import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { ActivationIntake } from "./activation-intake";
import { dispatchLabels, type DispatchLabels } from "./dispatch";
import { SetupError, type Launcher } from "./launch";
import type { LinearService, RepairCandidate } from "./linear";
import { CODING_STATE, PLANNING_STATE } from "./plannotator";
import { classifyTicketAgents, type ProcessInspector } from "./process-liveness";
import type { ProjectStore } from "./project-flow";
import { withPriority } from "./rate-budget";
import type { ReviewDeletions } from "./review-deletions";
import type { RestartOptions, RestartResult } from "./sessions";
import type { PluginSettings } from "./settings";
import { NEEDS_INPUT_STATE } from "./writeback";

// Repairing stale running and failed labels (README, "Repairing stale running and failed labels").
// `<trigger>-running` says an agent works on the ticket, `<trigger>-failed` that its start failed.
// Nothing else removes them when the agent is deleted, lost with its host's records or left without
// its process (a ghost), or when a start failed only for a passing glitch, so the project hand-out
// would skip such a ticket for good. Each label is reconciled with what is true, and a replacement
// agent starts only under stricter conditions:
// - An agent works on the ticket: live, stopped (closed or in error, left to its own recovery),
//   claimed by the peer host, queued as an activation, or starting. `-running` stays, `-failed`
//   comes off.
// - `-running` without one for ORPHAN_GRACE_MS: the labels come off, and an eligible ticket (a
//   work state, not held) starts again, at most RESTART_CAP times, ORPHAN_GRACE_MS apart.
// - `-failed` without one: started again after FAILED_BACKOFF_MINUTES, at most RESTART_CAP times;
//   then the owner is mentioned once and the label stays.
// - A start that fails on the host's setup (SetupError) is not retried: the owner is mentioned once.
// Every incident is a record in projects.json, claimed before each start and each comment, so a
// reload never doubles a start or a comment and never resets a cap.

// How often the pass runs: the cadence of the project reads.
const REPAIR_POLL_MS = 2 * 60_000;
// A ticket carries `-running` this long without an agent before the label comes off; also how long
// an interrupted restart may still be starting, and the pause between two restarts of an orphan.
const ORPHAN_GRACE_MS = 15 * 60_000;
const RESTART_CAP = 3;
// Retry N+1 of a failed start comes this many minutes after the failure before it.
const FAILED_BACKOFF_MINUTES = [10, 30, 90];
// A resolved incident is kept this long: an agent that vanishes again within it is the same
// incident (its restarts count on, no second comment).
const RESOLVED_KEEP_MS = 24 * 60 * 60_000;
const LOG_LIMIT = 10;
const CLOSED_TYPES = new Set(["completed", "canceled", "duplicate"]);
// Work states a replacement agent may start in; Needs input, review and other started states only
// lose a stale label: the owner's answer or the pull request watch starts their next agent.
const RESTART_TYPES = new Set(["triage", "backlog", "unstarted"]);
const RESTART_STARTED_STATES = new Set([PLANNING_STATE, CODING_STATE].map((name) => name.toLowerCase()));

export type RepairKind = "running" | "failed";
export type RepairState = "watching" | "restarting" | "resolved" | "exhausted";
// One incident per ticket. `incident`: its id; every write checks it, so a reset by the owner meanwhile
// is never overwritten. `orphanSince`/`failedSince`: when the grace or backoff of the next restart
// started (unset after an owner retry until the next scan). `attempts`: restarts claimed.
// `attemptAt`: when the restart under way was claimed. `cleared`: the repair removed the labels.
// `owner`: the incident began with the owner's retry, so it goes on without a label. `setup`: it
// stopped on a SetupError. `comments`: the comments already claimed. `log`: the last steps.
export type RepairRecord = {
  incident: string; identifier: string; kind: RepairKind; state: RepairState; attempts: number;
  orphanSince?: string; failedSince?: string; attemptAt?: string; startedAgentId?: string; exhaustedAt?: string; resolvedAt?: string;
  cleared?: boolean; owner?: boolean; setup?: boolean; lastReason?: string; comments?: string[];
  log: { at: string; action: string }[];
};

type Deps = {
  linear: Pick<LinearService, "repairCandidates" | "addLabel" | "removeLabel" | "comment" | "issueState" | "userUrl" | "viewerId">;
  store: Pick<ProjectStore, "repairs" | "updateRepairs">;
  launcher: Pick<Launcher, "gate" | "underWay">;
  // SessionRouter.restartFor.
  restart: (issueId: string, identifier: string, options: RestartOptions) => Promise<RestartResult>;
  intake: Pick<ActivationIntake, "claimFor" | "pendingFor" | "claimsReady">;
  deletions?: Pick<ReviewDeletions, "blocked">;
  now?: () => number;
  // Provider-process inspection for ghost agents; the tests inject a fake process table.
  inspect?: ProcessInspector;
};

type Names = DispatchLabels & { trigger: string };
type Ownership = { works: boolean; why: string; local: { id: string; createdAt: string } | null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasLabel(labels: { name: string }[], name: string): boolean {
  return labels.some((label) => label.name.trim().toLowerCase() === name.toLowerCase());
}

function sinceOf(record: RepairRecord): string | undefined {
  return record.kind === "running" ? record.orphanSince : record.failedSince;
}

function timed(record: RepairRecord, at: string): RepairRecord {
  return record.kind === "running" ? { ...record, orphanSince: at } : { ...record, failedSince: at };
}

// The state a replacement agent may start in: Triage, Backlog, Todo, Planning or In Progress.
function restartable(status: string, statusType: string): boolean {
  const type = statusType.trim().toLowerCase();
  return RESTART_TYPES.has(type) || (type === "started" && RESTART_STARTED_STATES.has(status.trim().toLowerCase()));
}

function heldBy(labels: { name: string }[], names: Names): string | null {
  return [names.hold, names.manual, names.needsYou].find((name) => hasLabel(labels, name)) ?? null;
}

function sentence(reason: string): string {
  return reason.trim().replace(/[.\s]+$/, "");
}

export class LabelRepair {
  private lastPoll = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: Deps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // Called on every dispatch poll, after the projects; runs at most every REPAIR_POLL_MS. Only the
  // host that hands out tickets repairs: a draining host never does, and this host only once it
  // knows which tickets the peer keeps (the claims handshake). Background priority is set here, not
  // left to the dispatch tick that usually calls it, so a direct call pauses at the pool's reserve
  // too (see rate-budget.ts).
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    await withPriority("background", "label-repair", async () => {
      if (settings.activation.mode === "remote" || this.now() - this.lastPoll < REPAIR_POLL_MS) return;
      this.lastPoll = this.now();
      try {
        if (!await this.deps.intake.claimsReady()) return;
        const names = { ...dispatchLabels(settings.dispatch.label), trigger: settings.dispatch.label };
        const records = await this.deps.store.repairs();
        const tickets = await this.deps.linear.repairCandidates({ labels: [names.running, names.failed], teamKeys: settings.dispatch.teamKeys, ids: Object.keys(records) });
        const open = new Map(tickets.filter((ticket) => !CLOSED_TYPES.has(ticket.statusType.trim().toLowerCase())).map((ticket) => [ticket.id, ticket]));
        // Records whose ticket closed or is gone end with it.
        const gone = Object.keys(records).filter((id) => !open.has(id));
        if (gone.length) await this.deps.store.updateRepairs((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !gone.includes(id))));
        // One restart per pass: a start takes a minute or two, and the dispatcher's poll waits for it.
        const pass = { restarted: false };
        for (const ticket of open.values()) {
          await this.repair(paseo, names, ticket, records[ticket.id] ?? null, pass)
            .catch((error: unknown) => console.error(`[linear-tickets] ${ticket.identifier}: repairing its labels failed, the next pass retries: ${message(error)}`));
        }
        this.lastError = null;
      } catch (error) {
        if (message(error) !== this.lastError) console.error(`[linear-tickets] the label repair pass failed: ${message(error)}`);
        this.lastError = message(error);
      }
    });
  }

  // The owner started the ticket again (the trigger label, the sidebar): any incident of it ends,
  // and a later failure or vanished agent is a new one, with fresh restarts. `issue`: its id or
  // identifier. Throws when the record could not be written: the caller then starts nothing.
  async ownerRetried(issue: string): Promise<void> {
    await this.deps.store.updateRepairs((current) => {
      const id = current[issue] ? issue : Object.keys(current).find((key) => current[key].identifier === issue);
      if (!id) return null;
      const old = current[id];
      const reset: RepairRecord = { incident: randomUUID(), identifier: old.identifier, kind: old.kind, state: "watching", attempts: 0, owner: true, log: old.log };
      console.log(`[linear-tickets] ${old.identifier}: started again by the owner; its label repair begins anew`);
      return { ...current, [id]: logged(reset, this.iso(), "the owner started it again; a new incident") };
    });
  }

  // Writes the ticket's record as `next` (null deletes it) if it still is incident `incident` (null:
  // no record). False when it changed meanwhile (the owner reset it): the caller then stops.
  private async commit(issueId: string, incident: string | null, next: RepairRecord | null): Promise<boolean> {
    let written = false;
    await this.deps.store.updateRepairs((current) => {
      if ((current[issueId]?.incident ?? null) !== incident) return null;
      written = true;
      const rest = Object.fromEntries(Object.entries(current).filter(([id]) => id !== issueId));
      return next ? { ...rest, [issueId]: next } : rest;
    });
    return written;
  }

  // Whether an agent works on the ticket anywhere: on this host (live, or stopped but still there;
  // ghosts do not count), claimed by the peer host, queued as an activation, or a start under way.
  // `inGate`: the caller holds the ticket's start gate, which `underWay` would report.
  private async ownership(paseo: PaseoApi, ticket: { id: string; identifier: string }, inGate: boolean): Promise<Ownership> {
    const agents = await classifyTicketAgents(paseo, ticket.id, this.now(), this.deps.inspect);
    for (const ghost of agents.ghosts) console.log(`[linear-tickets] ${ticket.identifier}: agent ${ghost.id.slice(0, 8)} shows ${ghost.status} but its OMP process is gone; it counts as gone`);
    const local = [...agents.live, ...agents.stopped].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (local) return { works: true, why: `agent ${local.id.slice(0, 8)} is ${local.status}`, local: { id: local.id, createdAt: local.createdAt } };
    const claim = await this.deps.intake.claimFor(ticket.id);
    if (claim) return { works: true, why: `it runs on ${claim.host || "the peer host"}`, local: null };
    if (await this.deps.intake.pendingFor(ticket.id)) return { works: true, why: "an activation for it is queued", local: null };
    if (!inGate && this.deps.launcher.underWay(ticket.id)) return { works: true, why: "a start is under way", local: null };
    return { works: false, why: "no agent works on it", local: null };
  }

  // Why the ticket may not get a replacement agent right now (null: it may), read fresh from Linear
  // and the hosts. Runs inside restartFor, after its admission and right before the start.
  private async refusal(paseo: PaseoApi, ticket: RepairCandidate, names: Names): Promise<string | null> {
    const state = await this.deps.linear.issueState(ticket.id);
    if (CLOSED_TYPES.has(state.statusType.trim().toLowerCase())) return `${ticket.identifier} is ${state.status}`;
    if (hasLabel(state.labels, names.trigger)) return `${ticket.identifier} carries ${names.trigger} now`;
    const held = heldBy(state.labels, names);
    if (held) return `${ticket.identifier} carries ${held}`;
    if (!restartable(state.status, state.statusType)) return `${ticket.identifier} is in ${state.status}`;
    const own = await this.ownership(paseo, ticket, true);
    return own.works ? `an agent works on ${ticket.identifier} (${own.why})` : null;
  }

  private async repair(paseo: PaseoApi, names: Names, ticket: RepairCandidate, stored: RepairRecord | null, pass: { restarted: boolean }): Promise<void> {
    const { linear } = this.deps;
    const running = hasLabel(ticket.labels, names.running);
    const failed = hasLabel(ticket.labels, names.failed);
    // The trigger label belongs to the dispatch, a group's work to its sub-issues; a ticket being
    // deleted to no one.
    if (hasLabel(ticket.labels, names.trigger) || ticket.openChildren) return;
    if (await this.deps.deletions?.blocked(ticket.id)) return;
    const own = await this.ownership(paseo, ticket, false);
    const now = this.iso();
    let record = stored;

    // A restart whose outcome was never stored (the plugin reloaded during it). The attempt counts
    // either way; it is never given back and never claimed a fourth time.
    if (record?.state === "restarting") {
      if (own.works) {
        if (own.local && !running) await linear.addLabel(ticket.id, names.running);
        if (failed) await linear.removeLabel(ticket.id, names.failed, ticket.labels);
        await this.commit(ticket.id, record.incident, logged({ ...record, state: "resolved", resolvedAt: now, ...(own.local ? { startedAgentId: own.local.id } : {}) }, now, `the interrupted restart ${record.attempts} left an agent: ${own.why}`));
        return;
      }
      const attemptAt = record.attemptAt ?? now;
      if (this.now() - Date.parse(attemptAt) < ORPHAN_GRACE_MS) return;
      const lost = `restart ${record.attempts} was interrupted and no agent came up`;
      if (record.attempts >= RESTART_CAP) await this.exhaust(ticket, { ...record, lastReason: lost }, names, now, lost);
      else await this.commit(ticket.id, record.incident, logged(timed({ ...record, state: "watching", lastReason: lost }, attemptAt), now, lost));
      return;
    }

    // Left to the owner. Only the owner's own start ends it: the trigger label or the sidebar
    // (ownerRetried), or an agent of this host that came after it and is not the repair's own.
    if (record?.state === "exhausted") {
      const exhaustedAt = record.exhaustedAt ?? now;
      const ownersAgent = own.local && own.local.id !== record.startedAgentId && own.local.createdAt > exhaustedAt;
      if (!ownersAgent) {
        if (own.works && failed) await this.clearFailed(ticket, record, names, now, own);
        return;
      }
      if (!await this.commit(ticket.id, record.incident, null)) return;
      record = null;
    }

    if (record?.state === "resolved") {
      const old = this.now() - Date.parse(record.resolvedAt ?? now) > RESOLVED_KEEP_MS;
      if (own.works || (!running && !failed)) {
        if (own.works && failed) await this.clearFailed(ticket, record, names, now, own);
        if (old) await this.commit(ticket.id, record.incident, null);
        return;
      }
      if (old) {
        if (!await this.commit(ticket.id, record.incident, null)) return;
        record = null;
      } else {
        // Vanished again within a day: the same incident, its restarts and comments count on.
        const reopened = logged(timed({ ...record, kind: running ? "running" : "failed", state: "watching", cleared: false, resolvedAt: undefined }, now), now, "no agent works on it again");
        await this.commit(ticket.id, record.incident, reopened);
        return;
      }
    }

    if (!record) {
      if (own.works) {
        if (failed) await this.clearFailed(ticket, null, names, now, own);
        return;
      }
      if (!running && !failed) return;
      const kind: RepairKind = running ? "running" : "failed";
      const opened: RepairRecord = timed({ incident: randomUUID(), identifier: ticket.identifier, kind, state: "watching", attempts: 0, log: [] }, now);
      await this.commit(ticket.id, null, logged(opened, now, kind === "running" ? `carries ${names.running} but no agent works on it` : `carries ${names.failed} and no agent works on it`));
      return;
    }

    // Watching. An owner's retry left the timing for this scan: it starts from the labels now.
    if (!sinceOf(record)) {
      const kind: RepairKind = running ? "running" : failed ? "failed" : record.kind;
      await this.commit(ticket.id, record.incident, logged(timed({ ...record, kind }, now), now, `watching the owner's start (${kind})`));
      return;
    }
    if (own.works) {
      if (failed) await this.clearFailed(ticket, record, names, now, own);
      await this.commit(ticket.id, record.incident, record.attempts === 0 && !record.cleared ? null
        : logged({ ...record, state: "resolved", resolvedAt: now }, now, `an agent works on it: ${own.why}`));
      return;
    }
    // The label went without the repair (the owner, an archived agent): nothing stale is left.
    if (!running && !failed && !record.cleared && !record.owner) {
      await this.commit(ticket.id, record.incident, null);
      return;
    }
    const held = heldBy(ticket.labels, names);
    const eligible = !held && restartable(ticket.status, ticket.statusType);

    if (record.kind === "running") {
      if (this.now() - Date.parse(sinceOf(record)!) < ORPHAN_GRACE_MS) return;
      if (running || failed) {
        // Removed under the ticket's start gate after a last look, so a start that came up in
        // between keeps its label.
        const gate = this.deps.launcher.gate(ticket.id);
        if (!gate) return;
        try {
          const again = await this.ownership(paseo, ticket, true);
          if (again.works) return;
          if (running) await linear.removeLabel(ticket.id, names.running, ticket.labels);
          if (failed) await linear.removeLabel(ticket.id, names.failed, ticket.labels);
          const marker = record.comments?.includes("cleanup") ? null : "cleanup";
          const cleared = logged({ ...record, cleared: true, comments: [...record.comments ?? [], ...marker ? [marker] : []] }, now, `removed ${[running ? names.running : "", failed ? names.failed : ""].filter(Boolean).join(" and ")}: no agent for 15 minutes`);
          if (!await this.commit(ticket.id, record.incident, cleared)) return;
          record = cleared;
          if (marker) await this.post(ticket, vanishedComment(names, ticket, held, eligible));
        } finally {
          gate.release();
        }
      }
      if (!eligible) {
        await this.commit(ticket.id, record.incident, logged({ ...record, state: "resolved", resolvedAt: now }, now, `no new agent: ${held ? `it carries ${held}` : `it is in ${ticket.status}`}`));
        return;
      }
    } else {
      // A failed start in a state or with a label no agent starts for waits for the owner.
      if (!eligible) return;
      const due = Date.parse(sinceOf(record)!) + (FAILED_BACKOFF_MINUTES[record.attempts] ?? FAILED_BACKOFF_MINUTES.at(-1)!) * 60_000;
      if (record.attempts < RESTART_CAP && this.now() < due) return;
    }
    if (record.attempts >= RESTART_CAP) {
      await this.exhaust(ticket, record, names, now, record.lastReason ?? "the earlier restarts did not leave an agent");
      return;
    }
    if (pass.restarted) return;
    pass.restarted = true;
    // `-failed` is still on the ticket unless this pass removed it with the running label.
    await this.attempt(paseo, ticket, record, names, failed && !record.cleared);
  }

  // One restart, claimed before it runs. A definite no-start (deferred, forwarded, skipped) gives the
  // attempt back; anything else keeps it.
  private async attempt(paseo: PaseoApi, ticket: RepairCandidate, watching: RepairRecord, names: Names, failed: boolean): Promise<void> {
    const n = watching.attempts + 1;
    const claimed = logged({ ...watching, attempts: n, state: "restarting", attemptAt: this.iso() }, this.iso(), `restart ${n} of ${RESTART_CAP}`);
    if (!await this.commit(ticket.id, watching.incident, claimed)) return;
    console.log(`[linear-tickets] ${ticket.identifier}: ${watching.kind === "running" ? "no agent since its label came off" : `${names.failed} without an agent`}; restart ${n} of ${RESTART_CAP}`);
    const result = await this.deps.restart(ticket.id, ticket.identifier, {
      retryHint: `add the "${names.trigger}" label again`,
      eligible: () => this.refusal(paseo, ticket, names),
    }).catch((error: unknown): RestartResult => ({ kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }));
    const at = this.iso();
    const { linear } = this.deps;
    if (result.kind === "started" || result.kind === "live") {
      const comments = [...claimed.comments ?? []];
      const marker = watching.kind === "failed" ? `retry-${n}` : null;
      if (marker && !comments.includes(marker)) comments.push(marker);
      const resolved = logged({ ...claimed, state: "resolved", resolvedAt: at, lastReason: undefined, comments, ...(result.kind === "started" ? { startedAgentId: result.agentId } : {}) },
        at, result.kind === "started" ? `restart ${n} started agent ${result.agentId.slice(0, 8)}` : `restart ${n} found a live agent`);
      if (!await this.commit(ticket.id, claimed.incident, resolved)) return;
      if (result.kind === "started" && !result.marked) await linear.addLabel(ticket.id, names.running).catch((error: unknown) => console.error(`[linear-tickets] ${ticket.identifier}: adding ${names.running} failed: ${message(error)}`));
      if (!failed) return;
      // Left in place when this fails: the next pass sees the agent and removes it then.
      const removed = await linear.removeLabel(ticket.id, names.failed, ticket.labels).then(() => true, (error: unknown) => { console.error(`[linear-tickets] ${ticket.identifier}: removing ${names.failed} failed, the next pass retries: ${message(error)}`); return false; });
      if (removed && marker) await this.post(ticket, result.kind === "started"
        ? `Paseo started an agent for this ticket on retry ${n} of ${RESTART_CAP} after its failed start, and removed \`${names.failed}\`.`
        : `Paseo removed \`${names.failed}\`: an agent works on this ticket now.`);
      return;
    }
    if (result.kind !== "failed") {
      const why = result.kind === "deferred" ? result.reason : result.kind === "forwarded" ? `handed to ${result.peer}` : "the ticket is deleted or paused for deletion";
      await this.commit(ticket.id, claimed.incident, logged({ ...claimed, attempts: watching.attempts, state: "watching", attemptAt: undefined }, at, `restart ${n} did not start: ${why}`));
      return;
    }
    const reason = result.error.message;
    console.error(`[linear-tickets] ${ticket.identifier}: restart ${n} of ${RESTART_CAP} failed: ${reason}`);
    if (result.error instanceof SetupError) {
      const stopped = logged({ ...claimed, state: "exhausted", exhaustedAt: at, setup: true, lastReason: reason, comments: [...claimed.comments ?? [], "setup"] }, at, `restart ${n} failed on setup: ${reason}`);
      if (!await this.commit(ticket.id, claimed.incident, stopped)) return;
      if (!failed) await linear.addLabel(ticket.id, names.failed).catch((error: unknown) => console.error(`[linear-tickets] ${ticket.identifier}: adding ${names.failed} failed: ${message(error)}`));
      if (!claimed.comments?.includes("setup")) await this.post(ticket, `**Paseo cannot start an agent for this ticket until its setup is fixed:** ${sentence(reason)}. It does not retry; the ticket is marked \`${names.failed}\`.`, true);
      return;
    }
    const after = { ...claimed, lastReason: reason };
    if (n >= RESTART_CAP) await this.exhaust(ticket, after, names, at, reason);
    else await this.commit(ticket.id, claimed.incident, logged(timed({ ...after, state: "watching", attemptAt: undefined }, at), at, `restart ${n} failed: ${reason}`));
  }

  // RESTART_CAP restarts left no agent: the ticket waits for the owner, who is told once.
  private async exhaust(ticket: RepairCandidate, record: RepairRecord, names: Names, at: string, reason: string): Promise<void> {
    const asked = record.comments?.includes("cap");
    const next = logged({ ...record, state: "exhausted", exhaustedAt: at, comments: asked ? record.comments : [...record.comments ?? [], "cap"] }, at, `left to the owner after ${record.attempts} restarts`);
    if (!await this.commit(ticket.id, record.incident, next) || asked) return;
    console.error(`[linear-tickets] ${ticket.identifier}: no agent after ${record.attempts} restarts; left to the owner`);
    if (record.kind === "running") {
      await this.post(ticket, `**Paseo could not start an agent for this ticket.** Its agent was gone, and Paseo started it again ${record.attempts} times, but no agent is working on it now (the start failed, or the agent never came up), so it stops trying. Last failure: ${sentence(reason)}. Start an agent for it from the Linear tickets sidebar, or add the \`${names.trigger}\` label to try again.`);
    } else {
      await this.post(ticket, `**Paseo could not start an agent for this ticket**, also after ${RESTART_CAP} more tries (${FAILED_BACKOFF_MINUTES.slice(0, -1).join(", ")} and ${FAILED_BACKOFF_MINUTES.at(-1)} minutes after each failure). Last failure: ${sentence(reason)}. The ticket stays \`${names.failed}\`: start an agent from the Linear tickets sidebar, or add the \`${names.trigger}\` label.`, true);
    }
  }

  // An agent works on a ticket still marked failed: the label comes off, then the comment. A label
  // that could not be removed throws, so the next pass tries again before anything is said.
  private async clearFailed(ticket: RepairCandidate, record: RepairRecord | null, names: Names, at: string, own: Ownership): Promise<void> {
    await this.deps.linear.removeLabel(ticket.id, names.failed, ticket.labels);
    const action = `removed ${names.failed}: ${own.why}`;
    console.log(`[linear-tickets] ${ticket.identifier}: ${action}`);
    if (record) await this.commit(ticket.id, record.incident, logged(record, at, action));
    else await this.commit(ticket.id, null, logged({ incident: randomUUID(), identifier: ticket.identifier, kind: "failed", state: "resolved", attempts: 0, resolvedAt: at, log: [] }, at, action));
    await this.post(ticket, `Paseo removed \`${names.failed}\`: an agent works on this ticket now.`);
  }

  // A failed comment never stops a repair: it is logged, and its claim stays (never twice).
  private async post(ticket: RepairCandidate, body: string, mention = false): Promise<void> {
    const { linear } = this.deps;
    try {
      await linear.comment(ticket.id, mention ? `${await linear.userUrl(await linear.viewerId())} ${body}` : body);
    } catch (error) {
      console.error(`[linear-tickets] ${ticket.identifier}: the label repair's comment failed: ${message(error)}`);
    }
  }
}

function logged(record: RepairRecord, at: string, action: string): RepairRecord {
  console.log(`[linear-tickets] ${record.identifier}: label repair: ${action}`);
  return { ...record, log: [...record.log, { at, action }].slice(-LOG_LIMIT) };
}

// The comment when the labels of a vanished agent come off: whether a new agent starts, and if not,
// what starts the next one.
function vanishedComment(names: Names, ticket: RepairCandidate, held: string | null, eligible: boolean): string {
  const lead = `**No agent was working on this ticket.** It carried \`${names.running}\` for 15 minutes without a working agent on any Paseo host (the agent was deleted, lost with its host's records, or its process is gone).`;
  if (eligible) return `${lead} Paseo removed the label and starts a new agent; it tries up to ${RESTART_CAP} times.`;
  if (held === names.needsYou || ticket.status.trim().toLowerCase() === NEEDS_INPUT_STATE.toLowerCase()) return `${lead} Paseo removed the label. No new agent starts while the ticket waits for you: your answer here starts one.`;
  if (held) return `${lead} Paseo removed the label; no agent starts while the ticket is held.`;
  if (/review|merge/i.test(ticket.status)) return `${lead} Paseo removed the label. The pull request watch starts a new agent when the pull request needs one.`;
  return `${lead} Paseo removed the label. No new agent starts while the ticket is in ${ticket.status}.`;
}
