import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { AgentDirectory } from "./agent-directory";

// TUC-3006 acceptance: one shared agent listing for the plugin's periodic readers. The daemon
// rebuilds and sorts every agent for each page it serves, so the number of list requests is the
// cost this directory exists to cut.

type Call = { includeArchived: boolean; cursor?: string; limit: number };
type Agent = { id: string; archivedAt: string | null; labels: Record<string, string> };

function agent(id: string, archivedAt: string | null = null, labels: Record<string, string> = {}): Agent {
  return { id, archivedAt, labels };
}

function daemon() {
  const state = {
    live: [] as Agent[],
    archived: [] as Agent[],
    calls: [] as Call[],
    failure: null as null | "no-page-info" | "repeat-cursor" | "throw",
    gate: null as Promise<void> | null,
  };
  const paseo = {
    agents: {
      list: async (input: { filter?: { includeArchived?: boolean }; page?: { limit?: number; cursor?: string } }) => {
        const includeArchived = input.filter?.includeArchived === true;
        const limit = input.page?.limit ?? 200;
        state.calls.push({ includeArchived, cursor: input.page?.cursor, limit });
        if (state.gate) await state.gate;
        if (state.failure === "throw") throw new Error("daemon unavailable");
        const source = includeArchived ? [...state.live, ...state.archived] : state.live;
        const start = Number(input.page?.cursor ?? 0);
        const entries = source.slice(start, start + limit).map(agent => ({ agent: { ...agent } }));
        const hasMore = start + limit < source.length;
        if (state.failure === "no-page-info") return { entries };
        const nextCursor = hasMore ? (state.failure === "repeat-cursor" ? String(limit) : String(start + limit)) : null;
        return { entries, pageInfo: { hasMore, nextCursor } };
      },
    },
  } as unknown as PaseoApi;
  return { state, paseo, scans: (archived: boolean) => state.calls.filter(call => call.includeArchived === archived && !call.cursor).length };
}

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const ids = (agents: readonly PaseoAgent[]) => agents.map(agent => agent.id).sort();

test("concurrent readers share one paginated live scan, and the snapshot is reused until it is liveTtlMs old", async () => {
  const d = daemon(), c = clock();
  d.state.live = [agent("a1"), agent("a2"), agent("a3"), agent("a4"), agent("a5")];
  const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000, pageLimit: 2 });
  directory.attach(d.paseo);

  const [first, second] = await Promise.all([directory.live(), directory.live()]);
  assert.deepEqual(ids(first), ["a1", "a2", "a3", "a4", "a5"]);
  assert.deepEqual(ids(second), ids(first));
  assert.equal(d.state.calls.length, 3, "one scan of three pages, shared by both readers");
  assert.ok(d.state.calls.every(call => !call.includeArchived && call.limit === 2));

  c.advance(19_999);
  await directory.live();
  assert.equal(d.state.calls.length, 3, "a snapshot younger than liveTtlMs is served without a request");

  d.state.live.push(agent("a6"));
  c.advance(1);
  assert.deepEqual(ids(await directory.live()), ["a1", "a2", "a3", "a4", "a5", "a6"]);
  assert.equal(d.scans(false), 2, "an expired snapshot is scanned again");
});

test("each reader gets its own array: sorting or filtering one result cannot change another's", async () => {
  const d = daemon(), c = clock();
  d.state.live = [agent("b"), agent("a")];
  const directory = new AgentDirectory({ now: c.now });
  directory.attach(d.paseo);
  const first = await directory.live();
  first.sort((x, y) => x.id.localeCompare(y.id));
  first.pop();
  assert.deepEqual((await directory.live()).map(agent => agent.id), ["b", "a"]);
});

test("a reader before any Paseo source is attached is refused, not answered with an empty list", async () => {
  const directory = new AgentDirectory();
  await assert.rejects(directory.live(), /Paseo source unavailable/);
  await assert.rejects(directory.all(), /Paseo source unavailable/);
});

test("an incomplete listing is an error for every waiting reader and is never cached", async () => {
  for (const failure of ["no-page-info", "repeat-cursor", "throw"] as const) {
    const d = daemon(), c = clock();
    d.state.live = [agent("a1"), agent("a2"), agent("a3"), agent("a4"), agent("a5")];
    const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000, pageLimit: 2 });
    directory.attach(d.paseo);
    assert.equal((await directory.live()).length, 5);

    c.advance(20_000);
    d.state.failure = failure;
    const results = await Promise.allSettled([directory.live(), directory.live()]);
    assert.ok(results.every(result => result.status === "rejected"), `${failure}: both readers see the failure, not the expired snapshot`);

    d.state.failure = null;
    const scansBefore = d.scans(false);
    assert.equal((await directory.live()).length, 5, `${failure}: the next reader starts a new scan`);
    assert.equal(d.scans(false), scansBefore + 1);
  }
});

test("a listing longer than maxPages is refused instead of read without end", async () => {
  const d = daemon();
  d.state.live = [agent("a1"), agent("a2"), agent("a3"), agent("a4"), agent("a5")];
  const directory = new AgentDirectory({ pageLimit: 2, maxPages: 2 });
  directory.attach(d.paseo);
  await assert.rejects(directory.live());
  assert.equal(d.state.calls.length, 2);
});

test("invalidate makes the next reader scan again, also when it lands during a scan in flight", async () => {
  const d = daemon(), c = clock();
  d.state.live = [agent("a1")];
  const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000 });
  directory.attach(d.paseo);
  await directory.live();

  d.state.live.push(agent("a2"));
  directory.invalidate();
  assert.deepEqual(ids(await directory.live()), ["a1", "a2"]);
  assert.equal(d.scans(false), 2);

  let release!: () => void;
  d.state.gate = new Promise<void>(resolve => { release = resolve; }); // lib is ES2023: no Promise.withResolvers
  directory.invalidate();
  const inFlight = directory.live();
  await Promise.resolve();
  d.state.live.push(agent("a3"));
  directory.invalidate(); // an agent was created after the scan's pages were requested
  d.state.gate = null;
  release();
  await inFlight; // its readers still get the scan they joined
  assert.deepEqual(ids(await directory.live()), ["a1", "a2", "a3"], "the scan that started before invalidate is not cached as fresh");
  assert.equal(d.scans(false), 4);
});

test("all() is the live agents plus an archived index scanned once per archivedTtlMs", async () => {
  const d = daemon(), c = clock();
  d.state.live = [agent("a1", null, { k: "live" })];
  d.state.archived = [agent("z1", "2026-10-01T00:00:00.000Z"), agent("z2", "2026-10-02T00:00:00.000Z")];
  const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000, archivedTtlMs: 600_000, pageLimit: 200 });
  directory.attach(d.paseo);

  const [first, second] = await Promise.all([directory.all(), directory.all()]);
  assert.deepEqual(ids(first), ["a1", "z1", "z2"]);
  assert.deepEqual(ids(second), ids(first));
  assert.equal(d.scans(true), 1, "one archived scan shared by concurrent readers");
  assert.equal(d.scans(false), 1);

  c.advance(20_000);
  await directory.all();
  assert.equal(d.scans(true), 1, "an archived index younger than archivedTtlMs is reused while live agents are rescanned");
  assert.equal(d.scans(false), 2);

  c.advance(600_000);
  d.state.archived.push(agent("z3", "2026-10-03T00:00:00.000Z"));
  assert.deepEqual(ids(await directory.all()), ["a1", "z1", "z2", "z3"]);
  assert.equal(d.scans(true), 2, "an expired archived index is scanned again");
});

test("all() reports each agent once and the live record wins over an archived one", async () => {
  const d = daemon(), c = clock();
  d.state.archived = [agent("a1", "2026-10-01T00:00:00.000Z", { k: "archived" })];
  const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000 });
  directory.attach(d.paseo);
  await directory.all();

  // Unarchived: the daemon lists it live again, while the archived index still holds it.
  d.state.archived = [];
  d.state.live = [agent("a1", null, { k: "live" })];
  c.advance(20_000);
  const all = await directory.all();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.archivedAt, null);
  assert.equal(all[0]!.labels.k, "live");
});

test("an agent that leaves the live listing is found in all() without waiting for the archived index to expire", async () => {
  const d = daemon(), c = clock();
  d.state.live = [agent("a1"), agent("a2"), agent("a3")];
  const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000, archivedTtlMs: 600_000 });
  directory.attach(d.paseo);
  assert.deepEqual(ids(await directory.all()), ["a1", "a2", "a3"]);
  assert.equal(d.scans(true), 1);

  // a2 is archived, a3 deleted.
  d.state.live = [agent("a1")];
  d.state.archived = [agent("a2", "2026-10-23T20:00:00.000Z")];
  c.advance(20_000);
  const all = await directory.all();
  assert.deepEqual(ids(all), ["a1", "a2"]);
  assert.equal(all.find(agent => agent.id === "a2")!.archivedAt, "2026-10-23T20:00:00.000Z");
  assert.equal(d.scans(true), 2, "the dropped agents made the archived index stale");

  c.advance(20_000);
  await directory.all();
  assert.equal(d.scans(true), 2, "no further archived scan while nothing else left the live listing");
});

test("a live() reader alone also notices agents that left, so a later all() still includes them", async () => {
  const d = daemon(), c = clock();
  d.state.live = [agent("a1"), agent("a2")];
  const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000, archivedTtlMs: 600_000 });
  directory.attach(d.paseo);
  await directory.all();

  d.state.live = [agent("a1")];
  d.state.archived = [agent("a2", "2026-10-23T20:00:00.000Z")];
  c.advance(20_000);
  await directory.live(); // the drop is seen here, not by all()
  c.advance(1);
  assert.deepEqual(ids(await directory.all()), ["a1", "a2"]);
  assert.equal(d.scans(true), 2);
});

test("a newly attached Paseo source serves the following scans", async () => {
  const first = daemon(), second = daemon(), c = clock();
  first.state.live = [agent("old")];
  second.state.live = [agent("new")];
  const directory = new AgentDirectory({ now: c.now, liveTtlMs: 20_000 });
  directory.attach(first.paseo);
  assert.deepEqual(ids(await directory.live()), ["old"]);
  directory.attach(second.paseo);
  c.advance(20_000);
  assert.deepEqual(ids(await directory.live()), ["new"]);
  assert.equal(second.scans(false), 1);
});
