import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Capacity } from "./capacity";
import { Scheduler, type Candidate } from "./scheduler";

const paseo = {} as PaseoApi;
const ticket = (identifier: string): Candidate => ({ issueId: identifier.toLowerCase(), identifier, projectId: "erp", priority: 3, unblocks: 0, createdAt: "2026-01-01T00:00:00Z" });
const lease = (limit: number, ttlSeconds = 120) => ({ limit, ttlSeconds, reason: "80 GB budget, 6 GB free" });

function room(running: string[] = []) {
  let now = Date.parse("2026-10-03T12:00:00Z");
  const clock = () => now;
  return {
    capacity: new Capacity(clock),
    scheduler: new Scheduler({ running: async () => running, projectOf: async () => "erp", now: clock }),
    advance: (ms: number) => { now += ms; },
  };
}

test("a lease below max agents caps new starts, and the queue names RAM and the lease's reason", async () => {
  const { capacity, scheduler } = room(["r1"]);
  capacity.set(lease(2));
  const cap = capacity.limit(10);
  assert.deepEqual({ limit: cap.limit, source: cap.source }, { limit: 2, source: "ram" });
  assert.deepEqual(await scheduler.admit(ticket("TUC-1"), paseo, cap), { ok: true });
  assert.deepEqual(await scheduler.admit(ticket("TUC-2"), paseo, cap), { ok: false, reason: "Queued: RAM-limited, 2 of 2 slots used (80 GB budget, 6 GB free). It starts when memory frees up." });
});

test("a lease above max agents is clamped to max agents, which then decides", async () => {
  const { capacity, scheduler } = room();
  capacity.set(lease(5));
  const cap = capacity.limit(1);
  assert.deepEqual({ limit: cap.limit, source: cap.source, leased: cap.lease?.limit }, { limit: 1, source: "settings", leased: 5 });
  assert.deepEqual(await scheduler.admit(ticket("TUC-1"), paseo, cap), { ok: true });
  const refused = await scheduler.admit(ticket("TUC-2"), paseo, cap);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /^Queued: 1 of 1 ticket agents are working/);
});

test("with no max agents, a lease still applies", async () => {
  const { capacity, scheduler } = room();
  capacity.set(lease(1));
  const cap = capacity.limit(0);
  assert.equal(cap.limit, 1);
  assert.deepEqual(await scheduler.admit(ticket("TUC-1"), paseo, cap), { ok: true });
  assert.equal((await scheduler.admit(ticket("TUC-2"), paseo, cap)).ok, false);
});

test("a lease of 0 admits nothing; clearing it brings back no limit", async () => {
  const { capacity, scheduler } = room();
  capacity.set(lease(0));
  const refused = await scheduler.admit(ticket("TUC-1"), paseo, capacity.limit(0));
  assert.deepEqual(refused, { ok: false, reason: "Queued: RAM-limited, 0 of 0 slots used (80 GB budget, 6 GB free). It starts when memory frees up." });
  assert.equal(capacity.set(null), null);
  assert.deepEqual(capacity.limit(0), { limit: null, source: "settings", lease: null });
  assert.deepEqual(await scheduler.admit(ticket("TUC-1"), paseo, capacity.limit(0)), { ok: true });
});

test("an expired lease falls back to max agents", () => {
  const { capacity, advance } = room();
  assert.equal(capacity.set(lease(0, 30))?.until, "2026-10-03T12:00:30.000Z");
  advance(29_000);
  assert.equal(capacity.limit(4).limit, 0);
  advance(1_000);
  assert.deepEqual(capacity.limit(4), { limit: 4, source: "settings", lease: null });
  assert.equal(capacity.current(), null);
});

test("leases out of range are refused and leave the current one in place", () => {
  const { capacity } = room();
  capacity.set(lease(3));
  for (const bad of [lease(-1), lease(51), lease(1.5), lease(3, 29), lease(3, 601), { ...lease(3), reason: "  " }, { ...lease(3), reason: "x".repeat(201) }]) {
    assert.throws(() => capacity.set(bad), /RAM/, JSON.stringify(bad));
  }
  assert.equal(capacity.current()?.limit, 3);
  assert.equal(capacity.set(lease(50, 600))?.limit, 50);
});

test("the capacity counts working, reserved and waiting tickets; the wait line lists the waiting ones until they go stale", async () => {
  const { capacity, scheduler, advance } = room(["r1"]);
  capacity.set(lease(2));
  const cap = capacity.limit(0);
  await scheduler.admit(ticket("TUC-1"), paseo, cap);
  await scheduler.admit(ticket("TUC-2"), paseo, cap);
  await scheduler.admit(ticket("TUC-3"), paseo, cap);
  assert.deepEqual(await scheduler.counts(paseo), { running: 1, reserved: 1, waiting: 2 });
  assert.deepEqual(scheduler.waitingIds(), [ticket("TUC-2").issueId, ticket("TUC-3").issueId], "the admitted TUC-1 is not in line");
  advance(4 * 60_000);
  assert.deepEqual(scheduler.waitingIds(), [], "not asked for in 3 minutes: out of the line");
  assert.deepEqual(await scheduler.counts(paseo), { running: 1, reserved: 0, waiting: 0 });
});
