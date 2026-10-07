import assert from "node:assert/strict";
import test from "node:test";
import { Credentials } from "./credentials";
import { LinearService, UPDATE_ISSUE_STATE_QUERY, type IssueStatus, type Post } from "./linear";
import { RateLimitedError } from "./rate-budget";
import { planStateLabels, StateLabels, stateLabelColor, ticketFor, type LabelAgent, type LabelDaemon, type LabelWorkspace, type StateLabel, type TicketState } from "./state-labels";

const agent = (workspaceId: string, issueId: string, identifier: string, createdAt: string): LabelAgent => ({ workspaceId, issueId, identifier, createdAt });
const IN_REVIEW: TicketState = { name: "In Review", type: "started" };
const IN_PROGRESS: TicketState = { name: "In Progress", type: "started" };

test("colours follow the state type, and the stages of started work look different", () => {
  const colors = Object.fromEntries([
    ["Triage", "triage"], ["Backlog", "backlog"], ["Todo", "unstarted"], ["In Progress", "started"], ["In Review", "started"], ["Ready to merge", "started"],
    ["Planning", "started"], ["Needs input", "started"], ["Done", "completed"], ["Canceled", "canceled"], ["Duplicate", "duplicate"], ["Odd", "unknown"],
  ].map(([name, type]) => [name, stateLabelColor({ name, type })]));
  assert.deepEqual(colors, {
    Triage: "orange", Backlog: "indigo", Todo: "sky", "In Progress": "amber", "In Review": "violet", "Ready to merge": "teal",
    Planning: "blue", "Needs input": "pink", Done: "emerald", Canceled: "red", Duplicate: "red", Odd: "sky",
  });
});

test("a workspace with agents on different tickets shows the ticket its name carries, else the oldest agent's", () => {
  const older = agent("w", "issue-b", "TUC-37", "2026-09-01T00:00:00.000Z");
  const named = agent("w", "issue-a", "TUC-376", "2026-09-02T00:00:00.000Z");
  assert.equal(ticketFor({ name: "TUC-376: Shared AGENTS.md" }, [older, named]), named, "title wins over age");
  assert.equal(ticketFor({ name: "mtuchel/tuc-376-shared-agents-md" }, [older, named]), named, "branch names count, case ignored");
  assert.equal(ticketFor({ name: "TUC-3760: other" }, [named, older]), older, "TUC-376 is not part of TUC-3760; falls back to the oldest");
  const twin = agent("w", "issue-0", "TUC-9", older.createdAt);
  assert.equal(ticketFor({ name: "scratch" }, [older, twin]), twin, "same age: the lower issue id");
  assert.equal(ticketFor({ name: "scratch" }, []), null);
});

test("each ticket workspace gets exactly its state label; stale state labels go, other labels stay", () => {
  const workspaces: LabelWorkspace[] = [
    { id: "new", name: "TUC-1: a", labels: ["to-do"] },
    { id: "moved", name: "TUC-2: b", labels: ["Linear: In Progress", "to-do", "Linear: Done"] },
    { id: "same", name: "TUC-3: c", labels: ["linear:  in review"] },
    { id: "plain", name: "scratch", labels: ["Linear: Todo", "to-do"] },
    { id: "unknown", name: "TUC-4: d", labels: ["Linear: Backlog"] },
  ];
  const agents = [agent("new", "i1", "TUC-1", "t"), agent("moved", "i2", "TUC-2", "t"), agent("same", "i3", "TUC-3", "t"), agent("unknown", "i4", "TUC-4", "t"), agent("gone", "i1", "TUC-1", "t")];
  const states = new Map([["i1", IN_PROGRESS], ["i2", IN_REVIEW], ["i3", IN_REVIEW]]);
  const plan = planStateLabels({ workspaces, agents, states, catalog: [{ name: "to-do", color: "pink" }] });
  assert.deepEqual(plan.changes, [
    { workspaceId: "moved", assign: { name: "Linear: In Review", color: "violet" }, unassign: ["Linear: In Progress", "Linear: Done"] },
    { workspaceId: "new", assign: { name: "Linear: In Progress", color: "amber" }, unassign: [] },
    { workspaceId: "plain", unassign: ["Linear: Todo"] },
  ]);
  assert.deepEqual(plan.recolor, []);
});

test("a state label whose catalog colour drifted is recoloured; labels nobody wants now are left in the catalog", () => {
  const catalog: StateLabel[] = [{ name: "Linear: In Review", color: "amber" }, { name: "Linear: Done", color: "red" }, { name: "Review", color: "amber" }];
  const plan = planStateLabels({ workspaces: [{ id: "w", name: "TUC-1", labels: ["Linear: In Review"] }], agents: [agent("w", "i1", "TUC-1", "t")], states: new Map([["i1", IN_REVIEW]]), catalog });
  assert.deepEqual(plan, { recolor: [{ name: "Linear: In Review", color: "violet" }], changes: [] });
});

class FakeDaemon implements LabelDaemon {
  calls: string[] = [];
  fail: Error | null = null;
  workspaceList: LabelWorkspace[] = [{ id: "w1", name: "TUC-1: a", labels: [] }, { id: "w2", name: "TUC-2: b", labels: [] }, { id: "w3", name: "notes", labels: ["to-do"] }];
  agents = [agent("w1", "i1", "TUC-1", "t"), agent("w2", "i2", "TUC-2", "t")];
  async workspaces() { return this.workspaceList.map((workspace) => ({ ...workspace, labels: [...workspace.labels] })); }
  async ticketAgents() { return this.agents; }
  async catalog() { return []; }
  async assign(workspaceId: string, label: StateLabel) {
    if (this.fail) throw this.fail;
    this.calls.push(`+${workspaceId} ${label.name}`);
    this.workspaceList.find((workspace) => workspace.id === workspaceId)!.labels.push(label.name);
  }
  async unassign(workspaceId: string, name: string) {
    if (this.fail) throw this.fail;
    this.calls.push(`-${workspaceId} ${name}`);
    const workspace = this.workspaceList.find((item) => item.id === workspaceId)!;
    workspace.labels = workspace.labels.filter((label) => label !== name);
  }
  async recolor(label: StateLabel) { this.calls.push(`color ${label.name}`); }
}

function harness() {
  const clock = { now: 1_000_000 };
  const reads: string[][] = [];
  const linearStates = new Map<string, IssueStatus>([["i1", { status: "In Progress", statusType: "started", completedAt: null }], ["i2", { status: "Todo", statusType: "unstarted", completedAt: null }]]);
  const daemon = new FakeDaemon();
  const labels = new StateLabels({
    linear: { issueStatuses: async (ids) => { reads.push(ids); return new Map(ids.filter((id) => linearStates.has(id)).map((id) => [id, linearStates.get(id)!])); } },
    daemon: async () => daemon,
    now: () => clock.now,
  });
  return { clock, reads, linearStates, daemon, labels };
}

async function captureErrors(run: (errors: string[]) => Promise<void>) {
  const original = console.error;
  const errors: string[] = [];
  console.error = (line: string) => { errors.push(line); };
  try { await run(errors); } finally { console.error = original; }
}

test("one batched Linear read per cycle; written states and fresh reads cost no read; a state change swaps the label", async () => {
  const h = harness();
  await h.labels.sync();
  assert.deepEqual(h.reads, [["i1", "i2"]]);
  assert.deepEqual(h.daemon.calls, ["+w1 Linear: In Progress", "+w2 Linear: Todo"]);
  h.daemon.calls.length = 0;
  await h.labels.sync();
  assert.equal(h.reads.length, 1, "states read this cycle are not read again");
  assert.deepEqual(h.daemon.calls, []);
  h.labels.noteState("i1", { name: "In Review", type: "started" });
  await h.labels.sync();
  assert.equal(h.reads.length, 1, "a state the plugin wrote is not read back");
  assert.deepEqual(h.daemon.calls, ["+w1 Linear: In Review", "-w1 Linear: In Progress"]);
  h.daemon.calls.length = 0;
  h.clock.now += 60_000;
  h.linearStates.set("i1", { status: "In Review", statusType: "started", completedAt: null });
  h.linearStates.set("i2", { status: "Done", statusType: "completed", completedAt: "t" });
  await h.labels.sync();
  assert.deepEqual(h.reads[1], ["i1", "i2"], "the next cycle reads every ticket again");
  assert.deepEqual(h.daemon.calls, ["+w2 Linear: Done", "-w2 Linear: Todo"]);
});

test("a ticket Linear does not return keeps its workspace as it is and is not asked about every cycle", async () => {
  const h = harness();
  h.linearStates.delete("i2");
  h.daemon.workspaceList[1].labels = ["Linear: Todo"];
  await h.labels.sync();
  h.clock.now += 60_000;
  await h.labels.sync();
  assert.deepEqual(h.reads, [["i1", "i2"], ["i1"]]);
  assert.deepEqual(h.daemon.workspaceList[1].labels, ["Linear: Todo"]);
});

test("daemon and Linear failures never throw, are logged once per cause, and end a failing round early", async () => {
  await captureErrors(async (errors) => {
    const h = harness();
    h.daemon.fail = new Error("Unknown request type: workspace.label.assignment.set.request");
    h.daemon.agents = [...h.daemon.agents, agent("w3", "i1", "TUC-1", "t"), agent("w4", "i2", "TUC-2", "t")];
    h.daemon.workspaceList.push({ id: "w4", name: "TUC-2: c", labels: [] });
    await h.labels.sync();
    await h.labels.sync();
    assert.equal(errors.filter((line) => line.includes("Unknown request type")).length, 1);
    assert.equal(errors.filter((line) => line.includes("stopped this round")).length, 1);
    const beforeLimit = errors.length;
    const offline = new StateLabels({ linear: { issueStatuses: async () => { throw new RateLimitedError("app", Date.now() + 60_000); } }, daemon: async () => h.daemon });
    await offline.sync();
    await offline.sync();
    assert.equal(errors.length - beforeLimit, 1, "a repeated pool pause is logged once");
    const disconnected = new StateLabels({ linear: { issueStatuses: async () => new Map() }, daemon: async () => null });
    await disconnected.sync();
    await disconnected.sync();
    assert.equal(errors.filter((line) => line.includes("no connection")).length, 1);
  });
});

test("the plugin's own state changes reach the labels from the mutation's answer, failed ones do not", async () => {
  const written: string[] = [];
  let success = true;
  const post: Post = async (_key, query, variables) => {
    if (query === UPDATE_ISSUE_STATE_QUERY) return { issueUpdate: { success, issue: { id: variables.id, state: { name: "In Review", type: "started" } } } };
    return { issue: { id: "i1", identifier: "TUC-1", state: { id: "ip", name: "In Progress", type: "started" }, team: { id: "t1" }, labels: { nodes: [] }, attachments: { nodes: [] }, inverseRelations: { nodes: [] } } };
  };
  const linear = new LinearService(new Credentials("/unused", "env-key"), post);
  linear.onStateWritten((issueId, state) => written.push(`${issueId} ${state.name} ${state.type}`));
  await linear.moveToState("i1", "review");
  success = false;
  await assert.rejects(linear.moveToState("i1", "review"));
  assert.deepEqual(written, ["i1 In Review started"]);
});
