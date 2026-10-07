import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { AgentApi, AppAuth } from "./agent-app";
import { verifyWebhook } from "./agent-webhook";
import { fingerprint, type Candidate, type CorrectionActivity } from "./deputy";
import { Handover, handoverPrompt, progressBody, type HandoverRecord } from "./handover";
import { AuthenticationError, LinearApiError, LinearService, postGraphQL, type GroupChild, type IssueGroup, type IssueState } from "./linear";
import { closeAnswered, NeedsYouIssues } from "./needs-you";
import { PermissionReplies } from "./permission-replies";
import { planSteps, SessionRouter, SessionStore, type SessionLink } from "./sessions";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { ticketProcessLiveness, type ProcessAgent, type ProcessInspector } from "./process-liveness";
import { Credentials } from "./credentials";
import { RateBudget, RateLimitedError, withPriority } from "./rate-budget";

const OWNER = "owner-1";
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
  dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, deputy: DEFAULT_DEPUTY,
};

test("only fresh, correctly signed webhooks are accepted", () => {
  const secret = "lin_wh_test";
  const body = Buffer.from(JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: 1_000_000 }));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.ok(verifyWebhook(body, signature, secret, 1_000_500));
  assert.equal(verifyWebhook(body, signature, "other-secret", 1_000_500), null);
  assert.equal(verifyWebhook(body, undefined, secret, 1_000_500), null);
  assert.equal(verifyWebhook(body, signature.slice(2), secret, 1_000_500), null);
  assert.equal(verifyWebhook(body, signature, secret, 1_000_000 + 61_000), null, "older than 60 s");
});

test("the app token is refreshed before it expires and once more after a 401", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-agent-auth-"));
  try {
    await writeFile(join(directory, "app.json"), JSON.stringify({ clientId: "c", clientSecret: "s", webhookSecret: "w" }));
    await writeFile(join(directory, "token.json"), JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: 1_000 }));
    const refreshes: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      refreshes.push(String(init.body));
      return new Response(JSON.stringify({ access_token: `new-${refreshes.length}`, expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const auth = new AppAuth(directory, fakeFetch, () => 900_000);
    assert.equal(await auth.accessToken(), "new-1", "expired token refreshed");
    assert.match(refreshes[0], /grant_type=refresh_token&refresh_token=r1/);
    const saved = JSON.parse(await readFile(join(directory, "token.json"), "utf8"));
    assert.equal(saved.refresh_token, "r1", "refresh token kept when Linear does not rotate it");

    const posted: string[] = [];
    const api = new AgentApi(auth, async (key) => {
      posted.push(key);
      if (key === "Bearer new-1") throw new AuthenticationError("Linear rejected this API key. Check it in Linear settings and reconnect.", 401);
      return { agentActivityCreate: { success: true } };
    });
    await api.activity("session-1", { type: "thought", body: "hi" });
    assert.deepEqual(posted, ["Bearer new-1", "Bearer new-2"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a refused request (403) is not a reason to refresh the app token", async () => {
  const forces: boolean[] = [];
  const refused = new LinearApiError("Linear rejected this API key. Check it in Linear settings and reconnect.", 403);
  const posted: string[] = [];
  const api = new AgentApi({ accessToken: async (force = false) => { forces.push(force); return "t"; } }, async (key) => { posted.push(key); throw refused; });
  await assert.rejects(api.activity("session-1", { type: "thought", body: "hi" }), (error: unknown) => error === refused);
  assert.deepEqual(forces, [false]);
  assert.deepEqual(posted, ["Bearer t"]);
});

test("a reserved activity id is sent with the create, and an activity lookup tells 'no such activity' apart from a failure", async () => {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const notFound = new LinearApiError("The Linear API request failed: Entity not found: AgentActivity", 400, ["INPUT_ERROR"], ["Entity not found: AgentActivity"]);
  let lookup: Error | null = null;
  const api = new AgentApi({ accessToken: async () => "t" }, async (_key, query, variables) => {
    sent.push({ query, variables });
    if (query.includes("agentActivityById")) { if (lookup) throw lookup; return { agentActivity: { id: String(variables.id) } }; }
    return { agentActivityCreate: { success: true } };
  });
  await api.activity("session-1", { type: "thought", body: "hi" }, { id: "11111111-1111-4111-8111-111111111111" });
  const create = sent[0].variables.input;
  assert.ok(create && typeof create === "object" && "id" in create && create.id === "11111111-1111-4111-8111-111111111111", "the reserved id is carried into the create input");
  assert.deepEqual(await api.activityById("a1"), { id: "a1" });
  lookup = notFound;
  assert.equal(await api.activityById("gone"), null);
  lookup = new Error("Could not reach the Linear API. Check the host's network connection and try again.");
  await assert.rejects(api.activityById("gone"), /Could not reach the Linear API/);
});

test("only this app's sessions are open here: another host's app never has its threads adopted", async () => {
  const node = (id: string, app: string | null) => ({ id, status: "pending", createdAt: "2026-01-01T00:00:00Z", appUser: app ? { id: app } : null, creator: { id: OWNER }, issue: { id: `i-${id}`, identifier: `TUC-${id}` } });
  const answer = (viewer: string | null) => async () => ({ viewer: viewer ? { id: viewer } : null, agentSessions: { nodes: [node("1", "server-app"), node("2", "mac-app"), node("3", null), node("4", "server-app")] } });
  const mine = new AgentApi({ accessToken: async () => "t" }, answer("server-app"));
  assert.deepEqual((await mine.openSessions()).map((session) => session.id), ["1", "4"]);
  const unknown = new AgentApi({ accessToken: async () => "t" }, answer(null));
  assert.deepEqual(await unknown.openSessions(), [], "without its own id the app claims no thread");
});

const NOW = 1_000_000_000_000;
const MINUTE = 60_000;

// An installed app on a temporary directory; `refreshes` counts Linear's token endpoint calls,
// `respond` answers them (by default a new token for an hour). `clock` is the app's clock.
async function installedApp(t: TestContext, token: Record<string, unknown>, respond?: () => Response | Promise<Response>) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-agent-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "app.json"), JSON.stringify({ clientId: "c", clientSecret: "s", webhookSecret: "w" }));
  await writeFile(join(directory, "token.json"), JSON.stringify({ access_token: "old", refresh_token: "r1", ...token }));
  const fixture = { refreshes: 0, clock: NOW, auth: null as unknown as AppAuth, directory };
  const fakeFetch = (async () => {
    fixture.refreshes++;
    return respond ? respond() : new Response(JSON.stringify({ access_token: `new-${fixture.refreshes}`, expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  fixture.auth = new AppAuth(directory, fakeFetch, () => fixture.clock);
  return fixture;
}

// Lets pending I/O (token file reads and writes) run until `done` holds.
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 10_000 && !done(); turn++) await setImmediatePromise();
  assert.ok(done(), "condition not reached");
}

test("the app token is refreshed only within ten minutes of its expiry", async (t) => {
  const fresh = await installedApp(t, { expires_at: NOW + 10 * MINUTE + 1 });
  assert.equal(await fresh.auth.accessToken(), "old");
  assert.equal(fresh.refreshes, 0);

  const due = await installedApp(t, { expires_at: NOW + 10 * MINUTE });
  assert.equal(await due.auth.accessToken(), "new-1");
  assert.equal(due.refreshes, 1);
  const saved = JSON.parse(await readFile(join(due.directory, "token.json"), "utf8"));
  assert.equal(saved.expires_at, NOW + 3600 * 1000);
});

test("callers asking for a due token at the same time share one refresh", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = await installedApp(t, { expires_at: NOW - 1 }, async () => {
    await gate;
    return new Response(JSON.stringify({ access_token: "new-1", expires_in: 3600 }), { status: 200 });
  });
  const tokens = Promise.all([app.auth.accessToken(), app.auth.accessToken(), app.auth.accessToken()]);
  await until(() => app.refreshes === 1);
  release();
  assert.deepEqual(await tokens, ["new-1", "new-1", "new-1"]);
  assert.equal(app.refreshes, 1);
});

test("keepFresh refreshes a nearly expired token at once and then on every tick, with one timer per instance until stopped", async (t) => {
  const app = await installedApp(t, { expires_at: NOW + 5 * MINUTE });
  const asked = t.mock.method(app.auth, "accessToken");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stop = app.auth.keepFresh();
  assert.equal(asked.mock.callCount(), 1, "the first tick runs at once");
  await until(() => app.refreshes === 1);
  assert.equal(await app.auth.accessToken(), "new-1");
  asked.mock.resetCalls();

  const stopAgain = app.auth.keepFresh();
  assert.equal(asked.mock.callCount(), 0, "a second call keeps the running timer");
  app.clock += 55 * MINUTE;
  t.mock.timers.tick(5 * MINUTE);
  assert.equal(asked.mock.callCount(), 1, "one timer, one check per tick");
  await until(() => app.refreshes === 2);
  assert.equal(await app.auth.accessToken(), "new-2");
  asked.mock.resetCalls();

  stop();
  t.mock.timers.tick(15 * MINUTE);
  assert.equal(asked.mock.callCount(), 0, "stopped");
  stopAgain();
  assert.equal(app.refreshes, 2);
});

test("a failed keep-fresh refresh is logged, never an unhandled rejection", async (t) => {
  const app = await installedApp(t, { expires_at: NOW + MINUTE }, () => new Response("{}", { status: 400 }));
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.join(" ")); });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); });
  const stop = app.auth.keepFresh();
  t.after(stop);
  await until(() => errors.length === 1);
  await setImmediatePromise();
  assert.match(errors[0], /keeping the Paseo app token fresh failed: Linear refused to refresh the Paseo app token \(HTTP 400\)/);
  assert.deepEqual(unhandled, []);
  assert.equal(app.refreshes, 1);
});

test("plan checklists come from checkboxes, or numbered steps under a Steps heading", () => {
  assert.deepEqual(planSteps("# Plan\n- [ ] AC-1 domain\n- [x] AC-2 migration\ntext"), ["AC-1 domain", "AC-2 migration"]);
  assert.deepEqual(planSteps("## Context\n1. not a step\n## Steps\n1. First\n2. Second\n## Verification\n1. no"), ["First", "Second"]);
  assert.deepEqual(planSteps("no structure here"), []);
});

type Call = string;
type RouterLinear = Pick<LinearService, "viewerId" | "appUserId" | "addLabel" | "removeLabel" | "complete" | "cancel" | "issueState" | "issueStatus" | "issueStatuses" | "issueGroup" | "delegate" | "moveToStateNamed" | "comment" | "hasComment" | "userUrl">;
// `reload`: the daemon's agent reload (null: the plugin has no daemon connection); `send`: runs
// before each send is recorded.
function harness(options: { now?: () => number; pending?: AgentPermissionRequest[]; activeAgent?: { id: string; title: string } | null; snapshot?: () => Promise<unknown>; attach?: boolean; needsYou?: NeedsYouIssues; delegate?: (issueId: string, to: string) => Promise<void>; groups?: Record<string, IssueGroup>; blockedBy?: Record<string, string[]>; reload?: ((agentId: string) => Promise<void>) | null; send?: () => Promise<void>; agents?: ProcessAgent[]; processInspector?: ProcessInspector; processLiveness?: typeof ticketProcessLiveness; checked?: boolean; answer?: () => Promise<void>; directory?: string; manual?: boolean; budget?: RateBudget; api?: AgentApi; linear?: RouterLinear; admission?: (issueId: string) => Promise<{ ok: true } | { ok: false; reason: string }>; decideReview?: (url: string, approve: boolean, feedback: string, agentId: string) => Promise<void>; decidePlan?: (link: SessionLink, mode: "later" | "split") => Promise<string | null> } = {}) {
  const calls: Call[] = [];
  const api = {
    activity: async (sessionId: string, content: { type: string; body?: string }, extra: { options?: { value: string }[] } = {}) => { calls.push(`${content.type}:${content.body ?? ""}${extra.options ? ` [${extra.options.map((o) => o.value).join("|")}]` : ""}`); },
    updateSession: async () => {},
    createSessionOnIssue: async () => "s-new",
    viewer: async () => ({ id: "paseo-app", name: "Paseo" }),
    openSessions: async () => [],
    activities: async () => [],
    sessionStatus: async () => "stale",
    sessionStatuses: async (ids: string[]) => new Map(ids.map((id) => [id, "stale"])),
  };
  const paseo = {
    agents: {
      list: async (input?: { filter?: { includeArchived?: boolean } }) => ({
        entries: options.agents
          ? options.agents.filter((agent) => input?.filter?.includeArchived || !agent.archivedAt).map((agent) => ({ agent }))
          : options.activeAgent ? [{ agent: { ...options.activeAgent, labels: {} } }] : [],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      ref: (id: string) => ({
        refresh: options.snapshot ?? (async () => ({ agent: { pendingPermissions: options.pending ?? [] } })),
        send: async (text: string) => { await options.send?.(); calls.push(`send ${id}: ${text}`); },
        respondToPermission: async ({ requestId, response }: { requestId: string; response: unknown }) => { calls.push(`respond ${requestId} ${JSON.stringify(response)}`); },
        archive: async () => { calls.push(`archive ${id}`); return { archivedAt: "now" }; },
      }),
    },
  } as unknown as PaseoApi;
  const directory = options.directory ?? join(tmpdir(), `paseo-sessions-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = new SessionStore(join(directory, "sessions.json"));
  const replies = new PermissionReplies({
    directory,
    daemon: async () => options.checked ? {
      respondToPermissionAndWait: async (_agentId: string, requestId: string, response: AgentPermissionResponse) => {
        calls.push(`checked ${requestId} ${JSON.stringify(response)}`);
        await options.answer?.();
      },
    } : null,
  });
  const answered: { agentId: string; request: AgentPermissionRequest; response: AgentPermissionResponse; activity: CorrectionActivity; at: string }[] = [];
  replies.recordEffects({
    ownerAnswered: async (agentId, request, response, activity, at) => { answered.push({ agentId, request, response, activity, at }); },
    correctLate: async () => ({ delivered: false, reply: "No deputy answer to correct." }),
    needsYou: async (agentId, issueId) => {
      if (issueId && options.needsYou && (await options.needsYou.all()).some((entry) => entry.id === issueId && entry.agentId === agentId)) {
        await closeAnswered(options.needsYou, { complete: async (id) => { calls.push(`complete ${id}`); } }, issueId);
      }
    },
  });
  replies.attach(paseo);
  const router = new SessionRouter({
    api: (options.api ?? api) as never,
    linear: options.linear ?? {
      viewerId: async () => OWNER, appUserId: async () => "paseo-app",
      comment: async () => {}, hasComment: async () => false, userUrl: async () => "https://linear.app/owner",
      addLabel: async (_id: string, name: string) => { calls.push(`+${name}`); }, removeLabel: async (_id: string, name: string) => { calls.push(`-${name}`); },
      complete: async (id: string) => { calls.push(`complete ${id}`); }, cancel: async (id: string, reason: string) => { calls.push(`cancel ${id}: ${reason.split("\n")[0]}`); },
      issueState: async (id: string) => ({ id, status: "Todo", statusType: "unstarted", blockedBy: options.blockedBy?.[id] ?? [] }) as IssueState,
      issueStatus: async () => ({ status: "Todo", statusType: "unstarted" }),
      issueStatuses: async (ids: string[]) => new Map(ids.map((id) => [id, { status: "Todo", statusType: "unstarted", completedAt: null }])),
      issueGroup: async (id: string) => options.groups?.[id] ?? { id, identifier: "TUC-1", status: "Todo", statusType: "unstarted", delegateId: "paseo-app", finished: false, children: [] },
      moveToStateNamed: async (id: string, name: string) => { calls.push(`move ${id} to ${name}`); return { changed: true }; },
      delegate: options.delegate ?? (async (id: string, to: string) => { calls.push(`delegate ${id} to ${to}`); }),
    },
    starter: { start: async (_issue: string, _paseo: PaseoApi, _settings: PluginSettings, launch: { labels?: Record<string, string> }) => { calls.push(`start ${JSON.stringify(launch.labels)}`); return { agentId: "agent-new", warnings: [], provider: "omp/x", target: "repo", resumed: false, untrusted: false, plan: null }; }, admission: options.admission ?? (async () => ({ ok: true as const })) },
    handover: { resumeTarget: async () => null, handOff: async () => true },
    launcher: { gate: () => ({ release: () => {} }) },
    settings: { read: async () => settings },
    store,
    replies,
    needsYou: options.needsYou,
    budget: options.budget,
    now: options.now,
    decidePlan: options.decidePlan,
    stop: async (agentId) => { calls.push(`stop ${agentId}`); },
    decideReview: options.decideReview ?? (async (url, approve, feedback) => { calls.push(`review ${url} ${approve ? "approve" : `deny:${feedback}`}`); }),
    ...("reload" in options ? { reloader: async () => options.reload ? async (agentId: string) => { calls.push(`reload ${agentId}`); await options.reload!(agentId); } : null } : {}),
    ...(options.processLiveness ? { processLiveness: options.processLiveness } : options.processInspector ? { processLiveness: (paseo: PaseoApi, issueId: string, extra?: ProcessAgent[]) => ticketProcessLiveness(paseo, issueId, extra, options.processInspector) } : {}),
  });
  // Deterministic session/queue tests drive the sweep themselves, as do the group tests.
  if (options.groups || options.manual) Object.assign(router, { paseo });
  else if (options.attach ?? true) router.attach(paseo);
  router.stop();
  return { router, store, replies, answered, calls, paseo, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const link = (change: Partial<SessionLink> = {}): SessionLink => ({ sessionId: "s1", agentId: "agent-1", issueId: "i1", identifier: "TUC-1", createdAt: "2026-01-01T00:00:00Z", handled: [], review: null, offer: null, ...change });

test("a delegation from someone else is refused; the owner's starts an agent linked to the session", async () => {
  const other = harness();
  await other.router.created({ id: "s1", creatorId: "someone-else", issueId: "i1", issue: { identifier: "TUC-1" } });
  assert.deepEqual(other.calls, ["error:Only the workspace owner can start Paseo agents."]);
  await other.cleanup();

  const mine = harness();
  await mine.router.created({ id: "s1", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" } });
  assert.deepEqual(mine.calls.slice(0, 2), ["+paseo-running", 'start {"linear.sessionId":"s1"}']);
  assert.equal((await mine.store.get("s1"))?.agentId, "agent-new");
  await mine.cleanup();
});

test("a stalled ticket is started again with a new agent and thread: its errored thread is closed and its stopped agent archived", async () => {
  const h = harness();
  // TUC-678: the thread whose launch timed out (in error in Linear, no agent), and an older thread
  // whose agent was closed.
  await h.store.put(link({ sessionId: "s0", agentId: "agent-old", createdAt: "2025-12-31T00:00:00Z" }));
  await h.store.put(link({ agentId: null }));
  await h.router.restartFor("i1", "TUC-1");
  assert.deepEqual(h.calls, ["+paseo-running", "start undefined", "delegate i1 to paseo-app", "archive agent-old"]);
  assert.equal((await h.store.get("s-new"))?.agentId, "agent-new", "a new thread, not the errored one");
  assert.equal((await h.store.get("s1"))?.closed, true);
  assert.equal((await h.store.get("s0"))?.closed, true);
  await h.cleanup();
});

const child = (identifier: string, change: Partial<GroupChild> = {}): GroupChild => ({ id: identifier.toLowerCase(), identifier, status: "Todo", statusType: "unstarted", delegateId: null, finished: false, assigneeId: null, labels: [], blockers: [], ...change });
const parent = (children: GroupChild[], change: Partial<IssueGroup> = {}): IssueGroup => ({ id: "i1", identifier: "TUC-1", status: "Todo", statusType: "unstarted", delegateId: "paseo-app", finished: false, children, ...change });
const blocker = (identifier: string, change: Partial<GroupChild> = {}) => ({ id: identifier.toLowerCase(), identifier, status: "Todo", statusType: "unstarted", delegateId: null, finished: false, ...change });

test("assigning a parent with open sub-issues hands out the open ones nobody else has instead of starting an agent, and says what each waits for", async () => {
  const group = parent([
    child("TUC-2"),
    child("TUC-3", { assigneeId: OWNER, blockers: [blocker("TUC-2")] }),
    child("TUC-4", { assigneeId: "someone-else" }),
    child("TUC-5", { status: "Done", statusType: "completed", finished: true }),
    child("TUC-6", { assigneeId: OWNER, labels: ["paseo-manual"] }),
    child("TUC-7", { blockers: [blocker("TUC-88")] }),
  ]);
  const h = harness({ groups: { i1: group } });
  await h.router.created({ id: "s1", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" } });
  assert.ok(!h.calls.some((call) => call.startsWith("start ")), "no agent for the parent");
  assert.deepEqual(h.calls.filter((call) => call.startsWith("delegate ")), ["delegate tuc-2 to paseo-app", "delegate tuc-3 to paseo-app", "delegate tuc-7 to paseo-app"]);
  assert.ok(h.calls.includes("move i1 to In Progress"));
  assert.equal(h.calls.at(-1), [
    "thought:1 of 5 sub-issues finished. TUC-1 closes when all are.",
    "- TUC-2: starting",
    "- TUC-3: waits for TUC-2",
    "- TUC-4: assigned to someone else; TUC-1 waits for it",
    "- TUC-5: Done",
    "- TUC-7: waits for TUC-88 (not with Paseo, nobody is working on it here)",
  ].join("\n"));
  assert.deepEqual((await h.store.get("s1"))?.group?.delegated, true);
  await h.cleanup();
});

test("a blocked parent hands out nothing until its blockers finish; unassigning Paseo stops the group", async () => {
  const blockedBy: Record<string, string[]> = { i1: ["TUC-9"] };
  const groups = { i1: parent([child("TUC-2")]) };
  const h = harness({ groups, blockedBy });
  await h.router.created({ id: "s1", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" } });
  assert.ok(!h.calls.some((call) => call.startsWith("delegate ")));
  assert.match(h.calls.at(-1) ?? "", /^thought:TUC-1 is blocked by TUC-9; its sub-issues are handed out once that is finished\./);
  blockedBy.i1 = [];
  await h.router.advanceGroups();
  assert.deepEqual(h.calls.filter((call) => call.startsWith("delegate ")), ["delegate tuc-2 to paseo-app"]);
  groups.i1 = parent([child("TUC-2", { delegateId: "paseo-app" })], { delegateId: null });
  await h.router.advanceGroups();
  assert.equal(h.calls.at(-1), "response:Paseo was unassigned from TUC-1, so it stopped handing out sub-issues. Agents already working continue.");
  assert.equal((await h.store.get("s1"))?.closed, true);
  await h.cleanup();
});

test("the parent closes when every sub-issue is finished: Done when any was done, Canceled with the reason when all were canceled", async () => {
  const done = harness({ groups: { i1: parent([child("TUC-2", { status: "Done", statusType: "completed", finished: true }), child("TUC-3", { status: "Canceled", statusType: "canceled", finished: true }), child("TUC-4", { labels: ["paseo-manual"] })]) } });
  await done.store.put(link({ agentId: null, group: { delegated: true } }));
  await done.router.advanceGroups();
  assert.ok(done.calls.includes("complete i1"), "an open manual task does not hold the parent open");
  assert.match(done.calls.at(-1) ?? "", /^response:All sub-issues are finished, so TUC-1 is done\./);
  assert.equal((await done.store.get("s1"))?.closed, true);
  await done.cleanup();

  const canceled = harness({ groups: { i1: parent([child("TUC-2", { status: "Canceled", statusType: "canceled", finished: true })]) } });
  await canceled.store.put(link({ agentId: null, group: { delegated: true } }));
  await canceled.router.advanceGroups();
  assert.deepEqual(canceled.calls.slice(0, 1), ["cancel i1: Every sub-issue was canceled, so TUC-1 is canceled too."]);
  await canceled.cleanup();
});

test("a ticket whose sub-issues are all finished, or only the owner's manual tasks, starts an agent of its own", async () => {
  const h = harness({ groups: { i1: parent([child("TUC-2", { status: "Done", statusType: "completed", finished: true }), child("TUC-3", { assigneeId: OWNER, labels: ["paseo-manual"] })]) } });
  await h.router.created({ id: "s1", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" } });
  assert.deepEqual(h.calls.slice(0, 2), ["+paseo-running", 'start {"linear.sessionId":"s1"}']);
  await h.cleanup();
});

test("a mention on a ticket with a running agent is passed to that agent instead of starting another", async () => {
  const h = harness({ activeAgent: { id: "agent-1", title: "TUC-1: Fix" } });
  await h.router.created({ id: "s2", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" }, comment: { body: "@paseo also cover returns" } });
  assert.equal(h.calls[0], "send agent-1: also cover returns");
  assert.equal((await h.store.get("s2"))?.agentId, "agent-1");
  await h.cleanup();
});

test("a mention on a Needs you sub-issue goes to the agent that asked on the parent ticket and closes the sub-issue", async () => {
  const needsYou = new NeedsYouIssues(mkdtempSync(join(tmpdir(), "needs-you-")));
  await needsYou.add({ id: "sub-1", identifier: "TUC-2", parentId: "i1", agentId: "agent-1" });
  const h = harness({ needsYou });
  await h.router.created({ id: "s2", creatorId: OWNER, issueId: "sub-1", issue: { identifier: "TUC-2" }, comment: { body: "@paseo mail is sent" } });
  assert.deepEqual(h.calls.slice(0, 2), ["send agent-1: mail is sent", "complete sub-1"]);
  assert.ok(!h.calls.some((call) => call.startsWith("start ")), "no new agent for the sub-issue");
  assert.deepEqual(await needsYou.all(), []);
  await h.cleanup();
});

test("a label or sidebar launch delegates its ticket to the Paseo app once the session links the agent; a failed delegation keeps the session", async () => {
  const seen: { store?: SessionStore; delegated?: string; linkedAgent?: string | null } = {};
  const h = harness({ delegate: async (id, to) => { seen.delegated = `${id} to ${to}`; seen.linkedAgent = (await seen.store!.get("s-new"))?.agentId; } });
  seen.store = h.store;
  assert.equal(await h.router.openFor("i1", "TUC-1", "agent-1"), "s-new");
  assert.equal(seen.delegated, "i1 to paseo-app");
  assert.equal(seen.linkedAgent, "agent-1", "the delegation's own session event finds the agent, never starts a second one");
  await h.cleanup();

  const failing = harness({ delegate: async () => { throw new Error("HTTP 503"); } });
  assert.equal(await failing.router.openFor("i1", "TUC-1", "agent-1"), "s-new");
  assert.equal((await failing.store.get("s-new"))?.agentId, "agent-1");
  await failing.cleanup();
});

test("a mention to a running agent that waits on a question answers it, like a relayed comment, and is recorded as the owner's answer", async () => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  const h = harness({ activeAgent: { id: "agent-1", title: "TUC-1: Fix" }, pending: [question], checked: true });
  await h.router.created({ id: "s3", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" }, comment: { body: "@paseo csv" } });
  assert.equal(h.calls[0], `checked q ${JSON.stringify({ behavior: "allow", updatedInput: { answers: { Response: "CSV" } } })}`);
  assert.deepEqual(h.answered.map(({ agentId, request, activity }) => `${agentId} ${request.id} ${activity.via} ${activity.activityId} ${activity.userId}`), [`agent-1 q linear-session s3 ${OWNER}`]);
  await h.cleanup();
});

test("session question outcomes show durable rejection or uncertainty and count only confirmed owner answers", async (t) => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  const cases = [
    { error: null, evidence: 1, reply: null },
    { error: "No pending permission request with id 'q'", evidence: 0, reply: /^error:Your answer was not delivered:/ },
    { error: "Timed out waiting for agent_permission_resolved", evidence: 0, reply: /^error:Paseo could not confirm that your answer reached the agent:/ },
    { error: "persistSnapshot failed after application", evidence: 0, reply: /^error:Paseo could not confirm that your answer reached the agent:/ },
  ];
  for (const item of cases) {
    const pending = [question];
    const h = harness({ pending, checked: true, manual: true, answer: async () => { if (item.error) throw new Error(item.error); } });
    t.after(h.cleanup);
    await h.store.put(link());
    const activity = { id: "answer-1", userId: OWNER, body: "csv" };
    await h.router.prompted("s1", activity);
    assert.equal(h.answered.length, item.evidence, item.error ?? "confirmed");
    if (item.reply) assert.ok(h.calls.some((call) => item.reply!.test(call)), JSON.stringify(h.calls));
    else {
      // The owner identity the evidence carries, not the whole activity object's shape.
      const recorded = h.answered[0].activity;
      assert.equal(recorded.via, "linear-session");
      assert.equal(recorded.activityId, "answer-1");
      assert.equal(recorded.userId, OWNER);
    }
    pending.splice(0, 1, { ...question, id: "newer" });
    // An interrupted caller can read the old activity again; the delivery ledger still owns it.
    await h.store.patch("s1", { handled: [] });
    await h.router.prompted("s1", activity);
    assert.equal(h.calls.filter((call) => call.startsWith("checked ")).length, 1, "never resubmitted to the newer question");
    assert.equal(h.answered.length, item.evidence, "no repeated evidence");
    assert.ok(!h.calls.some((call) => call.startsWith("send ")));
  }
});

test("session replies without an author remain allowed but unattributed, and a nonowner still cannot answer", async (t) => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  for (const userId of [undefined, "", "someone-else"]) {
    const h = harness({ pending: [question], checked: true, manual: true });
    t.after(h.cleanup);
    await h.store.put(link());
    await h.router.prompted("s1", { id: "answer-1", userId, body: "CSV" });
    assert.deepEqual(h.answered, []);
    assert.equal(h.calls.filter((call) => call.startsWith("checked ")).length, userId === "someone-else" ? 0 : 1);
    if (userId === "someone-else") assert.ok(h.calls.includes("error:Only the workspace owner can steer Paseo agents."));
  }
});

test("a session question without a checked connection is sent once and is never counted as the owner's answer", async (t) => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  const pending = [question];
  const h = harness({ pending, manual: true });
  t.after(h.cleanup);
  await h.store.put(link());
  const activity = { id: "answer-1", userId: OWNER, body: "CSV" };
  await h.router.prompted("s1", activity);
  pending.splice(0);
  await h.store.patch("s1", { handled: [] });
  await h.router.prompted("s1", activity);
  assert.deepEqual(h.calls.filter((call) => /^(respond |send )/.test(call)), ['respond q {"behavior":"allow","updatedInput":{"answers":{"Response":"CSV"}}}']);
  assert.deepEqual(h.answered, []);
});

test("queued session answers retain verified authors or a stable unverified origin and replay safely after a failed store patch and restart", async (t) => {
  t.mock.method(console, "error", () => {});
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  const agents: ProcessAgent[] = [{ id: "agent-1", status: "idle", labels: { "linear.issueId": "i1" } }];
  for (const pendingFrom of [{ activityId: "owner-activity", userId: OWNER }, null, { activityId: "unverified-activity", userId: "" }]) {
    const pending = [question];
    const h = harness({ pending, agents, checked: true, manual: true });
    t.after(h.cleanup);
    await h.store.put(link({ sessionId: "queued", agentId: null, queued: true, pendingText: "CSV", pendingFrom }));
    const deliveries = t.mock.method(h.replies, "deliver");
    const patch = h.store.patch.bind(h.store);
    t.mock.method(h.store, "patch", async (sessionId: string, change: Partial<SessionLink>) => {
      if (change.agentId) throw new Error("session store unavailable after delivery");
      await patch(sessionId, change);
    });
    await h.router.startQueued();
    assert.equal(h.calls.filter((call) => call.startsWith("checked ")).length, 1);
    assert.equal(h.answered.length, pendingFrom?.userId ? 1 : 0);
    const firstOrigin = deliveries.mock.calls[0].arguments[3];
    assert.equal(firstOrigin.issueId, "i1");
    assert.equal(firstOrigin.responder.kind, pendingFrom?.userId ? "owner" : "linear-unverified");
    if (pendingFrom?.userId) {
      assert.equal(firstOrigin.ref, "session:owner-activity");
      // The recorded evidence carries the verified owner, not the origin object's whole shape.
      const recorded = h.answered[0].activity;
      assert.equal(recorded.via, "linear-session");
      assert.equal(recorded.activityId, "owner-activity");
      assert.equal(recorded.userId, OWNER);
    } else assert.match(firstOrigin.ref, /^queued:queued:[a-f0-9]{64}$/);
    assert.equal((await h.store.get("queued"))?.queued, true);
    pending.splice(0, 1, { ...question, id: "newer" });
    const restarted = harness({ pending, agents, checked: true, manual: true, directory: h.directory });
    const replays = t.mock.method(restarted.replies, "deliver");
    await restarted.router.startQueued();
    assert.equal(replays.mock.calls[0].arguments[3].ref, firstOrigin.ref);
    assert.ok(!restarted.calls.some((call) => /^(checked |respond |send )/.test(call)));
    assert.deepEqual(restarted.answered, []);
    assert.equal((await restarted.store.get("queued"))?.queued, false);
    assert.equal((await restarted.store.get("queued"))?.pendingText, null);
  }
});

test("a queued approval or plain message is never resent or rerouted into a newer multipart question after its session patch failed", async (t) => {
  t.mock.method(console, "error", () => {});
  const approval: AgentPermissionRequest = { id: "tool", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash" };
  const newer: AgentPermissionRequest = { id: "newer", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Deploy?", header: "deploy", options: [] }, { question: "Region?", header: "region", options: [] }] } };
  const agents: ProcessAgent[] = [{ id: "agent-1", status: "idle", labels: { "linear.issueId": "i1" } }];
  const cases: { pending: AgentPermissionRequest[]; text: string; sent: RegExp }[] = [
    { pending: [approval], text: "approve", sent: /^respond tool / },
    { pending: [], text: "Also update the README", sent: /^send agent-1: Also update the README$/ },
  ];
  for (const item of cases) {
    const h = harness({ pending: item.pending, agents, manual: true });
    t.after(h.cleanup);
    await h.store.put(link({ sessionId: "queued", agentId: null, queued: true, pendingText: item.text, pendingFrom: { activityId: "queued-activity", userId: OWNER } }));
    t.mock.method(h.store, "patch", async () => { throw new Error("session store unavailable after send"); });
    await h.router.startQueued();
    assert.equal(h.calls.filter((call) => item.sent.test(call)).length, 1);
    item.pending.splice(0, item.pending.length, newer);
    const restarted = harness({ pending: item.pending, agents, manual: true, directory: h.directory });
    await restarted.router.startQueued();
    assert.ok(!restarted.calls.some((call) => /^(respond |send )/.test(call)), JSON.stringify(restarted.calls));
    assert.equal((await restarted.store.get("queued"))?.questions, undefined);
    assert.equal((await restarted.store.get("queued"))?.queued, false);
  }
});

test("an unconfirmed queued message replay reports the original uncertainty and sends nothing into a later question", async (t) => {
  t.mock.method(console, "error", () => {});
  const attempts: string[] = [];
  const pending: AgentPermissionRequest[] = [];
  const agents: ProcessAgent[] = [{ id: "agent-1", status: "idle", labels: { "linear.issueId": "i1" } }];
  const h = harness({ pending, agents, manual: true, send: async () => { attempts.push("attempt"); throw new Error("connection lost after send"); } });
  t.after(h.cleanup);
  await h.store.put(link({ sessionId: "queued", agentId: null, queued: true, pendingText: "carry on" }));
  await h.router.startQueued();
  assert.deepEqual(attempts, ["attempt"]);
  assert.ok(h.calls.some((call) => call.startsWith("error:Paseo could not confirm")));
  pending.push({ id: "newer", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Deploy?", header: "deploy", options: [] }] } });
  const restarted = harness({ pending, agents, manual: true, directory: h.directory });
  await restarted.router.startQueued();
  assert.ok(!restarted.calls.some((call) => /^(respond |send )/.test(call)));
  assert.ok(restarted.calls.some((call) => call.startsWith("error:Paseo could not confirm")));
  assert.equal((await restarted.store.get("queued"))?.queued, true, "uncertainty remains visible rather than silently declaring delivery");
});

test("needs-you completion follows confirmed session outcomes, including a delivered late correction, not rejected or unconfirmed answers", async (t) => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  for (const error of [null, "No pending permission request with id 'q'", "Timed out waiting for agent_permission_resolved"]) {
    const directory = await mkdtemp(join(tmpdir(), "needs-you-session-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const needsYou = new NeedsYouIssues(directory);
    await needsYou.add({ id: "sub-1", identifier: "TUC-2", parentId: "i1", agentId: "agent-1" });
    const h = harness({ pending: [question], needsYou, checked: true, manual: true, answer: async () => { if (error) throw new Error(error); } });
    t.after(h.cleanup);
    await h.store.put(link({ issueId: "sub-1" }));
    await h.router.prompted("s1", { id: "answer-1", userId: OWNER, body: "CSV" });
    assert.equal((await needsYou.all()).length, error ? 1 : 0);
    assert.equal(h.calls.includes("complete sub-1"), !error);
  }
  const directory = await mkdtemp(join(tmpdir(), "needs-you-correction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const needsYou = new NeedsYouIssues(directory);
  await needsYou.add({ id: "sub-1", identifier: "TUC-2", parentId: "i1", agentId: "agent-1" });
  const pending = [question];
  const h = harness({ pending, needsYou, checked: true, manual: true });
  t.after(h.cleanup);
  await h.store.put(link({ issueId: "sub-1" }));
  assert.equal(await h.replies.respond({ agentId: "agent-1", requestId: "q", fingerprint: fingerprint(question), intentId: "D-needs-you", response: { behavior: "allow", updatedInput: { answers: { Response: "CSV" } } } }), "applied");
  pending.splice(0);
  await h.store.patch("s1", { questions: { requestId: "q", request: question, index: 0, answers: {} } });
  h.replies.recordEffects({
    ownerAnswered: async () => { throw new Error("a correction is not owner evidence"); },
    correctLate: async () => ({ delivered: true, reply: "The deputy had already answered this question (D-needs-you); your answer went to the agent as your correction." }),
    needsYou: async (_agentId, issueId) => {
      assert.equal(issueId, "sub-1");
      await closeAnswered(needsYou, { complete: async (id) => { h.calls.push(`complete ${id}`); } }, issueId!);
    },
  });
  await h.router.prompted("s1", { id: "correction-1", userId: OWNER, body: "XML" });
  assert.deepEqual(await needsYou.all(), []);
  assert.ok(h.calls.includes("complete sub-1"));
  assert.equal(h.calls.filter((call) => call.startsWith("checked ")).length, 1);
});

test("an override that opens a session corrects the deputy's answer and neither answers the pending question nor starts an agent", async () => {
  const question: AgentPermissionRequest = { id: "q2", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Split?", header: "Response", options: [{ label: "Keep" }, { label: "Split" }] }] } };
  const h = harness({ activeAgent: { id: "agent-1", title: "TUC-1: Fix" }, pending: [question] });
  const corrections: string[] = [];
  const applied = { ref: "D-1a2b3c4d" } as Candidate;
  h.router.recordDeputy({
    byRef: async (ref) => ref === applied.ref ? applied : null,
    correct: async (candidate, text, activity) => { corrections.push(`${candidate.ref} ${text} ${activity.activityId} ${activity.userId}`); return { delivered: true, reply: "Passed to the agent as your correction of D-1a2b3c4d." }; },
  });
  await h.router.created({ id: "s4", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" }, comment: { body: "@paseo override D-1a2b3c4d use vitest" } });
  assert.deepEqual(corrections, [`D-1a2b3c4d use vitest s4 ${OWNER}`]);
  assert.deepEqual(h.calls, ["response:Passed to the agent as your correction of D-1a2b3c4d."]);
  await h.router.created({ id: "s5", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" }, comment: { body: "@paseo override D-0000000f keep" } });
  assert.match(h.calls.at(-1) ?? "", /^error:D-0000000f is not an answer the deputy gave/);
  assert.ok(!h.calls.some((call) => call.startsWith("respond ") || call.startsWith("send ") || call.startsWith("start ")));
  await h.cleanup();
});

test("replies route to stop, question, approval, plan review or message, and each is handled once", async () => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Transfer?", header: "Response", options: [{ label: "SFTP" }, { label: "Mail" }] }] } };
  const tool: AgentPermissionRequest = { id: "t", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash" };
  const cases: { pending?: AgentPermissionRequest[]; change?: Partial<SessionLink>; activity: Record<string, unknown>; expect: string }[] = [
    { activity: { id: "a1", signal: "stop", content: { body: "stop" } }, expect: "stop agent-1" },
    { pending: [question], activity: { id: "a2", content: { body: "SFTP" } }, expect: 'respond q {"behavior":"allow","updatedInput":{"answers":{"Response":"SFTP"}}}' },
    { pending: [tool], activity: { id: "a3", content: { body: "deny" } }, expect: 'respond t {"behavior":"deny"}' },
    { change: { review: { localUrl: "http://localhost:5000/" } }, activity: { id: "a4", content: { body: "approve-plan" } }, expect: "review http://localhost:5000/ approve" },
    { change: { review: { localUrl: "http://localhost:5000/" } }, activity: { id: "a5", content: { body: "Split step 2" } }, expect: "review http://localhost:5000/ deny:Split step 2" },
    { activity: { id: "a6", content: { body: "Also update the README" } }, expect: "send agent-1: Also update the README" },
  ];
  for (const item of cases) {
    const h = harness({ pending: item.pending });
    await h.store.put(link(item.change));
    await h.router.prompted("s1", item.activity);
    await h.router.prompted("s1", item.activity);
    assert.equal(h.calls.filter((call) => call === item.expect).length, 1, `${item.expect} once`);
    await h.cleanup();
  }
});

test("a stopped agent's Resume choice starts its successor and closes the old agent", async () => {
  const h = harness();
  await h.store.put(link({ offer: "resume" }));
  await h.router.prompted("s1", { id: "a1", content: { body: "resume" } });
  assert.ok(h.calls.includes('start {"linear.sessionId":"s1"}'));
  assert.ok(h.calls.includes("archive agent-1"));
  assert.equal((await h.store.get("s1"))?.agentId, "agent-new");
  await h.cleanup();
});

test("a plan approved for later offers no Resume when its agent is archived, and any reply starts the implementer", async () => {
  const h = harness();
  await h.store.put(link({ offer: "later" }));
  await h.router.offerResume("s1");
  assert.ok(!h.calls.some((call) => call.includes("[resume|leave]")));
  await h.router.prompted("s1", { id: "a1", content: { body: "go ahead" } });
  assert.ok(h.calls.includes('start {"linear.sessionId":"s1"}'));
  assert.equal((await h.store.get("s1"))?.offer, null);
  await h.cleanup();
});

test("the progress comment is created once and edited in place; the next agent gets its own and a resume prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-handover-"));
  const calls: string[] = [];
  const links: string[] = [];
  try {
    const handover = new Handover({
      upsertComment: async (_issue: string, body: string, id: string | null) => {
        if (id) { calls.push(`update ${id} ${body.split("\n")[0]}`); return id; }
        calls.push(`create ${body.split("\n")[0]}`);
        return `c${calls.length}`;
      },
      comment: async (_issue: string, body: string) => { calls.push(`final ${body.split("\n")[0]}`); },
      upsertAttachment: async (_issue: string, url: string, title: string, subtitle: string) => { links.push(`${url} | ${title} | ${subtitle}`); },
      removeAttachments: async (_issue: string, prefix: string, keep: string) => { links.push(`remove ${prefix}* except ${keep}`); },
    }, directory, async () => ({ branch: "mtuchel/tuc-1-fix", lastCommit: "abc123 wip" }), () => "2026-01-01T10:00:00Z", async (agentId) => `https://app.paseo.sh/h/srv/agent/${agentId}`);
    const issue = { id: "i1", identifier: "TUC-1" };
    const first = { id: "agent-1", title: "TUC-1: Fix", cwd: "/wt/tuc-1" };
    await handover.update(issue, first, { summary: "Did step 1" });
    await handover.update(issue, first, { summary: "Did step 2", model: "omp/opus · thinking medium" });
    const record: HandoverRecord = await handover.finish(issue, first, "failed", "provider login expired");
    assert.deepEqual(calls, ["create 🛠 **Paseo progress** — TUC-1: Fix", "update c1 🛠 **Paseo progress** — TUC-1: Fix", "update c1 🛠 **Paseo progress** — TUC-1: Fix", "final 🏁 **Paseo final report** — TUC-1: Fix"]);
    assert.deepEqual(record.summaries, ["Did step 1", "Did step 2"]);
    const target = await handover.resumeTarget("i1");
    assert.equal(target?.branch, "mtuchel/tuc-1-fix");
    assert.equal(target?.worktreePath, "/wt/tuc-1");
    assert.match(handoverPrompt(record), /continuing work on Linear ticket TUC-1 .*Stopped with an error/s);
    assert.match(target?.handover ?? "", /report 2 ---\nDid step 2/);
    await handover.update(issue, { id: "agent-2", title: "TUC-1: Fix (resumed)", cwd: "/wt/tuc-1" }, { summary: "Continued" });
    assert.equal(calls.at(-1), "create 🛠 **Paseo progress** — TUC-1: Fix (resumed)");
    assert.equal((await handover.read("i1"))?.resumedFrom, "agent-1");
    // The ticket's agent link: one attachment, its subtitle following the phase and model, moved to the next agent.
    assert.deepEqual(links, [
      "https://app.paseo.sh/h/srv/agent/agent-1 | Paseo agent · TUC-1: Fix | Working",
      "remove https://app.paseo.sh/h/* except https://app.paseo.sh/h/srv/agent/agent-1",
      "https://app.paseo.sh/h/srv/agent/agent-1 | Paseo agent · TUC-1: Fix | Working · omp/opus · thinking medium",
      "https://app.paseo.sh/h/srv/agent/agent-1 | Paseo agent · TUC-1: Fix | Stopped with an error · omp/opus · thinking medium",
      "https://app.paseo.sh/h/srv/agent/agent-2 | Paseo agent · TUC-1: Fix (resumed) | Working",
      "remove https://app.paseo.sh/h/* except https://app.paseo.sh/h/srv/agent/agent-2",
    ]);
    assert.match(progressBody((await handover.read("i1"))!), /\*\*Links:\*\* \[Open in Paseo\]\(https:\/\/app\.paseo\.sh\/h\/srv\/agent\/agent-2\)/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the ticket's pull request link stays on the record when another agent takes over; the Paseo link is the new agent's", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-handover-"));
  try {
    const handover = new Handover({
      upsertComment: async () => "c1",
      comment: async () => {},
      upsertAttachment: async () => {},
      removeAttachments: async () => {},
    }, directory, async () => ({ branch: "mtuchel/tuc-1-fix", lastCommit: null }), () => "2026-01-01T10:00:00Z", async (agentId) => `https://app.paseo.sh/h/srv/agent/${agentId}`);
    const issue = { id: "i1", identifier: "TUC-1" };
    const pr = "https://github.com/o/r/pull/7";
    await handover.update(issue, { id: "agent-1", title: "TUC-1: Fix", cwd: "/wt/tuc-1" }, { link: ["Pull request", pr] });
    await handover.finish(issue, { id: "agent-1", title: "TUC-1: Fix", cwd: "/wt/tuc-1" }, "archived", "archived");
    const resumed = await handover.update(issue, { id: "agent-2", title: "TUC-1: Fix (resumed)", cwd: "/wt/tuc-1" }, { summary: "Continued" });
    assert.deepEqual(resumed.links, { "Open in Paseo": "https://app.paseo.sh/h/srv/agent/agent-2", "Pull request": pr });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a permission shows in the agent panel only while still pending, and the ticket then mentions the session's owner as the Paseo app", async () => {
  const { Writeback } = await import("./writeback");
  const request: AgentPermissionRequest = { id: "p1", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash", description: "Command: ls" };
  for (const pending of [[], [request]]) {
    const calls: string[] = [];
    const linear = {
      issueState: async () => ({ id: "i1", identifier: "TUC-1", status: "In Progress", statusId: "ip", statusType: "started", teamId: "t", projectId: null, creatorId: "customer", labels: [], attachmentUrls: [], blockedBy: [], priority: 0, createdAt: "", unblocks: 0 }),
      markInProgress: async () => ({ changed: false }), moveToReview: async () => ({ changed: false }), linkUrl: async () => {}, moveToState: async () => {},
      moveToStateNamed: async (_i: string, name: string) => { calls.push(`move ${name}`); return { changed: true }; },
      comment: async (_i: string, body: string) => { calls.push(`comment ${body.slice(0, 30)}`); },
      upsertComment: async (_i: string, body: string, id: string | null) => { calls.push(`app comment ${id ?? "new"} ${body.split("\n")[0]}`); return "c1"; },
      // In a session the session's owner is asked; the ticket's creator is never looked at.
      isPerson: async (): Promise<boolean> => { throw new Error("the creator is not consulted in a session"); },
      viewerId: async () => OWNER, userUrl: async (id: string) => `https://linear.app/ws/profiles/${id}`,
      addLabel: async (_i: string, name: string) => { calls.push(`+${name}`); }, removeLabel: async () => {},
      createIssue: async (): Promise<{ id: string; identifier: string; url: string }> => { throw new Error("an open ticket gets no sub-issue"); }, complete: async () => {},
    };
    const sessions = {
      sessionFor: async () => ({ sessionId: "s1" }), say: async () => {}, action: async () => {}, link: async () => {}, offerResume: async () => {}, resumeNow: async () => false,
      scheduleLimitResume: async () => false,
      ask: async (_s: string, body: string, options: { value: string }[]) => { calls.push(`ask ${body.split("\n")[0]} [${options.map((o) => o.value).join("|")}]`); },
    };
    const handover = { read: async () => null, update: async () => ({}) as never, finish: async () => ({}) as never, handOff: async () => true, waiting: async () => null, setWaiting: async () => {} };
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" }, pendingPermissions: pending } }) }) } } as unknown as PaseoApi;
    const writeback = new Writeback(linear, { read: async () => ({ ...settings, writeback: { ...DEFAULT_WRITEBACK, blocked: true } }) }, { sessions: sessions as never, handover }, 0, join(tmpdir(), `paseo-writeback-outbox-${process.pid}.json`));
    await writeback.permissionRequested({ agent: { id: "a1", workspaceId: "w", parentAgentId: null, provider: "omp", cwd: "/x", title: "T" }, request }, paseo);
    assert.deepEqual(calls, pending.length ? ["ask Approve this action? [approve|deny]", "move Needs input", "+paseo-needs-you", `app comment new https://linear.app/ws/profiles/${OWNER} **T** (Paseo) is waiting for permission: Allow tool: bash`] : []);
  }
});

test("an automatic prompt reaches only an idle agent; busy, waiting, gone and disconnected are told apart", async () => {
  const cases: [string, Parameters<typeof harness>[0], string][] = [
    ["sent", { snapshot: async () => ({ agent: { status: "closed", pendingPermissions: [] } }) }, "a stopped agent is loaded and prompted"],
    ["busy", { snapshot: async () => ({ agent: { status: "running", activeTurn: { id: "t" }, pendingPermissions: [] } }) }, "a running turn is not interrupted"],
    ["waiting", { snapshot: async () => ({ agent: { status: "idle", pendingPermissions: [{ id: "q", kind: "question" }] } }) }, "a pending question is not dropped"],
    ["waiting", { snapshot: async () => ({ agent: { status: "running", activeTurn: { id: "t" }, pendingPermissions: [{ id: "q", kind: "question" }] } }) }, "a question asked inside a running turn waits for the owner, not for the turn"],
    ["gone", { snapshot: async () => ({ agent: { status: "idle", archivedAt: "2026-09-01T00:00:00Z", pendingPermissions: [] } }) }, "archived"],
    ["gone", { snapshot: async () => { throw new Error("Agent not found: agent-1"); } }, "deleted"],
    ["unavailable", { attach: false }, "Paseo not connected"],
  ];
  for (const [expected, options, why] of cases) {
    const h = harness(options);
    assert.equal(await h.router.prompt("agent-1", "fix it", async () => { h.calls.push("dispatch"); }), expected, why);
    assert.deepEqual(h.calls, expected === "sent" ? ["dispatch", "send agent-1: fix it"] : [], why);
    await h.cleanup();
  }
});

// A crashed agent as Paseo shows it; a reload keeps `lastError`, so a restarted agent still has it.
const CRASHED = { status: "error", lastError: "OMP RPC process is closed", pendingPermissions: [] };
const RESTARTED = { status: "idle", lastError: "OMP RPC process is closed", pendingPermissions: [] };

// The agent's snapshot is `state.agent`; the daemon's reload moves it to `after`, or throws it. The
// reload finishes after every pending read: a recovery waiting for the ticket read the crash first.
function crashed(after: unknown, options: Parameters<typeof harness>[0] = {}) {
  const state: { agent: unknown } = { agent: CRASHED };
  const reload = async () => {
    await setImmediatePromise();
    if (after instanceof Error) throw after;
    state.agent = after;
  };
  const h = harness({ reload, ...options, snapshot: options.snapshot ?? (async () => ({ agent: state.agent })) });
  const recovery = { issueId: "i1", before: async (_resume: string, error: string) => { h.calls.push(`before ${error}`); } };
  return { ...h, state, recovery };
}

test("a crashed agent is reloaded, then sent the resume: the crash, git status, an interrupted rebase, then the original message", async () => {
  const h = crashed(RESTARTED);
  assert.equal(await h.router.prompt("agent-1", "fix it", async () => { h.calls.push("dispatch"); }, h.recovery), "restarted");
  assert.deepEqual(h.calls.slice(0, 2), ["before OMP RPC process is closed", "reload agent-1"]);
  assert.equal(h.calls.length, 3, "no dispatch: before claims the attempt");
  const resume = h.calls[2];
  assert.match(resume, /^send agent-1: Your previous run crashed \(`OMP RPC process is closed`\), and Paseo restarted you\./);
  assert.match(resume, /run `git status`/);
  assert.match(resume, /`git rebase --continue`/);
  assert.match(resume, /`git rebase --abort`/);
  assert.ok(resume.endsWith("\n\nfix it"));
  await h.cleanup();
});

test("a crashed agent whose reload fails, or that is still in error after it, is sent nothing", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const [after, why] of [[CRASHED, "still crashed"], [{ ...RESTARTED, status: "error", lastError: "provider quota" }, "in error for another reason"], [new Error("rpc_error"), "the reload threw"]] as const) {
    const h = crashed(after);
    assert.equal(await h.router.prompt("agent-1", "fix it", undefined, h.recovery), "crashed", why);
    assert.deepEqual(h.calls, ["before OMP RPC process is closed", "reload agent-1"], why);
    await h.cleanup();
  }
});

test("a restarted agent that is busy right after, or whose resume fails to send, keeps the resume for later", async (t) => {
  t.mock.method(console, "error", () => {});
  const cases: [unknown, Parameters<typeof harness>[0], string][] = [
    [{ ...RESTARTED, status: "running" }, {}, "running"],
    [{ ...RESTARTED, pendingPermissions: [{ id: "q" }] }, {}, "a pending question"],
    [RESTARTED, { send: async () => { throw new Error("connection lost"); } }, "the send failed"],
  ];
  for (const [after, options, why] of cases) {
    const h = crashed(after, options);
    assert.equal(await h.router.prompt("agent-1", "fix it", undefined, h.recovery), "reloaded", why);
    assert.deepEqual(h.calls, ["before OMP RPC process is closed", "reload agent-1"], why);
    await h.cleanup();
  }
});

test("a crashed agent is not reloaded while busy, while another live agent has its ticket, without a daemon connection, or without a recovery", async () => {
  const cases: [Parameters<typeof harness>[0], boolean, string, string][] = [
    [{ snapshot: async () => ({ agent: { ...CRASHED, pendingPermissions: [{ id: "q" }] } }) }, true, "waiting", "a pending question"],
    [{ snapshot: (() => { let reads = 0; return async () => ({ agent: reads++ ? { ...CRASHED, pendingPermissions: [{ id: "q" }] } : CRASHED }); })() }, true, "waiting", "a question that came up while the recovery waited for the ticket's turn"],
    [{ snapshot: async () => ({ agent: { ...CRASHED, activeTurn: { id: "t" } } }) }, true, "busy", "in a turn"],
    [{ activeAgent: { id: "agent-2", title: "Successor" } }, true, "busy", "a successor took over"],
    [{ reload: null }, true, "unavailable", "no daemon connection"],
    [{}, false, "crashed", "no recovery asked for"],
  ];
  for (const [options, recover, expected, why] of cases) {
    const h = crashed(RESTARTED, options);
    assert.equal(await h.router.prompt("agent-1", "fix it", async () => { h.calls.push("dispatch"); }, recover ? h.recovery : undefined), expected, why);
    assert.deepEqual(h.calls, [], why);
    await h.cleanup();
  }
});

test("an agent in error whose process still runs is sent the message as usual", async () => {
  const h = harness({ snapshot: async () => ({ agent: { status: "error", lastError: "provider quota exceeded", pendingPermissions: [] } }), reload: async () => {} });
  assert.equal(await h.router.prompt("agent-1", "fix it", async () => { h.calls.push("dispatch"); }, { issueId: "i1", before: async () => { h.calls.push("before"); } }), "sent");
  assert.deepEqual(h.calls, ["dispatch", "send agent-1: fix it"]);
  await h.cleanup();
});

test("two recoveries of one ticket take turns: the second judges the agent again and never reloads it twice", async () => {
  for (const [after, expected, calls] of [
    [{ ...RESTARTED, status: "running" }, "busy", []],
    [RESTARTED, "sent", ["send agent-1: again"]],
  ] as const) {
    const h = crashed(after);
    // The second recovery read the crash before the first one's reload finished.
    const [first, second] = await Promise.all([
      h.router.prompt("agent-1", "fix it", undefined, h.recovery),
      h.router.prompt("agent-1", "again", undefined, h.recovery),
    ]);
    assert.equal(first, after.status === "running" ? "reloaded" : "restarted");
    assert.equal(second, expected);
    assert.deepEqual(h.calls.filter((call) => !call.startsWith("send agent-1: Your previous run")), ["before OMP RPC process is closed", "reload agent-1", ...calls]);
    await h.cleanup();
  }
});

const OMP_HANDLE = "/home/mirko/.omp/agent/sessions/worktree/2026-10-05T11-05-57-212Z_01a10bbd-e6dc-7761-93d1-081ca47d9501.jsonl";
const OMP_CLOSED: ProcessAgent = {
  id: "agent-1", provider: "omp", status: "closed", cwd: "/repo/wt", labels: { "linear.issueId": "i1" },
  runtimeInfo: { provider: "omp", sessionId: "01a10bbd-e6dc-7761-93d1-081ca47d9501" },
  persistence: { provider: "omp", sessionId: "01a10bbd-e6dc-7761-93d1-081ca47d9501", nativeHandle: OMP_HANDLE },
};

function inspectProcess(output: string): ProcessInspector {
  return { processes: async () => output, cwd: async () => "/repo/wt", canonicalPath: async (path) => path };
}

test("an exact live OMP process behind CLOSED or archive is never automatically sent or reloaded", async () => {
  for (const agent of [OMP_CLOSED, { ...OMP_CLOSED, archivedAt: "now" }, { ...OMP_CLOSED, ...CRASHED }]) {
    const h = harness({
      snapshot: async () => ({ agent }), reload: async () => {},
      processInspector: inspectProcess(`2100185 omp --mode rpc-ui --session ${OMP_HANDLE}\n`),
    });
    try {
      const outcome = await h.router.prompt("agent-1", "fix it", async () => { h.calls.push("dispatch"); }, { issueId: "i1", before: async () => { h.calls.push("before"); } });
      assert.equal(outcome, agent.archivedAt ? "gone" : "busy");
      assert.deepEqual(h.calls, [], "no claim, send or reload");
    } finally { await h.cleanup(); }
  }
});

test("a sessionless same-worktree process prevents lazy CLOSED resurrection; absence releases it", async () => {
  let output = "2100185 omp --mode rpc-ui\n";
  const inspect = inspectProcess("");
  inspect.processes = async () => output;
  const h = harness({ snapshot: async () => ({ agent: OMP_CLOSED }), processInspector: inspect });
  try {
    assert.equal(await h.router.prompt("agent-1", "fix it", async () => { h.calls.push("dispatch"); }), "busy");
    assert.deepEqual(h.calls, []);
    output = "";
    assert.equal(await h.router.prompt("agent-1", "fix it", async () => { h.calls.push("dispatch"); }), "sent");
    assert.deepEqual(h.calls, ["dispatch", "send agent-1: fix it"]);
  } finally { await h.cleanup(); }
});

test("failed inspection leaves a crashed OMP recovery unclaimed; confirmed absence allows reload", async () => {
  const inspect = inspectProcess("");
  inspect.processes = async () => { throw new Error("ps failed"); };
  const h = crashed(RESTARTED, { snapshot: async () => ({ agent: { ...OMP_CLOSED, ...CRASHED } }), processInspector: inspect });
  try {
    assert.equal(await h.router.prompt("agent-1", "fix it", undefined, h.recovery), "busy");
    assert.deepEqual(h.calls, []);
  } finally { await h.cleanup(); }

  const absent = crashed(RESTARTED, { processInspector: inspectProcess("") });
  absent.state.agent = { ...OMP_CLOSED, ...CRASHED };
  try {
    assert.equal(await absent.router.prompt("agent-1", "fix it", undefined, absent.recovery), "restarted");
    assert.deepEqual(absent.calls.slice(0, 2), ["before OMP RPC process is closed", "reload agent-1"]);
    assert.match(absent.calls[2], /send agent-1: Your previous run crashed/);
  } finally { await absent.cleanup(); }
});

test("a normal idle OMP target stays usable but an archived live-process sibling blocks dispatch", async () => {
  const agent = { ...OMP_CLOSED, status: "idle" as const };
  const inspect = inspectProcess(`2100185 omp --mode rpc-ui --session ${OMP_HANDLE}\n`);
  const idle = harness({ snapshot: async () => ({ agent }), agents: [agent], processInspector: inspect });
  try {
    assert.equal(await idle.router.prompt("agent-1", "fix it", async () => { idle.calls.push("dispatch"); }), "sent");
    assert.deepEqual(idle.calls, ["dispatch", "send agent-1: fix it"]);
  } finally { await idle.cleanup(); }

  const sibling = harness({ snapshot: async () => ({ agent }), agents: [agent, { ...OMP_CLOSED, id: "archived-root", archivedAt: "now" }], processInspector: inspect });
  try {
    assert.equal(await sibling.router.prompt("agent-1", "fix it", async () => { sibling.calls.push("dispatch"); }), "busy");
    assert.deepEqual(sibling.calls, []);
  } finally { await sibling.cleanup(); }
});

// `answer`: a response for an operation whose answer depends on its variables (batched reads);
// undefined falls through to the fixed answers below.
function routerAdmission(t: TestContext, points = 60_000, limitedOperation?: string, answer?: (operation: string, variables: Record<string, unknown>) => object | undefined) {
  const budget = new RateBudget(() => 0);
  const headers = { "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "4500", "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": String(points), "x-complexity": "100" };
  for (const pool of ["app", "key"] as const) budget.acquire(pool, "owner").done(new Headers(headers), false);
  const sent: { operation: string; variables: Record<string, unknown> }[] = [];
  const data: Record<string, object> = {
    viewerCheck: { viewer: { id: OWNER } },
    issueState: { issue: { id: "i1", identifier: "TUC-1", state: { id: "todo", name: "Todo", type: "unstarted" }, team: { id: "team-1" }, labels: { nodes: [] } } },
    issueStatus: { issue: { state: { name: "Todo", type: "unstarted" } } },
    teamStates: { team: { states: { nodes: [{ id: "coding", name: "In Progress", type: "started", position: 1 }] } } },
    issueUpdateState: { issueUpdate: { success: true, issue: { id: "i1", state: { id: "coding", name: "In Progress", type: "started" } } } },
    comment: { commentCreate: { success: true, comment: { id: "comment-1" } } },
    agentActivity: { agentActivityCreate: { success: true } },
    agentSessionUpdate: { agentSessionUpdate: { success: true } },
    openSessions: { viewer: { id: "paseo-app" }, agentSessions: { nodes: [] } },
    sessionStatus: { agentSession: { status: "active" } },
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body: { query: string; variables: Record<string, unknown> } = JSON.parse(String(init?.body));
    const operation = body.query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? "?";
    sent.push({ operation, variables: body.variables });
    if (operation === limitedOperation) return new Response(JSON.stringify({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] }), { status: 400, headers });
    const dynamic = answer?.(operation, body.variables);
    if (dynamic) return new Response(JSON.stringify(dynamic), { headers });
    assert.ok(data[operation], `unexpected Linear operation ${operation}`);
    return new Response(JSON.stringify({ data: data[operation] }), { headers });
  });
  const post = (key: string, query: string, variables: Record<string, unknown>) => postGraphQL(key, query, variables, budget);
  const api = new AgentApi({ accessToken: async () => "app-token" }, post);
  const linear = new LinearService(new Credentials("/unused", "owner-key"), post, api);
  return { budget, headers, api, linear, sent, now: () => 0 };
}

test("Linear-panel approve, split and approve-later protect their owner check, cold-cache prerequisites and acknowledgements at 3% points", async (t) => {
  for (const command of ["approve-plan", "split-plan", "approve-later", "send-back"]) {
    const admission = routerAdmission(t);
    const decisions: string[] = [];
    const decide = async () => {
      decisions.push(command);
      await admission.linear.issueState("i1");
      await admission.linear.moveToStateNamed("i1", "In Progress");
      await admission.linear.comment("i1", `Owner decision: ${command}`);
      return `Handled ${command}`;
    };
    const h = harness({ ...admission, groups: {}, decideReview: async () => { await decide(); }, decidePlan: decide });
    try {
      await h.store.put(link({ review: { localUrl: "http://localhost:5000/" } }));
      await withPriority("background", "panel ingress test", () => h.router.prompted("s1", { id: `activity-${command}`, userId: OWNER, content: { body: command } }));
      assert.deepEqual(decisions, [command]);
      assert.equal(admission.sent[0].operation, "viewerCheck", `${command}: a cold owner-identity read is admitted`);
      assert.ok(admission.sent.some((call) => call.operation === "issueState"), command);
      assert.ok(admission.sent.some((call) => call.operation === "teamStates"), command);
      assert.ok(admission.sent.some((call) => call.operation === "issueUpdateState"), command);
      assert.ok(admission.sent.some((call) => call.operation === "comment"), command);
      assert.equal(admission.sent.at(-1)?.operation, "agentActivity", `${command}: the acknowledgement also gets owner priority`);
      // Approve-later and split leave the session to the journaled workflow (plannotator.ts).
      if (command === "approve-plan" || command === "send-back") assert.equal((await h.store.get("s1"))?.review, null);
    } finally { await h.cleanup(); }
  }
});

test("owner admission never changes the Linear-panel identity check", async (t) => {
  const admission = routerAdmission(t);
  const decisions: string[] = [];
  const h = harness({ ...admission, groups: {}, decideReview: async () => { decisions.push("approved"); } });
  try {
    await h.store.put(link({ review: { localUrl: "http://localhost:5000/" } }));
    await h.router.prompted("s1", { id: "not-owner", userId: "colleague", content: { body: "approve-plan" } });
    assert.deepEqual(decisions, []);
    assert.deepEqual(admission.sent.map((call) => call.operation), ["viewerCheck", "agentActivity"]);
    const input = admission.sent[1].variables.input;
    assert.ok(input && typeof input === "object" && "content" in input && input.content && typeof input.content === "object" && "body" in input.content);
    assert.equal(input.content.body, "Only the workspace owner can steer Paseo agents.");
    assert.ok((await h.store.get("s1"))?.review);
  } finally { await h.cleanup(); }
});

test("two whole session sweeps send nothing and log one pause while the app has 3% points", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const admission = routerAdmission(t);
  const h = harness({ ...admission, groups: {} });
  try {
    await h.store.put(link({ agentId: null, queued: true, queueReason: "a slot is full" }));
    await h.store.put(link({ sessionId: "s2", agentId: null, issueId: "i2", queued: true }));
    await h.router.sweep();
    await h.router.sweep();
    assert.deepEqual(admission.sent, []);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /agent session sweep paused: .*Paseo Linear app/);
    assert.equal((await h.store.get("s1"))?.queued, true);
  } finally { await h.cleanup(); }
});

test("a queued-thread rate limit stops its loop and logs once across the remaining parts and the next sweep", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const admission = routerAdmission(t, 420_000, "sessionStatuses");
  const h = harness({ ...admission, groups: {} });
  try {
    await h.store.put(link({ agentId: null, queued: true, queueReason: "a slot is full" }));
    await h.store.put(link({ sessionId: "s2", agentId: null, issueId: "i2", queued: true }));
    await h.router.sweep();
    await h.router.sweep();
    assert.deepEqual(admission.sent.map((call) => call.operation), ["sessionStatuses"], "no other queued thread or sweep part sends after the app refuses");
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /agent session sweep \(queued threads\) paused:/);
    assert.equal((await h.store.get("s1"))?.queueReason, "a slot is full");
    assert.equal((await h.store.get("s2"))?.queued, true);
  } finally { await h.cleanup(); }
});

// server087, 2026-10-07: 62 waiting threads, 55 of them held by a live OMP worker, cost one session
// read each a minute, about 1,900 of the app's 5,000 requests an hour (README, "Rate limits").
test("a queue pass reads 120 waiting threads' Linear states in four requests, not one per thread", async (t) => {
  const admission = routerAdmission(t, 1_000_000, undefined, (operation, variables) => {
    if (operation === "sessionStatuses") return { data: Object.fromEntries(Object.keys(variables).map((alias) => [alias, { status: "active" }])) };
    if (operation === "issueStatuses") return { data: { issues: { nodes: (variables.ids as string[]).map((id) => ({ id, state: { name: "Todo", type: "unstarted" }, completedAt: null })) } } };
    return undefined;
  });
  const h = harness({
    ...admission,
    manual: true,
    processLiveness: async (_paseo, issueId) => Number(issueId.slice(1)) < 100 ? "alive" : "absent",
    admission: async () => ({ ok: false, reason: "Waiting for TUC-9 to finish." }),
  });
  try {
    for (let n = 0; n < 120; n += 1) await h.store.put(link({ sessionId: `s${n}`, issueId: `i${n}`, identifier: `TUC-${n}`, agentId: null, queued: true }));
    await h.router.startQueued();
    assert.deepEqual(admission.sent.map((call) => call.operation), ["sessionStatuses", "sessionStatuses", "sessionStatuses", "issueStatuses"]);
    assert.deepEqual(admission.sent.slice(0, 3).map((call) => Object.keys(call.variables).length), [50, 50, 20]);
    assert.deepEqual(admission.sent[3].variables.ids, Array.from({ length: 20 }, (_, n) => `i${100 + n}`), "the tickets from the first thread that needs a state on");
    assert.equal((await h.store.get("s0"))?.queueReason, "an OMP worker for this ticket is still alive");
    assert.equal((await h.store.get("s119"))?.queueReason, "Waiting for TUC-9 to finish.");
    assert.equal((await h.store.get("s119"))?.queued, true);
  } finally { await h.cleanup(); }
});

test("a waiting thread Linear has no session for leaves the batch and is read alone; the batch still ends a completed thread", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const notFound = (path: string) => ({ data: null, errors: [{ message: "Entity not found: AgentSession", path: [path], extensions: { code: "INPUT_ERROR" } }] });
  const admission = routerAdmission(t, 1_000_000, undefined, (operation, variables) => {
    if (operation === "sessionStatus" && variables.id === "s1") return notFound("agentSession");
    if (operation !== "sessionStatuses") return undefined;
    const gone = Object.entries(variables).find(([, id]) => id === "s1");
    if (gone) return notFound(gone[0]);
    return { data: Object.fromEntries(Object.entries(variables).map(([alias, id]) => [alias, { status: id === "s2" ? "complete" : "active" }])) };
  });
  const h = harness({ ...admission, manual: true, processLiveness: async () => "alive" });
  try {
    for (const n of [0, 1, 2]) await h.store.put(link({ sessionId: `s${n}`, issueId: `i${n}`, identifier: `TUC-${n}`, agentId: null, queued: true }));
    await h.router.startQueued();
    assert.deepEqual(admission.sent.map((call) => call.operation), ["sessionStatuses", "sessionStatuses", "sessionStatus"]);
    assert.deepEqual(Object.values(admission.sent[1].variables), ["s0", "s2"]);
    assert.equal((await h.store.get("s0"))?.queueReason, "an OMP worker for this ticket is still alive");
    assert.equal((await h.store.get("s1"))?.queued, true, "a failed read leaves the thread queued, as before batching");
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /TUC-1: checking the queued thread failed: .*Entity not found/);
    assert.deepEqual([(await h.store.get("s2"))?.queued, (await h.store.get("s2"))?.closed], [false, true]);
  } finally { await h.cleanup(); }
});

test("a rate-limited webhook queued before attachment is settled without an unhandled rejection", async (t) => {
  const admission = routerAdmission(t, 1_000_000, "viewerCheck");
  const errors = t.mock.method(console, "error", () => {});
  const h = harness({ ...admission, attach: false });
  try {
    h.router.receive({ type: "AgentSessionEvent", action: "created", agentSession: { id: "s1", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" } } });
    h.router.attach(h.paseo as unknown as PaseoApi);
    await h.router.settled();
    assert.equal(await h.store.get("s1"), null);
    assert.ok(admission.sent.some((call) => call.operation === "viewerCheck"));
    assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes("try again")));
  } finally { h.router.stop(); await h.cleanup(); }
});

test("an optional session-link failure never loses the owner's initiating message or delegation", async (t) => {
  const h = harness({ activeAgent: { id: "agent-1", title: "TUC-1: Fix" } });
  t.mock.method(h.router, "linkToPaseo", async () => { throw new RateLimitedError("app", Date.now() + 60_000); });
  try {
    const event = { id: "s3", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" }, comment: { body: "@paseo Continue with the approved plan." } };
    await h.router.created(event);
    await h.router.created(event);
    assert.equal(h.calls.filter((call) => call === "send agent-1: Continue with the approved plan.").length, 1);
    assert.equal((await h.store.get("s3"))?.agentId, "agent-1");
    assert.equal((await h.store.get("s3"))?.paseoLinked, undefined);
    assert.equal(await h.router.openFor("i2", "TUC-2", "agent-2"), "s-new");
    assert.ok(h.calls.includes("delegate i2 to paseo-app"));
    assert.equal((await h.store.get("s-new"))?.paseoLinked, undefined);
  } finally { await h.cleanup(); }
});
