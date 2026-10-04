import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";
import { AuthenticationError, ISSUE_STATE_QUERY, ISSUE_STATUSES_QUERY, LABELED_ISSUES_QUERY, LinearApiError, LinearService, MARKED_COMMENT_QUERY, type App, type Post } from "./linear";
import { RateLimitedError } from "./rate-budget";

const issue = { id: "i1", identifier: "TUC-1", state: { id: "s1", name: "Todo", type: "unstarted" }, team: { id: "t1" }, labels: { nodes: [] }, attachments: { nodes: [] }, inverseRelations: { nodes: [] } };
const ID_A = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID_B = "0c7f5f9e-83a5-4e4b-b7f3-2f7d3c1b5a10";

// The app's reads only: these tests write nothing, so its writes and viewer must stay unused.
function service(reader: Pick<App, "query"> | undefined, answers: (query: string, variables: Record<string, unknown>) => Record<string, unknown>) {
  const keyCalls: string[] = [];
  const post: Post = (_key, query, variables) => {
    keyCalls.push(query);
    return Promise.resolve(answers(query, variables));
  };
  const app: App | undefined = reader && { query: reader.query, mutate: () => Promise.reject(new Error("no writes here")), viewer: () => Promise.reject(new Error("no viewer here")) };
  return { keyCalls, linear: new LinearService(new Credentials("/unused", "env-key"), post, app) };
}

test("poller reads go to the app's pool and never touch the key when the app can answer", async () => {
  const appCalls: string[] = [];
  const reader: Pick<App, "query"> = {
    query: (query, variables) => {
      appCalls.push(query);
      if (query === ISSUE_STATE_QUERY) return Promise.resolve({ issue });
      if (query === ISSUE_STATUSES_QUERY) return Promise.resolve({ issues: { nodes: (variables.ids as string[]).map((id) => ({ id, state: { type: "started" }, completedAt: null })) } });
      return Promise.resolve({ issues: { nodes: [{ id: "i1", identifier: "TUC-1", priority: 2, team: { key: "TUC" }, labels: { nodes: [] } }] } });
    },
  };
  const { linear, keyCalls } = service(reader, () => { throw new Error("the key must not be used"); });
  assert.equal((await linear.issueState("i1")).identifier, "TUC-1");
  assert.equal((await linear.issueStatuses([ID_A, ID_B])).size, 2);
  assert.equal((await linear.labeledIssues("paseo", ["TUC"])).length, 1);
  assert.deepEqual(appCalls, [ISSUE_STATE_QUERY, ISSUE_STATUSES_QUERY, LABELED_ISSUES_QUERY]);
  assert.deepEqual(keyCalls, []);
});

test("the key reads once when the app is not usable here", async () => {
  const { linear, keyCalls } = service({ query: () => Promise.resolve(null) }, () => ({ issue }));
  await linear.issueState("i1");
  assert.deepEqual(keyCalls, [ISSUE_STATE_QUERY]);
});

test("tickets the app cannot see are read with the key", async () => {
  const missingIssue = service({ query: () => Promise.resolve({ issue: null }) }, () => ({ issue }));
  assert.equal((await missingIssue.linear.issueState("i1")).identifier, "TUC-1");
  assert.deepEqual(missingIssue.keyCalls, [ISSUE_STATE_QUERY]);

  const notFound = service({ query: () => Promise.reject(new Error("The Linear API request failed: Entity not found: Issue")) }, () => ({ issue }));
  await notFound.linear.issueState("i1");
  assert.deepEqual(notFound.keyCalls, [ISSUE_STATE_QUERY]);

  // The app sees one of two tickets: the key answers for the whole batch, so the blocker is not taken for deleted.
  const partial = service(
    { query: () => Promise.resolve({ issues: { nodes: [{ id: ID_A, state: { type: "completed" }, completedAt: "2026-09-28T00:00:00Z" }] } }) },
    () => ({ issues: { nodes: [{ id: ID_A, state: { type: "completed" }, completedAt: "2026-09-28T00:00:00Z" }, { id: ID_B, state: { type: "started" }, completedAt: null }] } }),
  );
  const statuses = await partial.linear.issueStatuses([ID_A, ID_B]);
  assert.equal(statuses.get(ID_B)?.statusType, "started");
  assert.deepEqual(partial.keyCalls, [ISSUE_STATUSES_QUERY]);
});

test("hasComment looks a marker up among the ticket's comments, and fails rather than answer for a ticket Linear does not return", async () => {
  const asked: Record<string, unknown>[] = [];
  const marked = (found: boolean) => service({ query: (query, variables) => {
    assert.equal(query, MARKED_COMMENT_QUERY);
    asked.push(variables);
    return Promise.resolve({ issue: { comments: { nodes: found ? [{ id: "c1" }] : [] } } });
  } }, () => { throw new Error("the key must not be used"); });
  assert.equal(await marked(true).linear.hasComment("i1", "queue-backstop:drop:#437:419"), true);
  assert.equal(await marked(false).linear.hasComment("i1", "queue-backstop:drop:#437:419"), false);
  assert.deepEqual(asked, [{ id: "i1", text: "queue-backstop:drop:#437:419" }, { id: "i1", text: "queue-backstop:drop:#437:419" }]);
  const missing = service({ query: () => Promise.resolve({ issue: null }) }, () => ({ issue: null }));
  await assert.rejects(missing.linear.hasComment("i1", "queue-backstop:x"), /did not return the ticket/);
  assert.deepEqual(missing.keyCalls, [MARKED_COMMENT_QUERY], "a ticket the app cannot see is read with the key first");
});

test("an app rate limit pauses the read instead of spending the key", async () => {
  const limited = new RateLimitedError("app", Date.now() + 60_000);
  const { linear, keyCalls } = service({ query: () => Promise.reject(limited) }, () => ({ issue }));
  await assert.rejects(linear.issueState("i1"), (error: unknown) => error === limited);
  await assert.rejects(linear.labeledIssues("paseo", ["TUC"]), RateLimitedError);
  assert.deepEqual(keyCalls, []);
});

test("AgentApi.query: null when the app cannot be used, errors otherwise", async () => {
  const notInstalled = new AgentApi({ accessToken: () => Promise.reject(new Error("The Paseo Linear app is not installed on this host.")) }, () => Promise.reject(new Error("unreachable")));
  assert.equal(await notInstalled.query("q", {}), null);

  const revoked = new AgentApi({ accessToken: () => Promise.resolve("token") }, () => Promise.reject(new AuthenticationError("Linear rejected this API key. Check it in Linear settings and reconnect.", 401)));
  assert.equal(await revoked.query("q", {}), null);

  const limited = new RateLimitedError("app", Date.now() + 60_000);
  const busy = new AgentApi({ accessToken: () => Promise.resolve("token") }, () => Promise.reject(limited));
  await assert.rejects(busy.query("q", {}), (error: unknown) => error === limited);

  // A refused read falls back to the key; the same refusal of a write propagates.
  const refused = new LinearApiError("Linear rejected this API key. Check it in Linear settings and reconnect.", 403);
  const forbidden = new AgentApi({ accessToken: () => Promise.resolve("token") }, () => Promise.reject(refused));
  assert.equal(await forbidden.query("q", {}), null);
  await assert.rejects(forbidden.mutate("m", {}), (error: unknown) => error === refused);

  const auth: string[] = [];
  const working = new AgentApi({ accessToken: () => Promise.resolve("token") }, (key) => { auth.push(key); return Promise.resolve({ viewer: { id: "app" } }); });
  assert.deepEqual(await working.query("q", {}), { viewer: { id: "app" } });
  assert.deepEqual(auth, ["Bearer token"]);
});

// A fake Linear for the aliased relay query: `visible` tickets have `comments`, served 50 per page.
function relayServer(visible: Record<string, number>) {
  const requests: Record<string, unknown>[] = [];
  const answer = (query: string, variables: Record<string, unknown>) => {
    assert.match(query, /^query relayComments/);
    requests.push(variables);
    const data: Record<string, unknown> = {};
    for (let index = 0; `i${index}` in variables; index++) {
      const id = variables[`i${index}`] as string;
      if (!(id in visible)) { data[`t${index}`] = { nodes: [] }; continue; }
      const offset = Number(variables[`a${index}`] ?? 0);
      const all = Array.from({ length: visible[id] }, (_, n) => ({ id: `${id}-c${n}`, body: `@paseo ${n}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), user: { id: "me" }, reactions: [] }));
      const nodes = all.slice(offset, offset + 50);
      data[`t${index}`] = { nodes: [{ id, comments: { nodes, pageInfo: { hasNextPage: offset + 50 < all.length, endCursor: String(offset + 50) } } }] };
    }
    return data;
  };
  return { requests, answer };
}

test("relay comments: one request for many tickets, every page of a busy ticket, and the key only for tickets the app cannot see", async () => {
  const ID_C = "9d1c2a44-1f7e-4c55-9a53-6a0f2e8b7c31";
  const ID_GONE = "5e2b8f00-7a1d-4b3c-8e9f-112233445566";
  const app = relayServer({ [ID_A]: 2, [ID_B]: 120 });
  const key = relayServer({ [ID_C]: 1 });
  const { linear, keyCalls } = service({ query: (query, variables) => Promise.resolve(app.answer(query, variables)) }, (query, variables) => key.answer(query, variables));
  const cursors = [ID_A, ID_B, ID_C, ID_GONE, "not-a-linear-id"].map((issueId) => ({ issueId, since: "2026-01-01T00:00:00Z" }));
  const { comments, unseen } = await linear.relayComments("me", cursors);
  // Round 1 reads all four real tickets; rounds 2 and 3 page through the busy one alone.
  assert.deepEqual(app.requests.map((variables) => Object.keys(variables).filter((name) => name.startsWith("i")).length), [4, 1, 1]);
  assert.equal(comments.get(ID_B)?.length, 120);
  assert.deepEqual(comments.get(ID_B)?.slice(0, 2).map((item) => item.id), [`${ID_B}-c0`, `${ID_B}-c1`]);
  assert.equal(comments.get(ID_A)?.length, 2);
  // The key is asked once, for the two tickets the app could not see.
  assert.equal(keyCalls.length, 1);
  assert.deepEqual([key.requests[0].i0, key.requests[0].i1], [ID_C, ID_GONE]);
  assert.equal(comments.get(ID_C)?.length, 1);
  assert.deepEqual(unseen.sort(), [ID_GONE, "not-a-linear-id"].sort());
});

test("relay comments: an app rate limit fails the read without falling back to the key", async () => {
  const { linear, keyCalls } = service({ query: () => Promise.reject(new RateLimitedError("app", Date.now() + 60_000)) }, () => ({}));
  await assert.rejects(linear.relayComments("me", [{ issueId: ID_A, since: "2026-01-01T00:00:00Z" }]), RateLimitedError);
  assert.deepEqual(keyCalls, []);
});
