import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { dispatchLabels } from "./dispatch";
import type { Launcher } from "./launch";
import type { LinearService } from "./linear";
import { LIVE_AGENT } from "./process-liveness";
import { deliverToAgent } from "./relay";
import { ResumeUnavailableError, type TicketStarter, type Started } from "./starter";
import type { Settings } from "./settings";
import type { SessionRouter } from "./sessions";
import {
  activationDirectory,
  activationEnvelopeSchema,
  activationJson,
  activationText,
  claimsSyncSchema,
  JsonFile,
  postToPeer,
  readActivationSecret,
  recoverActivationId,
  type ActivationEnvelope,
  type ActivationRequest,
  type ActivationSink,
  type ActivationTake,
  type ClaimsSync,
  type RequestLike,
} from "./activation";

const SWEEP_MS = 60_000;
const TOMBSTONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_ENTRIES = 1_000;
const RETRY_CAP_MINUTES = 15;
const HANDFOFF_NOTE_LIMIT = 1_500;

// `host` is the source host label the draining host registered with its claim (never a URL; the
// peer's configured origin is what deliveries are sent to). `appliedAt` is the handshake: set
// when the first full snapshot arrived, even an empty one -- before that this host starts no
// automatic ticket work at all, because it cannot know which roots still run on the other side.
type Claim = { issueId: string; identifier: string; agentId: string; host: string; claimedAt: string; updatedAt: string };
// `seeds` remembers the highest revision applied per seed id: a re-seeded host (a new id) starts
// a fresh set even at a low revision, while a snapshot that arrives late for a seed already
// applied is never let back in.
type ClaimsFile = { version: 1; host: string; seed: string; revision: number; appliedAt: string; seeds: Record<string, number>; claims: Record<string, Claim>; receipts: Record<string, string> };
export type PendingState = "pending" | "done" | "handoff";
type PendingEntry = {
  envelope: ActivationEnvelope;
  state: PendingState;
  attempts: number;
  note: string | null;
  at: string;
  updatedAt: string;
  retryAt: string;
  commented: boolean;
};
type PendingFile = { version: 1; entries: Record<string, PendingEntry> };

export type IntakeStatus = {
  mode: "local" | "remote";
  peer: string | null;
  host: string;
  claims: number;
  revision: number;
  appliedAt: string | null;
  pending: number;
  handoffs: number;
  done: number;
};

export type IntakeDeps = {
  settings: Pick<Settings, "read">;
  // Late-bound: the plugin builds these after the intake exists.
  paseo: () => PaseoApi | null;
  linear: () => Pick<LinearService, "comment" | "addLabel" | "removeLabel"> | null;
  starter: () => Pick<TicketStarter, "start" | "admission"> | null;
  launcher: () => Pick<Launcher, "gate"> | null;
  // The session router, to open this host's own thread for an agent a forwarded activation started.
  sessions?: () => Pick<SessionRouter, "openFor"> | null;
  sessionFor?: (agentId: string) => Promise<{ closed?: boolean } | null>;
  deliver?: (paseo: PaseoApi, agentId: string, message: string) => Promise<void>;
  request?: RequestLike;
  home?: string;
  host?: string;
  now?: () => number;
  log?: (message: string) => void;
  sweepMs?: number;
};

function claimsFrom(raw: unknown): ClaimsFile {
  const value = raw && typeof raw === "object" ? raw as Partial<ClaimsFile> : {};
  const claims: Record<string, Claim> = {};
  if (value.claims && typeof value.claims === "object" && !Array.isArray(value.claims)) {
    for (const [issueId, claim] of Object.entries(value.claims)) {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) continue;
      const candidate = claim as Partial<Claim>;
      if (typeof candidate.identifier !== "string" || typeof candidate.agentId !== "string") continue;
      claims[issueId] = {
        issueId,
        identifier: candidate.identifier,
        agentId: candidate.agentId,
        host: typeof candidate.host === "string" ? candidate.host : "",
        claimedAt: typeof candidate.claimedAt === "string" ? candidate.claimedAt : "",
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
      };
    }
  }
  const receipts: Record<string, string> = {};
  if (value.receipts && typeof value.receipts === "object" && !Array.isArray(value.receipts)) {
    for (const [id, at] of Object.entries(value.receipts)) if (typeof at === "string") receipts[id] = at;
  }
  const seeds: Record<string, number> = {};
  if (value.seeds && typeof value.seeds === "object" && !Array.isArray(value.seeds)) {
    for (const [id, revision] of Object.entries(value.seeds)) if (typeof revision === "number" && Number.isInteger(revision)) seeds[id] = revision;
  }
  return {
    version: 1,
    host: typeof value.host === "string" ? value.host : "",
    seed: typeof value.seed === "string" ? value.seed : "",
    revision: typeof value.revision === "number" ? value.revision : 0,
    appliedAt: typeof value.appliedAt === "string" ? value.appliedAt : "",
    seeds,
    claims,
    receipts,
  };
}

function pendingFrom(raw: unknown): PendingFile {
  const value = raw && typeof raw === "object" ? raw as Partial<PendingFile> : {};
  const entries: Record<string, PendingEntry> = {};
  if (value.entries && typeof value.entries === "object" && !Array.isArray(value.entries)) {
    for (const [id, entry] of Object.entries(value.entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const candidate = entry as Partial<PendingEntry>;
      const envelope = activationEnvelopeSchema.safeParse(candidate.envelope);
      if (!envelope.success) continue;
      entries[id] = {
        envelope: envelope.data,
        state: candidate.state === "done" || candidate.state === "handoff" ? candidate.state : "pending",
        attempts: typeof candidate.attempts === "number" ? candidate.attempts : 0,
        note: typeof candidate.note === "string" ? candidate.note : null,
        at: typeof candidate.at === "string" ? candidate.at : envelope.data.requestedAt,
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : envelope.data.requestedAt,
        retryAt: typeof candidate.retryAt === "string" ? candidate.retryAt : "",
        commented: candidate.commented === true,
      };
    }
  }
  return { version: 1, entries };
}

// The receiving host of a two-host cutover (README, "Draining a host"). It holds the draining
// host's claims durably and fails closed for those tickets -- a deferred activation is delivered
// to the agent that owns it there, or waits until the claim is released and starts here. Every
// other ticket starts through this host's normal admission, scheduler and launcher, without
// contacting the draining host at all (it may be asleep).
//
// Until the first claims snapshot has been applied, this host starts no automatic ticket work at
// all: right after a reload during the cutover it cannot know which roots still run there, and an
// activation that arrives in that window waits (durably) instead of starting beside one.
export class ActivationIntake implements ActivationSink {
  private readonly home: string;
  private readonly host: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly request: RequestLike;
  private readonly sweepMs: number;
  private readonly claimsFile: JsonFile<ClaimsFile>;
  private readonly pendingFile: JsonFile<PendingFile>;
  private readonly inFlight = new Map<string, Promise<PendingEntry>>();
  private background: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly deps: IntakeDeps) {
    this.home = deps.home ?? activationDirectory();
    this.host = deps.host ?? "this host";
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.log(`[linear-tickets] ${message}`));
    this.request = deps.request ?? (fetch as unknown as RequestLike);
    this.sweepMs = deps.sweepMs ?? SWEEP_MS;
    this.claimsFile = new JsonFile(`${this.home}/activation-claims.json`, () => claimsFrom(null), claimsFrom);
    this.pendingFile = new JsonFile(`${this.home}/activation-pending.json`, () => pendingFrom(null), pendingFrom);
  }

  start(): void {
    void this.retry();
    this.timer ??= setInterval(() => { void this.retry(); }, this.sweepMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  // The claim the draining host registered for a ticket, if any. This is the authority every
  // deferred decision reads: a claim stays until a newer snapshot releases it, and a missing
  // answer from the draining host is not one.
  async claimFor(issueId: string): Promise<Claim | null> {
    return (await this.claimsFile.load()).claims[issueId] ?? null;
  }

  // Whether an activation for the ticket waits here (queued or handed off, not done): a start for
  // it is under way, so nothing else may start one. Throws when the queue is unreadable.
  async pendingFor(issueId: string): Promise<boolean> {
    return Object.values((await this.pendingFile.load()).entries).some((entry) => entry.envelope.issueId === issueId && entry.state !== "done");
  }

  // Whether this host knows which tickets the peer keeps: no peer is configured, or its first
  // claims snapshot arrived (the handshake). Throws when the claims are unreadable.
  async claimsReady(): Promise<boolean> {
    const claims = await this.claimsFile.load();
    return Boolean(claims.appliedAt) || !(await this.deps.settings.read()).activation.peer;
  }

  // Applies one claims snapshot. The comparison and the replacement are one change to the file,
  // so two snapshots that arrive out of order cannot let the older one overwrite the newer one.
  // The check is per seed id: a re-seeded host (a new id) replaces the set even from a low
  // revision, while a snapshot for a seed already applied must be strictly newer.
  async applyClaims(input: unknown): Promise<{ revision: number }> {
    const sync = claimsSyncSchema.parse(input);
    const at = new Date(this.now()).toISOString();
    let applied = 0;
    let changed = false;
    await this.claimsFile.update((file) => {
      const known = file.seeds[sync.seed] ?? (file.seed === sync.seed ? file.revision : -1);
      if (known >= sync.revision) {
        applied = file.revision;
        return;
      }
      const previous = file.claims;
      file.host = sync.host;
      file.seed = sync.seed;
      file.revision = sync.revision;
      // The first applied snapshot is the handshake; an empty one counts.
      file.appliedAt = file.appliedAt || at;
      file.seeds[sync.seed] = sync.revision;
      const seeds = Object.keys(file.seeds);
      for (const old of seeds.slice(0, Math.max(0, seeds.length - 8))) if (old !== sync.seed) delete file.seeds[old];
      file.claims = Object.fromEntries(sync.claims.map((claim) => [claim.issueId, {
        ...claim,
        host: sync.host,
        claimedAt: previous[claim.issueId]?.claimedAt || at,
        updatedAt: at,
      }]));
      applied = sync.revision;
      changed = true;
    });
    if (changed) this.log(`activation routing: ${sync.host} registered ${sync.claims.length} claim(s) (revision ${sync.revision})`);
    return { revision: applied };
  }

  // An activation from the draining host: persisted whole, answered with 202 as soon as it is on
  // disk -- a slow start must not run into the peer's timeout and be retried -- then processed in
  // the background and by the sweep. The duplicate check and the insert are one change to the
  // file, so two forwards of the same id that arrive together become one activation. An already
  // recorded id is never reset: the source ids are immutable (a session, an activity, a comment),
  // and a label that is added again travels under a fresh occurrence id.
  async accept(raw: unknown): Promise<{ status: number; body: string }> {
    const parsed = activationEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return activationJson(400, { error: "That is not an activation." });
    const envelope = parsed.data;
    if ((await this.deps.settings.read()).activation.mode === "remote") return activationJson(409, { error: "This host is draining; it does not accept activations." });
    let duplicate = false;
    const file = await this.pendingFile.update((current) => {
      if (current.entries[envelope.id]) { duplicate = true; return; }
      current.entries[envelope.id] = {
        envelope,
        state: "pending",
        attempts: 0,
        note: null,
        at: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        retryAt: "",
        commented: false,
      };
      this.prune(current);
    });
    const entry = file.entries[envelope.id];
    if (duplicate) return activationJson(202, { ok: true, id: envelope.id, state: entry.state, duplicate: true });
    this.kick(envelope.id);
    return activationJson(202, { ok: true, id: envelope.id, state: entry.state });
  }

  // Routing for this host's own automatic start paths. Nothing decides on a state it cannot read;
  // a ticket this host still works on is never taken over (a reply, an approval or a message for a
  // live agent here stays here, whatever the other host claims); a ticket no claim covers starts
  // here without contacting the other host at all. Until the first snapshot has been applied no
  // automatic start happens here either.
  async take(request: ActivationRequest): Promise<ActivationTake> {
    let claims: ClaimsFile;
    try { claims = await this.claimsFile.load(); }
    catch (error) { return { held: `this host's claims are unreadable (${reason(error)})` }; }
    if (!claims.appliedAt && (await this.deps.settings.read()).activation.peer) return { held: "the other host has not registered the agents it keeps yet" };
    const claim = claims.claims[request.issueId];
    if (!claim) return null;
    // A new session is new work for the ticket's owner; a message for a ticket this host already
    // works on belongs to the agent here, not to the claim.
    if (request.kind !== "session") {
      const paseo = this.deps.paseo();
      if (!paseo) return { held: "Paseo is not connected on this host" };
      let local: PaseoAgent | null;
      try { local = await this.liveAgent(paseo, request.issueId); }
      catch (error) { return { held: `whether this host still works on the ticket could not be read (${reason(error)})` }; }
      if (local) return null;
    }
    const envelope: ActivationEnvelope = {
      id: request.id ?? this.idFor(request),
      kind: request.kind,
      issueId: request.issueId,
      identifier: request.identifier,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.text ? { text: activationText(request.text) } : {}),
      ...(request.label ? { label: request.label } : {}),
      ...(request.strictResume ? { strictResume: true } : {}),
      ...(request.resume ? { resume: request.resume } : {}),
      host: this.host,
      requestedAt: new Date(this.now()).toISOString(),
    };
    await this.accept(envelope);
    return { peer: claim.host || this.host };
  }

  // A message for this host's live agent on the ticket. `receipt` is the sender's stable id for
  // this message: a delivery that was answered too late to be read is not delivered twice. The
  // receipt is written only after the message went out, so a crash in between repeats the message
  // (at-least-once) instead of losing it.
  async deliverLocal(issueId: string, text: string, receipt?: string): Promise<{ ok: boolean; reason?: string; duplicate?: boolean }> {
    if (receipt && (await this.claimsFile.load()).receipts[receipt]) return { ok: true, duplicate: true };
    const paseo = this.deps.paseo();
    if (!paseo) return { ok: false, reason: "Paseo is not connected on this host." };
    const agent = await this.liveAgent(paseo, issueId);
    if (!agent) return { ok: false, reason: "No agent of this host is working on the ticket." };
    const deliver = this.deps.deliver ?? deliverToAgent;
    try {
      await deliver(paseo, agent.id, text);
    } catch (error) {
      return { ok: false, reason: reason(error) };
    }
    if (receipt) {
      const at = new Date(this.now()).toISOString();
      await this.claimsFile.update((file) => {
        file.receipts[receipt] = at;
        for (const [id, written] of Object.entries(file.receipts)) if (this.now() - Date.parse(written) > RECEIPT_KEEP_MS) delete file.receipts[id];
      });
    }
    return { ok: true };
  }

  async status(): Promise<IntakeStatus> {
    const { mode, peer } = (await this.deps.settings.read()).activation;
    const claims = await this.claimsFile.load();
    const entries = Object.values((await this.pendingFile.load()).entries);
    return {
      mode, peer, host: this.host,
      claims: Object.keys(claims.claims).length,
      revision: claims.revision,
      appliedAt: claims.appliedAt || null,
      pending: entries.filter((entry) => entry.state === "pending").length,
      handoffs: entries.filter((entry) => entry.state === "handoff").length,
      done: entries.filter((entry) => entry.state === "done").length,
    };
  }

  // Retries the activations that are still waiting: their ticket's owner may have finished, an
  // admission reason (blockers, a slot, the memory lease) may be gone, or the peer may be back.
  async retry(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.now();
      for (const entry of Object.values((await this.pendingFile.load()).entries)) {
        if (entry.state === "done") continue;
        if (entry.retryAt && Date.parse(entry.retryAt) > now) continue;
        await this.process(entry);
      }
    } catch (error) {
      this.log(`activation routing: retrying pending activations failed: ${reason(error)}`);
    } finally { this.sweeping = false; }
  }

  // --- internals ---

  // One activation is processed once at a time: a forward that arrives while its predecessor is
  // still being handled (a retried POST, the sweep, the background kick) joins the same run.
  private process(entry: PendingEntry): Promise<PendingEntry> {
    const running = this.inFlight.get(entry.envelope.id);
    if (running) return running;
    const run = this.processNow(entry).finally(() => this.inFlight.delete(entry.envelope.id));
    this.inFlight.set(entry.envelope.id, run);
    return run;
  }

  private kick(id: string): void {
    this.background = this.background.then(async () => {
      const entry = (await this.pendingFile.load()).entries[id];
      if (entry) await this.process(entry);
    }).catch((error: unknown) => {
      this.log(`activation routing: processing ${id} failed (kept, retried every sweep): ${reason(error)}`);
    });
  }

  // Resolves once the processing `accept` and the sweep kicked off has finished (the tests and a
  // shutdown read this; the wire never waits for it).
  async idle(): Promise<void> {
    await this.background;
    await Promise.all([...this.inFlight.values()]);
  }

  private idFor(request: ActivationRequest): string {
    if (request.kind === "session") return request.sessionId ? `session:${request.sessionId}` : `start:${request.issueId}`;
    if (request.kind === "reply") return request.activityId ? `activity:${request.activityId}` : `reply:${request.sessionId ?? request.issueId}:${request.text ?? ""}`;
    if (request.kind === "ticket") return `label:${request.issueId}:${(request.label ?? "").toLowerCase()}`;
    return recoverActivationId(request.issueId, request.resume?.branch ?? "unknown", request.text ?? "");
  }

  private prune(file: PendingFile): void {
    for (const [id, entry] of Object.entries(file.entries)) {
      if (entry.state === "done" && this.now() - Date.parse(entry.updatedAt) > TOMBSTONE_KEEP_MS) delete file.entries[id];
    }
    const ids = Object.keys(file.entries);
    if (ids.length <= MAX_PENDING_ENTRIES) return;
    for (const id of ids.slice(0, ids.length - MAX_PENDING_ENTRIES)) {
      if (file.entries[id].state === "done") delete file.entries[id];
    }
  }

  private async settle(id: string, state: PendingState, note: string | null, retryInMinutes = 0): Promise<void> {
    await this.pendingFile.update((file) => {
      const entry = file.entries[id];
      if (!entry) return;
      entry.state = state;
      entry.note = note;
      entry.attempts += 1;
      entry.updatedAt = new Date(this.now()).toISOString();
      entry.retryAt = retryInMinutes > 0 ? new Date(this.now() + retryInMinutes * 60_000).toISOString() : "";
    });
  }

  private minutesToWait(attempts: number): number {
    return Math.min(RETRY_CAP_MINUTES, Math.max(1, 2 ** Math.min(attempts, 4)));
  }

  // What one activation comes to. Order: the handshake, the draining host's claim (fail closed),
  // a live agent of this host (hand the message over), admission, then the normal start. Anything
  // left waiting keeps its record and is retried.
  private async processNow(entry: PendingEntry): Promise<PendingEntry> {
    const envelope = entry.envelope;
    const reload = async () => (await this.pendingFile.load()).entries[envelope.id] ?? entry;
    const paseo = this.deps.paseo();
    if (!paseo) {
      await this.settle(envelope.id, entry.state === "handoff" ? "handoff" : "pending", "Paseo is not connected on this host.", this.minutesToWait(entry.attempts));
      return reload();
    }
    const claims = await this.claimsFile.load();
    if (!claims.appliedAt && (await this.deps.settings.read()).activation.peer) {
      await this.settle(envelope.id, "pending", "The other host has not registered the agents it keeps yet.", this.minutesToWait(entry.attempts));
      return reload();
    }
    const claim = claims.claims[envelope.issueId];
    if (claim) {
      if (!envelope.text) {
        await this.settle(envelope.id, "pending", `Owned by ${claim.host} (${claim.identifier}); it starts here once that agent is done.`, this.minutesToWait(entry.attempts));
        return reload();
      }
      const delivery = await this.deliverToPeer(claim, envelope);
      await this.settle(envelope.id, delivery.ok ? "done" : "pending", delivery.ok ? `Delivered to the agent on ${claim.host}.` : `Owned by ${claim.host}: ${delivery.reason}`, delivery.ok ? 0 : this.minutesToWait(entry.attempts));
      return reload();
    }
    // A read that fails is not "no agent": the activation waits instead of starting beside one.
    let local: PaseoAgent | null;
    try { local = await this.liveAgent(paseo, envelope.issueId); }
    catch (error) {
      await this.settle(envelope.id, "pending", `Whether an agent already works on the ticket could not be read: ${reason(error)}`, this.minutesToWait(entry.attempts));
      return reload();
    }
    if (local) {
      if (envelope.text) {
        const deliver = this.deps.deliver ?? deliverToAgent;
        try {
          await deliver(paseo, local.id, envelope.text);
          await this.settle(envelope.id, "done", `Delivered to the agent working on the ticket (${local.id.slice(0, 8)}).`);
        } catch (error) {
          await this.settle(envelope.id, "pending", `The agent working on the ticket could not take the message: ${reason(error)}`, this.minutesToWait(entry.attempts));
        }
      } else {
        await this.settle(envelope.id, "done", `An agent already works on the ticket (${local.id.slice(0, 8)}).`);
      }
      return reload();
    }
    const settings = await this.deps.settings.read();
    if (settings.activation.mode === "remote") {
      await this.settle(envelope.id, "pending", "This host is draining; nothing starts here.", this.minutesToWait(entry.attempts));
      return reload();
    }
    const gate = this.deps.launcher?.()?.gate(envelope.issueId) ?? null;
    if (!gate) {
      await this.settle(envelope.id, "pending", "Another launch for this ticket is under way.", this.minutesToWait(entry.attempts));
      return reload();
    }
    try {
      const starter = this.deps.starter?.();
      if (!starter) {
        await this.settle(envelope.id, "pending", "Paseo is not connected on this host.", this.minutesToWait(entry.attempts));
        return reload();
      }
      const admission = await starter.admission(envelope.issueId, paseo, settings);
      if (!admission.ok) {
        await this.settle(envelope.id, "pending", admission.reason, this.minutesToWait(entry.attempts));
        return reload();
      }
      // A label activation claims the trigger label the same way auto-dispatch does, so a later
      // poll -- here or on the draining host -- does not ask for it again.
      const labels = dispatchLabels(settings.dispatch.label);
      const trigger = envelope.label ?? settings.dispatch.label;
      const linear = this.deps.linear?.();
      if (envelope.kind === "ticket" && linear) await linear.removeLabel(envelope.issueId, trigger).catch(() => {});
      if (envelope.kind === "ticket" && linear) await linear.addLabel(envelope.issueId, labels.running).catch(() => {});
      let started: Started;
      try {
        started = await starter.start(envelope.issueId, paseo, settings, {
          retryHint: `${envelope.host} forwarded it again, or assign Paseo on the ticket here`,
          ...(envelope.strictResume ? { resumeOnly: true } : {}),
          ...(envelope.resume ? { resume: envelope.resume } : {}),
          ...(envelope.text ? { lead: envelope.text } : {}),
        });
      } catch (error) {
        if (envelope.kind === "ticket" && linear) await linear.removeLabel(envelope.issueId, labels.running).catch(() => {});
        throw error;
      }
      await this.openNativeThread(envelope, started);
      if (envelope.kind === "ticket" && linear && !started.warnings.length) {
        await linear.comment(envelope.issueId, `Paseo started an agent for this ticket on ${this.host} (${started.provider} in ${started.target})${started.resumed ? ", resuming the recorded work" : ""}.`).catch(() => {});
      }
      await this.settle(envelope.id, "done", `Started ${started.agentId.slice(0, 8)} in ${started.target}${started.resumed ? " (resumed)" : ""}.`);
    } catch (error) {
      if (error instanceof ResumeUnavailableError) {
        await this.reportHandoff(envelope, error.message, entry);
        await this.settle(envelope.id, "handoff", `${error.message} Queued for the owner to make the branch available here.`, this.minutesToWait(entry.attempts + 2));
      } else {
        await this.settle(envelope.id, "pending", reason(error), this.minutesToWait(entry.attempts));
        this.log(`activation routing: starting ${envelope.identifier} for ${envelope.id} failed (kept, retried): ${reason(error)}`);
      }
    } finally { gate.release(); }
    return reload();
  }

  // The agent this host started for a forwarded activation gets a thread of its own here, so the
  // owner's later replies, questions and approvals reach it through this host's normal paths. The
  // session id the draining host used for the same ticket is never applied here: this host opens
  // its own thread for its own app. Best effort -- the agent runs either way.
  private async openNativeThread(envelope: ActivationEnvelope, started: Started): Promise<void> {
    const sessions = this.deps.sessions?.();
    if (!sessions) return;
    try {
      await sessions.openFor(envelope.issueId, envelope.identifier, started.agentId);
    } catch (error) {
      this.log(`activation routing: opening a thread for ${envelope.identifier} here failed (best effort): ${reason(error)}`);
    }
  }

  // Delivers a claimed ticket's message to the agent that owns it on the draining host. The
  // activation id is the delivery's receipt, so a lost answer does not deliver it twice.
  private async deliverToPeer(claim: Claim, envelope: ActivationEnvelope): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { peer } = (await this.deps.settings.read()).activation;
    const secret = await readActivationSecret();
    if (!peer || !secret) return { ok: false, reason: "no peer origin or shared secret is configured" };
    try {
      await postToPeer(this.request, peer, "/activation/deliver", secret, { issueId: claim.issueId, text: envelope.text ?? "", receipt: envelope.id });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reason(error) };
    }
  }

  // A successor that cannot continue the recorded branch is not replaced by a fresh one: the ask
  // is queued (durably) and the ticket says what must happen for it to run here.
  private async reportHandoff(envelope: ActivationEnvelope, reasonText: string, entry: PendingEntry): Promise<void> {
    if (entry.commented || !envelope.text) return;
    const linear = this.deps.linear?.();
    if (!linear) return;
    const branch = envelope.resume?.branch ? `\`${envelope.resume.branch}\`` : "the recorded branch";
    const links = envelope.resume?.handover?.split("\n").filter((line) => /^https?:\/\//.test(line.trim())).slice(0, 3) ?? [];
    const note = [
      `Paseo Server queued the work for this ticket: the branch ${branch} the previous agent recorded cannot be continued here (${reasonText}).`,
      `Nothing was started on a fresh branch, so the previous agent's work is not lost. Push or fetch ${branch} here, then the queued request runs on it.`,
      ...(links.length ? [`Recorded links:\n${links.join("\n")}`] : []),
    ].join("\n\n").slice(0, HANDFOFF_NOTE_LIMIT);
    await linear.comment(envelope.issueId, note).catch((error: unknown) => {
      this.log(`activation routing: reporting the queued handoff for ${envelope.identifier} failed: ${reason(error)}`);
    });
    await this.pendingFile.update((file) => { const known = file.entries[envelope.id]; if (known) known.commented = true; });
  }

  // The newest root agent of the ticket that is working (or waiting for the owner) here. An agent
  // whose thread was closed but whose process still runs counts: it may be a root from before the
  // cutover, and starting beside it would duplicate it.
  private async liveAgent(paseo: PaseoApi, issueId: string): Promise<PaseoAgent | null> {
    const page = await paseo.agents.list({ filter: { labels: { "linear.issueId": issueId }, includeArchived: false }, page: { limit: 200 } });
    const candidates = page.entries.map((entry) => entry.agent).filter((agent) => !agent.labels?.["paseo.parent-agent-id"] && LIVE_AGENT[agent.status])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const agent of candidates) {
      const link = await this.deps.sessionFor?.(agent.id).catch(() => null);
      if (!link?.closed) return agent;
    }
    return candidates[0] ?? null;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
