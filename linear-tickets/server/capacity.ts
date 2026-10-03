import type { CapacityLease, CapacityState } from "../shared/contracts";
import { MAX_RUNNING_LIMIT } from "./settings";

// Memory lease (README, "Memory lease"). The Paseo Agents menu bar app sends a cap on ticket
// agents computed from free RAM, valid for a short while and renewed while it runs. The lease
// lives in memory only: it runs out at `until`, and a daemon restart drops it, so a stopped app
// never leaves the cap behind. It only gates new admissions; running agents are never touched.

export const MIN_LEASE_SECONDS = 30;
export const MAX_LEASE_SECONDS = 600;
export const MAX_LEASE_REASON = 200;

export type LeaseRequest = { limit: number; ttlSeconds: number; reason: string };
// The cap the scheduler admits under: `limit` null is no limit, 0 admits nothing.
export type EffectiveLimit = Pick<CapacityState, "limit" | "source" | "lease">;

export class Capacity {
  private lease: CapacityLease | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  current(): CapacityLease | null {
    if (this.lease && Date.parse(this.lease.until) <= this.now()) this.lease = null;
    return this.lease;
  }

  // Without a lease, max agents (0: no limit). With one, the lower of the two; a lease alone
  // applies even when max agents is 0, and its 0 stops new starts.
  limit(maxRunning: number): EffectiveLimit {
    const lease = this.current();
    if (!lease) return { limit: maxRunning > 0 ? maxRunning : null, source: "settings", lease: null };
    if (maxRunning > 0 && maxRunning < lease.limit) return { limit: maxRunning, source: "settings", lease };
    return { limit: lease.limit, source: "ram", lease };
  }

  // null clears the lease; a new one replaces the previous.
  set(request: LeaseRequest | null): CapacityLease | null {
    if (!request) return this.lease = null;
    if (!Number.isInteger(request.limit) || request.limit < 0 || request.limit > MAX_RUNNING_LIMIT) {
      throw new Error(`The RAM limit must be a whole number from 0 (no new starts) to ${MAX_RUNNING_LIMIT}.`);
    }
    if (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds < MIN_LEASE_SECONDS || request.ttlSeconds > MAX_LEASE_SECONDS) {
      throw new Error(`The RAM lease must last a whole number of seconds from ${MIN_LEASE_SECONDS} to ${MAX_LEASE_SECONDS}.`);
    }
    const reason = request.reason.trim();
    if (!reason || reason.length > MAX_LEASE_REASON) throw new Error(`The RAM lease needs a reason of 1 to ${MAX_LEASE_REASON} characters.`);
    return this.lease = { limit: request.limit, reason, until: new Date(this.now() + request.ttlSeconds * 1_000).toISOString() };
  }
}
