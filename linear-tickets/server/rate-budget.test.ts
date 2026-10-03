import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubBudget, GitHubPausedError, RateBudget, RateLimitedError, withPriority } from "./rate-budget";

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

test("background work stops at the 15% reserve and resumes once the refill passes it; interactive work does not stop", () => {
  const { time, budget } = clock();
  budget.acquire("key").done(headers(3600, 540), false);
  // Reserve is 540: nothing is left for background work.
  const paused = budget.pausedUntil("key");
  assert.ok(paused !== null && paused > time.now);
  assert.throws(() => budget.acquire("key", "background"), (error: unknown) => error instanceof RateLimitedError && error.reason === "reserve");
  budget.acquire("key", "interactive").done(null, false);
  time.now = paused;
  budget.acquire("key", "background").done(null, false);
  // The other pool is unaffected.
  assert.equal(budget.pausedUntil("app"), null);
});

test("concurrent background requests near the reserve: only the requests above it get through", async () => {
  const { budget } = clock();
  budget.acquire("key").done(headers(1000, 150 + 5), false);
  const results = await Promise.all(Array.from({ length: 20 }, () => withPriority("background", async () => {
    try {
      return budget.acquire("key");
    } catch {
      return null;
    }
  })));
  assert.equal(results.filter(Boolean).length, 5);
});

test("withPriority marks every request inside it as background, including awaited ones", async () => {
  const { budget } = clock();
  budget.acquire("app").done(headers(1000, 100), false);
  await withPriority("background", async () => {
    await Promise.resolve();
    assert.throws(() => budget.acquire("app"), RateLimitedError);
  });
  budget.acquire("app").done(null, false);
});

test("after a rate limit only one probe goes out; success unblocks, another limit doubles the wait", () => {
  const { time, budget } = clock();
  budget.acquire("key").done(headers(3600, 0), true);
  const firstBlock = budget.pausedUntil("key")!;
  // At least the one-minute floor, and the refill to the 540-request reserve (9 min) here.
  assert.equal(firstBlock - time.now, 540_000);
  assert.throws(() => budget.acquire("key", "interactive"), RateLimitedError);

  time.now = firstBlock;
  const probe = budget.acquire("key", "interactive");
  assert.throws(() => budget.acquire("key", "interactive"), RateLimitedError, "a second request waits for the probe");
  probe.done(headers(3600, 0), true);
  const secondBlock = budget.pausedUntil("key")!;
  assert.equal(secondBlock - time.now, 540_000);

  // Without limit headers the backoff alone decides: 60 s, then doubled.
  const bare = clock();
  bare.budget.acquire("app").done(null, true);
  assert.equal(bare.budget.pausedUntil("app")! - bare.time.now, 60_000);
  bare.time.now += 60_000;
  bare.budget.acquire("app").done(null, true);
  assert.equal(bare.budget.pausedUntil("app")! - bare.time.now, 120_000);
  bare.time.now += 120_000;
  bare.budget.acquire("app").done(headers(5000, 4000), false);
  assert.equal(bare.budget.pausedUntil("app"), null);
  bare.budget.acquire("app", "background").done(null, false);
});

test("a stale budget recovers without any request: the estimate rises with time", () => {
  const { time, budget } = clock();
  budget.acquire("key").done(headers(3600, 0), false);
  const until = budget.pausedUntil("key")!;
  assert.ok(until > time.now);
  time.now = until;
  assert.equal(budget.pausedUntil("key"), null);
});

test("a probe that never reached Linear frees the probe slot", () => {
  const { time, budget } = clock();
  budget.acquire("key").done(null, true);
  time.now = budget.pausedUntil("key")!;
  budget.acquire("key").done(null, false);
  budget.acquire("key").done(headers(2500, 2000), false);
  assert.equal(budget.pausedUntil("key"), null);
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
  await withPriority("interactive", async () => assert.throws(() => budget.admit(), (error: unknown) => error instanceof GitHubPausedError && error.reason === "throttled"));
  time.now += 120_000;
  budget.admit("interactive");
});
