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
// Paseo is the one behind `paseo` on PATH, or the @getpaseo/server directory in PASEO_SERVER_DIR
// (for a plugin whose manifest excludes the host's Paseo: point it at a version the plugin
// supports).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Not in @getpaseo/server's package exports, so it is imported by file path.
const RUNTIME_ENTRY = join("dist", "server", "server", "plugins", "runtime.js");

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

const HOW_TO_POINT =
  "set PASEO_SERVER_DIR to an @getpaseo/server package directory (the one inside the Paseo CLI install, or one unpacked with npm pack)";

// The @getpaseo/server package the check builds with: { dir, version }.
export function locatePaseoServer(env = process.env) {
  if (env.PASEO_SERVER_DIR) {
    const dir = resolve(env.PASEO_SERVER_DIR);
    const pkg = readPackage(dir);
    if (!pkg?.version) throw new Error(`PASEO_SERVER_DIR=${dir} has no package.json with a version`);
    return { dir, version: pkg.version };
  }
  const bin = onPath("paseo", env.PATH);
  if (!bin) throw new Error(`cannot find \`paseo\` on PATH; ${HOW_TO_POINT}`);
  const cli = packageRoot(dirname(realpathSync(bin)), "@getpaseo/cli");
  if (!cli) throw new Error(`${realpathSync(bin)} is not inside an @getpaseo/cli install; ${HOW_TO_POINT}`);
  let entry;
  try {
    entry = createRequire(join(cli, "package.json")).resolve("@getpaseo/server");
  } catch (error) {
    throw new Error(`${cli} does not resolve @getpaseo/server (${error.message}); ${HOW_TO_POINT}`);
  }
  const dir = packageRoot(dirname(entry), "@getpaseo/server");
  const version = dir && readPackage(dir)?.version;
  if (!version) throw new Error(`cannot find @getpaseo/server's package.json above ${entry}; ${HOW_TO_POINT}`);
  return { dir, version };
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
