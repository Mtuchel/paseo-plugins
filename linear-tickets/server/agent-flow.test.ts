import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { HealthMonitor } from "./health";
import { reviewChange } from "./pr-watch";
import { decidePlannotatorReview, describeTool, questionPrompt, SessionRouter, SessionStore } from "./sessions";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { splitIntoSubIssues } from "./split";
import { isUntrusted, TicketStarter, UNTRUSTED_NOTE } from "./starter";

const OWNER = "owner-1";
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp", launchPreferences: { omp: { model: "omp/opus", modeId: "full" } },
  projectMappings: { "team:t1": { projectId: "p1", label: "Team", baseBranch: "refs/heads/main" } }, agentLinearAccess: false,
  dispatch: { ...DEFAULT_DISPATCH, maxRunning: 2 }, writeback: DEFAULT_WRITEBACK,
};

const twoPart: AgentPermissionRequest = {
  id: "q", provider: "claude", name: "AskUserQuestion", kind: "question", title: "Setup",
  input: { questions: [
    { question: "Transfer?", header: "transfer", options: [{ label: "SFTP" }, { label: "Mail" }, { label: "Other (type your own)" }] },
    { question: "Format?", header: "format", options: [{ label: "CSV" }, { label: "XML" }] },
    { question: "Optional comment", header: "Comment", options: [], allowEmpty: true },
  ] },
};

test("question parts are asked one at a time, and Other is a hint rather than a button", () => {
  const first = questionPrompt(twoPart, 0);
  assert.deepEqual(first.options.map((option) => option.label), ["SFTP", "Mail"]);
  assert.match(first.body, /^Transfer\? \(1\/2\)/);
  assert.match(first.body, /Or type your own answer\.$/);
  assert.match(questionPrompt(twoPart, 1).body, /^Format\? \(2\/2\)/);
});

function routerHarness(pending: AgentPermissionRequest[], extra: Partial<ConstructorParameters<typeof SessionRouter>[0]> = {}) {
  const calls: string[] = [];
  const feeds: ((event: unknown) => void)[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: { pendingPermissions: pending } }),
        send: async (text: string) => { calls.push(`send ${id}: ${text}`); },
        respondToPermission: async ({ response }: { response: unknown }) => { calls.push(`respond ${JSON.stringify(response)}`); },
        timeline: { subscribe: (handler: (event: unknown) => void) => { feeds.push(handler); return () => {}; } },
      }),
    },
  } as unknown as PaseoApi;
  const directory = join(tmpdir(), `paseo-flow-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = new SessionStore(join(directory, "sessions.json"));
  const router = new SessionRouter({
    api: { activity: async (_s: string, content: { type: string; body?: string }) => { calls.push(`${content.type}:${(content.body ?? "").split("\n")[0]}`); }, openSessions: async () => [], activities: async () => [] } as never,
    linear: { viewerId: async () => OWNER, addLabel: async () => {}, removeLabel: async () => {} },
    starter: { start: async () => { throw new Error("unused"); }, admission: async () => ({ ok: true as const }) },
    settings: { read: async () => settings },
    store,
    stop: async (agentId) => { calls.push(`stop ${agentId}`); },
    ...extra,
  });
  router.attach(paseo);
  router.stop();
  return { router, store, calls, feeds, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const link = { sessionId: "s1", agentId: "a1", issueId: "i1", identifier: "TUC-1", createdAt: "2026-01-01T00:00:00Z", handled: [], review: null, offer: null };

test("a multi-part question collects every answer before answering the agent once", async () => {
  const h = routerHarness([twoPart]);
  await h.store.put(link);
  await h.router.prompted("s1", { id: "p1", content: { body: "sftp" } });
  assert.deepEqual(h.calls, ["elicitation:Format? (2/2)"]);
  await h.router.prompted("s1", { id: "p2", content: { body: "CSV" } });
  assert.equal(h.calls.at(-1), 'respond {"behavior":"allow","updatedInput":{"answers":{"transfer":"SFTP","format":"CSV","Comment":""}}}');
  await h.cleanup();
});

test("after Stop, a turn the provider starts on its own is stopped again until the owner replies", async () => {
  const h = routerHarness([]);
  await h.store.put(link);
  await h.router.prompted("s1", { id: "p1", signal: "stop", content: { body: "stop" } });
  assert.equal(await h.router.holdIfStopped("a1"), true);
  assert.deepEqual(h.calls.filter((call) => call.startsWith("stop")), ["stop a1", "stop a1"]);
  await h.router.prompted("s1", { id: "p2", content: { body: "carry on" } });
  assert.equal(await h.router.holdIfStopped("a1"), false);
  await h.cleanup();
});

test("while a question is open the live feed holds its actions, so Linear keeps showing the options", async () => {
  const h = routerHarness([]);
  await h.store.put(link);
  await h.router.follow("a1");
  const ran = (command: string) => h.feeds[0]({ event: { type: "timeline", item: { type: "tool_call", status: "completed", detail: { type: "shell", command } } } });
  ran("ls");
  await h.router.ask("s1", "The plan is ready for review", [{ label: "Approve plan", value: "approve-plan" }]);
  ran("cat PLAN.md");
  await h.router.unfollow("a1");
  assert.deepEqual(h.calls, ["action:", "elicitation:The plan is ready for review"]);
  await h.router.follow("a1");
  await h.router.ask("s1", "Which?", [{ label: "A", value: "a" }]);
  h.feeds[1]({ event: { type: "timeline", item: { type: "tool_call", status: "completed", detail: { type: "shell", command: "pwd" } } } });
  await h.router.prompted("s1", { id: "p1", content: { body: "A" } });
  await h.router.unfollow("a1");
  assert.equal(h.calls.at(-1), "action:");
  await h.cleanup();
});

test("feedback for a review whose Plannotator server is gone reaches the agent instead of failing", async () => {
  const h = routerHarness([], { decideReview: (url, approve, feedback) => decidePlannotatorReview(url, approve, feedback) });
  await h.store.put({ ...link, review: { localUrl: "http://127.0.0.1:1" } });
  await h.router.prompted("s1", { id: "p1", content: { body: "Split step 2 in two" } });
  assert.equal((await h.store.get("s1"))?.review, null);
  assert.match(h.calls.at(-1) ?? "", /^send a1: Your Plannotator plan review closed[\s\S]*Split step 2 in two/);
  await h.cleanup();
});

test("the live feed shows completed commands and edits only", () => {
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "shell", command: "npm test" } }), "Ran npm test");
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "edit", filePath: "src/a.ts" } }), "Edited src/a.ts");
  assert.equal(describeTool({ type: "tool_call", status: "running", detail: { type: "shell", command: "npm test" } }), null);
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "read", filePath: "a" } }), null);
});

function starterHarness(state: { creatorId: string; labels: { id: string; name: string }[]; blockedBy: string[] }, running: number) {
  const launches: { modeId?: string; instructions: string; labels?: Record<string, string> }[] = [];
  const starter = new TicketStarter({
    linear: {
      detail: async () => ({ issue: { identifier: "TUC-1", project: "", team: "Team" }, projectId: null, teamId: "t1" }) as never,
      issueState: async () => ({ id: "i1", identifier: "TUC-1", status: "Todo", statusType: "unstarted", teamId: "t1", projectId: null, attachmentUrls: [], ...state }),
      viewerId: async () => OWNER,
    },
    launcher: { start: async (input, _paseo, options) => { launches.push({ modeId: input.modeId, instructions: input.instructions, labels: options?.labels }); return { agentId: "new", warnings: [] }; } },
    branches: async () => ({ branches: [{ id: "refs/heads/main", label: "main" }], defaultBranch: "refs/heads/main" }),
  });
  const paseo = {
    agents: { list: async () => ({ entries: Array.from({ length: running }, (_, index) => ({ agent: { id: `r${index}`, status: "running", labels: { "linear.issueId": `x${index}` } } })), pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectKind: "git", projectRootPath: "/repo", projectDisplayName: "repo" }] }) },
  } as unknown as PaseoApi;
  return { starter, paseo, launches };
}

test("admission waits for unfinished blockers and for a free agent slot", async () => {
  const blocked = starterHarness({ creatorId: OWNER, labels: [], blockedBy: ["TUC-9"] }, 0);
  assert.deepEqual(await blocked.starter.admission("i1", blocked.paseo, settings), { ok: false, reason: "Waiting for TUC-9 to finish." });
  const full = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 2);
  assert.match((await full.starter.admission("i1", full.paseo, settings) as { reason: string }).reason, /Queued: 2 of 2/);
  const room = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 1);
  assert.deepEqual(await room.starter.admission("i1", room.paseo, settings), { ok: true });
  assert.deepEqual(await room.starter.admission("i1", room.paseo, { ...settings, dispatch: { ...settings.dispatch, maxRunning: 0 } }), { ok: true });
});

test("tickets written by someone else, or from the feedback intake, start plan-first", async () => {
  assert.equal(isUntrusted({ creatorId: OWNER, labels: [] }, OWNER), false);
  assert.equal(isUntrusted({ creatorId: "customer", labels: [] }, OWNER), true);
  assert.equal(isUntrusted({ creatorId: OWNER, labels: [{ name: "Feedback" }] }, OWNER), true);
  const h = starterHarness({ creatorId: "customer", labels: [], blockedBy: [] }, 0);
  const started = await h.starter.start("i1", h.paseo, settings, { retryHint: "retry" });
  assert.equal(started.untrusted, true);
  assert.deepEqual(h.launches[0], { modeId: "write", instructions: UNTRUSTED_NOTE, labels: { "linear.untrusted": "1" } });
  const mine = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  await mine.starter.start("i1", mine.paseo, settings, { retryHint: "retry" });
  assert.equal(mine.launches[0].modeId, "full");
});

test("pull request reviews become ticket updates: changes requested, fixes pushed, approved, merged", () => {
  const start = { reviewedAt: null, decision: null, merged: false };
  const requested = reviewChange({ state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z" }], lastCommitAt: "2026-01-01T09:00:00Z" }, start);
  assert.equal(requested.change?.state, "In Progress");
  assert.equal(requested.change?.review, "changes requested by @ada");
  assert.equal(reviewChange({ state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z" }], lastCommitAt: "2026-01-01T09:00:00Z" }, requested.seen).change, null, "nothing new");
  const pushed = reviewChange({ state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z" }], lastCommitAt: "2026-01-01T11:00:00Z" }, requested.seen);
  assert.equal(pushed.change?.state, "In Review");
  const approved = reviewChange({ state: "OPEN", reviews: [{ author: "ada", state: "APPROVED", submittedAt: "2026-01-01T12:00:00Z" }], lastCommitAt: "2026-01-01T11:00:00Z" }, pushed.seen);
  assert.equal(approved.change?.review, "approved by @ada");
  const merged = reviewChange({ state: "MERGED", reviews: [], lastCommitAt: null }, approved.seen);
  assert.equal(merged.change?.review, "merged");
  assert.equal(reviewChange({ state: "MERGED", reviews: [], lastCommitAt: null }, merged.seen).change, null);
});

test("splitting creates one sub-issue per step, each blocked by the previous, all assigned to Paseo", async () => {
  const calls: string[] = [];
  let n = 0;
  const deps = {
    linear: {
      issueState: async () => ({ id: "parent", identifier: "TUC-1", status: "Planning", statusType: "started", teamId: "t1", projectId: "p9", creatorId: OWNER, labels: [], attachmentUrls: [], blockedBy: [] }),
      upsertIssueDocument: async (_id: string, _title: string, body: string) => { calls.push(`document ${body.split("\n").find((line) => line.includes("Planned with"))}`); return "https://linear.app/doc/plan"; },
      createIssue: async (input: { title: string; parentId?: string; projectId?: string | null; ready?: boolean }) => { n++; calls.push(`create ${input.title} parent=${input.parentId} project=${input.projectId}${input.ready ? " ready" : ""}`); return { id: `s${n}`, identifier: `TUC-${10 + n}`, url: "" }; },
      addBlocker: async (blocker: string, blocked: string) => { calls.push(`${blocker} blocks ${blocked}`); },
      delegate: async (id: string, to: string) => { calls.push(`delegate ${id} to ${to}`); },
      moveToStateNamed: async (id: string, name: string) => { calls.push(`move ${id} to ${name}`); return { changed: true }; },
    },
    appUserId: async () => "paseo-app",
    readPlan: async () => "# Plan\n## Steps\n1. Add the domain\n2. Add the migration\n3. Wire the API",
    retirePlanner: async (_url: string, agentId: string) => { calls.push(`retire ${agentId}`); },
  };
  const planner = { agents: { ref: () => ({ refresh: async () => ({ agent: { model: "omp/opus", effectiveThinkingOptionId: "medium" } }) }) } } as unknown as PaseoApi;
  const summary = await splitIntoSubIssues(deps, { issueId: "parent", identifier: "TUC-1", agentId: "planner" }, "http://localhost:5000/", planner);
  assert.deepEqual(calls, [
    "document > **Planned with:** `omp/opus · thinking medium`",
    "retire planner",
    "create Add the domain parent=parent project=p9 ready",
    "create Add the migration parent=parent project=p9 ready",
    "s1 blocks s2",
    "create Wire the API parent=parent project=p9 ready",
    "s2 blocks s3",
    "delegate s1 to paseo-app", "delegate s2 to paseo-app", "delegate s3 to paseo-app",
    "move parent to In Progress",
  ]);
  assert.match(summary, /Split into 3 sub-issues \(TUC-11, TUC-12, TUC-13\)/);
  await assert.rejects(splitIntoSubIssues({ ...deps, readPlan: async () => "just prose" }, { issueId: "parent", identifier: "TUC-1", agentId: "planner" }, "http://localhost:5000/", {} as PaseoApi), /fewer than two/);
});

test("health problems open one urgent ticket after two failed checks, update it, and complete it on recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-health-"));
  const calls: string[] = [];
  let funnelOk = false;
  let receiverOk = true;
  try {
    const monitor = new HealthMonitor({
      createIssue: async (input: { title: string; priority?: number }) => { calls.push(`create ${input.title} p${input.priority}`); return { id: "h1", identifier: "TUC-99", url: "" }; },
      updateDescription: async () => { calls.push("describe"); },
      comment: async (_id: string, body: string) => { calls.push(`comment ${body}`); },
      complete: async () => { calls.push("complete"); },
      teamIdByKey: async () => "t1",
      viewerId: async () => OWNER,
    }, { read: async () => ({ ...settings, dispatch: { ...settings.dispatch, teamKeys: ["TUC"] } }) }, [
      { name: "Tailscale Funnel", run: async () => { if (!funnelOk) throw new Error("Funnel is off"); } },
      { name: "Webhook receiver", run: async () => { if (!receiverOk) throw new Error("down"); } },
    ], join(directory, "health.json"));
    assert.deepEqual(await monitor.check(), {}, "one failure is not confirmed");
    assert.deepEqual(await monitor.check(), { "Tailscale Funnel": "Funnel is off" });
    assert.deepEqual(calls, ["create ⚠️ Paseo needs attention p1"]);
    receiverOk = false;
    await monitor.check();
    await monitor.check();
    assert.deepEqual(calls.slice(1), ["describe", "comment Problems now: Tailscale Funnel, Webhook receiver."]);
    funnelOk = true;
    receiverOk = true;
    await monitor.check();
    assert.deepEqual(calls.slice(3), ["comment ✅ All checks pass again.", "complete"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
