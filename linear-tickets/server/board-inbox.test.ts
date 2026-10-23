import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BoardHostFacts, type BoardIssue, type BoardOpenPull, type BoardView } from "../shared/board";
import { BoardInbox } from "./board-inbox";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function facts(host: string, pulls: string[] = []): BoardHostFacts {
  return {
    host, collectedAt: iso(NOW), maxRunning: 5,
    agentCounts: { running: 1, idle: 0, initializing: 0, error: 0, permission: 0 },
    agents: [{ id: `a-${host}`, identifier: host === "server087" ? "T-1" : "T-2", title: "T: x", status: "running", createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 60_000), permission: false, inside: null }],
    steward: null, ownership: null, watchdog: [], plans: { lastArrivalAt: null, rows: [] },
    pulls: pulls.map((url) => ({ url, failed: [], running: 0, drops: 0, drop: null, activeAt: null })),
    flow: { planning: 0, arrived: 0, decided: 0, autoApproved: 0, starts: 0, openedPr: 0, enqueued: 0 },
  };
}
const issue: BoardIssue = { identifier: "T-1", title: "One", url: "https://linear.app/a/issue/T-1", status: "In Progress", statusType: "started", project: null, labels: ["paseo"], startedAt: null, completedAt: null, updatedAt: iso(NOW - 60_000) };

function mockFetch(t: TestContext, answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return answer(url);
  });
  return calls;
}

function harness(overrides: { peers?: string[]; issues?: () => Promise<BoardIssue[]>; pulls?: (repos: string[]) => Promise<BoardOpenPull[]>; facts?: () => Promise<BoardHostFacts> } = {}) {
  let now = NOW;
  const counts = { facts: 0, issues: 0, pulls: 0 };
  const repos: string[][] = [];
  const inbox = new BoardInbox({
    facts: async () => { counts.facts++; return overrides.facts ? overrides.facts() : facts("server087", ["https://github.com/acme/app/pull/1", "https://github.com/acme/lib/pull/2", "https://github.com/acme/app/pull/3"]); },
    peers: async () => overrides.peers ?? [],
    issues: async () => { counts.issues++; return overrides.issues ? overrides.issues() : [issue]; },
    pulls: async (wanted) => { counts.pulls++; repos.push(wanted); return overrides.pulls ? overrides.pulls(wanted) : []; },
    now: () => now,
  });
  const get = async (path: string, method = "GET") => {
    const answer = await inbox.route({ method, path, headers: { host: "laptop.test:8444" }, body: "" });
    return answer && { ...answer, json: () => JSON.parse(answer.body) as unknown };
  };
  return { inbox, get, counts, repos, advance: (ms: number) => { now += ms; } };
}

test("other paths are not the board's", async () => {
  const h = harness();
  assert.equal(await h.get("/api/decisions"), null);
  assert.equal(await h.get("/board"), null);
});

test("/api/board/local answers this host's facts", async () => {
  const h = harness();
  const answer = await h.get("/api/board/local");
  assert.equal(answer?.status, 200);
  assert.equal((answer?.json() as BoardHostFacts).host, "server087");
  assert.equal((await h.get("/api/board/local", "POST"))?.status, 405);
});

test("/api/board joins this host, its reachable peers, Linear and GitHub, and names unreachable peers", async (t) => {
  const calls = mockFetch(t, (url) => url.startsWith("https://mbp.example:8444/")
    ? Response.json(facts("mbp"))
    : new Response("down", { status: 502 }));
  const h = harness({ peers: ["https://mbp.example:8444", "https://down.example:8444/"] });
  const answer = await h.get("/api/board");
  assert.equal(answer?.status, 200);
  assert.deepEqual(calls.sort(), ["https://down.example:8444/api/board/local", "https://mbp.example:8444/api/board/local"]);
  const view = answer?.json() as BoardView;
  assert.deepEqual(view.hosts.map((host) => host.key), ["server087", "mbp"]);
  assert.deepEqual(view.unreachable, ["https://down.example:8444"]);
  assert.deepEqual(view.rows.map((row) => [row.id, row.title, row.hosts]), [["T-1", "One", ["server087"]], ["T-2", "x", ["mbp"]]]);
  assert.deepEqual(h.repos, [["acme/app", "acme/lib"]]);
  assert.deepEqual(view.sources, [["Linear", iso(NOW)], ["GitHub", iso(NOW)]]);
});

test("a peer answering malformed facts counts as unreachable", async (t) => {
  mockFetch(t, () => Response.json({ host: "mbp", agents: "nope" }));
  const h = harness({ peers: ["https://mbp.example:8444"] });
  const view = (await h.get("/api/board"))?.json() as BoardView;
  assert.deepEqual(view.unreachable, ["https://mbp.example:8444"]);
  assert.deepEqual(view.hosts.map((host) => host.key), ["server087"]);
});

test("Linear and GitHub failures leave the board up without them", async () => {
  const h = harness({ issues: async () => { throw new Error("rate limited"); }, pulls: async () => { throw new Error("gh missing"); } });
  const answer = await h.get("/api/board");
  assert.equal(answer?.status, 200);
  const view = answer?.json() as BoardView;
  assert.deepEqual(view.sources, [["Linear", null], ["GitHub", null]]);
  assert.deepEqual(view.rows.map((row) => row.id), ["T-1"]);
});

test("Linear and GitHub are read at most every two minutes, the local facts at most every 30 seconds", async () => {
  const h = harness();
  await h.get("/api/board");
  await h.get("/api/board");
  await h.get("/api/board/local");
  assert.deepEqual(h.counts, { facts: 1, issues: 1, pulls: 1 });
  h.advance(31_000);
  await h.get("/api/board");
  assert.deepEqual(h.counts, { facts: 2, issues: 1, pulls: 1 });
  h.advance(90_000);
  await h.get("/api/board");
  assert.deepEqual(h.counts, { facts: 3, issues: 2, pulls: 2 });
});

test("concurrent reads share one collection", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); // lib is ES2023: no Promise.withResolvers
  const h = harness({ facts: async () => { await gate; return facts("server087"); } });
  const reads = [h.get("/api/board"), h.get("/api/board/local"), h.get("/api/board")];
  release();
  const answers = await Promise.all(reads);
  assert.deepEqual(answers.map((answer) => answer?.status), [200, 200, 200]);
  assert.equal(h.counts.facts, 1);
  assert.equal(h.counts.issues, 1);
});

test("a slow collection is answered with the previous reading for up to five minutes, then waited for", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); // lib is ES2023: no Promise.withResolvers
  let reads = 0;
  const h = harness({ facts: async () => { reads++; if (reads === 1) return facts("before"); await gate; return facts("after"); } });
  const host = async () => { const answer = await h.get("/api/board/local"); return answer && BoardHostFacts.parse(answer.json()).host; };
  assert.equal(await host(), "before");
  h.advance(31_000);
  assert.equal(await host(), "before");
  assert.equal(await host(), "before");
  assert.equal(h.counts.facts, 2);
  h.advance(5 * 60_000);
  const waiting = host();
  release();
  assert.equal(await waiting, "after");
  assert.equal(h.counts.facts, 2);
});

test("this host's facts failing is a 503 with the reason", async () => {
  const h = harness({ facts: async () => { throw new Error("Paseo daemon unavailable"); } });
  const answer = await h.get("/api/board");
  assert.equal(answer?.status, 503);
  assert.match(answer?.body ?? "", /Paseo daemon unavailable/);
  assert.equal((await h.get("/api/board/local"))?.status, 503);
});
