import { AsyncLocalStorage } from "node:async_hooks";

// Linear meters requests per credential: the owner's API key (2,500/h, shared by every key of
// that user) and the Paseo app token (5,000/h per app user) are separate pools. Both refill at a
// constant rate (a leaky bucket: limit / 1 h), so the budget of a pool is estimated from the last
// response's `X-RateLimit-Requests-Remaining` plus the refill since then. The `-Reset` header is
// not used: Linear always reports it as one hour from now.
export type Pool = "key" | "app";
export type Priority = "interactive" | "background";

const PERIOD_MS = 60 * 60 * 1000;
// Background work leaves this share of a pool to interactive work (sessions, write-backs, MCP).
export const RESERVE_FRACTION = 0.15;
const MIN_BLOCK_MS = 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
// While the single probe after a block is in flight, other callers are told to come back shortly.
const PROBE_WAIT_MS = 10 * 1000;

export function poolOf(authorization: string): Pool {
  return /^Bearer\s/i.test(authorization) ? "app" : "key";
}

export function poolName(pool: Pool): string {
  return pool === "key" ? "the Linear API key" : "the Paseo Linear app";
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export class RateLimitedError extends Error {
  // `reserve`: the pool still has requests, but they are kept for interactive work.
  constructor(readonly pool: Pool, readonly resumeAt: number, readonly reason: "limited" | "reserve" = "limited") {
    super(reason === "limited"
      ? `Linear's hourly request limit is reached for ${poolName(pool)}; try again after ~${clock(resumeAt)}.`
      : `Background Linear work is paused to keep ${poolName(pool)}'s last requests for agents; it resumes ~${clock(resumeAt)}.`);
    this.name = "RateLimitedError";
  }
}

type PoolState = {
  limit: number | null;
  remaining: number;
  at: number;
  inFlight: number;
  blockedUntil: number;
  backoffMs: number;
  probing: boolean;
};

export type Ticket = {
  // `headers` of the response, when there was one.
  done(headers: Headers | null, rateLimited: boolean): void;
};

const UNKNOWN: PoolState = { limit: null, remaining: 0, at: 0, inFlight: 0, blockedUntil: 0, backoffMs: 0, probing: false };

const priority = new AsyncLocalStorage<Priority>();

// Everything `work` sends to Linear, including awaited calls deep inside it, runs at this priority.
// Pollers and sweeps run at background priority, which pauses before a pool's reserve is touched.
export function withPriority<T>(level: Priority, work: () => Promise<T>): Promise<T> {
  return priority.run(level, work);
}

export class RateBudget {
  private readonly pools: Record<Pool, PoolState> = { key: { ...UNKNOWN }, app: { ...UNKNOWN } };

  constructor(private readonly now: () => number = () => Date.now()) {}

  private rate(state: PoolState): number {
    return (state.limit ?? 0) / PERIOD_MS;
  }

  // Requests the pool can take now, minus those already on their way. Unknown before the
  // first response: Infinity, so a fresh plugin never waits on a guess.
  estimate(pool: Pool): number {
    const state = this.pools[pool];
    if (state.limit === null) return Infinity;
    const refilled = Math.min(state.limit, state.remaining + this.rate(state) * (this.now() - state.at));
    return refilled - state.inFlight;
  }

  private reserve(state: PoolState): number {
    return Math.ceil((state.limit ?? 0) * RESERVE_FRACTION);
  }

  // When background work on this pool may run again, or null when it may run now. `room` asks
  // for that many requests above the reserve (a dispatch launch needs several in a row).
  pausedUntil(pool: Pool, room = 1): number | null {
    const state = this.pools[pool];
    const now = this.now();
    if (state.blockedUntil > now) return state.blockedUntil;
    if (state.blockedUntil) return state.probing ? now + PROBE_WAIT_MS : null;
    if (state.limit === null) return null;
    const missing = this.reserve(state) + room - this.estimate(pool);
    if (missing <= 0) return null;
    return now + Math.ceil(missing / this.rate(state));
  }

  // Admission for one request. Interactive requests always pass unless the pool is blocked by a
  // rate-limit response; background requests also stop at the reserve. The check and the
  // in-flight count happen together, so concurrent callers near the reserve cannot all pass.
  acquire(pool: Pool, level: Priority = priority.getStore() ?? "interactive"): Ticket {
    const state = this.pools[pool];
    const now = this.now();
    if (state.blockedUntil > now) throw new RateLimitedError(pool, state.blockedUntil);
    let probe = false;
    if (state.blockedUntil) {
      if (state.probing) throw new RateLimitedError(pool, now + PROBE_WAIT_MS);
      state.probing = probe = true;
    } else if (level === "background") {
      const until = this.pausedUntil(pool);
      if (until !== null) throw new RateLimitedError(pool, until, "reserve");
    }
    state.inFlight++;
    let settled = false;
    return {
      done: (headers, rateLimited) => {
        if (settled) return;
        settled = true;
        state.inFlight--;
        if (probe) state.probing = false;
        this.record(pool, headers);
        if (rateLimited) this.block(pool);
        else if (probe && headers) {
          state.blockedUntil = 0;
          state.backoffMs = 0;
        }
      },
    };
  }

  private record(pool: Pool, headers: Headers | null): void {
    if (!headers) return;
    const limit = Number(headers.get("x-ratelimit-requests-limit"));
    const remaining = Number(headers.get("x-ratelimit-requests-remaining"));
    if (!headers.has("x-ratelimit-requests-remaining") || !Number.isFinite(remaining)) return;
    const state = this.pools[pool];
    if (Number.isFinite(limit) && limit > 0) state.limit = limit;
    state.remaining = remaining;
    state.at = this.now();
  }

  // A rate-limit response: the pool waits until the refill estimate reaches the reserve again,
  // at least a minute, doubling (to 15 min) when the probe after a block is limited again.
  private block(pool: Pool): void {
    const state = this.pools[pool];
    const now = this.now();
    state.remaining = 0;
    state.at = now;
    state.backoffMs = state.backoffMs ? Math.min(state.backoffMs * 2, MAX_BACKOFF_MS) : MIN_BLOCK_MS;
    const refill = state.limit ? Math.ceil(this.reserve(state) / this.rate(state)) : 0;
    state.blockedUntil = now + Math.max(state.backoffMs, refill);
  }
}

export const rateBudget = new RateBudget();

// GitHub's REST budget of the shared gh login, which every agent uses too. Unlike Linear's refill it
// is a fixed window: `x-ratelimit-remaining` requests until `x-ratelimit-reset`, then full again.
// Background readers stop while fewer than the reserve are left before the reset, so the agents
// keep the rest; interactive requests stop only after GitHub refused one.
export const GITHUB_RESERVE = 300;
// After GitHub refused a request (403/429 rate limit), nothing is sent for this long.
const GITHUB_THROTTLE_MS = 2 * 60 * 1000;

export type GitHubLimit = { remaining: number; limit: number; resetAt: number };

export class GitHubPausedError extends Error {
  constructor(readonly resumeAt: number, readonly reason: "budget" | "throttled", readonly remaining: number | null) {
    super(reason === "budget"
      ? `Paused until ${clock(resumeAt)}: the shared GitHub budget is low (${remaining} left)`
      : `GitHub is throttling the shared gh login; paused until ${clock(resumeAt)}`);
    this.name = "GitHubPausedError";
  }
}

export class GitHubBudget {
  private known: GitHubLimit | null = null;
  private blockedUntil = 0;

  constructor(private readonly now: () => number = () => Date.now(), readonly reserve = GITHUB_RESERVE) {}

  // A response's headers, lower-case names. Only the `core` resource is this budget.
  record(headers: ReadonlyMap<string, string>): void {
    const resource = headers.get("x-ratelimit-resource");
    if (resource && resource !== "core") return;
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const limit = Number(headers.get("x-ratelimit-limit"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (!headers.has("x-ratelimit-remaining") || !Number.isFinite(remaining) || !Number.isFinite(reset)) return;
    this.known = { remaining, limit: Number.isFinite(limit) ? limit : 0, resetAt: reset * 1000 };
  }

  // GitHub refused a request for its rate limit; the pause that follows.
  throttled(): GitHubPausedError {
    this.blockedUntil = this.now() + GITHUB_THROTTLE_MS;
    return new GitHubPausedError(this.blockedUntil, "throttled", this.current()?.remaining ?? null);
  }

  // The last known budget; null before any response and once its window reset.
  current(): GitHubLimit | null {
    return this.known && this.known.resetAt > this.now() ? this.known : null;
  }

  // Admission for one request; background requests also stop at the reserve.
  admit(level: Priority = priority.getStore() ?? "interactive"): void {
    const now = this.now();
    if (this.blockedUntil > now) throw new GitHubPausedError(this.blockedUntil, "throttled", this.current()?.remaining ?? null);
    const known = this.current();
    if (level === "background" && known && known.remaining < this.reserve) throw new GitHubPausedError(known.resetAt, "budget", known.remaining);
  }
}

export const githubBudget = new GitHubBudget();
