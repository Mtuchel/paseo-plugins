import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";
import { AuthenticationError, CREATE_ISSUE_QUERY, ISSUE_ATTACHMENT_URLS_QUERY, ISSUE_COMMENT_HISTORY_QUERY, ISSUE_CORE_QUERY, ISSUE_GROUP_QUERY, ISSUE_GROUP_LABELS_QUERY, ISSUE_WATCH_STATE_QUERY, ISSUE_METADATA_QUERY, ISSUE_STATUS_QUERY, ISSUE_STATE_QUERY, ISSUE_STATUSES_QUERY, LABELED_ISSUES_QUERY, LinearApiError, LinearService, MARKED_COMMENT_QUERY, MENTIONING_ISSUES_QUERY, OWNER_ASKS_QUERY, TEAM_STATES_QUERY, type App, type IssueCore, type Post } from "./linear";
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

const groupConnection = (nodes: unknown[], after: string | null = null) => ({
  nodes, pageInfo: { hasNextPage: after !== null, endCursor: after },
});
const groupChild = (number: number) => ({
  id: `child-${number}`, identifier: `TUC-${number}`, state: { name: "Done", type: "completed" },
  delegate: { id: "app" }, assignee: { id: "owner" }, labels: groupConnection([]),
  attachments: { nodes: [] }, inverseRelations: { nodes: [] },
});

test("issueGroup reads every child and label page, retaining late owner labels and child blockers", async () => {
  const children = Array.from({ length: 75 }, (_, index) => groupChild(index + 2));
  children[74].state = { name: "Todo", type: "unstarted" };
  const labels = [...Array.from({ length: 40 }, (_, index) => ({ name: `label-${index}` })), { name: "paseo-manual" }];
  const ownerTask = {
    ...children[0], labels: groupConnection(labels.slice(0, 20), "labels-20"),
    inverseRelations: { nodes: [{ type: "blocks", issue: {
      id: "external", identifier: "TUC-99", state: { name: "Todo", type: "unstarted" }, delegate: null, attachments: { nodes: [] },
    } }] },
  };
  const { linear } = service(undefined, (query, variables) => {
    if (query === ISSUE_GROUP_QUERY) return { issue: { ...issue, delegate: { id: "app" },
      children: variables.after === null
        ? groupConnection([ownerTask, ...children.slice(1, 50)], "children-50")
        : groupConnection(children.slice(50)),
    } };
    assert.equal(query, ISSUE_GROUP_LABELS_QUERY);
    assert.equal(variables.id, ownerTask.id);
    return { issue: { id: ownerTask.id, labels: variables.after === "labels-20"
      ? groupConnection(labels.slice(20, 40), "labels-40") : groupConnection(labels.slice(40)) } };
  });
  const group = await linear.issueGroup("i1");
  assert.equal(group.delegateId, "app");
  assert.deepEqual(group.children.map((child) => child.id), children.map((child) => child.id));
  assert.deepEqual(group.children[0].labels, labels.map((label) => label.name));
  assert.deepEqual(group.children[0].blockers, [{
    id: "external", identifier: "TUC-99", status: "Todo", statusType: "unstarted", delegateId: null, finished: false,
  }]);
  assert.equal(group.children[74].finished, false, "the last page's open child must remain visible");
  assert.equal(group.children[74].statusType, "unstarted");
});

test("explicit last-page metadata accepts exactly 50 children and exactly 20 labels without a size heuristic", async () => {
  const labels = Array.from({ length: 20 }, (_, index) => ({ name: `label-${index}` }));
  const children = Array.from({ length: 50 }, (_, index) => ({ ...groupChild(index + 2), labels: groupConnection(labels) }));
  const { linear } = service(undefined, (query) => {
    if (query !== ISSUE_GROUP_QUERY) throw new Error("A terminal label page must not request another page");
    return { issue: { ...issue, children: groupConnection(children) } };
  });
  const group = await linear.issueGroup("i1");
  assert.deepEqual(group.children.map((child) => [child.id, child.labels]), children.map((child) => [child.id, labels.map((label) => label.name)]));
});

test("overlapping child pages keep one current child row and numeric handout order", async () => {
  const { linear } = service(undefined, (_query, variables) => ({
    issue: { ...issue, children: variables.after === null
      ? groupConnection([groupChild(10), groupChild(2)], "next")
      : groupConnection([{ ...groupChild(10), state: { name: "Todo", type: "unstarted" } }, groupChild(3)]),
    },
  }));
  const group = await linear.issueGroup("i1");
  assert.deepEqual(group.children.map((child) => [child.identifier, child.finished]), [["TUC-2", true], ["TUC-3", true], ["TUC-10", false]]);
});

test("incomplete child or label pagination rejects the whole group instead of exposing a prefix", async () => {
  const invalid: Record<string, unknown> = {
    "missing metadata": { nodes: [] },
    "missing nodes": { pageInfo: { hasNextPage: false, endCursor: null } },
    "missing cursor": { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
    "repeated cursor": groupConnection([], "next"),
  };
  for (const field of ["children", "labels"] as const) {
    for (const [failure, page] of Object.entries(invalid)) {
      const { linear } = service(undefined, (query, variables) => {
        if (field === "children") return { issue: { ...issue, children: variables.after === null
          ? groupConnection([groupChild(2)], "next") : page } };
        if (query === ISSUE_GROUP_QUERY) return { issue: { ...issue,
          children: groupConnection([{ ...groupChild(2), labels: groupConnection([{ name: "paseo" }], "next") }]),
        } };
        return { issue: { id: "child-2", labels: page } };
      });
      await assert.rejects(linear.issueGroup("i1"), /Linear/, `${field}: ${failure}`);
    }
  }
});

test("missing first-page metadata cannot be mistaken for a complete empty group or label list", async () => {
  for (const children of [
    { nodes: [] },
    groupConnection([{ ...groupChild(2), labels: { nodes: [] } }]),
  ]) {
    const { linear } = service(undefined, () => ({ issue: { ...issue, children } }));
    await assert.rejects(linear.issueGroup("i1"), /pagination metadata/);
  }
});

test("failed later child or label reads propagate and never return partial success", async () => {
  for (const field of ["children", "labels"] as const) {
    for (const failure of ["unavailable", "deleted", "rate limited"] as const) {
      const limited = new RateLimitedError("key", Date.now() + 60_000);
      const { linear } = service(undefined, (query, variables) => {
        if (query === ISSUE_GROUP_QUERY && variables.after === null) return { issue: { ...issue,
          children: field === "children" ? groupConnection([groupChild(2)], "next")
            : groupConnection([{ ...groupChild(2), labels: groupConnection([], "next") }]),
        } };
        if (failure === "deleted") return { issue: null };
        if (failure === "rate limited") throw limited;
        throw new Error("page unavailable");
      });
      await assert.rejects(linear.issueGroup("i1"), (error: unknown) => failure === "rate limited"
        ? error === limited : error instanceof Error, `${field}: ${failure}`);
    }
  }
});

test("a cursor cycle longer than one page also fails closed", async () => {
  const { linear } = service(undefined, (_query, variables) => ({
    issue: { ...issue, children: groupConnection([], variables.after === "a" ? "b" : "a") },
  }));
  await assert.rejects(linear.issueGroup("i1"), /repeated cursor/);
});

test("createIssue sends a client-chosen id with the assignee and priority, in Todo, and no project when none is given", async () => {  // TUC-1208 AC-9
  const inputs: Record<string, unknown>[] = [];
  const { linear } = service(undefined, (query, variables) => {
    if (query === TEAM_STATES_QUERY) return { team: { states: { nodes: [{ id: "triage", name: "Triage", type: "triage", position: 0 }, { id: "todo", name: "Todo", type: "unstarted", position: 1 }] } } };
    if (query === CREATE_ISSUE_QUERY) {
      inputs.push(variables.input as Record<string, unknown>);
      return { issueCreate: { success: true, issue: { id: ID_A, identifier: "TUC-9", url: "https://linear.app/t/issue/TUC-9" } } };
    }
    throw new Error(`unexpected query ${query}`);
  });
  const created = await linear.createIssue({ id: ID_A, teamId: "t1", projectId: null, title: "Greptile is not reviewing", description: "d", assigneeId: "owner", priority: 2, ready: true });
  assert.equal(created.id, ID_A);
  assert.deepEqual(inputs, [{ id: ID_A, teamId: "t1", title: "Greptile is not reviewing", description: "d", stateId: "todo", priority: 2, assigneeId: "owner" }]);
  await linear.createIssue({ teamId: "t1", title: "plain", description: "d" });
  assert.equal("id" in inputs[1], false);
});

test("issuesMentioning with openOnly filters on the description and leaves out finished tickets", async () => {  // TUC-1208 AC-9
  const filters: unknown[] = [];
  const { linear } = service(undefined, (query, variables) => {
    assert.equal(query, MENTIONING_ISSUES_QUERY);
    filters.push(variables.filter);
    return { issues: { nodes: [{ id: "i1", identifier: "TUC-7", title: "Greptile is not reviewing", url: "u", state: { name: "Todo", type: "unstarted" }, description: "Marker: `greptile-outage`", comments: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } };
  });
  const found = await linear.issuesMentioning("t1", "greptile-outage", true);
  assert.deepEqual(found.map((issue) => issue.identifier), ["TUC-7"]);
  assert.deepEqual(filters, [{ team: { id: { eq: "t1" } }, description: { contains: "greptile-outage" }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } }]);
});

// Outside a background context (owner-triggered and interactive reads); background reads go to the
// key first (background-pause.test.ts).
test("interactive reads go to the app's pool and never touch the key when the app can answer", async () => {
  const appCalls: string[] = [];
  const reader: Pick<App, "query"> = {
    query: (query, variables) => {
      appCalls.push(query);
      if ([ISSUE_STATE_QUERY, ISSUE_CORE_QUERY, ISSUE_METADATA_QUERY, ISSUE_STATUS_QUERY].includes(query)) return Promise.resolve({ issue });
      if (query === ISSUE_STATUSES_QUERY) return Promise.resolve({ issues: { nodes: (variables.ids as string[]).map((id) => ({ id, state: { type: "started" }, completedAt: null })) } });
      return Promise.resolve({ issues: { nodes: [{ id: "i1", identifier: "TUC-1", priority: 2, team: { key: "TUC" }, labels: { nodes: [] } }] } });
    },
  };
  const { linear, keyCalls } = service(reader, () => { throw new Error("the key must not be used"); });
  assert.equal((await linear.issueState("i1")).identifier, "TUC-1");
  assert.equal((await linear.issueCore("i1")).identifier, "TUC-1");
  assert.deepEqual(await linear.issueMetadata("i1"), { id: "i1", identifier: "TUC-1", labels: [] });
  assert.deepEqual(await linear.issueStatus("i1"), { status: "Todo", statusType: "unstarted" });
  assert.equal((await linear.issueStatuses([ID_A, ID_B])).size, 2);
  assert.equal((await linear.labeledIssues("paseo", ["TUC"])).length, 1);
  assert.deepEqual(appCalls, [ISSUE_STATE_QUERY, ISSUE_CORE_QUERY, ISSUE_METADATA_QUERY, ISSUE_STATUS_QUERY, ISSUE_STATUSES_QUERY, LABELED_ISSUES_QUERY]);
  assert.deepEqual(keyCalls, []);
});

test("the key reads once when the app is not usable here", async () => {
  const { linear, keyCalls } = service({ query: () => Promise.resolve(null) }, () => ({ issue }));
  await linear.issueState("i1");
  await linear.issueCore("i1");
  await linear.issueMetadata("i1");
  await linear.issueStatus("i1");
  await linear.issueAttachments("i1");
  await linear.issueWatchState("i1");
  assert.deepEqual(keyCalls, [ISSUE_STATE_QUERY, ISSUE_CORE_QUERY, ISSUE_METADATA_QUERY, ISSUE_STATUS_QUERY, ISSUE_ATTACHMENT_URLS_QUERY, ISSUE_WATCH_STATE_QUERY]);
});

test("tickets the app cannot see are read with the key", async () => {
  const missingIssue = service({ query: () => Promise.resolve({ issue: null }) }, () => ({ issue }));
  assert.equal((await missingIssue.linear.issueState("i1")).identifier, "TUC-1");
  assert.equal((await missingIssue.linear.issueCore("i1")).identifier, "TUC-1");
  assert.equal((await missingIssue.linear.issueMetadata("i1")).identifier, "TUC-1");
  assert.equal((await missingIssue.linear.issueStatus("i1")).statusType, "unstarted");
  assert.deepEqual(await missingIssue.linear.issueAttachments("i1"), []);
  assert.deepEqual(await missingIssue.linear.issueWatchState("i1"), { status: "Todo", statusType: "unstarted", labels: [] });
  assert.deepEqual(missingIssue.keyCalls, [ISSUE_STATE_QUERY, ISSUE_CORE_QUERY, ISSUE_METADATA_QUERY, ISSUE_STATUS_QUERY, ISSUE_ATTACHMENT_URLS_QUERY, ISSUE_WATCH_STATE_QUERY]);

  const notFound = service({ query: () => Promise.reject(new Error("The Linear API request failed: Entity not found: Issue")) }, () => ({ issue }));
  await notFound.linear.issueState("i1");
  await notFound.linear.issueCore("i1");
  assert.deepEqual(notFound.keyCalls, [ISSUE_STATE_QUERY, ISSUE_CORE_QUERY]);

  // Neither pool returns the ticket: the read fails rather than decide on empty fields.
  const nowhere = service({ query: () => Promise.resolve({ issue: null }) }, () => ({ issue: null }));
  await assert.rejects(nowhere.linear.issueCore("i1"), /did not return this issue/);
  assert.deepEqual(nowhere.keyCalls, [ISSUE_CORE_QUERY]);

  // The app sees one of two tickets: the key answers for the whole batch, so the blocker is not taken for deleted.
  const partial = service(
    { query: () => Promise.resolve({ issues: { nodes: [{ id: ID_A, state: { type: "completed" }, completedAt: "2026-09-28T00:00:00Z" }] } }) },
    () => ({ issues: { nodes: [{ id: ID_A, state: { type: "completed" }, completedAt: "2026-09-28T00:00:00Z" }, { id: ID_B, state: { type: "started" }, completedAt: null }] } }),
  );
  const statuses = await partial.linear.issueStatuses([ID_A, ID_B]);
  assert.equal(statuses.get(ID_B)?.statusType, "started");
  assert.deepEqual(partial.keyCalls, [ISSUE_STATUSES_QUERY]);
});

test("the status batch asks for exactly the rows of its chunk (AC-11): two ids send first: 2, 300 send 250 + 50", async () => {
  const asked: Record<string, unknown>[] = [];
  const reader: Pick<App, "query"> = {
    query: (query, variables) => {
      assert.equal(query, ISSUE_STATUSES_QUERY);
      asked.push(variables);
      return Promise.resolve({ issues: { nodes: (variables.ids as string[]).map((id) => ({ id, state: { name: "Todo", type: "unstarted" }, completedAt: null })) } });
    },
  };
  const { linear, keyCalls } = service(reader, () => { throw new Error("the key must not be used"); });
  assert.equal((await linear.issueStatuses([ID_A, ID_B])).size, 2);
  assert.deepEqual(asked, [{ ids: [ID_A, ID_B], first: 2 }]);

  asked.length = 0;
  const ids = Array.from({ length: 300 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  assert.equal((await linear.issueStatuses(ids)).size, 300);
  assert.deepEqual(asked.map((variables) => ({ first: variables.first, count: (variables.ids as string[]).length })), [{ first: 250, count: 250 }, { first: 50, count: 50 }]);
  assert.deepEqual((asked[0].ids as string[]).concat(asked[1].ids as string[]), ids, "the chunks cover every id in order, without overlap");
  assert.deepEqual(keyCalls, []);
});

// TUC-1684: the queue's batch decides admission on the same parsed fields as a single read.
test("the admission batch parses a ticket exactly as issueState does, once per id, and leaves out tickets Linear does not return", async () => {
  const node = {
    id: "i1", identifier: "TUC-1", title: "Queue blocker: PostgreSQL integration", priority: 2, createdAt: "2026-10-01T00:00:00Z", state: { id: "s1", name: "Todo", type: "unstarted" }, project: { id: "p1" }, labels: { nodes: [{ id: "l1", name: "paseo" }] },
    inverseRelations: { nodes: [
      { type: "blocks", issue: { id: "b1", identifier: "TUC-8", state: { name: "In Progress", type: "started" }, attachments: { nodes: [] } } },
      { type: "blocks", issue: { id: "b2", identifier: "TUC-9", state: { name: "Done", type: "completed" }, attachments: { nodes: [] } } },
      { type: "related", issue: { id: "r1", identifier: "TUC-10", state: { name: "Todo", type: "unstarted" }, attachments: { nodes: [] } } },
    ] },
    relations: { nodes: [{ type: "blocks", relatedIssue: { state: { type: "unstarted" } } }, { type: "blocks", relatedIssue: { state: { type: "completed" } } }] },
  };
  const asked: string[][] = [];
  const { linear } = service({ query: (query, variables) => {
    if (query === ISSUE_STATE_QUERY) return Promise.resolve({ issue: node });
    asked.push(variables.ids as string[]);
    return Promise.resolve({ issues: { nodes: [node] } });
  } }, () => ({ issues: { nodes: [node] } }));
  const single = await linear.issueState("i1");
  const batch = await linear.admissionStates(["i1", "gone", "i1"]);
  assert.deepEqual(asked, [["i1", "gone"]]);
  const read = batch.get("i1")!;
  for (const field of ["id", "identifier", "status", "statusType", "projectId", "labels", "blockedBy", "priority", "createdAt", "unblocks", "queueBlocker"] as const) assert.deepEqual(read[field], single[field], field);
  assert.equal(read.queueBlocker, true, "the alert's title prefix marks a queue blocker");
  assert.deepEqual(read.blockedBy, ["TUC-8"]);
  assert.equal(batch.has("gone"), false);
});

test("hasComment looks a marker up among the ticket's comments, counts only a body that carries it whole, and fails rather than answer for a ticket Linear does not return", async () => {
  const asked: Record<string, unknown>[] = [];
  const mark = "`queue-backstop:drop:#437:419`";
  const marked = (bodies: string[]) => service({ query: (query, variables) => {
    assert.equal(query, MARKED_COMMENT_QUERY);
    asked.push(variables);
    return Promise.resolve({ issue: { comments: { nodes: bodies.map((body, index) => ({ id: `c${index}`, body })) } } });
  } }, () => { throw new Error("the key must not be used"); });
  assert.equal(await marked([`Enqueued.\n\n${mark}`]).linear.hasComment("i1", mark), true);
  assert.equal(await marked([]).linear.hasComment("i1", mark), false);
  // Linear's filter matched a comment that does not carry the whole mark: another action's.
  assert.equal(await marked(["Enqueued.\n\n`queue-backstop:drop:#437:4190`"]).linear.hasComment("i1", mark), false, "only the exact mark counts");
  assert.equal(await marked(["Enqueued.\n\n`queue-backstop:drop:#437:4190`", `Enqueued.\n\n${mark}`]).linear.hasComment("i1", mark), true, "among other matches");
  assert.deepEqual(asked, Array.from({ length: 4 }, () => ({ id: "i1", text: mark })));
  const missing = service({ query: () => Promise.resolve({ issue: null }) }, () => ({ issue: null }));
  await assert.rejects(missing.linear.hasComment("i1", "queue-backstop:x"), /did not return the ticket/);
  assert.deepEqual(missing.keyCalls, [MARKED_COMMENT_QUERY], "a ticket the app cannot see is read with the key first");
});

test("an app rate limit pauses an interactive read instead of spending the key", async () => {
  const limited = new RateLimitedError("app", Date.now() + 60_000);
  const { linear, keyCalls } = service({ query: () => Promise.reject(limited) }, () => ({ issue }));
  await assert.rejects(linear.issueState("i1"), (error: unknown) => error === limited);
  await assert.rejects(linear.issueCore("i1"), (error: unknown) => error === limited);
  await assert.rejects(linear.issueMetadata("i1"), (error: unknown) => error === limited);
  await assert.rejects(linear.issueStatus("i1"), (error: unknown) => error === limited);
  await assert.rejects(linear.issueAttachments("i1"), (error: unknown) => error === limited);
  await assert.rejects(linear.issueWatchState("i1"), (error: unknown) => error === limited);
  await assert.rejects(linear.labeledIssues("paseo", ["TUC"]), RateLimitedError);
  await assert.rejects(linear.issueStatuses([ID_A, ID_B]), RateLimitedError);
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

// Through the app's token `isMe` is the Paseo app, which is assigned nothing: the server returned
// no asks at all while the owner had 38 in Needs input.
test("owner collection uses the owner's credential and reaches normal asks beyond five pages", async () => {
  const appQueries: string[] = [];
  let page = 0;
  const { linear } = service({ query: (query) => { appQueries.push(query); return Promise.resolve({ issues: groupConnection([]) }); } }, (query, variables) => {
    assert.equal(query, OWNER_ASKS_QUERY);
    assert.ok(variables.filter && typeof variables.filter === "object" && "assignee" in variables.filter);
    assert.deepEqual(variables.filter.assignee, { isMe: { eq: true } });
    page++;
    return { issues: groupConnection([{ ...issue, id: `i${page}`, identifier: `TUC-${page}`, description: page === 7 ? "Which deployment region?" : "" }], page < 7 ? `c${page}` : null) };
  });
  const asks = await linear.ownerAskIssues(true);
  assert.deepEqual(appQueries, []);
  assert.equal(asks.find(item => item.identifier === "TUC-7")?.description, "Which deployment region?");
  assert.deepEqual(asks.map(item => item.id), ["i1", "i2", "i3", "i4", "i5", "i6", "i7"]);
});

test("owner issue inventory reads 201 issues in three pages without dropping the last decision", async () => {
  const issues = Array.from({ length: 201 }, (_, index) => ({
    ...issue, id: `issue-${index}`, identifier: `TUC-${index}`,
    description: index === 200 ? "Approve the final issue?" : "",
  }));
  let requests = 0;
  const { linear } = service(undefined, (query, variables) => {
    assert.equal(query, OWNER_ASKS_QUERY);
    assert.equal(variables.first, 100);
    const start = variables.after === null ? 0 : Number(variables.after);
    const end = Math.min(start + Number(variables.first), issues.length);
    requests++;
    return { issues: groupConnection(issues.slice(start, end), end < issues.length ? String(end) : null) };
  });
  const found = await linear.ownerAskIssues(true);
  assert.equal(requests, 3);
  assert.equal(found.length, 201);
  assert.equal(found.at(-1)?.description, "Approve the final issue?");
});

test("owner collection refuses a repeating issue cursor instead of claiming completeness", async () => {
  const { linear } = service(undefined, () => ({ issues: groupConnection([issue], "repeated") }));
  await assert.rejects(linear.ownerAskIssues(true), /repeated owner-issue cursor/);
});

test("owner comment inventory covers a large inbox in two bounded reads without mixing tickets", async () => {
  const ids = Array.from({ length: 26 }, (_, index) => `issue-${index}`);
  const batchSizes: number[] = [];
  const { linear } = service(undefined, (_query, variables) => {
    const entries = Object.entries(variables).filter(([name]) => /^i\d+$/.test(name));
    batchSizes.push(entries.length);
    return Object.fromEntries(entries.map(([name, id]) => [`t${name.slice(1)}`, groupConnection([{
      comments: groupConnection([{ id: `ask-${id}`, body: `Decision for ${id}?`, createdAt: "2026-10-15T00:00:00Z" }]),
    }])]));
  });
  const found = await linear.ownerAskComments(ids);
  assert.deepEqual(batchSizes, [25, 1]);
  assert.deepEqual(ids.map(id => found.get(id)?.[0]?.id), ids.map(id => `ask-${id}`));
});

test("owner comment inventory reaches an old unresolved question while other issues finish early", async () => {
  const recent = Array.from({ length: 50 }, (_, i) => ({ id: `recent-${i}`, body: "Progress update", createdAt: "2026-10-14T00:00:00Z" }));
  const oldAsk = { id: "old-question", body: "A: EU region or B: US region?", createdAt: "2026-10-01T00:00:00Z" };
  const { linear } = service(undefined, (_query, variables) => variables.a0
    ? { t0: groupConnection([{ comments: groupConnection([oldAsk]) }]) }
    : { t0: groupConnection([{ comments: groupConnection(recent, "older") }]), t1: groupConnection([{ comments: groupConnection([]) }]) });
  const found = await linear.ownerAskComments([ID_A, ID_B]);
  assert.deepEqual(found.get(ID_A)?.at(-1), oldAsk);
  assert.deepEqual(found.get(ID_B), []);
});

test("a slow issue batch does not stall other histories or lose their older owner question", async () => {
  const ids = Array.from({ length: 51 }, (_, index) => `issue-${index}`);
  let release!: () => void;
  let enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const oldAsk = { id: "old-owner-question", body: "Which legal entity may sign?", createdAt: "2026-10-01T00:00:00Z" };
  let otherHistoryFinished = false;
  const post: Post = async (_key, _query, variables) => {
    if (variables.i0 === "issue-0") {
      enter();
      await blocked;
    }
    return Object.fromEntries(Object.entries(variables).filter(([name]) => /^i\d+$/.test(name)).map(([name, id]) => {
      const suffix = name.slice(1);
      if (id !== "issue-25") return [`t${suffix}`, groupConnection([{ comments: groupConnection([]) }])];
      if (variables[`a${suffix}`] === "older") {
        otherHistoryFinished = true;
        return [`t${suffix}`, groupConnection([{ comments: groupConnection([oldAsk]) }])];
      }
      return [`t${suffix}`, groupConnection([{ comments: groupConnection([], "older") }])];
    }));
  };
  const linear = new LinearService(new Credentials("/unused", "env-key"), post);
  const pending = linear.ownerAskComments(ids);
  await entered;
  try {
    // All injected I/O except the held first page is immediately ready.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(otherHistoryFinished, true, "independent cursor walks must not wait for the held batch");
  } finally {
    release();
    await pending;
  }
  const found = await pending;
  assert.deepEqual(found.get("issue-25"), [oldAsk]);
  assert.deepEqual(found.get("issue-0"), []);
  assert.deepEqual([...found.keys()].sort(), ids.sort(), "return only the complete inventory");
});

test("a failed history inventory drains its active reads and never returns partial comments", async (t) => {
  for (const fault of ["cursor", "missing issue", "rate limit"] as const) {
    await t.test(fault, async () => {
      let release!: () => void;
      let enter!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const limited = new RateLimitedError("key", Date.now() + 60_000);
      const post: Post = async (_key, _query, variables) => {
        if (variables.i0 === "issue-0") {
          enter();
          await blocked;
          return Object.fromEntries(Object.entries(variables).filter(([name]) => /^i\d+$/.test(name))
            .map(([name]) => [`t${name.slice(1)}`, groupConnection([{ comments: groupConnection([]) }])]));
        }
        if (fault === "rate limit") throw limited;
        if (fault === "missing issue") return {};
        return { t0: groupConnection([{ comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }]) };
      };
      const linear = new LinearService(new Credentials("/unused", "env-key"), post);
      const pending = linear.ownerAskComments(Array.from({ length: 26 }, (_, index) => `issue-${index}`));
      let settled = false;
      const observed = pending.then(() => { settled = true; }, () => { settled = true; });
      await entered;
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, false, "a failed collection must settle its outstanding read before retry is possible");
      } finally {
        release();
        await observed;
      }
      await assert.rejects(pending, fault === "rate limit"
        ? (error: unknown) => error === limited
        : /incomplete or repeated comment cursor|could not read owner-question comments/);
    });
  }
});

test("an incomplete comment cursor rejects the owner inventory rather than dropping asks", async () => {
  const { linear } = service(undefined, () => ({ t0: groupConnection([{ comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }]) }));
  await assert.rejects(linear.ownerAskComments([ID_A]), /incomplete or repeated comment cursor/);
});

test("owner comment changes cover a large inventory in bounded filters, follow pages and group by issue", async () => {
  const ids = Array.from({ length: 501 }, (_, index) => `issue-${index}`);
  const filters: { ids: number; since: string; after: unknown }[] = [];
  const { linear } = service(undefined, (_query, variables) => {
    const filter = variables.filter as { updatedAt: { gte: string }; issue: { id: { in: string[] } } };
    filters.push({ ids: filter.issue.id.in.length, since: filter.updatedAt.gte, after: variables.after });
    const node = (id: string, issueId: string) => ({ id, body: `Edited ${id}?`, createdAt: "2026-10-16T00:00:00Z", issue: { id: issueId } });
    if (filter.issue.id.in.includes("issue-500")) return { comments: groupConnection([node("last", "issue-500")]) };
    return variables.after === null
      ? { comments: groupConnection([node("a", "issue-0"), node("b", "issue-1")], "page-2") }
      : { comments: groupConnection([node("c", "issue-0")]) };
  });
  const found = await linear.ownerAskCommentChanges(ids, "2026-10-16T00:00:00.000Z");
  assert.deepEqual(filters, [
    { ids: 500, since: "2026-10-16T00:00:00.000Z", after: null },
    { ids: 500, since: "2026-10-16T00:00:00.000Z", after: "page-2" },
    { ids: 1, since: "2026-10-16T00:00:00.000Z", after: null },
  ]);
  assert.deepEqual(Object.fromEntries([...found].map(([id, list]) => [id, list.map(comment => comment.id)])),
    { "issue-0": ["a", "c"], "issue-1": ["b"], "issue-500": ["last"] });
});

// TUC-1324: status moves and label removal read the ticket without its relations. A real
// LinearService whose app answers reads and writes; `sent` lists each operation sent on either
// pool (state writes with their target), and the 498-point ISSUE_STATE_QUERY is refused outright.
const TEAM = [
  { id: "todo", name: "Todo", type: "unstarted", position: 1 },
  // AC-7 (TUC-1289): the plan stages sit before In Review, so a review move that took the first
  // started state named for review would land in Plan review.
  { id: "plan-review", name: "Plan review", type: "started", position: 1.6 },
  { id: "plan-approved", name: "Plan approved", type: "started", position: 1.7 },
  { id: "coding", name: "In Progress", type: "started", position: 2 },
  { id: "planning", name: "Planning", type: "started", position: 3 },
  { id: "review", name: "In Review", type: "started", position: 4 },
  { id: "done", name: "Done", type: "completed", position: 5 },
  { id: "canceled", name: "Canceled", type: "canceled", position: 6 },
  { id: "dup", name: "Duplicate", type: "duplicate", position: 7 },
];
function ticket(stateId: string, labels: { id: string; name: string }[] = []) {
  const { id, name, type } = TEAM.find((item) => item.id === stateId)!;
  return { id: "i1", identifier: "TUC-1", state: { id, name, type }, team: { id: "t1" }, labels: { nodes: labels }, attachments: { nodes: [] } };
}
function mover(node: Record<string, unknown>) {
  const sent: string[] = [];
  const answer = (query: string, variables: Record<string, unknown>): Record<string, unknown> => {
    const operation = /^\s*(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "unknown";
    sent.push(operation === "issueUpdateState" ? `${operation} ${variables.stateId}` : operation);
    if (query === ISSUE_CORE_QUERY) return { issue: node };
    if (query === TEAM_STATES_QUERY) return { team: { states: { nodes: TEAM } } };
    if (operation === "issueUpdateState") return { issueUpdate: { success: true, issue: { id: "i1", state: { name: "Moved", type: "started" } } } };
    if (operation === "comment") return { commentCreate: { success: true, comment: { id: "c1" } } };
    if (operation === "removeLabel") return { issueRemoveLabel: { success: true } };
    throw new Error(`unexpected operation ${operation}`);
  };
  const app: App = { query: async (query, variables) => answer(query, variables), mutate: async (query, variables) => answer(query, variables), viewer: () => Promise.reject(new Error("no viewer here")) };
  return { sent, linear: new LinearService(new Credentials("/unused", "env-key"), async (_key, query, variables) => answer(query, variables), app) };
}
const CORE: IssueCore = { id: "i1", identifier: "TUC-1", status: "Todo", statusId: "todo", statusType: "unstarted", teamId: "t1", projectId: null, creatorId: null, labels: [{ id: "l1", name: "paseo-needs-you" }], attachmentUrls: [] };
const NEEDS_YOU = [{ id: "l1", name: "Paseo-Needs-You" }];

// Each helper keeps its own rule for closed tickets (README, "Rate limits"): one case it leaves alone, one it writes.
const MOVES: { name: string; node?: Record<string, unknown>; run: (linear: LinearService) => Promise<unknown>; sent: string[] }[] = [
  { name: "complete leaves a Done ticket alone", node: ticket("done"), run: (linear) => linear.complete("i1"), sent: ["issueCore"] },
  { name: "complete moves a canceled ticket to Done", node: ticket("canceled"), run: (linear) => linear.complete("i1"), sent: ["issueCore", "teamStates", "issueUpdateState done"] },
  { name: "cancel leaves a duplicate alone", node: ticket("dup"), run: (linear) => linear.cancel("i1", "Not needed."), sent: ["issueCore"] },
  { name: "cancel posts the reason and cancels an open ticket", node: ticket("todo"), run: (linear) => linear.cancel("i1", "Not needed."), sent: ["issueCore", "teamStates", "comment", "issueUpdateState canceled"] },
  { name: "moveToStateNamed leaves a canceled ticket alone", node: ticket("canceled"), run: (linear) => linear.moveToStateNamed("i1", "Planning"), sent: ["issueCore"] },
  { name: "moveToStateNamed moves an open ticket", node: ticket("todo"), run: (linear) => linear.moveToStateNamed("i1", "Planning"), sent: ["issueCore", "teamStates", "issueUpdateState planning"] },
  { name: "moveToStateNamed decides on the caller's read without reading", run: (linear) => linear.moveToStateNamed("i1", "Planning", CORE), sent: ["teamStates", "issueUpdateState planning"] },
  { name: "moveToReady leaves an unstarted ticket alone", node: ticket("todo"), run: (linear) => linear.moveToReady("i1"), sent: ["issueCore"] },
  { name: "moveToReady moves a started ticket to Todo", node: ticket("coding"), run: (linear) => linear.moveToReady("i1"), sent: ["issueCore", "teamStates", "issueUpdateState todo"] },
  { name: "reopen leaves a ticket already in Todo alone", node: ticket("todo"), run: (linear) => linear.reopen("i1"), sent: ["issueCore", "teamStates"] },
  { name: "reopen moves a Done ticket to Todo", node: ticket("done"), run: (linear) => linear.reopen("i1"), sent: ["issueCore", "teamStates", "issueUpdateState todo"] },
  { name: "reopenToCoding leaves a canceled ticket alone", node: ticket("canceled"), run: (linear) => linear.reopenToCoding("i1"), sent: ["issueCore"] },
  { name: "reopenToCoding moves a Done ticket back to work", node: ticket("done"), run: (linear) => linear.reopenToCoding("i1"), sent: ["issueCore", "teamStates", "issueUpdateState coding"] },
  { name: "reopenToCoding decides on the caller's read without reading", run: (linear) => linear.reopenToCoding("i1", { ...CORE, status: "Done", statusId: "done", statusType: "completed" }), sent: ["teamStates", "issueUpdateState coding"] },
  { name: "moveToReview leaves a Done ticket alone", node: ticket("done"), run: (linear) => linear.moveToReview("i1"), sent: ["issueCore"] },
  { name: "moveToReview moves a started ticket to review", node: ticket("coding"), run: (linear) => linear.moveToReview("i1"), sent: ["issueCore", "teamStates", "issueUpdateState review"] },
  { name: "moveToReview moves a duplicate too (only completed and canceled stay)", node: ticket("dup"), run: (linear) => linear.moveToReview("i1"), sent: ["issueCore", "teamStates", "issueUpdateState review"] },
  { name: "AC-7: moveToReview moves a ticket out of Plan review to In Review", node: ticket("plan-review"), run: (linear) => linear.moveToReview("i1"), sent: ["issueCore", "teamStates", "issueUpdateState review"] },
  { name: "AC-7: moveToReview leaves a ticket already In Review alone", node: ticket("review"), run: (linear) => linear.moveToReview("i1"), sent: ["issueCore"] },
  { name: "moveToPlanStage leaves a Done ticket alone", node: ticket("done"), run: (linear) => linear.moveToPlanStage("i1", "Plan review"), sent: ["issueCore"] },
  { name: "moveToPlanStage moves Planning to Plan review", node: ticket("planning"), run: (linear) => linear.moveToPlanStage("i1", "Plan review"), sent: ["issueCore", "teamStates", "issueUpdateState plan-review"] },
  { name: "moveToPlanStage leaves a ticket already in Plan review alone", node: ticket("plan-review"), run: (linear) => linear.moveToPlanStage("i1", "Plan review"), sent: ["issueCore", "teamStates"] },
  { name: "moveToPlanStage moves Plan review to Plan approved", node: ticket("plan-review"), run: (linear) => linear.moveToPlanStage("i1", "Plan approved"), sent: ["issueCore", "teamStates", "issueUpdateState plan-approved"] },
  { name: "moveToPlanStage moves Todo to Plan approved", node: ticket("todo"), run: (linear) => linear.moveToPlanStage("i1", "Plan approved"), sent: ["issueCore", "teamStates", "issueUpdateState plan-approved"] },
  { name: "moveToPlanStage never moves In Progress back to Plan approved", node: ticket("coding"), run: (linear) => linear.moveToPlanStage("i1", "Plan approved"), sent: ["issueCore"] },
  { name: "moveToPlanStage never moves In Review back to Plan approved", node: ticket("review"), run: (linear) => linear.moveToPlanStage("i1", "Plan approved"), sent: ["issueCore"] },
  { name: "moveToPlanStage sends In Progress back to Planning (a send-back)", node: ticket("coding"), run: (linear) => linear.moveToPlanStage("i1", "Planning"), sent: ["issueCore", "teamStates", "issueUpdateState planning"] },
  { name: "removeLabel leaves a ticket without the label alone", node: ticket("todo"), run: (linear) => linear.removeLabel("i1", "paseo-needs-you"), sent: ["issueCore"] },
  { name: "removeLabel removes the label whatever its case", node: ticket("todo", NEEDS_YOU), run: (linear) => linear.removeLabel("i1", "paseo-needs-you"), sent: ["issueCore", "removeLabel"] },
  { name: "removeLabel decides on the caller's labels without reading", run: (linear) => linear.removeLabel("i1", "paseo-needs-you", CORE.labels), sent: ["removeLabel"] },
];
for (const row of MOVES) {
  test(`${row.name}, never reading the ticket's relations`, async () => {
    const { linear, sent } = mover(row.node ?? {});
    await row.run(linear);
    assert.deepEqual(sent, row.sent);
  });
}

test("issueCore keeps exactly the fields it reads from one answer, on a cold service, and a status move decides on them", async () => {
  const node = {
    id: "i1", identifier: "TUC-1", state: { id: "planning", name: "Planning", type: "started" }, team: { id: "t1" }, project: { id: "p1" }, creator: { id: "u1" },
    labels: { nodes: [{ id: "l1", name: "paseo" }] }, attachments: { nodes: [{ url: "https://github.com/o/r/pull/1" }] },
  };
  const { linear, sent } = mover(node);
  assert.deepEqual(await linear.issueCore("i1"), {
    id: "i1", identifier: "TUC-1", status: "Planning", statusId: "planning", statusType: "started", teamId: "t1", projectId: "p1", creatorId: "u1",
    labels: [{ id: "l1", name: "paseo" }], attachmentUrls: ["https://github.com/o/r/pull/1"],
  });
  assert.deepEqual(await linear.moveToReview("i1"), { changed: true });
  assert.deepEqual(sent, ["issueCore", "issueCore", "teamStates", "issueUpdateState review"]);
});

const commentNode = (id: string, at: string, author = "u-owner") => ({ id, body: `Comment ${id}`, createdAt: at, updatedAt: at, url: `https://linear.app/tuc/comment/${id}`, user: { id: author } });
const commentPage = (nodes: unknown[], after: string | null) => ({ nodes, pageInfo: { hasNextPage: after !== null, endCursor: after } });

test("issueCommentHistory reads every page of one ticket's comments, oldest first", async () => {
  const { keyCalls, linear } = service(undefined, (query, variables) => {
    assert.equal(query, ISSUE_COMMENT_HISTORY_QUERY);
    assert.equal(variables.id, "i1");
    if (variables.after === null) return { issue: { id: "i1", comments: commentPage([commentNode("k1", "2026-10-01T07:00:00Z"), commentNode("k2", "2026-10-01T08:00:00Z", "app-1")], "cursor-2") } };
    assert.equal(variables.after, "cursor-2", "the next page is read with the cursor Linear returned");
    return { issue: { id: "i1", comments: commentPage([commentNode("k3", "2026-10-02T07:00:00Z")], null) } };
  });
  assert.deepEqual(await linear.issueCommentHistory("i1"), [
    { id: "k1", body: "Comment k1", createdAt: "2026-10-01T07:00:00Z", updatedAt: "2026-10-01T07:00:00Z", url: "https://linear.app/tuc/comment/k1", authorId: "u-owner" },
    { id: "k2", body: "Comment k2", createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-01T08:00:00Z", url: "https://linear.app/tuc/comment/k2", authorId: "app-1" },
    { id: "k3", body: "Comment k3", createdAt: "2026-10-02T07:00:00Z", updatedAt: "2026-10-02T07:00:00Z", url: "https://linear.app/tuc/comment/k3", authorId: "u-owner" },
  ]);
  assert.equal(keyCalls.length, 2, "one read per page and nothing else");
});


test("a comment Linear returns without its id, body or timestamps, or without the user field it was asked for, refuses the whole history", async () => {
  const whole = commentNode("k1", "2026-10-01T07:00:00Z");
  for (const broken of [
    { ...whole, id: undefined },
    { ...whole, body: null },
    { ...whole, createdAt: "" },
    { ...whole, updatedAt: 7 },
    // `user: null` is Linear's own answer for a comment an app or bot actor wrote (read as valid
    // below), so only a user field the answer did not return, or returned malformed, refuses.
    { ...whole, user: undefined },
    { ...whole, user: "someone" },
    { ...whole, user: {} },
    { ...whole, user: { id: "" } },
    { ...whole, user: { id: 7 } },
    "not-a-comment",
  ]) {
    const { linear } = service(undefined, () => ({ issue: { id: "i1", comments: commentPage([broken], null) } }));
    await assert.rejects(linear.issueCommentHistory("i1"), /ticket comment|unexpected response/, JSON.stringify(broken));
  }
});

test("a comment Linear attributes to no user is read as valid, beside the owner's own comments", async () => {
  // Linear's real answer for a comment an app or bot actor wrote: `user: null` is part of the
  // answer, not a read that went missing, so it does not refuse the history the owner's own
  // comment is read from.
  const { linear } = service(undefined, () => ({ issue: { id: "i1", comments: commentPage([commentNode("k1", "2026-10-01T07:00:00Z"), { ...commentNode("k2", "2026-10-01T08:00:00Z"), user: null }], null) } }));
  assert.deepEqual(await linear.issueCommentHistory("i1"), [
    { id: "k1", body: "Comment k1", createdAt: "2026-10-01T07:00:00Z", updatedAt: "2026-10-01T07:00:00Z", url: "https://linear.app/tuc/comment/k1", authorId: "u-owner" },
    { id: "k2", body: "Comment k2", createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-01T08:00:00Z", url: "https://linear.app/tuc/comment/k2", authorId: null },
  ]);
});

test("an unknown or unfinished comment page state refuses the history instead of passing as its end", async () => {
  for (const [comments, expected] of [
    [{ nodes: [], pageInfo: {} }, /pagination metadata/],
    [{ nodes: [] }, /pagination metadata/],
    [{ nodes: [], pageInfo: { hasNextPage: null } }, /pagination metadata/],
    [{ nodes: [], pageInfo: { hasNextPage: true } }, /missing or repeated cursor/],
    [{ nodes: "later" }, /did not return the comment history/],
    [null, /did not return the comment history/],
  ] as const) {
    const { linear } = service(undefined, () => ({ issue: { id: "i1", comments } }));
    await assert.rejects(linear.issueCommentHistory("i1"), expected, JSON.stringify(comments));
  }
  const { linear } = service(undefined, () => ({ issue: { id: "i1", comments: commentPage([], null) } }));
  assert.deepEqual(await linear.issueCommentHistory("i1"), [], "a ticket with no comments has a complete history");
});

test("a repeated cursor and a history longer than one read allows both fail closed", async () => {
  const repeated = service(undefined, () => ({ issue: { id: "i1", comments: commentPage([], "same-cursor") } }));
  await assert.rejects(repeated.linear.issueCommentHistory("i1"), /missing or repeated cursor/);
  let page = 0;
  const endless = service(undefined, () => ({ issue: { id: "i1", comments: commentPage([], `cursor-${++page}`) } }));
  await assert.rejects(endless.linear.issueCommentHistory("i1"));
  assert.equal(page, 50, "an unfinished history must stop at the bounded page limit");
});

test("a ticket Linear does not return, and a failed comment read, refuse the history", async () => {
  const missing = service(undefined, () => ({ issue: null }));
  await assert.rejects(missing.linear.issueCommentHistory("i1"), /did not return the ticket whose comment history/);
  const limited = new RateLimitedError("key", Date.now() + 60_000);
  const paused = service(undefined, () => { throw limited; });
  await assert.rejects(paused.linear.issueCommentHistory("i1"), (error: unknown) => error === limited);
  const failed = service(undefined, () => { throw new LinearApiError("Linear answered HTTP 500", 500); });
  await assert.rejects(failed.linear.issueCommentHistory("i1"), /HTTP 500/);
});
