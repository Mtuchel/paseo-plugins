import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Runs the planning smoke check (scripts/planning-smoke.mjs, README "Planning smoke check") on
// this host in its `--if-changed` mode: shortly after the plugin starts, then every 15 minutes,
// one run at a time, as a child process with a hard timeout. The script itself decides whether
// anything changed since the stored result and throttles retries of a failure; a skipped run
// prints nothing and is not logged.
const FIRST_RUN_MS = 2 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;
// The script waits at most 3 minutes for omp's reply plus a few seconds per extension.
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 10_000;
const OUTPUT_BYTES = 16 * 1024;

export type SmokeRun = { code: number | null; timedOut: boolean; stdout: string; stderr: string };
export type SmokeRunner = (script: string, signal: AbortSignal) => Promise<SmokeRun>;

// The plugin runs as a bundle evaluated from memory, so it does not know its own directory. The
// checkout is found through the plan-first extension's link into omp (README, "The omp
// extension"), the same checkout whose plan-first code the agents run.
export function locateSmokeScript(home = homedir()): string | null {
  try {
    return join(dirname(dirname(realpathSync(join(home, ".omp", "agent", "extensions", "linear-tickets-plan-first.ts")))), "scripts", "planning-smoke.mjs");
  } catch {
    return null;
  }
}

// Executor form: the plugin's TypeScript lib predates Promise.withResolvers.
export const runSmokeScript: SmokeRunner = (script, signal) => new Promise((resolve) => {
  // The daemon's own Node runtime (Electron as Node inside the desktop app).
  const env = { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
  const child = spawn(process.execPath, [script, "--if-changed"], { cwd: dirname(dirname(script)), env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let killer: NodeJS.Timeout | undefined;
  // SIGTERM lets the script stop omp and remove its temporary files; SIGKILL if it does not exit.
  const stop = () => {
    if (killer) return;
    child.kill("SIGTERM");
    killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    killer.unref?.();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, RUN_TIMEOUT_MS);
  timer.unref?.();
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_BYTES) stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < OUTPUT_BYTES) stderr += chunk.toString("utf8"); });
  const done = (code: number | null) => {
    clearTimeout(timer);
    clearTimeout(killer);
    signal.removeEventListener("abort", stop);
    resolve({ code, timedOut, stdout, stderr });
  };
  child.on("error", (error) => { stderr += error.message; done(null); });
  child.on("close", (code) => done(code));
});

export class PlanningSmoke {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private reportedMissing = false;

  constructor(private readonly deps: {
    locate?: () => string | null;
    run?: SmokeRunner;
    // Off under `node --test`: the plugin's own tests load the whole plugin.
    enabled?: boolean;
  } = {}) {}

  start(): void {
    if (this.timer || this.stopped || !(this.deps.enabled ?? !process.env.NODE_TEST_CONTEXT)) return;
    this.schedule(FIRST_RUN_MS);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.tick(); }, ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    await this.runOnce();
    if (!this.stopped) this.schedule(INTERVAL_MS);
  }

  // One run; a call while one is under way waits for that run instead of starting another.
  runOnce(): Promise<void> {
    this.running ??= this.check().finally(() => { this.running = null; });
    return this.running;
  }

  private async check(): Promise<void> {
    const script = (this.deps.locate ?? locateSmokeScript)();
    if (!script) {
      if (!this.reportedMissing) console.error("[linear-tickets] planning smoke check skipped: the plan-first omp extension is not linked into ~/.omp/agent/extensions");
      this.reportedMissing = true;
      return;
    }
    this.reportedMissing = false;
    this.controller = new AbortController();
    try {
      const run = await (this.deps.run ?? runSmokeScript)(script, this.controller.signal);
      if (this.stopped) return;
      const output = run.stdout.trim();
      if (run.timedOut) console.error(`[linear-tickets] planning smoke check stopped after ${RUN_TIMEOUT_MS / 60_000} minutes without finishing`);
      else if (run.code === 0) { if (output) console.log(`[linear-tickets] ${output}`); }
      else if (run.code === 1 && output) console.error(`[linear-tickets] ${output}`);
      else console.error(`[linear-tickets] planning smoke check could not run (exit ${run.code ?? "signal"}): ${(run.stderr.trim() || output).split("\n")[0]}`);
    } catch (error) {
      console.error(`[linear-tickets] planning smoke check could not run: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.controller = null;
    }
  }
}
