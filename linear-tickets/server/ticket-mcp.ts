import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

// Content-addressed so agents created by an older plugin version keep a working script.
export async function writeTicketMcpScript(home = paseoHome(), source = TICKET_MCP_SOURCE): Promise<string> {
  const directory = join(home, "linear-tickets");
  const path = join(directory, `ticket-mcp-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.mjs`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (await reusable(path, source)) return path;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return path;
}

// Reuse only a private regular file we own with the exact bytes; anything else is rewritten,
// and rename replaces a symlink itself rather than its target.
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
