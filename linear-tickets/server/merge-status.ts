import type { PaseoApi } from "@getpaseo/client";
import type { MergeBlocker, MergeStatusSnapshot } from "../shared/merge-status";
import type { Handover } from "./handover";
import { QUEUE_BLOCKER_TITLE_PREFIX, type LinearService } from "./linear";
import type { ParkedPlans } from "./parked";
import { PLAN_APPROVED_STATE, PLAN_POLICY_LABEL, PLAN_REVIEW_STATE, planStage } from "./plan-policy";
import type { SessionStore } from "./sessions";

export type MergeStatusDeps = {
  linear: Pick<LinearService, "focusQueueBlockers">;
  teamKeys: () => Promise<string[]>;
  paseo: () => PaseoApi | null;
  handover: Pick<Handover, "all">;
  parked: Pick<ParkedPlans, "all">;
  sessions: Pick<SessionStore, "all">;
  waiting: () => string[];
  agentUrl: (id: string) => Promise<string | null>;
  now?: () => number;
};
type Agent = { id: string; status: string; labels?: Record<string, string>; archivedAt?: string | null; pendingPermissions?: unknown[] | null; activeTurn?: unknown; updatedAt?: string };
const CACHE_MS = 60_000;

// One read-only inventory shared by the RPC and the canonical browser feed. A partial collection
// never replaces complete evidence; checkedAt advances only after every source was read.
export class MergeStatus {
  private current: MergeStatusSnapshot = { checkedAt: null, error: null, blockers: [] };
  private attemptedAt: number | null = null;
  private flight: Promise<MergeStatusSnapshot> | null = null;
  private readonly now: () => number;
  constructor(private readonly deps: MergeStatusDeps) { this.now = deps.now ?? Date.now; }

  snapshot(): Promise<MergeStatusSnapshot> {
    if (this.flight) return this.flight;
    if (this.attemptedAt !== null && this.now() - this.attemptedAt < CACHE_MS) return Promise.resolve(this.current);
    const flight = this.collect().then(blockers => {
      this.current = { checkedAt: new Date(this.now()).toISOString(), error: null, blockers };
      return this.current;
    }, error => {
      this.current = { ...this.current, error: `Merge status unavailable: ${error instanceof Error ? error.message : String(error)}` };
      return this.current;
    }).finally(() => { this.attemptedAt = this.now(); this.flight = null; });
    this.flight = flight;
    return flight;
  }

  // HTTP peer reads have a five-second budget. Start/join the same collection as the RPC, but
  // never hold a decision feed open behind Linear quota admission or a long inventory scan.
  feed(): MergeStatusSnapshot {
    void this.snapshot();
    return this.current.checkedAt || this.current.error ? this.current :
      { ...this.current, error: "Queue blocker status is being checked; no successful inventory is available yet." };
  }

  private async agents(): Promise<Agent[]> {
    const paseo = this.deps.paseo();
    if (!paseo) throw new Error("Paseo is disconnected; repair agents cannot be checked.");
    const agents = new Map<string, Agent>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      if (typeof page.pageInfo.hasMore !== "boolean") throw new Error("Paseo returned incomplete repair-agent pagination metadata.");
      for (const { agent } of page.entries) if (!agent.archivedAt) agents.set(agent.id, agent);
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      if (page.pageInfo.hasMore && (!cursor || seen.has(cursor))) throw new Error("Paseo returned an incomplete or repeated repair-agent cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [...agents.values()];
  }

  private async collect(): Promise<MergeBlocker[]> {
    const keys = await this.deps.teamKeys();
    if (!keys.length) throw new Error("No dispatch teams are configured; queue blocker coverage is unknown.");
    const issues = await this.deps.linear.focusQueueBlockers(keys);
    // An empty complete inventory needs no agent evidence and is not a claim about main's health.
    if (!issues.length) return [];
    const [agents, records, parked, sessions] = await Promise.all([this.agents(), this.deps.handover.all(), this.deps.parked.all(), this.deps.sessions.all()]);
    const waiting = new Set(this.deps.waiting());
    const rows: MergeBlocker[] = [];
    for (const issue of issues) {
      if (["completed", "canceled", "duplicate"].includes(issue.statusType)) continue;
      const record = records.find(entry => entry.issueId === issue.id);
      const issueThreads = sessions.filter(entry => entry.issueId === issue.id && !entry.closed && !entry.remote);
      const plan = parked.find(entry => entry.issueId === issue.id);
      // A handover's current agent wins over older roots carrying the same ticket label. Children
      // and control agents are not implementing roots; a running label alone proves nothing.
      const roots = agents.filter(agent => !agent.labels?.["paseo.parent-agent-id"] && !agent.labels?.["linear.coordination"] &&
        !record?.formerAgents?.includes(agent.id) && (agent.id === record?.agentId || agent.labels?.["linear.issueId"] === issue.id));
      roots.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      const running = (entry: Agent) => entry.status === "running" || Boolean(entry.activeTurn);
      const agent = roots.find(entry => entry.id === record?.agentId && (running(entry) || entry.pendingPermissions?.length)) ??
        roots.find(entry => running(entry) || entry.pendingPermissions?.length) ?? roots.find(entry => entry.id === record?.agentId) ?? roots[0];
      const currentId = agent?.id ?? record?.agentId ?? plan?.agentId ?? null;
      const threads = issueThreads.filter(entry => entry.agentId === currentId);
      const stage = planStage(issue.status, issue.statusType);
      // Linear's review/approval transition is authoritative. A staged parked file or an old
      // session review cannot resurrect approval after a successful handoff to a successor.
      const currentPlan = plan?.agentId === currentId && !plan?.staged;
      const currentReview = threads.some(entry => entry.review || entry.offer === "parked");
      const planner = agent?.labels?.[PLAN_POLICY_LABEL] === "required";
      let phase: MergeBlocker["phase"] = "unknown";
      let nextAction = stage ? "Wait for the planning agent to submit the repair plan." : "Check the blocker ticket; no current repair activity is confirmed.";
      if (stage === PLAN_REVIEW_STATE) {
        phase = "waiting-approval"; nextAction = "Review the repair plan and approve it or send feedback.";
      } else if (stage === PLAN_APPROVED_STATE) {
        phase = "queued"; nextAction = "Wait for the approved repair's implementation handoff.";
      } else if (agent?.pendingPermissions?.length || threads.some(entry => entry.questions) || (record?.agentId === currentId && record?.waiting) || issue.status.trim().toLowerCase() === "needs input") {
        phase = "waiting-input"; nextAction = "Answer the repair agent's current question or permission request.";
      } else if (/review/i.test(issue.status) && !stage) {
        phase = "review"; nextAction = "Review the repair pull request and its checks.";
      } else if (agent && running(agent) && !stage && !planner) {
        phase = "working"; nextAction = "Wait for the implementing agent to finish the repair and verify its checks.";
      } else if ((currentPlan && planner) || (currentReview && stage === "Planning")) {
        phase = "waiting-approval"; nextAction = "Review the repair plan and approve it or send feedback.";
      } else if (agent?.status === "error" || record?.status === "failed") {
        phase = "failed"; nextAction = "Inspect the failed repair agent and resolve its reported error.";
      } else if (waiting.has(issue.id) || threads.some(entry => entry.queued)) {
        phase = "queued"; nextAction = threads.find(entry => entry.queued)?.queueReason ?? "Wait for admission and an available repair agent slot.";
      }
      const agentId = currentId;
      rows.push({ identifier: issue.identifier, title: issue.title.startsWith(QUEUE_BLOCKER_TITLE_PREFIX) ? issue.title.slice(QUEUE_BLOCKER_TITLE_PREFIX.length).trimStart() || issue.title : issue.title, issueUrl: issue.url, status: issue.status,
        phase, nextAction, agentId, agentUrl: agentId ? await this.deps.agentUrl(agentId) : null });
    }
    return rows.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
  }
}
