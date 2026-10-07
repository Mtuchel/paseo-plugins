import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Handover, type GitState, type HandoverStatus } from "./handover";

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
