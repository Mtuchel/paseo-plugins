import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HandoverRecord } from "./handover";
import { PullRequestWatch, type FailedCheck, type PullRequestView, type QueueDraft } from "./pr-watch";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const settings = { dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, status: true } } as unknown as PluginSettings;
const OWNER = "https://linear.app/ws/profiles/me";
const PR = "https://github.com/tuchel-sohn/tuchel-platform/pull/419";
const graphiteLink = (number: number) => `[#${number}](https://app.graphite.com/github/pr/tuchel-sohn/tuchel-platform/${number})`;

// Graphite's Merge activity comment; each bullet gets its own minute, as Graphite stamps them.
function activity(...events: string[]): string {
  return `### Merge activity\n\n${events.map((event, index) => `* **Sep 29, 7:${String(index).padStart(2, "0")} AM UTC**: ${event}`).join("\n")}\n`;
}
const QUEUED = "`Mtuchel` added this pull request to the [Graphite merge queue](https://app.graphite.com/merges?org=tuchel-sohn&repo=tuchel-platform).";
const running = (draft: number) => `CI is running for this pull request on a draft pull request (${graphiteLink(draft)}) due to your merge queue CI optimization settings.`;
const CONFLICT = "The [Graphite merge queue](https://app.graphite.com/merges?org=tuchel-sohn&repo=tuchel-platform) couldn't merge this PR because **it had merge conflicts**.";

function draft(number: number, prs: number[], state = "CLOSED"): QueueDraft {
  return {
    number,
    title: `[Graphite MQ] Draft PR GROUP:spec_${number} (PRs ${prs.join(", ")})`,
    body: `\n  This draft PR was created by the Graphite merge queue.\n\n  The following PRs are included in this draft PR:\n${prs.map((pr) => `  * ${graphiteLink(pr)}`).join("\n")}\n`,
    state,
    headSha: `sha-${number}`,
    base: "main",
  };
}

function harness(t: TestContext, agent: { status?: HandoverRecord["status"]; live?: boolean } = {}) {
  const record = { issueId: "i1", identifier: "TUC-1", agentId: "a1", agentTitle: "T", worktreePath: "/wt/tuc-1", links: { "Pull request": PR }, status: agent.status ?? "working" } as unknown as HandoverRecord;
  const github = { view: { state: "OPEN", labels: [], mergeActivity: null, reviews: [], lastCommitAt: null } as PullRequestView, drafts: [] as QueueDraft[], landed: [] as number[], checks: [] as FailedCheck[] };
  const calls: string[] = [];
  const directory = mkdtemp(join(tmpdir(), "paseo-pr-watch-"));
  t.after(async () => rm(await directory, { recursive: true, force: true }));
  const watch = directory.then((home) => new PullRequestWatch({
    handover: { all: async () => [record], update: async (_issue, _agent, patch) => { calls.push(`review ${patch.review}`); return null as never; } },
    sessions: {
      sessionFor: async () => ({ sessionId: "s" }) as never,
      say: async (_id, kind, text) => { calls.push(`say ${kind} ${text.split("\n")[0]}`); },
      prompt: async (agentId, text) => {
        if (!(agent.live ?? true)) return false;
        calls.push(`prompt ${agentId}\n${text}`);
        return true;
      },
    },
    linear: {
      moveToStateNamed: async (_id, name) => { calls.push(`move ${name}`); return { changed: true }; },
      createComment: async (_id, body) => { calls.push(`comment ${body}`); return "c1"; },
      updateComment: async () => {},
      viewerId: async () => "me",
      userUrl: async () => OWNER,
    },
    manualTasks: { openBlockers: async () => [], awaitingMerge: async () => false, merged: async (issueId) => { calls.push(`merged ${issueId}`); } },
    settings: { read: async () => settings },
    view: async () => github.view,
    mergeQueue: {
      drafts: async () => github.drafts,
      landed: async (_repo, item) => github.landed.includes(item.number),
      failedChecks: async () => github.checks,
    },
  }, join(home, "pr-watch.json")));
  const poll = async () => {
    calls.length = 0;
    await (await watch).poll();
    return [...calls];
  };
  return { github, poll };
}

test("a pull request the merge queue closed with the externally-merged label counts as merged and releases after-merge tasks", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, state: "CLOSED", labels: ["complex-review", "externally-merged"] };
  assert.deepEqual(await h.poll(), ["review merged", "say thought The pull request was merged.", "merged i1"]);
  assert.deepEqual(await h.poll(), [], "reported once");
});

test("a closed pull request without the externally-merged label is not merged", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, state: "CLOSED", labels: ["complex-review"], mergeActivity: activity(QUEUED, running(437), CONFLICT) };
  assert.deepEqual(await h.poll(), []);
});

test("a closed pull request whose last Merge activity is Graphite's merge counts as merged without the label", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, state: "CLOSED", mergeActivity: activity(QUEUED, running(415), `Merged by the [Graphite merge queue](https://app.graphite.com/merges) via draft PR: ${graphiteLink(415)}.`) };
  assert.deepEqual(await h.poll(), ["review merged", "say thought The pull request was merged.", "merged i1"]);
});

test("a queue drop prompts the live agent once with the reason, the failed checks and the runbook", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437)) };
  h.github.drafts = [draft(437, [419])];
  h.github.checks = [{ name: "Code validation / Core (core-web)", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/1/job/2", conclusion: "failure" }];
  const calls = await h.poll();
  assert.equal(calls.length, 2);
  const [prompt, said] = calls;
  assert.match(prompt, /^prompt a1\n/);
  assert.match(prompt, /Reason: The merge queue closed its draft pull request #437 without landing it\./);
  assert.match(prompt, /- \[Code validation \/ Core \(core-web\)\]\(https:\/\/github\.com\/tuchel-sohn\/tuchel-platform\/actions\/runs\/1\/job\/2\) — failure/);
  assert.match(prompt, /worktree \(`\/wt\/tuc-1`\), run `gt sync && gt restack`/);
  assert.match(prompt, /`gt submit --stack`, then `gt merge`/);
  assert.match(prompt, /one plain `gt merge` retry/);
  assert.match(said, /^say thought The merge queue dropped the pull request/);
  assert.deepEqual(await h.poll(), [], "not prompted again on the next poll");
  // Graphite's bullet for the same attempt arrives later; it is the same drop.
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437), "The Graphite merge queue removed this PR because a required check failed.") };
  assert.deepEqual(await h.poll(), [], "the bullet for draft #437 is the drop already handled");
});

test("a queue drop with no live agent comments on Linear and moves the ticket back to coding", async (t) => {
  for (const agent of [{ live: false }, { status: "archived" as const, live: true }]) {
    const h = harness(t, agent);
    // A conflict drops the pull request before any queue draft exists.
    h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
    const calls = await h.poll();
    assert.equal(calls[0], "move In Progress");
    assert.match(calls[1], new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running, so the ticket is back in In Progress`));
    assert.match(calls[1], /Reason: Sep 29, 7:01 AM UTC: The Graphite merge queue couldn't merge this PR because it had merge conflicts\./);
    assert.match(calls[1], /`gt sync && gt restack`/);
    assert.match(calls[2], /^say response The merge queue dropped the pull request and the agent is no longer running/);
    assert.equal(calls.length, 3, JSON.stringify(agent));
    assert.deepEqual(await h.poll(), []);
  }
});

test("the third queue drop escalates to the owner instead of prompting, and later drops stay quiet", async (t) => {
  const h = harness(t);
  const events = [QUEUED, CONFLICT];
  h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
  assert.match((await h.poll())[0], /fix request 1 of 2/);
  events.push(QUEUED, running(440), "The Graphite merge queue removed this PR because a required check failed.");
  h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
  h.github.drafts = [draft(440, [418, 419])];
  assert.match((await h.poll())[0], /fix request 2 of 2/);
  events.push(QUEUED, CONFLICT);
  h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
  const third = await h.poll();
  assert.ok(!third.some((call) => call.startsWith("prompt")));
  assert.match(third[0], new RegExp(`^comment ${OWNER} The merge queue dropped this stack three times`));
  assert.match(third[1], /^say response The merge queue dropped the pull request three times/);
  events.push(QUEUED, CONFLICT);
  h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
  assert.deepEqual(await h.poll(), [], "a fourth drop neither prompts nor comments");
});

test("a queue draft for other pull requests, a still-open draft or a landed draft is not a drop", async (t) => {
  const h = harness(t);
  h.github.drafts = [draft(450, [420, 4190])];
  assert.deepEqual(await h.poll(), [], "closed draft for other pull requests");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(451)) };
  h.github.drafts = [draft(451, [419], "OPEN"), draft(450, [420])];
  assert.deepEqual(await h.poll(), [], "the queue is still testing the draft");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(452)) };
  h.github.drafts = [draft(452, [419])];
  h.github.landed = [452];
  assert.deepEqual(await h.poll(), [], "the draft landed; the pull request closes next");
});
