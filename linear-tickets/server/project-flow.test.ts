import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { ProjectIssue } from "./linear";
import { Capacity } from "./capacity";
import { parseOrder, ProjectFlow, ProjectStore } from "./project-flow";
import { Scheduler } from "./scheduler";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const OWNER = "owner-1";
const APP = "paseo-app";
const HOUR = 60 * 60_000;
const paseo = {} as PaseoApi;
const settings = { dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["TUC"], maxRunning: 2 }, writeback: DEFAULT_WRITEBACK } as PluginSettings;

const issue = (n: number, change: Partial<ProjectIssue> = {}): ProjectIssue => ({
  id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, priority: 3, createdAt: `2026-01-01T00:00:0${n}Z`, status: "Todo", statusType: "unstarted",
  teamId: "t1", teamKey: "TUC", creatorId: OWNER, assigneeId: null, delegateId: null, labels: [], parentId: null, blockers: [], blocks: [], ...change,
});

async function room(t: TestContext, issues: ProjectIssue[], running: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "project-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  let now = Date.parse("2026-01-02T00:00:00Z");
  let created = 0;
  let away = false;
  // Plan documents by "<ticket id> <title>"; `fail`: Linear writes that fail (comments the next n
  // times, one relation always); `comments`: every comment body posted.
  const documents = new Map<string, string>();
  const fail: { comments?: number; relation?: string } = {};
  const comments: string[] = [];
  const linear = {
    labeledProjects: async () => [{ id: "erp", name: "ERP" }],
    projectIssues: async () => issues,
    issueDescriptions: async () => new Map<string, string>(),
    createIssue: async (input: { title: string; description: string; priority?: number }) => { created++; calls.push(`create ${input.title} P${input.priority}`); return { id: `planner${created}`, identifier: `TUC-${100 + created}`, url: "" }; },
    addLabel: async (id: string, name: string) => { calls.push(`label ${id} +${name}`); },
    removeLabel: async (id: string, name: string) => { calls.push(`label ${id} -${name}`); },
    delegate: async (id: string) => { calls.push(`delegate ${id}`); },
    addBlocker: async (blocker: string, blocked: string) => {
      if (fail.relation === `${blocker} blocks ${blocked}`) throw new Error("Linear refused the relation");
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
  const store = new ProjectStore(join(directory, "projects.json"));
  const scheduler = new Scheduler({ running: async () => running, projectOf: async () => "erp", away: async () => away, now: () => now });
  const flow = new ProjectFlow({ linear, scheduler, capacity: new Capacity(() => now), store, retire: async (agentId) => { calls.push(`retire ${agentId}`); }, now: () => now });
  return { flow, calls, store, issues, documents, fail, comments, advance: (ms: number) => { now += ms; }, setAway: (value: boolean) => { away = value; } };
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
  assert.deepEqual(r.calls.slice(0, 4), [
    "i2 blocks i3",
    "comment planner1 **Work order applied** (1 change). The project's tickets are now handed to Paseo in order as agent slots free up.",
    "complete planner1",
    "retire agent-p",
  ]);
  assert.match(r.comments.at(-1)!, /Skipped:\n- TUC-1 blocks TUC-2 \(Linear refused the relation\)/);
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

test("the work-order block accepts list markers and case, and ignores other lines", () => {
  assert.deepEqual(parseOrder("intro\n```project-order\n* tuc-1 BLOCKS tuc-2\n- Hold TUC-3 — owner decides\nrelease TUC-4\nnotes here\n```\nTUC-8 blocks TUC-9"), [
    { kind: "blocks", blocker: "TUC-1", blocked: "TUC-2" },
    { kind: "hold", ticket: "TUC-3", reason: "owner decides" },
    { kind: "release", ticket: "TUC-4", reason: "" },
  ]);
  assert.deepEqual(parseOrder("```project-order\nAttended tuc-5: wording\nunattended TUC-6\n```"), [
    { kind: "attended", ticket: "TUC-5", reason: "wording" },
    { kind: "unattended", ticket: "TUC-6", reason: "" },
  ]);
});
