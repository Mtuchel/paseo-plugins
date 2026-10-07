import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { ghostAgents, type ProcessInspector } from "./process-liveness";
import type { Settings } from "./settings";
import { deliverToAgent } from "./relay";
import { PermissionReplies, type DeliveryOrigin, type DeliveryResult } from "./permission-replies";
import {
  activationDirectory,
  activationEnvelopeSchema,
  activationText,
  JsonFile,
  postToPeer,
  readActivationSecret,
  recoverActivationId,
  type ActivationEnvelope,
  type ActivationRequest,
  type ActivationResume,
  type ActivationSink,
  type ActivationTake,
  type RequestLike,
} from "./activation";

const SWEEP_MS = 60_000;
const RECEIPT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OUTBOX_ENTRIES = 500;
export const MAX_ALLOWLIST_AGENTS = 500;
// The owner's initializer for a cutover (README, "Draining a host"): the exact roots that keep
// working on this host, for when the daemon's own list cannot be trusted (persisted snapshots of
// agents that are really gone) or the owner wants to pin the set. Read only while the allowlist
// is seeded; never written.
export const SEED_FILE = "activation-allowlist-seed.json";
// Linear status types (issueState.statusType) that mean the ticket is finished: a root may no
// longer keep owning it, and the peer starts whatever comes next for it.
const FINISHED_TICKET = new Set(["completed", "canceled"]);
// The daemon states of a root that may still own its ticket here: the turn-ended and
// process-closed ones included. Paseo closes an agent that idles too long, and a root that merely
// ended its turn or was closed while it waits for the next one is exactly the grandfathered case
// (its thread is open, its ticket is open): it must not be retired, and no duplicate may start on
// the peer. Only an archived agent, one in error, a ghost (idle or running without a process), a
// closed thread or a finished ticket retires it.
export const OWNED_AGENT: Record<string, true> = { initializing: true, idle: true, running: true, closed: true };

type SeedEntry = { agentId: string; issueId: string; identifier: string };

// The initializer's schema: `{ "agents": [ { "agentId", "issueId", "identifier" } ] }`, also
// accepted as an object keyed by agent id. Every entry is checked; the usable ones seed.
export function seedAgentsOf(raw: unknown): { agents: [string, { issueId: string; identifier: string }][]; rejected: number } {
  const value = raw && typeof raw === "object" ? raw as { agents?: unknown } : {};
  const listed: SeedEntry[] = [];
  let rejected = 0;
  const usable = (agentId: unknown, issueId: unknown, identifier: unknown): SeedEntry | null =>
    typeof agentId === "string" && agentId.trim() && agentId.length <= 100 && typeof issueId === "string" && issueId.trim() && issueId.length <= 100 && typeof identifier === "string" && identifier.trim() && identifier.length <= 100
      ? { agentId: agentId.trim(), issueId: issueId.trim(), identifier: identifier.trim() }
      : null;
  if (Array.isArray(value.agents)) {
    for (const entry of value.agents) {
      const candidate = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      const usableEntry = usable(candidate.agentId, candidate.issueId, candidate.identifier);
      if (usableEntry) listed.push(usableEntry);
      else rejected += 1;
    }
  } else if (value.agents && typeof value.agents === "object") {
    for (const [agentId, entry] of Object.entries(value.agents)) {
      const candidate = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      const usableEntry = usable(agentId, candidate.issueId, candidate.identifier);
      if (usableEntry) listed.push(usableEntry);
      else rejected += 1;
    }
  } else {
    return { agents: [], rejected: 0 };
  }
  const agents: [string, { issueId: string; identifier: string }][] = [];
  for (const entry of listed) {
    if (agents.length >= MAX_ALLOWLIST_AGENTS) { rejected += 1; continue; }
    agents.push([entry.agentId, { issueId: entry.issueId, identifier: entry.identifier }]);
  }
  return { agents, rejected };
}

// The agents this host may keep running while it drains: the roots that were working (or waiting
// for the owner) when the drain was seeded. It is taken once, persisted and never extended: a
// reload keeps the same agents, and no agent started later is ever enrolled. Deleting the file
// (while this host is not draining) makes the next load seed again.
type Allowlist = {
  version: 1;
  host: string;
  // New when the allowlist is seeded again, so a restarted revision counter is not read as stale.
  seed: string;
  seededAt: string;
  // How the seed was taken: the owner's initializer file, or this host's own daemon. Empty while
  // the host has not seeded yet: then nothing is forwarded (`take`), and the seeding is retried.
  seedSource: "file" | "daemon" | "";
  // Initializer entries that were not usable (the rest seeded regardless), for the health answer.
  seedRejected: number;
  agents: Record<string, { issueId: string; identifier: string }>;
  // Bumped whenever the live claim set changes; the peer applies a snapshot only for a newer one.
  revision: number;
  sentRevision: number;
  ackedRevision: number;
  sentDigest: string | null;
  // The last registered claim set: kept when a drain cannot read its daemon, so the peer keeps
  // failing closed rather than treating those tickets as free.
  sentClaims: { issueId: string; identifier: string; agentId: string }[];
  // Delivery receipts (the peer's activation ids): a delivery that was answered too late to be
  // read is not repeated into the agent.
  receipts: Record<string, string>;
};

// The forwarding queue and the label occurrences it knows about: a label has no immutable source
// id, so the id minted when it was first taken is reused for every retry of that activation and
// forgotten once the peer acknowledged it -- a label added again later is a new occurrence and a
// new activation, while a repeated poll of the same one never starts twice.
type Outbox = {
  version: 1;
  entries: Record<string, { envelope: ActivationEnvelope; attempts: number; lastError: string | null; at: string }>;
  occurrences: Record<string, { id: string; at: string }>;
};

export type DrainStatus = {
  mode: "local" | "remote";
  peer: string | null;
  host: string;
  seededAt: string | null;
  seedSource: "file" | "daemon" | null;
  seedRejected: number;
  agents: number;
  claims: number;
  revision: number;
  ackedRevision: number;
  outbox: number;
};

export type DrainDeps = {
  settings: Pick<Settings, "read">;
  paseo: () => PaseoApi | null;
  // The newest Linear thread of an agent, to retire an agent whose thread was closed.
  sessionFor?: (agentId: string) => Promise<{ closed?: boolean } | null>;
  // The ticket's Linear state, to retire a finished ticket (done or canceled). Unread or missing
  // reads keep the agent: only a finished ticket retires it.
  ticketState?: (issueId: string) => Promise<{ statusType: string } | null>;
  deliver?: (paseo: PaseoApi, agentId: string, message: string, origin: DeliveryOrigin, replies: PermissionReplies) => Promise<DeliveryResult>;
  replies?: PermissionReplies;
  request?: RequestLike;
  home?: string;
  host?: string;
  now?: () => number;
  log?: (message: string) => void;
  // The process check that keeps a dead agent (a ghost) from owning its tickets; injectable.
  ghosts?: (agents: PaseoAgent[], now: number) => Promise<Set<string>>;
  processInspector?: ProcessInspector;
  sweepMs?: number;
  // The ticket's watchdog history travels with every forwarded activation, and a forwarded ticket
  // is no longer this host's to recover (watchdog.ts).
  watchdog?: { history(issueId: string, now: number): Promise<unknown>; transferred(issueId: string, identifier: string): Promise<void> };
  // The source's handover snapshot for a strict resume (handover.ts resumeSnapshot): the
  // recorded branch, its exact commit, the dirty state and the handover text, never the worktree
  // path. A missing or unreadable snapshot is left out; the receiving host then holds the
  // activation instead of continuing on a fresh branch.
  handover?: { resumeSnapshot(issueId: string): Promise<ActivationResume | null> };
};

function allowlistFrom(raw: unknown): Allowlist {
  const value = raw && typeof raw === "object" ? raw as Partial<Allowlist> : {};
  const agents: Allowlist["agents"] = {};
  if (value.agents && typeof value.agents === "object" && !Array.isArray(value.agents)) {
    for (const [agentId, entry] of Object.entries(value.agents)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const candidate = entry as { issueId?: unknown; identifier?: unknown };
      if (typeof candidate.issueId !== "string" || typeof candidate.identifier !== "string") continue;
      agents[agentId] = { issueId: candidate.issueId, identifier: candidate.identifier };
    }
  }
  return {
    version: 1,
    host: typeof value.host === "string" ? value.host : "",
    seed: typeof value.seed === "string" ? value.seed : randomUUID(),
    seededAt: typeof value.seededAt === "string" ? value.seededAt : "",
    seedSource: value.seedSource === "file" || value.seedSource === "daemon" ? value.seedSource : "",
    seedRejected: typeof value.seedRejected === "number" && Number.isInteger(value.seedRejected) && value.seedRejected > 0 ? value.seedRejected : 0,
    agents,
    revision: typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision > 0 ? value.revision : 0,
    sentRevision: typeof value.sentRevision === "number" ? value.sentRevision : 0,
    ackedRevision: typeof value.ackedRevision === "number" ? value.ackedRevision : 0,
    sentDigest: typeof value.sentDigest === "string" ? value.sentDigest : null,
    sentClaims: Array.isArray(value.sentClaims) ? value.sentClaims.flatMap((claim) => {
      if (!claim || typeof claim !== "object") return [];
      const { issueId, identifier, agentId } = claim;
      return typeof issueId === "string" && typeof identifier === "string" && typeof agentId === "string" ? [{ issueId, identifier, agentId }] : [];
    }) : [],
    receipts: value.receipts && typeof value.receipts === "object" && !Array.isArray(value.receipts)
      ? Object.fromEntries(Object.entries(value.receipts).filter(([, at]) => typeof at === "string")) as Record<string, string>
      : {},
  };
}

function outboxFrom(raw: unknown): Outbox {
  const value = raw && typeof raw === "object" ? raw as Partial<Outbox> : {};
  const entries = value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) ? value.entries : {};
  const parsed: Outbox["entries"] = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as { envelope?: unknown; attempts?: unknown; lastError?: unknown; at?: unknown };
    const envelope = activationEnvelopeSchema.safeParse(candidate.envelope);
    if (!envelope.success) continue;
    parsed[id] = { envelope: envelope.data, attempts: typeof candidate.attempts === "number" ? candidate.attempts : 0, lastError: typeof candidate.lastError === "string" ? candidate.lastError : null, at: typeof candidate.at === "string" ? candidate.at : envelope.data.requestedAt };
  }
  const occurrences: Outbox["occurrences"] = {};
  if (value.occurrences && typeof value.occurrences === "object" && !Array.isArray(value.occurrences)) {
    for (const [key, entry] of Object.entries(value.occurrences)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const candidate = entry as { id?: unknown; at?: unknown };
      if (typeof candidate.id === "string" && candidate.id) occurrences[key] = { id: candidate.id, at: typeof candidate.at === "string" ? candidate.at : "" };
    }
  }
  return { version: 1, entries: parsed, occurrences };
}

function claimDigest(claims: { issueId: string; identifier: string; agentId: string }[]): string {
  return JSON.stringify([...claims].sort((a, b) => a.issueId.localeCompare(b.issueId)));
}

// The draining host of a two-host cutover (README, "Draining a host"). It owns the Linear app,
// the threads and the grandfathered agents; everything else is forwarded to the peer and never
// started locally. Its decisions never depend on the peer being reachable: an unreachable peer
// only grows the durable outbox and leaves the claims unsynced (the peer then keeps failing
// closed), while this host starts nothing.
export class DrainRouter implements ActivationSink {
  private readonly home: string;
  private readonly host: string;
  private readonly seedPath: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly request: RequestLike;
  private readonly sweepMs: number;
  private readonly allowlist: JsonFile<Allowlist>;
  private readonly outbox: JsonFile<Outbox>;
  private readonly replies: PermissionReplies;
  private timer: NodeJS.Timeout | null = null;
  private ready: Promise<void> | null = null;
  private sweeping = false;

  constructor(private readonly deps: DrainDeps) {
    this.home = deps.home ?? activationDirectory();
    this.replies = deps.replies ?? new PermissionReplies({ directory: this.home, daemon: async () => null });
    this.host = deps.host ?? "this host";
    this.seedPath = `${this.home}/${SEED_FILE}`;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.log(`[linear-tickets] ${message}`));
    this.request = deps.request ?? (fetch as unknown as RequestLike);
    this.sweepMs = deps.sweepMs ?? SWEEP_MS;
    this.allowlist = new JsonFile(`${this.home}/activation-allowlist.json`, () => allowlistFrom(null), allowlistFrom);
    this.outbox = new JsonFile(`${this.home}/activation-outbox.json`, () => outboxFrom(null), outboxFrom);
  }

  // Seeds (once), registers the claims and flushes the outbox before any routing decision. A
  // failure here is logged and retried by the sweep; it never makes this host start locally.
  start(): void {
    void this.readyNow();
    this.timer ??= setInterval(() => { void this.sweep(); }, this.sweepMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  // Seeds (once), registers the claims and flushes the outbox. A failure is logged and retried by
  // the sweep; it never makes this host start locally.
  async readyNow(): Promise<void> {
    const pending = this.ready ??= this.prepare().catch((error: unknown) => {
      this.log(`activation routing: preparing the drain failed (retried every sweep): ${error instanceof Error ? error.message : error}`);
      this.ready = null;
    });
    await pending;
  }

  private async prepare(): Promise<void> {
    await this.ensureSeeded();
    await this.syncClaims();
    await this.flush();
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.ensureSeeded();
      await this.syncClaims();
      await this.flush();
    } catch (error) {
      this.log(`activation routing: sweeping the drain failed: ${error instanceof Error ? error.message : error}`);
    } finally { this.sweeping = false; }
  }

  // Whether the ticket may stay here: an allowlisted agent that is still working, still connected
  // to a process and not retired (its thread closed on purpose). Null: the activation is remote.
  async ownerFor(issueId: string): Promise<{ id: string; identifier: string } | null> {
    const paseo = this.deps.paseo();
    const allowlist = await this.allowlist.load();
    if (!paseo || !allowlist.seededAt) return null;
    const live = await this.liveAllowlisted(paseo);
    return live.find((entry) => entry.issueId === issueId) ?? null;
  }

  // Forwards one new automatic activation. Null keeps it local (not draining, or an allowed agent
  // still owns the ticket); `{ peer }` hands it over; `{ held }` starts nothing anywhere -- the
  // prompt is durably queued and the sweep retries it. Nothing is ever decided on an unreadable
  // state: until this host has read the agents it keeps and the peer has acknowledged that
  // snapshot, no activation is forwarded (the peer would start beside a root it knows nothing
  // about) and none is started here either.
  async take(request: ActivationRequest): Promise<ActivationTake> {
    const { mode, peer } = (await this.deps.settings.read()).activation;
    if (mode !== "remote" || !peer) return null;
    await this.readyNow();
    // A prepare that ran before this host could read its daemon (or while the initializer was
    // being fixed) seeds nothing; the question is retried here so a host that just came up can
    // route as soon as it can read its agents -- and holds the activation until then.
    if (!(await this.allowlist.load()).seededAt) await this.sweep();
    // Ownership first: an allowed agent that still owns the ticket keeps it here, whatever the
    // peer knows and however long the handshake takes. A read that fails decides nothing.
    let owner: { id: string; identifier: string } | null = null;
    let ownershipError: string | null = null;
    try { owner = await this.ownerFor(request.issueId); }
    catch (error) { ownershipError = this.reason(error); }
    if (owner) return null;
    // Everything that cannot be forwarded right now is written down first, so the prompt is never
    // lost and the sweep picks it up. The queue is never pruned: an unacknowledged activation is
    // the only copy of the owner's prompt.
    const envelope = await this.envelope(request);
    let crossedCap = false;
    await this.outbox.update((outbox) => {
      const before = Object.keys(outbox.entries).length;
      outbox.entries[envelope.id] = { envelope, attempts: outbox.entries[envelope.id]?.attempts ?? 0, lastError: null, at: new Date(this.now()).toISOString() };
      crossedCap = before <= MAX_OUTBOX_ENTRIES && Object.keys(outbox.entries).length > MAX_OUTBOX_ENTRIES;
    });
    if (crossedCap) this.log(`activation routing: more than ${MAX_OUTBOX_ENTRIES} activations wait for ${this.peerLabel(peer)} (nothing is dropped; they are forwarded in order)`);
    if (ownershipError) return { held: `whether this host still owns the ticket could not be read (${ownershipError}); nothing was started and the ticket is queued` };
    // The work goes to the peer: this host's watchdog stops recovering the ticket's older roots. A
    // failure is logged; the ticket's agents here are then still judged, as before the forward.
    await this.deps.watchdog?.transferred(request.issueId, request.identifier).catch((error: unknown) => this.log(`activation routing: recording ${request.identifier} as handed over for the watchdog failed: ${this.reason(error)}`));
    let state: { ok: true } | { ok: false; reason: string };
    try { state = await this.routable(); }
    catch (error) { state = { ok: false, reason: `this host's own state is unreadable (${this.reason(error)})` }; }
    if (!state.ok) return { held: `${state.reason}; nothing was started and the ticket is queued` };
    await this.flush();
    return { peer: this.peerLabel(peer) };
  }

  // Whether this host may forward at all: it has read the agents it keeps, the claim snapshot for
  // them was registered and the peer acknowledged that exact revision. An empty snapshot is a
  // valid one (nothing is grandfathered), so the handshake is the same either way.
  private async routable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const allowlist = await this.allowlist.load();
    if (!allowlist.seededAt) return { ok: false, reason: "this host has not read the agents it keeps yet" };
    if (allowlist.sentRevision < 1 || allowlist.ackedRevision < allowlist.sentRevision) return { ok: false, reason: "the other host has not acknowledged this host's agents yet" };
    return { ok: true };
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // Delivers a peer's message to the allowlisted agent that still owns the ticket (the peer calls
  // this only for a ticket it has a claim for). No owner: 409, and the peer keeps its work pending.
  // The shared reply ledger reserves the activation before routing/sending. A failed receipt
  // write can replay the outcome, but cannot deliver into a newer permission request.
  async deliver(issueId: string, text: string, receipt?: string): Promise<{ ok: boolean; reason?: string; duplicate?: boolean }> {
    if (receipt && (await this.allowlist.load()).receipts[receipt]) return { ok: true, duplicate: true };
    const paseo = this.deps.paseo();
    if (!paseo) return { ok: false, reason: "Paseo is not connected on this host." };
    const owner = await this.ownerFor(issueId);
    if (!owner) return { ok: false, reason: "No agent of this host still owns the ticket." };
    const deliver = this.deps.deliver ?? deliverToAgent;
    try {
      const ref = `activation:${receipt ?? createHash("sha256").update(`${issueId}:${text}`).digest("hex").slice(0, 16)}`;
      const origin: DeliveryOrigin = { ref, responder: { kind: "linear-unverified", via: "activation", ref }, issueId };
      const result = await deliver(paseo, owner.id, text, origin, this.replies);
      if (!result.delivered) return { ok: false, reason: result.reply ?? "The message was not delivered." };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "unknown error" };
    }
    if (receipt) {
      const at = new Date(this.now()).toISOString();
      await this.allowlist.update((file) => {
        file.receipts[receipt] = at;
        for (const [id, written] of Object.entries(file.receipts)) if (this.now() - Date.parse(written) > RECEIPT_KEEP_MS) delete file.receipts[id];
      });
    }
    return { ok: true };
  }

  async status(): Promise<DrainStatus> {
    const { mode, peer } = (await this.deps.settings.read()).activation;
    const allowlist = await this.allowlist.load();
    const outbox = await this.outbox.load();
    return {
      mode, peer, host: this.host,
      seededAt: allowlist.seededAt || null,
      seedSource: allowlist.seedSource || null,
      seedRejected: allowlist.seedRejected,
      agents: Object.keys(allowlist.agents).length,
      claims: (await this.claims()).length,
      revision: allowlist.revision,
      ackedRevision: allowlist.ackedRevision,
      outbox: Object.keys(outbox.entries).length,
    };
  }

  // --- internals ---

  private peerLabel(peer: string): string {
    try { return new URL(peer).hostname.split(".")[0]; } catch { return peer; }
  }

  private async envelope(request: ActivationRequest): Promise<ActivationEnvelope> {
    const text = activationText(request.text);
    const id = request.id ?? await this.idFor(request);
    // An unreadable history is left out: the receiving host then holds recovery for a day rather
    // than starting with a fresh budget.
    const watchdog = request.watchdog ?? await this.deps.watchdog?.history(request.issueId, this.now()).catch(() => undefined);
    // A strict resume continues the recorded work on the peer, so the source's handover snapshot
    // rides with it (handover.ts): the recorded branch, its exact commit and dirty state, never the
    // worktree path. Missing or unreadable metadata is left out like the history -- the peer holds
    // the activation (its own record, if any, is not the work that was handed over) rather than
    // continuing on a guess.
    const resume = request.resume ?? (request.strictResume ? await this.deps.handover?.resumeSnapshot(request.issueId).catch(() => undefined) : undefined);
    return {
      id,
      kind: request.kind,
      issueId: request.issueId,
      identifier: request.identifier,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(text ? { text } : {}),
      ...(request.label ? { label: request.label } : {}),
      ...(request.strictResume ? { strictResume: true } : {}),
      ...(resume ? { resume } : {}),
      ...(watchdog ? { watchdog } : {}),
      host: this.host,
      requestedAt: new Date(this.now()).toISOString(),
    };
  }

  private async idFor(request: ActivationRequest): Promise<string> {
    if (request.kind === "reply") {
      return request.activityId ? `activity:${request.activityId}` : `reply:${request.sessionId ?? request.issueId}:${createHash("sha256").update(request.text ?? "").digest("hex").slice(0, 16)}`;
    }
    if (request.kind === "session") return request.sessionId ? `session:${request.sessionId}` : `start:${request.issueId}`;
    if (request.kind === "ticket") {
      const key = `${request.issueId}:${(request.label ?? "").toLowerCase()}`;
      let id = "";
      await this.outbox.update((outbox) => {
        id = outbox.occurrences[key]?.id ?? `label:${request.issueId}:${(request.label ?? "").toLowerCase()}:${randomUUID().slice(0, 8)}`;
        outbox.occurrences[key] = { id, at: new Date(this.now()).toISOString() };
      });
      return id;
    }
    return recoverActivationId(request.issueId, request.resume?.branch ?? "unknown", request.text ?? "");
  }

  // Seeds once: from the owner's initializer file when it exists, else from this host's own
  // daemon -- the roots working or waiting for the owner at that moment, never the idle finished
  // ones, and never an agent without a process. An initializer that exists but cannot be used
  // seeds nothing -- and is never silently replaced by the daemon's list -- so the host keeps new
  // work local (`take`) until it is fixed.
  private async ensureSeeded(): Promise<Allowlist> {
    const allowlist = await this.allowlist.load();
    const { mode } = (await this.deps.settings.read()).activation;
    if (mode !== "remote" || allowlist.seededAt) return allowlist;
    const file = await this.readSeedFile();
    let seeds: [string, { issueId: string; identifier: string }][];
    let source: "file" | "daemon";
    let rejected = 0;
    if (file) {
      if (!file.usable) {
        this.log(`activation routing: ${SEED_FILE} exists but was not usable (${file.reason}); nothing is seeded, and this host keeps new work local until it is fixed`);
        return allowlist;
      }
      seeds = file.agents;
      rejected = file.rejected;
      source = "file";
    } else {
      const paseo = this.deps.paseo();
      if (!paseo) return allowlist;
      seeds = await this.seedCandidates(paseo);
      source = "daemon";
    }
    const seeded = await this.allowlist.update((current) => {
      if (current.seededAt) return;
      current.host = this.host;
      current.seed = randomUUID();
      current.seededAt = new Date(this.now()).toISOString();
      current.seedSource = source;
      current.seedRejected = rejected;
      current.agents = Object.fromEntries(seeds);
      current.revision = Math.max(1, current.revision + 1);
    });
    this.log(`activation routing: seeded ${Object.keys(seeded.agents).length} agent(s) from the ${source === "file" ? SEED_FILE : "daemon"}${rejected ? `, ${rejected} entr${rejected === 1 ? "y" : "ies"} rejected` : ""}`);
    return seeded;
  }

  // The initializer (`{ "agents": [ { "agentId", "issueId", "identifier" } ] }`, also an object
  // keyed by agent id). Absent: seed from the daemon. Present: `agents` must be a list or object
  // -- an empty one seeds an empty allowlist on purpose -- and at least one entry must be usable,
  // so a mistyped file cannot quietly turn into "nothing is grandfathered".
  private async readSeedFile(): Promise<{ usable: true; agents: [string, { issueId: string; identifier: string }][]; rejected: number } | { usable: false; reason: string } | null> {
    let text: string;
    try {
      text = await readFile(this.seedPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { usable: false, reason: error instanceof Error ? error.message : "it could not be read" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { usable: false, reason: "it is not JSON" };
    }
    const shape = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { agents?: unknown }).agents : undefined;
    if (!Array.isArray(shape) && !(shape && typeof shape === "object")) return { usable: false, reason: "it has no agents list" };
    const parsed = seedAgentsOf(raw);
    if (!parsed.agents.length && parsed.rejected > 0) return { usable: false, reason: `every one of its ${parsed.rejected} entr${parsed.rejected === 1 ? "y" : "ies"} was rejected` };
    return { usable: true, agents: parsed.agents, rejected: parsed.rejected };
  }

  private async seedCandidates(paseo: PaseoApi): Promise<[string, { issueId: string; identifier: string }][]> {
    const candidates: PaseoAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) {
        const issueId = agent.labels?.["linear.issueId"];
        if (!issueId || agent.labels?.["paseo.parent-agent-id"]) continue;
        // Every root with a ticket is seeded, whatever its daemon state: whether it still owns its
        // ticket is decided when a decision is made (liveAllowlisted), so a root that merely ended
        // a turn or had its process closed while it waits cannot be replaced by a duplicate.
        candidates.push(agent);
      }
      cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    const ghosts = await this.ghostSet(candidates);
    const seeds: [string, { issueId: string; identifier: string }][] = [];
    for (const agent of candidates) {
      if (ghosts.has(agent.id)) continue;
      const link = await this.deps.sessionFor?.(agent.id).catch(() => null);
      if (link?.closed) continue;
      seeds.push([agent.id, { issueId: agent.labels!["linear.issueId"], identifier: agent.labels?.["linear.identifier"] ?? agent.labels!["linear.issueId"] }]);
      if (seeds.length >= MAX_ALLOWLIST_AGENTS) break;
    }
    return seeds;
  }

  private async ghostSet(agents: PaseoAgent[]): Promise<Set<string>> {
    if (this.deps.ghosts) return this.deps.ghosts(agents, this.now());
    return ghostAgents(agents, this.now(), this.deps.processInspector);
  }

  // The allowlisted agents that still own their tickets, one per ticket (the newest). The rule is
  // deliberate: a working root keeps its ticket across turns (a turn that ended normally, idle,
  // waiting for its next ticket) and while the owner still has to answer it; it is retired when
  // its ticket is finished (done or canceled), its thread was closed, it is archived or failed,
  // or its process is gone.
  private async liveAllowlisted(paseo: PaseoApi): Promise<{ id: string; issueId: string; identifier: string }[]> {
    const allowlist = await this.allowlist.load();
    const wanted = new Map(Object.entries(allowlist.agents));
    if (!wanted.size) return [];
    const found: PaseoAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) if (wanted.has(agent.id)) found.push(agent);
      cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    const alive = found.filter((agent) => OWNED_AGENT[agent.status]);
    const ghosts = await this.ghostSet(alive);
    const byIssue = new Map<string, { id: string; issueId: string; identifier: string; createdAt: string }>();
    for (const agent of alive) {
      if (ghosts.has(agent.id)) continue;
      const link = await this.deps.sessionFor?.(agent.id).catch(() => null);
      if (link?.closed) continue;
      const entry = wanted.get(agent.id)!;
      const known = byIssue.get(entry.issueId);
      if (!known || agent.createdAt > known.createdAt) byIssue.set(entry.issueId, { id: agent.id, ...entry, createdAt: agent.createdAt });
    }
    const owned = [...byIssue.values()];
    const finished = new Set<string>();
    if (this.deps.ticketState) {
      for (const entry of owned) {
        const state = await this.deps.ticketState(entry.issueId).catch(() => null);
        if (state && FINISHED_TICKET.has(state.statusType)) finished.add(entry.issueId);
      }
    }
    return owned.filter((entry) => !finished.has(entry.issueId)).map(({ createdAt: _createdAt, ...entry }) => entry);
  }

  // The ticket of an agent this host knows, for the resume guard (activation-guard.ts). An entry
  // stays after the agent is retired, so a heartbeat that targets it is still recognized as
  // ticket work and refused here.
  async agentTicket(agentId: string): Promise<{ issueId: string; identifier: string } | null> {
    const entry = (await this.allowlist.load()).agents[agentId];
    return entry ? { ...entry } : null;
  }

  // Whether this host may still run that agent: an allowlisted root whose ticket is still open
  // and whose process still runs. This host not draining keeps everything.
  async holdsAgent(agentId: string): Promise<boolean> {
    if ((await this.deps.settings.read()).activation.mode !== "remote") return true;
    const allowlist = await this.allowlist.load();
    if (!allowlist.seededAt || !allowlist.agents[agentId]) return false;
    const paseo = this.deps.paseo();
    if (!paseo) return false;
    return (await this.liveAllowlisted(paseo)).some((entry) => entry.id === agentId);
  }

  // The claim set to register now: the live allowlisted agents, or the empty set once this host
  // stops draining (a release). Without a daemon to read, the last registered set is kept, so the
  // peer keeps failing closed instead of treating those tickets as free.
  private async claims(): Promise<{ issueId: string; identifier: string; agentId: string }[]> {
    const { mode } = (await this.deps.settings.read()).activation;
    if (mode !== "remote") return [];
    const paseo = this.deps.paseo();
    if (!paseo) return (await this.allowlist.load()).sentClaims;
    return this.liveClaims(paseo);
  }

  private async liveClaims(paseo: PaseoApi): Promise<{ issueId: string; identifier: string; agentId: string }[]> {
    return (await this.liveAllowlisted(paseo)).map(({ issueId, identifier, id }) => ({ issueId, identifier, agentId: id }));
  }

  // Registers the full claim set with the peer, retrying the same revision until it answers.
  private async syncClaims(): Promise<void> {
    const { mode, peer } = (await this.deps.settings.read()).activation;
    const secret = await readActivationSecret();
    if (!peer || !secret) return;
    const allowlist = await this.allowlist.load();
    // A host that has not seeded yet says nothing: an empty snapshot would tell the peer that the
    // tickets of roots it has not read yet are free, and it would start beside them. The peer
    // keeps its last snapshot instead (and fails closed for those tickets).
    if (mode === "remote" && !allowlist.seededAt) return;
    // A host that never registered claims has nothing to release; otherwise the empty set is sent
    // once when it stops draining.
    if (mode !== "remote" && !allowlist.sentDigest) return;
    const claims = await this.claims();
    const digest = claimDigest(claims);
    if (digest !== allowlist.sentDigest) {
      await this.allowlist.update((current) => {
        current.revision += 1;
        current.sentRevision = current.revision;
        current.sentDigest = digest;
        current.sentClaims = claims;
      });
    }
    const current = await this.allowlist.load();
    if (current.ackedRevision >= current.sentRevision && current.sentRevision === current.revision) return;
    try {
      const answer = await postToPeer(this.request, peer, "/activation/claims", secret, {
        host: this.host,
        seed: current.seed,
        revision: current.sentRevision,
        claims,
      });
      const applied = answer && typeof answer === "object" && "revision" in answer && typeof answer.revision === "number" ? answer.revision : current.sentRevision;
      if (applied >= current.sentRevision) await this.allowlist.update((value) => { value.ackedRevision = Math.max(value.ackedRevision, current.sentRevision); });
    } catch (error) {
      this.log(`activation routing: registering ${claims.length} claim(s) with ${this.peerLabel(peer)} failed (retried every sweep): ${error instanceof Error ? error.message : error}`);
    }
  }

  private async flush(): Promise<void> {
    const { peer } = (await this.deps.settings.read()).activation;
    const secret = await readActivationSecret();
    if (!peer || !secret) return;
    if (!(await this.routable()).ok) return;
    const pending = Object.values((await this.outbox.load()).entries).sort((a, b) => a.at.localeCompare(b.at));
    for (const entry of pending) {
      try {
        await postToPeer(this.request, peer, "/activation", secret, entry.envelope);
        await this.outbox.update((outbox) => {
          delete outbox.entries[entry.envelope.id];
          // The occurrence is done once the peer acknowledged it: a label added again later is a
          // new activation, while every retry until then reused this id.
          for (const [key, known] of Object.entries(outbox.occurrences)) if (known.id === entry.envelope.id) delete outbox.occurrences[key];
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.outbox.update((outbox) => {
          const known = outbox.entries[entry.envelope.id];
          if (known) Object.assign(known, { attempts: known.attempts + 1, lastError: message.slice(0, 300) });
        });
        this.log(`activation routing: forwarding ${entry.envelope.id} to ${this.peerLabel(peer)} failed (kept, retried every sweep): ${message}`);
        return;
      }
    }
  }
}
