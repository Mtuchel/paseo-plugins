import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HandoverRecord } from "./handover";
import { GitHubRateLimitedError, PullRequestWatch, type FailedCheck, type PullRequestView, type QueueDraft } from "./pr-watch";
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

type Outcome = "sent" | "busy" | "gone" | "unavailable";

function harness(t: TestContext, agent: { status?: HandoverRecord["status"]; live?: boolean; updatedAt?: string } = {}) {
  const records = [{ issueId: "i1", identifier: "TUC-1", agentId: "a1", agentTitle: "T", worktreePath: "/wt/tuc-1", links: { "Pull request": PR }, status: agent.status ?? "working", updatedAt: agent.updatedAt ?? new Date().toISOString() } as unknown as HandoverRecord];
  const github = { view: { state: "OPEN", labels: [], mergeActivity: null, reviews: [], lastCommitAt: null } as PullRequestView, drafts: [] as QueueDraft[], landed: [] as number[], checks: [] as FailedCheck[], reads: [] as string[], throttled: false };
  // What the agent does with a prompt; "sent" records it.
  const paseo: { answer: () => Promise<Outcome> } = { answer: async () => (agent.live ?? true) ? "sent" : "gone" };
  const calls: string[] = [];
  const directory = mkdtemp(join(tmpdir(), "paseo-pr-watch-"));
  t.after(async () => rm(await directory, { recursive: true, force: true }));
  const create = () => directory.then((home) => new PullRequestWatch({
    handover: { all: async () => records, update: async (_issue, _agent, patch) => { calls.push(`review ${patch.review}`); return null as never; } },
    sessions: {
      sessionFor: async () => ({ sessionId: "s" }) as never,
      say: async (_id, kind, text) => { calls.push(`say ${kind} ${text.split("\n")[0]}`); },
      prompt: async (agentId, text) => {
        const outcome = await paseo.answer();
        if (outcome === "sent") calls.push(`prompt ${agentId}\n${text}`);
        return outcome;
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
    view: async (url) => {
      github.reads.push(url);
      if (github.throttled) throw new GitHubRateLimitedError("GitHub is throttling gh: HTTP 403: API rate limit exceeded");
      return github.view;
    },
    mergeQueue: {
      drafts: async () => github.drafts,
      landed: async (_repo, item) => github.landed.includes(item.number),
      failedChecks: async () => github.checks,
    },
  }, join(home, "pr-watch.json")));
  let watch = create();
  const poll = async () => {
    calls.length = 0;
    github.reads.length = 0;
    await (await watch).poll();
    return [...calls];
  };
  // A new plugin instance on the same state file.
  const restart = () => { watch = create(); return watch; };
  return { github, paseo, records, calls, poll, restart, watch: () => watch };
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

test("a queue draft for other pull requests, an earlier attempt's draft, a still-open or newer draft, or a landed draft is not a drop", async (t) => {
  const h = harness(t);
  h.github.drafts = [draft(450, [420, 4190])];
  assert.deepEqual(await h.poll(), [], "closed draft for other pull requests");
  h.github.drafts = [draft(437, [419])];
  assert.deepEqual(await h.poll(), [], "no Merge activity: a closed draft says nothing about the current attempt");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437), QUEUED) };
  assert.deepEqual(await h.poll(), [], "re-enqueued: the new attempt has no draft yet");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437), QUEUED, running(441)) };
  assert.deepEqual(await h.poll(), [], "the current attempt's draft #441 is not listed yet");
  h.github.drafts = [draft(443, [419], "OPEN"), draft(441, [419]), draft(437, [419])];
  assert.deepEqual(await h.poll(), [], "a newer queue draft for the pull request is open");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(451)) };
  h.github.drafts = [draft(451, [419], "OPEN"), draft(450, [420])];
  assert.deepEqual(await h.poll(), [], "the queue is still testing the draft");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(452)) };
  h.github.drafts = [draft(452, [419])];
  h.github.landed = [452];
  assert.deepEqual(await h.poll(), [], "the draft landed; the pull request closes next");
});

test("a drop is claimed before the prompt goes out: overlapping polls and a restart mid-send never prompt twice", async (t) => {
  const overlapping = harness(t);
  overlapping.github.view = { ...overlapping.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let asked = 0;
  overlapping.paseo.answer = async () => { asked++; await gate; return "sent"; };
  const watch = await overlapping.watch();
  const polls = [watch.poll(), watch.poll()];
  release();
  await Promise.all(polls);
  await watch.poll();
  assert.equal(asked, 1);

  const restarted = harness(t);
  restarted.github.view = { ...restarted.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  let reached!: () => void;
  const sending = new Promise<void>((resolve) => { reached = resolve; });
  // The first instance never learns whether its prompt went out.
  restarted.paseo.answer = () => { reached(); return new Promise<Outcome>(() => {}); };
  void (await restarted.watch()).poll();
  await sending;
  restarted.paseo.answer = async () => "sent";
  const log = t.mock.method(console, "error", () => {});
  await restarted.restart();
  assert.deepEqual(await restarted.poll(), [], "not sent again after the restart");
  assert.match(String(log.mock.calls[0]?.arguments[0]), /may already have gone out; it is not sent again/);
  assert.deepEqual(await restarted.poll(), []);
});

test("a prompt that fails is retried on the next poll, then not sent again", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  t.mock.method(console, "error", () => {});
  h.paseo.answer = async () => { throw new Error("daemon went away"); };
  assert.deepEqual(await h.poll(), []);
  h.paseo.answer = async () => "sent";
  assert.match((await h.poll())[0], /^prompt a1\n/);
  assert.deepEqual(await h.poll(), []);
});

test("a busy agent or a disconnected Paseo gets the fix once it can take it, never through the ticket", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  const outcomes: Outcome[] = ["busy", "unavailable"];
  h.paseo.answer = async () => outcomes.shift() ?? "sent";
  assert.deepEqual(await h.poll(), [], "in a turn: waits");
  assert.deepEqual(await h.poll(), [], "Paseo not connected: waits");
  const delivered = await h.poll();
  assert.match(delivered[0], /^prompt a1\n.*\nReason: Sep 29, 7:01 AM UTC: The Graphite merge queue couldn't merge this PR/s);
  assert.match(delivered[1], /^say thought The merge queue dropped the pull request/);
  assert.equal(delivered.length, 2);
  assert.deepEqual(await h.poll(), []);
});

test("an archived agent's open pull request stops being watched after the escalation, or after 14 days without activity", async (t) => {
  const stale = harness(t, { status: "archived", updatedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString() });
  await stale.poll();
  assert.deepEqual(stale.github.reads, []);

  const h = harness(t, { status: "archived" });
  const events = [QUEUED, CONFLICT];
  for (let drop = 1; drop <= 3; drop++) {
    h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
    const calls = await h.poll();
    assert.ok(!calls.some((call) => call.startsWith("prompt")), "an archived agent is never prompted");
    assert.match(calls.find((call) => call.startsWith("comment")) ?? "", drop === 3 ? /dropped this stack three times/ : /no longer running/);
    events.push(QUEUED, CONFLICT);
  }
  h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
  await h.poll();
  assert.deepEqual(h.github.reads, [], "escalated: no longer read");
});

test("GitHub throttling ends the poll, is logged once, and the next poll reads every pull request", async (t) => {
  const h = harness(t);
  h.records.push({ ...h.records[0], issueId: "i2", identifier: "TUC-2", links: { "Pull request": "https://github.com/tuchel-sohn/tuchel-platform/pull/420" } });
  const log = t.mock.method(console, "error", () => {});
  h.github.throttled = true;
  await h.poll();
  assert.deepEqual(h.github.reads, [PR], "the second pull request is not read");
  await h.poll();
  assert.deepEqual(h.github.reads, [PR]);
  assert.equal(log.mock.callCount(), 1);
  assert.match(String(log.mock.calls[0].arguments[0]), /paused until the next poll: GitHub is throttling gh/);
  h.github.throttled = false;
  await h.poll();
  assert.equal(h.github.reads.length, 2);
});
