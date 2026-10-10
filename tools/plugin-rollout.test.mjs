// tools/plugin-rollout.mjs against a fake `paseo` (PASEO_BIN), a fake `npm` (NPM_BIN), a stub
// Paseo build (PASEO_SERVER_DIR) and a real git checkout cloned from a temporary bare origin.
//
// The fake keeps the daemon, plugin list and plugin logs in one JSON state file. Its
// `plugin reload` behaves like Paseo 0.10.3: it logs Stopping/stopped/Loading, reports `failed`
// for the whole load, prints the CLI's 60 s timeout and exits 1, while a detached "daemon" helper
// finishes the load later with `Plugin ready` or `Plugin failed to load`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { classify, decide, resolvePending, settled } from "./plugin-rollout.mjs";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "plugin-rollout.mjs");
const VERSION = "0.10.3";
const DAEMON = { pid: 4242, startedAt: "2026-10-10T07:00:00.000Z" };

function tryMkdir(path) {
  try {
    mkdirSync(path);
    return true;
  } catch {
    return false;
  }
}

const FAKE_PASEO = String.raw`#!/usr/bin/env node
import { mkdirSync, readFileSync, rmdirSync, writeFileSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
const file = process.env.FAKE_PASEO_STATE;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function locked(change) {
  for (;;) {
    try { mkdirSync(file + ".lock"); break; } catch { sleep(5); }
  }
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    const result = change(state);
    writeFileSync(file + ".tmp", JSON.stringify(state));
    renameSync(file + ".tmp", file);
    return result;
  } finally { rmdirSync(file + ".lock"); }
}
function log(state, id, message) {
  const sequence = state.nextSequence++;
  (state.logs[id] ??= []).push({ sequence, timestamp: new Date().toISOString(), stream: "stdout", message });
  state.events.push(id + ": " + message);
}
const plugin = (state, id) => state.plugins.find((p) => p.id === id);
// Writers replace the file by rename, so a read never sees a partial write.
const read = () => JSON.parse(readFileSync(file, "utf8"));
const [a, b, c] = process.argv.slice(2);
if (a === "daemon" && b === "status") {
  console.log(JSON.stringify(read().daemon));
} else if (a === "plugin" && b === "ls") {
  console.log(JSON.stringify(read().plugins));
} else if (a === "plugin" && b === "logs") {
  console.log(JSON.stringify((read().logs[c] ?? []).slice(-500)));
} else if (a === "plugin" && b === "reload") {
  const behavior = locked((s) => {
    s.reloads.push(c);
    log(s, c, "[paseo] Stopping plugin");
    log(s, c, "[paseo] Plugin stopped");
    log(s, c, "[paseo] Loading plugin");
    plugin(s, c).status = "failed";
    return s.behavior[c] ?? { outcome: "ready", loadMs: 400 };
  });
  spawn(process.execPath, [process.argv[1], "__finish", c, behavior.outcome, String(behavior.loadMs), String(behavior.burst ?? 0)], { detached: true, stdio: "ignore" }).unref();
  if (behavior.cliMs) sleep(behavior.cliMs);
  console.error("Error: Timeout waiting for message (60000ms)");
  process.exit(1);
} else if (a === "__finish") {
  sleep(Number(process.argv[5]));
  locked((s) => {
    // A startup burst can push the load's own lines out of the 500-entry window.
    for (let i = 0; i < Number(process.argv[6]); i += 1) log(s, b, "[" + b + "] starting up");
    if (process.argv[4] === "ready") { log(s, b, "[paseo] Plugin ready"); plugin(s, b).status = "running"; }
    else if (process.argv[4] === "failed") log(s, b, "[paseo] Plugin failed to load: Build failed with 1 error: boom");
  });
} else if (a === "__event") {
  locked((s) => { s.events.push(b); });
} else if (a === "__restart") {
  // A daemon restart: new identity, and it loads every plugin from the checkout as it is.
  locked((s) => {
    s.daemon.pid += 1;
    s.daemon.startedAt = new Date().toISOString();
    s.restartOnBuild = false;
    for (const p of s.plugins) { log(s, p.id, "[paseo] Loading plugin"); log(s, p.id, "[paseo] Plugin ready"); p.status = "running"; }
  });
} else {
  console.error("fake paseo: unknown command " + process.argv.slice(2).join(" "));
  process.exit(64);
}
`;

const FAKE_NPM = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
appendFileSync(process.env.FAKE_NPM_CALLS, process.cwd() + "\n");
if (existsSync(process.env.FAKE_NPM_CALLS + ".fail")) { console.error("npm error: fake failure"); process.exit(1); }
mkdirSync("node_modules", { recursive: true });
`;

// The stub build refuses a plugin directory that contains BUILD_FAIL, and restarts the fake daemon
// while it builds when the state asks for it.
const STUB_RUNTIME = `import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
export class PluginRuntime {
  async validatePlugin(directory) {
    if (JSON.parse(readFileSync(process.env.FAKE_PASEO_STATE, "utf8")).restartOnBuild) execFileSync(process.env.PASEO_BIN, ["__restart"]);
    if (existsSync(join(directory, "BUILD_FAIL"))) throw new Error("Build failed with 1 error: stub refusal");
  }
}
`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writePlugin(root, id, extra = {}) {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "paseo-plugin.json"), JSON.stringify({ id }));
  writeFileSync(join(root, id, "package.json"), JSON.stringify({ name: id, private: true }));
  writeFileSync(join(root, id, "npm-shrinkwrap.json"), JSON.stringify({ name: id, lockfileVersion: 3, ...extra }));
  writeFileSync(join(root, id, "index.server.ts"), "export default {};\n");
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "rollout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "paseo.mjs"), FAKE_PASEO);
  writeFileSync(join(bin, "npm.mjs"), FAKE_NPM);
  chmodSync(join(bin, "paseo.mjs"), 0o755);
  chmodSync(join(bin, "npm.mjs"), 0o755);
  const server = join(root, "server");
  mkdirSync(join(server, "dist", "server", "server", "plugins"), { recursive: true });
  writeFileSync(join(server, "package.json"), JSON.stringify({ name: "@getpaseo/server", version: VERSION }));
  writeFileSync(join(server, "dist", "server", "server", "plugins", "runtime.js"), STUB_RUNTIME);

  // origin (bare), dev (where changes are made and pushed), checkout (the host's clone).
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  const checkout = join(root, "checkout");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, dev);
  for (const repo of [dev]) {
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
  }
  writeFileSync(join(dev, ".gitignore"), "node_modules/\n");
  writePlugin(dev, "alpha");
  writePlugin(dev, "beta");
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "initial");
  git(dev, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", "-b", "main", origin, checkout);

  const home = join(root, "home");
  const stateFile = join(root, "paseo-state.json");
  const npmCalls = join(root, "npm-calls");
  writeFileSync(npmCalls, "");
  const env = {
    ...process.env,
    PASEO_BIN: join(bin, "paseo.mjs"),
    NPM_BIN: join(bin, "npm.mjs"),
    PASEO_SERVER_DIR: server,
    PASEO_HOME: home,
    FAKE_PASEO_STATE: stateFile,
    FAKE_NPM_CALLS: npmCalls,
    PLUGIN_ROLLOUT_POLL_MS: "50",
    PLUGIN_ROLLOUT_DEADLINE_MS: "20000",
  };
  // A post-merge hook records each pull among the fake daemon's lifecycle events.
  writeFileSync(join(checkout, ".git", "hooks", "post-merge"), `#!/bin/sh\nexec "${process.execPath}" "${env.PASEO_BIN}" __event pull\n`);
  chmodSync(join(checkout, ".git", "hooks", "post-merge"), 0o755);

  const initial = {
    daemon: { ...DAEMON, daemonVersion: VERSION },
    plugins: ["alpha", "beta"].map((id) => ({ id, path: join(checkout, id), enabled: true, status: "running" })),
    logs: { alpha: [], beta: [] },
    nextSequence: 1,
    reloads: [],
    behavior: {},
    events: [],
  };
  writeFileSync(stateFile, JSON.stringify(initial));
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  // Under the fake's own lock: the fake daemon writes the same file concurrently.
  const update = (change) => {
    while (!tryMkdir(`${stateFile}.lock`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    try {
      const s = state();
      change(s);
      writeFileSync(`${stateFile}.tmp`, JSON.stringify(s));
      renameSync(`${stateFile}.tmp`, stateFile);
    } finally {
      rmdirSync(`${stateFile}.lock`);
    }
  };
  const addLog = (id, message, status) =>
    update((s) => {
      s.logs[id].push({ sequence: s.nextSequence++, timestamp: new Date().toISOString(), stream: "stdout", message });
      s.events.push(`${id}: ${message}`);
      if (status) s.plugins.find((p) => p.id === id).status = status;
    });
  const start = (id, ...args) => {
    const child = spawn(process.execPath, [TOOL, join(checkout, id), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
    return { child, done };
  };
  const rollout = (id, ...args) => start(id, ...args).done;
  const push = (change, message) => {
    change(dev);
    git(dev, "add", "-A");
    git(dev, "commit", "-q", "-m", message);
    git(dev, "push", "-q", "origin", "HEAD:main");
  };
  const receipt = (id) => {
    const file = join(home, "plugin-rollout", `${id}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };
  const npmCount = () => readFileSync(npmCalls, "utf8").split("\n").filter(Boolean).length;
  // The first rollout per host and plugin has no receipt: exit 2, then --force loads it once.
  const prime = async (id = "alpha") => {
    const first = await rollout(id);
    assert.equal(first.code, 2, first.out);
    const forced = await rollout(id, "--force");
    assert.equal(forced.code, 0, forced.out);
  };
  return { root, dev, checkout, home, env, state, update, addLog, start, rollout, push, receipt, npmCount, npmCalls, prime };
}

const reloads = (ctx, id = "alpha") => ctx.state().reloads.filter((r) => r === id).length;

test("a reload whose CLI times out is waited for until Plugin ready; the receipt records the loaded tree", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  assert.equal(reloads(ctx), 1);
  const receipt = ctx.receipt("alpha");
  assert.equal(receipt.state, "loaded");
  assert.equal(receipt.tree, git(ctx.checkout, "rev-parse", "HEAD:alpha"));
  assert.equal(receipt.daemonPid, DAEMON.pid);
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 2 };\n"), "alpha v2");
  const run = await ctx.rollout("alpha");
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /the CLI stopped waiting after 60 s/);
  assert.match(run.out, /ready [0-9a-f]{7}/);
  assert.equal(reloads(ctx), 2);
  assert.equal(ctx.receipt("alpha").tree, git(ctx.checkout, "rev-parse", "HEAD:alpha"));
});

test("a load that fails exits 1 with Paseo's line and records the failure", async (t) => {
  const ctx = setup(t);
  ctx.update((s) => (s.behavior.alpha = { outcome: "failed", loadMs: 200 }));
  const run = await ctx.rollout("alpha", "--force");
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /\[paseo\] Plugin failed to load: Build failed with 1 error: boom/);
  assert.equal(ctx.receipt("alpha").state, "failed");
  assert.equal(reloads(ctx), 1);
});

test("two rollouts of the same commit started together reload once", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 2 };\n"), "alpha v2");
  const [one, two] = await Promise.all([ctx.rollout("alpha"), ctx.rollout("alpha")]);
  assert.deepEqual([one.code, two.code], [0, 0], one.out + two.out);
  assert.equal(reloads(ctx), 2, "the priming reload and one more");
  assert.match(one.out + two.out, /already loaded/);
});

test("a second rollout bringing another commit reloads only after the first load is ready", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.update((s) => (s.behavior.alpha = { outcome: "ready", loadMs: 800 }));
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 2 };\n"), "alpha v2");
  const first = ctx.start("alpha");
  // The first holds the lock and is reloading when the second commit lands and its rollout starts.
  while (!ctx.state().events.slice(-1)[0]?.includes("Loading plugin") || reloads(ctx) < 2) await delay(20);
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 3 };\n"), "alpha v3");
  const second = await ctx.rollout("alpha");
  const firstDone = await first.done;
  assert.deepEqual([firstDone.code, second.code], [0, 0], firstDone.out + second.out);
  assert.equal(reloads(ctx), 3);
  const alphaEvents = ctx.state().events.filter((e) => e.startsWith("alpha: [paseo] Loading plugin") || e.startsWith("alpha: [paseo] Plugin ready"));
  assert.deepEqual(alphaEvents.slice(-4), [
    "alpha: [paseo] Loading plugin",
    "alpha: [paseo] Plugin ready",
    "alpha: [paseo] Loading plugin",
    "alpha: [paseo] Plugin ready",
  ]);
  assert.equal(ctx.receipt("alpha").tree, git(ctx.dev, "rev-parse", "HEAD:alpha"));
});

test("a refused build reloads nothing and says the running plugin keeps its code", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "BUILD_FAIL"), ""), "alpha breaks the build");
  const run = await ctx.rollout("alpha");
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /refuses alpha: Build failed with 1 error: stub refusal/);
  assert.match(run.out, /not reloading; the running plugin keeps its code/);
  assert.equal(reloads(ctx), 1);
});

test("a plugin not running with no lifecycle line in view is waited for; at the deadline nothing is pulled or reloaded", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.update((s) => {
    s.plugins.find((p) => p.id === "alpha").status = "failed";
    s.logs.alpha = [];
  });
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 2 };\n"), "alpha v2");
  const before = git(ctx.checkout, "rev-parse", "HEAD");
  const run = await ctx.rollout("alpha", "--force");
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /waiting for the running load of alpha/);
  assert.match(run.out, /alpha still loading; not changing the checkout or reloading/);
  assert.equal(reloads(ctx), 1);
  assert.equal(git(ctx.checkout, "rev-parse", "HEAD"), before);
}, { timeout: 60_000 });

test("an old failed line followed by a load still running is waited for, not reloaded into", async (t) => {
  const ctx = setup(t);
  ctx.addLog("alpha", "[paseo] Plugin failed to load: old", "failed");
  ctx.addLog("alpha", "[paseo] Loading plugin");
  const run = ctx.start("alpha", "--force");
  await delay(1500);
  assert.equal(reloads(ctx), 0);
  ctx.addLog("alpha", "[paseo] Plugin ready", "running");
  const done = await run.done;
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /waiting for the running load of alpha/);
  assert.equal(reloads(ctx), 1);
  const events = ctx.state().events;
  assert.ok(events.indexOf("alpha: [paseo] Plugin ready") < events.indexOf("alpha: [paseo] Stopping plugin"));
});

test("unknown running code exits 2 with the reason and reloads only with --force", async (t) => {
  await t.test("no receipt", async (t) => {
    const ctx = setup(t);
    const run = await ctx.rollout("alpha");
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /cannot tell which code alpha runs \(no receipt from an earlier rollout of it on this host\); rerun with --force/);
    assert.equal(reloads(ctx), 0);
    const forced = await ctx.rollout("alpha", "--force");
    assert.equal(forced.code, 0, forced.out);
    assert.equal(reloads(ctx), 1);
  });
  await t.test("Paseo restarted since the receipt", async (t) => {
    const ctx = setup(t);
    await ctx.prime();
    ctx.update((s) => (s.daemon.startedAt = "2026-10-10T08:00:00.000Z"));
    const run = await ctx.rollout("alpha");
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /Paseo restarted since its last rollout/);
    assert.equal(reloads(ctx), 1);
    assert.equal((await ctx.rollout("alpha", "--force")).code, 0);
    assert.equal(reloads(ctx), 2);
  });
  await t.test("a load outside the tool is visible", async (t) => {
    const ctx = setup(t);
    await ctx.prime();
    ctx.addLog("alpha", "[paseo] Loading plugin");
    ctx.addLog("alpha", "[paseo] Plugin ready", "running");
    const run = await ctx.rollout("alpha");
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /it was loaded outside this tool \(plugin log sequence \d+\)/);
    assert.equal(reloads(ctx), 1);
    assert.equal((await ctx.rollout("alpha", "--force")).code, 0);
    assert.equal(reloads(ctx), 2);
  });
});

test("a rollout killed after its reload was sent: the next run waits for that load and adopts it", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.update((s) => (s.behavior.alpha = { outcome: "ready", loadMs: 1000 }));
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 2 };\n"), "alpha v2");
  const killed = ctx.start("alpha");
  while (reloads(ctx) < 2) await delay(10);
  await delay(100);
  killed.child.kill("SIGKILL");
  // The locked rollout is a grandchild (node → python's exec → node): kill it by its command line.
  execFileSync("pkill", ["-KILL", "-f", `plugin-rollout\\.mjs --locked .*${join(ctx.checkout, "alpha")}`]);
  await killed.done;
  assert.equal(ctx.receipt("alpha").state, "pending");
  const next = await ctx.rollout("alpha");
  assert.equal(next.code, 0, next.out);
  assert.match(next.out, /waiting for the running load of alpha/);
  assert.match(next.out, /already loaded/);
  assert.equal(reloads(ctx), 2);
  assert.equal(ctx.receipt("alpha").state, "loaded");
});

test("a rollout killed after writing its intent but before the reload: the next run exits 2", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  // What a rollout leaves when it dies between writing `pending` and running `paseo plugin reload`.
  const file = join(ctx.home, "plugin-rollout", "alpha.json");
  const loaded = JSON.parse(readFileSync(file, "utf8"));
  const newest = ctx.state().nextSequence - 1;
  writeFileSync(file, JSON.stringify({ ...loaded, state: "pending", afterSequence: newest, loadSequence: undefined }));
  const run = await ctx.rollout("alpha");
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /the last rollout's reload has no visible outcome/);
  assert.equal(reloads(ctx), 1);
});

test("the lock: a holder killed while waiting frees it at once; a surviving child keeps it", async (t) => {
  const ctx = setup(t);
  const lockFile = join(ctx.home, "plugin-rollout.lock");
  const flock = join(dirname(TOOL), "flock.py");
  mkdirSync(ctx.home, { recursive: true });
  // A lock holder that sleeps, SIGKILLed: the next rollout gets the lock at once.
  const holder = spawn("python3", [flock, lockFile, String(Date.now() + 10_000), "sleep", "30"], { stdio: "ignore" });
  await delay(300);
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.on("close", resolve));
  const started = Date.now();
  const run = await ctx.rollout("alpha");
  assert.equal(run.code, 2, run.out);
  assert.doesNotMatch(run.out, /waiting for another plugin rollout/);
  assert.ok(Date.now() - started < 10_000);

  // A Node owner that hands the lock fd to a child, then dies: the lock stays until the child exits.
  const owner = join(ctx.root, "owner.mjs");
  writeFileSync(
    owner,
    `import { spawn } from "node:child_process";
const fd = Number(process.argv[2]);
const stdio = ["ignore", "ignore", "ignore"]; while (stdio.length < fd) stdio.push("ignore"); stdio[fd] = fd;
spawn("sleep", ["2"], { stdio, detached: true }).unref();
setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
`,
  );
  const ownerRun = spawn("python3", [flock, lockFile, String(Date.now() + 10_000), process.execPath, owner, "@LOCKFD@"], { stdio: "ignore" });
  await new Promise((resolve) => ownerRun.on("close", resolve));
  const waitedFrom = Date.now();
  const blocked = await ctx.rollout("alpha");
  assert.equal(blocked.code, 2, blocked.out);
  assert.match(blocked.out, /waiting for another plugin rollout/);
  assert.ok(Date.now() - waitedFrom >= 1000, "waited for the surviving child");
});

test("--force with a matching receipt reloads once, after a running load", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.addLog("alpha", "[paseo] Stopping plugin", "failed");
  ctx.addLog("alpha", "[paseo] Plugin stopped");
  ctx.addLog("alpha", "[paseo] Loading plugin");
  const run = ctx.start("alpha", "--force");
  await delay(1000);
  assert.equal(reloads(ctx), 1);
  ctx.addLog("alpha", "[paseo] Plugin ready", "running");
  const done = await run.done;
  assert.equal(done.code, 0, done.out);
  assert.equal(reloads(ctx), 2);
});

test("a different daemon version or plugin path stops before the pull", async (t) => {
  await t.test("daemon version", async (t) => {
    const ctx = setup(t);
    ctx.update((s) => (s.daemon.daemonVersion = "0.11.0"));
    ctx.push((dev) => writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 2 };\n"), "alpha v2");
    const before = git(ctx.checkout, "rev-parse", "HEAD");
    const run = await ctx.rollout("alpha", "--force");
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /the daemon runs Paseo 0\.11\.0, the build check uses 0\.10\.3/);
    assert.equal(git(ctx.checkout, "rev-parse", "HEAD"), before);
    assert.equal(reloads(ctx), 0);
  });
  await t.test("plugin path", async (t) => {
    const ctx = setup(t);
    ctx.update((s) => (s.plugins.find((p) => p.id === "alpha").path = "/elsewhere/alpha"));
    const run = await ctx.rollout("alpha", "--force");
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /Paseo loads alpha from \/elsewhere\/alpha/);
    assert.equal(reloads(ctx), 0);
  });
});

test("a changed tracked file or an untracked file in the plugin is refused; untracked notes at the root are not", async (t) => {
  await t.test("tracked change", async (t) => {
    const ctx = setup(t);
    writeFileSync(join(ctx.checkout, "beta", "index.server.ts"), "export default { local: true };\n");
    const run = await ctx.rollout("alpha", "--force");
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /has local changes; nothing done:\n M beta\/index.server.ts/);
    assert.equal(reloads(ctx), 0);
  });
  await t.test("untracked file in the plugin", async (t) => {
    const ctx = setup(t);
    writeFileSync(join(ctx.checkout, "alpha", "extra.ts"), "export const x = 1;\n");
    const run = await ctx.rollout("alpha", "--force");
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /\?\? alpha\/extra.ts/);
    assert.equal(reloads(ctx), 0);
  });
  await t.test("untracked note at the root", async (t) => {
    const ctx = setup(t);
    writeFileSync(join(ctx.checkout, "PLAN-x.md"), "notes\n");
    const run = await ctx.rollout("alpha", "--force");
    assert.equal(run.code, 0, run.out);
    assert.equal(reloads(ctx), 1);
  });
});

test("a rollout of beta pulls only after alpha's load from a killed rollout reached ready", async (t) => {
  const ctx = setup(t);
  await ctx.prime("alpha");
  await ctx.prime("beta");
  // A killed alpha rollout left its load running.
  ctx.addLog("alpha", "[paseo] Stopping plugin", "failed");
  ctx.addLog("alpha", "[paseo] Plugin stopped");
  ctx.addLog("alpha", "[paseo] Loading plugin");
  ctx.push((dev) => {
    writeFileSync(join(dev, "alpha", "index.server.ts"), "export default { v: 2 };\n");
    writeFileSync(join(dev, "beta", "index.server.ts"), "export default { v: 2 };\n");
  }, "alpha and beta v2");
  const pulls = () => ctx.state().events.filter((event) => event === "pull").length;
  const pullsBefore = pulls();
  const run = ctx.start("beta");
  await delay(1000);
  assert.equal(pulls(), pullsBefore, "no pull during alpha's load");
  ctx.addLog("alpha", "[paseo] Plugin ready", "running");
  const done = await run.done;
  assert.equal(done.code, 0, done.out);
  const events = ctx.state().events;
  const pull = events.lastIndexOf("pull");
  assert.ok(pull > events.lastIndexOf("alpha: [paseo] Plugin ready"));
});

test("dependencies: a lockfile pulled by another rollout, a failed npm ci and a missing node_modules each install", async (t) => {
  const ctx = setup(t);
  await ctx.prime("alpha");
  await ctx.prime("beta");
  const base = ctx.npmCount();
  // beta's rollout pulls alpha's new lockfile without installing it.
  ctx.push((dev) => writeFileSync(join(dev, "alpha", "npm-shrinkwrap.json"), JSON.stringify({ name: "alpha", lockfileVersion: 3, v: 2 })), "alpha lockfile");
  const beta = await ctx.rollout("beta");
  assert.equal(beta.code, 0, beta.out);
  assert.equal(ctx.npmCount(), base);
  writeFileSync(`${ctx.npmCalls}.fail`, "");
  const failed = await ctx.rollout("alpha");
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /npm ci failed .*nothing reloaded/s);
  assert.equal(existsSync(join(ctx.home, "plugin-rollout", "alpha.install")), false);
  assert.equal(ctx.npmCount(), base + 1);
  rmSync(`${ctx.npmCalls}.fail`);
  const retry = await ctx.rollout("alpha");
  assert.equal(retry.code, 0, retry.out);
  assert.equal(ctx.npmCount(), base + 2, "the retry at the same HEAD installs again");
  rmSync(join(ctx.checkout, "alpha", "node_modules"), { recursive: true });
  const again = await ctx.rollout("alpha");
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already loaded/);
  assert.equal(ctx.npmCount(), base + 3);
  assert.equal(reloads(ctx), 2);
});

test("a finished load whose lines left the 500-entry log window still counts as loaded", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.update((s) => {
    for (let i = 0; i < 600; i += 1) s.logs.alpha.push({ sequence: s.nextSequence++, timestamp: "", stream: "stdout", message: "[alpha] work" });
  });
  const run = await ctx.rollout("alpha");
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /already loaded/);
  assert.equal(reloads(ctx), 1);
});

test("a malformed receipt counts as none", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  writeFileSync(join(ctx.home, "plugin-rollout", "alpha.json"), "{ not json");
  const run = await ctx.rollout("alpha");
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /no receipt/);
  assert.equal(reloads(ctx), 1);
});

test("Paseo restarting during the pull or build makes the running code unknown, not already loaded", async (t) => {
  const ctx = setup(t);
  await ctx.prime();
  ctx.update((s) => (s.restartOnBuild = true));
  const run = await ctx.rollout("alpha");
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /cannot tell which code alpha runs \(Paseo restarted since its last rollout\)/);
  assert.doesNotMatch(run.out, /already loaded/);
  assert.equal(reloads(ctx), 1);
});

test("a load whose Loading line left the log window before its outcome still ends at Plugin ready", async (t) => {
  const ctx = setup(t);
  ctx.update((s) => (s.behavior.alpha = { outcome: "ready", loadMs: 600, burst: 600 }));
  const run = await ctx.rollout("alpha", "--force");
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /ready [0-9a-f]{7}/);
  assert.equal(ctx.receipt("alpha").state, "loaded");
  const next = await ctx.rollout("alpha");
  assert.equal(next.code, 0, next.out);
  assert.match(next.out, /already loaded/);
  assert.equal(reloads(ctx), 1);
});

// Pure decisions.

const daemon = { pid: 1, startedAt: "s" };
const entry = (status = "running") => ({ id: "alpha", status });
const line = (sequence, message) => ({ sequence, message: `[paseo] ${message}` });

test("settled: running without a load under way, or down after a failed load; never `failed` status alone", () => {
  assert.equal(settled(entry(), []), true);
  assert.equal(settled(entry(), [line(1, "Loading plugin"), line(2, "Plugin ready")]), true);
  assert.equal(settled(entry("failed"), []), false);
  assert.equal(settled(entry("failed"), [line(1, "Plugin failed to load: x"), line(2, "Loading plugin")]), false);
  assert.equal(settled(entry("failed"), [line(1, "Loading plugin"), line(2, "Plugin failed to load: x")]), true);
  assert.equal(settled(entry(), [line(1, "Stopping plugin")]), false);
});

test("resolvePending adopts the one load since the request, and only when the window still covers it", () => {
  const pending = { revision: "r", tree: "t", state: "pending", daemonPid: 1, daemonStartedAt: "s", afterSequence: 10 };
  const logs = [line(10, "x"), line(11, "Stopping plugin"), line(12, "Loading plugin"), line(13, "Plugin ready")];
  assert.deepEqual(resolvePending(pending, daemon, logs), { ...pending, state: "loaded", loadSequence: 12 });
  assert.equal(resolvePending(pending, daemon, logs.slice(1)).state, "pending", "anchor scrolled out");
  assert.equal(resolvePending(pending, daemon, [...logs, line(14, "Loading plugin"), line(15, "Plugin ready")]).state, "pending");
  assert.equal(resolvePending(pending, { pid: 2, startedAt: "s" }, logs).state, "pending");
  assert.equal(resolvePending(pending, daemon, [line(10, "x"), line(12, "Loading plugin"), line(13, "Plugin failed to load: e")]).state, "failed");
});

test("classify and decide", () => {
  const loaded = { revision: "abcdef1", tree: "t1", state: "loaded", daemonPid: 1, daemonStartedAt: "s", afterSequence: 1, loadSequence: 2 };
  assert.deepEqual(classify(loaded, daemon, entry(), []), { kind: "known", tree: "t1", revision: "abcdef1" });
  assert.equal(classify(loaded, daemon, entry(), [line(3, "Loading plugin"), line(4, "Plugin ready")]).kind, "unknown");
  assert.equal(classify(loaded, daemon, entry("failed"), [line(5, "Plugin failed to load: e")]).kind, "down");
  assert.equal(classify(null, daemon, entry(), []).kind, "unknown");
  assert.deepEqual(decide({ kind: "known", tree: "t1", revision: "abcdef1" }, "t1", false), { action: "skip" });
  assert.equal(decide({ kind: "known", tree: "t1", revision: "abcdef1" }, "t2", false).action, "reload");
  assert.equal(decide({ kind: "known", tree: "t1", revision: "abcdef1" }, "t1", true).action, "reload");
  assert.equal(decide({ kind: "down" }, "t1", false).action, "reload");
  assert.deepEqual(decide({ kind: "unknown", reason: "why" }, "t1", false), { action: "refuse", reason: "why" });
  assert.equal(decide({ kind: "unknown", reason: "why" }, "t1", true).action, "reload");
});
