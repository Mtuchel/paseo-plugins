import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { IssueState } from "./linear";
import { DEFAULT_DISPATCH, type PluginSettings } from "./settings";
import { MAX_SUMMARY_LENGTH, turnPullRequests, turnReply, Writeback } from "./writeback";

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];

const allOn: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true,
  dispatch: DEFAULT_DISPATCH,
  writeback: { status: true, summaries: true, blocked: true, pullRequests: true },
};
const root: PluginHookAgent = { id: "agent-1", workspaceId: "w1", parentAgentId: null, provider: "claude", cwd: "/repo", title: "ENG-1: Fix sign-in" };

const toolCall = (output: string) => ({ type: "tool_call", callId: "c1", name: "shell", status: "completed", detail: { type: "unknown", input: null, output }, error: null }) as unknown as Timeline[number];

class FakeLinear {
  readonly writes: string[] = [];
  state: IssueState = { id: "issue-1", status: "Todo", statusType: "unstarted", teamId: "t1", labels: [{ id: "l1", name: "paseo-running" }], attachmentUrls: [] };
  async issueState() { this.writes.push("state"); return this.state; }
  async markInProgress(issue: { id: string }) { this.writes.push(`in-progress ${issue.id}`); return { changed: true }; }
  async comment(_id: string, body: string) { this.writes.push(`comment: ${body}`); }
  async addLabel(_id: string, name: string) { this.writes.push(`+${name}`); }
  async removeLabel(_id: string, name: string) { this.writes.push(`-${name}`); }
  async linkUrl(_id: string, url: string) { this.writes.push(`link ${url}`); }
  async moveToReview() { this.writes.push("review"); return { changed: true }; }
}

function paseoWithLabels(labels: Record<string, string>): PaseoApi {
  return { agents: { ref: () => ({ refresh: async () => ({ agent: { labels } }) }) } } as unknown as PaseoApi;
}
const linked = paseoWithLabels({ "linear.issueId": "issue-1" });

test("the turn reply is the assistant text after the last user message, joined across streamed pieces", () => {
  const timeline: Timeline = [
    { type: "user_message", text: "first" },
    { type: "assistant_message", text: "old answer" },
    { type: "user_message", text: "second" },
    { type: "assistant_message", text: "Fixed the " },
    toolCall("ok"),
    { type: "assistant_message", text: "bug." },
  ];
  assert.equal(turnReply(timeline), "Fixed the bug.");
});

test("pull requests come only from this turn's tool output, deduplicated", () => {
  const timeline: Timeline = [
    toolCall("https://github.com/o/r/pull/1"),
    { type: "user_message", text: "see https://github.com/o/r/pull/2" },
    { type: "assistant_message", text: "Compare https://github.com/o/r/pull/3" },
    toolCall("Created https://github.com/o/r/pull/4\nhttps://github.com/o/r/pull/4"),
  ];
  assert.deepEqual(turnPullRequests(timeline), ["https://github.com/o/r/pull/4"]);
});

test("agents without a Linear link and subagents never touch Linear", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn });
  const event = { turnId: "t", outcome: { kind: "completed" as const }, timeline: [{ type: "assistant_message" as const, text: "done" }] };
  await writeback.turnEnded({ ...event, agent: root }, paseoWithLabels({}));
  await writeback.turnEnded({ ...event, agent: { ...root, id: "child", parentAgentId: "agent-1" } }, linked);
  assert.deepEqual(linear.writes, []);
});

test("a completed turn posts its reply, truncated, and links a new pull request then moves to review", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn });
  const long = "x".repeat(MAX_SUMMARY_LENGTH + 50);
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [toolCall("https://github.com/o/r/pull/9"), { type: "assistant_message", text: long }] }, linked);
  const comment = linear.writes.find((write) => write.startsWith("comment: "))!;
  assert.match(comment, /^comment: \*\*ENG-1: Fix sign-in\*\* \(Paseo\) finished a turn:/);
  assert.match(comment, /truncated; the full reply is in Paseo\)$/);
  assert.ok(comment.length < MAX_SUMMARY_LENGTH + 200);
  assert.deepEqual(linear.writes.slice(1), ["-paseo-blocked", "link https://github.com/o/r/pull/9", "review"]);
});

test("each write-back toggle gates its own effect", async () => {
  const linear = new FakeLinear();
  const off = { ...allOn, writeback: { status: false, summaries: false, blocked: false, pullRequests: false } };
  const writeback = new Writeback(linear, { read: async () => off });
  await writeback.turnStarted({ agent: root, turnId: "t" }, linked);
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "failed", error: { message: "boom" } }, timeline: [toolCall("https://github.com/o/r/pull/9")] }, linked);
  await writeback.permissionRequested({ agent: root, request: { id: "p", provider: "claude", name: "Bash", kind: "tool" } }, linked);
  assert.deepEqual(linear.writes, []);
});

test("the first turn marks the ticket in progress once per agent", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn });
  await writeback.turnStarted({ agent: root, turnId: "a" }, linked);
  await writeback.turnStarted({ agent: root, turnId: "b" }, linked);
  assert.deepEqual(linear.writes, ["state", "in-progress issue-1"]);
});

test("a pending question marks the ticket blocked until it is answered", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn });
  await writeback.permissionRequested({ agent: root, request: { id: "p", provider: "claude", name: "AskUser", kind: "question", title: "Which database?" } }, linked);
  await writeback.permissionResolved({ agent: root, requestId: "p", resolution: { behavior: "allow" } }, linked);
  assert.deepEqual(linear.writes, ["comment: **ENG-1: Fix sign-in** (Paseo) is waiting for an answer: Which database?", "+paseo-blocked", "-paseo-blocked"]);
});

test("archiving clears the running marker and reports only when no pull request was linked", async () => {
  const linear = new FakeLinear();
  const writeback = new Writeback(linear, { read: async () => allOn });
  await writeback.archived({ agent: root, archivedAt: "now" }, linked);
  assert.deepEqual(linear.writes, ["state", "-paseo-running", "-paseo-blocked", "comment: **ENG-1: Fix sign-in** (Paseo) was archived without a linked pull request."]);

  const withPr = new FakeLinear();
  withPr.state = { ...withPr.state, attachmentUrls: ["https://github.com/o/r/pull/9"] };
  await new Writeback(withPr, { read: async () => allOn }).archived({ agent: root, archivedAt: "now" }, linked);
  assert.ok(!withPr.writes.some((write) => write.startsWith("comment")));
});

test("a Linear failure is logged and never thrown back into the daemon hook", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  linear.comment = async () => { throw new Error("rate limited"); };
  const writeback = new Writeback(linear, { read: async () => allOn });
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "done" }] }, linked);
  assert.match(String(errors.mock.calls[0].arguments[1]), /rate limited/);
});
