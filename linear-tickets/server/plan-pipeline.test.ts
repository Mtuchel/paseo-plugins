import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { SessionLink } from "./sessions";
import type { ParkedPlan } from "./parked";
import { ADVISOR_MODEL } from "../shared/plan-advisor";
import { PlanPipeline, type PipelineReview } from "./plan-pipeline";
import { NativeReader } from "./plan-pipeline-source";
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

type Harness = {
  pipeline: PlanPipeline; home: string; file: string; native: string; agents: PaseoAgent[];
  sessions: SessionLink[]; parked: ParkedPlan[]; clock: Date; failList: boolean; absent: boolean;
  timelines: Record<string, { timestamp: string; item: Record<string, unknown> }[]>;
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
  const make = (): PlanPipeline => new PlanPipeline({ host: "test-host", home, file, now: () => h.clock, sessions: async () => h.sessions, parked: async () => h.parked, processInspector: {
    processes: async () => h.absent ? "" : `123 omp --mode rpc-ui --session ${native}\n`,
    cwd: async () => home, canonicalPath: async (path) => path,
  } });
  const h: Harness = {
    home, native, file, agents, sessions: [], parked: [], clock: new Date(ARRIVED), failList: false, absent: false, timelines: {}, append,
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
