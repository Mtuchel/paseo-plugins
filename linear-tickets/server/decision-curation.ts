import type { BrowserOwnerAsk, CuratedDecision, DecisionView, LiveDecision } from "../shared/decision-inbox";

export const CURATION_INTERVAL_MS = 15 * 60 * 1000;
export const ownerSourceId = (ask: BrowserOwnerAsk): string => JSON.stringify([ask.issueId, ask.sourceId ?? ask.revision]);
export const liveSourceId = (live: LiveDecision): string => JSON.stringify([live.agentId, live.requestId]);

// Source identity, not ticket identity, is the unit of work. Equal questions on different
// comments or agents are independent decisions; never turn a ticket-wide join into approval.
export function curateDecisions(view: DecisionView, now: number): CuratedDecision[] {
  const tasks: CuratedDecision[] = [];
  const seen = new Set<string>();
  const add = (task: CuratedDecision) => {
    const key = JSON.stringify([task.host, task.target, task.id, task.revision]);
    if (!seen.has(key)) { seen.add(key); tasks.push(task); }
  };
  for (const host of view.hosts) {
    if (host.host === view.canonicalHost) for (const ask of host.asks) {
      // A confirmed answer closes only this source revision. Unknown delivery stays visible.
      if (host.history.some(receipt => receipt.issueId === ask.issueId && receipt.revision === ask.revision
        && (receipt.action === "answer" || receipt.action === "done")
        && ["agent", "continued", "queued", "comment", "closed", "applied"].includes(receipt.delivery))) continue;
      const deferred = Boolean(ask.deferredUntil && Date.parse(ask.deferredUntil) > now);
      const waiting = deferred || ask.disposition === "research" || ask.disposition === "delegated";
      const unresolved = ask.deliveryUnknown || (!ask.extracted && ask.kind !== "manual");
      add({ host: host.host, target: "owner", id: ownerSourceId(ask), revision: ask.revision,
        priority: waiting ? "waiting" : unresolved ? "review" : ask.attention !== "owner" ? "waiting" : ask.kind !== "info" ? "owner" : "review",
        reason: ask.attentionReason,
        blockedWork: ask.blockerIdentifier ? `${ask.ticketIdentifier} is blocked by ${ask.blockerIdentifier}.` : `${ask.ticketIdentifier} — no specific downstream blocker evidenced.`,
        flow: host.flow?.tickets?.find(ticket => ticket.identifier === ask.ticketIdentifier) });
    }
    for (const live of host.live) add({ host: host.host, target: "live", id: liveSourceId(live), revision: live.revision,
      priority: live.deliveryUnknown ? "review" : live.deferredUntil && Date.parse(live.deferredUntil) > now ? "waiting" : "owner",
      reason: live.kind === "permission" ? "An original plan or permission request requires an explicit choice; no authorization is inferred." : "The agent is waiting for an answer to this exact question round.",
      blockedWork: `${live.identifier ? `${live.identifier} · ` : ""}agent ${live.agentId} is waiting on request ${live.requestId}.`,
      flow: host.flow?.tickets?.find(ticket => ticket.identifier === live.identifier) });
  }
  const rank = { owner: 0, review: 1, waiting: 2 };
  // Preserve source order within priority: no invented urgency, impact, or recommendation.
  return tasks.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** Daemon-owned, single-flight collection. No browser connection or automatic decision required. */
export class DecisionCuration {
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<void> | null = null;
  private snapshot: DecisionView | null = null;
  private lastRefreshAt: number | null = null;
  private nextRefreshAt: number | null = null;
  private error: string | null = null;
  private generation = 0;
  private dirty = true;

  constructor(private readonly collect: () => Promise<DecisionView>, private readonly now: () => number = Date.now) {}

  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    this.nextRefreshAt = this.now() + CURATION_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.nextRefreshAt = this.now() + CURATION_INTERVAL_MS;
      void this.refresh();
    }, CURATION_INTERVAL_MS);
    this.timer.unref?.();
    return this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.nextRefreshAt = null;
  }

  invalidate(): void { this.generation++; this.dirty = true; }

  async refresh(): Promise<void> {
    if (this.flight) {
      await this.flight;
      if (this.dirty) await this.refresh();
      return;
    }
    const generation = this.generation;
    const flight = (async () => {
      try {
        const snapshot = await this.collect();
        if (generation !== this.generation) return;
        this.snapshot = snapshot;
        this.lastRefreshAt = this.now();
        this.error = null;
        this.dirty = false;
      } catch (error) {
        if (generation === this.generation) {
          this.error = error instanceof Error ? error.message : String(error);
          // Retain the last known tasks and expose the failure, never claim an empty inbox.
          this.dirty = false;
        }
      }
    })();
    this.flight = flight;
    try { await flight; } finally { if (this.flight === flight) this.flight = null; }
    // An answer/config change during collection invalidates that entire pass. Recollect even
    // when no browser is waiting, rather than leaving the task list dirty until the next tick.
    if (this.dirty) await this.refresh();
  }

  async view(): Promise<DecisionView> {
    if (this.dirty || this.lastRefreshAt === null || this.now() - this.lastRefreshAt >= CURATION_INTERVAL_MS) {
      do { await this.refresh(); } while (this.dirty);
    }
    const view = this.snapshot ?? { hosts: [], canonicalHost: null, unreachable: [] };
    return { ...view, tasks: curateDecisions(view, this.now()), curation: {
      intervalMs: CURATION_INTERVAL_MS, running: this.timer !== undefined, refreshing: this.flight !== null,
      lastRefreshAt: this.lastRefreshAt === null ? null : new Date(this.lastRefreshAt).toISOString(),
      nextRefreshAt: this.nextRefreshAt === null ? null : new Date(this.nextRefreshAt).toISOString(), error: this.error,
    } };
  }
}
