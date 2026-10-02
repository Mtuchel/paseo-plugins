import type { PaseoApi } from "@getpaseo/client";

// Who gets the next free agent slot (README, "Who starts next"). Every path that wants to start a
// ticket asks here: threads waiting their turn, labelled tickets and project tickets. Each ask
// registers the ticket as waiting; while slots are short, the waiting tickets are ranked and only
// the first ones are admitted:
// 1. the project with the fewest agents working first, so one project takes every slot only
//    while nothing else waits, and a project that waits gets the next free slot;
// 2. then priority (urgent first, none last), then the ticket that unblocks the most open tickets,
//    then the oldest.
// An admitted ticket keeps its slot (a reservation) until its agent shows up or a few minutes pass.

// `blocked` tickets never ask: their blockers are checked before.
export type Candidate = { issueId: string; identifier: string; projectId: string | null; priority: number; unblocks: number; createdAt: string };
export type Admission = { ok: true } | { ok: false; reason: string };

// A waiting ticket that has not asked for this long has started, closed or stopped waiting.
const WAITING_MS = 3 * 60_000;
// A reservation whose agent never showed up (a failed start) frees its slot after this long.
const RESERVED_MS = 3 * 60_000;
// The working agents are read once per burst of asks.
const RUNNING_CACHE_MS = 5_000;

type Deps = {
  // Issue ids of the ticket agents working right now.
  running: (paseo: PaseoApi) => Promise<string[]>;
  projectOf: (issueId: string) => Promise<string | null>;
  now?: () => number;
};

export function rankWaiting(waiting: Candidate[], load: Map<string | null, number>, slots: number): Candidate[] {
  const loads = new Map(load);
  const left = [...waiting];
  const picked: Candidate[] = [];
  while (picked.length < slots && left.length) {
    left.sort((a, b) => (loads.get(a.projectId) ?? 0) - (loads.get(b.projectId) ?? 0)
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

export class Scheduler {
  private readonly waiting = new Map<string, Candidate & { seenAt: number }>();
  private readonly reserved = new Map<string, { projectId: string | null; until: number }>();
  private readonly projects = new Map<string, string | null>();
  private runningCache: { at: number; ids: string[] } | null = null;

  constructor(private readonly deps: Deps) {}

  // Registers tickets as waiting without deciding, so a caller with several tickets has them all
  // ranked before it asks for the first one.
  note(candidates: Candidate[]): void {
    const now = (this.deps.now ?? Date.now)();
    for (const candidate of candidates) {
      this.waiting.set(candidate.issueId, { ...candidate, seenAt: now });
      this.projects.set(candidate.issueId, candidate.projectId);
    }
  }

  // An admitted ticket that will not start after all (handing it to Paseo failed). Paths that
  // cannot tell let the reservation run out instead.
  release(issueId: string): void {
    this.reserved.delete(issueId);
  }

  // `limit` 0: no limit. Asking registers the ticket as waiting.
  async admit(candidate: Candidate, paseo: PaseoApi, limit: number): Promise<Admission> {
    if (this.reserved.has(candidate.issueId)) return { ok: true };
    this.note([candidate]);
    const now = (this.deps.now ?? Date.now)();
    if (limit <= 0) return this.reserve(candidate, now);
    if (!this.runningCache || now - this.runningCache.at > RUNNING_CACHE_MS) this.runningCache = { at: now, ids: await this.deps.running(paseo) };
    const running = this.runningCache.ids;
    for (const [issueId, reservation] of this.reserved) if (reservation.until < now || running.includes(issueId)) this.reserved.delete(issueId);
    for (const [issueId, waiting] of this.waiting) if (now - waiting.seenAt > WAITING_MS || running.includes(issueId)) this.waiting.delete(issueId);
    const used = running.length + this.reserved.size;
    if (used >= limit) return { ok: false, reason: `Queued: ${used} of ${limit} ticket agents are working. It starts when one finishes.` };
    const load = new Map<string | null, number>();
    for (const issueId of running) {
      if (!this.projects.has(issueId)) this.projects.set(issueId, await this.deps.projectOf(issueId).catch(() => null));
      const projectId = this.projects.get(issueId) ?? null;
      load.set(projectId, (load.get(projectId) ?? 0) + 1);
    }
    for (const { projectId } of this.reserved.values()) load.set(projectId, (load.get(projectId) ?? 0) + 1);
    const picked = rankWaiting([...this.waiting.values()], load, limit - used);
    if (picked.some((item) => item.issueId === candidate.issueId)) return this.reserve(candidate, now);
    const ahead = rankWaiting([...this.waiting.values()], load, this.waiting.size).findIndex((item) => item.issueId === candidate.issueId);
    return { ok: false, reason: `Queued: ${limit - used} free agent slot${limit - used === 1 ? "" : "s"}, ${ahead} ticket${ahead === 1 ? "" : "s"} ahead. It starts when its turn comes.` };
  }

  private reserve(candidate: Candidate, now: number): Admission {
    this.waiting.delete(candidate.issueId);
    this.reserved.set(candidate.issueId, { projectId: candidate.projectId, until: now + RESERVED_MS });
    return { ok: true };
  }
}
