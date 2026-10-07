import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "./rate-budget";

// Exact daemon traffic, separate from the credential-wide remaining budget. MCP processes and
// host scripts share credentials but do not pass this transport; no header-difference attribution
// is attempted (concurrent responses may arrive out of order, and refill caps hide consumption).
const WINDOW_MS = 60 * 60 * 1000;
const BUCKET_MS = 60 * 1000;
const callers = new AsyncLocalStorage<string>();

export function asCaller<T>(name: string, work: () => T): T {
  return callers.run(name, work);
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

function header(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function operationName(query: string): string {
  return /^\s*(?:(?:#[^\n]*\n)\s*)*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
}

export class LinearUsage {
  private readonly loadedAt: number;
  private buckets: Bucket[] = [];
  private readonly last: Partial<Record<Pool, Last>> = {};

  constructor(private readonly now: () => number = Date.now) {
    this.loadedAt = now();
  }

  // Called exactly once per sent request, including failed/limited responses. Local budget
  // refusals do not reach this method. Null/missing X-Complexity is unknown, never a free call.
  record(pool: Pool, query: string, headers: Headers | null): void {
    const at = this.now();
    const start = at - at % BUCKET_MS;
    let bucket = this.buckets.at(-1);
    if (bucket?.start !== start) {
      bucket = { start, rows: new Map() };
      this.buckets.push(bucket);
      this.buckets = this.buckets.filter((item) => item.start >= start - WINDOW_MS + BUCKET_MS);
    }
    const points = headers ? header(headers, "x-complexity") : null;
    const caller = callers.getStore() ?? "other";
    const operation = operationName(query);
    const key = `${pool}\u0000${caller}\u0000${operation}`;
    const row = bucket.rows.get(key) ?? { pool, caller, operation, requests: 0, points: 0, unmetered: 0 };
    row.requests++;
    row.points += points ?? 0;
    if (points === null) row.unmetered++;
    bucket.rows.set(key, row);
    if (headers) this.last[pool] = {
      observedAt: new Date(at).toISOString(),
      requestsRemaining: header(headers, "x-ratelimit-requests-remaining"),
      requestsLimit: header(headers, "x-ratelimit-requests-limit"),
      pointsRemaining: header(headers, "x-ratelimit-complexity-remaining"),
      pointsLimit: header(headers, "x-ratelimit-complexity-limit"),
    };
  }

  // At most 60 minute buckets, including the current partial minute. `since` is the actual
  // coverage boundary, not the first request's minute; periods with no traffic still count.
  snapshot(): UsageSnapshot {
    const at = this.now();
    const cutoff = at - at % BUCKET_MS - WINDOW_MS + BUCKET_MS;
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
