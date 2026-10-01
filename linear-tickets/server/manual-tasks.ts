import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentApi } from "./agent-app";
import { dispatchLabels } from "./dispatch";
import type { IssueStatus, LinearService } from "./linear";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";
import { appComment } from "./writeback";

const INTERVAL_MS = 60 * 1000;
const MANUAL_COLOR = "#f2994a";
const CHECK_TIMEOUT_MS = 60 * 1000;
const CHECK_OUTPUT_BYTES = 64 * 1024;
const CLOSED = ["canceled", "duplicate"];
const WHEN_TEXT: Record<ManualTask["when"], string> = { before_merge: "before merge", after_merge: "after merge", anytime: "due now" };

// Written by the linear_ticket MCP tool `add_manual_task` (see ticket-mcp-source.ts); the plugin
// owns every field after `createdAt`.
export type ManualTask = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  parentId: string;
  parentIdentifier: string;
  when: "before_merge" | "after_merge" | "anytime";
  // Only ever read from this private file, never from Linear, which anyone in the workspace can edit.
  check: string | null;
  cwd: string;
  createdAt: string;
  announced: boolean;
  activated: boolean;
  // Set when a check passed for the completion Linear reports at `verifiedFor`.
  verifiedAt: string | null;
  verifiedFor?: string | null;
};
export type CheckResult = { ok: boolean; code: number | null; output: string; cwd: string };
type Linear = Pick<LinearService, "addLabel" | "comment" | "createComment" | "updateComment" | "moveToReady" | "reopen" | "issueStatuses" | "viewerId" | "userUrl">;

// Runs a check with no stdin, a timeout and capped output. Tools such as gh and railway live in
// Homebrew, which a daemon's PATH often lacks.
export function runCheck(command: string, cwd: string): Promise<CheckResult> {
  const where = existsSync(cwd) ? cwd : homedir();
  const path = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":");
  // Executor form: the plugin's TypeScript lib predates Promise.withResolvers.
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: where, env: { ...process.env, PATH: path }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { if (output.length < CHECK_OUTPUT_BYTES) output += chunk.toString("utf8").slice(0, CHECK_OUTPUT_BYTES - output.length); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), CHECK_TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, code: null, output: error.message, cwd: where }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output, cwd: where }); });
  });
}

// Manual tasks agents registered for the owner: announces new ones, makes after-merge ones due when
// the pull request merges, and runs a task's check once it is marked done (a failing check reopens
// it). The merge gate itself lives in PullRequestWatch, which asks `openBlockers`.
export class ManualTasks {
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private pausedPool: RateLimitedError["pool"] | null = null;

  constructor(
    private readonly deps: {
      linear: Linear;
      settings: Pick<Settings, "read">;
      comments?: Pick<AgentApi, "createComment" | "updateComment">;
      check?: (command: string, cwd: string) => Promise<CheckResult>;
    },
    private readonly directory = join(paseoHome(), "linear-tickets", "manual-tasks"),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tasks(): Promise<ManualTask[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const tasks = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(this.directory, name), "utf8").then((text) => JSON.parse(text) as ManualTask, () => null)));
    return tasks.filter((task): task is ManualTask => Boolean(task?.id && task.parentId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async save(task: ManualTask): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${task.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(task, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  private async forget(task: ManualTask): Promise<void> {
    await rm(join(this.directory, `${task.id}.json`), { force: true });
  }

  private async mention(issueId: string, body: string): Promise<void> {
    await appComment(this.deps.linear, this.deps.comments, issueId, `${await this.deps.linear.userUrl(await this.deps.linear.viewerId())} ${body}`);
  }

  // After-merge tasks still waiting for the merge keep the ticket's pull request watched.
  async awaitingMerge(issueId: string): Promise<boolean> {
    return (await this.tasks()).some((task) => task.parentId === issueId && !task.activated);
  }

  // Before-merge tasks not done yet. A task marked done whose check has not passed still counts,
  // so the gate never opens between the owner's click and the check.
  async openBlockers(issueId: string): Promise<ManualTask[]> {
    const tasks = (await this.tasks()).filter((task) => task.parentId === issueId && task.when === "before_merge");
    if (!tasks.length) return [];
    const statuses = await this.deps.linear.issueStatuses(tasks.map((task) => task.id));
    return tasks.filter((task) => {
      const status = statuses.get(task.id);
      if (!status || CLOSED.includes(status.statusType)) return false;
      return status.statusType !== "completed" || Boolean(task.check && task.verifiedFor !== status.completedAt);
    });
  }

  // The ticket's pull request merged: after-merge tasks become due (Backlog → Todo), and one
  // comment tells the owner what is due now and what should have been done before.
  async merged(issueId: string): Promise<void> {
    const tasks = (await this.tasks()).filter((task) => task.parentId === issueId);
    const due = tasks.filter((task) => !task.activated);
    const late = await this.openBlockers(issueId);
    for (const task of due) {
      await this.deps.linear.moveToReady(task.id);
      await this.save({ ...task, activated: true });
    }
    const lines = [
      ...(due.length ? ["The pull request was merged. Now due:", ...due.map((task) => `- [${task.identifier}](${task.url}) ${task.title}`)] : []),
      ...(late.length ? [`${due.length ? "\n" : ""}The pull request was merged while these were still open, although they were due before the merge:`, ...late.map((task) => `- [${task.identifier}](${task.url}) ${task.title}`)] : []),
    ];
    if (lines.length) await this.mention(issueId, lines.join("\n"));
  }

  // Background priority: requests stop at their pool's reserve; a pause ends the poll quietly
  // (logged once per pool) and the next poll picks up where this one stopped.
  poll(): Promise<void> {
    this.polling ??= withPriority("background", () => this.run()).catch((error: unknown) => {
      if (!(error instanceof RateLimitedError)) throw error;
      if (this.pausedPool !== error.pool) console.error(`[linear-tickets] manual tasks paused: ${error.message}`);
      this.pausedPool = error.pool;
    }).finally(() => { this.polling = null; });
    return this.polling;
  }

  private async run(): Promise<void> {
    const tasks = await this.tasks();
    if (!tasks.length) return;
    let statuses: Map<string, IssueStatus>;
    try {
      statuses = await this.deps.linear.issueStatuses(tasks.map((task) => task.id));
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      console.error(`[linear-tickets] reading manual tasks failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    const settings = await this.deps.settings.read();
    await this.announce(tasks.filter((task) => !task.announced && statuses.has(task.id)), dispatchLabels(settings.dispatch.label).manual);
    for (const task of tasks) {
      try {
        await this.settle(task, statuses.get(task.id));
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        console.error(`[linear-tickets] manual task ${task.identifier} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    this.pausedPool = null;
  }

  // New tasks get the manual label, and their ticket one comment that mentions the owner.
  private async announce(tasks: ManualTask[], label: string): Promise<void> {
    const byParent = new Map<string, ManualTask[]>();
    for (const task of tasks) byParent.set(task.parentId, [...(byParent.get(task.parentId) ?? []), task]);
    for (const [parentId, group] of byParent) {
      try {
        for (const task of group) await this.deps.linear.addLabel(task.id, label, MANUAL_COLOR);
        const lines = group.map((task) => `- [${task.identifier}](${task.url}) ${task.title} (${WHEN_TEXT[task.when]})`);
        await this.mention(parentId, [`${group.length === 1 ? "A manual task needs" : `${group.length} manual tasks need`} you on this ticket:`, ...lines].join("\n"));
        for (const task of group) await this.save({ ...task, announced: true });
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        console.error(`[linear-tickets] announcing manual tasks for ${group[0].parentIdentifier} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Done tasks run their check once per completion; finished tasks leave the watch list.
  private async settle(task: ManualTask, status: IssueStatus | undefined): Promise<void> {
    if (!status || CLOSED.includes(status.statusType)) return this.forget(task);
    if (status.statusType !== "completed") return;
    if (!task.check) return this.forget(task);
    if (task.verifiedFor === status.completedAt) return;
    const result = await (this.deps.check ?? runCheck)(task.check, task.cwd);
    if (result.ok) {
      await this.deps.linear.comment(task.id, `✓ Verified: the check passed (ran in \`${result.cwd}\`).`);
      await this.forget(task);
      return;
    }
    // The output can hold secrets, so it stays in the plugin log.
    console.error(`[linear-tickets] manual task ${task.identifier}: check exited ${result.code ?? "without a code"}:\n${result.output}`);
    await this.deps.linear.reopen(task.id);
    await this.save({ ...task, verifiedFor: null });
    await this.mention(task.id, `This task was reopened: its check failed (${result.code === null ? "it did not finish" : `exit code ${result.code}`}; ran in \`${result.cwd}\`). The output is in \`paseo plugin logs linear-tickets\`.`);
  }
}
