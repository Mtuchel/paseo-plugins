import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { HandoverRecord } from "./handover";
import type { PluginSettings, WorktreeShardSettings } from "./settings";

const exec = promisify(execFile);

// README, "Worktree shards". One repository's ticket worktrees live under a single git directory
// by default, and every filesystem event there (a `config` rewrite, a packed-refs lock) costs the
// daemon work for every worktree that shares it. With shards, new tickets are assigned to one of a
// configured list of clones, each with its own git directory, so that cost is divided by the
// number of clones. What must never happen is a ticket landing in a clone that does not have the
// work it builds on: a stack whose lower branches, or the worktree a follow-up continues, live in
// another clone, where its local branches and Graphite metadata do not exist.

// One candidate root: the Paseo project registered for it.
export type ShardProject = { projectId: string; rootPath: string; label: string };

// Why a root was chosen; also the line the plugin logs and the tests assert.
export type ShardReason = "pinned" | "resume" | "resume-branch" | "recorded" | "own-branch" | "dependency" | "base-branch" | "least-worktrees";

// Everything the choice reads, gathered by assign(): which roots exist, what work each holds and
// how loaded each is. Kept as plain data so the rule itself is a pure function.
export type ShardFacts = {
  // Candidate roots, the mapped (original) root first.
  roots: string[];
  mappedRoot: string;
  requestedRoot: string;
  // The root of the worktree a resume continues, when the ticket is continued.
  resumeRoot: string | null;
  // Roots holding the branch a resume continues as a local ref. A continuation imported from the
  // draining host carries only the branch, and that branch has to exist where the agent runs.
  resumeBranchRoots: string[];
  // The root of the ticket's recorded worktree (its handover record).
  recordedRoot: string | null;
  // Roots holding the ticket's own branch as a local ref.
  ownBranchRoots: string[];
  // Roots holding recorded work of the tickets this one stacks on or is blocked by.
  dependencyRoots: string[];
  // Roots holding the launch's requested base branch as a local ref (a branch only one clone has
  // is that clone's work, e.g. a stack's lower branch).
  baseBranchRoots: string[];
  // Registered worktrees per root: the cost a filesystem event in that clone's git directory pays.
  worktrees: Record<string, number>;
  issueId: string;
};

export type ShardChoice = { root: string; reason: ShardReason };

const normalized = (path: string): string => resolve(path.trim());

// Only one root holds this work; two (say, the same branch fetched into two clones) decide nothing.
function onlyRoot(inRoots: (string | null | undefined)[]): string | null {
  const found = [...new Set(inRoots.flatMap((path) => (path ? [path] : [])))];
  return found.length === 1 ? found[0] : null;
}

// A stable rank so two clones with the same load always resolve the same ticket the same way
// (a retried launch must not land in a second clone).
function rank(issueId: string, root: string): string {
  return createHash("sha256").update(`${issueId}\u0000${root}`).digest("hex");
}

export function chooseShardRoot(input: ShardFacts): ShardChoice {
  const roots = input.roots.map(normalized);
  const known = (path: string | null): string | null => {
    if (!path) return null;
    const wanted = normalized(path);
    return roots.find((root) => root === wanted) ?? null;
  };
  // A project that already is one of the pool's clones is the owner's (or an earlier decision's)
  // choice: the launch keeps it instead of being re-sharded.
  const requested = known(input.requestedRoot);
  if (requested && requested !== normalized(input.mappedRoot)) return { root: requested, reason: "pinned" };
  const resume = known(input.resumeRoot);
  if (resume) return { root: resume, reason: "resume" };
  const resumeBranch = onlyRoot(input.resumeBranchRoots.map(known));
  if (resumeBranch) return { root: resumeBranch, reason: "resume-branch" };
  const recorded = known(input.recordedRoot);
  if (recorded) return { root: recorded, reason: "recorded" };
  const own = onlyRoot(input.ownBranchRoots.map(known));
  if (own) return { root: own, reason: "own-branch" };
  const dependency = onlyRoot(input.dependencyRoots.map(known));
  if (dependency) return { root: dependency, reason: "dependency" };
  const base = onlyRoot(input.baseBranchRoots.map(known));
  if (base) return { root: base, reason: "base-branch" };
  // Nothing demands a root: the least loaded one, so the next ticket pays the least on top of the
  // worktrees already there. Roots whose worktree count could not be read count as the most loaded.
  const load = (root: string) => input.worktrees[root] ?? Number.MAX_SAFE_INTEGER;
  const [chosen] = [...roots].sort((a, b) => load(a) - load(b) || rank(input.issueId, a).localeCompare(rank(input.issueId, b)));
  return { root: chosen, reason: "least-worktrees" };
}

// The project a launch should use instead of the mapped one, with the line to log about it.
export type ShardAssignment = { projectId: string; rootPath: string; label: string; reason: ShardReason; notes: string[] };

type Git = (args: string[], cwd: string) => Promise<string>;

const git: Git = async (args, cwd) => (await exec("git", ["-C", cwd, ...args], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

// A clone's remote-tracking refs must not be stale when a new ticket branches off them; a clone
// that fetched within this window is left alone (other launches and its own agents keep it fresh).
const FETCH_FRESH_MS = 10 * 60 * 1000;

export type ShardAssignInput = {
  requested: { projectId: string; rootPath: string };
  ticket: { id: string; branch: string | null; dependencies: string[] };
  // The worktree and branch the launch continues, when it continues one.
  resume?: { worktreePath: string | null; branch?: string | null } | null;
  baseBranch?: string | undefined;
};

type Deps = {
  // The saved settings, read per assignment so a changed pool applies without a reload.
  settings: () => Promise<PluginSettings>;
  // The ticket records that say where a ticket's work already is.
  handover?: { read(issueId: string): Promise<HandoverRecord | null> };
  git?: Git;
  now?: () => number;
};

export class ShardAssignor {
  private readonly git: Git;
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.git = deps.git ?? git;
    this.now = deps.now ?? Date.now;
  }

  // The root to use for a launch, or null when the host has no pool for the requested project (or
  // nothing to spread across): callers then launch exactly as before.
  async assign(input: ShardAssignInput, paseo: PaseoApi): Promise<ShardAssignment | null> {
    const settings = await this.deps.settings();
    const pool = shardPool(settings.worktreeShards, input.requested.rootPath);
    if (!pool) return null;
    const projects = (await paseo.projects.list()).projects;
    const byRoot = new Map<string, ShardProject>();
    for (const project of projects) {
      if (project.projectRootPath) byRoot.set(normalized(project.projectRootPath), { projectId: project.projectId, rootPath: project.projectRootPath, label: project.projectCustomName || project.projectDisplayName || project.projectRootPath });
    }
    const notes: string[] = [];
    const roots = [...new Set(pool.roots.map(normalized))];
    const candidates = roots.flatMap((root) => {
      const project = byRoot.get(root);
      if (project) return [project];
      notes.push(`The shard root ${root} is not a Paseo project on this host; its tickets are not assigned to it.`);
      return [];
    });
    if (candidates.length < 2) return null;
    // A launch that already names one of the pool's clones keeps it: an earlier assignment in the
    // same launch (the starter) or the owner's own project choice, never re-sharded mid-flight.
    const pinned = normalized(input.requested.rootPath) === normalized(pool.mappedRoot) ? undefined : candidates.find((candidate) => normalized(candidate.rootPath) === normalized(input.requested.rootPath));
    if (pinned) return { projectId: pinned.projectId, rootPath: pinned.rootPath, label: pinned.label, reason: "pinned", notes };
    // What each clone holds: its registered worktrees, and which of them is a given path. The
    // listing also resolves a recorded worktree (a resumed one included) to the clone that owns it.
    const worktrees: Record<string, number> = {};
    const owners = new Map<string, string>();
    for (const candidate of candidates) {
      try {
        const listed = await this.git(["worktree", "list", "--porcelain"], candidate.rootPath);
        const paths = listed.split("\n").flatMap((line) => line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []);
        worktrees[normalized(candidate.rootPath)] = paths.length;
        for (const path of paths) owners.set(normalized(path), candidate.rootPath);
      } catch {
        notes.push(`Could not read the worktrees of ${candidate.rootPath}; its load was left out of the assignment.`);
      }
    }
    const ownerOf = (path: string | null | undefined): string | null => (path ? owners.get(normalized(path)) ?? null : null);
    // The roots holding one of these branches as a local ref: a branch only one clone has is that
    // clone's work (a stack's lower branch, the ticket's own branch, a continued branch).
    const localBranchRoots = async (refs: (string | null | undefined)[]): Promise<string[]> => {
      // A local-branch check: a full remote ref says nothing about which clone holds the work.
      const wanted = new Set(refs.flatMap((ref) => {
        if (!ref) return [];
        const head = ref.startsWith("refs/heads/") ? ref : ref.startsWith("refs/") ? null : `refs/heads/${ref}`;
        return head ? [head] : [];
      }));
      if (!wanted.size) return [];
      const found: string[] = [];
      for (const candidate of candidates) {
        const listed = await this.git(["for-each-ref", "--format=%(refname)", "refs/heads"], candidate.rootPath).catch(() => "");
        if (listed.split("\n").some((ref) => wanted.has(ref))) found.push(candidate.rootPath);
      }
      return found;
    };
    const recorded = this.deps.handover && input.ticket.id ? await this.deps.handover.read(input.ticket.id).catch(() => null) : null;
    const dependencies = input.ticket.dependencies.length && this.deps.handover
      ? (await Promise.all(input.ticket.dependencies.map((id) => this.deps.handover!.read(id).catch(() => null)))).flatMap((record) => ownerOf(record?.worktreePath) ?? [])
      : [];
    const choice = chooseShardRoot({
      roots: candidates.map((candidate) => candidate.rootPath),
      mappedRoot: pool.mappedRoot,
      requestedRoot: input.requested.rootPath,
      resumeRoot: ownerOf(input.resume?.worktreePath),
      resumeBranchRoots: await localBranchRoots([input.resume?.branch]),
      recordedRoot: ownerOf(recorded?.worktreePath),
      ownBranchRoots: await localBranchRoots([input.ticket.branch]),
      dependencyRoots: dependencies,
      baseBranchRoots: await localBranchRoots([input.baseBranch]),
      worktrees,
      issueId: input.ticket.id,
    });
    const project = candidates.find((candidate) => normalized(candidate.rootPath) === choice.root)!;
    return { projectId: project.projectId, rootPath: project.rootPath, label: project.label, reason: choice.reason, notes };
  }

  // Refreshes the assigned clone's remote-tracking refs, so the new branch starts from the current
  // base branch instead of the clone's last fetch. Best effort: a stale clone is worse than a
  // launch that waits, never more than a note.
  async refresh(rootPath: string): Promise<string | null> {
    try {
      const commonDir = resolve(rootPath, await this.git(["rev-parse", "--git-common-dir"], rootPath).then((out) => out.trim()).catch(() => ".git"));
      // A clone that never fetched has no FETCH_HEAD: that is the stalest case, not an error.
      let fetched = 0;
      try { fetched = statSync(resolve(commonDir, "FETCH_HEAD")).mtimeMs; } catch { /* never fetched */ }
      if (this.now() - fetched < FETCH_FRESH_MS) return null;
      await this.git(["fetch", "--quiet", "origin"], rootPath);
      return null;
    } catch (error) {
      return `Could not refresh ${rootPath} before creating the worktree (${error instanceof Error ? error.message : "unknown error"}); its base branch may be behind.`;
    }
  }
}

// The pool that applies to a requested project root: keyed by the mapped root, and recognized from
// any of the pool's own roots, so a launch that already carries an assigned clone stays there.
export function shardPool(shards: WorktreeShardSettings, rootPath: string): { mappedRoot: string; roots: string[] } | null {
  if (!shards.enabled) return null;
  const wanted = normalized(rootPath);
  for (const [mappedRoot, clones] of Object.entries(shards.pools)) {
    const roots = [mappedRoot, ...clones];
    if (roots.some((root) => normalized(root) === wanted)) return { mappedRoot, roots };
  }
  return null;
}

// The tickets a launch builds on: its Linear parent (a sub-issue continues the parent's work) and
// the tickets it is blocked by. Where their work is decides where this ticket's work has to be.
export function shardDependencies(relations: { parent: { id: string } | null; related: { id: string; direction: string }[] }): string[] {
  const ids = [...(relations.parent?.id ? [relations.parent.id] : []), ...relations.related.flatMap((ticket) => ticket.direction === "blocked by" ? [ticket.id] : [])];
  return [...new Set(ids)];
}
