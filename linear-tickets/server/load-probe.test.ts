import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { startLoadProbe, type DelayHistogram, type InspectorSessionLike, type LoadProbeOptions } from "./load-probe";
import { sessionOpenGuard, sessionPrepare } from "./session-open";
import { DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_STEWARD, DEFAULT_WATCHDOG, DEFAULT_WORKTREE_SHARDS, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const MINUTE = 60_000;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Timers and both clocks under the test's control. `block` moves time without running any timer
// (a synchronous stretch on the event loop); `advance` runs every timer that falls due, an
// overdue interval once, as Node does after a blocked loop.
class FakeClock {
  t = 0;
  wallShift = 0;
  private seq = 0;
  private readonly timers = new Map<number, { callback: () => void; at: number; every: number | null }>();
  constructor(readonly wallBase = Date.now()) {}
  now = () => this.t;
  wallNow = () => this.wallBase + this.t + this.wallShift;
  setInterval = (callback: () => void, ms: number) => this.add(callback, ms, ms);
  setTimeout = (callback: () => void, ms: number) => this.add(callback, ms, null);
  clear = (handle: unknown) => { this.timers.delete(handle as number); };
  private add(callback: () => void, ms: number, every: number | null): number {
    const id = ++this.seq;
    this.timers.set(id, { callback, at: this.t + ms, every });
    return id;
  }
  block(ms: number): void { this.t += ms; }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { callback: () => void; at: number; every: number | null }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      this.t = Math.max(this.t, timer.at);
      if (timer.every === null) this.timers.delete(id);
      else timer.at = this.t + timer.every;
      timer.callback();
    }
    this.t = end;
  }
  // Runs timers minute by minute, letting the profiler's file work settle between them.
  async run(ms: number, settle: () => Promise<void>): Promise<void> {
    for (let left = ms; left > 0; left -= Math.min(left, 1000)) {
      this.advance(Math.min(left, 1000));
      await settle();
    }
  }
}

class FakeHistogram implements DelayHistogram {
  p99Ns = 0;
  resets = 0;
  enabled = false;
  enable() { this.enabled = true; }
  disable() { this.enabled = false; }
  reset() { this.resets++; this.p99Ns = 0; }
  percentile() { return this.p99Ns; }
}

class FakeSession implements InspectorSessionLike {
  calls: string[] = [];
  fail: string | null = null;
  connect() { this.calls.push("connect"); }
  disconnect() { this.calls.push("disconnect"); }
  post(method: string, _params: object, callback: (error: Error | null, result?: object) => void) {
    this.calls.push(method);
    if (method === this.fail) { setImmediate(() => callback(new Error(`${method} broke`))); return; }
    setImmediate(() => callback(null, method === "Profiler.stop" ? { profile: { nodes: [], startTime: 0, endTime: 1 } } : {}));
  }
}

function probeWith(clock: FakeClock, extra: Partial<LoadProbeOptions> = {}) {
  const lines: string[] = [];
  const delay = new FakeHistogram();
  const sessions: FakeSession[] = [];
  const probe = startLoadProbe({
    now: clock.now, wallNow: clock.wallNow,
    setInterval: clock.setInterval, clearInterval: clock.clear, setTimeout: clock.setTimeout, clearTimeout: clock.clear,
    log: (line) => lines.push(line),
    memory: () => ({ heapUsed: 64 * 1024 * 1024, rss: 256 * 1024 * 1024 }),
    delay: () => delay,
    home: join(tmpdir(), "load-probe-no-home"),
    session: () => { const session = new FakeSession(); sessions.push(session); return session; },
    ...extra,
  });
  return { probe, lines, delay, sessions };
}

const stallLines = (lines: string[]) => lines.filter((line) => line.includes("event loop blocked"));
const blockedMs = (line: string) => Number(/blocked (\d+) ms/.exec(line)?.[1]);

test("a synchronous block of two seconds or more is logged once when the loop resumes, close to its length", () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  try {
    clock.advance(1000);
    clock.block(2000);
    assert.equal(stallLines(lines).length, 0, "nothing is written while the loop is blocked");
    clock.advance(0);
    clock.advance(5000);
    assert.equal(stallLines(lines).length, 1);
    assert.ok(Math.abs(blockedMs(stallLines(lines)[0] as string) - 2000) <= 250, stallLines(lines)[0]);

    clock.advance(130);
    clock.block(3000);
    clock.advance(1000);
    assert.equal(stallLines(lines).length, 2);
    assert.ok(Math.abs(blockedMs(stallLines(lines)[1] as string) - 3000) <= 250, stallLines(lines)[1]);
    assert.match(stallLines(lines)[1] as string, /heap 64 MB, rss 256 MB, in flight: none/);
  } finally { probe.stop(); }
});

test("a half-second block is not a stall", () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  try {
    for (let index = 0; index < 20; index++) { clock.advance(170); clock.block(500); }
    clock.advance(1000);
    assert.deepEqual(stallLines(lines), []);
  } finally { probe.stop(); }
});

test("the stall line names the work in flight and how long it has run", async () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  try {
    let finish = () => {};
    const pending = probe.time("steward", () => new Promise<void>((resolve) => { finish = resolve; }));
    clock.advance(1000);
    clock.block(4000);
    clock.advance(0);
    assert.match(stallLines(lines)[0] as string, /in flight: steward 5000 ms\)/);
    finish();
    await pending;
  } finally { probe.stop(); }
});

test("stepping the wall clock backwards does not change a measured duration", async () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  try {
    clock.advance(1000);
    clock.wallShift = -3_600_000;
    clock.block(2000);
    clock.advance(0);
    assert.ok(Math.abs(blockedMs(stallLines(lines)[0] as string) - 2000) <= 250);

    let finish = () => {};
    const pending = probe.time("session_open.prepare", () => new Promise<void>((resolve) => { finish = resolve; }), "hook");
    clock.wallShift = -7_200_000;
    clock.advance(2500);
    finish();
    await pending;
    await flush();
    assert.match(lines.find((line) => line.includes("slow session_open.prepare")) ?? "", /slow session_open\.prepare 2500 ms \(ok\)/);
  } finally { probe.stop(); }
});

test("time() hands back the work's own value and its own error", async () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  try {
    const value = { answer: 42 };
    assert.equal(await probe.time("pass", async () => value), value);
    const error = new Error("boom");
    await assert.rejects(probe.time("pass", async () => { throw error; }), (thrown) => thrown === error);
    const syncError = new Error("sync");
    assert.throws(() => probe.time("pass", () => { throw syncError; }), (thrown) => thrown === syncError);
    await flush();
    assert.deepEqual(lines, [], "fast work is not logged, failed or not");
  } finally { probe.stop(); }
});

test("slow work is logged with its outcome at the hook and pass thresholds", async () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  const timed = async (name: string, ms: number, kind: "hook" | "pass", fails = false) => {
    let settle = () => {};
    const pending = probe.time(name, () => new Promise<void>((resolve, reject) => { settle = fails ? () => reject(new Error("no")) : resolve; }), kind);
    clock.advance(ms);
    settle();
    await pending.catch(() => undefined);
    await flush();
  };
  try {
    await timed("capacity", 1900, "hook");
    await timed("turn_ended", 2100, "hook", true);
    await timed("plan-pipeline", 9000, "pass");
    await timed("pr-watch", 12_000, "pass");
    const slow = lines.filter((line) => line.includes(" slow "));
    assert.equal(slow.length, 2, slow.join("\n"));
    assert.match(slow[0] as string, /^\[linear-tickets\] slow turn_ended 2100 ms \(failed\), started \d{4}-/);
    assert.match(slow[1] as string, /slow pr-watch 12000 ms \(ok\)/);
  } finally { probe.stop(); }
});

function settingsFor(): PluginSettings {
  return {
    template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
    dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, steward: DEFAULT_STEWARD, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [],
    activation: { ...DEFAULT_ACTIVATION, mode: "remote", peer: "https://peer.example:8444" }, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
  };
}

function openRequest(change: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest {
  return { agentId: "agent-1", workspaceId: null, provider: "omp", cwd: "/repo/wt", reason: "resume", purpose: "interactive", env: {}, ...change };
}

// A daemon connection whose agent refresh resolves after `refreshMs` of fake time.
function paseoFor(clock: FakeClock, refreshMs: number, found: boolean): PaseoApi {
  return { agents: { ref: () => ({ refresh: async () => {
    clock.advance(refreshMs);
    return found ? { agent: { labels: { "linear.issueId": "issue-1" } } } : null;
  } }) } } as unknown as PaseoApi;
}

const prepareDeps = { attach: () => {}, plannotator: async () => null, envs: { read: async () => ({}) } };

test("a session_open prepare with a slow refresh logs its start and every awaited step; a fast one logs nothing", async () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  try {
    const prepare = sessionPrepare(prepareDeps, probe);
    await prepare({ request: openRequest() }, { paseo: paseoFor(clock, 100, true) });
    await flush();
    assert.deepEqual(lines.filter((line) => line.includes("session_open")), []);

    await prepare({ request: openRequest() }, { paseo: paseoFor(clock, 2400, true) });
    await flush();
    const line = lines.find((entry) => entry.includes("slow session_open.prepare")) ?? "";
    assert.match(line, /slow session_open\.prepare 2400 ms \(ok\), started \S+Z; steps: plannotator 0 ms, env 0 ms, refresh 2400 ms$/);
  } finally { probe.stop(); }
});

test("timing keeps the resume capability error and the guard's refusal word for word", async () => {
  const clock = new FakeClock();
  const { probe } = probeWith(clock);
  try {
    const prepare = sessionPrepare(prepareDeps, probe);
    await assert.rejects(prepare({ request: openRequest() }, { paseo: paseoFor(clock, 10, false) }), {
      message: "The resumed agent's capabilities cannot be verified; the session stays closed.",
    });
    const guard = sessionOpenGuard({
      settings: { read: async () => settingsFor() },
      drain: { agentTicket: async () => ({ identifier: "TUC-1" }), holdsAgent: async () => false },
      log: () => {},
    }, probe);
    await assert.rejects(guard({ request: openRequest() }, { paseo: {} as PaseoApi }), {
      message: "This host no longer runs new work for TUC-1: Linear ticket work is routed to https://peer.example:8444. The ticket continues on the other host; open a new chat for anything else.",
    });
  } finally { probe.stop(); }
});

test("a slow guard names its awaited reads", async () => {
  const clock = new FakeClock();
  const { probe, lines } = probeWith(clock);
  try {
    const guard = sessionOpenGuard({
      settings: { read: async () => settingsFor() },
      ready: async () => { clock.advance(10); },
      drain: { agentTicket: async () => ({ identifier: "TUC-1" }), holdsAgent: async () => { clock.advance(3000); return true; } },
      log: () => {},
    }, probe);
    await guard({ request: openRequest() }, { paseo: {} as PaseoApi });
    await flush();
    assert.match(lines.find((line) => line.includes("slow session_open.guard")) ?? "", /steps: settings 0 ms, ready 10 ms, ticket 0 ms, holds 3000 ms$/);
  } finally { probe.stop(); }
});

test("the ten-minute summary counts the opens, turns and stalls since start; its loop delay p99 is per interval", async () => {
  const clock = new FakeClock();
  const { probe, lines, delay } = probeWith(clock);
  try {
    for (let index = 0; index < 5; index++) await probe.time("session_open.guard", async () => undefined, "hook");
    await probe.time("session_open.prepare", async () => { throw new Error("x"); }, "hook").catch(() => undefined);
    let finish = () => {};
    const slow = probe.time("session_open.prepare", () => new Promise<void>((resolve) => { finish = resolve; }), "hook");
    clock.advance(3000);
    finish();
    await slow;
    for (let index = 0; index < 3; index++) await probe.time("turn_ended", async () => undefined, "hook");
    clock.block(6000);
    clock.advance(0);
    await flush();
    delay.p99Ns = 41_000_000;
    clock.advance(10 * MINUTE - clock.t);
    const summaries = lines.filter((line) => line.includes("load probe since"));
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0], `[linear-tickets] load probe since ${new Date(clock.wallBase).toISOString()}: session_open 5 (failed 1, ≥2s 1, max 3000 ms), turn_ended 3, stalls ≥2s 1 / ≥5s 1, max stall 6000 ms, loop delay p99 41 ms`);
    clock.advance(10 * MINUTE);
    assert.match(lines.filter((line) => line.includes("load probe since"))[1] as string, /session_open 5 .*loop delay p99 0 ms$/);
    assert.equal(delay.resets, 2);
  } finally { probe.stop(); }
  assert.equal(delay.enabled, false);
});

// The profiler, against a temporary PASEO_HOME and a fake inspector session.
async function profilerWorld(extra: Partial<LoadProbeOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "load-probe-"));
  const directory = join(home, "linear-tickets", "diagnostics");
  await mkdir(directory, { recursive: true });
  const clock = new FakeClock();
  const world = probeWith(clock, { home, ...extra });
  const settle = async () => { for (let round = 0; round < 4; round++) { await world.probe.idle(); await flush(); } };
  const writeSwitch = async (until: number, writtenAt = clock.wallNow()) => {
    const file = join(directory, "profile-until");
    await writeFile(file, new Date(until).toISOString());
    await utimes(file, writtenAt / 1000, writtenAt / 1000);
  };
  const profiles = async () => (await readdir(directory)).filter((name) => name.endsWith(".cpuprofile")).sort();
  const cleanup = async () => { world.probe.stop(); await rm(home, { recursive: true, force: true }); };
  return { ...world, clock, directory, settle, writeSwitch, profiles, cleanup };
}

test("without a switch file no inspector session is ever started", async () => {
  const world = await profilerWorld();
  try {
    await world.clock.run(5 * MINUTE, world.settle);
    assert.equal(world.sessions.length, 0);
  } finally { await world.cleanup(); }
});

test("a switch more than a day past its write time, or already past, is ignored and logged once", async () => {
  const world = await profilerWorld();
  try {
    await world.writeSwitch(world.clock.wallNow() + 25 * 60 * MINUTE);
    await world.clock.run(3 * MINUTE, world.settle);
    await world.writeSwitch(world.clock.wallNow() - MINUTE);
    await world.clock.run(3 * MINUTE, world.settle);
    assert.equal(world.sessions.length, 0);
    const ignored = world.lines.filter((line) => line.includes("profiler switch ignored"));
    assert.equal(ignored.length, 2, ignored.join("\n"));
    assert.match(ignored[0] as string, /more than 24 h after/);
    assert.match(ignored[1] as string, /in the past/);
  } finally { await world.cleanup(); }
});

test("an unchanged valid switch never extends its deadline: recording stops at the file's time", async () => {
  const world = await profilerWorld();
  try {
    const until = world.clock.wallNow() + 30 * MINUTE + 20_000;
    await world.writeSwitch(until);
    await world.clock.run(31 * MINUTE, world.settle);
    assert.equal(world.sessions.length, 1);
    const session = world.sessions[0] as FakeSession;
    assert.equal(session.calls.at(-1), "disconnect");
    assert.equal(session.calls.filter((call) => call === "Profiler.start").length, 30, "from the first poll a minute in: twenty-nine full chunks and a last partial one");
    assert.ok(world.lines.some((line) => line.includes("profiler stopped (switch expired)")));
    await world.clock.run(5 * MINUTE, world.settle);
    assert.equal(world.sessions.length, 1, "the expired switch starts nothing again");
    assert.equal(world.lines.filter((line) => line.includes("profiler switch ignored")).length, 0);
    assert.deepEqual(await world.profiles(), [], "no chunk held a long stall");
  } finally { await world.cleanup(); }
});

test("expiry inside a chunk stops and disconnects; that chunk is kept only for a stall of five seconds", async () => {
  const world = await profilerWorld();
  try {
    await world.writeSwitch(world.clock.wallNow() + 90_000);
    await world.clock.run(70_000, world.settle);
    world.clock.block(5500);
    await world.clock.run(30_000, world.settle);
    const session = world.sessions[0] as FakeSession;
    assert.equal(session.calls.at(-1), "disconnect");
    assert.equal((await world.profiles()).length, 1);

    await world.writeSwitch(world.clock.wallNow() + 90_000);
    await world.clock.run(70_000, world.settle);
    world.clock.block(3000);
    await world.clock.run(30_000, world.settle);
    assert.equal((world.sessions[1] as FakeSession).calls.at(-1), "disconnect");
    assert.equal((await world.profiles()).length, 1, "a three-second stall keeps no profile");
  } finally { await world.cleanup(); }
});

test("deleting the switch file stops the recording", async () => {
  const world = await profilerWorld();
  try {
    await world.writeSwitch(world.clock.wallNow() + 60 * MINUTE);
    await world.clock.run(90_000, world.settle);
    await rm(join(world.directory, "profile-until"));
    await world.clock.run(MINUTE, world.settle);
    assert.equal((world.sessions[0] as FakeSession).calls.at(-1), "disconnect");
    assert.ok(world.lines.some((line) => line.includes("profiler stopped (switch removed)")));
  } finally { await world.cleanup(); }
});

for (const method of ["Profiler.start", "Profiler.stop"]) {
  test(`a failing ${method} disconnects, logs once and leaves the profiler off until reload`, async () => {
    const world = await profilerWorld({ session: () => { const session = new FakeSession(); session.fail = method; world.sessions.push(session); return session; } });
    try {
      await world.writeSwitch(world.clock.wallNow() + 60 * MINUTE);
      await world.clock.run(5 * MINUTE, world.settle);
      assert.equal(world.sessions.length, 1);
      assert.equal((world.sessions[0] as FakeSession).calls.at(-1), "disconnect");
      const disabled = world.lines.filter((line) => line.includes("profiler disabled until reload"));
      assert.equal(disabled.length, 1);
      assert.match(disabled[0] as string, new RegExp(`${method.replace(".", "\\.")} failed \\(${method.replace(".", "\\.")} broke\\)`));
    } finally { await world.cleanup(); }
  });
}

test("the file cap keeps the thirty newest profiles", async () => {
  const world = await profilerWorld();
  try {
    for (let index = 0; index < 30; index++) await writeFile(join(world.directory, `2000-01-01T00-00-${String(index).padStart(2, "0")}.000Z.cpuprofile`), "{}");
    await world.writeSwitch(world.clock.wallNow() + 90_000);
    await world.clock.run(70_000, world.settle);
    world.clock.block(6000);
    await world.clock.run(MINUTE, world.settle);
    const kept = await world.profiles();
    assert.equal(kept.length, 30);
    assert.equal(kept[0], "2000-01-01T00-00-01.000Z.cpuprofile", "the oldest is gone");
    assert.ok(!(kept.at(-1) as string).startsWith("2000-"), "the new profile is kept");
  } finally { await world.cleanup(); }
});

test("the size cap prunes the oldest profiles until the rest fit", async () => {
  const world = await profilerWorld({ limits: { bytes: 1000 } });
  try {
    for (const name of ["2000-01-01T00-00-00.000Z", "2000-01-01T00-00-01.000Z"]) await writeFile(join(world.directory, `${name}.cpuprofile`), "x".repeat(490));
    await world.writeSwitch(world.clock.wallNow() + 90_000);
    await world.clock.run(70_000, world.settle);
    world.clock.block(6000);
    await world.clock.run(MINUTE, world.settle);
    const kept = await world.profiles();
    assert.equal(kept.length, 2);
    assert.equal(kept[0], "2000-01-01T00-00-01.000Z.cpuprofile");
  } finally { await world.cleanup(); }
});

test("stopping the plugin disconnects a running recording", async () => {
  const world = await profilerWorld();
  try {
    await world.writeSwitch(world.clock.wallNow() + 60 * MINUTE);
    await world.clock.run(2 * MINUTE, world.settle);
    world.probe.stop();
    await world.settle();
    const session = world.sessions[0] as FakeSession;
    assert.deepEqual(session.calls.slice(-2), ["Profiler.stop", "disconnect"]);
    await world.clock.run(5 * MINUTE, world.settle);
    assert.equal(world.sessions.length, 1);
    assert.equal(session.calls.at(-1), "disconnect");
  } finally { await world.cleanup(); }
});
