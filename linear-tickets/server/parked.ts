import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  return { parked: join(plannotator.directory, "parked"), script: join(plannotator.directory, "host.mjs"), pid: join(plannotator.directory, "host.pid"), events: plannotator.events, open: plannotator.launcher };
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

const RESTART_MS = 30_000;

// Runs the central Plannotator host (plannotator-host-source.ts) as a Bun child of the plugin,
// restarted when it exits. A host left over from an earlier plugin run is stopped first, so two
// hosts never serve the same plans.
export class PlannotatorHost {
  private child: ChildProcess | null = null;
  private stopped = false;
  private restart: NodeJS.Timeout | null = null;

  constructor(private readonly paths = parkedPaths(), private readonly locate: () => HostLocation | null = () => locateHost()) {}

  // Whether parked plans are served right now; false keeps agents waiting for the owner.
  available(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const found = this.locate();
    if (!found) { console.error("[linear-tickets] Plannotator host unavailable (needs Bun and omp's @plannotator/pi-extension): plans that need the owner keep their agents waiting"); return; }
    await mkdir(this.paths.parked, { recursive: true, mode: 0o700 });
    const temporary = `${this.paths.script}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, PLANNOTATOR_HOST_SOURCE, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.paths.script);
    } finally { await rm(temporary, { force: true }); }
    await this.stopStale();
    if (this.stopped) return;
    const child = spawn(found.bun, [this.paths.script], {
      cwd: this.paths.parked,
      env: { ...process.env, LINEAR_TICKETS_PARKED: this.paths.parked, LINEAR_TICKETS_PLANNOTATOR_EVENTS: this.paths.events, LINEAR_TICKETS_PLANNOTATOR_OPEN: this.paths.open, LINEAR_TICKETS_PLANNOTATOR_PACKAGE: found.plannotator },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (data: Buffer) => console.log(`[linear-tickets] Plannotator host: ${data.toString().trim()}`));
    child.stderr?.on("data", (data: Buffer) => console.error(`[linear-tickets] Plannotator host: ${data.toString().trim()}`));
    child.on("error", (error) => console.error(`[linear-tickets] Plannotator host failed to start: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      console.error(`[linear-tickets] Plannotator host exited (${signal ?? code}); restarting in ${RESTART_MS / 1000} s`);
      this.restart = setTimeout(() => { void this.start(); }, RESTART_MS);
      this.restart.unref?.();
    });
    if (child.pid) await writeFile(this.paths.pid, String(child.pid), { mode: 0o600 });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restart ?? undefined);
    this.restart = null;
    this.child?.kill();
    this.child = null;
    void rm(this.paths.pid, { force: true });
  }

  // Only a process still running this host's script is stopped: a recycled pid is left alone.
  private async stopStale(): Promise<void> {
    const pid = Number(await readFile(this.paths.pid, "utf8").catch(() => ""));
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 });
      if (command.includes(this.paths.script)) process.kill(pid);
    } catch { /* not running */ }
  }
}
