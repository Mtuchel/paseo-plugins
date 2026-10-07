import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { SessionLink } from "./sessions";
import type { ParkedPlan } from "./parked";
import type { HandoverRecord } from "./handover";
import { ADVISOR_MODEL } from "../shared/plan-advisor";
import { PlanPipeline, type PipelineReview } from "./plan-pipeline";
import { NativeReader, pipelineOwnerEvidence } from "./plan-pipeline-source";
import type { PipelineHost } from "../shared/plan-pipeline";

const START = "2026-10-06T12:00:00.000Z";
const SUBMIT = "2026-10-06T12:01:00.000Z";
const ARRIVED = "2026-10-06T12:01:05.000Z";
const HASH_A = "a".repeat(64), HASH_B = "b".repeat(64);
// Reduced REAL OMP JSONL shapes: session v3; append-only id/parentId tree; custom planning
// state and advice; assistant toolCall arguments; tool_execution_start; toolResult details.
// No copied prompts, paths, plan content or credentials from the observed host fixtures.
type FixtureEntry = { type: string; timestamp?: string; customType?: string; data?: Record<string, unknown>; message?: Record<string, unknown> };
function planning(): FixtureEntry[] {
  return [
    { type: "custom", timestamp: START, customType: "plannotator", data: { phase: "idle", lastSubmittedPath: null } },
    { type: "custom", timestamp: START, customType: "plannotator", data: { phase: "planning", lastSubmittedPath: null } },
    { type: "custom", timestamp: START, customType: "linear-tickets.plan-first", data: { reason: "launch", policy: "required", at: START } },
  ];
}
function submit(hash = HASH_A, id = "submit-a", at = SUBMIT): FixtureEntry[] {
  return [
    { type: "custom", customType: "linear-tickets.plan-advice", timestamp: at, data: { hash, advisorAgentId: "advisor", verdict: "agreed", at } },
    { type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id, name: "plannotator_submit_plan", arguments: { filePath: "plans/ticket.md" } }] } },
    { type: "custom", customType: "tool_execution_start", timestamp: at, data: { toolCallId: id, toolName: "plannotator_submit_plan", startedAt: at } },
  ];
}
function result(details: Record<string, unknown>, isError = false, text = "Plan submitted", id = "submit-a", at = ARRIVED): FixtureEntry {
  return { type: "message", timestamp: at, message: { role: "toolResult", toolCallId: id, toolName: "plannotator_submit_plan", content: [{ type: "text", text }], details, isError } };
}
function review(extra: Partial<PipelineReview> = {}): PipelineReview {
  return { agentId: "root", name: "TUC-99", since: ARRIVED, link: "https://host.test:8444/review/root", ...extra };
}
function link(extra: Partial<SessionLink> = {}): SessionLink {
  return { sessionId: "thread", agentId: "root", issueId: "issue", identifier: "TUC-99", createdAt: START, handled: [], review: null, offer: null, ...extra };
}
function parked(): ParkedPlan {
  return { issueId: "issue", identifier: "TUC-99", agentId: "root", plan: "# Private plan not exposed", line: "Owner review", reasons: [], model: null, parkedAt: ARRIVED, announced: true };
}
function owner(extra: Partial<HandoverRecord> = {}): HandoverRecord {
  return {
    issueId: "issue", identifier: "TUC-99", agentId: "root", agentTitle: "Planner",
    branch: null, worktreePath: null, lastCommit: null, summaries: [], links: {},
    status: "working", waiting: null, progressCommentId: null, resumedFrom: null, updatedAt: ARRIVED,
    ...extra,
  };
}

type Harness = {
  pipeline: PlanPipeline; home: string; file: string; native: string; agents: PaseoAgent[];
  sessions: SessionLink[]; parked: ParkedPlan[]; clock: Date; failList: boolean; absent: boolean;
  timelines: Record<string, { timestamp: string; item: Record<string, unknown> }[]>;
  owners: Map<string, HandoverRecord>; ownerFiles: boolean;
  append(entries: FixtureEntry[]): Promise<void>;
  snapshot(open?: PipelineReview[], decided?: PipelineReview[]): Promise<PipelineHost>;
  restart(): Promise<void>; refresh(): Promise<void>;
};
async function harness(run: (h: Harness) => Promise<void>, entries = planning()): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "plan-pipeline-"));
  const native = join(home, "session.jsonl"), file = join(home, "journal.json");
  let seq = 0, parentId: string | null = null;
  const append = async (values: FixtureEntry[]) => {
    const lines = values.map((entry) => { const id = `entry-${++seq}`; const value = { ...entry, id, parentId }; parentId = id; return JSON.stringify(value); });
    await appendFile(native, lines.join("\n") + "\n");
  };
  await writeFile(native, JSON.stringify({ type: "session", version: 3, id: "native-session", timestamp: START, cwd: home }) + "\n");
  await append(entries);
  const agents = [{ id: "root", provider: "omp", cwd: home, model: "openai-codex/gpt-6.1-sol", createdAt: START, updatedAt: START, status: "running", labels: { "linear.issueId": "issue", "linear.identifier": "TUC-99", "linear.plan": "required" }, pendingPermissions: [], runtimeInfo: { provider: "omp", sessionId: "native-session" }, persistence: { provider: "omp", sessionId: "native-session", nativeHandle: native } }] as unknown as PaseoAgent[];
  const make = (): PlanPipeline => new PlanPipeline({ host: "test-host", home, file, now: () => h.clock, sessions: async () => h.sessions, parked: async () => h.parked,
    owners: (issueIds) => pipelineOwnerEvidence(home, issueIds, h.ownerFiles ? undefined : async (issueId) => h.owners.get(issueId) ?? null),
    processInspector: {
    processes: async () => h.absent ? "" : `123 omp --mode rpc-ui --session ${native}\n`,
    cwd: async () => home, canonicalPath: async (path) => path,
  } });
  const h: Harness = {
    home, native, file, agents, sessions: [], parked: [], owners: new Map(), ownerFiles: false, clock: new Date(ARRIVED), failList: false, absent: false, timelines: {}, append,
    pipeline: make(),
    refresh: async () => { await h.pipeline.refresh(); },
    snapshot: (open = [], decided = []) => h.pipeline.snapshot(open, decided),
    restart: async () => { h.pipeline.stop(); await h.pipeline.refresh(); h.pipeline = make(); h.pipeline.attach(paseo); await h.pipeline.refresh(); },
  };
  const paseo = {
    agents: {
      list: async () => { if (h.failList) throw new Error("ECONNREFUSED private-token=https://secret.test/prompt"); return { entries: h.agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }; },
      ref: (agent: PaseoAgent) => ({ timeline: { refetch: async () => ({ entries: h.timelines[agent.id] ?? [], error: null }) } }),
    },
  } as unknown as PaseoApi;
  h.pipeline.attach(paseo);
  try { await h.refresh(); await run(h); }
  finally { h.pipeline.stop(); await h.pipeline.refresh(); await rm(home, { recursive: true, force: true }); }
}

test("existing running planner is expected before any review; an implementing idle successor is not", async () => {
  await harness(async (h) => {
    const row = (await h.snapshot()).rows[0];
    assert.equal(row.stage, "preparing"); assert.equal(row.status, "normal"); assert.equal(row.lastProgressAt, null);
    const implementing = join(h.home, "implementing.jsonl");
    await writeFile(implementing, JSON.stringify({ type: "custom", id: "impl", parentId: null, timestamp: START, customType: "plannotator", data: { phase: "idle", lastSubmittedPath: null } }) + "\n");
    h.agents.push({ ...h.agents[0], id: "implementer", labels: { "linear.issueId": "other", "linear.identifier": "TUC-696" }, persistence: { provider: "omp", sessionId: "impl", nativeHandle: implementing } });
    await h.refresh();
    assert.equal((await h.snapshot()).rows.some((entry) => entry.agentId === "implementer"), false);
  });
});

test("a ticketless planner run remains visible through planning and a failed submission", async () => {
  await harness(async (h) => {
    h.agents.splice(0, 1, { ...h.agents[0], id: "project-planner", title: "Plan the work order of ERP",
      labels: { "linear.plannerRun": "run-erp", "linear.projectId": "erp" } });
    await h.refresh();
    const row = (await h.snapshot()).rows.find((entry) => entry.agentId === "project-planner")!;
    assert.equal(row.identifier, "Plan the work order of ERP");
    assert.equal(row.stage, "preparing");
    assert.equal(row.status, "normal");
    await h.append([...submit(), result({}, true, "Cannot find module '/private/tools/plan.mjs'")]);
    await h.refresh();
    const failed = (await h.snapshot()).rows.find((entry) => entry.agentId === "project-planner")!;
    assert.equal(failed.stage, "publishing");
    assert.equal(failed.status, "failed");
    await h.restart();
    assert.equal((await h.snapshot()).rows.find((entry) => entry.agentId === "project-planner")?.status, "failed");
  });
});

test("advisor requires the explicit model AND parent; its real timeline progress prevents false stall", async () => {
  await harness(async (h) => {
    h.clock = new Date("2026-10-06T13:00:00.000Z");
    h.agents.push({ ...h.agents[0], id: "worker", labels: { "paseo.parent-agent-id": "root" }, model: "another-model" });
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].stage, "preparing");
    assert.equal((await h.snapshot()).rows[0].status, "attention");
    h.agents.push({ ...h.agents[0], id: "advisor", model: ADVISOR_MODEL, runtimeInfo: { provider: "omp", sessionId: "advice", model: ADVISOR_MODEL }, labels: { "paseo.parent-agent-id": "root" }, activeTurn: { turnId: "turn", startedAt: SUBMIT } });
    const progress = "2026-10-06T12:59:00.000Z";
    h.timelines.advisor = [{ timestamp: progress, item: { type: "assistant_message", text: "Private advisor reasoning" } }];
    await h.refresh();
    const row = (await h.snapshot()).rows[0];
    assert.equal(row.stage, "advisor"); assert.equal(row.status, "normal"); assert.equal(row.lastProgressAt, progress);
    await h.append(submit()); await h.refresh();
    assert.equal((await h.snapshot()).rows.find((entry) => entry.stage !== "superseded")?.stage, "publishing");
  });
});

test("submit success stays publishing until matched real inbox delivery; stale older revision cannot resolve it", async () => {
  await harness(async (h) => {
    await h.append([...submit(), result({ approved: false, pending: true, reviewId: "local-review" })]);
    await h.refresh();
    const row = (await h.snapshot()).rows[0];
    assert.equal(row.stage, "publishing"); assert.equal(row.status, "normal");
    await h.snapshot([review({ since: START })]);
    assert.equal((await h.snapshot()).rows.find((entry) => entry.id === row.id)?.stage, "publishing");
    const delivered = await h.snapshot([review({ revision: HASH_A })]);
    assert.equal(delivered.rows.find((entry) => entry.id === row.id)?.stage, "ready");
    assert.equal(delivered.lastArrivalAt, ARRIVED);
  });
});

test("lazy-import submit failure survives later assistant messages and restart, without leaking error content", async () => {
  await harness(async (h) => {
    await h.append([...submit(), result({}, true, "Cannot find module '/private/prompts/token-secret.mjs' imported by lazy plan tool")]);
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "failed");
    await h.append([{ type: "message", timestamp: "2026-10-06T12:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Investigating the import failure" }] } }]);
    await h.refresh(); await h.restart();
    const row = (await h.snapshot()).rows[0];
    assert.equal(row.stage, "publishing"); assert.equal(row.status, "failed"); assert.match(row.detail, /dependency\/import/);
    assert.doesNotMatch(JSON.stringify(row), /token-secret|private\/prompts/);
    const ready = await h.snapshot([review({ revision: HASH_A })]);
    assert.equal(ready.rows[0].stage, "ready"); assert.equal(ready.rows[0].status, "normal");
  });
});

test("quiet planning is attention, never failed; real assistant/tool timestamps advance progress, not polling", async () => {
  await harness(async (h) => {
    h.clock = new Date("2026-10-06T16:00:00.000Z");
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "attention");
    const actual = "2026-10-06T15:59:00.000Z";
    await h.append([{ type: "custom", timestamp: actual, customType: "tool_execution_start", data: { toolCallId: "read", toolName: "read", startedAt: actual, args: { path: "private.md" } } }]);
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "normal");
    assert.equal((await h.snapshot()).rows[0].lastProgressAt, actual);
    h.agents[0].updatedAt = "2026-10-06T16:55:00.000Z";
    h.clock = new Date("2026-10-06T17:00:00.000Z");
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "attention");
    assert.equal((await h.snapshot()).rows[0].lastProgressAt, actual);
  });
});

test("owner questions, permissions, queue admission and parked retired roots are normal waits even with absent processes", async () => {
  await harness(async (h) => {
    h.clock = new Date("2026-10-06T14:00:00.000Z"); h.absent = true;
    h.sessions = [link({ questions: { requestId: "question", index: 0, answers: {} } })];
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].stage, "waiting"); assert.equal((await h.snapshot()).rows[0].status, "normal");
    h.sessions = []; h.agents[0].pendingPermissions = [{ id: "permission", kind: "tool", name: "shell" }] as unknown as PaseoAgent["pendingPermissions"];
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "normal");
    h.agents[0].pendingPermissions = []; h.sessions = [link({ queued: true })];
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].stage, "queued");
    h.sessions = []; h.agents[0].status = "closed"; h.agents[0].archivedAt = ARRIVED; h.parked = [parked()];
    h.clock = new Date(ARRIVED);
    await h.append([{ type: "custom", timestamp: ARRIVED, customType: "session_exit", data: { kind: "normal", reason: "dispose", recordedAt: ARRIVED } }]);
    await h.refresh();
    const pending = (await h.snapshot()).rows[0];
    assert.equal(pending.stage, "publishing"); assert.equal(pending.status, "normal");
    const delivered = await h.snapshot([review()]);
    assert.equal(delivered.rows[0].stage, "ready"); assert.equal(delivered.rows[0].status, "normal");
    h.parked = []; await h.refresh();
    assert.equal((await h.snapshot()).rows[0].stage, "ready", "transient disappearance is not cancellation");
  });
});

test("only a proven absent process or actual error fails planning; daemon closed alone does not", async () => {
  await harness(async (h) => {
    h.clock = new Date("2026-10-06T14:00:00.000Z"); h.agents[0].status = "closed";
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "attention");
    h.agents[0].status = "running"; h.absent = true;
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "failed");
    assert.match((await h.snapshot()).rows[0].detail, /proven absent/);
    h.absent = false; h.agents[0].status = "error"; h.agents[0].lastError = "ECONNREFUSED";
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "failed");
  });
});

test("native auto-approval is resolved without inbox delivery; native completion remains terminal", async () => {
  await harness(async (h) => {
    await h.append([...submit(), { type: "custom", timestamp: ARRIVED, customType: "plannotator-execute", data: { lastSubmittedPath: "plan.md" } }, result({ approved: true })]);
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].stage, "auto-approved");
    await h.append([{ type: "custom_message", timestamp: "2026-10-06T12:03:00.000Z", customType: "plannotator-complete" }]);
    await h.refresh(); await h.restart();
    assert.equal((await h.snapshot()).rows[0].stage, "completed"); assert.equal((await h.snapshot()).rows[0].status, "normal");
  });
});

test("supersession is per revision; explicit idle exit cancels current planning, source disappearance does not", async () => {
  await harness(async (h) => {
    await h.append(submit()); await h.refresh();
    await h.snapshot([review({ revision: HASH_A })]);
    const nextAt = "2026-10-06T12:04:00.000Z";
    await h.append(submit(HASH_B, "submit-b", nextAt)); await h.refresh();
    const rows = (await h.snapshot()).rows;
    assert.equal(rows.find((entry) => entry.stage === "superseded")?.status, "normal");
    assert.equal(rows.find((entry) => entry.stage === "publishing")?.since, nextAt);
    await h.snapshot([review({ revision: HASH_A })]);
    assert.equal((await h.snapshot()).rows.find((entry) => entry.stage === "publishing")?.since, nextAt);
    await h.append([{ type: "custom", timestamp: "2026-10-06T12:05:00.000Z", customType: "plannotator", data: { phase: "idle" } }]);
    await h.refresh();
    assert.equal((await h.snapshot()).rows.find((entry) => entry.stage === "cancelled")?.status, "normal");
    h.agents = []; await h.refresh(); await h.restart();
    assert.equal((await h.snapshot()).rows.some((entry) => entry.stage === "cancelled"), true);
  });
});

test("source failures preserve successful checkedAt and evidence; unsupported native provider stays unknown", async () => {
  await harness(async (h) => {
    const good = (await h.snapshot()).checkedAt;
    h.clock = new Date("2026-10-06T12:10:00.000Z"); h.failList = true;
    await h.refresh();
    const failed = await h.snapshot();
    assert.equal(failed.checkedAt, good); assert.equal(failed.rows[0].status, "unknown"); assert.match(failed.error ?? "", /connection refused/);
    assert.doesNotMatch(JSON.stringify(failed), /private-token|secret.test/);
    h.failList = false; h.agents[0].provider = "codex";
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "unknown"); assert.equal((await h.snapshot()).checkedAt, good);
  });
});

test("delivery retry exhaustion persists without its event file; actual open or terminal delivery wins", async () => {
  await harness(async (h) => {
    await h.append(submit()); await h.refresh();
    await h.pipeline.recordDeliveryError({ agentId: "root", type: "decided", at: ARRIVED }, new Error("ECONNREFUSED"), 5);
    assert.equal((await h.snapshot()).rows[0].status, "normal");
    await h.pipeline.recordDeliveryError({ agentId: "root", type: "opened", at: ARRIVED, localUrl: "http://127.0.0.1:4444" }, new Error("Cannot find module '/secret/bridge.mjs'"), 5);
    await h.restart();
    const failed = (await h.snapshot()).rows[0];
    assert.equal(failed.status, "failed"); assert.match(failed.detail, /delivery attempt 5/);
    assert.doesNotMatch(await readFile(h.file, "utf8"), /\/secret/);
    assert.equal((await h.snapshot([review()])).rows[0].stage, "ready");
    const terminal = await h.snapshot([], [review({ outcome: "approved", autoApproved: true, decidedAt: "2026-10-06T12:02:00.000Z" })]);
    assert.equal(terminal.rows[0].stage, "auto-approved"); assert.equal(terminal.rows[0].status, "normal");
  });
});

test("mid-run plan request is read for an implementing agent and remains expected after transient request removal", async () => {
  await harness(async (h) => {
    delete h.agents[0].labels["linear.plan"];
    const directory = join(h.home, "linear-tickets", "plan-requests");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "root"), JSON.stringify({ identifier: "TUC-99", at: SUBMIT, message: "Private owner's instruction" }));
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].stage, "preparing");
    await rm(join(directory, "root")); await h.refresh();
    assert.equal((await h.snapshot()).rows[0].stage, "preparing");
    assert.doesNotMatch(await readFile(h.file, "utf8"), /Private owner's instruction/);
  }, [{ type: "custom", timestamp: START, customType: "plannotator", data: { phase: "idle", lastSubmittedPath: null } }]);
});

test("restart and file replacement/compaction keep resolved history and discover current planning without mtime progress", async () => {
  await harness(async (h) => {
    await h.append(submit()); await h.refresh();
    await h.snapshot([], [review({ revision: HASH_A, outcome: "approved" })]); await h.refresh();
    await h.restart();
    const temporary = join(h.home, "compacted.jsonl");
    await writeFile(temporary, [
      { type: "session", version: 3, id: "native-session", timestamp: START },
      { type: "compaction", id: "compact", parentId: null, timestamp: "2026-10-06T12:10:00.000Z", summary: "Private compacted context" },
      { type: "custom", id: "restored", parentId: "compact", timestamp: "2026-10-06T12:10:00.000Z", customType: "plannotator", data: { phase: "planning" } },
      { type: "message", id: "working", parentId: "restored", timestamp: "2026-10-06T12:11:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Preparing next plan" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await rename(temporary, h.native); h.clock = new Date("2026-10-06T12:11:05.000Z"); await h.refresh();
    const rows = (await h.snapshot()).rows;
    assert.equal(rows.some((entry) => entry.stage === "completed"), true);
    assert.equal(rows.find((entry) => entry.stage === "preparing")?.lastProgressAt, "2026-10-06T12:11:00.000Z");
  });
});

test("bounded reader backfills large sessions incrementally, notices current tail, and ignores touch/poll time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-native-"));
  const path = join(directory, "large.jsonl");
  try {
    let parentId: string | null = null;
    const entries: string[] = [];
    const add = (value: FixtureEntry) => { const id = `e-${entries.length}`; entries.push(JSON.stringify({ ...value, id, parentId })); parentId = id; };
    for (const entry of planning()) add(entry);
    for (let index = 0; index < 100; index++) add({ type: "message", timestamp: SUBMIT, message: { role: "user", content: [{ type: "text", text: "Private context ".repeat(2500) }] } });
    for (const entry of submit()) add(entry);
    await writeFile(path, entries.join("\n") + "\n");
    const reader = new NativeReader();
    let evidence = await reader.read(path);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.state.revisions.at(-1)?.stage, "publishing");
    assert.ok(evidence.cursor.offset <= 1024 * 1024);
    for (let index = 0; index < 10 && !evidence.complete; index++) evidence = await reader.read(path, evidence.cursor);
    assert.equal(evidence.complete, true); assert.equal(evidence.state.progress, SUBMIT);
    const unchanged = await reader.read(path, evidence.cursor);
    assert.equal(unchanged.state.progress, SUBMIT); assert.equal(unchanged.cursor.offset, evidence.cursor.offset);
    assert.doesNotMatch(JSON.stringify(unchanged.cursor), /Private context/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("inbox snapshot never waits for a blocked source refresh; refresh is single-flight", { timeout: 3000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pipeline-cache-"));
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let lists = 0;
  const pipeline = new PlanPipeline({ home, host: "host", sessions: async () => [], parked: async () => [] });
  pipeline.attach({ agents: { list: async () => { lists++; started(); await held; return { entries: [], pageInfo: { hasMore: false } }; } } } as unknown as PaseoApi);
  try {
    await entered;
    const snapshots = await Promise.all(Array.from({ length: 10 }, () => pipeline.snapshot([], [])));
    assert.equal(snapshots[0].checkedAt, null); assert.match(snapshots[0].error ?? "", /not been checked/); assert.equal(lists, 1);
    release(); await pipeline.refresh();
    assert.ok((await pipeline.snapshot([], [])).checkedAt);
  } finally { release(); await pipeline.refresh(); pipeline.stop(); await rm(home, { recursive: true, force: true }); }
});

test("malformed native state is unknown monitoring health; delivered ready still overrides it", async () => {
  await harness(async (h) => {
    const checkedAt = (await h.snapshot()).checkedAt;
    h.clock = new Date("2026-10-06T12:10:00.000Z");
    await h.append([{ type: "custom", timestamp: SUBMIT, customType: "plannotator", data: { phase: "unsupported-phase" } }]);
    await h.refresh();
    const unknown = await h.snapshot();
    assert.equal(unknown.checkedAt, checkedAt);
    assert.equal(unknown.rows[0].status, "unknown");
    assert.match(unknown.error ?? "", /incomplete or unsupported/);
    const delivered = await h.snapshot([review()]);
    assert.equal(delivered.rows[0].stage, "ready");
    assert.equal(delivered.rows[0].status, "normal");
    assert.equal(delivered.checkedAt, checkedAt);
  });
});

test("stale monitoring does not erase a proven submit failure; native turn errors recover on actual new progress", async () => {
  await harness(async (h) => {
    await h.append([...submit(), result({}, true, "ERR_MODULE_NOT_FOUND")]);
    await h.refresh();
    const checkedAt = (await h.snapshot()).checkedAt;
    h.failList = true; h.clock = new Date("2026-10-06T12:10:00.000Z");
    await h.refresh();
    const stale = await h.snapshot();
    assert.equal(stale.rows[0].status, "failed");
    assert.equal(stale.checkedAt, checkedAt);
    assert.ok(stale.error);
  });
  await harness(async (h) => {
    await h.append([{ type: "message", timestamp: SUBMIT, message: { role: "assistant", stopReason: "error", errorMessage: "ECONNREFUSED", content: [] } }]);
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "failed");
    await h.append([{ type: "message", timestamp: ARRIVED, message: { role: "assistant", content: [{ type: "text", text: "Resumed planning" }] } }]);
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "normal");
    assert.equal((await h.snapshot()).rows[0].lastProgressAt, ARRIVED);
  });
});

test("queued admission resolves when its session links to a root; explicit queue closure is cancelled", async () => {
  await harness(async (h) => {
    h.sessions = [link({ agentId: null, queued: true })];
    await h.refresh();
    assert.equal((await h.snapshot()).rows.find((entry) => entry.agentId === "")?.stage, "queued");
    h.sessions = [link({ queued: false })];
    await h.refresh();
    assert.equal((await h.snapshot()).rows.find((entry) => entry.agentId === "")?.stage, "completed");
    h.sessions.push(link({ sessionId: "second-thread", agentId: null, queued: true }));
    await h.refresh();
    h.sessions[1].closed = true;
    await h.refresh();
    assert.equal((await h.snapshot()).rows.some((entry) => entry.agentId === "" && entry.stage === "cancelled"), true);
  });
});

test("unhashed submissions inherit delivered identity across refresh and restart without resolving a newer attempt", async () => {
  await harness(async (h) => {
    await h.append(submit().filter((entry) => entry.customType !== "linear-tickets.plan-advice"));
    h.parked = [parked()];
    await h.refresh();
    const revision = createHash("sha256").update(h.parked[0].plan).digest("hex");
    const delivered = review({ revision });
    const assertDelivered = (view: PipelineHost) => {
      assert.equal(view.rows.filter((row) => row.agentId === "root" && row.stage === "ready").length, 1);
      assert.equal(view.rows.some((row) => row.agentId === "root" && ["preparing", "publishing", "waiting"].includes(row.stage)), false);
    };
    assertDelivered(await h.snapshot([delivered]));
    await h.refresh(); assertDelivered(await h.snapshot([delivered]));
    await h.restart(); assertDelivered(await h.snapshot([delivered]));
    const next = "2026-10-06T12:04:00.000Z";
    h.parked = [];
    await h.append([
      { type: "custom", timestamp: next, customType: "plannotator", data: { phase: "idle" } },
      { type: "custom", timestamp: next, customType: "plannotator", data: { phase: "planning" } },
      ...submit(HASH_B, "submit-b", next).filter((entry) => entry.customType !== "linear-tickets.plan-advice"),
    ]);
    await h.refresh();
    const newer = await h.snapshot([delivered]);
    assert.equal(newer.rows.some((row) => row.stage === "publishing" && row.since === next), true);
    assertDelivered(await h.snapshot([review({ revision, since: "2026-10-06T12:04:05.000Z" })]));
    await h.refresh();
    assertDelivered(await h.snapshot([review({ revision, since: "2026-10-06T12:04:05.000Z" })]));
  });
});

test("delivered content supersedes older mismatched native content without claiming a newer submission", async () => {
  await harness(async (h) => {
    await h.append(submit());
    h.parked = [parked()];
    await h.refresh();
    const revision = createHash("sha256").update(h.parked[0].plan).digest("hex");
    const delivered = review({ revision });
    const current = await h.snapshot([delivered]);
    assert.equal(current.rows.some((row) => row.stage === "publishing"), false);
    assert.equal(current.rows.filter((row) => row.stage === "ready").length, 1);
    assert.equal(current.rows.some((row) => row.stage === "superseded"), true);
    await h.refresh();
    assert.equal((await h.snapshot([delivered])).rows.some((row) => row.stage === "publishing"), false);
    const next = "2026-10-06T12:04:00.000Z";
    h.parked = [];
    await h.append(submit(HASH_B, "submit-b", next));
    await h.refresh();
    assert.equal((await h.snapshot([delivered])).rows.some((row) => row.stage === "publishing" && row.since === next), true);
  });
});

for (const [outcome, stage] of [["approved", "completed"], ["sent back", "superseded"], ["cancelled", "cancelled"]] as const) {
  test(`legacy ${outcome} settles attempts before actual decision, not later identical submissions`, async () => {
    await harness(async (h) => {
      await h.append(submit()); await h.refresh();
      const original = (await h.snapshot()).rows[0].id;
      const decision = review({ since: START, outcome, decidedAt: ARRIVED });
      const resolved = await h.snapshot([], [decision]);
      assert.equal(resolved.rows.find((row) => row.id === original)?.stage, stage);
      assert.equal(resolved.rows.some((row) => ["preparing", "publishing"].includes(row.stage)), false);
      await h.refresh(); await h.restart();
      assert.equal((await h.snapshot([], [decision])).rows.find((row) => row.id === original)?.stage, stage);
      const next = "2026-10-06T12:04:00.000Z";
      await h.append(submit(HASH_A, "same-content-new-call", next)); await h.refresh();
      const newer = await h.snapshot([], [decision]);
      const active = newer.rows.find((row) => row.stage === "publishing");
      assert.ok(active); assert.notEqual(active.id, original); assert.equal(active.since, next);
      await h.refresh(); await h.restart();
      assert.equal((await h.snapshot([], [decision])).rows.find((row) => row.id === active.id)?.stage, "publishing");
      const latest = await h.snapshot([review({ revision: HASH_A, publishedAt: "2026-10-06T12:04:05.000Z" })], [decision]);
      assert.equal(latest.rows.find((row) => row.id === active.id)?.stage, "ready");
      assert.equal(latest.rows.find((row) => row.id === original)?.stage, stage);
    });
  });
}

test("a hashed earlier review cannot resolve a same-content resubmission made after publication", async () => {
  await harness(async (h) => {
    await h.append(submit()); await h.refresh();
    const delivered = review({ revision: HASH_A });
    const original = (await h.snapshot([delivered])).rows[0].id;
    const next = "2026-10-06T12:04:00.000Z";
    await h.append(submit(HASH_A, "submit-again", next)); await h.refresh();
    const decided = { ...delivered, outcome: "approved", decidedAt: "2026-10-06T12:05:00.000Z" };
    const rows = (await h.snapshot([], [decided])).rows;
    assert.equal(rows.find((row) => row.id === original)?.stage, "completed");
    const pending = rows.find((row) => row.stage === "publishing");
    assert.ok(pending); assert.equal(pending.since, next);
    await h.refresh(); await h.restart();
    assert.equal((await h.snapshot([], [decided])).rows.find((row) => row.id === pending.id)?.stage, "publishing");
  });
});

test("a newer preparing cycle is not retired by a legacy earlier decision", async () => {
  await harness(async (h) => {
    await h.append(submit()); await h.refresh();
    const next = "2026-10-06T12:04:00.000Z";
    await h.append([
      { type: "custom", timestamp: next, customType: "plannotator", data: { phase: "executing" } },
      { type: "custom", timestamp: next, customType: "plannotator", data: { phase: "planning" } },
    ]);
    await h.refresh();
    const decision = review({ since: START, outcome: "approved", decidedAt: ARRIVED });
    const row = (await h.snapshot([], [decision])).rows.find((entry) => entry.stage === "preparing");
    assert.ok(row); assert.equal(row.since, next);
    await h.restart();
    assert.equal((await h.snapshot([], [decision])).rows.find((entry) => entry.id === row.id)?.stage, "preparing");
  });
});

test("handover owner waits survive normal disposal and reload without inventing inbox readiness", async () => {
  await harness(async (h) => {
    h.clock = new Date("2026-10-06T14:00:00.000Z"); h.absent = true;
    h.owners.set("issue", owner({ status: "waiting", waiting: { previousStateId: "planning", commentId: "question" } }));
    await h.append([{ type: "custom", timestamp: ARRIVED, customType: "session_exit", data: { kind: "normal", reason: "dispose", recordedAt: ARRIVED } }]);
    h.agents[0].status = "closed"; h.agents[0].archivedAt = ARRIVED;
    await h.refresh(); await h.restart();
    const row = (await h.snapshot()).rows[0];
    assert.equal(row.stage, "waiting"); assert.equal(row.status, "normal");
    assert.equal(row.reviewUrl, undefined); assert.equal((await h.snapshot()).lastArrivalAt, null);
  });
});

test("needs-you waits remain with their historical owner, not a successor carrying the old handover hold", async () => {
  await harness(async (h) => {
    h.clock = new Date("2026-10-06T14:00:00.000Z"); h.absent = true;
    h.agents[0].status = "closed"; h.agents[0].archivedAt = ARRIVED;
    h.agents.push({ ...h.agents[0], id: "successor", status: "running", archivedAt: null });
    h.owners.set("issue", owner({ agentId: "successor", waiting: { previousStateId: null, commentId: "question", subIssueId: "need" } }));
    const directory = join(h.home, "linear-tickets", "needs-you"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "need.json"), JSON.stringify({ id: "need", identifier: "TUC-100", parentId: "issue", agentId: "root" }));
    await h.refresh(); await h.restart();
    const rows = (await h.snapshot()).rows;
    assert.equal(rows.find((row) => row.agentId === "root")?.stage, "waiting");
    assert.equal(rows.find((row) => row.agentId === "root")?.status, "normal");
    assert.equal(rows.find((row) => row.agentId === "successor")?.status, "failed");
    assert.notEqual(rows.find((row) => row.agentId === "successor")?.stage, "waiting");
  });
});

test("normal disposal is an unfinished-planning warning, abnormal exit is failure, and progress clears both", async () => {
  await harness(async (h) => {
    h.absent = true; h.clock = new Date("2026-10-06T14:00:00.000Z");
    await h.append([{ type: "custom", timestamp: SUBMIT, customType: "session_exit", data: { kind: "normal", reason: "dispose", recordedAt: SUBMIT } }]);
    await h.refresh(); await h.restart();
    assert.equal((await h.snapshot()).rows[0].status, "attention");
    assert.equal((await h.snapshot()).rows[0].stage, "preparing");
    await h.append([{ type: "custom", timestamp: ARRIVED, customType: "session_exit", data: { kind: "error", code: 1, recordedAt: ARRIVED } }]);
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "failed");
    h.absent = false; h.clock = new Date("2026-10-06T12:02:00.000Z");
    await h.append([{ type: "message", timestamp: h.clock.toISOString(), message: { role: "assistant", content: [{ type: "text", text: "New planning turn" }] } }]);
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "normal");
  });
});

test("provider 429 keeps sanitized retry timing visible even with a live process and owner wait", async () => {
  await harness(async (h) => {
    h.owners.set("issue", owner({ waiting: { previousStateId: null, commentId: "question" } }));
    const error = '429 {"request_id":"private-provider-id","message":"private request"} retry-after-ms=274228000 (model=private-model)';
    await h.append([{ type: "message", timestamp: ARRIVED, message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } }]);
    await h.refresh(); await h.restart();
    const row = (await h.snapshot()).rows[0];
    assert.equal(row.status, "failed"); assert.match(row.detail, /429/);
    assert.match(row.detail, /274228 seconds/);
    assert.doesNotMatch(await readFile(h.file, "utf8"), /private-provider-id|private request|private-model/);
  });
});

test("a stopped initial prompt becomes current planning on same-agent recovery, not a retained stale failure", async () => {
  await harness(async (h) => {
    h.clock = new Date("2026-10-06T14:00:00.000Z"); h.agents[0].status = "closed"; h.absent = true;
    h.owners.set("issue", owner({ status: "failed", updatedAt: SUBMIT }));
    await h.refresh();
    const stopped = (await h.snapshot()).rows[0];
    assert.equal(stopped.status, "failed");
    h.absent = false; h.agents[0].status = "running";
    h.clock = new Date("2026-10-06T14:01:00.000Z");
    h.agents[0].activeTurn = { turnId: "recovery", startedAt: h.clock.toISOString() };
    await h.append([{ type: "message", timestamp: h.clock.toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Recovered initial prompt" }] } }]);
    await h.refresh(); await h.restart();
    const rows = (await h.snapshot()).rows;
    assert.equal(rows.find((row) => row.id === stopped.id)?.status, "normal");
    assert.equal(rows.filter((row) => row.agentId === "root").length, 1);
  }, [{ type: "custom", timestamp: START, customType: "plannotator", data: { phase: "idle" } }]);
});

test("explicit executing phase resolves previously observed missing-plan work after native compaction", async () => {
  await harness(async (h) => {
    const original = (await h.snapshot()).rows[0].id;
    h.absent = true; h.clock = new Date("2026-10-06T14:00:00.000Z");
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "failed");
    const replacement = join(h.home, "executing.jsonl");
    await writeFile(replacement, JSON.stringify({ type: "custom", id: "execute", parentId: null, timestamp: ARRIVED, customType: "plannotator", data: { phase: "executing" } }) + "\n");
    await rename(replacement, h.native);
    await h.refresh(); await h.restart();
    const row = (await h.snapshot()).rows.find((entry) => entry.id === original);
    assert.equal(row?.stage, "completed"); assert.equal(row?.status, "normal");
  });
});

test("authoritative owner transfer retires only the named predecessor; missing owner evidence is not success", async () => {
  await harness(async (h) => {
    await h.append(submit()); await h.refresh();
    const original = (await h.snapshot()).rows[0].id;
    h.agents.push({ ...h.agents[0], id: "unrelated" });
    h.owners.set("issue", owner({ agentId: "successor", resumedFrom: "root", updatedAt: ARRIVED }));
    await h.refresh(); await h.restart();
    const rows = (await h.snapshot()).rows;
    assert.equal(rows.find((row) => row.id === original)?.stage, "superseded");
    assert.equal(rows.find((row) => row.agentId === "unrelated")?.stage, "publishing");
    h.owners.clear(); h.agents = []; await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.agentId === "unrelated")?.stage, "publishing");
  });
});

test("archived exact-session history settles journal queues before session sweep and cannot settle another thread", async () => {
  await harness(async (h) => {
    h.sessions = [link({ agentId: null, queued: true })]; await h.refresh();
    const queue = (await h.snapshot()).rows.find((row) => row.agentId === "");
    assert.ok(queue); assert.equal(queue.stage, "queued");
    h.agents[0].labels["linear.sessionId"] = "thread";
    h.agents[0].archivedAt = ARRIVED; h.agents[0].status = "closed";
    h.sessions.push(link({ agentId: null, queued: true, sessionId: "different-thread" }));
    await h.refresh(); await h.restart();
    const rows = (await h.snapshot()).rows;
    assert.equal(rows.find((row) => row.id === queue.id)?.stage, "completed");
    assert.equal(rows.find((row) => row.agentId === "" && row.id !== queue.id)?.stage, "queued");
    h.sessions = []; await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === queue.id)?.stage, "completed");
  });
});

test("already-run exact-session agents never produce fresh phantom queue rows; blockers retain actual queue reason", async () => {
  await harness(async (h) => {
    h.agents[0].labels["linear.sessionId"] = "thread";
    h.sessions = [link({ agentId: null, queued: true })];
    const blocked = { ...link({ agentId: null, queued: true, sessionId: "blocked" }), queueReason: "Blocked by predecessor dependency" };
    h.sessions.push(blocked); await h.refresh();
    const rows = (await h.snapshot()).rows.filter((row) => row.agentId === "");
    assert.equal(rows.length, 1); assert.equal(rows[0].stage, "queued");
    assert.equal(rows[0].detail, blocked.queueReason);
    h.failList = true; await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === rows[0].id)?.status, "unknown");
  });
});

test("unreadable owner evidence and partial execution stay unknown; an invalid inbox link is never ready", async () => {
  await harness(async (h) => {
    const directory = join(h.home, "linear-tickets", "needs-you"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "broken.json"), "{");
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "unknown");
    await rm(join(directory, "broken.json"));
    await h.append([{ type: "custom", timestamp: ARRIVED, customType: "plannotator", data: { phase: "executing" } }]);
    await appendFile(h.native, '{"type":"message"');
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "unknown");
    const invalid = await h.snapshot([review({ link: "http://owner:secret@host.test/review" })]);
    assert.equal(invalid.rows.some((row) => row.stage === "ready"), false);
    assert.equal(invalid.lastArrivalAt, null);
    const delivered = await h.snapshot([review()]);
    assert.equal(delivered.rows[0].stage, "ready"); assert.equal(delivered.rows[0].status, "normal");
  });
});

test("legacy crash summaries are replayed on reload without changing historical row identities", async () => {
  await harness(async (h) => {
    await h.append([...submit(), { type: "custom", timestamp: ARRIVED, customType: "session_exit", data: { kind: "normal", reason: "dispose", recordedAt: ARRIVED } }]);
    await h.refresh();
    const original = (await h.snapshot()).rows[0].id;
    h.pipeline.stop(); await h.pipeline.refresh();
    const journal = JSON.parse(await readFile(h.file, "utf8"));
    journal.records[0].key = `hash:${HASH_A}`;
    journal.cursors.root.state.stoppedAt = ARRIVED;
    delete journal.cursors.root.state.disposedAt;
    await writeFile(h.file, JSON.stringify(journal));
    await h.restart();
    const row = (await h.snapshot()).rows.find((entry) => entry.id === original);
    assert.equal(row?.stage, "publishing"); assert.equal(row?.status, "attention");
  });
});

test("exact-session history resolves a journal queue even after its registry link is no longer present", async () => {
  await harness(async (h) => {
    h.sessions = [link({ agentId: null, queued: true })]; await h.refresh();
    const queued = (await h.snapshot()).rows.find((row) => row.agentId === "");
    assert.ok(queued);
    h.sessions = []; const agent = h.agents[0]; h.agents = [];
    await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === queued.id)?.stage, "queued");
    agent.labels["linear.sessionId"] = "thread"; agent.status = "closed"; agent.archivedAt = ARRIVED; h.agents = [agent];
    await h.restart();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === queued.id)?.stage, "completed");
  });
});

test("explicit parked-plan requeues create a new durable admission cycle and never settle from retired history", async () => {
  await harness(async (h) => {
    h.sessions = [link({ agentId: null, queued: true })]; await h.refresh();
    const prior = (await h.snapshot()).rows.find((row) => row.agentId === "");
    assert.ok(prior);
    h.agents[0].labels["linear.sessionId"] = "thread"; h.agents[0].status = "closed"; h.agents[0].archivedAt = ARRIVED;
    await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === prior.id)?.stage, "completed");
    const requeued = { ...link({ agentId: null, queued: true }), restartRequested: true, queueReason: "Owner-decided plan waits for admission" };
    h.sessions = [requeued];
    await h.refresh(); await h.restart();
    const next = (await h.snapshot()).rows.find((row) => row.agentId === "" && row.stage === "queued");
    assert.ok(next); assert.notEqual(next.id, prior.id);
    assert.equal((await h.snapshot()).rows.find((row) => row.id === prior.id)?.stage, "completed");
    h.sessions = []; await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === next.id)?.stage, "queued");
    h.sessions = [link({ queued: false, agentId: "new-root" })]; await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === next.id)?.stage, "completed");
  });
});

test("a retired exact-session owner cannot erase an undelivered queued message", async () => {
  await harness(async (h) => {
    h.agents[0].labels["linear.sessionId"] = "thread"; h.agents[0].status = "closed"; h.agents[0].archivedAt = ARRIVED;
    const waiting = { ...link({ agentId: null, queued: true, pendingText: "Private unanswered owner instruction" }), queueReason: "Queued owner message waits for a live owner" };
    h.sessions = [waiting];
    await h.refresh(); await h.restart();
    const queued = (await h.snapshot()).rows.find((row) => row.agentId === "");
    assert.ok(queued); assert.equal(queued.stage, "queued"); assert.equal(queued.status, "normal");
    assert.equal(queued.detail, "Queued owner message waits for a live owner");
    assert.doesNotMatch(await readFile(h.file, "utf8"), /Private unanswered owner instruction/);
    h.sessions = []; await h.refresh();
    assert.equal((await h.snapshot()).rows.find((row) => row.id === queued.id)?.stage, "queued");
  });
});

test("missing needs-you evidence cannot convert a recorded owner wait into a process failure", async () => {
  await harness(async (h) => {
    h.absent = true; h.clock = new Date("2026-10-06T14:00:00.000Z");
    h.owners.set("issue", owner({ waiting: { previousStateId: null, commentId: "question", subIssueId: "missing" } }));
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "unknown");
    assert.equal((await h.snapshot()).rows[0].stage, "preparing");
  });
});

test("untracked archived roots stay out of planning counts until actual parked evidence makes them monitored", async () => {
  await harness(async (h) => {
    h.agents.push({
      ...h.agents[0], id: "never-tracked", status: "closed", archivedAt: ARRIVED,
      labels: { "linear.issueId": "historical", "linear.identifier": "TUC-101", "linear.plan": "required" },
    });
    await h.refresh(); await h.restart();
    assert.equal((await h.snapshot()).rows.some((row) => row.agentId === "never-tracked"), false);
    h.parked.push({ ...parked(), issueId: "historical", identifier: "TUC-101", agentId: "never-tracked" });
    await h.refresh();
    const row = (await h.snapshot()).rows.find((entry) => entry.agentId === "never-tracked");
    assert.equal(row?.stage, "publishing"); assert.equal(row?.status, "normal");
  });
});

test("strict owner sampling distinguishes absent records from malformed, oversized and unreadable owner files", async () => {
  await harness(async (h) => {
    h.ownerFiles = true; h.absent = true; h.clock = new Date("2026-10-06T14:00:00.000Z");
    await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "failed", "a genuinely absent owner record supplies no hold");
    const directory = join(h.home, "linear-tickets", "handover"), path = join(directory, "issue.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify(owner({ waiting: { previousStateId: "planning", commentId: "question" } })));
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].stage, "waiting");
    const checkedAt = (await h.snapshot()).checkedAt;
    await writeFile(path, "{"); await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "unknown");
    assert.equal((await h.snapshot()).checkedAt, checkedAt);
    await writeFile(path, JSON.stringify({ ...owner(), summaries: ["x".repeat(64 * 1024)] })); await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "unknown");
    await rm(path); await mkdir(path); await h.refresh();
    assert.equal((await h.snapshot()).rows[0].status, "unknown");
    assert.ok((await h.snapshot()).error);
  });
});

test("unreadable owner evidence retains a confirmed initial-prompt failure across reload, but not after real recovery progress", async () => {
  await harness(async (h) => {
    h.ownerFiles = true; h.agents[0].status = "closed";
    const directory = join(h.home, "linear-tickets", "handover"), path = join(directory, "issue.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify(owner({ status: "failed", updatedAt: SUBMIT })));
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "failed");
    await writeFile(path, "{"); await h.refresh(); await h.restart();
    const stale = await h.snapshot();
    assert.equal(stale.rows[0].status, "failed"); assert.ok(stale.error);
    h.agents[0].status = "running";
    const recovered = "2026-10-06T12:03:00.000Z";
    h.clock = new Date(recovered); h.agents[0].activeTurn = { turnId: "recovered", startedAt: recovered };
    await h.append([{ type: "message", timestamp: recovered, message: { role: "assistant", content: [{ type: "text", text: "Current recovery output" }] } }]);
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "unknown");
    await writeFile(path, JSON.stringify(owner({ status: "working", updatedAt: recovered })));
    await h.refresh(); assert.equal((await h.snapshot()).rows[0].status, "normal");
  }, [{ type: "custom", timestamp: START, customType: "plannotator", data: { phase: "idle" } }]);
});

test("a known provider error stays visible when both native and owner evidence become unreadable", async () => {
  await harness(async (h) => {
    h.ownerFiles = true;
    await h.append([{ type: "message", timestamp: ARRIVED, message: { role: "assistant", stopReason: "error", errorMessage: "429 retry-after-ms=274228000 private-request-token", content: [] } }]);
    await h.refresh();
    const directory = join(h.home, "linear-tickets", "handover");
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "issue.json"), "{");
    await rm(h.native); await h.refresh(); await h.restart();
    const row = (await h.snapshot()).rows[0];
    assert.equal(row.status, "failed"); assert.match(row.detail, /429/); assert.match(row.detail, /274228 seconds/);
    assert.ok((await h.snapshot()).error); assert.doesNotMatch(await readFile(h.file, "utf8"), /private-request-token/);
  });
});
