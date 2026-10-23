// The candidate list (README, "Related work"): one markdown snapshot of a team's work that every
// planner of the team reads from its context file instead of searching Linear on its own. Built when
// a planner starts, at most once per team every CANDIDATE_TTL_MS, at background priority.

import { planFootprint } from "../shared/plan-footprint";
import { reachBody } from "../shared/plan-sections";
import type { PullRequestFiles } from "./label-sync";
import type { CandidateIssue, DoneIssue, LinearService, Pages } from "./linear";
import { PLANNING_STATE, planStage } from "./plan-policy";

export const CANDIDATE_TTL_MS = 2 * 60 * 1000;
const DONE_DAYS = 60;
const EXCERPT_CHARS = 240;
const DAY_MS = 24 * 60 * 60 * 1000;
// GitHub reads a build waits for (about half a second each, one at a time): the planner's launch
// waits for the build. The label sync fills the same cache with up to 150 reads per cycle.
export const CANDIDATE_PULL_REQUEST_READS = 20;

// Which of two sources counts when they disagree; the list, the planner's note and later the
// implementer's note state it.
export const PRECEDENCE_RULE = "When sources disagree: the code as merged is the current baseline. A plan written before a later merged change that contradicts it is re-planned, not implemented against it. A later approved plan that deliberately replaces existing behaviour stays valid: it is the newer decision. Open pull requests are proposed work, to be checked as conflicts, not authority. Ticket descriptions count least. When unsure whether a merged change still holds (it may have been reverted), read the file on `origin/main`.";

type Deps = {
  linear: Pick<LinearService, "teamCandidates" | "doneSince" | "documentContents">;
  pullRequests: Pick<PullRequestFiles, "refresh" | "filesOf" | "stateOf">;
  now?: () => number;
};

type ApprovedPlan = { issue: CandidateIssue; approvedAt: string; label: string; content: string };

export class RelatedWork {
  // `until`: when the finished build expires; Infinity while it runs (single flight).
  private readonly builds = new Map<string, { list: Promise<string>; until: number }>();
  // Plan document contents by id, valid while the document's `updatedAt` is unchanged. Kept for the
  // host's lifetime: one entry per plan document of an open ticket it listed (a few hundred).
  private readonly contents = new Map<string, { updatedAt: string; content: string }>();
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  // The team's candidate list. Rejects when the team's open tickets cannot be read; a failed build
  // is not kept, so the next planner's start tries again.
  candidates(teamId: string): Promise<string> {
    const cached = this.builds.get(teamId);
    if (cached && cached.until > this.now()) return cached.list;
    const entry = { list: this.build(teamId), until: Infinity };
    this.builds.set(teamId, entry);
    entry.list.then(
      () => { entry.until = this.now() + CANDIDATE_TTL_MS; },
      () => { if (this.builds.get(teamId) === entry) this.builds.delete(teamId); },
    );
    return entry.list;
  }

  private async build(teamId: string): Promise<string> {
    const open = await this.deps.linear.teamCandidates(teamId);
    const since = new Date(this.now() - DONE_DAYS * DAY_MS).toISOString();
    const [done, plans] = await Promise.all([
      this.deps.linear.doneSince(teamId, since).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))),
      this.approvedPlans(open.items),
      // A failed refresh leaves the pull requests it did not read listed as not read yet.
      this.deps.pullRequests.refresh(open.items.flatMap((issue) => issue.pullRequests), CANDIDATE_PULL_REQUEST_READS).catch(() => undefined),
    ]);
    const team = open.items[0]?.identifier.replace(/-\d+$/, "") ?? "";
    return [
      `This list covers the team's own tickets${team ? ` (${team})` : ""}; search Linear for other teams' tickets. Each section says whether it is complete; look up by hand what an incomplete one names.`,
      PRECEDENCE_RULE,
      openSection(open),
      plansSection(plans),
      planningSection(open.items),
      this.pullRequestSection(open.items),
      doneSection(done, since),
    ].join("\n\n") + "\n";
  }

  // The Approved `Plan: <identifier>` documents of these tickets, newest approval first; `unread`:
  // the documents whose content could not be read.
  private async approvedPlans(issues: CandidateIssue[]): Promise<{ plans: ApprovedPlan[]; unread: string[] }> {
    const documents = issues.flatMap((issue) => issue.planDocuments.filter((document) => document.title === `Plan: ${issue.identifier}`).map((document) => ({ issue, document })));
    const stale = documents.filter(({ document }) => this.contents.get(document.id)?.updatedAt !== document.updatedAt).map(({ document }) => document.id);
    const read = stale.length ? await this.deps.linear.documentContents(stale).catch(() => null) : new Map<string, { content: string; updatedAt: string }>();
    const plans: ApprovedPlan[] = [];
    const unread: string[] = [];
    for (const { issue, document } of documents) {
      const known = this.contents.get(document.id);
      const fresh = read?.get(document.id);
      const entry = known?.updatedAt === document.updatedAt ? known : fresh ? { updatedAt: fresh.updatedAt || document.updatedAt, content: fresh.content } : null;
      if (!entry) { unread.push(document.title); continue; }
      this.contents.set(document.id, entry);
      const text = entry.content.trimStart();
      if (!text.startsWith("> **Approved**")) continue;
      // `on 2026-10-15 19:33 UTC` (or a date alone on older plans); the document's own time without one.
      const header = /^> \*\*Approved\*\*[^\n]* on (\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) UTC)?/.exec(text);
      const approvedAt = header ? `${header[1]}T${header[2] ?? "00:00"}Z` : document.updatedAt;
      plans.push({ issue, approvedAt, label: header ? `${header[1]}${header[2] ? ` ${header[2]} UTC` : ""}` : `${document.updatedAt} (document saved)`, content: entry.content });
    }
    plans.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
    return { plans, unread };
  }

  private pullRequestSection(issues: CandidateIssue[]): string {
    const open: string[] = [];
    const merged: { at: string; line: string }[] = [];
    const unread: string[] = [];
    for (const issue of issues) for (const url of issue.pullRequests) {
      const state = this.deps.pullRequests.stateOf(url);
      const files = this.deps.pullRequests.filesOf(url) ?? [];
      const listed = files.length ? files.map((file) => `\`${file}\``).join(", ") : "no files";
      if (!state) unread.push(`- ${issue.identifier} ${url} — not read yet: \`gh pr view ${url} --json files\``);
      else if (state.state === "OPEN") open.push(`- ${issue.identifier} (${issue.status}) ${url}: ${listed}`);
      else if (state.state === "MERGED") merged.push({ at: state.mergedAt ?? "", line: `- ${issue.identifier} (${issue.status}) ${url}, merged ${state.mergedAt ?? "(time unknown)"}: ${listed}` });
      // CLOSED and MISSING: proposed work nobody pursues any more.
    }
    merged.sort((a, b) => b.at.localeCompare(a.at));
    return [
      "## Pull request files of open tickets",
      unread.length ? `Incomplete: ${unread.length} pull request${unread.length === 1 ? " is" : "s are"} not read yet (listed below with the command that reads them).` : "Complete.",
      "Pull requests closed without merging are left out.",
      `### Open (${open.length})`,
      ...open,
      `### Merged, newest merge first (${merged.length})`,
      ...merged.map((entry) => entry.line),
      ...(unread.length ? [`### Not read yet (${unread.length})`, ...unread] : []),
    ].join("\n");
  }
}

function completeness(complete: boolean, what: string): string {
  return complete ? "Complete." : `Incomplete: ${what}`;
}

function openSection(open: Pages<CandidateIssue>): string {
  return [
    `## Open tickets (${open.items.length})`,
    completeness(open.complete, "Linear had more open tickets than the plugin reads; search Linear for the rest."),
    ...open.items.map((issue) => {
      const excerpt = issue.description.replace(/\s+/g, " ").trim();
      return `- ${issue.identifier} — ${issue.title} — ${issue.status}${issue.labels.length ? ` — labels: ${issue.labels.join(", ")}` : ""}${excerpt ? ` — ${excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt}` : ""}`;
    }),
  ].join("\n");
}

function plansSection({ plans, unread }: { plans: ApprovedPlan[]; unread: string[] }): string {
  return [
    `## Approved plans of open tickets, newest approval first (${plans.length})`,
    completeness(!unread.length, `these plan documents could not be read; read them in Linear: ${unread.join(", ")}.`),
    ...plans.map((plan) => {
      const reach = reachBody(plan.content);
      const files = planFootprint(plan.content).files;
      return [
        `### ${plan.issue.identifier} — ${plan.issue.title} (${plan.issue.status}), approved ${plan.label}`,
        `Related-work list: ${/^#{1,6}\s+Related work\b/im.test(plan.content) ? "yes" : "no"}.`,
        `Files: ${files.length ? files.map((file) => `\`${file}\``).join(", ") : "none named"}.`,
        reach ? `Reach:\n\n${reach}` : "Reach: the plan has no `## Reach` section.",
      ].join("\n");
    }),
  ].join("\n\n");
}

function planningSection(issues: CandidateIssue[]): string {
  const planning = issues.filter((issue) => planStage(issue.status, issue.statusType) === PLANNING_STATE);
  return [`## Tickets in ${PLANNING_STATE} (${planning.length})`, "Complete.", ...planning.map((issue) => `- ${issue.identifier} — ${issue.title}`)].join("\n");
}

function doneSection(done: Pages<DoneIssue> | Error, since: string): string {
  const heading = `## Done in the last ${DONE_DAYS} days`;
  if (done instanceof Error) return [heading, `Incomplete: could not be read (${done.message}); search Linear for the team's tickets completed since ${since.slice(0, 10)}.`].join("\n");
  return [
    `${heading} (${done.items.length})`,
    completeness(done.complete, `Linear had more done tickets than the plugin reads; search Linear for those completed since ${since.slice(0, 10)}.`),
    ...done.items.map((issue) => `- ${issue.identifier} — ${issue.title} (done ${issue.completedAt.slice(0, 10)})`),
  ].join("\n");
}
