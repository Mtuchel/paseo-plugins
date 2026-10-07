import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { plannotatorPaths } from "./plannotator";
import { PLANNOTATOR_HOST_SOURCE } from "./plannotator-host-source";

// Parked plans (README, "Parked plans"). A plan the risk policy leaves to the owner does not keep
// its agent (a slot and its memory) waiting: the plan is parked here and the agent retired. The
// central Plannotator host serves every parked plan with Plannotator's own review page; the owner's
// decision starts a fresh agent that implements the plan, or plans again with the feedback.

// `announced`: the owner was told (comment, panel question, tab) once; a host restart only rebinds.
export type ParkedPlan = {
  issueId: string;
  identifier: string;
  agentId: string;
  plan: string;
  line: string;
  reasons: string[];
  model: string | null;
  parkedAt: string;
  announced: boolean;
};

export function parkedPaths(home?: string) {
  const plannotator = plannotatorPaths(home);
  const directory = plannotator.directory;
  return {
    parked: join(directory, "parked"),
    script: join(directory, "host.mjs"),
    // The host's heartbeat ({ pid, version, at }), its output, the plugin's own heartbeat, and the
    // port each parked issue is served on.
    state: join(directory, "host.json"),
    log: join(directory, "host.log"),
    alive: join(directory, "plugin.alive"),
    ports: join(directory, "ports.json"),
    events: plannotator.events,
    // The decision journal (decision-journal.ts `decisionsDirectory()`: the same directory under
    // the same home). The host checks it so a plan whose decision is not settled is not served.
    decisions: join(directory, "decisions"),
    open: plannotator.launcher,
  };
}

export class ParkedPlans {
  constructor(private readonly directory = parkedPaths().parked) {}

  private path(issueId: string): string {
    return join(this.directory, `${issueId.replace(/[^0-9A-Za-z-]/g, "")}.json`);
  }

  async all(): Promise<ParkedPlan[]> {
    const names = (await readdir(this.directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && !name.startsWith("."));
    const plans: ParkedPlan[] = [];
    for (const name of names) {
      try { plans.push(JSON.parse(await readFile(join(this.directory, name), "utf8")) as ParkedPlan); } catch { /* half-written or removed meanwhile */ }
    }
    return plans;
  }

  async forAgent(agentId: string): Promise<ParkedPlan | null> {
    return (await this.all()).find((plan) => plan.agentId === agentId) ?? null;
  }

  async put(plan: ParkedPlan): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(plan.issueId);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async remove(issueId: string): Promise<void> {
    await rm(this.path(issueId), { force: true });
  }
}

// Where the host's two prerequisites live; null when either is missing (then plans are not parked
// and their agents wait for the owner as before). The env overrides exist for tests.
export type HostLocation = { bun: string; plannotator: string };
export function locateHost(home = homedir()): HostLocation | null {
  const bun = [process.env.LINEAR_TICKETS_BUN, join(home, ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].find((path): path is string => Boolean(path) && existsSync(path!));
  const plannotator = process.env.LINEAR_TICKETS_PLANNOTATOR_PACKAGE ?? join(home, ".omp", "plugins", "node_modules", "@plannotator", "pi-extension");
  return bun && existsSync(join(plannotator, "server", "serverPlan.ts")) && existsSync(join(plannotator, "plannotator.html")) ? { bun, plannotator } : null;
}

// How often the plugin checks the host, how old its heartbeat may be, and how long a host just
// started gets before it must answer (and before a host that keeps exiting is started again).
export type HostTimings = { monitorMs: number; staleMs: number; startupMs: number };
const TIMINGS: HostTimings = { monitorMs: 5_000, staleMs: 15_000, startupMs: 30_000 };
const STOP_WAIT_MS = 5_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LOG_CHUNK_BYTES = 256 * 1024;

type HostState = { pid: number; version: string; at: string };

// What the running host must match to be kept: its source, Bun, and the Plannotator it serves.
function hostVersion(found: HostLocation): string {
  let plannotatorPackage = "";
  try { plannotatorPackage = readFileSync(join(found.plannotator, "package.json"), "utf8"); } catch { /* versioned by path only */ }
  return createHash("sha256").update(PLANNOTATOR_HOST_SOURCE).update("\0").update(found.bun).update("\0").update(found.plannotator).update("\0").update(plannotatorPackage).digest("hex").slice(0, 16);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// Runs the central Plannotator host (plannotator-host-source.ts) as a detached Bun process that
// outlives plugin reloads: a reload adopts the running host, so review pages stay connected to
// their servers. The host is replaced when its version differs and started again when its
// heartbeat stops; it exits by itself once the plugin has been gone for ten minutes. Its output
// goes to host.log, which the plugin forwards to its own log.
export class PlannotatorHost {
  private stopped = true;
  private monitor: NodeJS.Timeout | null = null;
  private found: HostLocation | null = null;
  private version = "";
  private spawned: { pid: number; at: number } | null = null;
  private live = false;
  private checking: Promise<void> | null = null;
  private logOffset = 0;
  private logRest = "";

  constructor(
    private readonly paths = parkedPaths(),
    private readonly locate: () => HostLocation | null = () => locateHost(),
    private readonly timings: HostTimings = TIMINGS,
  ) {}

  // Whether parked plans are served right now; false keeps agents waiting for the owner.
  available(): boolean {
    return this.live;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const found = this.locate();
    if (!found) { console.error("[linear-tickets] Plannotator host unavailable (needs Bun and omp's @plannotator/pi-extension): plans that need the owner keep their agents waiting"); return; }
    this.found = found;
    this.version = hostVersion(found);
    await mkdir(this.paths.parked, { recursive: true, mode: 0o700 });
    const temporary = `${this.paths.script}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, PLANNOTATOR_HOST_SOURCE, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.paths.script);
    } finally { await rm(temporary, { force: true }); }
    // Output from before this plugin run is not repeated.
    this.logOffset = (await stat(this.paths.log).catch(() => null))?.size ?? 0;
    this.logRest = "";
    await this.check();
    if (this.stopped) return;
    clearInterval(this.monitor ?? undefined);
    this.monitor = setInterval(() => { void this.check(); }, this.timings.monitorMs);
    this.monitor.unref?.();
  }

  // The host keeps running: the next plugin run adopts it, and it exits by itself when none comes.
  stop(): void {
    this.stopped = true;
    clearInterval(this.monitor ?? undefined);
    this.monitor = null;
    this.live = false;
  }

  private check(): Promise<void> {
    return this.checking ??= this.checkOnce()
      .catch((error: unknown) => console.error(`[linear-tickets] checking the Plannotator host failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => { this.checking = null; });
  }

  private async checkOnce(): Promise<void> {
    const found = this.found;
    if (this.stopped || !found) return;
    await writeFile(this.paths.alive, new Date().toISOString(), { mode: 0o600 });
    await this.forwardLog();
    const state = await this.readState();
    const answering = state !== null && Date.now() - Date.parse(state.at) < this.timings.staleMs && processAlive(state.pid);
    if (answering && state.version === this.version) { this.live = true; return; }
    const spawned = this.spawned;
    if (spawned && Date.now() - spawned.at < this.timings.startupMs) {
      // Just started: serving as soon as it runs; one that exited at once is not started in a loop.
      this.live = processAlive(spawned.pid);
      return;
    }
    this.live = false;
    if (answering) console.log(`[linear-tickets] Plannotator host ${state.pid} runs another version; replacing it`);
    else if (state || spawned) console.error("[linear-tickets] Plannotator host stopped answering; starting it again");
    await this.stopHosts();
    if (this.stopped) return;
    this.spawn(found);
  }

  private async readState(): Promise<HostState | null> {
    try {
      const state = JSON.parse(await readFile(this.paths.state, "utf8")) as Partial<HostState>;
      return typeof state.pid === "number" && typeof state.version === "string" && typeof state.at === "string" ? state as HostState : null;
    } catch { return null; }
  }

  private spawn(found: HostLocation): void {
    try {
      if (statSync(this.paths.log).size > LOG_ROTATE_BYTES) renameSync(this.paths.log, `${this.paths.log}.1`);
    } catch { /* no log yet, or it keeps appending */ }
    const out = openSync(this.paths.log, "a", 0o600);
    try {
      const child = spawn(found.bun, [this.paths.script], {
        cwd: this.paths.parked,
        detached: true,
        env: {
          ...process.env,
          LINEAR_TICKETS_PARKED: this.paths.parked,
          LINEAR_TICKETS_PLANNOTATOR_EVENTS: this.paths.events,
          LINEAR_TICKETS_DECISIONS: this.paths.decisions,
          LINEAR_TICKETS_PLANNOTATOR_OPEN: this.paths.open,
          LINEAR_TICKETS_PLANNOTATOR_PACKAGE: found.plannotator,
          LINEAR_TICKETS_PLANNOTATOR_HOST_STATE: this.paths.state,
          LINEAR_TICKETS_PLANNOTATOR_HOST_VERSION: this.version,
          LINEAR_TICKETS_PLANNOTATOR_PORTS: this.paths.ports,
          LINEAR_TICKETS_PLANNOTATOR_PLUGIN_ALIVE: this.paths.alive,
        },
        stdio: ["ignore", out, out],
      });
      child.on("error", (error) => console.error(`[linear-tickets] Plannotator host failed to start: ${error.message}`));
      child.unref();
      this.spawned = child.pid ? { pid: child.pid, at: Date.now() } : null;
      this.live = Boolean(child.pid);
    } finally { closeSync(out); }
  }

  // Every process running this host's script (an older version, one that stopped answering, or a
  // leftover); each gets SIGTERM, then SIGKILL, and is gone before a new host binds its ports.
  private async stopHosts(): Promise<void> {
    let pids: number[] = [];
    try {
      const pattern = this.paths.script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pids = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8", timeout: 5_000 }).split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    } catch { /* none running */ }
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    const deadline = Date.now() + STOP_WAIT_MS;
    while (pids.some(processAlive) && Date.now() < deadline) await sleep(100);
    for (const pid of pids.filter(processAlive)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }

  private async forwardLog(): Promise<void> {
    const handle = await open(this.paths.log, "r").catch(() => null);
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size < this.logOffset) { this.logOffset = 0; this.logRest = ""; }
      if (size === this.logOffset) return;
      const length = Math.min(size - this.logOffset, LOG_CHUNK_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.logOffset);
      this.logOffset += bytesRead;
      const lines = (this.logRest + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      this.logRest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) console.log(`[linear-tickets] Plannotator host: ${line}`);
    } finally { await handle.close(); }
  }
}
