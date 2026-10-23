import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { candidates, normalizeModel } from "../shared/model-fallbacks";
import { availability, LIMIT_DAY, LIMIT_SPACING, limitError, limitSchedule, limitTime, type UsageReader } from "./limit-resume";
import { SetupError } from "./launch";
import { activeModel } from "./model";
import type { ProcessInspector } from "./process-liveness";
import { RateLimitedError } from "./rate-budget";
import { RepairBusyError } from "./repair-exclusion";
import type { PluginSettings } from "./settings";
import type { TicketAgents } from "./starter";

// A planner run is one durable lifecycle, whether it orders a project's tickets (project-flow.ts)
// or catches up the related work of older approved plans (related-catch-up.ts): the run is written
// before its agent is started, a run without a live agent is started again after a grace period a
// few times, usage limits are waited out with durable claims, the owner is asked once, and a
// finished run is closed with its agent retired. Only the target differs: what holds the run, how
// its agents are found, the brief, and how the owner hears about a stuck run. That is
// `PlannerStore` and `PlannerTarget`; nothing here knows about projects.

// A started run without a live agent this long after its (re)start is started again. A start takes
// a couple of minutes (TUC-678: filed 08:26:04, its workspace stood at 08:26:46, the daemon gave up
// waiting for the agent at 08:27:46), so ten minutes never starts a second agent beside one still
// launching, and a run stalls by a failed start for at most that plus one read.
export const RESTART_GRACE_MS = 10 * 60_000;
// Starts per run before it is left to the owner: a start that fails this often (another agent
// cannot come up, the daemon keeps timing out) needs them, not another try.
const RESTART_CAP = 3;

const recoveryTime = z.string().refine((value) => Number.isFinite(Date.parse(value)));
export const plannerRecoverySchema = z.object({
  attempt: z.number().int().nonnegative(),
  claims: z.array(recoveryTime),
  handledAgentId: z.string().optional(),
  pending: z.object({
    identity: z.string(), error: z.string(), model: z.string().nullable(), failedAt: recoveryTime,
    resumeAt: recoveryTime, fallbackAt: recoveryTime, jitterMs: z.number().min(60_000).max(300_000),
    basis: z.enum(["room", "reset", "retry-after", "default"]), selector: z.string().nullable(),
  }).optional(),
  claim: z.object({ requestId: z.string(), at: recoveryTime }).optional(),
});
type PlannerRecovery = z.infer<typeof plannerRecoverySchema>;

export function recoveryOf(run: PlannerRecord): PlannerRecovery | undefined {
  if (run.recovery === undefined) return undefined;
  const parsed = plannerRecoverySchema.safeParse(run.recovery);
  if (!parsed.success) throw new Error(`Planner ${run.id}: corrupt usage-limit recovery metadata; automatic recovery is stopped.`);
  return parsed.data;
}

// The open run: its `id` (the agent carries it as a label), `started`: false until its agent is up,
// `startedAt`: when it was last (re)started, `agentId`: the agent the last start created,
// `restarts`: how often it was started again without a live agent (a stopped agent, or a start that
// failed), `ownerAsked`: past RESTART_CAP, or on a start that cannot succeed, the owner was asked
// once to start it or give it up, `error`: why it is stuck, `approved`: the plan it submitted until
// the target applies it (with the changes of it already applied), and `recovery`: the usage-limit
// waiting state.
// Project runs also record what they list (`listedAt`, `listed`, `tickets`); a target that does not
// batch tickets leaves those out.
export type PlannerRecord = {
  id: string; listedAt: string; listed?: string[]; tickets: number; started?: boolean;
  startedAt?: string; agentId?: string; restarts?: number; ownerAsked?: boolean; error?: string;
  approved?: { agentId: string | null; plan: string; done?: string[] };
  recovery?: PlannerRecovery;
};

// The stored state that holds a run: a project's record, or a catch-up's. `closedPlanner` keeps the
// run closed last, so a late report of its review is ignored rather than applied twice.
export type PlannerHolder = { planner: PlannerRecord | null; closedPlanner?: string };

// A usage-limit restart's evidence, recorded in the same write as the run's change (the target
// decides where, and whether, it keeps it).
export type PlannerRestart = { requestId: string; agentId: string; at: number };

// What the lifecycle writes and reads. Every change is one serialized write of the record that
// holds the run, so a poll, a start and an approval never overwrite each other's state.
export type PlannerStore<State extends PlannerHolder> = {
  // The target's open run, as stored now.
  current(): Promise<PlannerRecord | null>;
  // Installs `run` (with `record` when the target has none yet); returns the run another path
  // opened first, so two starts never run at once.
  open(run: PlannerRecord, record: State): Promise<{ run: PlannerRecord; opened: boolean }>;
  // Change of the record holding the run `runId`: `change` gets the stored record and its run, and
  // returns the new record, or null to keep it.
  update(runId: string, change: (record: State, run: PlannerRecord) => State | null, restart?: PlannerRestart): Promise<State | null>;
};

// The parts that differ between a project's planner and a catch-up: what the run is called, how its
// agents carry it, the brief, how an agent is started, and how the owner is told. `own`, `fresh`
// and `defer` come from the caller's operation (ownership, settings snapshot, its queue).
export type PlannerTarget = {
  // The run in logs: "project ERP", "ticket TUC-12".
  label: string;
  // The operation's settings snapshot; throws when this host may no longer start or write.
  own(settings: PluginSettings): Promise<PluginSettings>;
  // Fresh settings; null once this host no longer runs the work itself (remote mode).
  fresh(settings: PluginSettings): Promise<PluginSettings | null>;
  // The run's root agents, classified live, stopped or ghost.
  agents(run: PlannerRecord, paseo: PaseoApi): Promise<TicketAgents>;
  // The planner's brief, read when an agent is about to be started.
  brief(settings: PluginSettings): Promise<string>;
  // Starts an agent for the run and returns its id.
  start(input: { runId: string; requestId: string; brief: string }, paseo: PaseoApi, settings: PluginSettings): Promise<{ agentId: string }>;
  // Tells the owner, once per run, that no agent is planning it (a project update; a comment on a
  // catch-up ticket). The record already carries `ownerAsked`; a failure is logged, never retried.
  ask(run: PlannerRecord, problem: string): Promise<void>;
  // Runs `work` behind the caller's queue (a start the caller only acknowledges).
  defer(work: () => Promise<void>): Promise<void>;
};

export type PlannerDeps = {
  // Stops the run's agent and archives it (ProjectFlow's retire).
  retire: (agentId: string, paseo: PaseoApi) => Promise<void>;
  now?: () => number;
  // Provider-process inspection for ghost agents.
  inspect?: ProcessInspector;
  usage?: Pick<UsageReader, "read" | "chains">;
  jitter?: () => number;
};

// A new run's record, written by `start` before its agent exists.
export type PlannerNewRun<State extends PlannerHolder> = {
  // The run's own fields; `start` gives it its id.
  run: Omit<PlannerRecord, "id">;
  // Written when the target has no record yet.
  record: State;
  settings: PluginSettings;
  paseo: PaseoApi;
  // The caller only acknowledges the stored run: the launch runs behind its queue.
  background?: boolean;
};

export class PlannerTickets<State extends PlannerHolder> {
  constructor(private readonly deps: PlannerDeps, private readonly store: PlannerStore<State>) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // Writes the run first (the next read retries whatever the store says is missing, and no second
  // run starts while one is open), then starts its agent. A read and a start at the same time start
  // one run: the other returns the run already open.
  async start(target: PlannerTarget, input: PlannerNewRun<State>): Promise<PlannerRecord> {
    const run: PlannerRecord = { ...input.run, id: randomUUID() };
    const opened = await this.store.open(run, input.record);
    if (!opened.opened) return opened.run;
    console.log(`[linear-tickets] ${target.label}: planner run ${run.id.slice(0, 8)} for ${run.tickets} new ticket${run.tickets === 1 ? "" : "s"}`);
    if (input.background) {
      // The RPC acknowledges the persisted run, not provider readiness (which can take minutes).
      // Queue behind this operation; a poll already queued may start it first, so recheck attempts.
      void target.defer(async () => {
        const settings = await target.fresh(input.settings);
        if (!settings) return;
        const pending = await this.store.current();
        if (pending?.id !== run.id || pending.startedAt || pending.approved || pending.ownerAsked) return;
        await this.launch(target, pending, settings, input.paseo);
      }).catch((error: unknown) => console.error(`[linear-tickets] ${target.label}: starting the planner failed; the next read after the grace retries: ${message(error)}`));
    } else await this.launch(target, run, input.settings, input.paseo);
    return (await this.store.current()) ?? run;
  }

  // A started run whose agent stopped without submitting a plan (closed after idling, archived,
  // lost with its process) would hold its target: no second run starts while it is open.
  // RESTART_GRACE_MS after its last start without a live agent it is started again for the same
  // run; a few tries, then the owner is asked once.
  async revive(target: PlannerTarget, run: PlannerRecord, settings: PluginSettings, paseo: PaseoApi): Promise<void> {
    settings = await target.own(settings);
    // Inspect every poll for live/limit roots; only the generic path obeys its ten-minute grace.
    recoveryOf(run);
    if (!run.recovery?.pending && this.now() - Date.parse(run.startedAt ?? run.listedAt) < RESTART_GRACE_MS) {
      const agents = await target.agents(run, paseo);
      if (await this.adopt(run, agents, paseo)) return;
      const stopped = run.agentId && agents.stopped.find((agent) => agent.id === run.agentId);
      if (!stopped || stopped.status !== "error" || stopped.id === run.recovery?.handledAgentId || !limitError(stopped.lastError ?? "")) return;
    }
    await this.launch(target, run, settings, paseo);
  }

  // Recovered runs keep a live recorded root authoritative even if an uncertain older creation
  // appears later. With no live recorded root, adopt deterministically; retire all other roots.
  async adopt(run: PlannerRecord, agents: TicketAgents, paseo: PaseoApi): Promise<boolean> {
    const live = (run.recovery && agents.live.find((agent) => agent.id === run.agentId))
      || agents.live.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id))[0];
    if (!live) return false;
    const requestId = live.labels?.["linear.plannerRequest"];
    const prefix = `planner-${run.id}-limit-`;
    const suffix = requestId?.startsWith(prefix) ? requestId.slice(prefix.length) : "";
    const attempt = /^[1-9]\d*$/.test(suffix) ? Number(suffix) : 0;
    const recovery = recoveryOf(run);
    const restart = recovery?.pending && attempt > 0 && attempt <= recovery.attempt
      && live.id !== run.agentId && live.id !== recovery.handledAgentId
      ? { requestId: requestId!, agentId: live.id, at: this.now() } : undefined;
    await this.store.update(run.id, (record, current) => current.approved || current.ownerAsked ? null : {
      ...record,
      planner: { ...current, started: true, agentId: live.id, startedAt: current.startedAt ?? new Date(this.now()).toISOString(), error: undefined,
        ...(run.recovery ? { recovery: { ...recoveryOf(current)!, pending: undefined, claim: undefined, handledAgentId: undefined } } : {}) },
    }, restart);
    if (run.recovery) {
      for (const agent of [...agents.live, ...agents.stopped, ...agents.ghosts]) {
        if (agent.id !== live.id) await this.deps.retire(agent.id, paseo);
      }
    }
    return true;
  }

  // Closes the run: the target's own change first (what the plan marked), then the run is gone from
  // the record, then its agent is retired.
  async close(run: PlannerRecord, change: (record: State, run: PlannerRecord) => State | null, paseo: PaseoApi): Promise<boolean> {
    const stored = await this.store.update(run.id, (record, current) => {
      const next = change(record, current);
      if (!next) return null;
      return { ...next, planner: null, closedPlanner: current.id };
    });
    if (!stored) return false;
    if (run.approved?.agentId) await this.deps.retire(run.approved.agentId, paseo);
    return true;
  }

  private async launchAvailability(settings: PluginSettings) {
    const selector = settings.lastProvider ? settings.launchPreferences?.[settings.lastProvider]?.model ?? null : null;
    const [chains, reports] = await Promise.all([this.deps.usage?.chains() ?? {}, this.deps.usage?.read() ?? null]);
    return { selector, recovery: reports ? availability(reports, selector ? candidates(chains, selector) : [], this.now()).recovery : null };
  }

  private async scheduleLimit(run: PlannerRecord, identity: string, error: string, model: string | null, settings: PluginSettings, failedAgentId?: string): Promise<void> {
    const hint = limitError(error)!;
    const old = recoveryOf(run) ?? { attempt: 0, claims: [] };
    if (old.pending?.identity === identity) return;
    const reading = await this.launchAvailability(settings);
    const now = this.now();
    const jitterMs = this.deps.jitter?.() ?? 60_000 + Math.floor(Math.random() * 240_001);
    const timing = limitSchedule(reading.recovery, hint.retryAfterMs, now, () => jitterMs);
    const fallback = limitSchedule(null, hint.retryAfterMs, now, () => jitterMs);
    const pending: NonNullable<PlannerRecovery["pending"]> = {
      identity, error, model: model ? normalizeModel(model) : null, failedAt: new Date(now).toISOString(),
      resumeAt: new Date(timing.resumeAt).toISOString(), fallbackAt: new Date(fallback.resumeAt).toISOString(),
      jitterMs, basis: timing.basis, selector: reading.selector,
    };
    await this.store.update(run.id, (record, current) => current.approved || current.ownerAsked ? null
      : { ...record, planner: { ...current, agentId: failedAgentId ?? current.agentId,
        recovery: { ...old, handledAgentId: failedAgentId ?? old.handledAgentId, pending }, error } });
  }

  // No new jitter or fallback deadline while waiting. Room can advance a wait, but only for the
  // selector the same settings snapshot will launch; preference changes invalidate old room.
  private async limitReady(run: PlannerRecord, settings: PluginSettings): Promise<boolean> {
    const recovery = recoveryOf(run)!;
    const pending = recovery.pending!;
    const reading = await this.launchAvailability(settings);
    const now = this.now();
    let at = Date.parse(pending.resumeAt);
    let basis = pending.basis;
    if (reading.recovery?.roomNow) { at = now; basis = "room"; }
    else if (pending.selector !== reading.selector || basis === "room") {
      const reset = reading.recovery?.earliestReset;
      at = reset !== null && reset !== undefined ? reset + pending.jitterMs : Date.parse(pending.fallbackAt);
      basis = reset !== null && reset !== undefined ? "reset" : limitError(pending.error)?.retryAfterMs ? "retry-after" : "default";
    } else if (reading.recovery?.earliestReset !== null && reading.recovery?.earliestReset !== undefined && reading.recovery.earliestReset > now) {
      at = Math.max(at, reading.recovery.earliestReset + pending.jitterMs);
      basis = "reset";
    }
    const claims = recovery.claims.filter((claim) => Date.parse(claim) > now - LIMIT_DAY);
    if (claims.length) at = Math.max(at, Math.max(...claims.map(Date.parse)) + LIMIT_SPACING);
    // A lost launch response keeps its original grace even if another account has room.
    if (pending.identity !== run.agentId || recovery.claim) at = Math.max(at, Date.parse(run.startedAt ?? run.listedAt) + RESTART_GRACE_MS);
    const provider = limitError(pending.error)?.provider ?? pending.model?.split("/")[0] ?? "provider";
    const updated = { ...pending, resumeAt: new Date(at).toISOString(), basis, selector: reading.selector };
    await this.store.update(run.id, (record, current) => current.approved || current.ownerAsked ? null
      : { ...record, planner: { ...current, recovery: { ...recovery, claims, pending: updated },
        error: `Usage limit on ${provider}: Paseo starts a new agent at ${limitTime(at, now)}.` } });
    return at <= now;
  }

  private async restartLimit(target: PlannerTarget, run: PlannerRecord, settings: PluginSettings, paseo: PaseoApi): Promise<void> {
    settings = await target.own(settings);
    if (!await this.limitReady(run, settings)) return;
    const brief = await target.brief(settings);
    // Broker/brief reads can outlive an uncertain creation: inspect again before spending a slot.
    run = (await this.store.current())!;
    if (!run || run.approved || run.ownerAsked) return;
    const agents = await target.agents(run, paseo);
    if (await this.adopt(run, agents, paseo)) return;
    if (!await this.limitReady(run, settings)) return;
    run = (await this.store.current())!;
    settings = await target.own(settings);
    const recovery = recoveryOf(run)!;
    if (recovery.claims.length >= 4) {
      await this.ask(target, run, "The planner reached four usage-limit restart attempts in twenty-four hours.");
      return;
    }
    const at = new Date(this.now()).toISOString();
    const attempt = recovery.attempt + 1;
    const requestId = `planner-${run.id}-limit-${attempt}`;
    await this.store.update(run.id, (record, current) => ({ ...record, planner: { ...current, startedAt: at, recovery: { ...recovery, attempt, claims: [...recovery.claims, at], claim: { requestId, at } } } }));
    let agentId: string;
    try {
      ({ agentId } = await target.start({ runId: run.id, requestId, brief }, paseo, settings));
    } catch (error) {
      if (error instanceof RepairBusyError) {
        // The repair holds the ticket briefly and nothing was created: undo the claim so the
        // pending limit recovery stays and the next pass retries it.
        await this.store.update(run.id, (record, current) => current.recovery?.claim?.requestId === requestId
          ? { ...record, planner: { ...current, startedAt: run.startedAt, recovery } }
          : null);
        console.log(`[linear-tickets] ${target.label}: the planner start waits for a repair; the next pass retries`);
        return;
      }
      const current = (await this.store.current())!;
      if (error instanceof SetupError) await this.ask(target, current, message(error));
      else if (limitError(message(error))) {
        await this.scheduleLimit(current, requestId, message(error), /\bmodel=([^\s,)]+)/i.exec(message(error))?.[1] ?? null, settings);
        await this.limitReady((await this.store.current())!, settings);
      } else if (/Agent creation could not be confirmed/i.test(message(error))) {
        // The response is uncertain, not proof no agent was created. Keep the spent claim and
        // pending limit until adoption or the next separately bounded identity after the grace.
        console.error(`[linear-tickets] ${target.label}: uncertain limit restart: ${message(error)}`);
      } else {
        await this.store.update(run.id, (record, stored) => ({ ...record, planner: { ...stored, error: message(error),
          recovery: { ...recoveryOf(stored)!, pending: undefined, claim: undefined } } }));
        throw error;
      }
      return;
    }
    // External creation has succeeded. Persistence/retirement failures are not failed creations.
    await this.store.update(run.id, (record, current) => ({
      ...record,
      planner: { ...current, started: true, agentId, error: undefined,
        recovery: { ...recoveryOf(current)!, pending: undefined, claim: undefined } },
    }), { requestId, agentId, at: this.now() });
    for (const stopped of [...agents.stopped, ...agents.ghosts]) await this.deps.retire(stopped.id, paseo);
  }

  // Starts (or starts again) the run's agent. Inspect roots before either retry budget: provider
  // limits use durable reset-aware claims, other failures keep the original grace/cap, and a
  // SetupError immediately leaves the run held. Called directly for a run whose record was written
  // but whose first start never happened.
  async launch(target: PlannerTarget, run: PlannerRecord, settings: PluginSettings, paseo: PaseoApi): Promise<void> {
    settings = await target.own(settings);
    const again = run.startedAt !== undefined;
    const agents = await target.agents(run, paseo);
    for (const ghost of agents.ghosts) console.log(`[linear-tickets] ${target.label}: planner agent ${ghost.id.slice(0, 8)} shows ${ghost.status} but its OMP process is gone; it counts as stopped`);
    recoveryOf(run); // Corruption never clears a durable budget or silently takes the generic path.
    if (await this.adopt(run, agents, paseo)) return;
    const stopped = run.agentId ? agents.stopped.find((agent) => agent.id === run.agentId)
      : agents.stopped.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id))[0];
    if (!run.recovery?.pending && stopped?.status === "error" && stopped.id !== run.recovery?.handledAgentId && limitError(stopped.lastError ?? "")) {
      await this.scheduleLimit(run, stopped.id, stopped.lastError!, activeModel(stopped), settings, stopped.id);
      run = (await this.store.current())!;
    }
    if (run.recovery?.pending) return this.restartLimit(target, run, settings, paseo);
    const restarts = run.restarts ?? 0;
    if (again && restarts >= RESTART_CAP) {
      await this.ask(target, run, `Paseo started the planner ${restarts + 1} times, and none of its agents is working on it now (the start failed, or the agent stopped without submitting a plan).`);
      return;
    }
    const brief = await target.brief(settings);
    settings = await target.own(settings);
    const counted = again ? restarts + 1 : restarts;
    const attemptAt = new Date(this.now()).toISOString();
    await this.store.update(run.id, (record, current) => ({ ...record, planner: { ...current, restarts: counted, startedAt: attemptAt } }));
    if (again) console.log(`[linear-tickets] ${target.label}: no live planner agent since its start at ${run.startedAt}; restart ${counted} of ${RESTART_CAP}`);
    let agentId: string;
    const requestId = run.recovery ? `planner-${run.id}-restart-${counted}-after-limit-${run.recovery.attempt}` : `planner-${run.id}-${counted}`;
    try {
      agentId = (await target.start({ runId: run.id, requestId, brief }, paseo, settings)).agentId;
    } catch (error) {
      if (error instanceof RepairBusyError || error instanceof RateLimitedError) {
        // A repair holding the ticket, or Linear's budget refusing the start's reads or writes, is
        // transient: undo this attempt's restart count and grace start so the next pass tries again
        // instead of spending the restart budget the owner is asked about. An agent the start
        // created before the refusal is adopted by the next pass before anything is started.
        await this.store.update(run.id, (record, current) => current.startedAt === attemptAt
          ? { ...record, planner: { ...current, restarts: run.restarts, startedAt: run.startedAt } }
          : null);
        console.log(`[linear-tickets] ${target.label}: the planner start waits (${message(error)}); the next pass retries`);
        return;
      }
      if (error instanceof SetupError) {
        await this.ask(target, { ...run, restarts: counted }, message(error));
        return;
      }
      if (limitError(message(error))) {
        await this.store.update(run.id, (record, current) => ({ ...record, planner: { ...current, restarts } }));
        run = (await this.store.current())!;
        await this.scheduleLimit(run, requestId, message(error), /\bmodel=([^\s,)]+)/i.exec(message(error))?.[1] ?? null, settings);
        await this.limitReady((await this.store.current())!, settings);
        return;
      }
      throw error;
    }
    await this.store.update(run.id, (record, current) => ({ ...record, planner: { ...current, started: true, agentId, startedAt: new Date(this.now()).toISOString(), error: undefined } }));
    for (const stopped of agents.stopped) await paseo.agents.ref(stopped.id).archive().catch((error: unknown) => console.error(`[linear-tickets] ${target.label}: archiving planner agent ${stopped.id.slice(0, 8)} failed: ${message(error)}`));
  }

  // Asks the owner once per run: the record is marked first, so later reads neither repeat the
  // notice nor restart the run; the target's write is logged and never retried, and never blocks
  // the target.
  private async ask(target: PlannerTarget, run: PlannerRecord, problem: string): Promise<void> {
    const stored = await this.store.update(run.id, (record, current) => current.ownerAsked ? null
      : { ...record, planner: { ...current, ownerAsked: true, error: problem } });
    if (!stored) return;
    await target.ask(run, problem);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}