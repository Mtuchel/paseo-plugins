import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { askQuestionSchema, decisionReceiptSchema, type DecisionReceipt } from "../shared/contracts";
import { browserOwnerAskSchema, decisionHostSchema, liveDecisionSchema, type BrowserDecisionAction, type DecisionHost, type DecisionView, type LiveDecision, type StewardFlow } from "../shared/decision-inbox";
import type { ActivationRoute } from "./activation";
import { decisionPage } from "./decision-page";
import type { OwnerAsks, OwnerAskSnapshot } from "./owner-asks";
import type { DeliveryResult, PermissionReplies, ReplyRecord } from "./permission-replies";
import { answerableQuestions, matchOption, questionAnswer, questionKey, questionsOf } from "./relay";
import { paseoHome } from "./ticket-mcp";
import { INBOX_DISPLAYED_HEADER } from "./inbox-transport";
import { CURATION_INTERVAL_MS, DecisionCuration } from "./decision-curation";

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
  directory?: string;
  now?: () => number;
};
const OWNER_CACHE_MS = CURATION_INTERVAL_MS;
const READ_TIMEOUT_MS = 5_000;
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
  issueId: z.string().min(1).optional(), agentId: z.string().min(1).optional(), requestId: z.string().min(1).optional(),
  revision: z.string().min(1), answers: z.record(z.string(), z.string().max(4000)).optional(),
  note: z.string().max(4000).optional(), done: z.boolean().optional(),
  action: z.enum(["research", "delegate", "defer", "reopen"]).optional(), until: z.string().datetime({ offset: true }).optional(),
  actionId: z.string().min(1).optional(), behavior: z.enum(["allow", "deny"]).optional(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.target === "owner" ? !value.issueId || value.agentId !== undefined || value.requestId !== undefined : !value.agentId || !value.requestId || value.issueId !== undefined) invalid("Identify exactly one owner ask or live request.");
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
const peerSchema = decisionHostSchema.extend({
  host: z.string().min(1), updatedAt: z.string().datetime({ offset: true }),
  asks: z.array(browserOwnerAskSchema.extend({ questions: z.array(peerQuestionSchema) }).strict()),
  live: z.array(liveDecisionSchema.extend({ questions: z.array(liveDecisionSchema.shape.questions.element.extend({ options: z.array(askQuestionSchema.shape.options.element.strict()) }).strict()), actions: z.array(liveDecisionSchema.shape.actions.element.strict()) }).strict()),
  history: z.array(decisionReceiptSchema.strict()),
}).strict();
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

export class BrowserDecisionInbox {
  private readonly host: string;
  private readonly directory: string;
  private readonly now: () => number;
  private ownerCache: { snapshot: OwnerSnapshot; checkedAt: number; error: string | null } | null = null;
  private ownerFlight: Promise<NonNullable<BrowserDecisionInbox["ownerCache"]>> | null = null;
  private ownerGeneration = 0;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private readonly curation: DecisionCuration;

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
    this.ownerCache = null;
    this.ownerFlight = null;
    this.curation.invalidate();
    return this.curation.refresh();
  }

  readonly route: ActivationRoute = async ({ method, path, headers, body }) => {
    if (path !== "/decisions" && path !== "/api/decisions" && path !== "/api/decisions/local" && path !== "/api/decisions/action") return null;
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
          this.ownerCache = null;
          this.ownerFlight = null;
          this.curation.invalidate();
        }
      }
      if (method !== "GET") return json(405, { error: "Use GET for the decision inbox." });
      if (path === "/api/decisions/local") return json(200, await this.local());
      const view = await this.view();
      if (path === "/api/decisions") return json(200, view);
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: decisionPage(view) };
    } catch (error) {
      return json(error instanceof InboxError ? error.status : 503, { error: reasonOf(error), ...(error instanceof InboxError && error.outcomeUnknown ? { outcomeUnknown: true } : {}) });
    }
  };

  private async ownerSnapshot(): Promise<NonNullable<BrowserDecisionInbox["ownerCache"]>> {
    if (this.ownerCache && this.now() - this.ownerCache.checkedAt < OWNER_CACHE_MS) return this.ownerCache;
    if (this.ownerFlight) return this.ownerFlight;
    const generation = this.ownerGeneration;
    const flight = (async () => {
      const checkedAt = this.now();
      const updatedAt = new Date(checkedAt).toISOString();
      let result: NonNullable<BrowserDecisionInbox["ownerCache"]>;
      try { result = { snapshot: await this.deps.ownerAsks.snapshot(this.deps.paseo()), checkedAt, error: null }; }
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
    const [owner, deferrals, records] = await Promise.all([
      canonical ? deadline(() => this.ownerSnapshot(), READ_TIMEOUT_MS).catch((error) => ({
        snapshot: { asks: [], history: [], updatedAt: new Date(this.now()).toISOString() },
        checkedAt: this.now(), error: `Owner asks unavailable: ${reasonOf(error)}`,
      })) : Promise.resolve(null),
      this.readDeferrals().catch((error) => { errors.push(`Live deferrals unavailable: ${reasonOf(error)}`); return { deferrals: {}, history: [] } as DeferralFile; }),
      this.deps.replies.records().catch((error) => { errors.push(`Live history unavailable: ${reasonOf(error)}`); return {} as Record<string, ReplyRecord>; }),
    ]);
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
              const activity = Object.values(records).filter(record => record.ref.startsWith(PREFIX) && record.agentId === agent.id
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
    const receipts = Object.values(records).filter((record) => record.ref.startsWith(PREFIX) && record.request).map((record): DecisionReceipt => ({
      id: record.ref, issueId: record.issueId ?? `agent:${record.agentId}`, identifier: record.agentId, revision: revision(record.request!),
      action: record.intent ? (record.text.startsWith("Research only:") ? "research" : "delegate") : "answer",
      text: record.text, at: record.at, delivery: record.status,
    }));
    // Never hide every ask on a ticket because one agent's request disappeared. OwnerAsks
    // resolves the exact wait-comment source; curation deduplicates only source identities.
    const asks = owner?.snapshot.asks ?? [];
    return { host: this.host, asks, live,
      backendInstanceId: this.deps.backendInstanceId?.(),
      history: [...owner?.snapshot.history ?? [], ...receipts, ...deferrals.history].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
      updatedAt: owner?.snapshot.updatedAt ?? new Date(this.now()).toISOString(), error: errors.length ? errors.join("\n") : null,
      // The steward's flow summary (README, "Ticket steward"). Its failure is a page warning, not
      // an inbox error: the decisions below are still answerable.
      flow: await this.readFlow(errors) };
  }

  // The steward's flow for the page's Flow section; its failure is named there.
  private async readFlow(errors: string[]): Promise<StewardFlow | null> {
    if (!this.deps.flow) return null;
    try {
      return await this.deps.flow();
    } catch (error) {
      const reason = `Ticket flow unavailable: ${reasonOf(error)}`;
      errors.push(reason);
      return { at: null, counts: {}, oldest: [], error: reason };
    }
  }

  private async readPeer(peer: string): Promise<DecisionHost> {
    return deadline(async () => {
      const response = await fetch(`${peer}/api/decisions/local`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = peerSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The peer returned an invalid decision snapshot.");
      return parsed.data;
    }, READ_TIMEOUT_MS);
  }

  view(): Promise<DecisionView> { return this.curation.view(); }

  private async collectView(): Promise<DecisionView> {
    // Each curation pass collects Linear again; peer/local reads still share the short cache.
    if (!this.ownerFlight) this.ownerCache = null;
    const [configuredPeers, canonicalPeer] = await Promise.all([this.deps.peers(), this.deps.canonicalPeer()]);
    const localPromise = this.local(canonicalPeer === null);
    const sources = await Promise.all([...new Set(configuredPeers)].map(async (configured) => {
      try { const peer = peerOrigin(configured); return { configured, peer, snapshot: await this.readPeer(peer), error: null }; }
      catch (error) { return { configured, peer: null, snapshot: null, error: reasonOf(error) }; }
    }));
    const local = await localPromise;
    const hosts: DecisionHost[] = [local];
    const unreachable: string[] = [];
    let canonicalHost: string | null = canonicalPeer === null ? this.host : null;
    let canonicalOrigin: string | null = null;
    if (canonicalPeer !== null) {
      try { canonicalOrigin = peerOrigin(canonicalPeer); }
      catch (error) { local.error = [local.error, `Canonical source ${canonicalPeer} unavailable: ${reasonOf(error)}`].filter(Boolean).join("\n"); }
    }
    const identities = new Set([this.host]);
    for (const source of sources) {
      if (!source.snapshot || identities.has(source.snapshot.host)) {
        unreachable.push(source.configured);
        hosts.push({ host: source.configured, asks: [], live: [], history: [], updatedAt: new Date(this.now()).toISOString(), error: `Decision source ${source.configured} unavailable: ${source.error ?? "duplicate host identity"}`, flow: null });
        continue;
      }
      identities.add(source.snapshot.host);
      const canonical = canonicalOrigin !== null && source.peer === canonicalOrigin;
      if (canonical) canonicalHost = source.snapshot.host;
      hosts.push({ ...source.snapshot, asks: canonical ? source.snapshot.asks : [],
        history: canonical ? source.snapshot.history : source.snapshot.history.filter((receipt) => receipt.id.startsWith(PREFIX)) });
    }
    if (canonicalPeer !== null && canonicalHost === null) {
      if (!unreachable.includes(canonicalPeer)) unreachable.push(canonicalPeer);
      local.error = [local.error, `Canonical owner asks unavailable from ${canonicalPeer}; no local Linear fallback is used.`].filter(Boolean).join("\n");
    }
    return { hosts, canonicalHost, unreachable };
  }

  private async action(input: BrowserDecisionAction) {
    if (input.host === this.host) {
      const backendInstanceId = this.deps.backendInstanceId?.();
      if (backendInstanceId !== undefined && input.backendInstanceId !== backendInstanceId) throw new InboxError(409, "The decision backend changed since this page was displayed; nothing was delivered. Refresh the inbox.");
      if (input.target === "owner") {
        if (await this.deps.canonicalPeer() !== null) throw new InboxError(409, "Owner asks can only be answered on the configured canonical host.");
        try {
          const result = input.operation === "answer"
            ? await this.deps.ownerAsks.answer({ issueId: input.issueId!, revision: input.revision, answers: input.answers!, ...(input.note !== undefined ? { note: input.note } : {}), ...(input.done !== undefined ? { done: input.done } : {}) }, this.deps.paseo())
            : await this.deps.ownerAsks.triage({ issueId: input.issueId!, revision: input.revision, action: input.action!, ...(input.note !== undefined ? { note: input.note } : {}), ...(input.until !== undefined ? { until: input.until } : {}) }, this.deps.paseo());
          return json(200, result);
        } finally { this.ownerGeneration++; this.ownerCache = null; this.ownerFlight = null; }
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
    const prior = Object.values(await this.deps.replies.records()).filter(record => record.ref.startsWith(PREFIX)
      && record.agentId === input.agentId && record.requestId === input.requestId && record.request && revision(record.request) === input.revision);
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
