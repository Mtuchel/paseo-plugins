#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { botGitInvocation } from "./github-git.mjs";
import { resourceFor, runNativeApi, watchRun } from "./github-api.mjs";

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

function booleanFlag(value, flag) {
  if (["1", "t", "T", "true", "TRUE", "True"].includes(value)) return true;
  if (["0", "f", "F", "false", "FALSE", "False"].includes(value)) return false;
  throw new Error(`GitHub router: invalid boolean ${flag} value`);
}

export function ghOperation(args) {
  const words = [];
  let method = "", fields = false, input = false, query = "", json = "", interval = "", cache = false, commandIndex = -1, actionIndex = -1, paginate = false, exitStatus = false;
  const valueFlags = new Set(["-R", "--repo", "--hostname", "--jq", "-q", "--template", "-t", "--header", "-H", "--preview", "-p", "--paginate-limit"]);
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
    if (words[0] === "api" && (a === "--paginate" || a.startsWith("--paginate="))) {
      paginate = booleanFlag(a.includes("=") ? a.slice(11) : "true", "--paginate");
      continue;
    }
    if (words[0] === "run" && (a === "--exit-status" || a.startsWith("--exit-status="))) {
      exitStatus = booleanFlag(a.includes("=") ? a.slice(14) : "true", "--exit-status");
      continue;
    }
    if (!a.startsWith("-")) {
      if (!words.length) commandIndex = i;
      if (words.length === 1) actionIndex = i;
      words.push(a);
    }
  }
  const [command, action] = words;
  // Only top-level help/version is unambiguously local; nested values may be write content.
  const local = ["--help", "-h", "--version"].includes(args[0]) || command === "help";
  let read = false, resource = "graphql";
  if (command === "api") {
    resource = resourceFor(action ?? "/");
    // Unknown/file/stdin GraphQL documents are writes, never balanced across identities.
    read = resource === "graphql"
      ? !input && !query.startsWith("@") && /^(?:\s|#[^\n]*\n)*(?:query\b|\{)/.test(query) && !/\bmutation\b/i.test(query)
      : !input && (!fields || method.toUpperCase() === "GET") && (!method || method.toUpperCase() === "GET");
  } else if (command === "pr") read = ["view", "list", "status", "checks", "diff"].includes(action);
  else if (command === "issue") { read = ["view", "list", "status"].includes(action); resource = "graphql"; }
  else if (command === "repo") read = ["view", "list"].includes(action);
  else if (command === "run") { read = ["view", "list", "watch"].includes(action); resource = "core"; }
  else if (command === "search") { read = true; resource = action === "code" ? "code_search" : "search"; }
  // Authentication/token operations pin to bot, including helpers used by child commands.
  return { command, action, commandIndex, actionIndex, read, resource, local, json, interval, cache, paginate, exitStatus, words };
}

export function accountEnvironment(account, home, env = process.env) {
  const next = { ...env, GH_CONFIG_DIR: account === "bot" ? join(home, "gh-bot") : join(env.HOME || homedir(), ".config", "gh") };
  delete next.GH_TOKEN;
  delete next.GITHUB_TOKEN;
  delete next.GH_DEBUG;
  next.GH_PROMPT_DISABLED = "1";
  return next;
}

function probe(realGh, account, resource, home, env, token) {
  const e = accountEnvironment(account, home, env);
  if (token) e.GH_TOKEN = token;
  let result;
  if (resource === "graphql") {
    result = spawnSync(realGh, ["api", "graphql", "-f", "query={rateLimit{limit remaining resetAt}}"], { env: e, encoding: "utf8", timeout: 3_000 });
    if (result.status !== 0) throw new Error(`GitHub router: ${account} GraphQL budget probe failed`);
    const budget = JSON.parse(result.stdout).data?.rateLimit;
    if (!budget) throw new Error(`GitHub router: ${account} GraphQL budget unavailable`);
    return { remaining: budget.remaining, resetAt: Date.parse(budget.resetAt), at: Date.now() };
  }
  // /rate_limit can report a different bucket. Use actual authenticated response headers.
  const path = resource === "search" ? "search/repositories?q=repo:cli/cli&per_page=1" : resource === "code_search" ? "search/code?q=repo:cli/cli+filename:README.md&per_page=1" : "user";
  const args = ["api", "-i", path];
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
  const reserve = (account) => ["search", "code_search"].includes(resource) ? (account === "bot" ? 5 : 1) : account === "bot" ? BOT_RESERVE : OWNER_RESERVE;
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
  const authentication = spawnSync(realGh, ["auth", "token", "--hostname", "github.com"], { env: accountEnvironment("bot", home, env), encoding: "utf8", timeout: 3_000 });
  if (authentication.status !== 0 || !authentication.stdout.trim()) throw new Error("GitHub router: bot credentials unavailable");
  const token = authentication.stdout.trim();
  const digest = createHash("sha256").update(token).digest("hex");
  await withLock(home, (path) => {
    const state = load(path);
    const core = state.core ??= {};
    if (core.bot?.identity === BOT && state.botTokenDigest === digest && Date.now() - core.bot.at < TTL) return;
    core.bot = probe(realGh, "bot", "core", home, env, token);
    state.botTokenDigest = digest;
    save(path, state);
  });
  return token;
}

function pendingCost(entries, key) {
  let cost = 0;
  for (const [pid, entry] of Object.entries(entries ?? {})) {
    try { process.kill(Number(pid), 0); }
    catch (error) { if (error.code === "ESRCH") { delete entries[pid]; continue; } }
    cost += entry[key] ?? 0;
  }
  return cost;
}

async function reserveWrite(home, operation) {
  await withLock(home, (path) => {
    const state = load(path);
    const pending = state.pendingWrites ??= {};
    const cost = operation.command === "api" ? 1 : 10;
    const resources = operation.command === "api" ? [operation.resource] : ["core", "graphql"];
    const entry = pending[process.pid] ??= {};
    for (const resource of resources) entry[resource] = (entry[resource] ?? 0) + cost;
    save(path, state);
  });
}

async function finishWrite(home) {
  await withLock(home, (path) => {
    const state = load(path);
    const entry = state.pendingWrites?.[process.pid];
    for (const resource of Object.keys(entry ?? {})) if (state[resource]?.bot) state[resource].bot.at = 0;
    if (entry) delete state.pendingWrites[process.pid];
    save(path, state);
  });
}

async function finishRead(home, account, resource, invalidate = false) {
  await withLock(home, (path) => {
    const state = load(path);
    const entry = state.pendingReads?.[process.pid];
    if (entry && account && resource) {
      const key = `${resource}:${account}`;
      if (entry[key] > 1) entry[key]--;
      else delete entry[key];
      if (invalidate && state[resource]?.[account]) state[resource][account].at = 0;
      if (!Object.keys(entry).length) delete state.pendingReads[process.pid];
    } else if (entry) {
      delete state.pendingReads[process.pid];
    }
    save(path, state);
  });
}

async function observe(home, account, resource, headers) {
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const resetAt = Number(headers.get("x-ratelimit-reset")) * 1000;
  if (!headers.has("x-ratelimit-remaining") || !Number.isFinite(remaining) || !Number.isFinite(resetAt)) return;
  await withLock(home, (path) => {
    const state = load(path);
    const pool = state[resource] ??= {};
    const previous = pool[account];
    pool[account] = { ...previous, remaining: previous?.resetAt === resetAt ? Math.min(previous.remaining, remaining) : remaining, resetAt, at: Date.now() };
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
    const writeDebt = pendingCost(state.pendingWrites, operation.resource);
    const effective = Object.fromEntries(Object.entries(budgets).map(([account, pool]) => [
      account, { ...pool, remaining: pool.remaining - pendingCost(state.pendingReads, `${operation.resource}:${account}`) - (account === "bot" ? writeDebt : 0) },
    ]));
    const chosen = pickRead(effective, operation.resource, now);
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
    if (chosen) {
      const pending = state.pendingReads ??= {};
      const entry = pending[process.pid] ??= {};
      const key = `${operation.resource}:${chosen}`;
      entry[key] = (entry[key] ?? 0) + 1;
    }
    save(path, state);
    if (!chosen) {
      const resume = Math.min(...Object.values(budgets).map((b) => b.resetAt));
      throw new Error(`GitHub read budgets exhausted; bot writes remain reserved. Try after ${new Date(resume).toISOString()}`);
    }
    return chosen;
  });
}

function guardedHelper() {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(SELF)} git-credential`;
}

export function botGitEnvironment(home, realGh, env) {
  return botGitInvocation(findBinary("git", env), realGh, home, [], accountEnvironment("bot", home, env), guardedHelper()).env;
}

// `call`: the linear-tickets GitHub usage meter's id for the call ($LINEAR_TICKETS_GH_CALL), so
// its record takes the account from this line (README, "GitHub usage").
function record(home, agent, account, mode, operation, env = process.env) {
  const directory = join(home, "github-router");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const call = env.LINEAR_TICKETS_GH_CALL;
  // No arguments/bodies/tokens: enough to attribute traffic without collecting secrets.
  appendFileSync(join(directory, "calls.jsonl"), JSON.stringify({ at: new Date().toISOString(), agent, account, command: mode, operation, ...(call ? { call } : {}) }) + "\n", { mode: 0o600 });
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
  const writeToken = mode === "gh" && !operation.read ? await verifyBot(real, home, childEnv) : undefined;
  if (mode === "git") {
    return { real, ...botGitInvocation(real, findBinary("gh", env), home, args, accountEnvironment("bot", home, childEnv), guardedHelper()) };
  }
  if (mode === "gt") {
    const directory = join(home, "graphite-bot");
    const local = ["--help", "-h", "--version"].includes(args[0]) || ["help", "log", "restack", "create", "modify", "checkout", "up", "down", "branch", "init", "guide"].includes(args[0]);
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
        if (result.status !== 0 || !/Authenticated as:\s*bot112112121(?:\s|$)/.test(result.stdout)) {
          throw new Error("GitHub router: Graphite token is not authenticated as bot112112121; refusing owner identity");
        }
        save(join(directory, "identity.json"), { login: BOT, digest, at: Date.now() });
      }
    }
    record(home, who.agent, "bot", mode, args[0], env);
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
  if (writeToken) next.GH_TOKEN = writeToken;
  const write = !operation.read && operation.command !== "auth";
  if (write) await reserveWrite(home, operation);
  let routedArgs = args;
  if (operation.read && operation.command === "api" && operation.resource === "core" && !operation.cache) {
    const index = operation.commandIndex;
    routedArgs = [...args.slice(0, index + 1), "--cache", "30s", ...args.slice(index + 1)];
    if (operation.actionIndex >= 0) operation.actionIndex += 2;
  }
  record(home, who.agent, account, mode, `${operation.command ?? "unknown"} ${operation.action ?? ""}`.trim().replace(/\?.*$/, ""), env);
  return { real, args: routedArgs, env: next, account, operation, who, home, write };
}

async function gitCredential(args) {
  if (args[0] !== "get") return;
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const fields = Object.fromEntries(input.split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (fields.protocol !== "https" || fields.host !== "github.com") throw new Error("GitHub router: guarded credential helper only supports github.com HTTPS");
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const realGh = findBinary("gh");
  const token = await verifyBot(realGh, home, process.env);
  process.stdout.write(`username=${BOT}\npassword=${token}\n\n`);
}

async function main() {
  let mode = basename(process.argv[1]);
  let args = process.argv.slice(2);
  if (mode === "gh-agent-guard") mode = "gh";
  if (mode === "github-router.mjs") mode = args.shift();
  if (mode === "git-credential") return gitCredential(args);
  if (!["gh", "git", "gt"].includes(mode)) throw new Error("GitHub router: expected gh, git or gt");
  const invocation = await route(mode, args);
  if (mode === "gh" && invocation.operation?.read && (invocation.operation.command === "api" && invocation.operation.action || invocation.operation.command === "run" && invocation.operation.action === "watch")) {
    const deps = {
      realGh: invocation.real, realGit: findBinary("git"), env: invocation.env,
      firstAccount: invocation.account, operation: invocation.operation,
      home: invocation.home,
      cacheMs: (() => {
        const index = invocation.args.indexOf("--cache");
        const value = index >= 0 ? invocation.args[index + 1] : invocation.args.find((a) => a.startsWith("--cache="))?.slice(8);
        return [...(value ?? "").matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)].reduce((total, match) => total + Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]]), 0);
      })(),
      choose: (resource) => readAccount(invocation.real, { ...invocation.operation, resource }, invocation.home, invocation.env, invocation.who.agent),
      environment: (account) => accountEnvironment(account, invocation.home, invocation.env),
      observe: (account, resource, headers) => observe(invocation.home, account, resource, headers),
      complete: (account, resource) => finishRead(invocation.home, account, resource),
      record: (account, resource) => record(invocation.home, invocation.who.agent, account, "gh-api", resource, invocation.env),
    };
    try {
      const result = invocation.operation.command === "api" ? await runNativeApi(invocation, deps) : { code: await watchRun(args, deps) };
      process.exitCode = result.code ?? 1;
      return;
    } finally {
      await finishRead(invocation.home);
    }
  }
  const child = spawn(invocation.real, invocation.args, { env: invocation.env, stdio: "inherit" });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = signals.map((signal) => { const fn = () => child.kill(signal); process.on(signal, fn); return fn; });
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exitCode = code ?? 1;
  } finally {
    signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
    if (invocation.write) await finishWrite(invocation.home);
    if (invocation.operation?.read) await finishRead(invocation.home, invocation.account, invocation.operation.resource, true);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = /GitHub read budgets exhausted|budget admission lock timed out/.test(error.message) ? 75 : 1;
  });
}
