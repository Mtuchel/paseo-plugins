import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LinearService } from "./linear";
import type { FollowState, RetriggerRun } from "./queue-backstop";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// The Greptile outage issue (TUC-1208, README "Queue backstop"): once a pull request waits 2 hours
// after the queue backstop asked Greptile, one issue "Greptile is not reviewing" lists every
// pull request that waits for its first Greptile review. It is updated, never filed twice, and
// completes itself once a run read every repo and every listed pull request has an outcome.
// Only the dispatch host runs it (see PullRequestWatch.queueBackstop), one run at a time.

export const OUTAGE_TITLE = "Greptile is not reviewing";
// The description's first line; a lost state file finds the open issue by it.
export const OUTAGE_MARKER = "Marker: `greptile-outage`";
const CLOSED_TYPES = ["completed", "canceled", "duplicate"];
const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
// A listed line of the description: `- [#12 title](https://github.com/o/r/pull/12) — …`.
const LISTED_LINE = /^- \[#\d+ ?([^\]\n]*)\]\((https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/\d+)\)/gm;
const BERLIN = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });

// One repo's answer of `greptile-retrigger.mjs` in a backstop run: `failed` when it threw, exited 1
// or the run stopped before it (rate limit); `skipped` when the repo has no checkout or no script.
export type RetriggerResult = { repo: string; result: "answer"; run: RetriggerRun } | { repo: string; result: "failed"; error: string } | { repo: string; result: "skipped" };

type Outcome = Exclude<FollowState, "waiting" | "unread">;
// A listed pull request: `outcome` null while it waits, else why it no longer does.
type Listed = { title: string; triggers: string[]; outcome: Outcome | null };
// `reserved`: the id chosen for the issue before its create, until Linear confirmed it (a lost
// answer is looked up, and retried, under the same id). `dismissed`: a person closed the issue
// while pull requests still waited; it is left alone until a complete run finds none waiting.
// `written`: the description last written. `commented`: the closing comment went out.
export type OutageState = { issueId: string | null; reserved: string | null; listed: Record<string, Listed>; dismissed: boolean; written: string | null; commented: boolean };
type Linear = Pick<LinearService, "createIssue" | "updateDescription" | "comment" | "complete" | "teamIdByKey" | "viewerId" | "userUrl" | "issueById" | "issueState" | "issuesMentioning">;
type Waiting = { title: string; triggers: string[]; overdue: boolean };

const empty = (): OutageState => ({ issueId: null, reserved: null, listed: {}, dismissed: false, written: null, commented: false });
const pullUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

const OUTCOME_TEXT: Record<Outcome, string> = { reviewed: "reviewed", closed: "closed", draft: "back to draft", unlabelled: "`complex-review` removed" };

function pullLink(url: string, title: string): string {
  const clean = title.replace(/[[\]\n]/g, " ").trim();
  return `[#${PULL_URL.exec(url)?.[2] ?? "?"}${clean ? ` ${clean}` : ""}](${url})`;
}

function byNumber(a: string, b: string): number {
  return Number(PULL_URL.exec(a)?.[2] ?? 0) - Number(PULL_URL.exec(b)?.[2] ?? 0);
}

export function outageDescription(state: Pick<OutageState, "listed">, unread: Set<string>, mention: string): string {
  const urls = Object.keys(state.listed).sort(byNumber);
  const waiting = urls.filter((url) => state.listed[url].outcome === null).map((url) => {
    const entry = state.listed[url];
    const last = entry.triggers.map((at) => Date.parse(at)).filter(Number.isFinite).sort((a, b) => a - b).at(-1);
    const asked = last === undefined ? "not asked yet" : `Greptile re-requested ${BERLIN.format(last)} (${entry.triggers.length}×)`;
    return `- ${pullLink(url, entry.title)} — ${asked}${unread.has(url) ? " (not read this run)" : ""}`;
  });
  const finished = urls.flatMap((url) => {
    const { outcome, title } = state.listed[url];
    return outcome === null ? [] : [`- ${pullLink(url, title)} — ${OUTCOME_TEXT[outcome]}`];
  });
  return [
    OUTAGE_MARKER,
    "",
    `${mention} Greptile has not answered the queue backstop's review request (\`@greptileai\`) for 2 hours. These \`complex-review\` pull requests wait for their first Greptile review, so they cannot merge. Paseo updates this list every 10 minutes and completes this issue once none waits any more.`,
    "",
    "**Waiting for Greptile**",
    "",
    ...(waiting.length ? waiting : ["- none"]),
    ...(finished.length ? ["", "**No longer waiting**", "", ...finished] : []),
  ].join("\n");
}

export class GreptileOutage {
  constructor(
    private readonly linear: Linear,
    private readonly settings: Pick<Settings, "read">,
    private readonly path = join(paseoHome(), "linear-tickets", "greptile-outage.json"),
  ) {}

  private async load(): Promise<OutageState> {
    try { return { ...empty(), ...JSON.parse(await readFile(this.path, "utf8")) }; } catch { return empty(); }
  }

  private async save(state: OutageState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  // The listed pull requests still without an outcome, per repo: this run passes them to the
  // script as `--follow`, so a reviewed, closed or unmarked one is told from one not read. A repo
  // whose listed pull requests all have an outcome stays in (with none), so it is still read
  // until the incident is over.
  async follow(): Promise<Map<string, number[]>> {
    const follow = new Map<string, number[]>();
    for (const [url, entry] of Object.entries((await this.load()).listed)) {
      const found = PULL_URL.exec(url);
      if (!found) continue;
      follow.set(found[1], [...(follow.get(found[1]) ?? []), ...(entry.outcome === null ? [Number(found[2])] : [])]);
    }
    return follow;
  }

  private async teamId(): Promise<string | null> {
    const teamKey = (await this.settings.read()).dispatch.teamKeys[0];
    return teamKey ? this.linear.teamIdByKey(teamKey) : null;
  }

  // One run, after every repo's script ran (see RetriggerResult). A Linear failure throws and
  // stops the run; the state saved so far is what the next run (10 minutes later) starts from.
  async sync(results: RetriggerResult[]): Promise<void> {
    const state = await this.load();
    const answers = new Map(results.flatMap((found): [string, RetriggerRun][] => (found.result === "answer" ? [[found.repo, found.run]] : [])));
    const waiting = new Map<string, Waiting>();
    const followed = new Map<string, FollowState>();
    for (const [repo, run] of answers) {
      for (const pull of run.pulls) waiting.set(pullUrl(repo, pull.pr), { title: pull.title, triggers: pull.triggers, overdue: pull.overdue });
      for (const item of run.followed) followed.set(pullUrl(repo, item.pr), item.state);
    }
    for (const [url, found] of followed) {
      if (found === "waiting" && !waiting.has(url)) waiting.set(url, { title: state.listed[url]?.title ?? "", triggers: state.listed[url]?.triggers ?? [], overdue: false });
    }
    // A listed pull request that waits was not decided by this run unless its repo answered for it.
    const unread = new Set(Object.entries(state.listed).flatMap(([url, entry]) => {
      if (waiting.has(url)) return [];
      const found = followed.get(url);
      const answered = answers.has(PULL_URL.exec(url)?.[1] ?? "");
      if (entry.outcome !== null && found === undefined) return [];
      return !answered || found === undefined || found === "unread" ? [url] : [];
    }));
    // Every repo must answer, including those retained after its listed PRs resolved.
    const listedRepos = new Set(Object.keys(state.listed).map((url) => PULL_URL.exec(url)?.[1] ?? ""));
    const complete = results.every((found) => found.result === "answer") && [...listedRepos].every((repo) => answers.has(repo)) && ![...answers.values()].some((run) => run.errors.length > 0 || run.followed.some((item) => item.state === "unread")) && unread.size === 0;
    const overdue = [...waiting.values()].some((pull) => pull.overdue);
    const list = (urls: Iterable<[string, Waiting]>) => {
      for (const [url, pull] of urls) state.listed[url] ??= { title: pull.title, triggers: pull.triggers, outcome: null };
    };

    // 1. A reservation is resolved first; a lost state file is recovered by the marker.
    if (state.reserved) {
      const found = await this.linear.issueById(state.reserved);
      if (found) {
        state.issueId = found.id;
        state.reserved = null;
        await this.save(state);
      } else if (!overdue && complete) {
        // The create never went through and a complete run finds nothing overdue: no obsolete issue.
        await this.save(empty());
        return;
      }
    } else if (!state.issueId) {
      const teamId = await this.teamId();
      const open = teamId ? (await this.linear.issuesMentioning(teamId, "greptile-outage", true)).filter((issue) => issue.description.includes(OUTAGE_MARKER)) : [];
      const [oldest, ...others] = open.sort((a, b) => Number(a.identifier.split("-")[1]) - Number(b.identifier.split("-")[1]));
      if (oldest) {
        if (others.length) console.error(`[linear-tickets] greptile outage: adopted ${oldest.identifier}; also open: ${others.map((issue) => issue.identifier).join(", ")}`);
        state.issueId = oldest.id;
        state.written = oldest.description;
        // Followed from the next run on, so this run never completes it.
        for (const [, title, url] of oldest.description.matchAll(LISTED_LINE)) state.listed[url] ??= { title: title.trim(), triggers: [], outcome: null };
        await this.save(state);
        return;
      }
    }

    // 2. Outcomes: a pull request that waits again has none; an unread one keeps its entry.
    for (const [url, entry] of Object.entries(state.listed)) {
      if (unread.has(url)) continue;
      const now = waiting.get(url);
      const found = followed.get(url);
      if (now) {
        entry.outcome = null;
        entry.title = now.title || entry.title;
        if (now.triggers.length) entry.triggers = now.triggers;
      } else if (found && found !== "waiting" && found !== "unread") entry.outcome = found;
    }

    // 3. Open once something is overdue, under the reserved id.
    if (!state.issueId) {
      if (!overdue || state.dismissed) return;
      const teamId = await this.teamId();
      if (!teamId) {
        console.error("[linear-tickets] greptile outage: no auto-dispatch team to file the issue in");
        return;
      }
      list(waiting);
      if (!state.reserved) {
        state.reserved = randomUUID();
        await this.save(state);
      }
      const viewer = await this.linear.viewerId();
      const description = outageDescription(state, unread, await this.linear.userUrl(viewer));
      let issueId: string;
      try {
        issueId = (await this.linear.createIssue({ id: state.reserved, teamId, projectId: null, title: OUTAGE_TITLE, description, assigneeId: viewer, priority: 2, ready: true })).id || state.reserved;
      } catch (error) {
        // "Already exists": an earlier create under this id went through after all.
        const found = await this.linear.issueById(state.reserved).catch(() => null);
        if (!found) throw error;
        issueId = found.id;
      }
      await this.save({ ...state, issueId, reserved: null, written: description });
      return;
    }

    // 4. Update; a person's close is respected while anything waits.
    const issueId = state.issueId;
    if (!state.dismissed) list(waiting);
    const status = await this.linear.issueState(issueId).then((found) => found.statusType, async (error: unknown) => {
      if (await this.linear.issueById(issueId) === null) return "canceled";
      throw error;
    });
    const closed = CLOSED_TYPES.includes(status);
    const pending = waiting.size > 0 || Object.values(state.listed).some((entry) => entry.outcome === null);
    if (closed && pending) state.dismissed = true;
    if (!closed && !state.dismissed) {
      const description = outageDescription(state, unread, await this.linear.userUrl(await this.linear.viewerId()));
      if (description !== state.written) {
        await this.linear.updateDescription(issueId, description);
        state.written = description;
      }
    }

    // 5. Complete (or forget a dismissed issue) only after a complete run with nothing waiting.
    if (complete && !pending) {
      if (!closed && !state.dismissed) {
        if (!state.commented) {
          const lines = Object.keys(state.listed).sort(byNumber).flatMap((url) => {
            const { outcome, title } = state.listed[url];
            return outcome === null ? [] : [`- ${pullLink(url, title)} — ${OUTCOME_TEXT[outcome]}`];
          });
          await this.linear.comment(issueId, ["✅ No pull request waits for Greptile any more:", "", ...lines].join("\n"));
          state.commented = true;
          await this.save(state);
        }
        await this.linear.complete(issueId);
      }
      await this.save(empty());
      return;
    }
    await this.save(state);
  }
}
