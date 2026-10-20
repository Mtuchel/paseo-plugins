// The responsibility check (README, "Responsibility check"): every ten minutes it asks of each
// Paseo ticket in a plan or work status whether exactly one step is responsible for what happens
// next (an agent, a review, a queued thread, an open question), reports the tickets where none or
// more than one is, and repairs the one clear case: a plan review that was lost before the owner's
// decision was carried out is parked again, so the owner gets the same plan back.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { DecisionPendingError, type DecisionJournal, FencedError, JOURNAL_KEEP_MS, type ReviewGeneration, reviewEntryId } from "./decision-journal";
import type { ParkedPlan, ParkedPlans } from "./parked";
import { PLAN_APPROVED_STATE, PLAN_REVIEW_STATE, PLANNING_STATE, planStage } from "./plan-policy";
import type { RepairExclusion } from "./repair-exclusion";
import type { ReviewDeletions } from "./review-deletions";
import type { ReviewEntry, ReviewLinks, TicketReviewRow, TicketReviews } from "./review-links";
import { paseoHome } from "./ticket-mcp";
import { NEEDS_INPUT_STATE } from "./writeback";

export const RESPONSIBILITY_CHECK_MS = 10 * 60_000;
// A ticket the steward or an agent start touched this recently is still settling.
export const RESPONSIBILITY_GRACE_MS = 10 * 60_000;
// How long a lost review's ticket is held back from a fresh planner while its repair is pending.
export const REPAIR_HOLD_MS = 60 * 60_000;
const WHY_MAX = 120;
const IN_PROGRESS_STATE = "In Progress";
const MAX_PAGES = 20;

export type ResponsibilityKind = "planning-no-agent" | "review-missing" | "approved-no-handoff" | "in-progress-no-agent" | "needs-input-no-question" | "two-steps";
// The digest's line for each kind (ops/paseo-ops-digest.py RESPONSIBILITY_KINDS).
export const KIND_DETAIL: Record<ResponsibilityKind, string> = {
  "planning-no-agent": "Planning without an agent",
  "review-missing": "Plan review without a review",
  "approved-no-handoff": "Plan approved without a hand-off",
  "in-progress-no-agent": "In Progress without an agent or queue entry",
  "needs-input-no-question": "Needs input without an open question",
  "two-steps": "More than one responsible step",
};
const REPAIRABLE: Partial<Record<ResponsibilityKind, true>> = { "planning-no-agent": true, "review-missing": true };

type Stage = typeof PLANNING_STATE | typeof PLAN_REVIEW_STATE | typeof PLAN_APPROVED_STATE | typeof IN_PROGRESS_STATE | typeof NEEDS_INPUT_STATE;

// The judged statuses; every other one is not judged.
function stageOf(status: string, statusType: string): Stage | null {
  const plan = planStage(status, statusType);
  if (plan) return plan;
  const name = status.trim().replace(/\s+/g, " ").toLowerCase();
  if (name === NEEDS_INPUT_STATE.toLowerCase()) return NEEDS_INPUT_STATE;
  if (name === IN_PROGRESS_STATE.toLowerCase() && statusType.trim().toLowerCase() === "started") return IN_PROGRESS_STATE;
  return null;
}

// --- The verdict --------------------------------------------------------------------------------

export type ReviewSource = "parked" | "open" | "applying" | "thread";
export type Evidence = {
  status: string;
  statusType: string;
  // An owner hold (hold/manual/do-not-merge label, watchdog Stop, peer host, focus) or an open
  // blocker: the owner or the blocking ticket is responsible.
  ownerHold: boolean;
  // Live root agents (no subagents, no steward verifiers).
  liveRoots: string[];
  // A queued thread or the steward's own queue deferral.
  queued: boolean;
  // Review steps: a parked plan, an open review on any host, a decision being applied, a thread
  // waiting for a plan decision. `agentId` null: the thread did not name its agent.
  reviews: { agentId: string | null; source: ReviewSource }[];
  // A question for the owner (a live owner wait, a Needs-you entry, a pending permission).
  question: { agentId: string | null } | null;
  // Every host's reviews were read.
  reviewsKnown: boolean;
  // The agent of a parked generation a repair wrote, still within its hold: the hand-off of a
  // Planning ticket until delivery stages Plan review.
  handoff: string | null;
};
export type Verdict =
  | { verdict: "fine" }
  | { verdict: "unknown"; why: string }
  | { verdict: "violation"; kind: ResponsibilityKind; why?: string };

type Step = { review: ReviewSource[]; question: boolean; root: boolean; queued: boolean; agentId: string | null };

function describe(step: Step): string {
  if (step.review.length) return step.review.every((source) => source === "applying") ? "a decision being applied" : "an open review";
  if (step.question) return "an open question";
  if (step.root) return "a running agent";
  return "a queued thread";
}

function clip(text: string): string {
  return text.length > WHY_MAX ? `${text.slice(0, WHY_MAX - 1)}…` : text;
}

// Pure: the ticket's responsible steps, merged per agent, against the one its status expects.
export function judge(evidence: Evidence): Verdict | null {
  const stage = stageOf(evidence.status, evidence.statusType);
  if (!stage) return null;
  if (evidence.ownerHold) return { verdict: "fine" };
  if (!evidence.reviewsKnown && (stage === PLAN_REVIEW_STATE || stage === PLAN_APPROVED_STATE)) return { verdict: "unknown", why: "a peer's reviews could not be read" };
  const steps = new Map<string, Step>();
  const step = (key: string, agentId: string | null): Step => {
    let found = steps.get(key);
    if (!found) steps.set(key, found = { review: [], question: false, root: false, queued: false, agentId });
    return found;
  };
  const named = evidence.reviews.filter((review) => review.agentId !== null);
  for (const review of named) step(`agent:${review.agentId}`, review.agentId).review.push(review.source);
  // A thread's review without a named agent is the ticket's one review when another names it.
  const anonymous = evidence.reviews.filter((review) => review.agentId === null);
  if (anonymous.length && !named.length) step("review", null).review.push(...anonymous.map((review) => review.source));
  if (evidence.question) {
    const agentId = evidence.question.agentId;
    step(agentId ? `agent:${agentId}` : "question", agentId).question = true;
  }
  for (const agentId of evidence.liveRoots) step(`agent:${agentId}`, agentId).root = true;
  if (evidence.queued) step("queued", null).queued = true;
  const found = [...steps.values()];
  const why = found.length ? clip(`found: ${found.map(describe).join(", ")}`) : undefined;
  if (found.length > 1) return { verdict: "violation", kind: "two-steps", ...(why ? { why } : {}) };
  const only = found[0];
  const fits: Record<Stage, (step: Step) => boolean> = {
    [PLANNING_STATE]: (step) => step.root || step.queued || (evidence.handoff !== null && step.agentId === evidence.handoff && step.review.includes("parked")),
    [PLAN_REVIEW_STATE]: (step) => step.review.length > 0,
    [PLAN_APPROVED_STATE]: (step) => step.queued || step.root || step.review.includes("applying"),
    [IN_PROGRESS_STATE]: (step) => step.root || step.queued,
    [NEEDS_INPUT_STATE]: (step) => step.question,
  };
  if (only && fits[stage](only)) return { verdict: "fine" };
  const kind: Record<Stage, ResponsibilityKind> = {
    [PLANNING_STATE]: "planning-no-agent",
    [PLAN_REVIEW_STATE]: "review-missing",
    [PLAN_APPROVED_STATE]: "approved-no-handoff",
    [IN_PROGRESS_STATE]: "in-progress-no-agent",
    [NEEDS_INPUT_STATE]: "needs-input-no-question",
  };
  return { verdict: "violation", kind: kind[stage], ...(why ? { why } : {}) };
}

// --- The plan file a review agent submitted --------------------------------------------------------

const SUBMIT_TOOL = "plannotator_submit_plan";

// The plan file a submission names, as given (omp/linear-tickets-plan-first.ts submittedPlan, the
// extension's own reading of the same calls). null: not a plan submission.
function submittedPlan(toolName: unknown, input: unknown): string | null {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  if (toolName === SUBMIT_TOOL) return typeof args?.filePath === "string" ? args.filePath.trim() || null : null;
  if (toolName !== "write" || typeof args?.path !== "string") return null;
  const path = args.path.trim();
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (path === "xd://propose") return content ? `local://${content}-plan.md` : null;
  if (path !== `xd://${SUBMIT_TOOL}`) return null;
  try {
    const parsed = JSON.parse(content) as { filePath?: unknown };
    return typeof parsed.filePath === "string" ? parsed.filePath.trim() || null : null;
  } catch {
    return null;
  }
}

// The absolute path of the last plan file an omp transcript submitted: `local://` resolves into
// the session's artifacts directory (the transcript path without `.jsonl`), anything else against
// the agent's working directory. null: the transcript names none.
export function submittedPlanFile(transcript: string, nativeHandle: string, cwd: string): string | null {
  let last: string | null = null;
  for (const line of transcript.split("\n")) {
    if (!line.includes(SUBMIT_TOOL) && !line.includes("xd://propose")) continue;
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content as { type?: unknown; name?: unknown; arguments?: unknown }[]) {
      if (part?.type !== "toolCall") continue;
      const file = submittedPlan(part.name, part.arguments);
      if (file) last = file;
    }
  }
  if (!last) return null;
  const local = /^local:\/\/(.+)$/.exec(last);
  if (local) return join(nativeHandle.replace(/\.jsonl$/, ""), "local", local[1]);
  return resolvePath(cwd, last);
}

// --- The store -------------------------------------------------------------------------------------

export type RepairState = "claimed" | "released" | "done" | "report-only" | "failed";
export type ResponsibilityViolation = { issueId: string; identifier: string; url: string; status: string; kind: ResponsibilityKind; detail: string; since: string; seen: number; why?: string };
export type ResponsibilityRepair = {
  issueId: string; identifier: string; url: string; kind: ResponsibilityKind; detail: string;
  revision: string; reviewId: string; agentId: string; repairId: string; previousStatus: string; parkedAt: string;
  state: RepairState; tries: number; at: string; why?: string; error?: string;
};
export type ResponsibilityFile = {
  version: 1;
  host: string;
  checkedAt: string | null;
  // Seen in two runs in a row: what the digest reports.
  violations: ResponsibilityViolation[];
  // Seen once: reported if the next run sees it again.
  candidates: ResponsibilityViolation[];
  unknown: { issueId: string; identifier: string; why: string }[];
  // "<issueId>:<revision>": since when the lost review's ticket is held.
  holds: Record<string, { since: string }>;
  // Every repair, never pruned: a terminal one is never tried again.
  repairs: Record<string, ResponsibilityRepair>;
};

export class ResponsibilityStateError extends Error {}

function emptyFile(host: string): ResponsibilityFile {
  return { version: 1, host, checkedAt: null, violations: [], candidates: [], unknown: [], holds: {}, repairs: {} };
}

function parseFile(text: string, host: string): ResponsibilityFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ResponsibilityStateError("responsibility.json is not valid JSON"); }
  const file = value as Partial<ResponsibilityFile> | null;
  const object = (part: unknown) => Boolean(part) && typeof part === "object" && !Array.isArray(part);
  if (!object(file) || file!.version !== 1 || !object(file!.holds) || !object(file!.repairs)) throw new ResponsibilityStateError("responsibility.json has an unknown shape or version");
  for (const [key, repair] of Object.entries(file!.repairs!)) {
    if (!object(repair) || typeof repair.repairId !== "string" || typeof repair.state !== "string" || !Number.isInteger(repair.tries)) throw new ResponsibilityStateError(`responsibility.json has a malformed repair for ${key}`);
  }
  return {
    ...emptyFile(host), ...file as ResponsibilityFile, host,
    violations: Array.isArray(file!.violations) ? file!.violations : [],
    candidates: Array.isArray(file!.candidates) ? file!.candidates : [],
    unknown: Array.isArray(file!.unknown) ? file!.unknown : [],
  };
}

// responsibility.json next to steward.json: atomic, owner-only, every change serialized. Only a
// missing file starts empty; a corrupt one throws, so no settled repair is ever forgotten.
export class ResponsibilityStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly host: string, readonly path = join(paseoHome(), "linear-tickets", "responsibility.json")) {}

  async read(): Promise<ResponsibilityFile> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile(this.host);
      throw new ResponsibilityStateError(`responsibility.json cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    return parseFile(text, this.host);
  }

  update<T>(work: (file: ResponsibilityFile) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const file = await this.read();
      const result = await work(file);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(file), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// --- The check -------------------------------------------------------------------------------------

// One ticket as the steward saw it in this pass (steward.ts facts).
export type ResponsibilityTicket = {
  issue: { id: string; identifier: string; status: string; statusType: string };
  ownerHold: boolean;
  question: { agentId: string | null } | null;
  liveRoots: string[];
  queued: boolean;
  // The ticket's thread waits for a plan decision (a review or a parked/split/later offer).
  reviewThread: { agentId: string | null } | null;
  // The steward's latest claim or action on the ticket (ms), if any.
  stewardAt: number | null;
};
// The steward's fresh check under the repair's reservation: null when nothing of the steward's
// own (ownership, status, owner Stop/question/hold, blocker, live agent, recent action) stands
// in the way, else why — always temporary.
export type RepairFence = (issueId: string, identifier: string) => Promise<string | null>;

export type ResponsibilityDeps = {
  store: ResponsibilityStore;
  reviews: Pick<ReviewLinks, "ticketReviews" | "latestFor">;
  journal: Pick<DecisionJournal, "all" | "review" | "attempts" | "applying" | "busy" | "superseded" | "replacement" | "supersession" | "supersede">;
  parked: Pick<ParkedPlans, "get" | "putIfAbsent">;
  deletions: Pick<ReviewDeletions, "get" | "forAgent">;
  exclusion: Pick<RepairExclusion, "tryRepair">;
  // The workspace's web address (linear.ts workspaceUrl), for the ticket links the digest shows.
  workspaceUrl: () => Promise<string>;
  now?: () => number;
  readText?: (path: string) => Promise<string>;
};

// A guard's answer: the case waits (`temporary`, the hold stays) or is settled as report-only.
type Refusal = { permanent: boolean; why: string };
// A lost review the check may repair: the ticket's latest local review, closed, with its plan's
// revision.
type Lost = { entry: ReviewEntry & { revision: string }; reviewId: string; key: string };

const OWNER_VOID: Record<string, true> = { "Dropped by the owner.": true, "The owner chose the other decision.": true };
const TERMINAL: Record<RepairState, boolean> = { claimed: false, released: false, done: true, "report-only": true, failed: true };

export class ResponsibilityCheck {
  private lastRun = 0;

  constructor(private readonly deps: ResponsibilityDeps) {}

  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  // Whether a run is due (every ten minutes; the steward's pass runs more often).
  due(now: number): boolean {
    return now - this.lastRun >= RESPONSIBILITY_CHECK_MS;
  }

  // The lost-review hold: the steward asks this for a Planning ticket with no live root, no parked
  // plan and no owner hold, question or blocker. True while the ticket's lost review is repairable
  // and not yet settled, for at most an hour from the first time it was held (persisted).
  async holds(issue: { id: string; identifier: string }): Promise<boolean> {
    const lost = await this.lost(issue.id, issue.identifier);
    if (!lost) return false;
    const now = this.clock();
    const file = await this.deps.store.read();
    const repair = file.repairs[lost.key];
    if (repair && TERMINAL[repair.state]) return false;
    const since = file.holds[lost.key]?.since ?? await this.deps.store.update((current) => (current.holds[lost.key] ??= { since: new Date(now).toISOString() }).since);
    return now - Date.parse(since) < REPAIR_HOLD_MS;
  }

  // The ticket's latest local review when it is a lost one: closed (or decided), its revision
  // known, its decision neither carried out nor dropped by the owner, no deletion recorded.
  private async lost(issueId: string, identifier: string): Promise<Lost | null> {
    const entry = await this.deps.reviews.latestFor(issueId, identifier);
    if (!entry?.revision || !(entry.closedAt || entry.outcome)) return null;
    const reviewId = entry.reviewId ?? reviewEntryId(entry.agentId, entry.localUrl, entry.openedAt);
    const lost: Lost = { entry: entry as Lost["entry"], reviewId, key: `${issueId}:${entry.revision}` };
    if (this.ownerSettled(lost)) return null;
    if (await this.deps.deletions.get(issueId) || await this.deps.deletions.forAgent(entry.agentId)) return null;
    return lost;
  }

  // Guard 2: the decision was carried out, or the owner dropped it (or chose the other one).
  private ownerSettled(lost: Lost): string | null {
    const attempts = this.deps.journal.attempts(lost.reviewId);
    if (attempts.some((attempt) => attempt.state === "applied")) return "the decision was carried out";
    if (attempts.some((attempt) => attempt.state === "void" && attempt.voidReason && OWNER_VOID[attempt.voidReason])) return "the owner dropped the decision";
    const review = this.deps.journal.review(lost.reviewId);
    const dropped = this.deps.journal.all().some((entry) => entry.kind === "unbound" && entry.agentId === lost.entry.agentId && entry.state === "dropped" && (!review || entry.at >= review.openedAt));
    return dropped ? "the owner dropped a decision of the review's agent" : null;
  }

  // One run: judges every ticket, repairs the lost reviews, and writes the snapshot the digest
  // reads. `enabled`: the steward is enabled (no repair otherwise).
  async run(input: { tickets: ResponsibilityTicket[]; enabled: boolean; fence: RepairFence; paseo: PaseoApi }): Promise<void> {
    const now = this.clock();
    this.lastRun = now;
    const at = new Date(now).toISOString();
    const base = await this.deps.workspaceUrl();
    const reviews: TicketReviews = await this.deps.reviews.ticketReviews().catch(() => ({ rows: [], unreachable: ["this host's reviews"] }));
    // An own claim from an earlier run is proven only by this repair's exact parked record or the
    // review generation it opened as.
    for (const [key, record] of Object.entries((await this.deps.store.read()).repairs)) {
      if (record.state !== "claimed") continue;
      const parked = await this.deps.parked.get(record.issueId);
      const proven = (parked?.responsibilityRepairId === record.repairId && parked.parkedAt === record.parkedAt && parked.agentId === record.agentId) || this.deps.journal.replacement(record.repairId);
      if (proven) await this.deps.store.update((file) => { file.repairs[key] = { ...record, state: "done", at }; delete file.holds[key]; });
    }
    const before = await this.deps.store.read();
    const earlier = new Map([...before.candidates, ...before.violations].map((entry) => [`${entry.issueId}:${entry.kind}`, entry]));
    const violations: ResponsibilityViolation[] = [];
    const candidates: ResponsibilityViolation[] = [];
    const unknown: ResponsibilityFile["unknown"] = [];
    const held = new Set<string>();
    for (const ticket of input.tickets) {
      const { issue } = ticket;
      const stage = stageOf(issue.status, issue.statusType);
      if (!stage) continue;
      const url = `${base}/issue/${encodeURIComponent(issue.identifier)}`;
      try {
        const parked = await this.deps.parked.get(issue.id);
        const verdict = judge(this.evidence(ticket, reviews, parked, before, now));
        if (!verdict || verdict.verdict === "fine") continue;
        if (verdict.verdict === "unknown") { unknown.push({ issueId: issue.id, identifier: issue.identifier, why: verdict.why }); continue; }
        if (input.enabled && REPAIRABLE[verdict.kind] && (stage === PLANNING_STATE || stage === PLAN_REVIEW_STATE) && !ticket.ownerHold && !ticket.question && !ticket.liveRoots.length && !parked) {
          const pending = await this.repair(ticket, verdict.kind, url, input);
          if (pending === "done") continue;
          if (pending) { held.add(pending); continue; }
        }
        if (ticket.stewardAt !== null && now - ticket.stewardAt < RESPONSIBILITY_GRACE_MS) continue;
        const known = earlier.get(`${issue.id}:${verdict.kind}`);
        const row: ResponsibilityViolation = {
          issueId: issue.id, identifier: issue.identifier, url, status: issue.status, kind: verdict.kind, detail: KIND_DETAIL[verdict.kind],
          since: known?.since ?? at, seen: (known?.seen ?? 0) + 1, ...(verdict.why ? { why: verdict.why } : {}),
        };
        (row.seen >= 2 ? violations : candidates).push(row);
      } catch (error) {
        unknown.push({ issueId: issue.id, identifier: issue.identifier, why: clip(`the check failed: ${error instanceof Error ? error.message : String(error)}`) });
      }
    }
    await this.deps.store.update((file) => {
      file.checkedAt = at;
      file.violations = violations;
      file.candidates = candidates;
      file.unknown = unknown;
      // A hold of a case no longer pending ends; a pending one keeps its hour.
      for (const key of Object.keys(file.holds)) if (!held.has(key)) delete file.holds[key];
    });
  }

  private evidence(ticket: ResponsibilityTicket, reviews: TicketReviews, parked: ParkedPlan | null, file: ResponsibilityFile, now: number): Evidence {
    const { issue } = ticket;
    const mine = (row: TicketReviewRow) => row.issueId === issue.id || (row.identifier !== undefined && row.identifier === issue.identifier);
    const steps: Evidence["reviews"] = reviews.rows.filter(mine).map((row) => ({ agentId: row.agentId, source: row.state === "open" ? "open" : "applying" }));
    if (parked) steps.push({ agentId: parked.agentId, source: "parked" });
    if (ticket.reviewThread) steps.push({ agentId: ticket.reviewThread.agentId, source: "thread" });
    const repair = parked?.responsibilityRepairId
      ? Object.values(file.repairs).find((entry) => entry.repairId === parked.responsibilityRepairId && (entry.state === "claimed" || entry.state === "done") && now - Date.parse(entry.parkedAt) < REPAIR_HOLD_MS)
      : undefined;
    return {
      status: issue.status, statusType: issue.statusType, ownerHold: ticket.ownerHold, liveRoots: ticket.liveRoots, queued: ticket.queued,
      reviews: steps, question: ticket.question, reviewsKnown: reviews.unreachable.length === 0, handoff: repair?.agentId ?? null,
    };
  }

  // The repair of a lost review. Returns the case's key while it is still pending (the ticket is
  // held and not reported), "done" once the plan is parked again, null when the ticket is to be
  // reported as usual.
  private async repair(ticket: ResponsibilityTicket, kind: ResponsibilityKind, url: string, input: { fence: RepairFence; paseo: PaseoApi }): Promise<string | "done" | null> {
    const { issue } = ticket;
    const lost = await this.lost(issue.id, issue.identifier);
    if (!lost) return null;
    const now = this.clock();
    const at = new Date(now).toISOString();
    const file = await this.deps.store.read();
    const known = file.repairs[lost.key];
    if (known && TERMINAL[known.state]) return null;
    const since = file.holds[lost.key]?.since ?? at;
    const settle = (state: RepairState, repair: ResponsibilityRepair, extra: { why?: string; error?: string } = {}) => this.deps.store.update((current) => {
      current.repairs[lost.key] = { ...repair, state, at: new Date(this.clock()).toISOString(), ...extra };
      if (TERMINAL[state]) delete current.holds[lost.key];
    });
    const fresh = known?.state !== "claimed";
    const record: ResponsibilityRepair = fresh
      ? {
        issueId: issue.id, identifier: issue.identifier, url, kind, detail: KIND_DETAIL[kind], revision: lost.entry.revision, reviewId: lost.reviewId,
        agentId: lost.entry.agentId, repairId: randomUUID(), previousStatus: issue.status, parkedAt: at, state: "claimed", tries: 1, at,
      }
      : known!;
    if (!fresh && record.tries >= 2) { await settle("failed", record, { why: "the repair failed twice" }); return null; }
    if (now - Date.parse(since) >= REPAIR_HOLD_MS) { await settle("report-only", record, { why: "not repaired within an hour" }); return null; }
    const early = this.cheapGuards(lost, record, now);
    if (early) {
      if (early.permanent) { await settle("report-only", record, { why: early.why }); return null; }
      await this.deps.store.update((current) => { current.holds[lost.key] = { since }; });
      return lost.key;
    }
    // The claim before the effect: a crash from here on is recovered from this record.
    if (fresh) await this.deps.store.update((current) => { current.repairs[lost.key] = record; current.holds[lost.key] = { since }; });
    const outcome = await this.effect(ticket, lost, record, input).catch((error: unknown): EffectOutcome => ({ state: "error", error: error instanceof Error ? error.message : String(error) }));
    if (outcome.state === "done") { await settle("done", outcome.record); return "done"; }
    if (outcome.state === "report-only") { await settle("report-only", outcome.record, { why: outcome.why }); return null; }
    if (outcome.state === "error") {
      // A failed effect stays claimed: the next run proves or retries it, at most once more.
      await this.deps.store.update((current) => { current.repairs[lost.key] = { ...current.repairs[lost.key] ?? record, error: clip(outcome.error) }; });
      return lost.key;
    }
    // Temporary: a fresh claim with no write is released; a recovered one keeps its claim.
    if (fresh || !this.deps.journal.supersession(record.repairId)) await settle("released", record, { why: outcome.why });
    else await this.deps.store.update((current) => { current.repairs[lost.key] = { ...record, why: outcome.why }; });
    await this.deps.store.update((current) => { current.holds[lost.key] = { since }; });
    return lost.key;
  }

  // Guards 1 and 2 from the journal and the registry alone (no Paseo, no peers).
  private cheapGuards(lost: Lost, record: ResponsibilityRepair, now: number): Refusal | null {
    const review: ReviewGeneration | null = this.deps.journal.review(lost.reviewId);
    const opened = review ? Date.parse(review.openedAt) : NaN;
    if (!review || review.legacy || !Number.isFinite(opened) || opened > now || opened <= now - JOURNAL_KEEP_MS) return { permanent: true, why: "the review's history is not complete in the journal" };
    const closed = Date.parse(lost.entry.closedAt ?? lost.entry.decidedAt ?? "");
    if (!Number.isFinite(closed)) return { permanent: false, why: "the review's closing time is not known yet" };
    if (now - closed < RESPONSIBILITY_GRACE_MS) return { permanent: false, why: "the review closed less than ten minutes ago" };
    const settled = this.ownerSettled(lost);
    if (settled) return { permanent: true, why: settled };
    const superseded = this.deps.journal.superseded(lost.reviewId);
    if (superseded && superseded.repairId !== record.repairId) return { permanent: true, why: "another repair restored this review" };
    return null;
  }

  // Under the ticket's exclusive reservation: every guard again from fresh evidence, then the
  // supersession and the parked record.
  private async effect(ticket: ResponsibilityTicket, lost: Lost, record: ResponsibilityRepair, input: { fence: RepairFence; paseo: PaseoApi }): Promise<EffectOutcome> {
    const { issue } = ticket;
    const reservation = this.deps.exclusion.tryRepair(issue.id);
    if (!reservation) return { state: "temporary", why: "another operation on the ticket is under way" };
    try {
      const now = this.clock();
      const fenced = await input.fence(issue.id, issue.identifier);
      if (fenced) return { state: "temporary", why: fenced };
      const current = await this.lost(issue.id, issue.identifier);
      if (!current || current.key !== lost.key || current.reviewId !== record.reviewId || current.entry.agentId !== record.agentId) return { state: "temporary", why: "the ticket's latest review changed" };
      const fresh = this.cheapGuards(current, record, now) ?? await this.freshGuards(issue, current, now, input.paseo);
      if (!Array.isArray(fresh)) return fresh.permanent ? { state: "report-only", record, why: fresh.why } : { state: "temporary", why: fresh.why };
      if (await this.deps.parked.get(issue.id)) return { state: "report-only", record, why: "another parked plan appeared" };
      const plan = await this.plan(current, fresh.find((agent) => agent.id === current.entry.agentId) ?? null);
      if (typeof plan !== "string") return { state: "report-only", record, why: plan.why };
      // A retry of an own claim counts before the effect runs again.
      let attempt = record;
      if (this.deps.journal.supersession(record.repairId)) {
        attempt = { ...record, tries: record.tries + 1 };
        await this.deps.store.update((file) => { file.repairs[lost.key] = { ...attempt, at: new Date(this.clock()).toISOString() }; });
      }
      const review = this.deps.journal.review(record.reviewId)!;
      try {
        await this.deps.journal.supersede({ review, issueId: issue.id, repairId: record.repairId, parkedAt: record.parkedAt });
      } catch (error) {
        if (error instanceof FencedError) return { state: "temporary", why: "the decision journal is not owned by this plugin now" };
        if (error instanceof DecisionPendingError) return { state: "report-only", record: attempt, why: clip(error.message) };
        throw error;
      }
      const parked: ParkedPlan = {
        issueId: issue.id, identifier: issue.identifier, agentId: record.agentId, plan,
        line: "Parked again: the review was lost before your decision was carried out",
        reasons: ["review lost; parked again by the responsibility check"],
        model: current.entry.model ?? null, parkedAt: record.parkedAt, announced: false, responsibilityRepairId: record.repairId,
      };
      if (!await this.deps.parked.putIfAbsent(parked)) return { state: "report-only", record: attempt, why: "another parked plan appeared" };
      return { state: "done", record: attempt };
    } finally {
      reservation.release();
    }
  }

  // Guards 3 to 6 from fresh reads: the journal's open entries, the ticket's agents (archived
  // included), every host's reviews, the deletion records. The ticket's agents when all hold.
  private async freshGuards(issue: ResponsibilityTicket["issue"], lost: Lost, now: number, paseo: PaseoApi): Promise<Refusal | PaseoAgent[]> {
    if (await this.deps.deletions.get(issue.id) || await this.deps.deletions.forAgent(lost.entry.agentId)) return { permanent: true, why: "a deletion is recorded for the ticket or the review's agent" };
    const agents = await ticketAgents(paseo, issue.id);
    if (!agents) return { permanent: false, why: "the ticket's agents could not be listed" };
    if (agents.some((agent) => now - Date.parse(agent.createdAt) < RESPONSIBILITY_GRACE_MS)) return { permanent: false, why: "an agent of the ticket started less than ten minutes ago" };
    const ids = new Set([lost.entry.agentId, ...agents.map((agent) => agent.id)]);
    // An entry that names no ticket (an unbound report, a conflict without its attempt's ticket,
    // an unreadable file) may be this ticket's: it blocks every repair.
    for (const row of this.deps.journal.applying()) {
      if (row.kind === "unreadable") return { permanent: false, why: "a decision journal entry cannot be read" };
      const issueId = row.kind === "attempt" ? row.entry.issueId : row.kind === "conflict" ? row.attempt?.issueId ?? null : null;
      if (issueId === null || issueId === issue.id) return { permanent: false, why: "a decision is being applied" };
    }
    if ([...ids].some((agentId) => this.deps.journal.busy(agentId))) return { permanent: false, why: "a decision of the ticket's agents is in progress" };
    const reviews = await this.deps.reviews.ticketReviews();
    if (reviews.unreachable.length) return { permanent: false, why: clip(`reviews could not be read: ${reviews.unreachable.join(", ")}`) };
    if (reviews.rows.some((row) => row.state === "open" && (row.issueId === issue.id || row.identifier === issue.identifier || row.agentId === lost.entry.agentId))) return { permanent: false, why: "a review of the ticket is open" };
    return agents;
  }

  // Guard 7: the plan file the review's agent submitted, unchanged since the review showed it.
  private async plan(lost: Lost, agent: PaseoAgent | null): Promise<string | { why: string }> {
    const read = this.deps.readText ?? ((path: string) => readFile(path, "utf8"));
    const handle = agent?.persistence?.nativeHandle;
    if (!agent || !handle) return { why: "the review's agent has no transcript" };
    const transcript = await read(handle).catch(() => null);
    if (transcript === null) return { why: "the review's transcript cannot be read" };
    const path = submittedPlanFile(transcript, handle, agent.cwd);
    if (!path) return { why: "the transcript names no plan file" };
    const content = await read(path).catch(() => null);
    if (content === null) return { why: "the plan file cannot be read" };
    if (createHash("sha256").update(content).digest("hex") !== lost.entry.revision) return { why: "the plan file changed since the review" };
    return content;
  }
}

type EffectOutcome =
  | { state: "done"; record: ResponsibilityRepair }
  | { state: "report-only"; record: ResponsibilityRepair; why: string }
  | { state: "temporary"; why: string }
  | { state: "error"; error: string };

// Every agent of the ticket, archived included; null when the listing is incomplete.
async function ticketAgents(paseo: PaseoApi, issueId: string): Promise<PaseoAgent[] | null> {
  const agents = new Map<string, PaseoAgent>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await paseo.agents.list({ filter: { labels: { "linear.issueId": issueId }, includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of page.entries) agents.set(agent.id, agent);
    if (!page.pageInfo) return null;
    if (!page.pageInfo.hasMore) return [...agents.values()];
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (!cursor || cursors.has(cursor)) return null;
    cursors.add(cursor);
  }
  return null;
}
