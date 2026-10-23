import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi, PaseoProject } from "@getpaseo/client";
import { findProject, ProjectUnavailableError, readBranches } from "./projects";

test("branch discovery reads local and remote refs, omits symbolic remote HEAD, and defaults to the current branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-branches-"));
  const exec = promisify(execFile);
  const git = (args: string[]) => exec("git", ["-C", directory, ...args]);
  try {
    await git(["init", "--initial-branch=main"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial"]);
    await git(["branch", "feature/test"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const result = await readBranches(directory);
    assert.equal(result.defaultBranch, "refs/heads/main");
    assert.deepEqual(result.branches.map((branch) => branch.id), ["refs/heads/feature/test", "refs/heads/main", "refs/remotes/origin/main"]);
    await git(["checkout", "--detach"]);
    assert.equal((await readBranches(directory)).defaultBranch, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("project lookups share one listing, and a project the listing lacks is looked up afresh", async () => {
  const project = (id: string) => ({ projectId: id, projectRootPath: `/src/${id}` }) as PaseoProject;
  let projects = [project("a")];
  let lists = 0;
  const paseo = { projects: { list: async () => { lists++; return { projects }; } } } as unknown as PaseoApi;

  assert.equal((await findProject(paseo, "a")).projectRootPath, "/src/a");
  assert.equal((await findProject(paseo, "a")).projectRootPath, "/src/a");
  assert.equal(lists, 1);

  projects = [project("a"), project("b")];
  assert.equal((await findProject(paseo, "b")).projectRootPath, "/src/b");
  assert.equal(lists, 2);

  await assert.rejects(findProject(paseo, "gone"), ProjectUnavailableError);
  assert.equal(lists, 3);
});
