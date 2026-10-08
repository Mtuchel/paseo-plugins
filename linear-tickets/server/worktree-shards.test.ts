import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { HandoverRecord } from "./handover";
import { DEFAULT_WORKTREE_SHARDS, normalizeWorktreeShards, Settings, validWorktreeShards, type PluginSettings, type WorktreeShardSettings } from "./settings";
import { chooseShardRoot, shardDependencies, shardPool, ShardAssignor, type ShardFacts } from "./worktree-shards";

// README, "Worktree shards": the four decisions the assignment must get right are an unrelated new
// ticket (spread), a follow-up for an existing ticket (continue its clone), a stacked or dependent
// ticket (the clone that holds the work it builds on) and a ticket whose work sits in the original
// repository (keep the original). A wrong decision hides local branches and Graphite metadata.

const ORIGINAL = "/paseo/tuchel-platform-git-source";
const CLONE2 = "/paseo/tuchel-platform-2";
const CLONE3 = "/paseo/tuchel-platform-3";
const LEGACY_WORKTREE = "/paseo/worktrees/1u2u03rs/mtuchel-tuc-90-legacy";

const facts = (change: Partial<ShardFacts> = {}): ShardFacts => ({
  roots: [ORIGINAL, CLONE2, CLONE3],
  mappedRoot: ORIGINAL,
  requestedRoot: ORIGINAL,
  resumeRoot: null,
  resumeBranchRoots: [],
  recordedRoot: null,
  ownBranchRoots: [],
  dependencyRoots: [],
  baseBranchRoots: [],
  // The original carries the backlog; the clones are the whole point of spreading.
  worktrees: { [ORIGINAL]: 412, [CLONE2]: 6, [CLONE3]: 11 },
  issueId: "issue-1",
  ...change,
});

test("an unrelated new ticket goes to the least loaded clone", () => {
  assert.deepEqual(chooseShardRoot(facts()), { root: CLONE2, reason: "least-worktrees" });
  // A retry with the same ticket decides the same way, and equal loads break ties stably.
  const tied = facts({ worktrees: { [ORIGINAL]: 412, [CLONE2]: 6, [CLONE3]: 6 } });
  assert.equal(chooseShardRoot(tied).root, chooseShardRoot(tied).root);
  assert.equal(chooseShardRoot(tied).reason, "least-worktrees");
});

test("a follow-up for an existing ticket continues the clone that holds its worktree", () => {
  assert.deepEqual(chooseShardRoot(facts({ recordedRoot: CLONE3 })), { root: CLONE3, reason: "recorded" });
  // The worktree actually being resumed wins over the record, and over an emptier clone.
  assert.deepEqual(chooseShardRoot(facts({ resumeRoot: CLONE3, recordedRoot: CLONE2 })), { root: CLONE3, reason: "resume" });
  // Without a worktree path, the ticket's own branch says which clone has the work.
  assert.deepEqual(chooseShardRoot(facts({ ownBranchRoots: [CLONE3] })), { root: CLONE3, reason: "own-branch" });
  // A continuation imported from the other host carries only its branch: that branch decides,
  // ahead of this host's older record for the ticket.
  assert.deepEqual(chooseShardRoot(facts({ resumeBranchRoots: [CLONE3], recordedRoot: ORIGINAL })), { root: CLONE3, reason: "resume-branch" });
});

test("a stacked or dependent ticket lands where the work it builds on is", () => {
  // A sub-issue or blocked-by ticket builds on the parent's clone, loaded or not.
  assert.deepEqual(chooseShardRoot(facts({ dependencyRoots: [CLONE3] })), { root: CLONE3, reason: "dependency" });
  // A base branch that exists as a local ref in only one clone is that clone's work (a stack's
  // lower branch).
  assert.deepEqual(chooseShardRoot(facts({ baseBranchRoots: [CLONE2] })), { root: CLONE2, reason: "base-branch" });
  // Two clones holding the branch decide nothing: the ticket is assigned as an unrelated one.
  assert.deepEqual(chooseShardRoot(facts({ baseBranchRoots: [CLONE2, CLONE3] })), { root: CLONE2, reason: "least-worktrees" });
  // A launch that already names a clone keeps it: never re-sharded mid-flight.
  assert.deepEqual(chooseShardRoot(facts({ requestedRoot: CLONE3 })), { root: CLONE3, reason: "pinned" });
});

test("a ticket with a worktree in the original repository keeps the original", () => {
  assert.deepEqual(chooseShardRoot(facts({ recordedRoot: ORIGINAL })), { root: ORIGINAL, reason: "recorded" });
  assert.deepEqual(chooseShardRoot(facts({ ownBranchRoots: [ORIGINAL] })), { root: ORIGINAL, reason: "own-branch" });
});

// --- The assignment as the launch paths call it ---------------------------------------------------

const projects = [
  { projectId: "p-original", projectRootPath: ORIGINAL, projectDisplayName: "tuchel-platform" },
  { projectId: "p-clone2", projectRootPath: CLONE2, projectDisplayName: "tuchel-platform-2" },
  { projectId: "p-clone3", projectRootPath: CLONE3, projectDisplayName: "tuchel-platform-3" },
];
const fakePaseo = { projects: { list: async () => ({ projects }) } } as unknown as PaseoApi;

type FakeRoot = { path: string; worktrees: string[]; branches: string[] };

function fakeAssignor(roots: FakeRoot[], options: { records?: HandoverRecord[]; shards?: WorktreeShardSettings; now?: () => number; fetch?: () => Promise<void> } = {}) {
  const fetched: string[] = [];
  const git = async (args: string[], cwd: string): Promise<string> => {
    const root = roots.find((item) => item.path === cwd);
    if (args[0] === "worktree" && args[1] === "list") return root ? root.worktrees.map((path) => `worktree ${path}\nHEAD abc\n`).join("") : "";
    if (args[0] === "for-each-ref") return root ? root.branches.map((ref) => `${ref}\n`).join("") : "";
    if (args[0] === "rev-parse") return ".git\n";
    if (args[0] === "fetch") { fetched.push(cwd); await (options.fetch ?? (async () => {}))(); return ""; }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const assignor = new ShardAssignor({
    settings: async () => ({ worktreeShards: options.shards ?? { enabled: true, pools: { [ORIGINAL]: [CLONE2, CLONE3] } } }) as unknown as PluginSettings,
    handover: { read: async (issueId: string) => options.records?.find((record) => record.issueId === issueId) ?? null },
    git,
    ...(options.now ? { now: options.now } : {}),
  });
  return { assignor, fetched };
}

const record = (issueId: string, worktreePath: string | null): HandoverRecord => ({
  issueId, identifier: issueId, agentId: "agent-1", agentTitle: "Paseo agent", branch: "mtuchel/tuc-90", worktreePath,
  lastCommit: null, summaries: [], links: {}, status: "working", progressCommentId: null, resumedFrom: null, updatedAt: "2026-10-08T00:00:00Z",
});

const ROOTS: FakeRoot[] = [
  { path: ORIGINAL, worktrees: [ORIGINAL, LEGACY_WORKTREE], branches: ["refs/heads/main"] },
  { path: CLONE2, worktrees: [CLONE2, "/paseo/worktrees/9x/tuc-12"], branches: ["refs/heads/main", "refs/heads/mtuchel/tuc-12"] },
  { path: CLONE3, worktrees: [CLONE3], branches: ["refs/heads/main"] },
];

test("assignment: a legacy worktree in the original keeps the ticket in the original", async () => {
  const { assignor } = fakeAssignor(ROOTS, { records: [record("issue-legacy", LEGACY_WORKTREE)] });
  const assignment = await assignor.assign({
    requested: { projectId: "p-original", rootPath: ORIGINAL },
    ticket: { id: "issue-legacy", branch: "mtuchel/tuc-90", dependencies: [] },
    resume: { worktreePath: LEGACY_WORKTREE, branch: "mtuchel/tuc-90" },
    baseBranch: "refs/remotes/origin/main",
  }, fakePaseo);
  assert.deepEqual(assignment && { projectId: assignment.projectId, reason: assignment.reason }, { projectId: "p-original", reason: "resume" });
});

test("assignment: a new ticket spreads, a follow-up of the same ticket does not", async () => {
  const spread = fakeAssignor(ROOTS);
  const fresh = await spread.assignor.assign({
    requested: { projectId: "p-original", rootPath: ORIGINAL },
    ticket: { id: "issue-new", branch: "mtuchel/tuc-91", dependencies: [] },
    baseBranch: "refs/remotes/origin/main",
  }, fakePaseo);
  // clone-2 has two worktrees against clone-3's one, so the least loaded clone is clone-3.
  assert.deepEqual(fresh && { root: fresh.rootPath, reason: fresh.reason }, { root: CLONE3, reason: "least-worktrees" });

  const followUp = fakeAssignor(ROOTS, { records: [record("issue-12", "/paseo/worktrees/9x/tuc-12")] });
  const continued = await followUp.assignor.assign({
    requested: { projectId: "p-original", rootPath: ORIGINAL },
    ticket: { id: "issue-12", branch: "mtuchel/tuc-12", dependencies: [] },
    resume: { worktreePath: "/paseo/worktrees/9x/tuc-12", branch: "mtuchel/tuc-12" },
    baseBranch: "refs/remotes/origin/main",
  }, fakePaseo);
  assert.deepEqual(continued && { root: continued.rootPath, reason: continued.reason }, { root: CLONE2, reason: "resume" });
});

test("assignment: a child ticket follows its parent's clone, and a shard without a project is reported", async () => {
  // The parent's worktree is in clone-2; the child is new here and must land beside it.
  const withParent = fakeAssignor(ROOTS, { records: [record("parent-1", "/paseo/worktrees/9x/tuc-12")] });
  const child = await withParent.assignor.assign({
    requested: { projectId: "p-original", rootPath: ORIGINAL },
    ticket: { id: "child-1", branch: "mtuchel/tuc-92", dependencies: ["parent-1"] },
    baseBranch: "refs/remotes/origin/main",
  }, fakePaseo);
  assert.deepEqual(child && { root: child.rootPath, reason: child.reason }, { root: CLONE2, reason: "dependency" });

  // A configured root that is not a Paseo project here is skipped with a note, never used.
  const missing = new ShardAssignor({
    settings: async () => ({ worktreeShards: { enabled: true, pools: { [ORIGINAL]: [CLONE2, "/paseo/tuchel-platform-9"] } } }) as unknown as PluginSettings,
    // The original carries two worktrees, clone-2 one: the least loaded is decided, not guessed.
    git: async (args: string[], cwd: string) => (args[0] === "worktree" ? `worktree ${cwd}\n${cwd === ORIGINAL ? `worktree ${LEGACY_WORKTREE}\n` : ""}` : ""),
  });
  const assignment = await missing.assign({
    requested: { projectId: "p-original", rootPath: ORIGINAL },
    ticket: { id: "issue-new", branch: null, dependencies: [] },
  }, fakePaseo);
  assert.equal(assignment?.rootPath, CLONE2);
  assert.match(assignment?.notes.join(" ") ?? "", /\/paseo\/tuchel-platform-9 is not a Paseo project/);
});

test("assignment: without a pool (the default) a launch keeps its mapped project", async () => {
  const off = new ShardAssignor({ settings: async () => ({ worktreeShards: DEFAULT_WORKTREE_SHARDS }) as unknown as PluginSettings });
  assert.equal(await off.assign({ requested: { projectId: "p-original", rootPath: ORIGINAL }, ticket: { id: "issue-1", branch: null, dependencies: [] } }, fakePaseo), null);
  // One clone is a valid two-way split (the original and one clone); a launch still spreads.
  const single = new ShardAssignor({
    settings: async () => ({ worktreeShards: { enabled: true, pools: { [ORIGINAL]: [CLONE2] } } }) as unknown as PluginSettings,
    git: async (args: string[], cwd: string) => (args[0] === "worktree" ? `worktree ${cwd}\n` : ""),
  });
  const spread = await single.assign({ requested: { projectId: "p-original", rootPath: ORIGINAL }, ticket: { id: "issue-1", branch: null, dependencies: [] } }, fakePaseo);
  assert.equal(spread?.projectId, "p-clone2");
});

test("assignment: shardDependencies reads the parent and the blockers", () => {
  const relations = {
    parent: { id: "parent-1" },
    subissues: [],
    related: [
      { id: "blocker-1", direction: "blocked by" },
      { id: "blocker-2", direction: "blocked by" },
      { id: "other-1", direction: "blocks" },
      { id: "parent-1", direction: "related" },
    ],
  };
  assert.deepEqual(shardDependencies(relations), ["parent-1", "blocker-1", "blocker-2"]);
});

test("refresh: a clone that fetched recently is left alone, a stale or failing one is reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shard-refresh-"));
  try {
    await mkdir(join(directory, ".git"), { recursive: true });
    await writeFile(join(directory, ".git", "FETCH_HEAD"), "");
    const fresh = fakeAssignor(ROOTS, { now: () => 0 });
    assert.equal(await fresh.assignor.refresh(directory), null);
    assert.deepEqual(fresh.fetched, []);

    const stale = fakeAssignor(ROOTS, { now: () => Date.now() + 60 * 60 * 1000 });
    assert.equal(await stale.assignor.refresh(directory), null);
    assert.deepEqual(stale.fetched, [directory]);

    const failing = fakeAssignor(ROOTS, { now: () => Date.now() + 60 * 60 * 1000, fetch: async () => { throw new Error("offline"); } });
    assert.match(await failing.assignor.refresh(directory) ?? "", /Could not refresh .*offline/);

    await rm(join(directory, ".git", "FETCH_HEAD"));
    const neverFetched = fakeAssignor(ROOTS);
    assert.equal(await neverFetched.assignor.refresh(directory), null);
    assert.deepEqual(neverFetched.fetched, [directory]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- Settings --------------------------------------------------------------------------------------

test("settings: pools take absolute roots, drop the mapped root and reject malformed edits", () => {
  assert.deepEqual(normalizeWorktreeShards({ enabled: true, pools: { [`${ORIGINAL}/`]: [CLONE2, `${CLONE2}/`, ORIGINAL, "relative", 7] } }), {
    enabled: true,
    pools: { [ORIGINAL]: [CLONE2] },
  });
  assert.deepEqual(normalizeWorktreeShards({ pools: { [ORIGINAL]: [] } }), DEFAULT_WORKTREE_SHARDS);
  assert.throws(() => validWorktreeShards({ enabled: true, pools: { [ORIGINAL]: ["relative"] } }), /absolute root paths/);
  assert.throws(() => validWorktreeShards({ enabled: "yes" }), /true or false/);
  assert.deepEqual(shardPool({ enabled: false, pools: { [ORIGINAL]: [CLONE2] } }, ORIGINAL), null);
  assert.deepEqual(shardPool({ enabled: true, pools: { [ORIGINAL]: [CLONE2] } }, `${CLONE2}/`), { mappedRoot: ORIGINAL, roots: [ORIGINAL, CLONE2] });
  assert.deepEqual(shardPool({ enabled: true, pools: {} }, ORIGINAL), null);
});

test("settings: the shard pools save, patch and clear like the other settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shard-settings-"));
  const path = join(directory, "settings.json");
  try {
    const settings = new Settings(path);
    const saved = await settings.patch({ worktreeShards: { enabled: true, pools: { [ORIGINAL]: [CLONE2, CLONE3] } } });
    assert.deepEqual(saved.worktreeShards, { enabled: true, pools: { [ORIGINAL]: [CLONE2, CLONE3] } });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).worktreeShards, { enabled: true, pools: { [ORIGINAL]: [CLONE2, CLONE3] } });
    // A partial patch keeps the pools; clearing both fields removes the setting.
    assert.deepEqual((await settings.patch({ worktreeShards: { enabled: false } })).worktreeShards, { enabled: false, pools: { [ORIGINAL]: [CLONE2, CLONE3] } });
    assert.deepEqual((await settings.patch({ worktreeShards: { enabled: false, pools: {} } })).worktreeShards, DEFAULT_WORKTREE_SHARDS);
    assert.equal(existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>).worktreeShards : undefined, undefined);
    await assert.rejects(settings.patch({ worktreeShards: { pools: { nope: [CLONE2] } } }), /absolute project root path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
