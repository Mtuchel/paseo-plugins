import assert from "node:assert/strict";
import test from "node:test";
import { blockerIdentifier, classifyAttention } from "./owner-ask-attention";
import { askContext, askTimeline, checkAssessment } from "./owner-ask-admission";
import type { ExtractedAsk } from "./owner-ask-extract";

const info: ExtractedAsk = { kind: "info", summary: "Waiting elsewhere.", questions: [] };

test("punctuation, old wait envelopes, manual extraction and uncertain history do not independently establish owner urgency", () => {
  for (const source of ["Why stop now? Checks continue.", "Plan ready; nothing needed from you yet.",
    "**TUC-1** (Paseo) is waiting for an answer: which old workflow?", "Unknown historical note.",
    "https://example.test/progress?state=complete", "Waiting for an advisor; approval may be needed later."]) {
    const context = askContext("description", askTimeline(source, []), null, false, false);
    for (const value of [null, info, { ...info, kind: "manual" as const }]) {
      const attention = classifyAttention(source, value, context);
      assert.equal(attention.attention, "info");
      assert.match(attention.attentionReason, /nonurgent.*review/);
    }
  }
});

test("an exact known live owner request stays fail-open even when extraction cannot classify it", () => {
  const source = "Which contract quantity is correct?";
  const context = askContext("description", askTimeline(source, []), "description", true, true);
  assert.equal(classifyAttention(source, null, context).attention, "owner");
  assert.equal(classifyAttention(source, info, context).attention, "owner");
});

test("a checked current business request survives other waits without transferring its answer", () => {
  const source = "Blocked by TUC-1275. Owner decision still required: which package quantity is contracted?";
  const context = askContext("description", askTimeline(source, []), null, false, false);
  const assessment = checkAssessment({ state: "owner", ownerBoundary: "business", reason: "Contract quantity remains an unanswered business fact.",
    evidence: [{ sourceId: "description", quote: source }] }, context)!;
  const result = classifyAttention(source, { ...info, assessment }, context);
  assert.equal(result.attention, "owner");
  assert.equal(result.blockerIdentifier, "TUC-1275");
  assert.match(result.attentionReason, /description/);
});

test("blocker grouping requires explicit positive dependency evidence, not mentions or advice", () => {
  assert.equal(blockerIdentifier("See TUC-1275 for prior discussion; implement TUC-1926."), null);
  assert.equal(blockerIdentifier("Recommended: read TUC-1275."), null);
  assert.equal(blockerIdentifier("Not blocked by TUC-1275 anymore."), null);
  assert.equal(blockerIdentifier("No longer blocked on TUC-1275."), null);
  assert.equal(blockerIdentifier("Blocked by [TUC-1275](https://linear.app/issue/TUC-1275). Also see TUC-1926."), "TUC-1275");
  assert.equal(blockerIdentifier("Depends on ticket TUC-1275."), "TUC-1275");
  assert.equal(blockerIdentifier("Blocked by TUC-1275. Blocked by TUC-1926."), null);
  assert.equal(blockerIdentifier("If TUC-2070 blocks TUC-1435, ask the owner."), null);
  for (const [source, expected] of [
    ["TUC-1275's migration failed, so P3009 blocks all later migrations. How should this go?", "TUC-1275"],
    ["Main already sits exactly at the cap (TUC-2070, which also blocks TUC-1435). How should I unblock it?", "TUC-2070"],
    ["The same blocks TUC-1435 (filed as TUC-2070). How should I proceed?", "TUC-2070"],
  ]) assert.equal(blockerIdentifier(source), expected);
});
