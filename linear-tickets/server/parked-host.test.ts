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
  await mkdir(paths.decisions, { recursive: true });
  await mkdir(paths.events, { recursive: true });
  // The PLANNOTATOR_BROWSER hook, run by this machine's runtime: it records the `opened` event the
  // real hook records, for the review URL Plannotator opened. Its time is the hook's open time,
  // which must not precede the review's `servedAt`.
  const hook = join(home, "opened-hook.mjs");
  await writeFile(hook, `import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const events = ${JSON.stringify(paths.events)};
mkdirSync(events, { recursive: true, mode: 0o700 });
const name = Date.now() + "-" + randomUUID() + ".json";
writeFileSync(join(events, "." + name + ".tmp"), JSON.stringify({ type: "opened", agentId: process.env.PASEO_AGENT_ID ?? null, localUrl: process.argv[2], remoteUrl: null, at: new Date().toISOString() }), { mode: 0o600 });
renameSync(join(events, "." + name + ".tmp"), join(events, name));
`);
  await writeFile(paths.open, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} "$1"\n`);
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
  const park = async (issueId: string, agentId: string) => {
    const plan: ParkedPlan = { issueId, identifier: issueId.toUpperCase(), agentId, plan: `# Plan ${issueId}`, line: "", reasons: [], model: null, parkedAt: new Date().toISOString(), announced: true };
    await writeFile(join(paths.parked, `${issueId}.json`), JSON.stringify(plan));
    return plan;
  };
  // The event directory as the plugin reads it: `opened` events from the hook, `decided` ones from
  // the host.
  const events = async () => {
    const names = (await readdir(paths.events).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
    const parsed: Record<string, unknown>[] = [];
    for (const name of names) {
      try { parsed.push(JSON.parse(await readFile(join(paths.events, name), "utf8")) as Record<string, unknown>); } catch { /* half-written */ }
    }
    return parsed;
  };
  const opened = async () => (await events()).filter((event) => event.type === "opened").map((event) => ({ url: String(event.localUrl), agentId: String(event.agentId), at: String(event.at) }));
  const decided = async () => (await events()).filter((event) => event.type === "decided");
  // One decision journal entry (decision-journal.ts); the host reads the directory each sweep.
  const journal = async (file: string, entry: Record<string, unknown>) => writeFile(join(paths.decisions, file), JSON.stringify(entry, null, 2));
  const answer = async (url: string) => {
    try { return await (await fetch(url, { signal: AbortSignal.timeout(1_000) })).json() as { plan: string; pid: number }; } catch { return null; }
  };
  return { found, paths, host, hostPid, park, opened, decided, journal, answer };
}

test("a plugin reload keeps the host and its reviews; a restarted host serves each plan again on its port, except one whose decision is still queued", async (t) => {
  const { found, host, hostPid, park, opened, decided, answer } = await setup(t);
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
    const all = await decided();
    return all.length ? all : null;
  });
  assert.equal(queued.feedback, "Split step 2");
  // The event names the review generation it was taken on, opened between servedAt and its being
  // recorded (the plugin binds the decision to exactly that generation).
  const review = queued.review as { localUrl?: string; servedAt?: string };
  assert.equal(review.localUrl, b.url, "the review is the address Plannotator served");
  assert.ok(Date.parse(review.servedAt!) <= Date.parse(b.at), `servedAt ${review.servedAt} is at or before the hook's opened time ${b.at}`);

  // The host dies (a crash, the daemon's service stopping it): the plugin starts a new one.
  process.kill(pid, "SIGKILL");
  const restarted = await until("a new host", async () => { const now = await hostPid().catch(() => pid); return now !== pid && now; });
  const again = await until("plan A served again", async () => { const all = await opened(); return all.length > 2 && all.slice(2); });
  assert.deepEqual(again.map(({ url, agentId }) => ({ url, agentId })), [{ url: a.url, agentId: "agent-a" }], "A on its old address, B not again while its decision waits");
  assert.deepEqual(await answer(a.url!), { plan: "# Plan issue-a", pid: restarted });
  assert.equal(await answer(b.url!), null);
});

test("a plan whose decision is not settled in the journal is not served, on a fresh host too; a void or resolved entry serves it again without a restart", async (t) => {
  const { found, paths, host, hostPid, park, opened, journal } = await setup(t);
  if (!found) return t.skip("needs Bun");
  const [pending, unbound, conflict, deciding] = await Promise.all([park("issue-p", "agent-p"), park("issue-u", "agent-u"), park("issue-c", "agent-c"), park("issue-v", "agent-v")]);
  await park("issue-ok", "agent-ok");
  // A decided event the host did not take itself (the Linear panel, the risk policy), written
  // before the host starts: it holds the plan back, but only while the file stays queued.
  const queued = await park("issue-q", "agent-q");
  const queuedEvent = join(paths.events, "1-decided-q.json");
  await writeFile(queuedEvent, JSON.stringify({ type: "decided", parked: true, agentId: "agent-q", approved: true, planContent: "# Plan issue-q", at: queued.parkedAt }));
  // One entry per blocking shape, bound to this plan's review (opened while it was parked).
  const attempt = (agentId: string, state: string, reviewOpenedAt: string) => ({ kind: "attempt", id: `attempt-${agentId}`, reviewId: `review-${agentId}`, reviewOpenedAt, at: reviewOpenedAt, agentId, planHash: "plan-hash", planContent: "# Plan", approved: true, transport: true, mode: "approve", source: "parked-page", state, reports: [], steps: {}, attempts: 0 });
  const unboundEntry = (state: string) => ({ kind: "unbound", id: "unbound-u", agentId: "agent-u", at: unbound.parkedAt, approved: true, planContent: "# Plan", event: "1-opened.json", state, ...(state === "open" ? {} : { resolvedAt: new Date().toISOString() }) });
  const conflictEntry = (resolution?: string) => ({ kind: "conflict", id: "conflict-c", reviewId: "review-c", reviewOpenedAt: conflict.parkedAt, agentId: "agent-c", attemptId: null, closingId: null, afterApply: false, reportOutcome: true, report: { event: "2-opened.json", at: conflict.parkedAt }, at: conflict.parkedAt, ...(resolution ? { resolution, resolvedAt: new Date().toISOString() } : {}) });
  await journal("attempt-p.json", attempt("agent-p", "pending", pending.parkedAt));
  await journal("unbound-u.json", unboundEntry("open"));
  await journal("conflict-c.json", conflictEntry());
  await journal("attempt-v.json", attempt("agent-v", "deciding", deciding.parkedAt));

  const first = host();
  await first.start();
  await until("the plan without a journal entry to be served", async () => (await opened()).some((event) => event.agentId === "agent-ok"));
  const blocked = async (why: string) => {
    const all = await opened();
    for (const agent of ["agent-p", "agent-u", "agent-c", "agent-v"]) assert.ok(!all.some((event) => event.agentId === agent), `${agent} is not served ${why}`);
  };
  await sleep(800);
  await blocked("while its decision is in the journal");

  // A host restart (a crash) re-reads the journal: the plans stay unserved; the check was never a
  // sticky marker of the old host.
  const pid = await until("the host's heartbeat", () => hostPid().catch(() => 0));
  process.kill(pid, "SIGKILL");
  const restarted = await until("a new host", async () => { const now = await hostPid().catch(() => pid); return now !== pid && now; });
  await until("the undecided plan served again", async () => (await opened()).filter((event) => event.agentId === "agent-ok").length >= 2);
  await sleep(800);
  await blocked("on the restarted host");

  // Settled entries — a void attempt, a carried unbound report and a resolved conflict — serve
  // their plans again on the running host, no restart.
  await journal("attempt-p.json", { ...attempt("agent-p", "void", pending.parkedAt), voidReason: "Dropped by the owner." });
  await journal("unbound-u.json", unboundEntry("carried"));
  await journal("conflict-c.json", conflictEntry("keep"));
  await journal("attempt-v.json", { ...attempt("agent-v", "void", deciding.parkedAt), voidReason: "Plannotator refused the decision." });
  await until("the settled plans served", async () => {
    const all = await opened();
    return ["agent-p", "agent-u", "agent-c", "agent-v"].every((agent) => all.some((event) => event.agentId === agent));
  });
  // Removing the handed-on event file serves its plan on the same host: the queue was consulted
  // afresh every sweep, never turned into a sticky marker.
  assert.ok(!(await opened()).some((event) => event.agentId === "agent-q"), "a queued decided event holds its plan back");
  await rm(queuedEvent, { force: true });
  await until("the plan with the handed-on event served", async () => (await opened()).some((event) => event.agentId === "agent-q"));
  assert.equal(await hostPid(), restarted, "the same host serves them after the entries settled");
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
