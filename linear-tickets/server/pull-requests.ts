import { z } from "zod";
import type { CheckSummary, LandedCommit, PullRequestEntry, PullRequestsSnapshot, QueueActivity } from "../shared/contracts";
import { activityBullets, ghJson, GitHubRateLimitedError, QUEUE_MERGED_LABEL } from "./pr-watch";
import { githubBudget, GitHubPausedError, withPriority, type GitHubBudget } from "./rate-budget";

// The Paseo Agents menu bar's pull request view (README, "Pull request view"), read from GitHub
// REST through the routed gh CLI (github-cli.ts): the account router decides which read account
// serves each call; without it, the owner's gh login reads as before. Conditional requests (an
// unchanged resource answers 304 and costs no budget), at most every 2 minutes per repository,
// and only while a client asked for it in the last 10 minutes. GraphQL stays reserved for `gh pr`
// and `gt`.
const REFRESH_MS = 2 * 60 * 1000;
const ACTIVE_MS = 10 * 60 * 1000;
const TICK_MS = 15 * 1000;
// gh processes at once: one per request, on a machine running many agents.
const CONCURRENCY = 4;
const MAX_REPOSITORIES = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Gates fail because a job they wait for failed; the job is the cause.
const GATES = ["PR code", "Platform gate", "Post-merge gate"];
// Passes on a stacked pull request only once its downstack merged (merge-queue.md in the repo).
const IGNORED_CHECKS = ["Graphite / mergeability_check", "mergeability_check"];
const FAILING = ["failure", "timed_out", "action_required", "startup_failure"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A check run on a pull request's head; `suite` is its check suite (a workflow run).
export type CheckRunRecord = { name: string; status: string; conclusion: string | null; startedAt: string | null; htmlUrl: string | null; suite: number | null };
export type WorkflowRunRecord = { id: number; workflowId: number; checkSuiteId: number };
// The REST pull request fields the view shows; `trunk` is the repo's default branch.
type PullFields = Pick<PullRequestEntry, "number" | "title" | "draft" | "htmlUrl" | "createdAt" | "updatedAt" | "user" | "head" | "base" | "labels">;
type PullRecord = PullFields & { trunk: string };

export type RestResponse = { status: number; headers: ReadonlyMap<string, string>; body: string };
// One GET of the REST API (a path below api.github.com); `etag` makes it conditional.
export type RestGet = (path: string, etag: string | null) => Promise<RestResponse>;
// Adds the label to the pull request; resolves to the labels it carries now.
export type LabelPost = (repository: string, number: number, label: string) => Promise<string[]>;

// ISO 8601 without fractional seconds, as GitHub writes times (and Swift's `.iso8601` reads them).
export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The first ticket identifier in a pull request title or commit message (`TUC-343`).
export function ticketIn(text: string): string | null {
  return /\b[A-Z][A-Z0-9]*-\d+\b/.exec(text)?.[0] ?? null;
}

// Suites of workflow runs a later run of the same workflow replaced, e.g. the draft-only `PR code`
// guard once the pull request is marked ready.
export function supersededSuites(runs: WorkflowRunRecord[]): Set<number> {
  const latest = new Map<number, WorkflowRunRecord>();
  for (const run of runs) if ((latest.get(run.workflowId)?.id ?? -Infinity) < run.id) latest.set(run.workflowId, run);
  const kept = new Set([...latest.values()].map((run) => run.checkSuiteId));
  return new Set(runs.map((run) => run.checkSuiteId).filter((suite) => !kept.has(suite)));
}

// CI on a pull request's head: the newest run per check name, runs of superseded suites left out.
export function checkSummary(runs: CheckRunRecord[], superseded: ReadonlySet<number> = new Set()): CheckSummary {
  const started = (run: CheckRunRecord) => Date.parse(run.startedAt ?? "") || -Infinity;
  const newest = new Map<string, CheckRunRecord>();
  for (const run of runs) {
    if (IGNORED_CHECKS.includes(run.name) || (run.suite !== null && superseded.has(run.suite))) continue;
    const seen = newest.get(run.name);
    if (seen && started(seen) >= started(run)) continue;
    newest.set(run.name, run);
  }
  const latest = [...newest.values()];
  const failed = latest.filter((run) => run.status === "completed" && FAILING.includes(run.conclusion ?? ""));
  const jobs = failed.filter((run) => !GATES.includes(run.name));
  const failures = (jobs.length ? jobs : failed)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((run) => ({ name: run.name, url: run.htmlUrl }));
  const done = latest.filter((run) => run.status === "completed").length;
  const running = latest.filter((run) => run.status !== "completed").map(started).filter(Number.isFinite);
  return {
    state: failures.length ? "failed" : latest.length === 0 ? "empty" : done === latest.length ? "passed" : "running",
    done,
    total: latest.length,
    failures,
    runningSince: running.length ? iso(Math.min(...running)) : null,
  };
}

// "Oct 2, 9:40 PM UTC" carries no year: this year, or last year when that is more than a day ahead.
function bulletTime(stamp: string, now: number): number | null {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2}) ([AP]M) UTC$/.exec(stamp);
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (!match || month < 0) return null;
  const hour = (Number(match[3]) % 12) + (match[5] === "PM" ? 12 : 0);
  const year = new Date(now).getUTCFullYear();
  const at = Date.UTC(year, month, Number(match[2]), hour, Number(match[4]));
  return at > now + DAY_MS ? Date.UTC(year - 1, month, Number(match[2]), hour, Number(match[4])) : at;
}

// "…was not satisfying all requirements (Failed CI (PR code))." → "Failed CI (PR code)".
function shortReason(text: string): string {
  const open = text.indexOf("requirements (");
  if (open < 0) return text;
  const reason = text.slice(open + "requirements (".length).replace(/^[. ]+|[. ]+$/g, "");
  return reason.endsWith(")") ? reason.slice(0, -1) : reason;
}

// Where a pull request stands in the Graphite merge queue, from the newest bullet of Graphite's
// "Merge activity" comment (same reading as the repo's tools/ci/wait-queue.mjs).
export function queueActivity(body: string, now: number): QueueActivity | null {
  if (!body.trim().startsWith("### Merge activity")) return null;
  // Only time-stamped bullets (`* **Oct 2, 9:40 PM UTC**: …`) are events.
  const bullets = activityBullets(body).flatMap((bullet) => (bullet.at === null ? [] : [{ ...bullet, time: bulletTime(bullet.at, now) }]));
  const last = bullets.at(-1);
  if (!last) return null;
  const kind = last.kind === "running" ? "testing" : last.kind;
  const removal = "removed this pull request due to ";
  const cut = last.event.indexOf(removal);
  return {
    kind,
    draft: kind === "testing" ? last.draft ?? 0 : null,
    reason: kind !== "dropped" ? null : shortReason(cut < 0 ? last.event : last.event.slice(cut + removal.length).replace(/^[. ]+|[. ]+$/g, "")),
    at: last.time === null ? null : iso(last.time),
    // Only explicit removals count; other bullets read as drops only when they are the newest.
    dropsToday: bullets.filter((bullet) => bullet.event.includes("removed this pull request") && (bullet.time ?? -Infinity) >= now - DAY_MS).length,
    inQueue: kind === "queued" || kind === "testing",
  };
}

export function pullEntry(pull: PullFields, checks: CheckSummary | null, queue: QueueActivity | null): PullRequestEntry {
  return {
    number: pull.number,
    title: pull.title,
    draft: pull.draft,
    htmlUrl: pull.htmlUrl,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    user: pull.user,
    head: pull.head,
    base: pull.base,
    labels: pull.labels,
    // From the title only: branch names like `dependabot/…/tailwindcss-4` look like tickets.
    ticket: ticketIn(pull.title),
    // Without the "Add TUC-343 [repo] " prefix the repo's pull request titles carry.
    shortTitle: pull.title.replace(/^\w+ [A-Z][A-Z0-9]*-\d+ \[[^\]]+\] /, ""),
    // Queued by Graphite (the queue writes the label) but no longer in the queue.
    hasStaleQueueLabel: pull.labels.some((label) => label.name === QUEUE_MERGED_LABEL) && !(queue?.inQueue ?? false),
    checks,
    queue,
  };
}

// gh's one-line reason ("Not Found (HTTP 404)"), not the whole command line.
function ghMessage(error: unknown): string {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
  if (stderr) return stderr.split("\n")[0].replace(/^gh: /, "");
  return error instanceof Error ? error.message : String(error);
}

// `gh api -i` prints the status line and the headers, a blank line, then the body.
function parseIncluded(stdout: string): RestResponse {
  const gap = /\r?\n\r?\n/.exec(stdout);
  const [status = "", ...lines] = (gap ? stdout.slice(0, gap.index) : stdout).split(/\r?\n/);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(/^HTTP\/\S+ (\d{3})/.exec(status)?.[1] ?? 0), headers, body: gap ? stdout.slice(gap.index + gap[0].length) : "" };
}

export const ghGet: RestGet = async (path, etag) => {
  try {
    return await ghJson(["api", "-i", ...(etag ? ["-H", `If-None-Match: ${etag}`] : []), path], parseIncluded);
  } catch (error) {
    // gh exits with an error on 304 Not Modified; its output still holds the headers.
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    if (/^HTTP\/\S+ 304\b/.test(stdout)) return parseIncluded(stdout);
    throw error;
  }
};

export const ghLabel: LabelPost = (repository, number, label) =>
  ghJson<string[]>(["api", "-X", "POST", `repos/${repository}/issues/${number}/labels`, "-f", `labels[]=${label}`, "--jq", "[.[].name]"]);

type Cached = { etag: string; items: unknown[]; next: string | null; pass: number };

// Listings with their ETags, page by page (each page keeps only the fields the view uses). Every
// request passes the GitHub budget first, at the caller's priority.
class ConditionalReader {
  private readonly cache = new Map<string, Cached>();
  private pass = 0;
  private abandoned = -1;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly get: RestGet, private readonly budget: GitHubBudget) {}

  begin(): void {
    this.pass++;
  }

  // After a failed pass: requests still queued for it are not sent.
  abandon(): void {
    this.abandoned = this.pass;
  }

  // After a complete pass: what it did not read (closed pull requests, old heads) is dropped.
  sweep(): void {
    for (const [path, entry] of this.cache) if (entry.pass !== this.pass) this.cache.delete(path);
  }

  // Every page of a listing (following `Link: rel="next"`), up to `maxPages`.
  async pages<T>(path: string, maxPages: number, map: (json: unknown) => T[]): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    for (let page = 0; next && page < maxPages; page++) {
      const entry = await this.page(next, map);
      items.push(...(entry.items as T[]));
      next = entry.next;
    }
    return items;
  }

  private async page(path: string, map: (json: unknown) => unknown[]): Promise<Cached> {
    const pass = this.pass;
    while (this.active >= CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      if (this.abandoned === pass) throw new Error("abandoned");
      this.budget.admit();
      const cached = this.cache.get(path);
      const response = await this.get(path, cached?.etag ?? null).catch((error: unknown) => {
        throw error instanceof GitHubRateLimitedError ? this.budget.refused(error) : error;
      });
      this.budget.record(response.headers);
      if (response.status === 304 && cached) {
        cached.pass = pass;
        return cached;
      }
      if (response.status !== 200) throw new Error(`GitHub answered HTTP ${response.status} for ${path}`);
      const link = response.headers.get("link")?.split(",").find((part) => part.includes('rel="next"'));
      const next = link ? /<https:\/\/api\.github\.com\/([^>]+)>/.exec(link)?.[1] ?? null : null;
      const entry = { etag: response.headers.get("etag") ?? "", items: map(JSON.parse(response.body)), next, pass };
      if (entry.etag) this.cache.set(path, entry);
      return entry;
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

// GitHub REST responses, only the fields the view uses (zod drops the rest before caching).
const pullsJson = z.array(z.object({
  number: z.number().int(),
  title: z.string(),
  draft: z.boolean().nullish(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ default_branch: z.string() }).nullish() }),
  labels: z.array(z.object({ name: z.string() })),
}));
const checkRunsJson = z.object({
  check_runs: z.array(z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    started_at: z.string().nullish(),
    html_url: z.string().nullish(),
    check_suite: z.object({ id: z.number() }).nullish(),
  })),
});
const workflowRunsJson = z.object({ workflow_runs: z.array(z.object({ id: z.number(), workflow_id: z.number(), check_suite_id: z.number() })) });
const commentsJson = z.array(z.object({ user: z.object({ login: z.string() }).nullable(), body: z.string().nullish() }));
const commitsJson = z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string(), committer: z.object({ date: z.string() }).nullable() }) }));

type Repo = { snapshot: PullRequestsSnapshot; askedAt: number; attemptAt: number; running: Promise<void> | null; reader: ConditionalReader };

export class PullRequestBoard {
  private readonly repos = new Map<string, Repo>();
  private timer: NodeJS.Timeout | undefined;
  private readonly get: RestGet;
  private readonly post: LabelPost;
  private readonly budget: GitHubBudget;
  private readonly now: () => number;

  constructor(deps: { get?: RestGet; post?: LabelPost; budget?: GitHubBudget; now?: () => number } = {}) {
    this.get = deps.get ?? ghGet;
    this.post = deps.post ?? ghLabel;
    this.budget = deps.budget ?? githubBudget;
    this.now = deps.now ?? (() => Date.now());
  }

  // Served from memory, never waiting on GitHub; asking keeps the repository polled for 10 minutes.
  read(repository: string): PullRequestsSnapshot {
    const repo = this.repo(repository);
    repo.askedAt = this.now();
    this.due(repository, repo);
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref?.();
    }
    return this.view(repo);
  }

  // The poll in flight for the repository, if any.
  async settled(repository: string): Promise<void> {
    await this.repos.get(repository)?.running;
  }

  // Polls the repositories asked for in the last 10 minutes that are due; with none, the timer stops.
  tick(): void {
    let active = false;
    for (const [repository, repo] of this.repos) {
      if (this.now() - repo.askedAt > ACTIVE_MS) continue;
      active = true;
      this.due(repository, repo);
    }
    if (!active) this.stop();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // In order, stopping at the first pull request GitHub refuses. The labels GitHub answers with go
  // into the snapshot at once, without another read.
  async label(repository: string, label: string, numbers: number[]): Promise<{ labelled: number[]; error: string | null; snapshot: PullRequestsSnapshot }> {
    const repo = this.repo(repository);
    const labelled: number[] = [];
    let error: string | null = null;
    await withPriority("interactive", async () => {
      for (const number of numbers) {
        try {
          this.budget.admit();
          const labels = (await this.post(repository, number, label)).map((name) => ({ name }));
          labelled.push(number);
          const relabel = (list: PullRequestEntry[]) => list.map((pull) => (pull.number === number ? pullEntry({ ...pull, labels }, pull.checks, pull.queue) : pull));
          repo.snapshot = { ...repo.snapshot, pulls: relabel(repo.snapshot.pulls), queueDrafts: relabel(repo.snapshot.queueDrafts) };
        } catch (failure) {
          if (failure instanceof GitHubRateLimitedError) this.budget.refused(failure);
          error = `GitHub refused #${number}: ${ghMessage(failure)}`;
          break;
        }
      }
    });
    return { labelled, error, snapshot: this.view(repo) };
  }

  private repo(repository: string): Repo {
    const known = this.repos.get(repository);
    if (known) return known;
    const repo: Repo = {
      snapshot: { repository, fetchedAt: null, refreshing: false, error: null, rateLimited: null, rateLimit: null, refreshIntervalSeconds: REFRESH_MS / 1000, pulls: [], queueDrafts: [], landedRecently: [] },
      askedAt: this.now(),
      attemptAt: -Infinity,
      running: null,
      reader: new ConditionalReader(this.get, this.budget),
    };
    this.repos.set(repository, repo);
    if (this.repos.size > MAX_REPOSITORIES) {
      const idle = [...this.repos].filter(([, other]) => !other.running).sort((a, b) => a[1].askedAt - b[1].askedAt)[0];
      if (idle) this.repos.delete(idle[0]);
    }
    return repo;
  }

  private view(repo: Repo): PullRequestsSnapshot {
    const limit = this.budget.current();
    return { ...repo.snapshot, refreshing: repo.running !== null, rateLimit: limit && { remaining: limit.remaining, limit: limit.limit, resetsAt: iso(limit.resetAt) } };
  }

  private due(repository: string, repo: Repo): void {
    if (repo.running || this.now() - repo.attemptAt < REFRESH_MS) return;
    repo.attemptAt = this.now();
    repo.running = withPriority("background", () => this.refresh(repository, repo)).finally(() => { repo.running = null; });
  }

  // Background priority: with the single-login budget, below its reserve the poll stops and the
  // last data stays; with the router installed the call would not have been made below a read
  // budget.
  private async refresh(repository: string, repo: Repo): Promise<void> {
    repo.reader.begin();
    try {
      const fetched = await this.fetch(repository, repo.reader);
      repo.reader.sweep();
      repo.snapshot = { ...repo.snapshot, ...fetched, fetchedAt: iso(this.now()), error: null, rateLimited: null };
    } catch (error) {
      repo.reader.abandon();
      repo.snapshot = error instanceof GitHubPausedError
        ? { ...repo.snapshot, error: null, rateLimited: { reason: error.reason, until: iso(error.resumeAt), message: error.message } }
        : { ...repo.snapshot, rateLimited: null, error: ghMessage(error) };
    }
  }

  private async fetch(repository: string, reader: ConditionalReader): Promise<Pick<PullRequestsSnapshot, "pulls" | "queueDrafts" | "landedRecently">> {
    const now = this.now();
    const open = await reader.pages(`repos/${repository}/pulls?state=open&per_page=100`, 5, (json) => pullsJson.parse(json).map((pull): PullRecord => ({
      number: pull.number,
      title: pull.title,
      draft: pull.draft ?? false,
      htmlUrl: pull.html_url,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      user: { login: pull.user?.login ?? "" },
      head: pull.head,
      base: { ref: pull.base.ref, sha: pull.base.sha },
      labels: pull.labels,
      trunk: pull.base.repo?.default_branch ?? "main",
    })));
    const sources: PullRecord[] = [];
    const drafts: PullRecord[] = [];
    for (const pull of open) (pull.head.ref.startsWith("gtmq_") && pull.user.login === "graphite-app[bot]" ? drafts : sources).push(pull);
    // Drafts run no code CI and are never queued: only ready pull requests and queue drafts are
    // looked at in detail.
    const ready = sources.filter((pull) => !pull.draft);
    const [checks, queues, landedRecently] = await Promise.all([
      Promise.all([...ready, ...drafts].map(async (pull) => [pull.number, await this.checks(repository, reader, pull.head.sha)] as const)),
      Promise.all(ready.map(async (pull) => [pull.number, await this.queue(repository, reader, pull.number, now)] as const)),
      this.landed(repository, reader, open[0]?.trunk ?? "main", now),
    ]);
    const checkMap = new Map(checks);
    const queueMap = new Map(queues);
    return {
      pulls: sources.map((pull) => pullEntry(pull, checkMap.get(pull.number) ?? null, queueMap.get(pull.number) ?? null)),
      queueDrafts: drafts.map((pull) => pullEntry(pull, checkMap.get(pull.number) ?? null, null)),
      landedRecently,
    };
  }

  private async checks(repository: string, reader: ConditionalReader, sha: string): Promise<CheckSummary> {
    const runs = await reader.pages(`repos/${repository}/commits/${sha}/check-runs?per_page=100`, 3, (json) => checkRunsJson.parse(json).check_runs.map((run): CheckRunRecord => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.started_at ?? null,
      htmlUrl: run.html_url ?? null,
      suite: run.check_suite?.id ?? null,
    })));
    const workflows = await reader.pages(`repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`, 2, (json) => workflowRunsJson.parse(json).workflow_runs.map((run): WorkflowRunRecord => ({
      id: run.id,
      workflowId: run.workflow_id,
      checkSuiteId: run.check_suite_id,
    })));
    return checkSummary(runs, supersededSuites(workflows));
  }

  private async queue(repository: string, reader: ConditionalReader, number: number, now: number): Promise<QueueActivity | null> {
    // Only Graphite's Merge activity comments are kept from the pages.
    const bodies = await reader.pages(`repos/${repository}/issues/${number}/comments?per_page=100`, 3, (json) => commentsJson.parse(json)
      .filter((comment) => (comment.user?.login ?? "").startsWith("graphite-app") && (comment.body ?? "").includes("### Merge activity"))
      .map((comment) => comment.body ?? ""));
    const body = bodies.at(-1);
    return body === undefined ? null : queueActivity(body, now);
  }

  private async landed(repository: string, reader: ConditionalReader, trunk: string, now: number): Promise<LandedCommit[]> {
    // Rounded to the hour so the URL, and with it the ETag, stays the same for an hour.
    const since = iso(Math.floor(now / HOUR_MS) * HOUR_MS - DAY_MS);
    return reader.pages(`repos/${repository}/commits?sha=${encodeURIComponent(trunk)}&since=${since}&per_page=100`, 2, (json) => commitsJson.parse(json).map((entry) => {
      const title = entry.commit.message.split("\n")[0];
      return { sha: entry.sha, title, date: entry.commit.committer?.date ?? "", ticket: ticketIn(title) };
    }));
  }
}
