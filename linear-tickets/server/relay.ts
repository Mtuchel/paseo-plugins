import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
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
// `needsYou`: a "Needs you" sub-issue of the agent's ticket; a delivered reply there closes it.
type LinkedAgent = { id: string; issueId: string; createdAt: string; needsYou?: boolean };
type Question = { header?: string; question?: string; options?: { label?: string }[] };

// The message after the mention, or null when the comment is not addressed to Paseo.
export function mentionMessage(body: string): string | null {
  const match = body.match(MENTION);
  if (!match) return null;
  return body.slice(match[0].length).trim();
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

// Linear → agent. On every poll, comments by the key's own user that start with "@paseo" on
// tickets with an active linked agent are delivered to that agent: as the answer to its
// pending question, as an approve/deny decision for a pending approval, or as a new message.
// The agent's reply comes back through turn-summary write-back, so the conversation stays in
// Linear. A 👀 reaction marks a delivered comment and ❌ plus a reply one that could not be
// delivered.
//
// All linked tickets are read in one request (see LinearService.relayComments), each from its own
// cursor: the creation time of the last comment the relay handled, persisted, so a pause of any
// length or a restart loses nothing. The cursor only moves past a comment once it is handled; a
// failed read moves nothing. Reactions are queued (`acks`, persisted with the cursors) and sent
// when the key has room, so a paused key never makes a comment deliver twice.
type Cursor = { agentId: string; since: string; boundaryIds: string[] };
type Ack = { commentId: string; issueId: string; emoji: string; reacted: boolean; reply: string | null };
type RelayState = { cursors: Record<string, Cursor>; acks: Ack[] };

export class CommentRelay {
  private state: RelayState | null = null;
  private saved = "";
  // Tickets neither credential could read (deleted, no access); skipped until the plugin restarts.
  private readonly unseen = new Set<string>();

  // `needsYou`: the open "Needs you" sub-issues, whose replies go to the agent that asked.
  constructor(private readonly linear: Linear, private readonly path = join(paseoHome(), "linear-tickets", "relay-cursors.json"), private readonly needsYou?: NeedsYouIssues) {}

  async poll(paseo: PaseoApi): Promise<void> {
    const state = await this.load();
    await this.acknowledge(state);
    const linked = await this.linkedAgents(paseo);
    for (const entry of await this.needsYou?.all() ?? []) {
      const agent = linked.find((known) => known.id === entry.agentId);
      if (agent) linked.push({ id: agent.id, issueId: entry.id, createdAt: agent.createdAt, needsYou: true });
    }
    const agents = linked.filter((agent) => !this.unseen.has(agent.issueId));
    // A new agent on a ticket starts from its own start: comments before it were in its first prompt.
    const cursors: Record<string, Cursor> = {};
    for (const agent of agents) {
      const known = state.cursors[agent.issueId];
      cursors[agent.issueId] = known?.agentId === agent.id ? known : { agentId: agent.id, since: agent.createdAt, boundaryIds: [] };
    }
    state.cursors = cursors;
    if (agents.length) {
      const viewerId = await this.linear.viewerId();
      // Reactions are written as the Paseo app (or the owner when the app is not usable, and before
      // writes moved to the app): either one marks the comment as handled.
      const appId = await this.linear.appUserId();
      const { comments, unseen } = await this.linear.relayComments(viewerId, agents.map((agent) => ({ issueId: agent.issueId, since: cursors[agent.issueId].since })));
      for (const issueId of unseen) this.unseen.add(issueId);
      for (const agent of agents) {
        const cursor = cursors[agent.issueId];
        for (const comment of comments.get(agent.issueId) ?? []) {
          if (comment.createdAt < cursor.since || (comment.createdAt === cursor.since && cursor.boundaryIds.includes(comment.id))) continue;
          // An @mention of the Paseo app opens (or replies in) an agent session, and the session
          // webhook delivers it; relaying it too would hand the agent the same message twice.
          const handled = comment.userId !== viewerId
            || comment.sessionId !== null
            || comment.reactions.some((reaction) => (reaction.userId === viewerId || (appId !== null && reaction.userId === appId)) && (reaction.emoji === ACK_EMOJI || reaction.emoji === FAILED_EMOJI))
            || state.acks.some((ack) => ack.commentId === comment.id);
          const message = handled ? null : mentionMessage(comment.body);
          if (message !== null) {
            const outcome = await this.deliver(paseo, agent, comment, message);
            state.acks.push({ commentId: comment.id, issueId: agent.issueId, reacted: false, ...outcome });
            if (agent.needsYou && outcome.emoji === ACK_EMOJI && this.needsYou) await closeAnswered(this.needsYou, this.linear, agent.issueId);
          }
          if (comment.createdAt === cursor.since) cursor.boundaryIds.push(comment.id);
          else Object.assign(cursor, { since: comment.createdAt, boundaryIds: [comment.id] });
          // Recorded before the reaction: a restart in between must not deliver the comment again.
          if (message !== null) await this.save(state);
        }
      }
    }
    await this.acknowledge(state);
    await this.save(state);
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
      this.state = { cursors: stored.cursors && typeof stored.cursors === "object" ? stored.cursors : {}, acks: Array.isArray(stored.acks) ? stored.acks : [] };
    } catch {
      this.state = { cursors: {}, acks: [] };
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
