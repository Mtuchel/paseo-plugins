import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { OwnerAsk } from "../shared/contracts";
import type { BrowserDecisionAction, DecisionHost, StewardFlow } from "../shared/decision-inbox";
import { BrowserDecisionInbox, type BrowserDecisionInboxDeps } from "./decision-inbox";
import { PermissionReplies } from "./permission-replies";
import { INBOX_DISPLAYED_HEADER } from "./inbox-transport";

const PEER_BACKEND = "d1fdc181-dbf0-4ee4-b792-de58e7695484";
const LOCAL_BACKEND = "96b93fd3-9ef6-40d7-875d-7b8a9b35f6b8";

const question: AgentPermissionRequest = {
  id: "q1", provider: "omp", name: "ask", kind: "question", title: "Runner?",
  input: { questions: [
    { header: "Runner", question: "Test runner?", options: [{ label: "Node", description: "Built in" }, { label: "Vitest", description: "External" }], multiSelect: false },
    { header: "Comment", question: "Optional comment", options: [], allowEmpty: true },
  ] },
};
const permission: AgentPermissionRequest = {
  id: "p1", provider: "omp", name: "bash", kind: "tool", title: "Production command",
  description: "Approve the exact command only.", input: { command: "deploy staging" },
  actions: [{ id: "allow-once", label: "Run once", behavior: "allow" }, { id: "reject-original", label: "Reject", behavior: "deny" }],
};
const ownerAsk: OwnerAsk = {
  issueId: "i1", revision: "owner-r1", attention: "owner", attentionReason: "Owner decision", blockerIdentifier: null,
  disposition: null, deferredUntil: null, identifier: "TUC-1", title: "Choose runner", url: "https://linear.app/test/issue/TUC-1",
  parentIdentifier: null, ticketIdentifier: "TUC-1", kind: "decision", summary: "Choose runner",
  questions: [{ key: "q1", question: "Runner?", options: [{ label: "Node", description: "Built in" }], multiSelect: false }],
  source: "Runner?", route: "agent", agentId: "a", mirrorsLiveRequest: false, extracted: true, updatedAt: "2026-10-12T00:00:00.000Z",
};
type Agent = { id: string; title: string; status: string; labels: Record<string, string>; archivedAt?: string | null; pendingPermissions: AgentPermissionRequest[] };
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function harness(t: TestContext, host = "laptop", asks: OwnerAsk[] = [ownerAsk]) {
  const directory = await mkdtemp(join(tmpdir(), "decision-inbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-10-12T00:00:00.000Z");
  let canonical: string | null = null;
  let peers: string[] = [];
  let ownerReads = 0;
  let ownerRead: (() => Promise<void>) | undefined;
  let submit: ((requestId: string, response: AgentPermissionResponse) => Promise<void>) | undefined;
  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const ownerActions: { operation: string; input: unknown }[] = [];
  const listCalls: (string | undefined)[] = [];
  let flowDep: (() => Promise<StewardFlow>) | undefined;
  let flowReads = 0;
  const agents: Agent[] = [{ id: "a", title: "Standalone", status: "idle", labels: {}, pendingPermissions: [structuredClone(question)] }];
  let pages: Agent[][] | null = null;
  const sdk = { agents: {
    list: async (input: { page: { cursor?: string }; filter: { includeArchived: boolean } }) => {
      assert.equal(input.filter.includeArchived, false);
      listCalls.push(input.page.cursor);
      const index = input.page.cursor ? Number(input.page.cursor) : 0;
      const entries = (pages ? pages[index] : agents).map((agent) => ({ agent }));
      const hasMore = pages !== null && index + 1 < pages.length;
      return { entries, pageInfo: { hasMore, nextCursor: hasMore ? String(index + 1) : null } };
    },
    ref: (id: string) => ({
      refresh: async () => { const agent = agents.find((item) => item.id === id); return agent ? { agent } : null; },
      send: async () => { throw new Error("A browser action must never route an unbound message."); },
      respondToPermission: async () => { throw new Error("A browser action must use checked delivery."); },
    }),
  } } as unknown as PaseoApi;
  const daemon = async () => ({ respondToPermissionAndWait: async (agentId: string, requestId: string, response: AgentPermissionResponse) => {
    sent.push({ agentId, requestId, response });
    if (submit) await submit(requestId, response);
    else agents.find((agent) => agent.id === agentId)!.pendingPermissions = agents.find((agent) => agent.id === agentId)!.pendingPermissions.filter((request) => request.id !== requestId);
  } });
  const ownerAsks: BrowserDecisionInboxDeps["ownerAsks"] = {
    snapshot: async () => { ownerReads++; await ownerRead?.(); return { asks, history: [], updatedAt: new Date(now).toISOString() }; },
    answer: async (input) => { ownerActions.push({ operation: "answer", input }); return { delivered: "agent", message: "Owner ask answered." }; },
    triage: async (input) => { ownerActions.push({ operation: "triage", input }); return { delivered: "local", message: "Owner ask deferred." }; },
  };
  const create = (backendInstanceId?: () => string | undefined) => {
    const replies = new PermissionReplies({ directory: join(directory, "replies"), daemon, now: () => now });
    replies.attach(sdk);
    const inbox = new BrowserDecisionInbox({ ownerAsks, paseo: () => sdk, replies, peers: async () => peers,
      canonicalPeer: async () => canonical, host, backendInstanceId, agentUrl: async (id) => `https://paseo.test/agents/${id}`,
      directory: join(directory, "inbox"), now: () => now,
      // Only a test that asks for a steward flow gets the dependency: a host without one answers
      // `flow: null` like a host that never ran the steward, and the other tests keep it that way.
      ...(flowDep ? { flow: () => { flowReads++; return flowDep!(); } } : {}) });
    return { inbox, replies };
  };
  const { inbox, replies } = create();
  const post = async (input: unknown, selected = inbox, headers: Record<string, string> = {}) => {
    const response = await selected.route({ method: "POST", path: "/api/decisions/action", body: JSON.stringify(input),
      headers: { host: "laptop.test:8444", origin: "https://laptop.test:8444", "content-type": "application/json", "x-review-action": "1", ...headers } });
    assert.ok(response);
    return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const action = async (requestId = "q1", selected = inbox): Promise<BrowserDecisionAction> => {
    const snapshot = await selected.local();
    const live = snapshot.live.find((item) => item.requestId === requestId);
    assert.ok(live);
    return { host: snapshot.host, ...(snapshot.backendInstanceId ? { backendInstanceId: snapshot.backendInstanceId } : {}), target: "live", operation: "answer", agentId: live.agentId, requestId, revision: live.revision, answers: { Runner: "Node" } };
  };
  return { inbox, replies, sdk, directory, sent, agents, ownerActions, listCalls, create, post, action,
    clock: (value: number) => { now = value; }, now: () => now,
    canonical: (value: string | null) => { canonical = value; }, peers: (values: string[]) => { peers = values; },
    pages: (values: Agent[][]) => { pages = values; }, ownerReads: () => ownerReads,
    onOwnerRead: (work: () => Promise<void>) => { ownerRead = work; }, onSubmit: (work: typeof submit) => { submit = work; },
    flow: (work: () => Promise<StewardFlow>) => { flowDep = work; }, flowReads: () => flowReads,
  };
}
function peerSnapshot(host = "server087"): DecisionHost {
  return { host, backendInstanceId: PEER_BACKEND, asks: [ownerAsk], live: [], history: [], updatedAt: "2026-10-12T00:00:00.000Z", error: null, flow: null };
}
function mockPeers(t: TestContext, answer: (url: string, method: string, body: unknown, headers: Headers) => Promise<Response> | Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    return answer(url, method, body, new Headers(init?.headers));
  });
  return calls;
}

test("local inbox pages standalone and child agents, preserving exact questions and permission detail", async (t) => {
  const h = await harness(t);
  const child: Agent = { id: "child", title: "Child", status: "idle", labels: { "paseo.parent-agent-id": "a" }, pendingPermissions: [{ ...permission, detail: { type: "shell", command: "rm -rf /production", filePath: "/production" } } as AgentPermissionRequest] };
  const plan: Agent = { id: "plan", title: "Plan", status: "idle", labels: {}, pendingPermissions: [{ id: "plan-request", provider: "omp", kind: "plan", name: "plan" }] };
  h.agents.push(child, plan);
  h.pages([[h.agents[0]], [child, plan]]);
  const snapshot = await h.inbox.local();
  assert.deepEqual(snapshot.live.map((live) => live.agentId), ["a", "child", "plan"]);
  assert.match(snapshot.live[1].source, /rm -rf \/production/);
  assert.match(snapshot.live[1].source, /"filePath": "\/production"/);
  assert.match(snapshot.live[1].source, /deploy staging/);
  assert.deepEqual(snapshot.live[1].actions, permission.actions?.map(({ id, label, behavior }) => ({ id, label, behavior })));
  assert.deepEqual(snapshot.live[2].actions, [{ id: "reject", label: "Deny", behavior: "deny" }, { id: "accept", label: "Implement", behavior: "allow" }]);
});

test("changed permission input, actions and metadata invalidate the full live revision", async (t) => {
  const h = await harness(t);
  for (const change of [
    (request: AgentPermissionRequest) => { request.input = { command: "deploy production" }; },
    (request: AgentPermissionRequest) => { request.actions = [{ id: "allow-once", label: "Allow permanently", behavior: "allow" }]; },
    (request: AgentPermissionRequest) => { request.metadata = { target: "production" }; },
  ]) {
    h.agents[0].pendingPermissions = [structuredClone(permission)];
    const old = await h.action("p1");
    change(h.agents[0].pendingPermissions[0]);
    const current = (await h.inbox.local()).live[0];
    assert.notEqual(current.revision, old.revision);
    const result = await h.post({ ...old, answers: undefined, actionId: "allow-once", behavior: "allow" });
    assert.equal(result.status, 409);
    assert.match(String(result.body.error), /changed/);
  }
  assert.deepEqual(h.sent, []);
});

test("cross-site mutations and unknown payload fields are rejected without delivery", async (t) => {
  const h = await harness(t);
  const input = await h.action();
  const badHeaders: Record<string, string>[] = [
    { origin: "https://attacker.test" }, { origin: "null" }, { origin: "https://laptop.test:443" },
    { "x-review-action": "0" }, { "content-type": "text/plain" },
  ];
  for (const headers of badHeaders) {
    assert.equal((await h.post(input, h.inbox, headers)).status, 403);
  }
  assert.equal((await h.post({ ...input, remoteUrl: "https://attacker.test" })).status, 400);
  assert.deepEqual(h.sent, []);
});

test("unknown hosts cannot cause a POST or an arbitrary URL fetch", async (t) => {
  const h = await harness(t);
  h.peers(["https://server087.test:8444"]);
  const calls = mockPeers(t, () => Response.json(peerSnapshot()));
  const result = await h.post({ ...await h.action(), host: "https://attacker.test" });
  assert.equal(result.status, 404);
  assert.deepEqual(calls, [{ url: "https://server087.test:8444/api/decisions/local", method: "GET", body: null }]);
  assert.deepEqual(h.sent, []);
});

test("confirmed exact retries survive newer question rounds and restart without a second submission", async (t) => {
  const h = await harness(t);
  const input = await h.action();
  const gate = barrier(), entered = barrier();
  h.onSubmit(async () => { entered.release(); await gate.promise; h.agents[0].pendingPermissions = [{ ...question, id: "q2", title: "Next round" }]; });
  const first = h.post(input);
  await entered.promise;
  const duplicate = h.post(input);
  gate.release();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.equal(one.status, 200);
  assert.deepEqual(two, one);
  assert.deepEqual(await h.post(input, h.create().inbox), one);
  assert.deepEqual(h.sent, [{ agentId: "a", requestId: "q1", response: { behavior: "allow", updatedInput: { answers: { Runner: "Node", Comment: "" } } } }]);
  assert.equal((await h.inbox.local()).live[0].requestId, "q2");
  assert.equal((await h.post({ ...input, answers: { Runner: "Vitest" } })).status, 409);
  const records = Object.values(await h.replies.records());
  assert.equal(records[0].responder.kind, "owner");
  assert.equal(records[0].status, "applied");
});

test("a lost checked acknowledgement remains explicit and is never resent into the next question", async (t) => {
  const h = await harness(t);
  const input = await h.action();
  h.onSubmit(async () => { h.agents[0].pendingPermissions = [{ ...question, id: "q2" }]; throw new Error("socket closed after application"); });
  const first = await h.post(input);
  assert.equal(first.status, 502);
  assert.equal(first.body.outcomeUnknown, true);
  assert.match(String(first.body.error), /not sent again/i);
  assert.deepEqual(await h.post(input, h.create().inbox), first);
  assert.equal(h.sent.length, 1);
  assert.equal(h.agents[0].pendingPermissions[0].id, "q2");
});

test("multipart answers require every field, reject unknown keys and preserve optional empty answers", async (t) => {
  const h = await harness(t);
  h.agents[0].pendingPermissions = [{ ...question, input: { questions: [
    ...(question.input!.questions as unknown[]), { header: "Scope", question: "Scope?", options: [] },
  ] } }];
  const input = await h.action();
  assert.equal((await h.post(input)).status, 400);
  assert.equal((await h.post({ ...input, answers: { Runner: "Node", Scope: "Tests only", stranger: "bad" } })).status, 400);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.post({ ...input, answers: { Runner: "node", Scope: "Tests only" } })).status, 200);
  assert.deepEqual(h.sent[0].response, { behavior: "allow", updatedInput: { answers: { Runner: "Node", Comment: "", Scope: "Tests only" } } });
});

test("optional comment answers are delivered without being dropped or appended to another question", async (t) => {
  const h = await harness(t);
  const input = await h.action();
  assert.equal((await h.post({ ...input, answers: { Runner: "Node", Comment: "Staging only; do not deploy production." } })).status, 200);
  assert.deepEqual(h.sent[0].response, {
    behavior: "allow", updatedInput: { answers: { Runner: "Node", Comment: "Staging only; do not deploy production." } },
  });
});

test("OMP select rounds submit one original option then expose the next provider question", async (t) => {
  const h = await harness(t);
  const round: AgentPermissionRequest = { ...question, metadata: { extensionUiMethod: "select" }, input: { questions: [{ header: "Select", question: "(1 selected) Colors?", multiSelect: false, options: [{ label: "Blue" }, { label: "Green" }, { label: "Other" }, { label: " Done selecting" }] }] } };
  h.agents[0].pendingPermissions = [round];
  const input = await h.action();
  assert.equal((await h.post({ ...input, answers: { Select: "Blue, Green" } })).status, 400);
  h.onSubmit(async () => { h.agents[0].pendingPermissions = [{ ...question, id: "editor", metadata: { extensionUiMethod: "editor" }, input: { questions: [{ header: "Response", question: "Other color?", options: [] }] } }]; });
  assert.equal((await h.post({ ...input, answers: { Select: "Other" } })).status, 200);
  assert.deepEqual(h.sent[0].response, { behavior: "allow", updatedInput: { answers: { Select: "Other" } } });
  const next = (await h.inbox.local()).live[0];
  assert.equal(next.requestId, "editor");
});

test("permissions require the exact original action and reject research or delegate", async (t) => {
  const h = await harness(t);
  h.agents[0].pendingPermissions = [structuredClone(permission)];
  const input = { ...await h.action("p1"), answers: undefined };
  assert.equal((await h.post({ ...input, actionId: "invented", behavior: "allow" })).status, 400);
  assert.equal((await h.post({ ...input, actionId: "allow-once", behavior: "deny" })).status, 400);
  for (const action of ["research", "delegate"]) {
    assert.equal((await h.post({ ...input, operation: "triage", action, note: "Read evidence only" })).status, 400);
  }
  assert.equal(h.sent.length, 0);
  assert.equal((await h.post({ ...input, actionId: "reject-original", behavior: "deny", note: "Wrong target" })).status, 200);
  assert.deepEqual(h.sent[0].response, { behavior: "deny", selectedActionId: "reject-original", message: "Wrong target" });
  h.agents[0].pendingPermissions = [{ ...permission, id: "fallback", actions: undefined }];
  const fallback = { ...await h.action("fallback"), answers: undefined, actionId: "accept", behavior: "allow" };
  assert.equal((await h.post(fallback)).status, 200);
  assert.deepEqual(h.sent[1].response, { behavior: "allow", selectedActionId: "accept" });
});

test("research and delegation require scope, preserve multipart shape, and do not trigger answer effects", async (t) => {
  const h = await harness(t);
  const effects: string[] = [];
  h.replies.recordEffects({ ownerAnswered: async () => { effects.push("answered"); }, correctLate: async () => { effects.push("corrected"); return { delivered: true, reply: "corrected" }; }, needsYou: async () => { effects.push("closed"); } });
  const input = { ...await h.action(), answers: undefined, operation: "triage" as const };
  assert.equal((await h.post({ ...input, action: "research", note: " " })).status, 400);
  assert.equal((await h.post({ ...input, action: "research", note: "Compare runner compatibility" })).status, 200);
  const researchResponse = h.sent[0].response;
  assert.equal(researchResponse.behavior, "allow");
  if (researchResponse.behavior !== "allow") throw new Error("Expected question response");
  assert.ok(researchResponse.updatedInput);
  const researchAnswers = researchResponse.updatedInput.answers as Record<string, string>;
  assert.match(researchAnswers.Runner, /Research only.*Do not implement/s);
  assert.equal(researchAnswers.Comment, "");
  assert.deepEqual(effects, []);
  assert.equal(Object.values(await h.replies.records())[0].intent, "triage");
  h.agents[0].pendingPermissions = [{ ...question, id: "delegate-round" }];
  const delegation = { ...await h.action("delegate-round"), answers: undefined, operation: "triage", action: "delegate", note: "Implement tests for the already approved module" };
  assert.equal((await h.post(delegation)).status, 200);
  assert.match(Object.values(await h.replies.records()).find((record) => record.requestId === "delegate-round")!.text, /Do not decide business policy, permissions, spending, destructive or production actions/);
  assert.deepEqual(effects, []);
});

test("canonical peer failure is visible and never reads local Linear asks", async (t) => {
  const h = await harness(t);
  const peer = "https://server087.test:8444";
  h.canonical(peer); h.peers([peer]);
  const calls = mockPeers(t, () => { throw new Error("connection refused"); });
  const view = await h.inbox.view();
  assert.equal(view.canonicalHost, null);
  assert.deepEqual(view.unreachable, [peer]);
  assert.equal(h.ownerReads(), 0);
  assert.deepEqual(view.hosts.map((host) => host.asks), [[], []]);
  assert.match(view.hosts[0].error!, /Canonical owner asks unavailable/);
  assert.match(view.hosts[1].error!, /connection refused/);
  assert.equal(view.hosts[0].live[0].requestId, "q1");
  assert.deepEqual(calls.map((call) => call.url), [`${peer}/api/decisions/local`]);
  const localRoute = await h.inbox.route({ method: "GET", path: "/api/decisions/local", headers: {}, body: "" });
  assert.ok(localRoute);
  assert.equal((JSON.parse(localRoute.body) as DecisionHost).host, "laptop");
  assert.equal(calls.length, 1);
  assert.equal((await h.post({ host: "laptop", target: "owner", operation: "answer", issueId: "i1", revision: "owner-r1", answers: { q1: "Node" } })).status, 409);
  assert.deepEqual(h.ownerActions, []);
});

test("aggregation uses returned canonical identity and retains live sources without duplicate owner asks", async (t) => {
  const h = await harness(t);
  const canonical = "https://server087.test:8444", other = "https://other.test:8444";
  h.canonical(canonical); h.peers([canonical, other]);
  const calls = mockPeers(t, (url) => Response.json(peerSnapshot(url.startsWith(canonical) ? "actual-server-name" : "other-host")));
  const view = await h.inbox.view();
  assert.equal(view.canonicalHost, "actual-server-name");
  assert.deepEqual(view.hosts.map((host) => host.asks.map((ask) => ask.issueId)), [[], ["i1"], []]);
  assert.deepEqual(view.unreachable, []);
  assert.equal(h.ownerReads(), 0);
  assert.ok(calls.every((call) => call.url.endsWith("/api/decisions/local")));
});

test("malformed peer schema is an unavailable source rather than a partial successful snapshot", async (t) => {
  const h = await harness(t);
  const peer = "https://server087.test:8444";
  h.canonical(peer); h.peers([peer]);
  mockPeers(t, () => Response.json({ ...peerSnapshot(), asks: [{ ...ownerAsk, untrustedExtra: "silently stripped otherwise" }] }));
  const view = await h.inbox.view();
  assert.equal(view.canonicalHost, null);
  assert.match(view.hosts[1].error!, /invalid decision snapshot/);
  assert.equal(h.ownerReads(), 0);
  assert.deepEqual(view.hosts[1].asks, []);
});

test("forwarding selects only the configured origin and exposes an unknown outcome without automatic retry", async (t) => {
  const h = await harness(t);
  const peer = "https://server087.test:8444";
  h.peers([peer]);
  const calls = mockPeers(t, (url, method, _body, headers) => {
    assert.ok(url.startsWith(`${peer}/api/decisions/`));
    if (method === "GET") return Response.json(peerSnapshot());
    assert.equal(headers.get(INBOX_DISPLAYED_HEADER), PEER_BACKEND);
    throw new Error("peer socket closed after submission");
  });
  const result = await h.post({ ...await h.action(), host: "server087", backendInstanceId: PEER_BACKEND });
  assert.equal(result.status, 502);
  assert.equal(result.body.outcomeUnknown, true);
  assert.match(String(result.body.error), /not retried automatically/);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
  assert.equal(calls[1].url, `${peer}/api/decisions/action`);
  assert.deepEqual(h.sent, []);
});

test("live deferrals survive restart, expire, ignore changed revisions and never answer or restart", async (t) => {
  const h = await harness(t);
  const input = { ...await h.action(), answers: undefined, operation: "triage", action: "defer", until: new Date(h.now() + 60_000).toISOString() };
  assert.equal((await h.post(input)).status, 200);
  const recreated = h.create().inbox;
  assert.equal((await recreated.local()).live[0].deferredUntil, input.until);
  h.agents[0].pendingPermissions[0] = { ...question, description: "Changed round under the same request ID" };
  assert.equal((await recreated.local()).live[0].deferredUntil, null);
  h.agents[0].pendingPermissions = [structuredClone(question)];
  h.clock(h.now() + 60_000);
  const expired = await recreated.local();
  assert.equal(expired.live[0].deferredUntil, null);
  assert.equal(expired.history[0].action, "defer");
  assert.equal(expired.history[0].delivery, "local");
  assert.equal((await h.post({ ...input, until: new Date(h.now() - 1).toISOString() })).status, 400);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(await h.replies.records(), {});
  assert.equal((await stat(join(h.directory, "inbox"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(h.directory, "inbox", "live-deferrals.json"))).mode & 0o777, 0o600);
});

test("reopen clears only the matching live deferral and keeps the local action history", async (t) => {
  const h = await harness(t);
  const input = { ...await h.action(), answers: undefined, operation: "triage", action: "defer", until: new Date(h.now() + 60_000).toISOString() };
  assert.equal((await h.post(input)).status, 200);
  assert.equal((await h.post({ ...input, action: "reopen", until: undefined })).status, 200);
  const snapshot = await h.inbox.local();
  assert.equal(snapshot.live[0].deferredUntil, null);
  assert.deepEqual(snapshot.history.map((receipt) => receipt.action), ["reopen", "defer"]);
  assert.deepEqual(h.sent, []);
});

test("owner reads share their collection while live questions stay fresh and explicit refresh recollects", async (t) => {
  const h = await harness(t);
  const gate = barrier();
  h.onOwnerRead(() => gate.promise);
  const one = h.inbox.local(), two = h.inbox.local();
  gate.release();
  const snapshots = await Promise.all([one, two]);
  assert.equal(h.ownerReads(), 1);
  const checkedAt = snapshots[0].updatedAt;
  h.clock(h.now() + 30_000);
  h.agents[0].pendingPermissions = [{ ...question, id: "q2" }];
  const refreshed = await h.inbox.local();
  assert.equal(refreshed.live[0].requestId, "q2");
  assert.equal(refreshed.updatedAt, checkedAt);
  assert.equal(h.ownerReads(), 1);
  await h.inbox.refresh();
  assert.notEqual((await h.inbox.local()).updatedAt, checkedAt);
  assert.equal(h.ownerReads(), 2);
});

test("a slow canonical owner scan does not disconnect peer questions or checked answer delivery", async t => {
  const server = await harness(t, "server087");
  const local = await harness(t);
  const serverInbox = server.create(() => PEER_BACKEND).inbox;
  await serverInbox.view();
  const input = await server.action("q1", serverInbox);
  const entered = barrier(), release = barrier();
  server.onOwnerRead(async () => { entered.release(); await release.promise; });
  const collecting = serverInbox.refresh();
  await entered.promise;
  local.canonical("https://server.test:8444");
  local.peers(["https://server.test:8444"]);
  mockPeers(t, async (url, method, body, headers) => {
    const target = new URL(url);
    const result = await serverInbox.route({ method, path: target.pathname,
      headers: { host: target.host, "content-type": "application/json", "x-review-action": headers.get("x-review-action") ?? "" },
      body: body === null ? "" : JSON.stringify(body) });
    assert.ok(result);
    return new Response(result.body, { status: result.status, headers: result.headers });
  });
  try {
    await local.inbox.refresh();
    const view = await local.inbox.view();
    assert.equal(view.canonicalHost, "server087");
    assert.deepEqual(view.unreachable, []);
    assert.equal(view.hosts.find(host => host.host === "server087")?.live[0].requestId, "q1");
    const result = await local.post(input);
    assert.equal(result.status, 200);
    assert.equal(result.body.delivered, "agent");
    assert.deepEqual(server.sent.map(item => item.requestId), ["q1"]);
  } finally {
    release.release();
    await collecting;
  }
});

test("transport refresh updates live questions without repeating the fifteen-minute owner scan", async t => {
  const h = await harness(t);
  await h.inbox.view();
  h.agents[0].pendingPermissions = [{ ...question, id: "q2" }];
  // Past the transport window and the memory's stale window: a read inside either answers from the
  // snapshot it already has while its replacement collects behind it.
  h.clock(h.now() + 121_000);
  const view = await h.inbox.view();
  assert.equal(view.hosts[0].live[0].requestId, "q2");
  assert.equal(h.ownerReads(), 1);
});

test("a recovered canonical peer becomes reachable on the next transport refresh", async t => {
  const h = await harness(t);
  const peer = "https://server.test:8444";
  h.canonical(peer); h.peers([peer]);
  let reachable = false;
  mockPeers(t, () => {
    if (!reachable) throw new Error("connection refused");
    return Response.json(peerSnapshot());
  });
  assert.deepEqual((await h.inbox.view()).unreachable, [peer]);
  reachable = true;
  h.clock(h.now() + 121_000);
  const recovered = await h.inbox.view();
  assert.equal(recovered.canonicalHost, "server087");
  assert.deepEqual(recovered.unreachable, []);
  assert.deepEqual(recovered.hosts[1].asks.map(ask => ask.revision), [ownerAsk.revision]);
  assert.equal(recovered.hosts[0].error, null);
  assert.equal(recovered.hosts[1].error, null);
});

test("a stalled peer cannot delay local questions, delivery, or the post-answer refresh", { timeout: 2_000 }, async t => {
  const h = await harness(t);
  const peer = "https://slow.test:8444";
  h.canonical(peer); h.peers([peer]);
  const release = barrier();
  mockPeers(t, async () => { await release.promise; return Response.json(peerSnapshot()); });
  try {
    const before = await h.inbox.view();
    assert.equal(before.hosts[0].live[0].requestId, "q1");
    assert.equal(before.canonicalHost, null);
    assert.deepEqual(before.unreachable, [peer]);
    assert.equal((await h.post(await h.action())).body.delivered, "agent");
    const after = await h.inbox.view();
    assert.deepEqual(after.hosts[0].live, []);
    assert.deepEqual(after.unreachable, [peer]);
    release.release();
    await h.inbox.refresh();
    const recovered = await h.inbox.view();
    assert.equal(recovered.canonicalHost, "server087");
    assert.deepEqual(recovered.unreachable, []);
    assert.deepEqual(recovered.hosts[0].live, []);
    assert.deepEqual(h.sent.map(item => item.requestId), ["q1"]);
  } finally { release.release(); h.inbox.stop(); }
});

test("expired peer decisions are withheld while their refresh is blocked", { timeout: 2_000 }, async t => {
  const h = await harness(t);
  const peer = "https://slow.test:8444";
  h.canonical(peer); h.peers([peer]);
  const release = barrier();
  let hold = false;
  mockPeers(t, async () => { if (hold) await release.promise; return Response.json(peerSnapshot()); });
  try {
    await h.inbox.refresh();
    assert.equal((await h.inbox.view()).canonicalHost, "server087");
    hold = true;
    h.clock(h.now() + 30_001);
    const expired = await h.inbox.view();
    assert.equal(expired.canonicalHost, null);
    assert.deepEqual(expired.hosts[1].asks, []);
    assert.deepEqual(expired.unreachable, [peer]);
  } finally { release.release(); h.inbox.stop(); }
});

test("background curation publishes complete owner sources after the interactive deadline", async (t) => {
  const h = await harness(t);
  const entered = barrier(), release = barrier();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.onOwnerRead(async () => { entered.release(); await release.promise; });
  const collecting = h.inbox.start();
  t.after(() => h.inbox.stop());
  await entered.promise;
  assert.equal((await h.inbox.view()).hosts[0].live[0].requestId, "q1");
  t.mock.timers.tick(6_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  release.release();
  await collecting;
  h.clock(h.now() + 30_001);
  const view = await h.inbox.view();
  assert.deepEqual(view.hosts[0].asks.map(ask => ask.revision), [ownerAsk.revision]);
  assert.equal(view.hosts[0].error, null);
  assert.equal(view.tasks?.some(task => task.target === "owner" && task.revision === ownerAsk.revision), true);
});

test("an answer during a transport read cannot republish the answered request", async t => {
  const h = await harness(t);
  await h.inbox.start();
  t.after(() => h.inbox.stop());
  const input = await h.action();
  const entered = barrier(), release = barrier();
  const list = h.sdk.agents.list.bind(h.sdk.agents);
  let hold = true;
  t.mock.method(h.sdk.agents, "list", async (...args: Parameters<typeof list>) => {
    const page = structuredClone(await list(...args));
    if (hold) { hold = false; entered.release(); await release.promise; }
    return page;
  });
  // The transport read has to collect and be held by the mock, so it has to be past the memory's
  // five-second window: a fresh read answers from the collection the harness already made.
  h.clock(h.now() + 121_000);
  const reading = h.inbox.view();
  await entered.promise;
  assert.equal((await h.post(input)).status, 200);
  release.release();
  assert.deepEqual((await reading).hosts[0].live, []);
  assert.deepEqual((await h.inbox.view()).hosts[0].live, []);
});

test("answering a live request revalidates owner sources instead of hiding every ask on its ticket", async t => {
  const twin: OwnerAsk = { ...ownerAsk, mirrorsLiveRequest: true };
  const other: OwnerAsk = { ...ownerAsk, revision: "independent-policy-r2", title: "Independent policy question" };
  const asks = [twin, other];
  const h = await harness(t, "laptop", asks);
  h.agents[0].labels = { "linear.issueId": "i1" };
  await h.inbox.local();
  h.onSubmit(async () => { h.agents[0].pendingPermissions = []; asks.splice(0, 1); });
  assert.equal((await h.post(await h.action())).status, 200);
  const after = await h.inbox.local();
  assert.equal(h.ownerReads(), 2, "answer invalidates the owner cache for immediate collection");
  assert.deepEqual(after.live, []);
  assert.deepEqual(after.asks.map(ask => ask.revision), ["independent-policy-r2"]);
  h.sdk.agents.list = async () => { throw new Error("daemon busy"); };
  assert.deepEqual((await h.inbox.local()).asks.map(ask => ask.revision), ["independent-policy-r2"]);
});

test("a stalled Linear owner read does not prevent viewing live questions or multiply the read", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = barrier(), release = barrier();
  h.onOwnerRead(async () => { entered.release(); await release.promise; });
  const pending = h.inbox.local();
  await entered.promise;
  t.mock.timers.tick(5_000);
  const snapshot = await pending;
  assert.equal(snapshot.live[0].requestId, "q1");
  assert.deepEqual(snapshot.asks, []);
  release.release();
  await h.inbox.local();
  assert.equal(h.ownerReads(), 1);
});

test("owner actions preserve the supplied revision and invalidate the browser owner cache", async (t) => {
  const h = await harness(t);
  await h.inbox.local();
  const input = { host: "laptop", target: "owner", operation: "answer", issueId: "i1", revision: "owner-r1", answers: { q1: "Node" }, note: "Tests only", done: false };
  assert.equal((await h.post(input)).status, 200);
  await h.inbox.local();
  assert.equal(h.ownerReads(), 2);
});

test("owner read errors remain visible within the cache window and clear on a subsequent successful check", async (t) => {
  const h = await harness(t);
  h.onOwnerRead(async () => { throw new Error("Linear rate budget unavailable"); });
  const failed = await h.inbox.local();
  assert.deepEqual(failed.asks, []);
  assert.match(failed.error!, /Owner asks unavailable.*checked.*Linear rate budget unavailable/);
  h.clock(h.now() + 30_000);
  const cached = await h.inbox.local();
  assert.equal(cached.error, failed.error);
  assert.equal(cached.updatedAt, failed.updatedAt);
  assert.equal(h.ownerReads(), 1);
  h.onOwnerRead(async () => {});
  await h.inbox.refresh();
  const recovered = await h.inbox.local();
  assert.equal(recovered.error, null);
  assert.deepEqual(recovered.asks.map((ask) => ask.issueId), ["i1"]);
  assert.equal(h.ownerReads(), 2);
});


for (const status of ["confirmed", "unconfirmed"] as const) {
  test(`transport metadata migration preserves ${status} activity replay across backend reload`, async (t) => {
    const h = await harness(t);
    const input = await h.action();
    if (status === "unconfirmed") h.onSubmit(async () => { throw new Error("lost acknowledgement"); });
    const original = await h.post(input);
    assert.equal(original.status, status === "confirmed" ? 200 : 502);
    for (const backendInstanceId of [LOCAL_BACKEND, PEER_BACKEND]) {
      const replacement = h.create(() => backendInstanceId).inbox;
      const replay = await h.post({ ...input, backendInstanceId }, replacement);
      assert.deepEqual(replay, original);
    }
    assert.equal(h.sent.length, 1, "transport metadata never creates another permission activity");
  });
}

test("captured decision backend epoch rejects missing or stale local and peer provenance before delivery", async (t) => {
  const h = await harness(t);
  const local = h.create(() => LOCAL_BACKEND).inbox;
  const input = await h.action("q1", local);
  for (const backendInstanceId of [undefined, PEER_BACKEND]) {
    assert.equal((await h.post({ ...input, backendInstanceId }, local)).status, 409);
  }
  h.peers(["https://server087.test:8444"]);
  const calls = mockPeers(t, () => Response.json(peerSnapshot()));
  for (const backendInstanceId of [undefined, LOCAL_BACKEND]) {
    assert.equal((await h.post({ ...input, host: "server087", backendInstanceId }, local)).status, 409);
  }
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  assert.deepEqual(h.sent, []);
});

for (const [sourceHost, targetHost, sourceEpoch, targetEpoch] of [
  ["laptop", "server087", LOCAL_BACKEND, PEER_BACKEND],
  ["server087", "laptop", PEER_BACKEND, LOCAL_BACKEND],
]) {
  test(`decision actions from ${sourceHost} reach ${targetHost}'s checked authority exactly once`, async (t) => {
    const source = await harness(t, sourceHost);
    const target = await harness(t, targetHost);
    const sourceInbox = source.create(() => sourceEpoch).inbox;
    const targetInbox = target.create(() => targetEpoch).inbox;
    const peer = `https://${targetHost}.test:8444`;
    source.peers([peer]); source.canonical(peer);
    const calls = mockPeers(t, async (url, method, body, headers) => {
      assert.ok(url.startsWith(`${peer}/api/decisions/`));
      if (method === "GET") return Response.json(await targetInbox.local());
      assert.equal(headers.get(INBOX_DISPLAYED_HEADER), targetEpoch);
      const response = await targetInbox.route({ method, path: "/api/decisions/action", headers: { host: new URL(url).host, "x-review-action": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.ok(response);
      return new Response(response.body, { status: response.status, headers: response.headers });
    });
    const displayed = await target.action("q1", targetInbox);
    assert.equal((await source.post(displayed, sourceInbox)).status, 200);
    assert.equal(target.sent.length, 1);
    assert.deepEqual(source.sent, []);
    assert.equal((await source.post({ host: targetHost, backendInstanceId: targetEpoch, target: "owner", operation: "answer", issueId: ownerAsk.issueId, revision: ownerAsk.revision, answers: { q1: "Node" } }, sourceInbox)).status, 200);
    assert.equal(target.ownerActions.length, 1);
    assert.deepEqual(source.ownerActions, []);
    assert.equal(calls.filter((call) => call.method === "POST").length, 2);
  });
}

test("a curated live choice is revalidated immediately, before the fifteen-minute refresh", async t => {
  const h = await harness(t);
  await h.inbox.start();
  t.after(() => h.inbox.stop());
  const displayed = await h.inbox.view();
  const pending = displayed.hosts[0].live[0];
  h.agents[0].pendingPermissions[0] = { ...question, title: "A different authority boundary" };
  const result = await h.post({ host: "laptop", target: "live", operation: "answer", agentId: pending.agentId,
    requestId: pending.requestId, revision: pending.revision, answers: { Runner: "Node" } });
  assert.equal(result.status, 409);
  assert.deepEqual(h.sent, []);
  const current = await h.inbox.view();
  assert.notEqual(current.hosts[0].live[0].revision, pending.revision);
  assert.equal(current.curation?.running, true);
});

test("confirmed answers disappear from curated tasks immediately without waiting for collection cadence", async t => {
  const h = await harness(t);
  const displayed = await h.inbox.view();
  const pending = displayed.hosts[0].live[0];
  assert.equal((await h.post({ host: "laptop", target: "live", operation: "answer", agentId: pending.agentId,
    requestId: pending.requestId, revision: pending.revision, answers: { Runner: "Node" } })).status, 200);
  const current = await h.inbox.view();
  assert.deepEqual(current.tasks?.filter(task => task.target === "live"), []);
  assert.equal(h.sent.length, 1);
});

test("unknown live delivery stays visible and cannot be retried with a different choice", async t => {
  const h = await harness(t);
  const input = await h.action();
  h.onSubmit(async () => { throw new Error("connection lost after submission"); });
  const first = await h.post(input);
  assert.equal(first.body.outcomeUnknown, true);
  const snapshot = await h.inbox.view();
  assert.equal(snapshot.hosts[0].live[0].deliveryUnknown, true);
  assert.equal(snapshot.tasks?.find(task => task.target === "live")?.priority, "review");
  const different = await h.post({ ...input, answers: { Runner: "Vitest" } });
  assert.equal(different.body.outcomeUnknown, true);
  assert.equal(h.sent.length, 1);
});

// Owner sources that only need nonurgent review stay with the canonical host and are read in
// pages; the feeds every page and peer reads carry only what needs action, plus the review count.
function sourceReview(n: number, title: string): OwnerAsk {
  return { ...ownerAsk, issueId: `info-${n}`, revision: `info-r${n}`, attention: "info", attentionReason: "Source to review",
    kind: "info", identifier: `TUC-${100 + n}`, ticketIdentifier: `TUC-${100 + n}`, title, summary: title, questions: [], source: `${title} source`, extracted: false };
}
const actionable: OwnerAsk[] = [
  ownerAsk,
  { ...ownerAsk, issueId: "adv", revision: "adv-r1", attention: "advisor", attentionReason: "Advisor" },
  { ...ownerAsk, issueId: "dep", revision: "dep-r1", attention: "dependency", attentionReason: "Blocked", blockerIdentifier: "TUC-9" },
  { ...sourceReview(9, "Deferred note"), disposition: "deferred", deferredUntil: "2026-10-20T00:00:00.000Z" },
  { ...sourceReview(8, "Researching note"), disposition: "research" },
];
const reviews = [sourceReview(1, "Alpha note"), sourceReview(2, "Beta note"), sourceReview(3, "Beta other")];
async function getRoute(inbox: BrowserDecisionInbox, path: string, search = "") {
  const response = await inbox.route({ method: "GET", path, search, headers: {}, body: "" });
  assert.ok(response);
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}

test("the canonical feed carries every actionable owner ask in full and only counts source reviews", async (t) => {
  const h = await harness(t, "laptop", [actionable[0], reviews[0], actionable[1], reviews[1], actionable[2], actionable[3], reviews[2], actionable[4]]);
  await h.inbox.refresh();
  const local = await h.inbox.local();
  assert.deepEqual(local.asks.map(ask => ask.revision), actionable.map(ask => ask.revision));
  assert.equal(local.sourceReviews, 3);
  const view = await h.inbox.view();
  assert.deepEqual(view.hosts[0].asks.map(ask => ask.revision), actionable.map(ask => ask.revision));
  assert.equal(view.hosts[0].sourceReviews, 3);
  const served = await getRoute(h.inbox, "/api/decisions/local");
  assert.equal(served.body.sourceReviews, 3);
});

test("the canonical host pages its source reviews in source order, bounded and searchable", async (t) => {
  const h = await harness(t, "laptop", [...actionable, ...reviews]);
  await h.inbox.refresh();
  for (const path of ["/api/decisions/reviews", "/api/decisions/reviews/local"]) {
    const first = await getRoute(h.inbox, path, "?offset=0&limit=2");
    assert.equal(first.status, 200);
    assert.equal(first.body.host, "laptop");
    assert.equal(first.body.total, 3);
    assert.equal(first.body.offset, 0);
    assert.deepEqual((first.body.asks as OwnerAsk[]).map(ask => ask.revision), ["info-r1", "info-r2"]);
    const rest = await getRoute(h.inbox, path, "?offset=2&limit=2");
    assert.deepEqual((rest.body.asks as OwnerAsk[]).map(ask => ask.revision), ["info-r3"]);
    assert.equal(rest.body.total, 3);
    const defaults = await getRoute(h.inbox, path);
    assert.deepEqual((defaults.body.asks as OwnerAsk[]).map(ask => ask.revision), ["info-r1", "info-r2", "info-r3"]);
    const searched = await getRoute(h.inbox, path, "?q=BETA%20note");
    assert.equal(searched.body.total, 1);
    assert.deepEqual((searched.body.asks as OwnerAsk[]).map(ask => ask.revision), ["info-r2"]);
    const past = await getRoute(h.inbox, path, "?offset=10");
    assert.equal(past.status, 200);
    assert.deepEqual(past.body.asks, []);
    for (const bad of ["?limit=0", "?limit=101", "?offset=-1", "?offset=abc", "?limit=2.5"]) {
      assert.equal((await getRoute(h.inbox, path, bad)).status, 400, `${path}${bad}`);
    }
  }
  assert.equal((await h.inbox.route({ method: "POST", path: "/api/decisions/reviews", search: "", headers: {}, body: "" }))?.status, 405);
});

test("source reviews are unavailable, not empty, while the canonical owner collection is pending", async (t) => {
  const h = await harness(t, "laptop", reviews);
  const blocked = barrier();
  h.onOwnerRead(() => blocked.promise);
  t.after(() => blocked.release());
  const pending = await getRoute(h.inbox, "/api/decisions/reviews");
  assert.equal(pending.status, 503);
  assert.match(String(pending.body.error), /being collected/);
});

test("a non-canonical host reads source review pages from the canonical peer and never from local Linear", async (t) => {
  const h = await harness(t);
  const peer = "https://server087.test:8444";
  h.canonical(peer); h.peers([peer]);
  const page = { host: "server087", backendInstanceId: PEER_BACKEND, updatedAt: "2026-10-12T00:00:00.000Z", total: 51, offset: 50, asks: [sourceReview(2, "Beta note")] };
  let answer: () => Response = () => Response.json(page);
  const calls = mockPeers(t, () => answer());
  const read = await getRoute(h.inbox, "/api/decisions/reviews", "?offset=50&limit=50&q=beta");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, page);
  assert.deepEqual(calls.map(call => call.url), [`${peer}/api/decisions/reviews/local?offset=50&limit=50&q=beta`]);
  assert.equal(h.ownerReads(), 0);
  assert.equal((await getRoute(h.inbox, "/api/decisions/reviews/local")).status, 404, "only the canonical host serves its own pages");
  assert.equal(calls.length, 1, "the canonical-only route never proxies");
  answer = () => Response.json({ ...page, asks: [{ ...sourceReview(2, "Beta note"), untrustedExtra: true }] });
  const malformed = await getRoute(h.inbox, "/api/decisions/reviews");
  assert.equal(malformed.status, 503);
  assert.match(String(malformed.body.error), /invalid source review page/);
  answer = () => Response.json({ error: "busy" }, { status: 503 });
  const failed = await getRoute(h.inbox, "/api/decisions/reviews");
  assert.equal(failed.status, 503);
  assert.match(String(failed.body.error), /HTTP 503/);
  assert.equal(h.ownerReads(), 0);
});

test("the canonical peer's source review count reaches the view, and a peer without it still parses", async (t) => {
  const h = await harness(t);
  const peer = "https://server087.test:8444";
  h.canonical(peer); h.peers([peer]);
  let count: number | undefined = 7;
  mockPeers(t, () => Response.json(count === undefined ? peerSnapshot() : { ...peerSnapshot(), sourceReviews: count }));
  const view = await h.inbox.view();
  assert.equal(view.canonicalHost, "server087");
  assert.equal(view.hosts[1].sourceReviews, 7);
  count = undefined;
  await h.inbox.refresh();
  const older = await h.inbox.view();
  assert.equal(older.canonicalHost, "server087");
  assert.equal(older.hosts[1].sourceReviews, undefined);
});

test("a paged source review is answered through the canonical owner action", async (t) => {
  const h = await harness(t, "laptop", reviews);
  await h.inbox.refresh();
  const page = await getRoute(h.inbox, "/api/decisions/reviews", "?limit=1");
  const row = (page.body.asks as OwnerAsk[])[0];
  const result = await h.post({ host: page.body.host, target: "owner", operation: "answer", issueId: row.issueId, revision: row.revision, answers: {}, note: "Seen" });
  assert.equal(result.status, 200);
  assert.deepEqual(h.ownerActions.map(action => action.input), [{ issueId: "info-1", revision: "info-r1", answers: {}, note: "Seen" }]);
});

// This host's own snapshot is served from memory: a peer reads it under a five-second deadline and
// retries two seconds later, so the first read must not wait for a Linear scan, a Paseo listing or
// the steward, and the read after it must find the collection already done.
const flush = () => new Promise<void>((resolve) => { setImmediate(() => resolve()); });
// A background collection is never part of the answer that triggered it: turn the event loop until
// it has reached the step the test waits on, so the counts that follow are the collection's own.
const until = async (condition: () => boolean) => {
  for (let turn = 0; turn < 100 && !condition(); turn++) await flush();
  assert.ok(condition(), "the background collection did not reach the expected step");
};
const openQuestion = (body: Record<string, unknown>) => (body.live as { agentId: string; requestId: string; revision: string }[])[0];

test("the local feed answers from memory until the snapshot is five seconds old", async (t) => {
  const h = await harness(t);
  h.flow(async () => flow);
  const inbox = h.create().inbox;
  const first = await getRoute(inbox, "/api/decisions/local");
  assert.equal(first.status, 200);
  const listings = h.listCalls.length, flows = h.flowReads();
  assert.ok(listings > 0 && flows === 1, "the first read collects the snapshot");
  h.clock(h.now() + 4_000);
  h.agents[0].pendingPermissions = [{ ...question, id: "q2" }];
  const second = await getRoute(inbox, "/api/decisions/local");
  assert.deepEqual(second.body, first.body);
  assert.equal(h.listCalls.length, listings, "a fresh snapshot is not collected again");
  assert.equal(h.flowReads(), flows);
});

test("a stale snapshot answers while its replacement collects, and the follow-up read serves that replacement", async (t) => {
  const h = await harness(t);
  const gate = barrier();
  let blocked = false;
  h.flow(async () => { if (blocked) await gate.promise; return flow; });
  const inbox = h.create().inbox;
  t.after(() => gate.release());
  const first = await getRoute(inbox, "/api/decisions/local");
  const listings = h.listCalls.length, flows = h.flowReads();
  blocked = true;
  h.clock(h.now() + 10_000);
  h.agents[0].pendingPermissions = [{ ...question, id: "q2" }];
  const stale = await getRoute(inbox, "/api/decisions/local");
  assert.deepEqual(stale.body, first.body, "a snapshot inside the stale window answers before its replacement lands");
  await until(() => h.flowReads() === flows + 1);
  assert.equal(h.listCalls.length, listings + 1, "the replacement collection runs behind the read");
  gate.release();
  await flush();
  const next = await getRoute(inbox, "/api/decisions/local");
  assert.equal(openQuestion(next.body).requestId, "q2");
  assert.equal(h.flowReads(), flows + 1, "the landed replacement is served from memory");
});

test("a snapshot older than two minutes is collected before the read answers", async (t) => {
  const h = await harness(t);
  const gate = barrier();
  let blocked = false;
  h.flow(async () => { if (blocked) await gate.promise; return flow; });
  const inbox = h.create().inbox;
  t.after(() => gate.release());
  await getRoute(inbox, "/api/decisions/local");
  blocked = true;
  h.clock(h.now() + 121_000);
  h.agents[0].pendingPermissions = [{ ...question, id: "q2" }];
  let answered = false;
  const pending = getRoute(inbox, "/api/decisions/local").then((response) => { answered = true; return response; });
  await flush();
  assert.equal(answered, false, "an expired snapshot is not served while its replacement collects");
  gate.release();
  assert.equal(openQuestion((await pending).body).requestId, "q2");
});

test("an answer and an explicit refresh invalidate the memory instead of being followed by it", async (t) => {
  const h = await harness(t);
  const before = await getRoute(h.inbox, "/api/decisions/local");
  const live = openQuestion(before.body);
  const result = await h.post({ host: before.body.host, target: "live", operation: "answer", agentId: live.agentId, requestId: live.requestId, revision: live.revision, answers: { Runner: "Node" } });
  assert.equal(result.status, 200);
  const after = await getRoute(h.inbox, "/api/decisions/local");
  assert.deepEqual(after.body.live, [], "the answered question is gone from the very next read");
  h.agents[0].pendingPermissions = [{ ...question, id: "q3" }];
  await h.inbox.refresh();
  const refreshed = await getRoute(h.inbox, "/api/decisions/local");
  assert.equal(openQuestion(refreshed.body).requestId, "q3");
});

test("a collection begun before an answer never lands in the memory after it", async (t) => {
  const h = await harness(t);
  const gates: { promise: Promise<void>; release: () => void }[] = [];
  let blocked = false;
  h.flow(async () => { if (blocked) { const gate = barrier(); gates.push(gate); await gate.promise; } return flow; });
  const inbox = h.create().inbox;
  t.after(() => gates.forEach(gate => gate.release()));
  const first = await getRoute(inbox, "/api/decisions/local");
  const live = openQuestion(first.body);
  blocked = true;
  h.clock(h.now() + 10_000);
  assert.equal(openQuestion((await getRoute(inbox, "/api/decisions/local")).body).requestId, "q1", "the stale answer still carries the open question");
  await until(() => gates.length === 1);
  const listings = h.listCalls.length, flows = h.flowReads();
  // The answer lands while that collection is in flight: the action collects its replacement right
  // away, and the older collection must not write the memory afterwards — even when it lands last.
  assert.equal((await h.post({ host: first.body.host, target: "live", operation: "answer", agentId: live.agentId, requestId: live.requestId, revision: live.revision, answers: { Runner: "Node" } }, inbox)).status, 200);
  await until(() => gates.length === 2);
  gates[1].release();
  await flush();
  gates[0].release();
  await flush();
  const after = await getRoute(inbox, "/api/decisions/local");
  assert.deepEqual(after.body.live, [], "the answered question is gone from the memory");
  assert.equal(h.listCalls.length, listings + 1, "the post-answer collection is what the memory holds");
  assert.equal(h.flowReads(), flows + 1, "the answer is served from the collection the action started");
});

test("a landed owner collection reaches the next reads without any read waiting for it", async (t) => {
  const h = await harness(t);
  const gate = barrier();
  h.onOwnerRead(() => gate.promise);
  t.after(() => gate.release());
  const first = await getRoute(h.inbox, "/api/decisions/local");
  assert.deepEqual(first.body.asks, [], "the owner collection is still running");
  assert.match(String(first.body.error), /being collected/);
  const listings = h.listCalls.length;
  gate.release();
  await flush();
  const landing = await getRoute(h.inbox, "/api/decisions/local");
  assert.deepEqual(landing.body.asks, [], "the read after the landing answers from memory while it recollects");
  // Every read answers from memory; the recollection the landing started is what they turn to.
  let next = landing;
  for (let turn = 0; turn < 100 && !(next.body.asks as OwnerAsk[]).length; turn++) {
    await flush();
    next = await getRoute(h.inbox, "/api/decisions/local");
  }
  assert.equal((next.body.asks as OwnerAsk[]).map(ask => ask.revision).join(), ownerAsk.revision, "the landed owner collection is in the answer");
  assert.equal(h.listCalls.length, listings + 1, "the landing is collected once, not on every read");
  assert.equal((await getRoute(h.inbox, "/api/decisions/local")).status, 200);
  assert.equal(h.listCalls.length, listings + 1, "the recollection answers from memory afterwards");
});

// The steward's flow: three tracked recovery tickets, of which this host's decisions reference two
// — the owner ask's ticket and the live agent's ticket label (decision-curation.ts joins on
// exactly those). A peer feed ships the referenced ones; the whole list stays readable on demand.
function recoveryTicket(identifier: string) {
  return { identifier, situation: "Needs checking", since: "2026-10-12T00:00:00.000Z", reason: `Recovery evidence for ${identifier}` };
}
const flow: StewardFlow = { at: "2026-10-12T00:00:00.000Z", counts: { "waiting-owner": 1 }, oldest: [], error: null,
  tickets: [recoveryTicket("TUC-1"), recoveryTicket("TUC-5"), recoveryTicket("TUC-9")] };

test("a peer feed ships only the recovery tickets its decisions reference, with the steward's total", async (t) => {
  const h = await harness(t);
  h.flow(async () => flow);
  h.agents[0].labels["linear.identifier"] = "TUC-5";
  const inbox = h.create().inbox;
  const feed = await getRoute(inbox, "/api/decisions/local");
  assert.deepEqual(feed.body.flow, { ...flow, tickets: [recoveryTicket("TUC-1"), recoveryTicket("TUC-5")], ticketCount: 3 });
  const view = await inbox.view();
  assert.deepEqual(view.hosts[0].flow, { ...flow, ticketCount: 3 }, "this host's own page keeps every ticket");
});


test("the recovery evidence of a host is read locally or from the peer that owns it", async (t) => {
  const h = await harness(t);
  h.flow(async () => flow);
  const local = h.create().inbox;
  const own = await getRoute(local, "/api/decisions/flow/local");
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, { host: "laptop", tickets: flow.tickets });
  assert.deepEqual((await getRoute(local, "/api/decisions/flow", "?host=laptop")).body, { host: "laptop", tickets: flow.tickets });
  assert.equal((await getRoute(local, "/api/decisions/flow")).status, 400, "the host to read is named");
  const peer = "https://server087.test:8444";
  h.peers([peer]);
  const page = { host: "server087", tickets: [recoveryTicket("TUC-9")] };
  let ticketAnswer = () => Response.json(page);
  const calls = mockPeers(t, (url) => url.endsWith("/api/decisions/local") ? Response.json(peerSnapshot()) : ticketAnswer());
  const proxied = await getRoute(local, "/api/decisions/flow", "?host=server087");
  assert.equal(proxied.status, 200);
  assert.deepEqual(proxied.body, page);
  assert.deepEqual(calls.map(call => call.url), [`${peer}/api/decisions/local`, `${peer}/api/decisions/flow/local`]);
  const fetched = calls.length;
  const unknown = await getRoute(local, "/api/decisions/flow", "?host=https%3A%2F%2Fevil.test");
  assert.equal(unknown.status, 404);
  assert.match(String(unknown.body.error), /Unknown or unavailable decision host/);
  assert.equal(calls.length, fetched + 1, "an unknown host resolves against the configured origins only");
  assert.equal(calls[fetched].url, `${peer}/api/decisions/local`);
  ticketAnswer = () => Response.json({ ...page, untrustedExtra: true });
  const extended = await getRoute(local, "/api/decisions/flow", "?host=server087");
  assert.equal(extended.status, 503);
  assert.match(String(extended.body.error), /invalid recovery ticket list/);
  ticketAnswer = () => Response.json({ ...page, tickets: [{ ...recoveryTicket("TUC-9"), untrustedExtra: true }] });
  assert.equal((await getRoute(local, "/api/decisions/flow", "?host=server087")).status, 503);
  ticketAnswer = () => Response.json({ ...page, host: "someone-else" });
  const mislabelled = await getRoute(local, "/api/decisions/flow", "?host=server087");
  assert.equal(mislabelled.status, 503);
  assert.match(String(mislabelled.body.error), /answered for someone-else instead of server087/);
  ticketAnswer = () => Response.json({ error: "busy" }, { status: 503 });
  const failed = await getRoute(local, "/api/decisions/flow", "?host=server087");
  assert.equal(failed.status, 503);
  assert.match(String(failed.body.error), /HTTP 503/);
  // A host that never ran the steward has no recovery evidence to read: an explicit error, never
  // an empty list that reads as "no tickets".
  const bare = await harness(t);
  const noFlow = await getRoute(bare.create().inbox, "/api/decisions/flow/local");
  assert.equal(noFlow.status, 503);
  assert.match(String(noFlow.body.error), /no ticket flow configured/);
});
