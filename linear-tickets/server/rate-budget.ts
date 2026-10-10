import { AsyncLocalStorage } from "node:async_hooks";
import { githubRouted } from "./github-cli";
import { asCaller, currentCallerName, linearUsage, type LinearUsage, type LinearUsageHandle } from "./linear-usage";

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

type Dimension = { limit: number; remaining: number; at: number; observedAt: number };
type PoolState = {
  requests: Dimension | null;
  points: Dimension | null;
  avgPoints: number;
  pending: Set<{ points: number; clean: boolean }>;
  debt: Map<string, { requests: number; points: number }>;
  blockedUntil: number;
  backoffMs: number;
  probing: boolean;
};

export type Ticket = {
  start(): void;
  cancel(): void;
  done(headers: Headers | null, rateLimited: boolean, uncertaintyId?: string): void;
};
export type Reservation = { points?: number; deferred?: boolean };
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
    key: { requests: null, points: null, avgPoints: 100, pending: new Set(), debt: new Map(), blockedUntil: 0, backoffMs: 0, probing: false },
    app: { requests: null, points: null, avgPoints: 100, pending: new Set(), debt: new Map(), blockedUntil: 0, backoffMs: 0, probing: false },
  };

  constructor(private readonly now: () => number = () => Date.now(), private readonly usage?: LinearUsage) {}

  estimate(pool: Pool, dimension: "requests" | "points" = "requests"): number {
    const state = this.pools[pool];
    const known = state[dimension];
    if (!known) return Infinity;
    let reserved = 0;
    for (const ticket of state.pending) reserved += dimension === "points" ? ticket.points : 1;
    for (const debt of state.debt.values()) reserved += debt[dimension];
    return Math.min(known.limit, known.remaining + known.limit / PERIOD_MS * Math.max(0, this.now() - known.at)) - reserved;
  }

  averagePoints(pool: Pool): number { return this.pools[pool].avgPoints; }

  hasSamples(pool: Pool, since = 0): boolean {
    const state = this.pools[pool];
    return state.requests !== null && state.points !== null && state.requests.observedAt >= since && state.points.observedAt >= since;
  }

  // Recovered/unknown sends are reservations, never fabricated usage measurements.
  retainDebt(pool: Pool, id: string, requests: number, points: number): void {
    this.pools[pool].debt.set(id, { requests, points });
  }

  releaseDebt(pool: Pool, id: string, headers: Headers): void {
    const state = this.pools[pool];
    const debt = state.debt.get(id);
    if (!debt) return;
    this.record(pool, headers, false, debt.points);
    state.debt.delete(id);
  }

  private reserveUntil(pool: Pool, level: Priority, room: number, pointCost = this.pools[pool].avgPoints): number | null {
    const state = this.pools[pool];
    let until: number | null = null;
    for (const dimension of ["requests", "points"] as const) {
      const known = state[dimension];
      if (!known) continue;
      const missing = Math.ceil(known.limit * RESERVES[level]) + room * (dimension === "points" ? pointCost : 1) - this.estimate(pool, dimension);
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

  // The share of the pool's hourly allowance left above `level`'s reserve: the smaller of its
  // two dimensions, negative below the reserve, Infinity while neither has been observed.
  headroom(pool: Pool, level: Priority = "background"): number {
    const state = this.pools[pool];
    let share = Infinity;
    for (const dimension of ["requests", "points"] as const) {
      const known = state[dimension];
      if (known) share = Math.min(share, (this.estimate(pool, dimension) - known.limit * RESERVES[level]) / known.limit);
    }
    return share;
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

  acquire(pool: Pool, level: Priority = currentPriority(), caller?: string, operation = "anonymous", options: Reservation = {}): Ticket {
    const named = caller ?? currentCaller(operation);
    const state = this.pools[pool];
    const points = options.points ?? state.avgPoints;
    if (!Number.isFinite(points) || points < 0) throw new Error("Invalid Linear reservation cost");
    const now = this.now();
    if (state.blockedUntil > now) throw new RateLimitedError(pool, state.blockedUntil);
    // Reserve admission precedes the probe slot: a poll cannot steal the owner's probe.
    const until = this.reserveUntil(pool, level, 1, points);
    if (until !== null) {
      if (level !== "owner") this.usage?.refused(pool, named, level);
      throw new RateLimitedError(pool, until, "reserve", level);
    }
    let probe = false;
    if (state.blockedUntil) {
      if (state.probing) throw new RateLimitedError(pool, now + PROBE_WAIT_MS);
      state.probing = probe = true;
    }
    const captured = { points, clean: state.pending.size === 0 };
    for (const pending of state.pending) pending.clean = false;
    state.pending.add(captured);
    let accounting: LinearUsageHandle | undefined;
    let started = false;
    let settled = false;
    const release = () => { state.pending.delete(captured); if (probe) state.probing = false; };
    const ticket: Ticket = {
      start: () => {
        if (settled || started) return;
        started = true;
        accounting = this.usage?.begin(pool, named, operation);
      },
      cancel: () => {
        if (settled || started) return;
        settled = true;
        release();
      },
      done: (headers, limited, uncertaintyId) => {
        if (settled) return;
        if (!started) { ticket.cancel(); return; }
        settled = true;
        release();
        accounting?.done(headers, limited, points);
        if (headers === null) {
          this.retainDebt(pool, uncertaintyId ?? `unknown:${++this.unknownSequence}`, 1, points);
        } else {
          this.record(pool, headers, captured.clean, points);
        }
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
    if (!options.deferred) ticket.start();
    return ticket;
  }

  private unknownSequence = 0;

  private record(pool: Pool, headers: Headers, clean: boolean, reservedPoints: number): void {
    const state = this.pools[pool];
    const costHeader = headers.get("x-complexity");
    const measured = costHeader === null ? NaN : Number(costHeader);
    const cost = Number.isFinite(measured) && measured >= 0 ? measured : reservedPoints;
    for (const [dimension, name] of [["requests", "requests"], ["points", "complexity"]] as const) {
      const previous = state[dimension];
      const ownCost = dimension === "points" ? cost : 1;
      const pessimistic = previous ? Math.max(0, Math.min(previous.limit,
        previous.remaining + previous.limit / PERIOD_MS * Math.max(0, this.now() - previous.at)) - ownCost) : null;
      const raw = headers.get(`x-ratelimit-${name}-remaining`);
      const remaining = raw === null ? NaN : Number(raw);
      const limit = Number(headers.get(`x-ratelimit-${name}-limit`) ?? previous?.limit);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining >= 0 && remaining <= limit) {
        // A response which overlapped another request may be stale even if it arrives last.
        state[dimension] = { limit, remaining: clean || pessimistic === null ? remaining : Math.min(remaining, pessimistic), at: this.now(), observedAt: this.now() };
      } else if (previous && pessimistic !== null) {
        state[dimension] = { ...previous, remaining: pessimistic, at: this.now() };
      }
    }
    if (Number.isFinite(measured) && measured >= 0) state.avgPoints = 0.2 * measured + 0.8 * state.avgPoints;
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
// After GitHub refused a request without saying until when (no `remaining: 0` with a reset, no
// `retry-after`), nothing is sent for this long.
const GITHUB_THROTTLE_MS = 2 * 60 * 1000;

export type GitHubLimit = { remaining: number; limit: number; resetAt: number };

// GitHub's pause messages name UTC: the daemon log is UTC, and a host-local time without a zone
// was misread (TUC-1880).
export function utcClock(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

// What GitHub's refusal said about itself. `primary`: the resource's hourly budget is spent
// (`remaining: 0`), until its reset; `secondary`: a secondary rate limit, for `retry-after`;
// `unknown`: neither, so the 2-minute fallback.
export type GitHubRefusal = { resumeAt: number; resource: string; kind: "primary" | "secondary" | "unknown" };

export function refusalOf(headers: ReadonlyMap<string, string> | null | undefined, now: number): GitHubRefusal {
  const resource = headers?.get("x-ratelimit-resource") || "unknown";
  const remaining = headers?.get("x-ratelimit-remaining");
  const reset = Number(headers?.get("x-ratelimit-reset"));
  if (remaining === "0" && Number.isFinite(reset) && reset * 1000 > now) return { resumeAt: reset * 1000, resource, kind: "primary" };
  const retryAfter = Number(headers?.get("retry-after"));
  if (headers?.has("retry-after") && Number.isFinite(retryAfter) && retryAfter > 0) return { resumeAt: now + retryAfter * 1000, resource, kind: "secondary" };
  return { resumeAt: now + GITHUB_THROTTLE_MS, resource, kind: "unknown" };
}

// The headers the GitHub usage meter put on a failed gh call (github-usage.ts), if any.
export function refusalHeaders(error: unknown): ReadonlyMap<string, string> | null {
  return error && typeof error === "object" && "headers" in error && error.headers instanceof Map ? error.headers as ReadonlyMap<string, string> : null;
}

// gh reports GitHub's throttling (HTTP 429, primary or secondary rate limit), or a repo script
// printed GitHub's refusal (queue-backstop.ts); the GitHub work of the poll or backstop run stops.
export class GitHubRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitedError";
  }
}

export class GitHubPausedError extends Error {
  constructor(readonly resumeAt: number, readonly reason: "budget" | "throttled", readonly remaining: number | null, readonly resource: string = "core", readonly kind: GitHubRefusal["kind"] | "reserve" = reason === "budget" ? "reserve" : "unknown") {
    super(reason === "budget"
      ? `Paused until ${utcClock(resumeAt)}: the shared GitHub budget is low (${remaining} left)`
      : kind === "primary" ? `GitHub refused the shared gh login: its ${resource} budget is spent; paused until ${utcClock(resumeAt)}`
        : kind === "secondary" ? `GitHub refused the shared gh login with a secondary rate limit; paused until ${utcClock(resumeAt)}`
          : `GitHub is throttling the shared gh login; paused until ${utcClock(resumeAt)}`);
    this.name = "GitHubPausedError";
  }
}

export class GitHubBudget {
  private known: GitHubLimit | null = null;
  private blocked: GitHubRefusal = { resumeAt: 0, resource: "unknown", kind: "unknown" };

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

  // GitHub refused a request for its rate limit; the pause that follows, until the reset or
  // `retry-after` the refused response named (not capped: GitHub's deadline is authoritative).
  throttled(refusal: GitHubRefusal = refusalOf(null, this.now())): GitHubPausedError {
    if (refusal.resumeAt >= this.blocked.resumeAt) this.blocked = refusal;
    return this.paused();
  }

  private paused(): GitHubPausedError {
    return new GitHubPausedError(this.blocked.resumeAt, "throttled", this.current()?.remaining ?? null, this.blocked.resource, this.blocked.kind);
  }

  // The error a refused request surfaces. Routed: the router's own refusal, which names the
  // exhausted read budgets and when they resume. Single login: the pause until GitHub's reset,
  // read from the refused response's headers (refusalOf).
  refused(error: Error): Error {
    return this.routed ? error : this.throttled(refusalOf(refusalHeaders(error), this.now()));
  }

  // The last known budget; null before any response and once its window reset.
  current(): GitHubLimit | null {
    if (this.routed) return null;
    return this.known && this.known.resetAt > this.now() ? this.known : null;
  }

  admit(level: Priority = currentPriority()): void {
    if (this.routed) return;
    const now = this.now();
    if (this.blocked.resumeAt > now) throw this.paused();
    const known = this.current();
    if (level === "background" && known && known.remaining < this.reserve) throw new GitHubPausedError(known.resetAt, "budget", known.remaining);
  }
}

export const githubBudget = new GitHubBudget(() => Date.now(), GITHUB_RESERVE, githubRouted());
