import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { dispatchLabels } from "./dispatch";
import { questionsOf } from "./relay";
import type { Handover } from "./handover";
import type { LinearService } from "./linear";
import type { SessionRouter } from "./sessions";
import { optionsForQuestion } from "./sessions";
import type { PluginSettings, Settings } from "./settings";

export const MAX_SUMMARY_LENGTH = 4_000;
const PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];
type Link = { issueId: string; identifier: string };
// The native Linear agent: the session panel and the durable handover record. Optional, so
// ticket write-back keeps working without the Paseo Linear app installed.
export type AgentBridge = {
  sessions: Pick<SessionRouter, "sessionFor" | "say" | "action" | "ask" | "link" | "offerResume" | "resumeNow">;
  handover: Pick<Handover, "update" | "finish">;
};
type Linear = Pick<LinearService, "issueState" | "markInProgress" | "comment" | "addLabel" | "removeLabel" | "linkUrl" | "moveToReview">;

// The turn's reply: assistant text after the last user message. Streaming providers may
// split one reply across several items, so the pieces are joined without separators.
export function turnReply(timeline: Timeline): string {
  let reply = "";
  for (const item of timeline) {
    if (item.type === "user_message") reply = "";
    else if (item.type === "assistant_message") reply += item.text;
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

  constructor(private readonly linear: Linear, private readonly settings: Pick<Settings, "read">, private readonly agentBridge?: AgentBridge) {}

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
    const issueId = refreshed?.agent.labels?.["linear.issueId"];
    const link = issueId ? { issueId, identifier: refreshed?.agent.labels?.["linear.identifier"] || issueId } : null;
    this.links.set(agent.id, link);
    return link;
  }

  private async run(event: string, agent: PluginHookAgent, paseo: PaseoApi, work: (link: Link, settings: PluginSettings) => Promise<void>): Promise<void> {
    try {
      const link = await this.link(agent, paseo);
      if (!link) return;
      await work(link, await this.settings.read());
    } catch (error) {
      console.error(`[linear-tickets] write-back for ${event} on agent ${agent.id} failed:`, error instanceof Error ? error.message : error);
    }
  }

  turnStarted({ agent }: PluginLifecycleEvents["agent.turn_started"], paseo: PaseoApi): Promise<void> {
    return this.run("turn_started", agent, paseo, async ({ issueId }, settings) => {
      await this.session(agent.id, (sessionId, sessions) => sessions.say(sessionId, "thought", "Working…", true));
      if (!settings.writeback.status || this.started.has(agent.id)) return;
      this.started.add(agent.id);
      const state = await this.linear.issueState(issueId);
      const outcome = await this.linear.markInProgress(state, state.teamId);
      if (outcome.note) console.error(`[linear-tickets] ${issueId}: ${outcome.note}`);
    });
  }

  turnEnded({ agent, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"], paseo: PaseoApi): Promise<void> {
    return this.run("turn_ended", agent, paseo, async ({ issueId, identifier }, settings) => {
      const { writeback } = settings;
      const blocked = dispatchLabels(settings.dispatch.label).blocked;
      const title = agent.title ?? "Paseo agent";
      const handover = this.agentBridge?.handover;
      const issue = { id: issueId, identifier };
      if (outcome.kind === "completed") {
        const reply = turnReply(timeline);
        await this.session(agent.id, async (sessionId, sessions) => {
          for (const command of turnCommands(timeline)) await sessions.action(sessionId, "Ran", command);
          if (reply) await sessions.say(sessionId, "response", truncateSummary(reply));
        });
        // With the handover record, turns update one progress comment instead of adding comments.
        if (writeback.summaries && reply) {
          if (handover) await handover.update(issue, agent, { status: "working", summary: reply });
          else await this.linear.comment(issueId, `**${title}** (Paseo) finished a turn:\n\n${truncateSummary(reply)}`);
        }
        if (writeback.blocked) await this.linear.removeLabel(issueId, blocked);
      } else if (outcome.kind === "failed") {
        await this.session(agent.id, (sessionId, sessions) => sessions.say(sessionId, "error", `The agent stopped with an error: ${outcome.error.message}`));
        if (handover) await handover.finish(issue, agent, "failed", outcome.error.message.slice(0, 500));
        else if (writeback.summaries || writeback.blocked) await this.linear.comment(issueId, `**${title}** (Paseo) stopped with an error: ${outcome.error.message}`);
        if (writeback.blocked) await this.linear.addLabel(issueId, blocked);
        await this.session(agent.id, async (sessionId, sessions) => {
          if (!writeback.autoResume || !await sessions.resumeNow(sessionId)) await sessions.offerResume(sessionId);
        });
      }
      if (!writeback.pullRequests) return;
      const urls = turnPullRequests(timeline);
      if (!urls.length) return;
      for (const url of urls) {
        await this.linear.linkUrl(issueId, url, "Pull request");
        await this.session(agent.id, (sessionId, sessions) => sessions.link(sessionId, "Pull request", url));
        if (handover) await handover.update(issue, agent, { link: ["Pull request", url] });
      }
      const moved = await this.linear.moveToReview(issueId);
      if (moved.note) console.error(`[linear-tickets] ${issueId}: ${moved.note}`);
    });
  }

  permissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"], paseo: PaseoApi): Promise<void> {
    return this.run("permission_requested", agent, paseo, async ({ issueId }, settings) => {
      await this.session(agent.id, (sessionId, sessions) => {
        const subject = [request.title || request.name, request.description].filter(Boolean).join("\n\n");
        return request.kind === "question"
          ? sessions.ask(sessionId, subject, optionsForQuestion(request))
          : sessions.ask(sessionId, `Approve this action?\n\n${subject}`, [{ label: "Approve", value: "approve" }, { label: "Deny", value: "deny" }]);
      });
      if (!settings.writeback.blocked) return;
      const what = request.kind === "question" ? "an answer" : request.kind === "plan" ? "plan approval" : "permission";
      const subject = request.title || request.name;
      const description = request.description ? `\n\n${truncateSummary(request.description)}` : "";
      const choices = (questionsOf(request)[0]?.options ?? []).map((option) => option.label ?? "").filter(Boolean);
      const options = choices.length ? `\n\nOptions:\n${choices.map((choice) => `- ${choice}`).join("\n")}` : "";
      const hint = settings.writeback.mentions
        ? `\n\nReply here with ${request.kind === "question" ? "“@paseo <your answer>”" : "“@paseo approve” or “@paseo deny <reason>”"}.`
        : "";
      await this.linear.comment(issueId, `**${agent.title ?? "Paseo agent"}** (Paseo) is waiting for ${what}: ${subject}${description}${options}${hint}`);
      await this.linear.addLabel(issueId, dispatchLabels(settings.dispatch.label).blocked);
    });
  }

  permissionResolved({ agent }: PluginLifecycleEvents["agent.permission_resolved"], paseo: PaseoApi): Promise<void> {
    return this.run("permission_resolved", agent, paseo, async ({ issueId }, settings) => {
      if (settings.writeback.blocked) await this.linear.removeLabel(issueId, dispatchLabels(settings.dispatch.label).blocked);
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
      // The running marker belongs to the dispatcher and is always cleared; the blocked
      // marker only when blocked write-back owns it.
      await this.linear.removeLabel(issueId, labels.running, state.labels);
      if (settings.writeback.blocked) await this.linear.removeLabel(issueId, labels.blocked, state.labels);
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
