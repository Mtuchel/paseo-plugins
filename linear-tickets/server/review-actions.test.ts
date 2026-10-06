import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Credentials } from "./credentials";
import { LinearRefusedError, LinearService } from "./linear";
import { ReviewDeletions } from "./review-deletions";
import { ReviewLinks, type ReviewLinksOptions } from "./review-links";
import { ReviewClosedError, ReviewDecisionAppliedError } from "./sessions";

const ISSUE = "3b241101-e2bb-4255-8caf-4136c566a962";
const OTHER = "0c7f5f9e-83a5-4e4b-b7f3-2f7d3c1b5a10";
const IDENTIFIER = "TUC-630";
const event = { type: "opened" as const, agentId: "agent-1", localUrl: "http://localhost:50001/", remoteUrl: "https://host.tail.ts.net:50001/", at: "2026-01-01T10:00:00Z" };

async function fixture(run: (h: {
  links: ReviewLinks; journal: ReviewDeletions; file: string;
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
  rows: () => Promise<{ open: { name: string; areas?: string[]; deleteable?: boolean }[]; decided: { name: string }[] }>;
}) => Promise<void>, options: ReviewLinksOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-actions-"));
  const file = join(directory, "deletions.json");
  const journal = new ReviewDeletions(file);
  const links = new ReviewLinks({
    port: 0, proxyPort: 0, file: join(directory, "reviews.json"), sweepMs: 3_600_000,
    serve: async () => "https://host.tail.ts.net:8444", route: async () => {}, unserve: async () => {}, alive: async () => true,
    fetchPlan: async () => "", issueInfo: async () => ({ issueId: ISSUE, areas: ["Purchasing"] }),
    issueLink: async () => ({ issueId: ISSUE, identifier: IDENTIFIER }),
    deleteIssue: async () => {}, cleanupIssue: async () => {}, deletions: journal, ...options,
  });
  try {
    await links.start();
    await links.opened("agent-1", event, { identifier: IDENTIFIER, issueId: ISSUE });
    const origin = `http://127.0.0.1:${links.listeningPort}`;
    await run({
      links, journal, file,
      post: (path, body, headers = { "x-review-action": "1" }) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      rows: async () => (await fetch(`${origin}/api/inbox`)).json(),
    });
  } finally { links.stop(); await rm(directory, { recursive: true, force: true }); }
}

const DELETE = "/api/reviews/agent-1/delete";
const RECHECK = "/api/reviews/agent-1/recheck";

test("destructive review actions require same-origin JSON and exact ticket confirmation", async () => {
  let mutations = 0;
  await fixture(async ({ post, rows }) => {
    for (const path of [DELETE, RECHECK]) {
      assert.equal((await post(path, {}, {})).status, 403);
      assert.equal((await post(path, {}, { "x-review-action": "1", origin: "https://evil.example" })).status, 403);
      assert.equal((await post(path, {}, { "x-review-action": "1", origin: "null" })).status, 403);
    }
    assert.equal((await post(DELETE, { identifier: "tuc-630" })).status, 400);
    assert.equal((await post(DELETE, { identifier: IDENTIFIER, issueId: OTHER })).status, 400);
    assert.equal((await post(RECHECK, { feedback: "implement immediately" })).status, 400);
    assert.equal(mutations, 0);
    assert.deepEqual((await rows()).open.map((row) => row.name), [IDENTIFIER]);
  }, { deleteIssue: async () => { mutations++; } });
});

test("delete revalidates saved issue identity, current linkage and latest waiting state", async () => {
  let current = ISSUE;
  let linked = ISSUE;
  let mutations = 0;
  await fixture(async ({ links, post, rows }) => {
    const row = (await rows()).open[0];
    assert.deepEqual({ areas: row.areas, deleteable: row.deleteable }, { areas: ["Purchasing"], deleteable: true });
    current = OTHER;
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 409);
    current = ISSUE; linked = OTHER;
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 409);
    linked = ISSUE;
    await links.decided("agent-1", true);
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 409);
    assert.equal(mutations, 0);
  }, {
    issueInfo: async () => ({ issueId: current, areas: ["Purchasing"] }),
    issueLink: async () => ({ issueId: linked, identifier: IDENTIFIER }),
    deleteIssue: async () => { mutations++; },
  });
});

test("a non-ticket review and unverified metadata never offer or execute deletion", async () => {
  await fixture(async ({ links, post, rows }) => {
    await links.opened("agent-1", event);
    assert.equal((await rows()).open[0].deleteable, false);
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 400);
  }, { issueLink: async () => null });
  await fixture(async ({ post, rows }) => {
    assert.equal((await rows()).open[0].deleteable, false);
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 409);
  }, { issueInfo: async () => null });
});

test("Linear refusal clears the durable pause without clearing or deciding the review", async () => {
  let cleanups = 0;
  let decisions = 0;
  await fixture(async ({ post, journal, rows }) => {
    const response = await post(DELETE, { identifier: IDENTIFIER });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Linear refused deletion; the review was preserved/);
    assert.equal(await journal.get(ISSUE), null);
    assert.equal((await rows()).open[0].name, IDENTIFIER);
    assert.equal(cleanups, 0); assert.equal(decisions, 0);
  }, { deleteIssue: async () => { throw new LinearRefusedError("Linear did not delete the ticket."); }, cleanupIssue: async () => { cleanups++; }, decide: async () => { decisions++; } });
});

test("confirmed deletion is durable before cleanup, and cleanup retries never delete or deny twice", async () => {
  let mutations = 0;
  let cleanups = 0;
  let journalFile = "";
  await fixture(async ({ post, journal, file, rows }) => {
    journalFile = file;
    const response = await post(DELETE, { identifier: IDENTIFIER });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /underlying issue TUC-630 is already deleted.*local cleanup failed/);
    assert.equal((await rows()).open[0].deleteable, true);
    assert.equal((await new ReviewDeletions(file).get(ISSUE))?.phase, "deleted");
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 200);
    assert.deepEqual((await rows()).open, []);
    assert.equal((await journal.get(ISSUE))?.phase, "deleted");
    assert.equal(mutations, 1); assert.equal(cleanups, 2);
  }, {
    deleteIssue: async () => { mutations++; },
    decide: async () => { throw new Error("deletion must not decide a review"); },
    cleanupIssue: async () => {
      assert.equal((await new ReviewDeletions(journalFile).get(ISSUE))?.phase, "deleted");
      if (++cleanups === 1) throw new Error("archive failed");
    },
  });
});

test("an unknown mutation result cannot be retried from disappeared or stale ticket identity", async () => {
  let mutations = 0;
  let visible = true;
  await fixture(async ({ post, journal, file }) => {
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 502);
    assert.equal((await new ReviewDeletions(file).get(ISSUE))?.phase, "pending");
    visible = false;
    const uncertain = await post(DELETE, { identifier: IDENTIFIER });
    assert.equal(uncertain.status, 409);
    assert.match((await uncertain.json()).error, /outcome is unknown.*no duplicate deletion/);
    assert.equal(mutations, 1);
    visible = true;
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 200);
    assert.equal(mutations, 2);
    assert.equal((await journal.get(ISSUE))?.phase, "deleted");
  }, {
    issueInfo: async () => visible ? { issueId: ISSUE, areas: [] } : null,
    deleteIssue: async () => { if (++mutations === 1) throw new Error("response lost"); },
  });
});

test("recheck sends back and requires owner approval across review rounds, while refused feedback rolls back the flag", async () => {
  const feedback: string[] = [];
  await fixture(async ({ post, links }) => {
    assert.equal((await post(RECHECK, {})).status, 200);
    assert.equal(await links.requiresOwner(ISSUE), true);
    await links.opened("agent-2", { ...event, agentId: "agent-2", localUrl: "http://localhost:50002/", remoteUrl: "https://host.tail.ts.net:50002/" }, { identifier: IDENTIFIER, issueId: ISSUE });
    assert.equal(await links.requiresOwner(ISSUE), true);
    assert.equal((await post("/api/reviews/agent-2/decision", { approve: true })).status, 200);
    assert.equal(await links.requiresOwner(ISSUE), false);
    assert.match(feedback[0], /current code and main branch.*recently merged pull requests.*related Linear issues and plans.*active reviews/);
    assert.match(feedback[0], /fresh advisor review of the exact revised text.*user's review.*Do not implement anything and do not auto-approve/);
  }, { decide: async (_url, approved, text) => { feedback.push(`${approved} ${text}`); } });
  await fixture(async ({ post, links }) => {
    assert.equal((await post(RECHECK, {})).status, 409);
    assert.equal(await links.requiresOwner(ISSUE), false);
  }, { decide: async () => { throw new ReviewClosedError("Plannotator refused feedback."); } });
  await fixture(async ({ post, links }) => {
    assert.equal((await post(RECHECK, {})).status, 502);
    assert.equal(await links.requiresOwner(ISSUE), true);
  }, { decide: async () => { throw new ReviewDecisionAppliedError("Feedback delivered; recording failed."); } });
});

test("tombstones suppress replayed opened reviews after a fixture restart", async () => {
  await fixture(async ({ post, links, file }) => {
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 200);
    assert.equal(await links.opened("old-agent", { ...event, agentId: "old-agent" }, { identifier: IDENTIFIER, issueId: ISSUE }), null);
    const restarted = new ReviewLinks({ file: join(file, "..", "reviews.json"), deletions: new ReviewDeletions(file) });
    assert.equal(await restarted.opened("agent-1", event, { identifier: IDENTIFIER, issueId: ISSUE }), null);
  });
});

test("Linear issueDelete refusal and missing success are errors, not false local success", async () => {
  let response: Record<string, unknown> = { issueDelete: { success: false } };
  const linear = new LinearService(new Credentials("/unused", "fixture-key"), async () => response);
  await assert.rejects(linear.deleteIssue(ISSUE), LinearRefusedError);
  response = { issueDelete: {} };
  await assert.rejects(linear.deleteIssue(ISSUE), LinearRefusedError);
  response = { issueDelete: { success: true } };
  await linear.deleteIssue(ISSUE);
});

test("peer actions reach the owner without a previous inbox load and preserve partial deletion errors", async () => {
  let cleanups = 0;
  await fixture(async (peer) => {
    await peer.links.opened("agent-9", { ...event, agentId: "agent-9", localUrl: "http://localhost:50009/", remoteUrl: "https://host.tail.ts.net:50009/" }, { identifier: IDENTIFIER, issueId: ISSUE });
    await fixture(async ({ post, links }) => {
      assert.equal((await post("/api/reviews/agent-9/recheck", {})).status, 200);
      assert.equal(await peer.links.requiresOwner(ISSUE), true);
      await peer.links.opened("agent-9", { ...event, agentId: "agent-9", localUrl: "http://localhost:50010/", remoteUrl: "https://host.tail.ts.net:50010/" }, { identifier: IDENTIFIER, issueId: ISSUE });
      const partial = await post("/api/reviews/agent-9/delete", { identifier: IDENTIFIER });
      assert.equal(partial.status, 500);
      assert.match((await partial.json()).error, /underlying issue TUC-630 is already deleted.*local cleanup failed/);
      assert.equal(await links.requiresOwner(ISSUE), false, "the forwarding host never sent feedback locally");
      assert.equal((await post("/api/reviews/agent-9/delete", { identifier: IDENTIFIER })).status, 200);
      assert.deepEqual((await peer.rows()).open, []);
    }, { peers: async () => [`http://127.0.0.1:${peer.links.listeningPort}`] });
  }, { decide: async () => {}, cleanupIssue: async () => { if (++cleanups === 1) throw new Error("remote archive failed"); } });
});

test("deletion rejects a newer waiting review that arrived during fresh identity verification", async () => {
  let replace: (() => Promise<void>) | null = null;
  let mutations = 0;
  await fixture(async ({ links, post }) => {
    replace = async () => {
      await links.opened("agent-1", { ...event, localUrl: "http://localhost:50002/", remoteUrl: "https://host.tail.ts.net:50002/" }, { identifier: IDENTIFIER, issueId: ISSUE });
    };
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 409);
    assert.equal(mutations, 0);
  }, {
    issueInfo: async (_identifier, options) => { if (options?.fresh) await replace?.(); return { issueId: ISSUE, areas: [] }; },
    deleteIssue: async () => { mutations++; },
  });
});

test("cached row linkage cannot authorize deletion when its independent fresh read fails", async () => {
  let mutations = 0;
  await fixture(async ({ rows, post }) => {
    assert.equal((await rows()).open[0].deleteable, true);
    assert.equal((await post(DELETE, { identifier: IDENTIFIER })).status, 409);
    assert.equal(mutations, 0);
  }, { issueInfo: async (_identifier, options) => options?.fresh ? null : { issueId: ISSUE, areas: [] }, deleteIssue: async () => { mutations++; } });
});

test("pre-mutation cleanup preparation failure restores actionability without a false unknown remote outcome", async () => {
  let mutations = 0;
  await fixture(async ({ journal, post, rows }) => {
    const response = await post(DELETE, { identifier: IDENTIFIER });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Deletion did not start/);
    assert.equal(await journal.get(ISSUE), null);
    assert.equal((await rows()).open[0].deleteable, true);
    assert.equal(mutations, 0);
  }, { prepareDelete: async () => { throw new Error("in-flight start did not settle"); }, deleteIssue: async () => { mutations++; } });
});
