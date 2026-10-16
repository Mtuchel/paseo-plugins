#!/usr/bin/env node
// Runs the plugin build Paseo itself runs when it loads a plugin: Paseo's own
// PluginRuntime.validatePlugin (manifest, Paseo version requirement, entry points, esbuild
// bundle with Paseo's module rules), taken from the installed Paseo, not a copy of its rules.
//
//   node tools/paseo-build.mjs <plugin-dir>
//
// Exit 0: "Paseo <v> builds <id>". Exit 1: "Paseo <v> refuses <id>: <message>", or Paseo could
// not be found / has no build entry this check knows. The check never skips.
//
// It builds with the Paseo the running daemon runs: a host whose `paseo` on PATH is another
// install (a patched runtime behind a symlink, a Paseo.app bundle, a mise CLI of an older
// version) must not make the check measure a Paseo the daemon does not run. In order:
//  1. PASEO_SERVER_DIR: the @getpaseo/server package directory to build with (a plugin whose
//     manifest excludes the host's Paseo: one it supports, unpacked with npm pack). The CLI
//     reported for it is PASEO_BIN or PASEO_CLI when set, else `paseo` on PATH.
//  2. PASEO_BIN: the `paseo` executable to use; an unusable one is an error, not a fallback.
//  3. The CLI the host's daemon was started from, read off the process table: its command line
//     (`<node> <install>/node_modules/.bin/paseo daemon run`) names the CLI, and the daemon's
//     @getpaseo/server is the one that install resolves. No PATH setup and no working CLI is
//     needed to ask. Several daemons: none of them is picked, and the answer has to come from
//     PASEO_CLI or `paseo` on PATH (or PASEO_BIN); the error names them when it does not.
//  4. PASEO_CLI: the CLI a host's daemon runner hands its children (systemd
//     `Environment=PASEO_CLI`, the Mac's paseo-daemon-run.sh). Best effort: an app-managed daemon
//     hands out its own launcher, which is not an @getpaseo/cli install.
//  5. `paseo` on PATH.
// tools/plugin-rollout.mjs drives the daemon with the CLI this resolves, so one rollout never
// builds with one Paseo and reloads through another.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Not in @getpaseo/server's package exports, so it is imported by file path.
const RUNTIME_ENTRY = join("dist", "server", "server", "plugins", "runtime.js");
// The daemon's own command line, `paseo daemon run`: both words, so `paseo daemon status` and
// friends (a CLI process, not the daemon) do not count as one.
const DAEMON_COMMAND = ["daemon", "run"];

function readPackage(directory) {
  const file = join(directory, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The nearest ancestor directory (or `start` itself) holding a package.json named `name`.
function packageRoot(start, name) {
  for (let directory = start; ; directory = dirname(directory)) {
    if (readPackage(directory)?.name === name) return directory;
    if (dirname(directory) === directory) return null;
  }
}

function onPath(command, pathValue) {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The `paseo` executable a running daemon was started from
// ---------------------------------------------------------------------------------------------

// The @getpaseo/cli install a path belongs to, and the `paseo` executable in it: { root, bin },
// or null when the path is not a file inside such an install.
export function cliInstall(path) {
  let file;
  try {
    file = realpathSync(path);
  } catch {
    return null;
  }
  const root = packageRoot(dirname(file), "@getpaseo/cli");
  if (!root) return null;
  const declared = readPackage(root)?.bin;
  const bin = join(root, typeof declared === "string" ? declared : declared?.paseo ?? join("bin", "paseo"));
  return existsSync(bin) ? { root, bin } : null;
}

// The `paseo` of a command line: its first token that belongs to an @getpaseo/cli install. The
// daemon keeps the argument vector it was started with, whatever it later sets its process title
// to, so `node <install>/node_modules/.bin/paseo daemon run` is enough to find its install.
function cliOfCommandLine(argv) {
  for (const token of argv) {
    if (!token.includes("/")) continue;
    const install = cliInstall(token);
    if (install) return install.bin;
  }
  return null;
}

// Process table rows: { pid, ppid, uid, argv }. `ps` prints pid, ppid and uid first; a line that
// is not such a row is skipped.
export function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!row) continue;
    rows.push({ pid: Number(row[1]), ppid: Number(row[2]), uid: Number(row[3]), argv: row[4].split(/\s+/) });
  }
  return rows;
}

function readProcessTable() {
  try {
    return parseProcessTable(
      execFileSync("ps", ["-ww", "-Ao", "pid=,ppid=,uid=,args="], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    // No `ps`, or it refused: discovery falls through to PASEO_CLI and PATH.
    return [];
  }
}

// The `paseo` executables of this user's running Paseo daemons, in table order. Another user's
// daemon is not this host's rollout target and is ignored.
export function daemonClis(rows, uid = process.getuid?.() ?? null) {
  const clis = [];
  for (const row of rows) {
    if (uid !== null && row.uid !== uid) continue;
    if (!DAEMON_COMMAND.every((word) => row.argv.includes(word))) continue;
    const cli = cliOfCommandLine(row.argv);
    if (cli && !clis.includes(cli)) clis.push(cli);
  }
  return clis;
}

const HOW_TO_POINT =
  "set PASEO_SERVER_DIR to an @getpaseo/server package directory (the one inside the Paseo CLI install, or one unpacked with npm pack) or PASEO_BIN to the `paseo` executable to use";

// The @getpaseo/server package an installed Paseo CLI uses: { dir, version }.
export function serverBehindCli(bin) {
  let file;
  try {
    file = realpathSync(bin);
  } catch (error) {
    throw new Error(`cannot read ${bin} (${error.message})`);
  }
  const cli = packageRoot(dirname(file), "@getpaseo/cli");
  if (!cli) throw new Error(`${file} is not inside an @getpaseo/cli install`);
  let entry;
  try {
    entry = createRequire(join(cli, "package.json")).resolve("@getpaseo/server");
  } catch (error) {
    throw new Error(`${cli} does not resolve @getpaseo/server (${error.message})`);
  }
  const dir = packageRoot(dirname(entry), "@getpaseo/server");
  const version = dir && readPackage(dir)?.version;
  if (!version) throw new Error(`cannot find @getpaseo/server's package.json above ${entry}`);
  return { dir, version };
}

// The Paseo the check builds with: { dir, version, cli }. `cli` is the `paseo` executable of the
// install the server came from, or null when PASEO_SERVER_DIR pinned the server and no CLI is
// configured; tools/plugin-rollout.mjs drives the daemon with it.
// `rows`: a pre-read process table (tests); null reads the host's with `ps`.
export function locatePaseoServer(env = process.env, rows = null) {
  if (env.PASEO_SERVER_DIR) {
    const dir = resolve(env.PASEO_SERVER_DIR);
    const pkg = readPackage(dir);
    if (!pkg?.version) throw new Error(`PASEO_SERVER_DIR=${dir} has no package.json with a version`);
    return { dir, version: pkg.version, cli: env.PASEO_BIN || env.PASEO_CLI || null };
  }
  if (env.PASEO_BIN) {
    // An explicit choice: never silently replaced by another Paseo.
    try {
      return { ...serverBehindCli(env.PASEO_BIN), cli: env.PASEO_BIN };
    } catch (error) {
      throw new Error(`PASEO_BIN=${env.PASEO_BIN} is unusable (${error.message}); ${HOW_TO_POINT}`);
    }
  }
  const problems = [];
  const daemons = daemonClis(rows ?? readProcessTable());
  if (daemons.length === 1) {
    try {
      return { ...serverBehindCli(daemons[0]), cli: daemons[0] };
    } catch (error) {
      problems.push(`the daemon's CLI ${daemons[0]}: ${error.message}`);
    }
  } else if (daemons.length > 1) {
    problems.push(`the process table shows ${daemons.length} Paseo daemons (${daemons.join(", ")}); set PASEO_BIN to the one to use`);
  }
  if (env.PASEO_CLI) {
    try {
      return { ...serverBehindCli(env.PASEO_CLI), cli: env.PASEO_CLI };
    } catch (error) {
      problems.push(`PASEO_CLI=${env.PASEO_CLI}: ${error.message}`);
    }
  }
  const pathBin = onPath("paseo", env.PATH);
  if (!pathBin) {
    problems.push("no `paseo` on PATH");
  } else {
    try {
      return { ...serverBehindCli(pathBin), cli: pathBin };
    } catch (error) {
      problems.push(`\`paseo\` on PATH (${pathBin}): ${error.message}`);
    }
  }
  throw new Error(`cannot find the Paseo the daemon runs: ${problems.join("; ")}; ${HOW_TO_POINT}`);
}

export function pluginId(pluginDir) {
  try {
    const id = JSON.parse(readFileSync(join(pluginDir, "paseo-plugin.json"), "utf8")).id;
    if (typeof id === "string" && id) return id;
  } catch {}
  return basename(resolve(pluginDir));
}

const silentLogger = {
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

// Resolves when Paseo builds the plugin; throws Paseo's own error when it refuses it.
export async function checkPluginBuild(pluginDir, server) {
  const unknown = new Error(
    `Paseo ${server.version} has no plugin build entry this check knows; update tools/paseo-build.mjs`,
  );
  const runtimeFile = join(server.dir, RUNTIME_ENTRY);
  if (!existsSync(runtimeFile)) throw unknown;
  const { PluginRuntime } = await import(pathToFileURL(runtimeFile).href);
  if (typeof PluginRuntime?.prototype?.validatePlugin !== "function") throw unknown;
  await new PluginRuntime(silentLogger, server.version).validatePlugin(realpathSync(pluginDir));
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    console.error("usage: node tools/paseo-build.mjs <plugin-dir>");
    return 1;
  }
  const pluginDir = resolve(argv[0]);
  const id = pluginId(pluginDir);
  let server;
  try {
    server = locatePaseoServer();
  } catch (error) {
    console.error(`cannot run Paseo's plugin build for ${id}: ${describe(error)}`);
    return 1;
  }
  try {
    await checkPluginBuild(pluginDir, server);
  } catch (error) {
    console.error(`Paseo ${server.version} refuses ${id}: ${describe(error)}`);
    return 1;
  }
  console.log(`Paseo ${server.version} builds ${id}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // esbuild's service keeps the event loop alive; the verdict is final here.
  main(process.argv.slice(2)).then((code) => process.exit(code));
}