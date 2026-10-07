import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { dispatchLabels } from "./dispatch";
import { assessRisk, type Part } from "./deputy-risk";
import { evidenceSummary, shadowEvidence } from "./deputy-evidence";
import { policyVersion, type EvaluationInput, type Verdict } from "./deputy-evaluator";
import { gatherSources, verifyCitation, type Source, type SourceReaders } from "./deputy-sources";
import type { LinearService } from "./linear";
import { logQuietly, type Citation, type DecisionLog, type LogEntry } from "./owner-decisions";
import { hasLabel, planPolicy } from "./plan-policy";
import { questionKey, questionsOf } from "./relay";
import type { PluginSettings, Settings } from "./settings";
import { isUntrusted } from "./starter";
import { paseoHome } from "./ticket-mcp";

// The deputy for agent questions (README, "Deputy for agent questions"). After the existing settle
// window and owner prompt, every question of a ticket agent becomes a candidate, kept on disk per
// (agent, request): risk first, knowledge second, then a prediction. In shadow mode that is all:
// the prediction is logged and the owner answers as before. In live mode the owner keeps a grace
// period; only after it, and only if nothing changed and every gate still holds, may the deputy
// answer — through a daemon response that lets an owner answer win and names who answered. The
// installed daemon has no such response yet (TUC-1258), so live mode records why it is blocked
// and answers nothing. Corrections of a deputy answer go to the agent that got it, never into a
// newer question.

export const DEPUTY_DIRECTORY = () => join(paseoHome(), "linear-tickets", "deputy");
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const NOTICE_RETRY_MS = 5 * 60 * 1000;
const MAX_PARALLEL_EVALUATIONS = 2;
export const ARBITER_MISSING = "the Paseo daemon does not offer owner-priority permission responses with an authoritative responder yet (TUC-1258)";

export type ArbitratedOutcome = "applied" | "owner-first" | "gone";
// The daemon response live answers need (TUC-1258): submitted only while no owner response for the
// request is in, bound to the request's fingerprint, idempotent per intent, and resolving with
// who actually answered. `outcome` reports an earlier intent after an interruption (null: unknown).
export type PermissionArbiter = {
  respond(input: { agentId: string; requestId: string; fingerprint: string; intentId: string; response: AgentPermissionResponse }): Promise<ArbitratedOutcome>;
  outcome(intentId: string): Promise<ArbitratedOutcome | null>;
};

// The host's capability check: no released Paseo daemon or SDK offers the arbitrated response,
// so every host answers null and live mode stays blocked. Comparing answer texts or timing
// afterwards does not prove who answered, so there is no fallback.
export async function permissionArbiter(): Promise<PermissionArbiter | null> {
  return null;
}

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
  graceDeadline?: string;
  selections?: Record<string, string>;
  citations?: Citation[];
  intentId?: string;
  notice?: { comment: boolean; session: boolean; commentId: string | null };
};

export type CorrectionActivity = { via: "linear-comment" | "linear-session"; activityId: string; userId: string };
export type Correction = { delivered: boolean; reply: string };

const OVERRIDE = /^\s*override\s+(D-[0-9a-f]{8})\b[:,.]?\s*([\s\S]*)$/i;
// "override D-1a2b3c4d <answer>": the explicit, request-bound correction of a deputy answer.
export function overrideCommand(message: string): { ref: string; text: string } | null {
  const match = OVERRIDE.exec(message);
  return match ? { ref: `D-${match[1].slice(2).toLowerCase()}`, text: match[2].trim() } : null;
}

export function fingerprint(request: AgentPermissionRequest): string {
  return createHash("sha256").update(JSON.stringify({ kind: request.kind, title: request.title ?? "", description: request.description ?? "", questions: questionsOf(request) })).digest("hex").slice(0, 24);
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
  linear: Pick<LinearService, "issueState" | "viewerId" | "appUserId" | "upsertComment">;
  sessions?: { sessionFor(agentId: string): Promise<{ sessionId: string } | null>; say(sessionId: string, type: "thought" | "response" | "error", body: string): Promise<void> };
  readers: SourceReaders;
  evaluate(input: EvaluationInput, model: string): Promise<Verdict>;
  arbiter?: () => Promise<PermissionArbiter | null>;
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
  private storeQueue: Promise<unknown> = Promise.resolve();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private noticeTimer: NodeJS.Timeout | null = null;
  private running = 0;
  private readonly queued: (() => void)[] = [];
  // Work started in the background (evaluations, dispatches), for tests and orderly shutdown.
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly deps: Deps) {
    this.directory = deps.directory ?? DEPUTY_DIRECTORY();
    this.now = deps.now ?? (() => Date.now());
    this.arbiter = deps.arbiter ?? permissionArbiter;
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
    this.background(this.recover());
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearInterval(this.noticeTimer ?? undefined);
  }

  // A question still pending after the settle window, once the owner was shown it. Returns at once:
  // the evaluation runs in the background and never delays or replaces the owner's prompt.
  async observe(agent: { id: string; cwd: string; title?: string | null }, request: AgentPermissionRequest, link: { issueId: string; identifier: string }): Promise<void> {
    if (request.kind !== "question" || this.stopped) return;
    const { mode } = (await this.deps.settings.read()).deputy;
    if (mode === "off") return;
    const key = `${agent.id}:${request.id}`;
    const at = new Date(this.now()).toISOString();
    const created = await this.change((store) => {
      if (store[key]) return false;
      store[key] = { key, ref: refFor(key), agentId: agent.id, requestId: request.id, issueId: link.issueId, identifier: link.identifier, agentTitle: agent.title ?? null, cwd: agent.cwd, request, fingerprint: fingerprint(request), mode, observedAt: at, updatedAt: at, status: "evaluating" };
      return true;
    });
    if (created) this.background(this.lane(key, () => this.slot(() => this.evaluate(key))));
  }

  private async refuse(candidate: Candidate, version: string, reason: string, category?: string): Promise<void> {
    await logQuietly(() => this.deps.log.append({ kind: "deputy-refusal", id: candidate.key, at: new Date(this.now()).toISOString(), identifier: candidate.identifier, issueId: candidate.issueId, version, mode: candidate.mode, reason, ...(category ? { category } : {}) }), `deputy refusal on ${candidate.identifier}`);
    await this.patch(candidate.key, { status: "refused", reason, version });
    console.log(`[linear-tickets] deputy: ${candidate.identifier} question ${candidate.ref} stays with the owner: ${reason}`);
  }

  // Risk first, then knowledge, as of now: the parts the deputy may pick for and the sources it may
  // cite, or why the question stays with the owner.
  private async assess(candidate: Candidate, settings: PluginSettings): Promise<{ ok: true; parts: Part[]; sources: Source[] } | { ok: false; reason: string; category: string }> {
    let state;
    try {
      state = await this.deps.linear.issueState(candidate.issueId);
    } catch (error) {
      return { ok: false, reason: `the ticket could not be read (${message(error)})`, category: "source-unavailable" };
    }
    const trusted = !isUntrusted(state, await this.deps.linear.viewerId(), await this.deps.linear.appUserId());
    // The ticket's plan is approved (plan-ready); before that a question decides the plan.
    const planApproved = planPolicy(state.labels) === null;
    const risk = assessRisk(candidate.request, { trusted, planning: !planApproved, attended: hasLabel(state.labels, dispatchLabels(settings.dispatch.label).attended.toLowerCase()) });
    if (!risk.ok) return { ok: false, reason: risk.reason, category: risk.category };
    const snapshot = await gatherSources(this.deps.readers, { id: candidate.key, issueId: candidate.issueId, identifier: candidate.identifier, cwd: candidate.cwd, text: questionText(candidate.request), planApproved }, settings.deputy.principlesRepository);
    if (snapshot.abstain) return { ok: false, reason: snapshot.abstain, category: "source-unavailable" };
    return { ok: true, parts: risk.parts, sources: snapshot.sources };
  }

  private async evaluate(key: string): Promise<void> {
    const candidate = (await this.readStore())[key];
    if (!candidate || candidate.status !== "evaluating") return;
    const settings = await this.deps.settings.read();
    const { mode, model } = settings.deputy;
    if (mode === "off") { await this.patch(key, { status: "canceled", reason: "the deputy was switched off" }); return; }
    const version = model ? policyVersion(model) : "no-evaluator";
    const assessed = await this.assess(candidate, settings);
    if (!assessed.ok) { await this.refuse(candidate, version, assessed.reason, assessed.category); return; }
    if (!model) { await this.refuse(candidate, version, "no evaluator model is configured (deputy.model)", "no-evaluator"); return; }
    const verdict = await this.deps.evaluate({ identifier: candidate.identifier, parts: assessed.parts, context: candidate.request.description ?? "", sources: assessed.sources }, model)
      .catch((error: unknown): Verdict => ({ ok: false, reason: `the evaluator failed: ${message(error)}` }));
    if (!verdict.ok) { await this.refuse(candidate, version, verdict.reason, verdict.category ?? "no-knowledge"); return; }
    const now = await this.deps.settings.read();
    if (now.deputy.mode === "off") { await this.patch(key, { status: "canceled", reason: "the deputy was switched off" }); return; }
    // Recorded once, before any dispatch: the evidence compares it with the owner's later answer.
    await this.deps.log.append({ kind: "deputy-prediction", id: key, at: new Date(this.now()).toISOString(), identifier: candidate.identifier, issueId: candidate.issueId, version, mode: candidate.mode, selections: verdict.selections, citations: verdict.citations });
    const latest = (await this.readStore())[key];
    if (!latest || latest.status !== "evaluating") return;
    if (now.deputy.mode !== "live") {
      await this.patch(key, { status: "predicted", version, selections: verdict.selections, citations: verdict.citations });
      return;
    }
    const graceDeadline = new Date(Date.parse(candidate.observedAt) + now.deputy.graceMinutes * 60_000).toISOString();
    const waiting = await this.patch(key, { status: "waiting", version, selections: verdict.selections, citations: verdict.citations, graceDeadline });
    if (waiting) this.schedule(waiting);
  }

  private schedule(candidate: Candidate): void {
    if (this.stopped || !candidate.graceDeadline) return;
    clearTimeout(this.timers.get(candidate.key));
    const timer = setTimeout(() => {
      this.timers.delete(candidate.key);
      this.background(this.lane(candidate.key, () => this.dispatch(candidate.key)));
    }, Math.max(0, Date.parse(candidate.graceDeadline) - this.now()));
    timer.unref?.();
    this.timers.set(candidate.key, timer);
  }

  private unschedule(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  // Why live answers are not allowed now; empty when they are.
  async liveBlockers(settings: PluginSettings): Promise<string[]> {
    const blockers: string[] = [];
    if (!settings.deputy.model) blockers.push("no evaluator model is configured");
    else {
      const evidence = shadowEvidence(await this.deps.log.entries(), policyVersion(settings.deputy.model));
      if (!evidence.ready) blockers.push(`not enough shadow evidence for ${evidence.version}: ${evidenceSummary(evidence)}`);
    }
    if (!await this.arbiter()) blockers.push(ARBITER_MISSING);
    return blockers;
  }

  private async outcome(candidate: Candidate, status: "blocked" | "canceled" | "owner-won" | "unknown" | "resolved", reason: string): Promise<void> {
    await this.patch(candidate.key, { status, reason });
    if (status !== "resolved") await logQuietly(() => this.deps.log.append({ kind: "deputy-outcome", id: candidate.key, at: new Date(this.now()).toISOString(), key: status, reason }), `deputy outcome on ${candidate.identifier}`);
    console.log(`[linear-tickets] deputy: ${candidate.identifier} question ${candidate.ref}: ${status} (${reason})`);
  }

  // The grace period is over: every gate is checked again right before the one possible write.
  private async dispatch(key: string): Promise<void> {
    const candidate = (await this.readStore())[key];
    if (!candidate || candidate.status !== "waiting" || !candidate.selections) return;
    const settings = await this.deps.settings.read();
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
    const blockers = await this.liveBlockers(settings);
    if (blockers.length) { await this.outcome(candidate, "blocked", blockers.join("; ")); return; }
    // Risk and knowledge again: the ticket may be attended or untrusted now, and every cited
    // passage must still be in today's sources.
    const assessed = await this.assess(candidate, settings);
    if (!assessed.ok) { await this.outcome(candidate, "canceled", `the question no longer qualifies: ${assessed.reason}`); return; }
    const stale = (candidate.citations ?? []).find((citation) => typeof verifyCitation(assessed.sources, citation.sourceId, citation.quote) === "string");
    if (stale) { await this.outcome(candidate, "canceled", `the sources changed since the prediction (${stale.sourceId})`); return; }
    const arbiter = await this.arbiter();
    if (!arbiter) { await this.outcome(candidate, "blocked", ARBITER_MISSING); return; }
    const intentId = randomUUID();
    // Recorded before the write: a reload in between finds the intent and never submits it again.
    await this.patch(key, { status: "dispatching", intentId });
    const answers: Record<string, string> = {};
    questionsOf(pending).forEach((item, index) => {
      const part = questionKey(item, index);
      answers[part] = candidate.selections?.[part] ?? "";
    });
    let result: ArbitratedOutcome;
    try {
      result = await arbiter.respond({ agentId: candidate.agentId, requestId: candidate.requestId, fingerprint: candidate.fingerprint, intentId, response: { behavior: "allow", updatedInput: { answers } } });
    } catch (error) {
      await this.outcome({ ...candidate, intentId }, "unknown", `the daemon did not confirm the answer (${message(error)}); it is not submitted again`);
      return;
    }
    await this.settle({ ...candidate, intentId }, result);
  }

  private async settle(candidate: Candidate, result: ArbitratedOutcome): Promise<void> {
    if (result === "owner-first") { await this.outcome(candidate, "owner-won", "the owner answered first"); return; }
    if (result === "gone") { await this.outcome(candidate, "resolved", "the request was gone when the answer arrived"); return; }
    await this.deps.log.append({ kind: "deputy-answer", id: candidate.key, at: new Date(this.now()).toISOString(), identifier: candidate.identifier, issueId: candidate.issueId, version: candidate.version ?? "", key: candidate.intentId ?? "", answers: candidate.selections ?? {}, citations: candidate.citations ?? [] });
    const applied = await this.patch(candidate.key, { status: "applied", notice: { comment: false, session: false, commentId: null } });
    if (applied) await this.notify(applied);
  }

  // The visible answer: a ticket comment (always, whatever the write-back settings) and the agent
  // session's panel. A failed notice is retried; the answer itself never is.
  private async notify(candidate: Candidate): Promise<void> {
    const notice = candidate.notice ?? { comment: false, session: false, commentId: null };
    const parts = questionsOf(candidate.request).map((item, index) => ({ key: questionKey(item, index), question: [item.header, item.question].filter(Boolean).join(": ") }));
    const answer = parts.filter((part) => candidate.selections?.[part.key]).map((part) => `- ${part.question}: **${candidate.selections?.[part.key]}**`).join("\n");
    const sources = (candidate.citations ?? []).map((citation) => `- ${citation.url ? `[${citation.title}](${citation.url})` : citation.title} (\`${citation.sourceId}\` @ \`${citation.revision}\`): “${citation.quote}”`).join("\n");
    const head = `🤖 **Answered by the deputy** for **${candidate.agentTitle ?? "the Paseo agent"}** (${candidate.ref}):\n\n${answer}\n\n**Sources:**\n${sources}`;
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
      this.retryNotices();
    }
  }

  private retryNotices(): void {
    if (this.noticeTimer || this.stopped) return;
    this.noticeTimer = setInterval(() => {
      this.background((async () => {
        const pending = (await this.candidates()).filter((candidate) => candidate.status === "applied" && candidate.notice && !(candidate.notice.comment && candidate.notice.session));
        if (!pending.length && this.noticeTimer) { clearInterval(this.noticeTimer); this.noticeTimer = null; }
        for (const candidate of pending) await this.lane(candidate.key, () => this.notify(candidate));
      })());
    }, NOTICE_RETRY_MS);
    this.noticeTimer.unref?.();
  }

  // After a reload: candidates continue where they were, checked against the requests that are
  // actually pending. An interrupted dispatch is never submitted again.
  private async recover(): Promise<void> {
    for (const candidate of await this.candidates()) {
      if (candidate.status === "dispatching") {
        const arbiter = await this.arbiter();
        const known = arbiter && candidate.intentId ? await arbiter.outcome(candidate.intentId).catch(() => null) : null;
        await this.lane(candidate.key, () => known ? this.settle(candidate, known) : this.outcome(candidate, "unknown", "the plugin restarted while the answer was submitted; it is not submitted again"));
        continue;
      }
      if (candidate.status === "applied" && candidate.notice && !(candidate.notice.comment && candidate.notice.session)) { this.retryNotices(); continue; }
      if (candidate.status !== "evaluating" && candidate.status !== "waiting") continue;
      const found = await this.paseo?.agents.ref(candidate.agentId).refresh().catch(() => null);
      const pending = found?.agent.pendingPermissions?.some((request) => request.id === candidate.requestId);
      if (!pending) { await this.lane(candidate.key, () => this.outcome(candidate, "resolved", "the request was no longer pending after a reload")); continue; }
      if (candidate.status === "waiting") this.schedule(candidate);
      else this.background(this.lane(candidate.key, () => this.slot(() => this.evaluate(candidate.key))));
    }
  }

  // The request was resolved, by whoever: an open candidate ends; a dispatch in flight settles on
  // the daemon's own answer.
  async resolved(agentId: string, requestId: string): Promise<void> {
    const key = `${agentId}:${requestId}`;
    this.unschedule(key);
    await this.lane(key, async () => {
      const candidate = (await this.readStore())[key];
      if (candidate && OPEN.includes(candidate.status)) await this.patch(key, { status: "resolved", reason: "the request was resolved" });
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
    await logQuietly(() => this.deps.log.append({ kind: "owner-answer", id: key, at, key: activity.activityId || `answer:${at}`, via: activity.via, userId: activity.userId, answers }), `owner answer on ${key}`);
    this.unschedule(key);
    await this.lane(key, async () => {
      const candidate = (await this.readStore())[key];
      if (candidate && OPEN.includes(candidate.status)) await this.patch(key, { status: "owner-answered", reason: "the owner answered" });
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
        `Correction from the owner (${candidate.ref}): the deputy answered your earlier question “${question}” (request ${candidate.requestId}) with “${answered}” on the owner's behalf. The owner overrides that answer:`,
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

  // Off or shadow stops live work at once: candidates waiting for their grace period end.
  async settingsChanged(): Promise<void> {
    const { mode } = (await this.deps.settings.read()).deputy;
    if (mode === "live") return;
    for (const candidate of await this.candidates()) {
      if (candidate.status !== "waiting" && !(mode === "off" && candidate.status === "evaluating")) continue;
      this.unschedule(candidate.key);
      await this.lane(candidate.key, async () => {
        const current = (await this.readStore())[candidate.key];
        if (current && (current.status === "waiting" || current.status === "evaluating")) await this.outcome(current, "canceled", `the deputy was switched to ${mode}`);
      });
    }
  }
}
