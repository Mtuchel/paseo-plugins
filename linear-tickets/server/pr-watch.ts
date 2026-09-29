import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentApi } from "./agent-app";
import type { Handover, HandoverRecord } from "./handover";
import type { LinearService } from "./linear";
import type { ManualTasks } from "./manual-tasks";
import { CODING_STATE } from "./plannotator";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { SessionRouter } from "./sessions";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";
import { appComment } from "./writeback";

const exec = promisify(execFile);
const INTERVAL_MS = 2 * 60 * 1000;
const REVIEW_STATE = "In Review";
// Approved and waiting for the merge click; teams without this state stay in In Review.
const READY_STATE = "Ready to merge";
// The repo's workflow labels pull requests Graphite's merge queue landed: the queue fast-forwards
// the base branch and closes them instead of merging them.
const QUEUE_MERGED_LABEL = "externally-merged";
const QUEUE_DRAFT_TITLE = "[Graphite MQ] Draft PR";
// Automatic fix prompts per pull request; the next drop goes to the owner instead.
const DROP_PROMPTS = 2;
// An archived agent's open pull request stops being watched after this long without activity.
const ARCHIVED_WATCH_MS = 14 * 24 * 60 * 60 * 1000;

export type PullRequestView = {
  state: string;
  labels: string[];
  // The body of Graphite's "Merge activity" comment, one bullet per merge queue event.
  mergeActivity: string | null;
  reviews: { author: string; state: string; submittedAt: string }[];
  lastCommitAt: string | null;
};
// `held`: approved, but kept out of Ready to merge while manual tasks due before merge are open.
// `closed`: closed without merging. `drops`: merge queue drops already claimed, by draft (`#123`)
// or, for drops before any draft, by the Merge activity bullet. `pending`: the claimed drop still
// to be delivered. `activeAt`: the last change or drop seen.
type Seen = { reviewedAt: string | null; decision: string | null; merged: boolean; held?: boolean; closed?: boolean; drops?: string[]; pending?: PendingDrop | null; activeAt?: string };
// A claimed drop, saved before anything is sent. `fix` goes to the agent (or, when it is gone, to
// the ticket); without it, `facts` escalate to the owner. `sending`: a message went out and its
// result was not recorded (a restart or a failed save), so it is not sent again.
type PendingDrop = { key: string; reason: string; facts: string; fix: string | null; sending?: boolean };
type Change = { thought: string; review: string; state?: string };

// A draft pull request the merge queue tests a stack on; `base` is the branch it lands on.
export type QueueDraft = { number: number; title: string; body: string; state: string; headSha: string; base: string };
export type FailedCheck = { name: string; url: string; conclusion: string };
export type MergeQueueReader = {
  // Graphite's recent draft pull requests in the repo (`owner/name`).
  drafts(repo: string): Promise<QueueDraft[]>;
  // Whether the draft's head reached its base branch.
  landed(repo: string, draft: QueueDraft): Promise<boolean>;
  failedChecks(repo: string, sha: string): Promise<FailedCheck[]>;
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

export async function viewPullRequest(url: string): Promise<PullRequestView> {
  const data = await ghJson<{
    state?: string;
    labels?: { name?: string }[];
    comments?: { author?: { login?: string }; body?: string }[];
    reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
    commits?: { committedDate?: string }[];
  }>(["pr", "view", url, "--json", "state,labels,comments,reviews,commits"]);
  const activity = (data.comments ?? []).filter((comment) => /^graphite-app(\[bot\])?$/.test(comment.author?.login ?? "") && comment.body?.startsWith("### Merge activity")).at(-1);
  return {
    state: data.state ?? "",
    labels: (data.labels ?? []).map((item) => item.name ?? "").filter(Boolean),
    mergeActivity: activity?.body ?? null,
    reviews: (data.reviews ?? []).map((review) => ({ author: review.author?.login ?? "someone", state: review.state ?? "", submittedAt: review.submittedAt ?? "" })).filter((review) => review.submittedAt),
    lastCommitAt: data.commits?.at(-1)?.committedDate ?? null,
  };
}

export const githubMergeQueue: MergeQueueReader = {
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
  async failedChecks(repo, sha) {
    const { check_runs: runs = [] } = await ghJson<{ check_runs?: { name?: string; html_url?: string; status?: string; conclusion?: string | null }[] }>(
      ["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", "{check_runs: [.check_runs[] | {name, html_url, status, conclusion}]}"]);
    return runs.filter((run) => !["success", "skipped", "neutral"].includes(run.conclusion ?? ""))
      .map((run) => ({ name: run.name ?? "check", url: run.html_url ?? "", conclusion: run.conclusion ?? run.status ?? "unknown" }));
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

// Mirrors each ticket's pull request review into Linear every 2 minutes, and sends pull requests the
// Graphite merge queue dropped back to be fixed.
export class PullRequestWatch {
  private timer: NodeJS.Timeout | null = null;
  private pausedPool: RateLimitedError["pool"] | null = null;

  constructor(
    private readonly deps: {
      handover: Pick<Handover, "all" | "update">;
      sessions: Pick<SessionRouter, "sessionFor" | "say" | "prompt">;
      linear: Pick<LinearService, "moveToStateNamed" | "createComment" | "updateComment" | "viewerId" | "userUrl">;
      comments?: Pick<AgentApi, "createComment" | "updateComment">;
      manualTasks?: Pick<ManualTasks, "openBlockers" | "merged" | "awaitingMerge">;
      settings: Pick<Settings, "read">;
      view?: (url: string) => Promise<PullRequestView>;
      mergeQueue?: MergeQueueReader;
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
      // An archived agent's open pull request stays watched, so a merge queue drop still reaches
      // the ticket: until a drop escalated to the owner, or 14 days without activity. After-merge
      // tasks keep it watched until the merge.
      const quiet = Date.now() - Math.max(Date.parse(record.updatedAt) || 0, Date.parse(seen?.activeAt ?? "") || 0) > ARCHIVED_WATCH_MS;
      const watched = !seen?.merged && !seen?.closed && (seen?.drops?.length ?? 0) <= DROP_PROMPTS && !quiet;
      if (record.status !== "archived" || seen?.pending || watched || await manual?.awaitingMerge(record.issueId)) records.push(record);
    }
    // Graphite's drafts are listed once per repo and poll.
    const drafts = new Map<string, Promise<QueueDraft[]>>();
    const listDrafts = (repo: string) => {
      if (!drafts.has(repo)) drafts.set(repo, (this.deps.mergeQueue ?? githubMergeQueue).drafts(repo));
      return drafts.get(repo)!;
    };
    const save = () => this.save(seenByUrl);
    let paused: RateLimitedError | null = null;
    let throttled: GitHubRateLimitedError | null = null;
    for (const record of records) {
      const url = record.links["Pull request"];
      try {
        const view = await (this.deps.view ?? viewPullRequest)(url);
        const result = reviewChange(view, seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false });
        const { change, seen } = manual ? await this.gate(record, result, manual) : result;
        if (change) await this.apply(record, change);
        if (change?.review === "merged" && manual) await manual.merged(record.issueId);
        // Each step's state is recorded after it, so a failed step is retried on the next poll.
        const now = new Date().toISOString();
        seenByUrl[url] = { ...seen, closed: view.state === "CLOSED" && !seen.merged, ...(change ? { activeAt: now } : {}) };
        if (view.state !== "OPEN") {
          if (seenByUrl[url].pending) console.error(`[linear-tickets] ${record.identifier}: ${url} is no longer open; the merge queue drop is not reported`);
          seenByUrl[url] = { ...seenByUrl[url], pending: null };
          continue;
        }
        if (!seenByUrl[url].pending) {
          const handled = seenByUrl[url].drops ?? [];
          const drop = await this.queueDrop(url, view, handled, listDrafts);
          if (drop) {
            // Claimed and saved before anything is sent: a later failure, a restart or another
            // poll never sends it twice.
            seenByUrl[url] = { ...seenByUrl[url], drops: [...handled, drop.key], pending: await this.claim(record, url, drop, handled.length), activeAt: now };
            await save();
          }
        }
        const pending = seenByUrl[url].pending;
        // Recorded as delivered as soon as the message went out, before any session line.
        if (pending) await this.deliver(record, url, pending, save, async () => {
          seenByUrl[url] = { ...seenByUrl[url], pending: null };
          await save();
        });
      } catch (error) {
        if (error instanceof RateLimitedError) {
          paused = error;
          break;
        }
        if (error instanceof GitHubRateLimitedError) {
          throttled = error;
          break;
        }
        console.error(`[linear-tickets] ${record.identifier}: reading ${url} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
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
    const listing = (await drafts(repo)).filter((draft) => draft.title.startsWith(QUEUE_DRAFT_TITLE) && draft.body.includes(`](https://app.graphite.com/github/pr/${repo}/${number})`));
    const draft = listing.find((item) => item.number === draftNumber);
    if (!draft || draft.state !== "CLOSED" || listing.some((item) => item.number > draftNumber && item.state === "OPEN")) return null;
    if (await (this.deps.mergeQueue ?? githubMergeQueue).landed(repo, draft)) return null;
    return { key, reason: `The merge queue closed its draft pull request #${draftNumber} without landing it.`, repo, draft: { number: draftNumber, url: draftUrl, headSha: draft.headSha || null } };
  }

  // What a drop sends: up to DROP_PROMPTS fix requests per pull request, then (the third drop) an
  // escalation to the owner; later drops only reach the log.
  private async claim(record: HandoverRecord, url: string, drop: Drop, handled: number): Promise<PendingDrop | null> {
    if (handled > DROP_PROMPTS) {
      console.error(`[linear-tickets] ${record.identifier}: the merge queue dropped ${url} again; already escalated to the owner`);
      return null;
    }
    const checks = drop.draft?.headSha ? await (this.deps.mergeQueue ?? githubMergeQueue).failedChecks(drop.repo, drop.draft.headSha) : [];
    const facts = [
      `The Graphite merge queue dropped [the pull request](${url}) without merging it.`,
      `Reason: ${drop.reason}`,
      ...(!drop.draft?.headSha ? [] : checks.length
        ? [`Checks that did not pass on the queue's draft [#${drop.draft.number}](${drop.draft.url}):`, ...checks.map((check) => `- [${check.name}](${check.url}) — ${check.conclusion}`)]
        : [`No check failed on the queue's draft [#${drop.draft.number}](${drop.draft.url}).`]),
    ].join("\n");
    if (handled === DROP_PROMPTS) return { key: drop.key, reason: drop.reason, facts, fix: null };
    const fix = [
      facts,
      "",
      "To land it:",
      `1. In your stack's worktree${record.worktreePath ? ` (\`${record.worktreePath}\`)` : ""}, run \`gt sync && gt restack\`.`,
      "2. Fix the cause.",
      "3. Run `gt submit --stack`, then `gt merge`.",
      "",
      "An obviously flaky failure (unrelated to the change) gets one plain `gt merge` retry instead.",
      `This is automatic fix request ${handled + 1} of ${DROP_PROMPTS} for this pull request; after that the owner takes over.`,
    ].join("\n");
    return { key: drop.key, reason: drop.reason, facts, fix };
  }

  // Delivers a claimed drop: the fix request to the agent while it exists, otherwise to the ticket,
  // which goes back to coding for the next agent; an escalation to the owner. It waits for a later
  // poll while the agent is in a turn or Paseo is not connected. `sending` is saved right before a
  // message goes out, so one whose result was lost (a restart) is never sent again; `delivered`
  // records it right after, before the best-effort session line.
  private async deliver(record: HandoverRecord, url: string, pending: PendingDrop, save: () => Promise<void>, delivered: () => Promise<void>): Promise<void> {
    if (pending.sending) {
      console.error(`[linear-tickets] ${record.identifier}: the message about the merge queue drop of ${url} may already have gone out; it is not sent again`);
      await delivered();
      return;
    }
    const dispatch = async () => {
      pending.sending = true;
      await save();
    };
    const { fix } = pending;
    try {
      if (fix === null) {
        await dispatch();
        await this.mention(record.issueId, `The merge queue dropped this stack three times, so Paseo stops asking the agent to fix it. Please take over.\n\n${pending.facts}`);
        await delivered();
        await this.tell(record, "response", `The merge queue dropped the pull request three times; the owner was asked to take over.\n\n${pending.facts}`);
        return;
      }
      if (record.status !== "archived") {
        const outcome = await this.deps.sessions.prompt(record.agentId, fix, dispatch);
        if (outcome === "sent") {
          await delivered();
          await this.tell(record, "thought", `The merge queue dropped the pull request (${pending.reason}). The agent was asked to fix it.`);
        }
        if (outcome !== "gone") return;
      }
      if ((await this.deps.settings.read()).writeback.status) await this.deps.linear.moveToStateNamed(record.issueId, CODING_STATE);
      await dispatch();
      await this.mention(record.issueId, `The agent that worked on this ticket is no longer running, so the ticket is back in ${CODING_STATE} for the next one.\n\n${fix}`);
      await delivered();
      await this.tell(record, "response", `The merge queue dropped the pull request and the agent is no longer running; the ticket is back in ${CODING_STATE}.\n\n${pending.facts}`);
    } finally {
      // A send that failed outright is retried on the next poll (saved with the rest of the state).
      pending.sending = false;
    }
  }

  private async mention(issueId: string, body: string): Promise<void> {
    const { linear } = this.deps;
    await appComment(linear, this.deps.comments, issueId, `${await linear.userUrl(await linear.viewerId())} ${body}`);
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
