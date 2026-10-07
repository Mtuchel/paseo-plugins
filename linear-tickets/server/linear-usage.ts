import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool, Priority } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";

// One accounting event feeds exact rolling daemon traffic and persistent hourly history.
// MCP processes and host scripts share credentials but are not attributed; only isolated
// header intervals contribute an explicitly partial estimate of outside spend.
const HOUR_MS = 60 * 60 * 1000;
const BUCKET_MS = 60 * 1000;
const SAMPLE_MAX_AGE_MS = 5 * 60 * 1000;
const RETENTION_MS = 8 * 24 * HOUR_MS;
const WRITE_INTERVAL_MS = 60 * 1000;
const POOLS: Pool[] = ["app", "key"];
const DIMENSIONS = ["requests", "points"] as const;
type Dimension = typeof DIMENSIONS[number];
type RefusedLevel = Extract<Priority, "background" | "interactive">;
const callers = new AsyncLocalStorage<string>();

export function asCaller<T>(name: string, work: () => T): T {
  return callers.run(name, work);
}

// The caller name of the innermost `asCaller` context, or undefined outside one. RateBudget
// resolves a request without a context to `op:<operation>`.
export function currentCallerName(): string | undefined {
  return callers.getStore();
}

export type UsageRow = { pool: Pool; caller: string; operation: string; requests: number; points: number; unmetered: number };
export type PoolUsage = {
  pool: Pool;
  observedAt: string | null;
  requestsRemaining: number | null; requestsLimit: number | null;
  pointsRemaining: number | null; pointsLimit: number | null;
  requests: number; points: number; unmetered: number;
};
export type UsageSnapshot = { since: string; until: string; pools: PoolUsage[]; rows: UsageRow[] };
type Bucket = { start: number; rows: Map<string, UsageRow> };
type Last = { observedAt: string; requestsRemaining: number | null; requestsLimit: number | null; pointsRemaining: number | null; pointsLimit: number | null };

export type LinearUsageBucket = {
  limits: { requests: number | null; points: number | null };
  requests: number;
  points: number;
  estimatedPoints: number;
  limited: number;
  blockedMs: number;
  refused: { background: number; interactive: number };
  minRemaining: { requests: number | null; points: number | null };
  outside: { requests: { spent: number; observedMs: number }; points: { spent: number; observedMs: number } };
  callers: Record<string, { requests: number; points: number; refused: number }>;
};
export type LinearUsageHistory = { version: 1; hours: Record<string, Partial<Record<Pool, LinearUsageBucket>>> };
export type LinearUsageSummary = {
  pool: Pool;
  start: string;
  callers: Array<{ caller: string; requests: number; points: number }>;
  outside: { requests: { spent: number; observedShare: number }; points: { spent: number; observedShare: number } };
};
export type LinearUsageOptions = {
  path?: string;
  // The cancellation function keeps fake timers independent of Node's timer handle type.
  timer?: (tick: () => Promise<void>, intervalMs: number) => () => void;
  log?: (message: string) => void;
};
export type LinearUsageHandle = { done(headers: Headers | null, limited: boolean, estimatedCost: number): void };

type HeaderSample = { limit: number; remaining: number; at: number; clean: boolean };
type RequestSample = { clean: boolean };
type Block = { since: number; until: number };

function hourStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function emptyBucket(): LinearUsageBucket {
  return {
    limits: { requests: null, points: null }, requests: 0, points: 0, estimatedPoints: 0,
    limited: 0, blockedMs: 0, refused: { background: 0, interactive: 0 },
    minRemaining: { requests: null, points: null },
    outside: { requests: { spent: 0, observedMs: 0 }, points: { spent: 0, observedMs: 0 } },
    callers: Object.create(null),
  };
}

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function operationName(query: string): string {
  return /^\s*(?:(?:#[^\n]*\n)\s*)*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
}

function dimensionHeader(headers: Headers, dimension: Dimension): { limit: number; remaining: number } | null {
  const name = dimension === "requests" ? "requests" : "complexity";
  const limit = numberHeader(headers, `x-ratelimit-${name}-limit`);
  const remaining = numberHeader(headers, `x-ratelimit-${name}-remaining`);
  return limit !== null && limit > 0 && remaining !== null ? { limit, remaining } : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validBucket(value: unknown): value is LinearUsageBucket {
  if (!record(value) || !record(value.limits) || !record(value.refused) || !record(value.minRemaining)
    || !record(value.outside) || !record(value.callers)) return false;
  for (const name of ["requests", "points", "estimatedPoints", "limited", "blockedMs"]) {
    if (!nonnegative(value[name])) return false;
  }
  if (!nonnegative(value.blockedMs) || value.blockedMs > HOUR_MS
    || !nonnegative(value.refused.background) || !nonnegative(value.refused.interactive)) return false;
  for (const dimension of DIMENSIONS) {
    const limit = value.limits[dimension];
    const outside = value.outside[dimension];
    const remaining = value.minRemaining[dimension];
    if (!(limit === null || (nonnegative(limit) && limit > 0))
      || !(remaining === null || (nonnegative(remaining) && remaining <= 1))
      || !record(outside) || typeof outside.spent !== "number" || !Number.isFinite(outside.spent)
      || !nonnegative(outside.observedMs) || outside.observedMs > HOUR_MS) return false;
  }
  return Object.values(value.callers).every((caller) => record(caller)
    && nonnegative(caller.requests) && nonnegative(caller.points) && nonnegative(caller.refused));
}

function validHistory(value: unknown): value is LinearUsageHistory {
  if (!record(value) || value.version !== 1 || !record(value.hours)) return false;
  return Object.entries(value.hours).every(([start, pools]) => {
    const at = Date.parse(start);
    return Number.isFinite(at) && new Date(hourStart(at)).toISOString() === start && record(pools)
      && Object.entries(pools).every(([pool, bucket]) => POOLS.includes(pool as Pool) && validBucket(bucket));
  });
}

function mergeBucket(current: LinearUsageBucket, saved: LinearUsageBucket): void {
  for (const name of ["requests", "points", "estimatedPoints", "limited"] as const) current[name] += saved[name];
  current.blockedMs = Math.min(HOUR_MS, current.blockedMs + saved.blockedMs);
  for (const level of ["background", "interactive"] as const) current.refused[level] += saved.refused[level];
  for (const dimension of DIMENSIONS) {
    current.limits[dimension] ??= saved.limits[dimension];
    const minimum = saved.minRemaining[dimension];
    if (minimum !== null) current.minRemaining[dimension] = Math.min(current.minRemaining[dimension] ?? minimum, minimum);
    current.outside[dimension].spent += saved.outside[dimension].spent;
    current.outside[dimension].observedMs = Math.min(HOUR_MS, current.outside[dimension].observedMs + saved.outside[dimension].observedMs);
  }
  for (const [name, savedCaller] of Object.entries(saved.callers)) {
    const caller = current.callers[name] ??= { requests: 0, points: 0, refused: 0 };
    caller.requests += savedCaller.requests;
    caller.points += savedCaller.points;
    caller.refused += savedCaller.refused;
  }
}

function minuteTimer(tick: () => Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Request accounting is independent of admission: uncertain/missing samples never imply outside
// spend, and failed persistence must not prevent the next Linear request from being sent.
export class LinearUsage {
  private readonly loadedAt: number;
  private readonly now: () => number;
  private readonly suppliedPath: string | undefined;
  private readonly timer: NonNullable<LinearUsageOptions["timer"]>;
  private readonly log: NonNullable<LinearUsageOptions["log"]>;
  private buckets: Bucket[] = [];
  private readonly last: Partial<Record<Pool, Last>> = {};
  private readonly history: LinearUsageHistory = { version: 1, hours: Object.create(null) };
  private readonly inFlight: Record<Pool, Set<RequestSample>> = { app: new Set(), key: new Set() };
  private readonly previous: Record<Pool, Partial<Record<Dimension, HeaderSample>>> = { app: {}, key: {} };
  private readonly blocks: Record<Pool, Block | null> = { app: null, key: null };
  private readonly logged = new Set<string>();
  private resolvedPath: string | null = null;
  private cancelTimer: (() => void) | null = null;
  private active = false;
  private loading: Promise<void> | null = null;
  private writing = Promise.resolve();
  private readonly finishDrains = new Set<() => void>();

  constructor(now: () => number = () => Date.now(), options: LinearUsageOptions = {}) {
    this.now = now;
    this.loadedAt = now();
    this.suppliedPath = options.path;
    this.timer = options.timer ?? minuteTimer;
    this.log = options.log ?? ((message) => console.error(message));
  }

  private get path(): string {
    return this.resolvedPath ??= this.suppliedPath ?? join(paseoHome(), "linear-tickets", "linear-usage.json");
  }

  async start(): Promise<void> {
    this.active = true;
    this.loading ??= this.load();
    await this.loading;
    if (!this.active || this.cancelTimer) return;
    this.roll(this.now());
    this.cancelTimer = this.timer(() => this.flush(), WRITE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.active = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.loading ??= this.load();
    await this.loading;
    // Unload must persist responses of requests which were already admitted. Promise
    // continuations can admit their next request; give that chain an event-loop turn.
    do {
      while (this.inFlight.app.size || this.inFlight.key.size) {
        await new Promise<void>((resolve) => { this.finishDrains.add(resolve); });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (this.inFlight.app.size || this.inFlight.key.size);
    await this.flush();
  }

  // Exactly one handle per sent request, including failed/limited responses; local budget
  // refusals do not reach this method. `done` records the answer once and never throws:
  // counting must not decide whether the request goes out or how its response is reported.
  invalidateContinuity(pool: Pool): void {
    this.previous[pool] = {};
    for (const sample of this.inFlight[pool]) sample.clean = false;
  }

  begin(pool: Pool, caller: string, operation: string): LinearUsageHandle {
    const active = this.inFlight[pool];
    const sample: RequestSample = { clean: active.size === 0 };
    // Mark BOTH sides of an overlap, including a request which will answer first.
    for (const other of active) other.clean = false;
    active.add(sample);
    let finished = false;
    return {
      done: (headers, limited, estimatedCost) => {
        if (finished) return;
        finished = true;
        active.delete(sample);
        const at = this.now();
        // The rolling view counts every sent request: a failed send still spends the credential's
        // budget, even though no answer can say by how much.
        this.count(pool, caller, operation, headers, at);
        if (headers === null) {
          // A network failure may still have spent budget upstream; do not label it outside.
          this.previous[pool] = {};
          this.settled();
          return;
        }
        this.roll(at);
        const bucket = this.bucket(pool, at);
        const cost = numberHeader(headers, "x-complexity");
        const points = cost ?? estimatedCost;
        bucket.requests++;
        bucket.points += points;
        if (cost === null) bucket.estimatedPoints += points;
        if (limited) bucket.limited++;
        const named = bucket.callers[caller] ??= { requests: 0, points: 0, refused: 0 };
        named.requests++;
        named.points += points;
        for (const dimension of DIMENSIONS) this.answer(pool, dimension, headers, at, sample.clean, dimension === "requests" ? 1 : points, bucket);
        this.settled();
      },
    };
  }

  private settled(): void {
    if (this.inFlight.app.size || this.inFlight.key.size) return;
    for (const resolve of this.finishDrains) resolve();
    this.finishDrains.clear();
  }

  refused(pool: Pool, caller: string, level: RefusedLevel): void {
    const at = this.now();
    this.roll(at);
    const bucket = this.bucket(pool, at);
    bucket.refused[level]++;
    const named = bucket.callers[caller] ??= { requests: 0, points: 0, refused: 0 };
    named.refused++;
  }

  block(pool: Pool, until: number): void {
    const at = this.now();
    this.roll(at);
    if (until <= at) return;
    this.blocks[pool] = { since: at, until: Math.max(until, this.blocks[pool]?.until ?? until) };
  }

  summary(): LinearUsageSummary[] {
    const at = this.now();
    this.roll(at);
    const start = new Date(hourStart(at)).toISOString();
    return POOLS.map((pool) => {
      const bucket = this.bucket(pool, at);
      return {
        pool, start,
        callers: Object.entries(bucket.callers).map(([caller, counts]) => ({ caller, requests: counts.requests, points: counts.points }))
          .sort((a, b) => b.points - a.points || b.requests - a.requests || a.caller.localeCompare(b.caller)).slice(0, 10),
        outside: {
          requests: { spent: Math.max(0, bucket.outside.requests.spent), observedShare: bucket.outside.requests.observedMs / HOUR_MS },
          points: { spent: Math.max(0, bucket.outside.points.spent), observedShare: bucket.outside.points.observedMs / HOUR_MS },
        },
      };
    });
  }

  // At most 60 minute buckets, including the current partial minute. `since` is the actual
  // coverage boundary, not the first request's minute; periods with no traffic still count.
  snapshot(): UsageSnapshot {
    const at = this.now();
    const cutoff = at - at % BUCKET_MS - HOUR_MS + BUCKET_MS;
    const rows = new Map<string, UsageRow>();
    for (const bucket of this.buckets) {
      if (bucket.start < cutoff) continue;
      for (const [key, row] of bucket.rows) {
        const sum = rows.get(key) ?? { ...row, requests: 0, points: 0, unmetered: 0 };
        sum.requests += row.requests;
        sum.points += row.points;
        sum.unmetered += row.unmetered;
        rows.set(key, sum);
      }
    }
    const sorted = [...rows.values()].sort((a, b) => b.points - a.points || b.requests - a.requests);
    const pools = (["app", "key"] as const).map((pool): PoolUsage => {
      const own = sorted.filter((row) => row.pool === pool);
      const last = this.last[pool];
      return {
        pool, observedAt: last?.observedAt ?? null,
        requestsRemaining: last?.requestsRemaining ?? null, requestsLimit: last?.requestsLimit ?? null,
        pointsRemaining: last?.pointsRemaining ?? null, pointsLimit: last?.pointsLimit ?? null,
        requests: own.reduce((sum, row) => sum + row.requests, 0),
        points: own.reduce((sum, row) => sum + row.points, 0),
        unmetered: own.reduce((sum, row) => sum + row.unmetered, 0),
      };
    });
    return { since: new Date(Math.max(this.loadedAt, cutoff)).toISOString(), until: new Date(at).toISOString(), pools, rows: sorted };
  }

  // The rolling last-hour view: minute buckets keyed by pool, caller and operation.
  private count(pool: Pool, caller: string, operation: string, headers: Headers | null, at: number): void {
    const start = at - at % BUCKET_MS;
    let bucket = this.buckets.at(-1);
    if (bucket?.start !== start) {
      bucket = { start, rows: new Map() };
      this.buckets.push(bucket);
      this.buckets = this.buckets.filter((item) => item.start >= start - HOUR_MS + BUCKET_MS);
    }
    const points = headers ? numberHeader(headers, "x-complexity") : null;
    const key = `${pool}\u0000${caller}\u0000${operation}`;
    const row = bucket.rows.get(key) ?? { pool, caller, operation, requests: 0, points: 0, unmetered: 0 };
    row.requests++;
    row.points += points ?? 0;
    if (points === null) row.unmetered++;
    bucket.rows.set(key, row);
    if (headers) this.last[pool] = {
      observedAt: new Date(at).toISOString(),
      requestsRemaining: numberHeader(headers, "x-ratelimit-requests-remaining"),
      requestsLimit: numberHeader(headers, "x-ratelimit-requests-limit"),
      pointsRemaining: numberHeader(headers, "x-ratelimit-complexity-remaining"),
      pointsLimit: numberHeader(headers, "x-ratelimit-complexity-limit"),
    };
  }

  private bucket(pool: Pool, at: number): LinearUsageBucket {
    const start = new Date(hourStart(at)).toISOString();
    const pools = this.history.hours[start] ??= {};
    return pools[pool] ??= emptyBucket();
  }

  private answer(pool: Pool, dimension: Dimension, headers: Headers, at: number, clean: boolean, cost: number, bucket: LinearUsageBucket): void {
    const header = dimensionHeader(headers, dimension);
    const previous = this.previous[pool][dimension];
    if (header === null) {
      delete this.previous[pool][dimension];
      return;
    }
    bucket.limits[dimension] = header.limit;
    const fraction = Math.min(1, header.remaining / header.limit);
    bucket.minRemaining[dimension] = Math.min(bucket.minRemaining[dimension] ?? fraction, fraction);
    const elapsed = previous ? at - previous.at : 0;
    if (previous?.clean && clean && elapsed > 0 && elapsed <= SAMPLE_MAX_AGE_MS) {
      const outside = bucket.outside[dimension];
      const observed = Math.min(at - Math.max(previous.at, hourStart(at)), HOUR_MS - outside.observedMs);
      const refilled = Math.min(header.limit, previous.remaining + header.limit / HOUR_MS * elapsed);
      const step = refilled - header.remaining - cost;
      // At capacity, refill during the request can hide its own cost; that loss of information
      // must not invent negative outside spend. Unsaturated observations remain signed.
      const spent = refilled === header.limit || header.remaining >= header.limit ? Math.max(0, step) : step;
      // The preceding hour is dropped rather than pretending to know when its spend happened.
      outside.spent += spent * observed / elapsed;
      outside.observedMs += observed;
    }
    this.previous[pool][dimension] = { ...header, at, clean };
  }

  private roll(at: number): void {
    const cutoff = at - RETENTION_MS;
    for (const pool of POOLS) {
      const block = this.blocks[pool];
      if (block && at > block.since) {
        const end = Math.min(at, block.until);
        let from = Math.max(block.since, hourStart(cutoff));
        while (from < end) {
          const to = Math.min(end, hourStart(from) + HOUR_MS);
          this.bucket(pool, from).blockedMs += to - from;
          from = to;
        }
        block.since = end;
        if (at >= block.until) this.blocks[pool] = null;
      }
      this.bucket(pool, at);
    }
    for (const start of Object.keys(this.history.hours)) {
      if (Date.parse(start) < cutoff) delete this.history.hours[start];
    }
  }

  private report(action: string, error: unknown, temporary?: string): void {
    let message = error instanceof Error ? error.message : String(error);
    if (temporary) message = message.replaceAll(temporary, this.path);
    const key = `${action}: ${message}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(`[linear-tickets] Linear usage ${key}`);
  }

  private async load(): Promise<void> {
    try {
      const saved: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!validHistory(saved)) throw new Error("invalid version or hourly buckets");
      // start() is deliberately nonblocking at plugin contribution. Preserve answers which
      // arrive while disk I/O is pending, with their newer header limits taking precedence.
      for (const [start, pools] of Object.entries(saved.hours)) {
        for (const pool of POOLS) {
          if (pools[pool]) mergeBucket(this.bucket(pool, Date.parse(start)), pools[pool]);
        }
      }
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return;
      this.report("load failed; starting empty", error);
    }
  }

  private flush(): Promise<void> {
    const write = async () => {
      this.roll(this.now());
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      let prepared = false;
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        prepared = true;
        await writeFile(temporary, JSON.stringify(this.history), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } catch (error) {
        this.report("write failed", error, temporary);
      } finally {
        if (prepared) await rm(temporary, { force: true }).catch((error: unknown) => this.report("temporary cleanup failed", error, temporary));
      }
    };
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}

export function usageLines(snapshot: UsageSnapshot, top = 12): string[] {
  return snapshot.pools.filter((pool) => pool.requests).map((pool) => {
    const callers = snapshot.rows.filter((row) => row.pool === pool.pool).slice(0, top)
      .map((row) => `${row.caller}/${row.operation} ${row.points}/${row.requests} (${row.unmetered} unmetered)`).join(", ");
    return `[linear-tickets] Linear usage ${snapshot.since}..${snapshot.until} (${pool.pool}): `
      + `daemon ${pool.points} points / ${pool.requests} requests (${pool.unmetered} unmetered); `
      + `credential left ${pool.pointsRemaining ?? "?"}/${pool.pointsLimit ?? "?"} points, ${pool.requestsRemaining ?? "?"}/${pool.requestsLimit ?? "?"} requests at ${pool.observedAt ?? "unknown"}; `
      + `top (points/requests): ${callers}`;
  });
}

export const linearUsage = new LinearUsage();
