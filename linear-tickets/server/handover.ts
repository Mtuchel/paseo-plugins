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
  agentId: string;
  agentTitle: string;
  branch: string | null;
  worktreePath: string | null;
  lastCommit: string | null;
  summaries: string[];
  links: Record<string, string>;
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
    `You are continuing work on Linear ticket ${record.identifier} that another Paseo agent ("${record.agentTitle}") started. It ended as: ${PHASE[record.status]}.`,
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

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async read(issueId: string): Promise<HandoverRecord | null> {
    try { return JSON.parse(await readFile(join(this.directory, `${issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`), "utf8")); } catch { return null; }
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
    return this.serialize(async () => this.write(await this.read(issue.id), issue, agent, change));
  }

  private async write(previous: HandoverRecord | null, issue: { id: string; identifier: string }, agent: { id: string; title: string | null; cwd: string }, change: { status?: HandoverStatus; summary?: string; link?: [string, string]; plan?: string; review?: string; model?: string | null }): Promise<HandoverRecord> {
    const sameAgent = previous?.agentId === agent.id;
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
  handOff(issue: { id: string; identifier: string }, predecessorId: string, successor: { id: string; title: string | null; cwd: string }, report?: { title: string | null }): Promise<boolean> {
    return this.serialize(async () => {
      const previous = await this.read(issue.id);
      const own = !previous || previous.agentId === predecessorId;
      if (own) await this.write(previous, issue, successor, { status: "working" });
      if (!report) return own;
      const successorTitle = successor.title ?? `a new agent (${successor.id.slice(0, 8)})`;
      if (previous && own) {
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
      const previous = await this.read(issue.id);
      if (!previous && !waiting) return;
      const base: HandoverRecord = previous ?? {
        issueId: issue.id, identifier: issue.identifier, agentId: agent.id, agentTitle: agent.title ?? `Paseo agent on ${issue.identifier}`,
        branch: null, worktreePath: agent.cwd, lastCommit: null, summaries: [], links: {}, status: "working", progressCommentId: null, resumedFrom: null, updatedAt: this.now(),
      };
      await this.save({ ...base, waiting });
    });
  }

  async all(): Promise<HandoverRecord[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(this.directory, name), "utf8").then((text) => JSON.parse(text) as HandoverRecord, () => null)));
    return records.filter((record): record is HandoverRecord => Boolean(record));
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
