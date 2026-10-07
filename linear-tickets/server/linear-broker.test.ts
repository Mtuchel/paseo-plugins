import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LinearBroker, type BrokerReply, type BrokerOptions } from "./linear-broker";
import { RateBudget } from "./rate-budget";
import { LinearUsage } from "./linear-usage";

const HOUR = 3_600_000;
function headers(remaining = 1_000_000): Headers {
  return new Headers({ "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "4500",
    "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": String(remaining), "x-complexity": "1" });
}
function call(socketPath: string, authorization = "Bearer app", extra: Record<string, unknown> = {}): Promise<BrokerReply> {
  return new Promise((resolve, reject) => {
    const client = request({ socketPath, path: "/graphql", method: "POST" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    client.on("error", reject);
    client.end(JSON.stringify({ authorization, query: "query ticket { viewer { id } }", variables: {}, tool: "get_issue", ...extra }));
  });
}
async function fixture(t: TestContext, options: BrokerOptions = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), "linear-broker-"));
  const time = { now: 1_800_000_000_000 };
  const usage = options.usage ?? new LinearUsage(() => time.now, { path: join(home, "usage.json") });
  const budget = options.budget ?? new RateBudget(() => time.now, usage);
  const calls: string[] = [];
  const broker = new LinearBroker({ home, now: () => time.now, budget, usage,
    upstream: async (_authorization, query) => { calls.push(query); return Response.json({ data: { viewer: { id: "owner" } } }, { headers: headers() }); }, ...options });
  t.after(async () => { await broker.stop(); await rm(home, { recursive: true, force: true }); });
  await broker.start();
  return { home, time, usage, budget, broker, calls };
}

test("app/key MCP reads and writes stop at three percent while owner decisions pass", async (t) => {
  const { broker, budget, usage, calls } = await fixture(t);
  for (const authorization of ["Bearer app", "key"]) {
    const pool = authorization.startsWith("Bearer") ? "app" : "key";
    budget.acquire(pool, "owner").done(headers(60_000), false);
    for (const tool of ["get_issue", "add_comment"]) {
      const result = await call(broker.socketPath, authorization, { tool });
      assert.equal(result.kind, "held");
    }
    const owner = budget.acquire(pool, "owner", "owner decision", "issueUpdate");
    owner.done(headers(59_999), false);
    assert.equal(usage.snapshot().rows.find((row) => row.pool === pool && row.caller === "owner decision")!.requests, 1);
  }
  assert.deepEqual(calls, []);
  assert.equal(usage.snapshot().rows.some((row) => row.caller.startsWith("mcp:")), false);
});

test("cold app and idle key share one discovery per pool before any concurrent tool queries", async (t) => {
  const { broker, usage, calls } = await fixture(t);
  for (const authorization of ["Bearer app", "key"]) {
    const replies = await Promise.all(Array.from({ length: 4 }, () => call(broker.socketPath, authorization)));
    assert.ok(replies.every((reply) => reply.kind === "answer"));
  }
  assert.equal(calls.filter((query) => query.includes("McpBudgetProbe")).length, 2);
  assert.equal(calls.length, 10);
  for (const pool of ["app", "key"]) {
    assert.equal(usage.snapshot().rows.find((row) => row.pool === pool && row.caller === "mcp:budget-probe")!.requests, 1);
    assert.equal(usage.snapshot().rows.find((row) => row.pool === pool && row.caller === "mcp:get_issue")!.requests, 4);
  }
});

test("clients cannot select owner priority, caller, cost or upstream", async (t) => {
  const { broker, calls } = await fixture(t);
  for (const extra of [{ priority: "owner" }, { caller: "owner" }, { points: 0 }, { upstream: "http://elsewhere" }, { tool: "__proto__" }]) {
    assert.equal((await call(broker.socketPath, "key", extra)).kind, "unsent");
  }
  assert.deepEqual(calls, []);
});

test("a live socket is not unlinked and the original broker remains usable", async (t) => {
  const { broker, home } = await fixture(t);
  const duplicate = new LinearBroker({ home });
  await assert.rejects(duplicate.start(), /already listening/);
  await duplicate.stop();
  assert.equal((await call(broker.socketPath)).kind, "answer");
  assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
});

test("journal persistence failure cancels unsent admission without usage or leaked reservation", async (t) => {
  const { broker, home, budget, usage, calls } = await fixture(t);
  budget.acquire("app", "owner").done(headers(110_000), false);
  await mkdir(join(home, "linear-tickets", "linear-broker-journal.json"));
  const before = usage.snapshot();
  assert.equal((await call(broker.socketPath)).kind, "unsent");
  assert.deepEqual(calls, []);
  assert.deepEqual(usage.snapshot(), before);
  assert.equal(budget.estimate("app", "points"), 110_000);
});

test("recovered debt survives fence expiry, headers and a second restart without invented usage", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "linear-debt-"));
  await mkdir(join(home, "linear-tickets"), { mode: 0o700 });
  const fenceUntil = 1_800_000_000_000 + HOUR;
  const marker = { id: "pending", pool: "app", sentAt: fenceUntil - HOUR, requests: 1, points: 10_000, fenceUntil };
  await writeFile(join(home, "linear-tickets", "linear-broker-journal.json"), JSON.stringify({ version: 1, intents: [marker] }), { mode: 0o600 });
  const first = await fixture(t, { home });
  first.budget.acquire("app", "owner").done(headers(110_000), false);
  assert.equal((await call(first.broker.socketPath)).kind, "held");
  await first.broker.stop();
  const second = await fixture(t, { home });
  second.time.now = fenceUntil + 1;
  second.budget.acquire("app", "owner").done(headers(110_000), false);
  assert.equal(second.budget.estimate("app", "points"), 100_000);
  assert.equal((await call(second.broker.socketPath)).kind, "held");
  assert.deepEqual(second.calls, []);
  assert.equal(second.usage.snapshot().rows.some((row) => row.caller.startsWith("mcp:")), false);
  const persisted = JSON.parse(await readFile(join(home, "linear-tickets", "linear-broker-journal.json"), "utf8"));
  assert.equal(persisted.intents[0].fenceUntil, fenceUntil);
  second.budget.acquire("app", "owner").done(headers(120_000), false);
  assert.equal((await call(second.broker.socketPath)).kind, "answer");
});

test("unknown outcomes retain debt and a definitive late answer releases it without recounting", { timeout: 5_000 }, async (t) => {
  let finish!: (response: Response) => void;
  // This integration case exercises the platform's upstream/socket deadline, not the budget clock.
  const { broker, budget, usage, home } = await fixture(t, { deadlineMs: 20,
    upstream: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  budget.acquire("app", "owner").done(headers(120_000), false);
  assert.equal((await call(broker.socketPath)).kind, "unknown");
  assert.equal((await call(broker.socketPath)).kind, "held");
  const row = usage.snapshot().rows.find((entry) => entry.caller === "mcp:get_issue")!;
  assert.equal(row.requests, 1); assert.equal(row.unmetered, 1);
  assert.equal(budget.estimate("app", "points"), 110_000);
  // Observe real settlement after durable fsync, without polling or delaying the test.
  const settled = new Promise<void>((resolve) => {
    const releaseDebt = budget.releaseDebt.bind(budget);
    t.mock.method(budget, "releaseDebt", (...args: Parameters<RateBudget["releaseDebt"]>) => {
      releaseDebt(...args);
      resolve();
    });
  });
  finish(Response.json({ data: {} }, { headers: headers(119_999) }));
  await settled;
  const journal = JSON.parse(await readFile(join(home, "linear-tickets", "linear-broker-journal.json"), "utf8"));
  assert.deepEqual(journal.intents, []);
  assert.equal(budget.estimate("app", "points"), 119_999);
  assert.equal(usage.snapshot().rows.find((entry) => entry.caller === "mcp:get_issue")!.requests, 1);
});

test("a stopped broker's late answer never rewrites the next broker's journal", async (t) => {
  let finish!: (response: Response) => void;
  const first = await fixture(t, { deadlineMs: 20, upstream: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  first.budget.acquire("app", "owner").done(headers(120_000), false);
  assert.equal((await call(first.broker.socketPath)).kind, "unknown");
  await first.broker.stop();
  const second = await fixture(t, { home: first.home });
  const path = join(first.home, "linear-tickets", "linear-broker-journal.json");
  const recovered = await readFile(path, "utf8");
  assert.equal(JSON.parse(recovered).intents.length, 1);
  finish(Response.json({ data: {} }, { headers: headers(119_999) }));
  // The old handler's write takes several fsyncs; stop observing as soon as anything changes.
  for (let turn = 0; turn < 50 && await readFile(path, "utf8") === recovered; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(await readFile(path, "utf8"), recovered, "only the current broker may settle the recovered debt");
});

test("corrupt recovery state fails closed instead of using elapsed time to discard debt", async (t) => {
  const { broker, home } = await fixture(t);
  await broker.stop();
  await writeFile(join(home, "linear-tickets", "linear-broker-journal.json"), "corrupt", { mode: 0o600 });
  const recovered = await fixture(t, { home });
  recovered.time.now += 2 * HOUR;
  assert.equal((await call(recovered.broker.socketPath)).kind, "unsent");
  assert.deepEqual(recovered.calls, []);
});
