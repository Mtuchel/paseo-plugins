import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { Scheduler, type Candidate } from "./scheduler";

// TUC-3006 acceptance: the menu bar polls linear.capacity every 15 s from several places, and each
// poll used to start a full agent listing once the 5 s admission cache ran out. Capacity reads now
// rescan only after 30 s; admissions keep their own 5 s bound.

const paseo = {} as PaseoApi;
const candidate: Candidate = { issueId: "w-1", identifier: "W-1", projectId: "erp", priority: 3, unblocks: 0, createdAt: "2026-01-01T00:00:00Z" };

function harness() {
  let now = 0, listings = 0;
  const instance = new Scheduler({ now: () => now, projectOf: async () => null, running: async () => { listings++; return ["one"]; } });
  return { instance, at: (ms: number) => { now = ms; }, listings: () => listings };
}

test("capacity reads reuse an observation up to 30 s old and report it as not stale", async () => {
  const h = harness();
  await h.instance.observedCounts(paseo);
  for (const at of [6_000, 15_000, 30_000]) {
    h.at(at);
    const observation = await h.instance.observedCounts(paseo);
    assert.equal(observation.running, 1);
    assert.equal(observation.stale, false, `${at} ms`);
  }
  assert.equal(h.listings(), 1);
});

test("an observation older than 30 s is returned as stale while one new listing runs", async () => {
  const h = harness();
  await h.instance.observedCounts(paseo);
  h.at(30_001);
  const [first, second] = await Promise.all([h.instance.observedCounts(paseo), h.instance.observedCounts(paseo)]);
  assert.equal(first.stale, true);
  assert.equal(second.observedAt, new Date(0).toISOString());
  await setImmediate();
  assert.equal(h.listings(), 2);
  assert.equal((await h.instance.observedCounts(paseo)).stale, false);
});

test("an admission still lists again once the observation is older than 5 s", async () => {
  const h = harness();
  await h.instance.observedCounts(paseo);
  h.at(5_001);
  await h.instance.admit(candidate, paseo, { limit: 2, source: "settings", lease: null });
  assert.equal(h.listings(), 2);
});
