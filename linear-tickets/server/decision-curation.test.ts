import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserOwnerAsk, DecisionView, LiveDecision } from "../shared/decision-inbox";
import { CURATION_INTERVAL_MS, curateDecisions, DecisionCuration, ownerSourceId } from "./decision-curation";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const ask: BrowserOwnerAsk = {
  issueId: "i1", sourceId: "comment-policy", revision: "policy-r1", identifier: "TUC-1", title: "Rollout policy?",
  url: "https://linear.app/test/issue/TUC-1", parentIdentifier: null, ticketIdentifier: "TUC-1",
  attention: "owner", attentionReason: "Source asks: Which rollout policy?", blockerIdentifier: null,
  disposition: null, deferredUntil: null, kind: "decision", summary: "Choose the rollout policy.",
  questions: [{ key: "q1", question: "Which rollout policy?", multiSelect: false,
    options: [{ label: "A. Stage first (Recommended)", description: "Slower, limits exposure." }, { label: "B. Wait", description: "No release today." }] }],
  source: "Which rollout policy?", route: "comment", agentId: null, mirrorsLiveRequest: false,
  extracted: true, updatedAt: new Date(NOW).toISOString(),
};
const live: LiveDecision = {
  agentId: "agent1", requestId: "request1", revision: "live-r1", title: "Approve plan?", identifier: "TUC-1",
  issueUrl: ask.url, agentUrl: null, source: "Original plan", kind: "permission", questions: [],
  actions: [{ id: "deny", label: "Reject this plan", behavior: "deny" }], deferredUntil: null,
};
function view(asks: BrowserOwnerAsk[] = [ask], requests: LiveDecision[] = []): DecisionView {
  return { hosts: [{ host: "canonical", asks, live: requests, history: [], updatedAt: new Date(NOW).toISOString(), error: null, flow: null }], canonicalHost: "canonical", unreachable: [] };
}

test("curation deduplicates exact sources without collapsing independent questions on the same ticket", () => {
  const recovery = { ...ask, sourceId: "comment-recovery", revision: "recovery-r1", title: "Recovery needs approval?" };
  const input = view([ask, ask, recovery], [live, live, { ...live, requestId: "request2" }]);
  const result = curateDecisions(input, NOW);
  assert.deepEqual(result.map(task => [task.target, task.id]), [
    ["owner", ownerSourceId(ask)], ["owner", ownerSourceId(recovery)],
    ["live", JSON.stringify(["agent1", "request1"])], ["live", JSON.stringify(["agent1", "request2"])],
  ]);
});

test("confirmed receipts hide only their revision; unknown delivery and sibling sources remain visible", () => {
  const recovery = { ...ask, sourceId: "recovery", revision: "recovery-r1", deliveryUnknown: true };
  const input = view([ask, recovery]);
  input.hosts[0].history = [
    { id: "answer1", issueId: ask.issueId, identifier: ask.identifier, revision: ask.revision, action: "answer", text: "A", at: new Date(NOW).toISOString(), delivery: "comment" },
    { id: "answer2", issueId: ask.issueId, identifier: ask.identifier, revision: recovery.revision, action: "answer", text: "B", at: new Date(NOW).toISOString(), delivery: "unconfirmed" },
  ];
  assert.deepEqual(curateDecisions(input, NOW).map(task => [task.id, task.priority]), [[ownerSourceId(recovery), "review"]]);
});

test("genuine owner tasks precede uncertain extraction and delegated work; deferral expires without authorization", () => {
  const waiting = { ...ask, sourceId: "waiting", disposition: "delegated" as const };
  const uncertain = { ...ask, sourceId: "pending", extracted: false, attention: "info" as const };
  const deferred = { ...ask, sourceId: "deferred", disposition: "deferred" as const, deferredUntil: new Date(NOW + 1).toISOString() };
  const input = view([waiting, uncertain, deferred, ask]);
  assert.deepEqual(curateDecisions(input, NOW).map(task => task.priority), ["owner", "review", "waiting", "waiting"]);
  assert.deepEqual(curateDecisions(input, NOW + 1).filter(task => task.priority === "owner").map(task => task.id), [ownerSourceId(deferred), ownerSourceId(ask)]);
});

test("recovery flow is evidence, not a synthetic owner ask or a claim of advancement", () => {
  const input = view();
  const queued = { identifier: "TUC-1", situation: "queued", since: new Date(NOW).toISOString(), reason: "Retired generation awaits replacement",
    nextAction: "Wait for dispatch", waitReason: "Capacity", nextCheckAt: new Date(NOW + 60_000).toISOString(),
    responsibleGeneration: "generation2", lastVerifiedAdvancementAt: null };
  input.hosts[0].flow = { at: new Date(NOW).toISOString(), counts: { queued: 1 }, oldest: [], error: null,
    tickets: [queued, { ...queued, identifier: "TUC-2" }], control: { passStartedAt: null, overduePassMs: 0, maxUnattendedMs: 60_000, recoveryOutcomes: { queued: 1 } } };
  const tasks = curateDecisions(input, NOW);
  assert.deepEqual(tasks.map(task => task.id), [ownerSourceId(ask)]);
  assert.deepEqual(tasks[0].flow, queued);
});

test("daemon collects immediately and every fifteen minutes without a browser, and stop removes the timer", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = NOW, reads = 0;
  const curator = new DecisionCuration(async () => { reads++; return view([{ ...ask, revision: `r${reads}` }]); }, () => now);
  t.after(() => curator.stop());
  await curator.start();
  await curator.start();
  assert.equal(reads, 1);
  let snapshot = await curator.view();
  assert.equal(snapshot.curation?.nextRefreshAt, new Date(NOW + CURATION_INTERVAL_MS).toISOString());
  now += CURATION_INTERVAL_MS;
  t.mock.timers.tick(CURATION_INTERVAL_MS);
  assert.equal(reads, 2, "timer collected without any page read");
  snapshot = await curator.view();
  assert.equal(snapshot.hosts[0].asks[0].revision, "r2");
  assert.equal(snapshot.curation?.lastRefreshAt, new Date(now).toISOString());
  curator.stop();
  now += CURATION_INTERVAL_MS;
  t.mock.timers.tick(CURATION_INTERVAL_MS);
  assert.equal(reads, 2);
});

test("single-flight collection discards a pre-answer snapshot invalidated while reading", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const curator = new DecisionCuration(async () => {
    reads++;
    if (reads === 1) { await gate; return view(); }
    return view([]);
  }, () => NOW);
  const first = curator.view(), second = curator.view();
  assert.equal(reads, 1);
  curator.invalidate();
  release();
  const results = await Promise.all([first, second]);
  assert.equal(reads, 2);
  assert.deepEqual(results.map(result => result.tasks), [[], []]);
});

test("failed collection retains previous tasks and exposes the failure and partial host coverage", async () => {
  let fail = false;
  const partial = view();
  partial.unreachable = ["server087"];
  const curator = new DecisionCuration(async () => { if (fail) throw new Error("peer discovery unavailable"); return partial; }, () => NOW);
  await curator.view();
  fail = true;
  await curator.refresh();
  const snapshot = await curator.view();
  assert.equal(snapshot.curation?.error, "peer discovery unavailable");
  assert.deepEqual(snapshot.unreachable, ["server087"]);
  assert.equal(snapshot.tasks?.[0].id, ownerSourceId(ask));
});

test("standalone agents without Linear identifiers remain owner tasks", () => {
  const standalone: LiveDecision = { ...live, identifier: null, issueUrl: null, kind: "question", actions: [],
    questions: [{ key: "q1", question: "Who does it?", multiSelect: false, allowEmpty: false,
      options: [{ label: "A. Agent does it", description: "Within the approved scope." }, { label: "B. Owner does it", description: "Manual work." }] }] };
  const input = view([], [standalone]);
  const tasks = curateDecisions(input, NOW);
  assert.deepEqual(tasks.map(task => [task.target, task.id, task.priority]), [["live", JSON.stringify([standalone.agentId, standalone.requestId]), "owner"]]);
});
