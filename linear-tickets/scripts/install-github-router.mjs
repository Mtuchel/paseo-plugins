#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { accountEnvironment, findBinary } from "./github-router.mjs";

const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
const bin = join(home, "bin");
const links = join(homedir(), ".local", "bin");
const tokenFile = join(home, "graphite-bot", "token");
const installedConfig = join(home, "github-router", "config.json");
const old = existsSync(installedConfig) ? JSON.parse(readFileSync(installedConfig, "utf8")) : {};
const executables = Object.fromEntries(["gh", "git", "gt"].map((name) => [name, old.executables?.[name] || realpathSync(findBinary(name))]));
const botEnv = accountEnvironment("bot", home);
const github = spawnSync(executables.gh, ["api", "user", "--jq", ".login"], { env: botEnv, encoding: "utf8", timeout: 10_000 });
if (github.status !== 0 || github.stdout.trim() !== "bot112112121") throw new Error("Bot GitHub authentication must identify bot112112121 before installation");
if (!existsSync(tokenFile)) throw new Error(`Bot Graphite token required in ${tokenFile}; no wrappers changed`);
const token = readFileSync(tokenFile, "utf8").trim();
const graphite = spawnSync(executables.gt, ["auth", "--no-interactive"], { env: { ...botEnv, GRAPHITE_AUTH_TOKEN: token }, encoding: "utf8", timeout: 10_000 });
if (graphite.status !== 0 || !/Authenticated as:\s*bot112112121(?:\s|$)/.test(graphite.stdout)) throw new Error("Bot Graphite token must identify bot112112121 before installation; no wrappers changed");

// Resolve executables and authenticate before modifying any live command paths.
mkdirSync(bin, { recursive: true, mode: 0o700 });
mkdirSync(links, { recursive: true });
const state = join(home, "github-router");
mkdirSync(state, { recursive: true, mode: 0o700 });
const backup = join(state, "backups", String(Date.now()));
mkdirSync(backup, { recursive: true, mode: 0o700 });
const manifest = [];
function remember(path, name) {
  let stat;
  try { stat = lstatSync(path); } catch { manifest.push({ path, absent: true }); return; }
  if (stat.isSymbolicLink()) {
    // Copy dereferences for durable recovery even when the old target is replaced.
    copyFileSync(path, join(backup, name));
    manifest.push({ path, backup: name, link: readlinkSync(path) });
  } else {
    copyFileSync(path, join(backup, name));
    manifest.push({ path, backup: name, mode: stat.mode });
  }
}
const destination = join(bin, "github-router.mjs");
remember(destination, "github-router.mjs");
for (const name of ["gh", "git", "gt"]) remember(join(links, name), name);
remember(join(bin, "gh-agent-guard"), "gh-agent-guard");
remember(installedConfig, "config.json");
writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const source = join(dirname(fileURLToPath(import.meta.url)), "github-router.mjs");
const temporary = `${destination}.${process.pid}`;
copyFileSync(source, temporary);
renameSync(temporary, destination);
writeFileSync(installedConfig, JSON.stringify({ executables }, null, 2), { mode: 0o600 });
for (const path of [...["gh", "git", "gt"].map((name) => join(links, name)), join(bin, "gh-agent-guard")]) {
  const temp = `${path}.${process.pid}`;
  symlinkSync(destination, temp);
  renameSync(temp, path);
}
console.log(`Installed bot GitHub/Graphite routing in ${home}. Original commands saved in ${backup}.`);
