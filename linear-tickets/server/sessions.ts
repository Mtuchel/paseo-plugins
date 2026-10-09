import { asCaller } from "./linear-usage";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentApi, OpenSession, SelectOption, SessionPlanStep } from "./agent-app";
import { agentAppDirectory } from "./agent-app";
import { recoverActivationId, type ActivationSink } from "./activation";
import type { AgentSessionWebhook } from "./agent-webhook";
import { groupProgress, groupStatus, isGroup } from "./groups";
import { planHash, type PendingReview, type ReviewOutcome } from "./review-outcome";
import { dispatchLabels } from "./dispatch";
import type { Handover } from "./handover";
import type { AdmissionState, IssueGroup, LinearService } from "./linear";
import type { Launcher } from "./launch";
import { CODING_STATE } from "./plannotator";
import type { NeedsYouIssues } from "./needs-you";
import { overrideCommand, type Correction, type CorrectionActivity, type Deputy } from "./deputy";
import { answerableQuestions, approvalDecision, deliverToAgent, matchOption, questionAnswer, questionsOf } from "./relay";
import { PermissionReplies, type DeliveryOrigin, type DeliveryResult } from "./permission-replies";
import type { PluginSettings, Settings } from "./settings";
import { issueAgents, type TicketStarter } from "./starter";
import { ghostAgents, LIVE_AGENT, ticketProcessLiveness, type ProcessAgent, type ProcessInspector } from "./process-liveness";
import { WATCHDOG_LABEL, type TicketRoots, type WatchdogOutcome, type WatchdogRequest, type WatchdogStore } from "./watchdog";
import type { ReviewDeletions } from "./review-deletions";
import { DecisionPendingError, FencedError } from "./decision-journal";
import { availability, candidates, claims, finishPending, incidentFor, LIMIT_SPACING, limitError, limitSchedule, limitTime, normalizeModel, updateEpisode, type LimitPending, type LimitResumeStore, type UsageReader } from "./limit-resume";
import { rateBudget, RateLimitedError, withPriority, type RateBudget } from "./rate-budget";

const exec = promisify(execFile);
const HANDLED_LIMIT = 200;
const SWEEP_MS = 60_000;
const QUEUED_OWNER_MAX_PAGES = 100;
// A session Linear webhooks for is re-read on this fallback cadence instead of every sweep, and a
// webhook whose read is due pulls it forward instead of waiting for the sweep (README, "Rate
// limits"). The webhook delivers the prompt itself, so the read only backstops a delivery Linear
// dropped: with no webhook for this long the session returns to the per-minute sweep, exactly the
// cost of a missed webhook before.
const WEBHOOK_FALLBACK_MS = 5 * 60 * 1000;
const ADOPT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const APPROVE_PLAN = "approve-plan";
export const APPROVE_LATER = "approve-later";
export const SEND_BACK = "send-back";
export const SPLIT_PLAN = "split-plan";
export const MAX_SPLIT = 12;
export const RESUME = "resume";
export const LEAVE = "leave";

// A crashed agent: Paseo shows it in error and its provider process exited or is closed (OMP:
// "OMP RPC process exited with code 1 …", "OMP RPC process is closed"). A message reaches nobody
// until the agent is reloaded. An agent in error for another reason (a failed API call) still has
// its process and takes messages.
const CLOSED_PROCESS = /\bprocess (exited|is closed)\b/i;

export function crashedProcess(agent: { status?: string; lastError?: string | null }): string | null {
  return agent.status === "error" && agent.lastError && CLOSED_PROCESS.test(agent.lastError) ? agent.lastError : null;
}

// What a restarted agent is sent: the crash, the git state to check first, then the message it
// would have got. It can arrive twice (see PullRequestWatch's pending resumes).
export function crashResume(error: string, next: string): string {
  return [
    `Your previous run crashed (\`${error}\`), and Paseo restarted you. Before anything else, run \`git status\` in your worktree: if a rebase is in progress, finish it (\`git rebase --continue\` once its conflicts are resolved) or abort it (\`git rebase --abort\`) and redo that step; the same for an interrupted merge or cherry-pick. Check the current state of your pull requests and lifecycle step before acting (this message can arrive twice). Then continue with the step below.`,
    "",
    next,
  ].join("\n");
}

// The ticket state a crash restart went by when Linear refused even the small ticket check on both
// pools (README, "Crashed agents"): the state Paseo last saw, and when (milliseconds since the epoch).
export type UnverifiedState = { name: string; at: number };

// A resume sent on such a state starts by asking the agent to check its ticket first. Added when the
// resume is sent, never stored with it: a pending resume sent later on a fresh read goes without it.
export function unverifiedResume(resume: string, seen: UnverifiedState | undefined): string {
  if (!seen) return resume;
  const at = `${new Date(seen.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return [
    `Paseo could not read this ticket's Linear state just now and restarted you on the state it last saw (${seen.name}, ${at}). First check the ticket's state with the linear_ticket tool get_ticket. If it is Done or Canceled (or marked a duplicate), stop. Otherwise check where your pull requests and lifecycle step stand and continue the steps that are not finished, without repeating finished ones. If you cannot check it, wait and do nothing else until you can.`,
    "",
    resume,
  ].join("\n");
}

// `restarted`: the agent had crashed, was reloaded and got the resume. `reloaded`: it was reloaded,
// but the resume did not go out (busy right after, or the send failed). `crashed`: it is crashed and
// was not (or could not be) reloaded; nothing was sent. `waiting`: it waits for the owner's answer
// or approval, so nothing was sent; unlike `busy` it does not end by itself (README, "Stalled pull
// requests").
export type PromptOutcome = "sent" | "restarted" | "reloaded" | "crashed" | "busy" | "waiting" | "gone" | "unavailable";
// Which host owns a ticket's automatic work (see Deps.owner).
export type HostOwnership = "here" | "elsewhere" | "unknown";
// What SessionRouter.whileIdle came to: `ran` with the work's value, or why the work did not run.
export type IdleRun<T> = { outcome: "ran"; value: T } | { outcome: "busy" | "waiting" | "elsewhere" | "unavailable" };
// What a successor start for a gone agent (SessionRouter.succeed) came to. `started`: a new agent
// runs with the message as the last part of its first prompt. `live`: another live agent of the
// ticket now owns its record and takes the message from the next poll. `wait`: nothing claimed, try
// again later. `impossible`: no successor can start (the caller tells the owner).
export type Succession =
  | { kind: "started" | "live"; agent: { id: string; title: string | null; cwd: string } }
  | { kind: "wait" | "impossible"; reason: string };
// What a restart (SessionRouter.restartFor) came to. `started`: a new agent runs (`marked`: the
// running label was written). `live`: a live agent already works on the ticket. `forwarded`: the
// peer host owns the start. `skipped`: the ticket is deleted or paused for deletion. `deferred`:
// nothing started and nothing failed (not connected, another start under way, held route, a process
// still writing, no admission, `eligible` refused, or a read before the start failed). `failed`:
// the start itself threw.
export type RestartResult =
  | { kind: "started"; agentId: string; marked: boolean }
  | { kind: "live" } | { kind: "forwarded"; peer: string } | { kind: "skipped" }
  | { kind: "deferred"; reason: string } | { kind: "failed"; error: Error };
// `retryHint`: how the owner tries again, for a start that fails on setup. `eligible`: why the
// ticket may not start any more (null: it may), checked last before the start.
export type RestartOptions = { retryHint?: string; eligible?: () => Promise<string | null> };
// The project flow's restarts: a deferred or failed restart throws, as before restartFor had a
// result, so the caller's catch releases its scheduler reservation and logs why.
export function restartOrThrow(result: RestartResult): void {
  if (result.kind === "deferred") throw new Error(result.reason);
  if (result.kind === "failed") throw result.error;
}
// How a crashed agent is recovered: `before` runs with the resume text and the crash right before
// the reload, so the caller can claim the attempt and keep the resume until it went out.
// `unverified`: the ticket state the restart went by could not be read just now (see unverifiedResume).
export type Recovery = { issueId: string; before: (resume: string, error: string) => Promise<void>; unverified?: UnverifiedState };
type Snapshot = ProcessAgent & { activeTurn?: unknown; pendingPermissions?: unknown[] | null };

// Running, starting, in a turn or waiting for an answer: a message would interrupt the turn or drop
// the question.
function busy(agent: Snapshot): boolean {
  return Boolean(agent.activeTurn || agent.status === "running" || agent.status === "initializing" || agent.pendingPermissions?.length);
}

export type SessionLink = {
  sessionId: string;
  agentId: string | null;
  issueId: string;
  identifier: string;
  createdAt: string;
  handled: string[];
  // What a plain reply in the panel means right now, besides a pending permission.
  review: PendingReview | null;
  // "split" / "later": the plugin retired the planner on purpose, so no Resume is offered.
  // "parked": its plan waits for the owner in the central Plannotator host (parked.ts).
  offer: "resume" | "split" | "later" | "parked" | null;
  // Waiting for blockers or an agent slot, or for another start of its ticket to finish; the
  // sweep starts it when admitted, or links it to the agent that start made.
  queued?: boolean;
  // The actual last process, route or admission blocker; absent after the queue is resolved.
  queueReason?: string;
  // An owner-decided parked plan requests a new run even though this session has retired agents.
  restartRequested?: boolean;
  // The comment a thread queued behind another start of its ticket came with, passed on to the
  // agent it is linked to (see startQueued).
  pendingText?: string | null;
  // Who wrote `pendingText`, when that was verified as the owner (the thread's creator, or a reply
  // whose author was checked): only then does its delivery count as the owner's answer (README,
  // "Deputy for agent questions"). Null for a reply that named no author.
  pendingFrom?: { activityId: string; userId: string } | null;
  // A question with several parts, asked one part at a time.
  questions?: { requestId: string; request?: AgentPermissionRequest; index: number; answers: Record<string, string> } | null;
  // Replaced by a newer thread on the same ticket (every @mention opens one); told so and completed.
  // Also a thread that ended without an agent on purpose: refused (not the owner's), or completed
  // in Linear while it waited.
  closed?: boolean;
  // The agent the thread's "Open in Paseo" link points at.
  paseoLinked?: string;
  // The peer host that took this thread's work over (DrainRouter/ActivationIntake): its replies
  // are forwarded, and no local agent id is ever stored for it.
  remote?: string;
  // Handed to Paseo as a group (groups.ts): no agent of its own; its sub-issues are handed out and
  // it closes when they are finished. `delegated`: the ticket was assigned to Paseo when the group
  // started, so unassigning it stops the group. `status`: the last status posted in the panel.
  group?: { delegated: boolean; status?: string };
};

// Every @mention or assignment opens a new Linear thread, so a ticket collects threads while one
// agent works. Only the newest thread with an agent stays open; older ones on that ticket
// (and their stale review links or resume offers) are superseded. A queued thread whose comment
// was not delivered yet is not: the queue sweep passes it on first (see startQueued).
export function supersededSessions(links: SessionLink[]): { link: SessionLink; current: SessionLink }[] {
  const result: { link: SessionLink; current: SessionLink }[] = [];
  const byIssue = new Map<string, SessionLink[]>();
  for (const link of links) byIssue.set(link.issueId, [...(byIssue.get(link.issueId) ?? []), link]);
  for (const group of byIssue.values()) {
    const current = group.filter((link) => link.agentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!current) continue;
    for (const link of group) if (link !== current && !link.closed && !(link.queued && link.pendingText) && link.createdAt < current.createdAt) result.push({ link, current });
  }
  return result;
}

// sessionId → Paseo agent, persisted so a reload keeps every conversation connected.
export class SessionStore {
  private links: Record<string, SessionLink> | null = null;
  private loading: Promise<Record<string, SessionLink>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path = join(agentAppDirectory(), "sessions.json")) {}

  // One shared read: two concurrent first loads would each replace the map and drop the other's writes.
  private load(): Promise<Record<string, SessionLink>> {
    return this.loading ??= readFile(this.path, "utf8").then((text) => JSON.parse(text) as Record<string, SessionLink>, () => ({})).then((links) => (this.links = links));
  }

  private persist(): Promise<void> {
    const run = async () => {
      await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(this.links ?? {}), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async get(sessionId: string): Promise<SessionLink | null> {
    return (await this.load())[sessionId] ?? null;
  }

  // The newest session of an agent: the one its activities go to.
  async forAgent(agentId: string): Promise<SessionLink | null> {
    const links = Object.values(await this.load()).filter((link) => link.agentId === agentId);
    return links.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async all(): Promise<SessionLink[]> {
    return Object.values(await this.load());
  }

  // The ticket of a known agent: the newest thread that names it. The resume guard
  // (activation-guard.ts) reads this so a heartbeat for an old root of this host is still
  // recognized as ticket work after its thread was closed.
  async agentTicket(agentId: string): Promise<{ issueId: string; identifier: string } | null> {
    const links = Object.values(await this.load()).filter((link) => link.agentId === agentId);
    const newest = links.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return newest ? { issueId: newest.issueId, identifier: newest.identifier } : null;
  }

  async put(link: SessionLink): Promise<void> {
    (await this.load())[link.sessionId] = { ...link, handled: [...link.handled] };
    await this.persist();
  }

  async patch(sessionId: string, change: Partial<SessionLink>): Promise<void> {
    const links = await this.load();
    if (!links[sessionId]) return;
    links[sessionId] = { ...links[sessionId], ...change };
    await this.persist();
  }

  async removeIssue(issueId: string): Promise<void> {
    const links = await this.load();
    for (const [id, link] of Object.entries(links)) if (link.issueId === issueId) delete links[id];
    await this.persist();
  }

  // True the first time an activity is seen; webhook and sweep both deliver prompts.
  async claim(sessionId: string, activityId: string): Promise<boolean> {
    const link = (await this.load())[sessionId];
    if (!link || link.handled.includes(activityId)) return false;
    link.handled = [...link.handled, activityId].slice(-HANDLED_LIMIT);
    await this.persist();
    return true;
  }
}

function paseoCli(): string {
  for (const candidate of [process.env.PASEO_CLI, "/Applications/Paseo.app/Contents/Resources/bin/paseo", join(process.env.HOME ?? "", ".local/bin/paseo")]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "paseo";
}

// Switches an agent's mode (the plugin SDK cannot), e.g. from plan-first back to the usual mode.
export async function setAgentMode(agentId: string, modeId: string): Promise<void> {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  await exec(paseoCli(), ["agent", "mode", agentId, modeId], { timeout: 15_000, env });
}

// Interrupts the agent's running turn. The plugin SDK has no cancel, so the CLI does it.
export async function stopAgentTurn(agentId: string): Promise<void> {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  await exec(paseoCli(), ["stop", agentId], { timeout: 15_000, env });
}

const OTHER_OPTION = /^other\b/i;

// Buttons for one question part. "Other (type your own)" is not a button: typing an answer is.
export function questionPrompt(request: AgentPermissionRequest, index: number): { body: string; options: SelectOption[] } {
  const parts = answerableQuestions(request);
  const part = parts[index]?.question ?? questionsOf(request)[0] ?? {};
  const labels = (part.options ?? []).map((option) => option.label ?? "").filter(Boolean);
  const other = labels.some((label) => OTHER_OPTION.test(label)) || Boolean((part as { allowOther?: boolean }).allowOther);
  const counter = parts.length > 1 ? `(${index + 1}/${parts.length})` : "";
  const title = index === 0 ? [request.title, request.description].filter(Boolean).join("\n\n") : "";
  const question = part.question && part.question !== request.title ? part.question : "";
  return {
    body: [`${[question || title, counter].filter(Boolean).join(" ")}`, index === 0 && question ? title : "", other ? "Or type your own answer." : ""].filter(Boolean).join("\n\n") || "The agent has a question.",
    options: labels.filter((label) => !OTHER_OPTION.test(label)).map((label) => ({ label, value: label })),
  };
}

// "SFTP" or "sftp" (a clicked option's value) both select the option labelled SFTP.
export function optionsForQuestion(request: AgentPermissionRequest): SelectOption[] {
  return questionPrompt(request, 0).options;
}

// The web app opens the agent directly when this browser is paired with the host.
export function paseoAgentUrl(serverId: string, agentId: string): string {
  return `https://app.paseo.sh/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

let serverIdCache: Promise<string | null> | null = null;
export function daemonServerId(): Promise<string | null> {
  serverIdCache ??= exec(paseoCli(), ["daemon", "status", "--json"], { timeout: 15_000 })
    .then(({ stdout }) => { const id = (JSON.parse(stdout) as { serverId?: unknown }).serverId; return typeof id === "string" ? id : null; })
    .catch(() => null);
  return serverIdCache;
}

// The live feed's cadence: one agentActivity per running agent at most this often (README, "Rate
// limits"). At 4 s it cost the app up to 1,150 requests an hour on server087 (2026-10-08).
const LIVE_FLUSH_MS = 15_000;
const HOLD_MS = 5 * 60 * 1000;

// Checklist entries from a plan's markdown: "- [ ] step", "1. step" or "- step" under a
// Steps heading, falling back to all checkbox lines.
export function planSteps(markdown: string): string[] {
  const lines = markdown.split("\n");
  const checkbox = lines.map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]).filter((text): text is string => Boolean(text));
  if (checkbox.length) return checkbox.slice(0, 30);
  // A "Steps" section wins over "Implementation", which wins over a general "Plan" heading.
  const heading = (word: string) => lines.findIndex((line) => new RegExp(`^#{1,4}\\s+${word}\\b`, "i").test(line));
  const start = [heading("steps"), heading("implementation"), heading("plan")].find((index) => index >= 0) ?? -1;
  if (start < 0) return [];
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line)) break;
    const step = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)?.[1];
    if (step) steps.push(step);
  }
  return steps.slice(0, 30);
}

type Deps = {
  api: AgentApi;
  linear: Pick<LinearService, "viewerId" | "appUserId" | "addLabel" | "removeLabel" | "complete" | "cancel" | "issueState" | "admissionStates" | "issueGroup" | "delegate" | "moveToStateNamed" | "comment" | "hasComment" | "userUrl">;
  starter: Pick<TicketStarter, "start" | "admission">;
  // The ticket's handover record: a successor resumes from it and takes it over (succeed).
  handover: Pick<Handover, "resumeTarget" | "handOff">;
  // The per-ticket start gate every automatic start path takes (Launcher.gate).
  launcher: Pick<Launcher, "gate">;
  // Activation routing (activation.ts): the draining host forwards, the receiving host defers
  // claimed tickets. Absent: today's local-only behavior.
  route?: ActivationSink;
  settings: Pick<Settings, "read">;
  store: SessionStore;
  replies?: PermissionReplies;
  stop?: (agentId: string) => Promise<void>;
  // The owner's decisions in the panel, journaled before anything happens (plannotator.ts,
  // decideOwner / decidePanel). `decidePlan` answers null when the workflow replied itself.
  decideReview?: (localUrl: string, approve: boolean, feedback: string, agentId: string, origin: { reviewId?: string; openedAt?: string; source: "linear-panel" }) => Promise<void>;
  decidePlan?: (link: SessionLink, mode: "later" | "split") => Promise<string | null>;
  // A review decided on Plannotator's own page, found after its server is gone; journaled for the
  // stored review before the session lets go of it.
  reviewOutcome?: (review: PendingReview) => Promise<ReviewOutcome>;
  recordOutcome?: (agentId: string, outcome: Exclude<ReviewOutcome, "open" | null>, review: PendingReview) => Promise<void>;
  // Open "Needs you" sub-issues: an @mention there goes to the agent that asked, not a new one.
  needsYou?: NeedsYouIssues;
  // The daemon's agent reload (`paseo agent reload`), resolved per use: null while the plugin has
  // no daemon connection of its own.
  reloader?: () => Promise<((agentId: string) => Promise<void>) | null>;
  // Exact provider-process inspection, injectable without changing daemon or filesystem state.
  processLiveness?: typeof ticketProcessLiveness;
  // The process table ghost agents are checked against (see liveSuccessorFor); the tests inject one.
  processInspector?: ProcessInspector;
  // The clock the webhook fallback windows are measured against.
  now?: () => number;
  budget?: Pick<RateBudget, "pausedUntil" | "blockedUntil">;
  deletions?: Pick<ReviewDeletions, "get" | "blocked" | "forAgent">;
  // The watchdog's durable owner Stop and owner continuations (watchdog.ts).
  watchdog?: Pick<WatchdogStore, "hold" | "continued" | "read">;
  limitResumes?: LimitResumeStore;
  usage?: Pick<UsageReader, "read" | "chains">;
  jitter?: () => number;
  // How a bounded wait for a stopped turn pauses between reads; the tests inject one.
  sleep?: (ms: number) => Promise<void>;
  // Whether this host owns the ticket's automatic work (activation.ts claims, read only): `here`,
  // `elsewhere` (the peer host does), or `unknown` (its state is unreadable). Absent: here.
  owner?: (issueId: string) => Promise<HostOwnership>;
};

// One queue pass's Linear reads (see startQueued): the waiting threads' session states, or the
// error their batched read failed with, and each ticket's admission state on demand.
type QueuedReads = { sessions: Map<string, string> | Error; ticket: (issueId: string) => Promise<AdmissionState> };

// How long a watchdog Stop waits for the turn to end before it counts as failed.
const STOP_WAIT_MS = 60_000;

// Linear agent sessions ↔ Paseo agents. Inbound: `created` starts or links an agent, and
// `prompted` answers its question, decides its approval or plan review, stops it, or sends a
// message. Outbound: the helpers below post what the agent does into the session.
export class SessionRouter {
  private paseo: PaseoApi | null = null;
  private waiting: AgentSessionWebhook[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private pausedSweep: string | null = null;
  private pauseDuringSweep = false;
  // Agents the user stopped from Linear: a turn the provider starts on its own is stopped again.
  private readonly held = new Map<string, number>();
  // Live action feed per agent during a turn: the subscription and actions not yet posted.
  // `asking`: Linear shows an elicitation's options only while it is the newest activity, so the
  // feed holds its actions from a question until the owner's reply.
  private readonly live = new Map<string, { sessionId: string; stop: () => void; pending: string[]; timer: NodeJS.Timeout | null; posted: number; asking: boolean }>();
  // Event-driven activity reads (README, "Rate limits"): `webhookedAt` is the last webhook per
  // session, `webhookReadAt` when its activities were last read because of one. A session with a
  // fresh webhook is skipped by the sweep; one whose webhooks stopped, or never arrived, is read
  // every sweep as before. `reads` counts both for `linear.agent-status`.
  private readonly webhookedAt = new Map<string, number>();
  private readonly webhookReadAt = new Map<string, number>();
  private readonly readingSession = new Set<string>();
  private readonly reads = { sweep: 0, skipped: 0, webhook: 0 };
  // The open-session listing, shared by the parts of one sweep: Linear counts every call (README,
  // "Rate limits"). A failed call is dropped rather than shared, so the other part retries it.
  private sessionList: Promise<OpenSession[]> | null = null;
  // Reads webhooks started (`receive` is fire-and-forget), awaited by `settled`.
  private readonly inflightReads = new Set<Promise<unknown>>();

  // Explicit overrides retain their existing path; confirmed answer evidence is owned by replies.
  private deputy: Pick<Deputy, "byRef" | "correct"> | null = null;
  private readonly replies: PermissionReplies;

  constructor(private readonly deps: Deps) {
    this.replies = deps.replies ?? new PermissionReplies({ directory: dirname(deps.store.path), daemon: async () => null });
  }

  recordDeputy(deputy: Pick<Deputy, "byRef" | "correct">): void {
    this.deputy = deputy;
  }

  // Restored multipart answers veto the deputy before its startup recovery or dispatch.
  async seedHolds(): Promise<void> {
    for (const link of await this.deps.store.all()) {
      if (link.agentId && link.questions && !link.closed) this.replies.holdForOwner(link.agentId, link.questions.requestId);
    }
  }

  attach(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    for (const event of this.waiting.splice(0)) this.track(this.handle(event));
    this.timer = setInterval(() => { void this.sweep(); }, SWEEP_MS);
    this.timer.unref?.();
    void this.sweep();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const state of this.live.values()) { if (state.timer) clearTimeout(state.timer); state.stop(); }
    this.live.clear();
  }

  // Await any already-admitted start/recovery before deletion; the durable pause blocks new ones.
  async settleTicket(issueId: string): Promise<void> {
    await this.exclusive(issueId, async () => {});
  }

  async deleteTicket(issueId: string, reviewAgentId: string): Promise<void> {
    if (!this.paseo) throw new Error("Paseo is not connected; ticket-agent cleanup cannot finish.");
    await this.exclusive(issueId, async () => {
      const links = (await this.deps.store.all()).filter((link) => link.issueId === issueId);
      const agents = await issueAgents(this.paseo!, issueId);
      const ids = new Set([reviewAgentId, ...agents.map((agent) => agent.id), ...links.flatMap((link) => link.agentId ? [link.agentId] : [])]);
      const failures: string[] = [];
      for (const id of ids) {
        const state = this.live.get(id);
        if (state) { clearTimeout(state.timer ?? undefined); state.stop(); this.live.delete(id); }
        try {
          const found = await this.paseo!.agents.ref(id).refresh();
          if (!found || found.agent.archivedAt) continue;
          try { await (this.deps.stop ?? stopAgentTurn)(id); } catch (error) { failures.push(`stop ${id}: ${error instanceof Error ? error.message : error}`); }
          await this.paseo!.agents.ref(id).archive();
        } catch (error) {
          if (!/not found/i.test(error instanceof Error ? error.message : String(error))) failures.push(`archive ${id}: ${error instanceof Error ? error.message : error}`);
        }
      }
      this.waiting = this.waiting.filter((event) => {
        const issue = (event.agentSession.issue ?? {}) as { id?: string };
        return String(event.agentSession.issueId ?? issue.id ?? "") !== issueId;
      });
      await this.deps.store.removeIssue(issueId);
      for (const link of links) this.releaseQuestions(link);
      this.lastAutoResume.delete(issueId);
      if (failures.length) throw new Error(failures.join("; "));
    });
  }

  // Entry point for webhooks. Acknowledges `created` right away — Linear marks sessions without
  // an activity within 10 s as unresponsive — even before Paseo is reachable.
  receive(event: AgentSessionWebhook): void {
    const sessionId = event.agentSession.id;
    const now = this.clock();
    // A webhook for this session is proof Linear's delivery works for it: the sweep stops reading
    // it every minute, and a due read happens here at once instead of at the next sweep. A
    // `created` webhook has nothing to catch up on: its session is read from its first prompt on.
    const readAt = this.webhookReadAt.get(sessionId);
    const due = readAt === undefined || now - readAt >= WEBHOOK_FALLBACK_MS;
    this.webhookedAt.set(sessionId, now);
    if (event.action !== "created" && due) this.track(this.readSession(sessionId, "webhook"));
    if (event.action === "created") void this.say(event.agentSession.id, "thought", "Paseo received this — preparing an agent…").catch(() => {});
    if (!this.paseo) { this.waiting.push(event); return; }
    this.track(this.handle(event));
  }

  // What the event-driven reads did, for `linear.agent-status` (README, "Rate limits").
  readStats(): { sweepReads: number; sweepSkips: number; webhookReads: number } {
    return { sweepReads: this.reads.sweep, sweepSkips: this.reads.skipped, webhookReads: this.reads.webhook };
  }

  // Waits for the reads and deliveries webhooks started, the way `sweep()` waits for its parts.
  async settled(): Promise<void> {
    while (this.inflightReads.size) await Promise.all([...this.inflightReads]);
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private track(work: Promise<unknown>): void {
    const running = work
      .catch((error: unknown) => console.error(`[linear-tickets] reading a session's activities after a webhook failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => this.inflightReads.delete(running));
    this.inflightReads.add(running);
  }

  private async handle(event: AgentSessionWebhook): Promise<void> {
    try {
      if (event.action === "created") await this.created(event.agentSession);
      else if (event.action === "prompted" && event.agentActivity) await this.prompted(event.agentSession.id, event.agentActivity);
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`[linear-tickets] agent session ${event.agentSession.id}: ${message}`);
      await this.say(event.agentSession.id, "error", `Paseo could not handle this: ${message}`).catch(() => {});
    }
  }

  private async owner(): Promise<string> {
    return this.deps.linear.viewerId();
  }

  // "override D-…" (README, "Deputy for agent questions"): the owner corrects a deputy answer. It
  // goes to the agent that got that answer as a message, before the text could answer a newer
  // question or start anything. Null when the text is no override.
  private async override(text: string, activity: CorrectionActivity): Promise<Correction | null> {
    const command = this.deputy ? overrideCommand(text) : null;
    if (!command || !this.deputy) return null;
    const target = await this.deputy.byRef(command.ref);
    return target
      ? this.deputy.correct(target, command.text, activity)
      : { delivered: false, reply: `${command.ref} is not an answer the deputy gave on this host, so nothing was passed on.` };
  }

  private origin(link: Pick<SessionLink, "sessionId" | "issueId">, text: string, activity?: Omit<CorrectionActivity, "via"> | null): DeliveryOrigin {
    const ref = activity?.activityId
      ? `session:${activity.activityId}`
      : `queued:${link.sessionId}:${createHash("sha256").update(text).digest("hex")}`;
    return {
      ref,
      issueId: link.issueId,
      responder: activity?.userId.trim()
        ? { kind: "owner", via: "linear-session", activityId: activity.activityId || ref, userId: activity.userId }
        : { kind: "linear-unverified", via: "linear-session", ref },
    };
  }

  // Routing and replay protection are shared with comments and forwarded replies.
  private passOn(agentId: string, text: string, origin: DeliveryOrigin): Promise<DeliveryResult> {
    return deliverToAgent(this.paseo!, agentId, text, origin, this.replies);
  }

  private async deliveryReply(sessionId: string, result: DeliveryResult): Promise<void> {
    if (result.reply) await this.say(sessionId, result.delivered ? "response" : "error", result.reply);
  }

  private releaseQuestions(link: SessionLink): void {
    if (link.agentId && link.questions) this.replies.releaseOwner(link.agentId, link.questions.requestId);
  }

  private async activeAgentFor(issueId: string): Promise<{ id: string; title: string | null } | null> {
    const page = await this.paseo!.agents.list({ filter: { labels: { "linear.issueId": issueId }, includeArchived: false }, page: { limit: 20 } });
    const agent = page.entries.map((entry) => entry.agent).find((candidate) => !candidate.labels?.["paseo.parent-agent-id"]);
    return agent ? { id: agent.id, title: agent.title ?? null } : null;
  }

  // Bounded public ticket history: a different Linear thread's retired root cannot settle this
  // queue. A current root takes precedence, including one a newer thread started meanwhile.
  private async queuedOwners(link: SessionLink): Promise<{ current: PaseoAgent | null; previous: PaseoAgent | null }> {
    const candidates: PaseoAgent[] = [];
    let previous: PaseoAgent | null = null;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber === QUEUED_OWNER_MAX_PAGES) throw new Error("The ticket's agent history could not be fully read.");
      const page = await this.paseo!.agents.list({ filter: { labels: { "linear.issueId": link.issueId }, includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) {
        if (agent.labels?.["linear.issueId"] !== link.issueId || agent.labels?.["paseo.parent-agent-id"]) continue;
        if (agent.labels?.["linear.sessionId"] === link.sessionId && (!previous || agent.createdAt > previous.createdAt)) previous = agent;
        if (!agent.archivedAt && agent.status !== "closed" && !crashedProcess(agent)) candidates.push(agent);
      }
      if (!page.pageInfo) throw new Error("The ticket's agent history could not be fully read.");
      if (!page.pageInfo.hasMore) break;
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (!cursor || cursors.has(cursor)) throw new Error("The ticket's agent history could not be fully read.");
      cursors.add(cursor);
    }
    const ghosts = await ghostAgents(candidates, this.clock(), this.deps.processInspector);
    let current: PaseoAgent | null = null;
    for (const agent of candidates) if (!ghosts.has(agent.id) && (!current || agent.createdAt > current.createdAt)) current = agent;
    return { current, previous };
  }

  async created(session: Record<string, unknown> & { id: string }): Promise<void> {
    const issue = (session.issue ?? {}) as { id?: string; identifier?: string };
    const issueId = String(session.issueId ?? issue.id ?? "");
    const identifier = String(issue.identifier ?? "this ticket");
    if (!issueId) throw new Error("The session has no ticket.");
    if (await this.deps.deletions?.blocked(issueId)) return;
    const known = await this.deps.store.get(session.id);
    if (known?.agentId || known?.group) return;
    const link: SessionLink = { sessionId: session.id, agentId: null, issueId, identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null };
    // One-person workspace: other integrations acting in Linear must not start agents here. Kept
    // as closed, so the ticket left assigned to Paseo is not taken for a failed start either.
    const owner = await this.owner();
    if (String(session.creatorId ?? "") !== owner) {
      await this.deps.store.put({ ...link, closed: true });
      await this.say(session.id, "error", "Only the workspace owner can start Paseo agents.");
      return;
    }
    // A new thread from the owner is an explicit continuation: the watchdog's hold on the ticket ends.
    await this.deps.watchdog?.continued(issueId).catch((error: unknown) => console.error(`[linear-tickets] ${identifier}: recording the owner's continuation for the watchdog failed: ${error instanceof Error ? error.message : error}`));
    const comment = (session.comment ?? {}) as { body?: string };
    const text = typeof comment.body === "string" && !/^This thread is for an agent session/.test(comment.body) ? comment.body.replace(/@paseo\b/gi, "").trim() : "";
    // The thread's creator was checked as the owner above.
    const from = { activityId: session.id, userId: owner };
    // A correction of a deputy answer starts nothing and answers nothing: the thread only
    // reports where it went.
    const corrected = text ? await this.override(text, { via: "linear-session", ...from }) : null;
    if (corrected) {
      await this.deps.store.put({ ...link, closed: true });
      await this.say(session.id, corrected.delivered ? "response" : "error", corrected.reply);
      return;
    }
    // Another automatic start of the ticket is under way: the thread waits for it, and the queue
    // sweep links it to the agent it made (passing the comment on) or starts one.
    const gate = this.deps.launcher.gate(issueId);
    if (!gate) {
      await this.deps.store.put({ ...link, queued: true, queueReason: "a launch for this ticket is under way", pendingText: text || null, pendingFrom: text ? from : null });
      await this.say(session.id, "thought", "A launch for this ticket is under way; this thread joins its agent once it is up, or starts one.");
      return;
    }
    try {
      const wait = await this.processWait(issueId);
      if (wait) {
        await this.deps.store.put({ ...link, queued: true, queueReason: wait, pendingText: text || null, pendingFrom: text ? from : null });
        await this.say(session.id, "thought", `Queued: ${wait}; this thread waits for confirmed process exit.`);
        return;
      }
      const asked = (await this.deps.needsYou?.all())?.find((entry) => entry.id === issueId);
      const existing = asked
        ? { id: asked.agentId, title: (await this.paseo!.agents.ref(asked.agentId).refresh().catch(() => null))?.agent.title ?? null }
        : await this.activeAgentFor(issueId);
      if (existing) {
        await this.deps.store.put({ ...link, agentId: existing.id });
        await this.linkToPaseo(session.id, existing.id).catch(() => {});
        // Same as a relayed comment: answers a pending question or decides a pending approval.
        if (text) await this.deliveryReply(session.id, await this.passOn(existing.id, text, this.origin(link, text, from)));
        await this.say(session.id, "thought", `Linked to the running agent “${existing.title ?? existing.id}”.${text ? " Your message was passed on." : ""}`);
        await this.closeSuperseded();
        return;
      }
      // Everything this host must not start (it drains, the peer still owns the ticket, or the
      // hosts have not shaken hands yet) is taken over before anything local plans it -- the
      // group keeper included, so no sub-issue is handed out here for a ticket that is not this
      // host's to start.
      const routed = await this.deps.route?.take({ kind: "session", issueId, identifier, sessionId: session.id, ...(text ? { text } : {}) });
      if (routed && "held" in routed) {
        await this.deps.store.put({ ...link, queued: true, queueReason: routed.held, pendingText: text || null, pendingFrom: text ? from : null });
        await this.say(session.id, "thought", `Not started yet: ${routed.held}. This thread stays queued here.`);
        return;
      }
      if (routed) {
        await this.deps.store.put({ ...link, remote: routed.peer });
        await this.say(session.id, "thought", `${identifier} is handled on ${routed.peer}${text ? "; your message was passed on" : ""}.`);
        await this.closeSuperseded();
        return;
      }
      if (await this.startGroup(link)) return;
      await this.deps.store.put(link);
      const admission = await this.deps.starter.admission(issueId, this.paseo!, await this.deps.settings.read());
      if (!admission.ok) {
        await this.deps.store.patch(session.id, { queued: true, queueReason: admission.reason, pendingText: text || null, pendingFrom: text ? from : null });
        await this.say(session.id, "thought", admission.reason);
        return;
      }
      await this.startFor(link, false, true);
      await this.closeSuperseded();
    } finally {
      gate.release();
    }
  }

  // Completes older threads on a ticket once a newer one has the agent, so the ticket shows one
  // live Paseo thread. A reply in a closed thread still reaches the agent.
  async closeSuperseded(): Promise<void> {
    const superseded = supersededSessions(await this.deps.store.all());
    if (!superseded.length) return;
    // Threads Linear already shows as complete are only marked, not told again.
    const open = new Set((await this.listSessions()).filter((session) => session.status !== "complete").map((session) => session.id));
    for (const { link, current } of superseded) {
      await this.clearReview(link.sessionId);
      await this.deps.store.patch(link.sessionId, { closed: true, offer: null, questions: null, queued: false, queueReason: undefined, restartRequested: undefined });
      this.releaseQuestions(link);
      if (!open.has(link.sessionId)) continue;
      const title = current.agentId ? (await this.paseo?.agents.ref(current.agentId).refresh().catch(() => null))?.agent.title : null;
      await this.say(link.sessionId, "response", `Continued in the newest Paseo thread on this ticket${title ? ` (agent “${title}”)` : ""}. Follow and reply there; this thread is closed.`).catch(() => {});
    }
  }

  // A new agent for the thread's ticket. It runs in the ticket's turn (see exclusive), so a crash
  // recovery of the predecessor waits until the successor started and the predecessor is archived.
  private startFor(link: SessionLink, fresh: boolean, gateHeld = false): Promise<void> {
    return this.exclusive(link.issueId, async () => {
      if (await this.deps.deletions?.blocked(link.issueId)) return;
      const gate = gateHeld ? null : this.deps.launcher.gate(link.issueId);
      try {
        const wait = !gateHeld && !gate ? "a launch for this ticket is under way" : await this.processWait(link.issueId);
        if (wait) {
          if (!link.agentId) await this.deps.store.patch(link.sessionId, { queued: true, queueReason: wait });
          await this.say(link.sessionId, "thought", `Queued: ${wait}; this thread waits before starting another agent.`);
          return;
        }
        await this.startNow(link, fresh);
      } finally {
        gate?.release();
      }
    });
  }

  private async startNow(link: SessionLink, fresh: boolean): Promise<void> {
    if (await this.deps.deletions?.blocked(link.issueId)) return;
    const settings = await this.deps.settings.read();
    // This thread's next agent belongs to the peer (the host drains, or the ticket is claimed
    // there): the pending comment goes with it, and nothing starts here.
    const routed = await this.deps.route?.take({ kind: "session", issueId: link.issueId, identifier: link.identifier, sessionId: link.sessionId, ...(link.pendingText ? { text: link.pendingText } : {}) });
    if (routed && "held" in routed) {
      // Nothing was started and nothing was forwarded: the thread keeps its message and the
      // sweep tries again.
      await this.deps.store.patch(link.sessionId, { queued: true, queueReason: routed.held });
      await this.say(link.sessionId, "thought", `Not started yet: ${routed.held}. This thread stays queued here.`);
      return;
    }
    if (routed) {
      await this.deps.store.patch(link.sessionId, { queued: false, queueReason: undefined, restartRequested: undefined, pendingText: null, offer: null, remote: routed.peer });
      await this.say(link.sessionId, "thought", `Handed to ${routed.peer}: this host does not start new work for ${link.identifier}.`);
      return;
    }
    const running = dispatchLabels(settings.dispatch.label).running;
    await this.deps.linear.addLabel(link.issueId, running).catch(() => {});
    try {
      const started = await this.deps.starter.start(link.issueId, this.paseo!, settings, { labels: { "linear.sessionId": link.sessionId }, retryHint: "assign Paseo again", fresh, ...(link.pendingText ? { lead: link.pendingText } : {}) });
      await this.deps.store.patch(link.sessionId, { agentId: started.agentId, offer: null, questions: null, queued: false, queueReason: undefined, restartRequested: undefined, pendingText: null });
      this.releaseQuestions(link);
      // The stopped agent is closed only after the session points at its successor, so its
      // archive does not offer another resume. Its worktree stays for the new agent.
      if (link.agentId && link.agentId !== started.agentId) await this.paseo!.agents.ref(link.agentId).archive().catch(() => {});
      const warnings = started.warnings.length ? `\n\nWarnings:\n${started.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      const plan = started.plan === "required"
        ? started.untrusted ? " This ticket is not yours, so its plan waits for your approval." : " The agent plans first; a plan within your risk threshold is approved automatically, any other waits for you."
        : "";
      await this.say(link.sessionId, "thought", `${started.resumed ? "Resumed the previous agent's work" : "Started"} with ${started.provider} in ${started.target} (Paseo agent ${started.agentId.slice(0, 8)}).${plan}${warnings}`);
      await this.linkToPaseo(link.sessionId, started.agentId).catch(() => {});
    } catch (error) {
      await this.deps.linear.removeLabel(link.issueId, running).catch(() => {});
      throw error;
    }
  }

  async prompted(sessionId: string, activity: Record<string, unknown>): Promise<void> {
    const link = await this.deps.store.get(sessionId);
    if (link?.review) return withPriority("owner", "plan decision", () => this.promptedWithLink(sessionId, activity, link));
    return this.promptedWithLink(sessionId, activity, link);
  }

  private async promptedWithLink(sessionId: string, activity: Record<string, unknown>, link: SessionLink | null): Promise<void> {
    for (const [agentId, state] of this.live) {
      if (state.sessionId !== sessionId || !state.asking) continue;
      state.asking = false;
      state.timer ??= setTimeout(() => { void asCaller("session-live-feed", () => this.flush(agentId)); }, LIVE_FLUSH_MS);
    }
    const activityId = String(activity.id ?? "");
    const content = (activity.content ?? {}) as { body?: string };
    let body = String(content.body ?? activity.body ?? "").trim();
    const signal = typeof activity.signal === "string" ? activity.signal : null;

    if (!link) { await this.say(sessionId, "error", "No Paseo agent is linked to this session. Assign Paseo to the ticket again."); return; }
    if (await this.deps.deletions?.blocked(link.issueId)) return;
    const claimed = !activityId || await this.deps.store.claim(sessionId, activityId);
    const userId = typeof activity.userId === "string" ? activity.userId : String(((activity.user ?? {}) as { id?: string }).id ?? "");
    if (userId && userId !== await this.owner()) { await this.say(sessionId, "error", "Only the workspace owner can steer Paseo agents."); return; }
    // A durable delivery outranks the short handled window and current multipart question.
    // Also finish effects of an already-claimed activity whose process died after the ack.
    const recorded = activityId ? await this.replies.recorded(`session:${activityId}`) : null;
    if (recorded) { await this.deliveryReply(sessionId, recorded); return; }
    if (!claimed) return;
    // The ticket lock orders owner cancellation against a due start. Re-read after waiting:
    // a start that won the lock may have replaced the agent this reply originally named.
    const issueId = link.issueId;
    link = await this.exclusive(issueId, async () => {
      const current = await this.deps.store.get(sessionId);
      if (!current) return null;
      const watchdogNote = (error: unknown) => console.error(`[linear-tickets] ${current.identifier}: recording the owner's ${signal === "stop" ? "Stop" : "continuation"} for the watchdog failed: ${error instanceof Error ? error.message : error}`);
      if (signal === "stop") await this.deps.watchdog?.hold(issueId, current.agentId).catch(watchdogNote);
      else await this.deps.watchdog?.continued(issueId).catch(watchdogNote);
      await this.deps.limitResumes?.update((file) => finishPending(file, issueId, "cancelled"))
        .catch((error: unknown) => console.error(`[linear-tickets] cancelling limit resume failed: ${error instanceof Error ? error.message : error}`));
      return current;
    });
    if (!link) return;

    if (link.offer === "resume") {
      if (body.toLowerCase() === RESUME || /resume/i.test(body)) { await this.startFor(link, false); return; }
      await this.deps.store.patch(sessionId, { offer: null });
      if (body.toLowerCase() === LEAVE) { await this.say(sessionId, "response", "Left as it is. Assign Paseo again whenever you want it continued."); return; }
    }
    // "Approve, implement later": any reply in this session starts the implementing agent.
    if (link.offer === "later") { await this.startFor(link, false); return; }
    if (link.group && link.closed) { await this.say(sessionId, "response", `Paseo no longer hands out ${link.identifier}'s sub-issues. Assign Paseo to it again to continue.`); return; }
    if (link.group && !link.review) {
      if (signal === "stop") {
        await this.deps.store.patch(sessionId, { closed: true });
        await this.say(sessionId, "response", "Stopped handing out sub-issues. Agents already working continue; assign Paseo again to continue.");
        return;
      }
      // Any reply asks for the current status, posted even when it has not changed.
      await this.advanceGroup({ ...link, group: { ...link.group, status: undefined } });
      return;
    }
    const corrected = await this.override(body, { via: "linear-session", activityId, userId });
    if (corrected) {
      await this.say(sessionId, corrected.delivered ? "response" : "error", corrected.reply);
      return;
    }
    // Multipart progress belongs to its captured local request, not a peer's current question.
    if (body && this.deps.route && !link.questions) {
      const routed = await this.deps.route.take({ kind: "reply", issueId: link.issueId, identifier: link.identifier, sessionId, ...(activityId ? { activityId } : {}), text: body });
      if (routed && "held" in routed) {
        // Nothing was started or sent anywhere; the answer stays with the thread and the sweep
        // tries again (the owner sees why here).
        await this.deps.store.patch(sessionId, { queued: true, queueReason: routed.held, pendingText: body, pendingFrom: userId ? { activityId, userId } : null });
        await this.say(sessionId, "thought", `Not passed on yet: ${routed.held}. Your message stays queued here.`);
        return;
      }
      if (routed) {
        await this.deps.store.patch(sessionId, { remote: routed.peer, queued: false, queueReason: undefined, restartRequested: undefined, pendingText: null });
        await this.say(sessionId, "response", `Passed to the agent working on ${link.identifier} on ${routed.peer}.`);
        return;
      }
    }
    if (!link.agentId) { await this.say(sessionId, "error", "The agent for this session has not started yet."); return; }
    const handle = this.paseo!.agents.ref(link.agentId);
    if (signal === "stop") {
      this.held.set(link.agentId, Date.now());
      await (this.deps.stop ?? stopAgentTurn)(link.agentId);
      await this.say(sessionId, "response", "Stopped the agent's current turn. Reply here to continue.");
      return;
    }
    const later = body.toLowerCase() === APPROVE_LATER;
    if (link.review && (later || body.toLowerCase() === SPLIT_PLAN) && this.deps.decidePlan) {
      // Journaled first; the workflow holds the session (no Resume while the planner is retired),
      // groups it for a split, clears the review and replies with its summary.
      try {
        const reply = await this.deps.decidePlan(link, later ? "later" : "split");
        if (reply) await this.say(sessionId, "response", reply);
      } catch (error) {
        if (!(error instanceof DecisionPendingError || error instanceof FencedError)) throw error;
        await this.say(sessionId, "response", error.message);
      }
      return;
    }
    if (link.review && this.deps.decideReview) {
      const approve = body.toLowerCase() === APPROVE_PLAN || /^(approve|approved|yes|ok|looks good)\b/i.test(body);
      const feedback = body.toLowerCase() === SEND_BACK ? "Sent back from Linear." : body;
      try {
        await this.deps.decideReview(link.review.localUrl, approve, approve ? "" : feedback, link.agentId, { reviewId: link.review.reviewId, openedAt: link.review.openedAt, source: "linear-panel" });
        await this.clearReview(sessionId);
        await this.say(sessionId, "thought", approve ? "Plan approved." : "Plan sent back with your feedback.");
        return;
      } catch (error) {
        if (error instanceof DecisionPendingError || error instanceof FencedError) { await this.say(sessionId, "response", error.message); return; }
        if (!(error instanceof ReviewClosedError)) throw error;
        if (error.outcomeUnknown) {
          await this.say(sessionId, "response", "Plannotator did not answer, so it is not confirmed that it took your decision. Paseo asks it again and carries the decision out once it is confirmed; the review inbox shows it under Being applied.");
          return;
        }
        // The review died with its agent process (restart, cancelled turn). The reply still reaches the agent.
        await this.clearReview(sessionId);
        await this.say(sessionId, "thought", "That plan review had already closed, so your reply goes to the agent, which submits the plan again.");
        body = `Your Plannotator plan review closed before the owner decided (for example after a restart). The owner replied in Linear:\n\n${approve ? "Approved." : feedback}\n\nRevise the plan if needed and submit it for review again.`;
      }
    }
    this.held.delete(link.agentId);
    const pending = (await handle.refresh())?.agent.pendingPermissions ?? [];
    const progress = link.questions;
    const question = pending.find((request) => request.kind === "question" && request.id === progress?.requestId)
      ?? pending.find((request) => request.kind === "question");
    const approval = pending.find((request) => request.kind !== "question");
    const origin = this.origin(link, body, { activityId, userId });
    if (progress && progress.requestId !== question?.id) {
      // Finish only the captured question. A newer request must never consume these old parts.
      const request = progress.request;
      const answers = { ...progress.answers };
      const next = request ? answerableQuestions(request).find(({ key }) => answers[key] === undefined) : null;
      if (next) answers[next.key] = matchOption(next.question, body);
      const text = [...Object.entries(answers).map(([key, answer]) => `${key}: ${answer}`), ...(!next && body ? [body] : [])].join("\n");
      const delivery = this.replies.deliver(this.paseo!, link.agentId, text, origin, {
        requestId: progress.requestId,
        ...(request ? { request, response: questionAnswer(request, "", answers) } : {}),
      });
      // deliver has synchronously admitted the owner before this multipart veto is released.
      this.releaseQuestions(link);
      const result = await delivery;
      await this.deps.store.patch(sessionId, { questions: null });
      await this.deliveryReply(sessionId, result);
      if (question) await this.askQuestion(sessionId, question);
      return;
    }
    if (question) {
      const request = progress?.request ?? question;
      const parts = answerableQuestions(request);
      const answers = { ...(progress?.answers ?? {}) };
      const next = parts.find(({ key }) => answers[key] === undefined);
      if (next) answers[next.key] = matchOption(next.question, body);
      const answered = parts.filter(({ key }) => answers[key] !== undefined).length;
      if (answered < parts.length) {
        this.replies.holdForOwner(link.agentId, request.id);
        await this.deps.store.patch(sessionId, { questions: { requestId: request.id, request, index: answered, answers } });
        const prompt = questionPrompt(request, answered);
        await this.ask(sessionId, prompt.body, prompt.options);
        return;
      }
      const response = questionAnswer(request, "", answers);
      const text = Object.entries(answers).map(([key, answer]) => `${key}: ${answer}`).join("\n") || body;
      const delivery = this.replies.deliver(this.paseo!, link.agentId, text, origin, { requestId: request.id, request, response });
      this.releaseQuestions(link);
      const result = await delivery;
      await this.deps.store.patch(sessionId, { questions: null });
      await this.deliveryReply(sessionId, result);
      return;
    }
    if (approval) {
      const decision = approvalDecision(body);
      if (!decision) { await this.say(sessionId, "error", `The agent is waiting for approval of “${approval.title || approval.name}”. Choose Approve or Deny.`); return; }
      await this.deliveryReply(sessionId, await this.passOn(link.agentId, body, origin));
      // Parallel tool calls wait on several approvals; Linear shows only the newest question, so the next one is asked again.
      const next = pending.find((request) => request.kind !== "question" && request.id !== approval.id);
      if (next) await this.ask(sessionId, `Approve this action?\n\n${[next.title || next.name, next.description].filter(Boolean).join("\n\n")}`, [{ label: "Approve", value: "approve" }, { label: "Deny", value: "deny" }]);
      return;
    }
    if (!body) return;
    await this.deliveryReply(sessionId, await this.passOn(link.agentId, body, origin));
  }

  // Whether a start or crash recovery under way (the ticket's turn, see exclusive) or the ticket's
  // newest thread accounts for it, so a missing agent is no failed start: the thread waits for
  // blockers or a free slot (`startQueued` starts it), its agent came up once (a plan approved for
  // later, a resume offered, a parked plan, a group), or it was closed on purpose. False when the
  // ticket has no thread or its newest one never got an agent.
  async threadHolds(issueId: string): Promise<boolean> {
    if (this.turns.has(issueId)) return true;
    const newest = (await this.deps.store.all()).filter((link) => link.issueId === issueId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return Boolean(newest && (newest.queued || newest.agentId || newest.offer || newest.group || newest.closed));
  }

  // Threads waiting for blockers, an agent slot or another start of their ticket. Read from the
  // store, not from `openSessions`: that is Linear's 50 most recently updated sessions in the whole
  // workspace, and a waiting thread posts nothing, so it drops out of that list hours before a slow
  // blocker finishes. Each thread is tried on its own, under the ticket's start gate: a failed read
  // (or a failed send of its comment) leaves it queued for the next sweep, a failed start ends the
  // wait with an error in the thread (as for a ticket that was never queued). A ticket that has an
  // agent meanwhile is linked to it without waiting for a slot: linking starts nothing.
  // Linear counts requests, not threads: the waiting threads' session states are read in batches
  // up front, and their tickets' states, with everything admission decides on, in batches of 50
  // once a thread first needs one (README, "Rate limits").
  async startQueued(): Promise<void> {
    const waiting = (await this.deps.store.all()).filter((link) => link.queued && !link.agentId && !link.closed);
    if (!waiting.length) return;
    let sessions: Map<string, string> | Error;
    try {
      sessions = await this.deps.api.sessionStatuses(waiting.map((link) => link.sessionId));
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      sessions = error instanceof Error ? error : new Error(String(error));
    }
    const reads: QueuedReads = { sessions, ticket: this.ticketStates(waiting.map((link) => link.issueId)) };
    for (const link of waiting) {
      if (await this.deps.deletions?.blocked(link.issueId)) continue;
      const gate = this.deps.launcher.gate(link.issueId);
      if (!gate) {
        if (link.queueReason !== "a launch for this ticket is under way") await this.deps.store.patch(link.sessionId, { queueReason: "a launch for this ticket is under way" });
        continue;
      }
      try {
        await this.startQueuedThread(link, reads);
      } finally {
        gate.release();
      }
    }
  }

  // A ticket's admission state for this queue pass. The first thread that needs one reads it for
  // itself and every ticket after it in one batch; threads of one ticket share its entry. A ticket
  // the batch does not return is read alone, as before batching. A failed batch fails each thread
  // that needs it, as its own read would. Read in the same pass as admission, so no fresher read
  // exists: nothing is cached across passes.
  private ticketStates(issueIds: string[]): (issueId: string) => Promise<AdmissionState> {
    let batch: Promise<Map<string, AdmissionState>> | null = null;
    return async (issueId) => {
      batch ??= this.deps.linear.admissionStates(issueIds.slice(issueIds.indexOf(issueId)));
      return (await batch).get(issueId) ?? this.deps.linear.issueState(issueId);
    };
  }

  private async startQueuedThread(link: SessionLink, reads: QueuedReads): Promise<void> {
    try {
      // Terminal Linear threads must not wait behind capacity, dependencies, routing or orphans.
      // A failed read leaves the queue and its owner's undelivered text intact.
      if (reads.sessions instanceof Error) throw reads.sessions;
      const status = reads.sessions.get(link.sessionId) ?? await this.deps.api.sessionStatus(link.sessionId);
      if (!status || status === "complete" || status === "error") {
        await this.deps.store.patch(link.sessionId, { queued: false, queueReason: undefined, restartRequested: undefined, ...(status === "complete" ? { closed: true } : {}) });
        console.log(`[linear-tickets] ${link.identifier}: queued thread ended in Linear (${status ?? "gone"}); no agent started`);
        return;
      }
      const { current: existing, previous } = await this.queuedOwners(link);
      // Reconnecting an empty retired run is accounting, not a resume or a successful completion.
      // An undelivered owner message is still a legitimate queue: keep it unlinked so the sweep
      // can deliver it to a later live owner. Never revive the retired root or release a hold.
      // A parked plan's explicit owner decision is a real new run, not this stale queue.
      if ((link.offer && !(link.offer === "resume" && existing)) || (!existing && previous && !link.restartRequested)) {
        if (link.pendingText) {
          const reason = link.offer
            ? `The queued owner message waits for the thread's ${link.offer} decision.`
            : "The previous agent for this thread has stopped; the queued owner message waits for a live owner or explicit continuation.";
          if (link.queueReason !== reason) await this.deps.store.patch(link.sessionId, { queueReason: reason });
          return;
        }
        await this.deps.store.patch(link.sessionId, { ...(previous ? { agentId: previous.id } : {}), queued: false, queueReason: undefined, restartRequested: undefined });
        return;
      }
      const wait = await this.processWait(link.issueId);
      if (wait) {
        if (link.queueReason !== wait) await this.deps.store.patch(link.sessionId, { queueReason: wait });
        return;
      }
      const ticket = await reads.ticket(link.issueId);
      if (await this.deps.deletions?.blocked(link.issueId)) return;
      if (ticket.statusType === "completed" || ticket.statusType === "canceled") {
        await this.deps.store.patch(link.sessionId, { queued: false, queueReason: undefined, restartRequested: undefined });
        await this.say(link.sessionId, "response", `${link.identifier} was moved to ${ticket.status} while it waited, so no agent was started. Assign Paseo again to start one.`);
        return;
      }
      if (existing) {
        // A caller's failed store patch replays its activity, never the send. Refresh first:
        // retirement between the directory read and dispatch must not resurrect a dead agent.
        const text = link.pendingText;
        if (text) {
          const found = await this.agent(existing.id);
          if (!found || found.agent.status === "closed" || crashedProcess(found.agent)) return;
          // Only stored, verified authors may be attributed; legacy text keeps a stable hash ref.
          const from = link.pendingFrom?.userId.trim() ? link.pendingFrom : null;
          try {
            await this.deliveryReply(link.sessionId, await this.passOn(existing.id, text, this.origin(link, text, from)));
          } catch (error) {
            await this.say(link.sessionId, "error", error instanceof Error ? error.message : "Your message could not be delivered.");
            throw error;
          }
        }
        await this.deps.store.patch(link.sessionId, { agentId: existing.id, queued: false, queueReason: undefined, restartRequested: undefined, pendingText: null, ...(link.offer === "resume" ? { offer: null } : {}) });
        await this.linkToPaseo(link.sessionId, existing.id).catch(() => {});
        await this.say(link.sessionId, "thought", `Linked to the running agent “${existing.title ?? existing.id}”.${text ? " Your message was passed on." : ""}`);
        return;
      }
      // A draining host forwards before admission; a full host must not strand the peer's work.
      const routed = await this.deps.route?.take({ kind: "session", issueId: link.issueId, identifier: link.identifier, sessionId: link.sessionId, ...(link.pendingText ? { text: link.pendingText } : {}) });
      if (routed && "held" in routed) {
        if (link.queueReason !== routed.held) await this.deps.store.patch(link.sessionId, { queueReason: routed.held });
        return;
      }
      if (routed) {
        await this.deps.store.patch(link.sessionId, { remote: routed.peer, queued: false, queueReason: undefined, restartRequested: undefined, pendingText: null });
        await this.say(link.sessionId, "thought", `${link.identifier} is handled on ${routed.peer}${link.pendingText ? "; your message was passed on" : ""}.`);
        return;
      }
      const admission = await this.deps.starter.admission(link.issueId, this.paseo!, await this.deps.settings.read(), ticket);
      if (!admission.ok) {
        if (link.queueReason !== admission.reason) await this.deps.store.patch(link.sessionId, { queueReason: admission.reason });
        return;
      }
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      if (link.queueReason !== undefined) await this.deps.store.patch(link.sessionId, { queueReason: undefined });
      console.error(`[linear-tickets] ${link.identifier}: checking the queued thread failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    try {
      await this.startFor(link, false, true);
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      if ((await this.deps.store.get(link.sessionId))?.agentId) {
        console.error(`[linear-tickets] ${link.identifier}: queued agent started, reporting it failed: ${error instanceof Error ? error.message : error}`);
        return;
      }
      await this.deps.store.patch(link.sessionId, { queued: false, queueReason: undefined, restartRequested: undefined });
      await this.say(link.sessionId, "error", `Paseo could not start the agent: ${error instanceof Error ? error.message : error}`).catch(() => {});
    }
  }

  // A ticket with open sub-issues is worked on through them instead of by an agent of its own:
  // each open sub-issue nobody else has is assigned to Paseo (its own thread then starts it once
  // its blockers are finished), and the ticket closes when all of them are finished.
  private async startGroup(link: SessionLink, read?: { group: IssueGroup; appId: string }): Promise<boolean> {
    const known = read ?? await this.readGroup(link.issueId);
    if (!isGroup(groupProgress(known.group, await this.owner(), known.appId, await this.ownLabels()))) return false;
    const group = { delegated: known.group.delegateId === known.appId };
    await this.deps.store.put({ ...link, group });
    for (const other of await this.deps.store.all()) {
      if (other.issueId !== link.issueId || !other.group || other.closed || other.sessionId === link.sessionId) continue;
      await this.deps.store.patch(other.sessionId, { closed: true });
      await this.say(other.sessionId, "response", "Continued in the newest Paseo thread on this ticket. Follow and reply there; this thread is closed.").catch(() => {});
    }
    await this.say(link.sessionId, "thought", `${link.identifier} has open sub-issues, so Paseo works on them instead of on ${link.identifier} itself: each one is assigned to Paseo and starts once its blockers are finished. ${link.identifier} closes when they are all finished.`);
    await this.advanceGroup({ ...link, group }, known);
    return true;
  }

  // A labelled ticket with open sub-issues becomes a group too: it is assigned to Paseo, whose
  // thread hands out the sub-issues. True when the ticket is a group; without a usable Paseo app
  // there are no threads, so the ticket starts an agent like any other.
  async handOffGroup(issueId: string): Promise<boolean> {
    if (!await this.deps.linear.appUserId()) return false;
    const known = await this.readGroup(issueId);
    if (!isGroup(groupProgress(known.group, await this.owner(), known.appId, await this.ownLabels()))) return false;
    // Assigning opens the ticket's thread, which starts the group (`created`).
    if (known.group.delegateId !== known.appId) { await this.deps.linear.delegate(issueId, known.appId); return true; }
    if ((await this.deps.store.all()).some((other) => other.issueId === issueId && other.group && !other.closed)) return true;
    const sessionId = await this.deps.api.createSessionOnIssue(issueId);
    await this.startGroup({ sessionId, agentId: null, issueId, identifier: known.group.identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null }, known);
    return true;
  }

  private async readGroup(issueId: string): Promise<{ group: IssueGroup; appId: string }> {
    const appId = await this.deps.linear.appUserId();
    if (!appId) throw new Error("The Paseo Linear app is not usable on this host, so sub-issues cannot be assigned to it.");
    return { group: await this.deps.linear.issueGroup(issueId), appId };
  }

  // Sub-issues the plugin made for the owner (manual tasks, "Needs you" questions): never group members.
  private async ownLabels(): Promise<string[]> {
    const labels = dispatchLabels((await this.deps.settings.read()).dispatch.label);
    return [labels.manual, labels.needsYou];
  }

  async advanceGroups(): Promise<void> {
    for (const link of await this.deps.store.all()) {
      if (!link.group || link.closed) continue;
      try {
        await this.advanceGroup({ ...link, group: link.group });
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        console.error(`[linear-tickets] ${link.identifier}: advancing the group failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Hands out the group's new sub-issues once the parent itself is not blocked, closes the parent
  // when every sub-issue is finished, and posts what each one waits for whenever that changes.
  // One advance per thread at a time: the minute sweep, a reply and the thread's start can overlap,
  // and two would close the parent or post the same status twice. A skipped one is redone next minute.
  private readonly advancing = new Set<string>();
  private async advanceGroup(link: SessionLink & { group: NonNullable<SessionLink["group"]> }, read?: { group: IssueGroup; appId: string }): Promise<void> {
    if (this.advancing.has(link.sessionId)) return;
    this.advancing.add(link.sessionId);
    try {
      await this.stepGroup(link, read);
    } finally {
      this.advancing.delete(link.sessionId);
    }
  }

  private async stepGroup(link: SessionLink & { group: NonNullable<SessionLink["group"]> }, read?: { group: IssueGroup; appId: string }): Promise<void> {
    const { group, appId } = read ?? await this.readGroup(link.issueId);
    const end = async (body: string) => {
      await this.deps.store.patch(link.sessionId, { closed: true });
      await this.say(link.sessionId, "response", body);
    };
    if (["completed", "canceled", "duplicate"].includes(group.statusType)) return end(`${link.identifier} was moved to ${group.status}, so Paseo stopped handing out its sub-issues.`);
    if (link.group.delegated && group.delegateId !== appId) return end(`Paseo was unassigned from ${link.identifier}, so it stopped handing out sub-issues. Agents already working continue.`);
    const progress = groupProgress(group, await this.owner(), appId, await this.ownLabels());
    if (progress.finished) {
      const list = progress.members.map((child) => `- ${child.identifier}: ${child.status}`).join("\n");
      if (progress.outcome === "canceled") await this.deps.linear.cancel(link.issueId, `Every sub-issue was canceled, so ${link.identifier} is canceled too.\n\n${list}`);
      else await this.deps.linear.complete(link.issueId);
      return end(`All sub-issues are finished, so ${link.identifier} is ${progress.outcome === "canceled" ? "canceled" : "done"}.\n\n${list}`);
    }
    let parentBlockers: string[] = [];
    const failures: string[] = [];
    if (progress.handOut.length) {
      const parent = await this.deps.linear.issueState(link.issueId);
      parentBlockers = parent.blockedBy;
      if (!parentBlockers.length) {
        for (const child of progress.handOut) {
          try {
            await this.deps.linear.delegate(child.id, appId);
            child.delegateId = appId;
          } catch (error) {
            if (error instanceof RateLimitedError) throw error;
            failures.push(`Could not assign ${child.identifier} to Paseo: ${error instanceof Error ? error.message : error}`);
          }
        }
        if (progress.handOut.some((child) => child.delegateId === appId)) {
          const moved = await this.deps.linear.moveToStateNamed(link.issueId, CODING_STATE, parent).catch((error: unknown) => {
            if (error instanceof RateLimitedError) throw error;
            return { changed: false, note: error instanceof Error ? error.message : String(error) };
          });
          if (moved.note) console.error(`[linear-tickets] ${link.identifier}: ${moved.note}`);
        }
      }
    }
    const agents = new Map<string, "working" | "queued" | "group">();
    for (const other of await this.deps.store.all()) {
      if (other.closed || agents.get(other.issueId) === "working") continue;
      if (other.group) agents.set(other.issueId, "group");
      else if (other.agentId) agents.set(other.issueId, "working");
      else if (other.queued) agents.set(other.issueId, "queued");
    }
    const status = [groupStatus(link.identifier, progress, appId, agents, parentBlockers), ...failures].join("\n");
    if (status === link.group.status) return;
    await this.deps.store.patch(link.sessionId, { group: { ...link.group, status } });
    await this.say(link.sessionId, "thought", status);
  }

  // Catch-up for missed webhooks: queued threads now admitted, new sessions nobody started, and prompts
  // not yet handled. Each part runs on its own, so one failed Linear request skips only the part it hit.
  async sweep(): Promise<void> {
    if (this.sweeping || !this.paseo) return;
    const budget = this.deps.budget ?? rateBudget;
    const until = budget.pausedUntil("app", "background");
    if (until !== null) {
      this.logSweepPause(new RateLimitedError("app", until, budget.blockedUntil("app") > this.clock() ? "limited" : "reserve"));
      return;
    }
    this.pauseDuringSweep = false;
    this.sweeping = true;
    // One listing for this sweep's parts, and a fresh one next minute.
    this.sessionList = null;
    try {
      await this.sweepPart("limit resumes", () => this.resumeLimits());
      await this.sweepPart("queued threads", () => this.startQueued());
      await this.sweepPart("groups", () => this.advanceGroups());
      await this.sweepPart("superseded threads", () => this.closeSuperseded());
      await this.sweepPart("reviews", () => this.settleReviews());
      // Threads opened before the link existed (or linked to a newer agent) get "Open in Paseo".
      await this.sweepPart("Open in Paseo links", async () => {
        for (const link of await this.deps.store.all()) if (link.agentId && !link.closed && link.paseoLinked !== link.agentId) await this.linkToPaseo(link.sessionId, link.agentId);
      });
      await this.sweepPart("missed replies", () => this.catchUp());
    } finally {
      this.sweeping = false;
      if (!this.pauseDuringSweep) this.pausedSweep = null;
    }
  }

  private async sweepPart(part: string, run: () => Promise<void>): Promise<void> {
    try {
      await withPriority("background", `session-sweep.${part}`, run);
    } catch (error) {
      if (error instanceof RateLimitedError) { this.logSweepPause(error, part); return; }
      console.error(`[linear-tickets] agent session sweep (${part}) failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private logSweepPause(error: RateLimitedError, part?: string): void {
    const pause = `${error.pool}:${error.reason}`;
    if (this.pausedSweep !== pause) console.error(`[linear-tickets] agent session sweep${part ? ` (${part})` : ""} paused: ${error.message}`);
    this.pausedSweep = pause;
    this.pauseDuringSweep = true;
  }

  // New sessions nobody started and prompts not yet handled. A thread whose read fails is tried
  // again next minute; the threads after it go ahead. A session Linear webhooks for is skipped
  // until the fallback cadence is due (README, "Rate limits"); with no webhook it is read here
  // every minute, as before.
  private async catchUp(): Promise<void> {
    const sessions = await this.listSessions();
    const failures: string[] = [];
    for (const session of sessions) {
      try {
        const link = await this.deps.store.get(session.id);
        // Still waiting: `startQueued` owns it.
        if (link?.queued && !link.agentId) continue;
        if (!link) {
          // A webhook missed while this host was down: Linear marks a thread nobody answered `stale`
          // after about a minute, so a stale thread without a link is started like a pending one,
          // unless the ticket has a newer thread (assigned again): that one starts the agent.
          const stale = session.status === "stale" && !sessions.some((other) => other.id !== session.id && other.issueId === session.issueId && other.createdAt > session.createdAt);
          if ((session.status === "pending" || stale) && Date.now() - Date.parse(session.createdAt) < ADOPT_WINDOW_MS && session.issueId) {
            await this.handle({ type: "AgentSessionEvent", action: "created", agentSession: { id: session.id, creatorId: session.creatorId, issueId: session.issueId, issue: { id: session.issueId, identifier: session.identifier } } });
          }
          continue;
        }
        if (!["pending", "active", "awaitingInput"].includes(session.status)) continue;
        const now = this.clock();
        const hookedAt = this.webhookedAt.get(session.id);
        const readAt = this.webhookReadAt.get(session.id);
        if (hookedAt !== undefined && now - hookedAt < WEBHOOK_FALLBACK_MS && readAt !== undefined && now - readAt < WEBHOOK_FALLBACK_MS) {
          this.reads.skipped += 1;
          continue;
        }
        await this.readSession(session.id, "sweep");
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) throw new Error(`${failures.length} of ${sessions.length} threads skipped until the next sweep: ${failures[0]}`);
  }

  // Linear's open sessions, once per sweep: closing superseded threads and the missed-reply
  // catch-up both need it, and Linear counts every call (README, "Rate limits"). A failed call is
  // dropped rather than shared, so the other part retries it instead of inheriting the failure.
  private listSessions(): Promise<OpenSession[]> {
    this.sessionList ??= this.deps.api.openSessions().catch((error: unknown) => {
      this.sessionList = null;
      throw error;
    });
    return this.sessionList;
  }

  // One session's activities, and the prompts among them no webhook delivered. A webhook calls
  // this at once and the sweep at the fallback cadence. The link is read here because a webhook
  // can arrive before `created` stored it; a session with no link has nothing to reach.
  private async readSession(sessionId: string, source: "webhook" | "sweep"): Promise<void> {
    if (this.readingSession.has(sessionId)) return;
    this.readingSession.add(sessionId);
    const previousRead = this.webhookReadAt.get(sessionId);
    try {
      const link = await this.deps.store.get(sessionId);
      if (!link) return;
      this.webhookReadAt.set(sessionId, this.clock());
      if (source === "webhook") this.reads.webhook += 1;
      else this.reads.sweep += 1;
      const owner = await this.owner();
      for (const activity of await this.deps.api.activities(sessionId)) {
        if (activity.type !== "prompt" || activity.userId !== owner || activity.createdAt < link.createdAt || link.handled.includes(activity.id)) continue;
        await this.handle({ type: "AgentSessionEvent", action: "prompted", agentSession: { id: sessionId }, agentActivity: { id: activity.id, content: { body: activity.body }, signal: activity.signal, userId: activity.userId } });
      }
    } catch (error) {
      // Marked unread again, so the next sweep retries it the way a failed sweep read did.
      if (previousRead === undefined) this.webhookReadAt.delete(sessionId);
      else this.webhookReadAt.set(sessionId, previousRead);
      throw error;
    } finally {
      this.readingSession.delete(sessionId);
    }
  }

  // ---- outbound -------------------------------------------------------------------------

  async sessionFor(agentId: string): Promise<SessionLink | null> {
    return this.deps.store.forAgent(agentId);
  }

  // Sends an idle agent a new message; a stopped one is loaded only after its ticket's terminal
  // OMP roots are confirmed absent. A live or unobservable orphan, or a held start gate, is `busy`.
  // Nothing is sent while the agent waits for the owner's answer or approval (`waiting`: the
  // message would drop the question) or is in a turn (`busy`: Paseo would interrupt it). `gone`:
  // the agent no longer exists or is archived; `unavailable`: Paseo is not connected, retry later.
  // `onDispatch` runs once the agent is known to take it, right before the message is sent.
  // A crashed agent (see crashedProcess) takes no message: `crashed`, unless `recovery` asks to
  // reload it and send it the resume (see recover).
  async prompt(agentId: string, text: string, onDispatch?: () => Promise<void>, recovery?: Recovery): Promise<PromptOutcome> {
    if (!this.paseo) return "unavailable";
    const found = await this.agent(agentId);
    if (!found) return "gone";
    if (found.agent.pendingPermissions?.length) return "waiting";
    if (busy(found.agent)) return "busy";
    const issueId = recovery?.issueId ?? found.agent.labels?.["linear.issueId"] ?? (await this.deps.store.forAgent(agentId))?.issueId;
    if (issueId) {
      if (await this.deps.deletions?.blocked(issueId)) return "gone";
      return this.exclusive(issueId, async () => {
        if (await this.deps.deletions?.blocked(issueId)) return "gone";
        const gate = this.deps.launcher.gate(issueId);
        if (!gate) return "busy";
        try {
          const current = await this.agent(agentId);
          if (!current) return "gone";
          if (current.agent.pendingPermissions?.length) return "waiting";
          if (busy(current.agent)) return "busy";
          if (await this.processWait(issueId, [{ ...current.agent, id: agentId }])) return "busy";
          if (crashedProcess(current.agent)) return recovery ? await this.recover(agentId, text, onDispatch, recovery) : "crashed";
          await onDispatch?.();
          await current.handle.send(text);
          return "sent";
        } finally {
          gate.release();
        }
      });
    }
    // Without a ticket identity a terminal OMP worker cannot safely be lazily resurrected.
    if (found.agent.provider === "omp" && (found.agent.status === "closed" || crashedProcess(found.agent))) return "busy";
    if (crashedProcess(found.agent)) return "crashed";
    await onDispatch?.();
    await found.handle.send(text);
    return "sent";
  }

  // The crashed process of an existing, unarchived agent (its last error), else null.
  async crashed(agentId: string): Promise<string | null> {
    if (!this.paseo) return null;
    const found = await this.agent(agentId);
    return found ? crashedProcess(found.agent) : null;
  }

  // Reloads a crashed agent (as `paseo agent reload` does) and sends it the resume, in its ticket's
  // turn: an earlier recovery or a successor start for the ticket has finished, so the agent is read
  // and judged again first. A live, uncrashed agent of the same ticket is taking over (`busy`).
  // `before` claims the attempt right before the reload; nothing after it throws: the reload
  // throwing or leaving the agent in error is `crashed`, a resume that does not go out `reloaded`.
  private async recover(agentId: string, text: string, onDispatch: (() => Promise<void>) | undefined, recovery: Recovery): Promise<PromptOutcome> {
    const found = await this.agent(agentId);
    if (!found) return "gone";
    if (found.agent.pendingPermissions?.length) return "waiting";
    if (busy(found.agent)) return "busy";
    const error = crashedProcess(found.agent);
    if (!error) {
      await onDispatch?.();
      await found.handle.send(text);
      return "sent";
    }
    const agents = await issueAgents(this.paseo!, recovery.issueId);
    if (agents.some((agent) => agent.id !== agentId && !agent.archivedAt && !agent.labels?.["paseo.parent-agent-id"] && agent.status !== "closed" && !crashedProcess(agent))) return "busy";
    const reload = await this.deps.reloader?.();
    if (!reload) return "unavailable";
    const resume = crashResume(error, text);
    await recovery.before(resume, error);
    try {
      await reload(agentId);
    } catch (failure) {
      console.error(`[linear-tickets] reloading crashed agent ${agentId} failed: ${failure instanceof Error ? failure.message : failure}`);
      return "crashed";
    }
    const reloaded = await this.agent(agentId).catch((failure: unknown) => {
      console.error(`[linear-tickets] reading restarted agent ${agentId} failed: ${failure instanceof Error ? failure.message : failure}`);
      return undefined;
    });
    if (reloaded === undefined) return "reloaded";
    if (!reloaded) return "gone";
    if (reloaded.agent.status === "error") return "crashed";
    if (busy(reloaded.agent)) return "reloaded";
    try {
      await reloaded.handle.send(unverifiedResume(resume, recovery.unverified));
    } catch (failure) {
      console.error(`[linear-tickets] the resume for restarted agent ${agentId} failed: ${failure instanceof Error ? failure.message : failure}`);
      return "reloaded";
    }
    return "restarted";
  }

  // The agent's current snapshot; null when it no longer exists or is archived.
  private async agent(agentId: string): Promise<{ handle: PaseoAgentHandle; agent: PaseoAgent } | null> {
    const handle = this.paseo!.agents.ref(agentId);
    const refreshed = await handle.refresh().catch((error: unknown) => {
      if (error instanceof Error && /not found/i.test(error.message)) return null;
      throw error;
    });
    return refreshed && !refreshed.agent.archivedAt ? { handle, agent: refreshed.agent } : null;
  }

  // One recovery or successor start per ticket at a time, in call order.
  private readonly turns = new Map<string, Promise<unknown>>();

  private exclusive<T>(issueId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.turns.get(issueId) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    this.turns.set(issueId, settled);
    void settled.then(() => { if (this.turns.get(issueId) === settled) this.turns.delete(issueId); });
    return run;
  }

  // Called only with the Launcher gate held; successor/recovery paths also hold the ticket's turn.
  // Unobservable is a pending wait, not exit; no dispatch claim, send, reload or launch precedes it.
  private async processWait(issueId: string, extra: ProcessAgent[] = [], options: { subagents?: boolean } = {}): Promise<string | null> {
    try {
      const state = await (this.deps.processLiveness ?? ticketProcessLiveness)(this.paseo!, issueId, extra, undefined, options);
      if (state === "absent") return null;
      return state === "alive" ? "an OMP worker for this ticket is still alive" : "the OMP workers for this ticket could not be inspected";
    } catch {
      return "the OMP workers for this ticket could not be inspected";
    }
  }

  // Runs `work` only while no agent of the ticket works, in the ticket's turn with its start gate
  // held: every agent of the ticket (successors and subagents too) is read, and `work` runs when
  // each is idle, closed, crashed or gone and no OMP worker process of the ticket lives (a closed
  // or archived subagent's included) or is unobservable. Otherwise it does not run: `busy` (an
  // agent is in a turn, a launch is under way, or a worker process lives), `waiting` (an agent
  // waits for the owner's answer), `elsewhere`
  // (the peer host owns the ticket's work), `unavailable` (Paseo is not connected, the ticket is
  // being deleted, or its agents or owner cannot be read). It reads only: nothing is forwarded or
  // started. A turn the owner starts directly does not take the gate, so it is not serialized.
  async whileIdle<T>(issueId: string, work: () => Promise<T>): Promise<IdleRun<T>> {
    if (!this.paseo) return { outcome: "unavailable" };
    return this.exclusive(issueId, async (): Promise<IdleRun<T>> => {
      const unreadable = (error: unknown): IdleRun<T> => {
        console.error(`[linear-tickets] reading whether an agent of ${issueId} works failed: ${error instanceof Error ? error.message : error}`);
        return { outcome: "unavailable" };
      };
      try {
        if (await this.deps.deletions?.blocked(issueId)) return { outcome: "unavailable" };
        const owner = this.deps.owner ? await this.deps.owner(issueId) : "here";
        if (owner !== "here") return { outcome: owner === "elsewhere" ? "elsewhere" : "unavailable" };
      } catch (error) {
        return unreadable(error);
      }
      const gate = this.deps.launcher.gate(issueId);
      if (!gate) return { outcome: "busy" };
      try {
        let agents: PaseoAgent[];
        try {
          agents = await issueAgents(this.paseo!, issueId);
        } catch (error) {
          return unreadable(error);
        }
        if (agents.some((agent) => agent.pendingPermissions?.length)) return { outcome: "waiting" };
        if (agents.some(busy) || await this.processWait(issueId, agents, { subagents: true })) return { outcome: "busy" };
        return { outcome: "ran", value: await work() };
      } finally {
        gate.release();
      }
    });
  }

  // `id`: a reserved activity id (a decision's step), so a retry finds it with `said` instead of
  // posting it twice.
  async say(sessionId: string, type: "thought" | "response" | "error", body: string, ephemeral = false, id?: string): Promise<void> {
    await this.deps.api.activity(sessionId, { type, body }, { ephemeral, ...(id ? { id } : {}) });
  }

  async said(id: string): Promise<boolean> {
    return Boolean(await this.deps.api.activityById(id));
  }

  async action(sessionId: string, action: string, parameter: string, result?: string): Promise<void> {
    await this.deps.api.activity(sessionId, { type: "action", action, parameter, ...(result ? { result } : {}) });
  }

  // First part of a pending question (later parts follow each answer).
  async askQuestion(sessionId: string, request: AgentPermissionRequest): Promise<void> {
    const progress = (await this.deps.store.get(sessionId))?.questions;
    if (progress && progress.requestId !== request.id) return;
    const prompt = questionPrompt(progress?.request ?? request, progress?.index ?? 0);
    await this.ask(sessionId, prompt.body, prompt.options);
  }

  // Called when a turn starts: a provider restarting on its own right after a Stop is stopped again.
  async holdIfStopped(agentId: string): Promise<boolean> {
    if (this.deps.deletions) {
      const deletion = await this.deps.deletions.forAgent(agentId);
      const link = await this.deps.store.forAgent(agentId);
      const issueId = link?.issueId ?? (await this.paseo?.agents.ref(agentId).refresh())?.agent.labels?.["linear.issueId"];
      const issueDeletion = deletion ?? (issueId ? await this.deps.deletions.get(issueId) : null);
      if (issueDeletion?.phase === "deleted") {
        await (this.deps.stop ?? stopAgentTurn)(agentId);
        return true;
      }
    }
    const since = this.held.get(agentId);
    if (since === undefined || Date.now() - since > HOLD_MS) { this.held.delete(agentId); return false; }
    await (this.deps.stop ?? stopAgentTurn)(agentId).catch(() => {});
    const link = await this.deps.store.forAgent(agentId);
    if (link) await this.say(link.sessionId, "thought", "Kept stopped — reply here to continue.").catch(() => {});
    return true;
  }

  // Posts the agent's completed commands and edits while the turn runs, merged at most every 15 s,
  // accounted as `session-live-feed` (the timer runs outside any caller context).
  async follow(agentId: string): Promise<void> {
    if (!this.paseo || this.live.has(agentId)) return;
    const link = await this.deps.store.forAgent(agentId);
    if (!link) return;
    const state = { sessionId: link.sessionId, stop: () => {}, pending: [] as string[], timer: null as NodeJS.Timeout | null, posted: 0, asking: false };
    this.live.set(agentId, state);
    const unsubscribe = this.paseo.agents.ref(agentId).timeline.subscribe((event) => {
      if (event.event.type !== "timeline") return;
      const description = describeTool(event.event.item);
      if (!description) return;
      state.pending.push(description);
      state.timer ??= setTimeout(() => { void asCaller("session-live-feed", () => this.flush(agentId)); }, LIVE_FLUSH_MS);
    });
    state.stop = () => unsubscribe();
  }

  private async flush(agentId: string): Promise<void> {
    const state = this.live.get(agentId);
    if (!state) return;
    state.timer = null;
    if (state.asking) return;
    const items = state.pending.splice(0);
    if (!items.length) return;
    state.posted += items.length;
    const [first] = items;
    const [action, ...rest] = first.split(" ");
    await this.action(state.sessionId, items.length === 1 ? action : `${items.length} steps`, items.length === 1 ? rest.join(" ") : items.join("\n").slice(0, 2_000)).catch(() => {});
  }

  // Ends the live feed at turn end; true when it posted anything, so the turn summary skips its action log.
  async unfollow(agentId: string): Promise<boolean> {
    const state = this.live.get(agentId);
    if (!state) return false;
    if (state.timer) clearTimeout(state.timer);
    await this.flush(agentId);
    state.stop();
    this.live.delete(agentId);
    return state.posted > 0;
  }

  async ask(sessionId: string, body: string, options: SelectOption[]): Promise<void> {
    for (const [agentId, state] of this.live) {
      if (state.sessionId !== sessionId) continue;
      if (state.timer) clearTimeout(state.timer);
      await this.flush(agentId);
      state.asking = true;
    }
    await this.deps.api.activity(sessionId, { type: "elicitation", body }, options.length ? { signal: "select", options } : {});
  }

  async plan(sessionId: string, steps: SessionPlanStep[]): Promise<void> {
    await this.deps.api.updateSession(sessionId, { plan: steps });
  }

  async link(sessionId: string, label: string, url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) return;
    await this.deps.api.updateSession(sessionId, { addedExternalUrls: [{ label, url }] });
  }

  // The review a plain reply decides; its tailnet link is shown in the panel while it is open.
  // `reviewId`: the decision journal's generation of it (decision-journal.ts).
  async expectReview(sessionId: string, localUrl: string | null, plan = "", remoteUrl: string | null = null, reviewId?: string): Promise<void> {
    if (!localUrl) { await this.clearReview(sessionId); return; }
    await this.clearReview(sessionId);
    await this.deps.store.patch(sessionId, { review: { localUrl, openedAt: new Date().toISOString(), ...(remoteUrl ? { remoteUrl } : {}), ...(plan.trim() ? { planHash: planHash(plan) } : {}), ...(reviewId ? { reviewId } : {}) } });
    if (remoteUrl) await this.link(sessionId, "Plan review", remoteUrl);
  }

  async clearReview(sessionId: string): Promise<void> {
    const review = (await this.deps.store.get(sessionId))?.review;
    if (!review) return;
    await this.deps.store.patch(sessionId, { review: null });
    if (review.remoteUrl) await this.deps.api.updateSession(sessionId, { removedExternalUrls: [review.remoteUrl] }).catch(() => {});
  }

  // A review whose server is gone was decided on Plannotator's page (or closed without a
  // decision, e.g. by a restart). Its saved decision is journaled for the stored review before the
  // session lets go of it; a failed journal write keeps the review for the next sweep.
  async settleReviews(): Promise<void> {
    const { reviewOutcome, recordOutcome } = this.deps;
    if (!reviewOutcome || !recordOutcome) return;
    for (const link of await this.deps.store.all()) {
      // A parked plan's review moves to the central host, which may restart: it stays bound.
      if (!link.review || link.closed || !link.agentId || link.offer === "parked") continue;
      const outcome = await reviewOutcome(link.review).catch(() => "open" as const);
      if (outcome === "open") continue;
      if (outcome) await recordOutcome(link.agentId, outcome, link.review);
      await this.clearReview(link.sessionId);
      if (!outcome) await this.say(link.sessionId, "thought", "The plan review closed without a decision (for example after a restart). Reply here if the agent should submit the plan again.").catch(() => {});
    }
  }

  // Rate/usage limits keep a durable schedule and a separate rolling-day budget.
  async scheduleLimitResume(sessionId: string, errorText: string, model: string | null): Promise<boolean> {
    const error = limitError(errorText);
    const store = this.deps.limitResumes;
    const known = await this.deps.store.get(sessionId);
    if (!error || !store || !known || !this.paseo) return false;
    return this.exclusive(known.issueId, async () => {
      const link = await this.deps.store.get(sessionId);
      if (!link?.agentId || link.closed || await this.deps.deletions?.blocked(link.issueId)) return false;
      try {
        await store.read(); // Never schedule by resetting an unreadable budget.
        if ((await this.deps.watchdog?.read())?.holds[link.issueId]) return false;
        if (!(await this.deps.settings.read()).writeback.autoResume) return false;
        const failedAt = new Date(this.clock()).toISOString();
        const selected = normalizeModel(/\bmodel=((?:omp\/)?[^\s,)]+)/i.exec(errorText)?.[1] ?? model ?? `${error.provider ?? "unknown"}/unknown`);
        const provider = error.provider ?? selected.split("/")[0];
        const models = candidates(await this.deps.usage?.chains() ?? {}, selected);
        const reports = await this.deps.usage?.read() ?? null;
        const now = this.clock(); // A report refreshed while awaiting the broker is still fresh.
        const reading = reports ? availability(reports, models, now) : null;
        const recovery = reading?.recovery;
        const timing = limitSchedule(recovery, error.retryAfterMs, now, () => this.limitJitter());
        const basis = timing.basis;
        let resumeAt = timing.resumeAt;
        const scheduled = await store.update((file) => {
          const recent = claims(file, link.issueId, now);
          if (recent.length) resumeAt = Math.max(resumeAt, Math.max(...recent) + LIMIT_SPACING);
          finishPending(file, link.issueId, "superseded");
          (file.incidents[link.issueId] ??= []).push({ failedAgentId: link.agentId!, failedAt, provider, exhausted: recovery?.exhausted ?? false, basis, resolution: recent.length >= 4 ? "bounded" : "pending" });
          if (reading) updateEpisode(file, provider, reading.episode, now);
          if (recent.length >= 4) return false;
          file.pending[link.issueId] = { identifier: link.identifier, sessionId, agentId: link.agentId!, provider, model: selected, failedAt, resumeAt: new Date(resumeAt).toISOString(), basis };
          return true;
        });
        if (!scheduled) return false;
        const text = basis === "room" && resumeAt <= now
          ? `Usage limit on ${provider}: another account has room, so Paseo starts a new agent now.`
          : reading?.episode.state === "exhausted"
            ? `Usage limit on ${provider}: every account is used up. Paseo starts a new agent at ${limitTime(resumeAt, now)}, when the first one has room again.`
            : `Usage limit on ${provider}: Paseo starts a new agent at ${limitTime(resumeAt, now)}.`;
        await this.say(sessionId, "thought", text).catch((error: unknown) => console.error(`[linear-tickets] reporting limit resume failed: ${error instanceof Error ? error.message : error}`));
        return true;
      } catch (error) {
        console.error(`[linear-tickets] scheduling limit resume failed: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    });
  }

  private limitJitter(): number {
    return this.deps.jitter?.() ?? 60_000 + Math.floor(Math.random() * 240_001);
  }

  async resumeLimits(): Promise<void> {
    const store = this.deps.limitResumes;
    if (!store || !this.paseo) return;
    const file = await store.read();
    for (const [issueId, entry] of Object.entries(file.pending)) {
      if (Date.parse(entry.resumeAt) > this.clock()) continue;
      await this.exclusive(issueId, () => this.resumeLimit(issueId, entry)).catch((error: unknown) => console.error(`[linear-tickets] ${entry.identifier}: due limit resume failed: ${error instanceof Error ? error.message : error}`));
    }
    // Confirm recovery even when nothing is due, so a later exhaustion is a new episode.
    const episodes = (await store.read()).episodes;
    if (Object.keys(episodes).length) {
      const reports = await this.deps.usage?.read() ?? null;
      if (reports) await store.update((current) => {
        for (const provider of Object.keys(current.episodes)) updateEpisode(current, provider, availability(reports, [`${provider}/unknown`], this.clock()).episode, this.clock());
      });
    }
    await this.reportLimitEpisodes();
  }

  private async resumeLimit(issueId: string, expected: LimitPending): Promise<void> {
    const store = this.deps.limitResumes!;
    const entry = (await store.read()).pending[issueId];
    if (!entry || entry.agentId !== expected.agentId || entry.failedAt !== expected.failedAt || Date.parse(entry.resumeAt) > this.clock()) return;
    if (!(await this.deps.settings.read()).writeback.autoResume) {
      await store.update((file) => finishPending(file, issueId, "switched-off"));
      await this.offerResume(entry.sessionId);
      return;
    }
    if ((await this.deps.watchdog?.read())?.holds[issueId]) {
      await store.update((file) => finishPending(file, issueId, "cancelled"));
      return;
    }
    const link = await this.deps.store.get(entry.sessionId);
    if (!link || link.closed || link.agentId !== entry.agentId || await this.deps.deletions?.blocked(issueId)
      || (await this.agent(entry.agentId))?.agent.status !== "error" || await this.liveSuccessorFor(issueId, [entry.agentId])) {
      await store.update((file) => finishPending(file, issueId, "superseded"));
      return;
    }
    const gate = this.deps.launcher.gate(issueId);
    if (!gate) return;
    try {
      if (await this.processWait(issueId)) return;
      if (entry.basis === "reset" || entry.basis === "default") {
        const reports = await this.deps.usage?.read() ?? null;
        if (reports) {
          const reading = availability(reports, candidates(await this.deps.usage?.chains() ?? {}, entry.model), this.clock());
          const postponed = await store.update((file) => {
            updateEpisode(file, entry.provider, reading.episode, this.clock());
            if (!reading.recovery.roomNow && reading.recovery.earliestReset !== null && reading.recovery.earliestReset > this.clock()) {
              file.pending[issueId].resumeAt = new Date(reading.recovery.earliestReset + this.limitJitter()).toISOString();
              return true;
            }
            return false;
          });
          if (postponed) return;
        }
      }
      const result = await store.update((file) => {
        const current = file.pending[issueId];
        if (!current || current.agentId !== entry.agentId || current.failedAt !== entry.failedAt) return "gone";
        if (claims(file, issueId, this.clock()).length >= 4) { finishPending(file, issueId, "bounded"); return "bounded"; }
        const incident = incidentFor(file, issueId, current);
        incident.claimedAt = new Date(this.clock()).toISOString();
        incident.resolution = "claimed";
        delete file.pending[issueId];
        return "claimed";
      });
      if (result === "bounded") { await this.offerResume(entry.sessionId); return; }
      if (result !== "claimed") return;
      let failure: unknown;
      try { await this.startNow(link, false); } catch (error) { failure = error; }
      const after = await this.deps.store.get(entry.sessionId);
      const outcome = after?.agentId && after.agentId !== entry.agentId ? "started" : after?.remote ? "forwarded" : after?.queued ? "pending" : "failed";
      await store.update((file) => {
        const incident = incidentFor(file, issueId, entry);
        incident.resolution = outcome;
        if (outcome === "started") incident.startedAt = new Date(this.clock()).toISOString();
        if (outcome === "pending") {
          delete incident.claimedAt;
          file.pending[issueId] = { ...entry, resumeAt: new Date(this.clock() + 5 * 60_000).toISOString() };
        }
      });
      if (outcome === "pending") await this.deps.store.patch(entry.sessionId, { queued: false, queueReason: undefined });
      if (failure) console.error(`[linear-tickets] ${entry.identifier}: limit resume ${outcome}: ${failure instanceof Error ? failure.message : failure}`);
      if (outcome === "failed") await this.offerResume(entry.sessionId);
    } finally { gate.release(); }
  }

  // Serialized across tickets: one durable mention per provider episode, including lost replies.
  private limitReports: Promise<unknown> = Promise.resolve();
  private reportLimitEpisodes(): Promise<void> {
    const run = this.limitReports.then(async () => {
      const store = this.deps.limitResumes!;
      await store.update((file) => {
        for (const [provider, episode] of Object.entries(file.episodes)) {
          if (episode.mention || Math.max(Date.parse(episode.until ?? episode.since), Date.parse(episode.lastConfirmedAt)) - Date.parse(episode.since) <= 6 * 60 * 60_000) continue;
          const waiting = Object.entries(file.pending).find(([, entry]) => entry.provider === provider);
          if (waiting) episode.mention = { issueId: waiting[0], key: `limit-resume:${provider}:${episode.since}`, attempted: false, posted: false };
        }
      });
      for (const [provider, episode] of Object.entries((await store.read()).episodes)) {
        const mention = episode.mention;
        if (!mention || mention.posted) continue;
        try {
          const mark = `\`${mention.key}\``;
          if (mention.attempted && await this.deps.linear.hasComment(mention.issueId, mark)) {
            await store.update((file) => { const current = file.episodes[provider]?.mention; if (current?.key === mention.key) current.posted = true; });
            continue;
          }
          const owner = await this.deps.linear.userUrl(await this.owner());
          const attempted = await store.update((file) => {
            const current = file.episodes[provider];
            if (!current?.mention || current.mention.key !== mention.key) return null;
            current.mention.attempted = true;
            return { until: current.until };
          });
          if (!attempted) continue;
          const until = attempted.until ? `until ${limitTime(Date.parse(attempted.until), this.clock(), true)}` : "with no known reset time";
          await this.deps.linear.comment(mention.issueId, `${owner} All ${provider} accounts are used up ${until}. The agent on this ticket continues then; other tickets stopped by the same limit wait for the same time without another mention.\n\n${mark}`);
          await store.update((file) => { const current = file.episodes[provider]?.mention; if (current?.key === mention.key) current.posted = true; });
        } catch (error) { console.error(`[linear-tickets] reporting ${provider} usage exhaustion failed: ${error instanceof Error ? error.message : error}`); }
      }
    });
    this.limitReports = run.catch(() => undefined);
    return run;
  }

  // Automatic retry after a failure, at most once an hour per ticket. In the ticket's turn and under
  // its start gate: a start that ran first (a successor the pull request watch started) leaves a
  // live agent, which needs neither a retry nor a Resume offer (true). Another start still under
  // way may end without an agent, so the owner keeps the offer (false) and the hour is not used up.
  private readonly lastAutoResume = new Map<string, number>();

  async resumeNow(sessionId: string): Promise<boolean> {
    const known = await this.deps.store.get(sessionId);
    if (!known || !this.paseo) return false;
    return this.exclusive(known.issueId, async () => {
      const link = await this.deps.store.get(sessionId) ?? known;
      if (await this.deps.deletions?.blocked(link.issueId)) return false;
      const last = this.lastAutoResume.get(link.issueId) ?? 0;
      if (Date.now() - last < 60 * 60 * 1000) return false;
      const gate = this.deps.launcher.gate(link.issueId);
      if (!gate) return false;
      try {
        if (await this.processWait(link.issueId)) return false;
        if (await this.liveSuccessorFor(link.issueId, link.agentId ? [link.agentId] : [])) return true;
        this.lastAutoResume.set(link.issueId, Date.now());
        await this.startNow(link, false);
        return true;
      } finally {
        gate.release();
      }
    });
  }

  // A stalled ticket without a live agent (README, "Restarting a failed start") and the label
  // repair's replacements (label-repair.ts): a new agent and a new thread, as for a label launch,
  // admitted like any start. The earlier thread cannot be reused: one whose launch failed is in
  // error in Linear, and Linear opens no new thread when the ticket is assigned to Paseo again.
  // Its stopped agents are archived once the new one runs, so a later reply or mention never
  // reaches them, and its earlier threads are closed as superseded.
  // Runs in the ticket's turn and under its start gate, like any automatic start: a live agent that
  // came up meanwhile (a successor start before it) is no ticket to restart.
  // `eligible` runs last before the start, after admission (which may wait), and a reason it
  // returns defers the start. Only a failed `starter.start` is `failed`; what follows a start
  // (thread, archive, superseded threads) is best effort and never turns a started agent into a
  // failure. `marked`: the running label was written.
  restartFor(issueId: string, identifier: string, options: RestartOptions = {}): Promise<RestartResult> {
    return this.exclusive(issueId, () => this.restartNow(issueId, identifier, options));
  }

  private async restartNow(issueId: string, identifier: string, options: RestartOptions): Promise<RestartResult> {
    if (await this.deps.deletions?.blocked(issueId)) return { kind: "skipped" };
    if (!this.paseo) return { kind: "deferred", reason: "Paseo is not connected yet." };
    const paseo = this.paseo;
    const gate = this.deps.launcher.gate(issueId);
    if (!gate) return { kind: "deferred", reason: "A launch for this ticket is under way." };
    const later = (step: string, work: () => Promise<unknown>) => work().catch((error: unknown) => {
      console.error(`[linear-tickets] ${identifier}: ${step} failed: ${error instanceof Error ? error.message : error}`);
    });
    try {
      let settings: PluginSettings;
      let stopped: Set<string>;
      // Everything up to the start only reads: a failure there started nothing (deferred).
      try {
        const routed = await this.deps.route?.take({ kind: "session", issueId, identifier });
        if (routed && "held" in routed) return { kind: "deferred", reason: `Nothing was restarted: ${routed.held}. The project's next read tries again.` };
        if (routed) {
          console.log(`[linear-tickets] ${identifier}: the restart is handed to ${routed.peer}`);
          return { kind: "forwarded", peer: routed.peer };
        }
        const wait = await this.processWait(issueId);
        if (wait) return { kind: "deferred", reason: wait };
        if (await this.liveSuccessorFor(issueId)) return { kind: "live" };
        settings = await this.deps.settings.read();
        const admission = await this.deps.starter.admission(issueId, paseo, settings);
        if (!admission.ok) return { kind: "deferred", reason: admission.reason };
        const refused = await options.eligible?.();
        if (refused) return { kind: "deferred", reason: refused };
        stopped = new Set((await this.deps.store.all()).filter((link) => link.issueId === issueId && link.agentId).map((link) => link.agentId!));
      } catch (error) {
        return { kind: "deferred", reason: error instanceof Error ? error.message : String(error) };
      }
      const running = dispatchLabels(settings.dispatch.label).running;
      const marked = await this.deps.linear.addLabel(issueId, running).then(() => true, () => false);
      let agentId: string;
      try {
        agentId = (await this.deps.starter.start(issueId, paseo, settings, { retryHint: options.retryHint ?? "the project's next read starts it again" })).agentId;
      } catch (error) {
        await this.deps.linear.removeLabel(issueId, running).catch(() => {});
        return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
      }
      await later("opening the new agent's thread", () => this.openFor(issueId, identifier, agentId));
      for (const old of stopped) if (old !== agentId) await later(`archiving stopped agent ${old.slice(0, 8)}`, () => paseo.agents.ref(old).archive());
      await later("closing superseded threads", () => this.closeSuperseded());
      return { kind: "started", agentId, marked };
    } finally {
      gate.release();
    }
  }

  // The newest live agent of the ticket (starting, idle or running, see LIVE_AGENT; not a subagent,
  // not one of `exclude`), from every page of its agents. A closed, errored or crashed one is not,
  // nor is a ghost (idle or running without a process, see ghostAgents): a restart replaces it.
  async liveSuccessorFor(issueId: string, exclude: string[] = []): Promise<{ id: string; title: string | null; cwd: string } | null> {
    const candidates = (await issueAgents(this.paseo!, issueId))
      .filter((agent) => !agent.labels?.["paseo.parent-agent-id"] && !exclude.includes(agent.id) && LIVE_AGENT[agent.status]);
    const ghosts = await ghostAgents(candidates, this.clock(), this.deps.processInspector);
    const live = candidates.filter((agent) => !ghosts.has(agent.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return live ? { id: live.id, title: live.title ?? null, cwd: live.cwd } : null;
  }

  // A message the pull request watch has for a ticket whose agent is gone (README, "Stalled pull
  // requests"): a successor on the recorded branch and worktree, with `lead` as the last part of
  // its first prompt. In the ticket's turn and under its start gate, in this order: a closed ticket
  // has none (`impossible`); another start under way is waited for (`wait`); a live agent of the
  // ticket takes over the record and the message (`live`, before the branch is looked at); without
  // a recorded branch nothing can continue (`impossible`); without admission (blockers, the agent
  // limit, memory, away) it waits. Then `onDispatch` claims the message, right before the start:
  // a failed start is `impossible`, and a claimed message never starts a second successor. What
  // follows the start (thread, archive, record) is best effort and never undoes it.
  succeed(issueId: string, identifier: string, predecessorId: string, lead: string, onDispatch: () => Promise<void>): Promise<Succession> {
    return this.exclusive(issueId, () => this.succeedNow({ id: issueId, identifier }, predecessorId, lead, onDispatch));
  }

  private async succeedNow(issue: { id: string; identifier: string }, predecessorId: string, lead: string, onDispatch: () => Promise<void>): Promise<Succession> {
    if (await this.deps.deletions?.blocked(issue.id)) return { kind: "impossible", reason: "the ticket was deleted or is paused for deletion" };
    if (!this.paseo) return { kind: "wait", reason: "Paseo is not connected yet" };
    const paseo = this.paseo;
    const state = await this.deps.linear.issueState(issue.id);
    if (["completed", "canceled", "duplicate"].includes(state.statusType.trim().toLowerCase())) return { kind: "impossible", reason: `${issue.identifier} is ${state.status}` };
    const gate = this.deps.launcher.gate(issue.id);
    if (!gate) return { kind: "wait", reason: "a launch for this ticket is under way" };
    const later = (step: string, work: () => Promise<unknown>) => work().catch((error: unknown) => {
      console.error(`[linear-tickets] ${issue.identifier}: ${step} failed: ${error instanceof Error ? error.message : error}`);
    });
    try {
      const wait = await this.processWait(issue.id);
      if (wait) return { kind: "wait", reason: wait };
      const live = await this.liveSuccessorFor(issue.id, [predecessorId]);
      if (live) {
        // Nothing is claimed: a failed hand-off is tried again with the message on the next poll.
        await later("handing the record to the live agent", () => this.deps.handover.handOff(issue, predecessorId, live));
        return { kind: "live", agent: live };
      }
      // The successor belongs to the peer (the host drains, or the ticket is claimed there): the
      // ask and its handover snapshot go with it. The message is claimed right before forwarding,
      // and a failed forward stays in the peer's or this host's durable queue -- never a local
      // start, and never a fresh branch when the recorded one cannot be continued there.
      const routed = await this.deps.route?.take({
        kind: "recover", issueId: issue.id, identifier: issue.identifier,
        id: recoverActivationId(issue.id, predecessorId, lead),
        text: lead, strictResume: true,
      });
      // Held: nothing was started here and nothing was forwarded; the message stays unclaimed so
      // the next poll tries again.
      if (routed && "held" in routed) return { kind: "wait", reason: `the pull request's message is not routed yet: ${routed.held}` };
      if (routed) {
        await onDispatch();
        console.log(`[linear-tickets] ${issue.identifier}: the pull request's message for gone agent ${predecessorId.slice(0, 8)} is handed to ${routed.peer}`);
        return { kind: "started", agent: { id: `peer:${routed.peer}`, title: `an agent on ${routed.peer}`, cwd: "" } };
      }
      if (!await this.deps.handover.resumeTarget(issue.id)) return { kind: "impossible", reason: "no branch is recorded for the ticket" };
      const settings = await this.deps.settings.read();
      const admission = await this.deps.starter.admission(issue.id, paseo, settings);
      if (!admission.ok) return { kind: "wait", reason: admission.reason };
      await onDispatch();
      console.log(`[linear-tickets] ${issue.identifier}: the pull request's message for gone agent ${predecessorId.slice(0, 8)} is claimed; starting a successor`);
      const running = dispatchLabels(settings.dispatch.label).running;
      await this.deps.linear.addLabel(issue.id, running).catch(() => {});
      let agentId: string;
      try {
        agentId = (await this.deps.starter.start(issue.id, paseo, settings, { retryHint: "assign Paseo again", resumeOnly: true, lead })).agentId;
      } catch (error) {
        await this.deps.linear.removeLabel(issue.id, running).catch(() => {});
        return { kind: "impossible", reason: error instanceof Error ? error.message : String(error) };
      }
      console.log(`[linear-tickets] ${issue.identifier}: started a successor (agent ${agentId.slice(0, 8)}) for gone agent ${predecessorId.slice(0, 8)}`);
      const snapshot = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent;
      const agent = { id: agentId, title: snapshot?.title ?? null, cwd: snapshot?.cwd ?? "" };
      await later("opening the successor's thread", () => this.openFor(issue.id, issue.identifier, agentId));
      await later("archiving the gone agent", async () => { if (await this.agent(predecessorId)) await paseo.agents.ref(predecessorId).archive(); });
      await later("closing superseded threads", () => this.closeSuperseded());
      // Without the successor's worktree the record would lose its branch: the hand-off waits for
      // the next poll, which finds the successor live (see above), or for its first write-back.
      if (snapshot) await later("handing the record to the successor", () => this.deps.handover.handOff(issue, predecessorId, agent));
      else console.error(`[linear-tickets] ${issue.identifier}: the successor ${agentId.slice(0, 8)} could not be read; its record hand-off waits`);
      return { kind: "started", agent };
    } finally {
      gate.release();
    }
  }

  // Every ticket's unarchived root agents (no subagents) and its proven ghosts, for the watchdog.
  async watchdogRoots(): Promise<Map<string, TicketRoots>> {
    const tickets = new Map<string, TicketRoots>();
    if (!this.paseo) return tickets;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber === QUEUED_OWNER_MAX_PAGES) throw new Error("The agent list could not be fully read.");
      const page = await this.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) {
        const issueId = agent.labels?.["linear.issueId"];
        if (!issueId || agent.labels?.["paseo.parent-agent-id"] || agent.archivedAt) continue;
        const ticket = tickets.get(issueId) ?? { issueId, identifier: agent.labels?.["linear.identifier"] ?? issueId, roots: [], ghosts: new Set<string>() };
        ticket.roots.push(agent);
        tickets.set(issueId, ticket);
      }
      if (!page.pageInfo) throw new Error("The agent list could not be fully read.");
      if (!page.pageInfo.hasMore) break;
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (!cursor || cursors.has(cursor)) throw new Error("The agent list could not be fully read.");
      cursors.add(cursor);
    }
    const ghosts = await ghostAgents([...tickets.values()].flatMap((ticket) => ticket.roots), this.clock(), this.deps.processInspector);
    for (const ticket of tickets.values()) for (const agent of ticket.roots) if (ghosts.has(agent.id)) ticket.ghosts.add(agent.id);
    return tickets;
  }

  // The ticket's newest thread: queued, forwarded, split, parked or reviewing threads keep the
  // watchdog away.
  async watchdogThread(issueId: string): Promise<SessionLink | null> {
    return (await this.deps.store.all()).filter((link) => link.issueId === issueId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  // One watchdog step (watchdog.ts), in the ticket's turn and under its start gate like every
  // recovery: the step is checked again there (`check`, deep before the first effect, cheap after
  // every later await), claimed right before its first effect, and stops at once when the plugin
  // instance unloads. An ordinary message to a running agent stays `busy` (see prompt); only the
  // watchdog steers (OMP's `/steer`, which keeps the turn) or stops a turn on purpose.
  watchdogAct(request: WatchdogRequest): Promise<WatchdogOutcome> {
    if (!this.paseo) return Promise.resolve({ kind: "skipped", reason: "Paseo is not connected yet", end: false });
    return this.exclusive(request.issueId, async (): Promise<WatchdogOutcome> => {
      if (await this.deps.deletions?.blocked(request.issueId)) return { kind: "skipped", reason: "the ticket is paused for deletion", end: true };
      const gate = this.deps.launcher.gate(request.issueId);
      if (!gate) return { kind: "skipped", reason: "a launch for this ticket is under way", end: false };
      try {
        return await this.watchdogEffect(request);
      } catch (error) {
        return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
      } finally {
        gate.release();
      }
    });
  }

  private async watchdogEffect(request: WatchdogRequest): Promise<WatchdogOutcome> {
    const { issueId, rootId, action, text, marker } = request;
    const unloading: WatchdogOutcome = { kind: "skipped", reason: "the plugin is unloading", end: false };
    const found = rootId ? await this.agent(rootId) : null;
    if (!request.alive()) return unloading;
    if (!found && action !== "succeed") return { kind: "skipped", reason: "the agent is gone", end: true };
    const reason = await request.check(found?.agent ?? null, true);
    if (reason) return { kind: "skipped", reason, end: true };
    if (!request.alive()) return unloading;
    if (action === "succeed") return this.watchdogSucceed(request, found);
    const { handle, agent } = found!;
    const running = Boolean(agent.activeTurn || agent.status === "running");
    if (action === "steer" || action === "interrupt") {
      if (!running || (agent.activeTurn?.turnId ?? null) !== request.turnId) return { kind: "skipped", reason: "the silent turn already ended", end: true };
      if (agent.provider !== "omp") return { kind: "skipped", reason: `${agent.provider} agents cannot be steered without cancelling their turn`, end: true };
      await request.claim();
      if (action === "interrupt") return this.watchdogResume(request, found!, true, null);
      const fenced = await this.watchdogFence(request, agent);
      if (fenced) return fenced;
      await handle.send(`/steer ${text}`, { messageId: marker });
      return { kind: "done" };
    }
    if (action === "reload") {
      const reload = await this.deps.reloader?.();
      if (!reload) return { kind: "skipped", reason: "the daemon's agent reload is not available", end: false };
      await request.claim();
      return this.watchdogResume(request, found!, running, reload);
    }
    // `resume`: a closed or idle agent. A closed one is loaded again by the message itself, once its
    // ticket's terminal OMP roots are proven gone; a crashed one is reloaded first.
    if (running) return { kind: "skipped", reason: "the agent is working again", end: true };
    const crashed = crashedProcess(agent);
    if (agent.status === "closed" || crashed) {
      const wait = await this.processWait(issueId, [{ ...agent, id: rootId }]);
      if (wait) return { kind: "skipped", reason: wait, end: false };
    }
    const reload = crashed ? await this.deps.reloader?.() : null;
    if (crashed && !reload) return { kind: "skipped", reason: "the daemon's agent reload is not available", end: false };
    if (!request.alive()) return unloading;
    await request.claim();
    const fenced = await this.watchdogFence(request, agent);
    if (fenced) return fenced;
    try {
      if (reload) await reload(rootId);
      await handle.send(text, { messageId: marker });
    } catch (error) {
      return { kind: "failed", reason: `the agent could not be loaded (${error instanceof Error ? error.message : error})`, unloadable: true };
    }
    return { kind: "done" };
  }

  // The last look before an effect goes out, after every await that prepared it: the plugin still
  // runs and nothing (an owner Stop, a wait, a veto) excludes the ticket now. An unload keeps the
  // step for the next instance (its claim is released, nothing went out); `dispatched` says an
  // earlier part of the step (a retirement) already happened.
  private async watchdogFence(request: WatchdogRequest, agent: PaseoAgent | null, dispatched = false): Promise<WatchdogOutcome | null> {
    const unloading: WatchdogOutcome = { kind: "failed", reason: "the plugin unloaded before the step went out", retry: true };
    if (!request.alive()) return unloading;
    const reason = await request.check(agent, false);
    if (!request.alive()) return unloading;
    return reason ? { kind: "skipped", reason, end: true, ...(dispatched ? { dispatched } : {}) } : null;
  }

  // Stops the agent's turn and waits up to STOP_WAIT_MS for it to end. Returns the last snapshot.
  private async stopTurn(agentId: string): Promise<{ handle: PaseoAgentHandle; agent: PaseoAgent } | null> {
    const deadline = this.clock() + STOP_WAIT_MS;
    await (this.deps.stop ?? stopAgentTurn)(agentId);
    for (;;) {
      const current = await this.agent(agentId);
      if (!current || !(current.agent.activeTurn || current.agent.status === "running") || this.clock() >= deadline) return current;
      await (this.deps.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait))))(2_000);
    }
  }

  // The interrupt and reload steps: stop the turn when one runs, reload when asked, look again, and
  // send the resume. Everything after the claim reports what happened instead of throwing.
  private async watchdogResume(request: WatchdogRequest, found: { handle: PaseoAgentHandle; agent: PaseoAgent }, stop: boolean, reload: ((agentId: string) => Promise<void>) | null): Promise<WatchdogOutcome> {
    const { rootId } = request;
    try {
      let current: { handle: PaseoAgentHandle; agent: PaseoAgent } | null = found;
      if (stop) {
        current = await this.stopTurn(rootId);
        if (!current) return { kind: "failed", reason: "the agent disappeared after the stop" };
        if (current.agent.activeTurn || current.agent.status === "running") return { kind: "failed", reason: `the turn did not stop within ${STOP_WAIT_MS / 1000} seconds` };
      }
      if (!request.alive()) return { kind: "failed", reason: "the plugin unloaded before the resume went out" };
      if (reload) {
        await reload(rootId);
        current = await this.agent(rootId);
        if (!current) return { kind: "failed", reason: "the agent is gone after the reload" };
        if (current.agent.status === "error") return { kind: "failed", reason: `the agent is in error after the reload${current.agent.lastError ? ` (${current.agent.lastError})` : ""}` };
      }
      const reason = await request.check(current.agent, false);
      if (reason) return { kind: "skipped", reason, end: true, dispatched: true };
      if (!request.alive()) return { kind: "failed", reason: "the plugin unloaded before the resume went out" };
      if (busy(current.agent)) return { kind: "failed", reason: "the agent started another turn before the resume went out" };
      await current.handle.send(request.text, { messageId: `${request.marker}:resume` });
      return { kind: "done" };
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // The replacement: the predecessor is retired first (its Stop and archive are claimed), its
  // workers must be proven gone (`retry` until then; the watchdog's deadline ends that), and only
  // then a successor starts on the recorded branch and worktree, carrying the cycle's label. A
  // peer-bound replacement is forwarded with the cycle's history after the claim and never falls
  // back to a local start. Branch, worktree and uncommitted files stay as they are.
  private async watchdogSucceed(request: WatchdogRequest, found: { handle: PaseoAgentHandle; agent: PaseoAgent } | null): Promise<WatchdogOutcome> {
    const { issueId, identifier, rootId } = request;
    const paseo = this.paseo!;
    await request.claim();
    if (found) {
      let current: { handle: PaseoAgentHandle; agent: PaseoAgent } | null = found;
      if (current.agent.activeTurn || current.agent.status === "running") {
        current = await this.stopTurn(rootId);
        if (current && (current.agent.activeTurn || current.agent.status === "running")) return { kind: "failed", reason: `the silent agent's turn did not stop within ${STOP_WAIT_MS / 1000} seconds`, retry: true };
      }
      const reason = await request.check(current?.agent ?? null, false);
      if (reason) return { kind: "skipped", reason, end: true, dispatched: true };
      if (!request.alive()) return { kind: "failed", reason: "the plugin unloaded during the retirement", retry: true };
      if (current) await paseo.agents.ref(rootId).archive();
    }
    const wait = await this.processWait(issueId, found ? [{ ...found.agent, id: rootId }] : []);
    if (wait) return { kind: "failed", reason: wait, retry: true };
    const live = await this.liveSuccessorFor(issueId, [rootId]);
    if (live) {
      const marked = (await this.agent(live.id))?.agent.labels?.[WATCHDOG_LABEL] === request.marker;
      return marked ? { kind: "done", successor: live } : { kind: "skipped", reason: `agent ${live.id.slice(0, 8)} took over the ticket`, end: true, dispatched: true };
    }
    const fenced = await this.watchdogFence(request, null, Boolean(found));
    if (fenced) return fenced;
    const routed = await this.deps.route?.take({
      kind: "recover", issueId, identifier, id: `watchdog:${issueId}:${request.marker}`,
      text: request.text, strictResume: true, ...(request.history ? { watchdog: request.history } : {}),
    });
    if (routed && "held" in routed) return { kind: "failed", reason: `the replacement is not routed yet: ${routed.held}`, retry: true };
    if (routed) return { kind: "done", peer: routed.peer };
    if (!await this.deps.handover.resumeTarget(issueId)) return { kind: "failed", reason: "no branch is recorded for the ticket" };
    const settings = await this.deps.settings.read();
    const admission = await this.deps.starter.admission(issueId, paseo, settings);
    if (!admission.ok) return { kind: "failed", reason: admission.reason, retry: true };
    const running = dispatchLabels(settings.dispatch.label).running;
    await this.deps.linear.addLabel(issueId, running).catch(() => {});
    const last = await this.watchdogFence(request, null, Boolean(found));
    if (last) {
      await this.deps.linear.removeLabel(issueId, running).catch(() => {});
      return last;
    }
    let agentId: string;
    try {
      agentId = (await this.deps.starter.start(issueId, paseo, settings, { retryHint: "assign Paseo again", resumeOnly: true, lead: request.text, labels: { [WATCHDOG_LABEL]: request.marker } })).agentId;
    } catch (error) {
      await this.deps.linear.removeLabel(issueId, running).catch(() => {});
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    const later = (step: string, work: () => Promise<unknown>) => work().catch((error: unknown) => {
      console.error(`[linear-tickets] ${identifier}: ${step} failed: ${error instanceof Error ? error.message : error}`);
    });
    const snapshot = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent;
    const agent = { id: agentId, title: snapshot?.title ?? null, cwd: snapshot?.cwd ?? "" };
    await later("opening the replacement's thread", () => this.openFor(issueId, identifier, agentId));
    await later("closing superseded threads", () => this.closeSuperseded());
    if (snapshot) await later("handing the record to the replacement", () => this.deps.handover.handOff({ id: issueId, identifier }, rootId, agent));
    return { kind: "done", successor: agent };
  }

  async offerResume(sessionId: string): Promise<void> {
    const link = await this.deps.store.get(sessionId);
    if (!link || await this.deps.deletions?.blocked(link.issueId)) return;
    const offer = link.offer;
    if (offer === "split" || offer === "later" || offer === "parked") return;
    await this.deps.store.patch(sessionId, { offer: "resume" });
    await this.ask(sessionId, "The agent stopped. Continue with a new agent on the same branch?", [{ label: "Resume with a new agent", value: RESUME }, { label: "Leave it", value: LEAVE }]);
  }

  // The plan waits for the owner in the central Plannotator host and its agent is retired: no
  // Resume is offered, and the review is bound again once the host serves the plan.
  async parked(agentId: string): Promise<void> {
    const link = await this.sessionFor(agentId);
    if (!link) return;
    await this.deps.store.patch(link.sessionId, { offer: "parked" });
    await this.clearReview(link.sessionId);
  }

  // The owner decided a parked plan: the thread waits for a slot like a queued one, and the queue
  // sweep starts a fresh agent that implements the approved plan or plans again. Only while the
  // session still names the retired agent: "moved-on" once it was queued (or has a successor)
  // already, so a retried decision resets nothing; "none" without an open thread.
  async requeueSession(sessionId: string, agentId: string): Promise<"queued" | "moved-on" | "none"> {
    const link = await this.deps.store.get(sessionId);
    if (!link || link.closed) return "none";
    if (link.agentId !== agentId) return "moved-on";
    if (await this.deps.deletions?.blocked(link.issueId)) return "none";
    await this.clearReview(sessionId);
    await this.deps.store.patch(sessionId, { agentId: null, questions: null, queued: true, queueReason: undefined, restartRequested: true, offer: null });
    this.releaseQuestions(link);
    return "queued";
  }

  // "Approve, implement later" and "Approve & split" hold the session first: retiring the planner
  // then offers no Resume and starts no agent.
  async holdSession(sessionId: string, offer: "later" | "split"): Promise<void> {
    await this.deps.store.patch(sessionId, { offer });
  }

  // A split plan's steps are the parent's sub-issues: the parent closes when they are finished.
  async groupSession(sessionId: string): Promise<void> {
    await this.deps.store.patch(sessionId, { group: { delegated: false } });
  }

  async linkToPaseo(sessionId: string, agentId: string): Promise<void> {
    const serverId = await daemonServerId();
    if (!serverId) return;
    await this.link(sessionId, "Open in Paseo", paseoAgentUrl(serverId, agentId));
    await this.deps.store.patch(sessionId, { paseoLinked: agentId });
  }

  // A label or sidebar launch gets a session too, so the ticket shows the same agent panel, and
  // is delegated to the Paseo app like a ticket assigned in Linear: a ticket with an agent always
  // names Paseo. Delegated only after the session links the agent, so the delegation cannot start
  // a second one; a failed delegation keeps the session.
  async openFor(issueId: string, identifier: string, agentId: string): Promise<string | null> {
    if (await this.deps.deletions?.blocked(issueId)) return null;
    let sessionId: string;
    try {
      sessionId = await this.deps.api.createSessionOnIssue(issueId);
      await this.deps.store.put({ sessionId, agentId, issueId, identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null });
      await this.linkToPaseo(sessionId, agentId).catch(() => {});
    } catch (error) {
      console.error(`[linear-tickets] ${identifier}: could not open an agent session: ${error instanceof Error ? error.message : error}`);
      return null;
    }
    try {
      await this.deps.linear.delegate(issueId, (await this.deps.api.viewer()).id);
    } catch (error) {
      console.error(`[linear-tickets] ${identifier}: could not delegate the ticket to Paseo: ${error instanceof Error ? error.message : error}`);
    }
    return sessionId;
  }
}

// Decides a waiting Plannotator review through its local server (the same endpoints its page uses).
// The review's server is gone or no longer takes decisions.
export class ReviewClosedError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) { super(message); }
}

// `feedback` on an approval reaches the agent as Plannotator's approval notes.
export async function decidePlannotatorReview(localUrl: string, approve: boolean, feedback: string): Promise<void> {
  const origin = new URL(localUrl).origin;
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) throw new Error("Only local Plannotator reviews can be decided.");
  const response = await fetch(`${origin}/api/${approve ? "approve" : "deny"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(approve && !feedback ? {} : { feedback }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    // A refused connection never reached Plannotator (its server is gone): the decision was not
    // taken. Any later failure (reset, timeout) may come after Plannotator acted on it.
    const code = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : null;
    throw new ReviewClosedError(`Plannotator is not reachable at ${origin}: ${error instanceof Error ? error.message : error}`, code !== "ECONNREFUSED");
  });
  if (!response.ok) throw new ReviewClosedError(`Plannotator answered HTTP ${response.status}; the review is already closed.`);
}


// One line for the live feed, or null for tools not worth showing (reads, searches, thinking).
export function describeTool(item: { type: string; status?: string; detail?: { type: string; command?: string; filePath?: string } }): string | null {
  if (item.type !== "tool_call" || item.status !== "completed" || !item.detail) return null;
  if (item.detail.type === "shell" && item.detail.command) return `Ran ${item.detail.command.slice(0, 200)}`;
  if ((item.detail.type === "edit" || item.detail.type === "write") && item.detail.filePath) return `Edited ${item.detail.filePath}`;
  return null;
}
