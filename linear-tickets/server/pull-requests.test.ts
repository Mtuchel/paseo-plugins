import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubRateLimitedError } from "./pr-watch";
import { checkSummary, pullEntry, PullRequestBoard, queueActivity, supersededSuites, type CheckRunRecord, type RestGet } from "./pull-requests";
import { GitHubBudget } from "./rate-budget";

const NOW = Date.UTC(2026, 9, 3, 8, 30);
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 3, hour, minute)).toISOString().replace(/\.\d{3}Z$/, "Z");
const run = (name: string, fields: Partial<CheckRunRecord> = {}): CheckRunRecord =>
  ({ name, status: "completed", conclusion: "success", startedAt: at(8), htmlUrl: `https://ci/${name}`, suite: 1, ...fields });

// Graphite's Merge activity comment, one time-stamped bullet per event.
const activity = (...bullets: [string, string][]) => `### Merge activity\n\n${bullets.map(([time, text]) => `* **${time}**: ${text}`).join("\n")}\n`;
const QUEUED = "`Mtuchel` added this pull request to the [Graphite merge queue](https://app.graphite.com/merges).";
const testing = (draft: number) => `CI is running for this pull request on a draft pull request ([#${draft}](https://app.graphite.com/github/pr/o/r/${draft})) due to your merge queue CI optimization settings.`;
const removed = (why: string) => `The Graphite merge queue removed this pull request due to ${why}.`;

test("CI summary: the newest run per check counts, Graphite's mergeability check never", () => {
  const summary = checkSummary([
    run("build", { conclusion: "failure", startedAt: at(7) }),
    run("build", { startedAt: at(8) }),
    run("Graphite / mergeability_check", { status: "in_progress", conclusion: null }),
    run("mergeability_check", { conclusion: "failure" }),
  ]);
  assert.deepEqual(summary, { state: "passed", done: 1, total: 1, failures: [], runningSince: null });
  assert.equal(checkSummary([]).state, "empty");
});

test("CI summary: a failed job is named instead of the gate waiting on it; a gate alone is named", () => {
  const withJob = checkSummary([run("PR code", { conclusion: "failure" }), run("unit", { conclusion: "timed_out" }), run("e2e", { conclusion: "failure" }), run("lint", { conclusion: "cancelled" })]);
  assert.equal(withJob.state, "failed");
  assert.deepEqual(withJob.failures.map((failure) => failure.name), ["e2e", "unit"]);
  const gateOnly = checkSummary([run("Platform gate", { conclusion: "failure" }), run("unit")]);
  assert.deepEqual(gateOnly.failures, [{ name: "Platform gate", url: "https://ci/Platform gate" }]);
});

test("CI summary: running since the oldest start among checks still running", () => {
  const summary = checkSummary([
    run("unit", { status: "in_progress", conclusion: null, startedAt: at(8, 20) }),
    run("e2e", { status: "queued", conclusion: null, startedAt: null }),
    run("deploy", { status: "in_progress", conclusion: null, startedAt: at(6, 5) }),
    run("lint", { startedAt: at(5) }),
  ]);
  assert.deepEqual({ state: summary.state, done: summary.done, total: summary.total, runningSince: summary.runningSince }, { state: "running", done: 1, total: 4, runningSince: at(6, 5) });
});

test("CI summary: a workflow run a later run of the same workflow replaced does not fail the head", () => {
  // The draft-only `PR code` guard (suite 1) failed; once ready, workflow 7 ran again as suite 3.
  const superseded = supersededSuites([
    { id: 100, workflowId: 7, checkSuiteId: 1 },
    { id: 105, workflowId: 7, checkSuiteId: 3 },
    { id: 101, workflowId: 8, checkSuiteId: 2 },
  ]);
  assert.deepEqual([...superseded], [1]);
  const summary = checkSummary([
    run("PR code", { conclusion: "failure", suite: 1, startedAt: at(8, 10) }),
    run("PR code guard", { suite: 3 }),
    run("unit", { suite: 2 }),
  ], superseded);
  assert.deepEqual({ state: summary.state, total: summary.total }, { state: "passed", total: 2 });
});

test("queue activity: the newest bullet decides; testing names its round", () => {
  const body = activity(["Oct 3, 7:40 AM UTC", QUEUED], ["Oct 3, 7:52 AM UTC", testing(1480)]);
  assert.deepEqual(queueActivity(body, NOW), { kind: "testing", draft: 1480, reason: null, at: at(7, 52), dropsToday: 0, inQueue: true });
  assert.equal(queueActivity(activity(["Oct 3, 7:40 AM UTC", QUEUED]), NOW)?.kind, "queued");
  const merged = queueActivity(activity(["Oct 3, 8:01 AM UTC", "Merged by the Graphite merge queue."]), NOW);
  assert.deepEqual({ kind: merged?.kind, inQueue: merged?.inQueue }, { kind: "merged", inQueue: false });
  assert.equal(queueActivity("Some other comment\n* **Oct 3, 7:40 AM UTC**: x", NOW), null);
});

test("queue activity: a drop carries Graphite's short reason and counts removals of the last 24 hours", () => {
  const body = activity(
    ["Oct 1, 9:00 PM UTC", removed("downstack failures on PR #1200")],
    ["Oct 2, 9:40 PM UTC", removed("downstack failures on PR #1251")],
    ["Oct 3, 6:00 AM UTC", QUEUED],
    ["Oct 3, 7:10 AM UTC", "The Graphite merge queue removed this pull request due to it was not satisfying all requirements (Failed CI (PR code))."],
  );
  assert.deepEqual(queueActivity(body, NOW), { kind: "dropped", draft: null, reason: "Failed CI (PR code)", at: at(7, 10), dropsToday: 2, inQueue: false });
  const downstack = queueActivity(activity(["Oct 3, 7:10 AM UTC", removed("downstack failures on PR #1251")]), NOW);
  assert.equal(downstack?.reason, "downstack failures on PR #1251");
  // Any other ending reads as a drop with its own text.
  const conflict = queueActivity(activity(["Oct 3, 7:10 AM UTC", "The [Graphite merge queue](https://g) couldn't merge this PR because **it had merge conflicts**."]), NOW);
  assert.deepEqual({ kind: conflict?.kind, reason: conflict?.reason, dropsToday: conflict?.dropsToday }, { kind: "dropped", reason: "The Graphite merge queue couldn't merge this PR because it had merge conflicts.", dropsToday: 0 });
});

test("queue activity: a bullet without a year is from last year when this year's date is ahead", () => {
  const newYear = Date.UTC(2027, 0, 1, 0, 30);
  assert.equal(queueActivity(activity(["Dec 31, 11:50 PM UTC", QUEUED]), newYear)?.at, "2026-12-31T23:50:00Z");
  assert.equal(queueActivity(activity(["Jan 1, 12:10 AM UTC", QUEUED]), newYear)?.at, "2027-01-01T00:10:00Z");
});

test("pull entry: ticket and short title come from the title; the queue label is stale only outside the queue", () => {
  const fields = {
    number: 13, title: "Add TUC-343 [platform] Queue status", draft: false, htmlUrl: "https://github.com/o/r/pull/13", createdAt: at(7), updatedAt: at(8),
    user: { login: "Mtuchel" }, head: { ref: "dependabot/npm/tailwindcss-4", sha: "s" }, base: { ref: "main", sha: "b" }, labels: [{ name: "externally-merged" }],
  };
  const entry = pullEntry(fields, null, null);
  assert.deepEqual({ ticket: entry.ticket, shortTitle: entry.shortTitle, stale: entry.hasStaleQueueLabel }, { ticket: "TUC-343", shortTitle: "Queue status", stale: true });
  assert.equal(pullEntry({ ...fields, title: "Bump tailwindcss" }, null, null).ticket, null);
  const inQueue = queueActivity(activity(["Oct 3, 7:40 AM UTC", QUEUED]), NOW);
  assert.equal(pullEntry(fields, null, inQueue).hasStaleQueueLabel, false);
});

// A fake api.github.com: ETags from the content, 304 when the client's ETag still matches.
function fakeGitHub() {
  const pull = (number: number, title: string, fields: { draft?: boolean; ref?: string; login?: string; labels?: string[] } = {}) => ({
    number, title, draft: fields.draft ?? false, html_url: `https://github.com/o/r/pull/${number}`, created_at: at(6), updated_at: at(7),
    user: { login: fields.login ?? "Mtuchel" }, head: { ref: fields.ref ?? `b${number}`, sha: `s${number}` }, base: { ref: "main", sha: "m", repo: { default_branch: "main" } },
    labels: (fields.labels ?? []).map((name) => ({ name })),
  });
  const state = {
    remaining: 4000,
    pages: [
      [pull(10, "Add TUC-1 [web] Orders export", { labels: ["externally-merged"] }), pull(11, "Fix TUC-2 [api] Draft work", { draft: true })],
      [pull(12, "[Graphite MQ] Draft PR GROUP:spec_12 (PRs 10)", { draft: true, ref: "gtmq_spec_12", login: "graphite-app[bot]" }), pull(13, "Bump tailwindcss", { ref: "dependabot/npm/tailwindcss-4" })],
    ],
    checks: {
      s10: [{ name: "unit", status: "in_progress", conclusion: null, started_at: at(8), html_url: "https://ci/unit", check_suite: { id: 2 } }],
      s12: [{ name: "e2e", status: "completed", conclusion: "failure", started_at: at(8), html_url: "https://ci/e2e", check_suite: { id: 5 } }],
    } as Record<string, unknown[]>,
    comments: {
      10: [{ user: { login: "greptile-apps[bot]" }, body: "Summary" }, { user: { login: "graphite-app[bot]" }, body: activity(["Oct 3, 7:52 AM UTC", testing(12)]) }],
    } as Record<number, unknown[]>,
    commits: [{ sha: "c1", commit: { message: "Add TUC-515 [web] Orders export (#1450)\n\nBody", committer: { date: at(6, 12) } } }],
    calls: [] as { path: string; etag: string | null }[],
    throttle: false,
  };
  const body = (path: string): unknown => {
    if (path.startsWith("repos/o/r/pulls?")) return state.pages[0];
    if (path === "repositories/1/pulls?page=2") return state.pages[1];
    const sha = /commits\/(\w+)\/check-runs/.exec(path) ?? /head_sha=(\w+)/.exec(path);
    if (sha && path.includes("check-runs")) return { check_runs: state.checks[sha[1]] ?? [] };
    if (sha) return { workflow_runs: [] };
    const comments = /issues\/(\d+)\/comments/.exec(path);
    if (comments) return state.comments[Number(comments[1])] ?? [];
    if (path.startsWith("repos/o/r/commits?sha=main&since=")) return state.commits;
    throw new Error(`unexpected path ${path}`);
  };
  const get: RestGet = async (path, etag) => {
    state.calls.push({ path, etag });
    if (state.throttle) throw new GitHubRateLimitedError("GitHub is throttling gh: API rate limit exceeded (HTTP 403)");
    const json = JSON.stringify(body(path));
    const headers = new Map([["etag", `"${json.length}:${json}"`], ["x-ratelimit-remaining", String(state.remaining)], ["x-ratelimit-limit", "5000"], ["x-ratelimit-reset", String((NOW + 30 * 60_000) / 1000)], ["x-ratelimit-resource", "core"]]);
    if (path.startsWith("repos/o/r/pulls?")) headers.set("link", '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=2>; rel="last"');
    return etag === headers.get("etag") ? { status: 304, headers, body: "" } : { status: 200, headers, body: json };
  };
  return { state, get };
}

function board(github = fakeGitHub(), post: (repository: string, number: number, label: string) => Promise<string[]> = async () => []) {
  const time = { now: NOW };
  const instance = new PullRequestBoard({ get: github.get, post, budget: new GitHubBudget(() => time.now), now: () => time.now });
  return { time, board: instance, github };
}

test("the first ask answers at once and polls; queue drafts are separate and only ready PRs and rounds are read in detail", async (t) => {
  const { board: pulls, github } = board();
  t.after(() => pulls.stop());
  const first = pulls.read("o/r");
  assert.deepEqual({ fetchedAt: first.fetchedAt, refreshing: first.refreshing, pulls: first.pulls }, { fetchedAt: null, refreshing: true, pulls: [] });
  await pulls.settled("o/r");
  const snapshot = pulls.read("o/r");
  assert.equal(snapshot.fetchedAt, at(8, 30));
  assert.deepEqual(snapshot.pulls.map((pull) => pull.number), [10, 11, 13]);
  assert.deepEqual(snapshot.queueDrafts.map((pull) => [pull.number, pull.checks?.state]), [[12, "failed"]]);
  const [ready, draft, bump] = snapshot.pulls;
  assert.deepEqual({ checks: ready.checks?.state, since: ready.checks?.runningSince, queue: ready.queue?.kind, round: ready.queue?.draft, stale: ready.hasStaleQueueLabel }, { checks: "running", since: at(8), queue: "testing", round: 12, stale: false });
  assert.deepEqual({ checks: draft.checks, queue: draft.queue }, { checks: null, queue: null });
  assert.deepEqual({ checks: bump.checks?.state, queue: bump.queue }, { checks: "empty", queue: null });
  assert.deepEqual(snapshot.landedRecently, [{ sha: "c1", title: "Add TUC-515 [web] Orders export (#1450)", date: at(6, 12), ticket: "TUC-515" }]);
  assert.deepEqual(snapshot.rateLimit, { remaining: 4000, limit: 5000, resetsAt: at(9) });
  const read = github.state.calls.map((call) => call.path);
  assert.ok(!read.some((path) => path.includes("s11") || path.includes("issues/11/") || path.includes("issues/12/")), read.join("\n"));
});

test("polls at most every two minutes, conditionally: unchanged pages answer 304 and keep their data", async (t) => {
  const { board: pulls, github, time } = board();
  t.after(() => pulls.stop());
  pulls.read("o/r");
  await pulls.settled("o/r");
  const firstRound = github.state.calls.length;
  time.now += 60_000;
  pulls.read("o/r");
  pulls.tick();
  assert.equal(github.state.calls.length, firstRound);
  time.now += 60_000;
  github.state.pages[1][1].labels = [{ name: "do-not-merge" }];
  pulls.tick();
  await pulls.settled("o/r");
  const secondRound = github.state.calls.slice(firstRound);
  assert.equal(secondRound.length, firstRound);
  assert.ok(secondRound.every((call) => call.etag !== null));
  const snapshot = pulls.read("o/r");
  assert.equal(snapshot.fetchedAt, at(8, 32));
  assert.deepEqual(snapshot.pulls.find((pull) => pull.number === 13)?.labels, [{ name: "do-not-merge" }]);
  assert.equal(snapshot.pulls[0].queue?.kind, "testing");
  assert.equal(snapshot.queueDrafts[0].checks?.state, "failed");
});

test("nobody asked for ten minutes: no more polls until the next ask", async (t) => {
  const { board: pulls, github, time } = board();
  t.after(() => pulls.stop());
  pulls.read("o/r");
  await pulls.settled("o/r");
  const calls = github.state.calls.length;
  time.now += 10 * 60_000 + 1;
  pulls.tick();
  await pulls.settled("o/r");
  assert.equal(github.state.calls.length, calls);
  pulls.read("o/r");
  await pulls.settled("o/r");
  assert.ok(github.state.calls.length > calls);
});

test("below the budget's reserve the poll stops and keeps its data; labelling still goes through", async (t) => {
  const labelled: number[] = [];
  const { board: pulls, github, time } = board(fakeGitHub(), async (_repository, number, label) => { labelled.push(number); return [label]; });
  t.after(() => pulls.stop());
  pulls.read("o/r");
  await pulls.settled("o/r");
  github.state.remaining = 250;
  time.now += 120_000;
  pulls.tick();
  await pulls.settled("o/r");
  const snapshot = pulls.read("o/r");
  assert.equal(snapshot.fetchedAt, at(8, 30));
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.rateLimited && { reason: snapshot.rateLimited.reason, until: snapshot.rateLimited.until }, { reason: "budget", until: at(9) });
  assert.match(snapshot.rateLimited?.message ?? "", /250 left/);
  assert.deepEqual(snapshot.pulls.map((pull) => pull.number), [10, 11, 13]);
  const result = await pulls.label("o/r", "approved-migration", [13]);
  assert.deepEqual({ labelled: result.labelled, error: result.error, called: labelled }, { labelled: [13], error: null, called: [13] });
});

test("GitHub throttling the login shows as rate limited, not as an error", async (t) => {
  const github = fakeGitHub();
  github.state.throttle = true;
  const { board: pulls } = board(github);
  t.after(() => pulls.stop());
  pulls.read("o/r");
  await pulls.settled("o/r");
  const snapshot = pulls.read("o/r");
  assert.deepEqual({ error: snapshot.error, reason: snapshot.rateLimited?.reason, until: snapshot.rateLimited?.until }, { error: null, reason: "throttled", until: at(8, 32) });
});

test("labelling stops at the first PR GitHub refuses; the labels it answered with show at once", async (t) => {
  const tried: number[] = [];
  const post = async (_repository: string, number: number, label: string) => {
    tried.push(number);
    if (number === 99) throw Object.assign(new Error("Command failed: gh api -X POST …"), { stderr: "gh: Not Found (HTTP 404)\n" });
    return ["externally-merged", label];
  };
  const { board: pulls, github } = board(fakeGitHub(), post);
  t.after(() => pulls.stop());
  pulls.read("o/r");
  await pulls.settled("o/r");
  const calls = github.state.calls.length;
  const result = await pulls.label("o/r", "approved-test-change", [13, 99, 11]);
  assert.deepEqual(tried, [13, 99]);
  assert.deepEqual(result.labelled, [13]);
  assert.equal(result.error, "GitHub refused #99: Not Found (HTTP 404)");
  const bump = result.snapshot.pulls.find((pull) => pull.number === 13);
  assert.deepEqual(bump?.labels, [{ name: "externally-merged" }, { name: "approved-test-change" }]);
  // Labelled externally-merged without being in the queue.
  assert.equal(bump?.hasStaleQueueLabel, true);
  assert.equal(github.state.calls.length, calls);
});
