import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { footprintOverlap, planFootprint, type PlanFootprint } from "../shared/plan-footprint";
import { overlapText } from "../shared/plan-risk";
import { JsonFile } from "./activation";
import type { LinearService } from "./linear";
import type { RelatedWork } from "./related-work";
import { approvalInterval, approvedDocument, documentPlanHash, planHash } from "./review-outcome";
import { paseoHome } from "./ticket-mcp";

// One approval coordinator across the plugin's hosts (README, "Plan risk and auto-approval"). Linear
// has no compare-and-set and no read-after-write guarantee across clients, so the hosts do not
// coordinate through Linear: the one host with `dispatch.enabled` is the only place that grants an
// automatic approval, and every other host asks it over the tailnet inbox channel. A grant is
// decided against the grants still held, the approval ledger and Linear's committed approvals, so
// two overlapping plans cannot both be approved automatically; a host that cannot reach the
// coordinator never auto-approves.
const DAY_MS = 86_400_000;
// A terminal answer is kept this long, and a claim id older than 30 days is answered `expired`: a
// retry, however late, never becomes a new grant.
const ANSWER_DAYS = 60;
const EXPIRED_DAYS = 30;
// A granted claim held this long without a settle or a matching `Plan:` document asks the owner.
const UNCONFIRMED_MS = 60 * 60_000;
// The coordinator's own settle sweep: one Linear read per granted claim.
export const CLAIM_SWEEP_MS = 60_000;
// A requester rechecks its claims this often; its bridge sweeps every three seconds.
export const RECONCILE_MS = 60_000;
// How long a peer's `/api/inbox` answer is trusted for the coordinator lookup.
export const COORDINATOR_TTL_MS = 60_000;
// The review inbox's peer-read timeout.
const PEER_TIMEOUT_MS = 4_000;
// What an automatic claim may name; a larger plan goes to the owner instead of into a claim.
const MAX_FILES = 300;
const MAX_PLACES = 60;
const MAX_TICKETS = 60;
const MAX_ENTRY_CHARS = 200;
// A status type, not a state name: only these mean the ticket is no longer open.
const FINISHED: Record<string, true> = { completed: true, canceled: true };

export type ClaimState = "granted" | "denied" | "withdrawn" | "committed" | "expired";
export type ClaimAnswer = { state: ClaimState | "unreachable"; reason?: string; other?: string };
// What the requester asks for, and what the coordinator keeps for as long as the claim is live.
export type ClaimRequest = {
  claimId: string;
  issueId: string;
  identifier: string;
  planHash: string;
  footprint: PlanFootprint;
  roundStartedAt: string;
  // The requester's own inbox origin, so the coordinator can ask it back; null when the requester is
  // this host, which the coordinator answers in process.
  origin: string | null;
};
export type ClaimGrant = ClaimRequest & { grantedAt: string };
// A committed approval: an automatic claim that settled, or any host's owner approval reported in.
export type OwnerApproval = { issueId: string; identifier: string; planHash: string; footprint: PlanFootprint; approvedAt: string };
// A host's answer about its own intent record for one claim (`GET /api/approval-claims/<id>/holder`).
export type HolderAnswer = { claim: "none" | ClaimIntentState; planHash?: string };
// What became of a claim's review: its decided plan's document was written; a decision on another
// plan was applied; a decision is being applied; the review still waits; or it is gone with nothing
// recorded (the one state that cannot be told).
export type ClaimReviewState = "applied" | "other" | "pending" | "open" | "gone";
// The requester's own record for a claimed plan, written before the claim is sent.
export type ClaimIntentState = "claiming" | "granted" | "unclear";
export type ClaimIntent = {
  claimId: string;
  issueId: string;
  identifier: string;
  planHash: string;
  footprint: PlanFootprint;
  roundStartedAt: string;
  agentId: string;
  localUrl: string;
  // The decision journal's review generation, so reconciliation can tell an applied decision from a
  // waiting review without trusting the plan text again.
  reviewId: string;
  // Whether the owner was told this claim can no longer be answered (a failed comment is retried).
  item?: true;
  // A parked plan's approval is carried out on the parked route, which cannot be judged again.
  parked?: boolean;
  state: ClaimIntentState;
  at: string;
};

const entry = z.string().min(1).max(MAX_ENTRY_CHARS);
const FootprintBody = z.object({
  files: z.array(entry).max(MAX_FILES),
  places: z.array(entry).max(MAX_PLACES),
  tickets: z.array(entry).max(MAX_TICKETS),
  ticket: entry.nullable(),
});
// An owner approval is recorded whole, bounded only by the route's body limit: leaving entries out
// would let an overlapping plan be approved automatically.
const OwnerFootprintBody = z.object({ files: z.array(z.string().min(1)), places: z.array(z.string().min(1)), tickets: z.array(z.string().min(1)), ticket: z.string().min(1).nullable() });
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().min(1).max(100);
const uuid = z.string().uuid().max(64);
const time = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)));
export const ClaimBody = z.object({
  claimId: uuid, issueId: z.string().min(1).max(200), identifier, planHash: hash, footprint: FootprintBody,
  roundStartedAt: time, origin: z.string().url().max(500).nullable().optional(),
}).strict();
export const SettleBody = z.object({ claimId: uuid, state: z.enum(["committed", "withdrawn"]) }).strict();
export const RecordBody = z.object({ issueId: z.string().min(1).max(200), identifier, planHash: hash, footprint: OwnerFootprintBody, approvedAt: time }).strict();
// `POST /api/approval-claims` (claim), `/settle` and `/record`; `GET /api/approval-claims/<id>` and
// `/<id>/holder`.
export const CLAIM_ROUTE = /^\/api\/approval-claims(?:\/(settle|record|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?(?:\/(holder))?\/?$/;
const ClaimAnswerBody = z.object({ state: z.enum(["granted", "denied", "withdrawn", "committed", "expired"]), reason: z.string().max(500).optional(), other: z.string().max(100).optional() });
const HolderBody = z.object({ claim: z.enum(["none", "claiming", "granted", "unclear"]), planHash: hash.optional() });
// A peer's `/api/inbox` answer, read only for whether it is the approval coordinator. A peer from
// before this field existed reads as not one: during a rolling upgrade nobody trusts it.
const DispatchBody = z.object({ dispatch: z.object({ enabled: z.boolean() }).optional() });

type Grants = Record<string, ClaimGrant>;
type Answers = Record<string, { state: "denied" | "withdrawn" | "committed"; reason?: string; other?: string; at: string }>;
type Ledger = Record<string, OwnerApproval & { recordedAt: string }>;
type Item = { claimId: string; issueId: string; identifier: string; itemAt: string; answeredAt?: string; holder?: string };
type Items = Record<string, Item>;
type Outbox = Record<string, OwnerApproval>;

// A uuid v7 (RFC 9562): the first 48 bits are the claim's creation time, which is how a retried
// claim id is aged without keeping the answer forever.
export function newClaimId(now = Date.now()): string {
  const bytes = randomBytes(16);
  let left = BigInt(Math.max(0, Math.trunc(now)));
  for (let index = 5; index >= 0; index--) { bytes[index] = Number(left & 0xffn); left >>= 8n; }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function claimIdTime(claimId: string): number | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(claimId.toLowerCase());
  return match ? parseInt(match[1] + match[2], 16) : null;
}

// A uuid the plugin derives from a name, so a comment posted again uses the same id instead of
// showing twice.
function uuidFrom(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

// True when two plans share anything: a file, a Reach place, a ticket, or either names the other's
// ticket.
function overlaps(a: PlanFootprint, b: PlanFootprint): boolean {
  const match = footprintOverlap(a, b);
  return Boolean(match.files.length || match.places.length || match.tickets.length || match.namesOther);
}

function entriesOf(value: unknown): Record<string, Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Record<string, unknown>> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function footprintOf(value: unknown): PlanFootprint | null {
  const entry = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const list = (raw: unknown): string[] | null => Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw as string[] : null;
  if (!entry) return null;
  const files = list(entry.files), places = list(entry.places), tickets = list(entry.tickets);
  const ticket = entry.ticket === null || entry.ticket === undefined ? null : text(entry.ticket);
  return files && places && tickets && (entry.ticket === undefined || entry.ticket === null || ticket) ? { files, places, tickets, ticket } : null;
}

function grantOf(value: Record<string, unknown>): ClaimGrant | null {
  const footprint = footprintOf(value.footprint);
  const claimId = text(value.claimId), issueId = text(value.issueId), name = text(value.identifier), plan = text(value.planHash), since = text(value.roundStartedAt), at = text(value.grantedAt);
  return footprint && claimId && issueId && name && plan && since && at
    ? { claimId, issueId, identifier: name, planHash: plan, footprint, roundStartedAt: since, origin: text(value.origin), grantedAt: at }
    : null;
}

function approvalOf(value: Record<string, unknown>): OwnerApproval | null {
  const footprint = footprintOf(value.footprint);
  const issueId = text(value.issueId), name = text(value.identifier), plan = text(value.planHash), at = text(value.approvedAt);
  return footprint && issueId && name && plan && at ? { issueId, identifier: name, planHash: plan, footprint, approvedAt: at } : null;
}

function answerOf(stored: Answers[string]): ClaimAnswer {
  return { state: stored.state, ...(stored.reason ? { reason: stored.reason } : {}), ...(stored.other ? { other: stored.other } : {}) };
}

// The dispatch host's approval coordinator. `claim`, `settle`, `record` and `sweep` run one at a
// time, so a grant is decided against every grant and approval this host knows of, never against one
// that another request is about to write.
export class ApprovalClaims {
  private readonly granted: JsonFile<Grants>;
  private readonly answers: JsonFile<Answers>;
  private readonly ledger: JsonFile<Ledger>;
  private readonly items: JsonFile<Items>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(private readonly deps: {
    linear: Pick<LinearService, "issueDocument" | "issueState" | "comment" | "issueCommentHistory" | "viewerId">;
    related: Pick<RelatedWork, "approvedSince">;
    // The requester side on this host, for the claims it made itself (`origin: null`).
    holder?: (claimId: string) => Promise<HolderAnswer | null>;
    directory?: string;
    now?: () => number;
  }) {
    const directory = deps.directory ?? join(paseoHome(), "linear-tickets", "approval-claims");
    this.granted = new JsonFile(join(directory, "granted.json"), () => ({}), (raw) => {
      const grants: Grants = {};
      for (const [key, value] of Object.entries(entriesOf(raw))) {
        const grant = grantOf(value);
        if (grant && grant.claimId === key) grants[key] = grant;
      }
      return grants;
    });
    this.answers = new JsonFile(join(directory, "answers.json"), () => ({}), (raw) => {
      const answers: Answers = {};
      for (const [key, value] of Object.entries(entriesOf(raw))) {
        const state = text(value.state), at = text(value.at);
        if (key && at && (state === "denied" || state === "withdrawn" || state === "committed")) {
          answers[key] = { state, at, ...(text(value.reason) ? { reason: text(value.reason)! } : {}), ...(text(value.other) ? { other: text(value.other)! } : {}) };
        }
      }
      return answers;
    });
    this.ledger = new JsonFile(join(directory, "ledger.json"), () => ({}), (raw) => {
      const ledger: Ledger = {};
      for (const [key, value] of Object.entries(entriesOf(raw))) {
        const approval = approvalOf(value), recordedAt = text(value.recordedAt);
        if (approval && recordedAt) ledger[key] = { ...approval, recordedAt };
      }
      return ledger;
    });
    this.items = new JsonFile(join(directory, "unconfirmed.json"), () => ({}), (raw) => {
      const items: Items = {};
      for (const [key, value] of Object.entries(entriesOf(raw))) {
        const claimId = text(value.claimId), issueId = text(value.issueId), name = text(value.identifier), itemAt = text(value.itemAt);
        if (claimId && issueId && name && itemAt) items[key] = { claimId, issueId, identifier: name, itemAt, ...(text(value.answeredAt) ? { answeredAt: text(value.answeredAt)! } : {}), ...(text(value.holder) ? { holder: text(value.holder)! } : {}) };
      }
      return items;
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, CLAIM_SWEEP_MS);
    this.timer.unref?.();
    void this.sweep();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  // The coordinator's own settle sweep: a granted claim whose ticket's Approved `Plan:` document
  // carries its plan hash has been committed; otherwise a claim held for an hour asks the owner.
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.serial(() => this.sweepOnce()).catch((error: unknown) => {
      console.error(`[linear-tickets] the approval coordinator's sweep failed: ${error instanceof Error ? error.message : error}`);
    }).finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  claim(request: ClaimRequest): Promise<ClaimAnswer> {
    return this.serial(async () => {
      const now = this.deps.now?.() ?? Date.now();
      const answers = await this.answers.load();
      const stored = answers[request.claimId];
      if (stored) return answerOf(stored);
      const grants = await this.granted.load();
      if (grants[request.claimId]) return { state: "granted" };
      // An id whose age cannot be bounded is never granted: the answer would outlive its evidence.
      const created = claimIdTime(request.claimId);
      if (created === null || now - created > EXPIRED_DAYS * DAY_MS) return { state: "expired" };
      // Every answer is stored before it is returned, so a repeat of the same id is answered the same
      // way even after the state it was decided against changed.
      const deny = async (reason: string, other: string): Promise<ClaimAnswer> => {
        await this.answers.update((current) => { current[request.claimId] = { state: "denied", reason, other, at: new Date(now).toISOString() }; });
        return { state: "denied", reason, other };
      };
      // One live claim per ticket: a re-plan's claim waits for the earlier one to settle, since its
      // plan can no longer become the document that gets written.
      if (Object.values(grants).some((grant) => grant.issueId === request.issueId)) {
        return await deny("an automatic approval of this ticket is still in flight", request.identifier);
      }
      // Committed approvals of other tickets since the planning round began, read from Linear: the
      // window in which an owner approval has not been reported here yet but is still seen.
      const since = Date.parse(request.roundStartedAt);
      const committed = await this.deps.related.approvedSince(request.issueId, since, request.footprint, request.identifier);
      if (committed.length) {
        const [first] = committed;
        return await deny(`${first.identifier}'s plan ${overlapText(first.overlap)}`, first.identifier);
      }
      // Every live grant, and every reported approval since the round began, including ones Linear's
      // read may not show yet. An approval from before the round was in the planner's candidate list.
      for (const grant of Object.values(grants)) {
        if (grant.issueId !== request.issueId && overlaps(request.footprint, grant.footprint)) return await deny(`${grant.identifier}'s plan ${overlapText(footprintOverlap(request.footprint, grant.footprint))}`, grant.identifier);
      }
      for (const entry of Object.values(await this.ledger.load())) {
        if (entry.issueId === request.issueId || Date.parse(entry.approvedAt) < since) continue;
        if (overlaps(request.footprint, entry.footprint)) return await deny(`${entry.identifier}'s plan ${overlapText(footprintOverlap(request.footprint, entry.footprint))}`, entry.identifier);
      }
      // Persisted before it is answered, so an answer that cannot be sent is still a grant.
      await this.granted.update((current) => {
        current[request.claimId] = { ...request, origin: request.origin ? request.origin.replace(/\/+$/, "") : null, grantedAt: new Date(now).toISOString() };
      });
      return { state: "granted" };
    });
  }

  settle(claimId: string, state: "committed" | "withdrawn"): Promise<{ state: ClaimState | "unknown" }> {
    return this.serial(async () => {
      const grant = (await this.granted.load())[claimId];
      if (!grant) return { state: await this.answerState(claimId) };
      if (state === "committed") await this.commit(grant);
      else await this.remove(grant.claimId, "withdrawn");
      return { state };
    });
  }

  // An owner approval, reported by the host that wrote its `Plan:` document (its outbox retries
  // until acknowledged here). A retried report is a no-op.
  record(approval: OwnerApproval): Promise<void> {
    return this.serial(async () => {
      const key = `${approval.issueId}:${approval.planHash}`;
      await this.ledger.update((entries) => {
        if (entries[key]) return;
        entries[key] = { ...approval, recordedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString() };
      });
    });
  }

  status(claimId: string): Promise<ClaimState | "unknown"> {
    return this.serial(async () => {
      if ((await this.granted.load())[claimId]) return "granted";
      return this.answerState(claimId);
    });
  }

  private async answerState(claimId: string): Promise<ClaimState | "unknown"> {
    const stored = (await this.answers.load())[claimId];
    if (stored) return stored.state;
    const created = claimIdTime(claimId);
    return created !== null && (this.deps.now?.() ?? Date.now()) - created > EXPIRED_DAYS * DAY_MS ? "expired" : "unknown";
  }

  // Committed: the ledger entry is written (and flushed) before the claim leaves the table, so a
  // crash in between leaves it in both; the next sweep writes the one that is missing and never
  // grants anything in between.
  private async commit(grant: ClaimGrant, approvedAt = grant.grantedAt): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const key = `${grant.issueId}:${grant.planHash}`;
    await this.ledger.update((entries) => {
      if (entries[key]) return;
      entries[key] = { issueId: grant.issueId, identifier: grant.identifier, planHash: grant.planHash, footprint: grant.footprint, approvedAt, recordedAt: new Date(now).toISOString() };
    });
    await this.granted.update((grants) => { delete grants[grant.claimId]; });
    await this.answers.update((answers) => { answers[grant.claimId] = { state: "committed", at: new Date(now).toISOString() }; });
    await this.items.update((items) => { delete items[grant.claimId]; });
  }

  private async remove(claimId: string, state: "withdrawn"): Promise<void> {
    await this.granted.update((grants) => { delete grants[claimId]; });
    await this.answers.update((answers) => { answers[claimId] = { state, at: new Date(this.deps.now?.() ?? Date.now()).toISOString() }; });
    await this.items.update((items) => { delete items[claimId]; });
  }

  private async sweepOnce(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    for (const grant of Object.values(await this.granted.load())) {
      try {
        const document = await this.deps.linear.issueDocument(grant.issueId, `Plan: ${grant.identifier}`);
        if (document && approvedDocument(document.content) && documentPlanHash(document.content) === grant.planHash) {
          await this.commit(grant, new Date(approvalInterval(document.content, "")?.at(0) ?? Date.parse(grant.grantedAt)).toISOString());
          continue;
        }
        await this.confirm(grant, now);
      } catch (error) {
        console.error(`[linear-tickets] checking the automatic approval of ${grant.identifier} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    await this.purge(now);
  }

  // A grant an hour old that its document has not confirmed: one item on the ticket, and the
  // owner's answer asks the holder. Only the holder's own word that it can no longer act (`none`,
  // `unclear`, or a `committed` one with the same hash) releases the claim; a holder still
  // `granted`, one that does not answer, and a closed ticket all leave it blocking.
  private async confirm(grant: ClaimGrant, now: number): Promise<void> {
    const item = (await this.items.load())[grant.claimId];
    if (!item) {
      if (now - Date.parse(grant.grantedAt) < UNCONFIRMED_MS) return;
      const body = [
        `⚠️ **The automatic approval of ${grant.identifier} could not be confirmed.** Paseo approved this plan automatically but has not seen its \`Plan:\` document since (the host that asked may have stopped before writing it).`,
        "No overlapping plan is approved automatically while this is open. Reply on this ticket to have Paseo check again.",
      ].join("\n\n");
      await this.deps.linear.comment(grant.issueId, body, uuidFrom(`approval-unconfirmed:${grant.claimId}`));
      await this.items.update((current) => { current[grant.claimId] = { claimId: grant.claimId, issueId: grant.issueId, identifier: grant.identifier, itemAt: new Date(now).toISOString() }; });
      return;
    }
    if (!item.answeredAt && !await this.ownerAnswered(item)) return;
    if (!item.answeredAt) await this.items.update((current) => { if (current[grant.claimId]) current[grant.claimId].answeredAt = new Date(now).toISOString(); });
    const holder = await this.holderOf(grant);
    const answer = holder?.claim ?? "no answer";
    // A committed claim leaves no holder record (`none`): the requester deletes it once the
    // coordinator answered its commit, and the coordinator's own sweep commits a document it sees.
    if (answer === "none" || answer === "unclear") {
      await this.remove(grant.claimId, "withdrawn");
      await this.deps.linear.comment(grant.issueId, `The automatic approval of ${grant.identifier} was released: the host that asked no longer holds it. Overlapping plans can be approved automatically again.`, uuidFrom(`approval-released:${grant.claimId}`));
      return;
    }
    if (item.holder === answer) return;
    await this.items.update((current) => { if (current[grant.claimId]) current[grant.claimId].holder = answer; });
    const why = answer === "no answer" ? "The host that asked for it did not answer." : `The host that asked for it still holds it (${answer}).`;
    await this.deps.linear.comment(grant.issueId, `The automatic approval of ${grant.identifier} still blocks overlapping plans. ${why} Reply again on this ticket once that host is back or the plan is decided.`, uuidFrom(`approval-held:${grant.claimId}`));
  }

  // Whether the owner replied on the ticket after the item was posted. The item is written with the
  // owner's own key, so it is named and skipped.
  private async ownerAnswered(item: Item): Promise<boolean> {
    const [owner, comments] = await Promise.all([this.deps.linear.viewerId(), this.deps.linear.issueCommentHistory(item.issueId)]);
    const itemId = uuidFrom(`approval-unconfirmed:${item.claimId}`);
    return comments.some((comment) => comment.authorId === owner && comment.id !== itemId && Date.parse(comment.createdAt) > Date.parse(item.itemAt));
  }

  // The requester's own answer on this host, or the holder route of the host that asked.
  private async holderOf(grant: ClaimGrant): Promise<HolderAnswer | null> {
    if (!grant.origin) return this.deps.holder ? await this.deps.holder(grant.claimId) : null;
    try {
      const response = await fetch(`${grant.origin}/api/approval-claims/${encodeURIComponent(grant.claimId)}/holder`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
      if (!response.ok) return null;
      const answer = HolderBody.safeParse(await response.json());
      return answer.success ? { claim: answer.data.claim, ...(answer.data.planHash ? { planHash: answer.data.planHash } : {}) } : null;
    } catch { return null; }
  }

  // Terminal answers are kept 60 days; a ledger entry is kept 60 days after its approval and at
  // least while its ticket is still open (a read that fails keeps it: fail closed).
  private async purge(now: number): Promise<void> {
    await this.answers.update((answers) => {
      for (const [claimId, answer] of Object.entries(answers)) if (now - Date.parse(answer.at) > ANSWER_DAYS * DAY_MS) delete answers[claimId];
    });
    for (const [key, entry] of Object.entries(await this.ledger.load())) {
      if (now - Date.parse(entry.approvedAt) <= ANSWER_DAYS * DAY_MS) continue;
      let finished = false;
      try { finished = Boolean(FINISHED[(await this.deps.linear.issueState(entry.issueId)).statusType.trim().toLowerCase()]); } catch { finished = false; }
      if (finished) await this.ledger.update((entries) => { delete entries[key]; });
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// The requester side on every host (README, "Plan risk and auto-approval"): it writes the intent
// record before a claim is sent, saves the grant before `decide`, settles it once the approved
// plan's document is written, and reconciles every record at start and on every sweep. Owner
// approvals leave through an outbox that is written before their `Plan:` document and reported
// until the coordinator acknowledges it, also when that document's write then failed.
export class ClaimRequests {
  private readonly directory: string;
  private readonly outbox: JsonFile<Outbox>;
  private queue: Promise<unknown> = Promise.resolve();
  private coordinatorCache: { at: number; value: { kind: "local"; claims: ApprovalClaims } | { kind: "peer"; origin: string } | null } | null = null;
  private reconciling: Promise<void> | null = null;
  private lastReconcile = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: {
    linear: Pick<LinearService, "comment">;
    // This host's own coordinator while `dispatch.enabled` is on; otherwise the one peer that answers
    // `dispatch.enabled: true` on `/api/inbox` is asked.
    local: () => Promise<ApprovalClaims | null>;
    peers: () => Promise<string[]>;
    // This host's published inbox origin, which the coordinator uses to ask it back.
    origin: () => Promise<string | null>;
    state: (record: ClaimIntent) => Promise<ClaimReviewState>;
    rejudge: (record: ClaimIntent) => Promise<void>;
    directory?: string;
    now?: () => number;
  }) {
    this.directory = deps.directory ?? join(paseoHome(), "linear-tickets", "approval-claims");
    this.outbox = new JsonFile(join(this.directory, "outbox.json"), () => ({}), (raw) => {
      const entries: Outbox = {};
      for (const [key, value] of Object.entries(entriesOf(raw))) {
        const approval = approvalOf(value);
        if (approval) entries[key] = approval;
      }
      return entries;
    });
  }

  // A claim for a plan that would otherwise be approved automatically. `granted` is the only answer
  // that lets the caller decide; `unreachable` (no coordinator, more than one, or no answer) and
  // every terminal answer keep the plan with the owner.
  claim(input: Omit<ClaimIntent, "claimId" | "state" | "at">): Promise<ClaimAnswer> {
    return this.serial(async () => {
      // The same bound in process and across hosts: a plan this large goes to the owner.
      if (!FootprintBody.safeParse(input.footprint).success) return { state: "denied", reason: "the plan names more files, places or tickets than an automatic approval may", other: input.identifier };
      const now = this.deps.now?.() ?? Date.now();
      const existing = await this.read(input.issueId);
      let record: ClaimIntent;
      if (existing && existing.state === "claiming" && existing.planHash === input.planHash) {
        // A crash between the record and the answer: the same id is sent again, so a grant made
        // already is returned instead of a second one.
        record = existing;
      } else if (existing && existing.state === "granted" && existing.planHash === input.planHash) {
        return { state: "granted" };
      } else if (existing && existing.state === "unclear") {
        return { state: "denied", reason: "an earlier automatic approval of this ticket could not be confirmed", other: input.identifier };
      } else {
        if (existing) await this.withdrawOnce(existing);
        record = { ...input, claimId: newClaimId(now), state: "claiming", at: new Date(now).toISOString() };
        await this.write(record);
      }
      const answer = await this.sendClaim(record);
      if (!answer) {
        // Nothing was granted (no coordinator, or it refused the request): forget the id, so a host
        // without a coordinator keeps no record per plan.
        await this.remove(record.issueId);
        return { state: "unreachable" };
      }
      // Sent, but no answer came back: the coordinator may have granted it. The record stays
      // `claiming`, so reconciliation resends the same id, and a late grant is then committed or
      // given back like any other instead of blocking overlapping plans until the owner answers.
      if (answer.state === "unreachable") return answer;
      if (answer.state === "granted") {
        await this.write({ ...record, state: "granted" });
        return { state: "granted" };
      }
      await this.remove(record.issueId);
      return answer;
    });
  }

  // The approved plan's `Plan:` document was written for a granted claim: it is committed.
  committed(issueId: string, plan: string): Promise<void> {
    return this.serial(async () => {
      const record = await this.read(issueId);
      if (!record) return;
      if (record.state === "granted" && record.planHash === planHash(plan)) {
        await this.settleOnce(record.claimId, "committed");
        await this.remove(issueId);
        return;
      }
      await this.withdrawOnce(record);
    });
  }

  // An owner-approved plan: its outbox entry exists before the `Plan:` document is written.
  ownerApproval(input: { issueId: string; identifier: string; plan: string; approvedAt: string }): Promise<void> {
    return this.serial(async () => {
      const entry: OwnerApproval = { issueId: input.issueId, identifier: input.identifier, planHash: planHash(input.plan), footprint: planFootprint(input.plan, input.identifier), approvedAt: input.approvedAt };
      await this.outbox.update((entries) => { entries[`${entry.issueId}:${entry.planHash}`] = entry; });
    });
  }

  // Report every pending owner approval; the coordinator acknowledges by accepting the report.
  flushOwnerApprovals(): Promise<void> {
    return this.serial(() => this.flushOnce());
  }

  // Reconciliation, at start and on every sweep: `claiming` resends the same id until answered;
  // `granted` commits once its decision's document was written, withdraws and is judged again when
  // the review still waits, and becomes `unclear` (with one owner item) when neither can be told.
  reconcile(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.reconciling || now - this.lastReconcile < RECONCILE_MS) return this.reconciling ?? Promise.resolve();
    this.lastReconcile = now;
    this.reconciling = this.serial(async () => {
      for (const record of await this.all()) {
        try {
          await this.reconcileOne(record, now);
        } catch (error) {
          console.error(`[linear-tickets] reconciling the automatic approval of ${record.identifier} failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      await this.flushOnce();
    }).catch((error: unknown) => {
      console.error(`[linear-tickets] reconciling automatic approvals failed: ${error instanceof Error ? error.message : error}`);
    }).finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  // Every host answers for its own records (the coordinator's holder route).
  async holder(claimId: string): Promise<HolderAnswer | null> {
    for (const record of await this.all()) if (record.claimId === claimId) return { claim: record.state, planHash: record.planHash };
    return { claim: "none" };
  }

  private async reconcileOne(record: ClaimIntent, now: number): Promise<void> {
    const created = claimIdTime(record.claimId);
    // `unclear` never acts again, but an owner item whose comment did not get through is retried.
    if (record.state === "unclear") { if (!record.item) await this.unconfirmedItem(record); return; }
    if (record.state === "claiming") {
      // A requester stops resending after 30 days: the claim can never be granted by then. The
      // record stays as `unclear` so it answers the holder and blocks a new claim for the ticket.
      if (created === null || now - created > EXPIRED_DAYS * DAY_MS) {
        await this.unconfirmedItem(record);
        return;
      }
      const answer = await this.sendClaim(record);
      if (!answer || answer.state === "unreachable") return;
      if (answer.state === "granted") { await this.write({ ...record, state: "granted" }); return; }
      await this.remove(record.issueId);
      return;
    }
    if (record.state !== "granted") return;
    const state = await this.deps.state(record);
    if (state === "applied") {
      await this.settleOnce(record.claimId, "committed");
      await this.remove(record.issueId);
      return;
    }
    if (state === "pending") return;
    // The review is gone with nothing recorded: the claim is neither committed nor withdrawn. Its
    // record becomes `unclear` (the holder's own answer that it can no longer act), which is what
    // releases the coordinator's claim once the owner answers the item.
    if (state === "gone") { await this.unconfirmedItem(record); return; }
    await this.withdrawOnce(record);
    if (state === "open" && !record.parked) await this.deps.rejudge(record).catch((error: unknown) => {
      console.error(`[linear-tickets] judging ${record.identifier}'s plan again failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  private async withdrawOnce(record: ClaimIntent): Promise<void> {
    await this.settleOnce(record.claimId, "withdrawn");
    await this.remove(record.issueId);
  }

  // One owner item for an approval nobody can confirm; it never decides anything itself. The record
  // becomes `unclear` (written first, so the holder answers `unclear` even if the comment fails)
  // and no `decide` is ever called for it.
  private async unconfirmedItem(record: ClaimIntent): Promise<void> {
    await this.write({ ...record, state: "unclear" });
    const body = [
      `⚠️ **The automatic approval of ${record.identifier} could not be confirmed.** No decision was recorded for its review, and Paseo can no longer tell whether the plan was approved.`,
      "Nothing will be approved automatically for it. Decide the plan by hand, or write a new plan.",
    ].join("\n\n");
    await this.deps.linear.comment(record.issueId, body, uuidFrom(`approval-unclear:${record.claimId}`));
    await this.write({ ...record, state: "unclear", item: true });
  }

  private settleOnce(claimId: string, state: "committed" | "withdrawn"): Promise<{ state: ClaimState | "unknown" }> {
    return (async () => {
      const coordinator = await this.coordinator();
      if (!coordinator) return { state: "unknown" as const };
      try {
        if (coordinator.kind === "local") return await coordinator.claims.settle(claimId, state);
        const response = await fetch(`${coordinator.origin}/api/approval-claims/settle`, {
          method: "POST", signal: AbortSignal.timeout(PEER_TIMEOUT_MS * 2),
          headers: { "content-type": "application/json", "x-review-action": "1" },
          body: JSON.stringify({ claimId, state }),
        });
        if (!response.ok) return { state: "unknown" as const };
        const answer = z.object({ state: z.enum(["granted", "denied", "withdrawn", "committed", "expired", "unknown"]) }).safeParse(await response.json());
        return { state: answer.success ? answer.data.state : "unknown" as const };
      } catch { return { state: "unknown" as const }; }
    })();
  }

  // The coordinator's answer; `null` when nothing can have been granted (no coordinator, no origin,
  // a refused request or a local check that failed), `unreachable` when a sent request got no answer.
  private async sendClaim(record: ClaimIntent): Promise<ClaimAnswer | null> {
    const coordinator = await this.coordinator();
    if (!coordinator) return null;
    const request = { claimId: record.claimId, issueId: record.issueId, identifier: record.identifier, planHash: record.planHash, footprint: record.footprint, roundStartedAt: record.roundStartedAt };
    if (coordinator.kind === "local") return await coordinator.claims.claim({ ...request, origin: null }).catch(() => null);
    // The coordinator has to be able to ask this host back, so a host without a published origin
    // cannot claim: it falls back to the owner.
    const origin = await this.deps.origin().then((value) => value?.replace(/\/+$/, "") ?? null).catch(() => null);
    if (!origin) return null;
    let response: Response;
    try {
      response = await fetch(`${coordinator.origin}/api/approval-claims`, {
        method: "POST", signal: AbortSignal.timeout(PEER_TIMEOUT_MS * 2),
        headers: { "content-type": "application/json", "x-review-action": "1" },
        body: JSON.stringify({ ...request, origin }),
      });
    } catch { return { state: "unreachable" }; }
    if (!response.ok) return null;
    try {
      const answer = ClaimAnswerBody.safeParse(await response.json());
      return answer.success ? answer.data : { state: "unreachable" };
    } catch { return { state: "unreachable" }; }
  }

  // `refused` is a coordinator that will never take this report (400, 413): retrying cannot help, and
  // its approval still reaches every check through Linear's read of committed approvals.
  private async reportTo(origin: string, entry: OwnerApproval): Promise<"done" | "refused" | "retry"> {
    try {
      const response = await fetch(`${origin}/api/approval-claims/record`, {
        method: "POST", signal: AbortSignal.timeout(PEER_TIMEOUT_MS * 2),
        headers: { "content-type": "application/json", "x-review-action": "1" },
        body: JSON.stringify(entry),
      });
      return response.ok ? "done" : response.status === 400 || response.status === 413 ? "refused" : "retry";
    } catch { return "retry"; }
  }

  private async flushOnce(): Promise<void> {
    const entries = await this.outbox.load();
    if (!Object.keys(entries).length) return;
    const coordinator = await this.coordinator();
    if (!coordinator) return;
    for (const [key, entry] of Object.entries(entries)) {
      const outcome = coordinator.kind === "local"
        ? await coordinator.claims.record(entry).then(() => "done" as const, () => "retry" as const)
        : await this.reportTo(coordinator.origin, entry);
      if (outcome === "refused") console.error(`[linear-tickets] the approval coordinator refused the owner approval of ${entry.identifier}; only Linear's read of approved plans reports it now`);
      if (outcome !== "retry") await this.outbox.update((current) => { delete current[key]; });
    }
  }

  // This host's coordinator when it dispatches, else exactly one peer answering `dispatch: true`.
  private async coordinator(): Promise<{ kind: "local"; claims: ApprovalClaims } | { kind: "peer"; origin: string } | null> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.coordinatorCache && now - this.coordinatorCache.at < COORDINATOR_TTL_MS) return this.coordinatorCache.value;
    let value: { kind: "local"; claims: ApprovalClaims } | { kind: "peer"; origin: string } | null = null;
    const local = await this.deps.local().catch(() => null);
    if (local) value = { kind: "local", claims: local };
    else {
      const peers = await this.deps.peers().catch(() => [] as string[]);
      const enabled: string[] = [];
      await Promise.all(peers.map(async (peer) => {
        if (await dispatches(peer)) enabled.push(peer.replace(/\/+$/, ""));
      }));
      // None or several: no automatic approval (fail closed).
      if (enabled.length === 1) value = { kind: "peer", origin: enabled[0] };
    }
    this.coordinatorCache = { at: now, value };
    return value;
  }

  private async read(issueId: string): Promise<ClaimIntent | null> {
    return parseIntent(await readFile(this.pathOf(issueId), "utf8").catch(() => null));
  }

  private pathOf(issueId: string): string {
    return join(this.directory, `${issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
  }

  // The record is replaced whole on every change (tmp file, then rename), so a crash leaves the
  // previous state rather than half of the new one.
  private async write(record: ClaimIntent): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathOf(record.issueId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  private async remove(issueId: string): Promise<void> {
    await rm(this.pathOf(issueId), { force: true });
  }

  private async all(): Promise<ClaimIntent[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const records: ClaimIntent[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || ["granted.json", "answers.json", "ledger.json", "unconfirmed.json", "outbox.json"].includes(name)) continue;
      const record = parseIntent(await readFile(join(this.directory, name), "utf8").catch(() => null));
      if (record) records.push(record);
    }
    return records;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// One intent record's file text, or null when it is absent or not a claim (a crashed or older
// writer must not wedge reconciliation).
function parseIntent(raw: string | null): ClaimIntent | null {
  if (!raw) return null;
  const entry = (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })();
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  const state = value.state === "claiming" || value.state === "granted" || value.state === "unclear" ? value.state : null;
  const footprint = footprintOf(value.footprint);
  const claimId = text(value.claimId), issueId = text(value.issueId), name = text(value.identifier);
  const plan = text(value.planHash), since = text(value.roundStartedAt), agentId = text(value.agentId);
  const localUrl = text(value.localUrl), reviewId = text(value.reviewId), at = text(value.at);
  if (!state || !footprint || !claimId || !issueId || !name || !plan || !since || !agentId || !localUrl || !reviewId || !at) return null;
  return { claimId, issueId, identifier: name, planHash: plan, footprint, roundStartedAt: since, agentId, localUrl, reviewId, ...(value.parked === true ? { parked: true } : {}), ...(value.item === true ? { item: true } : {}), state, at };
}

// Whether a peer's inbox says it is the approval coordinator (absent or unreadable: not one).
async function dispatches(peer: string): Promise<boolean> {
  try {
    const response = await fetch(`${peer.replace(/\/+$/, "")}/api/inbox`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
    if (!response.ok) return false;
    const answer = DispatchBody.safeParse(await response.json());
    return answer.success && answer.data.dispatch?.enabled === true;
  } catch { return false; }
}