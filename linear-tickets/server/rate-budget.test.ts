import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubRateLimitedError } from "./pr-watch";
import { GitHubBudget, GitHubPausedError, RateBudget, RateLimitedError, withPriority } from "./rate-budget";
import { LinearUsage } from "./linear-usage";
import { postGraphQL } from "./linear";

const HOUR = 60 * 60 * 1000;

function headers(limit: number, remaining: number): Headers {
  return new Headers({ "x-ratelimit-requests-limit": String(limit), "x-ratelimit-requests-remaining": String(remaining) });
}

function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, budget: new RateBudget(() => time.now) };
}

test("the estimate refills at limit per hour after the last response, capped at the limit", () => {
  const { time, budget } = clock();
  assert.equal(budget.estimate("key"), Infinity);
  budget.acquire("key").done(headers(3600, 100), false);
  assert.equal(budget.estimate("key"), 100);
  time.now += 60_000;
  assert.equal(budget.estimate("key"), 160);
  time.now += 2 * HOUR;
  assert.equal(budget.estimate("key"), 3600);
});
function points(remaining: number): Headers {
  const result = headers(5000, 4500);
  result.set("x-ratelimit-complexity-limit", "2000000");
  result.set("x-ratelimit-complexity-remaining", String(remaining));
  return result;
}

test("both reserves use the lower dimension, while unknown points do not restrict", () => {
  const { time, budget } = clock();
  budget.acquire("app").done(points(380_000), false);
  const until = time.now + Math.ceil((400_000 + 100 - 380_000) * HOUR / 2_000_000);
  assert.equal(budget.pausedUntil("app", "background"), until);
  assert.throws(() => budget.acquire("app", "background"), (error: unknown) => error instanceof RateLimitedError && error.reason === "reserve" && error.resumeAt === until);
  budget.acquire("app", "interactive").done(null, false);
  budget.acquire("app", "owner").done(null, false);
  time.now = until;
  budget.acquire("app", "background").done(null, false);
  budget.acquire("key").done(headers(5000, 4500), false);
  budget.acquire("key", "background").done(null, false);
});

test("requests and points reserve the last five percent for owner operations", () => {
  for (const dimension of ["requests", "points"] as const) {
    const { budget } = clock();
    const low = dimension === "points" ? points(80_000) : headers(5000, 200);
    budget.acquire("app").done(low, false);
    assert.throws(() => budget.acquire("app", "interactive"), RateLimitedError);
    assert.throws(() => budget.acquire("app", "background"), RateLimitedError);
    budget.acquire("app", "owner").done(dimension === "points" ? points(120_000) : headers(5000, 300), false);
    budget.acquire("app", "interactive").done(null, false);
    assert.throws(() => budget.acquire("app", "background"), RateLimitedError);
  }
});

test("concurrent requests reserve their estimated in-flight costs atomically", async () => {
  const { budget } = clock();
  budget.acquire("app").done(points(400_000 + 5 * 100), false);
  const tickets = await Promise.all(Array.from({ length: 20 }, () => withPriority("background", "test poll", async () => {
    try { return budget.acquire("app"); } catch { return null; }
  })));
  assert.equal(tickets.filter(Boolean).length, 5);
  for (const ticket of tickets) ticket?.done(null, false);
});

test("awaited nested background work cannot demote owner context", async () => {
  const { budget } = clock();
  budget.acquire("app").done(points(60_000), false);
  await withPriority("background", "test poll", async () => {
    await Promise.resolve();
    assert.throws(() => budget.acquire("app"), RateLimitedError);
    await withPriority("owner", "test decision", () => withPriority("background", "nested", async () => {
      budget.acquire("app").done(null, false);
    }));
  });
});

test("backoff precedes owner probe; lower tiers cannot steal it; network failure releases it", () => {
  const { time, budget } = clock();
  budget.acquire("app").done(points(0), true);
  for (const level of ["owner", "interactive", "background"] as const) {
    assert.throws(() => budget.acquire("app", level), (error: unknown) => error instanceof RateLimitedError && error.reason === "limited" && error.resumeAt === time.now + 60_000);
  }
  time.now += 60_000;
  assert.throws(() => budget.acquire("app", "background"), RateLimitedError);
  assert.throws(() => budget.acquire("app", "interactive"), RateLimitedError);
  const first = budget.acquire("app", "owner");
  assert.throws(() => budget.acquire("app", "owner"), RateLimitedError);
  first.done(null, false);
  const second = budget.acquire("app", "owner");
  second.done(points(0), true);
  assert.equal(budget.blockedUntil("app"), time.now + 120_000);
  time.now += 120_000;
  budget.acquire("app", "owner").done(points(1_000_000), false);
  assert.equal(budget.blockedUntil("app"), 0);
  budget.acquire("app", "background").done(null, false);
});

test("missing dimension headers preserve the sample; EWMA estimates complexity in flight", () => {
  const { time, budget } = clock();
  const response = points(1_000_000);
  response.set("x-complexity", "1000");
  budget.acquire("app").done(response, false);
  assert.equal(budget.averagePoints("app"), 280);
  const ticket = budget.acquire("app");
  assert.equal(budget.estimate("app", "points"), 1_000_000 - 280);
  ticket.done(headers(5000, 4400), false);
  assert.equal(budget.estimate("app", "points"), 1_000_000);
  time.now += HOUR;
  assert.equal(budget.estimate("app", "points"), 2_000_000);
});

test("a headerless refusal preserves the minute floor and doubles limited probes", () => {
  const { time, budget } = clock();
  budget.acquire("app").done(null, true);
  assert.equal(budget.blockedUntil("app"), time.now + 60_000);
  time.now += 60_000;
  budget.acquire("app", "owner").done(null, true);
  assert.equal(budget.blockedUntil("app"), time.now + 120_000);
});

test("real requests attribute operation fallback and nested caller costs without mixing pools", async (t) => {
  const usage = new LinearUsage(() => Date.parse("2026-10-07T09:10:00Z"));
  const budget = new RateBudget(() => Date.parse("2026-10-07T09:10:00Z"), usage);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: {} }), { headers: query.includes("Measured") ? { "x-complexity": "1000" } : {} });
  });
  await postGraphQL("Bearer app", "query Measured { viewer { id } }", {}, budget);
  await withPriority("interactive", "sidebar", () => postGraphQL("Bearer app", "query Estimated { viewer { id } }", {}, budget));
  await withPriority("owner", "status change", () => postGraphQL("key", "mutation Measured { issueUpdate { success } }", {}, budget));
  const hours = usage.summary();
  assert.deepEqual(hours.find((hour) => hour.pool === "app")!.callers, [
    { caller: "op:Measured", requests: 1, points: 1000 },
    { caller: "sidebar", requests: 1, points: 280 },
  ]);
  assert.deepEqual(hours.find((hour) => hour.pool === "key")!.callers, [{ caller: "status change", requests: 1, points: 1000 }]);
});

test("concurrent already-sent refusals do not count as successively limited probes", () => {
  const { time, budget } = clock();
  const a = budget.acquire("app"), b = budget.acquire("app");
  a.done(points(0), true);
  b.done(points(0), true);
  assert.equal(budget.blockedUntil("app"), time.now + 60_000);
});

function githubHeaders(remaining: number, resetAt: number, resource = "core"): Map<string, string> {
  return new Map([["x-ratelimit-limit", "5000"], ["x-ratelimit-remaining", String(remaining)], ["x-ratelimit-reset", String(resetAt / 1000)], ["x-ratelimit-resource", resource]]);
}

test("GitHub: background requests stop below the 300-request reserve until the window resets; interactive ones go on", () => {
  const time = { now: 1_000_000_000 };
  const budget = new GitHubBudget(() => time.now);
  const reset = time.now + 20 * 60_000;
  budget.admit("background");
  budget.record(githubHeaders(300, reset));
  budget.admit("background");
  budget.record(githubHeaders(299, reset));
  assert.throws(() => budget.admit("background"), (error: unknown) => error instanceof GitHubPausedError && error.reason === "budget" && error.resumeAt === reset);
  budget.admit("interactive");
  budget.admit("owner");
  // Another resource (search) says nothing about the core budget.
  budget.record(githubHeaders(4999, reset, "search"));
  assert.throws(() => budget.admit("background"), GitHubPausedError);
  time.now = reset;
  assert.equal(budget.current(), null);
  budget.admit("background");
});

test("GitHub: after a refusal nothing is sent for two minutes, interactive requests included", async () => {
  const time = { now: 1_000_000_000 };
  const budget = new GitHubBudget(() => time.now);
  const pause = budget.throttled();
  assert.equal(pause.resumeAt, time.now + 120_000);
  await withPriority("interactive", "test GitHub", async () => assert.throws(() => budget.admit(), (error: unknown) => error instanceof GitHubPausedError && error.reason === "throttled"));
  time.now += 120_000;
  budget.admit("interactive");
});

test("GitHub: a routed budget records nothing from one account's headers and passes the router's refusal through", () => {
  const time = { now: 1_000_000_000 };
  const budget = new GitHubBudget(() => time.now, 300, true);
  // However low the account that answered last is, the router picks the other one for reads.
  budget.record(githubHeaders(1, time.now + 20 * 60_000));
  assert.equal(budget.current(), null);
  budget.admit("background");
  budget.admit("interactive");
  const refused = new GitHubRateLimitedError("GitHub is throttling gh: GitHub read budgets exhausted; try again after 2026-10-06T23:10:00Z.");
  assert.equal(budget.refused(refused), refused, "the router's message is what the caller surfaces");
  budget.admit("interactive");
});
