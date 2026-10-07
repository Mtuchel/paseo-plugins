import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { internalDaemon } from "./connection";
import { fingerprint, type ArbitratedOutcome, type Correction, type CorrectionActivity, type PermissionArbiter } from "./deputy";
import { approvalDecision, questionAnswer } from "./relay";
import { paseoHome } from "./ticket-mcp";

export type DeliveryOrigin = {
  ref: string;
  responder: ({ kind: "owner" } & CorrectionActivity) | { kind: "linear-unverified"; via: string; ref: string };
  issueId?: string;
};
export type BoundAnswer = { requestId: string; request?: AgentPermissionRequest; response?: AgentPermissionResponse };
type Status = "reserved" | "submitted" | "applied" | "rejected" | "owner-first" | "deputy-first" | "gone" | "unconfirmed" | "sent" | "unchecked";
export type DeliveryResult = {
  status: Exclude<Status, "reserved" | "submitted" | "owner-first">;
  reply: string | null;
  delivered: boolean;
  request?: AgentPermissionRequest;
  response?: AgentPermissionResponse;
  at: string;
};
export type ReplyRecord = {
  ref: string;
  kind: "answer" | "message" | "approval";
  agentId: string;
  requestId?: string;
  fingerprint?: string;
  request?: AgentPermissionRequest;
  response?: AgentPermissionResponse;
  text: string;
  at: string;
  responder: DeliveryOrigin["responder"] | { kind: "deputy"; intentId: string };
  issueId?: string;
  status: Status;
  reason?: string;
  deputyIntentId?: string;
  reply?: string;
  correctionDelivered?: boolean;
  effects: { evidence: boolean; correction: boolean; needsYou: boolean };
};
type CheckedClient = { respondToPermissionAndWait(agentId: string, requestId: string, response: AgentPermissionResponse, timeout: number): Promise<unknown> };
type Effects = {
  ownerAnswered(agentId: string, request: AgentPermissionRequest, response: AgentPermissionResponse, activity: CorrectionActivity, at: string): Promise<void>;
  correctLate(agentId: string, requestId: string, text: string, activity: CorrectionActivity): Promise<Correction>;
  needsYou(agentId: string, issueId?: string): Promise<void>;
};
type Deps = { directory?: string; daemon?: () => Promise<CheckedClient | null>; now?: () => number; beforeSubmit?: (record: ReplyRecord) => Promise<void> };
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const NOT_DELIVERED = "Your answer was not delivered: the question was no longer waiting, or Paseo was already processing another answer to it.";
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const unconfirmed = (reason: string) => `Paseo could not confirm that your answer reached the agent: ${reason}. It is not sent again; check the agent.`;

// Only the daemon's known pre-application errors prove rejection. Handler failures elsewhere,
// including persisting the snapshot after application, cannot prove that nothing happened.
export function rejectedBeforeApplication(error: unknown, requestId: string): boolean {
  const message = reasonOf(error).replace(/^Request failed: /, "").replace(/ requestType=agent_permission_response(?: code=handler_error)?$/, "");
  return message === "A response to this permission request is already being submitted"
    || message === `No pending permission request with id '${requestId}'`
    || message === `No pending Codex app-server permission request with id '${requestId}'`;
}

// A plugin-local, durable submission boundary. Each activity is reserved before routing and each
// question has one send lane. No recorded activity or interrupted submission is ever sent again.
export class PermissionReplies implements PermissionArbiter {
  private readonly directory: string;
  private readonly daemon: () => Promise<CheckedClient | null>;
  private readonly now: () => number;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private readonly flights = new Map<string, Promise<ReplyRecord>>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly owners = new Map<string, number>();
  private readonly holds = new Set<string>();
  private effects: Effects | null = null;
  private stopped = false;

  constructor(private readonly deps: Deps = {}) {
    this.directory = deps.directory ?? join(paseoHome(), "linear-tickets");
    this.daemon = deps.daemon ?? internalDaemon;
    this.now = deps.now ?? Date.now;
  }
  recordEffects(effects: Effects): void { this.effects = effects; }
  stop(): void { this.stopped = true; }
  holdForOwner(agentId: string, requestId: string): void { this.holds.add(`${agentId}:${requestId}`); }
  releaseOwner(agentId: string, requestId: string): void { this.holds.delete(`${agentId}:${requestId}`); }
  async available(): Promise<PermissionArbiter | null> { return !this.stopped && await this.daemon() ? this : null; }

  private get path(): string { return join(this.directory, "permission-replies.json"); }
  async records(): Promise<Record<string, ReplyRecord>> {
    try { return JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  private change<T>(work: (records: Record<string, ReplyRecord>) => T): Promise<T> {
    const run = async () => {
      const records = await this.records();
      const cutoff = this.now() - KEEP_MS;
      for (const [ref, record] of Object.entries(records)) if (Date.parse(record.at) < cutoff && !this.flights.has(ref)) delete records[ref];
      const result = work(records);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(records), { mode: 0o600, flag: "wx" }); await rename(temp, this.path); }
      finally { await rm(temp, { force: true }); }
      return result;
    };
    const result = this.storeQueue.then(run, run);
    this.storeQueue = result.catch(() => undefined);
    return result;
  }
  private save(record: ReplyRecord): Promise<ReplyRecord> { return this.change((records) => (records[record.ref] = record)); }
  private lane<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.lanes.get(key) ?? Promise.resolve()).then(work, work);
    const settled = result.catch(() => undefined);
    this.lanes.set(key, settled);
    void settled.then(() => { if (this.lanes.get(key) === settled) this.lanes.delete(key); });
    return result;
  }
  // Set before work's first await, so simultaneous duplicate activities join even across Q1→Q2.
  private single(ref: string, work: () => Promise<ReplyRecord>): Promise<ReplyRecord> {
    const known = this.flights.get(ref);
    if (known) return known;
    const result = Promise.resolve().then(work);
    this.flights.set(ref, result);
    void result.then(() => { if (this.flights.get(ref) === result) this.flights.delete(ref); }, () => { if (this.flights.get(ref) === result) this.flights.delete(ref); });
    return result;
  }
  private async replay(record: ReplyRecord): Promise<ReplyRecord> {
    return record.status === "reserved" || record.status === "submitted"
      ? this.save({ ...record, status: "unconfirmed", reason: "the plugin stopped before it recorded confirmation" }) : record;
  }
  private base(ref: string, agentId: string, text: string, responder: ReplyRecord["responder"], issueId?: string): ReplyRecord {
    return { ref, agentId, text, responder, issueId, kind: "message", at: new Date(this.now()).toISOString(), status: "reserved", effects: { evidence: false, correction: false, needsYou: false } };
  }

  deliver(paseo: PaseoApi, agentId: string, message: string, origin: DeliveryOrigin, bound?: BoundAnswer): Promise<DeliveryResult> {
    // A bound multipart final answer takes over its hold synchronously before any disk work.
    const key = bound ? `${agentId}:${bound.requestId}` : null;
    if (key) this.owners.set(key, (this.owners.get(key) ?? 0) + 1);
    const work = this.single(origin.ref, async () => {
      const known = (await this.records())[origin.ref];
      if (known) return this.finish(await this.replay(known));
      let record = await this.save(this.base(origin.ref, agentId, message, origin.responder, origin.issueId));
      const handle = paseo.agents.ref(agentId);
      const pending = bound ? [] : (await handle.refresh())?.agent.pendingPermissions ?? [];
      const question = bound?.request ?? pending.find((request) => request.kind === "question");
      if (bound || question) {
        if (!message && !bound?.response) throw new Error("The agent is waiting for an answer; write it after @paseo.");
        const requestId = bound?.requestId ?? question!.id;
        const response = bound?.response ?? (question ? questionAnswer(question, message) : undefined);
        const selectedKey = `${agentId}:${requestId}`;
        if (!key) this.owners.set(selectedKey, (this.owners.get(selectedKey) ?? 0) + 1);
        try {
          record = { ...record, kind: "answer", requestId, request: question, response, fingerprint: question ? fingerprint(question) : undefined };
          record = await this.lane(selectedKey, () => this.submit(paseo, record));
        } finally { if (!key) this.leaveOwner(selectedKey); }
      } else {
        const approval = pending.find((request) => request.kind !== "question");
        const decision = approval ? approvalDecision(message) : null;
        if (approval && !decision) throw new Error(`The agent is waiting for approval of "${approval.title || approval.name}". Reply "@paseo approve" or "@paseo deny <reason>".`);
        if (!approval && !message) throw new Error("Write the message after @paseo.");
        record = await this.save({ ...record, kind: approval ? "approval" : "message", requestId: approval?.id, request: approval, response: decision ?? undefined, status: "submitted", at: new Date(this.now()).toISOString() });
        try {
          if (this.stopped) throw new Error("the plugin unloaded before sending");
          if (approval && decision) await handle.respondToPermission({ requestId: approval.id, response: decision });
          else await handle.send(message);
          record = await this.save({ ...record, status: "sent" });
        } catch (error) { record = await this.save({ ...record, status: "unconfirmed", reason: reasonOf(error) }); }
      }
      return this.finish(record);
    });
    return work.then((record) => this.result(record)).finally(() => { if (key) this.leaveOwner(key); });
  }
  private leaveOwner(key: string): void {
    const remaining = (this.owners.get(key) ?? 1) - 1;
    if (remaining) this.owners.set(key, remaining); else this.owners.delete(key);
  }

  async respond(input: Parameters<PermissionArbiter["respond"]>[0]): Promise<ArbitratedOutcome> {
    const ref = `deputy:${input.intentId}`;
    const record = await this.single(ref, async () => {
      const known = (await this.records())[ref];
      if (known) return this.replay(known);
      const initial = { ...this.base(ref, input.agentId, "", { kind: "deputy", intentId: input.intentId }), kind: "answer" as const, requestId: input.requestId, fingerprint: input.fingerprint, response: input.response };
      return this.lane(`${input.agentId}:${input.requestId}`, () => this.submit(null, initial));
    });
    const outcome = this.arbitrated(record);
    if (!outcome) throw new Error(record.reason ?? "Paseo did not confirm the submission; it is not sent again");
    return outcome;
  }
  async outcome(intentId: string): Promise<ArbitratedOutcome | null> {
    const record = (await this.records())[`deputy:${intentId}`];
    return record ? this.arbitrated(record) : null;
  }
  private arbitrated(record: ReplyRecord): ArbitratedOutcome | null {
    if (record.status === "applied" || record.status === "owner-first") return record.status;
    return record.status === "gone" || record.status === "rejected" ? "gone" : null;
  }

  private async submit(paseo: PaseoApi | null, original: ReplyRecord): Promise<ReplyRecord> {
    let record = original;
    const requestId = record.requestId!;
    const key = `${record.agentId}:${requestId}`;
    if (record.responder.kind !== "deputy") {
      const deputy = Object.values(await this.records()).find((known) => known.responder.kind === "deputy" && known.agentId === record.agentId && known.requestId === requestId && known.status === "applied");
      if (deputy && deputy.responder.kind === "deputy") return this.save({ ...record, status: "deputy-first", deputyIntentId: deputy.responder.intentId });
    }
    record = await this.save({ ...record, status: "submitted", at: new Date(this.now()).toISOString() });
    try {
      const daemon = await this.daemon();
      // Use the caller's SDK for the final refresh. Deputy submissions use the private client's
      // fetchAgent when available, through the attached SDK supplied by setPaseo.
      const sdk = paseo ?? this.paseo;
      if (!sdk) throw new Error("no daemon connection to refresh the request");
      const current = (await sdk.agents.ref(record.agentId).refresh())?.agent.pendingPermissions?.find((request) => request.id === requestId);
      if (!current || !record.fingerprint || fingerprint(current) !== record.fingerprint || !record.response) return this.save({ ...record, status: "gone" });
      await this.deps.beforeSubmit?.(record);
      if (this.stopped) throw new Error("the plugin unloaded before submitting the answer");
      if (record.responder.kind === "deputy" && ((this.owners.get(key) ?? 0) > 0 || this.holds.has(key))) return this.save({ ...record, status: "owner-first" });
      // No await between the synchronous fence above and starting the external submission.
      if (daemon) await daemon.respondToPermissionAndWait(record.agentId, requestId, record.response, 60_000);
      else if (record.responder.kind === "deputy") throw new Error("no checked answer connection to the local Paseo daemon");
      else await sdk.agents.ref(record.agentId).respondToPermission({ requestId, response: record.response });
      return await this.save({ ...record, request: record.request ?? current, status: daemon ? "applied" : "unchecked" });
    } catch (error) {
      const status = rejectedBeforeApplication(error, requestId) ? "rejected" : "unconfirmed";
      return this.save({ ...record, status, reason: reasonOf(error) });
    }
  }
  private paseo: PaseoApi | null = null;
  attach(paseo: PaseoApi): void { this.paseo = paseo; }

  // Effects are outside the submission lane: deputy dispatch holds its candidate lane while
  // waiting for respond(). Replaying uses only this stored Q1 data, never current Q2 state.
  // A failed effect never changes what happened to the answer: it is logged, its flag stays
  // unset, and a replay of the same activity completes it.
  private async finish(original: ReplyRecord): Promise<ReplyRecord> {
    return this.lane(`effects:${original.ref}`, async () => {
      let record = (await this.records())[original.ref] ?? original;
      const effects = this.effects;
      if (!effects) return record;
      const attempt = async (name: string, work: () => Promise<void>) => {
        try { await work(); }
        catch (error) { console.error(`[linear-tickets] ${name} after ${record.ref} (${record.status}) failed; a replay completes it: ${reasonOf(error)}`); }
      };
      if (record.status === "applied" && record.responder.kind === "owner" && record.request && record.response && !record.effects.evidence) {
        const responder = record.responder;
        await attempt("recording the owner's answer", async () => {
          await effects.ownerAnswered(record.agentId, record.request!, record.response!, responder, record.at);
          record = await this.save({ ...record, effects: { ...record.effects, evidence: true } });
        });
      }
      if (record.status === "deputy-first" && !record.effects.correction) {
        const responder = record.responder;
        await attempt("passing on the owner's correction", async () => {
          const correction = responder.kind === "owner"
            ? await effects.correctLate(record.agentId, record.requestId!, record.text, responder)
            : { delivered: false, reply: "Paseo could not verify that this reply is the owner's, so it was not passed on as a correction." };
          record = await this.save({ ...record, reply: correction.reply, correctionDelivered: correction.delivered, effects: { ...record.effects, correction: true } });
        });
        if (!record.effects.correction) record = { ...record, reply: "The deputy had already answered this question, and your correction could not be passed on. Tell the agent directly." };
      }
      if (!record.effects.needsYou && (record.status === "applied" || record.status === "unchecked" || record.status === "sent" || (record.status === "deputy-first" && record.correctionDelivered))) {
        await attempt("closing the Needs you sub-issue", async () => {
          await effects.needsYou(record.agentId, record.issueId);
          record = await this.save({ ...record, effects: { ...record.effects, needsYou: true } });
        });
      }
      return record;
    });
  }
  private result(record: ReplyRecord): DeliveryResult {
    const status = record.status === "reserved" || record.status === "submitted" || record.status === "owner-first" ? "unconfirmed" : record.status;
    const delivered = status === "applied" || status === "unchecked" || status === "sent" || (status === "deputy-first" && Boolean(record.correctionDelivered));
    const reply = status === "rejected" || status === "gone" ? NOT_DELIVERED
      : status === "unconfirmed" ? unconfirmed(record.reason ?? "no confirmation was recorded") : record.reply ?? null;
    return { status, delivered, reply, request: record.request, response: record.response, at: record.at };
  }
}
