import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Handover, HandoverRecord } from "./handover";
import type { LinearService } from "./linear";
import { CODING_STATE } from "./plannotator";
import type { SessionRouter } from "./sessions";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

const exec = promisify(execFile);
const INTERVAL_MS = 2 * 60 * 1000;
const REVIEW_STATE = "In Review";

export type PullRequestView = {
  state: string;
  reviews: { author: string; state: string; submittedAt: string }[];
  lastCommitAt: string | null;
};
type Seen = { reviewedAt: string | null; decision: string | null; merged: boolean };
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
    if (latest.state === "APPROVED") return { change: { thought: `@${latest.author} approved the pull request.`, review: `approved by @${latest.author}` }, seen: next };
    if (latest.state === "COMMENTED") return { change: { thought: `@${latest.author} commented on the pull request — the agent is looking at it in Paseo.`, review: `comments from @${latest.author}` }, seen: next };
    return { change: null, seen: next };
  }
  // Fixes pushed after a change request send the ticket back to review.
  if (seen.decision === "CHANGES_REQUESTED" && view.lastCommitAt && seen.reviewedAt && view.lastCommitAt > seen.reviewedAt) {
    return { change: { thought: "New commits were pushed after the requested changes — back in review.", review: "fixes pushed, awaiting review", state: REVIEW_STATE }, seen: { ...seen, decision: "FIXES_PUSHED" } };
  }
  return { change: null, seen };
}

// Mirrors each ticket's pull request review into Linear every 2 minutes.
export class PullRequestWatch {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      handover: Pick<Handover, "all" | "update">;
      sessions: Pick<SessionRouter, "sessionFor" | "say">;
      linear: Pick<LinearService, "moveToStateNamed">;
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

  async poll(): Promise<void> {
    const seenByUrl = await this.load();
    const records = (await this.deps.handover.all()).filter((record) => record.links["Pull request"] && record.status !== "archived");
    for (const record of records) {
      const url = record.links["Pull request"];
      try {
        const { change, seen } = reviewChange(await (this.deps.view ?? viewPullRequest)(url), seenByUrl[url] ?? { reviewedAt: null, decision: null, merged: false });
        seenByUrl[url] = seen;
        if (change) await this.apply(record, change);
      } catch (error) {
        console.error(`[linear-tickets] ${record.identifier}: reading ${url} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    await this.save(seenByUrl);
  }

  private async apply(record: HandoverRecord, change: Change): Promise<void> {
    const link = await this.deps.sessions.sessionFor(record.agentId);
    if (link) await this.deps.sessions.say(link.sessionId, "thought", change.thought).catch(() => {});
    if (change.state && (await this.deps.settings.read()).writeback.status) await this.deps.linear.moveToStateNamed(record.issueId, change.state);
    await this.deps.handover.update({ id: record.issueId, identifier: record.identifier }, { id: record.agentId, title: record.agentTitle, cwd: record.worktreePath ?? "" }, { review: change.review });
  }
}
