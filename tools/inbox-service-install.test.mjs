// tools/inbox-service-install.mjs end to end: a real build of the frontdoor bundle from the real
// plugin checkout, staged into a temporary install root, with launchctl/systemctl/tailscale stubs
// that keep their own state. Every assertion is about what the tool actually produced on disk or
// actually invoked -- the plist and unit it writes, the modes of its private files, the version
// symlink, the recorded supervisor calls -- never about the tool's own strings.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "inbox-service-install.mjs");
const PLUGIN = join(dirname(dirname(fileURLToPath(import.meta.url))), "linear-tickets");
const NODE = process.execPath;
const execFileAsync = promisify(execFile);
// The uid launchd domains are named by; the stubs only record it.
const UID = typeof process.getuid === "function" ? process.getuid() : 501;

// One stub shape: record every invocation, keep a little state so `print`/`is-active` tell the
// truth after `bootstrap`/`start`.
const LAUNCHCTL = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const [command] = process.argv.slice(2);
const state = process.env.STUB_STATE;
if (command === "print") { if (existsSync(state)) { console.log("state = running"); process.exit(0); } console.error("Could not find service"); process.exit(113); }
if (command === "bootstrap" || command === "kickstart") { writeFileSync(state, "loaded"); process.exit(0); }
if (command === "bootout") { rmSync(state, { force: true }); process.exit(0); }
process.exit(0);
`;
const SYSTEMCTL = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const [, command] = process.argv.slice(2);
const state = process.env.STUB_STATE;
if (command === "is-active") { console.log(existsSync(state) ? "active" : "inactive"); process.exit(existsSync(state) ? 0 : 3); }
if (command === "start") { writeFileSync(state, "active"); process.exit(0); }
if (command === "stop") { rmSync(state, { force: true }); process.exit(0); }
process.exit(0);
`;
const TAILSCALE = `#!/usr/bin/env node
if (process.argv.includes("--json")) { console.log(JSON.stringify({ Self: { DNSName: "host.tail1.ts.net." } })); process.exit(0); }
console.error("unsupported stub call"); process.exit(1);
`;
const TAILSCALE_BROKEN = `#!/usr/bin/env node
console.error("tailscaled is not running"); process.exit(1);
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paseo-inbox-install-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const write = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, body, { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  };
  return {
    root,
    home: join(root, "home"),
    installRoot: join(root, "install"),
    log: join(root, "calls.log"),
    state: join(root, "service.state"),
    bin: {
      launchctl: write("launchctl", LAUNCHCTL),
      systemctl: write("systemctl", SYSTEMCTL),
      tailscale: write("tailscale", TAILSCALE),
      tailscaleBroken: write("tailscale-broken", TAILSCALE_BROKEN),
    },
  };
}

function envFor(fixture_, overrides = {}) {
  return {
    ...process.env,
    HOME: fixture_.home,
    PASEO_HOME: join(fixture_.home, ".paseo"),
    STUB_LOG: fixture_.log,
    STUB_STATE: fixture_.state,
    INBOX_INSTALL_LAUNCHCTL: fixture_.bin.launchctl,
    INBOX_INSTALL_SYSTEMCTL: fixture_.bin.systemctl,
    INBOX_INSTALL_LOGINCTL: fixture_.bin.launchctl,
    INBOX_INSTALL_TAILSCALE: fixture_.bin.tailscale,
    ...overrides,
  };
}

// Asynchronous on purpose: a stub supervisor or listener may live in this very process, and a
// blocking spawn would starve it while the tool waits for an answer.
async function install(fixture_, args, overrides = {}) {
  const argv = [TOOL, ...args, "--install-root", fixture_.installRoot, "--paseo-home", join(fixture_.home, ".paseo")];
  try {
    const { stdout, stderr } = await execFileAsync(NODE, argv, { encoding: "utf8", env: envFor(fixture_, overrides), timeout: 120_000 });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message) };
  }
}

function calls(fixture_) {
  if (!existsSync(fixture_.log)) return [];
  return readFileSync(fixture_.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function config(fixture_) {
  return JSON.parse(readFileSync(join(fixture_.installRoot, "config.json"), "utf8"));
}

test("prepare builds a versioned standalone bundle and pins it with a private configuration", async () => {
  const fixture_ = fixture();
  try {
    const unexpectedHome = join(fixture_.root, "environment-home");
    const prepared = await install(fixture_, ["prepare", "--platform", "darwin"], { PASEO_HOME: unexpectedHome });
    assert.equal(prepared.status, 0, prepared.stderr);
    const settings = config(fixture_);
    assert.equal(statSync(join(fixture_.installRoot, "config.json")).mode & 0o777, 0o600);
    assert.equal(statSync(settings.stateDirectory).mode & 0o777, 0o700);
    // The version directory is content addressed, and `current` is one atomic symlink.
    const version = settings.installedVersion;
    const bundle = join(fixture_.installRoot, "versions", version, "inbox-frontdoor.mjs");
    assert.equal(readlinkSync(join(fixture_.installRoot, "current")), join("versions", version));
    assert.equal(createHash("sha256").update(readFileSync(bundle)).digest("hex").slice(0, 12), version);
    assert.equal(JSON.parse(readFileSync(join(fixture_.installRoot, "versions", version, "manifest.json"), "utf8")).version, version);
    // The private credential exists, is 0600 in a 0700 directory, and is high entropy.
    const credential = join(fixture_.home, ".paseo", "linear-tickets", "inbox-transport", "backend-secret");
    assert.equal(existsSync(unexpectedHome), false, "the explicit home must not write into the environment's home");
    assert.equal(statSync(credential).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(credential)).mode & 0o777, 0o700);
    assert.match(readFileSync(credential, "utf8"), /^[A-Za-z0-9_-]{43}$/);
    // The staged artifact runs outside the plugin checkout, with no dependency on its node_modules.
    const check = await execFileAsync(NODE, [join(fixture_.installRoot, "current", "inbox-frontdoor.mjs"), "--check"], { encoding: "utf8", cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" }, timeout: 60_000 });
    const report = JSON.parse(check.stdout);
    assert.equal(report.protocolVersion, 1);
    assert.equal(report.digest, JSON.parse(readFileSync(join(fixture_.installRoot, "versions", version, "manifest.json"), "utf8")).digest);
    // Preparing again is idempotent and never starts anything.
    const again = await install(fixture_, ["prepare", "--platform", "darwin"]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(config(fixture_).installedVersion, version);
    assert.deepEqual(calls(fixture_), []);
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("install registers the launchd agent without starting it", async () => {
  const fixture_ = fixture();
  try {
    const installed = await install(fixture_, ["install", "--platform", "darwin"]);
    assert.equal(installed.status, 0, installed.stderr);
    const plist = join(fixture_.home, "Library", "LaunchAgents", "sh.paseo.inbox-frontdoor.plist");
    assert.ok(existsSync(plist), "the agent file exists for the next login");
    const body = readFileSync(plist, "utf8");
    assert.match(body, new RegExp(`<string>${NODE}</string>`));
    assert.match(body, new RegExp(`<string>${join(fixture_.installRoot, "current", "inbox-frontdoor.mjs")}</string>`));
    assert.match(body, new RegExp(`<string>${join(fixture_.installRoot, "config.json")}</string>`));
    assert.match(body, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(body, /<key>KeepAlive<\/key><true\/>/);
    assert.match(body, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
    assert.match(body, new RegExp(`<string>${join(fixture_.installRoot, "logs", "frontdoor.err.log")}</string>`));
    assert.match(installed.stdout, /not started/);
    assert.deepEqual(calls(fixture_), [], "installing staged the service: nothing was started");
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("install registers the systemd user unit enabled but not started", async () => {
  const fixture_ = fixture();
  try {
    const installed = await install(fixture_, ["install", "--platform", "linux"]);
    assert.equal(installed.status, 0, installed.stderr);
    const unit = join(fixture_.home, ".config", "systemd", "user", "paseo-inbox-frontdoor.service");
    const body = readFileSync(unit, "utf8");
    assert.match(body, new RegExp(`ExecStart=${NODE} ${join(fixture_.installRoot, "current", "inbox-frontdoor.mjs")} ${join(fixture_.installRoot, "config.json")}`));
    assert.match(body, new RegExp(`Environment=PASEO_HOME=${join(fixture_.home, ".paseo")}`));
    assert.match(body, /Restart=always\nRestartSec=5\nTimeoutStopSec=15/);
    assert.match(body, /WantedBy=default.target/);
    assert.deepEqual(calls(fixture_), [["--user", "daemon-reload"], ["--user", "enable", "paseo-inbox-frontdoor.service"]]);
    assert.equal(calls(fixture_).some((command) => command.includes("start")), false);
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("start and stop drive the supervisor and report what answers", async () => {
  const fixture_ = fixture();
  try {
    assert.equal((await install(fixture_, ["install", "--platform", "darwin"])).status, 0);
    const port = await freePort();
    const service = availabilityServer(port);
    await service.listen;
    try {
      const first = await install(fixture_, ["start", "--platform", "darwin", "--port", String(port)]);
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual(calls(fixture_)[0], ["print", `gui/${UID}/sh.paseo.inbox-frontdoor`]);
      assert.deepEqual(calls(fixture_)[1], ["bootstrap", `gui/${UID}`, join(fixture_.home, "Library", "LaunchAgents", "sh.paseo.inbox-frontdoor.plist")]);
      assert.match(first.stdout, new RegExp(`frontdoor answered on 127\\.0\\.0\\.1:${port}:`));
      const second = await install(fixture_, ["start", "--platform", "darwin", "--port", String(port)]);
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(calls(fixture_).at(-1), ["kickstart", "-k", `gui/${UID}/sh.paseo.inbox-frontdoor`]);
      const status = await install(fixture_, ["status", "--platform", "darwin", "--port", String(port)]);
      const state = JSON.parse(status.stdout);
      assert.equal(state.supervisorInstalled, true);
      assert.equal(state.service, "loaded");
      assert.equal(state.frontdoor.status, 200);
      assert.equal(state.frontdoor.availability.readOnly, false);
      assert.equal(state.versionIntact, true);
      const stopped = await install(fixture_, ["stop", "--platform", "darwin"]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.deepEqual(calls(fixture_).at(-1), ["bootout", `gui/${UID}`, join(fixture_.home, "Library", "LaunchAgents", "sh.paseo.inbox-frontdoor.plist")]);
      assert.equal(JSON.parse((await install(fixture_, ["status", "--platform", "darwin", "--port", String(port)])).stdout).service, "not loaded");
    } finally { service.close(); }
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("rollback points the service at another staged version and refuses an unknown one", async () => {
  const fixture_ = fixture();
  try {
    assert.equal((await install(fixture_, ["install", "--platform", "darwin", "--origin", "https://pinned.tail1.ts.net:9444", "--port", "49131", "--backend-port", "49132", "--state-directory", join(fixture_.root, "pinned-state")])).status, 0);
    const installed = config(fixture_);
    const current = config(fixture_).installedVersion;
    writeFileSync(fixture_.state, "loaded");
    // A later staged version the rollback tool finds by its own directory.
    const target = join(fixture_.installRoot, "versions", "111111111111");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "inbox-frontdoor.mjs"), readFileSync(join(fixture_.installRoot, "versions", current, "inbox-frontdoor.mjs")));
    const unknown = await install(fixture_, ["rollback", "--platform", "darwin", "--version", "does-not-exist"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /is not staged/);
    const rolled = await install(fixture_, ["rollback", "--platform", "darwin"]);
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(readlinkSync(join(fixture_.installRoot, "current")), join("versions", "111111111111"));
    assert.equal(config(fixture_).installedVersion, "111111111111");
    const restored = config(fixture_);
    assert.deepEqual({ ...restored, installedVersion: installed.installedVersion, installedAt: installed.installedAt }, installed, "rollback preserves every installed setting");
    assert.equal(calls(fixture_).some((command) => command[0] === "kickstart"), true, "a running service is restarted onto the rolled-back version");
    assert.equal(JSON.parse((await install(fixture_, ["status", "--platform", "darwin"])).stdout).version, "111111111111");
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("rollback refuses an invalid installed configuration before changing the active bundle", async () => {
  const fixture_ = fixture();
  try {
    const prepared = await install(fixture_, ["install", "--platform", "darwin"]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const active = readlinkSync(join(fixture_.installRoot, "current"));
    const target = join(fixture_.installRoot, "versions", "111111111111");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "inbox-frontdoor.mjs"), readFileSync(join(fixture_.installRoot, active, "inbox-frontdoor.mjs")));
    writeFileSync(join(fixture_.installRoot, "config.json"), JSON.stringify({ version: 9 }));
    writeFileSync(fixture_.state, "loaded");
    const beforeCalls = calls(fixture_);
    const refused = await install(fixture_, ["rollback", "--platform", "darwin"]);
    assert.equal(refused.status, 1);
    assert.equal(readlinkSync(join(fixture_.installRoot, "current")), active);
    assert.deepEqual(config(fixture_), { version: 9 });
    assert.deepEqual(calls(fixture_), beforeCalls);
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("uninstall deregisters and removes its own files, keeping the shared credential", async () => {
  const fixture_ = fixture();
  try {
    assert.equal((await install(fixture_, ["install", "--platform", "linux"])).status, 0);
    const credential = config(fixture_).credentialFile;
    const removed = await install(fixture_, ["uninstall", "--platform", "linux"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(fixture_.installRoot), false);
    assert.equal(existsSync(join(fixture_.home, ".config", "systemd", "user", "paseo-inbox-frontdoor.service")), false);
    assert.equal(existsSync(credential), true, "the plugin's own credential stays");
    assert.deepEqual(calls(fixture_).filter((command) => command.includes("disable")), [["--user", "disable", "paseo-inbox-frontdoor.service"]]);
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("the installer refuses to guess: no origin, no esbuild, no staged service", async () => {
  const fixture_ = fixture();
  try {
    const noOrigin = await install(fixture_, ["prepare", "--platform", "darwin"], { INBOX_INSTALL_TAILSCALE: fixture_.bin.tailscaleBroken });
    assert.equal(noOrigin.status, 1);
    assert.match(noOrigin.stderr, /Could not read this host's tailnet origin/);
    // A fixture plugin without an installed dependency tree is refused with the fix, not built by
    // accident.
    const bare = join(fixture_.root, "bare-plugin");
    mkdirSync(join(bare, "server"), { recursive: true });
    writeFileSync(join(bare, "server", "inbox-frontdoor-main.ts"), "export {};\n");
    const noEsbuild = await install(fixture_, ["prepare", "--platform", "darwin", "--plugin-dir", bare]);
    assert.equal(noEsbuild.status, 1);
    assert.match(noEsbuild.stderr, /esbuild was not found/);
    assert.match(noEsbuild.stderr, /npm ci/);
    const notAPlugin = join(fixture_.root, "not-a-plugin");
    mkdirSync(notAPlugin, { recursive: true });
    assert.match((await install(fixture_, ["prepare", "--platform", "darwin", "--plugin-dir", notAPlugin])).stderr, /does not look like the linear-tickets plugin/);
    const notInstalled = await install(fixture_, ["start", "--platform", "darwin"]);
    assert.equal(notInstalled.status, 1);
    assert.match(notInstalled.stderr, /run `install` first/);
    const wrongCommand = await install(fixture_, ["frobnicate"]);
    assert.equal(wrongCommand.status, 64);
    assert.match(wrongCommand.stderr, /usage:/);
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("the origin can be pinned explicitly, so the tool never depends on a live tailscaled", async () => {
  const fixture_ = fixture();
  try {
    const prepared = await install(fixture_, ["prepare", "--platform", "linux", "--origin", "https://server087.tail1.ts.net:8444"], { INBOX_INSTALL_TAILSCALE: fixture_.bin.tailscaleBroken });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(config(fixture_).publicOrigin, "https://server087.tail1.ts.net:8444");
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("prepare reports a real build failure instead of installing a broken bundle", async () => {
  const fixture_ = fixture();
  try {
    const broken = join(fixture_.root, "broken-plugin");
    mkdirSync(join(broken, "server"), { recursive: true });
    mkdirSync(join(broken, "node_modules", "esbuild", "bin"), { recursive: true });
    writeFileSync(join(broken, "node_modules", "esbuild", "bin", "esbuild"), "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
    writeFileSync(join(broken, "server", "inbox-frontdoor-main.ts"), "export {};\n");
    const failed = await install(fixture_, ["prepare", "--platform", "darwin", "--plugin-dir", broken]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /building the inbox frontdoor bundle/);
    assert.equal(existsSync(join(fixture_.installRoot, "config.json")), false, "nothing was pinned");
    assert.equal(existsSync(join(fixture_.installRoot, "current")), false, "nothing was activated");
  } finally {
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

test("the installed bundle boots from the configuration the installer wrote", async () => {
  const fixture_ = fixture();
  const backendPort = await freePort();
  const frontdoorPort = await freePort();
  // The credential file the installer generates, read where it lives: the same private path the
  // installed bundle resolves, so a mismatch shows up as the 401 the frontdoor would report.
  const backend = createServer((request, response) => {
    const answer = (value) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    let secret = "";
    try { secret = readFileSync(join(fixture_.home, ".paseo", "linear-tickets", "inbox-transport", "backend-secret"), "utf8"); } catch { secret = ""; }
    if (!secret || request.headers["x-paseo-inbox-auth"] !== secret) return response.writeHead(401).end();
    if (request.url === "/_inbox/ready") return answer({ protocolVersion: 1, instanceId: "installed-check", state: "ready" });
    if (request.url === "/_inbox/snapshot") return answer({ protocolVersion: 1, instanceId: "installed-check", capturedAt: new Date().toISOString(), inbox: { open: [], decided: [], applying: [], unreachable: [], hosts: [], push: false }, decisions: { hosts: [], canonicalHost: null, unreachable: [] } });
    return response.writeHead(404).end();
  });
  await new Promise((resolve) => backend.listen(backendPort, "127.0.0.1", resolve));
  let child = null;
  try {
    // The credential the installer generated is already on disk before this prepare, exactly as
    // it is on a real host; the bundle reads the same file the stub backend checks.
    const installed = await install(fixture_, ["install", "--platform", "linux", "--port", String(frontdoorPort), "--backend-port", String(backendPort)]);
    assert.equal(installed.status, 0, installed.stderr);
    child = spawn(NODE, [join(fixture_.installRoot, "current", "inbox-frontdoor.mjs"), join(fixture_.installRoot, "config.json")], { env: { HOME: fixture_.home, PASEO_HOME: join(fixture_.home, ".paseo"), PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const availability = await waitFor(async () => {
      try {
        const answer = await fetch(`http://127.0.0.1:${frontdoorPort}/api/inbox/availability`);
        return answer.status === 200 ? await answer.json() : null;
      } catch { return null; }
    });
    assert.equal(availability.backendState, "ready", output);
    assert.equal(availability.stale, false, output);
    const page = await (await fetch(`http://127.0.0.1:${frontdoorPort}/`)).text();
    assert.match(page, /<title>Plan reviews<\/title>/, output);
    // SIGTERM is what launchd sends: the frontdoor exits cleanly and the port is free again.
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, output);
    child = null;
  } finally {
    child?.kill("SIGKILL");
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    rmSync(fixture_.root, { recursive: true, force: true });
  }
});

function waitFor(probe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error("the installed frontdoor did not answer in time");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// A stand-in for the running frontdoor's availability route, so `status` is checked against a real
// listener rather than an invented one.
function availabilityServer(port) {
  const server = createServer((request, response) => {
    if (request.url === "/api/inbox/availability") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ protocolVersion: 1, backendState: "ready", instanceId: "i", capturedAt: "2026-01-01T00:00:00.000Z", lastCheckedAt: "2026-01-01T00:00:00.000Z", stale: false, readOnly: false, reason: null }));
      return;
    }
    response.writeHead(404).end();
  });
  return {
    close: () => server.close(),
    listen: new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
  };
}
