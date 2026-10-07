import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { TICKET_MCP_SOURCE } from "./ticket-mcp-source";
import { upgradeTicketMcpScripts, writeTicketMcpScript } from "./ticket-mcp";

// Behavioral coverage for the saved-command rollout of TUC-1323: upgradeTicketMcpScripts rewrites
// the generated ticket MCP scripts older agent configs still point at, keeps checksum-verified
// backups, installs the restore helper and recognizes its own earlier rollouts. Every phase is
// observed by executing the saved path with Node, never by inspecting the writer's source.

const PROBE = "--fixture-version";

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function savedName(source: string): string {
  return `ticket-mcp-${digest(source).slice(0, 12)}.mjs`;
}

// A complete generated script: the real MCP source plus one probe statement after its leading
// imports. It prints and exits before any server code runs, so normal MCP usage of the same bytes
// is unaffected.
function fixtureSource(version: string): string {
  const lines = TICKET_MCP_SOURCE.split("\n");
  const first = lines.findIndex((line) => line.startsWith("import "));
  if (first < 0) throw new Error("the ticket MCP source no longer starts with an import block");
  let end = first;
  while (end < lines.length && lines[end].startsWith("import ")) end++;
  const probe = `if (process.argv.includes("${PROBE}")) { process.stdout.write(${JSON.stringify(`fixture:${version}\n`)}, () => process.exit(0)); }`;
  return [...lines.slice(0, end), probe, ...lines.slice(end)].join("\n");
}

const ticketDir = (home: string): string => join(home, "linear-tickets");
const manifestDir = (home: string): string => join(ticketDir(home), "mcp-upgrades");
const archiveDir = (home: string): string => manifestDir(home);
const helperPath = (home: string): string => join(ticketDir(home), "ticket-mcp-restore.mjs");

// The saved command as an older plugin left it: name = first 12 sha256 characters of its bytes.
async function savedScript(home: string, source: string): Promise<string> {
  await mkdir(ticketDir(home), { recursive: true, mode: 0o700 });
  const path = join(ticketDir(home), savedName(source));
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

async function installHome(t: TestContext, prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  return home;
}

type Running = { status: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Running {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 15_000 });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = (typeof result.stderr === "string" ? result.stderr : "") || (result.error ? String(result.error.message) : "");
  return { status: result.status, stdout, stderr };
}

// Runs the saved command exactly as an agent would, with the probe flag appended.
function assertVersion(path: string, home: string, mode: "agent" | "planner", version: string): void {
  const args = [path, ...(mode === "planner" ? ["--read-only"] : ["--issue", "TUC-1"]), "--paseo-home", home, PROBE];
  const result = run(process.execPath, args);
  assert.equal(result.status, 0, `the saved command must run: ${result.stderr}`);
  assert.equal(result.stdout.trim(), `fixture:${version}`, `the ${version} bytes must be on disk at ${basename(path)}`);
}

function restoreManifest(home: string, manifest: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Running {
  return run(process.execPath, [helperPath(home), manifest], options);
}

function restoredCount(result: Running): number {
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`the restore helper must print JSON, got ${JSON.stringify(result.stdout)}`); }
  if (typeof parsed !== "object" || parsed === null || !("restored" in parsed)) {
    throw new Error(`the restore helper must report {restored:n}, got ${JSON.stringify(result.stdout)}`);
  }
  const restored = parsed.restored;
  if (typeof restored !== "number") {
    throw new Error(`the restore helper must report {restored:n}, got ${JSON.stringify(result.stdout)}`);
  }
  return restored;
}

function manifestFile(home: string, manifest: string | null): string {
  assert.ok(manifest, "an upgrade with work to do must return a manifest path");
  const path = existsSync(manifest) ? manifest : resolve(home, manifest);
  assert.ok(existsSync(path), `the upgrade must write the manifest at ${manifest}`);
  return path;
}

function reported(result: { unrecognized: string[] }, path: string): boolean {
  return result.unrecognized.some((entry) => entry === path || basename(entry) === basename(path));
}

test("saved generated commands upgrade through two releases and restore through both manifests", async (t) => {
  const home = await installHome(t, "paseo-ticket-mcp-upgrade-");
  const originalAgent = fixtureSource("original-agent");
  const originalPlanner = fixtureSource("original-planner");
  const versionA = fixtureSource("version-a");
  const versionB = fixtureSource("version-b");
  const agentPath = await savedScript(home, originalAgent);
  const plannerPath = await savedScript(home, originalPlanner);
  assertVersion(agentPath, home, "agent", "original-agent");
  assertVersion(plannerPath, home, "planner", "original-planner");

  const first = await upgradeTicketMcpScripts(home, versionA);
  const manifestA = manifestFile(home, first.manifest);
  assert.equal(dirname(manifestA), manifestDir(home));
  assertVersion(agentPath, home, "agent", "version-a");
  assertVersion(plannerPath, home, "planner", "version-a");
  const blobAgent = join(archiveDir(home), `${digest(originalAgent)}.mjs`);
  const blobPlanner = join(archiveDir(home), `${digest(originalPlanner)}.mjs`);
  assert.equal(await readFile(blobAgent, "utf8"), originalAgent, "the pre-upgrade bytes must be archived");
  assert.equal(await readFile(blobPlanner, "utf8"), originalPlanner);
  assert.equal((await stat(blobAgent)).mode & 0o077, 0, "archived sources must stay private");

  // The second release must recognize the old saved filenames even though the bytes changed.
  const second = await upgradeTicketMcpScripts(home, versionB);
  const manifestB = manifestFile(home, second.manifest);
  assert.notEqual(manifestB, manifestA);
  assert.equal(await readFile(join(archiveDir(home), `${digest(versionA)}.mjs`), "utf8"), versionA);
  assertVersion(agentPath, home, "agent", "version-b");
  assertVersion(plannerPath, home, "planner", "version-b");

  const repeat = await upgradeTicketMcpScripts(home, versionB);
  assertVersion(agentPath, home, "agent", "version-b");
  assertVersion(plannerPath, home, "planner", "version-b");
  assert.ok(!reported(repeat, agentPath) && !reported(repeat, plannerPath), "a repeated upgrade must keep recognizing its saved paths");

  assert.ok(existsSync(helperPath(home)), "the upgrade must install the restore helper");
  // Standalone proof: an unrelated working directory and only PATH, so the helper cannot lean on
  // the plugin checkout or any dependency.
  const elsewhere = await mkdtemp(join(tmpdir(), "paseo-ticket-mcp-restore-cwd-"));
  t.after(async () => { await rm(elsewhere, { recursive: true, force: true }); });
  const standalone = { cwd: elsewhere, env: { PATH: process.env.PATH } };

  const rollbackB = restoreManifest(home, manifestB, standalone);
  assert.equal(rollbackB.status, 0, rollbackB.stderr);
  assert.equal(restoredCount(rollbackB), 2);
  assertVersion(agentPath, home, "agent", "version-a");
  assertVersion(plannerPath, home, "planner", "version-a");

  const rollbackAgain = restoreManifest(home, manifestB, standalone);
  assert.equal(rollbackAgain.status, 0, rollbackAgain.stderr);
  assert.equal(restoredCount(rollbackAgain), 0, "paths already at their previous hash are skipped");
  assertVersion(agentPath, home, "agent", "version-a");

  const rollbackA = restoreManifest(home, manifestA, standalone);
  assert.equal(rollbackA.status, 0, rollbackA.stderr);
  assert.equal(restoredCount(rollbackA), 2);
  assertVersion(agentPath, home, "agent", "original-agent");
  assertVersion(plannerPath, home, "planner", "original-planner");

  const names = (await readdir(ticketDir(home))).filter((name) => /^ticket-mcp-[0-9a-f]{12}\.mjs$/.test(name)).sort();
  assert.deepEqual(names, [basename(agentPath), basename(plannerPath)].sort(), "no old saved path may be left behind");
  assert.ok((await readdir(ticketDir(home))).every((name) => !name.includes(".tmp")));
  assert.ok((await lstat(agentPath)).isFile() && (await lstat(plannerPath)).isFile());
});

test("commands created after each cutover roll back through all releases too", async (t) => {
  const home = await installHome(t, "paseo-mcp-new-command-");
  const original = fixtureSource("original");
  const sourceA = fixtureSource("version-a");
  const sourceB = fixtureSource("version-b");
  const oldPath = await savedScript(home, original);
  const rolloutA = await upgradeTicketMcpScripts(home, sourceA);
  const canonicalA = await writeTicketMcpScript(home, sourceA);
  const rolloutB = await upgradeTicketMcpScripts(home, sourceB);
  const canonicalB = await writeTicketMcpScript(home, sourceB);
  for (const path of [oldPath, canonicalA, canonicalB]) assertVersion(path, home, "agent", "version-b");
  const backToA = restoreManifest(home, manifestFile(home, rolloutB.manifest));
  assert.equal(backToA.status, 0, backToA.stderr);
  for (const path of [oldPath, canonicalA, canonicalB]) assertVersion(path, home, "agent", "version-a");
  const backToOriginal = restoreManifest(home, manifestFile(home, rolloutA.manifest));
  assert.equal(backToOriginal.status, 0, backToOriginal.stderr);
  for (const path of [oldPath, canonicalA, canonicalB]) assertVersion(path, home, "agent", "original");
});


test("unrecognized, private and symlinked candidates stay untouched while a valid script upgrades", async (t) => {
  const home = await installHome(t, "paseo-ticket-mcp-upgrade-negative-");
  const validPath = await savedScript(home, fixtureSource("original"));

  // A saved-looking name whose bytes hash to something else and carry no generated provenance.
  const junk = "// not a ticket MCP script\n";
  const badPath = join(ticketDir(home), "ticket-mcp-000000000000.mjs");
  await writeFile(badPath, junk, { mode: 0o600 });

  // Hash matches the name, but the content is not a generated ticket MCP script.
  const foreign = 'console.log("not generated");\n';
  const noProvenancePath = join(ticketDir(home), `ticket-mcp-${digest(foreign).slice(0, 12)}.mjs`);
  await writeFile(noProvenancePath, foreign, { mode: 0o600 });

  // A generated script is skipped while it is not private.
  const exposedBytes = fixtureSource("exposed");
  const exposedPath = await savedScript(home, exposedBytes);
  await chmod(exposedPath, 0o644);

  // A symlink is never followed, even when its name matches the target's bytes.
  const linkedBytes = fixtureSource("linked");
  const targetPath = join(home, "elsewhere.mjs");
  await writeFile(targetPath, linkedBytes, { mode: 0o600 });
  const linkPath = join(ticketDir(home), savedName(linkedBytes));
  await symlink(targetPath, linkPath);

  const result = await upgradeTicketMcpScripts(home, fixtureSource("version-a"));
  assertVersion(validPath, home, "agent", "version-a");
  assert.equal(await readFile(badPath, "utf8"), junk);
  assert.equal(await readFile(noProvenancePath, "utf8"), foreign);
  assert.equal(await readFile(exposedPath, "utf8"), exposedBytes);
  assert.ok((await lstat(linkPath)).isSymbolicLink());
  assert.equal(await readFile(targetPath, "utf8"), linkedBytes);
  assert.ok(reported(result, badPath), "a filename that does not match its bytes must be reported");
  assert.ok(reported(result, noProvenancePath), "content without generated provenance must be reported");
});

test("a cached path changed on disk is reported and left unprotected, never overwritten", async (t) => {
  const home = await installHome(t, "paseo-ticket-mcp-upgrade-changed-");
  const path = await savedScript(home, fixtureSource("original"));
  const first = await upgradeTicketMcpScripts(home, fixtureSource("version-a"));
  assert.ok(first.manifest, "the first upgrade must produce a manifest");
  const tampered = "fixture: tampered\n";
  await writeFile(path, tampered, { mode: 0o600 });
  const upgrade = await upgradeTicketMcpScripts(home, fixtureSource("version-b"));
  assert.ok(reported(upgrade, path), "changed saved commands must be reported as unrecognized");
  assert.equal(await readFile(path, "utf8"), tampered, "an unsafe cached path must never be overwritten");
});

test("the restore helper refuses changed and symlinked targets", async (t) => {
  const changedHome = await installHome(t, "paseo-ticket-mcp-restore-changed-");
  const changedPath = await savedScript(changedHome, fixtureSource("original"));
  const changedUpgrade = await upgradeTicketMcpScripts(changedHome, fixtureSource("version-a"));
  const changedManifest = manifestFile(changedHome, changedUpgrade.manifest);
  const tampered = "fixture: tampered\n";
  await writeFile(changedPath, tampered, { mode: 0o600 });
  const changed = restoreManifest(changedHome, changedManifest);
  assert.notEqual(changed.status, 0, "a changed target must be refused");
  assert.ok(`${changed.stdout}${changed.stderr}`.trim().length > 0, "the refusal must be reported");
  assert.equal(await readFile(changedPath, "utf8"), tampered);

  const linkHome = await installHome(t, "paseo-ticket-mcp-restore-symlink-");
  const linkPath = await savedScript(linkHome, fixtureSource("original"));
  const linkUpgrade = await upgradeTicketMcpScripts(linkHome, fixtureSource("version-a"));
  const linkManifest = manifestFile(linkHome, linkUpgrade.manifest);
  const outsidePath = join(linkHome, "outside.mjs");
  await writeFile(outsidePath, "outside\n", { mode: 0o600 });
  await rm(linkPath);
  await symlink(outsidePath, linkPath);
  const linked = restoreManifest(linkHome, linkManifest);
  assert.notEqual(linked.status, 0, "a symlinked target must be refused");
  assert.ok(`${linked.stdout}${linked.stderr}`.trim().length > 0, "the refusal must be reported");
  assert.ok((await lstat(linkPath)).isSymbolicLink());
  assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
});

test("an interrupted rollout resumes and keeps the originals restorable", async (t) => {
  const home = await installHome(t, "paseo-ticket-mcp-upgrade-interrupted-");
  const originalAgent = fixtureSource("original-agent");
  const originalPlanner = fixtureSource("original-planner");
  const versionA = fixtureSource("version-a");
  const versionB = fixtureSource("version-b");
  const agentPath = await savedScript(home, originalAgent);
  const plannerPath = await savedScript(home, originalPlanner);

  const first = await upgradeTicketMcpScripts(home, versionA);
  const manifestA = manifestFile(home, first.manifest);
  assertVersion(agentPath, home, "agent", "version-a");
  assertVersion(plannerPath, home, "planner", "version-a");
  const originalBlob = join(archiveDir(home), `${digest(originalAgent)}.mjs`);
  assert.equal(await readFile(originalBlob, "utf8"), originalAgent);

  // The interrupted rollout, exactly in the pinned manifest schema: both entries recorded, the
  // previous bytes archived, one path already overwritten and one still untouched.
  await mkdir(archiveDir(home), { recursive: true, mode: 0o700 });
  const interrupted = join(manifestDir(home), `rollout-${Date.now()}-${randomUUID()}.json`);
  await writeFile(interrupted, JSON.stringify({
    version: 1,
    sourceHash: digest(versionB),
    entries: [
      { name: basename(agentPath), previousHash: digest(versionA), applied: false },
      { name: basename(plannerPath), previousHash: digest(versionA), applied: false },
    ],
  }), { mode: 0o600 });
  await writeFile(join(archiveDir(home), `${digest(versionA)}.mjs`), versionA, { mode: 0o600 });
  await writeFile(agentPath, versionB, { mode: 0o600 });
  await writeFile(plannerPath, versionA, { mode: 0o600 });

  const resumed = await upgradeTicketMcpScripts(home, versionB);
  const resumedManifest = manifestFile(home, resumed.manifest);
  assertVersion(agentPath, home, "agent", "version-b");
  assertVersion(plannerPath, home, "planner", "version-b");
  assert.ok(!reported(resumed, agentPath) && !reported(resumed, plannerPath), "an interrupted rollout must be recognized, not treated as foreign");
  assert.equal(await readFile(originalBlob, "utf8"), originalAgent, "earlier backups must be preserved across a resume");

  const backToA = restoreManifest(home, resumedManifest);
  assert.equal(backToA.status, 0, backToA.stderr);
  assertVersion(agentPath, home, "agent", "version-a");
  assertVersion(plannerPath, home, "planner", "version-a");

  const backToOriginal = restoreManifest(home, manifestA);
  assert.equal(backToOriginal.status, 0, backToOriginal.stderr);
  assertVersion(agentPath, home, "agent", "original-agent");
  assertVersion(plannerPath, home, "planner", "original-planner");
});
