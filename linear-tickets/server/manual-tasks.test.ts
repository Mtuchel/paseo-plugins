import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HandoverRecord } from "./handover";
import type { IssueStatus } from "./linear";
import { ManualTasks, runCheck, type CheckResult, type ManualTask } from "./manual-tasks";
import { PullRequestWatch, type PullRequestView } from "./pr-watch";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const settings = { dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, status: true } } as unknown as PluginSettings;
const OWNER = "https://linear.app/ws/profiles/me";

function task(id: string, overrides: Partial<ManualTask> = {}): ManualTask {
  return { id, identifier: id.toUpperCase(), url: `https://linear.app/x/issue/${id}`, title: `Do ${id}`, parentId: "parent", parentIdentifier: "TUC-1", when: "anytime", check: null, cwd: "/nowhere", createdAt: "2026-09-28T00:00:00Z", announced: true, activated: true, verifiedAt: null, ...overrides };
}

class FakeLinear {
  writes: string[] = [];
  statuses = new Map<string, IssueStatus>();
  async issueStatuses(ids: string[]) { return new Map(ids.filter((id) => this.statuses.has(id)).map((id) => [id, this.statuses.get(id)!])); }
  async addLabel(issueId: string, name: string) { this.writes.push(`+${name} ${issueId}`); }
  async comment(issueId: string, body: string) { this.writes.push(`comment ${issueId}: ${body}`); }
  async moveToReady(issueId: string) { this.writes.push(`ready ${issueId}`); return { changed: true }; }
  async reopen(issueId: string) { this.writes.push(`reopen ${issueId}`); this.statuses.set(issueId, { status: "Todo", statusType: "unstarted", completedAt: null }); }
  async viewerId() { return "me"; }
  async userUrl() { return OWNER; }
}

async function setup(tasks: ManualTask[], check?: (command: string, cwd: string) => Promise<CheckResult>) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-manual-tasks-"));
  for (const item of tasks) await writeFile(join(directory, `${item.id}.json`), JSON.stringify(item));
  const linear = new FakeLinear();
  const manual = new ManualTasks({ linear: linear as never, settings: { read: async () => settings }, check }, directory);
  const stored = async () => Object.fromEntries(await Promise.all((await readdir(directory)).map(async (name): Promise<[string, ManualTask]> => [name.replace(".json", ""), JSON.parse(await readFile(join(directory, name), "utf8"))])));
  return { directory, linear, manual, stored, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("new manual tasks get the label and one owner mention per ticket, only once", async () => {
  const { linear, manual, stored, cleanup } = await setup([
    task("a", { announced: false, when: "before_merge" }),
    task("b", { announced: false, when: "after_merge", activated: false }),
    task("c", { announced: false, parentId: "other", parentIdentifier: "TUC-2" }),
    task("gone", { announced: false }),
  ]);
  try {
    for (const id of ["a", "b", "c"]) linear.statuses.set(id, id === "b" ? { status: "Backlog", statusType: "backlog", completedAt: null } : { status: "Todo", statusType: "unstarted", completedAt: null });
    await manual.poll();
    assert.deepEqual(linear.writes, [
      "+paseo-manual a", "+paseo-manual b",
      `comment parent: ${OWNER} 2 manual tasks need you on this ticket:\n- [A](https://linear.app/x/issue/a) Do a (before merge)\n- [B](https://linear.app/x/issue/b) Do b (after merge)`,
      "+paseo-manual c",
      `comment other: ${OWNER} A manual task needs you on this ticket:\n- [C](https://linear.app/x/issue/c) Do c (due now)`,
    ]);
    const after = await stored();
    assert.deepEqual(Object.keys(after).sort(), ["a", "b", "c"], "a task deleted in Linear leaves the watch list");
    assert.ok(Object.values(after).every((item) => item.announced));
    linear.writes.length = 0;
    await manual.poll();
    assert.deepEqual(linear.writes, []);
  } finally { await cleanup(); }
});

test("a done task runs its check once per completion: passing verifies, failing reopens without leaking output", async () => {
  const runs: string[] = [];
  let pass = false;
  const { linear, manual, stored, cleanup } = await setup([task("a", { check: "railway variables | grep -q X" }), task("plain"), task("dropped", { check: "true" })], async (command, cwd) => {
    runs.push(`${command} @ ${cwd}`);
    return { ok: pass, code: pass ? 0 : 3, output: "SECRET=hunter2", cwd: "/home/me" };
  });
  try {
    linear.statuses.set("a", { status: "Done", statusType: "completed", completedAt: "t1" });
    linear.statuses.set("plain", { status: "Done", statusType: "completed", completedAt: "t1" });
    linear.statuses.set("dropped", { status: "Canceled", statusType: "canceled", completedAt: null });
    assert.equal((await manual.openBlockers("parent")).length, 0, "only before-merge tasks gate");
    await manual.poll();
    assert.deepEqual(runs, ["railway variables | grep -q X @ /nowhere"]);
    assert.deepEqual(linear.writes, ["reopen a", `comment a: ${OWNER} This task was reopened: its check failed (exit code 3; ran in \`/home/me\`). The output is in \`paseo plugin logs linear-tickets\`.`]);
    assert.ok(!linear.writes.join("\n").includes("hunter2"));
    assert.deepEqual(Object.keys(await stored()), ["a"], "done without a check, and canceled, leave the watch list");

    await manual.poll();
    assert.equal(runs.length, 1, "a reopened task is not checked again");

    pass = true;
    linear.writes.length = 0;
    linear.statuses.set("a", { status: "Done", statusType: "completed", completedAt: "t2" });
    await manual.poll();
    assert.deepEqual(linear.writes, ["comment a: ✓ Verified: the check passed (ran in `/home/me`)."]);
    assert.deepEqual(Object.keys(await stored()), []);
  } finally { await cleanup(); }
});

test("before-merge tasks block until done and verified; a merge makes after-merge tasks due and names late ones", async () => {
  const { linear, manual, stored, cleanup } = await setup([
    task("gate", { when: "before_merge", check: "true" }),
    task("later", { when: "after_merge", activated: false }),
    task("now", { when: "anytime" }),
  ]);
  try {
    linear.statuses.set("gate", { status: "Done", statusType: "completed", completedAt: "t1" });
    linear.statuses.set("later", { status: "Backlog", statusType: "backlog", completedAt: null });
    linear.statuses.set("now", { status: "Todo", statusType: "unstarted", completedAt: null });
    assert.deepEqual((await manual.openBlockers("parent")).map((item) => item.id), ["gate"], "done but not yet verified still blocks");
    assert.equal(await manual.awaitingMerge("parent"), true);
    await manual.merged("parent");
    assert.deepEqual(linear.writes, ["ready later", `comment parent: ${OWNER} The pull request was merged. Now due:\n- [LATER](https://linear.app/x/issue/later) Do later\n\nThe pull request was merged while these were still open, although they were due before the merge:\n- [GATE](https://linear.app/x/issue/gate) Do gate`]);
    assert.equal((await stored()).later.activated, true);
    assert.equal(await manual.awaitingMerge("parent"), false);
  } finally { await cleanup(); }
});

test("an approval waits for before-merge tasks, then moves to Ready to merge; archived agents stay watched until the merge", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-pr-watch-"));
  const record = { issueId: "parent", identifier: "TUC-1", agentId: "a1", agentTitle: "T", links: { "Pull request": "https://github.com/o/r/pull/1" }, status: "archived" } as unknown as HandoverRecord;
  let view: PullRequestView = { state: "OPEN", isDraft: false, headSha: "h", headBranch: "tuc-1", baseBranch: "main", updatedAt: "", reviewDecision: "", labels: [], mergeActivity: null, comments: [], reviews: [{ author: "ada", state: "APPROVED", submittedAt: "2026-01-01T12:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T11:00:00Z", checks: [{ name: "ci", url: "", state: "pending", conclusion: "pending" }] };
  let open = ["TUC-9"];
  let awaiting = true;
  const calls: string[] = [];
  const watch = new PullRequestWatch({
    handover: { all: async () => [record], update: async (_issue, _agent, patch) => { calls.push(`review ${patch.review}`); return null as never; } },
    sessions: { sessionFor: async () => ({ sessionId: "s" }) as never, say: async (_id, _kind, text) => { calls.push(`say ${text}`); }, prompt: async () => "gone" as const, link: async () => {} },
    linear: { moveToStateNamed: async (_id, name) => { calls.push(`move ${name}`); return { changed: true }; }, comment: async () => {}, viewerId: async () => "u", userUrl: async () => "u", linkUrl: async () => {} },
    settings: { read: async () => settings },
    manualTasks: {
      openBlockers: async () => open.map((identifier) => ({ identifier }) as ManualTask),
      awaitingMerge: async () => awaiting,
      merged: async (issueId) => { calls.push(`merged ${issueId}`); awaiting = false; },
    },
    view: async () => view,
    github: { drafts: async () => [], landed: async () => false, failedChecks: async () => [], reviewThreads: async () => [], openPullRequests: async () => [], branchExists: async () => true },
  }, join(home, "pr-watch.json"));
  try {
    await watch.poll();
    assert.deepEqual(calls, ["review approved by @ada; waiting on manual tasks TUC-9", "say @ada approved the pull request, but a manual task is due before merge: TUC-9."]);
    calls.length = 0;
    await watch.poll();
    assert.deepEqual(calls, [], "still held, nothing new");
    open = [];
    await watch.poll();
    assert.deepEqual(calls, ["move Ready to merge", "review approved; manual tasks done", "say The manual tasks due before merge are done — ready to merge."]);
    calls.length = 0;
    view = { ...view, state: "MERGED" };
    await watch.poll();
    assert.deepEqual(calls, ["review merged", "say The pull request was merged.", "merged parent"]);
    calls.length = 0;
    await watch.poll();
    assert.deepEqual(calls, [], "archived and nothing awaiting the merge: no longer watched");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("checks run without stdin in their directory, falling back to home when it is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-check-"));
  try {
    await mkdir(join(directory, "sub"));
    const here = await runCheck("pwd; read line; test -z \"$line\"", join(directory, "sub"));
    assert.equal(here.ok, true);
    assert.match(here.output, /paseo-check-.*\/sub/);
    const failed = await runCheck("exit 4", join(directory, "missing"));
    assert.deepEqual({ ok: failed.ok, code: failed.code, cwd: failed.cwd }, { ok: false, code: 4, cwd: homedir() });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
