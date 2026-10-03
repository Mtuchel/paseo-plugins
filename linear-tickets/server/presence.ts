import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PresenceSchedule, PresenceState } from "../shared/contracts";
import { dispatchLabels } from "./dispatch";
import { PLAN_READY_LABEL } from "./plan-policy";
import { paseoHome } from "./ticket-mcp";

// Present and away (README, "Present and away"). While the owner is away, approved plans of
// tickets that may need them during the run wait; planning and everything else starts as usual.
// Away comes from the owner's toggle, which holds until the schedule's next switch, or from the
// schedule (host-local times).

// `override`: the owner's toggle; `until` null holds until the owner toggles again (no schedule).
type PresenceFile = { schedule: PresenceSchedule; override: { away: boolean; until: string | null } | null };

export const DEFAULT_SCHEDULE: PresenceSchedule = { enabled: false, awayFrom: "22:00", awayUntil: "07:00" };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}

// Whether `date` falls in the away window; a window may run over midnight.
export function scheduledAway(schedule: PresenceSchedule, date: Date): boolean {
  if (!schedule.enabled) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const from = minutes(schedule.awayFrom);
  const until = minutes(schedule.awayUntil);
  if (from === until) return false;
  return from < until ? now >= from && now < until : now >= from || now < until;
}

// The next time the schedule switches between present and away.
export function nextSwitch(schedule: PresenceSchedule, date: Date): Date {
  const times: Date[] = [];
  for (const day of [0, 1]) {
    for (const time of [schedule.awayFrom, schedule.awayUntil]) {
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate() + day, ...time.split(":").map(Number) as [number, number]);
      if (at > date) times.push(at);
    }
  }
  return times.sort((a, b) => a.getTime() - b.getTime())[0];
}

export function presenceAt(file: PresenceFile, date: Date): PresenceState {
  const { schedule, override } = file;
  if (override && (!override.until || date < new Date(override.until))) return { away: override.away, source: "manual", until: override.until, schedule };
  return { away: scheduledAway(schedule, date), source: schedule.enabled ? "schedule" : "default", until: schedule.enabled ? nextSwitch(schedule, date).toISOString() : null, schedule };
}

function normalizeFile(value: unknown): PresenceFile {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const schedule = raw.schedule && typeof raw.schedule === "object" ? raw.schedule as Record<string, unknown> : {};
  const time = (item: unknown, fallback: string) => typeof item === "string" && TIME.test(item) ? item : fallback;
  const override = raw.override && typeof raw.override === "object" ? raw.override as Record<string, unknown> : null;
  return {
    schedule: { enabled: schedule.enabled === true, awayFrom: time(schedule.awayFrom, DEFAULT_SCHEDULE.awayFrom), awayUntil: time(schedule.awayUntil, DEFAULT_SCHEDULE.awayUntil) },
    override: override && typeof override.away === "boolean" ? { away: override.away, until: typeof override.until === "string" ? override.until : null } : null,
  };
}

export class Presence {
  private file: PresenceFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path = join(paseoHome(), "linear-tickets", "presence.json"),
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<PresenceFile> {
    this.file ??= normalizeFile(JSON.parse(await readFile(this.path, "utf8").catch(() => "{}")));
    return this.file;
  }

  async state(): Promise<PresenceState> {
    return presenceAt(await this.load(), new Date(this.now()));
  }

  async away(): Promise<boolean> {
    return (await this.state()).away;
  }

  // `away`: the owner's toggle, held until the schedule's next switch. A new schedule drops an
  // earlier toggle, so the schedule applies at once.
  update(change: { away?: boolean; schedule?: PresenceSchedule }): Promise<PresenceState> {
    const run = async () => {
      const current = await this.load();
      const schedule = change.schedule ?? current.schedule;
      if (!TIME.test(schedule.awayFrom) || !TIME.test(schedule.awayUntil)) throw new Error("Away times must be HH:MM, for example 22:00.");
      if (schedule.enabled && schedule.awayFrom === schedule.awayUntil) throw new Error("The away window needs different start and end times.");
      const date = new Date(this.now());
      const override = change.away === undefined
        ? (change.schedule ? null : current.override)
        : { away: change.away, until: schedule.enabled ? nextSwitch(schedule, date).toISOString() : null };
      const next: PresenceFile = { schedule, override };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      this.file = next;
      return presenceAt(next, date);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

// Whether a ticket waits while the owner is away: the planner marked it (`<trigger>-attended`)
// because its agent will very likely have to ask them during the work, and its plan is approved
// (plan-ready), so the next agent implements. Planning never waits: it needs nobody, and a plan
// that is not approved automatically waits for the owner on its own (README, "Parked plans").
export function needsOwner(labels: string[], trigger: string): boolean {
  const names = new Set(labels.map((name) => name.trim().toLowerCase()));
  return names.has(dispatchLabels(trigger).attended.toLowerCase()) && names.has(PLAN_READY_LABEL);
}
