import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { ProjectIssue } from "./linear";
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
  teamId: "t1", teamKey: "TUC", assigneeId: null, delegateId: null, labels: [], parentId: null, blockers: [], blocks: [], ...change,
});

async function room(t: TestContext, issues: ProjectIssue[], running: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "project-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  let now = Date.parse("2026-01-02T00:00:00Z");
  let created = 0;
  const linear = {
    labeledProjects: async () => [{ id: "erp", name: "ERP" }],
    projectIssues: async () => issues,
    issueDescriptions: async () => new Map<string, string>(),
    createIssue: async (input: { title: string; description: string; priority?: number }) => { created++; calls.push(`create ${input.title} P${input.priority}`); return { id: `planner${created}`, identifier: `TUC-${100 + created}`, url: "" }; },
    addLabel: async (id: string, name: string) => { calls.push(`label ${id} +${name}`); },
    removeLabel: async (id: string, name: string) => { calls.push(`label ${id} -${name}`); },
    delegate: async (id: string) => { calls.push(`delegate ${id}`); },
    addBlocker: async (blocker: string, blocked: string) => { calls.push(`${blocker} blocks ${blocked}`); },
    complete: async (id: string) => { calls.push(`complete ${id}`); },
    comment: async (id: string, body: string) => { calls.push(`comment ${id} ${body.split("\n")[0]}`); },
    appUserId: async () => APP,
    viewerId: async () => OWNER,
  };
  const store = new ProjectStore(join(directory, "projects.json"));
  const scheduler = new Scheduler({ running: async () => running, projectOf: async () => "erp", now: () => now });
  const flow = new ProjectFlow({ linear, scheduler, store, retire: async (agentId) => { calls.push(`retire ${agentId}`); }, now: () => now });
  return { flow, calls, store, issues, advance: (ms: number) => { now += ms; } };
}

test("a newly labelled project gets a planner first and hands out nothing before its plan is approved", async (t) => {
  const r = await room(t, [issue(1), issue(2)]);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["create Plan the work order of ERP P1", "label planner1 +paseo-planner", "label planner1 +plan", "delegate planner1"]);
  r.calls.length = 0;
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner", "plan"], delegateId: APP }));
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "one planner at a time; its tickets wait for the approval");
});

test("the approved work order is written to Linear, then planned tickets are handed out in order up to the agent limit", async (t) => {
  const r = await room(t, [issue(1, { priority: 4 }), issue(2, { priority: 1 }), issue(3), issue(4), issue(5)], ["running-elsewhere"]);
  await r.flow.tick(paseo, settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  const plan = "# Order\n\n```project-order\n- TUC-3 blocks TUC-4\nhold TUC-5: needs a pricing decision\nTUC-9 blocks TUC-1\n```";
  assert.equal(await r.flow.applyPlan("unrelated", "agent-x", plan, paseo, settings), false);
  assert.equal(await r.flow.applyPlan("planner1", "agent-p", plan, paseo, settings), true);
  assert.deepEqual(r.calls.slice(4), [
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
  await r.flow.tick(paseo, settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  await r.flow.applyPlan("planner1", "agent-p", "no order block", paseo, settings);
  r.issues.pop();
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i4", "delegate i6"]);
});

test("tickets filed after the plan wait for the next planner, which starts once new tickets stop arriving", async (t) => {
  const r = await room(t, [issue(1)]);
  await r.flow.tick(paseo, settings);
  r.issues.push(issue(100, { id: "planner1", labels: ["paseo-planner"] }));
  await r.flow.applyPlan("planner1", "agent-p", "", paseo, settings);
  r.issues.pop();
  r.issues[0] = issue(1, { delegateId: APP });
  // Filed after the plan but never handed out by the project, so they start no planner.
  r.issues.push(issue(3, { createdAt: "2026-01-02T00:30:00Z", parentId: "i1" }), issue(4, { createdAt: "2026-01-02T00:30:00Z", delegateId: APP }),
    issue(5, { createdAt: "2026-01-02T00:30:00Z", assigneeId: "colleague" }), issue(6, { createdAt: "2026-01-02T00:30:00Z", statusType: "started", status: "In Progress" }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, []);
  r.issues.push(issue(2, { createdAt: "2026-01-02T01:59:00Z" }));
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, [], "TUC-2 arrived a minute ago");
  r.advance(15 * 60_000);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls.slice(0, 1), ["create Plan the work order of ERP P1"]);
});

test("a planner the owner closes without approving counts its tickets as planned", async (t) => {
  const r = await room(t, [issue(1)]);
  await r.flow.tick(paseo, settings);
  r.calls.length = 0;
  r.advance(HOUR);
  await r.flow.tick(paseo, settings);
  assert.deepEqual(r.calls, ["delegate i1"]);
});

test("the work-order block accepts list markers and case, and ignores other lines", () => {
  assert.deepEqual(parseOrder("intro\n```project-order\n* tuc-1 BLOCKS tuc-2\n- Hold TUC-3 — owner decides\nrelease TUC-4\nnotes here\n```\nTUC-8 blocks TUC-9"), [
    { kind: "blocks", blocker: "TUC-1", blocked: "TUC-2" },
    { kind: "hold", ticket: "TUC-3", reason: "owner decides" },
    { kind: "release", ticket: "TUC-4", reason: "" },
  ]);
});
