import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { AgentApi, AppAuth } from "./agent-app";
import { verifyWebhook } from "./agent-webhook";
import { Handover, handoverPrompt, progressBody, type HandoverRecord } from "./handover";
import { AuthenticationError, LinearApiError, type GroupChild, type IssueGroup, type IssueState } from "./linear";
import { NeedsYouIssues } from "./needs-you";
import { planSteps, SessionRouter, SessionStore, type SessionLink } from "./sessions";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";

const OWNER = "owner-1";
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
  dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [],
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
// `reload`: the daemon's agent reload (null: the plugin has no daemon connection); `send`: runs
// before each send is recorded.
function harness(options: { pending?: AgentPermissionRequest[]; activeAgent?: { id: string; title: string } | null; snapshot?: () => Promise<unknown>; attach?: boolean; needsYou?: NeedsYouIssues; delegate?: (issueId: string, to: string) => Promise<void>; groups?: Record<string, IssueGroup>; blockedBy?: Record<string, string[]>; reload?: ((agentId: string) => Promise<void>) | null; send?: () => Promise<void> } = {}) {
  const calls: Call[] = [];
  const api = {
    activity: async (sessionId: string, content: { type: string; body?: string }, extra: { options?: { value: string }[] } = {}) => { calls.push(`${content.type}:${content.body ?? ""}${extra.options ? ` [${extra.options.map((o) => o.value).join("|")}]` : ""}`); },
    updateSession: async () => {},
    createSessionOnIssue: async () => "s-new",
    viewer: async () => ({ id: "paseo-app", name: "Paseo" }),
    openSessions: async () => [],
    activities: async () => [],
  };
  const paseo = {
    agents: {
      list: async () => ({ entries: options.activeAgent ? [{ agent: { ...options.activeAgent, labels: {} } }] : [] }),
      ref: (id: string) => ({
        refresh: options.snapshot ?? (async () => ({ agent: { pendingPermissions: options.pending ?? [] } })),
        send: async (text: string) => { await options.send?.(); calls.push(`send ${id}: ${text}`); },
        respondToPermission: async ({ requestId, response }: { requestId: string; response: unknown }) => { calls.push(`respond ${requestId} ${JSON.stringify(response)}`); },
        archive: async () => { calls.push(`archive ${id}`); return { archivedAt: "now" }; },
      }),
    },
  } as unknown as PaseoApi;
  const directory = join(tmpdir(), `paseo-sessions-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = new SessionStore(join(directory, "sessions.json"));
  const router = new SessionRouter({
    api: api as never,
    linear: {
      viewerId: async () => OWNER, appUserId: async () => "paseo-app",
      addLabel: async (_id: string, name: string) => { calls.push(`+${name}`); }, removeLabel: async (_id: string, name: string) => { calls.push(`-${name}`); },
      complete: async (id: string) => { calls.push(`complete ${id}`); }, cancel: async (id: string, reason: string) => { calls.push(`cancel ${id}: ${reason.split("\n")[0]}`); },
      issueState: async (id: string) => ({ id, status: "Todo", statusType: "unstarted", blockedBy: options.blockedBy?.[id] ?? [] }) as IssueState,
      issueGroup: async (id: string) => options.groups?.[id] ?? { id, identifier: "TUC-1", status: "Todo", statusType: "unstarted", delegateId: "paseo-app", finished: false, children: [] },
      moveToStateNamed: async (id: string, name: string) => { calls.push(`move ${id} to ${name}`); return { changed: true }; },
      delegate: options.delegate ?? (async (id: string, to: string) => { calls.push(`delegate ${id} to ${to}`); }),
    },
    starter: { start: async (_issue: string, _paseo: PaseoApi, _settings: PluginSettings, launch: { labels?: Record<string, string> }) => { calls.push(`start ${JSON.stringify(launch.labels)}`); return { agentId: "agent-new", warnings: [], provider: "omp/x", target: "repo", resumed: false, untrusted: false, plan: null }; }, admission: async () => ({ ok: true as const }) },
    settings: { read: async () => settings },
    store,
    needsYou: options.needsYou,
    stop: async (agentId) => { calls.push(`stop ${agentId}`); },
    decideReview: async (url, approve, feedback) => { calls.push(`review ${url} ${approve ? "approve" : `deny:${feedback}`}`); },
    ...("reload" in options ? { reloader: async () => options.reload ? async (agentId: string) => { calls.push(`reload ${agentId}`); await options.reload!(agentId); } : null } : {}),
  });
  // Group tests drive the sweep themselves: the startup sweep would advance the group alongside them.
  if (options.groups) Object.assign(router, { paseo });
  else if (options.attach ?? true) router.attach(paseo);
  router.stop();
  return { router, store, calls, cleanup: () => rm(directory, { recursive: true, force: true }) };
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

test("a project planner is started again with a new agent and thread: its errored thread is closed and its stopped agent archived", async () => {
  const h = harness();
  // TUC-678: the thread whose launch timed out (in error in Linear, no agent), and an older thread
  // whose agent was closed without a plan.
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

test("a mention to a running agent that waits on a question answers it, like a relayed comment", async () => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  const h = harness({ activeAgent: { id: "agent-1", title: "TUC-1: Fix" }, pending: [question] });
  await h.router.created({ id: "s3", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" }, comment: { body: "@paseo csv" } });
  assert.equal(h.calls[0], `respond q ${JSON.stringify({ behavior: "allow", updatedInput: { answers: { Response: "CSV" } } })}`);
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

test("a plan approved for later offers no Resume when the planner is archived, and any reply starts the implementer", async () => {
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
      ask: async (_s: string, body: string, options: { value: string }[]) => { calls.push(`ask ${body.split("\n")[0]} [${options.map((o) => o.value).join("|")}]`); },
    };
    const handover = { read: async () => null, update: async () => ({}) as never, finish: async () => ({}) as never, waiting: async () => null, setWaiting: async () => {} };
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" }, pendingPermissions: pending } }) }) } } as unknown as PaseoApi;
    const writeback = new Writeback(linear, { read: async () => ({ ...settings, writeback: { ...DEFAULT_WRITEBACK, blocked: true } }) }, { sessions: sessions as never, handover }, 0, join(tmpdir(), `paseo-writeback-outbox-${process.pid}.json`));
    await writeback.permissionRequested({ agent: { id: "a1", workspaceId: "w", parentAgentId: null, provider: "omp", cwd: "/x", title: "T" }, request }, paseo);
    assert.deepEqual(calls, pending.length ? ["ask Approve this action? [approve|deny]", "move Needs input", "+paseo-needs-you", `app comment new https://linear.app/ws/profiles/${OWNER} **T** (Paseo) is waiting for permission: Allow tool: bash`] : []);
  }
});

test("an automatic prompt reaches only an idle agent; busy, gone and disconnected are told apart", async () => {
  const cases: [string, Parameters<typeof harness>[0], string][] = [
    ["sent", { snapshot: async () => ({ agent: { status: "closed", pendingPermissions: [] } }) }, "a stopped agent is loaded and prompted"],
    ["busy", { snapshot: async () => ({ agent: { status: "running", activeTurn: { id: "t" }, pendingPermissions: [] } }) }, "a running turn is not interrupted"],
    ["busy", { snapshot: async () => ({ agent: { status: "idle", pendingPermissions: [{ id: "q", kind: "question" }] } }) }, "a pending question is not dropped"],
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
    [{ snapshot: async () => ({ agent: { ...CRASHED, pendingPermissions: [{ id: "q" }] } }) }, true, "busy", "a pending question"],
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
