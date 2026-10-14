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

test("one project takes every worker slot while nothing else waits", async () => {
  const { instance } = scheduler([{ issueId: "r1", projectId: "erp" }]);
  for (const name of ["TUC-1", "TUC-2"]) assert.deepEqual(await instance.admit(ticket(name), paseo, max(4)), { ok: true });
  assert.equal((await instance.admit(ticket("TUC-3"), paseo, max(4))).ok, false);
});

test("the project with fewer agents working gets the next slot, then priority, unblocking and age decide", async () => {
  const { instance } = scheduler([{ issueId: "r1", projectId: "erp" }, { issueId: "r2", projectId: "erp" }]);
  const erpUrgent = ticket("TUC-1", { priority: 1 });
  const other = ticket("TUC-2", { projectId: "web", priority: 4 });
  instance.note([erpUrgent, other]);
  const refused = await instance.admit(erpUrgent, paseo, max(4));
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /1 ticket ahead/);
  assert.deepEqual(await instance.admit(other, paseo, max(4)), { ok: true });

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

// Seen live on 2026-10-09: two queue blockers in the busiest project waited behind every lighter
// project while main was red and the queue held every stack.
test("a queue blocker takes the next free slot ahead of a lighter project, urgency, age and the night order, but still waits for one", async () => {
  const blocker = ticket("TUC-1832", { queueBlocker: true, priority: 4, createdAt: "2026-10-09T13:19:00Z" });
  const lighter = ticket("TUC-2", { projectId: "web", priority: 1, createdAt: "2025-01-01T00:00:00Z", attended: true });
  const { instance } = scheduler([{ issueId: "r1", projectId: "erp" }, { issueId: "r2", projectId: "erp" }]);
  instance.note([lighter, blocker]);
  assert.equal((await instance.admit(lighter, paseo, max(4))).ok, false, "the lighter project's urgent, older ticket waits");
  assert.deepEqual(await instance.admit(blocker, paseo, max(4)), { ok: true });

  const { instance: away } = scheduler([], true);
  const cheap = impl("TUC-3", "cheap", { createdAt: "2025-01-01T00:00:00Z" });
  away.note([cheap, blocker]);
  assert.deepEqual(await away.admit(blocker, paseo, max(1)), { ok: true }, "ahead of the night order too");

  const { instance: full } = scheduler([{ issueId: "r1", projectId: "erp" }]);
  assert.deepEqual(await full.admit(blocker, paseo, max(1)), { ok: false, reason: "Queued: 1 of 1 ticket agents are working. It starts when one finishes." }, "a full limit holds it");
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
  assert.deepEqual(await instance.admit(cheap, paseo, max(3)), { ok: true });
  assert.deepEqual(await instance.admit(strong, paseo, max(3)), { ok: true }, "the second worker slot goes to the strong implementation");
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

test("worker saturation leaves exactly one control slot within the hard cap", async () => {
  const { instance } = scheduler([]);
  assert.equal((await instance.admit(ticket("W-1"), paseo, max(3))).ok, true);
  assert.equal((await instance.admit(ticket("W-2"), paseo, max(3))).ok, true);
  assert.equal((await instance.admit(ticket("W-3"), paseo, max(3))).ok, false);
  assert.equal((await instance.admit(ticket("P-1", { control: true }), paseo, max(3))).ok, true);
  assert.equal((await instance.admit(ticket("P-2", { control: true }), paseo, max(3))).ok, false);
  assert.deepEqual(await instance.counts(paseo), { running: 0, reserved: 3, waiting: 2 });
});

test("a zero cap denies controls and previously reserved retries; one slot still serves workers", async () => {
  const { instance } = scheduler([]);
  const parent = ticket("P-1", { control: true });
  assert.equal((await instance.admit(parent, paseo, max(0))).ok, false);
  assert.equal((await instance.admit(ticket("W-1"), paseo, max(0))).ok, false);
  assert.equal((await instance.admit(ticket("W-1"), paseo, max(1))).ok, false, "the queued control takes priority");
  assert.equal((await instance.admit(parent, paseo, max(1))).ok, true);
  assert.equal((await instance.admit(parent, paseo, max(0))).ok, false, "a zero lease also holds a retry");
  instance.release(parent.issueId);
  assert.equal((await instance.admit(ticket("W-1"), paseo, max(1))).ok, true, "no permanently withheld worker slot");
});

test("existing full workers are not displaced, and controls obey presence", async () => {
  const running = [{ issueId: "r1", projectId: "erp" }, { issueId: "r2", projectId: "erp" }];
  const { instance, advance } = scheduler(running);
  const parent = ticket("P-1", { control: true });
  assert.equal((await instance.admit(parent, paseo, max(2))).ok, false);
  assert.deepEqual(await instance.counts(paseo), { running: 2, reserved: 0, waiting: 1 });
  running.pop();
  advance(5_001);
  assert.equal((await instance.admit(parent, paseo, max(2))).ok, true);
  const { instance: away } = scheduler([], true);
  assert.equal((await away.admit({ ...parent, attended: true }, paseo, max(2))).ok, false);
});

test("simultaneous admissions and diagnostics share refresh and reserve atomically after project reads", async () => {
  let lists = 0;
  let finishListing!: (value: string[]) => void;
  let finishProjects!: (value: string | null) => void;
  let projectStarted!: () => void;
  const listing = new Promise<string[]>((resolve) => { finishListing = resolve; });
  const project = new Promise<string | null>((resolve) => { finishProjects = resolve; });
  const readingProject = new Promise<void>((resolve) => { projectStarted = resolve; });
  const instance = new Scheduler({
    running: () => { lists++; return listing; },
    projectOf: () => { projectStarted(); return project; },
  });
  const worker = ticket("W-1");
  const asks = [worker, worker, ticket("W-2"), ticket("P-1", { control: true }), ticket("P-2", { control: true })]
    .map((item) => instance.admit(item, paseo, max(3)));
  const counts = [instance.counts(paseo), instance.counts(paseo)];
  finishListing(["existing"]);
  await readingProject;
  assert.equal(lists, 1);
  assert.deepEqual(await Promise.all(counts), [{ running: 1, reserved: 0, waiting: 4 }, { running: 1, reserved: 0, waiting: 4 }]);
  finishProjects("erp");
  const results = await Promise.all(asks);
  assert.deepEqual(results.map((result) => result.ok), [false, false, false, true, true]);
  assert.deepEqual(await instance.counts(paseo), { running: 1, reserved: 2, waiting: 2 });
  assert.equal(lists, 1);
});

test("simultaneous retries of one ticket retain one reservation, including after expiry", async () => {
  const { instance, advance } = scheduler([]);
  const worker = ticket("W-1");
  assert.deepEqual((await Promise.all([instance.admit(worker, paseo, max(1)), instance.admit(worker, paseo, max(1))])).map((result) => result.ok), [true, true]);
  assert.deepEqual(await instance.counts(paseo), { running: 0, reserved: 1, waiting: 0 });
  advance(180_001);
  assert.deepEqual(await instance.counts(paseo), { running: 0, reserved: 0, waiting: 0 });
  assert.equal((await instance.admit(worker, paseo, max(1))).ok, true);
});

test("slow refresh stays cached from completion and failed refresh never fabricates empty counts", async () => {
  let now = 0;
  let lists = 0;
  const instance = new Scheduler({
    now: () => now,
    running: async () => {
      lists++;
      if (lists === 1) throw new Error("listing unavailable");
      now += 20_000;
      return ["working"];
    },
    projectOf: async () => null,
  });
  await assert.rejects(instance.counts(paseo), /listing unavailable/);
  assert.deepEqual(await instance.counts(paseo), { running: 1, reserved: 0, waiting: 0 });
  assert.deepEqual(await instance.counts(paseo), { running: 1, reserved: 0, waiting: 0 });
  assert.equal(lists, 2, "a twenty-second read is still fresh when it completes");
  now += 5_001;
  await instance.counts(paseo);
  assert.equal(lists, 3);
});

test("visible control reservations reconcile once and expired controls restore the held slot", async () => {
  let now = 0;
  const running: { issueId: string; control: boolean }[] = [];
  const instance = new Scheduler({ running: async () => [...running], projectOf: async () => null, now: () => now });
  const parent = ticket("P-1", { control: true });
  await instance.admit(parent, paseo, max(3));
  running.push({ issueId: parent.issueId, control: true });
  now += 5_001;
  assert.deepEqual(await instance.counts(paseo), { running: 1, reserved: 0, waiting: 0 });
  assert.equal((await instance.admit(ticket("W-1"), paseo, max(3))).ok, true);
  assert.equal((await instance.admit(ticket("W-2"), paseo, max(3))).ok, true, "the running control consumes the held slot");
  running.length = 0;
  now += 180_001;
  assert.deepEqual(await instance.counts(paseo), { running: 0, reserved: 0, waiting: 0 });
  assert.equal((await instance.admit(ticket("W-3"), paseo, max(2))).ok, true);
  assert.equal((await instance.admit(ticket("W-4"), paseo, max(2))).ok, false);
  assert.equal((await instance.admit(parent, paseo, max(2))).ok, true);
});
