import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { fingerprint } from "./deputy";
import { HealthMonitor } from "./health";
import { reviewChange, type PullRequestView } from "./pr-watch";
import { PermissionReplies } from "./permission-replies";
import { PlannotatorBridge } from "./plannotator";
import { planHash, type PendingReview, type ReviewOutcome } from "./review-outcome";
import { APPROVE_LATER, decidePlannotatorReview, describeTool, questionPrompt, ReviewClosedError, SEND_BACK, SessionRouter, SessionStore, SPLIT_PLAN, type SessionLink } from "./sessions";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { AWAY_REASON } from "./scheduler";
import { isUntrusted, MISSED_REACH_NOTE, MODEL_NOTE, OVERLAP_NOTE, QUESTIONS_NOTE, TicketStarter, tierMissingNote, UNTRUSTED_NOTE } from "./starter";
import { advisorNote, PLAN_REQUIRED_NOTE, PLAN_SECTIONS_NOTE, planPolicy } from "./plan-policy";
import { ReviewDeletions } from "./review-deletions";
import { WatchdogStore } from "./watchdog";

const OWNER = "owner-1";
const APP = "paseo-app";
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp", launchPreferences: { omp: { model: "omp/opus", modeId: "full" } },
  projectMappings: { "team:t1": { projectId: "p1", label: "Team", baseBranch: "refs/heads/main" } }, agentLinearAccess: false,
  dispatch: { ...DEFAULT_DISPATCH, maxRunning: 2 }, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, deputy: DEFAULT_DEPUTY,
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

function routerHarness(pending: AgentPermissionRequest[], extra: Partial<ConstructorParameters<typeof SessionRouter>[0]> = {}, listed: { id: string; title: string }[] = [], checked: boolean | (() => Promise<void>) = false) {
  const calls: string[] = [];
  const feeds: ((event: unknown) => void)[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: listed.map((agent) => ({ agent: { ...agent, status: "idle", createdAt: "2026-01-02T00:00:00Z", labels: { "linear.issueId": "i1" } } })), pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: { pendingPermissions: pending } }),
        send: async (text: string) => { calls.push(`send ${id}: ${text}`); },
        respondToPermission: async ({ response }: { response: unknown }) => { calls.push(`respond ${JSON.stringify(response)}`); },
        timeline: { subscribe: (handler: (event: unknown) => void) => { feeds.push(handler); return () => {}; } },
      }),
    },
  } as unknown as PaseoApi;
  const directory = extra.store ? dirname(extra.store.path) : join(tmpdir(), `paseo-flow-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = extra.store ?? new SessionStore(join(directory, "sessions.json"));
  const replies = extra.replies ?? new PermissionReplies({
    directory,
    daemon: async () => checked ? {
      respondToPermissionAndWait: async (_agentId: string, requestId: string, response: AgentPermissionResponse) => {
        calls.push(`checked ${requestId} ${JSON.stringify(response)}`);
        if (typeof checked === "function") await checked();
      },
    } : null,
  });
  const router = new SessionRouter({
    api: { activity: async (_s: string, content: { type: string; body?: string }) => { calls.push(`${content.type}:${(content.body ?? "").split("\n")[0]}`); }, openSessions: async () => [], activities: async () => [] } as never,
    linear: { viewerId: async () => OWNER, appUserId: async () => APP, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, cancel: async () => {}, issueState: async () => { throw new Error("unused"); }, issueStatus: async () => { throw new Error("unused"); }, issueStatuses: async () => { throw new Error("unused"); }, issueGroup: async () => { throw new Error("unused"); }, moveToStateNamed: async () => ({ changed: false }), delegate: async () => {}, comment: async () => {}, hasComment: async () => false, userUrl: async () => "https://linear.app/owner" },
    starter: { start: async () => { throw new Error("unused"); }, admission: async () => ({ ok: true as const }) },
    handover: { resumeTarget: async () => null, handOff: async () => true },
    launcher: { gate: () => ({ release: () => {} }) },
    settings: { read: async () => settings },
    store,
    replies,
    stop: async (agentId) => { calls.push(`stop ${agentId}`); },
    ...extra,
  });
  // Connected without attach(): its startup sweep would run alongside the test and, once the
  // daemon's server id is cached, post "Open in Paseo" links mid-test. Tests call sweep() themselves.
  Object.assign(router, { paseo });
  replies.attach(paseo);
  return { router, store, replies, calls, feeds, paseo, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const link = { sessionId: "s1", agentId: "a1", issueId: "i1", identifier: "TUC-1", createdAt: "2026-01-01T00:00:00Z", handled: [], review: null, offer: null };

test("a ticket's newest thread accounts for a missing agent only while it waits, once its agent came up, or once it was refused", async () => {
  const h = routerHarness([]);
  assert.equal(await h.router.threadHolds("i1"), false, "no thread: the webhook never arrived");
  // TUC-534: the launch failed; an older thread whose agent ran does not count.
  await h.store.put({ ...link, offer: "later" });
  await h.store.put({ ...link, sessionId: "s2", agentId: null, createdAt: "2026-01-02T00:00:00Z" });
  assert.equal(await h.router.threadHolds("i1"), false);
  await h.store.patch("s2", { queued: true });
  assert.equal(await h.router.threadHolds("i1"), true, "it waits for blockers or a slot");
  // A plan approved for later: back in Todo on purpose, its planner retired.
  await h.store.put({ ...link, sessionId: "s3", offer: "later", createdAt: "2026-01-03T00:00:00Z" });
  assert.equal(await h.router.threadHolds("i1"), true);
  // Handed to Paseo by someone else: refused, and not taken for a failed start either.
  await h.store.put({ ...link, sessionId: "s4", agentId: null, createdAt: "2026-01-04T00:00:00Z" });
  assert.equal(await h.router.threadHolds("i1"), false);
  await h.router.created({ id: "s5", issueId: "i1", issue: { identifier: "TUC-1" }, creatorId: "teammate" });
  assert.equal(await h.router.threadHolds("i1"), true);
  await h.cleanup();
});

test("a start under way accounts for the ticket until it ends", async () => {
  const gate: { fail?: (error: Error) => void } = {};
  const h = routerHarness([], {
    // Executor form: the plugin's lib is ES2023, without Promise.withResolvers.
    starter: { admission: async () => ({ ok: true as const }), start: () => new Promise((_resolve, reject) => { gate.fail = reject; }) },
  });
  const restart = h.router.restartFor("i9", "TUC-9");
  while (!gate.fail) await setImmediate();
  assert.equal(await h.router.threadHolds("i9"), true, "the agent takes a minute or two to show up");
  gate.fail(new Error("Timed out waiting for OMP to become ready"));
  const result = await restart;
  assert.equal(result.kind === "failed" && result.error.message, "Timed out waiting for OMP to become ready");
  await setImmediate();
  assert.equal(await h.router.threadHolds("i9"), false);
  await h.cleanup();
});

test("a multi-part question collects every answer before answering the agent once", async () => {
  const h = routerHarness([twoPart]);
  await h.store.put(link);
  await h.router.prompted("s1", { id: "p1", content: { body: "sftp" } });
  assert.deepEqual(h.calls, ["elicitation:Format? (2/2)"]);
  await h.router.prompted("s1", { id: "p2", content: { body: "CSV" } });
  assert.equal(h.calls.at(-1), 'respond {"behavior":"allow","updatedInput":{"answers":{"transfer":"SFTP","format":"CSV","Comment":""}}}');
  await h.cleanup();
});

test("an old approval or message replay cannot become the first part of a newer multipart answer", async (t) => {
  for (const kind of ["approval", "message"] as const) {
    const pending: AgentPermissionRequest[] = kind === "approval" ? [{ id: "tool", provider: "omp", name: "bash", kind: "tool" }] : [];
    const h = routerHarness(pending, {}, [], true);
    t.after(h.cleanup);
    await h.store.put(link);
    await h.router.prompted("s1", { id: "old", userId: OWNER, body: kind === "approval" ? "approve" : "old text" });
    pending.splice(0, pending.length, twoPart);
    // More than the store's bounded handled window: only the durable activity ledger remains.
    await h.store.patch("s1", { handled: [] });
    await h.router.prompted("s1", { id: "old", userId: OWNER, body: "old text" });
    assert.equal((await h.store.get("s1"))?.questions, undefined);
    await h.router.prompted("s1", { id: "fresh1", userId: OWNER, body: "SFTP" });
    await h.router.prompted("s1", { id: "fresh2", userId: OWNER, body: "CSV" });
    assert.deepEqual(h.calls.filter(call => call.startsWith("checked q ")), ['checked q {"behavior":"allow","updatedInput":{"answers":{"transfer":"SFTP","format":"CSV","Comment":""}}}']);
  }
});

test("an already-claimed session replay completes confirmed evidence without answering the next question", async (t) => {
  t.mock.method(console, "error", () => {});
  const single: AgentPermissionRequest = { id: "old", provider: "omp", name: "ask", kind: "question", input: { questions: [{ header: "Runner", question: "Runner?", options: [{ label: "Node" }] }] } };
  const pending = [single];
  const h = routerHarness(pending, {}, [], true);
  t.after(h.cleanup);
  let offline = true;
  const evidence: AgentPermissionRequest[] = [];
  h.replies.recordEffects({
    ownerAnswered: async (_agent, request) => { if (offline) throw new Error("offline"); evidence.push(request); },
    correctLate: async () => ({ delivered: false, reply: "unused" }),
    needsYou: async () => {},
  });
  await h.store.put(link);
  await h.router.prompted("s1", { id: "claimed", userId: OWNER, body: "Node" });
  pending.splice(0, pending.length, twoPart);
  offline = false;
  await h.router.prompted("s1", { id: "claimed", userId: OWNER, body: "Node" });
  assert.deepEqual(evidence, [single]);
  assert.equal((await h.store.get("s1"))?.questions, null);
  assert.equal(h.calls.filter(call => call.startsWith("checked ")).length, 1);
});

test("the first multipart part holds the old question before its store write, and final delivery takes over before release", async (t) => {
  const h = routerHarness([twoPart], {}, [], true);
  t.after(h.cleanup);
  await h.store.put(link);
  const patch = h.store.patch.bind(h.store);
  let releaseWrite: (() => void) | undefined;
  let writeStarted: (() => void) | undefined;
  const writing = new Promise<void>((resolve) => { writeStarted = resolve; });
  const heldWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  t.mock.method(h.store, "patch", async (sessionId: string, change: Partial<SessionLink>) => {
    if (change.questions) {
      writeStarted!();
      await heldWrite;
    }
    await patch(sessionId, change);
  });
  const first = h.router.prompted("s1", { id: "p1", userId: OWNER, body: "sftp" });
  await writing;
  assert.equal(await h.replies.respond({ agentId: "a1", requestId: twoPart.id, fingerprint: fingerprint(twoPart), intentId: "D-first-part", response: { behavior: "allow", updatedInput: { answers: { transfer: "Mail", format: "XML", Comment: "" } } } }), "owner-first");
  assert.ok(!h.calls.some((call) => call.startsWith("checked ")));
  releaseWrite!();
  await first;
  const order: string[] = [];
  const deliver = h.replies.deliver.bind(h.replies);
  const releaseOwner = h.replies.releaseOwner.bind(h.replies);
  t.mock.method(h.replies, "deliver", (...args: Parameters<PermissionReplies["deliver"]>) => { order.push("deliver"); return deliver(...args); });
  t.mock.method(h.replies, "releaseOwner", (...args: Parameters<PermissionReplies["releaseOwner"]>) => { order.push("release"); releaseOwner(...args); });
  await h.router.prompted("s1", { id: "p2", userId: OWNER, body: "CSV" });
  assert.deepEqual(order, ["deliver", "release"]);
  assert.deepEqual(h.calls.filter((call) => call.startsWith("checked ")), ['checked q {"behavior":"allow","updatedInput":{"answers":{"transfer":"SFTP","format":"CSV","Comment":""}}}']);
  assert.equal((await h.store.get("s1"))?.questions, null);
});

test("seedHolds restores only nonclosed multipart vetoes from disk before deputy recovery", async (t) => {
  const h = routerHarness([twoPart], {}, [], true);
  t.after(h.cleanup);
  const questions = { requestId: twoPart.id, request: twoPart, index: 1, answers: { transfer: "SFTP" } };
  await h.store.put({ ...link, questions });
  await h.store.put({ ...link, sessionId: "closed", agentId: "closed-agent", closed: true, questions });
  const restarted = routerHarness([twoPart], { store: new SessionStore(h.store.path) }, [], true);
  t.after(restarted.cleanup);
  await restarted.router.seedHolds();
  const response: AgentPermissionResponse = { behavior: "allow", updatedInput: { answers: { transfer: "Mail", format: "XML", Comment: "" } } };
  assert.equal(await restarted.replies.respond({ agentId: "a1", requestId: twoPart.id, fingerprint: fingerprint(twoPart), intentId: "D-restored", response }), "owner-first");
  assert.equal(await restarted.replies.respond({ agentId: "closed-agent", requestId: twoPart.id, fingerprint: fingerprint(twoPart), intentId: "D-closed", response }), "applied");
  assert.equal(restarted.calls.filter((call) => call.startsWith("checked ")).length, 1);
});

test("a new question cannot discard multipart progress or receive its old answer, and the old hold is released", async (t) => {
  const newer: AgentPermissionRequest = { ...twoPart, id: "newer", input: { questions: [{ question: "Deploy?", header: "deploy", options: [{ label: "Yes" }, { label: "No" }] }] } };
  const pending = [twoPart];
  const routes: string[] = [];
  const h = routerHarness(pending, { route: { take: async (request) => {
    routes.push(request.text ?? "");
    return routes.length === 1 ? null : { peer: "peer-host" };
  } } }, [], true);
  t.after(h.cleanup);
  await h.store.put(link);
  await h.router.prompted("s1", { id: "p1", userId: OWNER, body: "sftp" });
  pending.splice(0, 1, newer);
  await h.router.askQuestion("s1", newer);
  assert.equal((await h.store.get("s1"))?.questions?.requestId, "q");
  assert.deepEqual(h.calls, ["elicitation:Format? (2/2)"]);
  await h.router.prompted("s1", { id: "p2", userId: OWNER, body: "CSV" });
  assert.deepEqual(routes, ["sftp"], "the old final part is not forwarded into a peer's newer question");
  assert.ok(h.calls.some((call) => call.startsWith("error:Your answer was not delivered:")));
  assert.equal(h.calls.at(-1), "elicitation:Deploy?");
  assert.ok(!h.calls.some((call) => /^(checked |respond |send )/.test(call)));
  assert.equal((await h.store.get("s1"))?.questions, null);
  pending.splice(0, 1, twoPart);
  assert.equal(await h.replies.respond({ agentId: "a1", requestId: "q", fingerprint: fingerprint(twoPart), intentId: "D-released", response: { behavior: "allow", updatedInput: { answers: { transfer: "Mail", format: "XML", Comment: "" } } } }), "applied");
});

test("legacy multipart progress without a saved request never answers a newer question even without a checked connection", async (t) => {
  const newer: AgentPermissionRequest = { ...twoPart, id: "newer", input: { questions: [{ question: "Deploy?", header: "deploy", options: [] }] } };
  for (const checked of [false, true]) {
    const h = routerHarness([newer], {}, [], checked);
    t.after(h.cleanup);
    await h.store.put({ ...link, questions: { requestId: "old", index: 1, answers: { transfer: "SFTP" } } });
    await h.router.seedHolds();
    await h.router.prompted("s1", { id: "finish-old", userId: OWNER, body: "CSV" });
    assert.ok(h.calls.some((call) => call.startsWith("error:Your answer was not delivered:")));
    assert.equal(h.calls.at(-1), "elicitation:Deploy?");
    assert.ok(!h.calls.some((call) => /^(respond |checked |send )/.test(call)));
    assert.equal((await h.store.get("s1"))?.questions, null);
  }
});

test("superseding a multipart thread drops its saved progress and releases its deputy veto", async (t) => {
  const h = routerHarness([twoPart], {}, [], true);
  t.after(h.cleanup);
  await h.store.put({ ...link, questions: { requestId: "q", request: twoPart, index: 1, answers: { transfer: "SFTP" } } });
  await h.store.put({ ...link, sessionId: "newest", agentId: "a2", createdAt: "2026-01-02T00:00:00Z" });
  await h.router.seedHolds();
  await h.router.closeSuperseded();
  assert.equal((await h.store.get("s1"))?.closed, true);
  assert.equal((await h.store.get("s1"))?.questions, null);
  assert.equal(await h.replies.respond({ agentId: "a1", requestId: "q", fingerprint: fingerprint(twoPart), intentId: "D-superseded", response: { behavior: "allow", updatedInput: { answers: { transfer: "Mail", format: "XML", Comment: "" } } } }), "applied");
});

test("when a deputy resolved the multipart question, all collected parts become one correction and never answer the newer question", async (t) => {
  const pending = [twoPart];
  let submitted: (() => void) | undefined;
  let acknowledge: (() => void) | undefined;
  const onWire = new Promise<void>((resolve) => { submitted = resolve; });
  const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
  const h = routerHarness(pending, {}, [], async () => { submitted!(); await acknowledgement; });
  t.after(h.cleanup);
  await h.store.put(link);
  const deputy = h.replies.respond({ agentId: "a1", requestId: "q", fingerprint: fingerprint(twoPart), intentId: "D-late-part", response: { behavior: "allow", updatedInput: { answers: { transfer: "Mail", format: "XML", Comment: "" } } } });
  await onWire;
  await h.router.prompted("s1", { id: "p1", userId: OWNER, body: "sftp" });
  acknowledge!();
  assert.equal(await deputy, "applied");
  const corrections: string[] = [];
  h.replies.recordEffects({
    ownerAnswered: async () => { throw new Error("a correction is not owner answer evidence"); },
    correctLate: async (_agentId, requestId, text) => {
      corrections.push(`${requestId}: ${text}`);
      return { delivered: true, reply: "The deputy had already answered this question (D-late-part); your answer went to the agent as your correction." };
    },
    needsYou: async () => {},
  });
  const newer: AgentPermissionRequest = { ...twoPart, id: "newer", input: { questions: [{ question: "Deploy?", header: "deploy", options: [] }] } };
  pending.splice(0, 1, newer);
  await h.router.prompted("s1", { id: "p2", userId: OWNER, body: "CSV" });
  assert.deepEqual(corrections, ["q: transfer: SFTP\nformat: CSV"]);
  assert.ok(h.calls.some((call) => call.startsWith("response:The deputy had already answered this question")));
  assert.equal(h.calls.at(-1), "elicitation:Deploy?");
  assert.equal(h.calls.filter((call) => call.startsWith("checked ")).length, 1);
  assert.ok(!h.calls.some((call) => call.startsWith("checked newer ")));
  assert.equal((await h.store.get("s1"))?.questions, null);
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

test("the owner's Stop holds the ticket for the watchdog across a reload until the owner replies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-flow-watchdog-"));
  const watchdog = new WatchdogStore(join(directory, "watchdog.json"));
  const order: string[] = [];
  const h = routerHarness([], { watchdog: { read: () => watchdog.read(), hold: async (issueId, agentId) => { order.push("hold"); await watchdog.hold(issueId, agentId); }, continued: (issueId) => watchdog.continued(issueId) }, stop: async () => { order.push("stop"); } });
  await h.store.put(link);
  await h.router.prompted("s1", { id: "p1", signal: "stop", content: { body: "stop" } });
  assert.deepEqual(order, ["hold", "stop"], "the hold is saved before the Stop goes out");
  // A new plugin instance reads the same file: the hold does not expire.
  assert.deepEqual(Object.keys((await new WatchdogStore(watchdog.path).read()).holds), ["i1"]);
  await h.router.prompted("s1", { id: "p2", content: { body: "carry on" } });
  assert.deepEqual((await watchdog.read()).holds, {}, "the owner's reply continues the ticket");
  await h.cleanup();
  await rm(directory, { recursive: true, force: true });
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
  // A port nothing listens on any more: the connection is refused, so the decision never reached Plannotator.
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  const h = routerHarness([], { decideReview: (url, approve, feedback) => decidePlannotatorReview(url, approve, feedback) });
  await h.store.put({ ...link, review: { localUrl: `http://127.0.0.1:${port}` } });
  await h.router.prompted("s1", { id: "p1", content: { body: "Split step 2 in two" } });
  assert.equal((await h.store.get("s1"))?.review, null);
  assert.match(h.calls.at(-1) ?? "", /^send a1: Your Plannotator plan review closed[\s\S]*Split step 2 in two/);
  await h.cleanup();
});

test("a ticket keeps one open Paseo thread: older threads are closed once a newer one has the agent", async () => {
  const calls: string[] = [];
  const h = routerHarness([], {
    api: {
      activity: async (sessionId: string, content: { type: string; body?: string }) => { calls.push(`${sessionId} ${content.type}: ${(content.body ?? "").slice(0, 40)}`); },
      openSessions: async () => [{ id: "old", status: "active" }, { id: "older", status: "complete" }, { id: "current", status: "active" }],
      activities: async () => [],
    } as never,
  });
  const at = (hour: number) => `2026-01-01T${String(hour).padStart(2, "0")}:00:00Z`;
  await h.store.put({ ...link, sessionId: "older", agentId: "a0", createdAt: at(8) });
  await h.store.put({ ...link, sessionId: "old", agentId: "a1", createdAt: at(9), review: { localUrl: "http://localhost:5000" } });
  await h.store.put({ ...link, sessionId: "current", agentId: "a1", createdAt: at(10) });
  await h.store.put({ ...link, sessionId: "waiting", agentId: null, createdAt: at(11), queued: true });
  await h.store.put({ ...link, sessionId: "elsewhere", issueId: "i2", agentId: "a2", createdAt: at(7) });
  await h.router.closeSuperseded();
  assert.deepEqual(calls, ["old response: Continued in the newest Paseo thread on "]);
  assert.equal((await h.store.get("old"))?.closed, true);
  assert.equal((await h.store.get("old"))?.review, null);
  assert.equal((await h.store.get("older"))?.closed, true, "already complete in Linear: marked, not told again");
  for (const id of ["current", "waiting", "elsewhere"]) assert.equal((await h.store.get(id))?.closed, undefined, id);
  assert.equal((await h.store.forAgent("a1"))?.sessionId, "current");
  await h.router.closeSuperseded();
  assert.equal(calls.length, 1, "closing happens once");
  await h.cleanup();
});

test("one failed Linear read skips only its part of the sweep: a reply in another thread still reaches its agent", async () => {
  let lists = 0;
  const h = routerHarness([], {
    api: {
      activity: async () => {},
      // The first list (closing superseded threads) fails, the way Linear's 503s do; so does one thread's read.
      openSessions: async () => { if (++lists === 1) throw new Error("HTTP 503"); return [{ id: "s1", status: "active" }, { id: "s2", status: "active" }]; },
      activities: async (id: string) => {
        if (id === "s1") throw new Error("HTTP 503");
        return [{ id: "p1", type: "prompt", userId: OWNER, createdAt: "2026-01-02T00:00:00Z", body: "Also update the README" }];
      },
    } as never,
  });
  // `old` is superseded by `s1`, so closing it lists the sessions first, and that list fails.
  await h.store.put({ ...link, sessionId: "old", agentId: "a0", createdAt: "2025-12-31T00:00:00Z", paseoLinked: "a0" });
  await h.store.put({ ...link, sessionId: "s1", agentId: "a1", paseoLinked: "a1" });
  await h.store.put({ ...link, sessionId: "s2", agentId: "a2", issueId: "i2", paseoLinked: "a2" });
  await h.router.sweep();
  assert.ok(h.calls.some((call) => call.startsWith("send a2:") && call.includes("Also update the README")), JSON.stringify(h.calls));
  assert.ok(!h.calls.some((call) => call.startsWith("send a1")));
  assert.equal(lists, 2);
  await h.cleanup();
});

test("a session Linear webhooks for is read at once and then skipped by the minute sweep", async () => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const reads: string[] = [];
  const h = routerHarness([], {
    now: () => clock,
    api: {
      activity: async () => {},
      openSessions: async () => [{ id: "s1", status: "active" }],
      activities: async (id: string) => { reads.push(id); return []; },
    } as never,
  });
  await h.store.put({ ...link, sessionId: "s1" });
  h.router.receive({ type: "AgentSessionEvent", action: "prompted", agentSession: { id: "s1" }, agentActivity: { id: "p1", content: { body: "carry on" }, userId: OWNER } });
  await h.router.settled();
  assert.deepEqual(reads, ["s1"], "the webhook read the session at once");
  clock += 60_000;
  await h.router.sweep();
  assert.deepEqual(reads, ["s1"], "a minute later the sweep skips it: the webhook delivered the prompt");
  assert.deepEqual(h.router.readStats(), { sweepReads: 0, sweepSkips: 1, webhookReads: 1 });
  await h.cleanup();
});

test("a session Linear webhooks for is re-read on the 5-minute fallback, and every minute again once its webhooks stop", async () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  let clock = start;
  const reads: number[] = [];
  const h = routerHarness([], {
    now: () => clock,
    api: {
      activity: async () => {},
      openSessions: async () => [{ id: "s1", status: "active" }],
      activities: async (id: string) => { reads.push(Math.floor((clock - start) / 60_000)); return []; },
    } as never,
  });
  await h.store.put({ ...link, sessionId: "s1" });
  const webhook = (n: number) => h.router.receive({ type: "AgentSessionEvent", action: "prompted", agentSession: { id: "s1" }, agentActivity: { id: `p${n}`, content: { body: "go on" }, userId: OWNER } });
  webhook(1);
  await h.router.settled();
  for (let minute = 1; minute <= 4; minute++) {
    clock = start + minute * 60_000;
    webhook(minute + 1);
    await h.router.settled();
    await h.router.sweep();
  }
  assert.deepEqual(reads, [0], "the webhooks cover it, so the sweep skips it every minute");
  // The last webhook was 90 s ago (still fresh), but nothing has read the session for 5 minutes.
  clock = start + 5 * 60_000 + 30_000;
  await h.router.sweep();
  assert.deepEqual(reads, [0, 5], "the fallback read is due again");
  // The webhooks stop: once the freshness window is over it is back on the minute sweep.
  clock = start + 10 * 60_000;
  await h.router.sweep();
  await h.router.sweep();
  assert.deepEqual(reads, [0, 5, 10, 10], "no webhook for 5 minutes: today's reads every sweep");
  await h.cleanup();
});

test("a webhook pulls a due fallback read forward, and one that is not due does not read", async () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  let clock = start;
  const reads: string[] = [];
  const h = routerHarness([], {
    now: () => clock,
    api: {
      activity: async () => {},
      openSessions: async () => [{ id: "s1", status: "active" }],
      activities: async (id: string) => { reads.push(id); return []; },
    } as never,
  });
  await h.store.put({ ...link, sessionId: "s1" });
  const webhook = (n: number) => h.router.receive({ type: "AgentSessionEvent", action: "prompted", agentSession: { id: "s1" }, agentActivity: { id: `p${n}`, content: { body: "go on" }, userId: OWNER } });
  webhook(1);
  await h.router.settled();
  clock += 10_000;
  webhook(2);
  await h.router.settled();
  assert.deepEqual(reads, ["s1"], "a prompt ten seconds later does not read again");
  clock = start + 5 * 60_000 + 6_000;
  webhook(3);
  await h.router.settled();
  assert.deepEqual(reads, ["s1", "s1"], "the due read happens at the webhook, not at the next sweep");
  assert.deepEqual(h.router.readStats(), { sweepReads: 0, sweepSkips: 0, webhookReads: 2 });
  await h.cleanup();
});

test("a session with no webhook keeps the minute sweep", async () => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const reads: string[] = [];
  const h = routerHarness([], {
    now: () => clock,
    api: {
      activity: async () => {},
      openSessions: async () => [{ id: "s1", status: "active" }],
      activities: async (id: string) => { reads.push(id); return []; },
    } as never,
  });
  await h.store.put({ ...link, sessionId: "s1" });
  for (let minute = 0; minute < 3; minute++) {
    await h.router.sweep();
    clock += 60_000;
  }
  assert.deepEqual(reads, ["s1", "s1", "s1"]);
  assert.deepEqual(h.router.readStats(), { sweepReads: 3, sweepSkips: 0, webhookReads: 0 });
  await h.cleanup();
});

test("a queued thread starts once its blockers finish, even after it dropped out of Linear's recent sessions", async () => {
  const events: string[] = [];
  const blocked = new Set(["i1", "i2", "i3", "i4", "i5"]);
  const sessionStatus: Record<string, string | null> = { q1: "stale", q2: "complete", q3: "stale", q4: "stale", q5: "awaitingInput" };
  const h = routerHarness([], {
    // Linear's session list no longer contains any of the waiting threads.
    // The batched reads return nothing, so each thread is read alone (the batch's fallback).
    api: { activity: async (sessionId: string, content: { type: string; body?: string }) => { if (content.type !== "thought") events.push(`${sessionId} ${content.type}`); }, openSessions: async () => [], activities: async () => [], sessionStatus: async (id: string) => sessionStatus[id], sessionStatuses: async () => new Map() } as never,
    linear: { viewerId: async () => OWNER, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, issueStatus: async (id: string) => ({ statusType: id === "i3" ? "canceled" : "unstarted", status: id === "i3" ? "Canceled" : "Todo" }), issueStatuses: async () => new Map() } as never,
    starter: {
      admission: async (id: string) => (blocked.has(id) ? { ok: false as const, reason: "Waiting for TUC-9 to finish." } : { ok: true as const }),
      start: async (id: string) => {
        if (id === "i4") throw new Error("No Paseo project is mapped");
        events.push(`start ${id}`);
        return { agentId: `agent-${id}`, warnings: [], provider: "omp", target: "repo", resumed: false, untrusted: false, plan: null };
      },
    },
  });
  for (const n of [1, 2, 3, 4, 5]) await h.store.put({ ...link, sessionId: `q${n}`, issueId: `i${n}`, identifier: `TUC-${n}`, agentId: null, queued: true });

  await h.router.sweep();
  assert.deepEqual(events, ["q3 response"], "closed tickets settle without waiting for blockers");
  assert.equal((await h.store.get("q1"))?.queueReason, "Waiting for TUC-9 to finish.");
  assert.equal((await h.store.get("q2"))?.queued, false, "completed threads settle before admission");

  blocked.clear();
  await h.router.sweep();
  assert.deepEqual(events, [
    "q3 response",
    "start i1",
    "q4 error",
    "start i5",
  ]);
  assert.equal((await h.store.get("q1"))?.agentId, "agent-i1");
  assert.equal((await h.store.get("q5"))?.agentId, "agent-i5");
  for (const id of ["q1", "q2", "q3", "q4", "q5"]) assert.equal((await h.store.get(id))?.queued, false, id);
  assert.equal((await h.store.get("q2"))?.agentId, null, "a thread the owner ended starts nothing");

  await h.router.sweep();
  assert.equal(events.length, 4, "an ended, closed or failed wait is not tried again");
  await h.cleanup();
});

test("a thread Linear marked stale while this host was down starts its agent, unless the ticket was assigned again since", async () => {
  const started: string[] = [];
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const thread = (id: string, status: string, createdAt: string, issueId: string) => ({ id, status, createdAt, creatorId: OWNER, issueId, identifier: `TUC-${issueId}` });
  const h = routerHarness([], {
    api: {
      activity: async () => {},
      activities: async () => [],
      openSessions: async () => [
        // Missed webhook: nobody answered, so Linear marked it stale.
        thread("missed", "stale", minutesAgo(10), "i1"),
        // Missed too, but the owner assigned the ticket again: the newer thread starts it.
        thread("superseded", "stale", minutesAgo(10), "i2"),
        thread("newer", "active", minutesAgo(1), "i2"),
        // Past the adoption window: left alone.
        thread("ancient", "stale", minutesAgo(3 * 60), "i3"),
      ],
    } as never,
    linear: {
      viewerId: async () => OWNER, appUserId: async () => APP, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, cancel: async () => {}, moveToStateNamed: async () => ({ changed: false }), delegate: async () => {},
      issueStatus: async () => ({ statusType: "unstarted", status: "Todo" }),
      issueStatuses: async () => new Map(),
      issueGroup: async (id: string) => ({ id, identifier: `TUC-${id}`, status: "Todo", statusType: "unstarted", delegateId: APP, finished: false, children: [] }),
    } as never,
    starter: {
      admission: async () => ({ ok: true as const }),
      start: async (id: string) => {
        started.push(id);
        return { agentId: `agent-${id}`, warnings: [], provider: "omp", target: "repo", resumed: false, untrusted: false, plan: null };
      },
    },
  });
  await h.store.put({ ...link, sessionId: "newer", issueId: "i2", identifier: "TUC-i2", agentId: "agent-i2", paseoLinked: "agent-i2" });
  await h.router.sweep();
  assert.deepEqual(started, ["i1"]);
  assert.equal((await h.store.get("missed"))?.agentId, "agent-i1");
  assert.equal(await h.store.get("superseded"), null);
  assert.equal(await h.store.get("ancient"), null);
  await h.cleanup();
});

test("a queued thread whose ticket already has a running agent is linked to it instead of starting a second", async () => {
  const starts: string[] = [];
  const h = routerHarness([], {
    api: { activity: async () => {}, openSessions: async () => [], activities: async () => [], sessionStatus: async () => "stale", sessionStatuses: async () => new Map() } as never,
    linear: { viewerId: async () => OWNER, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, issueStatus: async () => ({ statusType: "unstarted", status: "Todo" }), issueStatuses: async () => new Map() } as never,
    starter: { admission: async () => ({ ok: true as const }), start: async (id: string) => { starts.push(id); throw new Error("unused"); } },
  }, [{ id: "labelled", title: "Started by the paseo label" }]);
  await h.store.put({ ...link, sessionId: "q1", agentId: null, queued: true });
  await h.router.startQueued();
  assert.deepEqual(starts, []);
  assert.deepEqual([(await h.store.get("q1"))?.agentId, (await h.store.get("q1"))?.queued], ["labelled", false]);
  await h.cleanup();
});

test("a parked plan's thread offers no resume when its agent is retired, and starts a fresh agent once the owner decided", async () => {
  const starts: string[] = [];
  const h = routerHarness([], {
    api: { activity: async (_s: string, content: { type: string; body?: string }) => { h.calls.push(`${content.type}:${(content.body ?? "").split("\n")[0]}`); }, openSessions: async () => [], activities: async () => [], sessionStatus: async () => "stale", sessionStatuses: async () => new Map() } as never,
    linear: { viewerId: async () => OWNER, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, issueStatus: async () => ({ statusType: "unstarted", status: "Todo" }), issueStatuses: async () => new Map() } as never,
    starter: {
      admission: async () => ({ ok: true as const }),
      start: async (id: string) => { starts.push(id); return { agentId: "fresh", warnings: [], provider: "omp", target: "repo", resumed: false, untrusted: false, plan: null }; },
    },
  });
  await h.store.put({ ...link, review: { localUrl: "http://localhost:4000/" } });
  await h.router.parked("a1");
  assert.deepEqual([(await h.store.get("s1"))?.offer, (await h.store.get("s1"))?.review], ["parked", null]);
  await h.router.offerResume("s1");
  assert.ok(!h.calls.some((call) => call.includes("Resume")), "the retired agent offers no resume");
  assert.equal(await h.router.requeueSession("s1", "a1"), "queued");
  // A retried decision (the worker's step ran but was not recorded) resets nothing.
  assert.equal(await h.router.requeueSession("s1", "a1"), "moved-on");
  await h.router.startQueued();
  assert.deepEqual(starts, ["i1"]);
  assert.deepEqual([(await h.store.get("s1"))?.agentId, (await h.store.get("s1"))?.queued, (await h.store.get("s1"))?.offer], ["fresh", false, null]);
  assert.equal(await h.router.requeueSession("s1", "a1"), "moved-on", "the retired agent no longer owns the thread");
  await h.cleanup();
});

test("a review decided or closed outside Linear is settled by the sweep", async () => {
  const recorded: unknown[] = [];
  const outcomes: Record<string, "open" | null | { approved: boolean; planContent: string }> = { "http://localhost:1": "open", "http://localhost:2": { approved: true, planContent: "# Plan" }, "http://localhost:3": null };
  const h = routerHarness([], { reviewOutcome: async (review) => outcomes[review.localUrl], recordOutcome: async (agentId, outcome) => { recorded.push([agentId, outcome]); } });
  for (const n of [1, 2, 3]) await h.store.put({ ...link, sessionId: `s${n}`, agentId: `a${n}`, issueId: `i${n}`, review: { localUrl: `http://localhost:${n}` } });
  await h.router.settleReviews();
  assert.deepEqual(recorded, [["a2", { approved: true, planContent: "# Plan" }]]);
  assert.deepEqual(h.calls, ["thought:The plan review closed without a decision (for example after a restart). Reply here if the agent should submit the plan again."]);
  assert.deepEqual([(await h.store.get("s1"))?.review?.localUrl, (await h.store.get("s2"))?.review, (await h.store.get("s3"))?.review], ["http://localhost:1", null, null]);
  await h.cleanup();
});

test("the panel's Plan review link lives exactly as long as the review", async () => {
  const updates: unknown[] = [];
  const h = routerHarness([], { api: { activity: async () => {}, openSessions: async () => [], activities: async () => [], updateSession: async (_s: string, input: unknown) => { updates.push(input); } } as never });
  await h.store.put(link);
  await h.router.expectReview("s1", "http://localhost:5000", "# Plan", "https://mac.ts.net:5000");
  await h.router.expectReview("s1", "http://localhost:6000", "# Plan v2", "https://mac.ts.net:6000");
  await h.router.expectReview("s1", null);
  assert.deepEqual(updates, [
    { addedExternalUrls: [{ label: "Plan review", url: "https://mac.ts.net:5000" }] },
    { removedExternalUrls: ["https://mac.ts.net:5000"] },
    { addedExternalUrls: [{ label: "Plan review", url: "https://mac.ts.net:6000" }] },
    { removedExternalUrls: ["https://mac.ts.net:6000"] },
  ]);
  assert.equal((await h.store.get("s1"))?.review, null);
  await h.cleanup();
});

test("the live feed shows completed commands and edits only", () => {
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "shell", command: "npm test" } }), "Ran npm test");
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "edit", filePath: "src/a.ts" } }), "Edited src/a.ts");
  assert.equal(describeTool({ type: "tool_call", status: "running", detail: { type: "shell", command: "npm test" } }), null);
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "read", filePath: "a" } }), null);
});

// `appId`: the Paseo app's user, or null when the app is not usable on this host.
function starterHarness(state: { creatorId: string | null; labels: { id: string; name: string }[]; blockedBy: string[] }, running: number, appId: string | null = APP, away = false, planText = "# Plan\n1. Add the table") {
  const launches: { provider?: string; thinkingOptionId?: string; modeId?: string; instructions: string; labels?: Record<string, string>; env?: Record<string, string>; markInProgress?: boolean }[] = [];
  const starter = new TicketStarter({
    linear: {
      detail: async () => ({ issue: { identifier: "TUC-1", project: "", team: "Team" }, projectId: null, teamId: "t1" }) as never,
      issueState: async () => ({ id: "i1", identifier: "TUC-1", status: "Todo", statusId: "todo", statusType: "unstarted", teamId: "t1", projectId: null, attachmentUrls: [], priority: 0, createdAt: "", unblocks: 0, ...state }),
      viewerId: async () => OWNER,
      appUserId: async () => appId,
      issueDocument: async (_id: string, title: string) => title === "Plan: TUC-1" ? { url: "https://linear.app/doc/plan", content: planText } : null,
    },
    launcher: { start: async (input, _paseo, options) => { launches.push({ provider: input.provider, thinkingOptionId: input.thinkingOptionId, modeId: input.modeId, instructions: input.instructions, labels: options?.labels, env: options?.env, markInProgress: options?.markInProgress }); return { agentId: "new", warnings: [] }; } },
    branches: async () => ({ branches: [{ id: "refs/heads/main", label: "main" }], defaultBranch: "refs/heads/main" }),
    presence: { away: async () => away },
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

test("an agent waiting for the owner's answer or approval frees its slot; one at work keeps it", async () => {
  const h = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  // One running ticket agent per entry, with that entry's pending permission requests.
  const paseoWith = (pending: { id: string; kind: string }[][]) => ({ ...h.paseo, agents: { list: async () => ({
    entries: pending.map((pendingPermissions, index) => ({ agent: { id: `r${index}`, status: "running", labels: { "linear.issueId": `x${index}` }, pendingPermissions } })),
    pageInfo: { hasMore: false },
  }) } }) as unknown as PaseoApi;
  const waiting = paseoWith([[{ id: "q", kind: "question" }], [{ id: "p", kind: "tool" }]]);
  assert.deepEqual(await h.starter.admission("i1", waiting, settings), { ok: true }, "both agents wait for the owner: 0 of 2 slots used");
  assert.equal((await h.starter.scheduler.counts(waiting)).running, 0);
  const working = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  const busy = paseoWith([[], []]);
  assert.match((await working.starter.admission("i1", busy, settings) as { reason: string }).reason, /Queued: 2 of 2/);
});

test("while the owner is away, only the implementation of an attended ticket waits; planning never does, even with no agent limit", async () => {
  const unlimited = { ...settings, dispatch: { ...settings.dispatch, maxRunning: 0 } };
  const approved = starterHarness({ creatorId: OWNER, labels: [{ id: "l1", name: "paseo-attended" }, { id: "r", name: "plan-ready" }], blockedBy: [] }, 0, APP, true);
  assert.deepEqual(await approved.starter.admission("i1", approved.paseo, unlimited), { ok: false, reason: AWAY_REASON });
  const present = starterHarness({ creatorId: OWNER, labels: [{ id: "l1", name: "paseo-attended" }, { id: "r", name: "plan-ready" }], blockedBy: [] }, 0, APP, false);
  assert.deepEqual(await present.starter.admission("i1", present.paseo, unlimited), { ok: true });
  for (const [why, state] of [
    ["attended, still to plan", { creatorId: OWNER, labels: [{ id: "l1", name: "paseo-attended" }] }],
    ["written by someone else", { creatorId: "colleague", labels: [] }],
    ["an approved plan, not attended", { creatorId: OWNER, labels: [{ id: "r", name: "plan-ready" }] }],
    ["plain", { creatorId: OWNER, labels: [] }],
  ] as const) {
    const away = starterHarness({ ...state, labels: [...state.labels], blockedBy: [] }, 0, APP, true);
    assert.deepEqual(await away.starter.admission("i1", away.paseo, unlimited), { ok: true }, why);
  }
});

test("every ticket starts plan-first; someone else's ticket is marked untrusted; omp keeps the usual mode so the planner never waits for approvals", async () => {
  assert.equal(isUntrusted({ creatorId: OWNER, labels: [] }, OWNER, APP), false);
  assert.equal(isUntrusted({ creatorId: "customer", labels: [] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: OWNER, labels: [{ name: "Feedback" }] }, OWNER, APP), true);
  const h = starterHarness({ creatorId: "customer", labels: [], blockedBy: [] }, 0);
  const started = await h.starter.start("i1", h.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: started.untrusted, plan: started.plan }, { untrusted: true, plan: "required" });
  assert.deepEqual(h.launches[0], { provider: "omp/opus", thinkingOptionId: undefined, modeId: "full", instructions: `${UNTRUSTED_NOTE}\n\n${OVERLAP_NOTE}\n\n${PLAN_SECTIONS_NOTE}\n\n${MODEL_NOTE}\n\n${advisorNote("omp")}\n\n${MISSED_REACH_NOTE}\n\n${QUESTIONS_NOTE}`, labels: { "linear.plan": "required" }, env: { LINEAR_TICKETS_PLAN: "required" }, markInProgress: false });
  const mine = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  const own = await mine.starter.start("i1", mine.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: own.untrusted, plan: own.plan }, { untrusted: false, plan: "required" });
  assert.deepEqual(mine.launches[0], { provider: "omp/opus", thinkingOptionId: undefined, modeId: "full", instructions: `${PLAN_REQUIRED_NOTE}\n\n${OVERLAP_NOTE}\n\n${PLAN_SECTIONS_NOTE}\n\n${MODEL_NOTE}\n\n${advisorNote("omp")}\n\n${MISSED_REACH_NOTE}\n\n${QUESTIONS_NOTE}`, labels: { "linear.plan": "required" }, env: { LINEAR_TICKETS_PLAN: "required" }, markInProgress: false });
});

test("tickets the Paseo app wrote are trusted like the owner's, unless they came from the feedback intake or the app is unknown here", async () => {
  assert.equal(isUntrusted({ creatorId: APP, labels: [] }, OWNER, APP), false);
  assert.equal(isUntrusted({ creatorId: APP, labels: [{ name: "feedback" }] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: "customer", labels: [] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: null, labels: [] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: null, labels: [] }, OWNER, null), true, "an unknown creator never matches an unknown app");
  assert.equal(isUntrusted({ creatorId: APP, labels: [] }, OWNER, null), true);
  const byApp = starterHarness({ creatorId: APP, labels: [], blockedBy: [] }, 0);
  const trusted = await byApp.starter.start("i1", byApp.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: trusted.untrusted, plan: trusted.plan }, { untrusted: false, plan: "required" });
  const appUnknown = starterHarness({ creatorId: APP, labels: [], blockedBy: [] }, 0, null);
  const untrusted = await appUnknown.starter.start("i1", appUnknown.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: untrusted.untrusted, plan: untrusted.plan }, { untrusted: true, plan: "required" });
});

test("plan policy: an approved plan is implemented, every other ticket plans; the old no-plan label skips nothing", () => {
  const labels = (...names: string[]) => names.map((name) => ({ name }));
  assert.equal(planPolicy(labels()), "required");
  assert.equal(planPolicy(labels("no-plan")), "required");
  assert.equal(planPolicy(labels("Plan-Ready")), null);
  assert.equal(planPolicy(labels("plan-ready", "plan")), null);
});

test("a plan starts in the provider's safe mode, and not in progress", async () => {
  const h = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  const started = await h.starter.start("i1", h.paseo, { ...settings, markInProgress: true, lastProvider: "claude", launchPreferences: { claude: { model: "claude/opus", modeId: "default" } } }, { retryHint: "retry" });
  assert.deepEqual({ untrusted: started.untrusted, plan: started.plan }, { untrusted: false, plan: "required" });
  assert.deepEqual(h.launches[0], { provider: "claude/opus", thinkingOptionId: undefined, modeId: "plan", instructions: `${PLAN_REQUIRED_NOTE}\n\n${OVERLAP_NOTE}\n\n${PLAN_SECTIONS_NOTE}\n\n${MODEL_NOTE}\n\n${advisorNote("claude")}\n\n${MISSED_REACH_NOTE}\n\n${QUESTIONS_NOTE}`, labels: { "linear.plan": "required" }, env: { LINEAR_TICKETS_PLAN: "required" }, markInProgress: false });
});

test("a plan-first ticket is not marked in progress; once its plan is approved (plan-ready) the next agent implements it in the usual mode", async () => {
  const syncing = { ...settings, markInProgress: true, writeback: { ...DEFAULT_WRITEBACK, status: true } };
  const first = starterHarness({ creatorId: "customer", labels: [{ id: "f", name: "feedback" }], blockedBy: [] }, 0);
  await first.starter.start("i1", first.paseo, syncing, { retryHint: "retry" });
  assert.equal(first.launches[0].markInProgress, false);
  const later = starterHarness({ creatorId: "customer", labels: [{ id: "f", name: "feedback" }, { id: "r", name: "plan-ready" }], blockedBy: [] }, 0, APP, false, "# Plan\n1. Add the table\n\n## Model\n\n- Tier: strong — four layers\n- Strong steps: none — all of it\n");
  const started = await later.starter.start("i1", later.paseo, syncing, { retryHint: "retry" });
  assert.equal(started.plan, null);
  assert.equal(later.launches[0].modeId, "full");
  assert.equal(later.launches[0].markInProgress, true);
  assert.deepEqual(later.launches[0].labels, { "linear.tier": "strong" });
  assert.match(later.launches[0].instructions, /untrusted input/);
  assert.doesNotMatch(later.launches[0].instructions, /write a plan only/);
  assert.match(later.launches[0].instructions, /already approved a plan.*https:\/\/linear\.app\/doc\/plan/);
  assert.match(later.launches[0].instructions, /1\. Add the table/);
  assert.ok(later.launches[0].instructions.includes(MISSED_REACH_NOTE), "the implementer files places the plan missed instead of growing the ticket");
});

test("an approved plan on the cheap tier launches on the provider's cheap model; a model:strong label overrides it", async () => {
  const cheapPlan = "# Plan\n1. Add the column\n\n## Model\n\n- Tier: cheap — one column\n- Strong steps: 2 — the migration\n";
  const tiered = { ...settings, cheapModels: { omp: { model: "omp/deepseek/deepseek-flash", thinkingOptionId: "max" } } };
  const ready = { id: "r", name: "plan-ready" };
  const cheap = starterHarness({ creatorId: OWNER, labels: [ready], blockedBy: [] }, 0, APP, false, cheapPlan);
  await cheap.starter.start("i1", cheap.paseo, tiered, { retryHint: "retry" });
  assert.deepEqual({ provider: cheap.launches[0].provider, thinking: cheap.launches[0].thinkingOptionId, labels: cheap.launches[0].labels }, { provider: "omp/deepseek/deepseek-flash", thinking: "max", labels: { "linear.tier": "cheap" } });
  assert.match(cheap.launches[0].instructions, /cheap model tier.*Strong steps: 2 — the migration.*escalate_model/s);
  const unset = starterHarness({ creatorId: OWNER, labels: [ready], blockedBy: [] }, 0, APP, false, cheapPlan);
  await unset.starter.start("i1", unset.paseo, settings, { retryHint: "retry" });
  assert.equal(unset.launches[0].provider, "omp/opus", "no cheap model for the provider: the launch model");
  const labelled = starterHarness({ creatorId: OWNER, labels: [ready, { id: "s", name: "model:strong" }], blockedBy: [] }, 0, APP, false, cheapPlan);
  await labelled.starter.start("i1", labelled.paseo, tiered, { retryHint: "retry" });
  assert.deepEqual({ provider: labelled.launches[0].provider, labels: labelled.launches[0].labels }, { provider: "omp/opus", labels: { "linear.tier": "strong" } });
});

const READY = { id: "r", name: "plan-ready" };
const RISK = (impact: number) => `## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: ${impact} — orders\n- Reversibility: revert — none\n- Feature flag: no\n- Migration: no\n- Auth: no\n- New rule: no — none\n- Failure mode: a wrong column\n- Advisor rating: impact ${impact}, reversibility revert\n- Recommendation: auto — none\n`;

test("an approved standard plan launches on the provider's standard model; a risk rating that requires strong launches on the launch model", async () => {
  const standardPlan = (impact: number) => `# Plan\n1. Add the column\n\n## Model\n\n- Tier: standard — a column with a filter\n- Strong steps: none — routine\n\n${RISK(impact)}`;
  const tiered = { ...settings, standardModels: { omp: { model: "omp/openai-codex/gpt-6.1-sol", thinkingOptionId: "high" } } };
  const standard = starterHarness({ creatorId: OWNER, labels: [READY], blockedBy: [] }, 0, APP, false, standardPlan(2));
  await standard.starter.start("i1", standard.paseo, tiered, { retryHint: "retry" });
  assert.deepEqual({ provider: standard.launches[0].provider, thinking: standard.launches[0].thinkingOptionId, labels: standard.launches[0].labels }, { provider: "omp/openai-codex/gpt-6.1-sol", thinking: "high", labels: { "linear.tier": "standard" } });
  assert.match(standard.launches[0].instructions, /standard model tier.*escalate_model/s);
  const risky = starterHarness({ creatorId: OWNER, labels: [READY], blockedBy: [] }, 0, APP, false, standardPlan(3));
  await risky.starter.start("i1", risky.paseo, tiered, { retryHint: "retry" });
  assert.deepEqual({ provider: risky.launches[0].provider, labels: risky.launches[0].labels }, { provider: "omp/opus", labels: { "linear.tier": "strong" } }, "impact 3 always implements on the strong tier");
});

test("an approved plan that names no tier goes back to planning for its model section instead of implementing on a default tier", async () => {
  const h = starterHarness({ creatorId: OWNER, labels: [READY], blockedBy: [] }, 0);
  const started = await h.starter.start("i1", h.paseo, { ...settings, markInProgress: true }, { retryHint: "retry" });
  assert.equal(started.plan, "required");
  assert.deepEqual({ provider: h.launches[0].provider, labels: h.launches[0].labels, env: h.launches[0].env, markInProgress: h.launches[0].markInProgress }, { provider: "omp/opus", labels: { "linear.plan": "required" }, env: { LINEAR_TICKETS_PLAN: "required" }, markInProgress: false });
  assert.ok(h.launches[0].instructions.startsWith(tierMissingNote("TUC-1", { url: "https://linear.app/doc/plan", content: "# Plan\n1. Add the table" })));
  assert.ok(h.launches[0].instructions.includes(MODEL_NOTE));
  assert.ok(!h.launches[0].instructions.includes(OVERLAP_NOTE), "the approved plan already looked for overlaps");
});

const PR: PullRequestView = { state: "OPEN", isDraft: false, headSha: "h", headBranch: "tuc-1", baseBranch: "main", updatedAt: "", reviewDecision: "", labels: [], mergeActivity: null, comments: [], reviews: [], lastCommitAt: null, checks: [], mergeable: null };

test("the review mirror: approval means ready to merge, and commits after it send the ticket back to review", () => {
  const approved = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "APPROVED", submittedAt: "2026-01-01T12:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T11:00:00Z" }, { reviewedAt: null, decision: null, merged: false });
  assert.equal(approved.change?.state, "Ready to merge");
  assert.equal(reviewChange({ ...PR, state: "OPEN", reviews: [], lastCommitAt: "2026-01-01T11:00:00Z" }, approved.seen).change, null, "nothing new");
  const pushed = reviewChange({ ...PR, state: "OPEN", reviews: [], lastCommitAt: "2026-01-01T13:00:00Z" }, approved.seen);
  assert.equal(pushed.change?.state, "In Review");
  assert.equal(reviewChange({ ...PR, state: "OPEN", reviews: [], lastCommitAt: "2026-01-01T13:00:00Z" }, pushed.seen).change, null, "reported once");
});

test("pull request reviews become ticket updates: changes requested, fixes pushed, approved, merged", () => {
  const start = { reviewedAt: null, decision: null, merged: false };
  const requested = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T09:00:00Z" }, start);
  assert.equal(requested.change?.state, "In Progress");
  assert.equal(requested.change?.review, "changes requested by @ada");
  assert.equal(reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T09:00:00Z" }, requested.seen).change, null, "nothing new");
  const pushed = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T11:00:00Z" }, requested.seen);
  assert.equal(pushed.change?.state, "In Review");
  const approved = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "APPROVED", submittedAt: "2026-01-01T12:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T11:00:00Z" }, pushed.seen);
  assert.equal(approved.change?.review, "approved by @ada");
  const merged = reviewChange({ ...PR, state: "MERGED", reviews: [], lastCommitAt: null }, approved.seen);
  assert.equal(merged.change?.review, "merged");
  assert.equal(reviewChange({ ...PR, state: "MERGED", reviews: [], lastCommitAt: null }, merged.seen).change, null);
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

test("deleted tickets lose parked and queued sessions, archive every affected agent, and cannot requeue or succeed after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-deleted-session-"));
  const issueId = "3b241101-e2bb-4255-8caf-4136c566a962";
  const file = join(directory, "deletions.json");
  const journal = new ReviewDeletions(file);
  const h = routerHarness([], { deletions: journal });
  const archived = new Set<string>();
  let launches = 0;
  const actions: string[] = [];
  Object.assign(h.router, {
    paseo: {
      agents: {
        list: async () => ({ entries: ["a1", "a2"].filter((id) => !archived.has(id)).map((id) => ({ agent: { id, labels: { "linear.issueId": issueId } } })), pageInfo: { hasMore: false } }),
        ref: (id: string) => ({
          refresh: async () => ({ agent: { id, archivedAt: archived.has(id) ? "now" : null, labels: { "linear.issueId": issueId } } }),
          archive: async () => { archived.add(id); actions.push(`archive ${id}`); },
        }),
      },
    },
  });
  try {
    await h.store.put({ ...link, issueId, offer: "parked", review: { localUrl: "http://localhost:4000/" } });
    await h.store.put({ ...link, sessionId: "queued", issueId, agentId: null, queued: true, pendingText: "Replan this" });
    await h.store.put({ ...link, sessionId: "unrelated", issueId: "another-ticket", queued: true, pendingText: "Keep this message" });
    await journal.put({ issueId, identifier: "TUC-1", agentId: "a1", phase: "deleted" });
    await h.router.deleteTicket(issueId, "a1");
    assert.deepEqual([...archived].sort(), ["a1", "a2"]);
    assert.deepEqual(actions.sort(), ["archive a1", "archive a2"]);
    assert.deepEqual(h.calls, ["stop a1", "stop a2"]);
    assert.deepEqual((await h.store.all()).map((entry) => ({ id: entry.sessionId, pending: entry.pendingText })), [{ id: "unrelated", pending: "Keep this message" }]);
    const restarted = routerHarness([], {
      deletions: new ReviewDeletions(file),
      starter: { admission: async () => ({ ok: true as const }), start: async () => { launches++; throw new Error("deleted issue must never start"); } },
    });
    try {
      await restarted.router.created({ id: "stale", issueId, issue: { identifier: "TUC-1" }, creatorId: OWNER });
      await restarted.router.restartFor(issueId, "TUC-1");
      assert.equal((await restarted.router.succeed(issueId, "TUC-1", "a1", "Continue", async () => {})).kind, "impossible");
      assert.equal(await restarted.router.requeueSession("s1", "a1"), "none");
      assert.deepEqual(await restarted.store.all(), []);
      assert.equal(launches, 0);
    } finally { await restarted.cleanup(); }
  } finally { await h.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

// --- Panel decisions and recovered outcomes through the journal (TUC-1288) -------------------

// What the panel's bridge needs of the fake Linear service.
type PanelLinearService = {
  comment(issueId: string, body: string, id?: string): Promise<void>;
  commentById(id: string): Promise<{ id: string } | null>;
  issueById(id: string): Promise<{ id: string; identifier: string } | null>;
  createIssue(input: { id?: string; title: string }): Promise<{ id: string; identifier: string }>;
  addBlocker(blocker: string, blocked: string): Promise<void>;
  delegate(issueId: string, appUserId: string): Promise<void>;
  upsertIssueDocument(issueId: string, title: string): Promise<string>;
  issueDocument(issueId: string, title: string): Promise<null>;
  moveToStateNamed(issueId: string, name: string): Promise<{ changed: boolean }>;
  moveToReady(issueId: string): Promise<{ changed: boolean }>;
  addLabel(issueId: string, name: string): Promise<void>;
  removeLabel(issueId: string, name: string): Promise<void>;
  issueState(issueId: string): Promise<never>;
  viewerId(): Promise<string>;
  appUserId(): Promise<string>;
};

// How the fake Linear service fails a call: the message the call throws with, or `before`/`after`
// for a sub-issue create (thrown before creating, or after creating with the answer lost).
type LinearTrouble = {
  document?: (call: number) => string | null;
  ready?: (call: number) => string | null;
  create?: (call: number) => "before" | "after" | null;
};

type PanelLinear = {
  linear: PanelLinearService;
  calls: string[];
  issues: Map<string, { id: string; identifier: string }>;
  counters: { documentTries: number; documents: number; readyTries: number; creates: number };
};

// The fake Linear service behind the panel's bridge: every effect is named in `calls`, sub-issues
// stay under the id the worker reserved for them (a retry looks them up instead of creating
// another), and `trouble` fails one call with the message it returns.
function panelLinear(trouble: LinearTrouble = {}): PanelLinear {
  const calls: string[] = [];
  const issues = new Map<string, { id: string; identifier: string }>();
  const counters = { documentTries: 0, documents: 0, readyTries: 0, creates: 0 };
  const linear: PanelLinearService = {
    async comment(issueId: string, _body: string, _id?: string) { calls.push(`comment ${issueId}`); },
    async commentById(_id: string) { return null; },
    async issueById(id: string) { return issues.get(id) ?? null; },
    async createIssue(input: { id?: string; title: string }) {
      counters.creates += 1;
      const failure = trouble.create?.(counters.creates) ?? null;
      if (failure === "before") throw new Error("Linear is down");
      const issue = { id: input.id ?? `created-${counters.creates}`, identifier: `TUC-${900 + counters.creates}` };
      issues.set(issue.id, issue);
      calls.push(`create ${issue.identifier} ${input.title}`);
      if (failure === "after") throw new Error("socket hang up");
      return issue;
    },
    async addBlocker(blocker: string, blocked: string) { calls.push(`block ${blocker} ${blocked}`); },
    async delegate(issueId: string, appUserId: string) { calls.push(`delegate ${issueId} ${appUserId}`); },
    async upsertIssueDocument(issueId: string, title: string) {
      counters.documentTries += 1;
      const failure = trouble.document?.(counters.documentTries) ?? null;
      if (failure) throw new Error(failure);
      counters.documents += 1;
      calls.push(`document ${issueId} ${title}`);
      return `https://linear.app/doc/${issueId}`;
    },
    async issueDocument(_issueId: string, _title: string) { return null; },
    async moveToStateNamed(issueId: string, name: string) { calls.push(`state ${name} ${issueId}`); return { changed: true }; },
    async moveToReady(issueId: string) {
      counters.readyTries += 1;
      const failure = trouble.ready?.(counters.readyTries) ?? null;
      if (failure) throw new Error(failure);
      calls.push(`ready ${issueId}`);
      return { changed: true };
    },
    async addLabel(issueId: string, name: string) { calls.push(`+${name} ${issueId}`); },
    async removeLabel(issueId: string, name: string) { calls.push(`-${name} ${issueId}`); },
    async issueState() { return { identifier: "TUC-1", teamId: "t1", projectId: "p1", labels: [], status: "Todo", statusType: "unstarted" } as never; },
    async viewerId() { return OWNER; },
    async appUserId() { return APP; },
  };
  return { linear, calls, issues, counters };
}

// The router with a real PlannotatorBridge (and its journal) behind the panel's decision deps:
// a panel Approve / Send back goes through decideOwner, later/split through decidePanel, and a
// saved outcome through recovered. `build()` makes a bridge on the same temp directories; after
// stop(), building another one is a reload.
async function panelHarness(plan: string, options: {
  linear?: PanelLinear;
  decide?: (localUrl: string, approve: boolean, feedback: string) => Promise<void>;
  outcome?: (review: PendingReview) => Promise<ReviewOutcome>;
  labels?: Record<string, string>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "paseo-panel-"));
  const store = new SessionStore(join(root, "sessions.json"));
  const events = join(root, "events");
  await mkdir(events, { recursive: true });
  const linear = options.linear ?? panelLinear();
  const decisions: { url: string; approve: boolean; feedback: string }[] = [];
  const decide = async (url: string, approve: boolean, feedback: string) => {
    decisions.push({ url, approve, feedback });
    await options.decide?.(url, approve, feedback);
  };
  const holder: { bridge: PlannotatorBridge | null } = { bridge: null };
  const h = routerHarness([], {
    store,
    decideReview: (url, approve, feedback, agentId, origin) => holder.bridge!.decideOwner(url, approve, feedback, agentId, origin),
    decidePlan: (link, mode) => holder.bridge!.decidePanel(link, mode),
    reviewOutcome: options.outcome ?? (async () => "open" as const),
    recordOutcome: (agentId, outcome, review) => holder.bridge!.recovered(agentId, review, outcome),
  });
  // The agent's labels as the bridge sees them; without them it has no ticket and its decisions
  // take the "none" route, without a session context.
  if (options.labels) {
    const labels = options.labels;
    const ref = h.paseo.agents.ref.bind(h.paseo.agents);
    Object.assign(h.paseo.agents as unknown as Record<string, unknown>, {
      ref: (id: string) => ({ ...ref(id), refresh: async () => ({ agent: { id, labels } }) }),
    });
  }
  const bridges: PlannotatorBridge[] = [];
  const build = () => {
    const bridge = new PlannotatorBridge(linear.linear as never, { read: async () => settings }, events, h.router, async () => plan, undefined, undefined, undefined, decide, () => {});
    bridges.push(bridge);
    holder.bridge = bridge;
    return bridge;
  };
  // The journal's review generation and the session's stored review, as the hand-off leaves them.
  const seed = async (bridge: PlannotatorBridge) => {
    await h.store.put({ ...link, review: null });
    const review = await bridge.decisionJournal.ensureReview({ agentId: "a1", localUrl: "http://localhost:4000/", openedAt: "2026-10-07T11:00:00.000Z", planHash: planHash(plan) });
    await h.router.expectReview("s1", review.localUrl, plan, null, review.id);
    return review;
  };
  const cleanup = async () => { for (const bridge of bridges) await bridge.stop().catch(() => {}); await h.cleanup(); };
  return { h, store, events, linear, decisions, holder, build, seed, cleanup };
}

test("a panel approve is journaled before Plannotator is asked, and applied once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  const plan = "# Plan\n\n1. Do the thing";
  const panels = await panelHarness(plan, {
    labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" },
    decide: async () => {
      const attempts = panels.holder.bridge!.decisionJournal.attempts();
      assert.equal(attempts.length, 1, "the decision is journaled before Plannotator is asked");
      assert.deepEqual(
        { source: attempts[0].source, state: attempts[0].state, approved: attempts[0].approved, mode: attempts[0].mode, sessionId: attempts[0].sessionId, route: attempts[0].route },
        { source: "linear-panel", state: "deciding", approved: true, mode: "approve", sessionId: "s1", route: "live" },
      );
    },
  });
  const { h, store } = panels;
  try {
    const bridge = panels.build();
    bridge.attach(h.paseo);
    await bridge.drain();
    const review = await panels.seed(bridge);
    await h.router.prompted("s1", { id: "p1", content: { body: "Approve plan" } });
    assert.equal((await store.get("s1"))?.review, null, "the panel's approve clears the review");
    assert.ok(h.calls.includes("thought:Plan approved."), JSON.stringify(h.calls));
    const attempt = bridge.decisionJournal.attempts()[0];
    assert.equal(attempt.reviewId, review.id, "the attempt is on the panel's review");
    await bridge.drain();
    assert.equal(bridge.decisionJournal.attempt(attempt.id)?.state, "applied", "the accepted decision is carried out");
    assert.equal(h.calls.filter((call) => call === "thought:Plan approved — starting on it.").length, 1, "the panel note is posted once");
    assert.equal(panels.linear.calls.filter((call) => call.startsWith("comment ")).length, 1, "the decision is carried out once");
  } finally { await panels.cleanup(); }
});

test("a panel reply whose review already closed voids the attempt, clears the review and reaches the agent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  const plan = "# Plan\n\n1. Do the thing";
  let asked = 0;
  const panels = await panelHarness(plan, {
    decide: async () => {
      const attempts = panels.holder.bridge!.decisionJournal.attempts();
      assert.equal(attempts.length, 1);
      assert.deepEqual({ source: attempts[0].source, approved: attempts[0].approved, mode: attempts[0].mode }, { source: "linear-panel", approved: false, mode: "send-back" });
      asked += 1;
      throw new ReviewClosedError("the review closed with its agent process", false);
    },
  });
  const { h, store } = panels;
  try {
    const bridge = panels.build();
    bridge.attach(h.paseo);
    await bridge.drain();
    await panels.seed(bridge);
    await h.router.prompted("s1", { id: "p1", content: { body: SEND_BACK } });
    assert.equal(asked, 1, "Plannotator was asked once");
    const attempt = bridge.decisionJournal.attempts()[0];
    assert.equal(attempt.state, "void", "a review Plannotator refused cannot be accepted later");
    assert.ok(attempt.voidReason);
    assert.equal((await store.get("s1"))?.review, null, "the closed review no longer holds the session");
    assert.ok(h.calls.includes("thought:That plan review had already closed, so your reply goes to the agent, which submits the plan again."), JSON.stringify(h.calls));
    assert.match(h.calls.at(-1) ?? "", /^send a1: Your Plannotator plan review closed[\s\S]*Sent back from Linear\./);
  } finally { await panels.cleanup(); }
});

test("a panel 'approve, implement later' survives Linear failures and reloads, applies once, and its retire report confirms", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const plan = "# Plan\n\n1. One\n2. Two";
  let clears = 0;
  let atRetire: string | null | undefined;
  const linear = panelLinear({ document: (call) => call === 1 ? "Linear is down" : null, ready: (call) => call === 1 ? "Linear is down" : null });
  const panels = await panelHarness(plan, { linear, decide: async (_url, approve) => { if (!approve) atRetire = (await panels.h.store.get("s1"))?.offer; } });
  const { h, store } = panels;
  try {
    const bridge = panels.build();
    bridge.attach(h.paseo);
    await bridge.drain();
    const review = await panels.seed(bridge);
    const clear = h.router.clearReview.bind(h.router);
    h.router.clearReview = async (sessionId: string) => { clears += 1; return clear(sessionId); };
    await h.router.prompted("s1", { id: "p1", content: { body: APPROVE_LATER } });
    assert.match(h.calls.at(-1) ?? "", /^response:Approved — being applied: Linear is down\./, JSON.stringify(h.calls));
    assert.equal((await store.get("s1"))?.offer, "later", "the session is held before the planner is retired");
    assert.equal((await store.get("s1"))?.review?.reviewId, review.id, "the review stays until the decision went through");
    const attemptId = bridge.decisionJournal.attempts()[0].id;

    // A reload between the hold and the retire: no Resume, no agent.
    await bridge.stop();
    let quiet = h.calls.length;
    await h.router.offerResume("s1");
    await h.router.startQueued();
    assert.equal(h.calls.length, quiet, "a held session offers no Resume and starts nobody");
    assert.equal(panels.decisions.length, 0, "the planner was not retired yet");

    // The retry writes the document and retires the planner, then Linear fails at `ready`.
    const second = panels.build();
    t.mock.timers.tick(3_000);
    second.attach(h.paseo);
    await second.drain();
    assert.equal(atRetire, "later", "the planner is retired only after the session is held");
    assert.deepEqual(panels.decisions.map(({ approve }) => approve), [false], "the planner is retired once");
    assert.equal((await store.get("s1"))?.review?.reviewId, review.id);
    assert.equal(second.decisionJournal.attempt(attemptId)?.lastError, "Linear is down");

    // A reload between the retire and the ready write: still no Resume and no agent.
    await second.stop();
    quiet = h.calls.length;
    await h.router.offerResume("s1");
    await h.router.startQueued();
    assert.equal(h.calls.length, quiet, "the retired planner is not resumed");
    assert.equal(panels.decisions.length, 1, "the retire is not repeated");

    const third = panels.build();
    t.mock.timers.tick(3_000);
    third.attach(h.paseo);
    await third.drain();
    assert.equal(third.decisionJournal.attempt(attemptId)?.state, "applied");
    assert.equal(clears, 1, "the review is cleared once");
    assert.equal((await store.get("s1"))?.review, null);
    assert.equal(h.calls.filter((call) => call.startsWith("response:Plan approved for later")).length, 1, "the workflow replies once");
    assert.deepEqual(linear.calls.filter((call) => call.startsWith("ready ")), ["ready i1"]);
    assert.equal(linear.counters.documents, 1, "the plan document is written once");
    assert.ok(linear.calls.includes("+plan-ready i1"));

    // The retired planner's report of the closed review arrives later: a confirmation, not a decision.
    await writeFile(join(panels.events, "z-later-report.json"), JSON.stringify({ type: "decided", agentId: "a1", approved: false, planContent: plan, at: "2026-10-07T12:05:00.000Z" }));
    quiet = h.calls.length;
    await third.drain();
    assert.deepEqual(third.decisionJournal.attempt(attemptId)?.reports, ["z-later-report.json"], "the report confirms the closing");
    assert.equal(third.decisionJournal.attempt(attemptId)?.state, "applied");
    assert.ok(!third.decisionJournal.all().some((entry) => entry.kind === "conflict"));
    assert.equal(h.calls.length, quiet, "the confirmation reaches nobody");
    assert.deepEqual(await readdir(panels.events), [], "the report file is consumed");
  } finally { await panels.cleanup(); }
});

test("a panel split survives a lost sub-issue create and reloads: every sub-issue, blocker and delegation exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const plan = "# Plan\n\n1. One\n2. Two\n3. Three";
  let atRetire: string | null | undefined;
  let groups = 0;
  const linear = panelLinear({ create: (call) => call === 3 ? "before" : call === 4 ? "after" : null });
  const panels = await panelHarness(plan, { linear, decide: async (_url, approve) => { if (!approve) atRetire = (await panels.h.store.get("s1"))?.offer; } });
  const { h, store } = panels;
  try {
    const bridge = panels.build();
    bridge.attach(h.paseo);
    await bridge.drain();
    const review = await panels.seed(bridge);
    const group = h.router.groupSession.bind(h.router);
    h.router.groupSession = async (sessionId: string) => { groups += 1; return group(sessionId); };

    await h.router.prompted("s1", { id: "p1", content: { body: SPLIT_PLAN } });
    assert.match(h.calls.at(-1) ?? "", /^response:Approved — being applied: Linear is down\./, JSON.stringify(h.calls));
    assert.equal(atRetire, "split", "the planner is retired only after the session is held");
    assert.equal(panels.decisions.length, 1, "the planner is retired once");
    assert.equal(linear.issues.size, 2, "two sub-issues were created before the failure");
    assert.equal((await store.get("s1"))?.review?.reviewId, review.id);

    // A reload after the retire: no Resume, no parent agent.
    await bridge.stop();
    let quiet = h.calls.length;
    await h.router.offerResume("s1");
    await h.router.startQueued();
    assert.equal(h.calls.length, quiet, "a held session offers no Resume and starts nobody");

    // The retry creates the third sub-issue and loses its answer.
    const second = panels.build();
    t.mock.timers.tick(3_000);
    second.attach(h.paseo);
    await second.drain();
    const attemptId = second.decisionJournal.attempts()[0].id;
    assert.equal(linear.issues.size, 3, "the created sub-issue is kept under its reserved id");
    assert.equal(linear.counters.creates, 4, "the third sub-issue was created once, after one failed try");

    // Another reload after the retire, before the answer is recovered.
    await second.stop();
    quiet = h.calls.length;
    await h.router.offerResume("s1");
    await h.router.startQueued();
    assert.equal(h.calls.length, quiet, "the retired planner is not resumed");

    const third = panels.build();
    t.mock.timers.tick(3_000);
    third.attach(h.paseo);
    await third.drain();
    assert.equal(third.decisionJournal.attempt(attemptId)?.state, "applied");
    assert.equal(linear.issues.size, 3, "exactly three sub-issues");
    assert.equal(linear.counters.creates, 4, "the reserved id is looked up instead of creating a fourth");
    assert.equal(linear.calls.filter((call) => call.startsWith("block ")).length, 2, "each later step is blocked by its predecessor once");
    assert.equal(linear.calls.filter((call) => call.startsWith("delegate ")).length, 3, "every sub-issue is delegated once");
    assert.equal(groups, 1, "the session is grouped once");
    assert.deepEqual((await store.get("s1"))?.group, { delegated: false });
    assert.equal((await store.get("s1"))?.review, null);
    assert.equal(h.calls.filter((call) => call.startsWith("response:Split into 3 sub-issues")).length, 1);

    // The retired planner's deny report is a confirmation.
    await writeFile(join(panels.events, "z-split-report.json"), JSON.stringify({ type: "decided", agentId: "a1", approved: false, planContent: plan, at: "2026-10-07T12:05:00.000Z" }));
    quiet = h.calls.length;
    await third.drain();
    assert.deepEqual(third.decisionJournal.attempt(attemptId)?.reports, ["z-split-report.json"]);
    assert.equal(third.decisionJournal.attempt(attemptId)?.state, "applied");
    assert.equal(h.calls.length, quiet, "the confirmation reaches nobody");
  } finally { await panels.cleanup(); }
});

test("a recovered outcome whose journal write fails keeps the session's review for the next sweep", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const plan = "# Plan\n\n1. Do the thing";
  const panels = await panelHarness(plan, { labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" }, outcome: async () => ({ approved: true, planContent: plan }) });
  const { h, store } = panels;
  try {
    const bridge = panels.build();
    bridge.attach(h.paseo);
    await bridge.drain();
    const review = await panels.seed(bridge);
    const report = bridge.decisionJournal.report.bind(bridge.decisionJournal);
    let failOnce = true;
    bridge.decisionJournal.report = async (input) => {
      if (failOnce) { failOnce = false; throw new Error("disk full"); }
      return report(input);
    };

    await h.router.settleReviews().catch(() => {});
    assert.equal((await store.get("s1"))?.review?.reviewId, review.id, "the review waits for the next sweep");
    assert.equal(bridge.decisionJournal.attempts().length, 0, "nothing was journaled");

    await h.router.settleReviews();
    const attempt = bridge.decisionJournal.attempts()[0];
    assert.deepEqual(
      { source: attempt.source, reviewId: attempt.reviewId, planContent: attempt.planContent, reports: attempt.reports },
      { source: "recovered", reviewId: review.id, planContent: plan, reports: [`recovered-${review.id}`] },
    );
    assert.equal((await store.get("s1"))?.review, null, "the review lets go once the journal has it");
    await bridge.drain();
    assert.equal(bridge.decisionJournal.attempt(attempt.id)?.state, "applied");
    assert.equal(bridge.decisionJournal.attempts(review.id).length, 1, "the outcome is applied once");
    assert.equal(panels.linear.calls.filter((call) => call.startsWith("comment ")).length, 1, "the decision is carried out once");
  } finally { await panels.cleanup(); }
});

test("a recovered outcome more than two minutes after the panel decision confirms it and is applied once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const plan = "# Plan\n\n1. Do the thing";
  const panels = await panelHarness(plan, {
    labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" },
    outcome: async () => ({ approved: true, planContent: plan }),
    decide: async () => { throw new ReviewClosedError("Plannotator did not answer in time", true); },
  });
  const { h, store } = panels;
  try {
    const bridge = panels.build();
    bridge.attach(h.paseo);
    await bridge.drain();
    const review = await panels.seed(bridge);
    await h.router.prompted("s1", { id: "p1", content: { body: "Approve plan" } });
    const attempt = bridge.decisionJournal.attempts()[0];
    assert.equal(attempt.state, "uncertain", "the lost answer leaves the attempt uncertain");
    assert.match(h.calls.at(-1) ?? "", /^response:Plannotator did not answer/, JSON.stringify(h.calls));
    assert.equal((await store.get("s1"))?.review?.reviewId, review.id, "the panel's review waits for its outcome");

    // More than the old 120 s memory window: the saved outcome still binds to this review.
    t.mock.timers.tick(130_000);
    await h.router.settleReviews();
    assert.equal(bridge.decisionJournal.attempts().length, 1, "the outcome confirms the panel's decision instead of recording a second one");
    assert.deepEqual(bridge.decisionJournal.attempt(attempt.id)?.reports, [`recovered-${review.id}`]);
    assert.equal((await store.get("s1"))?.review, null);
    await bridge.drain();
    assert.equal(bridge.decisionJournal.attempt(attempt.id)?.state, "applied");
    assert.equal(h.calls.filter((call) => call === "thought:Plan approved — starting on it.").length, 1, "the decision is carried out once");
    assert.equal(panels.linear.calls.filter((call) => call.startsWith("comment ")).length, 1, "the outcome is delivered once");
  } finally { await panels.cleanup(); }
});
