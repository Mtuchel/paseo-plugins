import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { UUID, type LinearService, type WrittenState } from "./linear";
import { RateLimitedError, withPriority } from "./rate-budget";

// Each ticket workspace carries one workspace label naming its ticket's Linear state
// ("Linear: In Review"), so the sidebar row shows it next to the PR badge. Labels with this prefix
// belong to the plugin: it assigns, swaps and removes them. Every other label is left alone.
export const STATE_LABEL_PREFIX = "Linear: ";
const SYNC_MS = 60_000;
// States read within this window are not read again; just under one cycle, so each cycle reads all.
const FRESH_MS = 50_000;
// Tickets Linear did not return (deleted, archived, invisible) are asked about again after this.
const MISSING_RETRY_MS = 60 * 60 * 1000;
// After an agent is created: long enough for its workspace and labels to settle.
const SOON_MS = 2_000;
// Label operations failing in a row within one cycle end it (an old daemon, a dropped connection).
const MAX_FAILURES = 3;

export type LabelColor = Parameters<DaemonClient["setWorkspaceLabel"]>[0]["label"]["color"];
export type StateLabel = { name: string; color: LabelColor };
export type TicketState = { name: string; type: string };
export type LabelWorkspace = { id: string; name: string; labels: string[] };
export type LabelAgent = { workspaceId: string; issueId: string; identifier: string; createdAt: string };
export type LabelChange = { workspaceId: string; assign?: StateLabel; unassign: string[] };
export type LabelPlan = { recolor: StateLabel[]; changes: LabelChange[] };

// The daemon's own label identity: whitespace collapsed, case ignored.
export function labelKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

const PREFIX_KEY = labelKey(STATE_LABEL_PREFIX) + " ";
export function isStateLabel(name: string): boolean {
  return labelKey(name).startsWith(PREFIX_KEY);
}

// By state type; started states differ by stage, so review, merge, planning and waiting stand out
// from plain work in progress.
const COLOR_BY_TYPE: Record<string, LabelColor> = {
  triage: "orange",
  backlog: "indigo",
  unstarted: "sky",
  started: "amber",
  completed: "emerald",
  canceled: "red",
  duplicate: "red",
};
const STARTED_STAGES: [RegExp, LabelColor][] = [
  [/review/i, "violet"],
  [/merge/i, "teal"],
  [/plan/i, "blue"],
  [/needs|input|blocked|waiting/i, "pink"],
];

export function stateLabelColor(state: TicketState): LabelColor {
  const type = state.type.trim().toLowerCase();
  if (type === "started") return STARTED_STAGES.find(([pattern]) => pattern.test(state.name))?.[1] ?? COLOR_BY_TYPE.started;
  return COLOR_BY_TYPE[type] ?? COLOR_BY_TYPE.unstarted;
}

export function stateLabel(state: TicketState): StateLabel {
  return { name: `${STATE_LABEL_PREFIX}${state.name.replace(/\s+/g, " ").trim()}`, color: stateLabelColor(state) };
}

function namesTicket(workspaceName: string, identifier: string): boolean {
  if (!identifier) return false;
  const escaped = identifier.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?![0-9])`).test(workspaceName.toLowerCase());
}

// The ticket a workspace shows, from the ticket agents created in it. Agents pointing at different
// tickets: the ticket the workspace's name carries (launches title it "TUC-1: …", branches carry
// "tuc-1-…"), else the ticket of the oldest agent (the one the workspace was opened for); ties go
// to the lower issue id.
export function ticketFor(workspace: Pick<LabelWorkspace, "name">, agents: LabelAgent[]): LabelAgent | null {
  const named = agents.filter((agent) => namesTicket(workspace.name, agent.identifier));
  const pool = named.length ? named : agents;
  return [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.issueId.localeCompare(b.issueId))[0] ?? null;
}

export function workspaceTickets(workspaces: LabelWorkspace[], agents: LabelAgent[]): Map<string, LabelAgent> {
  const byWorkspace = new Map<string, LabelAgent[]>();
  for (const agent of agents) byWorkspace.set(agent.workspaceId, [...(byWorkspace.get(agent.workspaceId) ?? []), agent]);
  const tickets = new Map<string, LabelAgent>();
  for (const workspace of workspaces) {
    const ticket = ticketFor(workspace, byWorkspace.get(workspace.id) ?? []);
    if (ticket) tickets.set(workspace.id, ticket);
  }
  return tickets;
}

// What to change so each ticket workspace carries exactly its ticket's state label and other
// workspaces carry none. A ticket whose state is unknown keeps the workspace as it is. `recolor`:
// catalog entries of wanted labels whose colour drifted from the state's colour.
export function planStateLabels(input: { workspaces: LabelWorkspace[]; agents: LabelAgent[]; states: ReadonlyMap<string, TicketState>; catalog: StateLabel[] }): LabelPlan {
  const tickets = workspaceTickets(input.workspaces, input.agents);
  const wanted = new Map<string, StateLabel>();
  const changes: LabelChange[] = [];
  for (const workspace of [...input.workspaces].sort((a, b) => a.id.localeCompare(b.id))) {
    const owned = workspace.labels.filter(isStateLabel);
    const ticket = tickets.get(workspace.id);
    if (!ticket) {
      if (owned.length) changes.push({ workspaceId: workspace.id, unassign: owned });
      continue;
    }
    const state = input.states.get(ticket.issueId);
    if (!state) continue;
    const desired = stateLabel(state);
    const key = labelKey(desired.name);
    if (!wanted.has(key)) wanted.set(key, desired);
    const stale = owned.filter((name) => labelKey(name) !== key);
    const present = stale.length < owned.length;
    if (!present || stale.length) changes.push({ workspaceId: workspace.id, ...(present ? {} : { assign: desired }), unassign: stale });
  }
  const recolor: StateLabel[] = [];
  for (const entry of input.catalog) {
    const desired = wanted.get(labelKey(entry.name));
    if (desired && desired.color !== entry.color) recolor.push({ name: entry.name, color: desired.color });
  }
  return { recolor, changes };
}

// The daemon calls the sync needs; the internal daemon client in production (see labelDaemon).
export type LabelDaemon = {
  workspaces(): Promise<LabelWorkspace[]>;
  ticketAgents(): Promise<LabelAgent[]>;
  catalog(): Promise<StateLabel[]>;
  assign(workspaceId: string, label: StateLabel): Promise<void>;
  unassign(workspaceId: string, name: string): Promise<void>;
  recolor(label: StateLabel): Promise<void>;
};

type Deps = {
  linear: Pick<LinearService, "issueStatuses">;
  daemon: () => Promise<LabelDaemon | null>;
  now?: () => number;
};

export class StateLabels {
  private timer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly states = new Map<string, { state: TicketState; at: number }>();
  private readonly missing = new Map<string, number>();
  private readonly logged = new Set<string>();

  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.sync(); }, SYNC_MS);
    this.timer.unref?.();
    void this.sync();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer ?? undefined);
    clearTimeout(this.soonTimer ?? undefined);
    this.timer = this.soonTimer = null;
  }

  // A state the plugin just wrote: shown without reading it back from Linear.
  noteState(issueId: string, state: WrittenState): void {
    this.states.set(issueId, { state, at: this.deps.now?.() ?? Date.now() });
    this.missing.delete(issueId);
    this.soon();
  }

  // A new agent or workspace: label it now rather than at the next cycle.
  soon(): void {
    if (this.stopped || !this.timer) return;
    clearTimeout(this.soonTimer ?? undefined);
    this.soonTimer = setTimeout(() => { this.soonTimer = null; void this.sync(); }, SOON_MS);
    this.soonTimer.unref?.();
  }

  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.run().catch((error: unknown) => this.report(error)).finally(() => {
      this.running = null;
      if (this.again && !this.stopped) { this.again = false; void this.sync(); }
    });
    return this.running;
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof RateLimitedError ? `rate:${error.pool}` : message;
    if (this.logged.has(cause)) return;
    this.logged.add(cause);
    console.error(`[linear-tickets] workspace state labels: ${message}`);
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    const daemon = await this.deps.daemon();
    if (!daemon) throw new Error("no connection to the local Paseo daemon; labels are not updated.");
    const [workspaces, agents] = await Promise.all([daemon.workspaces(), daemon.ticketAgents()]);
    const tickets = new Set([...workspaceTickets(workspaces, agents).values()].map((agent) => agent.issueId));
    await this.readStates(tickets);
    const catalog = await daemon.catalog();
    const states = new Map([...this.states].map(([id, entry]) => [id, entry.state]));
    const plan = planStateLabels({ workspaces, agents, states, catalog });
    let failures = 0;
    let failed = false;
    const attempt = async (work: () => Promise<void>) => {
      if (failures >= MAX_FAILURES || this.stopped) return;
      try { await work(); failures = 0; } catch (error) { failures++; failed = true; this.report(error); }
    };
    for (const label of plan.recolor) await attempt(() => daemon.recolor(label));
    for (const change of plan.changes) {
      if (change.assign) { const label = change.assign; await attempt(() => daemon.assign(change.workspaceId, label)); }
      for (const name of change.unassign) await attempt(() => daemon.unassign(change.workspaceId, name));
    }
    if (failures >= MAX_FAILURES) throw new Error(`stopped this round after ${MAX_FAILURES} failed label changes; retrying in a minute.`);
    // A clean round: a cause that comes back later is reported again.
    if (!failed) this.logged.clear();
  }

  // One batched read for the tickets whose state is not fresh; known states of tickets no longer
  // shown are dropped.
  private async readStates(tickets: Set<string>): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    for (const [id, entry] of this.states) if (!tickets.has(id) && now - entry.at > FRESH_MS) this.states.delete(id);
    for (const [id, until] of this.missing) if (!tickets.has(id) || until <= now) this.missing.delete(id);
    const due = [...tickets].filter((id) => !this.missing.has(id) && now - (this.states.get(id)?.at ?? -Infinity) > FRESH_MS);
    if (!due.length) return;
    const found = await withPriority("background", "state-labels", () => this.deps.linear.issueStatuses(due));
    for (const id of due) {
      const status = found.get(id);
      if (status?.status) this.states.set(id, { state: { name: status.status, type: status.statusType }, at: now });
      else { this.states.delete(id); this.missing.set(id, now + MISSING_RETRY_MS); }
    }
  }
}

// Workspace labels through the daemon protocol (workspace.label.* requests). The plugin SDK has
// no call for them, so this is the internal daemon client the SDK is built on.
const CATALOG_SUBSCRIPTION = "linear-tickets-state-labels";
const PAGE = 200;

export function labelDaemon(client: DaemonClient): LabelDaemon {
  return {
    async workspaces() {
      const found: LabelWorkspace[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.fetchWorkspaces({ page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
        for (const workspace of page.entries) {
          if (!workspace.archivingAt) found.push({ id: workspace.id, name: workspace.name, labels: workspace.labels ?? [] });
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor);
      return found;
    },
    // Archived agents count too: a workspace keeps its ticket after its agent finished. A label
    // that is not a Linear id (a test run's "guard-test") makes no ticket agent.
    async ticketAgents() {
      const found: LabelAgent[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.fetchAgents({ filter: { includeArchived: true }, page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
        for (const { agent } of page.entries) {
          const issueId = agent.labels?.["linear.issueId"];
          if (issueId && UUID.test(issueId) && agent.workspaceId) found.push({ workspaceId: agent.workspaceId, issueId, identifier: agent.labels["linear.identifier"] ?? "", createdAt: agent.createdAt });
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor);
      return found;
    },
    // The same subscription id each time: the daemon replaces the previous listing's subscription.
    async catalog() {
      return (await client.listWorkspaceLabels({ subscriptionId: CATALOG_SUBSCRIPTION })).labels;
    },
    async assign(workspaceId, label) {
      await client.setWorkspaceLabel({ workspaceId, label, assigned: true });
    },
    // The colour is required by the request but unused when unassigning.
    async unassign(workspaceId, name) {
      await client.setWorkspaceLabel({ workspaceId, label: { name, color: COLOR_BY_TYPE.unstarted }, assigned: false });
    },
    async recolor(label) {
      await client.updateWorkspaceLabel({ name: label.name, color: label.color });
    },
  };
}
