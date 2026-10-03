import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentApi, AppAuth } from "./agent-app";
import { Credentials } from "./credentials";
import { AuthenticationError, LinearApiError, LinearService, postGraphQL, type Post } from "./linear";
import { RateBudget, RateLimitedError } from "./rate-budget";

// Which credential carried each request: the owner's key ("env-key") or the Paseo app's token.
const KEY = "env-key";
const APP = "Bearer app-token";
const APP_REFRESHED = "Bearer app-token-2";

type Sent = { auth: string; op: string; mutation: boolean; variables: Record<string, unknown> };
type Answer = (sent: Sent) => Record<string, unknown>;

const operation = (query: string) => query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? "?";
const states = { nodes: [
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-ip", name: "In Progress", type: "started", position: 2 },
  { id: "s-review", name: "In Review", type: "started", position: 3 },
  { id: "s-done", name: "Done", type: "completed", position: 4 },
] };
const OLD_LINK = "https://app.paseo.sh/h/srv/agent/old";
const NEW_LINK = "https://app.paseo.sh/h/srv/agent/new";

// Linear's successful answer to every operation LinearService sends.
const ANSWERS: Record<string, Answer> = {
  issueState: () => ({ issue: {
    id: "i1", identifier: "TUC-1", state: { id: "s-ip", name: "In Progress", type: "started" }, team: { id: "t1" }, project: null, creator: { id: "u1" },
    labels: { nodes: [{ id: "l-needs-you", name: "paseo-needs-you" }] }, attachments: { nodes: [] }, inverseRelations: { nodes: [] },
  } }),
  teamStates: () => ({ team: { states } }),
  issueUpdateState: ({ variables }) => {
    const state = states.nodes.find((item) => item.id === variables.stateId)!;
    return { issueUpdate: { success: true, issue: { id: variables.id, state: { name: state.name, type: state.type } } } };
  },
  issueCreate: () => ({ issueCreate: { success: true, issue: { id: "i2", identifier: "TUC-2", url: "https://linear.app/ws/issue/TUC-2" } } }),
  delegate: () => ({ issueUpdate: { success: true } }),
  relation: () => ({ issueRelationCreate: { success: true } }),
  describe: () => ({ issueUpdate: { success: true } }),
  labelByName: () => ({ issueLabels: { nodes: [] } }),
  labelCreate: () => ({ issueLabelCreate: { success: true, issueLabel: { id: "l-new", name: "paseo-new" } } }),
  addLabel: () => ({ issueAddLabel: { success: true } }),
  removeLabel: () => ({ issueRemoveLabel: { success: true } }),
  comment: () => ({ commentCreate: { success: true, comment: { id: "c-new" } } }),
  commentUpdate: () => ({ commentUpdate: { success: true } }),
  upsertAttachment: () => ({ attachmentCreate: { success: true } }),
  issueAttachments: () => ({ issue: { attachments: { nodes: [{ id: "a-old", url: OLD_LINK }, { id: "a-new", url: NEW_LINK }] } } }),
  deleteAttachment: () => ({ attachmentDelete: { success: true } }),
  link: () => ({ attachmentLinkURL: { success: true } }),
  react: () => ({ reactionCreate: { success: true } }),
  issueDocuments: () => ({ issue: { id: "i1", documents: { nodes: [] } } }),
  documentCreate: () => ({ documentCreate: { success: true, document: { id: "d1", url: "https://linear.app/ws/document/d1" } } }),
  documentUpdate: () => ({ documentUpdate: { success: true, document: { id: "d1", url: "https://linear.app/ws/document/d1" } } }),
  viewerCheck: () => ({ viewer: { id: "owner" } }),
  userUrl: () => ({ user: { url: "https://linear.app/ws/profiles/owner" } }),
  userKind: () => ({ user: { app: false } }),
  appViewer: () => ({ viewer: { id: "app-user", name: "Paseo" } }),
  listIssues: () => ({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }),
  issueDetail: () => ({ viewer: { id: "owner" }, issue: {
    id: "i1", identifier: "TUC-1", title: "Fix", url: "https://linear.app/ws/issue/TUC-1", description: "", state: { name: "In Progress", type: "started" },
    team: { id: "t1" }, labels: { nodes: [] }, attachments: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, children: { nodes: [] },
  } }),
  issueComments: () => ({ issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
};

// A fake Linear behind LinearService and a real AgentApi. `fail` turns a request into an error
// (the request then ran on Linear or not, as the error says); `token` is the app's token for a
// refresh or not (default: "app-token", "app-token-2" when forced), or throws when it has none.
function harness(options: { app?: "installed" | "none"; fail?: (sent: Sent, index: number) => Error | undefined; answers?: Record<string, Answer>; token?: (force: boolean) => string } = {}) {
  const sent: Sent[] = [];
  const forces: boolean[] = [];
  const post: Post = async (auth, query, variables) => {
    const request: Sent = { auth, op: operation(query), mutation: query.trimStart().startsWith("mutation"), variables };
    sent.push(request);
    const error = options.fail?.(request, sent.length - 1);
    if (error) throw error;
    const answer = options.answers?.[request.op] ?? ANSWERS[request.op];
    if (!answer) throw new Error(`no fake answer for ${request.op}`);
    return answer(request);
  };
  const token = options.token ?? ((force: boolean) => (force ? "app-token-2" : "app-token"));
  const app = new AgentApi({ accessToken: async (force = false) => { forces.push(force); return token(force); } }, post);
  const linear = new LinearService(new Credentials("/unused", KEY), post, options.app === "none" ? undefined : app);
  return {
    linear, sent, forces,
    // Every write sent, as "<credential> <operation>".
    writes: () => sent.filter((request) => request.mutation).map((request) => `${request.auth} ${request.op}`),
  };
}

function quiet(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args.join(" ")); });
  return lines;
}

const documentExists: Record<string, Answer> = {
  issueDocuments: () => ({ issue: { id: "i1", documents: { nodes: [{ id: "d1", title: "Plan: TUC-1", url: "https://linear.app/ws/document/d1", content: "old" }] } } }),
};

const WRITES: { name: string; run: (linear: LinearService) => Promise<unknown>; writes: string[]; answers?: Record<string, Answer> }[] = [
  { name: "markInProgress", run: async (linear) => assert.deepEqual(await linear.markInProgress({ id: "i1", status: "Todo", statusType: "unstarted" }, "t1"), { changed: true }), writes: ["issueUpdateState"] },
  { name: "moveToStateNamed", run: (linear) => linear.moveToStateNamed("i1", "In Review"), writes: ["issueUpdateState"] },
  { name: "moveToState", run: (linear) => linear.moveToState("i1", "s-todo"), writes: ["issueUpdateState"] },
  { name: "moveToReview", run: (linear) => linear.moveToReview("i1"), writes: ["issueUpdateState"] },
  { name: "moveToReady", run: (linear) => linear.moveToReady("i1"), writes: ["issueUpdateState"] },
  { name: "reopen", run: (linear) => linear.reopen("i1"), writes: ["issueUpdateState"] },
  { name: "complete", run: (linear) => linear.complete("i1"), writes: ["issueUpdateState"] },
  { name: "createIssue", run: (linear) => linear.createIssue({ teamId: "t1", title: "Needs you", description: "d", ready: true }), writes: ["issueCreate"] },
  { name: "addBlocker", run: (linear) => linear.addBlocker("i1", "i2"), writes: ["relation"] },
  { name: "updateDescription", run: (linear) => linear.updateDescription("i1", "new text"), writes: ["describe"] },
  { name: "addLabel with a new label", run: (linear) => linear.addLabel("i1", "paseo-new", "#ff0000"), writes: ["labelCreate", "addLabel"] },
  { name: "removeLabel", run: (linear) => linear.removeLabel("i1", "paseo-needs-you"), writes: ["removeLabel"] },
  { name: "comment", run: (linear) => linear.comment("i1", "hello"), writes: ["comment"] },
  { name: "upsertComment without a comment", run: async (linear) => assert.equal(await linear.upsertComment("i1", "hello", null), "c-new"), writes: ["comment"] },
  { name: "upsertComment editing one", run: async (linear) => assert.equal(await linear.upsertComment("i1", "hello", "c1"), "c1"), writes: ["commentUpdate"] },
  { name: "upsertAttachment", run: (linear) => linear.upsertAttachment("i1", NEW_LINK, "Paseo agent", "Working"), writes: ["upsertAttachment"] },
  { name: "removeAttachments", run: (linear) => linear.removeAttachments("i1", "https://app.paseo.sh/h/", NEW_LINK), writes: ["deleteAttachment"] },
  { name: "linkUrl", run: (linear) => linear.linkUrl("i1", "https://github.com/o/r/pull/1", "PR"), writes: ["link"] },
  { name: "react", run: (linear) => linear.react("c1", "👀"), writes: ["react"] },
  { name: "upsertIssueDocument creating it", run: (linear) => linear.upsertIssueDocument("i1", "Plan: TUC-1", "plan"), writes: ["documentCreate"] },
  { name: "upsertIssueDocument updating it", run: (linear) => linear.upsertIssueDocument("i1", "Plan: TUC-1", "plan"), writes: ["documentUpdate"], answers: documentExists },
];

for (const row of WRITES) {
  test(`${row.name} writes as the Paseo app, never with the key`, async () => {
    const { linear, writes } = harness({ answers: row.answers });
    await row.run(linear);
    assert.deepEqual(writes(), row.writes.map((op) => `${APP} ${op}`));
  });
}

test("delegating a ticket and the owner's own reads use the key, not the app", async () => {
  const { linear, sent, forces } = harness();
  await linear.delegate("i1", "app-user");
  await linear.issues();
  await linear.detail("i1");
  assert.equal(await linear.viewerId(), "owner");
  assert.equal(await linear.userUrl("owner"), "https://linear.app/ws/profiles/owner");
  await linear.ping();
  assert.deepEqual(sent.map((request) => `${request.auth} ${request.op}`), [
    `${KEY} delegate`, `${KEY} listIssues`, `${KEY} issueDetail`, `${KEY} issueComments`, `${KEY} viewerCheck`, `${KEY} userUrl`, `${KEY} viewerCheck`,
  ]);
  assert.deepEqual(forces, [], "the app's token is never asked for");
});

test("without a usable app on this host, writes go out with the key and say so once", async (t) => {
  const notInstalled = () => { throw new Error("The Paseo Linear app is not installed on this host."); };
  for (const options of [{ app: "none" as const }, { token: notInstalled }]) {
    const lines = quiet(t);
    const { linear, writes } = harness(options);
    await linear.comment("i1", "one");
    await linear.addBlocker("i1", "i2");
    assert.deepEqual(writes(), [`${KEY} comment`, `${KEY} relation`]);
    assert.deepEqual(lines, ["[linear-tickets] the Paseo app is not usable on this host; Linear writes appear as the key's owner"]);
    t.mock.restoreAll();
  }
});

test("an expired app token Linear refuses to refresh sends the write with the key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-split-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "app.json"), JSON.stringify({ clientId: "c", clientSecret: "s", webhookSecret: "w" }));
  await writeFile(join(directory, "token.json"), JSON.stringify({ access_token: "app-token", refresh_token: "r1", expires_at: Date.now() - 1 }));
  const refreshes: number[] = [];
  const auth = new AppAuth(directory, (async () => { refreshes.push(1); return new Response("{}", { status: 400 }); }) as unknown as typeof fetch);
  const sent: string[] = [];
  const post: Post = async (key, query) => { sent.push(`${key} ${operation(query)}`); return ANSWERS[operation(query)]({} as Sent); };
  quiet(t);
  await new LinearService(new Credentials("/unused", KEY), post, new AgentApi(auth, post)).comment("i1", "hi");
  assert.equal(refreshes.length, 1);
  assert.deepEqual(sent, [`${KEY} comment`]);
});

test("a rejected app token falls back to the key only when the forced refresh or its retry is rejected too", async (t) => {
  quiet(t);
  const rejected = () => new AuthenticationError("Linear rejected this API key. Check it in Linear settings and reconnect.", 401);

  // The refresh after the 401 fails: nothing was authenticated, so the key writes.
  const noRefresh = harness({ fail: (sent) => (sent.auth === APP ? rejected() : undefined), token: (force) => { if (force) throw new Error("Linear refused to refresh the Paseo app token (HTTP 400)."); return "app-token"; } });
  await noRefresh.linear.comment("i1", "hi");
  assert.deepEqual(noRefresh.writes(), [`${APP} comment`, `${KEY} comment`]);
  assert.deepEqual(noRefresh.forces, [false, true]);

  // The refreshed token is rejected as well.
  const twice = harness({ fail: (sent) => (sent.auth.startsWith("Bearer ") ? rejected() : undefined) });
  await twice.linear.comment("i1", "hi");
  assert.deepEqual(twice.writes(), [`${APP} comment`, `${APP_REFRESHED} comment`, `${KEY} comment`]);

  // The refreshed token is accepted: the app writes, the key never does.
  const recovered = harness({ fail: (sent) => (sent.auth === APP ? rejected() : undefined) });
  await recovered.linear.comment("i1", "hi");
  assert.deepEqual(recovered.writes(), [`${APP} comment`, `${APP_REFRESHED} comment`]);
});

test("a write Linear refused, rate limited or may have run is never repeated with the key", async (t) => {
  const lines = quiet(t);
  const forbidden = new LinearApiError("Linear rejected this API key. Check it in Linear settings and reconnect.", 403);

  // 401, refresh, then 403: the refused write propagates.
  const afterRefresh = harness({ fail: (sent) => (sent.auth === APP ? new AuthenticationError("rejected", 401) : sent.auth === APP_REFRESHED ? forbidden : undefined) });
  await assert.rejects(afterRefresh.linear.comment("i1", "hi"), (error: unknown) => error === forbidden);
  assert.deepEqual(afterRefresh.writes(), [`${APP} comment`, `${APP_REFRESHED} comment`]);

  // 403 at once: no refresh, no key.
  const refused = harness({ fail: (sent) => (sent.auth === APP ? forbidden : undefined) });
  await assert.rejects(refused.linear.comment("i1", "hi"), (error: unknown) => error === forbidden);
  assert.deepEqual(refused.writes(), [`${APP} comment`]);
  assert.deepEqual(refused.forces, [false]);

  const limited = new RateLimitedError("app", Date.now() + 60_000);
  const busy = harness({ fail: (sent) => (sent.auth === APP ? limited : undefined) });
  await assert.rejects(busy.linear.addLabel("i1", "paseo-new"), (error: unknown) => error === limited);
  assert.deepEqual(busy.writes(), [`${APP} labelCreate`]);

  // Outages and network failures on a create, an edit and a delete.
  const failures = [
    () => new LinearApiError("The Linear API request failed (HTTP 502). Try again.", 502),
    () => new Error("Could not reach the Linear API. Check the host's network connection and try again."),
  ];
  const writes: [string, (linear: LinearService) => Promise<unknown>, string[]][] = [
    ["create", (linear) => linear.comment("i1", "hi"), ["comment"]],
    ["edit", (linear) => linear.upsertComment("i1", "hi", "c1"), ["commentUpdate"]],
    ["delete", (linear) => linear.removeAttachments("i1", "https://app.paseo.sh/h/", NEW_LINK), ["deleteAttachment"]],
  ];
  for (const failure of failures) {
    for (const [kind, run, expected] of writes) {
      const error = failure();
      const { linear, writes: sent } = harness({ fail: (request) => (request.auth === APP ? error : undefined) });
      await assert.rejects(run(linear), (thrown: unknown) => thrown === error, `${kind}: ${error.message}`);
      assert.deepEqual(sent(), expected.map((op) => `${APP} ${op}`), `${kind}: ${error.message}`);
    }
  }
  assert.deepEqual(lines, [], "the app was usable throughout");
});

test("upsertComment: a comment the key wrote is edited with the key, once", async () => {
  const notAuthor = new LinearApiError("The Linear API request failed: Cannot modify Comment.", 400, ["INPUT_ERROR"], ["Cannot modify Comment"]);
  const { linear, writes } = harness({ fail: (sent) => (sent.auth === APP && sent.op === "commentUpdate" ? notAuthor : undefined) });
  assert.equal(await linear.upsertComment("i1", "progress", "c1"), "c1");
  assert.deepEqual(writes(), [`${APP} commentUpdate`, `${KEY} commentUpdate`]);
});

test("upsertComment: other refusals and failures of the edit propagate; nothing is posted instead", async () => {
  const failures = [
    new LinearApiError("The Linear API request failed: Argument Validation Error.", 400, ["INPUT_ERROR"], ["Argument Validation Error"]),
    new LinearApiError("Linear rejected this API key. Check it in Linear settings and reconnect.", 403),
    new LinearApiError("The Linear API request failed (HTTP 500). Try again.", 500),
  ];
  for (const failure of failures) {
    const { linear, writes } = harness({ fail: (sent) => (sent.auth === APP ? failure : undefined) });
    await assert.rejects(linear.upsertComment("i1", "progress", "c1"), (error: unknown) => error === failure);
    assert.deepEqual(writes(), [`${APP} commentUpdate`], failure.message);
  }
});

test("upsertComment: a deleted comment is replaced by a new one from the app", async () => {
  const gone = new LinearApiError("The Linear API request failed: Entity not found: Comment.", 400, ["INVALID_INPUT"], ["Entity not found: Comment"]);
  const { linear, writes, sent } = harness({ fail: (request) => (request.op === "commentUpdate" ? gone : undefined) });
  assert.equal(await linear.upsertComment("i1", "progress", "c1"), "c-new");
  assert.deepEqual(writes(), [`${APP} commentUpdate`, `${APP} comment`]);
  assert.deepEqual(sent.at(-1)?.variables, { input: { issueId: "i1", body: "progress" } });
});

test("isPerson: the Paseo app and other apps are not people; an unanswered question is not remembered", async () => {
  const { linear, sent } = harness({ answers: { userKind: ({ variables }) => ({ user: { app: variables.id === "integration" } }) } });
  assert.equal(await linear.appUserId(), "app-user");
  assert.equal(await linear.isPerson("app-user"), false);
  assert.equal(sent.filter((request) => request.op === "userKind").length, 0, "the app's own id needs no read");

  assert.equal(await linear.isPerson("customer"), true);
  assert.equal(await linear.isPerson("customer"), true);
  assert.equal(await linear.isPerson("integration"), false);
  assert.deepEqual(sent.filter((request) => request.op === "userKind").map((request) => `${request.auth} ${request.variables.id}`), [`${KEY} customer`, `${KEY} integration`]);

  let down = true;
  const flaky = harness({ fail: (request) => (request.op === "userKind" && down ? new Error("Could not reach the Linear API.") : undefined) });
  assert.equal(await flaky.linear.isPerson("customer"), false);
  down = false;
  assert.equal(await flaky.linear.isPerson("customer"), true);

  const noApp = harness({ token: () => { throw new Error("The Paseo Linear app is not installed on this host."); } });
  assert.equal(await noApp.linear.appUserId(), null);
});

// The real request path: Linear's HTTP answers become the errors the rules above decide on.
test("Linear's answers map to the errors that decide between app, key and failure", async (t) => {
  const budget = new RateBudget();
  let reply: (auth: string, op: string) => Response = () => new Response("{}", { status: 500 });
  const auths: string[] = [];
  t.mock.method(globalThis, "fetch", (async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).authorization;
    auths.push(auth);
    return reply(auth, operation(JSON.parse(String(init?.body)).query));
  }) as typeof fetch);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const post: Post = (key, query, variables) => postGraphQL(key, query, variables, budget);

  reply = () => json(401, { errors: [{ message: "Authentication required" }] });
  await assert.rejects(post(APP, "query q { viewer { id } }", {}), AuthenticationError);
  reply = () => json(200, { errors: [{ message: "Invalid token", extensions: { code: "AUTHENTICATION_ERROR" } }] });
  await assert.rejects(post(APP, "query q { viewer { id } }", {}), AuthenticationError);
  reply = () => json(403, { errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] });
  await assert.rejects(post(APP, "query q { viewer { id } }", {}), (error: unknown) => error instanceof LinearApiError && !(error instanceof AuthenticationError) && error.status === 403);

  // The key's old comment, edited end to end: the app is refused, the key edits it.
  auths.length = 0;
  reply = (auth, op) => (op === "commentUpdate" && auth.startsWith("Bearer ")
    ? json(400, { data: null, errors: [{ message: "Cannot modify Comment", extensions: { code: "INPUT_ERROR", type: "invalid input", userError: true } }] })
    : json(200, { data: { commentUpdate: { success: true } } }));
  const linear = new LinearService(new Credentials("/unused", KEY), post, new AgentApi({ accessToken: async () => "app-token" }, post));
  assert.equal(await linear.upsertComment("i1", "progress", "c1"), "c1");
  assert.deepEqual(auths, [APP, KEY]);
});
