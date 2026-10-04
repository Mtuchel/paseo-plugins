import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { filedIssues, pluginComments, postedComments } from "./agent-records";
import type { LinearService, RelayComment } from "./linear";
import { closeAnswered, type NeedsYouIssues } from "./needs-you";
import { RateLimitedError } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";

// A comment addressed to the agent: "@paseo" first, then the message. Linear may render the
// mention as a link, so a markdown-wrapped "[@paseo](…)" counts too.
const MENTION = /^\s*(?:\[@paseo\]\([^)]*\)|@paseo\b)[:,]?\s*/i;
export const ACK_EMOJI = "eyes";
export const FAILED_EMOJI = "x";

type Linear = Pick<LinearService, "viewerId" | "appUserId" | "relayComments" | "comment" | "react" | "complete">;
type LinkedAgent = { id: string; issueId: string; createdAt: string };
type Question = { header?: string; question?: string; options?: { label?: string }[] };

// The message after the mention, or null when the comment is not addressed to Paseo.
export function mentionMessage(body: string): string | null {
  const match = body.match(MENTION);
  if (!match) return null;
  return body.slice(match[0].length).trim();
}

// A comment is addressed to the agent when it starts with "@paseo" or replies in a thread the
// Paseo app started (its status, question and summary comments): the whole reply is the message.
export function addressedMessage(comment: Pick<RelayComment, "body" | "parent">, appId: string | null): string | null {
  const mentioned = mentionMessage(comment.body);
  if (mentioned !== null) return mentioned;
  return appId !== null && comment.parent?.userId === appId ? comment.body.trim() : null;
}

export function questionsOf(request: AgentPermissionRequest): Question[] {
  const questions = request.input && Array.isArray(request.input.questions) ? request.input.questions : [];
  return questions.filter((item): item is Question => Boolean(item) && typeof item === "object");
}

// Answers a pending question the way the Paseo app does: `answers` keyed by each
// question's header. The message fills the first question, matching an option label
// case-insensitively; later questions (for example omp's optional comment) stay empty.
export function questionKey(item: Question, index: number): string {
  return item.header || item.question || `q${index}`;
}

// The questions that need an answer: optional free-text follow-ups (no options, empty
// answers allowed — omp's "Optional comment") are left empty.
export function answerableQuestions(request: AgentPermissionRequest): { key: string; question: Question }[] {
  return questionsOf(request)
    .map((question, index) => ({ key: questionKey(question, index), question }))
    .filter(({ question }) => (question.options?.length ?? 0) > 0 || !(question as { allowEmpty?: boolean }).allowEmpty);
}

// An answer snaps to an option label (case-insensitive); anything else is free text.
export function matchOption(question: Question, message: string): string {
  return question.options?.find((choice) => choice.label?.trim().toLowerCase() === message.trim().toLowerCase())?.label ?? message;
}

// `given` holds answers already collected for earlier parts; `message` answers the next one.
export function questionAnswer(request: AgentPermissionRequest, message: string, given: Record<string, string> = {}): AgentPermissionResponse {
  const answers: Record<string, string> = {};
  const answerable = answerableQuestions(request);
  const next = answerable.find(({ key }) => given[key] === undefined);
  questionsOf(request).forEach((item, index) => {
    const key = questionKey(item, index);
    answers[key] = given[key] ?? (next?.key === key ? matchOption(item, message) : "");
  });
  return { behavior: "allow", updatedInput: { answers } };
}

// "approve"/"yes" or "deny"/"no" (optionally followed by a reason) for a pending tool or
// plan approval; anything else is not treated as a decision.
export function approvalDecision(message: string): AgentPermissionResponse | null {
  const match = message.match(/^(approve|approved|allow|yes|ok|deny|denied|reject|no)\b[.!:,]?\s*([\s\S]*)$/i);
  if (!match) return null;
  if (/^(approve|approved|allow|yes|ok)$/i.test(match[1])) return { behavior: "allow" };
  return { behavior: "deny", ...(match[2].trim() ? { message: match[2].trim() } : {}) };
}

// Linear → agent. On every poll, the owner's comments on the issues running ticket agents watch are
// delivered to the agent: as the answer to its pending question, as an approve/deny decision for a
// pending approval, or as a new message. The agent's reply comes back through turn-summary
// write-back (or its own comment), so the conversation stays in Linear. A 👀 reaction marks a
// delivered comment and ❌ plus a reply one that could not be delivered.
//
// Watched (README, "Replies from Linear"): the agent's ticket, its "Needs you" sub-issues, the
// issues it filed until they have an agent of their own, and the threads it started on other
// issues. Every owner comment counts on the agent's own issues, and replies in its threads; without
// a usable Paseo app, the plugin's own comments cannot be told from the owner's, so there only
// "@paseo" comments, replies to Paseo comments and replies in the agent's threads count. Comments the agents and the plugin wrote
// themselves (agent-records.ts) never count.
//
// All watched issues are read in one request (see LinearService.relayComments), each from its own
// cursor: the creation time of the last comment the relay handled, persisted, so a pause of any
// length or a restart loses nothing. The cursor only moves past a comment once it is handled; a
// failed read moves nothing. Reactions are queued (`acks`, persisted with the cursors) and sent
// when the key has room, so a paused key never makes a comment deliver twice.
// `agentId`: the issue's primary reader; `threads`: "<comment id>:<agent id>" of its thread readers.
type Cursor = { agentId: string | null; threads?: string[]; since: string; boundaryIds: string[] };
type Ack = { commentId: string; issueId: string; emoji: string; reacted: boolean; reply: string | null };
// `version` 2: cursors also cover plain comments (no "@paseo").
type RelayState = { version?: number; cursors: Record<string, Cursor>; acks: Ack[] };
const STATE_VERSION = 2;

// Who reads an issue's comments, from `start` on (earlier ones predate the agent, or its thread,
// or were in its first prompt).
type Reader = { agent: LinkedAgent; start: string; kind: "ticket" | "needs-you" | "filed" | "thread"; identifier: string | null };
// `primary`: the agent whose issue it is; `threads`: agents that commented on it, by that comment's id.
type Watch = { issueId: string; primary: Reader | null; threads: Map<string, Reader> };

const later = (a: string, b: string) => (a > b ? a : b);
const earliest = (values: string[]) => values.reduce((a, b) => (a < b ? a : b));

// A new primary reader restarts the cursor from the earliest start; a new thread moves it back to
// its start. Each comment still goes only to a reader whose start it does not precede.
function nextCursor(known: Cursor | undefined, watch: Watch): Cursor {
  const agentId = watch.primary?.agent.id ?? null;
  const threads = [...watch.threads].map(([commentId, reader]) => `${commentId}:${reader.agent.id}`);
  const starts = [...(watch.primary ? [watch.primary] : []), ...watch.threads.values()].map((reader) => reader.start);
  if (!known || known.agentId !== agentId) return { agentId, threads, since: earliest(starts), boundaryIds: [] };
  const added = [...watch.threads].filter(([commentId, reader]) => !(known.threads ?? []).includes(`${commentId}:${reader.agent.id}`)).map(([, reader]) => reader.start);
  const since = earliest([known.since, ...added]);
  return { agentId, threads, since, boundaryIds: since === known.since ? known.boundaryIds : [] };
}

// The reader a comment goes to and the message it gets, or null. A reply in an agent's thread goes
// to that agent, anything else to the issue's primary reader. A comment on another issue than the
// agent's ticket names that issue, so the agent knows where the owner wrote.
function routeComment(watch: Watch, comment: RelayComment, plain: boolean, appId: string | null): { reader: Reader; message: string } | null {
  const thread = comment.parent ? watch.threads.get(comment.parent.id) : undefined;
  const reader = thread && comment.createdAt >= thread.start ? thread : watch.primary && comment.createdAt >= watch.primary.start ? watch.primary : null;
  if (!reader) return null;
  const message = reader.kind === "thread" || plain ? mentionMessage(comment.body) ?? comment.body.trim() : addressedMessage(comment, appId);
  if (message === null) return null;
  if (reader.kind === "filed") return message ? { reader, message: `Comment on ${reader.identifier}, the issue you filed: ${message}` } : null;
  if (reader.kind === "thread") return message ? { reader, message: `Reply to your comment on ${reader.identifier ?? "another issue"}: ${message}` } : null;
  return { reader, message };
}

export class CommentRelay {
  private state: RelayState | null = null;
  private saved = "";
  // Issues neither credential could read (deleted, no access); skipped until the plugin restarts.
  private readonly unseen = new Set<string>();
  // The plugin's state directory, where the cursor file and the agents' records live.
  private readonly directory: string;

  // `needsYou`: the open "Needs you" sub-issues, whose replies go to the agent that asked.
  constructor(private readonly linear: Linear, private readonly path = join(paseoHome(), "linear-tickets", "relay-cursors.json"), private readonly needsYou?: NeedsYouIssues) {
    this.directory = dirname(path);
  }

  async poll(paseo: PaseoApi): Promise<void> {
    const state = await this.load();
    await this.acknowledge(state);
    const linked = await this.linkedAgents(paseo);
    const { watches, written } = await this.watches(linked);
    const active = watches.filter((watch) => !this.unseen.has(watch.issueId));
    const cursors: Record<string, Cursor> = {};
    for (const watch of active) cursors[watch.issueId] = nextCursor(state.cursors[watch.issueId], watch);
    state.cursors = cursors;
    if (active.length) {
      const viewerId = await this.linear.viewerId();
      // Reactions are written as the Paseo app (or the owner when the app is not usable, and before
      // writes moved to the app): either one marks the comment as handled.
      const appId = await this.linear.appUserId();
      const plain = appId !== null;
      const { comments, unseen } = await this.linear.relayComments(viewerId, active.map((watch) => ({ issueId: watch.issueId, since: cursors[watch.issueId].since })), plain);
      for (const issueId of unseen) this.unseen.add(issueId);
      for (const watch of active) {
        const cursor = cursors[watch.issueId];
        for (const comment of comments.get(watch.issueId) ?? []) {
          if (comment.createdAt < cursor.since || (comment.createdAt === cursor.since && cursor.boundaryIds.includes(comment.id))) continue;
          // An @mention of the Paseo app opens (or replies in) an agent session, and so does a reply
          // in a session's thread; the session webhook delivers those, and relaying them too would
          // hand the agent the same message twice.
          const handled = comment.userId !== viewerId
            || written.has(comment.id)
            || comment.sessionId !== null
            || comment.parent?.sessionId != null
            || comment.reactions.some((reaction) => (reaction.userId === viewerId || (appId !== null && reaction.userId === appId)) && (reaction.emoji === ACK_EMOJI || reaction.emoji === FAILED_EMOJI))
            || state.acks.some((ack) => ack.commentId === comment.id);
          const route = handled ? null : routeComment(watch, comment, plain, appId);
          if (route) {
            const outcome = await this.deliver(paseo, route.reader.agent, comment, route.message);
            state.acks.push({ commentId: comment.id, issueId: watch.issueId, reacted: false, ...outcome });
            if (route.reader.kind === "needs-you" && outcome.emoji === ACK_EMOJI && this.needsYou) await closeAnswered(this.needsYou, this.linear, watch.issueId);
          }
          if (comment.createdAt === cursor.since) cursor.boundaryIds.push(comment.id);
          else Object.assign(cursor, { since: comment.createdAt, boundaryIds: [comment.id] });
          // Recorded before the reaction: a restart in between must not deliver the comment again.
          if (route) await this.save(state);
        }
      }
    }
    await this.acknowledge(state);
    await this.save(state);
  }

  // The issues the linked agents watch, and the ids of the comments agents and the plugin wrote.
  private async watches(linked: LinkedAgent[]): Promise<{ watches: Watch[]; written: Set<string> }> {
    const byIssue = new Map<string, Watch>();
    const watch = (issueId: string) => {
      const known = byIssue.get(issueId);
      if (known) return known;
      const created: Watch = { issueId, primary: null, threads: new Map() };
      byIssue.set(issueId, created);
      return created;
    };
    for (const agent of linked) watch(agent.issueId).primary = { agent, start: agent.createdAt, kind: "ticket", identifier: null };
    for (const entry of await this.needsYou?.all() ?? []) {
      const agent = linked.find((known) => known.id === entry.agentId);
      if (agent && !byIssue.get(entry.id)?.primary) watch(entry.id).primary = { agent, start: agent.createdAt, kind: "needs-you", identifier: entry.identifier };
    }
    const written = new Set(await pluginComments(this.directory));
    for (const agent of linked) {
      // A filed issue with an agent of its own is that agent's (set above).
      for (const issue of await filedIssues(this.directory, agent.issueId)) {
        const target = watch(issue.id);
        if (!target.primary) target.primary = { agent, start: later(issue.createdAt, agent.createdAt), kind: "filed", identifier: issue.identifier };
      }
      for (const posted of await postedComments(this.directory, agent.issueId)) {
        written.add(posted.id);
        if (posted.issueId !== agent.issueId) watch(posted.issueId).threads.set(posted.id, { agent, start: later(posted.createdAt, agent.createdAt), kind: "thread", identifier: posted.identifier });
      }
    }
    return { watches: [...byIssue.values()], written };
  }

  // Sends the queued reactions (and failure replies). A rate limit or a network failure leaves the
  // rest for the next poll; a reaction Linear refuses (the comment was deleted) is dropped.
  private async acknowledge(state: RelayState): Promise<void> {
    while (state.acks.length) {
      const ack = state.acks[0];
      try {
        if (!ack.reacted) {
          await this.linear.react(ack.commentId, ack.emoji);
          ack.reacted = true;
        }
        if (ack.reply) await this.linear.comment(ack.issueId, ack.reply);
      } catch (error) {
        if (error instanceof RateLimitedError || (error instanceof Error && /Could not reach/.test(error.message))) return;
        console.error(`[linear-tickets] marking comment ${ack.commentId} failed: ${error instanceof Error ? error.message : error}`);
      }
      state.acks.shift();
    }
  }

  private async load(): Promise<RelayState> {
    if (this.state) return this.state;
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8"));
      const cursors: Record<string, Cursor> = stored.cursors && typeof stored.cursors === "object" ? stored.cursors : {};
      // Cursors from before plain comments counted only moved past "@paseo" comments and replies:
      // the owner's earlier plain comments were never messages, so they start from now.
      if (stored.version !== STATE_VERSION) {
        const now = new Date().toISOString();
        for (const cursor of Object.values(cursors)) if (cursor.since < now) Object.assign(cursor, { since: now, boundaryIds: [] });
      }
      this.state = { version: STATE_VERSION, cursors, acks: Array.isArray(stored.acks) ? stored.acks : [] };
    } catch {
      this.state = { version: STATE_VERSION, cursors: {}, acks: [] };
    }
    this.saved = JSON.stringify(this.state);
    return this.state;
  }

  private async save(state: RelayState): Promise<void> {
    const text = JSON.stringify(state);
    if (text === this.saved) return;
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      this.saved = text;
    } finally { await rm(temporary, { force: true }); }
  }

  // The newest active root agent per ticket; older agents on the same ticket stay quiet.
  private async linkedAgents(paseo: PaseoApi): Promise<LinkedAgent[]> {
    const byIssue = new Map<string, LinkedAgent & { updatedAt: string }>();
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) {
        const issueId = agent.labels?.["linear.issueId"];
        if (!issueId || agent.labels?.["paseo.parent-agent-id"]) continue;
        const known = byIssue.get(issueId);
        if (!known || agent.updatedAt > known.updatedAt) byIssue.set(issueId, { id: agent.id, issueId, createdAt: agent.createdAt, updatedAt: agent.updatedAt });
      }
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    return [...byIssue.values()];
  }

  // Hands the comment to the agent; the outcome is the reaction (and, on failure, the reply) to queue.
  private async deliver(paseo: PaseoApi, agent: LinkedAgent, comment: RelayComment, message: string): Promise<{ emoji: string; reply: string | null }> {
    try {
      await deliverToAgent(paseo, agent.id, message);
      return { emoji: ACK_EMOJI, reply: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`[linear-tickets] relaying comment ${comment.id} to agent ${agent.id} failed: ${reason}`);
      return { emoji: FAILED_EMOJI, reply: `Paseo could not deliver that comment to the agent: ${reason}` };
    }
  }
}

// A message from Linear for a running agent: the answer to its pending question, an approve/deny
// decision for a pending approval, or otherwise a new message. Throws the reason, for the person
// who wrote it, when the message cannot be used.
export async function deliverToAgent(paseo: PaseoApi, agentId: string, message: string): Promise<void> {
  const handle = paseo.agents.ref(agentId);
  const refreshed = await handle.refresh();
  const pending = refreshed?.agent.pendingPermissions ?? [];
  const question = pending.find((request) => request.kind === "question");
  const approval = pending.find((request) => request.kind !== "question");
  const decision = approval ? approvalDecision(message) : null;
  if (question) {
    if (!message) throw new Error("The agent is waiting for an answer; write it after @paseo.");
    await handle.respondToPermission({ requestId: question.id, response: questionAnswer(question, message) });
  } else if (approval && decision) {
    await handle.respondToPermission({ requestId: approval.id, response: decision });
  } else if (approval) {
    throw new Error(`The agent is waiting for approval of "${approval.title || approval.name}". Reply "@paseo approve" or "@paseo deny <reason>".`);
  } else {
    if (!message) throw new Error("Write the message after @paseo.");
    await handle.send(message);
  }
}
