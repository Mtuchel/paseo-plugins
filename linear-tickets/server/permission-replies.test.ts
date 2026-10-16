import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { fingerprint } from "./deputy";
import { PermissionReplies, rejectedBeforeApplication, type DeliveryOrigin, type ReplyRecord } from "./permission-replies";
import { questionAnswer, questionsOf } from "./relay";
import { TECHNICAL_CONTINUATION } from "./deputy-continuation";

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
  const instances: PermissionReplies[] = [];
  t.after(async () => {
    await Promise.all(instances.map((replies) => replies.stop()));
    await rm(directory, { recursive: true, force: true });
  });
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
    instances.push(replies);
    return replies;
  };
  const replies = create();
  const intent = (intentId: string) => ({ agentId: "a", requestId: q.id, fingerprint: fingerprint(q), intentId, response, canSubmit: () => true });
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
  await h.replies.recoverEffects();
  h.pending([{ ...q, id: "q2" }]);
  const restarted = h.create();
  const replay = await restarted.deliver(h.sdk, "a", "Vitest", owner("comment:c1"));
  await restarted.recoverEffects();
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
  await h.replies.recoverEffects();
  const recorded = (await h.replies.records())["comment:evidence"];
  assert.equal(recorded.status, "applied");
  h.pending([{ ...q, id: "q2", title: "New question" }]);
  const restarted = h.create();
  const result = await restarted.deliver(h.sdk, "a", "Vitest", owner("comment:evidence"));
  await restarted.recoverEffects();
  assert.equal(result.status, "applied");
  assert.deepEqual(h.evidence, [{ request: q, response, at: recorded.at }]);
  assert.equal(h.sent.length, 1);
});

test("parallel writes on different agents preserve both records and effects", async (t) => {
  const h = await harness(t);
  h.onSubmit(async () => {});
  // Both refreshes capture Q1; the final submissions share disk writes, not the agent lane.
  await Promise.all([h.replies.deliver(h.sdk, "a", "Node", owner("comment:a")), h.replies.deliver(h.sdk, "b", "Node", owner("comment:b"))]);
  await h.replies.recoverEffects();
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

test("deputy refreshes again after asynchronous pre-submit work and rejects changed requests", async (t) => {
  const h = await harness(t);
  h.pending([{ ...q, title: "Changed" }]);
  assert.equal(await h.replies.respond(h.intent("changed")), "gone");
  assert.deepEqual(h.sent, []);
  const after = await harness(t, { beforeSubmit: async () => { after.pending([{ ...q, title: "Changed during asynchronous check" }]); } });
  assert.equal(await after.replies.respond(after.intent("after")), "gone");
  assert.deepEqual(after.sent, []);
});

test("bound permission answers reject changed command input at the final submission refresh", async (t) => {
  const permission: AgentPermissionRequest = {
    id: "permission", provider: "omp", kind: "tool", name: "bash",
    title: "Run command", input: { command: "echo safe" },
  };
  const h = await harness(t);
  h.pending([{ ...permission, input: { command: "rm important-data" } }]);
  const result = await h.replies.deliver(h.sdk, "a", "Allow displayed command",
    owner("browser:permission"), {
      requestId: permission.id, request: permission, response: { behavior: "allow" },
    });
  assert.equal(result.status, "gone");
  assert.equal(result.delivered, false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.messages, []);
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
  await h.replies.recoverEffects();
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
  await h.replies.recoverEffects();
  const at = (await h.replies.records())["session:claimed"].at;
  h.pending([{ ...q, id: "q2" }]);
  const restarted = h.create();
  await restarted.recoverEffects();
  await restarted.recoverEffects();
  assert.deepEqual(h.evidence, [{ request: q, response, at }]);
  assert.deepEqual(h.needsYou, ["i1"]);
  assert.deepEqual(h.sent.map(entry => entry.requestId), ["q1"]);
});

test("triage answers a question as scoped free text without completion or reusable owner approval evidence", async (t) => {
  const h = await harness(t);
  const instruction = "Research only: compare Node and Vitest. Do not accept either recommendation or implement changes.";
  const origin: DeliveryOrigin = { ...owner("decision:research"), intent: "triage" };
  const result = await h.replies.deliver(h.sdk, "a", instruction, origin);
  assert.equal(result.delivered, true);
  assert.deepEqual(h.sent[0].response, questionAnswer(q, instruction));
  assert.deepEqual(h.needsYou, []);
  assert.deepEqual(h.evidence, []);
  h.pending([{ ...q, id: "q2", title: "Deploy now?" }]);
  const reloaded = h.create();
  await reloaded.recoverEffects();
  await reloaded.deliver(h.sdk, "a", instruction, origin);
  assert.deepEqual(h.sent.map((sent) => sent.requestId), ["q1"]);
  assert.deepEqual(h.needsYou, []);
  assert.deepEqual(h.evidence, []);
});

test("triage cannot approve or deny a security permission, including approval-shaped owner instructions", async (t) => {
  const h = await harness(t);
  h.pending([{ id: "security", provider: "omp", name: "bash", kind: "tool", title: "Production command", input: {} }]);
  await assert.rejects(h.replies.deliver(h.sdk, "a", "Approve the recommended action", { ...owner("decision:delegate"), intent: "triage" }), /cannot answer a security permission/);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.needsYou, []);
});

test("revocation during the checked boundary's last await prevents sending and survives replay", async (t) => {
  const paused = barrier(), resume = barrier();
  const h = await harness(t, { beforeSubmit: async () => { paused.release(); await resume.promise; } });
  let valid = true;
  const pending = h.replies.respond({ ...h.intent("revoked"), canSubmit: () => valid });
  await paused.promise;
  valid = false;
  resume.release();
  assert.equal(await pending, "revoked");
  assert.deepEqual(h.sent, []);
  assert.equal(await h.create().outcome("revoked"), "revoked");
  assert.equal(await h.create().respond(h.intent("revoked")), "revoked", "a new authorization cannot replay a revoked intent");
  assert.deepEqual(h.sent, []);
  const ownerAnswer = await h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:after-revocation"));
  assert.equal(ownerAnswer.delivered, true);
  assert.deepEqual(h.sent, [{ agentId: "a", requestId: q.id, response: questionAnswer(q, "Vitest") }]);
});

test("revocation after a checked submission starts does not erase its confirmed outcome", async (t) => {
  const h = await harness(t);
  const entered = barrier(), resume = barrier();
  let valid = true;
  h.onSubmit(async () => { entered.release(); await resume.promise; });
  const pending = h.replies.respond({ ...h.intent("on-wire"), canSubmit: () => valid });
  await entered.promise;
  valid = false;
  resume.release();
  assert.equal(await pending, "applied");
  assert.equal(await h.create().outcome("on-wire"), "applied");
  assert.deepEqual(h.sent.map((item) => item.requestId), ["q1"]);
});

test("applied receipts and concurrent replays settle while evidence and Linear closing remain open", { timeout: 5_000 }, async (t) => {
  const evidenceEntered = barrier(), evidenceGate = barrier();
  const closingEntered = barrier(), closingGate = barrier();
  t.after(() => { evidenceGate.release(); closingGate.release(); });
  const h = await harness(t);
  let evidenceCalls = 0, closingCalls = 0;
  h.replies.recordEffects({
    ...h.effects,
    ownerAnswered: async (...args) => {
      evidenceCalls++;
      evidenceEntered.release();
      await evidenceGate.promise;
      await h.effects.ownerAnswered(...args);
    },
    needsYou: async (...args) => {
      closingCalls++;
      closingEntered.release();
      await closingGate.promise;
      await h.effects.needsYou(...args);
    },
  });
  const origin = owner("comment:slow-effects");
  try {
    const receipt = await h.replies.deliver(h.sdk, "a", "Node", origin);
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.delivered, true);
    await evidenceEntered.promise;
    const persisted = (await h.replies.records())[origin.ref];
    assert.equal(persisted.status, "applied");
    assert.equal(persisted.effects.evidence, false);
    h.pending([{ ...q, id: "q2" }]);
    const recovery = h.replies.recoverEffects();
    const receipts = await Promise.all([
      h.replies.recorded(origin.ref),
      h.replies.deliver(h.sdk, "a", "Vitest", origin),
    ]);
    assert.deepEqual(receipts, [receipt, receipt]);
    assert.equal(evidenceCalls, 1);
    assert.equal(closingCalls, 0);
    evidenceGate.release();
    await closingEntered.promise;
    assert.deepEqual(await h.replies.recorded(origin.ref), receipt);
    assert.equal(closingCalls, 1);
    assert.equal((await h.replies.records())[origin.ref].effects.needsYou, false);
    closingGate.release();
    await recovery;
    assert.deepEqual(h.evidence, [{ request: q, response, at: receipt.at }]);
    assert.deepEqual(h.needsYou, ["i1"]);
    assert.deepEqual(h.sent.map((entry) => entry.requestId), ["q1"]);
    assert.deepEqual((await h.replies.records())[origin.ref].effects, { evidence: true, correction: false, needsYou: true });
  } finally {
    evidenceGate.release();
    closingGate.release();
  }
});

test("shutdown drains started evidence, fences closing, and restart recovers without resubmission", { timeout: 5_000 }, async (t) => {
  const entered = barrier(), gate = barrier();
  t.after(() => gate.release());
  const h = await harness(t);
  h.replies.recordEffects({
    ...h.effects,
    ownerAnswered: async (...args) => { entered.release(); await gate.promise; await h.effects.ownerAnswered(...args); },
  });
  const origin = owner("comment:shutdown");
  try {
    const receipt = await h.replies.deliver(h.sdk, "a", "Node", origin);
    await entered.promise;
    let stopped = false;
    const stopping = h.replies.stop().then(() => { stopped = true; });
    assert.deepEqual(await h.replies.recorded(origin.ref), receipt);
    assert.equal(stopped, false, "shutdown must drain the effect already in progress");
    gate.release();
    await stopping;
    assert.deepEqual(h.needsYou, [], "no new effect may start after stop");
    const saved = (await h.replies.records())[origin.ref];
    assert.equal(saved.effects.evidence, true);
    assert.equal(saved.effects.needsYou, false);
    h.pending([{ ...q, id: "q2" }]);
    const restarted = h.create();
    await restarted.recoverEffects();
    assert.deepEqual(await restarted.deliver(h.sdk, "a", "changed", origin), receipt);
    await restarted.recoverEffects();
    assert.deepEqual(h.evidence, [{ request: q, response, at: receipt.at }]);
    assert.deepEqual(h.needsYou, ["i1"]);
    assert.deepEqual(h.sent.map((entry) => entry.requestId), ["q1"]);
  } finally { gate.release(); }
});

test("late correction receipts still wait for checked correction delivery", { timeout: 5_000 }, async (t) => {
  const entered = barrier(), gate = barrier();
  t.after(() => gate.release());
  const h = await harness(t);
  await h.replies.respond(h.intent("d1"));
  h.replies.recordEffects({
    ...h.effects,
    correctLate: async (agentId, requestId, text) => { entered.release(); await gate.promise; return h.effects.correctLate(agentId, requestId, text); },
  });
  let settled = false;
  const pending = h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:checked-correction"),
    { requestId: q.id, request: q, response: questionAnswer(q, "Vitest") }).then((result) => { settled = true; return result; });
  try {
    await entered.promise;
    assert.equal(settled, false);
    const saved = (await h.replies.records())["comment:checked-correction"];
    assert.equal(saved.status, "deputy-first");
    assert.equal(saved.correctionDelivered, undefined);
    assert.equal(settled, false, "the stored deputy-first marker is not a checked correction receipt");
    gate.release();
    const result = await pending;
    assert.equal(result.delivered, true);
    assert.match(result.reply!, /your correction/);
    assert.deepEqual(h.corrections, ["Vitest"]);
    assert.equal(h.sent.length, 1);
  } finally { gate.release(); }
});

test("restart recovery can remain in Linear closing while stored applied receipts are replayed", { timeout: 5_000 }, async (t) => {
  const entered = barrier(), gate = barrier();
  t.after(() => gate.release());
  const h = await harness(t);
  t.mock.method(console, "error", () => {});
  h.replies.recordEffects({ ...h.effects, needsYou: async () => { throw new Error("Linear offline"); } });
  const origin = owner("comment:restart-closing");
  const receipt = await h.replies.deliver(h.sdk, "a", "Node", origin);
  await h.replies.recoverEffects();
  await h.replies.stop();
  h.pending([{ ...q, id: "q2" }]);
  const restarted = h.create();
  let closingCalls = 0;
  restarted.recordEffects({
    ...h.effects,
    needsYou: async (...args) => {
      closingCalls++;
      entered.release();
      await gate.promise;
      await h.effects.needsYou(...args);
    },
  });
  const recovery = restarted.recoverEffects();
  try {
    await entered.promise;
    const anotherRecovery = restarted.recoverEffects();
    assert.deepEqual(await restarted.recorded(origin.ref), receipt);
    assert.deepEqual(await restarted.deliver(h.sdk, "a", "changed replay", origin), receipt);
    assert.equal(closingCalls, 1);
    assert.deepEqual(h.sent.map((entry) => entry.requestId), ["q1"]);
    assert.deepEqual(h.evidence, [{ request: q, response, at: receipt.at }]);
    gate.release();
    await Promise.all([recovery, anotherRecovery]);
    assert.deepEqual(h.needsYou, ["i1"]);
    assert.equal((await restarted.records())[origin.ref].effects.needsYou, true);
  } finally { gate.release(); }
});

test("shutdown during checked submission records confirmation but leaves effects for restart", async (t) => {
  const h = await harness(t);
  const entered = barrier(), gate = barrier();
  h.onSubmit(async () => { entered.release(); await gate.promise; });
  const origin = owner("comment:stop-on-wire");
  const pending = h.replies.deliver(h.sdk, "a", "Node", origin);
  await entered.promise;
  const stopping = h.replies.stop();
  gate.release();
  await assert.rejects(h.replies.deliver(h.sdk, "a", "Vitest", owner("comment:after-stop")), /plugin unloaded/);
  await assert.rejects(h.replies.respond(h.intent("after-stop")), /plugin unloaded/);
  const receipt = await pending;
  await stopping;
  assert.equal(receipt.status, "applied");
  assert.deepEqual(h.evidence, []);
  assert.deepEqual(h.needsYou, []);
  const records = await h.replies.records();
  assert.equal(records["comment:after-stop"], undefined);
  assert.equal(records["deputy:after-stop"], undefined);
  const restarted = h.create();
  await restarted.recoverEffects();
  assert.deepEqual(await restarted.recorded(origin.ref), receipt);
  assert.deepEqual(h.evidence, [{ request: q, response, at: receipt.at }]);
  assert.deepEqual(h.needsYou, ["i1"]);
  assert.deepEqual(h.sent.map((entry) => entry.requestId), ["q1"]);
});

for (const change of ["ompAsk", "answerHeader", "optionLabels", "provider", "requestId", "questions"] as const) {
  test(`checked custom instruction rejects ${change} changed at the last asynchronous submit boundary`, async t => {
    const options = [{ label: "Ship unknown release" }, { label: "Owner reviews" }];
    const request: AgentPermissionRequest = { id: "custom", provider: "omp", name: "OMP ask", kind: "question", title: "Release?",
      input: { questions: [{ header: "Response", question: "Next?", options, allowOther: true, multiSelect: false }] },
      metadata: { ompAsk: true, answerHeader: "Response", optionLabels: options.map(option => option.label) } };
    const h = await harness(t, { beforeSubmit: async () => {
      h.pending([change === "provider" ? { ...request, provider: "unknown" }
        : change === "requestId" ? { ...request, id: "new-editor" }
        : change === "questions" ? { ...request, input: { questions: [questionsOf(request)[0], null] } }
        : { ...request, metadata: { ...request.metadata, [change]: change === "ompAsk" ? false : change === "answerHeader" ? "Different" : ["Changed"] } }]);
    } });
    h.pending([request]);
    assert.equal(await h.replies.respond({ ...h.intent(`custom-${change}`), requestId: request.id, fingerprint: fingerprint(request),
      response: { behavior: "allow", updatedInput: { answers: { Response: TECHNICAL_CONTINUATION } } } }), "gone");
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.evidence, []);
    assert.deepEqual(h.needsYou, []);
  });
}
