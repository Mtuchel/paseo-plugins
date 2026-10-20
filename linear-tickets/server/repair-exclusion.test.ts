import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { ExclusionClosedError, RepairBusyError, RepairExclusion, withEffect } from "./repair-exclusion";

// The exclusion between the responsibility check's repair and every other effect on a ticket
// (repair-exclusion.ts): effects exclude repairs and repairs exclude effects, a repair never
// waits, and shutdown drains repairs before the journal changes hands.

test("an effect on an unknown ticket blocks every repair until it is bound, then only its own", () => {
  const exclusion = new RepairExclusion();
  const token = exclusion.enterEffect(null);
  assert.equal(exclusion.tryRepair("issue-1"), null, "an unknown ticket may be any ticket");
  token.bind("issue-1");
  assert.equal(exclusion.tryRepair("issue-1"), null, "the binding leaves no gap: the ticket stays held");
  const other = exclusion.tryRepair("issue-2");
  assert.ok(other, "another ticket is free once the token is bound");
  other.release();
  assert.throws(() => token.bind("issue-2"), /cannot be bound/, "a bound token keeps its ticket");
  token.release();
  token.release();
  const repair = exclusion.tryRepair("issue-1");
  assert.ok(repair, "released (twice, harmlessly): the ticket is free");
  repair.release();
});

test("a repair refuses effects on its ticket and unknown ones; a waiting admission enters once it ends", async () => {
  const exclusion = new RepairExclusion();
  const repair = exclusion.tryRepair("issue-1")!;
  assert.equal(exclusion.tryRepair("issue-1"), null, "one repair per ticket");
  assert.throws(() => exclusion.enterEffect("issue-1"), RepairBusyError);
  assert.throws(() => exclusion.enterEffect(null), RepairBusyError);
  exclusion.enterEffect("issue-2").release();
  let admitted = false;
  const waiting = exclusion.admit(null).then((token) => { admitted = true; return token; });
  await immediate();
  assert.equal(admitted, false, "it waits for the repair");
  repair.release();
  (await waiting).release();
  assert.equal(admitted, true);
});

test("a repair never waits: it is refused while an effect holds the ticket", async () => {
  const exclusion = new RepairExclusion();
  let release!: () => void;
  // Executor form: the plugin's TypeScript lib predates Promise.withResolvers.
  const held = new Promise<void>((resolve) => { release = resolve; });
  const effect = withEffect(exclusion, "issue-1", () => held);
  await immediate();
  assert.equal(exclusion.tryRepair("issue-1"), null);
  release();
  await effect;
  const repair = exclusion.tryRepair("issue-1");
  assert.ok(repair, "free once the effect ended");
  repair.release();
});

test("admission starts closed when asked to, and closing it refuses new and waiting effects", async () => {
  const exclusion = new RepairExclusion({ open: false });
  assert.throws(() => exclusion.enterEffect("issue-1"), ExclusionClosedError);
  await assert.rejects(exclusion.admit("issue-1"), ExclusionClosedError);
  assert.equal(exclusion.tryRepair("issue-1"), null);
  exclusion.open();
  const repair = exclusion.tryRepair("issue-1")!;
  const waiting = exclusion.admit("issue-1");
  exclusion.closeAdmission();
  await assert.rejects(waiting, ExclusionClosedError, "nothing waits on a closed exclusion");
  assert.ok(new ExclusionClosedError() instanceof RepairBusyError, "a closed exclusion is a transient refusal too");
  repair.release();
});

test("drain waits for every repair, and for effects only up to its bound", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const exclusion = new RepairExclusion();
  const repair = exclusion.tryRepair("issue-1")!;
  const effect = exclusion.enterEffect("issue-2");
  exclusion.closeAdmission();
  let drained = false;
  const draining = exclusion.drain(20).then(() => { drained = true; });
  await immediate();
  t.mock.timers.tick(40);
  await immediate();
  assert.equal(drained, false, "a repair is waited for past the effects' bound");
  repair.release();
  await draining;
  assert.equal(drained, true, "the stuck effect does not hold the shutdown");
  effect.release();
  await exclusion.drain(20);
});
