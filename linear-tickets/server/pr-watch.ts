import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Handover, HandoverRecord } from "./handover";
import type { LinearService } from "./linear";
import type { ManualTasks } from "./manual-tasks";
import { CODING_STATE } from "./plannotator";
import { mergeable, mergeText, STAGE_STEP, stalledStage, type ReviewThread, type Stage } from "./pr-nudge";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { SessionRouter } from "./sessions";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

const exec = promisify(execFile);
const INTERVAL_MS = 2 * 60 * 1000;
const REVIEW_STATE = "In Review";
// Approved and waiting for the merge click; teams without this state stay in In Review.
const READY_STATE = "Ready to merge";
// The repo's workflow labels pull requests Graphite's merge queue landed: the queue fast-forwards
// the base branch and closes them instead of merging them.
export const QUEUE_MERGED_LABEL = "externally-merged";
const QUEUE_DRAFT_TITLE = "[Graphite MQ] Draft PR";
// Automatic prompts per pull request and drop kind (docs/automation/merge-queue.md in the repo):
// one fix request after a plain drop, up to five restacks after conflict-only drops. The next drop
// of a kind goes to the owner instead, and after that escalation no drop prompts the agent again.
const DROP_PROMPTS: Record<DropKind, number> = { plain: 1, conflict: 5 };
// Nudges per pull request and lifecycle stage; the next time that stage stalls goes to the owner.
const STAGE_NUDGES = 2;
// The owner's veto: such a pull request is never nudged.
const DO_NOT_MERGE_LABEL = "do-not-merge";
// Check conclusions that do not fail a pull request.
const PASSING_CONCLUSIONS = ["success", "skipped", "neutral"];
// An archived agent's open pull request stops being watched after this long without activity.
const ARCHIVED_WATCH_MS = 14 * 24 * 60 * 60 * 1000;

// A check on the pull request's head: the latest run of each check, pending until it completes.
export type CheckRun = { name: string; url: string; state: "pending" | "passed" | "failed"; conclusion: string };
export type PullRequestView = {
  state: string;
  isDraft: boolean;
  headSha: string;
  // The pull request's branch and the branch it targets.
  headBranch: string;
  baseBranch: string;
  // The last change of any kind: a commit, comment, review, label.
  updatedAt: string;
  // GitHub's aggregate review decision ("" without required reviews).
  reviewDecision: string;
  labels: string[];
  // The body of Graphite's "Merge activity" comment, one bullet per merge queue event.
  mergeActivity: string | null;
  // The conversation's comments (not review comments), as last edited: Greptile's summary comment
  // names the commit it last reviewed, also for a review without findings, which files no review.
  comments: { author: string; body: string }[];
  // `commit`: the head the review was submitted on.
  reviews: { author: string; state: string; submittedAt: string; body: string; commit: string | null }[];
  lastCommitAt: string | null;
  checks: CheckRun[];
};
// `held`: approved, but kept out of Ready to merge while manual tasks due before merge are open.
// `closed`: closed without merging. Merge queue drops already claimed, by draft (`#123`) or, for
// drops before any draft, by the Merge activity bullet: `drops` the plain ones (and every drop
// claimed before drops had kinds), `conflicts` the conflict-only ones. `escalated`: a drop went to
// the owner; before drops had kinds that was the third drop. `pending`: the claimed drop still to
// be delivered. `replay`: closed without merging, `due` until the closure was looked at once,
// `asked` once the agent was told to open a replacement pull request (see replace). `nudges`: per
// stage, one key per nudge (or the escalation after them): the head, or for requested changes the
// reviews it covered, space-separated (see stalledStage). `activeAt`: the last change, drop or
// nudge seen. `missing`: GitHub has no pull request at the link (a made-up or mistyped URL); it is
// never read again, so a later pull request that takes the number is not mistaken for the ticket's.
// `advance`: landed, `due` until the ticket's next open pull request was looked for (see advance).
type Seen = { reviewedAt: string | null; decision: string | null; merged: boolean; held?: boolean; closed?: boolean; drops?: string[]; conflicts?: string[]; escalated?: boolean; pending?: PendingDrop | null; replay?: "due" | "asked"; nudges?: Partial<Record<Stage, string[]>>; activeAt?: string; missing?: boolean; advance?: "due" };
// A claimed drop, saved before anything is sent. `fix` goes to the agent (or, when it is gone, to
// the ticket); without it, `facts` escalate to the owner. `sending`: a message went out and its
// result was not recorded (a restart or a failed save), so it is not sent again.
type PendingDrop = { key: string; reason: string; facts: string; fix: string | null; sending?: boolean };
type Change = { thought: string; review: string; state?: string };

// A draft pull request the merge queue tests a stack on; `base` is the branch it lands on.
export type QueueDraft = { number: number; title: string; body: string; state: string; headSha: string; base: string };
export type FailedCheck = { name: string; url: string; conclusion: string };
// An open pull request of the repo, from one listing per repo and poll; `trunk` is the repo's
// default branch.
export type OpenPull = { number: number; url: string; title: string; headBranch: string; headSha: string; baseBranch: string; trunk: string; draft: boolean; labels: string[] };
// The GitHub reads beyond the pull request itself; `repo` is `owner/name`.
export type GitHubReader = {
  // Graphite's recent draft pull requests in the repo.
  drafts(repo: string): Promise<QueueDraft[]>;
  // Whether the draft's head reached its base branch.
  landed(repo: string, draft: QueueDraft): Promise<boolean>;
  // Every check run on the commit that did not pass, still running ones included.
  failedChecks(repo: string, sha: string): Promise<FailedCheck[]>;
  reviewThreads(repo: string, number: number): Promise<ReviewThread[]>;
  // Every open pull request of the repo (REST, every page).
  openPullRequests(repo: string): Promise<OpenPull[]>;
  branchExists(repo: string, branch: string): Promise<boolean>;
};
// The pull request a ticket's merge nudge names, with the ready ones below it (bottom first).
type MergeTarget = { pull: OpenPull; view: PullRequestView; below: OpenPull[] };
// `repo` is the pull request's `owner/name` and `number` its number; `draft.headSha` is null when
// the draft is no longer listed, and `draft.pulls` are the pull requests its body lists (none then).
type Drop = { key: string; reason: string; repo: string; number: number; draft: { number: number; url: string; headSha: string | null; pulls: number[] } | null };
// `conflict`: Graphite names a merge conflict and nothing else went wrong (see isConflictOnly).
type DropKind = "plain" | "conflict";

// A pull request title that names the ticket as a whole word (`Add TUC-34 [area] …`, never TUC-343).
function namesTicket(identifier: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9-])${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
}

// gh reports GitHub's throttling (HTTP 429, primary or secondary rate limit); the poll's GitHub
// reads stop until the next one.
export class GitHubRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitedError";
  }
}
// gh found the repository but no pull request with that number.
export class PullRequestNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestNotFoundError";
  }
}
// `at`: Graphite's time stamp as written ("Sep 29, 7:26 AM UTC"); `event`: the text after it.
type Bullet = { text: string; event: string; at: string | null; kind: "queued" | "running" | "merged" | "dropped"; draft: number | null };

function gh(): string {
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) if (existsSync(candidate)) return candidate;
  return "gh";
}

// `parse` reads gh's output; JSON by default.
export async function ghJson<T>(args: string[], parse: (stdout: string) => T = (stdout) => JSON.parse(stdout) as T): Promise<T> {
  try {
    const { stdout } = await exec(gh(), args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
    return parse(stdout);
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    if (/HTTP 429|rate limit/i.test(stderr)) throw new GitHubRateLimitedError(`GitHub is throttling gh: ${stderr.trim().split("\n")[0]}`);
    if (/Could not resolve to a PullRequest/i.test(stderr)) throw new PullRequestNotFoundError(stderr.trim().split("\n")[0]);
    throw error;
  }
}

// `gh api --paginate --jq '[…]'` prints one compact JSON array per page, one per line.
function pages<T>(stdout: string): T[] {
  return stdout.split("\n").filter(Boolean).flatMap((line) => JSON.parse(line) as T[]);
}

type RollupItem = {
  __typename?: string;
  name?: string; status?: string; conclusion?: string | null; detailsUrl?: string; workflowName?: string;
  context?: string; state?: string; targetUrl?: string;
  startedAt?: string;
};

// One read per pull request and poll: everything the review mirror, the drop detection and the
// nudges need except review threads.
export async function viewPullRequest(url: string): Promise<PullRequestView> {
  const data = await ghJson<{
    state?: string;
    isDraft?: boolean;
    headRefOid?: string;
    headRefName?: string;
    baseRefName?: string;
    updatedAt?: string;
    reviewDecision?: string | null;
    labels?: { name?: string }[];
    comments?: { author?: { login?: string }; body?: string }[];
    reviews?: { author?: { login?: string }; state?: string; submittedAt?: string; body?: string; commit?: { oid?: string } | null }[];
    commits?: { committedDate?: string }[];
    statusCheckRollup?: RollupItem[];
  }>(["pr", "view", url, "--json", "state,isDraft,headRefOid,headRefName,baseRefName,updatedAt,reviewDecision,labels,comments,reviews,commits,statusCheckRollup"]);
  const activity = (data.comments ?? []).filter((comment) => /^graphite-app(\[bot\])?$/.test(comment.author?.login ?? "") && comment.body?.startsWith("### Merge activity")).at(-1);
  // A check re-run (or run again for another event) appears once per run; the latest one counts.
  const latest = new Map<string, { at: string; check: CheckRun }>();
  for (const item of data.statusCheckRollup ?? []) {
    const status = item.__typename === "StatusContext";
    const name = (status ? item.context : item.name) ?? "check";
    const result = ((status ? item.state : item.conclusion) ?? "").toLowerCase();
    const done = status ? !["pending", "expected", ""].includes(result) : item.status === "COMPLETED";
    const key = `${item.workflowName ?? ""}\n${name}`;
    const at = item.startedAt ?? "";
    if ((latest.get(key)?.at ?? "") > at) continue;
    latest.set(key, { at, check: { name, url: (status ? item.targetUrl : item.detailsUrl) ?? "", state: !done ? "pending" : PASSING_CONCLUSIONS.includes(result) ? "passed" : "failed", conclusion: done ? result : "pending" } });
  }
  return {
    state: data.state ?? "",
    isDraft: data.isDraft ?? false,
    headSha: data.headRefOid ?? "",
    headBranch: data.headRefName ?? "",
    baseBranch: data.baseRefName ?? "",
    updatedAt: data.updatedAt ?? "",
    reviewDecision: data.reviewDecision ?? "",
    labels: (data.labels ?? []).map((item) => item.name ?? "").filter(Boolean),
    mergeActivity: activity?.body ?? null,
    comments: (data.comments ?? []).map((comment) => ({ author: comment.author?.login ?? "someone", body: comment.body ?? "" })),
    reviews: (data.reviews ?? []).map((review) => ({ author: review.author?.login ?? "someone", state: review.state ?? "", submittedAt: review.submittedAt ?? "", body: review.body ?? "", commit: review.commit?.oid ?? null })).filter((review) => review.submittedAt),
    lastCommitAt: data.commits?.at(-1)?.committedDate ?? null,
    checks: [...latest.values()].map((entry) => entry.check),
  };
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      isResolved path line
      comments(first: 20) { nodes { author { login __typename } body createdAt url } }
    }
  } } }
}`;

export const githubReader: GitHubReader = {
  async drafts(repo) {
    const drafts = await ghJson<{ number: number; title?: string; body?: string; state?: string; headRefOid?: string; baseRefName?: string }[]>(
      ["pr", "list", "-R", repo, "--state", "all", "--author", "app/graphite-app", "--limit", "30", "--json", "number,title,body,state,headRefOid,baseRefName"]);
    return drafts.map((draft) => ({ number: draft.number, title: draft.title ?? "", body: draft.body ?? "", state: draft.state ?? "", headSha: draft.headRefOid ?? "", base: draft.baseRefName ?? "main" }));
  },
  async landed(repo, draft) {
    // Compared from the draft's head: the base branch is `identical` or `ahead` once it contains it.
    const { status } = await ghJson<{ status?: string }>(["api", `repos/${repo}/compare/${draft.headSha}...${encodeURIComponent(draft.base)}`, "--jq", "{status}"]);
    return status === "identical" || status === "ahead";
  },
  // Every page (a draft runs about 90 check runs): a failed or still running run left out must
  // never let a drop pass as conflict-only.
  async failedChecks(repo, sha) {
    const runs = await ghJson(["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {name, html_url, status, conclusion}]"],
      pages<{ name?: string; html_url?: string; status?: string; conclusion?: string | null }>);
    return runs.filter((run) => !PASSING_CONCLUSIONS.includes(run.conclusion ?? ""))
      .map((run) => ({ name: run.name ?? "check", url: run.html_url ?? "", conclusion: run.conclusion ?? run.status ?? "unknown" }));
  },
  async openPullRequests(repo) {
    const open = await ghJson(["api", "--paginate", `repos/${repo}/pulls?state=open&per_page=100`, "--jq", "[.[] | {number, url: .html_url, title, headBranch: .head.ref, headSha: .head.sha, baseBranch: .base.ref, trunk: .base.repo.default_branch, draft, labels: [.labels[].name]}]"], pages<OpenPull>);
    return open.sort((a, b) => b.number - a.number);
  },
  async branchExists(repo, branch) {
    try {
      await ghJson(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--jq", "{name}"]);
      return true;
    } catch (error) {
      // gh reports a missing branch as "Branch not found (HTTP 404)".
      if (error && typeof error === "object" && "stderr" in error && /HTTP 404/.test(String(error.stderr))) return false;
      throw error;
    }
  },
  // Every page: a thread left out could hide a finding or hold a merge.
  async reviewThreads(repo, number) {
    const [owner, name] = repo.split("/");
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    do {
      const data: { data?: { repository?: { pullRequest?: { reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: {
          isResolved?: boolean; path?: string | null; line?: number | null;
          comments?: { nodes?: { author?: { login?: string; __typename?: string } | null; body?: string; createdAt?: string; url?: string }[] };
        }[];
      } } } } } = await ghJson(["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, ...(cursor ? ["-f", `cursor=${cursor}`] : [])]);
      const page = data.data?.repository?.pullRequest?.reviewThreads;
      for (const thread of page?.nodes ?? []) {
        threads.push({
          resolved: thread.isResolved ?? false,
          path: thread.path ?? null,
          line: thread.line ?? null,
          comments: (thread.comments?.nodes ?? []).map((comment) => ({
            author: comment.author?.login ?? "someone",
            bot: comment.author?.__typename === "Bot" || /\[bot\]$/.test(comment.author?.login ?? ""),
            body: comment.body ?? "",
            createdAt: comment.createdAt ?? "",
            url: comment.url ?? "",
          })),
        });
      }
      cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor ?? null : null;
    } while (cursor);
    return threads;
  },
};

// The bullets of Graphite's "Merge activity" comment, e.g.
// `* **Sep 29, 7:26 AM UTC**: The [Graphite merge queue](…) couldn't merge this PR because **it had merge conflicts**.`
// `text` keeps the time and drops the markdown. Anything that is not queued, running or merged
// ended the attempt: a conflict, a failed check, "merge when ready" turned off.
export function activityBullets(body: string | null): Bullet[] {
  if (!body) return [];
  return body.split("\n").map((line) => line.trim()).filter((line) => /^[*-]\s/.test(line)).map((line) => {
    const raw = line.slice(2).trim();
    const plain = (value: string) => value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").trim();
    const stamp = /^\*\*([^*]+)\*\*:\s*/.exec(raw);
    const event = plain(stamp ? raw.slice(stamp[0].length) : raw);
    const draft = /\[#(\d+)\]/.exec(raw);
    const kind = /^CI is running\b/i.test(event) ? "running"
      : /added this pull request to the Graphite merge queue/i.test(event) ? "queued"
      : /^Merged by the Graphite merge queue/i.test(event) ? "merged"
      : "dropped";
    return { text: plain(raw), event, at: stamp ? stamp[1].trim() : null, kind, draft: kind === "running" && draft ? Number(draft[1]) : null };
  });
}

// A drop whose only cause is a merge conflict (TUC-540; the repo's tools/ci/wait-queue.mjs
// `isConflictOnly` decides the same for the agent's own wait): Graphite names a merge conflict, and
// nothing on the queue's draft failed, was cancelled or was still running, or no draft existed.
// Graphite also says "merge conflicts" for real failures (#429), so a draft whose checks could not
// be read (no longer listed) makes it a plain drop.
function isConflictOnly(drop: Drop, checks: FailedCheck[]): boolean {
  return /merge conflict/i.test(drop.reason) && (drop.draft === null || (drop.draft.headSha !== null && checks.length === 0));
}

// A drop went to the owner. Before drops had kinds, the third drop did.
function escalated(seen: Seen | undefined): boolean {
  return Boolean(seen?.escalated) || (seen?.drops?.length ?? 0) > 2;
}

// What changed since the last look, as one panel thought, a progress line and an optional state.
// The review loop itself runs in Paseo; this only makes it visible on the ticket.
export function reviewChange(view: PullRequestView, seen: Seen): { change: Change | null; seen: Seen } {
  // The merge queue closes what it landed instead of merging it. The repo labels those; where the
  // label is missing, Graphite's last Merge activity bullet says "Merged by the Graphite merge queue".
  if (view.state === "MERGED" || (view.state === "CLOSED" && (view.labels.includes(QUEUE_MERGED_LABEL) || activityBullets(view.mergeActivity).at(-1)?.kind === "merged"))) {
    return seen.merged ? { change: null, seen } : { change: { thought: "The pull request was merged.", review: "merged" }, seen: { ...seen, merged: true } };
  }
  const fresh = view.reviews.filter((review) => !seen.reviewedAt || review.submittedAt > seen.reviewedAt).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const latest = fresh.at(-1);
  if (latest) {
    const next = { ...seen, reviewedAt: latest.submittedAt, decision: latest.state };
    if (latest.state === "CHANGES_REQUESTED") return { change: { thought: `@${latest.author} requested changes on the pull request — the agent is addressing them in Paseo.`, review: `changes requested by @${latest.author}`, state: CODING_STATE }, seen: next };
    if (latest.state === "APPROVED") return { change: { thought: `@${latest.author} approved the pull request — ready to merge.`, review: `approved by @${latest.author}`, state: READY_STATE }, seen: next };
    if (latest.state === "COMMENTED") return { change: { thought: `@${latest.author} commented on the pull request — the agent is looking at it in Paseo.`, review: `comments from @${latest.author}` }, seen: next };
    return { change: null, seen: next };
  }
  // Commits pushed after requested changes, or after an approval, send the ticket back to review.
  if (seen.decision === "CHANGES_REQUESTED" && view.lastCommitAt && seen.reviewedAt && view.lastCommitAt > seen.reviewedAt) {
    return { change: { thought: "New commits were pushed after the requested changes — back in review.", review: "fixes pushed, awaiting review", state: REVIEW_STATE }, seen: { ...seen, decision: "FIXES_PUSHED" } };
  }
  if (seen.decision === "APPROVED" && view.lastCommitAt && seen.reviewedAt && view.lastCommitAt > seen.reviewedAt) {
    return { change: { thought: "New commits were pushed after the approval — back in review.", review: "new commits after approval, awaiting review", state: REVIEW_STATE }, seen: { ...seen, decision: "PUSHED_AFTER_APPROVAL" } };
  }
  return { change: null, seen };
}

// Mirrors each ticket's pull request review into Linear every 2 minutes, sends pull requests the
// Graphite merge queue dropped back to be fixed, nudges stalled ones to their next step, and
// follows a pull request closed after part of its stack landed to its replacement.
export class PullRequestWatch {
  private timer: NodeJS.Timeout | null = null;
  private pausedPool: RateLimitedError["pool"] | null = null;

  constructor(
    private readonly deps: {
      handover: Pick<Handover, "all" | "update">;
      sessions: Pick<SessionRouter, "sessionFor" | "say" | "prompt" | "link">;
      linear: Pick<LinearService, "moveToStateNamed" | "comment" | "viewerId" | "userUrl" | "linkUrl">;
      manualTasks?: Pick<ManualTasks, "openBlockers" | "merged" | "awaitingMerge">;
      settings: Pick<Settings, "read">;
      view?: (url: string) => Promise<PullRequestView>;
      github?: GitHubReader;
    },
    private readonly path = join(paseoHome(), "linear-tickets", "pr-watch.json"),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(): Promise<Record<string, Seen>> {
    try { return JSON.parse(await readFile(this.path, "utf8")); } catch { return {}; }
  }

  private async save(value: Record<string, Seen>): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  private running: Promise<void> | null = null;
  private githubThrottled = false;

  // Background priority: requests stop at their pool's reserve. A pause ends the poll (logged once
  // per pool); unsaved records are retried on the next poll. One poll at a time: a tick while the
  // last one still runs joins it.
  poll(): Promise<void> {
    this.running ??= withPriority("background", () => this.watch()).finally(() => { this.running = null; });
    return this.running;
  }

  private async watch(): Promise<void> {
    const seenByUrl = await this.load();
    const manual = this.deps.manualTasks;
    const records: HandoverRecord[] = [];
    for (const record of await this.deps.handover.all()) {
      const url = record.links["Pull request"];
      if (!url) continue;
      const seen = seenByUrl[url];
      if (seen?.missing) continue;
      // An archived agent's open pull request stays watched, so a merge queue drop still reaches
      // the ticket: until a drop escalated to the owner, or 14 days without activity. After-merge
      // tasks keep it watched until the merge, a closure until it was looked at, and a landing until
      // the ticket's next open pull request was looked for; once the agent was asked to open a
      // replacement, until the replacement is linked or 14 days pass.
      const quiet = Date.now() - Math.max(Date.parse(record.updatedAt) || 0, Date.parse(seen?.activeAt ?? "") || 0) > ARCHIVED_WATCH_MS;
      const watched = !seen?.merged && (!seen?.closed || seen.replay === "asked") && !escalated(seen) && !quiet;
      if (record.status !== "archived" || seen?.pending || seen?.replay === "due" || seen?.advance === "due" || watched || await manual?.awaitingMerge(record.issueId)) records.push(record);
    }
    // Graphite's drafts and the open pull requests are listed once per repo and poll.
    const drafts = new Map<string, Promise<QueueDraft[]>>();
    const listDrafts = (repo: string) => {
      if (!drafts.has(repo)) drafts.set(repo, (this.deps.github ?? githubReader).drafts(repo));
      return drafts.get(repo)!;
    };
    const pulls = new Map<string, Promise<OpenPull[]>>();
    const listPulls = (repo: string) => {
      const listing = pulls.get(repo) ?? (this.deps.github ?? githubReader).openPullRequests(repo);
      pulls.set(repo, listing);
      return listing;
    };
    const save = () => this.save(seenByUrl);
    // Agents that got a message this poll: one instruction per agent and poll, so the pull
    // requests of one stack do not each send it one.
    const reserved = new Set<string>();
    const stopped: { paused: RateLimitedError | null; throttled: GitHubRateLimitedError | null } = { paused: null, throttled: null };
    // A failure for one pull request is logged and the rest go on; a rate limit ends the poll.
    const step = async (record: HandoverRecord, url: string, work: () => Promise<void>): Promise<boolean> => {
      try {
        await work();
      } catch (error) {
        if (error instanceof RateLimitedError) stopped.paused = error;
        else if (error instanceof GitHubRateLimitedError) stopped.throttled = error;
        else console.error(`[linear-tickets] ${record.identifier}: reading ${url} failed: ${error instanceof Error ? error.message : error}`);
      }
      return !stopped.paused && !stopped.throttled;
    };
    // Stalled pull requests are nudged, and closed ones followed to their replacement, after every
    // drop was handled: a drop's fix request comes first when both are for the same agent.
    const nudges: { record: HandoverRecord; url: string; view: PullRequestView }[] = [];
    for (const record of records) {
      const url = record.links["Pull request"];
      const going = await step(record, url, async () => {
        let view: PullRequestView;
        try {
          view = await (this.deps.view ?? viewPullRequest)(url);
        } catch (error) {
          if (!(error instanceof PullRequestNotFoundError)) throw error;
          console.error(`[linear-tickets] ${record.identifier}: ${url} does not exist (${error.message}); it is no longer watched`);
          seenByUrl[url] = { ...(seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false }), missing: true, pending: null };
          return;
        }
        const result = reviewChange(view, seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false });
        const { change, seen } = manual ? await this.gate(record, result, manual) : result;
        if (change) await this.apply(record, change);
        if (change?.review === "merged" && manual) await manual.merged(record.issueId);
        // Each step's state is recorded after it, so a failed step is retried on the next poll.
        const now = new Date().toISOString();
        const closed = view.state === "CLOSED" && !seen.merged;
        seenByUrl[url] = { ...seen, closed, ...(closed && !seen.closed ? { replay: "due" as const } : {}), ...(change?.review === "merged" ? { advance: "due" as const } : {}), ...(change ? { activeAt: now } : {}) };
        if (view.state !== "OPEN") {
          if (seenByUrl[url].pending) console.error(`[linear-tickets] ${record.identifier}: ${url} is no longer open; the merge queue drop is not reported`);
          seenByUrl[url] = { ...seenByUrl[url], pending: null };
          if (closed || seen.merged) nudges.push({ record, url, view });
          return;
        }
        let dropped = Boolean(seenByUrl[url].pending);
        if (!dropped) {
          const current = seenByUrl[url];
          const drop = await this.queueDrop(url, view, [...(current.drops ?? []), ...(current.conflicts ?? [])], listDrafts);
          if (drop) {
            dropped = true;
            // Claimed and saved before anything is sent: a later failure, a restart or another
            // poll never sends it twice.
            const { kind, pending } = await this.claim(record, url, view, drop, current, listPulls);
            const counted = kind === "conflict" ? { conflicts: [...(current.conflicts ?? []), drop.key] } : { drops: [...(current.drops ?? []), drop.key] };
            seenByUrl[url] = { ...current, ...counted, ...(pending?.fix === null ? { escalated: true } : {}), pending, activeAt: now };
            await save();
          }
        }
        const pending = seenByUrl[url].pending;
        // Recorded as delivered as soon as the message went out, before any session line.
        if (pending) await this.deliver(record, url, pending, save, reserved, async () => {
          seenByUrl[url] = { ...seenByUrl[url], pending: null };
          await save();
        });
        // A stalled pull request gets its next step, but never in a poll that handles a drop.
        if (!dropped) nudges.push({ record, url, view });
      });
      if (!going) break;
    }
    for (const { record, url, view } of stopped.paused || stopped.throttled ? [] : nudges) {
      const next = view.state === "OPEN" ? () => this.nudge(record, url, view, seenByUrl, save, listDrafts, listPulls, reserved)
        : seenByUrl[url].merged ? () => this.advance(record, url, seenByUrl, listPulls)
        : () => this.replace(record, url, view, seenByUrl, save, listPulls, reserved);
      if (!await step(record, url, next)) break;
    }
    const { paused, throttled } = stopped;
    if (paused && paused.pool !== this.pausedPool) console.error(`[linear-tickets] pull request watch paused: ${paused.message}`);
    this.pausedPool = paused?.pool ?? null;
    if (throttled && !this.githubThrottled) console.error(`[linear-tickets] pull request watch paused until the next poll: ${throttled.message}`);
    this.githubThrottled = throttled !== null;
    await save();
  }

  // The current merge queue attempt, when it ended without landing and is not claimed yet. Its
  // draft is the one its "CI is running" bullet names: Graphite's last bullet while CI runs, the
  // one before the outcome after it. Either Graphite's last bullet ended the attempt (a conflict
  // can drop a pull request before any draft exists), or, while that bullet still says CI is
  // running, that very draft was closed without its head reaching the base branch and no newer
  // queue draft for this pull request is open. Without Merge activity nothing counts: an older
  // closed draft says nothing about the current attempt. Keyed by the draft's number (by the
  // bullet when there is none), so both signs of one drop count once.
  private async queueDrop(url: string, view: PullRequestView, handled: string[], drafts: (repo: string) => Promise<QueueDraft[]>): Promise<Drop | null> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (!source) return null;
    const [, repo, number] = source;
    const bullets = activityBullets(view.mergeActivity);
    const last = bullets.at(-1);
    if (last?.kind !== "running" && last?.kind !== "dropped") return null;
    const running = last.kind === "running" ? last : bullets.at(-2);
    const draftNumber = running?.kind === "running" ? running.draft : null;
    const key = draftNumber === null ? last.text : `#${draftNumber}`;
    if (handled.includes(key)) return null;
    const draftUrl = `https://github.com/${repo}/pull/${draftNumber}`;
    let reason = last.text;
    let draft: QueueDraft | undefined;
    if (last.kind === "dropped") {
      if (draftNumber === null) return { key, reason, repo, number: Number(number), draft: null };
      draft = (await drafts(repo)).find((item) => item.number === draftNumber);
    } else {
      if (draftNumber === null) return null;
      const listing = (await drafts(repo)).filter((item) => item.title.startsWith(QUEUE_DRAFT_TITLE) && item.body.includes(`](https://app.graphite.com/github/pr/${repo}/${number})`));
      draft = listing.find((item) => item.number === draftNumber);
      if (!draft || draft.state !== "CLOSED" || listing.some((item) => item.number > draftNumber && item.state === "OPEN")) return null;
      if (await (this.deps.github ?? githubReader).landed(repo, draft)) return null;
      reason = `The merge queue closed its draft pull request #${draftNumber} without landing it.`;
    }
    // The draft's body lists the queue range it tested, one Graphite link per pull request.
    const pulls = [...(draft?.body ?? "").matchAll(/\]\(https:\/\/app\.graphite\.com\/github\/pr\/([^/)]+\/[^/)]+)\/(\d+)\)/g)].filter((link) => link[1] === repo).map((link) => Number(link[2]));
    return { key, reason, repo, number: Number(number), draft: { number: draftNumber, url: draftUrl, headSha: draft?.headSha || null, pulls } };
  }

  // What a drop sends, by kind (see isConflictOnly): a fix request for a plain drop, a restack
  // request for a conflict-only one, up to DROP_PROMPTS of that kind per pull request. The next
  // drop of that kind escalates to the owner; after the escalation drops of either kind only reach
  // the log. Both re-enqueue the dropped queue range from its top branch, the one `gt merge` ran on
  // before the drop: the highest of the ticket's open pull requests the queue's draft listed, or
  // the dropped one. `gt merge` on the stack's top branch would enqueue pull requests above the
  // range that are not ready to land.
  private async claim(record: HandoverRecord, url: string, view: PullRequestView, drop: Drop, seen: Seen, pulls: (repo: string) => Promise<OpenPull[]>): Promise<{ kind: DropKind; pending: PendingDrop | null }> {
    if (escalated(seen)) {
      console.error(`[linear-tickets] ${record.identifier}: the merge queue dropped ${url} again; already escalated to the owner`);
      // The kind no longer matters: the key only keeps the drop from being claimed again.
      return { kind: "plain", pending: null };
    }
    const checks = drop.draft?.headSha ? await (this.deps.github ?? githubReader).failedChecks(drop.repo, drop.draft.headSha) : [];
    const kind: DropKind = isConflictOnly(drop, checks) ? "conflict" : "plain";
    const plain = (seen.drops?.length ?? 0) + (kind === "plain" ? 1 : 0);
    const conflicts = (seen.conflicts?.length ?? 0) + (kind === "conflict" ? 1 : 0);
    const facts = [
      `The Graphite merge queue dropped [the pull request](${url}) without merging it.`,
      `Reason: ${drop.reason}`,
      ...(!drop.draft?.headSha ? [] : checks.length
        ? [`Checks that did not pass on the queue's draft [#${drop.draft.number}](${drop.draft.url}):`, ...checks.map((check) => `- [${check.name}](${check.url}) — ${check.conclusion}`)]
        : [`No check failed on the queue's draft [#${drop.draft.number}](${drop.draft.url}).`]),
    ].join("\n");
    const count = kind === "plain" ? plain : conflicts;
    if (count > DROP_PROMPTS[kind]) return { kind, pending: { key: drop.key, reason: drop.reason, facts: `${facts}\nDrops of this pull request so far: ${plain} plain, ${conflicts} conflict-only.`, fix: null } };
    const identifier = namesTicket(record.identifier);
    const range = drop.draft?.pulls.length ? (await pulls(drop.repo)).filter((pull) => drop.draft?.pulls.includes(pull.number) && (pull.url === url || identifier.test(pull.title))) : [];
    const top = range.filter((pull) => !range.some((other) => other.baseBranch === pull.headBranch)).sort((a, b) => b.number - a.number)[0];
    const branch = top?.headBranch ?? view.headBranch;
    const pr = top?.number ?? drop.number;
    const enqueue = `\`git switch ${branch} && node tools/ci/enqueue.mjs\` (the top branch of the dropped queue range, not the stack's top branch; never a bare \`gt merge\`: it refuses while the range conflicts with \`main\` or the queue tip and names the fix)`;
    const worktree = `In your stack's worktree${record.worktreePath ? ` (\`${record.worktreePath}\`)` : ""}, on the top branch of the stack`;
    const rebase = "`git fetch origin main && git rebase --update-refs --onto origin/main \"$(git merge-base HEAD origin/main)\"`. It moves only your own branches; never `gt sync` or `gt restack`, which move the shared `main` and other agents' branches.";
    const fix = kind === "conflict" ? [
      facts,
      "",
      "Conflict only: Graphite names a merge conflict and nothing failed, was cancelled or was still running on the queue's draft. Restack and re-enqueue right away, without asking (docs/automation/merge-queue.md#conflict-only-drops), unless a pull request of the stack carries `do-not-merge`:",
      `1. ${worktree}, and only when every branch below it is your own, run ${rebase}`,
      "2. Keep `main`'s version of generated files and regenerate them; never merge them by hand. Run the focused checks for the files the restack touched.",
      `3. Run \`gt submit --stack --ignore-out-of-sync-trunk\`, then right away ${enqueue} and \`node tools/ci/wait-queue.mjs ${pr}\`. Do not wait for the pull request's checks first: the queue's draft runs the full suite. Only when \`enqueue.mjs\` reports that \`gt merge\` refused because checks are still running, wait with \`node tools/ci/wait-checks.mjs ${pr}\` and run \`node tools/ci/enqueue.mjs\` once more.`,
      "",
      `This is automatic restack ${count} of ${DROP_PROMPTS.conflict} for this pull request; after that the owner takes over.`,
    ] : [
      facts,
      "",
      "To land it:",
      `1. ${worktree}, run ${rebase} If your stack sits on a PR that has already landed, or your PR was auto-closed, follow docs/automation/merge-queue.md instead.`,
      "2. Fix the cause.",
      `3. Run \`gt submit --stack --ignore-out-of-sync-trunk\`, then ${enqueue} and \`node tools/ci/wait-queue.mjs ${pr}\`.`,
      "",
      `An obviously flaky failure (unrelated to the change) gets one plain \`git switch ${branch} && node tools/ci/enqueue.mjs\` retry instead.`,
      `This is automatic fix request ${count} of ${DROP_PROMPTS.plain} for this pull request; the next plain drop goes to the owner.`,
    ];
    return { kind, pending: { key: drop.key, reason: drop.reason, facts, fix: fix.join("\n") } };
  }

  // Delivers a claimed drop: the fix request to the agent while it exists, otherwise to the ticket,
  // which goes back to coding for the next agent; an escalation to the owner. It waits for a later
  // poll while the agent is in a turn, Paseo is not connected, or the agent already got a message
  // this poll (`reserved`). `sending` is saved right before a message goes out, so one whose
  // result was lost (a restart) is never sent again; `delivered` records it right after, before
  // the best-effort session line.
  private async deliver(record: HandoverRecord, url: string, pending: PendingDrop, save: () => Promise<void>, reserved: Set<string>, delivered: () => Promise<void>): Promise<void> {
    if (pending.sending) {
      console.error(`[linear-tickets] ${record.identifier}: the message about the merge queue drop of ${url} may already have gone out; it is not sent again`);
      await delivered();
      return;
    }
    const dispatch = async () => {
      pending.sending = true;
      await save();
    };
    const toAgent = async () => {
      reserved.add(record.agentId);
      await dispatch();
    };
    const { fix } = pending;
    try {
      if (fix === null) {
        await dispatch();
        await this.mention(record.issueId, `The merge queue dropped this stack again after Paseo's automatic requests (one fix request after a plain drop, ${DROP_PROMPTS.conflict} restacks after conflict-only drops), so Paseo stops asking the agent to fix it. Please take over.\n\n${pending.facts}`);
        await delivered();
        await this.tell(record, "response", `The merge queue dropped the pull request again; the owner was asked to take over.\n\n${pending.facts}`);
        return;
      }
      if (reserved.has(record.agentId)) return;
      if (record.status !== "archived") {
        const outcome = await this.deps.sessions.prompt(record.agentId, fix, toAgent);
        if (outcome === "sent") {
          await delivered();
          await this.tell(record, "thought", `The merge queue dropped the pull request (${pending.reason}). The agent was asked to fix it.`);
        }
        if (outcome !== "gone") return;
      }
      await this.handBack(record, fix, toAgent);
      await delivered();
      await this.tell(record, "response", `The merge queue dropped the pull request and the agent is no longer running; the ticket is back in ${CODING_STATE}.\n\n${pending.facts}`);
    } finally {
      // A send that failed outright is retried on the next poll (saved with the rest of the state).
      pending.sending = false;
    }
  }

  // The next lifecycle step of a stalled ticket (see pr-nudge.ts), for its idle agent. Nothing
  // while manual tasks due before the merge are open or the agent already got a message this poll.
  // The recorded pull request gets the steps before the merge (draft, failed checks, requested
  // changes, findings) unless it may not be nudged (see nudgeable). The merge step covers every
  // open pull request of the ticket: one nudge per ticket and poll, for the highest one that is
  // ready to land with everything below it (see mergeTarget). Pull requests the recorded one's
  // steps leave out are settled before review threads are read. A step is claimed per head of its
  // pull request right before its message goes out: at most STAGE_NUDGES per stage and pull
  // request, then one escalation to the owner, then only the log. A busy agent or a disconnected
  // Paseo claims nothing; the next poll decides again.
  private async nudge(record: HandoverRecord, url: string, view: PullRequestView, seenByUrl: Record<string, Seen>, save: () => Promise<void>, drafts: (repo: string) => Promise<QueueDraft[]>, pulls: (repo: string) => Promise<OpenPull[]>, reserved: Set<string>): Promise<void> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (!source || reserved.has(record.agentId)) return;
    const [, repo, number] = source;
    if ((await this.deps.manualTasks?.openBlockers(record.issueId))?.length) return;
    const claimedOn = (target: string, stage: Stage) => seenByUrl[target]?.nudges?.[stage] ?? [];
    const github = this.deps.github ?? githubReader;
    // Each pull request's review threads are read at most once per nudge.
    const threadReads = new Map<number, Promise<ReviewThread[]>>();
    const threads = (pull: number) => {
      const read = threadReads.get(pull) ?? github.reviewThreads(repo, pull);
      threadReads.set(pull, read);
      return read;
    };
    let target = url;
    let found: { stage: Stage; key: string; text: string } | null = null;
    if (await this.nudgeable(repo, Number(number), view, drafts)) {
      const step = await stalledStage(view, url, Date.now(), (stage, key) => claimedOn(url, stage).some((entry) => entry.split(" ").includes(key)), () => threads(Number(number)));
      if (step && step.stage !== "merge" && !claimedOn(url, step.stage).includes(step.key)) found = step;
    }
    if (!found) {
      const ready = await this.mergeTarget(record, repo, url, view, drafts, pulls, threads);
      if (!ready || claimedOn(ready.pull.url, "merge").includes(ready.view.headSha)) return;
      target = ready.pull.url;
      found = { stage: "merge", key: ready.view.headSha, text: mergeText(ready.pull.url, ready.view, ready.below) };
    }
    const { stage, text, key } = found;
    const before = seenByUrl[target]?.nudges ?? {};
    const heads = before[stage] ?? [];
    const sent = heads.length;
    let claimed = false;
    const claim = async () => {
      seenByUrl[target] = { ...(seenByUrl[target] ?? { reviewedAt: null, decision: null, merged: false }), nudges: { ...before, [stage]: [...heads, key] }, activeAt: new Date().toISOString() };
      claimed = true;
      await save();
    };
    const toAgent = async () => {
      reserved.add(record.agentId);
      await claim();
    };
    try {
      if (sent > STAGE_NUDGES) {
        console.error(`[linear-tickets] ${record.identifier}: ${target} is waiting for the agent to ${STAGE_STEP[stage]} again; already escalated to the owner`);
        await claim();
        return;
      }
      if (sent === STAGE_NUDGES) {
        await claim();
        await this.mention(record.issueId, `Paseo asked the agent ${STAGE_NUDGES} times to ${STAGE_STEP[stage]} on [the pull request](${target}), and it is stuck there again, so Paseo stops asking. Please take over.\n\n${text}`);
        await this.tell(record, "response", `The pull request is stuck again waiting for the agent to ${STAGE_STEP[stage]}; the owner was asked to take over.`);
        return;
      }
      const prompt = `${text}\n\nThis is nudge ${sent + 1} of ${STAGE_NUDGES} for this step; after that the owner takes over.`;
      if (record.status !== "archived") {
        const outcome = await this.deps.sessions.prompt(record.agentId, prompt, toAgent);
        if (outcome === "sent") await this.tell(record, "thought", `The pull request is waiting for the agent to ${STAGE_STEP[stage]}; it was asked to.`);
        if (outcome !== "gone") return;
      }
      await this.handBack(record, prompt, toAgent);
      await this.tell(record, "response", `The pull request is waiting for the agent to ${STAGE_STEP[stage]}, and the agent is no longer running; the ticket is back in ${CODING_STATE}.`);
    } catch (error) {
      // A message that failed outright was not sent: the next poll sends it again.
      if (claimed) seenByUrl[target] = { ...seenByUrl[target], nudges: before };
      throw error;
    }
  }

  // A pull request may be nudged unless the owner vetoes merging it (`do-not-merge`) or the merge
  // queue has (or just landed) it: its last Merge activity bullet queues it, runs its CI or merged
  // it, or an open queue draft lists it.
  private async nudgeable(repo: string, number: number, view: PullRequestView, drafts: (repo: string) => Promise<QueueDraft[]>): Promise<boolean> {
    const last = activityBullets(view.mergeActivity).at(-1);
    if (view.labels.includes(DO_NOT_MERGE_LABEL) || (last && last.kind !== "dropped")) return false;
    const listed = `](https://app.graphite.com/github/pr/${repo}/${number})`;
    return !(await drafts(repo)).some((draft) => draft.state === "OPEN" && draft.title.startsWith(QUEUE_DRAFT_TITLE) && draft.body.includes(listed));
  }

  // The pull request a ticket's merge nudge names. The ticket's open pull requests are the
  // recorded one and every open pull request whose title names the ticket (see namesTicket). A
  // stack lands bottom first, so it is the highest one that is ready (mergeable, nudgeable, no
  // open review thread) with every pull request below it ready too, climbing from the repo's
  // default branch through the ticket's own pull requests;
  // `below` lists those, bottom first. Drafts and vetoed pull requests are left out from the
  // listing; the others are read bottom up, and only while everything below them is ready.
  private async mergeTarget(record: HandoverRecord, repo: string, url: string, view: PullRequestView, drafts: (repo: string) => Promise<QueueDraft[]>, pulls: (repo: string) => Promise<OpenPull[]>, threads: (pull: number) => Promise<ReviewThread[]>): Promise<MergeTarget | null> {
    const identifier = namesTicket(record.identifier);
    const own = (await pulls(repo)).filter((pull) => pull.url === url || identifier.test(pull.title)).sort((a, b) => a.number - b.number);
    const ready = async (pull: OpenPull): Promise<PullRequestView | null> => {
      if (pull.draft || pull.labels.includes(DO_NOT_MERGE_LABEL)) return null;
      const pullView = pull.url === url ? view : await (this.deps.view ?? viewPullRequest)(pull.url);
      if (!mergeable(pullView) || !await this.nudgeable(repo, pull.number, pullView, drafts)) return null;
      return (await threads(pull.number)).some((thread) => !thread.resolved && thread.comments.length) ? null : pullView;
    };
    const climb = async (pull: OpenPull, below: OpenPull[]): Promise<MergeTarget | null> => {
      const pullView = await ready(pull);
      if (!pullView) return null;
      let top: MergeTarget = { pull, view: pullView, below };
      for (const child of own.filter((item) => item.baseBranch === pull.headBranch)) {
        const higher = await climb(child, [...below, pull]);
        if (higher && higher.below.length > top.below.length) top = higher;
      }
      return top;
    };
    let best: MergeTarget | null = null;
    for (const root of own.filter((pull) => pull.baseBranch === pull.trunk)) {
      const top = await climb(root, []);
      if (top && (!best || top.below.length > best.below.length)) best = top;
    }
    return best;
  }

  // The recorded pull request landed, but part of the ticket may not have: the rest of its stack
  // stays open (the queue landed only the range below it), or the agent replayed it onto main as
  // new pull requests. While the ticket has an open pull request, the record's link moves to the
  // lowest one (the one no other open pull request of the ticket sits below; ties go to the lower
  // number), as for a replacement, and the watch, its nudges and the ticket's merge nudge follow
  // it from the next poll. `advance: due` is cleared only once the lookup and the move succeeded,
  // so a failure, or a poll that ended before it, is retried on the next poll.
  private async advance(record: HandoverRecord, url: string, seenByUrl: Record<string, Seen>, pulls: (repo: string) => Promise<OpenPull[]>): Promise<void> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    const identifier = namesTicket(record.identifier);
    const open = source ? (await pulls(source[1])).filter((pull) => pull.url !== url && identifier.test(pull.title)) : [];
    const next = open.filter((pull) => !open.some((other) => other.headBranch === pull.baseBranch)).sort((a, b) => a.number - b.number)[0];
    if (next) await this.relink(record, next.url);
    seenByUrl[url] = { ...seenByUrl[url], advance: undefined };
    if (next) await this.tell(record, "thought", `The pull request landed; Paseo now follows the ticket's next open pull request #${next.number}.`);
  }

  // A pull request closed without merging. When the merge queue landed the branch below it,
  // Graphite deleted that branch and GitHub closed the pull requests based on it for good: they
  // cannot be reopened onto a deleted base. An open pull request from the same branch replaces it:
  // the record's link moves to it, as when the agent links a new pull request, and the watch
  // follows it from the next poll. Without one, the closure is looked at once (`replay: due`): when
  // the base branch is gone, the agent is told to replay the rest of its stack onto main and open
  // the replacement, claimed right before the message goes out like a nudge; a gone or archived
  // agent's message goes to the ticket.
  private async replace(record: HandoverRecord, url: string, view: PullRequestView, seenByUrl: Record<string, Seen>, save: () => Promise<void>, pulls: (repo: string) => Promise<OpenPull[]>, reserved: Set<string>): Promise<void> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (!source || !view.headBranch) return;
    const [, repo, number] = source;
    const github = this.deps.github ?? githubReader;
    const successor = (await pulls(repo)).find((pull) => pull.headBranch === view.headBranch && pull.number !== Number(number));
    if (successor) {
      await this.relink(record, successor.url);
      await this.tell(record, "thought", `The pull request was closed without merging; Paseo now follows its replacement #${successor.number} from the same branch.`);
      return;
    }
    if (seenByUrl[url].replay !== "due" || reserved.has(record.agentId)) return;
    if (await github.branchExists(repo, view.baseBranch)) {
      seenByUrl[url] = { ...seenByUrl[url], replay: undefined };
      return;
    }
    const text = [
      `[The pull request](${url}) was closed without merging: its base branch \`${view.baseBranch}\` is gone (Graphite deletes a branch once the merge queue landed it), and no open pull request has its branch \`${view.headBranch}\`.`,
      `Next step, in your stack's worktree${record.worktreePath ? ` (\`${record.worktreePath}\`)` : ""}:`,
      `1. On the top branch of the stack, replay the remaining branches onto main from the landed branch: \`git fetch origin main && git rebase --update-refs --onto origin/main ${view.baseBranch}\`. It moves only your own branches; never \`gt sync\` or \`gt restack\`.`,
      "2. Push each replayed branch with `git push --force-with-lease origin <branch>`.",
      `3. Open a new pull request from \`${view.headBranch}\` onto main whose body links [the old one](${url}): \`gh pr create --base main --head ${view.headBranch}\`.`,
      `4. Run \`gt track ${view.headBranch} --parent main\` so Graphite links the new pull request; never recreate \`${view.baseBranch}\`.`,
    ].join("\n");
    let claimed = false;
    const toAgent = async () => {
      reserved.add(record.agentId);
      seenByUrl[url] = { ...seenByUrl[url], replay: "asked", activeAt: new Date().toISOString() };
      claimed = true;
      await save();
    };
    try {
      if (record.status !== "archived") {
        const outcome = await this.deps.sessions.prompt(record.agentId, text, toAgent);
        if (outcome === "sent") await this.tell(record, "thought", "The pull request was closed because the branch below it landed; the agent was asked to open its replacement.");
        if (outcome !== "gone") return;
      }
      await this.handBack(record, text, toAgent);
      await this.tell(record, "response", `The pull request was closed because the branch below it landed, and the agent is no longer running; the ticket is back in ${CODING_STATE}.`);
    } catch (error) {
      // A message that failed outright was not sent: the next poll sends it again.
      if (claimed) seenByUrl[url] = { ...seenByUrl[url], replay: "due" };
      throw error;
    }
  }

  // The record's pull request link moves: the ticket, the handover record and, best effort, the
  // agent's session.
  private async relink(record: HandoverRecord, url: string): Promise<void> {
    await this.deps.linear.linkUrl(record.issueId, url, "Pull request");
    await this.deps.handover.update({ id: record.issueId, identifier: record.identifier }, { id: record.agentId, title: record.agentTitle, cwd: record.worktreePath ?? "" }, { link: ["Pull request", url] });
    try {
      const link = await this.deps.sessions.sessionFor(record.agentId);
      if (link) await this.deps.sessions.link(link.sessionId, "Pull request", url);
    } catch (error) {
      console.error(`[linear-tickets] ${record.identifier}: the agent session link failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // A message for an agent that is gone goes to the ticket: back to coding (when status write-back
  // is on) and a comment mentioning the owner. `dispatch` records it right before the comment.
  private async handBack(record: HandoverRecord, text: string, dispatch: () => Promise<void>): Promise<void> {
    if ((await this.deps.settings.read()).writeback.status) await this.deps.linear.moveToStateNamed(record.issueId, CODING_STATE);
    await dispatch();
    await this.mention(record.issueId, `The agent that worked on this ticket is no longer running, so the ticket is back in ${CODING_STATE} for the next one.\n\n${text}`);
  }

  private async mention(issueId: string, body: string): Promise<void> {
    const { linear } = this.deps;
    await linear.comment(issueId, `${await linear.userUrl(await linear.viewerId())} ${body}`);
  }

  // Best effort: the ticket's agent session, when it has one, shows the line too. A failure here
  // never undoes (or repeats) what was already sent.
  private async tell(record: HandoverRecord, type: "thought" | "response", text: string): Promise<void> {
    try {
      const link = await this.deps.sessions.sessionFor(record.agentId);
      if (link) await this.deps.sessions.say(link.sessionId, type, text);
    } catch (error) {
      console.error(`[linear-tickets] ${record.identifier}: the agent session line failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // The soft merge gate: an approval moves the ticket to Ready to merge only once its before-merge
  // manual tasks are done; merging on GitHub still works.
  private async gate(record: HandoverRecord, { change, seen }: { change: Change | null; seen: Seen }, manual: Pick<ManualTasks, "openBlockers">): Promise<{ change: Change | null; seen: Seen }> {
    if (seen.merged || seen.decision !== "APPROVED") return { change, seen: { ...seen, held: false } };
    if (change && change.state !== READY_STATE) return { change, seen };
    if (!change && !seen.held) return { change, seen };
    const open = await manual.openBlockers(record.issueId);
    if (open.length) {
      if (!change) return { change, seen };
      const list = open.map((task) => task.identifier).join(", ");
      return { change: { thought: `${change.thought.replace(/ — ready to merge\.$/, "")}, but ${open.length === 1 ? "a manual task is" : `${open.length} manual tasks are`} due before merge: ${list}.`, review: `${change.review}; waiting on manual tasks ${list}` }, seen: { ...seen, held: true } };
    }
    if (change) return { change, seen: { ...seen, held: false } };
    return { change: { thought: "The manual tasks due before merge are done — ready to merge.", review: "approved; manual tasks done", state: READY_STATE }, seen: { ...seen, held: false } };
  }

  // The session line comes last: a step that fails is retried on the next poll, and the thought
  // must not repeat with it.
  private async apply(record: HandoverRecord, change: Change): Promise<void> {
    if (change.state && (await this.deps.settings.read()).writeback.status) await this.deps.linear.moveToStateNamed(record.issueId, change.state);
    await this.deps.handover.update({ id: record.issueId, identifier: record.identifier }, { id: record.agentId, title: record.agentTitle, cwd: record.worktreePath ?? "" }, { review: change.review });
    await this.tell(record, "thought", change.thought);
  }
}
