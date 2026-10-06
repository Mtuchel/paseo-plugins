#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SELF = fileURLToPath(import.meta.url);
const BOT = "bot112112121";
const TTL = 60_000;
const BOT_RESERVE = 750;
const OWNER_RESERVE = 300;
const LOCK_MS = 8_000;

export function findBinary(command, env = process.env) {
  const home = env.PASEO_HOME || join(homedir(), ".paseo");
  const configured = load(join(home, "github-router", "config.json")).executables?.[command];
  if (configured) {
    accessSync(configured, constants.X_OK);
    return configured;
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      const target = realpathSync(candidate);
      if (target !== realpathSync(SELF) && !["github-router.mjs", "gh-agent-guard"].includes(basename(target))) return candidate;
    } catch {}
  }
  throw new Error(`GitHub router: no real ${command} on PATH`);
}

// Python kernels may lose their agent environment; recover identity from the agent ancestor.
export function caller(env = process.env, pid = process.ppid) {
  if (env.PASEO_AGENT_ID) return { automated: true, agent: env.PASEO_AGENT_ID };
  if (env.PASEO_GITHUB_AUTOMATION === "1") return { automated: true, agent: "plugin" };
  const home = env.PASEO_HOME || join(homedir(), ".paseo");
  let daemon;
  try { daemon = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")).pid; } catch {}
  let inDaemon = false;
  for (let depth = 0; pid > 1 && depth < 24; depth++) {
    if (pid === daemon) { inDaemon = true; break; }
    let info, environment;
    try {
      if (process.platform === "linux") {
        environment = readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", " ");
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        info = { parent: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) };
      } else {
        const ps = spawnSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim();
        if (!ps) break;
        info = { parent: Number(ps.split(/\s+/)[0]) };
        // Only agent ancestors need the expensive environment read. Never log it.
        if (/\b(omp|claude|codex)(?:\s|$|\/)/.test(ps)) {
          environment = spawnSync("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).stdout;
        }
      }
      const agent = environment?.match(/(?:^|\s)PASEO_AGENT_ID=([\w-]+)(?:\s|$)/)?.[1];
      if (agent) return { automated: true, agent };
      if (!info.parent || info.parent === pid) break;
      pid = info.parent;
    } catch { break; }
  }
  return { automated: inDaemon, agent: inDaemon ? "daemon" : null };
}

export function ghOperation(args) {
  const words = [];
  let method = "", fields = false, input = false, query = "", json = "", interval = "", cache = false;
  const valueFlags = new Set(["-R", "--repo", "--hostname", "--jq", "-q", "--template", "-t", "--header", "-H", "--paginate-limit"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.has(a)) { i++; continue; }
    if (a === "--json") { json = args[++i] ?? ""; continue; }
    if (a.startsWith("--json=")) { json = a.slice(7); continue; }
    if (a === "--interval" || (a === "-i" && words[0] !== "api")) { interval = args[++i] ?? ""; continue; }
    if (a.startsWith("--interval=")) { interval = a.slice(11); continue; }
    if (a === "-X" || a === "--method") { method = args[++i] ?? ""; continue; }
    if (a.startsWith("--method=")) { method = a.slice(9); continue; }
    if (a.startsWith("-X") && a !== "-X") { method = a.slice(2); continue; }
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) {
      fields = true;
      const field = args[++i] ?? "";
      if (field.startsWith("query=")) query = field.slice(6);
      continue;
    }
    if (/^(?:-f|-F|--field=|--raw-field=)/.test(a)) {
      fields = true;
      const field = a.replace(/^(?:-f|-F|--field=|--raw-field=)/, "");
      if (field.startsWith("query=")) query = field.slice(6);
      continue;
    }
    if (a === "--input") { input = true; i++; continue; }
    if (a.startsWith("--input=")) { input = true; continue; }
    if (a === "--cache") { cache = true; i++; continue; }
    if (a.startsWith("--cache=")) { cache = true; continue; }
    if (!a.startsWith("-")) words.push(a);
  }
  const [command, action] = words;
  const local = args.includes("--help") || args.includes("--version") || command === "help";
  let read = false, resource = "graphql";
  if (command === "api") {
    resource = action === "graphql" ? "graphql" : "core";
    // Unknown/file/stdin GraphQL documents are writes, never balanced across identities.
    read = action === "graphql"
      ? !input && !query.startsWith("@") && /^(?:\s|#[^\n]*\n)*(?:query\b|\{)/.test(query) && !/\bmutation\b/i.test(query)
      : !input && (!fields || method.toUpperCase() === "GET") && (!method || method.toUpperCase() === "GET");
  } else if (command === "pr") read = ["view", "list", "status", "checks", "diff"].includes(action);
  else if (command === "issue") { read = ["view", "list", "status"].includes(action); resource = "graphql"; }
  else if (command === "repo") read = ["view", "list"].includes(action);
  else if (command === "run") { read = ["view", "list", "watch"].includes(action); resource = "core"; }
  else if (command === "search") { read = true; resource = "search"; }
  // Authentication/token operations pin to bot, including helpers used by child commands.
  return { command, action, read, resource, local, json, interval, cache, words };
}

export function accountEnvironment(account, home, env = process.env) {
  const next = { ...env, GH_CONFIG_DIR: account === "bot" ? join(home, "gh-bot") : join(env.HOME || homedir(), ".config", "gh") };
  delete next.GH_TOKEN;
  delete next.GITHUB_TOKEN;
  delete next.GH_DEBUG;
  next.GH_PROMPT_DISABLED = "1";
  return next;
}

function probe(realGh, account, resource, home, env) {
  const e = accountEnvironment(account, home, env);
  let result;
  if (resource === "graphql") {
    result = spawnSync(realGh, ["api", "graphql", "-f", "query={rateLimit{limit remaining resetAt}}"], { env: e, encoding: "utf8", timeout: 3_000 });
    if (result.status !== 0) throw new Error(`GitHub router: ${account} GraphQL budget probe failed`);
    const budget = JSON.parse(result.stdout).data?.rateLimit;
    if (!budget) throw new Error(`GitHub router: ${account} GraphQL budget unavailable`);
    return { remaining: budget.remaining, resetAt: Date.parse(budget.resetAt), at: Date.now() };
  }
  // /rate_limit can report a different bucket. Use actual authenticated response headers.
  const args = resource === "search" ? ["api", "-i", "search/repositories?q=repo:cli/cli&per_page=1"] : ["api", "-i", "user"];
  result = spawnSync(realGh, args, { env: e, encoding: "utf8", timeout: 3_000 });
  const headers = new Map(result.stdout?.split(/\r?\n/).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  if (result.status !== 0 || !headers.has("x-ratelimit-remaining")) throw new Error(`GitHub router: ${account} REST budget probe failed`);
  const identity = resource === "core" ? JSON.parse(result.stdout.split(/\r?\n\r?\n/).at(-1)).login : undefined;
  if (resource === "core" && account === "bot" && identity !== BOT) throw new Error(`GitHub router: bot credentials do not identify ${BOT}`);
  return { remaining: Number(headers.get("x-ratelimit-remaining")), resetAt: Number(headers.get("x-ratelimit-reset")) * 1000, at: Date.now(), ...(identity ? { identity } : {}) };
}

function load(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } }
function save(path, data) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
}

export function pickRead(budgets, resource, now = Date.now()) {
  const reserve = (account) => resource === "search" ? (account === "bot" ? 5 : 1) : account === "bot" ? BOT_RESERVE : OWNER_RESERVE;
  const candidates = ["bot", "owner"].filter((a) => budgets[a]?.resetAt > now && budgets[a].remaining > reserve(a));
  candidates.sort((a, b) => (budgets[b].remaining - reserve(b)) - (budgets[a].remaining - reserve(a)));
  return candidates[0] ?? null;
}

async function withLock(home, action) {
  const dir = join(home, "github-router");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "admission.lock");
  const until = Date.now() + LOCK_MS;
  while (true) {
    try { mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid)); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(loadText(join(lock, "pid")));
      if (pid) {
        try { process.kill(pid, 0); }
        catch (e) { if (e.code === "ESRCH") { rmSync(lock, { recursive: true, force: true }); continue; } }
      }
      if (Date.now() >= until) throw new Error("GitHub router: budget admission lock timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await action(join(dir, "budgets.json")); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
function loadText(path) { try { return readFileSync(path, "utf8"); } catch { return ""; } }

async function verifyBot(realGh, home, env) {
  await withLock(home, (path) => {
    const state = load(path);
    const core = state.core ??= {};
    if (core.bot?.identity === BOT && Date.now() - core.bot.at < TTL) return;
    core.bot = probe(realGh, "bot", "core", home, env);
    save(path, state);
  });
}

async function readAccount(realGh, operation, home, env, agent) {
  return withLock(home, (path) => {
    const state = load(path), now = Date.now();
    const budgets = state[operation.resource] ?? {};
    for (const account of ["bot", "owner"]) {
      const cached = budgets[account];
      if (cached && now - cached.at < TTL && cached.resetAt > now) continue;
      try { budgets[account] = probe(realGh, account, operation.resource, home, env); }
      catch { budgets[account] = { remaining: 0, resetAt: now + TTL, at: now }; }
    }
    const chosen = pickRead(budgets, operation.resource, now);
    state[operation.resource] = budgets;
    const allowance = state.agents ??= {};
    if (operation.resource === "graphql" && agent && !["daemon", "plugin"].includes(agent)) {
      const hour = Math.floor(now / 3_600_000);
      const entry = allowance[agent];
      const count = entry?.hour === hour ? entry.count : 0;
      if (count >= 60) throw new Error(`GitHub router: agent ${agent.slice(0, 8)} used its 60 GraphQL reads this hour; use REST instead`);
      if (chosen) allowance[agent] = { hour, count: count + 1 };
      for (const id of Object.keys(allowance)) if (allowance[id].hour < hour - 1) delete allowance[id];
    }
    if (chosen) budgets[chosen].remaining--;
    save(path, state);
    if (!chosen) {
      const resume = Math.min(...Object.values(budgets).map((b) => b.resetAt));
      throw new Error(`GitHub read budgets exhausted; bot writes remain reserved. Try after ${new Date(resume).toISOString()}`);
    }
    return chosen;
  });
}

function addGitConfig(env, entries) {
  let count = Number(env.GIT_CONFIG_COUNT || 0);
  for (const [key, value] of entries) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count++}`] = value;
  }
  env.GIT_CONFIG_COUNT = String(count);
}

export function botGitEnvironment(home, realGh, env) {
  const next = accountEnvironment("bot", home, env);
  // Per-process configuration, not global: SSH GitHub URLs cannot use the owner's SSH key.
  addGitConfig(next, [
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["http.https://github.com/.extraHeader", ""],
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", `!${JSON.stringify(realGh)} auth git-credential`],
    ["credential.https://github.com.username", BOT],
  ]);
  next.GIT_TERMINAL_PROMPT = "0";
  return next;
}

function record(home, agent, account, mode, operation) {
  const directory = join(home, "github-router");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // No arguments/bodies/tokens: enough to attribute traffic without collecting secrets.
  appendFileSync(join(directory, "calls.jsonl"), JSON.stringify({ at: new Date().toISOString(), agent, account, command: mode, operation }) + "\n", { mode: 0o600 });
}

export async function route(mode, args, env = process.env) {
  const real = findBinary(mode, env);
  const who = caller(env);
  if (!who.automated) return { real, args, env };
  const home = env.PASEO_HOME || join(homedir(), ".paseo");
  const childEnv = { ...env, PASEO_GITHUB_AUTOMATION: "1", ...(who.agent && !["daemon", "plugin"].includes(who.agent) ? { PASEO_AGENT_ID: who.agent } : {}) };
  const operation = mode === "gh" ? ghOperation(args) : null;
  if (operation?.local) return { real, args, env: childEnv };
  if (!existsSync(join(home, "gh-bot", "hosts.yml"))) throw new Error("GitHub router: bot credentials missing; refusing automation rather than writing as owner");
  if (mode === "gh" && operation.command === "auth" && ["login", "logout", "switch", "setup-git", "refresh"].includes(operation.action)) {
    throw new Error("GitHub router: automated commands cannot modify authentication configuration");
  }
  if (mode === "gh" && !operation.read) await verifyBot(real, home, childEnv);
  if (mode === "git") {
    // Local Git commands do not need credentials. These overrides also cover aliases/submodules.
    return { real, args, env: botGitEnvironment(home, findBinary("gh", env), childEnv) };
  }
  if (mode === "gt") {
    const directory = join(home, "graphite-bot");
    const local = args.some((a) => a === "--help" || a === "--version") || ["log", "restack", "create", "modify", "checkout", "up", "down", "branch", "init", "guide"].includes(args[0]);
    const next = botGitEnvironment(home, findBinary("gh", env), childEnv);
    delete next.GRAPHITE_AUTH_TOKEN;
    delete next.GRAPHITE_PROFILE;
    const token = loadText(join(directory, "token")).trim();
    if (!local) {
      if (!token) throw new Error("GitHub router: bot Graphite authentication missing; refusing owner Graphite identity");
      next.GRAPHITE_AUTH_TOKEN = token;
      const digest = createHash("sha256").update(token).digest("hex");
      const identity = load(join(directory, "identity.json"));
      if (identity.login !== BOT || identity.digest !== digest || Date.now() - identity.at > 600_000) {
        const result = spawnSync(real, ["auth", "--no-interactive"], { env: next, encoding: "utf8", timeout: 10_000 });
        if (result.status !== 0 || !new RegExp(`Authenticated as:\\\\s*${BOT}(?:\\\\s|$)`).test(result.stdout)) {
          throw new Error("GitHub router: Graphite token is not authenticated as bot112112121; refusing owner identity");
        }
        save(join(directory, "identity.json"), { login: BOT, digest, at: Date.now() });
      }
    }
    record(home, who.agent, "bot", mode, args[0]);
    return { real, args, env: next };
  }
  if (who.agent && !["daemon", "plugin"].includes(who.agent)) {
    if (operation.command === "pr" && operation.action === "checks") throw new Error("GitHub router: gh pr checks is not available to agents; use REST checks or the repository wait-checks helper");
    if (operation.command === "pr" && operation.action === "view" && operation.json.split(",").includes("statusCheckRollup")) throw new Error("GitHub router: agents must use REST checks, not statusCheckRollup polling");
    if (operation.command === "run" && operation.action === "watch" && (!/^[1-9][0-9]*$/.test(operation.interval) || Number(operation.interval) < 30)) throw new Error("GitHub router: gh run watch requires --interval 30 or more");
  }
  const account = operation.read ? await readAccount(real, operation, home, childEnv, who.agent) : "bot";
  const next = accountEnvironment(account, home, childEnv);
  // gh commands invoking Git inherit bot Git authentication even when a read used the owner.
  if (!operation.read) Object.assign(next, botGitEnvironment(home, real, childEnv));
  let routedArgs = args;
  if (operation.read && operation.command === "api" && operation.resource === "core" && !operation.cache) {
    const index = args.indexOf("api");
    routedArgs = [...args.slice(0, index + 1), "--cache", "30s", ...args.slice(index + 1)];
  }
  record(home, who.agent, account, mode, `${operation.command ?? "unknown"} ${operation.action ?? ""}`.trim().replace(/\?.*$/, ""));
  return { real, args: routedArgs, env: next };
}

async function main() {
  let mode = basename(process.argv[1]);
  let args = process.argv.slice(2);
  if (mode === "gh-agent-guard") mode = "gh";
  if (mode === "github-router.mjs") { mode = args.shift(); }
  if (!["gh", "git", "gt"].includes(mode)) throw new Error("GitHub router: expected gh, git or gt");
  const invocation = await route(mode, args);
  const child = spawn(invocation.real, invocation.args, { env: invocation.env, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => { console.error(error.message); process.exitCode = 127; });
  child.on("exit", (code, signal) => {
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exitCode = code ?? 1;
  });
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = /GitHub read budgets exhausted|budget admission lock timed out/.test(error.message) ? 75 : 1;
  });
}
