import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { ActivationIntake } from "./activation-intake";
import { dispatchLabels, type DispatchLabels } from "./dispatch";
import { FOCUS_REASON, type Focus } from "./focus";
import type { Handover, HandoverRecord } from "./handover";
import type { Launcher } from "./launch";
import type { IssueCore, LinearService, StewardIssue } from "./linear";
import type { ManualTasks } from "./manual-tasks";
import type { NeedsYouIssues } from "./needs-you";
import type { ParkedPlans } from "./parked";
import type { ParentPhase, ParentProgress } from "./parents";
import { LIVE_AGENT, type ProcessInspector } from "./process-liveness";
import { PLAN_REVIEW_STATE, PLANNING_STATE, planStage } from "./plan-policy";
import type { PullState, StackState } from "./pr-watch";
import { RateLimitedError, withPriority } from "./rate-budget";
import { EXCLUSION_CLOSED_MESSAGE, REPAIR_BUSY_MESSAGE, RepairBusyError } from "./repair-exclusion";
import type { ReviewDeletions } from "./review-deletions";
import { RESPONSIBILITY_GRACE_MS, type ResponsibilityCheck, type ResponsibilityTicket } from "./responsibility";
import { AWAY_REASON } from "./scheduler";
import { recordedCiFails } from "./pr-nudge";
import type { HostOwnership, RestartResult, SessionRouter, Succession } from "./sessions";
import type { PluginSettings, Settings } from "./settings";
import { classifyTicketAgents, issueAgents, WAITING_PLAN_REASON, type TicketStarter } from "./starter";
import { paseoHome } from "./ticket-mcp";
import { takeLease, releaseLease, type TicketRoots, type WatchedAgent, type WatchdogFile, type WatchdogStore } from "./watchdog";
import { NEEDS_INPUT_STATE, STEWARD_WAIT_ANCHOR, type Writeback } from "./writeback";
import { CONTROL_CHECK_MS, RECOVERY_REACTION_MS, DIAGNOSTIC_TIMEOUT_MS, DIAGNOSTIC_CAP, diagnosticBrief, recentDiagnostics, stageEvidence, stageAdvanced, type RecoveryDiagnostic, type Responsibility } from "./recovery-diagnostic";

// The ticket steward (README, "Ticket steward"): one level-triggered reconciler for every in-scope
// open ticket of the dispatch teams. The plugin's other loops are event- or domain-scoped — label
// dispatch sees labelled tickets, the pull request watch sees the records this host owns, the
// session sweep sees Linear's threads, the write-back sees the waits it recorded — and each has a
// filter a stuck ticket can fall out of: a merged stack in In Review, a gone agent without a label,
// a parent whose sub-issues finished without a group link, a wait whose ending event was lost.
// The steward recomputes, every pass, what each ticket is — moving, waiting for the owner, waiting
// for a blocker, queued, closeable — from fresh facts, and repairs a ticket that is in none of
// those with exactly one action: a verifier for a landed stack, a successor for a pull request
// whose agent is gone, a restart for a vanished agent, an archive for the agent of a finished
// ticket, a cleared stale wait, a closed parent, or an escalation that puts the decision in front
// of the owner as a Needs-input item. It is the loop that ends in a decision rather than a comment.
//
// Missed events do not matter: every pass recomputes from Linear, the handover records, the agent
// listing and the pull request watch's own state; the store only remembers what a pass may not
// repeat (a claimed effect, its budgets, the escalation already posted). Every effect is claimed
// in steward.json before it runs, like the watchdog's steps, so a restart never repeats one blindly.

// How often the pass runs (the dispatch poll calls it every `dispatch.intervalSeconds`).
export const STEWARD_POLL_MS = CONTROL_CHECK_MS;
// A defect (a ticket in none of the five states) is acted on only after it has been seen this long,
// so a start, a successor or a thread that is about to make the ticket move is waited for.
export const DEFECT_GRACE_MS = RECOVERY_REACTION_MS;
// A ticket is restarted at most RESTART_CAP times within STEWARD_WINDOW_MS.
export const RESTART_CAP = 3;
export const STEWARD_WINDOW_MS = 24 * 60 * 60_000;
// How many refusals (a start that could not run) a ticket may collect before the steward stops
// retrying and asks the owner. A permanent refusal (setup, an ineligible ticket) escalates at once.
export const REFUSAL_CAP = 3;
// A claim whose outcome was never written (a reload in the middle): nothing is repeated for this
// long, then the claim is marked outcome-unknown and the facts decide again.
export const CLAIM_GRACE_MS = RECOVERY_REACTION_MS;
// A verifier that has not reported within this long is escalated.
export const VERIFY_TIMEOUT_MS = RECOVERY_REACTION_MS;
// A recorded wait whose ending event was lost is cleared after this long without a live agent
// (writeback.ts WAIT_NO_AGENT_GRACE_MS, unchanged).
const WAIT_NO_AGENT_GRACE_MS = 10 * 60_000;
const LOG_LIMIT = 10;
const CLOSED_TYPES = ["completed", "canceled", "duplicate"] as const;
const DO_NOT_MERGE = "do-not-merge";
// The states a replacement agent may start in: Triage, Backlog, Todo, a plan stage or In Progress
// (label-repair.ts's rule, unchanged).
const RESTART_TYPES = new Set(["triage", "backlog", "unstarted"]);
const RESTART_STARTED_STATES = new Set(["in progress"]);
// Where the verifier's structured verdicts land (`ticket-mcp-source.ts` writes them in the agent's
// own process; the steward reads them here).
export const STEWARD_VERDICT_DIRECTORY = "steward-verdicts";
// The label a verifier carries, so its agent is told apart from the ticket's own.
export const STEWARD_VERIFIER_LABEL = "linear-tickets.steward";
// The reason the start gate gives when a live agent took the ticket over between the read and the
// start: not a failure — somebody works on it.
const LIVE_AGAIN_PREFIX = "an agent works on ";

type Linear = Pick<LinearService,
  "stewardIssues" | "issueGroup" | "issueStatus" | "issueStatuses" | "issueCore" | "issueRef" | "addLabel" | "removeLabel" | "comment" | "createIssue" | "relate" | "complete" | "moveToReady" | "setDueDate" | "trustedAppIds">;
type Sessions = Pick<SessionRouter, "restartFor" | "succeed" | "resumeVerifiedParent" | "prompt" | "continueOperation" | "watchdogRoots" | "watchdogThread" | "retireTurn" | "threadQueued" | "parentProgress" | "parentProgresses">;
type Continuation = Awaited<ReturnType<SessionRouter["continueOperation"]>>;

export type StewardDeps = {
  // The durable store (steward.json); the daemon passes the default path.
  store: StewardStore;
  linear: Linear;
  sessions: Sessions;
  // `admission`: the same gate every start takes (focus, parked plans, blockers, the scheduler's
  // slot and RAM lease, presence). The verifier takes it too (README, "Ticket steward").
  starter: Pick<TicketStarter, "start" | "admission">;
  launcher: Pick<Launcher, "gate">;
  handover: Pick<Handover, "all">;
  // The owner-visible side of an escalation and the end of a stale wait (writeback.ts).
  writeback: Pick<Writeback, "escalate" | "clearWait">;
  watchdog: Pick<WatchdogStore, "read" | "handedOver">;
  manualTasks: Pick<ManualTasks, "openBlockers" | "tasksStrict">;
  needsYou: Pick<NeedsYouIssues, "all" | "allStrict">;
  settings: Pick<Settings, "read">;
  // Which host owns a ticket's automatic work (activation-guard.ts ticketOwnership).
  owner: (issueId: string) => Promise<HostOwnership>;
  // The pull request watch's own state for the tickets' recorded pull requests (pr-watch.ts
  // `Seen`), and the complete fresh pull-request inventory of one ticket for a verdict's close
  // (pr-watch.ts `completionPulls`): every attached and recorded pull request, across all of its
  // repositories, read from GitHub now — not the retirement policy's cached set, not a veto list.
  pulls: (urls: string[]) => Promise<Map<string, PullState>>;
  completionPulls: (issueId: string, identifier: string, urls: string[]) => Promise<StackState>;
  // Which of a ticket's recorded open pull requests GitHub still has open, read fresh right before a
  // successor starts on one (pr-watch.ts `freshOpenPulls`): the recorded state is a claim from the
  // watch's last read of that URL, and a pull request that closed or landed since it starts nothing.
  freshOpenPulls: (urls: string[]) => Promise<{ open: string[]; unreadable: boolean }>;
  intake: Pick<ActivationIntake, "claimsReady">;
  doneTickets: DoneTickets;
  // The `<trigger>-running` labels still to remove after an archive (retired-labels.json).
  labels: Pick<RetiredLabels, "all" | "add" | "remove">;
  // The parked plans of the Plannotator host (parked.ts): a plan that waits for the owner's
  // decision is a deliberate wait, never recovered.
  planned?: Pick<ParkedPlans, "has">;
  deletions?: Pick<ReviewDeletions, "blocked">;
  focus?: Pick<Focus, "admits">;
  inspect?: ProcessInspector;
  recoveryWait?: (issueId: string, identifier: string, urls: string[]) => Promise<string | null>;
  now?: () => number;
  // The verifier's structured verdicts, oldest first (ticket-mcp-source.ts `steward_verdict`).
  verdicts?: (issueId: string) => Promise<StewardVerdict[]>;
  // The responsibility check (responsibility.ts): its lost-review hold and its ten-minute run.
  responsibility?: Pick<ResponsibilityCheck, "due" | "holds" | "run">;
};

// The pull request watch's state of one pull request, as far as this module cares (pr-watch.ts
// `Seen`): whether it landed (MERGED, or CLOSED with the repo's `externally-merged` label or the
// merge queue's own "Merged by the Graphite merge queue" bullet), whether it was closed without
// merging, and what the reviewers asked for.

// Whether a finished ticket's stack landed: `open` while the watch still sees an open pull request
// of it, `unknown` while its pull requests were never listed (pr-watch.ts stackState).

// --- Situations -----------------------------------------------------------------------------------

// The five states every in-scope open ticket is in — MOVING, WAITING_OWNER, WAITING_BLOCKER,
// QUEUED, PARKED — and the defects a pass repairs. `closed` is a finished ticket with nothing left
// to do (its agents archived); it is outside the five on purpose, as the invariant covers open
// tickets. No situation completes or cancels a ticket: the group coordinator hands out children,
// and the steward closes parents only after a verifier's verdict and fresh completion fences.
export const STEWARD_SITUATIONS = [
  "moving",
  "waiting-owner",
  "waiting-blocker",
  "queued",
  "parked",
  "closed",
  "terminal-agents",
  "landed",
  "open-pr",
  "closed-unmerged",
  "stalled",
  "unstarted",
  "idle",
  "idle-unresponsive",
  "wait-stale",
  "verifying",
  "queued-too-long",
  "restart-exhausted",
  "watchdog-exhausted",
  "refused",
  "escalated",
] as const;
export type StewardSituation = (typeof STEWARD_SITUATIONS)[number];

export type StewardAction = "start" | "restart" | "succeed" | "resume" | "verify" | "archive" | "clear-wait" | "escalate";

// The one action of each situation (null: none — the ticket is exactly where it should be). A
// Record, not a switch: a new situation without an action is a type error.
export const STEWARD_ACTION: Record<StewardSituation, StewardAction | null> = {
  "moving": null,
  "waiting-owner": null,
  "waiting-blocker": null,
  "queued": null,
  "parked": null,
  "closed": null,
  "terminal-agents": "archive",
  "landed": "verify",
  "open-pr": "succeed",
  "closed-unmerged": "succeed",
  "stalled": "restart",
  "unstarted": "start",
  "idle": "resume",
  "idle-unresponsive": "verify",
  "wait-stale": "clear-wait",
  "verifying": null,
  "queued-too-long": "escalate",
  "restart-exhausted": "escalate",
  "watchdog-exhausted": "escalate",
  "refused": "escalate",
  "escalated": "escalate",
};

// The five states of the invariant: a ticket in one of them needs no repair.
export const STEWARD_STATES: Record<StewardSituation, boolean> = {
  "moving": true,
  "waiting-owner": true,
  "waiting-blocker": true,
  "queued": true,
  "parked": true,
  "closed": false,
  "terminal-agents": false,
  "landed": false,
  "open-pr": false,
  "closed-unmerged": false,
  "stalled": false,
  "unstarted": false,
  "idle": false,
  "idle-unresponsive": false,
  "wait-stale": false,
  "verifying": false,
  "queued-too-long": false,
  "restart-exhausted": false,
  "watchdog-exhausted": false,
  "refused": false,
  "escalated": false,
};

export function isDefect(situation: StewardSituation): boolean {
  return situation !== "closed" && !STEWARD_STATES[situation];
}

// --- Facts and the classifier ---------------------------------------------------------------------

export type StewardPullFacts = PullState & { url: string };

// A deliberate wait, put there by the owner or the policy: no automatic mechanism may recover it
// (the deleted retirement's fences and the watchdog's exclusion list, folded in here).
export type StewardDeliberate =
  // The owner's own veto or step.
  | "hold" | "manual" | "do-not-merge" | "stopped" | "needs-you"
  // The plan waits for the owner: the status, a parked plan, an open review or a retirement offer.
  | "plan-review"
  // The ticket's thread is with the peer host (drain), or a live root waits for an answer.
  | "remote" | "permissions"
  // The admission gates the ticket waits behind: focus mode.
  | "focus";

// Everything the classifier decides on, read fresh each pass.
export type StewardFacts = {
  identifier: string;
  status: string;
  statusType: string;
  terminal: boolean;
  // The ticket's own sub-issues: how many, how many are open, and whether the list was read in
  // full (`complete`: without it no parent is ever treated as finished).
  children: { total: number; open: number; complete: boolean };
  // The deliberate wait the ticket is in, if any: recovery never touches it.
  deliberate: StewardDeliberate | null;
  // Durable parent lifecycle, independent of the latest UI thread's open/closed state.
  parentPhase: ParentPhase | null;
  // A coordinator still handing out children (or an open legacy group awaiting migration).
  groupLinked: boolean;
  // A verifier parked the ticket (the park verdict): it waits for a blocker or a date.
  parked: boolean;
  // An unfinished blocker (linear.ts finishedIssue: done, canceled, duplicate, or in review with
  // merged pull requests).
  blocker: string | null;
  live: boolean;
  // The live roots' silence: null while one of them has an open turn, else their quiet time.
  idleMinutes: number | null;
  // The silence that makes a live root idle (steward.idleMinutes).
  idleThreshold: number;
  // A recorded wait for the owner: `live` while something can still end it, `stale` when nothing
  // can (the agent is gone and the grace has passed), `none` without one.
  ownerWait: "none" | "live" | "stale";
  // The steward already resumed these roots for this silence (once, then a verifier judges).
  resumed: boolean;
  // A thread of the ticket waits for its blockers or a slot (sessions.ts startQueued).
  queuedThread: boolean;
  // The steward's own admission deferral: the last start waited for its turn (no budget spent).
  queuedAt: string | null;
  queuedSince: string | null;
  queuedTooLong: boolean;
  // The queue deadline the too-long escalation reads (steward.queuedEscalateHours).
  queuedHours: number;
  openPulls: StewardPullFacts[];
  landedPulls: StewardPullFacts[];
  closedPulls: StewardPullFacts[];
  // Open manual tasks due before the merge hold the ready state back (pr-watch.ts gate).
  beforeMerge: number;
  // The ticket ever started: a handover record of an agent, an agent or a pull request.
  started: boolean;
  // It may start now: a state a replacement starts in, no hold/manual/needs-you label, no
  // do-not-merge, nothing waiting on purpose.
  startable: boolean;
  restarts: number;
  refusals: number;
  lastRefusal: string | null;
  watchdog: "none" | "active" | "queued" | "exhausted";
  verifier: boolean;
  // The landed set that was already verified once, and the escalation of the current situation.
  verified: string | null;
  landedSignature: string;
  escalated: string | null;
};

// The one situation of a ticket. Exhaustive and ordered: the first match wins, and the order is
// the precedence the tests pin — a finished ticket beats everything, a claimed verifier beats the
// facts it is judging, deliberate waits beat every repair, and only unfinished group members stay
// with the coordinator. A finished parent is judged after its own live/owner/blocker/pull-request
// facts, and recovery budgets are checked before successor branches that would spend them.
export function classifyTicket(facts: StewardFacts): StewardSituation {
  if (facts.terminal) return facts.live ? "terminal-agents" : "closed";
  if (facts.verifier) return "verifying";
  // A deliberate wait: the ticket is where it should be, and nothing automatic may touch it.
  if (facts.deliberate === "focus" || facts.deliberate === "remote") return "queued";
  if (facts.deliberate) return "waiting-owner";
  if (facts.parentPhase === "paused" || facts.parentPhase === "closed") return facts.blocker ? "waiting-blocker" : "waiting-owner";
  if (facts.groupLinked && (!facts.children.complete || facts.children.open > 0)) return "moving";
  if (facts.live) {
    if (facts.ownerWait === "live") return "waiting-owner";
    if (facts.idleMinutes !== null && facts.idleMinutes >= facts.idleThreshold && facts.openPulls.length === 0) return facts.resumed ? "idle-unresponsive" : "idle";
    return "moving";
  }
  if (facts.ownerWait === "live") return "waiting-owner";
  if (facts.ownerWait === "stale") return "wait-stale";
  if (facts.blocker) return "waiting-blocker";
  if (facts.parked) return "parked";
  // The owner-wait state with no recorded wait: an agent's status call moved the ticket there, the
  // owner did, or the record was lost with its agent. Nothing can end it (no answer is consumed, no
  // event clears it), so it is stale exactly like a dead wait, and the pass clears it back to work.
  if (facts.ownerWait === "none" && facts.status.trim().toLowerCase() === NEEDS_INPUT_STATE.toLowerCase()) return "wait-stale";
  if (facts.watchdog === "active") return "moving";
  if (facts.watchdog === "queued") return "queued";
  // A start that waited for its turn stays queued and is retried; its budget is untouched.
  const queued = facts.queuedThread || facts.queuedAt !== null;
  if (queued) return facts.queuedTooLong ? "queued-too-long" : "queued";
  if (facts.refusals >= REFUSAL_CAP) return "refused";
  // Every branch below starts something: the recovery budget is checked before each of them.
  if (facts.openPulls.length > 0) return facts.restarts >= RESTART_CAP ? "restart-exhausted" : "open-pr";
  if (facts.landedPulls.length > 0 && facts.beforeMerge === 0) return facts.verified === facts.landedSignature ? "escalated" : "landed";
  if (facts.restarts >= RESTART_CAP) return "restart-exhausted";
  if (facts.closedPulls.some((pull) => pull.replay !== "asked")) return "closed-unmerged";
  if (facts.closedPulls.length > 0) return "escalated";
  // A parent whose sub-issues all finished is judged like any ticket: a verifier, never a straight
  // completion (its own work — a pull request, a blocker, the owner — comes first), and never a
  // restart (its sub-issues say the work is finished).
  if ((facts.children.total > 0 || facts.parentPhase === "verification") && facts.children.open === 0 && facts.children.complete) return facts.verified === facts.landedSignature ? "escalated" : "landed";
  if (facts.refusals > 0 && !facts.startable) return "refused";
  if (facts.watchdog === "exhausted") return "watchdog-exhausted";
  if (facts.started) return facts.startable ? "stalled" : "escalated";
  return facts.startable ? "unstarted" : "escalated";
}

// --- Durable state ---------------------------------------------------------------------------------

// `claimed`: written right before the effect; a restart that finds it cannot know whether the
// effect happened (the crash gap) and never repeats it blindly. `done`/`failed`: the outcome.
// `deferred`: nothing was attempted (the start waited for admission); no budget was spent and the
// pass retries the action from the ticket's `queued` record.
export type StewardClaim = { action: StewardAction; marker: string; at: string; state: "claimed" | "done" | "failed" | "deferred"; result?: string };
// The verifier a pass started for a ticket, and the verdict it returned. `marker` binds a verdict
// to the verifier generation that issued it (ticket-mcp-source.ts `steward_verdict`) and is also
// the value the verifier's agent label carries, so an interrupted launch is adopted by marker
// instead of losing its verdict. `agentId` is null between the marker's persistence and the
// launch's return; the label is what ties the two together across a reload.
export type StewardVerifier = { agentId: string | null; marker: string; at: string; children?: string[] };
// A start the steward attempted and admission deferred (no slot, focus, a blocker, presence): the
// ticket waits in the queue without spending a restart or a refusal, and the pass retries the
// recorded action until it is admitted (or `steward.queuedEscalateHours` passes).
export type StewardQueued = { situation: StewardSituation; action: StewardAction; at: string; reason: string };
// A verifier's verdict being applied: written before the first effect, with the steps that already
// committed, so a reload never repeats a close or loses the verdict (steward.ts `verdict`).
// `timeout` and `exhausted` are the verifier's terminal outcomes (it never reported, or its
// resume verdict outran the recovery budget): they are journaled like a verdict, so their
// owner-facing escalation is retried instead of being lost between the archive and the call.
export type StewardApplying = { marker: string; verdict: StewardVerdictKind | "timeout" | "exhausted"; step: "claimed" | "closed" | "parked" | "escalated" | "resumed"; at: string };
// The verifier's park (the `park` verdict): the ticket waits for a blocker or a date.
export type StewardParked = { at: string; blockedBy: string | null; dueDate: string | null; reason: string };
export type StewardTicket = {
  identifier: string;
  // The last situation and when it was first seen (the flow view, and the grace before a defect is
  // acted on).
  situation: StewardSituation;
  since: string;
  at: string;
  claim: StewardClaim | null;
  // Restarts claimed within the window, oldest first.
  restarts: string[];
  // Refusals (a start that could not run) within the window.
  refusals: { at: string; reason: string }[];
  // The silence the last resume answered, so one resume happens per silence.
  resumedAt: string | null;
  verifier: StewardVerifier | null;
  // The landed set that was verified, and the owner-facing escalation of the current situation.
  verified: string | null;
  escalated: { key: string; signature: string; at: string } | null;
  // The owner's own continuation (the trigger label, the sidebar): budgets and escalations restart.
  ownerAt: string | null;
  // An admission deferral the pass retries (see StewardQueued), a verdict being applied, and a
  // verifier's park.
  queued: StewardQueued | null;
  applying: StewardApplying | null;
  parked: StewardParked | null;
  log: { at: string; action: string }[];
  responsibility?: Responsibility;
  diagnostic?: RecoveryDiagnostic | null;
  diagnostics?: string[];
  diagnosticRequested?: string | null;
  continuation?: { agentId: string; operationId: string; text: string; at: string; status: Continuation["status"] } | null;
  // A confirmed recovery result followed by a stage transition is a temporal proxy, not proof
  // that recovery caused progress. Reconciliation of the same operation never opens it twice.
  recoveryObservation?: { key: string; at: string; advancedAt?: string };
  recoveryOutcomes?: Record<string, number>;
};
// The flow view: the counts of the last pass and the oldest tickets of each state.
export type StewardFlow = {
  at: string;
  counts: Record<string, number>;
  oldest: { identifier: string; situation: StewardSituation; since: string }[];
};
export type StewardFile = { version: 1; tickets: Record<string, StewardTicket>; flow: StewardFlow | null };

export class StewardStateError extends Error {}

function emptyFile(): StewardFile {
  return { version: 1, tickets: {}, flow: null };
}

function parseFile(text: string): StewardFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new StewardStateError("steward.json is not valid JSON"); }
  const file = value as Partial<StewardFile> | null;
  if (!file || typeof file !== "object" || file.version !== 1 || !file.tickets || typeof file.tickets !== "object") {
    throw new StewardStateError("steward.json has an unknown shape or version");
  }
  for (const [issueId, ticket] of Object.entries(file.tickets)) {
    if (!ticket || typeof ticket !== "object" || typeof ticket.situation !== "string" || !Array.isArray(ticket.restarts)) {
      throw new StewardStateError(`steward.json has a malformed entry for ${issueId}`);
    }
    const responsibility = ticket.responsibility;
    if (responsibility && (typeof responsibility.generation !== "string" || typeof responsibility.host !== "string" || !Number.isFinite(Date.parse(responsibility.nextCheckAt)) || !Number.isFinite(Date.parse(responsibility.observedAt)))) throw new StewardStateError(`steward.json has malformed responsibility for ${issueId}`);
    const diagnostic = ticket.diagnostic;
    if (diagnostic && (typeof diagnostic.marker !== "string" || typeof diagnostic.generation !== "string" || typeof diagnostic.host !== "string" || !Number.isFinite(Date.parse(diagnostic.at)) || !Number.isFinite(Date.parse(diagnostic.deadline)) || !["launching", "running", "applying", "waiting", "done"].includes(diagnostic.state))) throw new StewardStateError(`steward.json has malformed diagnosis for ${issueId}`);
    if (ticket.diagnostics && (!Array.isArray(ticket.diagnostics) || ticket.diagnostics.some((at) => !Number.isFinite(Date.parse(at))))) throw new StewardStateError(`steward.json has malformed diagnostic budget for ${issueId}`);
  }
  return { version: 1, tickets: file.tickets as Record<string, StewardTicket>, flow: file.flow ?? null };
}

// steward.json next to pr-watch.json: atomic, owner-only, every change serialized. Only a missing
// file starts empty; an unreadable or corrupt one throws, so no budget is ever reset by a bad read.
export class StewardStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path = join(paseoHome(), "linear-tickets", "steward.json")) {}

  async read(): Promise<StewardFile> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw new StewardStateError(`steward.json cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    return parseFile(text);
  }

  update<T>(work: (file: StewardFile) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const file = await this.read();
      const result = await work(file);
      await this.write(file);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(file: StewardFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(file), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  // The ticket's record, created empty when the ticket is new to the store.
  ticket(file: StewardFile, issueId: string, identifier: string, at: string): StewardTicket {
    file.tickets[issueId] ??= {
      identifier, situation: "moving", since: at, at, claim: null, restarts: [], refusals: [], resumedAt: null,
      verifier: null, verified: null, escalated: null, ownerAt: null, queued: null, applying: null, parked: null, log: [],
    };
    if (identifier && identifier !== issueId) file.tickets[issueId].identifier = identifier;
    return file.tickets[issueId];
  }
}

// --- Finished tickets, their labels and the stack check --------------------------------------------

export const QUIET_DONE_MS = 60 * 60_000;
const TERMINAL: Record<string, true> = { completed: true, canceled: true, duplicate: true };

// How long the agent has been quiet: since its last update in Paseo. Null for an unreadable or
// future time, which never counts as quiet.
export function quietFor(updatedAt: string | null | undefined, now: number): number | null {
  const at = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(at) && at <= now ? now - at : null;
}

// The last workflow state type Paseo saw of each ticket with a candidate agent, for the slot count
// (TicketStarter's scheduler) and the steward's archive. Of two observations the later stamp wins:
// a read is stamped when its request was sent, a state the plugin wrote when Linear confirmed it,
// and a write wins a tie. So a reopen written after a poll's read is never undone by that read.
// Kept in memory: after a reload every agent counts until the first pass observed its ticket.
export class DoneTickets {
  private readonly seen = new Map<string, { type: string; at: number }>();

  // A successful read that returned the ticket.
  read(issueId: string, type: string, at: number): void {
    const known = this.seen.get(issueId);
    if (known && known.at >= at) return;
    this.seen.set(issueId, { type: type.trim().toLowerCase(), at });
  }

  // A state the plugin wrote (LinearService.onStateWritten).
  written(issueId: string, type: string, at: number): void {
    const known = this.seen.get(issueId);
    if (known && known.at > at) return;
    this.seen.set(issueId, { type: type.trim().toLowerCase(), at });
  }

  // A successful read that did not return the ticket (deleted, no access): its agent counts again,
  // unless a later observation exists. A failed read changes nothing.
  missing(issueId: string, at: number): void {
    const known = this.seen.get(issueId);
    if (known && known.at < at) this.seen.delete(issueId);
  }

  retain(issueIds: Set<string>): void {
    for (const issueId of [...this.seen.keys()]) if (!issueIds.has(issueId)) this.seen.delete(issueId);
  }

  type(issueId: string): string | null {
    return this.seen.get(issueId)?.type ?? null;
  }

  // The agent frees its slot: its ticket was last seen Done, Canceled or Duplicate, and it has been
  // quiet for more than QUIET_DONE_MS. Any activity, or a state the plugin writes, counts it again.
  releases(agent: Pick<PaseoAgent, "labels" | "updatedAt">, now: number): boolean {
    const issueId = agent.labels?.["linear.issueId"];
    const type = issueId ? this.type(issueId) : null;
    if (!type || !TERMINAL[type]) return false;
    const quiet = quietFor(agent.updatedAt, now);
    return quiet !== null && quiet > QUIET_DONE_MS;
  }
}

// The `<trigger>-running` labels still to remove after an archive, one per archived agent, in
// retired-labels.json next to pr-watch.json: written before the archive, so a reload between the
// archive and the label step loses nothing. Only a missing file starts empty; an unreadable one
// throws, so nothing is archived while it cannot be written.
export type RetiredLabel = { issueId: string; identifier: string; agentId: string };

export class RetiredLabels {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path = join(paseoHome(), "linear-tickets", "retired-labels.json")) {}

  async all(): Promise<RetiredLabel[]> {
    return Object.values(await this.read());
  }

  add(entry: RetiredLabel): Promise<void> {
    return this.update((entries) => { entries[entry.agentId] = entry; });
  }

  remove(agentId: string): Promise<void> {
    return this.update((entries) => { delete entries[agentId]; });
  }

  private async read(): Promise<Record<string, RetiredLabel>> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`retired-labels.json cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("retired-labels.json is not valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("retired-labels.json has an unknown shape");
    const entries: Record<string, RetiredLabel> = {};
    for (const [agentId, value] of Object.entries(parsed as Record<string, Partial<RetiredLabel>>)) {
      if (value && typeof value.issueId === "string" && typeof value.identifier === "string" && value.agentId === agentId) entries[agentId] = { issueId: value.issueId, identifier: value.identifier, agentId };
    }
    return entries;
  }

  private update(change: (entries: Record<string, RetiredLabel>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = await this.read();
      change(entries);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// --- The verifier's verdict ------------------------------------------------------------------------

// Design correction B: exactly four verdicts. `follow_up` is gone — the owner files no follow-up
// issues for open tickets. `park` hands the ticket back to Linear as startable work: a blocking
// relation and/or a due date, Todo, and the trigger label only when there is a blocker to wait for.
export type StewardVerdictKind = "close" | "resume" | "park" | "ask_owner" | "continue" | "replace" | "wait";
// What one verifier recorded through the `steward_verdict` tool: exactly one verdict, bound to the
// verifier generation that issued it (`verifier`: the marker the steward started it with).
export type StewardVerdict = {
  issueId: string;
  at: string;
  verifier: string;
  verdict: StewardVerdictKind;
  // `resume`: what the ticket's agent must still do. `park`: why the ticket waits, the blocker
  // ticket (an identifier) and/or the date it waits for. `ask_owner`: the question and its options.
  instruction: string | null;
  blockedBy: string | null;
  dueDate: string | null;
  reason: string | null;
  question: string | null;
  options: string[] | null;
  nextCheckAt?: string | null;
};

const VERDICT_KINDS: StewardVerdictKind[] = ["close", "resume", "park", "ask_owner", "continue", "replace", "wait"];

// A real calendar date: the shape alone accepts 2026-02-31, which Linear would refuse later and
// which would park a ticket that nothing ever wakes.
export function calendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function parseVerdict(value: unknown): StewardVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const verdict = VERDICT_KINDS.find((kind) => kind === raw.verdict);
  if (!verdict || typeof raw.issueId !== "string" || typeof raw.at !== "string" || typeof raw.verifier !== "string" || !raw.verifier.trim()) return null;
  const field = (key: string, limit: number) => typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim().slice(0, limit) : null;
  const options = Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 6) : null;
  const record: StewardVerdict = {
    issueId: raw.issueId, at: raw.at, verifier: raw.verifier.trim().slice(0, 64), verdict,
    instruction: field("instruction", 4_000), blockedBy: field("blockedBy", 40), dueDate: field("dueDate", 10),
    reason: field("reason", 2_000), question: field("question", 2_000), options,
    nextCheckAt: field("nextCheckAt", 40),
  };
  // A verdict that does not name what it needs is refused rather than applied as a guess: a park
  // without a blocker or a date would wait for nothing, forever.
  if (verdict === "resume" && !record.instruction) return null;
  if (verdict === "park" && (!record.reason || (!record.blockedBy && !record.dueDate))) return null;
  if (verdict === "park" && record.dueDate && !calendarDate(record.dueDate)) return null;
  if (verdict === "ask_owner" && (!record.question || !record.options?.length)) return null;
  if (!Number.isFinite(Date.parse(record.at))) return null;
  if ((verdict === "continue" || verdict === "replace") && !record.instruction) return null;
  if (verdict === "wait" && (!record.reason || !record.instruction || !record.nextCheckAt || !Number.isFinite(Date.parse(record.nextCheckAt)) || Date.parse(record.nextCheckAt) <= Date.parse(record.at) || Date.parse(record.nextCheckAt) - Date.parse(record.at) > RECOVERY_REACTION_MS)) return null;
  const diagnostic = record.verifier.startsWith("diagnostic-");
  if (diagnostic && (!["continue", "replace", "wait", "ask_owner"].includes(verdict) || (verdict === "ask_owner" && !record.reason))) return null;
  if (!diagnostic && ["continue", "replace", "wait"].includes(verdict)) return null;
  return record;
}

// The verifier's records, oldest first, from its own directory (ticket-mcp-source.ts
// `steward_verdict`). The first record of the verifier generation that issued it is the verdict;
// later ones (a second call, a crashed retry) are ignored by the caller.
export async function readVerdicts(directory: string): Promise<StewardVerdict[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const verdicts: StewardVerdict[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const parsed = await readFile(join(directory, name), "utf8").then((text) => JSON.parse(text) as unknown, () => null);
    const verdict = parseVerdict(parsed);
    if (verdict) verdicts.push(verdict);
  }
  return verdicts.sort((a, b) => a.at.localeCompare(b.at));
}

// --- Texts ------------------------------------------------------------------------------------------

export function restartText(identifier: string, attempt: number, cause: string): string {
  return `Paseo's ticket steward found that ${identifier} ${cause} (restart ${attempt} of ${RESTART_CAP}). Before anything else, run \`git status\` in your worktree: finish or abort an interrupted rebase, merge or cherry-pick, and then continue the lifecycle step this ticket is on. Do not start over.`;
}

export function resumeText(identifier: string, quietMinutes: number): string {
  return `Your ticket ${identifier} is still open and this agent recorded no progress for ${Math.round(quietMinutes)} minutes. Run \`git status\` in your worktree, check the current state of this ticket's pull requests, and continue the lifecycle step you were on (this message can arrive twice). If you are waiting for the owner, ask through a question request instead of waiting silently.`;
}

// The instruction a successor gets for a ticket whose open pull request nobody works on: the
// lifecycle step its recorded state names, or the general walk-through of all of them.
export function successorText(identifier: string, pull: StewardPullFacts): string {
  const work = "Work in this ticket's recorded worktree and continue the pull request's lifecycle step.";
  if (pull.decision === "CHANGES_REQUESTED") return `Nobody works on ${identifier}'s open pull request ${pull.url} and reviewers requested changes. ${work} Address every requested change, push, and reply to the reviewers.`;
  return `Nobody works on ${identifier}'s open pull request ${pull.url}. ${work} Read its current state (\`gh pr view ${pull.url}\`): publish it if it is a draft, fix failing checks, resolve a base conflict, address review comments or findings, and get it ready to merge.`;
}

export function replayText(identifier: string, pull: StewardPullFacts, worktree: string | null): string {
  return `[The pull request](${pull.url}) of ${identifier} was closed without merging and no open pull request carries its branch. Replay the remaining work: in ${worktree ? `\`${worktree}\`` : "the ticket's recorded worktree"}, on the top branch of the stack, replay the remaining branches onto main from the landed branch, push each replayed branch, open a new pull request onto main whose body links the old one, and let Graphite track it. It moves only your own branches; never \`gt sync\` or \`gt restack\`.`;
}

// The lettered options of an escalation, per situation: what the owner can do about it.
const ESCALATION_OPTIONS: Record<string, string[]> = {
  "queued-too-long": ["Free a slot (archive or stop an agent) and the ticket starts on the next pass.", "Start the ticket's agent from the Linear tickets sidebar yourself.", "Take the ticket out of this host's scope (remove its Paseo labels)."],
  "restart-exhausted": ["Fix what the starts fail on, then add the trigger label again.", "Start an agent for the ticket from the Linear tickets sidebar.", "Move the ticket to a state a start is possible in (Todo, Backlog or In Progress), or close it."],
  "watchdog-exhausted": ["Take the agent over yourself (resume it, or start a new one from the sidebar).", "Add the trigger label again for a fresh steward round.", "Close the ticket if the work is no longer needed."],
  "refused": ["Clear what refuses the start (the state, a hold label, the setup it fails on).", "Start the ticket's agent from the Linear tickets sidebar.", "Move the ticket back to Todo if it is in a state Paseo does not start work in."],
  "escalated": ["Decide what the ticket should do next and start its agent from the sidebar.", "Add the trigger label again for a fresh steward round.", "Close the ticket if the work is no longer needed."],
  "closed-unmerged": ["Tell the agent what to do with the closed pull request (start it from the sidebar).", "Close the ticket if its work landed elsewhere.", "Replace the pull request by hand."],
  "landed": ["Confirm that the landed work completes the ticket and close it.", "Send the ticket's agent back to work with what is missing (the verifier can park it for a blocker or a date instead).", "Move the ticket back to Todo with a blocker or a due date if it must wait."],
  "idle-unresponsive": ["Resume the agent yourself and tell it what to do next.", "Start a replacement agent from the Linear tickets sidebar.", "Close the ticket if its work is done."],
  "verifying": ["Answer the verifier's question and start the ticket's agent from the sidebar.", "Add the trigger label again for a fresh steward round.", "Close the ticket."],
};

function optionsFor(situation: StewardSituation): string[] {
  return ESCALATION_OPTIONS[situation] ?? ESCALATION_OPTIONS.escalated;
}

export function escalateBody(situation: StewardSituation, facts: StewardFacts, reason: string, options: string[]): string {
  const letters = options.map((option, index) => `${String.fromCharCode(97 + index)}) ${option}`).join("\n");
  return [
    `**Paseo's ticket steward cannot move this ticket on** (${situation}): ${reason}.`,
    "",
    `What it sees: ${facts.identifier} is ${facts.status}${facts.live ? ", an agent is working on it" : ", no agent is working on it"}; ${facts.openPulls.length} open pull request(s), ${facts.landedPulls.length} landed, ${facts.restarts} restart(s) and ${facts.refusals} refused start(s) in the last 24 hours.${facts.blocker ? ` It waits for ${facts.blocker}.` : ""}`,
    "",
    "Options:",
    letters,
    "",
    "Its automatic recovery stops here until one of them is taken; adding the trigger label again gives the steward a fresh budget.",
  ].join("\n");
}

// The fact sheet a verifier gets: the ticket, its sub-issues, its landed pull requests and what the
// last agent reported. It reads the rest itself and implements nothing.
export function verifierBrief(issue: StewardIssue, facts: StewardFacts, record: HandoverRecord | null): string {
  const summaries = (record?.summaries ?? []).slice(-3).map((summary) => `- ${summary.slice(0, 600)}`).join("\n");
  return [
    "You are a short-lived verifier started by Paseo's ticket steward. You implement nothing, change nothing and push nothing: read, judge, and record exactly one verdict.",
    "",
    `Ticket: ${issue.identifier} — ${issue.title} (${issue.status})`,
    issue.children.length ? `Sub-issues:\n${issue.children.map((child) => `- ${child.identifier}: ${child.status}`).join("\n")}` : "Sub-issues: none",
    facts.landedPulls.length ? `Landed pull requests:\n${facts.landedPulls.map((pull) => `- ${pull.url}`).join("\n")}` : "Landed pull requests: none",
    facts.openPulls.length ? `Open pull requests (none should be left behind):\n${facts.openPulls.map((pull) => `- ${pull.url}`).join("\n")}` : "",
    summaries ? `The last agent's own reports:\n${summaries}` : "",
    record?.plan ? `The ticket's plan: ${record.plan}` : "",
    "",
    "Verify the parent's acceptance criteria against each child's actual landed PR evidence, not merely terminal child statuses or merged PRs. Canceled or duplicate children are not successful delivery: identify their explicit scope disposition and prove the remaining parent acceptance criteria are satisfied before choosing close.",
    "Read the repository's delivery instructions and consult its existing deployment receipts/statuses. Where deployment or runtime verification is required, require proof for the landed SHA and each affected service/environment, plus the required runtime checks. A merged PR alone is not deployment proof. Never invent deployment evidence or assume a deployment source exists. Safe read-only runtime verification is allowed; implementation, deployment, fixes and other mutations are not.",
    "Check unresolved manual owner tasks and Needs-you questions, including after-merge tasks and checks still awaiting verification. Missing acceptance, child PR, deployment or runtime evidence must produce an actionable resume instruction, park with a real blocker/date, or ask_owner with concrete options; never close on missing evidence.",
    "Read the ticket and its comments (the linear_ticket tools get_ticket and get_comments), the plan document if there is one, and the landed pull requests (gh pr view and gh pr diff). Judge whether the ticket's work is complete against its description and acceptance criteria, then use the steward_verdict tool (omp shows it as linear_ticket_steward_verdict) exactly once with one verdict: close (nothing remains), resume with what the ticket's agent must still do, park with why it must wait (blockedBy names the ticket it waits for, dueDate when a date decides it), or ask_owner with the question and its options when only the owner can decide. Then stop.",
  ].filter(Boolean).join("\n");
}

// --- The pass -------------------------------------------------------------------------------------

export type StewardSnapshot = {
  enabled: boolean;
  active: boolean;
  lastPassAt: string | null;
  lastError: string | null;
  counts: Record<string, number>;
  tickets: { identifier: string; situation: StewardSituation; since: string; reason: string; nextAction: string | null; waitReason: string | null; nextCheckAt: string | null; responsibleGeneration: string | null; lastVerifiedAdvancementAt: string | null }[];
  control: { passStartedAt: string | null; overduePassMs: number; maxUnattendedMs: number; recoveryOutcomes: Record<string, number> };
  oldest: { identifier: string; situation: StewardSituation; since: string }[];
};
export type ResponsibilityView = { nextAction: string | null; waitReason: string | null; nextCheckAt: string | null; responsibleGeneration: string | null; lastVerifiedAdvancementAt: string | null };
export type StewardFlowEntry = { state: StewardSituation; since: string; reason: string } & ResponsibilityView;

function responsibilityView(ticket: StewardTicket): ResponsibilityView {
  return {
    nextAction: ticket.responsibility?.nextAction ?? null,
    waitReason: ticket.responsibility?.waitReason ?? null,
    nextCheckAt: ticket.responsibility?.nextCheckAt ?? null,
    responsibleGeneration: ticket.responsibility?.generation ?? null,
    lastVerifiedAdvancementAt: ticket.responsibility?.lastVerifiedAdvancementAt ?? null,
  };
}

// `roots`: the ticket's agent snapshot from the pass's one registry read. Classification already
// decides on it; recording the responsibility uses the same agents instead of listing the registry
// again for every ticket of the pass.
type Candidate = { issue: StewardIssue; facts: StewardFacts; situation: StewardSituation; ticket: StewardTicket; check: ResponsibilityTicket; roots: WatchedAgent[] };
type Pass = { actions: number; cap: number };
// What one action came to: `done` (the effect went out), `deferred` (nothing was attempted —
// admission waits; the ticket stays queued and the pass retries, no budget spent), `failed` (it did
// not run; `permanent`: the owner is asked at once rather than after REFUSAL_CAP refusals).
type StewardOutcome = { state: "done" | "failed" | "deferred"; reason: string; permanent?: boolean };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasLabel(labels: { name: string }[], name: string): boolean {
  return labels.some((label) => label.name.trim().toLowerCase() === name.toLowerCase());
}

// The deliberate waits that make the owner (or the peer host) responsible for the next step, for
// the responsibility check; a plan review, a pending permission and a Needs-you item are review
// steps or questions it reads on their own.
const OWNER_HOLDS: Record<StewardDeliberate, boolean> = {
  hold: true, manual: true, "do-not-merge": true, stopped: true, remote: true, focus: true,
  "needs-you": false, "plan-review": false, permissions: false,
};

// The steward's latest claim or logged action on a ticket (ms), if any.
function stewardActionAt(ticket: StewardTicket | null): number | null {
  const stamps = [ticket?.claim?.at, ticket?.log.at(-1)?.at].map((at) => (at ? Date.parse(at) : NaN)).filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

function recent(at: string[], now: number): string[] {
  return at.filter((entry) => {
    const parsed = Date.parse(entry);
    return Number.isFinite(parsed) && now - parsed < STEWARD_WINDOW_MS;
  });
}

// The state a replacement agent may start in: Triage, Backlog, Todo, a plan stage or In Progress.
function restartable(status: string, statusType: string): boolean {
  const type = statusType.trim().toLowerCase();
  return RESTART_TYPES.has(type) || Boolean(planStage(status, type)) || (type === "started" && RESTART_STARTED_STATES.has(status.trim().toLowerCase()));
}

// A blocker that is not finished (linear.ts finishedIssue).
export function finishedBlocker(blocker: { statusType: string; merged: boolean }): boolean {
  const type = blocker.statusType.trim().toLowerCase();
  if (type === "completed" || type === "canceled" || type === "duplicate") return true;
  return type === "started" && blocker.merged;
}

// Whether a verifier's park still waits: its named blocker is on the ticket and unfinished, or
// its due date has not arrived. A park whose gates are both gone — the blocker finished, the
// relation was removed, the date passed — is no wait any more: the ticket is recovered like any
// other, and the owner's own retry clears the record outright (steward.ts `ownerRetried`).
export function parkStillWaits(parked: StewardParked, issue: StewardIssue, now: number): boolean {
  const blocker = parked.blockedBy ? issue.blockers.find((entry) => entry.identifier === parked.blockedBy) ?? null : null;
  const blockerWaits = blocker !== null && !finishedBlocker(blocker);
  const dateWaits = Boolean(parked.dueDate) && Date.parse(`${parked.dueDate}T00:00:00.000Z`) > now;
  return blockerWaits || dateWaits;
}

const short = (id: string) => id.slice(0, 8);

// The agent of the ticket's verifier generation, when its launch returned one: the agent a verdict
// must never mistake for an implementation agent (and never archive twice).
function verifierIdOf(candidate: Candidate): string | null {
  return candidate.ticket.verifier?.agentId ?? null;
}

export class Steward {
  private revoked = false;
  private lastPoll = 0;
  private readonly logged = new Map<string, string>();
  private paseo: PaseoApi | null = null;
  private lastPassAt: string | null = null;
  private lastError: string | null = null;
  private enabled = true;
  private running = false;
  private passStartedAt: string | null = null;
  private readonly host = hostname();

  constructor(private readonly deps: StewardDeps) {}

  stop(): void {
    this.revoked = true;
  }

  private alive(): boolean {
    return !this.revoked;
  }

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private iso(at = this.clock()): string {
    return new Date(at).toISOString();
  }

  // A condition logged once until it changes, so a two-minute pass does not flood the log.
  private once(key: string, text: string): void {
    if (this.logged.get(key) === text) return;
    this.logged.set(key, text);
    console.log(`[linear-tickets] ${text}`);
  }

  // The owner started or continued the ticket (the trigger label, the sidebar): the restarts spent,
  // the refusals and the escalation of the current situation are forgotten, so a later failure is a
  // new round with a fresh budget (label-repair.ts ownerRetried, unchanged), and a verifier's park
  // is over — the owner's own continuation ends the wait the park recorded. Throws when the record
  // could not be written: the caller then starts nothing.
  async ownerRetried(issue: string): Promise<void> {
    await this.deps.store.update((file) => {
      const id = Object.keys(file.tickets).find((key) => key === issue || file.tickets[key].identifier === issue);
      if (!id) return null;
      const ticket = file.tickets[id];
      ticket.recoveryOutcomes ??= {};
      ticket.recoveryOutcomes["owner-retry"] = (ticket.recoveryOutcomes["owner-retry"] ?? 0) + 1;
      file.tickets[id] = { ...ticket, restarts: [], refusals: [], resumedAt: null, escalated: null, verified: null, parked: null, diagnosticRequested: null, diagnostics: [], continuation: ticket.continuation && ["queued", "sent", "unknown"].includes(ticket.continuation.status) ? ticket.continuation : null, ownerAt: this.iso() };
      console.log(`[linear-tickets] ${ticket.identifier}: started again by the owner; the steward's budgets begin anew`);
    });
  }

  // Called only inside SessionRouter's owned resume turn, immediately before dispatch. This
  // authorizes implementation, not closure: no acceptance, landed-stack or child-terminal test.
  async parentResumeWait(issueId: string): Promise<string | null> {
    if (!this.alive()) return "the steward is stopped";
    const settings = await this.deps.settings.read();
    if (!settings.steward.enabled) return "the steward is disabled";
    if (await this.deps.deletions?.blocked(issueId)) return "the ticket is paused for deletion";
    if (await this.deps.owner(issueId) !== "here") return "the parent is not owned by this host";
    const names = { ...dispatchLabels(settings.dispatch.label), trigger: settings.dispatch.label };
    const appIds = await this.deps.linear.trustedAppIds();
    const issue = (await this.deps.linear.stewardIssues({ teamKeys: settings.dispatch.teamKeys, labels: Object.values(names), appIds, ids: [issueId] })).find((entry) => entry.id === issueId);
    if (!issue) return "the parent cannot be read";
    const fresh = await this.completeParentIssue(issue);
    if (CLOSED_TYPES.includes(fresh.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number])) return `the parent is ${fresh.status}`;
    const parent = await this.deps.sessions.parentProgress(issueId);
    if (parent?.phase === "paused" || parent?.phase === "closed") return `parent orchestration is ${parent.phase}: ${parent.nextAction}`;
    if (parent?.delegated && (!fresh.delegateId || !appIds.includes(fresh.delegateId))) return "Paseo is no longer delegated to the parent";
    const authority = await this.ownerAuthorityFence(fresh, names, parent, true);
    if (authority) return authority;
    const tasks = await this.ownerCompletionFence(fresh);
    if (tasks) return tasks;
    const record = (await this.deps.handover.all()).find((entry) => entry.issueId === issueId) ?? null;
    if (record?.waiting) {
      const [roots, handed] = await Promise.all([this.deps.sessions.watchdogRoots(), this.deps.watchdog.handedOver()]);
      const group = roots.get(issueId);
      const live = group?.roots.filter((agent) => LIVE_AGENT[agent.status] && !group.ghosts.has(agent.id)) ?? [];
      if (await this.waitState(fresh, record.waiting, live, { handed, record, roots }, this.clock()) === "live") return "the parent waits for the owner";
    }
    return null;
  }

  // Whether a steward effect is under way for the ticket (a claimed action, a verifier): the
  // project hand-out leaves it alone, so no second start races the steward's.
  async underway(issueId: string): Promise<boolean> {
    const ticket = (await this.deps.store.read()).tickets[issueId];
    if (!ticket) return false;
    if (ticket.claim?.state === "claimed" && this.clock() - Date.parse(ticket.claim.at) < CLAIM_GRACE_MS) return true;
    return Boolean(ticket.verifier || (ticket.diagnostic && ticket.diagnostic.state !== "done") || (ticket.continuation && ["queued", "unknown"].includes(ticket.continuation.status)));
  }

  // The flow view for the status RPC and the browser inbox: the counts of the last pass, the
  // oldest tickets of each state, and each tracked ticket's situation.
  async snapshot(): Promise<StewardSnapshot> {
    const file = await this.deps.store.read();
    const now = this.clock();
    const recoveryOutcomes: Record<string, number> = {};
    let maxUnattendedMs = 0;
    for (const ticket of Object.values(file.tickets)) {
      if (ticket.situation !== "closed" && ticket.responsibility) maxUnattendedMs = Math.max(maxUnattendedMs, now - Date.parse(ticket.responsibility.nextCheckAt));
      for (const [outcome, count] of Object.entries(ticket.recoveryOutcomes ?? {})) recoveryOutcomes[outcome] = (recoveryOutcomes[outcome] ?? 0) + count;
    }
    return {
      enabled: this.enabled,
      active: Boolean(this.paseo),
      lastPassAt: this.lastPassAt,
      lastError: this.lastError,
      counts: file.flow?.counts ?? {},
      tickets: Object.values(file.tickets).map((ticket) => ({ identifier: ticket.identifier, situation: ticket.situation, since: ticket.since, reason: ticket.log.at(-1)?.action ?? "", ...responsibilityView(ticket) })),
      control: { passStartedAt: this.passStartedAt, overduePassMs: Math.max(0, now - Date.parse(this.lastPassAt ?? file.flow?.at ?? this.passStartedAt ?? this.iso()) - CONTROL_CHECK_MS), maxUnattendedMs, recoveryOutcomes },
      oldest: file.flow?.oldest ?? [],
    };
  }

  // The flow of the given tickets, for the browser inbox's detail pane.
  async flowFor(issueIds: string[]): Promise<Map<string, StewardFlowEntry>> {
    const file = await this.deps.store.read();
    const result = new Map<string, StewardFlowEntry>();
    for (const issueId of issueIds) {
      const ticket = file.tickets[issueId];
      if (ticket) result.set(issueId, { state: ticket.situation, since: ticket.since, reason: ticket.log.at(-1)?.action ?? "", ...responsibilityView(ticket) });
    }
    return result;
  }

  // One pass, at the cadence of the dispatch poll it runs in (self-throttled to STEWARD_POLL_MS).
  // Background priority: every read and write stops at its pool's reserve; a rate limit ends the
  // pass and the next one continues.
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.revoked || this.running || this.clock() - this.lastPoll < STEWARD_POLL_MS) return;
    this.paseo = paseo;
    this.running = true;
    this.lastPoll = this.clock();
    this.passStartedAt = this.iso();
    try {
      await withPriority("background", "steward", () => this.pass(paseo, settings, {}));
      this.lastPassAt = this.iso();
      this.lastError = null;
    } catch (error) {
      this.lastError = message(error);
      this.once("pass", `the steward pass failed: ${this.lastError}; the next pass retries`);
    } finally { this.running = false; }
  }

  // The paused-poll exception (README, "Auto-dispatch"): while the background share is paused, a
  // queue blocker with a failed start is still retried, at interactive priority. One filtered read,
  // and only queue-blocker tickets are acted on.
  async tickQueueBlockers(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.revoked || this.running) return;
    this.running = true;
    this.paseo = paseo;
    await withPriority("interactive", "queue-blocker steward", async () => {
      try {
        await this.pass(paseo, settings, { queueBlockers: true });
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        this.once("blockers", `the queue-blocker steward pass failed: ${message(error)}; the next one retries`);
      }
    }).finally(() => { this.running = false; });
  }

  private async pass(paseo: PaseoApi, settings: PluginSettings, options: { queueBlockers?: boolean }): Promise<void> {
    const instance = randomUUID();
    if (!await takeLease(this.deps.store.path, instance)) return;
    try { await this.runPass(paseo, settings, options); }
    finally { await releaseLease(this.deps.store.path, instance); }
  }

  private async runPass(paseo: PaseoApi, settings: PluginSettings, options: { queueBlockers?: boolean }): Promise<void> {
    this.enabled = settings.steward.enabled;
    const store = this.deps.store;
    const file = await store.read();
    const now = this.clock();
    // The peer's claims decide which tickets are this host's to move; without the snapshot nothing
    // is acted on (label-repair.ts's rule, unchanged).
    if (!await this.deps.intake.claimsReady()) return;
    const names: DispatchLabels & { trigger: string } = { ...dispatchLabels(settings.dispatch.label), trigger: settings.dispatch.label };
    const labelNames = [names.trigger, names.running, names.failed, names.blocked, names.needsYou, names.manual, names.hold, names.attended, names.queued];
    const appIds = (await this.deps.linear.trustedAppIds().catch(() => [])).filter(Boolean);
    // The local inventory first: the reads below name the tickets no label or delegate filter
    // reaches — the root agents of finished tickets (a quiet one still holds a scheduler slot),
    // tickets known only through a handover record, the parents of Needs-you sub-issues, and
    // everything an earlier pass tracked — and they go into the batched Linear read, so the first
    // pass on an empty store manages them too.
    const [roots, records, watchdog, needsYou, handed, parents] = await Promise.all([
      this.deps.sessions.watchdogRoots(),
      this.deps.handover.all(),
      this.deps.watchdog.read().catch(() => null),
      this.deps.needsYou.all().catch(() => [] as { id: string; parentId: string }[]),
      this.deps.watchdog.handedOver().catch(() => new Map<string, string>()),
      this.deps.sessions.parentProgresses(),
    ]);
    const recordOf = new Map(records.map((record) => [record.issueId, record]));
    const parentOf = new Map(parents.map((parent) => [parent.issueId, parent]));
    const inventory = new Set<string>([...Object.keys(file.tickets), ...records.map((record) => record.issueId), ...roots.keys(), ...needsYou.map((entry) => entry.parentId), ...parentOf.keys()]);
    const all = await this.deps.linear.stewardIssues({ teamKeys: settings.dispatch.teamKeys, labels: labelNames, appIds, ids: [...inventory], queueBlockers: options.queueBlockers === true });
    // The owner-wait state is not a label. A ticket an agent's status call or the owner left there
    // (or whose wait record its dead agent took with it) carries no dispatch label, no record and no
    // root, so none of the reads above returns it -- and every consumer of the state needs a record
    // that does not exist. Read the configured teams' Needs-input tickets by state so the pass can
    // judge them: a state nothing live backs is a defect it clears (classifyTicket, "wait-stale").
    const waitingStates = settings.steward.enabled && options.queueBlockers !== true
      ? await this.deps.linear.stewardIssues({ teamKeys: settings.dispatch.teamKeys, labels: [], appIds: [], ids: [], states: [NEEDS_INPUT_STATE] })
      : [];
    const reachable = new Map(all.map((issue) => [issue.id, issue]));
    for (const issue of waitingStates) if (!reachable.has(issue.id)) reachable.set(issue.id, issue);
    const teams = new Set(settings.dispatch.teamKeys.map((key) => key.trim().toLowerCase()).filter(Boolean));
    const inTeam = (issue: StewardIssue) => teams.has(issue.teamKey.trim().toLowerCase());
    const issues = options.queueBlockers ? all.filter((issue) => inTeam(issue) && hasLabel(issue.labels, names.failed)) : [...reachable.values()];
    if (options.queueBlockers && !issues.length) return;
    const inScope = issues.filter((issue) => (options.queueBlockers ? true : (inTeam(issue) && parentOf.has(issue.id)) || this.inScope(issue, names, settings.dispatch.teamKeys, appIds, recordOf, roots, file.tickets)));
    const pulls = await this.deps.pulls([...new Set(inScope.flatMap((issue) => pullUrls(issue, recordOf.get(issue.id))))]);
    const candidates: Candidate[] = [];
    for (const issue of inScope) {
      if (!this.alive()) return;
      if (await this.deps.owner(issue.id).catch(() => "unknown" as HostOwnership) !== "here") continue;
      const ticket = file.tickets[issue.id] ?? null;
      const { facts, check } = await this.facts(issue, paseo, { names, roots, record: recordOf.get(issue.id) ?? null, parent: parentOf.get(issue.id) ?? null, watchdog, needsYou, handed, pulls, now, ticket, settings });
      candidates.push({ issue, facts, situation: classifyTicket(facts), ticket: ticket ?? newTicket(issue.identifier, this.iso(now)), check, roots: roots.get(issue.id)?.roots ?? [] });
    }
    // The responsibility check (README, "Responsibility check"), every ten minutes on this host's
    // own tickets: before this pass's effects, so a repair it makes is what the next pass reads.
    const responsibility = this.deps.responsibility;
    if (responsibility && !options.queueBlockers && responsibility.due(now) && this.alive()) {
      try {
        await responsibility.run({ tickets: candidates.map((candidate) => candidate.check), enabled: settings.steward.enabled, fence: (issueId, identifier) => this.repairFence(settings, names, paseo, issueId, identifier), paseo });
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        console.error(`[linear-tickets] the responsibility check failed: ${message(error)}; it runs again in ten minutes`);
      }
    }
    // The `<trigger>-running` labels an archive still owes: settled from the pass's own agent
    // reading, before this pass's effects add new debt.
    await this.settleLabels(paseo, names, roots);
    const pass: Pass = { actions: 0, cap: settings.steward.maxActionsPerPass };
    for (const candidate of candidates) {
      if (!this.alive()) return;
      try {
        await this.ticket(paseo, settings, names, candidate, pass, now);
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        console.error(`[linear-tickets] ${candidate.issue.identifier}: the steward failed: ${message(error)}; the next pass retries`);
      }
    }
    if (options.queueBlockers) return;
    // The flow view (the counts of this pass and the oldest tickets of each state) for the browser
    // inbox and the status RPC.
    await this.flowView(candidates);
  }

  // Whether a ticket is inside the steward's scope: open, of a *configured* dispatch team, and
  // Paseo is involved — delegated to a Paseo app, carrying a Paseo label, with a handover record, a
  // root agent, a sub-issue or parent of one, or tracked by an earlier pass. Tickets of humans with
  // no Paseo involvement are out of scope, and so is every ticket of a team that is not configured:
  // a ticket moved out of the dispatch teams (or a team removed from the settings, or an empty
  // list) is never moved by this steward again, however the inventory reached it.
  private inScope(issue: StewardIssue, names: DispatchLabels & { trigger: string }, teamKeys: string[], appIds: string[], records: Map<string, HandoverRecord>, roots: Map<string, TicketRoots>, stored: Record<string, StewardTicket>): boolean {
    const teams = new Set(teamKeys.map((key) => key.trim().toLowerCase()).filter(Boolean));
    if (!teams.size || !teams.has(issue.teamKey.trim().toLowerCase())) return false;
    const terminal = CLOSED_TYPES.includes(issue.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number]);
    if (terminal && !stored[issue.id] && !records.has(issue.id) && !roots.has(issue.id)) return false;
    if (issue.delegateId && appIds.includes(issue.delegateId)) return true;
    if ([names.trigger, names.running, names.failed, names.blocked, names.needsYou, names.manual, names.hold, names.attended, names.queued].some((name) => hasLabel(issue.labels, name))) return true;
    if (records.has(issue.id) || stored[issue.id] || roots.has(issue.id)) return true;
    return Boolean(issue.parentId && (records.has(issue.parentId) || stored[issue.parentId] || roots.has(issue.parentId)));
  }

  // Everything the classifier decides on, from the pass's reads.
  private async facts(issue: StewardIssue, paseo: PaseoApi, input: {
    names: DispatchLabels & { trigger: string };
    roots: Map<string, TicketRoots>;
    record: HandoverRecord | null;
    parent: ParentProgress | null;
    watchdog: WatchdogFile | null;
    needsYou: { id: string; parentId: string }[];
    handed: Map<string, string>;
    pulls: Map<string, PullState>;
    now: number;
    ticket: StewardTicket | null;
    settings: PluginSettings;
  }): Promise<{ facts: StewardFacts; check: ResponsibilityTicket }> {
    const { names, record, parent, now } = input;
    const terminal = CLOSED_TYPES.includes(issue.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number]);
    const group = input.roots.get(issue.id) ?? null;
    const roots = group?.roots ?? [];
    const liveRoots = roots.filter((agent) => LIVE_AGENT[agent.status] && !group!.ghosts.has(agent.id));
    const live = liveRoots.length > 0;
    const idle = live ? idleMinutesOf(liveRoots, now) : null;
    const openChildren = issue.children.filter((child) => !CLOSED_TYPES.includes(child.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number]));
    const blocker = issue.blockers.find((candidate) => !finishedBlocker(candidate))?.identifier ?? null;
    const pullFacts: StewardPullFacts[] = pullUrls(issue, record ?? undefined).map((url) => {
      const state = input.pulls.get(url);
      return { url, merged: state?.merged === true, closed: state?.closed === true, missing: state?.missing === true, decision: state?.decision ?? null, replay: state?.replay ?? null, headSha: state?.headSha ?? null, ci: state?.ci ?? null };
    });
    const openPulls = pullFacts.filter((pull) => !pull.merged && !pull.closed && !pull.missing);
    const landedPulls = pullFacts.filter((pull) => pull.merged);
    const closedPulls = pullFacts.filter((pull) => pull.closed && !pull.merged);
    // An unreadable task list counts as one open task: the merge stays held rather than verified
    // away (the old pr-watch gate's unknown handling).
    const beforeMerge = landedPulls.length ? await this.deps.manualTasks.openBlockers(issue.id).then((tasks) => tasks.length).catch(() => 1) : 0;
    const waiting = record?.waiting ?? null;
    const ownerWait = waiting ? await this.waitState(issue, waiting, liveRoots, input, now) : "none";
    const thread = await this.deps.sessions.watchdogThread(issue.id).catch(() => null);
    // A durable parent's responsibility outlives its UI link. Only a live link may supply UI
    // waits; persisted parked plans, watchdog holds and current host ownership remain authoritative.
    const activeThread = parent && thread?.closed ? null : thread;
    const queuedThread = Boolean(activeThread?.queued) || await this.deps.sessions.threadQueued(issue.id).catch(() => false);
    const planned = (await this.deps.planned?.has(issue.id).catch(() => false)) === true;
    const focused = Boolean(await this.deps.focus?.admits(issue.id, paseo).catch(() => null));
    const cycle = input.watchdog?.tickets[issue.id] ?? null;
    const stripAnchor = (record?.agentId ?? "").startsWith(STEWARD_WAIT_ANCHOR);
    const started = Boolean(record && record.agentId && !stripAnchor) || roots.length > 0 || pullFacts.length > 0;
    const permissions = live && liveRoots.some((agent) => (agent.pendingPermissions?.length ?? 0) > 0);
    const offer = activeThread?.offer && ["split", "later", "parked"].includes(activeThread.offer) ? activeThread.offer : null;
    // The deliberate waits, strongest first: the owner's own veto or step, the plan under review,
    // the watchdog's owner Stop, the peer host, an unanswered question, a Needs-you item, focus.
    const owned: StewardDeliberate | null =
      hasLabel(issue.labels, names.hold) ? "hold"
        : hasLabel(issue.labels, names.manual) ? "manual"
          : hasLabel(issue.labels, DO_NOT_MERGE) ? "do-not-merge"
            : planStage(issue.status, issue.statusType) === PLAN_REVIEW_STATE || Boolean(activeThread?.review) || planned || offer ? "plan-review"
              : input.watchdog?.holds[issue.id] ? "stopped"
                : activeThread?.remote ? "remote"
                  : permissions ? "permissions"
                    : input.needsYou.some((entry) => entry.id === issue.id || entry.parentId === issue.id) ? "needs-you"
                      : focused ? "focus"
                        : null;
    // A Planning ticket whose review the responsibility check is restoring (README, "Responsibility
    // check"): a plan under review, not a stalled planner to restart, for at most the hold's hour.
    const held = !owned && this.enabled && planStage(issue.status, issue.statusType) === PLANNING_STATE && !live && !planned && !blocker && !waiting && !queuedThread && !input.ticket?.queued
      && await this.deps.responsibility?.holds({ id: issue.id, identifier: issue.identifier }).catch(() => false) === true;
    const deliberate: StewardDeliberate | null = owned ?? (held ? "plan-review" : null);
    const storedPark = input.ticket?.parked ?? null;
    const parked = storedPark !== null && parkStillWaits(storedPark, issue, now);
    const queuedAt = input.ticket?.queued?.at ?? null;
    const resumedAt = input.ticket?.resumedAt ? Date.parse(input.ticket.resumedAt) : NaN;
    // The silence began at the live roots' latest activity: a stamp, never a duration compared to
    // one — a later turn of the agent starts a new silence with its own resume.
    const silenceStart = live ? Math.max(...liveRoots.map((agent) => Date.parse(agent.updatedAt) || 0, now - (idle ?? 0) * 60_000)) : 0;
    // When the queue began: the steward's own admission deferral stamps it, a thread's wait is
    // aged by the situation it has been in.
    const queuedSince = input.ticket?.queued?.at ?? (input.ticket?.situation === "queued" || input.ticket?.situation === "queued-too-long" ? input.ticket.since : null);
    const queuedTooLong = Boolean((queuedThread || queuedAt) && queuedSince && now - Date.parse(queuedSince) >= input.settings.steward.queuedEscalateHours * 60 * 60_000);
    const facts: StewardFacts = {
      identifier: issue.identifier,
      status: issue.status,
      statusType: issue.statusType,
      terminal,
      children: parent
        ? { total: parent.children.length, open: parent.children.filter((child) => !child.finished).length, complete: parent.children.length > 0 || parent.phase === "verification" }
        : { total: issue.children.length, open: openChildren.length, complete: issue.childrenComplete },
      deliberate,
      parentPhase: parent?.phase ?? null,
      groupLinked: parent ? parent.phase === "children" || parent.phase === "verification" : Boolean(thread?.group && !thread.closed),
      parked,
      blocker,
      live,
      idleMinutes: idle,
      idleThreshold: input.settings.steward.idleMinutes,
      ownerWait,
      resumed: Number.isFinite(resumedAt) && resumedAt >= silenceStart,
      queuedThread,
      queuedAt,
      queuedSince,
      queuedTooLong,
      queuedHours: input.settings.steward.queuedEscalateHours,
      openPulls,
      landedPulls,
      closedPulls,
      beforeMerge,
      started,
      startable: !terminal && !deliberate && !input.ticket?.parked && restartable(issue.status, issue.statusType) && !blocker && !waiting && !queuedThread,
      restarts: recent(input.ticket?.restarts ?? [], now).length,
      refusals: (input.ticket?.refusals ?? []).filter((entry) => Number.isFinite(Date.parse(entry.at)) && now - Date.parse(entry.at) < STEWARD_WINDOW_MS).length,
      lastRefusal: input.ticket?.refusals?.at(-1)?.reason ?? null,
      watchdog: cycle?.cycle?.retiredAt ? "queued" : cycle?.cycle ? "active" : cycle?.exhausted ? "exhausted" : "none",
      verifier: Boolean(input.ticket?.verifier),
      verified: input.ticket?.verified ?? null,
      landedSignature: landedPulls.map((pull) => pull.url).sort().join(","),
      escalated: input.ticket?.escalated?.key ?? null,
    };
    const asked = ownerWait === "live" ? { agentId: record?.agentId ?? null }
      : activeThread?.questions ? { agentId: activeThread.agentId }
        : permissions ? { agentId: liveRoots.find((agent) => (agent.pendingPermissions?.length ?? 0) > 0)?.id ?? null }
          : input.needsYou.some((entry) => entry.parentId === issue.id) ? { agentId: null }
            : null;
    const check: ResponsibilityTicket = {
      issue: { id: issue.id, identifier: issue.identifier, status: issue.status, statusType: issue.statusType },
      ownerHold: blocker !== null || (owned !== null && OWNER_HOLDS[owned]),
      question: asked,
      liveRoots: liveRoots.filter((agent) => !agent.labels?.[STEWARD_VERIFIER_LABEL] && !agent.labels?.["paseo.parent-agent-id"]).map((agent) => agent.id),
      queued: queuedThread || Boolean(input.ticket?.queued),
      reviewThread: activeThread && (activeThread.review || offer) ? { agentId: activeThread.agentId } : null,
      stewardAt: stewardActionAt(input.ticket),
    };
    return { facts, check };
  }

  // A recorded wait for the owner: `live` while something can still end it, `stale` when nothing
  // can (writeback.ts reconcileWaiting, folded in here). A pending request on a live agent is
  // answerable; a live agent without one can still take its next turn (a `turn-end` wait stays);
  // with no live agent the wait is over unless it is minutes old (a daemon that just restarted
  // still lists its agents) or its ticket was handed to the peer host. A `decision` wait is the
  // steward's own escalation: only the owner's answer or retry ends it, never a liveness check.
  private async waitState(issue: StewardIssue, waiting: { kind?: string; at?: string }, liveRoots: WatchedAgent[], input: { handed: Map<string, string>; record: HandoverRecord | null; roots: Map<string, TicketRoots> }, now: number): Promise<"live" | "stale"> {
    if (waiting.kind === "decision") return "live";
    if (liveRoots.some((agent) => (agent.pendingPermissions?.length ?? 0) > 0)) return "live";
    if (liveRoots.length > 0) return waiting.kind === "request" ? "stale" : "live";
    const at = Date.parse(waiting.at ?? input.record?.updatedAt ?? "") || 0;
    if (now - at < WAIT_NO_AGENT_GRACE_MS) return "live";
    const newest = (input.roots.get(issue.id)?.roots ?? []).reduce((latest, agent) => Math.max(latest, Date.parse(agent.createdAt) || 0), 0);
    const handed = input.handed.get(issue.id);
    if (handed && newest <= (Date.parse(handed) || 0)) return "live";
    return "stale";
  }

  // One ticket: record its situation, then take its one action (if the cap allows it). A ticket
  // whose start admission deferred stays queued and retries the same action on every pass, without
  // spending a restart or a refusal; the recovery budgets are rolling 24-hour windows that only the
  // owner's own retry clears.
  private async ticket(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, pass: Pass, now: number): Promise<void> {
    const { issue, facts, situation } = candidate;
    const previous = candidate.ticket;
    // The situation's age: kept while it does not change, so the grace and the flow view can tell a
    // ticket that just got stuck from one that has been for hours.
    const since = previous.situation === situation ? previous.since : this.iso(now);
    const root = newestLiveRoot(candidate.roots);
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      ticket.situation = situation;
      ticket.since = since;
      ticket.at = this.iso(now);
      const old = ticket.responsibility;
      const stage = stageEvidence(issue, facts, old?.observedStage);
      const agentId = root?.id ?? old?.agentId ?? null;
      const changedOwner = !old || old.host !== this.host || old.agentId !== agentId;
      const advanced = Boolean(old && stageAdvanced(old.observedStage, stage));
      const nextAction = facts.deliberate ? `Recheck ${facts.deliberate}` : facts.blocker ? `Recheck blocker ${facts.blocker}` : facts.watchdog === "queued" ? "Recheck retired worker replacement admission" : ticket.diagnostic && ticket.diagnostic.state !== "done" ? "Read diagnostic verdict" : STEWARD_ACTION[situation] ?? "Verify stage advancement";
      ticket.responsibility = {
        generation: changedOwner ? randomUUID() : old.generation,
        generationAt: changedOwner ? this.iso(now) : old.generationAt ?? old.observedAt,
        agentId, host: this.host, nextAction,
        waitReason: facts.deliberate ?? facts.blocker ?? (facts.watchdog === "queued" ? "Retired implementation worker; replacement admission pending" : ticket.queued?.reason ?? null),
        nextCheckAt: this.iso(now + CONTROL_CHECK_MS),
        observedStage: stage, observedAt: old?.observedAt ?? this.iso(now),
        lastVerifiedAdvancementAt: advanced ? this.iso(now) : old?.lastVerifiedAdvancementAt ?? null,
      };
      if (advanced) {
        if (ticket.recoveryObservation && !ticket.recoveryObservation.advancedAt && Date.parse(ticket.recoveryObservation.at) <= now) {
          ticket.recoveryObservation.advancedAt = this.iso(now);
          ticket.recoveryOutcomes ??= {};
          ticket.recoveryOutcomes["advancement-after-recovery"] = (ticket.recoveryOutcomes["advancement-after-recovery"] ?? 0) + 1;
        }
        ticket.diagnosticRequested = null;
        // Advancement does not cancel the router's independently drained delivery operation.
        if (ticket.continuation && ["started", "cancelled"].includes(ticket.continuation.status)) ticket.continuation = null;
      }
      // A queue entry that no longer describes the ticket is dropped; the ticket moved on.
      if (ticket.queued && situation !== "queued") ticket.queued = null;
      // A park whose blocker finished or whose date arrived is over: the record goes, and the
      // ticket is classified and recovered like any other on this same pass.
      if (ticket.parked && !facts.parked) {
        ticket.log = [...ticket.log, { at: this.iso(now), action: "park ended: its blocker finished or its date arrived" }].slice(-LOG_LIMIT);
        ticket.parked = null;
      }
      if (ticket.claim?.state === "claimed" && this.clock() - Date.parse(ticket.claim.at) >= CLAIM_GRACE_MS) {
        ticket.claim = { ...ticket.claim, state: "failed", result: "outcome unknown after a restart" };
      }
    });
    const stored = (await this.deps.store.read()).tickets[issue.id];
    candidate.ticket = stored;
    if ((this.enabled || (stored.diagnostic && stored.diagnostic.state !== "done")) && await this.recovery(paseo, settings, names, candidate, pass, now)) return;
    // A claim whose outcome is unknown is never repeated blindly: the ticket waits for the grace.
    if (stored?.claim?.state === "claimed") {
      this.once(`claim:${issue.id}`, `${issue.identifier}: the steward's ${stored.claim.action} is claimed but has no outcome yet; it is not repeated`);
      return;
    }
    // A recovered ticket with a live root does not keep a stale `<t>-failed` of an earlier attempt.
    if (situation === "moving" && facts.live && hasLabel(issue.labels, names.failed)) await this.clearFailed(issue, names);
    const retry = situation === "queued" ? stored?.queued ?? null : null;
    if (retry) {
      if (!this.enabled) return;
      const retryCandidate: Candidate = { ...candidate, situation: retry.situation };
      if (!this.cap(pass, retryCandidate, retry.action)) return;
      console.log(`[linear-tickets] ${issue.identifier}: steward: its ${retry.action} waits in the queue (${retry.reason}); trying again`);
      await this.act(paseo, settings, names, retryCandidate, retry.situation, retry.action, now);
      return;
    }
    // A ticket already escalated for this reason waits for the owner, whatever its situation now is.
    const key = situation === "escalated" ? (stored?.escalated?.key ?? "escalated") : situation;
    const ownerNewer = Boolean(stored?.ownerAt && stored.escalated && Date.parse(stored.ownerAt) > Date.parse(stored.escalated.at));
    const escalated = Boolean(stored?.escalated && stored.escalated.key === key && !ownerNewer);
    const action = situation === "escalated" || escalated ? "escalate" : STEWARD_ACTION[situation];
    if (!action) {
      await this.verdict(paseo, settings, names, candidate, pass, now);
      return;
    }
    if (!this.enabled) return;
    // A defect is acted on after the grace, so a start or a thread that is about to move the ticket
    // is waited for; the invariant's five states need nothing.
    if (isDefect(situation) && situation !== "idle" && now - Date.parse(since) < DEFECT_GRACE_MS) return;
    if (escalated) {
      this.once(`escalated:${issue.id}`, `${issue.identifier}: the steward already asked the owner (${key}); it waits for their answer`);
      return;
    }
    if (!this.cap(pass, candidate, action)) return;
    await this.act(paseo, settings, names, candidate, situation, action, now);
  }

  private async requestDiagnosis(issue: { id: string; identifier: string }, reason: string): Promise<void> {
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso());
      ticket.diagnosticRequested ??= reason;
    });
  }

  private async recordContinuation(issueId: string, outcome: Continuation): Promise<void> {
    await this.deps.store.update((file) => {
      const ticket = file.tickets[issueId];
      if (!ticket?.continuation) return;
      ticket.continuation.status = outcome.status;
      if (["sent", "started"].includes(outcome.status) && ticket.recoveryObservation?.key !== ticket.continuation.operationId) {
        ticket.recoveryObservation = { key: ticket.continuation.operationId, at: this.iso() };
      }
      if (ticket.responsibility) {
        ticket.responsibility.nextAction = outcome.status === "unknown" ? "Diagnose ambiguous continuation delivery" : "Verify continuation advancement";
        ticket.responsibility.waitReason = outcome.reason ?? `Continuation ${outcome.status}`;
        ticket.responsibility.nextCheckAt = this.iso(this.clock() + CONTROL_CHECK_MS);
      }
    });
  }

  // Diagnostics never take over the implementation handover. Every effect re-reads authority.
  private async diagnosticFence(paseo: PaseoApi, issue: StewardIssue, names: DispatchLabels, generation: string, inTurn = false): Promise<string | null> {
    if (!this.alive() || !(await this.deps.settings.read()).steward.enabled) return "Recovery control is stopped";
    if (await this.deps.owner(issue.id) !== "here") return "Another host owns recovery";
    if (await this.deps.deletions?.blocked(issue.id)) return "Ticket deletion is pending";
    const current = (await this.deps.store.read()).tickets[issue.id];
    if (current?.responsibility?.generation !== generation || current.responsibility.host !== this.host) return "Responsible generation changed";
    const appIds = await this.deps.linear.trustedAppIds();
    const settings = await this.deps.settings.read();
    const fresh = (await this.deps.linear.stewardIssues({ teamKeys: settings.dispatch.teamKeys, labels: Object.values(names), appIds, ids: [issue.id] })).find((entry) => entry.id === issue.id);
    if (!fresh) return "Current ticket evidence is unavailable";
    if (CLOSED_TYPES.includes(fresh.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number])) return "Ticket is terminal";
    const parent = await this.deps.sessions.parentProgress(issue.id);
    if (parent?.phase === "paused" || parent?.phase === "closed") return "Parent responsibility is paused";
    const authority = await this.ownerAuthorityFence(fresh, names, parent, inTurn);
    if (authority) return authority;
    const roots = (await this.deps.sessions.watchdogRoots()).get(issue.id)?.roots ?? [];
    if (roots.some((agent) => agent.pendingPermissions?.length)) return "An implementation agent waits for permission";
    if (roots.filter((agent) => LIVE_AGENT[agent.status]).some((agent) => agent.id !== current.responsibility?.agentId)) return "Implementation ownership changed";
    const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id);
    if (record?.waiting) return "The ticket waits for the owner";
    if ((await this.deps.needsYou.allStrict()).some((entry) => entry.parentId === issue.id)) return "A Needs-you decision is open";
    if (!this.deps.recoveryWait) return "The recovery PR authority reader is unavailable";
    return this.deps.recoveryWait(issue.id, issue.identifier, pullUrls(fresh, record));
  }

  private async diagnosticWait(issueId: string, reason: string, nextAction = "Recheck recovery authority", nextCheckAt = this.iso(this.clock() + CONTROL_CHECK_MS)): Promise<void> {
    await this.deps.store.update((file) => {
      const responsibility = file.tickets[issueId]?.responsibility;
      if (responsibility) Object.assign(responsibility, { waitReason: reason, nextAction, nextCheckAt });
    });
  }

  private async finishDiagnostic(paseo: PaseoApi, issueId: string, diagnostic: RecoveryDiagnostic, outcome: string): Promise<void> {
    const helperIds = diagnostic.agentId ? [diagnostic.agentId] : (await issueAgents(paseo, issueId)).filter((agent) => agent.labels?.[STEWARD_VERIFIER_LABEL] === diagnostic.marker).map((agent) => agent.id);
    // A timed-out create is not a cancelled create. Keep its original marker reserved until
    // an exact helper is discovered or the transport returns its identity, across reloads.
    if (!helperIds.length && (diagnostic.launchPending || diagnostic.state === "launching")) {
      await this.diagnosticWait(issueId, "Diagnostic create outcome unknown; original marker remains reserved", "Find and retire the original diagnostic helper");
      return;
    }
    for (const id of helperIds) {
      const helper = await paseo.agents.ref(id).refresh();
      if (helper && !helper.agent.archivedAt) {
        if (helper.agent.labels?.[STEWARD_VERIFIER_LABEL] !== diagnostic.marker) throw new Error("Diagnostic helper label changed; refusing archive");
        await paseo.agents.ref(id).archive();
      }
    }
    await this.deps.store.update((file) => {
      const ticket = file.tickets[issueId];
      if (ticket?.diagnostic?.marker !== diagnostic.marker || ticket.diagnostic.state === "done") return;
      ticket.diagnostic = { ...ticket.diagnostic, state: "done", outcome, finishedAt: this.iso() };
      ticket.diagnosticRequested = null;
      ticket.recoveryOutcomes ??= {};
      ticket.recoveryOutcomes[outcome] = (ticket.recoveryOutcomes[outcome] ?? 0) + 1;
      if (outcome === "replaced") ticket.recoveryObservation = { key: diagnostic.marker, at: this.iso() };
      ticket.log = [...ticket.log, { at: this.iso(), action: `diagnostic: ${outcome}` }].slice(-LOG_LIMIT);
    });
  }

  private async recovery(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, pass: Pass, now: number): Promise<boolean> {
    const { issue, facts, ticket } = candidate;
    const responsibility = ticket.responsibility!;
    let diagnostic = ticket.diagnostic;
    const blocked = facts.terminal || facts.deliberate || facts.ownerWait === "live" || facts.blocker || facts.parked;
    if (diagnostic && diagnostic.state !== "done" && responsibility.lastVerifiedAdvancementAt && Date.parse(responsibility.lastVerifiedAdvancementAt) > Date.parse(diagnostic.at)) {
      await this.finishDiagnostic(paseo, issue.id, diagnostic, "advanced");
      return true;
    }
    if (diagnostic && diagnostic.state !== "done" && (!this.enabled || blocked || diagnostic.generation !== responsibility.generation || diagnostic.host !== this.host)) {
      await this.finishDiagnostic(paseo, issue.id, diagnostic, "cancelled-authority");
      return true;
    }
    if (blocked || ticket.verifier) return false;
    if (ticket.continuation && ticket.continuation.status !== "cancelled") {
      const operation = ticket.continuation;
      const outcome = await this.deps.sessions.continueOperation({ issueId: issue.id, agentId: operation.agentId, operationId: operation.operationId, text: operation.text });
      await this.recordContinuation(issue.id, outcome);
      operation.status = outcome.status;
      if (outcome.status === "unknown" || (["queued", "sent"].includes(outcome.status) && now - Date.parse(operation.at) >= RECOVERY_REACTION_MS)) ticket.diagnosticRequested = `Continuation ${operation.operationId} remains ${outcome.status}; reconcile it, never replace its delivery identity`;
      else if (outcome.status !== "cancelled" && now - Date.parse(operation.at) < RECOVERY_REACTION_MS && (!diagnostic || diagnostic.state === "done")) return true;
    }
    if (diagnostic && diagnostic.state !== "done") {
      if (!diagnostic.agentId) {
        const helpers = (await issueAgents(paseo, issue.id)).filter((agent) => agent.labels?.[STEWARD_VERIFIER_LABEL] === diagnostic!.marker);
        if (helpers.length > 1) { await this.finishDiagnostic(paseo, issue.id, diagnostic, "duplicate-helper"); return true; }
        if (helpers.length === 1) {
          diagnostic = { ...diagnostic, agentId: helpers[0].id, launchPending: false, state: diagnostic.state === "launching" ? "running" : diagnostic.state };
          await this.deps.store.update((file) => { if (file.tickets[issue.id].diagnostic?.marker === diagnostic!.marker) file.tickets[issue.id].diagnostic = diagnostic; });
        }
      }
      const fence = await this.diagnosticFence(paseo, issue, names, diagnostic.generation);
      if (fence) {
        if (now >= Date.parse(diagnostic.deadline)) await this.finishDiagnostic(paseo, issue.id, diagnostic, "authority-wait");
        await this.diagnosticWait(issue.id, fence);
        return true;
      }
      if (diagnostic.state === "waiting") {
        if (diagnostic.waitUntil && now < Date.parse(diagnostic.waitUntil)) {
          await this.diagnosticWait(issue.id, diagnostic.reason, diagnostic.instruction ?? "Check diagnostic wait", diagnostic.waitUntil);
          return true;
        }
        await this.finishDiagnostic(paseo, issue.id, diagnostic, "wait-expired");
        await this.requestDiagnosis(issue, "The diagnostic's named wait expired without verified advancement");
        return true;
      }
      const read = this.deps.verdicts ?? ((issueId: string) => readVerdicts(join(paseoHome(), "linear-tickets", STEWARD_VERDICT_DIRECTORY, issueId)));
      const verdict = (await read(issue.id)).map(parseVerdict).find((entry): entry is StewardVerdict => entry !== null && entry.issueId === issue.id && entry.verifier === diagnostic!.marker && Date.parse(entry.at) >= Date.parse(diagnostic!.at) && Date.parse(entry.at) <= Math.min(now, Date.parse(diagnostic!.deadline)) && ["continue", "replace", "wait", "ask_owner"].includes(entry.verdict));
      if (!diagnostic.agentId && (diagnostic.launchPending || diagnostic.state === "launching") && now >= Date.parse(diagnostic.deadline)) {
        await this.diagnosticWait(issue.id, "Diagnostic create outcome unknown; do not repeat the launch", "Find the original diagnostic marker");
        if (now >= Date.parse(diagnostic.deadline) + RECOVERY_REACTION_MS) await this.escalate(candidate, "Read-only diagnostic launch and bounded reconciliation have no confirmed outcome. Its original marker stays reserved; another launch could duplicate it.");
        return true;
      }
      if (!verdict) {
        if (now < Date.parse(diagnostic.deadline)) { await this.diagnosticWait(issue.id, "Read-only diagnosis is running", "Read diagnostic verdict", diagnostic.deadline); return true; }
        await this.finishDiagnostic(paseo, issue.id, diagnostic, diagnostic.agentId ? "timeout" : "launch-unknown");
        await this.requestDiagnosis(issue, "Bounded diagnosis produced no usable verdict");
        return true;
      }
      const applyFence = await this.diagnosticFence(paseo, issue, names, diagnostic.generation);
      if (applyFence) { await this.diagnosticWait(issue.id, applyFence); return true; }
      if (diagnostic.dispatchedAt && verdict.verdict === "replace") {
        await this.finishDiagnostic(paseo, issue.id, diagnostic, "replacement-outcome-unknown");
        await this.requestDiagnosis(issue, "Replacement dispatch was claimed before a restart; never repeat blindly");
        return true;
      }
      if (verdict.verdict === "wait") {
        const until = verdict.nextCheckAt!;
        if (Date.parse(until) <= now) {
          await this.finishDiagnostic(paseo, issue.id, diagnostic, "wait-expired");
          await this.requestDiagnosis(issue, "The diagnostic wait deadline already passed");
          return true;
        }
        if (diagnostic.agentId) await this.archiveAgent(paseo, diagnostic.agentId);
        await this.deps.store.update((file) => { file.tickets[issue.id].diagnostic = { ...diagnostic!, state: "waiting", decision: "wait", reason: verdict.reason!, instruction: verdict.instruction!, waitUntil: until }; });
        await this.diagnosticWait(issue.id, verdict.reason!, verdict.instruction!, until);
        return true;
      }
      if (verdict.verdict === "ask_owner") {
        await this.escalate(candidate, verdict.question!, verdict.options ?? undefined);
        await this.finishDiagnostic(paseo, issue.id, diagnostic, "ask-owner");
        return true;
      }
      if (!this.cap(pass, candidate, verdict.verdict === "continue" ? "resume" : "succeed")) return true;
      if (verdict.verdict === "continue") {
        const root = await this.liveRoot(paseo, issue.id);
        if (!root || root.id !== responsibility.agentId) {
          await this.finishDiagnostic(paseo, issue.id, diagnostic, "continue-unavailable");
          await this.requestDiagnosis(issue, "Continuation cannot safely reach its responsible worker");
          return true;
        }
        if (ticket.continuation && ["queued", "sent", "unknown"].includes(ticket.continuation.status)) {
          // The pass reconciled this exact operation above. Neither a new diagnostic verdict
          // nor a transport acknowledgement authorizes another independently drained instruction.
          await this.finishDiagnostic(paseo, issue.id, diagnostic, `continue-existing-${ticket.continuation.status}`);
          await this.diagnosticWait(issue.id, `Continuation ${ticket.continuation.operationId} remains ${ticket.continuation.status}`, "Reconcile the existing continuation operation");
          return true;
        }
        const operation = { agentId: root.id, operationId: diagnostic.marker, text: verdict.instruction!, at: diagnostic.at, status: "queued" as const };
        await this.deps.store.update((file) => { file.tickets[issue.id].continuation = operation; });
        const result = await this.deps.sessions.continueOperation({ issueId: issue.id, ...operation });
        await this.recordContinuation(issue.id, result);
        await this.finishDiagnostic(paseo, issue.id, diagnostic, `continue-${result.status}`);
        return true;
      }
      // One corrective attempt per diagnosis, never a recovery-budget reset or a timed kill.
      const workers = (await classifyTicketAgents(paseo, issue.id, now, this.deps.inspect)).live.filter((agent) => !agent.labels?.[STEWARD_VERIFIER_LABEL] && !agent.labels?.["paseo.parent-agent-id"]);
      if (workers.length) {
        await this.finishDiagnostic(paseo, issue.id, diagnostic, "replace-live-worker");
        await this.requestDiagnosis(issue, "Replacement refused: an implementation worker is still live");
        return true;
      }
      const record = (await this.deps.handover.all()).find((entry) => entry.issueId === issue.id);
      if (!record?.branch) {
        await this.finishDiagnostic(paseo, issue.id, diagnostic, "replace-no-recorded-branch");
        await this.requestDiagnosis(issue, "Replacement requires the recorded branch; no new branch was created");
        return true;
      }
      await this.deps.store.update((file) => { file.tickets[issue.id].diagnostic = { ...diagnostic!, state: "applying", decision: "replace", dispatchedAt: this.iso() }; });
      const result = await this.deps.sessions.succeed(issue.id, issue.identifier, record.agentId, verdict.instruction!, async () => {
        const veto = await this.diagnosticFence(paseo, issue, names, diagnostic!.generation, true);
        if (veto) throw new Error(veto);
      });
      if ("agent" in result) await this.finishDiagnostic(paseo, issue.id, diagnostic, "replaced");
      else if (result.kind === "wait") {
        await this.deps.store.update((file) => { file.tickets[issue.id].diagnostic = { ...diagnostic!, state: "waiting", decision: "wait", reason: result.reason, instruction: "Recheck replacement admission and process absence", waitUntil: this.iso(now + RECOVERY_REACTION_MS) }; });
        await this.diagnosticWait(issue.id, result.reason, "Recheck replacement admission", this.iso(now + CONTROL_CHECK_MS));
      } else {
        await this.finishDiagnostic(paseo, issue.id, diagnostic, "replace-refused");
        await this.requestDiagnosis(issue, result.reason);
      }
      return true;
    }
    if (ticket.escalated && (!ticket.ownerAt || Date.parse(ticket.ownerAt) <= Date.parse(ticket.escalated.at))) return false;
    if (diagnostic?.finishedAt && (!ticket.diagnosticRequested || diagnostic.outcome?.startsWith("continue-existing-")) && now - Date.parse(diagnostic.finishedAt) < RECOVERY_REACTION_MS) {
      await this.diagnosticWait(issue.id, "Waiting for independently verified advancement after recovery", "Verify recovered stage", this.iso(Date.parse(diagnostic.finishedAt) + RECOVERY_REACTION_MS));
      return true;
    }
    const advancementAt = Math.max(Date.parse(responsibility.lastVerifiedAdvancementAt ?? responsibility.observedAt), Date.parse(responsibility.generationAt ?? responsibility.observedAt));
    const stageStuck = candidate.situation === "moving" && facts.watchdog !== "active" && now - advancementAt >= RECOVERY_REACTION_MS;
    const needsDiagnosis = ticket.diagnosticRequested || stageStuck || candidate.situation === "idle-unresponsive" || (STEWARD_ACTION[candidate.situation] === "escalate" && now - Date.parse(ticket.since) >= DEFECT_GRACE_MS);
    if (!needsDiagnosis) return false;
    const fence = await this.diagnosticFence(paseo, issue, names, responsibility.generation);
    if (fence) { await this.diagnosticWait(issue.id, fence); return true; }
    const starts = recentDiagnostics(ticket.diagnostics ?? [], now);
    if (starts.length >= DIAGNOSTIC_CAP) {
      await this.escalate(candidate, `Bounded read-only diagnosis exhausted (${DIAGNOSTIC_CAP} in 24 hours); latest outcome: ${diagnostic?.outcome ?? ticket.diagnosticRequested ?? "no safe advance"}`);
      return true;
    }
    if (!this.cap(pass, candidate, "verify")) return true;
    const gate = this.deps.launcher.gate(issue.id);
    if (!gate) { await this.diagnosticWait(issue.id, "A launch for this ticket is under way"); return true; }
    try {
      const current = (await this.deps.store.read()).tickets[issue.id];
      if (current.diagnostic && current.diagnostic.state !== "done") return true;
      const otherHelper = (await issueAgents(paseo, issue.id)).find((agent) => agent.labels?.["linear.coordination"] === "recovery-diagnostic");
      if (otherHelper) { await this.diagnosticWait(issue.id, `Diagnostic helper ${short(otherHelper.id)} still exists; no duplicate is launched`); return true; }
      if (!settings.agentLinearAccess) { await this.diagnosticWait(issue.id, "Diagnostic structured-verdict tooling is disabled"); return true; }
      const admission = await this.deps.starter.admission(issue.id, paseo, settings, undefined, { control: true });
      if (!admission.ok) { await this.diagnosticWait(issue.id, admission.reason, "Admit a bounded diagnostic"); return true; }
      const freshFence = await this.diagnosticFence(paseo, issue, names, responsibility.generation);
      if (freshFence) { await this.diagnosticWait(issue.id, freshFence); return true; }
      const record = (await this.deps.handover.all()).find((entry) => entry.issueId === issue.id) ?? null;
      const reason = ticket.diagnosticRequested ?? (stageStuck ? "No independently verified stage advancement for five minutes" : refusalReason(facts, candidate.situation));
      const marker = `diagnostic-${randomUUID()}`;
      const pending: RecoveryDiagnostic = { marker, generation: responsibility.generation, host: this.host, agentId: null, at: this.iso(), deadline: this.iso(this.clock() + DIAGNOSTIC_TIMEOUT_MS), reason, state: "launching", launchPending: true };
      await this.deps.store.update((file) => {
        file.tickets[issue.id].diagnostic = pending;
        file.tickets[issue.id].diagnostics = [...starts, pending.at];
        file.tickets[issue.id].diagnosticRequested = null;
      });
      let timer: NodeJS.Timeout | undefined;
      const launch = this.deps.starter.start(issue.id, paseo, settings, {
        retryHint: "Wait for the recorded diagnostic generation to reconcile",
        labels: { [STEWARD_VERIFIER_LABEL]: marker, "linear.coordination": "recovery-diagnostic", "paseo.parent-agent-id": responsibility.agentId ?? "steward-diagnostic" },
        verifier: {
          brief: diagnosticBrief(issue, facts, ticket, record, reason), marker,
          check: async () => {
            const claimed = (await this.deps.store.read()).tickets[issue.id]?.diagnostic;
            if (!claimed || claimed.marker !== marker || claimed.state === "done" || this.clock() >= Date.parse(claimed.deadline)) return "Diagnostic generation expired";
            return this.diagnosticFence(paseo, issue, names, responsibility.generation);
          },
        },
      }).then(async (started) => {
        const current = (await this.deps.store.read()).tickets[issue.id];
        const expired = !this.alive() || this.clock() >= Date.parse(pending.deadline) || current?.diagnostic?.marker !== marker || current.diagnostic.state === "done" || current.responsibility?.generation !== pending.generation;
        if (expired) {
          await this.finishDiagnostic(paseo, issue.id, { ...pending, agentId: started.agentId, launchPending: false }, "late-launch-retired");
          return;
        }
        await this.deps.store.update((file) => {
          if (file.tickets[issue.id].diagnostic?.marker === marker && file.tickets[issue.id].diagnostic?.state !== "done") file.tickets[issue.id].diagnostic = { ...pending, agentId: started.agentId, state: "running", launchPending: false };
        });
      }).catch(async (error: unknown) => {
        await this.diagnosticWait(issue.id, `Diagnostic launch outcome unknown: ${message(error)}`, "Find original diagnostic generation");
      });
      // Timeout releases this control pass, not the remote create. The durable marker remains
      // reserved and the late completion above retires only its exactly-labelled helper.
      try {
        await Promise.race([launch, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, Date.parse(pending.deadline) - this.clock()));
          timer.unref?.();
        })]);
      } finally { clearTimeout(timer); }
      void launch.catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: diagnostic reconciliation failed: ${message(error)}`));
      return true;
    } finally { gate.release(); }
  }

  // The per-pass action cap: starts, successors, resumes and verifiers wait for the next pass;
  // closes, archives and escalations are not capped (README, "Ticket steward").
  private cap(pass: Pass, candidate: Candidate, action: StewardAction): boolean {
    const heavy = action === "start" || action === "restart" || action === "succeed" || action === "resume" || action === "verify";
    if (heavy && pass.actions >= pass.cap) {
      this.once(`cap:${candidate.issue.identifier}`, `${candidate.issue.identifier}: the steward's per-pass action cap (${pass.cap}) is used up; its ${candidate.situation} waits for the next pass`);
      return false;
    }
    if (heavy) pass.actions++;
    return true;
  }

  // The one action of a ticket per pass, claimed before its effect.
  private async act(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, situation: StewardSituation, action: StewardAction, now: number): Promise<void> {
    const { issue } = candidate;
    const claim: StewardClaim = { action, marker: `${action}:${randomUUID().slice(0, 8)}`, at: this.iso(now), state: "claimed" };
    const written = await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      if (ticket.claim?.state === "claimed" && this.clock() - Date.parse(ticket.claim.at) < CLAIM_GRACE_MS) return false;
      ticket.claim = claim;
      return true;
    });
    if (!written) return;
    const settle = async (state: "done" | "failed" | "deferred", result?: string) => {
      await this.deps.store.update((file) => {
        const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
        ticket.claim = { ...claim, state, ...(result ? { result: result.slice(0, 500) } : {}) };
        if (state === "done" && (action === "restart" || action === "succeed")) ticket.recoveryObservation = { key: claim.marker, at: this.iso() };
        // A deferral is the ticket's queue entry (no budget was spent, the pass retries it); any
        // other outcome ends the entry.
        if (state === "deferred") ticket.queued = { situation, action, at: ticket.queued?.situation === situation ? ticket.queued.at : this.iso(now), reason: (result ?? "waiting for admission").slice(0, 300) };
        else if (ticket.queued?.situation === situation) ticket.queued = null;
        ticket.log = [...ticket.log, { at: this.iso(), action: `${action}: ${state}${result ? ` (${result.slice(0, 200)})` : ""}` }].slice(-LOG_LIMIT);
      });
    };
    try {
      switch (action) {
        case "restart":
        case "start": {
          const result = await this.restart(paseo, names, candidate, now);
          await settle(result.state, result.reason);
          if (result.permanent) await this.requestDiagnosis(issue, result.reason);
          return;
        }
        case "succeed": {
          const result = await this.succeed(names, candidate);
          await settle(result.state, result.reason);
          if (result.permanent) await this.requestDiagnosis(issue, result.reason);
          return;
        }
        case "resume": {
          const root = await this.liveRoot(paseo, issue.id);
          if (!root) return settle("failed", "the live agent is gone");
          const text = resumeText(issue.identifier, candidate.facts.idleMinutes ?? 0);
          await this.deps.store.update((file) => {
            file.tickets[issue.id].continuation = { agentId: root.id, operationId: claim.marker, text, at: this.iso(), status: "queued" };
          });
          const outcome = await this.deps.sessions.continueOperation({ issueId: issue.id, agentId: root.id, operationId: claim.marker, text });
          await this.recordContinuation(issue.id, outcome);
          if (outcome.status === "unknown") await this.requestDiagnosis(issue, "Continuation delivery is unknown; do not resend under a new operation id");
          if (outcome.status === "cancelled") return settle("failed", outcome.reason ?? "continuation cancelled by its authority gates");
          await this.deps.store.update((file) => {
            const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
            ticket.resumedAt = this.iso();
          });
          return settle("done", `continuation ${outcome.status} for ${short(root.id)}`);
        }
        case "verify": {
          const result = await this.verify(paseo, settings, candidate, now);
          await settle(result.state, result.reason);
          if (result.permanent) await this.requestDiagnosis(issue, result.reason);
          return;
        }
        case "archive": {
          const result = await this.archive(paseo, settings, names, candidate, now);
          return settle(result.state, result.reason);
        }
        case "clear-wait": {
          await this.deps.writeback.clearWait(issue.id, issue.identifier);
          return settle("done", "cleared the wait for the owner");
        }
        case "escalate": {
          await this.requestDiagnosis(issue, refusalReason(candidate.facts, situation));
          return settle("done", "bounded diagnosis requested");
        }
        default: {
          const never: never = action;
          throw new Error(`unknown steward action ${String(never)}`);
        }
      }
    } catch (error) {
      await settle("failed", message(error));
      throw error;
    }
  }

  // A restart (or a first start): the same path the label repair took, under the same gates — the
  // ticket's start gate, admission, the recorded branch. The attempt counts against the 24-hour
  // budget before it runs (a start that fails has still been tried) and is refunded only when
  // nothing was attempted because admission deferred it: a capacity or focus wait spends no budget
  // and stays queued. A start that went out never refunds anything, however quickly its agent
  // vanishes again.
  private async restart(paseo: PaseoApi, names: DispatchLabels & { trigger: string }, candidate: Candidate, now: number): Promise<StewardOutcome> {
    const { issue } = candidate;
    const attempt = candidate.facts.restarts + 1;
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      ticket.restarts = [...recent(ticket.restarts, now), this.iso(now)];
    });
    const cause = candidate.facts.started ? "has no agent working on it" : "is unblocked and in Paseo's scope, but no agent was ever started on it";
    console.log(`[linear-tickets] ${issue.identifier}: steward: ${cause}; restart ${attempt} of ${RESTART_CAP}`);
    const result: RestartResult = await this.deps.sessions.restartFor(issue.id, issue.identifier, {
      retryHint: `add the "${names.trigger}" label again`,
      lead: candidate.facts.started ? undefined : restartText(issue.identifier, attempt, cause),
      eligible: async () => {
        const agents = await classifyTicketAgents(paseo, issue.id, this.clock(), this.deps.inspect);
        const working = agents.live.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return working ? `an agent works on ${issue.identifier} again (agent ${short(working.id)} is ${working.status})` : null;
      },
    }).catch((error: unknown): RestartResult => ({ kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }));
    if (result.kind === "started" || result.kind === "live") {
      await this.clearFailed(issue, names);
      return { state: "done", reason: result.kind === "started" ? `started agent ${short(result.agentId)}` : "an agent works on it again", permanent: false };
    }
    if (result.kind === "forwarded") return { state: "done", reason: `handed to ${result.peer}`, permanent: false };
    if (result.kind === "skipped") return { state: "failed", reason: "the ticket is deleted or paused for deletion", permanent: true };
    if (result.kind === "deferred") {
      if (queueWait(result.reason)) {
        await this.unspend(issue, now);
        return { state: "deferred", reason: result.reason, permanent: false };
      }
      const count = await this.refused(issue, now, result.reason);
      return { state: "failed", reason: `the start is refused${count > 1 ? ` ${count} times` : ""}: ${result.reason}`, permanent: count >= REFUSAL_CAP };
    }
    const reason = message(result.error);
    const count = await this.refused(issue, now, reason);
    const permanent = /^No Paseo project is mapped|^No provider has been chosen|^Could not pick a base branch|^This ticket is paused/.test(reason) || count >= REFUSAL_CAP;
    console.error(`[linear-tickets] ${issue.identifier}: steward: restart ${attempt} of ${RESTART_CAP} failed: ${reason}`);
    return { state: "failed", reason: `restart ${attempt} failed: ${reason}`, permanent };
  }

  // The attempt a deferral refunds: nothing was attempted, so the rolling budget is untouched.
  private unspend(issue: StewardIssue, now: number): Promise<void> {
    const at = this.iso(now);
    return this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, at);
      ticket.restarts = ticket.restarts.filter((entry) => entry !== at);
    });
  }

  // One refusal of a start, counted within the window (null clears them after a start went out).
  private refused(issue: StewardIssue, now: number, reason: string | null): Promise<number> {
    return this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      const kept = ticket.refusals.filter((entry) => Number.isFinite(Date.parse(entry.at)) && now - Date.parse(entry.at) < STEWARD_WINDOW_MS);
      ticket.refusals = reason ? [...kept, { at: this.iso(now), reason: reason.slice(0, 300) }] : kept;
      return ticket.refusals.length;
    });
  }

  // A successor for a ticket whose pull request nobody works on: the open pull request's lifecycle
  // step, or the replay of a stack whose pull request was closed without merging. The message is
  // claimed by the session router right before its start, so a failed start is tried again. The
  // attempt counts against the same rolling budget as a restart (the classifier refuses the branch
  // when it is spent), and an admission wait refunds it and stays queued.
  private async succeed(names: DispatchLabels & { trigger: string }, candidate: Candidate): Promise<StewardOutcome> {
    const { issue, facts } = candidate;
    // The facts' open pull requests are what the watch last recorded. That is a claim, not a read:
    // a pull request the ticket only attaches is never refreshed by a poll, and one whose record
    // moved on keeps the state of its last read. TUC-1131 was re-dispatched four times over #3868,
    // which had closed when the branch below it landed. Read the claim fresh before spending a
    // start on it, record what it says (see pr-watch.ts `freshOpenPulls`) and continue only a pull
    // request that is still open: a stale claim retries nothing, the healed state classifies the
    // ticket next pass (a landing is verified, a closure is replayed).
    let pull: StewardPullFacts | null = null;
    if (facts.openPulls.length) {
      const recorded = facts.openPulls;
      const fresh = await this.deps.freshOpenPulls(recorded.map((entry) => entry.url)).catch((error: unknown) => {
        if (error instanceof RateLimitedError) throw error;
        return { open: [] as string[], unreadable: true };
      });
      pull = recorded.find((entry) => fresh.open.includes(entry.url)) ?? null;
      if (!pull) {
        return { state: "failed", reason: fresh.unreadable ? "the open pull requests cannot be read now" : "the open pull request it recorded has closed or landed since the watch read it; nothing is started on it", permanent: false };
      }
    }
    pull ??= facts.closedPulls[0] ?? null;
    if (!pull) return { state: "failed", reason: "no pull request to continue", permanent: true };
    const now = this.clock();
    const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id) ?? null;
    const open = facts.openPulls.some((entry) => entry.url === pull!.url);
    const lead = open ? successorText(issue.identifier, pull) : replayText(issue.identifier, pull, record?.worktreePath ?? null);
    const attempt = facts.restarts + 1;
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      ticket.restarts = [...recent(ticket.restarts, now), this.iso(now)];
    });
    // A closed pull request is replayed; an open one whose recorded checks fail is a CI repair. A
    // green open one is the ticket's plain continuation and carries no repair label.
    const repair = !open ? "replay" : recordedCiFails(pull.ci) ? "ci" : null;
    const result: Succession = await this.deps.sessions.succeed(issue.id, issue.identifier, record?.agentId ?? null, lead, async () => {
      console.log(`[linear-tickets] ${issue.identifier}: steward: successor ${attempt} of ${RESTART_CAP}`);
    }, repair).catch((error: unknown): Succession => ({ kind: "impossible", reason: message(error) }));
    if (result.kind === "wait" || result.kind === "impossible") {
      const reason = result.kind === "wait" ? `the successor waits: ${result.reason}` : `no successor can start: ${successionReason(result)}`;
      if (result.kind === "wait" && queueWait(result.reason)) {
        await this.unspend(issue, now);
        return { state: "deferred", reason: result.reason, permanent: false };
      }
      const count = await this.refused(issue, now, reason);
      return { state: "failed", reason, permanent: count >= REFUSAL_CAP || result.kind === "impossible" };
    }
    // The remaining member carries the agent (a live or started successor); narrow by shape, since
    // its discriminant is a two-value union TypeScript cannot split.
    if (!("agent" in result)) throw new Error("the successor result carries neither an agent nor a reason");
    await this.clearFailed(issue, names);
    return { state: "done", reason: result.kind === "started" ? `started a successor ${short(result.agent.id)}` : "a live agent takes the pull request over", permanent: false };
  }

  // The verifier for a landed stack: a short-lived cheap agent with the fact sheet, which records
  // exactly one verdict through its ticket tool. One verifier per ticket, claim-journaled. It takes
  // the same admission as any start — focus, parked plans, blockers, the scheduler's slot and RAM
  // lease, presence — so no verifier is ever started beside a full host or outside focus, and an
  // admission wait is a queue entry, not a refusal. A live idle root (the unresponsive case) is
  // handed over first; a stopped or error root is no work at all and never blocks the verifier.
  // The generation (marker) is persisted *before* the launch and carried as the verifier's own
  // agent label, so an interrupted launch is adopted by marker on the next pass: its verdict is
  // never lost to a reload between agent creation and the store write.
  private async verify(paseo: PaseoApi, settings: PluginSettings, candidate: Candidate, now: number): Promise<StewardOutcome> {
    let { issue } = candidate;
    const { facts } = candidate;
    const gate = this.deps.launcher.gate(issue.id);
    if (!gate) return { state: "deferred", reason: "a launch for this ticket is under way" };
    try {
      if (facts.parentPhase !== null || issue.children.length > 0) {
        const complete = await this.completeParentIssue(issue).catch(() => null);
        if (!complete) return { state: "deferred", reason: "Waiting for complete parent child and label evidence." };
        issue = complete;
        if (CLOSED_TYPES.includes(issue.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number])) return { state: "deferred", reason: "The parent is already terminal." };
        if (issue.children.some((child) => !CLOSED_TYPES.includes(child.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number]))) return { state: "deferred", reason: "Waiting for all children, including owner tasks, to reach terminal states." };
      }
      const agents = (await classifyTicketAgents(paseo, issue.id, now, this.deps.inspect)).live;
      const verified = (agent: { labels?: Record<string, string> | undefined }) => agent.labels?.[STEWARD_VERIFIER_LABEL] ?? null;
      // A generation is still pending only when its launch has not been confirmed yet; the
      // adoption that resolves it lives in `verdict`, where every pass reaches it.
      if (candidate.ticket.verifier && !candidate.ticket.verifier.agentId) return { state: "deferred", reason: "the verifier's launch is being confirmed" };
      const idle = agents
        .filter((agent) => verified(agent) === null && !agent.activeTurn && agent.status !== "running" && agent.status !== "initializing" && !(agent.pendingPermissions?.length))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const working = agents.filter((agent) => verified(agent) === null && !idle.includes(agent));
      if (working.length) return { state: "failed", reason: `an agent works on the ticket again (${short(working[0].id)})` };
      // The verifier reports through its ticket MCP server: without Linear access for agents it has
      // no steward_verdict tool, so it is started only when that is on.
      if (!settings.agentLinearAccess) return { state: "failed", reason: `the verifier cannot report a verdict: agent Linear access is off (${issue.identifier} keeps its verifier claim until it is on)`, permanent: true };
      const parentVerifier = issue.children.length > 0;
      const admission = await this.deps.starter.admission(issue.id, paseo, settings, undefined, parentVerifier ? { control: true } : undefined);
      if (!admission.ok) return { state: "deferred", reason: admission.reason };
      // Only now, with the tooling and the slot confirmed, is the ticket's silent root handed over:
      // a refused admission must not leave the ticket with no agent and no verifier (B2).
      for (const agent of idle) await this.archiveAgent(paseo, agent.id);
      const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id) ?? null;
      const marker = randomUUID();
      // The generation is durable before anything is created: a crash right after the launch
      // leaves an adoptable verifier, not an anonymous agent with an unreadable verdict.
      await this.deps.store.update((file) => {
        const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
        ticket.verifier = { agentId: null, marker, at: this.iso(now), children: issue.children.map((child) => child.id).sort() };
      });
      let started: { agentId: string };
      try {
        started = await this.deps.starter.start(issue.id, paseo, settings, {
          retryHint: "start the verifier again",
          resumeOnly: !parentVerifier && facts.parentPhase === null,
          labels: { [STEWARD_VERIFIER_LABEL]: marker, ...(parentVerifier ? { "linear.coordination": "parent-verification" } : {}) },
          verifier: { brief: verifierBrief(issue, facts, record), marker },
        });
      } catch (error) {
        // A repair held the ticket (or the plugin is restarting): the start refused before it
        // created anything, so the generation is dropped and the pass retries as an admission wait.
        if (error instanceof RepairBusyError) {
          await this.deps.store.update((file) => {
            const ticket = file.tickets[issue.id];
            if (ticket?.verifier?.marker === marker && !ticket.verifier.agentId) ticket.verifier = null;
          });
          return { state: "deferred", reason: error.message };
        }
        // The generation stays pending: the next pass adopts the agent if the launch created one
        // and drops the generation (with a refusal) if it did not.
        const reason = `the verifier could not start: ${message(error)}`;
        console.error(`[linear-tickets] ${issue.identifier}: steward: ${reason}`);
        return { state: "failed", reason };
      }
      await this.deps.store.update((file) => {
        const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
        if (ticket.verifier?.marker === marker) ticket.verifier = { ...ticket.verifier, agentId: started.agentId };
      });
      console.log(`[linear-tickets] ${issue.identifier}: steward: started verifier ${short(started.agentId)} for the landed stack`);
      return { state: "done", reason: `verifier ${short(started.agentId)}` };
    } catch (error) {
      // A verifier that cannot start is a refusal like any other start: after REFUSAL_CAP the owner
      // is asked instead of the pass trying the same broken start forever.
      const reason = `the verifier could not start: ${message(error)}`;
      const count = await this.refused(issue, now, reason);
      return { state: "failed", reason, permanent: count >= REFUSAL_CAP };
    } finally {
      gate.release();
    }
  }

  // issueGroup succeeds only after exhausting every child and child-label page; no partial
  // result is usable as verifier evidence. Classification uses the once-per-pass durable snapshot.
  private async completeParentIssue(issue: StewardIssue): Promise<StewardIssue> {
    const group = await this.deps.linear.issueGroup(issue.id);
    return { ...issue, status: group.status, statusType: group.statusType, delegateId: group.delegateId, children: group.children, childrenComplete: true };
  }

  // A verifier's verdict, applied: close, resume (a successor with the instruction), park (Todo,
  // a blocking relation and/or a due date) or ask_owner. The record must carry the verifier
  // generation's marker, and only its first verdict counts. The application is claimed and its
  // committed steps are recorded before anything else runs, and the verifier is consumed only once
  // the effects are in — so a reload neither repeats a close nor loses a verdict. Nothing is
  // mutated while `steward.enabled` is off, and a successor spends the per-pass cap and the
  // recovery budget like any other start.
  private async verdict(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, pass: Pass, now: number): Promise<void> {
    const { issue } = candidate;
    const verifier = candidate.ticket.verifier;
    if (!verifier) return;
    const read = this.deps.verdicts ?? ((issueId: string) => readVerdicts(join(paseoHome(), "linear-tickets", STEWARD_VERDICT_DIRECTORY, issueId)));
    // Only the verifier generation's own first verdict counts: a second record, or one another
    // ticket agent wrote, is ignored.
    const verdict = (await read(issue.id).catch(() => [] as StewardVerdict[]))
      .filter((entry) => entry.issueId === issue.id && entry.verifier === verifier.marker && Date.parse(entry.at) >= Date.parse(verifier.at) && ["close", "resume", "park", "ask_owner"].includes(entry.verdict))
      .at(0) ?? null;
    // The journal's step for the effects a branch commits, and whether the consumed verifier's
    // landed set counts as verified (only a close says so).
    const verifiedOf = (kind: StewardApplying["verdict"]) => (kind === "close" ? candidate.facts.landedSignature || null : null);
    if (!verdict) {
      // A generation whose launch never returned an agent: the marker on the launch's label finds
      // it again, so its verdict is read instead of the ticket being classified as ordinary work.
      if (!verifier.agentId) {
        const adopted = (await classifyTicketAgents(paseo, issue.id, now, this.deps.inspect).catch(() => null))?.live
          .find((agent) => agent.labels?.[STEWARD_VERIFIER_LABEL] === verifier.marker) ?? null;
        if (adopted) {
          await this.deps.store.update((file) => {
            const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
            if (ticket.verifier?.marker === verifier.marker) ticket.verifier = { ...ticket.verifier, agentId: adopted.id };
          });
          console.log(`[linear-tickets] ${issue.identifier}: steward: adopted verifier ${short(adopted.id)} (generation ${verifier.marker.slice(0, 8)})`);
          return;
        }
        if (now - Date.parse(verifier.at) > CLAIM_GRACE_MS) {
          if (!this.enabled) return;
          await this.deps.store.update((file) => {
            const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
            if (ticket.verifier?.marker === verifier.marker) ticket.verifier = null;
          });
          await this.refused(issue, now, "the verifier's launch left no agent");
          return;
        }
      }
      if (now - Date.parse(verifier.at) <= VERIFY_TIMEOUT_MS) return;
      if (!this.enabled) return;
      const applying = candidate.ticket.applying?.marker === verifier.marker ? candidate.ticket.applying : null;
      if (applying && applying.step === "claimed" && now - Date.parse(applying.at) < CLAIM_GRACE_MS) return;
      if (applying && applying.step !== "claimed") {
        await this.archiveAgent(paseo, verifier.agentId);
        await this.consume(issue, verifiedOf(applying.verdict));
        return;
      }
      // The timeout is journaled like a verdict, and its owner-facing escalation is committed
      // before the verifier is consumed: a failed call or a reload retries the decision instead of
      // losing it and launching a fresh verifier over the same ticket.
      if (!await this.claimApplication(issue, verifier.marker, "timeout", now)) return;
      await this.archiveAgent(paseo, verifier.agentId);
      await this.requestDiagnosis(issue, "The completion verifier did not report within five minutes");
      await this.step(issue, verifier.marker, "escalated", now);
      await this.consume(issue, null);
      return;
    }
    if (!this.enabled) return;
    console.log(`[linear-tickets] ${issue.identifier}: the verifier's verdict is ${verdict.verdict}`);
    const applying = candidate.ticket.applying?.marker === verifier.marker ? candidate.ticket.applying : null;
    // Another pass is applying this verdict right now; the effects committed before a reload are
    // only consumed. Neither case repeats an effect.
    if (applying && applying.step === "claimed" && now - Date.parse(applying.at) < CLAIM_GRACE_MS && applying.verdict === verdict.verdict) return;
    if (applying && applying.step !== "claimed") {
      await this.archiveAgent(paseo, verifier.agentId);
      await this.consume(issue, verifiedOf(applying.verdict));
      return;
    }
    // A successor the verdict asks for is a start like any other: it spends the per-pass cap (its
    // application waits for the next pass, nothing consumed) and the rolling recovery budget, and a
    // deliberate wait that appeared while the verifier ran wins over it.
    if (verdict.verdict === "resume") {
      if (candidate.facts.deliberate) {
        this.once(`verdict:${issue.id}`, `${issue.identifier}: the verifier asked for more work but the ticket deliberately waits (${candidate.facts.deliberate}); it waits`);
        return;
      }
      if (!this.cap(pass, candidate, "resume")) return;
      if (candidate.facts.restarts >= RESTART_CAP) {
        // The recovery budget is spent: the verdict does not open a way around it, and the decision
        // is journaled before the verifier is consumed.
        if (!await this.claimApplication(issue, verifier.marker, "exhausted", now)) return;
        await this.archiveAgent(paseo, verifier.agentId);
        await this.requestDiagnosis(issue, `The verifier asked for more work but the ticket's restart budget (${RESTART_CAP} in 24 hours) is spent`);
        await this.step(issue, verifier.marker, "escalated", now);
        await this.consume(issue, candidate.facts.landedSignature || null);
        return;
      }
    }
    if (!await this.claimApplication(issue, verifier.marker, verdict.verdict, now)) return;
    // The verifier is archived before any effect: its verdict is already on disk, and it must never
    // be mistaken for the implementation agent a `resume` is looking for.
    await this.archiveAgent(paseo, verifier.agentId);
    try {
      switch (verdict.verdict) {
        case "close": {
          // The evidence is re-read before the ticket is closed: a pull request opened (or recorded)
          // while the verifier ran, an owner hold, a fresh blocker or a live agent aborts the close,
          // and the next pass classifies the ticket anew.
          const blocked = await this.completionFence(paseo, settings, names, candidate, now);
          if (blocked) {
            console.log(`[linear-tickets] ${issue.identifier}: the verifier's close verdict is not applied — ${blocked}`);
            await this.consume(issue, null);
            return;
          }
          await this.close(paseo, candidate, "its verifier judged the landed work complete");
          await this.step(issue, verifier.marker, "closed", now);
          await this.consume(issue, candidate.facts.landedSignature || null);
          return;
        }
        case "ask_owner": {
          await this.escalate(candidate, verdict.question ?? "the verifier asked the owner for a decision", verdict.options ?? undefined);
          await this.step(issue, verifier.marker, "escalated", now);
          await this.consume(issue, null);
          return;
        }
        case "park": {
          await this.park(issue, candidate, names, verdict);
          await this.step(issue, verifier.marker, "parked", now);
          await this.consume(issue, null);
          return;
        }
        case "resume": {
          const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id) ?? null;
          const instruction = verdict.instruction ?? "The verifier found the ticket's work incomplete; continue it.";
          const parentResume = candidate.facts.parentPhase !== null || Boolean(verifier.children?.length);
          let charged = false;
          const charge = async () => {
            await this.deps.store.update((file) => {
              const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
              ticket.restarts = [...recent(ticket.restarts, now), this.iso(now)];
            });
            charged = true;
          };
          // Parent continuations charge only after worker admission and fresh authority checks.
          // An admitted failure still spends its attempt; a capacity wait keeps the instruction
          // and budget intact. The existing branch-only successor semantics remain unchanged.
          if (!parentResume) await charge();
          const onDispatch = async () => {
            if (parentResume) await charge();
            console.log(`[linear-tickets] ${issue.identifier}: steward: the verifier asked for more work; a successor continues it`);
          };
          const result = await (parentResume
            ? this.deps.sessions.resumeVerifiedParent(issue.id, issue.identifier, record?.agentId ?? null, instruction, onDispatch)
            : this.deps.sessions.succeed(issue.id, issue.identifier, record?.agentId ?? null, instruction, onDispatch)
          ).catch((error: unknown): Succession => ({ kind: "impossible", reason: message(error) }));
          if ("agent" in result && result.agent.id !== verifier.agentId) {
            await this.step(issue, verifier.marker, "resumed", now);
            await this.consume(issue, null);
            return;
          }
          if ("agent" in result) {
            // The live agent it would take over from is the verifier itself: no implementation
            // successor exists, so nothing is consumed and the next pass turns this into a decision.
            const reason = "the only live agent on the ticket is its verifier";
            const count = await this.refused(issue, now, reason);
            this.once(`verdict:${issue.id}`, `${issue.identifier}: ${reason}; the next pass retries or asks the owner`);
            if (count >= REFUSAL_CAP) await this.exhausted(candidate, verifier.marker, reason, now);
            return;
          }
          if (result.kind === "wait" && (parentResume || queueWait(result.reason))) {
            // No dispatched parent attempt is charged; retain its verdict through any owner or
            // admission wait. Ordinary branch-only capacity waits keep their existing refund.
            if (charged) await this.unspend(issue, now);
            this.once(`verdict:${issue.id}`, `${issue.identifier}: the verifier's successor waits (${result.reason}); the next pass retries`);
            return;
          }
          const reason = result.kind === "wait" ? `the successor waits: ${result.reason}` : `no successor can start: ${successionReason(result)}`;
          const count = await this.refused(issue, now, reason);
          this.once(`verdict:${issue.id}`, `${issue.identifier}: ${reason}; the next pass tries again`);
          if (count >= REFUSAL_CAP) await this.exhausted(candidate, verifier.marker, reason, now);
          return;
        }
      }
    } catch (error) {
      // The claim and the verdict stay: the next pass resumes from the recorded step.
      this.once(`verdict:${issue.id}`, `${issue.identifier}: applying the verifier's ${verdict.verdict} failed: ${message(error)}; the next pass retries`);
      throw error;
    }
  }

  // The verdict application's claim, written before its first effect. False: another pass holds
  // it, or this pass just applied it.
  private claimApplication(issue: StewardIssue, marker: string, verdict: StewardApplying["verdict"], now: number): Promise<boolean> {
    return this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      const current = ticket.applying;
      if (current?.marker === marker && this.clock() - Date.parse(current.at) < CLAIM_GRACE_MS) return false;
      ticket.applying = { marker, verdict, step: "claimed", at: this.iso(now) };
      return true;
    });
  }

  // The verdict successor outran every budget: the verifier's ask becomes the owner's decision,
  // journaled before the verifier is consumed (the same shape as its timeout).
  private async exhausted(candidate: Candidate, marker: string, reason: string, now: number): Promise<void> {
    const { issue } = candidate;
    // This pass owns the application (same marker), so the journal is rewritten without the grace.
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      ticket.applying = { marker, verdict: "exhausted", step: "claimed", at: this.iso(now) };
    });
    console.log(`[linear-tickets] ${issue.identifier}: steward: the verifier's successor cannot run (${reason})`);
    await this.requestDiagnosis(issue, reason);
    await this.step(issue, marker, "escalated", now);
    await this.consume(issue, null);
  }

  // Whether the close verdict may still be applied, read fresh at effect time: the ticket's own
  // current facts (host ownership, deletion, an owner hold or manual step, a plan under review, a
  // newly open sub-issue, a fresh blocker, a live implementation agent, an owner wait), then the
  // complete pull-request inventory of the ticket — every attached and recorded pull request, read
  // from GitHub now by pr-watch's `completionPulls` across all of its repositories, without the
  // retirement policy's veto exclusions and without trusting a recorded closed state.
  private async completionFence(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, now: number): Promise<string | null> {
    const { issue } = candidate;
    if (await this.deps.deletions?.blocked(issue.id).catch(() => true)) return "the ticket is paused for deletion";
    const ownership = await this.deps.owner(issue.id).catch(() => "unknown" as HostOwnership);
    if (ownership !== "here") return `another host owns the ticket (${ownership})`;
    const appIds = (await this.deps.linear.trustedAppIds().catch(() => [])).filter(Boolean);
    const labelNames = [names.trigger, names.running, names.failed, names.blocked, names.needsYou, names.manual, names.hold, names.attended, names.queued];
    let fresh = (await this.deps.linear.stewardIssues({ teamKeys: settings.dispatch.teamKeys, labels: labelNames, appIds, ids: [issue.id] })).find((entry) => entry.id === issue.id) ?? null;
    if (!fresh) return "the ticket cannot be read";
    if (candidate.facts.parentPhase !== null || fresh.children.length > 0 || candidate.ticket.verifier?.children?.length) {
      const complete = await this.completeParentIssue(fresh).catch(() => null);
      if (!complete) return "complete parent child and label evidence cannot be read";
      fresh = complete;
    }
    if (CLOSED_TYPES.includes(fresh.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number])) return `the ticket is already ${fresh.status}`;
    const parent = await this.deps.sessions.parentProgress(issue.id);
    if (parent?.phase === "paused" || parent?.phase === "closed") return `parent orchestration is ${parent.phase}: ${parent.nextAction}`;
    if (parent?.delegated && (!fresh.delegateId || !appIds.includes(fresh.delegateId))) return "Paseo is no longer delegated to the parent";
    const authority = await this.ownerAuthorityFence(fresh, names, parent);
    if (authority) return authority;
    const openChildren = fresh.children.filter((child) => !CLOSED_TYPES.includes(child.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number])).length;
    if (openChildren > 0 || !fresh.childrenComplete) return "a sub-issue is still open";
    const children = candidate.ticket.verifier?.children;
    if (!children && (parent || fresh.children.length > 0)) return "the verifier has no child membership snapshot; a fresh verification is required";
    if (children && JSON.stringify(children) !== JSON.stringify(fresh.children.map((child) => child.id).sort())) return "the parent's child membership changed during verification";
    const ownerTasks = await this.ownerCompletionFence(fresh);
    if (ownerTasks) return ownerTasks;
    const blocker = fresh.blockers.find((entry) => !finishedBlocker(entry));
    if (blocker) return `it waits for ${blocker.identifier}`;
    const live = (await classifyTicketAgents(paseo, issue.id, now, this.deps.inspect)).live
      .filter((agent) => !agent.labels?.[STEWARD_VERIFIER_LABEL] && agent.id !== verifierIdOf(candidate));
    if (live.length) return `an agent works on it again (${short(live[0].id)})`;
    const records = await this.deps.handover.all();
    const record = records.find((item) => item.issueId === issue.id) ?? null;
    if (record?.waiting) {
      const handed = await this.deps.watchdog.handedOver();
      const wait = await this.waitState(fresh, record.waiting, [], { handed, record, roots: new Map() }, now);
      if (wait === "live") return "it waits for the owner";
    }
    // The complete, fresh inventory: everything the ticket recorded plus everything Linear carries
    // as its pull request, reopened or not, do-not-merge or fork or another repository.
    const urls = pullUrls(fresh, record ?? undefined);
    const stack = await this.deps.completionPulls(issue.id, issue.identifier, urls).catch(() => "unknown" as StackState);
    if (stack === "open") return "an open pull request of the ticket exists";
    if (stack === "unknown") return "the ticket's pull requests cannot be read";
    for (const child of fresh.children) {
      const childRecord = records.find((item) => item.issueId === child.id);
      const childStack = await this.deps.completionPulls(child.id, child.identifier, childRecord?.pullRequests ?? []).catch(() => "unknown" as StackState);
      if (childStack === "open") return `child ${child.identifier} has an open pull request`;
      if (childStack === "unknown") return `child ${child.identifier}'s pull requests cannot be read`;
    }
    return null;
  }

  // Verification wins classification, not authority to ignore a newer owner gate. No failure
  // fallback here: unreadable evidence rejects the effect. inTurn ignores only the router's own
  // exclusive resume turn; threadQueued still checks actual live queued links.
  private async ownerAuthorityFence(issue: StewardIssue, names: DispatchLabels, parent: ParentProgress | null, inTurn = false): Promise<string | null> {
    const gate = await this.ownerGates(issue, names, parent, inTurn);
    if (gate) return gate;
    const stage = planStage(issue.status, issue.statusType);
    if (stage && (!inTurn || stage === PLAN_REVIEW_STATE)) return `the ticket's plan is in ${issue.status}`;
    return null;
  }

  // The owner's gates other than the plan stage: an owner Stop, a parked plan, a thread waiting for
  // a decision, an answer or the peer host, a queued turn, and the owner's labels.
  private async ownerGates(issue: StewardIssue, names: DispatchLabels, parent: ParentProgress | null, inTurn: boolean): Promise<string | null> {
    const [watchdog, planned, thread, queuedThread] = await Promise.all([
      this.deps.watchdog.read(),
      this.deps.planned?.has(issue.id) ?? Promise.resolve(false),
      this.deps.sessions.watchdogThread(issue.id),
      this.deps.sessions.threadQueued(issue.id, inTurn),
    ]);
    if (watchdog?.holds[issue.id]) return "the owner stopped recovery for this ticket";
    if (planned) return "the ticket has a persisted parked plan";
    const activeThread = parent && thread?.closed ? null : thread;
    if (activeThread?.review || (activeThread?.offer && ["split", "later", "parked"].includes(activeThread.offer))) return "the live ticket thread waits for a plan decision";
    if (activeThread?.questions) return "the live ticket thread waits for the owner's answer";
    if (activeThread?.remote) return "the live ticket thread belongs to the peer host";
    if (activeThread?.queued || queuedThread) return "the ticket has a live queued thread or turn";
    if (hasLabel(issue.labels, names.hold)) return `the owner put the ticket on hold (${names.hold})`;
    if (hasLabel(issue.labels, names.manual)) return `the ticket carries a manual step (${names.manual})`;
    if (hasLabel(issue.labels, names.needsYou)) return `the ticket needs the owner (${names.needsYou})`;
    if (hasLabel(issue.labels, DO_NOT_MERGE)) return "the ticket is marked do-not-merge";
    return null;
  }

  // The responsibility check's fence (responsibility.ts RepairFence), read fresh under the
  // repair's reservation: this host still owns the ticket, it is still in Planning or Plan review,
  // and nothing of the owner's or the steward's own stands in the way — a pause, an owner gate, a
  // blocker, a live agent, an owner wait or question, a steward action within the grace. Unreadable
  // evidence refuses; every answer is temporary.
  private async repairFence(settings: PluginSettings, names: DispatchLabels & { trigger: string }, paseo: PaseoApi, issueId: string, identifier: string): Promise<string | null> {
    const now = this.clock();
    if (await this.deps.deletions?.blocked(issueId).catch(() => true)) return "the ticket is paused for deletion";
    const ownership = await this.deps.owner(issueId).catch(() => "unknown" as HostOwnership);
    if (ownership !== "here") return `another host owns the ticket (${ownership})`;
    const appIds = (await this.deps.linear.trustedAppIds().catch(() => [])).filter(Boolean);
    const labelNames = [names.trigger, names.running, names.failed, names.blocked, names.needsYou, names.manual, names.hold, names.attended, names.queued];
    const fresh = (await this.deps.linear.stewardIssues({ teamKeys: settings.dispatch.teamKeys, labels: labelNames, appIds, ids: [issueId] })).find((entry) => entry.id === issueId) ?? null;
    if (!fresh) return "the ticket cannot be read";
    const stage = planStage(fresh.status, fresh.statusType);
    if (stage !== PLANNING_STATE && stage !== PLAN_REVIEW_STATE) return `the ticket moved to ${fresh.status}`;
    const parent = await this.deps.sessions.parentProgress(issueId);
    if (parent?.phase === "paused" || parent?.phase === "closed") return `parent orchestration is ${parent.phase}: ${parent.nextAction}`;
    const gate = await this.ownerGates(fresh, names, parent, false);
    if (gate) return gate;
    const blocker = fresh.blockers.find((entry) => !finishedBlocker(entry));
    if (blocker) return `it waits for ${blocker.identifier}`;
    const live = (await classifyTicketAgents(paseo, issueId, now, this.deps.inspect)).live
      .filter((agent) => !agent.labels?.[STEWARD_VERIFIER_LABEL] && !agent.labels?.["paseo.parent-agent-id"]);
    if (live.length) return `an agent works on it (${short(live[0].id)})`;
    const record = (await this.deps.handover.all()).find((item) => item.issueId === issueId) ?? null;
    if (record?.waiting) {
      const handed = await this.deps.watchdog.handedOver();
      if (await this.waitState(fresh, record.waiting, [], { handed, record, roots: new Map() }, now) === "live") return "it waits for the owner";
    }
    if ((await this.deps.needsYou.allStrict()).some((entry) => entry.parentId === issueId)) return "it has an open Needs-you question";
    const stewardAt = stewardActionAt((await this.deps.store.read()).tickets[issueId] ?? null);
    if (stewardAt !== null && now - stewardAt < RESPONSIBILITY_GRACE_MS) return `the steward acted on ${identifier} within the last ten minutes`;
    return null;
  }

  // Group handout excludes owner tasks; completion cannot. Re-read every registered task's
  // status and check receipt, including after-merge tasks on the parent or its child tickets.
  private async ownerCompletionFence(issue: StewardIssue): Promise<string | null> {
    const scope = new Set([issue.id, ...issue.children.map((child) => child.id)]);
    const [tasks, needsYou] = await Promise.all([this.deps.manualTasks.tasksStrict(), this.deps.needsYou.allStrict()]);
    const manual = tasks.filter((task) => scope.has(task.parentId));
    const questions = needsYou.filter((task) => scope.has(task.parentId));
    if (!manual.length && !questions.length) return null;
    // The batched API includes completedAt; issueStatus alone only returns name/type.
    const statuses = await this.deps.linear.issueStatuses([...new Set([...manual, ...questions].map((task) => task.id))]);
    for (const task of manual) {
      const status = statuses.get(task.id);
      if (!status) return `manual task ${task.identifier} cannot be read`;
      const type = status.statusType.trim().toLowerCase();
      if (type === "canceled" || type === "duplicate") continue;
      if (type !== "completed") return `manual task ${task.identifier} is still open`;
      if (task.check && (!status.completedAt || task.verifiedFor !== status.completedAt)) return `manual task ${task.identifier} still needs its completion check`;
    }
    for (const task of questions) {
      const status = statuses.get(task.id);
      if (!status || !CLOSED_TYPES.includes(status.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number])) return `owner question ${task.identifier} is unresolved`;
    }
    return null;
  }

  // One committed step of a verdict application, written before the next effect runs.
  private step(issue: StewardIssue, marker: string, step: StewardApplying["step"], now: number): Promise<void> {
    return this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      if (ticket.applying?.marker === marker) ticket.applying = { ...ticket.applying, step, at: this.iso(now) };
    });
  }

  // The verifier is consumed only here, after its verdict's effects are in: the claim goes, and the
  // landed set it judged is remembered so the next pass does not verify the same work twice.
  private consume(issue: StewardIssue, verified: string | null): Promise<void> {
    return this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso());
      ticket.verifier = null;
      ticket.applying = null;
      if (verified !== null) ticket.verified = verified;
    });
  }

  // The verifier's park: the ticket waits for another ticket (`blockedBy`) and/or a date, is moved
  // to Todo, and carries the trigger label only when a blocker must finish first — the label
  // dispatch starts it then. Without a blocker nothing starts it: the `parked` marker keeps the
  // steward's hands off until the owner acts.
  private async park(issue: StewardIssue, candidate: Candidate, names: DispatchLabels & { trigger: string }, verdict: StewardVerdict): Promise<void> {
    const reason = verdict.reason ?? "the verifier parked the ticket";
    const blocker = verdict.blockedBy ? await this.deps.linear.issueRef(verdict.blockedBy) : null;
    if (verdict.blockedBy && !blocker) throw new Error(`Linear has no ticket ${verdict.blockedBy}`);
    if (blocker) await this.deps.linear.relate(blocker.id, issue.id, "blocks");
    if (verdict.dueDate) await this.deps.linear.setDueDate(issue.id, verdict.dueDate);
    const moved = await this.deps.linear.moveToReady(issue.id);
    if (blocker) await this.deps.linear.addLabel(issue.id, names.trigger);
    const waits = [blocker ? `${blocker.identifier} to finish` : null, verdict.dueDate ? `the date ${verdict.dueDate}` : null].filter(Boolean).join(" and ");
    await this.deps.linear.comment(issue.id, `Paseo's ticket steward parked this ticket${waits ? `: it waits for ${waits}` : ""}. ${reason}`).catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: the park comment failed: ${message(error)}`));
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso());
      ticket.parked = { at: this.iso(), blockedBy: blocker?.identifier ?? null, dueDate: verdict.dueDate, reason: reason.slice(0, 300) };
      ticket.log = [...ticket.log, { at: this.iso(), action: `parked: ${reason.slice(0, 200)}` }].slice(-LOG_LIMIT);
    });
    console.log(`[linear-tickets] ${issue.identifier}: steward: parked (${reason}${moved.note ? `; ${moved.note}` : ""})`);
  }

  // The close of a landing verifier's verdict: complete the ticket, comment why, then archive its
  // agents (they hold no slot any more).
  private async close(paseo: PaseoApi, candidate: Candidate, why: string): Promise<void> {
    const { issue } = candidate;
    const list = issue.children.map((child) => `- ${child.identifier}: ${child.status}`).join("\n");
    await this.deps.linear.complete(issue.id);
    await this.deps.doneTickets.written(issue.id, "completed", this.clock());
    const landed = candidate.facts.landedPulls.length ? ` Its pull requests landed (${candidate.facts.landedPulls.map((pull) => pull.url).join(", ")}).` : "";
    await this.deps.linear.comment(issue.id, `Paseo's ticket steward completed this ticket: ${why}.${landed}${list ? `\n\n${list}` : ""}`).catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: the completion comment failed: ${message(error)}`));
    await this.deps.sessions.retireTurn(issue.id, async () => {
      const roots = (await this.rootsOf(paseo, issue.id)).filter((agent) => !agent.archivedAt);
      for (const agent of roots) await this.archiveAgent(paseo, agent.id);
      return roots.length;
    }).catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: archiving its agents failed: ${message(error)}`));
  }

  // The agent of a finished ticket (Done/Canceled) that is quiet holds no slot: it is archived and
  // its `<trigger>-running` label comes off. The stack must have landed,
  // nothing may wait for the owner, and the agent must still be quiet when the archive goes out.
  private async archive(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, now: number): Promise<{ state: "done" | "failed"; reason: string }> {
    const { issue } = candidate;
    const roots = await this.rootsOf(paseo, issue.id);
    const quiet = roots.filter((agent) => {
      const silence = quietFor(agent.updatedAt, now);
      return !agent.archivedAt && !agent.labels?.["paseo.parent-agent-id"] && silence !== null && silence > QUIET_DONE_MS
        && (agent.status === "running" || agent.status === "initializing" || agent.status === "idle" || agent.status === "closed") && !agent.pendingPermissions?.length;
    });
    if (!quiet.length) return { state: "failed", reason: "the agent was active again" };
    const state = await this.deps.linear.issueStatus(issue.id);
    this.deps.doneTickets.read(issue.id, state.statusType, now);
    const type = state.statusType.trim().toLowerCase();
    if (!TERMINAL[type]) return { state: "failed", reason: `${issue.identifier} is ${state.status}` };
    if (state.status.trim().toLowerCase() === NEEDS_INPUT_STATE.toLowerCase()) return { state: "failed", reason: `the ticket waits for the owner in ${state.status}` };
    if (hasLabel(issue.labels, names.needsYou)) return { state: "failed", reason: `the ticket waits for the owner (${names.needsYou})` };
    const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id) ?? null;
    if (record?.waiting) return { state: "failed", reason: "the ticket has a recorded wait for the owner" };
    if (type === "completed") {
      const stack = await this.deps.completionPulls(issue.id, issue.identifier, pullUrls(issue, record ?? undefined)).catch(() => "unknown" as StackState);
      if (stack === "open") return { state: "failed", reason: "the ticket's stack has open pull requests" };
      if (stack === "unknown") return { state: "failed", reason: "the ticket's open pull requests cannot be read" };
    }
    const gate = this.deps.launcher.gate(issue.id);
    if (!gate) return { state: "failed", reason: "a launch for this ticket is under way" };
    try {
      let archived = 0;
      for (const agent of quiet) {
        // Before the archive: a failed write archives nothing.
        await this.deps.labels.add({ issueId: issue.id, identifier: issue.identifier, agentId: agent.id });
        const fresh = (await this.rootsOf(paseo, issue.id)).find((item) => item.id === agent.id);
        if (!fresh || fresh.archivedAt || fresh.updatedAt !== agent.updatedAt || fresh.pendingPermissions?.length) continue;
        await this.archiveAgent(paseo, agent.id);
        archived++;
        // The label comes off only once a fresh read confirms it is there, and the debt is dropped
        // only once the removal went through: a failed read or a rate limit keeps it for the next
        // pass (settleLabels), never losing it.
        await this.settleLabel(issue.id, issue.identifier, agent.id, names);
      }
      void settings;
      return archived ? { state: "done", reason: `archived ${archived} quiet agent(s) of ${state.status}` } : { state: "failed", reason: "the agent was active again" };
    } finally {
      gate.release();
    }
  }

  // The `<trigger>-running` labels archived agents still owe, settled from the pass's own agent
  // reading (retired-labels.json, written before the archive). A ticket whose next root agent is
  // unarchived keeps the label (the successor owns it) and only drops the debt; one that moved to
  // the peer host drops the debt too, since the peer manages its labels.
  private async settleLabels(paseo: PaseoApi, names: DispatchLabels & { trigger: string }, roots: Map<string, TicketRoots>): Promise<void> {
    const debt = await this.deps.labels.all().catch((error: unknown) => {
      this.once("labels", `the steward could not read the archived agents' labels: ${message(error)}; the next pass retries`);
      return [] as RetiredLabel[];
    });
    for (const entry of debt) {
      if (!this.alive()) return;
      const ownership = await this.deps.owner(entry.issueId).catch(() => "unknown" as HostOwnership);
      if (ownership === "unknown") continue;
      if (ownership === "elsewhere") {
        await this.deps.labels.remove(entry.agentId).catch(() => undefined);
        continue;
      }
      const agents = roots.get(entry.issueId)?.roots ?? await this.rootsOf(paseo, entry.issueId).catch(() => [] as WatchedAgent[]);
      const mine = agents.find((agent) => agent.id === entry.agentId);
      if (mine && !mine.archivedAt) continue; // the archive never happened: the label is this agent's
      if (agents.some((agent) => agent.id !== entry.agentId && !agent.archivedAt)) {
        await this.deps.labels.remove(entry.agentId).catch(() => undefined); // a successor re-added it
        continue;
      }
      await this.settleLabel(entry.issueId, entry.identifier, entry.agentId, names);
    }
  }

  // One archived agent's label: read the ticket, remove the label when it is still there, then drop
  // the debt. An unreadable ticket or a failed removal keeps the debt for the next pass.
  private async settleLabel(issueId: string, identifier: string, agentId: string, names: DispatchLabels & { trigger: string }): Promise<void> {
    const core: IssueCore | null = await this.deps.linear.issueCore(issueId).catch(() => null);
    if (!core) {
      this.once(`labels:${agentId}`, `${identifier}: its ${names.running} label cannot be settled (the ticket cannot be read); the next pass retries`);
      return;
    }
    if (hasLabel(core.labels, names.running)) {
      try {
        await this.deps.linear.removeLabel(issueId, names.running, core.labels);
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        this.once(`labels:${agentId}`, `${identifier}: removing its ${names.running} label failed: ${message(error)}; the next pass retries`);
        return;
      }
    }
    await this.deps.labels.remove(agentId).catch((error: unknown) => this.once(`labels:${agentId}`, `${identifier}: dropping the archived label record failed: ${message(error)}; the next pass retries`));
  }

  // The stale `<trigger>-failed` of an earlier attempt comes off once an agent works the ticket
  // again (README, "Statuses and labels"): after a successful start or a successor.
  private async clearFailed(issue: StewardIssue, names: DispatchLabels & { trigger: string }): Promise<void> {
    if (!hasLabel(issue.labels, names.failed)) return;
    await this.deps.linear.removeLabel(issue.id, names.failed, issue.labels).catch((error: unknown) => this.once(`failed:${issue.id}`, `${issue.identifier}: clearing its ${names.failed} label failed: ${message(error)}; the next pass retries`));
  }

  // The archive of one agent: refresh first, then archive. A gone agent is nothing to do. An empty
  // id is a verifier generation whose launch never returned an agent.
  private async archiveAgent(paseo: PaseoApi, agentId: string | null): Promise<void> {
    if (!agentId) return;
    const current = await paseo.agents.ref(agentId).refresh().catch(() => null);
    if (!current || current.agent.archivedAt) return;
    await paseo.agents.ref(agentId).archive().catch((error: unknown) => console.error(`[linear-tickets] archiving agent ${short(agentId)} failed: ${message(error)}`));
  }

  private async rootsOf(paseo: PaseoApi, issueId: string): Promise<WatchedAgent[]> {
    const roots = await this.deps.sessions.watchdogRoots().catch(() => null);
    if (roots) return roots.get(issueId)?.roots ?? [];
    const agents = await classifyTicketAgents(paseo, issueId, this.clock(), this.deps.inspect);
    return [...agents.live, ...agents.stopped, ...agents.ghosts];
  }

  private async liveRoot(paseo: PaseoApi, issueId: string): Promise<WatchedAgent | null> {
    return newestLiveRoot(await this.rootsOf(paseo, issueId));
  }

  // ESCALATE: one owner-visible decision item on the ticket — the Needs input state, the needs-you
  // label and one comment naming the reason and the lettered options — through the write-back's own
  // waiting path (README, "Ticket steward"). Never a bare comment as the terminal step.
  private async escalate(candidate: Candidate, reason: string | undefined, options?: string[]): Promise<void> {
    const { issue, facts, situation } = candidate;
    const key = situation === "escalated" ? (candidate.ticket.escalated?.key ?? "escalated") : situation;
    const why = reason ?? refusalReason(facts, situation);
    const stored = (await this.deps.store.read()).tickets[issue.id];
    const ownerNewer = Boolean(stored?.ownerAt && stored.escalated && Date.parse(stored.ownerAt) > Date.parse(stored.escalated.at));
    if (stored?.escalated?.key === key && !ownerNewer) return;
    try {
      await this.deps.writeback.escalate(issue.id, issue.identifier, `the ticket steward cannot move ${issue.identifier} on (${situation})`, `${escalateBody(situation, facts, why, options ?? optionsFor(situation))}\n\n<!-- paseo:steward:${situation} -->`);
    } catch (error) {
      this.once(`escalate:${issue.id}`, `${issue.identifier}: the steward's escalation failed: ${message(error)}; the next pass retries`);
      throw error;
    }
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso());
      ticket.escalated = { key, signature: `${situation}:${why}`, at: this.iso() };
      ticket.recoveryOutcomes ??= {};
      ticket.recoveryOutcomes["owner-escalation"] = (ticket.recoveryOutcomes["owner-escalation"] ?? 0) + 1;
      ticket.log = [...ticket.log, { at: this.iso(), action: `escalated: ${why.slice(0, 200)}` }].slice(-LOG_LIMIT);
    });
    console.log(`[linear-tickets] ${issue.identifier}: steward: asked the owner to decide (${situation}: ${why})`);
  }

  // The watchdog's exhausted recovery (watchdog.ts flushReports): its terminal step is the same
  // owner-visible escalation the steward's own pass posts -- the reason, the options for that
  // situation, and the mark -- instead of a bare owner mention. Deduplication is the watchdog's
  // (its report is queued once per cycle).
  async escalateExhausted(issueId: string, identifier: string, reason: string): Promise<void> {
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issueId, identifier, this.iso());
      ticket.diagnosticRequested ??= reason;
    });
  }

  // The flow view (README, "Ticket steward"): the counts of the last pass and the oldest tickets of
  // each state, for the browser inbox and the status RPC.
  private async flowView(candidates: Candidate[]): Promise<void> {
    const counts: Record<string, number> = {};
    for (const situation of STEWARD_SITUATIONS) counts[situation] = 0;
    for (const candidate of candidates) counts[candidate.situation] = (counts[candidate.situation] ?? 0) + 1;
    const oldest = candidates
      .filter((candidate) => STEWARD_STATES[candidate.situation])
      .sort((a, b) => a.ticket.since.localeCompare(b.ticket.since))
      .slice(0, 10)
      .map((candidate) => ({ identifier: candidate.issue.identifier, situation: candidate.situation, since: candidate.ticket.since }));
    await this.deps.store.update((file) => {
      file.flow = { at: this.iso(), counts, oldest };
    });
  }
}

// The pull requests a ticket's handover record names (the link and the moved-in ones).
function recordPulls(record: HandoverRecord | undefined): string[] {
  if (!record) return [];
  const urls = new Set<string>();
  for (const url of Object.values(record.links)) if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) urls.add(url);
  for (const url of record.pullRequests ?? []) urls.add(url);
  return [...urls];
}

// Every pull request of one ticket: the record's own links and the GitHub pull request attachments
// Linear carries, so a pull request in another repository is judged too (the landed set, the close
// check).
function pullUrls(issue: StewardIssue, record: HandoverRecord | undefined): string[] {
  const urls = new Set(recordPulls(record));
  for (const attachment of issue.attachments) if (attachment.sourceType === "github" && /\/pull\/\d+/.test(attachment.url)) urls.add(attachment.url);
  return [...urls];
}

// A ticket the store does not know yet, at the moment a pass first classifies it.
function newTicket(identifier: string, at: string): StewardTicket {
  return {
    identifier, situation: "moving", since: at, at, claim: null, restarts: [], refusals: [], resumedAt: null,
    verifier: null, verified: null, escalated: null, ownerAt: null, queued: null, applying: null, parked: null, log: [],
  };
}

// A start admission refused without anything being attempted: the ticket waits in the queue for a
// slot, focus, a blocker, a parked plan or the owner's presence, and the pass retries it. Nothing
// was tried, so no recovery budget is spent (finding: ordinary admission deferrals are queue
// entries, not failures). Everything else a deferral can mean is a failure like any other.
function queueWait(reason: string): boolean {
  return /^(Queued: |This ticket is paused for deletion|Paseo is not connected yet|A launch for this ticket is under way|Waiting for .+ to finish)/.test(reason)
    || reason === FOCUS_REASON || reason === WAITING_PLAN_REASON || reason === AWAY_REASON
    || reason === REPAIR_BUSY_MESSAGE || reason === EXCLUSION_CLOSED_MESSAGE
    || reason.startsWith(LIVE_AGAIN_PREFIX);
}

// The ticket's own root among a set of its agents: live, not a verifier generation or a sub-agent,
// newest first — a retried start leaves the older agent behind. `liveRoot` selects it fresh before
// an effect; a pass selects it from the registry snapshot it already read.
function newestLiveRoot(roots: WatchedAgent[]): WatchedAgent | null {
  return roots
    .filter((agent) => LIVE_AGENT[agent.status] && !agent.labels?.[STEWARD_VERIFIER_LABEL] && !agent.labels?.["paseo.parent-agent-id"])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

// How long the live roots have been quiet: null while one of them has an open turn, else the
// longest quiet time among them (Paseo's own agent update; the watchdog's deeper evidence rules
// when it acts).
function idleMinutesOf(roots: WatchedAgent[], now: number): number | null {
  if (roots.some((agent) => agent.activeTurn || agent.status === "running" || agent.status === "initializing")) return null;
  const quiet = roots.map((agent) => quietFor(agent.updatedAt, now)).filter((value): value is number => value !== null);
  return quiet.length ? Math.max(...quiet) / 60_000 : 0;
}

function refusalReason(facts: StewardFacts, situation: StewardSituation): string {
  const reasons: Partial<Record<StewardSituation, string>> = {
    "queued-too-long": `it has waited in the queue for more than ${facts.queuedHours} hours`,
    "restart-exhausted": `its restarts (${facts.restarts} of ${RESTART_CAP}) left no agent`,
    "watchdog-exhausted": "the watchdog used both of its recovery cycles in the last 24 hours",
    "refused": `every start it tried was refused${facts.lastRefusal ? ` (last: ${facts.lastRefusal})` : ""}`,
    "escalated": "it is in a state no automatic mechanism moves",
    "closed-unmerged": "its pull request was closed without merging and the replay was already asked for",
    "landed": "its stack landed but the ticket is still open and was verified before",
    "idle-unresponsive": "its agent stayed silent after the steward resumed it",
    "verifying": "its verifier's verdict needs the owner",
  };
  return reasons[situation] ?? "no automatic mechanism moves it";
}

// Why a successor could not take over: `Succession`'s refusal members carry a reason, a started or
// live one carries an agent (whose kind TypeScript cannot exclude by discriminant alone).
function successionReason(result: Succession): string {
  return "reason" in result ? result.reason : "no reason was given";
}
