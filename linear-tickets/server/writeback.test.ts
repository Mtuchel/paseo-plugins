import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
// Not mocked: the tests below mock setTimeout and Date only.
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { LinearService, postGraphQL, type IssueState } from "./linear";
import { GitHubRateLimitedError } from "./pr-watch";
import { ticketPullRequest, type PullRequestText } from "./pull-request-check";
import { RateBudget, RateLimitedError, withPriority } from "./rate-budget";
import { DEFAULT_WORKTREE_SHARDS, DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { NeedsYouIssues } from "./needs-you";
import { MAX_SUMMARY_LENGTH, ownerRequest, turnPullRequests, turnReply, Writeback } from "./writeback";
import { DecisionLog } from "./owner-decisions";
import { Handover } from "./handover";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";

// Writebacks built without an outbox path keep theirs here, never in the real Paseo home.
process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "paseo-writeback-home-"));
const outboxPath = () => join(mkdtempSync(join(tmpdir(), "paseo-writeback-outbox-")), "writeback-outbox.json");

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];

const allOn: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true,
  dispatch: DEFAULT_DISPATCH,
  writeback: { status: true, summaries: true, blocked: true, pullRequests: true, mentions: true, autoResume: false, watchdog: true }, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};
const root: PluginHookAgent = { id: "agent-1", workspaceId: "w1", parentAgentId: null, provider: "claude", cwd: "/repo", title: "ENG-1: Fix sign-in" };

const toolCall = (output: string): Timeline[number] => ({ type: "tool_call", callId: "c1", name: "bash", status: "completed", detail: { type: "shell", command: "gh pr create", output }, error: null });
// The pull request check for tests whose pull requests are the ticket's; it never runs gh.
const accept = async () => ({ link: true as const });

class FakeLinear {
  readonly writes: string[] = [];
  state: IssueState = { id: "issue-1", identifier: "ENG-1", projectId: null, creatorId: null, blockedBy: [], status: "Todo", statusId: "todo", statusType: "unstarted", teamId: "t1", labels: [{ id: "l1", name: "paseo-running" }], attachmentUrls: [], priority: 0, createdAt: "", unblocks: 0 };
  // Other issues by id (the "Needs you" sub-issues); `state` is the ticket itself.
  readonly others = new Map<string, IssueState>();
  private comments = 0;
  async issueState(id = "issue-1") {
    this.writes.push(id === this.state.id ? "state" : `state ${id}`);
    const found = id === this.state.id ? this.state : this.others.get(id);
    if (!found) throw new Error("Linear did not return this issue. Check that you have access to it.");
    return found;
  }
  async createIssue(input: { title: string; parentId?: string; assigneeId?: string; startedState?: string }) {
    const id = `sub-${this.others.size + 1}`;
    const identifier = `ENG-${this.others.size + 2}`;
    this.writes.push(`create ${id} "${input.title}" under ${input.parentId} for ${input.assigneeId} in ${input.startedState}`);
    this.others.set(id, { ...this.state, id, identifier, status: input.startedState ?? "Todo", statusId: "ni", statusType: "started", labels: [] });
    return { id, identifier, url: "" };
  }
  async complete(id: string) { this.writes.push(`complete ${id}`); this.others.set(id, { ...this.others.get(id)!, status: "Done", statusType: "completed" }); }
  async markInProgress(issue: { id: string }) { this.writes.push(`in-progress ${issue.id}`); return { changed: true }; }
  async moveToStateNamed(id: string, name: string) {
    this.writes.push(`move ${id} ${name}`);
    if (this.state.status === name) return { changed: false };
    this.state = { ...this.state, status: name, statusId: name.toLowerCase(), statusType: "started" };
    return { changed: true };
  }
  async moveToState(_id: string, stateId: string) { this.writes.push(`restore ${stateId}`); }
  async comment(_id: string, body: string) { this.writes.push(`comment: ${body}`); }
  async upsertComment(id: string, body: string, commentId: string | null) {
    if (commentId) { this.writes.push(`edit ${commentId}: ${body}`); return commentId; }
    this.writes.push(id === this.state.id ? `new comment: ${body}` : `new comment on ${id}: ${body}`);
    return `c${++this.comments}`;
  }
  // Users Linear reports as apps (the Paseo app, other integrations); everyone else is a person.
  readonly apps = new Set(["paseo-app"]);
  async isPerson(id: string) { return !this.apps.has(id); }
  async viewerId() { return "owner"; }
  async userUrl(id: string) { return `https://linear.app/acme/profiles/${id}`; }
  async addLabel(id: string, name: string) {
    if (id !== this.state.id) { this.writes.push(`+${name} on ${id}`); return; }
    this.writes.push(`+${name}`);
    this.state = { ...this.state, labels: [...this.state.labels, { id: name, name }] };
  }
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
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), undefined, accept);
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

test("a required-plan agent's first turn moves its ticket to Planning, unless the ticket already started", async () => {
  const planFirst = paseoWithLabels({ "linear.issueId": "issue-1", "linear.plan": "required" });
  const fresh = new FakeLinear();
  await new Writeback(fresh, { read: async () => allOn }, undefined, 0).turnStarted({ agent: root, turnId: "a" }, planFirst);
  assert.deepEqual(fresh.writes, ["state", "move issue-1 Planning"]);
  const approved = new FakeLinear();
  approved.state = { ...approved.state, status: "In Progress", statusType: "started" };
  await new Writeback(approved, { read: async () => allOn }, undefined, 0).turnStarted({ agent: root, turnId: "a" }, planFirst);
  assert.deepEqual(approved.writes, ["state"]);
});

test("turn-start state changes keep cold prerequisites in the owner reserve at 3% points", async (t) => {
  for (const planFirst of [false, true]) {
    const budget = new RateBudget(() => 0);
    const headers = { "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "4500", "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": "60000", "x-complexity": "100" };
    for (const pool of ["key", "app"] as const) budget.acquire(pool, "owner").done(new Headers(headers), false);
    let stateId = "todo";
    let mutations = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body));
      const operation = /^(?:query|mutation) (\w+)/.exec(query)?.[1];
      let data;
      if (operation === "issueState") data = { issue: { id: "issue-1", state: { id: stateId, name: "Todo", type: "unstarted" }, team: { id: "team-1" } } };
      else if (operation === "teamStates") data = { team: { states: { nodes: [{ id: "coding", name: "In Progress", type: "started", position: 1 }, { id: "planning", name: "Planning", type: "started", position: 2 }] } } };
      else if (operation === "issueUpdateState") {
        stateId = variables.stateId;
        mutations++;
        data = { issueUpdate: { success: true, issue: { state: { name: planFirst ? "Planning" : "In Progress", type: "started" } } } };
      } else throw new Error(`unexpected operation ${operation}`);
      return new Response(JSON.stringify({ data }), { headers });
    });
    const post = (key: string, query: string, variables: Record<string, unknown>) => postGraphQL(key, query, variables, budget);
    const linear = new LinearService(new Credentials("/unused", "owner-key"), post, new AgentApi({ accessToken: async () => "app-token" }, post));
    const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath());
    const paseo = paseoWithLabels({ "linear.issueId": "issue-1", ...(planFirst ? { "linear.plan": "required" } : {}) });
    await withPriority("background", "status prerequisite test", () => writeback.turnStarted({ agent: root, turnId: "a" }, paseo));
    assert.equal(stateId, planFirst ? "planning" : "coding");
    await writeback.turnStarted({ agent: root, turnId: "b" }, paseo);
    assert.equal(mutations, 1, "a successful transition is not repeated on the next turn");
  }
});

test("a refused turn-start prerequisite does not consume the first state transition", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  const original = linear.issueState.bind(linear);
  let limited = true;
  linear.issueState = async () => {
    if (limited) throw new RateLimitedError("app", 60_000);
    return original();
  };
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath());
  await writeback.turnStarted({ agent: root, turnId: "a" }, linked);
  assert.deepEqual(linear.writes, []);
  limited = false;
  t.mock.timers.tick(60_000);
  await until(() => linear.writes.includes("in-progress issue-1"));
  await writeback.turnStarted({ agent: root, turnId: "b" }, linked);
  assert.equal(linear.writes.filter((write) => write === "in-progress issue-1").length, 1);
});

test("a model switch between turns is announced in the panel and recorded in the progress comment", async () => {
  const linear = new FakeLinear();
  const panel: string[] = [];
  const records: unknown[] = [];
  const bridge = {
    sessions: { sessionFor: async () => ({ sessionId: "s1" }), holdIfStopped: async () => false, follow: async () => {}, say: async (_s: string, type: string, body: string) => { panel.push(`${type}: ${body}`); } },
    handover: { update: async (_issue: unknown, _agent: unknown, change: unknown) => { records.push(change); }, waiting: async () => null },
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

async function ownerQuestionAdmission(t: TestContext, endOfTurn: boolean): Promise<void> {
  const budget = new RateBudget(() => 0);
  const headers = { "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "4500", "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": "60000", "x-complexity": "100" };
  for (const pool of ["key", "app"] as const) budget.acquire(pool, "owner").done(new Headers(headers), false);
  const sent: { operation: string; variables: Record<string, unknown> }[] = [];
  const data: Record<string, object> = {
    issueState: { issue: { id: "issue-1", identifier: "ENG-1", state: { id: "coding", name: "In Progress", type: "started" }, team: { id: "team-1" }, labels: { nodes: [] } } },
    viewerCheck: { viewer: { id: "owner" } },
    teamStates: { team: { states: { nodes: [{ id: "needs-input", name: "Needs input", type: "started", position: 1 }] } } },
    issueUpdateState: { issueUpdate: { success: true, issue: { id: "issue-1", state: { id: "needs-input", name: "Needs input", type: "started" } } } },
    labelByName: { issueLabels: { nodes: [{ id: "needs-you", name: "paseo-needs-you" }] } },
    addLabel: { issueAddLabel: { success: true } },
    userUrl: { user: { url: "https://linear.app/acme/profiles/owner" } },
    comment: { commentCreate: { success: true, comment: { id: "comment-1" } } },
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body: { query: string; variables: Record<string, unknown> } = JSON.parse(String(init?.body));
    const operation = body.query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? "?";
    sent.push({ operation, variables: body.variables });
    assert.ok(data[operation], `unexpected Linear operation ${operation}`);
    return new Response(JSON.stringify({ data: data[operation] }), { headers });
  });
  const post = (key: string, query: string, variables: Record<string, unknown>) => postGraphQL(key, query, variables, budget);
  const linear = new LinearService(new Credentials("/unused", "owner-key"), post, new AgentApi({ accessToken: async () => "app-token" }, post));
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath());
  await withPriority("background", "owner question test", () => endOfTurn
    ? writeback.turnEnded({ agent: root, turnId: "question-turn", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "Should I deploy?" }] }, linked)
    : writeback.permissionRequested({ agent: root, request: { id: "question-1", provider: "claude", name: "AskUser", kind: "question", title: "Should I deploy?" } }, linked));
  assert.equal(sent.filter((call) => call.operation === "comment").length, 1, "only the owner notification spends the reserve");
  assert.equal(sent.find((call) => call.operation === "issueUpdateState")?.variables.stateId, "needs-input");
  assert.deepEqual(sent.find((call) => call.operation === "addLabel")?.variables, { id: "issue-1", labelId: "needs-you" });
  const commentInput = sent.find((call) => call.operation === "comment")?.variables.input;
  assert.ok(commentInput && typeof commentInput === "object" && "body" in commentInput && typeof commentInput.body === "string");
  assert.match(commentInput.body, /profiles\/owner/);
  assert.ok(commentInput.body.includes("Should I deploy?"));
}

test("an owner question writes Needs input, its label and comment through real admission at 3% points", (t) => ownerQuestionAdmission(t, false));
test("a completed turn notifies the owner at 3% before its ordinary progress work is refused", (t) => ownerQuestionAdmission(t, true));

test("a turn that ends asking the owner waits in Needs input until the agent's next turn starts", async () => {
  const linear = new FakeLinear();
  linear.state = { ...linear.state, status: "In Progress", statusId: "ip", statusType: "started", creatorId: "creator" };
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  const end = (text: string) => writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text }] }, linked);

  await end("The stack is ready.\n\nShould I push it and open the draft PRs?");
  const delivered = linear.writes.splice(0);
  assert.ok(delivered.includes("move issue-1 Needs input"));
  assert.ok(delivered.includes("+paseo-needs-you"));
  assert.ok(delivered.some((write) => write.startsWith("new comment: ") && write.includes("profiles/creator") && write.includes("Should I push it and open the draft PRs?")));
  // The owner's reply starts the next turn: the ticket goes back where it was.
  await writeback.turnStarted({ agent: root, turnId: "t2" }, linked);
  assert.deepEqual(linear.writes.splice(0).filter((write) => write !== "in-progress issue-1"), ["state", "-paseo-needs-you", "restore ip", "state"]);
  await writeback.turnStarted({ agent: root, turnId: "t3" }, linked);
  assert.deepEqual(linear.writes.splice(0), []);
  await end("Pushed; the PRs are #4 and #5.");
  assert.ok(!linear.writes.includes("move issue-1 Needs input"));
});

test("only replies that hand the next step to the owner count as waiting, and plan approval never does", () => {
  assert.equal(ownerRequest("Merged #12 and the staging deploy succeeded."), null);
  assert.equal(ownerRequest("Run `curl 'https://x/api?q=1'` to check.\n\n```ts\nconst a = b ? c : d;\n```"), null);
  assert.equal(ownerRequest("Approve or annotate the plan in Plannotator. Should I split AC-3 out?"), null);
  assert.equal(ownerRequest("Done.\n\nThe `approved-test-change` label needs your OK, then I merge.\n\nPLAN.md is untracked."), "The `approved-test-change` label needs your OK, then I merge.\n\nPLAN.md is untracked.");
  // A question far above the closing report is history, not the open ask.
  assert.equal(ownerRequest(`Should I start?\n\n${"Report line.\n\n".repeat(150)}All checks pass.`), null);
});

test("a wait on a closed ticket opens a Needs you sub-issue instead; follow-ups edit its comment and the answer closes it", async () => {
  const linear = new FakeLinear();
  linear.state = { ...linear.state, status: "Done", statusId: "done", statusType: "completed", creatorId: "creator" };
  const needsYou = new NeedsYouIssues(mkdtempSync(join(tmpdir(), "needs-you-")));
  let pending: { id: string }[] = [];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1" }, pendingPermissions: pending } }) }) } } as unknown as PaseoApi;
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), needsYou);
  const ask = async (id: string, title: string) => {
    pending = [{ id }];
    await writeback.permissionRequested({ agent: root, request: { id, provider: "claude", name: "AskUser", kind: "question", title } }, paseo);
  };
  const waiting = (question: string) => `https://linear.app/acme/profiles/creator **ENG-1: Fix sign-in** (Paseo) is waiting for an answer: ${question}\n\nReply here with “@paseo <your answer>”.`;

  await ask("q1", "Enqueue #850 yourself?");
  assert.deepEqual(linear.writes.splice(0), ['state', 'create sub-1 "Needs you: Enqueue #850 yourself?" under issue-1 for creator in Needs input', "+paseo-needs-you on sub-1", `new comment on sub-1: ${waiting("Enqueue #850 yourself?")}`]);
  assert.deepEqual(await needsYou.all(), [{ id: "sub-1", identifier: "ENG-2", parentId: "issue-1", agentId: "agent-1" }]);
  // The closed ticket itself is never moved or labelled; a follow-up question edits the comment.
  pending = [{ id: "q2" }];
  await writeback.permissionResolved({ agent: root, requestId: "q1", resolution: { behavior: "allow" } }, paseo);
  await ask("q2", "And watch the deploy?");
  assert.deepEqual(linear.writes.splice(0), ["state", `edit c1: ${waiting("And watch the deploy?")}`]);
  pending = [];
  await writeback.permissionResolved({ agent: root, requestId: "q2", resolution: { behavior: "allow" } }, paseo);
  assert.deepEqual(linear.writes.splice(0), ["state", "-paseo-needs-you", "complete sub-1"]);
  assert.deepEqual(await needsYou.all(), []);
});

test("a turn-end wait on a closed ticket keeps its sub-issue open for the owner and reuses it until the owner closes it", async () => {
  const linear = new FakeLinear();
  linear.state = { ...linear.state, status: "Done", statusId: "done", statusType: "completed", creatorId: "creator" };
  const needsYou = new NeedsYouIssues(mkdtempSync(join(tmpdir(), "needs-you-")));
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), needsYou);
  const end = (text: string) => writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text }] }, linked);
  const created = () => linear.writes.splice(0).filter((write) => write.startsWith("create "));

  await end("Merged.\n\n**Someone has to send a test mail to `purchases@`.** Only you can do that.");
  assert.deepEqual(created(), ['create sub-1 "Needs you: Someone has to send a test mail to purchases@. Only you can do that." under issue-1 for creator in Needs input']);
  // The next turn may be a nudge, not the step being done: the sub-issue stays open, and the
  // closed ticket is not reopened by the agent's first turn this plugin instance sees.
  await writeback.turnStarted({ agent: root, turnId: "t2" }, linked);
  assert.ok(!linear.writes.includes("complete sub-1"));
  assert.ok(!linear.writes.some((write) => write.startsWith("in-progress")));
  await end("Still waiting: should I run the smoke test once the mail arrived?");
  assert.deepEqual(created(), []);
  assert.equal(linear.others.size, 1);

  linear.others.set("sub-1", { ...linear.others.get("sub-1")!, status: "Done", statusType: "completed" });
  await writeback.turnStarted({ agent: root, turnId: "t3" }, linked);
  await end("Should I close the epic?");
  assert.deepEqual(created(), ['create sub-2 "Needs you: Should I close the epic?" under issue-1 for creator in Needs input']);
  assert.deepEqual((await needsYou.all()).map((entry) => entry.id), ["sub-2"]);
});

test("a ticket the Paseo app or another integration wrote asks and assigns the owner; a person who wrote it is still asked", async () => {
  // What a waiting agent writes: the "Needs you" sub-issue (closed tickets) and the mention in its comment.
  const ask = async (creatorId: string, statusType: "started" | "completed") => {
    const linear = new FakeLinear();
    // Another integration: Linear reports it as an app although it is not the Paseo app.
    linear.apps.add("zapier");
    linear.state = { ...linear.state, status: statusType === "completed" ? "Done" : "In Progress", statusId: "x", statusType, creatorId };
    const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), new NeedsYouIssues(mkdtempSync(join(tmpdir(), "needs-you-"))));
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1" }, pendingPermissions: [{ id: "q" }] } }) }) } } as unknown as PaseoApi;
    await writeback.permissionRequested({ agent: root, request: { id: "q", provider: "claude", name: "AskUser", kind: "question", title: "Which bucket?" } }, paseo);
    return linear.writes.filter((write) => write.startsWith("create ") || write.startsWith("new comment")).map((write) => write.replace(/ \*\*ENG-1[\s\S]*/, ""));
  };
  const profile = "https://linear.app/acme/profiles";
  for (const app of ["paseo-app", "zapier"]) {
    assert.deepEqual(await ask(app, "started"), [`new comment: ${profile}/owner`], `${app}: the open ticket's comment mentions the owner`);
    assert.deepEqual(await ask(app, "completed"), ['create sub-1 "Needs you: Which bucket?" under issue-1 for owner in Needs input', `new comment on sub-1: ${profile}/owner`], `${app}: the sub-issue goes to the owner`);
  }
  assert.deepEqual(await ask("teammate", "started"), [`new comment: ${profile}/teammate`]);
  assert.deepEqual(await ask("teammate", "completed"), ['create sub-1 "Needs you: Which bucket?" under issue-1 for teammate in Needs input', `new comment on sub-1: ${profile}/teammate`]);
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

// The ticket's non-archived agents on pages of two: five subagents first, the successor last.
function paseoWithAgents(agents: { id: string; createdAt: string; parent?: string }[]): PaseoApi {
  const entries = agents.map(({ id, createdAt, parent }) => ({ agent: { id, createdAt, title: `ENG-1 (${id})`, cwd: "/repo", status: "idle", labels: { "linear.issueId": "issue-1", ...(parent ? { "paseo.parent-agent-id": parent } : {}) } } }));
  return {
    agents: {
      ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1" } } }) }),
      list: async (input: { page?: { cursor?: string } }) => {
        const start = Number(input.page?.cursor ?? 0);
        const hasMore = start + 2 < entries.length;
        return { entries: entries.slice(start, start + 2), pageInfo: { hasMore, nextCursor: hasMore ? String(start + 2) : null } };
      },
    },
  } as unknown as PaseoApi;
}

test("an archived predecessor hands the record to its successor beyond the first page of subagents, and never takes it back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-writeback-takeover-"));
  const linear = new FakeLinear();
  const handover = new Handover(linear as never, directory, async () => ({ branch: "mtuchel/eng-1-fix", lastCommit: "abc123 the fix" }), () => "2026-01-01T10:00:00.000Z");
  await handover.update({ id: "issue-1", identifier: "ENG-1" }, root, { summary: "Pushed the fix." });
  const subagents = Array.from({ length: 5 }, (_, index) => ({ id: `sub-${index}`, createdAt: `2026-01-03T00:00:0${index}Z`, parent: "agent-2" }));
  const paseo = paseoWithAgents([...subagents, { id: "agent-2", createdAt: "2026-01-02T00:00:00Z" }]);
  const writeback = new Writeback(linear, { read: async () => allOn }, { sessions: {} as never, handover }, 0, outboxPath());

  await writeback.archived({ agent: root, archivedAt: "now" }, paseo);
  const record = await handover.read("issue-1");
  assert.deepEqual({ agentId: record?.agentId, status: record?.status, branch: record?.branch }, { agentId: "agent-2", status: "working", branch: "mtuchel/eng-1-fix" });
  assert.ok(linear.writes.some((write) => /^comment: 🏁 \*\*Paseo final report\*\* — ENG-1: Fix sign-in\n[\s\S]*handed over to ENG-1 \(agent-2\)[\s\S]*Pushed the fix\./.test(write)), "the predecessor reports its own work");
  assert.ok(!linear.writes.includes("-paseo-running"), "the successor keeps the running marker");

  // A repeated archive event (or a later one of the predecessor) leaves the successor's record.
  await handover.update({ id: "issue-1", identifier: "ENG-1" }, { ...root, id: "agent-2", title: "ENG-1 (agent-2)" }, { status: "waiting" });
  await new Writeback(linear, { read: async () => allOn }, { sessions: {} as never, handover }, 0, outboxPath()).archived({ agent: root, archivedAt: "now" }, paseo);
  assert.deepEqual({ agentId: (await handover.read("issue-1"))?.agentId, status: (await handover.read("issue-1"))?.status }, { agentId: "agent-2", status: "waiting" });

  // Only subagents left: the record is the predecessor's to close.
  const alone = mkdtempSync(join(tmpdir(), "paseo-writeback-takeover-"));
  const own = new Handover(linear as never, alone, async () => ({ branch: "mtuchel/eng-1-fix", lastCommit: "abc123 the fix" }), () => "2026-01-01T10:00:00.000Z");
  await own.update({ id: "issue-1", identifier: "ENG-1" }, root, { summary: "Pushed the fix." });
  await new Writeback(linear, { read: async () => allOn }, { sessions: {} as never, handover: own }, 0, outboxPath()).archived({ agent: root, archivedAt: "now" }, paseoWithAgents(subagents));
  assert.deepEqual({ agentId: (await own.read("issue-1"))?.agentId, status: (await own.read("issue-1"))?.status }, { agentId: "agent-1", status: "archived" });
});

test("a Linear failure is logged and never thrown back into the daemon hook", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  linear.comment = async () => { throw new Error("rate limited"); };
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  await writeback.turnEnded({ agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "done" }] }, linked);
  assert.match(String(errors.mock.calls[0].arguments[1]), /rate limited/);
});

const PR = "https://github.com/o/r/pull/9";
const completedWithPr: PluginLifecycleEvents["agent.turn_ended"] = { agent: root, turnId: "t", outcome: { kind: "completed" }, timeline: [toolCall(PR), { type: "assistant_message", text: "done" }] };
const MINUTE = 60_000;

// Retries fire from mocked timers and run in the background; real I/O (the outbox) needs real turns.
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!condition() && performance.now() < deadline) await nextTurn();
  assert.ok(condition(), "the expected write-back never happened");
}
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) await nextTurn();
}

function fakeBridge() {
  const calls: string[] = [];
  const bridge = {
    sessions: {
      sessionFor: async () => ({ sessionId: "s1" }), holdIfStopped: async () => false, follow: async () => {}, unfollow: async () => true, action: async () => {}, resumeNow: async () => false,
      scheduleLimitResume: async () => false,
      say: async (_s: string, type: string, body: string) => { calls.push(`say ${type}: ${body}`); },
      link: async (_s: string, _title: string, url: string) => { calls.push(`session link ${url}`); },
      offerResume: async () => { calls.push("offer resume"); },
    },
    handover: {
      read: async () => null, waiting: async () => null, setWaiting: async () => {},
      update: async (_issue: unknown, _agent: unknown, change: object) => { calls.push(`handover ${JSON.stringify(change)}`); return {}; },
      finish: async (_issue: unknown, _agent: unknown, status: string) => { calls.push(`finish ${status}`); return {}; },
    },
  };
  return { calls, bridge: bridge as never, sessions: bridge.sessions };
}

test("a rate-limited turn end is retried whenever Linear's pool refills, however often, until it lands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  const issueState = linear.issueState.bind(linear);
  let attempts = 0;
  linear.issueState = async () => { if (++attempts <= 4) throw new RateLimitedError("key", Date.now() + 10 * MINUTE); return issueState(); };
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), undefined, accept);
  await writeback.turnEnded(completedWithPr, linked);
  for (let retry = 1; retry <= 4; retry++) {
    t.mock.timers.tick(10 * MINUTE - 1);
    await settle();
    assert.equal(attempts, retry, "not retried before the pool refills");
    t.mock.timers.tick(1);
    await until(() => attempts === retry + 1);
  }
  await until(() => linear.writes.includes("review"));
  assert.equal(linear.writes.filter((write) => write.startsWith("comment: ")).length, 1);
  assert.ok(linear.writes.includes(`link ${PR}`));
});

test("a turn end that stays rate-limited gives up after 6 h", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  let attempts = 0;
  linear.issueState = async () => { attempts++; throw new RateLimitedError("key", Date.now() + 60 * MINUTE); };
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), undefined, accept);
  await writeback.turnEnded(completedWithPr, linked);
  for (let hour = 1; hour <= 6; hour++) {
    t.mock.timers.tick(60 * MINUTE);
    await until(() => attempts === hour + 1);
  }
  const gaveUp = () => errors.mock.calls.some((call) => String(call.arguments[0]) === "[linear-tickets] write-back for turn_ended on agent agent-1 gave up after 6 h of Linear rate limits");
  await until(gaveUp);
  t.mock.timers.tick(24 * 60 * MINUTE);
  await settle();
  assert.equal(attempts, 7);
  assert.ok(!linear.writes.includes("review"));
});

test("a delayed retry overtaken by a newer event links its pull request but leaves the newer state alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  const issueState = linear.issueState.bind(linear);
  let limited = true;
  linear.issueState = async () => { if (limited) { limited = false; throw new RateLimitedError("key", Date.now() + 10 * MINUTE); } return issueState(); };
  const { calls, bridge } = fakeBridge();
  const writeback = new Writeback(linear, { read: async () => allOn }, bridge, 0, outboxPath(), undefined, accept);
  await writeback.turnEnded(completedWithPr, linked);
  await writeback.turnStarted({ agent: root, turnId: "next" }, linked);
  linear.writes.length = 0;
  calls.length = 0;
  t.mock.timers.tick(10 * MINUTE);
  await until(() => errors.mock.calls.some((call) => /turn_ended on agent agent-1 superseded by a newer event/.test(String(call.arguments[0]))));
  // The stale turn neither clears the waiting state, drops labels, reports nor moves the ticket.
  assert.deepEqual(linear.writes, [`link ${PR}`]);
  assert.deepEqual(calls, [`session link ${PR}`, `handover {"link":["Pull request","${PR}"]}`]);
});

test("a retry after partial success repeats no comment, report or session activity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(console, "error", () => {});
  const plain = new FakeLinear();
  const removeLabel = plain.removeLabel.bind(plain);
  let limited = true;
  plain.removeLabel = async (id: string, name: string) => {
    if (name === "paseo-blocked" && limited) { limited = false; throw new RateLimitedError("key", Date.now() + MINUTE); }
    return removeLabel(id, name);
  };
  await new Writeback(plain, { read: async () => allOn }, undefined, 0, outboxPath(), undefined, accept).turnEnded(completedWithPr, linked);
  t.mock.timers.tick(MINUTE);
  await until(() => plain.writes.includes("review"));
  assert.equal(plain.writes.filter((write) => write.startsWith("comment: ")).length, 1);
  assert.equal(plain.writes.filter((write) => write === `link ${PR}`).length, 1);

  const native = new FakeLinear();
  const addLabel = native.addLabel.bind(native);
  let failing = true;
  native.addLabel = async (id: string, name: string) => { if (failing) { failing = false; throw new RateLimitedError("key", Date.now() + MINUTE); } return addLabel(id, name); };
  const { calls, bridge } = fakeBridge();
  await new Writeback(native, { read: async () => allOn }, bridge, 0, outboxPath()).turnEnded({ agent: root, turnId: "t", outcome: { kind: "failed", error: { message: "boom" } }, timeline: [] }, linked);
  t.mock.timers.tick(MINUTE);
  await until(() => calls.includes("offer resume"));
  assert.deepEqual(calls, ["say error: The agent stopped with an error: boom", "finish failed", "offer resume"]);
  assert.deepEqual(native.writes.filter((write) => write === "+paseo-blocked"), ["+paseo-blocked"]);
});

test("a pull request left in the outbox is linked by the next plugin instance on its first write-back", async (t) => {
  t.mock.method(console, "error", () => {});
  const path = outboxPath();
  const before = new FakeLinear();
  before.linkUrl = async () => { throw new Error("Linear did not link the URL."); };
  await new Writeback(before, { read: async () => allOn }, undefined, 0, path, undefined, accept).turnEnded(completedWithPr, linked);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).map((entry: { url: string; done: object }) => [entry.url, entry.done]), [[PR, { linear: false, session: false, handover: false }]]);

  const after = new FakeLinear();
  await new Writeback(after, { read: async () => allOn }, undefined, 0, path, undefined, accept).turnStarted({ agent: { ...root, id: "agent-2" }, turnId: "t" }, linked);
  assert.deepEqual(after.writes, [`link ${PR}`, "state", "in-progress issue-1"]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
});

test("other Linear outages are retried twice, after 30 s and 2 min, then dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  let attempts = 0;
  linear.issueState = async () => { attempts++; throw new Error("The Linear API request failed (HTTP 503). Try again."); };
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), undefined, accept);
  await writeback.turnEnded(completedWithPr, linked);
  t.mock.timers.tick(30_000);
  await until(() => attempts === 2);
  t.mock.timers.tick(120_000);
  await until(() => attempts === 3);
  await until(() => errors.mock.calls.some((call) => String(call.arguments[0]) === "[linear-tickets] write-back for turn_ended on agent agent-1 failed:"));
  t.mock.timers.tick(60 * MINUTE);
  await settle();
  assert.equal(attempts, 3);
  assert.deepEqual(errors.mock.calls.map((call) => String(call.arguments[0]).match(/retrying in \d+ s/)?.[0]).filter(Boolean), ["retrying in 30 s", "retrying in 120 s"]);
});

// The URL printed on TUC-810's agent turn: a fixture of these tests, not a pull request.
const FIXTURE = "https://github.com/o/r/pull/1";
const NO_REPOSITORY = "no such repository, or this host's gh cannot see it";
const ticketLinked = paseoWithLabels({ "linear.issueId": "issue-1", "linear.identifier": "ENG-1" });
const linksIn = (writes: string[]) => writes.filter((write) => write.startsWith("link ") || write === "review");
const bridgeLinks = (calls: string[]) => calls.filter((call) => call.startsWith("session link ") || call.startsWith('handover {"link"'));
const outbox = async (path: string) => JSON.parse(await readFile(path, "utf8")) as { url: string; checked?: true; done: object }[];

// The pull request check, faked: URLs in `rejected` fail with that reason, any other is the
// ticket's. Every call is recorded.
function fakeCheck(rejected: Record<string, string> = {}) {
  const checked: string[] = [];
  const check = async (url: string) => {
    checked.push(url);
    return url in rejected ? { link: false as const, reason: rejected[url] } : { link: true as const };
  };
  return { checked, check };
}

test("a turn printing a test fixture's pull request URL links nothing on the ticket, the session or the handover, and leaves the ticket out of review", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  const { calls, bridge } = fakeBridge();
  const path = outboxPath();
  const { checked, check } = fakeCheck({ [FIXTURE]: NO_REPOSITORY });
  await new Writeback(linear, { read: async () => allOn }, bridge, 0, path, undefined, check).turnEnded({ ...completedWithPr, timeline: [toolCall(`not ok 3 - links\n  expected: '${FIXTURE}'`), { type: "assistant_message", text: "done" }] }, ticketLinked);
  assert.deepEqual(checked, [FIXTURE]);
  assert.deepEqual(linksIn(linear.writes), []);
  assert.deepEqual(bridgeLinks(calls), []);
  assert.deepEqual(await outbox(path), []);
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]) === `[linear-tickets] not linking ${FIXTURE} to ENG-1: ${NO_REPOSITORY}`));
});

test("of a turn's pull requests only the one naming the ticket is linked in all three places, and the ticket moves to review once", async (t) => {
  t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  const { calls, bridge } = fakeBridge();
  const other = "https://github.com/o/r/pull/3";
  const own = "https://github.com/o/r/pull/4";
  const shown: Record<string, PullRequestText> = { [other]: { title: "ENG-2: another ticket", body: "Part of ENG-2", headRefName: "eng-2" }, [own]: { title: "Fix sign-in", body: "Part of ENG-1", headRefName: "fix-sign-in" } };
  const check = (url: string, identifier: string) => ticketPullRequest(url, identifier, async (viewed) => shown[viewed]);
  await new Writeback(linear, { read: async () => allOn }, bridge, 0, outboxPath(), undefined, check).turnEnded({ ...completedWithPr, timeline: [toolCall(`${other}\nCreated ${own}`), { type: "assistant_message", text: "done" }] }, ticketLinked);
  assert.deepEqual(linksIn(linear.writes), [`link ${own}`, "review"]);
  assert.deepEqual(bridgeLinks(calls), [`session link ${own}`, `handover {"link":["Pull request","${own}"]}`]);
});

test("a pull request whose check cannot reach GitHub stays in the outbox unlinked, and a later drain links it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const errors = t.mock.method(console, "error", () => {});
  const path = outboxPath();
  const before = new FakeLinear();
  const offline = (url: string) => ticketPullRequest(url, "ENG-1", async () => { throw new GitHubRateLimitedError("GitHub is throttling gh: HTTP 429"); });
  await new Writeback(before, { read: async () => allOn }, undefined, 0, path, undefined, offline).turnEnded(completedWithPr, ticketLinked);
  assert.deepEqual(linksIn(before.writes), []);
  assert.deepEqual((await outbox(path)).map((entry) => [entry.url, entry.checked, entry.done]), [[PR, undefined, { linear: false, session: false, handover: false }]]);
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).endsWith(`retrying in 30 s: Could not reach GitHub to check ${PR}: GitHub is throttling gh: HTTP 429`)));

  const after = new FakeLinear();
  await new Writeback(after, { read: async () => allOn }, undefined, 0, path, undefined, accept).turnStarted({ agent: { ...root, id: "agent-2" }, turnId: "t" }, ticketLinked);
  assert.deepEqual(linksIn(after.writes), [`link ${PR}`]);
  assert.deepEqual(await outbox(path), []);
});

test("outbox entries from before the check are checked first, even half-linked ones; entries checked earlier are not checked again", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const path = outboxPath();
  const entry = (url: string, extra: object = {}) => ({ agentId: "agent-1", agentTitle: "ENG-1: Fix sign-in", cwd: "/repo", issueId: "issue-1", identifier: "ENG-1", url, done: { linear: false, session: false, handover: false }, ...extra });
  const own = "https://github.com/o/r/pull/5";
  const halfLinkedFixture = "https://github.com/o/app/pull/1";
  const checkedEarlier = "https://github.com/o/r/pull/7";
  const halfLinked = { done: { linear: true, session: false, handover: false } };
  await writeFile(path, JSON.stringify([entry(own), entry(FIXTURE), entry(halfLinkedFixture, halfLinked), entry(checkedEarlier, { checked: true, ...halfLinked })]));
  const linear = new FakeLinear();
  const { calls, bridge } = fakeBridge();
  const { checked, check } = fakeCheck({ [FIXTURE]: NO_REPOSITORY, [halfLinkedFixture]: NO_REPOSITORY });
  await new Writeback(linear, { read: async () => allOn }, bridge, 0, path, undefined, check).turnStarted({ agent: { ...root, id: "agent-2" }, turnId: "t" }, ticketLinked);
  assert.deepEqual(checked, [own, FIXTURE, halfLinkedFixture]);
  assert.deepEqual(linksIn(linear.writes), [`link ${own}`]);
  assert.deepEqual(bridgeLinks(calls), [
    `session link ${own}`, `handover {"link":["Pull request","${own}"]}`,
    `session link ${checkedEarlier}`, `handover {"link":["Pull request","${checkedEarlier}"]}`,
  ]);
  assert.deepEqual(await outbox(path), []);
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]) === `[linear-tickets] not linking ${halfLinkedFixture} to ENG-1: ${NO_REPOSITORY}; already attached on Linear; remove it by hand`));
});

test("a retry after a partial link or a failed move to review checks nothing again, links each place once and still moves the ticket to review", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(console, "error", () => {});

  // The session panel is rate-limited once, after the ticket was linked.
  const linear = new FakeLinear();
  const { calls, bridge, sessions } = fakeBridge();
  const link = sessions.link;
  let limited = true;
  sessions.link = async (sessionId, title, url) => {
    if (limited) { limited = false; throw new RateLimitedError("key", Date.now() + MINUTE); }
    return link(sessionId, title, url);
  };
  const { checked, check } = fakeCheck();
  await new Writeback(linear, { read: async () => allOn }, bridge, 0, outboxPath(), undefined, check).turnEnded(completedWithPr, ticketLinked);
  assert.deepEqual(linksIn(linear.writes), [`link ${PR}`]);
  t.mock.timers.tick(MINUTE);
  await until(() => linear.writes.includes("review"));
  assert.deepEqual(checked, [PR]);
  assert.deepEqual(linksIn(linear.writes), [`link ${PR}`, "review"]);
  assert.deepEqual(bridgeLinks(calls), [`session link ${PR}`, `handover {"link":["Pull request","${PR}"]}`]);

  // Every place is linked (the outbox is empty), then the move to review is rate-limited once.
  const moving = new FakeLinear();
  const moveToReview = moving.moveToReview.bind(moving);
  let failing = true;
  moving.moveToReview = async () => {
    if (failing) { failing = false; throw new RateLimitedError("key", Date.now() + MINUTE); }
    return moveToReview();
  };
  const second = fakeCheck();
  await new Writeback(moving, { read: async () => allOn }, undefined, 0, outboxPath(), undefined, second.check).turnEnded(completedWithPr, ticketLinked);
  t.mock.timers.tick(MINUTE);
  await until(() => moving.writes.includes("review"));
  assert.deepEqual(second.checked, [PR]);
  assert.deepEqual(linksIn(moving.writes), [`link ${PR}`, "review"]);
});

test("a pull request rejected in one turn is checked again in a later one, and links once it names the ticket", async (t) => {
  t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  const rejected: Record<string, string> = { [PR]: "the pull request does not name ENG-1 in its title, description or branch" };
  const { checked, check } = fakeCheck(rejected);
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0, outboxPath(), undefined, check);
  await writeback.turnEnded(completedWithPr, ticketLinked);
  assert.deepEqual(linksIn(linear.writes), []);
  // The agent added "Part of ENG-1" to the pull request's description.
  delete rejected[PR];
  await writeback.turnEnded(completedWithPr, ticketLinked);
  assert.deepEqual(checked, [PR, PR]);
  assert.deepEqual(linksIn(linear.writes), [`link ${PR}`, "review"]);
});

test("questions and the owner's answers are logged for the decision candidates, across a reload and with write-back off", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-decision-log-"));
  const linear = new FakeLinear();
  const off = { ...allOn, writeback: DEFAULT_WRITEBACK };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1", "linear.identifier": "ENG-1" }, pendingPermissions: [] } }) }) } } as unknown as PaseoApi;
  const before = new Writeback(linear, { read: async () => off }, undefined, 0);
  before.recordDecisions(new DecisionLog(directory));
  const ask = (id: string) => before.permissionRequested({ agent: root, request: { id, provider: "omp", name: "ask", kind: "question", input: { questions: [{ header: "Merge", question: "May I merge?", options: [{ label: "Yes" }, { label: "No" }] }] } } }, paseo);
  await ask("q1");
  await ask("q2");
  await before.permissionRequested({ agent: root, request: { id: "t1", provider: "omp", name: "Bash", kind: "tool" } }, paseo);
  // The plugin reloads before the owner answers in the Paseo app.
  const after = new Writeback(linear, { read: async () => off }, undefined, 0);
  after.recordDecisions(new DecisionLog(directory));
  const answer = (requestId: string, choice: string) => after.permissionResolved({ agent: root, requestId, resolution: { behavior: "allow", updatedInput: { answers: { Merge: choice } } } }, paseo);
  await answer("q1", "Yes");
  await answer("q1", "Yes");
  await answer("q2", "No");
  await after.permissionResolved({ agent: root, requestId: "t1", resolution: { behavior: "allow" } }, paseo);
  const entries = await new DecisionLog(directory).entries();
  assert.deepEqual(entries.map((entry) => `${entry.kind} ${entry.id}`), ["question agent-1:q1", "question agent-1:q2", "answer agent-1:q1", "answer agent-1:q2"]);
  assert.deepEqual(entries[0], { kind: "question", id: "agent-1:q1", at: entries[0].at, identifier: "ENG-1", issueId: "issue-1", questions: [{ key: "Merge", question: "Merge: May I merge?", options: ["Yes", "No"] }] });
  assert.deepEqual(linear.writes, []);
});

test("a failing decision log never stops the waiting write-back", async () => {
  const linear = new FakeLinear();
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1" }, pendingPermissions: [{ id: "q1" }] } }) }) } } as unknown as PaseoApi;
  const writeback = new Writeback(linear, { read: async () => allOn }, undefined, 0);
  writeback.recordDecisions({ append: async () => { throw new Error("disk full"); }, answer: async () => { throw new Error("disk full"); } });
  const errors = test.mock.method(console, "error", () => {});
  await writeback.permissionRequested({ agent: root, request: { id: "q1", provider: "omp", name: "ask", kind: "question", title: "Which?" } }, paseo);
  errors.mock.restore();
  assert.ok(linear.writes.includes("move issue-1 Needs input"));
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /decision log: question on issue-1 failed: disk full/);
});
