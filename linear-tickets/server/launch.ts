import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { launchAgentRpc } from "../shared/contracts";
import { existsSync } from "node:fs";
import { attachmentNote, saveAttachments, type Download } from "./attachments";
import { buildPrompt } from "./context";
import type { LinearService } from "./linear";
import { findProject, readBranches } from "./projects";
import { TICKET_MCP_NAME, ticketMcpServer, writeTicketMcpScript } from "./ticket-mcp";

type Start = RpcInput<typeof launchAgentRpc>;
type Result = { agentId: string; warnings: string[] };
// `resume` continues another agent's work: same branch (and worktree while it still exists),
// with the handover text ahead of the ticket prompt. `labels` are added to the agent.
export type ResumeTarget = { branch: string; worktreePath: string | null; handover: string };
type Options = { promptTemplate?: string; markInProgress?: boolean; linearAccess?: boolean; labels?: Record<string, string>; resume?: ResumeTarget };

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

export class Launcher {
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<Result> }>();
  private readonly active = new Map<string, Promise<Result>>();

  constructor(
    private readonly linear: Pick<LinearService, "detail" | "markInProgress">,
    private readonly branches = readBranches,
    private readonly ticketScript: () => Promise<string> = () => writeTicketMcpScript(),
    // Downloads Linear uploads with the host's key; without it attachments stay links.
    private readonly download?: Download,
  ) {}

  start(input: Start, paseo: PaseoApi, options: Options = {}): Promise<Result> {
    const fingerprint = JSON.stringify([input.id, input.projectId, input.baseBranch, input.provider, input.modeId, input.thinkingOptionId, input.instructions, options.promptTemplate ?? "", options.markInProgress ?? false, options.linearAccess ?? false]);
    const prior = this.requests.get(input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(new Error("This launch request has already been used. Reopen the ticket to start another agent."));
      return prior.result;
    }
    const active = this.active.get(fingerprint);
    if (active) {
      this.requests.set(input.requestId, { fingerprint, result: active });
      return active;
    }
    let creationStarted = false;
    const result = this.launch(input, paseo, options, () => { creationStarted = true; });
    this.requests.set(input.requestId, { fingerprint, result });
    this.active.set(fingerprint, result);
    void result.then(() => this.active.delete(fingerprint), () => {
      this.active.delete(fingerprint);
      // A creation request may have succeeded before its response was lost.
      // Keep that result so retrying this request cannot create a second agent.
      if (!creationStarted) {
        for (const [id, entry] of this.requests) {
          if (entry.result === result) this.requests.delete(id);
        }
      }
    });
    return result;
  }

  private async launch(input: Start, paseo: PaseoApi, options: Options, onCreate: () => void): Promise<Result> {
    const project = await findProject(paseo, input.projectId);
    if (project.projectKind === "git" && !options.resume) {
      const available = await this.branches(project.projectRootPath);
      if (!input.baseBranch || !available.branches.some((branch) => branch.id === input.baseBranch)) {
        throw new Error("Select an available base branch for this project.");
      }
    } else if (input.baseBranch && project.projectKind !== "git") {
      throw new Error("This project does not support Git branches.");
    }
    const detail = await this.linear.detail(input.id);
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
    const warnings = [...detail.warnings];
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
    const agent = await workspace.agents.create({
      config: { provider: input.provider, modeId: input.modeId, thinkingOptionId: input.thinkingOptionId, ...(mcpServers ? { mcpServers } : {}) },
      title,
      prompt: [options.resume?.handover, buildPrompt(detail, instructions, options.promptTemplate, options.linearAccess ?? false)].filter(Boolean).join("\n\n"),
      requestId: input.requestId,
      clientMessageId: input.requestId,
      labels: { "linear.issueId": detail.issue.id, "linear.identifier": detail.issue.identifier, "linear.url": detail.issue.url, ...options.labels },
    }).catch((error: unknown) => {
      // Keep the daemon's reason (e.g. a provider failing to start with the ticket MCP server).
      const cause = error instanceof Error && error.message ? ` (${error.message.slice(0, 300)})` : "";
      throw new Error(`Agent creation could not be confirmed${cause}. Check the workspace's agents before reopening this ticket to try again.`);
    });
    if (mcpServers && agent.capabilities?.supportsMcpServers === false) {
      warnings.push("This provider does not load MCP servers, so the agent has no Linear tools. It was still told about them; choose another provider to let it update the ticket.");
    }
    return { agentId: agent.id, warnings };
  }
}
