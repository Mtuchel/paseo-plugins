import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Credentials } from "./credentials";
import { CREATE_ISSUE_QUERY, LinearService, postGraphQL, RELATION_QUERY, TEAM_STATES_QUERY, type App } from "./linear";
import { MAX_ATTEMPTS, PlanFollowUps, RETRY_MS, type FollowUpRecord } from "./plan-follow-ups";
import { RateBudget, RateLimitedError, withPriority } from "./rate-budget";
import { AgentApi } from "./agent-app";

const PLAN = "# Plan\n\n## Reach\n\n- Changes: the delivery date\n- Help page: follow-up — Document the delivery date\n- Mobile app: follow-up — Show the delivery date on mobile\n\n## Principles and rules\n\nNone apply; no new rule.\n\n## Risk and impact\n\n- Impact: 0\n";
const ORIGIN = { issueId: "origin-1", identifier: "TUC-50", plan: PLAN, documentUrl: "https://linear.app/doc/plan" };
type Mode = "ok" | "null" | "throw" | RateLimitedError;
type Ticket = { teamId: string; projectId: string; creatorId: string; labels: { id: string; name: string }[] };
type FollowUpLinear = Pick<LinearService, "issueState" | "viewerId" | "appUserId" | "createIssueAsApp" | "relateAsApp" | "comment">;
type Harness = { calls: string[]; mode: { create: Mode; relate: Mode; comment: Mode }; ticket: Ticket; linear: FollowUpLinear; followUps: PlanFollowUps; directory: string; later: (ms: number) => void };

// Linear as plan-follow-ups.ts sees it; `mode` decides how each write answers.
function fakeLinear() {
  const calls: string[] = [];
  const mode: Harness["mode"] = { create: "ok", relate: "ok", comment: "ok" };
  const ticket: Ticket = { teamId: "team-1", projectId: "project-1", creatorId: "owner", labels: [] };
  let created = 0;
  const answer = <T>(which: Mode, value: T): T | null => {
    if (which instanceof RateLimitedError) throw which;
    if (which === "throw") throw new Error("Linear is down");
    return which === "null" ? null : value;
  };
  const linear = {
    async issueState() { return { ...ticket } as never; },
    async viewerId() { return "owner"; },
    async appUserId() { return "paseo-app"; },
    async createIssueAsApp(input: { teamId: string; projectId?: string | null; ready?: boolean; title: string; description: string }) {
      calls.push(`create "${input.title}" ${input.teamId} ${input.projectId} ready=${input.ready}`);
      const result = answer(mode.create, { id: `new-${created + 1}`, identifier: `TUC-${101 + created}`, url: `https://linear.app/TUC-${101 + created}` });
      if (result) created += 1;
      return result;
    },
    async relateAsApp(issueId: string, relatedId: string, type: string) {
      calls.push(`relate ${issueId} ${relatedId} ${type}`);
      return answer(mode.relate, true as const);
    },
    async comment(issueId: string, body: string) {
      calls.push(`comment ${issueId}: ${body}`);
      answer(mode.comment, true);
    },
  };
  return { calls, mode, ticket, linear };
}

async function withFollowUps(run: (h: Harness) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-follow-ups-"));
  let now = Date.parse("2026-10-04T12:00:00Z");
  const fake = fakeLinear();
  try {
    await run({ ...fake, followUps: new PlanFollowUps(fake.linear, directory, () => now), directory, later: (ms) => { now += ms; } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const comments = (calls: string[]) => calls.filter((call) => call.startsWith("comment "));

test("the create and relate of a follow-up go only through the Paseo app, never the owner's key", async () => {
  const keyed: string[] = [];
  const post = async (_key: string, query: string) => {
    keyed.push(query === TEAM_STATES_QUERY ? "states" : query === CREATE_ISSUE_QUERY ? "create" : query === RELATION_QUERY ? "relate" : "other");
    return query === TEAM_STATES_QUERY ? { team: { states: { nodes: [{ id: "todo", name: "Todo", type: "unstarted", position: 1 }, { id: "backlog", name: "Backlog", type: "backlog", position: 0 }] } } } : { issueCreate: { success: true, issue: { id: "x", identifier: "X-1", url: "u" } }, issueRelationCreate: { success: true } };
  };
  const mutations: { query: string; variables: Record<string, unknown> }[] = [];
  let usable = true;
  const app: App = {
    query: async () => null,
    mutate: async (query, variables) => {
      if (!usable) return null;
      mutations.push({ query, variables });
      return query === CREATE_ISSUE_QUERY ? { issueCreate: { success: true, issue: { id: "i9", identifier: "TUC-9", url: "https://linear.app/TUC-9" } } } : { issueRelationCreate: { success: true } };
    },
    viewer: async () => ({ id: "paseo-app", name: "Paseo" }),
  };
  const linear = new LinearService(new Credentials("/unused", "owner-key"), post, app);
  assert.deepEqual(await linear.createIssueAsApp({ teamId: "t1", projectId: "p1", ready: true, title: "Follow-up", description: "d" }), { id: "i9", identifier: "TUC-9", url: "https://linear.app/TUC-9" });
  assert.equal(await linear.relateAsApp("i9", "origin", "related"), true);
  assert.deepEqual(mutations.map((mutation) => mutation.variables.input), [
    { teamId: "t1", title: "Follow-up", description: "d", stateId: "todo", projectId: "p1" },
    { issueId: "i9", relatedIssueId: "origin", type: "related" },
  ]);
  usable = false;
  assert.equal(await linear.createIssueAsApp({ teamId: "t1", ready: true, title: "Follow-up", description: "d" }), null);
  assert.equal(await linear.relateAsApp("i9", "origin", "related"), null);
  assert.deepEqual(keyed, ["states"], "the key only read the team's states; no write reached it");
});

test("two follow-ups become two tickets in the origin's team and project, related to it, with one comment; a repeated approval files nothing again", async () => {
  await withFollowUps(async ({ calls, followUps, directory }) => {
    await followUps.file(ORIGIN);
    assert.deepEqual(calls, [
      `create "Document the delivery date" team-1 project-1 ready=true`,
      `create "Show the delivery date on mobile" team-1 project-1 ready=true`,
      "relate new-1 origin-1 related",
      "relate new-2 origin-1 related",
      "comment origin-1: 📌 Follow-ups filed from the approved plan ([plan](https://linear.app/doc/plan)):\n- [TUC-101](https://linear.app/TUC-101) Document the delivery date\n- [TUC-102](https://linear.app/TUC-102) Show the delivery date on mobile",
    ]);
    calls.length = 0;
    await followUps.file(ORIGIN);
    await followUps.file({ ...ORIGIN, plan: PLAN.replace("Document the delivery date", "document the delivery date") });
    assert.deepEqual(calls, [], "filed titles (case aside) are never filed again, and the same outcome is not commented twice");
    const [name] = await readdir(directory);
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  });
});

test("a plan without follow-ups files and says nothing", async () => {
  await withFollowUps(async ({ calls, followUps, directory }) => {
    await followUps.file({ ...ORIGIN, plan: "# Plan\n\n## Reach\n\nOnly the menu bar.\n" });
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(directory).catch(() => []), []);
  });
});

test("a follow-up created but not linked is only linked on retry, never created again", async () => {
  for (const failure of ["null", "throw"] as const) {
    await withFollowUps(async ({ calls, mode, followUps, later }) => {
      mode.relate = failure;
      await followUps.file(ORIGIN);
      assert.equal(calls.filter((call) => call.startsWith("create")).length, 2, failure);
      assert.match(comments(calls)[0], /Created, but linking them to this ticket is still pending:\n- \[TUC-101\]\(https:\/\/linear\.app\/TUC-101\) Document the delivery date/, failure);
      calls.length = 0;
      mode.relate = "ok";
      later(RETRY_MS / 2);
      await followUps.retryPending();
      assert.equal(calls.length, 0, `${failure}: not before the retry is due`);
      later(RETRY_MS / 2);
      await followUps.retryPending();
      assert.deepEqual(calls.slice(0, 2), ["relate new-1 origin-1 related", "relate new-2 origin-1 related"], failure);
      assert.match(comments(calls)[0], /Follow-ups filed from the approved plan/, failure);
      calls.length = 0;
      await followUps.file(ORIGIN);
      assert.deepEqual(calls, [], failure);
    });
  }
});

test("when the Paseo app cannot write, nothing is filed under the owner's name and the comment says why", async () => {
  await withFollowUps(async ({ calls, mode, followUps, later }) => {
    mode.create = "null";
    await followUps.file(ORIGIN);
    assert.deepEqual(comments(calls), ["comment origin-1: Not filed: Paseo could not write to Linear as itself; file them by hand or approve again later:\n- Document the delivery date\n- Show the delivery date on mobile"]);
    calls.length = 0;
    later(RETRY_MS * 2);
    await followUps.retryPending();
    assert.equal(calls.length, 0, "no automatic retry");
    mode.create = "ok";
    await followUps.file(ORIGIN);
    assert.equal(calls.filter((call) => call.startsWith("create")).length, 2, "approving again files them");
  });
});

test("a ticket not written by the owner or Paseo, or labelled feedback, gets the list instead of tickets", async () => {
  for (const change of [{ creatorId: "colleague" }, { labels: [{ id: "f", name: "feedback" }] }]) {
    await withFollowUps(async ({ calls, ticket, followUps }) => {
      Object.assign(ticket, change);
      await followUps.file(ORIGIN);
      assert.deepEqual(calls, ["comment origin-1: 📌 Follow-ups in the approved plan ([plan](https://linear.app/doc/plan)), not filed because this ticket was not written by you or Paseo:\n- Document the delivery date\n- Show the delivery date on mobile"]);
    });
  }
});

test("Linear failures are retried by the sweep and, after the last attempt, listed for the owner; a feedback label added meanwhile stops the filing", async () => {
  await withFollowUps(async ({ calls, mode, followUps, later }) => {
    mode.create = "throw";
    await followUps.file(ORIGIN);
    assert.deepEqual(comments(calls), [], "no comment while the filing waits for its retry");
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      later(RETRY_MS);
      await followUps.retryPending();
    }
    assert.equal(calls.filter((call) => call.startsWith("create")).length, MAX_ATTEMPTS * 2);
    assert.deepEqual(comments(calls), [`comment origin-1: Not filed: Linear failed ${MAX_ATTEMPTS} times; file them by hand or approve again later:\n- Document the delivery date\n- Show the delivery date on mobile`]);
    calls.length = 0;
    later(RETRY_MS);
    await followUps.retryPending();
    assert.deepEqual(calls, []);
  });
  await withFollowUps(async ({ calls, mode, ticket, followUps, later }) => {
    mode.create = "throw";
    await followUps.file(ORIGIN);
    ticket.labels = [{ id: "f", name: "feedback" }];
    mode.create = "ok";
    calls.length = 0;
    later(RETRY_MS);
    await followUps.retryPending();
    assert.ok(!calls.some((call) => call.startsWith("create")));
    assert.match(comments(calls)[0], /not filed because this ticket was not written by you or Paseo/);
  });
});

test("approvals of one ticket arriving at once file each follow-up once", async () => {
  await withFollowUps(async ({ calls, followUps }) => {
    await Promise.all([followUps.file(ORIGIN), followUps.file(ORIGIN), followUps.file(ORIGIN)]);
    assert.equal(calls.filter((call) => call.startsWith("create")).length, 2);
    assert.equal(comments(calls).length, 1);
  });
});

test("a failed comment is posted by the sweep, once", async () => {
  await withFollowUps(async ({ calls, mode, followUps, later }) => {
    mode.comment = "throw";
    await followUps.file(ORIGIN);
    mode.comment = "ok";
    calls.length = 0;
    later(RETRY_MS);
    await followUps.retryPending();
    assert.equal(comments(calls).length, 1);
    assert.ok(!calls.some((call) => call.startsWith("create")));
    later(RETRY_MS);
    await followUps.retryPending();
    assert.equal(comments(calls).length, 1);
  });
});

test("rate-limited follow-up creation, relations and announcements wait without spending attempts or duplicating successful writes", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const stage of ["create", "relate", "comment"] as const) {
    await withFollowUps(async ({ calls, mode, followUps, directory, later }) => {
      let now = Date.parse("2026-10-04T12:00:00Z");
      const record = async () => JSON.parse(await readFile(join(directory, "origin-1.json"), "utf8")) as FollowUpRecord;
      for (let failure = 0; failure < MAX_ATTEMPTS + 2; failure++) {
        const resumeAt = now + RETRY_MS;
        mode[stage] = new RateLimitedError("app", resumeAt);
        if (failure === 0) await followUps.file(ORIGIN);
        else await followUps.retryPending();
        const pending = await record();
        assert.equal(pending.retryAt, resumeAt, stage);
        assert.equal(pending.attempts, 0, stage);
        assert.ok(Object.values(pending.items).every((item) => item.stopped !== "gave-up"), stage);
        const before = calls.length;
        later(RETRY_MS - 1);
        now += RETRY_MS - 1;
        await followUps.retryPending();
        assert.equal(calls.length, before, `${stage}: not retried before resumeAt`);
        // The scan is minute-spaced; move to its next due scan after checking the boundary.
        later(60_001);
        now += 60_001;
      }
      mode[stage] = "ok";
      await followUps.retryPending();
      const finished = await record();
      assert.equal(finished.retryAt, null, stage);
      assert.equal(finished.attempts, 0, stage);
      assert.ok(Object.values(finished.items).every((item) => item.id && item.related), stage);
      assert.equal(calls.filter((call) => call.startsWith("create")).length, stage === "create" ? MAX_ATTEMPTS + 4 : 2, stage);
      assert.equal(calls.filter((call) => call.startsWith("relate")).length, stage === "relate" ? MAX_ATTEMPTS + 4 : 2, stage);
      const before = calls.length;
      later(RETRY_MS);
      await followUps.retryPending();
      assert.equal(calls.length, before, `${stage}: completed once`);
    });
  }
});

test("a follow-up created before a limit is persisted and is never recreated, including after restarting the worker", async (t) => {
  t.mock.method(console, "error", () => {});
  await withFollowUps(async ({ calls, linear, followUps, directory, later }) => {
    const create = linear.createIssueAsApp;
    let writes = 0;
    const resumeAt = Date.parse("2026-10-04T12:00:00Z") + RETRY_MS;
    linear.createIssueAsApp = async (input) => {
      if (++writes === 2) throw new RateLimitedError("app", resumeAt);
      return create(input);
    };
    await followUps.file(ORIGIN);
    const pending = JSON.parse(await readFile(join(directory, "origin-1.json"), "utf8")) as FollowUpRecord;
    assert.equal(pending.items["document the delivery date"].id, "new-1");
    assert.equal(pending.attempts, 0);
    assert.equal(pending.retryAt, resumeAt);
    later(RETRY_MS);
    const restarted = new PlanFollowUps(linear, directory, () => resumeAt);
    await restarted.retryPending();
    assert.equal(calls.filter((call) => call.startsWith('create "Document')).length, 1);
    assert.equal(calls.filter((call) => call.startsWith("relate new-1")).length, 1);
    assert.equal(comments(calls).length, 1);
  });
});

test("initial follow-up filing and retryPending admit every prerequisite and write through real admission with 3% points", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-follow-up-admission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-10-07T12:00:00Z");
  const budget = new RateBudget(() => now);
  const headers = { "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "4500", "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": "60000", "x-complexity": "100" };
  for (const pool of ["key", "app"] as const) budget.acquire(pool, "owner").done(new Headers(headers), false);
  const sent: string[] = [];
  let createRequests = 0;
  const data: Record<string, object> = {
    issueState: { issue: { id: "origin-1", identifier: "TUC-50", creator: { id: "owner" }, team: { id: "team-1" }, project: { id: "project-1" }, state: { name: "Todo", type: "unstarted" }, labels: { nodes: [] } } },
    viewerCheck: { viewer: { id: "owner" } },
    appViewer: { viewer: { id: "paseo-app", name: "Paseo" } },
    teamStates: { team: { states: { nodes: [{ id: "todo", name: "Todo", type: "unstarted", position: 1 }] } } },
    relation: { issueRelationCreate: { success: true } },
    comment: { commentCreate: { success: true, comment: { id: "comment-1" } } },
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body: { query: string } = JSON.parse(String(init?.body));
    const operation = body.query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? "?";
    sent.push(operation);
    if (operation === "issueCreate") {
      createRequests++;
      if (createRequests === 1) return new Response(JSON.stringify({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] }), { status: 400, headers });
      return new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: `new-${createRequests - 1}`, identifier: `TUC-${100 + createRequests}`, url: `https://linear.app/TUC-${100 + createRequests}` } } } }), { headers });
    }
    assert.ok(data[operation], `unexpected Linear operation ${operation}`);
    return new Response(JSON.stringify({ data: data[operation] }), { headers });
  });
  const post = (key: string, query: string, variables: Record<string, unknown>) => postGraphQL(key, query, variables, budget);
  const linear = new LinearService(new Credentials("/unused", "owner-key"), post, new AgentApi({ accessToken: async () => "app-token" }, post));
  const followUps = new PlanFollowUps(linear, directory, () => now);
  await withPriority("background", "follow-up test", () => followUps.file(ORIGIN));
  const pending = JSON.parse(await readFile(join(directory, "origin-1.json"), "utf8")) as FollowUpRecord;
  assert.equal(pending.retryAt, now + 60_000);
  assert.equal(pending.attempts, 0);
  assert.ok(sent.includes("issueState"));
  assert.ok(sent.includes("teamStates"));
  now += 60_000;
  assert.ok(budget.pausedUntil("app", "background"), "the app's background share has not refilled");
  await withPriority("background", "follow-up retry test", () => followUps.retryPending());
  const complete = JSON.parse(await readFile(join(directory, "origin-1.json"), "utf8")) as FollowUpRecord;
  assert.equal(complete.retryAt, null);
  assert.equal(complete.attempts, 0);
  assert.ok(Object.values(complete.items).every((item) => item.id && item.related));
  assert.equal(sent.filter((operation) => operation === "issueCreate").length, 3);
  assert.equal(sent.filter((operation) => operation === "relation").length, 2);
  assert.equal(sent.filter((operation) => operation === "comment").length, 1);
});

test("a relation saved before a limit is not repeated by a restarted follow-up worker", async (t) => {
  t.mock.method(console, "error", () => {});
  await withFollowUps(async ({ calls, linear, followUps, directory }) => {
    const relate = linear.relateAsApp;
    let relations = 0;
    const resumeAt = Date.parse("2026-10-04T12:00:00Z") + RETRY_MS;
    linear.relateAsApp = async (...args) => {
      if (++relations === 2) throw new RateLimitedError("app", resumeAt);
      return relate(...args);
    };
    await followUps.file(ORIGIN);
    const pending = JSON.parse(await readFile(join(directory, "origin-1.json"), "utf8")) as FollowUpRecord;
    assert.equal(pending.items["document the delivery date"].related, true);
    assert.equal(pending.retryAt, resumeAt);
    assert.equal(pending.attempts, 0);
    await new PlanFollowUps(linear, directory, () => resumeAt).retryPending();
    assert.equal(calls.filter((call) => call.startsWith("create ")).length, 2);
    assert.equal(calls.filter((call) => call === "relate new-1 origin-1 related").length, 1);
    assert.equal(calls.filter((call) => call === "relate new-2 origin-1 related").length, 1);
    assert.equal(comments(calls).length, 1);
  });
});

test("a limited announcement never spends the round's attempt, even when a relation failed earlier in that round", async (t) => {
  t.mock.method(console, "error", () => {});
  await withFollowUps(async ({ mode, followUps, directory }) => {
    mode.relate = "throw";
    const resumeAt = Date.parse("2026-10-04T12:00:00Z") + RETRY_MS;
    mode.comment = new RateLimitedError("app", resumeAt);
    await followUps.file(ORIGIN);
    const pending = JSON.parse(await readFile(join(directory, "origin-1.json"), "utf8")) as FollowUpRecord;
    assert.equal(pending.retryAt, resumeAt);
    assert.equal(pending.attempts, 0);
    assert.ok(Object.values(pending.items).every((item) => item.id && !item.stopped));
  });
});
