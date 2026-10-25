import assert from "node:assert/strict";
import test from "node:test";
import { DaemonUsage } from "./daemon-usage";
import { asCaller } from "./linear-usage";

// TUC-3006 acceptance: every daemon request the plugin makes is counted per caller and request
// kind, so the hourly log line says which loop spends the daemon's time.

class Client {
  #requests = 0;
  async fetchAgents(_input: { filter?: { includeArchived?: boolean } }) { this.#requests++; return { entries: [], requests: this.#requests }; }
  async fetchWorkspaces() { return { entries: [] }; }
}

function api() {
  const refreshes: string[] = [];
  return {
    refreshes,
    host: "server087",
    agents: {
      list: async (_input?: { filter?: { includeArchived?: boolean } }) => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({ id, refresh: async () => { refreshes.push(id); return { id }; } }),
      subscribe: (_handler: () => void) => () => {},
    },
    workspaces: { list: async () => ({ entries: [] }) },
  };
}

test("each daemon request is counted under the asCaller name and its request kind; archived listings are their own kind", async () => {
  const usage = new DaemonUsage();
  const paseo = usage.meter(api());
  await asCaller("plan-pipeline", async () => {
    await paseo.agents.list({ filter: { includeArchived: true } });
    await paseo.agents.list({ filter: { includeArchived: true } });
    await paseo.agents.list({});
  });
  await asCaller("watchdog", () => paseo.agents.ref("a1").refresh());
  await paseo.workspaces.list();

  const window = usage.drain();
  assert.equal(window.total, 5);
  assert.deepEqual(window.byCaller, {
    "plan-pipeline": { "agents.list[archived]": 2, "agents.list": 1 },
    watchdog: { "agents.ref().refresh": 1 },
    unattributed: { "workspaces.list": 1 },
  });
});

test("synchronous calls make no request and are not counted; what they return is still metered", async () => {
  const usage = new DaemonUsage();
  const raw = api();
  const paseo = usage.meter(raw);
  const ref = paseo.agents.ref("a1");
  const unsubscribe = paseo.agents.subscribe(() => {});
  unsubscribe();
  assert.equal(paseo.host, "server087", "plain values pass through");
  assert.equal(usage.drain().total, 0);
  assert.deepEqual(await ref.refresh(), { id: "a1" });
  assert.deepEqual(raw.refreshes, ["a1"], "the call reaches the real target");
  assert.deepEqual(usage.drain().byCaller, { unattributed: { "agents.ref().refresh": 1 } });
});

test("a failed request is still a request", async () => {
  const usage = new DaemonUsage();
  const paseo = usage.meter({ agents: { list: async () => { throw new Error("daemon unavailable"); } } });
  await assert.rejects(asCaller("relay", () => paseo.agents.list()), /daemon unavailable/);
  assert.deepEqual(usage.drain().byCaller, { relay: { "agents.list": 1 } });
});

test("the internal daemon client keeps working through the meter, private fields included", async () => {
  const usage = new DaemonUsage();
  const client = usage.meter(new Client());
  await asCaller("state-labels", async () => {
    assert.equal((await client.fetchAgents({ filter: { includeArchived: true } })).requests, 1);
    assert.equal((await client.fetchAgents({})).requests, 2);
    await client.fetchWorkspaces();
  });
  assert.deepEqual(usage.drain().byCaller, { "state-labels": { "fetchAgents[archived]": 1, fetchAgents: 1, fetchWorkspaces: 1 } });
});

test("metering the same source twice returns the same object, so identity checks on it still hold", () => {
  const usage = new DaemonUsage();
  const raw = api();
  assert.equal(usage.meter(raw), usage.meter(raw));
  assert.equal(usage.meter(raw).agents, usage.meter(raw).agents);
});

test("metering an already metered source returns it unchanged, so each request is counted once", async () => {
  const usage = new DaemonUsage();
  const once = usage.meter(api());
  const twice = usage.meter(once);
  assert.equal(twice, once);
  await asCaller("plan-pipeline", () => twice.agents.list({ filter: { includeArchived: true } }));
  assert.deepEqual(usage.drain().byCaller, { "plan-pipeline": { "agents.list[archived]": 1 } });
});

test("drain returns the counts since the previous drain and starts a new window", async () => {
  let now = 1_000;
  const usage = new DaemonUsage({ now: () => now });
  const paseo = usage.meter(api());
  await paseo.agents.list();
  now = 61_000;
  const first = usage.drain();
  assert.equal(first.total, 1);
  assert.equal(first.untilMs - first.sinceMs, 60_000);
  await paseo.agents.list();
  await paseo.agents.list();
  now = 121_000;
  const second = usage.drain();
  assert.equal(second.total, 2);
  assert.equal(second.sinceMs, 61_000);
  assert.equal(usage.drain().total, 0);
});
