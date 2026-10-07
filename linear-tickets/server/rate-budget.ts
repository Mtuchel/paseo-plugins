import { AsyncLocalStorage } from "node:async_hooks";
import { githubRouted } from "./github-cli";
import { asCaller, currentCallerName, linearUsage, type LinearUsage } from "./linear-usage";

// Linear's app and API-key pools each meter requests and complexity independently.
export type Pool = "key" | "app";
export type Priority = "owner" | "interactive" | "background";

const PERIOD_MS = 60 * 60 * 1000;
export const RESERVES: Record<Priority, number> = { background: 0.20, interactive: 0.05, owner: 0 };
const MIN_BLOCK_MS = 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
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
  constructor(readonly pool: Pool, readonly resumeAt: number, readonly reason: "limited" | "reserve" = "limited", level: Priority = "background") {
    super(reason === "limited"
      ? `Linear's hourly request or complexity limit is reached for ${poolName(pool)}; try again after ~${clock(resumeAt)}.`
      : `${level === "interactive" ? "Agent" : "Background"} Linear work is paused to keep ${poolName(pool)}'s last budget for ${level === "interactive" ? "owner decisions" : "agents and owner decisions"}; it resumes ~${clock(resumeAt)}.`);
    this.name = "RateLimitedError";
  }
}

type Dimension = { limit: number; remaining: number; at: number };
type PoolState = {
  requests: Dimension | null;
  points: Dimension | null;
  avgPoints: number;
  inFlight: number;
  blockedUntil: number;
  backoffMs: number;
  probing: boolean;
};

export type Ticket = { done(headers: Headers | null, rateLimited: boolean): void };
const priority = new AsyncLocalStorage<Priority>();
export function currentPriority(): Priority { return priority.getStore() ?? "interactive"; }
// The caller name carried by `asCaller` (linear-usage.ts); a request outside any such context is
// labelled by the operation it runs, so unattributed spend is still attributable per operation.
export function currentCaller(operation: string): string { return currentCallerName() ?? `op:${operation}`; }

// The level and the caller are separate contexts: `asCaller` names who spends, this storage
// only says how urgent they are. Nested work can raise priority, but cannot demote an owner's
// prerequisite reads or writes.
export function withPriority<T>(level: Priority, caller: string, work: () => Promise<T>): Promise<T> {
  const parent = priority.getStore();
  const rank = { background: 0, interactive: 1, owner: 2 };
  return asCaller(caller, () => priority.run(parent && rank[parent] > rank[level] ? parent : level, work));
}

export class RateBudget {
  private readonly pools: Record<Pool, PoolState> = {
    key: { requests: null, points: null, avgPoints: 100, inFlight: 0, blockedUntil: 0, backoffMs: 0, probing: false },
    app: { requests: null, points: null, avgPoints: 100, inFlight: 0, blockedUntil: 0, backoffMs: 0, probing: false },
  };

  constructor(private readonly now: () => number = () => Date.now(), private readonly usage?: LinearUsage) {}

  estimate(pool: Pool, dimension: "requests" | "points" = "requests"): number {
    const state = this.pools[pool];
    const known = state[dimension];
    if (!known) return Infinity;
    return Math.min(known.limit, known.remaining + known.limit / PERIOD_MS * Math.max(0, this.now() - known.at))
      - state.inFlight * (dimension === "points" ? state.avgPoints : 1);
  }

  averagePoints(pool: Pool): number { return this.pools[pool].avgPoints; }

  private reserveUntil(pool: Pool, level: Priority, room: number): number | null {
    const state = this.pools[pool];
    let until: number | null = null;
    for (const dimension of ["requests", "points"] as const) {
      const known = state[dimension];
      if (!known) continue;
      const missing = Math.ceil(known.limit * RESERVES[level]) + room * (dimension === "points" ? state.avgPoints : 1) - this.estimate(pool, dimension);
      if (missing > 0) until = Math.max(until ?? 0, this.now() + Math.ceil(missing * PERIOD_MS / known.limit));
    }
    return until;
  }

  pausedUntil(pool: Pool, level: Priority = "background", room = 1): number | null {
    const state = this.pools[pool];
    const reserve = this.reserveUntil(pool, level, room);
    const blocked = state.blockedUntil > this.now() ? state.blockedUntil : state.probing ? this.now() + PROBE_WAIT_MS : null;
    return reserve === null ? blocked : blocked === null ? reserve : Math.max(reserve, blocked);
  }

  blockedUntil(pool: Pool): number { return this.pools[pool].blockedUntil; }

  snapshot() {
    return (["app", "key"] as const).map((pool) => {
      const state = this.pools[pool];
      const dimension = (name: "requests" | "points") => state[name] ? { limit: state[name]!.limit, remaining: Math.max(0, this.estimate(pool, name)) } : null;
      return { pool, requests: dimension("requests"), points: dimension("points"), blockedUntil: state.blockedUntil,
        pausedUntil: { background: this.pausedUntil(pool, "background"), interactive: this.pausedUntil(pool, "interactive") } };
    });
  }

  acquire(pool: Pool, level: Priority = currentPriority(), caller?: string, operation = "anonymous"): Ticket {
    const named = caller ?? currentCaller(operation);
    const state = this.pools[pool];
    const now = this.now();
    if (state.blockedUntil > now) throw new RateLimitedError(pool, state.blockedUntil);
    // Reserve admission precedes the probe slot: a poll cannot steal the owner's probe.
    const until = this.reserveUntil(pool, level, 1);
    if (until !== null) {
      if (level !== "owner") this.usage?.refused(pool, named, level);
      throw new RateLimitedError(pool, until, "reserve", level);
    }
    let probe = false;
    if (state.blockedUntil) {
      if (state.probing) throw new RateLimitedError(pool, now + PROBE_WAIT_MS);
      state.probing = probe = true;
    }
    state.inFlight++;
    // One handle per admitted request, settled exactly once by `done`; local refusals above
    // never reach it, so the recorded traffic and the sent traffic agree.
    const accounting = this.usage?.begin(pool, named, operation);
    let settled = false;
    return {
      done: (headers, limited) => {
        if (settled) return;
        settled = true;
        state.inFlight--;
        if (probe) state.probing = false;
        accounting?.done(headers, limited, state.avgPoints);
        this.record(pool, headers);
        if (limited) {
          if (!headers?.has("x-ratelimit-requests-remaining") && !headers?.has("x-ratelimit-complexity-remaining")) {
            const known = state.requests;
            if (known) { known.remaining = 0; known.at = this.now(); }
          }
          state.backoffMs = probe ? Math.min(state.backoffMs * 2, MAX_BACKOFF_MS) : state.backoffMs || MIN_BLOCK_MS;
          state.blockedUntil = this.now() + state.backoffMs;
          this.usage?.block(pool, state.blockedUntil);
        } else if (probe && headers) {
          state.blockedUntil = 0;
          state.backoffMs = 0;
        }
      },
    };
  }

  private record(pool: Pool, headers: Headers | null): void {
    if (!headers) return;
    const state = this.pools[pool];
    for (const [dimension, name] of [["requests", "requests"], ["points", "complexity"]] as const) {
      if (!headers.has(`x-ratelimit-${name}-remaining`)) continue;
      const remaining = Number(headers.get(`x-ratelimit-${name}-remaining`));
      const limit = Number(headers.get(`x-ratelimit-${name}-limit`) ?? state[dimension]?.limit);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining >= 0) state[dimension] = { limit, remaining, at: this.now() };
    }
    if (headers.has("x-complexity")) {
      const cost = Number(headers.get("x-complexity"));
      if (Number.isFinite(cost) && cost >= 0) state.avgPoints = 0.2 * cost + 0.8 * state.avgPoints;
    }
  }
}

export const rateBudget = new RateBudget(() => Date.now(), linearUsage);

// GitHub's REST budget without the account router: the one shared gh login, which every agent
// uses too. Unlike Linear's refill it is a fixed window: `x-ratelimit-remaining` requests until
// `x-ratelimit-reset`, then full again. Background readers stop while fewer than the reserve are
// left before the reset, so the agents keep the rest; interactive requests stop only after
// GitHub refused one. With the router installed (see github-cli.ts) it owns the bot and owner
// budgets itself, and this budget records nothing: a response's headers name whichever account
// served the call, so pausing on them would block the other account's reads and the bot's
// writes on one account's low quota.
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

  // `routed`: the account router (github-cli.ts) serves this host's GitHub calls and owns both
  // accounts' quotas; see the GITHUB_RESERVE comment. Off (the default) is the single-login
  // budget.
  constructor(private readonly now: () => number = () => Date.now(), readonly reserve = GITHUB_RESERVE, readonly routed = false) {}

  // A response's headers, lower-case names. Only the `core` resource is this budget.
  record(headers: ReadonlyMap<string, string>): void {
    if (this.routed) return;
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

  // The error a refused request surfaces. Routed: the router's own refusal, which names the
  // exhausted read budgets and when they resume. Single login: the pause that keeps the next
  // two minutes quiet.
  refused(error: Error): Error {
    return this.routed ? error : this.throttled();
  }

  // The last known budget; null before any response and once its window reset.
  current(): GitHubLimit | null {
    if (this.routed) return null;
    return this.known && this.known.resetAt > this.now() ? this.known : null;
  }

  admit(level: Priority = currentPriority()): void {
    if (this.routed) return;
    const now = this.now();
    if (this.blockedUntil > now) throw new GitHubPausedError(this.blockedUntil, "throttled", this.current()?.remaining ?? null);
    const known = this.current();
    if (level === "background" && known && known.remaining < this.reserve) throw new GitHubPausedError(known.resetAt, "budget", known.remaining);
  }
}

export const githubBudget = new GitHubBudget(() => Date.now(), GITHUB_RESERVE, githubRouted());
