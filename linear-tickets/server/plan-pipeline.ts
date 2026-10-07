import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { PipelineHost, PipelineRow, type PipelineStage, type PipelineStatus } from "../shared/plan-pipeline";
import { ADVISOR_MODEL } from "../shared/plan-advisor";
import type { ParkedPlan } from "./parked";
import { ghostAgents, LIVE_AGENT, type ProcessInspector } from "./process-liveness";
import type { SessionLink } from "./sessions";
import { paseoHome } from "./ticket-mcp";
import { diagnostic, NativeReader, pipelinePlannerEvidence, timestamp, type NativeCursor, type NativeEvidence, type PipelinePlannerEvidence } from "./plan-pipeline-source";
import { limitError, limitTime } from "./limit-resume";

export type PipelineReview = {
  agentId: string; name: string; since: string; link: string; outcome?: string; decidedAt?: string;
  // Optional stronger matching for revisions served at the same stable URL / original since.
  revision?: string; publishedAt?: string; autoApproved?: boolean;
};
export type PipelineOwnerEvidence = {
  issueId: string; agentId: string; waiting: boolean; at?: string; resumedFrom?: string; failedAt?: string;
};
export type PlanPipelineOptions = {
  host?: string; file?: string; now?: () => Date;
  sessions?: () => Promise<SessionLink[]>; parked?: () => Promise<ParkedPlan[]>;
  // One bounded, local-only sample per refresh, scoped to the actual record owner.
  owners?: (issueIds: readonly string[]) => Promise<readonly PipelineOwnerEvidence[]>;
  // Source root and read-only process inspection seam; useful for deterministic isolated tests.
  home?: string; processInspector?: ProcessInspector;
};
type Row = PipelineRow;
type PlannerIdentity = { projectId: string; runId: string };
type RecordEntry = { row: Row; key: string; revision?: string; submittedAt?: string; observedAt?: string; ownerFailedAt?: string; planner?: PlannerIdentity; queue?: { sessionId: string; restart: boolean; pending: boolean }; history: { stage: PipelineStage; status: PipelineStatus; at: string }[] };
function revisionOf(entry: RecordEntry): string | undefined {
  return entry.revision ?? (entry.key.startsWith("hash:") ? entry.key.slice(5) : undefined);
}
function attemptTime(entry: RecordEntry): string { return entry.submittedAt ?? entry.observedAt ?? entry.row.since; }
function queueDetail(link: SessionLink): string {
  const reason = object(link).queueReason;
  return typeof reason === "string" && reason.trim() ? label(reason, 1400) : "Waiting for admission or agent capacity";
}
type DeliveryError = { at: string; detail: string; attempts: number; localUrl?: string };
type Journal = {
  version: 1; checkedAt: string | null; lastArrivalAt: string | null;
  records: RecordEntry[]; cursors: Record<string, NativeCursor>; deliveries: Record<string, DeliveryError>;
};
const REFRESH_MS = 30_000;
const QUIET_MS = 20 * 60_000;
const MAX_ROWS = 1000;
const MAX_ROOTS = 512;
const MAX_HISTORY = 24;
const TERMINAL: Record<string, true> = { "auto-approved": true, completed: true, superseded: true, cancelled: true };

function label(value: string, max: number): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max); }
function url(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? value : undefined; } catch { return undefined; }
}
async function json(path: string, limit: number, absent: unknown): Promise<unknown> {
  let file: FileHandle;
  try { file = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Evidence source exceeds its safe bound");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    if (bytes > stat.size) throw new Error("Evidence source changed during read");
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as unknown;
  } finally { await file.close(); }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function boundedMap<T, R>(values: readonly T[], run: (value: T) => Promise<R>): Promise<R[]> {
  let index = 0;
  const result: R[] = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (index < values.length) { const next = index++; result[next] = await run(values[next]); }
  }));
  return result;
}

/** Read-only source monitor. Inbox delivery is supplied by ReviewLinks, never inferred from a
 * successful submit result. snapshot is cache-only: no daemon RPC/process scan is on the HTTP path.
 * refresh and persistence are single-flight; no action is taken on the observed agents. */
export class PlanPipeline {
  private readonly host: string;
  private readonly file: string;
  private readonly home: string;
  private readonly now: () => Date;
  private paseo: PaseoApi | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private loadProblem: string | undefined;
  private refreshing: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;
  private lastRefresh = -Infinity;
  private checkedAt: string | null = null;
  private lastArrivalAt: string | null = null;
  private error: string | undefined = "Pipeline sources have not been checked";
  private readonly records = new Map<string, RecordEntry>();
  private cursors: Record<string, NativeCursor> = {};
  private deliveries: Record<string, DeliveryError> = {};
  private readonly readers = new Map<string, NativeReader>();
  private reviews: readonly PipelineReview[] = [];
  private decided: readonly PipelineReview[] = [];

  constructor(private readonly options: PlanPipelineOptions = {}) {
    this.host = label(options.host ?? hostname(), 100);
    this.home = options.home ?? paseoHome();
    this.file = options.file ?? join(this.home, "linear-tickets", "plan-pipeline.json");
    this.now = options.now ?? (() => new Date());
  }

  attach(paseo: PaseoApi): void {
    if (this.stopped) return;
    this.paseo = paseo;
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
      this.timer.unref?.();
    }
    void this.refresh();
  }

  stop(): void { this.stopped = true; clearInterval(this.timer ?? undefined); this.timer = null; }

  async snapshot(openReviews: readonly PipelineReview[], decidedReviews: readonly PipelineReview[]): Promise<PipelineHost> {
    // No waiting for load/refresh. A first response is explicitly unknown; the worker loads the
    // restart journal before observing sources. Review delivery still updates synchronously.
    this.reviews = openReviews.slice(-MAX_ROWS);
    this.decided = decidedReviews.slice(-MAX_ROWS);
    this.applyInbox();
    if (!this.stopped && this.now().getTime() - this.lastRefresh >= REFRESH_MS) void this.refresh();
    if (this.dirty && this.loaded) void this.persist().catch(() => { this.error = "Pipeline journal could not be saved"; });
    const rows = [...this.records.values()].map(({ row }) => ({ ...row }));
    return PipelineHost.parse({ host: this.host, checkedAt: this.checkedAt, lastArrivalAt: this.lastArrivalAt, rows: rows.slice(-MAX_ROWS), ...(this.error ? { error: this.error.slice(0, 1400) } : {}) });
  }

  async recordDeliveryError(event: { agentId: string | null; type: string; at?: string; localUrl?: string }, error: unknown, attempts: number): Promise<void> {
    if (event.type !== "opened" || !event.agentId || this.stopped) return;
    await this.load();
    // A callback is an actual failed delivery, not a poll. Its receipt time identifies a failure
    // when the event omitted at; it never advances lastProgressAt.
    const at = timestamp(event.at) ?? this.now().toISOString();
    const id = label(event.agentId, 100);
    const before = this.deliveries[id];
    if (!before || at >= before.at) {
      const count = Number.isFinite(attempts) ? Math.max(1, Math.min(9999, Math.floor(attempts))) : 1;
      this.deliveries[id] = { at, detail: `${diagnostic(error)}; delivery attempt ${count}`, attempts: count, ...(url(event.localUrl) ? { localUrl: url(event.localUrl) } : {}) };
      const record = this.latest(id) ?? this.ensure(id, id, `delivery:${at}`, at);
      if (!TERMINAL[record.row.stage] && record.row.stage !== "ready" && at >= (record.submittedAt ?? record.row.since)) this.change(record, "publishing", "failed", at, this.deliveries[id].detail);
      this.applyInbox(); this.dirty = true;
      await this.persist();
    }
  }

  // Explicit refresh is also the deterministic behavior-test seam; production callers use attach.
  refresh(): Promise<void> {
    if (this.stopped) return this.refreshing ?? this.saving ?? Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.lastRefresh = this.now().getTime();
    this.refreshing = this.run().catch((error: unknown) => {
      this.error = diagnostic(error);
      for (const record of this.records.values()) if (!TERMINAL[record.row.stage] && record.row.stage !== "ready" && record.row.status !== "failed") {
        record.row.status = "unknown"; record.row.detail = "Source refresh failed; retaining last evidence";
      }
      // checkedAt is deliberately unchanged. Successful review delivery remains authoritative.
      this.applyInbox();
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const raw = await json(this.file, 24 * 1024 * 1024, null);
      if (raw === null) return;
      const saved = object(raw);
      if (saved.version !== 1 || !Array.isArray(saved.records)) throw new Error("Unsupported pipeline journal");
      this.checkedAt = timestamp(saved.checkedAt);
      this.lastArrivalAt = timestamp(saved.lastArrivalAt);
      for (const value of saved.records.slice(-MAX_ROWS)) {
        const entry = object(value);
        const parsed = PipelineRow.safeParse(entry.row);
        if (!parsed.success || typeof entry.key !== "string" || this.records.has(parsed.data.id)) continue;
        const history = Array.isArray(entry.history) ? entry.history.filter((event) => {
          const item = object(event); return typeof item.stage === "string" && typeof item.status === "string" && timestamp(item.at);
        }).slice(-MAX_HISTORY) : [];
        this.records.set(parsed.data.id, { row: { ...parsed.data, host: this.host }, key: entry.key.slice(0, 300), observedAt: timestamp(entry.observedAt) ?? timestamp(object(history[0]).at) ?? parsed.data.since, ...(typeof entry.revision === "string" && /^[a-f0-9]{64}$/.test(entry.revision) ? { revision: entry.revision } : {}), ...(timestamp(entry.submittedAt) ? { submittedAt: timestamp(entry.submittedAt) ?? undefined } : {}), history: history as RecordEntry["history"] });
        if (timestamp(entry.ownerFailedAt)) this.records.get(parsed.data.id)!.ownerFailedAt = timestamp(entry.ownerFailedAt)!;
        const queue = object(entry.queue);
        if (typeof queue.sessionId === "string" && queue.sessionId.length <= 200) this.records.get(parsed.data.id)!.queue = { sessionId: queue.sessionId, restart: queue.restart === true, pending: queue.pending === true };
        const planner = object(entry.planner);
        if ([planner.projectId, planner.runId].every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) {
          this.records.get(parsed.data.id)!.planner = { projectId: planner.projectId as string, runId: planner.runId as string };
          // A journal is historical evidence, not authority for a current restart promise.
          const restored = this.records.get(parsed.data.id)!;
          if (!TERMINAL[restored.row.stage] && restored.row.stage !== "ready") {
            restored.row.status = "unknown"; restored.row.detail = "Planner recovery awaiting current project evidence";
          }
        }
      }
      for (const [id, value] of Object.entries(object(saved.cursors)).slice(-MAX_ROOTS)) {
        const cursor = object(value), state = object(cursor.state);
        // Older readers classified every dispose as a crash; replay those bounded native files.
        if (state.stoppedAt) continue;
        if (typeof cursor.path === "string" && typeof cursor.inode === "string" && typeof cursor.offset === "number" && cursor.offset >= 0 && typeof cursor.anchor === "string" && Array.isArray(state.revisions)) this.cursors[id] = value as NativeCursor;
      }
      for (const [id, value] of Object.entries(object(saved.deliveries)).slice(-MAX_ROOTS)) {
        const delivery = object(value);
        const at = timestamp(delivery.at);
        if (at && typeof delivery.detail === "string" && typeof delivery.attempts === "number") this.deliveries[id] = { at, detail: label(delivery.detail, 300), attempts: Math.min(9999, delivery.attempts) };
      }
    })().then(() => { this.loaded = true; }).catch((error: unknown) => {
      this.loadProblem = `Pipeline journal unavailable: ${diagnostic(error)}`;
      this.loaded = true; // reconstruct from public/native sources rather than stick on a rejected load
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  private latest(agentId: string): RecordEntry | undefined {
    return [...this.records.values()].filter(({ row }) => row.agentId === agentId).sort((a, b) => attemptTime(b).localeCompare(attemptTime(a)))[0];
  }

  private ensure(agentId: string, identifier: string, key: string, at: string): RecordEntry {
    const id = `${this.host}:${label(agentId, 100)}:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    let record = this.records.get(id);
    if (!record) {
      record = { key, observedAt: at, row: { id, agentId: label(agentId, 100), identifier: label(identifier, 200), host: this.host, stage: "preparing", status: "unknown", since: at, lastProgressAt: null, detail: "Planning evidence not yet available" }, history: [] };
      this.records.set(id, record); this.dirty = true;
    }
    record.row.identifier = label(identifier, 200);
    return record;
  }

  private change(record: RecordEntry, stage: PipelineStage, status: PipelineStatus, at: string, detail: string): void {
    const safeDetail = label(detail, 1400);
    if (record.row.stage === stage && record.row.status === status && record.row.detail === safeDetail) return;
    if (record.row.stage !== stage || record.row.status !== status) {
      record.history.push({ stage, status, at }); record.history = record.history.slice(-MAX_HISTORY);
      if (record.row.stage !== stage) record.row.since = at;
    }
    record.row.stage = stage; record.row.status = status; record.row.detail = safeDetail;
    this.dirty = true;
  }

  private observeRecovery(record: RecordEntry, project: PipelinePlannerEvidence | undefined, agent: PaseoAgent | undefined, live: boolean, now: number, unavailable: boolean): boolean {
    const identity = record.planner;
    if (!identity || TERMINAL[record.row.stage] || record.row.stage === "ready") return false;
    const run = project?.run;
    if (project?.closedRunId === identity.runId || run?.runId === identity.runId && run.approved) {
      this.change(record, "completed", "normal", this.now().toISOString(), "Project planner run closed; no automatic restart is pending");
    } else if (run && (run.runId !== identity.runId || run.agentId && run.agentId !== record.row.agentId)) {
      this.change(record, "superseded", "normal", run.listedAt, "Project planner replaced by the current run or agent");
    } else if (unavailable || !run || run.runId !== identity.runId) {
      this.change(record, record.row.stage, "unknown", record.row.since, "Planner recovery evidence unavailable; automatic restart unconfirmed");
    } else if (!run.pending) {
      if (!agent) this.change(record, record.row.stage, "unknown", record.row.since, "No pending planner recovery; current agent evidence unavailable");
      else return false;
    } else if (live) {
      if (!agent || agent.archivedAt || !LIVE_AGENT[agent.status]) this.change(record, record.row.stage, "unknown", record.row.since, "Live planner observed; waiting for recovery ownership confirmation");
      else return false;
    } else if (agent && (agent.labels?.["linear.projectId"] !== identity.projectId || agent.labels?.["linear.plannerRun"] !== identity.runId || agent.labels?.["linear.issueId"] || agent.labels?.["paseo.parent-agent-id"])) {
      this.change(record, record.row.stage, "unknown", record.row.since, "Planner recovery ownership unconfirmed");
    } else if (run.ownerAsked) {
      this.change(record, "waiting", "attention", run.pending.failedAt, "Automatic planner recovery stopped; owner action required. Use Plan or Skip.");
    } else {
      const claim = run.claim && run.pending.identity !== run.claim.requestId ? run.claim : undefined;
      const detail = claim
        ? `Usage-limit restart requested at ${limitTime(Date.parse(claim.at), now, true)}; waiting for agent confirmation.`
        : `Usage limit: restart scheduled for ${limitTime(Date.parse(run.pending.resumeAt), now, true)}. Recovery is checked when automatic dispatch is active and the project is eligible.`;
      this.change(record, "waiting", "normal", run.pending.failedAt, detail);
    }
    return true;
  }

  private applyInbox(): void {
    for (const [reviews, decided] of [[this.decided, true], [this.reviews, false]] as const) for (const review of reviews) {
      const at = timestamp(review.publishedAt) ?? timestamp(review.since);
      const decisionAt = timestamp(review.decidedAt);
      const agentId = label(review.agentId, 100);
      if (!at || !agentId) continue;
      // Legacy registries kept the original opening time, not the latest submitted content.
      // Only an actual decision can settle no-hash attempts between that opening and decision.
      const cutoff = decided && !review.revision ? decisionAt ?? at : at;
      const candidates = [...this.records.values()].filter((entry) => entry.row.agentId === agentId);
      const eligible = candidates.filter((entry) => attemptTime(entry) <= cutoff);
      const matches = eligible.filter((entry) => !review.revision || revisionOf(entry) === review.revision);
      const provisional = review.revision ? eligible.filter((entry) => !revisionOf(entry) && !TERMINAL[entry.row.stage]) : [];
      const matched = matches.sort((a, b) => attemptTime(b).localeCompare(attemptTime(a)))[0];
      const pending = provisional.sort((a, b) => attemptTime(b).localeCompare(attemptTime(a)))[0];
      let record = pending && (!matched || attemptTime(pending) > attemptTime(matched)) ? pending : matched;
      if (!record) record = this.ensure(agentId, review.name, review.revision ? `review:${review.revision}:${at}` : `review:${at}`, at);
      if (review.revision) {
        if (record.revision !== review.revision) { record.revision = review.revision; this.dirty = true; }
        // Remove only delivery placeholders for the same attempt, never real resubmissions.
        for (const duplicate of matches) if (duplicate !== record && !duplicate.submittedAt
          && attemptTime(duplicate) === attemptTime(record)) {
          this.records.delete(duplicate.row.id); this.dirty = true;
        }
      }
      const arrived = url(review.link);
      if (arrived) {
        record.row.reviewUrl = arrived;
        if (!this.lastArrivalAt || at > this.lastArrivalAt) { this.lastArrivalAt = at; this.dirty = true; }
      }
      if (decided) {
        const outcome = review.outcome?.toLowerCase();
        if (!["approved", "auto-approved", "cancelled", "superseded", "sent back", "completed"].includes(outcome ?? "")) {
          if (!TERMINAL[record.row.stage]) this.change(record, record.row.stage, "unknown", cutoff, "Review outcome unavailable or unsupported");
          continue;
        }
        const approved = outcome === "approved" || outcome === "auto-approved";
        const stage: PipelineStage = outcome === "cancelled" ? "cancelled" : outcome === "superseded" || outcome === "sent back" ? "superseded" : approved && (review.autoApproved || outcome === "auto-approved") ? "auto-approved" : "completed";
        this.change(record, stage, "normal", decisionAt ?? at, approved ? "Plan approved" : "Review resolved");
      } else if (!TERMINAL[record.row.stage]) {
        this.change(record, arrived ? "ready" : record.row.stage, arrived ? "normal" : "unknown", at,
          arrived ? "Plan delivered to the review inbox; waiting for owner" : "Review inbox link unavailable");
      }
      if (decided || arrived) for (const older of eligible) if (older !== record && !TERMINAL[older.row.stage]
        && (attemptTime(older) < attemptTime(record) || review.revision && revisionOf(older) !== review.revision)) {
        this.change(older, "superseded", "normal", decisionAt ?? at, "Earlier attempt replaced by the resolved or delivered review");
      }
      // Delivery and decisions never resolve a later attempt, even with identical content.
    }
    this.prune();
  }

  private async agents(): Promise<PaseoAgent[]> {
    if (!this.paseo) throw new Error("Paseo source unavailable");
    const agents: PaseoAgent[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      agents.push(...result.entries.map(({ agent }) => agent));
      if (!result.pageInfo?.hasMore) { if (!result.pageInfo) throw new Error("Agent listing incomplete"); return agents; }
      cursor = result.pageInfo.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) throw new Error("Agent listing incomplete");
      seen.add(cursor);
    }
    throw new Error("Agent listing exceeds safe bound");
  }

  private async timeline(agent: PaseoAgent): Promise<{ progress: string | null; submitAt?: string; failure?: string }> {
    if (!this.paseo) throw new Error("Paseo source unavailable");
    const page = await this.paseo.agents.ref(agent).timeline.refetch({ direction: "tail", projection: "canonical", limit: 64 });
    if (page.error) throw new Error("Public timeline unavailable");
    let progress: string | null = null, submitAt: string | undefined, failure: string | undefined;
    for (const entry of page.entries) {
      const at = timestamp(entry.timestamp);
      if (!at) continue;
      const item = entry.item;
      if (item.type === "assistant_message" || item.type === "tool_call") {
        if (!progress || at > progress) progress = at;
      }
      if (item.type === "tool_call" && item.name === "plannotator_submit_plan" && (!submitAt || at >= submitAt)) {
        submitAt = at;
        failure = item.status === "failed" ? diagnostic(item.error) : undefined;
      }
    }
    return { progress, ...(submitAt ? { submitAt } : {}), ...(failure ? { failure } : {}) };
  }

  private async sessions(): Promise<SessionLink[]> {
    if (this.options.sessions) return this.options.sessions();
    const raw = await json(join(this.home, "linear-tickets", "agent-app", "sessions.json"), 4 * 1024 * 1024, {});
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Session source malformed");
    const entries = Object.values(raw);
    if (entries.length > 4000) throw new Error("Session source exceeds safe bound");
    for (const value of entries) {
      const link = object(value);
      if (typeof link.sessionId !== "string" || typeof link.identifier !== "string" || !timestamp(link.createdAt) || !(link.agentId === null || typeof link.agentId === "string")) throw new Error("Session source malformed");
    }
    return entries as SessionLink[];
  }

  private async parked(): Promise<ParkedPlan[]> {
    if (this.options.parked) return this.options.parked();
    const directory = join(this.home, "linear-tickets", "plannotator", "parked");
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const files = names.filter((name) => name.endsWith(".json") && !name.startsWith("."));
    if (files.length > MAX_ROWS) throw new Error("Parked source exceeds safe bound");
    return boundedMap(files, async (name) => {
      const value = object(await json(join(directory, name), 256 * 1024, null));
      if (typeof value.agentId !== "string" || typeof value.identifier !== "string" || !timestamp(value.parkedAt)) throw new Error("Parked source malformed or changed during read");
      return value as ParkedPlan;
    });
  }

  private async run(): Promise<void> {
    await this.load();
    const [agentSource, sessionSource, parkedSource, plannerSource] = await Promise.allSettled([this.agents(), this.sessions(), this.parked(), pipelinePlannerEvidence(this.home)]);
    const agents = agentSource.status === "fulfilled" ? agentSource.value : [];
    const links = sessionSource.status === "fulfilled" ? sessionSource.value : [];
    const parked = parkedSource.status === "fulfilled" ? parkedSource.value : [];
    const planners = new Map((plannerSource.status === "fulfilled" ? plannerSource.value : []).map((project) => [project.projectId, project]));
    const handledRecovery = new Set<string>();
    const sourceProblems = [agentSource, sessionSource, parkedSource].flatMap((source) => source.status === "rejected" ? [diagnostic(source.reason)] : []);
    const recoveryUnavailable = plannerSource.status === "rejected" || sourceProblems.length > 0;
    if (agentSource.status === "rejected") for (const record of this.records.values()) {
      if (!TERMINAL[record.row.stage] && record.row.stage !== "ready" && record.row.status !== "failed") this.change(record, record.row.stage, "unknown", record.row.since, "Agent source unavailable; retaining last evidence");
    }
    if (this.stopped) return;
    const now = this.now().getTime();
    const knownRoots = new Set([...this.records.values()].map((entry) => entry.row.agentId));
    const parkedRoots = new Set(parked.map((plan) => plan.agentId));
    const rootSource = agents.filter((agent) => !agent.labels?.["paseo.parent-agent-id"] && (agent.labels?.["linear.issueId"] || agent.labels?.["linear.plannerRun"])
      && (!agent.archivedAt || knownRoots.has(agent.id) || parkedRoots.has(agent.id)
        || planners.get(agent.labels?.["linear.projectId"])?.run?.pending && planners.get(agent.labels?.["linear.projectId"])?.run?.runId === agent.labels?.["linear.plannerRun"]
          && planners.get(agent.labels?.["linear.projectId"])?.run?.agentId === agent.id));
    const roots = rootSource.sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_ROOTS);
    const issues: string[] = [...sourceProblems, ...(this.loadProblem ? [this.loadProblem] : [])];
    if (plannerSource.status === "rejected") issues.push(`Planner recovery source unavailable: ${diagnostic(plannerSource.reason)}`);
    if (rootSource.length > MAX_ROOTS) issues.push("Planning root limit reached");
    let owners: readonly PipelineOwnerEvidence[] = [];
    let ownersUnavailable = false;
    if (this.options.owners) try {
      owners = await this.options.owners([...new Set(roots.flatMap((agent) => agent.labels["linear.issueId"] ? [agent.labels["linear.issueId"]] : []))]);
      if (owners.length > MAX_ROWS) throw new Error("Owner evidence exceeds safe bound");
    } catch (error) {
      ownersUnavailable = true;
      const problem = diagnostic(error); sourceProblems.push(problem); issues.push(problem);
      owners = [];
    }
    const ghosts = await ghostAgents(roots, now, this.options.processInspector);
    const liveRuns = new Set(agents.filter((agent) => !agent.labels?.["paseo.parent-agent-id"] && !agent.archivedAt && LIVE_AGENT[agent.status] && !ghosts.has(agent.id))
      .map((agent) => JSON.stringify([agent.labels?.["linear.projectId"], agent.labels?.["linear.plannerRun"]])));
    await boundedMap(roots, async (agent) => {
      const identifier = agent.labels["linear.plannerRun"]
        ? agent.title || `Planner run ${agent.labels["linear.plannerRun"].slice(0, 8)}`
        : agent.labels["linear.identifier"] ?? agent.labels["linear.issueId"];
      const link = links.filter((session) => session.agentId === agent.id || !session.agentId && session.sessionId === agent.labels["linear.sessionId"])
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const ownerWait = owners.find((owner) => owner.issueId === agent.labels["linear.issueId"] && owner.agentId === agent.id && owner.waiting);
      const ownerFailure = owners.find((owner) => owner.issueId === agent.labels["linear.issueId"] && owner.agentId === agent.id && timestamp(owner.failedAt));
      const transfer = owners.find((owner) => owner.issueId === agent.labels["linear.issueId"] && owner.resumedFrom === agent.id && owner.agentId !== agent.id && timestamp(owner.at));
      const parkedPlan = parked.find((plan) => plan.agentId === agent.id);
      let requestAt: string | null = null, sourceError: string | undefined;
      try {
        if (!/^[a-zA-Z0-9-]+$/.test(agent.id)) throw new Error("Unsupported agent identity");
        const request = await json(join(this.home, "linear-tickets", "plan-requests", agent.id), 16 * 1024, null);
        if (request !== null) { requestAt = timestamp(object(request).at); if (!requestAt) throw new Error("Plan request malformed"); }
      } catch (error) { sourceError = diagnostic(error); }
      let native: NativeEvidence | undefined;
      if (agent.provider === "omp") {
        const path = agent.persistence?.nativeHandle;
        if (path) {
          const reader = this.readers.get(agent.id) ?? new NativeReader(); this.readers.set(agent.id, reader);
          try { native = await reader.read(path, this.cursors[agent.id]); this.cursors[agent.id] = native.cursor; }
          catch (error) { sourceError = diagnostic(error); }
        } else sourceError = "Public OMP native session handle unavailable";
      } else sourceError = "Native planning evidence unsupported for this provider";
      const state = native?.state;
      const previous = this.latest(agent.id);
      const planning = state?.phase === "planning" || requestAt || parkedPlan || link?.review || ownerWait || this.deliveries[agent.id] || ((agent.labels["linear.plan"] === "required" || agent.labels["linear.plannerRun"]) && state?.phase !== "executing" && !(state?.phase === "idle" && state.progress));
      if (!planning && !previous && !state?.revisions.length) return; // approved implementing successor
      let timeline: { progress: string | null; submitAt?: string; failure?: string } | undefined;
      if (!native) {
        try { timeline = await this.timeline(agent); } catch { sourceError = "Public timeline unavailable; native evidence unavailable"; }
      }
      let problem = sourceError ?? native?.problem ?? sourceProblems[0];
      if (problem) issues.push(problem);
      const cycleAt = requestAt ?? state?.planningAt ?? parkedPlan?.parkedAt ?? link?.review?.openedAt ?? agent.createdAt;
      const revisions = state?.revisions ?? [];
      let record = previous;
      for (const revision of revisions) {
        const sameAttempt = [...this.records.values()].find((entry) => entry.row.agentId === agent.id
          && (entry.key === revision.key || revision.hash && revisionOf(entry) === revision.hash && entry.submittedAt === revision.attemptAt));
        const provisional = record && !record.submittedAt && !TERMINAL[record.row.stage]
          && attemptTime(record) <= (revision.attemptAt ?? revision.at)
          && (record.row.stage !== "ready" || revision.attemptAt && revision.attemptAt <= record.row.since) ? record : undefined;
        record = sameAttempt ?? provisional ?? this.ensure(agent.id, identifier, revision.key, revision.at);
        record.key = revision.key; record.row.identifier = label(identifier, 200);
        if (revision.hash && !record.revision) record.revision = revision.hash;
        if (revision.progress && (!record.row.lastProgressAt || revision.progress > record.row.lastProgressAt)) record.row.lastProgressAt = revision.progress;
        if (revision.attemptAt) record.submittedAt = revision.attemptAt;
        if (TERMINAL[revision.stage] && !native?.problem && (!TERMINAL[record.row.stage] || record.row.stage === "auto-approved" && revision.stage === "completed") && !(record.row.stage === "ready" && revision.stage === "cancelled")) this.change(record, revision.stage, "normal", revision.resolvedAt ?? revision.at, "Plan planning cycle resolved");
      }
      if (requestAt && (!record || requestAt > (state?.planningAt ?? record.row.since))) record = this.ensure(agent.id, identifier, `request:${requestAt}`, requestAt);
      if (!record && planning) record = this.ensure(agent.id, identifier, `planning:${cycleAt}`, cycleAt);
      if (!record) return;
      const projectId = agent.labels["linear.projectId"], runId = agent.labels["linear.plannerRun"];
      const project = projectId ? planners.get(projectId) : undefined;
      const plannerPending = !agent.labels["linear.issueId"] && project?.run?.runId === runId && project.run.agentId === agent.id ? project.run.pending : undefined;
      if (plannerPending && !record.planner) { record.planner = { projectId, runId }; this.dirty = true; }
      if (record.planner) handledRecovery.add(record.row.id);
      const executingAt = state?.phase === "executing" && !native?.problem ? timestamp(state.phaseAt) : null;
      if (executingAt) for (const entry of this.records.values()) if (entry.row.agentId === agent.id
        && !TERMINAL[entry.row.stage] && attemptTime(entry) <= executingAt) {
        this.change(entry, "completed", "normal", executingAt, "Native plan phase explicitly entered execution");
      }
      if (transfer) for (const entry of this.records.values()) if (entry.row.agentId === agent.id
        && !TERMINAL[entry.row.stage] && entry.row.stage !== "ready" && attemptTime(entry) <= transfer.at!) {
        this.change(entry, "superseded", "normal", transfer.at!, "Planning owner explicitly handed over to a successor");
      }
      if (link?.remote && (agent.archivedAt || agent.status === "closed")) for (const entry of this.records.values()) if (entry.row.agentId === agent.id
        && !TERMINAL[entry.row.stage] && entry.row.stage !== "ready") {
        this.change(entry, "superseded", "normal", entry.row.since, "Session explicitly transferred to a peer host");
      }
      if (TERMINAL[record.row.stage]) return;
      if (record.row.stage === "ready") return; // real delivery survives retirement and source loss
      if (!ownersUnavailable) record.ownerFailedAt = timestamp(ownerFailure?.failedAt) ?? undefined;
      let progressAt = state?.progress ?? record.row.lastProgressAt;
      if (record.row.lastProgressAt && (!progressAt || record.row.lastProgressAt > progressAt)) progressAt = record.row.lastProgressAt;
      if (timeline?.progress && (!progressAt || timeline.progress > progressAt)) progressAt = timeline.progress;
      if (progressAt && (!record.row.lastProgressAt || progressAt > record.row.lastProgressAt)) record.row.lastProgressAt = progressAt;
      const revision = revisions.at(-1);
      let stage: PipelineStage = parkedPlan || revision?.stage === "publishing" || timeline?.submitAt ? "publishing" : "preparing";
      let status: PipelineStatus = "normal";
      let detail = stage === "publishing" ? "Submission observed; waiting for actual inbox delivery" : "Preparing plan";
      let at = revision?.attemptAt ?? timestamp(parkedPlan?.parkedAt) ?? cycleAt;
      const advisor = agents.find((child) => child.labels?.["paseo.parent-agent-id"] === agent.id && (child.runtimeInfo?.model ?? child.model) === ADVISOR_MODEL && !child.archivedAt && (child.status === "running" || child.status === "initializing"));
      if (stage !== "publishing" && advisor && (!state?.adviceAt || advisor.activeTurn?.startedAt && advisor.activeTurn.startedAt > state.adviceAt)) {
        stage = "advisor"; at = timestamp(advisor.activeTurn?.startedAt) ?? advisor.createdAt; detail = "Explicit plan advisor is reviewing";
        try {
          const advisorProgress = (await this.timeline(advisor)).progress;
          if (advisorProgress && (!progressAt || advisorProgress > progressAt)) {
            progressAt = advisorProgress; record.row.lastProgressAt = advisorProgress;
          }
        } catch { problem = "Advisor progress source unavailable"; issues.push(problem); }
      }
      if (link?.agentId === agent.id && link.queued && !link.closed && !link.remote && !agents.some((candidate) => !candidate.labels?.["paseo.parent-agent-id"] && candidate.labels?.["linear.sessionId"] === link.sessionId)) {
        stage = "queued"; at = link.createdAt; detail = queueDetail(link);
      } else if (ownerWait || link?.agentId === agent.id && !link.closed && (link.questions || link.review) || agent.pendingPermissions?.length) {
        stage = "waiting"; at = timestamp(ownerWait?.at) ?? timestamp(link?.review?.openedAt) ?? cycleAt;
        detail = link?.agentId === agent.id && !link.closed && link.review ? "Review exists; waiting for owner (inbox delivery not confirmed)" : "Waiting for owner's question or permission response";
      }
      const legitimateWait = stage === "queued" || stage === "waiting";
      const delivery = this.deliveries[agent.id];
      const failedSubmit = revision?.failure ?? timeline?.failure ?? (!native && record.row.status === "failed" && record.row.stage === "publishing" ? record.row.detail : undefined);
      const failedAt = timestamp(ownerFailure?.failedAt) ?? (ownersUnavailable ? record.ownerFailedAt : undefined);
      const turnAt = timestamp(agent.activeTurn?.startedAt);
      const stoppedOwner = failedAt && (!progressAt || progressAt <= failedAt) && (!turnAt || turnAt <= failedAt);
      const cursor = this.cursors[agent.id];
      const retainedNative = !native && cursor?.path === agent.persistence?.nativeHandle ? cursor?.state : undefined;
      const retainedError = retainedNative?.errorAt && (!progressAt || progressAt <= retainedNative.errorAt) ? retainedNative.error : undefined;
      const crashAt = state?.crashAt ?? (retainedNative?.crashAt && (!progressAt || progressAt <= retainedNative.crashAt) ? retainedNative.crashAt : undefined);
      const providerError = state?.error ?? retainedError ?? (agent.status === "error" && agent.lastError ? diagnostic(agent.lastError) : undefined);
      if (providerError && /Provider rate limit \(429\)/.test(providerError)
        && !(record.planner && (legitimateWait || failedSubmit || delivery && delivery.at >= (revision?.attemptAt ?? cycleAt)))) {
        status = "failed"; detail = providerError;
      } else if (!legitimateWait && (delivery && delivery.at >= (revision?.attemptAt ?? cycleAt) || failedSubmit)) {
        stage = "publishing"; status = "failed"; detail = delivery && delivery.at >= (revision?.attemptAt ?? cycleAt) ? delivery.detail : failedSubmit ?? "Plan submission failed";
        at = delivery && delivery.at >= (revision?.attemptAt ?? cycleAt) ? delivery.at : revision?.failureAt ?? at;
      } else if (!legitimateWait && !parkedPlan && (providerError || crashAt || ownersUnavailable && stoppedOwner)) {
        status = "failed"; detail = providerError ?? (crashAt ? "Provider session recorded an abnormal process exit; reload before resuming" : "Owner record confirms unfinished planner stopped; current owner evidence unavailable");
      } else if (problem && !legitimateWait) {
        status = "unknown"; detail = problem;
      } else if (!legitimateWait && !parkedPlan && (stoppedOwner || !state?.disposedAt && ghosts.has(agent.id))) {
        status = "failed"; detail = stoppedOwner ? "Owner record confirms unfinished planner stopped; no subsequent turn progress observed" : "Provider process proven absent";
      } else if (!legitimateWait && !parkedPlan && state?.disposedAt) {
        status = "attention"; detail = "Planner session was disposed normally; unfinished planning is not proof of a crash";
      } else if (!legitimateWait && now - Date.parse(progressAt ?? cycleAt) >= QUIET_MS) {
        status = "attention"; detail = "No recent assistant/tool progress; quiet stage suspected, not proven failed";
      }
      let recovered = false;
      if (record.planner) {
        const expectedFailure = !providerError || /Provider rate limit \(429\)|Provider process exited or is closed/.test(providerError)
          || !state?.error && !retainedError && Boolean(limitError(agent.lastError ?? ""));
        const protectedEvidence = legitimateWait || parkedPlan || failedSubmit || delivery && delivery.at >= (revision?.attemptAt ?? cycleAt)
          || !expectedFailure || plannerPending && (progressAt && progressAt > plannerPending.failedAt || turnAt && turnAt > plannerPending.failedAt);
        if (!protectedEvidence) recovered = this.observeRecovery(record, planners.get(record.planner.projectId), agent,
          liveRuns.has(JSON.stringify([record.planner.projectId, record.planner.runId])), now, recoveryUnavailable);
      }
      if (!recovered) this.change(record, stage, status, at, detail);
      // A known newer submission supersedes only the preceding nonterminal revision of THIS
      // agent. Never cancel a disappearing root or conflate two planners of the same ticket.
      if (revision?.attemptAt) for (const other of this.records.values()) {
        if (other !== record && other.row.agentId === agent.id && !TERMINAL[other.row.stage] && attemptTime(other) < revision.attemptAt) this.change(other, "superseded", "normal", revision.attemptAt, "Replaced by a newer plan submission");
      }
    });
    for (const plan of parked) {
      const record = this.latest(plan.agentId) ?? this.ensure(plan.agentId, plan.identifier, `parked:${plan.parkedAt}`, plan.parkedAt);
      if (!TERMINAL[record.row.stage] && record.row.stage !== "ready" && record.row.stage !== "waiting") this.change(record, "publishing", record.row.status, timestamp(plan.parkedAt) ?? record.row.since, record.row.status === "failed" ? record.row.detail : "Parked plan recorded; inbox delivery not confirmed");
    }
    const exactSessions = new Map<string, PaseoAgent>(), liveSessions = new Set<string>();
    for (const agent of agents) {
      const sessionId = agent.labels?.["linear.sessionId"];
      if (!sessionId || agent.labels?.["paseo.parent-agent-id"]) continue;
      const before = exactSessions.get(sessionId);
      if (!before || agent.createdAt > before.createdAt) exactSessions.set(sessionId, agent);
      if (!agent.archivedAt && agent.status !== "closed" && !ghosts.has(agent.id)
        && !(agent.status === "error" && /\bprocess (exited|is closed)\b/i.test(agent.lastError ?? ""))) liveSessions.add(sessionId);
    }
    for (const link of links) if (link.queued && !link.closed && !link.remote && !link.group && !link.agentId) {
      const restart = object(link).restartRequested === true, pending = Boolean(link.pendingText);
      const ran = exactSessions.get(link.sessionId);
      if (!restart && !(pending && !liveSessions.has(link.sessionId)) && ran?.labels?.["linear.issueId"] === link.issueId) continue;
      const cycles = [...this.records.values()].filter((entry) => entry.row.agentId === ""
        && (entry.queue?.sessionId === link.sessionId || entry.key === `queue:${link.sessionId}`));
      let queued = cycles.find((entry) => !TERMINAL[entry.row.stage]);
      if (!queued) {
        const previous = cycles.sort((a, b) => attemptTime(b).localeCompare(attemptTime(a)))[0];
        const key = previous ? `queue:${link.sessionId}:cycle:${createHash("sha256").update(previous.row.id).digest("hex").slice(0, 20)}` : `queue:${link.sessionId}`;
        queued = this.ensure("", link.identifier, key, previous ? this.now().toISOString() : link.createdAt);
      }
      queued.queue ??= { sessionId: link.sessionId, restart, pending };
      queued.queue.restart = restart; queued.queue.pending = pending;
      this.change(queued, "queued", agentSource.status === "fulfilled" ? "normal" : "unknown", queued.row.since,
        agentSource.status === "fulfilled" ? queueDetail(link) : "Exact-session agent history unavailable; admission unconfirmed");
    }
    for (const queued of this.records.values()) {
      if (!queued.key.startsWith("queue:") || queued.row.agentId !== "" || TERMINAL[queued.row.stage]) continue;
      const sessionId = queued.queue?.sessionId ?? queued.key.slice(6), link = links.find((entry) => entry.sessionId === sessionId);
      const ran = exactSessions.get(sessionId);
      const restart = link ? object(link).restartRequested === true : queued.queue?.restart;
      const pending = link ? Boolean(link.pendingText) : queued.queue?.pending;
      if (link?.closed) this.change(queued, "cancelled", "normal", link.createdAt, "Queued session explicitly closed");
      else if (link?.remote) this.change(queued, "superseded", "normal", link.createdAt, "Queued session explicitly transferred to a peer host");
      else if (link?.agentId) this.change(queued, "completed", "normal", agents.find((agent) => agent.id === link.agentId)?.createdAt ?? link.createdAt, "Admission resolved; session linked to its agent");
      else if (ran && (!link || ran.labels?.["linear.issueId"] === link.issueId) && !restart && !(pending && !liveSessions.has(sessionId))) this.change(queued, "completed", "normal", ran.createdAt, "Admission resolved; exact-session agent already ran");
      else if (agentSource.status === "rejected" || sessionSource.status === "rejected") this.change(queued, "queued", "unknown", queued.row.since, "Queue sources unavailable; retaining unconfirmed admission");
    }
    // Current project evidence also owns roots absent from the daemon and launches without a root.
    for (const project of planners.values()) {
      const run = project.run;
      if (!run?.pending || run.approved) continue;
      const key = `planner-recovery:${JSON.stringify([project.projectId, run.runId])}`;
      const agent = run.agentId ? agents.find((candidate) => candidate.id === run.agentId) : undefined;
      if (agent && (agent.labels?.["linear.projectId"] !== project.projectId || agent.labels?.["linear.plannerRun"] !== run.runId
        || agent.labels?.["linear.issueId"] || agent.labels?.["paseo.parent-agent-id"])) continue;
      const existing = [...this.records.values()].find((entry) => entry.planner?.projectId === project.projectId
        && entry.planner.runId === run.runId && entry.row.agentId === (run.agentId ?? "") && !TERMINAL[entry.row.stage]);
      // A live implementing root or a real terminal review must not acquire a recovery placeholder.
      const previous = run.agentId ? this.latest(run.agentId) : undefined;
      if (!existing && run.agentId && (agent && !agent.archivedAt && LIVE_AGENT[agent.status] && !ghosts.has(agent.id)
        || previous && (TERMINAL[previous.row.stage] || previous.row.stage === "ready"))) continue;
      const record = existing ?? this.ensure(run.agentId ?? "", agent?.title || `Planner run ${run.runId.slice(0, 8)}`, key, run.pending.failedAt);
      if (!record.planner) { record.planner = { projectId: project.projectId, runId: run.runId }; this.dirty = true; }
    }
    for (const record of this.records.values()) {
      if (!record.planner || handledRecovery.has(record.row.id) || TERMINAL[record.row.stage] || record.row.stage === "ready") continue;
      const agent = record.row.agentId ? agents.find((candidate) => candidate.id === record.row.agentId) : undefined;
      if (parked.some((plan) => plan.agentId === record.row.agentId) || record.submittedAt || this.deliveries[record.row.agentId]
        || agent?.pendingPermissions?.length) continue;
      const pending = planners.get(record.planner.projectId)?.run?.pending;
      if (pending && record.row.lastProgressAt && record.row.lastProgressAt > pending.failedAt) continue;
      this.observeRecovery(record, planners.get(record.planner.projectId), agent,
        liveRuns.has(JSON.stringify([record.planner.projectId, record.planner.runId])), now, recoveryUnavailable);
    }
    this.applyInbox();
    this.prune();
    const checkedBefore = this.checkedAt;
    if (!issues.length) { this.checkedAt = this.now().toISOString(); this.error = undefined; }
    else this.error = [...new Set(issues)].slice(0, 4).join("; ").slice(0, 1400);
    this.dirty = true;
    try { await this.persist(); this.loadProblem = undefined; }
    catch (error) { this.checkedAt = checkedBefore; throw error; }
  }

  private prune(): void {
    // Keep all live rows first; bounded resolved history is retained across restarts.
    if (this.records.size > MAX_ROWS) {
      const oldest = [...this.records.values()].sort((a, b) => Number(!TERMINAL[a.row.stage]) - Number(!TERMINAL[b.row.stage]) || a.row.since.localeCompare(b.row.since));
      for (const entry of oldest.slice(0, this.records.size - MAX_ROWS)) this.records.delete(entry.row.id);
    }
    const retained = Object.keys(this.cursors).slice(-MAX_ROOTS);
    this.cursors = Object.fromEntries(retained.map((id) => [id, this.cursors[id]]));
    for (const id of this.readers.keys()) if (!this.cursors[id]) this.readers.delete(id);
    this.deliveries = Object.fromEntries(Object.entries(this.deliveries).slice(-MAX_ROOTS));
  }

  private persist(): Promise<void> {
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const journal: Journal = { version: 1, checkedAt: this.checkedAt, lastArrivalAt: this.lastArrivalAt, records: [...this.records.values()], cursors: this.cursors, deliveries: this.deliveries };
        const text = JSON.stringify(journal);
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, text, { mode: 0o600, flag: "wx" }); await rename(temporary, this.file); }
        finally { await rm(temporary, { force: true }); }
      }
    })().finally(() => { this.saving = null; });
    return this.saving;
  }
}
