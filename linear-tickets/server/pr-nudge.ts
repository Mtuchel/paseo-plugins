import type { PullRequestView } from "./pr-watch";

// The next lifecycle step a stalled pull request is waiting on its agent for. The watch sends it
// to an idle agent (see PullRequestWatch.nudge); this module only decides the step and its text.
export type Stage = "draft" | "red" | "changes" | "findings";
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
const DECISIVE = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

// The step, for a panel line and the owner's escalation: "… the agent to <step>".
export const STAGE_STEP: Record<Stage, string> = {
  draft: "publish the draft",
  red: "fix the failing checks",
  changes: "address the requested changes",
  findings: "resolve the review findings",
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
// can still be sent. A ready pull request gets no nudge: the queue backstop enqueues it (TUC-615).
export async function stalledStage(view: PullRequestView, url: string, now: number, claimed: (stage: Stage, key: string) => boolean, readThreads: () => Promise<ReviewThread[]>): Promise<{ stage: Stage; key: string; text: string } | null> {
  const head = view.headSha.slice(0, 7);
  const key = view.headSha;
  if (view.isDraft) {
    const quiet = [view.updatedAt, view.lastCommitAt].every((at) => !at || now - Date.parse(at) >= DRAFT_IDLE_MS);
    if (!quiet) return null;
    return { stage: "draft", key, text: [
      `[The pull request](${url}) is still a draft, with no new commit or pull request activity for ${DRAFT_IDLE_MS / 60_000} minutes.`,
      `Next step: run the background Sol review if you have not yet. Publish only the reviewed part of your stack, bottom first: \`git switch ${view.headBranch} && node tools/ci/publish.mjs\` once this branch and every branch below it are reviewed and each passed \`mise exec -- pnpm verify:pre-pr --body-file <body>\` (never a bare \`gt submit --publish\` or \`gh pr ready\` except under the exception below: \`publish.mjs\` refuses until PR metadata is green and prints any owner question); the branches above stay drafts until they are.`,
      "",
      "Exception (owner, Q-29, 2026-10-05): a branch whose local `verify:pre-pr` was killed from outside, timed out, or failed twice only on tests unrelated to its change may be published without a passing receipt. Everything else still holds: only the reviewed part of the stack, bottom first; the branches above stay drafts. In order:",
      "1. Write the evidence into the PR's Verification section: the killed or timed-out run, or both failing runs and why those tests are unrelated.",
      "2. Run `node tools/ci/publish.mjs` and continue only when its only problems are `no verify:pre-pr receipt for its tree` or `verify:pre-pr failed on this tree`, each for a branch with such evidence, and every draft branch it lists is `green`. Run it again while one is `pending`; any later change to a branch or its PR means running it again.",
      "3. Make sure none of the ticket's questions to the owner is still unanswered.",
      `4. Publish each such branch bottom first: those below this one first, each the same way with its own name, then this one with \`gt submit --publish --no-stack --update-only --no-edit --no-interactive --branch ${view.headBranch}\`.`,
      "CI is the proof; continue to the merge.",
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
  if (claimed("findings", key)) return null;
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
  return null;
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
