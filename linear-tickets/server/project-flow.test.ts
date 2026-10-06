import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { LinearApiError, LinearRefusedError, type ProjectIssue, type TeamIssue, type TicketRef } from "./linear";
import { Capacity } from "./capacity";
import { orderProblems, parseOrder, ProjectFlow, ProjectStore, type ProjectRecord } from "./project-flow";
import type { ProcessInspector } from "./process-liveness";
import { Scheduler } from "./scheduler";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const OWNER = "owner-1";
const APP = "paseo-app";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type Agent = { id: string; status: string; labels: Record<string, string> };
// Paseo with these agents: one labelled with a ticket only for that ticket, any other for every
// ticket asked about.
const paseoWith = (agents: () => Agent[]) => ({ agents: { list: async ({ filter }: { filter: { labels: Record<string, string> } }) => ({
  entries: agents().filter((agent) => !agent.labels["linear.issueId"] || agent.labels["linear.issueId"] === filter.labels["linear.issueId"]).map((agent) => ({ agent })),
  pageInfo: { hasMore: false },
}) } }) as unknown as PaseoApi;
// Every planner has a working agent, except in the restart test.
const paseo = paseoWith(() => [{ id: "agent-p", status: "running", labels: {} }]);
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
  // Plan documents by "<ticket id> <title>"; `fail`: Linear writes that fail (comments and
  // delegations the next n times, `create` always, one relation refused or never reaching Linear,
  // the hold label refused); `comments`: every comment body posted; `gate`: holds createIssue open;
  // `descriptions`: ticket descriptions by id; `team`: open tickets of the team; `elsewhere`:
  // tickets by identifier; `briefs`: every planner description filed.
  const documents = new Map<string, string>();
  const fail: { comments?: number; delegate?: number; create?: boolean; relation?: string; unreached?: string; hold?: boolean; restart?: boolean } = {};
  const comments: string[] = [];
  let gate: Promise<void> | null = null;
  let creating = false;
  const outage = () => new LinearApiError("The Linear API request failed (HTTP 503). Try again.", 503);
  const descriptions = new Map<string, string>();
  const team: TeamIssue[] = [];
  const elsewhere = new Map<string, TicketRef>();
  const briefs: string[] = [];
  const linear = {
    labeledProjects: async () => [{ id: "erp", name: "ERP" }],
    projectIssues: async () => issues,
    issueDescriptions: async () => descriptions,
    openTeamIssues: async (_teams: string[], limit: number) => team.slice(0, limit),
    issueRef: async (identifier: string) => elsewhere.get(identifier) ?? null,
    relate: async (id: string, other: string, type: string) => { calls.push(`${id} ${type} ${other}`); },
    createIssue: async (input: { title: string; description: string; priority?: number }) => {
      if (fail.create) throw outage();
      creating = true;
      await gate;
      created++;
      calls.push(`create ${input.title} P${input.priority}`);
      briefs.push(input.description);
      return { id: `planner${created}`, identifier: `TUC-${100 + created}`, url: "" };
    },
    addLabel: async (id: string, name: string) => {
      if (fail.hold && name === "paseo-hold") throw new LinearRefusedError(`Linear did not add the "${name}" label.`);
      calls.push(`label ${id} +${name}`);
    },
    removeLabel: async (id: string, name: string) => { calls.push(`label ${id} -${name}`); },
    delegate: async (id: string) => {
      if (fail.delegate) { fail.delegate--; throw outage(); }
      calls.push(`delegate ${id}`);
    },
    addBlocker: async (blocker: string, blocked: string) => {
      if (fail.relation === `${blocker} blocks ${blocked}`) throw new LinearRefusedError("Linear refused the relation");
      if (fail.unreached === `${blocker} blocks ${blocked}`) throw outage();
      calls.push(`${blocker} blocks ${blocked}`);
    },
    complete: async (id: string) => { calls.push(`complete ${id}`); },
    comment: async (id: string, body: string) => {
      if (fail.comments) { fail.comments--; throw new Error("Linear's hourly request limit is reached"); }
      calls.push(`comment ${id} ${body.split("\n")[0]}`);
      comments.push(body);
    },
    issueDocument: async (id: string, title: string) => documents.has(`${id} ${title}`) ? { url: "", content: documents.get(`${id} ${title}`)! } : null,
    appUserId: async () => APP,
    viewerId: async () => OWNER,
  };
  const path = join(directory, "projects.json");
  const store = new ProjectStore(path);
  const scheduler = new Scheduler({ running: async () => running, projectOf: async () => "erp", away: async () => away, now: () => now });
  // Tickets a start under way, or their newest thread, accounts for.
  const held = new Set<string>();
  const flow = new ProjectFlow({ linear, scheduler, capacity: new Capacity(() => now), store, retire: async (agentId) => { calls.push(`retire ${agentId}`); }, now: () => now, inspect,
    restart: async (id) => {
      calls.push(`restart ${id}`);
      if (fail.restart) throw new Error("Agent creation could not be confirmed (Timed out waiting for OMP to become ready).");
    },
    accountedFor: async (id) => held.has(id) });
  return {
    flow, calls, store, issues, documents, fail, comments, descriptions, team, elsewhere, briefs, held,
    advance: (ms: number) => { now += ms; },
    setAway: (value: boolean) => { away = value; },
    // The project's record as an earlier poll left it.
    seed: (record: ProjectRecord) => writeFile(path, JSON.stringify({ erp: record })),
    // Holds createIssue until `open` runs; `creating` is true once a call waits there.
    // Executor form: the plugin's lib is ES2023, without Promise.withResolvers.
    hold: () => { let open!: () => void; gate = new Promise((resolve) => { open = resolve; }); return { open, creating: () => creating }; },
  };
}

test("a labelled project files a planner for its new tickets on its own, and hands them out only once the order is applied", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["create Plan the work order of ERP P1", "label planner1 +paseo-planner", "delegate planner1"]);
  assert.deepEqual(r.flow.status().map(({ name, toPlan, planner }) => ({ name, toPlan, planner })), [{ name: "ERP", toPlan: 0, planner: { identifier: "TUC-101", url: "", tickets: 2 } }]);
  r.calls.length = 0;
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"], delegateId: APP }), issue(3, { createdAt: "2026-01-02T00:30:00Z" }));
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "its tickets wait for the order, and one planner at a time");
  assert.equal(r.flow.status()[0].toPlan, 1, "TUC-3 came after the planner's list");
  await assert.rejects(r.flow.planNow("erp", settings), /TUC-101 is still planning the work order/);
});

test("Plan files the planner right away instead of at the next poll", async (t) => {
  const r = await room(t, [issue(1)]);
  const status = await r.flow.planNow("erp", settings);
  assert.deepEqual(r.calls, ["create Plan the work order of ERP P1", "label planner1 +paseo-planner", "delegate planner1"]);
  assert.deepEqual({ toPlan: status.toPlan, planner: status.planner }, { toPlan: 0, planner: { identifier: "TUC-101", url: "", tickets: 1 } });
});

test("the approved work order is written to Linear, then planned tickets are handed out in order up to the agent limit", async (t) => {
  const r = await room(t, [issue(1, { priority: 4 }), issue(2, { priority: 1 }), issue(3), issue(4), issue(5)], ["running-elsewhere"]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  const plan = "# Order\n\n```project-order\n- TUC-3 blocks TUC-4\nhold TUC-5: needs a pricing decision\nTUC-9 blocks TUC-1\n```";
  assert.equal(await r.flow.applyPlan("unrelated", "agent-x", plan, paseo, settings), false);
  assert.equal(await r.flow.applyPlan("planner1", "agent-p", plan, paseo, settings), true);
  assert.deepEqual(r.calls.slice(3), [
    "i3 blocks i4",
    "label i5 +paseo-hold",
    "comment planner1 **Work order applied** (2 changes). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "complete planner1",
    "retire agent-p",
  ]);
  // Linear now shows the order: the planner is closed, TUC-4 blocked, TUC-5 held.
  r.issues.splice(0, r.issues.length, issue(1, { priority: 4 }), issue(2, { priority: 1 }), issue(3), issue(4, { blockers: [{ id: "i3", identifier: "TUC-3", status: "Todo", statusType: "unstarted", delegateId: null, finished: false }] }), issue(5, { labels: ["paseo-hold"] }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i2"], "one free slot of two: the urgent ticket; blocked and held tickets never");
});

test("while the owner is away only an attended ticket with an approved plan waits; back, it goes first", async (t) => {
  // TUC-1 is marked attended by the order and its plan is approved; TUC-2, someone else's, plans like any other.
  const r = await room(t, [issue(1), issue(2, { creatorId: "colleague" }), issue(3), issue(4), issue(5, { priority: 1 })]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  await r.flow.applyPlan("planner1", "agent-p", "```project-order\nattended TUC-1: pricing is not decided\n```", paseo, settings);
  assert.ok(r.calls.includes("label i1 +paseo-attended"));
  const attended = () => issue(1, { labels: ["paseo-attended", "plan-ready"] });
  r.issues.splice(0, r.issues.length, attended(), issue(2, { creatorId: "colleague" }), issue(3), issue(4), issue(5, { priority: 1 }));
  r.setAway(true);
  r.calls.length = 0;
  r.advance(HOUR);
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
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  await r.flow.applyPlan("planner1", "agent-p", "no order block", paseo, settings);
  r.issues.pop();
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i4", "delegate i6"]);
});

test("only new tickets the project could hand out get a planner", async (t) => {
  const r = await room(t, [issue(1)]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  await r.flow.applyPlan("planner1", "agent-p", "", paseo, settings);
  r.issues.pop();
  r.issues[0] = issue(1, { delegateId: APP });
  r.issues.push(issue(3, { createdAt: "2026-01-02T00:30:00Z", parentId: "i1" }), issue(4, { createdAt: "2026-01-02T00:30:00Z", delegateId: APP }),
    issue(5, { createdAt: "2026-01-02T00:30:00Z", assigneeId: "colleague" }), issue(6, { createdAt: "2026-01-02T00:30:00Z", statusType: "started", status: "In Progress" }));
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual({ toPlan: r.flow.status()[0].toPlan, planner: r.flow.status()[0].planner }, { toPlan: 0, planner: null });
  await assert.rejects(r.flow.planNow("erp", settings), /No new tickets to plan/);
  r.issues.push(issue(2, { createdAt: "2026-01-02T00:40:00Z" }), issue(7, { createdAt: "2026-01-02T00:40:00Z", assigneeId: OWNER, statusType: "triage", status: "Triage" }));
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.equal(r.flow.status()[0].planner?.tickets, 2);
});

test("a planner the owner closes without approving counts its tickets as planned", async (t) => {
  const r = await room(t, [issue(1)]);
  await r.flow.planNow("erp", settings);
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i1"]);
  assert.deepEqual({ toPlan: r.flow.status()[0].toPlan, planner: r.flow.status()[0].planner }, { toPlan: 0, planner: null });
});

test("an approved work order Linear could not take is kept and written by the next poll", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  r.calls.length = 0;
  r.fail.comments = 1;
  assert.equal(await r.flow.applyPlan("planner1", "agent-p", "```project-order\nTUC-1 blocks TUC-2\n```", paseo, settings), true);
  assert.deepEqual(r.calls, ["i1 blocks i2"], "the closing comment failed: the planner stays open");
  assert.equal((await r.store.all()).erp.planner?.approved?.agentId, "agent-p", "the approval is kept for the next poll");
  // Linear has the relation from the first write.
  r.issues[1] = issue(2, { blockers: [{ id: "i1", identifier: "TUC-1", status: "Todo", statusType: "unstarted", delegateId: null, finished: false }] });
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [
    "comment planner1 **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "complete planner1",
    "retire agent-p",
    "delegate i1",
  ], "written on the next poll, then its tickets go out in order");
});

test("a change Linear keeps refusing is retried for three polls, then the order closes with it listed as skipped", async (t) => {
  const r = await room(t, [issue(1), issue(2), issue(3)]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  r.fail.relation = "i1 blocks i2";
  await r.flow.applyPlan("planner1", "agent-p", "```project-order\nTUC-1 blocks TUC-2\nTUC-2 blocks TUC-3\n```", paseo, settings);
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.ok(!r.calls.includes("complete planner1"), "two polls with a failing change keep the planner open");
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [
    "comment planner1 **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "complete planner1",
    "retire agent-p",
    "delegate i1",
    "delegate i3",
  ], "only the refused change is tried again; TUC-2's blocker was refused, so it is not handed out unordered");
  assert.match(r.comments.at(-1)!, /Skipped:\n- TUC-1 blocks TUC-2 \(Linear refused the relation\)/);
  assert.match(r.comments.at(-1)!, /Not handed out, because Linear refused their hold or blocker: TUC-2\./);
});

test("a planner approved some other way (plan-ready and its plan document) is written from that document at the next poll", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  r.documents.set("planner1 Plan: TUC-101", "> **Approved** in Plannotator\n\n# Work order\n\n```project-order\nTUC-1 blocks TUC-2\n```");
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.equal(r.calls.length, 0, "a plan document alone is no approval: a plan sent back has one too");
  r.issues[2] = issue(100, { id: "planner1", labels: ["paseo-planner", "plan-ready"] });
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.slice(0, 3), [
    "i1 blocks i2",
    "comment planner1 **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "complete planner1",
  ]);
  assert.ok(!r.calls.some((call) => call.startsWith("retire")), "no agent of its own to retire");
  assert.equal(await r.flow.isPlanner("planner1"), true, "a late report of its review is still its own");
});

test("a change that never reached Linear is retried every poll, without the three-poll limit", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"], delegateId: APP }));
  r.fail.unreached = "i1 blocks i2";
  await r.flow.applyPlan("planner1", "agent-p", "```project-order\nTUC-1 blocks TUC-2\n```", paseo, settings);
  for (let poll = 0; poll < 4; poll++) { r.advance(HOUR); await r.flow.tick(paseo, settings); }
  assert.ok(!r.calls.includes("complete planner1"), "an outage never closes the order with the change skipped");
  assert.equal((await r.store.all()).erp.planner?.approved?.agentId, "agent-p");
  r.fail.unreached = undefined;
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.slice(0, 2), ["i1 blocks i2", "comment planner1 **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up."]);
});

test("a planner whose label or assignment failed is started by the next poll, not filed again", async (t) => {
  const r = await room(t, [issue(1)]);
  r.fail.delegate = 1;
  await r.flow.planNow("erp", settings);
  assert.deepEqual(r.calls, ["create Plan the work order of ERP P1", "label planner1 +paseo-planner"]);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate planner1"], "only the missing assignment is repeated");
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "started: nothing is repeated");
});

test("a planner that cannot be filed never stops the hand-out of tickets already planned", async (t) => {
  const r = await room(t, [issue(1), issue(2, { createdAt: "2026-01-02T00:00:00Z" })]);
  await r.seed({ plannedThrough: "2026-01-01T12:00:00Z", planner: null });
  r.fail.create = true;
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i1"]);
  assert.deepEqual({ toPlan: r.flow.status()[0].toPlan, planner: r.flow.status()[0].planner }, { toPlan: 1, planner: null });
  r.fail.create = false;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.ok(r.calls.includes("create Plan the work order of ERP P1"), "the next poll files it");
});

test("an approved order whose planner ticket was closed meanwhile is still written, without completing the ticket", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"], delegateId: APP }));
  r.fail.comments = 1;
  await r.flow.applyPlan("planner1", "agent-p", "```project-order\nTUC-1 blocks TUC-2\n```", paseo, settings);
  // The owner closes the planner; Linear has the relation from the first write.
  r.issues.splice(0, r.issues.length, issue(1), issue(2, { blockers: [{ id: "i1", identifier: "TUC-1", status: "Todo", statusType: "unstarted", delegateId: null, finished: false }] }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [
    "comment planner1 **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "retire agent-p",
    "delegate i1",
  ]);
});

test("Plan during a poll that is filing the project's planner files no second one", async (t) => {
  const r = await room(t, [issue(1)]);
  const gate = r.hold();
  const poll = r.flow.tick(paseo, settings);
  while (!gate.creating()) await setImmediate();
  await assert.rejects(r.flow.planNow("erp", settings), /being filed right now/);
  gate.open();
  await poll;
  assert.deepEqual(r.calls.filter((call) => call.startsWith("create")), ["create Plan the work order of ERP P1"]);
});

test("a planner without a live agent (TUC-678: its launch timed out) is started again after ten minutes, at most three times, then left to the owner", async (t) => {
  // TUC-1 is worked on (In Progress), so only the planner lacks an agent.
  const r = await room(t, [issue(1, { delegateId: APP, statusType: "started", status: "In Progress" }), issue(100, { id: "planner1", labels: ["paseo-planner"], delegateId: APP })]);
  // As TUC-678 stood: filed and assigned to Paseo an hour ago by a version without restarts; no agent.
  await r.seed({ plannedThrough: "2026-01-01T12:00:00Z", planner: { id: "planner1", identifier: "TUC-101", url: "", listedAt: "2026-01-01T23:00:00Z", tickets: 1, started: true } });
  const agents: Agent[] = [];
  const local = paseoWith(() => agents);
  const poll = async (minutes: number) => {
    r.calls.length = 0;
    r.advance(minutes * MINUTE);
    await r.flow.tick(local, settings);
    return r.calls.filter((call) => call.startsWith("restart") || call.startsWith("comment"));
  };
  assert.deepEqual(await poll(0), ["restart planner1"]);
  assert.deepEqual(await poll(9), [], "the new agent may still be launching");
  agents.push({ id: "agent-a", status: "initializing", labels: {} });
  assert.deepEqual(await poll(11), [], "it came up");
  // It went idle without a plan and was closed; every start from now on fails.
  agents[0].status = "closed";
  r.fail.restart = true;
  assert.deepEqual(await poll(11), ["restart planner1"]);
  assert.deepEqual(await poll(11), ["restart planner1"]);
  assert.deepEqual(await poll(11), ["comment planner1 **No agent is planning this work order.** Paseo started this planner 4 times, and none of its agents is working on it now (the start failed, or the agent stopped without submitting a plan), so it stops trying. Start an agent for it from the Linear tickets sidebar, or close this ticket to skip the work order: its tickets then count as planned and are handed out without one."]);
  assert.deepEqual(await poll(60), [], "asked once, then left to the owner");
  const planner = (await r.store.all()).erp.planner!;
  assert.deepEqual({ restarts: planner.restarts, ownerAsked: planner.ownerAsked }, { restarts: 3, ownerAsked: true });
});

test("a planner whose agent shows running without a process (2026-10-05: a daemon crash left TUC-949's agent so for 16 hours) is started again", async (t) => {
  let processes = "";
  const inspect: ProcessInspector = { processes: async () => processes, cwd: async () => "/repo/planner", canonicalPath: async (path) => path };
  const r = await room(t, [issue(1, { delegateId: APP, statusType: "started", status: "In Progress" }), issue(100, { id: "planner1", labels: ["paseo-planner"], delegateId: APP })], [], inspect);
  await r.seed({ plannedThrough: "2026-01-01T12:00:00Z", planner: { id: "planner1", identifier: "TUC-101", url: "", listedAt: "2026-01-01T18:00:00Z", tickets: 1, started: true, startedAt: "2026-01-01T18:00:00Z" } });
  const handle = "/home/mirko/.omp/agent/sessions/planner/2026-01-01T18-03-07-492Z_01a10d3b.jsonl";
  // Its last update was at the crash; the listing still shows it running.
  const agents = [{ id: "agent-ghost", status: "running", labels: {}, provider: "omp", cwd: "/repo/planner", updatedAt: "2026-01-01T18:09:44Z", persistence: { provider: "omp", sessionId: "01a10d3b", nativeHandle: handle } }];
  const local = paseoWith(() => agents);
  const poll = async () => {
    r.calls.length = 0;
    await r.flow.tick(local, settings);
    return r.calls.filter((call) => call.startsWith("restart"));
  };
  processes = `2100185 omp --mode rpc-ui --session ${handle}\n`;
  assert.deepEqual(await poll(), [], "its process still works: a long turn, not a ghost");
  processes = "";
  r.advance(HOUR);
  assert.deepEqual(await poll(), ["restart planner1"]);
});

// A ticket assigned to Paseo by an earlier poll, and how its blockers stand.
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

test("a ticket is planned only once a planner listed it: one created while the planner is filed, or moved in from another project, is new", async (t) => {
  const r = await room(t, [issue(1)]);
  const gate = r.hold();
  const filing = r.flow.planNow("erp", settings);
  while (!gate.creating()) await setImmediate();
  // Created after the project was read, in the same instant as the read.
  r.issues.push(issue(2, { createdAt: "2026-01-02T00:00:00.000Z" }));
  gate.open();
  await filing;
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  await r.flow.applyPlan("planner1", "agent-p", "```project-order\n```", paseo, settings);
  r.issues.pop();
  // TUC-3 is moved into the project: created long before, never listed by its planner.
  r.issues.push(issue(3, { createdAt: "2025-12-01T00:00:00Z" }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.filter((call) => call.startsWith("delegate i")), ["delegate i1"]);
  assert.ok(r.calls.includes("create Plan the work order of ERP P1"), "TUC-2 and TUC-3 get a planner");
  assert.equal(r.flow.status()[0].planner?.tickets, 2);
});

test("a record of an older version keeps its planned tickets; a ticket moved in later is new", async (t) => {
  const r = await room(t, [issue(1)]);
  await r.seed({ plannedThrough: "2026-01-01T12:00:00Z", planner: null });
  r.fail.create = true;
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i1"], "planned by the old record");
  r.issues[0] = issue(1, { delegateId: APP });
  r.issues.push(issue(2));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "TUC-2 was created before the old record's time, but moved in after it");
  assert.equal(r.flow.status()[0].toPlan, 1);
});

test("a work order retried by a later poll repeats only the changes that did not go through, so a hold the owner removed stays removed", async (t) => {
  const r = await room(t, [issue(1), issue(2), issue(3)]);
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"], delegateId: APP }));
  r.fail.unreached = "i1 blocks i3";
  await r.flow.applyPlan("planner1", "agent-p", "```project-order\nhold TUC-2: pricing first\nTUC-1 blocks TUC-3\n```", paseo, settings);
  assert.ok(r.calls.includes("label i2 +paseo-hold"));
  // Meanwhile the owner takes the hold off TUC-2 again (the fake's TUC-2 has no label); Linear is back.
  r.fail.unreached = undefined;
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.slice(0, 2), ["i1 blocks i3", "comment planner1 **Work order applied** (2 changes). The project's tickets are now handed to Paseo in order as agent slots free up."]);
});

test("while an approved order waits to be written, the tickets it blocks, holds or marks attended are not handed out", async (t) => {
  const r = await room(t, [issue(1), issue(2), issue(3), issue(4), issue(5), issue(100, { id: "planner1", labels: ["paseo-planner"], delegateId: APP })]);
  // TUC-1 to TUC-5 were planned before; the open planner's order is approved, but Linear is down for its relation.
  await r.seed({ plannedThrough: "2026-01-01T12:00:00Z", planner: { id: "planner1", identifier: "TUC-101", url: "", listedAt: "2026-01-01T23:00:00Z", tickets: 1, started: true,
    approved: { agentId: "agent-p", plan: "```project-order\nTUC-1 blocks TUC-2\nhold TUC-3: pricing first\nattended TUC-4: wording\n```" } } });
  r.fail.unreached = "i1 blocks i2";
  await r.flow.tick(paseo, settings);
  assert.ok(!r.calls.includes("complete planner1"), "the order is not written yet");
  assert.deepEqual(r.calls.filter((call) => call.startsWith("delegate")), ["delegate i1", "delegate i5"]);
});

test("changes to the project store made at the same time all land", async (t) => {
  const r = await room(t, []);
  const empty = { planned: [], planner: null };
  await Promise.all([
    r.store.update("erp", (current) => ({ ...(current ?? empty), planned: ["i1"] })),
    r.store.update("erp", (current) => ({ ...(current ?? empty), closedPlanner: "planner1" })),
  ]);
  assert.deepEqual((await r.store.all()).erp, { planned: ["i1"], planner: null, closedPlanner: "planner1" });
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

test("the planner sees every NEW ticket in full and the team's open tickets outside the project", async (t) => {
  const long = `Export the ledger. ${"Every column is listed here. ".repeat(20)}The CSV uses semicolons.`;
  const r = await room(t, [issue(1, { createdAt: "2025-12-31T00:00:00Z" }), issue(2)]);
  r.descriptions.set("i1", long);
  r.descriptions.set("i2", long);
  await r.seed({ plannedThrough: "2026-01-01T00:00:00Z", planner: null });
  r.team.push(
    { id: "i1", identifier: "TUC-1", title: "Ticket 1", status: "Todo", projectId: "erp", projectName: "ERP" },
    { id: "o1", identifier: "TUC-50", title: "Ledger export for accounting", status: "In Review", projectId: "fin", projectName: "Finance" },
    { id: "o2", identifier: "TUC-51", title: "Loose idea", status: "Backlog", projectId: null, projectName: "" },
  );
  await r.flow.planNow("erp", settings);
  const brief = r.briefs[0];
  assert.equal(brief.split("The CSV uses semicolons.").length - 1, 1, "only the NEW ticket's description is given in full");
  assert.match(brief, /\*\*TUC-50\*\* Ledger export for accounting \(In Review · Finance\)/);
  assert.match(brief, /\*\*TUC-51\*\* Loose idea \(Backlog · no project\)/);
  assert.ok(!/outside ERP[\s\S]*\*\*TUC-1\*\*/.test(brief), "the project's own tickets are not listed again as outside it");
});

test("a work order links related tickets anywhere and closes a duplicate only when nobody works on it", async (t) => {
  const r = await room(t, [
    issue(1), issue(2), issue(3, { statusType: "started", status: "In Progress" }), issue(4, { linked: [{ id: "o9", identifier: "OPS-9", kind: "related" }] }),
  ]);
  r.elsewhere.set("OPS-9", { id: "o9", identifier: "OPS-9", title: "Shared export" });
  await r.flow.planNow("erp", settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  r.calls.length = 0;
  const order = "```project-order\nTUC-1 duplicates OPS-9: OPS-9 already exports the ledger\nTUC-2 relates to OPS-9\nTUC-3 duplicates TUC-2: same\nTUC-4 relates to OPS-9\nTUC-4 duplicates OPS-9: covered\nTUC-2 relates to OPS-404\nTUC-2 relates to TUC-2\n```";
  await r.flow.applyPlan("planner1", "agent-p", order, paseo, settings);
  assert.deepEqual(r.calls.slice(0, 7), [
    "label i1 +paseo-hold",
    "comment i1 Closed as a duplicate of OPS-9 by the work order of TUC-101: OPS-9 already exports the ledger",
    "i1 duplicate o9",
    "i2 related o9",
    "label i4 +paseo-hold",
    "comment i4 Closed as a duplicate of OPS-9 by the work order of TUC-101: covered",
    "i4 duplicate o9",
  ], "held before it is closed; an existing related link is not added again, but does not stand for a duplicate");
  const summary = r.comments.at(-1)!;
  assert.match(summary, /Applied:\n- TUC-1 duplicates OPS-9: OPS-9 already exports the ledger\n- TUC-2 relates to OPS-9\n- TUC-4 relates to OPS-9\n- TUC-4 duplicates OPS-9: covered/);
  assert.match(summary, /- TUC-3 duplicates TUC-2: same \(started or with an agent/);
  assert.match(summary, /- TUC-2 relates to OPS-404 \(OPS-404 does not exist\)/);
  assert.match(summary, /- TUC-2 relates to TUC-2 \(a ticket cannot be linked to itself\)/);
});
