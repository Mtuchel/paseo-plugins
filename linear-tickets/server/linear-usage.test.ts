import assert from "node:assert/strict";
import { test } from "node:test";
import { asCaller, LinearUsage, linearUsage } from "./linear-usage";
import { postGraphQL } from "./linear";
import { RateBudget, RateLimitedError } from "./rate-budget";

const MINUTE = 60_000;
const metered = (points: string) => new Headers({ "x-complexity": points });

test("overlapping callers and nested work retain their own attribution across awaits", async () => {
  const usage = new LinearUsage(() => 0);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await Promise.all([
    asCaller("slow", async () => {
      await wait;
      usage.record("app", "query ticket { viewer { id } }", metered("498"));
      await asCaller("nested", async () => {
        await Promise.resolve();
        usage.record("app", "mutation update { viewer { id } }", metered("7"));
      });
      usage.record("app", "query ticket { viewer { id } }", metered("502"));
    }),
    asCaller("fast", async () => {
      await Promise.resolve();
      usage.record("key", "query ticket { viewer { id } }", metered("1004"));
      release();
    }),
  ]);
  assert.deepEqual(usage.snapshot().rows, [
    { pool: "key", caller: "fast", operation: "ticket", requests: 1, points: 1004, unmetered: 0 },
    { pool: "app", caller: "slow", operation: "ticket", requests: 2, points: 1000, unmetered: 0 },
    { pool: "app", caller: "nested", operation: "update", requests: 1, points: 7, unmetered: 0 },
  ]);
});

test("the last 60 minute buckets expire even when no further request arrives", () => {
  let now = 30_000;
  const usage = new LinearUsage(() => now);
  usage.record("app", "query first { viewer { id } }", metered("90"));
  now = MINUTE;
  usage.record("app", "query second { viewer { id } }", metered("7"));
  now = 60 * MINUTE;
  assert.deepEqual(usage.snapshot().rows.map((row) => [row.operation, row.points]), [["second", 7]]);
  assert.equal(usage.snapshot().since, new Date(MINUTE).toISOString());
  now = 61 * MINUTE;
  assert.deepEqual(usage.snapshot().rows, []);
  assert.equal(usage.snapshot().pools[0].requests, 0);
});

test("missing, invalid and failed measurements are unknown, while zero complexity is metered", () => {
  const usage = new LinearUsage(() => 0);
  for (const value of [null, new Headers(), metered(""), metered("garbage"), metered("-1"), metered("Infinity"), metered("0"), metered("12")]) {
    usage.record("app", "{ viewer { id } }", value);
  }
  assert.deepEqual(usage.snapshot().rows, [{ pool: "app", caller: "other", operation: "anonymous", requests: 8, points: 12, unmetered: 6 }]);
});

test("each credential reports its last observed budget, never extrapolated own usage", () => {
  let now = 0;
  const usage = new LinearUsage(() => now);
  usage.record("app", "query sample { viewer { id } }", new Headers({
    "x-complexity": "2", "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "123",
    "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": "456",
  }));
  now = MINUTE;
  usage.record("key", "query sample { viewer { id } }", metered("7"));
  now = 2 * MINUTE;
  usage.record("app", "query sample { viewer { id } }", null);
  assert.deepEqual(usage.snapshot().pools[0], {
    pool: "app", observedAt: new Date(0).toISOString(), requestsRemaining: 123, requestsLimit: 5000,
    pointsRemaining: 456, pointsLimit: 2000000, requests: 2, points: 2, unmetered: 1,
  });
  assert.equal(usage.snapshot().pools[1].points, 7);
  assert.equal(usage.snapshot().pools[1].pointsRemaining, null);
  assert.equal(usage.snapshot().since, new Date(0).toISOString());
});

test("real transport meters refused responses once, excludes local pauses, and counts failed sends", async (t) => {
  const budget = new RateBudget();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ errors: [{ extensions: { code: "RATELIMITED" } }] }), {
    status: 400, headers: { "x-complexity": "498" },
  }));
  await asCaller("transport-counter-test", async () => {
    await assert.rejects(postGraphQL("Bearer test", "query sample { viewer { id } }", {}, budget), RateLimitedError);
    await assert.rejects(postGraphQL("Bearer test", "query sample { viewer { id } }", {}, budget), RateLimitedError);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("network unavailable"); });
    await assert.rejects(postGraphQL("key", "query sample { viewer { id } }", {}, new RateBudget()), /Could not reach/);
  });
  assert.deepEqual(linearUsage.snapshot().rows.filter((row) => row.caller === "transport-counter-test"), [
    { pool: "app", caller: "transport-counter-test", operation: "sample", requests: 1, points: 498, unmetered: 0 },
    { pool: "key", caller: "transport-counter-test", operation: "sample", requests: 1, points: 0, unmetered: 1 },
  ]);
});
