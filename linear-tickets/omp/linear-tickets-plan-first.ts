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
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Phase = "idle" | "planning" | "executing";
type Entry = { type: string; customType?: string; data?: { reason?: string }; message?: { role?: string } };
type Context = { sessionManager: { getBranch(): Entry[] } };
type ToolResult = { content: { type: "text"; text: string }[]; details?: Record<string, unknown> };
type Schema = { object(shape: Record<string, unknown>): unknown; string(): unknown };
type ExtensionApi = {
  on(event: "session_start" | "before_agent_start", handler: (event: unknown, ctx: Context) => Promise<void> | void): void;
  on(event: "tool_call", handler: (event: { toolName: string }, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void;
  events: { emit(channel: string, data: unknown): void };
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "aside" }): void;
  registerTool(tool: { name: string; label: string; description: string; parameters: unknown; loadMode?: "essential" | "discoverable"; execute(id: string, params: { reason?: string }): Promise<ToolResult> }): void;
  zod: Schema;
};

const POLICY = process.env.LINEAR_TICKETS_PLAN;
const AGENT_ID = process.env.PASEO_AGENT_ID;
const HOME = process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
const EVENTS = join(HOME, "linear-tickets", "plannotator", "events");
const MARKER = "linear-tickets.plan-first";
const REQUEST_TIMEOUT_MS = 5_000;
const OWNER_ASKED = "The owner added the `plan` label to this ticket, so you are now in Plannotator's plan mode. Stop implementing: investigate what is left, write a plan and submit it for review before any further change.";

function text(message: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: message }], details };
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

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const marks = entries.filter((entry) => entry.type === "custom" && entry.customType === MARKER);
    launched = marks.length > 0 || entries.some((entry) => entry.type === "message" && entry.message?.role === "assistant");
    ownerAsked = marks.some((entry) => entry.data?.reason === "owner");
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
  pi.on("tool_call", async () => {
    if (await takeOwnerRequest() !== "entered") return undefined;
    pi.sendMessage({ customType: MARKER, content: OWNER_ASKED, display: true }, { deliverAs: "aside" });
    return { block: true, reason: "Stopped by the linear-tickets plugin: the owner asked for a plan before further changes (see its message)." };
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
