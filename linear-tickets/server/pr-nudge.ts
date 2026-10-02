import type { PullRequestView } from "./pr-watch";

// The next lifecycle step a stalled pull request is waiting on its agent for. The watch sends it
// to an idle agent (see PullRequestWatch.nudge); this module only decides the step and its text.
export type Stage = "draft" | "red" | "changes" | "findings" | "merge";
export type ReviewThread = {
  resolved: boolean;
  path: string | null;
  line: number | null;
  comments: { author: string; bot: boolean; body: string; createdAt: string; url: string }[];
};

// A draft counts as stalled after this long without a new commit or any pull request activity.
export const DRAFT_IDLE_MS = 30 * 60 * 1000;
// Graphite's own check: it stays in progress until the pull request is queued, and the queue
// reports on it; the agent cannot fix it by pushing.
const QUEUE_CHECK = "Graphite / mergeability_check";
// Pull requests with this label need Greptile's review of the current head before they merge.
const GREPTILE_LABEL = "complex-review";
const GREPTILE = /^greptile-apps(\[bot\])?$/;
// The repo's required checks: a merge nudge needs each on the head (the optional one only when it
// ran), finished as a success or skipped. Other checks only have to be green when they are there.
const REQUIRED_CHECKS = ["PR code", "PR metadata"];
const REQUIRED_WHEN_PRESENT = ["Label queued PRs for Linear"];
const DECISIVE = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

// The step, for a panel line and the owner's escalation: "… the agent to <step>".
export const STAGE_STEP: Record<Stage, string> = {
  draft: "publish the draft",
  red: "fix the failing checks",
  changes: "address the requested changes",
  findings: "resolve the review findings",
  merge: "merge it through the merge queue",
};

// Review comments quoted in a prompt: Greptile's badges become their alt text, other markup goes.
function excerpt(body: string, limit: number): string {
  const text = body.replace(/<img[^>]*\balt="([^"]*)"[^>]*>/g, "$1").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

function threadLines(threads: ReviewThread[]): string[] {
  return threads.map((thread) => {
    const [first] = thread.comments;
    const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "thread";
    const replies = thread.comments.length - 1;
    return `- [${where}](${first.url}) @${first.author}: ${excerpt(first.body, 300)}${replies ? ` (${replies} ${replies === 1 ? "reply" : "replies"})` : ""}`;
  });
}

// The first stage that matches, in lifecycle order, with the prompt for it and the key it is
// claimed under; null when the pull request waits on nobody but its agent's reviewers, or on
// nothing. Stages are keyed by head, so a new head can be nudged again; requested changes are
// keyed by the reviews themselves (`<reviewer>@<submitted at>`, or `review-decision` when only
// GitHub's decision says so), so pushing does not repeat a request that was already sent.
// `claimed(stage, key)`: already sent; review threads are only read when a stage that needs them
// can still be sent.
export async function stalledStage(view: PullRequestView, url: string, now: number, claimed: (stage: Stage, key: string) => boolean, readThreads: () => Promise<ReviewThread[]>): Promise<{ stage: Stage; key: string; text: string } | null> {
  const head = view.headSha.slice(0, 7);
  const key = view.headSha;
  if (view.isDraft) {
    const quiet = [view.updatedAt, view.lastCommitAt].every((at) => !at || now - Date.parse(at) >= DRAFT_IDLE_MS);
    if (!quiet) return null;
    return { stage: "draft", key, text: [
      `[The pull request](${url}) is still a draft, with no new commit or pull request activity for ${DRAFT_IDLE_MS / 60_000} minutes.`,
      `Next step: run the background Sol review if you have not yet. Publish only the reviewed part of your stack, bottom first: \`gt submit --publish --no-stack --branch ${view.headBranch}\` once this branch and every branch below it are reviewed; the branches above stay drafts until they are.`,
    ].join("\n") };
  }
  const failed = failedChecks(view);
  if (failed.length) {
    return { stage: "red", key, text: [
      `Checks failed on the head of [the pull request](${url}) (\`${head}\`):`,
      ...failed.map((check) => `- [${check.name}](${check.url}) — ${check.conclusion}`),
      "Next step: fix them, then `gt submit --stack`.",
    ].join("\n") };
  }
  const requested = changeRequests(view);
  if (requested.length || view.reviewDecision === "CHANGES_REQUESTED") {
    // A request already sent keeps holding the merge, but is not sent again for a new head.
    const unsent = (requested.length ? requested.map((review) => `${review.author}@${review.submittedAt}`) : ["review-decision"]).filter((id) => !claimed("changes", id));
    if (!unsent.length) return null;
    const open = (await readThreads()).filter((thread) => !thread.resolved && thread.comments.length);
    const summaries = requested.flatMap((review) => [
      `@${review.author} requested changes on [the pull request](${url})${review.commit && review.commit !== view.headSha ? ` at \`${review.commit.slice(0, 7)}\`, before the latest commits` : ""}:`,
      ...(review.body.trim() ? [`> ${excerpt(review.body, 1500)}`] : []),
    ]);
    const earlier = requested.filter((review) => review.commit && review.commit !== view.headSha).map((review) => `@${review.author}`);
    return { stage: "changes", key: unsent.join(" "), text: [
      ...(summaries.length ? summaries : [`GitHub reports changes requested on [the pull request](${url}).`]),
      ...(open.length ? ["", "Unresolved review threads:", ...threadLines(open)] : []),
      "",
      "Next step: address them, then `gt submit --stack`.",
      ...(earlier.length ? [`Where the new commits already address a review, reply on its threads and re-request a review from ${earlier.join(", ")}.`] : []),
    ].join("\n") };
  }
  const ready = mergeable(view);
  if (claimed("findings", key) && (claimed("merge", key) || !ready)) return null;
  const open = (await readThreads()).filter((thread) => !thread.resolved && thread.comments.length);
  const findings = open.filter((thread) => thread.comments[0].bot);
  if (findings.length) {
    return { stage: "findings", key, text: [
      `Reviewers left unresolved findings on [the pull request](${url}):`,
      ...threadLines(findings),
      "",
      "Next step: run the AGENTS.md review loop on them.",
    ].join("\n") };
  }
  if (!ready || open.length) return null;
  return { stage: "merge", key, text: mergeText(url, view, []) };
}

function failedChecks(view: PullRequestView): PullRequestView["checks"] {
  return view.checks.filter((check) => check.state === "failed" && check.name !== QUEUE_CHECK);
}

// Each reviewer's latest decisive review counts (a dismissed one reads DISMISSED), on any commit:
// new commits do not settle a change request, the reviewer does.
function changeRequests(view: PullRequestView): PullRequestView["reviews"] {
  const latestByAuthor = new Map<string, PullRequestView["reviews"][number]>();
  for (const review of [...view.reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (DECISIVE.includes(review.state)) latestByAuthor.set(review.author, review);
  }
  return [...latestByAuthor.values()].filter((review) => review.state === "CHANGES_REQUESTED");
}

// Ready to merge as far as the pull request itself shows; its review threads must be resolved
// too. Not a draft, no failed check and no change request; green: the required checks ran on the
// head and passed, and every other check but the queue's own finished and passed (an empty or
// incomplete rollup is not green); and with `complex-review`, Greptile reviewed the head.
export function mergeable(view: PullRequestView): boolean {
  if (view.isDraft || failedChecks(view).length || changeRequests(view).length || view.reviewDecision === "CHANGES_REQUESTED") return false;
  const named = (name: string) => view.checks.filter((check) => check.name === name);
  const green = view.checks.every((check) => check.state === "passed" || check.name === QUEUE_CHECK)
    && REQUIRED_CHECKS.every((name) => named(name).length > 0)
    && [...REQUIRED_CHECKS, ...REQUIRED_WHEN_PRESENT].every((name) => named(name).every((check) => check.conclusion === "success" || check.conclusion === "skipped"));
  return green && (!view.labels.includes(GREPTILE_LABEL) || view.reviews.some((review) => GREPTILE.test(review.author) && review.commit === view.headSha));
}

// The merge step for the highest ready pull request of a stack; `below`: the ready ones under it,
// bottom first, which `gt merge` enqueues with it.
export function mergeText(url: string, view: PullRequestView, below: { number: number; url: string }[]): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1] ?? "";
  return [
    `[The pull request](${url}) is ready: its checks are green, no review thread is open, the reviewers are done, and it is not in the merge queue.`,
    ...(below.length ? [`So are the pull requests below it: ${below.map((pull) => `[#${pull.number}](${pull.url})`).join(", ")}.`] : []),
    `Next step: \`gt checkout ${view.headBranch} && gt merge\`${below.length ? " (it enqueues the pull requests below it too)" : ""}, then \`node tools/ci/wait-queue.mjs ${number}\`. The rest of the stack follows once it is reviewed.`,
  ].join("\n");
}
