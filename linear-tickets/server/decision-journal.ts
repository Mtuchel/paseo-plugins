import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { planHash } from "./review-outcome";
import { paseoHome } from "./ticket-mcp";
import { releaseLease, takeLease } from "./watchdog";

// The decision journal (README, "Decision journal"): every owner decision on a plan — the review
// inbox, Plannotator's page (an agent's own review or a parked plan on the central host), the
// Linear panel, the risk policy's approvals — is written here before anything is done about it,
// and the bridge's worker (plannotator.ts) carries it out step by step until every step went
// through. One private file per entry in $PASEO_HOME/linear-tickets/plannotator/decisions/.
//
// Contract for the other parts of the plugin (and TUC-1289/1290/747): the journal is
// authoritative. An agent with a `deciding`, `uncertain` or `pending` attempt, an open `unbound`
// report or an unresolved `conflict` has its decision in progress or waiting for the owner,
// whatever its review record or parked record says. A decision counts as received at `pending`
// and as carried out at `applied`.
//
// Only the holder of the lease `decisions/.lease` writes entries (one plugin instance per host;
// a reloaded instance takes over once the old one drained, a dead process's lease is taken over).

export type DecisionSource = "inbox" | "linear-panel" | "plannotator-page" | "parked-page" | "risk-policy" | "recovered";
// `later` and `split` approve the plan but close Plannotator with a send-back (`transport`).
export type DecisionMode = "approve" | "send-back" | "later" | "split";
// How the decision is carried out, fixed when it is accepted and never rediscovered.
export type DecisionRoute = "parked" | "live" | "work-order" | "later" | "split" | "none";
// deciding: journaled, Plannotator's answer outstanding; never applied.
// uncertain: Plannotator's answer was lost (or the process died while waiting for it).
// pending: accepted, being carried out. applied: every step went through. void: never applied.
export type AttemptState = "deciding" | "uncertain" | "pending" | "applied" | "void";

export type ParkedSnapshot = { issueId: string; identifier: string; plan: string; model: string | null; parkedAt: string; reasons?: string[]; line?: string };

// What the bridge knows locally about the agent when a decision is accepted.
export type RouteSnapshot = {
  route: DecisionRoute;
  issueId: string | null;
  identifier: string | null;
  sessionId: string | null;
  model?: string | null;
  provider?: string | null;
  planPolicy?: string | null;
  runId?: string | null;
  parked?: ParkedSnapshot;
};

// One review generation: a review is told apart by its address and the time it opened, since
// Plannotator reuses ports. `event`: the name of its `opened` event file (write order).
export type ReviewGeneration = {
  kind: "review";
  id: string;
  agentId: string;
  localUrl: string;
  openedAt: string;
  planHash: string | null;
  parked: boolean;
  event?: string;
  legacy?: true;
  at: string;
};

export type DecisionAttempt = {
  kind: "attempt";
  id: string;
  reviewId: string;
  reviewOpenedAt: string;
  at: string;
  acceptedAt?: string;
  agentId: string;
  planHash: string;
  planContent: string;
  // The owner's outcome, and the one sent to (or reported by) Plannotator.
  approved: boolean;
  transport: boolean;
  mode: DecisionMode;
  feedback?: string;
  source: DecisionSource;
  state: AttemptState;
  // Event files that reported this decision.
  reports: string[];
  // Steps that went through, with their results (and reserved Linear ids).
  steps: Record<string, unknown>;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  appliedAt?: string;
  voidReason?: string;
  // An unresolved conflict that holds this attempt.
  pausedBy?: string;
} & RouteSnapshot;

// The plugin closing a review itself (retiring a planner, a tier send-back, a work order): its
// report is a confirmation, never the owner's decision.
export type ReviewClosing = { kind: "closing"; id: string; reviewId: string; agentId: string; transport: boolean; reason: string; reports: string[]; at: string };

// A report from Plannotator's omp extension whose plan text is not the text of the review it would
// bind to. Waits for the owner (Carry it out / Drop it).
export type UnboundReport = {
  kind: "unbound";
  id: string;
  agentId: string;
  at: string;
  approved: boolean;
  feedback?: string;
  planContent: string;
  event: string;
  state: "open" | "carried" | "dropped";
  attemptId?: string;
  resolvedAt?: string;
};

export type ConflictReport = { event: string; at: string; feedback?: string; planContent?: string };
// Plannotator reported the other decision than an accepted attempt (or a closing) of the review.
export type DecisionConflict = {
  kind: "conflict";
  id: string;
  reviewId: string;
  reviewOpenedAt: string;
  agentId: string;
  attemptId: string | null;
  closingId: string | null;
  // The attempt was applied already: only Dismiss remains.
  afterApply: boolean;
  reportOutcome: boolean;
  report: ConflictReport;
  at: string;
  resolution?: "keep" | "other" | "dismiss";
  resolvedAt?: string;
};

export type JournalEntry = ReviewGeneration | DecisionAttempt | ReviewClosing | UnboundReport | DecisionConflict;
export type ResolveAction = "carry-out" | "drop" | "keep" | "other" | "dismiss";

// What the inbox lists under "Being applied".
export type ApplyingEntry =
  | { kind: "attempt"; entry: DecisionAttempt; review: ReviewGeneration | null }
  | { kind: "unbound"; entry: UnboundReport; review: ReviewGeneration | null }
  | { kind: "conflict"; entry: DecisionConflict; attempt: DecisionAttempt | null; review: ReviewGeneration | null }
  | { kind: "unreadable"; file: string };

export class FencedError extends Error {
  constructor() { super("The plugin is restarting; try again in a few seconds."); }
}

// The review already has a decision (or a closing, or a conflict waiting for the owner).
export class DecisionPendingError extends Error {
  constructor(message = "Already decided; it is being applied.") { super(message); }
}

// An owner resolution on an entry whose state changed since the inbox listed it.
export class StaleResolutionError extends Error {}

const QUICK_ATTEMPTS = 20;
const QUICK_RETRY_MS = 3_000;
const SLOW_RETRY_MS = 60_000;
export const JOURNAL_KEEP_MS = 60 * 24 * 60 * 60 * 1000;
const OPEN_STATES: ReadonlySet<AttemptState> = new Set(["deciding", "uncertain"]);
const ACCEPTED_STATES: ReadonlySet<AttemptState> = new Set(["pending", "applied"]);

export function decisionsDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "plannotator", "decisions");
}

export function reviewEntryId(agentId: string, localUrl: string, openedAt: string): string {
  return `review-${agentId.replace(/[^0-9A-Za-z-]/g, "")}-${createHash("sha256").update(`${localUrl}\n${openedAt}`).digest("hex").slice(0, 32)}`;
}

// When the next try of an attempt that failed `attempts` times is due.
export function retryDelay(attempts: number): number {
  return attempts <= QUICK_ATTEMPTS ? QUICK_RETRY_MS : SLOW_RETRY_MS;
}

// The order of a review generation among the event files (names start with their write time).
function reviewOrder(review: ReviewGeneration): string {
  return review.event ?? `${String(Date.parse(review.openedAt) || 0).padStart(13, "0")}-`;
}

function compactTime(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 17).padEnd(17, "0");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } catch { /* not every platform syncs a directory */ } finally { await handle.close(); }
}

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
}

export type AttemptInput = {
  review: ReviewGeneration;
  agentId: string;
  planContent: string;
  approved: boolean;
  transport?: boolean;
  mode?: DecisionMode;
  feedback?: string;
  source: DecisionSource;
  state: "deciding" | "pending";
  snapshot: RouteSnapshot;
  at?: string;
};

export type ReportInput = {
  event: string;
  agentId: string;
  approved: boolean;
  feedback?: string;
  planContent?: string;
  at: string;
  review: ReviewGeneration;
  source: "plannotator-page" | "parked-page";
  // Exact binding (the central host names its review): the plan text is not compared.
  exact: boolean;
  snapshot: () => Promise<RouteSnapshot>;
};

export type ReportOutcome = "recorded" | "confirmed" | "conflict" | "unbound" | "replay";

export class DecisionJournal {
  private readonly entries = new Map<string, JournalEntry>();
  private readonly files = new Map<string, string>();
  private unreadable: string[] = [];
  private loaded = false;
  private held = false;
  private stopping = false;
  private acquiring: Promise<boolean> | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly instance = randomUUID();

  constructor(readonly directory = decisionsDirectory(), private readonly now: () => number = Date.now) {}

  // Whether this instance may write and carry out decisions now.
  get active(): boolean {
    return this.held && !this.stopping;
  }

  get closing(): boolean {
    return this.stopping;
  }

  // Takes the lease (false while another instance holds it) and loads the entries. A `deciding`
  // attempt found now was left by an instance that is gone: its answer is unknown.
  acquire(): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    if (this.held) return Promise.resolve(true);
    return this.acquiring ??= (async () => {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (!await takeLease(`${this.directory}/`, this.instance)) return false;
        if (this.stopping) { await releaseLease(`${this.directory}/`, this.instance); return false; }
        await this.load();
        this.held = true;
        for (const entry of [...this.entries.values()]) {
          if (entry.kind === "attempt" && entry.state === "deciding") await this.write({ ...entry, state: "uncertain", lastError: "The plugin stopped before Plannotator answered." });
        }
        return true;
      } catch (error) {
        console.error(`[linear-tickets] opening the decision journal failed: ${error instanceof Error ? error.message : error}`);
        if (!this.held) await releaseLease(`${this.directory}/`, this.instance);
        return false;
      } finally { this.acquiring = null; }
    })();
  }

  // Graceful stop (plugin reload): nothing new is admitted, everything admitted finishes (each
  // external call is bounded), and only then is the lease released for the next instance.
  async stop(): Promise<void> {
    this.stopping = true;
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    if (this.acquiring) await this.acquiring.catch(() => false);
    if (this.held) await releaseLease(`${this.directory}/`, this.instance);
    this.held = false;
  }

  // Admits one operation (a producer's decision, an intake pass, a worker step) or refuses it
  // while the journal is not held or stopping.
  run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.active) return Promise.reject(new FencedError());
    const running = work();
    this.inFlight.add(running);
    const done = () => { this.inFlight.delete(running); };
    running.then(done, done);
    return running;
  }

  // Every check-then-create for one review runs under its lock.
  withReview<T>(reviewId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(reviewId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(reviewId, next);
    const release = () => { if (this.locks.get(reviewId) === next) this.locks.delete(reviewId); };
    next.then(release, release);
    return next;
  }

  // --- Reading ------------------------------------------------------------------------------

  all(): JournalEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): JournalEntry | null {
    return this.entries.get(id) ?? null;
  }

  attempt(id: string): DecisionAttempt | null {
    const entry = this.entries.get(id);
    return entry?.kind === "attempt" ? entry : null;
  }

  review(id: string): ReviewGeneration | null {
    const entry = this.entries.get(id);
    return entry?.kind === "review" ? entry : null;
  }

  attempts(reviewId?: string): DecisionAttempt[] {
    return this.all().filter((entry): entry is DecisionAttempt => entry.kind === "attempt" && (!reviewId || entry.reviewId === reviewId));
  }

  // The agent's latest review generation, optionally only those written before an event file and
  // only on one address.
  latestReview(agentId: string, options: { before?: string; localUrl?: string } = {}): ReviewGeneration | null {
    let found: ReviewGeneration | null = null;
    for (const entry of this.entries.values()) {
      if (entry.kind !== "review" || entry.agentId !== agentId) continue;
      if (options.localUrl && entry.localUrl !== options.localUrl) continue;
      if (options.before && reviewOrder(entry) >= options.before) continue;
      if (!found || reviewOrder(entry) > reviewOrder(found)) found = entry;
    }
    return found;
  }

  // The generation on this address that opened at or after `since` (the central host's review,
  // named by its server's address and start time): the earliest such one.
  reviewServedSince(agentId: string, localUrl: string, since: string): ReviewGeneration | null {
    let found: ReviewGeneration | null = null;
    for (const entry of this.entries.values()) {
      if (entry.kind !== "review" || entry.agentId !== agentId || entry.localUrl !== localUrl || entry.openedAt < since) continue;
      if (!found || entry.openedAt < found.openedAt) found = entry;
    }
    return found;
  }

  // Everything the owner sees under "Being applied".
  applying(): ApplyingEntry[] {
    const rows: ApplyingEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.kind === "attempt" && (entry.state === "pending" || entry.state === "uncertain")) rows.push({ kind: "attempt", entry, review: this.review(entry.reviewId) });
      if (entry.kind === "unbound" && entry.state === "open") rows.push({ kind: "unbound", entry, review: this.latestReview(entry.agentId) });
      if (entry.kind === "conflict" && !entry.resolution) rows.push({ kind: "conflict", entry, attempt: entry.attemptId ? this.attempt(entry.attemptId) : null, review: this.review(entry.reviewId) });
    }
    for (const file of this.unreadable) rows.push({ kind: "unreadable", file });
    return rows;
  }

  // Whether the agent has a decision in progress or waiting for the owner.
  busy(agentId: string): boolean {
    return this.all().some((entry) => entry.agentId === agentId && (
      entry.kind === "attempt" && (OPEN_STATES.has(entry.state) || entry.state === "pending")
      || entry.kind === "unbound" && entry.state === "open"
      || entry.kind === "conflict" && !entry.resolution));
  }

  // Attempts for the worker: pending ones that are due and first in their ticket's order, and
  // uncertain ones (re-evaluated every sweep).
  due(): { pending: DecisionAttempt[]; uncertain: DecisionAttempt[] } {
    const now = this.now();
    const accepted = this.attempts().filter((entry) => entry.state === "pending").sort((a, b) => (a.acceptedAt ?? a.at).localeCompare(b.acceptedAt ?? b.at) || a.id.localeCompare(b.id));
    const first = new Map<string, DecisionAttempt>();
    for (const entry of accepted) {
      const key = entry.issueId ?? `agent:${entry.agentId}`;
      if (!first.has(key)) first.set(key, entry);
    }
    const pending = [...first.values()].filter((entry) => !entry.pausedBy && (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now));
    const uncertain = this.attempts().filter((entry) => entry.state === "uncertain");
    return { pending, uncertain };
  }

  // --- Writing ------------------------------------------------------------------------------

  // The review generation for an `opened` event (or a decision on a review that predates the
  // journal: `legacy`). Replay-safe: the same generation always maps to the same entry.
  async ensureReview(input: { agentId: string; localUrl: string; openedAt: string; planHash?: string | null; parked?: boolean; event?: string; legacy?: boolean }): Promise<ReviewGeneration> {
    const id = reviewEntryId(input.agentId, input.localUrl, input.openedAt);
    const known = this.review(id);
    if (known) {
      if (!known.planHash && input.planHash) return this.write({ ...known, planHash: input.planHash });
      return known;
    }
    const entry: ReviewGeneration = {
      kind: "review", id, agentId: input.agentId, localUrl: input.localUrl, openedAt: input.openedAt,
      planHash: input.planHash ?? null, parked: input.parked ?? false, at: new Date(this.now()).toISOString(),
      ...(input.event ? { event: input.event } : {}), ...(input.legacy ? { legacy: true as const } : {}),
    };
    return this.publish(entry, `${id}.json`);
  }

  // A producer's decision on an exact review generation, before anything else happens: `deciding`
  // while Plannotator still has to take it, `pending` when nothing has to be asked.
  begin(input: AttemptInput): Promise<DecisionAttempt> {
    return this.withReview(input.review.id, async () => {
      this.admissible(input.review.id);
      return this.createAttempt(input);
    });
  }

  // Plannotator's answer to the producer's call (or a resend): `accepted` (HTTP OK), `refused`
  // (Plannotator itself refused this request), `unknown` (the answer was lost).
  settle(attemptId: string, answer: "accepted" | "refused" | "unknown", detail?: string): Promise<DecisionAttempt> {
    const attempt = this.attempt(attemptId);
    if (!attempt) return Promise.reject(new Error(`no decision ${attemptId}`));
    return this.withReview(attempt.reviewId, async () => {
      const current = this.attempt(attemptId)!;
      if (answer === "accepted" && OPEN_STATES.has(current.state)) return this.accept(current);
      if (answer === "refused" && current.state === "deciding") return this.write({ ...current, state: "void", voidReason: detail ?? "Plannotator refused the decision." });
      if (answer === "unknown" && current.state === "deciding") return this.write({ ...current, state: "uncertain", lastError: detail ?? "Plannotator's answer was lost." });
      if (answer === "refused" && current.state === "uncertain") return this.write({ ...current, lastError: detail ?? "Plannotator was decided meanwhile; waiting for its report." });
      return current;
    });
  }

  // A saved Plannotator outcome found for an uncertain attempt's generation (review-outcome.ts).
  evidence(attemptId: string, approved: boolean, report: string): Promise<DecisionAttempt | null> {
    const attempt = this.attempt(attemptId);
    if (!attempt) return Promise.resolve(null);
    return this.withReview(attempt.reviewId, async () => {
      const current = this.attempt(attemptId)!;
      if (!OPEN_STATES.has(current.state)) return current;
      if (approved === current.transport) return this.accept({ ...current, reports: current.reports.includes(report) ? current.reports : [...current.reports, report] });
      await this.write({ ...current, state: "void", voidReason: "Plannotator accepted the other decision." });
      return null;
    });
  }

  // The plugin closes a review itself. Refused while the review has a decision of the owner.
  addClosing(review: ReviewGeneration, transport: boolean, reason: string): Promise<ReviewClosing> {
    return this.withReview(review.id, async () => {
      const known = this.all().find((entry): entry is ReviewClosing => entry.kind === "closing" && entry.reviewId === review.id);
      if (known) return known;
      this.admissible(review.id, { closing: false });
      const at = new Date(this.now()).toISOString();
      const id = randomUUID();
      return this.publish<ReviewClosing>({ kind: "closing", id, reviewId: review.id, agentId: review.agentId, transport, reason: reason.slice(0, 500), reports: [], at }, `${compactTime(at)}-${id}.json`);
    });
  }

  // A `decided` report (Plannotator's omp extension, the central host, a legacy event file) bound
  // to its review generation. See the module header for the rules.
  report(input: ReportInput): Promise<ReportOutcome> {
    return this.withReview(input.review.id, async () => {
      if (this.knownReport(input.event)) return "replay";
      const hash = input.planContent?.trim() ? planHash(input.planContent) : null;
      if (!input.exact && hash && input.review.planHash && hash !== input.review.planHash) {
        const id = randomUUID();
        await this.publish<UnboundReport>({ kind: "unbound", id, agentId: input.agentId, at: input.at, approved: input.approved, ...(input.feedback ? { feedback: input.feedback } : {}), planContent: input.planContent ?? "", event: input.event, state: "open" }, `${compactTime(input.at)}-${id}.json`);
        return "unbound";
      }
      const attempts = this.attempts(input.review.id);
      const open = attempts.find((entry) => OPEN_STATES.has(entry.state));
      const accepted = attempts.find((entry) => ACCEPTED_STATES.has(entry.state));
      const closing = this.all().find((entry): entry is ReviewClosing => entry.kind === "closing" && entry.reviewId === input.review.id);
      if (open) {
        if (open.transport === input.approved) { await this.accept({ ...open, reports: [...open.reports, input.event] }); return "confirmed"; }
        // Plannotator takes exactly one decision: the reported one is the review's.
        await this.write({ ...open, state: "void", voidReason: "Plannotator accepted the other decision." });
        await this.fromReport(input);
        return "recorded";
      }
      if (accepted) {
        if (accepted.transport === input.approved) { await this.write({ ...accepted, reports: [...accepted.reports, input.event] }); return "confirmed"; }
        await this.conflict(input, accepted, null);
        return "conflict";
      }
      if (closing) {
        if (closing.transport === input.approved) { await this.write({ ...closing, reports: [...closing.reports, input.event] }); return "confirmed"; }
        if (this.unresolvedConflict(input.review.id)) { await this.write({ ...closing, reports: [...closing.reports, input.event] }); return "confirmed"; }
        await this.conflict(input, null, closing);
        return "conflict";
      }
      if (this.unresolvedConflict(input.review.id)) return "replay";
      await this.fromReport(input);
      return "recorded";
    });
  }

  // The owner settles an entry the plugin cannot settle from Plannotator's answers alone.
  async resolve(entryId: string, action: ResolveAction, snapshot: (agentId: string) => Promise<RouteSnapshot>): Promise<void> {
    const entry = this.entries.get(entryId);
    if (!entry || entry.kind === "review" || entry.kind === "closing") throw new StaleResolutionError("That entry is not waiting for you any more.");
    // Carrying out an unbound report creates an attempt on the agent's latest review: its lock.
    const reviewId = entry.kind === "unbound" ? this.latestReview(entry.agentId)?.id ?? `unbound:${entry.agentId}` : entry.reviewId;
    await this.withReview(reviewId, async () => {
      const current = this.entries.get(entryId)!;
      if (current.kind === "attempt") {
        if (current.state !== "uncertain" || action !== "carry-out" && action !== "drop") throw new StaleResolutionError("That decision changed meanwhile; reload the inbox.");
        if (action === "carry-out") await this.accept({ ...current, lastError: undefined });
        else await this.write({ ...current, state: "void", voidReason: "Dropped by the owner." });
        return;
      }
      if (current.kind === "unbound") {
        if (current.state !== "open" || action !== "carry-out" && action !== "drop") throw new StaleResolutionError("That report changed meanwhile; reload the inbox.");
        const resolvedAt = new Date(this.now()).toISOString();
        if (action === "drop") { await this.write({ ...current, state: "dropped", resolvedAt }); return; }
        const review = this.latestReview(current.agentId);
        if (!review) throw new StaleResolutionError("The agent has no review to carry this decision out on.");
        const busy = this.attempts(review.id).some((attempt) => OPEN_STATES.has(attempt.state) || ACCEPTED_STATES.has(attempt.state));
        if (busy || this.unresolvedConflict(review.id)) throw new StaleResolutionError("That review has a decision already; drop this report instead.");
        const attempt = await this.createAttempt({ review, agentId: current.agentId, planContent: current.planContent, approved: current.approved, ...(current.feedback ? { feedback: current.feedback } : {}), source: "plannotator-page", state: "pending", snapshot: await snapshot(current.agentId), at: current.at });
        await this.write({ ...current, state: "carried", attemptId: attempt.id, resolvedAt });
        return;
      }
      if (current.kind !== "conflict" || current.resolution) throw new StaleResolutionError("That conflict was settled meanwhile; reload the inbox.");
      const resolvedAt = new Date(this.now()).toISOString();
      if (current.afterApply) {
        if (action !== "dismiss") throw new StaleResolutionError("That decision was carried out already; only Dismiss remains.");
        await this.write({ ...current, resolution: "dismiss", resolvedAt });
        return;
      }
      if (action !== "keep" && action !== "other") throw new StaleResolutionError("Choose which decision to keep.");
      const attempt = current.attemptId ? this.attempt(current.attemptId) : null;
      if (action === "keep") {
        if (attempt && attempt.pausedBy === current.id) await this.write({ ...attempt, pausedBy: undefined });
        await this.write({ ...current, resolution: "keep", resolvedAt });
        return;
      }
      if (attempt && attempt.state === "applied") throw new StaleResolutionError("That decision was carried out meanwhile; reload the inbox.");
      if (attempt) await this.write({ ...attempt, state: "void", voidReason: "The owner chose the other decision.", pausedBy: undefined });
      const review = this.review(current.reviewId);
      if (review) {
        await this.createAttempt({ review, agentId: current.agentId, planContent: current.report.planContent ?? attempt?.planContent ?? "", approved: current.reportOutcome, ...(current.report.feedback ? { feedback: current.report.feedback } : {}), source: review.parked ? "parked-page" : "plannotator-page", state: "pending", snapshot: await snapshot(current.agentId), at: current.report.at });
      }
      await this.write({ ...current, resolution: "other", resolvedAt });
    });
  }

  // --- The worker's bookkeeping -------------------------------------------------------------

  // A step went through; `value` is what it produced (true when nothing).
  async step(attempt: DecisionAttempt, name: string, value: unknown = true): Promise<DecisionAttempt> {
    const current = this.attempt(attempt.id) ?? attempt;
    return this.write({ ...current, steps: { ...current.steps, [name]: value } });
  }

  async failed(attempt: DecisionAttempt, error: unknown, counted = true): Promise<DecisionAttempt> {
    const current = this.attempt(attempt.id) ?? attempt;
    const attempts = counted ? current.attempts + 1 : current.attempts;
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 500);
    return this.write({ ...current, attempts, lastError: message, nextAttemptAt: new Date(this.now() + retryDelay(attempts)).toISOString() });
  }

  // Waits without counting a try (a deletion in progress, a rate-limit pause).
  async later(attempt: DecisionAttempt, at: number, reason: string): Promise<DecisionAttempt> {
    const current = this.attempt(attempt.id) ?? attempt;
    return this.write({ ...current, lastError: reason, nextAttemptAt: new Date(at).toISOString() });
  }

  async applied(attempt: DecisionAttempt): Promise<DecisionAttempt> {
    const current = this.attempt(attempt.id) ?? attempt;
    return this.write({ ...current, state: "applied", appliedAt: new Date(this.now()).toISOString(), lastError: undefined, nextAttemptAt: undefined });
  }

  async abandon(attempt: DecisionAttempt, reason: string): Promise<DecisionAttempt> {
    const current = this.attempt(attempt.id) ?? attempt;
    return this.write({ ...current, state: "void", voidReason: reason });
  }

  // Drops settled entries older than JOURNAL_KEEP_MS; never one still in progress or waiting for
  // the owner, nor a review such an entry (or a kept attempt) points to.
  async prune(): Promise<void> {
    const cutoff = this.now() - JOURNAL_KEEP_MS;
    const old = (iso: string | undefined) => Boolean(iso) && Date.parse(iso!) < cutoff;
    const keepReviews = new Set<string>();
    const drop: JournalEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.kind === "attempt") {
        if ((entry.state === "applied" || entry.state === "void") && old(entry.appliedAt ?? entry.at)) drop.push(entry);
        else keepReviews.add(entry.reviewId);
      } else if (entry.kind === "conflict") {
        if (entry.resolution && old(entry.resolvedAt)) drop.push(entry);
        else keepReviews.add(entry.reviewId);
      } else if (entry.kind === "unbound") {
        if (entry.state !== "open" && old(entry.resolvedAt)) drop.push(entry);
      } else if (entry.kind === "closing") {
        if (old(entry.at)) drop.push(entry);
        else keepReviews.add(entry.reviewId);
      }
    }
    for (const entry of this.entries.values()) if (entry.kind === "review" && old(entry.at) && !keepReviews.has(entry.id)) drop.push(entry);
    for (const entry of drop) {
      const file = this.files.get(entry.id);
      if (file) await rm(join(this.directory, file), { force: true });
      this.entries.delete(entry.id);
      this.files.delete(entry.id);
    }
    if (drop.length) await syncDirectory(this.directory);
  }

  // --- Internals ----------------------------------------------------------------------------

  private admissible(reviewId: string, options: { closing?: boolean } = {}): void {
    for (const entry of this.entries.values()) {
      if (entry.kind === "attempt" && entry.reviewId === reviewId && (OPEN_STATES.has(entry.state) || ACCEPTED_STATES.has(entry.state))) {
        throw new DecisionPendingError(entry.state === "applied" ? "This review was decided already." : "Already decided; it is being applied.");
      }
      if (entry.kind === "conflict" && entry.reviewId === reviewId && !entry.resolution) throw new DecisionPendingError("This review has conflicting decisions waiting for you under Being applied.");
      if (options.closing !== false && entry.kind === "closing" && entry.reviewId === reviewId) throw new DecisionPendingError("Paseo closed this review itself; it takes no decision.");
    }
  }

  private unresolvedConflict(reviewId: string): DecisionConflict | null {
    return this.all().find((entry): entry is DecisionConflict => entry.kind === "conflict" && entry.reviewId === reviewId && !entry.resolution) ?? null;
  }

  private knownReport(event: string): boolean {
    for (const entry of this.entries.values()) {
      if ((entry.kind === "attempt" || entry.kind === "closing") && entry.reports.includes(event)) return true;
      if (entry.kind === "unbound" && entry.event === event) return true;
      if (entry.kind === "conflict" && entry.report.event === event) return true;
    }
    return false;
  }

  private async createAttempt(input: AttemptInput & { reports?: string[] }): Promise<DecisionAttempt> {
    const at = input.at ?? new Date(this.now()).toISOString();
    const id = randomUUID();
    const mode = input.mode ?? (input.approved ? "approve" : "send-back");
    const feedback = input.feedback?.trim();
    const attempt: DecisionAttempt = {
      kind: "attempt", id, reviewId: input.review.id, reviewOpenedAt: input.review.openedAt, at,
      agentId: input.agentId, planHash: planHash(input.planContent), planContent: input.planContent,
      approved: input.approved, transport: input.transport ?? input.approved, mode,
      ...(feedback ? { feedback } : {}), source: input.source, state: input.state,
      ...(input.state === "pending" ? { acceptedAt: new Date(this.now()).toISOString() } : {}),
      reports: input.reports ?? [], steps: {}, attempts: 0, ...input.snapshot,
    };
    return this.publish(attempt, `${compactTime(at)}-${id}.json`);
  }

  private async fromReport(input: ReportInput): Promise<DecisionAttempt> {
    return this.createAttempt({ review: input.review, agentId: input.agentId, planContent: input.planContent ?? "", approved: input.approved, ...(input.feedback ? { feedback: input.feedback } : {}), source: input.source, state: "pending", snapshot: await input.snapshot(), at: input.at, reports: [input.event] });
  }

  private async conflict(input: ReportInput, attempt: DecisionAttempt | null, closing: ReviewClosing | null): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const id = randomUUID();
    const afterApply = attempt?.state === "applied";
    await this.publish<DecisionConflict>({
      kind: "conflict", id, reviewId: input.review.id, reviewOpenedAt: input.review.openedAt, agentId: input.agentId,
      attemptId: attempt?.id ?? null, closingId: closing?.id ?? null, afterApply, reportOutcome: input.approved,
      report: { event: input.event, at: input.at, ...(input.feedback ? { feedback: input.feedback } : {}), ...(input.planContent ? { planContent: input.planContent } : {}) }, at,
    }, `${compactTime(at)}-${id}.json`);
    if (attempt && !afterApply) await this.write({ ...attempt, pausedBy: id });
  }

  private accept(attempt: DecisionAttempt): Promise<DecisionAttempt> {
    return this.write({ ...attempt, state: "pending", acceptedAt: attempt.acceptedAt ?? new Date(this.now()).toISOString(), lastError: undefined, nextAttemptAt: undefined });
  }

  private assertHeld(): void {
    if (!this.held) throw new FencedError();
  }

  // Exclusive creation: the final name appears complete or not at all, and never twice.
  private async publish<T extends JournalEntry>(entry: T, file: string): Promise<T> {
    this.assertHeld();
    const temporary = join(this.directory, `.${entry.id}.${randomUUID()}.tmp`);
    try {
      await writeSynced(temporary, JSON.stringify(entry, null, 2));
      try {
        await link(temporary, join(this.directory, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.readEntry(file);
        if (!existing) throw new Error(`the decision record ${file} exists but cannot be read`);
        this.entries.set(existing.id, existing);
        this.files.set(existing.id, file);
        return existing as T;
      }
    } finally { await rm(temporary, { force: true }); }
    await syncDirectory(this.directory);
    this.entries.set(entry.id, entry);
    this.files.set(entry.id, file);
    return entry;
  }

  private async write<T extends JournalEntry>(entry: T): Promise<T> {
    this.assertHeld();
    const file = this.files.get(entry.id);
    if (!file) throw new Error(`no decision record for ${entry.id}`);
    const clean = JSON.parse(JSON.stringify(entry)) as T;
    const temporary = join(this.directory, `.${entry.id}.${randomUUID()}.tmp`);
    try {
      await writeSynced(temporary, JSON.stringify(clean, null, 2));
      await rename(temporary, join(this.directory, file));
    } finally { await rm(temporary, { force: true }); }
    await syncDirectory(this.directory);
    this.entries.set(entry.id, clean);
    return clean;
  }

  private async readEntry(file: string): Promise<JournalEntry | null> {
    try {
      const value = JSON.parse(await readFile(join(this.directory, file), "utf8")) as JournalEntry;
      return value && typeof value === "object" && typeof value.id === "string" && typeof value.kind === "string" ? value : null;
    } catch { return null; }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.entries.clear();
    this.files.clear();
    const unreadable: string[] = [];
    for (const file of (await readdir(this.directory)).sort()) {
      if (file.startsWith(".") || !file.endsWith(".json")) continue;
      const entry = await this.readEntry(file);
      if (!entry) {
        unreadable.push(file);
        console.error(`[linear-tickets] Unreadable decision record ${file}; it is kept and listed under Being applied.`);
        continue;
      }
      this.entries.set(entry.id, entry);
      this.files.set(entry.id, file);
    }
    this.unreadable = unreadable;
    this.loaded = true;
  }
}
