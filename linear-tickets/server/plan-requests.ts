import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { LinearService } from "./linear";
import { PLAN_LABEL } from "./plan-policy";
import { RateLimitedError, withPriority } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";

const POLL_MS = 60_000;
const STATE_FILE = "state.json";

// One file per requested agent, named by its Paseo agent id. The omp extension
// (omp/linear-tickets-plan-first.ts) watches this directory; keep the two in sync.
export function planRequestsDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "plan-requests");
}

type Prompt = (agentId: string, text: string) => Promise<"sent" | "busy" | "gone" | "unavailable">;
type Deps = { linear: Pick<LinearService, "issueLabels">; prompt: Prompt; directory?: string };
// Per agent: whether its ticket carried the `plan` label at the last poll, and whether the agent
// still has to be told (it was busy, or Paseo was unavailable).
type Entry = { plan: boolean; pending: boolean };
type TicketAgent = { id: string; issueId: string; identifier: string };

export function planRequestText(identifier: string): string {
  return `The owner added the \`plan\` label to ${identifier}: stop, write a plan for the remaining work and submit it for review before you change anything else.`;
}

// The owner adds `plan` to a ticket while its agent works. The label has to appear after the
// agent was first seen (a label present at launch already made the launch plan first), so only a
// change from "no label" to "label" counts. The request is a file the omp extension turns into
// Plannotator's planning phase at the agent's next tool call or prompt, which works mid-turn; the
// message tells the agent why (and is all other providers get). A busy agent is told on a later poll.
export class PlanRequests {
  private paseo: PaseoApi | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private stopped = false;
  private lastError: string | null = null;
  private readonly directory: string;

  constructor(private readonly deps: Deps) {
    this.directory = deps.directory ?? planRequestsDirectory();
  }

  attach(paseo: PaseoApi): void {
    if (this.paseo || this.stopped) return;
    this.paseo = paseo;
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer ?? undefined);
  }

  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = withPriority("background", () => this.run()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof RateLimitedError ? `rate:${error.pool}` : message;
      if (kind !== this.lastError) console.error(`[linear-tickets] plan request poll failed: ${message}`);
      this.lastError = kind;
    }).finally(() => { this.polling = null; });
    return this.polling;
  }

  private async run(): Promise<void> {
    const paseo = this.paseo;
    if (!paseo || this.stopped) return;
    const agents = await ticketAgents(paseo);
    const previous = await this.load();
    const labels = agents.length ? await this.deps.linear.issueLabels(agents.map((agent) => agent.issueId)) : new Map<string, string[]>();
    const next: Record<string, Entry> = {};
    for (const agent of agents) {
      const names = labels.get(agent.issueId);
      const before = previous[agent.id];
      // A ticket Linear did not return keeps its last state.
      if (!names) { if (before) next[agent.id] = before; continue; }
      const plan = names.includes(PLAN_LABEL);
      const entry: Entry = { plan, pending: plan && (before?.pending ?? false) };
      if (plan && before && !before.plan) {
        await this.writeRequest(agent);
        entry.pending = true;
      }
      if (!plan && before?.pending) await rm(join(this.directory, agent.id), { force: true });
      if (entry.pending) entry.pending = await this.tell(agent);
      next[agent.id] = entry;
    }
    await this.save(next);
    await this.removeStale(new Set(agents.map((agent) => agent.id)));
    this.lastError = null;
  }

  // Whether the agent still has to be told. The omp extension removes the request file once the
  // agent is planning, which also covers a busy agent: nothing left to say.
  private async tell(agent: TicketAgent): Promise<boolean> {
    const waiting = await stat(join(this.directory, agent.id)).then(() => true, () => false);
    if (!waiting) return false;
    const outcome = await this.deps.prompt(agent.id, planRequestText(agent.identifier));
    if (outcome === "sent") console.log(`[linear-tickets] ${agent.identifier}: plan requested from agent ${agent.id.slice(0, 8)}`);
    return outcome === "busy" || outcome === "unavailable";
  }

  private async writeRequest(agent: TicketAgent): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, agent.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ identifier: agent.identifier, at: new Date().toISOString() }), { mode: 0o600 });
    await rename(temporary, path);
  }

  // Requests for agents that are gone (archived, deleted) are never picked up.
  private async removeStale(live: Set<string>): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      if (name === STATE_FILE || name.endsWith(".tmp") || live.has(name)) continue;
      await rm(join(this.directory, name), { force: true });
    }
  }

  private async load(): Promise<Record<string, Entry>> {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, STATE_FILE), "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Entry> : {};
    } catch { return {}; }
  }

  private async save(state: Record<string, Entry>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, STATE_FILE);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, path);
  }
}

// Root ticket agents that are not archived, idle or working.
async function ticketAgents(paseo: PaseoApi): Promise<TicketAgent[]> {
  const agents: TicketAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of page.entries) {
      const labels = agent.labels ?? {};
      const issueId = labels["linear.issueId"];
      if (issueId && !labels["paseo.parent-agent-id"]) agents.push({ id: agent.id, issueId, identifier: labels["linear.identifier"] || issueId });
    }
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return agents;
}
