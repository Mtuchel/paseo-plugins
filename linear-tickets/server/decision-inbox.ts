import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { askQuestionSchema, decisionReceiptSchema, type DecisionReceipt } from "../shared/contracts";
import { browserOwnerAskSchema, decisionHostSchema, isSourceReview, liveDecisionSchema, recoveryTicketPageSchema, recoveryTicketSchema, SOURCE_REVIEW_PAGE_LIMIT, SOURCE_REVIEW_PAGE_MAX, sourceReviewPageSchema, type BrowserDecisionAction, type DecisionHost, type DecisionView, type LiveDecision, type RecoveryTicketPage, type StewardFlow } from "../shared/decision-inbox";
import { summarizeDecisions } from "../shared/decision-summary";
import type { ActivationRoute } from "./activation";
import { decisionPage } from "./decision-page";
import type { OwnerAsks, OwnerAskSnapshot } from "./owner-asks";
import type { DeliveryResult, PermissionReplies, ReplyRecord } from "./permission-replies";
import { answerableQuestions, matchOption, questionAnswer, questionKey, questionsOf } from "./relay";
import { paseoHome } from "./ticket-mcp";
import { INBOX_DISPLAYED_HEADER } from "./inbox-transport";
import { CURATION_INTERVAL_MS, DecisionCuration, curateDecisions } from "./decision-curation";
import type { MergeStatusSnapshot } from "../shared/merge-status";

export type BrowserDecisionInboxDeps = {
  ownerAsks: Pick<OwnerAsks, "snapshot" | "answer" | "triage">;
  paseo: () => PaseoApi | null;
  replies: PermissionReplies;
  peers: () => Promise<string[]>;
  canonicalPeer: () => Promise<string | null>;
  host?: string;
  backendInstanceId?: () => string | undefined;
  agentUrl?: (id: string) => Promise<string | null>;
  // The ticket steward's flow summary for the page's Flow section (Steward.snapshot, steward.ts).
  // Absent: the page shows no flow.
  flow?: () => Promise<StewardFlow>;
  mergeStatus?: () => Promise<MergeStatusSnapshot>;
  directory?: string;
  now?: () => number;
};
const OWNER_CACHE_MS = CURATION_INTERVAL_MS;
const READ_TIMEOUT_MS = 5_000;
// How long this host's own snapshot answers reads from memory: a peer's five-second read must not
// wait for a Linear scan, a Paseo listing or the steward, and the read after it must be instant.
const LOCAL_FRESH_MS = 5_000;
const LOCAL_STALE_MS = 120_000;
const TRANSPORT_CACHE_MS = 30_000;
const ACTION_TIMEOUT_MS = 65_000;
const PREFIX = "decision-inbox:";
const json = (status: number, value: unknown) => ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(value) });
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);
class InboxError extends Error {
  constructor(readonly status: number, message: string, readonly outcomeUnknown = false) { super(message); }
}
const actionSchema = z.object({
  host: z.string().min(1), target: z.enum(["owner", "live"]), operation: z.enum(["answer", "triage"]),
  backendInstanceId: z.string().uuid().optional(),
  issueId: z.string().min(1).optional(), sourceId: z.string().min(1).optional(), agentId: z.string().min(1).optional(), requestId: z.string().min(1).optional(),
  revision: z.string().min(1), answers: z.record(z.string(), z.string().max(4000)).optional(),
  note: z.string().max(4000).optional(), done: z.boolean().optional(),
  action: z.enum(["research", "delegate", "defer", "reopen"]).optional(), until: z.string().datetime({ offset: true }).optional(),
  actionId: z.string().min(1).optional(), behavior: z.enum(["allow", "deny"]).optional(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.target === "owner" ? !value.issueId || value.agentId !== undefined || value.requestId !== undefined : !value.agentId || !value.requestId || value.issueId !== undefined || value.sourceId !== undefined) invalid("Identify exactly one owner ask or live request.");
  if (value.operation === "triage") {
    if (!value.action || value.answers !== undefined || value.actionId !== undefined || value.behavior !== undefined || value.done !== undefined) invalid("Triage requires one action and no answer or permission fields.");
    if (value.action === "defer" ? !value.until : value.until !== undefined) invalid("Only Defer requires an expiry.");
    if ((value.action === "research" || value.action === "delegate") && !value.note?.trim()) invalid("Write an explicit research instruction or delegation scope.");
  } else {
    if (value.action !== undefined || value.until !== undefined) invalid("An answer cannot include triage fields.");
    if (value.target === "owner" && (value.answers === undefined || value.actionId !== undefined || value.behavior !== undefined)) invalid("Owner answers require answers, not permission fields.");
    if (value.target === "live" && value.done !== undefined) invalid("A live response cannot mark a Linear task done.");
  }
});
// Reject unknown peer fields at every object boundary instead of silently stripping a malformed response.
const peerQuestionSchema = askQuestionSchema.extend({ options: z.array(askQuestionSchema.shape.options.element.strict()) }).strict();
// The strict ask shape both peer answers carry: one host snapshot and one paged source review.
const peerAskSchema = browserOwnerAskSchema.extend({ questions: z.array(peerQuestionSchema) }).strict();
const peerSchema = decisionHostSchema.extend({
  host: z.string().min(1), updatedAt: z.string().datetime({ offset: true }),
  asks: z.array(peerAskSchema),
  live: z.array(liveDecisionSchema.extend({ questions: z.array(liveDecisionSchema.shape.questions.element.extend({ options: z.array(askQuestionSchema.shape.options.element.strict()) }).strict()), actions: z.array(liveDecisionSchema.shape.actions.element.strict()) }).strict()),
  history: z.array(decisionReceiptSchema.strict()),
}).strict();
// A paged source review read (shared/decision-inbox.ts): strict at the page boundary too, so an
// extended or malformed page from the canonical host is refused rather than half-shown.
const peerReviewPageSchema = sourceReviewPageSchema.extend({ asks: z.array(peerAskSchema) }).strict();
// A recovery ticket page read from a peer: strict at the page boundary and at every ticket, so an
// extended or malformed list is refused instead of half-shown.
const peerFlowPageSchema = recoveryTicketPageSchema.extend({ tickets: z.array(recoveryTicketSchema.strict()) }).strict();
const actionResultSchema = z.object({ delivered: z.string(), message: z.string() }).strict();
const errorSchema = z.object({ error: z.string(), outcomeUnknown: z.boolean().optional() }).strict();
const deferralSchema = z.object({ agentId: z.string(), requestId: z.string(), revision: z.string(), until: z.string().datetime() }).strict();
const deferralFileSchema = z.object({ deferrals: z.record(z.string(), deferralSchema), history: z.array(decisionReceiptSchema.strict()) }).strict();
type DeferralFile = z.infer<typeof deferralFileSchema>;
type OwnerSnapshot = OwnerAskSnapshot;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function hash(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
// Unlike the deputy's question identity, the browser revision includes every original request field.
function revision(request: AgentPermissionRequest): string { return hash(request); }
// A peer feed carries only the recovery tickets its own decisions reference — exactly the
// identifiers curation joins a task's blocked work and waiting agent on (decision-curation.ts) —
// plus `ticketCount`, the steward's total, so a reader can see the shipped list is partial. The
// whole list stays readable on demand (GET /api/decisions/flow), and this host's own page keeps it.
function referencedTickets(host: DecisionHost): DecisionHost {
  const flow = host.flow;
  if (!flow?.tickets) return host;
  const referenced = new Set<string>();
  for (const ask of host.asks) if (ask.ticketIdentifier) referenced.add(ask.ticketIdentifier);
  for (const live of host.live) if (live.identifier) referenced.add(live.identifier);
  return { ...host, flow: { ...flow, tickets: flow.tickets.filter((ticket) => referenced.has(ticket.identifier)), ticketCount: flow.tickets.length } };
}
function peerOrigin(peer: string): string {
  const url = new URL(peer);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Decision peers must be HTTP(S) origins without credentials, paths or query strings.");
  return url.origin;
}
async function deadline<T>(work: () => Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Deadline exceeded")), timeout); })]);
  } finally { clearTimeout(timer); }
}
function permissionActions(request: AgentPermissionRequest): LiveDecision["actions"] {
  return request.actions?.length ? request.actions.map(({ id, label, behavior }) => ({ id, label, behavior })) : [
    { id: "reject", label: "Deny", behavior: "deny" },
    { id: "accept", label: request.kind === "plan" ? "Implement" : "Accept", behavior: "allow" },
  ];
}
function normalizedQuestions(request: AgentPermissionRequest): LiveDecision["questions"] {
  return questionsOf(request).map((item, index) => {
    const raw = item as { question?: string; header?: string; multiSelect?: boolean; allowEmpty?: boolean; options?: { label?: string; description?: string }[] };
    return { key: questionKey(item, index), question: raw.question || raw.header || request.title || request.name,
      options: (raw.options ?? []).map((option) => ({ label: option.label ?? "", description: option.description ?? "" })),
      // OMP select rounds explicitly supply false; do not infer multi-select from their labels.
      multiSelect: raw.multiSelect === true, allowEmpty: raw.allowEmpty === true };
  });
}
function sourceOf(request: AgentPermissionRequest): string {
  return [request.description, request.detail === undefined ? null : JSON.stringify(request.detail, null, 2), request.input === undefined ? null : JSON.stringify(request.input, null, 2)].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
}
function triageText(action: "research" | "delegate", note: string): string {
  return action === "research"
    ? `Research only: gather evidence for this question and report findings. Do not implement, approve, accept a recommendation, change policy or close the owner task.\nOwner instruction: ${note}`
    : `Delegate only reversible technical implementation within the already approved scope below. Do not decide business policy, permissions, spending, destructive or production actions; do not override repository rules, accept recommendations or close the owner task. Stop and ask if the scope needs additional authority.\nOwner scope: ${note}`;
}
// The bounds of one source review page (shared/decision-inbox.ts). A page stays small on purpose:
// a value that is not exactly an in-range whole number is the client's error, never a silently
// clamped default or a widened feed.
function reviewPaging(search: string): { offset: number; limit: number; q: string } {
  const params = new URLSearchParams(search);
  const bound = (name: string, fallback: number, min: number, max: number): number => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new InboxError(400, `Invalid ${name}: use a whole number from ${min} to ${max}.`);
    return value;
  };
  const q = params.get("q") ?? "";
  if (q.length > 200) throw new InboxError(400, "The source review search is longer than 200 characters.");
  return { offset: bound("offset", 0, 0, Number.MAX_SAFE_INTEGER), limit: bound("limit", SOURCE_REVIEW_PAGE_LIMIT, 1, SOURCE_REVIEW_PAGE_MAX), q };
}

export class BrowserDecisionInbox {
  private readonly host: string;
  private readonly directory: string;
  private readonly now: () => number;
  private ownerCache: { snapshot: OwnerSnapshot; checkedAt: number; error: string | null } | null = null;
  private ownerFlight: Promise<NonNullable<BrowserDecisionInbox["ownerCache"]>> | null = null;
  private ownerGeneration = 0;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private readonly curation: DecisionCuration;
  // This host's own snapshot, served from memory to the peer feed and the page (localSnapshot).
  private localCache: { host: DecisionHost; at: number; generation: number; canonical: boolean; ownerCheckedAt: number | null } | null = null;
  private localFlight: { canonical: boolean; ownerCheckedAt: number | null; promise: Promise<DecisionHost> } | null = null;
  private transportCache: { view: DecisionView; at: number; generation: number } | null = null;
  private transportFlight: Promise<DecisionView> | null = null;
  private readonly peerFlights = new Map<string, Promise<DecisionHost>>();
  private readonly peerCache = new Map<string, { snapshot: DecisionHost | null; error: string | null; at: number; generation: number }>();

  constructor(private readonly deps: BrowserDecisionInboxDeps) {
    this.host = deps.host ?? hostname().replace(/\.local$/, "");
    this.directory = deps.directory ?? join(paseoHome(), "linear-tickets", "decision-inbox");
    this.now = deps.now ?? Date.now;
    this.curation = new DecisionCuration(() => this.collectView(), this.now);
  }

  // Parent starts this once Paseo/peer discovery is attached, and stops it on plugin disposal.
  // start() collects immediately; the daemon interval continues with every browser closed.
  start(): Promise<void> { return this.curation.start(); }
  stop(): void { this.curation.stop(); }
  refresh(): Promise<void> {
    this.ownerGeneration++;
    this.peerFlights.clear();
    this.localFlight = null;
    this.ownerCache = null;
    this.ownerFlight = null;
    this.transportFlight = null;
    this.curation.invalidate();
    return this.curation.refresh();
  }

  readonly route: ActivationRoute = async ({ method, path, search, headers, body }) => {
    if (path !== "/decisions" && path !== "/api/decisions" && path !== "/api/decisions/local" && path !== "/api/decisions/action"
      && path !== "/api/decisions/reviews" && path !== "/api/decisions/reviews/local" && path !== "/api/decisions/flow" && path !== "/api/decisions/flow/local") return null;
    try {
      if (path === "/api/decisions/action") {
        if (method !== "POST") return json(405, { error: "Use POST for a decision action." });
        let sameOrigin = !headers.origin;
        try {
          if (typeof headers.origin === "string") {
            const origin = new URL(headers.origin);
            sameOrigin = /^https?:$/.test(origin.protocol) && origin.host === headers.host && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash;
          }
        } catch { sameOrigin = false; }
        if (!sameOrigin || headers["x-review-action"] !== "1" || !/^application\/json(?:\s*;|\s*$)/i.test(String(headers["content-type"] ?? ""))) return json(403, { error: "Not allowed." });
        if (Buffer.byteLength(body) > 16 * 1024) return json(413, { error: "Decision action exceeds 16 KiB." });
        let raw: unknown;
        try { raw = JSON.parse(body); } catch { return json(400, { error: "The request is not JSON." }); }
        const parsed = actionSchema.safeParse(raw);
        if (!parsed.success) return json(400, { error: parsed.error.issues.map((issue) => issue.message).join(" ") });
        try { return await this.action(parsed.data); }
        finally {
          this.ownerGeneration++;
          this.peerFlights.clear();
          this.localFlight = null;
          this.ownerCache = null;
          this.ownerFlight = null;
          this.transportFlight = null;
          this.curation.invalidate();
          // The answered source may not be served again: collect the replacement snapshot right
          // away, so the page's post-answer refresh and the next peer read join it instead of
          // waiting for a cold collection. A background compute reports to nobody.
          void this.localSnapshot().catch(() => undefined);
        }
      }
      if (method !== "GET") return json(405, { error: "Use GET for the decision inbox." });
      // The peer feed ships only the recovery tickets its decisions reference (referencedTickets).
      if (path === "/api/decisions/local") return json(200, referencedTickets(await this.localSnapshot()));
      if (path === "/api/decisions/reviews" || path === "/api/decisions/reviews/local") return await this.reviewPage(path === "/api/decisions/reviews/local", search ?? "");
      if (path === "/api/decisions/flow" || path === "/api/decisions/flow/local") return await this.flowPage(path === "/api/decisions/flow/local", search ?? "");
      const view = await this.view();
      if (path === "/api/decisions") return json(200, view);
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: decisionPage(view) };
    } catch (error) {
      return json(error instanceof InboxError ? error.status : 503, { error: reasonOf(error), ...(error instanceof InboxError && error.outcomeUnknown ? { outcomeUnknown: true } : {}) });
    }
  };

  // This host's own snapshot, served from memory: the peer feed and the page's transport reads
  // must not wait for a fresh Linear scan, Paseo listing or steward on every request, and the read
  // that follows a five-second deadline must find the collection already done. An entry answers
  // the transport generation it was computed under: while that matches, an entry younger than
  // LOCAL_FRESH_MS is returned as is, and one younger than LOCAL_STALE_MS — or one computed before
  // the latest owner collection landed — is returned immediately while a recompute runs in the
  // background. Anything else (no entry, superseded generation, older than stale) is awaited. An
  // answer or refresh bumps the generation, so an answered source is never served again; a landed
  // owner collection is carried by the next read's background recompute without a read waiting —
  // except for the background pass (`awaitOwner`), which publishes the collection it awaited. A
  // canonical flag that does not match the entry computes for that flag.
  private async localSnapshot(canonical?: boolean, awaitOwner = false): Promise<DecisionHost> {
    const errors: string[] = [];
    if (canonical === undefined) {
      try { canonical = await this.deps.canonicalPeer() === null; }
      catch (error) { canonical = false; errors.push(`Canonical source unavailable: ${reasonOf(error)}`); }
    }
    const withErrors = async (host: DecisionHost): Promise<DecisionHost> => ({
      ...host,
      // Overlay the live service even when the decision snapshot is cached. A source-review scan
      // or the fifteen-minute curator must never determine merge-status freshness.
      ...(canonical && this.deps.mergeStatus ? { mergeStatus: await this.deps.mergeStatus() } : {}),
      error: errors.length ? [host.error, ...errors].filter(Boolean).join("\n") : host.error,
    });
    const entry = this.localCache;
    const ownerNow = this.ownerCache?.checkedAt ?? null;
    if (entry && entry.generation === this.ownerGeneration && entry.canonical === canonical) {
      const age = this.now() - entry.at;
      const ownerCurrent = entry.ownerCheckedAt === ownerNow;
      if (age < LOCAL_FRESH_MS && ownerCurrent) return withErrors(entry.host);
      if (age < LOCAL_STALE_MS && (ownerCurrent || !awaitOwner)) {
        void this.computeLocal(canonical).catch(() => undefined);
        return withErrors(entry.host);
      }
    }
    // A caller that waits for the latest owner collection does not join a compute begun before it
    // landed: that compute finishes first, and the one started after it carries the collection.
    const flight = this.localFlight;
    if (awaitOwner && flight?.canonical === canonical && flight.ownerCheckedAt !== ownerNow) await flight.promise.catch(() => undefined);
    return withErrors(await this.computeLocal(canonical));
  }

  // One collection in flight per canonical flag: every awaiting caller shares it, and a caller
  // whose flag does not match collects its own. A collection begun under an older generation never
  // writes the cache (the fence ownerSnapshot uses); a failed collection keeps the previous entry
  // and rejects only its awaiters, while a background one is not awaited by anybody.
  private computeLocal(canonical: boolean): Promise<DecisionHost> {
    if (this.localFlight?.canonical === canonical) return this.localFlight.promise;
    const generation = this.ownerGeneration;
    // The owner collection this compute starts from: stamping the one current when it lands could
    // mark a snapshot built from older asks as current.
    const ownerCheckedAt = this.ownerCache?.checkedAt ?? null;
    const flight = this.local(canonical).then((host) => {
      if (generation === this.ownerGeneration) {
        this.localCache = { host, at: this.now(), generation, canonical, ownerCheckedAt };
      }
      return host;
    });
    this.localFlight = { canonical, ownerCheckedAt, promise: flight };
    void flight.finally(() => { if (this.localFlight?.promise === flight) this.localFlight = null; }).catch(() => undefined);
    return flight;
  }

  private async ownerSnapshot(): Promise<NonNullable<BrowserDecisionInbox["ownerCache"]>> {
    if (this.ownerCache && this.now() - this.ownerCache.checkedAt < OWNER_CACHE_MS) return this.ownerCache;
    if (this.ownerFlight) return this.ownerFlight;
    const generation = this.ownerGeneration;
    const flight = (async () => {
      const checkedAt = this.now();
      const updatedAt = new Date(checkedAt).toISOString();
      let result: NonNullable<BrowserDecisionInbox["ownerCache"]>;
      try { result = { snapshot: await this.deps.ownerAsks.snapshot(this.deps.paseo(), true), checkedAt, error: null }; }
      catch (error) { result = { snapshot: this.ownerCache?.snapshot ?? { asks: [], history: [], updatedAt }, checkedAt, error: `Owner asks unavailable (checked ${updatedAt}): ${reasonOf(error)}` }; }
      if (generation === this.ownerGeneration) this.ownerCache = result;
      return result;
    })();
    this.ownerFlight = flight;
    try { return await flight; } finally { if (this.ownerFlight === flight) this.ownerFlight = null; }
  }

  async local(canonical?: boolean): Promise<DecisionHost> {
    const errors: string[] = [];
    if (canonical === undefined) {
      try { canonical = await this.deps.canonicalPeer() === null; }
      catch (error) { canonical = false; errors.push(`Canonical source unavailable: ${reasonOf(error)}`); }
    }
    // Owner collection is background work, never a prerequisite for reading or answering
    // live questions. The peer's deadline must not expire while this host scans Linear.
    if (canonical) void this.ownerSnapshot();
    const [deferrals, records] = await Promise.all([
      this.readDeferrals().catch((error) => { errors.push(`Live deferrals unavailable: ${reasonOf(error)}`); return { deferrals: {}, history: [] } as DeferralFile; }),
      this.deps.replies.records().catch((error) => { errors.push(`Live history unavailable: ${reasonOf(error)}`); return {} as Record<string, ReplyRecord>; }),
    ]);
    const owner = canonical ? this.ownerCache : null;
    if (canonical && !owner) errors.push("Owner asks are being collected; live agent questions remain available.");
    else if (owner && this.now() - owner.checkedAt >= OWNER_CACHE_MS) errors.push("Owner asks are refreshing; showing the previous collection.");
    if (owner?.error) errors.push(owner.error);
    if (owner && "coverage" in owner.snapshot) errors.push(...owner.snapshot.coverage ?? []);
    const live: LiveDecision[] = [];
    const paseo = this.deps.paseo();
    if (!paseo) errors.push("Live agents unavailable: Paseo is disconnected.");
    else {
      try {
        let cursor: string | undefined;
        const seen = new Set<string>();
        const seenRequests = new Set<string>();
        do {
          const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
          for (const { agent } of page.entries) {
            if (agent.archivedAt) continue;
            for (const request of agent.pendingPermissions ?? []) {
              const key = hash([agent.id, request.id]);
              if (seenRequests.has(key)) continue;
              seenRequests.add(key);
              const currentRevision = revision(request);
              const deferred = deferrals.deferrals[key];
              // Checked replies from Linear, native and browser bind the same exact round.
              const activity = Object.values(records).filter(record => record.agentId === agent.id
                && record.requestId === request.id && record.request && revision(record.request) === currentRevision);
              if (activity.some(record => record.status === "applied")) continue;
              const deliveryUnknown = activity.some(record => ["reserved", "submitted", "unconfirmed", "sent", "unchecked"].includes(record.status));
              let agentUrl: string | null = null;
              try { agentUrl = await this.deps.agentUrl?.(agent.id) ?? null; }
              catch (error) { errors.push(`Agent link ${agent.id} unavailable: ${reasonOf(error)}`); }
              live.push({ agentId: agent.id, requestId: request.id, revision: currentRevision,
                title: request.title || request.name, identifier: agent.labels?.["linear.identifier"] ?? null,
                issueUrl: agent.labels?.["linear.url"] ?? null, agentUrl, source: sourceOf(request),
                questions: request.kind === "question" ? normalizedQuestions(request) : [], kind: request.kind === "question" ? "question" : "permission",
                actions: request.kind === "question" ? [] : permissionActions(request),
                deliveryUnknown,
                deferredUntil: deferred?.revision === currentRevision && Date.parse(deferred.until) > this.now() ? deferred.until : null });
            }
          }
          cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
          if (page.pageInfo.hasMore && (!cursor || seen.has(cursor))) throw new Error("Paseo returned an incomplete or repeated agent-page cursor.");
          if (cursor) seen.add(cursor);
        } while (cursor);
      } catch (error) { errors.push(`Live agents incomplete: ${reasonOf(error)}`); }
    }
    const receipts = Object.values(records).filter((record) => record.request && (record.ref.startsWith(PREFIX) || record.responder.kind === "owner")).map((record): DecisionReceipt => ({
      id: record.ref, issueId: record.issueId ?? `agent:${record.agentId}`, identifier: record.agentId, revision: revision(record.request!),
      action: record.intent ? (record.text.startsWith("Research only:") ? "research" : "delegate") : "answer",
      text: record.text, at: record.at, delivery: record.status,
    }));
    // Never hide every ask on a ticket because one agent's request disappeared. OwnerAsks
    // resolves the exact wait-comment source; curation deduplicates only source identities.
    // Nonurgent source reviews are not actionable: the feeds carry them as a count and the page
    // reads them in pages (reviewPage), never as part of `asks`.
    const ownerAsks = owner?.snapshot.asks ?? [];
    const asks = ownerAsks.filter((ask) => !isSourceReview(ask));
    return { host: this.host, asks, ...(owner ? { sourceReviews: ownerAsks.length - asks.length } : {}), live,
      backendInstanceId: this.deps.backendInstanceId?.(),
      history: [...owner?.snapshot.history ?? [], ...receipts, ...deferrals.history].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
      updatedAt: owner?.snapshot.updatedAt ?? new Date(this.now()).toISOString(), error: errors.length ? errors.join("\n") : null,
      // The steward's flow summary (README, "Ticket steward"). Its failure is a page warning, not
      // an inbox error: the decisions below are still answerable.
      flow: await this.readFlow(errors) };
  }

  // One page of the canonical host's withheld source reviews (shared/decision-inbox.ts): the
  // local route serves this host's own owner cache, and every other host proxies the same read to
  // the canonical host, so a page always lists the canonical owner's sources and never reads
  // local Linear. Source order, bounded slice: the whole withheld feed is what broke the peers.
  private async reviewPage(locallyServed: boolean, search: string) {
    const { offset, limit, q } = reviewPaging(search);
    const canonicalPeer = await this.deps.canonicalPeer();
    if (canonicalPeer === null) {
      // The collection that owns these sources may still be running. An empty page would read as
      // "no source reviews" and hide every one of them, so a missing collection says so instead
      // and lets the background collection land.
      void this.ownerSnapshot();
      const owner = this.ownerCache;
      if (!owner) throw new InboxError(503, "Owner asks are being collected; source reviews are not available yet.");
      const terms = q.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
      // A term must occur in the row the page renders; searching the JSON of the whole row is the
      // matcher the page uses, so paged results and the page's own filter agree.
      const rows = owner.snapshot.asks.filter((ask) => isSourceReview(ask) && terms.every((term) => JSON.stringify([this.host, ask]).toLowerCase().includes(term)));
      const backendInstanceId = this.deps.backendInstanceId?.();
      return json(200, { host: this.host, ...(backendInstanceId ? { backendInstanceId } : {}), updatedAt: owner.snapshot.updatedAt, total: rows.length, offset, asks: rows.slice(offset, offset + limit) });
    }
    if (locallyServed) throw new InboxError(404, "Only the canonical host serves its own source review pages; the canonical host's are read through /api/decisions/reviews.");
    const peer = peerOrigin(canonicalPeer);
    // The forwarded query is rebuilt from the validated values: the canonical host sees exactly
    // the page this host admitted and nothing else the caller sent.
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (q) params.set("q", q);
    return json(200, await deadline(async () => {
      const response = await fetch(`${peer}/api/decisions/reviews/local?${params}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Source reviews unavailable from ${peer}: HTTP ${response.status}`);
      const parsed = peerReviewPageSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error(`The canonical host ${peer} returned an invalid source review page.`);
      return parsed.data;
    }, READ_TIMEOUT_MS));
  }

  // The steward's flow for the page's Flow section; its failure is named there. A flow that ships
  // its tickets carries their total as well, so the page reads the count of a full list exactly
  // the way it reads a partial peer feed's `ticketCount` (shared/decision-inbox.ts).
  private async readFlow(errors: string[]): Promise<StewardFlow | null> {
    if (!this.deps.flow) return null;
    try {
      const flow = await this.deps.flow();
      return flow.tickets === undefined ? flow : { ...flow, ticketCount: flow.tickets.length };
    } catch (error) {
      const reason = `Ticket flow unavailable: ${reasonOf(error)}`;
      errors.push(reason);
      return { at: null, counts: {}, oldest: [], error: reason };
    }
  }

  // The full recovery evidence of this host, for the page's on-demand list (README, "Decision
  // inbox"): `flow.tickets` in a peer feed is reference-only, so reading the rest is always a
  // request to the host that owns them. This host's own page reads them here, never through a URL
  // from a payload.
  private async localTickets(): Promise<RecoveryTicketPage> {
    if (!this.deps.flow) throw new InboxError(503, "This host has no ticket flow configured, so it has no recovery evidence to read.");
    try { return { host: this.host, tickets: (await this.deps.flow()).tickets ?? [] }; }
    catch (error) { throw new InboxError(503, `Ticket flow unavailable: ${reasonOf(error)}`); }
  }

  // One host's full recovery evidence: this host's own list, or the same read proxied to the peer
  // that owns the host name. The name resolves to a configured origin whose current local snapshot
  // calls itself that host — the origin a URL comes from is never a payload's to choose — and the
  // read is bounded like the review pages: a peer that does not answer inside the deadline is an
  // unavailable source, not an inbox that hangs.
  private async flowPage(locallyServed: boolean, search: string) {
    const query = new URLSearchParams(search).get("host");
    if (locallyServed) {
      // `/flow/local` is this host's own read; a `host` that is not this host's is the client's error.
      if (query !== null && query !== this.host) throw new InboxError(404, "The named host does not serve its recovery evidence here; read it through /api/decisions/flow.");
      return json(200, await this.localTickets());
    }
    if (!query) throw new InboxError(400, "Name the decision host whose recovery evidence is read.");
    if (query === this.host) return json(200, await this.localTickets());
    // Only a host this page already collected is reachable, and only one peer may own the name.
    const configured = [...new Set((await this.deps.peers()).map(peerOrigin))];
    const sources = await Promise.all(configured.map(async (peer) => ({ peer, snapshot: await this.readPeer(peer).catch(() => null) })));
    const matches = sources.filter((source) => source.snapshot?.host === query);
    if (matches.length !== 1) throw new InboxError(404, "Unknown or unavailable decision host; no recovery evidence was read.");
    const peer = matches[0].peer;
    return json(200, await deadline(async () => {
      const response = await fetch(`${peer}/api/decisions/flow/local`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Recovery tickets unavailable from ${peer}: HTTP ${response.status}`);
      const parsed = peerFlowPageSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error(`The decision host ${peer} returned an invalid recovery ticket list.`);
      if (parsed.data.host !== query) throw new Error(`The decision host ${peer} answered for ${parsed.data.host} instead of ${query}.`);
      return parsed.data;
    }, READ_TIMEOUT_MS));
  }

  private async readPeer(peer: string): Promise<DecisionHost> {
    const pending = this.peerFlights.get(peer);
    if (pending) return pending;
    const flight = deadline(async () => {
      const response = await fetch(`${peer}/api/decisions/local`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = peerSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The peer returned an invalid decision snapshot.");
      return parsed.data;
    }, READ_TIMEOUT_MS);
    const generation = this.ownerGeneration;
    this.peerFlights.set(peer, flight);
    try {
      const snapshot = await flight;
      if (generation === this.ownerGeneration) {
        this.peerCache.set(peer, { snapshot, error: null, at: this.now(), generation });
        this.transportCache = null;
      }
      return snapshot;
    } catch (error) {
      if (generation === this.ownerGeneration) {
        this.peerCache.set(peer, { snapshot: null, error: reasonOf(error), at: this.now(), generation });
        this.transportCache = null;
      }
      throw error;
    }
    finally { if (this.peerFlights.get(peer) === flight) this.peerFlights.delete(peer); }
  }

  async view(): Promise<DecisionView> {
    // Keep the fifteen-minute Linear scan independent of the browser transport. A page read
    // refreshes live requests and peer reachability without waiting for that scan to finish.
    void this.curation.view();
    const generation = this.ownerGeneration;
    let view: DecisionView;
    if (this.transportCache?.generation === generation && this.now() - this.transportCache.at < TRANSPORT_CACHE_MS) {
      view = this.transportCache.view;
    } else {
      if (!this.transportFlight) {
        const flight = this.collectView(false).then(view => {
          if (generation === this.ownerGeneration) this.transportCache = { view, at: this.now(), generation };
          return view;
        });
        this.transportFlight = flight;
        void flight.finally(() => { if (this.transportFlight === flight) this.transportFlight = null; }).catch(() => {});
      }
      view = await this.transportFlight;
    }
    if (generation !== this.ownerGeneration) return this.view();
    const current = { ...view, tasks: curateDecisions(view, this.now()), curation: this.curation.current().curation };
    return { ...current, summary: summarizeDecisions(current, this.now()) };
  }

  private async collectView(collectOwners = true): Promise<DecisionView> {
    // Only the daemon-owned fifteen-minute pass forces a full owner collection.
    if (collectOwners && !this.ownerFlight) this.ownerCache = null;
    const [configuredPeers, canonicalPeer] = await Promise.all([this.deps.peers(), this.deps.canonicalPeer()]);
    if (collectOwners && canonicalPeer === null) await this.ownerSnapshot();
    // The background pass publishes the owner collection it just awaited, so it waits for the
    // snapshot that carries it; interactive reads answer from memory (localSnapshot).
    const localPromise = this.localSnapshot(canonicalPeer === null, collectOwners);
    const peers = [...new Set(configuredPeers)].map(configured => {
      try { return { configured, peer: peerOrigin(configured), error: null }; }
      catch (error) { return { configured, peer: null, error: reasonOf(error) }; }
    });
    const reads = peers.flatMap(({ peer }) => {
      if (!peer) return [];
      const cached = this.peerCache.get(peer);
      if (!collectOwners && cached?.generation === this.ownerGeneration && this.now() - cached.at < TRANSPORT_CACHE_MS) return [];
      return [this.readPeer(peer).catch(() => null)];
    });
    // Background collection can wait for coverage. Interactive reads never wait for another host.
    if (collectOwners) await Promise.all(reads);
    // This host's snapshot is shared with the memory the peer feed reads (localSnapshot), so the
    // page composes its own entry instead of writing a transport-only error into that snapshot.
    let local = await localPromise;
    const sources = peers.map(({ configured, peer, error }) => {
      const cached = peer ? this.peerCache.get(peer) : undefined;
      const current = cached?.generation === this.ownerGeneration && this.now() - cached.at < TRANSPORT_CACHE_MS;
      // No current snapshot yet, but its read is under way: a page shows that host as being read,
      // not as failed, and asks again once the read can have landed.
      const reading = !error && !current && peer !== null && this.peerFlights.has(peer);
      return { configured, peer, reading, snapshot: current ? cached.snapshot : null,
        error: error ?? (current ? cached.error : "Refreshing this host; no current snapshot is available.") };
    });
    const unreachable: string[] = [];
    const reading: string[] = [];
    let canonicalHost: string | null = canonicalPeer === null ? this.host : null;
    let canonicalOrigin: string | null = null;
    if (canonicalPeer !== null) {
      try { canonicalOrigin = peerOrigin(canonicalPeer); }
      catch (error) { local = { ...local, error: [local.error, `Canonical source ${canonicalPeer} unavailable: ${reasonOf(error)}`].filter(Boolean).join("\n") }; }
    }
    const identities = new Set([this.host]);
    const hosts: DecisionHost[] = [];
    for (const source of sources) {
      if (!source.snapshot || identities.has(source.snapshot.host)) {
        unreachable.push(source.configured);
        if (source.reading) reading.push(source.configured);
        hosts.push({ host: source.configured, asks: [], live: [], history: [], updatedAt: new Date(this.now()).toISOString(), error: `Decision source ${source.configured} unavailable: ${source.error ?? "duplicate host identity"}`, flow: null });
        continue;
      }
      identities.add(source.snapshot.host);
      const canonical = canonicalOrigin !== null && source.peer === canonicalOrigin;
      if (canonical) canonicalHost = source.snapshot.host;
      hosts.push({ ...source.snapshot, asks: canonical ? source.snapshot.asks : [],
        // The count, like the asks it counts, belongs to the canonical owner's inbox only: a
        // non-canonical peer's reviews are not this page's to summarize.
        sourceReviews: canonical ? source.snapshot.sourceReviews : undefined,
        mergeStatus: canonical ? source.snapshot.mergeStatus : undefined,
        history: canonical ? source.snapshot.history : source.snapshot.history.filter((receipt) => receipt.id.startsWith(PREFIX)) });
    }
    // A canonical host whose first read is still under way is named by canonicalReading; the
    // failure note below is reserved for a read that ended without a usable snapshot.
    const canonicalReading = canonicalPeer !== null && canonicalHost === null && canonicalOrigin !== null && sources.some((source) => source.reading && source.peer === canonicalOrigin);
    if (canonicalPeer !== null && canonicalHost === null) {
      if (!unreachable.includes(canonicalPeer)) unreachable.push(canonicalPeer);
      if (!canonicalReading) local = { ...local, error: [local.error, `Canonical owner asks unavailable from ${canonicalPeer}; no local Linear fallback is used.`].filter(Boolean).join("\n") };
    }
    return { hosts: [local, ...hosts], canonicalHost, unreachable, ...(reading.length ? { reading } : {}), ...(canonicalReading ? { canonicalReading } : {}) };
  }

  private async action(input: BrowserDecisionAction) {
    if (input.host === this.host) {
      const backendInstanceId = this.deps.backendInstanceId?.();
      if (backendInstanceId !== undefined && input.backendInstanceId !== backendInstanceId) throw new InboxError(409, "The decision backend changed since this page was displayed; nothing was delivered. Refresh the inbox.");
      if (input.target === "owner") {
        if (await this.deps.canonicalPeer() !== null) throw new InboxError(409, "Owner asks can only be answered on the configured canonical host.");
        try {
          const result = input.operation === "answer"
            ? await this.deps.ownerAsks.answer({ issueId: input.issueId!, ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}), revision: input.revision, answers: input.answers!, ...(input.note !== undefined ? { note: input.note } : {}), ...(input.done !== undefined ? { done: input.done } : {}) }, this.deps.paseo())
            : await this.deps.ownerAsks.triage({ issueId: input.issueId!, ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}), revision: input.revision, action: input.action!, ...(input.note !== undefined ? { note: input.note } : {}), ...(input.until !== undefined ? { until: input.until } : {}) }, this.deps.paseo());
          return json(200, result);
        } finally { this.ownerGeneration++; this.peerFlights.clear(); this.ownerCache = null; this.ownerFlight = null; this.transportFlight = null; }
      }
      return this.liveAction(input);
    }
    // Discover host identity only from the configured origins' local snapshots. No payload URL is ever fetched.
    const configured = [...new Set((await this.deps.peers()).map(peerOrigin))];
    const sources = await Promise.all(configured.map(async (peer) => ({ peer, snapshot: await this.readPeer(peer).catch(() => null) })));
    const matches = sources.filter((source) => source.snapshot?.host === input.host);
    if (matches.length !== 1) throw new InboxError(404, "Unknown or unavailable decision host; no action was forwarded.");
    if (!input.backendInstanceId || matches[0].snapshot?.backendInstanceId !== input.backendInstanceId) throw new InboxError(409, "The target decision backend is missing or changed since this page was displayed; no action was forwarded. Refresh the inbox.");
    const peer = matches[0].peer;
    if (input.target === "owner") {
      const canonical = await this.deps.canonicalPeer();
      if (canonical === null || peerOrigin(canonical) !== peer) throw new InboxError(409, "Owner asks can only be answered on the configured canonical host.");
    }
    try {
      return await deadline(async () => {
        const response = await fetch(`${peer}/api/decisions/action`, { method: "POST", headers: { "content-type": "application/json", "x-review-action": "1", [INBOX_DISPLAYED_HEADER]: input.backendInstanceId! }, body: JSON.stringify(input), signal: AbortSignal.timeout(ACTION_TIMEOUT_MS), redirect: "error" });
        const raw: unknown = await response.json();
        if (response.ok) {
          const parsed = actionResultSchema.safeParse(raw);
          if (!parsed.success) throw new Error("The peer's action acknowledgement is invalid");
          return json(response.status, parsed.data);
        }
        const parsed = errorSchema.safeParse(raw);
        if (!parsed.success) throw new Error(`The peer returned HTTP ${response.status} without a valid acknowledgement`);
        return json(response.status, parsed.data);
      }, ACTION_TIMEOUT_MS);
    } catch (error) { throw new InboxError(502, `The action's outcome on ${input.host} is unknown: ${reasonOf(error)}. It is not retried automatically; inspect that agent or ticket before taking another action.`, true); }
  }

  private delivery(result: DeliveryResult) {
    if (result.status === "unconfirmed" || result.status === "unchecked" || result.status === "sent") throw new InboxError(502, result.reply ?? "Paseo did not confirm this action. It will not be sent again; inspect the agent.", true);
    if (!result.delivered) throw new InboxError(409, result.reply ?? "The request is no longer waiting; nothing was delivered.");
    return json(200, { delivered: "agent", message: result.reply ?? "Paseo confirmed the response to this exact request." });
  }

  private async liveAction(input: BrowserDecisionAction) {
    // The backend epoch fences transport, not the durable identity of this exact owner activity.
    const { backendInstanceId: _backendInstanceId, ...activity } = input;
    const ref = `${PREFIX}${hash(activity)}`;
    // Replay the durable exact activity before consulting Q2. Never rebind a confirmed retry to a newer round.
    if (input.operation === "answer" || input.action === "research" || input.action === "delegate") {
      const recorded = await this.deps.replies.recorded(ref);
      if (recorded) return this.delivery(recorded);
    }
    const paseo = this.deps.paseo();
    if (!paseo) throw new InboxError(503, "Paseo is disconnected; nothing was delivered.");
    const agent = (await paseo.agents.ref(input.agentId!).refresh())?.agent;
    const request = agent?.archivedAt ? undefined : agent?.pendingPermissions?.find((pending) => pending.id === input.requestId);
    if (!request || revision(request) !== input.revision) throw new InboxError(409, "This live request changed or is no longer waiting. Refresh the inbox; nothing was delivered.");
    const prior = Object.values(await this.deps.replies.records()).filter(record => record.agentId === input.agentId
      && record.requestId === input.requestId && record.request && revision(record.request) === input.revision);
    if (prior.some(record => record.status === "applied")) throw new InboxError(409, "This exact request already has a confirmed response. Refresh for the next round; nothing was delivered.");
    if (prior.some(record => ["reserved", "submitted", "unconfirmed", "sent", "unchecked"].includes(record.status))) throw new InboxError(502, "Delivery for this exact request is unconfirmed. Inspect the agent before taking another action; nothing was retried.", true);
    if (input.operation === "triage" && (input.action === "defer" || input.action === "reopen")) {
      return this.defer(input, request);
    }
    let response: AgentPermissionResponse;
    let text: string;
    if (request.kind !== "question") {
      if (input.operation !== "answer" || input.answers !== undefined) throw new InboxError(400, "Research/delegate and question answers cannot resolve a security permission. Choose an explicit original action.");
      const actions = permissionActions(request);
      const selected = actions.filter((action) => action.id === input.actionId);
      if (selected.length !== 1 || input.behavior !== selected[0].behavior) throw new InboxError(400, "Choose an exact permission action and its original behavior.");
      // Fallback accept/reject IDs match native Paseo's effective actions, including selectedActionId.
      response = selected[0].behavior === "allow" ? { behavior: "allow", selectedActionId: selected[0].id } : { behavior: "deny", selectedActionId: selected[0].id, ...(input.note?.trim() ? { message: input.note.trim() } : {}) };
      if (response.behavior === "allow" && input.note?.trim()) throw new InboxError(400, "An allow action does not accept an extra instruction.");
      text = `${selected[0].label}${input.note?.trim() ? `: ${input.note.trim()}` : ""}`;
    } else {
      if (input.actionId !== undefined || input.behavior !== undefined) throw new InboxError(400, "A question requires answers, not a permission action.");
      if (input.operation === "triage") {
        text = triageText(input.action as "research" | "delegate", input.note!.trim());
        const required = answerableQuestions(request);
        const keys = questionsOf(request).map(questionKey);
        if (!keys.length || new Set(keys).size !== keys.length) throw new InboxError(409, "This request has no unambiguous question fields; answer it in Paseo.");
        response = questionAnswer(request, "", Object.fromEntries(required.map(({ key }) => [key, text])));
      } else {
        if (!input.answers) throw new InboxError(400, "Supply the answers for this current question round.");
        const questions = questionsOf(request);
        const keys = questions.map(questionKey);
        if (new Set(keys).size !== keys.length) throw new InboxError(409, "This request contains ambiguous duplicate question keys; answer it in Paseo.");
        if (Object.keys(input.answers).some((key) => !keys.includes(key))) throw new InboxError(400, "Unknown question key. Nothing was delivered.");
        const required = answerableQuestions(request);
        if (!questions.length || required.some(({ key }) => !input.answers![key]?.trim())) throw new InboxError(400, "Answer every required question in this current round.");
        if (input.note?.trim()) throw new InboxError(400, "Put free text in the question's own answer field, not a separate note.");
        const given = Object.fromEntries(questions.map((question, index) => [questionKey(question, index), matchOption(question, input.answers![questionKey(question, index)] ?? "")]));
        if (request.provider === "omp" && request.metadata?.extensionUiMethod === "select"
          && required.some(({ key, question }) => !question.options?.some((option) => option.label === given[key]))) {
          throw new InboxError(400, "Choose one exact current-round option. Use Other to open the next editor round; do not join selections.");
        }
        response = questionAnswer(request, "", given);
        text = questions.map((question, index) => `${questionKey(question, index)}: ${given[questionKey(question, index)]}`).join("\n");
      }
    }
    // PermissionReplies owns durable checked submission and the final request fence. Its
    // non-question fingerprint must cover the whole request, including input and actions.
    return this.delivery(await this.deps.replies.deliver(paseo, input.agentId!, text, {
      ref, responder: { kind: "owner", via: "menu-bar", activityId: ref, userId: "owner" },
      ...(agent?.labels?.["linear.issueId"] ? { issueId: agent.labels["linear.issueId"] } : {}),
      ...(input.operation === "triage" ? { intent: "triage" as const } : {}),
    }, { requestId: request.id, request, response }));
  }

  private get deferralPath(): string { return join(this.directory, "live-deferrals.json"); }
  private async readDeferrals(): Promise<DeferralFile> {
    try { return deferralFileSchema.parse(JSON.parse(await readFile(this.deferralPath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deferrals: {}, history: [] }; throw error; }
  }
  private async defer(input: BrowserDecisionAction, request: AgentPermissionRequest) {
    if (input.action === "defer" && (!input.until || Date.parse(input.until) <= this.now())) throw new InboxError(400, "Defer requires a future ISO timestamp.");
    const run = async () => {
      const file = await this.readDeferrals();
      const key = hash([input.agentId, input.requestId]);
      for (const [id, deferred] of Object.entries(file.deferrals)) if (Date.parse(deferred.until) <= this.now()) delete file.deferrals[id];
      if (input.action === "defer") file.deferrals[key] = { agentId: input.agentId!, requestId: request.id, revision: input.revision, until: new Date(input.until!).toISOString() };
      else delete file.deferrals[key];
      const message = input.action === "defer" ? `Deferred until ${input.until}. The agent remains blocked; no answer or permission was granted.` : "Returned this revision to the inbox. No answer, permission or restart was sent.";
      file.history.unshift({ id: `${PREFIX}${randomUUID()}`, issueId: `agent:${input.agentId}`, identifier: input.agentId!, revision: input.revision, action: input.action as "defer" | "reopen", text: `${message}${input.note?.trim() ? `\n${input.note.trim()}` : ""}`, at: new Date(this.now()).toISOString(), delivery: "local" });
      file.history = file.history.slice(0, 100);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const temp = `${this.deferralPath}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(file), { mode: 0o600, flag: "wx" }); await rename(temp, this.deferralPath); }
      finally { await rm(temp, { force: true }); }
      return json(200, { delivered: "local", message });
    };
    const result = this.storeQueue.then(run, run);
    this.storeQueue = result.catch(() => undefined);
    return result;
  }
}
