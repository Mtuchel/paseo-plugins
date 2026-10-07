#!/usr/bin/env node
// Planning smoke check (README, "Planning smoke check"): does a fresh ticket agent on this host
// still start planning with Plannotator's planning instructions (the "framing")?
//
// - framing / launch: runs omp in rpc-ui mode as a fake ticket agent (LINEAR_TICKETS_PLAN=required,
//   no ticket, nothing touches Linear) in a temporary git repository, sends one prompt, waits for
//   `agent_end` and reads the session file: the plan-first launch marker must be there and a
//   `plannotator-framing` message must precede the first assistant message.
// - system-prompt-hook: no configured omp extension may return `systemPrompt` from
//   `before_agent_start` (see probeExtension for why).
//
// The result goes to $PASEO_HOME/linear-tickets/planning-smoke.json (read by the ops digest):
//   {"version":1,"checkedAt":…,"fingerprint":…,"ok":…,"failures":[{"check":…,"detail":…}]}
// `fingerprint` hashes what decides the outcome (omp version, omp plugins, omp config and
// extensions, Plannotator's config); `--if-changed` runs only when it differs from the stored
// result's, and retries a failed result for the same fingerprint at most hourly.
//
//   npm run smoke:planning [-- --if-changed] [-- --omp <binary>] [-- --omp-config <config.yml>]
//                          [-- --omp-extensions <directory>]
// `--omp-config` / `--omp-extensions` replace omp's config and extensions directory for the hook
// check and the fingerprint only; the omp run always uses omp's own configuration.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// DeepSeek model policy: Flash only, never any DeepSeek Pro.
export const SMOKE_MODEL = "deepseek/deepseek-flash";
export const SMOKE_PROMPT = "Reply OK. Do not use tools.";
export const AGENT_END_TIMEOUT_MS = 180_000;
// A failed result is retried for the same fingerprint at most this often.
export const RETRY_FAILED_MS = 60 * 60 * 1000;
export const LAUNCH_MARKER = "linear-tickets.plan-first";
export const FRAMING = "plannotator-framing";
const KILL_GRACE_MS = 5_000;
const PROBE_TIMEOUT_MS = 30_000;
const HANDLER_TIMEOUT_MS = 5_000;
const PROBE_LINE = "PLANNING_SMOKE_PROBE ";
const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const TYPESCRIPT = new Set([".ts", ".mts", ".cts"]);
// The model a probe's ctx reports: not DeepSeek, so model-policy hooks take their normal path.
const PROBE_MODEL = { provider: "anthropic", id: "claude-opus-5-5" };

const expandHome = (value, home) => value.replace(/^~(?=\/|$)/, home);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const firstLine = (error) => String(error instanceof Error ? error.message : error).split("\n")[0].slice(0, 160);

export function smokePaths({ home = homedir(), env = process.env, ompConfig, ompExtensions } = {}) {
  const paseoHome = env.PASEO_HOME ? expandHome(env.PASEO_HOME, home) : join(home, ".paseo");
  const piAgent = env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR, home) : join(home, ".pi", "agent");
  const omp = join(home, ".omp");
  return {
    home,
    result: join(paseoHome, "linear-tickets", "planning-smoke.json"),
    config: ompConfig ? resolve(ompConfig) : join(omp, "agent", "config.yml"),
    extensions: ompExtensions ? resolve(ompExtensions) : join(omp, "agent", "extensions"),
    pluginsLock: join(omp, "plugins", "omp-plugins.lock.json"),
    plannotatorPackage: join(omp, "plugins", "node_modules", "@plannotator", "pi-extension", "package.json"),
    plannotatorConfig: join(piAgent, "plannotator.json"),
  };
}

// The `extensions:` list of omp's config.yml: block items (`- path`) or one flow list
// (`[a, b]`). Not a YAML parser: enough for the list omp documents. `~` is the home directory;
// a relative path is taken relative to the config file.
export function configuredExtensions(text, configPath, home = homedir()) {
  const unquote = (value) => {
    const trimmed = value.trim();
    if (/^(["']).*\1$/.test(trimmed)) return trimmed.slice(1, -1);
    return trimmed.replace(/\s+#.*$/, "").trim();
  };
  const paths = [];
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inList) {
      const key = /^extensions:\s*(.*?)\s*$/.exec(line);
      if (!key) continue;
      const rest = key[1].replace(/^#.*$/, "");
      if (rest.startsWith("[")) {
        for (const item of rest.replace(/^\[|\].*$/g, "").split(",")) if (unquote(item)) paths.push(unquote(item));
        break;
      }
      inList = true;
      continue;
    }
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break;
    if (unquote(item[1])) paths.push(unquote(item[1]));
  }
  return paths.map((path) => resolve(dirname(configPath), expandHome(path, home)));
}

async function readOrNull(path) {
  try { return await readFile(path); } catch { return null; }
}

// Every top-level entry of the extensions directory, symlinks resolved: a file as itself, a
// directory as its index module. `module`: whether it is something omp loads as an extension.
async function directoryEntries(directory) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => !name.startsWith(".")).sort();
  const entries = [];
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) entries.push({ name, path, module: MODULE_EXTENSIONS.has(extname(name)) });
    else if (info?.isDirectory()) {
      for (const index of ["index.ts", "index.mts", "index.js", "index.mjs"]) {
        if ((await stat(join(path, index)).catch(() => null))?.isFile()) { entries.push({ name: `${name}/${index}`, path: join(path, index), module: true }); break; }
      }
    } else entries.push({ name, path, module: false });
  }
  return entries;
}

export async function extensionInputs(paths) {
  const config = await readOrNull(paths.config);
  const configured = config ? configuredExtensions(config.toString("utf8"), paths.config, paths.home) : [];
  const directory = await directoryEntries(paths.extensions);
  const seen = new Set();
  const modules = [];
  for (const path of [...configured, ...directory.filter((entry) => entry.module).map((entry) => entry.path)]) {
    let real = path;
    try { real = realpathSync(path); } catch { /* missing: reported by the hook check */ }
    if (seen.has(real)) continue;
    seen.add(real);
    modules.push(path);
  }
  return { config, configured, directory, modules };
}

// sha256 over every input that decides the outcome; a missing input hashes as absent.
export async function fingerprint(paths, ompVersion, inputs) {
  const parts = [];
  const add = (name, content) => parts.push([name, content === null || content === undefined ? null : sha256(content)]);
  add("omp --version", ompVersion);
  add("omp plugins lock", await readOrNull(paths.pluginsLock));
  const plannotator = await readOrNull(paths.plannotatorPackage);
  let plannotatorVersion = null;
  try { plannotatorVersion = plannotator ? String(JSON.parse(plannotator.toString("utf8")).version ?? "") : null; } catch { plannotatorVersion = "unreadable"; }
  add("plannotator version", plannotatorVersion);
  add("omp config", inputs.config);
  for (const path of inputs.configured) add(`extension ${path}`, await readOrNull(path));
  for (const entry of inputs.directory) add(`extensions/${entry.name}`, await readOrNull(entry.path));
  add("plannotator config", await readOrNull(paths.plannotatorConfig));
  return sha256(JSON.stringify(parts));
}

// `--if-changed`: run when nothing is stored, the fingerprint changed, or a failed result for this
// fingerprint is at least RETRY_FAILED_MS old.
export function shouldRun(stored, current, now = Date.now()) {
  if (!stored || stored.version !== 1 || stored.fingerprint !== current) return true;
  if (stored.ok === true) return false;
  const at = Date.parse(stored.checkedAt);
  return !Number.isFinite(at) || at > now || now - at >= RETRY_FAILED_MS;
}

export async function readStored(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function writeResult(path, result) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

// The session file's verdict: null when planning started with the framing, else a failure.
export function sessionVerdict(text) {
  let launched = false;
  let framed = false;
  let replied = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "custom" && entry.customType === LAUNCH_MARKER && entry.data?.reason === "launch") launched = true;
    else if (entry?.type === "custom_message" && entry.customType === FRAMING) framed = true;
    else if (entry?.type === "message" && entry.message?.role === "assistant") { replied = true; break; }
  }
  if (!launched) return { check: "launch", detail: "planning not entered (no plan-first launch marker)" };
  if (!replied) return { check: "launch", detail: "no assistant reply" };
  if (!framed) return { check: "framing", detail: "Plannotator planning framing missing before the first reply" };
  return null;
}

async function executable(path) {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}

// Daemons often lack the login shell's PATH (omp lives in ~/.local/bin or Homebrew).
function toolPath(home, env = process.env) {
  return [env.PATH ?? "", join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(delimiter);
}

export async function findOmp(home = homedir(), env = process.env) {
  for (const directory of toolPath(home, env).split(delimiter)) {
    if (directory && await executable(join(directory, "omp"))) return join(directory, "omp");
  }
  return null;
}

function run(file, args, options) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => resolvePromise(error ? null : String(stdout).trim()));
  });
}

// Cleanups for the signal handler: a SIGTERM (the plugin's hard timeout or a reload) still
// kills omp's process group and removes the temporary directory.
const cleanups = new Set();

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

// Runs omp as a fresh ticket agent and judges its session file. Returns null (passed) or the
// failure, plus the run's duration.
export async function runSmoke(omp, { home = homedir(), timeoutMs = AGENT_END_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "planning-smoke-"));
  let child = null;
  const cleanup = () => {
    if (child && child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  };
  cleanups.add(cleanup);
  try {
    const repo = join(directory, "repo");
    const sessions = join(directory, "sessions");
    await mkdir(repo);
    if (await run("git", ["init", "-q"], { cwd: repo, env: { ...process.env, PATH: toolPath(home) } }) === null) {
      return { failure: { check: "launch", detail: "git init failed" }, seconds: (Date.now() - started) / 1000 };
    }
    const env = { ...process.env, PATH: toolPath(home), LINEAR_TICKETS_PLAN: "required", PASEO_AGENT_ID: `planning-smoke-${randomUUID()}`, PASEO_HOME: join(directory, "paseo") };
    for (const key of ["LINEAR_TICKETS_ISSUE", "LINEAR_TICKETS_MCP", "LINEAR_TICKETS_CONTEXT", "PLANNOTATOR_BROWSER", "ELECTRON_RUN_AS_NODE"]) delete env[key];
    const outcome = await new Promise((resolvePromise) => {
      let settled = false;
      const settle = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value); } };
      const timer = setTimeout(() => settle({ ended: false, detail: `no agent_end within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
      child = spawn(omp, ["--mode", "rpc-ui", "--approval-mode", "yolo", "--model", SMOKE_MODEL, "--session-dir", sessions], { cwd: repo, env, stdio: ["pipe", "pipe", "ignore"], detached: true });
      child.on("error", () => settle({ ended: false, detail: "omp could not be started" }));
      child.on("exit", (code, signal) => settle({ ended: false, detail: `omp exited (${signal ?? `code ${code}`}) before agent_end` }));
      child.stdin.on("error", () => {});
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        if (!line.startsWith("{")) return;
        try { if (JSON.parse(line).type === "agent_end") settle({ ended: true }); } catch { /* not a frame */ }
      });
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: SMOKE_PROMPT })}\n`);
    });
    await stopChild(child);
    const files = (await readdir(sessions).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort();
    const verdict = files.length ? sessionVerdict(await readFile(join(sessions, files[0]), "utf8")) : { check: "launch", detail: "no session file" };
    // A missing framing is the more specific finding even when the run itself went wrong.
    const failure = verdict?.check === "framing" || outcome.ended ? verdict : { check: "launch", detail: outcome.detail };
    return { failure, seconds: (Date.now() - started) / 1000 };
  } finally {
    cleanups.delete(cleanup);
    if (child) await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

function tsxLoader() {
  try { return import.meta.resolve("tsx"); } catch { return null; }
}

// Why this check: omp 18.7 re-runs every extension's before_agent_start handler when one of them
// returns `systemPrompt` and the base system prompt changed meanwhile (xd:// mounts at startup),
// and drops the messages the first round produced. Plannotator delivers its planning framing as
// such a message once (it then sets `framingDelivered`), so the re-run lost it and planners
// worked without it (2026-10-07). Each extension is loaded in its own child process against a
// stub `pi` that records `on(event, handler)`; session_start handlers run first (as in omp), then
// every before_agent_start handler is called with a stub event and ctx. An extension that cannot
// be loaded or invoked under the stub is reported as not checked, not as a failure.
export async function checkHooks(modules, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const loader = tsxLoader();
  const script = fileURLToPath(import.meta.url);
  const report = { checked: [], flagged: [], notChecked: [] };
  const sandbox = await mkdtemp(join(tmpdir(), "planning-smoke-hooks-"));
  const cleanup = () => rmSync(sandbox, { recursive: true, force: true });
  cleanups.add(cleanup);
  try {
    // A private HOME and PASEO_HOME: extensions that report to local apps or write state find
    // nothing of the real ones. No LINEAR_TICKETS_PLAN, so plan-first does not ask Plannotator.
    const env = { PATH: process.env.PATH ?? "", HOME: sandbox, PASEO_HOME: join(sandbox, ".paseo"), XDG_RUNTIME_DIR: sandbox, PASEO_AGENT_ID: "planning-smoke-hook-check" };
    for (const key of ["TMPDIR", "LANG", "ELECTRON_RUN_AS_NODE"]) if (process.env[key]) env[key] = process.env[key];
    for (const path of modules) {
      if (!(await stat(path).catch(() => null))?.isFile()) { report.notChecked.push({ path, reason: "file not found" }); continue; }
      if (TYPESCRIPT.has(extname(path)) && !loader) { report.notChecked.push({ path, reason: "no TypeScript loader (tsx) next to this script" }); continue; }
      const args = [...(TYPESCRIPT.has(extname(path)) ? ["--import", loader] : []), script, "--probe", path];
      const outcome = await probeChild(process.execPath, args, { cwd: sandbox, env, timeoutMs });
      if (outcome.status !== "ok") report.notChecked.push({ path, reason: outcome.reason });
      else if (outcome.systemPrompt) report.flagged.push(path);
      else if (outcome.failed) report.notChecked.push({ path, reason: `${outcome.failed} before_agent_start handler(s) failed under the stub: ${outcome.reason}` });
      else report.checked.push(path);
    }
  } finally {
    cleanups.delete(cleanup);
    await rm(sandbox, { recursive: true, force: true });
  }
  return report;
}

function probeChild(file, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    let output = "";
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    cleanups.add(kill);
    const timer = setTimeout(kill, timeoutMs);
    child.stdout.on("data", (chunk) => { if (output.length < 1024 * 1024) output += chunk; });
    child.on("error", () => { clearTimeout(timer); cleanups.delete(kill); resolvePromise({ status: "unloadable", reason: "probe could not start" }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      cleanups.delete(kill);
      const line = output.split("\n").reverse().find((candidate) => candidate.startsWith(PROBE_LINE));
      if (line) {
        try { resolvePromise(JSON.parse(line.slice(PROBE_LINE.length))); return; } catch { /* below */ }
      }
      resolvePromise({ status: "unloadable", reason: signal === "SIGKILL" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `probe exited (${signal ?? `code ${code}`})` });
    });
  });
}

// Any member the stub does not define: callable, chainable, never a thenable, iterable as empty.
const inert = new Proxy(function inert() {}, {
  get: (_target, key) => fallback(key),
  apply: () => inert,
  construct: () => inert,
});

function fallback(key) {
  if (key === "then") return undefined;
  if (key === Symbol.iterator) return function* () {};
  if (key === Symbol.asyncIterator) return async function* () {};
  if (key === Symbol.toPrimitive || key === "toString" || key === "valueOf" || key === "toJSON") return () => "";
  if (typeof key === "symbol") return undefined;
  return inert;
}

function stub(members) {
  return new Proxy(members, { get: (target, key) => (key in target ? target[key] : fallback(key)) });
}

function withTimeout(value) {
  return Promise.race([
    Promise.resolve(value),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`no answer within ${HANDLER_TIMEOUT_MS / 1000} s`)), HANDLER_TIMEOUT_MS).unref()),
  ]);
}

// `--probe <extension>`, in a child process: loads one extension and calls its handlers.
async function probeExtension(path) {
  const answer = (value) => { process.stdout.write(`\n${PROBE_LINE}${JSON.stringify(value)}\n`, () => process.exit(0)); };
  const handlers = new Map();
  const pi = stub({ on: (event, handler) => { if (typeof handler === "function") handlers.set(event, [...(handlers.get(event) ?? []), handler]); } });
  const cwd = process.cwd();
  const ctx = stub({
    cwd,
    hasUI: false,
    model: PROBE_MODEL,
    models: stub({ current: () => PROBE_MODEL, resolve: () => undefined }),
    sessionManager: stub({ getBranch: () => [], getEntries: () => [], getSessionId: () => "planning-smoke-hook-check", getSessionFile: () => undefined, getCwd: () => cwd }),
    isIdle: () => true,
  });
  let factory;
  try {
    const loaded = await import(pathToFileURL(path).href);
    factory = [loaded.default, loaded.default?.default, loaded].find((candidate) => typeof candidate === "function");
  } catch (error) {
    return answer({ status: "unloadable", reason: `import failed: ${firstLine(error)}` });
  }
  if (!factory) return answer({ status: "unloadable", reason: "no default export function" });
  try { await withTimeout(factory(pi)); } catch (error) { return answer({ status: "unloadable", reason: `setup failed: ${firstLine(error)}` }); }
  for (const handler of handlers.get("session_start") ?? []) {
    try { await withTimeout(handler({ type: "session_start" }, ctx)); } catch { /* the before_agent_start call below decides */ }
  }
  let systemPrompt = false;
  let failed = 0;
  let reason = "";
  for (const handler of handlers.get("before_agent_start") ?? []) {
    try {
      const result = await withTimeout(handler({ type: "before_agent_start", prompt: "x", images: [], systemPrompt: "base" }, ctx));
      if (result && typeof result === "object" && result.systemPrompt !== undefined) systemPrompt = true;
    } catch (error) {
      failed += 1;
      reason ||= firstLine(error);
    }
  }
  return answer({ status: "ok", systemPrompt, failed, reason });
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const ifChanged = argv.includes("--if-changed");
  const paths = smokePaths({ ompConfig: option(argv, "--omp-config"), ompExtensions: option(argv, "--omp-extensions") });
  const omp = option(argv, "--omp") ?? await findOmp(paths.home);
  const version = omp ? await run(omp, ["--version"], { env: { ...process.env, PATH: toolPath(paths.home) } }) : null;
  const inputs = await extensionInputs(paths);
  const current = await fingerprint(paths, version, inputs);
  if (ifChanged && !shouldRun(await readStored(paths.result), current)) return 0;

  const hooks = await checkHooks(inputs.modules);
  const smoke = omp ? await runSmoke(omp, { home: paths.home }) : { failure: { check: "launch", detail: "omp not found" }, seconds: 0 };
  const failures = [
    ...(smoke.failure ? [smoke.failure] : []),
    ...hooks.flagged.map((path) => ({ check: "system-prompt-hook", detail: `${basename(path)} returns systemPrompt from before_agent_start` })),
  ];
  const result = { version: 1, checkedAt: new Date().toISOString(), fingerprint: current, ok: failures.length === 0, failures };
  await writeResult(paths.result, result);

  const lines = [`Planning smoke check on ${hostname().replace(/\.local$/, "")}: ${result.ok ? "PASS" : "FAIL"}`];
  lines.push(smoke.failure ? `  FAIL ${smoke.failure.check}: ${smoke.failure.detail}` : `  ok   framing: planning started with Plannotator's framing (${version ?? "omp"}, ${smoke.seconds.toFixed(1)} s)`);
  for (const path of hooks.flagged) lines.push(`  FAIL system-prompt-hook: ${basename(path)} returns systemPrompt from before_agent_start`);
  if (!hooks.flagged.length) lines.push(`  ok   system-prompt-hook: ${hooks.checked.length} extension(s) return no systemPrompt`);
  for (const { path, reason } of hooks.notChecked) lines.push(`  not checked: ${basename(path)} (${reason})`);
  lines.push(`  result: ${paths.result}`);
  console.log(lines.join("\n"));
  return result.ok ? 0 : 1;
}

const invoked = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invoked) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--probe" && argv[1]) {
    await probeExtension(resolve(argv[1]));
  } else {
    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
      process.on(signal, () => {
        for (const cleanup of cleanups) { try { cleanup(); } catch { /* best effort */ } }
        process.exit(code);
      });
    }
    try {
      process.exitCode = await main(argv);
    } catch (error) {
      console.error(`Planning smoke check could not run: ${firstLine(error)}`);
      process.exitCode = 2;
    }
  }
}
