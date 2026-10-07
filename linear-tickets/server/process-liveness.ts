import { execFile } from "node:child_process";
import { readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { issueAgents } from "./starter";

const exec = promisify(execFile);
const MAX_PAGES = 100;
const MAX_PROCESSES = 256;
const CLOSED_PROCESS = /\bprocess (exited|is closed)\b/i;

export type ProcessAgent = Partial<Pick<PaseoAgent, "id" | "provider" | "cwd" | "status" | "lastError" | "archivedAt" | "labels" | "runtimeInfo" | "persistence" | "updatedAt">>;
export type ProcessLiveness = "absent" | "alive" | "unknown";

// No daemon status, JSONL timestamp or missing open file can prove a provider process exited.
// Throws mean unobservable, including a process that disappeared during inspection: retry later.
export type ProcessInspector = {
  processes: () => Promise<string>;
  cwd: (pid: number) => Promise<string>;
  canonicalPath: (path: string) => Promise<string>;
};

const inspector: ProcessInspector = {
  processes: async () => (await exec("ps", ["-ww", "-eo", "pid=,args="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  cwd: async (pid) => {
    if (process.platform === "linux") return (await readlink(`/proc/${pid}/cwd`)).replace(/ \(deleted\)$/, "");
    if (process.platform === "darwin") {
      const { stdout } = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2_000, maxBuffer: 64 * 1024 });
      const paths = stdout.split("\n").filter((line) => line.startsWith("n"));
      if (paths.length === 1 && isAbsolute(paths[0].slice(1))) return paths[0].slice(1);
    }
    throw new Error("The OMP process cwd could not be inspected.");
  },
  canonicalPath: async (path) => {
    try { return await realpath(path); }
    catch (error) {
      // A removed worktree is still an identity. Other failures cannot authorize recovery.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
      throw error;
    }
  },
};


function option(args: string[], name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== name && !arg.startsWith(`${name}=`)) continue;
    if (value !== undefined) throw new Error(`Ambiguous ${name} argument.`);
    value = arg === name ? args[index + 1] : arg.slice(name.length + 1);
    if (!value || value.startsWith("--")) throw new Error(`Incomplete ${name} argument.`);
  }
  return value;
}

// ps prints argv, not a shell command. Only complete whitespace-delimited identities are compared;
// paths containing whitespace are ambiguous and deliberately never establish absence.
function rpcProcesses(output: string): { pid: number; session?: string; ambiguous: boolean }[] {
  const found: { pid: number; session?: string; ambiguous: boolean }[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("Incomplete process listing.");
    const args = match[2].trim().split(/\s+/);
    const command = basename(args[0]);
    const interpreter = ["node", "bun", "tsx"].includes(command);
    const omp = command === "omp" || (interpreter && args[1] && basename(args[1]) === "omp");
    if ((!omp && !interpreter) || option(args, "--mode") !== "rpc-ui") continue;
    if (found.length === MAX_PROCESSES) throw new Error("Too many OMP processes to inspect safely.");
    // OMP can also run as node/bun <coding-agent cli>. Without a named omp executable, the
    // rpc-ui process is ambiguous: its exact cwd must exclude the relevant worktree.
    found.push({ pid: Number(match[1]), session: option(args, "--session"), ambiguous: !omp });
  }
  return found;
}

// Every page, archived roots included: checking only the predecessor misses an older writable
// owner. Public snapshots carry provider runtime/persistence identities; no private disk schema.
// `subagents`: closed or archived subagents' workers count too (SessionRouter.whileIdle, which
// must not run while any worker of the ticket lives); otherwise only roots are inspected.
export async function ticketProcessLiveness(paseo: PaseoApi, issueId: string, extra: ProcessAgent[] = [], inspect: ProcessInspector = inspector, options: { subagents?: boolean } = {}): Promise<ProcessLiveness> {
  try {
    const agents = new Map<string, ProcessAgent>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber === MAX_PAGES) return "unknown";
      const page = await paseo.agents.list({ filter: { labels: { "linear.issueId": issueId }, includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) agents.set(agent.id, agent);
      if (!page.pageInfo) return "unknown";
      if (!page.pageInfo.hasMore) break;
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (!cursor || cursors.has(cursor)) return "unknown";
      cursors.add(cursor);
    }
    // The caller refreshed before this listing. Include a missing target, but never let that
    // earlier snapshot erase a newly closed/archived identity returned by the listing.
    for (const agent of extra) if (agent.id && !agents.has(agent.id)) agents.set(agent.id, agent);
    const candidates = [...agents.values()].filter((agent) => agent.provider === "omp" && (options.subagents || !agent.labels?.["paseo.parent-agent-id"])
      && Boolean(agent.archivedAt || agent.status === "closed"
        || (agent.status === "error" && agent.lastError && CLOSED_PROCESS.test(agent.lastError))));
    if (!candidates.length) return "absent";
    const processes = rpcProcesses(await inspect.processes());
    if (!processes.length) return "absent";
    const sessions = new Set<string>();
    const handles = new Set<string>();
    const worktrees = new Set<string>();
    let incomplete = false;
    for (const agent of candidates) {
      const native = agent.persistence?.nativeHandle;
      if (typeof native === "string" && isAbsolute(native) && !/\s/.test(native)) handles.add(native);
      else incomplete = true;
      for (const session of [agent.runtimeInfo?.sessionId, agent.persistence?.sessionId]) {
        if (session && !/\s/.test(session)) sessions.add(session);
      }
      if (!agent.cwd || !isAbsolute(agent.cwd)) return "unknown";
      worktrees.add(await inspect.canonicalPath(agent.cwd));
    }
    let unknown = false;
    for (const process of processes) {
      if (process.session) {
        if (handles.has(process.session) || sessions.has(process.session)) return "alive";
        // Without the full native handle, a UUID alone cannot exclude an absolute JSONL argument.
        if (incomplete) unknown = true;
        if (!process.ambiguous) continue;
      }
      try {
        // Newly created workers have no --session: exact cwd is the conservative ownership seam.
        if (worktrees.has(await inspect.canonicalPath(await inspect.cwd(process.pid)))) return "alive";
      } catch { unknown = true; }
    }
    return unknown ? "unknown" : "absent";
  } catch {
    return "unknown";
  }
}

// An agent the daemon shows idle or running although no process works for it. After a daemon
// crash (2026-10-05 18:09, `spawn ps EAGAIN`) the daemon listed the agents it had loaded with their
// last status; twenty stayed "running" for 16 hours without a process, and the TUC-949 planner was
// never restarted because its agent looked live. A ghost never takes the next step on its own.
// An agent updated within GHOST_GRACE_MS may still be starting or reloading its process.
const GHOST_GRACE_MS = 5 * 60_000;

// The ids of `agents` that are ghosts: OMP, unarchived, idle or running, quiet for GHOST_GRACE_MS,
// and no rpc-ui process carries their session or runs in their worktree. Absence must be proven:
// an agent without a complete native handle or cwd is never a ghost, and an inspection that fails
// anywhere (ps, a cwd, a path) reports none, so the next poll looks again.
export async function ghostAgents(agents: ProcessAgent[], now: number, inspect: ProcessInspector = inspector): Promise<Set<string>> {
  const suspects = agents.filter((agent) => agent.id && agent.provider === "omp" && !agent.archivedAt
    && (agent.status === "idle" || agent.status === "running")
    && agent.updatedAt && now - Date.parse(agent.updatedAt) >= GHOST_GRACE_MS
    && typeof agent.persistence?.nativeHandle === "string" && isAbsolute(agent.persistence.nativeHandle) && !/\s/.test(agent.persistence.nativeHandle)
    && agent.cwd && isAbsolute(agent.cwd));
  if (!suspects.length) return new Set();
  try {
    const processes = rpcProcesses(await inspect.processes());
    const ghosts = new Set(suspects.map((agent) => agent.id!));
    const byWorktree = new Map<string, string[]>();
    for (const agent of suspects) {
      const path = await inspect.canonicalPath(agent.cwd!);
      byWorktree.set(path, [...byWorktree.get(path) ?? [], agent.id!]);
    }
    for (const process of processes) {
      if (!ghosts.size) break;
      if (process.session) {
        const owner = suspects.find((agent) => [agent.persistence?.nativeHandle, agent.persistence?.sessionId, agent.runtimeInfo?.sessionId].includes(process.session));
        if (owner) { ghosts.delete(owner.id!); continue; }
      }
      // A process of another session in the same worktree may still be this agent's under an
      // identity its snapshot does not show: any rpc-ui process there keeps it alive.
      for (const id of byWorktree.get(await inspect.canonicalPath(await inspect.cwd(process.pid))) ?? []) ghosts.delete(id);
    }
    return ghosts;
  } catch {
    return new Set();
  }
}

// Agent states that still work on the ticket. A closed agent (idle too long) or one in error never
// submits a plan, or takes the next step, on its own; nor does a ghost, idle or running without a
// process (see ghostAgents).
export const LIVE_AGENT: Record<string, true> = { initializing: true, idle: true, running: true };

// The ticket's root agents on this host, from every page, by what they do: `live` work on it (see
// LIVE_AGENT, ghosts excluded), `ghosts` show live without a process, `stopped` are closed or in
// error but still exist. Archived agents and subagents are not listed.
export type TicketAgents = { live: PaseoAgent[]; ghosts: PaseoAgent[]; stopped: PaseoAgent[] };

export async function classifyTicketAgents(paseo: PaseoApi, issueId: string, now: number, inspect?: ProcessInspector): Promise<TicketAgents> {
  const roots = (await issueAgents(paseo, issueId)).filter((agent) => !agent.labels?.["paseo.parent-agent-id"]);
  const candidates = roots.filter((agent) => LIVE_AGENT[agent.status]);
  const ghostIds = candidates.length ? await ghostAgents(candidates, now, inspect) : new Set<string>();
  return {
    live: candidates.filter((agent) => !ghostIds.has(agent.id)),
    ghosts: candidates.filter((agent) => ghostIds.has(agent.id)),
    stopped: roots.filter((agent) => !LIVE_AGENT[agent.status]),
  };
}
