import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { AUTONOMY_POLICY_REVISION } from "../shared/autonomy-policy";
import { dispatchLabels } from "./dispatch";
import { assessRisk, type Part } from "./deputy-risk";
import { evidenceSummary, shadowEvidence } from "./deputy-evidence";
import { policyVersion, type EvaluationInput, type Verdict } from "./deputy-evaluator";
import { supportsTechnicalContinuation, TECHNICAL_CONTINUATION, TECHNICAL_CONTINUATION_TEMPLATE, type TechnicalContinuation } from "./deputy-continuation";
import { gatherSources, verifyCitation, type Source, type SourceReaders } from "./deputy-sources";
import type { LinearService } from "./linear";
import { logQuietly, questionEntry, type Citation, type DecisionLog, type LogEntry } from "./owner-decisions";
import { hasLabel, planPolicy } from "./plan-policy";
import { questionKey, questionsOf } from "./relay";
import type { PluginSettings, Settings } from "./settings";
import { isUntrusted } from "./starter";
import { paseoHome } from "./ticket-mcp";

// Request-bound deputy decisions. Structural/trust eligibility precedes isolated
// semantic selection. Live answers retain grace, current-policy evidence, exact
// request freshness and the checked owner-priority arbiter. Restart equivalence
// retires stale work; it never transfers a selection to another request.

export const DEPUTY_DIRECTORY = () => join(paseoHome(), "linear-tickets", "deputy");
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const SETTLEMENT_RETRY_MS = 5 * 60 * 1000;
const MAX_PARALLEL_EVALUATIONS = 2;
const RETRYABLE_REFUSALS: Record<string, true | undefined> = { "source-unavailable": true, "evaluator-unavailable": true, "no-knowledge": true, "no-evaluator": true, "evidence-changed": true };
export const CHECKED_CONNECTION_MISSING = "no checked answer connection to the local Paseo daemon";

export type ArbitratedOutcome = "applied" | "owner-first" | "gone" | "revoked";
// Plugin-local precedence and a checked result, idempotent per intent. The daemon cannot compare
// request fingerprints or identify other responders; answers outside the plugin are unattributed.
// `outcome` reports an earlier confirmed intent after an interruption (null: unknown).
export type PermissionArbiter = {
  respond(input: { agentId: string; requestId: string; fingerprint: string; intentId: string; response: AgentPermissionResponse; canSubmit: () => boolean }): Promise<ArbitratedOutcome>;
  outcome(intentId: string): Promise<ArbitratedOutcome | null>;
};


export type CandidateStatus =
  | "evaluating" | "refused" | "predicted" | "waiting" | "dispatching" | "applied"
  | "resolved" | "owner-answered" | "canceled" | "blocked" | "owner-won" | "unknown";
const OPEN: CandidateStatus[] = ["evaluating", "predicted", "waiting"];

export type Candidate = {
  key: string;
  // Short reference the owner uses to override: "override D-1a2b3c4d <answer>".
  ref: string;
  agentId: string;
  requestId: string;
  issueId: string;
  identifier: string;
  agentTitle: string | null;
  cwd: string;
  request: AgentPermissionRequest;
  fingerprint: string;
  mode: "shadow" | "live";
  observedAt: string;
  updatedAt: string;
  status: CandidateStatus;
  reason?: string;
  version?: string;
  refusalCategory?: string;
  // Unchanged evidence is not sent to an abstaining model again; unavailable
  // sources/evaluators are checked at most every five minutes.
  evidenceFingerprint?: string;
  retryAt?: string;
  graceDeadline?: string;
  eligible?: boolean;
  standing?: boolean;
  activation?: string;
  selections?: Record<string, string>;
  continuation?: TechnicalContinuation;
  citations?: Citation[];
  intentId?: string;
  notice?: { comment: boolean; session: boolean; commentId: string | null };
};

// Where an owner's answer came from: a Linear comment, an agent session, or the Paseo Agents
// menu bar's ask cards (owner-asks.ts).
export type CorrectionActivity = { via: "linear-comment" | "linear-session" | "menu-bar"; activityId: string; userId: string };
export type Correction = { delivered: boolean; reply: string };

const OVERRIDE = /^\s*override\s+(D-[0-9a-f]{8})\b[:,.]?\s*([\s\S]*)$/i;
// "override D-1a2b3c4d <answer>": the explicit, request-bound correction of a deputy answer.
export function overrideCommand(message: string): { ref: string; text: string } | null {
  const match = OVERRIDE.exec(message);
  return match ? { ref: `D-${match[1].slice(2).toLowerCase()}`, text: match[2].trim() } : null;
}

export function fingerprint(request: AgentPermissionRequest): string {
  // Provider routing and custom-answer capability are part of the action.
  // Legacy pending candidates migrate only after a fresh full raw-request match.
  if (request.kind !== "question") return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 24);
  return createHash("sha256").update(JSON.stringify({ kind: request.kind, title: request.title ?? "", description: request.description ?? "", input: request.input, provider: request.provider, name: request.name, metadata: request.metadata })).digest("hex").slice(0, 24);
}

// What the sources are searched with: everything the request shows, the same at prediction and
// at dispatch, so both see the same sections.
function questionText(request: AgentPermissionRequest): string {
  return [request.title, request.description, ...questionsOf(request).map((item) => [item.header, item.question, ...(item.options ?? []).flatMap((option) => [option.label ?? "", "description" in option && typeof option.description === "string" ? option.description : ""])].filter(Boolean).join("\n"))].filter(Boolean).join("\n");
}

const refFor = (key: string) => `D-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export const candidatesPath = (directory: string) => join(directory, "candidates.json");

// The deputy's candidates by key; none before the first question.
export async function readCandidates(directory: string): Promise<Record<string, Candidate>> {
  try {
    const value: unknown = JSON.parse(await readFile(candidatesPath(directory), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Candidate] => Boolean(entry[1]) && typeof entry[1] === "object")) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

type Deps = {
  settings: Pick<Settings, "read">;
  log: Pick<DecisionLog, "append" | "entries">;
  linear: Pick<LinearService, "issueState" | "viewerId" | "trustedAppIds" | "upsertComment">;
  sessions?: { sessionFor(agentId: string): Promise<{ sessionId: string } | null>; say(sessionId: string, type: "thought" | "response" | "error", body: string): Promise<void> };
  readers: SourceReaders;
  evaluate(input: EvaluationInput, model: string): Promise<Verdict>;
  arbiter?: () => Promise<PermissionArbiter | null>;
  // No recovery, inventory or newly observed request may outrun persisted owner holds.
  ready?: () => Promise<void>;
  directory?: string;
  now?: () => number;
};

export class Deputy {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly arbiter: () => Promise<PermissionArbiter | null>;
  private paseo: PaseoApi | null = null;
  private recovered = false;
  private stopped = false;
  // Incremented synchronously on settings notification, before disk reads or candidate lanes.
  // An unsent intent keeps its original generation even if settings change away and back.
  private settingsGeneration = 0;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private candidateRevision = 0;
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private retryTimer: NodeJS.Timeout | null = null;
  private running = 0;
  private readonly queued: (() => void)[] = [];
  // Work started in the background (evaluations, dispatches), for tests and orderly shutdown.
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly evaluating = new Set<string>();
  private readonly revoked = new Set<string>();
  private discoveryFlight: Promise<{ observed: number; skipped: number; failed: number }> | null = null;
  private reconciliationFlight: Promise<{ observed: number; skipped: number; failed: number }> | null = null;

  constructor(private readonly deps: Deps) {
    this.directory = deps.directory ?? DEPUTY_DIRECTORY();
    this.now = deps.now ?? (() => Date.now());
    this.arbiter = deps.arbiter ?? (async () => null);
  }

  // ---------------------------------------------------------------------------------------------
  // The candidate store: one JSON file, private to the daemon user, written whole and atomically.

  private get path(): string {
    return candidatesPath(this.directory);
  }

  private readStore(): Promise<Record<string, Candidate>> {
    return readCandidates(this.directory);
  }

  private change<T>(work: (store: Record<string, Candidate>) => T): Promise<T> {
    this.candidateRevision++;
    const run = async () => {
      const store = await this.readStore();
      const result = work(store);
      const cutoff = this.now() - KEEP_MS;
      for (const [key, candidate] of Object.entries(store)) if (!OPEN.includes(candidate.status) && candidate.status !== "dispatching" && Date.parse(candidate.updatedAt) < cutoff && (!candidate.notice || (candidate.notice.comment && candidate.notice.session))) delete store[key];
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(store), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return result;
    };
    const result = this.storeQueue.then(run, run);
    this.storeQueue = result.catch(() => undefined);
    return result;
  }

  async candidates(): Promise<Candidate[]> {
    return Object.values(await this.readStore());
  }

  private async patch(key: string, change: Partial<Candidate>): Promise<Candidate | null> {
    return this.change((store) => {
      const known = store[key];
      if (!known) return null;
      store[key] = { ...known, ...change, updatedAt: new Date(this.now()).toISOString() };
      return store[key];
    });
  }

  // One transition at a time per candidate.
  private lane<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.lanes.get(key) ?? Promise.resolve()).then(work, work);
    const settled = result.catch(() => undefined);
    this.lanes.set(key, settled);
    void settled.then(() => { if (this.lanes.get(key) === settled) this.lanes.delete(key); });
    return result;
  }

  private background(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => console.error(`[linear-tickets] deputy: ${message(error)}`));
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  // Resolves once the background work started so far (and what it started) has finished.
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_PARALLEL_EVALUATIONS) await new Promise<void>((resolve) => this.queued.push(resolve));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.queued.shift()?.();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  attach(paseo: PaseoApi): void {
    this.paseo = paseo;
    if (this.recovered || this.stopped) return;
    this.recovered = true;
    this.background(this.reconcile());
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = null;
  }

  // Observe before the settle window. Evaluation is background work; the
  // owner's ordinary question/answer surface remains available throughout.
  async observe(agent: { id: string; cwd: string; title?: string | null }, request: AgentPermissionRequest, link: { issueId: string; identifier: string }): Promise<void> {
    if (request.kind !== "question" || this.stopped) return;
    const { mode } = (await this.deps.settings.read()).deputy;
    if (mode === "off") return;
    await this.deps.ready?.();
    const key = `${agent.id}:${request.id}`;
    const at = new Date(this.now()).toISOString();
    const created = await this.change((store) => {
      if (store[key]) return false;
      // Equivalent unanswered requests after a restart get one active evaluation,
      // but NEVER inherit an answer, intent, deadline or evidence from the old id.
      for (const previous of Object.values(store)) {
        if (previous.agentId === agent.id && previous.issueId === link.issueId && previous.cwd === agent.cwd && previous.fingerprint === fingerprint(request) && (OPEN.includes(previous.status) || previous.status === "refused")) {
          this.revoked.add(previous.key);
          this.unschedule(previous.key);
          previous.status = "canceled";
          previous.reason = "an equivalent question was reissued with a new request identity; fresh evaluation required";
          previous.updatedAt = at;
          previous.retryAt = undefined;
        }
      }
      store[key] = { key, ref: refFor(key), agentId: agent.id, requestId: request.id, issueId: link.issueId, identifier: link.identifier, agentTitle: agent.title ?? null, cwd: agent.cwd, request, fingerprint: fingerprint(request), mode, observedAt: at, updatedAt: at, status: "evaluating" };
      return true;
    });
    if (created) this.background(this.lane(key, () => this.slot(() => this.evaluate(key))));
  }

  // Host-local, level-triggered discovery. Never interpret historical Linear text as a
  // permission, reuse replay verdicts, or revive a terminal candidate. `observe` deduplicates
  // exact identities; recovery handles only policy/settings-authorized reevaluation.
  async reconcile(): Promise<{ observed: number; skipped: number; failed: number }> {
    if (this.stopped) return { observed: 0, skipped: 0, failed: 0 };
    if (this.reconciliationFlight) return this.reconciliationFlight;
    const flight = (async () => {
      await this.recover();
      return this.discoverPending();
    })();
    this.reconciliationFlight = flight;
    void flight.finally(() => { if (this.reconciliationFlight === flight) this.reconciliationFlight = null; }).catch(() => {});
    return flight;
  }

  private discoverPending(): Promise<{ observed: number; skipped: number; failed: number }> {
    if (this.discoveryFlight) return this.discoveryFlight;
    const run = async () => {
      const result = { observed: 0, skipped: 0, failed: 0 };
      const paseo = this.paseo;
      if (!paseo || this.stopped || (await this.deps.settings.read()).deputy.mode === "off") return result;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        for (const { agent: listed } of page.entries) {
          if (!listed.pendingPermissions?.some(request => request.kind === "question")) continue;
          try {
            const refreshed = await paseo.agents.ref(listed.id).refresh();
            if (!refreshed) { result.skipped++; continue; }
            const agent = refreshed.agent;
            const issueId = agent.labels?.["linear.issueId"];
            const identifier = agent.labels?.["linear.identifier"];
            if (agent.archivedAt || agent.status === "closed" || !issueId || !identifier || !agent.cwd) { result.skipped++; continue; }
            for (const request of agent.pendingPermissions ?? []) {
              if (request.kind !== "question") { result.skipped++; continue; }
              const entry = questionEntry(agent.id, request, { id: issueId, identifier }, new Date(this.now()).toISOString());
              if (entry) await this.deps.log.append(entry);
              await this.observe({ id: agent.id, cwd: agent.cwd, title: agent.title }, request, { issueId, identifier });
              result.observed++;
            }
          } catch (error) {
            result.failed++;
            console.error(`[linear-tickets] deputy: discovering pending requests on ${listed.id} failed: ${message(error)}`);
          }
        }
        if (!page.pageInfo.hasMore) break;
        const next = page.pageInfo.nextCursor;
        if (!next || cursors.has(next)) throw new Error("The daemon returned incomplete pending-agent pagination; undiscovered requests remain owner-visible.");
        cursors.add(next);
        cursor = next;
      } while (!this.stopped);
      return result;
    };
    const flight = run();
    this.discoveryFlight = flight;
    void flight.finally(() => { if (this.discoveryFlight === flight) this.discoveryFlight = null; }).catch(() => {});
    return flight;
  }

  private async refuse(candidate: Candidate, version: string, reason: string, category?: string): Promise<void> {
    if (candidate.status !== "refused" || candidate.reason !== reason || candidate.version !== version || candidate.refusalCategory !== category) {
      await logQuietly(() => this.deps.log.append({ kind: "deputy-refusal", id: candidate.key, key: randomUUID(), at: new Date(this.now()).toISOString(), identifier: candidate.identifier, issueId: candidate.issueId, version, mode: candidate.mode, reason, ...(category ? { category } : {}) }), `deputy refusal on ${candidate.identifier}`);
    }
    const recorded = await this.change(store => {
      const current = store[candidate.key];
      if (!current) return false;
      // A replacement can retire this request while its refusal journal is awaited.
      // Fence the durable transition inside the same serialized store mutation.
      if (category === "evidence-changed" && (current.status !== "waiting" || this.revoked.has(candidate.key))) return false;
      store[candidate.key] = { ...current, status: "refused", reason, version, refusalCategory: category, retryAt: category && RETRYABLE_REFUSALS[category] ? new Date(this.now() + SETTLEMENT_RETRY_MS).toISOString() : undefined, updatedAt: new Date(this.now()).toISOString() };
      return true;
    });
    if (!recorded) return;
    if (category && RETRYABLE_REFUSALS[category]) this.retrySettlement();
    console.log(`[linear-tickets] deputy: ${candidate.identifier} question ${candidate.ref} stays with the owner: ${reason}`);
  }

  // Risk first, then knowledge, as of now: the parts the deputy may pick for and the sources it may
  // cite, or why the question stays with the owner.
  private async assess(candidate: Candidate, settings: PluginSettings): Promise<{ ok: true; parts: Part[]; sources: Source[]; context: string } | { ok: false; reason: string; category: string }> {
    let state;
    try {
      state = await this.deps.linear.issueState(candidate.issueId);
    } catch (error) {
      return { ok: false, reason: `the ticket could not be read (${message(error)})`, category: "source-unavailable" };
    }
    let trusted: boolean;
    try {
      trusted = !isUntrusted(state, await this.deps.linear.viewerId(), await this.deps.linear.trustedAppIds());
    } catch (error) {
      return { ok: false, reason: `the ticket's authorship could not be checked (${message(error)})`, category: "source-unavailable" };
    }
    // Planning and attended are context, not blanket owner gates.
    const planApproved = planPolicy(state.labels) === null;
    const risk = assessRisk(candidate.request, { trusted, planning: !planApproved, attended: hasLabel(state.labels, dispatchLabels(settings.dispatch.label).attended.toLowerCase()) });
    if (!risk.ok) return { ok: false, reason: risk.reason, category: risk.category };
    const snapshot = await gatherSources(this.deps.readers, { id: candidate.key, issueId: candidate.issueId, identifier: candidate.identifier, cwd: candidate.cwd, text: questionText(candidate.request), planApproved }, settings.deputy.principlesRepository);
    if (snapshot.abstain) return { ok: false, reason: snapshot.abstain, category: "source-unavailable" };
    const holds = state.labels.map((label) => label.name).filter((name) => /(?:^|-)hold$|^do-not-merge$/i.test(name)).sort();
    const context = [candidate.request.title, candidate.request.description, `Ticket context: ${JSON.stringify({ planning: !planApproved, attended: hasLabel(state.labels, dispatchLabels(settings.dispatch.label).attended.toLowerCase()), canceled: state.statusType === "canceled", holds })}. Standing delegation does not release holds or cancellations.`].filter(Boolean).join("\n\n");
    return { ok: true, parts: risk.parts, sources: snapshot.sources, context };
  }

  private async evaluate(key: string, retry = false): Promise<void> {
    this.evaluating.add(key);
    try { await this.evaluateCandidate(key, retry); }
    finally { this.evaluating.delete(key); }
  }

  private async evaluateCandidate(key: string, retry: boolean): Promise<void> {
    const generation = this.settingsGeneration;
    let candidate = (await this.readStore())[key];
    if (!candidate || this.stopped || (retry ? !this.retryable(candidate) : candidate.status !== "evaluating")) return;
    // Refusal retries enter evaluation directly, without startup recovery.
    // An interrupted legacy migration must repeat its full raw verification
    // before the normal current-format freshness checks can run.
    const legacyFingerprint = this.legacyFingerprint(candidate);
    if (legacyFingerprint) {
      const { mode } = (await this.deps.settings.read()).deputy;
      if (mode === "off") { await this.patch(key, { status: "canceled", reason: "the deputy was switched off" }); return; }
      const migrated = await this.resetEvaluation(candidate, mode, legacyFingerprint);
      if (!migrated) return;
      candidate = migrated;
    }
    // A prior prediction's grace and retry category survive interrupted evaluation.
    // A refreshed answer must not borrow that earlier prediction's elapsed grace.
    const freshGrace = Boolean(candidate.graceDeadline) && RETRYABLE_REFUSALS[candidate.refusalCategory ?? ""] === true;
    if (!await this.stillPending(candidate)) return;
    const settings = await this.deps.settings.read();
    const { mode, model } = settings.deputy;
    if (mode === "off") { await this.patch(key, { status: "canceled", reason: "the deputy was switched off" }); return; }
    const version = model ? policyVersion(model) : "no-evaluator";
    const assessed = await this.assess(candidate, settings);
    if (!assessed.ok) { await this.refuse(candidate, version, assessed.reason, assessed.category); return; }
    if (!model) { await this.refuse(candidate, version, "no evaluator model is configured (deputy.model)", "no-evaluator"); return; }
    const input: EvaluationInput = { identifier: candidate.identifier, parts: assessed.parts, context: assessed.context, sources: assessed.sources, request: candidate.request };
    const evidenceFingerprint = createHash("sha256").update(JSON.stringify([version, input])).digest("hex");
    if (retry && candidate.refusalCategory === "no-knowledge" && candidate.evidenceFingerprint === evidenceFingerprint) {
      await this.patch(key, { retryAt: new Date(this.now() + SETTLEMENT_RETRY_MS).toISOString() });
      this.retrySettlement();
      return;
    }
    candidate = { ...candidate, mode, version, evidenceFingerprint };
    await this.patch(key, { status: "evaluating", eligible: true, mode, version, evidenceFingerprint, retryAt: undefined });
    const verdict = await this.deps.evaluate(input, model)
      .catch((error: unknown): Verdict => ({ ok: false, reason: `the evaluator failed: ${message(error)}`, category: "evaluator-unavailable" }));
    if (this.revoked.has(key) || (await this.readStore())[key]?.status !== "evaluating") return;
    if (!verdict.ok) { await this.refuse(candidate, version, verdict.reason, verdict.category ?? "no-knowledge"); return; }
    const now = await this.deps.settings.read();
    if (now.deputy.mode === "off") { await this.patch(key, { status: "canceled", reason: "the deputy was switched off" }); return; }
    // An owner reply is journaled before it waits for this candidate's lane. Do not turn that
    // reply into knowledge for a new prediction of the very question it already answered.
    if (this.stopped || !await this.stillPending(candidate)) return;
    if (generation !== this.settingsGeneration) { await this.outcome(candidate, "canceled", "the deputy settings changed during evaluation"); return; }
    if ((await this.readStore())[key]?.status !== "evaluating") return;
    // Preserve each evidence-bound prediction. Empirical evidence still counts only
    // the first shadow prediction per question, never retries or live answers.
    await this.deps.log.append({ kind: "deputy-prediction", id: key, key: `${version}:${evidenceFingerprint}`, at: new Date(this.now()).toISOString(), identifier: candidate.identifier, issueId: candidate.issueId, version, mode: candidate.mode, selections: verdict.selections, citations: verdict.citations, standing: verdict.standing, ...(verdict.continuation ? { continuation: verdict.continuation } : {}) });
    const latest = (await this.readStore())[key];
    if (!latest || latest.status !== "evaluating") return;
    if (now.deputy.mode !== "live") {
      await this.patch(key, { status: "predicted", reason: undefined, refusalCategory: undefined, version, selections: verdict.selections, citations: verdict.citations, standing: verdict.standing, continuation: verdict.continuation });
      return;
    }
    const graceDeadline = new Date((freshGrace ? this.now() : Date.parse(candidate.observedAt)) + now.deputy.graceMinutes * 60_000).toISOString();
    const waiting = await this.patch(key, { status: "waiting", reason: undefined, refusalCategory: undefined, version, selections: verdict.selections, citations: verdict.citations, standing: verdict.standing, continuation: verdict.continuation, graceDeadline });
    if (waiting) this.schedule(waiting, generation);
  }

  private schedule(candidate: Candidate, generation = this.settingsGeneration): void {
    if (this.stopped || !candidate.graceDeadline) return;
    clearTimeout(this.timers.get(candidate.key));
    const timer = setTimeout(() => {
      this.timers.delete(candidate.key);
      this.background(this.lane(candidate.key, () => this.dispatch(candidate.key, generation)));
    }, Math.max(0, Date.parse(candidate.graceDeadline) - this.now()));
    timer.unref?.();
    this.timers.set(candidate.key, timer);
  }

  private unschedule(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  // Generic authority retains the empirical gate. The independently audited,
  // revision-bound opt-in bypasses ONLY that gate, ONLY for standing selections.
  async liveBlockers(settings: PluginSettings, standing = false): Promise<string[]> {
    const blockers: string[] = [];
    if (!settings.deputy.model) blockers.push("no evaluator model is configured");
    else {
      const entries = await this.deps.log.entries();
      const activation = entries.filter((entry) => entry.kind === "deputy-activation").at(-1);
      const authorized = standing && settings.deputy.standingPolicy === AUTONOMY_POLICY_REVISION && activation?.policy === AUTONOMY_POLICY_REVISION;
      const evidence = shadowEvidence(entries, policyVersion(settings.deputy.model));
      if (!authorized && !evidence.ready) blockers.push(`not enough shadow evidence for ${evidence.version}: ${evidenceSummary(evidence)}`);
    }
    if (!await this.arbiter()) blockers.push(CHECKED_CONNECTION_MISSING);
    return blockers;
  }

  // Read-only transport contract for native urgency suppression. A caller must
  // compare `request` with its local raw request, keep answer/override UI visible,
  // fail open on any error, and never extend these fixed deadlines on a poll.
  async status(filter: { agentId?: string; permissionId?: string } = {}) {
    const generation = this.settingsGeneration;
    const read = await this.deps.settings.read();
    const settings = { ...read, deputy: { ...read.deputy } };
    const now = this.now();
    const version = settings.deputy.model ? policyVersion(settings.deputy.model) : null;
    const candidates = [];
    for (const candidate of await this.candidates()) {
      if ((filter.agentId && candidate.agentId !== filter.agentId) || (filter.permissionId && candidate.requestId !== filter.permissionId)) continue;
      let suppressUrgency = false;
      let expiresAt: string | null = null;
      const deadline = candidate.status === "evaluating" ? Date.parse(candidate.observedAt) + 150_000 : candidate.graceDeadline ? Date.parse(candidate.graceDeadline) + 10_000 : NaN;
      if (!this.stopped && !this.revoked.has(candidate.key) && candidate.eligible && candidate.mode === "live" && settings.deputy.mode === "live" && candidate.version === version && ["evaluating", "waiting", "dispatching"].includes(candidate.status) && deadline > now && !(await this.liveBlockers(settings, candidate.status === "evaluating" || candidate.standing === true)).length) {
        // No stale id-only suppression, no mutation of candidate state on reads.
        const found = await this.paseo?.agents.ref(candidate.agentId).refresh();
        const agent = found?.agent;
        const request = agent?.pendingPermissions?.find((request) => request.id === candidate.requestId);
        if (agent && !agent.archivedAt && agent.status !== "closed" && agent.labels?.["linear.issueId"] === candidate.issueId && request && fingerprint(request) === candidate.fingerprint) {
          suppressUrgency = true;
          expiresAt = new Date(deadline).toISOString();
        }
      }
      const state: string = candidate.status;
      candidates.push({ agentId: candidate.agentId, permissionId: candidate.requestId, requestFingerprint: candidate.fingerprint, request: candidate.request, state, observedAt: candidate.observedAt, updatedAt: candidate.updatedAt, expiresAt, suppressUrgency });
    }
    // Async gate/daemon reads may overlap refusals, revocations or settings
    // writes. Drain earlier writes and validate one final store snapshot; any
    // subsequently queued mutation invalidates this read, even before its I/O.
    const queue = this.storeQueue;
    await queue;
    const revision = this.candidateRevision;
    const currentSettings = await this.deps.settings.read();
    const currentStore = await this.readStore();
    const currentVersion = currentSettings.deputy.model ? policyVersion(currentSettings.deputy.model) : null;
    const stable = !this.stopped && generation === this.settingsGeneration && queue === this.storeQueue && revision === this.candidateRevision
      && JSON.stringify(currentSettings.deputy) === JSON.stringify(settings.deputy) && currentSettings.template === settings.template;
    for (const entry of candidates) {
      const key = `${entry.agentId}:${entry.permissionId}`;
      const current = currentStore[key];
      if (!stable || this.revoked.has(key) || !current || current.status !== entry.state || current.updatedAt !== entry.updatedAt
        || current.fingerprint !== entry.requestFingerprint || !current.eligible || current.mode !== "live" || current.version !== currentVersion
        || !entry.expiresAt || Date.parse(entry.expiresAt) <= this.now()) {
        entry.suppressUrgency = false;
        entry.expiresAt = null;
      }
      if (current) {
        // The durable state is a first-response receipt, not editor consumption.
        // The native RPC already accepts descriptive state strings.
        entry.state = current.status === "applied" && current.continuation ? "technical-instruction-submitted-editor-unobserved" : current.status;
        entry.updatedAt = current.updatedAt;
      }
    }
    return { mode: currentSettings.deputy.mode, policyVersion: currentVersion, updatedAt: new Date(this.now()).toISOString(), candidates };
  }

  async ownerNotificationDelay(agentId: string, requestId: string): Promise<number> {
    const snapshot = await this.status({ agentId, permissionId: requestId });
    const candidate = snapshot.candidates[0];
    if (candidate?.suppressUrgency && candidate.expiresAt) return Math.max(0, Date.parse(candidate.expiresAt) - this.now());
    // Owner-authorized notification-only initial debounce. This is NOT trusted
    // suppression: all question/answer UI stays visible, and the clock is fixed.
    if (snapshot.mode === "live" && snapshot.policyVersion && candidate?.state === "evaluating" && !(await this.liveBlockers(await this.deps.settings.read(), true)).length) return Math.max(0, Date.parse(candidate.observedAt) + 15_000 - this.now());
    return 0;
  }

  private async outcome(candidate: Candidate, status: "blocked" | "canceled" | "owner-won" | "unknown" | "resolved", reason: string): Promise<void> {
    await this.patch(candidate.key, { status, reason });
    if (status !== "resolved") await logQuietly(() => this.deps.log.append({ kind: "deputy-outcome", id: candidate.key, at: new Date(this.now()).toISOString(), key: status, reason }), `deputy outcome on ${candidate.identifier}`);
    console.log(`[linear-tickets] deputy: ${candidate.identifier} question ${candidate.ref}: ${status} (${reason})`);
  }

  // The grace period is over: every gate is checked again right before the one possible write.
  private async dispatch(key: string, generation: number): Promise<void> {
    const candidate = (await this.readStore())[key];
    if (!candidate || candidate.status !== "waiting" || !candidate.selections) return;
    const read = await this.deps.settings.read();
    const settings = { ...read, deputy: { ...read.deputy } };
    if (settings.deputy.mode !== "live") { await this.outcome(candidate, "canceled", `the deputy is ${settings.deputy.mode} now`); return; }
    if (!settings.deputy.model || policyVersion(settings.deputy.model) !== candidate.version) { await this.outcome(candidate, "canceled", "the evaluator changed since the prediction"); return; }
    const paseo = this.paseo;
    if (!paseo) { await this.outcome(candidate, "canceled", "no daemon connection to check the request"); return; }
    const found = await paseo.agents.ref(candidate.agentId).refresh().catch(() => null);
    const agent = found?.agent;
    if (!agent || agent.archivedAt || agent.status === "closed") { await this.outcome(candidate, "canceled", "the agent is gone"); return; }
    if (agent.labels?.["linear.issueId"] !== candidate.issueId) { await this.outcome(candidate, "canceled", "the agent is no longer linked to the ticket"); return; }
    const pending = (agent.pendingPermissions ?? []).find((request) => request.id === candidate.requestId);
    if (!pending) { await this.outcome(candidate, "resolved", "the request was answered or withdrawn during the grace period"); return; }
    if (fingerprint(pending) !== candidate.fingerprint) { await this.outcome(candidate, "canceled", "the request changed since the prediction"); return; }
    if (candidate.continuation && (!supportsTechnicalContinuation(pending)
      || candidate.continuation.template !== TECHNICAL_CONTINUATION_TEMPLATE
      || typeof candidate.continuation.step !== "string" || !candidate.continuation.step.trim()
      || typeof candidate.continuation.whyNoSafeOption !== "string" || !candidate.continuation.whyNoSafeOption.trim()
      || candidate.standing !== true || Object.keys(candidate.selections).length !== 1 || candidate.selections.Response !== TECHNICAL_CONTINUATION)) {
      await this.outcome(candidate, "canceled", "the technical-continuation template or custom-answer capability changed");
      return;
    }
    if (!candidate.continuation && Object.values(candidate.selections).includes(TECHNICAL_CONTINUATION)) {
      await this.outcome(candidate, "canceled", "a technical instruction is not an offered-choice answer");
      return;
    }
    const blockers = await this.liveBlockers(settings, candidate.standing === true);
    if (blockers.length) { await this.outcome(candidate, "blocked", blockers.join("; ")); return; }
    // Ticket constraints and knowledge again; every cited passage must still be
    // in today's sources and the complete evaluator input must be unchanged.
    const assessed = await this.assess(candidate, settings);
    if (!assessed.ok) { await this.outcome(candidate, "canceled", `the question no longer qualifies: ${assessed.reason}`); return; }
    const input: EvaluationInput = { identifier: candidate.identifier, parts: assessed.parts, context: assessed.context, sources: assessed.sources, request: candidate.request };
    const evidenceFingerprint = createHash("sha256").update(JSON.stringify([candidate.version, input])).digest("hex");
    // Quotes alone are insufficient: amended policy can retain the quote, and a new
    // blocking-only source can contradict it. Legacy predictions without a snapshot fail closed.
    if (candidate.evidenceFingerprint !== evidenceFingerprint) {
      if (this.stopped || this.revoked.has(key) || generation !== this.settingsGeneration) return;
      if (!candidate.evidenceFingerprint) await this.outcome(candidate, "canceled", "the prediction has no evidence snapshot");
      else await this.refuse(candidate, candidate.version!, "the evaluator evidence changed since the prediction", "evidence-changed");
      return;
    }
    const stale = (candidate.citations ?? []).find((citation) => typeof verifyCitation(assessed.sources, citation.sourceId, citation.quote) === "string");
    if (stale) { await this.outcome(candidate, "canceled", `the sources changed since the prediction (${stale.sourceId})`); return; }
    const arbiter = await this.arbiter();
    if (!arbiter) { await this.outcome(candidate, "blocked", CHECKED_CONNECTION_MISSING); return; }
    const intentId = randomUUID();
    // Recorded before the write: a reload in between finds the intent and never submits it again.
    const audit = (await this.deps.log.entries()).filter((entry) => entry.kind === "deputy-activation").at(-1);
    const activation = candidate.standing && settings.deputy.standingPolicy === AUTONOMY_POLICY_REVISION && audit?.policy === AUTONOMY_POLICY_REVISION ? AUTONOMY_POLICY_REVISION : undefined;
    await this.patch(key, { status: "dispatching", intentId, activation });
    const answers: Record<string, string> = {};
    questionsOf(pending).forEach((item, index) => {
      const part = questionKey(item, index);
      answers[part] = candidate.selections?.[part] ?? "";
    });
    if (this.stopped) { await this.outcome({ ...candidate, intentId }, "canceled", "the plugin stopped before the answer was submitted"); return; }
    const latest = (await this.deps.settings.read()).deputy;
    if (latest.mode !== "live" || !latest.model || policyVersion(latest.model) !== candidate.version || latest.principlesRepository !== settings.deputy.principlesRepository || latest.graceMinutes !== settings.deputy.graceMinutes || latest.standingPolicy !== settings.deputy.standingPolicy) {
      await this.outcome({ ...candidate, intentId }, "canceled", "the deputy settings changed before submission");
      return;
    }
    // PermissionReplies calls this synchronously AFTER its own awaits, immediately before
    // invoking the checked daemon send. A settings notification cannot queue behind this lane.
    const canSubmit = () => !this.stopped && generation === this.settingsGeneration && !this.revoked.has(key);
    let result: ArbitratedOutcome;
    try {
      result = await arbiter.respond({ agentId: candidate.agentId, requestId: candidate.requestId, fingerprint: candidate.fingerprint, intentId, response: { behavior: "allow", updatedInput: { answers } }, canSubmit });
    } catch (error) {
      await this.outcome({ ...candidate, intentId }, "unknown", `the daemon did not confirm the answer (${message(error)}); it is not submitted again`);
      return;
    }
    await this.settle({ ...candidate, intentId, activation }, result);
  }

  private async settle(candidate: Candidate, result: ArbitratedOutcome): Promise<void> {
    try {
      if (result === "owner-first") { await this.outcome(candidate, "owner-won", "the owner answered first"); return; }
      if (result === "revoked") { await this.outcome(candidate, "canceled", "the deputy authorization was revoked before submission"); return; }
      if (result === "gone") { await this.outcome(candidate, "resolved", "the request was gone when the answer arrived"); return; }
      if (candidate.continuation) {
        await this.deps.log.append({ kind: "deputy-continuation", id: candidate.key, at: new Date(this.now()).toISOString(), identifier: candidate.identifier, issueId: candidate.issueId, version: candidate.version ?? "", key: candidate.intentId ?? "", fingerprint: candidate.fingerprint, directive: TECHNICAL_CONTINUATION, continuation: candidate.continuation, citations: candidate.citations ?? [], ...(candidate.activation ? { activation: candidate.activation } : {}) });
      } else {
        await this.deps.log.append({ kind: "deputy-answer", id: candidate.key, at: new Date(this.now()).toISOString(), identifier: candidate.identifier, issueId: candidate.issueId, version: candidate.version ?? "", key: candidate.intentId ?? "", answers: candidate.selections ?? {}, citations: candidate.citations ?? [], ...(candidate.activation ? { activation: candidate.activation } : {}) });
      }
      const applied = await this.patch(candidate.key, { status: "applied", reason: candidate.continuation ? "checked technical instruction submitted; editor consumption and agent execution unobserved; not a substantive answer or owner approval" : undefined, notice: { comment: false, session: false, commentId: null } });
      if (applied) await this.notify(applied);
    } catch (error) {
      this.retrySettlement();
      throw error;
    }
  }

  // The visible answer: a ticket comment (always, whatever the write-back settings) and the agent
  // session's panel. A failed notice is retried; the answer itself never is.
  private async notify(candidate: Candidate): Promise<void> {
    const notice = candidate.notice ?? { comment: false, session: false, commentId: null };
    const parts = questionsOf(candidate.request).map((item, index) => ({ key: questionKey(item, index), question: [item.header, item.question].filter(Boolean).join(": ") }));
    const answer = parts.filter((part) => candidate.selections?.[part.key]).map((part) => `- ${part.question}: **${candidate.selections?.[part.key]}**`).join("\n");
    const sources = (candidate.citations ?? []).map((citation) => `- ${citation.url ? `[${citation.title}](${citation.url})` : citation.title} (\`${citation.sourceId}\` @ \`${citation.revision}\`): “${citation.quote}”`).join("\n");
    const head = candidate.continuation
      ? `🤖 **Checked technical instruction submitted** for **${candidate.agentTitle ?? "the Paseo agent"}** (${candidate.ref}). The checked receipt confirms only the first OMP response; later editor consumption and agent execution are unobserved. Not an owner approval or substantive decision answered.\n\n${answer}\n\n**Sources:**\n${sources}`
      : `🤖 **Answered by the deputy** for **${candidate.agentTitle ?? "the Paseo agent"}** (${candidate.ref}):\n\n${answer}\n\n**Sources:**\n${sources}`;
    try {
      if (!notice.comment) {
        const commentId = await this.deps.linear.upsertComment(candidate.issueId, `${head}\n\n**Reply to override:** a reply to this comment goes to that agent as your correction. Request \`${candidate.key}\`.`, null);
        Object.assign(notice, { comment: true, commentId });
        await this.patch(candidate.key, { notice: { ...notice } });
      }
      if (!notice.session) {
        const link = await this.deps.sessions?.sessionFor(candidate.agentId) ?? null;
        if (link) await this.deps.sessions?.say(link.sessionId, "response", `${head}\n\nReply to override: “override ${candidate.ref} <your answer>”.`);
        notice.session = true;
        await this.patch(candidate.key, { notice: { ...notice } });
      }
    } catch (error) {
      console.error(`[linear-tickets] deputy: the notice for ${candidate.identifier} ${candidate.ref} failed, retrying later: ${message(error)}`);
      this.retrySettlement();
    }
  }

  private owesSettlement(candidate: Candidate): boolean {
    // Refusal retries are separate from dispatch settlement: they never replay an answer.
    return candidate.status === "dispatching" || Boolean(candidate.status === "applied" && candidate.notice && !(candidate.notice.comment && candidate.notice.session));
  }

  private retryable(candidate: Candidate): boolean {
    return candidate.status === "refused" && RETRYABLE_REFUSALS[candidate.refusalCategory ?? ""] === true;
  }

  private legacyFingerprint(candidate: Candidate): string | null {
    // Recognize only the pre-capability question hash, never an arbitrary
    // mismatch or terminal history. The caller must verify the complete raw
    // request freshly before persisting the returned current-format hash.
    if (!["refused", "predicted", "waiting", "evaluating", "blocked"].includes(candidate.status) || candidate.request.kind !== "question") return null;
    const current = fingerprint(candidate.request);
    if (candidate.fingerprint === current) return null;
    const legacy = createHash("sha256").update(JSON.stringify({ kind: candidate.request.kind, title: candidate.request.title ?? "", description: candidate.request.description ?? "", questions: questionsOf(candidate.request) })).digest("hex").slice(0, 24);
    return candidate.fingerprint === legacy ? current : null;
  }

  private async resetEvaluation(candidate: Candidate, mode: Candidate["mode"], nextFingerprint: string | null): Promise<Candidate | null> {
    this.unschedule(candidate.key);
    const rechecked = nextFingerprint ? { ...candidate, fingerprint: nextFingerprint } : candidate;
    if (!await this.stillPending(rechecked, nextFingerprint !== null)) return null;
    return this.patch(candidate.key, { status: "evaluating", fingerprint: rechecked.fingerprint, mode, observedAt: new Date(this.now()).toISOString(), version: undefined, eligible: false, standing: undefined, continuation: undefined, activation: undefined, selections: undefined, citations: undefined, evidenceFingerprint: undefined, graceDeadline: undefined, refusalCategory: undefined, retryAt: undefined, reason: undefined, intentId: undefined });
  }

  private async stillPending(candidate: Candidate, requireRawMatch = false): Promise<boolean> {
    if (this.revoked.has(candidate.key)) return false;
    let entries: LogEntry[];
    try {
      entries = await this.deps.log.entries();
    } catch (error) {
      await this.refuse(candidate, candidate.version ?? "no-evaluator", `recorded answers could not be checked (${message(error)})`, "source-unavailable");
      return false;
    }
    if (entries.some((entry) => entry.id === candidate.key && (entry.kind === "answer" || entry.kind === "owner-answer" || entry.kind === "deputy-answer" || entry.kind === "deputy-continuation"))) {
      await this.outcome(candidate, "resolved", "the request already has a recorded answer");
      return false;
    }
    const found = await this.paseo?.agents.ref(candidate.agentId).refresh().catch(() => null);
    // A connection outage is not evidence that the question disappeared.
    if (!found) {
      await this.refuse(candidate, candidate.version ?? "no-evaluator", "the pending request could not be checked", "source-unavailable");
      return false;
    }
    const agent = found.agent;
    const pending = agent.pendingPermissions?.find((request) => request.id === candidate.requestId);
    if (agent.archivedAt || agent.status === "closed" || agent.labels?.["linear.issueId"] !== candidate.issueId || !pending) {
      await this.outcome(candidate, "resolved", "the request is no longer pending on the linked agent");
      return false;
    }
    if (fingerprint(pending) !== candidate.fingerprint || (requireRawMatch && !isDeepStrictEqual(pending, candidate.request))) {
      await this.outcome(candidate, "canceled", "the request changed since it was observed");
      return false;
    }
    return true;
  }

  private retrySettlement(): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.background(this.retryPending());
    }, SETTLEMENT_RETRY_MS);
    this.retryTimer.unref?.();
  }

  // Complete confirmed answers and notices; reconsider retryable refusals without replaying a response.
  private async retryPending(): Promise<void> {
    if (this.stopped) return;
    try {
      for (const candidate of (await this.candidates()).filter((item) => this.owesSettlement(item) || (this.retryable(item) && Date.parse(item.retryAt ?? "") <= this.now()))) {
        try {
          await this.lane(candidate.key, async () => {
            if (this.stopped) return;
            const current = (await this.readStore())[candidate.key];
            if (!current) return;
            if (current.status === "dispatching") {
              const arbiter = await this.arbiter();
              const known = arbiter && current.intentId ? await arbiter.outcome(current.intentId) : null;
              if (known) await this.settle(current, known);
            } else if (this.owesSettlement(current)) await this.notify(current);
            else if (this.retryable(current)) await this.slot(() => this.evaluate(current.key, true));
          });
        } catch (error) {
          console.error(`[linear-tickets] deputy: settlement for ${candidate.identifier} ${candidate.ref} failed, retrying later: ${message(error)}`);
        }
      }
      if ((await this.candidates()).some((candidate) => this.owesSettlement(candidate) || this.retryable(candidate))) this.retrySettlement();
    } catch (error) {
      this.retrySettlement();
      throw error;
    }
  }

  // After a reload: candidates continue where they were, checked against the requests that are
  // actually pending. An interrupted dispatch is never submitted again.
  private async recover(restartKeys?: ReadonlySet<string>, standingActivation = false): Promise<void> {
    await this.deps.ready?.();
    const settings = await this.deps.settings.read();
    const version = settings.deputy.model ? policyVersion(settings.deputy.model) : "no-evaluator";
    let refusals: Map<string, Extract<LogEntry, { kind: "deputy-refusal" }>> | undefined;
    for (const candidate of await this.candidates()) {
      // Terminal history needs neither a lane nor another whole-store read.
      // Keep unfinished effects and exact settings-authorized restart keys.
      if (candidate.status !== "dispatching" && !this.owesSettlement(candidate)
        && !["refused", "predicted", "waiting", "evaluating", "blocked"].includes(candidate.status)
        && !(candidate.status === "canceled" && restartKeys?.has(candidate.key))) continue;
      // A current in-process evaluation owns its fresh checks and continuation.
      // Waiting behind its model call would prevent discovery of unrelated asks.
      // Restored evaluations and explicit settings recovery still take the lane.
      if (!restartKeys && !standingActivation && candidate.status === "evaluating"
        && candidate.mode === settings.deputy.mode && (!candidate.version || candidate.version === version)
        && this.lanes.has(candidate.key)) continue;
      try {
        await this.lane(candidate.key, async () => {
          const current = (await this.readStore())[candidate.key];
          if (!current) return;
          if (current.status === "dispatching") {
            const arbiter = await this.arbiter();
            // Without the checked connection the outcome cannot be read now; the candidate stays
            // owed and the settlement timer retries it instead of concluding "unknown" blindly.
            if (!arbiter) { this.retrySettlement(); return; }
            const known = current.intentId ? await arbiter.outcome(current.intentId) : null;
            if (known) await this.settle(current, known);
            else await this.outcome(current, "unknown", "the plugin restarted while the answer was submitted; it is not submitted again");
            return;
          }
          if (this.owesSettlement(current)) { this.retrySettlement(); return; }
          const changedPolicy = (current.version !== version || current.mode !== settings.deputy.mode) && ["refused", "predicted", "waiting", "evaluating", "blocked"].includes(current.status);
          const revokedHere = current.status === "canceled" && restartKeys?.has(current.key)
            && ["the deputy settings changed", "the deputy settings changed during evaluation", "the deputy was switched off"].includes(current.reason ?? "");
          const newlyAuthorized = standingActivation && current.status === "blocked" && current.standing === true;
          const legacyFingerprint = this.legacyFingerprint(current);
          if (settings.deputy.mode !== "off" && (changedPolicy || revokedHere || newlyAuthorized || legacyFingerprint)) {
            // Reevaluate exact still-pending requests after a policy/mode change
            // or this settings write's revocation/standing activation. Never
            // promote old selections, grace or intents; never revive arbitrary
            // canceled work, answered requests or interrupted dispatches.
            if (!await this.resetEvaluation(current, settings.deputy.mode, legacyFingerprint)) return;
            this.background(this.lane(current.key, () => this.slot(() => this.evaluate(current.key))));
            return;
          }
          if (current.status === "refused") {
            // Existing candidates predate persisted categories. Recover only the journaled
            // refusal matching this candidate; never infer safety from the question's words.
            if (!current.refusalCategory && !refusals) {
              refusals = new Map((await this.deps.log.entries()).flatMap((entry) => entry.kind === "deputy-refusal" ? [[entry.id, entry] as const] : []));
            }
            const logged = refusals?.get(current.key);
            const category = current.refusalCategory ?? (logged && logged.reason === current.reason ? logged.category ?? "no-knowledge" : undefined);
            if (category && RETRYABLE_REFUSALS[category]) {
              await this.patch(current.key, { refusalCategory: category, retryAt: current.retryAt ?? new Date(this.now() + SETTLEMENT_RETRY_MS).toISOString() });
              this.retrySettlement();
            }
            return;
          }
          if (current.status !== "evaluating" && current.status !== "waiting") return;
          if (!await this.stillPending(current)) return;
          if (current.status === "waiting") this.schedule(current);
          else this.background(this.lane(current.key, () => this.slot(() => this.evaluate(current.key))));
        });
      } catch (error) {
        console.error(`[linear-tickets] deputy: recovery for ${candidate.identifier} ${candidate.ref} failed: ${message(error)}`);
        if (this.owesSettlement(candidate)) this.retrySettlement();
      }
    }
  }

  // The request was resolved, by whoever: an open candidate ends; a dispatch in flight settles on
  // the daemon's own answer.
  async resolved(agentId: string, requestId: string): Promise<void> {
    const key = `${agentId}:${requestId}`;
    this.unschedule(key);
    await this.lane(key, async () => {
      const candidate = (await this.readStore())[key];
      if (candidate && (OPEN.includes(candidate.status) || this.retryable(candidate))) await this.patch(key, { status: "resolved", retryAt: undefined, reason: "the request was resolved" });
    });
  }

  // The plugin delivered the authenticated owner's answer to this request (a Linear comment
  // written with the owner's key, or an agent-session reply whose author is the owner). The only
  // answers that count as the owner's, for the evidence and as knowledge for later questions.
  // `at`: taken before the answer was submitted, so a prediction recorded after it counts as late.
  async ownerAnswered(agentId: string, request: AgentPermissionRequest, response: AgentPermissionResponse, activity: CorrectionActivity, at: string): Promise<void> {
    if (request.kind !== "question" || response.behavior !== "allow" || !activity.userId.trim()) return;
    const raw = response.updatedInput && typeof response.updatedInput === "object" ? Object.entries(response.updatedInput).find(([field]) => field === "answers")?.[1] : undefined;
    const answers = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    const key = `${agentId}:${request.id}`;
    await this.deps.log.append({ kind: "owner-answer", id: key, at, key: activity.activityId || `answer:${at}`, via: activity.via, userId: activity.userId, answers });
    this.unschedule(key);
    await this.lane(key, async () => {
      const candidate = (await this.readStore())[key];
      if (candidate && (OPEN.includes(candidate.status) || this.retryable(candidate))) await this.patch(key, { status: "owner-answered", retryAt: undefined, reason: "the owner answered" });
    });
  }

  // The deputy answer a Linear reply corrects: a reply in the thread of its notice comment.
  async noticeFor(commentId: string | null | undefined): Promise<Candidate | null> {
    if (!commentId) return null;
    return (await this.candidates()).find((candidate) => candidate.notice?.commentId === commentId) ?? null;
  }

  async byRef(ref: string): Promise<Candidate | null> {
    return (await this.candidates()).find((candidate) => candidate.ref === ref) ?? null;
  }

  // A checked deputy outcome authorises the owner's late correction even while its own log and
  // notices are still owed. Only this in-memory copy advances; settlement keeps its durable state.
  async correctLate(agentId: string, requestId: string, text: string, activity: CorrectionActivity): Promise<Correction> {
    const key = `${agentId}:${requestId}`;
    const candidate = await this.lane(key, async () => {
      const current = (await this.readStore())[key];
      if (!current || current.status === "applied") return current;
      const arbiter = await this.arbiter();
      const known = arbiter && current.intentId ? await arbiter.outcome(current.intentId) : null;
      if (known !== "applied") return current;
      try {
        await this.settle(current, known);
      } catch (error) {
        console.error(`[linear-tickets] deputy: settlement for ${current.identifier} ${current.ref} failed; the confirmed answer can still be corrected: ${message(error)}`);
      }
      return { ...current, status: "applied" as const };
    });
    if (!candidate) return { delivered: false, reply: "Your answer was not delivered: the question was no longer waiting, or Paseo was already processing another answer to it." };
    const result = await this.correct(candidate, text, activity);
    return result.delivered
      ? { delivered: true, reply: `The deputy had already answered this question (${candidate.ref}); your answer went to the agent as your correction.` }
      : result;
  }

  // The owner overrides a deputy answer: the correction goes to the agent that got the answer as a
  // message, never as the answer to whatever it asks now. Each owner activity is handled once.
  async correct(candidate: Candidate, text: string, activity: CorrectionActivity): Promise<Correction> {
    if (!activity.userId.trim()) return { delivered: false, reply: "Paseo could not verify that this reply is the owner's, so it was not passed on as a correction." };
    if (candidate.status !== "applied") return { delivered: false, reply: `${candidate.ref} is not an answer the deputy gave, so there is nothing to override.` };
    if (!text.trim()) return { delivered: false, reply: `Write your answer, for example “override ${candidate.ref} <your answer>”.` };
    return this.lane(`${candidate.key}:correction`, async () => {
      const done = (await this.deps.log.entries()).find((entry): entry is Extract<LogEntry, { kind: "deputy-override" }> => entry.kind === "deputy-override" && entry.id === candidate.key && entry.key === activity.activityId);
      if (done) return { delivered: done.disposition === "delivered", reply: done.disposition === "delivered" ? "Already passed on as a correction." : `Not delivered earlier: ${done.detail ?? "unknown reason"}` };
      const question = questionsOf(candidate.request).map((item) => [item.header, item.question].filter(Boolean).join(": ")).join(" / ");
      const answered = Object.values(candidate.selections ?? {}).filter(Boolean).join(" / ");
      const note = [
        candidate.continuation
          ? `Correction from the owner (${candidate.ref}): the automated deputy submitted a bounded technical instruction for your earlier question “${question}” (request ${candidate.requestId}), not personal owner approval. The owner corrects that instruction:`
          : `Correction from the owner (${candidate.ref}): the deputy answered your earlier question “${question}” (request ${candidate.requestId}) with “${answered}” on the owner's behalf. The owner overrides that answer:`,
        text.trim(),
        "Redo or adjust whatever you did based on the deputy's answer. This message is not an answer to any question you are asking now.",
      ].join("\n\n");
      let disposition: "delivered" | "failed" = "delivered";
      let detail: string | undefined;
      try {
        if (!this.paseo) throw new Error("no daemon connection");
        const handle = this.paseo.agents.ref(candidate.agentId);
        const found = await handle.refresh();
        if (!found || found.agent.archivedAt || found.agent.status === "closed") throw new Error("the agent that got the deputy's answer is no longer running");
        await handle.send(note);
      } catch (error) {
        disposition = "failed";
        detail = message(error);
      }
      await this.deps.log.append({ kind: "deputy-override", id: candidate.key, at: new Date(this.now()).toISOString(), key: activity.activityId, via: activity.via, userId: activity.userId, text: text.trim(), disposition, ...(detail ? { detail } : {}) });
      return disposition === "delivered"
        ? { delivered: true, reply: `Passed to the agent as your correction of ${candidate.ref}.` }
        : { delivered: false, reply: `Your correction of ${candidate.ref} was not delivered: ${detail}. Tell the agent working on ${candidate.identifier} directly.` };
    });
  }

  // Every settings notification revokes unsent work synchronously. The later durable
  // cancellation may wait for a candidate lane, but the final checked-send guard never does.
  async settingsChanged(): Promise<string[]> {
    // Preserve evaluation identities before the first await: those evaluations
    // may observe this generation change and cancel themselves before our lane.
    const canceled = new Set(this.evaluating);
    this.settingsGeneration++;
    const { mode } = (await this.deps.settings.read()).deputy;
    const candidates = await this.candidates();
    for (const candidate of candidates) {
      if (candidate.status !== "waiting" && candidate.status !== "evaluating" && !(mode === "off" && this.retryable(candidate))) continue;
      canceled.add(candidate.key);
      this.unschedule(candidate.key);
      await this.lane(candidate.key, async () => {
        const current = (await this.readStore())[candidate.key];
        if (current && (current.status === "waiting" || current.status === "evaluating" || (mode === "off" && this.retryable(current)))) {
          await this.outcome(current, "canceled", "the deputy settings changed");
          canceled.add(current.key);
        }
      });
    }
    return [...canceled];
  }

  // Called only after the settings RPC has durably recorded any activation.
  // The keys are precisely the unsent work revoked by that settings write.
  async recheckPolicy(canceled: readonly string[], standingActivation = false): Promise<void> {
    if (!this.stopped) {
      await this.recover(canceled.length ? new Set(canceled) : undefined, standingActivation);
      await this.discoverPending();
    }
  }
}
