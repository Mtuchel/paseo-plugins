import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TICKET_MCP_SOURCE } from "./ticket-mcp-source";

export const TICKET_MCP_NAME = "linear_ticket";
// The server's command (TicketMcpServer as JSON) in an omp agent's environment: the plugin's omp
// extension (omp/linear-tickets-plan-first.ts) mounts its tools, since omp cannot load MCP servers.
export const TICKET_MCP_ENV = "LINEAR_TICKETS_MCP";
export type TicketMcpServer = { type: "stdio"; command: string; args: string[]; env?: Record<string, string> };
export type Runtime = { execPath: string; electron: boolean };
const daemonRuntime: Runtime = { execPath: process.execPath, electron: Boolean(process.versions.electron) };

export function paseoHome(): string {
  return process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
}

// README "Plan-first": the extension is installed by linking it into omp's extensions directory.
export function ompExtensionInstalled(home = homedir()): boolean {
  return existsSync(join(home, ".omp", "agent", "extensions", "linear-tickets-plan-first.ts"));
}

// New launch paths are content-addressed. Older saved paths become verified handles on cutover.
export async function writeTicketMcpScript(home = paseoHome(), source = TICKET_MCP_SOURCE): Promise<string> {
  const directory = join(home, "linear-tickets");
  const path = join(directory, `ticket-mcp-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.mjs`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (await reusable(path, source)) return path;
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("Unrecognized or unsafe saved Linear MCP script: " + path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
    try { await link(temporary, path); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST" && await reusable(path, source))) throw error;
    }
  } finally { await rm(temporary, { force: true }); }
  return path;
}

// Reuse only exact private owned bytes. Never overwrite a modified file or a symlink.
async function reusable(path: string, source: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || (info.mode & 0o077) !== 0) return false;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
  return readFile(path, "utf8").then((current) => current === source, () => false);
}

// Only the issue id and a path go into the saved agent config; the key is read at call time.
// The daemon's own runtime avoids the agent's PATH; under Electron it runs as Node only with ELECTRON_RUN_AS_NODE.
// A null issue id launches the same script read-only: it reads any Linear issue and writes nothing.
export function ticketMcpServer(scriptPath: string, issueId: string | null, home = paseoHome(), runtime = daemonRuntime): TicketMcpServer {
  const args = issueId === null ? [scriptPath, "--read-only", "--paseo-home", home] : [scriptPath, "--issue", issueId, "--paseo-home", home];
  const server: TicketMcpServer = { type: "stdio", command: runtime.execPath, args };
  return runtime.electron ? { ...server, env: { ELECTRON_RUN_AS_NODE: "1" } } : server;
}

type UpgradeEntry = { name: string; previousHash: string; applied: boolean };
type UpgradeManifest = { version: 1; sourceHash: string; rollbackHash?: string; entries: UpgradeEntry[] };

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function privateSource(path: string): Promise<string | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) return null;
  return readFile(path, "utf8");
}

function generated(source: string): boolean {
  return /serverInfo:\s*\{\s*name:\s*["']linear-ticket["']/.test(source)
    && source.includes("--paseo-home") && source.includes("--issue");
}

function validManifest(value: unknown): value is UpgradeManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as UpgradeManifest;
  return manifest.version === 1 && /^[a-f0-9]{64}$/.test(manifest.sourceHash)
    && (manifest.rollbackHash === undefined || /^[a-f0-9]{64}$/.test(manifest.rollbackHash)) && Array.isArray(manifest.entries)
    && manifest.entries.every((entry) => !!entry && /^ticket-mcp-[a-f0-9]{12}\.mjs$/.test(entry.name)
      && /^[a-f0-9]{64}$/.test(entry.previousHash) && typeof entry.applied === "boolean");
}

async function durablePrivateWrite(path: string, content: string): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(join(path, ".."), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

// Single-process serialization also covers simultaneous launch calls. Manifests are persisted
// before replacement, so interruption is recoverable without a content-hash filename invariant.
let upgrades = Promise.resolve();
export function upgradeTicketMcpScripts(home = paseoHome(), source = TICKET_MCP_SOURCE): Promise<{ manifest: string | null; unrecognized: string[] }> {
  const result = upgrades.then(() => upgradeScripts(home, source));
  upgrades = result.then(() => {}, () => {});
  return result;
}

async function upgradeScripts(home: string, source: string): Promise<{ manifest: string | null; unrecognized: string[] }> {
  if (!generated(source)) throw new Error("Not a generated Linear MCP source");
  const directory = join(home, "linear-tickets");
  const archive = join(directory, "mcp-upgrades");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(archive, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isDirectory() || (archiveInfo.mode & 0o077)
    || (typeof process.getuid === "function" && archiveInfo.uid !== process.getuid())) throw new Error("Unsafe MCP upgrade archive");
  const known = new Map<string, Set<string>>();
  for (const name of await readdir(archive)) {
    if (!/^rollout-\d+-[a-f0-9-]+\.json$/.test(name)) continue;
    const bytes = await privateSource(join(archive, name));
    if (bytes === null) throw new Error("Unsafe MCP upgrade manifest");
    const manifest: unknown = JSON.parse(bytes);
    if (!validManifest(manifest)) throw new Error("Invalid MCP upgrade manifest");
    for (const entry of manifest.entries) {
      const hashes = known.get(entry.name) ?? new Set<string>();
      hashes.add(entry.previousHash); hashes.add(manifest.sourceHash);
      known.set(entry.name, hashes);
    }
  }
  const currentHash = sourceHash(source);
  const entries: UpgradeEntry[] = [];
  const originals = new Map<string, string>();
  const unrecognized: string[] = [];
  let rollback: { hash: string; modified: number } | null = null;
  for (const name of await readdir(directory)) {
    const match = /^ticket-mcp-([a-f0-9]{12})\.mjs$/.exec(name);
    if (!match) continue;
    const bytes = await privateSource(join(directory, name));
    const hash = bytes === null ? null : sourceHash(bytes);
    if (bytes === null || !generated(bytes) || (hash!.slice(0, 12) !== match[1] && !known.get(name)?.has(hash!))) {
      unrecognized.push(join(directory, name));
      continue;
    }
    if (hash === currentHash) continue;
    entries.push({ name, previousHash: hash!, applied: false });
    originals.set(hash!, bytes);
    const info = await lstat(join(directory, name));
    if (!rollback || info.mtimeMs > rollback.modified) rollback = { hash: hash!, modified: info.mtimeMs };
  }
  const helper = join(directory, "ticket-mcp-restore.mjs");
  const priorHelper = await lstat(helper).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (priorHelper && await privateSource(helper) !== RESTORE_SOURCE) throw new Error("Unrecognized MCP restoration helper");
  if (!priorHelper) await durablePrivateWrite(helper, RESTORE_SOURCE);
  if (entries.length === 0) return { manifest: null, unrecognized };
  for (const [hash, bytes] of originals) {
    const path = join(archive, hash + ".mjs");
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      const saved = await privateSource(path);
      if (saved === null || sourceHash(saved) !== hash) throw new Error("Invalid MCP restoration source");
    } else await durablePrivateWrite(path, bytes);
  }
  const manifest: UpgradeManifest = { version: 1, sourceHash: currentHash, rollbackHash: rollback!.hash, entries };
  const path = join(archive, "rollout-" + Date.now() + "-" + randomUUID() + ".json");
  await durablePrivateWrite(path, JSON.stringify(manifest));
  for (const entry of entries) {
    const target = join(directory, entry.name);
    const before = await privateSource(target);
    if (before === null || sourceHash(before) !== entry.previousHash) throw new Error("Saved MCP source changed during cutover: " + target);
    await durablePrivateWrite(target, source);
    entry.applied = true;
    await durablePrivateWrite(path, JSON.stringify(manifest));
  }
  return { manifest: path, unrecognized };
}

// Installed independently of the checkout: still executable after reverting the plugin.
const RESTORE_SOURCE = String.raw`
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const directory = dirname(fileURLToPath(import.meta.url));
const archive = join(directory, "mcp-upgrades");
const manifestPath = resolve(process.argv[2] || "");
if (dirname(manifestPath) !== archive || !/^rollout-\d+-[a-f0-9-]+\.json$/.test(basename(manifestPath))) throw new Error("Select a manifest from this host's mcp-upgrades directory");
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function privateBytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Unsafe restoration file: " + path);
  return readFile(path, "utf8");
}
async function writePrivate(path, bytes) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(dirname(path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}
const manifest = JSON.parse(await privateBytes(manifestPath));
if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sourceHash) || !Array.isArray(manifest.entries)) throw new Error("Invalid restoration manifest");
// Commands created after cutover also need rollback. Persist their restoration intent first.
const known = new Map();
for (const name of await readdir(archive)) {
  if (!/^rollout-\d+-[a-f0-9-]+\.json$/.test(name)) continue;
  const other = JSON.parse(await privateBytes(join(archive, name)));
  if (other.version !== 1 || !Array.isArray(other.entries)) throw new Error("Invalid restoration history");
  for (const entry of other.entries) {
    if (other.sourceHash === manifest.sourceHash || entry.previousHash === manifest.sourceHash) known.set(entry.name, true);
  }
}
const rollbackHash = manifest.rollbackHash || manifest.entries[0]?.previousHash;
if (!/^[a-f0-9]{64}$/.test(rollbackHash)) throw new Error("Missing restoration source");
for (const name of await readdir(directory)) {
  const match = /^ticket-mcp-([a-f0-9]{12})\.mjs$/.exec(name);
  if (!match || manifest.entries.some((entry) => entry.name === name)) continue;
  if (match[1] !== manifest.sourceHash.slice(0, 12) && !known.has(name)) continue;
  if (hash(await privateBytes(join(directory, name))) !== manifest.sourceHash) continue;
  manifest.entries.push({ name, previousHash: rollbackHash, applied: true });
}
await writePrivate(manifestPath, JSON.stringify(manifest));
let restored = 0;
for (const entry of manifest.entries) {
  if (!entry || !/^ticket-mcp-[a-f0-9]{12}\.mjs$/.test(entry.name) || !/^[a-f0-9]{64}$/.test(entry.previousHash)) throw new Error("Invalid restoration entry");
  const path = join(directory, entry.name);
  const currentHash = hash(await privateBytes(path));
  if (currentHash === entry.previousHash) continue;
  if (currentHash !== manifest.sourceHash) throw new Error("Saved MCP source changed; refusing restoration: " + path);
  const previous = await privateBytes(join(archive, entry.previousHash + ".mjs"));
  if (hash(previous) !== entry.previousHash) throw new Error("Restoration source checksum mismatch");
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(previous); await file.sync(); } finally { await file.close(); }
    if (hash(await privateBytes(path)) !== manifest.sourceHash) throw new Error("Saved MCP source changed during restoration");
    await rename(temporary, path);
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    restored++;
  } finally { await rm(temporary, { force: true }); }
}
console.log(JSON.stringify({ restored }));
`;
