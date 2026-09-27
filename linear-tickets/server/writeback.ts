import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { dispatchLabels } from "./dispatch";
import { activeModel } from "./model";
import { questionsOf } from "./relay";
import type { AgentApi } from "./agent-app";
import type { Handover, WaitingPeriod } from "./handover";
import type { IssueState, LinearService } from "./linear";
import { PLANNING_STATE } from "./plannotator";
import type { SessionRouter } from "./sessions";
import type { PluginSettings, Settings } from "./settings";

export const MAX_SUMMARY_LENGTH = 4_000;
// The workflow state (type started) a ticket waits in while its agent needs the owner.
export const NEEDS_INPUT_STATE = "Needs input";
const NEEDS_YOU_COLOR = "#eb5757";
const TRANSIENT = /HTTP 50\d|rate-limiting|Could not reach|timed out|ECONNRESET|fetch failed/i;
const RETRY_DELAYS_MS = [30_000, 120_000];
const PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];
// `planFirst`: launched plan-first (a ticket you did not write, before its plan is approved).
type Link = { issueId: string; identifier: string; planFirst: boolean };
// The native Linear agent: the session panel, the durable handover record and comments written
// as the Paseo app. Optional, so ticket write-back keeps working without the Paseo Linear app installed.
export type AgentBridge = {
  sessions: Pick<SessionRouter, "sessionFor" | "say" | "action" | "ask" | "askQuestion" | "link" | "offerResume" | "resumeNow" | "holdIfStopped" | "follow" | "unfollow">;
  handover: Pick<Handover, "update" | "finish" | "waiting" | "setWaiting">;
  comments?: Pick<AgentApi, "createComment" | "updateComment">;
};
type Linear = Pick<LinearService, "issueState" | "markInProgress" | "moveToStateNamed" | "moveToState" | "comment" | "createComment" | "updateComment" | "addLabel" | "removeLabel" | "linkUrl" | "moveToReview" | "viewerId" | "userUrl">;

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

  constructor(private readonly linear: Linear, private readonly settings: Pick<Settings, "read">, private readonly agentBridge?: AgentBridge, private readonly settleMs = 2_000) {}

  // The running model, and the agent with its title: hook events can carry none.
  private async snapshot(agent: PluginHookAgent, paseo: PaseoApi): Promise<{ model: string | null; named: PluginHookAgent }> {
    const current = (await paseo.agents.ref(agent.id).refresh().catch(() => null))?.agent;
    return { model: activeModel(current), named: { ...agent, title: agent.title ?? current?.title ?? null } };
  }

  // Session activities are best-effort on their own: a panel failure must not skip comments.
  private async session(agentId: string, work: (sessionId: string, sessions: AgentBridge["sessions"]) => Promise<void>): Promise<void> {
    const sessions = this.agentBridge?.sessions;
    if (!sessions) return;
    try {
      const link = await sessions.sessionFor(agentId);
      if (link) await work(link.sessionId, sessions);
    } catch (error) {
      console.error(`[linear-tickets] agent session update for ${agentId} failed:`, error instanceof Error ? error.message : error);
    }
  }

  private async link(agent: PluginHookAgent, paseo: PaseoApi): Promise<Link | null> {
    if (agent.parentAgentId) return null;
    const known = this.links.get(agent.id);
    if (known !== undefined) return known;
    const refreshed = await paseo.agents.ref(agent.id).refresh();
    const labels = refreshed?.agent.labels ?? {};
    const issueId = labels["linear.issueId"];
    const link = issueId ? { issueId, identifier: labels["linear.identifier"] || issueId, planFirst: labels["linear.untrusted"] === "1" } : null;
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

  // Written as the Paseo app when it is installed: the plugin's key belongs to the owner, and Linear
  // notifies nobody of their own mentions. The waiting period's comment is edited, not repeated.
  private async waitingComment(issueId: string, commentId: string | null, body: string): Promise<string> {
    const app = this.agentBridge?.comments;
    if (commentId) {
      for (const author of app ? [app, this.linear] : [this.linear]) {
        if (await author.updateComment(commentId, body).then(() => true, () => false)) return commentId;
      }
    }
    if (app) {
      const id = await app.createComment(issueId, body).catch((error: unknown) => {
        console.error(`[linear-tickets] ${issueId}: comment as the Paseo app failed, posting with the plugin's key: ${error instanceof Error ? error.message : error}`);
        return null;
      });
      if (id) return id;
    }
    return this.linear.createComment(issueId, body);
  }

  // Opens or continues a waiting period: the ticket moves to Needs input (teams without that state
  // skip it), gets the needs-you label, and one comment mentions the owner, edited per question.
  private markWaiting(issue: { id: string; identifier: string }, agent: PluginHookAgent, settings: PluginSettings, body: string, inSession: boolean): Promise<void> {
    return this.serialize(issue.id, async () => {
      const waiting = await this.waitingFor(issue.id);
      const state = await this.linear.issueState(issue.id);
      const moved = await this.linear.moveToStateNamed(issue.id, NEEDS_INPUT_STATE, state);
      // Remembered before anything else can fail, so a retry still knows where the ticket was.
      const previousStateId = waiting?.previousStateId ?? (moved.changed ? state.statusId : null);
      if (previousStateId !== (waiting?.previousStateId ?? null)) await this.setWaiting(issue, agent, { previousStateId, commentId: waiting?.commentId ?? null });
      const needsYou = dispatchLabels(settings.dispatch.label).needsYou;
      if (!state.labels.some((item) => item.name.trim().toLowerCase() === needsYou.toLowerCase())) await this.linear.addLabel(issue.id, needsYou, NEEDS_YOU_COLOR);
      // Only the owner opens Linear sessions; without one, whoever wrote the ticket is asked.
      const ownerId = (inSession ? null : state.creatorId) ?? await this.linear.viewerId();
      const commentId = await this.waitingComment(issue.id, waiting?.commentId ?? null, `${await this.linear.userUrl(ownerId)} ${body}`);
      await this.setWaiting(issue, agent, { previousStateId, commentId });
    });
  }

  // Ends the waiting period: the label comes off and the ticket goes back where it was, unless
  // someone moved it out of Needs input meanwhile. The next period gets a fresh comment.
  private clearWaiting(issue: { id: string; identifier: string }, agent: PluginHookAgent, settings: PluginSettings, current?: IssueState): Promise<void> {
    return this.serialize(issue.id, async () => {
      const waiting = await this.waitingFor(issue.id);
      const state = current ?? await this.linear.issueState(issue.id);
      await this.linear.removeLabel(issue.id, dispatchLabels(settings.dispatch.label).needsYou, state.labels);
      if (waiting?.previousStateId && state.status.trim().toLowerCase() === NEEDS_INPUT_STATE.toLowerCase()) await this.linear.moveToState(issue.id, waiting.previousStateId);
      if (waiting) await this.setWaiting(issue, agent, null);
    });
  }

  // Linear outages (HTTP 503, rate limits, network drops) are retried after 30 s and 2 min.
  private async run(event: string, agent: PluginHookAgent, paseo: PaseoApi, work: (link: Link, settings: PluginSettings) => Promise<void>, attempt = 0): Promise<void> {
    try {
      const link = await this.link(agent, paseo);
      if (!link) return;
      await work(link, await this.settings.read());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined && TRANSIENT.test(message)) {
        console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} failed, retrying in ${delay / 1000} s: ${message}`);
        setTimeout(() => { void this.run(event, agent, paseo, work, attempt + 1); }, delay).unref?.();
        return;
      }
      console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} failed:`, message);
    }
  }

  turnStarted({ agent }: PluginLifecycleEvents["agent.turn_started"], paseo: PaseoApi): Promise<void> {
    return this.run("turn_started", agent, paseo, async ({ issueId, identifier, planFirst }, settings) => {
      const sessions = this.agentBridge?.sessions;
      if (sessions && await sessions.holdIfStopped(agent.id).catch(() => false)) return;
      const { model, named } = await this.snapshot(agent, paseo);
      const previous = this.models.get(agent.id);
      if (model) this.models.set(agent.id, model);
      const changed = Boolean(model && previous && model !== previous);
      await this.session(agent.id, async (sessionId, live) => {
        if (changed) await live.say(sessionId, "thought", `Model changed: ${previous} → ${model}`);
        await live.say(sessionId, "thought", model ? `Working… (${model})` : "Working…", true);
        await live.follow(agent.id);
      });
      const handover = this.agentBridge?.handover;
      if (model && (changed || !previous) && handover && settings.writeback.summaries) {
        await handover.update({ id: issueId, identifier }, named, { model }).catch(() => {});
      }
      if (!settings.writeback.status || this.started.has(agent.id)) return;
      this.started.add(agent.id);
      const state = await this.linear.issueState(issueId);
      // A plan-first agent only plans: its ticket goes to Planning, not In Progress. A ticket
      // already started (for example after the plan was approved) is left where it is.
      const outcome = !planFirst ? await this.linear.markInProgress(state, state.teamId)
        : state.statusType.trim().toLowerCase() === "started" ? { changed: false } : await this.linear.moveToStateNamed(issueId, PLANNING_STATE);
      if (outcome.note) console.error(`[linear-tickets] ${issueId}: ${outcome.note}`);
    });
  }

  turnEnded({ agent, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"], paseo: PaseoApi): Promise<void> {
    return this.run("turn_ended", agent, paseo, async ({ issueId, identifier }, settings) => {
      const { writeback } = settings;
      const blocked = dispatchLabels(settings.dispatch.label).blocked;
      // The turn is over, so nothing waits for the owner any more; `paseo-blocked` marks errors only.
      const state = writeback.blocked ? await this.linear.issueState(issueId) : null;
      if (state) await this.clearWaiting({ id: issueId, identifier }, agent, settings, state);
      const title = agent.title ?? "Paseo agent";
      const handover = this.agentBridge?.handover;
      const issue = { id: issueId, identifier };
      const { model, named } = await this.snapshot(agent, paseo);
      if (model) this.models.set(agent.id, model);
      if (outcome.kind === "completed") {
        const reply = turnReply(timeline);
        await this.session(agent.id, async (sessionId, sessions) => {
          // The live feed already showed the commands; otherwise post the turn's last few.
          if (!await sessions.unfollow(agent.id)) for (const command of turnCommands(timeline)) await sessions.action(sessionId, "Ran", command);
          if (reply) await sessions.say(sessionId, "response", truncateSummary(reply));
        });
        // With the handover record, turns update one progress comment instead of adding comments.
        if (writeback.summaries && reply) {
          if (handover) await handover.update(issue, named, { status: "working", summary: reply, model });
          else await this.linear.comment(issueId, `**${title}** (Paseo) finished a turn:\n\n${truncateSummary(reply)}`);
        }
        if (state) await this.linear.removeLabel(issueId, blocked, state.labels);
      } else if (outcome.kind === "failed") {
        await this.session(agent.id, async (sessionId, sessions) => {
          await sessions.unfollow(agent.id);
          await sessions.say(sessionId, "error", `The agent stopped with an error: ${outcome.error.message}`);
        });
        if (handover) await handover.finish(issue, named, "failed", outcome.error.message.slice(0, 500), model);
        else if (writeback.summaries || writeback.blocked) await this.linear.comment(issueId, `**${title}** (Paseo) stopped with an error: ${outcome.error.message}`);
        if (writeback.blocked) await this.linear.addLabel(issueId, blocked);
        await this.session(agent.id, async (sessionId, sessions) => {
          if (!writeback.autoResume || !await sessions.resumeNow(sessionId)) await sessions.offerResume(sessionId);
        });
      }
      if (outcome.kind === "canceled") await this.session(agent.id, async (_sessionId, sessions) => { await sessions.unfollow(agent.id); });
      if (!writeback.pullRequests) return;
      const urls = turnPullRequests(timeline);
      if (!urls.length) return;
      for (const url of urls) {
        await this.linear.linkUrl(issueId, url, "Pull request");
        await this.session(agent.id, (sessionId, sessions) => sessions.link(sessionId, "Pull request", url));
        if (handover) await handover.update(issue, named, { link: ["Pull request", url] });
      }
      const moved = await this.linear.moveToReview(issueId);
      if (moved.note) console.error(`[linear-tickets] ${issueId}: ${moved.note}`);
    });
  }

  permissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"], paseo: PaseoApi): Promise<void> {
    return this.run("permission_requested", agent, paseo, async ({ issueId, identifier }, settings) => {
      // Providers sometimes resolve a request themselves within moments (for example after a
      // plan approval switches the mode); only requests still pending after a short wait are shown.
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      const refreshed = await paseo.agents.ref(agent.id).refresh().catch(() => null);
      const stillPending = refreshed?.agent.pendingPermissions;
      if (Array.isArray(stillPending) && !stillPending.some((pending) => pending.id === request.id)) return;
      let inSession = false;
      await this.session(agent.id, (sessionId, sessions) => {
        inSession = true;
        const subject = [request.title || request.name, request.description].filter(Boolean).join("\n\n");
        return request.kind === "question"
          ? sessions.askQuestion(sessionId, request)
          : sessions.ask(sessionId, `Approve this action?\n\n${subject}`, [{ label: "Approve", value: "approve" }, { label: "Deny", value: "deny" }]);
      });
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
      await this.markWaiting({ id: issueId, identifier }, agent, settings, `**${agent.title ?? "Paseo agent"}** (Paseo) is waiting for ${what}: ${subject}${description}${options}${hint}`, inSession);
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
      await this.clearWaiting({ id: issueId, identifier }, agent, settings);
    });
  }

  archived({ agent }: PluginLifecycleEvents["agent.archived"], paseo: PaseoApi): Promise<void> {
    return this.run("archived", agent, paseo, async ({ issueId, identifier }, settings) => {
      this.links.delete(agent.id);
      this.started.delete(agent.id);
      const labels = dispatchLabels(settings.dispatch.label);
      const state = await this.linear.issueState(issueId);
      // A successor already working on the ticket (a resume) keeps the running marker and the session.
      const others = await paseo.agents.list({ filter: { labels: { "linear.issueId": issueId }, includeArchived: false }, page: { limit: 5 } });
      const succeeded = others.entries.some(({ agent: other }) => other.id !== agent.id);
      if (succeeded) {
        await this.agentBridge?.handover.finish({ id: issueId, identifier }, agent, "archived", "handed over to a new agent");
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
      const handover = this.agentBridge?.handover;
      if (handover) {
        await handover.finish({ id: issueId, identifier }, agent, "archived", hasPullRequest ? "pull request linked" : "no pull request linked");
        if (open) await this.session(agent.id, (sessionId, sessions) => sessions.offerResume(sessionId));
        return;
      }
      if (settings.writeback.summaries && !hasPullRequest) {
        await this.linear.comment(issueId, `**${agent.title ?? "Paseo agent"}** (Paseo) was archived without a linked pull request.`);
      }
    });
  }
}
