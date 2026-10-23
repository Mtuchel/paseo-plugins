import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planFootprint } from "../shared/plan-footprint";
import { ApprovalClaims, ClaimRequests, claimIdTime, newClaimId, type ClaimAnswer, type ClaimIntent, type ClaimRequest, type ClaimReviewState, type HolderAnswer, type OwnerApproval } from "./approval-claims";
import type { PlanDocument, TicketComment } from "./linear";
import { planDocument } from "./plannotator";
import { RelatedWork } from "./related-work";
import { planHash } from "./review-outcome";
import { ReviewLinks } from "./review-links";

// AC-18: one approval coordinator across hosts. Two requesters (separate state directories) claim
// through one coordinator; every rule below keeps an automatic approval from racing another.
const DAY = 86_400_000;
const START = "2026-10-15T10:41:10.500Z";
const X = "# Plan\n\n1. Change `server/x.ts`.\n";
const Y = "# Plan\n\n1. Change `server/y.ts`.\n";

type Ticket = { issueId: string; identifier: string; documents: Map<string, string>; comments: TicketComment[]; statusType: string };

async function withWorld(run: (world: World) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "paseo-approval-claims-"));
  try { await run(makeWorld(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

function makeWorld(root: string): World {
  let now = Date.parse("2026-10-15T12:00:00.000Z");
  const tickets = new Map<string, Ticket>();
  // The `Plan:` documents Linear lists as approved since a cutoff (related-work.ts `approvedSince`).
  const rows: PlanDocument[] = [];
  const reads: string[] = [];
  let sequence = 0;
  const linear = {
    async issueDocument(issueId: string, title: string) {
      const content = tickets.get(issueId)?.documents.get(title);
      return content === undefined ? null : { url: `https://linear.app/doc/${issueId}`, content };
    },
    async issueState(issueId: string) {
      const ticket = tickets.get(issueId);
      const statusType = ticket?.statusType ?? "started";
      return {
        id: issueId, identifier: ticket?.identifier ?? issueId, status: statusType === "completed" ? "Done" : "In Progress", statusId: statusType, statusType,
        teamId: null, projectId: null, creatorId: "owner", labels: [], attachmentUrls: [], blockedBy: [], priority: 0, createdAt: START, unblocks: 0,
      };
    },
    async comment(issueId: string, body: string, id?: string) {
      const ticket = tickets.get(issueId);
      if (!ticket) throw new Error(`no ticket ${issueId}`);
      const at = new Date(now).toISOString();
      ticket.comments.push({ id: id ?? `paseo-${++sequence}`, body, createdAt: at, updatedAt: at, url: `https://linear.app/comment/${sequence}`, authorId: "paseo-app" });
    },
    async issueCommentHistory(issueId: string) { return tickets.get(issueId)?.comments ?? []; },
    async viewerId() { return "owner"; },
    async planDocumentsSince(since: string) { reads.push(since); return rows; },
    async teamCandidates() { return { items: [], complete: true }; },
    async doneSince() { return { items: [], complete: true }; },
    async documentContents() { return new Map<string, { content: string; updatedAt: string }>(); },
  };
  const related = new RelatedWork({ linear: linear as never, pullRequests: { refresh: async () => undefined, filesOf: () => null, stateOf: () => null } });
  const clock = { now: () => now, tick: (ms: number) => { now += ms; } };
  let local: ApprovalClaims | null = null;
  const ticket = (identifier: string, options: { statusType?: string } = {}): Ticket => {
    const entry: Ticket = { issueId: `issue-${identifier}`, identifier, documents: new Map(), comments: [], statusType: options.statusType ?? "started" };
    tickets.set(entry.issueId, entry);
    return entry;
  };
  // The ticket's approved `Plan:` document: both the document the coordinator reads and the
  // approved-plan row a fresh Linear read lists.
  const approve = (entry: Ticket, plan: string, at = new Date(now).toISOString()) => {
    const content = planDocument({ type: "decided", agentId: "agent", approved: true, planContent: plan, at }, entry.identifier);
    entry.documents.set(`Plan: ${entry.identifier}`, content);
    rows.push({ id: `doc-${entry.identifier}-${++sequence}`, title: `Plan: ${entry.identifier}`, url: `https://linear.app/doc/${sequence}`, updatedAt: at, content, issue: { id: entry.issueId, identifier: entry.identifier, url: `https://linear.app/issue/${entry.identifier}`, project: "" } });
  };
  const ownerReply = (entry: Ticket, body: string) => {
    now += 1_000;
    entry.comments.push({ id: `owner-${++sequence}`, body, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), url: "", authorId: "owner" });
  };
  const claims = (options: { directory?: string; holder?: (claimId: string) => Promise<HolderAnswer | null> } = {}) =>
    new ApprovalClaims({ linear: linear as never, related, holder: options.holder, directory: options.directory ?? join(root, "coordinator"), now: clock.now });
  const requester = (options: {
    directory: string; peers?: string[]; origin?: string | null; local?: () => Promise<ApprovalClaims | null>;
    state?: (record: ClaimIntent) => Promise<ClaimReviewState>; rejudge?: () => Promise<void>;
  }) => new ClaimRequests({
    linear: linear as never,
    local: options.local ?? (async () => local),
    peers: async () => options.peers ?? [],
    origin: async () => options.origin ?? null,
    state: options.state ?? (async () => "open"),
    rejudge: options.rejudge ?? (async () => undefined),
    directory: options.directory,
    now: clock.now,
  });
  const request = (entry: Ticket, plan: string, claimId = newClaimId(now)): ClaimRequest => ({
    claimId, issueId: entry.issueId, identifier: entry.identifier, planHash: planHash(plan), footprint: planFootprint(plan, entry.identifier),
    roundStartedAt: START, origin: null,
  });
  const claim = (requests: ClaimRequests, entry: Ticket, plan: string, extra: Partial<Omit<ClaimIntent, "claimId" | "state" | "at">> = {}) => requests.claim({
    issueId: entry.issueId, identifier: entry.identifier, planHash: planHash(plan), footprint: planFootprint(plan, entry.identifier),
    roundStartedAt: START, agentId: `agent-${entry.identifier}`, localUrl: `http://localhost:4000/${entry.identifier}`, reviewId: `review-${entry.identifier}`, ...extra,
  });
  const file = async (directory: string, name: string): Promise<Record<string, unknown> | null> => {
    try { return JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, unknown>; } catch { return null; }
  };
  const write = async (directory: string, name: string, value: unknown) => { await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), JSON.stringify(value)); };
  const intent = async (directory: string, entry: Ticket, plan: string, overrides: Record<string, unknown>): Promise<string> => {
    const claimId = typeof overrides.claimId === "string" ? overrides.claimId : newClaimId(now);
    await write(directory, `issue-${entry.identifier}.json`, {
      ...request(entry, plan, claimId), agentId: `agent-${entry.identifier}`, localUrl: `http://localhost:4000/${entry.identifier}`,
      reviewId: `review-${entry.identifier}`, state: "claiming", at: new Date(now).toISOString(), ...overrides,
    });
    return claimId;
  };
  return { root, clock, ticket, approve, rows, reads, claims, requester, request, claim, file, write, intent, ownerReply, setLocal: (value: ApprovalClaims | null) => { local = value; } };
}

type World = {
  root: string;
  clock: { now(): number; tick(ms: number): void };
  ticket(identifier: string, options?: { statusType?: string }): Ticket;
  approve(entry: Ticket, plan: string, at?: string): void;
  rows: PlanDocument[];
  reads: string[];
  claims(options?: { directory?: string; holder?: (claimId: string) => Promise<HolderAnswer | null> }): ApprovalClaims;
  requester(options: { directory: string; peers?: string[]; origin?: string | null; local?: () => Promise<ApprovalClaims | null>; state?: (record: ClaimIntent) => Promise<ClaimReviewState>; rejudge?: () => Promise<void> }): ClaimRequests;
  request(entry: Ticket, plan: string, claimId?: string): ClaimRequest;
  claim(requests: ClaimRequests, entry: Ticket, plan: string, extra?: Partial<Omit<ClaimIntent, "claimId" | "state" | "at">>): Promise<ClaimAnswer>;
  file(directory: string, name: string): Promise<Record<string, unknown> | null>;
  write(directory: string, name: string, value: unknown): Promise<void>;
  intent(directory: string, entry: Ticket, plan: string, overrides: Record<string, unknown>): Promise<string>;
  ownerReply(entry: Ticket, body: string): void;
  setLocal(value: ApprovalClaims | null): void;
};

const claimIdOf = async (world: World, directory: string, ticket: Ticket): Promise<string> => String((await world.file(directory, `issue-${ticket.identifier}.json`))?.claimId);

test("AC-18: overlapping plans of two requesters get exactly one grant, in either order and after an hour", async () => {
  for (const order of ["first claims, second waits", "second claims, first waits"] as const) {
    await withWorld(async (world) => {
      const one = world.ticket("TUC-1"), five = world.ticket("TUC-5");
      const claims = world.claims();
      world.setLocal(claims);
      const first = world.requester({ directory: join(world.root, "first") });
      const second = world.requester({ directory: join(world.root, "second") });
      const [early, late] = order.startsWith("first") ? [one, five] : [five, one];
      const [earlyRequester, lateRequester] = order.startsWith("first") ? [first, second] : [second, first];
      assert.deepEqual(await world.claim(earlyRequester, early, X), { state: "granted" });
      // One pauses between its claim and its decision for longer than an hour: the claim does not
      // lapse and the owner gets one item, not one per sweep.
      world.clock.tick(61 * 60_000);
      await claims.sweep();
      await claims.sweep();
      const denied = await world.claim(lateRequester, late, X);
      assert.equal(denied.state, "denied", order);
      assert.equal(denied.other, early.identifier, order);
      assert.match(denied.reason ?? "", new RegExp(`${early.identifier}'s plan names the same files: server/x\\.ts`), order);
      assert.equal(early.comments.filter((comment) => comment.body.includes("could not be confirmed")).length, 1, order);
      // The answer was stored with the denial: settling the first claim does not turn a repeat of the
      // refused id into a grant.
      const earlyId = await claimIdOf(world, join(world.root, order.startsWith("first") ? "first" : "second"), early);
      const lateId = newClaimId(world.clock.now());
      const refused = await claims.claim(world.request(late, X, lateId));
      assert.equal(refused.state, "denied", order);
      await claims.settle(earlyId, "withdrawn");
      assert.deepEqual(await claims.claim(world.request(late, X, lateId)), refused, order);
    });
  }
});

test("AC-18: plans that share nothing are both granted, and the coordinator does its own Linear read", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), nine = world.ticket("TUC-9");
    const claims = world.claims();
    world.setLocal(claims);
    const first = world.requester({ directory: join(world.root, "first") });
    const second = world.requester({ directory: join(world.root, "second") });
    assert.equal((await world.claim(first, one, X)).state, "granted");
    assert.equal((await world.claim(second, nine, Y)).state, "granted");
    assert.ok(world.reads.length >= 2, "each claim asked Linear for committed approvals");
  });
});

test("AC-18: a plan naming more than a claim may goes to the owner in process as across hosts", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    world.setLocal(world.claims());
    const large = `# Plan\n\n${Array.from({ length: 301 }, (_, index) => `${index + 1}. Change \`server/module-${index}.ts\`.`).join("\n")}\n`;
    assert.equal((await world.claim(world.requester({ directory: join(world.root, "first") }), one, large)).state, "denied");
    assert.equal(await world.file(join(world.root, "first"), `${one.issueId}.json`), null, "nothing is held for it");
  });
});

test("AC-18: a grant is committed by its own approved document, never by an older one, and the ledger then blocks without Linear", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), five = world.ticket("TUC-5");
    let first: ClaimRequests | null = null;
    const claims = world.claims({ holder: async (claimId) => first ? first.holder(claimId) : { claim: "none" } });
    first = world.requester({ directory: join(world.root, "first") });
    world.setLocal(claims);
    assert.equal((await world.claim(first, one, X)).state, "granted");
    const claimId = await claimIdOf(world, join(world.root, "first"), one);
    const second = world.requester({ directory: join(world.root, "second") });
    // The ticket's plan document was approved long ago for another plan: it does not settle this claim.
    world.approve(one, Y, "2026-10-15T09:00:00.000Z");
    await claims.sweep();
    assert.equal(await claims.status(claimId), "granted");
    assert.equal((await world.claim(second, five, X)).state, "denied");
    // Now the document for this claim's own plan: committed into the ledger.
    world.approve(one, X);
    await claims.sweep();
    assert.equal(await claims.status(claimId), "committed");
    const ledger = await world.file(join(world.root, "coordinator"), "ledger.json");
    assert.deepEqual(Object.keys(ledger ?? {}), [`${one.issueId}:${planHash(X)}`]);
    // Linear no longer shows the document; the ledger alone still denies the overlapping plan.
    world.rows.length = 0;
    const denied = await world.claim(second, five, X);
    assert.equal(denied.state, "denied");
    assert.equal(denied.other, "TUC-1");
    assert.equal((await world.requester({ directory: join(world.root, "third") }).claim({ issueId: five.issueId, identifier: five.identifier, planHash: planHash(X), footprint: planFootprint(X, five.identifier), roundStartedAt: START, agentId: "agent", localUrl: "http://localhost:4000/5", reviewId: "review-5" })).state, "denied");
  });
});

test("AC-18: a crash between the ledger write and the claim removal leaves the approval on one side or the other, never neither", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), five = world.ticket("TUC-5");
    const claims = world.claims();
    const first = world.requester({ directory: join(world.root, "first") });
    world.setLocal(claims);
    assert.equal((await world.claim(first, one, X)).state, "granted");
    const claimId = await claimIdOf(world, join(world.root, "first"), one);
    await first.committed(one.issueId, X);
    const ledger = await world.file(join(world.root, "coordinator"), "ledger.json");
    assert.deepEqual(Object.keys(ledger ?? {}), [`${one.issueId}:${planHash(X)}`]);
    assert.deepEqual(await world.file(join(world.root, "coordinator"), "granted.json"), {}, "the claim left the table");
    const record = { claimId, issueId: one.issueId, identifier: one.identifier, planHash: planHash(X), footprint: planFootprint(X, one.identifier), roundStartedAt: START, origin: null, grantedAt: new Date(world.clock.now()).toISOString() };
    // A crash after the ledger write, before the claim's removal: a restart reads both copies.
    const both = join(world.root, "both");
    await world.write(both, "ledger.json", ledger);
    await world.write(both, "granted.json", { [claimId]: record });
    const restarted = world.claims({ directory: both });
    assert.equal(await restarted.status(claimId), "granted");
    assert.equal((await world.claim(world.requester({ directory: join(world.root, "second"), local: async () => restarted }), five, X)).state, "denied");
    // The requester's retried settle finishes the commit; the duplicate is tolerated.
    assert.deepEqual(await restarted.settle(claimId, "committed"), { state: "committed" });
    assert.deepEqual(Object.keys((await world.file(both, "ledger.json")) ?? {}), [`${one.issueId}:${planHash(X)}`]);
    assert.deepEqual(await world.file(both, "granted.json"), {}, "the finished commit removes the surviving grant");
    // The other side of the crash: only the claim survived, which keeps blocking too.
    const claimOnly = join(world.root, "claim-only");
    await world.write(claimOnly, "granted.json", { [claimId]: record });
    const survivor = world.claims({ directory: claimOnly });
    assert.equal(await survivor.status(claimId), "granted");
    assert.equal((await world.claim(world.requester({ directory: join(world.root, "third"), local: async () => survivor }), five, X)).state, "denied");
    assert.deepEqual(Object.keys((await world.file(claimOnly, "granted.json")) ?? {}), [claimId]);
  });
});

test("AC-18: an owner approval reported in denies overlapping plans before Linear shows it, and the outbox retries until acknowledged", async () => {
  await withWorld(async (world) => {
    const three = world.ticket("TUC-3"), five = world.ticket("TUC-5");
    const claims = world.claims();
    const owner = world.requester({ directory: join(world.root, "owner") });
    await owner.ownerApproval({ issueId: three.issueId, identifier: three.identifier, plan: X, approvedAt: new Date(world.clock.now()).toISOString() });
    assert.deepEqual(Object.keys((await world.file(join(world.root, "owner"), "outbox.json")) ?? {}), [`${three.issueId}:${planHash(X)}`]);
    // No coordinator yet: the report waits, and it is sent although no document was ever written.
    await owner.flushOwnerApprovals();
    assert.deepEqual(Object.keys((await world.file(join(world.root, "owner"), "outbox.json")) ?? {}), [`${three.issueId}:${planHash(X)}`]);
    world.setLocal(claims);
    world.clock.tick(61_000);
    await owner.flushOwnerApprovals();
    assert.deepEqual(await world.file(join(world.root, "owner"), "outbox.json"), {});
    const denied = await world.claim(world.requester({ directory: join(world.root, "second") }), five, X);
    assert.equal(denied.state, "denied");
    assert.equal(denied.other, "TUC-3");
    assert.match(denied.reason ?? "", /TUC-3's plan names the same files: server\/x\.ts/);
  });
});

test("AC-18: a ledger approval from before the planning round began does not deny, one from its start on does", async () => {
  await withWorld(async (world) => {
    const three = world.ticket("TUC-3"), four = world.ticket("TUC-4"), five = world.ticket("TUC-5"), six = world.ticket("TUC-6");
    const claims = world.claims();
    // TUC-3's plan was approved before TUC-5's round began and its ticket is still open, so the ledger
    // keeps it; the planner saw it in its candidate list.
    await claims.record({ issueId: three.issueId, identifier: three.identifier, planHash: planHash(X), footprint: planFootprint(X, three.identifier), approvedAt: "2026-10-15T10:41:10.499Z" });
    assert.equal((await claims.claim(world.request(five, X))).state, "granted");
    await claims.record({ issueId: four.issueId, identifier: four.identifier, planHash: planHash(Y), footprint: planFootprint(Y, four.identifier), approvedAt: START });
    const denied = await claims.claim(world.request(six, Y));
    assert.equal(denied.state, "denied");
    assert.equal(denied.other, "TUC-4");
  });
});

test("AC-18: a retried claim id gets its stored answer, and an id older than 30 days is expired, never granted", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const claims = world.claims();
    const id = newClaimId(world.clock.now());
    assert.equal(claimIdTime(id), world.clock.now());
    assert.equal(await claims.status(id), "unknown");
    assert.deepEqual(await claims.claim(world.request(one, X, id)), { state: "granted" });
    assert.deepEqual(await claims.claim(world.request(one, X, id)), { state: "granted" });
    assert.deepEqual(await claims.settle(id, "withdrawn"), { state: "withdrawn" });
    // A retry of a withdrawn claim is answered, never granted again.
    assert.deepEqual(await claims.claim(world.request(one, X, id)), { state: "withdrawn" });
    // After its terminal answer was dropped, the id's own age answers expired.
    world.clock.tick(61 * DAY);
    await claims.sweep();
    assert.equal(await claims.status(id), "expired");
    assert.deepEqual(await claims.claim(world.request(one, X, id)), { state: "expired" });
    const ancient = newClaimId(world.clock.now() - 31 * DAY);
    assert.deepEqual(await claims.claim(world.request(one, X, ancient)), { state: "expired" });
    assert.deepEqual(await world.file(join(world.root, "coordinator"), "granted.json"), {}, "nothing was ever granted");
  });
});

test("AC-18: a delayed duplicate request makes one grant and one answer", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const claims = world.claims();
    const id = newClaimId(world.clock.now());
    const [first, second] = await Promise.all([claims.claim(world.request(one, X, id)), claims.claim(world.request(one, X, id))]);
    assert.deepEqual(first, { state: "granted" });
    assert.deepEqual(second, { state: "granted" });
    assert.deepEqual(Object.keys((await world.file(join(world.root, "coordinator"), "granted.json")) ?? {}), [id]);
    assert.equal(await claims.status(id), "granted");
  });
});

test("AC-18: a paused requester keeps blocking, and only its own `unclear` releases the claim", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), five = world.ticket("TUC-5");
    let holder: ClaimRequests | null = null;
    const claims = world.claims({ holder: async (claimId) => holder ? holder.holder(claimId) : { claim: "none" } });
    let state: ClaimReviewState = "open";
    const first = world.requester({ directory: join(world.root, "first"), state: async () => state });
    holder = first;
    world.setLocal(claims);
    assert.equal((await world.claim(first, one, X)).state, "granted");
    const claimId = await claimIdOf(world, join(world.root, "first"), one);
    const second = world.requester({ directory: join(world.root, "second") });
    world.clock.tick(61 * 60_000);
    await claims.sweep();
    assert.equal((await world.claim(second, five, X)).state, "denied");
    // The owner answers the item while the record still holds the grant: it keeps blocking.
    world.ownerReply(one, "please check");
    await claims.sweep();
    assert.equal(await claims.status(claimId), "granted");
    assert.equal((await world.claim(second, five, X)).state, "denied");
    assert.ok(one.comments.some((comment) => comment.body.includes("still holds it (granted)")));
    // The review is gone with nothing recorded: the record answers `unclear`, which releases it.
    state = "gone";
    world.clock.tick(61_000);
    await first.reconcile();
    assert.equal((await world.file(join(world.root, "first"), "issue-TUC-1.json"))?.state, "unclear");
    assert.ok(one.comments.some((comment) => comment.body.includes("could not be confirmed")));
    await claims.sweep();
    assert.equal(await claims.status(claimId), "withdrawn");
    assert.equal((await world.claim(second, five, X)).state, "granted");
  });
});

test("AC-18: a ticket closed while its requester is paused releases nothing", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), five = world.ticket("TUC-5");
    let holder: ClaimRequests | null = null;
    const claims = world.claims({ holder: async (claimId) => holder ? holder.holder(claimId) : { claim: "none" } });
    holder = world.requester({ directory: join(world.root, "first") });
    world.setLocal(claims);
    assert.equal((await world.claim(holder, one, X)).state, "granted");
    const claimId = await claimIdOf(world, join(world.root, "first"), one);
    world.clock.tick(61 * 60_000);
    await claims.sweep();
    one.statusType = "completed";
    world.ownerReply(one, "ticket is done");
    await claims.sweep();
    assert.equal(await claims.status(claimId), "granted");
    assert.equal((await world.claim(world.requester({ directory: join(world.root, "second") }), five, X)).state, "denied");
  });
});

test("AC-18: a requester that crashed before saving its grant resends the same id, and a waiting review is withdrawn and judged again", { timeout: 20_000 }, async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const claims = world.claims();
    world.setLocal(claims);
    const claimId = newClaimId(world.clock.now());
    assert.equal((await claims.claim(world.request(one, X, claimId))).state, "granted");
    const directory = join(world.root, "first");
    await world.intent(directory, one, X, { claimId });
    // Judging again claims through the same requester, as the plugin's judge does.
    const again: string[] = [];
    const restarted: ClaimRequests = world.requester({ directory, state: async () => "open", rejudge: async () => { again.push((await world.claim(restarted, one, X)).state); } });
    await restarted.reconcile();
    assert.equal((await world.file(directory, "issue-TUC-1.json"))?.state, "granted", "the same id came back granted");
    assert.deepEqual(Object.keys((await world.file(join(world.root, "coordinator"), "granted.json")) ?? {}), [claimId], "no second grant");
    // The review still waits and there is no decision: the claim is withdrawn and the plan judged again.
    world.clock.tick(61_000);
    await restarted.reconcile();
    assert.deepEqual(again, ["granted"], "the judgement's own claim is answered, not queued behind the reconciliation");
    assert.equal(await claims.status(claimId), "withdrawn");
    assert.notEqual((await world.file(directory, "issue-TUC-1.json"))?.claimId, claimId, "the new judgement holds a new id");
  });
});

test("AC-18: a requester stops resending after 30 days and turns its claim into the owner item", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const directory = join(world.root, "first");
    await world.intent(directory, one, X, { claimId: newClaimId(world.clock.now() - 31 * DAY) });
    const requester = world.requester({ directory, peers: [] });
    await requester.reconcile();
    assert.equal((await world.file(directory, "issue-TUC-1.json"))?.state, "unclear");
    assert.equal(one.comments.filter((comment) => comment.body.includes("could not be confirmed")).length, 1);
    // A comment that did not get through is retried, once (a second reconcile with the marker set
    // posts nothing more).
    const record = await world.file(directory, "issue-TUC-1.json");
    await world.write(directory, "issue-TUC-1.json", { ...record, item: undefined });
    one.comments.length = 0;
    world.clock.tick(61_000);
    await requester.reconcile();
    world.clock.tick(61_000);
    await requester.reconcile();
    assert.equal(one.comments.filter((comment) => comment.body.includes("could not be confirmed")).length, 1);
    // An unclear record never claims again for its ticket.
    assert.equal((await world.claim(requester, one, X)).state, "denied");
  });
});

test("AC-18: a restart reads back its grants, ledger and terminal answers", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), five = world.ticket("TUC-5");
    const claims = world.claims();
    const first = world.requester({ directory: join(world.root, "first") });
    world.setLocal(claims);
    assert.equal((await world.claim(first, one, X)).state, "granted");
    const claimId = await claimIdOf(world, join(world.root, "first"), one);
    await first.committed(one.issueId, X);
    world.rows.length = 0;
    const restarted = world.claims();
    assert.equal(await restarted.status(claimId), "committed");
    assert.deepEqual(await world.file(join(world.root, "coordinator"), "granted.json"), {});
    assert.equal((await world.claim(world.requester({ directory: join(world.root, "second"), local: async () => restarted }), five, X)).state, "denied", "the restarted ledger alone denies it");
  });
});

// A peer host's `/api/inbox` (and, for the one coordinator, its claim route).
type PeerAnswer = { status: number; body: unknown } | "hang";
async function peer(respond: (path: string) => PeerAnswer): Promise<{ origin: string; close: () => void }> {
  const server = createServer((request, response) => {
    const answer = respond(request.url ?? "");
    if (answer === "hang") { response.on("error", () => {}); return; }
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk; });
    request.on("end", () => { response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("AC-18: no coordinator, two hosts answering dispatch, or no answer keep the plan with the owner", { timeout: 20_000 }, async () => {
  const dispatch = (path: string): PeerAnswer => path === "/api/inbox"
    ? { status: 200, body: { dispatch: { enabled: true } } }
    : { status: 200, body: { state: "granted" } };
  const one = await peer(dispatch);
  const two = await peer(dispatch);
  const hanging = await peer(() => "hang");
  const refused = await peer(() => ({ status: 503, body: {} }));
  try {
    await withWorld(async (world) => {
      const ticket = world.ticket("TUC-1");
      const none = world.requester({ directory: join(world.root, "none"), peers: [], local: async () => null });
      assert.deepEqual(await world.claim(none, ticket, X), { state: "unreachable" });
      const several = world.requester({ directory: join(world.root, "several"), peers: [one.origin, two.origin], local: async () => null });
      assert.deepEqual(await world.claim(several, ticket, X), { state: "unreachable" });
      const silent = world.requester({ directory: join(world.root, "silent"), peers: [refused.origin], local: async () => null });
      assert.deepEqual(await world.claim(silent, ticket, X), { state: "unreachable" });
      const slow = world.requester({ directory: join(world.root, "slow"), peers: [hanging.origin], local: async () => null });
      assert.deepEqual(await world.claim(slow, ticket, X), { state: "unreachable" });
    });
  } finally {
    one.close(); two.close(); hanging.close(); refused.close();
  }
});

test("AC-18: a claim granted after its requester stopped waiting is resent with the same id, not left blocking", { timeout: 20_000 }, async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const claims = world.claims();
    let hang = true;
    // The coordinator grants (its Linear read was slow) but the answer never reaches the requester.
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk; });
      request.on("end", () => {
        void (async () => {
          const json = (value: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
          if (request.url === "/api/inbox") return json({ dispatch: { enabled: true } });
          if (request.url === "/api/approval-claims/settle") {
            const { claimId, state } = JSON.parse(body) as { claimId: string; state: "committed" | "withdrawn" };
            return json(await claims.settle(claimId, state));
          }
          const answer = await claims.claim(JSON.parse(body) as ClaimRequest);
          if (hang) { response.on("error", () => {}); return; }
          json(answer);
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      let rejudged = 0;
      const directory = join(world.root, "remote");
      const remote = world.requester({ directory, local: async () => null, peers: [origin], origin: "http://127.0.0.1:49999", rejudge: async () => { rejudged += 1; } });
      assert.deepEqual(await world.claim(remote, one, X), { state: "unreachable" });
      const claimId = await claimIdOf(world, directory, one);
      assert.equal(await claims.status(claimId), "granted");
      hang = false;
      world.clock.tick(61_000);
      await remote.reconcile();
      assert.equal((await world.file(directory, `${one.issueId}.json`))?.state, "granted", "the resent id gets the stored grant");
      world.clock.tick(61_000);
      await remote.reconcile();
      assert.equal(await claims.status(claimId), "withdrawn", "the review still waits, so the grant is given back and the plan judged again");
      assert.equal(rejudged, 1);
    } finally { server.close(); }
  });
});

test("AC-18: a requester on another host claims through the real inbox route, which refuses a request without the custom header", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const claims = world.claims();
    const remote = world.requester({ directory: join(world.root, "remote"), local: async () => null, origin: "http://127.0.0.1:49999" });
    // What the request looks like on the wire: the intent record must exist, still `claiming`, so a
    // crash after the grant answers it with the same id instead of a second claim.
    let seen: { claimId: string; state: unknown; stored: unknown } | null = null;
    const watched = {
      claim: async (request: ClaimRequest) => {
        const record = await world.file(join(world.root, "finding"), `${one.issueId}.json`);
        seen = { claimId: request.claimId, state: record?.state, stored: record?.claimId };
        return claims.claim(request);
      },
      settle: (claimId: string, state: "committed" | "withdrawn") => claims.settle(claimId, state),
      record: (approval: OwnerApproval) => claims.record(approval),
      status: (claimId: string) => claims.status(claimId),
    };
    const links = new ReviewLinks({
      port: 0, proxyPort: 0, file: join(world.root, "reviews.json"), sweepMs: 3_600_000, alive: async () => false, origin: async () => null,
      claims: async () => watched, dispatch: async () => true, holder: (claimId) => remote.holder(claimId),
    });
    await links.start();
    try {
      const origin = `http://127.0.0.1:${links.listeningPort}`;
      const inbox = await (await fetch(`${origin}/api/inbox`)).json() as { dispatch?: { enabled?: boolean } };
      assert.deepEqual(inbox.dispatch, { enabled: true });
      const finding = world.requester({ directory: join(world.root, "finding"), local: async () => null, peers: [origin], origin: "http://127.0.0.1:49999" });
      assert.deepEqual(await world.claim(finding, one, X), { state: "granted" });
      const claimId = await claimIdOf(world, join(world.root, "finding"), one);
      assert.deepEqual(seen, { claimId, state: "claiming", stored: claimId }, "the record exists before the claim is sent");
      assert.equal((await world.file(join(world.root, "finding"), `${one.issueId}.json`))?.state, "granted", "the grant is saved before it is decided");
      assert.deepEqual(await (await fetch(`${origin}/api/approval-claims/${claimId}`)).json(), { state: "granted" });
      assert.deepEqual(await (await fetch(`${origin}/api/approval-claims/${claimId}/holder`)).json(), { claim: "none" }, "the route answers for this host's own records, which hold none");
      const refused = await fetch(`${origin}/api/approval-claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(world.request(one, X)) });
      assert.equal(refused.status, 403);
      assert.deepEqual(await (await fetch(`${origin}/api/approval-claims/${claimId}`)).json(), { state: "granted" });
    } finally { links.stop(); }
  });
});

test("AC-18: an owner approval naming more than a claim may is recorded whole through the real inbox route", async () => {
  await withWorld(async (world) => {
    const three = world.ticket("TUC-3"), five = world.ticket("TUC-5");
    const claims = world.claims();
    const links = new ReviewLinks({
      port: 0, proxyPort: 0, file: join(world.root, "reviews.json"), sweepMs: 3_600_000, alive: async () => false, origin: async () => null,
      claims: async () => claims, dispatch: async () => true, holder: async () => ({ claim: "none" }),
    });
    await links.start();
    try {
      const peers = [`http://127.0.0.1:${links.listeningPort}`];
      const large = `# Plan\n\n${Array.from({ length: 1_000 }, (_, index) => `${index + 1}. Change \`server/module-${index}.ts\`.`).join("\n")}\n`;
      const owner = world.requester({ directory: join(world.root, "owner"), local: async () => null, peers });
      await owner.ownerApproval({ issueId: three.issueId, identifier: three.identifier, plan: large, approvedAt: new Date(world.clock.now()).toISOString() });
      await owner.flushOwnerApprovals();
      assert.deepEqual(await world.file(join(world.root, "owner"), "outbox.json"), {}, "the coordinator acknowledged the report");
      const last = "# Plan\n\n1. Change `server/module-999.ts`.\n";
      const second = world.requester({ directory: join(world.root, "second"), local: async () => null, peers, origin: "http://127.0.0.1:49999" });
      assert.equal((await world.claim(second, five, last)).state, "denied", "the approval's last file still blocks an overlapping plan");
    } finally { links.stop(); }
  });
});

test("AC-18: stopping finishes the claim in progress, then admits no claim and reconciles nothing", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), two = world.ticket("TUC-2");
    const claims = world.claims();
    world.setLocal(claims);
    const coordinator = join(world.root, "coordinator"), first = join(world.root, "first");
    // The coordinator's own claim in progress is written before its stop returns.
    const direct = world.request(two, Y);
    const pending = claims.claim(direct);
    await claims.stop();
    assert.deepEqual(Object.keys((await world.file(coordinator, "granted.json")) ?? {}), [direct.claimId]);
    assert.equal((await pending).state, "granted");
    await assert.rejects(claims.claim(world.request(one, X)), "a stopped coordinator admits no claim");
    // The requester's likewise, against a coordinator still running.
    const running = world.claims({ directory: join(world.root, "running") });
    const requests = world.requester({ directory: first, local: async () => running });
    const claimed = world.claim(requests, one, X);
    await requests.stop();
    assert.equal((await world.file(first, "issue-TUC-1.json"))?.state, "granted");
    assert.equal((await claimed).state, "granted");
    await assert.rejects(world.claim(requests, two, Y), "a stopped requester admits no claim");
    // A record a stopped requester finds is left for the replacement plugin.
    const second = join(world.root, "second");
    await world.intent(second, two, Y, {});
    const later = world.requester({ directory: second, local: async () => running });
    await later.stop();
    await later.reconcile();
    assert.equal((await world.file(second, "issue-TUC-2.json"))?.state, "claiming");
  });
});

test("AC-18: a crash after an answer is stored and before its grant is removed answers the stored state, and the next sweep removes the grant", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), two = world.ticket("TUC-2");
    const coordinator = join(world.root, "coordinator");
    const claimId = newClaimId(world.clock.now());
    assert.equal((await world.claims().claim(world.request(one, X, claimId))).state, "granted");
    // The crash: the withdrawal's answer is stored, the grant not removed yet.
    await world.write(coordinator, "answers.json", { [claimId]: { state: "withdrawn", at: new Date(world.clock.now()).toISOString() } });
    const restarted = world.claims();
    assert.equal(await restarted.status(claimId), "withdrawn");
    assert.deepEqual(await restarted.settle(claimId, "committed"), { state: "withdrawn" }, "a late commit does not turn a withdrawal into an approval");
    assert.equal((await restarted.claim(world.request(two, X))).state, "denied", "the grant still blocks until the sweep");
    await restarted.sweep();
    assert.deepEqual(await world.file(coordinator, "granted.json"), {});
    assert.equal((await restarted.claim(world.request(two, X))).state, "granted");
  });
});

test("AC-18: an automatic approval settled after a later round began still blocks that round's overlapping plan", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1"), two = world.ticket("TUC-2");
    world.setLocal(world.claims());
    const first = world.requester({ directory: join(world.root, "first") });
    assert.equal((await world.claim(first, one, X)).state, "granted");
    world.clock.tick(10 * 60_000);
    const round = new Date(world.clock.now()).toISOString();
    world.clock.tick(60_000);
    await first.committed(one.issueId, X);
    const entries = Object.values((await world.file(join(world.root, "coordinator"), "ledger.json")) ?? {}) as { approvedAt: string }[];
    assert.deepEqual(entries.map((entry) => entry.approvedAt), [new Date(world.clock.now()).toISOString()], "approved when it was settled");
    const second = world.requester({ directory: join(world.root, "second") });
    assert.equal((await world.claim(second, two, X, { roundStartedAt: round })).state, "denied");
  });
});

test("AC-18: the same plan claimed again from a later review keeps its grant and follows that review", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const claims = world.claims();
    world.setLocal(claims);
    const directory = join(world.root, "first");
    // The first review is still open; the second one's judgement is the one using the grant.
    const states: Record<string, ClaimReviewState> = { "review-first": "open", "review-second": "pending" };
    const requests = world.requester({ directory, state: async (record) => states[record.reviewId] ?? "gone" });
    assert.equal((await world.claim(requests, one, X, { reviewId: "review-first" })).state, "granted");
    const claimId = (await world.file(directory, "issue-TUC-1.json"))?.claimId;
    assert.equal((await world.claim(requests, one, X, { reviewId: "review-second", localUrl: "http://localhost:4000/second" })).state, "granted");
    const record = await world.file(directory, "issue-TUC-1.json");
    assert.deepEqual([record?.claimId, record?.reviewId, record?.localUrl], [claimId, "review-second", "http://localhost:4000/second"]);
    world.clock.tick(61_000);
    await requests.reconcile();
    assert.equal(await claims.status(String(claimId)), "granted", "the first review still waiting does not withdraw the second one's grant");
  });
});

test("AC-18: a host that cannot read its claim records, or keeps none yet, gives no holder answer", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const directory = join(world.root, "first");
    const claimId = await world.intent(directory, one, X, { state: "granted" });
    const requests = world.requester({ directory });
    const path = join(directory, "issue-TUC-1.json");
    await chmod(path, 0o000);
    const links = new ReviewLinks({
      port: 0, proxyPort: 0, file: join(world.root, "reviews.json"), sweepMs: 3_600_000, alive: async () => false, origin: async () => null,
      claims: async () => null, dispatch: async () => false, holder: (id) => requests.holder(id),
    });
    const starting = new ReviewLinks({
      port: 0, proxyPort: 0, file: join(world.root, "reviews-starting.json"), sweepMs: 3_600_000, alive: async () => false, origin: async () => null,
      claims: async () => null, dispatch: async () => false, holder: async () => null,
    });
    await links.start();
    await starting.start();
    try {
      await assert.rejects(requests.holder(claimId), "an unreadable record is not `none`");
      assert.equal((await fetch(`http://127.0.0.1:${links.listeningPort}/api/approval-claims/${claimId}/holder`)).ok, false);
      assert.equal((await fetch(`http://127.0.0.1:${starting.listeningPort}/api/approval-claims/${claimId}/holder`)).ok, false, "no requester yet is no answer");
    } finally { links.stop(); starting.stop(); await chmod(path, 0o600); }
  });
});

test("AC-18: an automatic approval of a plan longer than its document keeps is still seen as committed", async () => {
  await withWorld(async (world) => {
    const one = world.ticket("TUC-1");
    const claims = world.claims();
    const long = `# Plan\n\n1. Change \`server/x.ts\`.\n\n${"Detail. ".repeat(30_000)}\n`;
    const claimId = newClaimId(world.clock.now());
    assert.equal((await claims.claim(world.request(one, long, claimId))).state, "granted");
    world.approve(one, long);
    await claims.sweep();
    assert.equal(await claims.status(claimId), "committed");
  });
});