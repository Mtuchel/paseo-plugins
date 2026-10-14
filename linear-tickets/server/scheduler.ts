import type { PaseoApi } from "@getpaseo/client";
import type { Tier } from "../shared/plan-model";
import type { EffectiveLimit } from "./capacity";
import { launchTier, type TierRecord } from "./model-tiers";
import { planPolicy } from "./plan-policy";

// Who gets the next free agent slot (README, "Who starts next"). Every path that wants to start a
// ticket asks here: threads waiting their turn, labelled tickets and project tickets. Each ask
// registers the ticket as waiting; while slots are short, the waiting tickets are ranked and only
// the first ones are admitted. Parent-verification controls rank first; one slot within caps
// greater than one is held for them. Worker ordering:
// 0. a queue blocker (tuchel-platform's `queue-blocker-alert.mjs` ticket, `queueBlocker`) first:
//    while it waits, every stack's merge-queue run waits with it, so it takes the next worker slot
//    ahead of every other worker, whatever its project's load or the night order;
// 1. while the owner is away, the night class first (see Night): a ticket whose approved plan
//    implements on the cheap tier, then one on the standard tier, then the rest — so the work that
//    can finish without the owner starts first. The class only orders the line; nothing waits
//    because of it;
// 2. the project with the fewest agents working first, so one project takes every slot only
//    while nothing else waits, and a project that waits gets the next free slot;
// 3. then tickets that may need the owner (`attended`), so the time they are present is used for those;
// 4. then priority (urgent first, none last), then the ticket that unblocks the most open tickets,
//    then the oldest.
// While the owner is away, `attended` tickets are not admitted and take no place in the line.
// An admitted ticket keeps its slot (a reservation) until its agent shows up or a few minutes pass.

// The night order's input (README, "Who starts next"): `planReady`, the ticket implements an
// approved plan (`plan-ready`) rather than planning, and `tier`, the tier that implementation runs
// on. A build site that cannot tell leaves it out: the ticket ranks in class 2 like everything the
// night order does not place.
export type Night = { planReady: boolean; tier: Tier | null };

// The night input of a ticket, from data the plugin already has when it builds a candidate: the
// label names the ticket carries and its tier store record (null where a site has no record). The
// tier is the strongest of the ticket's `model:` label and its recorded decision, as launchTier
// does; the plan document is not read before a start.
export function nightInput(labelNames: readonly string[], record: TierRecord | null): Night {
  const labels = labelNames.map((name) => ({ name }));
  return { planReady: planPolicy(labels) === null, tier: launchTier(labels, record, null) };
}

// `blocked` tickets never ask: their blockers are checked before.
export type Candidate = {
  issueId: string; identifier: string; projectId: string | null; priority: number; unblocks: number; createdAt: string; attended?: boolean;
  // Parent verification may use the one control slot held within a finite cap.
  control?: boolean;
  // A queue blocker (IssueState.queueBlocker) ranks ahead of other workers; absent: not one.
  queueBlocker?: boolean;
  // While the owner is away this ticket's night class decides first (see rankWaiting); absent:
  // class 2.
  night?: Night;
};

export const AWAY_REASON = "Waits until you are present: it may need you while it runs.";
export type Admission = { ok: true } | { ok: false; reason: string };

// A waiting ticket that has not asked for this long has started, closed or stopped waiting.
const WAITING_MS = 3 * 60_000;
// A reservation whose agent never showed up (a failed start) frees its slot after this long.
const RESERVED_MS = 3 * 60_000;
// The working agents are read once per burst of asks.
const RUNNING_CACHE_MS = 5_000;

type RunningTicket = { issueId: string; control?: boolean };

type Deps = {
  // One entry per working root agent, retaining control labels across plugin restarts.
  running: (paseo: PaseoApi) => Promise<(string | RunningTicket)[]>;
  projectOf: (issueId: string) => Promise<string | null>;
  // Whether the owner is away (presence.ts); absent: always present.
  away?: () => Promise<boolean>;
  now?: () => number;
};

// The class a waiting ticket ranks in while the owner is away (README, "Who starts next"): 0 a
// cheap implementation, 1 a standard one, 2 everything else — a strong implementation, one whose
// tier is not known here, a ticket that still plans, one whose site passed no input.
function nightClass(candidate: Candidate): number {
  if (!candidate.night?.planReady) return 2;
  return candidate.night.tier === "cheap" ? 0 : candidate.night.tier === "standard" ? 1 : 2;
}

export function rankWaiting(waiting: Candidate[], load: Map<string | null, number>, slots: number, away = false): Candidate[] {
  const loads = new Map(load);
  const left = [...waiting];
  const picked: Candidate[] = [];
  while (picked.length < slots && left.length) {
    left.sort((a, b) => Number(Boolean(b.control)) - Number(Boolean(a.control))
      || Number(Boolean(b.queueBlocker)) - Number(Boolean(a.queueBlocker))
      || (away ? nightClass(a) - nightClass(b) : 0)
      || (loads.get(a.projectId) ?? 0) - (loads.get(b.projectId) ?? 0)
      || Number(Boolean(b.attended)) - Number(Boolean(a.attended))
      || (a.priority || 5) - (b.priority || 5)
      || b.unblocks - a.unblocks
      || a.createdAt.localeCompare(b.createdAt)
      || a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
    const next = left.shift()!;
    picked.push(next);
    loads.set(next.projectId, (loads.get(next.projectId) ?? 0) + 1);
  }
  return picked;
}

function laneKey(candidate: { issueId: string; control?: boolean }): string {
  return `${candidate.control ? "control" : "worker"}:${candidate.issueId}`;
}

export class Scheduler {
  private readonly waiting = new Map<string, Candidate & { seenAt: number }>();
  private readonly reserved = new Map<string, { issueId: string; projectId: string | null; control: boolean; until: number }>();
  private readonly projects = new Map<string, string | null>();
  private runningCache: { at: number; agents: RunningTicket[] } | null = null;
  private refreshing: Promise<void> | null = null;
  private observationError: string | null = null;

  constructor(private readonly deps: Deps) {}

  // Registers tickets as waiting without deciding, so a caller with several tickets has them all
  // ranked before it asks for the first one.
  note(candidates: Candidate[]): void {
    const now = (this.deps.now ?? Date.now)();
    for (const candidate of candidates) {
      this.waiting.set(laneKey(candidate), { ...candidate, seenAt: now });
      this.projects.set(candidate.issueId, candidate.projectId);
    }
  }

  // An admitted ticket that will not start after all (handing it to Paseo failed). Paths that
  // cannot tell let the reservation run out instead.
  release(issueId: string, control = false): void {
    this.reserved.delete(laneKey({ issueId, control }));
  }

  // `cap.limit` null: no limit; 0 admits nothing (a memory lease). Asking registers the ticket as waiting.
  async admit(candidate: Candidate, paseo: PaseoApi, cap: EffectiveLimit): Promise<Admission> {
    // Presence and a zero lease apply even when an earlier ask held a reservation.
    const away = (await this.deps.away?.()) ?? false;
    if (away && candidate.attended) {
      this.waiting.delete(laneKey(candidate));
      return { ok: false, reason: AWAY_REASON };
    }
    this.note([candidate]);
    const limit = cap.limit;
    if (limit === null) {
      const now = (this.deps.now ?? Date.now)();
      const reservation = this.reserved.get(laneKey(candidate));
      if (reservation && reservation.until >= now) {
        this.waiting.delete(laneKey(candidate));
        return { ok: true };
      }
      return this.reserve(candidate, now);
    }
    await this.refresh(paseo);
    // Project reads yield too: make the admission decision only after ALL asynchronous work.
    // No await may separate occupancy/ranking from reserving the resulting slot.
    this.prune((this.deps.now ?? Date.now)());
    if (this.runningCache!.agents.length + this.reserved.size < limit && !this.reserved.has(laneKey(candidate))) {
      for (const { issueId } of this.runningCache!.agents) {
        if (!this.projects.has(issueId)) this.projects.set(issueId, await this.deps.projectOf(issueId).catch(() => null));
      }
    }
    const now = (this.deps.now ?? Date.now)();
    this.prune(now);
    const running = this.runningCache!.agents;
    const used = running.length + this.reserved.size;
    const alreadyReserved = this.reserved.has(laneKey(candidate));
    if (limit === 0 || used > limit || (!alreadyReserved && used >= limit)) {
      return { ok: false, reason: cap.source === "ram" && cap.lease
        ? `Queued: RAM-limited, ${used} of ${limit} slots used (${cap.lease.reason}). It starts when memory frees up.`
        : `Queued: ${used} of ${limit} ticket agents are working. It starts when one finishes.` };
    }
    if (alreadyReserved) {
      this.waiting.delete(laneKey(candidate));
      return { ok: true };
    }
    const load = new Map<string | null, number>();
    for (const { issueId } of running) {
      const projectId = this.projects.get(issueId) ?? null;
      load.set(projectId, (load.get(projectId) ?? 0) + 1);
    }
    for (const { projectId } of this.reserved.values()) load.set(projectId, (load.get(projectId) ?? 0) + 1);
    const line = [...this.waiting.values()].filter((item) => !(away && item.attended));
    const ranked = rankWaiting(line, load, line.length, away);
    let slots = limit - used;
    let controlOccupied = running.some((item) => item.control) || [...this.reserved.values()].some((item) => item.control);
    for (const item of ranked) {
      if (slots === 0) break;
      // A single-slot host must still run workers. Larger caps hold back exactly one slot
      // until a running, reserved or selected control uses it; controls share the hard cap.
      if (!item.control && limit > 1 && !controlOccupied && slots === 1) continue;
      if (laneKey(item) === laneKey(candidate)) return this.reserve(candidate, now);
      slots--;
      controlOccupied ||= Boolean(item.control);
    }
    if (!candidate.control && limit > 1 && !controlOccupied && limit - used === 1) {
      return { ok: false, reason: `Queued: one of ${limit} agent slots is reserved for parent verification. It starts when a worker slot frees up.` };
    }
    const ahead = ranked.findIndex((item) => laneKey(item) === laneKey(candidate));
    return { ok: false, reason: `Queued: ${limit - used} free agent slot${limit - used === 1 ? "" : "s"}, ${ahead} ticket${ahead === 1 ? "" : "s"} ahead. It starts when its turn comes.` };
  }

  // Ticket agents working, admitted ones whose agent is not visible yet, and tickets waiting for a slot.
  async counts(paseo: PaseoApi): Promise<{ running: number; reserved: number; waiting: number }> {
    await this.refresh(paseo);
    this.prune((this.deps.now ?? Date.now)());
    return { running: this.runningCache!.agents.length, reserved: this.reserved.size, waiting: this.waiting.size };
  }

  // Control-plane reads must not wait behind the daemon's full agent/process listing.
  // Admissions still use refresh() and never use an old observation to authorize a start.
  async observedCounts(paseo: PaseoApi): Promise<{ running: number; reserved: number; waiting: number; observedAt: string; stale: boolean; observationError: string | null }> {
    const refresh = this.refresh(paseo).catch((error: unknown) => {
      this.observationError = error instanceof Error ? error.message : String(error);
      throw error;
    });
    // Keep rejection handled even when a cached observation lets this request return immediately.
    void refresh.catch(() => {});
    if (!this.runningCache) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([refresh, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Agent counts are not observed yet; refresh continues in the background.")), 1_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    const observed = this.runningCache;
    if (!observed) throw new Error("Agent counts are unavailable.");
    const now = (this.deps.now ?? Date.now)();
    this.prune(now);
    return {
      running: observed.agents.length, reserved: this.reserved.size, waiting: this.waiting.size,
      observedAt: new Date(observed.at).toISOString(), stale: now - observed.at > RUNNING_CACHE_MS,
      observationError: this.observationError,
    };
  }

  // Tickets asked for within the last WAITING_MS and not admitted: the wait line as it stands.
  waitingIds(): string[] {
    const now = (this.deps.now ?? Date.now)();
    const admitted = new Set([...this.reserved].filter(([, reservation]) => reservation.until >= now).map(([key]) => key));
    for (const agent of this.runningCache?.agents ?? []) admitted.add(laneKey(agent));
    return [...new Set([...this.waiting.values()].filter((item) => now - item.seenAt <= WAITING_MS && !admitted.has(laneKey(item))).map((item) => item.issueId))];
  }

  // Tickets out of the line: admitted (a reservation not run out) or with a working agent, as last read.
  admittedIds(): string[] {
    const now = (this.deps.now ?? Date.now)();
    const reserved = [...this.reserved.values()].filter((reservation) => reservation.until >= now).map((reservation) => reservation.issueId);
    return [...new Set([...reserved, ...(this.runningCache?.agents.map((agent) => agent.issueId) ?? [])])];
  }

  // Concurrent admissions and diagnostics share the full expensive listing/liveness operation.
  // Timestamp its completion, so a slow read does not immediately expire its own result.
  private async refresh(paseo: PaseoApi): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    if (this.runningCache && now - this.runningCache.at <= RUNNING_CACHE_MS) return;
    if (!this.refreshing) {
      this.refreshing = this.deps.running(paseo).then((agents) => {
        this.runningCache = {
          at: (this.deps.now ?? Date.now)(),
          agents: agents.map((agent) => typeof agent === "string" ? { issueId: agent } : agent),
        };
        this.observationError = null;
      }).finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
  }

  private prune(now: number): void {
    const running = new Set(this.runningCache?.agents.map(laneKey));
    for (const [key, reservation] of this.reserved) if (reservation.until < now || running.has(key)) this.reserved.delete(key);
    for (const [key, waiting] of this.waiting) if (now - waiting.seenAt > WAITING_MS || running.has(key) || this.reserved.has(key)) this.waiting.delete(key);
  }

  private reserve(candidate: Candidate, now: number): Admission {
    this.waiting.delete(laneKey(candidate));
    this.reserved.set(laneKey(candidate), { issueId: candidate.issueId, projectId: candidate.projectId, control: Boolean(candidate.control), until: now + RESERVED_MS });
    return { ok: true };
  }
}
