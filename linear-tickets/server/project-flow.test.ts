import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { LinearApiError, LinearRefusedError, type ProjectIssue, type TeamIssue, type TicketRef } from "./linear";
import { Capacity } from "./capacity";
import { SetupError, type PlannerStart } from "./launch";
import type { ProcessInspector } from "./process-liveness";
import { orderProblems, parseOrder, plannerBrief, ProjectFlow, ProjectStore, type PlannerRecord, type ProjectRecord } from "./project-flow";
import { Scheduler } from "./scheduler";
import { DEFAULT_ACTIVATION, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { type UsageReport } from "./limit-resume";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";

const OWNER = "owner-1";
const APP = "paseo-app";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type Agent = { id: string; status: string; labels: Record<string, string>; provider?: string; model?: string; lastError?: string; createdAt?: string; cwd?: string; updatedAt?: string; persistence?: { provider: string; sessionId: string; nativeHandle: string } };
// Paseo listing the agents of whatever label the caller filters on (a ticket's `linear.issueId`, a
// run's `linear.plannerRun`), and recording the agents archived through it.
const paseoWith = (agents: () => Agent[], archived: string[] = []) => ({ agents: {
  list: async ({ filter }: { filter: { labels: Record<string, string> } }) => {
    const [key, value] = Object.entries(filter.labels)[0] ?? [];
    return { entries: agents().filter((agent) => key !== undefined && agent.labels[key] === value).map((agent) => ({ agent })), pageInfo: { hasMore: false } };
  },
  ref: (id: string) => ({ archive: async () => { archived.push(id); }, refresh: async () => ({ agent: agents().find((agent) => agent.id === id) ?? null }) }),
} }) as unknown as PaseoApi;
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp",
  launchPreferences: { omp: { model: "anthropic/claude-opus-5-5", modeId: "full" } }, projectMappings: {}, agentLinearAccess: false,
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["TUC"], maxRunning: 2 }, writeback: DEFAULT_WRITEBACK,
  watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [],
  activation: DEFAULT_ACTIVATION, deputy: DEFAULT_DEPUTY,
};

const issue = (n: number, change: Partial<ProjectIssue> = {}): ProjectIssue => ({
  id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, priority: 3, createdAt: `2026-01-01T00:00:0${n}Z`, status: "Todo", statusType: "unstarted",
  teamId: "t1", teamKey: "TUC", creatorId: OWNER, assigneeId: null, delegateId: null, labels: [], parentId: null, blockers: [], blocks: [], linked: [], ...change,
});

// `inspect`: the provider process table ghost agents are checked against.
async function room(t: TestContext, issues: ProjectIssue[], running: string[] = [], inspect?: ProcessInspector, readSettings?: () => Promise<PluginSettings>) {
  const directory = await mkdtemp(join(tmpdir(), "project-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const reads: string[] = [];
  let now = Date.parse("2026-01-02T00:00:00Z");
  let created = 0;
  let away = false;
  let labelled = true;
  // Linear writes that fail (`update`: the next n project updates; one relation refused or never
  // reaching Linear); `start`: how a planner start fails (`setup`: a SetupError, `always`: a
  // timeout); `restart`: every stalled-ticket restart. `starts`: every planner start, in order.
  const fail: { read?: boolean; update?: number; relation?: string; unreached?: string; restart?: boolean; retire?: boolean; start?: "setup" | "always"; startError?: string } = {};
  const starts: PlannerStart[] = [];
  const comments: string[] = [];
  const updates: string[] = [];
  const notificationAttempts: string[] = [];
  let gate: Promise<void> | null = null;
  let starting = false;
  const outage = () => new LinearApiError("The Linear API request failed (HTTP 503). Try again.", 503);
  const descriptions = new Map<string, string>();
  const team: TeamIssue[] = [];
  const elsewhere = new Map<string, TicketRef>();
  // Blocking relations written by the flow: a full read shows them on the blocked ticket; a
  // changed-only read (the host's cache) may not yet.
  const written: [string, string][] = [];
  let cachedRelations = 0;
  let readGate: Promise<void> | null = null;
  let reading = false;
  const projectIssues = async (_projectId: string, full: boolean) => {
    reads.push("projectIssues");
    if (fail.read) throw outage();
    if (full) { reading = true; await readGate; cachedRelations = written.length; }
    return issues.map((item) => {
      const added = written.slice(0, cachedRelations).filter(([blocker, blocked]) => blocked === item.id && !item.blockers.some((known) => known.id === blocker));
      return added.length ? { ...item, blockers: [...item.blockers, ...added.map(([id]) => ({ id, identifier: issues.find((other) => other.id === id)?.identifier ?? id, status: "Todo", statusType: "unstarted", delegateId: null, finished: false }))] } : item;
    });
  };
  const linear = {
    labeledProjects: async () => { reads.push("labeledProjects"); if (fail.read) throw outage(); return labelled ? [{ id: "erp", name: "ERP" }] : []; },
    projectIssues: async () => { reads.push("projectIssues"); if (fail.read) throw outage(); return issues; },
    issueDescriptions: async () => { reads.push("issueDescriptions"); if (fail.read) throw outage(); return descriptions; },
    openTeamIssues: async (_teams: string[], limit: number) => { reads.push("openTeamIssues"); if (fail.read) throw outage(); return team.slice(0, limit); },
    issueRef: async (identifier: string) => { reads.push("issueRef"); if (fail.read) throw outage(); return elsewhere.get(identifier) ?? null; },
    relate: async (id: string, other: string, type: string) => { calls.push(`${id} ${type} ${other}`); },
    addLabel: async (id: string, name: string) => { calls.push(`label ${id} +${name}`); },
    removeLabel: async (id: string, name: string) => { calls.push(`label ${id} -${name}`); },
    delegate: async (id: string) => { calls.push(`delegate ${id}`); },
    addBlocker: async (blocker: string, blocked: string) => {
      if (fail.relation === `${blocker} blocks ${blocked}`) throw new LinearRefusedError("Linear refused the relation");
      if (fail.unreached === `${blocker} blocks ${blocked}`) throw outage();
      calls.push(`${blocker} blocks ${blocked}`);
      written.push([blocker, blocked]);
    },
    comment: async (id: string, body: string) => { calls.push(`comment ${id} ${body.split("\n")[0]}`); comments.push(body); },
    projectUpdate: async (id: string, body: string) => {
      notificationAttempts.push(body);
      if (fail.update) { fail.update--; throw new Error("Linear's hourly request limit is reached"); }
      calls.push(`update ${id} ${body.split("\n")[0]}`);
      updates.push(body);
    },
    appUserId: async () => { reads.push("appUserId"); if (fail.read) throw outage(); return APP; },
    viewerId: async () => { reads.push("viewerId"); if (fail.read) throw outage(); return OWNER; },
  };
  const path = join(directory, "projects.json");
  const store = new ProjectStore(path, () => now);
  const scheduler = new Scheduler({ running: async () => running, projectOf: async () => "erp", away: async () => away, now: () => now });
  // Tickets a start under way, or their newest thread, accounts for.
  const held = new Set<string>();
  const usage = { reports: null as UsageReport[] | null, chains: {} as Record<string, string[]>, refresh: true };
  const launchedSelectors: string[] = [];
  const deps = { linear, projectIssues, scheduler, capacity: new Capacity(() => now), store,
    settings: readSettings ? { read: readSettings } : undefined,
    startPlanner: async (input: PlannerStart, _paseo: PaseoApi, current: PluginSettings) => {
      launchedSelectors.push(current.launchPreferences[current.lastProvider!].model);
      starts.push(input);
      calls.push("start run");
      if (fail.start === "setup") throw new SetupError("No Paseo project is mapped to ERP or its team. Open the Paseo plugin settings and map one.");
      starting = true;
      await gate;
      if (fail.start === "always") throw new Error("Agent creation could not be confirmed (Timed out waiting for OMP to become ready).");
      if (fail.startError) throw new Error(fail.startError);
      created++;
      return { agentId: `run-agent-${created}` };
    },
    retire: async (agentId: string) => { calls.push(`retire ${agentId}`); if (fail.retire) throw new Error("retirement unavailable"); },
    now: () => now,
    inspect,
    restart: async (id: string) => {
      calls.push(`restart ${id}`);
      if (fail.restart) throw new Error("Agent creation could not be confirmed (Timed out waiting for OMP to become ready).");
    },
    accountedFor: async (id: string) => held.has(id),
    usage: { chains: async () => usage.chains, read: async () => usage.refresh ? usage.reports?.map((report) => ({ ...report, fetchedAt: now })) ?? null : usage.reports },
    jitter: () => MINUTE };
  const makeFlow = () => new ProjectFlow({ ...deps, store: new ProjectStore(path, () => now) });
  const flow = makeFlow();
  return {
    flow, makeFlow, calls, reads, path, store, issues, fail, comments, updates, starts, descriptions, team, elsewhere, held, usage, launchedSelectors,
    now: () => now,
    notificationAttempts,
    setLabelled: (value: boolean) => { labelled = value; },
    advance: (ms: number) => { now += ms; },
    setAway: (value: boolean) => { away = value; },
    // The project's record as an earlier read left it.
    seed: (record: ProjectRecord) => writeFile(path, JSON.stringify({ erp: record })),
    // Holds the next planner start until `open` runs; `starting` is true once one waits there.
    // Executor form: the plugin's lib is ES2023, without Promise.withResolvers.
    holdStart: () => { let open!: () => void; gate = new Promise((resolve) => { open = resolve; }); return { open, starting: () => starting }; },
    holdFullRead: () => { let open!: () => void; readGate = new Promise((resolve) => { open = resolve; }); return { open, reading: () => reading }; },
  };
}

// The open run an earlier read left, as the next read finds it.
const runRecord = (change: Partial<PlannerRecord> = {}): PlannerRecord => ({ id: "run-1", listedAt: "2026-01-01T23:00:00Z", tickets: 1, started: true, startedAt: "2026-01-01T23:00:00Z", ...change });

test("a forwarding host refuses Plan, replacement Plan, Skip and approved orders before reads or side effects", async (t) => {
  const remote: PluginSettings = { ...settings, activation: { mode: "remote", peer: "https://server087.example:8444" } };
  for (const action of ["plan", "replace", "skip", "apply"] as const) {
    const r = await room(t, [issue(1)]);
    await r.seed({ planned: [], planner: action === "plan" ? null : runRecord({ listed: ["i1"], agentId: "stuck", ownerAsked: true, error: "Needs owner" }) });
    const before = await readFile(r.path, "utf8");
    const archived: string[] = [];
    const agentReads: string[] = [];
    const paseo = paseoWith(() => { agentReads.push("agents"); return [{ id: "stuck", status: "closed", labels: { "linear.projectId": "erp", "linear.plannerRun": "run-1" } }]; }, archived);
    const operation = action === "skip" ? r.flow.skipPlan("erp", remote, paseo)
      : action === "apply" ? r.flow.applyPlan("run-1", "stuck", "```project-order\nhold TUC-1: wait\n```", paseo, remote)
      : r.flow.planNow("erp", remote, paseo, true);
    await assert.rejects(operation, /server087\.example:8444.*use Plan or Skip there/);
    assert.deepEqual(r.reads, [], `${action} must not read Linear`);
    assert.equal(await readFile(r.path, "utf8"), before, `${action} must leave durable state untouched`);
    assert.deepEqual(r.starts, []);
    assert.deepEqual(r.calls, [], `${action} must not write, delegate, restart or retire`);
    assert.deepEqual(r.notificationAttempts, []);
    assert.deepEqual(agentReads, []);
    assert.deepEqual(archived, []);
  }
});

test("a forwarding poll leaves pending, failed and approved planners and planned tickets untouched", async (t) => {
  const remote: PluginSettings = { ...settings, activation: { mode: "remote", peer: null } };
  const planners = [
    null,
    runRecord({ started: false, startedAt: undefined }),
    runRecord({ agentId: "failed" }),
    runRecord({ approved: { agentId: "failed", plan: "```project-order\nhold TUC-2: wait\n```" } }),
  ];
  for (const planner of planners) {
    const r = await room(t, [issue(1), issue(2), issue(3, { delegateId: APP })]);
    await r.seed({ planned: ["i1"], planner, waiting: { i2: "2026-01-01T23:00:00Z" }, stalled: { i3: { since: "2026-01-01T23:00:00Z", restarts: 0 } } });
    const before = await readFile(r.path, "utf8");
    const archived: string[] = [];
    const agentReads: string[] = [];
    const paseo = paseoWith(() => { agentReads.push("agents"); return []; }, archived);
    await r.flow.tick(paseo, remote);
    assert.deepEqual(r.reads, []);
    assert.equal(await readFile(r.path, "utf8"), before);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.starts, []);
    assert.deepEqual(r.notificationAttempts, []);
    assert.deepEqual(agentReads, []);
    assert.deepEqual(archived, []);
    await assert.rejects(r.flow.planNow("erp", remote, paseo), /the peer host.*use Plan or Skip there/);
  }
});

test("manual Plan on the local owner starts a planner with automatic dispatch disabled", async (t) => {
  const r = await room(t, [issue(1)]);
  const manual: PluginSettings = { ...settings, dispatch: { ...settings.dispatch, enabled: false } };
  const status = await r.flow.planNow("erp", manual, paseoWith(() => []));
  assert.equal(status.planner?.agentId, "run-agent-1");
  assert.equal(r.starts.length, 1);
  assert.equal(r.starts[0].runId, status.planner?.runId);
  assert.equal((await r.store.all()).erp.planner?.started, true);
  assert.deepEqual(r.calls, ["start run"]);
});

test("queued background Plan rechecks ownership and leaves its run unattempted when the host switches remote", async (t) => {
  let current = settings;
  let waiting = false;
  let hold = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  async function readSettings(): Promise<PluginSettings> {
    if (hold && (await r.store.all()).erp?.planner) {
      waiting = true;
      await gate;
    }
    return current;
  }
  const r = await room(t, [issue(1)], [], undefined, readSettings);
  const archived: string[] = [];
  const paseo = paseoWith(() => [], archived);
  const status = await r.flow.planNow("erp", settings, paseo, true);
  while (!waiting) await setImmediate();
  const before = await readFile(r.path, "utf8");
  r.reads.length = 0;
  try {
    current = { ...settings, activation: { mode: "remote", peer: "https://server087.example:8444" } };
  } finally { hold = false; release(); }
  // Queued behind the background operation; its stale local snapshot must also be refused.
  await assert.rejects(r.flow.skipPlan("erp", settings, paseo), /server087\.example:8444/);
  assert.equal(await readFile(r.path, "utf8"), before);
  assert.deepEqual(r.reads, []);
  assert.equal(r.starts.length, 0);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(archived, []);
  current = settings;
  await r.flow.tick(paseo, settings);
  assert.equal(r.starts.length, 1, "returning ownership launches the existing unattempted run");
  assert.equal(r.starts[0].runId, status.planner?.runId);
});

test("fresh remote settings reject manual actions, approved orders and polling despite a stale local snapshot", async (t) => {
  const remote: PluginSettings = { ...settings, activation: { mode: "remote", peer: "https://server087.example:8444" } };
  const r = await room(t, [issue(1)], [], undefined, async () => remote);
  await r.seed({ planned: [], planner: runRecord({ ownerAsked: true, agentId: "failed" }) });
  const before = await readFile(r.path, "utf8");
  const paseo = paseoWith(() => []);
  await assert.rejects(r.flow.planNow("erp", settings, paseo, true), /server087\.example:8444/);
  await assert.rejects(r.flow.skipPlan("erp", settings, paseo), /server087\.example:8444/);
  await assert.rejects(r.flow.applyPlan("run-1", "failed", "```project-order\nhold TUC-1: wait\n```", paseo, settings), /server087\.example:8444/);
  await r.flow.tick(paseo, settings);
  assert.equal(await readFile(r.path, "utf8"), before);
  assert.deepEqual(r.reads, []);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.starts, []);
});

test("status exposes persisted owner-held runs after reload without any successful Linear read or notification", async (t) => {
  for (const name of ["ERP", undefined]) {
    const r = await room(t, [issue(1)]);
    await r.seed({ name, planned: [], planner: runRecord({ agentId: "failed", ownerAsked: true, error: "No mapping" }) });
    r.fail.read = true;
    r.fail.update = 1;
    const flow = r.makeFlow();
    const status = (await flow.status())[0];
    assert.equal(status.id, "erp");
    assert.equal(status.name, name ?? "erp");
    assert.equal(status.toPlan, 0);
    assert.equal(status.plansAt, null);
    assert.equal(status.readAt, "2026-01-01T23:00:00Z");
    assert.equal(status.planner?.runId, "run-1");
    assert.equal(status.planner?.ownerAsked, true);
    assert.equal(status.planner?.error, "No mapping");
    assert.deepEqual(r.reads, []);
    assert.deepEqual(r.notificationAttempts, []);
    await assert.rejects(flow.tick(paseoWith(() => []), settings), /HTTP 503/);
    assert.deepEqual(await flow.status(), [status], "an outage must not hide a durable failure");
    await r.store.update("erp", (record) => ({ ...record!, planner: runRecord({ id: "replacement", ownerAsked: false, error: "Usage limit: waiting for reset" }) }));
    assert.deepEqual(await flow.status(), [], "the old held run is not emitted after replacement");
    await r.store.update("erp", (record) => ({ ...record!, planner: null, closedPlanner: "replacement" }));
    assert.deepEqual(await flow.status(), []);
  }
});

test("a failed owner notification cannot hide the named planner failure across reload", async (t) => {
  const r = await room(t, [issue(1)]);
  r.fail.start = "setup";
  r.fail.update = 1;
  await r.flow.planNow("erp", settings, paseoWith(() => []));
  assert.equal((await r.store.all()).erp.name, "ERP");
  assert.equal(r.notificationAttempts.length, 1);
  assert.deepEqual(r.updates, []);
  r.fail.read = true;
  const status = (await r.makeFlow().status())[0];
  assert.equal(status.name, "ERP");
  assert.equal(status.planner?.ownerAsked, true);
  assert.match(status.planner!.error!, /No Paseo project is mapped/);
});

test("an accepted owner-held order awaiting Linear retry no longer requests owner input", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  const order = "```project-order\nTUC-1 blocks TUC-2\n```";
  await r.seed({ name: "ERP", planned: [], planner: runRecord({ listed: ["i1", "i2"], ownerAsked: true, error: "Needs owner" }) });
  await r.flow.tick(paseo, settings);
  r.fail.unreached = "i1 blocks i2";
  await r.flow.applyPlan("run-1", null, order, paseo, settings);
  const pending = (await r.store.all()).erp.planner!;
  assert.equal(pending.approved?.plan, order);
  assert.equal((await r.flow.status())[0].planner?.ownerAsked, false);
  assert.deepEqual(await r.makeFlow().status(), []);
  await r.store.update("erp", (record) => ({ ...record!, planner: { ...record!.planner!, ownerAsked: true } }));
  assert.equal((await r.flow.status())[0].planner?.ownerAsked, false, "old approved records must not reappear as owner-needed");
  assert.deepEqual(await r.makeFlow().status(), []);
  r.fail.unreached = undefined;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.equal((await r.store.all()).erp.planner, null);
  assert.ok(r.calls.includes("i1 blocks i2"));
});

test("durable status replaces cached failures after closure, replacement or recovery without losing the successful ticket read", async (t) => {
  for (const resolution of ["closed", "replaced", "recovered"] as const) {
    const r = await room(t, [issue(1), issue(2)]);
    await r.seed({ planned: [], planner: runRecord({ listed: ["i1"], ownerAsked: true, error: "Needs owner" }) });
    await r.flow.tick(paseoWith(() => []), settings);
    const before = (await r.flow.status())[0];
    assert.equal(before.toPlan, 1);
    assert.equal(before.planner?.ownerAsked, true);
    r.fail.read = true;
    await r.store.update("erp", (record) => ({
      ...record!,
      planner: resolution === "closed" ? null : runRecord({
        id: resolution === "replaced" ? "replacement" : "run-1",
        listed: ["i1"], ownerAsked: false, error: resolution === "replaced" ? "Usage limit: waiting for reset" : undefined,
      }),
    }));
    const after = (await r.flow.status())[0];
    assert.equal(after.name, before.name);
    assert.equal(after.toPlan, before.toPlan);
    assert.equal(after.plansAt, before.plansAt);
    assert.equal(after.readAt, before.readAt);
    if (resolution === "closed") assert.equal(after.planner, null);
    else {
      assert.equal(after.planner?.ownerAsked, false);
      assert.equal(after.planner?.runId, resolution === "replaced" ? "replacement" : "run-1");
      assert.equal(after.planner?.error, resolution === "replaced" ? "Usage limit: waiting for reset" : null);
    }
    assert.deepEqual(await r.makeFlow().status(), [], "a healthy or closed durable run is not a reload alert");
  }
});

test("durable status adds uncached held projects while preserving cached successful project reads", async (t) => {
  const r = await room(t, [issue(1)]);
  await r.flow.tick(paseoWith(() => []), settings);
  const before = (await r.flow.status())[0];
  await r.store.update("other", () => ({ name: "Other project", planned: [], planner: runRecord({ id: "other-run", ownerAsked: true, error: "Needs owner" }) }));
  const statuses = await r.flow.status();
  assert.deepEqual(statuses[0], before);
  assert.equal(statuses[1].id, "other");
  assert.equal(statuses[1].name, "Other project");
  assert.equal(statuses[1].planner?.ownerAsked, true);
});

test("status distinguishes a missing store from unreadable or malformed durable state", async (t) => {
  const r = await room(t, [issue(1)]);
  assert.deepEqual(await r.flow.status(), [], "a store not created yet is empty");
  await r.seed({ name: "ERP", planned: [], planner: runRecord({ ownerAsked: true, error: "Needs owner" }) });
  await r.flow.tick(paseoWith(() => []), settings);
  assert.equal((await r.flow.status())[0].planner?.ownerAsked, true);
  for (const source of ["{", "null", "[]", '{"erp":null}', '{"erp":{"planner":false}}', JSON.stringify({ erp: { planner: { ...runRecord(), ownerAsked: "yes" } } })]) {
    await writeFile(r.path, source);
    await assert.rejects(r.flow.status(), /JSON|malformed/, "unknown state must not look like an empty or resolved alert");
  }
  await rm(r.path);
  await mkdir(r.path);
  await assert.rejects(r.flow.status(), { code: "EISDIR" }, "filesystem read errors must reach the caller");
});


test("new tickets get a planner run once they have waited the quiet time, and its brief carries every one of them", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "the tickets only arrived");
  const waiting = (await r.flow.status())[0];
  assert.deepEqual({ toPlan: waiting.toPlan, plansAt: waiting.plansAt, planner: waiting.planner },
    { toPlan: 2, plansAt: "2026-01-02T00:15:00.000Z", planner: null }, "the run starts 15 minutes after the newest ticket");
  r.advance(14 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "14 minutes is short of the quiet time");
  r.advance(2 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["start run"]);
  const status = (await r.flow.status())[0];
  assert.deepEqual({ toPlan: status.toPlan, plansAt: status.plansAt, tickets: status.planner?.tickets, restarts: status.planner?.restarts, agentId: status.planner?.agentId },
    { toPlan: 0, plansAt: null, tickets: 2, restarts: 0, agentId: "run-agent-1" });
  const start = r.starts[0];
  assert.equal(start.runId, status.planner!.runId);
  assert.equal(start.requestId, `planner-${start.runId}-0`);
  assert.deepEqual({ project: start.projectName, projectId: start.linearProjectId, team: start.teamId }, { project: "ERP", projectId: "erp", team: "t1" });
  assert.match(start.brief, /\*\*TUC-1\*\* Ticket 1 \(Todo · P3 · NEW\)/);
  assert.match(start.brief, /\*\*TUC-2\*\* Ticket 2 \(Todo · P3 · NEW\)/);
});

test("a steady trickle of tickets still gets a run once the oldest has waited an hour", async (t) => {
  const r = await room(t, [issue(1), issue(2), issue(3)]);
  await r.seed({ planned: [], planner: null, waiting: { i1: "2026-01-01T23:00:00Z", i2: "2026-01-01T23:10:00Z", i3: "2026-01-01T23:50:00Z" } });
  await r.flow.tick(paseoWith(() => []), settings);
  assert.deepEqual(r.calls, ["start run"], "the hour cap beats the newest ticket's quiet time");
  assert.match(r.starts[0].brief, /\*\*TUC-1\*\*/);
  assert.match(r.starts[0].brief, /\*\*TUC-3\*\*/);
  assert.equal((await r.store.all()).erp.planner?.tickets, 3);
});

test("Plan and a dispatch poll share one in-flight launch", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => []);
  const gate = r.holdStart();
  const planned = r.flow.planNow("erp", settings, paseo);
  while (!gate.starting()) await setImmediate();
  const poll = r.flow.tick(paseo, settings);
  await setImmediate();
  gate.open();
  await Promise.all([planned, poll]);
  assert.equal(r.starts.length, 1, "the dispatch poll must not launch a second agent");
  assert.equal((await r.store.all()).erp.planner?.restarts, 0);
});

test("the Plan RPC can return its durable run while agent startup is still waiting", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => []);
  const gate = r.holdStart();
  let returned: { planner: { runId: string; agentId: string | null } | null } | undefined;
  const planned = r.flow.planNow("erp", settings, paseo, true).then((status) => { returned = status; });
  while (!gate.starting()) await setImmediate();
  try {
    assert.ok(returned?.planner, "Plan acknowledges the durable run before provider readiness");
    assert.equal(returned.planner.agentId, null);
    assert.equal(returned.planner.runId, (await r.store.all()).erp.planner!.id);
  } finally { gate.open(); await planned; }
  await r.flow.tick(paseo, settings);
  assert.equal(r.starts.length, 1, "the poll and queued background launch cannot double-start");
  assert.equal((await r.store.all()).erp.planner?.agentId, "run-agent-1");
});

test("Skip during launch retires the returned agent before handing tickets out", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => []);
  const gate = r.holdStart();
  const planned = r.flow.planNow("erp", settings, paseo);
  while (!gate.starting()) await setImmediate();
  const skipped = r.flow.skipPlan("erp", settings, paseo);
  await setImmediate();
  gate.open();
  await planned;
  const status = await skipped;
  assert.equal(status.planner, null);
  assert.ok(r.calls.includes("retire run-agent-1"), "a run closed during launch must not leave its agent behind");
  await r.flow.tick(paseo, settings);
  assert.ok(r.calls.includes("delegate i1"));
});

test("Skip waits for an in-flight order write and cannot claim its tickets went out unordered", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  const gate = r.holdFullRead();
  const writing = r.flow.applyPlan(run, "run-agent-1", "```project-order\nTUC-1 blocks TUC-2\n```", paseo, settings);
  while (!gate.reading()) await setImmediate();
  let skipped = false;
  const skip = r.flow.skipPlan("erp", settings, paseo).then(() => { skipped = true; }, (error: unknown) => error);
  await setImmediate();
  assert.equal(skipped, false, "Skip cannot succeed while a writer can still mutate Linear");
  gate.open();
  await writing;
  assert.match(String(await skip), /No planner is planning/);
  assert.equal(await r.flow.applyPlan(run, "run-agent-1", "```project-order\nhold TUC-1: obsolete\n```", paseo, settings), false);
  assert.ok(!r.calls.includes("label i1 +paseo-hold"), "the obsolete report cannot apply another order");
});

test("Skip retires an unconfirmed creation, including an agent that appears only on a later poll", async (t) => {
  const r = await room(t, [issue(1)]);
  const agents: Agent[] = [];
  const paseo = paseoWith(() => agents);
  r.fail.start = "always";
  await assert.rejects(r.flow.planNow("erp", settings, paseo), /creation could not be confirmed/);
  const run = (await r.store.all()).erp.planner!.id;
  agents.push({ id: "lost-response", status: "running", labels: { "linear.plannerRun": run, "linear.projectId": "erp" } });
  await r.flow.skipPlan("erp", settings, paseo);
  assert.ok(r.calls.includes("retire lost-response"));
  agents.length = 0;
  agents.push({ id: "late-creation", status: "running", labels: { "linear.plannerRun": run, "linear.projectId": "erp" } });
  r.calls.length = 0;
  r.advance(2 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.slice(0, 2), ["retire late-creation", "delegate i1"], "obsolete roots are stopped before hand-out");
});

test("Skip stops the run without an order: its tickets count as planned and are handed out", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  r.calls.length = 0;
  const status = await r.flow.skipPlan("erp", settings, paseo);
  assert.deepEqual(r.calls, ["retire run-agent-1"], "the run's agent is archived, nothing is written to the project");
  assert.deepEqual({ toPlan: status.toPlan, planner: status.planner }, { toPlan: 0, planner: null });
  const stored = (await r.store.all()).erp;
  assert.equal(stored.closedPlanner, run);
  assert.deepEqual([...(stored.planned ?? [])].sort(), ["i1", "i2"]);
  assert.equal(await r.flow.applyPlan(run, "agent-1", "```project-order\n```", paseo, settings), false, "a late report of the skipped run is ignored");
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i1", "delegate i2"], "handed out unordered, and no second run starts");
  await assert.rejects(r.flow.skipPlan("erp", settings, paseo), /No planner is planning the work order of this project/);
});

test("a start that cannot succeed (no mapping, no provider) is left to the owner with one project update and never retried", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => []);
  r.fail.start = "setup";
  await r.flow.planNow("erp", settings, paseo);
  assert.equal(r.starts.length, 1);
  assert.equal(r.updates.length, 1);
  assert.match(r.updates[0], /^\*\*No agent is planning the work order of ERP\.\*\* No Paseo project is mapped to ERP or its team\./);
  assert.match(r.updates[0], /Press Plan in the Paseo Agents menu bar app to start again, or Skip/);
  const stored = (await r.store.all()).erp.planner!;
  assert.deepEqual({ ownerAsked: stored.ownerAsked, restarts: stored.restarts, error: stored.error },
    { ownerAsked: true, restarts: 0, error: "No Paseo project is mapped to ERP or its team. Open the Paseo plugin settings and map one." });
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "asked once, then left to the owner");
  assert.equal((await r.flow.status())[0].planner?.error, "No Paseo project is mapped to ERP or its team. Open the Paseo plugin settings and map one.");
});

test("Plan replaces a run left to the owner, archiving its agent and starting over", async (t) => {
  const r = await room(t, [issue(1)]);
  await r.seed({ planned: [], planner: runRecord({ agentId: "agent-stuck", restarts: 3, ownerAsked: true, error: "No agent is planning the work order" }) });
  const status = await r.flow.planNow("erp", settings, paseoWith(() => []));
  assert.deepEqual(r.calls, ["retire agent-stuck", "start run"]);
  assert.notEqual(status.planner?.runId, "run-1");
  assert.deepEqual({ ownerAsked: (await r.store.all()).erp.planner?.ownerAsked, agentId: status.planner?.agentId }, { ownerAsked: undefined, agentId: "run-agent-1" });
});

test("a run whose agent stopped is started again after ten minutes, at most three times, then the owner is asked once", async (t) => {
  // TUC-1 is worked on (In Progress), so only the run lacks an agent.
  const r = await room(t, [issue(1, { delegateId: APP, statusType: "started", status: "In Progress" })]);
  await r.seed({ planned: [], planner: runRecord({ startedAt: "2026-01-01T23:50:00Z" }) });
  const agents: Agent[] = [];
  const archived: string[] = [];
  const local = paseoWith(() => agents, archived);
  const poll = async (minutes: number) => { r.calls.length = 0; r.advance(minutes * MINUTE); await r.flow.tick(local, settings); return r.calls; };
  assert.deepEqual(await poll(0), ["start run"], "ten minutes without a live agent");
  assert.deepEqual(await poll(9), [], "the new agent may still be launching");
  agents.push({ id: "agent-a", status: "initializing", labels: { "linear.plannerRun": "run-1" } });
  assert.deepEqual(await poll(11), [], "it came up");
  // It went idle without a plan and was closed; one start fails, the next one comes up again.
  agents[0].status = "closed";
  r.fail.start = "always";
  assert.deepEqual(await poll(11), ["start run"]);
  r.fail.start = undefined;
  assert.deepEqual(await poll(11), ["start run"], "the third restart comes up");
  assert.deepEqual(archived, ["agent-a"], "the stopped agent it replaced is archived");
  assert.deepEqual(await poll(11), ["update erp **No agent is planning the work order of ERP.** Paseo started the planner 4 times, and none of its agents is working on it now (the start failed, or the agent stopped without submitting a plan)."], "asked once");
  assert.deepEqual(await poll(60), [], "asked once, then left to the owner");
  const planner = (await r.store.all()).erp.planner!;
  assert.deepEqual({ restarts: planner.restarts, ownerAsked: planner.ownerAsked }, { restarts: 3, ownerAsked: true });
});

test("a start that keeps failing counts like a restart and reaches the owner the same way", async (t) => {
  const r = await room(t, [issue(1, { delegateId: APP, statusType: "started", status: "In Progress" })]);
  await r.seed({ planned: [], planner: runRecord({ startedAt: "2026-01-01T23:50:00Z" }) });
  r.fail.start = "always";
  const none = paseoWith(() => []);
  const poll = async (minutes: number) => { r.calls.length = 0; r.advance(minutes * MINUTE); await r.flow.tick(none, settings); return r.calls; };
  assert.deepEqual(await poll(0), ["start run"], "the first read after the grace starts it");
  assert.deepEqual(await poll(2), [], "a start still under way is not doubled");
  assert.deepEqual(await poll(11), ["start run"], "the grace runs from the attempt");
  assert.deepEqual(await poll(11), ["start run"]);
  assert.deepEqual(await poll(11), ["update erp **No agent is planning the work order of ERP.** Paseo started the planner 4 times, and none of its agents is working on it now (the start failed, or the agent stopped without submitting a plan)."]);
  assert.equal(r.starts.length, 3, "three starts: the cap");
  assert.deepEqual(await poll(60), []);
  assert.equal((await r.store.all()).erp.planner?.ownerAsked, true);
});

test("a planner startup usage limit waits through the reset window without ordinary retries", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => []);
  r.fail.startError = "usage limit retry-after: 18000 model=anthropic/claude-opus-5-5";
  await r.flow.planNow("erp", settings, paseo).catch(() => {});
  const runId = (await r.store.all()).erp.planner!.id;
  for (let poll = 0; poll < 12; poll++) {
    r.advance(10 * MINUTE);
    await r.flow.tick(paseo, settings);
  }
  assert.equal(r.starts.length, 1, "the provider is unavailable, not twelve new restart opportunities");
  assert.equal((await r.store.all()).erp.planner?.restarts, 0);
  assert.equal((await r.store.all()).erp.planner?.ownerAsked, undefined);
  r.fail.startError = undefined;
  r.advance(185 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.equal(r.starts.length, 2);
  assert.equal(r.starts[1].runId, runId);
  assert.notEqual(r.starts[1].requestId, r.starts[0].requestId);
});

test("a run agent that shows running without its process is started again (2026-10-05: a daemon crash left TUC-949's agent so)", async (t) => {
  let processes = "";
  const inspect: ProcessInspector = { processes: async () => processes, cwd: async () => "/repo/planner", canonicalPath: async (path) => path };
  const r = await room(t, [issue(1, { delegateId: APP, statusType: "started", status: "In Progress" })], [], inspect);
  await r.seed({ planned: [], planner: runRecord({ startedAt: "2026-01-01T23:59:00Z" }) });
  const handle = "/home/mirko/.omp/agent/sessions/planner/2026-01-01T18-03-07-492Z_01a10d3b.jsonl";
  // Its last update was at the crash; the listing still shows it running.
  const agents: Agent[] = [{ id: "agent-ghost", status: "running", labels: { "linear.plannerRun": "run-1" }, provider: "omp", cwd: "/repo/planner", updatedAt: "2026-01-01T23:09:44Z", persistence: { provider: "omp", sessionId: "01a10d3b", nativeHandle: handle } }];
  const local = paseoWith(() => agents);
  const poll = async () => { r.calls.length = 0; await r.flow.tick(local, settings); return r.calls.filter((call) => call === "start run"); };
  processes = `2100185 omp --mode rpc-ui --session ${handle}\n`;
  assert.deepEqual(await poll(), [], "its process still works: a long turn, not a ghost");
  processes = "";
  r.advance(HOUR);
  assert.deepEqual(await poll(), ["start run"]);
});

test("a planner ticket of an older version is dropped: the ticket is left alone and its tickets are planned on their own", async (t) => {
  const r = await room(t, [issue(1), issue(2, { id: "legacy", identifier: "TUC-101", labels: ["paseo-planner"], delegateId: APP, createdAt: "2026-01-01T23:00:00Z" })]);
  const legacy: PlannerRecord & { identifier: string; url: string } = { id: "legacy", identifier: "TUC-101", url: "https://linear.app/x", listedAt: "2026-01-01T23:00:00Z", tickets: 1, started: true };
  await r.seed({ plannedThrough: "2026-01-01T12:00:00Z", planner: legacy });
  await r.flow.tick(paseoWith(() => []), settings);
  const stored = (await r.store.all()).erp;
  assert.deepEqual({ planner: stored.planner, planned: stored.planned }, { planner: null, planned: ["i1"] });
  assert.deepEqual(r.calls, ["delegate i1"], "TUC-1 was planned by the old record; the planner ticket is not a ticket to hand out");
  assert.equal((await r.flow.status())[0].toPlan, 0);
  r.calls.length = 0;
  r.issues[0] = issue(1, { delegateId: APP });
  r.advance(HOUR);
  await r.flow.tick(paseoWith(() => []), settings);
  assert.deepEqual(r.calls, [], "the dropped ticket's tickets are planned: no run starts for them either");
});

test("a run whose start fails never stops the hand-out of tickets already planned, and the next read retries it", async (t) => {
  const r = await room(t, [issue(1), issue(2, { createdAt: "2026-01-02T00:00:00Z" })]);
  await r.seed({ plannedThrough: "2026-01-01T12:00:00Z", planner: null, waiting: { i2: "2026-01-01T23:00:00Z" } });
  r.fail.start = "always";
  await r.flow.tick(paseoWith(() => []), settings);
  assert.deepEqual(r.calls, ["start run", "delegate i1"], "the run's start failed: the planned ticket goes out anyway");
  assert.equal((await r.store.all()).erp.planner?.restarts, 0, "the run's first start is not a restart");
  assert.equal((await r.flow.status())[0].planner?.restarts, 0);
  r.fail.start = undefined;
  r.advance(2 * MINUTE);
  await r.flow.tick(paseoWith(() => []), settings);
  assert.equal(r.starts.length, 1, "an unconfirmed launch keeps the ten-minute grace too");
  r.advance(8 * MINUTE);
  await r.flow.tick(paseoWith(() => []), settings);
  assert.equal(r.starts.length, 2, "the first poll after the grace starts it");
  assert.equal((await r.store.all()).erp.planner?.started, true);
});

test("a ticket is planned only once a run listed it: one created while the run starts, or moved in from another project, is new", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  // TUC-2 came after the run's list; TUC-3 was moved into the project, created long before it.
  r.issues.push(issue(2, { createdAt: "2026-01-02T00:00:00Z" }), issue(3, { createdAt: "2025-12-01T00:00:00Z" }));
  r.advance(2 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.equal(r.starts.length, 1, "the open run lists the others as unplanned; no second run starts");
  assert.equal((await r.flow.status())[0].toPlan, 2);
  await r.flow.applyPlan(run, "run-agent-1", "```project-order\n```", paseo, settings);
  r.calls.length = 0;
  r.advance(16 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["start run", "delegate i1"], "only what the first run listed is planned");
  assert.match(r.starts[1].brief, /## NEW tickets in full\n\n### TUC-2 /);
  assert.doesNotMatch(r.starts[1].brief, /### TUC-1 /);
  assert.equal((await r.store.all()).erp.planner?.tickets, 2);
});

test("first-seen times are kept per ticket and pruned when one leaves the waiting list", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  await r.flow.tick(paseo, settings);
  assert.deepEqual((await r.store.all()).erp.waiting, { i1: "2026-01-02T00:00:00.000Z", i2: "2026-01-02T00:00:00.000Z" });
  // TUC-1 is handed to Paseo by someone else: not waiting for a plan any more.
  r.issues[0] = issue(1, { delegateId: APP });
  r.advance(2 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.deepEqual((await r.store.all()).erp.waiting, { i2: "2026-01-02T00:00:00.000Z" });
  assert.equal((await r.flow.status())[0].plansAt, "2026-01-02T00:15:00.000Z", "TUC-2 keeps its own first-seen time");
});

test("the approved work order is written as one project update, then planned tickets are handed out in order up to the agent limit", async (t) => {
  const r = await room(t, [issue(1, { priority: 4 }), issue(2, { priority: 1 }), issue(3), issue(4), issue(5)], ["running-elsewhere"]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  r.calls.length = 0;
  const plan = "# Order\n\n```project-order\n- TUC-3 blocks TUC-4\nhold TUC-5: needs a pricing decision\nTUC-9 blocks TUC-1\n```";
  assert.equal(await r.flow.applyPlan("unrelated", "agent-x", plan, paseo, settings), false);
  assert.equal(await r.flow.applyPlan(run, "run-agent-1", plan, paseo, settings), true);
  assert.deepEqual(r.calls, [
    "i3 blocks i4",
    "label i5 +paseo-hold",
    "update erp **Work order applied** (2 changes). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "retire run-agent-1",
  ]);
  assert.match(r.updates[0], /Applied:\n- TUC-3 blocks TUC-4\n- hold TUC-5: needs a pricing decision/);
  assert.match(r.updates[0], /Skipped:\n- TUC-9 blocks TUC-1 \(not an open ticket of the project\)/);
  // Linear now shows the order: TUC-4 blocked, TUC-5 held.
  r.issues.splice(0, r.issues.length, issue(1, { priority: 4 }), issue(2, { priority: 1 }), issue(3), issue(4, { blockers: [{ id: "i3", identifier: "TUC-3", status: "Todo", statusType: "unstarted", delegateId: null, finished: false }] }), issue(5, { labels: ["paseo-hold"] }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i2"], "one free slot of two: the urgent ticket; blocked and held tickets never");
});

test("a failed summary update does not keep an applied work order open", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  r.calls.length = 0;
  r.fail.update = 1;
  await r.flow.applyPlan(run, "run-agent-1", "```project-order\nTUC-1 blocks TUC-2\n```", paseo, settings);
  assert.equal((await r.store.all()).erp.planner, null);
  assert.deepEqual(r.calls, ["i1 blocks i2", "retire run-agent-1"]);
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i1"], "neither the relation nor the summary repeats");
});

test("a change Linear keeps refusing is retried for three reads, then the order closes with it listed as skipped", async (t) => {
  const r = await room(t, [issue(1), issue(2), issue(3)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  r.fail.relation = "i1 blocks i2";
  await r.flow.applyPlan(run, "run-agent-1", "```project-order\nTUC-1 blocks TUC-2\nTUC-2 blocks TUC-3\n```", paseo, settings);
  assert.deepEqual(r.calls.filter((call) => call.endsWith("i3")), ["i2 blocks i3"], "the readable change goes through on the first try");
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.updates, [], "two reads with a failing change keep the order open");
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [
    "update erp **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "retire run-agent-1",
    "delegate i1",
  ], "the third read closes the order with the refused change skipped; TUC-2's blocker was refused, so it is not handed out unordered, and TUC-3 waits for TUC-2");
  assert.match(r.updates.at(-1)!, /Skipped:\n- TUC-1 blocks TUC-2 \(Linear refused the relation\)/);
  assert.match(r.updates.at(-1)!, /Not handed out, because Linear refused their hold or blocker: TUC-2\. Assign them to Paseo yourself when they may start\./);
});

test("a change that never reached Linear is retried every read, without the three-read limit", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  r.fail.unreached = "i1 blocks i2";
  await r.flow.applyPlan(run, "run-agent-1", "```project-order\nTUC-1 blocks TUC-2\n```", paseo, settings);
  for (let poll = 0; poll < 4; poll++) { r.advance(HOUR); await r.flow.tick(paseo, settings); }
  assert.deepEqual(r.updates, [], "an outage never closes the order with the change skipped");
  assert.equal((await r.store.all()).erp.planner?.approved?.agentId, "run-agent-1");
  r.fail.unreached = undefined;
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.slice(0, 2), ["i1 blocks i2", "update erp **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up."]);
});

test("a work order retried by a later read repeats only the changes that did not go through, so a hold the owner removed stays removed", async (t) => {
  const r = await room(t, [issue(1), issue(2), issue(3)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  r.fail.unreached = "i1 blocks i3";
  await r.flow.applyPlan(run, "run-agent-1", "```project-order\nhold TUC-2: pricing first\nTUC-1 blocks TUC-3\n```", paseo, settings);
  assert.ok(r.calls.includes("label i2 +paseo-hold"));
  // Meanwhile the owner takes the hold off TUC-2 again (the fake's TUC-2 has no label); Linear is back.
  r.fail.unreached = undefined;
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.slice(0, 2), ["i1 blocks i3", "update erp **Work order applied** (2 changes). The project's tickets are now handed to Paseo in order as agent slots free up."], "the hold is not repeated, the relation is");
});

test("while an approved order waits to be written, the tickets it blocks, holds or marks attended are not handed out", async (t) => {
  const r = await room(t, [issue(1), issue(2), issue(3), issue(4), issue(5)]);
  // TUC-1 to TUC-5 were planned before; the open run's order is approved, but Linear is down for its relation.
  await r.seed({ planned: ["i1", "i2", "i3", "i4", "i5"], planner: runRecord({ listed: ["i1", "i2", "i3", "i4", "i5"], tickets: 5,
    approved: { agentId: "agent-p", plan: "```project-order\nTUC-1 blocks TUC-2\nhold TUC-3: pricing first\nattended TUC-4: wording\n```" } }) });
  r.fail.unreached = "i1 blocks i2";
  await r.flow.tick(paseoWith(() => []), settings);
  assert.deepEqual(r.updates, [], "the order is not written yet");
  assert.deepEqual(r.calls.filter((call) => call.startsWith("delegate")), ["delegate i1", "delegate i5"]);
});

test("a read that writes the approved order reads the project in full before handing out, so a ticket it just blocked waits", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  await r.seed({ planned: ["i1", "i2"], planner: runRecord({ listed: ["i1", "i2"], tickets: 2, approved: { agentId: "agent-p", plan: "```project-order\nTUC-1 blocks TUC-2\n```" } }) });
  await r.flow.tick(paseoWith(() => []), settings);
  assert.ok(r.calls.includes("i1 blocks i2"));
  assert.deepEqual(r.calls.filter((call) => call.startsWith("delegate")), ["delegate i1"], "TUC-2 waits for TUC-1, though the project's changed-only view does not show that yet");
});

test("a work order links related tickets anywhere and closes a duplicate only when nobody works on it", async (t) => {
  const r = await room(t, [
    issue(1), issue(2), issue(3, { statusType: "started", status: "In Progress" }), issue(4, { linked: [{ id: "o9", identifier: "OPS-9", kind: "related" }] }),
  ]);
  r.elsewhere.set("OPS-9", { id: "o9", identifier: "OPS-9", title: "Shared export" });
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  r.calls.length = 0;
  const order = "```project-order\nTUC-1 duplicates OPS-9: OPS-9 already exports the ledger\nTUC-2 relates to OPS-9\nTUC-3 duplicates TUC-2: same\nTUC-4 relates to OPS-9\nTUC-4 duplicates OPS-9: covered\nTUC-2 relates to TUC-404\nTUC-2 relates to TUC-2\n```";
  await r.flow.applyPlan(run, "run-agent-1", order, paseo, settings);
  assert.deepEqual(r.calls.slice(0, 7), [
    "label i1 +paseo-hold",
    "comment i1 Closed as a duplicate of OPS-9 by the project's work order: OPS-9 already exports the ledger",
    "i1 duplicate o9",
    "i2 related o9",
    "label i4 +paseo-hold",
    "comment i4 Closed as a duplicate of OPS-9 by the project's work order: covered",
    "i4 duplicate o9",
  ], "held before it is closed; an existing related link is not added again, but does not stand for a duplicate");
  const summary = r.updates.at(-1)!;
  assert.match(summary, /Applied:\n- TUC-1 duplicates OPS-9: OPS-9 already exports the ledger\n- TUC-2 relates to OPS-9\n- TUC-4 relates to OPS-9\n- TUC-4 duplicates OPS-9: covered/);
  assert.match(summary, /- TUC-3 duplicates TUC-2: same \(started or with an agent/);
  assert.match(summary, /- TUC-2 relates to TUC-404 \(TUC-404 does not exist\)/);
  assert.match(summary, /- TUC-2 relates to TUC-2 \(a ticket cannot be linked to itself\)/);
});

test("while the owner is away only an attended ticket with an approved plan waits; back, it goes first", async (t) => {
  // TUC-1 was marked attended by a work order and its plan is approved; TUC-2, someone else's, plans like any other.
  const attended = () => issue(1, { labels: ["paseo-attended", "plan-ready"] });
  const r = await room(t, [attended(), issue(2, { creatorId: "colleague" }), issue(3), issue(4), issue(5, { priority: 1 })]);
  await r.seed({ planned: ["i1", "i2", "i3", "i4", "i5"], planner: null });
  const paseo = paseoWith(() => []);
  r.setAway(true);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i2", "delegate i5"], "two slots: the urgent ticket and the oldest that needs nobody; TUC-1 waits");
  r.issues.splice(0, r.issues.length, attended(), issue(3, { priority: 2 }), issue(4, { priority: 2 }));
  r.setAway(false);
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i1", "delegate i3"], "present: the attended ticket goes before higher-priority ones, so TUC-4 waits");
});

test("tickets nobody may hand out stay put: started, someone else's, already with Paseo, sub-issues; a parent goes as a group", async (t) => {
  const r = await room(t, [
    issue(1, { statusType: "started", status: "In Progress" }),
    issue(2, { assigneeId: "colleague" }),
    issue(3, { delegateId: APP }),
    issue(4),
    issue(5, { parentId: "i4" }),
    issue(6, { assigneeId: OWNER, labels: ["Area/Sales"] }),
    issue(7, { statusType: "triage", status: "Triage" }),
  ]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  await r.flow.applyPlan(run, "run-agent-1", "```project-order\n```", paseo, settings);
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i4", "delegate i6"]);
});

test("only new tickets the project could hand out get a run", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => []);
  const run = (await r.flow.planNow("erp", settings, paseo)).planner!.runId;
  await r.flow.applyPlan(run, "run-agent-1", "```project-order\n```", paseo, settings);
  r.issues[0] = issue(1, { delegateId: APP });
  r.issues.push(issue(3, { createdAt: "2026-01-02T00:30:00Z", parentId: "i1" }), issue(4, { createdAt: "2026-01-02T00:30:00Z", delegateId: APP }),
    issue(5, { createdAt: "2026-01-02T00:30:00Z", assigneeId: "colleague" }), issue(6, { createdAt: "2026-01-02T00:30:00Z", statusType: "started", status: "In Progress" }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  const read = (await r.flow.status())[0];
  assert.deepEqual({ toPlan: read.toPlan, planner: read.planner }, { toPlan: 0, planner: null }, "none of them could be handed out");
  await assert.rejects(r.flow.planNow("erp", settings, paseo), /No new tickets to plan/);
  r.issues.push(issue(2, { createdAt: "2026-01-02T00:40:00Z" }), issue(7, { createdAt: "2026-01-02T00:40:00Z", assigneeId: OWNER, statusType: "triage", status: "Triage" }));
  r.advance(2 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.equal((await r.flow.status())[0].toPlan, 2, "first seen now");
  r.advance(16 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.equal((await r.flow.status())[0].planner?.tickets, 2);
  await r.flow.skipPlan("erp", settings, paseo);
  await assert.rejects(r.flow.planNow("erp", settings, paseo), /No new tickets to plan/);
});

test("changes to the project store made at the same time all land", async (t) => {
  const r = await room(t, []);
  const empty = { planned: [], planner: null };
  await Promise.all([
    r.store.update("erp", (current) => ({ ...(current ?? empty), planned: ["i1"] })),
    r.store.update("erp", (current) => ({ ...(current ?? empty), closedPlanner: "run-1" })),
  ]);
  assert.deepEqual((await r.store.all()).erp, { planned: ["i1"], planner: null, closedPlanner: "run-1" });
});

test("a work order is readable only when every line in its block is one change", () => {
  assert.deepEqual(orderProblems("```project-order\nTUC-1 blocks TUC-2: shares the form.\nhold TUC-3 - owner decides\n\n```"), []);
  assert.deepEqual(orderProblems("no block"), ["The plan has no ```project-order block."]);
  assert.deepEqual(orderProblems("```project-order\nTUC-1 blocks TUC-2, TUC-3\nhold TUC-4\n```"), ['Not one work-order change: "TUC-1 blocks TUC-2, TUC-3"']);
});

test("the work-order block accepts list markers and case, and ignores other lines", () => {
  assert.deepEqual(parseOrder("intro\n```project-order\n* tuc-1 BLOCKS tuc-2\n- Hold TUC-3 — owner decides\nrelease TUC-4\nnotes here\n```\nTUC-8 blocks TUC-9"), [
    { kind: "blocks", blocker: "TUC-1", blocked: "TUC-2" },
    { kind: "hold", ticket: "TUC-3", reason: "owner decides" },
    { kind: "release", ticket: "TUC-4", reason: "" },
  ]);
  assert.deepEqual(parseOrder("```project-order\nAttended tuc-5: wording\nunattended TUC-6\ntuc-7 Duplicates OPS-2: same export\nTUC-8 relates   to TUC-9\n```"), [
    { kind: "attended", ticket: "TUC-5", reason: "wording" },
    { kind: "unattended", ticket: "TUC-6", reason: "" },
    { kind: "duplicates", ticket: "TUC-7", other: "OPS-2", reason: "same export" },
    { kind: "relates", ticket: "TUC-8", other: "TUC-9", reason: "" },
  ]);
});

test("the planner's brief gives every NEW ticket in full and lists the team's open tickets outside the project", async (t) => {
  const long = `Export the ledger. ${"Every column is listed here. ".repeat(20)}The CSV uses semicolons.`;
  const r = await room(t, [issue(1, { createdAt: "2025-12-31T00:00:00Z" }), issue(2)]);
  r.descriptions.set("i1", long);
  r.descriptions.set("i2", long);
  await r.seed({ plannedThrough: "2026-01-01T00:00:00Z", planner: null, waiting: { i2: "2026-01-01T23:00:00Z" } });
  r.team.push(
    { id: "i1", identifier: "TUC-1", title: "Ticket 1", status: "Todo", projectId: "erp", projectName: "ERP" },
    { id: "o1", identifier: "TUC-50", title: "Ledger export for accounting", status: "In Review", projectId: "fin", projectName: "Finance" },
    { id: "o2", identifier: "TUC-51", title: "Loose idea", status: "Backlog", projectId: null, projectName: "" },
  );
  await r.flow.planNow("erp", settings, paseoWith(() => []));
  const brief = r.starts[0].brief;
  assert.equal(brief.split("The CSV uses semicolons.").length - 1, 1, "only the NEW ticket's description is given in full");
  assert.match(brief, /\*\*TUC-50\*\* Ledger export for accounting \(In Review · Finance\)/);
  assert.match(brief, /\*\*TUC-51\*\* Loose idea \(Backlog · no project\)/);
  assert.ok(!/outside ERP[\s\S]*\*\*TUC-1\*\*/.test(brief), "the project's own tickets are not listed again as outside it");
});

test("a large project's brief stays within the prompt limit and lists every NEW ticket", () => {
  // TUC-1094: a brief whose prompt passed 200,000 characters (the ticket planners rode Linear's
  // agent-session limit).
  const title = "Rework the goods receipt booking so partial deliveries keep their batch and storage location";
  const work = Array.from({ length: 2_000 }, (_, n) => issue(n + 1, { title: `${title} ${n + 1}`, labels: ["Platform", "Warehouse"] }));
  const fresh = work.filter((_, n) => n % 10 === 9);
  const descriptions = new Map(work.map((item) => [item.id, "x".repeat(5_000)]));
  const others: TeamIssue[] = Array.from({ length: 300 }, (_, n) => ({ id: `o${n}`, identifier: `TUC-${5_000 + n}`, title, status: "Todo", projectId: "fin", projectName: "Finance" }));
  const brief = plannerBrief("ERP", work, fresh, descriptions, others, true, { hold: "paseo-hold", attended: "paseo-attended" });
  assert.ok(brief.length <= 120_000, `brief has ${brief.length} characters`);
  const list = brief.split("## NEW tickets in full")[0];
  for (const item of fresh) assert.match(list, new RegExp(`\\*\\*${item.identifier}\\*\\* .*NEW\\)`), `${item.identifier} is listed`);
  assert.match(list, /\d+ more open tickets are not listed for length; search Linear for them\./);
  assert.match(brief, /Only the \d+ most recently updated are listed; search Linear for older ones\./);
});

// A ticket assigned to Paseo by an earlier read, and how its blockers stand.
const blocker = (finished: boolean) => ({ id: "b1", identifier: "TUC-90", status: finished ? "Done" : "In Progress", statusType: finished ? "completed" : "started", delegateId: null, finished });

test("a ticket assigned to Paseo whose start failed (TUC-53) is started again after ten minutes, at most three times, then left to the owner", async (t) => {
  const r = await room(t, [
    issue(1, { delegateId: APP }),
    // Not stalled: a thread waits for a slot, the label dispatch owns it, it is worked on, it is a
    // group whose sub-issue works, or it waits for its blocker.
    issue(2, { delegateId: APP }),
    issue(3, { delegateId: APP, labels: ["paseo-failed"] }),
    issue(4, { delegateId: APP, statusType: "started", status: "In Progress" }),
    issue(5, { delegateId: APP }), issue(6, { parentId: "i5", statusType: "started", status: "In Progress" }),
    issue(7, { delegateId: APP, blockers: [blocker(false)] }),
  ]);
  r.held.add("i2");
  r.fail.restart = true;
  const none = paseoWith(() => []);
  const poll = async (minutes: number) => {
    r.calls.length = 0;
    r.advance(minutes * MINUTE);
    await r.flow.tick(none, settings);
    return r.calls.filter((call) => call.startsWith("restart") || call.startsWith("comment"));
  };
  assert.deepEqual(await poll(0), [], "first seen without an agent: its start may still be under way");
  assert.deepEqual(await poll(9), []);
  assert.deepEqual(await poll(2), ["restart i1"]);
  assert.deepEqual(await poll(9), [], "the grace runs again from the restart");
  assert.deepEqual(await poll(2), ["restart i1"]);
  assert.deepEqual(await poll(11), ["restart i1"]);
  assert.deepEqual(await poll(11), ["comment i1 **Paseo could not start an agent for this ticket.** It is assigned to Paseo, but Paseo restarted it 3 times and no agent is working on it now (the start failed, or the agent never came up), so it stops trying. Start an agent for it from the Linear tickets sidebar, or add the `paseo` label to try again."]);
  assert.deepEqual(await poll(60), [], "asked once, then left to the owner");
  assert.deepEqual((await r.store.all()).erp.stalled, { i1: { since: "2026-01-02T00:33:00.000Z", restarts: 3, ownerAsked: true } });
});

test("stalled tickets restart one per poll, and a failed restart frees its slot for the next one", async (t) => {
  const r = await room(t, [issue(1, { delegateId: APP }), issue(2, { delegateId: APP })]);
  r.fail.restart = true;
  const one = { ...settings, dispatch: { ...settings.dispatch, maxRunning: 1 } };
  const none = paseoWith(() => []);
  const poll = async (minutes: number) => {
    r.calls.length = 0;
    r.advance(minutes * MINUTE);
    await r.flow.tick(none, one);
    return r.calls.filter((call) => call.startsWith("restart"));
  };
  assert.deepEqual(await poll(0), []);
  assert.deepEqual(await poll(11), ["restart i1"]);
  assert.deepEqual(await poll(2), ["restart i2"], "the only agent slot is free again");
});

test("a stalled ticket waits for a free slot without using up a restart, and is forgotten once its agent works", async (t) => {
  const running = ["x1", "x2"];
  const r = await room(t, [issue(1, { delegateId: APP }), issue(7, { delegateId: APP, blockers: [blocker(false)] })], running);
  const agents: Agent[] = [];
  const local = paseoWith(() => agents);
  const poll = async (minutes: number) => {
    r.calls.length = 0;
    r.advance(minutes * MINUTE);
    await r.flow.tick(local, settings);
    return r.calls.filter((call) => call.startsWith("restart"));
  };
  assert.deepEqual(await poll(0), []);
  assert.deepEqual(await poll(30), [], "both agent slots are taken");
  assert.deepEqual((await r.store.all()).erp.stalled?.i1.restarts, 0);
  running.length = 0;
  r.issues[1] = issue(7, { delegateId: APP, blockers: [blocker(true)] });
  assert.deepEqual(await poll(2), ["restart i1"], "a slot is free");
  assert.deepEqual((await r.store.all()).erp.stalled?.i7, { since: "2026-01-02T00:32:00.000Z", restarts: 0 }, "TUC-7's blocker finished only now, so its grace starts now");
  agents.push({ id: "agent-1", status: "running", labels: { "linear.issueId": "i1" } });
  assert.deepEqual(await poll(8), []);
  assert.deepEqual(await poll(2), ["restart i7"]);
  assert.deepEqual((await r.store.all()).erp.stalled, { i7: { since: "2026-01-02T00:42:00.000Z", restarts: 1 } }, "TUC-1 is forgotten once its agent works");
});

async function limitedRoom(t: TestContext, error = "usage limit model=anthropic/claude-opus-5-5", delay = 5 * HOUR) {
  const r = await room(t, [issue(1)]);
  const agents: Agent[] = [{ id: "failed", status: "error", lastError: error, model: "anthropic/claude-opus-5-5", createdAt: "2026-01-01T23:00:00Z",
    labels: { "linear.plannerRun": "run-1", "linear.projectId": "erp" } }];
  const paseo = paseoWith(() => agents);
  r.usage.reports = [{ provider: "anthropic", fetchedAt: r.now(), limits: [{ amount: { usedFraction: 1 }, window: { resetsAt: r.now() + delay } }] }];
  await r.seed({ planned: [], planner: runRecord({ agentId: "failed" }) });
  await r.flow.tick(paseo, settings);
  return { ...r, agents, paseo };
}

test("planner reset waits survive reload and repeated errors while planned tickets go out", async (t) => {
  const r = await limitedRoom(t);
  const deadline = (await r.store.all()).erp.planner!.recovery!.pending!.resumeAt;
  r.issues.push(issue(2));
  await r.store.update("erp", (record) => ({ ...record!, planned: ["i2"] }));
  let flow = r.makeFlow();
  for (let poll = 0; poll < 30; poll++) {
    r.advance(10 * MINUTE);
    await flow.tick(r.paseo, settings);
    assert.equal(r.starts.length, 0);
    assert.equal((await r.store.all()).erp.planner!.recovery!.pending!.resumeAt, deadline);
    flow = r.makeFlow();
  }
  assert.ok(r.calls.includes("delegate i2"));
  assert.equal((await r.store.all()).erp.planner?.ownerAsked, undefined);
  r.advance(2 * MINUTE);
  await flow.tick(r.paseo, settings);
  assert.equal(r.starts.length, 1);
  assert.equal(r.starts[0].runId, "run-1");
  assert.equal((await r.store.all()).erp.planner!.recovery!.claims.length, 1);
  assert.equal((await r.store.all()).erp.planner!.restarts ?? 0, 0);
});

test("new account or configured fallback capacity advances a persisted planner wait", async (t) => {
  for (const fallback of [false, true]) {
    const r = await limitedRoom(t);
    const provider = fallback ? "openai-codex" : "anthropic";
    if (fallback) r.usage.chains = { "anthropic/claude-opus-5-5": ["openai-codex/gpt-6"] };
    r.advance(HOUR);
    r.usage.reports!.push({ provider, fetchedAt: r.now(), limits: [{ amount: { usedFraction: 0 } }] });
    await r.flow.tick(r.paseo, settings);
    assert.equal(r.starts.length, 1);
    assert.equal(r.starts[0].runId, "run-1");
    assert.equal((await r.store.all()).erp.planner!.recovery!.pending, undefined);
  }
});

test("changed launch preferences cannot use old-model room to authorize the new selector", async (t) => {
  const r = await limitedRoom(t);
  const current = { ...settings, launchPreferences: { omp: { ...settings.launchPreferences.omp, model: "openai-codex/gpt-6" } } };
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.usage.reports!.push({ provider: "openai-codex", fetchedAt: r.now(), limits: [{ amount: { usedFraction: 1 }, window: { resetsAt: r.now() + 4 * HOUR } }] });
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, current);
  assert.equal(r.starts.length, 0);
  assert.equal((await r.store.all()).erp.planner!.recovery!.pending!.selector, "openai-codex/gpt-6");
  r.usage.reports![1].limits = [{ amount: { usedFraction: 0 } }];
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, current);
  assert.deepEqual(r.launchedSelectors, ["openai-codex/gpt-6"]);
});

test("unreadable or stale usage preserves retry-after and default deadlines", async (t) => {
  for (const hint of ["", " retry-after: 720"]) {
    const r = await room(t, [issue(1)]);
    const paseo = paseoWith(() => [{ id: "failed", status: "error", lastError: `usage limit${hint}`, labels: { "linear.plannerRun": "run-1" } }]);
    await r.seed({ planned: [], planner: runRecord({ agentId: "failed" }) });
    r.usage.refresh = false;
    r.usage.reports = [{ provider: "anthropic", fetchedAt: r.now() - 31 * MINUTE, limits: [{ amount: { usedFraction: 0 } }] }];
    await r.flow.tick(paseo, settings);
    const deadline = (await r.store.all()).erp.planner!.recovery!.pending!.resumeAt;
    r.usage.reports = null;
    r.advance((hint ? 12 : 28) * MINUTE);
    await r.flow.tick(paseo, settings);
    assert.equal(r.starts.length, 0);
    assert.equal((await r.store.all()).erp.planner!.recovery!.pending!.resumeAt, deadline);
    r.advance(2 * MINUTE);
    await r.flow.tick(paseo, settings);
    assert.equal(r.starts.length, 1);
  }
});

test("planner limit spacing and daily bound are independent of generic retries and hold after failed notification", async (t) => {
  for (const failedNotice of [false, true]) {
    const r = await limitedRoom(t);
    await r.store.update("erp", (record) => ({ ...record!, planner: { ...record!.planner!, restarts: 3 } }));
    r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
    if (failedNotice) r.fail.update = 1;
    let flow = r.makeFlow();
    for (let attempt = 1; attempt <= 4; attempt++) {
      r.advance(attempt === 1 ? 2 * MINUTE : 14 * MINUTE);
      await flow.tick(r.paseo, settings);
      if (attempt > 1) {
        assert.equal(r.starts.length, attempt - 1);
        r.advance(2 * MINUTE);
        await flow.tick(r.paseo, settings);
      }
      assert.equal(r.starts.length, attempt);
      const run = (await r.store.all()).erp.planner!;
      assert.equal(run.restarts, 3);
      assert.equal(run.recovery!.claims.length, attempt);
      r.agents.splice(0, r.agents.length, { id: run.agentId!, status: "error", lastError: "usage limit", labels: { "linear.plannerRun": "run-1", "linear.projectId": "erp" } });
      flow = r.makeFlow();
    }
    r.advance(16 * MINUTE);
    await flow.tick(r.paseo, settings);
    assert.equal(r.starts.length, 4);
    assert.equal((await r.store.all()).erp.planner!.ownerAsked, true);
    assert.equal(r.notificationAttempts.length, 1);
    assert.equal(r.updates.length, failedNotice ? 0 : 1);
    r.advance(25 * HOUR);
    await r.makeFlow().tick(r.paseo, settings);
    assert.equal(r.starts.length, 4);
    assert.equal(r.notificationAttempts.length, 1);
  }
});

test("expired claims free capacity without reusing planner attempt identities", async (t) => {
  const r = await limitedRoom(t);
  await r.store.update("erp", (record) => ({ ...record!, planner: { ...record!.planner!, recovery: { ...record!.planner!.recovery!, attempt: 4,
    claims: [new Date(r.now() - 25 * HOUR).toISOString(), new Date(r.now() - HOUR).toISOString()] } } }));
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts[0].requestId, "planner-run-1-limit-5");
  assert.equal((await r.store.all()).erp.planner!.recovery!.claims.length, 2);
  assert.equal((await r.store.all()).erp.planner!.ownerAsked, undefined);
});

test("uncertain creation survives reload and a late first root cannot replace its live successor or approve", async (t) => {
  for (const close of ["skip", "approve"]) {
    const r = await limitedRoom(t);
    r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
    r.fail.start = "always";
    r.advance(2 * MINUTE);
    await r.flow.tick(r.paseo, settings);
    assert.equal((await r.store.all()).erp.planner!.recovery!.claim!.requestId, "planner-run-1-limit-1");
    let flow = r.makeFlow();
    r.advance(14 * MINUTE);
    await flow.tick(r.paseo, settings);
    assert.equal(r.starts.length, 1);
    r.fail.start = undefined;
    r.advance(2 * MINUTE);
    await flow.tick(r.paseo, settings);
    assert.deepEqual(r.starts.map((start) => start.requestId), ["planner-run-1-limit-1", "planner-run-1-limit-2"]);
    const canonical = (await r.store.all()).erp.planner!.agentId!;
    r.agents.splice(0, r.agents.length,
      { id: canonical, status: "running", createdAt: new Date(r.now()).toISOString(), labels: { "linear.plannerRun": "run-1", "linear.projectId": "erp" } },
      { id: "late-first", status: "running", createdAt: new Date(r.now() + MINUTE).toISOString(), labels: { "linear.plannerRun": "run-1", "linear.projectId": "erp" } });
    flow = r.makeFlow();
    r.advance(2 * MINUTE);
    await flow.tick(r.paseo, settings);
    assert.equal((await r.store.all()).erp.planner!.agentId, canonical);
    assert.ok(r.calls.includes("retire late-first"));
    assert.equal(await flow.applyPlan("run-1", "late-first", "```project-order\nTUC-1 hold\n```", r.paseo, settings), false);
    assert.ok(!r.calls.includes("label i1 +paseo-hold"));
    if (close === "skip") await flow.skipPlan("erp", settings, r.paseo);
    else assert.equal(await flow.applyPlan("run-1", canonical, "```project-order\n```", r.paseo, settings), true);
    assert.equal((await r.store.all()).erp.planner, null);
    assert.ok(r.calls.includes(`retire ${canonical}`));
    r.agents.push({ id: "late-after-close", status: "running", labels: { "linear.plannerRun": "run-1", "linear.projectId": "erp" } });
    r.advance(2 * MINUTE);
    await flow.tick(r.paseo, settings);
    assert.ok(r.calls.includes("retire late-after-close"));
  }
});

test("a late live result before another uncertain attempt is adopted without spending a claim", async (t) => {
  const r = await limitedRoom(t);
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.fail.start = "always";
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  r.agents.push({ id: "late-live", status: "running", labels: { "linear.plannerRun": "run-1" } });
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts.length, 1);
  assert.equal((await r.store.all()).erp.planner!.agentId, "late-live");
  assert.equal((await r.store.all()).erp.planner!.recovery!.claims.length, 1);
  assert.equal((await r.store.all()).erp.planner!.recovery!.claim, undefined);
});

test("Skip waits for a claimed limit launch and retires its returned agent", async (t) => {
  const r = await limitedRoom(t);
  const gate = r.holdStart();
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.advance(2 * MINUTE);
  const tick = r.flow.tick(r.paseo, settings);
  while (!gate.starting()) await setImmediate();
  const skip = r.flow.skipPlan("erp", settings, r.paseo);
  gate.open();
  await tick;
  await skip;
  assert.ok(r.calls.includes("retire run-agent-1"));
  r.advance(HOUR);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts.length, 1);
  assert.equal((await r.store.all()).erp.planner, null);
});

test("disabled dispatch and removed trigger preserve waits; child and predecessor errors cannot restart a live root", async (t) => {
  const r = await limitedRoom(t);
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.advance(HOUR);
  await r.flow.tick(r.paseo, { ...settings, dispatch: { ...settings.dispatch, enabled: false } });
  assert.equal(r.starts.length, 0);
  r.setLabelled(false);
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  assert.equal(r.starts.length, 0);
  r.setLabelled(true);
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  assert.equal(r.starts.length, 1);
  const canonical = (await r.store.all()).erp.planner!.agentId!;
  r.agents.push({ id: canonical, status: "running", labels: { "linear.plannerRun": "run-1" } },
    { id: "child", status: "error", lastError: "usage limit", labels: { "linear.plannerRun": "run-1", "paseo.parent-agent-id": canonical } });
  r.advance(HOUR);
  await r.flow.tick(r.paseo, settings);
  assert.equal(r.starts.length, 1);
  assert.equal((await r.store.all()).erp.planner!.recovery!.pending, undefined);
});

test("corrupt planner recovery metadata fails closed without resetting its budget", async (t) => {
  const r = await limitedRoom(t);
  const messages: string[] = [];
  t.mock.method(console, "error", (text: string) => { messages.push(text); });
  const record = (await r.store.all()).erp;
  await r.seed({ ...record, planner: { ...record.planner!, recovery: { attempt: 4, claims: ["not-a-timestamp"] } } });
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.advance(HOUR);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts.length, 0);
  assert.deepEqual((await r.store.all()).erp.planner!.recovery!.claims, ["not-a-timestamp"]);
  assert.ok(messages.some((message) => message.includes("corrupt usage-limit recovery metadata")));
});

test("a provider limit during replacement startup spends one claim, preserves generic count, and reports the next wait", async (t) => {
  const r = await limitedRoom(t);
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.fail.startError = "429 usage limit retry-after: 3600 model=anthropic/claude-opus-5-5";
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  const failed = (await r.store.all()).erp.planner!;
  assert.equal(failed.recovery!.claims.length, 1);
  assert.equal(failed.restarts ?? 0, 0);
  assert.equal(failed.recovery!.pending!.identity, r.starts[0].requestId);
  assert.match((await r.flow.status())[0].planner!.error!, /Berlin time/);
  r.fail.startError = undefined;
  r.advance(14 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts.length, 1);
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts.length, 2);
  assert.equal((await r.store.all()).erp.planner!.recovery!.claims.length, 2);
});

test("a later provider reset postpones recovery without redrawing jitter or spending attempts", async (t) => {
  const r = await limitedRoom(t);
  const first = (await r.store.all()).erp.planner!.recovery!.pending!;
  r.usage.reports![0].limits[0].window = { resetsAt: r.now() + 7 * HOUR };
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  const postponed = (await r.store.all()).erp.planner!.recovery!;
  assert.equal(postponed.pending!.resumeAt, new Date(Date.parse(first.failedAt) + 7 * HOUR + MINUTE).toISOString());
  assert.equal(postponed.pending!.jitterMs, first.jitterMs);
  assert.equal(postponed.pending!.fallbackAt, first.fallbackAt);
  assert.equal(postponed.claims.length, 0);
  assert.equal(r.starts.length, 0);
});

test("ordinary replacement-start failure cannot reclassify a handled predecessor limit", async (t) => {
  const r = await limitedRoom(t);
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.fail.startError = "project listing is offline";
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  assert.equal(r.starts.length, 1);
  r.advance(8 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts.length, 1, "ordinary startup grace is ten minutes");
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.equal(r.starts.length, 2, "ordinary failure retries at ten minutes, not the limit spacing");
  for (let poll = 0; poll < 3; poll++) {
    r.advance(10 * MINUTE);
    await r.makeFlow().tick(r.paseo, settings);
  }
  const run = (await r.store.all()).erp.planner!;
  assert.equal(r.starts.length, 4);
  assert.equal(run.restarts, 3);
  assert.equal(run.recovery!.claims.length, 1);
  assert.equal(run.ownerAsked, true);
});

test("an unconfirmed usage-limited ordinary restart retains grace despite a predecessor agent id", async (t) => {
  const r = await room(t, [issue(1)]);
  const paseo = paseoWith(() => [{ id: "predecessor", status: "closed", labels: { "linear.plannerRun": "run-1" } }]);
  await r.seed({ planned: [], planner: runRecord({ agentId: "predecessor" }) });
  r.fail.startError = "Agent creation could not be confirmed (429 usage limit model=anthropic/claude-opus-5-5).";
  await r.flow.tick(paseo, settings);
  assert.equal(r.starts.length, 1);
  r.fail.startError = undefined;
  r.usage.reports = [{ provider: "anthropic", fetchedAt: r.now(), limits: [{ amount: { usedFraction: 0 } }] }];
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(paseo, settings);
  assert.equal(r.starts.length, 1, "a predecessor id is not confirmation of the new failed creation");
  r.advance(6 * MINUTE);
  await r.makeFlow().tick(paseo, settings);
  assert.equal(r.starts.length, 1);
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(paseo, settings);
  assert.equal(r.starts.length, 2);
  assert.notEqual(r.starts[0].requestId, r.starts[1].requestId);
  assert.equal((await r.store.all()).erp.planner!.recovery!.claims.length, 1);
});

test("confirmed limit restarts survive multiple attempts, closure and reload without crediting claims", async (t) => {
  for (const close of ["skip", "approve", "replace"]) {
    const r = await limitedRoom(t);
    assert.equal((await r.store.all()).erp.plannerLimitRestarts, undefined);
    r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
    r.advance(2 * MINUTE);
    await r.flow.tick(r.paseo, settings);
    const first = (await r.store.all()).erp.plannerLimitRestarts!;
    assert.deepEqual(first, [{ runId: "run-1", requestId: "planner-run-1-limit-1", agentId: "run-agent-1", failedAgentId: "failed", confirmedAt: new Date(r.now()).toISOString() }]);
    r.agents.splice(0, r.agents.length, { id: "run-agent-1", status: "error", lastError: "usage limit", labels: { "linear.plannerRun": "run-1" } });
    r.advance(16 * MINUTE);
    await r.makeFlow().tick(r.paseo, settings);
    const expected = (await r.store.all()).erp.plannerLimitRestarts!;
    assert.equal(expected[1].requestId, "planner-run-1-limit-2");
    assert.equal(expected[1].failedAgentId, "run-agent-1");
    r.agents.splice(0, r.agents.length, { id: "run-agent-2", status: "running", labels: { "linear.plannerRun": "run-1", "linear.plannerRequest": "planner-run-1-limit-2" } });
    const flow = r.makeFlow();
    if (close === "skip") await flow.skipPlan("erp", settings, r.paseo);
    else if (close === "approve") await flow.applyPlan("run-1", "run-agent-2", "```project-order\n```", r.paseo, settings);
    else {
      await r.store.update("erp", (record) => ({ ...record!, planner: { ...record!.planner!, ownerAsked: true } }));
      await flow.planNow("erp", settings, r.paseo);
    }
    assert.deepEqual((await r.store.all()).erp.plannerLimitRestarts, expected);
  }
});

test("uncertain labeled adoption credits only the canonical new usage-limit root once", async (t) => {
  for (const label of ["planner-run-1-limit-1", undefined, "planner-run-1-limit-2", "planner-run-1-1"]) {
    const r = await limitedRoom(t);
    r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
    r.fail.start = "always";
    r.advance(2 * MINUTE);
    await r.flow.tick(r.paseo, settings);
    assert.equal((await r.store.all()).erp.plannerLimitRestarts, undefined);
    r.agents.push({ id: "adopted", status: "running", labels: { "linear.plannerRun": "run-1", ...(label ? { "linear.plannerRequest": label } : {}) } });
    r.advance(2 * MINUTE);
    await r.makeFlow().tick(r.paseo, settings);
    const expected = label === "planner-run-1-limit-1"
      ? [{ runId: "run-1", requestId: label, agentId: "adopted", failedAgentId: "failed", confirmedAt: new Date(r.now()).toISOString() }] : undefined;
    assert.deepEqual((await r.store.all()).erp.plannerLimitRestarts, expected);
    r.agents.push({ id: "duplicate", status: "running", labels: { "linear.plannerRun": "run-1", "linear.plannerRequest": "planner-run-1-limit-1" } });
    r.advance(2 * MINUTE);
    await r.makeFlow().tick(r.paseo, settings);
    assert.deepEqual((await r.store.all()).erp.plannerLimitRestarts, expected);
    assert.ok(r.calls.includes("retire duplicate"));
  }
});

test("failed confirmation save keeps the claim for exactly one labeled adoption after reload", async (t) => {
  const r = await limitedRoom(t);
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  const update = ProjectStore.prototype.update;
  let fail = true;
  t.mock.method(ProjectStore.prototype, "update", function (this: ProjectStore, id: string, change: (record: ProjectRecord | undefined) => ProjectRecord | null) {
    return update.call(this, id, (record) => {
      const next = change(record);
      if (fail && next?.plannerLimitRestarts?.length) { fail = false; throw new Error("confirmation disk failure"); }
      return next;
    });
  });
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  const waiting = (await r.store.all()).erp;
  assert.equal(waiting.plannerLimitRestarts, undefined);
  assert.equal(waiting.planner!.recovery!.claim!.requestId, "planner-run-1-limit-1");
  assert.ok(waiting.planner!.recovery!.pending);
  r.agents.push({ id: "run-agent-1", status: "running", labels: { "linear.plannerRun": "run-1", "linear.plannerRequest": r.starts[0].requestId } });
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  const confirmed = (await r.store.all()).erp.plannerLimitRestarts!;
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].agentId, "run-agent-1");
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.deepEqual((await r.store.all()).erp.plannerLimitRestarts, confirmed);
  assert.equal(r.starts.length, 1);
});

test("retirement failure cannot rewrite a persisted successful restart as failed creation", async (t) => {
  const r = await limitedRoom(t);
  r.usage.reports![0].limits = [{ amount: { usedFraction: 0 } }];
  r.fail.retire = true;
  r.advance(2 * MINUTE);
  await r.flow.tick(r.paseo, settings);
  const record = (await r.store.all()).erp;
  assert.equal(record.planner!.error, undefined);
  assert.equal(record.planner!.recovery!.pending, undefined);
  assert.equal(record.plannerLimitRestarts![0].agentId, "run-agent-1");
  r.agents.push({ id: "run-agent-1", status: "running", labels: { "linear.plannerRun": "run-1", "linear.plannerRequest": r.starts[0].requestId } });
  r.fail.retire = false;
  r.advance(2 * MINUTE);
  await r.makeFlow().tick(r.paseo, settings);
  assert.deepEqual((await r.store.all()).erp.plannerLimitRestarts, record.plannerLimitRestarts);
  assert.equal(r.starts.length, 1);
});

test("project updates expire restart evidence after eight days while preserving repair records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "restart-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.parse("2026-01-10T00:00:00Z");
  const store = new ProjectStore(join(directory, "projects.json"), () => now);
  const boundary = { runId: "run", requestId: "request", agentId: "agent", confirmedAt: new Date(now - 8 * 24 * HOUR).toISOString() };
  await writeFile(join(directory, "projects.json"), JSON.stringify({ erp: { planner: null, plannerLimitRestarts: [boundary, { ...boundary, requestId: "expired", confirmedAt: new Date(now - 8 * 24 * HOUR - 1).toISOString() }] }, "~repairs": { sentinel: { incident: "unchanged" } } }));
  await store.update("erp", (record) => ({ ...record!, planned: ["i1"] }));
  assert.deepEqual((await store.all()).erp.plannerLimitRestarts, [boundary]);
  assert.deepEqual(await store.repairs(), { sentinel: { incident: "unchanged" } });
});
