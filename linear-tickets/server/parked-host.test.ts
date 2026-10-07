import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { locateHost, parkedPaths, PlannotatorHost, type ParkedPlan } from "./parked";

// The central host for real (Bun, plannotator-host-source.ts), with a stand-in for Plannotator's
// plan server: it binds PLANNOTATOR_PORT as Plannotator does, answers GET with its plan and the
// serving process, and takes a decision on POST /decide.
const PLAN_SERVER = String.raw`import { createServer } from "node:http";
export async function startPlanReviewServer(options) {
  const listeners = [];
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { for (const listener of listeners) listener(JSON.parse(body)); res.end("{}"); });
      return;
    }
    res.end(JSON.stringify({ plan: options.plan, pid: process.pid }));
  });
  const port = Number(process.env.PLANNOTATOR_PORT || 0);
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(error.code === "EADDRINUSE" ? new Error("Port " + port + " in use after 5 retries") : error));
    server.listen(port, "127.0.0.1", resolve);
  });
  const bound = server.address().port;
  return { url: "http://localhost:" + bound, port: bound, onDecision: (listener) => listeners.push(listener), stop: () => server.close() };
}
`;

const TIMINGS = { monitorMs: 200, staleMs: 1_500, startupMs: 4_000 };
// A range of its own per test run, away from the hosts' default 28600-28699.
const FIRST_PORT = 31_000 + (process.pid % 500) * 20;

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function setup(t: TestContext, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "paseo-parked-host-"));
  const plannotator = join(home, "plannotator-package");
  await mkdir(join(plannotator, "server"), { recursive: true });
  await writeFile(join(plannotator, "server", "serverPlan.ts"), PLAN_SERVER);
  await writeFile(join(plannotator, "plannotator.html"), "<html></html>");
  const saved = { ...process.env };
  Object.assign(process.env, { LINEAR_TICKETS_PLANNOTATOR_PACKAGE: plannotator, LINEAR_TICKETS_PARKED_SWEEP_MS: "100", LINEAR_TICKETS_PLANNOTATOR_PORT_RANGE: `${FIRST_PORT}-${FIRST_PORT + 9}`, ...env });
  // Bun from this machine; Plannotator is the stand-in above.
  const found = locateHost();
  const paths = parkedPaths(home);
  await mkdir(paths.parked, { recursive: true });
  // The PLANNOTATOR_BROWSER hook: one line per review opened, "<url> <agent>".
  const openedLog = join(home, "opened.txt");
  await writeFile(paths.open, `#!/bin/sh\necho "$1 $PASEO_AGENT_ID" >> "${openedLog}"\n`);
  await chmod(paths.open, 0o755);
  const hostPid = async () => {
    const state: unknown = JSON.parse(await readFile(paths.state, "utf8"));
    return state && typeof state === "object" && "pid" in state && typeof state.pid === "number" ? state.pid : 0;
  };
  const hosts: PlannotatorHost[] = [];
  const host = () => {
    const created = new PlannotatorHost(paths, () => found, TIMINGS);
    hosts.push(created);
    return created;
  };
  t.after(async () => {
    process.env = saved;
    for (const created of hosts) created.stop();
    try { process.kill(await hostPid(), "SIGKILL"); } catch { /* already gone */ }
    await rm(home, { recursive: true, force: true });
  });
  const park = (issueId: string, agentId: string) => writeFile(join(paths.parked, `${issueId}.json`), JSON.stringify({ issueId, identifier: issueId.toUpperCase(), agentId, plan: `# Plan ${issueId}`, line: "", reasons: [], model: null, parkedAt: new Date().toISOString(), announced: true } satisfies ParkedPlan));
  const opened = async () => (await readFile(openedLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => { const [url, agentId] = line.split(" "); return { url, agentId }; });
  const answer = async (url: string) => {
    try { return await (await fetch(url, { signal: AbortSignal.timeout(1_000) })).json() as { plan: string; pid: number }; } catch { return null; }
  };
  return { found, paths, host, hostPid, park, opened, answer };
}

test("a plugin reload keeps the host and its reviews; a restarted host serves each plan again on its port, except one whose decision is still queued", async (t) => {
  const { found, paths, host, hostPid, park, opened, answer } = await setup(t);
  if (!found) return t.skip("needs Bun");
  await park("issue-a", "agent-a");
  await park("issue-b", "agent-b");
  const first = host();
  await first.start();
  const [a, b] = await until("both reviews", async () => { const all = await opened(); return all.length === 2 && all.sort((x, y) => x.agentId!.localeCompare(y.agentId!)); });
  const pid = await until("the host's heartbeat", () => hostPid().catch(() => 0));
  assert.equal((await answer(a.url!))?.plan, "# Plan issue-a");

  // A reload: the next plugin run adopts the host instead of starting another.
  first.stop();
  const second = host();
  await second.start();
  await sleep(1_000);
  assert.equal(await hostPid(), pid, "the same host keeps serving");
  assert.equal(second.available(), true);
  assert.equal((await opened()).length, 2, "no review was served again");
  assert.deepEqual(await answer(a.url!), { plan: "# Plan issue-a", pid }, "the page's server is the one it loaded from");

  // The owner sends B back; Linear refuses for now, so its event stays queued.
  await fetch(b.url!, { method: "POST", body: JSON.stringify({ approved: false, feedback: "Split step 2" }) });
  const [queued] = await until("the decision event", async () => {
    const names = (await readdir(paths.events).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
    return names.length ? Promise.all(names.map(async (name) => JSON.parse(await readFile(join(paths.events, name), "utf8")))) : null;
  });
  assert.equal(queued.feedback, "Split step 2");

  // The host dies (a crash, the daemon's service stopping it): the plugin starts a new one.
  process.kill(pid, "SIGKILL");
  const restarted = await until("a new host", async () => { const now = await hostPid().catch(() => pid); return now !== pid && now; });
  const again = await until("plan A served again", async () => { const all = await opened(); return all.length > 2 && all.slice(2); });
  assert.deepEqual(again, [{ url: a.url, agentId: "agent-a" }], "A on its old address, B not again while its decision waits");
  assert.deepEqual(await answer(a.url!), { plan: "# Plan issue-a", pid: restarted });
  assert.equal(await answer(b.url!), null);
});

test("a host whose plugin is gone stops by itself", async (t) => {
  const { found, host, hostPid, park, opened } = await setup(t, { LINEAR_TICKETS_PLANNOTATOR_ORPHAN_MS: "1500" });
  if (!found) return t.skip("needs Bun");
  await park("issue-a", "agent-a");
  const plugin = host();
  await plugin.start();
  await until("the review", async () => (await opened()).length === 1);
  const pid = await hostPid();
  await sleep(2_000);
  assert.doesNotThrow(() => process.kill(pid, 0), "the plugin's heartbeat keeps it running");
  plugin.stop();
  await until("the host to exit", async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
});
