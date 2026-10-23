import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { FocusNode } from "./linear";
import type { HandoverRecord } from "./handover";
import type { ParkedPlan } from "./parked";
import type { SessionLink } from "./sessions";
import { AgentDirectory } from "./agent-directory";
import { MergeStatus, type MergeStatusDeps } from "./merge-status";

function ticket(id: string, status = "In Progress", labels: string[] = []): FocusNode {
  return { id, identifier: `TUC-${id}`, title: `Queue blocker: failure ${id}`, url: `https://linear.app/test/issue/TUC-${id}`, status, statusType: "started", delegateId: null, labels, finished: false, agentLinked: false, children: [], blockers: [] };
}
function harness() {
  let now = Date.parse("2026-10-21T06:00:00Z");
  let tickets = [ticket("1")];
  let failure: string | null = null;
  let reads = 0;
  let beforeRead: (() => Promise<void>) | undefined;
  const agents: { id: string; status: string; labels: Record<string, string>; pendingPermissions: { id: string }[]; archivedAt?: string }[] = [];
  let pages: typeof agents[] | null = null;
  let malformed = false;
  const parked: ParkedPlan[] = [];
  const records: HandoverRecord[] = [];
  const sessions: SessionLink[] = [];
  const paseo = { agents: { list: async (input: { page: { cursor?: string } }) => {
    const index = Number(input.page.cursor ?? 0);
    return { entries: (pages ? pages[index] : agents).map(agent => ({ agent })), pageInfo: { hasMore: malformed || Boolean(pages && index + 1 < pages.length), nextCursor: malformed ? null : String(index + 1) } };
  } } } as unknown as PaseoApi;
  const agentDirectory = new AgentDirectory({ liveTtlMs: 0 });
  agentDirectory.attach(paseo);
  const deps: MergeStatusDeps = {
    linear: { focusQueueBlockers: async keys => { assert.deepEqual(keys, ["TUC"]); reads++; await beforeRead?.(); if (failure) throw new Error(failure); return tickets; } },
    teamKeys: async () => ["TUC"], paseo: () => paseo, agentDirectory,
    handover: { all: async () => records }, parked: { all: async () => parked }, sessions: { all: async () => sessions },
    waiting: () => [], agentUrl: async id => `https://app.paseo.sh/h/test/agent/${id}`, now: () => now,
  };
  return { service: new MergeStatus(deps), agents, parked, records, sessions,
    tickets: (value: FocusNode[]) => { tickets = value; }, fail: (value: string | null) => { failure = value; },
    advance: () => { now += 60_001; }, reads: () => reads, hold: (value: () => Promise<void>) => { beforeRead = value; },
    pages: (value: typeof agents[]) => { pages = value; }, malformed: () => { malformed = true; },
  };
}

test("approval and pending input outrank running labels and actual turns; only an implementer is working", async () => {
  const h = harness();
  h.tickets([ticket("1", "Plan review", ["paseo-running"]), ticket("2", "Plan approved"), ticket("3"), ticket("4", "In Progress", ["paseo-running"]), ticket("5"), ticket("6", "In Review"), ticket("7"), ticket("8", "Planning")]);
  h.agents.push(...["1", "2", "3", "5", "6", "8"].map(id => ({ id: `a${id}`, status: "running", labels: { "linear.issueId": id }, pendingPermissions: id === "3" ? [{ id: "permission" }] : [] })));
  h.agents.push({ id: "a7", status: "error", labels: { "linear.issueId": "7" }, pendingPermissions: [] });
  const status = await h.service.snapshot();
  assert.deepEqual(status.blockers.map(row => [row.identifier, row.phase]), [["TUC-1", "waiting-approval"], ["TUC-2", "queued"], ["TUC-3", "waiting-input"], ["TUC-4", "unknown"], ["TUC-5", "working"], ["TUC-6", "review"], ["TUC-7", "failed"], ["TUC-8", "unknown"]]);
  assert.match(status.blockers[0].nextAction, /Review/);
  assert.equal(status.blockers[4].agentUrl, "https://app.paseo.sh/h/test/agent/a5");
  assert.equal(status.blockers[3].agentId, null);
});

test("failed refresh retains the complete last successful blockers and timestamp; successful empty clears them", async () => {
  const h = harness();
  h.tickets([ticket("1"), ticket("2")]);
  const initial = await h.service.snapshot();
  h.advance(); h.fail("Linear rate limited");
  const failed = await h.service.snapshot();
  assert.equal(failed.checkedAt, initial.checkedAt);
  assert.deepEqual(failed.blockers, initial.blockers);
  assert.match(failed.error ?? "", /Linear rate limited/);
  h.advance(); h.fail(null); h.tickets([]);
  const empty = await h.service.snapshot();
  assert.deepEqual(empty.blockers, []);
  assert.equal(empty.error, null);
  assert.notEqual(empty.checkedAt, initial.checkedAt);
});

test("concurrent consumers share one collection and reads inside a minute reuse it", async () => {
  const h = harness();
  const gate = new EventEmitter();
  h.hold(async () => { await once(gate, "release"); });
  const pendingFeed = h.service.feed();
  assert.equal(pendingFeed.checkedAt, null);
  assert.match(pendingFeed.error ?? "", /being checked/);
  const first = h.service.snapshot();
  const second = h.service.snapshot();
  await setImmediate();
  gate.emit("release");
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.service.feed(), a);
  await h.service.snapshot();
  assert.equal(h.reads(), 1);
});

test("agent pagination finds a late implementer and refuses an incomplete refresh without losing prior evidence", async () => {
  const h = harness();
  h.pages([[], [{ id: "late", status: "running", labels: { "linear.issueId": "1" }, pendingPermissions: [] }]]);
  const initial = await h.service.snapshot();
  assert.equal(initial.blockers[0].phase, "working");
  assert.equal(initial.blockers[0].agentId, "late");
  h.advance(); h.malformed();
  const failed = await h.service.snapshot();
  assert.deepEqual(failed.blockers, initial.blockers);
  assert.equal(failed.checkedAt, initial.checkedAt);
  assert.match(failed.error ?? "", /cursor/);
});

test("new Linear state and current implementation supersede stale parked and session approvals", async () => {
  const h = harness();
  h.tickets([ticket("1", "Plan review"), ticket("2", "Plan approved"), ticket("3")]);
  for (const id of ["1", "2", "3"]) {
    h.parked.push({ issueId: id, identifier: `TUC-${id}`, agentId: `planner${id}`, plan: "Repair plan", line: "Approve?", reasons: [], model: null, parkedAt: "2026-10-21T05:00:00Z", announced: true, staged: true });
    h.sessions.push({ issueId: id, identifier: `TUC-${id}`, agentId: `planner${id}`, sessionId: `s${id}`, createdAt: "2026-10-21T05:00:00Z", handled: [], review: null, offer: "parked" });
  }
  h.records.push({ issueId: "3", identifier: "TUC-3", agentId: "implementer", formerAgents: ["planner3"], agentTitle: "Repair", branch: null, worktreePath: null, lastCommit: null, summaries: [], links: {}, status: "working", progressCommentId: null, resumedFrom: null, updatedAt: "2026-10-21T06:00:00Z" });
  h.agents.push({ id: "planner3", status: "running", labels: { "linear.issueId": "3", "linear.plan": "required" }, pendingPermissions: [] },
    { id: "implementer", status: "running", labels: { "linear.issueId": "3" }, pendingPermissions: [] });
  const status = await h.service.snapshot();
  assert.deepEqual(status.blockers.map(row => row.phase), ["waiting-approval", "queued", "working"]);
  assert.equal(status.blockers[2].agentId, "implementer");
  assert.equal(status.blockers[2].title, "failure 3");
});
