import assert from "node:assert/strict";
import test from "node:test";
import { askContext, askTimeline, checkAssessment } from "./owner-ask-admission";

const question = "Owner decision still required: which package quantity is contracted?";
const comments = [
  { id: "ask", body: question, createdAt: "2026-10-01T10:00:00Z" },
  { id: "progress", body: "Implementation progress; another unrelated test passed.", createdAt: "2026-10-02T10:00:00Z" },
  { id: "answer", body: `Resolved ask: \"${question}\" Owner chose 50 packages.`, createdAt: "2026-10-03T10:00:00Z" },
];
const context = askContext("ask", askTimeline("", comments), null, false, false);
const owner = { state: "owner", ownerBoundary: "business", reason: "The source explicitly still requests the contracted quantity.", evidence: [{ sourceId: "ask", quote: question }] };

test("owner admission needs checked source evidence and a positive human boundary, not a model kind or a manual label", () => {
  assert.equal(checkAssessment(owner, context)?.state, "owner");
  assert.equal(checkAssessment({ ...owner, ownerBoundary: null }, context), null);
  assert.equal(checkAssessment({ ...owner, evidence: [{ sourceId: "missing", quote: question }] }, context), null);
  assert.equal(checkAssessment({ ...owner, evidence: [{ sourceId: "ask", quote: "Owner already approved 50 packages." }] }, context), null);
  assert.equal(checkAssessment(owner, { ...context, complete: false }), null);
});

test("a cited newer unrelated progress note cannot reconcile an independent question; a later exact answer can", () => {
  const resolved = { ...owner, state: "resolved", relatedSourceId: "progress", evidence: [...owner.evidence, { sourceId: "progress", quote: comments[1].body }] };
  assert.equal(checkAssessment(resolved, context), null);
  assert.equal(checkAssessment({ ...resolved, relatedSourceId: "answer", evidence: [...owner.evidence, { sourceId: "answer", quote: comments[2].body }] }, context)?.state, "resolved");
  const backwards = { ...context, timeline: context.timeline.map(source => source.sourceId === "answer" ? { ...source, createdAt: "2026-09-01T10:00:00Z" } : source) };
  assert.equal(checkAssessment({ ...resolved, relatedSourceId: "answer", evidence: [...owner.evidence, { sourceId: "answer", quote: comments[2].body }] }, backwards), null);
});

test("exact relay echoes share a stable canonical source but altered choices and independent questions do not", () => {
  const original = { id: "original", body: question, createdAt: "2026-10-01T10:00:00Z" };
  const echo = { id: "echo", body: `**TUC-1** (Paseo) is waiting for an answer:\n\n${question}\n\nReply here with “@paseo <your answer>”.`, createdAt: "2026-10-02T10:00:00Z" };
  const other = { id: "other", body: `${question}\nA. 50 packages\nB. 100 packages`, createdAt: "2026-10-02T11:00:00Z" };
  for (const order of [[original, echo, other], [other, echo, original]]) {
    const timeline = askTimeline("", order);
    assert.equal(askContext("echo", timeline, null, false, false).duplicateOf, "original");
    assert.equal(askContext("other", timeline, null, false, false).duplicateOf, null);
    assert.equal(askContext("echo", timeline, "echo", true, true).duplicateOf, null);
    assert.equal(askContext("original", timeline, "echo", false, false).duplicateOf, "echo");
  }
});

test("edited questions and changed wait ownership cannot inherit a previous echo classification", () => {
  const timeline = askTimeline("", [
    { id: "original", body: question, createdAt: "2026-10-01T10:00:00Z" },
    { id: "echo", body: question, createdAt: "2026-10-02T10:00:00Z" },
  ]);
  const original = timeline.find(source => source.sourceId === "original")!;
  const echo = timeline.find(source => source.sourceId === "echo")!;
  assert.equal(askContext("echo", timeline, null, false, false).duplicateOf, "original");
  echo.text = `${question}\nDoes the contract include delivery?`;
  assert.equal(askContext("echo", timeline, null, false, false).duplicateOf, null);
  echo.text = question;
  assert.equal(askContext("echo", timeline, "echo", true, true).duplicateOf, null);
  assert.equal(askContext("original", timeline, "echo", false, false).duplicateOf, "echo");
  original.createdAt = "2026-10-03T10:00:00Z";
  assert.equal(askContext("original", timeline, null, false, false).duplicateOf, "echo");
});

test("capped timeline is explicitly incomplete and cannot silently promote historical owner urgency", () => {
  const timeline = askTimeline("", [...comments, { id: "huge", body: "x".repeat(40_000), createdAt: "2026-10-04T00:00:00Z" }]);
  const capped = askContext("ask", timeline, null, false, false);
  assert.equal(capped.complete, false);
  assert.equal(capped.timeline.find(source => source.sourceId === "ask")?.text, question);
  assert.equal(checkAssessment(owner, capped), null);
});
