import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { DispatchStatus } from "../shared/contracts";
import { mappedBaseBranch, mappingLabel, type ProjectMapping } from "../shared/mapping";
import type { Launcher } from "./launch";
import type { LabeledIssue, LinearService } from "./linear";
import { findProject, readBranches } from "./projects";
import type { PluginSettings, Settings } from "./settings";

const RECENT_LIMIT = 10;
const IDLE_POLL_SECONDS = 60;

type Linear = Pick<LinearService, "labeledIssues" | "detail" | "addLabel" | "removeLabel" | "comment">;
type Deps = {
  linear: Linear;
  launcher: Pick<Launcher, "start">;
  settings: Pick<Settings, "read">;
  branches?: typeof readBranches;
};

// The labels a dispatched ticket moves through, derived from the trigger label so a
// custom trigger ("agent") gets matching companions ("agent-running", "agent-failed").
export function dispatchLabels(trigger: string) {
  return { running: `${trigger}-running`, failed: `${trigger}-failed`, blocked: `${trigger}-blocked` };
}

// Polls Linear for tickets carrying the trigger label and starts one agent per ticket
// through the same Launcher the sidebar uses, so auto-dispatched agents get the same
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
  private readonly branches: typeof readBranches;

  constructor(private readonly deps: Deps) {
    this.branches = deps.branches ?? readBranches;
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
    this.polling = (async () => {
      try {
        const settings = await this.deps.settings.read();
        intervalSeconds = settings.dispatch.intervalSeconds;
        this.status.active = settings.dispatch.enabled && settings.dispatch.teamKeys.length > 0;
        if (!this.status.active || !this.paseo) return;
        await this.poll(settings, this.paseo);
        this.status.lastPollAt = new Date().toISOString();
        this.status.lastError = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        // Logged once per distinct error so a persistent failure does not flood the plugin log.
        if (message !== this.status.lastError) console.error(`[linear-tickets] auto-dispatch poll failed: ${message}`);
        this.status.lastPollAt = new Date().toISOString();
        this.status.lastError = message;
      }
    })();
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
      await this.dispatch(issue, settings, paseo);
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
      const detail = await linear.detail(issue.id);
      const source = { projectId: detail.projectId, projectName: detail.issue.project, teamId: detail.teamId, teamName: detail.issue.team };
      // Only saved mappings dispatch. The sidebar's name-match preselection is a UI hint;
      // guessing the repository for an unattended launch is not.
      const mapping: ProjectMapping | undefined = (source.projectId ? settings.projectMappings[`project:${source.projectId}`] : undefined)
        ?? (source.teamId ? settings.projectMappings[`team:${source.teamId}`] : undefined);
      if (!mapping) {
        throw new Error(`No Paseo project is mapped to ${mappingLabel(source)}. Start one agent for it from the Linear tickets sidebar (that saves the mapping), then add the "${trigger}" label again.`);
      }
      const preference = settings.lastProvider ? settings.launchPreferences[settings.lastProvider] : undefined;
      if (!preference) {
        throw new Error(`No provider has been chosen on this host yet. Start one agent from the Linear tickets sidebar so the plugin remembers the provider and model, then add the "${trigger}" label again.`);
      }
      const project = await findProject(paseo, mapping.projectId);
      let baseBranch: string | undefined;
      if (project.projectKind === "git") {
        const available = await this.branches(project.projectRootPath);
        baseBranch = mappedBaseBranch(mapping.baseBranch, available.branches, available.defaultBranch) || undefined;
        if (!baseBranch) throw new Error(`Could not pick a base branch in ${mapping.label}. Save a base branch for its project mapping.`);
      }
      const result = await this.deps.launcher.start({
        id: issue.id,
        projectId: mapping.projectId,
        baseBranch,
        provider: preference.model,
        modeId: preference.modeId,
        thinkingOptionId: preference.thinkingOptionId,
        instructions: "",
        markInProgress: settings.markInProgress,
        requestId: randomUUID(),
      }, paseo, { promptTemplate: settings.template ?? undefined, markInProgress: settings.markInProgress, linearAccess: settings.agentLinearAccess });
      const target = project.projectCustomName || project.projectDisplayName || mapping.label;
      this.record(issue.identifier, "launched", `${preference.model} in ${target}`);
      const warnings = result.warnings.length ? `\n\nWarnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      await linear.comment(issue.id, `Paseo started an agent for this ticket (${preference.model} in ${target}).${warnings}`)
        .catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: start comment failed:`, error instanceof Error ? error.message : error));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.record(issue.identifier, "failed", message);
      // Best-effort: surface the failure on the ticket; `<trigger>-failed` keeps it out of the next poll.
      for (const step of [
        () => linear.removeLabel(issue.id, labels.running),
        () => linear.addLabel(issue.id, labels.failed),
        () => linear.comment(issue.id, `Paseo could not start an agent for this ticket: ${message}`),
      ]) {
        await step().catch((failure: unknown) => console.error(`[linear-tickets] ${issue.identifier}: failure reporting failed:`, failure instanceof Error ? failure.message : failure));
      }
    }
  }
}
