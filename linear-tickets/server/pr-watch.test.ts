import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HandoverRecord } from "./handover";
import type { ReviewThread } from "./pr-nudge";
import { GitHubRateLimitedError, PullRequestWatch, type CheckRun, type FailedCheck, type PullRequestView, type QueueDraft } from "./pr-watch";
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

const HEAD = "a1b2c3d4e5f6";
const RUNNING_CI: CheckRun = { name: "Code validation / Core (core-web)", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/1/job/1", state: "pending", conclusion: "pending" };
// An open, ready pull request whose CI still runs: no lifecycle stage applies to it.
const OPEN_PR: PullRequestView = { state: "OPEN", isDraft: false, headSha: HEAD, updatedAt: "", reviewDecision: "", labels: [], mergeActivity: null, reviews: [], lastCommitAt: null, checks: [RUNNING_CI] };

function harness(t: TestContext, agent: { status?: HandoverRecord["status"]; live?: boolean; updatedAt?: string } = {}) {
  const records = [{ issueId: "i1", identifier: "TUC-1", agentId: "a1", agentTitle: "T", worktreePath: "/wt/tuc-1", links: { "Pull request": PR }, status: agent.status ?? "working", updatedAt: agent.updatedAt ?? new Date().toISOString() } as unknown as HandoverRecord];
  const github = { view: OPEN_PR, drafts: [] as QueueDraft[], landed: [] as number[], checks: [] as FailedCheck[], threads: [] as ReviewThread[], reads: [] as string[], threadReads: 0, throttled: false };
  const blockers: string[] = [];
  // `answer`: what Paseo finds before sending (only "sent" dispatches); `send`: the send itself,
  // after the dispatch was recorded; `session`: the agent's session lookup.
  const paseo: { answer: () => Promise<Outcome>; send: () => Promise<void>; session: () => Promise<unknown> } = {
    answer: async () => (agent.live ?? true) ? "sent" : "gone",
    send: async () => {},
    session: async () => ({ sessionId: "s" }),
  };
  const calls: string[] = [];
  const directory = mkdtemp(join(tmpdir(), "paseo-pr-watch-"));
  t.after(async () => rm(await directory, { recursive: true, force: true }));
  const create = () => directory.then((home) => new PullRequestWatch({
    handover: { all: async () => records, update: async (_issue, _agent, patch) => { calls.push(`review ${patch.review}`); return null as never; } },
    sessions: {
      sessionFor: () => paseo.session() as never,
      say: async (_id, kind, text) => { calls.push(`say ${kind} ${text.split("\n")[0]}`); },
      prompt: async (agentId, text, onDispatch) => {
        const outcome = await paseo.answer();
        if (outcome !== "sent") return outcome;
        await onDispatch?.();
        await paseo.send();
        calls.push(`prompt ${agentId}\n${text}`);
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
    manualTasks: { openBlockers: async () => blockers.map((identifier) => ({ identifier }) as never), awaitingMerge: async () => false, merged: async (issueId) => { calls.push(`merged ${issueId}`); } },
    settings: { read: async () => settings },
    view: async (url) => {
      github.reads.push(url);
      if (github.throttled) throw new GitHubRateLimitedError("GitHub is throttling gh: HTTP 403: API rate limit exceeded");
      return github.view;
    },
    github: {
      drafts: async () => github.drafts,
      landed: async (_repo, item) => github.landed.includes(item.number),
      failedChecks: async () => github.checks,
      reviewThreads: async () => { github.threadReads++; return github.threads; },
    },
  }, join(home, "pr-watch.json")));
  let watch = create();
  const poll = async () => {
    calls.length = 0;
    github.reads.length = 0;
    github.threadReads = 0;
    await (await watch).poll();
    return [...calls];
  };
  // A new plugin instance on the same state file.
  const restart = () => { watch = create(); return watch; };
  return { github, paseo, records, blockers, calls, poll, restart, watch: () => watch };
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
  assert.match(prompt, /worktree \(`\/wt\/tuc-1`\), on the top branch of the stack, run `git fetch origin main && git rebase --update-refs --onto origin\/main "\$\(git merge-base HEAD origin\/main\)"`/);
  assert.match(prompt, /`gt submit --stack --ignore-out-of-sync-trunk`, then `gt merge`/);
  assert.doesNotMatch(prompt, /run `gt sync/);
  assert.match(prompt, /If your stack sits on a PR that has already landed, or your PR was auto-closed, follow docs\/automation\/merge-queue\.md instead\.\n2\. Fix the cause\./);
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
    assert.match(calls[1], /`git fetch origin main && git rebase --update-refs --onto origin\/main/);
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
  // The first instance dispatches and never learns whether its prompt went out.
  restarted.paseo.send = () => { reached(); return new Promise<void>(() => {}); };
  void (await restarted.watch()).poll();
  await sending;
  restarted.paseo.send = async () => {};
  const log = t.mock.method(console, "error", () => {});
  await restarted.restart();
  assert.deepEqual(await restarted.poll(), [], "not sent again after the restart");
  assert.match(String(log.mock.calls[0]?.arguments[0]), /may already have gone out; it is not sent again/);
  assert.deepEqual(await restarted.poll(), []);
});

test("a restart while the agent was busy keeps the drop pending, and it is delivered once the agent is idle", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  h.paseo.answer = async () => "busy";
  assert.deepEqual(await h.poll(), []);
  await h.restart();
  h.paseo.answer = async () => "sent";
  assert.match((await h.poll())[0], /^prompt a1\n/);
  assert.deepEqual(await h.poll(), []);
});

test("a session line that fails after the prompt went out never sends the prompt again", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  const log = t.mock.method(console, "error", () => {});
  h.paseo.session = async () => { throw new Error("session store unreadable"); };
  const calls = await h.poll();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^prompt a1\n/);
  assert.match(String(log.mock.calls[0]?.arguments[0]), /session line failed: session store unreadable/);
  await h.restart();
  assert.deepEqual(await h.poll(), []);
});

test("a prompt that fails is retried on the next poll, then not sent again", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  t.mock.method(console, "error", () => {});
  h.paseo.answer = async () => { throw new Error("daemon went away"); };
  assert.deepEqual(await h.poll(), []);
  h.paseo.answer = async () => "sent";
  h.paseo.send = async () => { throw new Error("connection lost while sending"); };
  assert.deepEqual(await h.poll(), [], "a send that failed outright");
  h.paseo.send = async () => {};
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

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const GREEN: CheckRun = { ...RUNNING_CI, state: "passed", conclusion: "success" };
const failing = (name: string): CheckRun => ({ name, url: `https://github.com/tuchel-sohn/tuchel-platform/actions/runs/2/job/${name.length}`, state: "failed", conclusion: "failure" });
const passing = (name: string, conclusion = "success"): CheckRun => ({ name, url: "", state: "passed", conclusion });
// The repo's required checks passed on the head, and the rest of CI is green.
const READY: PullRequestView = { ...OPEN_PR, checks: [GREEN, passing("PR code"), passing("PR metadata")] };
const FINDING: ReviewThread = {
  resolved: false, path: "server/upload.ts", line: 42,
  comments: [{ author: "greptile-apps", bot: true, body: '<a href="#"><img alt="P2" src="https://greptile-static-assets.s3.amazonaws.com/badges/p2.svg"></a> The retry loop never gives up.', createdAt: ago(MINUTE), url: `${PR}#discussion_r1` }],
};
const promptOf = (calls: string[]) => calls.find((call) => call.startsWith("prompt a1\n"))?.slice("prompt a1\n".length);

test("a draft with no commit or activity for 30 minutes is told to run the Sol review and publish", async (t) => {
  const h = harness(t);
  h.github.view = { ...OPEN_PR, isDraft: true, updatedAt: ago(10 * MINUTE), lastCommitAt: ago(40 * MINUTE), checks: [failing("PR code")] };
  assert.deepEqual(await h.poll(), [], "activity 10 minutes ago");
  h.github.view = { ...h.github.view, updatedAt: ago(31 * MINUTE) };
  const calls = await h.poll();
  assert.equal(promptOf(calls), `[The pull request](${PR}) is still a draft, with no new commit or pull request activity for 30 minutes.\nNext step: run the background Sol review if you have not yet, then \`gt submit --stack --publish\`.\n\nThis is nudge 1 of 2 for this step; after that the owner takes over.`);
  assert.equal(calls.at(-1), "say thought The pull request is waiting for the agent to publish the draft; it was asked to.");
  assert.equal(h.github.threadReads, 0, "a draft needs no review threads");
  assert.deepEqual(await h.poll(), [], "claimed for this head");
});

test("failed checks on a ready pull request are listed with links, ignoring pending runs and Graphite's mergeability check", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, checks: [GREEN, RUNNING_CI, failing("Graphite / mergeability_check")] };
  assert.deepEqual(await h.poll(), [], "only the queue's own check failed");
  h.github.view = { ...READY, checks: [GREEN, RUNNING_CI, failing("Graphite / mergeability_check"), failing("Code validation / Platform gate")] };
  assert.equal(promptOf(await h.poll()), `Checks failed on the head of [the pull request](${PR}) (\`a1b2c3d\`):\n- [Code validation / Platform gate](https://github.com/tuchel-sohn/tuchel-platform/actions/runs/2/job/31) — failure\nNext step: fix them, then \`gt submit --stack\`.\n\nThis is nudge 1 of 2 for this step; after that the owner takes over.`);
  assert.equal(h.github.threadReads, 0);
});

test("each reviewer's outstanding change request is sent once with the open threads, next to the ticket update", async (t) => {
  const h = harness(t);
  const human: ReviewThread = { resolved: false, path: "db/migrate.sql", line: null, comments: [
    { author: "Mtuchel", bot: false, body: "Split this   migration.", createdAt: ago(MINUTE), url: `${PR}#discussion_r2` },
    { author: "paseo-agent", bot: false, body: "Will do.", createdAt: ago(MINUTE), url: `${PR}#discussion_r3` },
  ] };
  h.github.threads = [human, { ...FINDING, resolved: true }];
  h.github.view = { ...READY, reviews: [
    { author: "Mtuchel", state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T08:00:00Z", body: "Two things before this can land.", commit: HEAD },
    { author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T08:10:00Z", body: "Nit.", commit: HEAD },
    { author: "ada", state: "APPROVED", submittedAt: "2026-09-29T08:20:00Z", body: "", commit: HEAD },
    { author: "bob", state: "DISMISSED", submittedAt: "2026-09-29T08:30:00Z", body: "Stale.", commit: HEAD },
  ] };
  const calls = await h.poll();
  assert.equal(calls.length, 2);
  assert.equal(promptOf(calls), `@Mtuchel requested changes on [the pull request](${PR}):\n> Two things before this can land.\n\nUnresolved review threads:\n- [db/migrate.sql](${PR}#discussion_r2) @Mtuchel: Split this migration. (1 reply)\n\nNext step: address them, then \`gt submit --stack\`.\n\nThis is nudge 1 of 2 for this step; after that the owner takes over.`, "ada approved since, bob's review was dismissed");
  assert.equal(calls.at(-1), "say thought The pull request is waiting for the agent to address the requested changes; it was asked to.");
  h.github.threads = [];
  assert.deepEqual(await h.poll(), [], "sent; no merge nudge while a change request is open");
});

test("a change request is sent once however many heads follow it; a new request on a later head is sent again", async (t) => {
  const h = harness(t);
  const mtuchel = { author: "Mtuchel", state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T08:00:00Z", body: "Two things before this can land.", commit: HEAD };
  h.github.view = { ...READY, reviews: [mtuchel] };
  assert.match(promptOf(await h.poll()) ?? "", /^@Mtuchel requested changes[^]*nudge 1 of 2/);
  for (const head of ["h2", "h3", "h4"]) {
    h.github.view = { ...h.github.view, headSha: head };
    assert.deepEqual(await h.poll(), [], `pushed ${head} without a new review: no prompt, no escalation, no merge nudge`);
  }
  h.github.view = { ...h.github.view, reviews: [mtuchel, { author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T09:00:00Z", body: "Nit.", commit: "h4" }] };
  const later = promptOf(await h.poll()) ?? "";
  assert.match(later, /^@Mtuchel requested changes on \[the pull request\]\([^)]*\) at `a1b2c3d`, before the latest commits:\n> Two things before this can land\.\n@ada requested changes on \[the pull request\]\([^)]*\):\n> Nit\.\n/);
  assert.match(later, /Where the new commits already address a review, reply on its threads and re-request a review from @Mtuchel\.\n\nThis is nudge 2 of 2/);
  h.github.view = { ...h.github.view, headSha: "h5", reviews: [...h.github.view.reviews, { ...mtuchel, submittedAt: "2026-09-29T10:00:00Z", commit: "h5" }] };
  const third = await h.poll();
  assert.equal(promptOf(third), undefined);
  assert.match(third.find((call) => call.startsWith("comment")) ?? "", new RegExp(`^comment ${OWNER} Paseo asked the agent 2 times to address the requested changes`), "a third request goes to the owner");
});

test("GitHub's changes-requested decision alone is a change request, sent once, and holds the merge", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, reviewDecision: "CHANGES_REQUESTED" };
  assert.equal(promptOf(await h.poll()), `GitHub reports changes requested on [the pull request](${PR}).\n\nNext step: address them, then \`gt submit --stack\`.\n\nThis is nudge 1 of 2 for this step; after that the owner takes over.`);
  h.github.view = { ...h.github.view, headSha: "h2" };
  assert.deepEqual(await h.poll(), [], "once per pull request, not per head");
});

test("the merge nudge needs PR code and PR metadata finished on the head; an empty or incomplete rollup is not green", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, checks: [] };
  assert.deepEqual(await h.poll(), [], "no checks reported yet");
  h.github.view = { ...READY, checks: [GREEN, passing("PR code")] };
  assert.deepEqual(await h.poll(), [], "PR metadata missing");
  h.github.view = { ...READY, checks: [GREEN, passing("PR code"), { ...RUNNING_CI, name: "PR metadata" }] };
  assert.deepEqual(await h.poll(), [], "PR metadata still running");
  h.github.view = { ...READY, checks: [...READY.checks, passing("Label queued PRs for Linear", "neutral")] };
  assert.deepEqual(await h.poll(), [], "the labelling check must succeed or be skipped");
  h.github.view = { ...READY, checks: [...READY.checks, passing("Label queued PRs for Linear", "skipped"), passing("PR code", "skipped")] };
  assert.match(promptOf(await h.poll()) ?? "", /is ready: its checks are green/);
});

test("one instruction per agent and poll: the pull requests of one stack take turns", async (t) => {
  const h = harness(t);
  h.records.push({ ...h.records[0], issueId: "i2", identifier: "TUC-2", links: { "Pull request": "https://github.com/tuchel-sohn/tuchel-platform/pull/420" } });
  h.github.view = { ...READY, checks: [failing("PR code")] };
  const first = await h.poll();
  assert.equal(first.filter((call) => call.startsWith("prompt")).length, 1);
  assert.match(promptOf(first) ?? "", /pull\/419/);
  const second = await h.poll();
  assert.equal(second.filter((call) => call.startsWith("prompt")).length, 1);
  assert.match(promptOf(second) ?? "", /pull\/420/);
  assert.deepEqual(await h.poll(), []);

  const dropped = harness(t);
  dropped.records.push({ ...dropped.records[0], issueId: "i2", identifier: "TUC-2", links: { "Pull request": "https://github.com/tuchel-sohn/tuchel-platform/pull/420" } });
  dropped.github.view = { ...READY, checks: [failing("PR code")], mergeActivity: activity(QUEUED, CONFLICT) };
  const calls = await dropped.poll();
  assert.equal(calls.filter((call) => call.startsWith("prompt")).length, 1);
  assert.match(promptOf(calls) ?? "", /^The Graphite merge queue dropped \[the pull request\]\([^)]*419\)/, "the drop of the first pull request; the second one's drop waits");
  assert.match(promptOf(await dropped.poll()) ?? "", /^The Graphite merge queue dropped \[the pull request\]\([^)]*420\)/);
});

test("unresolved bot review findings are sent for the review loop", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.github.threads = [FINDING];
  assert.equal(promptOf(await h.poll()), `Reviewers left unresolved findings on [the pull request](${PR}):\n- [server/upload.ts:42](${PR}#discussion_r1) @greptile-apps: P2 The retry loop never gives up.\n\nNext step: run the AGENTS.md review loop on them.\n\nThis is nudge 1 of 2 for this step; after that the owner takes over.`);
});

test("a ready, green, reviewed pull request outside the queue is told to merge; a human's open thread, a missing Greptile review or the queue (running or just landed) hold it, Graphite's pending mergeability check does not", async (t) => {
  const h = harness(t);
  const human: ReviewThread = { resolved: false, path: null, line: null, comments: [{ author: "Mtuchel", bot: false, body: "Why?", createdAt: ago(MINUTE), url: `${PR}#discussion_r4` }] };
  h.github.threads = [human];
  h.github.view = READY;
  assert.deepEqual(await h.poll(), [], "a person's thread is open");
  h.github.threads = [];
  h.github.view = { ...READY, labels: ["complex-review"], reviews: [{ author: "greptile-apps", state: "COMMENTED", submittedAt: "2026-09-29T08:00:00Z", body: "", commit: "0ld" }] };
  assert.equal(promptOf(await h.poll()), undefined, "complex-review: Greptile has not reviewed this head");
  h.github.view = { ...h.github.view, reviews: [{ author: "greptile-apps", state: "COMMENTED", submittedAt: "2026-09-29T09:00:00Z", body: "", commit: HEAD }], mergeActivity: activity(QUEUED) };
  assert.equal(promptOf(await h.poll()), undefined, "added to the queue");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(460)) };
  assert.deepEqual(await h.poll(), [], "the queue's CI runs");
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(460), `Merged by the [Graphite merge queue](https://app.graphite.com/merges) via draft PR: ${graphiteLink(460)}.`) };
  assert.deepEqual(await h.poll(), [], "landed, about to be closed");
  h.github.view = { ...h.github.view, mergeActivity: null };
  h.github.drafts = [draft(461, [418, 419], "OPEN")];
  assert.deepEqual(await h.poll(), [], "an open queue draft lists it");
  h.github.drafts = [];
  h.github.view = { ...h.github.view, reviewDecision: "CHANGES_REQUESTED" };
  assert.match(promptOf(await h.poll()) ?? "", /^GitHub reports changes requested/, "no merge while GitHub reports changes requested");
  h.github.view = { ...h.github.view, reviewDecision: "", checks: [...h.github.view.checks, { ...RUNNING_CI, name: "Graphite / mergeability_check" }] };
  assert.equal(promptOf(await h.poll()), `[The pull request](${PR}) is ready: its checks are green, no review thread is open, the reviewers are done, and it is not in the merge queue.\nNext step: \`gt merge\`, then \`node tools/ci/wait-queue.mjs <top PR>\` with the top pull request of your stack (419 if this one is the top).\n\nThis is nudge 1 of 2 for this step; after that the owner takes over.`);
});

test("the first matching stage wins: draft, then failed checks, then requested changes, then findings, then merge", async (t) => {
  const h = harness(t);
  h.github.threads = [FINDING];
  const changes = { author: "Mtuchel", state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T09:00:00Z", body: "No.", commit: HEAD };
  h.github.view = { ...READY, isDraft: true, updatedAt: ago(60 * MINUTE), checks: [failing("PR code")], reviews: [changes] };
  assert.match(promptOf(await h.poll()) ?? "", /still a draft/);
  h.github.view = { ...h.github.view, isDraft: false };
  assert.match(promptOf(await h.poll()) ?? "", /^Checks failed/);
  h.github.view = { ...h.github.view, checks: READY.checks };
  assert.match(promptOf(await h.poll()) ?? "", /requested changes/);
  h.github.view = { ...h.github.view, reviews: [] };
  assert.match(promptOf(await h.poll()) ?? "", /unresolved findings/);
  h.github.threads = [];
  assert.match(promptOf(await h.poll()) ?? "", /is ready: its checks are green/);
});

test("do-not-merge and open manual tasks keep every nudge and escalation away", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, labels: ["do-not-merge"] };
  for (let head = 0; head < 4; head++) {
    h.github.view = { ...h.github.view, headSha: `veto${head}` };
    assert.deepEqual(await h.poll(), [], "vetoed");
  }
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.blockers.push("TUC-9");
  assert.deepEqual(await h.poll(), [], "a manual task is due before the merge");
  for (const view of [READY, { ...READY, labels: ["do-not-merge"] }]) {
    h.github.view = view;
    assert.deepEqual(await h.poll(), []);
    assert.equal(h.github.threadReads, 0, "blocked pull requests are settled before review threads are read");
  }
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.blockers.length = 0;
  assert.match(promptOf(await h.poll()) ?? "", /nudge 1 of 2/, "the veto and the task claimed nothing");
});

test("a busy agent or a failed send is nudged on a later poll; a gone agent's nudge goes to the ticket", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.paseo.answer = async () => "busy";
  assert.deepEqual(await h.poll(), [], "in a turn");
  h.paseo.answer = async () => "unavailable";
  assert.deepEqual(await h.poll(), [], "Paseo not connected");
  h.paseo.answer = async () => "sent";
  h.paseo.send = async () => { throw new Error("connection lost while sending"); };
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await h.poll(), [], "the send failed");
  h.paseo.send = async () => {};
  assert.match(promptOf(await h.poll()) ?? "", /nudge 1 of 2/, "still the first nudge");

  const gone = harness(t, { live: false });
  gone.github.view = { ...READY, checks: [failing("PR code")] };
  const calls = await gone.poll();
  assert.equal(calls[0], "move In Progress");
  assert.match(calls[1], new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running, so the ticket is back in In Progress for the next one\\.\n\nChecks failed on the head`));
  assert.match(calls[1], /This is nudge 1 of 2 for this step/);
  assert.equal(calls[2], "say response The pull request is waiting for the agent to fix the failing checks, and the agent is no longer running; the ticket is back in In Progress.");
  assert.equal(calls.length, 3);
  assert.deepEqual(await gone.poll(), []);
});

test("two nudges per stage across heads, then one owner escalation, then only the log; other stages keep their own budget", async (t) => {
  const h = harness(t, { live: false });
  const log = t.mock.method(console, "error", () => {});
  const red = (head: string) => ({ ...READY, headSha: head, checks: [failing("PR code")] });
  h.github.view = red("h1");
  assert.match((await h.poll())[1], /nudge 1 of 2/, "a gone agent's hand-back counts as a nudge");
  assert.deepEqual(await h.poll(), [], "same head");
  h.paseo.answer = async () => "sent";
  h.github.view = red("h2");
  assert.match(promptOf(await h.poll()) ?? "", /nudge 2 of 2/, "a new head re-nudges within the budget");
  h.github.view = red("h3");
  const third = await h.poll();
  assert.equal(promptOf(third), undefined);
  assert.match(third[0], new RegExp(`^comment ${OWNER} Paseo asked the agent 2 times to fix the failing checks on \\[the pull request\\]\\(${PR.replace(/[/.]/g, "\\$&")}\\), and it is stuck there again, so Paseo stops asking\\. Please take over\\.\n\nChecks failed`));
  assert.equal(third[1], "say response The pull request is stuck again waiting for the agent to fix the failing checks; the owner was asked to take over.");
  h.github.view = red("h4");
  assert.deepEqual(await h.poll(), []);
  assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /waiting for the agent to fix the failing checks again; already escalated to the owner/);
  const logged = log.mock.callCount();
  assert.deepEqual(await h.poll(), []);
  assert.equal(log.mock.callCount(), logged, "logged once per head");
  h.github.view = { ...READY, headSha: "h4" };
  assert.match(promptOf(await h.poll()) ?? "", /is ready[^]*nudge 1 of 2/, "the merge stage starts its own budget");
});
