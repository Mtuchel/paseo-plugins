import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";
import { ISSUE_STATE_QUERY, ISSUE_STATUSES_QUERY, LABELED_ISSUES_QUERY, LinearService, type Post, type Reader } from "./linear";
import { RateLimitedError } from "./rate-budget";

const issue = { id: "i1", identifier: "TUC-1", state: { id: "s1", name: "Todo", type: "unstarted" }, team: { id: "t1" }, labels: { nodes: [] }, attachments: { nodes: [] }, inverseRelations: { nodes: [] } };
const ID_A = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID_B = "0c7f5f9e-83a5-4e4b-b7f3-2f7d3c1b5a10";

function service(reader: Reader | undefined, answers: (query: string, variables: Record<string, unknown>) => Record<string, unknown>) {
  const keyCalls: string[] = [];
  const post: Post = (_key, query, variables) => {
    keyCalls.push(query);
    return Promise.resolve(answers(query, variables));
  };
  return { keyCalls, linear: new LinearService(new Credentials("/unused", "env-key"), post, reader) };
}

test("poller reads go to the app's pool and never touch the key when the app can answer", async () => {
  const appCalls: string[] = [];
  const reader: Reader = {
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

  const revoked = new AgentApi({ accessToken: () => Promise.resolve("token") }, () => Promise.reject(new Error("Linear rejected this API key. Check it in Linear settings and reconnect.")));
  assert.equal(await revoked.query("q", {}), null);

  const limited = new RateLimitedError("app", Date.now() + 60_000);
  const busy = new AgentApi({ accessToken: () => Promise.resolve("token") }, () => Promise.reject(limited));
  await assert.rejects(busy.query("q", {}), (error: unknown) => error === limited);

  const auth: string[] = [];
  const working = new AgentApi({ accessToken: () => Promise.resolve("token") }, (key) => { auth.push(key); return Promise.resolve({ viewer: { id: "app" } }); });
  assert.deepEqual(await working.query("q", {}), { viewer: { id: "app" } });
  assert.deepEqual(auth, ["Bearer token"]);
});
