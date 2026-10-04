import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Credentials } from "./credentials";
import { CREATE_ISSUE_QUERY, LinearService, RELATION_QUERY, TEAM_STATES_QUERY, type App } from "./linear";
import { MAX_ATTEMPTS, PlanFollowUps, RETRY_MS } from "./plan-follow-ups";

const PLAN = "# Plan\n\n## Reach\n\n- Changes: the delivery date\n- Help page: follow-up — Document the delivery date\n- Mobile app: follow-up — Show the delivery date on mobile\n\n## Principles and rules\n\nNone apply; no new rule.\n\n## Risk and impact\n\n- Impact: 0\n";
const ORIGIN = { issueId: "origin-1", identifier: "TUC-50", plan: PLAN, documentUrl: "https://linear.app/doc/plan" };
type Mode = "ok" | "null" | "throw";
type Ticket = { teamId: string; projectId: string; creatorId: string; labels: { id: string; name: string }[] };
type Harness = { calls: string[]; mode: { create: Mode; relate: Mode; comment: Mode }; ticket: Ticket; followUps: PlanFollowUps; directory: string; later: (ms: number) => void };

// Linear as plan-follow-ups.ts sees it; `mode` decides how each write answers.
function fakeLinear() {
  const calls: string[] = [];
  const mode: Harness["mode"] = { create: "ok", relate: "ok", comment: "ok" };
  const ticket: Ticket = { teamId: "team-1", projectId: "project-1", creatorId: "owner", labels: [] };
  let created = 0;
  const answer = <T>(which: Mode, value: T): T | null => {
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
