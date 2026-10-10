// omp extension for the linear-tickets plugin's plan-first policy (README, "Plan-first").
// Install: symlink this file into ~/.omp/agent/extensions/. It loads before the Plannotator plugin
// (user extensions come first), so its before_agent_start runs first and Plannotator's own handler
// delivers the planning framing on the same prompt.
//
// - LINEAR_TICKETS_PLAN=required (set by the plugin for every ticket agent without an approved
//   plan): a fresh session starts in Plannotator's planning phase.
// - LINEAR_TICKETS_SMALL_ROUTE=1 (set by the plugin next to it when the ticket may take the
//   small-ticket route, README "Small-ticket route"): `take_small_ticket_route` checks the
//   ticket's facts (shared/small-route.ts), drops a `route` event and waits up to a minute for the
//   plugin's decision file `<PASEO_HOME>/linear-tickets/small-route/decisions/<route id>.decision`.
//   Whichever side writes that file first decides; it is created once with link(2), so a late
//   answer never replaces it. Only an `accepted` decision leaves planning; without an answer the
//   tool writes `cancelled` itself and the agent plans. Not after an owner `plan` request.
// - <PASEO_HOME>/linear-tickets/plan-requests/<agent id> (written by the plugin when the owner adds
//   the `plan` label while the agent works, or when an approved plan names no model tier): the
//   agent enters planning at its next tool call, which is blocked and followed by a message with
//   the reason (the file's `message`, else the owner's request), or at its next prompt.
// - LINEAR_TICKETS_ISSUE=<ticket> (set by the plugin for every ticket agent, also when Paseo
//   resumes its session: server/agent-env.ts; a planner run sets `project-planner:<run id>`, a
//   flag with no Linear ticket behind it): plan advisor
//   (README, "Plan advisor"). Submitting a plan (`plannotator_submit_plan`, its xd:// device, or
//   omp's `xd://propose`) is blocked until `record_plan_advice` recorded a GPT-6 Astra review for
//   exactly that plan text. The block reason carries the steps, pointing the advisor at the saved
//   ticket prompt in LINEAR_TICKETS_CONTEXT when the launch could save it. `xd://propose` is only
//   caught when this extension's handler runs before plannotator-omp-plan.ts. omp runs the
//   tool_call handlers of every call in a message, in order, before any of them executes: the
//   record is therefore checked in its own handler, so a record listed before the submit in the
//   same message counts, and a plan write or edit queued in that message holds both back. Subagents
//   (`task` children, which share the environment but cannot create an advisor) are not gated.
//   The record also needs the plan's `## Risk and impact` section (shared/plan-risk.ts) and its
//   `## Reach` and `## Principles and rules` sections (shared/plan-sections.ts; one line each
//   suffices at impact 0–1, by the higher of planner and advisor rating), and drops an `advised`
//   event with the verdict and the plan text's hash, from which the plugin's Plannotator bridge
//   decides whether the plan is approved without the owner (README, "Plan risk and
//   auto-approval"). The record also needs the plan's `## Model` section (shared/plan-model.ts):
//   the tier its implementation runs on; and a ticket plan follows the part layout of the owner's
//   Plannotator planning instructions (shared/plan-layout.ts), whether or not they reached the agent.
// - LINEAR_TICKETS_ISSUE=<ticket>: `escalate_model` (README, "Model tiers") lets a ticket agent on
//   the cheap or standard tier ask for the strong model; it drops an `escalated` event and the
//   plugin switches the agent's model. Subagents cannot call it.
// - LINEAR_TICKETS_ISSUE=<ticket>: Linear writes (README, "Agent access to Linear"). The user-level
//   Linear MCP server acts as the owner, so ticket agents and their subagents may call only its read
//   tools, named below; every other tool of that server is blocked, whether called directly
//   (`mcp__linear_<tool>`) or through its xd:// device. The plugin's own `linear_ticket` tools,
//   which write as the Paseo app, stay open. A guard against mistakes, not isolation: the agent
//   runs as the owner's user.
// - LINEAR_TICKETS_MCP=<server command as JSON> (set by the plugin when Agent access to Linear is
//   on): omp cannot load MCP servers, so this extension mounts the plugin's `linear_ticket` server
//   tools as `linear_ticket_<tool>` and runs each call through one server process. The read tools
//   are direct ("essential") tools, so they also work in Plannotator's planning phase, which
//   refuses every xd:// write.
import { execFileSync, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { ADVISOR_MODEL, ADVISOR_SECTION, ADVISOR_THINKING, advisorSteps, RECORD_ADVICE_TOOL } from "../shared/plan-advisor";
import { combinedRating, parsePlanRisk, sectionBody } from "../shared/plan-risk";
import { parsePlanSections, ruleMismatch, sectionSteps } from "../shared/plan-sections";
import { ESCALATE_TOOL, parsePlanModel } from "../shared/plan-model";
import { layoutProblem, requiredParts } from "../shared/plan-layout";
import { decisionText, parseDecision, parseRouteFacts, routeRefusals, SMALL_ROUTE_ENV, SMALL_ROUTE_TOOL, SMALL_ROUTE_WAIT_MS, smallRouteNote, type RouteDecision } from "../shared/small-route";

type Phase = "idle" | "planning" | "executing";
type Entry = { type: string; customType?: string; data?: { reason?: string; path?: string; hash?: string }; message?: { role?: string } };
type Context = { cwd?: string; agent?: { kind?: string }; sessionManager: { getBranch(): Entry[]; getArtifactsDir?(): string } };
type ToolResult = { content: { type: "text"; text: string }[]; details?: Record<string, unknown> };
type Params = Record<string, string | undefined>;
type Field = { describe(text: string): Field; optional(): unknown };
type Schema = {
  object(shape: Record<string, unknown>): unknown;
  string(): Field;
  number(): Field;
  enum(values: [string, ...string[]]): Field;
};
type ExtensionApi = {
  on(event: "session_start" | "session_switch" | "session_branch" | "session_tree" | "before_agent_start" | "turn_start", handler: (event: unknown, ctx: Context) => Promise<void> | void): void;
  on(event: "tool_call", handler: (event: { toolName: string; toolCallId?: string; input?: Record<string, unknown> }, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void;
  events: { emit(channel: string, data: unknown): void };
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "aside" }): void;
  registerTool(tool: { name: string; label: string; description: string; parameters: unknown; loadMode?: "essential" | "discoverable"; execute(id: string, params: Params, signal?: AbortSignal, onUpdate?: unknown, ctx?: Context): Promise<ToolResult> }): void;
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
// The plugin's decisions on small-ticket route attempts (server/small-route.ts, same directory).
const ROUTE_DECISIONS = join(HOME, "linear-tickets", "small-route", "decisions");
const SMALL_ROUTE = process.env[SMALL_ROUTE_ENV] === "1";
// Plannotator's global config, resolved as Plannotator resolves it (its config.ts): the owner's
// planning instructions, whose plan layout the record gate checks (shared/plan-layout.ts).
const PLANNOTATOR_CONFIG = join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent"), "plannotator.json");
const MARKER = "linear-tickets.plan-first";
const ADVICE_MARKER = "linear-tickets.plan-advice";
// The session left planning by the small-ticket route (server/plan-pipeline-source.ts reads it).
const ROUTE_MARKER = "linear-tickets.small-route";
const ROUTE_POLL_MS = 500;
const SUBMIT_TOOL = "plannotator_submit_plan";
const VERDICTS = ["agreed", "disagreements", "unavailable"] as const;
const REQUEST_TIMEOUT_MS = 5_000;
const INSPECT_TIMEOUT_MS = 15_000;
const run = promisify(execFile);
const OWNER_ASKED = "The owner added the `plan` label to this ticket, so you are now in Plannotator's plan mode. Stop implementing: investigate what is left, write a plan and submit it for review before any further change.";

function text(message: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: message }], details };
}

// Hands an event to the plugin's Plannotator bridge. Throws when it cannot be written.
function writeEvent(event: Record<string, unknown>): void {
  mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${randomUUID()}.json`;
  writeFileSync(join(EVENTS, `.${name}.tmp`), JSON.stringify({ ...event, agentId: AGENT_ID, at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(join(EVENTS, `.${name}.tmp`), join(EVENTS, name));
}

// Best-effort: the bridge treats a missing event as "ask the owner".
function dropEvent(event: Record<string, unknown>): void {
  try { writeEvent(event); } catch { /* see above */ }
}

// Publishes a route attempt's decision unless one exists, and returns the one that stands: a
// complete file linked into place, never replaced (server/small-route.ts writes the same way).
// null: unreadable, which never counts as accepted.
function publishDecision(routeId: string, decision: RouteDecision): RouteDecision | null {
  mkdirSync(ROUTE_DECISIONS, { recursive: true, mode: 0o700 });
  const target = join(ROUTE_DECISIONS, `${routeId}.decision`);
  const temporary = join(ROUTE_DECISIONS, `.${routeId}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeSync(fd, decisionText(decision, "tool")); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
  } finally {
    rmSync(temporary, { force: true });
  }
  try { return parseDecision(readFileSync(target, "utf8")); } catch { return null; }
}

// The decision on a route attempt: the plugin's, or once the wait ends without one, the tool's own
// `cancelled` (publishing returns whichever decision came first).
async function awaitDecision(routeId: string, expiresAt: number, signal: AbortSignal | undefined): Promise<RouteDecision | null> {
  const target = join(ROUTE_DECISIONS, `${routeId}.decision`);
  while (Date.now() < expiresAt && !signal?.aborted && !existsSync(target)) await sleep(ROUTE_POLL_MS);
  return publishDecision(routeId, { decision: "cancelled", reason: signal?.aborted ? "the tool call was aborted" : "the plugin did not answer in time" });
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

// The part headings the owner's planning instructions require; [] when the file or its planning
// instructions are missing or unreadable (Plannotator then uses its built-in ones, which name none).
function planningParts(): string[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(PLANNOTATOR_CONFIG, "utf8"));
  } catch {
    return [];
  }
  for (const key of ["phases", "planning", "instructions"]) {
    if (typeof value !== "object" || value === null || !(key in value)) return [];
    value = Reflect.get(value, key);
  }
  return typeof value === "string" ? requiredParts(value) : [];
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

const LINEAR_MCP = "mcp__linear_";
// The Linear MCP server's tools that only read (checked 2026-10-01). Explicit names, so a tool the
// server adds later is blocked until someone reviews it and adds it here.
const LINEAR_READ_TOOLS = new Set([
  "extract_images", "get_agent_skill", "get_attachment", "get_diff", "get_diff_threads", "get_document", "get_initiative", "get_issue",
  "get_issue_status", "get_milestone", "get_notifications", "get_project", "get_release", "get_release_note", "get_status_updates",
  "get_team", "get_template", "get_triage_responsibility", "get_user", "get_workspace", "list_agent_skills", "list_comments",
  "list_custom_views", "list_cycles", "list_diffs", "list_documents", "list_initiative_labels", "list_initiatives",
  "list_issue_labels", "list_issue_statuses", "list_issues", "list_milestones", "list_project_labels", "list_projects",
  "list_release_notes", "list_release_pipelines", "list_releases", "list_teams", "list_templates", "list_users", "search_documentation",
].map((name) => LINEAR_MCP + name));

// The Linear MCP tool a call would run when it is not one of the read tools, else null: called
// directly or by writing its arguments to its xd:// device.
export function linearWrite(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const path = toolName === "write" && typeof input?.path === "string" ? input.path.trim() : "";
  const tool = path.startsWith("xd://") ? path.slice("xd://".length) : toolName;
  // The plugin's own server is named `linear_ticket` (TICKET_MCP_NAME), so its tools share the prefix.
  if (!tool.startsWith(LINEAR_MCP) || tool.startsWith("mcp__linear_ticket_")) return null;
  return LINEAR_READ_TOOLS.has(tool) ? null : tool;
}

type TicketServer = { command: string; args: string[]; env: Record<string, string> };
type JsonSchema = { type?: string; enum?: string[]; description?: string; properties?: Record<string, JsonSchema>; required?: string[] };
type TicketTool = { name: string; description: string; inputSchema: JsonSchema; annotations?: { readOnlyHint?: boolean } };
const TICKET_TOOL_PREFIX = "linear_ticket_";
const TICKET_LIST_TIMEOUT_MS = 10_000;
const TICKET_CALL_TIMEOUT_MS = 90_000;

// The plugin's ticket server from LINEAR_TICKETS_MCP (server/ticket-mcp.ts TicketMcpServer), or
// null when this agent has no Linear access.
export function ticketServer(raw: string | undefined): TicketServer | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || !("command" in value) || !("args" in value)) return null;
  const { command, args } = value;
  if (typeof command !== "string" || !Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) return null;
  const env: Record<string, string> = {};
  if ("env" in value && value.env && typeof value.env === "object") {
    for (const [name, setting] of Object.entries(value.env)) if (typeof setting === "string") env[name] = setting;
  }
  return { command, args, env };
}

// The result of the response to request 1 in the server's output, or the error it reports.
function rpcResult(output: string): unknown {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const message: unknown = JSON.parse(line);
    if (!message || typeof message !== "object" || !("id" in message) || message.id !== 1) continue;
    if ("error" in message && message.error && typeof message.error === "object" && "message" in message.error) throw new Error(String(message.error.message));
    return "result" in message ? message.result : null;
  }
  throw new Error("The linear_ticket server gave no answer.");
}

// The server's tools, read once when the extension loads (the server answers tools/list at once).
export function listTicketTools(server: TicketServer): TicketTool[] {
  const output = execFileSync(server.command, server.args, { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n", env: { ...process.env, ...server.env }, encoding: "utf8", timeout: TICKET_LIST_TIMEOUT_MS, stdio: ["pipe", "pipe", "ignore"] });
  const result = rpcResult(output);
  const tools = result && typeof result === "object" && "tools" in result && Array.isArray(result.tools) ? result.tools : [];
  return tools.filter((tool): tool is TicketTool => Boolean(tool) && typeof tool.name === "string" && typeof tool.description === "string" && Boolean(tool.inputSchema) && typeof tool.inputSchema === "object");
}

// One process per call: the server answers the request, then exits once its input is closed.
export function callTicketTool(server: TicketServer, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  // Executor form for the same reason as planMode below.
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"], signal, timeout: TICKET_CALL_TIMEOUT_MS });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      try {
        const result = rpcResult(output);
        const content = result && typeof result === "object" && "content" in result && Array.isArray(result.content) ? result.content : [];
        const message = content.map((part: unknown) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
        if (result && typeof result === "object" && "isError" in result && result.isError === true) reject(new Error(message || "The Linear request failed."));
        else resolve(message);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

// The tool's JSON Schema (strings, numbers and string enums at the top level) as omp's schema.
function toolParameters(z: Schema, schema: JsonSchema): unknown {
  const shape: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const [first, ...rest] = property.enum ?? [];
    let field = first !== undefined ? z.enum([first, ...rest]) : property.type === "integer" || property.type === "number" ? z.number() : z.string();
    if (property.description) field = field.describe(property.description);
    shape[name] = schema.required?.includes(name) ? field : field.optional();
  }
  return z.object(shape);
}

export default function linearTicketsPlanFirst(pi: ExtensionApi): void {
  if (!AGENT_ID) return;
  const request = join(HOME, "linear-tickets", "plan-requests", AGENT_ID);
  // `launched`: this session already applied its launch policy, or is a resumed one that must not
  // be sent back to planning.
  let launched = false;
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
    const rated = parsePlanRisk(content);
    if ("problem" in rated) return text(`${file}: ${rated.problem}\n\nFix the section, then record again.`);
    const sections = parsePlanSections(content, combinedRating(rated.risk).impact);
    const sectionProblem = "problem" in sections ? sections.problem : ruleMismatch(rated.risk.newRule, sections.sections);
    if (sectionProblem) return text(`${file}: ${sectionProblem}\n\n${sectionSteps()}\n\nFix the section, then record again.`);
    // A planner run's work order only orders tickets; each ticket's own plan picks its tier.
    const model = sectionBody(content, "Work order") === null ? parsePlanModel(content, rated.risk) : null;
    if (model && "problem" in model) return text(`${file}: ${model.problem}\n\nFix the section, then record again.`);
    // Read at every record, so an edited template applies at once. No readable instructions: the
    // built-in ones, which name no parts, so nothing to check.
    const layout = model ? layoutProblem(content, planningParts()) : null;
    if (layout) return text(`${file}: ${layout}\n\nLay the plan out as the planning instructions in ${PLANNOTATOR_CONFIG} (phases.planning.instructions, "Plan File Structure") say, then record again.`);
    if (verdict === "unavailable") {
      const reason = params.reason?.trim();
      if (!reason) return text("Give the reason the advisor could not be created.");
      if (!/unavailable|could not be created|couldn't be created/i.test(section[1]) || !section[1].toLowerCase().includes(reason.toLowerCase())) {
        return text(`The plan's "## ${ADVISOR_SECTION}" section must tell the owner that the advisor was unavailable and why, with the reason you pass here word for word. Say so there, then record again.`);
      }
    } else if (verdict === "agreed" || verdict === "disagreements") {
      if (!rated.risk.advisor) return text(`The plan's "Advisor rating" says unavailable, but the verdict is ${verdict}. Put the advisor's own impact and reversibility there, then record again.`);
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
    // The Plannotator bridge compares it with server/review-outcome.ts `planHash` of the text it shows.
    dropEvent({ type: "advised", verdict, hash: createHash("sha256").update(content.trim()).digest("hex") });
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

  // The owner's (or the plugin's) request: planning from wherever the agent is (an approved plan
  // being executed included). The request file goes only once the agent is planning, so a failure
  // retries. `message`: why, from the file; the owner's request when it has none.
  async function takeOwnerRequest(): Promise<{ entered: boolean; message: string } | null> {
    if (unanswered || !existsSync(request)) return null;
    let message = OWNER_ASKED;
    try {
      const saved: unknown = JSON.parse(readFileSync(request, "utf8"));
      if (saved && typeof saved === "object" && "message" in saved && typeof saved.message === "string" && saved.message.trim()) message = saved.message;
    } catch { /* an unreadable request is still the owner's */ }
    let phase = await planMode("status");
    if (phase === null) { unanswered = true; return null; }
    if (phase === "planning") {
      rmSync(request, { force: true });
      return { entered: false, message };
    }
    if (phase === "executing") phase = await planMode("exit");
    if (phase === "idle") phase = await planMode("enter");
    if (phase !== "planning") return null;
    rmSync(request, { force: true });
    pi.appendEntry(MARKER, { reason: message === OWNER_ASKED ? "owner" : "plugin", at: new Date().toISOString() });
    return { entered: true, message };
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
    if (POLICY !== "required") return;
    if (await planMode("enter") === "planning") pi.appendEntry(MARKER, { reason: "launch", policy: POLICY, at: new Date().toISOString() });
  });

  // A tool result reads like data, so the owner's request arrives as a harness message at the next
  // step; the blocked call only points to it.
  pi.on("tool_call", async (event, ctx) => {
    const asked = await takeOwnerRequest();
    if (asked?.entered) {
      pi.sendMessage({ customType: MARKER, content: asked.message, display: true }, { deliverAs: "aside" });
      return { block: true, reason: `Stopped by the linear-tickets plugin: ${asked.message === OWNER_ASKED ? "the owner asked for a plan before further changes" : "back to planning"} (see its message).` };
    }
    if (!TICKET) return undefined;
    const input = event.input;
    const linearTool = linearWrite(event.toolName, input);
    if (linearTool) {
      return { block: true, reason: `Stopped by the linear-tickets plugin: ${linearTool} would act as the owner. Ticket agents change Linear only through the ${TICKET_TOOL_PREFIX}* tools, which write as Paseo: comments and relations on any issue, status and links on your ticket and the issues you created, create_issue for follow-ups. Reading with the Linear tools is fine. For anything else in Linear, ask the owner (or add a manual task).` };
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      // omp gives an edit's targets as `paths` (hashline patches) or `path`; an apply_patch edit
      // names them only in its `input` headers (`*** Update File: PLAN.md`, `*** Move to: …`).
      const targets: unknown[] = Array.isArray(input?.paths) ? [...input.paths] : [input?.path];
      if (typeof input?.input === "string") {
        for (const match of input.input.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm)) targets.push(match[1]);
      }
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

  if (TICKET) pi.registerTool({
    name: ESCALATE_TOOL,
    label: "Escalate Model",
    description: "Ask the plugin to move this ticket to the strong model tier when you run on the cheap or standard tier and the work needs more: the same check still fails after two honest fix attempts, the change turns out to need judgment the plan did not settle (several layers, an interface others build on, call sites that must agree, a check-then-write gap, many files), or a review found a design problem. The plugin switches your model within seconds and records the reason on the ticket; carry on with the work afterwards. Not for routine failures you can fix.",
    parameters: pi.zod.object({ reason: pi.zod.string() }),
    loadMode: "essential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (ctx?.agent?.kind === "sub") return text("Only the ticket agent itself can escalate; report back to it instead.");
      const reason = params.reason?.trim();
      if (!reason) return text("Give the reason your model is not enough.");
      dropEvent({ type: "escalated", reason: reason.slice(0, 1_000) });
      return text("Escalation requested: the plugin switches you to the strong model within seconds and records the reason on the ticket. Carry on with the work.");
    },
  });

  // The small-ticket route (README, "Small-ticket route"): only when the plugin offered it at launch.
  const yesNo = () => pi.zod.enum(["yes", "no"]);
  if (TICKET && SMALL_ROUTE) pi.registerTool({
    name: SMALL_ROUTE_TOOL,
    label: "Take Small-Ticket Route",
    description: `Skip the plan review for a small, low-risk ticket and implement it now. ${smallRouteNote()}`,
    parameters: pi.zod.object({
      acceptanceCriteria: pi.zod.number().describe("How many acceptance criteria the ticket has."),
      expectedChangedLines: pi.zod.number().describe("Changed lines (added + deleted) you expect in total."),
      impact: pi.zod.number().describe("Impact 0-4, as in a plan's `## Risk and impact`."),
      reversibility: pi.zod.enum(["revert", "data-fix", "irreversible"]),
      migration: yesNo(),
      auth: yesNo(),
      moneyOrErp: yesNo(),
      crossPackageContract: yesNo(),
      newRule: yesNo(),
      ownerDecisionNeeded: yesNo(),
      tier: pi.zod.enum(["cheap", "standard", "strong"]),
      tierReason: pi.zod.string(),
      reach: pi.zod.string().describe("The `Reach:` bullet your pull request body will carry: where else what you change is used, or why nowhere."),
      reason: pi.zod.string().describe("Why this ticket is small and low-risk, in one or two sentences."),
    }),
    // A direct tool: Plannotator's planning phase blocks xd:// writes to discoverable tools.
    loadMode: "essential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const plan = "Write the plan and submit it for review as usual.";
      if (ctx?.agent?.kind === "sub") return text("Only the ticket agent itself can take the small-ticket route.");
      const ownerAsked = existsSync(request) || (ctx?.sessionManager.getBranch() ?? []).some((entry) => entry.type === "custom" && entry.customType === MARKER && entry.data?.reason === "owner");
      if (ownerAsked) return text(`The owner asked for a plan on this ticket, so the small-ticket route is closed. ${plan}`);
      const parsed = parseRouteFacts(params);
      if ("problem" in parsed) return text(`${parsed.problem} Call the tool again with every field, or plan.`);
      const refusals = routeRefusals(parsed.facts);
      if (refusals.length) return text(`This ticket does not qualify for the small-ticket route: ${refusals.join("; ")}. ${plan}`);
      const phase = await planMode("status");
      if (phase !== "planning") return text(`Not in plan mode (${phase ?? "Plannotator did not answer"}): the small-ticket route only replaces a plan review.`);
      const routeId = randomUUID();
      const expiresAt = Date.now() + SMALL_ROUTE_WAIT_MS;
      try {
        writeEvent({ type: "route", routeId, expiresAt: new Date(expiresAt).toISOString(), facts: parsed.facts });
      } catch (error) {
        return text(`The route request could not be handed to the plugin (${error instanceof Error ? error.message : String(error)}). ${plan}`);
      }
      const decision = await awaitDecision(routeId, expiresAt, signal);
      if (decision?.decision !== "accepted") {
        const why = decision ? decision.reason : "its decision could not be read";
        return text(`The plugin did not accept the small-ticket route (${why}). ${plan}`, { routeId, decision: decision?.decision ?? "unreadable" });
      }
      // Before leaving: the plan pipeline reads planning that ends after it as the route, not a cancellation.
      pi.appendEntry(ROUTE_MARKER, { routeId, tier: parsed.facts.tier, at: new Date().toISOString() });
      if (await planMode("exit") !== "idle") return text(`The plugin accepted the small-ticket route, but Plannotator did not leave plan mode. ${plan} An approved plan replaces the route.`, { routeId, decision: "accepted" });
      return text(`Small-ticket route taken: the plugin records why on the ticket and moves you to the ${parsed.facts.tier} tier. Implement the ticket now; there is no plan document. Your pull request body's \`Reach:\` and \`Principles and rules:\` bullets are the plan (Reach: ${parsed.facts.reach}). If the work turns out bigger or riskier than you rated it, stop and ask the owner for a plan.`, { routeId, decision: "accepted" });
    },
  });

  const server = TICKET ? ticketServer(process.env.LINEAR_TICKETS_MCP) : null;
  if (!server) return;
  let listed: TicketTool[] = [];
  try {
    listed = listTicketTools(server);
  } catch (error) {
    console.error(`[linear-tickets] could not list the linear_ticket tools: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  for (const tool of listed) {
    pi.registerTool({
      name: TICKET_TOOL_PREFIX + tool.name,
      label: `Linear: ${tool.name.replace(/_/g, " ")}`,
      description: tool.description,
      parameters: toolParameters(pi.zod, tool.inputSchema),
      ...(tool.annotations?.readOnlyHint ? { loadMode: "essential" as const } : {}),
      async execute(_id, params, signal) {
        return text(await callTicketTool(server, tool.name, params, signal));
      },
    });
  }
}
