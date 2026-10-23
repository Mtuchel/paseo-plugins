import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documentPlanHash, planHash } from "./review-outcome";
import { blockLines, orderLine, parseBlock, RELATED_WORK_TAG, stepOf, type WorkOrderStep } from "../shared/work-order";
import { refusedByLinear, type LinearService } from "./linear";
import { hasLabel, PLAN_LABEL, PLAN_READY_LABEL } from "./plan-policy";
import type { PlanRequest } from "./plan-requests";
import { RateLimitedError, withPriority } from "./rate-budget";
import { isUntrusted } from "./starter";
import { paseoHome } from "./ticket-mcp";

// Spacing between the sweep's retries of a record whose last round failed, and how often it looks.
export const RETRY_MS = 10 * 60_000;
const SCAN_MS = 60_000;
// Rounds that failed (Linear unreachable, or the Paseo app unusable) before the record stops.
const MAX_ROUNDS = 5;
const FINISHED: Record<string, true> = { completed: true, canceled: true, duplicate: true };
// A ticket nobody works on is the only one a plan may close as its duplicate (as ProjectFlow.write).
const UNSTARTED: Record<string, true> = { backlog: true, unstarted: true, triage: true };

type Linear = Pick<LinearService,
  | "issueCore" | "issueRef" | "issueDocument" | "issueRelations" | "blockerStates" | "viewerId" | "trustedAppIds"
  | "addBlockerAsApp" | "relateAsApp" | "addLabelAsApp" | "removeLabelAsApp" | "commentAsApp" | "replanComments" | "commentById">;

export type RelationStep = {
  // The canonical line, and the record's done key for blocks/relates/duplicates.
  line: string;
  kind: "blocks" | "relates" | "duplicates" | "replan";
  ticket: string;
  other?: string;
  reason: string;
  done: boolean;
  // Why the line is not applied: Linear refused it, or the ticket it names is not eligible
  // (`replan` only). `pending` steps stopped by `stopped` are listed as not applied instead.
  skipped?: string;
  // `duplicates`: the hold and the comment are written one at a time, so a restart repeats only
  // the missing step; the link is `done`. The comment's id is reserved before it is posted, so a
  // lost answer is looked up instead of posting it again.
  held?: boolean;
  told?: boolean;
  tellId?: string;
  // `replan`: the plan hash the request is about, and the operation id the comment carries.
  targetId?: string;
  replanFor?: string;
  opId?: string;
  opAt?: string;
  commentPosted?: boolean;
  labelled?: boolean;
};

export type RelationsRecord = {
  issueId: string;
  // The record file's own identity: a catch-up section files one record per ticket beside the
  // ticket's agent record, and the outcome is read back by it. Absent for a ticket's own record.
  recordId?: string;
  identifier: string;
  documentUrl: string | null;
  // sha256 of the plan text the keys belong to: a revised plan re-asks its `replan` lines and
  // keeps every other line's done state.
  planHash: string;
  // The latest approved block's keys, in plan order.
  lines: string[];
  steps: Record<string, RelationStep>;
  // Lines of the block that were not one change; left alone (the bridge sends such plans back).
  unreadable: string[];
  // Earlier approved blocks: lines that no longer apply, and applied lines they listed.
  dropped: string[];
  doneElsewhere: string[];
  // The start of the planning round the approved plan answers: the newest request that started
  // it, or the planner agent's creation time. Null when neither is known.
  roundStartedAt: string | null;
  // The `plan` label's lifecycle (README, "Related work"): pending while it may still be set.
  removal: "pending" | "done";
  removalKept?: boolean;
  removalRestored?: boolean;
  attempts: number;
  retryAt: number | null;
  // A catch-up section's guard (README, "Catch-up of older plans"): the ticket's plan document
  // hash it was written for, re-read before every write step. A new approval stops it.
  guard?: { issueId: string; planHash: string };
  // What a replan comment credits ("<origin>'s approved plan"): this host, or the catch-up's
  // identifier for a catch-up section's request. Kept on the record for the retries.
  origin?: string;
  stopped?: "gave-up" | "untrusted" | "changed";
  // sha256 of the last comment posted, with the id reserved before it (as PlanFollowUps).
  summary: string | null;
  summaryId?: string;
  summaryPending?: string;
};

export type RelationsRequest = {
  issueId: string;
  identifier: string;
  plan: string;
  documentUrl: string | null;
  // A catch-up section (README, "Related work") applies links only: it never touches the label.
  cleanup?: boolean;
  roundStartedAt?: string | null;
  // The record's own file identity (a catch-up section's `catch-up:<issueId>:<planHash>`); the
  // serial key stays the ticket's, so its records still run one at a time. Default: the ticket's.
  recordId?: string;
  // A catch-up section's replan comments credit the catch-up ticket, not this host.
  origin?: string;
  // A catch-up section's guard: the ticket's `Plan:` document hash its lines were written for.
  // Every write step re-reads that hash and the ticket's trust first, and stops the remaining
  // lines (`changed`) when either moved: the owner replaced the plan this analysis covers.
  guard?: { issueId: string; planHash: string };
};

// What a record reached, read by its id (the catch-up marks its sections pending, applied or
// skipped with it). A missing record is pending: `file()` has not run yet.
export type RelationsOutcome = { status: "pending" } | { status: "done" } | { status: "stopped"; reason: "gave-up" | "untrusted" | "changed" };

// A plan's `## Related work` block (README, "Related work"): approving the plan writes each line
// into Linear as the Paseo app (never the owner's key) — a blocker, a relation, closing an
// unstarted ticket as this plan's duplicate, or a replan request on another ticket — then one
// comment on this ticket. One private record per ticket under
// `$PASEO_HOME/linear-tickets/plan-relations`, written after every Linear write, so a repeated
// approval writes nothing twice and a failed round only repeats what is missing. Work for one
// ticket runs one call at a time (the plugin is one process). `file()` runs one round and resolves
// once the work is done, a retry is scheduled, or the record stopped: the decision journal calls it
// again while it rejects, so an unavailable app must not hold the approval back. Only a rate limit
// rejects, which pauses the journal with it. The bridge's sweep (`retryPending`) does the later
// rounds ten minutes apart.
export class PlanRelations {
  private readonly chains = new Map<string, Promise<void>>();
  private lastScan = Number.NEGATIVE_INFINITY;
  private scanning = false;

  constructor(
    private readonly linear: Linear,
    // The requests newer than a time on a ticket (server/plan-requests.ts), for the label's
    // removal: the request that started this round is at `roundStartedAt`, not newer.
    private readonly requests: (issueId: string, identifier: string, since: string | null, planHash: string | null) => Promise<PlanRequest[]>,
    // This host's name ("server087"), for the replan comment's first line.
    private readonly origin: () => string,
    private readonly directory = join(paseoHome(), "linear-tickets", "plan-relations"),
    private readonly now: () => number = Date.now,
  ) {}

  file(request: RelationsRequest): Promise<void> {
    const block = parseBlock(request.plan, RELATED_WORK_TAG);
    const removal = request.cleanup !== false;
    // No block (a plan from before the rollout) is a plan with no related work: nothing to apply.
    if (block === null && !removal) return Promise.resolve();
    // A catch-up section files its own record beside the ticket's own; the ticket still runs one
    // call at a time, so two records of one ticket never write at once.
    const key = request.recordId ?? request.issueId;
    return this.serial(request.issueId, async () => {
      const record = await this.load(key) ?? {
        issueId: request.issueId, identifier: request.identifier, documentUrl: null, planHash: "", lines: [], steps: {}, unreadable: [],
        dropped: [], doneElsewhere: [], roundStartedAt: null, removal: "pending", attempts: 0, retryAt: null, summary: null,
      };
      // A later catch-up resumes the record an earlier one stopped (README, "Catch-up of older
      // plans"): its done lines and operation ids stay, its rounds start over.
      const resumed = Boolean(request.origin && record.origin && record.origin !== request.origin);
      if (request.recordId) record.recordId = request.recordId;
      if (request.guard) record.guard = request.guard;
      if (request.origin) record.origin = request.origin;
      record.identifier = request.identifier;
      record.documentUrl = request.documentUrl ?? record.documentUrl;
      if (request.roundStartedAt !== undefined) record.roundStartedAt = request.roundStartedAt;
      const hash = planHash(request.plan);
      // A revised plan is a fresh attempt: its lines re-ask and its rounds start over. A filing of
      // the same plan (a retried decision step) keeps the rounds and the schedule it reached.
      const revised = record.planHash !== hash;
      const parsed = blockLines(block ?? "").map((line) => ({ line, step: stepOf(line) }));
      // A revised plan: the same line keeps its done state, a line it no longer lists is dropped
      // (never written halfway), and `replan` lines are keyed by the plan's hash, so they ask again.
      // A catch-up section's replan belongs to the listed ticket's plan (`guard`), not to the
      // section's wording: a changed analysis of the same plan never asks a second time.
      const replanHash = request.guard?.planHash ?? hash;
      const keys = parsed.flatMap(({ line, step }) => step ? [step.kind === "replan" ? `${line} @ ${replanHash}` : line] : []);
      if (record.planHash && revised) {
        const current = new Set(keys);
        for (const [key, step] of Object.entries(record.steps)) {
          if (current.has(key)) continue;
          if (step.done) record.doneElsewhere.push(step.line);
          else if (!record.steps[key].skipped) record.dropped.push(step.line);
          delete record.steps[key];
        }
        record.dropped = [...new Set(record.dropped)];
        record.doneElsewhere = [...new Set(record.doneElsewhere)];
        record.attempts = 0;
        record.retryAt = null;
        delete record.stopped;
        delete record.removalKept;
        delete record.removalRestored;
      }
      if (resumed && !revised) {
        record.attempts = 0;
        record.retryAt = null;
        delete record.stopped;
      }
      record.planHash = hash;
      record.lines = keys;
      record.unreadable = parsed.flatMap(({ line, step }) => step ? [] : [line]);
      for (const [index, key] of keys.entries()) {
        if (!record.steps[key]) record.steps[key] = this.freshStep(parsed[index].step!);
      }
      // A links-only pass (the catch-up) leaves the label to the approval that applied it; the same
      // plan keeps where its removal got to, so a crash before or after the remove repeats it.
      if (!removal) record.removal = "done";
      else if (revised) record.removal = "pending";
      await this.save(record);
      // A stopped record and a retry that is not due yet are left to the sweep: the decision step
      // completes and the approval moves on while the relations retry on their own schedule.
      if (record.stopped || (record.retryAt !== null && record.retryAt > this.now())) return;
      await this.process(record);
    });
  }

  // Called from the bridge's sweep beside `followUps.retryPending()`: retries records with a
  // retry due. Never rejects itself; a failed round is logged and left for the next sweep.
  async retryPending(): Promise<void> {
    if (this.scanning || this.now() - this.lastScan < SCAN_MS) return;
    this.scanning = true;
    this.lastScan = this.now();
    const due = (record: RelationsRecord | null): record is RelationsRecord => record !== null && record.retryAt !== null && record.retryAt <= this.now();
    try {
      for (const name of await readdir(this.directory).catch(() => [] as string[])) {
        if (!name.endsWith(".json")) continue;
        const found = await this.read(join(this.directory, name));
        if (!due(found)) continue;
        const key = found.recordId ?? found.issueId;
        await this.serial(found.issueId, async () => {
          const record = await this.load(key);
          if (due(record)) await this.process(record);
        }).catch((error: unknown) => {
          console.error(`[linear-tickets] retrying the plan relations of ${found.identifier} failed: ${message(error)}`);
        });
      }
    } finally {
      this.scanning = false;
    }
  }

  // The record's step for one parsed line: `blocks` keeps both sides in `ticket`/`other`.
  private freshStep(step: WorkOrderStep): RelationStep {
    if (step.kind === "blocks") return { line: orderLine(step), kind: step.kind, ticket: step.blocker, other: step.blocked, reason: "", done: false };
    if (step.kind === "replan") return { line: orderLine(step), kind: step.kind, ticket: step.ticket, reason: step.reason, done: false };
    if (step.kind === "hold" || step.kind === "release" || step.kind === "attended" || step.kind === "unattended") {
      return { line: orderLine(step), kind: "relates", ticket: step.ticket, reason: step.reason, done: false, skipped: "not allowed in a ticket plan" };
    }
    return { line: orderLine(step), kind: step.kind, ticket: step.ticket, other: step.kind === "relates" || step.kind === "duplicates" ? step.other : undefined, reason: step.reason, done: false };
  }

  // One ticket's work runs one call at a time, as PlanFollowUps.serial.
  private serial(issueId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(issueId) ?? Promise.resolve()).then(work);
    const chain = run.catch(() => {});
    this.chains.set(issueId, chain);
    void chain.then(() => { if (this.chains.get(issueId) === chain) this.chains.delete(issueId); });
    return run;
  }

  // One round under the owner's budget. A rate limit is the journal's own pause (it keeps the
  // attempt); every other failure is counted here, on the record's ten-minute schedule, so the
  // decision step always resolves and the sweep carries the work out later.
  private process(record: RelationsRecord): Promise<void> {
    return withPriority("owner", "plan relations", async () => {
      try {
        await this.processRound(record);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          record.retryAt = error.resumeAt;
          await this.save(record);
          throw error;
        }
        if (!record.stopped && record.retryAt === null) this.failedRound(record);
        await this.save(record);
        console.error(`[linear-tickets] ${record.identifier}: the related-work round failed: ${message(error)}`);
        return;
      }
      // A round that leaves work outstanding without scheduling a retry would wait forever.
      if (!this.settled(record) && !record.stopped && record.retryAt === null) {
        console.error(`[linear-tickets] ${record.identifier}: the related work is outstanding with no retry scheduled; the record retries.`);
        this.failedRound(record);
        await this.save(record);
      }
    });
  }

  private async processRound(record: RelationsRecord): Promise<void> {
    const steps = record.lines.flatMap((key) => record.steps[key] ?? []);
    // This round consumes the due retry, so a failure anywhere in it is counted once (`process`).
    record.retryAt = null;
    let failed = false;
    if (!record.stopped) {
      // Checked before the first write, so a feedback label added while the plan waits stops it.
      const state = await this.linear.issueCore(record.issueId);
      if (isUntrusted(state, await this.linear.viewerId(), await this.linear.trustedAppIds())) {
        record.stopped = "untrusted";
        await this.save(record);
      }
    }
    for (const step of steps) {
      if (record.stopped || step.done || step.skipped) continue;
      // A catch-up section's guard (below): the plan it analyses may be replaced between two lines.
      if (await this.guardMoved(record)) { await this.save(record); break; }
      try {
        if (await this.apply(record, step)) {
          step.done = true;
          await this.save(record);
        } else if (!step.skipped) {
          // The app could not write (mutate answered null): the step waits for the next round.
          failed = true;
        }
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        if (refusedByLinear(error)) {
          step.skipped = message(error);
          await this.save(record);
        } else {
          failed = true;
          console.error(`[linear-tickets] ${record.identifier}: applying related-work "${step.line}" failed: ${message(error)}`);
        }
      }
    }
    if (!record.stopped && record.removal === "pending") {
      if (await this.cleanUp(record).catch((error: unknown) => {
        if (error instanceof RateLimitedError) throw error;
        console.error(`[linear-tickets] ${record.identifier}: the plan label's removal failed: ${message(error)}`);
        return false;
      })) await this.save(record);
      else failed = true;
    }
    if (failed && !record.stopped) this.failedRound(record);
    await this.save(record);
    await this.announce(record, steps);
  }

  // A catch-up section's guard (server/related-catch-up.ts): its lines belong to the plan hash it
  // names, and the ticket must still be trusted. Both are re-read before every write step, so a
  // plan approved again mid-round stops the remaining lines instead of linking them under a plan
  // the owner replaced. True when the record stopped.
  private async guardMoved(record: RelationsRecord): Promise<boolean> {
    const guard = record.guard;
    if (!guard) return false;
    const state = await this.linear.issueCore(guard.issueId);
    if (isUntrusted(state, await this.linear.viewerId(), await this.linear.trustedAppIds())) {
      record.stopped = "untrusted";
      return true;
    }
    const plan = await this.linear.issueDocument(guard.issueId, `Plan: ${state.identifier}`);
    if (!plan || documentPlanHash(plan.content) !== guard.planHash) {
      record.stopped = "changed";
      return true;
    }
    return false;
  }

  // What a record reached, by its id (server/related-catch-up.ts marks its sections with it): a
  // missing record has not run yet.
  async outcome(recordId: string): Promise<RelationsOutcome> {
    const record = await this.load(recordId);
    if (!record) return { status: "pending" };
    if (record.stopped) return { status: "stopped", reason: record.stopped };
    return { status: this.settled(record) ? "done" : "pending" };
  }

  // One line, as the Paseo app. True when done; false when the app could not be used (retried).
  private async apply(record: RelationsRecord, step: RelationStep): Promise<boolean> {
    if (step.kind === "replan") return this.replan(record, step);
    // A ticket plan may only change its own ticket's links (D2), in either position of the line;
    // every other line is unreadable.
    if (![step.ticket, step.other].includes(record.identifier)) {
      step.skipped = `it names no link of ${record.identifier}`;
      return false;
    }
    if (step.kind === "blocks") {
      const blocker = await this.linear.issueRef(step.ticket);
      const blocked = await this.linear.issueRef(step.other!);
      if (!blocker || !blocked) { step.skipped = `${blocker ? step.other : step.ticket} does not exist`; return false; }
      if (blocker.id === blocked.id) { step.skipped = "a ticket cannot block itself"; return false; }
      // A retried write must not add the blocker twice.
      const linked = (await this.linear.issueRelations(blocked.id)).some((relation) => relation.type === "blocks" && relation.direction === "in" && relation.id === blocker.id);
      return linked || (await this.linear.addBlockerAsApp(blocker.id, blocked.id)) !== null;
    }
    // `relates` and `duplicates` name two tickets, and the plan's own may be either. Both are
    // resolved, and the line keeps its direction: the first ticket is the one a duplicate closes.
    const link = await this.linear.issueRef(step.ticket);
    const other = await this.linear.issueRef(step.other!);
    if (!link) { step.skipped = `${step.ticket} does not exist`; return false; }
    if (!other) { step.skipped = `${step.other} does not exist`; return false; }
    if (link.id === other.id) { step.skipped = "a ticket cannot be linked to itself"; return false; }
    const relations = await this.linear.issueRelations(link.id);
    // Any relation counts for `relates`; only the duplicate ticket's own link for `duplicates`.
    const linked = relations.some((relation) => relation.id === other.id && (step.kind === "relates" || (relation.type === "duplicate" && relation.direction === "out")));
    if (linked) return true;
    if (step.kind === "relates") return (await this.linear.relateAsApp(link.id, other.id, "related")) !== null;
    const info = (await this.linear.blockerStates([link.id]))[0];
    if (!info || !UNSTARTED[info.statusType] || info.delegateId) {
      step.skipped = "started or with an agent; only a ticket nobody works on is closed as a duplicate";
      return false;
    }
    if (!step.held) {
      if (await this.linear.addLabelAsApp(link.id, "paseo-hold") === null) return false;
      step.held = true;
      await this.save(record);
    }
    if (!step.told) {
      // The id is reserved and saved first: a comment Linear created whose answer was lost is
      // found on the retry instead of posted twice (as the summary path does).
      if (!step.tellId) {
        step.tellId = randomUUID();
        await this.save(record);
      }
      const body = `Closed as a duplicate of ${other.identifier} by ${record.identifier}'s approved plan${step.reason ? `: ${step.reason}` : "."}`;
      const posted = (await this.linear.commentById(step.tellId)) !== null;
      if (!posted && (await this.linear.commentAsApp(link.id, body, step.tellId)) === null) return false;
      step.told = true;
      await this.save(record);
    }
    return (await this.linear.relateAsApp(link.id, other.id, "duplicate")) !== null;
  }

  // A replan request on another ticket (README, "Related work"): only an open ticket whose plan is
  // approved, only about the plan hash it had when the request was saved, and posted once under its
  // operation id.
  private async replan(record: RelationsRecord, step: RelationStep): Promise<boolean> {
    const target = await this.linear.issueRef(step.ticket);
    if (!target) { step.skipped = `${step.ticket} does not exist`; return false; }
    const info = (await this.linear.blockerStates([target.id]))[0];
    if (!info || FINISHED[info.statusType]) { step.skipped = "the ticket is not open"; return false; }
    const core = await this.linear.issueCore(target.id);
    if (!hasLabel(core.labels, PLAN_READY_LABEL)) { step.skipped = "the ticket has no approved plan"; return false; }
    const document = await this.linear.issueDocument(target.id, `Plan: ${target.identifier}`);
    if (!document) { step.skipped = "the ticket has no plan document"; return false; }
    const current = documentPlanHash(document.content);
    step.targetId = target.id;
    if (!step.replanFor) {
      step.replanFor = current;
      step.opId = randomUUID();
      step.opAt = new Date(this.now()).toISOString();
      await this.save(record);
    }
    // A retry never moves a request to a plan that replaced the one it is about.
    if (current !== step.replanFor) { step.skipped = `the plan of ${target.identifier} was replaced since this request`; return false; }
    if (!step.commentPosted) {
      const posted = await this.linear.replanComments(target.id, step.opAt!).then((comments) => comments.some((comment) => comment.body.includes(`<!-- replan-op: ${step.opId} -->`)));
      if (!posted) {
        const body = [
          `🔁 **Replan requested** by ${record.origin ?? this.origin()}'s approved plan`,
          "",
          step.reason || `${record.identifier}'s approved plan depends on this ticket's plan.`,
          ...(record.documentUrl ? [`[${record.identifier}'s approved plan](${record.documentUrl})`] : []),
          `<!-- replan-op: ${step.opId} -->`,
          `<!-- replan-for: ${step.replanFor} -->`,
        ].join("\n");
        if (await this.linear.commentAsApp(target.id, body) === null) return false;
      }
      step.commentPosted = true;
      await this.save(record);
    }
    if (!step.labelled) {
      // The visible indicator; not a request of its own, and planning never depends on it.
      if (await this.linear.addLabelAsApp(target.id, PLAN_LABEL) === null) return false;
      step.labelled = true;
      await this.save(record);
    }
    return true;
  }

  // The `plan` label: removed once the round the approval answers has no request newer than its
  // start, put back when one arrived while it was being removed. A restart repeats the steps, so a
  // crash before or after the remove ends with the label in the right place.
  private async cleanUp(record: RelationsRecord): Promise<boolean> {
    const since = record.roundStartedAt;
    if (since === null) {
      // No round start (an agent record from before this change): the label is left alone.
      record.removal = "done";
      return true;
    }
    const open = await this.requests(record.issueId, record.identifier, since, record.planHash);
    if (open.length) {
      // Added, not assumed: a retry after a removal whose restore failed finds the label gone.
      if (await this.linear.addLabelAsApp(record.issueId, PLAN_LABEL) === null) return false;
      record.removal = "done";
      record.removalKept = true;
      return true;
    }
    if (await this.linear.removeLabelAsApp(record.issueId, PLAN_LABEL) === null) return false;
    await this.save(record);
    const after = await this.requests(record.issueId, record.identifier, since, record.planHash);
    if (after.length) {
      if (await this.linear.addLabelAsApp(record.issueId, PLAN_LABEL) === null) return false;
      record.removalRestored = true;
    }
    record.removal = "done";
    return true;
  }

  private settled(record: RelationsRecord): boolean {
    if (record.stopped) return true;
    const steps = record.lines.flatMap((key) => record.steps[key] ?? []);
    if (!steps.every((step) => step.done || step.skipped)) return false;
    if (record.removal === "pending") return false;
    const body = summaryText(record, steps);
    return body === null || createHash("sha256").update(body).digest("hex") === record.summary;
  }

  private failedRound(record: RelationsRecord): void {
    record.attempts += 1;
    if (record.attempts < MAX_ROUNDS) {
      record.retryAt = this.now() + RETRY_MS;
      return;
    }
    record.retryAt = null;
    // A record stopped for another reason (an untrusted ticket) keeps that reason and stops
    // retrying its comment it cannot write.
    if (record.stopped) return;
    record.stopped = "gave-up";
    console.error(`[linear-tickets] ${record.identifier}: the plan's related work was not applied after ${MAX_ROUNDS} rounds; the record stops. Approve a revised plan to retry.`);
  }

  // One comment per distinct outcome, none while a write still waits for its retry. The id is
  // reserved and saved before the post, so a lost answer never posts it twice; a null answer (the
  // app cannot write) keeps the reservation and the summary unannounced, and retries.
  private async announce(record: RelationsRecord, steps: RelationStep[]): Promise<void> {
    const body = summaryText(record, steps);
    if (!body) return;
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash === record.summary) return;
    try {
      const reserved = record.summaryPending === hash ? record.summaryId : undefined;
      const id = reserved ?? randomUUID();
      const posted = reserved ? (await this.linear.commentById(reserved)) !== null : false;
      if (!reserved) {
        record.summaryId = id;
        record.summaryPending = hash;
        await this.save(record);
      }
      if (posted || (await this.linear.commentAsApp(record.issueId, body, id)) !== null) {
        record.summary = hash;
        delete record.summaryId;
        delete record.summaryPending;
      } else if (record.retryAt === null && record.stopped !== "gave-up") {
        // The comment could not be written: the reservation stays and the sweep retries, also for
        // an untrusted ticket's information-only comment.
        this.failedRound(record);
      }
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      console.error(`[linear-tickets] ${record.identifier}: the related-work comment failed: ${message(error)}`);
      if (record.retryAt === null && record.stopped !== "gave-up") this.failedRound(record);
    }
    await this.save(record);
  }

  // `key`: the record's id (the ticket's own id, or a catch-up section's `recordId`).
  private path(key: string): string {
    return join(this.directory, `${key.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
  }

  private load(key: string): Promise<RelationsRecord | null> {
    return this.read(this.path(key));
  }

  private async read(path: string): Promise<RelationsRecord | null> {
    const value: unknown = await readFile(path, "utf8").then(JSON.parse, () => null);
    if (!value || typeof value !== "object") return null;
    const record = value as RelationsRecord;
    return typeof record.issueId === "string" && Array.isArray(record.lines) && record.steps && typeof record.steps === "object" ? record : null;
  }

  private async save(record: RelationsRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.recordId ?? record.issueId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
}

// What the ticket's comment says about the approved plan's related work; null when there is
// nothing to say (no line and no label change).
export function summaryText(record: Pick<RelationsRecord, "identifier" | "documentUrl" | "dropped" | "doneElsewhere" | "unreadable" | "stopped" | "removalKept" | "removalRestored">, steps: RelationStep[]): string | null {
  if (!steps.length && !record.dropped.length && !record.unreadable.length && !record.removalKept && !record.removalRestored) return null;
  const plan = record.documentUrl ? ` ([plan](${record.documentUrl}))` : "";
  const applied = steps.filter((step) => step.done);
  const refused = steps.filter((step) => step.skipped && !step.done);
  const waiting = steps.filter((step) => !step.done && !step.skipped);
  const sections: string[] = [];
  if (record.stopped === "untrusted") {
    sections.push(`The approved plan's related work${plan}, not applied because this ticket was not written by you or Paseo. Review it by hand:\n${steps.map((step) => `- ${step.line}`).join("\n")}`);
  } else {
    if (applied.length) sections.push(`Related work applied from the approved plan${plan}:\n${applied.map((step) => `- ${step.line}${step.kind === "replan" ? ` (asked ${step.ticket} to plan again)` : ""}`).join("\n")}`);
    if (refused.length) sections.push(`Not applied:\n${refused.map((step) => `- ${step.line} (${step.skipped})`).join("\n")}`);
    if (waiting.length) sections.push(record.stopped === "changed"
      ? `Not applied — this analysis covers an earlier approved plan of ${record.identifier}, which was approved again (or whose plan document changed) while its lines were being written. The current plan carries its own related-work list, so these lines stop here:\n${waiting.map((step) => `- ${step.line}`).join("\n")}`
      : `Not applied yet — Paseo could not write to Linear as itself; it retries every ten minutes. Approve a revised plan to try again:\n${waiting.map((step) => `- ${step.line}`).join("\n")}`);
    if (record.doneElsewhere.length) sections.push(`Applied from an earlier approved plan, no longer listed:\n${record.doneElsewhere.map((line) => `- ${line}`).join("\n")}`);
    if (record.dropped.length) sections.push(`Dropped with this plan (never applied):\n${record.dropped.map((line) => `- ${line}`).join("\n")}`);
    if (record.unreadable.length) sections.push(`Not one related-work line, left alone:\n${record.unreadable.map((line) => `- ${line}`).join("\n")}`);
    if (record.removalKept) sections.push(`The \`${PLAN_LABEL}\` label stays: a replan request arrived while this approval was being applied.`);
    if (record.removalRestored) sections.push(`The \`${PLAN_LABEL}\` label was set again: a replan request arrived while it was being removed.`);
  }
  return sections.join("\n\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}