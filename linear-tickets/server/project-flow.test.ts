import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const OWNER = "owner-1";
const APP = "paseo-app";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type Agent = { id: string; status: string; labels: Record<string, string>; provider?: string; cwd?: string; updatedAt?: string; persistence?: { provider: string; sessionId: string; nativeHandle: string } };
// Paseo listing the agents of whatever label the caller filters on (a ticket's `linear.issueId`, a
// run's `linear.plannerRun`), and recording the agents archived through it.
const paseoWith = (agents: () => Agent[], archived: string[] = []) => ({ agents: {
  list: async ({ filter }: { filter: { labels: Record<string, string> } }) => {
    const [key, value] = Object.entries(filter.labels)[0] ?? [];
    return { entries: agents().filter((agent) => key !== undefined && agent.labels[key] === value).map((agent) => ({ agent })), pageInfo: { hasMore: false } };
  },
  ref: (id: string) => ({ archive: async () => { archived.push(id); }, refresh: async () => ({ agent: agents().find((agent) => agent.id === id) ?? null }) }),
} }) as unknown as PaseoApi;
const settings = { dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["TUC"], maxRunning: 2 }, writeback: DEFAULT_WRITEBACK } as PluginSettings;

const issue = (n: number, change: Partial<ProjectIssue> = {}): ProjectIssue => ({
  id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, priority: 3, createdAt: `2026-01-01T00:00:0${n}Z`, status: "Todo", statusType: "unstarted",
  teamId: "t1", teamKey: "TUC", creatorId: OWNER, assigneeId: null, delegateId: null, labels: [], parentId: null, blockers: [], blocks: [], linked: [], ...change,
});

// `inspect`: the provider process table ghost agents are checked against.
async function room(t: TestContext, issues: ProjectIssue[], running: string[] = [], inspect?: ProcessInspector) {
  const directory = await mkdtemp(join(tmpdir(), "project-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  let now = Date.parse("2026-01-02T00:00:00Z");
  let created = 0;
  let away = false;
  // Linear writes that fail (`update`: the next n project updates; one relation refused or never
  // reaching Linear); `start`: how a planner start fails (`setup`: a SetupError, `always`: a
  // timeout); `restart`: every stalled-ticket restart. `starts`: every planner start, in order.
  const fail: { update?: number; relation?: string; unreached?: string; restart?: boolean; start?: "setup" | "always" } = {};
  const starts: PlannerStart[] = [];
  const comments: string[] = [];
  const updates: string[] = [];
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
    if (full) { reading = true; await readGate; cachedRelations = written.length; }
    return issues.map((item) => {
      const added = written.slice(0, cachedRelations).filter(([blocker, blocked]) => blocked === item.id && !item.blockers.some((known) => known.id === blocker));
      return added.length ? { ...item, blockers: [...item.blockers, ...added.map(([id]) => ({ id, identifier: issues.find((other) => other.id === id)?.identifier ?? id, status: "Todo", statusType: "unstarted", delegateId: null, finished: false }))] } : item;
    });
  };
  const linear = {
    labeledProjects: async () => [{ id: "erp", name: "ERP" }],
    projectIssues: async () => issues,
    issueDescriptions: async () => descriptions,
    openTeamIssues: async (_teams: string[], limit: number) => team.slice(0, limit),
    issueRef: async (identifier: string) => elsewhere.get(identifier) ?? null,
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
      if (fail.update) { fail.update--; throw new Error("Linear's hourly request limit is reached"); }
      calls.push(`update ${id} ${body.split("\n")[0]}`);
      updates.push(body);
    },
    appUserId: async () => APP,
    viewerId: async () => OWNER,
  };
  const path = join(directory, "projects.json");
  const store = new ProjectStore(path);
  const scheduler = new Scheduler({ running: async () => running, projectOf: async () => "erp", away: async () => away, now: () => now });
  // Tickets a start under way, or their newest thread, accounts for.
  const held = new Set<string>();
  const flow = new ProjectFlow({ linear, projectIssues, scheduler, capacity: new Capacity(() => now), store,
    startPlanner: async (input: PlannerStart) => {
      starts.push(input);
      calls.push("start run");
      if (fail.start === "setup") throw new SetupError("No Paseo project is mapped to ERP or its team. Open the Paseo plugin settings and map one.");
      starting = true;
      await gate;
      if (fail.start === "always") throw new Error("Agent creation could not be confirmed (Timed out waiting for OMP to become ready).");
      created++;
      return { agentId: `run-agent-${created}` };
    },
    retire: async (agentId: string) => { calls.push(`retire ${agentId}`); },
    now: () => now,
    inspect,
    restart: async (id: string) => {
      calls.push(`restart ${id}`);
      if (fail.restart) throw new Error("Agent creation could not be confirmed (Timed out waiting for OMP to become ready).");
    },
    accountedFor: async (id: string) => held.has(id) });
  return {
    flow, calls, store, issues, fail, comments, updates, starts, descriptions, team, elsewhere, held,
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

test("new tickets get a planner run once they have waited the quiet time, and its brief carries every one of them", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  const paseo = paseoWith(() => []);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "the tickets only arrived");
  assert.deepEqual({ toPlan: r.flow.status()[0].toPlan, plansAt: r.flow.status()[0].plansAt, planner: r.flow.status()[0].planner },
    { toPlan: 2, plansAt: "2026-01-02T00:15:00.000Z", planner: null }, "the run starts 15 minutes after the newest ticket");
  r.advance(14 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "14 minutes is short of the quiet time");
  r.advance(2 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["start run"]);
  const status = r.flow.status()[0];
  assert.deepEqual(Object.keys(status).sort(), ["id", "name", "planner", "plansAt", "readAt", "toPlan"]);
  assert.deepEqual(Object.keys(status.planner!).sort(), ["agentId", "error", "restarts", "runId", "startedAt", "tickets"]);
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
  assert.equal(r.flow.status()[0].planner?.error, "No Paseo project is mapped to ERP or its team. Open the Paseo plugin settings and map one.");
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
  assert.equal(r.flow.status()[0].toPlan, 0);
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
  assert.equal(r.flow.status()[0].planner?.restarts, 0);
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
  assert.equal(r.flow.status()[0].toPlan, 2);
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
  assert.equal(r.flow.status()[0].plansAt, "2026-01-02T00:15:00.000Z", "TUC-2 keeps its own first-seen time");
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
  assert.deepEqual({ toPlan: r.flow.status()[0].toPlan, planner: r.flow.status()[0].planner }, { toPlan: 0, planner: null }, "none of them could be handed out");
  await assert.rejects(r.flow.planNow("erp", settings, paseo), /No new tickets to plan/);
  r.issues.push(issue(2, { createdAt: "2026-01-02T00:40:00Z" }), issue(7, { createdAt: "2026-01-02T00:40:00Z", assigneeId: OWNER, statusType: "triage", status: "Triage" }));
  r.advance(2 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.equal(r.flow.status()[0].toPlan, 2, "first seen now");
  r.advance(16 * MINUTE);
  await r.flow.tick(paseo, settings);
  assert.equal(r.flow.status()[0].planner?.tickets, 2);
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
