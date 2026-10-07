import assert from "node:assert/strict";
import test from "node:test";
import { PlanningSmoke, type SmokeRun } from "./planning-smoke";

test("the planning smoke check never runs twice at once, and stopping the plugin stops a running check", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  let calls = 0;
  let aborted = false;
  let finish: (run: SmokeRun) => void = () => {};
  const smoke = new PlanningSmoke({
    enabled: true,
    locate: () => "/checkout/linear-tickets/scripts/planning-smoke.mjs",
    run: (_script, signal) => {
      calls += 1;
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  const first = smoke.runOnce();
  const second = smoke.runOnce();
  assert.equal(calls, 1);
  finish({ code: 1, timedOut: false, stdout: "Planning smoke check on host: FAIL\n  FAIL framing: missing\n", stderr: "" });
  await Promise.all([first, second]);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /FAIL framing: missing/);

  const third = smoke.runOnce();
  assert.equal(calls, 2);
  smoke.stop();
  assert.equal(aborted, true);
  finish({ code: null, timedOut: false, stdout: "", stderr: "" });
  await third;
  // A run cut short by the plugin's own shutdown is not reported as a failure.
  assert.equal(errors.mock.callCount(), 1);
});

test("without the plan-first extension link the check is skipped and says so once", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  let calls = 0;
  const smoke = new PlanningSmoke({ enabled: true, locate: () => null, run: async () => { calls += 1; return { code: 0, timedOut: false, stdout: "", stderr: "" }; } });
  await smoke.runOnce();
  await smoke.runOnce();
  assert.equal(calls, 0);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /not linked/);
});
