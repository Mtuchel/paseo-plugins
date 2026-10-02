import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Scheduler, type Candidate } from "./scheduler";

const paseo = {} as PaseoApi;
const ticket = (identifier: string, change: Partial<Candidate> = {}): Candidate => ({ issueId: identifier.toLowerCase(), identifier, projectId: "erp", priority: 3, unblocks: 0, createdAt: "2026-01-01T00:00:00Z", ...change });

function scheduler(running: { issueId: string; projectId: string | null }[]) {
  let now = 0;
  const projects = new Map(running.map((item) => [item.issueId, item.projectId]));
  const instance = new Scheduler({ running: async () => running.map((item) => item.issueId), projectOf: async (issueId) => projects.get(issueId) ?? null, now: () => now });
  return { instance, advance: (ms: number) => { now += ms; } };
}

test("one project takes every free slot while nothing else waits", async () => {
  const { instance } = scheduler([{ issueId: "r1", projectId: "erp" }]);
  for (const name of ["TUC-1", "TUC-2"]) assert.deepEqual(await instance.admit(ticket(name), paseo, 3), { ok: true });
  assert.equal((await instance.admit(ticket("TUC-3"), paseo, 3)).ok, false);
});

test("the project with fewer agents working gets the next slot, then priority, unblocking and age decide", async () => {
  const { instance } = scheduler([{ issueId: "r1", projectId: "erp" }, { issueId: "r2", projectId: "erp" }]);
  const erpUrgent = ticket("TUC-1", { priority: 1 });
  const other = ticket("TUC-2", { projectId: "web", priority: 4 });
  instance.note([erpUrgent, other]);
  const refused = await instance.admit(erpUrgent, paseo, 3);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /1 ticket ahead/);
  assert.deepEqual(await instance.admit(other, paseo, 3), { ok: true });

  const { instance: ranked } = scheduler([]);
  const low = ticket("TUC-5", { priority: 4 });
  const none = ticket("TUC-6", { priority: 0 });
  const unblocker = ticket("TUC-7", { unblocks: 3 });
  const older = ticket("TUC-8", { createdAt: "2025-01-01T00:00:00Z" });
  ranked.note([low, none, unblocker, older]);
  assert.deepEqual(await ranked.admit(unblocker, paseo, 1), { ok: true });
  const { instance: byAge } = scheduler([]);
  byAge.note([low, none, ticket("TUC-9"), older]);
  assert.deepEqual(await byAge.admit(older, paseo, 1), { ok: true });
  const { instance: noneLast } = scheduler([]);
  noneLast.note([none, low]);
  assert.equal((await noneLast.admit(none, paseo, 1)).ok, false);
});

test("an admitted ticket holds its slot until its agent runs or the reservation runs out", async () => {
  const { instance, advance } = scheduler([]);
  assert.deepEqual(await instance.admit(ticket("TUC-1"), paseo, 1), { ok: true });
  assert.deepEqual(await instance.admit(ticket("TUC-1"), paseo, 1), { ok: true });
  assert.equal((await instance.admit(ticket("TUC-2"), paseo, 1)).ok, false);
  advance(4 * 60_000);
  assert.deepEqual(await instance.admit(ticket("TUC-2"), paseo, 1), { ok: true });
  instance.release("tuc-2");
  assert.deepEqual(await instance.admit(ticket("TUC-3"), paseo, 1), { ok: true });
});
