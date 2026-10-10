import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Handover, ownedPullRequests, type GitState, type HandoverStatus } from "./handover";

const exec = promisify(execFile);

const ISSUE = { id: "issue-1", identifier: "ENG-1" };
const PREDECESSOR = { id: "agent-1", title: "ENG-1: Fix sign-in", cwd: "/wt/eng-1" };
const SUCCESSOR = { id: "agent-2", title: "ENG-1: Fix sign-in (resumed)", cwd: "/wt/eng-1" };
const THIRD = { id: "agent-3", title: "ENG-1: Fix sign-in (again)", cwd: "/wt/eng-1" };
const GIT: GitState = { branch: "mtuchel/eng-1-fix", lastCommit: "abc123 push the fix" };

type Write = { kind: "progress" | "report"; body: string; commentId: string | null };

// Linear as a takeover sees it: one progress comment edited in place, and the final report.
function fakeLinear() {
  const writes: Write[] = [];
  let comments = 0;
  const linear = {
    upsertComment: async (_issue: string, body: string, commentId: string | null) => {
      writes.push({ kind: "progress", body, commentId });
      return commentId ?? `c${++comments}`;
    },
    comment: async (_issue: string, body: string) => { writes.push({ kind: "report", body, commentId: null }); },
    upsertAttachment: async () => {},
    removeAttachments: async () => {},
  };
  return { linear: linear as never, writes };
}

async function withHandover(run: (handover: Handover, writes: Write[]) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-handover-takeover-"));
  try {
    const { linear, writes } = fakeLinear();
    const handover = new Handover(linear, directory, async () => GIT, () => "2026-01-01T10:00:00.000Z");
    await run(handover, writes);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// The predecessor's own record: a branch, a commit and one report of its work.
async function predecessorWrote(handover: Handover): Promise<void> {
  await handover.update(ISSUE, PREDECESSOR, { summary: "Rebased on main and pushed the fix." });
}

test("a hand-off to a successor that has not written yet moves the record to it and reports the predecessor's own work", async () => {
  await withHandover(async (handover, writes) => {
    await predecessorWrote(handover);
    writes.length = 0;

    assert.equal(await handover.handOff(ISSUE, PREDECESSOR.id, SUCCESSOR, { title: PREDECESSOR.title }), true, "the record was the predecessor's");

    const record = await handover.read(ISSUE.id);
    assert.equal(record?.agentId, SUCCESSOR.id);
    assert.equal(record?.agentTitle, SUCCESSOR.title);
    assert.equal(record?.status, "working");
    assert.equal(record?.branch, GIT.branch, "the successor continues on the recorded branch");
    assert.equal(record?.lastCommit, GIT.lastCommit);
    assert.equal(record?.resumedFrom, PREDECESSOR.id);
    assert.deepEqual(record?.summaries, ["Rebased on main and pushed the fix."]);

    // The successor's progress comment starts fresh and says Working; the predecessor's own comment
    // ends as Agent closed, followed by its final report.
    assert.equal(writes.length, 3);
    assert.equal(writes[0].commentId, null);
    assert.match(writes[0].body, /^🛠 \*\*Paseo progress\*\* — ENG-1: Fix sign-in \(resumed\)/);
    assert.match(writes[0].body, /\*\*Phase:\*\* Working/);
    assert.match(writes[0].body, new RegExp(`\\*\\*Branch:\\*\\* \`${GIT.branch}\``));
    assert.equal(writes[1].commentId, "c1", "the predecessor's progress comment is edited, not replaced");
    assert.match(writes[1].body, /\*\*Phase:\*\* Agent closed/);
    assert.equal(writes[2].kind, "report");
    assert.match(writes[2].body, /^🏁 \*\*Paseo final report\*\* — ENG-1: Fix sign-in\n/);
    assert.match(writes[2].body, /\*\*Outcome:\*\* Agent closed — handed over to ENG-1: Fix sign-in \(resumed\)/);
    assert.match(writes[2].body, new RegExp(`\\*\\*Branch:\\*\\* \`${GIT.branch}\` · \\*\\*Last commit:\\*\\* \`${GIT.lastCommit}\``));
    assert.match(writes[2].body, /Rebased on main and pushed the fix\./);

    // A later report for the predecessor never hands the record back.
    writes.length = 0;
    assert.equal(await handover.handOff(ISSUE, PREDECESSOR.id, SUCCESSOR, { title: PREDECESSOR.title }), false);
    assert.equal((await handover.read(ISSUE.id))?.agentId, SUCCESSOR.id);
  });
});

test("a record the successor already wrote keeps its owner and its status in every phase", async () => {
  for (const status of ["working", "waiting", "failed", "finished"] as HandoverStatus[]) {
    await withHandover(async (handover, writes) => {
      await predecessorWrote(handover);
      await handover.update(ISSUE, SUCCESSOR, { summary: "The successor's own report.", status });
      writes.length = 0;

      assert.equal(await handover.handOff(ISSUE, PREDECESSOR.id, SUCCESSOR, { title: PREDECESSOR.title }), false, status);

      const record = await handover.read(ISSUE.id);
      assert.equal(record?.agentId, SUCCESSOR.id, status);
      assert.equal(record?.status, status, status);
      assert.deepEqual(record?.summaries, ["Rebased on main and pushed the fix.", "The successor's own report."], status);
      // Nothing of the record is the predecessor's any more: only who took over.
      assert.equal(writes.length, 1, status);
      assert.equal(writes[0].kind, "report", status);
      assert.equal(writes[0].body, "🏁 **Paseo final report** — ENG-1: Fix sign-in\n\n**Outcome:** Agent closed — handed over to ENG-1: Fix sign-in (resumed)", status);
    });
  }
});

test("a record a third agent owns is not touched, and the predecessor's report says only who took over", async () => {
  await withHandover(async (handover, writes) => {
    await predecessorWrote(handover);
    await handover.update(ISSUE, THIRD, { summary: "The third agent took the ticket.", status: "waiting" });
    writes.length = 0;

    assert.equal(await handover.handOff(ISSUE, PREDECESSOR.id, SUCCESSOR, { title: PREDECESSOR.title }), false);

    const record = await handover.read(ISSUE.id);
    assert.equal(record?.agentId, THIRD.id);
    assert.equal(record?.status, "waiting");
    assert.deepEqual(record?.summaries, ["Rebased on main and pushed the fix.", "The third agent took the ticket."]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body, "🏁 **Paseo final report** — ENG-1: Fix sign-in\n\n**Outcome:** Agent closed — handed over to ENG-1: Fix sign-in (resumed)");
    assert.ok(!writes.some((write) => write.body.includes("The third agent took the ticket.")), "the third agent's record stays its own");
  });
});

test("a ticket with no record yet gets the successor's record from the hand-off", async () => {
  await withHandover(async (handover, writes) => {
    assert.equal(await handover.handOff(ISSUE, PREDECESSOR.id, SUCCESSOR, { title: PREDECESSOR.title }), true);
    const record = await handover.read(ISSUE.id);
    assert.equal(record?.agentId, SUCCESSOR.id);
    assert.equal(record?.status, "working");
    assert.equal(record?.branch, GIT.branch);
    // No record of the predecessor's own was ever written: the report is the minimal one.
    const reports = writes.filter((write) => write.kind === "report");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].body, "🏁 **Paseo final report** — ENG-1: Fix sign-in\n\n**Outcome:** Agent closed — handed over to ENG-1: Fix sign-in (resumed)");
  });
});

// The snapshot a strict resume carries to the peer host: real git, so the branch, the full SHA
// and the dirty state are exactly what a forwarded replacement would travel with.
async function withWorktree(): Promise<{ cwd: string; git: (...args: string[]) => Promise<string>; done: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-handover-worktree-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", cwd, ...args], { maxBuffer: 1_000_000 })).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(cwd, "work.txt"), "one\n");
  await git("add", "work.txt");
  await git("commit", "--quiet", "-m", "first");
  return { cwd, git, done: () => rm(cwd, { recursive: true, force: true }) };
}

test("the resume snapshot carries the recorded branch's exact commit and dirty state, never the worktree path", async () => {
  const worktree = await withWorktree();
  const directory = await mkdtemp(join(tmpdir(), "paseo-handover-snapshot-"));
  try {
    await worktree.git("checkout", "--quiet", "-b", "mtuchel/eng-1-fix");
    const head = await worktree.git("rev-parse", "HEAD");
    const { linear } = fakeLinear();
    const handover = new Handover(linear, directory, undefined, () => "2026-01-01T10:00:00.000Z");
    await handover.update(ISSUE, { ...PREDECESSOR, cwd: worktree.cwd }, { summary: "Rebased on main and pushed the fix." });

    const snapshot = await handover.resumeSnapshot(ISSUE.id);
    assert.equal(snapshot?.branch, "mtuchel/eng-1-fix");
    assert.equal(snapshot?.commit, head);
    assert.match(snapshot?.commit ?? "", /^[0-9a-f]{40}$/, "the commit is the full SHA the receiving host can require");
    assert.equal(snapshot?.dirty, false);
    assert.ok(!snapshot!.handover!.includes(worktree.cwd), "the worktree path never travels");
    assert.match(snapshot!.handover!, /continuing work on Linear ticket ENG-1/);
    assert.match(snapshot!.handover!, /Worktree: a fresh checkout/, "the receiving host opens its own checkout");

    // Uncommitted work does not move the commit; it is what blocks the resume on the other side.
    await writeFile(join(worktree.cwd, "work.txt"), "two\n");
    const dirty = await handover.resumeSnapshot(ISSUE.id);
    assert.equal(dirty?.dirty, true);
    assert.equal(dirty?.commit, head);

    // A worktree off the recorded branch cannot vouch for an exact commit on it.
    await worktree.git("checkout", "--quiet", "-b", "another-branch");
    assert.equal(await handover.resumeSnapshot(ISSUE.id), null);
  } finally {
    await worktree.done();
    await rm(directory, { recursive: true, force: true });
  }
});

test("no resume snapshot is offered without a record, a recorded branch or a readable worktree", async () => {
  const worktree = await withWorktree();
  const directory = await mkdtemp(join(tmpdir(), "paseo-handover-snapshot-"));
  try {
    const { linear } = fakeLinear();
    const handover = new Handover(linear, directory, undefined, () => "2026-01-01T10:00:00.000Z");
    assert.equal(await handover.resumeSnapshot("nothing"), null);

    // A worktree that was pruned after the record: the branch is still recorded, but its state
    // cannot be verified any more.
    const pruned = `${worktree.cwd}-pruned`;
    await worktree.git("worktree", "add", "--quiet", pruned, "-b", "mtuchel/eng-2-fix");
    await handover.update({ id: "issue-2", identifier: "ENG-2" }, { id: "agent-1", title: null, cwd: pruned }, {});
    assert.ok((await handover.read("issue-2"))?.branch, "the record names the branch");
    await rm(pruned, { recursive: true, force: true });
    assert.equal(await handover.resumeSnapshot("issue-2"), null, "an unreadable worktree offers no snapshot");
  } finally {
    await worktree.done();
    await rm(directory, { recursive: true, force: true });
  }
});

// --- Handover.transfer: a pull request's ownership moves between tickets' records (TUC-1890) ------

const PR = "https://github.com/o/r/pull/7";
const OTHER_PR = "https://github.com/o/r/pull/8";
const SOURCE = { issueId: ISSUE.id, identifier: ISSUE.identifier };
const TARGET = { issueId: "issue-2", identifier: "ENG-2" };

test("a pull request moves to a ticket without a record: an agentless record on its branch owns it, the source keeps everything else, and a late source link cannot take it back", async () => {
  await withHandover(async (handover, writes) => {
    await handover.update(ISSUE, PREDECESSOR, { summary: "Opened the pull request.", link: ["Pull request", PR], plan: "approved" });
    writes.length = 0;
    assert.equal(await handover.transfer(PR, SOURCE, TARGET, "mtuchel/eng-2-work"), "moved");
    const target = await handover.read(TARGET.issueId);
    assert.equal(target?.agentId, null);
    assert.equal(target?.status, "archived");
    assert.equal(target?.branch, "mtuchel/eng-2-work");
    assert.deepEqual(target?.links, { "Pull request": PR });
    assert.deepEqual(target?.summaries, [], "no report, plan or agent of the source is copied");
    assert.equal(target?.plan, undefined);
    const source = await handover.read(ISSUE.id);
    assert.equal(source?.agentId, PREDECESSOR.id);
    assert.equal(source?.plan, "approved");
    assert.equal(source?.links["Pull request"], undefined, "only the pull request left the source");
    assert.deepEqual(writes, [], "a move posts nothing on Linear");
    assert.match((await handover.resumeTarget(TARGET.issueId))?.handover ?? "", /moved here from another ticket; no Paseo agent has worked on this ticket yet/);

    // The source agent's write-back links the pull request again: the move stands.
    await handover.update(ISSUE, PREDECESSOR, { link: ["Pull request", PR], summary: "Pushed again." });
    assert.equal((await handover.read(ISSUE.id))?.links["Pull request"], undefined);
    assert.equal(await handover.transfer(PR, SOURCE, TARGET, null), "already");
    assert.equal(await handover.transfer(PR, { issueId: "issue-9", identifier: "ENG-9" }, TARGET, null), "already");
    assert.equal(await handover.transfer(OTHER_PR, SOURCE, TARGET, null), "not-owned", "a pull request the source does not own never moves");
  });
});

test("a destination with its own pull request keeps it as primary and owns the moved one too, its concurrent update survives, and the source's next pull request becomes its primary", async () => {
  await withHandover(async (handover) => {
    await handover.update(ISSUE, PREDECESSOR, { link: ["Pull request", PR] });
    const destination = { id: "agent-9", title: "ENG-2: Other", cwd: "/wt/eng-2" };
    await handover.update({ id: TARGET.issueId, identifier: TARGET.identifier }, destination, { link: ["Pull request", OTHER_PR] });
    // The source owns a second pull request besides its primary one (an earlier move to it).
    const third = "https://github.com/o/r/pull/9";
    await handover.update({ id: "issue-3", identifier: "ENG-3" }, { id: "agent-3", title: "ENG-3", cwd: "/wt/eng-3" }, { link: ["Pull request", third] });
    assert.equal(await handover.transfer(third, { issueId: "issue-3", identifier: "ENG-3" }, SOURCE, "b"), "moved");
    assert.deepEqual((await handover.read(ISSUE.id))?.pullRequests, [third], "the source already had a primary: the moved one is added");

    const [moved] = await Promise.all([
      handover.transfer(PR, SOURCE, TARGET, "ignored"),
      handover.update({ id: TARGET.issueId, identifier: TARGET.identifier }, destination, { summary: "The destination's own work." }),
    ]);
    assert.equal(moved, "moved");
    const target = await handover.read(TARGET.issueId);
    assert.equal(target?.agentId, "agent-9");
    assert.equal(target?.links["Pull request"], OTHER_PR, "the destination's primary pull request stays primary");
    assert.deepEqual(target?.pullRequests, [PR]);
    assert.equal(target?.branch, GIT.branch, "a destination with an agent keeps its own branch");
    assert.deepEqual(target?.summaries, ["The destination's own work."]);
    const source = await handover.read(ISSUE.id);
    assert.equal(source?.links["Pull request"], third, "the source's remaining pull request is now its primary one");
    assert.equal(source?.pullRequests, undefined);
  });
});

test("a move interrupted after any durable step finishes on the next read, with one owner and nothing written twice", async () => {
  for (const stage of ["journal", "destination", "both"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "paseo-handover-transfer-"));
    try {
      const { linear } = fakeLinear();
      const before = new Handover(linear, directory, async () => GIT, () => "2026-01-01T10:00:00.000Z");
      await before.update(ISSUE, PREDECESSOR, { link: ["Pull request", PR], summary: "Opened it." });
      const source = (await before.read(ISSUE.id))!;
      await mkdir(join(directory, "transfers"), { recursive: true });
      await writeFile(join(directory, "transfers", "journal.json"), JSON.stringify({ "o/r#7": { generation: 1, url: PR, from: SOURCE, to: TARGET, headBranch: "eng-2", state: "pending", at: "2026-01-01T10:00:00.000Z" } }));
      if (stage !== "journal") await writeFile(join(directory, "issue-2.json"), JSON.stringify({ issueId: TARGET.issueId, identifier: TARGET.identifier, agentId: null, agentTitle: "Paseo on ENG-2", branch: "eng-2", worktreePath: null, lastCommit: null, summaries: [], links: { "Pull request": PR }, status: "archived", progressCommentId: null, resumedFrom: null, updatedAt: "2026-01-01T10:00:00.000Z" }));
      if (stage === "both") await writeFile(join(directory, "issue-1.json"), JSON.stringify({ ...source, links: {} }));

      const after = new Handover(linear, directory, async () => GIT, () => "2026-01-01T11:00:00.000Z");
      const owners = (await after.all()).filter((record) => record.links["Pull request"] === PR || record.pullRequests?.includes(PR)).map((record) => record.identifier);
      assert.deepEqual(owners, ["ENG-2"], stage);
      assert.deepEqual((await after.read(ISSUE.id))?.summaries, ["Opened it."], stage);
      const journal = JSON.parse(await readFile(join(directory, "transfers", "journal.json"), "utf8"));
      assert.equal(journal["o/r#7"].state, "completed", stage);
      assert.equal(journal["o/r#7"].generation, 1, stage);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a move back is a newer generation, and an agent taking over the agentless record keeps the moved pull request", async () => {
  await withHandover(async (handover) => {
    await handover.update(ISSUE, PREDECESSOR, { link: ["Pull request", PR] });
    assert.equal(await handover.transfer(PR, SOURCE, TARGET, "eng-2"), "moved");
    assert.equal(await handover.transfer(PR, TARGET, SOURCE, "eng-2"), "moved");
    assert.equal((await handover.read(ISSUE.id))?.links["Pull request"], PR);
    assert.equal((await handover.read(TARGET.issueId))?.links["Pull request"], undefined);
    // The newer generation decides: the source may link it again, the old destination not.
    await handover.update(ISSUE, PREDECESSOR, { link: ["Pull request", PR] });
    assert.equal((await handover.read(ISSUE.id))?.links["Pull request"], PR);

    assert.equal(await handover.transfer(PR, SOURCE, TARGET, "eng-2"), "moved");
    const successor = { id: "agent-7", title: "ENG-2: Continue", cwd: "/wt/eng-2" };
    assert.equal(await handover.handOff({ id: TARGET.issueId, identifier: TARGET.identifier }, null, successor), true, "the agentless record is the null predecessor's");
    const record = await handover.read(TARGET.issueId);
    assert.equal(record?.agentId, successor.id);
    assert.equal(record?.links["Pull request"], PR);
    assert.equal(record?.resumedFrom, null);
  });
});

test("a replaced pull request the ticket owns besides its primary one gives way alone: the primary one and the others stay", async () => {
  await withHandover(async (handover) => {
    await handover.update(ISSUE, PREDECESSOR, { link: ["Pull request", OTHER_PR] });
    await handover.update({ id: TARGET.issueId, identifier: TARGET.identifier }, { id: "agent-9", title: "ENG-2", cwd: "/wt/eng-2" }, { link: ["Pull request", PR] });
    const third = "https://github.com/o/r/pull/9";
    await handover.update({ id: "issue-3", identifier: "ENG-3" }, { id: "agent-3", title: "ENG-3", cwd: "/wt/eng-3" }, { link: ["Pull request", third] });
    assert.equal(await handover.transfer(third, { issueId: "issue-3", identifier: "ENG-3" }, SOURCE, "eng-3"), "moved");
    assert.deepEqual((await handover.read(ISSUE.id))?.pullRequests, [third]);
    const replacement = "https://github.com/o/r/pull/10";
    await handover.swapPullRequest(ISSUE.id, third, replacement);
    const record = await handover.read(ISSUE.id);
    assert.equal(record?.links["Pull request"], OTHER_PR, "the primary pull request stays");
    assert.deepEqual(record?.pullRequests, [replacement]);
    // The next pull request after a landing that the ticket already owns: the landed one just goes.
    await handover.swapPullRequest(ISSUE.id, replacement, OTHER_PR);
    assert.deepEqual(ownedPullRequests((await handover.read(ISSUE.id))!), [OTHER_PR]);
    // One whose last move took it to another ticket is not taken (only the old one goes).
    assert.equal(await handover.transfer(PR, TARGET, { issueId: "issue-3", identifier: "ENG-3" }, "eng-2"), "moved");
    await handover.swapPullRequest(ISSUE.id, OTHER_PR, PR);
    assert.deepEqual(ownedPullRequests((await handover.read(ISSUE.id))!), []);
    assert.deepEqual(ownedPullRequests((await handover.read("issue-3"))!), [PR]);
    // A pull request the ticket does not own changes nothing.
    await handover.swapPullRequest("issue-3", OTHER_PR, replacement);
    assert.deepEqual(ownedPullRequests((await handover.read("issue-3"))!), [PR]);
  });
});

test("a list or read issued while a move runs sees the pull request on exactly one ticket", async () => {
  await withHandover(async (handover) => {
    await handover.update(ISSUE, PREDECESSOR, { link: ["Pull request", PR] });
    const [moved, all, target] = await Promise.all([handover.transfer(PR, SOURCE, TARGET, "eng-2"), handover.all(), handover.read(TARGET.issueId)]);
    assert.equal(moved, "moved");
    assert.deepEqual(all.filter((record) => ownedPullRequests(record).includes(PR)).map((record) => record.identifier), ["ENG-2"]);
    assert.equal(target?.links["Pull request"], PR);
  });
});
