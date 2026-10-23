import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { paseoHome } from "./ticket-mcp";

// The load probe (README, "Diagnostics"): what kept this plugin's event loop busy while the
// daemon waited for one of its hooks. Read-only toward everything else: it logs event loop stalls
// with the work in flight, slow hooks and periodic passes with their awaited steps, a ten-minute
// activity summary, and -- only while an owner-written switch file allows it -- CPU profiles of the
// minutes that held a long stall. It never changes what the work it times returns or throws.
const TICK_MS = 250;
const STALL_MS = 2_000;
const PROFILE_STALL_MS = 5_000;
const SUMMARY_MS = 10 * 60 * 1000;
const SWITCH_POLL_MS = 60 * 1000;
const CHUNK_MS = 60 * 1000;
const SWITCH_MAX_MS = 24 * 60 * 60 * 1000;
const SLOW_MS: Record<ProbeKind, number> = { hook: 2_000, pass: 10_000 };
const IN_FLIGHT_SHOWN = 8;
const MAX_FILES = 30;
const MAX_BYTES = 500 * 1024 * 1024;
const SWITCH_FILE = "profile-until";

// A hook answers the daemon (session_open, turn events, capacity reads); a pass is periodic work.
export type ProbeKind = "hook" | "pass";
type Handle = unknown;
export type InspectorSessionLike = {
  connect(): void;
  post(method: string, params: object, callback: (error: Error | null, result?: object) => void): void;
  disconnect(): void;
};
export type DelayHistogram = { enable(): void; disable(): void; reset(): void; percentile(percentile: number): number };
export type LoadProbeOptions = {
  // Monotonic milliseconds; durations never come from the wall clock.
  now?: () => number;
  // Wall clock, for timestamps and the switch file's end time only.
  wallNow?: () => number;
  setInterval?: (callback: () => void, ms: number) => Handle;
  clearInterval?: (handle: Handle) => void;
  setTimeout?: (callback: () => void, ms: number) => Handle;
  clearTimeout?: (handle: Handle) => void;
  log?: (line: string) => void;
  memory?: () => { heapUsed: number; rss: number };
  delay?: () => DelayHistogram;
  home?: string;
  session?: () => InspectorSessionLike;
  limits?: { files?: number; bytes?: number };
};
export type Step = { name: string; ms: number };
export type LoadProbe = {
  time<T>(name: string, work: () => Promise<T>, kind?: ProbeKind): Promise<T>;
  // Marks one awaited step of the innermost timed operation; outside one it only runs the work.
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  stop(): void;
  // Settles when the profiler's queued work has finished (the behavior tests' seam).
  idle(): Promise<void>;
};
type Operation = { id: number; name: string; kind: ProbeKind; start: number; startedAt: number; steps: Step[]; done: boolean };
type Stats = { count: number; failed: number; slow: number; max: number };
type Recording = { session: InspectorSessionLike; until: number; key: string; chunkStall: number; chunkStartedAt: number; timer: Handle | null };
type SwitchRead = { until: number; key: string } | { invalid: string; key: string } | null;

const operations = new AsyncLocalStorage<Operation>();
let active: LoadProbe | null = null;

// The plugin-wide entry for modules that time their own passes: the running probe, or the bare
// work while none runs (tests, and before the plugin attaches).
export const loadProbe: Pick<LoadProbe, "time" | "step"> = {
  time: (name, work, kind) => active ? active.time(name, work, kind) : work(),
  step: (name, work) => active ? active.step(name, work) : work(),
};

export function startLoadProbe(options: LoadProbeOptions = {}): LoadProbe {
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const started = wallNow();
  const every = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const cancelEvery = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  const after = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancelAfter = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const rawLog = options.log ?? ((line: string) => console.log(line));
  const memory = options.memory ?? (() => process.memoryUsage());
  const directory = join(options.home ?? paseoHome(), "linear-tickets", "diagnostics");
  const createSession = options.session ?? (() => new Session());
  const maxFiles = options.limits?.files ?? MAX_FILES;
  const maxBytes = options.limits?.bytes ?? MAX_BYTES;
  const log = (message: string) => { try { rawLog(`[linear-tickets] ${message}`); } catch { /* a log line never fails the work */ } };
  const unref = (handle: Handle) => { (handle as { unref?: () => void } | null)?.unref?.(); return handle; };

  let stopped = false;
  let seq = 0;
  const inFlight = new Map<number, Operation>();
  const stats = new Map<string, Stats>();
  let stalls = 0, longStalls = 0, maxStall = 0;
  let delay: DelayHistogram | null = null;
  try {
    delay = options.delay ? options.delay() : monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
  } catch { delay = null; }

  const statsFor = (name: string): Stats => {
    let entry = stats.get(name);
    if (!entry) stats.set(name, entry = { count: 0, failed: 0, slow: 0, max: 0 });
    return entry;
  };
  const ms = (value: number) => Math.round(value);
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  const iso = (wall: number) => new Date(wall).toISOString();

  // Stall monitor: a gap between two ticks is time the loop ran no timer; the line is written
  // when the loop runs again, so it names what was in flight across the stall.
  let lastTick = now();
  let recording: Recording | null = null;
  const stall = (gap: number, at: number) => {
    stalls++;
    if (gap >= PROFILE_STALL_MS) longStalls++;
    maxStall = Math.max(maxStall, gap);
    if (recording) recording.chunkStall = Math.max(recording.chunkStall, gap);
    try {
      const { heapUsed, rss } = memory();
      const open = [...inFlight.values()].sort((a, b) => a.start - b.start);
      const shown = open.slice(0, IN_FLIGHT_SHOWN).map((operation) => `${operation.name} ${ms(at - operation.start)} ms`);
      if (open.length > IN_FLIGHT_SHOWN) shown.push(`${open.length - IN_FLIGHT_SHOWN} more`);
      log(`event loop blocked ${ms(gap)} ms (heap ${mb(heapUsed)} MB, rss ${mb(rss)} MB, in flight: ${shown.length ? shown.join(", ") : "none"})`);
    } catch { /* see log */ }
  };
  const tick = unref(every(() => {
    const at = now();
    const gap = at - lastTick;
    lastTick = at;
    if (gap >= STALL_MS) stall(gap, at);
  }, TICK_MS));

  const settle = (operation: Operation, ok: boolean) => {
    if (operation.done) return;
    operation.done = true;
    inFlight.delete(operation.id);
    const took = now() - operation.start;
    const entry = statsFor(operation.name);
    entry.count++;
    if (!ok) entry.failed++;
    if (took >= STALL_MS) entry.slow++;
    entry.max = Math.max(entry.max, took);
    if (took < SLOW_MS[operation.kind]) return;
    const steps = operation.steps.length ? `; steps: ${operation.steps.map((step) => `${step.name} ${ms(step.ms)} ms`).join(", ")}` : "";
    log(`slow ${operation.name} ${ms(took)} ms (${ok ? "ok" : "failed"}), started ${iso(operation.startedAt)}${steps}`);
  };

  const time = <T>(name: string, work: () => Promise<T>, kind: ProbeKind = "pass"): Promise<T> => {
    if (stopped) return work();
    const operation: Operation = { id: ++seq, name, kind, start: now(), startedAt: wallNow(), steps: [], done: false };
    inFlight.set(operation.id, operation);
    let result: Promise<T>;
    try {
      result = operations.run(operation, work);
    } catch (error) {
      settle(operation, false);
      throw error;
    }
    // The caller gets the work's own promise: its value and its rejection are untouched.
    Promise.resolve(result).then(() => settle(operation, true), () => settle(operation, false));
    return result;
  };

  const step = <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const operation = operations.getStore();
    if (stopped || !operation || operation.done) return work();
    const start = now();
    const done = () => { if (!operation.done) operation.steps.push({ name, ms: now() - start }); };
    let result: Promise<T>;
    try {
      result = work();
    } catch (error) {
      done();
      throw error;
    }
    Promise.resolve(result).then(done, done);
    return result;
  };

  // Activity summary: counters since this probe started (the plugin's load); the loop delay p99 is
  // this interval's.
  const summary = unref(every(() => {
    const guard = statsFor("session_open.guard");
    const prepare = statsFor("session_open.prepare");
    const turns = statsFor("turn_ended");
    let p99 = 0;
    try { p99 = (delay?.percentile(99) ?? 0) / 1e6; delay?.reset(); } catch { /* histogram unavailable */ }
    log(`load probe since ${iso(started)}: session_open ${guard.count} (failed ${guard.failed + prepare.failed}, ≥2s ${guard.slow + prepare.slow}, max ${ms(Math.max(guard.max, prepare.max))} ms), turn_ended ${turns.count}, stalls ≥2s ${stalls} / ≥5s ${longStalls}, max stall ${ms(maxStall)} ms, loop delay p99 ${ms(p99)} ms`);
  }, SUMMARY_MS));

  // Profiler: only while $PASEO_HOME/linear-tickets/diagnostics/profile-until names a future end
  // time at most 24 h after the file was written. Consecutive one-minute chunks; a chunk is kept
  // only when its minute held a stall of at least 5 s. Any profiler failure ends it until reload.
  let disabled = false;
  const reported = new Set<string>();
  const once = (key: string, message: string) => { if (!reported.has(key)) { reported.add(key); log(message); } };
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error: unknown) => once(`queue:${String(error)}`, `profiler step failed: ${error instanceof Error ? error.message : error}`));
  };
  const post = (session: InspectorSessionLike, method: string): Promise<object | undefined> => new Promise((resolve, reject) => {
    session.post(method, {}, (error, result) => error ? reject(error) : resolve(result));
  });
  const disconnect = (session: InspectorSessionLike) => { try { session.disconnect(); } catch { /* already gone */ } };

  const readSwitch = async (): Promise<SwitchRead> => {
    const file = join(directory, SWITCH_FILE);
    let text: string, mtimeMs: number;
    try {
      [text, { mtimeMs }] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      return { invalid: `unreadable (${code ?? (error instanceof Error ? error.message : error)})`, key: `read:${code}` };
    }
    const value = text.trim();
    const until = Date.parse(value);
    const key = `${value}@${mtimeMs}`;
    if (!Number.isFinite(until)) return { invalid: `"${value.slice(0, 40)}" is not an ISO time`, key };
    if (until <= wallNow()) return { invalid: `${value} is in the past`, key };
    if (until > mtimeMs + SWITCH_MAX_MS) return { invalid: `${value} is more than 24 h after the file was written`, key };
    return { until, key };
  };

  const fail = (phase: string, error: unknown) => {
    disabled = true;
    const current = recording;
    recording = null;
    if (current) {
      if (current.timer !== null) cancelAfter(current.timer);
      disconnect(current.session);
    }
    once("disabled", `profiler disabled until reload: ${phase} failed (${error instanceof Error ? error.message : error})`);
  };

  const prune = async () => {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".cpuprofile")).sort();
    const sizes = await Promise.all(names.map((name) => stat(join(directory, name)).then((info) => info.size, () => 0)));
    let total = sizes.reduce((sum, size) => sum + size, 0);
    let count = names.length;
    for (let index = 0; index < names.length && (count > maxFiles || total > maxBytes); index++) {
      await unlink(join(directory, names[index] as string)).catch(() => undefined);
      count--;
      total -= sizes[index] ?? 0;
    }
  };

  const scheduleChunkEnd = (current: Recording) => {
    current.timer = unref(after(() => enqueue(endChunk), Math.max(0, Math.min(CHUNK_MS, current.until - wallNow()))));
  };

  // Ends the running chunk: keeps it under the stall rule, then starts the next one while the
  // switch still allows it, or ends the recording. A stop() during any await has already
  // disconnected the session; the chunk then ends here without touching it again.
  const endChunk = async (): Promise<void> => {
    const current = recording;
    if (!current) return;
    if (current.timer !== null) cancelAfter(current.timer);
    current.timer = null;
    // A stall that delayed this very callback has not reached the monitor yet.
    const stalled = Math.max(current.chunkStall, now() - lastTick);
    let profile: object | undefined;
    try {
      profile = ((await post(current.session, "Profiler.stop")) as { profile?: object } | undefined)?.profile;
    } catch (error) {
      if (recording === current) fail("Profiler.stop", error);
      return;
    }
    if (stalled >= PROFILE_STALL_MS && profile) {
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${iso(current.chunkStartedAt).replace(/:/g, "-")}.cpuprofile`), JSON.stringify(profile));
        await prune();
      } catch (error) {
        if (recording === current) fail("writing the profile", error);
        return;
      }
    }
    const next = await readSwitch();
    if (recording !== current) return;
    if (!next || "invalid" in next) {
      recording = null;
      disconnect(current.session);
      // The switch this recording ran on is not reported again as ignored once it has expired.
      reported.add(current.key);
      if (next) reported.add(next.key);
      log(`profiler stopped (${!next ? "switch removed" : current.until <= wallNow() ? "switch expired" : `switch ignored: ${next.invalid}`})`);
      return;
    }
    current.until = next.until;
    current.key = next.key;
    try {
      await post(current.session, "Profiler.start");
    } catch (error) {
      if (recording === current) fail("Profiler.start", error);
      return;
    }
    if (recording !== current) return;
    current.chunkStall = 0;
    current.chunkStartedAt = wallNow();
    scheduleChunkEnd(current);
  };

  const pollSwitch = async (): Promise<void> => {
    if (disabled || stopped) return;
    if (recording) {
      // Only a removed or no longer valid switch ends the chunk early; a valid one runs on.
      const read = await readSwitch();
      if (!read || "invalid" in read) await endChunk();
      return;
    }
    const read = await readSwitch();
    if (!read) return;
    if ("invalid" in read) { once(read.key, `profiler switch ignored: ${read.invalid}`); return; }
    let session: InspectorSessionLike | null = null;
    try {
      session = createSession();
      session.connect();
      await post(session, "Profiler.enable");
      await post(session, "Profiler.start");
    } catch (error) {
      if (session) disconnect(session);
      fail("Profiler.start", error);
      return;
    }
    if (stopped) { disconnect(session); return; }
    const current: Recording = { session, until: read.until, key: read.key, chunkStall: 0, chunkStartedAt: wallNow(), timer: null };
    recording = current;
    log(`profiler recording until ${iso(read.until)}`);
    scheduleChunkEnd(current);
  };
  const switchTimer = unref(every(() => enqueue(pollSwitch), SWITCH_POLL_MS));
  enqueue(pollSwitch);

  const probe: LoadProbe = {
    time,
    step,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelEvery(tick);
      cancelEvery(summary);
      cancelEvery(switchTimer);
      try { delay?.disable(); } catch { /* histogram unavailable */ }
      const current = recording;
      recording = null;
      if (current) {
        if (current.timer !== null) cancelAfter(current.timer);
        try { current.session.post("Profiler.stop", {}, () => undefined); } catch { /* disconnecting below */ }
        disconnect(current.session);
      }
      if (active === probe) active = null;
    },
    idle: async () => { let seen: Promise<void>; do { seen = queue; await seen; } while (seen !== queue); },
  };
  active = probe;
  return probe;
}
