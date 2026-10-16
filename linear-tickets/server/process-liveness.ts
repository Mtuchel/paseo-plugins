import { execFile } from "./child-processes";
import { readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";

const MAX_PAGES = 100;
const MAX_PROCESSES = 256;
const CLOSED_PROCESS = /\bprocess (exited|is closed)\b/i;

// How long one `ps` table may serve further checks. Several checks ask for the same machine seconds
// apart (every ghost check of one session sweep, the planner refresh beside it, the starter's
// admission), and every read is a `ps` fork of this process; they share one table inside this
// window. Five seconds is also what the sharing can add to a check before a process the caller's own
// agent list does not name (a subagent started in a worktree, say) is seen.
const PROCESS_TABLE_MS = 5_000;

// The process table every check reads through, shared (one `ps` at a time, the last one served for
// PROCESS_TABLE_MS). `at(reference)`: the table handed back was read at or after `reference`, in ms.
// The rule callers live by, because a wrong table is a stopped or duplicated agent:
//
//   * A process cannot be older than the record that names it: the daemon writes an agent's record
//     when it starts (or reloads) its process, so `updatedAt` is never later than that process.
//   * Therefore a table read at or after the newest `updatedAt` among the agents a check is about
//     cannot miss a just-started process of theirs, and only such a table may decide an absence.
//   * Every caller passes that newest record as `reference` (see referenceOf): an agent whose record
//     moved since the last `ps` re-reads the table, so a destructive decision (a ghost stopped,
//     replaced or not counted, a ticket without workers) never rests on a table older than the facts
//     it is judging. A caller without a reference (`0`) only needs the window.
//
// A failed read is never served: the next check reads again.
export class ProcessTable {
  private cached: { at: number; table: Promise<string> } | null = null;

  constructor(private readonly read: () => Promise<string>, private readonly now: () => number = Date.now, private readonly ttlMs: number = PROCESS_TABLE_MS) {}

  async at(reference = 0): Promise<string> {
    const cached = this.cached;
    // `at` is when the read was queued, a lower bound for the moment the table describes: the
    // snapshot is taken after it, so a table that qualifies was read at or after `reference`.
    if (cached && cached.at >= reference && this.now() - cached.at <= this.ttlMs) return cached.table;
    // One `ps` at a time: a check that needs a newer table waits for the read in flight first, so a
    // burst of checks never runs two listings at once (and reuses the newer one when it qualifies).
    const queued = (cached ? cached.table.catch(() => undefined) : Promise.resolve()).then(() => this.read());
    const entry = { at: this.now(), table: queued };
    this.cached = entry;
    return queued.catch((error: unknown) => {
      if (this.cached === entry) this.cached = null;
      throw error;
    });
  }
}

// The newest record among the agents a check is about: nothing about an agent whose record carries
// no readable time can be bounded, so such an agent (one with an id) makes the table must be current.
function referenceOf(agents: Iterable<ProcessAgent>, now: number): number {
  let reference = 0;
  for (const agent of agents) {
    if (!agent.id) continue;
    const at = agent.updatedAt ? Date.parse(agent.updatedAt) : NaN;
    if (!Number.isFinite(at)) return now;
    reference = Math.max(reference, at);
  }
  return reference;
}

export type ProcessAgent = Partial<Pick<PaseoAgent, "id" | "provider" | "cwd" | "status" | "lastError" | "archivedAt" | "labels" | "runtimeInfo" | "persistence" | "updatedAt">>;
export type ProcessLiveness = "absent" | "alive" | "unknown";

// No daemon status, JSONL timestamp or missing open file can prove a provider process exited.
// Throws mean unobservable, including a process that disappeared during inspection: retry later.
export type ProcessInspector = {
  // The process table, read at or after `reference` (ms since the epoch): the newest record the
  // check judges (see ProcessTable). A caller that does not pass one gets the shared window.
  processes: (reference?: number) => Promise<string>;
  cwd: (pid: number) => Promise<string>;
  canonicalPath: (path: string) => Promise<string>;
};

// Every liveness check in this process reads the machine through it (see ProcessTable).
const processTable = new ProcessTable(async () => (await execFile("ps", ["-ww", "-eo", "pid=,args="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout);

const inspector: ProcessInspector = {
  processes: (reference = 0) => processTable.at(reference),
  cwd: async (pid) => {
    if (process.platform === "linux") return (await readlink(`/proc/${pid}/cwd`)).replace(/ \(deleted\)$/, "");
    if (process.platform === "darwin") {
      const { stdout } = await execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2_000, maxBuffer: 64 * 1024 });
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
    // The table must be as new as every record of this ticket, not just the dead candidates': a
    // worker started a moment ago is in the same worktree and would be missed by an older table
    // (see ProcessTable). Callers start an agent on "absent", so this is the destructive direction.
    const processes = rpcProcesses(await inspect.processes(referenceOf(agents.values(), Date.now())));
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
// anywhere (ps, a cwd, a path) reports none, so the next poll looks again. The process table must be
// at least as new as every record handed in (see ProcessTable): a process one of them started may be
// the very process that keeps a suspect alive, and callers stop, replace or do not count a ghost.
export async function ghostAgents(agents: ProcessAgent[], now: number, inspect: ProcessInspector = inspector): Promise<Set<string>> {
  const suspects = agents.filter((agent) => agent.id && agent.provider === "omp" && !agent.archivedAt
    && (agent.status === "idle" || agent.status === "running")
    && agent.updatedAt && now - Date.parse(agent.updatedAt) >= GHOST_GRACE_MS
    && typeof agent.persistence?.nativeHandle === "string" && isAbsolute(agent.persistence.nativeHandle) && !/\s/.test(agent.persistence.nativeHandle)
    && agent.cwd && isAbsolute(agent.cwd));
  if (!suspects.length) return new Set();
  try {
    const processes = rpcProcesses(await inspect.processes(referenceOf(agents, now)));
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
