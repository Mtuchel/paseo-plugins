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

export type PullRequestView = {
  state: string;
  labels: string[];
  // The body of Graphite's "Merge activity" comment, one bullet per merge queue event.
  mergeActivity: string | null;
  reviews: { author: string; state: string; submittedAt: string }[];
  lastCommitAt: string | null;
};
// `held`: approved, but kept out of Ready to merge while manual tasks due before merge are open.
// `closed`: closed without merging. `drops`: merge queue drops already handled, by draft (`#123`)
// or, for drops before any draft, by the Merge activity bullet.
type Seen = { reviewedAt: string | null; decision: string | null; merged: boolean; held?: boolean; closed?: boolean; drops?: string[] };
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
type Bullet = { text: string; kind: "queued" | "running" | "merged" | "dropped"; draft: number | null };

function gh(): string {
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) if (existsSync(candidate)) return candidate;
  return "gh";
}

async function ghJson<T>(args: string[]): Promise<T> {
  const { stdout } = await exec(gh(), args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
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

  // Background priority: requests stop at their pool's reserve. A pause ends the poll (logged once
  // per pool); unsaved records are retried on the next poll.
  poll(): Promise<void> {
    return withPriority("background", () => this.watch());
  }

  private async watch(): Promise<void> {
    const seenByUrl = await this.load();
    const manual = this.deps.manualTasks;
    const records: HandoverRecord[] = [];
    // Archived agents stay watched while the pull request is open, so a merge queue drop still
    // reaches the ticket, and while after-merge tasks wait for the merge.
    for (const record of await this.deps.handover.all()) {
      const url = record.links["Pull request"];
      if (url && (record.status !== "archived" || (!seenByUrl[url]?.merged && !seenByUrl[url]?.closed) || await manual?.awaitingMerge(record.issueId))) records.push(record);
    }
    // Graphite's drafts are listed once per repo and poll.
    const drafts = new Map<string, Promise<QueueDraft[]>>();
    const listDrafts = (repo: string) => {
      if (!drafts.has(repo)) drafts.set(repo, (this.deps.mergeQueue ?? githubMergeQueue).drafts(repo));
      return drafts.get(repo)!;
    };
    let paused: RateLimitedError | null = null;
    for (const record of records) {
      const url = record.links["Pull request"];
      try {
        const view = await (this.deps.view ?? viewPullRequest)(url);
        const result = reviewChange(view, seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false });
        const { change, seen } = manual ? await this.gate(record, result, manual) : result;
        if (change) await this.apply(record, change);
        if (change?.review === "merged" && manual) await manual.merged(record.issueId);
        // Each step's state is saved after it, so a failed step is retried on the next poll.
        seenByUrl[url] = { ...seen, closed: view.state === "CLOSED" && !seen.merged };
        if (view.state !== "OPEN") continue;
        const handled = seenByUrl[url].drops ?? [];
        const drop = await this.queueDrop(url, view, handled, listDrafts);
        if (!drop) continue;
        await this.route(record, url, drop, handled.length);
        seenByUrl[url] = { ...seenByUrl[url], drops: [...handled, drop.key] };
      } catch (error) {
        if (error instanceof RateLimitedError) {
          paused = error;
          break;
        }
        console.error(`[linear-tickets] ${record.identifier}: reading ${url} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (paused && paused.pool !== this.pausedPool) console.error(`[linear-tickets] pull request watch paused: ${paused.message}`);
    this.pausedPool = paused?.pool ?? null;
    await this.save(seenByUrl);
  }

  // A merge queue attempt that ended without landing and is not handled yet. Either Graphite's
  // last Merge activity bullet ended it (a conflict can drop a pull request before any draft
  // exists), or, while that bullet still says CI is running, the newest queue draft listing this
  // pull request was closed without its head reaching the base branch. Keyed by the draft's
  // number (by the bullet when there is none), so both signs of one drop count once.
  private async queueDrop(url: string, view: PullRequestView, handled: string[], drafts: (repo: string) => Promise<QueueDraft[]>): Promise<Drop | null> {
    const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (!source) return null;
    const [, repo, number] = source;
    const bullets = activityBullets(view.mergeActivity);
    const last = bullets.at(-1);
    if (last && last.kind !== "running" && last.kind !== "dropped") return null;
    let draftNumber = last?.kind === "running" ? last.draft : null;
    if (last?.kind === "dropped") {
      // The attempt's draft is the one its "CI is running" bullet names, after the previous outcome.
      for (const bullet of bullets.slice(0, -1).reverse()) {
        if (bullet.kind === "merged" || bullet.kind === "dropped") break;
        if (bullet.kind === "running") { draftNumber = bullet.draft; break; }
      }
      if (handled.includes(draftNumber === null ? last.text : `#${draftNumber}`)) return null;
      if (draftNumber === null) return { key: last.text, reason: last.text, repo, draft: null };
    } else if (draftNumber !== null && handled.includes(`#${draftNumber}`)) return null;
    const listing = (await drafts(repo))
      .filter((draft) => draft.title.startsWith(QUEUE_DRAFT_TITLE) && draft.body.includes(`](https://app.graphite.com/github/pr/${repo}/${number})`))
      .sort((a, b) => b.number - a.number);
    const draft = last?.kind === "dropped" ? listing.find((item) => item.number === draftNumber) : listing[0];
    if (last?.kind !== "dropped") {
      if (!draft || draft.state !== "CLOSED" || (last && last.draft !== draft.number) || handled.includes(`#${draft.number}`)) return null;
      if (await (this.deps.mergeQueue ?? githubMergeQueue).landed(repo, draft)) return null;
    }
    const drafted = draft?.number ?? draftNumber!;
    return {
      key: `#${drafted}`,
      reason: last?.kind === "dropped" ? last.text : `The merge queue closed its draft pull request #${drafted} without landing it.`,
      repo,
      draft: { number: drafted, url: `https://github.com/${repo}/pull/${drafted}`, headSha: draft?.headSha || null },
    };
  }

  // Up to DROP_PROMPTS fix requests per pull request: to its agent while that exists, otherwise on
  // the ticket, which goes back to coding for the next agent. The drop after them (the third)
  // goes to the owner, and later ones only to the log.
  private async route(record: HandoverRecord, url: string, drop: Drop, handled: number): Promise<void> {
    if (handled > DROP_PROMPTS) {
      console.error(`[linear-tickets] ${record.identifier}: the merge queue dropped ${url} again; already escalated to the owner`);
      return;
    }
    const checks = drop.draft?.headSha ? await (this.deps.mergeQueue ?? githubMergeQueue).failedChecks(drop.repo, drop.draft.headSha) : [];
    const facts = [
      `The Graphite merge queue dropped [the pull request](${url}) without merging it.`,
      `Reason: ${drop.reason}`,
      ...(!drop.draft?.headSha ? [] : checks.length
        ? [`Checks that did not pass on the queue's draft [#${drop.draft.number}](${drop.draft.url}):`, ...checks.map((check) => `- [${check.name}](${check.url}) — ${check.conclusion}`)]
        : [`No check failed on the queue's draft [#${drop.draft.number}](${drop.draft.url}).`]),
    ].join("\n");
    if (handled === DROP_PROMPTS) {
      await this.mention(record.issueId, `The merge queue dropped this stack three times, so Paseo stops asking the agent to fix it. Please take over.\n\n${facts}`);
      await this.tell(record, "response", `The merge queue dropped the pull request three times; the owner was asked to take over.\n\n${facts}`);
      return;
    }
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
    if (record.status !== "archived" && await this.deps.sessions.prompt(record.agentId, fix)) {
      await this.tell(record, "thought", `The merge queue dropped the pull request (${drop.reason}). The agent was asked to fix it.`);
      return;
    }
    if ((await this.deps.settings.read()).writeback.status) await this.deps.linear.moveToStateNamed(record.issueId, CODING_STATE);
    await this.mention(record.issueId, `The agent that worked on this ticket is no longer running, so the ticket is back in ${CODING_STATE} for the next one.\n\n${fix}`);
    await this.tell(record, "response", `The merge queue dropped the pull request and the agent is no longer running; the ticket is back in ${CODING_STATE}.\n\n${facts}`);
  }

  private async mention(issueId: string, body: string): Promise<void> {
    const { linear } = this.deps;
    await appComment(linear, this.deps.comments, issueId, `${await linear.userUrl(await linear.viewerId())} ${body}`);
  }

  // Best effort: the ticket's agent session, when it has one, shows the line too.
  private async tell(record: HandoverRecord, type: "thought" | "response", text: string): Promise<void> {
    const link = await this.deps.sessions.sessionFor(record.agentId);
    if (link) await this.deps.sessions.say(link.sessionId, type, text).catch(() => {});
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
