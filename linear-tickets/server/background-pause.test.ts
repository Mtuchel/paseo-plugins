import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";
import { Dispatcher } from "./dispatch";
import { HealthMonitor } from "./health";
import { LabelRepair } from "./label-repair";
import { LabelSync } from "./label-sync";
import { LinearService, postGraphQL, type Post } from "./linear";
import { LinearUsage } from "./linear-usage";
import { ManualTasks, type ManualTask } from "./manual-tasks";
import { PlanRequests } from "./plan-requests";
import { ProjectFlow, ProjectStore } from "./project-flow";
import { PullRequestWatch } from "./pr-watch";
import { RateBudget, RateLimitedError, withPriority, type Pool } from "./rate-budget";
import { CommentRelay } from "./relay";
import { SessionRouter, SessionStore } from "./sessions";
import { DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { StateLabels } from "./state-labels";
import { Writeback } from "./writeback";

const APP_TOKEN = "app-token";
const ID_A = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID_B = "c7d3f6b0-6a41-4f2e-9b8d-2f5c1a0e77c4";
const REQUESTS_LIMIT = 5_000;
const POINTS_LIMIT = 2_000_000;
// The budget every background fixture runs against: 19% of the points budget is below the 20%
// background reserve, so nothing goes out; 21% is above it, so the poller's own request is sent.
const LOW_POINTS = Math.floor(POINTS_LIMIT * 0.19);
const HIGH_POINTS = Math.ceil(POINTS_LIMIT * 0.21);
const PLENTY_REQUESTS = Math.ceil(REQUESTS_LIMIT * 0.95);

type Call = { pool: Pool; operation: string };
type Reply = Record<string, unknown> & { status?: number; errors?: { message: string }[] };
type Refusal = [Pool, string, "background" | "interactive"];

type Fixture = {
  clock: { now: number };
  now: () => number;
  calls: Call[];
  refusals: Refusal[];
  budget: RateBudget;
  linear: LinearService;
  post: Post;
  // Records a budget sample like the pool's first answered response would, without a request.
  sample: (pool: Pool, requests: number, points: number) => void;
};

// The real request path (LinearService/AgentApi → postGraphQL → RateBudget) against a fake Linear:
// every request is recorded with its credential and operation, the answer is canned per operation,
// and each response carries both dimensions' budget (or the countdown the caller sets). `usage` is
// a real LinearUsage whose `refused` is wrapped, so a local refusal is visible with its caller.
function fixture(t: TestContext, reply: (call: Call, variables: Record<string, unknown>) => Reply = () => ({}), remaining?: (call: Call) => { requests: number; points: number }): Fixture {
  const clock = { now: 1_000_000_000 };
  const now = () => clock.now;
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", (async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).authorization;
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const call: Call = { pool: /^Bearer\s/i.test(auth) ? "app" : "key", operation: /\b(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?" };
    calls.push(call);
    const { status = 200, errors, ...data } = reply(call, body.variables);
    const budget = remaining?.(call) ?? { requests: PLENTY_REQUESTS, points: HIGH_POINTS };
    return new Response(JSON.stringify(errors ? { errors } : { data }), {
      status,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-requests-limit": String(REQUESTS_LIMIT),
        "x-ratelimit-requests-remaining": String(budget.requests),
        "x-ratelimit-complexity-limit": String(POINTS_LIMIT),
        "x-ratelimit-complexity-remaining": String(budget.points),
      },
    });
  }) as typeof fetch);
  const usage = new LinearUsage(now, { path: join(tmpdir(), `paseo-usage-${randomUUID()}.json`) });
  const refusals: Refusal[] = [];
  const accounting = usage.refused.bind(usage);
  usage.refused = (pool, caller, level) => {
    refusals.push([pool, caller, level]);
    accounting(pool, caller, level);
  };
  const budget = new RateBudget(now, usage);
  const post: Post = (key, query, variables) => postGraphQL(key, query, variables, budget);
  const linear = new LinearService(new Credentials("/unused", "env-key"), post, new AgentApi({ accessToken: async () => APP_TOKEN }, post), budget);
  const sample = (pool: Pool, requests: number, points: number) => budget.acquire(pool, "owner").done(new Headers({
    "x-ratelimit-requests-limit": String(REQUESTS_LIMIT),
    "x-ratelimit-requests-remaining": String(requests),
    "x-ratelimit-complexity-limit": String(POINTS_LIMIT),
    "x-ratelimit-complexity-remaining": String(points),
  }), false);
  return { clock, now, calls, refusals, budget, linear, post, sample };
}
// Both pools at 19% (`LOW_POINTS`) or 21% (`HIGH_POINTS`) of their points: a background read goes
// to the key first (LinearService.read), so a poller pauses only when both are at their reserve,
// and then on the app's.
function bothAt(f: Fixture, points: number): void {
  f.sample("app", PLENTY_REQUESTS, points);
  f.sample("key", PLENTY_REQUESTS, points);
}

const settings = {
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["ENG"] },
  writeback: DEFAULT_WRITEBACK,
  activation: DEFAULT_ACTIVATION,
  backstop: DEFAULT_BACKSTOP,
} as unknown as PluginSettings;
// The write-back settings that make an agent's failed turn post its one Linear error comment.
const summaryWriteback = { ...settings, writeback: { ...DEFAULT_WRITEBACK, summaries: true } } as unknown as PluginSettings;

const AGENT = { id: "agent-1", title: "Agent", cwd: "/nowhere", labels: { "linear.issueId": ID_A, "linear.identifier": "TUC-1" } };
// The refresh every write-back path takes before its work; it carries the agent's ticket labels.
const agentPaseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, title: AGENT.title, labels: AGENT.labels, pendingPermissions: [] } }) }) } } as unknown as PaseoApi;

const ISSUE_STATE_REPLY = { issue: { id: ID_A, identifier: "TUC-1", state: { id: "s-todo", name: "Todo", type: "unstarted" }, team: { id: "t1" }, labels: { nodes: [] }, attachments: { nodes: [] }, inverseRelations: { nodes: [] }, relations: { nodes: [] } } };
const HANDOVER_RECORD = { issueId: ID_A, identifier: "TUC-1", agentId: "agent-1", agentTitle: "Agent", branch: "tuc-1-work", worktreePath: null, lastCommit: null, summaries: [], links: {}, plan: null, review: null, model: null, waiting: null, status: "working", progressCommentId: null, resumedFrom: null, updatedAt: "2026-10-07T00:00:00Z" };
const MANUAL_TASK = (id: string, parentId: string): ManualTask => ({ id, identifier: id.toUpperCase(), url: `https://linear.app/x/issue/${id}`, title: `Do ${id}`, parentId, parentIdentifier: parentId.toUpperCase(), when: "anytime", check: null, cwd: "/nowhere", createdAt: "2026-09-28T00:00:00Z", announced: false, activated: true, verifiedAt: null });
// The dispatch poller's start paths must never run in these fixtures: nothing is labelled.
const noStarter = { admission: async () => { throw new Error("no launch while the pool is paused"); }, start: async () => { throw new Error("no launch while the pool is paused"); } };

function dispatcher(f: Fixture): Dispatcher {
  const dispatch = new Dispatcher({ linear: f.linear, starter: noStarter, launcher: { gate: () => ({ release: () => {} }) }, settings: { read: async () => settings }, budget: f.budget });
  dispatch.attach({} as PaseoApi);
  return dispatch;
}
function watcher(f: Fixture, dir: string): PullRequestWatch {
  return new PullRequestWatch({ handover: { all: async () => [HANDOVER_RECORD], update: async () => {} }, sessions: { crashed: async () => null }, linear: f.linear, settings: { read: async () => settings } } as never, join(dir, "pr-watch.json"));
}
async function directory(t: TestContext, prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
// The poller sent nothing and its local reserve refusal is counted under its own caller name.
function assertPaused(f: Fixture, caller: string, pool: Pool = "app"): void {
  assert.deepEqual(f.calls, [], "no request reaches Linear");
  assert.deepEqual(f.refusals, [[pool, caller, "background"]]);
}
// The poller's own first request really went out.
function assertSent(f: Fixture, pool: Pool = "app"): void {
  assert.equal(f.calls[0]?.pool, pool, `first request is on the ${pool} pool`);
}

// AC-2: the dispatch poll pauses with both pools at 19% of the points budget, and sends at 21%.
// The mock clock keeps the timer `attach` arms from polling a second time behind the explicit tick.
// A paused poll's one outgoing request is the queue-blocker read (README, "Auto-dispatch"): it is
// admitted at interactive priority and its empty reply starts nothing.
test("the dispatch poll pauses at 19% of the points budget and sends only the queue-blocker read; at 21% it reads the full one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const low = fixture(t, () => ({ issues: { nodes: [] } }));
  bothAt(low, LOW_POINTS);
  const paused = dispatcher(low);
  await paused.tick();
  assert.deepEqual(low.calls, [{ pool: "app", operation: "labeledIssues" }], "the queue-blocker read is admitted at interactive priority");
  assert.deepEqual(low.refusals, [["app", "dispatch", "background"]]);
  assert.match(paused.snapshot().lastError ?? "", /^paused:/);

  const high = fixture(t, () => ({ issues: { nodes: [] } }));
  bothAt(high, HIGH_POINTS);
  await dispatcher(high).tick();
  assertSent(high, "key");
});

// AC-1: the ticket's fixture, the poller side: plenty of requests, 3% of the points budget on both pools.
test("AC-1: at 3% of the points budget (4,500/5,000 requests) the dispatch poll reports paused and sends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.sample("app", 4_500, 60_000);
  f.sample("key", 4_500, 60_000);
  const paused = dispatcher(f);
  await paused.tick();
  assert.deepEqual(f.calls, [], "no request reaches Linear");
  assert.deepEqual(f.refusals, [["app", "dispatch", "background"], ["app", "queue-blocker", "interactive"]], "the queue-blocker read is admitted only above the 5% owner reserve");
  assert.match(paused.snapshot().lastError ?? "", /^paused: /);
});

// TUC-1684: the app's allowance at its reserve no longer pauses background reads while the key has room.
test("with the app at its reserve and the key free, the dispatch poll reads with the key and nothing goes to the app", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, () => ({ issues: { nodes: [] } }));
  f.sample("app", 4_500, 60_000);
  f.sample("key", PLENTY_REQUESTS, HIGH_POINTS);
  const dispatch = dispatcher(f);
  await dispatch.tick();
  assert.deepEqual(f.calls, [{ pool: "key", operation: "labeledIssues" }]);
  assert.deepEqual(f.refusals, []);
  assert.equal(dispatch.snapshot().lastError, null);
});

// AC-4's no-fallback rule on the launch path: the read on one pool never spends the other's reserve.
// The key at its reserve sends the background read back to the app (TUC-1684), and the launch
// that would spend the key's last budget waits. The paused poll's queue-blocker read repeats the
// app read at interactive priority; the key stays untouched.
test("with the key at its reserve the dispatch poll still reads on the app and sends nothing with the key", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, () => ({ issues: { nodes: [{ id: ID_A, identifier: "ENG-1", priority: 0, team: { key: "ENG" }, labels: { nodes: [{ id: "l1", name: "paseo" }] } }] } }));
  f.sample("key", 100, HIGH_POINTS);
  const dispatch = dispatcher(f);
  await dispatch.tick();
  assert.deepEqual(f.calls, [{ pool: "app", operation: "labeledIssues" }, { pool: "app", operation: "labeledIssues" }]);
  assert.match(dispatch.snapshot().lastError ?? "", /^paused:/);
});

// AC-2: the comment relay owns its caller context, so a direct poll is admitted as background work.
test("the comment relay pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-relay-");
  const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "agent-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", labels: AGENT.labels } }], pageInfo: { hasMore: false, nextCursor: null } }) } } as unknown as PaseoApi;

  // The relay's first Linear read is the viewer, which the key answers.
  const low = fixture(t);
  low.sample("key", PLENTY_REQUESTS, LOW_POINTS);
  await assert.rejects(new CommentRelay(low.linear, join(dir, "low.json")).poll(paseo), RateLimitedError);
  assertPaused(low, "comment-relay", "key");

  const high = fixture(t, (call) => call.operation === "viewerCheck" ? { viewer: { id: "me" } } : call.operation === "appViewer" ? { viewer: { id: "paseo-app", name: "Paseo" } } : {});
  high.sample("key", PLENTY_REQUESTS, HIGH_POINTS);
  await new CommentRelay(high.linear, join(dir, "high.json")).poll(paseo);
  assertSent(high, "key");
});

// AC-2: the project flow's own tick, not only the outer dispatch tick.
test("the project flow pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-projects-");
  const flow = (f: Fixture) => new ProjectFlow({
    linear: f.linear,
    scheduler: { note: async () => {}, admit: async () => ({ ok: true }), release: async () => {} },
    capacity: { limit: () => 5 },
    store: new ProjectStore(join(dir, "projects.json")),
    retire: async () => {},
    restart: async () => {},
    accountedFor: async () => false,
    now: f.now,
  } as never);

  const low = fixture(t);
  low.sample("app", PLENTY_REQUESTS, LOW_POINTS);
  await assert.rejects(flow(low).tick({} as PaseoApi, settings), RateLimitedError);
  assertPaused(low, "project-flow");

  const high = fixture(t, (call) => call.operation === "appViewer" ? { viewer: { id: "paseo-app", name: "Paseo" } } : { projects: { nodes: [] } });
  high.sample("app", PLENTY_REQUESTS, HIGH_POINTS);
  await flow(high).tick({} as PaseoApi, settings);
  assertSent(high);
});

// AC-2: the label repair's own tick, not only the outer dispatch tick.
test("the label repair pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-repair-");
  t.mock.method(console, "error", () => {});
  const repair = (f: Fixture) => new LabelRepair({
    linear: f.linear,
    store: new ProjectStore(join(dir, "projects.json")),
    launcher: { gate: () => ({ release: () => {} }), underWay: async () => false },
    restart: async () => ({ started: false }),
    intake: { claimsReady: async () => true, claimFor: async () => null, pendingFor: async () => [] },
    now: f.now,
  } as never);

  const low = fixture(t);
  bothAt(low, LOW_POINTS);
  await repair(low).tick({} as PaseoApi, settings);
  assertPaused(low, "label-repair");

  const high = fixture(t, () => ({ issues: { nodes: [], pageInfo: { hasNextPage: false } } }));
  bothAt(high, HIGH_POINTS);
  await repair(high).tick({} as PaseoApi, settings);
  assertSent(high, "key");
});

// AC-2: health's public check, which is where its caller context lives.
test("the health check pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-health-");
  const monitor = (f: Fixture) => new HealthMonitor(f.linear, { read: async () => settings }, [{ name: "Linear", run: async () => { await f.linear.viewerId(); } }], join(dir, "health.json"), () => new Date(f.clock.now).toISOString());

  const low = fixture(t);
  low.sample("key", PLENTY_REQUESTS, LOW_POINTS);
  assert.deepEqual(await monitor(low).check(), {}, "a limit is neither a pass nor a problem");
  assertPaused(low, "health", "key");

  const high = fixture(t, () => ({ viewer: { id: "me" } }));
  high.sample("key", PLENTY_REQUESTS, HIGH_POINTS);
  assert.deepEqual(await monitor(high).check(), {});
  assertSent(high, "key");
});

// AC-2: the label rules' own sync, which reads the app's identity first.
test("the label rules pause at 19% of the points budget and send at 21%", async (t) => {
  t.mock.method(console, "error", () => {});
  const rules = { teamKeys: ["ENG"], groups: [], hash: "rules-1" };
  const sync = (f: Fixture) => new LabelSync({ linear: f.linear, pullRequests: { filesOf: () => null, refresh: async () => {} }, rules: async () => rules, now: f.now } as never);

  const low = fixture(t);
  low.sample("app", PLENTY_REQUESTS, LOW_POINTS);
  await sync(low).sync();
  assertPaused(low, "label-sync");

  const high = fixture(t, (call) => call.operation === "appViewer" ? { viewer: { id: "paseo-app", name: "Paseo" } } : call.operation === "labelCatalog" ? { issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } : { issues: { nodes: [], pageInfo: { hasNextPage: false } } });
  high.sample("app", PLENTY_REQUESTS, HIGH_POINTS);
  await sync(high).sync();
  assertSent(high);
});

// AC-2: manual tasks read their tickets through the real pool admission.
test("the manual task poll pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-manual-");
  t.mock.method(console, "error", () => {});
  await writeFile(join(dir, "a.json"), JSON.stringify(MANUAL_TASK("a", "p1")));

  const low = fixture(t);
  bothAt(low, LOW_POINTS);
  await new ManualTasks({ linear: low.linear, settings: { read: async () => settings } }, dir).poll();
  assertPaused(low, "manual-tasks");

  const high = fixture(t, (_call, variables) => ({ issues: { nodes: ((variables.ids ?? []) as string[]).map((id) => ({ id, state: { name: "Todo", type: "unstarted" }, completedAt: null })) } }));
  bothAt(high, HIGH_POINTS);
  await new ManualTasks({ linear: high.linear, settings: { read: async () => settings } }, dir).poll();
  assertSent(high, "key");
});

// AC-2: the plan-request poll reads the agents' tickets through the real pool admission.
test("the plan request poll pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-plans-");
  t.mock.method(console, "error", () => {});
  const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "agent-1", labels: AGENT.labels } }], pageInfo: { hasMore: false, nextCursor: null } }) } } as unknown as PaseoApi;
  const poller = (f: Fixture) => new PlanRequests({ linear: f.linear, prompt: async () => "sent", directory: join(dir, "requests") } as never);

  const low = fixture(t);
  bothAt(low, LOW_POINTS);
  const paused = poller(low);
  paused.attach(paseo);
  await paused.poll();
  paused.stop();
  assertPaused(low, "plan-requests");

  const high = fixture(t, () => ({ issues: { nodes: [{ id: ID_A, labels: { nodes: [] } }] } }));
  bothAt(high, HIGH_POINTS);
  const running = poller(high);
  running.attach(paseo);
  await running.poll();
  running.stop();
  assertSent(high, "key");
});

// AC-2: the pull request watch's own poll. The crash pass runs first whatever the budget says;
// with no crashed agent, its only Linear read is the background batch of the running tickets'
// states, which pauses like the poll's own reads.
test("the pull request watch pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-prwatch-");
  t.mock.method(console, "error", () => {});
  const low = fixture(t);
  bothAt(low, LOW_POINTS);
  await watcher(low, dir).poll();
  assert.deepEqual(low.calls, [], "no request reaches Linear");
  assert.deepEqual(low.refusals, [["app", "crash-recovery", "background"], ["app", "pr-watch", "background"]]);

  const high = fixture(t, () => ISSUE_STATE_REPLY);
  bothAt(high, HIGH_POINTS);
  await watcher(high, dir).poll();
  assertSent(high, "key");
});

// TUC-1684 AC-3: while background Linear work is paused, a crashed agent is still restarted in the
// same poll: its ticket check goes at interactive priority as `crash-recovery`.
test("with background work paused on both pools, the pull request watch still restarts a crashed agent", async (t) => {
  const dir = await directory(t, "paseo-crash-");
  t.mock.method(console, "error", () => {});
  // Every answer keeps both pools at 19%: background work stays paused through the whole poll.
  const f = fixture(t, () => ({ issue: { state: { name: "In Progress", type: "started" } } }), () => ({ requests: PLENTY_REQUESTS, points: LOW_POINTS }));
  bothAt(f, LOW_POINTS);
  const prompts: string[] = [];
  const sessions = {
    crashed: async () => "OMP RPC process is closed",
    prompt: async (agentId: string, text: string, onDispatch?: () => Promise<void>, recovery?: { before: (resume: string, error: string) => Promise<void> }) => {
      await recovery?.before(`resume: ${text}`, "OMP RPC process is closed");
      await onDispatch?.();
      prompts.push(`${agentId}: ${text}`);
      return "restarted";
    },
    say: async () => {},
    sessionFor: async () => null,
  };
  await new PullRequestWatch({ handover: { all: async () => [HANDOVER_RECORD], update: async () => {} }, sessions, linear: f.linear, settings: { read: async () => settings } } as never, join(dir, "pr-watch.json")).poll();
  assert.deepEqual(prompts, ["agent-1: Your ticket TUC-1 is in In Progress. Continue the lifecycle step you were on."]);
  assert.deepEqual(f.calls, [{ pool: "app", operation: "issueStatus" }], "only the crash check went out");
  assert.deepEqual(f.refusals, [["app", "crash-recovery", "background"], ["app", "pr-watch", "background"]], "the running tickets' batch and the pull request work wait");
});

// AC-2: the queue backstop's own run.
test("the queue backstop pauses at 19% of the points budget and sends at 21%", async (t) => {
  const dir = await directory(t, "paseo-backstop-");
  t.mock.method(console, "error", () => {});
  const low = fixture(t);
  bothAt(low, LOW_POINTS);
  await watcher(low, dir).backstop();
  assertPaused(low, "queue backstop");

  const high = fixture(t, () => ISSUE_STATE_REPLY);
  bothAt(high, HIGH_POINTS);
  await watcher(high, dir).backstop();
  assertSent(high, "key");
});

// AC-2: the workspace state labels' batched ticket read.
test("the state labels pause at 19% of the points budget and send at 21%", async (t) => {
  t.mock.method(console, "error", () => {});
  const daemon = () => ({
    workspaces: async () => [{ id: "w1", name: "TUC-1: work", labels: [] }],
    ticketAgents: async () => [{ workspaceId: "w1", issueId: ID_A, identifier: "TUC-1", createdAt: "2026-01-01T00:00:00Z" }],
    catalog: async () => [],
    assign: async () => {},
    unassign: async () => {},
    recolor: async () => {},
  });
  const labels = (f: Fixture) => new StateLabels({ linear: f.linear, daemon: async () => daemon(), now: f.now } as never);

  const low = fixture(t);
  bothAt(low, LOW_POINTS);
  await labels(low).sync();
  assertPaused(low, "state-labels");

  const high = fixture(t, () => ({ issues: { nodes: [{ id: ID_A, state: { name: "Todo", type: "unstarted" }, completedAt: null }] } }));
  bothAt(high, HIGH_POINTS);
  await labels(high).sync();
  assertSent(high, "key");
});

// AC-4: at 4% of either dimension the interactive work is refused and the owner's share passes.
test("AC-4: at 4% of either dimension a write-back comment, a session reply and the sidebar list are refused and the owner passes", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const dimension of ["requests", "points"] as const) {
    const dir = await directory(t, `paseo-interactive-${dimension}-`);
    const f = fixture(t, (call) => call.operation === "comment" ? { commentCreate: { success: true, comment: { id: "c1" } } } : call.operation === "agentActivity" ? { agentActivityCreate: { success: true } } : { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    f.sample("app", dimension === "requests" ? 200 : PLENTY_REQUESTS, dimension === "points" ? 80_000 : HIGH_POINTS);
    f.sample("key", dimension === "requests" ? 200 : PLENTY_REQUESTS, dimension === "points" ? 80_000 : HIGH_POINTS);
    const writeback = new Writeback(f.linear, { read: async () => summaryWriteback }, undefined, 0, join(dir, "outbox.json"));
    const router = new SessionRouter({ api: new AgentApi({ accessToken: async () => APP_TOKEN }, f.post), store: new SessionStore(join(dir, "sessions.json")) } as never);
    const turn = { agent: AGENT, outcome: { kind: "failed", error: new Error("boom") }, timeline: [] } as never;

    // Interactive work is refused on both pools, before any request goes out.
    await writeback.turnEnded(turn, agentPaseo);
    await assert.rejects(router.say("session-1", "thought", "hi"), (error: unknown) => error instanceof RateLimitedError && error.reason === "reserve");
    await assert.rejects(f.linear.issues(), (error: unknown) => error instanceof RateLimitedError && error.reason === "reserve");
    assert.deepEqual(f.calls, [], "the interactive work is not sent");
    assert.deepEqual(f.refusals, [
      ["app", "op:comment", "interactive"],
      ["app", "op:agentActivity", "interactive"],
      ["key", "op:listIssues", "interactive"],
    ]);

    // The owner's write to each of them passes at the same 4%.
    await withPriority("owner", "plan decision", () => writeback.turnEnded(turn, agentPaseo));
    await withPriority("owner", "plan decision", () => router.say("session-1", "thought", "hi"));
    await withPriority("owner", "plan decision", () => f.linear.issues());
    assert.deepEqual(f.calls, [
      { pool: "app", operation: "comment" },
      { pool: "app", operation: "agentActivity" },
      { pool: "key", operation: "listIssues" },
    ]);
  }
});

test("AC-4: at 6% interactive work passes while the same work at background priority is refused", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const dimension of ["requests", "points"] as const) {
    const dir = await directory(t, `paseo-six-${dimension}-`);
    const sample = (f: Fixture) => f.sample("app", dimension === "requests" ? 300 : PLENTY_REQUESTS, dimension === "points" ? 120_000 : HIGH_POINTS);
    const reply = (call: Call) => call.operation === "comment" ? { commentCreate: { success: true, comment: { id: "c1" } } } : {};
    const turn = { agent: AGENT, outcome: { kind: "failed", error: new Error("boom") }, timeline: [] } as never;

    const interactive = fixture(t, reply);
    sample(interactive);
    await new Writeback(interactive.linear, { read: async () => summaryWriteback }, undefined, 0, join(dir, "outbox-interactive.json")).turnEnded(turn, agentPaseo);
    assert.deepEqual(interactive.calls, [{ pool: "app", operation: "comment" }]);

    const background = fixture(t, reply);
    sample(background);
    await withPriority("background", "dispatch poll", async () => {
      await new Writeback(background.linear, { read: async () => summaryWriteback }, undefined, 0, join(dir, "outbox-background.json")).turnEnded(turn, agentPaseo);
    });
    assert.deepEqual(background.calls, [], "the same write is refused for background work");
    assert.deepEqual(background.refusals, [["app", "dispatch poll", "background"]]);
  }
});

// AC-4/AC-2: with the app at its reserve a poll stops on the app and never moves a write to the key.
test("the app reaching its reserve during a poll stops the remaining writes without falling back to the key; the pause is logged once", async (t) => {
  const dir = await directory(t, "paseo-tasks-");
  for (const item of [MANUAL_TASK("a", "p1"), MANUAL_TASK("bb", "p2")]) await writeFile(join(dir, `${item.id}.json`), JSON.stringify(item));
  // The plugin's writes go out as the app, which starts one request above its 20% reserve
  // (1,001 of 5,000) plus room and loses one per answered request; the key reads stay plentiful
  // and take the poll's background reads (TUC-1684).
  let appRemaining = 1_002;
  const f = fixture(t, (call, variables) => {
    const data: Record<string, Record<string, unknown>> = {
      issueStatuses: { issues: { nodes: ((variables.ids ?? []) as string[]).map((id) => ({ id, state: { type: "unstarted" }, completedAt: null })) } },
      labelByName: { issueLabels: { nodes: [{ id: "l-manual", name: "paseo-manual" }] } },
      addLabel: { issueAddLabel: { success: true } },
      viewerCheck: { viewer: { id: "me" } },
      userUrl: { user: { url: "https://linear.app/ws/profiles/me" } },
      comment: { commentCreate: { success: true, comment: { id: "c1" } } },
    };
    return data[call.operation] ?? {};
  }, (call) => ({ requests: call.pool === "app" ? appRemaining-- : PLENTY_REQUESTS, points: HIGH_POINTS }));
  f.sample("app", 1_002, HIGH_POINTS);
  f.sample("key", PLENTY_REQUESTS, HIGH_POINTS);
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.join(" ")); });
  const manual = new ManualTasks({ linear: f.linear, settings: { read: async () => settings } }, dir);

  await manual.poll();
  assert.deepEqual(f.calls.map((call) => `${call.pool} ${call.operation}`), [
    "key issueStatuses",
    "key labelByName", "app addLabel", "key viewerCheck", "key userUrl", "app comment",
    // The second ticket's label goes out; its mention would dip into the app's reserve and waits
    // instead of going out with the key.
    "app addLabel",
  ]);
  assert.equal(JSON.parse(await readFile(join(dir, "a.json"), "utf8")).announced, true);
  assert.equal(JSON.parse(await readFile(join(dir, "bb.json"), "utf8")).announced, false);

  f.calls.length = 0;
  await manual.poll();
  assert.deepEqual(f.calls.map((call) => `${call.pool} ${call.operation}`), ["key issueStatuses"], "the read goes on with the key; the app stays paused and no write moves to the key");
  assert.equal(errors.filter((line) => line.includes("manual tasks paused")).length, 1);
});

// AC-7: every public state mover runs at owner priority inside a background context.
test("AC-7: moveToStateNamed reads and writes inside a background context at 3% of the points budget", async (t) => {
  const f = fixture(t, (call) => {
    if (call.operation === "issueState") return ISSUE_STATE_REPLY;
    if (call.operation === "teamStates") return { team: { states: { nodes: [{ id: "s-wip", name: "In Progress", type: "started", position: 2 }, { id: "s-review", name: "In Review", type: "started", position: 3 }] } } };
    if (call.operation === "issueUpdateState") return { issueUpdate: { success: true, issue: { id: ID_A, state: { name: "In Progress", type: "started" } } } };
    return {};
  });
  f.sample("app", 4_500, 60_000);
  f.sample("key", PLENTY_REQUESTS, 60_000);

  const result = await withPriority("background", "dispatch poll", () => f.linear.moveToStateNamed(ID_A, "In Progress"));
  assert.deepEqual(result, { changed: true });
  assert.deepEqual(f.calls.map((call) => `${call.pool} ${call.operation}`), ["app issueState", "key teamStates", "app issueUpdateState"]);
  assert.deepEqual(f.refusals, [], "the owner tier never touches the reserve");
});

test("AC-7: markInProgress moves the ticket inside a background context at 3% of the points budget", async (t) => {
  const f = fixture(t, (call) => {
    if (call.operation === "teamStates") return { team: { states: { nodes: [{ id: "s-wip", name: "In Progress", type: "started", position: 2 }] } } };
    if (call.operation === "issueUpdateState") return { issueUpdate: { success: true, issue: { id: ID_A, state: { name: "In Progress", type: "started" } } } };
    return {};
  });
  f.sample("app", 4_500, 60_000);
  f.sample("key", PLENTY_REQUESTS, 60_000);

  const moved = await withPriority("background", "dispatch poll", () => f.linear.markInProgress({ id: ID_A, status: "Todo", statusType: "unstarted" }, "t1"));
  assert.deepEqual(moved, { changed: true });
  assert.deepEqual(f.calls.map((call) => `${call.pool} ${call.operation}`), ["key teamStates", "app issueUpdateState"]);
});

test("AC-7: markInProgress keeps its best-effort warning note, also in a paused context", async (t) => {
  const f = fixture(t, (call) => call.operation === "teamStates" ? { status: 500, errors: [{ message: "Internal error" }] } : {});
  f.sample("app", 4_500, 60_000);
  f.sample("key", PLENTY_REQUESTS, 60_000);

  const failed = await withPriority("background", "dispatch poll", () => f.linear.markInProgress({ id: ID_A, status: "Todo", statusType: "unstarted" }, "t1"));
  assert.equal(failed.changed, false);
  assert.match(failed.note ?? "", /Could not load the ticket team's states: The Linear API request failed: Internal error/);

  const teamless = await withPriority("background", "dispatch poll", () => f.linear.markInProgress({ id: ID_A, status: "Todo", statusType: "unstarted" }, null));
  assert.deepEqual(teamless, { changed: false, note: "The ticket has no team, so it could not be marked in progress." });
});

// TUC-1684: background reads go to the key first; the app answers only what the key cannot see.
test("a background read the key cannot see, or sees in part, is read again with the app; interactive reads stay on the app", async (t) => {
  const notFound = { status: 200, errors: [{ message: "Entity not found: Issue" }] };
  const f = fixture(t, (call, variables) => {
    if (call.operation === "issueStatus") return call.pool === "key" ? notFound : { issue: { state: { name: "Todo", type: "unstarted" } } };
    if (call.operation === "issueStatuses") return { issues: { nodes: ((variables.ids ?? []) as string[]).filter((id) => call.pool === "app" || id === ID_A).map((id) => ({ id, state: { name: "Todo", type: "unstarted" }, completedAt: null })) } };
    return {};
  });
  bothAt(f, HIGH_POINTS);
  await withPriority("background", "test", () => f.linear.issueStatus(ID_A));
  await withPriority("background", "test", () => f.linear.issueStatuses([ID_A, "other"]));
  await withPriority("interactive", "test", () => f.linear.issueStatus(ID_A));
  assert.deepEqual(f.calls.map((call) => `${call.pool} ${call.operation}`), ["key issueStatus", "app issueStatus", "key issueStatuses", "app issueStatuses", "app issueStatus"]);
});

test("a Linear rate limit on a key-first background read propagates without asking the app", async (t) => {
  const f = fixture(t, (call) => call.pool === "key" ? { status: 400, errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] as never } : { issue: { state: { name: "Todo", type: "unstarted" } } });
  bothAt(f, HIGH_POINTS);
  await assert.rejects(withPriority("background", "test", () => f.linear.issueStatus(ID_A)), (error: unknown) => error instanceof RateLimitedError && error.pool === "key");
  assert.deepEqual(f.calls, [{ pool: "key", operation: "issueStatus" }]);
});

// Crash recovery's ticket check (pr-watch.ts) at interactive priority: the key answers when the
// app's pool refuses, and only both refusing stops it.
test("the crash check reads with the key when the app is at its reserve and is refused only when both are", async (t) => {
  const f = fixture(t, () => ({ issue: { state: { name: "In Progress", type: "started" } } }));
  f.sample("app", 100, HIGH_POINTS);
  f.sample("key", PLENTY_REQUESTS, HIGH_POINTS);
  const before = Date.now();
  const { sentAt, ...read } = await withPriority("interactive", "crash-recovery", () => f.linear.issueStatusAnyPool(ID_A));
  assert.deepEqual(read, { status: "In Progress", statusType: "started" });
  assert.ok(sentAt >= before && sentAt <= Date.now(), "stamped when the key's request was sent");
  assert.deepEqual(f.calls, [{ pool: "key", operation: "issueStatus" }]);

  f.calls.length = 0;
  f.sample("key", 100, HIGH_POINTS);
  await assert.rejects(withPriority("interactive", "crash-recovery", () => f.linear.issueStatusAnyPool(ID_A)), RateLimitedError);
  assert.deepEqual(f.calls, [], "nothing is sent past either reserve");
});

// The queue-blocker exception (README, "Auto-dispatch"): a queue-blocker ticket blocks the merge
// queue for everyone, so a paused background poll still reads and starts it, at interactive
// priority; every other labelled ticket keeps waiting for the background share.
test("while background is paused, a queue blocker is polled and started at interactive priority and a ticket that is not one waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started: string[] = [];
  const blocker = { id: ID_A, identifier: "TUC-538-1", priority: 1, team: { key: "ENG" }, labels: { nodes: [{ id: "l1", name: "paseo" }] } };
  const elsewhere = { id: ID_B, identifier: "ENG-2", priority: 0, team: { key: "ENG" }, labels: { nodes: [{ id: "l1", name: "paseo" }] } };
  const filters: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const f = fixture(t, (call, variables) => {
    const issueId = String((variables.id ?? (variables.input as { issueId?: string } | undefined)?.issueId) ?? "");
    if (call.operation === "addLabel" || call.operation === "removeLabel" || call.operation === "comment") writes.push(`${call.operation} ${issueId}`);
    if (call.operation === "labeledIssues") {
      const filter = variables.filter as Record<string, unknown>;
      filters.push(filter);
      return { issues: { nodes: filter.or ? [blocker] : [blocker, elsewhere] } };
    }
    if (call.operation === "labelByName") return { issueLabels: { nodes: [{ id: "l-running", name: "paseo-running" }] } };
    if (call.operation === "addLabel") return { issueAddLabel: { success: true } };
    if (call.operation === "removeLabel") return { issueRemoveLabel: { success: true } };
    if (call.operation === "comment") return { commentCreate: { success: true, comment: { id: "c1" } } };
    return {};
  });
  f.sample("app", PLENTY_REQUESTS, LOW_POINTS);
  f.sample("key", PLENTY_REQUESTS, LOW_POINTS);
  const dispatch = new Dispatcher({
    linear: f.linear,
    starter: { admission: async () => ({ ok: true as const }), start: async (issueId: string) => { started.push(issueId); return { agentId: "agent-1", warnings: [], provider: "claude", target: "repo", resumed: false, untrusted: false, plan: null }; } },
    launcher: { gate: () => ({ release: () => {} }) },
    settings: { read: async () => settings },
    budget: f.budget,
  });
  dispatch.attach({ agents: { list: async () => ({ entries: [] }) } } as unknown as PaseoApi);
  await dispatch.tick();
  assert.deepEqual(started, [ID_A], "only the queue blocker started");
  assert.ok(!writes.some((write) => write.endsWith(` ${ID_B}`)), `nothing touched the ticket that is not a blocker: ${writes.join(", ")}`);
  assert.deepEqual(f.refusals, [["app", "dispatch", "background"]], "the normal poll paused at the background reserve");
  assert.deepEqual(f.calls[0], { pool: "app", operation: "labeledIssues" }, "the blocker read ran at interactive priority, not on the paused path");
  assert.deepEqual(filters, [{ labels: { some: { name: { eqIgnoreCase: "paseo" } } }, team: { key: { in: ["ENG"] } }, state: { type: { nin: ["completed", "canceled"] } }, or: [{ title: { startsWith: "Queue blocker:" } }, { description: { contains: "Queue blocker id:" } }] }], "the read is filtered to the queue-blocker markers");
});

// The retry side of the exception: a blocker whose launch lost the pause race carries
// `paseo-failed`; the paused poll's blocker pass retries it at interactive priority instead of
// waiting for the owner.
test("while background is paused, a paseo-failed queue blocker is retried by the blocker repair pass at interactive priority", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const dir = await directory(t, "paseo-blocker-repair-");
  const comments: string[] = [];
  const restarts: string[] = [];
  const f = fixture(t, (call, variables) => {
    if (call.operation === "labeledIssues") return { issues: { nodes: [] } };
    if (call.operation === "repairCandidates") return { issues: { nodes: [{ id: ID_A, identifier: "TUC-1", title: "Queue blocker: Image scan", state: { name: "Todo", type: "unstarted" }, project: null, labels: { nodes: [{ id: "l-failed", name: "paseo-failed" }] }, children: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } };
    if (call.operation === "issueState") return ISSUE_STATE_REPLY;
    if (call.operation === "labelByName") return { issueLabels: { nodes: [{ id: "l-running", name: "paseo-running" }] } };
    if (call.operation === "addLabel") return { issueAddLabel: { success: true } };
    if (call.operation === "removeLabel") return { issueRemoveLabel: { success: true } };
    if (call.operation === "comment") { comments.push(String((variables.input as { body?: string } | undefined)?.body ?? "")); return { commentCreate: { success: true, comment: { id: "c1" } } }; }
    return {};
  });
  f.sample("app", PLENTY_REQUESTS, LOW_POINTS);
  f.sample("key", PLENTY_REQUESTS, LOW_POINTS);
  const store = new ProjectStore(join(dir, "projects.json"));
  // The failed launch's incident, due for its first retry.
  await store.updateRepairs(() => ({ [ID_A]: { incident: "pause-1", identifier: "TUC-1", kind: "failed", state: "watching", attempts: 0, failedSince: new Date(f.clock.now - 11 * 60_000).toISOString(), log: [] } }));
  const repairs = new LabelRepair({
    linear: f.linear, store, launcher: { gate: () => ({ release: () => {} }), underWay: () => false },
    restart: async (_issueId: string, identifier: string) => { restarts.push(identifier); return { kind: "started" as const, agentId: "agent-9", marked: false }; },
    intake: { claimsReady: async () => true, claimFor: async () => null, pendingFor: async () => false },
    now: f.now,
  } as never);
  const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) } } as unknown as PaseoApi;
  const dispatch = new Dispatcher({
    linear: f.linear,
    starter: { admission: async () => ({ ok: true as const }), start: async () => { throw new Error("nothing carries the trigger label"); } },
    launcher: { gate: () => ({ release: () => {} }) },
    settings: { read: async () => settings },
    budget: f.budget,
    repairs,
  });
  dispatch.attach(paseo);
  await dispatch.tick();
  assert.deepEqual(restarts, ["TUC-1"], "the retry ran while the background share stayed paused");
  assert.deepEqual(f.refusals, [["app", "dispatch", "background"]]);
  assert.deepEqual(f.calls[0], { pool: "app", operation: "labeledIssues" }, "the blocker poll's read is admitted at interactive priority; the same pool's background share is paused");
  assert.ok(comments.some((body) => body.startsWith("Paseo started an agent for this ticket on retry 1 of 3")), comments.join(" | "));
  assert.ok(!comments.some((body) => body.includes("profiles/")), "no owner mention");
});

// The blocker reads are filtered server-side, and a marker-filtered read marks every candidate,
// so the retry rules apply without a further read.
test("the queue-blocker repair reads filter on the markers and mark their candidates", async (t) => {
  const filters: Record<string, unknown>[] = [];
  const nodes = [
    { id: ID_A, identifier: "TUC-1", title: "Queue blocker: Image scan", state: { name: "Todo", type: "unstarted" }, project: null, labels: { nodes: [{ id: "l1", name: "paseo-failed" }] }, children: { nodes: [] } },
    { id: ID_B, identifier: "ENG-2", title: "Unrelated work", state: { name: "Todo", type: "unstarted" }, project: null, labels: { nodes: [{ id: "l2", name: "paseo-failed" }] }, children: { nodes: [] } },
  ];
  const f = fixture(t, (call, variables) => {
    if (call.operation !== "repairCandidates") return {};
    filters.push(variables.filter as Record<string, unknown>);
    return { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
  });
  const open = await f.linear.repairCandidates({ labels: ["paseo-failed"], teamKeys: ["ENG"], ids: [] });
  assert.deepEqual(open.map((ticket) => [ticket.identifier, ticket.queueBlocker]), [["TUC-1", true], ["ENG-2", false]], "the title prefix marks a blocker on the unfiltered read");
  const blockers = await f.linear.repairCandidates({ labels: ["paseo-failed"], teamKeys: ["ENG"], ids: [], queueBlockers: true });
  assert.deepEqual(filters[1]?.or, [{ title: { startsWith: "Queue blocker:" } }, { description: { contains: "Queue blocker id:" } }], "the read is filtered to the markers");
  assert.deepEqual(blockers.map((ticket) => [ticket.identifier, ticket.queueBlocker]), [["TUC-1", true], ["ENG-2", true]], "a marker-filtered read marks every candidate it returns");
});
