import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { dispatchLabels } from "./dispatch";
import { activeModel } from "./model";
import { questionsOf } from "./relay";
import type { AgentApi } from "./agent-app";
import type { Handover, WaitingPeriod } from "./handover";
import type { IssueState, LinearService } from "./linear";
import type { NeedsYouIssues } from "./needs-you";
import { PLANNING_STATE } from "./plannotator";
import { PLAN_POLICY_LABEL } from "./plan-policy";
import { RateLimitedError } from "./rate-budget";
import type { SessionRouter } from "./sessions";
import type { PluginSettings, Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

export const MAX_SUMMARY_LENGTH = 4_000;
// The workflow state (type started) a ticket waits in while its agent needs the owner.
export const NEEDS_INPUT_STATE = "Needs input";
const NEEDS_YOU_COLOR = "#eb5757";
const CLOSED_TYPES = ["completed", "canceled", "duplicate"];
const MAX_NEEDS_YOU_TITLE = 80;
const TRANSIENT = /HTTP 50\d|Could not reach|timed out|ECONNRESET|fetch failed/i;
const RETRY_DELAYS_MS = [30_000, 120_000];
// Rate-limited write-backs wait for the pool to refill however often it takes, up to this long.
const RATE_LIMIT_GIVE_UP_MS = 6 * 60 * 60 * 1000;
const MIN_RATE_LIMIT_DELAY_MS = 5_000;
const PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];
// `planFirst`: launched plan-first (a ticket you did not write, before its plan is approved).
type Link = { issueId: string; identifier: string; planFirst: boolean };
// Steps that must not repeat when a failed write-back is retried (comments, session activities):
// a retry of the same event skips the steps that already succeeded and gets their earlier result.
export type WritebackContext = { once<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> };
type Work = (link: Link, settings: PluginSettings, context: WritebackContext) => Promise<void>;
type Delivery = { event: string; agent: PluginHookAgent; paseo: PaseoApi; work: Work; seq: number; attempt: number; firstFailureAt: number | null; transientRetries: number };
// A pull request found at the end of a turn, kept on disk until every place links it, so a
// rate limit, a superseding event or a plugin restart cannot lose it.
type OutboxEntry = { agentId: string; agentTitle: string | null; cwd: string; issueId: string; identifier: string; url: string; done: { linear: boolean; session: boolean; handover: boolean } };
// The native Linear agent: the session panel, the durable handover record and comments written
// as the Paseo app. Optional, so ticket write-back keeps working without the Paseo Linear app installed.
export type AgentBridge = {
  sessions: Pick<SessionRouter, "sessionFor" | "say" | "action" | "ask" | "askQuestion" | "link" | "offerResume" | "resumeNow" | "holdIfStopped" | "follow" | "unfollow">;
  handover: Pick<Handover, "read" | "update" | "finish" | "waiting" | "setWaiting">;
  comments?: Pick<AgentApi, "createComment" | "updateComment">;
};
type Linear = Pick<LinearService, "issueState" | "markInProgress" | "moveToStateNamed" | "moveToState" | "comment" | "createComment" | "updateComment" | "addLabel" | "removeLabel" | "linkUrl" | "moveToReview" | "viewerId" | "userUrl" | "createIssue" | "complete">;

// The turn's reply: assistant text after the last user message. Streaming providers may
// split one reply across several items, so the pieces are joined without separators.
// The final answer is the text after the turn's last tool call; earlier text is narration
// between tools. Some providers repeat the final message once complete, so a piece equal to
// the previous one is dropped.
export function turnReply(timeline: Timeline): string {
  let reply = "";
  let previous = "";
  for (const item of timeline) {
    if (item.type === "user_message" || item.type === "tool_call") { reply = ""; previous = ""; }
    else if (item.type === "assistant_message") {
      if (item.text.trim() && item.text.trim() === previous.trim()) continue;
      reply += item.text;
      previous = item.text;
    }
  }
  return reply.trim();
}

// Pull request URLs printed by completed shell commands during this turn (for example
// `gh pr create`). Tool inputs, file writes and prose are ignored — they routinely quote the
// ticket or other PRs — and only items after the last user message count, so earlier turns
// are not re-linked on every turn.
export function turnPullRequests(timeline: Timeline): string[] {
  let start = 0;
  timeline.forEach((item, index) => { if (item.type === "user_message") start = index + 1; });
  const urls = new Set<string>();
  for (const item of timeline.slice(start)) {
    if (item.type !== "tool_call" || item.status !== "completed" || item.detail.type !== "shell" || !item.detail.output) continue;
    for (const match of item.detail.output.matchAll(PULL_REQUEST_URL)) urls.add(match[0]);
  }
  return [...urls];
}

// Shell commands the agent completed this turn, newest last, for the session's action log.
export function turnCommands(timeline: Timeline, limit = 5): string[] {
  let start = 0;
  timeline.forEach((item, index) => { if (item.type === "user_message") start = index + 1; });
  const commands: string[] = [];
  for (const item of timeline.slice(start)) {
    if (item.type === "tool_call" && item.status === "completed" && item.detail.type === "shell" && item.detail.command) commands.push(item.detail.command.slice(0, 200));
  }
  return commands.slice(-limit);
}

export function truncateSummary(text: string): string {
  return text.length <= MAX_SUMMARY_LENGTH ? text : `${text.slice(0, MAX_SUMMARY_LENGTH).trimEnd()}\n\n… (truncated; the full reply is in Paseo)`;
}

// How far back from the end of a turn's reply a request to the owner is looked for.
const OWNER_REQUEST_WINDOW = 1_200;
// The agent hands the next step to the owner in its final reply instead of a question request:
// a sentence ending in a question mark, or a phrase that waits for the owner's answer or action.
const OWNER_REQUEST = new RegExp([
  String.raw`[^\s?]\?(?=\s|$|[)*_"”'’])`,
  String.raw`\bneed(?:s|ing)?\s+your\s+(?:ok|okay|yes|go-ahead|approval|decisions?|answers?|input|confirmation|authori[sz]ation)\b`,
  String.raw`\bwait(?:s|ing)?\s+(?:for|on)\s+your\s+(?:ok|okay|yes|go-ahead|approval|decisions?|answers?|input|reply|confirmation)\b`,
  String.raw`\b(?:after|once|when)\s+you\s+(?:answer|decide|confirm|reply|approve|say\s+go)\b`,
  String.raw`\bafter\s+your\s+(?:answer|decision|reply|ok|okay|go-ahead)\b`,
  String.raw`\bif\s+you\s+say\s+go\b`,
  String.raw`\b(?:for\s+you\s+to\s+decide|decisions?\s+for\s+you|please\s+decide)\b`,
  String.raw`\bonly\s+you\s+can\b`,
  String.raw`\byours\s+to\s+authori[sz]e\b`,
  String.raw`\b(?:reply|say)\s+["“][^"”\n]{1,40}["”]\s+and\s+I(?:'|’)ll\b`,
  String.raw`\btell\s+me\s+(?:when|once|whether|which|if)\b[^.?!\n]*\band\s+I(?:'|’)ll\b`,
].join("|"), "i");
// Plan approval has its own flow (Planning, Plannotator) and never means Needs input.
const PLAN_REVIEW = /\bplannotator\b|\b(?:approve|annotate)\b[^.\n]{0,60}\bplan\b/i;

// Code, commands and links are not questions to the owner (`?q=`, `a ? b : c`).
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, "code").replace(/https?:\/\/\S+/g, "link");

// Paragraphs of a reply; a fenced code block with blank lines in it stays one paragraph.
function paragraphs(text: string): string[] {
  const result: string[] = [];
  for (const piece of text.split(/\n\s*\n/)) {
    const last = result.at(-1);
    if (last !== undefined && (last.match(/```/g)?.length ?? 0) % 2 === 1) result[result.length - 1] = `${last}\n\n${piece}`;
    else result.push(piece);
  }
  return result;
}

// The part of a turn's final reply that asks the owner for an answer, decision, approval or
// action (from the first asking paragraph near the end), or null when the agent is not waiting
// on the owner. Plan approval requests are left to the plan review.
export function ownerRequest(reply: string): string | null {
  const all = paragraphs(reply.trim());
  let start = all.length;
  for (let length = 0; start > 0 && length < OWNER_REQUEST_WINDOW;) length += all[--start].length;
  const window = all.slice(start);
  if (PLAN_REVIEW.test(prose(window.join("\n\n")))) return null;
  const first = window.findIndex((paragraph) => OWNER_REQUEST.test(prose(paragraph)));
  return first === -1 ? null : window.slice(first).join("\n\n");
}

// Written as the Paseo app when it is installed: the plugin's key belongs to the owner, and Linear
// notifies nobody of their own mentions. `commentId` edits that comment instead of posting a new one.
// A rate limit is rethrown, never retried on the other credential: its pool must not absorb the load.
export async function appComment(linear: Pick<LinearService, "createComment" | "updateComment">, app: Pick<AgentApi, "createComment" | "updateComment"> | undefined, issueId: string, body: string, commentId: string | null = null): Promise<string> {
  if (commentId) {
    for (const author of app ? [app, linear] : [linear]) {
      const edited = await author.updateComment(commentId, body).then(() => true, (error: unknown) => {
        if (error instanceof RateLimitedError) throw error;
        return false;
      });
      if (edited) return commentId;
    }
  }
  if (app) {
    const id = await app.createComment(issueId, body).catch((error: unknown) => {
      if (error instanceof RateLimitedError) throw error;
      console.error(`[linear-tickets] ${issueId}: comment as the Paseo app failed, posting with the plugin's key: ${error instanceof Error ? error.message : error}`);
      return null;
    });
    if (id) return id;
  }
  return linear.createComment(issueId, body);
}

// Writes the lifecycle of ticket-linked agents back to their Linear ticket. Agents are
// linked by the `linear.issueId` label every launch (manual or dispatched) sets. Only
// root agents report; subagents work on behalf of their parent. Every write is
// best-effort: a Linear failure is logged and never affects the agent.
export class Writeback {
  private readonly links = new Map<string, Link | null>();
  private readonly started = new Set<string>();
  // Last model shown per agent; a change (another model picked in Paseo, or Plannotator restoring
  // its pre-planning model on approval) is announced in the panel and the progress comment.
  private readonly models = new Map<string, string>();
  // Waiting periods by issue when there is no handover record to keep them (no Linear app).
  private readonly waitingPeriods = new Map<string, WaitingPeriod>();
  // Per-issue queue for the waiting signals: a quick follow-up question must edit the first
  // question's comment, not race it into a second one.
  private readonly waitingQueue = new Map<string, Promise<unknown>>();
  // Newest event per agent: a retry older than it is superseded and must not overwrite newer state.
  private readonly latest = new Map<string, number>();
  // Steps already done per (agent, event sequence), until that event's write-back ends.
  private readonly ledgers = new Map<string, Map<string, unknown>>();
  // The one scheduled retry per (agent, event kind).
  private readonly pending = new Map<string, { seq: number; timer: NodeJS.Timeout }>();
  private outboxQueue: Promise<unknown> = Promise.resolve();
  private drainQueue: Promise<unknown> = Promise.resolve();
  private recovered = false;

  // `needsYou`: where waits on closed tickets keep their sub-issues; without it such a wait only
  // labels and comments on the closed ticket.
  constructor(private readonly linear: Linear, private readonly settings: Pick<Settings, "read">, private readonly agentBridge?: AgentBridge, private readonly settleMs = 2_000, private readonly outboxPath = join(paseoHome(), "linear-tickets", "writeback-outbox.json"), private readonly needsYou?: NeedsYouIssues) {}

  // The running model, and the agent with its title: hook events can carry none.
  private async snapshot(agent: PluginHookAgent, paseo: PaseoApi): Promise<{ model: string | null; named: PluginHookAgent }> {
    const current = (await paseo.agents.ref(agent.id).refresh().catch(() => null))?.agent;
    return { model: activeModel(current), named: { ...agent, title: agent.title ?? current?.title ?? null } };
  }

  // Session activities are best-effort on their own: a panel failure must not skip comments.
  // `strict` lets a rate limit through, for callers that keep the activity to retry it.
  private async session(agentId: string, work: (sessionId: string, sessions: AgentBridge["sessions"]) => Promise<void>, strict = false): Promise<void> {
    const sessions = this.agentBridge?.sessions;
    if (!sessions) return;
    try {
      const link = await sessions.sessionFor(agentId);
      if (link) await work(link.sessionId, sessions);
    } catch (error) {
      if (strict && error instanceof RateLimitedError) throw error;
      console.error(`[linear-tickets] agent session update for ${agentId} failed:`, error instanceof Error ? error.message : error);
    }
  }

  private async readOutbox(): Promise<OutboxEntry[]> {
    try {
      const entries: unknown = JSON.parse(await readFile(this.outboxPath, "utf8"));
      return Array.isArray(entries) ? entries as OutboxEntry[] : [];
    } catch { return []; }
  }

  private changeOutbox(change: (entries: OutboxEntry[]) => OutboxEntry[]): Promise<void> {
    const run = async () => {
      const entries = change(await this.readOutbox());
      await mkdir(join(this.outboxPath, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${this.outboxPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.outboxPath);
      } finally { await rm(temporary, { force: true }); }
    };
    const result = this.outboxQueue.then(run, run);
    this.outboxQueue = result.catch(() => undefined);
    return result;
  }

  private markDelivered(entry: OutboxEntry, place: keyof OutboxEntry["done"]): Promise<void> {
    entry.done[place] = true;
    return this.changeOutbox((entries) => entries.flatMap((known) => {
      if (known.agentId !== entry.agentId || known.url !== entry.url) return [known];
      const done = { ...known.done, [place]: true };
      return done.linear && done.session && done.handover ? [] : [{ ...known, done }];
    }));
  }

  // Links one pull request everywhere it is not linked yet; each place is recorded once done.
  private async deliver(entry: OutboxEntry): Promise<void> {
    if (!entry.done.linear) {
      await this.linear.linkUrl(entry.issueId, entry.url, "Pull request");
      await this.markDelivered(entry, "linear");
    }
    if (!entry.done.session) {
      await this.session(entry.agentId, (sessionId, sessions) => sessions.link(sessionId, "Pull request", entry.url), true);
      await this.markDelivered(entry, "session");
    }
    if (!entry.done.handover) {
      const handover = this.agentBridge?.handover;
      // A successor already owns the ticket's record: the old agent must not take it back.
      const record = handover ? await handover.read(entry.issueId) : null;
      if (handover && (!record || record.agentId === entry.agentId)) {
        await handover.update({ id: entry.issueId, identifier: entry.identifier }, { id: entry.agentId, title: entry.agentTitle, cwd: entry.cwd }, { link: ["Pull request", entry.url] });
      }
      await this.markDelivered(entry, "handover");
    }
  }

  // One agent's pending pull requests (failures propagate), or everyone's (failures are logged).
  private drainOutbox(agentId?: string): Promise<void> {
    const run = async () => {
      for (const entry of await this.readOutbox()) {
        if (agentId === undefined) {
          await this.deliver(entry).catch((error: unknown) => console.error(`[linear-tickets] linking ${entry.url} to ${entry.identifier} failed, kept for later: ${error instanceof Error ? error.message : error}`));
        } else if (entry.agentId === agentId) await this.deliver(entry);
      }
    };
    const result = this.drainQueue.then(run, run);
    this.drainQueue = result.catch(() => undefined);
    return result;
  }

  private async link(agent: PluginHookAgent, paseo: PaseoApi): Promise<Link | null> {
    if (agent.parentAgentId) return null;
    const known = this.links.get(agent.id);
    if (known !== undefined) return known;
    const refreshed = await paseo.agents.ref(agent.id).refresh();
    const labels = refreshed?.agent.labels ?? {};
    const issueId = labels["linear.issueId"];
    const link = issueId ? { issueId, identifier: labels["linear.identifier"] || issueId, planFirst: labels[PLAN_POLICY_LABEL] === "required" } : null;
    this.links.set(agent.id, link);
    return link;
  }

  private serialize(issueId: string, work: () => Promise<void>): Promise<void> {
    const result = (this.waitingQueue.get(issueId) ?? Promise.resolve()).then(work, work);
    this.waitingQueue.set(issueId, result.catch(() => undefined));
    return result;
  }

  private async waitingFor(issueId: string): Promise<WaitingPeriod | null> {
    const handover = this.agentBridge?.handover;
    return handover ? handover.waiting(issueId) : this.waitingPeriods.get(issueId) ?? null;
  }

  private async setWaiting(issue: { id: string; identifier: string }, agent: PluginHookAgent, waiting: WaitingPeriod | null): Promise<void> {
    const handover = this.agentBridge?.handover;
    if (handover) await handover.setWaiting(issue, agent, waiting);
    else if (waiting) this.waitingPeriods.set(issue.id, waiting);
    else this.waitingPeriods.delete(issue.id);
  }

  // Opens or continues a waiting period: the ticket moves to Needs input (teams without that state
  // skip it), gets the needs-you label, and one comment mentions the owner, edited per question.
  // A closed ticket stays closed: a "Needs you" sub-issue in Needs input carries the label and the
  // comment instead. `subject` (one line) titles that sub-issue.
  private markWaiting(issue: { id: string; identifier: string }, agent: PluginHookAgent, settings: PluginSettings, subject: string, body: string, inSession: boolean, { once }: WritebackContext): Promise<void> {
    return this.serialize(issue.id, async () => {
      const waiting = await this.waitingFor(issue.id);
      const state = await this.linear.issueState(issue.id);
      const needsYou = dispatchLabels(settings.dispatch.label).needsYou;
      // Only the owner opens Linear sessions; without one, whoever wrote the ticket is asked.
      const ownerId = (inSession ? null : state.creatorId) ?? await this.linear.viewerId();
      const closed = CLOSED_TYPES.includes(state.statusType.trim().toLowerCase());
      let subIssueId = waiting?.subIssueId ?? null;
      let previousStateId = waiting?.previousStateId ?? null;
      if (!subIssueId && closed && this.needsYou && state.teamId) {
        // The agent's sub-issue from an earlier wait, while still open, takes the new one too.
        for (const known of (await this.needsYou.all()).filter((entry) => entry.parentId === issue.id && entry.agentId === agent.id)) {
          // A deleted sub-issue is gone; outages and rate limits retry the whole write-back.
          const found = subIssueId ? null : await this.linear.issueState(known.id).catch((error: unknown) => {
            if (error instanceof RateLimitedError || (error instanceof Error && TRANSIENT.test(error.message))) throw error;
            return null;
          });
          const open = Boolean(found && !CLOSED_TYPES.includes(found.statusType.trim().toLowerCase()));
          if (open) subIssueId = known.id;
          else await this.needsYou.remove(known.id);
        }
        if (!subIssueId) {
          // Plain text: bold and code marks, and a leading heading, quote or list marker, go.
          const title = subject.split("\n")[0].replace(/[*`]+/g, "").replace(/^\s*(?:#+|>|[-+]|\d+\.)\s+/, "").trim();
          const created = await once("needs-you-issue", () => this.linear.createIssue({
            teamId: state.teamId!,
            parentId: issue.id,
            assigneeId: ownerId,
            startedState: NEEDS_INPUT_STATE,
            ready: true,
            title: `Needs you: ${title.length <= MAX_NEEDS_YOU_TITLE ? title : `${title.slice(0, MAX_NEEDS_YOU_TITLE - 1).trimEnd()}…`}`,
            description: `${body}\n\n${issue.identifier} was already closed when its agent asked, so the wait is tracked here. A reply starting with “@paseo” goes to the agent and closes this issue; otherwise close it once handled.`,
          }));
          if (!created) return;
          subIssueId = created.id;
          // Remembered before anything else can fail, so a retry continues this sub-issue.
          await this.setWaiting(issue, agent, { previousStateId, commentId: null, subIssueId });
          await this.needsYou?.add({ id: created.id, identifier: created.identifier, parentId: issue.id, agentId: agent.id });
          await once("needs-you-label", () => this.linear.addLabel(created.id, needsYou, NEEDS_YOU_COLOR));
        }
      }
      if (!subIssueId) {
        const moved = await this.linear.moveToStateNamed(issue.id, NEEDS_INPUT_STATE, state);
        // Remembered before anything else can fail, so a retry still knows where the ticket was.
        previousStateId ??= moved.changed ? state.statusId : null;
        if (previousStateId !== (waiting?.previousStateId ?? null)) await this.setWaiting(issue, agent, { previousStateId, commentId: waiting?.commentId ?? null });
        if (!state.labels.some((item) => item.name.trim().toLowerCase() === needsYou.toLowerCase())) await this.linear.addLabel(issue.id, needsYou, NEEDS_YOU_COLOR);
      }
      // The waiting period's comment is edited, not repeated.
      const commentId = await once("waiting-comment", async () => appComment(this.linear, this.agentBridge?.comments, subIssueId ?? issue.id, `${await this.linear.userUrl(ownerId)} ${body}`, waiting?.commentId ?? null)) ?? null;
      await this.setWaiting(issue, agent, { previousStateId, commentId, subIssueId });
    });
  }

  // Ends the waiting period: the label comes off and the ticket goes back where it was, unless
  // someone moved it out of Needs input meanwhile. The next period gets a fresh comment. A "Needs
  // you" sub-issue is closed only when `answered` (the question or approval was resolved); a wait
  // that ended otherwise may be a manual step, which the owner closes.
  private clearWaiting(issue: { id: string; identifier: string }, agent: PluginHookAgent, settings: PluginSettings, current?: IssueState, answered = false): Promise<void> {
    return this.serialize(issue.id, async () => {
      const waiting = await this.waitingFor(issue.id);
      const state = current ?? await this.linear.issueState(issue.id);
      await this.linear.removeLabel(issue.id, dispatchLabels(settings.dispatch.label).needsYou, state.labels);
      if (waiting?.previousStateId && state.status.trim().toLowerCase() === NEEDS_INPUT_STATE.toLowerCase()) await this.linear.moveToState(issue.id, waiting.previousStateId);
      if (waiting?.subIssueId && answered) {
        await this.linear.complete(waiting.subIssueId);
        await this.needsYou?.remove(waiting.subIssueId);
      }
      if (waiting) await this.setWaiting(issue, agent, null);
    });
  }

  // Each event takes the agent's next sequence number; a newer event of the same kind cancels the
  // older one's scheduled retry (its pull requests are safe in the outbox).
  private run(event: string, agent: PluginHookAgent, paseo: PaseoApi, work: Work): Promise<void> {
    const seq = (this.latest.get(agent.id) ?? 0) + 1;
    this.latest.set(agent.id, seq);
    const older = this.pending.get(`${agent.id}\n${event}`);
    if (older) {
      clearTimeout(older.timer);
      this.pending.delete(`${agent.id}\n${event}`);
      this.ledgers.delete(`${agent.id}\n${older.seq}`);
      console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} superseded by a newer event`);
    }
    return this.attempt({ event, agent, paseo, work, seq, attempt: 0, firstFailureAt: null, transientRetries: 0 });
  }

  private async attempt(delivery: Delivery): Promise<void> {
    const { event, agent, paseo, work, seq } = delivery;
    const ledgerKey = `${agent.id}\n${seq}`;
    try {
      // Pull requests left over from before a restart.
      if (!this.recovered) {
        this.recovered = true;
        await this.drainOutbox();
      }
      // A retry that a newer event overtook only links its pull requests; its state is stale.
      if (delivery.attempt > 0 && (this.latest.get(agent.id) ?? 0) > seq) {
        await this.drainOutbox(agent.id);
        console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} superseded by a newer event`);
        this.ledgers.delete(ledgerKey);
        return;
      }
      const link = await this.link(agent, paseo);
      if (link) {
        let ledger = this.ledgers.get(ledgerKey);
        if (!ledger) this.ledgers.set(ledgerKey, ledger = new Map());
        const steps = ledger;
        await work(link, await this.settings.read(), {
          once: async <T>(step: string, fn: () => Promise<T>) => {
            if (steps.has(step)) return steps.get(step) as T;
            const value = await fn();
            steps.set(step, value);
            return value;
          },
        });
      }
      this.ledgers.delete(ledgerKey);
    } catch (error) {
      if (!this.retry(delivery, error)) this.ledgers.delete(ledgerKey);
    }
  }

  // Rate limits are retried once Linear's pool refills, for up to 6 h; other outages (HTTP 503,
  // network drops) after 30 s and 2 min. Returns whether a retry is scheduled.
  private retry(delivery: Delivery, error: unknown): boolean {
    const { event, agent, seq } = delivery;
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    const firstFailureAt = delivery.firstFailureAt ?? now;
    let transientRetries = delivery.transientRetries;
    let delay: number | undefined;
    if (error instanceof RateLimitedError) {
      if (now - firstFailureAt >= RATE_LIMIT_GIVE_UP_MS) {
        console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} gave up after 6 h of Linear rate limits`);
        return false;
      }
      delay = Math.max(error.resumeAt - now, MIN_RATE_LIMIT_DELAY_MS);
    } else if (TRANSIENT.test(message)) {
      delay = RETRY_DELAYS_MS[transientRetries++];
    }
    if (delay === undefined) {
      console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} failed:`, message);
      return false;
    }
    const key = `${agent.id}\n${event}`;
    const other = this.pending.get(key);
    if (other && other.seq > seq) {
      console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} superseded by a newer event`);
      return false;
    }
    if (other) {
      clearTimeout(other.timer);
      this.ledgers.delete(`${agent.id}\n${other.seq}`);
    }
    console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} failed, retrying in ${Math.round(delay / 1000)} s: ${message}`);
    const timer = setTimeout(() => {
      if (this.pending.get(key)?.timer === timer) this.pending.delete(key);
      void this.attempt({ ...delivery, attempt: delivery.attempt + 1, firstFailureAt, transientRetries });
    }, delay);
    timer.unref?.();
    this.pending.set(key, { seq, timer });
    return true;
  }

  turnStarted({ agent }: PluginLifecycleEvents["agent.turn_started"], paseo: PaseoApi): Promise<void> {
    return this.run("turn_started", agent, paseo, async ({ issueId, identifier, planFirst }, settings, { once }) => {
      const sessions = this.agentBridge?.sessions;
      if (sessions && await sessions.holdIfStopped(agent.id).catch(() => false)) return;
      const { model, named } = await this.snapshot(agent, paseo);
      const previous = this.models.get(agent.id);
      if (model) this.models.set(agent.id, model);
      const changed = Boolean(model && previous && model !== previous);
      await once("session:working", () => this.session(agent.id, async (sessionId, live) => {
        if (changed) await live.say(sessionId, "thought", `Model changed: ${previous} → ${model}`);
        await live.say(sessionId, "thought", model ? `Working… (${model})` : "Working…", true);
        await live.follow(agent.id);
      }));
      const handover = this.agentBridge?.handover;
      if (model && (changed || !previous) && handover && settings.writeback.summaries) {
        await handover.update({ id: issueId, identifier }, named, { model }).catch(() => {});
      }
      // The agent works again, so a wait it ended its last turn with is over.
      if (settings.writeback.blocked && await this.waitingFor(issueId)) await this.clearWaiting({ id: issueId, identifier }, agent, settings);
      if (!settings.writeback.status || this.started.has(agent.id)) return;
      this.started.add(agent.id);
      const state = await this.linear.issueState(issueId);
      // A closed ticket stays closed: its agent still working after the merge (a deploy watch, a
      // step after merge) is often first seen after a plugin restart, and is not new work.
      if (CLOSED_TYPES.includes(state.statusType.trim().toLowerCase())) return;
      // A plan-first agent only plans: its ticket goes to Planning, not In Progress. A ticket
      // already started (for example after the plan was approved) is left where it is.
      const outcome = !planFirst ? await this.linear.markInProgress(state, state.teamId)
        : state.statusType.trim().toLowerCase() === "started" ? { changed: false } : await this.linear.moveToStateNamed(issueId, PLANNING_STATE);
      if (outcome.note) console.error(`[linear-tickets] ${issueId}: ${outcome.note}`);
    });
  }

  turnEnded({ agent, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"], paseo: PaseoApi): Promise<void> {
    return this.run("turn_ended", agent, paseo, async ({ issueId, identifier }, settings, context) => {
      const { once } = context;
      const { writeback } = settings;
      const { model, named } = await this.snapshot(agent, paseo);
      if (model) this.models.set(agent.id, model);
      // Recorded before any Linear call, so a failure below cannot lose the turn's pull requests.
      const urls = writeback.pullRequests ? turnPullRequests(timeline) : [];
      if (urls.length) {
        const added = urls.map((url): OutboxEntry => ({ agentId: agent.id, agentTitle: named.title, cwd: agent.cwd, issueId, identifier, url, done: { linear: false, session: false, handover: false } }));
        await once("outbox", () => this.changeOutbox((entries) => [...entries, ...added.filter((entry) => !entries.some((known) => known.agentId === entry.agentId && known.url === entry.url))]));
      }
      const blocked = dispatchLabels(settings.dispatch.label).blocked;
      const state = writeback.blocked ? await this.linear.issueState(issueId) : null;
      const reply = outcome.kind === "completed" ? turnReply(timeline) : "";
      // A reply that asks the owner keeps (or opens) the waiting period until the next turn starts;
      // otherwise the turn is over and nothing waits for the owner. `paseo-blocked` marks errors only.
      const request = state ? ownerRequest(reply) : null;
      if (state && !request) await this.clearWaiting({ id: issueId, identifier }, agent, settings, state);
      const title = agent.title ?? "Paseo agent";
      const handover = this.agentBridge?.handover;
      const issue = { id: issueId, identifier };
      if (outcome.kind === "completed") {
        await once("session:response", () => this.session(agent.id, async (sessionId, sessions) => {
          // The live feed already showed the commands; otherwise post the turn's last few.
          if (!await sessions.unfollow(agent.id)) for (const command of turnCommands(timeline)) await sessions.action(sessionId, "Ran", command);
          if (reply) await sessions.say(sessionId, "response", truncateSummary(reply));
        }));
        // With the handover record, turns update one progress comment instead of adding comments.
        if (writeback.summaries && reply) {
          if (handover) await handover.update(issue, named, { status: "working", summary: reply, model });
          else await once("comment", () => this.linear.comment(issueId, `**${title}** (Paseo) finished a turn:\n\n${truncateSummary(reply)}`));
        }
        if (state) await this.linear.removeLabel(issueId, blocked, state.labels);
        if (request) {
          const inSession = Boolean(await this.agentBridge?.sessions.sessionFor(agent.id).catch(() => null));
          const hint = writeback.mentions ? "\n\nReply here with “@paseo <your answer>”." : "";
          await this.markWaiting(issue, agent, settings, request, `**${title}** (Paseo) finished its turn and is waiting for you:\n\n${truncateSummary(request)}${hint}`, inSession, context);
        }
      } else if (outcome.kind === "failed") {
        await once("session:error", () => this.session(agent.id, async (sessionId, sessions) => {
          await sessions.unfollow(agent.id);
          await sessions.say(sessionId, "error", `The agent stopped with an error: ${outcome.error.message}`);
        }));
        if (handover) await once("finish", () => handover.finish(issue, named, "failed", outcome.error.message.slice(0, 500), model));
        else if (writeback.summaries || writeback.blocked) await once("comment", () => this.linear.comment(issueId, `**${title}** (Paseo) stopped with an error: ${outcome.error.message}`));
        if (writeback.blocked) await this.linear.addLabel(issueId, blocked);
        await once("session:resume", () => this.session(agent.id, async (sessionId, sessions) => {
          if (!writeback.autoResume || !await sessions.resumeNow(sessionId)) await sessions.offerResume(sessionId);
        }));
      }
      if (outcome.kind === "canceled") await this.session(agent.id, async (_sessionId, sessions) => { await sessions.unfollow(agent.id); });
      if (!urls.length) return;
      await this.drainOutbox(agent.id);
      const moved = await this.linear.moveToReview(issueId);
      if (moved.note) console.error(`[linear-tickets] ${issueId}: ${moved.note}`);
    });
  }

  permissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"], paseo: PaseoApi): Promise<void> {
    return this.run("permission_requested", agent, paseo, async ({ issueId, identifier }, settings, context) => {
      // Providers sometimes resolve a request themselves within moments (for example after a
      // plan approval switches the mode); only requests still pending after a short wait are shown.
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      const refreshed = await paseo.agents.ref(agent.id).refresh().catch(() => null);
      const stillPending = refreshed?.agent.pendingPermissions;
      if (Array.isArray(stillPending) && !stillPending.some((pending) => pending.id === request.id)) return;
      const inSession = await context.once("session:ask", async () => {
        let asked = false;
        await this.session(agent.id, (sessionId, sessions) => {
          asked = true;
          const subject = [request.title || request.name, request.description].filter(Boolean).join("\n\n");
          return request.kind === "question"
            ? sessions.askQuestion(sessionId, request)
            : sessions.ask(sessionId, `Approve this action?\n\n${subject}`, [{ label: "Approve", value: "approve" }, { label: "Deny", value: "deny" }]);
        });
        return asked;
      }) ?? false;
      if (!settings.writeback.blocked) return;
      // Posted even with the agent panel: only a mention reaches the owner's inbox and phone.
      const what = request.kind === "question" ? "an answer" : request.kind === "plan" ? "plan approval" : "permission";
      const subject = request.title || request.name;
      const description = request.description ? `\n\n${truncateSummary(request.description)}` : "";
      const choices = (questionsOf(request)[0]?.options ?? []).map((option) => option.label ?? "").filter(Boolean);
      const options = choices.length ? `\n\nOptions:\n${choices.map((choice) => `- ${choice}`).join("\n")}` : "";
      const hint = settings.writeback.mentions
        ? `\n\nReply here with ${request.kind === "question" ? "“@paseo <your answer>”" : "“@paseo approve” or “@paseo deny <reason>”"}.`
        : "";
      await this.markWaiting({ id: issueId, identifier }, agent, settings, subject, `**${agent.title ?? "Paseo agent"}** (Paseo) is waiting for ${what}: ${subject}${description}${options}${hint}`, inSession, context);
    });
  }

  // A follow-up question usually arrives within moments (question 2/5 after 1/5): the waiting
  // period only ends once nothing is pending after the settle wait.
  permissionResolved({ agent }: PluginLifecycleEvents["agent.permission_resolved"], paseo: PaseoApi): Promise<void> {
    return this.run("permission_resolved", agent, paseo, async ({ issueId, identifier }, settings) => {
      if (!settings.writeback.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      const refreshed = await paseo.agents.ref(agent.id).refresh().catch(() => null);
      const pending = refreshed?.agent.pendingPermissions;
      if (Array.isArray(pending) && pending.length > 0) return;
      await this.clearWaiting({ id: issueId, identifier }, agent, settings, undefined, true);
    });
  }

  archived({ agent }: PluginLifecycleEvents["agent.archived"], paseo: PaseoApi): Promise<void> {
    return this.run("archived", agent, paseo, async ({ issueId, identifier }, settings, { once }) => {
      this.links.delete(agent.id);
      this.started.delete(agent.id);
      // Replies on its open "Needs you" sub-issues have nobody to reach any more; the sub-issues
      // stay open for the owner.
      if (this.needsYou) for (const entry of (await this.needsYou.all()).filter((known) => known.agentId === agent.id)) await this.needsYou.remove(entry.id);
      const labels = dispatchLabels(settings.dispatch.label);
      const state = await this.linear.issueState(issueId);
      // A successor already working on the ticket (a resume) keeps the running marker and the session.
      const others = await paseo.agents.list({ filter: { labels: { "linear.issueId": issueId }, includeArchived: false }, page: { limit: 5 } });
      const succeeded = others.entries.some(({ agent: other }) => other.id !== agent.id);
      const handover = this.agentBridge?.handover;
      if (succeeded) {
        if (handover) await once("finish", () => handover.finish({ id: issueId, identifier }, agent, "archived", "handed over to a new agent"));
        return;
      }
      // The running marker belongs to the dispatcher and is always cleared; the blocked and
      // needs-you markers only when blocked write-back owns them.
      await this.linear.removeLabel(issueId, labels.running, state.labels);
      if (settings.writeback.blocked) {
        await this.linear.removeLabel(issueId, labels.blocked, state.labels);
        await this.clearWaiting({ id: issueId, identifier }, agent, settings, state);
      }
      const hasPullRequest = state.attachmentUrls.some((url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url));
      const open = !["completed", "canceled", "duplicate"].includes(state.statusType.trim().toLowerCase());
      if (handover) {
        await once("finish", () => handover.finish({ id: issueId, identifier }, agent, "archived", hasPullRequest ? "pull request linked" : "no pull request linked"));
        if (open) await once("session:resume", () => this.session(agent.id, (sessionId, sessions) => sessions.offerResume(sessionId)));
        return;
      }
      if (settings.writeback.summaries && !hasPullRequest) {
        await once("comment", () => this.linear.comment(issueId, `**${agent.title ?? "Paseo agent"}** (Paseo) was archived without a linked pull request.`));
      }
    });
  }
}
