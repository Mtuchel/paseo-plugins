import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { availability, candidates, LIMIT_DAY, LimitResumeStore, limitError, type UsageReport, UsageReader } from "./limit-resume";
import { SessionRouter, SessionStore, type SessionLink } from "./sessions";
import { DEFAULT_WORKTREE_SHARDS, DEFAULT_ACTIVATION, DEFAULT_DEPUTY, DEFAULT_BACKSTOP, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { WatchdogStore } from "./watchdog";
import { Writeback } from "./writeback";

const T0 = Date.parse("2026-10-07T10:00:00Z");
const MINUTE = 60_000;
const MODEL = "anthropic/claude-opus-5-5";
const ERROR = `429 {"type":"error","error":{"type":"rate_limit_error"}} retry-after-ms=274053000 (stopReason=error, model=${MODEL})`;
const iso = (at: number) => new Date(at).toISOString();
const report = (provider: string, now: number, used = 0, reset = now + 60 * MINUTE): UsageReport => ({ provider, fetchedAt: now, limits: [{ scope: {}, amount: { usedFraction: used }, window: { resetsAt: reset } }] });

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-limit-"));
  const state = {
    now: T0, reports: [report("anthropic", T0)] as UsageReport[] | null, chains: {} as Record<string, string[]>,
    process: "absent" as "absent" | "alive" | "unknown", gateHeld: false, deleted: false,
    route: null as null | { held: string } | { peer: string }, failStart: false, panelFails: false,
    pauseStart: null as null | (() => Promise<void>), commentFailure: "none" as "none" | "before" | "after",
    pauseRecipient: null as null | (() => Promise<void>), onUsage: null as null | (() => void),
    starts: [] as { id: string; fresh: boolean | undefined }[], messages: [] as string[], comments: [] as string[], stopped: [] as string[], sent: [] as string[],
    settings: { template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false, dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, autoResume: true }, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS } as PluginSettings,
    agents: [{ id: "a0", status: "error", createdAt: iso(T0), cwd: "/repo/wt", labels: { "linear.issueId": "i1" }, archivedAt: null as string | null }],
  };
  const sessions = new SessionStore(join(directory, "sessions.json"));
  const limits = new LimitResumeStore(join(directory, "limit-resumes.json"), () => state.now);
  const watchdog = new WatchdogStore(join(directory, "watchdog.json"));
  const link: SessionLink = { sessionId: "s1", agentId: "a0", issueId: "i1", identifier: "TUC-1", createdAt: iso(T0), handled: [], review: null, offer: null };
  await sessions.put(link);
  const paseo = {
    agents: {
      list: async () => ({ entries: state.agents.filter((agent) => !agent.archivedAt).map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => { const agent = state.agents.find((agent) => agent.id === id); return agent ? { agent } : null; },
        archive: async () => { const agent = state.agents.find((agent) => agent.id === id); if (agent) agent.archivedAt = iso(state.now); },
        send: async (text: string) => { state.sent.push(`${id}:${text}`); },
      }),
    },
  } as unknown as PaseoApi;
  let counter = 0;
  const makeRouter = () => {
    const router = new SessionRouter({
      api: { activity: async (_session: string, content: { body?: string }) => { if (state.panelFails && content.body?.startsWith("Resumed")) throw new Error("panel lost"); state.messages.push(content.body ?? ""); }, updateSession: async () => {}, openSessions: async () => [], activities: async () => [] } as never,
      linear: { viewerId: async () => "owner", appUserId: async () => "app", addLabel: async () => {}, removeLabel: async () => {}, userUrl: async () => { await state.pauseRecipient?.(); return "https://linear.app/owner"; }, hasComment: async (_issue: string, mark: string) => state.comments.some((comment) => comment.includes(mark)), comment: async (_issue: string, body: string) => { if (state.commentFailure === "before") throw new Error("comment failed"); state.comments.push(body); if (state.commentFailure === "after") { state.commentFailure = "none"; throw new Error("response lost"); } } } as never,
      starter: { start: async (_id: string, _paseo: PaseoApi, _settings: PluginSettings, options: { fresh?: boolean }) => {
        if (state.pauseStart) await state.pauseStart();
        if (state.failStart) throw new Error("start failed");
        const id = `a${++counter}`;
        state.starts.push({ id, fresh: options.fresh });
        state.agents.push({ id, status: "running", createdAt: iso(state.now), cwd: "/repo/wt", labels: { "linear.issueId": "i1" }, archivedAt: null });
        return { agentId: id, warnings: [], provider: "omp", target: "/repo/wt", resumed: true, plan: null };
      }, admission: async () => ({ ok: true }) } as never,
      handover: {} as never,
      launcher: { gate: () => { if (state.gateHeld) return null; state.gateHeld = true; return { release: () => { state.gateHeld = false; } }; } },
      route: { take: async () => state.route },
      settings: { read: async () => state.settings }, store: sessions, limitResumes: limits, watchdog,
      usage: { read: async () => { state.onUsage?.(); return state.reports; }, chains: async () => state.chains },
      now: () => state.now, jitter: () => MINUTE, processLiveness: async () => state.process,
      deletions: { blocked: async () => state.deleted, get: async () => null, forAgent: async () => null } as never,
      stop: async (id) => { state.stopped.push(id); },
    });
    Object.assign(router, { paseo }); // No attach: avoid a background sweep in an isolated fixture.
    return router;
  };
  const router = makeRouter();
  const failCurrent = async () => { const current = (await sessions.get("s1"))!; state.agents.find((agent) => agent.id === current.agentId)!.status = "error"; };
  return { state, sessions, limits, watchdog, router, paseo, makeRouter, failCurrent, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("limit errors parse real provider hints and reject unrelated errors and invalid hints", () => {
  assert.deepEqual(limitError(ERROR), { provider: "anthropic", retryAfterMs: 274053000 });
  assert.deepEqual(limitError("usage limit retry-after: 12 model=omp/openai-codex/gpt-6:high"), { provider: "openai-codex", retryAfterMs: 12000 });
  for (const text of ["timeout", "tool failed", "1429 errors"]) assert.equal(limitError(text), null);
  for (const hint of ["0", "-10", String(31 * LIMIT_DAY)]) assert.equal(limitError(`rate_limit_error retry-after-ms=${hint}`)?.retryAfterMs, null);
});

test("model candidates preserve exact and prefix fallback chains but ignore roles", () => {
  assert.deepEqual(candidates({ default: ["google/gemini"], "anthropic/claude-opus-5-5": ["openai-codex/gpt-6:high"], "anthropic/*": ["anthropic/claude-fable-5", "google/*"] }, "omp/anthropic/claude-opus-5-5 · thinking high"), [MODEL, "openai-codex/gpt-6", "anthropic/claude-fable-5", "google/claude-opus-5-5"]);
});

test("freshness, measurability, shared windows and all exhausted resets govern availability", () => {
  for (const reports of [[], [{ ...report("anthropic", T0), fetchedAt: T0 - 31 * MINUTE }], [{ provider: "anthropic", fetchedAt: T0, limits: [{ scope: { tier: "opus" }, status: "ok" }] }], [{ provider: "anthropic", fetchedAt: T0, limits: [{ scope: {} }] }], [report("anthropic", T0, 1)].map((item) => ({ ...item, limits: [{ status: "exhausted" }] }))]) {
    const result = availability(reports, [MODEL], T0);
    assert.equal(result.recovery.roomNow, false);
    assert.equal(result.recovery.exhausted, false);
    assert.equal(result.episode.state, "unknown");
  }
  const first = report("anthropic", T0, 1, T0 + 2 * MINUTE);
  first.limits.push({ amount: { remainingFraction: 0 }, window: { resetsAt: T0 + 90 * MINUTE } });
  const result = availability([first, report("anthropic", T0, 1, T0 + 60 * MINUTE)], [MODEL], T0);
  assert.deepEqual(result.recovery, { roomNow: false, earliestReset: T0 + 60 * MINUTE, exhausted: true });
  assert.equal(result.episode.until, T0 + 60 * MINUTE);
  assert.equal(availability([first], [MODEL, "google/gemini"], T0).recovery.exhausted, false);
});

test("tier-only exhaustion permits same-provider fallback without opening a provider episode", () => {
  const item = report("anthropic", T0);
  item.limits.push({ scope: { tier: "fable" }, amount: { usedFraction: 1 }, window: { resetsAt: T0 + 8 * 60 * MINUTE } });
  assert.equal(availability([item], ["anthropic/claude-fable-5"], T0).recovery.roomNow, false);
  assert.equal(availability([item], ["anthropic/claude-fable-5", MODEL], T0).recovery.roomNow, true);
  assert.equal(availability([item], ["anthropic/claude-fable-5"], T0).episode.state, "room");
});

test("usage reader caches configuration and usage separately and never exposes broker failures", async () => {
  let now = T0, configs = 0, reads = 0;
  const logs: string[] = [];
  let broken = false;
  const reader = new UsageReader({ now: () => now, config: async () => { configs++; return { url: "http://broker", token: "secret", chains: { [MODEL]: ["openai-codex/gpt-6"] } }; }, fetch: (async (url: string | URL | Request) => { assert.equal(url, "http://broker/v1/usage"); reads++; if (broken) throw new Error("secret"); return { ok: true, json: async () => ({ reports: [report("anthropic", now)] }) } as Response; }) as typeof fetch, log: (message) => { logs.push(message); } });
  await Promise.all([reader.read(), reader.read(), reader.chains()]);
  assert.deepEqual([configs, reads], [1, 1]);
  now += MINUTE;
  await reader.read();
  assert.deepEqual([configs, reads], [1, 2]);
  now += 10 * MINUTE; broken = true;
  assert.equal(await reader.read(), null);
  now += MINUTE; assert.equal(await reader.read(), null);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("secret"));
});

test("store serializes mutations, is owner-only, retains pending old failures and fails closed", async () => {
  const h = await harness();
  try {
    await Promise.all([h.router.scheduleLimitResume("s1", ERROR, MODEL), h.router.scheduleLimitResume("s1", ERROR, MODEL)]);
    assert.equal((await stat(h.limits.path)).mode & 0o777, 0o600);
    assert.deepEqual((await h.limits.read()).incidents.i1.map((item) => item.resolution), ["superseded", "pending"]);
    h.state.now += 9 * LIMIT_DAY;
    await h.limits.update(() => {});
    assert.equal((await h.limits.read()).incidents.i1.length, 2); // Both match the same failure identity in this fixture.
    await writeFile(h.limits.path, "corrupt");
    assert.equal(await h.router.scheduleLimitResume("s1", ERROR, MODEL), false);
    await assert.rejects(h.router.resumeLimits(), /unknown shape/);
    assert.equal(await readFile(h.limits.path, "utf8"), "corrupt");
  } finally { await h.cleanup(); }
});

test("room on a sibling account or cross-provider fallback starts on the next pass, never fresh", async () => {
  for (const fallback of [false, true]) {
    const h = await harness();
    try {
      h.state.reports = [report("anthropic", T0, 1, T0 + 12 * 60 * MINUTE), report(fallback ? "openai-codex" : "anthropic", T0)];
      if (fallback) h.state.chains = { [MODEL]: ["openai-codex/gpt-6:high"] };
      assert.equal(await h.router.scheduleLimitResume("s1", ERROR, MODEL), true);
      assert.equal(h.state.starts.length, 0);
      assert.match(h.state.messages[0], /new agent now/);
      await h.router.resumeLimits();
      assert.deepEqual(h.state.starts, [{ id: "a1", fresh: false }]);
      const file = await h.limits.read();
      assert.equal(file.incidents.i1[0].resolution, "started");
      assert.equal(file.incidents.i1[0].startedAt, iso(T0));
      assert.deepEqual(file.pending, {});
      assert.equal(h.state.gateHeld, false);
    } finally { await h.cleanup(); }
  }
});

test("reset schedule survives reload, postpones on renewed exhaustion and starts only when due", async () => {
  const h = await harness();
  try {
    h.state.reports = [report("anthropic", T0, 1, T0 + 60 * MINUTE)];
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    assert.equal((await h.limits.read()).pending.i1.resumeAt, iso(T0 + 61 * MINUTE));
    h.state.now += 60 * MINUTE;
    await h.makeRouter().resumeLimits();
    assert.equal(h.state.starts.length, 0);
    h.state.now += MINUTE;
    h.state.reports = [report("anthropic", h.state.now, 1, h.state.now + 120 * MINUTE)];
    await h.makeRouter().resumeLimits();
    assert.equal((await h.limits.read()).pending.i1.resumeAt, iso(h.state.now + 121 * MINUTE));
    assert.equal((await h.limits.read()).incidents.i1[0].claimedAt, undefined);
    h.state.now += 121 * MINUTE;
    h.state.reports = [report("anthropic", h.state.now)];
    await h.makeRouter().resumeLimits();
    assert.equal(h.state.starts.length, 1);
  } finally { await h.cleanup(); }
});

test("unreadable broker uses retry-after or 30 minutes and every basis respects last claim spacing", async () => {
  for (const error of [ERROR, "usage limit model=anthropic/claude-opus-5-5"]) {
    const h = await harness();
    try {
      h.state.reports = null;
      await h.router.scheduleLimitResume("s1", error, MODEL);
      assert.equal((await h.limits.read()).pending.i1.resumeAt, iso(T0 + (error === ERROR ? 274053000 + MINUTE : 30 * MINUTE)));
      assert.deepEqual((await h.limits.read()).episodes, {});
    } finally { await h.cleanup(); }
  }
  for (const basis of ["room", "reset", "retry-after", "default"]) {
    const h = await harness();
    try {
      await h.router.scheduleLimitResume("s1", ERROR, MODEL);
      await h.router.resumeLimits();
      await h.failCurrent();
      h.state.now += MINUTE;
      h.state.reports = basis === "room" ? [report("anthropic", h.state.now)] : basis === "reset" ? [report("anthropic", h.state.now, 1, h.state.now + MINUTE)] : null;
      await h.router.scheduleLimitResume("s1", basis === "retry-after" ? "429 retry-after: 1" : "429", MODEL);
      assert.ok(Date.parse((await h.limits.read()).pending.i1.resumeAt) >= T0 + 15 * MINUTE);
    } finally { await h.cleanup(); }
  }
});

test("four rolling-day claims survive reload and a fifth is bounded; older claims expire", async () => {
  const h = await harness();
  try {
    for (let n = 0; n < 4; n++) {
      const router = h.makeRouter();
      h.state.reports = [report("anthropic", h.state.now)];
      assert.equal(await router.scheduleLimitResume("s1", ERROR, MODEL), true);
      await router.resumeLimits();
      await h.failCurrent();
      h.state.now += 16 * MINUTE;
    }
    assert.equal(h.state.starts.length, 4);
    assert.equal(await h.makeRouter().scheduleLimitResume("s1", ERROR, MODEL), false);
    assert.equal((await h.limits.read()).incidents.i1.at(-1)?.resolution, "bounded");
    h.state.now += LIMIT_DAY;
    h.state.reports = [report("anthropic", h.state.now)];
    assert.equal(await h.makeRouter().scheduleLimitResume("s1", ERROR, MODEL), true);
    await h.makeRouter().resumeLimits();
    assert.equal(h.state.starts.length, 5);
  } finally { await h.cleanup(); }
});

test("claim without outcome is never replayed after reload and counts toward the bound", async () => {
  const h = await harness();
  try {
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    await h.limits.update((file) => { file.incidents.i1[0].claimedAt = iso(T0); file.incidents.i1[0].resolution = "claimed"; delete file.pending.i1; });
    await h.makeRouter().resumeLimits();
    assert.deepEqual(h.state.starts, []);
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    assert.equal((await h.limits.read()).pending.i1.resumeAt, iso(T0 + 15 * MINUTE));
  } finally { await h.cleanup(); }
});

test("switch off at due time persists switched-off and offers Resume without starting", async () => {
  const h = await harness();
  try {
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    h.state.settings.writeback.autoResume = false;
    await h.makeRouter().resumeLimits();
    assert.equal((await h.limits.read()).incidents.i1[0].resolution, "switched-off");
    assert.equal((await h.sessions.get("s1"))?.offer, "resume");
    assert.deepEqual(h.state.starts, []);
  } finally { await h.cleanup(); }
});

test("changed agent, no longer error, live successor, deletion and closed thread supersede a schedule", async () => {
  for (const reason of ["changed", "idle", "successor", "deleted", "closed"]) {
    const h = await harness();
    try {
      await h.router.scheduleLimitResume("s1", ERROR, MODEL);
      if (reason === "changed") await h.sessions.patch("s1", { agentId: "other" });
      if (reason === "idle") h.state.agents[0].status = "idle";
      if (reason === "successor") h.state.agents.push({ ...h.state.agents[0], id: "other", status: "initializing" });
      if (reason === "deleted") h.state.deleted = true;
      if (reason === "closed") await h.sessions.patch("s1", { closed: true });
      await h.router.resumeLimits();
      assert.equal((await h.limits.read()).incidents.i1[0].resolution, "superseded", reason);
      assert.deepEqual(h.state.starts, []);
    } finally { await h.cleanup(); }
  }
});

test("held launch gate or live process defers without claiming", async () => {
  for (const reason of ["gate", "process"]) {
    const h = await harness();
    try {
      await h.router.scheduleLimitResume("s1", ERROR, MODEL);
      if (reason === "gate") h.state.gateHeld = true; else h.state.process = "alive";
      await h.router.resumeLimits();
      assert.equal((await h.limits.read()).incidents.i1[0].claimedAt, undefined);
      assert.deepEqual(h.state.starts, []);
      h.state.gateHeld = false; h.state.process = "absent";
      await h.router.resumeLimits();
      assert.equal(h.state.starts.length, 1);
    } finally { await h.cleanup(); }
  }
});

test("held route undoes claim and remains scheduled, then starts after release; forwarding counts", async () => {
  const h = await harness();
  try {
    h.state.route = { held: "peer handshake" };
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    await h.router.resumeLimits();
    assert.equal((await h.limits.read()).incidents.i1[0].claimedAt, undefined);
    assert.equal((await h.limits.read()).pending.i1.resumeAt, iso(T0 + 5 * MINUTE));
    assert.equal((await h.sessions.get("s1"))?.queued, false);
    h.state.route = null; h.state.now += 5 * MINUTE;
    await h.router.resumeLimits();
    assert.equal((await h.limits.read()).incidents.i1[0].resolution, "started");
  } finally { await h.cleanup(); }
  const remote = await harness();
  try {
    remote.state.route = { peer: "laptop" };
    await remote.router.scheduleLimitResume("s1", ERROR, MODEL);
    await remote.router.resumeLimits();
    assert.equal((await remote.limits.read()).incidents.i1[0].resolution, "forwarded");
    assert.ok((await remote.limits.read()).incidents.i1[0].claimedAt);
    assert.deepEqual(remote.state.starts, []);
  } finally { await remote.cleanup(); }
});

test("start failure offers Resume, but successful start followed by panel failure is recorded started", async () => {
  for (const started of [false, true]) {
    const h = await harness();
    try {
      h.state.failStart = !started; h.state.panelFails = started;
      await h.router.scheduleLimitResume("s1", ERROR, MODEL);
      await h.router.resumeLimits();
      assert.equal((await h.limits.read()).incidents.i1[0].resolution, started ? "started" : "failed");
      assert.equal((await h.sessions.get("s1"))?.offer, started ? null : "resume");
    } finally { await h.cleanup(); }
  }
});

test("owner reply or Stop wins the lock first and cancellation survives reload; Stop blocks late failure", async () => {
  for (const stop of [false, true]) {
    const h = await harness();
    try {
      await h.router.scheduleLimitResume("s1", ERROR, MODEL);
      await h.router.prompted("s1", { id: "owner-reply", userId: "owner", ...(stop ? { signal: "stop" } : {}), body: "continue" });
      await h.makeRouter().resumeLimits();
      assert.equal((await h.limits.read()).incidents.i1[0].resolution, "cancelled");
      assert.deepEqual(h.state.starts, []);
      if (stop) assert.equal(await h.router.scheduleLimitResume("s1", ERROR, MODEL), false);
      else assert.deepEqual(h.state.sent, ["a0:continue"]);
    } finally { await h.cleanup(); }
  }
});

test("due start wins the lock and an owner Stop waiting behind it addresses the replacement", async () => {
  const h = await harness();
  try {
    let release!: () => void, entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    h.state.pauseStart = async () => { entered(); await pause; };
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    const due = h.router.resumeLimits();
    await inside;
    const stop = h.router.prompted("s1", { id: "stop", userId: "owner", signal: "stop", body: "stop" });
    release();
    await Promise.all([due, stop]);
    assert.deepEqual(h.state.stopped, ["a1"]);
    assert.equal((await h.watchdog.read()).holds.i1.agentId, "a1");
    assert.equal((await h.limits.read()).incidents.i1[0].resolution, "started");
    assert.equal(await h.router.scheduleLimitResume("s1", ERROR, MODEL), false);
  } finally { await h.cleanup(); }
});

test("provider episode mentions once, preserves unknown gaps, dedupes lost replies and ends on recovery", async () => {
  for (const failure of ["none", "before", "after"] as const) {
    const h = await harness();
    try {
      h.state.reports = [report("anthropic", T0, 1, T0 + 12 * 60 * MINUTE), report("openai-codex", T0, 1, T0 + 60 * MINUTE)];
      h.state.chains = { [MODEL]: ["openai-codex/gpt-6"] };
      h.state.commentFailure = failure;
      await h.router.scheduleLimitResume("s1", ERROR, MODEL);
      await h.router.resumeLimits();
      h.state.commentFailure = "none";
      h.state.reports = null;
      await h.makeRouter().resumeLimits();
      assert.equal(h.state.comments.length, 1);
      assert.match(h.state.comments[0], /https:\/\/linear.app\/owner All anthropic accounts/);
      assert.match(h.state.comments[0], /00:00/); // Primary provider resets 12 h later, not fallback in 1 h.
      h.state.reports = [report("anthropic", T0, 1, T0 + 12 * 60 * MINUTE)];
      await h.router.scheduleLimitResume("s1", ERROR, MODEL);
      await h.router.resumeLimits();
      assert.equal(h.state.comments.length, 1);
      h.state.reports = [report("anthropic", T0)];
      await h.router.resumeLimits();
      assert.deepEqual((await h.limits.read()).episodes, {});
    } finally { await h.cleanup(); }
  }
});

test("short exhaustion has no mention until confirmed for over six hours; tier models agree on episode", async () => {
  const h = await harness();
  try {
    const tier = report("anthropic", T0);
    tier.limits.push({ scope: { tier: "fable" }, status: "exhausted", window: { resetsAt: T0 + 12 * 60 * MINUTE } });
    h.state.reports = [tier];
    await h.router.scheduleLimitResume("s1", "429", "anthropic/claude-fable-5");
    await h.router.resumeLimits();
    assert.deepEqual((await h.limits.read()).episodes, {});
    assert.deepEqual(h.state.comments, []);
    h.state.reports = [report("anthropic", T0, 1, T0 + 60 * MINUTE)];
    await h.router.scheduleLimitResume("s1", "429", MODEL);
    await h.router.resumeLimits();
    assert.deepEqual(h.state.comments, []);
    for (let hour = 1; hour <= 7; hour++) {
      h.state.now = T0 + hour * 60 * MINUTE;
      h.state.reports = [report("anthropic", h.state.now, 1, h.state.now + 60 * MINUTE)];
      await h.router.scheduleLimitResume("s1", "429", hour % 2 ? "anthropic/claude-fable-5" : MODEL);
      await h.router.resumeLimits();
    }
    assert.equal(h.state.comments.length, 1);
    assert.equal((await h.limits.read()).episodes.anthropic.since, iso(T0));
  } finally { await h.cleanup(); }
});

test("limit restart does not consume the existing hourly non-limit retry", async () => {
  const h = await harness();
  try {
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    await h.router.resumeLimits();
    await h.failCurrent();
    assert.equal(await h.router.resumeNow("s1"), true);
    await h.failCurrent();
    assert.equal(await h.router.resumeNow("s1"), false);
    assert.equal(h.state.starts.length, 2);
  } finally { await h.cleanup(); }
});

test("failed-turn hook schedules only limits with the switch on; other failures keep the hourly retry", async () => {
  for (const kind of ["limit", "off", "other"] as const) {
    const h = await harness();
    try {
      h.state.settings.writeback = { ...h.state.settings.writeback, autoResume: kind !== "off", summaries: false, blocked: false, pullRequests: false };
      const writeback = new Writeback({} as never, { read: async () => h.state.settings }, { sessions: h.router, handover: { finish: async () => ({}) as never } as never }, 0, join(h.directory, "outbox.json"));
      const event = { agent: { id: "a0", workspaceId: "w1", parentAgentId: null, provider: "omp", cwd: "/repo/wt", title: "TUC-1" }, outcome: { kind: "failed", error: { message: kind === "other" ? "tool failed" : ERROR } }, timeline: [] };
      await writeback.turnEnded(event as never, h.paseo);
      if (kind === "limit") {
        assert.ok((await h.limits.read()).pending.i1);
        assert.equal(h.state.starts.length, 0);
        await h.router.resumeLimits();
        assert.equal((await h.limits.read()).incidents.i1[0].resolution, "started");
      } else if (kind === "off") {
        assert.deepEqual((await h.limits.read()).incidents, {});
        assert.equal((await h.sessions.get("s1"))?.offer, "resume");
        assert.equal(h.state.starts.length, 0);
      } else {
        assert.deepEqual((await h.limits.read()).incidents, {});
        assert.equal(h.state.starts.length, 1);
        await h.failCurrent();
        assert.equal(await h.router.resumeNow("s1"), false);
      }
    } finally { await h.cleanup(); }
  }
});

test("two tickets failing concurrently share one provider exhaustion mention", async () => {
  const h = await harness();
  try {
    h.state.reports = [report("anthropic", T0, 1, T0 + 12 * 60 * MINUTE)];
    await h.sessions.put({ ...(await h.sessions.get("s1"))!, sessionId: "s2", issueId: "i2", identifier: "TUC-2", agentId: "b0" });
    await Promise.all([h.router.scheduleLimitResume("s1", ERROR, MODEL), h.router.scheduleLimitResume("s2", ERROR, MODEL)]);
    await h.router.resumeLimits();
    assert.equal(Object.keys((await h.limits.read()).pending).length, 2);
    assert.equal(h.state.comments.length, 1);
    assert.equal((await h.limits.read()).episodes.anthropic.mention?.posted, true);
  } finally { await h.cleanup(); }
});

test("a broker refresh during an asynchronous read uses the evaluation clock, not the failure clock", async () => {
  const h = await harness();
  try {
    h.state.onUsage = () => { h.state.now += 1000; h.state.reports = [report("anthropic", h.state.now)]; };
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    const file = await h.limits.read();
    assert.equal(file.pending.i1.basis, "room");
    assert.equal(file.incidents.i1[0].failedAt, iso(T0));
    await h.router.resumeLimits();
    assert.equal(h.state.starts.length, 1);
  } finally { await h.cleanup(); }
});

test("a schedule older than eight days retains its new claim and outcome in the daily budget", async () => {
  const h = await harness();
  try {
    h.state.reports = null;
    await h.router.scheduleLimitResume("s1", `429 retry-after-ms=${9 * LIMIT_DAY}`, MODEL);
    h.state.now += 9 * LIMIT_DAY + MINUTE;
    await h.router.resumeLimits();
    assert.equal((await h.limits.read()).incidents.i1[0].resolution, "started");
    assert.equal((await h.limits.read()).incidents.i1[0].claimedAt, iso(h.state.now));
    await h.failCurrent();
    for (let n = 0; n < 3; n++) {
      h.state.now += 16 * MINUTE;
      h.state.reports = [report("anthropic", h.state.now)];
      assert.equal(await h.router.scheduleLimitResume("s1", ERROR, MODEL), true);
      await h.router.resumeLimits();
      await h.failCurrent();
    }
    assert.equal(await h.router.scheduleLimitResume("s1", ERROR, MODEL), false);
    assert.equal(h.state.starts.length, 4);
  } finally { await h.cleanup(); }
});

test("confirmed provider recovery while resolving the recipient cancels an unposted mention", async () => {
  const h = await harness();
  try {
    let release!: () => void, entered!: () => void;
    const lookup = new Promise<void>((resolve) => { entered = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    h.state.pauseRecipient = async () => { entered(); await pause; };
    h.state.reports = [report("anthropic", T0, 1, T0 + 12 * 60 * MINUTE)];
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    const pass = h.router.resumeLimits();
    await lookup;
    h.state.reports = [report("anthropic", T0)];
    await h.router.scheduleLimitResume("s1", ERROR, MODEL);
    assert.deepEqual((await h.limits.read()).episodes, {});
    release();
    await pass;
    assert.deepEqual(h.state.comments, []);
  } finally { await h.cleanup(); }
});
