import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserOwnerAsk, DecisionView, LiveDecision } from "../shared/decision-inbox";
import { decisionBucket, summarizeDecisions } from "../shared/decision-summary";
import { curateDecisions } from "./decision-curation";

const NOW = Date.parse("2026-10-21T15:00:00Z");
const ask: BrowserOwnerAsk = {
  issueId: "issue1", sourceId: "comment1", revision: "r1", identifier: "TUC-1", title: "Choose rollout",
  url: "https://linear.app/test/issue/TUC-1", parentIdentifier: null, ticketIdentifier: "TUC-1",
  attention: "owner", attentionReason: "Owner chooses rollout", blockerIdentifier: null,
  disposition: null, deferredUntil: null, kind: "decision", summary: "Choose rollout",
  questions: [{ key: "q1", question: "Stage or wait?", multiSelect: false, options: [{ label: "Stage", description: "Staging only" }, { label: "Wait", description: "Do not deploy" }] }],
  source: "Stage or wait?", route: "agent", agentId: "agent1", mirrorsLiveRequest: false, extracted: true,
  updatedAt: new Date(NOW).toISOString(),
};
const live: LiveDecision = {
  agentId: "agent1", requestId: "request1", revision: "live-r1", title: "Choose rollout", identifier: "TUC-1",
  issueUrl: ask.url, agentUrl: null, source: ask.source, kind: "question", actions: [], deferredUntil: null,
  questions: ask.questions.map(question => ({ ...question, allowEmpty: false })),
};
function view(asks: BrowserOwnerAsk[] = [ask], requests: LiveDecision[] = []): DecisionView {
  return { hosts: [{ host: "canonical", asks, live: requests, history: [], updatedAt: new Date(NOW).toISOString(), error: null, flow: null }], canonicalHost: "canonical", unreachable: [] };
}

test("105 personal actions and 50 choices are not 155 decisions; original sources remain available", () => {
  const input = view([
    ...Array.from({ length: 105 }, (_, i) => ({ ...ask, issueId: `manual${i}`, kind: "manual" as const, source: `Upload receipt ${i}` })),
    ...Array.from({ length: 50 }, (_, i) => ({ ...ask, issueId: `decision${i}` })),
  ]);
  const original = structuredClone(input);
  assert.deepEqual(summarizeDecisions(input, NOW), { decisions: 50, actions: 105, unverified: 0, coverageComplete: true, complete: true, checkedAt: new Date(NOW).toISOString(), reasons: [] });
  assert.deepEqual(input, original, "counting must not merge operations, revisions or drafts");
});

test("source echoes already admitted as nonurgent stay out; independent source identities remain separate", () => {
  const echo = { ...ask, sourceId: "description", revision: "echo-r1", attention: "info" as const };
  assert.equal(summarizeDecisions(view([ask, echo]), NOW).decisions, 1);
  assert.equal(summarizeDecisions(view([ask, { ...echo, attention: "owner" }]), NOW).decisions, 2);
  const independent = { ...ask, sourceId: "other-agent-comment", source: "Another agent independently asks the same question." };
  assert.equal(summarizeDecisions(view([ask, independent]), NOW).decisions, 2, "routing agent is not source authorship");
  const changedOption = { ...independent, questions: [{ ...ask.questions[0], options: [{ label: "Stage", description: "Production included" }] }] };
  const changedQuestion = { ...independent, questions: [{ ...ask.questions[0], question: "Who operates the deployment?" }] };
  const changedMode = { ...independent, questions: [{ ...ask.questions[0], multiSelect: true }] };
  for (const other of [changedOption, changedQuestion, changedMode, { ...independent, issueId: "issue2" }, { ...independent, agentId: "agent2" }]) {
    assert.equal(summarizeDecisions(view([ask, other]), NOW).decisions, 2);
  }
});

test("only an explicit exact live mirror shares a round; repeated independent requests never do", () => {
  const mirror = { ...ask, agentId: live.agentId, mirrorsLiveRequest: true };
  assert.equal(summarizeDecisions(view([mirror], [live]), NOW).decisions, 1);
  assert.equal(summarizeDecisions(view([{ ...mirror, mirrorsLiveRequest: false }], [live]), NOW).decisions, 2);
  const changed = summarizeDecisions(view([mirror], [{ ...live, questions: [{ ...live.questions[0], allowEmpty: true }] }]), NOW);
  assert.equal(changed.decisions, 1);
  assert.equal(changed.unverified, 1, "mismatched mirror must not resurrect an old question");
  assert.equal(summarizeDecisions(view([], [live, { ...live, requestId: "request2" }, { ...live, agentId: "agent2" }]), NOW).decisions, 3);
  const permission = { ...live, kind: "permission" as const, questions: [], actions: [{ id: "allow", label: "Allow once", behavior: "allow" as const }] };
  assert.equal(summarizeDecisions(view([], [permission]), NOW).decisions, 1);
  const nextRound = { ...live, requestId: "request2", questions: [{ ...live.questions[0], question: "Which staging window?" }] };
  const afterAnswer = summarizeDecisions(view([mirror], [nextRound]), NOW);
  assert.equal(afterAnswer.decisions, 1);
  assert.equal(afterAnswer.unverified, 1);
  assert.equal(afterAnswer.coverageComplete, true, "verified questions remain usable while a separate source needs review");
  assert.equal(afterAnswer.complete, false, "Q2 is not evidence that stale Q1 remains unanswered");
});

test("confirmed exact revision is excluded without suppressing a new round or another source", () => {
  const next = { ...ask, revision: "r2", questions: [{ ...ask.questions[0], question: "Which staging window?" }] };
  const input = view([ask, next]);
  input.hosts[0].history.push({ id: "answer1", issueId: ask.issueId, identifier: ask.identifier, revision: ask.revision, action: "answer", text: "Stage", at: new Date(NOW).toISOString(), delivery: "comment" });
  assert.equal(summarizeDecisions(input, NOW).decisions, 1);
  input.tasks = curateDecisions(input, NOW);
  assert.equal(summarizeDecisions(input, NOW).decisions, 1);
  assert.equal(input.hosts[0].asks.length, 2);
});

test("cold, missing, stale, failed and unknown-delivery reads cannot claim an exact empty or current count", () => {
  assert.equal(summarizeDecisions({ hosts: [], canonicalHost: null, unreachable: [] }, NOW).complete, false);
  for (const change of [
    (input: DecisionView) => { input.canonicalHost = null; },
    (input: DecisionView) => { input.unreachable.push("server087"); },
    (input: DecisionView) => { input.hosts[0].updatedAt = new Date(NOW - 930_001).toISOString(); },
    (input: DecisionView) => { input.hosts[0].updatedAt = new Date(NOW + 30_001).toISOString(); },
    (input: DecisionView) => { input.hosts[0].error = "Linear collection incomplete"; },
    (input: DecisionView) => { input.hosts[0].asks[0] = { ...ask, deliveryUnknown: true }; },
    (input: DecisionView) => { input.hosts[0].asks[0] = { ...ask, extracted: false }; },
  ]) {
    const input = view(); change(input);
    const summary = summarizeDecisions(input, NOW);
    assert.equal(summary.complete, false);
    assert.ok(summary.reasons.length > 0);
  }
  assert.deepEqual(summarizeDecisions(view([], []), NOW), { decisions: 0, actions: 0, unverified: 0, coverageComplete: true, complete: true, checkedAt: new Date(NOW).toISOString(), reasons: [] });
});

test("nonurgent history does not poison the current badge; research and deferral are not decisions", () => {
  const input = view([
    { ...ask, sourceId: "historical", attention: "info", kind: "info", extracted: false },
    { ...ask, sourceId: "research", disposition: "research" },
    { ...ask, sourceId: "deferred", deferredUntil: new Date(NOW + 1).toISOString() },
  ]);
  input.hosts[0].sourceReviews = 14_554;
  assert.equal(summarizeDecisions(input, NOW).decisions, 0);
  assert.equal(summarizeDecisions(input, NOW).complete, true);
  assert.equal(summarizeDecisions(input, NOW + 1).decisions, 1);
  assert.equal(decisionBucket({ target: "owner", data: { ...ask, kind: "manual", extracted: false } }, NOW), "review");
});
