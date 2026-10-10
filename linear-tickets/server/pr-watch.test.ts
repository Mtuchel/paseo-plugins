import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CONTEXT_TOO_LARGE } from "./context";
import type { RetriggerResult } from "./greptile-outage";
import type { HandoverRecord } from "./handover";
import type { ReviewThread } from "./pr-nudge";
import { activityBullets, ConditionalPullView, githubReader, PullRequestNotFoundError, PullRequestWatch, type CheckRun, type OpenPull, type PullRequestView, type PullViewSource, type QueueDraft, type RateProbe } from "./pr-watch";
import { BACKSTOP_ENQUEUE, ENQUEUE_READY, GREPTILE_RETRIGGER, marker, RETARGET_ORPHAN, WAIT_QUEUE, type ScriptOutput } from "./queue-backstop";
import { GitHubBudget, GitHubPausedError, GitHubRateLimitedError, RateLimitedError, withPriority } from "./rate-budget";
import { PermissionReplies } from "./permission-replies";
import { SessionRouter, type IdleRun, type Succession } from "./sessions";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { Watchdog, WatchdogStore, type WatchedAgent } from "./watchdog";
import { githubRouted } from "./github-cli";
import { ghGet } from "./pull-requests";

const settings = { dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, status: true } } as unknown as PluginSettings;
const OWNER = "https://linear.app/ws/profiles/me";
const PR = "https://github.com/tuchel-sohn/tuchel-platform/pull/419";
// The owner policy every nudge prompt ends with (TUC-1777); the drop fix requests close it with
// "; never because of a drop count".
const OWNER_POLICY = "Ask the owner only for a decision that can break something (data, production or staging, migrations, security, reverting someone else's landed work) or that changes how CI works in general (required checks, CI selection, quarantine, queue settings), through the ticket's normal question path (the deputy answers first)";
const NUDGE_CLOSE = `${OWNER_POLICY}; never just wait.`;
// Mirrors STAGE_NUDGES (module-private in server/pr-watch.ts): every third nudge of a stage adds the
// approach line, and a crash after three restarts of an agent starts a successor.
const STAGE_NUDGES = 3;
const graphiteLink = (number: number) => `[#${number}](https://app.graphite.com/github/pr/tuchel-sohn/tuchel-platform/${number})`;

async function failingGh(t: TestContext, source: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "paseo-gh-failure-"));
  const cli = join(home, "gh");
  const previous = process.env.LINEAR_TICKETS_GH;
  t.after(async () => {
    if (previous === undefined) delete process.env.LINEAR_TICKETS_GH;
    else process.env.LINEAR_TICKETS_GH = previous;
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(cli, `#!${process.execPath}\n${source}\n`);
  await chmod(cli, 0o700);
  process.env.LINEAR_TICKETS_GH = cli;
}

test("failed GitHub comment writes retain diagnostics without leaking the body to logs", async (t) => {
  for (const [status, code, reason, kind] of [
    [422, 1, "Validation failed", Error],
    [429, 1, "rate limit exceeded", GitHubRateLimitedError],
    [404, 1, "Could not resolve to a PullRequest", PullRequestNotFoundError],
    [503, 75, "GitHub read budgets exhausted", GitHubRateLimitedError],
  ] as const) {
    await t.test(`HTTP ${status}, exit ${code}`, async (t) => {
      await failingGh(t, `
const body = process.argv.slice(2).find(arg => arg.startsWith("body=")).slice(5);
process.stdout.write("response metadata");
process.stderr.write(body + "\\n" + JSON.stringify({ body }) + "\\n${reason} (HTTP ${status})\\n");
process.exitCode = ${code};`);
      const sentinels = ["PRIVATE_COMMENT_FIRST_LINE", "PRIVATE_COMMENT_SECOND_LINE"];
      await assert.rejects(() => githubReader.commentOnPull("o/r", 419, sentinels.join("\n")), (error: unknown) => {
        assert.ok(error instanceof kind);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.match(error.message, new RegExp(`exit ${code}`));
        assert.ok("stderr" in error && "stdout" in error && "code" in error && "signal" in error);
        assert.equal(error.stdout, "response metadata");
        assert.equal(error.code, code);
        assert.equal(error.signal, null);
        const loggable = `${error}\n${error.stack}\n${error.stderr}`;
        for (const sentinel of sentinels) assert.ok(!loggable.includes(sentinel), "no body line reaches a loggable diagnostic");
        assert.ok(!loggable.includes("body="), "the raw command line is not retained");
        return true;
      });
    });
  }
});

test("a failed gh exit carrying HTTP 304 still serves conditional REST headers", async (t) => {
  await failingGh(t, `
process.stdout.write('HTTP/2.0 304 Not Modified\\r\\netag: "cached"\\r\\nx-ratelimit-remaining: 4900\\r\\n\\r\\n');
process.stderr.write("gh: Not Modified (HTTP 304)\\n");
process.exitCode = 1;`);
  const response = await ghGet("repos/o/r/issues/419", '"cached"');
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"cached"');
  assert.equal(response.headers.get("x-ratelimit-remaining"), "4900");
  assert.equal(response.body, "");
});

// Graphite's Merge activity comment; each bullet gets its own minute, as Graphite stamps them.
function activity(...events: string[]): string {
  return `### Merge activity\n\n${events.map((event, index) => `* **Sep 29, 7:${String(index).padStart(2, "0")} AM UTC**: ${event}`).join("\n")}\n`;
}
const QUEUED = "`Mtuchel` added this pull request to the [Graphite merge queue](https://app.graphite.com/merges?org=tuchel-sohn&repo=tuchel-platform).";
const running = (draft: number) => `CI is running for this pull request on a draft pull request (${graphiteLink(draft)}) due to your merge queue CI optimization settings.`;
const CONFLICT = "The [Graphite merge queue](https://app.graphite.com/merges?org=tuchel-sohn&repo=tuchel-platform) couldn't merge this PR because **it had merge conflicts**.";
// Dropped without a merge conflict: a plain drop.
const REMOVED = "The Graphite merge queue removed this PR because a required check failed.";

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

type Outcome = "sent" | "busy" | "waiting" | "gone" | "unavailable";

// A crashed agent as Paseo shows it; a reload keeps `lastError`, so a restarted agent still has it.
const CRASH = "OMP RPC process is closed";
const CRASHED = { status: "error", lastError: CRASH, pendingPermissions: [] };
const RESTARTED = { status: "idle", lastError: CRASH, pendingPermissions: [] };

// A real SessionRouter on a fake Paseo daemon with one agent: its snapshot is `agent`, a reload
// (`reload <id>` in the calls) sets it to `reloaded`, and a send is recorded like the fake
// router's prompts (`send` runs first and may throw).
function crashDaemon(calls: string[]) {
  const daemon = { agent: CRASHED as Record<string, unknown>, reloaded: RESTARTED as Record<string, unknown>, send: async () => {}, router: null as unknown as SessionRouter };
  let held = false;
  // The fake store has no path, so the router cannot derive its ledger directory from it: give it
  // an isolated one of its own (these paths send through the agent handle, not the reply ledger,
  // so no file is written).
  const replies = new PermissionReplies({ directory: join(tmpdir(), `paseo-pr-watch-${process.pid}-${Math.random().toString(36).slice(2)}`), daemon: async () => null });
  daemon.router = new SessionRouter({
    launcher: { gate: () => {
      if (held) return null;
      held = true;
      return { release: () => { held = false; } };
    } },
    store: { forAgent: async () => null },
    replies,
    reloader: async () => async (agentId: string) => { calls.push(`reload ${agentId}`); daemon.agent = daemon.reloaded; },
  } as never);
  Object.assign(daemon.router, { paseo: { agents: {
    ref: (id: string) => ({ refresh: async () => ({ agent: daemon.agent }), send: async (text: string) => { await daemon.send(); calls.push(`prompt ${id}\n${text}`); } }),
    list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
  } } });
  return daemon;
}

const HEAD = "a1b2c3d4e5f6";
const RUNNING_CI: CheckRun = { name: "Code validation / Core (core-web)", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/1/job/1", state: "pending", conclusion: "pending" };
// An open, ready pull request whose CI still runs: no lifecycle stage applies to it.
const OPEN_PR: PullRequestView = { state: "OPEN", isDraft: false, headSha: HEAD, headBranch: "mtuchel/tuc-1-fix", baseBranch: "main", updatedAt: "", reviewDecision: "", labels: [], mergeActivity: null, comments: [], reviews: [], lastCommitAt: null, checks: [RUNNING_CI], mergeable: null };
// A pull request as the repo's open listing shows it.
const listed = (url: string, view: PullRequestView, title = "Fix TUC-1 [plugin] Retry the upload", headRepo: string | null = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1] ?? null): OpenPull => ({
  number: Number(url.split("/").at(-1)), url, title, headBranch: view.headBranch, headRepo, headSha: view.headSha, baseBranch: view.baseBranch, trunk: "main", draft: view.isDraft, labels: view.labels,
});

// The repo's `wait-queue.mjs` judgment of a dropped round (see queue-backstop.ts): genuine, and
// its code could not be compared, unless a test says otherwise.
type Judgment = { class: string; requeue: boolean; evidence: string[]; revision: { state: string; draft?: number | null; branch?: string | null; expect?: string | null; reason: string }; failures: { check: string; conclusion: string; url: string; tests?: string[]; testIds?: string[] }[] };
const GENUINE: Judgment = { class: "genuine", requeue: false, evidence: [], revision: { state: "unknown", reason: "no queue draft" }, failures: [] };
// Graphite named a conflict that is still there: a restack, no automatic re-enqueue.
const CONFLICT_ONLY: Judgment = { class: "conflictOnly", requeue: false, evidence: [], revision: { state: "unknown", reason: "no queue draft" }, failures: [] };
// Every failed job was red on `main`; without a draft the code cannot be compared.
const MAIN_BROKEN: Judgment = {
  class: "mainBroken", requeue: true, evidence: ["Migration replay was red on main at 07:30"], revision: { state: "unknown", reason: "no queue draft" },
  failures: [{ check: "Code validation / Migration replay", conclusion: "failure", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/9/job/1" }],
};

// `crash`: the agent runs on crashDaemon (`daemon`) instead of the fake router (`paseo`).
// `autoResume`: the setting *Start a new agent automatically* (`writeback.autoResume`) is on, so a
// gone agent's message starts a successor (`paseo.succeed`).
// `owner`: what the peer mechanism (README, "Several hosts") names as this host's tickets: `all`
// (the default: a host without a peer) keeps every record, `none` names none of them, `unknown`
// cannot tell, and `throws` fails the read. `backstop`: the queue backstop's `run` setting; the
// harness host is the backstop host unless a test says otherwise.
// `probe`: the cheap first look the poll goes through (see ConditionalPullView); without one the
// injected `view` is the whole read, as for the tests that predate it.
function harness(t: TestContext, agent: { status?: HandoverRecord["status"]; live?: boolean; updatedAt?: string; crash?: boolean; autoResume?: boolean; dispatch?: boolean; owner?: "all" | "none" | "unknown" | "throws"; backstop?: "auto" | "always" | "never"; watchdog?: Pick<Watchdog, "pass" | "stop"> } = {}, probe?: PullViewSource) {
  const waits = { runs: 0, failure: null as Error | null };
  const records = [{ issueId: "i1", identifier: "TUC-1", agentId: "a1", agentTitle: "T", worktreePath: "/wt/tuc-1", links: { "Pull request": PR }, status: agent.status ?? "working", updatedAt: agent.updatedAt ?? new Date().toISOString() } as unknown as HandoverRecord];
  // `view`: the watched pull request, listed while open under `title`; `views`: other pull requests
  // by URL, and `open` the listing's other entries; `deleted`: branches gone; `throttle`: pull
  // requests whose read GitHub throttles, `broken` ones whose read fails otherwise; `listFailure`:
  // what listing the open pull requests throws; `comments`:
  // each pull request's conversation comments; `stall`: runs after a pull request comment went
  // out (a hanging one is a crash right after); `states`: pull request states as REST reads them
  // one by one (a draft's own state by default; `unreadable` ones fail).
  const github = { view: OPEN_PR, title: "Fix TUC-1 [plugin] Retry the upload", views: {} as Record<string, PullRequestView>, drafts: [] as QueueDraft[], landed: [] as number[], threads: [] as ReviewThread[], open: [] as OpenPull[], deleted: [] as string[], reads: [] as string[], listings: [] as string[], threadReads: 0, throttled: false, throttle: [] as string[], broken: [] as string[], missing: false, listFailure: null as Error | null, comments: {} as Record<number, string[]>, stall: async () => {}, states: {} as Record<number, string>, unreadable: [] as number[], stateReads: [] as number[] };
  // The repo's scripts the backstop runs from its checkout (`checkout` null: the repo has none).
  // `judgment`: what `wait-queue.mjs` answers for a dropped round (null: still running; `judgments`
  // per pull request override it), or
  // `queueFailure` its stderr when it fails; `ready`: `enqueue-ready.mjs`'s answer; `enqueue`:
  // `backstop-enqueue.mjs`'s answers in turn (the last one repeats; enqueued and commented by
  // default). `onEnqueue`: what an enqueue changes (Graphite's bullets); `answered` runs before
  // the script's answer reaches the plugin and `beforeEnqueue` before the comment file is written
  // (stalling them is a crash after or before the enqueue); `runs`: every run, as
  // `<script> <args>`; `now`: the backstop's clock. `retarget`: `retarget-orphan.mjs` (see
  // retargets), run only while `present`: `list` the candidates `--list` names, `prepare` and
  // `apply` its answers in turn (the last one repeats), `records` every record `--apply` read,
  // `beforeApply` runs before its answer (a hanging one is a crash during the write). `greptile`:
  // `greptile-retrigger.mjs`, present in the checkout while `present`, answering per repo (an
  // empty run by default); `outage` the outage issue's `follow` list and every `sync`'s results.
  const clock = { now: Date.now() };
  const scripts = {
    checkout: "/backstop" as string | null,
    judgment: GENUINE as Judgment | null,
    judgments: {} as Record<number, Judgment>,
    queueFailure: null as string | null,
    ready: { stacks: [] as unknown[], drops: [] as unknown[] },
    enqueue: [] as { code: number; answer: Record<string, unknown> }[],
    onEnqueue: async (_args: string[]) => {},
    answered: async () => {},
    beforeEnqueue: async () => {},
    files: {} as Record<string, string>,
    runs: [] as string[],
    get now(): number { return clock.now; },
    set now(at: number) { clock.now = at; },
    checkouts: [] as { repo: string; sources: string[] }[],
    retarget: { present: false, list: [] as unknown[], prepare: [] as { code: number; answer: Record<string, unknown> }[], apply: [] as { code: number; answer: Record<string, unknown> }[], records: [] as unknown[], beforePrepare: async () => {}, beforeApply: async () => {} },
    greptile: { present: true, answers: {} as Record<string, { code: number; answer: unknown }> },
    outage: { follow: new Map<string, number[]>(), syncs: [] as RetriggerResult[][] },
    // The backstop's own GitHub budget and what the reset probe finds (probeRates).
    budget: new GitHubBudget(() => clock.now),
    rates: [] as RateProbe[],
    probes: 0,
  };
  // `failure`: what linking a URL on the ticket throws; `arrive`: runs before a ticket comment
  // reaches Linear (a hanging one is a crash before it went out), `stall` after it did (a crash
  // right after); `lost`: the request fails although the comment reached Linear. `comments`:
  // each ticket's comments; `state`: the ticket's workflow state, `completedAt` its Linear
  // completion stamp (drives the stack policy's once-per-completion reopen), and `byIssue` the
  // states of tickets a run has several of (`state` is every other ticket's). `issueFailure` fails
  // the ticket reads (`issueReads`), `statesFailure` the per-poll batch of the running tickets
  // (`stateReads`).
  const linear = { failure: null as Error | null, issueFailure: null as Error | null, statesFailure: null as Error | null, attachments: [] as string[], issueReads: [] as string[], stateReads: [] as string[][], arrive: async () => {}, stall: async () => {}, lost: false, comments: {} as Record<string, string[]>, state: { status: "In Progress", statusType: "started" }, completedAt: null as string | null, byIssue: {} as Record<string, { status: string; statusType: string }> };
  // No test worktree exists unless its git source is explicitly provided.
  const git = { origin: null as string | null, root: null as string | null, reads: [] as string[][] };
  // Open before-merge manual tasks of the ticket; `unreadable`: reading them fails.
  const blockers: string[] = [];
  const gate = { unreadable: false };
  // `answer`: what Paseo finds before sending (only "sent" dispatches); `send`: the send itself,
  // after the dispatch was recorded; `session`: the agent's session lookup. `succeed`: what a
  // successor start for a gone agent comes to (impossible by default: the message goes to the
  // ticket as before); `claim` is the watch's claim, which a start runs right before it creates
  // the agent (see `started`). A start or a live agent moves the record to it, as
  // SessionRouter.succeed does. `idle`: what SessionRouter.whileIdle finds for the ticket (its
  // work runs only when `ran`).
  const paseo: { answer: (agentId?: string) => Promise<Outcome>; send: () => Promise<void>; session: () => Promise<unknown>; succeed: (claim: () => Promise<void>) => Promise<Succession>; idle: (issueId: string) => Promise<IdleRun<unknown>["outcome"]> } = {
    answer: async () => (agent.live ?? true) ? "sent" : "gone",
    send: async () => {},
    session: async () => ({ sessionId: "s" }),
    succeed: async () => ({ kind: "impossible", reason: "no branch is recorded for the ticket" }),
    idle: async () => "ran",
  };
  const calls: string[] = [];
  const daemon = agent.crash ? crashDaemon(calls) : null;
  // This host's Paseo server id, as the tickets' `Paseo agent` attachments name it (see ownership).
  const server = { id: "srv_test" };
  const directory = mkdtemp(join(tmpdir(), "paseo-pr-watch-"));
  t.after(async () => rm(await directory, { recursive: true, force: true }));
  const create = () => directory.then((home) => new PullRequestWatch({
    handover: { all: async () => records, update: async (issue, _agent, patch) => {
      if (!patch.link) { calls.push(`review ${patch.review}`); return null as never; }
      calls.push(`handover link ${patch.link[1]}`);
      const index = records.findIndex((record) => record.issueId === issue.id);
      records[index] = { ...records[index], links: { ...records[index].links, [patch.link[0]]: patch.link[1] } };
      return records[index];
    } },
    sessions: {
      sessionFor: () => paseo.session() as never,
      say: async (_id, kind, text) => { calls.push(`say ${kind} ${text.split("\n")[0]}`); },
      link: async (_id, label, url) => { calls.push(`session link ${label} ${url}`); },
      prompt: daemon ? (agentId, text, onDispatch, recovery) => daemon.router.prompt(agentId, text, onDispatch, recovery) : async (agentId, text, onDispatch) => {
        const outcome = await paseo.answer(agentId);
        if (outcome !== "sent") return outcome;
        await onDispatch?.();
        await paseo.send();
        calls.push(`prompt ${agentId}\n${text}`);
        return outcome;
      },
      crashed: async (agentId) => daemon ? daemon.router.crashed(agentId) : null,
      succeed: async (_issueId, _identifier, predecessor, lead, onDispatch) => {
        const next = await paseo.succeed(onDispatch);
        if (next.kind === "started") calls.push(`succeed ${predecessor}\n${lead}`);
        if (next.kind === "started" || next.kind === "live") records[0] = { ...records[0], agentId: next.agent.id, agentTitle: next.agent.title ?? "", status: "working" };
        return next;
      },
      whileIdle: async <T>(issueId: string, work: () => Promise<T>): Promise<IdleRun<T>> => {
        const outcome = await paseo.idle(issueId);
        calls.push(`idle ${issueId} ${outcome}`);
        return outcome === "ran" ? { outcome, value: await work() } : { outcome };
      },
    },
    linear: {
      moveToStateNamed: async (_id, name) => { calls.push(`move ${name}`); return { changed: true }; },
      // A Done ticket's reopen (see reopenDone): the fake moves the state like Linear does, so the
      // once-per-completion decision and the owner's re-close are exercised the way they run.
      reopenToCoding: async (id) => {
        const before = linear.byIssue[id] ?? linear.state;
        if (before.statusType !== "completed") return { changed: false };
        calls.push("reopen");
        const moved = { status: "In Progress", statusType: "started" };
        if (linear.byIssue[id]) linear.byIssue[id] = moved;
        else linear.state = moved;
        return { changed: true };
      },
      comment: async (id, body) => {
        await linear.arrive();
        linear.comments[id] = [...(linear.comments[id] ?? []), body];
        calls.push(`comment ${body}`);
        await linear.stall();
        if (linear.lost) throw new Error("socket hang up");
      },
      hasComment: async (id, text) => (linear.comments[id] ?? []).some((body) => body.includes(text)),
      viewerId: async () => "me",
      userUrl: async () => OWNER,
      linkUrl: async (_id, url, title) => {
        if (linear.failure) throw linear.failure;
        calls.push(`link ${title} ${url}`);
      },
      issueState: async (id) => {
        linear.issueReads.push(id);
        if (linear.issueFailure) throw linear.issueFailure;
        return { ...(linear.byIssue[id] ?? linear.state), attachmentUrls: linear.attachments } as never;
      },
      issueAttachments: async (id) => {
        linear.issueReads.push(id);
        if (linear.issueFailure) throw linear.issueFailure;
        return linear.attachments;
      },
      issueStatusAnyPool: async (id) => {
        linear.issueReads.push(id);
        if (linear.issueFailure) throw linear.issueFailure;
        return { ...(linear.byIssue[id] ?? linear.state), sentAt: Date.now() };
      },
      issueStatuses: async (ids) => {
        linear.stateReads.push(ids);
        if (linear.statesFailure) throw linear.statesFailure;
        return new Map(ids.map((id) => [id, { ...(linear.byIssue[id] ?? linear.state), completedAt: linear.completedAt }]));
      },
    },
    manualTasks: {
      openBlockers: async () => {
        if (gate.unreadable) throw new Error("Linear is unavailable");
        return blockers.map((identifier) => ({ identifier }) as never);
      },
      awaitingMerge: async () => false,
      merged: async (issueId) => { calls.push(`merged ${issueId}`); },
    },
    settings: { read: async () => ({ ...settings, dispatch: { ...settings.dispatch, enabled: agent.dispatch ?? false }, writeback: { ...settings.writeback, autoResume: agent.autoResume ?? settings.writeback.autoResume }, backstop: { run: agent.backstop ?? "always" } }) },
    owner: async (issueIds) => {
      if (agent.owner === "throws") throw new Error("Linear is unavailable");
      if (agent.owner === "unknown") return null;
      return agent.owner === "none" ? new Set<string>() : new Set(issueIds);
    },
    serverId: async () => server.id,
    outage: { follow: async () => scripts.outage.follow, sync: async (results) => { scripts.outage.syncs.push(results); } },
    ...(probe ? { probe } : {}),
    ...(agent.watchdog ? { watchdog: agent.watchdog } : {}),
    view: async (url) => {
      github.reads.push(url);
      if (github.throttled || github.throttle.includes(url)) throw new GitHubRateLimitedError("GitHub is throttling gh: HTTP 403: API rate limit exceeded");
      if (github.missing) throw new PullRequestNotFoundError("GraphQL: Could not resolve to a PullRequest with the number of 419. (repository.pullRequest)");
      if (github.broken.includes(url)) throw new Error("HTTP 502: Bad Gateway");
      return github.views[url] ?? github.view;
    },
    github: {
      drafts: async () => github.drafts,
      pullState: async (_repo, number) => {
        github.stateReads.push(number);
        if (github.unreadable.includes(number)) throw new Error("HTTP 502");
        return github.states[number] ?? github.drafts.find((item) => item.number === number)?.state.toLowerCase() ?? "closed";
      },
      landed: async (_repo, item) => github.landed.includes(item.number),
      reviewThreads: async () => { github.threadReads++; return github.threads; },
      openPullRequests: async (repo) => {
        github.listings.push(repo);
        if (github.listFailure) throw github.listFailure;
        const linked = records[0].links["Pull request"];
        return [...(github.view.state === "OPEN" && linked ? [listed(linked, github.view, github.title)] : []), ...github.open]
          .filter((pull) => pull.url.startsWith(`https://github.com/${repo}/pull/`));
      },
      branchExists: async (_repo, branch) => !github.deleted.includes(branch),
      pullComments: async (_repo, number) => github.comments[number] ?? [],
      commentOnPull: async (_repo, number, body) => {
        github.comments[number] = [...(github.comments[number] ?? []), body];
        calls.push(`pr comment #${number} ${body.split("\n")[0]}`);
        await github.stall();
      },
    },
    git: async (args) => {
      git.reads.push(args);
      if (!git.origin) throw new Error("not a git repository");
      if (args.includes("--show-toplevel")) return git.root ?? args[1];
      return git.origin;
    },
    backstop: {
      now: () => scripts.now,
      budget: scripts.budget,
      rates: async () => { scripts.probes++; return scripts.rates; },
      has: (_checkout, script) => (script === RETARGET_ORPHAN ? scripts.retarget.present : script === GREPTILE_RETRIGGER ? scripts.greptile.present : true),
      checkout: {
        prepare: async (repo, sources) => {
          scripts.checkouts.push({ repo, sources });
          return scripts.checkout;
        },
        commentFile: async (action, body) => {
          await scripts.beforeEnqueue();
          scripts.files[`/comments/${action}.md`] = body;
          return `/comments/${action}.md`;
        },
      },
      run: async (_cwd, script, args, env): Promise<ScriptOutput> => {
        scripts.runs.push(`${script} ${args.join(" ")}`);
        const answer = (code: number, value: unknown) => ({ code, stdout: `${JSON.stringify(value)}\n`, stderr: "" });
        if (script === GREPTILE_RETRIGGER) {
          const found = scripts.greptile.answers[env.GITHUB_REPOSITORY] ?? { code: 0, answer: { pulls: [], followed: [], triggered: [], errors: [] } };
          return answer(found.code, found.answer);
        }
        if (script === WAIT_QUEUE) {
          if (scripts.queueFailure) return { code: 1, stdout: "", stderr: scripts.queueFailure };
          if (!scripts.judgment && !scripts.judgments[Number(args[0])]) return answer(3, { pr: Number(args[0]), result: "none" });
          const draft = args[1] === "--draft" ? Number(args[2]) : null;
          return answer(2, { result: "dropped", reason: "", ...(scripts.judgments[Number(args[0])] ?? scripts.judgment), queueDraft: draft });
        }
        if (script === ENQUEUE_READY) return answer(0, scripts.ready);
        if (script === RETARGET_ORPHAN) {
          const { retarget } = scripts;
          const next = (list: { code: number; answer: Record<string, unknown> }[]) => (list.length > 1 ? list.shift() : list[0]) ?? { code: 1, answer: { result: "error", error: "no answer" } };
          if (args[0] === "--list") return answer(0, { result: "listed", candidates: retarget.list });
          if (args[0] === "--prepare") {
            calls.push(`retarget ${args.slice(0, 4).join(" ")}`);
            const found = next(retarget.prepare);
            await retarget.beforePrepare();
            return answer(found.code, found.answer);
          }
          assert.equal(args[0], "--apply");
          retarget.records.push(JSON.parse(await readFile(args[args.indexOf("--record") + 1], "utf8")));
          calls.push(`retarget --apply ${args[1]}`);
          const found = next(retarget.apply);
          await retarget.beforeApply();
          return answer(found.code, found.answer);
        }
        assert.equal(script, BACKSTOP_ENQUEUE);
        const option = (name: string) => args[args.indexOf(name) + 1] ?? "";
        calls.push(`enqueue ${args[0]} --expect ${option("--expect")} --action ${option("--action")}`);
        const next = (scripts.enqueue.length > 1 ? scripts.enqueue.shift() : scripts.enqueue[0]) ?? { code: 0, answer: { result: "enqueued", comment: "posted" } };
        if (next.answer.result === "enqueued") {
          // The enqueue, then the script's pull request comment on the top, with the marker.
          await scripts.onEnqueue(args);
          const top = Number(option("--expect").split(",").at(-1)?.split("@")[0]);
          const body = `${scripts.files[option("--comment-file")]}\n\n${marker(option("--action"))}`;
          if (next.answer.comment === "posted") {
            github.comments[top] = [...(github.comments[top] ?? []), body];
            calls.push(`pr comment #${top} ${body.split("\n")[0]}`);
          }
        }
        await scripts.answered();
        return answer(next.code, next.answer);
      },
    },
    // The waits the plugin recorded for the owner (writeback.ts, reconcileWaiting): every poll
    // checks them; `waitsFailing` makes that check fail.
    ownerWaits: { reconcileWaiting: async () => { waits.runs++; if (waits.failure) throw waits.failure; } },
  }, join(home, "pr-watch.json")));
  let watch = create();
  const poll = async () => {
    calls.length = 0;
    github.reads.length = 0;
    github.threadReads = 0;
    github.listings.length = 0;
    await (await watch).poll();
    return [...calls];
  };
  // One queue backstop run (every 10 minutes in the plugin).
  const backstop = async () => {
    calls.length = 0;
    scripts.runs.length = 0;
    github.listings.length = 0;
    scripts.checkouts.length = 0;
    await (await watch).backstop();
    return [...calls];
  };
  // A new plugin instance on the same state file.
  const restart = () => { watch = create(); return watch; };
  // The state an earlier plugin version left.
  const state = async (value: unknown) => writeFile(join(await directory, "pr-watch.json"), JSON.stringify(value));
  // The crash recovery state file, read or written as is.
  const crashFile = async (value?: string) => {
    const path = join(await directory, "crash-recovery.json");
    if (value === undefined) return readFile(path, "utf8");
    await writeFile(path, value);
    return value;
  };
  // The stack policy's state file (caps and reopens), read as is (empty before the first write).
  const policyFile = async () => readFile(join(await directory, "stack-policy.json"), "utf8").catch(() => "");
  return { github, git, linear, paseo, daemon: daemon!, records, blockers, gate, calls, scripts, poll, backstop, restart, state, crashFile, policyFile, waits, server, home: () => directory, watch: () => watch };
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
  h.scripts.judgment = { ...GENUINE, failures: [{ check: "Code validation / Core (core-web)", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/1/job/2", conclusion: "failure" }] };
  const calls = await h.poll();
  assert.equal(calls.length, 2);
  const [prompt, said] = calls;
  assert.match(prompt, /^prompt a1\n/);
  assert.match(prompt, /Reason: The merge queue closed its draft pull request #437 without landing it\./);
  assert.match(prompt, /- \[Code validation \/ Core \(core-web\)\]\(https:\/\/github\.com\/tuchel-sohn\/tuchel-platform\/actions\/runs\/1\/job\/2\) — failure/);
  assert.match(prompt, /worktree \(`\/wt\/tuc-1`\), on the top branch of the stack, run `git fetch origin main && git rebase --update-refs --onto origin\/main "\$\(git merge-base HEAD origin\/main\)"`/);
  assert.match(prompt, /`gt submit --stack --ignore-out-of-sync-trunk`, then `git switch mtuchel\/tuc-1-fix && node tools\/ci\/enqueue\.mjs` \(the top branch of the dropped queue range, not the stack's top branch; never a bare `gt merge`[^\n]*\) and `node tools\/ci\/wait-queue\.mjs 419`/);
  assert.doesNotMatch(prompt, /run `gt sync/);
  assert.match(prompt, /If your stack sits on a PR that has already landed, or your PR was auto-closed, follow docs\/automation\/merge-queue\.md instead\.\n2\. Fix the cause\./);
  assert.match(prompt, /one plain `git switch mtuchel\/tuc-1-fix && node tools\/ci\/enqueue\.mjs` retry/);
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
  const events = [QUEUED, REMOVED];
  for (let drop = 1; drop <= 2; drop++) {
    h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
    const calls = await h.poll();
    assert.ok(!calls.some((call) => call.startsWith("prompt")), "an archived agent is never prompted");
    const comment = calls.find((call) => call.startsWith("comment")) ?? "";
    assert.match(comment, /no longer running/);
    assert.ok(!/take over|took over/.test(comment), `${drop}: an archived agent's drop never hands the ticket to the owner`);
    events.push(QUEUED, REMOVED);
  }
  // An escalation of the pull request — here the owner's answer was waited out — still ends the
  // watch: no further reads.
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, escalated: true } });
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

test("a link to a pull request GitHub does not have is read once, logged, and never read again, even after a restart or once the number exists", async (t) => {
  const h = harness(t);
  const log = t.mock.method(console, "error", () => {});
  h.github.missing = true;
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual(h.github.reads, [PR]);
  assert.equal(log.mock.callCount(), 1);
  assert.match(String(log.mock.calls[0].arguments[0]), /TUC-1: .*pull\/419 does not exist .*no longer watched/);
  // Someone later opens an unrelated pull request that takes the number.
  h.github.missing = false;
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, CONFLICT) };
  await h.restart();
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual(h.github.reads, []);
  assert.equal(log.mock.callCount(), 1);
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
  const prompt = promptOf(calls) ?? "";
  assert.ok(prompt.startsWith(`[The pull request](${PR}) is still a draft, with no new commit or pull request activity for 30 minutes.\nNext step: `), prompt);
  assert.ok(prompt.endsWith(`\n\n${NUDGE_CLOSE}`), prompt);
  assert.doesNotMatch(prompt, /owner takes over|takes over/, "no nudge hands the step to the owner");
  const order = ["- CI is the proof: <killed | timed out | failed twice on unrelated tests> — <evidence>", "none of the ticket's questions to the owner is still unanswered", "node tools/ci/publish.mjs --ci-proof"].map((part) => prompt.indexOf(part));
  assert.ok(order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1])), `evidence line, then the owner-question check, then --ci-proof: ${order}`);
  assert.ok(!prompt.includes("gt submit --publish") && !prompt.includes("gh pr ready"), "publish.mjs is the only publish route");
  assert.equal(calls.at(-1), "say thought The pull request is waiting for the agent to publish the draft; it was asked to.");
  assert.equal(h.github.threadReads, 0, "a draft needs no review threads");
  assert.deepEqual(await h.poll(), [], "claimed for this head");
});

test("failed checks on a ready pull request are listed with links, ignoring pending runs and Graphite's mergeability check", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, checks: [GREEN, RUNNING_CI, failing("Graphite / mergeability_check")] };
  assert.deepEqual(await h.poll(), [], "only the queue's own check failed");
  h.github.view = { ...READY, checks: [GREEN, RUNNING_CI, failing("Graphite / mergeability_check"), failing("Code validation / Platform gate")] };
  assert.equal(promptOf(await h.poll()), `Checks failed on the head of [the pull request](${PR}) (\`a1b2c3d\`):\n- [Code validation / Platform gate](https://github.com/tuchel-sohn/tuchel-platform/actions/runs/2/job/31) — failure\nNext step: fix them, then \`gt submit --stack\`.\n\n${NUDGE_CLOSE}`);
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
  assert.equal(promptOf(calls), `@Mtuchel requested changes on [the pull request](${PR}):\n> Two things before this can land.\n\nUnresolved review threads:\n- [db/migrate.sql](${PR}#discussion_r2) @Mtuchel: Split this migration. (1 reply)\n\nNext step: address them, then \`gt submit --stack\`.\n\n${NUDGE_CLOSE}`, "ada approved since, bob's review was dismissed");
  assert.equal(calls.at(-1), "say thought The pull request is waiting for the agent to address the requested changes; it was asked to.");
  h.github.threads = [];
  assert.deepEqual(await h.poll(), [], "sent once");
});

test("a change request is sent once however many heads follow it; a new request on a later head is sent again", async (t) => {
  const h = harness(t);
  const mtuchel = { author: "Mtuchel", state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T08:00:00Z", body: "Two things before this can land.", commit: HEAD };
  h.github.view = { ...READY, reviews: [mtuchel] };
  assert.match(promptOf(await h.poll()) ?? "", new RegExp(`^@Mtuchel requested changes[^]*never just wait\\.$`));
  for (const head of ["h2", "h3", "h4"]) {
    h.github.view = { ...h.github.view, headSha: head };
    assert.deepEqual(await h.poll(), [], `pushed ${head} without a new review: no prompt, no escalation`);
  }
  h.github.view = { ...h.github.view, reviews: [mtuchel, { author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T09:00:00Z", body: "Nit.", commit: "h4" }] };
  const later = promptOf(await h.poll()) ?? "";
  assert.match(later, /^@Mtuchel requested changes on \[the pull request\]\([^)]*\) at `a1b2c3d`, before the latest commits:\n> Two things before this can land\.\n@ada requested changes on \[the pull request\]\([^)]*\):\n> Nit\.\n/);
  assert.match(later, /Where the new commits already address a review, reply on its threads and re-request a review from @Mtuchel\./);
  assert.doesNotMatch(later, /keeps stalling/, "the second nudge of the stage is an ordinary one");
  assert.ok(later.endsWith(`\n\n${NUDGE_CLOSE}`), later);
  h.github.view = { ...h.github.view, headSha: "h5", reviews: [...h.github.view.reviews, { ...mtuchel, submittedAt: "2026-09-29T10:00:00Z", commit: "h5" }] };
  const third = promptOf(await h.poll()) ?? "";
  assert.match(third, /^@Mtuchel requested changes/);
  assert.match(third, /keeps stalling at this step \(nudge 3\); change your approach\./, "the third nudge asks for a new approach instead of mentioning the owner");
  assert.ok(third.endsWith(`\n\n${NUDGE_CLOSE}`), third);
});

test("GitHub's changes-requested decision alone is a change request, sent once, and holds the merge", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, reviewDecision: "CHANGES_REQUESTED" };
  assert.equal(promptOf(await h.poll()), `GitHub reports changes requested on [the pull request](${PR}).\n\nNext step: address them, then \`gt submit --stack\`.\n\n${NUDGE_CLOSE}`);
  h.github.view = { ...h.github.view, headSha: "h2" };
  assert.deepEqual(await h.poll(), [], "once per pull request, not per head");
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
  assert.equal(promptOf(await h.poll()), `Reviewers left unresolved findings on [the pull request](${PR}):\n- [server/upload.ts:42](${PR}#discussion_r1) @greptile-apps: P2 The retry loop never gives up.\n\nNext step: run the AGENTS.md review loop on them.\n\n${NUDGE_CLOSE}`);
});

test("a ready, green, reviewed pull request outside the queue gets no merge nudge: the queue backstop enqueues it", async (t) => {
  const h = harness(t);
  for (const view of [READY, { ...READY, labels: ["complex-review"] }, { ...READY, checks: [...READY.checks, { ...RUNNING_CI, name: "Graphite / mergeability_check" }] }]) {
    h.github.view = view;
    assert.deepEqual(await h.poll(), [], JSON.stringify(view.labels));
  }
  h.github.view = { ...READY, reviewDecision: "CHANGES_REQUESTED" };
  assert.match(promptOf(await h.poll()) ?? "", /^GitHub reports changes requested/, "other stages still nudge");
});

test("the first matching stage wins: draft, then failed checks, then requested changes, then findings; a ready pull request gets none", async (t) => {
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
  assert.deepEqual(await h.poll(), [], "ready: the queue backstop enqueues it, no merge nudge");
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
  assert.ok((promptOf(await h.poll()) ?? "").endsWith(`\n\n${NUDGE_CLOSE}`), "the veto and the task claimed nothing");
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
  assert.ok((promptOf(await h.poll()) ?? "").endsWith(`\n\n${NUDGE_CLOSE}`), "still the first nudge");

  const gone = harness(t, { live: false });
  gone.github.view = { ...READY, checks: [failing("PR code")] };
  const calls = await gone.poll();
  assert.equal(calls[0], "move In Progress");
  assert.match(calls[1], new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running, so the ticket is back in In Progress for the next one\\.\n\nChecks failed on the head`));
  assert.ok(calls[1].endsWith(`\n\n${NUDGE_CLOSE}`), "the hand-back carries the nudge's prompt");
  assert.equal(calls[2], "say response The pull request is waiting for the agent to fix the failing checks, and the agent is no longer running; the ticket is back in In Progress.");
  assert.equal(calls.length, 3);
  assert.deepEqual(await gone.poll(), []);
});

test("every new stall of a stage is nudged, no count ever hands it to the owner, and every third nudge asks for a new approach", async (t) => {
  const h = harness(t, { live: false });
  const red = (head: string) => ({ ...READY, headSha: head, checks: [failing("PR code")] });
  h.github.view = red("h1");
  const handedBack = await h.poll();
  assert.ok(handedBack[1].endsWith(`\n\n${NUDGE_CLOSE}`), "a gone agent's hand-back counts as a nudge and carries the prompt");
  assert.deepEqual(await h.poll(), [], "same head");
  h.paseo.answer = async () => "sent";
  for (const head of ["h2", "h3", "h4", "h5", "h6"]) {
    h.github.view = red(head);
    const calls = await h.poll();
    const prompt = promptOf(calls) ?? "";
    assert.match(prompt, /^Checks failed on the head/, head);
    assert.ok(prompt.endsWith(`\n\n${NUDGE_CLOSE}`), head);
    // h1 was nudge 1, so head hN is the stage's nudge N: the third and sixth ask for a new approach.
    const count = Number(head.slice(1));
    if (count % 3 === 0) assert.match(prompt, new RegExp(`keeps stalling at this step \\(nudge ${count}\\); change your approach`), head);
    else assert.doesNotMatch(prompt, /keeps stalling/, head);
    assert.ok(!calls.some((call) => call.startsWith("comment")), `${head}: no count mentions the owner`);
  }
  // A stage of its own starts from its own count, not from the checks stage's.
  h.github.view = { ...READY, headSha: "h6" };
  h.github.threads = [FINDING];
  const findings = promptOf(await h.poll()) ?? "";
  assert.match(findings, /unresolved findings[^]*never just wait\.$/, "the findings stage nudges with the owner policy");
  assert.doesNotMatch(findings, /keeps stalling/, "and without the approach line");
});

test("a stage escalated under the old cap resumes nudging on its next new stall; nothing mentions the owner for it", async (t) => {
  const h = harness(t);
  h.paseo.answer = async () => "sent";
  // The old plugin escalated the stage at its two nudges; its flag stays in the entry (state
  // cannot tell it from a waited-out question), but no count stops the nudges anymore.
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, escalated: true, nudges: { red: ["h1", "h1", "h1"] } } });
  h.github.view = { ...READY, headSha: "h2", checks: [failing("PR code")] };
  const calls = await h.poll();
  assert.ok((promptOf(calls) ?? "").endsWith(`\n\n${NUDGE_CLOSE}`), "the stage is nudged again");
  assert.ok(!calls.some((call) => call.startsWith("comment")), "and no count mentions the owner");
});

test("a conflict-only drop, before any queue draft or with nothing failed on it, asks for a restack and an immediate re-enqueue", async (t) => {
  const before = harness(t);
  before.github.view = { ...before.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  before.scripts.judgment = CONFLICT_ONLY;
  const prompt = promptOf(await before.poll()) ?? "";
  assert.match(prompt, /Conflict only: .*\(docs\/automation\/merge-queue\.md#conflict-only-drops\)/);
  assert.match(prompt, /`git fetch origin main && git rebase --update-refs --onto origin\/main "\$\(git merge-base HEAD origin\/main\)"`/);
  assert.match(prompt, /regenerate them; never merge them by hand\. Run the focused checks/);
  assert.match(prompt, /then right away `git switch mtuchel\/tuc-1-fix && node tools\/ci\/enqueue\.mjs` \(the top branch of the dropped queue range, not the stack's top branch; never a bare `gt merge`[^\n]*\) and `node tools\/ci\/wait-queue\.mjs 419`\. Do not wait for the pull request's checks[^\n]*wait with `node tools\/ci\/wait-checks\.mjs 419` and run `node tools\/ci\/enqueue\.mjs` once more\./);
  assert.doesNotMatch(prompt, /Fix the cause/);
  assert.match(prompt, /This is conflict-only drop 1 of this range; every one gets this restack request\./);

  const green = harness(t);
  green.github.view = { ...green.github.view, mergeActivity: activity(QUEUED, running(437), CONFLICT) };
  green.github.drafts = [draft(437, [419])];
  green.scripts.judgment = CONFLICT_ONLY;
  const restack = promptOf(await green.poll()) ?? "";
  assert.match(restack, /No check failed on the queue's draft \[#437\]/);
  assert.match(restack, /This is conflict-only drop 1 of this range/);
});

test("a drop re-enqueues the dropped queue range from its top branch, never from the stack's top above it", async (t) => {
  const pull = (number: number) => `https://github.com/tuchel-sohn/tuchel-platform/pull/${number}`;
  // 419 (recorded) <- 1501 <- 1502 (the stack's top); the queue's draft tested 419 and 1501 with
  // TUC-10's 1600.
  const step2 = { ...OPEN_PR, headSha: "s2", headBranch: "mtuchel/tuc-1-b", baseBranch: "mtuchel/tuc-1-fix" };
  const step3 = { ...OPEN_PR, headSha: "s3", headBranch: "mtuchel/tuc-1-c", baseBranch: "mtuchel/tuc-1-b" };
  const other = { ...OPEN_PR, headSha: "o1", headBranch: "mtuchel/tuc-10-x", baseBranch: "main" };
  const stack = [listed(pull(1501), step2, "Add TUC-1 [plugin] Step two"), listed(pull(1502), step3, "Add TUC-1 [plugin] Step three"), listed(pull(1600), other, "Add TUC-10 [plugin] Something else")];
  for (const outcome of [CONFLICT, REMOVED]) {
    const h = harness(t);
    h.github.view = { ...OPEN_PR, mergeActivity: activity(QUEUED, running(437), outcome) };
    h.github.drafts = [draft(437, [419, 1501, 1600])];
    h.github.open = stack;
    h.scripts.judgment = outcome === CONFLICT ? CONFLICT_ONLY : GENUINE;
    const prompt = promptOf(await h.poll()) ?? "";
    assert.match(prompt, outcome === CONFLICT ? /Conflict only/ : /Fix the cause/);
    assert.match(prompt, /`git switch mtuchel\/tuc-1-b && node tools\/ci\/enqueue\.mjs` \(the top branch of the dropped queue range, not the stack's top branch;[^\n]*\) and `node tools\/ci\/wait-queue\.mjs 1501`/, outcome);
    assert.doesNotMatch(prompt, /tuc-1-c|1502|tuc-10-x|wait-queue\.mjs 1600/, outcome);

    // Without a draft listing the range, the dropped pull request is its top.
    const bare = harness(t);
    bare.github.view = { ...OPEN_PR, mergeActivity: activity(QUEUED, outcome) };
    bare.github.open = stack;
    bare.scripts.judgment = outcome === CONFLICT ? CONFLICT_ONLY : GENUINE;
    const own = promptOf(await bare.poll()) ?? "";
    assert.match(own, /`git switch mtuchel\/tuc-1-fix && node tools\/ci\/enqueue\.mjs` [^\n]* and `node tools\/ci\/wait-queue\.mjs 419`/, outcome);
    assert.doesNotMatch(own, /tuc-1-c|1502/, outcome);
  }
});

test("the repo's wait-queue.mjs decides the kind of a drop, for the round's draft or, without one, the last round", async (t) => {
  for (const [judgment, events, args] of [
    [GENUINE, [QUEUED, running(437), CONFLICT], "419 --draft 437"],
    [GENUINE, [QUEUED, CONFLICT], "419 --last"],
    [CONFLICT_ONLY, [QUEUED, running(437), REMOVED], "419 --draft 437"],
  ] as const) {
    const h = harness(t);
    h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
    h.github.drafts = [draft(437, [419])];
    h.scripts.judgment = judgment;
    const prompt = promptOf(await h.poll()) ?? "";
    assert.deepEqual(h.scripts.runs, [`${WAIT_QUEUE} ${args}`]);
    if (judgment === GENUINE) {
      assert.match(prompt, /2\. Fix the cause\./, "Graphite naming a conflict does not make it conflict-only");
      assert.match(prompt, /This is genuine drop 1 of this range; every genuine drop gets this fix request\./);
      assert.doesNotMatch(prompt, /Conflict only/);
    } else assert.match(prompt, /Conflict only[^]*This is conflict-only drop 1 of this range/);
  }
});

test("no count of conflict-only or plain drops escalates a range: the restacks and fix requests keep coming, and only every fifth consecutive conflict asks for the hotspot (AC-1, AC-3)", async (t) => {
  const h = harness(t);
  t.mock.method(console, "error", () => {});
  const calls: string[] = [];
  const events: string[] = [];
  const drop = (...more: string[]) => {
    events.push(...more);
    h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
    h.scripts.judgment = more.at(-1) === CONFLICT ? CONFLICT_ONLY : GENUINE;
    return h.poll();
  };
  // Six conflict-only drops in a row: every one asks for a restack, and only the fifth (the fifth
  // consecutive one) also asks for the hotspot. Nothing reaches the owner, nothing stops.
  for (let restack = 1; restack <= 6; restack++) {
    const prompt = promptOf(await drop(QUEUED, CONFLICT)) ?? "";
    calls.push(prompt);
    assert.match(prompt, new RegExp(`This is conflict-only drop ${restack} of this range; every one gets this restack request\\.`));
    if (restack === 5) assert.match(prompt, /5 conflict-only drops of this range in a row: besides the restack, find out why it keeps conflicting and fix that cause/);
    else assert.doesNotMatch(prompt, /in a row: besides the restack/, `restack ${restack}`);
    assert.match(prompt, /Ask the owner only for a decision that can break something[^]*never because of a drop count\./);
  }
  // A plain drop resets the streak and gets its own fix request; the next conflict starts a new one.
  h.github.drafts = [draft(440, [419])];
  const plain = promptOf(await drop(QUEUED, running(440), REMOVED)) ?? "";
  calls.push(plain);
  assert.match(plain, /This is genuine drop 1 of this range; every genuine drop gets this fix request\./);
  h.github.drafts = [draft(441, [419])];
  const after = promptOf(await drop(QUEUED, running(441), REMOVED)) ?? "";
  calls.push(after);
  assert.match(after, /This is genuine drop 2 of this range/);
  h.github.drafts = [draft(442, [419])];
  const restarted = promptOf(await drop(QUEUED, CONFLICT)) ?? "";
  calls.push(restarted);
  assert.match(restarted, /This is conflict-only drop 7 of this range/);
  assert.doesNotMatch(restarted, /in a row: besides the restack/, "the plain drops reset the conflict streak");
  assert.ok(!calls.some((call) => /Please take over|owner was asked/.test(call)), "no drop ever hands the stack to the owner");
  assert.ok(!(await h.poll()).some((call) => /^comment /.test(call)), "nor on a later poll");
});

test("a main-broken drop the backstop cannot re-enqueue counts toward nothing and asks to re-enqueue with --wait-main once main is green", async (t) => {
  const h = harness(t);
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437)) };
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = MAIN_BROKEN;
  const prompt = promptOf(await h.poll()) ?? "";
  assert.match(prompt, /- \[Code validation \/ Migration replay\]\(https:\/\/github\.com\/[^)]+\) — failure/);
  assert.match(prompt, /Kind \(tools\/ci\/wait-queue\.mjs\): main-broken[^\n]*\n- Migration replay was red on main at 07:30/);
  assert.match(prompt, /Paseo did not re-enqueue it: it could not prove that the range is still the code that dropped \(no queue draft\)/);
  assert.match(prompt, /Main broken: the merge queue dropped the range because `main` was already red on the same jobs at that time \(tools\/ci\/wait-queue\.mjs\)\. No restack or fix of your own is needed unless `enqueue\.mjs` refuses the range\./);
  assert.match(prompt, /Re-enqueue the dropped queue range from its top branch once `main` is green: `git switch mtuchel\/tuc-1-fix && node tools\/ci\/enqueue\.mjs --wait-main` \(it waits until `main` is green, then checks and enqueues\), then `node tools\/ci\/wait-queue\.mjs 419`\./);
  assert.match(prompt, /Drops of this range so far: 0 plain, 0 conflict-only, 1 main-broken\./);
  assert.match(prompt, /Ask the owner only for a decision that can break something[^]*never because of a drop count\./);
  assert.doesNotMatch(prompt, /Fix the cause|git rebase|Please take over/);
  assert.deepEqual(await h.poll(), [], "not claimed again on the next poll");
  await h.restart();
  assert.deepEqual(await h.poll(), [], "nor after a restart");

  // With the agent gone, the same request goes to the ticket.
  const gone = harness(t, { live: false });
  gone.github.view = { ...gone.github.view, mergeActivity: activity(QUEUED, running(437)) };
  gone.github.drafts = [draft(437, [419])];
  gone.scripts.judgment = MAIN_BROKEN;
  const calls = await gone.poll();
  assert.equal(calls[0], "move In Progress");
  assert.match(calls[1], new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running[^]*enqueue\\.mjs --wait-main`));
});

test("three main-broken drops leave the plain drops alone: the next genuine failure gets its fix request", async (t) => {
  const h = harness(t);
  const events: string[] = [];
  const drop = (number: number) => {
    events.push(QUEUED, running(number));
    h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
    h.github.drafts = [draft(number, [419])];
    return h.poll();
  };
  h.scripts.judgment = MAIN_BROKEN;
  for (const [index, number] of [440, 441, 442].entries()) assert.match(promptOf(await drop(number)) ?? "", new RegExp(`Drops of this range so far: 0 plain, 0 conflict-only, ${index + 1} main-broken\\.`));
  h.scripts.judgment = GENUINE;
  const genuine = promptOf(await drop(443)) ?? "";
  assert.match(genuine, /2\. Fix the cause\./);
  assert.match(genuine, /This is genuine drop 1 of this range; every genuine drop gets this fix request\./);
  assert.doesNotMatch(genuine, /Main broken/);
});

test("a genuine drop's fix request carries the range's drop history, and a repeated failing signature also asks for the reproduction on main and the queue incident (AC-4)", async (t) => {
  const h = harness(t);
  t.mock.method(console, "error", () => {});
  const failures = [{ check: "Code validation / Core (core-web) (2/4)", conclusion: "failure", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/9/job/2", tests: ["core > uploads a file: timed out"], testIds: ["core > uploads a file"] }];
  const events: string[] = [];
  const round = async (number: number) => {
    events.push(QUEUED, running(number), REMOVED);
    h.github.view = { ...h.github.view, mergeActivity: activity(...events) };
    h.github.drafts = [...h.github.drafts, draft(number, [419])];
    h.scripts.judgment = { ...GENUINE, failures };
    return promptOf(await h.poll()) ?? "";
  };
  // The first genuine drop has no history yet: the request names the failing check and test.
  const first = await round(437);
  assert.doesNotMatch(first, /The range's drops \(newest last/, "the first drop's own entry is not yet history");
  assert.doesNotMatch(first, /The failing signature repeats/);
  // The second drop repeats the first's signature: its request adds the history, the reproduction
  // on current `origin/main` and the queue incident.
  const second = await round(438);
  assert.match(second, /- \d{4}-\d{2}-\d{2}T[0-9:.]+Z — genuine failure \(#437\) — failed checks: Code validation \/ Core \(core-web\) — failing tests: core > uploads a file: timed out/);
  assert.match(second, /The failing signature repeats the range's genuine drop #437 of \d{4}-\d{2}-\d{2}T[0-9:.]+Z: Code validation \/ Core \(core-web\) — core > uploads a file: timed out\./);
  assert.match(second, /Before you enqueue the range again, reproduce it on the range merged onto current `origin\/main`: in the stack's worktree `git fetch origin main`, then from the range's top branch `git switch -c queue-repro mtuchel\/tuc-1-fix && git merge --no-edit origin\/main`, and run the failing tests above there/);
  assert.match(second, /attach that evidence to its queue incident — the `TUC-538` queue-blocker ticket whose `Queue blocker id` is `core > uploads a file` — opening one if none exists/);
  assert.match(second, /This is genuine drop 2 of this range; every genuine drop gets this fix request\./);
  assert.match(second, /Ask the owner only for a decision that can break something[^]*never because of a drop count\./);
});

test("a wait-queue.mjs run that fails, or a round it does not call dropped yet, claims nothing; a later poll claims the drop", async (t) => {
  const h = harness(t);
  const log = t.mock.method(console, "error", () => {});
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437)) };
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = MAIN_BROKEN;
  h.scripts.queueFailure = "gh: HTTP 502";
  assert.deepEqual(await h.poll(), []);
  assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /reading .*pull\/419 failed: tools\/ci\/wait-queue\.mjs printed no JSON answer \(exit 1\): gh: HTTP 502/);
  h.scripts.queueFailure = null;
  h.scripts.judgment = null;
  assert.deepEqual(await h.poll(), [], "still running as far as the repo can tell");
  h.scripts.judgment = MAIN_BROKEN;
  assert.match(promptOf(await h.poll()) ?? "", /Main broken[^]*Drops of this range so far: 0 plain, 0 conflict-only, 1 main-broken\./);
});

test("the cutover un-escalates a range the old drop limits handed to the owner and gives its newest drop back once (AC-6)", async (t) => {
  const h = harness(t);
  t.mock.method(console, "error", () => {});
  // State the old plugin left: escalated at the second plain drop, its escalation to the owner
  // still unsent.
  await h.state({ [PR]: {
    reviewedAt: null, decision: null, merged: false, drops: ["#436", "#437"], escalated: true,
    pending: { key: "#437", reason: "a check failed", facts: "the old escalation to the owner", fix: null },
    activeAt: new Date().toISOString(),
  } });
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437)) };
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = { ...GENUINE, failures: [{ check: "Code validation / Core (core-web)", conclusion: "failure", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/9/job/2", tests: ["core > uploads a file: timed out"], testIds: ["core > uploads a file"] }] };
  const calls = await h.poll();
  assert.deepEqual(h.scripts.runs, [`${WAIT_QUEUE} 419 --draft 437`], "the newest drop is judged and claimed again");
  const prompt = promptOf(calls) ?? "";
  assert.match(prompt, /This is genuine drop 2 of this range; every genuine drop gets this fix request\./, "the agent gets the fix request the escalation had withheld");
  assert.ok(!calls.some((call) => /take over|took over/.test(call)), "the unsent escalation to the owner never goes out");
  const state = JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8"));
  assert.equal(state[PR].escalated, undefined, "un-escalated");
  assert.equal(state[PR].cutover, true, "marked, so a later load never hands the same drop back");
  assert.equal(state[PR].pending, null, "the owner message is gone");
  assert.deepEqual(await h.poll(), [], "never handed back twice");
  // A drop after the cutover is an ordinary drop.
  h.github.drafts = [draft(438, [419])];
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(437), REMOVED, QUEUED, running(438)) };
  assert.match(promptOf(await h.poll()) ?? "", /This is genuine drop 3 of this range/);
});

test("a stage or permission escalation stays as it is: the cutover reads no drop-count handover into it (AC-6)", async (t) => {
  const h = harness(t);
  const log = t.mock.method(console, "error", () => {});
  // Two plain drops, but the escalation a stage's own (its nudges went past their budget).
  await h.state({ [PR]: {
    reviewedAt: null, decision: null, merged: false, drops: ["#436", "#437"], escalated: true,
    nudges: { checks: ["h1", "h1", "h1"] }, activeAt: new Date().toISOString(),
  } });
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, running(438)) };
  h.github.drafts = [draft(438, [419])];
  h.scripts.judgment = GENUINE;
  assert.deepEqual(await h.poll(), [], "held: the drop only reaches the log");
  assert.deepEqual(h.scripts.runs, [], "and wait-queue.mjs is not run for it");
  assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /dropped .*pull\/419 again; already escalated to the owner/);
  const state = JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8"));
  assert.equal(state[PR].escalated, true, "the stage escalation stays");
  assert.equal(state[PR].cutover, undefined, "no cutover mark on it");

  // A message of a pull request whose agent waited out the owner's answer (the surviving
  // escalation) stays, too: no count evidence is read into it.
  const waited = harness(t);
  await waited.state({ [PR]: { reviewedAt: null, decision: null, merged: false, drops: ["#437"], escalated: true, activeAt: new Date().toISOString() } });
  waited.github.view = { ...waited.github.view, mergeActivity: activity(QUEUED, running(438)) };
  waited.github.drafts = [draft(438, [419])];
  assert.deepEqual(await waited.poll(), [], "held");
  const kept = JSON.parse(await readFile(join(await waited.home(), "pr-watch.json"), "utf8"));
  assert.equal(kept[PR].escalated, true, "the wait escalation stays");
  assert.equal(kept[PR].cutover, undefined);
});

test("drops claimed before drops had kinds count as plain ones and escalate nothing (AC-1, AC-6)", async (t) => {
  const conflict = { ...OPEN_PR, mergeActivity: activity(QUEUED, CONFLICT) };
  // One old plain drop, then a plain drop: the removed 2nd-drop limit handed the range to the
  // owner; now the agent gets the fix request.
  const two = harness(t);
  await two.state({ [PR]: { reviewedAt: null, decision: null, merged: false, drops: ["#436"], activeAt: new Date().toISOString() } });
  two.github.view = { ...two.github.view, mergeActivity: activity(QUEUED, REMOVED, QUEUED, REMOVED) };
  const prompt = promptOf(await two.poll()) ?? "";
  assert.match(prompt, /This is genuine drop 2 of this range; every genuine drop gets this fix request\./);
  assert.match(prompt, /Drops of this range so far: 2 plain, 0 conflict-only, 0 main-broken\./);
  assert.doesNotMatch(prompt, /take over|next plain drop goes to the owner/);

  // Two old plain drops, then a conflict-only drop: restacked, not escalated.
  const restacked = harness(t);
  await restacked.state({ [PR]: { reviewedAt: null, decision: null, merged: false, drops: ["#437", "#438"] } });
  restacked.github.view = conflict;
  restacked.scripts.judgment = CONFLICT_ONLY;
  assert.match(promptOf(await restacked.poll()) ?? "", /This is conflict-only drop 1 of this range/);

  // Three old plain drops: the removed legacy third-drop rule escalated them; nothing does now.
  const legacy = harness(t);
  await legacy.state({ [PR]: { reviewedAt: null, decision: null, merged: false, drops: ["#437", "#438", "#439"] } });
  legacy.github.view = conflict;
  legacy.scripts.judgment = CONFLICT_ONLY;
  assert.match(promptOf(await legacy.poll()) ?? "", /This is conflict-only drop 1 of this range/, "the third drop escalates nothing");
});

const PARENT = "mtuchel/tuc-0-parent";
const NEXT = "https://github.com/tuchel-sohn/tuchel-platform/pull/1500";

// The commands of a replay message: its one ```sh block.
function blockOf(text: string): string {
  const block = /```sh\n([^]*?)\n```/.exec(text);
  assert.ok(block, `no sh block in:\n${text}`);
  return block[1];
}

// A throwaway agent clone for a replay message's sh block (AC-12, AC-13): on a bare origin, `main`,
// the parent branch `base` (one commit), the stack `mtuchel/tuc-1-fix` <- `mtuchel/tuc-1-top` on
// it (one commit each), then the parent landed on `main` as a squash. `deleted`: Graphite deleted
// `base` on origin and the clone still has it locally (the closed pull request's case); else `base`
// stays on origin as a leftover and the clone never had it (the orphaned `graphite-base/<n>`
// case). The clone stands on the top branch. Stub `gh` and `gt` on PATH record their arguments.
async function replayRepo(t: TestContext, options: { base: string; deleted: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "paseo-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", PATH: `${join(root, "bin")}:${process.env.PATH}` };
  const sh = (cwd: string, script: string) => execFileSync("bash", ["-ec", script], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const [fix, top] = ["mtuchel/tuc-1-fix", "mtuchel/tuc-1-top"];
  await mkdir(join(root, "bin"));
  for (const tool of ["gh", "gt"]) {
    await writeFile(join(root, "bin", tool), `#!/bin/sh\necho "$*" >> "${join(root, `${tool}.log`)}"\n`);
    await chmod(join(root, "bin", tool), 0o755);
  }
  sh(root, `git init -q --bare -b main origin.git && git clone -q origin.git seed 2>/dev/null && cd seed
    echo base > base.txt && git add . && git commit -qm Base && git push -q origin main
    git switch -qc '${options.base}' && echo parent > parent.txt && git add . && git commit -qm Parent && git push -q origin '${options.base}'
    git switch -qc '${fix}' && echo fix > fix.txt && git add . && git commit -qm 'Fix the upload' && git push -q origin '${fix}'
    git switch -qc '${top}' && echo top > top.txt && git add . && git commit -qm Top && git push -q origin '${top}'
    cd .. && git clone -q origin.git work && cd work
    ${options.deleted ? `git branch -q '${options.base}' 'origin/${options.base}'` : ""}
    git branch -q '${fix}' 'origin/${fix}' && git switch -q '${top}'
    cd ../seed && git switch -q main && git merge -q --squash '${options.base}' && git commit -qm 'Parent (#418)' && git push -q origin main
    ${options.deleted ? `git push -q origin --delete '${options.base}'` : ""}`);
  const work = join(root, "work");
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  return {
    run: (script: string) => sh(work, script),
    gh: () => read("gh.log"),
    gt: () => read("gt.log"),
    // Each branch holds exactly its own commit, on `main` (the bottom) or on the branch below,
    // and origin has exactly the local branch.
    assertReplayed: () => {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env, encoding: "utf8" }).trim();
      git("fetch", "-q", "origin");
      for (const [branch, below, file] of [[fix, "origin/main", "fix.txt"], [top, fix, "top.txt"]]) {
        assert.equal(git("rev-parse", `origin/${branch}`), git("rev-parse", branch), `${branch} was pushed`);
        assert.equal(git("rev-parse", `${branch}^`), git("rev-parse", below), `${branch} sits on ${below}`);
        assert.equal(git("diff", "--name-only", `${branch}^`, branch), file, `${branch} holds only its own change`);
      }
      assert.equal(git("ls-remote", "origin", `refs/heads/${options.base}`) !== "", !options.deleted, `${options.base} is not recreated`);
    },
  };
}

test("a pull request closed without merging follows the open pull request from its branch", async (t) => {
  for (const base of [PARENT, "main"]) {
    const h = harness(t);
    h.github.view = { ...OPEN_PR, state: "CLOSED", baseBranch: base };
    h.github.deleted = [PARENT];
    h.github.open = [listed(NEXT, OPEN_PR)];
    assert.deepEqual(await h.poll(), [`link Pull request ${NEXT}`, `handover link ${NEXT}`, `session link Pull request ${NEXT}`, "say thought The pull request was closed without merging; Paseo now follows its replacement #1500 from the same branch."], base);
    h.github.view = OPEN_PR;
    assert.deepEqual(await h.poll(), []);
    assert.deepEqual(h.github.reads, [NEXT], "the replacement is watched from then on");
  }
});

test("without a replacement, a pull request closed because its base branch is gone tells its agent once how to open one", async (t) => {
  const h = harness(t);
  h.github.view = { ...OPEN_PR, state: "CLOSED", baseBranch: PARENT };
  h.github.deleted = [PARENT];
  h.paseo.answer = async () => "busy";
  assert.deepEqual(await h.poll(), [], "in a turn: waits");
  h.paseo.answer = async () => "sent";
  const calls = await h.poll();
  const prompt = promptOf(calls) ?? "";
  assert.match(prompt, new RegExp(`^\\[The pull request\\]\\(${PR}\\) was closed without merging: its base branch \`${PARENT}\` is gone`));
  // AC-12: the message's commands, run on the stack's top branch, replay the stack onto main and
  // open the replacement.
  const repo = await replayRepo(t, { base: PARENT, deleted: true });
  repo.run(blockOf(prompt));
  repo.assertReplayed();
  assert.match(repo.gh(), /^pr create --base main --head mtuchel\/tuc-1-fix --title Fix the upload --body Replaces https:\/\/github\.com\/tuchel-sohn\/tuchel-platform\/pull\/419$/m);
  assert.equal(repo.gt(), "track mtuchel/tuc-1-fix --parent main\n");
  assert.equal(calls.at(-1), "say thought The pull request was closed because the branch below it landed; the agent was asked to open its replacement.");
  assert.equal(calls.length, 2);
  assert.deepEqual(await h.poll(), [], "told once");
  await h.restart();
  assert.deepEqual(await h.poll(), [], "also after a restart");
  h.github.open = [listed(NEXT, OPEN_PR)];
  assert.match((await h.poll())[0], new RegExp(`^link Pull request ${NEXT}`), "the replacement the agent opened is followed");

  const kept = harness(t);
  kept.github.view = { ...OPEN_PR, state: "CLOSED" };
  assert.deepEqual(await kept.poll(), [], "closed while its base branch exists: nothing to replay");
  kept.github.deleted = ["main"];
  assert.deepEqual(await kept.poll(), [], "the closure was looked at once");

  const gone = harness(t, { live: false });
  gone.github.view = { ...OPEN_PR, state: "CLOSED", baseBranch: PARENT };
  gone.github.deleted = [PARENT];
  const handedBack = await gone.poll();
  assert.equal(handedBack[0], "move In Progress");
  assert.match(handedBack[1], new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running[^]*gt track mtuchel/tuc-1-fix --parent main`));
  assert.equal(handedBack[2], "say response The pull request was closed because the branch below it landed, and the agent is no longer running; the ticket is back in In Progress.");
  assert.equal(handedBack.length, 3);
  assert.deepEqual(await gone.poll(), []);
});

test("an archived agent's closed pull request stays watched after the replay request, so a replacement opened later is linked", async (t) => {
  const h = harness(t, { status: "archived" });
  h.github.view = { ...OPEN_PR, state: "CLOSED", baseBranch: PARENT };
  h.github.deleted = [PARENT];
  assert.match((await h.poll())[1] ?? "", /^comment [^]*gt track mtuchel\/tuc-1-fix --parent main/);
  assert.deepEqual(await h.poll(), [], "asked once");
  assert.deepEqual(h.github.reads, [PR], "still watched for its replacement");
  h.github.open = [listed(NEXT, OPEN_PR)];
  assert.deepEqual(await h.poll(), [`link Pull request ${NEXT}`, `handover link ${NEXT}`, `session link Pull request ${NEXT}`, "say thought The pull request was closed without merging; Paseo now follows its replacement #1500 from the same branch."]);
  h.github.view = OPEN_PR;
  await h.poll();
  assert.deepEqual(h.github.reads, [NEXT]);

  const quiet = harness(t, { status: "archived", updatedAt: ago(15 * 24 * 60 * MINUTE) });
  await quiet.state({ [PR]: { reviewedAt: null, decision: null, merged: false, closed: true, replay: "asked", activeAt: ago(15 * 24 * 60 * MINUTE) } });
  quiet.github.view = { ...OPEN_PR, state: "CLOSED", baseBranch: PARENT };
  await quiet.poll();
  assert.deepEqual(quiet.github.reads, [], "14 days without activity end the watch");
});

test("after a partial landing the ticket's lowest open pull request is linked, watched and nudged until none is open", async (t) => {
  const pull = (number: number) => `https://github.com/tuchel-sohn/tuchel-platform/pull/${number}`;
  const LANDED = ["externally-merged"];
  for (const status of ["working", "archived"] as const) {
    const h = harness(t, { status });
    // 419 landed; 1501 (now on main, its checks failed) <- 1502 stay open, 1502's CI still runs;
    // TUC-10's 1499 is not the ticket's.
    const step2 = { ...READY, headSha: "s2", headBranch: "mtuchel/tuc-1-b", baseBranch: "main", checks: [failing("PR code")] };
    const step3 = { ...READY, headSha: "s3", headBranch: "mtuchel/tuc-1-c", baseBranch: "mtuchel/tuc-1-b", checks: [GREEN, passing("PR code"), RUNNING_CI] };
    const other = { ...READY, headSha: "o1", headBranch: "mtuchel/tuc-10-x", baseBranch: "main" };
    h.github.view = { ...READY, state: "CLOSED", labels: LANDED };
    h.github.views = { [pull(1501)]: step2, [pull(1502)]: step3, [pull(1499)]: other };
    h.github.open = [listed(pull(1499), other, "Add TUC-10 [plugin] Something else"), listed(pull(1502), step3, "Add TUC-1 [plugin] Step three"), listed(pull(1501), step2, "Add TUC-1 [plugin] Step two")];
    assert.deepEqual(await h.poll(), ["review merged", "say thought The pull request was merged.", "merged i1", `link Pull request ${pull(1501)}`, `handover link ${pull(1501)}`, `session link Pull request ${pull(1501)}`, "say thought The pull request landed; Paseo now follows the ticket's next open pull request #1501."], status);
    const nudged = await h.poll();
    assert.equal(h.github.reads[0], pull(1501), status);
    assert.ok(nudged.some((call) => call.includes(`Checks failed on the head of [the pull request](${pull(1501)})`)), `${status}: the remaining pull request gets its nudge`);

    h.github.views[pull(1501)] = { ...step2, state: "CLOSED", labels: LANDED };
    h.github.open = [listed(pull(1499), other, "Add TUC-10 [plugin] Something else"), listed(pull(1502), { ...step3, baseBranch: "main" }, "Add TUC-1 [plugin] Step three")];
    assert.ok((await h.poll()).includes(`handover link ${pull(1502)}`), `${status}: the next landing moves the link again`);
    h.github.views[pull(1502)] = { ...step3, state: "CLOSED", labels: LANDED };
    h.github.open = [listed(pull(1499), other, "Add TUC-10 [plugin] Something else")];
    assert.deepEqual(await h.poll(), ["review merged", "say thought The pull request was merged.", "merged i1"], `${status}: nothing of the ticket is open any more`);
    assert.deepEqual(await h.poll(), [], status);
  }
});

test("an archived agent's landing is followed to the ticket's next pull request after the lookup or the move failed, or a rate limit ended the poll first", async (t) => {
  const pull = (number: number) => `https://github.com/tuchel-sohn/tuchel-platform/pull/${number}`;
  const step2 = { ...READY, headSha: "s2", headBranch: "mtuchel/tuc-1-b", baseBranch: "main", checks: [failing("PR code")] };
  t.mock.method(console, "error", () => {});
  for (const failure of ["lookup", "throttled lookup", "move", "another pull request throttled"] as const) {
    const h = harness(t, { status: "archived" });
    h.github.view = { ...READY, state: "CLOSED", labels: ["externally-merged"] };
    h.github.views = { [pull(1501)]: step2 };
    h.github.open = [listed(pull(1501), step2, "Add TUC-1 [plugin] Step two")];
    if (failure === "lookup") h.github.listFailure = new Error("gh: connection reset");
    if (failure === "throttled lookup") h.github.listFailure = new GitHubRateLimitedError("GitHub is throttling gh: HTTP 403: API rate limit exceeded");
    if (failure === "move") h.linear.failure = new Error("Linear is unavailable");
    if (failure === "another pull request throttled") {
      h.records.push({ ...h.records[0], issueId: "i2", identifier: "TUC-2", agentId: "a2", links: { "Pull request": pull(2000) } });
      h.github.views[pull(2000)] = OPEN_PR;
      h.github.throttle = [pull(2000)];
    }
    assert.deepEqual(await h.poll(), ["review merged", "say thought The pull request was merged.", "merged i1"], failure);
    h.github.listFailure = null;
    h.linear.failure = null;
    h.github.throttle = [];
    await h.restart();
    const recovered = await h.poll();
    assert.deepEqual(recovered.slice(0, 3), [`link Pull request ${pull(1501)}`, `handover link ${pull(1501)}`, `session link Pull request ${pull(1501)}`], failure);
    const nudged = await h.poll();
    assert.equal(h.github.reads[0], pull(1501), failure);
    assert.ok(nudged.some((call) => call.includes(`Checks failed on the head of [the pull request](${pull(1501)})`)), `${failure}: the remaining pull request is nudged`);
  }
});

test("missing PR links recover the lowest open ticket remainder after #2000 landed and repair it in the same poll", async (t) => {
  const h = harness(t);
  h.records[0] = { ...h.records[0], identifier: "TUC-654", branch: "mtuchel/tuc-654-landed", links: {} };
  h.git.origin = "git@github.com:tuchel-sohn/tuchel-platform.git";
  const bottom = { ...OPEN_PR, headBranch: "mtuchel/tuc-654-b", checks: [failing("PR code")] };
  const middle = { ...OPEN_PR, headBranch: "mtuchel/tuc-654-c", baseBranch: bottom.headBranch };
  const top = { ...OPEN_PR, headBranch: "mtuchel/tuc-654-d", baseBranch: middle.headBranch };
  h.github.view = { ...OPEN_PR, state: "CLOSED", labels: ["externally-merged"] };
  h.github.views[prUrl(2001)] = bottom;
  h.github.views[prUrl(2002)] = middle;
  h.github.views[prUrl(2003)] = top;
  h.github.open = [
    listed(prUrl(1999), OPEN_PR, "Fix TUC-6540 [queue] Not this ticket"),
    listed(prUrl(2003), top, "Fix TUC-654 [queue] Top"),
    listed(prUrl(2010), { ...OPEN_PR, headBranch: "mtuchel/tuc-654-independent" }, "Fix TUC-654 [queue] Independent"),
    listed(prUrl(2002), middle, "Fix TUC-654 [queue] Middle"),
    listed(prUrl(2001), bottom, "Fix TUC-654 [queue] Bottom remainder"),
  ];
  const landed = { reviewedAt: null, decision: null, merged: true, advance: "due" };
  await h.state({ [prUrl(2000)]: landed });
  const calls = await h.poll();
  assert.equal(h.records[0].links["Pull request"], prUrl(2001));
  assert.deepEqual(h.github.reads, [prUrl(2001), prUrl(2002), prUrl(2003)], "the recovered PR, then its connected stack before any nudge");
  assert.match(promptOf(calls) ?? "", /Checks failed on the head of \[the pull request\]\(https:\/\/github\.com\/tuchel-sohn\/tuchel-platform\/pull\/2001\)/);
  assert.deepEqual(h.linear.issueReads, [], "a validated source origin wins without ticket reads");
  assert.deepEqual(JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8"))[prUrl(2000)], landed, "discovery leaves earlier lifecycle claims intact");
  assert.deepEqual(await h.poll(), [], "link and repair are not repeated");
  await h.restart();
  assert.deepEqual(await h.poll(), [], "persisted link and nudge survive restart");
});

test("a removed worktree recovers its open remainder from the ticket's canonical landed-PR attachment", async (t) => {
  for (const worktreePath of ["/removed/tuc-654", null]) {
    const h = harness(t);
    h.records[0] = { ...h.records[0], identifier: "TUC-654", branch: "mtuchel/tuc-654-landed", worktreePath, links: {} };
    h.linear.attachments = [prUrl(2000), prUrl(2000), "https://linear.app/ws/issue/TUC-654"];
    const bottom = { ...OPEN_PR, headBranch: "mtuchel/tuc-654-b" };
    const upper = { ...OPEN_PR, headBranch: "mtuchel/tuc-654-c", baseBranch: bottom.headBranch };
    h.github.open = [
      listed(prUrl(2002), upper, "Fix TUC-654 [queue] Upper"),
      listed(prUrl(2001), bottom, "Fix TUC-654 [queue] Remainder"),
    ];
    h.github.views[prUrl(2001)] = bottom;
    h.github.views[prUrl(2002)] = upper;
    h.github.view = { ...OPEN_PR, state: "CLOSED" };
    assert.ok((await h.poll()).includes(`handover link ${prUrl(2001)}`), String(worktreePath));
    assert.equal(h.records[0].links["Pull request"], prUrl(2001));
    assert.deepEqual(h.github.reads, [prUrl(2001), prUrl(2002)], "the recovered PR is read immediately, then its connected stack");
    assert.deepEqual(h.github.listings, ["tuchel-sohn/tuchel-platform"]);
    await h.restart();
    assert.deepEqual(await h.poll(), [], "attachment fallback is not relinked on restart");
  }
});

test("linkless records share one repository listing and retain same-poll recovered records", async (t) => {
  const h = harness(t);
  h.records[0] = { ...h.records[0], identifier: "TUC-654", branch: "mtuchel/tuc-654", links: {} };
  h.records.push({ ...h.records[0], issueId: "i2", agentId: "a2", identifier: "TUC-566", branch: "mtuchel/tuc-566" });
  h.git.origin = "https://github.com/tuchel-sohn/tuchel-platform.git";
  h.github.open = [listed(prUrl(2001), OPEN_PR, "Fix TUC-654 [queue] Recover"), listed(prUrl(2050), OPEN_PR, "Fix TUC-566 [queue] Recover")];
  await h.poll();
  assert.deepEqual(h.records.map((record) => record.links["Pull request"]), [prUrl(2001), prUrl(2050)]);
  assert.deepEqual(h.github.reads, [prUrl(2001), prUrl(2050)]);
  assert.deepEqual(h.github.listings, ["tuchel-sohn/tuchel-platform"]);
});

test("direct backstop recovery uses an existing trusted checkout and reuses the attachment repository listing", async (t) => {
  const h = harness(t);
  h.records[0] = { ...h.records[0], identifier: "TUC-654", branch: "mtuchel/tuc-654-landed", worktreePath: null, links: {} };
  h.linear.attachments = [prUrl(2000)];
  h.github.view = { ...OPEN_PR, state: "CLOSED" };
  h.github.open = [listed(prUrl(2001), OPEN_PR, "Fix TUC-654 [queue] Remainder")];
  const calls = await h.backstop();
  assert.ok(calls.includes(`handover link ${prUrl(2001)}`));
  assert.deepEqual(h.scripts.checkouts, [{ repo: "tuchel-sohn/tuchel-platform", sources: [] }], "the trusted checkout can exist without worker folders");
  assert.ok(h.scripts.runs.includes(READY_RUN), "the newly discovered repo participates in the backstop");
  assert.deepEqual(h.github.listings, ["tuchel-sohn/tuchel-platform"], "discovery and the backstop share the listing");
  assert.deepEqual(await h.backstop(), [], "no repeated link");
  await h.restart();
  assert.deepEqual(await h.backstop(), [], "no repeated link after restart");
});

test("missing-link discovery respects in-flight delivery and keeps queued repairs through restart", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness(t);
  h.records[0] = { ...h.records[0], branch: OPEN_PR.headBranch, links: {} };
  h.git.origin = "ssh://git@github.com/tuchel-sohn/tuchel-platform.git";
  h.github.open = [listed(PR, OPEN_PR)];
  const pending = { key: "#437", reason: "Already claimed.", facts: "Repair.", fix: "Fix the checks.", sending: true };
  const queued = [{ key: "#438", reason: "Next claim.", facts: "Repair next.", fix: "Fix the next checks." }];
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, drops: ["#437", "#438"], blockedAt: HEAD, pending, queued } });
  assert.ok(!(await h.poll()).some((call) => call.startsWith("prompt ")), "an in-flight send is never duplicated");
  await h.restart();
  h.paseo.answer = async () => "busy";
  assert.deepEqual(await h.poll(), []);
  h.paseo.answer = async () => "sent";
  assert.match(promptOf(await h.poll()) ?? "", /Fix the next checks\./);
  await h.restart();
  assert.deepEqual(await h.poll(), [], "the queued repair is delivered only once");
});

test("missing-link recovery skips wrong origins, invalid folders, noncanonical attachments and tickets with no exact open candidate", async (t) => {
  const cases = [
    { name: "valid other origin takes precedence over ticket attachments", origin: "https://github.com/another/repo.git", attachments: [prUrl(2000)], expectedRepo: "another/repo" },
    { name: "lookalike origin is not GitHub", origin: "https://github.com.evil.test/tuchel-sohn/tuchel-platform.git", attachments: [], expectedRepo: null },
    { name: "non-worktree /tmp is ignored", origin: "https://github.com/tuchel-sohn/tuchel-platform.git", root: "/different/checkout", attachments: [], expectedRepo: null },
    { name: "no source and no attachments", origin: null, attachments: [], expectedRepo: null },
    { name: "noncanonical attachments", origin: null, attachments: ["https://github.com.evil.test/tuchel-sohn/tuchel-platform/pull/2000", "http://github.com/tuchel-sohn/tuchel-platform/pull/2000", "https://github.com/tuchel-sohn/tuchel-platform/issues/2000", `${prUrl(2000)}/extra`], expectedRepo: null },
    { name: "ambiguous attachment repositories", origin: null, attachments: [prUrl(2000), "https://github.com/another/repo/pull/1"], expectedRepo: null },
    { name: "only the longer ticket identifier is open", origin: "git@github.com:tuchel-sohn/tuchel-platform.git", attachments: [], expectedRepo: "tuchel-sohn/tuchel-platform" },
  ];
  for (const item of cases) {
    const h = harness(t);
    h.records[0] = { ...h.records[0], identifier: "TUC-654", branch: "mtuchel/tuc-654", worktreePath: "root" in item ? "/tmp" : h.records[0].worktreePath, links: {} };
    h.git.origin = item.origin;
    h.git.root = "root" in item ? item.root! : null;
    h.linear.attachments = item.attachments;
    h.github.open = [listed(prUrl(2001), OPEN_PR, "Fix TUC-6540 [queue] Different ticket")];
    assert.deepEqual(await h.poll(), [], item.name);
    assert.deepEqual(h.records[0].links, {}, item.name);
    assert.deepEqual(h.github.reads, [], item.name);
    assert.deepEqual(h.github.listings, item.expectedRepo ? [item.expectedRepo] : [], item.name);
  }
});

test("an unreadable attachment source leaves discovery and its existing claims pending", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness(t);
  h.records[0] = { ...h.records[0], branch: OPEN_PR.headBranch, links: {} };
  h.linear.attachments = [PR];
  h.linear.issueFailure = new Error("Linear is unavailable");
  const pending = { key: "#437", reason: "Claimed.", facts: "Repair.", fix: "Fix the checks." };
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, pending } });
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual(h.github.listings, []);
  assert.deepEqual(h.records[0].links, {});
  assert.deepEqual(JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8"))[PR].pending, pending);
});

test("archived linkless records discover only inside the existing 14-day relevance window", async (t) => {
  for (const days of [13, 15]) {
    const h = harness(t, { status: "archived", updatedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() });
    h.records[0] = { ...h.records[0], branch: OPEN_PR.headBranch, links: {} };
    h.git.origin = "git@github.com:tuchel-sohn/tuchel-platform.git";
    h.github.open = [listed(PR, OPEN_PR)];
    await h.poll();
    assert.deepEqual(h.github.reads, days === 13 ? [PR] : [], String(days));
    assert.equal(h.records[0].links["Pull request"], days === 13 ? PR : undefined, String(days));
  }
});

test("a discovery listing rate limit stops later PR reads and retries discovery next poll", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness(t);
  h.records[0] = { ...h.records[0], branch: OPEN_PR.headBranch, links: {} };
  h.records.push({ ...h.records[0], issueId: "i2", agentId: "a2", identifier: "TUC-2", links: { "Pull request": prUrl(420) } });
  h.git.origin = "git@github.com:tuchel-sohn/tuchel-platform.git";
  h.github.listFailure = new GitHubRateLimitedError("GitHub is throttling gh");
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual(h.github.reads, [], "the later linked PR is not read after throttling");
  assert.deepEqual(h.records[0].links, {});
  h.github.listFailure = null;
  h.github.open = [listed(PR, OPEN_PR)];
  await h.poll();
  assert.equal(h.records[0].links["Pull request"], PR, "the failed discovery is retried");
  assert.deepEqual(h.github.reads, [PR, prUrl(420)]);
});

// --- The queue backstop (TUC-615) ---------------------------------------------------------------

const prUrl = (number: number) => `https://github.com/tuchel-sohn/tuchel-platform/pull/${number}`;
// The recorded pull request alone, ready for 10 minutes, as `enqueue-ready.mjs` lists it.
const STACK = { action: `ready:419@${HEAD}`, top: 419, branch: "mtuchel/tuc-1-fix", prs: [419], expect: `419@${HEAD}`, tickets: ["TUC-1"], result: "candidate" };
const READY_RUN = `${ENQUEUE_READY} --ready-minutes 10`;
const enqueueRun = (action: string, expect = `419@${HEAD}`) => `${BACKSTOP_ENQUEUE} mtuchel/tuc-1-fix --expect ${expect} --action ${action} --comment-file /comments/${action}.md`;
// A flaky failure on the queue's draft #437 that tested exactly the open heads.
const SAME = { state: "same", draft: 437, branch: "mtuchel/tuc-1-fix", expect: `419@${HEAD}`, reason: "the queue's draft tested these heads" };
const FLAKY: Judgment = { class: "flaky", requeue: true, evidence: ["`server/upload.test.ts > retries` failed outside the change and is a known flaky test"], revision: SAME, failures: [{ check: "Code validation / Core (core-web)", conclusion: "failure", url: "https://github.com/tuchel-sohn/tuchel-platform/actions/runs/9/job/2" }] };
const ENQUEUED = "Paseo's queue backstop enqueued [#419](https://github.com/tuchel-sohn/tuchel-platform/pull/419) through `tools/ci/enqueue.mjs`.";
const firstLines = (calls: string[]) => calls.map((call) => call.split("\n")[0]);
const count = (calls: string[], start: string) => calls.filter((call) => call.startsWith(start)).length;

// The watched pull request's Merge activity, one bullet per event; `stamp` gives every bullet the
// same minute.
function bulletsOf(h: { github: { view: PullRequestView } }, options: { stamp?: string } = {}, ...initial: string[]) {
  const list = [...initial];
  const render = () => options.stamp ? `### Merge activity\n\n${list.map((event) => `* **${options.stamp}**: ${event}`).join("\n")}\n` : activity(...list);
  const set = () => { h.github.view = { ...h.github.view, mergeActivity: list.length ? render() : null }; };
  set();
  return { add: (...more: string[]) => { list.push(...more); set(); }, replace: (body: string) => { list.length = 0; h.github.view = { ...h.github.view, mergeActivity: body }; } };
}

// A point a run hangs at forever: a crash there. `reached` resolves once the run got there.
function hang() {
  let reach = () => {};
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  return { point: async (): Promise<void> => { reach(); await new Promise(() => {}); }, reached };
}

test("a ready stack nobody enqueued is enqueued by the backstop, with the pull request comment, the ticket comment and a note to the agent, once", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  const calls = await h.backstop();
  assert.deepEqual(h.scripts.runs, [READY_RUN, enqueueRun(STACK.action)]);
  assert.deepEqual(firstLines(calls), [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action ${STACK.action}`, `pr comment #419 ${ENQUEUED}`, `comment ${ENQUEUED}`, "prompt a1"]);
  assert.match(h.github.comments[419][0], /green, reviewed and without open threads for 10 minutes[^]*Nothing is needed from the agent[^]*<!-- queue-backstop:ready:419@a1b2c3d4e5f6 -->$/);
  assert.match(promptOf(calls) ?? "", /Do not enqueue it again yourself\.$/);
  assert.deepEqual(await h.backstop(), [], "listed again, but enqueued already");
  assert.deepEqual(await h.poll(), [], "and no merge nudge either");
});

test("a held enqueue is retried on the next backstop run, once per run", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  const held = { code: 3, answer: { result: "held", problems: [{ kind: "main-red", text: "main is red" }] } };
  h.scripts.enqueue = [held, held, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
  for (let run = 0; run < 2; run++) assert.deepEqual(firstLines(await h.backstop()), [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action ${STACK.action}`], `run ${run}`);
  assert.deepEqual(h.scripts.runs, [enqueueRun(STACK.action), `${READY_RUN} --exclude 419`], "a held enqueue keeps the range out of the ready run");
  const enqueued = await h.backstop();
  assert.equal(count(enqueued, "enqueue "), 1);
  assert.equal(count(enqueued, `pr comment #419 ${ENQUEUED}`), 1);
});

test("a genuine drop goes to the agent, and the backstop never enqueues the range, across polls and a restart, until a new head", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  h.github.drafts = [draft(437, [419])];
  assert.match(promptOf(await h.poll()) ?? "", /2\. Fix the cause\./);
  h.scripts.ready = { stacks: [STACK], drops: [] };
  for (const step of ["backstop", "poll", "restart"]) {
    if (step === "poll") assert.deepEqual(await h.poll(), [], step);
    if (step === "restart") await h.restart();
    assert.deepEqual(await h.backstop(), [], step);
    assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419`], step);
  }
  const fixed = "b2c3d4e5f6a7";
  h.github.view = { ...h.github.view, headSha: fixed };
  h.scripts.ready = { stacks: [{ ...STACK, action: `ready:419@${fixed}`, expect: `419@${fixed}` }], drops: [] };
  await h.backstop();
  assert.deepEqual(h.scripts.runs, [READY_RUN, enqueueRun(`ready:419@${fixed}`, `419@${fixed}`)], "the fix is enqueued");
});

test("a flaky drop of unchanged code is re-enqueued by the backstop without the agent, whatever the count (AC-2)", async (t) => {
  const h = harness(t);
  const bullets = bulletsOf(h, {}, QUEUED, running(437), REMOVED);
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = FLAKY;
  h.scripts.onEnqueue = async () => bullets.add(QUEUED);
  assert.deepEqual(await h.poll(), [], "nothing for the agent");
  const calls = await h.backstop();
  assert.deepEqual(h.scripts.runs, [enqueueRun("drop:#437:419"), READY_RUN]);
  assert.deepEqual(firstLines(calls), [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action drop:#437:419`, `pr comment #419 ${ENQUEUED}`, `comment ${ENQUEUED}`, "prompt a1"]);
  assert.match(h.github.comments[419][0], /\[queue run #437\]\([^)]+\)\), and it was not the stack's fault: flaky[^]*- `server\/upload\.test\.ts > retries`[^]*The code is unchanged since the drop \(the queue's draft tested these heads\)\. Nothing of the range's own needs a fix; no drop count hands anything to the owner\./);
  assert.deepEqual(await h.backstop(), [], "once");
  // The next drop of the range is claimed like any first drop: the flaky round counted toward nothing.
  bullets.add(running(438), REMOVED);
  h.github.drafts = [draft(438, [419])];
  h.scripts.judgment = GENUINE;
  assert.match(promptOf(await h.poll()) ?? "", /This is genuine drop 2 of this range; every genuine drop gets this fix request\./);
});

test("a main-broken drop of unchanged code is re-enqueued once main is green: held until then, counted toward nothing", async (t) => {
  const h = harness(t);
  const bullets = bulletsOf(h, {}, QUEUED, running(437), REMOVED);
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = { ...MAIN_BROKEN, revision: SAME };
  h.scripts.onEnqueue = async () => bullets.add(QUEUED);
  const held = { code: 3, answer: { result: "held", problems: [{ kind: "main-red", text: "main is red" }] } };
  h.scripts.enqueue = [held, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual(firstLines(await h.backstop()), [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action drop:#437:419`], "held: no comment yet");
  const enqueued = await h.backstop();
  assert.equal(count(enqueued, "enqueue "), 1);
  assert.match(h.github.comments[419][0], /main-broken[^]*The code is unchanged since the drop \(the queue's draft tested these heads\)\. The drop was `main`'s; the enqueue waits until `main` is green\./);
});

test("the same heads dropped in two rounds are two re-enqueues, and each drop is counted once", async (t) => {
  const h = harness(t);
  const bullets = bulletsOf(h, {}, QUEUED, running(437), REMOVED);
  h.github.drafts = [draft(437, [419]), draft(438, [419])];
  h.scripts.judgment = { ...MAIN_BROKEN, revision: SAME };
  h.scripts.onEnqueue = async () => bullets.add(QUEUED);
  const enqueues: string[] = [];
  for (const round of [437, 438]) {
    if (round === 438) bullets.add(running(438), REMOVED);
    assert.deepEqual(await h.poll(), [], `round ${round}`);
    await h.restart();
    enqueues.push(...(await h.backstop()).filter((call) => call.startsWith("enqueue ")));
  }
  assert.deepEqual(enqueues, [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action drop:#437:419`, `enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action drop:#438:419`]);
  assert.deepEqual(await h.poll(), []);
  bullets.add(running(439), REMOVED);
  h.github.drafts = [draft(439, [419])];
  // The backstop's own enqueue of these heads came right before this round, so only a drop the
  // repo does not clear for a re-enqueue reaches the agent.
  h.scripts.judgment = { ...MAIN_BROKEN, requeue: false };
  assert.match(promptOf(await h.poll()) ?? "", /Drops of this range so far: 0 plain, 0 conflict-only, 3 main-broken\./);
});

test("a genuine drop of a range member goes to the agent and holds the whole range for the backstop until its heads change", async (t) => {
  const h = harness(t);
  const step2 = { ...READY, headSha: "5e5e5e5", headBranch: "mtuchel/tuc-1-b", baseBranch: "mtuchel/tuc-1-fix" };
  h.github.open = [listed(prUrl(1501), step2, "Add TUC-1 [plugin] Step two")];
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  h.github.drafts = [draft(437, [419, 1501])];
  assert.match(promptOf(await h.poll()) ?? "", /This is genuine drop 1 of this range; every genuine drop gets this fix request\./, "the drop of the range goes to the agent");
  h.scripts.ready = { stacks: [{ action: `ready:1501@${HEAD},5e5e5e5`, top: 1501, branch: "mtuchel/tuc-1-b", prs: [419, 1501], expect: `419@${HEAD},1501@5e5e5e5`, tickets: ["TUC-1"], result: "candidate" }], drops: [] };
  assert.deepEqual(await h.backstop(), [], "held at the heads the drop left");
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419 --exclude 1501`]);
  h.github.open = [listed(prUrl(1501), { ...step2, headSha: "6f6f6f6" }, "Add TUC-1 [plugin] Step two")];
  await h.backstop();
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419`], "the member's new head releases it; the dropped head still holds");
});

test("a refused enqueue goes to the agent once per refusal, and is skipped until the change that fixes it", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main", text: "server/upload.ts conflicts with main" }] } }];
  assert.deepEqual(firstLines(await h.backstop()), [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action ${STACK.action}`]);
  const routed = await h.poll();
  assert.equal(count(routed, "prompt "), 1, "the repair is dispatched to the agent");
  for (let run = 0; run < 2; run++) {
    assert.deepEqual(await h.backstop(), [], `run ${run}`);
    assert.deepEqual(h.scripts.runs, [`${READY_RUN} --skip ${STACK.action}`], `run ${run}`);
    assert.deepEqual(await h.poll(), [], `run ${run}: routed once`);
  }
});

test("an enqueue.mjs that enqueued nothing is final: an enqueue someone else made meanwhile is never claimed, also after a restart", async (t) => {
  // #2183, 2026-10-06: someone enqueued the range by hand; Graphite's comment showed that bullet
  // only after the backstop read its boundary, and the backstop's own `gt merge` answered "The
  // stack is already merging" (enqueue.mjs exit 1, not-enqueued).
  const h = harness(t);
  h.github.view = READY;
  const bullets = bulletsOf(h, {});
  // The hand enqueue's bullet appears while the backstop's own `gt merge` runs, after its boundary.
  let raced = false;
  h.scripts.answered = async () => {
    if (!raced) bullets.add(QUEUED);
    raced = true;
  };
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{
    code: 1,
    answer: {
      result: "error",
      error: "enqueue.mjs exited 1 (not-enqueued)",
      enqueue: { result: "not-enqueued", outcome: "failed", gtOutput: "/tmp/gt-merge-419.txt", next: "node tools/ci/merge-block-evidence.mjs 419" },
    },
  }];
  const first = await h.backstop();
  assert.equal(count(first, "enqueue "), 1);
  assert.equal(count(first, `comment ${ENQUEUED}`), 0, "no enqueue comment on the ticket");
  await h.restart();
  const later = await h.backstop();
  assert.equal(count(later, "enqueue "), 0, "not retried");
  assert.equal(count(later, `comment ${ENQUEUED}`), 0, "the other enqueue is not claimed after a restart");
  assert.match(h.scripts.runs.at(-1) ?? "", new RegExp(` --skip ${STACK.action}$`), "the refusal is skipped");
  const routed = await h.poll();
  assert.equal(count(routed, "prompt "), 1, "the agent hears once that the backstop enqueued nothing");
  assert.match(promptOf(routed) ?? "", /`not-enqueued`: `gt merge` enqueued nothing \(failed\); its output is in `\/tmp\/gt-merge-419\.txt`/);
  assert.deepEqual(await h.backstop(), []);
  assert.deepEqual(await h.poll(), [], "routed once");
});

test("a refusal of a pull request whose agent is gone goes to the ticket, and without a ticket to the pull request", async (t) => {
  const gone = harness(t, { live: false });
  gone.github.view = READY;
  gone.scripts.ready = { stacks: [STACK], drops: [] };
  gone.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main", text: "conflicts with main" }] } }];
  await gone.backstop();
  const calls = await gone.poll();
  assert.equal(calls[0], "move In Progress");
  assert.match(calls[1], new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running[^]*\`conflict-main\``));

  const orphan = harness(t);
  const bump = { ...READY, headSha: "7a7a7a7", headBranch: "mtuchel/bump", baseBranch: "main" };
  orphan.github.open = [listed(prUrl(1700), bump, "Bump the upload library")];
  orphan.scripts.ready = { stacks: [{ action: "ready:1700@7a7a7a7", top: 1700, branch: "mtuchel/bump", prs: [1700], expect: "1700@7a7a7a7", tickets: [], result: "candidate" }], drops: [] };
  orphan.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main", text: "conflicts with main" }] } }];
  const posted = await orphan.backstop();
  assert.deepEqual(firstLines(posted), ["enqueue mtuchel/bump --expect 1700@7a7a7a7 --action ready:1700@7a7a7a7", "pr comment #1700 Paseo's queue backstop tried to enqueue [#1700](https://github.com/tuchel-sohn/tuchel-platform/pull/1700) from `mtuchel/bump`, and `tools/ci/enqueue.mjs` refused:"]);
  assert.match(orphan.github.comments[1700][0], /<!-- queue-backstop:route:refused:ready:1700@7a7a7a7 conflict-main -->$/);
  assert.deepEqual(await orphan.backstop(), [], "once");
});

test("a refusal reaches its existing agent even when the handover has no pull request link", async (t) => {
  const h = harness(t);
  h.records[0].links = {};
  h.github.view = { ...READY, state: "CLOSED" };
  h.github.open = [listed(PR, READY)];
  h.github.views[PR] = READY;
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false } });
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main", text: "conflicts with main" }] } }];
  const calls = await h.backstop();
  assert.equal(count(calls, "prompt "), 1);
  assert.equal(count(calls, "comment "), 0, "the owner is not asked to run a repair");
  assert.deepEqual(await h.backstop(), [], "delivered once");
});

test("a persisted refusal still reaches its agent when the handover link moves before delivery", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main", text: "conflicts with main" }] } }];
  await h.backstop();
  h.records[0].links["Pull request"] = prUrl(1501);
  h.github.open = [listed(PR, READY)];
  await h.restart();
  const calls = await h.backstop();
  assert.equal(count(calls, "prompt "), 1);
  assert.equal(count(calls, "comment "), 0);
  assert.deepEqual(await h.backstop(), [], "persisted delivery is not repeated");
});

test("a persisted claimed message and the one queued behind it reach the agent once when the handover link disappears", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main", text: "conflicts with main" }] } }];
  await h.backstop();
  const state = JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8"));
  assert.ok(state[PR].pending, "the linked refusal waits for delivery");
  state[PR].pending.sending = true;
  state[PR].queued = [{ key: "refused:queued", reason: "Next refusal.", facts: "Another repair is waiting.", fix: "Repair the queued refusal." }];
  await h.state(state);
  h.records[0].links = {};
  h.github.open = [listed(PR, READY)];
  await h.restart();

  const calls = await h.backstop();
  assert.equal(count(calls, "prompt "), 1, "the claimed refusal is not sent again");
  assert.equal(promptOf(calls), "Repair the queued refusal.");
  assert.equal(count(calls, "comment "), 0, "the owner is not asked to repair either refusal");
  assert.equal(count(calls, "pr comment "), 0, "the repair belongs to the ticket's agent");
  await h.restart();
  assert.deepEqual(await h.backstop(), [], "the queued refusal is not repeated after restart");

  h.github.drafts = [draft(437, [419])];
  h.scripts.ready = { stacks: [STACK], drops: [{ pr: 419, draft: 437, key: "#437", revision: null }] };
  assert.equal(count(await h.backstop(), "enqueue "), 0, "a genuine drop of the unchanged head is not enqueued");
  await h.restart();
  assert.deepEqual(await h.backstop(), [], "the genuine drop is not delivered again");
  assert.match(h.scripts.runs[0], /--exclude 419(?: |$)/, "the unchanged head remains excluded after restart");
});

test("a queue-tip conflict is routed once and retried once its queue draft is closed", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.github.drafts = [draft(900, [1400], "OPEN")];
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-tip", draft: 900, text: "conflicts with the queue tip" }] } }, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
  await h.backstop();
  assert.match(promptOf(await h.poll()) ?? "", /- `conflict-tip` \(queue draft #900\): conflicts with the queue tip/);
  assert.deepEqual(await h.backstop(), [], "the draft is still open");
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --skip ${STACK.action}`]);
  h.github.drafts = [draft(900, [1400])];
  const retried = await h.backstop();
  assert.deepEqual(h.scripts.runs, [READY_RUN, enqueueRun(STACK.action)]);
  assert.equal(count(retried, `pr comment #419 ${ENQUEUED}`), 1);
  assert.deepEqual(await h.poll(), [], "not routed again");
  assert.deepEqual(await h.backstop(), [], "enqueued: not retried again");
});

test("other repairable conditions retry only after the hourly boundary, without repeating the repair request", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  const differs = { code: 2, answer: { result: "refused", problems: [{ kind: "remote-differs", text: "a fresh remote read is needed" }] } };
  h.scripts.enqueue = [differs, differs, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
  await h.backstop();
  assert.equal(count(await h.poll(), "prompt "), 1);
  h.scripts.now += 30 * MINUTE;
  assert.deepEqual(await h.backstop(), []);
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --skip ${STACK.action}`], "not within half an hour");
  h.scripts.now += 31 * MINUTE;
  assert.equal(count(await h.backstop(), "enqueue "), 1, "retried after the hour");
  assert.deepEqual(await h.poll(), [], "the same refusal is not routed again");
  h.scripts.now += 61 * MINUTE;
  const repaired = await h.backstop();
  assert.equal(count(repaired, `pr comment #419 ${ENQUEUED}`), 1, "repaired: enqueued");
  assert.deepEqual(await h.poll(), []);
});

test("old local-differs refusals retry on the next backstop tick with unchanged reviewed heads", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "local-differs" }] } }, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
  await h.backstop();
  await h.poll();
  assert.equal(count(await h.backstop(), "enqueue "), 1, "no hourly wait for shared refs");
  assert.deepEqual(await h.backstop(), [], "no second enqueue after success");
});

test("an unlinked repair waits for its busy agent, survives restart, and dispatches once when it is idle", async (t) => {
  const h = harness(t);
  h.records[0].links = {};
  h.github.view = { ...READY, state: "CLOSED" };
  h.github.open = [listed(PR, READY)];
  h.github.views[PR] = READY;
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false } });
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main" }] } }];
  h.paseo.answer = async () => "busy";
  assert.equal(count(await h.backstop(), "prompt "), 0);
  await h.restart();
  assert.deepEqual(await h.backstop(), [], "a busy agent keeps the persisted repair pending");
  h.paseo.answer = async () => "sent";
  assert.equal(count(await h.backstop(), "prompt "), 1);
  assert.deepEqual(await h.backstop(), [], "the repair is not repeated");
});

test("an unlinked repair restarts a crashed agent rather than assigning its shell commands to the owner", async (t) => {
  const h = harness(t, { crash: true });
  h.records[0].links = {};
  h.github.view = { ...READY, state: "CLOSED" };
  h.github.open = [listed(PR, READY)];
  h.github.views[PR] = READY;
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false } });
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main" }] } }];
  const calls = await h.backstop();
  assert.equal(count(calls, "reload a1"), 1);
  assert.equal(count(calls, "prompt "), 1);
  assert.equal(count(calls, "comment "), 0);
  assert.deepEqual(await h.backstop(), [], "restart dispatch is not repeated");
});

test("an open manual task due before the merge, or one that cannot be read, keeps the range out of both enqueue paths", async (t) => {
  for (const gate of ["open", "unreadable"] as const) {
    const h = harness(t);
    h.github.view = READY;
    h.scripts.ready = { stacks: [STACK], drops: [] };
    if (gate === "open") h.blockers.push("TUC-9");
    else h.gate.unreadable = true;
    assert.deepEqual(await h.backstop(), [], gate);
    assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419`], gate);

    const dropped = harness(t);
    t.mock.method(console, "error", () => {});
    if (gate === "open") dropped.blockers.push("TUC-9");
    else dropped.gate.unreadable = true;
    dropped.github.view = { ...OPEN_PR, mergeActivity: activity(QUEUED, running(437), REMOVED) };
    dropped.github.drafts = [draft(437, [419])];
    dropped.scripts.judgment = FLAKY;
    assert.match(promptOf(await dropped.poll()) ?? "", /Paseo did not re-enqueue it: a manual task due before the merge is open\. Re-enqueue once it is done\./, gate);
    assert.deepEqual(await dropped.backstop(), [], gate);
    assert.deepEqual(dropped.scripts.runs, [`${READY_RUN} --exclude 419`], gate);
  }
});

test("a drop whose range changed since is neither re-enqueued nor sent: the new code goes through the ready rule", async (t) => {
  const h = harness(t);
  t.mock.method(console, "error", () => {});
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = { ...FLAKY, revision: { ...SAME, state: "changed", reason: "a new head" } };
  assert.deepEqual(await h.poll(), []);
  h.scripts.ready = { stacks: [STACK], drops: [] };
  await h.backstop();
  assert.deepEqual(h.scripts.runs, [READY_RUN, enqueueRun(STACK.action)]);
});

test("a drop whose code could not be compared stays out of both enqueue paths and goes to the agent", async (t) => {
  const h = harness(t);
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = { ...FLAKY, revision: { state: "unknown", reason: "the queue's draft could not be read" } };
  const prompt = promptOf(await h.poll()) ?? "";
  assert.match(prompt, /Paseo did not re-enqueue it: it could not prove that the range is still the code that dropped \(the queue's draft could not be read\), and it leaves the range alone until one of its heads changes\./);
  assert.match(prompt, /Not the stack's fault \(flaky: [^)]*\)[^]*Drops of this range so far: 1 plain, 0 conflict-only, 0 main-broken\./);
  h.scripts.ready = { stacks: [STACK], drops: [] };
  for (const step of ["backstop", "restart"]) {
    if (step === "restart") await h.restart();
    assert.deepEqual(await h.backstop(), [], step);
    assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419`], step);
  }
});

test("a drop of a pull request no agent watches is found through enqueue-ready.mjs; without a ticket, its request goes to the pull request once", async (t) => {
  const h = harness(t);
  h.github.open = [listed(prUrl(1700), { ...OPEN_PR, headSha: "7a7a7a7", headBranch: "mtuchel/bump" }, "Bump the upload library")];
  h.github.drafts = [draft(450, [1700])];
  h.scripts.ready = { stacks: [], drops: [{ pr: 1700, draft: 450, key: "#450", revision: null }] };
  const calls = await h.backstop();
  assert.deepEqual(h.scripts.runs, [READY_RUN, `${WAIT_QUEUE} 1700 --draft 450`]);
  assert.deepEqual(firstLines(calls), [`pr comment #1700 The Graphite merge queue dropped [the pull request](${prUrl(1700)}) without merging it.`]);
  assert.match(h.github.comments[1700][0], /2\. Fix the cause\.[^]*<!-- queue-backstop:route:#450 -->$/);
  assert.deepEqual(await h.backstop(), [], "claimed once");
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 1700`], "and blocked at its head");
});

test("a crash before the enqueue, after it, between its comments or during the ticket comment runs every step exactly once", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const crash of ["before the enqueue", "after the enqueue", "between the comments", "during the ticket comment"] as const) {
    const h = harness(t);
    h.github.view = READY;
    const bullets = bulletsOf(h);
    h.scripts.onEnqueue = async () => bullets.add(QUEUED);
    h.scripts.ready = { stacks: [STACK], drops: [] };
    const stop = hang();
    if (crash === "before the enqueue") h.scripts.beforeEnqueue = stop.point;
    if (crash === "after the enqueue") h.scripts.answered = stop.point;
    if (crash === "between the comments") {
      h.scripts.enqueue = [{ code: 0, answer: { result: "enqueued", comment: "none" } }];
      h.github.stall = stop.point;
    }
    if (crash === "during the ticket comment") h.linear.stall = stop.point;
    void h.backstop();
    await stop.reached;
    const crashed = [...h.calls];
    h.scripts.beforeEnqueue = h.scripts.answered = h.github.stall = h.linear.stall = async () => {};
    await h.restart();
    const all = [...crashed, ...await h.backstop(), ...await h.backstop()];
    for (const step of ["enqueue ", `pr comment #419 ${ENQUEUED}`, `comment ${ENQUEUED}`, "prompt a1\n"]) assert.equal(count(all, step), 1, `${crash}: ${step}`);
    assert.equal(h.github.comments[419].length, 1, crash);
  }
});

test("after a restart the enqueue bullet, also stamped in the same minute, and a following drop reconcile the action: no second enqueue, the drop counted once", async (t) => {
  for (const stamp of [undefined, "Sep 29, 7:00 AM UTC"]) {
    const h = harness(t);
    h.github.view = READY;
    // An earlier conflict-only round, claimed already, at the very minute of the enqueue.
    const bullets = bulletsOf(h, { stamp }, QUEUED, CONFLICT);
    const earlier = activityBullets(h.github.view.mergeActivity).at(-1)?.text ?? "";
    await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, conflicts: [earlier] } });
    h.scripts.onEnqueue = async () => bullets.add(QUEUED);
    h.scripts.ready = { stacks: [STACK], drops: [] };
    const stop = hang();
    h.scripts.answered = stop.point;
    void h.backstop();
    await stop.reached;
    h.scripts.answered = async () => {};
    bullets.add(running(437), REMOVED);
    h.github.drafts = [draft(437, [419])];
    await h.restart();
    assert.match(promptOf(await h.poll()) ?? "", /This is genuine drop 1 of this range/, String(stamp));
    const calls = await h.backstop();
    assert.equal(count(calls, "enqueue "), 0, `${stamp}: reconciled as enqueued`);
    assert.equal(count(calls, `comment ${ENQUEUED}`), 1, `${stamp}: its ticket comment`);
    assert.deepEqual(await h.poll(), [], `${stamp}: the drop is counted once`);
    assert.deepEqual(await h.backstop(), [], String(stamp));
    assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419`], `${stamp}: the genuine drop blocks the range`);
  }
});

test("after a restart, a rewritten Merge activity comment cannot tell whether the enqueue went through: no retry, the agent is asked to check", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  const bullets = bulletsOf(h, {}, QUEUED, CONFLICT);
  const earlier = activityBullets(h.github.view.mergeActivity).at(-1)?.text ?? "";
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, conflicts: [earlier] } });
  h.scripts.ready = { stacks: [STACK], drops: [] };
  const stop = hang();
  h.scripts.answered = stop.point;
  void h.backstop();
  await stop.reached;
  h.scripts.answered = async () => {};
  bullets.replace(activity(QUEUED));
  await h.restart();
  assert.deepEqual(await h.backstop(), []);
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419 --skip ${STACK.action}`], "not retried");
  assert.match(promptOf(await h.poll()) ?? "", /cannot tell whether the range was enqueued\. Paseo does not retry it\. Check with `node tools\/ci\/wait-queue\.mjs 419 --last`/);
  assert.deepEqual(await h.backstop(), []);
  assert.deepEqual(await h.poll(), [], "routed once");
});

test("after a restart that came after the landing, the enqueue's comments still go out, once", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  const bullets = bulletsOf(h);
  h.scripts.onEnqueue = async () => bullets.add(QUEUED);
  h.scripts.enqueue = [{ code: 0, answer: { result: "enqueued", comment: "none" } }];
  h.scripts.ready = { stacks: [STACK], drops: [] };
  const stop = hang();
  h.scripts.answered = stop.point;
  void h.backstop();
  await stop.reached;
  h.scripts.answered = async () => {};
  bullets.add(running(437), `Merged by the [Graphite merge queue](https://app.graphite.com/merges) via draft PR: ${graphiteLink(437)}.`);
  h.github.view = { ...h.github.view, state: "CLOSED", labels: ["externally-merged"] };
  await h.restart();
  const calls = [...await h.backstop(), ...await h.backstop()];
  assert.equal(count(calls, "enqueue "), 0);
  assert.equal(count(calls, `pr comment #419 ${ENQUEUED}`), 1);
  assert.equal(count(calls, `comment ${ENQUEUED}`), 1);
});

// The agent enqueued the range first: the backstop's enqueue is held while it is queued.
const QUEUED_ALREADY = { code: 3, answer: { result: "held", problems: [{ kind: "queued", text: "the range is in the merge queue" }] } };

test("a held enqueue is not retried after the round someone else queued dropped genuinely, whether the poll or the backstop claims that drop first", async (t) => {
  for (const claimer of ["poll", "backstop"] as const) {
    const h = harness(t);
    h.github.view = READY;
    const bullets = bulletsOf(h, {}, QUEUED);
    h.scripts.ready = { stacks: [STACK], drops: [] };
    h.scripts.enqueue = [QUEUED_ALREADY, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
    assert.equal(count(await h.backstop(), "enqueue "), 1, claimer);
    bullets.add(running(437), REMOVED);
    h.github.drafts = [draft(437, [419])];
    if (claimer === "poll") assert.match(promptOf(await h.poll()) ?? "", /2\. Fix the cause\./, claimer);
    assert.equal(count(await h.backstop(), "enqueue "), 0, `${claimer}: the range that failed is not enqueued again`);
    assert.deepEqual(h.scripts.runs.filter((run) => !run.startsWith(WAIT_QUEUE)), [`${READY_RUN} --exclude 419`], `${claimer}: blocked at its head`);
    if (claimer === "backstop") assert.match(promptOf(await h.poll()) ?? "", /2\. Fix the cause\./, "the backstop's claim goes to the agent");
    assert.equal(count(await h.backstop(), "enqueue "), 0, `${claimer}: nor later`);
  }
});

test("a held enqueue of a stack waits while the round someone queued for its lower pull request alone is not judged, and is not retried after it dropped genuinely", async (t) => {
  for (const judged of ["at once", "a run later"] as const) {
    const h = harness(t);
    h.github.view = READY;
    // Someone enqueued #419 alone; #1501 above it shows no activity of its own.
    const bullets = bulletsOf(h, {}, QUEUED);
    const step2 = { ...READY, headSha: "5e5e5e5", headBranch: "mtuchel/tuc-1-b", baseBranch: "mtuchel/tuc-1-fix" };
    h.github.open = [listed(prUrl(1501), step2, "Add TUC-1 [plugin] Step two")];
    h.github.views[prUrl(1501)] = step2;
    h.scripts.ready = { stacks: [{ action: `ready:1501@${HEAD},5e5e5e5`, top: 1501, branch: "mtuchel/tuc-1-b", prs: [419, 1501], expect: `419@${HEAD},1501@5e5e5e5`, tickets: ["TUC-1"], result: "candidate" }], drops: [] };
    h.scripts.enqueue = [QUEUED_ALREADY, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
    assert.equal(count(await h.backstop(), "enqueue "), 1, judged);
    // #419's round drops before any poll saw it.
    bullets.add(running(437), REMOVED);
    h.github.drafts = [draft(437, [419])];
    if (judged === "a run later") {
      h.scripts.judgment = null;
      assert.equal(count(await h.backstop(), "enqueue "), 0, "the round is not judged yet: the action waits");
      assert.deepEqual(h.scripts.runs.filter((run) => !run.startsWith(WAIT_QUEUE)), [`${READY_RUN} --exclude 419 --exclude 1501`], "and keeps its range out of the ready run");
      h.scripts.judgment = GENUINE;
    }
    assert.equal(count(await h.backstop(), "enqueue "), 0, `${judged}: the range whose lower pull request failed is not enqueued again`);
    assert.deepEqual(h.scripts.runs.filter((run) => !run.startsWith(WAIT_QUEUE)), [`${READY_RUN} --exclude 419`], `${judged}: #419 is blocked at its head`);
    assert.match(promptOf(await h.poll()) ?? "", /2\. Fix the cause\./, `${judged}: the backstop's claim goes to the agent`);
    assert.equal(count(await h.backstop(), "enqueue "), 0, `${judged}: nor later`);
  }
});

test("a held enqueue waits while a manual task due before the merge opened meanwhile, or cannot be read, and is enqueued once it is done", async (t) => {
  for (const gate of ["open", "unreadable"] as const) {
    const h = harness(t);
    h.github.view = READY;
    h.scripts.ready = { stacks: [STACK], drops: [] };
    h.scripts.enqueue = [{ code: 3, answer: { result: "held", problems: [{ kind: "main-red", text: "main is red" }] } }, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
    assert.equal(count(await h.backstop(), "enqueue "), 1, gate);
    if (gate === "open") h.blockers.push("TUC-9");
    else h.gate.unreadable = true;
    for (let run = 0; run < 2; run++) {
      assert.deepEqual(await h.backstop(), [], `${gate}: run ${run}`);
      assert.deepEqual(h.scripts.runs, [`${READY_RUN} --exclude 419`], `${gate}: run ${run}`);
    }
    h.blockers.length = 0;
    h.gate.unreadable = false;
    const done = await h.backstop();
    assert.equal(count(done, "enqueue "), 1, gate);
    assert.equal(count(done, `pr comment #419 ${ENQUEUED}`), 1, gate);
  }
});

test("a held enqueue a newer round superseded is retired: only the drop's own re-enqueue runs", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  const bullets = bulletsOf(h, {}, QUEUED);
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [QUEUED_ALREADY, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
  h.scripts.onEnqueue = async () => bullets.add(QUEUED);
  await h.backstop();
  bullets.add(running(437), REMOVED);
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = FLAKY;
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual((await h.backstop()).filter((call) => call.startsWith("enqueue ")), [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action drop:#437:419`]);
  assert.equal(count(await h.backstop(), "enqueue "), 0);
});

test("one queue draft that tested two independent stacks gives each its own re-enqueue", async (t) => {
  const h = harness(t);
  const dropped = activity(QUEUED, running(450), REMOVED);
  const other = { ...READY, headSha: "6a6a6a6", headBranch: "mtuchel/other", mergeActivity: dropped };
  h.github.view = { ...READY, mergeActivity: dropped };
  h.github.views[prUrl(1600)] = other;
  h.github.open = [listed(prUrl(1600), other, "Bump the upload library")];
  h.github.drafts = [draft(450, [419, 1600])];
  h.scripts.judgments = {
    419: { ...FLAKY, revision: { ...SAME, draft: 450 } },
    1600: { ...FLAKY, revision: { ...SAME, draft: 450, branch: "mtuchel/other", expect: "1600@6a6a6a6" } },
  };
  h.scripts.ready = { stacks: [], drops: [{ pr: 1600, draft: 450, key: "#450", revision: null }] };
  assert.deepEqual(await h.poll(), []);
  const enqueues = [...await h.backstop(), ...await h.backstop()].filter((call) => call.startsWith("enqueue "));
  assert.deepEqual(enqueues, [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action drop:#450:419`, "enqueue mtuchel/other --expect 1600@6a6a6a6 --action drop:#450:1600"]);
  assert.match(h.github.comments[1600][0], /<!-- queue-backstop:drop:#450:1600 -->$/);
});

test("a range member's plain drop escalates nothing: the next drop is handled like any other, and an escalated member still holds the range (AC-1, AC-6)", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const step2 = { ...READY, headSha: "5e5e5e5", headBranch: "mtuchel/tuc-1-b", baseBranch: "mtuchel/tuc-1-fix", mergeActivity: activity(QUEUED, running(437), REMOVED) };
  // One earlier plain drop of another member: the range's flaky drop is re-enqueued like the first.
  const counted = harness(t);
  counted.github.open = [listed(prUrl(1501), step2, "Add TUC-1 [plugin] Step two")];
  counted.github.views[prUrl(1501)] = step2;
  await counted.state({ [prUrl(1501)]: { reviewedAt: null, decision: null, merged: false, drops: ["#436"] } });
  counted.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  counted.github.drafts = [draft(437, [419, 1501])];
  counted.scripts.judgment = { ...FLAKY, revision: { ...SAME, branch: "mtuchel/tuc-1-b", expect: `419@${HEAD},1501@5e5e5e5` } };
  assert.deepEqual(await counted.poll(), [], "nothing for the agent: the drop was not the stack's fault");
  assert.equal(count(await counted.backstop(), "enqueue "), 1, "the range is enqueued again, whatever the member's count");
  // A member escalated after it waited out the owner's answer holds the whole range, as before.
  const escalated = harness(t);
  escalated.github.open = [listed(prUrl(1501), step2, "Add TUC-1 [plugin] Step two")];
  escalated.github.views[prUrl(1501)] = step2;
  await escalated.state({ [prUrl(1501)]: { reviewedAt: null, decision: null, merged: false, escalated: true } });
  escalated.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  escalated.github.drafts = [draft(437, [419, 1501])];
  escalated.scripts.judgment = { ...FLAKY, revision: { ...SAME, branch: "mtuchel/tuc-1-b", expect: `419@${HEAD},1501@5e5e5e5` } };
  assert.deepEqual(await escalated.poll(), []);
  assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /whose range escalated to the owner already/);
  assert.equal(count(await escalated.backstop(), "enqueue "), 0);
  assert.deepEqual(escalated.scripts.runs, [`${READY_RUN} --exclude 419 --exclude 1501`], "the whole range stays out");
});

test("two plain drops from before drops had kinds, without the escalation flag, escalate nothing: the next drop goes to the agent (AC-1, AC-6)", async (t) => {
  const h = harness(t);
  const step2 = { ...READY, headSha: "5e5e5e5", headBranch: "mtuchel/tuc-1-b", baseBranch: "mtuchel/tuc-1-fix" };
  h.github.open = [listed(prUrl(1501), step2, "Add TUC-1 [plugin] Step two")];
  h.github.views[prUrl(1501)] = step2;
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, drops: ["#435", "#436"] } });
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  h.github.drafts = [draft(437, [419, 1501])];
  h.scripts.judgment = { ...FLAKY, revision: { state: "unknown", reason: "no queue draft" } };
  const prompt = promptOf(await h.poll()) ?? "";
  assert.match(prompt, /Drops of this range so far: 3 plain, 0 conflict-only, 0 main-broken\./);
  assert.match(prompt, /Re-enqueue the dropped queue range from its top branch/);
  assert.doesNotMatch(prompt, /take over|next plain drop goes to the owner/);
});

test("the ticket comment of an enqueue is looked up by its mark before it goes out: a lost answer never doubles it, and one that never went out is posted after a restart", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const failure of ["lost answer", "crash before it went out"] as const) {
    const h = harness(t);
    h.github.view = READY;
    h.scripts.ready = { stacks: [STACK], drops: [] };
    if (failure === "lost answer") {
      h.linear.lost = true;
      await h.backstop();
      h.linear.lost = false;
    } else {
      const stop = hang();
      h.linear.arrive = stop.point;
      void h.backstop();
      await stop.reached;
      h.linear.arrive = async () => {};
    }
    await h.restart();
    await h.backstop();
    await h.backstop();
    assert.equal(h.linear.comments.i1?.length, 1, failure);
    assert.match(h.linear.comments.i1?.[0] ?? "", /^Paseo's queue backstop enqueued [^]*\n\n`queue-backstop:ready:419@a1b2c3d4e5f6`$/, failure);
  }
});

test("the ticket comment of an enqueue is found only by its whole mark: another action's mark that starts with it does not count", async (t) => {
  const h = harness(t);
  const bullets = bulletsOf(h, {}, QUEUED, running(5000), REMOVED);
  h.github.drafts = [draft(5000, [419])];
  h.scripts.judgment = { ...FLAKY, revision: { ...SAME, draft: 5000 } };
  h.scripts.onEnqueue = async () => bullets.add(QUEUED);
  const other = "Paseo's queue backstop enqueued [#4190](https://github.com/tuchel-sohn/tuchel-platform/pull/4190) through `tools/ci/enqueue.mjs`.\n\n`queue-backstop:drop:#5000:4190`";
  h.linear.comments.i1 = [other];
  assert.deepEqual(await h.poll(), []);
  assert.equal(count(await h.backstop(), `comment ${ENQUEUED}`), 1);
  assert.equal(h.linear.comments.i1.length, 2);
  assert.match(h.linear.comments.i1[1], /^Paseo's queue backstop enqueued \[#419\][^]*\n\n`queue-backstop:drop:#5000:419`$/);
  assert.deepEqual(await h.backstop(), [], "once");
});

test("a queue-tip conflict's draft is read by its number: still open but out of Graphite's listing, or unreadable, it holds the refusal", async (t) => {
  const h = harness(t);
  t.mock.method(console, "error", () => {});
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-tip", draft: 900, text: "conflicts with the queue tip" }] } }, { code: 0, answer: { result: "enqueued", comment: "posted" } }];
  await h.backstop();
  await h.poll();
  // Thirty newer drafts pushed #900 out of Graphite's listing.
  h.github.drafts = [];
  h.github.states[900] = "open";
  assert.deepEqual(await h.backstop(), [], "still open");
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --skip ${STACK.action}`], "still open");
  h.github.unreadable = [900];
  assert.deepEqual(await h.backstop(), [], "unreadable");
  assert.deepEqual(h.scripts.runs, [`${READY_RUN} --skip ${STACK.action}`], "unreadable");
  h.github.unreadable = [];
  h.github.states[900] = "closed";
  assert.equal(count(await h.backstop(), "enqueue "), 1, "closed: retried");
});

test("a drop claimed while its pull request still holds an earlier message is queued behind it, and both go out once", async (t) => {
  const h = harness(t);
  h.github.open = [listed(prUrl(1700), { ...OPEN_PR, headSha: "7a7a7a7", headBranch: "mtuchel/bump" }, "Bump the upload library")];
  h.github.drafts = [draft(450, [1700])];
  await h.state({ [prUrl(1700)]: { reviewedAt: null, decision: null, merged: false, pending: { key: "refused:earlier", reason: "an earlier refusal", facts: "Earlier message.", fix: "Earlier message.", orphan: { tickets: [] } } } });
  h.scripts.ready = { stacks: [], drops: [{ pr: 1700, draft: 450, key: "#450", revision: null }] };
  assert.deepEqual(firstLines(await h.backstop()), ["pr comment #1700 Earlier message.", `pr comment #1700 The Graphite merge queue dropped [the pull request](${prUrl(1700)}) without merging it.`]);
  assert.match(h.github.comments[1700][1], /2\. Fix the cause\.[^]*<!-- queue-backstop:route:#450 -->$/);
  assert.deepEqual(await h.backstop(), [], "each once");
});

test("a crashed agent is restarted at once, then after its backoff, and the crash after three restarts starts a successor", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { crash: true, autoResume: true });
  h.paseo.succeed = startSuccessor;
  h.records[0] = { ...h.records[0], branch: "mtuchel/tuc-1-fix" };
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.daemon.agent = RESTARTED;
  const first = await h.poll();
  assert.ok((promptOf(first) ?? "").endsWith(`\n\n${NUDGE_CLOSE}`));
  assert.ok(!first.includes("reload a1"), "a healthy agent is nudged as before");
  assert.deepEqual(await h.poll(), [], "a healthy agent is not nudged twice on one head");
  h.daemon.agent = CRASHED;
  const restarted = await h.poll();
  assert.deepEqual(restarted.filter((call) => !call.startsWith("prompt")), ["reload a1", `say thought The agent had crashed (${CRASH}); Paseo restarted it and asked it to resume and continue the step it was on.`]);
  const resume = promptOf(restarted) ?? "";
  assert.match(resume, /^Your previous run crashed \(`OMP RPC process is closed`\), and Paseo restarted you\./);
  assert.match(resume, /run `git status`/);
  assert.match(resume, /\n\nYour ticket TUC-1 is in In Progress\. Continue the lifecycle step you were on\.$/);
  assert.equal(restarted.filter((call) => call.startsWith("prompt")).length, 1, "the nudge does not follow in the same poll");
  assert.equal(JSON.parse(await h.crashFile()).a1.restarts, 1);

  // The second restart waits its backoff (2 minutes), with no message and no owner mention.
  h.daemon.agent = CRASHED;
  const waited = await h.poll();
  assert.ok(!waited.includes("reload a1"), "the second restart waits for the backoff");
  assert.ok(!waited.some((call) => call.startsWith("comment")), "no restart count mentions the owner");
  h.scripts.now += 2 * MINUTE;
  assert.ok((await h.poll()).includes("reload a1"), "the second restart after its backoff");
  assert.equal(JSON.parse(await h.crashFile()).a1.restarts, 2);
  // The third waits longer (4 minutes after the second), then goes the same way.
  h.daemon.agent = CRASHED;
  h.scripts.now += 2 * MINUTE;
  assert.ok(!(await h.poll()).includes("reload a1"), "the third restart waits its longer backoff");
  h.scripts.now += 2 * MINUTE;
  assert.ok((await h.poll()).includes("reload a1"), "the third restart after its backoff");
  assert.equal(JSON.parse(await h.crashFile()).a1.restarts, 3);

  // The crash after three restarts starts a successor whose lead is the pending resume.
  h.daemon.agent = CRASHED;
  const succeeded = await h.poll();
  assert.match(succeeded[0], /^succeed a1\nYour previous run crashed \(`OMP RPC process is closed`\), and Paseo restarted you\.[\s\S]*Continue the lifecycle step you were on\.$/);
  assert.equal(succeeded[1], `say thought The agent crashed 3 times in all; Paseo started a successor (agent s2a2b3c4) and asked it to resume and continue the step it was on.`);
  assert.equal(h.records[0].agentId, SUCCESSOR.id, "the record names the successor");
  assert.ok(JSON.parse(await h.crashFile()).a1.successor, "marked: this session is never restarted again");
  h.daemon.agent = RESTARTED;
  assert.deepEqual(await h.poll(), [], "no restart, no owner comment, no further message");
});

test("a crashed agent whose restart fails is sent nothing, and the attempt counts", async (t) => {
  const h = harness(t, { crash: true });
  t.mock.method(console, "error", () => {});
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.daemon.reloaded = CRASHED;
  assert.deepEqual(await h.poll(), ["reload a1", `say thought The agent had crashed (${CRASH}), and Paseo's restart failed; the next one waits for its backoff.`]);
  assert.equal(JSON.parse(await h.crashFile()).a1.restarts, 1);
  h.daemon.reloaded = RESTARTED;
  h.scripts.now += 2 * MINUTE;
  const second = await h.poll();
  assert.equal(second[0], "reload a1", "the second restart, after its backoff");
  assert.match(promptOf(second) ?? "", /Continue the lifecycle step you were on\.$/);
  assert.equal(JSON.parse(await h.crashFile()).a1.restarts, 2);
});

test("a crash only a person can fix gets one owner mention naming it and no restart loop", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { crash: true });
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.daemon.agent = { status: "error", lastError: "OMP RPC process exited with code 1: invalid API key for provider anthropic", pendingPermissions: [] };
  const calls = await h.poll();
  assert.ok(!calls.includes("reload a1"), "no restart clears this");
  const comments = calls.filter((call) => call.startsWith("comment "));
  assert.equal(comments.length, 1);
  assert.match(comments[0], /cannot run until the host's setup is fixed/);
  assert.match(comments[0], /invalid API key for provider anthropic/, "the comment names exactly what to fix");
  assert.equal(JSON.parse(await h.crashFile()).a1.restarts, undefined, "it never counts as a restart");
  assert.ok(JSON.parse(await h.crashFile()).a1.setup, "the crash is held until it changes");
  assert.ok(!(await h.poll()).some((call) => call.startsWith("reload") || call.startsWith("comment")), "told once: no restart loop");
  await h.restart();
  assert.ok(!(await h.poll()).some((call) => call.startsWith("reload") || call.startsWith("comment")), "also after a plugin restart");
  // The agent crashes differently now: handled like any other crash.
  h.daemon.agent = CRASHED;
  assert.ok((await h.poll()).includes("reload a1"), "a new crash is restarted as usual");
});

test("a crash with a generic denial a tool or file also raises is restarted, not handed to the owner", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { crash: true });
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.daemon.agent = { status: "error", lastError: "OMP RPC process exited with code 1: EACCES: permission denied, open '/repo/.git/index.lock' (403 Forbidden)", pendingPermissions: [] };
  const calls = await h.poll();
  assert.ok(calls.includes("reload a1"), "a restart can clear it");
  assert.ok(!calls.some((call) => call.startsWith("comment")), "no owner mention");
  assert.equal(JSON.parse(await h.crashFile()).a1.setup, undefined);
});

test("a crash that names a usage limit is never restarted and never counts: the limit resume owns it", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { crash: true });
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.daemon.agent = { status: "error", lastError: "OMP RPC process exited with code 1 (usage limit retry-after: 3600 model=anthropic/claude-opus-5-5)", pendingPermissions: [] };
  const calls = await h.poll();
  assert.ok(!calls.includes("reload a1"), "the limit-resume handling starts a new agent at the reset");
  assert.ok(!calls.some((call) => call.startsWith("comment")), "no owner mention");
  const saved = JSON.parse(await h.crashFile());
  assert.equal(saved.a1.restarts, undefined, "a usage limit never counts as a restart");
  assert.match(saved.a1.limit, /usage limit/);
  assert.ok(!(await h.poll()).some((call) => call.startsWith("reload") || call.startsWith("comment")), "left to the limit resume");
});

test("a resume that did not go out after the restart is sent on a later poll, also after a plugin restart, and cleared only once sent", async (t) => {
  const h = harness(t, { crash: true });
  t.mock.method(console, "error", () => {});
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.daemon.reloaded = { ...RESTARTED, status: "running" };
  assert.deepEqual(await h.poll(), ["reload a1", `say thought The agent had crashed (${CRASH}); Paseo restarted it, and asks it to resume once it takes a message.`]);
  await h.restart();
  h.daemon.agent = RESTARTED;
  h.daemon.send = async () => { throw new Error("connection lost"); };
  assert.deepEqual(await h.poll(), [], "the send failed: kept");
  h.daemon.send = async () => {};
  const saved = await h.crashFile();
  const sent = await h.poll();
  assert.match(promptOf(sent) ?? "", /^Your previous run crashed[\s\S]*Continue the lifecycle step you were on\.$/);
  assert.ok(sent.includes("say thought Paseo sent the restarted agent its resume."));
  assert.ok(!(await h.poll()).some((call) => call.includes("Your previous run crashed")), "sent once");
  // The plugin stopped after the send, before the resume was cleared: it goes out once more.
  await h.crashFile(saved);
  await h.restart();
  assert.match(promptOf(await h.poll()) ?? "", /^Your previous run crashed/);
});

test("a drop's fix request for an agent whose crash reached the successor path goes to the ticket, and its resume is never sent later", async (t) => {
  const h = harness(t, { crash: true });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  await h.crashFile(JSON.stringify({ a1: { restarts: STAGE_NUDGES, restartedAt: new Date(h.scripts.now).toISOString() } }));
  await h.restart();
  const first = await h.poll();
  assert.ok(!first.includes("reload a1"), "three restarts in all: the session is not reloaded again");
  assert.ok(first.includes("move In Progress"));
  assert.ok(first.some((call) => call.startsWith(`comment ${OWNER} The agent that worked on this ticket is no longer running`)), "no successor can start: the ticket is handed back");
  assert.ok(JSON.parse(await h.crashFile()).a1.successor, "marked: it is never restarted again");
  // The drop fix follows on the next poll, to the ticket.
  const next = await h.poll();
  assert.ok(next.includes("move In Progress"));
  assert.ok(next.some((call) => call.startsWith(`comment ${OWNER} The agent that worked on this ticket is no longer running`)));
  assert.ok(!next.some((call) => call.startsWith("prompt")), "never sent to the crashed agent's session");
});

test("a pending resume is dropped unsent once its ticket is no longer started or another agent took the ticket over", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const change of ["completed", "successor"] as const) {
    const h = harness(t, { crash: true });
    h.github.view = { ...READY, checks: [failing("PR code")] };
    h.daemon.reloaded = { ...RESTARTED, status: "running" };
    await h.poll();
    if (change === "completed") {
      // Done and its stack landed (no open pull request): the ticket stays Done, so the resume no
      // longer applies. Done with open pull requests is reopened instead (see the stack policy
      // tests), which is what keeps a resume for such a ticket pending.
      h.linear.state = { status: "Done", statusType: "completed" };
      h.records[0] = { ...h.records[0], links: {} };
    } else h.records[0] = { ...h.records[0], agentId: "a2" };
    h.daemon.agent = RESTARTED;
    assert.ok(!(await h.poll()).some((call) => call.includes("Your previous run crashed")), change);
    assert.equal(JSON.parse(await h.crashFile()).a1.resume, null, change);
  }
});

test("a crashed agent without an open pull request is restarted while its ticket is started, and after three restarts a successor takes over or the ticket goes back", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  for (const pull of ["never linked", "closed"] as const) {
    const h = harness(t, { crash: true });
    if (pull === "never linked") h.records[0] = { ...h.records[0], links: {} };
    else h.github.view = { ...OPEN_PR, state: "CLOSED" };
    const first = await h.poll();
    assert.ok(first.includes("reload a1"), pull);
    assert.match(promptOf(first) ?? "", /\n\nYour ticket TUC-1 is in In Progress\. Continue the lifecycle step you were on\.$/, pull);
    assert.equal(JSON.parse(await h.crashFile()).a1.restarts, 1, pull);
    // Three restarts in all: the crash after them is the successor path's (no branch is recorded
    // here, so no successor can start and the ticket goes back).
    await h.crashFile(JSON.stringify({ a1: { ...JSON.parse(await h.crashFile()).a1, restarts: STAGE_NUDGES } }));
    h.daemon.agent = CRASHED;
    await h.restart();
    const handed = await h.poll();
    assert.ok(!handed.includes("reload a1"), `${pull}: the session is not reloaded again`);
    assert.ok(handed.includes("move In Progress"), pull);
    assert.ok(handed.some((call) => call.startsWith(`comment ${OWNER} The agent that worked on this ticket is no longer running`)), pull);
    await h.restart();
    assert.deepEqual(await h.poll(), [], `${pull}: then nothing`);
  }
});

test("a hand-back whose owner comment failed is tried again on the next poll", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const h = harness(t, { crash: true });
  h.records[0] = { ...h.records[0], links: {} };
  await h.crashFile(JSON.stringify({ a1: { restarts: STAGE_NUDGES } }));
  await h.restart();
  h.linear.arrive = async () => { throw new Error("Linear is unavailable"); };
  assert.ok(!(await h.poll()).some((call) => call.startsWith("comment")), "the comment failed");
  assert.ok(!JSON.parse(await h.crashFile()).a1.successor, "the mark goes, so the pass tries again");
  h.linear.arrive = async () => {};
  assert.ok((await h.poll()).some((call) => call.startsWith(`comment ${OWNER} The agent that worked on this ticket is no longer running`)), "retried");
  assert.deepEqual(await h.poll(), [], "then nothing");
});

test("the crash cutover clears an old owner escalation, so the agent is restarted again under the new rule", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { crash: true });
  h.github.view = { ...READY, checks: [failing("PR code")] };
  await h.crashFile(JSON.stringify({ a1: { restarts: 2, escalated: true, resume: null, error: CRASH } }));
  await h.restart();
  const calls = await h.poll();
  assert.ok(calls.includes("reload a1"), "the old cap's hand-over is cleared: the agent is restarted");
  assert.ok(!calls.some((call) => call.startsWith("comment")), "no owner mention");
  const saved = JSON.parse(await h.crashFile());
  assert.equal(saved.a1.escalated, undefined, "the flag is gone from the state file");
  assert.equal(saved.a1.restarts, 3, "the restarts stay, so the next crash starts a successor");
});

test("without an open pull request, a healthy agent or a ticket that is not started is left alone", async (t) => {
  for (const [agent, statusType] of [[RESTARTED, "started"], [CRASHED, "completed"]] as const) {
    const h = harness(t, { crash: true });
    h.records[0] = { ...h.records[0], links: {} };
    h.daemon.agent = agent;
    h.linear.state = { status: statusType === "started" ? "In Progress" : "Done", statusType };
    assert.deepEqual(await h.poll(), [], statusType);
  }
});

// TUC-1684: the crash pass's ticket check falls back from a fresh read (either pool) to the state
// Paseo last saw (known-states.json), and only with neither does the agent wait for the next poll.
const REFUSED = () => new RateLimitedError("key", Date.now() + 60_000, "reserve");

test("with Linear refusing both pools, a crashed agent is restarted on the stored state, also after a plugin restart, and told to check its ticket first", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness(t, { crash: true });
  h.records[0] = { ...h.records[0], links: {} };
  h.daemon.agent = RESTARTED;
  assert.deepEqual(await h.poll(), [], "a healthy agent is left alone");
  assert.deepEqual(h.linear.stateReads, [["i1"]], "one batch per poll keeps the running tickets' states known");
  await h.restart();
  h.linear.issueFailure = REFUSED();
  h.linear.statesFailure = REFUSED();
  h.daemon.agent = CRASHED;
  const calls = await h.poll();
  assert.ok(calls.includes("reload a1"));
  const resume = promptOf(calls) ?? "";
  assert.match(resume, /^Paseo could not read this ticket's Linear state just now and restarted you on the state it last saw \(In Progress, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)\. First check the ticket's state with the linear_ticket tool get_ticket\. If it is Done or Canceled \(or marked a duplicate\), stop\./);
  assert.match(resume, /\n\nYour previous run crashed \(`OMP RPC process is closed`\)[\s\S]*Your ticket TUC-1 is in In Progress\. Continue the lifecycle step you were on\.$/);
  assert.doesNotMatch(JSON.parse(await h.crashFile()).a1.resume?.text ?? "", /could not read this ticket/, "the line is added at send time, never stored");
});

test("a stored Done is not restarted while Linear refuses both pools, and a ticket with no stored state waits, logged once, until a check succeeds", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const done = harness(t, { crash: true });
  done.records[0] = { ...done.records[0], links: {} };
  done.daemon.agent = RESTARTED;
  done.linear.state = { status: "Done", statusType: "completed" };
  await done.poll();
  done.linear.issueFailure = REFUSED();
  done.linear.statesFailure = REFUSED();
  done.daemon.agent = CRASHED;
  assert.ok(!(await done.poll()).includes("reload a1"), "the stored Done holds");

  const unknown = harness(t, { crash: true });
  unknown.records[0] = { ...unknown.records[0], links: {} };
  unknown.linear.issueFailure = REFUSED();
  unknown.linear.statesFailure = REFUSED();
  assert.ok(!(await unknown.poll()).includes("reload a1"));
  assert.ok(!(await unknown.poll()).includes("reload a1"));
  assert.equal(errors.mock.calls.filter((call) => /TUC-1: Linear refuses the ticket check and its state is not known yet, so agent a1 is not restarted/.test(String(call.arguments[0]))).length, 1);
  unknown.linear.issueFailure = null;
  const restarted = await unknown.poll();
  assert.ok(restarted.includes("reload a1"));
  assert.doesNotMatch(promptOf(restarted) ?? "", /could not read this ticket/, "a fresh read needs no check-first line");
});

test("a saved resume, also one saved before this line existed, is sent with the check-first line when only the stored state is known", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness(t, { crash: true });
  h.records[0] = { ...h.records[0], links: {} };
  await writeFile(join(await h.home(), "known-states.json"), JSON.stringify({ i1: { name: "In Review", type: "started", at: Date.parse("2026-10-09T05:00:00Z") } }));
  await h.crashFile(JSON.stringify({ a1: { restarts: 1, resume: { text: "Your previous run crashed (`boom`), and Paseo restarted you.\n\nOld step.", issueId: "i1" } } }));
  await h.restart();
  h.linear.issueFailure = REFUSED();
  h.linear.statesFailure = REFUSED();
  h.daemon.agent = RESTARTED;
  const sent = promptOf(await h.poll()) ?? "";
  assert.match(sent, /^Paseo could not read this ticket's Linear state just now and restarted you on the state it last saw \(In Review, 2026-10-09 05:00 UTC\)\./);
  assert.match(sent, /\n\nYour previous run crashed \(`boom`\), and Paseo restarted you\.\n\nOld step\.$/);
  assert.equal(JSON.parse(await h.crashFile()).a1.resume, null, "cleared once sent");
});

test("a refused Linear call for one crashed agent does not stop the crash pass for the next", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const h = harness(t, { crash: true });
  h.records[0] = { ...h.records[0], links: {} };
  h.records.push({ ...h.records[0], issueId: "i2", identifier: "TUC-2", agentId: "a2", worktreePath: "/wt/tuc-2" });
  await h.crashFile(JSON.stringify({ a1: { restarts: STAGE_NUDGES } }));
  await h.restart();
  h.linear.arrive = async () => { throw REFUSED(); };
  const calls = await h.poll();
  assert.ok(!calls.includes("reload a1"), "a1's three restarts went to the successor path");
  assert.ok(calls.includes("reload a2"), "a2 is restarted although a1's hand-back comment was refused");
  assert.ok(!JSON.parse(await h.crashFile()).a1.successor, "a1's mark goes, so the hand-back is retried on the next poll");
});

test("a crashed agent with a stalled pull request that the ticket check or the successor path held back is not reloaded by its nudge in the same poll", async (t) => {
  t.mock.method(console, "error", () => {});
  const unknown = harness(t, { crash: true });
  unknown.github.view = { ...READY, checks: [failing("PR code")] };
  unknown.linear.issueFailure = REFUSED();
  unknown.linear.statesFailure = REFUSED();
  assert.ok(!(await unknown.poll()).includes("reload a1"), "no known state: the nudge waits with the crash pass");

  const succeeded = harness(t, { crash: true });
  succeeded.github.view = { ...READY, checks: [failing("PR code")] };
  await succeeded.crashFile(JSON.stringify({ a1: { restarts: STAGE_NUDGES } }));
  await succeeded.restart();
  succeeded.linear.arrive = async () => { throw REFUSED(); };
  assert.ok(!(await succeeded.poll()).includes("reload a1"), "a refused hand-back comment does not let the nudge reload it again");
  assert.equal(JSON.parse(await succeeded.crashFile()).a1.restarts, STAGE_NUDGES, "and no restart is counted");
});

// ---- The cheap first look (ConditionalPullView): conditional REST requests per pull request (read
// as an issue, plus its comments, reviews and the head's checks) decide whether the one GraphQL query
// per pull request and poll (`viewPullRequest`) is needed at all. A 304 costs no budget, so a quiet
// pull request is free. The single-`pulls/{n}` endpoint is not used: its ETag moves every request. ---
const REPO = "tuchel-sohn/tuchel-platform";
const ISSUE_PATH = `repos/${REPO}/issues/419`;
const COMMENTS_PATH = `${ISSUE_PATH}/comments?per_page=100`;
const REVIEWS_PATH = `repos/${REPO}/pulls/419/reviews?per_page=100`;

// A fake GitHub REST: each path carries an ETag that `bump` moves, and a body from `seed`. A request
// that repeats the current ETag is answered 304, as GitHub answers an unchanged resource.
type RestStub = {
  calls: { path: string; etag: string | null }[];
  get: (path: string, etag: string | null) => Promise<{ status: number; headers: Map<string, string>; body: string }>;
  bump: (path: string) => void;
};

function restFake(seed: (path: string) => unknown): RestStub {
  const versions = new Map<string, number>();
  const calls: RestStub["calls"] = [];
  const get = async (path: string, etag: string | null) => {
    calls.push({ path, etag });
    const etagFor = `"${path}#${versions.get(path) ?? 0}"`;
    const headers = new Map([["etag", etagFor]]);
    if (etag === etagFor) return { status: 304, headers, body: "" };
    return { status: 200, headers, body: JSON.stringify(seed(path)) };
  };
  return { calls, get, bump: (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1) };
}

const checkBody = (conclusion: string) => ({ total_count: 1, check_runs: [{ name: "Code validation / Core (core-web)", status: "completed", conclusion, started_at: "2026-10-04T21:00:00Z", completed_at: "2026-10-04T21:05:00Z" }] });
const NO_STATUSES = { total_count: 0, statuses: [] };
// A pull request read as an issue: state, labels, the last change of any kind, and the merge. A push
// moves `updated_at` too, which is what tells the probe a head changed; the detail read then knows it.
const issueBody = (updatedAt: string, state = "open") => ({ state, updated_at: updatedAt, labels: [], pull_request: { merged_at: null } });
const checkRunsPath = (sha: string) => `repos/${REPO}/commits/${sha}/check-runs?per_page=100`;
// What one probe test moves to make a single resource change (a real change moves its fingerprint).
type ProbeState = { updatedAt: string; conclusion: string; commentAt: string; reviews: unknown[] };
const probeState = (): ProbeState => ({ updatedAt: "2026-10-04T21:05:00Z", conclusion: "success", commentAt: "2026-10-04T21:00:00Z", reviews: [] });
const restSeed = (state: ProbeState) => (path: string): unknown =>
  path.endsWith("/check-runs?per_page=100") ? checkBody(state.conclusion)
    : path.endsWith("/status") ? NO_STATUSES
      : path === COMMENTS_PATH ? [{ id: 1, updated_at: state.commentAt }]
        : path === REVIEWS_PATH ? state.reviews
          : issueBody(state.updatedAt);
// The `x-ratelimit-*` headers GitHub sends with every REST answer (GitHubBudget reads `remaining`).
const limitHeaders = (remaining: number) => new Map([["x-ratelimit-resource", "core"], ["x-ratelimit-remaining", String(remaining)], ["x-ratelimit-limit", "5000"], ["x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 3600)]]);

// A reader whose REST answers come from the fake, with the detail read counted.
function probeReader(rest: RestStub, read: () => PullRequestView) {
  const counted = { reads: 0 };
  const reader = new ConditionalPullView({ get: rest.get, budget: new GitHubBudget(() => Date.now(), 300), read: async () => { counted.reads++; return read(); } });
  return { reader, counted };
}

test("an unchanged pull request answers 304 and never reaches the detail read", async () => {
  const rest = restFake(restSeed(probeState()));
  const { reader, counted } = probeReader(rest, () => ({ ...OPEN_PR, updatedAt: "2026-10-04T21:05:00Z" }));
  const first = await withPriority("background", "pr watch", () => reader.view(PR));
  const second = await withPriority("background", "pr watch", () => reader.view(PR));
  assert.equal(counted.reads, 1, "the pull request was read in detail once");
  assert.equal(second, first, "the second poll served the cached view");
  assert.deepEqual(rest.calls.filter((call) => call.path === ISSUE_PATH).map((call) => call.etag), [null, `"${ISSUE_PATH}#0"`], "the second look is conditional on the first ETag");
  assert.equal(rest.calls.filter((call) => call.etag === null).length, 5, "only the first poll's five reads are unconditional");
});

test("a new head SHA reaches the detail read again", async () => {
  const state = probeState();
  let head = HEAD;
  const rest = restFake(restSeed(state));
  const { reader, counted } = probeReader(rest, () => ({ ...OPEN_PR, headSha: head, updatedAt: state.updatedAt }));
  await withPriority("background", "pr watch", () => reader.view(PR));
  // A push moves `updated_at`, which the probe sees; the detail read then returns the new head.
  state.updatedAt = "2026-10-04T21:10:00Z";
  head = "9f8e7d6c5b4a9f8e7d6c5b4a9f8e7d6c5b4a9f8e";
  rest.bump(ISSUE_PATH);
  const view = await withPriority("background", "pr watch", () => reader.view(PR));
  assert.equal(counted.reads, 2);
  assert.equal(view.headSha, head);
});

test("checks moving on an unchanged head reach the detail read again", async () => {
  const state = probeState();
  const rest = restFake(restSeed(state));
  const { reader, counted } = probeReader(rest, () => ({ ...OPEN_PR, checks: [{ ...RUNNING_CI, state: state.conclusion === "success" ? "passed" : "failed", conclusion: state.conclusion }] }));
  await withPriority("background", "pr watch", () => reader.view(PR));
  state.conclusion = "failure";
  rest.bump(checkRunsPath(HEAD));
  const view = await withPriority("background", "pr watch", () => reader.view(PR));
  assert.equal(counted.reads, 2);
  assert.equal(view.checks[0].state, "failed");
  assert.equal(rest.calls.filter((call) => call.path === ISSUE_PATH && call.etag !== null).length, 1, "the issue resource itself only answered 304s");
});

test("Graphite editing its merge activity comment reaches the detail read again", async () => {
  const state = probeState();
  const rest = restFake(restSeed(state));
  const { reader, counted } = probeReader(rest, () => ({ ...OPEN_PR, mergeActivity: `### Merge activity\n\n* **Oct 4, 11:22 PM UTC**: ${state.commentAt}` }));
  await withPriority("background", "pr watch", () => reader.view(PR));
  state.commentAt = "2026-10-04T21:20:00Z";
  rest.bump(COMMENTS_PATH);
  const view = await withPriority("background", "pr watch", () => reader.view(PR));
  assert.equal(counted.reads, 2);
  assert.ok(view.mergeActivity?.includes("21:20"), "the merge activity edit reached the view");
});

test("a new review reaches the detail read again", async () => {
  const state = probeState();
  const rest = restFake(restSeed(state));
  const { reader, counted } = probeReader(rest, () => ({ ...OPEN_PR, reviews: state.reviews as PullRequestView["reviews"] }));
  await withPriority("background", "pr watch", () => reader.view(PR));
  state.reviews = [{ id: 2, state: "CHANGES_REQUESTED", submitted_at: "2026-10-04T21:20:00Z" }];
  rest.bump(REVIEWS_PATH);
  const view = await withPriority("background", "pr watch", () => reader.view(PR));
  assert.equal(counted.reads, 2);
  assert.equal(view.reviews.length, 1);
});

test("the shared REST reserve pauses the first look before it sends anything", async () => {
  const rest = restFake(restSeed(probeState()));
  const budget = new GitHubBudget(() => Date.now(), 300);
  budget.record(limitHeaders(100));
  const reader = new ConditionalPullView({ get: rest.get, budget, read: async () => OPEN_PR });
  await assert.rejects(() => withPriority("background", "pr watch", () => reader.view(PR)), (error: unknown) => error instanceof GitHubPausedError);
  assert.deepEqual(rest.calls, [], "a background poll sends nothing below the reserve");
  await withPriority("interactive", "pull request view", () => reader.view(PR));
  assert.equal(rest.calls.length, 5, "an interactive caller still reads");
});

test("a custom unguarded CLI preserves the single-login reserve despite installed router markers", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "paseo-gh-override-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(join(home, ".paseo", "bin"), { recursive: true });
  await writeFile(join(home, ".local", "bin", "gh"), "");
  await writeFile(join(home, ".paseo", "bin", "github-router.mjs"), "");
  const env = { LINEAR_TICKETS_GH: "/custom/unguarded-gh" };
  const rest = restFake(restSeed(probeState()));
  const budget = new GitHubBudget(() => Date.now(), 300, githubRouted(env, home));
  budget.record(limitHeaders(100));
  const reader = new ConditionalPullView({ get: rest.get, budget, read: async () => OPEN_PR });
  await assert.rejects(() => withPriority("background", "pr watch", () => reader.view(PR)), (error: unknown) => error instanceof GitHubPausedError && error.reason === "budget");
  assert.deepEqual(rest.calls, [], "the installed but bypassed router cannot disable the reserve");
  await withPriority("interactive", "pull request view", () => reader.view(PR));
  assert.equal(rest.calls.length, 5, "interactive reads can use the reserved quota");

  const optedIn = new GitHubBudget(() => Date.now(), 300, githubRouted({ ...env, LINEAR_TICKETS_GITHUB_ROUTED: "1" }, home));
  optedIn.record(limitHeaders(100));
  const routed = new ConditionalPullView({ get: rest.get, budget: optedIn, read: async () => OPEN_PR });
  await withPriority("background", "pr watch", () => routed.view(PR));
  assert.equal(rest.calls.length, 10, "an explicitly routed override delegates quota admission");
});

test("with the router installed one account's low quota cannot pause the next look, and the router's refusal passes through", async () => {
  const rest = restFake(restSeed(probeState()));
  const budget = new GitHubBudget(() => Date.now(), 300, true);
  budget.record(limitHeaders(100)); // the account that answered the previous call is nearly spent
  const reader = new ConditionalPullView({ get: rest.get, budget, read: async () => OPEN_PR });
  await withPriority("background", "pr watch", () => reader.view(PR));
  assert.equal(rest.calls.length, 5, "the router, not the last response's headers, decides which account reads");
  const refused = new GitHubRateLimitedError("GitHub is throttling gh: GitHub read budgets exhausted; try again after 2026-10-06T23:10:00Z.");
  const spent = new ConditionalPullView({ get: async () => { throw refused; }, budget, read: async () => OPEN_PR });
  await assert.rejects(() => withPriority("background", "pr watch", () => spent.view(PR)), (error: unknown) => error === refused, "the router's message reaches the caller, not a generic pause");
});

test("the poll reads through the injected first look, not the detail view", async (t) => {
  let reads = 0;
  const h = harness(t, {}, { view: async () => { reads++; return OPEN_PR; } });
  await h.poll();
  assert.equal(reads, 1, "the first look read the pull request");
  assert.deepEqual(h.github.reads, [], "the injected detail read was not used");
});

test("a GitHub budget pause ends the poll and the next poll retries", async (t) => {
  t.mock.method(console, "error", () => {});
  let reads = 0;
  const h = harness(t, {}, { view: async () => { reads++; if (reads === 1) throw new GitHubPausedError(Date.now() + 60_000, "budget", 10); return { ...OPEN_PR, state: "MERGED" }; } });
  assert.deepEqual(await h.poll(), [], "the pause ended the poll before anything was sent");
  assert.deepEqual(await h.poll(), ["review merged", "say thought The pull request was merged.", "merged i1"]);
});

// A successor SessionRouter.succeed started for the gone agent `a1`: it claims, then creates.
const SUCCESSOR = { id: "s2a2b3c4d5", title: "TUC-1: successor", cwd: "/wt/tuc-1" };
const startSuccessor = async (claim: () => Promise<void>): Promise<Succession> => {
  await claim();
  return { kind: "started", agent: SUCCESSOR };
};
const STARTED_LINE = (step: string) => `say thought The agent was gone; Paseo started a successor (agent s2a2b3c4) on mtuchel/tuc-1-fix and asked it to ${step}.`;
const HANDED_BACK = new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running, so the ticket is back in In Progress`);

test("a gone agent's stalled stage starts one successor with the nudge as its lead; without a free slot it waits, unclaimed", async (t) => {
  t.mock.method(console, "log", () => {});
  for (const agent of [{ status: "archived" as const }, { live: false }]) {
    const h = harness(t, { ...agent, autoResume: true });
    h.records[0] = { ...h.records[0], branch: "mtuchel/tuc-1-fix" };
    h.github.view = { ...READY, checks: [failing("PR code")] };
    h.paseo.succeed = async () => ({ kind: "wait", reason: "the agent limit (2) is reached" });
    assert.deepEqual(await h.poll(), [], "no slot: nothing claimed, nothing to the ticket");
    assert.deepEqual(await h.poll(), [], "judged again on the next poll");
    h.paseo.succeed = startSuccessor;
    const calls = await h.poll();
    assert.ok(calls[0].startsWith("succeed a1\nChecks failed on the head"), calls[0]);
    assert.ok(calls[0].endsWith(`\n\n${NUDGE_CLOSE}`), calls[0]);
    assert.equal(calls[1], STARTED_LINE("fix the failing checks"));
    assert.equal(calls.length, 2, JSON.stringify(agent));
    assert.equal(h.records[0].agentId, SUCCESSOR.id, "the record names the successor");
    h.paseo.answer = async () => "sent";
    h.paseo.succeed = async () => { throw new Error("no second successor"); };
    assert.deepEqual(await h.poll(), [], "the claimed head is not sent again, to the successor either");
  }
});

test("a successor start counts as a nudge: a gone agent's stage keeps stalling without limit and asks for a new approach every third", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { status: "archived", autoResume: true });
  h.paseo.succeed = async (claim) => {
    await claim();
    h.records[0] = { ...h.records[0], status: "archived" };
    return { kind: "started", agent: { ...SUCCESSOR, id: h.records[0].agentId } };
  };
  for (const head of ["h1", "h2", "h3", "h4"]) {
    h.github.view = { ...READY, headSha: head, checks: [failing("PR code")] };
    const calls = await h.poll();
    assert.match(calls[0], /^succeed a1\n/, head);
    if (head === "h3") assert.match(calls[0], /keeps stalling at this step \(nudge 3\); change your approach/, head);
    else assert.doesNotMatch(calls[0], /keeps stalling/, head);
    assert.ok(calls[0].endsWith(`\n\n${NUDGE_CLOSE}`), head);
    assert.ok(!calls.some((call) => call.startsWith("comment")), `${head}: no count hands the stage to the owner`);
    h.records[0] = { ...h.records[0], status: "archived" };
  }
});

test("a gone agent's message goes to the ticket when no successor can start, the switch is off, or the pull request is vetoed", async (t) => {
  t.mock.method(console, "error", () => {});
  const none = harness(t, { status: "archived", autoResume: true });
  none.github.view = { ...READY, checks: [failing("PR code")] };
  const calls = await none.poll();
  assert.equal(calls[0], "move In Progress");
  assert.match(calls[1], HANDED_BACK);
  assert.deepEqual(await none.poll(), [], "claimed once");

  const off = harness(t, { status: "archived" });
  off.github.view = { ...off.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  off.paseo.succeed = async () => { throw new Error("the switch is off"); };
  assert.match((await off.poll())[1], HANDED_BACK);

  const vetoed = harness(t, { status: "archived", autoResume: true });
  vetoed.github.view = { ...vetoed.github.view, labels: ["do-not-merge"], mergeActivity: activity(QUEUED, CONFLICT) };
  vetoed.paseo.succeed = async () => { throw new Error("do-not-merge"); };
  assert.match((await vetoed.poll())[1], HANDED_BACK);
});

test("a gone agent's queue drop stays pending while no successor can start yet, then starts one with the fix request, delivered once", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { status: "archived", autoResume: true });
  h.records[0] = { ...h.records[0], branch: "mtuchel/tuc-1-fix" };
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  let starts = 0;
  h.paseo.succeed = async () => ({ kind: "wait", reason: "a launch for this ticket is under way" });
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual(await h.poll(), [], "still pending");
  h.paseo.succeed = async (claim) => { starts++; return startSuccessor(claim); };
  const calls = await h.poll();
  assert.match(calls[0], /^succeed a1\n[^]*Reason: Sep 29, 7:01 AM UTC: The Graphite merge queue couldn't merge this PR because it had merge conflicts\./);
  assert.equal(calls[1], STARTED_LINE("fix the merge queue drop"));
  assert.equal(calls.length, 2);
  assert.deepEqual(await h.poll(), [], "delivered");
  await h.restart();
  assert.deepEqual(await h.poll(), [], "also after a restart");
  assert.equal(starts, 1);
});

test("a gone agent's replay request starts a successor and the closed pull request then waits for the replacement", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { status: "archived", autoResume: true });
  h.records[0] = { ...h.records[0], branch: "mtuchel/tuc-1-fix" };
  h.github.view = { ...OPEN_PR, state: "CLOSED", baseBranch: PARENT };
  h.github.deleted = [PARENT];
  h.paseo.succeed = startSuccessor;
  const calls = await h.poll();
  assert.match(calls[0], new RegExp(`^succeed a1\\n\\[The pull request\\]\\(${PR}\\) was closed without merging[^]*gt track mtuchel/tuc-1-fix --parent main`));
  assert.equal(calls[1], STARTED_LINE("open the replacement pull request"));
  h.paseo.succeed = async () => { throw new Error("no second successor"); };
  assert.deepEqual(await h.poll(), [], "asked once");
  h.github.open = [listed(NEXT, OPEN_PR)];
  assert.match((await h.poll())[0], new RegExp(`^link Pull request ${NEXT}`), "the successor's replacement is followed");
});

test("a refused enqueue for a gone agent starts a successor with the refusal, after waiting for a slot", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { live: false, autoResume: true });
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.scripts.enqueue = [{ code: 2, answer: { result: "refused", problems: [{ kind: "conflict-main", text: "conflicts with main" }] } }];
  await h.backstop();
  h.paseo.succeed = async () => ({ kind: "wait", reason: "blocked by TUC-0" });
  assert.deepEqual(await h.poll(), []);
  h.paseo.succeed = startSuccessor;
  const calls = await h.poll();
  assert.match(calls[0], /^succeed a1\n[^]*`conflict-main`/);
  assert.deepEqual(await h.poll(), [], "delivered once");
});

test("once a successor started, a failing panel line, state save or plugin restart never starts a second one", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  // The panel line fails after the start: the claim stands.
  const panel = harness(t, { status: "archived", autoResume: true });
  panel.github.view = { ...READY, checks: [failing("PR code")] };
  panel.paseo.session = async () => { throw new Error("Linear is unavailable"); };
  let starts = 0;
  panel.paseo.succeed = async (claim) => { starts++; return startSuccessor(claim); };
  assert.match((await panel.poll())[0], /^succeed a1\n/);
  assert.deepEqual(await panel.poll(), []);
  await panel.restart();
  assert.deepEqual(await panel.poll(), []);
  assert.equal(starts, 1);

  // The state cannot be saved after the start (the drop's delivery included): the saved claim holds.
  const save = harness(t, { status: "archived", autoResume: true });
  save.github.view = { ...save.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  const home = await save.home();
  let dropStarts = 0;
  save.paseo.succeed = async (claim) => {
    dropStarts++;
    const started = await startSuccessor(claim);
    await chmod(home, 0o500);
    return started;
  };
  try {
    await assert.rejects(save.poll());
  } finally {
    await chmod(home, 0o700);
  }
  await save.restart();
  assert.deepEqual(await save.poll(), [], "the message may have gone out: not again");
  assert.equal(dropStarts, 1);

  // The plugin stops between the claim and the start: no start, no second claim (the accepted gap).
  const gap = harness(t, { status: "archived", autoResume: true });
  gap.github.view = { ...READY, checks: [failing("PR code")] };
  const stop = hang();
  let claims = 0;
  gap.paseo.succeed = async (claim) => { claims++; await claim(); return stop.point().then(() => startSuccessor(claim)); };
  void gap.poll();
  await stop.reached;
  await gap.restart();
  gap.paseo.succeed = async () => { throw new Error("no start after the claim"); };
  assert.deepEqual(await gap.poll(), []);
  assert.equal(claims, 1);
});

test("a live agent of the ticket takes the gone agent's record and gets the message on the next poll", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { status: "archived", autoResume: true });
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.paseo.succeed = async () => ({ kind: "live", agent: { id: "a2", title: "TUC-1: resumed", cwd: "/wt/tuc-1" } });
  assert.deepEqual(await h.poll(), [], "nothing claimed yet");
  h.paseo.succeed = async () => { throw new Error("the live agent takes it"); };
  const calls = await h.poll();
  assert.ok(calls[0].startsWith("prompt a2\nChecks failed on the head"), calls[0]);
  assert.ok(calls[0].endsWith(`\n\n${NUDGE_CLOSE}`), calls[0]);
  assert.deepEqual(await h.poll(), []);
});

const HOUR = 60 * MINUTE;
const WAITED = (step: string) => `comment ${OWNER} The agent has waited over 60 minutes for your answer while [the pull request](${PR}) waits for it to ${step}. Answer it in the ticket's thread, or take over.`;

test("a stage waiting 60 minutes for the owner's answer reminds the owner once; restarts and busy polls keep the timer", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t);
  const start = h.scripts.now;
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.paseo.answer = async () => "waiting";
  assert.deepEqual(await h.poll(), []);
  h.scripts.now = start + 30 * MINUTE;
  h.paseo.answer = async () => "busy";
  assert.deepEqual(await h.poll(), [], "busy keeps the wait");
  await h.restart();
  h.paseo.answer = async () => "unavailable";
  assert.deepEqual(await h.poll(), [], "so does a disconnected Paseo, after a restart");
  h.paseo.answer = async () => "waiting";
  h.scripts.now = start + 59 * MINUTE;
  assert.deepEqual(await h.poll(), []);
  h.scripts.now = start + HOUR;
  assert.deepEqual(await h.poll(), [WAITED("fix the failing checks")]);
  h.scripts.now = start + 3 * HOUR;
  assert.deepEqual(await h.poll(), [], "once");
  h.paseo.answer = async () => "sent";
  h.github.view = { ...READY, headSha: "h2", checks: [failing("PR code")] };
  const nudged = await h.poll();
  assert.ok((promptOf(nudged) ?? "").endsWith(`\n\n${NUDGE_CLOSE}`), "a new stall of the stage is nudged again: no count stops it");
  assert.equal(nudged.at(-1), "say thought The pull request is waiting for the agent to fix the failing checks; it was asked to.");
  assert.deepEqual(await h.poll(), [], "and the same head is not nudged twice while the answer is pending");
});

test("a message that went out, a new head or another stage starts the permission wait again from zero", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t);
  const start = h.scripts.now;
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.paseo.answer = async () => "waiting";
  await h.poll();
  h.scripts.now = start + 50 * MINUTE;
  h.paseo.answer = async () => "sent";
  assert.ok((promptOf(await h.poll()) ?? "").endsWith(`\n\n${NUDGE_CLOSE}`), "answered before the hour: sent");
  h.github.view = { ...READY, headSha: "h2", checks: [failing("PR code")] };
  h.paseo.answer = async () => "waiting";
  assert.deepEqual(await h.poll(), [], "a new head waits from now");
  h.scripts.now = start + 50 * MINUTE + 59 * MINUTE;
  assert.deepEqual(await h.poll(), []);
  // The checks pass on the same head, and a bot's finding holds it instead: another stage.
  h.github.view = { ...READY, headSha: "h2" };
  h.github.threads = [FINDING];
  assert.deepEqual(await h.poll(), [], "another stage waits from now");
  h.scripts.now += 59 * MINUTE;
  assert.deepEqual(await h.poll(), []);
  h.scripts.now += MINUTE;
  assert.deepEqual(await h.poll(), [WAITED("resolve the review findings")]);
});

test("a stage the owner vetoed meanwhile waits from zero once the veto is lifted", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t);
  const start = h.scripts.now;
  h.github.view = { ...READY, checks: [failing("PR code")] };
  h.paseo.answer = async () => "waiting";
  assert.deepEqual(await h.poll(), []);
  h.scripts.now = start + 50 * MINUTE;
  h.github.view = { ...READY, checks: [failing("PR code")], labels: ["do-not-merge"] };
  assert.deepEqual(await h.poll(), [], "vetoed: no nudge and no reminder");
  h.scripts.now = start + 90 * MINUTE;
  h.github.view = { ...READY, checks: [failing("PR code")] };
  assert.deepEqual(await h.poll(), [], "the same stage waits again, from now");
  h.scripts.now = start + 90 * MINUTE + 59 * MINUTE;
  assert.deepEqual(await h.poll(), []);
  h.scripts.now = start + 150 * MINUTE;
  assert.deepEqual(await h.poll(), [WAITED("fix the failing checks")]);
});

test("a drop's fix request or a replay request waiting 60 minutes for the owner's answer escalates once", async (t) => {
  t.mock.method(console, "log", () => {});
  const drop = harness(t);
  drop.github.view = { ...drop.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  drop.paseo.answer = async () => "waiting";
  assert.deepEqual(await drop.poll(), []);
  drop.scripts.now += HOUR;
  assert.deepEqual(await drop.poll(), [WAITED("fix the merge queue drop")]);
  drop.paseo.answer = async () => "sent";
  assert.deepEqual(await drop.poll(), [], "escalated: the fix request is not sent after all");

  const replay = harness(t);
  replay.github.view = { ...OPEN_PR, state: "CLOSED", baseBranch: PARENT };
  replay.github.deleted = [PARENT];
  replay.paseo.answer = async () => "waiting";
  assert.deepEqual(await replay.poll(), []);
  replay.scripts.now += HOUR;
  assert.deepEqual(await replay.poll(), [WAITED("open the replacement pull request")]);
  replay.paseo.answer = async () => "sent";
  assert.deepEqual(await replay.poll(), [], "asked");
});

test("the backstop's enqueued note waits while the agent waits for the owner, and goes out once it takes messages", async (t) => {
  const h = harness(t);
  h.github.view = READY;
  h.scripts.ready = { stacks: [STACK], drops: [] };
  h.paseo.answer = async () => "waiting";
  const calls = await h.backstop();
  assert.ok(!calls.some((call) => call.startsWith("prompt")), "not sent to an agent waiting for the owner");
  h.paseo.answer = async () => "sent";
  assert.match(promptOf(await h.backstop()) ?? "", /Do not enqueue it again yourself\.$/);
  assert.ok(!(await h.backstop()).some((call) => call.startsWith("prompt")), "once");
});

// --- TUC-1209: open stacks stranded on an orphaned graphite-base/<n> branch -----------------------

const ORPHAN_BASE = "graphite-base/418";
const sha = (digit: string) => digit.repeat(40);
const TOP_URL = "https://github.com/tuchel-sohn/tuchel-platform/pull/420";
const RANGE = [{ pr: 419, branch: "mtuchel/tuc-1-fix", base: ORPHAN_BASE, sha: sha("1") }, { pr: 420, branch: "mtuchel/tuc-1-top", base: "mtuchel/tuc-1-fix", sha: sha("2") }];
const OLD_HEADS = `419@${sha("1")},420@${sha("2")}`;
const NEW_HEADS = `419@${sha("3")},420@${sha("4")}`;
const CANDIDATE = { pr: 419, branch: RANGE[0].branch, base: ORPHAN_BASE, baseSha: sha("b"), expect: OLD_HEADS, range: RANGE, tickets: ["TUC-1"], eligible: true, reason: null };
const SYNC = `git fetch origin\ngit rebase --onto origin/mtuchel/tuc-1-fix ${sha("1")} mtuchel/tuc-1-fix\ngit rebase --onto origin/mtuchel/tuc-1-top ${sha("2")} mtuchel/tuc-1-top\ngt track mtuchel/tuc-1-fix --parent main`;
// What `--prepare` saves and `--apply` gets back as its record.
const PREPARED_MOVE = { pr: 419, base: ORPHAN_BASE, baseSha: sha("b"), range: RANGE, onto: sha("c"), stamp: 1_700_000_000, new: { base: "main", heads: NEW_HEADS }, sync: SYNC };
const PREPARE_RUN = `retarget --prepare 419 --expect ${OLD_HEADS}`;
const APPLY_RUN = "retarget --apply 419";
const MOVED = "Paseo's queue backstop moved";
const STRANDED = "is based on `graphite-base/418`";

// The watched pull request #419 is the bottom of the stack #419 <- #420 on `graphite-base/418`,
// which `retarget-orphan.mjs` lists, prepares and moves.
function stranded(t: TestContext, agent: Parameters<typeof harness>[1] = {}) {
  const h = harness(t, agent);
  h.github.view = { ...OPEN_PR, headSha: sha("1"), baseBranch: ORPHAN_BASE };
  h.github.open = [listed(TOP_URL, { ...OPEN_PR, headBranch: "mtuchel/tuc-1-top", headSha: sha("2"), baseBranch: "mtuchel/tuc-1-fix" }, "Top TUC-1 [plugin] Retry the upload")];
  h.scripts.retarget.present = true;
  h.scripts.retarget.list = [CANDIDATE];
  h.scripts.retarget.prepare = [{ code: 0, answer: { result: "prepared", ...PREPARED_MOVE, problems: [] } }];
  h.scripts.retarget.apply = [{ code: 0, answer: { result: "retargeted", pr: 419, problems: [] } }];
  return h;
}
const retargetCalls = (calls: string[]) => calls.filter((call) => call.startsWith("retarget ") || call.startsWith("idle "));

test("an idle ticket's stranded stack is moved, commented on once on the pull request and the ticket, and its agent gets the sync commands (AC-6)", async (t) => {
  const h = stranded(t);
  const calls = await h.backstop();
  assert.deepEqual(retargetCalls(calls), ["idle i1 ran", PREPARE_RUN, APPLY_RUN]);
  assert.deepEqual(h.scripts.retarget.records, [PREPARED_MOVE], "--apply gets exactly the saved preparation");
  const [comment, ...more] = h.github.comments[419] ?? [];
  assert.deepEqual(more, [], "one pull request comment");
  for (const fact of [`\`${ORPHAN_BASE}\` (\`${sha("b")}\`) → \`main\` (\`${sha("c")}\`)`, `| #419 | \`mtuchel/tuc-1-fix\` | \`${sha("1")}\` | \`${sha("3")}\` |`, `| #420 | \`mtuchel/tuc-1-top\` | \`${sha("2")}\` | \`${sha("4")}\` |`, SYNC]) assert.ok(comment.includes(fact), `the comment names ${fact}`);
  assert.match(comment, new RegExp(`<!-- queue-backstop:retarget:419@${sha("1")} -->$`));
  assert.equal(h.linear.comments.i1?.length, 1, "one ticket comment");
  assert.ok(h.linear.comments.i1[0].includes(`| #420 | \`mtuchel/tuc-1-top\` | \`${sha("2")}\` | \`${sha("4")}\` |`));
  const note = promptOf(calls) ?? "";
  assert.ok(note.includes(SYNC) && note.endsWith("Do not push the old heads again, and do not move the stack yourself: it is done."), "the living agent gets the sync commands");

  h.scripts.retarget.list = [];
  const again = await h.backstop();
  assert.deepEqual(retargetCalls(again), [], "moved once");
  assert.equal(count(again, "prompt"), 0);
  assert.equal(h.github.comments[419].length, 1);
});

test("a gone or archived agent's stranded stack is moved too, and only the comments report it (AC-6)", async (t) => {
  for (const agent of [{ live: false }, { status: "archived" as const }]) {
    const h = stranded(t, agent);
    const calls = await h.backstop();
    assert.deepEqual(retargetCalls(calls), ["idle i1 ran", PREPARE_RUN, APPLY_RUN], JSON.stringify(agent));
    assert.equal(h.github.comments[419]?.length, 1);
    assert.equal(h.linear.comments.i1?.length, 1);
    assert.equal(promptOf(calls), undefined, "no note to an agent that is gone");
  }
});

test("the backstop moves at most three stacks per run, and nothing without the script or without the ticket's confirmed ownership (AC-6)", async (t) => {
  const many = stranded(t);
  many.scripts.retarget.list = [501, 502, 503, 504].map((pr) => ({ ...CANDIDATE, pr, expect: `${pr}@${sha("1")}`, range: [{ ...RANGE[0], pr }] }));
  many.scripts.retarget.prepare = [501, 502, 503, 504].map((pr) => ({ code: 0, answer: { result: "prepared", ...PREPARED_MOVE, pr, range: [{ ...RANGE[0], pr }], new: { base: "main", heads: `${pr}@${sha("3")}` }, problems: [] } }));
  const calls = await many.backstop();
  assert.deepEqual(retargetCalls(calls).filter((call) => !call.startsWith("idle")), ["--prepare 501", "--apply 501", "--prepare 502", "--apply 502", "--prepare 503", "--apply 503"].map((run) => `retarget ${run}${run.startsWith("--prepare") ? ` --expect ${run.slice(10)}@${sha("1")}` : ""}`));
  assert.deepEqual(retargetCalls(await many.backstop()).filter((call) => !call.startsWith("idle")), [`retarget --prepare 504 --expect 504@${sha("1")}`, "retarget --apply 504"], "the fourth on the next run");

  const absent = stranded(t);
  absent.scripts.retarget.present = false;
  await absent.backstop();
  assert.ok(!absent.scripts.runs.some((run) => run.startsWith(RETARGET_ORPHAN)), "no script on main: nothing runs");

  for (const outcome of ["elsewhere", "unavailable"] as const) {
    const peer = stranded(t);
    peer.paseo.idle = async () => outcome;
    const runs = [...await peer.backstop(), ...await peer.poll()];
    assert.deepEqual(retargetCalls(runs), [`idle i1 ${outcome}`], `${outcome}: no prepare or apply`);
    assert.ok(!runs.some((call) => call.includes(STRANDED)), `${outcome}: no message either`);
  }

  const unknown = stranded(t);
  unknown.scripts.retarget.list = [{ ...CANDIDATE, tickets: ["TUC-7"] }];
  unknown.linear.state = { ...unknown.linear.state, id: "i7" } as typeof unknown.linear.state;
  assert.deepEqual(retargetCalls([...await unknown.backstop(), ...await unknown.backstop()]), [], "a ticket Linear knows but this host has no record of: nothing");
});

test("while an agent of the ticket works, the stack is left alone and the agent asked once; once none works, it is moved (AC-5, AC-13)", async (t) => {
  for (const outcome of ["busy", "waiting"] as const) {
    const h = stranded(t);
    h.paseo.idle = async () => outcome;
    h.paseo.answer = async () => outcome;
    assert.deepEqual(retargetCalls(await h.backstop()), [`idle i1 ${outcome}`], `${outcome}: no prepare`);
    assert.deepEqual(retargetCalls(await h.backstop()), [`idle i1 ${outcome}`], `${outcome}: still none`);
    h.paseo.answer = async () => "sent";
    const told = await h.poll();
    assert.equal(count(told, "prompt a1"), 1, `${outcome}: asked once across both runs`);
    const instruction = promptOf(told) ?? "";
    assert.ok(instruction.includes(STRANDED) && instruction.includes("An agent of the ticket is working"), instruction);
    assert.equal(count(await h.poll(), "prompt a1"), 0);

    if (outcome === "busy") {
      // AC-13: the instruction's commands move the stack by hand.
      const repo = await replayRepo(t, { base: ORPHAN_BASE, deleted: false });
      repo.run(blockOf(instruction));
      repo.assertReplayed();
      assert.equal(repo.gh(), "pr edit 419 --base main\n");
      assert.equal(repo.gt(), "track mtuchel/tuc-1-fix --parent main\n");
    }

    h.paseo.idle = async () => "ran";
    const moved = await h.backstop();
    assert.deepEqual(retargetCalls(moved), ["idle i1 ran", PREPARE_RUN, APPLY_RUN], `${outcome}: moved once no agent works`);
    assert.equal(h.github.comments[419]?.length, 1);
  }

  const asked = stranded(t);
  asked.paseo.idle = async () => "busy";
  asked.paseo.answer = async () => "busy";
  await asked.backstop();
  asked.paseo.idle = async () => "ran";
  asked.paseo.answer = async () => "sent";
  await asked.backstop();
  assert.ok(!(await asked.poll()).some((call) => call.includes(STRANDED)), "a move drops its instruction that had not gone out yet");
});

test("commits that do not apply onto main go to the agent once, else a successor, else the ticket (AC-4)", async (t) => {
  const conflict = { code: 2, answer: { result: "conflict", pr: 419, problems: [{ kind: "conflict", text: "s2's commits do not apply onto main" }] } };
  for (const who of ["agent", "successor", "ticket"] as const) {
    const h = stranded(t, who === "agent" ? {} : { live: false, autoResume: who === "successor" });
    h.scripts.retarget.prepare = [conflict];
    if (who === "successor") h.paseo.succeed = startSuccessor;
    assert.deepEqual(retargetCalls(await h.backstop()), ["idle i1 ran", PREPARE_RUN], `${who}: nothing applied`);
    const told = await h.poll();
    const text = who === "agent" ? promptOf(told) : who === "successor" ? told.find((call) => call.startsWith("succeed a1\n")) : told.find((call) => HANDED_BACK.test(call));
    assert.ok(text?.includes(STRANDED) && text.includes("Its own commits do not apply cleanly onto `main`"), `${who}:\n${told.join("\n")}`);
    if (who === "ticket") assert.equal(told.filter((call) => call.startsWith(`comment ${OWNER}`)).length, 1, "one owner mention");
    assert.deepEqual(retargetCalls(await h.backstop()), [], `${who}: the same heads are not prepared again`);
    assert.ok(!(await h.poll()).some((call) => call.includes(STRANDED)), `${who}: told once`);
  }
});

test("escalated, gated, blocked or otherwise messaged stacks are not moved, and a stack of several tickets goes to its bottom ticket's agent (AC-11)", async (t) => {
  const seen = (extra: Record<string, unknown>) => ({ reviewedAt: null, decision: null, merged: false, ...extra });
  const cases: { name: string; arrange: (h: ReturnType<typeof stranded>) => Promise<void> }[] = [
    { name: "escalated", arrange: (h) => h.state({ [PR]: seen({ escalated: true }) }) },
    { name: "before-merge manual task", arrange: async (h) => { h.blockers.push("TUC-9"); } },
    { name: "blocked at its head", arrange: (h) => h.state({ [TOP_URL]: seen({ blockedAt: sha("2") }) }) },
    { name: "a foreign message pending", arrange: (h) => h.state({ [PR]: seen({ pending: { key: "drop:#900:419", reason: "", facts: "Fix the drop.", fix: "Fix the drop." } }) }) },
  ];
  for (const item of cases) {
    const h = stranded(t);
    h.paseo.answer = async () => "busy";
    await item.arrange(h);
    const runs = [...await h.backstop(), ...await h.poll()];
    assert.deepEqual(retargetCalls(runs), [], `${item.name}: no prepare, apply or idle check`);
    assert.ok(!runs.some((call) => call.includes(STRANDED)), `${item.name}: no message`);
  }

  const shared = stranded(t);
  shared.scripts.retarget.list = [{ ...CANDIDATE, tickets: ["TUC-1", "TUC-2"] }];
  assert.deepEqual(retargetCalls(await shared.backstop()), [], "several tickets: no move");
  const told = promptOf(await shared.poll()) ?? "";
  assert.ok(told.includes(STRANDED) && told.includes("Its pull requests name several tickets (TUC-1, TUC-2)"), told);
  await shared.backstop();
  assert.ok(!(await shared.poll()).some((call) => call.includes(STRANDED)), "asked once");
});

test("a ticket named on the stack after it was first listed counts before the move, and a block that appears while it is prepared holds the write (AC-11)", async (t) => {
  const renamed = stranded(t);
  renamed.paseo.idle = async () => "busy";
  assert.deepEqual(retargetCalls(await renamed.backstop()), ["idle i1 busy"]);
  renamed.paseo.idle = async () => "ran";
  renamed.scripts.retarget.list = [{ ...CANDIDATE, tickets: ["TUC-1", "TUC-2"] }];
  assert.deepEqual(retargetCalls(await renamed.backstop()), [], "same heads, now several tickets: no move");

  const gated = stranded(t);
  gated.scripts.retarget.beforePrepare = async () => { gated.blockers.push("TUC-1"); };
  assert.deepEqual(retargetCalls(await gated.backstop()), ["idle i1 ran", PREPARE_RUN], "a manual task opened during the preparation: no write");
  gated.scripts.retarget.beforePrepare = async () => {};
  assert.deepEqual(retargetCalls(await gated.backstop()), [], "still open: no write");
  gated.blockers.length = 0;
  assert.deepEqual(retargetCalls(await gated.backstop()), ["idle i1 ran", APPLY_RUN], "the saved preparation is written once the task is done");
  assert.equal(gated.github.comments[419]?.length, 1);
});

test("a stack still stranded at the same heads keeps its conflict past the backstop's memory, so it is neither asked nor prepared again (AC-4)", async (t) => {
  const h = stranded(t);
  h.scripts.retarget.prepare = [{ code: 2, answer: { result: "conflict", pr: 419, problems: [{ kind: "conflict", text: "s2's commits do not apply onto main" }] } }];
  await h.backstop();
  assert.ok((promptOf(await h.poll()) ?? "").includes(STRANDED));
  h.scripts.now += 15 * 24 * HOUR;
  const later = [...await h.backstop(), ...await h.poll(), ...await h.backstop()];
  assert.deepEqual(retargetCalls(later), [], "not prepared again");
  assert.ok(!later.some((call) => call.includes(STRANDED)), "not asked again");
});

test("a restart at any point of a move ends with it moved, one pull request comment, one ticket comment and one note (AC-7)", async (t) => {
  for (const crash of ["during the write", "after the pull request comment", "before the ticket comment", "after the ticket comment"] as const) {
    const h = stranded(t);
    const stop = hang();
    if (crash === "during the write") h.scripts.retarget.beforeApply = stop.point;
    if (crash === "after the pull request comment") h.github.stall = stop.point;
    if (crash === "before the ticket comment") h.linear.arrive = stop.point;
    if (crash === "after the ticket comment") h.linear.stall = stop.point;
    void h.backstop();
    await stop.reached;
    const crashed = [...h.calls];
    h.scripts.retarget.beforeApply = h.github.stall = h.linear.arrive = h.linear.stall = async () => {};
    // The stack may already be on main: the saved move goes on without a new listing.
    h.scripts.retarget.list = [];
    await h.restart();
    const all = [...crashed, ...await h.backstop(), ...await h.backstop()];
    assert.equal(count(all, "retarget --prepare"), 1, `${crash}: prepared once`);
    assert.equal(count(all, `pr comment #419 ${MOVED}`), 1, `${crash}: one pull request comment`);
    assert.equal(count(all, `comment ${MOVED}`), 1, `${crash}: one ticket comment`);
    assert.equal(count(all, "prompt a1\n"), 1, `${crash}: one note`);
    assert.equal(h.github.comments[419].length, 1, crash);
    assert.equal(h.linear.comments.i1.length, 1, crash);
    for (const record of h.scripts.retarget.records) assert.deepEqual(record, PREPARED_MOVE, `${crash}: every --apply gets the saved preparation`);
  }
});

test("a saved move waits while a block holds it, an apply error is retried, and a stack that changed meanwhile goes to the agent (AC-7)", async (t) => {
  const h = stranded(t);
  h.scripts.retarget.apply = [{ code: 1, answer: { result: "error", pr: 419, error: "the push timed out", problems: [] } }, { code: 0, answer: { result: "retargeted", pr: 419, problems: [] } }];
  assert.deepEqual(retargetCalls(await h.backstop()), ["idle i1 ran", PREPARE_RUN, APPLY_RUN]);
  h.scripts.retarget.list = [];
  await h.restart();
  h.blockers.push("TUC-1");
  assert.deepEqual(retargetCalls(await h.backstop()), [], "a before-merge manual task: no write");
  h.blockers.length = 0;
  assert.deepEqual(retargetCalls(await h.backstop()), ["idle i1 ran", APPLY_RUN], "resumed once the block cleared, without preparing again");
  assert.equal(h.github.comments[419]?.length, 1);
  assert.deepEqual(h.scripts.retarget.records, [PREPARED_MOVE, PREPARED_MOVE]);

  const changed = stranded(t);
  changed.scripts.retarget.apply = [{ code: 2, answer: { result: "refused", pr: 419, problems: [{ kind: "remote-differs", text: "origin/mtuchel/tuc-1-top is not #420's head" }] } }];
  await changed.backstop();
  const told = promptOf(await changed.poll()) ?? "";
  assert.ok(told.includes(STRANDED) && told.includes("refused: remote-differs (origin/mtuchel/tuc-1-top is not #420's head)"), told);
  assert.equal(changed.github.comments[419], undefined, "no success comment");
  assert.deepEqual(retargetCalls(await changed.backstop()), [], "never written again");
});

test("a second host that moved the same stack reports nothing twice, and one that lost the race reports no success (AC-16)", async (t) => {
  const h = stranded(t);
  await h.backstop();
  // The other host, with its own state, saw the same stack and prepared the same new heads.
  await h.state({});
  await h.restart();
  await h.backstop();
  assert.equal(h.github.comments[419].length, 1, "the marker keeps the pull request comment single");
  assert.equal(h.linear.comments.i1.length, 1, "the ticket marker keeps the ticket comment single");

  await h.state({});
  await h.restart();
  h.scripts.retarget.apply = [{ code: 2, answer: { result: "refused", pr: 419, problems: [{ kind: "remote-differs", text: "origin/mtuchel/tuc-1-fix is not #419's head" }] } }];
  await h.backstop();
  assert.equal(h.github.comments[419].length, 1, "the loser posts no success comment");
  assert.equal(h.linear.comments.i1.length, 1);
});

// --- Greptile re-request (TUC-1208) ---------------------------------------------------------

const PLATFORM = "tuchel-sohn/tuchel-platform";
const GREPTILE_HEAD = "c".repeat(40);
const greptileRuns = (runs: string[]) => runs.filter((run) => run.startsWith(GREPTILE_RETRIGGER));

test("the dispatch host runs greptile-retrigger.mjs with --trigger and the outage issue's pull requests, records each request, and syncs the outage issue once with every repo (AC-4)", async (t) => {
  const h = harness(t, { dispatch: true });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  h.scripts.outage.follow = new Map([[PLATFORM, [12]], ["o/other", [5]]]);
  const run = { pulls: [{ pr: 419, url: PR, title: "Add TUC-1", head: GREPTILE_HEAD, since: "2026-10-07T10:00:00Z", triggers: ["2026-10-07T10:30:00Z"], state: "triggered", overdue: false }], followed: [{ pr: 12, state: "reviewed" }], triggered: [{ pr: 419, head: GREPTILE_HEAD, at: "2026-10-07T10:30:00Z" }], errors: [] };
  h.scripts.greptile.answers = { [PLATFORM]: { code: 0, answer: run }, "o/other": { code: 1, answer: { error: "cannot list the open pull requests" } } };
  await h.backstop();
  assert.deepEqual(greptileRuns(h.scripts.runs), [`${GREPTILE_RETRIGGER} --trigger --follow 12`, `${GREPTILE_RETRIGGER} --trigger --follow 5`]);
  assert.deepEqual(h.scripts.runs.filter((line) => line.startsWith(ENQUEUE_READY)).length, 1, "a repo only the outage issue lists gets no enqueue pass");
  assert.equal(h.scripts.outage.syncs.length, 1);
  assert.deepEqual(h.scripts.outage.syncs[0].map((found) => [found.repo, found.result]), [[PLATFORM, "answer"], ["o/other", "failed"]]);
  const saved = JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8"));
  assert.deepEqual(saved[PR].greptile, [{ head: GREPTILE_HEAD, at: "2026-10-07T10:30:00Z" }]);
});

test("a host whose dispatch is off never runs greptile-retrigger.mjs or touches the outage issue, and says so once (AC-4)", async (t) => {
  const h = harness(t);
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args.join(" ")); });
  h.scripts.outage.follow = new Map([[PLATFORM, [12]]]);
  await h.backstop();
  await h.backstop();
  assert.deepEqual(greptileRuns(h.scripts.runs), []);
  assert.deepEqual(h.scripts.outage.syncs, []);
  assert.deepEqual(logs.filter((line) => line.includes("greptile re-request")), ["[linear-tickets] greptile re-request: skipped, dispatch is off on this host"]);
});

test("a checkout without the script counts as skipped, and a script error is the repo's failure, never a stop of the backstop (AC-4)", async (t) => {
  const h = harness(t, { dispatch: true });
  t.mock.method(console, "error", () => {});
  h.scripts.greptile.present = false;
  await h.backstop();
  assert.deepEqual(greptileRuns(h.scripts.runs), []);
  assert.deepEqual(h.scripts.outage.syncs.at(-1), [{ repo: PLATFORM, result: "skipped" }]);

  h.scripts.greptile.present = true;
  h.scripts.greptile.answers = { [PLATFORM]: { code: 0, answer: { pulls: [{ pr: 419, state: "asked" }], followed: [], triggered: [], errors: [] } } };
  h.scripts.runs.length = 0;
  await h.backstop();
  assert.equal(h.scripts.outage.syncs.at(-1)?.[0].result, "failed");
  assert.ok(h.scripts.runs.some((line) => line.startsWith(ENQUEUE_READY)), "the enqueue pass still ran");
});

test("once GitHub's budget stops the backstop, the remaining repos count as failed for the outage issue (AC-4)", async (t) => {
  const h = harness(t, { dispatch: true });
  t.mock.method(console, "error", () => {});
  h.scripts.outage.follow = new Map([["o/other", [5]]]);
  h.github.listFailure = new GitHubRateLimitedError("GitHub is throttling gh");
  await h.backstop();
  assert.deepEqual(greptileRuns(h.scripts.runs), [`${GREPTILE_RETRIGGER} --trigger`], "the stopped repo's script is not run");
  assert.deepEqual(h.scripts.outage.syncs[0].map((found) => [found.repo, found.result]), [[PLATFORM, "answer"], ["o/other", "failed"]]);
});

test("a discovery rate limit still synchronizes the incident once without running GitHub scripts (AC-4)", async (t) => {
  const h = harness(t, { dispatch: true });
  t.mock.method(console, "error", () => {});
  h.records[0] = { ...h.records[0], branch: OPEN_PR.headBranch, links: {} };
  h.git.origin = "git@github.com:tuchel-sohn/tuchel-platform.git";
  h.scripts.outage.follow = new Map([[PLATFORM, [419]], ["o/other", [5]]]);
  h.github.listFailure = new GitHubRateLimitedError("GitHub is throttling gh");
  await h.backstop();
  assert.deepEqual(h.scripts.runs, []);
  assert.deepEqual(h.scripts.outage.syncs.map((run) => run.map((found) => [found.repo, found.result])), [[[PLATFORM, "failed"], ["o/other", "failed"]]]);
});

test("GitHub refusing a repo script stops the backstop, which waits until the probed reset, logged in UTC, and then runs again by itself (AC-3)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args.join(" ")); });
  const h = harness(t, { dispatch: true });
  h.scripts.now = Date.parse("2026-10-09T19:16:55Z");
  h.scripts.greptile.answers = { [PLATFORM]: { code: 1, answer: { error: "gh: API rate limit exceeded for user ID 333775540. (HTTP 403)" } } };
  h.scripts.rates = [{ resource: "graphql", remaining: 4800, resetAt: Date.parse("2026-10-09T19:50:00Z") }, { resource: "core", remaining: 0, resetAt: Date.parse("2026-10-09T19:23:10Z") }];
  await h.backstop();
  assert.deepEqual(h.scripts.runs, [`${GREPTILE_RETRIGGER} --trigger`], "the repo's backstop steps do not run into the refusal");
  assert.equal(h.scripts.probes, 1);
  assert.deepEqual(h.scripts.outage.syncs[0].map((found) => [found.repo, found.result]), [[PLATFORM, "failed"]]);
  assert.ok(logs.some((line) => line.startsWith("[linear-tickets] queue backstop waits until 19:23 UTC for GitHub's core budget reset (GitHub refused tools/ci/greptile-retrigger.mjs's requests: gh: API rate limit exceeded")), "the budget with room (graphql) is not the one waited for");

  h.scripts.greptile.answers = {};
  h.scripts.runs.length = 0;
  t.mock.timers.tick(Date.parse("2026-10-09T19:23:10Z") - h.scripts.now + 4_999);
  assert.deepEqual(h.scripts.runs, [], "nothing runs before the reset");
  t.mock.timers.tick(1);
  await (await h.watch()).backstop();
  assert.deepEqual(h.scripts.runs, [`${GREPTILE_RETRIGGER} --trigger`, READY_RUN], "after the reset the backstop ran again on its own");
  assert.ok(logs.some((line) => line === "[linear-tickets] queue backstop resumes after GitHub's reset at 19:23 UTC"));
});

test("the backstop's own low-budget pause stops it before its first GitHub request and resumes at the reset (AC-3)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args.join(" ")); });
  const h = harness(t);
  h.records[0] = { ...h.records[0], branch: OPEN_PR.headBranch, links: {} };
  h.git.origin = "git@github.com:tuchel-sohn/tuchel-platform.git";
  const reset = Math.floor(h.scripts.now / 1000) + 600;
  h.scripts.budget.record(new Map([["x-ratelimit-resource", "core"], ["x-ratelimit-remaining", "260"], ["x-ratelimit-limit", "5000"], ["x-ratelimit-reset", String(reset)]]));
  await h.backstop();
  assert.deepEqual(h.scripts.runs, [], "no repo script runs");
  assert.deepEqual(h.github.listings, [], "discovery does not list the repository either");
  assert.equal(h.scripts.probes, 0, "the pause names its own reset");
  const at = new Date(reset * 1000).toISOString().slice(11, 16);
  assert.ok(logs.some((line) => line === `[linear-tickets] queue backstop waits until ${at} UTC for GitHub's core budget reset (Paused until ${at} UTC: the shared GitHub budget is low (260 left))`));
  h.scripts.now = reset * 1000 + 5_000;
  t.mock.timers.tick(605_000);
  await (await h.watch()).backstop();
  assert.ok(h.github.listings.length > 0, "once the window reset, discovery reads again");
});

test("Greptile evidence expires even on non-writers and when the script is absent (AC-4)", async (t) => {
  t.mock.method(console, "log", () => {});
  for (const dispatch of [false, true]) {
    const h = harness(t, { dispatch });
    h.scripts.greptile.present = false;
    await h.state({ [PR]: { greptile: [{ head: GREPTILE_HEAD, at: new Date(h.scripts.now - 15 * 24 * 60 * 60_000).toISOString() }] } });
    await h.backstop();
    const saved = JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8"));
    assert.equal(saved[PR].greptile, undefined);
  }
});


// TUC-1265: the ticket's connected stack #417 (on main) → #418 → #419, linked at `link`. Every
// member is READY unless `parts` (bottom first) changes it; the listing shows what the views show.
const CHAIN = [prUrl(417), prUrl(418), PR];
const CHAIN_BRANCHES = ["mtuchel/tuc-1-a", "mtuchel/tuc-1-b", "mtuchel/tuc-1-fix"];
function stackOf(h: ReturnType<typeof harness>, link: number, ...parts: Partial<PullRequestView>[]): PullRequestView[] {
  const views = CHAIN.map((_, index) => ({ ...READY, headSha: `head${index}`, headBranch: CHAIN_BRANCHES[index], baseBranch: index ? CHAIN_BRANCHES[index - 1] : "main", ...parts[index] }));
  h.records[0] = { ...h.records[0], links: { "Pull request": CHAIN[link] } };
  CHAIN.forEach((url, index) => { h.github.views[url] = views[index]; });
  h.github.view = views[link];
  h.github.open = CHAIN.flatMap((url, index) => (index === link ? [] : [listed(url, views[index], `Fix TUC-1 [plugin] Part ${index + 1}`)]));
  return views;
}
const RED = { checks: [failing("PR code")] };
const saved = async (h: ReturnType<typeof harness>) => JSON.parse(await readFile(join(await h.home(), "pr-watch.json"), "utf8")) as Record<string, { nudges?: Record<string, string[]> }>;
const prompted = (calls: string[]) => calls.filter((call) => call.startsWith("prompt ")).map((call) => /\]\((https:\/\/github\.com\/[^)]+)\)/.exec(call)?.[1]);

test("TUC-1265: a green linked pull request's connected red parent gets one repair; the link and its review mirror stay", async (t) => {
  const h = harness(t);
  const approval = { author: "ada", state: "APPROVED", submittedAt: "2026-10-07T08:00:00Z", body: "", commit: "head1" };
  stackOf(h, 2, {}, { ...RED, reviews: [approval] });
  const first = await h.poll();
  assert.deepEqual(firstLines(first), ["prompt a1", "say thought The pull request is waiting for the agent to fix the failing checks; it was asked to."], "no review of the parent is mirrored into the ticket");
  assert.ok(promptOf(first)?.startsWith(`Checks failed on the head of [the pull request](${prUrl(418)}) (\`head1\`):`), promptOf(first));
  assert.equal(h.records[0].links["Pull request"], PR, "the link stays on the green child");
  assert.deepEqual((await saved(h))[prUrl(418)].nudges, { red: ["head1"] });
  assert.equal((await saved(h))[PR].nudges, undefined);
  assert.deepEqual(await h.poll(), [], "claimed");
  stackOf(h, 2, {}, { reviews: [approval] });
  assert.deepEqual(await h.poll(), [], "the blocker cleared: nothing more, also not for the child");
});

test("TUC-1265: blocked members are repaired bottom first wherever the link sits, also above it", async (t) => {
  for (const link of [0, 1, 2]) {
    const h = harness(t);
    stackOf(h, link, RED, RED, {});
    assert.deepEqual(prompted(await h.poll()), [prUrl(417)], `linked #${417 + link}: the bottom first`);
    assert.deepEqual(prompted(await h.poll()), [prUrl(418)], `linked #${417 + link}: then the middle`);
    assert.deepEqual(await h.poll(), []);
  }
  const above = harness(t);
  stackOf(above, 0, {}, {}, RED);
  assert.deepEqual(prompted(await above.poll()), [PR], "a red member above the linked bottom is repaired too");
  const middle = harness(t);
  stackOf(middle, 0, {}, RED, {});
  assert.deepEqual(prompted(await middle.poll()), [prUrl(418)], "the linked bottom's blocked middle");
});

test("TUC-1265: only the ticket's own connected chain counts; other tickets, trunk, and broken or forked topology leave the link to itself", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const disconnected = harness(t);
  disconnected.github.view = READY;
  disconnected.github.views[prUrl(500)] = { ...READY, ...RED, headBranch: "mtuchel/tuc-1-other" };
  disconnected.github.open = [listed(prUrl(500), disconnected.github.views[prUrl(500)], "Fix TUC-1 [plugin] Elsewhere")];
  assert.deepEqual(await disconnected.poll(), [], "a same-ticket pull request off the chain");
  assert.ok(!disconnected.github.reads.includes(prUrl(500)), "and it is not even read");

  const other = harness(t);
  other.github.view = { ...READY, baseBranch: "mtuchel/tuc-10-x" };
  other.github.views[prUrl(416)] = { ...READY, ...RED, headBranch: "mtuchel/tuc-10-x" };
  other.github.open = [listed(prUrl(416), other.github.views[prUrl(416)], "Fix TUC-10 [plugin] Another ticket")];
  assert.deepEqual(await other.poll(), [], "TUC-10 is another ticket: a boundary, never a target");

  const broken: [string, (h: ReturnType<typeof harness>) => void][] = [
    ["a parent branch without an open pull request", (h) => { stackOf(h, 2, {}, {}, RED); h.github.open = h.github.open.filter((pull) => pull.number !== 418); }],
    ["two open pull requests on the parent's branch", (h) => { stackOf(h, 2, {}, RED); h.github.open.push(listed(prUrl(430), { ...READY, headBranch: CHAIN_BRANCHES[1] }, "Fix TUC-1 [plugin] Twin")); }],
    ["a fork: two of the ticket's pull requests on the middle", (h) => { stackOf(h, 2, {}, RED); h.github.open.push(listed(prUrl(431), { ...READY, headBranch: "mtuchel/tuc-1-side", baseBranch: CHAIN_BRANCHES[1] }, "Fix TUC-1 [plugin] Side")); }],
    ["a cycle", (h) => { stackOf(h, 2, {}, { ...RED, baseBranch: CHAIN_BRANCHES[2] }); h.github.open = h.github.open.filter((pull) => pull.number === 418); }],
  ];
  for (const [why, setup] of broken) {
    const h = harness(t);
    setup(h);
    const linkedRed = h.github.view.checks.some((check) => check.state === "failed");
    assert.deepEqual(prompted(await h.poll()), linkedRed ? [PR] : [], `${why}: only the link is nudged, as before`);
    const state = await saved(h);
    assert.deepEqual(Object.keys(state).filter((url) => url !== PR && state[url].nudges), [], `${why}: no member claimed`);
  }
  assert.ok(log.mock.calls.some((call) => /connected stack is deferred: the base mtuchel\/tuc-1-b of #419 has no open pull request/.test(String(call.arguments[0]))));
});

test("TUC-1265: a confirmed base conflict asks for an own-stack rebase after draft and failed checks; unknown or clean mergeability asks nothing", async (t) => {
  const h = harness(t);
  for (const mergeable of [null, "MERGEABLE"] as const) {
    h.github.view = { ...READY, mergeable };
    assert.deepEqual(await h.poll(), [], String(mergeable));
  }
  h.github.view = { ...READY, mergeable: "CONFLICTING" };
  const calls = await h.poll();
  assert.equal(promptOf(calls), [
    `GitHub reports that [the pull request](${PR}) (\`mtuchel/tuc-1-fix\` at \`a1b2c3d\`) conflicts with its base \`main\`.`,
    "Next step: rebase only your own stack onto the current `main`: this branch and your branches above it, resolving the conflicts. Run the checks your repository's AGENTS.md requires, then push and resubmit the rebased branches the way it prescribes (its review and publication rules still hold).",
    "Do not run `gt sync` or `gt restack`, never rebase, restack or push another ticket's branches, and never enqueue around this pull request's parent.",
    "",
    `${NUDGE_CLOSE}`,
  ].join("\n"));
  assert.equal(calls.at(-1), "say thought The pull request is waiting for the agent to resolve the base conflict; it was asked to.");
  assert.deepEqual(await h.poll(), [], "claimed for this head");
  await h.restart();
  assert.deepEqual(await h.poll(), [], "also after a restart");
  assert.deepEqual(h.scripts.runs, [], "no enqueue, retarget or other repo script");

  const order = harness(t);
  const changes = { author: "Mtuchel", state: "CHANGES_REQUESTED", submittedAt: "2026-10-07T09:00:00Z", body: "No.", commit: HEAD };
  order.github.view = { ...READY, isDraft: true, updatedAt: ago(60 * MINUTE), ...RED, reviews: [changes], mergeable: "CONFLICTING" };
  assert.match(promptOf(await order.poll()) ?? "", /still a draft/);
  order.github.view = { ...order.github.view, isDraft: false };
  assert.match(promptOf(await order.poll()) ?? "", /^Checks failed/);
  order.github.view = { ...order.github.view, checks: READY.checks };
  assert.match(promptOf(await order.poll()) ?? "", /conflicts with its base/, "before requested changes");
  order.github.view = { ...order.github.view, mergeable: null };
  assert.match(promptOf(await order.poll()) ?? "", /requested changes/);

  const member = harness(t);
  stackOf(member, 2, { mergeable: "CONFLICTING" });
  const memberCalls = await member.poll();
  assert.deepEqual(prompted(memberCalls), [prUrl(417)]);
  assert.match(promptOf(memberCalls) ?? "", /\(`mtuchel\/tuc-1-a` at `head0`\) conflicts with its base `main`/);
});

test("TUC-1265: base conflicts on new heads keep being nudged, every third asks for a new approach, and no count mentions the owner", async (t) => {
  const h = harness(t);
  const conflict = (head: string) => stackOf(h, 2, {}, { headSha: head, mergeable: "CONFLICTING" });
  h.paseo.answer = async () => "sent";
  conflict("c1");
  assert.match(promptOf(await h.poll()) ?? "", /pull\/418\)[^]*never just wait\.$/);
  conflict("c2");
  assert.match(promptOf(await h.poll()) ?? "", /pull\/418\)[^]*never just wait\.$/);
  conflict("c3");
  const third = await h.poll();
  assert.match(promptOf(third) ?? "", /pull\/418\)[^]*keeps stalling at this step \(nudge 3\); change your approach[^]*never just wait\.$/, "the third nudge asks for a new approach");
  await h.restart();
  conflict("c4");
  const fourth = await h.poll();
  assert.match(promptOf(fourth) ?? "", /pull\/418\)[^]*never just wait\.$/, "also after a restart");
  assert.ok(!fourth.some((call) => call.startsWith("comment")), "no restart count or nudge count mentions the owner");

  t.mock.method(console, "log", () => {});
  const waiting = harness(t);
  const start = waiting.scripts.now;
  stackOf(waiting, 2, {}, { headSha: "w1", mergeable: "CONFLICTING" });
  waiting.paseo.answer = async () => "waiting";
  assert.deepEqual(await waiting.poll(), []);
  waiting.scripts.now = start + HOUR;
  assert.deepEqual(await waiting.poll(), [`comment ${OWNER} The agent has waited over 60 minutes for your answer while [the pull request](${prUrl(418)}) waits for it to resolve the base conflict. Answer it in the ticket's thread, or take over.`]);
  await waiting.restart();
  waiting.paseo.answer = async () => "sent";
  stackOf(waiting, 2, {}, { headSha: "w2", mergeable: "CONFLICTING" });
  const nudged = await waiting.poll();
  assert.ok((promptOf(nudged) ?? "").endsWith(`\n\n${NUDGE_CLOSE}`), "a new head of the stage is nudged again; no second mention for it");
  assert.equal(nudged.at(-1), "say thought The pull request is waiting for the agent to resolve the base conflict; it was asked to.");
});

test("TUC-1265: a hold anywhere on the stack defers its connected repair without any claim, and one repair goes out once it clears", async (t) => {
  t.mock.method(console, "error", () => {});
  const member = { reviewedAt: null, decision: null, merged: false };
  const holds: [string, (h: ReturnType<typeof harness>) => Promise<void> | void][] = [
    ["a veto on another member", (h) => { stackOf(h, 2, { labels: ["do-not-merge"] }, RED); }],
    ["an explicit drop escalation", (h) => h.state({ [prUrl(417)]: { ...member, escalated: true } })],
    ["a pending drop message", (h) => h.state({ [prUrl(417)]: { ...member, pending: { key: "#9", reason: "conflict", facts: "", fix: "Restack." } } })],
    ["a head held after a genuine drop", (h) => h.state({ [prUrl(417)]: { ...member, blockedAt: "head0" } })],
    ["an unreadable member", (h) => { h.github.broken.push(prUrl(417)); }],
    ["a head the listing does not show", (h) => { h.github.open = h.github.open.map((pull) => (pull.number === 417 ? { ...pull, headSha: "older" } : pull)); }],
    ["a base the listing does not show", (h) => { h.github.views[prUrl(418)] = { ...h.github.views[prUrl(418)], baseBranch: "main" }; }],
    ["another ticket's record linking a member", (h) => { h.records.push({ ...h.records[0], issueId: "i2", identifier: "TUC-2", agentId: "a2", links: { "Pull request": prUrl(417) } }); }],
    ["an open manual task", (h) => { h.blockers.push("TUC-9"); }],
    ["unreadable manual tasks", (h) => { h.gate.unreadable = true; }],
    ["a busy agent", (h) => { h.paseo.answer = async () => "busy"; }],
    ["the merge queue holding the blocked member", (h) => { stackOf(h, 2, {}, { ...RED, mergeActivity: activity(QUEUED) }); }],
  ];
  for (const [why, hold] of holds) {
    const h = harness(t);
    stackOf(h, 2, {}, RED);
    await hold(h);
    assert.deepEqual(await h.poll(), [], why);
    assert.equal((await saved(h))[prUrl(418)]?.nudges, undefined, `${why}: nothing claimed`);
    stackOf(h, 2, {}, RED);
    h.records.splice(1);
    h.blockers.length = 0;
    h.gate.unreadable = false;
    h.github.broken.length = 0;
    h.paseo.answer = async () => "sent";
    await h.state({});
    assert.deepEqual(prompted(await h.poll()), [prUrl(418)], `${why} cleared: one repair`);
    assert.deepEqual(await h.poll(), [], `${why} cleared: once`);
  }
  const gone = harness(t, { live: false });
  stackOf(gone, 2, {}, RED);
  const calls = await gone.poll();
  assert.equal(calls[0], "move In Progress");
  assert.ok(calls[1].includes(`Checks failed on the head of [the pull request](${prUrl(418)})`), "a gone agent's repair goes to the ticket");
});

test("TUC-1265: an old stage's nudges never exhaust it: its next new head is nudged, and the stack's other members follow on the next poll", async (t) => {
  const h = harness(t);
  h.paseo.answer = async () => "sent";
  // State the old plugin left: three nudges of the middle's red stage (its whole budget then).
  await h.state({ [prUrl(418)]: { reviewedAt: null, decision: null, merged: false, nudges: { red: ["x1", "x2", "x3"] } } });
  stackOf(h, 2, {}, { ...RED, headSha: "x4" }, RED);
  assert.deepEqual(prompted(await h.poll()), [prUrl(418)], "the old cap does not stop the next new head's nudge");
  assert.deepEqual(prompted(await h.poll()), [PR], "and the other members are reached on the next poll");
  await h.restart();
  stackOf(h, 2, {}, { ...RED, headSha: "x5" }, RED);
  assert.deepEqual(prompted(await h.poll()), [prUrl(418)], "also after a restart, on the stage's next new head");
  assert.deepEqual((await saved(h))[prUrl(418)].nudges, { red: ["x1", "x2", "x3", "x4", "x5"] });
});

test("TUC-1265: green members sharing a blocked parent get one repair from one listing, and members never move the ticket's link or state", async (t) => {
  const h = harness(t);
  const approval = { author: "ada", state: "APPROVED", submittedAt: "2026-10-07T08:00:00Z", body: "", commit: "head0" };
  stackOf(h, 2, { ...RED, reviews: [approval] });
  h.records.push({ ...h.records[0], agentId: "a2", links: { "Pull request": prUrl(418) } });
  const calls = await h.poll();
  assert.deepEqual(prompted(calls), [prUrl(417)], "one repair for both green descendants");
  assert.deepEqual(h.github.listings, ["tuchel-sohn/tuchel-platform"], "one open listing per repo and poll");
  assert.ok(!calls.some((call) => call.startsWith("review ") || call.startsWith("move ")), "the parent's approval is not mirrored");
  assert.deepEqual((await saved(h))[prUrl(417)].nudges, { red: ["head0"] });
  assert.deepEqual(await h.poll(), []);
  h.records.splice(1);
  stackOf(h, 2);
  h.github.open = h.github.open.filter((pull) => pull.number !== 417);
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await h.poll(), [], "the parent closed: nothing merged, reviewed or relinked");
  assert.equal(h.records[0].links["Pull request"], PR);
});

test("TUC-1265: a linked pull request whose title names no ticket keeps linked-only nudges and never targets a sibling", async (t) => {
  const h = harness(t);
  h.github.title = "The solver plans Aufbereitungen";
  h.github.view = { ...READY, baseBranch: "aufbereitung-a" };
  h.github.views[prUrl(417)] = { ...READY, ...RED, headBranch: "aufbereitung-a" };
  h.github.open = [listed(prUrl(417), h.github.views[prUrl(417)], "The solver plans Aufbereitungen (part 1)")];
  assert.deepEqual(await h.poll(), []);
  assert.deepEqual(h.github.reads, [PR], "the sibling is not read");
  h.github.view = { ...h.github.view, ...RED };
  assert.deepEqual(prompted(await h.poll()), [PR], "the link itself is still nudged");
});

test("TUC-1265: an agent waiting for the owner holds the whole stack's repairs, and the owner is reminded of one wait", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t);
  const start = h.scripts.now;
  stackOf(h, 2, RED, RED);
  h.paseo.answer = async () => "waiting";
  assert.deepEqual(await h.poll(), []);
  h.scripts.now = start + HOUR;
  assert.deepEqual(await h.poll(), [`comment ${OWNER} The agent has waited over 60 minutes for your answer while [the pull request](${prUrl(417)}) waits for it to fix the failing checks. Answer it in the ticket's thread, or take over.`], "only the bottom's wait");
  const state = await saved(h);
  assert.equal(state[prUrl(418)]?.nudges, undefined, "the middle was not even tried");
  h.paseo.answer = async () => "sent";
  assert.deepEqual(prompted(await h.poll()), [prUrl(418)], "the bottom's waited-out stall is claimed; the middle goes next");
});

test("TUC-1265: a member the stack held back starts its permission wait from zero once the hold lifts", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const h = harness(t);
  const start = h.scripts.now;
  stackOf(h, 2, {}, RED);
  h.paseo.answer = async () => "waiting";
  assert.deepEqual(await h.poll(), [], "the middle's wait starts");
  stackOf(h, 2, { labels: ["do-not-merge"] }, RED);
  h.scripts.now = start + 30 * MINUTE;
  assert.deepEqual(await h.poll(), [], "vetoed: the stack is deferred");
  stackOf(h, 2, {}, RED);
  h.scripts.now = start + HOUR;
  assert.deepEqual(await h.poll(), [], "the veto lifted: the wait starts again instead of reminding the owner");
  h.scripts.now = start + 2 * HOUR;
  assert.equal(count(await h.poll(), `comment ${OWNER} The agent has waited over 60 minutes`), 1);
});

test("TUC-1265: members compare by repo and number whatever the URL's spelling, and a fork's same-named branch is never a member", async (t) => {
  t.mock.method(console, "error", () => {});
  const mixed = (number: number) => `https://github.com/Tuchel-Sohn/tuchel-platform/pull/${number}`;
  const spelled = (h: ReturnType<typeof harness>) => {
    stackOf(h, 2, {}, RED);
    h.records[0] = { ...h.records[0], links: { "Pull request": mixed(419) } };
    h.github.open.push(listed(PR, h.github.view));
    for (const number of [417, 418]) h.github.views[mixed(number)] = h.github.views[prUrl(number)];
  };
  const plain = harness(t);
  spelled(plain);
  assert.deepEqual(prompted(await plain.poll()), [mixed(418)], "a differently spelled link still finds its stack");
  const owned = harness(t);
  spelled(owned);
  owned.records.push({ ...owned.records[0], issueId: "i2", identifier: "TUC-2", agentId: "a2", links: { "Pull request": prUrl(418) } });
  assert.ok(!(await owned.poll()).some((call) => call.startsWith("prompt a1")), "the parent is TUC-2's linked pull request: never TUC-1's agent's");
  const escalatedSpelling = harness(t);
  spelled(escalatedSpelling);
  await escalatedSpelling.state({ [prUrl(417)]: { reviewedAt: null, decision: null, merged: false, escalated: true } });
  assert.deepEqual(await escalatedSpelling.poll(), [], "an escalation saved under another spelling still holds the stack");

  const fork = harness(t);
  stackOf(fork, 2, {}, RED);
  fork.github.open.push(listed(prUrl(440), { ...READY, ...RED, headBranch: CHAIN_BRANCHES[1], baseBranch: CHAIN_BRANCHES[0] }, "Fix TUC-1 [plugin] From a fork", "someone/tuchel-platform"));
  assert.deepEqual(prompted(await fork.poll()), [prUrl(418)], "the fork's branch of the same name neither joins nor breaks the stack");
  assert.deepEqual(prompted(await fork.poll()), []);
  const orphan = harness(t);
  stackOf(orphan, 2, {}, RED);
  orphan.github.open = [listed(prUrl(417), orphan.github.views[prUrl(417)], "Fix TUC-1 [plugin] Part 1"), listed(prUrl(440), { ...READY, ...RED, headBranch: CHAIN_BRANCHES[1], baseBranch: CHAIN_BRANCHES[0] }, "Fix TUC-1 [plugin] From a fork", "someone/tuchel-platform")];
  assert.deepEqual(await orphan.poll(), [], "with the repo's own parent gone, a fork's same-named branch is no parent");
  assert.ok(!orphan.github.reads.includes(prUrl(440)));
});

test("every poll checks the waits the plugin recorded for the owner; a failure there is logged and never ends the poll", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const h = harness(t);
  await h.poll();
  assert.equal(h.waits.runs, 1);
  await h.poll();
  assert.equal(h.waits.runs, 2);
  h.waits.failure = new Error("Linear is unreachable");
  await h.poll();
  assert.equal(h.waits.runs, 3);
  assert.ok(errors.mock.calls.some((call) => /closing left-behind owner waits failed: Linear is unreachable/.test(String(call.arguments[0]))));
});
// --- One host per ticket and one per repo (TUC-538) ----------------------------------------------

const AGENT_URL = (server: string, agent = "a9") => `https://app.paseo.sh/h/${server}/agent/${agent}`;
const countLogs = (logs: { mock: { calls: { arguments: unknown[] }[] } }, pattern: RegExp) =>
  logs.mock.calls.filter((call) => pattern.test(String(call.arguments[0]))).length;
const readState = async (home: string) => JSON.parse(await readFile(join(home, "pr-watch.json"), "utf8")) as Record<string, { drops?: string[]; blockedAt?: string }>;

test("a ticket another host owns is not polled, routed, nudged or succeeded here; its record and its history stay (TUC-538)", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  // The laptop's settings: the tickets moved to server087, and the repo-wide queue half too.
  const h = harness(t, { owner: "none", backstop: "auto", dispatch: false });
  // A drop of its pull request, and a second record with no link for the backstop to discover.
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  h.github.drafts = [draft(437, [419])];
  h.records.push({ ...h.records[0], issueId: "i2", identifier: "TUC-2", agentId: "a2", links: {}, branch: "mtuchel/tuc-2" });
  // The state an earlier host left: kept as it is, never read, routed or cleared.
  await h.state({ [PR]: { reviewedAt: null, decision: null, merged: false, drops: ["#437"], blockedAt: HEAD } });
  const skipped = /tickets? of this host's records belong to another host; their pull requests are not polled here/;
  assert.deepEqual(await h.poll(), [], "no drop request, no nudge, no ticket message");
  assert.deepEqual(h.github.reads, [], "its pull request is not read");
  assert.deepEqual(h.github.listings, [], "not even the repository is listed");
  assert.deepEqual(await h.backstop(), [], "and the backstop neither discovers it nor scans for it");
  assert.deepEqual(h.github.listings, []);
  assert.deepEqual(h.scripts.runs, []);
  assert.equal(countLogs(logs, skipped), 1);
  assert.equal(countLogs(logs, /which host owns the ticket could not be told/), 0, "the ownership was told, it was not unknown");
  await h.poll();
  assert.equal(countLogs(logs, skipped), 1, "the count is logged once");
  assert.deepEqual(h.records.map((record) => record.identifier), ["TUC-1", "TUC-2"], "the records are kept, not deleted");
  assert.deepEqual((await readState(await h.home()))[PR], { reviewedAt: null, decision: null, merged: false, drops: ["#437"], blockedAt: HEAD }, "so is the history of its pull request");
  // The same poll on the host that owns the ticket is unchanged.
  const owned = harness(t);
  owned.github.view = { ...READY, mergeActivity: activity(QUEUED, running(437), REMOVED) };
  owned.github.drafts = [draft(437, [419])];
  assert.match(promptOf(await owned.poll()) ?? "", /Fix the cause/, "the ticket's own host still routes the drop to its agent");
  assert.deepEqual(owned.github.reads, [PR]);
});

test("an unknowable owner keeps watching (fail open), once logged; the ticket's agent link decides when it can (TUC-538)", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const open = harness(t, { owner: "unknown" });
  await open.poll();
  assert.deepEqual(open.github.reads, [PR], "nothing readable: the ticket stays watched");
  assert.equal(countLogs(logs, /which host owns the ticket could not be told; its pull requests stay watched here/), 1);
  await open.poll();
  assert.equal(countLogs(logs, /which host owns the ticket could not be told/), 1, "logged once");
  // The fallback evidence: the ticket's `Paseo agent` attachment names the host of its newest agent.
  const foreign = harness(t, { owner: "unknown" });
  foreign.linear.attachments = [AGENT_URL("srv_other")];
  assert.deepEqual(await foreign.poll(), []);
  assert.deepEqual(foreign.github.reads, [], "another host's agent runs the ticket: not watched here");
  assert.deepEqual(foreign.linear.issueReads, ["i1"], "read once");
  const mine = harness(t, { owner: "unknown" });
  mine.linear.attachments = [AGENT_URL(mine.server.id, "a1")];
  await mine.poll();
  assert.deepEqual(mine.github.reads, [PR], "this host's own agent: watched as before");
  const broken = harness(t, { owner: "throws" });
  await broken.poll();
  assert.deepEqual(broken.github.reads, [PR], "a failed ownership read keeps watching");
  const unreadable = harness(t, { owner: "unknown" });
  unreadable.linear.issueFailure = new Error("Linear is unavailable");
  await unreadable.poll();
  assert.deepEqual(unreadable.github.reads, [PR], "an unreadable agent link keeps watching");
});

test("the repo-wide half of the queue backstop runs on one host per repo; each host still enqueues what its own tickets claimed (AC-3)", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  // The laptop's settings: auto-dispatch off, so `auto` leaves the repo-wide half to server087.
  const laptop = harness(t, { backstop: "auto", dispatch: false });
  laptop.scripts.ready = { stacks: [STACK], drops: [] };
  assert.deepEqual(await laptop.backstop(), [], "no ready stack is enqueued");
  assert.deepEqual(laptop.scripts.runs, [], "not even the repository's own listing runs");
  assert.deepEqual(laptop.github.listings, [], "and the repository is not read for it");
  assert.equal(countLogs(logs, /queue backstop: the repo-wide half runs on the backstop host only \(backstop.run is auto and auto-dispatch is off here\); this host follows up its own enqueues/), 1);
  await laptop.backstop();
  assert.equal(countLogs(logs, /queue backstop: the repo-wide half runs on the backstop host only/), 1, "logged once");
  // A drop the poll claimed for this host's own ticket is still enqueued here: only the repo-wide
  // half moved to the backstop host.
  const h = harness(t, { backstop: "never" });
  const bullets = bulletsOf(h, {}, QUEUED, running(437), REMOVED);
  h.github.drafts = [draft(437, [419])];
  h.scripts.judgment = FLAKY;
  h.scripts.onEnqueue = async () => bullets.add(QUEUED);
  assert.deepEqual(await h.poll(), [], "the flaky drop needs nothing from the agent");
  assert.deepEqual(firstLines(await h.backstop()), [`enqueue mtuchel/tuc-1-fix --expect 419@${HEAD} --action drop:#437:419`, `pr comment #419 ${ENQUEUED}`, `${"comment"} ${ENQUEUED}`, "prompt a1"]);
  assert.deepEqual(h.scripts.runs, [enqueueRun("drop:#437:419")], "its own range, and no repository listing");
  // `always` pins the repo-wide half to a host whose dispatch is off.
  const server = harness(t, { backstop: "always", dispatch: false });
  server.scripts.ready = { stacks: [STACK], drops: [] };
  await server.backstop();
  assert.deepEqual(server.scripts.runs, [READY_RUN, enqueueRun(STACK.action)]);
  // And a host that owns none of the repo's tickets does not discover their pull requests; the
  // repo-wide half it drives is the backstop host's own work.
  const foreign = harness(t, { owner: "none" });
  foreign.scripts.ready = { stacks: [], drops: [] };
  foreign.records.push({ ...foreign.records[0], issueId: "i2", identifier: "TUC-2", links: {}, branch: "mtuchel/tuc-2" });
  foreign.linear.attachments = [prUrl(2000)];
  await foreign.state({ [prUrl(2000)]: { reviewedAt: null, decision: null, merged: false } });
  await foreign.backstop();
  assert.deepEqual(foreign.linear.issueReads, [], "no discovery of another host's ticket");
  assert.deepEqual(foreign.scripts.runs, [READY_RUN], "while the repo-wide half it drives still runs");
});

// --- The owner's stack policy (2026-10-09): the cap and the reopen of Done tickets ----------------

// The harness fakes a stack of test pull requests is built from.
type StackFixture = {
  github: { view: PullRequestView; views: Record<string, PullRequestView>; open: OpenPull[] };
  records: HandoverRecord[];
};

// A chain of `count` draft pull requests naming TUC-1, bottom first, its lowest branch based on
// main, with the ticket's link on the top one. `updatedAt` is now, so no draft stage is stalled.
function draftStack(h: StackFixture, count: number) {
  const branches = Array.from({ length: count }, (_, index) => `mtuchel/tuc-1-${String.fromCharCode(97 + index)}`);
  const now = new Date().toISOString();
  const views = branches.map((headBranch, index) => ({
    ...OPEN_PR, isDraft: true, updatedAt: now, lastCommitAt: now, headSha: `head${index}`, headBranch, baseBranch: index ? branches[index - 1] : "main",
  }));
  const urls = views.map((_, index) => prUrl(420 + index));
  views.forEach((view, index) => { h.github.views[urls[index]] = view; });
  h.records[0] = { ...h.records[0], branch: branches[count - 1], links: { "Pull request": urls[count - 1] } };
  h.github.view = views[count - 1];
  h.github.open = views.slice(0, -1).map((view, index) => listed(urls[index], view, `Fix TUC-1 [plugin] Part ${index + 1}`));
  return { urls, views };
}

test("the stack cap asks an over-cap ticket's agent once per stack to land the bottom range", async (t) => {
  const h = harness(t);
  const { urls } = draftStack(h, 4);
  const calls = await h.poll();
  const prompt = promptOf(calls) ?? "";
  assert.ok(prompt.startsWith(`The ticket's stack has 4 open pull requests (bottom first: [#420](${urls[0]}) \`mtuchel/tuc-1-a\`, [#421](${urls[1]}) \`mtuchel/tuc-1-b\`, [#422](${urls[2]}) \`mtuchel/tuc-1-c\`, [#423](${urls[3]}) \`mtuchel/tuc-1-d\`); the owner's policy allows at most 3 unlanded at a time.`), prompt);
  assert.match(prompt, /Land the reviewed bottom range before stacking more: publish it bottom first from the top branch of the reviewed range \(`git switch <that branch> && node tools\/ci\/publish\.mjs`/);
  assert.match(prompt, /`node tools\/ci\/enqueue\.mjs` and `wait-queue\.mjs`/);
  assert.match(prompt, /Never close or split a pull request for the cap, and add no new branch until the bottom range lands; review is never waived\./);
  assert.ok(prompt.endsWith(`${OWNER_POLICY}; never because of the count.`), "the owner policy closes it, with no count handover");
  assert.ok(!prompt.includes(OWNER), "no owner mention");
  assert.ok(calls.includes("say thought The agent was asked to land the reviewed bottom range before stacking more."));
  assert.deepEqual(await h.poll(), [], "the same stack is not asked twice");
  // The claim is the stack's signature: a new head is a changed stack and is asked again.
  h.github.open[0] = { ...h.github.open[0], headSha: "moved-on" };
  assert.match(promptOf(await h.poll()) ?? "", /^The ticket's stack has 4 open pull requests/);
  // A stack of three is allowed: nothing is sent.
  const atCap = harness(t);
  draftStack(atCap, 3);
  assert.deepEqual(await atCap.poll(), [], "three open pull requests are allowed");
});

test("the stack cap leaves a bottom that is published or already in the queue alone, reading no pull request of its own", async (t) => {
  // Four same-ticket pull requests off one chain, so this poll reads only its link: the cap decides
  // on the listing and Graphite's drafts, never with a pull request read.
  const shaped = (h: StackFixture) => {
    const urls = [0, 1, 2, 3].map((index) => prUrl(420 + index));
    const now = new Date().toISOString();
    urls.forEach((url, index) => { h.github.views[url] = { ...OPEN_PR, isDraft: true, updatedAt: now, lastCommitAt: now, headBranch: `mtuchel/tuc-1-${index}`, headSha: `head${index}` }; });
    h.records[0] = { ...h.records[0], branch: null, links: { "Pull request": urls[3] } };
    h.github.view = h.github.views[urls[3]];
    h.github.open = urls.slice(0, 3).map((url, index) => listed(url, h.github.views[url], `Fix TUC-1 [plugin] Part ${index + 1}`));
    return urls;
  };
  const published = harness(t);
  const urls = shaped(published);
  // The bottom is published (not a draft): its own lifecycle steps and the queue backstop's ready
  // rule own it, so the cap says nothing.
  published.github.open[0] = { ...published.github.open[0], draft: false };
  assert.deepEqual(await published.poll(), [], "a published bottom needs no message");
  assert.deepEqual(published.github.reads, [urls[3]], "and the cap read no pull request of its own");
  const draftBottom = harness(t);
  const drafts = shaped(draftBottom);
  assert.match(promptOf(await draftBottom.poll()) ?? "", /^The ticket's stack has 4 open pull requests/, "a draft bottom is asked");
  assert.deepEqual(draftBottom.github.reads, [drafts[3]], "still no read of its own");
  const queued = harness(t);
  const held = shaped(queued);
  queued.github.drafts = [draft(437, [420], "OPEN")];
  assert.deepEqual(await queued.poll(), [], "the queue holds the bottom already");
  assert.deepEqual(queued.github.reads, [held[3]]);
});

test("the cap message is a nudge: a gone agent's message starts a successor, a busy one waits", async (t) => {
  t.mock.method(console, "log", () => {});
  const gone = harness(t, { live: false, autoResume: true });
  draftStack(gone, 4);
  gone.paseo.succeed = startSuccessor;
  const calls = await gone.poll();
  assert.match(calls[0], /^succeed a1\nThe ticket's stack has 4 open pull requests/);
  assert.equal(calls[1], "say thought The agent was gone; Paseo started a successor (agent s2a2b3c4) on mtuchel/tuc-1-d and asked it to land the reviewed bottom range before stacking more.");
  assert.deepEqual(await gone.poll(), [], "claimed once");
  const busy = harness(t);
  draftStack(busy, 4);
  busy.paseo.answer = async () => "busy";
  assert.deepEqual(await busy.poll(), [], "a busy agent claims nothing");
  busy.paseo.answer = async () => "sent";
  assert.match(promptOf(await busy.poll()) ?? "", /^The ticket's stack has 4 open pull requests/, "asked on the next poll");
});

test("a Done ticket with open pull requests goes back to work once per completion, and its gone agent starts a successor", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { live: false, autoResume: true });
  h.linear.state = { status: "Done", statusType: "completed" };
  h.linear.completedAt = "2026-10-09T08:49:39.000Z";
  const { urls } = draftStack(h, 2);
  h.paseo.succeed = startSuccessor;
  const calls = await h.poll();
  assert.ok(calls.includes("reopen"), "the ticket is moved back to its coding state");
  assert.equal(h.linear.state.statusType, "started");
  const comment = calls.find((call) => call.startsWith("comment This ticket was in Done"));
  assert.ok(comment?.includes(`2 pull requests of its stack were still open and unlanded: [#420](${urls[0]}), [#421](${urls[1]}).`), comment);
  assert.match(comment ?? "", /`stack-policy:reopen:TUC-1:2026-10-09T08:49:39\.000Z`$/, "found by its mark on a retry");
  assert.match(calls.find((call) => call.startsWith("succeed a1")) ?? "", /^succeed a1\nThis ticket was in Done, but its stack has not landed: \[#420\]/);
  assert.equal(calls.find((call) => call.startsWith("say thought The agent was gone;"))?.includes("land the pull requests of its stack that are still open"), true);
  assert.deepEqual(await h.poll(), [], "decided once per completion: nothing on the next poll");
  // The three steps are recorded, so an interrupted reopen is finished without repeating them.
  const saved = JSON.parse(await h.policyFile()).i1.reopen;
  assert.equal(saved.completedAt, "2026-10-09T08:49:39.000Z");
  assert.equal(saved.moved, true);
  assert.equal(saved.commented, true);
  assert.equal(saved.message, undefined, "the notice went out");
  assert.equal(saved.sending, undefined);
  // Only the host that owns the ticket reopens it (README, "Several hosts").
  const foreign = harness(t, { owner: "none" });
  foreign.linear.state = { status: "Done", statusType: "completed" };
  draftStack(foreign, 1);
  assert.deepEqual(await foreign.poll(), [], "another host's ticket");
  assert.equal(await foreign.policyFile(), "", "and nothing is recorded for it");
});

test("a ticket moved to Done again after a reopen stays Done, logged once", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const h = harness(t, { live: false, autoResume: true });
  h.linear.state = { status: "Done", statusType: "completed" };
  h.linear.completedAt = "2026-10-09T08:49:39.000Z";
  draftStack(h, 1);
  h.paseo.succeed = startSuccessor;
  await h.poll();
  assert.equal(h.linear.state.statusType, "started", "reopened");
  // The owner moves it to Done again: respected, and the log says so once.
  h.linear.state = { status: "Done", statusType: "completed" };
  h.linear.completedAt = "2026-10-09T09:30:00.000Z";
  assert.deepEqual(await h.poll(), [], "respected: the ticket stays Done");
  assert.equal(countLogs(logs, /TUC-1: it was moved to Done again after Paseo reopened it; it stays there and is not reopened again/), 1);
  const before = logs.mock.calls.length;
  assert.deepEqual(await h.poll(), [], "nothing new");
  assert.deepEqual(await h.poll(), [], "also with a plugin restart");
  await h.restart();
  assert.deepEqual(await h.poll(), []);
  assert.equal(logs.mock.calls.length, before, "logged once");
  assert.deepEqual(JSON.parse(await h.policyFile()).i1.reopen.respected, true);
});

test("a canceled or duplicate ticket is never reopened, and neither is one whose open pull requests are all vetoed", async (t) => {
  for (const [status, statusType] of [["Canceled", "canceled"], ["Duplicate", "duplicate"]] as const) {
    const h = harness(t);
    h.linear.state = { status, statusType };
    draftStack(h, 1);
    assert.deepEqual(await h.poll(), [], status);
  }
  const vetoed = harness(t);
  vetoed.linear.state = { status: "Done", statusType: "completed" };
  draftStack(vetoed, 1);
  vetoed.github.view = { ...vetoed.github.view, labels: ["do-not-merge"] };
  vetoed.github.open = vetoed.github.open.map((pull) => ({ ...pull, labels: ["do-not-merge"] }));
  assert.deepEqual(await vetoed.poll(), [], "do-not-merge only: nothing to land");
});

test("at most three Done tickets are reopened per poll", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t);
  const [first] = h.records;
  h.records.length = 0;
  for (const index of [0, 1, 2, 3]) {
    const url = prUrl(430 + index);
    h.github.views[url] = { ...OPEN_PR, isDraft: true, updatedAt: new Date().toISOString(), lastCommitAt: new Date().toISOString(), headBranch: `mtuchel/tuc-${index + 1}`, headSha: `head${index}` };
    h.github.open.push(listed(url, h.github.views[url], `Fix TUC-${index + 1} [plugin] Work`));
    h.records.push({ ...first, issueId: `i${index}`, identifier: `TUC-${index + 1}`, agentId: `a${index + 1}`, branch: `mtuchel/tuc-${index + 1}`, links: { "Pull request": url } });
    h.linear.byIssue[`i${index}`] = { status: "Done", statusType: "completed" };
  }
  h.github.view = { ...OPEN_PR, state: "CLOSED" };
  h.linear.completedAt = "2026-10-09T08:00:00.000Z";
  const reopened = await h.poll();
  assert.equal(count(reopened, "reopen"), 3, "three of the four Done tickets, no more");
  assert.equal(count(reopened, "prompt a1"), 1, "each gets its own agent, one message per agent");
  const rest = await h.poll();
  assert.equal(count(rest, "reopen"), 1, "the fourth follows on the next poll");
  assert.deepEqual(await h.poll(), [], "then nothing");
});

// Seen live on 2026-10-09: three reopened tickets whose agents were busy held their notices, and
// counting those undelivered notices used up every later poll, so no other ticket was reopened or
// asked again. A notice that did not go out keeps waiting without holding the others back.
test("busy agents' undelivered policy messages do not use up the poll for the other tickets", async (t) => {
  t.mock.method(console, "log", () => {});
  const build = (state: { status: string; statusType: string }) => {
    const h = harness(t);
    const [first] = h.records;
    h.records.length = 0;
    for (const index of [0, 1, 2, 3]) {
      const urls = [0, 1, 2, 3].map((part) => prUrl(500 + index * 10 + part));
      const now = new Date().toISOString();
      urls.forEach((url, part) => {
        h.github.views[url] = { ...OPEN_PR, isDraft: true, updatedAt: now, lastCommitAt: now, headBranch: `mtuchel/tuc-${index + 1}-${part}`, headSha: `head${index}${part}` };
        h.github.open.push(listed(url, h.github.views[url], `Fix TUC-${index + 1} [plugin] Part ${part + 1}`));
      });
      h.records.push({ ...first, issueId: `i${index}`, identifier: `TUC-${index + 1}`, agentId: `a${index + 1}`, branch: `mtuchel/tuc-${index + 1}-3`, links: { "Pull request": urls[3] } });
      h.linear.byIssue[`i${index}`] = { ...state };
    }
    h.github.view = { ...OPEN_PR, state: "CLOSED" };
    h.linear.completedAt = "2026-10-09T08:00:00.000Z";
    // The first three agents are busy; the fourth takes messages.
    h.paseo.answer = async (agentId?: string) => (agentId === "a4" ? "sent" : "busy");
    return h;
  };
  const reopen = build({ status: "Done", statusType: "completed" });
  assert.equal(count(await reopen.poll(), "reopen"), 3, "the moves of the first three count");
  const next = await reopen.poll();
  assert.equal(count(next, "reopen"), 1, "the busy agents' pending notices do not hold the fourth ticket back");
  assert.equal(count(next, "prompt a4"), 1, "and the fourth ticket's agent gets its notice");
  const cap = build({ status: "In Progress", statusType: "started" });
  assert.equal(count(await cap.poll(), "prompt a4"), 1, "an over-cap stack behind three busy agents is asked in the same poll");
});

test("a Done ticket's reopen reaches an archived agent as a successor and a crashed one with its restart", async (t) => {
  t.mock.method(console, "log", () => {});
  const archived = harness(t, { status: "archived", autoResume: true });
  archived.linear.state = { status: "Done", statusType: "completed" };
  draftStack(archived, 1);
  archived.paseo.succeed = startSuccessor;
  const archivedCalls = await archived.poll();
  assert.ok(archivedCalls.includes("reopen"));
  assert.ok(archivedCalls.some((call) => call.startsWith("succeed a1\nThis ticket was in Done")), "no prompt: an archived agent is gone by definition");
  assert.ok(!archivedCalls.some((call) => call.startsWith("prompt a1")), "never sent to the archived agent's session");

  const crashed = harness(t, { crash: true });
  crashed.linear.state = { status: "Done", statusType: "completed" };
  draftStack(crashed, 1);
  const crashedCalls = await crashed.poll();
  assert.ok(crashedCalls.includes("reopen"));
  assert.ok(crashedCalls.includes("reload a1"), "the crashed agent is restarted with the notice as its resume");
  assert.match(promptOf(crashedCalls) ?? "", /Your previous run crashed[\s\S]*This ticket was in Done, but its stack has not landed/);
  assert.equal(JSON.parse(await crashed.crashFile()).a1.resume, null, "the notice went out, so the resume is cleared");
});

test("a Done ticket whose only open pull request is the merge queue's own draft is not reopened", async (t) => {
  const h = harness(t);
  h.linear.state = { status: "Done", statusType: "completed" };
  draftStack(h, 1);
  // The queue's draft is open in the repository, but it is Graphite's, not the ticket's: it never
  // counts as an unlanded pull request of the stack.
  h.github.open = [{ ...h.github.open[0], title: "[Graphite MQ] Draft PR GROUP:spec_437 (PRs 420)" }];
  assert.deepEqual(await h.poll(), [], "nothing to land: the queue manages its own draft");
});

test("an interrupted reopen finishes its remaining steps on the next poll", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = harness(t, { live: false, autoResume: true });
  draftStack(h, 1);
  h.paseo.succeed = startSuccessor;
  // The plugin stopped after the move: the comment and the notice are still due, the move is not.
  await writeFile(join(await h.home(), "stack-policy.json"), JSON.stringify({
    i1: { reopen: { completedAt: "2026-10-09T08:49:39.000Z", at: new Date().toISOString(), moved: true, comment: "This ticket was in Done while its stack was open.", message: "This ticket was in Done, but its stack has not landed." } },
  }));
  const calls = await h.poll();
  assert.ok(!calls.includes("reopen"), "the move already went through");
  assert.ok(calls.some((call) => call === "comment This ticket was in Done while its stack was open.\n\n`stack-policy:reopen:TUC-1:2026-10-09T08:49:39.000Z`"), "the comment goes out once, found by its mark");
  assert.match(calls.find((call) => call.startsWith("succeed a1")) ?? "", /^succeed a1\nThis ticket was in Done, but its stack has not landed\./);
  assert.deepEqual(await h.poll(), [], "finished");
  // Its save may be lost right after Linear took the comment: the mark on the ticket finds it and
  // the notice still goes out.
  const lost = harness(t, { live: false, autoResume: true });
  draftStack(lost, 1);
  lost.paseo.succeed = startSuccessor;
  const comment = "This ticket was in Done while its stack was open.";
  await writeFile(join(await lost.home(), "stack-policy.json"), JSON.stringify({
    i1: { reopen: { completedAt: "2026-10-09T08:49:39.000Z", at: new Date().toISOString(), moved: true, comment, message: "This ticket was in Done, but its stack has not landed." } },
  }));
  lost.linear.comments.i1 = [`${comment}\n\n\`stack-policy:reopen:TUC-1:2026-10-09T08:49:39.000Z\``];
  const again = await lost.poll();
  assert.ok(!again.some((call) => call.startsWith("comment")), "the comment is found by its mark, not repeated");
  assert.match(again.find((call) => call.startsWith("succeed a1")) ?? "", /^succeed a1\nThis ticket was in Done, but its stack has not landed\./);
});

// TUC-999/728/1322 on server087: planners idle since 2026-10-07 in the main checkout (configured
// `core.bare`, so Git cannot name its repository), no linked pull request, no pull request
// attachments. Their open pull requests were "cannot be read" on every judgement, so the watchdog
// never resumed them.
test("the watchdog resumes an idle agent whose ticket names no repository and no pull request; a failed pull request read still vetoes", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const quietSince = Date.now() - 3 * 60 * 60_000;
  const root = {
    id: "a1", provider: "omp", cwd: "/home/mirko/paseo/tuchel-platform", status: "idle", activeTurn: null,
    createdAt: new Date(quietSince).toISOString(), updatedAt: new Date(quietSince).toISOString(), lastUserMessageAt: null,
    pendingPermissions: [], title: "TUC-1: plan", labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" },
    persistence: { provider: "omp", sessionId: "native-a1", nativeHandle: "/sessions/a1.jsonl" },
  } as unknown as WatchedAgent;
  // `origin`: the worktree's GitHub origin (none: Git cannot name it); `listing`, `attachments`:
  // what reading the repository's open pull requests or the ticket's attachments throws.
  const judge = async (read: { origin?: string; listing?: Error; attachments?: Error } = {}) => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-pr-watch-watchdog-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const acts: string[] = [];
    let watchdog: Watchdog | null = null;
    const h = harness(t, { watchdog: { pass: (poll) => watchdog!.pass(poll), stop: () => watchdog!.stop() } });
    h.records[0] = { ...h.records[0], worktreePath: root.cwd, links: {} };
    watchdog = new Watchdog({
      store: new WatchdogStore(join(directory, "watchdog.json")),
      sessions: {
        watchdogRoots: async () => new Map([["i1", { issueId: "i1", identifier: "TUC-1", roots: [root], ghosts: new Set<string>() }]]),
        watchdogAct: async (request) => {
          const reason = await request.check(root, true);
          if (reason) return { kind: "skipped", reason, end: true };
          await request.claim();
          acts.push(request.action);
          return { kind: "done" };
        },
        watchdogThread: async () => null,
        sessionFor: async () => null,
        say: async () => {},
      },
      linear: {
        issueWatchState: async () => ({ status: "Planning", statusType: "started", labels: [] }),
        comment: async () => {}, hasComment: async () => false, viewerId: async () => "me", userUrl: async () => OWNER,
      },
      settings: { read: async () => ({ ...settings, watchdog: DEFAULT_WATCHDOG }) },
      handover: { all: async () => h.records },
      activity: async () => ({ ok: true, activity: { progressAt: quietSince, touchedAt: quietSince, head: "h1", awaitingChild: false } }),
    });
    h.git.origin = read.origin ?? null;
    h.github.listFailure = read.listing ?? null;
    h.linear.issueFailure = read.attachments ?? null;
    await h.poll();
    return acts;
  };
  // Git cannot name the worktree's repository and Linear lists no attachments: no pull requests.
  assert.deepEqual(await judge(), ["resume"]);
  // A known repository whose listing fails, or attachments that cannot be read, still veto.
  assert.deepEqual(await judge({ origin: "https://github.com/tuchel-sohn/tuchel-platform.git", listing: new Error("HTTP 502: Bad Gateway") }), []);
  assert.deepEqual(await judge({ attachments: new Error("Linear is unavailable") }), []);
});

// A successor start that fails because the ticket cannot fit in any prompt (sessions.ts `tooLarge`).
const TOO_LARGE = async (claim: () => Promise<void>): Promise<Succession> => {
  await claim();
  return { kind: "impossible", reason: CONTEXT_TOO_LARGE, tooLarge: true };
};
const OVERSIZE_MARK = "<!-- paseo:oversize-start:i1:a1 -->";

test("an oversized ticket asks the owner once: later drops and nudges, and a restart, claim their messages silently", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const h = harness(t, { live: false, autoResume: true });
  h.paseo.succeed = TOO_LARGE;
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  const first = await h.poll();
  assert.equal(first[0], "move In Progress");
  assert.match(first[1], new RegExp(`^comment ${OWNER} The agent that worked on this ticket is no longer running, and no successor can start: This ticket and its comments are too large to send in one prompt \\(200,000 characters maximum\\)\\.`));
  assert.ok(first[1].endsWith(OVERSIZE_MARK));
  assert.equal(first.filter((call) => call.startsWith("comment")).length, 1);
  // A stalled stage on the same pull request, then a new head after a restart: no new ask, no state change.
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, CONFLICT), checks: [failing("PR code")] };
  const nudged = await h.poll();
  assert.ok(!nudged.some((call) => call.startsWith("comment") || call.startsWith("move")), nudged.join("\n"));
  await h.restart();
  h.github.view = { ...h.github.view, headSha: "f00dfeedbeef" };
  const restarted = await h.poll();
  assert.ok(!restarted.some((call) => call.startsWith("comment") || call.startsWith("move")), restarted.join("\n"));
  assert.deepEqual(await h.poll(), [], "each message was claimed");
  assert.equal(h.linear.comments.i1.length, 1);
  // A successor that starts clears the ask: the next agent's oversized failure is a new one.
  h.paseo.succeed = async (claim) => { await claim(); return { kind: "started", agent: { id: "s2", title: "S2", cwd: "/wt/tuc-1" } }; };
  h.github.view = { ...h.github.view, headSha: "0123456789ab" };
  assert.ok((await h.poll()).some((call) => call.startsWith("succeed a1")));
  const asks = JSON.parse(await readFile(join(await h.home(), "oversize-asks.json"), "utf8"));
  assert.deepEqual(asks, {});
});

test("an oversized ticket's ask survives a lost response, a failed comment and an unknown owner without a second comment", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const owner: { owner?: "all" | "unknown" } = { owner: "unknown" };
  const h = harness(t, Object.assign(owner, { live: false, autoResume: true }));
  h.paseo.succeed = TOO_LARGE;
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  // Whether this host owns the ticket cannot be told: nobody asks, the drop stays pending.
  assert.ok(!(await h.poll()).some((call) => call.startsWith("comment")));
  owner.owner = "all";
  // The comment never reaches Linear: retried on the next poll.
  h.linear.arrive = async () => { throw new Error("Linear is unavailable"); };
  assert.ok(!(await h.poll()).some((call) => call.startsWith("comment")));
  // The comment reaches Linear, but its response is lost: the next poll finds it by its mark.
  h.linear.arrive = async () => {};
  h.linear.lost = true;
  await h.poll();
  h.linear.lost = false;
  assert.equal(h.linear.comments.i1.length, 1);
  const again = await h.poll();
  assert.ok(!again.some((call) => call.startsWith("comment")), again.join("\n"));
  assert.equal(h.linear.comments.i1.length, 1);
  assert.ok(h.linear.comments.i1[0].endsWith(OVERSIZE_MARK));
  assert.deepEqual(JSON.parse(await readFile(join(await h.home(), "oversize-asks.json"), "utf8"))["i1:a1"].state, "confirmed");
  assert.deepEqual(await h.poll(), [], "the drop was claimed once confirmed");
});

test("an unrelated successor failure still hands every message back as before", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const h = harness(t, { live: false, autoResume: true });
  h.paseo.succeed = async (claim) => { await claim(); return { kind: "impossible", reason: "Paseo is not connected yet." }; };
  h.github.view = { ...h.github.view, mergeActivity: activity(QUEUED, CONFLICT) };
  assert.match((await h.poll())[1], HANDED_BACK);
  h.github.view = { ...READY, mergeActivity: activity(QUEUED, CONFLICT), checks: [failing("PR code")] };
  assert.match((await h.poll()).find((call) => call.startsWith("comment")) ?? "", HANDED_BACK);
});
