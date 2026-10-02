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
import { STAGE_STEP, stalledStage, type ReviewThread, type Stage } from "./pr-nudge";
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
const QUEUE_MERGED_LABEL = "externally-merged";
const QUEUE_DRAFT_TITLE = "[Graphite MQ] Draft PR";
// Automatic fix prompts per pull request for drops other than a plain merge conflict; the next
// such drop goes to the owner instead.
const DROP_PROMPTS = 1;
// Automatic restack prompts per pull request for conflict-only drops (see classify); the next
// conflict-only drop goes to the owner instead.
const CONFLICT_PROMPTS = 5;
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
  // The last change of any kind: a commit, comment, review, label.
  updatedAt: string;
  // GitHub's aggregate review decision ("" without required reviews).
  reviewDecision: string;
  labels: string[];
  // The body of Graphite's "Merge activity" comment, one bullet per merge queue event.
  mergeActivity: string | null;
  // `commit`: the head the review was submitted on.
  reviews: { author: string; state: string; submittedAt: string; body: string; commit: string | null }[];
  lastCommitAt: string | null;
  checks: CheckRun[];
};
// `held`: approved, but kept out of Ready to merge while manual tasks due before merge are open.
// `closed`: closed without merging. `drops`: merge queue drops already claimed, by draft (`#123`)
// or, for drops before any draft, by the Merge activity bullet; `conflictDrops`: those of them
// that were conflict-only. `pending`: the claimed drop still to be delivered. `ticket`: the
// ticket's issue id; `escalated`: a drop of this pull request went to the owner, which stops the
// automatic drop prompts for every pull request of that ticket. `nudges`: per stage, one key per
// nudge (or the escalation after them): the head, or for requested changes the reviews it
// covered, space-separated (see stalledStage). `activeAt`: the last change, drop or nudge seen.
type Seen = { reviewedAt: string | null; decision: string | null; merged: boolean; held?: boolean; closed?: boolean; drops?: string[]; conflictDrops?: string[]; ticket?: string; escalated?: boolean; pending?: PendingDrop | null; nudges?: Partial<Record<Stage, string[]>>; activeAt?: string };
// A claimed drop, saved before anything is sent. `fix` goes to the agent (or, when it is gone, to
// the ticket); without it, `facts` escalate to the owner. `conflict`: a conflict-only drop (a
// restack request, or the escalation after the last one). `sending`: a message went out and its
// result was not recorded (a restart or a failed save), so it is not sent again.
type PendingDrop = { key: string; reason: string; facts: string; fix: string | null; conflict?: boolean; sending?: boolean };
type Change = { thought: string; review: string; state?: string };

// A draft pull request the merge queue tests a stack on; `base` is the branch it lands on.
export type QueueDraft = { number: number; title: string; body: string; state: string; headSha: string; base: string };
export type FailedCheck = { name: string; url: string; conclusion: string };
// The GitHub reads beyond the pull request itself; `repo` is `owner/name`.
export type GitHubReader = {
  // Graphite's recent draft pull requests in the repo.
  drafts(repo: string): Promise<QueueDraft[]>;
  // Whether the draft's head reached its base branch.
  landed(repo: string, draft: QueueDraft): Promise<boolean>;
  // Every check run on the commit that has not completed passing: failed, cancelled, timed out,
  // or still pending. Empty means every run completed with a passing conclusion.
  failedChecks(repo: string, sha: string): Promise<FailedCheck[]>;
  reviewThreads(repo: string, number: number): Promise<ReviewThread[]>;
};
// `repo` is the pull request's `owner/name`; `draft.headSha` is null when the draft is no longer listed.
type Drop = { key: string; reason: string; repo: string; draft: { number: number; url: string; headSha: string | null } | null };

// gh reports GitHub's throttling (HTTP 429, primary or secondary rate limit); the poll's GitHub
// reads stop until the next one.
export class GitHubRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitedError";
  }
}
type Bullet = { text: string; kind: "queued" | "running" | "merged" | "dropped"; draft: number | null };

function gh(): string {
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) if (existsSync(candidate)) return candidate;
  return "gh";
}

async function ghJson<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await exec(gh(), args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    if (/HTTP 429|rate limit/i.test(stderr)) throw new GitHubRateLimitedError(`GitHub is throttling gh: ${stderr.trim().split("\n")[0]}`);
    throw error;
  }
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
    updatedAt?: string;
    reviewDecision?: string | null;
    labels?: { name?: string }[];
    comments?: { author?: { login?: string }; body?: string }[];
    reviews?: { author?: { login?: string }; state?: string; submittedAt?: string; body?: string; commit?: { oid?: string } | null }[];
    commits?: { committedDate?: string }[];
    statusCheckRollup?: RollupItem[];
  }>(["pr", "view", url, "--json", "state,isDraft,headRefOid,updatedAt,reviewDecision,labels,comments,reviews,commits,statusCheckRollup"]);
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
    updatedAt: data.updatedAt ?? "",
    reviewDecision: data.reviewDecision ?? "",
    labels: (data.labels ?? []).map((item) => item.name ?? "").filter(Boolean),
    mergeActivity: activity?.body ?? null,
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
  // Every page: a failed or pending run past the first 100 must never let a drop pass as
  // conflict-only. A failed page throws, and the drop is judged on a later poll.
  async failedChecks(repo, sha) {
    const pages = await ghJson<{ check_runs?: { name?: string; html_url?: string; status?: string; conclusion?: string | null }[] }[]>(
      ["api", "--paginate", "--slurp", `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
    const runs = pages.flatMap((page) => page.check_runs ?? []);
    return runs.filter((run) => run.status !== "completed" || !PASSING_CONCLUSIONS.includes(run.conclusion ?? ""))
      .map((run) => ({ name: run.name ?? "check", url: run.html_url ?? "", conclusion: run.status === "completed" ? run.conclusion ?? "unknown" : run.status ?? "pending" }));
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
    const event = plain(raw.replace(/^\*\*[^*]+\*\*:\s*/, ""));
    const draft = /\[#(\d+)\]/.exec(raw);
    const kind = /^CI is running\b/i.test(event) ? "running"
      : /added this pull request to the Graphite merge queue/i.test(event) ? "queued"
      : /^Merged by the Graphite merge queue/i.test(event) ? "merged"
      : "dropped";
    return { text: plain(raw), kind, draft: kind === "running" && draft ? Number(draft[1]) : null };
  });
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

// Graphite's queue drafts that list the pull request `number` of `repo`.
function queueDraftsFor(drafts: QueueDraft[], repo: string, number: string): QueueDraft[] {
  const listed = `](https://app.graphite.com/github/pr/${repo}/${number})`;
  return drafts.filter((draft) => draft.title.startsWith(QUEUE_DRAFT_TITLE) && draft.body.includes(listed));
}

// Whether a merge queue drop of the ticket went to the owner: on this pull request, or on any
// other one of the same ticket, including one it replaced.
function ticketEscalated(seenByUrl: Record<string, Seen>, issueId: string, url: string): boolean {
  return Boolean(seenByUrl[url]?.escalated) || Object.values(seenByUrl).some((seen) => seen.ticket === issueId && seen.escalated);
}

// Mirrors each ticket's pull request review into Linear every 2 minutes, sends pull requests the
// Graphite merge queue dropped back to be fixed, and nudges stalled ones to their next step.
export class PullRequestWatch {
  private timer: NodeJS.Timeout | null = null;
  private pausedPool: RateLimitedError["pool"] | null = null;

  constructor(
    private readonly deps: {
      handover: Pick<Handover, "all" | "update">;
      sessions: Pick<SessionRouter, "sessionFor" | "say" | "prompt">;
      linear: Pick<LinearService, "moveToStateNamed" | "comment" | "viewerId" | "userUrl">;
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

  // State from before conflict-only drops were told apart: every drop counts as an ordinary one,
  // and the old policy's escalation (the third drop) stays one.
  private async load(): Promise<Record<string, Seen>> {
    let value: Record<string, Seen>;
    try { value = JSON.parse(await readFile(this.path, "utf8")); } catch { return {}; }
    for (const [url, seen] of Object.entries(value)) {
      if (seen.drops && !seen.conflictDrops) value[url] = { ...seen, conflictDrops: [], escalated: seen.escalated || seen.drops.length > 2 };
    }
    return value;
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
      const seen = seenByUrl[url] && { ...seenByUrl[url], ticket: record.issueId };
      if (seen) seenByUrl[url] = seen;
      // An archived agent's open pull request stays watched, so a merge queue drop still reaches
      // the ticket: until a drop of the ticket escalated to the owner, or 14 days without activity.
      // After-merge tasks keep it watched until the merge.
      const quiet = Date.now() - Math.max(Date.parse(record.updatedAt) || 0, Date.parse(seen?.activeAt ?? "") || 0) > ARCHIVED_WATCH_MS;
      const watched = !seen?.merged && !seen?.closed && !ticketEscalated(seenByUrl, record.issueId, url) && !quiet;
      if (record.status !== "archived" || seen?.pending || watched || await manual?.awaitingMerge(record.issueId)) records.push(record);
    }
    // Graphite's drafts are listed once per repo and poll.
    const drafts = new Map<string, Promise<QueueDraft[]>>();
    const listDrafts = (repo: string) => {
      if (!drafts.has(repo)) drafts.set(repo, (this.deps.github ?? githubReader).drafts(repo));
      return drafts.get(repo)!;
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
    // Stalled pull requests are nudged after every drop was handled: a drop's fix request comes
    // first when both are for the same agent.
    const nudges: { record: HandoverRecord; url: string; view: PullRequestView }[] = [];
    for (const record of records) {
      const url = record.links["Pull request"];
      const going = await step(record, url, async () => {
        const view = await (this.deps.view ?? viewPullRequest)(url);
        const result = reviewChange(view, seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false });
        const { change, seen } = manual ? await this.gate(record, result, manual) : result;
        if (change) await this.apply(record, change);
        if (change?.review === "merged" && manual) await manual.merged(record.issueId);
        // Each step's state is recorded after it, so a failed step is retried on the next poll.
        const now = new Date().toISOString();
        seenByUrl[url] = { ...seen, ticket: record.issueId, closed: view.state === "CLOSED" && !seen.merged, ...(change ? { activeAt: now } : {}) };
        if (view.state !== "OPEN") {
          if (seenByUrl[url].pending) console.error(`[linear-tickets] ${record.identifier}: ${url} is no longer open; the merge queue drop is not reported`);
          seenByUrl[url] = { ...seenByUrl[url], pending: null };
          return;
        }
        let dropped = Boolean(seenByUrl[url].pending);
        // The owner's veto (`do-not-merge`) keeps drops unclaimed and their fixes unsent.
        const vetoed = view.labels.includes(DO_NOT_MERGE_LABEL);
        // A queue draft that carries the pull request again: the agent already re-enqueued it.
        const queued = () => this.queued(url, listDrafts);
        if (!dropped && !vetoed) {
          const handled = seenByUrl[url].drops ?? [];
          const drop = await this.queueDrop(url, view, handled, listDrafts);
          const claimed = drop && await this.claim(record, url, drop, seenByUrl[url], ticketEscalated(seenByUrl, record.issueId, url), queued);
          if (drop && claimed) {
            dropped = true;
            const { pending, conflict } = claimed;
            const conflictDrops = seenByUrl[url].conflictDrops ?? [];
            // Claimed and saved before anything is sent: a later failure, a restart or another
            // poll never sends it twice. An escalation is recorded with the claim, so it stops the
            // ticket's automatic prompts even when its delivery fails.
            seenByUrl[url] = {
              ...seenByUrl[url],
              drops: [...handled, drop.key],
              conflictDrops: conflict ? [...conflictDrops, drop.key] : conflictDrops,
              escalated: seenByUrl[url].escalated || pending?.fix === null,
              pending,
              activeAt: now,
            };
            await save();
          }
        }
        // A pending message is recorded as delivered as soon as it went out, before any session line.
        const pending = seenByUrl[url].pending;
        if (pending && pending.fix !== null && ticketEscalated(seenByUrl, record.issueId, url)) {
          // Claimed while the agent was busy, then another pull request of the ticket escalated:
          // the owner has the ticket, so the automatic fix is never sent (also after a restart).
          console.error(`[linear-tickets] ${record.identifier}: the claimed ${pending.conflict ? "restack" : "fix"} request for ${url} is not sent; the ticket was escalated to the owner`);
          seenByUrl[url] = { ...seenByUrl[url], pending: null };
          await save();
        } else if (pending) await this.deliver(record, url, pending, save, reserved, async () => vetoed || Boolean(pending.conflict && await queued()), async () => {
          seenByUrl[url] = { ...seenByUrl[url], pending: null };
          await save();
        });
        // A stalled pull request gets its next step, but never in a poll that handles a drop.
        if (!dropped) nudges.push({ record, url, view });
      });
      if (!going) break;
    }
    for (const { record, url, view } of stopped.paused || stopped.throttled ? [] : nudges) {
      if (!await step(record, url, () => this.nudge(record, url, view, seenByUrl, save, listDrafts, reserved))) break;
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
    if (last.kind === "dropped") {
      if (draftNumber === null) return { key, reason: last.text, repo, draft: null };
      const draft = (await drafts(repo)).find((item) => item.number === draftNumber);
      return { key, reason: last.text, repo, draft: { number: draftNumber, url: draftUrl, headSha: draft?.headSha || null } };
    }
    if (draftNumber === null) return null;
    const listing = queueDraftsFor(await drafts(repo), repo, number);
    const draft = listing.find((item) => item.number === draftNumber);
    if (!draft || draft.state !== "CLOSED" || listing.some((item) => item.number > draftNumber && item.state === "OPEN")) return null;
    if (await (this.deps.github ?? githubReader).landed(repo, draft)) return null;
    return { key, reason: `The merge queue closed its draft pull request #${draftNumber} without landing it.`, repo, draft: { number: draftNumber, url: draftUrl, headSha: draft.headSha || null } };
  }

  // Whether an open queue draft carries the pull request.
  private async queued(url: string, drafts: (repo: string) => Promise<QueueDraft[]>): Promise<boolean> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (!source) return false;
    const [, repo, number] = source;
    return queueDraftsFor(await drafts(repo), repo, number).some((draft) => draft.state === "OPEN");
  }

  // What a drop sends. A conflict-only drop (TUC-432, the repository's rule in
  // tools/ci/wait-queue.mjs): Graphite names a merge conflict and nothing on the queue's draft
  // failed or still runs, that is no draft, or a known head whose every check run completed
  // passing; Graphite says "merge conflicts" for real failures too. Such drops get up to
  // CONFLICT_PROMPTS restack requests per pull request, any other drop up to DROP_PROMPTS fix
  // requests; the drop after either limit escalates to the owner, which stops both for the whole
  // ticket, and later drops only reach the log. A restack waits (nothing is claimed) while an open
  // queue draft carries the pull request again: null.
  private async claim(record: HandoverRecord, url: string, drop: Drop, seen: Seen, escalated: boolean, queued: () => Promise<boolean>): Promise<{ pending: PendingDrop | null; conflict: boolean } | null> {
    if (escalated) {
      console.error(`[linear-tickets] ${record.identifier}: the merge queue dropped ${url} again; already escalated to the owner`);
      return { pending: null, conflict: false };
    }
    const checks = drop.draft?.headSha ? await (this.deps.github ?? githubReader).failedChecks(drop.repo, drop.draft.headSha) : [];
    const conflict = /merge conflict/i.test(drop.reason) && (drop.draft === null || (drop.draft.headSha !== null && checks.length === 0));
    const conflictDrops = seen.conflictDrops?.length ?? 0;
    const used = conflict ? conflictDrops : (seen.drops?.length ?? 0) - conflictDrops;
    const limit = conflict ? CONFLICT_PROMPTS : DROP_PROMPTS;
    if (conflict && used < limit && await queued()) return null;
    const facts = [
      `The Graphite merge queue dropped [the pull request](${url}) without merging it.`,
      `Reason: ${drop.reason}`,
      ...(!drop.draft?.headSha ? [] : checks.length
        ? [`Checks that did not pass on the queue's draft [#${drop.draft.number}](${drop.draft.url}):`, ...checks.map((check) => `- [${check.name}](${check.url}) — ${check.conclusion}`)]
        : [`No check failed on the queue's draft [#${drop.draft.number}](${drop.draft.url}).`]),
    ].join("\n");
    if (used >= limit) return { pending: { key: drop.key, reason: drop.reason, facts, fix: null, conflict }, conflict };
    const steps = [
      `1. In your stack's worktree${record.worktreePath ? ` (\`${record.worktreePath}\`)` : ""}, on the top branch of the stack, run \`git fetch origin main && git rebase --update-refs --onto origin/main "$(git merge-base HEAD origin/main)"\`. It moves only your own branches; never \`gt sync\` or \`gt restack\`, which move the shared \`main\` and other agents' branches. If your stack sits on a PR that has already landed, or your PR was auto-closed, follow docs/automation/merge-queue.md instead.`,
      ...(conflict
        ? [
          "2. Resolve the conflicts; regenerate generated files with the repository generators instead of hand-merging them (docs/automation/merge-queue.md#conflict-only-drops), run the focused checks, then `gt submit --stack --ignore-out-of-sync-trunk`, wait for green checks with `node tools/ci/wait-checks.mjs <pr>`, check that the PR has no `do-not-merge` label, and run `gt merge`.",
          "",
          `This is automatic conflict restack ${used + 1} of ${CONFLICT_PROMPTS} for this pull request; after that the owner takes over.`,
        ]
        : [
          "2. Fix the cause.",
          "3. Run `gt submit --stack --ignore-out-of-sync-trunk`, then `gt merge`.",
          "",
          "An obviously flaky failure (unrelated to the change) gets one plain `gt merge` retry instead.",
          `This is automatic fix request ${used + 1} of ${DROP_PROMPTS} for this pull request; after that the owner takes over.`,
        ]),
    ];
    return { pending: { key: drop.key, reason: drop.reason, facts, fix: [facts, "", "To land it:", ...steps].join("\n"), conflict }, conflict };
  }

  // Delivers a claimed drop: the fix request to the agent while it exists, otherwise to the ticket,
  // which goes back to coding for the next agent; an escalation to the owner. A fix request waits
  // for a later poll while `held` (the owner's veto, or for a restack an open queue draft that
  // carries the pull request), the agent is in a turn, Paseo is not connected, or the agent already
  // got a message this poll (`reserved`). `sending` is saved right before a message goes out, so
  // one whose result was lost (a restart) is never sent again; `delivered` records it right after,
  // before the best-effort session line.
  private async deliver(record: HandoverRecord, url: string, pending: PendingDrop, save: () => Promise<void>, reserved: Set<string>, held: () => Promise<boolean>, delivered: () => Promise<void>): Promise<void> {
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
        await this.mention(record.issueId, `${pending.conflict
          ? "The merge queue dropped this stack six times for merge conflicts only, so Paseo stops asking the agent to restack it."
          : "The merge queue dropped this stack twice for reasons other than a plain merge conflict, so Paseo stops asking the agent to fix it."} Please take over.\n\n${pending.facts}`);
        await delivered();
        await this.tell(record, "response", `${pending.conflict
          ? "The merge queue dropped the pull request six times for merge conflicts"
          : "The merge queue dropped the pull request twice for reasons other than a plain merge conflict"}; the owner was asked to take over.\n\n${pending.facts}`);
        return;
      }
      if (reserved.has(record.agentId) || await held()) return;
      if (record.status !== "archived") {
        const outcome = await this.deps.sessions.prompt(record.agentId, fix, toAgent);
        if (outcome === "sent") {
          await delivered();
          await this.tell(record, "thought", `The merge queue dropped the pull request (${pending.reason}). The agent was asked to ${pending.conflict ? "restack" : "fix"} it.`);
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

  // The next lifecycle step of a stalled open pull request (see pr-nudge.ts), for its idle agent.
  // Nothing while the owner vetoes merging (`do-not-merge`), the merge queue has (or just landed)
  // the pull request, manual tasks due before the merge are open, or the agent already got a
  // message this poll; these are settled before review threads are read. A stage is claimed per
  // head right before its message goes out: at most STAGE_NUDGES per stage and pull request, then
  // one escalation to the owner, then only the log. A busy agent or a disconnected Paseo claims
  // nothing; the next poll decides again.
  private async nudge(record: HandoverRecord, url: string, view: PullRequestView, seenByUrl: Record<string, Seen>, save: () => Promise<void>, drafts: (repo: string) => Promise<QueueDraft[]>, reserved: Set<string>): Promise<void> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    const last = activityBullets(view.mergeActivity).at(-1);
    // After a drop escalation the owner has the ticket: no lifecycle step re-enqueues it either.
    if (!source || reserved.has(record.agentId) || view.labels.includes(DO_NOT_MERGE_LABEL) || (last && last.kind !== "dropped") || ticketEscalated(seenByUrl, record.issueId, url)) return;
    const [, repo, number] = source;
    if (await this.queued(url, drafts)) return;
    if ((await this.deps.manualTasks?.openBlockers(record.issueId))?.length) return;
    const before = seenByUrl[url].nudges ?? {};
    const heads = (stage: Stage) => before[stage] ?? [];
    const github = this.deps.github ?? githubReader;
    const found = await stalledStage(view, url, Date.now(), (stage, key) => heads(stage).some((entry) => entry.split(" ").includes(key)), () => github.reviewThreads(repo, Number(number)));
    if (!found || heads(found.stage).includes(found.key)) return;
    const { stage, text } = found;
    const sent = heads(stage).length;
    let claimed = false;
    const claim = async () => {
      seenByUrl[url] = { ...seenByUrl[url], nudges: { ...before, [stage]: [...heads(stage), found.key] }, activeAt: new Date().toISOString() };
      claimed = true;
      await save();
    };
    const toAgent = async () => {
      reserved.add(record.agentId);
      await claim();
    };
    try {
      if (sent > STAGE_NUDGES) {
        console.error(`[linear-tickets] ${record.identifier}: ${url} is waiting for the agent to ${STAGE_STEP[stage]} again; already escalated to the owner`);
        await claim();
        return;
      }
      if (sent === STAGE_NUDGES) {
        await claim();
        await this.mention(record.issueId, `Paseo asked the agent ${STAGE_NUDGES} times to ${STAGE_STEP[stage]} on [the pull request](${url}), and it is stuck there again, so Paseo stops asking. Please take over.\n\n${text}`);
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
      if (claimed) seenByUrl[url] = { ...seenByUrl[url], nudges: before };
      throw error;
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
