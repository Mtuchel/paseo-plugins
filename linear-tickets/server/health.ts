import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LinearService } from "./linear";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
// A problem must show up on two checks in a row, so a network blip does not page you.
const CONFIRMATIONS = 2;

export type HealthCheck = { name: string; run: () => Promise<void> };
type Linear = Pick<LinearService, "createIssue" | "updateDescription" | "comment" | "complete" | "teamIdByKey" | "viewerId">;
type State = { issueId: string | null; problems: Record<string, string> };

export function healthDescription(problems: Record<string, string>, at: string): string {
  return [
    `Paseo's Linear integration found problems on the host (checked ${at.slice(0, 16).replace("T", " ")} UTC):`,
    ...Object.entries(problems).map(([name, message]) => `- **${name}:** ${message}`),
    "",
    "While this ticket is open, agent sessions may start late or not at all; missed sessions are picked up once the problem is fixed. The ticket completes itself when every check passes again.",
  ].join("\n");
}

// Checks the pieces Linear-driven agents depend on every 5 minutes. A confirmed problem opens
// (or updates) one urgent ticket assigned to you, so Linear's app notifies you on your phone;
// recovery comments and completes it.
export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly strikes = new Map<string, number>();
  private running = false;

  constructor(
    private readonly linear: Linear,
    private readonly settings: Pick<Settings, "read">,
    private readonly checks: HealthCheck[],
    private readonly path = join(paseoHome(), "linear-tickets", "health.json"),
    private readonly now = () => new Date().toISOString(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { void this.tick(); }, FIRST_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    await this.check().catch((error: unknown) => console.error(`[linear-tickets] health check failed: ${error instanceof Error ? error.message : error}`));
    this.timer = setTimeout(() => { void this.tick(); }, INTERVAL_MS);
    this.timer.unref?.();
  }

  private async state(): Promise<State> {
    try { return JSON.parse(await readFile(this.path, "utf8")); } catch { return { issueId: null, problems: {} }; }
  }

  private async save(state: State): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  // Runs every check once; returns the confirmed problems.
  async check(): Promise<Record<string, string>> {
    if (this.running) return {};
    this.running = true;
    try {
      const confirmed: Record<string, string> = {};
      for (const check of this.checks) {
        try {
          await check.run();
          this.strikes.delete(check.name);
        } catch (error) {
          const strikes = (this.strikes.get(check.name) ?? 0) + 1;
          this.strikes.set(check.name, strikes);
          if (strikes >= CONFIRMATIONS) confirmed[check.name] = error instanceof Error ? error.message.slice(0, 300) : "failed";
        }
      }
      await this.report(confirmed);
      return confirmed;
    } finally {
      this.running = false;
    }
  }

  private async report(problems: Record<string, string>): Promise<void> {
    const state = await this.state();
    const names = Object.keys(problems).sort();
    const known = Object.keys(state.problems).sort();
    if (JSON.stringify(names) === JSON.stringify(known)) return;
    if (!names.length) {
      if (state.issueId) {
        await this.linear.comment(state.issueId, "✅ All checks pass again.");
        await this.linear.complete(state.issueId);
      }
      await this.save({ issueId: null, problems: {} });
      return;
    }
    const description = healthDescription(problems, this.now());
    if (state.issueId) {
      await this.linear.updateDescription(state.issueId, description);
      await this.linear.comment(state.issueId, `Problems now: ${names.join(", ")}.`);
      await this.save({ issueId: state.issueId, problems });
      return;
    }
    const teamKey = (await this.settings.read()).dispatch.teamKeys[0];
    const teamId = teamKey ? await this.linear.teamIdByKey(teamKey) : null;
    if (!teamId) {
      console.error(`[linear-tickets] health problems (no auto-dispatch team to report in): ${names.join(", ")}`);
      await this.save({ issueId: null, problems });
      return;
    }
    const issue = await this.linear.createIssue({ teamId, title: "⚠️ Paseo needs attention", description, assigneeId: await this.linear.viewerId(), priority: 1 });
    await this.save({ issueId: issue.id, problems });
  }
}
