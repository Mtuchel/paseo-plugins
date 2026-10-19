// What the check builds with, and the four verdicts of Paseo's own plugin build, run through
// this checkout's tool against throwaway fixture plugins: what Paseo refuses and what it builds.
//
// The tool builds with the Paseo the running daemon runs. These tests pin that resolution with
// fake @getpaseo/cli installs, a fake `ps` on PATH playing a host's process table, and
// PASEO_CLI / PASEO_BIN / PASEO_SERVER_DIR. The tests that run a real Paseo (the daemon's runtime
// or, with no daemon, the `paseo` on PATH) fail rather than skip when the host has none.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseProcessTable } from "./paseo-build.mjs";

const TOOL = fileURLToPath(new URL("./paseo-build.mjs", import.meta.url));
const UID = process.getuid();
// The stub Paseo build this file's installs carry: it refuses a plugin directory holding
// BUILD_FAIL and builds everything else.
const STUB_RUNTIME = `import { existsSync } from "node:fs";
import { join } from "node:path";
export class PluginRuntime {
  async validatePlugin(directory) {
    if (existsSync(join(directory, "BUILD_FAIL"))) throw new Error("Build failed with 1 error: stub refusal");
  }
}
`;

let counter = 0;
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-${process.pid}-${++counter}-`));
}

// The tool reads PASEO_SERVER_DIR, PASEO_BIN and PASEO_CLI from its environment; a test must not
// inherit the host's (an agent session on a host whose daemon sets PASEO_CLI has it).
function toolEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ["PASEO_SERVER_DIR", "PASEO_BIN", "PASEO_CLI"]) if (!(name in extra)) delete env[name];
  return env;
}

function run(pluginDir, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, pluginDir], { env: toolEnv(extra) });
    const out = [], err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code, signal) => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code, signal }));
  });
}

// A fixture plugin: the manifest plus the entry files, keyed by path relative to the plugin
// directory. No dependencies, no node_modules; the test that asked for it removes it.
function fixture(files) {
  const dir = tempDir("paseo-build");
  writeFileSync(join(dir, "paseo-plugin.json"), JSON.stringify({ id: "fixture", requirements: { paseo: ">=0.8.0" } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

// A throwaway @getpaseo/cli install, laid out the way `npm install` writes one: the `paseo`
// executable, the node_modules/.bin symlink to it, and the @getpaseo/server beside it that the
// check must find through it.
function paseoInstall(t, version = "9.9.9") {
  const runtime = tempDir("paseo-install");
  const modules = join(runtime, "node_modules");
  const cli = join(modules, "@getpaseo", "cli");
  const server = join(modules, "@getpaseo", "server");
  mkdirSync(join(cli, "bin"), { recursive: true });
  mkdirSync(join(modules, ".bin"), { recursive: true });
  mkdirSync(join(server, "dist", "server", "server", "plugins"), { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@getpaseo/cli", version, bin: { paseo: "bin/paseo" } }));
  writeFileSync(join(cli, "bin", "paseo"), "#!/usr/bin/env node\n");
  chmodSync(join(cli, "bin", "paseo"), 0o755);
  symlinkSync(join("..", "@getpaseo", "cli", "bin", "paseo"), join(modules, ".bin", "paseo"));
  writeFileSync(join(server, "package.json"), JSON.stringify({ name: "@getpaseo/server", version, main: "index.js" }));
  writeFileSync(join(server, "index.js"), "export {};\n");
  writeFileSync(join(server, "dist", "server", "server", "plugins", "runtime.js"), STUB_RUNTIME);
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  return { bin: join(cli, "bin", "paseo"), shim: join(modules, ".bin", "paseo"), serverDir: server };
}

// A `ps` on PATH printing a fixed process table, in the format `-ww -Ao pid=,ppid=,uid=,args=`
// uses. A daemon's row shows the command line it was started with; `uid` defaults to this user.
function fakePs(t, ...rows) {
  const bin = tempDir("paseo-ps");
  const table = rows.map((row, index) => `${1000 + index} 1 ${row.uid ?? UID} ${row.args}`).join("\n");
  writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat <<'TABLE'\n${table}\nTABLE\n`);
  chmodSync(join(bin, "ps"), 0o755);
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  return bin;
}

// A path to run the tool's children with: the fake `ps` (and any decoy Paseo) first.
const pathWith = (...first) => [...first, process.env.PATH ?? ""].join(delimiter);
// What a host's daemon command line looks like: `node <install>/node_modules/.bin/paseo daemon run`.
const daemonRun = (cli) => ({ args: `${process.execPath} ${cli} daemon run` });

// Which Paseo the check builds with.

test("the CLI the running daemon was started from decides the build, not the `paseo` on PATH", async (t) => {
  const daemon = paseoInstall(t, "9.9.9");
  const decoy = paseoInstall(t, "8.8.8");
  const plugin = fixture({ "index.server.ts": "export const x = 1;\n" });
  t.after(() => rmSync(plugin, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(plugin, { PATH: pathWith(fakePs(t, daemonRun(daemon.shim)), dirname(decoy.shim)) });
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.equal(stdout, "Paseo 9.9.9 builds fixture\n");
});

test("another user's daemon is not this host's: the `paseo` on PATH decides instead", async (t) => {
  const other = paseoInstall(t, "9.9.9");
  const decoy = paseoInstall(t, "8.8.8");
  const plugin = fixture({ "index.server.ts": "export const x = 1;\n" });
  t.after(() => rmSync(plugin, { recursive: true, force: true }));
  const ps = fakePs(t, { ...daemonRun(other.shim), uid: UID + 1 });
  const { code, stdout } = await run(plugin, { PATH: pathWith(ps, dirname(decoy.shim)) });
  assert.equal(code, 0);
  assert.equal(stdout, "Paseo 8.8.8 builds fixture\n");
});

test("with no daemon in the process table, PASEO_CLI and then `paseo` on PATH decide", async (t) => {
  const cli = paseoInstall(t, "9.9.9");
  const onPath = paseoInstall(t, "8.8.8");
  const plugin = fixture({ "index.server.ts": "export const x = 1;\n" });
  t.after(() => rmSync(plugin, { recursive: true, force: true }));
  const ps = fakePs(t);

  const viaCli = await run(plugin, { PATH: pathWith(ps), PASEO_CLI: cli.bin });
  assert.equal(viaCli.code, 0, viaCli.stderr);
  assert.equal(viaCli.stdout, "Paseo 9.9.9 builds fixture\n");

  const viaPath = await run(plugin, { PATH: pathWith(ps, dirname(onPath.shim)) });
  assert.equal(viaPath.code, 0, viaPath.stderr);
  assert.equal(viaPath.stdout, "Paseo 8.8.8 builds fixture\n");
});

test("a PASEO_CLI that is not an @getpaseo/cli install falls through to the daemon's CLI", async (t) => {
  // A Paseo.app launcher: the app's own shim, not an install the check can read.
  const launcherDir = tempDir("paseo-launcher");
  t.after(() => rmSync(launcherDir, { recursive: true, force: true }));
  const launcher = join(launcherDir, "paseo");
  writeFileSync(launcher, "#!/bin/sh\nexit 1\n");
  chmodSync(launcher, 0o755);
  const daemon = paseoInstall(t, "9.9.9");
  const plugin = fixture({ "index.server.ts": "export const x = 1;\n" });
  t.after(() => rmSync(plugin, { recursive: true, force: true }));
  const { code, stdout } = await run(plugin, { PATH: pathWith(fakePs(t, daemonRun(daemon.shim))), PASEO_CLI: launcher });
  assert.equal(code, 0);
  assert.equal(stdout, "Paseo 9.9.9 builds fixture\n");
});

test("an unusable PASEO_BIN is an error, never silently another Paseo", async (t) => {
  const daemon = paseoInstall(t, "9.9.9");
  const plugin = fixture({ "index.server.ts": "export const x = 1;\n" });
  t.after(() => rmSync(plugin, { recursive: true, force: true }));
  const env = { PATH: pathWith(fakePs(t, daemonRun(daemon.shim)), dirname(daemon.shim)), PASEO_BIN: join(daemon.serverDir, "package.json") };
  const { code, stdout, stderr } = await run(plugin, env);
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /PASEO_BIN=.*is unusable \(.* is not inside an @getpaseo\/cli install\)/);
});

test("several Paseo daemons in the process table are named, not guessed", async (t) => {
  const one = paseoInstall(t, "9.9.9");
  const two = paseoInstall(t, "8.8.8");
  const plugin = fixture({ "index.server.ts": "export const x = 1;\n" });
  t.after(() => rmSync(plugin, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(plugin, { PATH: pathWith(fakePs(t, daemonRun(one.shim), daemonRun(two.shim))) });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /the process table shows 2 Paseo daemons \(.*\); set PASEO_BIN to the one to use/);
  assert.ok(stderr.includes(one.bin) && stderr.includes(two.bin), stderr);
});

test("PASEO_SERVER_DIR pins the server even when a daemon's CLI is in the process table", async (t) => {
  const daemon = paseoInstall(t, "9.9.9");
  const pinned = paseoInstall(t, "7.7.7");
  const plugin = fixture({ "index.server.ts": "export const x = 1;\n" });
  t.after(() => rmSync(plugin, { recursive: true, force: true }));
  const { code, stdout } = await run(plugin, { PATH: pathWith(fakePs(t, daemonRun(daemon.shim))), PASEO_SERVER_DIR: pinned.serverDir });
  assert.equal(code, 0);
  assert.equal(stdout, "Paseo 7.7.7 builds fixture\n");
});

test("parseProcessTable reads pid, ppid, uid and the command line, and skips anything else", () => {
  const rows = parseProcessTable(
    [
      "  1     0     0 /sbin/init",
      " 4242     1   501 /usr/bin/node /home/u/.paseo/runtime-patches/abc/node_modules/.bin/paseo daemon run",
      " 4243  4242   501 Paseo Supervisor",
      "",
      "  oops not a row",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, uid: 0, argv: ["/sbin/init"] },
    { pid: 4242, ppid: 1, uid: 501, argv: ["/usr/bin/node", "/home/u/.paseo/runtime-patches/abc/node_modules/.bin/paseo", "daemon", "run"] },
    { pid: 4243, ppid: 4242, uid: 501, argv: ["Paseo", "Supervisor"] },
  ]);
});

// Paseo's own verdicts, against the Paseo this host's daemon runs.

test("a shared module importing a Node module is refused as a shared-bundle violation", async (t) => {
  const dir = fixture({
    "index.server.ts": 'export { read } from "./shared/read.ts";\n',
    "shared/read.ts": 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(dir);
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("Node module cannot be imported into the plugin shared bundle"), stderr);
});

test("a module outside client/, server/ and shared/ is refused", async (t) => {
  const dir = fixture({
    "index.server.ts": 'import "./scripts/x.mjs";\n',
    "scripts/x.mjs": "export const x = 1;\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(dir);
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("Plugin modules belong in client/, server/, or shared/"), stderr);
});

test("a server entry importing a server module builds", async (t) => {
  const dir = fixture({
    "index.server.ts": 'export { x } from "./server/x.ts";\n',
    "server/x.ts": "export const x = 1;\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(dir);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /^Paseo \S+ builds fixture\n$/);
});

test("a Paseo without a plugin build entry is an error, not a pass", async (t) => {
  const dir = fixture({ "index.server.ts": "export const x = 1;\n" });
  const stub = tempDir("paseo-build-stub");
  writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@getpaseo/server", version: "9.9.9" }));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  });
  const { code, stdout, stderr } = await run(dir, { PASEO_SERVER_DIR: stub });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "Paseo 9.9.9 refuses fixture: Paseo 9.9.9 has no plugin build entry this check knows; update tools/paseo-build.mjs\n");
});