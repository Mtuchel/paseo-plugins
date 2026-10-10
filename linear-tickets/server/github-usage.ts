import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { accountOf, appendUsage, meteredArgs, meterShape, METER_ENV, responseOf, splitIncluded, usageDir, withoutDir, type AccountBasis, type UsageResponse } from "../shared/gh-meter-core.mjs";
import { githubCli, githubRouted } from "./github-cli";
import { currentCallerName } from "./linear-usage";
import { paseoHome } from "./ticket-mcp";

const exec = promisify(execFile);

// README "GitHub usage": every GitHub call the plugin makes (ghJson, in-process) or starts (the
// repo scripts, through the gh-meter wrapper) is recorded by caller in a day file, so a report
// (scripts/github-usage-report.mjs) can tell what spends the bot account's budget.
export const RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const METER_SCRIPT = fileURLToPath(new URL("../scripts/gh-meter.mjs", import.meta.url));

// The poll or backstop run a call belongs to, with its size (how much work it covered), so cost
// per unit of work can be compared across days.
type Run = { id: string; caller: string; size: Record<string, number> };

export type MeteredOutput = { stdout: string; stderr: string; headers: ReadonlyMap<string, string> | null };

export function nodeBinary(): string {
  if (basename(process.execPath) === "node") return process.execPath;
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) if (existsSync(candidate)) return candidate;
  return "node";
}

export class GitHubUsage {
  private readonly runs = new AsyncLocalStorage<Run>();
  private pruneTimer: NodeJS.Timeout | null = null;
  private resolved: { target: string; basis: AccountBasis } | null = null;

  constructor(private readonly options: {
    dir?: string;
    meterDir?: string;
    host?: string;
    cli?: () => string;
    routed?: () => boolean;
    now?: () => number;
  } = {}) {}

  get dir(): string {
    return this.options.dir ?? usageDir();
  }

  // The wrapper's directory; queue-backstop.ts puts it first on the scripts' PATH.
  get meterDir(): string {
    return this.options.meterDir ?? join(paseoHome(), "linear-tickets", "gh-meter");
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  // The absolute gh behind the meter and how a call's account is known: the account router owns
  // the routing where it is installed; the gh guard (TUC-263) where `gh` is it; neither otherwise.
  private route(): { target: string; basis: AccountBasis } {
    if (this.resolved) return this.resolved;
    const cli = (this.options.cli ?? githubCli)();
    let target = cli;
    if (!isAbsolute(cli)) {
      for (const dir of withoutDir(process.env.PATH, this.meterDir).split(":")) {
        try {
          accessSync(join(dir, cli), constants.X_OK);
          target = join(dir, cli);
          break;
        } catch {}
      }
    }
    let resolvedTarget = target;
    try { resolvedTarget = realpathSync(target); } catch {}
    const basis: AccountBasis = (this.options.routed ?? githubRouted)() ? "router" : basename(resolvedTarget) === "gh-agent-guard" ? "guard rule" : "none";
    this.resolved = { target, basis };
    return this.resolved;
  }

  // Runs one in-process gh call (ghJson). Same contract as execFile: resolves with stdout and
  // stderr, rejects with execFile's error; stdout (also on the error) is what gh printed without
  // the meter's `--include`. `headers`: the response's headers when the meter read them.
  async exec(cli: string, args: string[], options: { timeout: number; maxBuffer: number }): Promise<MeteredOutput> {
    const shape = meterShape(args);
    if (shape.local) {
      const { stdout, stderr } = await exec(cli, args, options);
      return { stdout, stderr, headers: null };
    }
    const call = randomBytes(6).toString("hex");
    const startedAt = this.now();
    const { basis } = this.route();
    const reading = shape.mode !== "untouched";
    const finish = (stdout: string, stderr: string, exit: number | string | null) => {
      const split = reading ? splitIncluded(stdout) : { block: null, body: stdout };
      const responses: UsageResponse[] = split.block ? [responseOf(split.block, { cachePossible: shape.cache || basis === "router", startedAt, text: `${split.body.slice(0, 2048)}\n${stderr}` })] : [];
      appendUsage(this.dir, {
        at: new Date(startedAt).toISOString(),
        host: this.options.host ?? hostname(),
        call,
        caller: currentCallerName() ?? `op:${shape.command}`,
        run: this.runs.getStore()?.id ?? null,
        command: shape.command,
        method: shape.method,
        write: shape.write,
        responses,
        pages: reading ? responses.length : "unknown",
        ...accountOf(basis, shape),
        exit,
      });
      return { stdout: shape.mode === "include" ? split.body : stdout, headers: split.block?.headers ?? null };
    };
    try {
      const { stdout, stderr } = await exec(cli, meteredArgs(args, shape), { ...options, env: { ...process.env, [METER_ENV.call]: call } });
      return { ...finish(stdout, stderr, 0), stderr };
    } catch (error) {
      const found = error && typeof error === "object" ? error as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown } : {};
      const code = typeof found.code === "number" || typeof found.code === "string" ? found.code : null;
      const signal = typeof found.signal === "string" ? found.signal : null;
      const { stdout, headers } = finish(typeof found.stdout === "string" ? found.stdout : "", typeof found.stderr === "string" ? found.stderr : "", signal ?? code);
      if (error && typeof error === "object") Object.assign(error, { stdout, headers });
      throw error;
    }
  }

  // A poll or backstop run: its calls carry its id, and one `run` line records its size.
  run<T>(caller: string, work: () => Promise<T>): Promise<T> {
    const run: Run = { id: `${caller}@${new Date(this.now()).toISOString()}`, caller, size: {} };
    return this.runs.run(run, async () => {
      try {
        return await work();
      } finally {
        appendUsage(this.dir, { kind: "run", at: new Date(this.now()).toISOString(), host: this.options.host ?? hostname(), run: run.id, caller, size: run.size });
      }
    });
  }

  // Adds to the current run's size (`watched` pull requests, `actions`, `repos`, `candidates`).
  size(field: string, count: number): void {
    const run = this.runs.getStore();
    if (run) run.size[field] = (run.size[field] ?? 0) + count;
  }

  // The environment a repo script runs with: its gh calls go through the meter (runNodeScript
  // checks the wrapper first) and are recorded as `<caller>: <script>` in the current run.
  scriptEnv(script: string): Record<string, string> {
    const { target, basis } = this.route();
    const run = this.runs.getStore();
    return {
      [METER_ENV.caller]: `${currentCallerName() ?? "unknown"}: ${basename(script)}`,
      ...(run ? { [METER_ENV.run]: run.id } : {}),
      [METER_ENV.next]: target,
      [METER_ENV.meterDir]: this.meterDir,
      [METER_ENV.basis]: basis,
      [METER_ENV.dir]: this.dir,
    };
  }

  private wrapper(): string {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return `#!/bin/sh\n# Written by the linear-tickets plugin (README, "GitHub usage").\nexec ${quote(nodeBinary())} ${quote(METER_SCRIPT)} "$@"\n`;
  }

  private installed = false;

  // Writes the wrapper `<meterDir>/gh`; checked before each script start, rewritten when gone.
  install(): void {
    const path = join(this.meterDir, "gh");
    if (this.installed && existsSync(path)) return;
    mkdirSync(this.meterDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, this.wrapper(), { mode: 0o755 });
    this.installed = true;
  }

  // Day files older than RETENTION_DAYS go.
  async prune(): Promise<void> {
    const cutoff = new Date(this.now() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
    let names: string[];
    try { names = await readdir(this.dir); } catch { return; }
    for (const name of names) {
      const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (day && day < cutoff) await rm(join(this.dir, name), { force: true });
    }
  }

  start(): void {
    try {
      this.install();
    } catch (error) {
      console.error(`[linear-tickets] GitHub usage meter: the gh wrapper could not be written: ${error instanceof Error ? error.message : error}`);
    }
    void this.prune();
    this.pruneTimer ??= setInterval(() => { void this.prune(); }, DAY_MS);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.pruneTimer ?? undefined);
    this.pruneTimer = null;
  }
}

export const githubUsage = new GitHubUsage();
