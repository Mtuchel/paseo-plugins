import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { LinearService } from "./linear";
import type { LabelEvent } from "./label-rules";
import { documentPlanHash } from "./review-outcome";
import { loadProbe } from "./load-probe";
import { PLAN_LABEL } from "./plan-policy";
import { RateLimitedError, withPriority } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";
import type { PromptOutcome } from "./sessions";
import type { SmallRoutes } from "./small-route";

const POLL_MS = 60_000;
const STATE_FILE = "state.json";
const APPS_FILE = "trusted-apps.json";
// How long a verified peer app stays usable without asking the peer again (one inbox poll is
// cheaper than one per request read).
const APPS_TTL_MS = 60_000;
const OP_MARKER = /<!--\s*replan-op:\s*([0-9a-f-]{36})\s*-->/i;
const FOR_MARKER = /<!--\s*replan-for:\s*([0-9a-f]{64})\s*-->/i;
const FIRST_LINE = "🔁 **Replan requested**";

// One file per requested agent, named by its Paseo agent id. The omp extension
// (omp/linear-tickets-plan-first.ts) watches this directory; keep the two in sync.
export function planRequestsDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "plan-requests");
}

// A request to plan again (README, "Related work"): a replan comment a trusted Paseo app wrote on
// the ticket, or the owner's own `plan` label add. The id survives the label: the label is only the
// visible indicator, and losing it never hides a request.
export type PlanRequest = {
  id: string;
  at: string;
  kind: "comment" | "label";
  authorId: string | null;
  // The request's text (a comment's body) and its first own line, for the planner's brief.
  body?: string;
  reason?: string;
  commentId?: string;
};

type Prompt = (agentId: string, text: string) => Promise<PromptOutcome>;
type Deps = {
  linear: Pick<LinearService, "issueDocument" | "replanComments" | "existingLabelId" | "labelHistory" | "viewerId">;
  apps: Pick<TrustedApps, "ids">;
  prompt: Prompt;
  directory?: string;
  // The small-ticket route, which refuses `plan`: the owner's label add is taken as a request there.
  routes?: Pick<SmallRoutes, "ownerRequested">;
};
// Per agent: the request ids delivered to it, and when the planning round it answers started (the
// newest request delivered; null until one was).
type Entry = { handled: string[]; roundStartedAt: string | null };
type TicketAgent = { id: string; issueId: string; identifier: string; createdAt: string; provider: string };

export function planRequestText(identifier: string, request?: PlanRequest): string {
  const why = request?.kind === "comment"
    ? "Another ticket's approved plan asked for this plan to be revised"
    : `The owner added the \`${PLAN_LABEL}\` label`;
  return `${why} on ${identifier}: stop, write a plan for the remaining work and submit it for review before you change anything else.`;
}

// The Paseo app users whose replan comments count (README, "Related work"): this host's app, and
// the `appUserId` every peer currently listed in `reviewPeers` reported on `/api/inbox`, persisted
// per peer origin in `$PASEO_HOME/linear-tickets/trusted-apps.json`. A listed peer that is
// unreachable keeps its last verified id; a peer that answers without one loses it; a peer removed
// from `reviewPeers` loses its trust at once (the peer list is exactly what is asked).
export class TrustedApps {
  private cached: { at: number; ids: string[] } | null = null;

  constructor(private readonly deps: {
    appUserId: () => Promise<string | null>;
    peerApps: () => Promise<{ origin: string; reachable: boolean; appUserId: string | null }[]>;
    directory?: string;
    now?: () => number;
  }) {}

  async ids(): Promise<string[]> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.cached && now - this.cached.at < APPS_TTL_MS) return this.cached.ids;
    const path = join(this.deps.directory ?? join(paseoHome(), "linear-tickets"), APPS_FILE);
    const stored = await readApps(path);
    let peers: { origin: string; reachable: boolean; appUserId: string | null }[] = [];
    // A peer list that cannot be read trusts nobody: fail closed, a comment waits in Linear.
    try { peers = await this.deps.peerApps(); } catch { peers = []; }
    const next: typeof stored = {};
    for (const peer of peers) {
      if (peer.reachable) { if (peer.appUserId) next[peer.origin] = { appUserId: peer.appUserId, at: new Date(now).toISOString() }; }
      else if (stored[peer.origin]) next[peer.origin] = stored[peer.origin];
    }
    await writeApps(path, next);
    const own = await this.deps.appUserId().catch(() => null);
    const ids = [...new Set([own, ...Object.values(next).map((peer) => peer.appUserId)].filter((id): id is string => Boolean(id)))];
    this.cached = { at: now, ids };
    return ids;
  }
}

// The owner adds `plan` to a ticket while its agent works, or another ticket's approved plan asks
// for a replan. A request is delivered once per agent as a file the omp extension turns into
// Plannotator's planning phase at the agent's next tool call or prompt, plus a message telling the
// agent why. The file waits for an omp agent's next tool call; a provider without the extension has
// only the message, so its request stays pending until a poll sends it.
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
    this.polling = loadProbe.time("plan-requests", () => withPriority("background", "plan-requests", () => this.run())).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof RateLimitedError ? `rate:${error.pool}` : message;
      if (kind !== this.lastError) console.error(`[linear-tickets] plan request poll failed: ${message}`);
      this.lastError = kind;
    }).finally(() => { this.polling = null; });
    return this.polling;
  }

  // The requests on a ticket since a time, oldest first: trusted replan comments (about `planHash`
  // when one is given) and `plan` label adds by the owner. A comment from any other author is
  // ignored and logged; a peer app not known here yet leaves its comment in Linear until it is.
  async requests(issueId: string, identifier: string, since: string | null, planHash: string | null, asked?: Set<string>): Promise<PlanRequest[]> {
    const trusted = asked ?? new Set(await this.deps.apps.ids());
    const requests: PlanRequest[] = [];
    for (const comment of await this.deps.linear.replanComments(issueId, since ?? "1970-01-01T00:00:00.000Z")) {
      const opId = OP_MARKER.exec(comment.body)?.[1];
      if (!opId || !comment.body.includes(FIRST_LINE)) continue;
      const about = FOR_MARKER.exec(comment.body)?.[1] ?? null;
      // The request names the plan it is about: a comment written against a replaced plan is stale
      // (and one on a ticket with no approved plan has nothing to revise).
      if (about !== planHash) {
        console.error(`[linear-tickets] ${identifier}: ignoring the replan request ${opId} written for another plan (${about?.slice(0, 8) ?? "none"})`);
        continue;
      }
      if (!comment.authorId || !trusted.has(comment.authorId)) {
        console.error(`[linear-tickets] ${identifier}: ignoring the replan request ${opId} from ${comment.authorId ?? "an unknown author"}`);
        continue;
      }
      const reason = comment.body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith(FIRST_LINE) && !line.startsWith("<!--") && !line.startsWith("["));
      requests.push({ id: `op:${opId}`, at: comment.at, kind: "comment", authorId: comment.authorId, commentId: comment.id, body: comment.body, ...(reason ? { reason } : {}) });
    }
    // A label add needs a reference time to be newer than (the plan's approval): without one, it
    // cannot be told from the label the ticket already carried. The label's id is resolved by name,
    // not from the ticket's current labels: an owner add that an app removal (or the owner) undid
    // before this read still counts, and the approval's cleanup puts the label back.
    if (since) {
      const planLabel = await this.deps.linear.existingLabelId(PLAN_LABEL);
      if (planLabel) {
        const owner = await this.deps.linear.viewerId();
        // The predicate only ends the paging; the pages read hold every label change.
        const added = (event: LabelEvent) => event.added.includes(planLabel) && event.at > since;
        for (const event of await this.deps.linear.labelHistory(issueId, added)) {
          if (!added(event) || event.actorId !== owner) continue;
          requests.push({ id: `label:${event.at}`, at: event.at, kind: "label", authorId: event.actorId });
        }
      }
    }
    return requests.sort((a, b) => a.at.localeCompare(b.at));
  }

  // When the planning round of an agent's ticket started: the newest request delivered to it, or
  // null (its planner started for the ticket, not for a request).
  async roundStartedAt(agentId: string): Promise<string | null> {
    return (await this.entry(agentId))?.roundStartedAt ?? null;
  }

  private async run(): Promise<void> {
    const paseo = this.paseo;
    if (!paseo || this.stopped) return;
    const agents = await ticketAgents(paseo);
    const trusted = new Set(await this.deps.apps.ids());
    const previous = await this.load();
    const next: Record<string, Entry> = {};
    for (const agent of agents) {
      const before = previous[agent.id];
      const entry: Entry = {
        handled: Array.isArray(before?.handled) ? [...before.handled] : [],
        roundStartedAt: typeof before?.roundStartedAt === "string" ? before.roundStartedAt : null,
      };
      // A replan comment is about the plan the ticket has now; a replaced one is ignored and logged.
      const plan = await this.deps.linear.issueDocument(agent.issueId, `Plan: ${agent.identifier}`).catch(() => null);
      for (const request of await this.requests(agent.issueId, agent.identifier, agent.createdAt, plan ? documentPlanHash(plan.content) : null, trusted)) {
        if (entry.handled.includes(request.id)) continue;
        // A failure before the owner record leaves the request unhandled, so the next poll retries
        // it.
        const text = planRequestText(agent.identifier, request);
        // Only omp loads the plugin's extension, which consumes the request file at the agent's
        // next tool call: there the file is the delivery, whenever the prompt lands. Any other
        // provider has only the prompt, so its request stays pending until a poll sends it, and no
        // file is written for nobody to read.
        const consumesFile = agent.provider === "omp" || agent.provider.startsWith("omp/");
        if (consumesFile) await this.writeRequest(agent, text);
        const outcome = await this.deps.prompt(agent.id, text);
        if (outcome === "sent") console.log(`[linear-tickets] ${agent.identifier}: plan requested from agent ${agent.id.slice(0, 8)}`);
        if (!consumesFile && outcome !== "sent") continue;
        if (request.kind === "label") await this.deps.routes?.ownerRequested(agent.issueId);
        entry.handled.push(request.id);
        // A peer's older comment can become trusted after a newer request was delivered.
        if (!entry.roundStartedAt || request.at > entry.roundStartedAt) entry.roundStartedAt = request.at;
      }
      next[agent.id] = entry;
    }
    await this.save(next);
    await this.removeStale(new Set(agents.map((agent) => agent.id)));
    this.lastError = null;
  }

  // The plugin itself sends a working agent back to planning (README, "Model tiers"): the same
  // request file, carrying the message the omp extension shows instead of the owner's. The prompt
  // is all other providers get; a busy agent gets it from the file at its next tool call.
  async send(agent: { id: string; issueId: string; identifier: string }, message: string): Promise<void> {
    await this.writeRequest(agent, message);
    const outcome = await this.deps.prompt(agent.id, message).catch(() => "unavailable" as const);
    console.log(`[linear-tickets] ${agent.identifier}: agent ${agent.id.slice(0, 8)} sent back to planning (${outcome})`);
  }

  // The request file is what the omp extension turns into planning at the agent's next tool call
  // or prompt; a provider without it gets the prompt instead (the caller sends that).
  private async writeRequest(agent: { id: string; identifier: string }, text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, agent.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ identifier: agent.identifier, at: new Date().toISOString(), message: text }), { mode: 0o600 });
    await rename(temporary, path);
  }

  // Requests for agents that are gone (archived, deleted) are never picked up.
  private async removeStale(live: Set<string>): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      if (name === STATE_FILE || name === APPS_FILE || name.endsWith(".tmp") || live.has(name)) continue;
      await rm(join(this.directory, name), { force: true });
    }
  }

  private async entry(agentId: string): Promise<Entry | null> {
    return (await this.load())[agentId] ?? null;
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

async function readApps(path: string): Promise<Record<string, { appUserId: string; at: string }>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, { appUserId: string; at: string }> : {};
  } catch { return {}; }
}

async function writeApps(path: string, apps: Record<string, { appUserId: string; at: string }>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(apps), { mode: 0o600 });
  await rename(temporary, path);
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
      if (issueId && !labels["paseo.parent-agent-id"]) agents.push({ id: agent.id, issueId, identifier: labels["linear.identifier"] || issueId, createdAt: agent.createdAt, provider: agent.provider });
    }
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return agents;
}