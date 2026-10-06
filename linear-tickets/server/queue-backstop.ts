import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { paseoHome } from "./ticket-mcp";

const exec = promisify(execFile);

// The queue backstop (TUC-615): the repo's scripts decide, the plugin only runs them. They live in
// the repo's tools/ci and are run from a trusted checkout of `origin/main`:
// - `wait-queue.mjs <pr> --draft <n>` / `--last`: one queue round judged, with the drop's `class`,
//   `requeue`, `evidence` and `revision`;
// - `enqueue-ready.mjs`: the stacks that are ready to enqueue, and the drops it saw;
// - `backstop-enqueue.mjs`: the one enqueue path of the automation.
// Every script prints one JSON line on stdout. This module is the only place that reads those
// shapes: a stdout that is not that JSON, or an exit code the script does not document, is an
// error, and an error never counts as an enqueue.

export const WAIT_QUEUE = "tools/ci/wait-queue.mjs";
export const ENQUEUE_READY = "tools/ci/enqueue-ready.mjs";
export const BACKSTOP_ENQUEUE = "tools/ci/backstop-enqueue.mjs";
// A stack counts as ready once it has been for this long (the repo's `--ready-minutes`).
export const READY_MINUTES = 10;
// Refusals a person can repair without a new remote SHA are retried silently at most this often.
export const REPAIR_RETRY_MS = 60 * 60 * 1000;
// The scripts read GitHub and run `git`/`gt`; queue drafts take the longest (flake report).
const SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;

export type ScriptOutput = { code: number | null; stdout: string; stderr: string };
// Runs `node <script> …args` in `cwd`; never rejects for a non-zero exit (`code` null: killed).
export type ScriptRunner = (cwd: string, script: string, args: string[], env: Record<string, string>) => Promise<ScriptOutput>;
// Runs `git …args` (`-C` in the arguments); rejects when git fails.
export type GitRunner = (args: string[]) => Promise<string>;

export class BackstopScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackstopScriptError";
  }
}

// Tools such as node, gh and gt live in Homebrew, which a daemon's PATH often lacks.
const TOOL_PATH = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":");

function nodeBinary(): string {
  if (basename(process.execPath) === "node") return process.execPath;
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) if (existsSync(candidate)) return candidate;
  return "node";
}

// A failed run's exit code and output come with execFile's error.
function failedRun(error: unknown): ScriptOutput {
  const found = record(error) ?? {};
  return { code: typeof found.code === "number" ? found.code : null, stdout: text(found.stdout), stderr: text(found.stderr) || (error instanceof Error ? error.message : String(error)) };
}

export const runNodeScript: ScriptRunner = async (cwd, script, args, env) => {
  try {
    const { stdout, stderr } = await exec(nodeBinary(), [script, ...args], { cwd, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: TOOL_PATH, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return failedRun(error);
  }
};

export const runGit: GitRunner = async (args) => {
  try {
    return (await exec("git", args, { timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: TOOL_PATH } })).stdout.trim();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${failedRun(error).stderr.trim()}`);
  }
};

// Each enqueue owns its refs and Graphite metadata. Reuse the trusted checkout's objects, never
// its worker branches: local-only commits, dirty indexes and another clone's restack stay intact.
// The script still fetches and checks every expected GitHub head before it calls gt merge.
export async function inEnqueueClone(checkout: string, run: (clone: string) => Promise<ScriptOutput>): Promise<ScriptOutput> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-queue-enqueue-"));
  const clone = join(directory, "repo");
  try {
    const origin = await runGit(["-C", checkout, "remote", "get-url", "origin"]);
    const head = await runGit(["-C", checkout, "rev-parse", "HEAD"]);
    await runGit(["clone", "--quiet", "--shared", "--no-checkout", "--", checkout, clone]);
    await runGit(["-C", clone, "remote", "set-url", "origin", origin]);
    await runGit(["-C", clone, "update-ref", "refs/heads/main", head]);
    await runGit(["-C", clone, "symbolic-ref", "HEAD", "refs/heads/main"]);
    return await run(clone);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runIsolatedEnqueue(checkout: string, args: string[], env: Record<string, string>): Promise<ScriptOutput> {
  return inEnqueueClone(checkout, async (clone) => {
    await exec("gt", ["init", "--trunk", "main", "--no-interactive"], { cwd: clone, timeout: 60_000, env: { ...process.env, PATH: TOOL_PATH } });
    return runNodeScript(clone, resolve(checkout, BACKSTOP_ENQUEUE), args, env);
  });
}

// `<owner>/<repo>` (lower case) of a GitHub remote: `https://github.com/o/r(.git)`,
// `ssh://git@github.com/o/r(.git)` or `git@github.com:o/r(.git)`. The host must be exactly
// github.com and the path exactly two segments; anything else (a lookalike host, a path that
// only names github.com) is null.
export function originRepo(remote: string): string | null {
  const text = remote.trim();
  const scp = /^git@github\.com:([^/\s]+\/[^/\s]+)$/i.exec(text);
  let path: string;
  if (scp) path = scp[1];
  else {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (!["https:", "ssh:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com" || url.port !== "") return null;
    path = url.pathname.replace(/^\//, "");
  }
  const segments = path.replace(/\/$/, "").replace(/\.git$/i, "").split("/");
  return segments.length === 2 && segments.every((segment) => segment !== "") ? segments.join("/").toLowerCase() : null;
}

// One detached worktree per repo at `$PASEO_HOME/linear-tickets/queue-backstop/<owner>-<repo>`,
// created from the git common dir of a worktree of that repo and reset to `origin/main` (fetched
// first) before each run, so the scripts that run are always `main`'s. Null when no recorded folder
// is a clone of the repo (`origin` on GitHub's `<owner>/<repo>`) or `main` has no
// tools/ci/enqueue-ready.mjs: the backstop does not run there.
export class BackstopCheckout {
  constructor(private readonly git: GitRunner = runGit, private readonly root = join(paseoHome(), "linear-tickets", "queue-backstop")) {}

  path(repo: string): string {
    return join(this.root, repo.replace("/", "-"));
  }

  async prepare(repo: string, sources: string[]): Promise<string | null> {
    const path = this.path(repo);
    if (!existsSync(join(path, ".git"))) {
      const common = await this.commonDir(repo, sources);
      if (!common) return null;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      // A worktree whose folder was removed by hand is still registered; prune lets it be added again.
      await this.git(["--git-dir", common, "worktree", "prune"]);
      await this.git(["--git-dir", common, "fetch", "--quiet", "origin", "main"]);
      await this.git(["--git-dir", common, "worktree", "add", "--detach", path, "origin/main"]);
    }
    await this.git(["-C", path, "fetch", "--quiet", "origin", "main"]);
    await this.git(["-C", path, "reset", "--hard", "--quiet", "origin/main"]);
    return existsSync(join(path, ENQUEUE_READY)) ? path : null;
  }

  // The git common dir of the first recorded folder that is a clone of `repo`. A folder that is
  // gone, not a git repository (a ticket record can name `/tmp`) or another repository's clone
  // is skipped, so it never stops the backstop.
  private async commonDir(repo: string, sources: string[]): Promise<string | null> {
    for (const source of sources) {
      if (!existsSync(source)) continue;
      try {
        const common = await this.git(["-C", source, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
        const origin = await this.git(["--git-dir", common, "remote", "get-url", "origin"]);
        if (originRepo(origin) === repo.toLowerCase()) return common;
      } catch {
        // Not a git repository, or one without `origin`: try the next folder.
      }
    }
    return null;
  }

  // Comment files for `backstop-enqueue.mjs --comment-file`, outside the checkout it resets.
  async commentFile(action: string, body: string): Promise<string> {
    const directory = join(this.root, "comments");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${action.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}.md`);
    await writeFile(path, body, { mode: 0o600 });
    return path;
  }
}

// --- wait-queue.mjs -------------------------------------------------------------------------

export const DROP_CLASSES = ["conflictOnly", "mainBroken", "infra", "flaky", "genuine"] as const;
export type DropClass = (typeof DROP_CLASSES)[number];
// The code now against the code that dropped (see the repo's drop-class.mjs). `expect`: the
// range's current heads, lowest first (`<pr>@<sha>,…`), set for `same` and `changed`; `branch`: the
// head branch of its highest pull request.
export type Revision = { state: "same" | "changed" | "unknown"; draft: number | null; branch: string | null; expect: string | null; reason: string };
// A failed check on the queue's draft.
export type DropFailure = { check: string; conclusion: string; url: string };
export type DropJudgment = {
  result: "dropped";
  reason: string;
  class: DropClass;
  requeue: boolean;
  evidence: string[];
  revision: Revision;
  queueDraft: number | null;
  failures: DropFailure[];
};
// `pending`: the round is still running, or no round exists yet; `merged`: it landed.
export type RoundJudgment = DropJudgment | { result: "merged" | "pending" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

// The single JSON line a script printed (its last non-empty stdout line).
function answer(script: string, output: ScriptOutput): Record<string, unknown> {
  const line = output.stdout.split("\n").map((item) => item.trim()).filter(Boolean).at(-1) ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  const found = record(parsed);
  if (!found) throw new BackstopScriptError(`${script} printed no JSON answer (exit ${output.code}): ${(output.stderr.trim().split("\n").at(-1) ?? "").slice(0, 300)}`);
  return found;
}

export function parseRevision(value: unknown): Revision | null {
  const found = record(value);
  if (!found || !["same", "changed", "unknown"].includes(text(found.state))) return null;
  return {
    state: text(found.state) as Revision["state"],
    draft: count(found.draft),
    branch: text(found.branch) || null,
    expect: parseExpect(text(found.expect)) ? text(found.expect) : null,
    reason: text(found.reason),
  };
}

// `wait-queue.mjs` exits 0 merged, 2 dropped, 3 still running (or no round yet); 64 usage.
export function parseJudgment(output: ScriptOutput): RoundJudgment {
  const found = answer(WAIT_QUEUE, output);
  const result = text(found.result);
  if (output.code === 0 && result === "merged") return { result: "merged" };
  if (output.code === 3) return { result: "pending" };
  if (output.code !== 2 || result !== "dropped") throw new BackstopScriptError(`${WAIT_QUEUE} answered ${result || "nothing"} with exit ${output.code}`);
  const kind = text(found.class);
  const revision = parseRevision(found.revision);
  if (!DROP_CLASSES.includes(kind as DropClass) || typeof found.requeue !== "boolean" || !revision) throw new BackstopScriptError(`${WAIT_QUEUE} answered a drop without a class, requeue or revision`);
  const failures = (Array.isArray(found.failures) ? found.failures : []).map(record).filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({ check: text(item.check) || "check", conclusion: text(item.conclusion) || "failure", url: text(item.url) }));
  return {
    result: "dropped",
    reason: text(found.reason),
    class: kind as DropClass,
    // A genuine drop is never requeued, whatever the flag says.
    requeue: found.requeue && kind !== "genuine",
    evidence: texts(found.evidence),
    revision,
    queueDraft: count(found.queueDraft),
    failures,
  };
}

export function waitQueueArgs(pr: number, draft: number | null): string[] {
  return draft === null ? [String(pr), "--last"] : [String(pr), "--draft", String(draft)];
}

// `<pr>@<sha>,…` → its members, or null when it is not that shape.
export function parseExpect(expect: string): { pr: number; sha: string }[] | null {
  const members = expect.split(",").map((item) => /^(\d+)@([0-9a-f]{7,40})$/.exec(item.trim()));
  if (!expect || members.some((item) => !item)) return null;
  return members.map((item) => ({ pr: Number(item?.[1]), sha: item?.[2] ?? "" }));
}

// --- backstop-enqueue.mjs -------------------------------------------------------------------

export type Problem = { kind: string; text: string; draft: number | null };
export type EnqueueOutcome = { result: "enqueued" | "held" | "refused" | "error"; problems: Problem[]; comment: "posted" | "present" | "none"; error: string | null };
const ENQUEUE_EXITS: Record<number, EnqueueOutcome["result"]> = { 0: "enqueued", 1: "error", 2: "refused", 3: "held" };

function problems(value: unknown): Problem[] {
  return (Array.isArray(value) ? value : []).map(record).filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({ kind: text(item.kind) || "unknown", text: text(item.text) || text(item.reason), draft: count(item.draft) }));
}

// Exit 0 enqueued, 1 error, 2 refused, 3 held; the JSON's `result` has to say the same. An error
// whose `enqueue.mjs` answered `not-enqueued` (exit 1: `gt merge` ran and enqueued nothing) is
// final: a refusal of kind `not-enqueued`, so the Merge activity never decides it, and an enqueue
// someone else made meanwhile is never taken for the backstop's. Anything else is an error (the
// caller then reconciles from the Merge activity instead of assuming).
export function parseEnqueue(output: ScriptOutput): EnqueueOutcome {
  let found: Record<string, unknown>;
  try { found = answer(BACKSTOP_ENQUEUE, output); } catch (error) {
    return { result: "error", problems: [], comment: "none", error: error instanceof Error ? error.message : String(error) };
  }
  const expected = output.code === null ? undefined : ENQUEUE_EXITS[output.code];
  const result = text(found.result);
  if (!expected || expected !== result) return { result: "error", problems: problems(found.problems), comment: "none", error: `${BACKSTOP_ENQUEUE} answered ${result || "nothing"} with exit ${output.code}${text(found.error) ? `: ${text(found.error)}` : ""}` };
  const enqueue = record(found.enqueue);
  if (expected === "error" && enqueue && text(enqueue.result) === "not-enqueued") {
    const outcome = text(enqueue.outcome);
    const gtOutput = text(enqueue.gtOutput);
    const why = `\`gt merge\` enqueued nothing${outcome ? ` (${outcome})` : ""}${gtOutput ? `; its output is in \`${gtOutput}\`` : ""}`;
    return { result: "refused", problems: [{ kind: "not-enqueued", text: why, draft: null }], comment: "none", error: null };
  }
  const comment = text(found.comment);
  return { result: expected, problems: problems(found.problems), comment: comment === "posted" || comment === "present" ? comment : "none", error: text(found.error) || null };
}

export function enqueueArgs(branch: string, expect: string, action: string, commentFile: string | null): string[] {
  return [branch, "--expect", expect, "--action", action, ...(commentFile ? ["--comment-file", commentFile] : [])];
}

// --- enqueue-ready.mjs ----------------------------------------------------------------------

// A ready stack: `action` is `ready:<top>@<sha>,…`, `expect` its members' heads, lowest first.
export type ReadyStack = { action: string; top: number; branch: string; prs: number[]; expect: string; tickets: string[]; result: string };
// A pull request whose newest queue round ended in a drop; `key` is the drop's claim key.
export type ReadyDrop = { pr: number; draft: number | null; key: string; revision: Revision | null };
export type ReadyRun = { stacks: ReadyStack[]; drops: ReadyDrop[] };

// Exit 0 with `stacks` and `drops`; anything else is an error. A stack without its action, branch
// or heads is left out.
export function parseReady(output: ScriptOutput): ReadyRun {
  const found = answer(ENQUEUE_READY, output);
  if (output.code !== 0 || !Array.isArray(found.stacks)) throw new BackstopScriptError(`${ENQUEUE_READY} exited ${output.code} without its stacks`);
  const stacks = found.stacks.map(record).filter((item): item is Record<string, unknown> => item !== null).flatMap((item) => {
    const action = text(item.action);
    const top = count(item.top);
    const expect = text(item.expect);
    const prs = Array.isArray(item.prs) ? item.prs.map(count).filter((pr): pr is number => pr !== null) : [];
    if (!action.startsWith("ready:") || top === null || !text(item.branch) || !parseExpect(expect) || !prs.length) return [];
    return [{ action, top, branch: text(item.branch), prs, expect, tickets: texts(item.tickets), result: text(item.result) }];
  });
  const drops = (Array.isArray(found.drops) ? found.drops : []).map(record).filter((item): item is Record<string, unknown> => item !== null).flatMap((item) => {
    const pr = count(item.pr);
    const key = text(item.key);
    return pr === null || !key ? [] : [{ pr, draft: count(item.draft), key, revision: parseRevision(item.revision) }];
  });
  return { stacks, drops };
}

export function readyArgs(excludes: number[], skips: string[]): string[] {
  return ["--ready-minutes", String(READY_MINUTES), ...excludes.flatMap((pr) => ["--exclude", String(pr)]), ...skips.flatMap((key) => ["--skip", key])];
}

// --- Actions, refusals and restart reconciliation --------------------------------------------

// `due`: to run (also again after `held`); `started`: saved right before the enqueue ran, its
// outcome not recorded yet (reconciled from the Merge activity); `unclear`: the activity no longer
// shows whether it went through, so it went to the agent instead.
export type EnqueueStep = "due" | "started" | "held" | "enqueued" | "refused" | "closed" | "unclear";
// `started`: saved right before the comment or message went out; it is never sent twice.
export type MessageStep = "none" | "due" | "started" | "done";
// The number of Graphite's Merge activity bullets on the top pull request and the last one's text,
// read right before the enqueue: bullets appended after it belong to this enqueue.
export type ActivityBoundary = { count: number; last: string | null };
// One automatic enqueue of a range, saved before each step. `id` is round- and range-specific:
// `drop:<drop key>:<top>` (a queue draft can test several stacks, each its own range) or
// `ready:<top>@<shas>`; it names the action in its refusals and comment markers. `why` opens its
// comments. `linearDone`: the tickets whose comment is confirmed. `followedBy`: the drop key of
// the queue round that followed it once it was enqueued. `supersededBy`: the drop key of a newer
// round claimed on its range before its own enqueue was confirmed; it is never enqueued after it.
export type ActionRecord = {
  id: string;
  repo: string;
  branch: string;
  expect: string;
  prs: number[];
  top: number;
  tickets: string[];
  why: string;
  at: string;
  activityBoundary: ActivityBoundary | null;
  steps: { enqueue: EnqueueStep; prComment: MessageStep; linearComment: MessageStep; note: MessageStep };
  linearDone?: string[];
  followedBy?: string;
  supersededBy?: string;
};
// A refused enqueue, routed once per key (action + problem kind, + draft for a queue-tip
// conflict) and released by the change that can fix it (see released). `text`: the script's words.
export type Refusal = { key: string; action: string; kind: string; draft: number | null; at: string; routedAt: string | null; retryAfter: string | null; text?: string };

// Problems that only hold an enqueue: `main` is red or unknown, or someone else queued the range.
export const HELD_KINDS = ["main-red", "main-unknown", "queued"];
// Local conditions a person can repair at the same remote SHA.
export const REPAIRABLE_KINDS = ["remote-differs", "local-differs", "stack-differs", "unsubmitted", "unread"];

export function refusalKey(action: string, problem: Problem): string {
  return `${action} ${problem.kind}${problem.kind === "conflict-tip" && problem.draft !== null ? ` #${problem.draft}` : ""}`;
}

// Whether a refusal no longer holds its action back: a queue-tip conflict once its draft is no
// longer open, a repairable one an hour after it was last refused, a veto once the label is gone.
// Every other kind (`conflict-main`, `range-changed`, …) is released only by a new head, which is a
// new action.
export function released(refusal: Refusal, now: number, openDrafts: Set<number>, vetoed: boolean): boolean {
  if (refusal.kind === "conflict-tip") return refusal.draft !== null && !openDrafts.has(refusal.draft);
  // Old shared-ref refusals can be retried immediately: the next enqueue has private refs.
  if (refusal.kind === "local-differs" || refusal.kind === "stack-differs") return true;
  if (REPAIRABLE_KINDS.includes(refusal.kind)) return refusal.retryAfter !== null && now >= Date.parse(refusal.retryAfter);
  if (refusal.kind === "veto") return !vetoed;
  return false;
}

export function activityBoundary(bullets: { text: string }[]): ActivityBoundary {
  return { count: bullets.length, last: bullets.at(-1)?.text ?? null };
}

// After a restart with the enqueue `started`: `enqueued` when an enqueue bullet was appended after
// the boundary; `absent` when none was; `mismatch` when the bullets up to the boundary are no
// longer the ones read (the comment was rewritten or shortened), so nothing can be told.
export function reconcile(boundary: ActivityBoundary | null, bullets: { text: string; kind: string }[]): "enqueued" | "absent" | "mismatch" {
  if (!boundary || bullets.length < boundary.count) return "mismatch";
  if (boundary.count > 0 && bullets[boundary.count - 1]?.text !== boundary.last) return "mismatch";
  return bullets.slice(boundary.count).some((bullet) => bullet.kind === "queued") ? "enqueued" : "absent";
}

// --- Comments -------------------------------------------------------------------------------

export function marker(id: string): string {
  return `<!-- queue-backstop:${id} -->`;
}

// The ticket comment's mark: Linear does not keep HTML comments, so it is a visible code span. The
// backticks belong to the mark: a retry finds it by this whole text (see LinearService.hasComment),
// and the closing one keeps `drop:#5000:419` from matching `drop:#5000:4190`.
export function ticketMarker(id: string): string {
  return `\`queue-backstop:${id}\``;
}

// Posts a pull request comment with the marker once: nothing when a comment carries it already.
export async function commentOnce(github: { pullComments(repo: string, number: number): Promise<string[]>; commentOnPull(repo: string, number: number, body: string): Promise<void> }, repo: string, number: number, id: string, body: string): Promise<"posted" | "present"> {
  const tag = marker(id);
  if ((await github.pullComments(repo, number)).some((comment) => comment.includes(tag))) return "present";
  await github.commentOnPull(repo, number, `${body}\n\n${tag}`);
  return "posted";
}

export const CLASS_TEXT: Record<DropClass, string> = {
  conflictOnly: "conflict-only: Graphite named a merge conflict and nothing failed on the queue's draft",
  mainBroken: "main-broken: every job that failed on the queue's draft was red on `main` at that time",
  infra: "infra: a runner problem, not the change",
  flaky: "flaky: every failing test is outside the change and a known flaky test",
  genuine: "genuine failure",
};

const pullList = (repo: string, prs: number[]) => prs.map((pr) => `[#${pr}](https://github.com/${repo}/pull/${pr})`).join(", ");

// The opening line of a drop re-enqueue's comments: the kind, the evidence, the queue run, why the
// code is the code that dropped (`unchanged`) and how the drop counts (`count`).
export function dropWhy(repo: string, judgment: DropJudgment, unchanged: string, count: string): string {
  const run = judgment.queueDraft === null ? "" : ` ([queue run #${judgment.queueDraft}](https://github.com/${repo}/pull/${judgment.queueDraft}))`;
  return [
    `The merge queue dropped this range${run}, and it was not the stack's fault: ${CLASS_TEXT[judgment.class]}.`,
    ...judgment.evidence.map((line) => `- ${line}`),
    `The code is unchanged since the drop (${unchanged}). ${count}`,
  ].join("\n");
}

export const READY_WHY = `Every pull request of this range has been green, reviewed and without open threads for ${READY_MINUTES} minutes, and nobody had enqueued it.`;

// The comment on the pull request and the ticket after an automatic enqueue.
export function enqueuedComment(action: Pick<ActionRecord, "repo" | "prs" | "top" | "why">): string {
  return [
    `Paseo's queue backstop enqueued ${pullList(action.repo, action.prs)} through \`tools/ci/enqueue.mjs\`.`,
    "",
    action.why,
    "",
    `Nothing is needed from the agent; \`node tools/ci/wait-queue.mjs ${action.top}\` follows the round.`,
  ].join("\n");
}

// The message to the agent (or the ticket, or the pull request) when an automatic enqueue was refused.
export function refusalText(action: Pick<ActionRecord, "repo" | "prs" | "branch" | "top">, refused: Problem[], extra: string | null): string {
  return [
    `Paseo's queue backstop tried to enqueue ${pullList(action.repo, action.prs)} from \`${action.branch}\`, and \`tools/ci/enqueue.mjs\` refused:`,
    ...refused.map((problem) => `- \`${problem.kind}\`${problem.draft !== null ? ` (queue draft #${problem.draft})` : ""}${problem.text ? `: ${problem.text}` : ""}`),
    "",
    ...(extra ? [extra, ""] : []),
    `This is a repair request for the ticket's agent, not a command for the owner to run. Resolve the refusal without discarding local work, then \`git switch ${action.branch} && node tools/ci/enqueue.mjs\` and \`node tools/ci/wait-queue.mjs ${action.top}\`. The backstop uses private Git refs, so it never overwrites a worker's local branches. It retries after a new head for a conflict with \`main\`, the queue draft's end for a conflict with the queue tip, and at most hourly for other repairable conditions.`,
  ].join("\n");
}
