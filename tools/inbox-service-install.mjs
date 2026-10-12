#!/usr/bin/env node
// Installs the persistent inbox frontdoor (README, "Inbox transport") on this host: a versioned
// standalone bundle of 127.0.0.1:47832 and the tailnet origin :8444, plus a user-level supervisor
// (launchd on macOS, `systemd --user` on Linux) that starts it at login and keeps it running while
// the plugin reloads. The plugin itself keeps serving the checked inbox backend on 47834.
//
//   node tools/inbox-service-install.mjs prepare   [options]   build + stage the bundle, write config
//   node tools/inbox-service-install.mjs install   [options]   prepare, then register the supervisor
//   node tools/inbox-service-install.mjs start     [options]   start the supervised frontdoor
//   node tools/inbox-service-install.mjs stop      [options]   stop it (registration stays)
//   node tools/inbox-service-install.mjs status    [options]   installed version, service and port state
//   node tools/inbox-service-install.mjs rollback  [options]   point at a previous version, restart
//   node tools/inbox-service-install.mjs uninstall [options]   stop, deregister, remove the install root
//   node tools/inbox-service-install.mjs run       [options]   run the installed bundle in the foreground
//
// Nothing here touches the running plugin: with the plugin still owning 127.0.0.1:47832, `install`
// leaves the service prepared but not started, and `start` binds only after that listener is
// released (a busy port is an explicit failure, never a kill). The coordinated cutover -- a
// plugin rollout that drops :8444 publication and moves the backend to 47834, then `start`, then
// `tailscale serve --https=8444 http://127.0.0.1:47832` -- is the parent's to run; this tool never
// changes Serve configuration itself and never enables Funnel.
//
//   options: --plugin-dir <dir>   the linear-tickets source to build from (default ../linear-tickets)
//            --install-root <dir> where versions/config/logs/state live (default <paseo-home>/inbox-frontdoor)
//            --paseo-home <dir>   the shared plugin state (default $PASEO_HOME or ~/.paseo)
//            --node <path>        the absolute node to pin (default this process's)
//            --origin <url>       the public origin (default https://<tailnet DNS name>:8444)
//            --port <n>           the browser-facing loopback port (default 47832)
//            --backend-port <n>   the checked backend port (default 47834)
//            --state-directory <dir>  the snapshot cache directory (default <install-root>/state)
//            --version <id>       rollback target (default: the newest version that is not current)
//            --platform <name>    darwin|linux supervisor to install (default this host's)
//            --linger             Linux: also enable user lingering (survives SSH logout)
//            --print-config       prepare/install: print the configuration JSON
//
// Run `install`, `start`, `stop`, `rollback` and `uninstall` under the host rollout lock
// (tools/flock.py, the same lock tools/plugin-rollout.mjs uses): that is the one rollout at a time.
//
// Test overrides: INBOX_INSTALL_LAUNCHCTL, INBOX_INSTALL_SYSTEMCTL, INBOX_INSTALL_LOGINCTL,
// INBOX_INSTALL_TAILSCALE name the binaries (a stub records its calls and exits 0).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));
// The fixed user-level service identity; one frontdoor per host.
export const SERVICE_LABEL = "sh.paseo.inbox-frontdoor";
export const LINUX_UNIT = "paseo-inbox-frontdoor.service";
export const FRONTDOOR_PORT = 47_832;
export const BACKEND_PORT = 47_834;
const REVIEW_TAILNET = 8444;

class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function commandFor(env, name, fallback) {
  return env[name] || fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 60_000, cwd: options.cwd, env: options.env ?? process.env });
  if (result.error) throw new Fail(`${command} could not run: ${result.error.message}`);
  return result;
}

function runOk(command, args, what, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Fail(`${what} failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim().split("\n")[0]}`);
  return result;
}

// The same derivation the plugin uses (server/tailscale.ts): this host's own tailnet name.
function tailnetOrigin(env, port) {
  const binary = commandFor(env, "INBOX_INSTALL_TAILSCALE", "tailscale");
  const result = run(binary, ["status", "--json"], { timeout: 8_000 });
  if (result.error || result.status !== 0) return null;
  try {
    const dns = String(JSON.parse(result.stdout).Self?.DNSName ?? "").replace(/\.$/, "");
    return dns ? `https://${dns}:${port}` : null;
  } catch { return null; }
}

export function settingsFrom(env = process.env, argv = []) {
  const flags = {};
  const command = argv[0];
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--linger") { flags.linger = true; continue; }
    if (flag === "--print-config") { flags.printConfig = true; continue; }
    const name = flag.replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!["pluginDir", "installRoot", "paseoHome", "node", "origin", "port", "backendPort", "stateDirectory", "version", "platform"].includes(name)) throw new Fail(`unknown option ${flag}`, 64);
    const value = argv[++index];
    if (value === undefined) throw new Fail(`${flag} needs a value`, 64);
    flags[name] = value;
  }
  const home = resolve(String(flags.paseoHome ?? env.PASEO_HOME ?? join(homedir(), ".paseo")).replace(/^~(?=\/|$)/, homedir()));
  const installRoot = resolve(flags.installRoot ?? join(home, "inbox-frontdoor"));
  const pluginDir = resolve(flags.pluginDir ?? join(dirname(TOOLS), "linear-tickets"));
  const platform = flags.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Fail(`--platform must be darwin or linux (got ${platform})`, 64);
  const loopbackPort = Number(flags.port ?? FRONTDOOR_PORT);
  const backendPort = Number(flags.backendPort ?? BACKEND_PORT);
  if (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65_535) throw new Fail(`--port must be a port number (got ${flags.port})`, 64);
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65_535) throw new Fail(`--backend-port must be a port number (got ${flags.backendPort})`, 64);
  return {
    command,
    home,
    pluginDir,
    installRoot,
    versionsDirectory: join(installRoot, "versions"),
    currentLink: join(installRoot, "current"),
    configPath: join(installRoot, "config.json"),
    logDirectory: join(installRoot, "logs"),
    stateDirectory: resolve(flags.stateDirectory ?? join(installRoot, "state")),
    credentialFile: join(home, "linear-tickets", "inbox-transport", "backend-secret"),
    nodeBinary: resolve(flags.node ?? process.execPath),
    publicOrigin: flags.origin ?? tailnetOrigin(env, REVIEW_TAILNET),
    loopbackPort,
    backendPort,
    platform,
    rollbackVersion: flags.version,
    linger: Boolean(flags.linger),
    printConfig: Boolean(flags.printConfig),
    env,
  };
}

function supervisorDirectory(platform) {
  return platform === "darwin" ? join(homedir(), "Library", "LaunchAgents") : join(homedir(), ".config", "systemd", "user");
}

function supervisorPath(platform) {
  return join(supervisorDirectory(platform), platform === "darwin" ? `${SERVICE_LABEL}.plist` : LINUX_UNIT);
}

export function plistFor(settings) {
  const entry = join(settings.installRoot, "current", "inbox-frontdoor.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${settings.nodeBinary}</string><string>${entry}</string><string>${settings.configPath}</string></array>
  <key>EnvironmentVariables</key><dict><key>PASEO_HOME</key><string>${settings.home}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>${settings.installRoot}</string>
  <key>StandardOutPath</key><string>${join(settings.logDirectory, "frontdoor.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(settings.logDirectory, "frontdoor.err.log")}</string>
</dict></plist>
`;
}

export function unitFor(settings) {
  const entry = join(settings.installRoot, "current", "inbox-frontdoor.mjs");
  return `[Unit]
Description=Paseo inbox frontdoor (localhost:${settings.loopbackPort} for ${settings.publicOrigin})
After=network-online.target

[Service]
Type=simple
ExecStart=${settings.nodeBinary} ${entry} ${settings.configPath}
Environment=PASEO_HOME=${settings.home}
WorkingDirectory=${settings.installRoot}
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

export function configFor(settings, version) {
  return {
    version: 1,
    bundle: join(settings.installRoot, "current", "inbox-frontdoor.mjs"),
    host: hostname(),
    publicOrigin: settings.publicOrigin,
    loopbackPort: settings.loopbackPort,
    backendPort: settings.backendPort,
    stateDirectory: settings.stateDirectory,
    credentialFile: settings.credentialFile,
    node: settings.nodeBinary,
    installedVersion: version,
    installedAt: new Date().toISOString(),
  };
}

function writeAtomic(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

// The private credential both the frontdoor and the plugin authenticate with; created once, never
// rewritten, so a second creator cannot silently invalidate the first.
function ensureCredential(path) {
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (existsSync(path)) return { path, created: false };
    throw error;
  }
  return { path, created: true };
}

// esbuild's npm bin is the platform binary itself (or a thin launcher); run it directly and fall
// back to the interpreter only for a launcher layout that the shell could not execute.
function runEsbuild(settings, esbuild, args, what) {
  const direct = run(esbuild, args, { cwd: settings.pluginDir });
  const unusable = direct.error && (direct.error.code === "EACCES" || direct.error.code === "ENOEXEC");
  const result = unusable ? run(settings.nodeBinary, [esbuild, ...args], { cwd: settings.pluginDir }) : direct;
  if (result.status !== 0) throw new Fail(`${what} failed (exit ${result.status ?? result.error?.code}): ${(result.stderr || result.stdout || "").trim().split("\n")[0]}`);
  return result;
}

function locateEsbuild(pluginDir) {
  for (const candidate of [join(pluginDir, "node_modules", "esbuild", "bin", "esbuild"), join(pluginDir, "node_modules", ".bin", "esbuild")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Fail(`esbuild was not found under ${join(pluginDir, "node_modules")}; run \`npm ci\` in ${pluginDir} first (its tsx dependency installs esbuild).`);
}

function bundleEntry(pluginDir) {
  const entry = join(pluginDir, "server", "inbox-frontdoor-main.ts");
  if (!existsSync(entry)) throw new Fail(`${pluginDir} does not look like the linear-tickets plugin (no server/inbox-frontdoor-main.ts)`);
  return entry;
}

function versionDirectories(settings) {
  if (!existsSync(settings.versionsDirectory)) return [];
  return readdirSync(settings.versionsDirectory).map((name) => join(settings.versionsDirectory, name))
    .filter((directory) => existsSync(join(directory, "inbox-frontdoor.mjs")))
    .map((directory) => ({ directory, name: basename(directory), at: statSync(join(directory, "inbox-frontdoor.mjs")).mtimeMs }))
    .sort((a, b) => b.at - a.at);
}

function currentVersion(settings) {
  try {
    const target = readlinkSync(settings.currentLink);
    return basename(target);
  } catch { return null; }
}

function installedVersion(settings) {
  const name = currentVersion(settings);
  if (!name) return null;
  const file = join(settings.versionsDirectory, name, "inbox-frontdoor.mjs");
  if (!existsSync(file)) return null;
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
  return { name, file, digest, matches: digest === name };
}

// --------------------------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------------------------

function prepare(settings) {
  if (!settings.publicOrigin) throw new Fail("Could not read this host's tailnet origin from `tailscale status --json`; pass --origin https://<machine>.<tailnet>.ts.net:8444", 1);
  const entry = bundleEntry(settings.pluginDir);
  const esbuild = locateEsbuild(settings.pluginDir);
  const staging = join(settings.installRoot, `.staging-${process.pid}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const staged = join(staging, "inbox-frontdoor.mjs");
  try {
    runEsbuild(settings, esbuild, [entry, "--bundle", "--platform=node", "--format=esm", "--target=node22", `--outfile=${staged}`, "--log-level=warning"], `building the inbox frontdoor bundle in ${settings.pluginDir}`);
    const bytes = readFileSync(staged);
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    // The built artifact proves itself before anything is staged: it must run outside the plugin
    // checkout (a temporary working directory, no NODE_PATH) and render both existing pages.
    const check = runOk(settings.nodeBinary, [staged, "--check"], "checking the built inbox frontdoor bundle", { cwd: tmpdir(), env: { PATH: settings.env.PATH ?? "/usr/bin:/bin" } });
    let report;
    try { report = JSON.parse(check.stdout); } catch { throw new Fail(`the built bundle's --check did not print a report: ${check.stdout.trim().slice(0, 200)}`); }
    if (report.protocolVersion !== 1 || !(report.reviewBytes > 0) || !(report.decisionBytes > 0)) throw new Fail(`the built bundle's --check reported ${check.stdout.trim()}`);
    const directory = join(settings.versionsDirectory, version);
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    const target = join(directory, "inbox-frontdoor.mjs");
    if (!existsSync(target)) renameSync(staged, target);
    writeAtomic(join(directory, "manifest.json"), JSON.stringify({ version, digest: report.digest, protocolVersion: report.protocolVersion, builtFrom: settings.pluginDir, node: settings.nodeBinary, builtAt: new Date().toISOString() }, null, 2), 0o644);
    // The active version switches atomically: an installed service is never mid-write.
    const linking = `${settings.currentLink}.${process.pid}.tmp`;
    rmSync(linking, { force: true });
    symlinkSync(join("versions", version), linking);
    renameSync(linking, settings.currentLink);
    mkdirSync(settings.stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(settings.stateDirectory, 0o700);
    mkdirSync(settings.logDirectory, { recursive: true, mode: 0o700 });
    chmodSync(settings.logDirectory, 0o700);
    writeAtomic(settings.configPath, JSON.stringify(configFor(settings, version), null, 2), 0o600);
    const credential = ensureCredential(settings.credentialFile);
    return { version, entries: [target, settings.configPath], credential, report };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function install(settings) {
  const prepared = prepare(settings);
  const path = supervisorPath(settings.platform);
  const body = settings.platform === "darwin" ? plistFor(settings) : unitFor(settings);
  writeAtomic(path, body, 0o644);
  if (settings.platform === "linux") {
    const systemctl = commandFor(settings.env, "INBOX_INSTALL_SYSTEMCTL", "systemctl");
    runOk(systemctl, ["--user", "daemon-reload"], "systemctl --user daemon-reload");
    runOk(systemctl, ["--user", "enable", LINUX_UNIT], `enabling ${LINUX_UNIT}`);
    if (settings.linger) {
      const loginctl = commandFor(settings.env, "INBOX_INSTALL_LOGINCTL", "loginctl");
      const user = userInfo().username;
      const result = run(loginctl, ["enable-linger", user]);
      if (result.status !== 0) console.error(`[inbox-service] enabling lingering for ${user} failed (exit ${result.status}); availability after logout needs it: ${(result.stderr || "").trim()}`);
    }
  }
  return { prepared, supervisor: path };
}

function serviceState(settings) {
  if (settings.platform === "darwin") {
    const launchctl = commandFor(settings.env, "INBOX_INSTALL_LAUNCHCTL", "launchctl");
    const result = run(launchctl, ["print", `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`]);
    return result.status === 0 ? "loaded" : "not loaded";
  }
  const systemctl = commandFor(settings.env, "INBOX_INSTALL_SYSTEMCTL", "systemctl");
  const result = run(systemctl, ["--user", "is-active", LINUX_UNIT]);
  return (result.stdout || "").trim() || (result.status === 0 ? "active" : "inactive");
}

function start(settings) {
  if (!existsSync(supervisorPath(settings.platform))) throw new Fail(`nothing is installed for ${settings.installRoot}; run \`install\` first`);
  if (settings.platform === "darwin") {
    const launchctl = commandFor(settings.env, "INBOX_INSTALL_LAUNCHCTL", "launchctl");
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const already = run(launchctl, ["print", `${domain}/${SERVICE_LABEL}`]).status === 0;
    runOk(launchctl, already ? ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`] : ["bootstrap", domain, supervisorPath("darwin")], "starting the inbox frontdoor");
  } else {
    const systemctl = commandFor(settings.env, "INBOX_INSTALL_SYSTEMCTL", "systemctl");
    runOk(systemctl, ["--user", "start", LINUX_UNIT], "starting the inbox frontdoor");
  }
}

function stop(settings) {
  if (settings.platform === "darwin") {
    const launchctl = commandFor(settings.env, "INBOX_INSTALL_LAUNCHCTL", "launchctl");
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const result = run(launchctl, ["bootout", domain, supervisorPath("darwin")]);
    if (result.status !== 0 && !/no such process|could not find/i.test(`${result.stderr}${result.stdout}`)) throw new Fail(`stopping the inbox frontdoor failed (exit ${result.status}): ${(result.stderr || "").trim().split("\n")[0]}`);
    return;
  }
  const systemctl = commandFor(settings.env, "INBOX_INSTALL_SYSTEMCTL", "systemctl");
  runOk(systemctl, ["--user", "stop", LINUX_UNIT], "stopping the inbox frontdoor");
}

// The configuration the service was installed with; a rollback without it would invent defaults.
function installedConfig(settings) {
  let value;
  try { value = JSON.parse(readFileSync(settings.configPath, "utf8")); } catch (error) {
    throw new Fail(`reading the installed configuration ${settings.configPath} failed (${error instanceof Error ? error.message : error}); nothing was changed`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) throw new Fail(`${settings.configPath} is not an inbox frontdoor configuration version 1; nothing was changed`);
  return value;
}

function rollback(settings) {
  const versions = versionDirectories(settings);
  if (!versions.length) throw new Fail(`no version is staged under ${settings.versionsDirectory}`);
  const active = installedVersion(settings);
  const target = settings.rollbackVersion
    ? versions.find((version) => version.name === settings.rollbackVersion)
    : versions.find((version) => version.name !== active?.name);
  if (!target) throw new Fail(settings.rollbackVersion ? `version ${settings.rollbackVersion} is not staged under ${settings.versionsDirectory}` : "there is no earlier version to roll back to");
  const installed = installedConfig(settings);
  const linking = `${settings.currentLink}.${process.pid}.tmp`;
  rmSync(linking, { force: true });
  symlinkSync(join("versions", target.name), linking);
  renameSync(linking, settings.currentLink);
  // A rollback changes the bundle and its version metadata, never the installed configuration: the
  // ports, origin, state directory, credential and pinned node stay exactly as installed (a rebuild
  // from this command's defaults could bind the wrong port or lose the snapshot cache).
  writeAtomic(settings.configPath, JSON.stringify({
    ...installed,
    bundle: join(settings.installRoot, "current", "inbox-frontdoor.mjs"),
    installedVersion: target.name,
    installedAt: new Date().toISOString(),
  }, null, 2), 0o600);
  if (serviceState(settings) === "loaded" || serviceState(settings) === "active") {
    if (settings.platform === "darwin") {
      const launchctl = commandFor(settings.env, "INBOX_INSTALL_LAUNCHCTL", "launchctl");
      runOk(launchctl, ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`], "restarting the inbox frontdoor");
    } else {
      const systemctl = commandFor(settings.env, "INBOX_INSTALL_SYSTEMCTL", "systemctl");
      runOk(systemctl, ["--user", "restart", LINUX_UNIT], "restarting the inbox frontdoor");
    }
  }
  return target.name;
}

function uninstall(settings) {
  if (existsSync(supervisorPath(settings.platform))) {
    try { stop(settings); } catch (error) { console.error(`[inbox-service] stopping before uninstall: ${error.message}`); }
    rmSync(supervisorPath(settings.platform), { force: true });
  }
  if (settings.platform === "linux") {
    const systemctl = commandFor(settings.env, "INBOX_INSTALL_SYSTEMCTL", "systemctl");
    run(systemctl, ["--user", "disable", LINUX_UNIT]);
    run(systemctl, ["--user", "daemon-reload"]);
  }
  rmSync(settings.installRoot, { recursive: true, force: true });
  return { root: settings.installRoot, credential: settings.credentialFile };
}

async function probe(port, path) {
  const { request } = await import("node:http");
  return await new Promise((resolve) => {
    const call = request({ host: "127.0.0.1", port, path, timeout: 2_000, headers: { host: `127.0.0.1:${port}` } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    call.on("timeout", () => call.destroy(new Error("deadline exceeded")));
    call.on("error", (error) => resolve({ status: 0, body: "", error: error.message }));
    call.end();
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const settings = settingsFrom(env, argv);
  switch (settings.command) {
    case "prepare": {
      const result = prepare(settings);
      console.log(`[inbox-service] staged frontdoor ${result.version} at ${join(settings.versionsDirectory, result.version)}`);
      console.log(`[inbox-service] configuration ${settings.configPath} (0600), credential ${result.credential.path}${result.credential.created ? " (created)" : ""}`);
      console.log(`[inbox-service] ${settings.publicOrigin} will reach 127.0.0.1:${settings.loopbackPort}; the checked backend stays on 127.0.0.1:${settings.backendPort}`);
      console.log(`[inbox-service] nothing was started and no listener was touched; run \`install\` to register the supervisor`);
      if (settings.printConfig) console.log(readFileSync(settings.configPath, "utf8").trim());
      return 0;
    }
    case "install": {
      const result = install(settings);
      const command = settings.platform === "darwin"
        ? `launchctl bootstrap gui/${process.getuid?.() ?? 0} ${result.supervisor}`
        : `systemctl --user start ${LINUX_UNIT}`;
      console.log(`[inbox-service] frontdoor ${result.prepared.version} installed; supervisor ${result.supervisor}`);
      console.log(`[inbox-service] registration only: the service is not started (the plugin may still own 127.0.0.1:${settings.loopbackPort})`);
      console.log(`[inbox-service] cutover: 1) node tools/inbox-service-install.mjs start  2) tailscale serve --https=${REVIEW_TAILNET} http://127.0.0.1:${settings.loopbackPort}`);
      console.log(`[inbox-service] on this host that start is: ${command}`);
      if (settings.printConfig) console.log(readFileSync(settings.configPath, "utf8").trim());
      return 0;
    }
    case "start": {
      start(settings);
      const answer = await probe(settings.loopbackPort, "/api/inbox/availability");
      console.log(answer.status === 200
        ? `[inbox-service] frontdoor answered on 127.0.0.1:${settings.loopbackPort}: ${answer.body.slice(0, 200)}`
        : `[inbox-service] started, but 127.0.0.1:${settings.loopbackPort} has not answered yet${answer.error ? ` (${answer.error})` : ""}; the supervisor retries, and a busy port means the plugin still owns it`);
      return 0;
    }
    case "stop": {
      stop(settings);
      console.log(`[inbox-service] stopped; the supervisor registration stays`);
      return 0;
    }
    case "status": {
      const installed = installedVersion(settings);
      const supervisor = supervisorPath(settings.platform);
      const list = await probe(settings.loopbackPort, "/api/inbox/availability");
      const backend = await probe(settings.backendPort, "/_inbox/ready");
      console.log(JSON.stringify({
        installRoot: settings.installRoot,
        version: installed?.name ?? null,
        versionIntact: installed?.matches ?? null,
        supervisor,
        supervisorInstalled: existsSync(supervisor),
        service: serviceState(settings),
        frontdoor: { port: settings.loopbackPort, status: list.status, availability: list.status === 200 ? (() => { try { return JSON.parse(list.body); } catch { return null; } })() : null, ...(list.error ? { error: list.error } : {}) },
        backend: { port: settings.backendPort, status: backend.status },
      }, null, 2));
      return 0;
    }
    case "rollback": {
      const version = rollback(settings);
      console.log(`[inbox-service] now running staged version ${version}; previous versions stay under ${settings.versionsDirectory}`);
      return 0;
    }
    case "uninstall": {
      const removed = uninstall(settings);
      console.log(`[inbox-service] removed ${removed.root} and its supervisor entry; the shared credential stays at ${removed.credential}`);
      return 0;
    }
    case "run": {
      const entry = join(settings.installRoot, "current", "inbox-frontdoor.mjs");
      if (!existsSync(entry)) throw new Fail(`nothing is staged for ${settings.installRoot}; run \`prepare\` first`);
      const result = spawnSync(settings.nodeBinary, [entry, settings.configPath], { stdio: "inherit" });
      return result.status ?? 1;
    }
    default:
      throw new Fail(usage(), 64);
  }
}

export function usage() {
  return "usage: node tools/inbox-service-install.mjs <prepare|install|start|stop|status|rollback|uninstall|run> [options]";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[inbox-service] ${error instanceof Error ? error.message : error}`);
    process.exitCode = error instanceof Fail ? error.code : 1;
  });
}
