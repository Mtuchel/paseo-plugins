#!/usr/bin/env node
// Rolls a plugin from this checkout out to the Paseo daemon on this host: the only way a host
// pulls, installs and reloads a plugin.
//
//   node tools/plugin-rollout.mjs <plugin-dir> [--force]
//
// One rollout per host at a time (a kernel flock on $PASEO_HOME/plugin-rollout.lock, held by
// tools/flock.py and passed on to every child), within one 15-minute deadline:
//  1. target: the daemon runs the Paseo the build check uses; the plugin is installed from
//     <plugin-dir> and enabled;
//  2. waits until no plugin loaded from this checkout is loading (never pulls during a load);
//  3. resolves the receipt a killed rollout left `pending`;
//  4. classifies the running code: known (the receipt's tree), down (its last load failed) or
//     unknown;
//  5. refuses a dirty checkout, `git pull --ff-only`;
//  6. `npm ci` when the lockfile differs from the last successful install or node_modules is gone;
//  7. Paseo's own plugin build (tools/paseo-build.mjs): a refused build reloads nothing;
//  8. decides: known and unchanged → "already loaded"; changed, down or --force → reload;
//     unknown → exit 2 ("cannot tell which code <id> runs"), rerun with --force to reload;
//  9. reloads once and waits through the CLI's 60 s timeout for "Plugin ready" or
//     "Plugin failed to load", never reloading again.
//
// The running code is the plugin directory's git tree, recorded in a receipt
// ($PASEO_HOME/plugin-rollout/<id>.json) only once Paseo logged "Plugin ready" for this tool's
// load. The rule this relies on: plugins are loaded only by this tool or by a daemon (re)start.
// A Settings reload whose log line has scrolled out of the 500-line plugin log goes unnoticed.
//
// Exit 0: ready or already loaded. 1: failed, refused or gave up (nothing reloaded unless it says
// so). 2: cannot tell which code runs; --force decides.
//
// Overrides (tests): PASEO_BIN (the paseo executable), NPM_BIN, PASEO_SERVER_DIR (see
// paseo-build.mjs), PASEO_HOME, PLUGIN_ROLLOUT_DEADLINE_MS, PLUGIN_ROLLOUT_POLL_MS,
// PLUGIN_ROLLOUT_RELOAD_TIMEOUT_MS.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { locatePaseoServer, pluginId } from "./paseo-build.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
// Paseo keeps the last 500 entries of a plugin's log.
export const LOG_WINDOW = 500;

const MINUTE = 60_000;
const TIMEOUTS = { paseo: 30_000, git: 2 * MINUTE, npm: 10 * MINUTE, build: 5 * MINUTE };

class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function numberSetting(value, fallback) {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function settingsFrom(env) {
  return {
    paseoBin: env.PASEO_BIN || "paseo",
    npmBin: env.NPM_BIN || "npm",
    home: resolve(env.PASEO_HOME || join(homedir(), ".paseo")),
    deadlineMs: numberSetting(env.PLUGIN_ROLLOUT_DEADLINE_MS, 15 * MINUTE),
    pollMs: numberSetting(env.PLUGIN_ROLLOUT_POLL_MS, 10_000),
    reloadTimeoutMs: numberSetting(env.PLUGIN_ROLLOUT_RELOAD_TIMEOUT_MS, 90_000),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the plugin log
// ---------------------------------------------------------------------------------------------

const LIFECYCLE = [
  ["loading", (message) => message === "[paseo] Loading plugin"],
  ["ready", (message) => message === "[paseo] Plugin ready"],
  ["failed", (message) => message.startsWith("[paseo] Plugin failed to load")],
  ["stopping", (message) => message === "[paseo] Stopping plugin"],
  ["stopped", (message) => message === "[paseo] Plugin stopped"],
];

// The daemon's lifecycle lines, oldest first.
export function lifecycle(logs) {
  const events = [];
  for (const entry of logs) {
    if (typeof entry?.message !== "string" || typeof entry.sequence !== "number") continue;
    const match = LIFECYCLE.find(([, test]) => test(entry.message));
    if (match) events.push({ sequence: entry.sequence, kind: match[0], message: entry.message });
  }
  return events.sort((a, b) => a.sequence - b.sequence);
}

function newestLifecycle(logs) {
  return lifecycle(logs).at(-1) ?? null;
}

export function newestSequence(logs) {
  return logs.reduce((newest, entry) => (typeof entry?.sequence === "number" ? Math.max(newest, entry.sequence) : newest), -1);
}

// Neither loading nor in an unknown state: running with no load or stop under way, or down with
// its newest lifecycle line a failed load. `failed` status alone means nothing: Paseo reports it
// for the whole of a reload (TUC-1401).
export function settled(entry, logs) {
  const newest = newestLifecycle(logs);
  if (newest?.kind === "failed") return true;
  return entry.status === "running" && !["loading", "stopping", "stopped"].includes(newest?.kind);
}

// ---------------------------------------------------------------------------------------------
// Receipts: which code this tool last loaded
// ---------------------------------------------------------------------------------------------

const STATES = new Set(["pending", "loaded", "failed"]);

export function parseReceipt(text) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    return null;
  }
  const valid =
    receipt &&
    typeof receipt === "object" &&
    typeof receipt.revision === "string" &&
    typeof receipt.tree === "string" &&
    STATES.has(receipt.state) &&
    typeof receipt.daemonPid === "number" &&
    typeof receipt.daemonStartedAt === "string" &&
    typeof receipt.afterSequence === "number" &&
    (receipt.state === "pending" || typeof receipt.loadSequence === "number");
  return valid ? receipt : null;
}

function readReceipt(file) {
  try {
    return parseReceipt(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomically(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

function sameDaemon(receipt, daemon) {
  return receipt.daemonPid === daemon.pid && receipt.daemonStartedAt === daemon.startedAt;
}

// A `pending` receipt (a rollout died after asking for its reload) becomes `loaded` or `failed`
// when the one load since its request is visible with its outcome; otherwise it stays pending.
export function resolvePending(receipt, daemon, logs) {
  if (receipt?.state !== "pending" || !sameDaemon(receipt, daemon)) return receipt;
  const covered =
    logs.some((entry) => entry.sequence <= receipt.afterSequence) ||
    (receipt.afterSequence < 0 && logs.length < LOG_WINDOW);
  if (!covered) return receipt;
  const events = lifecycle(logs);
  const loads = events.filter((event) => event.kind === "loading" && event.sequence > receipt.afterSequence);
  if (loads.length !== 1) return receipt;
  const outcome = events.find(
    (event) => event.sequence > loads[0].sequence && (event.kind === "ready" || event.kind === "failed"),
  );
  if (!outcome) return receipt;
  return { ...receipt, state: outcome.kind === "ready" ? "loaded" : "failed", loadSequence: loads[0].sequence };
}

// Which code the plugin runs: { kind: "known", tree, revision } | { kind: "down" } |
// { kind: "unknown", reason }.
export function classify(receipt, daemon, entry, logs) {
  if (newestLifecycle(logs)?.kind === "failed") return { kind: "down" };
  const unknown = (reason) => ({ kind: "unknown", reason });
  if (!receipt) return unknown("no receipt from an earlier rollout of it on this host");
  if (!sameDaemon(receipt, daemon)) return unknown("Paseo restarted since its last rollout");
  if (receipt.state === "pending") return unknown("the last rollout's reload has no visible outcome in the plugin log");
  if (receipt.state !== "loaded") return unknown("the last rollout's load failed, and it was loaded since outside this tool");
  if (entry.status !== "running") return unknown(`it is ${entry.status}`);
  const foreign = lifecycle(logs).find((event) => event.kind === "loading" && event.sequence > receipt.loadSequence);
  if (foreign) return unknown(`it was loaded outside this tool (plugin log sequence ${foreign.sequence})`);
  return { kind: "known", tree: receipt.tree, revision: receipt.revision };
}

// { action: "skip" } | { action: "reload", why } | { action: "refuse", reason }.
export function decide(classification, tree, force) {
  if (force) return { action: "reload", why: "--force" };
  if (classification.kind === "known") {
    return classification.tree === tree
      ? { action: "skip" }
      : { action: "reload", why: `its code changed since ${classification.revision.slice(0, 7)} was loaded` };
  }
  if (classification.kind === "down") return { action: "reload", why: "its last load failed" };
  return { action: "refuse", reason: classification.reason };
}

// Waits until every plugin `snapshot()` returns is settled; returns that snapshot.
export async function settle({ snapshot, deadline, pollMs, say, now = Date.now, sleep = delay }) {
  const announced = new Set();
  for (;;) {
    const plugins = await snapshot();
    const busy = plugins.filter(({ entry, logs }) => !settled(entry, logs)).map(({ entry }) => entry.id);
    if (busy.length === 0) return plugins;
    for (const id of busy) {
      if (!announced.has(id)) say(`waiting for the running load of ${id}`);
      announced.add(id);
    }
    const left = deadline - now();
    if (left <= 0) throw new Fail(`${busy.join(", ")} still loading; not changing the checkout or reloading`);
    await sleep(Math.min(pollMs, left));
  }
}

// ---------------------------------------------------------------------------------------------
// Child processes: each gets the lock descriptor, its own process group and a timeout
// ---------------------------------------------------------------------------------------------

function runner(lockFd, deadline, env) {
  const children = new Set();
  const stdio = ["ignore", "pipe", "pipe"];
  if (lockFd !== null) {
    while (stdio.length < lockFd) stdio.push("ignore");
    stdio[lockFd] = lockFd;
  }
  const killGroup = (child) => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  // `bounded: false` (read-only status calls): only the call's own timeout, so the step that hits
  // the deadline can still read the state and say why it stops.
  const run = (command, args, { cwd, timeoutMs, bounded = true }) =>
    new Promise((done) => {
      let child;
      try {
        child = spawn(command, args, { cwd, env, stdio, detached: true });
      } catch (error) {
        done({ code: null, error, stdout: "", stderr: "", timedOut: false });
        return;
      }
      children.add(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(
        () => {
          timedOut = true;
          killGroup(child);
        },
        Math.max(0, bounded ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs),
      );
      child.on("error", (error) => {
        clearTimeout(timer);
        children.delete(child);
        done({ code: null, error, stdout, stderr, timedOut });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        done({ code, signal, stdout, stderr, timedOut });
      });
    });
  const killAll = () => children.forEach(killGroup);
  return { run, killAll };
}

function describeRun(result) {
  if (result.error) return result.error.message;
  if (result.timedOut) return "timed out";
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return `exit ${result.code ?? result.signal}${output ? `: ${output}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// The rollout
// ---------------------------------------------------------------------------------------------

function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function lockfileOf(pluginDir) {
  for (const name of ["npm-shrinkwrap.json", "package-lock.json"]) {
    if (existsSync(join(pluginDir, name))) return join(pluginDir, name);
  }
  return null;
}

async function rollout({ pluginArg, force, lockFd, deadline, env }) {
  const settings = settingsFrom(env);
  const pluginDir = realpathOr(pluginArg);
  const id = pluginId(pluginDir);
  const say = (line) => console.log(`${id}: ${line}`);
  const { run, killAll } = runner(lockFd, deadline, env);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      killAll();
      process.exit(1);
    });
  }

  const paseo = async (args) => {
    const result = await run(settings.paseoBin, args, { timeoutMs: TIMEOUTS.paseo, bounded: false });
    if (result.code !== 0) throw new Fail(`paseo ${args.join(" ")} failed (${describeRun(result)})`);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Fail(`paseo ${args.join(" ")} did not print JSON`);
    }
  };
  const daemonStatus = () => paseo(["daemon", "status", "--json"]);
  const listPlugins = () => paseo(["plugin", "ls", "--json"]);
  const readLogs = async (pluginIdToRead) => {
    const logs = await paseo(["plugin", "logs", pluginIdToRead, "--json"]);
    if (!Array.isArray(logs)) throw new Fail(`paseo plugin logs ${pluginIdToRead} did not print a list`);
    return logs;
  };
  const git = async (args) => {
    const result = await run("git", args, { cwd: pluginDir, timeoutMs: TIMEOUTS.git });
    if (result.code !== 0) throw new Fail(`git ${args.join(" ")} failed (${describeRun(result)})`);
    return result.stdout.trim();
  };

  // 1. Target.
  let server;
  try {
    server = locatePaseoServer(env);
  } catch (error) {
    throw new Fail(`cannot find the Paseo the build check uses: ${error.message}`);
  }
  const daemon = await daemonStatus();
  if (!daemon.daemonVersion || typeof daemon.pid !== "number" || !daemon.startedAt) {
    throw new Fail(`paseo daemon status shows no running daemon (local daemon: ${daemon.localDaemon ?? "unknown"}); nothing done`);
  }
  if (daemon.daemonVersion !== server.version) {
    throw new Fail(`the daemon runs Paseo ${daemon.daemonVersion}, the build check uses ${server.version} (${server.dir}); nothing done`);
  }
  const listed = (await listPlugins()).find((entry) => entry.id === id);
  if (!listed) throw new Fail(`Paseo has no plugin ${id} installed; nothing done`);
  if (realpathOr(listed.path) !== pluginDir) throw new Fail(`Paseo loads ${id} from ${listed.path}, not ${pluginDir}; nothing done`);
  if (!listed.enabled) throw new Fail(`${id} is disabled in Paseo; nothing done`);
  const repoRoot = realpathOr(await git(["rev-parse", "--show-toplevel"]));
  const prefix = await git(["rev-parse", "--show-prefix"]);
  const treeSpec = `HEAD:${prefix.replace(/\/$/, "")}`;

  // 2. Settle every plugin loaded from this checkout, not only this one.
  const fromCheckout = (entry) => {
    const path = realpathOr(entry.path);
    return entry.enabled && (path === repoRoot || path.startsWith(repoRoot + sep));
  };
  const snapshot = async () => {
    const entries = (await listPlugins()).filter(fromCheckout);
    return Promise.all(entries.map(async (entry) => ({ entry, logs: await readLogs(entry.id) })));
  };
  const settleAll = () => settle({ snapshot, deadline, pollMs: settings.pollMs, say });
  let plugins = await settleAll();
  let own = plugins.find(({ entry }) => entry.id === id);
  if (!own) throw new Fail(`${id} disappeared from Paseo's plugin list; nothing done`);

  // 3. Resolve a pending receipt; 4. classify before the pull.
  const stateDir = join(settings.home, "plugin-rollout");
  const receiptFile = join(stateDir, `${id}.json`);
  const current = await daemonStatus();
  const stored = readReceipt(receiptFile);
  const receipt = resolvePending(stored, current, own.logs);
  if (receipt !== stored) writeAtomically(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  const classification = classify(receipt, current, own.entry, own.logs);

  // 5. Checkout. Dirty: any tracked change, or an untracked file inside the plugin directory (the
  // build could pick it up although the tree does not have it). Untracked files elsewhere (planner
  // notes at the root) change neither the pull nor this plugin's code.
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, timeoutMs: TIMEOUTS.git });
  if (status.code !== 0) throw new Fail(`git status failed (${describeRun(status)})`);
  const dirty = status.stdout
    .split("\n")
    .filter((line) => line && (!line.startsWith("?? ") || line.slice(3).replace(/^"/, "").startsWith(prefix)));
  if (dirty.length) throw new Fail(`the checkout ${repoRoot} has local changes; nothing done:\n${dirty.join("\n")}`);
  const before = await git(["rev-parse", "HEAD"]);
  const pull = await run("git", ["pull", "--ff-only"], { cwd: repoRoot, timeoutMs: TIMEOUTS.git });
  if (pull.code !== 0) throw new Fail(`git pull --ff-only failed (${describeRun(pull)}); nothing reloaded`);
  const revision = await git(["rev-parse", "HEAD"]);
  const tree = await git(["rev-parse", treeSpec]);
  say(before === revision ? `checkout at ${revision.slice(0, 7)}` : `pulled ${before.slice(0, 7)}..${revision.slice(0, 7)}`);

  // 6. Dependencies.
  if (existsSync(join(pluginDir, "package.json"))) {
    const lockfile = lockfileOf(pluginDir);
    if (!lockfile) throw new Fail(`${pluginDir} has a package.json but no lockfile; nothing reloaded`);
    const fingerprintFile = join(stateDir, `${id}.install`);
    const wanted = createHash("sha256").update(readFileSync(lockfile)).digest("hex");
    let installed = null;
    try {
      installed = readFileSync(fingerprintFile, "utf8").trim();
    } catch {}
    if (installed !== wanted || !existsSync(join(pluginDir, "node_modules"))) {
      say("npm ci");
      rmSync(fingerprintFile, { force: true });
      const install = await run(settings.npmBin, ["ci"], { cwd: pluginDir, timeoutMs: TIMEOUTS.npm });
      if (install.code !== 0) throw new Fail(`npm ci failed (${describeRun(install)}); nothing reloaded`);
      writeAtomically(fingerprintFile, `${wanted}\n`);
    }
  }

  // 7. Paseo's own plugin build.
  const build = await run(process.execPath, [join(TOOLS, "paseo-build.mjs"), pluginDir], { timeoutMs: TIMEOUTS.build });
  if (build.code !== 0) {
    throw new Fail(`${(build.stderr || build.stdout).trim() || describeRun(build)}\nnot reloading; the running plugin keeps its code`);
  }
  say(build.stdout.trim());

  // 8. Decide.
  const decision = decide(classification, tree, force);
  if (decision.action === "skip") {
    say(`already loaded ${revision.slice(0, 7)}`);
    return 0;
  }
  if (decision.action === "refuse") {
    throw new Fail(`cannot tell which code ${id} runs (${decision.reason}); rerun with --force to reload it`, 2);
  }

  // 9. Reload once, never into a running load.
  plugins = await settleAll();
  own = plugins.find(({ entry }) => entry.id === id);
  if (!own) throw new Fail(`${id} disappeared from Paseo's plugin list; nothing reloaded`);
  const daemonNow = await daemonStatus();
  const afterSequence = newestSequence(own.logs);
  const pending = {
    revision,
    tree,
    state: "pending",
    daemonPid: daemonNow.pid,
    daemonStartedAt: daemonNow.startedAt,
    afterSequence,
  };
  writeAtomically(receiptFile, `${JSON.stringify(pending, null, 2)}\n`);
  say(`reloading ${revision.slice(0, 7)} (${decision.why})`);
  const reload = await run(settings.paseoBin, ["plugin", "reload", id], { timeoutMs: settings.reloadTimeoutMs });
  const cliTimeout = /Timeout waiting for message/.test(`${reload.stdout}\n${reload.stderr}`);
  if (reload.code !== 0 && !cliTimeout) {
    const started = lifecycle(await readLogs(id)).some((event) => event.kind === "loading" && event.sequence > afterSequence);
    if (!started) throw new Fail(`paseo plugin reload ${id} failed (${describeRun(reload)}); no load started`);
  }
  if (cliTimeout) say("the CLI stopped waiting after 60 s; the load goes on, waiting for Plugin ready");
  let loadSequence = null;
  for (;;) {
    const events = lifecycle(await readLogs(id));
    const load = events.find((event) => event.kind === "loading" && event.sequence > afterSequence);
    if (load) {
      loadSequence = load.sequence;
      const outcome = events.find((event) => event.sequence > load.sequence && (event.kind === "ready" || event.kind === "failed"));
      if (outcome) {
        writeAtomically(
          receiptFile,
          `${JSON.stringify({ ...pending, state: outcome.kind === "ready" ? "loaded" : "failed", loadSequence }, null, 2)}\n`,
        );
        if (outcome.kind === "failed") throw new Fail(outcome.message);
        say(`ready ${revision.slice(0, 7)}`);
        return 0;
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Fail(
        `${loadSequence === null ? "no load started" : "the load is still running"} at the deadline; not reloading again (the next rollout waits for it)`,
      );
    }
    await delay(Math.min(settings.pollMs, left));
  }
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { force: false, locked: false, lockFd: null, deadline: null, pluginArg: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--locked") options.locked = true;
    else if (arg === "--lock-fd") options.lockFd = Number(argv[++index]);
    else if (arg === "--deadline") options.deadline = Number(argv[++index]);
    else if (!arg.startsWith("-") && options.pluginArg === null) options.pluginArg = arg;
    else return null;
  }
  if (options.pluginArg === null) return null;
  if (options.locked && !(Number.isInteger(options.lockFd) && options.lockFd > 2 && Number.isFinite(options.deadline))) return null;
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!options) {
    console.error("usage: node tools/plugin-rollout.mjs <plugin-dir> [--force]");
    return 1;
  }
  const env = process.env;
  if (!options.locked) {
    const settings = settingsFrom(env);
    const deadline = Date.now() + settings.deadlineMs;
    const args = [
      join(TOOLS, "flock.py"),
      join(settings.home, "plugin-rollout.lock"),
      String(deadline),
      process.execPath,
      THIS_FILE,
      "--locked",
      "--lock-fd",
      "@LOCKFD@",
      "--deadline",
      String(deadline),
      options.pluginArg,
      ...(options.force ? ["--force"] : []),
    ];
    const child = spawn("python3", args, { stdio: "inherit" });
    return new Promise((done) => {
      child.on("error", (error) => {
        console.error(`cannot take the rollout lock: python3 ${error.message}`);
        done(1);
      });
      child.on("close", (code) => done(code ?? 1));
    });
  }
  try {
    return await rollout({ ...options, env });
  } catch (error) {
    if (error instanceof Fail) {
      console.error(error.message);
      return error.code;
    }
    console.error(error?.stack ?? String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
