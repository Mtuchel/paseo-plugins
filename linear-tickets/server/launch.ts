import type { PaseoAgentHandle, PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { launchAgentRpc } from "../shared/contracts";
import { savedMapping } from "../shared/mapping";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentEnvs } from "./agent-env";
import { attachmentNote, saveAttachments, type Download } from "./attachments";
import { buildPrompt, finishedBlockersNote } from "./context";
import { inReviewState, type LinearService } from "./linear";
import { advisorNote, PLAN_CONTEXT_ENV, PLAN_POLICY_ENV, PLAN_REQUIRED_NOTE, PLAN_SECTIONS_NOTE, PLAN_SLICING_NOTE, PLAN_TICKET_ENV, SAFE_MODES } from "./plan-policy";
import { findProject, ProjectUnavailableError, readBranches } from "./projects";
import { repoOrientation } from "./repo-orientation";
import type { PluginSettings } from "./settings";
import { ompExtensionInstalled, paseoHome, TICKET_MCP_ENV, TICKET_MCP_NAME, ticketMcpServer, writeTicketMcpScript, type TicketMcpServer } from "./ticket-mcp";
import { shardDependencies, type ShardAssignor } from "./worktree-shards";

import type { ReviewDeletions } from "./review-deletions";
type Start = RpcInput<typeof launchAgentRpc>;
type Result = { agentId: string; warnings: string[] };
// What a planner run (README, "Projects") launches through Launcher.startPlanner: the run, its
// Linear project and team (the mapping fallback) and the ticket brief the planner's prompt is
// built from. `requestId` dedupes the start: a retry of the same attempt never starts a second
// agent (the run's own record is the retry state).
export type PlannerStart = { runId: string; linearProjectId: string; projectName: string; teamId: string; requestId: string; brief: string };
// `resume` continues another agent's work: same branch (and worktree while it still exists),
// with the handover text ahead of the ticket prompt. `labels` are added to the agent, `env` to
// its provider process. `lead`: why Paseo started the agent now (the pull request's next step for
// a successor the pull request watch started), the last part of its first prompt.
export type ResumeTarget = { branch: string; worktreePath: string | null; handover: string };
type Options = { promptTemplate?: string; markInProgress?: boolean; linearAccess?: boolean; labels?: Record<string, string>; env?: Record<string, string>; resume?: ResumeTarget; lead?: string };
// A held per-ticket start gate (see Launcher.gate); `release` is idempotent.
export type Gate = { release(): void };
export const LEAD_INTRO = "Paseo started you because the pull request needs this now:";
// A start that cannot succeed until the owner fixes this host's setup: no Paseo project mapped, no
// provider chosen, no usable base branch, branches for a project without Git. Retrying it changes
// nothing, so the label repair stops at the first one (README, "Repairing stale running and failed labels").
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

// Linear computes the branch name with the workspace's branch-format setting, so it is
// the name users expect — but a stored value is not guaranteed to be a safe git ref.
const UNSAFE_BRANCH_CHARS = "~^:?*[]\\";
export function safeBranchName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 250 || /\s/.test(name)) return null;
  if (name.includes("..") || name.includes("@{") || name.endsWith(".lock")) return null;
  if (name.startsWith("/") || name.startsWith(".") || name.endsWith("/") || name.endsWith(".")) return null;
  if ([...name].some((char) => char.charCodeAt(0) < 0x20 || UNSAFE_BRANCH_CHARS.includes(char))) return null;
  return name;
}

// A failed worktree create that names an existing branch is the only workspace failure
// worth retrying: git reports it as "a branch named '<name>' already exists".
function isBranchCollision(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
}

// Saves the prompt a ticket agent starts with, so the plan advisor it consults reads the same
// ticket context (README, "Plan advisor"). One file per launch request; returns its path.
export async function writePlanContext(requestId: string, prompt: string, directory = join(paseoHome(), "linear-tickets", "plan-context")): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${requestId.replace(/[^A-Za-z0-9-]/g, "_")}.md`);
  await writeFile(`${path}.tmp`, prompt, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return path;
}

export class Launcher {
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<Result> }>();
  private readonly active = new Map<string, Promise<Result>>();
  // Launches under way per ticket, from any start path (sidebar, label, thread, project).
  private readonly launching = new Map<string, number>();
  // Tickets whose automatic start path holds the start gate (see gate).
  private readonly gates = new Set<string>();
  private deletions: Pick<ReviewDeletions, "blocked"> | null = null;
  private readonly pending = new Map<string, Set<Promise<Result>>>();
  private readonly canonicalIds = new Map<string, string>();

  constructor(
    private readonly linear: Pick<LinearService, "detail" | "markInProgress" | "finishedBlockers">,
    private readonly branches = readBranches,
    private readonly ticketScript: () => Promise<string> = () => writeTicketMcpScript(),
    // Downloads Linear uploads with the host's key; without it attachments stay links.
    private readonly download?: Download,
    private readonly planContext: (requestId: string, prompt: string) => Promise<string> = writePlanContext,
    // Whether the plugin's omp extension is installed; it gives omp agents the ticket tools.
    private readonly ompTools: () => boolean = ompExtensionInstalled,
    // Where each agent's ticket environment is kept for its resumed sessions (agent-env.ts).
    private readonly envs: Pick<AgentEnvs, "save"> = new AgentEnvs(),
    // When set, returns why this ticket must not start here (README, "Draining a host"): the
    // backstop for every start path that did not route the activation first (the sidebar
    // included). Never consulted for a ticket an allowed local agent still owns.
    private readonly blocked?: (issueId: string) => Promise<string | null>,
    // Which of a repository's clones a launch belongs to (README, "Worktree shards"); without it
    // every launch uses the mapped project.
    private readonly shards?: ShardAssignor,
  ) {}

  useDeletions(deletions: Pick<ReviewDeletions, "blocked">): void {
    this.deletions = deletions;
  }

  async settledFor(issueId: string): Promise<void> {
    for (;;) {
      const pending = [...this.pending].flatMap(([id, work]) => id === issueId || this.canonicalIds.get(id) === issueId ? [...work] : []);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  start(input: Start, paseo: PaseoApi, options: Options = {}): Promise<Result> {
    const fingerprint = JSON.stringify([input.id, input.projectId, input.baseBranch, input.provider, input.modeId, input.thinkingOptionId, input.instructions, options.promptTemplate ?? "", options.markInProgress ?? false, options.linearAccess ?? false, options.lead ?? ""]);
    return this.tracked(input.id, input.requestId, fingerprint, "This launch request has already been used. Reopen the ticket to start another agent.", (onCreate) => this.launch(input, paseo, options, onCreate));
  }

  // Starts the agent of a planner run (README, "Projects"): no Linear ticket, no branch, no
  // worktree — a directory workspace in the project root, like the planners before it. The run id
  // is the agent's identity (`linear.plannerRun`); the mapping and provider come from the same
  // saved settings every launch uses.
  startPlanner(input: PlannerStart, paseo: PaseoApi, settings: PluginSettings): Promise<Result> {
    const fingerprint = JSON.stringify([input.runId, input.requestId]);
    return this.tracked(input.runId, input.requestId, fingerprint, "This planner start has already been used.", (onCreate) => this.launchPlanner(input, paseo, settings, onCreate));
  }

  // One start per ticket (or run) and request id, from any start path: a repeated request id
  // returns what the first one did, and a launch still under way is joined instead of doubled.
  private tracked(id: string, requestId: string, fingerprint: string, reused: string, work: (onCreate: () => void) => Promise<Result>): Promise<Result> {
    const prior = this.requests.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(new Error(reused));
      return prior.result;
    }
    const active = this.active.get(fingerprint);
    if (active) {
      this.requests.set(requestId, { fingerprint, result: active });
      return active;
    }
    let creationStarted = false;
    const result = work(() => { creationStarted = true; });
    this.requests.set(requestId, { fingerprint, result });
    this.active.set(fingerprint, result);
    this.launching.set(id, (this.launching.get(id) ?? 0) + 1);
    const pending = this.pending.get(id) ?? new Set<Promise<Result>>();
    pending.add(result);
    this.pending.set(id, pending);
    const settled = () => {
      this.active.delete(fingerprint);
      const left = (this.launching.get(id) ?? 1) - 1;
      if (left) this.launching.set(id, left);
      else this.launching.delete(id);
      pending.delete(result);
      if (!pending.size) { this.pending.delete(id); this.canonicalIds.delete(id); }
    };
    void result.then(settled, () => {
      settled();
      // A creation request may have succeeded before its response was lost.
      // Keep that result so retrying this request cannot create a second agent.
      if (!creationStarted) {
        for (const [key, entry] of this.requests) {
          if (entry.result === result) this.requests.delete(key);
        }
      }
    });
    return result;
  }

  underWay(issueId: string): boolean {
    return this.launching.has(issueId) || this.gates.has(issueId);
  }

  // One automatic start per ticket at a time (README, "Stalled pull requests"): every automatic
  // start path (label dispatch, thread start and its queue, project restart, auto-resume, the pull
  // request watch's successor) takes the gate before it checks for a live agent and holds it through
  // admission and creation. Null while another path holds it or any launch of the ticket is under
  // way (the sidebar's included); that path then takes its own "wait". Synchronous and never
  // waiting, so holding it while awaiting the ticket's turn (SessionRouter.exclusive) cannot deadlock.
  gate(issueId: string): Gate | null {
    if (this.underWay(issueId)) return null;
    this.gates.add(issueId);
    let held = true;
    return { release: () => { if (held) { held = false; this.gates.delete(issueId); } } };
  }

  // The requested base branch must exist in the project that will create the worktree (which a
  // shard assignment may have moved, README "Worktree shards"): a local read, before any Linear
  // call or workspace creation.
  private async requireBaseBranch(project: { projectKind: string; projectRootPath: string }, baseBranch: string | undefined, resuming: boolean): Promise<void> {
    if (project.projectKind === "git" && !resuming) {
      const available = await this.branches(project.projectRootPath);
      if (!baseBranch || !available.branches.some((branch) => branch.id === baseBranch)) {
        throw new SetupError("Select an available base branch for this project.");
      }
    } else if (baseBranch && project.projectKind !== "git") {
      throw new SetupError("This project does not support Git branches.");
    }
  }

  private async launch(input: Start, paseo: PaseoApi, options: Options, onCreate: () => void): Promise<Result> {
    if (await this.deletions?.blocked(input.id)) throw new Error("This ticket is paused for deletion; no agent was started.");
    const blocked = await this.blocked?.(input.id);
    if (blocked) throw new Error(blocked);
    const mapped = await findProject(paseo, input.projectId);
    // Which of the repository's clones this launch belongs to (README, "Worktree shards"): a
    // ticket's recorded work, the worktree a resume continues, its base branch and each clone's
    // load are known without Linear, so they are assigned first — a launch whose base branch is
    // gone still fails before any Linear read. The ticket's own branch and its parent/blockers need
    // the ticket detail below and refine the choice. A failed assignment never blocks a launch.
    const shards = this.shards;
    const assign = (ticket: { id: string; branch: string | null; dependencies: string[] }) => shards!.assign({
      requested: { projectId: mapped.projectId, rootPath: mapped.projectRootPath },
      ticket,
      resume: options.resume ? { worktreePath: options.resume.worktreePath, branch: options.resume.branch } : null,
      baseBranch: input.baseBranch,
    }, paseo);
    const failSafe = (error: unknown) => {
      console.error(`[linear-tickets] ${input.id}: worktree shard assignment failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    };
    const first = shards ? await assign({ id: input.id, branch: null, dependencies: [] }).catch(failSafe) : null;
    const firstProject = first ? await findProject(paseo, first.projectId) : mapped;
    await this.requireBaseBranch(firstProject, input.baseBranch, Boolean(options.resume));
    const detail = await this.linear.detail(input.id);
    this.canonicalIds.set(input.id, detail.issue.id);
    const shard = shards ? await assign({ id: detail.issue.id, branch: safeBranchName(detail.issue.branchName), dependencies: shardDependencies(detail.relations) }).catch(failSafe) : null;
    const project = shard ? await findProject(paseo, shard.projectId) : firstProject;
    if (shard && shard.rootPath !== firstProject.projectRootPath) await this.requireBaseBranch(project, input.baseBranch, Boolean(options.resume));
    if (shard) console.log(`[linear-tickets] ${detail.issue.identifier} launches in ${shard.label} (${shard.reason}).`);
    const warnings = [...detail.warnings, ...(first?.notes ?? []), ...(shard?.notes ?? [])];
    // A clone that has not fetched for a while would branch off a stale base; refresh it before
    // the worktree is created. Best effort and only for a fresh start (a resume keeps its worktree).
    if (shard && !options.resume && shard.rootPath !== mapped.projectRootPath) {
      const refreshNote = await this.shards?.refresh(shard.rootPath);
      if (refreshNote) warnings.push(refreshNote);
    }
    if (await this.deletions?.blocked(detail.issue.id)) throw new Error("This ticket is paused for deletion; no agent was started.");
    // Written before any creation so a failure here cannot leave a half-launched ticket.
    const mcpServers = options.linearAccess ? { [TICKET_MCP_NAME]: ticketMcpServer(await this.ticketScript(), detail.issue.id) } : undefined;
    onCreate();
    const title = `${detail.issue.identifier}: ${detail.issue.title}`.slice(0, 60);
    const slug = detail.issue.identifier.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "ticket";
    // Prefer Linear's canonical branch name. Unlike the synthesized fallback it carries no
    // request suffix, so a second launch of the same ticket would collide: retry exactly
    // once with the short request-id suffix before surfacing any other failure.
    const canonical = safeBranchName(detail.issue.branchName);
    const fallback = `${slug}-${input.requestId.slice(0, 8)}`;
    const branchNames = project.projectKind === "git" ? (canonical ? [canonical, `${canonical}-${input.requestId.slice(0, 8)}`] : [fallback]) : [fallback];
    let workspace;
    if (options.resume) {
      const { branch, worktreePath } = options.resume;
      // The old worktree keeps uncommitted work, so it is reused while it exists; otherwise
      // the branch is checked out into a new worktree.
      workspace = await paseo.workspaces.create({
        title,
        requestId: `${input.requestId}-workspace`,
        source: worktreePath && existsSync(worktreePath)
          ? { kind: "directory", projectId: project.projectId, path: worktreePath }
          : { kind: "worktree", projectId: project.projectId, cwd: project.projectRootPath, action: "checkout", refName: branch },
      }).catch((error: unknown) => {
        throw new Error(`Could not reopen branch ${branch} for the resumed agent: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    } else for (let attempt = 0; ; attempt++) {
      try {
        workspace = await paseo.workspaces.create({
          title,
          // A distinct request id keeps the suffixed retry from being deduplicated as the failed create.
          requestId: `${input.requestId}-workspace${attempt ? "-retry" : ""}`,
          source: project.projectKind === "git"
            ? { kind: "worktree", projectId: project.projectId, cwd: project.projectRootPath, action: "branch-off", baseBranch: input.baseBranch, branchName: branchNames[attempt] }
            : { kind: "directory", projectId: project.projectId, path: project.projectRootPath },
        });
        break;
      } catch (error) {
        if (project.projectKind !== "git" || attempt >= branchNames.length - 1 || !isBranchCollision(error)) {
          throw new Error("Workspace creation could not be confirmed. Check this project's workspaces before reopening the ticket to try again.");
        }
      }
    }
    // Before the agent exists, so its first prompt can point at the local copies.
    let instructions = input.instructions;
    const cwd = workspace.directory ?? (project.projectKind === "git" ? null : project.projectRootPath);
    if (this.download && cwd) {
      try {
        const saved = await saveAttachments(cwd, detail.issue.identifier, detail.context, this.download);
        warnings.push(...saved.warnings);
        instructions = [instructions.trim(), attachmentNote(saved)].filter(Boolean).join("\n\n");
      } catch (error) {
        warnings.push(`Could not save the ticket's Linear attachments: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    // Never fails the launch: without a readable checkout only the scout and library-lookup notes are added.
    const orientation = await repoOrientation({ cwd, git: project.projectKind === "git", provider: input.provider, detail });
    warnings.push(...orientation.warnings);
    instructions = [instructions.trim(), orientation.note].filter(Boolean).join("\n\n");
    // The agent that starts after its blockers builds on what they did. Blockers in review are kept
    // only when their pull requests are merged (`finishedBlockers` checks). Never fails the launch.
    const finished = detail.relations.related.filter((ticket) => ticket.direction === "blocked by" && (ticket.statusType === "completed" || inReviewState(ticket.status, ticket.statusType)));
    if (finished.length) {
      try {
        instructions = [instructions.trim(), finishedBlockersNote(await this.linear.finishedBlockers(finished.map((ticket) => ticket.id)))].filter(Boolean).join("\n\n");
      } catch (error) {
        warnings.push(`Could not read what the finished blockers (${finished.map((ticket) => ticket.identifier).join(", ")}) left behind: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    if (options.markInProgress) {
      // Best-effort, and before the agent exists so its own set_status calls always come
      // after this one. A failed transition only warns; the request dedupe above keeps a
      // retried identical launch from re-running it.
      try {
        const outcome = await this.linear.markInProgress(detail.issue, detail.teamId);
        if (!outcome.changed && outcome.note) warnings.push(outcome.note);
      } catch (error) {
        warnings.push(`Could not mark the ticket in progress: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    // The ticket marks the agent for the plan advisor gate even when its context cannot be saved.
    const agent = await this.createAgent(workspace, input.requestId, {
      title,
      provider: input.provider,
      modeId: input.modeId,
      thinkingOptionId: input.thinkingOptionId,
      // The prompt is built per attempt, so the retry without tools never promises them.
      prompt: (linearAccess) => [options.resume?.handover, buildPrompt(detail, instructions, options.promptTemplate, linearAccess), options.lead ? `${LEAD_INTRO}\n\n${options.lead}` : ""].filter(Boolean).join("\n\n"),
      labels: { "linear.issueId": detail.issue.id, "linear.identifier": detail.issue.identifier, "linear.url": detail.issue.url, ...options.labels },
      env: { ...options.env, [PLAN_TICKET_ENV]: detail.issue.identifier },
      mcpServers,
      warnings,
      retry: "Check the workspace's agents before reopening this ticket to try again.",
      blocked: async () => (await this.deletions?.blocked(detail.issue.id)) ? "This ticket is paused for deletion; no agent was started." : null,
    });
    return { agentId: agent.id, warnings };
  }

  // The agent of one planner run (README, "Projects"): the brief plus the notes a planner is given
  // under the required policy, in the saved project mapping, on the saved provider and its safe
  // mode. No branch and no worktree — the planner writes no code and runs in the project root, as
  // the ticket planners did. The run id is the agent's label, which routes its work order
  // (plannotator.ts).
  private async launchPlanner(input: PlannerStart, paseo: PaseoApi, settings: PluginSettings, onCreate: () => void): Promise<Result> {
    const mapping = savedMapping({ projectId: input.linearProjectId, teamId: input.teamId }, settings.projectMappings);
    if (!mapping) throw new SetupError(`No Paseo project is mapped to ${input.projectName} or its team. Start one agent from the Linear tickets sidebar (that saves the mapping), then Plan starts the run again.`);
    const preference = settings.lastProvider ? settings.launchPreferences[settings.lastProvider] : undefined;
    if (!preference) throw new SetupError("No provider has been chosen on this host yet. Start one agent from the Linear tickets sidebar so the plugin remembers the provider and model, then Plan starts the run again.");
    const project = await findProject(paseo, mapping.projectId).catch((error: unknown) => {
      if (error instanceof ProjectUnavailableError) throw new SetupError(error.message);
      throw error;
    });
    const providerKey = preference.model.split("/")[0];
    const warnings: string[] = [];
    const title = `Plan the work order of ${input.projectName}`.slice(0, 60);
    const prompt = [input.brief, PLAN_REQUIRED_NOTE, PLAN_SECTIONS_NOTE, PLAN_SLICING_NOTE, advisorNote(providerKey)].join("\n\n");
    // Written before any creation, so a lost response cannot leave the run without a record while
    // its agent exists (the run's next attempt adopts a live agent instead of starting one).
    onCreate();
    const workspace = await paseo.workspaces.create({
      title,
      requestId: `${input.requestId}-workspace`,
      source: { kind: "directory", projectId: project.projectId, path: project.projectRootPath },
    });
    const agent = await this.createAgent(workspace, input.requestId, {
      title,
      provider: preference.model,
      modeId: SAFE_MODES[providerKey] ?? preference.modeId,
      thinkingOptionId: preference.thinkingOptionId,
      prompt: () => prompt,
      labels: { "linear.plannerRun": input.runId, "linear.projectId": input.linearProjectId, "linear.plannerRequest": input.requestId },
      // The ticket env is a flag for the plugin's omp extension (its plan gate, record_plan_advice
      // and ticket tools); no Linear ticket is behind it.
      env: { [PLAN_POLICY_ENV]: "required", [PLAN_TICKET_ENV]: `project-planner:${input.runId}` },
      mcpServers: settings.agentLinearAccess ? { [TICKET_MCP_NAME]: ticketMcpServer(await this.ticketScript(), null) } : undefined,
      warnings,
      retry: "Check the host's agents before the project's next read tries again.",
    });
    return { agentId: agent.id, warnings };
  }

  // Creates the agent in `workspace` and saves its environment for its resumed sessions
  // (agent-env.ts). Shared by ticket launches and planner runs: the ticket server is handed to the
  // provider as an MCP server (attach), or, for an omp that learns MCP, as TICKET_MCP_ENV for the
  // plugin's omp extension; a provider the daemon refuses MCP servers for starts again without the
  // tools and with the no-write prompt.
  private async createAgent(workspace: PaseoWorkspaceHandle, contextRequestId: string, spec: {
    title: string; provider: string; modeId: string | undefined; thinkingOptionId: string | undefined;
    prompt: (linearAccess: boolean) => string; labels: Record<string, string>; env: Record<string, string>;
    mcpServers: Record<string, TicketMcpServer> | undefined; warnings: string[];
    retry: string; blocked?: () => Promise<string | null>;
  }): Promise<PaseoAgentHandle> {
    const create = async (linearAccess: boolean, requestId: string, attach: boolean) => {
      const prompt = spec.prompt(linearAccess);
      let env: Record<string, string> = { ...spec.env };
      if (linearAccess && spec.mcpServers) env[TICKET_MCP_ENV] = JSON.stringify(spec.mcpServers[TICKET_MCP_NAME]);
      try {
        env = { ...env, [PLAN_CONTEXT_ENV]: await this.planContext(contextRequestId, prompt) };
      } catch (error) {
        spec.warnings.push(`Could not save the context for the plan advisor: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      const blocked = await spec.blocked?.();
      if (blocked) throw new Error(blocked);
      const agent = await workspace.agents.create({
        config: { provider: spec.provider, modeId: spec.modeId, thinkingOptionId: spec.thinkingOptionId, ...(linearAccess && attach && spec.mcpServers ? { mcpServers: spec.mcpServers } : {}) },
        title: spec.title,
        prompt,
        requestId,
        clientMessageId: requestId,
        labels: spec.labels,
        env,
      });
      // Never fails the launch: a resumed session then still gets its environment from its labels.
      await this.envs.save(agent.id, env).catch((error: unknown) => {
        spec.warnings.push(`Could not save the agent's environment for its resumed sessions: ${error instanceof Error ? error.message : "unknown error"}`);
      });
      return agent;
    };
    const unconfirmed = (error: unknown) => {
      // Keep the daemon's reason (e.g. a provider failing to start with the ticket MCP server).
      const cause = error instanceof Error && error.message ? ` (${error.message.slice(0, 300)})` : "";
      return new Error(`Agent creation could not be confirmed${cause}. ${spec.retry}`);
    };
    let withTools = Boolean(spec.mcpServers);
    // Attaching the server too would give an omp that learns MCP every tool twice.
    const viaExtension = withTools && (spec.provider === "omp" || spec.provider.startsWith("omp/")) && this.ompTools();
    const agent = await create(withTools, contextRequestId, !viaExtension).catch(async (error: unknown) => {
      // The daemon refuses MCP servers for providers that cannot load them before it creates
      // anything, so the same agent starts again without the Linear ticket tools and with the no-write note.
      if (!withTools || viaExtension || !(error instanceof Error && error.message.includes("does not support MCP servers"))) throw unconfirmed(error);
      withTools = false;
      spec.warnings.push("This provider does not load MCP servers, so the agent started without the Linear ticket tools and was told not to change Linear; choose another provider (for omp, install the plugin's omp extension) to let it update Linear.");
      return create(false, `${contextRequestId}-no-mcp`, false).catch((retryError: unknown) => { throw unconfirmed(retryError); });
    });
    if (withTools && !viaExtension && agent.capabilities?.supportsMcpServers === false) {
      spec.warnings.push("This provider does not load MCP servers, so the agent has no Linear tools. It was still told about them; choose another provider to let it update Linear.");
    }
    return agent;
  }
}
