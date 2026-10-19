import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { changedFiles, coreWebRoot, repositoryRoot, snapshotTree } from "../server/git-snapshot";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository(t: TestContext, coreWeb = true): string {
  const root = mkdtempSync(join(tmpdir(), "ui-verify-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "ui-verify@example.com");
  git(root, "config", "user.name", "ui-verify test");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  if (coreWeb) {
    mkdirSync(join(root, "apps", "core-web", "src"), { recursive: true });
    writeFileSync(join(root, "apps", "core-web", "package.json"), "{}\n");
    writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => null;\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}

test("core-web repositories are found from the root and from a subdirectory", async (t) => {
  const root = repository(t);
  assert.equal(await repositoryRoot(root), root);
  assert.equal(await coreWebRoot(root), root);
  assert.equal(await coreWebRoot(join(root, "apps", "core-web")), root);
});

test("repositories without apps/core-web and plain directories are ignored", async (t) => {
  const plain = mkdtempSync(join(tmpdir(), "ui-verify-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(await repositoryRoot(plain), null);
  assert.equal(await coreWebRoot(plain), null);
  assert.equal(await coreWebRoot(repository(t, false)), null);
});

test("snapshots see uncommitted and untracked changes without touching the real index", async (t) => {
  const root = repository(t);
  const before = await snapshotTree(root);

  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 'new';\n");
  writeFileSync(join(root, "apps", "core-web", "src", "New.css"), ".new { color: red; }\n");
  appendFileSync(join(root, "apps", "core-web", "src", "Page.test.tsx"), "test\n");

  const after = await snapshotTree(root);
  assert.notEqual(after, before);
  assert.deepEqual((await changedFiles(root, before, after)).sort(), [
    "apps/core-web/src/New.css",
    "apps/core-web/src/Page.test.tsx",
    "apps/core-web/src/Page.tsx",
  ]);
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "", "the real index stays unstaged");
  assert.match(git(root, "status", "--porcelain"), / M apps\/core-web\/src\/Page\.tsx/);
});

test("a change committed during the turn is still detected", async (t) => {
  const root = repository(t);
  const before = await snapshotTree(root);

  writeFileSync(join(root, "apps", "core-web", "src", "Committed.tsx"), "export const Committed = () => null;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "work done inside the turn");

  const after = await snapshotTree(root);
  assert.deepEqual(await changedFiles(root, before, after), ["apps/core-web/src/Committed.tsx"]);
});

test("identical trees have no changed files", async (t) => {
  const root = repository(t);
  const tree = await snapshotTree(root);
  assert.deepEqual(await changedFiles(root, tree, tree), []);
});