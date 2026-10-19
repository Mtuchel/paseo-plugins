import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface GitOptions {
  /** Aborts an in-flight git process; used when the plugin shuts down. */
  signal?: AbortSignal;
  /** Git executable, overridable in tests. */
  binary?: string;
}

interface GitInvocation extends GitOptions {
  env?: NodeJS.ProcessEnv;
}

/** Whether a rejection came from aborting a git command rather than from git itself. */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

async function git(cwd: string, args: string[], options: GitInvocation = {}): Promise<string> {
  const { stdout } = await execute(options.binary ?? "git", args, {
    cwd,
    env: { ...process.env, ...options.env },
    signal: options.signal,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** The repository root containing `cwd`, or null when `cwd` is not inside a git repository. */
export async function repositoryRoot(cwd: string, options: GitOptions = {}): Promise<string | null> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"], options);
  } catch {
    return null;
  }
}

/** The repository root when it contains apps/core-web, or null. */
export async function coreWebRoot(cwd: string, options: GitOptions = {}): Promise<string | null> {
  const root = await repositoryRoot(cwd, options);
  if (!root) return null;
  try {
    await access(join(root, "apps", "core-web", "package.json"));
    return root;
  } catch {
    return null;
  }
}

async function gitIndexPath(root: string, options: GitOptions): Promise<string> {
  try {
    return await git(
      root,
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      options,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    // git before 2.31 has no --path-format; its answer is relative to the repository root.
    return join(root, await git(root, ["rev-parse", "--git-path", "index"], options));
  }
}

/**
 * A tree object for the working tree as it is now, without touching the real index: stage into
 * a copy of the index and write that tree. Blobs are shared, so this only reads the worktree.
 *
 * Throws when git fails; the caller logs it and skips the turn.
 */
export async function snapshotTree(root: string, options: GitOptions = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-ui-verify-"));
  try {
    const index = join(directory, "index");
    await copyFile(await gitIndexPath(root, options), index).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const env = { GIT_INDEX_FILE: index };
    await git(root, ["add", "-A"], { ...options, env });
    const tree = await git(root, ["write-tree"], { ...options, env });
    if (!tree) throw new Error("git write-tree returned no tree");
    return tree;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Paths that differ between two tree objects, relative to the repository root. */
export async function changedFiles(
  root: string,
  before: string,
  after: string,
  options: GitOptions = {},
): Promise<string[]> {
  if (before === after) return [];
  const output = await git(root, ["diff-tree", "-r", "--name-only", "-z", before, after], options);
  return output.split("\0").filter((path) => path.length > 0);
}