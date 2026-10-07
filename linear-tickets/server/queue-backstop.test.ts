import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BackstopCheckout,
  BackstopScriptError,
  commentOnce,
  ENQUEUE_READY,
  enqueueArgs,
  originRepo,
  inEnqueueClone,
  parseEnqueue,
  parseJudgment,
  parseReady,
  parseRetarget,
  parseRetargetList,
  parseRetrigger,
  retriggerArgs,
  readyArgs,
  reconcile,
  refusalKey,
  released,
  runGit,
  waitQueueArgs,
  type Refusal,
  type ScriptOutput,
} from "./queue-backstop";

const out = (code: number | null, value: unknown, stderr = ""): ScriptOutput => ({ code, stdout: `progress line\n${JSON.stringify(value)}\n`, stderr });
const REVISION = { state: "same", draft: 437, branch: "mtuchel/tuc-1-fix", expect: "419@a1b2c3d,1501@b2c3d4e", reason: "the draft tested these heads" };
const DROPPED = { pr: 419, result: "dropped", reason: "a check failed", class: "flaky", requeue: true, evidence: ["a known flaky test"], revision: REVISION, queueDraft: 437, failures: [{ check: "Core", conclusion: "failure", url: "https://x" }] };

test("wait-queue.mjs: a dropped round carries its class, requeue, evidence and revision; merged and still-running rounds are no drop", () => {
  assert.deepEqual(parseJudgment(out(2, DROPPED)), {
    result: "dropped", reason: "a check failed", class: "flaky", requeue: true, evidence: ["a known flaky test"],
    revision: { state: "same", draft: 437, branch: "mtuchel/tuc-1-fix", expect: "419@a1b2c3d,1501@b2c3d4e", reason: "the draft tested these heads" },
    queueDraft: 437, failures: [{ check: "Core", conclusion: "failure", url: "https://x" }],
  });
  assert.deepEqual(parseJudgment(out(0, { result: "merged" })), { result: "merged" });
  assert.deepEqual(parseJudgment(out(3, { result: "running" })), { result: "pending" });
  const genuine = parseJudgment(out(2, { ...DROPPED, class: "genuine" }));
  assert.equal(genuine.result === "dropped" && genuine.requeue, false, "a genuine drop is never requeued");
  const malformed = parseJudgment(out(2, { ...DROPPED, revision: { ...REVISION, expect: "not heads" } }));
  assert.equal(malformed.result === "dropped" && malformed.revision.expect, null, "heads that are not <pr>@<sha> are no heads");
});

test("wait-queue.mjs: no JSON, an undocumented exit, an unknown class or a missing revision is an error, never a drop", () => {
  for (const [output, why] of [
    [{ code: 1, stdout: "", stderr: "gh: HTTP 502\n" }, "no JSON"],
    [{ code: 2, stdout: "Dropped!\n", stderr: "" }, "not JSON"],
    [out(1, DROPPED), "exit 1"],
    [out(0, DROPPED), "exit 0 for a drop"],
    [out(64, { result: "usage" }), "usage"],
    [out(2, { ...DROPPED, class: "bad-luck" }), "unknown class"],
    [out(2, { ...DROPPED, requeue: "yes" }), "requeue not a boolean"],
    [out(2, { ...DROPPED, revision: undefined }), "no revision"],
    [out(2, { ...DROPPED, revision: { state: "maybe" } }), "unknown revision state"],
  ] as const) assert.throws(() => parseJudgment(output), BackstopScriptError, why);
  assert.deepEqual(waitQueueArgs(419, 437), ["419", "--draft", "437"]);
  assert.deepEqual(waitQueueArgs(419, null), ["419", "--last"]);
});

test("backstop-enqueue.mjs: the exit code and the JSON result have to agree; anything else is an error, never an enqueue", () => {
  const problems = [{ kind: "conflict-tip", draft: 900, text: "conflicts with the queue tip" }];
  assert.deepEqual(parseEnqueue(out(0, { result: "enqueued", comment: "posted" })), { result: "enqueued", problems: [], comment: "posted", error: null });
  assert.deepEqual(parseEnqueue(out(2, { result: "refused", problems })), { result: "refused", problems: [{ kind: "conflict-tip", draft: 900, text: "conflicts with the queue tip" }], comment: "none", error: null });
  assert.equal(parseEnqueue(out(3, { result: "held", problems: [{ kind: "main-red" }] })).result, "held");
  assert.equal(parseEnqueue(out(1, { result: "error", error: "gt failed" })).result, "error");
  for (const output of [out(0, { result: "refused" }), out(2, { result: "enqueued" }), out(5, { result: "enqueued" }), out(null, { result: "enqueued" }), { code: 0, stdout: "enqueued\n", stderr: "" }]) {
    const outcome = parseEnqueue(output);
    assert.equal(outcome.result, "error", output.stdout);
    assert.ok(outcome.error, output.stdout);
  }
  assert.deepEqual(enqueueArgs("mtuchel/tuc-1-fix", "419@a1b2c3d", "ready:419@a1b2c3d", "/c/r.md"), ["mtuchel/tuc-1-fix", "--expect", "419@a1b2c3d", "--action", "ready:419@a1b2c3d", "--comment-file", "/c/r.md"]);
  assert.deepEqual(enqueueArgs("b", "1@a1b2c3d", "drop:#4", null), ["b", "--expect", "1@a1b2c3d", "--action", "drop:#4"]);
});

test("retarget-orphan.mjs: a move counts as prepared only with its full record, and exit code and result have to agree; anything else is an error", () => {
  const sha = (digit: string) => digit.repeat(40);
  const range = [{ pr: 419, branch: "mtuchel/tuc-1-fix", base: "graphite-base/418", sha: sha("1") }];
  const prepared = { result: "prepared", pr: 419, base: "graphite-base/418", baseSha: sha("b"), range, onto: sha("c"), stamp: 1_700_000_000, new: { base: "main", heads: `419@${sha("3")}` }, sync: "git fetch origin", problems: [] };
  assert.deepEqual(parseRetarget(out(0, prepared)), { result: "prepared", prepared: { pr: 419, base: "graphite-base/418", baseSha: sha("b"), range, onto: sha("c"), stamp: 1_700_000_000, new: { base: "main", heads: `419@${sha("3")}` }, sync: "git fetch origin" }, problems: [], error: null });
  assert.equal(parseRetarget(out(0, { result: "retargeted" })).result, "retargeted");
  assert.deepEqual(parseRetarget(out(2, { result: "refused", problems: [{ kind: "remote-differs", text: "moved" }] })).problems, [{ kind: "remote-differs", draft: null, text: "moved" }]);
  for (const [output, why] of [
    [out(0, { ...prepared, new: { base: "main", heads: "not heads" } }), "no new heads"],
    [out(0, { ...prepared, stamp: "now" }), "no stamp"],
    [out(0, { ...prepared, onto: "main" }), "onto not a SHA"],
    [out(0, { ...prepared, range: [{ ...range[0], branch: "" }] }), "a range member without its branch"],
    [out(2, prepared), "prepared with exit 2"],
    [out(0, { result: "conflict" }), "conflict with exit 0"],
    [out(null, { result: "retargeted" }), "killed"],
    [{ code: 0, stdout: "moved\n", stderr: "" }, "not JSON"],
  ] as const) assert.equal(parseRetarget(output).result, "error", why);

  const candidate = { pr: 419, branch: "mtuchel/tuc-1-fix", base: "graphite-base/418", baseSha: sha("b"), expect: `419@${sha("1")}`, range, tickets: ["TUC-1"], eligible: true, reason: null };
  assert.deepEqual(parseRetargetList(out(0, { result: "listed", candidates: [candidate, { ...candidate, pr: 420 }, { ...candidate, baseSha: "b" }] })), [candidate], "a candidate whose stack does not start at it, or without its base head, is left out");
  const failed = `Command failed: gh api --paginate repos/o/r/pulls?state=open --jq ${"x".repeat(400)}\ngh: API rate limit exceeded (HTTP 403)\n`;
  assert.throws(() => parseRetargetList(out(1, { result: "error", error: failed })), (error: unknown) => error instanceof BackstopScriptError && error.message.includes("API rate limit exceeded (HTTP 403)"), "a failed command logs its own error line, not its long command line");
});

test("enqueue-ready.mjs: stacks without their action, branch or heads are left out; a run without stacks is an error", () => {
  const stack = { action: "ready:1501@a1b2c3d,b2c3d4e", top: 1501, branch: "mtuchel/tuc-1-b", prs: [419, 1501], expect: "419@a1b2c3d,1501@b2c3d4e", tickets: ["TUC-1"], result: "candidate" };
  const run = parseReady(out(0, {
    stacks: [stack, { ...stack, action: "1501" }, { ...stack, branch: "" }, { ...stack, expect: "everything" }, { ...stack, prs: [] }, "junk"],
    drops: [{ pr: 1329, draft: 1341, key: "#1341", revision: { state: "unknown", reason: "no draft" } }, { pr: 1330, key: "" }, { pr: 1331, draft: null, key: "Sep 29: dropped", revision: null }],
  }));
  assert.deepEqual(run.stacks, [stack]);
  assert.deepEqual(run.drops, [
    { pr: 1329, draft: 1341, key: "#1341", revision: { state: "unknown", draft: null, branch: null, expect: null, reason: "no draft" } },
    { pr: 1331, draft: null, key: "Sep 29: dropped", revision: null },
  ]);
  assert.throws(() => parseReady(out(1, { stacks: [] })), BackstopScriptError);
  assert.throws(() => parseReady(out(0, { drops: [] })), BackstopScriptError);
  assert.throws(() => parseReady({ code: 0, stdout: "", stderr: "" }), BackstopScriptError);
  assert.deepEqual(readyArgs([419, 1501], ["ready:7@a1b2c3d"]), ["--ready-minutes", "10", "--exclude", "419", "--exclude", "1501", "--skip", "ready:7@a1b2c3d"]);
});

test("greptile-retrigger.mjs: exit 0 with all four lists; a wrong exit, a missing list, an unknown state or an entry without its number is an error", () => {  // TUC-1208 AC-4
  const pull = { pr: 419, url: "https://github.com/o/r/pull/419", title: "Add TUC-1", head: "a".repeat(40), since: "2026-10-07T10:00:00Z", triggers: ["2026-10-07T10:30:00Z"], state: "triggered", overdue: false };
  const answer = { pulls: [pull], followed: [{ pr: 12, state: "reviewed" }], triggered: [{ pr: 419, head: "a".repeat(40), at: "2026-10-07T10:30:00Z" }], errors: [{ pr: 13, error: "HTTP 502" }] };
  assert.deepEqual(parseRetrigger(out(0, answer)), answer);
  assert.throws(() => parseRetrigger(out(1, { error: "cannot list the open pull requests" })), BackstopScriptError);
  assert.throws(() => parseRetrigger(out(64, { error: "usage" })), BackstopScriptError);
  assert.throws(() => parseRetrigger({ code: 0, stdout: "not json", stderr: "" }), BackstopScriptError);
  for (const field of ["pulls", "followed", "triggered", "errors"]) assert.throws(() => parseRetrigger(out(0, { ...answer, [field]: undefined })), BackstopScriptError, field);
  assert.throws(() => parseRetrigger(out(0, { ...answer, pulls: [{ ...pull, state: "asked" }] })), BackstopScriptError);
  assert.throws(() => parseRetrigger(out(0, { ...answer, pulls: [{ ...pull, pr: null }] })), BackstopScriptError);
  for (const overdue of [undefined, "true", 1, null]) {
    assert.throws(() => parseRetrigger(out(0, { ...answer, pulls: [{ ...pull, overdue }] })), BackstopScriptError);
  }
  assert.throws(() => parseRetrigger(out(0, { ...answer, followed: [{ pr: 12, state: "gone" }] })), BackstopScriptError);
  assert.throws(() => parseRetrigger(out(0, { ...answer, triggered: [{ pr: 419, head: "a" }] })), BackstopScriptError);
  assert.deepEqual(retriggerArgs([]), ["--trigger"]);
  assert.deepEqual(retriggerArgs([12, 13]), ["--trigger", "--follow", "12", "--follow", "13"]);
});

test("refusals: keyed by action and kind, a queue-tip conflict also by its draft; each kind released by the change that can fix it", () => {
  const action = "ready:419@a1b2c3d";
  assert.equal(refusalKey(action, { kind: "conflict-tip", draft: 900, text: "" }), `${action} conflict-tip #900`);
  assert.equal(refusalKey(action, { kind: "conflict-main", draft: null, text: "" }), `${action} conflict-main`);
  const now = Date.parse("2026-10-04T10:00:00Z");
  const refusal = (kind: string, more: Partial<Refusal> = {}): Refusal => ({ key: `${action} ${kind}`, action, kind, draft: null, at: "2026-10-04T09:00:00Z", routedAt: "2026-10-04T09:00:00Z", retryAfter: null, ...more });
  assert.equal(released(refusal("conflict-tip", { draft: 900 }), now, new Set([900]), false), false, "its draft is still open");
  assert.equal(released(refusal("conflict-tip", { draft: 900 }), now, new Set([901]), false), true, "its draft closed");
  for (const kind of ["local-differs", "stack-differs"]) assert.equal(released(refusal(kind, { retryAfter: "2026-10-04T11:00:00Z" }), now, new Set(), false), true, "private refs release old shared-ref refusals immediately");
  assert.equal(released(refusal("unread", { retryAfter: "2026-10-04T10:00:01Z" }), now, new Set(), false), false, "within the hour");
  assert.equal(released(refusal("unread", { retryAfter: "2026-10-04T10:00:00Z" }), now, new Set(), false), true, "an hour later");
  assert.equal(released(refusal("veto"), now, new Set(), true), false, "still vetoed");
  assert.equal(released(refusal("veto"), now, new Set(), false), true, "the label is gone");
  for (const kind of ["conflict-main", "range-changed", "unclear", "author"]) assert.equal(released(refusal(kind), now, new Set(), false), false, `${kind}: only a new head, a new action`);
});

test("restart reconciliation: an enqueue bullet after the boundary is an enqueue; none is none; a rewritten comment tells nothing", () => {
  const before = [{ text: "Sep 29, 7:00 AM UTC: queued", kind: "queued" }, { text: "Sep 29, 7:00 AM UTC: conflict", kind: "dropped" }];
  const boundary = { count: 2, last: before[1].text };
  assert.equal(reconcile(boundary, [...before, { text: "Sep 29, 7:00 AM UTC: queued", kind: "queued" }, { text: "Sep 29, 7:00 AM UTC: dropped", kind: "dropped" }]), "enqueued", "same minute, told apart by position");
  assert.equal(reconcile(boundary, before), "absent");
  assert.equal(reconcile(boundary, [...before, { text: "Sep 29, 7:01 AM UTC: removed", kind: "dropped" }]), "absent");
  assert.equal(reconcile(boundary, [{ text: "Sep 29, 8:00 AM UTC: queued", kind: "queued" }]), "mismatch", "shortened");
  assert.equal(reconcile(boundary, [before[0], { text: "edited", kind: "dropped" }, { text: "q", kind: "queued" }]), "mismatch", "rewritten");
  assert.equal(reconcile(null, before), "mismatch", "no boundary was read");
  assert.equal(reconcile({ count: 0, last: null }, [{ text: "q", kind: "queued" }]), "enqueued");
});

test("a pull request comment with the marker goes out once", async () => {
  const comments: string[] = [];
  const github = { pullComments: async () => comments, commentOnPull: async (_repo: string, _number: number, body: string) => { comments.push(body); } };
  assert.equal(await commentOnce(github, "o/r", 419, "drop:#437", "Enqueued."), "posted");
  assert.equal(await commentOnce(github, "o/r", 419, "drop:#437", "Enqueued."), "present");
  assert.deepEqual(comments, ["Enqueued.\n\n<!-- queue-backstop:drop:#437 -->"]);
});

test("the backstop checkout: one detached worktree per repo from a recorded worktree's common dir, reset to origin/main before each run; none without enqueue-ready.mjs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "queue-backstop-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "agent-worktree");
  await mkdir(source);
  const root = join(home, "queue-backstop");
  const calls: string[] = [];
  let tools = true;
  let origin = "https://github.com/tuchel-sohn/tuchel-platform.git\n";
  const git = async (args: string[]) => {
    calls.push(args.join(" ").replaceAll(home, "~"));
    if (args.includes("rev-parse")) return join(home, "repo.git");
    if (args.includes("get-url")) return origin;
    const add = args.indexOf("add");
    if (add !== -1) {
      const path = args[add + 2];
      await mkdir(join(path, "tools", "ci"), { recursive: true });
      await writeFile(join(path, ".git"), "gitdir: …");
      if (tools) await writeFile(join(path, ENQUEUE_READY), "");
    }
    return "";
  };
  const checkout = new BackstopCheckout(git, root);
  assert.equal(await checkout.prepare("tuchel-sohn/tuchel-platform", [join(home, "gone")]), null, "no worktree of the repo exists");
  assert.deepEqual(calls, []);
  const path = await checkout.prepare("tuchel-sohn/tuchel-platform", [join(home, "gone"), source]);
  assert.equal(path, join(root, "tuchel-sohn-tuchel-platform"));
  assert.deepEqual(calls, [
    "-C ~/agent-worktree rev-parse --path-format=absolute --git-common-dir",
    "--git-dir ~/repo.git remote get-url origin",
    "--git-dir ~/repo.git worktree prune",
    "--git-dir ~/repo.git fetch --quiet origin main",
    "--git-dir ~/repo.git worktree add --detach ~/queue-backstop/tuchel-sohn-tuchel-platform origin/main",
    "-C ~/queue-backstop/tuchel-sohn-tuchel-platform fetch --quiet origin main",
    "-C ~/queue-backstop/tuchel-sohn-tuchel-platform reset --hard --quiet origin/main",
  ]);
  calls.length = 0;
  assert.equal(await checkout.prepare("tuchel-sohn/tuchel-platform", [source]), path);
  assert.deepEqual(calls, ["-C ~/queue-backstop/tuchel-sohn-tuchel-platform fetch --quiet origin main", "-C ~/queue-backstop/tuchel-sohn-tuchel-platform reset --hard --quiet origin/main"], "an existing checkout is only reset");

  tools = false;
  origin = "https://github.com/other/repo.git\n";
  assert.equal(await checkout.prepare("other/repo", [source]), null, "main has no tools/ci/enqueue-ready.mjs");
  const file = await checkout.commentFile("ready:419@a1b2c3d,b2c3d4e", "Enqueued.");
  assert.equal(file, join(root, "comments", "ready_419_a1b2c3d_b2c3d4e.md"));
});

test("the backstop checkout skips a recorded folder that is not a git repository or is another repository's clone, and runs nothing when none is a clone", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "queue-backstop-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const plain = join(home, "tmp");
  const other = join(home, "other-clone");
  const clone = join(home, "agent-worktree");
  for (const folder of [plain, other, clone]) await mkdir(folder);
  const root = join(home, "queue-backstop");
  const calls: string[] = [];
  const git = async (args: string[]) => {
    calls.push(args.join(" ").replaceAll(home, "~"));
    if (args.includes("rev-parse")) {
      if (args[1] === plain) throw new Error("fatal: not a git repository (or any of the parent directories): .git");
      return join(home, args[1] === other ? "other.git" : "repo.git");
    }
    if (args.includes("get-url")) return args[1].endsWith("other.git") ? "git@github.com:Mtuchel/zeiterfassung.git" : "git@github.com:Tuchel-Sohn/tuchel-platform.git";
    const add = args.indexOf("add");
    if (add !== -1) {
      const path = args[add + 2];
      await mkdir(join(path, "tools", "ci"), { recursive: true });
      await writeFile(join(path, ".git"), "gitdir: …");
      await writeFile(join(path, ENQUEUE_READY), "");
    }
    return "";
  };
  const checkout = new BackstopCheckout(git, root);

  assert.equal(await checkout.prepare("tuchel-sohn/tuchel-platform", [plain, other]), null, "neither folder is a clone of the repo");
  assert.ok(!calls.some((call) => call.includes("worktree add")), "nothing is added from a folder of another repository");

  calls.length = 0;
  const path = await checkout.prepare("tuchel-sohn/tuchel-platform", [plain, other, clone]);
  assert.equal(path, join(root, "tuchel-sohn-tuchel-platform"));
  assert.ok(calls.includes("--git-dir ~/repo.git worktree add --detach ~/queue-backstop/tuchel-sohn-tuchel-platform origin/main"), "the clone of the repo is used");
});

test("originRepo reads owner/repo only from github.com itself, never a lookalike host or a path naming github.com", () => {
  assert.equal(originRepo("https://github.com/Tuchel-Sohn/tuchel-platform.git\n"), "tuchel-sohn/tuchel-platform");
  assert.equal(originRepo("git@github.com:Mtuchel/paseo-plugins"), "mtuchel/paseo-plugins");
  assert.equal(originRepo("ssh://git@github.com/Mtuchel/paseo-plugins.git"), "mtuchel/paseo-plugins");
  assert.equal(originRepo("https://github.com/o/r/"), "o/r");
  for (const remote of [
    "https://notgithub.com/tuchel-sohn/tuchel-platform.git",
    "https://github.com.evil/github.com/tuchel-sohn/tuchel-platform.git",
    "https://evil.example/github.com/tuchel-sohn/tuchel-platform",
    "git@notgithub.com:tuchel-sohn/tuchel-platform.git",
    "git@evil.example:github.com:tuchel-sohn/tuchel-platform",
    "https://github.com:8443/tuchel-sohn/tuchel-platform",
    "http://github.com/tuchel-sohn/tuchel-platform",
    "https://github.com/tuchel-sohn/tuchel-platform/extra",
    "https://gitlab.com/o/r.git",
    "/srv/git/tuchel-platform.git",
    "",
  ])
    assert.equal(originRepo(remote), null, remote);
});

test("private enqueue refs follow the trusted head, leaving divergent worker commits, dirty files and Graphite metadata untouched", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "queue-ref-isolation-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "source");
  await runGit(["init", "--quiet", "--initial-branch=main", source]);
  await runGit(["-C", source, "remote", "add", "origin", "https://github.com/o/r.git"]);
  await writeFile(join(source, "file"), "trusted\n");
  await runGit(["-C", source, "add", "file"]);
  await runGit(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "trusted"]);
  const trusted = await runGit(["-C", source, "rev-parse", "HEAD"]);
  await runGit(["-C", source, "switch", "--quiet", "-c", "worker"]);
  await writeFile(join(source, "file"), "unpushed worker commit\n");
  await runGit(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-am", "worker"]);
  const worker = await runGit(["-C", source, "rev-parse", "HEAD"]);
  await writeFile(join(source, "file"), "dirty worker file\n");
  await writeFile(join(source, ".git", ".graphite_metadata.db"), "worker parent metadata");
  const before = await runGit(["-C", source, "status", "--porcelain"]);
  const checkout = join(home, "trusted");
  await runGit(["-C", source, "worktree", "add", "--quiet", "--detach", checkout, trusted]);
  let used = "";
  const result = await inEnqueueClone(checkout, async (clone) => {
    used = clone;
    assert.equal(await runGit(["-C", clone, "rev-parse", "main"]), trusted);
    assert.equal(await runGit(["-C", clone, "remote", "get-url", "origin"]), "https://github.com/o/r.git");
    await assert.rejects(runGit(["-C", clone, "show-ref", "--verify", "refs/heads/worker"]));
    await runGit(["-C", clone, "branch", "worker", trusted]);
    await writeFile(join(clone, ".git", ".graphite_metadata.db"), "enqueue parent metadata");
    return out(2, { result: "refused", problems: [{ kind: "conflict-main" }] });
  });
  assert.equal(parseEnqueue(result).result, "refused", "a real refusal is not disguised as recovery");
  await assert.rejects(access(used), "the invocation's clone is removed");
  assert.equal(await runGit(["-C", source, "rev-parse", "worker"]), worker);
  assert.equal(await runGit(["-C", source, "status", "--porcelain"]), before);
  assert.equal(await readFile(join(source, "file"), "utf8"), "dirty worker file\n");
  assert.equal(await readFile(join(source, ".git", ".graphite_metadata.db"), "utf8"), "worker parent metadata");
  await assert.rejects(inEnqueueClone(checkout, async (clone) => {
    used = clone;
    throw new Error("interrupted enqueue");
  }), /interrupted enqueue/);
  await assert.rejects(access(used), "a failed invocation is cleaned up too");
});
