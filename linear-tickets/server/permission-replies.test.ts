import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { fingerprint } from "./deputy";
import { PermissionReplies, rejectedBeforeApplication, type DeliveryOrigin, type ReplyRecord } from "./permission-replies";
import { questionAnswer } from "./relay";

const q: AgentPermissionRequest = { id: "q1", provider: "omp", kind: "question", name: "ask", title: "Runner?", input: { questions: [{ header: "Runner", question: "Test runner?", options: [{ label: "Node" }, { label: "Vitest" }] }] } };
const owner = (ref: string): DeliveryOrigin => ({ ref, responder: { kind: "owner", via: "linear-comment", activityId: ref, userId: "owner" }, issueId: "i1" });
const response = questionAnswer(q, "Node");
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function harness(t: TestContext, hooks: { beforeSubmit?: (record: ReplyRecord) => Promise<void>; checked?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "permission-replies-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let pending: AgentPermissionRequest[] = [q];
  let error: Error | null = null;
  let submit: (() => Promise<void>) | null = null;
  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const messages: string[] = [];
  const evidence: { request: AgentPermissionRequest; response: AgentPermissionResponse; at: string }[] = [];
  const corrections: string[] = [];
  const needsYou: string[] = [];
  const sdk = { agents: { ref: (agentId: string) => ({
    refresh: async () => ({ agent: { pendingPermissions: pending } }),
    send: async (text: string) => { messages.push(text); },
    respondToPermission: async (input: { requestId: string; response: AgentPermissionResponse }) => { sent.push({ agentId, ...input }); pending = []; },
  }) } } as unknown as PaseoApi;
  const daemon = async () => hooks.checked === false ? null : {
    respondToPermissionAndWait: async (agentId: string, requestId: string, response: AgentPermissionResponse) => {
      sent.push({ agentId, requestId, response });
      await submit?.();
      if (error) throw error;
      pending = [];
    },
  };
  const effects = {
    ownerAnswered: async (_agentId: string, request: AgentPermissionRequest, response: AgentPermissionResponse, _activity: unknown, at: string) => { evidence.push({ request, response, at }); },
    correctLate: async (_agentId: string, _requestId: string, text: string) => { corrections.push(text); return { delivered: true, reply: "The deputy had already answered this question (D-12345678); your answer went to the agent as your correction." }; },
    needsYou: async (_agentId: string, issueId?: string) => { needsYou.push(issueId ?? "agent"); },
  };
  const create = () => {
    const replies = new PermissionReplies({ directory, daemon, beforeSubmit: hooks.beforeSubmit });
    replies.attach(sdk);
    replies.recordEffects(effects);
    return replies;
  };
  const replies = create();
  const intent = (intentId: string) => ({ agentId: "a", requestId: q.id, fingerprint: fingerprint(q), intentId, response });
  return { directory, sdk, replies, create, daemon, effects, sent, messages, evidence, corrections, needsYou, intent,
    pending: (requests: AgentPermissionRequest[]) => { pending = requests; },
    fail: (failure: Error | null) => { error = failure; },
    onSubmit: (work: () => Promise<void>) => { submit = work; },
  };
}

test("simultaneous activity replays route Q1 once and never send into Q2, including after restart", async (t) => {
  const h = await harness(t);
  const gate = barrier();
  const entered = barrier();
  h.onSubmit(async () => { entered.release(); await gate.promise; });
  const first = h.replies.deliver(h.sdk, "a", "Node", owner("comment:c1"));
  await entered.promise;
  const duplicate = h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:c1"));
  gate.release();
  assert.deepEqual(await duplicate, await first);
  h.pending([{ ...q, id: "q2" }]);
  const replay = await h.create().deliver(h.sdk, "a", "Vitest", owner("comment:c1"));
  assert.equal(replay.status, "applied");
  assert.deepEqual(h.sent.map((item) => item.requestId), ["q1"]);
  assert.equal(h.evidence.length, 1);
  assert.deepEqual(h.evidence[0].response, response);
  assert.deepEqual(h.messages, []);
  assert.equal((await stat(join(h.directory, "permission-replies.json"))).mode & 0o777, 0o600);
});

test("an unbound owner starting during deputy's final pause vetoes the unsent deputy, durably", async (t) => {
  const paused = barrier(), resume = barrier();
  const h = await harness(t, { beforeSubmit: async (record) => { if (record.responder.kind === "deputy") { paused.release(); await resume.promise; } } });
  const deputy = h.replies.respond(h.intent("d1"));
  await paused.promise;
  const answer = h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:owner"));
  const duplicate = h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:owner"));
  resume.release();
  assert.equal(await deputy, "owner-first");
  assert.equal((await answer).status, "applied");
  assert.equal((await duplicate).status, "applied");
  assert.deepEqual(h.sent.map((item) => item.response), [questionAnswer(q, "Vitest")]);
  assert.equal(await h.replies.respond(h.intent("d1")), "owner-first");
  assert.equal(await h.create().outcome("d1"), "owner-first");
});

test("multipart holds veto the deputy; release allows a later intent", async (t) => {
  const h = await harness(t);
  h.replies.holdForOwner("a", "q1");
  assert.equal(await h.replies.respond(h.intent("held")), "owner-first");
  assert.deepEqual(h.sent, []);
  h.replies.releaseOwner("a", "q1");
  assert.equal(await h.replies.respond(h.intent("later")), "applied");
  assert.equal(h.sent.length, 1);
});

test("a bound owner queued behind an on-wire deputy sends a correction, not another permission", async (t) => {
  const h = await harness(t);
  const entered = barrier(), resume = barrier();
  h.onSubmit(async () => { entered.release(); await resume.promise; });
  const deputy = h.replies.respond(h.intent("d1"));
  await entered.promise;
  const answer = h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:late"), { requestId: q.id, request: q, response: questionAnswer(q, "Vitest") });
  resume.release();
  assert.equal(await deputy, "applied");
  const result = await answer;
  assert.equal(result.status, "deputy-first");
  assert.equal(result.delivered, true);
  assert.match(result.reply!, /your correction/);
  assert.deepEqual(h.corrections, ["Vitest"]);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.evidence, []);
  h.pending([{ ...q, id: "q2" }]);
  await h.create().deliver(h.sdk, "a", "changed replay text", owner("comment:late"));
  assert.deepEqual(h.corrections, ["Vitest"]);
  assert.equal(h.sent.length, 1);
});

test("same deputy intent joins its original flight and confirmed outcome survives restart", async (t) => {
  const h = await harness(t);
  const entered = barrier(), resume = barrier();
  h.onSubmit(async () => { entered.release(); await resume.promise; });
  const first = h.replies.respond(h.intent("d1"));
  await entered.promise;
  const second = h.replies.respond(h.intent("d1"));
  resume.release();
  assert.deepEqual(await Promise.all([first, second]), ["applied", "applied"]);
  assert.equal(h.sent.length, 1);
  assert.equal(await h.create().outcome("d1"), "applied");
});

test("reserved and submitted records after interruption never reroute or send", async (t) => {
  for (const status of ["reserved", "submitted"] as const) {
    const h = await harness(t);
    const origin = owner(`comment:${status}`);
    const record: ReplyRecord = { ref: origin.ref, responder: origin.responder, agentId: "a", kind: "answer", text: "Node", at: new Date().toISOString(), status, effects: { evidence: false, correction: false, needsYou: false } };
    await writeFile(join(h.directory, "permission-replies.json"), JSON.stringify({ [record.ref]: record, "deputy:d1": { ...record, ref: "deputy:d1", responder: { kind: "deputy", intentId: "d1" } } }));
    const result = await h.create().deliver(h.sdk, "a", "Node", origin);
    assert.equal(result.status, "unconfirmed");
    assert.equal(result.delivered, false);
    assert.equal(await h.create().outcome("d1"), null);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.messages, []);
  }
});

test("post-send effects replay original request, answers and timestamp without another submission", async (t) => {
  const h = await harness(t);
  h.replies.recordEffects({ ...h.effects, ownerAnswered: async () => { throw new Error("evidence storage offline"); } });
  assert.equal((await h.replies.deliver(h.sdk, "a", "Node", owner("comment:evidence"))).status, "applied");
  const recorded = (await h.replies.records())["comment:evidence"];
  assert.equal(recorded.status, "applied");
  h.pending([{ ...q, id: "q2", title: "New question" }]);
  const result = await h.create().deliver(h.sdk, "a", "Vitest", owner("comment:evidence"));
  assert.equal(result.status, "applied");
  assert.deepEqual(h.evidence, [{ request: q, response, at: recorded.at }]);
  assert.equal(h.sent.length, 1);
});

test("parallel writes on different agents preserve both records and effects", async (t) => {
  const h = await harness(t);
  h.onSubmit(async () => {});
  // Both refreshes capture Q1; the final submissions share disk writes, not the agent lane.
  await Promise.all([h.replies.deliver(h.sdk, "a", "Node", owner("comment:a")), h.replies.deliver(h.sdk, "b", "Node", owner("comment:b"))]);
  const records = await h.replies.records();
  assert.equal(records["comment:a"].agentId, "a");
  assert.equal(records["comment:b"].agentId, "b");
});

test("only exact daemon pre-application errors count as rejection", async (t) => {
  for (const text of ["A response to this permission request is already being submitted", "No pending permission request with id 'q1'", "No pending Codex app-server permission request with id 'q1'"]) {
    assert.equal(rejectedBeforeApplication(new Error(text), "q1"), true);
    assert.equal(rejectedBeforeApplication(new Error(`Request failed: ${text} requestType=agent_permission_response code=handler_error`), "q1"), true);
    const h = await harness(t);
    h.fail(new Error(`Request failed: ${text} requestType=agent_permission_response code=handler_error`));
    const result = await h.replies.deliver(h.sdk, "a", "Node", owner(`comment:${text}`));
    assert.equal(result.status, "rejected");
    assert.match(result.reply!, /not delivered/);
    assert.deepEqual(h.evidence, []);
    assert.deepEqual(h.needsYou, []);
  }
  assert.equal(rejectedBeforeApplication(new Error("No pending permission request with id 'q2'"), "q1"), false);
  assert.equal(rejectedBeforeApplication(new Error("permission failed after No pending permission request with id 'q1'"), "q1"), false);
});

test("lost acknowledgement, unknown and post-application errors remain unconfirmed and never resent", async (t) => {
  for (const reason of ["Timeout waiting for message (60000ms)", "socket closed", "could not persist applied agent snapshot"]) {
    const h = await harness(t);
    h.fail(new Error(reason));
    const result = await h.replies.deliver(h.sdk, "a", "Node", owner(`comment:${reason}`));
    assert.equal(result.status, "unconfirmed");
    assert.equal(result.delivered, false);
    assert.match(result.reply!, /It is not sent again/);
    h.pending([{ ...q, id: "q2" }]);
    await h.create().deliver(h.sdk, "a", "Node", owner(`comment:${reason}`));
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.evidence, []);
    assert.deepEqual(h.needsYou, []);
  }
});

test("fingerprint prevents changed request content, but cannot prevent changes after last refresh", async (t) => {
  const h = await harness(t);
  h.pending([{ ...q, title: "Changed" }]);
  assert.equal(await h.replies.respond(h.intent("changed")), "gone");
  assert.deepEqual(h.sent, []);
  const after = await harness(t, { beforeSubmit: async () => { after.pending([{ ...q, title: "Changed after refresh" }]); } });
  assert.equal(await after.replies.respond(after.intent("after")), "applied");
  assert.equal(after.sent.length, 1);
  assert.equal((await after.replies.records())["deputy:after"].fingerprint, fingerprint(q));
});

test("stop fences paused and queued submissions including unchecked fallback", async (t) => {
  for (const checked of [true, false]) {
    const entered = barrier(), resume = barrier();
    const h = await harness(t, { checked, beforeSubmit: async () => { entered.release(); await resume.promise; } });
    const pending = h.replies.deliver(h.sdk, "a", "Node", owner(`comment:stop-${checked}`));
    await entered.promise;
    h.replies.stop();
    resume.release();
    assert.equal((await pending).status, "unconfirmed");
    assert.deepEqual(h.sent, []);
    assert.equal(await h.replies.available(), null);
  }
});

test("unchecked and unverified answers retain precedence/replay protection but no owner identity", async (t) => {
  const unchecked = await harness(t, { checked: false });
  assert.equal((await unchecked.replies.deliver(unchecked.sdk, "a", "Node", owner("comment:unchecked"))).status, "unchecked");
  await unchecked.create().deliver(unchecked.sdk, "a", "Node", owner("comment:unchecked"));
  assert.equal(unchecked.sent.length, 1);
  assert.deepEqual(unchecked.evidence, []);
  assert.equal(await unchecked.replies.available(), null);
  const h = await harness(t);
  const result = await h.replies.deliver(h.sdk, "a", "Node", { ref: "activation:forwarded", responder: { kind: "linear-unverified", via: "activation", ref: "activation:forwarded" } });
  assert.equal(result.status, "applied");
  assert.deepEqual(h.evidence, []);
  assert.deepEqual(h.needsYou, ["agent"]);
});

test("approval and plain-message replays never become answers to newer questions", async (t) => {
  for (const kind of ["approval", "message"] as const) {
    const h = await harness(t);
    h.pending(kind === "approval" ? [{ ...q, kind: "tool", title: "Read file?" }] : []);
    const origin = owner(`comment:${kind}`);
    const result = await h.replies.deliver(h.sdk, "a", kind === "approval" ? "approve" : "Continue", origin);
    assert.equal(result.status, "sent");
    h.pending([{ ...q, id: "q2" }]);
    await h.create().deliver(h.sdk, "a", "Vitest", origin);
    assert.equal(h.sent.length, kind === "approval" ? 1 : 0);
    assert.deepEqual(h.messages, kind === "message" ? ["Continue"] : []);
    assert.deepEqual(h.evidence, []);
  }
});

test("overlapping failed owners release all counters so a later deputy can send", async (t) => {
  const h = await harness(t);
  h.fail(new Error("No pending permission request with id 'q1'"));
  const results = await Promise.all([h.replies.deliver(h.sdk, "a", "Node", owner("comment:a")), h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:b"))]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  const records = JSON.parse(await readFile(join(h.directory, "permission-replies.json"), "utf8"));
  assert.equal(records["comment:a"].status, "rejected");
  h.fail(null);
  assert.equal(await h.replies.respond(h.intent("later")), "applied");
});

test("admission of an old replay does not veto a deputy answering a newer request", async (t) => {
  const paused = barrier(), resume = barrier();
  const h = await harness(t, { beforeSubmit: async record => { if (record.responder.kind === "deputy") { paused.release(); await resume.promise; } } });
  await h.replies.deliver(h.sdk, "a", "Node", owner("comment:old"));
  const newer = { ...q, id: "q2" };
  h.pending([newer]);
  const deputy = h.replies.respond({ ...h.intent("new"), requestId: newer.id, fingerprint: fingerprint(newer) });
  await paused.promise;
  const replay = h.replies.deliver(h.sdk, "a", "obsolete", owner("comment:old"));
  resume.release();
  assert.equal((await replay).status, "applied");
  assert.equal(await deputy, "applied");
  assert.deepEqual(h.sent.map(entry => entry.requestId), ["q1", "q2"]);
});

test("restart recovers unfinished confirmed effects without a caller replay or new submission", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = await harness(t);
  h.replies.recordEffects({ ...h.effects, ownerAnswered: async () => { throw new Error("evidence offline"); }, needsYou: async () => { throw new Error("Linear offline"); } });
  await h.replies.deliver(h.sdk, "a", "Node", owner("session:claimed"));
  const at = (await h.replies.records())["session:claimed"].at;
  h.pending([{ ...q, id: "q2" }]);
  const restarted = h.create();
  await restarted.recoverEffects();
  await restarted.recoverEffects();
  assert.deepEqual(h.evidence, [{ request: q, response, at }]);
  assert.deepEqual(h.needsYou, ["i1"]);
  assert.deepEqual(h.sent.map(entry => entry.requestId), ["q1"]);
});
