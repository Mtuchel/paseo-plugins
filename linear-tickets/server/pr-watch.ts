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
import {
  activityBoundary, BACKSTOP_ENQUEUE, BackstopCheckout, CLASS_TEXT, commentOnce, dropWhy, ENQUEUE_READY, enqueueArgs, enqueuedComment, HELD_KINDS, parseEnqueue, parseExpect, parseJudgment, parseReady,
  READY_WHY, readyArgs, reconcile, refusalKey, refusalText, released, REPAIR_RETRY_MS, REPAIRABLE_KINDS, runNodeScript, ticketMarker, WAIT_QUEUE, waitQueueArgs,
  type ActionRecord, type DropClass, type DropJudgment, type Problem, type Refusal, type ScriptRunner,
} from "./queue-backstop";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { SessionRouter } from "./sessions";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

const exec = promisify(execFile);
const INTERVAL_MS = 2 * 60 * 1000;
// The queue backstop (see queueBackstop) runs this often, and right after a poll claimed a drop
// it re-enqueues.
const BACKSTOP_INTERVAL_MS = 10 * 60 * 1000;
// Finished actions and refusals are kept this long, so a round is never acted on twice.
const BACKSTOP_MEMORY_MS = 14 * 24 * 60 * 60 * 1000;
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
// Main-broken drops have no budget: they count toward neither limit. An automatic re-enqueue after
// a flaky or infra drop counts as a plain drop.
const DROP_PROMPTS: Record<Exclude<DropKind, "main">, number> = { plain: 1, conflict: 5 };
// How the repo's drop class counts (see claimDrop).
const DROP_KIND: Record<DropClass, DropKind> = { conflictOnly: "conflict", mainBroken: "main", infra: "plain", flaky: "plain", genuine: "plain" };
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
// drops before any draft, by the Merge activity bullet, on every pull request of the dropped range:
// `drops` the plain ones (and every drop claimed before drops had kinds), `conflicts` the
// conflict-only ones, `mainBroken` the main-broken ones (counted toward neither limit).
// `escalated`: a drop went to the owner (every pull request of the range is marked); before drops
// had kinds that was the third drop. `pending`: the claimed drop (or refused enqueue) still to be
// delivered, `queued` the messages routed to the same pull request while it was, delivered in turn
// after it (see route). `replay`: closed without merging, `due` until the closure was looked at once,
// `asked` once the agent was told to open a replacement pull request (see replace). `nudges`: per
// stage, one key per nudge (or the escalation after them): the head, or for requested changes the
// reviews it covered, space-separated (see stalledStage). `activeAt`: the last change, drop or
// nudge seen. `missing`: GitHub has no pull request at the link (a made-up or mistyped URL); it is
// never read again, so a later pull request that takes the number is not mistaken for the ticket's.
// `advance`: landed, `due` until the ticket's next open pull request was looked for (see advance).
// The queue backstop's state (see queueBackstop): `blockedAt`, the head a genuine drop (or a drop
// whose code could not be compared) left, which no automatic enqueue touches until a new head;
// `actions`, its enqueues of ranges whose top this is; `refusals`, their refused enqueues.
type Seen = {
  reviewedAt: string | null; decision: string | null; merged: boolean; held?: boolean; closed?: boolean; drops?: string[]; conflicts?: string[]; mainBroken?: string[]; escalated?: boolean; pending?: PendingDrop | null; queued?: PendingDrop[]; replay?: "due" | "asked"; nudges?: Partial<Record<Stage, string[]>>; activeAt?: string; missing?: boolean; advance?: "due";
  blockedAt?: string; actions?: ActionRecord[]; refusals?: Refusal[];
};
// A claimed drop or refused enqueue, saved before anything is sent. `fix` goes to the agent (or,
// when it is gone, to the ticket); without it, `facts` escalate to the owner. `sending`: a message
// went out and its result was not recorded (a restart or a failed save), so it is not sent again.
// `subject` names it in the agent panel ("The merge queue dropped the pull request" by default).
// `orphan`: the pull request has no handover record, so it goes to its tickets, or without one as
// a pull request comment (see deliverOrphan).
type PendingDrop = { key: string; reason: string; facts: string; fix: string | null; sending?: boolean; subject?: string; orphan?: { tickets: string[] } };
type Change = { thought: string; review: string; state?: string };

// A draft pull request the merge queue tests a stack on; `base` is the branch it lands on.
export type QueueDraft = { number: number; title: string; body: string; state: string; headSha: string; base: string };
// An open pull request of the repo, from one listing per repo and poll; `trunk` is the repo's
// default branch.
export type OpenPull = { number: number; url: string; title: string; headBranch: string; headSha: string; baseBranch: string; trunk: string; draft: boolean; labels: string[] };
// The GitHub reads beyond the pull request itself, and the queue backstop's pull request comments;
// `repo` is `owner/name`.
export type GitHubReader = {
  // Graphite's recent draft pull requests in the repo (the latest 30).
  drafts(repo: string): Promise<QueueDraft[]>;
  // One pull request's state as REST names it (`open` or `closed`), however old it is.
  pullState(repo: string, number: number): Promise<string>;
  // Whether the draft's head reached its base branch.
  landed(repo: string, draft: QueueDraft): Promise<boolean>;
  reviewThreads(repo: string, number: number): Promise<ReviewThread[]>;
  // Every open pull request of the repo (REST, every page).
  openPullRequests(repo: string): Promise<OpenPull[]>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  // The bodies of the pull request's conversation comments (REST, every page), and a new one.
  pullComments(repo: string, number: number): Promise<string[]>;
  commentOnPull(repo: string, number: number, body: string): Promise<void>;
};
// The queue backstop's runners (see queueBackstop): the repo's scripts, the checkout they run in,
// and the clock its hourly retries use.
export type BackstopDeps = { run?: ScriptRunner; checkout?: Pick<BackstopCheckout, "prepare" | "commentFile">; now?: () => number };
// `repo` is the pull request's `owner/name` and `number` its number; `draft.headSha` is null when
// the draft is no longer listed, and `draft.pulls` are the pull requests its body lists (none then).
type Drop = { key: string; reason: string; repo: string; number: number; draft: { number: number; url: string; headSha: string | null; pulls: number[] } | null };
// `conflict`: the repo's class is conflictOnly; `main`: mainBroken; `plain`: any other class.
type DropKind = "plain" | "conflict" | "main";
// What one poll or backstop run reads at most once per repo.
type RunContext = { records: HandoverRecord[]; pulls(repo: string): Promise<OpenPull[]>; drafts(repo: string): Promise<QueueDraft[]>; checkout(repo: string): Promise<string | null>; now: number };

const pullUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;
const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

// The pull request's entry, created when it has none.
function entry(seenByUrl: Record<string, Seen>, url: string): Seen {
  seenByUrl[url] ??= { reviewedAt: null, decision: null, merged: false };
  return seenByUrl[url];
}

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
  async pullState(repo, number) {
    return ghJson(["api", `repos/${repo}/pulls/${number}`, "--jq", ".state"], (stdout) => stdout.trim());
  },
  async landed(repo, draft) {
    // Compared from the draft's head: the base branch is `identical` or `ahead` once it contains it.
    const { status } = await ghJson<{ status?: string }>(["api", `repos/${repo}/compare/${draft.headSha}...${encodeURIComponent(draft.base)}`, "--jq", "{status}"]);
    return status === "identical" || status === "ahead";
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
  // Every page: a marker on any page means the comment is already there.
  async pullComments(repo, number) {
    return ghJson(["api", "--paginate", `repos/${repo}/issues/${number}/comments?per_page=100`, "--jq", "[.[] | .body]"], pages<string>);
  },
  async commentOnPull(repo, number, body) {
    await ghJson(["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`, "--jq", "{id}"]);
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

// A drop went to the owner. Before drops had kinds, the third drop did.
function escalated(seen: Seen | undefined): boolean {
  return Boolean(seen?.escalated) || (seen?.drops?.length ?? 0) > 2;
}

// Every drop key claimed on the pull request, of any kind.
function handledDrops(seen: Seen | undefined): string[] {
  return [...(seen?.drops ?? []), ...(seen?.conflicts ?? []), ...(seen?.mainBroken ?? [])];
}

// The pull request's message slot once its pending message went out: the next message routed to
// it while that one waited, if any (see route).
function nextMessage(seen: Seen): Pick<Seen, "pending" | "queued"> {
  const [next = null, ...rest] = seen.queued ?? [];
  return { pending: next, queued: rest.length ? rest : undefined };
}

// The dropped queue range, lowest first, with its top pull request and that one's branch, the one
// `gt merge` ran on: the range `wait-queue.mjs` compared, else the dropped pull request's own
// chain among the open pull requests the queue's draft listed (a draft can test other stacks too).
function dropRange(drop: Drop, judgment: DropJudgment, open: OpenPull[]): { prs: number[]; top: number; branch: string } {
  const branchOf = (top: number) => judgment.revision.branch ?? open.find((pull) => pull.number === top)?.headBranch ?? "";
  const compared = parseExpect(judgment.revision.expect ?? "")?.map((member) => member.pr);
  if (compared?.length) return { prs: [...new Set([...compared, drop.number])].sort((a, b) => a - b), top: compared[compared.length - 1], branch: branchOf(compared[compared.length - 1]) };
  const listed = open.filter((pull) => drop.draft?.pulls.includes(pull.number) || pull.number === drop.number);
  const dropped = listed.find((pull) => pull.number === drop.number);
  const chain = [drop.number];
  for (let below = dropped; below;) {
    const current: OpenPull = below;
    below = listed.find((pull) => pull.headBranch === current.baseBranch && !chain.includes(pull.number));
    if (below) chain.push(below.number);
  }
  let top = drop.number;
  for (let above = dropped; above;) {
    const current: OpenPull = above;
    above = listed.filter((pull) => pull.baseBranch === current.headBranch && !chain.includes(pull.number)).sort((a, b) => b.number - a.number)[0];
    if (above) {
      chain.push(above.number);
      top = above.number;
    }
  }
  return { prs: chain.sort((a, b) => a - b), top, branch: branchOf(top) };
}

// The round right after the backstop's own enqueue of the very heads that are open now: that
// enqueue proves the code is the code that dropped, whatever the comparison says. Each enqueued
// action is followed by one round only: the drop marks every action of its pull request.
function ownRound(drop: Drop, seenByUrl: Record<string, Seen>, open: OpenPull[]): { expect: string; branch: string } | null {
  let found: { expect: string; branch: string } | null = null;
  for (const [url, seen] of Object.entries(seenByUrl)) {
    if (PULL_URL.exec(url)?.[1] !== drop.repo) continue;
    for (const action of seen.actions ?? []) {
      if (action.steps.enqueue !== "enqueued" || !action.prs.includes(drop.number) || (action.followedBy ?? drop.key) !== drop.key) continue;
      action.followedBy = drop.key;
      const heads = parseExpect(action.expect) ?? [];
      if (heads.length && heads.every((member) => open.some((pull) => pull.number === member.pr && pull.headSha === member.sha))) found = { expect: action.expect, branch: action.branch };
    }
  }
  return found;
}

const TICKET_ID = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]*-\d+)(?![A-Za-z0-9])/g;

// The tickets of a repo's pull requests: the record's, those whose records link one of them, and
// those their open pull requests' titles name (an identifier Linear does not know is dropped later).
function ticketsOf(repo: string, prs: number[], open: OpenPull[], records: HandoverRecord[], record: HandoverRecord | null): string[] {
  const pulls = open.filter((pull) => prs.includes(pull.number));
  const urls = prs.map((pr) => pullUrl(repo, pr));
  const found = new Set(record ? [record.identifier] : []);
  for (const item of records) {
    if (urls.includes(item.links["Pull request"] ?? "") || pulls.some((pull) => namesTicket(item.identifier).test(pull.title))) found.add(item.identifier);
  }
  for (const pull of pulls) for (const match of pull.title.matchAll(TICKET_ID)) found.add(match[1]);
  return [...found].sort();
}

// The handover record of one of the tickets: a running agent's first, else the latest one.
function recordFor(tickets: string[], records: HandoverRecord[]): HandoverRecord | null {
  const own = records.filter((record) => tickets.includes(record.identifier)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return own.find((record) => record.status !== "archived") ?? own[0] ?? null;
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
// Graphite merge queue dropped back to be fixed (or re-enqueues them when the drop was not their
// fault), enqueues ready stacks nobody enqueued (see queueBackstop), nudges stalled ones to their
// next step, and follows a pull request closed after part of its stack landed to its replacement.
export class PullRequestWatch {
  private timer: NodeJS.Timeout | null = null;
  private backstopTimer: NodeJS.Timeout | null = null;
  private pausedPool: RateLimitedError["pool"] | null = null;
  // A poll created an enqueue action: the backstop runs right after it instead of within 10 minutes.
  private kicked = false;

  constructor(
    private readonly deps: {
      handover: Pick<Handover, "all" | "update">;
      sessions: Pick<SessionRouter, "sessionFor" | "say" | "prompt" | "link">;
      // `issueState` finds a ticket that has no handover record by its identifier.
      linear: Pick<LinearService, "moveToStateNamed" | "comment" | "hasComment" | "viewerId" | "userUrl" | "linkUrl"> & Partial<Pick<LinearService, "issueState">>;
      // `tasks` finds the before-merge tasks of tickets that have no handover record.
      manualTasks?: Pick<ManualTasks, "openBlockers" | "merged" | "awaitingMerge"> & Partial<Pick<ManualTasks, "tasks">>;
      settings: Pick<Settings, "read">;
      view?: (url: string) => Promise<PullRequestView>;
      github?: GitHubReader;
      backstop?: BackstopDeps;
    },
    private readonly path = join(paseoHome(), "linear-tickets", "pr-watch.json"),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().then(() => {
        if (!this.kicked) return;
        this.kicked = false;
        void this.backstop();
      });
    }, INTERVAL_MS);
    this.timer.unref?.();
    this.backstopTimer = setInterval(() => { void this.backstop(); }, BACKSTOP_INTERVAL_MS);
    this.backstopTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    clearInterval(this.backstopTimer ?? undefined);
    this.timer = null;
    this.backstopTimer = null;
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
  private backstopping: Promise<void> | null = null;
  private githubThrottled = false;
  // The poll and the backstop share pr-watch.json, so they take turns.
  private turn: Promise<unknown> = Promise.resolve();

  private exclusive(work: () => Promise<void>): Promise<void> {
    const next = this.turn.then(work, work);
    this.turn = next.catch(() => {});
    return next;
  }

  // Background priority: requests stop at their pool's reserve. A pause ends the poll (logged once
  // per pool); unsaved records are retried on the next poll. One poll at a time: a tick while the
  // last one still runs joins it.
  poll(): Promise<void> {
    this.running ??= this.exclusive(() => withPriority("background", () => this.watch())).finally(() => { this.running = null; });
    return this.running;
  }

  // One queue backstop run at a time (see queueBackstop); a tick while one runs joins it.
  backstop(): Promise<void> {
    this.backstopping ??= this.exclusive(() => withPriority("background", () => this.queueBackstop())).finally(() => { this.backstopping = null; });
    return this.backstopping;
  }

  private github(): GitHubReader {
    return this.deps.github ?? githubReader;
  }

  private view(url: string): Promise<PullRequestView> {
    return (this.deps.view ?? viewPullRequest)(url);
  }

  // The poll's and the backstop's reads, once per repo: the open pull requests, Graphite's drafts
  // and the backstop checkout (made from the worktree of any record of the repo).
  private context(records: HandoverRecord[]): RunContext {
    const pulls = new Map<string, Promise<OpenPull[]>>();
    const drafts = new Map<string, Promise<QueueDraft[]>>();
    const checkouts = new Map<string, Promise<string | null>>();
    const checkout = this.deps.backstop?.checkout ?? new BackstopCheckout();
    return {
      records,
      now: this.deps.backstop?.now?.() ?? Date.now(),
      pulls: (repo) => {
        const listing = pulls.get(repo) ?? this.github().openPullRequests(repo);
        pulls.set(repo, listing);
        return listing;
      },
      drafts: (repo) => {
        const listing = drafts.get(repo) ?? this.github().drafts(repo);
        drafts.set(repo, listing);
        return listing;
      },
      checkout: (repo) => {
        const sources = records.filter((record) => PULL_URL.exec(record.links["Pull request"] ?? "")?.[1] === repo && record.worktreePath).map((record) => record.worktreePath ?? "");
        const path = checkouts.get(repo) ?? checkout.prepare(repo, sources);
        checkouts.set(repo, path);
        return path;
      },
    };
  }

  private async watch(): Promise<void> {
    const seenByUrl = await this.load();
    const manual = this.deps.manualTasks;
    const all = await this.deps.handover.all();
    const records: HandoverRecord[] = [];
    for (const record of all) {
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
    const context = this.context(all);
    const listDrafts = context.drafts;
    const listPulls = context.pulls;
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
          seenByUrl[url] = { ...(seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false }), missing: true, pending: null, queued: undefined };
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
          seenByUrl[url] = { ...seenByUrl[url], pending: null, queued: undefined };
          if (closed || seen.merged) nudges.push({ record, url, view });
          return;
        }
        let dropped = Boolean(seenByUrl[url].pending);
        if (!dropped) {
          const drop = await this.queueDrop(url, view, handledDrops(seenByUrl[url]), listDrafts);
          // Claimed and saved before anything is sent: a later failure, a restart or another
          // poll never sends it twice. A failed read in claimDrop saves nothing: the next poll
          // claims it, and so does a round the repo's wait-queue.mjs does not call dropped yet.
          if (drop && await this.claimDrop(drop, record, seenByUrl, context)) {
            dropped = true;
            seenByUrl[url] = { ...seenByUrl[url], activeAt: now };
            await save();
          }
        }
        const pending = seenByUrl[url].pending;
        // Recorded as delivered as soon as the message went out, before any session line.
        if (pending) await this.deliver(record, url, pending, save, reserved, async () => {
          seenByUrl[url] = { ...seenByUrl[url], ...nextMessage(seenByUrl[url]) };
          await save();
        });
        // A stalled pull request gets its next step, but never in a poll that handles a drop.
        if (!dropped) nudges.push({ record, url, view });
      });
      if (!going) break;
    }
    for (const { record, url, view } of stopped.paused || stopped.throttled ? [] : nudges) {
      const next = view.state === "OPEN" ? () => this.nudge(record, url, view, seenByUrl, save, listDrafts, reserved)
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

  // A drop as the repo's `wait-queue.mjs` judges it (class, requeue, revision; see
  // queue-backstop.ts), claimed on every pull request of the dropped range and counted by class:
  // conflict-only toward the restack limit, main-broken toward none, every other class toward the
  // plain limit. The range counts as its most-dropped pull request: the next drop of a counted kind
  // past its limit on any of them escalates to the owner, and so does a drop of a range one of
  // whose pull requests escalated already (every pull request of the range is marked); after the
  // escalation drops of any kind only reach the log. A newer round retires the range's automatic
  // enqueues that had not gone through yet (see supersede), unless the range changed since the
  // drop. Otherwise:
  // - not the stack's fault, the code provably the code that dropped (`same`, or the backstop's
  //   own enqueue of the current heads came right before the round) and no manual task due before
  //   the merge open: the backstop re-enqueues the range (an action, see advanceAction);
  // - genuine: the fix request; the backstop leaves the range alone until a new head (`blockedAt`);
  // - not genuine, but the code changed since the drop: nothing is sent, the new code goes through
  //   the ready rule;
  // - not genuine, but the code could not be compared: the kind's request goes to the agent with
  //   why Paseo did not re-enqueue, and the range is blocked like a genuine drop;
  // - a manual task is open: the kind's request goes to the agent, to re-enqueue once it is done.
  // Requests re-enqueue the dropped range from its top branch, never the stack's top branch above
  // it, which would enqueue pull requests that are not ready. False when nothing was claimed: the
  // repo's script does not call the round dropped (yet). A failed read throws and claims nothing.
  private async claimDrop(drop: Drop, record: HandoverRecord | null, seenByUrl: Record<string, Seen>, context: RunContext): Promise<boolean> {
    const url = pullUrl(drop.repo, drop.number);
    const seen = entry(seenByUrl, url);
    if (escalated(seen)) {
      console.error(`[linear-tickets] ${record?.identifier ?? drop.repo}: the merge queue dropped ${url} again; already escalated to the owner`);
      // The kind no longer matters: the key only keeps the drop from being claimed again.
      seen.drops = [...(seen.drops ?? []), drop.key];
      this.supersede(drop.repo, [drop.number], drop.key, seenByUrl);
      return true;
    }
    const judgment = await this.judge(drop.repo, drop.number, drop.draft?.number ?? null, context);
    if (!judgment) return false;
    const open = await context.pulls(drop.repo);
    const range = dropRange(drop, judgment, open);
    const kind = DROP_KIND[judgment.class];
    const list = kind === "conflict" ? "conflicts" : kind === "main" ? "mainBroken" : "drops";
    const members = range.prs.map((pr) => entry(seenByUrl, pullUrl(drop.repo, pr)));
    // Decided before this drop is added: a member's legacy plain drops reaching the old limit with
    // this one is a new escalation, routed below, not an earlier one.
    const already = members.some((member) => escalated(member));
    for (const member of members) if (!handledDrops(member).includes(drop.key)) member[list] = [...(member[list] ?? []), drop.key];
    if (judgment.revision.state !== "changed") this.supersede(drop.repo, range.prs, drop.key, seenByUrl);
    if (already) {
      for (const member of members) member.escalated = true;
      console.error(`[linear-tickets] ${record?.identifier ?? drop.repo}: the merge queue dropped ${url}, whose range already escalated to the owner`);
      return true;
    }
    const most = (field: "drops" | "conflicts" | "mainBroken") => Math.max(...members.map((member) => member[field]?.length ?? 0));
    const plain = most("drops");
    const conflicts = most("conflicts");
    const main = most("mainBroken");
    const reason = drop.reason || judgment.reason;
    const draft = judgment.queueDraft;
    const facts = [
      `The Graphite merge queue dropped [the pull request](${url}) without merging it.`,
      `Reason: ${reason}`,
      ...(draft === null ? [] : judgment.failures.length
        ? [`Checks that did not pass on the queue's draft [#${draft}](${pullUrl(drop.repo, draft)}):`, ...judgment.failures.map((check) => `- [${check.check}](${check.url}) — ${check.conclusion}`)]
        : [`No check failed on the queue's draft [#${draft}](${pullUrl(drop.repo, draft)}).`]),
      ...(draft === null ? [] : [`Kind (tools/ci/wait-queue.mjs): ${CLASS_TEXT[judgment.class]}.`, ...judgment.evidence.map((line) => `- ${line}`)]),
    ].join("\n");
    const tickets = ticketsOf(drop.repo, range.prs, open, context.records, record);
    const target = { record, url, tickets };
    const count = kind === "plain" ? plain : conflicts;
    if (kind !== "main" && count > DROP_PROMPTS[kind]) {
      for (const member of members) member.escalated = true;
      this.route(seenByUrl, target, { key: drop.key, reason, facts: `${facts}\nDrops of this pull request so far: ${plain} plain, ${conflicts} conflict-only.`, fix: null });
      return true;
    }
    const own = ownRound(drop, seenByUrl, open);
    const same = judgment.revision.state === "same" && judgment.revision.expect ? { expect: judgment.revision.expect, branch: judgment.revision.branch } : null;
    const proof = same ?? own;
    const unchanged = same ? judgment.revision.reason || "checked against the queue's draft" : "Paseo's queue backstop enqueued these very heads right before this round";
    const gated = (await this.gatedTickets(context.records, tickets)).size > 0;
    const counted = kind === "main" ? "Main-broken drops count toward no limit; the enqueue waits until `main` is green."
      : kind === "conflict" ? `This is conflict-only drop ${conflicts} of ${DROP_PROMPTS.conflict} before the owner takes over.`
      : `It counts as plain drop ${plain} of ${DROP_PROMPTS.plain}; the next plain drop goes to the owner.`;
    if (judgment.requeue && proof && !gated) {
      const heads = parseExpect(proof.expect) ?? [];
      const top = heads.at(-1)?.pr ?? range.top;
      const action: ActionRecord = {
        id: `drop:${drop.key}:${top}`, repo: drop.repo, branch: proof.branch ?? range.branch, expect: proof.expect, prs: heads.map((head) => head.pr), top, tickets,
        why: dropWhy(drop.repo, judgment, unchanged, counted), at: new Date(context.now).toISOString(), activityBoundary: null,
        steps: { enqueue: "due", prComment: "none", linearComment: "none", note: "none" },
      };
      const holder = entry(seenByUrl, pullUrl(drop.repo, top));
      holder.actions = [...(holder.actions ?? []).filter((item) => item.id !== action.id), action];
      this.kicked = true;
      return true;
    }
    // The range stays out of every automatic enqueue until one of its heads changes.
    const block = () => {
      for (const pr of range.prs) {
        const head = open.find((pull) => pull.number === pr)?.headSha;
        if (head) entry(seenByUrl, pullUrl(drop.repo, pr)).blockedAt = head;
      }
    };
    if (judgment.class !== "genuine" && judgment.revision.state === "changed") {
      console.error(`[linear-tickets] ${record?.identifier ?? drop.repo}: the merge queue dropped ${url} (${judgment.class}), and the range has changed since; the new code goes through the ready rule`);
      return true;
    }
    if (judgment.class === "genuine" ? judgment.revision.state !== "changed" : !proof) block();
    const branch = range.branch;
    const pr = range.top;
    const enqueue = `\`git switch ${branch} && node tools/ci/enqueue.mjs\` (the top branch of the dropped queue range, not the stack's top branch; never a bare \`gt merge\`: it refuses while the range conflicts with \`main\` or the queue tip and names the fix)`;
    const worktree = `In your stack's worktree${record?.worktreePath ? ` (\`${record.worktreePath}\`)` : ""}, on the top branch of the stack`;
    const rebase = "`git fetch origin main && git rebase --update-refs --onto origin/main \"$(git merge-base HEAD origin/main)\"`. It moves only your own branches; never `gt sync` or `gt restack`, which move the shared `main` and other agents' branches.";
    const notRequeued = !judgment.requeue ? "`tools/ci/wait-queue.mjs` does not clear this drop for an automatic re-enqueue. Follow the steps below."
      : !proof ? `it could not prove that the range is still the code that dropped (${judgment.revision.reason || "no comparison"}), and it leaves the range alone until one of its heads changes. Check that nothing changed, then follow the steps below.`
      : "a manual task due before the merge is open. Re-enqueue once it is done.";
    const held = judgment.class === "genuine" ? [] : [`Paseo did not re-enqueue it: ${notRequeued}`, ""];
    const fix = judgment.class === "mainBroken" ? [
      facts,
      "",
      ...held,
      "Main broken: the merge queue dropped the range because `main` was already red on the same jobs at that time (tools/ci/wait-queue.mjs). This drop does not count toward the stack's limits, and no restack or fix of your own is needed unless `enqueue.mjs` refuses the range.",
      `Re-enqueue the dropped queue range from its top branch once \`main\` is green: \`git switch ${branch} && node tools/ci/enqueue.mjs --wait-main\` (it waits until \`main\` is green, then checks and enqueues), then \`node tools/ci/wait-queue.mjs ${pr}\`.`,
      "",
      `Drops of this pull request so far: ${plain} plain, ${conflicts} conflict-only, ${main} main-broken (not counted).`,
    ] : judgment.class === "conflictOnly" ? [
      facts,
      "",
      ...held,
      "Conflict only: Graphite names a merge conflict and nothing failed, was cancelled or was still running on the queue's draft. Restack and re-enqueue right away, without asking (docs/automation/merge-queue.md#conflict-only-drops), unless a pull request of the stack carries `do-not-merge`:",
      `1. ${worktree}, and only when every branch below it is your own, run ${rebase}`,
      "2. Keep `main`'s version of generated files and regenerate them; never merge them by hand. Run the focused checks for the files the restack touched.",
      `3. Run \`gt submit --stack --ignore-out-of-sync-trunk\`, then right away ${enqueue} and \`node tools/ci/wait-queue.mjs ${pr}\`. Do not wait for the pull request's checks first: the queue's draft runs the full suite. Only when \`enqueue.mjs\` reports that \`gt merge\` refused because checks are still running, wait with \`node tools/ci/wait-checks.mjs ${pr}\` and run \`node tools/ci/enqueue.mjs\` once more.`,
      "",
      `This is automatic restack ${count} of ${DROP_PROMPTS.conflict} for this pull request; after that the owner takes over.`,
    ] : judgment.class !== "genuine" ? [
      facts,
      "",
      ...held,
      `Not the stack's fault (${CLASS_TEXT[judgment.class]}): no fix of your own is needed unless \`enqueue.mjs\` refuses the range.`,
      `Re-enqueue the dropped queue range from its top branch: ${enqueue}, then \`node tools/ci/wait-queue.mjs ${pr}\`.`,
      "",
      `This drop counts as plain drop ${count} of ${DROP_PROMPTS.plain} for this pull request; the next plain drop goes to the owner.`,
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
    this.route(seenByUrl, target, { key: drop.key, reason, facts, fix: fix.join("\n") });
    return true;
  }

  // The round as the repo's `wait-queue.mjs` (from the backstop checkout) judges it; null while it
  // does not call it dropped. A repo without a backstop has no classes: its drops are genuine.
  private async judge(repo: string, number: number, draft: number | null, context: RunContext): Promise<DropJudgment | null> {
    const checkout = await context.checkout(repo);
    if (!checkout) return { result: "dropped", reason: "", class: "genuine", requeue: false, evidence: [], revision: { state: "unknown", draft, branch: null, expect: null, reason: "the repo has no queue backstop" }, queueDraft: null, failures: [] };
    const judged = parseJudgment(await this.run(checkout, WAIT_QUEUE, waitQueueArgs(number, draft), repo));
    return judged.result === "dropped" ? judged : null;
  }

  private run(checkout: string, script: string, args: string[], repo: string) {
    return (this.deps.backstop?.run ?? runNodeScript)(checkout, script, args, { GITHUB_REPOSITORY: repo });
  }

  // A message for the ticket's agent goes to its record's pull request, delivered by the poll (see
  // deliver); without a record, to the pull request's own entry, delivered by the backstop (see
  // deliverOrphan). While that entry still holds an earlier message, it is queued behind it and
  // delivered once the earlier one went out (see nextMessage), so a claimed drop is never lost; a
  // message with the same key already waiting there is not added twice.
  private route(seenByUrl: Record<string, Seen>, target: { record: HandoverRecord | null; url: string; tickets: string[] }, pending: PendingDrop): void {
    const seen = entry(seenByUrl, target.record?.links["Pull request"] ?? target.url);
    const message = target.record ? pending : { ...pending, orphan: { tickets: target.tickets } };
    if (!seen.pending) seen.pending = message;
    else if (![seen.pending, ...(seen.queued ?? [])].some((waiting) => waiting.key === pending.key)) seen.queued = [...(seen.queued ?? []), message];
  }

  // A newer queue round of the range retires its automatic enqueues that had not gone through yet:
  // due, held or refused ones close; one whose outcome is not recorded yet (`started`) closes once
  // its Merge activity shows it did not go through (see advanceAction). That round's own outcome
  // is the drop path's.
  private supersede(repo: string, prs: number[], key: string, seenByUrl: Record<string, Seen>): void {
    for (const [url, seen] of Object.entries(seenByUrl)) {
      if (PULL_URL.exec(url)?.[1] !== repo) continue;
      for (const action of seen.actions ?? []) {
        const { enqueue } = action.steps;
        if (!action.prs.some((pr) => prs.includes(pr)) || !["due", "held", "refused", "started"].includes(enqueue)) continue;
        action.supersededBy = key;
        if (enqueue !== "started") action.steps.enqueue = "closed";
      }
    }
  }

  // The tickets, of `among`, whose before-merge manual tasks are open; a gate that cannot be read
  // counts as open. Tickets are found by their records and by the tasks themselves.
  private async gatedTickets(records: HandoverRecord[], among?: string[]): Promise<Set<string>> {
    const manual = this.deps.manualTasks;
    const gated = new Set<string>();
    if (!manual) return gated;
    const parents = new Map<string, string>();
    for (const record of records) parents.set(record.issueId, record.identifier);
    for (const task of (await manual.tasks?.()) ?? []) if (task.when === "before_merge") parents.set(task.parentId, task.parentIdentifier);
    for (const [issueId, identifier] of parents) {
      if (gated.has(identifier) || (among && !among.includes(identifier))) continue;
      try {
        if ((await manual.openBlockers(issueId)).length) gated.add(identifier);
      } catch {
        gated.add(identifier);
      }
    }
    return gated;
  }

  // The Linear issue ids of tickets: from their records, their manual tasks, or Linear itself.
  private async issueIds(tickets: string[], records: HandoverRecord[]): Promise<{ identifier: string; issueId: string }[]> {
    const tasks = (await this.deps.manualTasks?.tasks?.()) ?? [];
    const found: { identifier: string; issueId: string }[] = [];
    for (const identifier of tickets) {
      let issueId = records.find((record) => record.identifier === identifier)?.issueId ?? tasks.find((task) => task.parentIdentifier === identifier)?.parentId;
      if (!issueId && this.deps.linear.issueState) issueId = await this.deps.linear.issueState(identifier).then((state) => state.id, () => undefined);
      if (issueId) found.push({ identifier, issueId });
    }
    return found;
  }

  // The queue backstop (TUC-615): every 10 minutes, and right after a poll claimed a drop to
  // re-enqueue, for each repo with a backstop checkout (see BackstopCheckout): earlier enqueues
  // move on (see advanceAction), the repo's `enqueue-ready.mjs` names the ready stacks and the
  // drops it saw, drops no record watches are claimed like the poll's, refused enqueues and
  // messages for pull requests without a record go out, and each ready stack is enqueued as an
  // action. It shares pr-watch.json with the poll and runs in turn with it.
  private async queueBackstop(): Promise<void> {
    const seenByUrl = await this.load();
    const records = await this.deps.handover.all();
    const context = this.context(records);
    const save = () => this.save(seenByUrl);
    const repos = new Set([...records.map((record) => record.links["Pull request"] ?? ""), ...Object.keys(seenByUrl)].map((url) => PULL_URL.exec(url)?.[1] ?? "").filter(Boolean));
    for (const repo of repos) {
      try {
        await this.backstopRepo(repo, seenByUrl, context, save);
      } catch (error) {
        console.error(`[linear-tickets] queue backstop for ${repo} stopped: ${error instanceof Error ? error.message : error}`);
        if (error instanceof RateLimitedError || error instanceof GitHubRateLimitedError) break;
      }
    }
    await save();
  }

  private async backstopRepo(repo: string, seenByUrl: Record<string, Seen>, context: RunContext, save: () => Promise<void>): Promise<void> {
    const checkout = await context.checkout(repo);
    if (!checkout) return;
    const inRepo = () => Object.entries(seenByUrl).filter(([url]) => PULL_URL.exec(url)?.[1] === repo);
    for (const [, seen] of inRepo()) {
      seen.actions = seen.actions?.filter((action) => context.now - Date.parse(action.at) < BACKSTOP_MEMORY_MS || ["due", "started", "held"].includes(action.steps.enqueue));
      seen.refusals = seen.refusals?.filter((refusal) => context.now - Date.parse(refusal.at) < BACKSTOP_MEMORY_MS);
    }
    // Each action moves at most once per run: a held one is retried on the next run, not twice.
    const advanced = new Set<string>();
    const advance = async () => {
      for (const [, seen] of inRepo()) {
        for (const action of seen.actions ?? []) {
          if (advanced.has(action.id)) continue;
          advanced.add(action.id);
          await this.advanceAction(action, seenByUrl, context, checkout, save);
        }
      }
    };
    await advance();
    const open = await context.pulls(repo);
    const gated = await this.gatedTickets(context.records);
    const excluded = this.excluded(repo, seenByUrl, open, gated, context.records);
    const skips = await this.skips(repo, seenByUrl, open, context.now);
    // A refused drop re-enqueue whose refusals are all released runs again: `enqueue-ready.mjs`
    // never lists a dropped range as ready, so nothing else would retry it.
    for (const [, seen] of inRepo()) {
      for (const action of seen.actions ?? []) {
        if (!action.id.startsWith("drop:") || action.steps.enqueue !== "refused" || skips.includes(action.id)) continue;
        if (action.prs.some((pr) => excluded.has(pr)) || action.tickets.some((ticket) => gated.has(ticket))) continue;
        action.steps.enqueue = "due";
        advanced.delete(action.id);
      }
    }
    const ready = parseReady(await this.run(checkout, ENQUEUE_READY, readyArgs([...excluded].sort((a, b) => a - b), skips), repo));
    const watched = new Set(context.records.map((record) => record.links["Pull request"]));
    for (const found of ready.drops) {
      const url = pullUrl(repo, found.pr);
      if (watched.has(url) || handledDrops(seenByUrl[url]).includes(found.key)) continue;
      const drop: Drop = { key: found.key, reason: "", repo, number: found.pr, draft: found.draft === null ? null : { number: found.draft, url: pullUrl(repo, found.draft), headSha: null, pulls: [] } };
      if (await this.claimDrop(drop, recordFor(ticketsOf(repo, [found.pr], open, context.records, null), context.records), seenByUrl, context)) await save();
    }
    // The drops claimed above may have started re-enqueues of their own.
    const busy = this.excluded(repo, seenByUrl, open, gated, context.records);
    for (const stack of ready.stacks) {
      if (stack.result !== "candidate" || stack.prs.some((pr) => busy.has(pr)) || stack.tickets.some((ticket) => gated.has(ticket)) || skips.includes(stack.action)) continue;
      const holder = entry(seenByUrl, pullUrl(repo, stack.top));
      const existing = holder.actions?.find((action) => action.id === stack.action);
      // A stack already enqueued under this action is followed by the drop path from now on.
      if (existing && existing.steps.enqueue !== "refused") continue;
      if (existing) {
        existing.steps.enqueue = "due";
        advanced.delete(existing.id);
      } else holder.actions = [...(holder.actions ?? []), {
        id: stack.action, repo, branch: stack.branch, expect: stack.expect, prs: stack.prs, top: stack.top, tickets: stack.tickets, why: READY_WHY,
        at: new Date(context.now).toISOString(), activityBoundary: null, steps: { enqueue: "due", prComment: "none", linearComment: "none", note: "none" },
      }];
      await save();
    }
    // The ready stacks, and the drops claimed above, are enqueued right away.
    await advance();
    await this.routeRefusals(repo, seenByUrl, context, save);
    // Every message waiting for a pull request without a record goes out in turn.
    for (const [url, seen] of inRepo()) while (seen.pending?.orphan) await this.deliverOrphan(url, seen, context, save);
  }

  // The pull requests no automatic enqueue may touch: escalated ones, ones blocked at their head
  // (a new head releases them), ones with a message or a drop re-enqueue still pending, and the
  // pull requests of tickets whose before-merge manual tasks are open.
  private excluded(repo: string, seenByUrl: Record<string, Seen>, open: OpenPull[], gated: Set<string>, records: HandoverRecord[]): Set<number> {
    const excluded = new Set<number>();
    for (const [url, seen] of Object.entries(seenByUrl)) {
      const source = PULL_URL.exec(url);
      if (source?.[1] !== repo) continue;
      const number = Number(source[2]);
      const head = open.find((pull) => pull.number === number)?.headSha;
      if (seen.blockedAt && head && head !== seen.blockedAt) delete seen.blockedAt;
      if (escalated(seen) || seen.blockedAt || seen.pending) excluded.add(number);
      for (const action of seen.actions ?? []) if (["due", "started", "held"].includes(action.steps.enqueue)) for (const pr of action.prs) excluded.add(pr);
    }
    for (const pull of open) if ([...gated].some((identifier) => namesTicket(identifier).test(pull.title))) excluded.add(pull.number);
    for (const record of records) {
      const source = PULL_URL.exec(record.links["Pull request"] ?? "");
      if (source?.[1] === repo && gated.has(record.identifier)) excluded.add(Number(source[2]));
    }
    return excluded;
  }

  // The actions whose refusals are not released yet (see released): `enqueue-ready.mjs` skips them.
  // A queue-tip conflict's draft is read by its number (Graphite's listing names only its latest
  // drafts); one whose state cannot be read counts as open, so its refusal holds.
  private async skips(repo: string, seenByUrl: Record<string, Seen>, open: OpenPull[], now: number): Promise<string[]> {
    const skips = new Set<string>();
    const openDrafts = new Set<number>();
    const read = new Set<number>();
    for (const [url, seen] of Object.entries(seenByUrl)) {
      if (PULL_URL.exec(url)?.[1] !== repo) continue;
      for (const refusal of seen.refusals ?? []) {
        const action = seen.actions?.find((item) => item.id === refusal.action);
        // Only a refusal still holding its action back is worth a read.
        if (refusal.kind === "conflict-tip" && refusal.draft !== null && action?.steps.enqueue === "refused" && !read.has(refusal.draft)) {
          read.add(refusal.draft);
          try {
            if (await this.github().pullState(repo, refusal.draft) !== "closed") openDrafts.add(refusal.draft);
          } catch (error) {
            if (error instanceof GitHubRateLimitedError) throw error;
            console.error(`[linear-tickets] queue backstop: the state of queue draft #${refusal.draft} could not be read (${error instanceof Error ? error.message : error}); its refusal holds`);
            openDrafts.add(refusal.draft);
          }
        }
        const prs = action?.prs ?? [];
        const vetoed = open.some((pull) => prs.includes(pull.number) && pull.labels.includes(DO_NOT_MERGE_LABEL));
        if (!released(refusal, now, openDrafts, vetoed)) skips.add(refusal.action);
      }
    }
    return [...skips];
  }

  // One action's next steps, each saved before it runs (see ActionRecord):
  // - `due`/`held`: the range is checked again as it is now (see stale), which may close the action
  //   or keep it for the next run; then the top pull request's Merge activity is read as the
  //   boundary right before `backstop-enqueue.mjs` runs; enqueued, held (retried on the next run),
  //   refused (each new refusal key is routed once, see routeRefusals) or closed (`range-changed`
  //   before any enqueue); an error or an answer that cannot be read leaves it `started`;
  // - `started` (a restart, or that error): reconciled from the bullets appended after the
  //   boundary: an enqueue bullet means enqueued; none means not enqueued, retried while the pull
  //   request is open and no newer round superseded it; a boundary that no longer matches can tell
  //   neither, so it is not retried but routed to the agent;
  // - enqueued: the pull request comment (by marker, also after the pull request closed or
  //   landed), the ticket comment (by its mark, see ticketMarker) and a note to a living agent
  //   that nothing is needed from it.
  private async advanceAction(action: ActionRecord, seenByUrl: Record<string, Seen>, context: RunContext, checkout: string, save: () => Promise<void>): Promise<void> {
    const { steps } = action;
    const topUrl = pullUrl(action.repo, action.top);
    const enqueued = () => {
      steps.enqueue = "enqueued";
      steps.prComment = steps.prComment === "done" ? "done" : "due";
      steps.linearComment = action.tickets.length ? "due" : "none";
      steps.note = "due";
    };
    if (steps.enqueue === "started") {
      const view = await this.view(topUrl);
      const verdict = reconcile(action.activityBoundary, activityBullets(view.mergeActivity));
      if (verdict === "enqueued") enqueued();
      else if (verdict === "mismatch") {
        steps.enqueue = "unclear";
        for (const member of parseExpect(action.expect) ?? []) entry(seenByUrl, pullUrl(action.repo, member.pr)).blockedAt = member.sha;
        const holder = entry(seenByUrl, topUrl);
        holder.refusals = [...(holder.refusals ?? []), { key: `${action.id} unclear`, action: action.id, kind: "unclear", draft: null, at: new Date(context.now).toISOString(), routedAt: null, retryAfter: null }];
      } else steps.enqueue = view.state === "OPEN" && !action.supersededBy ? "due" : "closed";
      await save();
    }
    if (steps.enqueue === "due" || steps.enqueue === "held") {
      const view = await this.view(topUrl);
      if (view.state !== "OPEN") {
        steps.enqueue = "closed";
        await save();
        return;
      }
      const stale = await this.stale(action, view, seenByUrl, context);
      if (stale) {
        if (stale.close) {
          steps.enqueue = "closed";
          console.error(`[linear-tickets] queue backstop: ${action.id} is not enqueued: ${stale.why}`);
        }
        await save();
        return;
      }
      action.activityBoundary = activityBoundary(activityBullets(view.mergeActivity));
      steps.enqueue = "started";
      await save();
      const file = await (this.deps.backstop?.checkout ?? new BackstopCheckout()).commentFile(action.id, enqueuedComment(action));
      const outcome = parseEnqueue(await this.run(checkout, BACKSTOP_ENQUEUE, enqueueArgs(action.branch, action.expect, action.id, file), action.repo));
      if (outcome.result === "enqueued") {
        if (outcome.comment !== "none") steps.prComment = "done";
        enqueued();
      } else if (outcome.result === "held") steps.enqueue = "held";
      else if (outcome.result === "refused") this.refused(action, outcome.problems, seenByUrl, context.now);
      else console.error(`[linear-tickets] queue backstop: ${action.id} did not answer clearly (${outcome.error}); its Merge activity decides on the next run`);
      await save();
    }
    if (steps.enqueue !== "enqueued") return;
    if (steps.prComment === "due") {
      await commentOnce(this.github(), action.repo, action.top, action.id, enqueuedComment(action));
      steps.prComment = "done";
      await save();
    }
    if (steps.linearComment === "due" || steps.linearComment === "started") {
      const mark = ticketMarker(action.id);
      steps.linearComment = "started";
      for (const { identifier, issueId } of await this.issueIds(action.tickets, context.records)) {
        if ((action.linearDone ?? []).includes(identifier)) continue;
        // Looked up before it goes out, and recorded only once Linear confirmed it: a comment whose
        // answer was lost (a restart, a request that failed after it reached Linear) is found by
        // its mark and not posted again; one that never went out is posted on the next run.
        if (!await this.deps.linear.hasComment(issueId, mark)) await this.deps.linear.comment(issueId, `${enqueuedComment(action)}\n\n${mark}`);
        action.linearDone = [...(action.linearDone ?? []), identifier];
        await save();
      }
      steps.linearComment = "done";
      await save();
    }
    if (steps.note === "due" || steps.note === "started") {
      const living = recordFor(action.tickets, context.records);
      if (steps.note === "due" && living && living.status !== "archived") {
        const outcome = await this.deps.sessions.prompt(living.agentId, `${enqueuedComment(action)}\n\nDo not enqueue it again yourself.`, async () => {
          steps.note = "started";
          await save();
        });
        if (outcome === "busy" || outcome === "unavailable") return;
      }
      steps.note = "done";
      await save();
    }
  }

  // Right before an action enqueues, its range is checked again as it is now: the ready run and the
  // drop claim decided on an older view, and a held action waits through other rounds. A round on
  // any pull request of its range that ended and nobody claimed yet is claimed first, like the
  // poll's (it may supersede this action or block the range): someone may have enqueued only part
  // of the range. Then the action closes when a newer round superseded it, a pull request of its
  // range closed or has a new head (the next ready run decides again), the range escalated, or one
  // of its pull requests is blocked at its head. It waits for the next run while such a round is
  // not judged dropped yet, a message about one of its pull requests is still pending, or a
  // before-merge manual task of its tickets is open (or cannot be read). Null: it may enqueue.
  private async stale(action: ActionRecord, view: PullRequestView, seenByUrl: Record<string, Seen>, context: RunContext): Promise<{ close: boolean; why: string } | null> {
    const { repo } = action;
    const open = await context.pulls(repo);
    for (const pr of action.prs) {
      const url = pullUrl(repo, pr);
      // A member that is no longer open closes the action below; its rounds are not read.
      if (pr !== action.top && !open.some((pull) => pull.number === pr)) continue;
      const drop = await this.queueDrop(url, pr === action.top ? view : await this.view(url), handledDrops(seenByUrl[url]), context.drafts);
      if (!drop) continue;
      const record = context.records.find((item) => item.links["Pull request"] === url) ?? recordFor(ticketsOf(repo, [pr], open, context.records, null), context.records);
      if (!await this.claimDrop(drop, record, seenByUrl, context)) return { close: false, why: `queue round ${drop.key} of #${pr} ended, and tools/ci/wait-queue.mjs does not call it dropped yet` };
    }
    if (action.supersededBy) return { close: true, why: `queue round ${action.supersededBy} came after it` };
    for (const { pr, sha } of parseExpect(action.expect) ?? []) {
      const pull = open.find((item) => item.number === pr);
      if (!pull || pull.headSha !== sha) return { close: true, why: `#${pr} ${pull ? "has a new head" : "is no longer open"}` };
      const seen = seenByUrl[pullUrl(repo, pr)];
      if (escalated(seen)) return { close: true, why: `#${pr} escalated to the owner` };
      if (seen?.blockedAt === sha) return { close: true, why: `#${pr} is blocked at its head` };
    }
    if (action.prs.some((pr) => seenByUrl[pullUrl(repo, pr)]?.pending)) return { close: false, why: "a message about its range is still pending" };
    const tickets = [...new Set([...action.tickets, ...ticketsOf(repo, action.prs, open, context.records, null)])];
    if ((await this.gatedTickets(context.records, tickets)).size) return { close: false, why: "a manual task due before the merge is open, or cannot be read" };
    return null;
  }

  // A refused enqueue: closed when only its range changed before the enqueue (the next ready run
  // decides again), otherwise one refusal per key. A key seen before is not routed again; a
  // repairable one is retried an hour after its last refusal.
  private refused(action: ActionRecord, problems: Problem[], seenByUrl: Record<string, Seen>, now: number): void {
    const refused = problems.filter((problem) => !HELD_KINDS.includes(problem.kind));
    if (!refused.length || refused.every((problem) => problem.kind === "range-changed")) {
      action.steps.enqueue = refused.length ? "closed" : "held";
      return;
    }
    action.steps.enqueue = "refused";
    const holder = entry(seenByUrl, pullUrl(action.repo, action.top));
    const refusals = holder.refusals ?? [];
    for (const problem of refused) {
      const key = refusalKey(action.id, problem);
      const retryAfter = REPAIRABLE_KINDS.includes(problem.kind) ? new Date(now + REPAIR_RETRY_MS).toISOString() : null;
      const known = refusals.find((refusal) => refusal.key === key);
      if (known) known.retryAfter = retryAfter;
      else refusals.push({ key, action: action.id, kind: problem.kind, draft: problem.draft, at: new Date(now).toISOString(), routedAt: null, retryAfter, text: problem.text });
    }
    holder.refusals = refusals;
  }

  // Each refusal goes once to the agent of its tickets (the ticket when the agent is gone, the
  // pull request when there is no ticket), behind any message that slot still holds (see route).
  private async routeRefusals(repo: string, seenByUrl: Record<string, Seen>, context: RunContext, save: () => Promise<void>): Promise<void> {
    for (const [url, seen] of Object.entries(seenByUrl)) {
      if (PULL_URL.exec(url)?.[1] !== repo) continue;
      for (const action of seen.actions ?? []) {
        const unrouted = (seen.refusals ?? []).filter((refusal) => refusal.action === action.id && !refusal.routedAt);
        if (!unrouted.length) continue;
        const kinds = unrouted.map((refusal) => refusal.kind).join(", ");
        const fix = unrouted.every((refusal) => refusal.kind === "unclear")
          ? `Paseo's queue backstop ran the enqueue of the range up to [#${action.top}](${url}) from \`${action.branch}\`, but stopped before it learned the outcome, and the pull request's Merge activity changed since, so it cannot tell whether the range was enqueued. Paseo does not retry it. Check with \`node tools/ci/wait-queue.mjs ${action.top} --last\`; when the range is not in the queue, enqueue it: \`git switch ${action.branch} && node tools/ci/enqueue.mjs\`, then \`node tools/ci/wait-queue.mjs ${action.top}\`.`
          : refusalText(action, unrouted.map((refusal) => ({ kind: refusal.kind, text: refusal.text ?? "", draft: refusal.draft })), unrouted.some((refusal) => refusal.kind.startsWith("conflict-"))
            ? "Restack only your own stack: on its top branch `git fetch origin main && git rebase --update-refs --onto origin/main \"$(git merge-base HEAD origin/main)\"` (never `gt sync` or `gt restack`), keep `main`'s version of generated files and regenerate them, then `gt submit --stack --ignore-out-of-sync-trunk`."
            : null);
        this.route(seenByUrl, { record: recordFor(action.tickets, context.records), url, tickets: action.tickets }, {
          key: `refused:${unrouted.map((refusal) => refusal.key).join(",")}`, reason: `the enqueue was refused (${kinds})`, facts: fix, fix,
          subject: `Paseo's automatic enqueue of the pull request was refused (${kinds})`,
        });
        for (const refusal of unrouted) refusal.routedAt = new Date(context.now).toISOString();
        await save();
      }
    }
  }

  // A message for a pull request without a handover record: a comment mentioning the owner on
  // each of its tickets, or without a ticket one comment on the pull request itself (with a
  // marker, so a retry never doubles it). A ticket comment is saved as `sending` right before it
  // goes out, so one whose result was lost (a restart) is not posted again.
  private async deliverOrphan(url: string, seen: Seen, context: RunContext, save: () => Promise<void>): Promise<void> {
    const pending = seen.pending;
    const source = PULL_URL.exec(url);
    if (!pending?.orphan || !source) return;
    const text = pending.fix ?? `The merge queue dropped this stack again after Paseo's automatic requests (one fix request after a plain drop, ${DROP_PROMPTS.conflict} restacks after conflict-only drops), so Paseo stops asking. Please take over.\n\n${pending.facts}`;
    const issues = await this.issueIds(pending.orphan.tickets, context.records);
    if (!issues.length) await commentOnce(this.github(), source[1], Number(source[2]), `route:${pending.key}`, text);
    else if (pending.sending) console.error(`[linear-tickets] queue backstop: the message about ${url} may already have gone out; it is not sent again`);
    else {
      pending.sending = true;
      await save();
      try {
        for (const { issueId } of issues) await this.mention(issueId, text);
      } catch (error) {
        pending.sending = false;
        throw error;
      }
    }
    Object.assign(seen, nextMessage(seen));
    await save();
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
          await this.tell(record, "thought", `${pending.subject ?? `The merge queue dropped the pull request (${pending.reason})`}. The agent was asked to fix it.`);
        }
        if (outcome !== "gone") return;
      }
      await this.handBack(record, fix, toAgent);
      await delivered();
      await this.tell(record, "response", `${pending.subject ?? "The merge queue dropped the pull request"} and the agent is no longer running; the ticket is back in ${CODING_STATE}.\n\n${pending.facts}`);
    } finally {
      // A send that failed outright is retried on the next poll (saved with the rest of the state).
      pending.sending = false;
    }
  }

  // The next lifecycle step of a stalled ticket (see pr-nudge.ts), for its idle agent. Nothing
  // while manual tasks due before the merge are open or the agent already got a message this poll.
  // The recorded pull request gets the steps before the merge (draft, failed checks, requested
  // changes, findings) unless it may not be nudged (see nudgeable); a ready stack is the queue
  // backstop's (see queueBackstop). A step is claimed per head right before its message goes out:
  // at most STAGE_NUDGES per stage and pull request, then one escalation to the owner, then only
  // the log. A busy agent or a disconnected Paseo claims nothing; the next poll decides again.
  private async nudge(record: HandoverRecord, url: string, view: PullRequestView, seenByUrl: Record<string, Seen>, save: () => Promise<void>, drafts: (repo: string) => Promise<QueueDraft[]>, reserved: Set<string>): Promise<void> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (!source || reserved.has(record.agentId)) return;
    const [, repo, number] = source;
    if ((await this.deps.manualTasks?.openBlockers(record.issueId))?.length) return;
    const claimedOn = (stage: Stage) => seenByUrl[url]?.nudges?.[stage] ?? [];
    if (!await this.nudgeable(repo, Number(number), view, drafts)) return;
    const found = await stalledStage(view, url, Date.now(), (stage, key) => claimedOn(stage).some((entry) => entry.split(" ").includes(key)), () => this.github().reviewThreads(repo, Number(number)));
    if (!found || claimedOn(found.stage).includes(found.key)) return;
    const { stage, text, key } = found;
    const before = seenByUrl[url]?.nudges ?? {};
    const heads = before[stage] ?? [];
    const sent = heads.length;
    let claimed = false;
    const claim = async () => {
      seenByUrl[url] = { ...entry(seenByUrl, url), nudges: { ...before, [stage]: [...heads, key] }, activeAt: new Date().toISOString() };
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

  // A pull request may be nudged unless the owner vetoes merging it (`do-not-merge`) or the merge
  // queue has (or just landed) it: its last Merge activity bullet queues it, runs its CI or merged
  // it, or an open queue draft lists it.
  private async nudgeable(repo: string, number: number, view: PullRequestView, drafts: (repo: string) => Promise<QueueDraft[]>): Promise<boolean> {
    const last = activityBullets(view.mergeActivity).at(-1);
    if (view.labels.includes(DO_NOT_MERGE_LABEL) || (last && last.kind !== "dropped")) return false;
    const listed = `](https://app.graphite.com/github/pr/${repo}/${number})`;
    return !(await drafts(repo)).some((draft) => draft.state === "OPEN" && draft.title.startsWith(QUEUE_DRAFT_TITLE) && draft.body.includes(listed));
  }

  // The recorded pull request landed, but part of the ticket may not have: the rest of its stack
  // stays open (the queue landed only the range below it), or the agent replayed it onto main as
  // new pull requests. While the ticket has an open pull request, the record's link moves to the
  // lowest one (the one no other open pull request of the ticket sits below; ties go to the lower
  // number), as for a replacement, and the watch and its nudges follow
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
