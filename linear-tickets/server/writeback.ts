import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { dispatchLabels } from "./dispatch";
import { activeModel } from "./model";
import { limitError } from "./limit-resume";
import { questionsOf } from "./relay";
import type { Handover, HandoverRecord, WaitingKind, WaitingPeriod } from "./handover";
import type { IssueCore, LinearService } from "./linear";
import type { NeedsYouIssues } from "./needs-you";
import { PLANNING_STATE } from "./plannotator";
import { PLAN_POLICY_LABEL } from "./plan-policy";
import { logQuietly, questionEntry, type DecisionLog } from "./owner-decisions";
import type { Deputy } from "./deputy";
import { ticketPullRequest, type PullRequestCheck } from "./pull-request-check";
import type { ProcessInspector } from "./process-liveness";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { SessionRouter } from "./sessions";
import type { PluginSettings, Settings } from "./settings";
import { classifyTicketAgents, issueAgents, type TicketAgents } from "./starter";
import { paseoHome } from "./ticket-mcp";

export const MAX_SUMMARY_LENGTH = 4_000;
// The workflow state (type started) a ticket waits in while its agent needs the owner.
export const NEEDS_INPUT_STATE = "Needs input";
const NEEDS_YOU_COLOR = "#eb5757";
const CLOSED_TYPES = ["completed", "canceled", "duplicate"];
const MAX_NEEDS_YOU_TITLE = 80;
const TRANSIENT = /HTTP 50\d|Could not reach|timed out|ECONNRESET|fetch failed/i;
const RETRY_DELAYS_MS = [30_000, 120_000];
// A recorded wait with no live agent is given this long before the reconcile closes it: a daemon or
// plugin that just restarted lists its agents again within moments, and a wait that outlives them
// is a wait whose ending event was lost, not one racing the listing.
const WAIT_NO_AGENT_GRACE_MS = 10 * 60_000;
// Rate-limited write-backs wait for the pool to refill however often it takes, up to this long.
const RATE_LIMIT_GIVE_UP_MS = 6 * 60 * 60 * 1000;
const MIN_RATE_LIMIT_DELAY_MS = 5_000;
const PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];
// `planFirst`: launched to plan (every ticket until its plan is approved, `plan-ready`).
type Link = { issueId: string; identifier: string; planFirst: boolean };
// Steps that must not repeat when a failed write-back is retried (comments, session activities):
// a retry of the same event skips the steps that already succeeded and gets their earlier result.
export type WritebackContext = { once<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> };
type Work = (link: Link, settings: PluginSettings, context: WritebackContext) => Promise<void>;
type Delivery = { event: string; agent: PluginHookAgent; paseo: PaseoApi; work: Work; seq: number; attempt: number; firstFailureAt: number | null; transientRetries: number };
// A pull request found at the end of a turn, kept on disk until it is checked and every place
// links it, so a rate limit, a GitHub outage, a superseding event or a plugin restart cannot lose
// it. `checked`: the check accepted it as the ticket's pull request (entries from before the check
// existed have none and are checked first).
type OutboxEntry = { agentId: string; agentTitle: string | null; cwd: string; issueId: string; identifier: string; url: string; checked?: true; done: { linear: boolean; session: boolean; handover: boolean } };
// The native Linear agent: the session panel and the durable handover record. Optional, so ticket
// write-back keeps working without the Paseo Linear app installed.
export type AgentBridge = {
  sessions: Pick<SessionRouter, "sessionFor" | "say" | "action" | "ask" | "askQuestion" | "link" | "offerResume" | "resumeNow" | "scheduleLimitResume" | "holdIfStopped" | "follow" | "unfollow">;
  handover: Pick<Handover, "read" | "all" | "update" | "finish" | "handOff" | "waiting" | "setWaiting">;
};
type Linear = Pick<LinearService, "issueCore" | "markInProgress" | "moveToStateNamed" | "moveToState" | "comment" | "upsertComment" | "commentBody" | "addLabel" | "removeLabel" | "linkUrl" | "moveToReview" | "viewerId" | "isPerson" | "userUrl" | "createIssue" | "complete">;
// What a waiting period needs of its agent: enough to write the record back without a hook event.
type WaitingAgent = { id: string; title: string | null; cwd: string };
// What the reconcile below gets from the host: the tickets this host forwarded to the peer host
// (their waits belong to the peer's plugin) and, for tests, the process table ghosts are read from.
export type ReconcileDeps = { handedOver?: () => Promise<Map<string, string>>; inspect?: ProcessInspector };

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
  // Where the owner's answers to questions are kept for the weekly decision candidates.
  private decisions: Pick<DecisionLog, "append" | "answer"> | null = null;
  // The deputy for agent questions (README, "Deputy for agent questions"), shown each question
  // after the owner was, and told when a request is resolved.
  private deputy: Pick<Deputy, "observe" | "resolved"> | null = null;

  // `needsYou`: where waits on closed tickets keep their sub-issues; without it such a wait only
  // labels and comments on the closed ticket. `checkPullRequest`: whether a pull request URL from
  // the agent's shell output is its ticket's pull request (see ticketPullRequest).
  constructor(private readonly linear: Linear, private readonly settings: Pick<Settings, "read">, private readonly agentBridge?: AgentBridge, private readonly settleMs = 2_000, private readonly outboxPath = join(paseoHome(), "linear-tickets", "writeback-outbox.json"), private readonly needsYou?: NeedsYouIssues, private readonly checkPullRequest: PullRequestCheck = ticketPullRequest) {}

  recordDecisions(log: Pick<DecisionLog, "append" | "answer">): void {
    this.decisions = log;
  }

  recordDeputy(deputy: Pick<Deputy, "observe" | "resolved">): void {
    this.deputy = deputy;
  }

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
  // First, unless an earlier delivery did, it checks that the URL is the ticket's pull request: a
  // rejected URL leaves the outbox unlinked, a GitHub outage throws and keeps it for later.
  // `accepted` collects the ticket's pull requests, so the turn knows to move the ticket to review.
  private async deliver(entry: OutboxEntry, accepted?: Set<string>): Promise<void> {
    if (!entry.checked) {
      const verdict = await this.checkPullRequest(entry.url, entry.identifier);
      if (!verdict.link) {
        await this.changeOutbox((entries) => entries.filter((known) => known.agentId !== entry.agentId || known.url !== entry.url));
        console.error(`[linear-tickets] not linking ${entry.url} to ${entry.identifier}: ${verdict.reason}${entry.done.linear ? "; already attached on Linear; remove it by hand" : ""}`);
        return;
      }
      // Recorded before the first link, so a retry or restart links without checking again.
      entry.checked = true;
      await this.changeOutbox((entries) => entries.map((known) => known.agentId === entry.agentId && known.url === entry.url ? { ...known, checked: true } : known));
    }
    accepted?.add(entry.url);
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
  // Only an agent's own drain collects `accepted`: a restart drain links but moves no ticket.
  private drainOutbox(agentId?: string, accepted?: Set<string>): Promise<void> {
    const run = async () => {
      for (const entry of await this.readOutbox()) {
        if (agentId === undefined) {
          await this.deliver(entry).catch((error: unknown) => console.error(`[linear-tickets] linking ${entry.url} to ${entry.identifier} failed, kept for later: ${error instanceof Error ? error.message : error}`));
        } else if (entry.agentId === agentId) await this.deliver(entry, accepted);
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

  private async setWaiting(issue: { id: string; identifier: string }, agent: WaitingAgent, waiting: WaitingPeriod | null): Promise<void> {
    const handover = this.agentBridge?.handover;
    if (handover) await handover.setWaiting(issue, agent, waiting);
    else if (waiting) this.waitingPeriods.set(issue.id, waiting);
    else this.waitingPeriods.delete(issue.id);
  }

  // Opens or continues a waiting period: the ticket moves to Needs input (teams without that state
  // skip it), gets the needs-you label, and one comment mentions the owner, edited per question.
  // A closed ticket stays closed: a "Needs you" sub-issue in Needs input carries the label and the
  // comment instead. `subject` (one line) titles that sub-issue. `kind` says what opened the wait,
  // so a wait no live agent can end can be told from a live one (reconcileWaiting).
  private markWaiting(issue: { id: string; identifier: string }, agent: WaitingAgent, settings: PluginSettings, subject: string, body: string, inSession: boolean, kind: WaitingKind, { once }: WritebackContext): Promise<void> {
    return this.serialize(issue.id, () => withPriority("owner", "owner question", async () => {
      const waiting = await this.waitingFor(issue.id);
      // When the current kind was opened: a new question on the same wait keeps the first one's
      // time, so a wait that keeps asking is not treated as brand new forever.
      const at = waiting?.kind === kind ? waiting.at ?? new Date().toISOString() : new Date().toISOString();
      const state = await this.linear.issueCore(issue.id);
      const needsYou = dispatchLabels(settings.dispatch.label).needsYou;
      // Only the owner opens Linear sessions; without one, whoever wrote the ticket is asked, unless
      // the Paseo app or another integration wrote it.
      const creator = inSession ? null : state.creatorId;
      const ownerId = creator && await this.linear.isPerson(creator) ? creator : await this.linear.viewerId();
      const closed = CLOSED_TYPES.includes(state.statusType.trim().toLowerCase());
      let subIssueId = waiting?.subIssueId ?? null;
      let previousStateId = waiting?.previousStateId ?? null;
      if (!subIssueId && closed && this.needsYou && state.teamId) {
        // The agent's sub-issue from an earlier wait, while still open, takes the new one too.
        for (const known of (await this.needsYou.all()).filter((entry) => entry.parentId === issue.id && entry.agentId === agent.id)) {
          // A deleted sub-issue is gone; outages and rate limits retry the whole write-back.
          const found = subIssueId ? null : await this.linear.issueCore(known.id).catch((error: unknown) => {
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
            projectId: state.projectId,
            assigneeId: ownerId,
            startedState: NEEDS_INPUT_STATE,
            ready: true,
            title: `Needs you: ${title.length <= MAX_NEEDS_YOU_TITLE ? title : `${title.slice(0, MAX_NEEDS_YOU_TITLE - 1).trimEnd()}…`}`,
            description: `${body}\n\n${issue.identifier} was already closed when its agent asked, so the wait is tracked here. A reply starting with “@paseo” goes to the agent and closes this issue; otherwise close it once handled.`,
          }));
          if (!created) return;
          subIssueId = created.id;
          // Remembered before anything else can fail, so a retry continues this sub-issue.
          await this.setWaiting(issue, agent, { previousStateId, commentId: null, subIssueId, kind, at });
          await this.needsYou?.add({ id: created.id, identifier: created.identifier, parentId: issue.id, agentId: agent.id });
          await once("needs-you-label", () => this.linear.addLabel(created.id, needsYou, NEEDS_YOU_COLOR));
        }
      }
      if (!subIssueId) {
        const moved = await this.linear.moveToStateNamed(issue.id, NEEDS_INPUT_STATE, state);
        // Remembered before anything else can fail, so a retry still knows where the ticket was.
        previousStateId ??= moved.changed ? state.statusId : null;
        if (previousStateId !== (waiting?.previousStateId ?? null)) await this.setWaiting(issue, agent, { previousStateId, commentId: waiting?.commentId ?? null, kind, at });
        if (!state.labels.some((item) => item.name.trim().toLowerCase() === needsYou.toLowerCase())) await this.linear.addLabel(issue.id, needsYou, NEEDS_YOU_COLOR);
      }
      // The waiting period's comment is edited, not repeated.
      const commentId = await once("waiting-comment", async () => this.linear.upsertComment(subIssueId ?? issue.id, `${await this.linear.userUrl(ownerId)} ${body}`, waiting?.commentId ?? null)) ?? null;
      await this.setWaiting(issue, agent, { previousStateId, commentId, subIssueId, kind, at });
    }));
  }

  // Ends the waiting period: the label comes off and the ticket goes back where it was, or to its
  // team's work state when nothing recorded where that was, unless someone moved it out of Needs
  // input meanwhile. The next period gets a fresh comment. A "Needs you" sub-issue is closed only
  // when `answered` (the question or approval was resolved); a wait that ended otherwise may be a
  // manual step, which the owner closes.
  private clearWaiting(issue: { id: string; identifier: string }, agent: WaitingAgent, settings: PluginSettings, current?: IssueCore, answered = false): Promise<void> {
    return this.serialize(issue.id, async () => {
      const waiting = await this.waitingFor(issue.id);
      const state = current ?? await this.linear.issueCore(issue.id);
      await this.linear.removeLabel(issue.id, dispatchLabels(settings.dispatch.label).needsYou, state.labels);
      if (state.status.trim().toLowerCase() === NEEDS_INPUT_STATE.toLowerCase()) {
        if (waiting?.previousStateId) await this.linear.moveToState(issue.id, waiting.previousStateId);
        // The period opened while the ticket was already in Needs input (an earlier wait here or on
        // the other host, or one whose end was lost), so nothing recorded the state it left: it goes
        // back to work instead of sitting in Needs input for good. A ticket whose team has no work
        // state, or that is closed, is left where it is.
        else if (!CLOSED_TYPES.includes(state.statusType.trim().toLowerCase())) {
          const moved = await this.linear.markInProgress(state, state.teamId, { fromStarted: true });
          if (moved.note) console.error(`[linear-tickets] ${issue.identifier}: the wait ended but the ticket stayed in ${state.status}: ${moved.note}`);
        }
      }
      if (waiting?.subIssueId && answered) {
        await this.linear.complete(waiting.subIssueId);
        await this.needsYou?.remove(waiting.subIssueId);
      }
      if (waiting) await this.setWaiting(issue, agent, null);
    });
  }

  // A recorded wait whose ending event never arrived -- a question killed with its agent's process
  // by a host or daemon restart, an agent closed or archived while the plugin was down, a reload in
  // between -- holds its ticket in Needs input under its label, and no later event ends it. The
  // pull request poll calls this every two minutes: every recorded wait is compared with the
  // ticket's live agents, and one no live agent can still end is closed the way a normal end is
  // (label off, the state it left restored, unless someone moved the ticket meanwhile). A live
  // wait, and a wait of a ticket this host handed to the peer host (whose plugin ends it), stays.
  async reconcileWaiting(paseo: PaseoApi, deps: ReconcileDeps = {}): Promise<void> {
    const handover = this.agentBridge?.handover;
    if (!handover?.all) return;
    const settings = await this.settings.read();
    if (!settings.writeback.blocked) return;
    // Read once per pass. An unreadable answer decides nothing: clearing a wait the peer's plugin
    // owns would take the label off a ticket that is waiting there.
    let handed: Map<string, string> | null | undefined;
    const handedOver = async (): Promise<Map<string, string> | null> => {
      if (handed !== undefined) return handed;
      try { handed = await deps.handedOver?.() ?? new Map(); }
      catch (error) {
        handed = null;
        console.error(`[linear-tickets] the waits for the owner: the tickets handed to the peer could not be read (${error instanceof Error ? error.message : error}); none is closed this pass`);
      }
      return handed;
    };
    for (const record of await handover.all()) {
      // Sub-issue waits (closed tickets) are the owner's to close, and waits whose ticket was moved
      // by hand are ended by clearWaiting either way.
      if (!record.waiting || record.waiting.subIssueId) continue;
      try {
        await this.reconcileWait(paseo, record, settings, deps, handedOver);
      } catch (error) {
        console.error(`[linear-tickets] ${record.identifier}: checking the wait for the owner failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // One recorded wait against this host's agents for its ticket: closes it when nothing can end it.
  private async reconcileWait(paseo: PaseoApi, record: HandoverRecord, settings: PluginSettings, deps: ReconcileDeps, handedOver: () => Promise<Map<string, string> | null>): Promise<void> {
    const waiting = record.waiting;
    // A record without an agent (Handover.transfer) never opened a wait.
    if (!waiting || record.agentId === null) return;
    const issue = { id: record.issueId, identifier: record.identifier };
    const agent: WaitingAgent = { id: record.agentId, title: record.agentTitle, cwd: record.worktreePath ?? "" };
    const now = Date.now();
    const found = await classifyTicketAgents(paseo, record.issueId, now, deps.inspect);
    const pending = found.live.some((live) => (live.pendingPermissions?.length ?? 0) > 0);
    let kind: WaitingKind | null = waiting.kind ?? null;
    // A period from before the kind was recorded: its own comment says what opened it. Read only
    // where the answer decides the outcome (a live agent, nothing pending on it).
    if (!kind && !pending && found.live.length > 0) {
      kind = await this.waitingKind(waiting.commentId);
      // Backfilled under the ticket's own queue and re-read first: a question that arrived while the
      // comment was read has its own, newer period, which must not be overwritten by this one.
      const derived = kind;
      if (derived) await this.serialize(record.issueId, async () => {
        const current = await this.waitingFor(record.issueId);
        if (current && !current.kind && current.commentId === waiting.commentId) await this.setWaiting(issue, agent, { ...current, kind: derived });
      });
    }
    const reason = await this.leftBehind(record, waiting, kind, found, pending, now, handedOver);
    if (!reason) return;
    console.log(`[linear-tickets] ${record.identifier}: the wait for the owner was left behind (${reason}); removing ${dispatchLabels(settings.dispatch.label).needsYou}${waiting.previousStateId ? " and restoring the state it left, unless the ticket was moved meanwhile" : ""}`);
    await this.clearWaiting(issue, agent, settings);
  }

  // Whether nothing can end the wait any more, and why. A pending request on a live agent is
  // answerable; a live agent without one can still take its next turn (a `turn-end` wait, and an
  // unclassified one, stays); with no live agent the wait is over unless it is only minutes old (a
  // daemon that just restarted still has to list its agents) or its ticket was handed to the peer.
  private async leftBehind(record: HandoverRecord, waiting: WaitingPeriod, kind: WaitingKind | null, found: TicketAgents, pending: boolean, now: number, handedOver: () => Promise<Map<string, string> | null>): Promise<string | null> {
    if (pending) return null;
    if (found.live.length > 0) return kind === "request" ? "nothing is pending on the agent any more" : null;
    if (now - (Date.parse(waiting.at ?? record.updatedAt) || 0) < WAIT_NO_AGENT_GRACE_MS) return null;
    const newest = [...found.live, ...found.ghosts, ...found.stopped].reduce((at, agent) => Math.max(at, Date.parse(agent.createdAt) || 0), 0);
    const handed = await handedOver();
    if (handed === null) return null;
    const transferred = handed.get(record.issueId);
    if (transferred && newest <= (Date.parse(transferred) || 0)) return null;
    return "the agent is gone";
  }

  // What a recorded wait's own comment says opened it: the plugin writes one of two bodies (their
  // titles vary). Null: Linear has no such comment any more, or could not be read -- the caller
  // then only ends the wait if no live agent can.
  private async waitingKind(commentId: string | null): Promise<WaitingKind | null> {
    if (!commentId) return null;
    const body = await this.linear.commentBody(commentId);
    if (body === null) return null;
    if (/\) finished its turn and is waiting for you:/.test(body)) return "turn-end";
    if (/\) is waiting for (?:an answer|plan approval|permission):/.test(body)) return "request";
    return null;
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
      // State changes keep their prerequisite reads in the owner's reserve, before ordinary
      // panel progress can be refused. A failed read does not mark this agent as started.
      await withPriority("owner", "status change", async () => {
        if (settings.writeback.blocked && await this.waitingFor(issueId)) await this.clearWaiting({ id: issueId, identifier }, agent, settings);
        if (!settings.writeback.status || this.started.has(agent.id)) return;
        const state = await this.linear.issueCore(issueId);
        // Work after merge (for example a deploy watch) never reopens a closed ticket.
        if (!CLOSED_TYPES.includes(state.statusType.trim().toLowerCase())) {
          const outcome = !planFirst ? await this.linear.markInProgress(state, state.teamId)
            : state.statusType.trim().toLowerCase() === "started" ? { changed: false } : await this.linear.moveToStateNamed(issueId, PLANNING_STATE);
          if (outcome.note) console.error(`[linear-tickets] ${issueId}: ${outcome.note}`);
        }
        this.started.add(agent.id);
      });
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
    });
  }

  turnEnded({ agent, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"], paseo: PaseoApi): Promise<void> {
    return this.run("turn_ended", agent, paseo, async ({ issueId, identifier }, settings, context) => {
      const { once } = context;
      const { writeback } = settings;
      const { model, named } = await this.snapshot(agent, paseo);
      if (model) this.models.set(agent.id, model);
      // Recorded before any Linear call, so a failure below cannot lose the turn's pull requests;
      // whether each is the ticket's pull request is checked when it is delivered.
      const urls = writeback.pullRequests ? turnPullRequests(timeline) : [];
      if (urls.length) {
        const added = urls.map((url): OutboxEntry => ({ agentId: agent.id, agentTitle: named.title, cwd: agent.cwd, issueId, identifier, url, done: { linear: false, session: false, handover: false } }));
        await once("outbox", () => this.changeOutbox((entries) => [...entries, ...added.filter((entry) => !entries.some((known) => known.agentId === entry.agentId && known.url === entry.url))]));
      }
      const reply = outcome.kind === "completed" ? turnReply(timeline) : "";
      const request = writeback.blocked ? ownerRequest(reply) : null;
      const title = agent.title ?? "Paseo agent";
      const handover = this.agentBridge?.handover;
      const issue = { id: issueId, identifier };
      // Deliver the owner's notification before ordinary progress work can hit its reserve.
      if (request) {
        const inSession = Boolean(await this.agentBridge?.sessions.sessionFor(agent.id).catch(() => null));
        const hint = writeback.mentions ? "\n\nReply here with “@paseo <your answer>”." : "";
        await once("owner-question", () => this.markWaiting(issue, agent, settings, request, `**${title}** (Paseo) finished its turn and is waiting for you:\n\n${truncateSummary(request)}${hint}`, inSession, "turn-end", context));
      }
      const blocked = dispatchLabels(settings.dispatch.label).blocked;
      const state = writeback.blocked ? await this.linear.issueCore(issueId) : null;
      // Without a new question the turn is over; `paseo-blocked` marks errors only.
      if (state && !request) await this.clearWaiting(issue, agent, settings, state);
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
      } else if (outcome.kind === "failed") {
        await once("session:error", () => this.session(agent.id, async (sessionId, sessions) => {
          await sessions.unfollow(agent.id);
          await sessions.say(sessionId, "error", `The agent stopped with an error: ${outcome.error.message}`);
        }));
        if (handover) await once("finish", () => handover.finish(issue, named, "failed", outcome.error.message.slice(0, 500), model));
        else if (writeback.summaries || writeback.blocked) await once("comment", () => this.linear.comment(issueId, `**${title}** (Paseo) stopped with an error: ${outcome.error.message}`));
        if (writeback.blocked) await this.linear.addLabel(issueId, blocked);
        await once("session:resume", () => this.session(agent.id, async (sessionId, sessions) => {
          if (writeback.autoResume && limitError(outcome.error.message)) {
            if (!await sessions.scheduleLimitResume(sessionId, outcome.error.message, model)) await sessions.offerResume(sessionId);
          } else if (!writeback.autoResume || !await sessions.resumeNow(sessionId)) await sessions.offerResume(sessionId);
        }));
      }
      if (outcome.kind === "canceled") await this.session(agent.id, async (_sessionId, sessions) => { await sessions.unfollow(agent.id); });
      if (!urls.length) return;
      // The same set on every retry of this turn end, so a retry after the links (a failed move to
      // review) still knows the turn had the ticket's pull request.
      const accepted = await once("accepted-pull-requests", async () => new Set<string>()) ?? new Set<string>();
      await this.drainOutbox(agent.id, accepted);
      // Only the ticket's own pull requests move it to review; fixtures and other tickets' do not.
      if (!accepted.size) return;
      const moved = await this.linear.moveToReview(issueId);
      if (moved.note) console.error(`[linear-tickets] ${issueId}: ${moved.note}`);
    });
  }

  permissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"], paseo: PaseoApi): Promise<void> {
    return this.run("permission_requested", agent, paseo, async ({ issueId, identifier }, settings, context) => {
      // Logged first and whatever the write-back settings: an answer given in the Paseo app leaves
      // no other trace, and the answer is joined to this entry by id, even after a plugin reload.
      const question = questionEntry(agent.id, request, { id: issueId, identifier });
      const log = this.decisions;
      if (question && log) await logQuietly(() => log.append(question), `question on ${identifier}`);
      // Providers sometimes resolve a request themselves within moments (for example after a
      // plan approval switches the mode); only requests still pending after a short wait are shown.
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      const refreshed = await paseo.agents.ref(agent.id).refresh().catch(() => null);
      const stillPending = refreshed?.agent.pendingPermissions;
      if (Array.isArray(stillPending) && !stillPending.some((pending) => pending.id === request.id)) return;
      const inSession = await context.once("session:ask", () => withPriority("owner", "owner question", async () => {
        let asked = false;
        await this.session(agent.id, (sessionId, sessions) => {
          asked = true;
          const subject = [request.title || request.name, request.description].filter(Boolean).join("\n\n");
          return request.kind === "question"
            ? sessions.askQuestion(sessionId, request)
            : sessions.ask(sessionId, `Approve this action?\n\n${subject}`, [{ label: "Approve", value: "approve" }, { label: "Deny", value: "deny" }]);
        });
        return asked;
      })) ?? false;
      // The owner sees the question first; the deputy only starts looking at it now, in the
      // background, and never answers before the owner's grace period ends.
      const observe = () => this.deputy?.observe(agent, request, { issueId, identifier });
      if (!settings.writeback.blocked) { await observe(); return; }
      // Posted even with the agent panel: only a mention reaches the owner's inbox and phone.
      const what = request.kind === "question" ? "an answer" : request.kind === "plan" ? "plan approval" : "permission";
      const subject = request.title || request.name;
      const description = request.description ? `\n\n${truncateSummary(request.description)}` : "";
      const choices = (questionsOf(request)[0]?.options ?? []).map((option) => option.label ?? "").filter(Boolean);
      const options = choices.length ? `\n\nOptions:\n${choices.map((choice) => `- ${choice}`).join("\n")}` : "";
      const hint = settings.writeback.mentions
        ? `\n\nReply here with ${request.kind === "question" ? "“@paseo <your answer>”" : "“@paseo approve” or “@paseo deny <reason>”"}.`
        : "";
      await this.markWaiting({ id: issueId, identifier }, agent, settings, subject, `**${agent.title ?? "Paseo agent"}** (Paseo) is waiting for ${what}: ${subject}${description}${options}${hint}`, inSession, "request", context);
      await observe();
    });
  }

  // A follow-up question usually arrives within moments (question 2/5 after 1/5): the waiting
  // period only ends once nothing is pending after the settle wait.
  permissionResolved({ agent, requestId, resolution }: PluginLifecycleEvents["agent.permission_resolved"], paseo: PaseoApi): Promise<void> {
    return this.run("permission_resolved", agent, paseo, async ({ issueId, identifier }, settings) => {
      const log = this.decisions;
      if (log) await logQuietly(() => log.answer(`${agent.id}:${requestId}`, resolution), `answer on ${identifier}`);
      await this.deputy?.resolved(agent.id, requestId);
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
      const state = await this.linear.issueCore(issueId);
      // A successor already working on the ticket (a resume) keeps the running marker and the session,
      // and the record: the newest other ticket agent (subagents are not one) takes it over unless it
      // or a third agent already owns it (Handover.handOff), whichever event comes first.
      const others = (await issueAgents(paseo, issueId)).filter((other) => other.id !== agent.id);
      const successor = others.filter((other) => !other.labels?.["paseo.parent-agent-id"]).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const handover = this.agentBridge?.handover;
      if (others.length) {
        if (handover) await once("finish", async () => {
          if (successor) await handover.handOff({ id: issueId, identifier }, agent.id, { id: successor.id, title: successor.title ?? null, cwd: successor.cwd }, { title: agent.title ?? null });
          else await handover.finish({ id: issueId, identifier }, agent, "archived", "handed over to a new agent");
        });
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
