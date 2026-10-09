import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { agentAppDirectory, type AgentApi } from "./agent-app";
import { record } from "./context";
import { CREATE_COMMENT_QUERY, CREATE_ISSUE_QUERY, UPDATE_ISSUE_STATE_QUERY, type IssueLink, type LinearService, type MentioningIssue } from "./linear";
import { questionKey, questionsOf } from "./relay";
import { paseoHome } from "./ticket-mcp";

// Decision candidates (README, "Decision candidates"): what the owner decided outside plans —
// plan review feedback, answers to agents' questions, comments on tickets an agent worked on — is
// collected once a week, an agent picks the decisions that should hold for future work, and
// `file` turns them into one "Decision candidates, week N" ticket per project. Nothing here
// approves anything: only the owner's answer in that ticket does.
//
// Everything lives in `$PASEO_HOME/linear-tickets/owner-decisions/`, private to the daemon user:
// - `log.jsonl`: plan feedback, questions and answers as they happen (the only trace of answers
//   given in the Paseo app, and of earlier review rounds once the plan document is replaced);
// - `state.json`: `coverageFrom` and `commentsFrom` (see collectWindow) and `checkpoint` (the last
//   filed batch's end);
// - `batches/<until>.json`: what one `collect` found, which `file` cites;
// - `lock`: one `collect` or `file` at a time.

const DAY_MS = 24 * 60 * 60 * 1000;
export const LOG_KEEP_MS = 60 * DAY_MS;
export const WINDOW_MS = 7 * DAY_MS;
export const MAX_LOOKBACK_MS = 28 * DAY_MS;
// How long agent-records.ts kept the plugin's key-written comment records before this feature
// raised it: anything older may have lost its record, so it cannot be told from the owner's.
const RECORDS_BEFORE_ROLLOUT_MS = 7 * DAY_MS;
const LOCK_STALE_MS = 30 * 60 * 1000;
// A release waits up to 2 s for another run's takeover or release (each takes milliseconds).
const GUARD_RETRY_MS = 50;
const GUARD_RETRIES = 40;
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const CLOSED_TYPES = ["completed", "canceled", "duplicate"];
// Every line terminator Markdown or a multiline `^` (Q_HEADING, MARKER_LINE) would break a line at.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
export const PROJECTS = ["ERP", "Agent tooling"] as const;
export type Project = (typeof PROJECTS)[number];
export const MARKER = "decision-candidates";
const MARKER_LINE = /^Marker: `decision-candidates (ERP|Agent tooling) (\d{4})-W(\d{2})(?: run (\d+))?`/m;
const KEY_LINE = /^- Key: `([0-9a-f]{16})`/gm;
const Q_HEADING = /^## Q-(\d+) — /gm;
const AUTO_APPROVED = "Auto-approved by the risk policy";

export function decisionsDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "owner-decisions");
}

async function writePrivate(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------
// The log

type LoggedQuestion = { key: string; question: string; options: string[] };
// Where a deputy's knowledge came from (README, "Deputy for agent questions"): the source's stable
// id and revision (a document's content hash, a commit, a log entry or memory id) and the verbatim
// passage, so a citation still says what it relied on after the source changes.
export type CitationKind = "plan" | "principles" | "rules" | "owner-answer" | "memory";
export type Citation = { sourceId: string; kind: CitationKind; title: string; revision: string; quote: string; url?: string };
export type DeputyMode = "shadow" | "live";
// `owner-answer`: an answer the plugin itself delivered for the authenticated owner (a Linear
// comment written with the owner's key, or an agent-session reply whose author is the owner),
// bound to the request it answered; the only answers the deputy treats as the owner's. `answer`
// records resolutions as the daemon reports them: they name no responder, so they never count as
// verified. `key` makes an entry unique beside (kind, id): an activity id, an intent or a status.
export type LogEntry =
  | { kind: "plan-feedback"; id: string; at: string; identifier: string; issueId: string; approved: boolean; text: string }
  | { kind: "question"; id: string; at: string; identifier: string; issueId: string; questions: LoggedQuestion[] }
  | { kind: "answer"; id: string; at: string; answers?: Record<string, string>; denyMessage?: string }
  | { kind: "owner-answer"; id: string; at: string; key: string; via: "linear-comment" | "linear-session" | "menu-bar"; userId: string; answers: Record<string, string> }
  | { kind: "deputy-prediction"; id: string; at: string; identifier: string; issueId: string; version: string; mode: DeputyMode; selections: Record<string, string>; citations: Citation[] }
  | { kind: "deputy-refusal"; id: string; at: string; identifier: string; issueId: string; version: string; mode: DeputyMode; reason: string; category?: string }
  | { kind: "deputy-answer"; id: string; at: string; identifier: string; issueId: string; version: string; key: string; answers: Record<string, string>; citations: Citation[] }
  | { kind: "deputy-outcome"; id: string; at: string; key: "blocked" | "canceled" | "owner-won" | "unknown"; reason: string }
  | { kind: "deputy-override"; id: string; at: string; key: string; via: "linear-comment" | "linear-session" | "menu-bar"; userId: string; text: string; disposition: "delivered" | "failed"; detail?: string };

const KINDS: LogEntry["kind"][] = ["plan-feedback", "question", "answer", "owner-answer", "deputy-prediction", "deputy-refusal", "deputy-answer", "deputy-outcome", "deputy-override"];
const entryKey = (entry: LogEntry) => `${entry.kind}\n${entry.id}\n${"key" in entry ? entry.key : ""}`;

function validEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return KINDS.includes(entry.kind as LogEntry["kind"]) && text(entry.id) && text(entry.at) && !Number.isNaN(Date.parse(entry.at));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

// Append-only in meaning: an entry is never changed; a (kind, id) already logged is skipped, and
// entries older than LOG_KEEP_MS are dropped on the next append. One instance per daemon, so its
// queue serializes every write.
export class DecisionLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly directory = decisionsDirectory(), private readonly now = () => Date.now()) {}

  private get path(): string {
    return join(this.directory, "log.jsonl");
  }

  async entries(): Promise<LogEntry[]> {
    const content = await readFile(this.path, "utf8").catch((error: unknown) => {
      if (missing(error)) return "";
      throw error;
    });
    return content.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const value: unknown = JSON.parse(line);
        return validEntry(value) ? [value] : [];
      } catch { return []; }
    });
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async write(entries: LogEntry[], entry: LogEntry): Promise<void> {
    if (entries.some((known) => entryKey(known) === entryKey(entry))) return;
    const cutoff = this.now() - LOG_KEEP_MS;
    const kept = [...entries.filter((known) => Date.parse(known.at) >= cutoff), entry];
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivate(this.path, kept.map((known) => JSON.stringify(known)).join("\n") + "\n");
  }

  append(entry: LogEntry): Promise<void> {
    return this.serialize(async () => this.write(await this.entries(), entry));
  }

  // The resolution of a question this log holds; other resolutions (tool and plan approvals) are
  // not the owner's answers and are skipped.
  answer(id: string, resolution: AgentPermissionResponse, at = new Date(this.now()).toISOString()): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.entries();
      if (!entries.some((entry) => entry.kind === "question" && entry.id === id)) return;
      await this.write(entries, resolution.behavior === "allow"
        ? { kind: "answer", id, at, answers: stringRecord(record(resolution.updatedInput ?? {}).answers) }
        : { kind: "answer", id, at, denyMessage: resolution.message ?? "" });
    });
  }
}

// A question request as the log keeps it; null for every other kind of request.
export function questionEntry(agentId: string, request: AgentPermissionRequest, issue: { id: string; identifier: string }, at = new Date().toISOString()): LogEntry | null {
  if (request.kind !== "question") return null;
  const questions = questionsOf(request).map((item, index) => ({
    key: questionKey(item, index),
    question: [item.header, item.question].filter(Boolean).join(": ") || request.title || request.name,
    options: (item.options ?? []).map((option) => option.label ?? "").filter(Boolean),
  }));
  if (!questions.length) questions.push({ key: "q0", question: [request.title || request.name, request.description].filter(Boolean).join("\n\n"), options: [] });
  return { kind: "question", id: `${agentId}:${request.id}`, at, identifier: issue.identifier, issueId: issue.id, questions };
}

// The plan review feedback the owner gave; null for a decision without feedback and for the risk
// policy's own approval note.
export function feedbackEntry(agentId: string, event: { approved: boolean; feedback?: string; at: string }, issue: { id: string; identifier: string }): LogEntry | null {
  const feedback = event.feedback?.trim();
  if (!feedback || feedback.startsWith(AUTO_APPROVED)) return null;
  return { kind: "plan-feedback", id: `${agentId}:${event.at}`, at: event.at, identifier: issue.identifier, issueId: issue.id, approved: event.approved, text: feedback };
}

// A failed log write is reported and never stops the delivery that triggered it.
export async function logQuietly(work: () => Promise<void>, what: string): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`[linear-tickets] decision log: ${what} failed: ${error instanceof Error ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The collector

// `deputy-answer`: what the deputy answered and why, review evidence only (its `words` are empty,
// so no candidate can quote it as the owner's decision); `deputy-override`: the owner correcting
// a deputy answer, in the owner's words.
export type ItemKind = "plan-feedback" | "answer" | "comment" | "deputy-answer" | "deputy-override";
// `sourceId`: stable per event (a Linear comment id, a log entry, a plan document's id plus its
// update time), so a candidate citing it keeps its identity however it is worded. `text`: what the
// sorting agent reads (for an answer also the agent's question and options); `words`: only what
// the owner wrote, the one place evidence may quote from.
export type Item = { kind: ItemKind; sourceId: string; at: string; identifier: string; ticketUrl: string; project: string; sourceUrl: string; text: string; words: string };
export type CollectReader = Pick<LinearService, "viewerId" | "ownerCommentsSince" | "planSentBackSince" | "planDocumentsSince" | "issueLinks">;
// `recorded`: comment ids agents and the plugin wrote (agent-records.ts); `agentTickets`: tickets
// that had an agent (handover and needs-you records); `excluded`: the candidate tickets.
export type CollectSources = { log: Pick<DecisionLog, "entries">; linear: CollectReader; recorded: Set<string>; agentTickets: Set<string>; excluded: Set<string> };

// The feedback section PlannotatorBridge writes into a "Plan:" document (planDocument), as Linear
// returns it; null when the document is not one of the plugin's or has no feedback.
export function documentFeedback(content: string): { approved: boolean; text: string } | null {
  const header = /^> \*\*(Sent back with feedback|Approved)\*\* in Plannotator/.exec(content);
  if (!header) return null;
  const start = content.indexOf("\n## Review feedback\n");
  const separator = content.search(/\n-{3,}\n/);
  if (start < 0 || (separator >= 0 && separator < start)) return null;
  const body = content.slice(start + "\n## Review feedback\n".length);
  const end = body.search(/\n-{3,}\n/);
  const feedback = (end < 0 ? body : body.slice(0, end)).trim();
  return feedback && !feedback.startsWith(AUTO_APPROVED) ? { approved: header[1] === "Approved", text: feedback } : null;
}

// The feedback in a "↩️ Plan sent back" comment: everything after its first line.
export function sentBackFeedback(body: string): string | null {
  if (!/^\s*↩️ \*\*Plan sent back\*\*/.test(body)) return null;
  const rest = body.slice(body.indexOf("\n") < 0 ? body.length : body.indexOf("\n"))
    .replace(/\n+Assign Paseo again to (?:plan it again|implement it)\.\s*$/, "").trim();
  return rest || null;
}

function answerText(question: Extract<LogEntry, { kind: "question" }>, answer: Extract<LogEntry, { kind: "answer" }>): string {
  if (answer.denyMessage !== undefined) {
    return [...question.questions.map((item) => `Question: ${item.question}`), `Declined${answer.denyMessage ? `: ${answer.denyMessage}` : ""}`].join("\n");
  }
  return question.questions.map((item) => [
    `Question: ${item.question}`,
    item.options.length ? `Options: ${item.options.join(" / ")}` : "",
    `Answer: ${answer.answers?.[item.key] || "(no answer)"}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function answerWords(question: Extract<LogEntry, { kind: "question" }>, answer: Extract<LogEntry, { kind: "answer" }>): string {
  if (answer.denyMessage !== undefined) return answer.denyMessage;
  return question.questions.map((item) => answer.answers?.[item.key] ?? "").filter(Boolean).join("\n\n");
}

function citationLines(citations: Citation[]): string {
  return citations.map((citation) => `- ${citation.title} (${citation.sourceId} @ ${citation.revision}${citation.url ? `, ${citation.url}` : ""}): “${citation.quote}”`).join("\n");
}

function deputyAnswerText(question: Extract<LogEntry, { kind: "question" }> | undefined, entry: Extract<LogEntry, { kind: "deputy-answer" }>): string {
  const parts = question?.questions.map((item) => [`Question: ${item.question}`, item.options.length ? `Options: ${item.options.join(" / ")}` : "", `Deputy answered: ${entry.answers[item.key] || "(nothing)"}`].filter(Boolean).join("\n"))
    ?? Object.entries(entry.answers).map(([key, value]) => `${key}: ${value}`);
  return [`Answered automatically by the deputy (${entry.version}); not an owner decision.`, ...parts, "Sources:", citationLines(entry.citations)].join("\n\n");
}

// `commentsFrom`: owner comments before it are left out, since a comment written with the key then
// has no record and cannot be told from the owner's own (see collectWindow).
export async function collectOwnerDecisions(sources: CollectSources, window: { since: string; until: string; commentsFrom?: string }): Promise<Item[]> {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  const inWindow = (at: string) => {
    const time = Date.parse(at);
    return time >= since && time < until;
  };
  const { linear } = sources;
  const entries = await sources.log.entries();
  const questions = new Map(entries.flatMap((entry) => entry.kind === "question" ? [[entry.id, entry] as const] : []));
  const feedback = entries.filter((entry): entry is Extract<LogEntry, { kind: "plan-feedback" }> => entry.kind === "plan-feedback" && inWindow(entry.at));
  // A resolution the deputy caused is not the owner's answer, whatever the daemon reports.
  const deputyAnswers = new Map(entries.flatMap((entry) => entry.kind === "deputy-answer" ? [[entry.id, entry] as const] : []));
  const answers = entries.flatMap((entry) => {
    const question = entry.kind === "answer" && inWindow(entry.at) && !deputyAnswers.has(entry.id) ? questions.get(entry.id) : undefined;
    return entry.kind === "answer" && question ? [{ answer: entry, question }] : [];
  });
  const deputyEntries = entries.filter((entry): entry is Extract<LogEntry, { kind: "deputy-answer" | "deputy-override" }> => (entry.kind === "deputy-answer" || entry.kind === "deputy-override") && inWindow(entry.at));
  const deputyIssue = (entry: { id: string }) => questions.get(entry.id)?.issueId ?? deputyAnswers.get(entry.id)?.issueId ?? null;
  const overrideComments = new Set(deputyEntries.flatMap((entry) => entry.kind === "deputy-override" && entry.via === "linear-comment" ? [entry.key] : []));
  const links = await linear.issueLinks([...feedback.map((entry) => entry.issueId), ...answers.map(({ question }) => question.issueId), ...deputyEntries.flatMap((entry) => deputyIssue(entry) ?? [])]);
  const allowed = (issueId: string) => !sources.excluded.has(issueId);
  const item = (kind: ItemKind, sourceId: string, at: string, link: IssueLink, sourceUrl: string, body: string, words: string): Item =>
    ({ kind, sourceId, at, identifier: link.identifier, ticketUrl: link.url, project: link.project, sourceUrl, text: body, words });

  const planItems: Item[] = [];
  for (const entry of feedback) {
    const link = links.get(entry.issueId);
    if (link && allowed(entry.issueId)) planItems.push(item("plan-feedback", `log:plan-feedback:${entry.id}`, entry.at, link, link.url, `${entry.approved ? "Approved with feedback" : "Sent back"}:\n${entry.text}`, entry.text));
  }
  for (const document of await linear.planDocumentsSince(window.since)) {
    const found = document.issue && inWindow(document.updatedAt) ? documentFeedback(document.content) : null;
    if (found && document.issue && allowed(document.issue.id)) planItems.push(item("plan-feedback", `doc:${document.id}:${document.updatedAt}`, document.updatedAt, document.issue, document.url, `${found.approved ? "Approved with feedback" : "Sent back"}:\n${found.text}`, found.text));
  }
  for (const comment of await linear.planSentBackSince(window.since)) {
    const found = comment.issue && inWindow(comment.createdAt) ? sentBackFeedback(comment.body) : null;
    if (found && comment.issue && allowed(comment.issue.id)) planItems.push(item("plan-feedback", `comment:${comment.id}`, comment.createdAt, comment.issue, comment.url, `Sent back:\n${found}`, found));
  }
  // The same feedback reaches the log, the plan document and a comment (cut at 4,000 characters):
  // kept once, from the fullest source first.
  const kept: Item[] = [];
  for (const candidate of planItems) {
    const body = normalize(candidate.text);
    if (kept.some((known) => known.identifier === candidate.identifier && normalize(known.text).startsWith(body))) continue;
    kept.push(candidate);
  }

  const answerItems = answers.flatMap(({ answer, question }) => {
    const link = links.get(question.issueId);
    return link && allowed(question.issueId) ? [item("answer", `log:answer:${answer.id}`, answer.at, link, link.url, answerText(question, answer), answerWords(question, answer))] : [];
  });
  const deputyItems = deputyEntries.flatMap((entry) => {
    const issueId = deputyIssue(entry);
    const link = issueId ? links.get(issueId) : undefined;
    if (!link || !issueId || !allowed(issueId)) return [];
    if (entry.kind === "deputy-answer") return [item("deputy-answer", `log:deputy-answer:${entry.id}`, entry.at, link, link.url, deputyAnswerText(questions.get(entry.id), entry), "")];
    const answered = deputyAnswers.get(entry.id);
    const body = [`The owner overrode the deputy's answer${answered ? ` (${Object.values(answered.answers).filter(Boolean).join(" / ")})` : ""}:`, entry.text, `Correction ${entry.disposition === "delivered" ? "delivered to the agent" : `not delivered: ${entry.detail ?? "unknown reason"}`}.`, ...(answered ? ["Deputy sources:", citationLines(answered.citations)] : [])].join("\n\n");
    return [item("deputy-override", `log:deputy-override:${entry.id}:${entry.key}`, entry.at, link, link.url, body, entry.text)];
  });

  const owner = await linear.viewerId();
  const commentsFrom = Math.max(since, window.commentsFrom ? Date.parse(window.commentsFrom) : since);
  const commentItems = (await linear.ownerCommentsSince(owner, new Date(commentsFrom).toISOString())).flatMap((comment) => {
    const issue = comment.issue;
    if (!issue || comment.userId !== owner || !inWindow(comment.createdAt) || Date.parse(comment.createdAt) < commentsFrom || sources.recorded.has(comment.id) || overrideComments.has(comment.id) || !allowed(issue.id)) return [];
    if (!sources.agentTickets.has(issue.id) && !(issue.parentId && sources.agentTickets.has(issue.parentId))) return [];
    const answered = issue.title.startsWith("Needs you:") || Boolean(comment.parentBody?.includes("is waiting for"));
    return [item(answered ? "answer" : "comment", `comment:${comment.id}`, comment.createdAt, issue, comment.url, comment.body.trim(), comment.body.trim())];
  }).filter((found) => found.text);

  return [...kept, ...answerItems, ...deputyItems, ...commentItems].sort((a, b) => a.at.localeCompare(b.at) || a.sourceId.localeCompare(b.sourceId));
}

// Tickets that had an agent: a handover record (any agent run) or a "Needs you" sub-issue record.
export async function agentTicketIds(home = paseoHome()): Promise<Set<string>> {
  const ids = new Set<string>();
  const read = async (directory: string) => {
    const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
    return Promise.all(names.map((name) => readFile(join(directory, name), "utf8").then((content) => record(JSON.parse(content)), () => null)));
  };
  for (const entry of await read(join(home, "linear-tickets", "handover"))) if (entry && text(entry.issueId)) ids.add(entry.issueId);
  for (const entry of await read(join(home, "linear-tickets", "needs-you"))) {
    if (entry && text(entry.id)) ids.add(entry.id);
    if (entry && text(entry.parentId)) ids.add(entry.parentId);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// State, window, lock and batches

type State = { coverageFrom?: string; commentsFrom?: string; checkpoint?: string };

async function readState(directory: string): Promise<State> {
  try {
    const value = record(JSON.parse(await readFile(join(directory, "state.json"), "utf8")));
    const kept = (["coverageFrom", "commentsFrom", "checkpoint"] as const).flatMap((field) => text(value[field]) ? [[field, value[field]] as const] : []);
    return Object.fromEntries(kept) as State;
  } catch (error) {
    if (missing(error)) return {};
    throw error;
  }
}

async function saveState(directory: string, state: State): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivate(join(directory, "state.json"), JSON.stringify(state));
}

// The window one `collect` covers: from the last filed batch's end (or a week back) to now, never
// more than 28 days back and never before `coverageFrom`. Both starts are fixed by the first
// collect. `coverageFrom`: a week before it. `commentsFrom`: the oldest comment record then kept
// under `agent-comments/` (`recordsFrom`), or the first collect itself without one; comments
// written with the key before records were kept show the owner as author and have nothing that
// tells them apart, so owner comments count only from there. Plan feedback and the log are not
// affected.
export function collectWindow(state: State, now: number, recordsFrom: string | null = null): { since: string; until: string; coverageFrom: string; commentsFrom: string } {
  const coverageFrom = state.coverageFrom ?? new Date(now - RECORDS_BEFORE_ROLLOUT_MS).toISOString();
  const commentsFrom = state.commentsFrom ?? new Date(Math.min(recordsFrom ? Date.parse(recordsFrom) : now, now)).toISOString();
  const start = Math.max(state.checkpoint ? Date.parse(state.checkpoint) : now - WINDOW_MS, now - MAX_LOOKBACK_MS, Date.parse(coverageFrom));
  return { since: new Date(Math.min(start, now)).toISOString(), until: new Date(now).toISOString(), coverageFrom, commentsFrom };
}

// Who holds the lock and since when (the time its holder wrote, else the file's mtime: a holder
// that died while writing leaves it empty or cut); null once it is gone.
async function lockHolder(path: string): Promise<{ token: string | null; since: number } | null> {
  const content = await readFile(path, "utf8").catch(() => null);
  if (content === null) return null;
  let value: Record<string, unknown> = {};
  try { value = record(JSON.parse(content)); } catch { /* empty or cut: judged by mtime */ }
  const at = text(value.at) ? Date.parse(value.at) : Number.NaN;
  const since = Number.isNaN(at) ? (await stat(path).catch(() => null))?.mtimeMs ?? 0 : at;
  return { token: text(value.token) ? value.token : null, since };
}

// The few milliseconds in which an existing lock is checked and then replaced (takeover) or
// removed (release): `lock.guard`, created exclusively, so no run checks a lock while another
// replaces or removes it. `retries`: how often to try again while another run is in it; false when
// it stayed busy. Only the run that created the guard removes it: removing one a run left behind
// when it died inside could race with a second run doing the same, so an old guard is reported
// and stays until a person removes it. Filesystem times are compared with the real clock.
async function guarded(path: string, work: () => Promise<void>, retries: number): Promise<boolean> {
  const guard = `${path}.guard`;
  for (let attempt = 0; ; attempt++) {
    try {
      await (await open(guard, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt < retries) { await sleep(GUARD_RETRY_MS); continue; }
      const left = await stat(guard).catch(() => null);
      if (left && Date.now() - left.mtimeMs >= LOCK_STALE_MS) throw new Error(`${guard} was left by a decision-candidates run that stopped inside it (${new Date(left.mtimeMs).toISOString()}); remove it once no run is active.`);
      return false;
    }
  }
  try {
    await work();
    return true;
  } finally {
    await rm(guard, { force: true });
  }
}

// One `collect` or `file` at a time. Each acquisition writes its own token, and every check of an
// existing lock that ends in replacing or removing it runs inside `guarded`: a run removes only its
// own lock, and a stale lock (30 minutes) is taken over by one run only.
export async function withLock<T>(directory: string, work: () => Promise<T>, now = () => Date.now()): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "lock");
  const token = randomUUID();
  const busy = (since: number) => new Error(`Another decision-candidates run holds ${path} (since ${new Date(since).toISOString()}).`);
  const take = async () => {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() }));
    } catch (error) {
      await handle.close();
      await rm(path, { force: true });
      throw error;
    }
    await handle.close();
  };
  try {
    await take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stale = await lockHolder(path);
    if (stale && now() - stale.since < LOCK_STALE_MS) throw busy(stale.since);
    let took = false;
    await guarded(path, async () => {
      // Still the same stale lock: another run may have taken it over in between.
      const again = await lockHolder(path);
      if (again && (again.token !== (stale?.token ?? null) || now() - again.since < LOCK_STALE_MS)) return;
      await rm(path, { force: true });
      // A run that found no lock at all may have taken it in this gap.
      try { await take(); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === "EEXIST") return; throw failure; }
      took = true;
    }, 0);
    if (!took) throw busy(stale?.since ?? now());
  }
  try {
    return await work();
  } finally {
    const released = await guarded(path, async () => {
      if ((await lockHolder(path))?.token === token) await rm(path, { force: true });
    }, GUARD_RETRIES).catch((error: unknown) => {
      console.error(`[linear-tickets] decision candidates: ${error instanceof Error ? error.message : error}`);
      return false;
    });
    if (!released) console.error(`[linear-tickets] decision candidates: ${path} could not be released; another run takes it over after 30 minutes.`);
  }
}

export type Batch = { since: string; until: string; commentsFrom?: string; createdAt: string; registerMaxQ: number; items: Item[] };
const batchFile = (directory: string, until: string) => join(directory, "batches", `${until.replace(/[^0-9A-Za-z]/g, "")}.json`);

export async function readBatch(directory: string, until: string): Promise<Batch> {
  const content = await readFile(batchFile(directory, until), "utf8").catch((error: unknown) => {
    if (missing(error)) throw new Error(`No batch ${until}: run \`collect\` first and pass the batch it printed.`);
    throw error;
  });
  return JSON.parse(content) as Batch;
}

// ---------------------------------------------------------------------------------------------
// The principles register (tuchel-platform `docs/principles/`), always as on origin/main

export type Register = { approved: string; decisions: string; queue: string };
const run = promisify(execFile);

export async function readRegister(repository: string): Promise<Register> {
  await run("git", ["-C", repository, "fetch", "--quiet", "origin", "main"], { timeout: 120_000 });
  const show = async (file: string) => (await run("git", ["-C", repository, "show", `origin/main:docs/principles/${file}`], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const [approved, decisions, queue] = await Promise.all([show("approved.md"), show("decisions.md"), show("decision-queue.md")]);
  if (!approved.trim() || !decisions.trim()) throw new Error("The principles register on origin/main is empty.");
  return { approved, decisions, queue };
}

export function highestQ(texts: string[]): number {
  let highest = 0;
  for (const content of texts) for (const match of content.matchAll(/\bQ-(\d+)\b/g)) highest = Math.max(highest, Number(match[1]));
  return highest;
}

// ---------------------------------------------------------------------------------------------
// Candidate tickets

export type Marker = { project: Project; year: number; week: number; run: number };

export function parseMarker(description: string): Marker | null {
  const match = MARKER_LINE.exec(description);
  return match ? { project: match[1] as Project, year: Number(match[2]), week: Number(match[3]), run: Number(match[4] ?? 1) } : null;
}

export function markerLine(marker: Marker): string {
  return `Marker: \`${MARKER} ${marker.project} ${marker.year}-W${String(marker.week).padStart(2, "0")}${marker.run > 1 ? ` run ${marker.run}` : ""}\``;
}

export function keysOf(description: string): string[] {
  return [...description.matchAll(KEY_LINE)].map((match) => match[1]);
}

export function proposalNumbers(description: string): number[] {
  return [...description.matchAll(Q_HEADING)].map((match) => Number(match[1]));
}

// ISO 8601 week of a UTC date: weeks start on Monday; week 1 holds the year's first Thursday.
export function isoWeek(date: Date): { year: number; week: number } {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return { year: day.getUTCFullYear(), week: Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7) };
}

export function candidateTickets(issues: MentioningIssue[]): (MentioningIssue & { marker: Marker })[] {
  return issues.flatMap((issue) => {
    const marker = parseMarker(issue.description);
    return marker ? [{ ...issue, marker }] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Filing

const TYPES = ["principle", "conflict", "exception"] as const;
export type Evidence = { sourceId: string; url: string; quote: string };
export type Candidate = { title: string; type: (typeof TYPES)[number]; wording: string; scope: string; question: string; options: string; recommendation: string; evidence: Evidence[] };
export type FileInput = { projects: { project: Project; candidates: Candidate[] }[] };

// Who decided it, quoted: hash of the project and the (source, quote) pairs. Two decisions quoted
// from one comment differ, a later review round of the same plan document is a new source, and
// a reworded retry of the same decision keeps its key. URLs are citations only.
export function candidateKey(project: Project, evidence: Evidence[]): string {
  const pairs = evidence.map((entry) => `${entry.sourceId}\u0000${normalize(entry.quote)}`).sort();
  return createHash("sha256").update([project, ...pairs].join("\n")).digest("hex").slice(0, 16);
}

export function validateInput(raw: unknown, batch: Batch): { input: FileInput; errors: string[] } {
  const errors: string[] = [];
  const items = new Map(batch.items.map((found) => [found.sourceId, found]));
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (!Array.isArray(value.projects)) return { input: { projects: [] }, errors: ["`projects` must be a list."] };
  const projects: FileInput["projects"] = [];
  value.projects.forEach((entry: unknown, index: number) => {
    const project = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const name = project.project;
    if (!PROJECTS.includes(name as Project)) { errors.push(`projects[${index}]: unknown project ${JSON.stringify(name)} (use ${PROJECTS.map((known) => `"${known}"`).join(" or ")}).`); return; }
    if (!Array.isArray(project.candidates)) { errors.push(`projects[${index}]: \`candidates\` must be a list.`); return; }
    const candidates: Candidate[] = [];
    project.candidates.forEach((raw: unknown, position: number) => {
      const where = `${name} candidate ${position + 1}`;
      const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const fields = ["title", "wording", "scope", "question", "options", "recommendation"] as const;
      for (const field of fields) if (!text(candidate[field]) || !String(candidate[field]).trim()) errors.push(`${where}: \`${field}\` is required.`);
      if (text(candidate.title) && (LINE_BREAK.test(candidate.title) || candidate.title.length > 120)) errors.push(`${where}: \`title\` must be one line of at most 120 characters.`);
      if (!TYPES.includes(candidate.type as Candidate["type"])) errors.push(`${where}: \`type\` must be ${TYPES.join(", ")}.`);
      const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
      if (!evidence.length) errors.push(`${where}: at least one \`evidence\` entry is required.`);
      const cited: Evidence[] = [];
      evidence.forEach((item: unknown, at: number) => {
        const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const source = text(entry.sourceId) ? items.get(entry.sourceId) : undefined;
        if (!source) { errors.push(`${where}, evidence ${at + 1}: \`sourceId\` ${JSON.stringify(entry.sourceId)} is not in batch ${batch.until}.`); return; }
        if (source.kind === "deputy-answer") { errors.push(`${where}, evidence ${at + 1}: ${entry.sourceId} is a deputy answer, not an owner decision; cite the owner's override or another owner source.`); return; }
        if (!text(entry.url) || !/^https:\/\/\S+$/.test(entry.url)) errors.push(`${where}, evidence ${at + 1}: \`url\` must be an https link.`);
        if (!text(entry.quote) || !normalize(entry.quote)) errors.push(`${where}, evidence ${at + 1}: \`quote\` is required.`);
        else if (!normalize(source.words ?? "").includes(normalize(entry.quote))) errors.push(`${where}, evidence ${at + 1}: \`quote\` must be the owner's own words verbatim from ${entry.sourceId} (not the question or options an agent asked).`);
        cited.push({ sourceId: String(entry.sourceId), url: String(entry.url ?? ""), quote: String(entry.quote ?? "") });
      });
      candidates.push({
        title: String(candidate.title ?? "").trim(), type: candidate.type as Candidate["type"], wording: String(candidate.wording ?? "").trim(), scope: String(candidate.scope ?? "").trim(),
        question: String(candidate.question ?? "").trim(), options: String(candidate.options ?? "").trim(), recommendation: String(candidate.recommendation ?? "").trim(), evidence: cited,
      });
    });
    projects.push({ project: name as Project, candidates });
  });
  return { input: { projects }, errors };
}

// The quoted passage as the owner wrote it (line breaks, indentation), found in their words with
// any whitespace between its words; validateInput made sure it is there.
export function verbatim(words: string, quote: string): string {
  const pattern = normalize(quote).split(" ").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return words.match(new RegExp(pattern))?.[0] ?? normalize(quote);
}

function renderCandidate(number: number, key: string, candidate: Candidate, batch: Batch): string {
  const items = new Map(batch.items.map((found) => [found.sourceId, found]));
  // Each quoted line is prefixed, so none of the owner's lines can read as a heading or marker.
  const evidence = candidate.evidence.flatMap((entry) => {
    const source = items.get(entry.sourceId)!;
    const quoted = verbatim(source.words, entry.quote).split(LINE_BREAK).map((line) => line.trimEnd() ? `    > ${line.trimEnd()}` : "    >");
    return [`  - ${source.at.slice(0, 16).replace("T", " ")} UTC, [${source.identifier}](${entry.url}) (${source.kind}):`, ...quoted];
  });
  const oneLine = (value: string) => normalize(value);
  return [
    `## Q-${number} — ${candidate.title}`,
    "",
    `- Key: \`${key}\``,
    `- Type: ${candidate.type}`,
    `- Wording: ${oneLine(candidate.wording)}`,
    `- Scope: ${oneLine(candidate.scope)}`,
    `- Question: ${oneLine(candidate.question)}`,
    `- Options: ${oneLine(candidate.options)}`,
    `- Recommendation: ${oneLine(candidate.recommendation)}`,
    "- Evidence:",
    ...evidence,
    `- Raised: ${batch.until.slice(0, 10)}, weekly decision candidates (owner decisions ${batch.since.slice(0, 10)} to ${batch.until.slice(0, 10)})`,
  ].join("\n");
}

function ticketDescription(project: Project, marker: Marker, blocks: string[]): string {
  const record = project === "ERP"
    ? "Record the answers in **one tuchel-platform pull request** as `docs/principles/README.md` prescribes: one `D-N` in `decisions.md` per answered proposal (source: the answer comment, with the decided wording and scope), a `P-N` in `approved.md` for each approved principle (an `E-N` for an approved exception), and the `Q-N` in `decision-queue.md` for each deferred one. Renumber a `Q-N` that is taken by then. A rejected proposal gets only its `D-N`, so it is not raised again."
    : "Record the answers in the linear-tickets plugin (`Mtuchel/paseo-plugins`, its README and, when the rule is about launches, the launch template): change them as worded for approved and changed proposals. Rejected and deferred proposals stay recorded in this ticket's answer comments, so they are not raised again.";
  return [
    markerLine(marker),
    "",
    `Decision candidates from the owner's decisions outside plans (plan review feedback, answers to agents' questions, comments on tickets an agent worked on), filed by the weekly \`decision-candidates\` run (linear-tickets README, "Decision candidates"). **Nothing here is binding** until the owner answers each proposal.`,
    "",
    "## For the agent working on this ticket",
    "",
    "1. Ask the owner every proposal below in one question request (proposal number, wording, options, recommendation). An approved implementation plan of this ticket is **not** an answer: record a proposal only after the owner answered that proposal.",
    "2. For each answer, post one comment `**Q-<n> answered** — approved | rejected | changed | deferred: <the owner's words>` with the link to the answer (for an answer given in the Paseo app: the quoted text and its time). The ops digest counts proposals without such a comment as waiting.",
    `3. ${record}`,
    "4. Nothing is written to `approved.md` (or any rule) without the owner's answer to that proposal.",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ].join("\n").trimEnd();
}

// `id`: a client-chosen issue id (UUID v4) Linear refuses to create twice (the ops review's
// create reservation, ops-review.ts); decision candidates leave it out.
export type FileWriter = { createIssue(input: { id?: string; teamId: string; projectId: string; stateId: string; title: string; description: string }): Promise<{ id: string; identifier: string; url: string }>; updateDescription(issueId: string, description: string): Promise<void> };
export type OpsWriter = FileWriter & { comment(issueId: string, body: string): Promise<void>; moveToState(issueId: string, stateId: string): Promise<void> };
export type ProjectReport = { project: Project; action: "none" | "created" | "appended"; ticket: string | null; proposals: string[]; skipped: string[] };

// One ticket per project per run at most: candidates whose key any candidate ticket of the project
// already holds (open or closed, any week) are dropped; the rest go into the week's open ticket,
// or a new one when there is none (with a run number when that week's ticket was closed).
// A new ticket goes into the team's Todo (`stateId`), so the project's planner and hand-out take it.
export async function fileCandidates(deps: { batch: Batch; tickets: MentioningIssue[]; teamId: string; stateId: string; projectIds: Record<Project, string>; writer: FileWriter; dryRun: boolean }, input: FileInput): Promise<ProjectReport[]> {
  const { batch } = deps;
  const tickets = candidateTickets(deps.tickets);
  let next = Math.max(batch.registerMaxQ, ...tickets.flatMap((ticket) => proposalNumbers(ticket.description)), 0) + 1;
  const { year, week } = isoWeek(new Date(batch.until));
  const reports: ProjectReport[] = [];
  for (const project of PROJECTS) {
    const candidates = input.projects.filter((entry) => entry.project === project).flatMap((entry) => entry.candidates);
    if (!candidates.length) continue;
    const theirs = tickets.filter((ticket) => ticket.marker.project === project);
    const known = new Set(theirs.flatMap((ticket) => keysOf(ticket.description)));
    const skipped: string[] = [];
    const fresh: { key: string; candidate: Candidate }[] = [];
    for (const candidate of candidates) {
      const key = candidateKey(project, candidate.evidence);
      if (known.has(key)) { skipped.push(`${candidate.title} (already proposed)`); continue; }
      known.add(key);
      fresh.push({ key, candidate });
    }
    if (!fresh.length) { reports.push({ project, action: "none", ticket: null, proposals: [], skipped }); continue; }
    const blocks = fresh.map(({ key, candidate }) => renderCandidate(next++, key, candidate, batch));
    const proposals = blocks.map((block) => block.split("\n")[0].replace(/^## /, ""));
    const sameWeek = theirs.filter((ticket) => ticket.marker.year === year && ticket.marker.week === week);
    const open = sameWeek.find((ticket) => !CLOSED_TYPES.includes(ticket.statusType));
    if (open) {
      if (!deps.dryRun) await deps.writer.updateDescription(open.id, `${open.description.trimEnd()}\n\n${blocks.join("\n\n")}`);
      reports.push({ project, action: "appended", ticket: open.url, proposals, skipped });
      continue;
    }
    const runNumber = sameWeek.length ? Math.max(...sameWeek.map((ticket) => ticket.marker.run)) + 1 : 1;
    const description = ticketDescription(project, { project, year, week, run: runNumber }, blocks);
    const created = deps.dryRun ? null : await deps.writer.createIssue({ teamId: deps.teamId, projectId: deps.projectIds[project], stateId: deps.stateId, title: `Decision candidates, week ${week}`, description });
    reports.push({ project, action: "created", ticket: created?.url ?? null, proposals, skipped });
  }
  return reports;
}

// Writes as the Paseo app and nothing else: the token is read from `agent-app/token.json` and never
// refreshed (only the daemon may rotate it); missing, expiring within 5 minutes or rejected by
// Linear (`force`) it throws, so `AgentApi.mutate` returns null and the write fails instead of
// falling back to the owner's key as LinearService.write would.
export class AppOnlyToken {
  constructor(private readonly directory = agentAppDirectory(), private readonly now = () => Date.now()) {}

  async accessToken(force = false): Promise<string> {
    if (force) throw new Error("Linear rejected the Paseo app token.");
    const token = await readFile(join(this.directory, "token.json"), "utf8").then((content) => record(JSON.parse(content)), () => null);
    if (!token || !text(token.access_token)) throw new Error("The Paseo Linear app is not installed on this host.");
    if (typeof token.expires_at === "number" && token.expires_at - TOKEN_MARGIN_MS <= this.now()) throw new Error("The Paseo app token expires within 5 minutes.");
    return token.access_token;
  }
}

const DESCRIBE_QUERY = `mutation describe($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success } }`;

export class AppWriter implements OpsWriter {
  constructor(private readonly api: Pick<AgentApi, "mutate">) {}

  private async mutate(query: string, variables: Record<string, unknown>, field: string): Promise<Record<string, unknown>> {
    const data = await this.api.mutate(query, variables);
    if (!data) throw new Error("The Paseo app token is missing, about to expire or was rejected; nothing was written (the owner's key is never used here). Retry once the daemon has refreshed it.");
    const result = record(record(data)[field] ?? {});
    if (result.success !== true) throw new Error(`Linear did not accept ${field}.`);
    return result;
  }

  async createIssue(input: { id?: string; teamId: string; projectId: string; stateId: string; title: string; description: string }): Promise<{ id: string; identifier: string; url: string }> {
    const issue = record((await this.mutate(CREATE_ISSUE_QUERY, { input }, "issueCreate")).issue ?? {});
    return { id: String(issue.id ?? ""), identifier: String(issue.identifier ?? ""), url: String(issue.url ?? "") };
  }

  async updateDescription(issueId: string, description: string): Promise<void> {
    await this.mutate(DESCRIBE_QUERY, { id: issueId, description }, "issueUpdate");
  }

  async comment(issueId: string, body: string): Promise<void> {
    await this.mutate(CREATE_COMMENT_QUERY, { input: { issueId, body } }, "commentCreate");
  }

  async moveToState(issueId: string, stateId: string): Promise<void> {
    await this.mutate(UPDATE_ISSUE_STATE_QUERY, { id: issueId, stateId }, "issueUpdate");
  }
}

// ---------------------------------------------------------------------------------------------
// The two commands (scripts/decision-candidates.ts wires them to the real host)

export type CollectRun = {
  directory: string;
  log: Pick<DecisionLog, "entries">;
  linear: CollectReader & Pick<LinearService, "teamIdByKey" | "issuesMentioning">;
  register: () => Promise<Register>;
  recorded: () => Promise<Set<string>>;
  // The oldest comment record kept (agent-records.ts, oldestRecord); read on the first collect only.
  recordsFrom: () => Promise<string | null>;
  agentTickets: () => Promise<Set<string>>;
  ruleSources: string[];
  teamKey: string;
  now: () => number;
};

export async function runCollect(deps: CollectRun): Promise<{ batch: Batch; markdown: string }> {
  return withLock(deps.directory, async () => {
    const register = await deps.register();
    const state = await readState(deps.directory);
    const window = collectWindow(state, deps.now(), state.commentsFrom ? null : await deps.recordsFrom());
    if (!state.coverageFrom || !state.commentsFrom) await saveState(deps.directory, { ...state, coverageFrom: window.coverageFrom, commentsFrom: window.commentsFrom });
    const teamId = await deps.linear.teamIdByKey(deps.teamKey);
    if (!teamId) throw new Error(`Linear has no team ${deps.teamKey}.`);
    const tickets = candidateTickets(await deps.linear.issuesMentioning(teamId, `${MARKER} `));
    const registerTickets = (await deps.linear.issuesMentioning(teamId, "docs/principles", true)).filter((issue) => !parseMarker(issue.description));
    const items = await collectOwnerDecisions({ log: deps.log, linear: deps.linear, recorded: await deps.recorded(), agentTickets: await deps.agentTickets(), excluded: new Set(tickets.map((ticket) => ticket.id)) }, window);
    const batch: Batch = { since: window.since, until: window.until, commentsFrom: window.commentsFrom, createdAt: new Date(deps.now()).toISOString(), registerMaxQ: highestQ([register.approved, register.decisions, register.queue]), items };
    await mkdir(join(deps.directory, "batches"), { recursive: true, mode: 0o700 });
    await writePrivate(batchFile(deps.directory, batch.until), JSON.stringify(batch, null, 2));
    return { batch, markdown: renderCollection(batch, register, tickets, registerTickets, deps.ruleSources) };
  }, deps.now);
}

// A fence longer than any backtick run in the text, so the owner's words print verbatim.
function fenced(body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${body}\n${fence}`;
}

export function renderCollection(batch: Batch, register: Register, tickets: MentioningIssue[], registerTickets: MentioningIssue[], ruleSources: string[]): string {
  const lines = [
    `# Owner decisions ${batch.since} → ${batch.until}`,
    "",
    `Batch: \`${batch.until}\` (pass it to \`file --batch\`). ${batch.items.length} item(s). Highest Q in the register: Q-${batch.registerMaxQ}.`,
    ...(batch.commentsFrom && Date.parse(batch.commentsFrom) > Date.parse(batch.since) ? ["", `Owner comments count from ${batch.commentsFrom} only: earlier comments written with the key have no record that tells them from the owner's.`] : []),
    "",
    "## Items",
    "",
  ];
  const deputyKinds: ItemKind[] = ["deputy-answer", "deputy-override"];
  const ownerItems = batch.items.filter((found) => !deputyKinds.includes(found.kind));
  const deputyItems = batch.items.filter((found) => deputyKinds.includes(found.kind));
  const render = (found: Item) => lines.push(`### ${found.identifier} · ${found.kind} · ${found.at}`, "", `- sourceId: \`${found.sourceId}\``, `- Ticket: ${found.ticketUrl} (project: ${found.project || "none"})`, `- Source: ${found.sourceUrl}`, "", fenced(found.text), "");
  if (!ownerItems.length) lines.push("None in this window.", "");
  ownerItems.forEach(render);
  if (deputyItems.length) {
    lines.push("## Deputy answers and overrides", "", "Review evidence, never decisions: a deputy answer shows which recorded knowledge it relied on; an override is the owner's correction (its words may be quoted). A wrong deputy answer becomes a rule only through a proposal the owner answers.", "");
    deputyItems.forEach(render);
  }
  lines.push("## Earlier candidate tickets (all states)", "");
  if (!tickets.length) lines.push("None yet.", "");
  for (const ticket of tickets) {
    lines.push(`### ${ticket.identifier} — ${ticket.title} (${ticket.status})`, "", ticket.url, "", fenced(ticket.description), "");
    for (const comment of ticket.comments) lines.push(`Comment by ${comment.author || "unknown"} at ${comment.createdAt} (${comment.url}):`, "", fenced(comment.body), "");
  }
  lines.push("## Open tickets that change the register (their decisions may not be in it yet)", "");
  if (!registerTickets.length) lines.push("None.", "");
  for (const ticket of registerTickets) lines.push(`- ${ticket.identifier} (${ticket.status}): ${ticket.title} — ${ticket.url}`);
  lines.push("", "## Agent tooling rules to check", "", ...ruleSources.map((source) => `- ${source}`), "");
  for (const [name, content] of [["approved.md", register.approved], ["decisions.md", register.decisions], ["decision-queue.md", register.queue]] as const) {
    lines.push(`## Register: docs/principles/${name} (origin/main)`, "", fenced(content.trimEnd()), "");
  }
  return lines.join("\n");
}

export type FileRun = {
  directory: string;
  batch: string;
  input: unknown;
  linear: Pick<LinearService, "teamIdByKey" | "todoStateId" | "projectIdByName" | "issuesMentioning">;
  writer: FileWriter;
  teamKey: string;
  dryRun: boolean;
  now: () => number;
};

export class InvalidInput extends Error {
  constructor(readonly errors: string[]) {
    super(`The candidates are invalid; nothing was written:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

export async function runFile(deps: FileRun): Promise<ProjectReport[]> {
  return withLock(deps.directory, async () => {
    const batch = await readBatch(deps.directory, deps.batch);
    const { input, errors } = validateInput(deps.input, batch);
    if (errors.length) throw new InvalidInput(errors);
    const teamId = await deps.linear.teamIdByKey(deps.teamKey);
    if (!teamId) throw new Error(`Linear has no team ${deps.teamKey}.`);
    const stateId = await deps.linear.todoStateId(teamId);
    if (!stateId) throw new Error(`Team ${deps.teamKey} has no unstarted (Todo) state.`);
    const projectIds = {} as Record<Project, string>;
    for (const project of PROJECTS) {
      if (!input.projects.some((entry) => entry.project === project && entry.candidates.length)) continue;
      const id = await deps.linear.projectIdByName(project);
      if (!id) throw new Error(`Linear has no project ${project}.`);
      projectIds[project] = id;
    }
    const tickets = await deps.linear.issuesMentioning(teamId, `${MARKER} `);
    const reports = await fileCandidates({ batch, tickets, teamId, stateId, projectIds, writer: deps.writer, dryRun: deps.dryRun }, input);
    if (!deps.dryRun) {
      // Only after every project went through, and never backwards (an older batch filed late).
      const state = await readState(deps.directory);
      if (!state.checkpoint || Date.parse(state.checkpoint) < Date.parse(batch.until)) await saveState(deps.directory, { ...state, checkpoint: batch.until });
    }
    return reports;
  }, deps.now);
}
