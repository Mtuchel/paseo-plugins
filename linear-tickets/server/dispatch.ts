import type { PaseoApi } from "@getpaseo/client";
import type { DispatchStatus } from "../shared/contracts";
import type { ActivationSink } from "./activation";
import type { LabelRepair } from "./label-repair";
import type { Launcher } from "./launch";
import type { LabeledIssue, LinearService } from "./linear";
import { rateBudget, RateLimitedError, withPriority, type RateBudget } from "./rate-budget";
import type { CommentRelay } from "./relay";
import type { PluginSettings, Settings } from "./settings";
import type { TicketStarter } from "./starter";
import { asCaller } from "./linear-usage";

const RECENT_LIMIT = 10;
const IDLE_POLL_SECONDS = 60;
// A launch sends about a dozen requests with the key (claim, ticket, comments, state); it only
// starts when the key has that much room above its reserve, so it does not stop half-way.
const LAUNCH_ROOM = 20;

type Linear = Pick<LinearService, "labeledIssues" | "addLabel" | "removeLabel" | "comment">;
type Deps = {
  linear: Linear;
  starter: Pick<TicketStarter, "start" | "admission">;
  // The per-ticket start gate every automatic start path takes (Launcher.gate).
  launcher: Pick<Launcher, "gate">;
  settings: Pick<Settings, "read">;
  // Called after each launch, e.g. to open the ticket's Linear agent session.
  // Returns true when the launch got a Linear agent session, whose panel replaces the start comment.
  afterLaunch?: (issueId: string, identifier: string, agentId: string) => Promise<boolean>;
  // A ticket with open sub-issues is handed to Paseo as a group instead of starting an agent;
  // true when it was (SessionRouter.handOffGroup).
  handOff?: (issueId: string) => Promise<boolean>;
  // Activation routing (activation.ts): a draining host forwards its label activations instead of
  // starting them, and the receiving host defers tickets the peer still claims.
  route?: ActivationSink;
  // Linear → agent comment delivery, run on the same cadence as dispatch.
  relay?: Pick<CommentRelay, "poll">;
  // Labelled projects (README, "Projects"), moved forward after the labelled tickets.
  projects?: { tick: (paseo: PaseoApi, settings: PluginSettings) => Promise<void> };
  // Stale running and failed labels (README, "Repairing stale running and failed labels"), repaired
  // after the projects; `ownerRetried` ends a ticket's incident before the owner's label starts it.
  repairs?: Pick<LabelRepair, "tick" | "ownerRetried">;
  budget?: Pick<RateBudget, "pausedUntil">;
};

// The labels a dispatched ticket moves through, derived from the trigger label so a
// custom trigger ("agent") gets matching companions ("agent-running", "agent-failed").
// `blocked`: the agent stopped with an error; `needsYou`: it waits for the owner's answer or approval;
// `manual`: a manual task an agent registered for the owner; `hold`: a project ticket the owner
// releases before it is handed out; `attended`: a ticket
// that may need the owner while it runs, so it waits while they are away (presence.ts).
export type DispatchLabels = { running: string; failed: string; blocked: string; needsYou: string; manual: string; hold: string; attended: string };
export function dispatchLabels(trigger: string): DispatchLabels {
  return { running: `${trigger}-running`, failed: `${trigger}-failed`, blocked: `${trigger}-blocked`, needsYou: `${trigger}-needs-you`, manual: `${trigger}-manual`, hold: `${trigger}-hold`, attended: `${trigger}-attended` };
}

// Polls Linear for tickets carrying the trigger label and starts one agent per ticket
// through the same TicketStarter as Linear delegation (and the Launcher the sidebar uses), so auto-dispatched agents get the same
// worktree, labels, composer pill and linear_ticket tools as manual launches.
//
// Linear is the lock: the trigger label is swapped for `<trigger>-running` before any
// launch, so a later poll, a plugin reload or a daemon restart never starts a second agent.
export class Dispatcher {
  private paseo: PaseoApi | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  private readonly status: DispatchStatus = { active: false, lastPollAt: null, lastError: null, recent: [] };

  constructor(private readonly deps: Deps) {}

  private relayError: string | null = null;
  private pausedPool: RateLimitedError["pool"] | null = null;

  // Relay failures are logged, once per distinct error (a rate limit once per pool), and never stop dispatch.
  private async relayComments(relay: Pick<CommentRelay, "poll">, paseo: PaseoApi): Promise<void> {
    try {
      await relay.poll(paseo);
      this.relayError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const kind = error instanceof RateLimitedError ? `rate:${error.pool}:${error.reason}` : message;
      if (kind !== this.relayError) console.error(`[linear-tickets] comment relay failed: ${message}`);
      this.relayError = kind;
    }
  }

  // Plugin server code only receives the daemon connection inside handler and hook
  // contexts; it is the same connection for the subprocess lifetime. The first context
  // seen starts polling.
  attach(paseo: PaseoApi): void {
    if (this.paseo || this.stopped) return;
    this.paseo = paseo;
    this.schedule(0);
  }

  // Poll now (after a settings change) instead of waiting for the next interval.
  wake(): void {
    if (this.paseo && !this.stopped) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  snapshot(): DispatchStatus {
    return { ...this.status, recent: [...this.status.recent] };
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
    this.timer.unref?.();
  }

  // Strictly single-flight: two concurrent polls could both see a ticket before either
  // claims it. A tick during a poll only asks for another poll right after it.
  async tick(): Promise<void> {
    if (this.polling) {
      this.rerun = true;
      return this.polling;
    }
    let intervalSeconds = IDLE_POLL_SECONDS;
    // Background priority: every request stops at its pool's reserve (see rate-budget.ts).
    this.polling = withPriority("background", "dispatch", async () => {
      try {
        const settings = await this.deps.settings.read();
        intervalSeconds = settings.dispatch.intervalSeconds;
        if (settings.writeback.mentions && this.deps.relay && this.paseo) await asCaller("comment-relay", () => this.relayComments(this.deps.relay!, this.paseo!));
        this.status.active = settings.dispatch.enabled && settings.dispatch.teamKeys.length > 0;
        if (!this.status.active || !this.paseo) return;
        await this.poll(settings, this.paseo);
        this.status.lastPollAt = new Date().toISOString();
        this.status.lastError = null;
        this.pausedPool = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        // Logged once per distinct error (a pause once per pool) so a persistent failure does not flood the plugin log.
        const pool = error instanceof RateLimitedError ? error.pool : null;
        if (pool ? pool !== this.pausedPool : message !== this.status.lastError) console.error(`[linear-tickets] auto-dispatch poll failed: ${message}`);
        this.pausedPool = pool;
        this.status.lastPollAt = new Date().toISOString();
        this.status.lastError = pool ? `paused: ${message}` : message;
      }
    });
    try {
      await this.polling;
    } finally {
      this.polling = null;
      const again = this.rerun;
      this.rerun = false;
      if (!this.stopped) this.schedule(again ? 0 : intervalSeconds * 1000);
    }
  }

  private async poll(settings: PluginSettings, paseo: PaseoApi): Promise<void> {
    const issues = await this.deps.linear.labeledIssues(settings.dispatch.label, settings.dispatch.teamKeys);
    // Sequential on purpose: each launch creates a worktree, and Linear rate-limits writes.
    for (const issue of issues) {
      if (this.stopped) return;
      const until = (this.deps.budget ?? rateBudget).pausedUntil("key", "background", LAUNCH_ROOM);
      if (until !== null) throw new RateLimitedError("key", until, "reserve");
      await this.dispatch(issue, settings, paseo);
    }
    for (const next of [this.deps.projects, this.deps.repairs]) {
      if (this.stopped || !next) continue;
      const until = (this.deps.budget ?? rateBudget).pausedUntil("key", "background", LAUNCH_ROOM);
      if (until !== null) throw new RateLimitedError("key", until, "reserve");
      await asCaller(next === this.deps.projects ? "project-flow" : "label-repair", () => next.tick(paseo, settings));
    }
  }

  private record(identifier: string, outcome: DispatchStatus["recent"][number]["outcome"], detail: string): void {
    this.status.recent.unshift({ identifier, at: new Date().toISOString(), outcome, detail });
    this.status.recent.length = Math.min(this.status.recent.length, RECENT_LIMIT);
    console.log(`[linear-tickets] auto-dispatch ${identifier}: ${outcome} (${detail})`);
  }

  private async dispatch(issue: LabeledIssue, settings: PluginSettings, paseo: PaseoApi): Promise<void> {
    const { linear } = this.deps;
    const trigger = settings.dispatch.label;
    const labels = dispatchLabels(trigger);
    // A ticket with open sub-issues goes to Paseo as a group (README, "Groups"): its thread hands
    // out the sub-issues, so the label comes off and no agent starts here. A failed check keeps the
    // label for the next poll.
    if (issue.openChildren && this.deps.handOff) {
      try {
        if (await this.deps.handOff(issue.id)) {
          await linear.removeLabel(issue.id, trigger, issue.labels);
          this.record(issue.identifier, "grouped", "assigned to Paseo as a group; its sub-issues are handed out");
          return;
        }
      } catch (error) {
        this.record(issue.identifier, "failed", `handing it to Paseo as a group: ${error instanceof Error ? error.message : error}`);
        return;
      }
    }
    // Another automatic start of the ticket under way (a successor, a thread): the label stays and
    // the next poll finds its agent. Held from the check for an agent through the start.
    const gate = this.deps.launcher.gate(issue.id);
    if (!gate) return;
    try {
      await this.launch(issue, settings, paseo);
    } finally {
      gate.release();
    }
  }

  private async launch(issue: LabeledIssue, settings: PluginSettings, paseo: PaseoApi): Promise<void> {
    const { linear } = this.deps;
    const trigger = settings.dispatch.label;
    const labels = dispatchLabels(trigger);
    // New label activations belong to the peer while this host drains (or while the ticket is
    // claimed there): forwarded durably, never started here.
    const routed = await this.deps.route?.take({ kind: "ticket", issueId: issue.id, identifier: issue.identifier, label: trigger });
    if (routed && "held" in routed) {
      this.record(issue.identifier, "failed", `not forwarded yet: ${routed.held}; the label stays and the next poll retries`);
      return;
    }
    if (routed) {
      this.record(issue.identifier, "launched", `handed to ${routed.peer}: this host forwards new work there`);
      return;
    }
    // Blocked tickets and a full agent limit wait with their label in place; the next poll retries.
    const admission = await this.deps.starter.admission(issue.id, paseo, settings);
    if (!admission.ok) return;
    // The owner asked for this start: an incident of the label repair ends first, durably, so a
    // failure of this start is a new incident with fresh retries. Without that, nothing starts.
    try {
      await this.deps.repairs?.ownerRetried(issue.id);
    } catch (error) {
      this.record(issue.identifier, "failed", `its label repair record could not be reset (${error instanceof Error ? error.message : error}); the label stays and the next poll retries`);
      return;
    }
    // Claim. If the trigger label cannot be removed, nothing else happens: the next poll retries.
    await linear.removeLabel(issue.id, trigger, issue.labels);
    try {
      await linear.addLabel(issue.id, labels.running);
      const existing = await paseo.agents.list({ filter: { labels: { "linear.issueId": issue.id }, includeArchived: false }, page: { limit: 1 } });
      if (existing.entries.length > 0) {
        const agent = existing.entries[0].agent;
        this.record(issue.identifier, "linked", `Already linked to ${agent.title ?? agent.id}`);
        await linear.comment(issue.id, `Paseo already has an active agent for this ticket (${agent.title ?? agent.id}); no new agent was started.`);
        return;
      }
      const started = await this.deps.starter.start(issue.id, paseo, settings, { retryHint: `add the "${trigger}" label again` });
      const { provider, target } = started;
      this.record(issue.identifier, "launched", `${provider} in ${target}${started.resumed ? " (resumed)" : ""}`);
      const inSession = await this.deps.afterLaunch?.(issue.id, issue.identifier, started.agentId).catch(() => false);
      if (inSession) return;
      const warnings = started.warnings.length ? `\n\nWarnings:\n${started.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      await linear.comment(issue.id, `Paseo ${started.resumed ? "resumed the previous agent's work" : "started an agent"} for this ticket (${provider} in ${target}).${warnings}`)
        .catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: start comment failed:`, error instanceof Error ? error.message : error));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.record(issue.identifier, "failed", message);
      // Best-effort: surface the failure on the ticket; `<trigger>-failed` keeps it out of the next poll.
      // Reported at interactive priority: a launch that ran into the key's reserve must still say so.
      await withPriority("interactive", "dispatch failure report", async () => {
        for (const step of [
          () => linear.removeLabel(issue.id, labels.running),
          () => linear.addLabel(issue.id, labels.failed),
          () => linear.comment(issue.id, `Paseo could not start an agent for this ticket: ${message}`),
        ]) {
          await step().catch((failure: unknown) => console.error(`[linear-tickets] ${issue.identifier}: failure reporting failed:`, failure instanceof Error ? failure.message : failure));
        }
      });
    }
  }
}
