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
import { RateLimitedError, withPriority } from "./rate-budget";
import type { SessionRouter } from "./sessions";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

const exec = promisify(execFile);
const INTERVAL_MS = 2 * 60 * 1000;
const REVIEW_STATE = "In Review";
// Approved and waiting for the merge click; teams without this state stay in In Review.
const READY_STATE = "Ready to merge";

export type PullRequestView = {
  state: string;
  reviews: { author: string; state: string; submittedAt: string }[];
  lastCommitAt: string | null;
};
// `held`: approved, but kept out of Ready to merge while manual tasks due before merge are open.
type Seen = { reviewedAt: string | null; decision: string | null; merged: boolean; held?: boolean };
type Change = { thought: string; review: string; state?: string };

function gh(): string {
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) if (existsSync(candidate)) return candidate;
  return "gh";
}

export async function viewPullRequest(url: string): Promise<PullRequestView> {
  const { stdout } = await exec(gh(), ["pr", "view", url, "--json", "state,reviews,commits"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout) as { state?: string; reviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[]; commits?: { committedDate?: string }[] };
  return {
    state: data.state ?? "",
    reviews: (data.reviews ?? []).map((review) => ({ author: review.author?.login ?? "someone", state: review.state ?? "", submittedAt: review.submittedAt ?? "" })).filter((review) => review.submittedAt),
    lastCommitAt: data.commits?.at(-1)?.committedDate ?? null,
  };
}

// What changed since the last look, as one panel thought, a progress line and an optional state.
// The review loop itself runs in Paseo; this only makes it visible on the ticket.
export function reviewChange(view: PullRequestView, seen: Seen): { change: Change | null; seen: Seen } {
  if (view.state === "MERGED") {
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

// Mirrors each ticket's pull request review into Linear every 2 minutes.
export class PullRequestWatch {
  private timer: NodeJS.Timeout | null = null;
  private pausedPool: RateLimitedError["pool"] | null = null;

  constructor(
    private readonly deps: {
      handover: Pick<Handover, "all" | "update">;
      sessions: Pick<SessionRouter, "sessionFor" | "say">;
      linear: Pick<LinearService, "moveToStateNamed">;
      manualTasks?: Pick<ManualTasks, "openBlockers" | "merged" | "awaitingMerge">;
      settings: Pick<Settings, "read">;
      view?: (url: string) => Promise<PullRequestView>;
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
    // Archived agents stay watched while after-merge tasks wait for their merge.
    for (const record of await this.deps.handover.all()) {
      if (record.links["Pull request"] && (record.status !== "archived" || await manual?.awaitingMerge(record.issueId))) records.push(record);
    }
    let paused: RateLimitedError | null = null;
    for (const record of records) {
      const url = record.links["Pull request"];
      try {
        const result = reviewChange(await (this.deps.view ?? viewPullRequest)(url), seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false });
        const { change, seen } = manual ? await this.gate(record, result, manual) : result;
        if (change) await this.apply(record, change);
        if (change?.review === "merged" && manual) await manual.merged(record.issueId);
        // Saved last, so a failed step is retried on the next poll.
        seenByUrl[url] = seen;
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
    const link = await this.deps.sessions.sessionFor(record.agentId);
    if (link) await this.deps.sessions.say(link.sessionId, "thought", change.thought).catch(() => {});
  }
}
