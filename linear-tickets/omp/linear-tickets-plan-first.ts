// omp extension for the linear-tickets plugin's plan-first policy (README, "Plan-first").
// Install: symlink this file into ~/.omp/agent/extensions/. It loads before the Plannotator plugin
// (user extensions come first), so its before_agent_start runs first and Plannotator's own handler
// delivers the planning framing on the same prompt.
//
// - LINEAR_TICKETS_PLAN=required|agent (set by the plugin for ticket agents): a fresh session
//   starts in Plannotator's planning phase. With "agent" the model may leave it through
//   `skip_plan` and a reason, which the plugin posts on the ticket; with "required" there is no
//   such tool.
// - <PASEO_HOME>/linear-tickets/plan-requests/<agent id> (written by the plugin when the owner adds
//   the `plan` label while the agent works): the agent enters planning at its next tool call, which
//   is blocked and followed by a message with the reason, or at its next prompt. `skip_plan` is
//   refused from then on.
// - LINEAR_TICKETS_ISSUE=<ticket> (set by the plugin for every ticket agent): plan advisor
//   (README, "Plan advisor"). Submitting a plan (`plannotator_submit_plan`, its xd:// device, or
//   omp's `xd://propose`) is blocked until `record_plan_advice` recorded a GPT-6 Astra review for
//   exactly that plan text. The block reason carries the steps, pointing the advisor at the saved
//   ticket prompt in LINEAR_TICKETS_CONTEXT when the launch could save it. `xd://propose` is only
//   caught when this extension's handler runs before plannotator-omp-plan.ts. omp runs the
//   tool_call handlers of every call in a message, in order, before any of them executes: the
//   record is therefore checked in its own handler, so a record listed before the submit in the
//   same message counts, and a plan write or edit queued in that message holds both back. Subagents
//   (`task` children, which share the environment but cannot create an advisor) are not gated.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { ADVISOR_MODEL, ADVISOR_SECTION, ADVISOR_THINKING, advisorSteps, RECORD_ADVICE_TOOL } from "../shared/plan-advisor";

type Phase = "idle" | "planning" | "executing";
type Entry = { type: string; customType?: string; data?: { reason?: string; path?: string; hash?: string }; message?: { role?: string } };
type Context = { cwd?: string; agent?: { kind?: string }; sessionManager: { getBranch(): Entry[]; getArtifactsDir?(): string } };
type ToolResult = { content: { type: "text"; text: string }[]; details?: Record<string, unknown> };
type Params = Record<string, string | undefined>;
type Schema = {
  object(shape: Record<string, unknown>): unknown;
  string(): { optional(): unknown };
  enum(values: [string, ...string[]]): unknown;
};
type ExtensionApi = {
  on(event: "session_start" | "session_switch" | "session_branch" | "session_tree" | "before_agent_start" | "turn_start", handler: (event: unknown, ctx: Context) => Promise<void> | void): void;
  on(event: "tool_call", handler: (event: { toolName: string; toolCallId?: string; input?: Record<string, unknown> }, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void;
  events: { emit(channel: string, data: unknown): void };
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "aside" }): void;
  registerTool(tool: { name: string; label: string; description: string; parameters: unknown; loadMode?: "essential" | "discoverable"; execute(id: string, params: Params, signal?: unknown, onUpdate?: unknown, ctx?: Context): Promise<ToolResult> }): void;
  zod: Schema;
};

const POLICY = process.env.LINEAR_TICKETS_PLAN;
// Every ticket agent carries its ticket; the saved ticket prompt is optional (its save can fail).
const TICKET = process.env.LINEAR_TICKETS_ISSUE;
const CONTEXT = process.env.LINEAR_TICKETS_CONTEXT || null;
const AGENT_ID = process.env.PASEO_AGENT_ID;
const PASEO_CLI = process.env.PASEO_CLI || "paseo";
const HOME = process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
const EVENTS = join(HOME, "linear-tickets", "plannotator", "events");
const MARKER = "linear-tickets.plan-first";
const ADVICE_MARKER = "linear-tickets.plan-advice";
const SUBMIT_TOOL = "plannotator_submit_plan";
const VERDICTS = ["agreed", "disagreements", "unavailable"] as const;
const REQUEST_TIMEOUT_MS = 5_000;
const INSPECT_TIMEOUT_MS = 15_000;
const run = promisify(execFile);
const OWNER_ASKED = "The owner added the `plan` label to this ticket, so you are now in Plannotator's plan mode. Stop implementing: investigate what is left, write a plan and submit it for review before any further change.";

function text(message: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: message }], details };
}

// The plan file a submission names, as given: a path relative to the working directory, or omp's
// local:// plan for `xd://propose`. null: not a plan submission.
export function submittedPlan(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (toolName === SUBMIT_TOOL) return typeof input?.filePath === "string" ? input.filePath.trim() || null : null;
  if (toolName !== "write" || typeof input?.path !== "string") return null;
  const path = input.path.trim();
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (path === "xd://propose") return content ? `local://${content}-plan.md` : null;
  if (path !== `xd://${SUBMIT_TOOL}`) return null;
  try {
    const args = JSON.parse(content) as { filePath?: unknown };
    return typeof args.filePath === "string" ? args.filePath.trim() || null : null;
  } catch {
    return null;
  }
}

function planPath(ctx: Context | undefined, file: string): string | null {
  const local = /^local:\/\/(.+)$/.exec(file);
  if (local) {
    const artifacts = ctx?.sessionManager.getArtifactsDir?.();
    return artifacts ? join(artifacts, "local", local[1]) : null;
  }
  return resolvePath(ctx?.cwd ?? process.cwd(), file);
}

function readPlan(path: string | null): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Why the advisor agent does not count, or null when it is this agent's GPT-6 Astra advisor and
// has finished its latest turn. It cannot prove what the advisor said about which plan version:
// the plan's advisor section, which the owner reads, carries that.
export function advisorProblem(agent: { Model?: unknown; Thinking?: unknown; ParentAgentId?: unknown; Status?: unknown }, parentId: string): string | null {
  if (agent.Model !== ADVISOR_MODEL) return `it runs ${String(agent.Model ?? "an unknown model")}, not ${ADVISOR_MODEL}`;
  if (agent.Thinking !== ADVISOR_THINKING) return `its thinking level is ${String(agent.Thinking ?? "unset")}, not ${ADVISOR_THINKING}`;
  if (agent.ParentAgentId !== parentId) return "it was not created by this agent";
  if (agent.Status !== "idle") return `it is ${String(agent.Status ?? "in an unknown state")}, not idle: wait for its answer to your latest message`;
  return null;
}

export default function linearTicketsPlanFirst(pi: ExtensionApi): void {
  if (!AGENT_ID) return;
  const request = join(HOME, "linear-tickets", "plan-requests", AGENT_ID);
  // `launched`: this session already applied its launch policy, or is a resumed one that must not
  // be sent back to planning. `ownerAsked`: the owner requested a plan; skip_plan is refused.
  let launched = false;
  let ownerAsked = false;
  // Plannotator did not answer once: without it there is no planning phase to enter, so the
  // request file is not checked again on every tool call (each check would wait for the timeout).
  let unanswered = false;
  // Plan (absolute path, or local:// URI) → sha256 of the text the advisor's review was recorded for.
  const advised = new Map<string, string>();
  // omp's local:// plans as last written: the Plannotator bridge submits them from the same cache
  // when the artifact is not on disk yet, so the gate reads what the bridge would send.
  const writtenPlans = new Map<string, string>();
  // Within the current turn (one assistant message): records already checked in their tool_call
  // handler, by tool call id, for their execute to return; and plans a queued write or edit is
  // about to change, which no record or submission in the same message may vouch for.
  const recordOutcomes = new Map<string, ToolResult>();
  const queuedEdits = new Set<string>();
  // The plan a submission, record or edit names: its key and current text (null: unreadable).
  function planText(ctx: Context | undefined, file: string): { key: string; content: string | null } {
    const local = /^local:\/\/[^/]+$/.test(file);
    const path = planPath(ctx, file);
    return { key: local ? file : path ?? file, content: readPlan(path) ?? (local ? writtenPlans.get(file) ?? null : null) };
  }
  // Checks a record_plan_advice call and, when it holds, records the review for the plan's
  // current text. Runs in the call's tool_call handler (see the header) or, for calls dispatched
  // without one, in its execute.
  const recordAdvice = async (params: Params, ctx: Context | undefined): Promise<ToolResult> => {
    const file = params.filePath?.trim();
    if (!file) return text("Pass the plan file you are about to submit (the same path you give the submit tool).");
    const { key, content } = planText(ctx, file);
    if (content === null) return text(`${file} could not be read. Pass the plan file you are about to submit.`);
    if (queuedEdits.has(key)) return text(`A change to ${file} is queued in this step, so the review cannot be recorded for it yet. Record after that change has run, in your next step.`);
    const section = new RegExp(`^#{1,6}\\s+${ADVISOR_SECTION}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, "im").exec(content);
    if (!section) {
      return text(`${file} has no "## ${ADVISOR_SECTION}" section. Add it (the advisor's model, the rounds, what changed because of it, and every open point with both positions), then record again.`);
    }
    const verdict = params.verdict;
    if (verdict === "unavailable") {
      const reason = params.reason?.trim();
      if (!reason) return text("Give the reason the advisor could not be created.");
      if (!/unavailable|could not be created|couldn't be created/i.test(section[1]) || !section[1].toLowerCase().includes(reason.toLowerCase())) {
        return text(`The plan's "## ${ADVISOR_SECTION}" section must tell the owner that the advisor was unavailable and why, with the reason you pass here word for word. Say so there, then record again.`);
      }
    } else if (verdict === "agreed" || verdict === "disagreements") {
      const advisorId = params.advisorAgentId?.trim();
      if (!advisorId) return text("Pass the advisor's Paseo agent id (from `create_agent`).");
      let agent: Record<string, unknown>;
      try {
        agent = JSON.parse((await run(PASEO_CLI, ["inspect", advisorId, "--json"], { timeout: INSPECT_TIMEOUT_MS })).stdout) as Record<string, unknown>;
      } catch (error) {
        return text(`Could not look up advisor ${advisorId} with \`paseo inspect\`: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
      const problem = advisorProblem(agent, AGENT_ID);
      if (problem) return text(`Agent ${advisorId} does not count as your plan advisor: ${problem}. Fix that, then record again.`);
    } else {
      return text(`Verdict must be one of: ${VERDICTS.join(", ")}.`);
    }
    const hash = createHash("sha256").update(content).digest("hex");
    advised.set(key, hash);
    pi.appendEntry(ADVICE_MARKER, { path: key, hash, verdict, advisorAgentId: params.advisorAgentId ?? null, reason: params.reason ?? null, at: new Date().toISOString() });
    return text(`Advisor review recorded for ${file} (${verdict}). Submit the plan now, without editing it again.`, { verdict });
  };
  // Plannotator's plan-mode control (plannotator:request). null: Plannotator did not answer.
  // Executor form: the plugin's TypeScript lib, which typechecks this file, predates Promise.withResolvers.
  function planMode(mode: "enter" | "exit" | "status"): Promise<Phase | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
      pi.events.emit("plannotator:request", {
        requestId: randomUUID(),
        action: "plan-mode",
        payload: { mode },
        respond: (response: { status?: string; result?: { phase?: Phase } }) => {
          clearTimeout(timer);
          resolve(response?.status === "handled" ? response.result?.phase ?? null : null);
        },
      });
    });
  }

  // The owner's request: planning from wherever the agent is (an approved plan being executed
  // included). The request file goes only once the agent is planning, so a failure retries.
  async function takeOwnerRequest(): Promise<"entered" | "planning" | null> {
    if (unanswered || !existsSync(request)) return null;
    let phase = await planMode("status");
    if (phase === null) { unanswered = true; return null; }
    if (phase === "planning") {
      rmSync(request, { force: true });
      ownerAsked = true;
      return "planning";
    }
    if (phase === "executing") phase = await planMode("exit");
    if (phase === "idle") phase = await planMode("enter");
    if (phase !== "planning") return null;
    rmSync(request, { force: true });
    ownerAsked = true;
    pi.appendEntry(MARKER, { reason: "owner", at: new Date().toISOString() });
    return "entered";
  }

  // Advice is rebuilt from the active branch only: another branch's or session's must not carry over.
  function restoreAdvice(entries: Entry[]): void {
    advised.clear();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === ADVICE_MARKER && entry.data?.path && entry.data.hash) advised.set(entry.data.path, entry.data.hash);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const marks = entries.filter((entry) => entry.type === "custom" && entry.customType === MARKER);
    launched = marks.length > 0 || entries.some((entry) => entry.type === "message" && entry.message?.role === "assistant");
    ownerAsked = marks.some((entry) => entry.data?.reason === "owner");
    restoreAdvice(entries);
  });
  for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
    pi.on(event, (_event, ctx) => restoreAdvice(ctx.sessionManager.getBranch()));
  }
  // omp starts a turn before each assistant message; the previous message's tools have all run.
  pi.on("turn_start", () => {
    recordOutcomes.clear();
    queuedEdits.clear();
  });

  pi.on("before_agent_start", async () => {
    if (await takeOwnerRequest()) { launched = true; return; }
    if (launched) return;
    launched = true;
    if (POLICY !== "required" && POLICY !== "agent") return;
    if (await planMode("enter") === "planning") pi.appendEntry(MARKER, { reason: "launch", policy: POLICY, at: new Date().toISOString() });
  });

  // A tool result reads like data, so the owner's request arrives as a harness message at the next
  // step; the blocked call only points to it.
  pi.on("tool_call", async (event, ctx) => {
    if (await takeOwnerRequest() === "entered") {
      pi.sendMessage({ customType: MARKER, content: OWNER_ASKED, display: true }, { deliverAs: "aside" });
      return { block: true, reason: "Stopped by the linear-tickets plugin: the owner asked for a plan before further changes (see its message)." };
    }
    if (!TICKET) return undefined;
    const input = event.input;
    if (event.toolName === "write" || event.toolName === "edit") {
      // omp gives an edit's targets as `paths` (hashline patches) or `path`.
      const targets = Array.isArray(input?.paths) ? input.paths : [input?.path];
      for (const target of targets) {
        if (typeof target === "string" && /^(local:\/\/[^/]+|.*\.mdx?)$/i.test(target.trim())) queuedEdits.add(planText(ctx, target.trim()).key);
      }
    }
    if (event.toolName === "write" && typeof input?.path === "string" && /^local:\/\/[^/]+-plan\.md$/.test(input.path.trim()) && typeof input.content === "string") {
      writtenPlans.set(input.path.trim(), input.content);
      return undefined;
    }
    if (event.toolName === RECORD_ADVICE_TOOL) {
      const params: Params = {};
      for (const [name, value] of Object.entries(input ?? {})) params[name] = typeof value === "string" ? value : undefined;
      const outcome = await recordAdvice(params, ctx);
      if (event.toolCallId) recordOutcomes.set(event.toolCallId, outcome);
      return undefined;
    }
    const file = submittedPlan(event.toolName, input);
    if (!file) return undefined;
    if (ctx?.agent?.kind === "sub") return undefined;
    const { key, content } = planText(ctx, file);
    if (content === null) {
      // Plannotator's submit tool reads the file itself and reports a missing one; every other
      // submission path could still find a plan this gate cannot read, so it fails closed.
      if (event.toolName === SUBMIT_TOOL) return undefined;
      return { block: true, reason: `Stopped by the linear-tickets plugin: ${file} could not be read, so its advisor review cannot be checked. Write the plan with the write tool, then submit it again.` };
    }
    const recorded = advised.get(key);
    if (!queuedEdits.has(key) && recorded === createHash("sha256").update(content).digest("hex")) return undefined;
    return {
      block: true,
      reason: recorded
        ? `Stopped by the linear-tickets plugin: ${file} changed after its advisor review was recorded. Send the changes to the same advisor with \`send_agent_prompt\`, settle any new points, update the \`## ${ADVISOR_SECTION}\` section, call \`${RECORD_ADVICE_TOOL}\` again, then submit without further edits.`
        : `Stopped by the linear-tickets plugin: ${file} has no recorded advisor review yet.\n\n${advisorSteps({ contextPath: CONTEXT, omp: true })}`,
    };
  });

  if (TICKET) pi.registerTool({
    name: RECORD_ADVICE_TOOL,
    label: "Record Plan Advice",
    description: `Record that your GPT-6 Astra plan advisor reviewed the plan file in its current form, so it can be submitted to the owner. Verdict: agreed (no open points), disagreements (open points listed in the plan's "## ${ADVISOR_SECTION}" section) or unavailable (the advisor could not be created; give the reason). Call it after the last edit to the plan; any later edit needs a new review and record.`,
    parameters: pi.zod.object({
      filePath: pi.zod.string(),
      verdict: pi.zod.enum([...VERDICTS]),
      advisorAgentId: pi.zod.string().optional(),
      reason: pi.zod.string().optional(),
    }),
    // A direct tool: Plannotator's planning phase blocks xd:// writes to discoverable tools.
    loadMode: "essential",
    async execute(id, params, _signal, _onUpdate, ctx) {
      const checked = recordOutcomes.get(id);
      recordOutcomes.delete(id);
      return checked ?? recordAdvice(params, ctx);
    },
  });

  if (POLICY !== "agent") return;
  pi.registerTool({
    name: "skip_plan",
    label: "Skip Plan",
    description: "Leave plan mode without a plan review because this ticket is small enough to implement directly: none of the plan rules in your instructions apply. Pass a one-sentence reason; it is posted on the Linear ticket. Then implement the ticket.",
    parameters: pi.zod.object({ reason: pi.zod.string() }),
    // A direct tool: discoverable tools are called by writing to xd://skip_plan, which
    // Plannotator's planning phase blocks like any non-markdown write.
    loadMode: "essential",
    async execute(_id, params) {
      const reason = params.reason?.trim();
      if (!reason) return text("Give a one-sentence reason why this ticket needs no plan.");
      if (ownerAsked) return text("The owner asked for a plan on this ticket, so it cannot be skipped. Write the plan and submit it for review.");
      const phase = await planMode("status");
      if (phase !== "planning") return text(`Not in plan mode (${phase ?? "Plannotator did not answer"}); there is nothing to skip.`);
      if (await planMode("exit") !== "idle") return text("Plan mode could not be left. Write the plan and submit it for review instead.");
      pi.appendEntry(MARKER, { reason: "skipped", at: new Date().toISOString() });
      try {
        mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
        const name = `${Date.now()}-${randomUUID()}.json`;
        writeFileSync(join(EVENTS, `.${name}.tmp`), JSON.stringify({ type: "skipped", agentId: AGENT_ID, reason, at: new Date().toISOString() }), { mode: 0o600 });
        renameSync(join(EVENTS, `.${name}.tmp`), join(EVENTS, name));
      } catch {
        // The ticket note is a convenience; leaving plan mode already happened.
      }
      return text("Plan skipped; your reason is posted on the ticket. Implement the ticket now.", { skipped: true });
    },
  });
}
