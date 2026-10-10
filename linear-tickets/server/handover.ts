import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActivationResume } from "./activation";
import type { ResumeTarget } from "./launch";
import type { LinearService } from "./linear";
import { paseoHome } from "./ticket-mcp";

const exec = promisify(execFile);
const MAX_SUMMARY = 1_500;
const KEPT_SUMMARIES = 3;

// What opened a waiting period: a question or permission request ("request"), which ends when
// nothing is pending any more, or a turn that ended by asking the owner ("turn-end"), which ends
// when the agent's next turn starts or the agent itself is gone.
export type WaitingKind = "request" | "turn-end";

// While an agent waits for an answer or approval: the state the ticket left for "Needs input"
// (restored afterwards) and the mention comment edited for each further question. A ticket already
// closed stays closed: the wait lives in a "Needs you" sub-issue (`subIssueId`), which holds the comment.
// `kind` and `at` describe what opened the period and when it last opened, so writeback can tell a
// wait whose ending event was lost (a question killed with its agent's process, a reload in
// between) from a live one.
export type WaitingPeriod = { previousStateId: string | null; commentId: string | null; subIssueId?: string | null; kind?: WaitingKind; at?: string };
export type HandoverStatus = "working" | "waiting" | "finished" | "failed" | "archived";
export type HandoverRecord = {
  issueId: string;
  identifier: string;
  // Null for a ticket that took over a pull request (see Handover.transfer) before any agent worked
  // on it; such a record is `archived` until an agent takes it over.
  agentId: string | null;
  agentTitle: string;
  branch: string | null;
  worktreePath: string | null;
  lastCommit: string | null;
  summaries: string[];
  links: Record<string, string>;
  // Pull requests the ticket owns besides links["Pull request"], which stays its primary one: those
  // moved to it from another ticket while it already had one (see ownedPullRequests).
  pullRequests?: string[];
  // Where the plan stands, e.g. "under review", "approved", "sent back", "split into 4 sub-issues".
  plan?: string | null;
  // Where the pull request review stands, e.g. "changes requested by @alice".
  review?: string | null;
  // The model the agent last ran with, e.g. "anthropic/claude-opus-5-5 · thinking medium".
  model?: string | null;
  // The open waiting period, while the agent waits for the owner (belongs to the ticket, not the agent).
  waiting?: WaitingPeriod | null;
  status: HandoverStatus;
  progressCommentId: string | null;
  resumedFrom: string | null;
  updatedAt: string;
};

// A pull request's identity whatever its URL's spelling: `owner/name#number`, the repo lower case.
const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
export function pullKey(url: string): string {
  const source = PULL_URL.exec(url);
  return source ? `${source[1].toLowerCase()}#${source[2]}` : url;
}

// Every pull request a ticket's record owns: its primary link first, then the ones moved to it
// while it already had one, each pull request once.
export function ownedPullRequests(record: HandoverRecord): string[] {
  const seen = new Set<string>();
  return [record.links["Pull request"], ...(record.pullRequests ?? [])].filter((url): url is string => {
    if (!url || seen.has(pullKey(url))) return false;
    seen.add(pullKey(url));
    return true;
  });
}

// One pull request's move from one ticket's record to another's (see Handover.transfer), journaled
// per pull request. Writing it `pending` is the move: from then on the pull request is the
// destination's, and reads wait until both records say so (`completed`). A later move of the same
// pull request has a higher `generation`.
export type PullTransfer = {
  generation: number;
  url: string;
  from: { issueId: string; identifier: string };
  to: { issueId: string; identifier: string };
  // The pull request's branch: what a destination without a record continues from.
  headBranch: string | null;
  state: "pending" | "completed";
  at: string;
};
type TransferJournal = Record<string, PullTransfer>;
export type GitState = { branch: string | null; lastCommit: string | null };
type Linear = Pick<LinearService, "upsertComment" | "comment" | "upsertAttachment" | "removeAttachments">;
// Where the web app opens an agent (null when the daemon id is unknown).
export type AgentUrl = (agentId: string) => Promise<string | null>;
const PASEO_WEB = "https://app.paseo.sh/h/";

export async function readGitState(cwd: string): Promise<GitState> {
  const git = async (args: string[]) => (await exec("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();
  const [branch, lastCommit] = await Promise.all([git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""), git(["log", "-1", "--format=%h %s"]).catch(() => "")]);
  return { branch: branch && branch !== "HEAD" ? branch : null, lastCommit: lastCommit || null };
}

// The exact state of the branch work a strict resume continues on: the branch the worktree is on,
// its commit (the full SHA, so the receiving host can require exactly that commit) and whether
// uncommitted changes sit next to it. Null when any of it cannot be read.
async function readWorkState(cwd: string): Promise<{ branch: string | null; commit: string; dirty: boolean } | null> {
  const git = async (args: string[]) => (await exec("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();
  const [branch, commit, status] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null),
    git(["rev-parse", "HEAD"]).catch(() => null),
    git(["status", "--porcelain"]).catch(() => null),
  ]);
  if (commit === null || status === null || !/^[0-9a-f]{40}$/.test(commit)) return null;
  return { branch: branch && branch !== "HEAD" ? branch : null, commit, dirty: status !== "" };
}

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit).trimEnd()} …`);

const PHASE: Record<HandoverStatus, string> = {
  working: "Working",
  waiting: "Waiting for you",
  finished: "Finished",
  failed: "Stopped with an error",
  archived: "Agent closed",
};

export function progressBody(record: HandoverRecord): string {
  const links = Object.entries(record.links).map(([name, url]) => `[${name}](${url})`).join(" · ");
  return [
    `🛠 **Paseo progress** — ${record.agentTitle}`,
    `**Phase:** ${PHASE[record.status]} · updated ${record.updatedAt.slice(0, 16).replace("T", " ")} UTC`,
    record.model ? `**Model:** \`${record.model}\`` : "",
    `**Branch:** ${record.branch ? `\`${record.branch}\`` : "—"} · **Last commit:** ${record.lastCommit ? `\`${record.lastCommit}\`` : "—"}`,
    record.worktreePath ? `**Worktree:** \`${record.worktreePath}\`` : "",
    record.plan ? `**Plan:** ${record.plan}` : "",
    record.review ? `**Review:** ${record.review}` : "",
    links ? `**Links:** ${links}` : "",
    record.summaries.length ? `**Latest:**\n\n${record.summaries[record.summaries.length - 1]}` : "",
  ].filter(Boolean).join("\n");
}

export function finalBody(record: HandoverRecord, reason: string): string {
  return [
    `🏁 **Paseo final report** — ${record.agentTitle}`,
    `**Outcome:** ${PHASE[record.status]}${reason ? ` — ${reason}` : ""}`,
    ...(record.model ? [`**Model:** \`${record.model}\``] : []),
    `**Branch:** ${record.branch ? `\`${record.branch}\`` : "—"} · **Last commit:** ${record.lastCommit ? `\`${record.lastCommit}\`` : "—"}`,
    record.summaries.length ? `**Last report:**\n\n${record.summaries[record.summaries.length - 1]}` : "**Last report:** none",
    `**Continue:** assign Paseo again, @mention it, or re-add the \`paseo\` label — the next agent picks up on ${record.branch ? `\`${record.branch}\`` : "this ticket"} with this record.`,
  ].join("\n\n");
}

// The report of an agent that was closed after another agent had already taken the ticket's record:
// nothing of the record is its own any more, so only who took over.
export function handedOverBody(title: string, successorTitle: string): string {
  return [`🏁 **Paseo final report** — ${title}`, `**Outcome:** ${PHASE.archived} — handed over to ${successorTitle}`].join("\n\n");
}

// What the next agent reads before the ticket prompt.
export function handoverPrompt(record: HandoverRecord): string {
  return [
    record.agentId === null
      ? `You are continuing work on Linear ticket ${record.identifier}. Its pull request moved here from another ticket; no Paseo agent has worked on this ticket yet.`
      : `You are continuing work on Linear ticket ${record.identifier} that another Paseo agent ("${record.agentTitle}") started. It ended as: ${PHASE[record.status]}.`,
    `Branch: ${record.branch ?? "unknown"}. Worktree: ${record.worktreePath ?? "a fresh checkout"}. Last commit: ${record.lastCommit ?? "none"}.`,
    record.summaries.length ? `Its last reports, oldest first:\n${record.summaries.map((summary, index) => `--- report ${index + 1} ---\n${summary}`).join("\n")}` : "",
    Object.keys(record.links).length ? `Links: ${Object.entries(record.links).map(([name, url]) => `${name}: ${url}`).join("; ")}` : "",
    "Verify the actual state with `git status`, `git log` and the ticket's comments and plan document before acting. Do not redo finished steps and keep the approved plan.",
  ].filter(Boolean).join("\n\n");
}

// The durable record of a ticket's agent work: one progress comment edited in place, a final
// comment when the agent stops, and a local record the next agent resumes from.
export class Handover {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly linear: Linear, private readonly directory = join(paseoHome(), "linear-tickets", "handover"), private readonly git = readGitState, private readonly now = () => new Date().toISOString(), private readonly agentUrl?: AgentUrl) {}

  // Every read and write runs in one queue, after any move journaled but not applied to both
  // records yet (a restart in between): nothing ever sees a pull request on both tickets or on
  // neither. Inside the queue, use `raw`.
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const locked = async () => { await this.recover(); return work(); };
    const result = this.queue.then(locked, locked);
    this.queue = result.catch(() => undefined);
    return result;
  }

  read(issueId: string): Promise<HandoverRecord | null> {
    return this.serialize(() => this.raw(issueId));
  }

  private async raw(issueId: string): Promise<HandoverRecord | null> {
    try { return JSON.parse(await readFile(join(this.directory, `${issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`), "utf8")); } catch { return null; }
  }

  private get journalPath(): string {
    return join(this.directory, "transfers", "journal.json");
  }

  private async journal(): Promise<TransferJournal> {
    try { return JSON.parse(await readFile(this.journalPath, "utf8")) as TransferJournal; } catch { return {}; }
  }

  private async saveJournal(journal: TransferJournal): Promise<void> {
    await mkdir(join(this.directory, "transfers"), { recursive: true, mode: 0o700 });
    const temporary = `${this.journalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.journalPath);
    } finally { await rm(temporary, { force: true }); }
  }

  private async recover(): Promise<void> {
    for (const entry of Object.values(await this.journal())) if (entry.state === "pending") await this.materialize(entry);
  }

  // Moves the saved ownership of an open pull request from one ticket's record to another's
  // (README, "Moving a pull request to another ticket"): only the pull request goes, never the
  // source agent, its plan or reports. A destination with a record keeps its agent, branch and
  // primary pull request (the moved one is added); one without a record gets a record without an
  // agent, archived, on the pull request's branch. `not-owned`: the source does not own the pull
  // request (any more), nothing changed. Each step is idempotent, so a restart anywhere resumes.
  transfer(url: string, from: { issueId: string; identifier: string }, to: { issueId: string; identifier: string }, headBranch: string | null): Promise<"moved" | "already" | "not-owned"> {
    return this.serialize(async () => {
      const key = pullKey(url);
      const journal = await this.journal();
      const last = journal[key];
      const destination = await this.raw(to.issueId);
      if (destination && ownedPullRequests(destination).some((owned) => pullKey(owned) === key)) return "already";
      const source = await this.raw(from.issueId);
      if (!source || !ownedPullRequests(source).some((owned) => pullKey(owned) === key)) return "not-owned";
      const entry: PullTransfer = { generation: (last?.generation ?? 0) + 1, url, from, to, headBranch, state: "pending", at: this.now() };
      await this.saveJournal({ ...journal, [key]: entry });
      await this.materialize(entry);
      console.log(`[linear-tickets] ${key} moved from ${from.identifier} to ${to.identifier} (generation ${entry.generation})`);
      return "moved";
    });
  }

  // Applies a journaled move to both records, then marks it completed. Only the ownership fields
  // are written, on the records as they are now.
  private async materialize(entry: PullTransfer): Promise<void> {
    const key = pullKey(entry.url);
    const destination = await this.raw(entry.to.issueId);
    if (!destination) {
      await this.save({
        issueId: entry.to.issueId, identifier: entry.to.identifier, agentId: null, agentTitle: `Paseo on ${entry.to.identifier}`,
        branch: entry.headBranch, worktreePath: null, lastCommit: null, summaries: [], links: { "Pull request": entry.url },
        status: "archived", progressCommentId: null, resumedFrom: null, updatedAt: this.now(),
      });
    } else if (!ownedPullRequests(destination).some((owned) => pullKey(owned) === key)) {
      const primary = destination.links["Pull request"];
      await this.save({
        ...destination,
        links: primary ? destination.links : { ...destination.links, "Pull request": entry.url },
        ...(primary ? { pullRequests: [...(destination.pullRequests ?? []), entry.url] } : {}),
        ...(destination.agentId === null && !destination.branch ? { branch: entry.headBranch } : {}),
        updatedAt: this.now(),
      });
    }
    const source = await this.raw(entry.from.issueId);
    if (source && ownedPullRequests(source).some((owned) => pullKey(owned) === key)) {
      const rest = ownedPullRequests(source).filter((owned) => pullKey(owned) !== key);
      const { "Pull request": _moved, ...links } = source.links;
      await this.save({ ...source, links: rest[0] ? { ...links, "Pull request": rest[0] } : links, pullRequests: rest.length > 1 ? rest.slice(1) : undefined, updatedAt: this.now() });
    }
    const journal = await this.journal();
    if (journal[key]?.generation === entry.generation) await this.saveJournal({ ...journal, [key]: { ...entry, state: "completed" } });
  }

  // The ticket a pull request moved to, when its last move took it away from `issueId`: a late
  // link from the source (a write-back, a discovery) must not take it back.
  private async movedAway(issueId: string, url: string): Promise<string | null> {
    const last = (await this.journal())[pullKey(url)];
    return last && last.to.issueId !== issueId ? last.to.identifier : null;
  }

  // A record without an agent (see transfer) gets its pull request's link or review state; the
  // record otherwise stays as it is until an agent takes it over.
  annotate(issueId: string, change: { link?: [string, string]; review?: string }): Promise<void> {
    return this.serialize(async () => {
      const previous = await this.raw(issueId);
      if (!previous || previous.agentId !== null) return;
      if (change.link?.[0] === "Pull request" && await this.movedAway(issueId, change.link[1])) return;
      await this.save({ ...previous, links: change.link ? { ...previous.links, [change.link[0]]: change.link[1] } : previous.links, review: change.review ?? previous.review ?? null, updatedAt: this.now() });
    });
  }

  // One pull request the record owns gives way to another (a replacement from the same branch, the
  // next one after a landing), wherever it stands: the primary link or the others. The others the
  // record owns stay. Nothing changes when the record does not own `previous`; a pull request that
  // moved away from this ticket is not taken back (only `previous` goes).
  swapPullRequest(issueId: string, previous: string, url: string): Promise<void> {
    return this.serialize(async () => {
      const record = await this.raw(issueId);
      const owned = record ? ownedPullRequests(record) : [];
      if (!record || !owned.some((item) => pullKey(item) === pullKey(previous))) return;
      const away = await this.movedAway(issueId, url);
      const list = owned.flatMap((item) => (pullKey(item) === pullKey(previous) ? (away ? [] : [url]) : [item]));
      const kept = list.filter((item, index) => list.findIndex((other) => pullKey(other) === pullKey(item)) === index);
      const { "Pull request": _old, ...links } = record.links;
      await this.save({ ...record, links: kept[0] ? { ...links, "Pull request": kept[0] } : links, pullRequests: kept.length > 1 ? kept.slice(1) : undefined, updatedAt: this.now() });
    });
  }

  private async save(record: HandoverRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${record.issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  // Updates the record for this agent (a new agent on the ticket starts a new progress comment)
  // and edits the progress comment. Returns the record.
  update(issue: { id: string; identifier: string }, agent: { id: string; title: string | null; cwd: string }, change: { status?: HandoverStatus; summary?: string; link?: [string, string]; plan?: string; review?: string; model?: string | null }): Promise<HandoverRecord> {
    return this.serialize(async () => this.write(await this.raw(issue.id), issue, agent, change));
  }

  private async write(previous: HandoverRecord | null, issue: { id: string; identifier: string }, agent: { id: string; title: string | null; cwd: string }, change: { status?: HandoverStatus; summary?: string; link?: [string, string]; plan?: string; review?: string; model?: string | null }): Promise<HandoverRecord> {
    const sameAgent = previous?.agentId === agent.id;
    const movedTo = change.link?.[0] === "Pull request" ? await this.movedAway(issue.id, change.link[1]) : null;
    if (movedTo) {
      console.log(`[linear-tickets] ${issue.identifier}: ${change.link![1]} moved to ${movedTo}; the late link to this ticket is not recorded`);
      change = { ...change, link: undefined };
    }
    const git = await this.git(agent.cwd).catch(() => ({ branch: null, lastCommit: null }));
    const paseoUrl = await this.agentUrl?.(agent.id).catch(() => null) ?? null;
    const record: HandoverRecord = {
      issueId: issue.id,
      identifier: issue.identifier,
      agentId: agent.id,
      // Hook events can carry no title; the one seen earlier for this agent stays.
      agentTitle: agent.title ?? (sameAgent ? previous.agentTitle : null) ?? `Paseo agent on ${issue.identifier}`,
      branch: git.branch ?? (sameAgent ? previous.branch : null),
      worktreePath: agent.cwd,
      lastCommit: git.lastCommit ?? (sameAgent ? previous.lastCommit : null),
      summaries: [...(sameAgent ? previous.summaries : previous?.summaries ?? []), ...(change.summary ? [clip(change.summary, MAX_SUMMARY)] : [])].slice(-KEPT_SUMMARIES),
      // The ticket's links (its pull request above all, which the pull request watch follows)
      // stay when another agent takes over; only the agent's own Paseo link is its own.
      links: { ...(paseoUrl ? { "Open in Paseo": paseoUrl } : {}), ...Object.fromEntries(Object.entries(previous?.links ?? {}).filter(([name]) => sameAgent || name !== "Open in Paseo")), ...(change.link ? { [change.link[0]]: change.link[1] } : {}) },
      ...(previous?.pullRequests?.length ? { pullRequests: previous.pullRequests } : {}),
      plan: change.plan ?? (sameAgent ? previous.plan ?? null : null),
      review: change.review ?? (sameAgent ? previous.review ?? null : null),
      model: change.model ?? (sameAgent ? previous.model ?? null : null),
      waiting: previous?.waiting ?? null,
      status: change.status ?? (sameAgent ? previous.status : "working"),
      progressCommentId: sameAgent ? previous.progressCommentId : null,
      resumedFrom: sameAgent ? previous.resumedFrom : previous?.agentId ?? null,
      updatedAt: this.now(),
    };
    const body = progressBody(record);
    record.progressCommentId = await this.linear.upsertComment(issue.id, body, record.progressCommentId);
    // The ticket's link to the agent (next to its pull requests), kept current and moved to a
    // new agent when one takes over. Best-effort: the comment above is the record.
    if (paseoUrl) {
      await this.linear.upsertAttachment(issue.id, paseoUrl, record.agentTitle.startsWith("Paseo agent") ? record.agentTitle : `Paseo agent · ${record.agentTitle}`, [PHASE[record.status], record.model].filter(Boolean).join(" · ")).catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: Paseo agent link failed: ${error instanceof Error ? error.message : error}`));
      if (!sameAgent) await this.linear.removeAttachments(issue.id, PASEO_WEB, paseoUrl).catch(() => {});
    }
    await this.save(record);
    return record;
  }

  // A takeover: the only way the record changes owner when one agent follows another (README,
  // "Durable record and resume"). A record that names the predecessor, or no record, becomes the
  // successor's (working, carried over as for any new agent); one that names the successor already
  // keeps its state (a waiting or finished successor stays so), and one that names a third agent is
  // not touched, so whichever event comes last never hands the ticket back. `report` (the
  // predecessor was closed): its final report, from the record as it was before the takeover when
  // that record was its own, else only who took over. Returns whether the record was rewritten.
  // A null `predecessorId` takes over a record without an agent (see transfer).
  handOff(issue: { id: string; identifier: string }, predecessorId: string | null, successor: { id: string; title: string | null; cwd: string }, report?: { title: string | null }): Promise<boolean> {
    return this.serialize(async () => {
      const previous = await this.raw(issue.id);
      const own = !previous || previous.agentId === predecessorId;
      if (own) await this.write(previous, issue, successor, { status: "working" });
      if (!report) return own;
      const successorTitle = successor.title ?? `a new agent (${successor.id.slice(0, 8)})`;
      if (previous?.agentId && own) {
        const closed: HandoverRecord = { ...previous, status: "archived", updatedAt: this.now() };
        if (previous.progressCommentId) await this.linear.upsertComment(issue.id, progressBody(closed), previous.progressCommentId);
        await this.linear.comment(issue.id, finalBody(closed, `handed over to ${successorTitle}`));
      } else {
        await this.linear.comment(issue.id, handedOverBody(report.title ?? `Paseo agent on ${issue.identifier}`, successorTitle));
      }
      return own;
    });
  }

  // Marks the agent as stopped and posts the final report.
  async finish(issue: { id: string; identifier: string }, agent: { id: string; title: string | null; cwd: string }, status: "finished" | "failed" | "archived", reason: string, model?: string | null): Promise<HandoverRecord> {
    const record = await this.update(issue, agent, { status, model });
    await this.linear.comment(issue.id, finalBody(record, reason));
    return record;
  }

  async waiting(issueId: string): Promise<WaitingPeriod | null> {
    return (await this.read(issueId))?.waiting ?? null;
  }

  // Records the waiting period without touching the progress comment. A ticket without a record
  // yet (no turn summary so far) gets a minimal one for this agent.
  setWaiting(issue: { id: string; identifier: string }, agent: { id: string; title: string | null; cwd: string }, waiting: WaitingPeriod | null): Promise<void> {
    return this.serialize(async () => {
      const previous = await this.raw(issue.id);
      if (!previous && !waiting) return;
      const base: HandoverRecord = previous ?? {
        issueId: issue.id, identifier: issue.identifier, agentId: agent.id, agentTitle: agent.title ?? `Paseo agent on ${issue.identifier}`,
        branch: null, worktreePath: agent.cwd, lastCommit: null, summaries: [], links: {}, status: "working", progressCommentId: null, resumedFrom: null, updatedAt: this.now(),
      };
      await this.save({ ...base, waiting });
    });
  }

  all(): Promise<HandoverRecord[]> {
    return this.serialize(async () => {
      const names = await readdir(this.directory).catch(() => [] as string[]);
      const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(this.directory, name), "utf8").then((text) => JSON.parse(text) as HandoverRecord, () => null)));
      return records.filter((record): record is HandoverRecord => Boolean(record));
    });
  }

  async resumeTarget(issueId: string): Promise<ResumeTarget | null> {
    const record = await this.read(issueId);
    if (!record?.branch) return null;
    return { branch: record.branch, worktreePath: record.worktreePath, handover: handoverPrompt(record) };
  }

  // The handover snapshot that travels with a strict resume to the peer host (drain.ts): the
  // recorded branch, its exact commit and whether uncommitted changes are next to it, plus the
  // same prompt the next agent reads. The worktree path stays on this host (the receiving host
  // opens its own checkout), and nothing is offered that could not be verified: no record, no
  // branch, no worktree, or a worktree that is gone or off the recorded branch means no snapshot,
  // so the peer holds the resume instead of continuing on a guess.
  async resumeSnapshot(issueId: string): Promise<ActivationResume | null> {
    const record = await this.read(issueId);
    if (!record?.branch || !record.worktreePath) return null;
    const state = await readWorkState(record.worktreePath);
    if (!state || state.branch !== record.branch) return null;
    return { branch: record.branch, commit: state.commit, dirty: state.dirty, handover: handoverPrompt({ ...record, worktreePath: null }) };
  }
}
