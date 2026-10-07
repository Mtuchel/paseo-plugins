import { open, opendir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { plannerRecoverySchema } from "./project-flow";
import type { HandoverRecord } from "./handover";
import type { PipelineOwnerEvidence } from "./plan-pipeline";

// Only provider-native OMP session files named by the PUBLIC persistence handle are read.
// Shapes below are emitted by OMP and the installed Plannotator extension, not daemon disk fields.
const READ_BYTES = 1024 * 1024;
const CHECKPOINTS = 64;
const REVISIONS = 32;
type ObjectValue = Record<string, unknown>;
export type NativeRevision = {
  key: string; at: string; progress: string | null;
  stage: "preparing" | "publishing" | "auto-approved" | "completed" | "cancelled";
  attempt?: string; attemptAt?: string; hash?: string; failure?: string; failureAt?: string; resolvedAt?: string;
};
export type NativeState = {
  phase?: string; phaseAt?: string; progress: string | null; planningAt?: string;
  hash?: string; advisor?: string; adviceAt?: string;
  revisions: NativeRevision[]; head?: string; unknown?: boolean; crashAt?: string; disposedAt?: string; error?: string; errorAt?: string;
};
export type NativeCursor = { path: string; inode: string; offset: number; anchor: string; state: NativeState };
export type NativeEvidence = { state: NativeState; cursor: NativeCursor; complete: boolean; problem?: string };

async function sourceJson(path: string, limit: number, strictEnvelope = false): Promise<ObjectValue | null> {
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Owner evidence exceeds safe bound");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    if (bytes !== stat.size) throw new Error("Owner evidence changed during read");
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    if (strictEnvelope && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("Planner evidence malformed");
    return object(parsed);
  } finally { await file.close(); }
}

/** Bounded local ownership sample; no Linear reads and no work on the inbox HTTP path. */
export async function pipelineOwnerEvidence(home: string, issueIds: readonly string[], readOwner?: (issueId: string) => Promise<HandoverRecord | null>): Promise<PipelineOwnerEvidence[]> {
  if (issueIds.length > 512) throw new Error("Owner evidence exceeds safe bound");
  if (!issueIds.length) return [];
  const unresolvedWaits = new Set<string>();
  const owners = new Map<string, PipelineOwnerEvidence>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, issueIds.length) }, async () => {
    while (index < issueIds.length) {
      const issueId = issueIds[index++];
      // The general handover reader intentionally swallows errors. Monitoring must distinguish
      // an absent record from unreadable evidence; only ENOENT means there is no owner record.
      const value = readOwner ? await readOwner(issueId) : await sourceJson(join(home, "linear-tickets", "handover", `${issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`), 64 * 1024);
      if (value === null) continue;
      const record = object(value), waiting = record.waiting == null ? null : object(record.waiting);
      if (record.issueId !== issueId || typeof record.agentId !== "string" || !timestamp(record.updatedAt)) throw new Error("Owner evidence malformed");
      if (waiting && ((waiting.previousStateId !== null && typeof waiting.previousStateId !== "string")
        || (waiting.commentId !== null && typeof waiting.commentId !== "string"))) throw new Error("Owner wait evidence malformed");
      if (typeof waiting?.subIssueId === "string") unresolvedWaits.add(waiting.subIssueId);
      owners.set(`${issueId}:${record.agentId}`, {
        issueId, agentId: record.agentId, waiting: Boolean(waiting && !waiting.subIssueId),
        at: timestamp(record.updatedAt)!,
        ...(record.status === "failed" ? { failedAt: timestamp(record.updatedAt)! } : {}),
        ...(typeof record.resumedFrom === "string" ? { resumedFrom: record.resumedFrom } : {}),
      });
    }
  }));
  const directory = join(home, "linear-tickets", "needs-you");
  const dir = await opendir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!dir) {
    if (unresolvedWaits.size) throw new Error("Needs-you wait evidence unavailable");
    return [...owners.values()];
  }
  const requested = new Set(issueIds);
  let files = 0;
  for await (const entry of dir) {
    if (++files > 1000) throw new Error("Needs-you evidence exceeds safe bound");
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = await sourceJson(join(directory, entry.name), 16 * 1024);
    if (!value) throw new Error("Needs-you evidence changed during read");
    if (typeof value.id !== "string" || typeof value.parentId !== "string" || typeof value.agentId !== "string") throw new Error("Needs-you evidence malformed");
    if (!requested.has(value.parentId)) continue;
    unresolvedWaits.delete(value.id);
    const key = `${value.parentId}:${value.agentId}`, before = owners.get(key);
    owners.set(key, { ...before, issueId: value.parentId, agentId: value.agentId, waiting: true });
    if (owners.size > 1000) throw new Error("Owner evidence exceeds safe bound");
  }
  if (unresolvedWaits.size) throw new Error("Needs-you wait evidence unavailable");
  return [...owners.values()];
}

const plannerIdentity = z.string().min(1).max(200);
const plannerTime = z.string().refine((value) => Boolean(timestamp(value)));
const plannerEvidenceSchema = z.object({
  closedPlanner: plannerIdentity.optional(),
  planner: z.object({
    id: plannerIdentity, agentId: plannerIdentity.optional(), listedAt: plannerTime,
    startedAt: plannerTime.optional(), ownerAsked: z.boolean().optional(),
    approved: z.object({ agentId: plannerIdentity.nullable(), plan: z.string(), done: z.array(z.string()).optional() }).optional(),
    recovery: plannerRecoverySchema.optional(),
  }).nullable(),
});
type Recovery = z.infer<typeof plannerRecoverySchema>;
export type PipelinePlannerEvidence = {
  projectId: string; closedRunId?: string;
  run?: {
    runId: string; agentId?: string; listedAt: string; ownerAsked: boolean; approved: boolean;
    pending?: Pick<NonNullable<Recovery["pending"]>, "identity" | "failedAt" | "resumeAt">;
    claim?: Recovery["claim"];
  };
};

/** Observe only persisted recovery ownership and times; never expose plans or provider errors. */
export async function pipelinePlannerEvidence(home: string): Promise<PipelinePlannerEvidence[]> {
  const raw = await sourceJson(join(home, "linear-tickets", "projects.json"), 4 * 1024 * 1024, true);
  if (!raw) return [];
  const entries = Object.entries(raw).filter(([id]) => id !== "~repairs");
  if (entries.length > 512) throw new Error("Planner evidence exceeds safe bound");
  return entries.map(([projectId, value]) => {
    const parsed = plannerEvidenceSchema.safeParse(value);
    if (!plannerIdentity.safeParse(projectId).success || !parsed.success) throw new Error("Planner evidence malformed");
    const { planner, closedPlanner } = parsed.data;
    const pending = planner?.recovery?.pending;
    return {
      projectId, ...(closedPlanner ? { closedRunId: closedPlanner } : {}),
      ...(planner ? { run: {
        runId: planner.id, agentId: planner.agentId, listedAt: timestamp(planner.listedAt)!,
        ownerAsked: planner.ownerAsked === true, approved: Boolean(planner.approved),
        ...(pending ? { pending: { identity: pending.identity, failedAt: timestamp(pending.failedAt)!, resumeAt: timestamp(pending.resumeAt)! } } : {}),
        ...(planner.recovery?.claim ? { claim: { ...planner.recovery.claim, at: timestamp(planner.recovery.claim.at)! } } : {}),
      } } : {}),
    };
  });
}

function object(value: unknown): ObjectValue { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {}; }
export function timestamp(value: unknown): string | null {
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function later(a: string | null | undefined, b: string | null | undefined): string | null { return !a ? b ?? null : !b ? a : a > b ? a : b; }
function empty(): NativeState { return { progress: null, revisions: [] }; }
function copy(state: NativeState): NativeState { return { ...state, revisions: state.revisions.map((revision) => ({ ...revision })) }; }
function current(state: NativeState, at: string): NativeRevision {
  let revision = state.revisions.at(-1);
  if (!revision || ["auto-approved", "completed", "cancelled"].includes(revision.stage)) {
    revision = { key: `planning:${state.planningAt ?? at}`, at: state.planningAt ?? at, progress: state.progress, stage: "preparing" };
    state.revisions.push(revision);
  }
  return revision;
}
function progress(state: NativeState, at: string): void {
  state.progress = later(state.progress, at);
  const revision = state.revisions.at(-1);
  if (revision && !["auto-approved", "completed", "cancelled"].includes(revision.stage)) revision.progress = later(revision.progress, at);
  if (state.crashAt && at > state.crashAt) delete state.crashAt;
  if (state.disposedAt && at > state.disposedAt) delete state.disposedAt;
  if (state.errorAt && at > state.errorAt) { delete state.error; delete state.errorAt; }
}
function submission(name: unknown, input: ObjectValue): boolean {
  if (name === "plannotator_submit_plan") return true;
  if (name !== "write") return false;
  return input.path === "xd://propose" || input.path === "xd://plannotator_submit_plan";
}
function submit(state: NativeState, id: unknown, at: string): void {
  if (typeof id !== "string" || !id) { state.unknown = true; return; }
  const before = state.revisions.at(-1);
  if (before?.attempt === id) return; // assistant call followed by tool_execution_start
  // Content is not an attempt identity: an unchanged-content resubmission is still a new review.
  const key = `submit:${id.slice(0, 200)}`;
  let revision = before;
  if (!revision || revision.attempt || ["auto-approved", "completed", "cancelled"].includes(revision.stage)) {
    revision = { key, at, progress: at, stage: "publishing" };
    state.revisions.push(revision);
  }
  revision.key = key;
  revision.stage = "publishing";
  revision.attempt = id.slice(0, 200);
  revision.attemptAt = at;
  revision.hash = state.hash;
  delete revision.failure;
  delete revision.failureAt;
  progress(state, at);
}

// Diagnostic text is a classification, never arbitrary provider output, prompts or tool args.
export function diagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = object(error).code;
  if (/import|Cannot find (module|package)|module.*not found|ERR_MODULE_NOT_FOUND/i.test(raw)) return "Plan tool dependency/import failed";
  if (/\b429\b|rate.?limit|quota.*exceed/i.test(raw)) {
    const retry = /\b(retryAfter|retry-after-ms|retry-after)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(raw);
    const seconds = retry ? Number(retry[2]) / (retry[1].toLowerCase() === "retry-after-ms" ? 1000 : 1) : NaN;
    return `Provider rate limit (429); ${Number.isFinite(seconds) && seconds > 0 && seconds <= 365 * 86400 ? `retry after ${Math.ceil(seconds)} seconds; ` : ""}wait for provider quota before retrying`;
  }
  if (/\bprocess (exited|is closed)\b/i.test(raw)) return "Provider process exited or is closed; reload is required before resuming";
  if (/ECONNREFUSED|connection refused/i.test(raw)) return "Review delivery connection refused";
  if (/ETIMEDOUT|timed? ?out|timeout/i.test(raw)) return "Review delivery timed out";
  if (/EACCES|EPERM|permission denied/i.test(raw)) return "Evidence or delivery access denied";
  if (/ENOENT|no such file/i.test(raw)) return "Evidence file unavailable";
  if (typeof code === "string" && /^[A-Z_0-9]{1,40}$/.test(code)) return `Source operation failed (${code})`;
  return "Source or delivery operation failed";
}
function result(state: NativeState, message: ObjectValue, at: string): void {
  const revision = state.revisions.at(-1);
  if (!revision || revision.attempt !== message.toolCallId) return;
  const details = object(message.details);
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content.map((part) => object(part).text).filter((part): part is string => typeof part === "string").join("\n");
  if (message.isError === true || /^(Error:|Failed to |Cannot find (module|package))/.test(text)) {
    revision.failure = diagnostic(text); revision.failureAt = at;
  } else if (details.approved === true) {
    if (revision.stage !== "completed") { revision.stage = "auto-approved"; revision.resolvedAt = at; }
  } else if (details.pending !== true && details.approved === false && typeof details.feedback === "string") {
    // Feedback is not a tool failure or proof of inbox delivery. The inbox/parked sources
    // resolve the revision; a subsequent actual submission identifies its replacement.
    revision.stage = "publishing";
  }
  progress(state, at);
}
function apply(state: NativeState, entry: ObjectValue): void {
  const data = object(entry.data);
  const at = timestamp(entry.timestamp) ?? timestamp(data.at);
  if (!at) return;
  if (entry.type !== "title") {
    if (state.crashAt && at > state.crashAt) delete state.crashAt;
    if (state.disposedAt && at > state.disposedAt) delete state.disposedAt;
  }
  const kind = entry.customType;
  if (entry.type === "custom" && kind === "linear-tickets.plan-first") {
    if (!state.planningAt || (state.phase !== "planning" && at > state.planningAt)) {
      state.hash = undefined; state.advisor = undefined; state.adviceAt = undefined;
      state.planningAt = at; current(state, at);
    }
    state.phase = "planning"; state.phaseAt = at;
  } else if (entry.type === "custom" && kind === "plannotator") {
    const previous = state.phase;
    if (["idle", "planning", "executing"].includes(String(data.phase))) {
      state.phase = String(data.phase); state.phaseAt = at;
      if (state.phase === "planning" && previous !== "planning") {
        state.planningAt = at; state.hash = undefined; state.advisor = undefined; state.adviceAt = undefined;
        current(state, at);
      }
      if (state.phase === "idle" && previous === "planning") {
        const revision = current(state, at); revision.stage = "cancelled"; revision.resolvedAt = at;
      }
      const revision = state.revisions.at(-1);
      if (state.phase === "executing" && revision) {
        if (revision.stage !== "auto-approved") { revision.stage = "completed"; revision.resolvedAt = at; }
      }
    } else state.unknown = true;
  } else if (entry.type === "custom" && kind === "linear-tickets.plan-advice") {
    state.hash = typeof data.hash === "string" && /^[a-f0-9]{64}$/.test(data.hash) ? data.hash : undefined;
    state.advisor = typeof data.advisorAgentId === "string" ? data.advisorAgentId.slice(0, 100) : undefined;
    state.adviceAt = at; progress(state, at);
  } else if (entry.type === "custom" && kind === "plannotator-execute") {
    const revision = state.revisions.at(-1);
    if (revision) { revision.stage = typeof data.approvedPlan === "string" ? "completed" : "auto-approved"; revision.resolvedAt = at; }
    state.phase = "executing"; state.phaseAt = at;
  } else if (kind === "plannotator-complete" || kind === "plannotator-handoff") {
    const revision = state.revisions.at(-1);
    if (revision) { revision.stage = "completed"; revision.resolvedAt = at; }
  } else if (entry.type === "custom" && kind === "session_exit") {
    const exitAt = timestamp(data.recordedAt) ?? at;
    if (data.kind === "normal" && data.reason === "dispose") state.disposedAt = exitAt;
    else if (["crash", "error", "signal"].includes(String(data.kind)) || typeof data.code === "number" && data.code !== 0) state.crashAt = exitAt;
    else state.unknown = true;
  } else if (entry.type === "custom" && kind === "tool_execution_start") {
    progress(state, at);
    if (submission(data.toolName, object(data.args))) submit(state, data.toolCallId, at);
  } else if (entry.type === "message") {
    const message = object(entry.message);
    if (message.role === "assistant") {
      progress(state, at);
      if (message.stopReason === "error" || typeof message.errorMessage === "string" && /\bprocess (exited|is closed)\b/i.test(message.errorMessage)) {
        state.error = diagnostic(message.errorMessage); state.errorAt = at;
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const call = object(part);
        if (call.type === "toolCall" && submission(call.name, object(call.arguments))) submit(state, call.id, at);
      }
    } else if (message.role === "toolResult") { progress(state, at); result(state, message, at); }
  }
  state.revisions = state.revisions.slice(-REVISIONS);
}

export class NativeReader {
  // Recent branch points are retained in memory; an unsupported old rewind fails unknown, not
  // approval/cancellation inferred from the abandoned branch. Only the current summary is persisted.
  private checkpoints = new Map<string, NativeState>();
  async read(path: string, saved?: NativeCursor): Promise<NativeEvidence> {
    if (!isAbsolute(path) || !path.endsWith(".jsonl")) throw new Error("Unsupported OMP native handle");
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Unsupported OMP native handle");
      const inode = `${stat.dev}:${stat.ino}`;
      let offset = saved?.offset ?? 0;
      let state = saved ? copy(saved.state) : empty();
      const anchor = async (end: number): Promise<string> => {
        const buffer = Buffer.alloc(Math.min(128, end));
        const read = await file.read(buffer, 0, buffer.length, Math.max(0, end - buffer.length));
        return buffer.subarray(0, read.bytesRead).toString("base64");
      };
      if (!saved || saved.path !== path || saved.inode !== inode || stat.size < offset || await anchor(offset) !== saved.anchor) {
        offset = 0; state = empty(); this.checkpoints.clear();
      }
      const ingest = (text: string, target: NativeState, branched: boolean): NativeState => {
        for (const line of text.split("\n")) {
          if (!line) continue;
          let entry: ObjectValue;
          try { entry = object(JSON.parse(line)); } catch { target.unknown = true; continue; }
          if (entry.type === "session" || entry.type === "title") continue;
          const id = typeof entry.id === "string" ? entry.id : undefined;
          if (branched && target.head && entry.parentId !== target.head) {
            const checkpoint = typeof entry.parentId === "string" ? this.checkpoints.get(entry.parentId) : undefined;
            target = checkpoint ? copy(checkpoint) : { ...empty(), unknown: true };
          }
          apply(target, entry);
          if (id) {
            target.head = id;
            if (branched) {
              this.checkpoints.set(id, copy(target));
              while (this.checkpoints.size > CHECKPOINTS) this.checkpoints.delete(this.checkpoints.keys().next().value!);
            }
          }
        }
        return target;
      };
      const bytes = Buffer.alloc(Math.min(READ_BYTES, stat.size - offset));
      const read = await file.read(bytes, 0, bytes.length, offset);
      const end = bytes.subarray(0, read.bytesRead).lastIndexOf(10);
      if (end >= 0) { state = ingest(bytes.subarray(0, end + 1).toString("utf8"), state, true); offset += end + 1; }
      else if (read.bytesRead === READ_BYTES) {
        // Oversized records are not retained (they may contain complete prompts). Move to the
        // next bounded window; until a newline the evidence is explicitly incomplete.
        offset += read.bytesRead; state.unknown = true;
      }
      const cursor: NativeCursor = { path, inode, offset, anchor: await anchor(offset), state };
      const complete = offset === stat.size;
      if (!complete && stat.size - offset > READ_BYTES) {
        // Initial discovery gets current state immediately while the forward cursor backfills
        // bounded history. Never treat this disconnected tail as complete branch evidence.
        const start = Math.max(offset, stat.size - READ_BYTES);
        const tail = Buffer.alloc(stat.size - start);
        const readTail = await file.read(tail, 0, tail.length, start);
        const slice = tail.subarray(0, readTail.bytesRead);
        const first = slice.indexOf(10), last = slice.lastIndexOf(10);
        if (first >= 0 && last > first) {
          const latest = ingest(slice.subarray(first + 1, last + 1).toString("utf8"), copy(state), false);
          return { state: latest, cursor, complete: false, problem: "Native history backfill incomplete" };
        }
      }
      return { state, cursor, complete, ...(!complete || state.unknown || !state.phase ? { problem: "Native evidence incomplete or unsupported" } : {}) };
    } finally { await file.close(); }
  }
}
