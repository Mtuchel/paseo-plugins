import type { PaseoAgent, PaseoApi } from "@getpaseo/client";

// One shared agent listing for the plugin's periodic readers. The daemon rebuilds and sorts every
// agent for each page it serves, so the list requests are the cost this directory exists to cut.
export type AgentDirectoryOptions = {
  now?: () => number;
  liveTtlMs?: number;
  archivedTtlMs?: number;
  pageLimit?: number;
  maxPages?: number;
};

type Snapshot = { agents: PaseoAgent[]; completedAt: number };
type LiveSnapshot = Snapshot & { generation: number };
type ArchivedSnapshot = Snapshot & { epoch: number };
type Flight = { generation: number; promise: Promise<PaseoAgent[]> };

type PageInfo = { hasMore?: boolean; nextCursor?: string | null } | null | undefined;

export class AgentDirectory {
  private readonly now: () => number;
  private readonly liveTtlMs: number;
  private readonly archivedTtlMs: number;
  private readonly pageLimit: number;
  private readonly maxPages: number;
  private source: PaseoApi | null = null;
  private generation = 0;
  private liveSnapshot: LiveSnapshot | null = null;
  private liveFlight: Flight | null = null;
  private archivedSnapshot: ArchivedSnapshot | null = null;
  private archivedEpoch = 0;
  private archivedFlight: Flight | null = null;
  // The ids of the last completed live scan: a later scan that lacks one saw an agent leave.
  private lastLiveIds: Set<string> | null = null;

  constructor(options: AgentDirectoryOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.liveTtlMs = options.liveTtlMs ?? 20_000;
    this.archivedTtlMs = options.archivedTtlMs ?? 600_000;
    this.pageLimit = options.pageLimit ?? 200;
    this.maxPages = options.maxPages ?? 100;
  }

  attach(paseo: PaseoApi): void {
    this.source = paseo;
    // A new source serves every following scan: an older snapshot or scan describes another host.
    this.generation++;
    this.liveSnapshot = null;
    this.archivedSnapshot = null;
    this.archivedEpoch++;
    this.lastLiveIds = null;
  }

  invalidate(): void {
    this.generation++;
  }

  async live(): Promise<PaseoAgent[]> {
    const paseo = this.source;
    if (!paseo) throw new Error("Paseo source unavailable");
    const now = this.now();
    if (this.liveSnapshot && this.liveSnapshot.generation === this.generation && now - this.liveSnapshot.completedAt < this.liveTtlMs) {
      return [...this.liveSnapshot.agents];
    }
    const generation = this.generation;
    const flight = this.liveFlight;
    if (flight && flight.generation === generation) return [...(await flight.promise)];
    const promise = this.scan(paseo, false).then((agents) => {
      const live = agents.filter((agent) => !agent.archivedAt);
      this.observeLive(live);
      // A scan invalidated while it ran still answers its readers, but must not pass as fresh.
      if (this.generation === generation) this.liveSnapshot = { agents: live, completedAt: this.now(), generation };
      return live;
    }).finally(() => {
      if (this.liveFlight?.promise === promise) this.liveFlight = null;
    });
    this.liveFlight = { generation, promise };
    return [...(await promise)];
  }

  async all(): Promise<PaseoAgent[]> {
    const live = await this.live();
    const archived = await this.archivedIndex();
    const liveIds = new Set(live.map((agent) => agent.id));
    // An agent both lists hold is live (the daemon re-listed it after an unarchive).
    return [...live, ...archived.filter((agent) => !liveIds.has(agent.id))];
  }

  private async archivedIndex(): Promise<PaseoAgent[]> {
    const paseo = this.source;
    if (!paseo) throw new Error("Paseo source unavailable");
    const now = this.now();
    const snapshot = this.archivedSnapshot;
    if (snapshot && snapshot.epoch === this.archivedEpoch && now - snapshot.completedAt < this.archivedTtlMs) {
      return [...snapshot.agents];
    }
    // Keyed on the archived epoch only: invalidate() (every agent created or archived) concerns the
    // live list, and restarting a ~36 page archived scan for it would cost what this saves. An
    // agent archived meanwhile leaves the live list, which advances the epoch.
    const epoch = this.archivedEpoch;
    const flight = this.archivedFlight;
    if (flight && flight.generation === epoch) return [...(await flight.promise)];
    const promise = this.scan(paseo, true).then((agents) => {
      const archived = agents.filter((agent) => Boolean(agent.archivedAt));
      if (this.archivedEpoch === epoch) this.archivedSnapshot = { agents: archived, completedAt: this.now(), epoch };
      return archived;
    }).finally(() => {
      if (this.archivedFlight?.promise === promise) this.archivedFlight = null;
    });
    this.archivedFlight = { generation: epoch, promise };
    return [...(await promise)];
  }

  // Every completed live scan detects departures, also one that only live() ran: all() then
  // rescans the archived index instead of waiting out archivedTtlMs.
  private observeLive(agents: PaseoAgent[]): void {
    const ids = new Set(agents.map((agent) => agent.id));
    if (this.lastLiveIds && [...this.lastLiveIds].some((id) => !ids.has(id))) this.archivedEpoch++;
    this.lastLiveIds = ids;
  }

  private async scan(paseo: PaseoApi, includeArchived: boolean): Promise<PaseoAgent[]> {
    const agents: PaseoAgent[] = [];
    const used = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const result = await paseo.agents.list({
        filter: { includeArchived },
        page: { limit: this.pageLimit, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of result.entries) agents.push(entry.agent);
      // A page without page info cannot tell whether the listing continues: refuse it rather
      // than claim a partial list is the whole one.
      if (!("pageInfo" in result) || !result.pageInfo) throw new Error("Agent listing incomplete");
      const info: PageInfo = result.pageInfo;
      if (!info.hasMore) return agents;
      const next = info.nextCursor;
      if (!next || used.has(next)) throw new Error("Agent listing incomplete");
      used.add(next);
      cursor = next;
    }
    throw new Error("Agent listing exceeds safe bound");
  }
}