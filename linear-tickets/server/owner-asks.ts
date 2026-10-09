import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { OwnerAsk } from "../shared/contracts";
import type { Handover, HandoverRecord } from "./handover";
import type { LinearService, OwnerAskComment, OwnerAskIssue } from "./linear";
import { closeAnswered, type NeedsYouIssues } from "./needs-you";
import { askHash, EXTRACTION_VERSION, MAX_SOURCE_CHARS, type AskQuestion, type ExtractInput, type Extraction, type ExtractedAsk } from "./owner-ask-extract";
import type { DeliveryOrigin, DeliveryResult } from "./permission-replies";
import { LIVE_AGENT } from "./process-liveness";
import { withPriority } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";
import { ownerRequest } from "./writeback";

// The owner's asks (README, "Owner asks"): everything waiting for the owner in Linear's "Needs
// input" state, read for the Paseo Agents menu bar app as cards the owner answers there. This
// module lists the asks (batched Linear reads, cached by `updatedAt`), extracts each ask's
// questions in the background (one isolated OMP call per issue and ask text, cached on disk) and
// routes an answer the same way an owner's "@paseo <answer>" comment would go: to the live agent
// that asked, as a continuation of the ticket when its agent is gone, or as a comment.

export const OWNER_ASK_DIRECTORY = () => join(paseoHome(), "linear-tickets", "owner-asks");
// One model call at a time or two; a failure is retried with backoff and then left unextracted.
const EXTRACT_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [15_000, 60_000, 300_000];
// A double click or a retry within this window answers once.
export const ANSWER_KEEP_MS = 10 * 60 * 1000;
// An issue answered here stays out of `linear.owner-asks` until Linear's `updatedAt` moves past
// the answer by this margin (the answer's own comment and state move must not resurrect it).
export const ANSWER_HIDE_MS = 60_000;
// The answered set is kept this long; afterwards the issue only follows its own `updatedAt`.
export const ANSWERED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const CALLER = "owner-asks";
const AGENT_PAGE = 200;
const RECORD_LIMIT = 4_000;

type Linear = Pick<LinearService, "ownerAskIssues" | "ownerAskIssuesByIds" | "ownerAskComments" | "commentBody" | "comment" | "complete" | "viewerId">;
type NeedsYou = Pick<NeedsYouIssues, "all" | "remove">;

export type ContinueOutcome = { kind: "started" | "live" | "deferred" | "failed" | "forwarded" | "skipped"; reason?: string; peer?: string };

export type OwnerAsksDeps = {
  linear: Linear;
  needsYou: NeedsYou;
  handover: Pick<Handover, "read">;
  // `<trigger>-needs-you` and `<trigger>-manual` (dispatchLabels).
  labels: () => Promise<{ needsYou: string; manual: string }>;
  // `settings.deputy.model` when set, else the cheap tier's omp model.
  resolveModel: () => Promise<string>;
  extract: (input: ExtractInput, model: string) => Promise<Extraction>;
  deliver: (paseo: PaseoApi, agentId: string, message: string, origin: DeliveryOrigin) => Promise<DeliveryResult>;
  continueTicket: (issueId: string, identifier: string, lead: string) => Promise<ContinueOutcome>;
  directory?: string;
  now?: () => number;
};

export type AnswerAskInput = { issueId: string; answers: Record<string, string>; note?: string; done?: boolean };
export type AnswerAskResult = { delivered: "agent" | "continued" | "comment" | "closed"; message: string };

// The ask text of one issue and what the extraction made of it. `questions` are the extraction's
// (empty while it is pending or failed). `ticketId`/`ticketIdentifier` name the ticket the ask
// belongs to: the parent of a "Needs you" sub-issue or manual task, else the issue itself (a
// ticket under an epic is still its own ticket).
type Draft = { issue: OwnerAskIssue; manual: boolean; text: string; needsYou: string | null; route: OwnerAsk["route"]; agentId: string | null; ticketAgentId: string | null; ticketId: string; ticketIdentifier: string };
type ExtractionState = { hash: string; value: ExtractedAsk | null; attempts: number; nextAt: number; running: boolean };
type ExtractionJob = { issueId: string; hash: string; input: ExtractInput };
type StoredExtraction = { hash: string; version: string; model: string; result: ExtractedAsk | null; attempts: number; nextAt: string | null; at: string };
type AnswerRecord = { at: number; result: AnswerAskResult };
// Which ask this host answered here and when: the menu bar reads `linear.owner-asks` next to its
// own answer, and the issue must not come back until Linear says something new happened to it.
type AnsweredRecord = { at: number; hash: string };
type Ledger = { version: number; answers: Record<string, AnswerRecord>; answered: Record<string, AnsweredRecord> };
const LEDGER_VERSION = 1;

// The plugin's wait comments and agent replies that hand the next step to the owner; the same
// detector write-back uses for a turn that ended by asking (writeback.ownerRequest).
const WAIT_COMMENT = /\) is waiting for (?:an answer|plan approval|permission):|\) finished its turn and is waiting for you:|Reply here with (?:“|")@paseo/;

export function asksOwner(body: string): boolean {
  return WAIT_COMMENT.test(body) || ownerRequest(body) !== null;
}

// The markdown one ask is extracted from: a "Needs you" sub-issue and a manual task carry the ask
// in their description; for a ticket it is its open wait comment, else the newest comment asking
// the owner, else the description.
export function selectAskText(source: { needsYou: boolean; manual: boolean; waitCommentId: string | null; comments: OwnerAskComment[] }, issue: { description: string }): string {
  if (source.needsYou || source.manual) return issue.description;
  const wait = source.waitCommentId ? source.comments.find((comment) => comment.id === source.waitCommentId) : undefined;
  if (wait) return wait.body;
  // `comments` are newest first (Linear's `comments(first:)`).
  const asking = source.comments.find((comment) => asksOwner(comment.body));
  return asking?.body ?? issue.description;
}

// Where an answer goes from this host's view: the live agent that asked, a continuation of the
// ticket whose agent is gone, or a plain comment when no ticket agent was ever involved.
export function askRoute(input: { manual: boolean; asking: string | null; live: Set<string>; history: boolean }): { route: OwnerAsk["route"]; agentId: string | null } {
  if (!input.manual && input.asking && input.live.has(input.asking)) return { route: "agent", agentId: input.asking };
  if (input.manual || !input.history) return { route: "comment", agentId: null };
  return { route: "continue", agentId: null };
}

// The answer as one text: each question with the owner's choice, then the note.
export function answerText(ask: { questions: AskQuestion[] }, input: AnswerAskInput): string {
  const given = Object.entries(input.answers).map(([key, value]) => [key, value.trim()] as const).filter(([, value]) => value);
  const lines = given.filter(([key]) => ask.questions.some((question) => question.key === key)).map(([key, value]) => {
    const question = ask.questions.find((item) => item.key === key)!;
    return `${question.question} → ${value}`;
  });
  for (const [, value] of given.filter(([key]) => !ask.questions.some((question) => question.key === key))) lines.push(value);
  const note = input.note?.trim() ?? "";
  return [...lines, note].filter(Boolean).join("\n");
}

// What the agent gets: with one question the chosen label itself, so it is answered as the exact
// option an "@paseo <answer>" reply would pick; otherwise the whole answer as one message.
export function deliveryText(ask: { questions: AskQuestion[] }, input: AnswerAskInput): string {
  const answered = ask.questions.filter((question) => (input.answers[question.key] ?? "").trim());
  const note = input.note?.trim() ?? "";
  if (answered.length === 1 && Object.keys(input.answers).filter((key) => (input.answers[key] ?? "").trim()).length === 1) {
    return [input.answers[answered[0].key]!.trim(), note].filter(Boolean).join("\n\n");
  }
  return answerText(ask, input);
}

function answerSignature(input: AnswerAskInput): string {
  const answers = Object.fromEntries(Object.entries(input.answers).map(([key, value]) => [key, value.trim()]).sort(([a], [b]) => a.localeCompare(b)));
  return askHash(JSON.stringify({ issueId: input.issueId, answers, note: input.note?.trim() ?? "", done: Boolean(input.done) }));
}

export class OwnerAsks {
  private readonly directory: string;
  private readonly now: () => number;
  // The ask text per issue, keyed by the `updatedAt` it was read at (one Linear read per change).
  private readonly cache = new Map<string, { updatedAt: string; text: string }>();
  private readonly extractions = new Map<string, ExtractionState>();
  private readonly queue: ExtractionJob[] = [];
  private readonly queued = new Set<string>();
  private readonly retries = new Set<NodeJS.Timeout>();
  private readonly answers = new Map<string, AnswerRecord>();
  private readonly answered = new Map<string, AnsweredRecord>();
  private readonly inFlight = new Map<string, Promise<AnswerAskResult>>();
  private answersLoaded = false;
  private running = 0;
  private stopped = false;

  constructor(private readonly deps: OwnerAsksDeps) {
    this.directory = deps.directory ?? OWNER_ASK_DIRECTORY();
    this.now = deps.now ?? Date.now;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  // Everything waiting for the owner, from cache, without waiting for the model: an ask whose
  // extraction has not finished is returned with `extracted: false` (kind "info", its title).
  async snapshot(paseo: PaseoApi | null): Promise<{ asks: OwnerAsk[]; updatedAt: string }> {
    const at = new Date(this.now()).toISOString();
    await this.loadLedger();
    const drafts = (await this.collect(paseo)).filter((draft) => !this.hidden(draft.issue));
    const asks: OwnerAsk[] = [];
    for (const draft of drafts) {
      const hash = askHash(`${EXTRACTION_VERSION}\n${draft.text}`);
      let state = await this.extractionFor(draft.issue.id, hash);
      if (!state) {
        state = { hash, value: null, attempts: 0, nextAt: 0, running: false };
        this.extractions.set(draft.issue.id, state);
      }
      if (!state.value && !state.running && state.attempts < MAX_ATTEMPTS && state.nextAt <= this.now()) {
        this.enqueue({ issueId: draft.issue.id, hash, input: { identifier: draft.issue.identifier, title: draft.issue.title, ticket: draft.ticketId === draft.issue.id ? null : draft.ticketIdentifier, kind: draft.needsYou ? "needs-you" : draft.manual ? "manual" : "ticket", text: draft.text } });
      }
      const value = state.value;
      asks.push({
        issueId: draft.issue.id,
        identifier: draft.issue.identifier,
        title: draft.issue.title,
        url: draft.issue.url,
        parentIdentifier: draft.issue.parentIdentifier,
        ticketIdentifier: draft.ticketIdentifier,
        kind: value?.kind ?? "info",
        summary: value?.summary ?? draft.issue.title,
        questions: value?.questions ?? [],
        source: draft.text.slice(0, MAX_SOURCE_CHARS),
        route: draft.route,
        agentId: draft.route === "agent" ? draft.agentId : null,
        extracted: Boolean(value),
        updatedAt: draft.issue.updatedAt,
      });
    }
    asks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { asks, updatedAt: at };
  }

  // Answers one ask the way an owner "@paseo <answer>" comment would: the live agent is told (its
  // pending question is answered, else the text is a prompt), a ticket whose agent is gone gets a
  // continuation agent, and anything else becomes a comment. Idempotent per issue and answer for
  // ANSWER_KEEP_MS, so a double click is one answer.
  answer(input: AnswerAskInput, paseo: PaseoApi | null): Promise<AnswerAskResult> {
    const key = `${input.issueId}:${answerSignature(input)}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = this.answerOnce(key, input, paseo).finally(() => { if (this.inFlight.get(key) === work) this.inFlight.delete(key); });
    this.inFlight.set(key, work);
    return work;
  }

  private async answerOnce(key: string, input: AnswerAskInput, paseo: PaseoApi | null): Promise<AnswerAskResult> {
    const known = await this.answerRecord(key);
    if (known) return known.result;
    const result = await this.runAnswer(input, paseo);
    this.answers.set(key, { at: this.now(), result });
    this.answered.set(input.issueId, { at: this.now(), hash: answerSignature(input) });
    await this.saveLedger();
    return result;
  }

  private async runAnswer(input: AnswerAskInput, paseo: PaseoApi | null): Promise<AnswerAskResult> {
    const drafts = await this.collect(paseo);
    const draft = drafts.find((item) => item.issue.id === input.issueId);
    if (!draft) throw new Error("That ask is not waiting for you in Linear any more (or is not assigned to you), so nothing was answered.");
    const state = await this.extractionFor(draft.issue.id, askHash(`${EXTRACTION_VERSION}\n${draft.text}`));
    const ask = { questions: state?.value?.questions ?? [] };
    const text = answerText(ask, input);
    if (input.done) {
      if (draft.needsYou || draft.manual) {
        if (draft.needsYou) await closeAnswered(this.deps.needsYou, this.deps.linear, draft.issue.id);
        else await this.deps.linear.complete(draft.issue.id);
        if (text) await this.deps.linear.comment(draft.issue.id, this.record(text));
        return { delivered: "closed", message: `Marked ${draft.issue.identifier} done.` };
      }
      await this.deps.linear.comment(draft.issue.id, this.record(text || `${draft.issue.identifier} is done from the owner's answers.`));
      return { delivered: "comment", message: `${draft.issue.identifier} keeps its state; the agent's next turn settles the wait.` };
    }
    if (!text) throw new Error("Nothing to answer: choose an option or write the answer.");
    const ticketId = draft.ticketId;
    if (draft.route === "agent" && draft.agentId && paseo) return this.tellAgent(draft, input, ask, paseo, draft.agentId);
    if (draft.route === "continue" && paseo) {
      const outcome = await this.deps.continueTicket(ticketId, draft.ticketIdentifier, text);
      // A live agent took the ticket meanwhile: the answer goes to it, exactly as a comment would.
      if (outcome.kind === "live" && draft.ticketAgentId) return this.tellAgent(draft, input, ask, paseo, draft.ticketAgentId);
      if (outcome.kind === "failed") throw new Error(`Could not start an agent on ${draft.ticketIdentifier}: ${outcome.reason ?? "unknown error"}.`);
      if (outcome.kind === "deferred" || outcome.kind === "skipped" || outcome.kind === "live") throw new Error(`No continuation agent was started: ${outcome.reason ?? "the ticket cannot start right now"}.`);
      if (draft.needsYou) await closeAnswered(this.deps.needsYou, this.deps.linear, draft.issue.id);
      await this.deps.linear.comment(ticketId, this.record(text));
      return { delivered: "continued", message: outcome.kind === "forwarded" ? `The answer is handed to ${outcome.peer ?? "the other host"}, which continues the ticket.` : `Started a continuation agent on ${draft.ticketIdentifier}.` };
    }
    if (draft.needsYou) await closeAnswered(this.deps.needsYou, this.deps.linear, draft.issue.id);
    await this.deps.linear.comment(draft.issue.id, this.record(text));
    return { delivered: "comment", message: `Recorded your answer as a comment on ${draft.issue.identifier}.` };
  }

  // The answer to the live agent that asked, through the same checked path an owner's "@paseo"
  // comment takes (its pending question is answered, else the text is a prompt); the record
  // comment and the "Needs you" sub-issue follow from it.
  private async tellAgent(draft: Draft, input: AnswerAskInput, ask: { questions: AskQuestion[] }, paseo: PaseoApi, agentId: string): Promise<AnswerAskResult> {
    const userId = await this.deps.linear.viewerId().catch(() => "");
    const origin: DeliveryOrigin = {
      ref: `owner-ask:${draft.issue.id}:${answerSignature(input)}`,
      responder: { kind: "owner", via: "menu-bar", activityId: `owner-ask:${draft.issue.id}`, userId },
      issueId: draft.needsYou ?? draft.issue.id,
    };
    const delivered = await this.deps.deliver(paseo, agentId, deliveryText(ask, input), origin);
    if (!delivered.delivered) throw new Error(delivered.reply ?? "The answer did not reach the agent; check the agent's Paseo session.");
    await this.deps.linear.comment(draft.issue.id, this.record(answerText(ask, input)));
    return { delivered: "agent", message: delivered.reply ?? `Passed to the agent working on ${draft.ticketIdentifier}.` };
  }

  private record(text: string): string {
    const body = text.trim();
    return `Answered from the menu bar: ${body.length > RECORD_LIMIT ? `${body.slice(0, RECORD_LIMIT - 1).trimEnd()}…` : body}`;
  }

  // ---------------------------------------------------------------------------------------------
  // Collection

  private isManual(issue: OwnerAskIssue, manualLabel: string): boolean {
    return issue.labels.some((name) => name.trim().toLowerCase() === manualLabel.trim().toLowerCase());
  }

  private async collect(paseo: PaseoApi | null): Promise<Draft[]> {
    const issues = await withPriority("interactive", CALLER, () => this.deps.linear.ownerAskIssues());
    const [needsYou, labels, agents] = await Promise.all([
      this.deps.needsYou.all().catch(() => []),
      this.deps.labels(),
      this.agentIndex(paseo),
    ]);
    const needsYouById = new Map(needsYou.map((entry) => [entry.id, entry]));
    const records = new Map<string, HandoverRecord | null>();
    const record = async (id: string) => {
      if (!records.has(id)) records.set(id, await this.deps.handover.read(id).catch(() => null));
      return records.get(id) ?? null;
    };
    const cached = (issue: OwnerAskIssue) => this.cache.get(issue.id)?.updatedAt === issue.updatedAt ? this.cache.get(issue.id)! : null;
    const isNeedsYou = (issue: OwnerAskIssue) => needsYouById.has(issue.id) || /^needs you:/i.test(issue.title.trim());
    const manual = (issue: OwnerAskIssue) => this.isManual(issue, labels.manual);
    const stale = issues.filter((issue) => !cached(issue));
    const comments = new Map<string, OwnerAskComment[]>();
    const asked = stale.filter((issue) => !isNeedsYou(issue) && !manual(issue));
    if (asked.length) {
      for (const [id, list] of await withPriority("interactive", CALLER, () => this.deps.linear.ownerAskComments(asked.map((issue) => issue.id)).catch(() => new Map<string, OwnerAskComment[]>()))) comments.set(id, list);
      // A wait comment older than the newest page is read on its own.
      for (const issue of asked) {
        const waiting = (await record(issue.id))?.waiting;
        if (!waiting?.commentId || comments.get(issue.id)?.some((comment) => comment.id === waiting.commentId)) continue;
        const body = await withPriority("interactive", CALLER, () => this.deps.linear.commentBody(waiting.commentId!)).catch(() => null);
        if (body !== null) comments.set(issue.id, [...comments.get(issue.id) ?? [], { id: waiting.commentId, body, createdAt: "" }]);
      }
    }
    const drafts: Draft[] = [];
    for (const issue of issues) {
      const known = cached(issue);
      const waiting = (await record(issue.id))?.waiting;
      const text = known?.text ?? selectAskText({ needsYou: isNeedsYou(issue), manual: manual(issue), waitCommentId: waiting?.commentId ?? null, comments: comments.get(issue.id) ?? [] }, issue);
      if (!known) this.cache.set(issue.id, { updatedAt: issue.updatedAt, text });
      const subIssue = isNeedsYou(issue) || manual(issue);
      const ticketId = subIssue && issue.parentId ? issue.parentId : issue.id;
      const ticketIdentifier = subIssue && issue.parentId ? issue.parentIdentifier ?? issue.identifier : issue.identifier;
      const ticketRecord = await record(ticketId);
      const asking = needsYouById.get(issue.id)?.agentId ?? (issue.id === ticketId ? ticketRecord?.agentId ?? null : null);
      const route = askRoute({ manual: manual(issue), asking, live: agents.live, history: Boolean(ticketRecord) || needsYouById.has(issue.id) || agents.issues.has(ticketId) });
      drafts.push({ issue, manual: manual(issue), text, needsYou: isNeedsYou(issue) ? issue.id : null, route: route.route, agentId: route.agentId, ticketAgentId: agents.newest.get(ticketId) ?? null, ticketId, ticketIdentifier });
    }
    return drafts;
  }

  // This host's unarchived agents: who is live, which tickets have an agent at all, and the
  // newest live root agent per ticket (the one a comment on the ticket reaches, as in the relay).
  private async agentIndex(paseo: PaseoApi | null): Promise<{ live: Set<string>; issues: Set<string>; newest: Map<string, string> }> {
    const live = new Set<string>();
    const issues = new Set<string>();
    const newestAgent = new Map<string, { id: string; createdAt: string }>();
    const newest = new Map<string, string>();
    if (!paseo) return { live, issues, newest };
    try {
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: AGENT_PAGE, ...(cursor ? { cursor } : {}) } });
        for (const { agent } of page.entries) {
          if (LIVE_AGENT[agent.status]) live.add(agent.id);
          const issueId = agent.labels?.["linear.issueId"];
          if (!issueId || agent.labels?.["paseo.parent-agent-id"]) continue;
          issues.add(issueId);
          const known = newestAgent.get(issueId);
          if (LIVE_AGENT[agent.status] && (!known || agent.createdAt > known.createdAt)) newestAgent.set(issueId, { id: agent.id, createdAt: agent.createdAt });
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor);
    } catch (error) {
      console.error(`[linear-tickets] reading this host's agents for the owner asks failed: ${error instanceof Error ? error.message : error}`);
    }
    for (const [issueId, agent] of newestAgent) newest.set(issueId, agent.id);
    return { live, issues, newest };
  }

  // ---------------------------------------------------------------------------------------------
  // Extraction

  private async extractionFor(issueId: string, hash: string): Promise<ExtractionState | undefined> {
    const memory = this.extractions.get(issueId);
    if (memory && memory.hash === hash) return memory;
    const stored = await this.readExtraction(issueId);
    if (!stored || stored.hash !== hash || stored.version !== EXTRACTION_VERSION) return undefined;
    const state: ExtractionState = { hash, value: stored.result, attempts: stored.attempts, nextAt: stored.nextAt ? Date.parse(stored.nextAt) || 0 : 0, running: false };
    this.extractions.set(issueId, state);
    return state;
  }

  private enqueue(job: ExtractionJob): void {
    if (this.stopped || this.queued.has(job.issueId)) return;
    this.queued.add(job.issueId);
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.running < EXTRACT_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.extract(job).catch((error: unknown) => console.error(`[linear-tickets] extracting the ask on ${job.input.identifier} failed: ${error instanceof Error ? error.message : error}`))
        .finally(() => {
          this.running--;
          this.queued.delete(job.issueId);
          if (!this.stopped) this.pump();
        });
    }
  }

  private async extract(job: ExtractionJob): Promise<void> {
    const state = this.extractions.get(job.issueId);
    if (!state || state.hash !== job.hash || state.value || state.running) return;
    state.running = true;
    const model = await this.deps.resolveModel().catch(() => "");
    const outcome: Extraction = model ? await this.deps.extract(job.input, model).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) })) : { ok: false, reason: "no model is configured for the owner asks" };
    const attempts = state.attempts + 1;
    state.attempts = attempts;
    state.running = false;
    if (outcome.ok) {
      state.value = outcome.value;
      state.nextAt = 0;
    } else {
      state.nextAt = attempts < MAX_ATTEMPTS ? this.now() + RETRY_DELAYS_MS[attempts - 1] : 0;
      console.error(`[linear-tickets] extracting the ask on ${job.input.identifier} failed (attempt ${attempts} of ${MAX_ATTEMPTS}): ${outcome.reason}`);
      if (attempts < MAX_ATTEMPTS) this.retryAfter(RETRY_DELAYS_MS[attempts - 1]);
    }
    const stored: StoredExtraction = { hash: job.hash, version: EXTRACTION_VERSION, model, result: state.value, attempts, nextAt: state.nextAt ? new Date(state.nextAt).toISOString() : null, at: new Date(this.now()).toISOString() };
    await this.write(this.extractionPath(job.issueId), JSON.stringify(stored)).catch((error: unknown) => console.error(`[linear-tickets] saving the extraction for ${job.input.identifier} failed: ${error instanceof Error ? error.message : error}`));
  }

  private retryAfter(ms: number): void {
    const timer = setTimeout(() => { this.retries.delete(timer); this.pump(); }, Math.max(0, ms));
    timer.unref?.();
    this.retries.add(timer);
  }

  private extractionPath(issueId: string): string {
    return join(this.directory, "extract", `${issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
  }

  private async readExtraction(issueId: string): Promise<StoredExtraction | null> {
    try {
      const stored = JSON.parse(await readFile(this.extractionPath(issueId), "utf8")) as StoredExtraction;
      return stored && typeof stored.hash === "string" ? stored : null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------------------------------------
  // The answers ledger: one answer per issue and answer text for ANSWER_KEEP_MS (across a reload),
  // and the answered set that keeps an answered ask out of the next snapshot.

  private async loadLedger(): Promise<void> {
    if (this.answersLoaded) return;
    this.answersLoaded = true;
    try {
      const stored = JSON.parse(await readFile(this.answersPath(), "utf8")) as Partial<Ledger>;
      if (stored.version !== LEDGER_VERSION) return;
      for (const [ref, record] of Object.entries(stored.answers ?? {})) if (record && this.now() - record.at < ANSWER_KEEP_MS) this.answers.set(ref, record);
      for (const [issueId, record] of Object.entries(stored.answered ?? {})) if (record && this.now() - record.at < ANSWERED_KEEP_MS) this.answered.set(issueId, record);
    } catch { /* no ledger yet */ }
  }

  private async answerRecord(key: string): Promise<AnswerRecord | null> {
    await this.loadLedger();
    const record = this.answers.get(key);
    return record && this.now() - record.at < ANSWER_KEEP_MS ? record : null;
  }

  // An answered issue stays hidden until Linear's `updatedAt` is later than the answer plus the
  // margin (the plugin's own record comment and state move land within it).
  private hidden(issue: OwnerAskIssue): boolean {
    const record = this.answered.get(issue.id);
    if (!record) return false;
    return (Date.parse(issue.updatedAt) || 0) <= record.at + ANSWER_HIDE_MS;
  }

  private async saveLedger(): Promise<void> {
    const ledger: Ledger = {
      version: LEDGER_VERSION,
      answers: Object.fromEntries([...this.answers].filter(([, record]) => this.now() - record.at < ANSWER_KEEP_MS)),
      answered: Object.fromEntries([...this.answered].filter(([, record]) => this.now() - record.at < ANSWERED_KEEP_MS)),
    };
    await this.write(this.answersPath(), JSON.stringify(ledger));
  }

  private answersPath(): string {
    return join(this.directory, "answers.json");
  }

  private async write(path: string, content: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
}
