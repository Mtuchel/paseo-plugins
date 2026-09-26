import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { TicketDetail } from "../shared/contracts";
import { mappedBaseBranch, mappingLabel, type ProjectMapping } from "../shared/mapping";
import type { Handover } from "./handover";
import type { Launcher } from "./launch";
import type { LinearService } from "./linear";
import { findProject, readBranches } from "./projects";
import type { PluginSettings } from "./settings";

export type Started = { agentId: string; warnings: string[]; provider: string; target: string; resumed: boolean };
type Deps = {
  linear: Pick<LinearService, "detail">;
  launcher: Pick<Launcher, "start">;
  handover?: Pick<Handover, "resumeTarget">;
  branches?: typeof readBranches;
};

// Starts the agent for one ticket, whatever asked for it (label, delegation, mention, resume):
// saved project mapping, remembered provider, base branch — and, when an earlier agent left a
// handover on this ticket, the same branch and worktree so the new agent continues its work.
export class TicketStarter {
  private readonly branches: typeof readBranches;

  constructor(private readonly deps: Deps) {
    this.branches = deps.branches ?? readBranches;
  }

  async start(issueId: string, paseo: PaseoApi, settings: PluginSettings, options: { labels?: Record<string, string>; retryHint: string; fresh?: boolean }): Promise<Started> {
    const detail: TicketDetail = await this.deps.linear.detail(issueId);
    const source = { projectId: detail.projectId, projectName: detail.issue.project, teamId: detail.teamId, teamName: detail.issue.team };
    // Only saved mappings launch. The sidebar's name-match preselection is a UI hint;
    // guessing the repository for an unattended launch is not.
    const mapping: ProjectMapping | undefined = (source.projectId ? settings.projectMappings[`project:${source.projectId}`] : undefined)
      ?? (source.teamId ? settings.projectMappings[`team:${source.teamId}`] : undefined);
    if (!mapping) {
      throw new Error(`No Paseo project is mapped to ${mappingLabel(source)}. Start one agent for it from the Linear tickets sidebar (that saves the mapping), then ${options.retryHint}.`);
    }
    const preference = settings.lastProvider ? settings.launchPreferences[settings.lastProvider] : undefined;
    if (!preference) {
      throw new Error(`No provider has been chosen on this host yet. Start one agent from the Linear tickets sidebar so the plugin remembers the provider and model, then ${options.retryHint}.`);
    }
    const project = await findProject(paseo, mapping.projectId);
    const target = project.projectCustomName || project.projectDisplayName || mapping.label;
    const resume = options.fresh ? null : await this.deps.handover?.resumeTarget(issueId);
    const base = {
      id: issueId,
      projectId: mapping.projectId,
      provider: preference.model,
      modeId: preference.modeId,
      thinkingOptionId: preference.thinkingOptionId,
      instructions: "",
      markInProgress: settings.markInProgress,
    };
    const launchOptions = { promptTemplate: settings.template ?? undefined, markInProgress: settings.markInProgress, linearAccess: settings.agentLinearAccess, labels: options.labels };
    if (resume && project.projectKind === "git") {
      try {
        const result = await this.deps.launcher.start({ ...base, requestId: randomUUID() }, paseo, { ...launchOptions, resume });
        return { ...result, provider: preference.model, target, resumed: true };
      } catch (error) {
        // A deleted or merged branch cannot be continued; a fresh start is the useful fallback.
        console.error(`[linear-tickets] ${detail.issue.identifier}: resume failed, starting fresh: ${error instanceof Error ? error.message : error}`);
      }
    }
    let baseBranch: string | undefined;
    if (project.projectKind === "git") {
      const available = await this.branches(project.projectRootPath);
      baseBranch = mappedBaseBranch(mapping.baseBranch, available.branches, available.defaultBranch) || undefined;
      if (!baseBranch) throw new Error(`Could not pick a base branch in ${mapping.label}. Save a base branch for its project mapping.`);
    }
    const result = await this.deps.launcher.start({ ...base, baseBranch, requestId: randomUUID() }, paseo, launchOptions);
    return { ...result, provider: preference.model, target, resumed: false };
  }
}
