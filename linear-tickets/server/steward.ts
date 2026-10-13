import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { ActivationIntake } from "./activation-intake";
import { dispatchLabels, type DispatchLabels } from "./dispatch";
import type { Focus } from "./focus";
import type { Handover, HandoverRecord } from "./handover";
import type { Launcher } from "./launch";
import type { LinearService, StewardIssue } from "./linear";
import type { ManualTasks } from "./manual-tasks";
import type { NeedsYouIssues } from "./needs-you";
import { LIVE_AGENT, type ProcessInspector } from "./process-liveness";
import { planStage } from "./plan-policy";
import type { PullState, StackState } from "./pr-watch";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { ReviewDeletions } from "./review-deletions";
import type { HostOwnership, RestartResult, SessionRouter, Succession } from "./sessions";
import type { PluginSettings, Settings } from "./settings";
import { classifyTicketAgents, type TicketStarter } from "./starter";
import { paseoHome } from "./ticket-mcp";
import type { TicketRoots, WatchedAgent, WatchdogFile, WatchdogStore } from "./watchdog";
import { NEEDS_INPUT_STATE, type Writeback } from "./writeback";

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
export const STEWARD_POLL_MS = 2 * 60_000;
// A defect (a ticket in none of the five states) is acted on only after it has been seen this long,
// so a start, a successor or a thread that is about to make the ticket move is waited for.
export const DEFECT_GRACE_MS = 15 * 60_000;
// A ticket is restarted at most RESTART_CAP times within STEWARD_WINDOW_MS.
export const RESTART_CAP = 3;
export const STEWARD_WINDOW_MS = 24 * 60 * 60_000;
// How many refusals (a start that could not run) a ticket may collect before the steward stops
// retrying and asks the owner. A permanent refusal (setup, an ineligible ticket) escalates at once.
export const REFUSAL_CAP = 3;
// A claim whose outcome was never written (a reload in the middle): nothing is repeated for this
// long, then the claim is marked outcome-unknown and the facts decide again.
export const CLAIM_GRACE_MS = 10 * 60_000;
// A verifier that has not reported within this long is escalated.
export const VERIFY_TIMEOUT_MS = 45 * 60_000;
// The status card of a head issue (a parent with sub-issues in scope) is refreshed at most this
// often, and at most this many cards are written per pass.
export const STATUS_CARD_MS = 30 * 60_000;
export const STATUS_CARDS_PER_PASS = 3;
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
// The mark of the steward's status card in a head issue's comment.
const CARD_MARK = "<!-- paseo:steward-flow -->";
// Where the verifier's structured verdicts land (`ticket-mcp-source.ts` writes them in the agent's
// own process; the steward reads them here).
export const STEWARD_VERDICT_DIRECTORY = "steward-verdicts";
// The label a verifier carries, so its agent is told apart from the ticket's own.
export const STEWARD_VERIFIER_LABEL = "linear-tickets.steward";
// The agent id a wait the steward opened for a ticket without an agent is anchored to: no agent
// ever carries it, so the ticket does not count as started by it.
const STEWARD_ANCHOR = "steward";

type Linear = Pick<LinearService,
  "stewardIssues" | "issueStatus" | "issueCore" | "addLabel" | "removeLabel" | "comment" | "upsertComment" | "createIssue" | "relate" | "complete" | "cancel" | "trustedAppIds">;
type Sessions = Pick<SessionRouter, "restartFor" | "succeed" | "prompt" | "watchdogRoots" | "watchdogThread" | "retireTurn" | "threadQueued">;

export type StewardDeps = {
  // The durable store (steward.json); the daemon passes the default path.
  store: StewardStore;
  linear: Linear;
  sessions: Sessions;
  starter: Pick<TicketStarter, "start">;
  launcher: Pick<Launcher, "gate">;
  handover: Pick<Handover, "all">;
  // The owner-visible side of an escalation and the end of a stale wait (writeback.ts).
  writeback: Pick<Writeback, "escalate" | "clearWait">;
  watchdog: Pick<WatchdogStore, "read" | "handedOver">;
  manualTasks: Pick<ManualTasks, "openBlockers">;
  needsYou: Pick<NeedsYouIssues, "all">;
  settings: Pick<Settings, "read">;
  // Which host owns a ticket's automatic work (activation-guard.ts ticketOwnership).
  owner: (issueId: string) => Promise<HostOwnership>;
  // The pull request watch's own state for the tickets' recorded pull requests (pr-watch.ts
  // `Seen`), and one ticket's stack state: its open pull requests as the watch last saw them.
  pulls: (urls: string[]) => Promise<Map<string, PullState>>;
  stacked: (issueId: string) => Promise<StackState>;
  intake: Pick<ActivationIntake, "claimsReady">;
  doneTickets: DoneTickets;
  // The `<trigger>-running` labels still to remove after an archive (retired-labels.json).
  labels: Pick<RetiredLabels, "all" | "add" | "remove">;
  deletions?: Pick<ReviewDeletions, "blocked">;
  focus?: Pick<Focus, "admits">;
  inspect?: ProcessInspector;
  now?: () => number;
  // The verifier's structured verdicts, oldest first (ticket-mcp-source.ts `steward_verdict`).
  verdicts?: (issueId: string) => Promise<StewardVerdict[]>;
};

// The pull request watch's state of one pull request, as far as this module cares (pr-watch.ts
// `Seen`): whether it landed (MERGED, or CLOSED with the repo's `externally-merged` label or the
// merge queue's own "Merged by the Graphite merge queue" bullet), whether it was closed without
// merging, and what the reviewers asked for.

// Whether a finished ticket's stack landed: `open` while the watch still sees an open pull request
// of it, `unknown` while its pull requests were never listed (pr-watch.ts stackState).

// --- Situations -----------------------------------------------------------------------------------

// The five states every in-scope open ticket is in — MOVING, WAITING_OWNER, WAITING_BLOCKER,
// QUEUED, CLOSEABLE — and the defects a pass repairs. `closed` is a finished ticket with nothing
// left to do (its agents archived); it is outside the five on purpose, as the invariant covers
// open tickets.
export const STEWARD_SITUATIONS = [
  "moving",
  "waiting-owner",
  "waiting-blocker",
  "queued",
  "closeable",
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

export type StewardAction = "start" | "restart" | "succeed" | "resume" | "verify" | "complete" | "cancel" | "archive" | "clear-wait" | "escalate";

// The one action of each situation (null: none — the ticket is exactly where it should be). A
// Record, not a switch: a new situation without an action is a type error.
export const STEWARD_ACTION: Record<StewardSituation, StewardAction | null> = {
  "moving": null,
  "waiting-owner": null,
  "waiting-blocker": null,
  "queued": null,
  "closeable": "complete",
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
  "closeable": true,
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

export type StewardPullFacts = { url: string; merged: boolean; closed: boolean; missing: boolean; decision: string | null; replay: "due" | "asked" | null };

// Everything the classifier decides on, read fresh each pass.
export type StewardFacts = {
  identifier: string;
  status: string;
  statusType: string;
  terminal: boolean;
  // The ticket's own sub-issues: how many, how many are open, and whether every finished one is
  // canceled or a duplicate (then the parent is canceled too, sessions.ts stepGroup).
  children: { total: number; open: number; canceledOnly: boolean };
  // An unfinished blocker (linear.ts finishedIssue: done, canceled, duplicate, or in review with
  // merged pull requests).
  blocker: string | null;
  live: boolean;
  // The live roots' silence: null while one of them has an open turn, else their quiet time.
  idleMinutes: number | null;
  // A recorded wait for the owner: `live` while something can still end it, `stale` when nothing
  // can (the agent is gone and the grace has passed), `none` without one.
  ownerWait: "none" | "live" | "stale";
  // The steward already resumed these roots for this silence (once, then a verifier judges).
  resumed: boolean;
  // A thread of the ticket waits for its blockers or a slot (sessions.ts startQueued).
  queuedThread: boolean;
  queuedSince: string | null;
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
  watchdog: "none" | "active" | "exhausted";
  verifier: boolean;
  // The landed set that was already verified once, and the escalation of the current situation.
  verified: string | null;
  landedSignature: string;
  escalated: string | null;
};

// The one situation of a ticket. Exhaustive and ordered: the first match wins, and the order is
// the precedence the tests pin — a finished ticket beats everything, a claimed verifier beats the
// facts it is judging, a finished parent closes, an open pull request beats a landed one, and a
// watchdog cycle that is recovering the ticket counts as moving.
export function classifyTicket(facts: StewardFacts): StewardSituation {
  if (facts.terminal) return facts.live ? "terminal-agents" : "closed";
  if (facts.verifier) return "verifying";
  if (facts.children.total > 0 && facts.children.open === 0) return "closeable";
  if (facts.live) {
    if (facts.ownerWait === "live") return "waiting-owner";
    if (facts.idleMinutes !== null && facts.openPulls.length === 0) return facts.resumed ? "idle-unresponsive" : "idle";
    return "moving";
  }
  if (facts.ownerWait === "live") return "waiting-owner";
  if (facts.ownerWait === "stale") return "wait-stale";
  if (facts.blocker) return "waiting-blocker";
  if (facts.watchdog === "active") return "moving";
  if (facts.openPulls.length > 0) return "open-pr";
  if (facts.landedPulls.length > 0 && facts.beforeMerge === 0) return facts.verified === facts.landedSignature ? "escalated" : "landed";
  if (facts.closedPulls.some((pull) => pull.replay !== "asked")) return "closed-unmerged";
  if (facts.closedPulls.length > 0) return "escalated";
  if (facts.queuedThread) return "queued";
  if (facts.refusals >= REFUSAL_CAP) return "refused";
  if (facts.refusals > 0 && !facts.startable) return "refused";
  if (facts.restarts >= RESTART_CAP) return "restart-exhausted";
  if (facts.watchdog === "exhausted") return "watchdog-exhausted";
  if (facts.started) return facts.startable ? "stalled" : "escalated";
  return facts.startable ? "unstarted" : "escalated";
}

// --- Durable state ---------------------------------------------------------------------------------

// `claimed`: written right before the effect; a restart that finds it cannot know whether the
// effect happened (the crash gap) and never repeats it blindly. `done`/`failed`: the outcome.
export type StewardClaim = { action: StewardAction; marker: string; at: string; state: "claimed" | "done" | "failed"; result?: string };
// The verifier a pass started for a ticket, and the verdict it returned.
export type StewardVerifier = { agentId: string; marker: string; at: string };
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
  // The steward's status card on this ticket, when it has one.
  card: { commentId: string; at: string } | null;
  log: { at: string; action: string }[];
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
      verifier: null, verified: null, escalated: null, ownerAt: null, card: null, log: [],
    };
    if (identifier && identifier !== issueId) file.tickets[issueId].identifier = identifier;
    return file.tickets[issueId];
  }
}

// --- Finished tickets, their labels and the stack check --------------------------------------------

export const QUIET_DONE_MS = 60 * 60_000;
export const OLD_GHOST_MS = 24 * 60 * 60_000;
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

export type StewardVerdictKind = "close" | "follow_up" | "ask_owner" | "resume";
// What one verifier recorded through the `steward_verdict` tool: exactly one verdict.
export type StewardVerdict = {
  issueId: string;
  at: string;
  verdict: StewardVerdictKind;
  // `close`: nothing left. `follow_up`: what remains, filed as one Backlog follow-up. `ask_owner`:
  // the question and its options. `resume`: what the ticket's agent should still do.
  remaining: string | null;
  question: string | null;
  options: string[] | null;
  instruction: string | null;
};

const VERDICT_KINDS: StewardVerdictKind[] = ["close", "follow_up", "ask_owner", "resume"];

export function parseVerdict(value: unknown): StewardVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const verdict = VERDICT_KINDS.find((kind) => kind === raw.verdict);
  if (!verdict || typeof raw.issueId !== "string" || typeof raw.at !== "string") return null;
  const field = (key: string, limit: number) => typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim().slice(0, limit) : null;
  const options = Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 6) : null;
  return { issueId: raw.issueId, at: raw.at, verdict, remaining: field("remaining", 4_000), question: field("question", 2_000), options, instruction: field("instruction", 4_000) };
}

// The verifier's records, oldest first, from its own directory (ticket-mcp-source.ts
// `steward_verdict`).
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
  "landed": ["Confirm that the landed work completes the ticket and close it.", "File what remains as a follow-up ticket.", "Send the ticket's agent back to work with what is missing."],
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
    "Read the ticket and its comments (the linear_ticket tools get_ticket and get_comments), the plan document if there is one, and the landed pull requests (gh pr view and gh pr diff). Judge whether the ticket's work is complete against its description and acceptance criteria, then use the steward_verdict tool (omp shows it as linear_ticket_steward_verdict) exactly once with one verdict: close (nothing remains), follow_up with what remains, ask_owner with the question and its options, or resume with what the ticket's agent must still do. Then stop.",
  ].filter(Boolean).join("\n");
}

// --- The pass -------------------------------------------------------------------------------------

export type StewardSnapshot = {
  enabled: boolean;
  active: boolean;
  lastPassAt: string | null;
  lastError: string | null;
  counts: Record<string, number>;
  tickets: { identifier: string; situation: StewardSituation; since: string; reason: string }[];
  oldest: { identifier: string; situation: StewardSituation; since: string }[];
};

type Candidate = { issue: StewardIssue; facts: StewardFacts; situation: StewardSituation; ticket: StewardTicket };
type Pass = { actions: number; cap: number; cards: number };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasLabel(labels: { name: string }[], name: string): boolean {
  return labels.some((label) => label.name.trim().toLowerCase() === name.toLowerCase());
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

const short = (id: string) => id.slice(0, 8);

export class Steward {
  private revoked = false;
  private lastPoll = 0;
  private readonly logged = new Map<string, string>();
  private paseo: PaseoApi | null = null;
  private lastPassAt: string | null = null;
  private lastError: string | null = null;
  private enabled = true;

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
  // new round with a fresh budget (label-repair.ts ownerRetried, unchanged). Throws when the record
  // could not be written: the caller then starts nothing.
  async ownerRetried(issue: string): Promise<void> {
    await this.deps.store.update((file) => {
      const id = Object.keys(file.tickets).find((key) => key === issue || file.tickets[key].identifier === issue);
      if (!id) return null;
      const ticket = file.tickets[id];
      file.tickets[id] = { ...ticket, restarts: [], refusals: [], resumedAt: null, escalated: null, verified: null, ownerAt: this.iso() };
      console.log(`[linear-tickets] ${ticket.identifier}: started again by the owner; the steward's budgets begin anew`);
    });
  }

  // Whether a steward effect is under way for the ticket (a claimed action, a verifier): the
  // project hand-out leaves it alone, so no second start races the steward's.
  async underway(issueId: string): Promise<boolean> {
    const ticket = (await this.deps.store.read()).tickets[issueId];
    if (!ticket) return false;
    if (ticket.claim?.state === "claimed" && this.clock() - Date.parse(ticket.claim.at) < CLAIM_GRACE_MS) return true;
    return Boolean(ticket.verifier);
  }

  // The flow view for the status RPC and the browser inbox: the counts of the last pass, the
  // oldest tickets of each state, and each tracked ticket's situation.
  async snapshot(): Promise<StewardSnapshot> {
    const file = await this.deps.store.read();
    return {
      enabled: this.enabled,
      active: Boolean(this.paseo),
      lastPassAt: this.lastPassAt,
      lastError: this.lastError,
      counts: file.flow?.counts ?? {},
      tickets: Object.values(file.tickets).map((ticket) => ({ identifier: ticket.identifier, situation: ticket.situation, since: ticket.since, reason: ticket.log.at(-1)?.action ?? "" })),
      oldest: file.flow?.oldest ?? [],
    };
  }

  // The flow of the given tickets, for the browser inbox's detail pane.
  async flowFor(issueIds: string[]): Promise<Map<string, { state: StewardSituation; since: string; reason: string }>> {
    const file = await this.deps.store.read();
    const result = new Map<string, { state: StewardSituation; since: string; reason: string }>();
    for (const issueId of issueIds) {
      const ticket = file.tickets[issueId];
      if (ticket) result.set(issueId, { state: ticket.situation, since: ticket.since, reason: ticket.log.at(-1)?.action ?? "" });
    }
    return result;
  }

  // One pass, at the cadence of the dispatch poll it runs in (self-throttled to STEWARD_POLL_MS).
  // Background priority: every read and write stops at its pool's reserve; a rate limit ends the
  // pass and the next one continues.
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.revoked) return;
    this.paseo = paseo;
    await withPriority("background", "steward", async () => {
      if (this.clock() - this.lastPoll < STEWARD_POLL_MS) return;
      this.lastPoll = this.clock();
      try {
        await this.pass(paseo, settings, {});
        this.lastPassAt = this.iso();
        this.lastError = null;
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        this.lastError = message(error);
        this.once("pass", `the steward pass failed: ${this.lastError}; the next pass retries`);
      }
    });
  }

  // The paused-poll exception (README, "Auto-dispatch"): while the background share is paused, a
  // queue blocker with a failed start is still retried, at interactive priority. One filtered read,
  // and only queue-blocker tickets are acted on.
  async tickQueueBlockers(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.revoked) return;
    this.paseo = paseo;
    await withPriority("interactive", "queue-blocker steward", async () => {
      try {
        await this.pass(paseo, settings, { queueBlockers: true });
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        this.once("blockers", `the queue-blocker steward pass failed: ${message(error)}; the next one retries`);
      }
    });
  }

  private async pass(paseo: PaseoApi, settings: PluginSettings, options: { queueBlockers?: boolean }): Promise<void> {
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
    const all = await this.deps.linear.stewardIssues({ teamKeys: settings.dispatch.teamKeys, labels: labelNames, appIds, ids: Object.keys(file.tickets) });
    const issues = options.queueBlockers ? all.filter((issue) => issue.title.startsWith("Queue blocker:") && hasLabel(issue.labels, names.failed)) : all;
    if (options.queueBlockers && !issues.length) return;
    // The local facts, read once per pass.
    const [roots, records, watchdog, needsYou, handed] = await Promise.all([
      this.deps.sessions.watchdogRoots(),
      this.deps.handover.all(),
      this.deps.watchdog.read().catch(() => null),
      this.deps.needsYou.all().catch(() => [] as { parentId: string }[]),
      this.deps.watchdog.handedOver().catch(() => new Map<string, string>()),
    ]);
    const recordOf = new Map(records.map((record) => [record.issueId, record]));
    const inScope = issues.filter((issue) => (options.queueBlockers ? true : this.inScope(issue, names, appIds, recordOf, file.tickets)));
    const pulls = await this.deps.pulls([...new Set(inScope.flatMap((issue) => recordPulls(recordOf.get(issue.id))))]);
    const candidates: Candidate[] = [];
    for (const issue of inScope) {
      if (!this.alive()) return;
      if (await this.deps.owner(issue.id).catch(() => "unknown" as HostOwnership) !== "here") continue;
      const ticket = file.tickets[issue.id] ?? null;
      const facts = await this.facts(issue, { names, roots, record: recordOf.get(issue.id) ?? null, watchdog, handed, pulls, now, ticket });
      candidates.push({ issue, facts, situation: classifyTicket(facts), ticket: ticket ?? { identifier: issue.identifier, situation: "moving", since: this.iso(now), at: this.iso(now), claim: null, restarts: [], refusals: [], resumedAt: null, verifier: null, verified: null, escalated: null, ownerAt: null, card: null, log: [] } });
    }
    const pass: Pass = { actions: 0, cap: settings.steward.maxActionsPerPass, cards: 0 };
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
    // The flow view, and the status card of each head issue in scope.
    await this.flowView(candidates, pass);
    for (const candidate of candidates) {
      if (!this.alive()) return;
      if (candidate.issue.children.length) await this.statusCard(candidate, candidates, pass).catch((error: unknown) => this.once(`card:${candidate.issue.id}`, `${candidate.issue.identifier}: the steward's status card failed: ${message(error)}; the next pass retries`));
    }
  }

  // Whether a ticket is inside the steward's scope: open, of a dispatch team, and Paseo is
  // involved — delegated to a Paseo app, carrying a Paseo label, with a handover record, a
  // sub-issue or parent of one, or tracked by an earlier pass. Tickets of humans with no Paseo
  // involvement are out of scope.
  private inScope(issue: StewardIssue, names: DispatchLabels & { trigger: string }, appIds: string[], records: Map<string, HandoverRecord>, stored: Record<string, StewardTicket>): boolean {
    const terminal = CLOSED_TYPES.includes(issue.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number]);
    if (terminal && !stored[issue.id] && !records.has(issue.id)) return false;
    if (issue.delegateId && appIds.includes(issue.delegateId)) return true;
    if ([names.trigger, names.running, names.failed, names.blocked, names.needsYou, names.manual, names.hold, names.attended, names.queued].some((name) => hasLabel(issue.labels, name))) return true;
    if (records.has(issue.id) || stored[issue.id]) return true;
    return Boolean(issue.parentId && (records.has(issue.parentId) || stored[issue.parentId]));
  }

  // Everything the classifier decides on, from the pass's reads.
  private async facts(issue: StewardIssue, input: {
    names: DispatchLabels & { trigger: string };
    roots: Map<string, TicketRoots>;
    record: HandoverRecord | null;
    watchdog: WatchdogFile | null;
    handed: Map<string, string>;
    pulls: Map<string, PullState>;
    now: number;
    ticket: StewardTicket | null;
  }): Promise<StewardFacts> {
    const { names, record, now } = input;
    const terminal = CLOSED_TYPES.includes(issue.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number]);
    const group = input.roots.get(issue.id) ?? null;
    const roots = group?.roots ?? [];
    const liveRoots = roots.filter((agent) => LIVE_AGENT[agent.status] && !group!.ghosts.has(agent.id));
    const live = liveRoots.length > 0;
    const idle = live ? idleMinutesOf(liveRoots, now) : null;
    const openChildren = issue.children.filter((child) => !CLOSED_TYPES.includes(child.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number]));
    const canceledOnly = issue.children.length > 0 && issue.children.every((child) => child.statusType === "canceled" || child.statusType === "duplicate");
    const blocker = issue.blockers.find((candidate) => !finishedBlocker(candidate))?.identifier ?? null;
    const pullFacts: StewardPullFacts[] = recordPulls(record ?? undefined).map((url) => {
      const state = input.pulls.get(url);
      return { url, merged: state?.merged === true, closed: state?.closed === true, missing: state?.missing === true, decision: state?.decision ?? null, replay: state?.replay ?? null };
    });
    const openPulls = pullFacts.filter((pull) => !pull.merged && !pull.closed && !pull.missing);
    const landedPulls = pullFacts.filter((pull) => pull.merged);
    const closedPulls = pullFacts.filter((pull) => pull.closed && !pull.merged);
    const beforeMerge = landedPulls.length ? await this.deps.manualTasks.openBlockers(issue.id).then((tasks) => tasks.length).catch(() => 0) : 0;
    const waiting = record?.waiting ?? null;
    const ownerWait = waiting ? await this.waitState(issue, waiting, liveRoots, input, now) : "none";
    const thread = await this.deps.sessions.watchdogThread(issue.id).catch(() => null);
    const queuedThread = Boolean(thread?.queued) || await this.deps.sessions.threadQueued(issue.id).catch(() => false);
    const cycle = input.watchdog?.tickets[issue.id] ?? null;
    const stripAnchor = (record?.agentId ?? "").startsWith(STEWARD_ANCHOR);
    const started = Boolean(record && record.agentId && !stripAnchor) || roots.length > 0 || pullFacts.length > 0;
    const held = [names.hold, names.manual, names.needsYou].find((name) => hasLabel(issue.labels, name)) ?? null;
    const resumedAt = input.ticket?.resumedAt ? Date.parse(input.ticket.resumedAt) : NaN;
    const quietSince = live ? now - (Math.max(...liveRoots.map((agent) => Date.parse(agent.updatedAt) || 0, now - (idle ?? 0) * 60_000))) : 0;
    return {
      identifier: issue.identifier,
      status: issue.status,
      statusType: issue.statusType,
      terminal,
      children: { total: issue.children.length, open: openChildren.length, canceledOnly },
      blocker,
      live,
      idleMinutes: idle,
      ownerWait,
      resumed: Number.isFinite(resumedAt) && resumedAt >= quietSince,
      queuedThread,
      queuedSince: input.ticket?.situation === "queued" || input.ticket?.situation === "queued-too-long" ? input.ticket.since : null,
      openPulls,
      landedPulls,
      closedPulls,
      beforeMerge,
      started,
      startable: !terminal && !held && !hasLabel(issue.labels, DO_NOT_MERGE) && restartable(issue.status, issue.statusType) && !blocker && !waiting && !queuedThread,
      restarts: recent(input.ticket?.restarts ?? [], now).length,
      refusals: (input.ticket?.refusals ?? []).filter((entry) => Number.isFinite(Date.parse(entry.at)) && now - Date.parse(entry.at) < STEWARD_WINDOW_MS).length,
      lastRefusal: input.ticket?.refusals?.at(-1)?.reason ?? null,
      watchdog: cycle?.cycle ? "active" : cycle?.exhausted ? "exhausted" : "none",
      verifier: Boolean(input.ticket?.verifier),
      verified: input.ticket?.verified ?? null,
      landedSignature: landedPulls.map((pull) => pull.url).sort().join(","),
      escalated: input.ticket?.escalated?.key ?? null,
    };
  }

  // A recorded wait for the owner: `live` while something can still end it, `stale` when nothing
  // can (writeback.ts reconcileWaiting, folded in here). A pending request on a live agent is
  // answerable; a live agent without one can still take its next turn (a `turn-end` wait stays);
  // with no live agent the wait is over unless it is minutes old (a daemon that just restarted
  // still lists its agents) or its ticket was handed to the peer host.
  private async waitState(issue: StewardIssue, waiting: { kind?: string; at?: string }, liveRoots: WatchedAgent[], input: { handed: Map<string, string>; record: HandoverRecord | null; roots: Map<string, TicketRoots> }, now: number): Promise<"live" | "stale"> {
    if (liveRoots.some((agent) => (agent.pendingPermissions?.length ?? 0) > 0)) return "live";
    if (liveRoots.length > 0) return waiting.kind === "request" ? "stale" : "live";
    const at = Date.parse(waiting.at ?? input.record?.updatedAt ?? "") || 0;
    if (now - at < WAIT_NO_AGENT_GRACE_MS) return "live";
    const newest = (input.roots.get(issue.id)?.roots ?? []).reduce((latest, agent) => Math.max(latest, Date.parse(agent.createdAt) || 0), 0);
    const handed = input.handed.get(issue.id);
    if (handed && newest <= (Date.parse(handed) || 0)) return "live";
    return "stale";
  }

  // One ticket: record its situation, then take its one action (if the cap allows it).
  private async ticket(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, pass: Pass, now: number): Promise<void> {
    const { issue, facts, situation } = candidate;
    const previous = candidate.ticket;
    // The situation's age: kept while it does not change, so the grace and the flow view can tell a
    // ticket that just got stuck from one that has been for hours.
    const since = previous.situation === situation ? previous.since : this.iso(now);
    const moved = ["moving", "waiting-owner", "waiting-blocker", "queued", "closeable", "closed"].includes(situation);
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      // A ticket that moved on by itself starts its repairs with a fresh budget.
      if (previous.situation !== situation && moved) {
        ticket.restarts = [];
        ticket.refusals = [];
        ticket.resumedAt = null;
        ticket.escalated = null;
      }
      ticket.situation = situation;
      ticket.since = since;
      ticket.at = this.iso(now);
      if (ticket.claim?.state === "claimed" && this.clock() - Date.parse(ticket.claim.at) >= CLAIM_GRACE_MS) {
        ticket.claim = { ...ticket.claim, state: "failed", result: "outcome unknown after a restart" };
      }
    });
    const stored = (await this.deps.store.read()).tickets[issue.id];
    // A claim whose outcome is unknown is never repeated blindly: the ticket waits for the grace.
    if (stored?.claim?.state === "claimed") {
      this.once(`claim:${issue.id}`, `${issue.identifier}: the steward's ${stored.claim.action} is claimed but has no outcome yet; it is not repeated`);
      return;
    }
    // A ticket already escalated for this reason waits for the owner, whatever its situation now is.
    const key = situation === "escalated" ? (stored?.escalated?.key ?? "escalated") : situation;
    const ownerNewer = Boolean(stored?.ownerAt && stored.escalated && Date.parse(stored.ownerAt) > Date.parse(stored.escalated.at));
    const escalated = Boolean(stored?.escalated && stored.escalated.key === key && !ownerNewer);
    const action = situation === "escalated" || escalated ? "escalate" : STEWARD_ACTION[situation];
    if (!action) {
      await this.verdict(paseo, settings, candidate, now);
      return;
    }
    if (!this.enabled) return;
    // A defect is acted on after the grace, so a start or a thread that is about to move the ticket
    // is waited for; the invariant's five states need nothing.
    if (isDefect(situation) && now - Date.parse(since) < DEFECT_GRACE_MS) return;
    if (escalated) {
      this.once(`escalated:${issue.id}`, `${issue.identifier}: the steward already asked the owner (${key}); it waits for their answer`);
      return;
    }
    const heavy = action === "start" || action === "restart" || action === "succeed" || action === "resume" || action === "verify";
    if (heavy && pass.actions >= pass.cap) {
      this.once(`cap:${issue.identifier}`, `${issue.identifier}: the steward's per-pass action cap (${pass.cap}) is used up; its ${situation} waits for the next pass`);
      return;
    }
    if (heavy) pass.actions++;
    await this.act(paseo, settings, names, candidate, situation, action, now);
  }

  // The one action of a ticket per pass, claimed before its effect.
  private async act(paseo: PaseoApi, settings: PluginSettings, names: DispatchLabels & { trigger: string }, candidate: Candidate, situation: StewardSituation, action: StewardAction, now: number): Promise<void> {
    const { issue, facts } = candidate;
    const claim: StewardClaim = { action, marker: `${action}:${randomUUID().slice(0, 8)}`, at: this.iso(now), state: "claimed" };
    const written = await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      if (ticket.claim?.state === "claimed" && this.clock() - Date.parse(ticket.claim.at) < CLAIM_GRACE_MS) return false;
      ticket.claim = claim;
      return true;
    });
    if (!written) return;
    const settle = async (state: "done" | "failed", result?: string) => {
      await this.deps.store.update((file) => {
        const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
        ticket.claim = { ...claim, state, ...(result ? { result: result.slice(0, 500) } : {}) };
        ticket.log = [...ticket.log, { at: this.iso(), action: `${action}: ${state}${result ? ` (${result.slice(0, 200)})` : ""}` }].slice(-LOG_LIMIT);
      });
    };
    try {
      switch (action) {
        case "restart":
        case "start": {
          const result = await this.restart(paseo, names, candidate, now);
          await settle(result.state, result.reason);
          if (result.permanent) await this.escalate(candidate, result.reason);
          return;
        }
        case "succeed": {
          const result = await this.succeed(candidate);
          await settle(result.state, result.reason);
          if (result.permanent) await this.escalate(candidate, result.reason);
          return;
        }
        case "resume": {
          const root = await this.liveRoot(paseo, issue.id);
          if (!root) return settle("failed", "the live agent is gone");
          const outcome = await this.deps.sessions.prompt(root.id, resumeText(issue.identifier, facts.idleMinutes ?? 0));
          if (outcome === "busy" || outcome === "waiting" || outcome === "unavailable") return settle("failed", `the resume did not go out (${outcome})`);
          await this.deps.store.update((file) => {
            const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
            ticket.resumedAt = this.iso();
          });
          return settle("done", `resumed ${short(root.id)}`);
        }
        case "verify": {
          const result = await this.verify(paseo, settings, candidate, now);
          await settle(result.state, result.reason);
          return;
        }
        case "complete":
        case "cancel": {
          await this.close(paseo, candidate, action === "cancel" || (facts.children.total > 0 && facts.children.canceledOnly));
          return settle("done", action);
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
          await this.escalate(candidate, undefined);
          return settle("done", "escalated");
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
  // ticket's start gate, admission, the recorded branch. The restart counts against the cap before
  // it runs: a start that fails has still been tried.
  private async restart(paseo: PaseoApi, names: DispatchLabels & { trigger: string }, candidate: Candidate, now: number): Promise<{ state: "done" | "failed"; reason: string; permanent: boolean }> {
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
        const working = [...agents.live, ...agents.stopped].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return working ? `an agent works on ${issue.identifier} again (agent ${short(working.id)} is ${working.status})` : null;
      },
    }).catch((error: unknown): RestartResult => ({ kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }));
    if (result.kind === "started" || result.kind === "live") {
      await this.refused(issue, now, null);
      return { state: "done", reason: result.kind === "started" ? `started agent ${short(result.agentId)}` : "an agent works on it again", permanent: false };
    }
    if (result.kind === "forwarded") return { state: "done", reason: `handed to ${result.peer}`, permanent: false };
    if (result.kind === "skipped") return { state: "failed", reason: "the ticket is deleted or paused for deletion", permanent: true };
    if (result.kind === "deferred") {
      // A deferral names a wait (admission, a gate, a route, a fresh agent): it is retried, and only
      // escalated after REFUSAL_CAP refusals.
      const count = await this.refused(issue, now, result.reason);
      return { state: "failed", reason: `the start is refused${count > 1 ? ` ${count} times` : ""}: ${result.reason}`, permanent: count >= REFUSAL_CAP };
    }
    const reason = message(result.error);
    const count = await this.refused(issue, now, reason);
    const permanent = /^No Paseo project is mapped|^No provider has been chosen|^Could not pick a base branch|^This ticket is paused/.test(reason) || count >= REFUSAL_CAP;
    console.error(`[linear-tickets] ${issue.identifier}: steward: restart ${attempt} of ${RESTART_CAP} failed: ${reason}`);
    return { state: "failed", reason: `restart ${attempt} failed: ${reason}`, permanent };
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
  // claimed by the session router right before its start, so a failed start is tried again.
  private async succeed(candidate: Candidate): Promise<{ state: "done" | "failed"; reason: string; permanent: boolean }> {
    const { issue, facts } = candidate;
    const pull = facts.openPulls[0] ?? facts.closedPulls[0];
    if (!pull) return { state: "failed", reason: "no pull request to continue", permanent: true };
    const now = this.clock();
    const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id) ?? null;
    const lead = facts.openPulls.length > 0 ? successorText(issue.identifier, pull) : replayText(issue.identifier, pull, record?.worktreePath ?? null);
    const attempt = facts.restarts + 1;
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      ticket.restarts = [...recent(ticket.restarts, now), this.iso(now)];
    });
    const result: Succession = await this.deps.sessions.succeed(issue.id, issue.identifier, record?.agentId ?? null, lead, async () => {
      console.log(`[linear-tickets] ${issue.identifier}: steward: successor ${attempt} of ${RESTART_CAP}`);
    }).catch((error: unknown): Succession => ({ kind: "impossible", reason: message(error) }));
    if (result.kind === "started" || result.kind === "live") {
      await this.refused(issue, now, null);
      return { state: "done", reason: result.kind === "started" ? `started a successor ${short(result.agent.id)}` : "a live agent takes the pull request over", permanent: false };
    }
    if (result.kind === "wait") {
      const count = await this.refused(issue, now, result.reason);
      return { state: "failed", reason: `the successor waits: ${result.reason}`, permanent: count >= REFUSAL_CAP };
    }
    return { state: "failed", reason: `no successor can start: ${successionReason(result)}`, permanent: true };
  }

  // The verifier for a landed stack: a short-lived cheap agent with the fact sheet, which records
  // exactly one verdict through its ticket tool. One verifier per ticket, claim-journaled.
  private async verify(paseo: PaseoApi, settings: PluginSettings, candidate: Candidate, now: number): Promise<{ state: "done" | "failed"; reason: string }> {
    const { issue, facts } = candidate;
    const gate = this.deps.launcher.gate(issue.id);
    if (!gate) return { state: "failed", reason: "a launch for this ticket is under way" };
    try {
      const agents = await classifyTicketAgents(paseo, issue.id, now, this.deps.inspect);
      const working = [...agents.live, ...agents.stopped][0];
      if (working) return { state: "failed", reason: `an agent works on the ticket again (${short(working.id)})` };
      const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id) ?? null;
      const started = await this.deps.starter.start(issue.id, paseo, settings, {
        retryHint: "start the verifier again",
        resumeOnly: true,
        labels: { [STEWARD_VERIFIER_LABEL]: "verifier" },
        verifier: { brief: verifierBrief(issue, facts, record) },
      });
      await this.deps.store.update((file) => {
        const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
        ticket.verifier = { agentId: started.agentId, marker: randomUUID().slice(0, 8), at: this.iso(now) };
      });
      console.log(`[linear-tickets] ${issue.identifier}: steward: started verifier ${short(started.agentId)} for the landed stack`);
      return { state: "done", reason: `verifier ${short(started.agentId)}` };
    } catch (error) {
      return { state: "failed", reason: `the verifier could not start: ${message(error)}` };
    } finally {
      gate.release();
    }
  }

  // A verifier's verdict, applied: close (with what the verifier says must remain, if anything),
  // follow_up, ask_owner or resume. Read from the verifier's own record directory.
  private async verdict(paseo: PaseoApi, settings: PluginSettings, candidate: Candidate, now: number): Promise<void> {
    const { issue } = candidate;
    const verifier = candidate.ticket.verifier;
    if (!verifier) return;
    const read = this.deps.verdicts ?? ((issueId: string) => readVerdicts(join(paseoHome(), "linear-tickets", STEWARD_VERDICT_DIRECTORY, issueId)));
    const verdict = (await read(issue.id).catch(() => [] as StewardVerdict[])).filter((entry) => Date.parse(entry.at) >= Date.parse(verifier.at)).at(-1) ?? null;
    if (!verdict && now - Date.parse(verifier.at) <= VERIFY_TIMEOUT_MS) return;
    await this.archiveAgent(paseo, verifier.agentId);
    const clear = () => this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
      ticket.verifier = null;
      ticket.verified = candidate.facts.landedSignature || null;
    });
    if (!verdict) {
      await clear();
      await this.escalate(candidate, "the verifier did not report within 45 minutes");
      return;
    }
    console.log(`[linear-tickets] ${issue.identifier}: the verifier's verdict is ${verdict.verdict}`);
    switch (verdict.verdict) {
      case "close":
      case "follow_up": {
        await clear();
        if (verdict.verdict === "follow_up") await this.followUp(issue, verdict.remaining ?? "The verifier reported remaining work without naming it.");
        await this.close(paseo, candidate, false);
        return;
      }
      case "ask_owner": {
        await clear();
        await this.escalate(candidate, verdict.question ?? "the verifier asked the owner for a decision", verdict.options ?? undefined);
        return;
      }
      case "resume": {
        await this.deps.store.update((file) => {
          const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso(now));
          ticket.verifier = null;
        });
        const record = (await this.deps.handover.all()).find((item) => item.issueId === issue.id) ?? null;
        const instruction = verdict.instruction ?? "The verifier found the ticket's work incomplete; continue it.";
        const result = await this.deps.sessions.succeed(issue.id, issue.identifier, record?.agentId ?? null, instruction, async () => {}).catch((error: unknown): Succession => ({ kind: "impossible", reason: message(error) }));
        if (result.kind === "started" || result.kind === "live") {
          console.log(`[linear-tickets] ${issue.identifier}: steward: the verifier asked for more work; a successor continues it`);
          return;
        }
        await this.escalate(candidate, `the verifier asked for more work but no successor could start: ${successionReason(result)}`);
        return;
      }
    }
  }

  // One Backlog follow-up for what a verifier says remains, related to the ticket (the
  // plan-follow-ups path's shape: a Backlog ticket in the origin's project).
  private async followUp(issue: StewardIssue, remaining: string): Promise<void> {
    const created = await this.deps.linear.createIssue({
      teamId: issue.teamId,
      title: `Follow-up for ${issue.identifier}`.slice(0, 80),
      description: `${remaining}\n\nFiled by Paseo's ticket steward from a verifier's verdict on ${issue.identifier}.`,
      backlog: true,
      ...(issue.projectId ? { projectId: issue.projectId } : {}),
    });
    await this.deps.linear.relate(created.id, issue.id, "related").catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: relating the follow-up ${created.identifier} failed: ${message(error)}`));
    await this.deps.linear.comment(issue.id, `A verifier found the ticket's work complete and its remaining work was filed as ${created.identifier}: ${remaining.slice(0, 500)}`).catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: the follow-up comment failed: ${message(error)}`));
  }

  // The parent of finished sub-issues: complete (or cancel when everything was canceled), then
  // archive its agents. Also the close of a landing verifier's verdict.
  private async close(paseo: PaseoApi, candidate: Candidate, canceled: boolean): Promise<void> {
    const { issue, facts } = candidate;
    const list = issue.children.map((child) => `- ${child.identifier}: ${child.status}`).join("\n");
    if (canceled) await this.deps.linear.cancel(issue.id, `Every sub-issue was canceled, so ${issue.identifier} is canceled too.\n\n${list}`);
    else await this.deps.linear.complete(issue.id);
    await this.deps.doneTickets.written(issue.id, canceled ? "canceled" : "completed", this.clock());
    const why = canceled
      ? "every sub-issue is finished and canceled"
      : facts.landedPulls.length ? `its pull requests landed (${facts.landedPulls.map((pull) => pull.url).join(", ")})` : "every sub-issue is finished";
    await this.deps.linear.comment(issue.id, `Paseo's ticket steward completed this ticket: ${why}.${list ? `\n\n${list}` : ""}`).catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: the completion comment failed: ${message(error)}`));
    // The ticket's agents hold no slot any more: archive them, in the ticket's turn and under its
    // start gate like every recovery.
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
      const stack = await this.deps.stacked(issue.id).catch(() => "unknown" as StackState);
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
        const core = await this.deps.linear.issueCore(issue.id).catch(() => null);
        if (core && hasLabel(core.labels, names.running)) await this.deps.linear.removeLabel(issue.id, names.running, core.labels).catch(() => {});
        await this.deps.labels.remove(agent.id);
      }
      void settings;
      return archived ? { state: "done", reason: `archived ${archived} quiet agent(s) of ${state.status}` } : { state: "failed", reason: "the agent was active again" };
    } finally {
      gate.release();
    }
  }

  // The archive of one agent: refresh first, then archive. A gone agent is nothing to do.
  private async archiveAgent(paseo: PaseoApi, agentId: string): Promise<void> {
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
    const roots = await this.rootsOf(paseo, issueId);
    return roots.filter((agent) => LIVE_AGENT[agent.status]).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
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
      ticket.log = [...ticket.log, { at: this.iso(), action: `escalated: ${why.slice(0, 200)}` }].slice(-LOG_LIMIT);
    });
    console.log(`[linear-tickets] ${issue.identifier}: steward: asked the owner to decide (${situation}: ${why})`);
  }

  // The watchdog's exhausted recovery (watchdog.ts flushReports): its terminal step is the same
  // owner-visible escalation the steward's own pass posts -- the reason, the options for that
  // situation, and the mark -- instead of a bare owner mention. Deduplication is the watchdog's
  // (its report is queued once per cycle).
  async escalateExhausted(issueId: string, identifier: string, reason: string): Promise<void> {
    const options = optionsFor("watchdog-exhausted");
    const body = [
      `**Paseo's ticket steward cannot move this ticket on** (watchdog-exhausted): ${reason}`,
      "",
      "Options:",
      options.map((option, index) => `${String.fromCharCode(97 + index)}) ${option}`).join("\n"),
      "",
      "Its automatic recovery stops here until one of them is taken; adding the trigger label again gives the steward a fresh budget.",
      "",
      "<!-- paseo:steward:watchdog-exhausted -->",
    ].join("\n");
    await this.deps.writeback.escalate(issueId, identifier, `the ticket steward cannot move ${identifier} on (watchdog-exhausted)`, body);
  }

  // The flow view (README, "Ticket steward"): the counts of the last pass and the oldest tickets of
  // each state, for the browser inbox and the status RPC.
  private async flowView(candidates: Candidate[], pass: Pass): Promise<void> {
    void pass;
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

  // The status card of a head issue: its members and what each of them is (the steward's state, or
  // its workflow state when the steward has none), refreshed at most every STATUS_CARD_MS and for
  // at most STATUS_CARDS_PER_PASS head issues per pass.
  private async statusCard(candidate: Candidate, candidates: Candidate[], pass: Pass): Promise<void> {
    const { issue } = candidate;
    if (pass.cards >= STATUS_CARDS_PER_PASS) return;
    const stored = (await this.deps.store.read()).tickets[issue.id];
    if (stored?.card && this.clock() - Date.parse(stored.card.at) < STATUS_CARD_MS) return;
    pass.cards++;
    const byIssue = new Map(candidates.map((item) => [item.issue.id, item]));
    const lines = issue.children.map((child) => `- ${child.identifier}: ${byIssue.get(child.id)?.situation ?? child.status}`);
    const open = issue.children.filter((child) => !CLOSED_TYPES.includes(child.statusType.trim().toLowerCase() as typeof CLOSED_TYPES[number])).length;
    const body = [
      `**Paseo's ticket steward: ${issue.children.length - open} of ${issue.children.length} sub-issues finished.**${open ? ` ${issue.identifier} closes when all are finished.` : " It is complete."}`,
      "",
      ...lines,
      "",
      CARD_MARK,
    ].join("\n");
    const commentId = await this.deps.linear.upsertComment(issue.id, body, stored?.card?.commentId ?? null);
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issue.id, issue.identifier, this.iso());
      ticket.card = { commentId, at: this.iso() };
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
    "queued-too-long": "it has waited in the queue for more than a day",
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
