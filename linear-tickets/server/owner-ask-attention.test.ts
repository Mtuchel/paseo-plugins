import assert from "node:assert/strict";
import test from "node:test";
import { blockerIdentifier, classifyAttention } from "./owner-ask-attention";
import type { ExtractedAsk } from "./owner-ask-extract";

const info: ExtractedAsk = { kind: "info", summary: "Waiting elsewhere.", questions: [] };
const future = "The rating stays at impact 4, so it needs your approval.\n\nNext: once the advisor answers, I record its verdict and submit the plan to you.\n\nNothing is needed from you yet.";
const wrappers = [
  (text: string) => text,
  (text: string) => `**TUC-560: Plan** (Paseo) finished its turn and is waiting for you:\n\n${text}\n\nReply here with “@paseo <your answer>”.`,
  (text: string) => `**TUC-1926: Plan** (Paseo) is waiting for an answer:\n\n${text}`,
];

test("retrospective future approval/advisor snippets are waiting, including Paseo wait wrappers", () => {
  for (const wrap of wrappers) {
    assert.equal(classifyAttention(wrap(future), info, false).attention, "advisor");
    assert.equal(classifyAttention(wrap("Nothing is needed from you yet."), info, false).attention, "info");
    assert.equal(classifyAttention(wrap("Waiting for the advisor to review the plan."), info, false).attention, "advisor");
    assert.equal(classifyAttention(wrap(future), null, false).attention, "owner", "pending or failed extraction stays visible");
  }
});

test("real current owner requests coexist with advisor and no-input status without being hidden", () => {
  for (const wrap of wrappers) {
    for (const request of ["May I deploy the change to production now?", "Please approve production access now.", "Can you choose between the two implementations?", "The production setting needs your approval before I change it.", "The database deletion is irreversible and needs your approval.", "The production setting is ready. It needs your approval."]) {
      assert.equal(classifyAttention(wrap(`${future}\n\nSeparately: ${request}`), info, false).attention, "owner");
    }
  }
  assert.equal(classifyAttention("Waiting for the advisor.", info, true).attention, "owner", "manual labels remain authoritative");
  assert.equal(classifyAttention("Unclear progress note.", info, false).attention, "owner", "an info extraction is not sufficient to hide ambiguous work");
});

test("blocker grouping requires explicit positive dependency evidence, not mentions or advice", () => {
  assert.equal(blockerIdentifier("See TUC-1275 for prior discussion; implement TUC-1926."), null);
  assert.equal(blockerIdentifier("Recommended: read TUC-1275."), null);
  assert.equal(blockerIdentifier("Not blocked by TUC-1275 anymore."), null);
  assert.equal(blockerIdentifier("No longer blocked on TUC-1275."), null);
  assert.equal(blockerIdentifier("Blocked by [TUC-1275](https://linear.app/issue/TUC-1275). Also see TUC-1926."), "TUC-1275");
  assert.equal(blockerIdentifier("Depends on ticket TUC-1275."), "TUC-1275");
  assert.equal(blockerIdentifier("Blocked by TUC-1275. Blocked by TUC-1926."), null, "multiple independent blockers cannot be collapsed into an arbitrary one");
  assert.equal(classifyAttention("Blocked by TUC-1275.", info, false).attention, "dependency");
  const current = classifyAttention("Blocked by TUC-1275. May I proceed with the reversible prototype?", info, false);
  assert.equal(current.attention, "owner");
  assert.equal(current.blockerIdentifier, "TUC-1275", "group membership never shares an answer or conceals this ticket's question");
});

test("explicit causal blocker references group the live staging and bundle-cap questions without sharing approvals", () => {
  for (const [source, expected] of [
    ["TUC-1275's migration 20261203120003_document_upload_origin_goods_receipt_file failed ('current transaction is aborted': an earlier statement failed; the first error is not in the deploy log), so P3009 blocks all later migrations. How should this go?", "TUC-1275"],
    ["Main already sits exactly at the cap (TUC-2070, which also blocks TUC-1435 and TUC-1074). How should I unblock it?", "TUC-2070"],
    ["The same blocks TUC-1435 (filed as TUC-2070). How should I proceed?", "TUC-2070"],
  ]) {
    const result = classifyAttention(source, info, false);
    assert.equal(result.blockerIdentifier, expected);
    assert.equal(result.attention, "owner");
  }
  assert.equal(blockerIdentifier("TUC-1275's migration failed last week. See TUC-2070 for the new work."), null);
  assert.equal(blockerIdentifier("TUC-2070 no longer blocks TUC-1435."), null);
  assert.equal(blockerIdentifier("If TUC-2070 blocks TUC-1435, ask the owner."), null);
  assert.equal(blockerIdentifier("TUC-2070 blocks TUC-1435. Blocked by TUC-1275 too."), null);
});
