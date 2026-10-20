// Keeps the responsibility check's repair (README, "Responsibility check") apart from every other
// effect on the same ticket: an agent start, a decision being recorded or carried out, a parked
// plan being written or removed, a deletion. Effects never exclude each other here (their own
// gates and locks order them as before); they only exclude a repair, and a repair excludes them.
//
// An effect takes a token before its first admission read and keeps it through its mutation. A
// token for an unknown ticket (`null`: an identifier not yet resolved, or journal work that may
// touch any ticket) blocks every repair until it is released or bound to the ticket's UUID; the
// binding is atomic, so there is no gap a repair could slip into. A repair never waits: it either
// reserves the ticket now or tries again on a later run. So no lock order can deadlock — a repair
// holds nothing another path waits for except its own short reservation, and it waits for nothing.
//
// Lifecycle: admission starts closed and opens once the decision journal is owned and loaded
// (`open`); shutdown closes it (`closeAdmission`), then `drain` waits for every admitted effect and
// repair before the journal's ownership is released, so a replacement instance never overlaps a
// repair of this one.

export const REPAIR_BUSY_MESSAGE = "A plan review is being restored for this ticket. Try again shortly.";
export const EXCLUSION_CLOSED_MESSAGE = "The plugin is restarting; try again in a few seconds.";

// A start or decision refused because a repair holds the ticket (or the plugin is restarting):
// transient, nothing was done, the same request can be retried.
export class RepairBusyError extends Error {
  constructor(message = REPAIR_BUSY_MESSAGE) {
    super(message);
    this.name = "RepairBusyError";
  }
}

// The refusal while admission is closed (startup before the journal is loaded, or shutdown).
export class ExclusionClosedError extends RepairBusyError {
  constructor() {
    super(EXCLUSION_CLOSED_MESSAGE);
    this.name = "ExclusionClosedError";
  }
}

export type EffectToken = {
  readonly issueId: string | null;
  // Binds an unknown-ticket token to the ticket's UUID, atomically; a no-op for the same id.
  bind(issueId: string): void;
  // Idempotent.
  release(): void;
};

export type RepairReservation = { readonly issueId: string; release(): void };

export class RepairExclusion {
  private admitting: boolean;
  private unknown = 0;
  private readonly effects = new Map<string, number>();
  private readonly repairs = new Set<string>();
  private waiters: (() => void)[] = [];

  constructor(options: { open?: boolean } = {}) {
    this.admitting = options.open ?? true;
  }

  // Waits while a repair holds the ticket (any repair, for an unknown ticket); refused once
  // admission is closed, including while waiting.
  async admit(issueId: string | null): Promise<EffectToken> {
    for (;;) {
      if (!this.admitting) throw new ExclusionClosedError();
      if (!this.conflicts(issueId)) return this.take(issueId);
      await this.changed();
    }
  }

  // The synchronous form: a token now, or RepairBusyError (never waits).
  enterEffect(issueId: string | null): EffectToken {
    if (!this.admitting) throw new ExclusionClosedError();
    if (this.conflicts(issueId)) throw new RepairBusyError();
    return this.take(issueId);
  }

  // The repair's exclusive reservation of one ticket, or null while any effect that may touch it
  // is under way (or admission is closed).
  tryRepair(issueId: string): RepairReservation | null {
    if (!this.admitting || this.unknown > 0 || (this.effects.get(issueId) ?? 0) > 0 || this.repairs.has(issueId)) return null;
    this.repairs.add(issueId);
    let held = true;
    return {
      issueId,
      release: () => {
        if (!held) return;
        held = false;
        this.repairs.delete(issueId);
        this.notify();
      },
    };
  }

  // The journal is owned and loaded: effects and repairs may be admitted.
  open(): void {
    this.admitting = true;
    this.notify();
  }

  // New effects and repairs are refused from now on; admitted ones finish. Waiting admissions
  // are refused too, so nothing waits on a closed exclusion.
  closeAdmission(): void {
    this.admitting = false;
    this.notify();
  }

  // Resolves once every admitted repair has released and every admitted effect has released or
  // `effectsMs` has passed: a repair is short and must finish before the journal changes hands; an
  // effect (an agent start stuck on Paseo) must not hold the shutdown forever.
  async drain(effectsMs = 30_000): Promise<void> {
    const deadline = Date.now() + effectsMs;
    for (;;) {
      const effects = this.unknown > 0 || this.effects.size > 0;
      if (!this.repairs.size && (!effects || Date.now() >= deadline)) return;
      let timer: NodeJS.Timeout | undefined;
      const tick = this.repairs.size ? null : new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); });
      await (tick ? Promise.race([this.changed(), tick]) : this.changed());
      clearTimeout(timer);
    }
  }

  private conflicts(issueId: string | null): boolean {
    return issueId === null ? this.repairs.size > 0 : this.repairs.has(issueId);
  }

  private take(issueId: string | null): EffectToken {
    let current = issueId;
    let held = true;
    this.count(current, 1);
    return {
      get issueId() { return current; },
      bind: (id: string) => {
        if (!held || current === id) return;
        if (current !== null) throw new Error(`An effect token for ${current} cannot be bound to ${id}.`);
        // No repair can hold `id`: an unknown token blocks every repair until this line.
        this.count(id, 1);
        this.count(null, -1);
        current = id;
      },
      release: () => {
        if (!held) return;
        held = false;
        this.count(current, -1);
        this.notify();
      },
    };
  }

  private count(issueId: string | null, delta: number): void {
    if (issueId === null) { this.unknown += delta; return; }
    const next = (this.effects.get(issueId) ?? 0) + delta;
    if (next > 0) this.effects.set(issueId, next);
    else this.effects.delete(issueId);
  }

  private changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

// Runs `work` holding an effect token for the ticket (waiting while a repair holds it); without an
// exclusion it just runs.
export async function withEffect<T>(exclusion: Pick<RepairExclusion, "admit"> | null | undefined, issueId: string | null, work: () => Promise<T>): Promise<T> {
  const token = exclusion ? await exclusion.admit(issueId) : null;
  try { return await work(); }
  finally { token?.release(); }
}
