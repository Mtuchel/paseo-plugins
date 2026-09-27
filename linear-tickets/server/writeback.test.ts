import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { IssueState } from "./linear";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { MAX_SUMMARY_LENGTH, turnPullRequests, turnReply, Writeback } from "./writeback";

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];

const allOn: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true,
  dispatch: DEFAULT_DISPATCH,
  writeback: { status: true, summaries: true, blocked: true, pullRequests: true, mentions: true, autoResume: false },
};
const root: PluginHookAgent = { id: "agent-1", workspaceId: "w1", parentAgentId: null, provider: "claude", cwd: "/repo", title: "ENG-1: Fix sign-in" };

const toolCall = (output: string): Timeline[number] => ({ type: "tool_call", callId: "c1", name: "bash", status: "completed", detail: { type: "shell", command: "gh pr create", output }, error: null });

class FakeLinear {
  readonly writes: string[] = [];
  state: IssueState = { id: "issue-1", identifier: "ENG-1", projectId: null, creatorId: null, blockedBy: [], status: "Todo", statusId: "todo", statusType: "unstarted", teamId: "t1", labels: [{ id: "l1", name: "paseo-running" }], attachmentUrls: [] };
  private comments = 0;
  async issueState() { this.writes.push("state"); return this.state; }
  async markInProgress(issue: { id: string }) { this.writes.push(`in-progress ${issue.id}`); return { changed: true }; }
  async moveToStateNamed(id: string, name: string) {
    this.writes.push(`move ${id} ${name}`);
    if (this.state.status === name) return { changed: false };
    this.state = { ...this.state, status: name, statusId: name.toLowerCase(), statusType: "started" };
    return { changed: true };
  }
  async moveToState(_id: string, stateId: string) { this.writes.push(`restore ${stateId}`); }
  async comment(_id: string, body: string) { this.writes.push(`comment: ${body}`); }
  async createComment(_id: string, body: string) { this.writes.push(`new comment: ${body}`); return `c${++this.comments}`; }
  async updateComment(id: string, body: string) { this.writes.push(`edit ${id}: ${body}`); }
  async viewerId() { return "owner"; }
  async userUrl(id: string) { return `https://linear.app/acme/profiles/${id}`; }
  async addLabel(_id: string, name: string) { this.writes.push(`+${name}`); this.state = { ...this.state, labels: [...this.state.labels, { id: name, name }] }; }
  async removeLabel(_id: string, name: string) { this.writes.push(`-${name}`); this.state = { ...this.state, labels: this.state.labels.filter((label) => label.name !== name) }; }
  async linkUrl(_id: string, url: string) { this.writes.push(`link ${url}`); }
  async moveToReview() { this.writes.push("review"); return { changed: true }; }
}

function paseoWithLabels(labels: Record<string, string>): PaseoApi {
  return { agents: { ref: () => ({ refresh: async () => ({ agent: { labels } }) }), list: async () => ({ entries: [] }) } } as unknown as PaseoApi;
}
const linked = paseoWithLabels({ "linear.issueId": "issue-1" });

test("the turn reply is the final answer after the last tool call, streamed pieces joined and repeats dropped", () => {
  const timeline: Timeline = [
    { type: "user_message", text: "first" },
    { type: "assistant_message", text: "old answer" },
    { type: "user_message", text: "second" },
    { type: "assistant_message", text: "Let me check." },
    toolCall("ok"),
    { type: "assistant_message", text: "Fixed the " },
    { type: "assistant_message", text: "bug." },
    { type: "assistant_message", text: "bug." },
  ];
  assert.equal(turnReply(timeline), "Fixed the bug.");
  // Seen live: a provider repeated its final message once complete.
  assert.equal(turnReply([{ type: "user_message", text: "go" }, toolCall("ok"), { type: "assistant_message", text: "DONE Blue" }, { type: "assistant_message", text: "DONE Blue" }]), "DONE Blue");
});

test("pull requests come only from this turn's shell output, deduplicated", () => {
  const timeline: Timeline = [
    toolCall("https://github.com/o/r/pull/1"),
    { type: "user_message", text: "see https://github.com/o/r/pull/2" },
    { type: "assistant_message", text: "Compare https://github.com/o/r/pull/3" },
    toolCall("Created https://github.com/o/r/pull/4\nhttps://github.com/o/r/pull/4"),
    // A file write quoting the ticket (seen live: an agent copying the ticket into PLAN.md).
    { type: "tool_call", callId: "c2", name: "write", status: "completed", detail: { type: "write", filePath: "PLAN.md", content: "see https://github.com/o/r/pull/5" }, error: null },
  ];
  assert.deepEqual(turnPullRequests(timeline), ["https://github.com/o/r/pull/4"]);
});

test("agents without a Linear link and subagents never touch Linear", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  const event = { turnId: "t", outcome: { kind: "completed" as const }, timeline: [{ type: "assistant_message" as const, text: "done" }] };
  await writeback.turnEnded({ ...event, agent: root }, paseoWithLabels({}));
  await writeback.turnEnded({ ...event, agent: { ...root, id: "child", parentAgentId: "agent-1" } }, linked);
  assert.deepEqual(linear.writes, []);
});

test("a completed turn posts its reply, truncated, and links a new pull request then moves to review", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  const long = "x".repeat(MAX_SUMMARY_LENGTH + 50);
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [toolCall("https://github.com/o/r/pull/9"), { type: "assistant_message", text: long }] }, linked);
  const comment = linear.writes.find((write) => write.startsWith("comment: "))!;
  assert.match(comment, /^comment: \*\*ENG-1: Fix sign-in\*\* \(Paseo\) finished a turn:/);
  assert.match(comment, /truncated; the full reply is in Paseo\)$/);
  assert.ok(comment.length < MAX_SUMMARY_LENGTH + 200);
  assert.deepEqual(linear.writes.filter((write) => write !== comment), ["state", "-paseo-needs-you", "-paseo-blocked", "link https://github.com/o/r/pull/9", "review"]);
});

test("each write-back toggle gates its own effect", async () => {
  const linear = new FakeLinear();
  const off = { ...allOn, writeback: DEFAULT_WRITEBACK };
  const writeback = new Writeback(linear, { read: async () => off }, undefined, 0);
  await writeback.turnStarted({ agent: root, turnId: "t" }, linked);
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "failed", error: { message: "boom" } }, timeline: [toolCall("https://github.com/o/r/pull/9")] }, linked);
  await writeback.permissionRequested({ agent: root, request: { id: "p", provider: "claude", name: "Bash", kind: "tool" } }, linked);
  assert.deepEqual(linear.writes, []);
});

test("the first turn marks the ticket in progress once per agent", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  await writeback.turnStarted({ agent: root, turnId: "a" }, linked);
  await writeback.turnStarted({ agent: root, turnId: "b" }, linked);
  assert.deepEqual(linear.writes, ["state", "in-progress issue-1"]);
});

test("a plan-first agent's first turn moves its ticket to Planning, unless the ticket already started", async () => {
  const planFirst = paseoWithLabels({ "linear.issueId": "issue-1", "linear.untrusted": "1" });
  const fresh = new FakeLinear();
  await new Writeback(fresh, { read: async () => allOn }, undefined, 0).turnStarted({ agent: root, turnId: "a" }, planFirst);
  assert.deepEqual(fresh.writes, ["state", "move issue-1 Planning"]);
  const approved = new FakeLinear();
  approved.state = { ...approved.state, status: "In Progress", statusType: "started" };
  await new Writeback(approved, { read: async () => allOn }, undefined, 0).turnStarted({ agent: root, turnId: "a" }, planFirst);
  assert.deepEqual(approved.writes, ["state"]);
});

test("a model switch between turns is announced in the panel and recorded in the progress comment", async () => {
  const linear = new FakeLinear();
  const panel: string[] = [];
  const records: unknown[] = [];
  const bridge = {
    sessions: { sessionFor: async () => ({ sessionId: "s1" }), holdIfStopped: async () => false, follow: async () => {}, say: async (_s: string, type: string, body: string) => { panel.push(`${type}: ${body}`); } },
    handover: { update: async (_issue: unknown, _agent: unknown, change: unknown) => { records.push(change); } },
  };
  const writeback = new Writeback(linear, { read: async () => allOn }, bridge as never, 0);
  // Plannotator restores its pre-planning model inside the provider; the runtime report wins.
  let runtime = "anthropic/claude-opus-5-5";
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1", "linear.identifier": "ENG-1" }, model: "anthropic/claude-opus-5-5", runtimeInfo: { model: runtime, thinkingOptionId: "medium" } } }) }) } } as unknown as PaseoApi;
  await writeback.turnStarted({ agent: root, turnId: "a" }, paseo);
  runtime = "deepseek/deepseek-v4-flash";
  await writeback.turnStarted({ agent: root, turnId: "b" }, paseo);
  assert.deepEqual(panel, [
    "thought: Working… (anthropic/claude-opus-5-5 · thinking medium)",
    "thought: Model changed: anthropic/claude-opus-5-5 · thinking medium → deepseek/deepseek-v4-flash · thinking medium",
    "thought: Working… (deepseek/deepseek-v4-flash · thinking medium)",
  ]);
  assert.deepEqual(records, [{ model: "anthropic/claude-opus-5-5 · thinking medium" }, { model: "deepseek/deepseek-v4-flash · thinking medium" }]);
});

test("a question moves the ticket to Needs input, labels it and mentions the owner in one comment per waiting period", async () => {
  const linear = new FakeLinear();
  linear.state = { ...linear.state, status: "In Progress", statusId: "ip", statusType: "started", creatorId: "creator" };
  let pending: { id: string }[] = [];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1" }, pendingPermissions: pending } }) }) } } as unknown as PaseoApi;
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  const ask = async (id: string, title: string) => {
    pending = [{ id }];
    await writeback.permissionRequested({ agent: root, request: { id, provider: "claude", name: "AskUser", kind: "question", title } }, paseo);
  };
  const waiting = (question: string) => `https://linear.app/acme/profiles/creator **ENG-1: Fix sign-in** (Paseo) is waiting for an answer: ${question}\n\nReply here with “@paseo <your answer>”.`;

  await ask("q1", "Question 1/2");
  assert.deepEqual(linear.writes.splice(0), ["state", "move issue-1 Needs input", "+paseo-needs-you", `new comment: ${waiting("Question 1/2")}`]);
  // The next question arrives before the settle wait ends: the ticket stays in Needs input and the comment is edited.
  pending = [{ id: "q2" }];
  await writeback.permissionResolved({ agent: root, requestId: "q1", resolution: { behavior: "allow" } }, paseo);
  await ask("q2", "Question 2/2");
  assert.deepEqual(linear.writes.splice(0), ["state", "move issue-1 Needs input", `edit c1: ${waiting("Question 2/2")}`]);

  pending = [];
  await writeback.permissionResolved({ agent: root, requestId: "q2", resolution: { behavior: "allow" } }, paseo);
  assert.deepEqual(linear.writes.splice(0), ["state", "-paseo-needs-you", "restore ip"]);
  // A later wait is a new period with a fresh comment.
  linear.state = { ...linear.state, status: "In Progress", statusId: "ip" };
  await ask("q3", "Another one?");
  assert.deepEqual(linear.writes.splice(0), ["state", "move issue-1 Needs input", "+paseo-needs-you", `new comment: ${waiting("Another one?")}`]);
});

test("the previous state is not restored when someone moved the ticket out of Needs input meanwhile", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  await writeback.permissionRequested({ agent: root, request: { id: "p", provider: "claude", name: "Bash", kind: "tool", title: "Allow tool: Bash" } }, linked);
  linear.state = { ...linear.state, status: "Canceled", statusId: "canceled", statusType: "canceled" };
  linear.writes.length = 0;
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "failed", error: { message: "boom" } }, timeline: [] }, linked);
  // Errors, not questions, get the blocked label.
  assert.deepEqual(linear.writes, ["state", "-paseo-needs-you", "comment: **ENG-1: Fix sign-in** (Paseo) stopped with an error: boom", "+paseo-blocked"]);
});

test("archiving clears the running marker and reports only when no pull request was linked", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  await writeback.archived({ agent: root, archivedAt: "now" }, linked);
  assert.deepEqual(linear.writes, ["state", "-paseo-running", "-paseo-blocked", "-paseo-needs-you", "comment: **ENG-1: Fix sign-in** (Paseo) was archived without a linked pull request."]);

  const withPr = new FakeLinear();
  withPr.state = { ...withPr.state, attachmentUrls: ["https://github.com/o/r/pull/9"] };
  await new Writeback(withPr, { read: async () => allOn }, undefined, 0).archived({ agent: root, archivedAt: "now" }, linked);
  assert.ok(!withPr.writes.some((write) => write.startsWith("comment")));
});

test("a Linear failure is logged and never thrown back into the daemon hook", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  linear.comment = async () => { throw new Error("rate limited"); };
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "done" }] }, linked);
  assert.match(String(errors.mock.calls[0].arguments[1]), /rate limited/);
});
