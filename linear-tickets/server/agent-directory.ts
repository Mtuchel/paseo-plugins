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

// More agents than this leaving the live listing at once (a bulk archive) cost more to read one by
// one than one rescan of the archived listing.
const MAX_DEPARTURE_READS = 50;

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
  // Agents that left the live listing since the archived index was last brought up to date.
  private departed = new Set<string>();

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
    this.departed.clear();
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
    const epoch = this.archivedEpoch;
    const flight = this.archivedFlight;
    if (flight && flight.generation === epoch) return [...(await flight.promise)];
    if (snapshot && snapshot.epoch === epoch && now - snapshot.completedAt < this.archivedTtlMs) {
      if (this.departed.size === 0) return [...snapshot.agents];
      // A few agents left the live listing: one agent read each instead of rescanning the whole
      // archived listing (~55 pages, each of which makes the daemon rebuild every agent).
      if (this.departed.size <= MAX_DEPARTURE_READS) return [...(await this.track(epoch, this.readDepartures(paseo, snapshot)))];
    }
    // Keyed on the archived epoch only: invalidate() (every agent created or archived) concerns the
    // live list, and restarting the archived scan for it would cost what this saves. Agents
    // archived meanwhile leave the live list and are read one by one (see readDepartures).
    this.departed.clear();
    return [...(await this.track(epoch, this.scan(paseo, true).then((agents) => {
      const archived = agents.filter((agent) => Boolean(agent.archivedAt));
      if (this.archivedEpoch === epoch) this.archivedSnapshot = { agents: archived, completedAt: this.now(), epoch };
      return archived;
    })))];
  }

  private track(epoch: number, work: Promise<PaseoAgent[]>): Promise<PaseoAgent[]> {
    const promise = work.finally(() => {
      if (this.archivedFlight?.promise === promise) this.archivedFlight = null;
    });
    this.archivedFlight = { generation: epoch, promise };
    return promise;
  }

  // Brings the archived index up to date with the agents that left the live listing: an archived
  // one is added with its archive time, a deleted one dropped. A failed read makes the next reader
  // rescan the whole archived listing instead of keeping an index that may lack the agent.
  private async readDepartures(paseo: PaseoApi, snapshot: ArchivedSnapshot): Promise<PaseoAgent[]> {
    const ids = [...this.departed];
    this.departed.clear();
    const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    try {
      for (const id of ids) {
        const read = await paseo.agents.ref(id).refresh().catch((error: unknown) => {
          if (error instanceof Error && /not found/i.test(error.message)) return null;
          throw error;
        });
        if (!read) byId.delete(id);
        else if (read.agent.archivedAt) byId.set(id, read.agent);
      }
    } catch (error) {
      if (this.archivedEpoch === snapshot.epoch) this.archivedEpoch++;
      throw error;
    }
    const agents = [...byId.values()];
    if (this.archivedSnapshot === snapshot) this.archivedSnapshot = { ...snapshot, agents };
    return agents;
  }

  // Every completed live scan detects departures, also one that only live() ran: all() then reads
  // them instead of waiting out archivedTtlMs.
  private observeLive(agents: PaseoAgent[]): void {
    const ids = new Set(agents.map((agent) => agent.id));
    if (this.lastLiveIds) for (const id of this.lastLiveIds) if (!ids.has(id)) this.departed.add(id);
    for (const id of ids) this.departed.delete(id);
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