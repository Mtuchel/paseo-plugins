import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { Tier } from "../shared/plan-model";
import { type TierRecord, type TierSource } from "./model-tiers";
import { nightInput, rankWaiting, Scheduler, type Candidate } from "./scheduler";

const paseo = {} as PaseoApi;
const max = (limit: number) => ({ limit, source: "settings" as const, lease: null });
const ticket = (identifier: string, change: Partial<Candidate> = {}): Candidate => ({ issueId: identifier.toLowerCase(), identifier, projectId: "erp", priority: 3, unblocks: 0, createdAt: "2026-01-01T00:00:00Z", ...change });
// The night input of an implementation on `tier`, and a tier store record like the one the plugin
// writes (model-guard.test.ts).
const impl = (identifier: string, tier: Tier, change: Partial<Candidate> = {}): Candidate => ticket(identifier, { ...change, night: { planReady: true, tier } });
const record = (...events: [TierSource, Tier][]): TierRecord => ({ issueId: "i1", identifier: "TUC-1", tier: events.at(-1)![1], agentId: "a1", updatedAt: "", history: events.map(([source, tier]) => ({ source, tier, reason: "", agentId: "a1", model: null, at: "" })) });

function scheduler(running: { issueId: string; projectId: string | null }[], away = false) {
  let now = 0;
  const projects = new Map(running.map((item) => [item.issueId, item.projectId]));
  const instance = new Scheduler({ running: async () => running.map((item) => item.issueId), projectOf: async (issueId) => projects.get(issueId) ?? null, away: async () => away, now: () => now });
  return { instance, advance: (ms: number) => { now += ms; } };
}

test("one project takes every free slot while nothing else waits", async () => {
  const { instance } = scheduler([{ issueId: "r1", projectId: "erp" }]);
  for (const name of ["TUC-1", "TUC-2"]) assert.deepEqual(await instance.admit(ticket(name), paseo, max(3)), { ok: true });
  assert.equal((await instance.admit(ticket("TUC-3"), paseo, max(3))).ok, false);
});

test("the project with fewer agents working gets the next slot, then priority, unblocking and age decide", async () => {
  const { instance } = scheduler([{ issueId: "r1", projectId: "erp" }, { issueId: "r2", projectId: "erp" }]);
  const erpUrgent = ticket("TUC-1", { priority: 1 });
  const other = ticket("TUC-2", { projectId: "web", priority: 4 });
  instance.note([erpUrgent, other]);
  const refused = await instance.admit(erpUrgent, paseo, max(3));
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /1 ticket ahead/);
  assert.deepEqual(await instance.admit(other, paseo, max(3)), { ok: true });

  const { instance: ranked } = scheduler([]);
  const low = ticket("TUC-5", { priority: 4 });
  const none = ticket("TUC-6", { priority: 0 });
  const unblocker = ticket("TUC-7", { unblocks: 3 });
  const older = ticket("TUC-8", { createdAt: "2025-01-01T00:00:00Z" });
  ranked.note([low, none, unblocker, older]);
  assert.deepEqual(await ranked.admit(unblocker, paseo, max(1)), { ok: true });
  const { instance: byAge } = scheduler([]);
  byAge.note([low, none, ticket("TUC-9"), older]);
  assert.deepEqual(await byAge.admit(older, paseo, max(1)), { ok: true });
  const { instance: noneLast } = scheduler([]);
  noneLast.note([none, low]);
  assert.equal((await noneLast.admit(none, paseo, max(1))).ok, false);
});

test("while the owner is away a cheap implementation goes first, then a standard one, then the rest", async () => {
  const strong = impl("TUC-1", "strong", { priority: 1, createdAt: "2025-01-01T00:00:00Z" });
  const planning = ticket("TUC-2", { priority: 1, createdAt: "2024-01-01T00:00:00Z", night: { planReady: false, tier: null } });
  const cheap = impl("TUC-3", "cheap", { priority: 4, createdAt: "2026-06-01T00:00:00Z" });
  const { instance } = scheduler([], true);
  instance.note([strong, planning, cheap]);
  assert.deepEqual(await instance.admit(cheap, paseo, max(1)), { ok: true }, "the newer, lower-priority cheap implementation takes the one slot");

  const standard = impl("TUC-4", "standard", { priority: 4 });
  const { instance: byStandard } = scheduler([], true);
  byStandard.note([strong, planning, standard]);
  const refused = await byStandard.admit(strong, paseo, max(1));
  assert.match(refused.ok ? "" : refused.reason, /2 tickets ahead/, "the standard implementation and the older planning ticket rank ahead of the urgent strong one");
  assert.deepEqual(await byStandard.admit(standard, paseo, max(1)), { ok: true });
});

test("a night class holds no slot back: a strong implementation or a planning ticket starts when nothing cheaper waits", async () => {
  const cheap = impl("TUC-1", "cheap");
  const strong = impl("TUC-2", "strong", { priority: 1 });
  const planning = ticket("TUC-3", { priority: 2 });
  const { instance } = scheduler([], true);
  instance.note([cheap, strong, planning]);
  assert.deepEqual(await instance.admit(cheap, paseo, max(2)), { ok: true });
  assert.deepEqual(await instance.admit(strong, paseo, max(2)), { ok: true }, "the second slot goes to the strong implementation");
  const { instance: onlyClassTwo } = scheduler([], true);
  onlyClassTwo.note([strong, planning]);
  assert.deepEqual(await onlyClassTwo.admit(strong, paseo, max(1)), { ok: true }, "with nothing cheaper waiting a class-2 ticket starts");
  assert.deepEqual(rankWaiting([strong, planning], new Map(), 1, true).map((item) => item.identifier), ["TUC-2"], "and the class-2 line keeps its order");
});

test("while the owner is present the night class is ignored and priority and age decide as before", async () => {
  const cheap = impl("TUC-1", "cheap", { priority: 4, createdAt: "2026-06-01T00:00:00Z" });
  const strong = impl("TUC-2", "strong", { priority: 1, createdAt: "2025-01-01T00:00:00Z" });
  const planning = ticket("TUC-3", { priority: 3, night: { planReady: false, tier: null } });
  const line = [cheap, strong, planning];
  assert.deepEqual(rankWaiting(line, new Map(), 3).map((item) => item.identifier), ["TUC-2", "TUC-3", "TUC-1"]);
  assert.deepEqual(rankWaiting(line, new Map(), 3, true).map((item) => item.identifier), ["TUC-1", "TUC-2", "TUC-3"], "away, the class comes before priority");
  const { instance } = scheduler([]);
  instance.note(line);
  assert.deepEqual(await instance.admit(strong, paseo, max(1)), { ok: true }, "present: the urgent, older ticket wins");
});

test("the night input reads the tier from the model: label and the tier store record", () => {
  assert.deepEqual(nightInput(["plan-ready", "model:cheap"], null), { planReady: true, tier: "cheap" });
  assert.deepEqual(nightInput(["plan-ready"], record(["plan", "standard"])), { planReady: true, tier: "standard" });
  assert.deepEqual(nightInput(["Model:Standard", "plan-ready"], record(["plan", "cheap"])), { planReady: true, tier: "standard" }, "the strongest of the two, as launchTier does");
  assert.deepEqual(nightInput(["plan-ready"], record(["start", "cheap"])), { planReady: true, tier: null }, "a recorded start alone decides nothing");
  assert.deepEqual(nightInput(["model:cheap"], null), { planReady: false, tier: "cheap" }, "a planning start ranks in class 2 whatever it carries");
  assert.deepEqual(nightInput([], null), { planReady: false, tier: null });
});

test("an admitted ticket holds its slot until its agent runs or the reservation runs out", async () => {
  const { instance, advance } = scheduler([]);
  assert.deepEqual(await instance.admit(ticket("TUC-1"), paseo, max(1)), { ok: true });
  assert.deepEqual(await instance.admit(ticket("TUC-1"), paseo, max(1)), { ok: true });
  assert.equal((await instance.admit(ticket("TUC-2"), paseo, max(1))).ok, false);
  advance(4 * 60_000);
  assert.deepEqual(await instance.admit(ticket("TUC-2"), paseo, max(1)), { ok: true });
  instance.release("tuc-2");
  assert.deepEqual(await instance.admit(ticket("TUC-3"), paseo, max(1)), { ok: true });
});
