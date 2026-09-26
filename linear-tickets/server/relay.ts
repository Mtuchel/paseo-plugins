import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { LinearService, RelayComment } from "./linear";

// A comment addressed to the agent: "@paseo" first, then the message. Linear may render the
// mention as a link, so a markdown-wrapped "[@paseo](…)" counts too.
const MENTION = /^\s*(?:\[@paseo\]\([^)]*\)|@paseo\b)[:,]?\s*/i;
export const ACK_EMOJI = "eyes";
export const FAILED_EMOJI = "x";

type Linear = Pick<LinearService, "viewerId" | "commentsSince" | "comment" | "react">;
type LinkedAgent = { id: string; issueId: string; createdAt: string };
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
// Linear. A 👀 reaction marks a delivered comment — Linear is the record, so a restart never
// delivers twice — and ❌ plus a reply marks one that could not be delivered.
export class CommentRelay {
  constructor(private readonly linear: Linear) {}

  async poll(paseo: PaseoApi): Promise<void> {
    const agents = await this.linkedAgents(paseo);
    if (!agents.length) return;
    const viewerId = await this.linear.viewerId();
    for (const agent of agents) {
      // Comments before the agent started were in its first prompt.
      const comments = await this.linear.commentsSince(agent.issueId, agent.createdAt);
      for (const comment of comments) {
        if (comment.userId !== viewerId) continue;
        if (comment.reactions.some((reaction) => reaction.userId === viewerId && (reaction.emoji === ACK_EMOJI || reaction.emoji === FAILED_EMOJI))) continue;
        const message = mentionMessage(comment.body);
        if (message === null) continue;
        await this.deliver(paseo, agent, comment, message);
      }
    }
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

  private async deliver(paseo: PaseoApi, agent: LinkedAgent, comment: RelayComment, message: string): Promise<void> {
    try {
      const handle = paseo.agents.ref(agent.id);
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
      await this.linear.react(comment.id, ACK_EMOJI);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`[linear-tickets] relaying comment ${comment.id} to agent ${agent.id} failed: ${reason}`);
      await this.linear.react(comment.id, FAILED_EMOJI).catch(() => {});
      await this.linear.comment(agent.issueId, `Paseo could not deliver that comment to the agent: ${reason}`).catch(() => {});
    }
  }
}
