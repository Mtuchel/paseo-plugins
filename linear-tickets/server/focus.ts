import type { PaseoApi } from "@getpaseo/client";
import { join } from "node:path";
import type { FocusPhase, FocusStatus, FocusTicket } from "../shared/contracts";
import { JsonFile } from "./activation";
import { dispatchLabels } from "./dispatch";
import { inReviewState, type FocusNode, type LinearService } from "./linear";
import { PLAN_READY_LABEL } from "./plan-policy";
import { LIVE_AGENT } from "./process-liveness";
import type { Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// Focus mode (README, "Focus mode"): while it is on, no new ticket work starts. The tickets in
// flight when it was turned on (the roots, fixed then and kept in focus.json) run to the end, and
// so does everything they need: their open sub-issues (a split plan's included) and the tickets
// blocking them, followed down the whole chain, plus the open queue blockers. The set below the
// roots is read from Linear again at most every REFRESH_MS (about 6 requests for 300 tickets), so
// a blocker or sub-issue added while focus is on joins it. Every automatic start path asks
// `admits` (TicketStarter.admission); a ticket outside focus waits exactly like a blocked one,
// with its label, thread or hand-out kept, and starts at the first poll after focus is turned off.

type FocusFile = { version: 1; active: boolean; since: string | null; roots: Record<string, string> };
type AgentState = { live: boolean; working: boolean; waiting: boolean };
type Snapshot = { members: Set<string>; tickets: FocusTicket[]; readAt: number };

export const FOCUS_REASON = "Focus mode is on: only the tickets in flight when it began, their sub-issues and their blockers start until it is turned off.";
const REFRESH_MS = 5 * 60_000;
// At most this many tickets are in focus; a walk that reaches it stops adding sub-issues and blockers.
const MAX_TICKETS = 1_000;
const CLOSED = ["completed", "canceled", "duplicate"];

function parseFile(raw: unknown): FocusFile {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (value.version !== 1) throw new Error("unknown focus file version");
  const roots = value.roots && typeof value.roots === "object" ? Object.fromEntries(Object.entries(value.roots as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  return { version: 1, active: value.active === true, since: typeof value.since === "string" ? value.since : null, roots };
}

// The root ticket agents on this host (not archived, no subagents), by ticket: `live` the agent
// exists to work (LIVE_AGENT), `working` it works right now, `waiting` it waits for the owner.
async function agentsByTicket(paseo: PaseoApi): Promise<Map<string, AgentState>> {
  const byTicket = new Map<string, AgentState>();
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of page.entries) {
      const issueId = agent.labels?.["linear.issueId"];
      if (!issueId || agent.labels["paseo.parent-agent-id"]) continue;
      const waiting = Boolean(agent.pendingPermissions?.length);
      const state = byTicket.get(issueId) ?? { live: false, working: false, waiting: false };
      byTicket.set(issueId, {
        live: state.live || Boolean(LIVE_AGENT[agent.status]),
        working: state.working || ((agent.status === "running" || agent.status === "initializing") && !waiting),
        waiting: state.waiting || waiting,
      });
    }
    cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return byTicket;
}

export class Focus {
  private readonly file: JsonFile<FocusFile>;
  private snapshot: Snapshot | null = null;
  private error: string | null = null;
  private refreshing: Promise<Snapshot> | null = null;

  constructor(private readonly deps: {
    linear: Pick<LinearService, "focusTickets" | "focusSeed" | "focusQueueBlockers" | "trustedAppIds">;
    settings: Pick<Settings, "read">;
    path?: string;
    now?: () => number;
  }) {
    this.file = new JsonFile(deps.path ?? join(paseoHome(), "linear-tickets", "focus.json"), () => ({ version: 1, active: false, since: null, roots: {} }), parseFile);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async active(): Promise<boolean> {
    return (await this.file.load()).active;
  }

  // Null when the ticket may start; else why it waits. A ticket outside focus waits; while the
  // set cannot be read, the last one read decides, and before any read the roots alone do.
  async admits(issueId: string, paseo: PaseoApi): Promise<string | null> {
    const file = await this.file.load();
    if (!file.active) return null;
    if (file.roots[issueId]) return null;
    const snapshot = await this.current(paseo).catch(() => this.snapshot);
    return snapshot?.members.has(issueId) ? null : FOCUS_REASON;
  }

  // Turns focus on, fixing the roots: every ticket with work under way -- a root ticket agent on
  // this host, a dispatch status label (`-running`, `-needs-you`, `-blocked`, `-failed`), or a
  // started ticket of the dispatch teams that Paseo has (delegated to this host's or the peer's
  // app, or carrying a Paseo agent link). An approved plan that no agent implements yet (Todo or
  // Backlog with `plan-ready`, no live agent) is new work and waits. Already on: unchanged.
  async enable(paseo: PaseoApi): Promise<FocusStatus> {
    if (!(await this.file.load()).active) {
      const settings = await this.deps.settings.read();
      const labels = dispatchLabels(settings.dispatch.label);
      const agents = await agentsByTicket(paseo);
      const appIds = new Set(await this.deps.linear.trustedAppIds());
      const seed = await this.deps.linear.focusSeed(settings.dispatch.teamKeys, [labels.running, labels.needsYou, labels.blocked, labels.failed]);
      const candidates = new Map<string, FocusNode>();
      for (const node of seed.labelled) candidates.set(node.id, node);
      for (const node of seed.started) {
        if ((node.delegateId && appIds.has(node.delegateId)) || node.agentLinked || agents.has(node.id)) candidates.set(node.id, node);
      }
      for (const node of await this.deps.linear.focusTickets([...agents.keys()].filter((id) => !candidates.has(id)))) candidates.set(node.id, node);
      const roots = Object.fromEntries([...candidates.values()]
        .filter((node) => !(["unstarted", "backlog", "triage"].includes(node.statusType) && node.labels.some((name) => name.toLowerCase() === PLAN_READY_LABEL) && !agents.get(node.id)?.live))
        .map((node) => [node.id, node.identifier]));
      const since = new Date(this.now()).toISOString();
      await this.file.update((file) => {
        if (file.active) return;
        Object.assign(file, { active: true, since, roots });
      });
      this.snapshot = null;
      this.error = null;
      console.log(`[linear-tickets] focus mode on: ${Object.keys(roots).length} ticket${Object.keys(roots).length === 1 ? "" : "s"} in flight`);
    }
    return this.status(paseo);
  }

  async disable(): Promise<FocusStatus> {
    await this.file.update((file) => Object.assign(file, { active: false, since: null, roots: {} }));
    this.snapshot = null;
    this.error = null;
    console.log("[linear-tickets] focus mode off");
    return { active: false, since: null, readAt: null, error: null, tickets: [], left: 0, complete: false };
  }

  // A ticket the owner started by hand while focus is on (the sidebar): it is in flight now, so
  // its later successors (review fixes, recoveries) start too.
  async include(issueId: string, identifier: string): Promise<void> {
    if (!(await this.file.load()).active) return;
    await this.file.update((file) => { if (file.active) file.roots[issueId] = identifier; });
    this.snapshot = null;
  }

  async status(paseo: PaseoApi): Promise<FocusStatus> {
    const file = await this.file.load();
    if (!file.active) return { active: false, since: null, readAt: null, error: null, tickets: [], left: 0, complete: false };
    const snapshot = await this.current(paseo).catch(() => this.snapshot);
    const tickets = snapshot?.tickets ?? [];
    const left = tickets.filter((ticket) => ticket.phase !== "review" && ticket.phase !== "done").length;
    return {
      active: true, since: file.since, readAt: snapshot ? new Date(snapshot.readAt).toISOString() : null, error: this.error,
      tickets, left, complete: Boolean(snapshot) && !this.error && left === 0,
    };
  }

  // The snapshot, read again when older than REFRESH_MS; one read at a time. A failed read is
  // remembered for the status and rethrown.
  private current(paseo: PaseoApi): Promise<Snapshot> {
    if (this.snapshot && this.now() - this.snapshot.readAt < REFRESH_MS) return Promise.resolve(this.snapshot);
    this.refreshing ??= this.walk(paseo).then((snapshot) => {
      this.snapshot = snapshot;
      this.error = null;
      return snapshot;
    }, (error: unknown) => {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async walk(paseo: PaseoApi): Promise<Snapshot> {
    const file = await this.file.load();
    const settings = await this.deps.settings.read();
    const labels = dispatchLabels(settings.dispatch.label);
    const agents = await agentsByTicket(paseo);
    const reasons = new Map<string, FocusTicket["reason"]>(Object.keys(file.roots).map((id) => [id, "in-flight"]));
    const nodes = new Map<string, FocusNode>();
    for (const node of await this.deps.linear.focusQueueBlockers(settings.dispatch.teamKeys)) {
      nodes.set(node.id, node);
      if (!reasons.has(node.id)) reasons.set(node.id, "queue-blocker");
    }
    let frontier = [...reasons.keys()].filter((id) => !nodes.has(id));
    while (frontier.length) {
      const next: string[] = [];
      for (const node of await this.deps.linear.focusTickets(frontier)) {
        nodes.set(node.id, node);
        // A closed ticket needs nothing more; an open one needs its open sub-issues and blockers.
        if (CLOSED.includes(node.statusType)) continue;
        for (const [id, reason] of [...node.children.map((id) => [id, "sub-issue"] as const), ...node.blockers.map((blocker) => [blocker.id, "blocker"] as const)]) {
          if (reasons.has(id) || reasons.size >= MAX_TICKETS) continue;
          reasons.set(id, reason);
          next.push(id);
        }
      }
      frontier = next;
    }
    const needsYou = new Set([labels.needsYou, labels.blocked, labels.failed].map((name) => name.toLowerCase()));
    const tickets = [...reasons].flatMap(([id, reason]): FocusTicket[] => {
      const node = nodes.get(id);
      if (!node) return [];
      const agent = agents.get(id);
      const phase: FocusPhase = CLOSED.includes(node.statusType) ? "done"
        : agent?.working ? "working"
          : agent?.waiting || /needs input|plan review/i.test(node.status) || node.labels.some((name) => needsYou.has(name.toLowerCase())) ? "needs-you"
            : inReviewState(node.status, node.statusType) ? (node.finished ? "done" : "review")
              : "waiting";
      const waitingOn = node.blockers.filter((blocker) => !nodes.get(blocker.id)?.finished).map((blocker) => blocker.identifier);
      return [{ id, identifier: node.identifier, title: node.title, url: node.url, status: node.status, phase, reason, waitingOn }];
    });
    return { members: new Set(reasons.keys()), tickets, readAt: this.now() };
  }
}
