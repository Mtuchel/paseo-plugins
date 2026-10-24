// The candidate list (README, "Related work"): one markdown snapshot of a team's work that every
// planner of the team reads from its context file instead of searching Linear on its own. Built when
// a planner starts, at most once per team every CANDIDATE_TTL_MS, at background priority.

import { footprintOverlap, planFootprint, sameFile, type FootprintOverlap, type PlanFootprint } from "../shared/plan-footprint";
import { hasSection, REACH_SECTION, reachBody } from "../shared/plan-sections";
import { parseBlock, RELATED_WORK_TAG } from "../shared/work-order";
import type { PullRequestFiles } from "./label-sync";
import type { CandidateIssue, DoneIssue, LinearService, Pages } from "./linear";
import { PLANNING_STATE, planStage } from "./plan-policy";
import { withPriority } from "./rate-budget";
import { approvalInterval, approvedDocument, documentPlanHash, documentPlanText, planHash } from "./review-outcome";

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

// The document a catch-up leaves beside an old approved plan (README, "Catch-up of older plans"):
// its first two lines name the plan it covers and the approved section it was written from, so
// every reader drops it as soon as the ticket is approved again.
export type RelatedWorkDocument = { planHash: string; section: string; catchUp: string; approvedAt: string; reach?: string | null };

export function relatedWorkDocument({ planHash: covers, section, catchUp, approvedAt, reach }: RelatedWorkDocument): string {
  return [
    `<!-- covers-plan: ${covers} -->\n<!-- analysis: ${planHash(section)} -->`,
    `## Related work (catch-up ${catchUp}, approved ${approvedAt})`,
    section.trim(),
    ...(reach ? [`## Reach`, reach.trim()] : []),
  ].join("\n\n") + "\n";
}

// A `Related work:` document's two header lines; either is null when the document was written by
// something else.
export function relatedWorkHeader(content: string): { coversPlan: string | null; analysis: string | null } {
  return {
    coversPlan: /^<!-- covers-plan: (\S+) -->\s*$/m.exec(content)?.[1] ?? null,
    analysis: /^<!-- analysis: (\S+) -->\s*$/m.exec(content)?.[1] ?? null,
  };
}

// A ticket's plan as every reader sees it: the `Plan:` document's own text, plus its `Related
// work:` document while that one covers the plan's current hash. A plan approved again makes the
// document stale, and its new plan carries its own list.
export function composePlan(planDocument: string, relatedWork: string | null): string {
  const plan = documentPlanText(planDocument);
  if (!relatedWork || relatedWorkHeader(relatedWork).coversPlan !== documentPlanHash(planDocument)) return plan;
  // Everything below the document's leading `<!-- … -->` header lines is its body.
  const body = relatedWork.replace(/^(?:\s*<!--[^\n]*-->\s*\n)+/, "").trim();
  return `${plan.trimEnd()}\n\n${body}\n`;
}

type Deps = {
  linear: Pick<LinearService, "teamCandidates" | "doneSince" | "documentContents" | "planDocumentsSince">;
  pullRequests: Pick<PullRequestFiles, "refresh" | "filesOf" | "stateOf">;
  now?: () => number;
};

type ApprovedPlan = {
  issue: CandidateIssue;
  approvedAt: string;
  label: string;
  // The `Plan:` document's content, and the plan every reader uses (composed, see `composePlan`).
  content: string;
  plan: string;
  // The `Plan:` document's own hash, block and `## Reach`, which the catch-up checks as they are.
  planHash: string;
  hasBlock: boolean;
  hasReach: boolean;
};
// One approved plan as the catch-up lists and applies it (server/related-catch-up.ts).
export type ApprovedPlanInfo = {
  issueId: string; identifier: string; title: string; status: string; statusType: string;
  approvedAt: string; planHash: string; hasBlock: boolean; hasReach: boolean; plan: string;
};
// An approved plan of another ticket whose footprint overlaps one's own (`approvedSince`).
export type ApprovalOverlap = { identifier: string; approvedAt: number; overlap: FootprintOverlap };
// Work that changed since a plan was approved (`changedSince`): a pull request merged, or another
// ticket's plan approved, with the part that overlaps the plan. `status`: the ticket's state.
export type ChangedSinceEntry =
  | { kind: "merged"; identifier: string; status: string; url: string; mergedAt: string; files: string[] }
  | { kind: "approved"; identifier: string; status: string | null; approvedAt: number; completedAt: string | null; overlap: FootprintOverlap };
export type ChangedSinceQuery = { issueId: string; identifier: string; teamId: string; plan: string; approved: string };
// A team's open work as the new-ticket check reads it (README, "New-ticket check"): the open
// tickets, the files each approved plan names, and the plan documents that could not be read.
export type OpenWork = { open: Pages<CandidateIssue>; plans: { identifier: string; files: string[] }[]; unreadPlans: string[] };
// One read of a team's open tickets and their approved plans, shared by the candidate list and
// `openWork`; `open` resolves first, so the list's pull request reads run alongside the plan reads.
type Snapshot = { open: Promise<Pages<CandidateIssue>>; full: Promise<{ open: Pages<CandidateIssue>; plans: ApprovedPlan[]; unread: string[] }> };

export class RelatedWork {
  // `until`: when the finished build expires; Infinity while it runs (single flight).
  private readonly builds = new Map<string, { list: Promise<string>; until: number }>();
  private readonly snapshots = new Map<string, { snapshot: Snapshot; until: number }>();
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

  // The team's open tickets and approved plans, read at most once per team every CANDIDATE_TTL_MS
  // (single flight); a failed read is not kept.
  private snapshot(teamId: string): Snapshot {
    const cached = this.snapshots.get(teamId);
    if (cached && cached.until > this.now()) return cached.snapshot;
    const open = this.deps.linear.teamCandidates(teamId);
    const full = open.then(async (read) => ({ open: read, ...(await this.readPlans(read.items)) }));
    // `full` carries the same rejection to every reader.
    open.catch(() => undefined);
    const entry = { snapshot: { open, full }, until: Infinity };
    this.snapshots.set(teamId, entry);
    full.then(
      () => { entry.until = this.now() + CANDIDATE_TTL_MS; },
      () => { if (this.snapshots.get(teamId) === entry) this.snapshots.delete(teamId); },
    );
    return entry.snapshot;
  }

  // The team's open work for the new-ticket check, from the same snapshot as the candidate list.
  // Rejects when the team's open tickets cannot be read.
  async openWork(teamId: string): Promise<OpenWork> {
    const { open, plans, unread } = await this.snapshot(teamId).full;
    return { open, plans: plans.map((plan) => ({ identifier: plan.issue.identifier, files: planFootprint(plan.plan, plan.issue.identifier).files })), unreadPlans: unread };
  }

  private async build(teamId: string): Promise<string> {
    const { open: reading, full } = this.snapshot(teamId);
    const since = new Date(this.now() - DONE_DAYS * DAY_MS).toISOString();
    const done = this.deps.linear.doneSince(teamId, since).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    const open = await reading;
    const [plans] = await Promise.all([
      full,
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
      doneSection(await done, since),
    ].join("\n\n") + "\n";
  }

  // The team's approved plans, newest approval first, with what the catch-up needs (README,
  // "Catch-up of older plans"): its own block, reach and hash, and the plan as its readers see it.
  async approvedPlans(teamId: string): Promise<ApprovedPlanInfo[]> {
    const open = await withPriority("background", "related work", () => this.deps.linear.teamCandidates(teamId));
    const { plans } = await this.readPlans(open.items);
    return plans.map((plan) => ({
      issueId: plan.issue.id, identifier: plan.issue.identifier, title: plan.issue.title, status: plan.issue.status, statusType: plan.issue.statusType,
      approvedAt: plan.approvedAt, planHash: plan.planHash, hasBlock: plan.hasBlock, hasReach: plan.hasReach, plan: plan.plan,
    }));
  }

  // The Approved `Plan: <identifier>` documents of these tickets, newest approval first, each with
  // the ticket's `Related work:` document composed into it while that one covers the plan's hash;
  // `unread`: the plan documents whose content could not be read.
  private async readPlans(issues: CandidateIssue[]): Promise<{ plans: ApprovedPlan[]; unread: string[] }> {
    const documents = issues.flatMap((issue) => issue.planDocuments.filter((document) => document.title === `Plan: ${issue.identifier}`).map((document) => ({ issue, document })));
    const annotations = issues.flatMap((issue) => issue.planDocuments.filter((document) => document.title === `Related work: ${issue.identifier}`).map((document) => ({ issue, document })));
    const texts = await this.documentTexts([...documents, ...annotations].map(({ document }) => document));
    const plans: ApprovedPlan[] = [];
    const unread: string[] = [];
    for (const { issue, document } of documents) {
      const content = texts.get(document.id);
      if (content === undefined) { unread.push(document.title); continue; }
      if (!approvedDocument(content)) continue;
      // The header as written, so an old minute-only approval reads like one approved then; the
      // approval interval (review-outcome.ts) carries the precision.
      const label = /^> \*\*Approved\*\*[^\n]* on (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)? UTC)?)/.exec(content)?.[1] ?? `${document.updatedAt} (document saved)`;
      const [approvedAt] = approvalInterval(content, document.updatedAt) ?? [Date.parse(document.updatedAt), 0];
      const annotation = annotations.find((entry) => entry.issue.id === issue.id);
      const text = documentPlanText(content);
      plans.push({
        issue, approvedAt: new Date(approvedAt).toISOString(), label, content,
        plan: composePlan(content, annotation ? texts.get(annotation.document.id) ?? null : null),
        planHash: documentPlanHash(content),
        hasBlock: parseBlock(text, RELATED_WORK_TAG) !== null,
        hasReach: hasSection(text, REACH_SECTION),
      });
    }
    plans.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
    return { plans, unread };
  }

  // The documents' texts by id from the lifetime cache, reading only those whose `updatedAt`
  // changed; a document Linear does not return is missing from the map.
  private async documentTexts(documents: { id: string; updatedAt: string }[]): Promise<Map<string, string>> {
    const stale = documents.filter((document) => this.contents.get(document.id)?.updatedAt !== document.updatedAt).map((document) => document.id);
    const read = stale.length ? await this.deps.linear.documentContents(stale).catch(() => null) : new Map<string, { content: string; updatedAt: string }>();
    const texts = new Map<string, string>();
    for (const document of documents) {
      const known = this.contents.get(document.id);
      const fresh = read?.get(document.id);
      const entry = known?.updatedAt === document.updatedAt ? known : fresh ? { updatedAt: fresh.updatedAt || document.updatedAt, content: fresh.content } : null;
      if (!entry) continue;
      this.contents.set(document.id, entry);
      texts.set(document.id, entry.content);
    }
    return texts;
  }

  // The committed `Plan:` documents of other tickets approved at or after `since` (epoch ms) whose
  // footprint overlaps `plan`, newest approval first (README, "Plan risk and auto-approval"). An
  // approval counts when its latest bound reaches `since`, so a legacy minute header approved in
  // that minute counts too. `planDocumentsSince` starts a day early, the widest header's window.
  async approvedSince(issueId: string, since: number, plan: string | PlanFootprint, identifier: string | null = null): Promise<ApprovalOverlap[]> {
    const documents = await withPriority("background", "related work", () => this.deps.linear.planDocumentsSince(new Date(since - DAY_MS).toISOString()));
    // The approval coordinator holds a claim's footprint rather than its plan text.
    const own = typeof plan === "string" ? planFootprint(plan, identifier) : plan;
    const overlaps: ApprovalOverlap[] = [];
    for (const document of documents) {
      if (!document.issue || document.issue.id === issueId || document.issue.identifier === identifier) continue;
      if (!approvedDocument(document.content)) continue;
      const approved = approvalInterval(document.content, document.updatedAt);
      if (!approved || approved[1] < since) continue;
      const overlap = footprintOverlap(own, planFootprint(composePlan(document.content, document.relatedWork ?? null), document.issue.identifier));
      if (!overlap.files.length && !overlap.places.length && !overlap.tickets.length && !overlap.namesOther) continue;
      overlaps.push({ identifier: document.issue.identifier, approvedAt: approved[0], overlap });
    }
    return overlaps.sort((a, b) => b.approvedAt - a.approvedAt);
  }

  // What changed since a source plan was approved (README, "Related work"): the approved plans
  // that overlap it, and every pull request merged since its cutoff (open and done tickets) or
  // ticket done since it whose plan overlaps, each at its own instant, newest first. The cutoff is
  // the source plan's earliest bound: a plan cannot contradict itself.
  async changedSince(query: ChangedSinceQuery): Promise<ChangedSinceEntry[]> {
    const cutoff = approvalInterval(query.approved)?.at(0);
    if (cutoff === undefined) throw new Error(`${query.identifier}: the plan document has no approval time`);
    if (!query.teamId) throw new Error(`${query.identifier}: the ticket's team is unknown`);
    const since = new Date(cutoff).toISOString();
    const [approvals, open, done] = await Promise.all([
      this.approvedSince(query.issueId, cutoff, query.plan, query.identifier),
      this.deps.linear.teamCandidates(query.teamId),
      this.deps.linear.doneSince(query.teamId, since),
    ]);
    const own = planFootprint(query.plan, query.identifier);
    // A ticket is open or done, never both; the done list adds the completion time. The ticket's own
    // pull requests are its plan being carried out (a later slice of the same plan), not a change to it.
    const tickets = [
      ...open.items.map((issue) => ({ id: issue.id, identifier: issue.identifier, status: issue.status as string | null, completedAt: null as string | null, pullRequests: issue.pullRequests })),
      ...done.items.map((issue) => ({ id: issue.id, identifier: issue.identifier, status: "Done" as string | null, completedAt: issue.completedAt as string | null, pullRequests: issue.pullRequests })),
    ].filter((ticket) => ticket.id !== query.issueId);
    const known = new Map(tickets.map((ticket) => [ticket.identifier, ticket]));
    const entries: ChangedSinceEntry[] = approvals.map((approval) => ({ kind: "approved", identifier: approval.identifier, status: known.get(approval.identifier)?.status ?? null, approvedAt: approval.approvedAt, completedAt: known.get(approval.identifier)?.completedAt ?? null, overlap: approval.overlap }));
    const urls = tickets.flatMap((ticket) => ticket.pullRequests);
    await this.deps.pullRequests.refresh(urls, CANDIDATE_PULL_REQUEST_READS).catch(() => undefined);
    for (const ticket of tickets) for (const url of ticket.pullRequests) {
      const state = this.deps.pullRequests.stateOf(url);
      if (state?.state !== "MERGED" || !state.mergedAt || Date.parse(state.mergedAt) < cutoff) continue;
      const changed = own.files.filter((planned) => (this.deps.pullRequests.filesOf(url) ?? []).some((file) => sameFile(planned, file)));
      if (changed.length) entries.push({ kind: "merged", identifier: ticket.identifier, status: ticket.status ?? "", url, mergedAt: state.mergedAt, files: changed });
    }
    // Tickets done since the cutoff whose plan also overlaps, whether or not it was approved since.
    const byTicket = new Map<string, Extract<ChangedSinceEntry, { kind: "approved" }>>();
    for (const entry of entries) if (entry.kind === "approved") byTicket.set(entry.identifier, entry);
    // The done tickets' plan documents come with the ticket (linear.ts `doneSince`); only one
    // Linear answered empty is read here.
    const donePlans = done.items.flatMap((issue) => issue.planDocuments.filter((document) => document.title === `Plan: ${issue.identifier}`).map((document) => ({ issue, document })));
    const unread = donePlans.filter(({ document }) => !document.content);
    const texts = unread.length ? await this.documentTexts(unread.map(({ document }) => document)) : new Map<string, string>();
    for (const { issue, document } of donePlans) {
      if (issue.id === query.issueId) continue;
      const content = document.content || texts.get(document.id);
      if (!content) throw new Error(`${issue.identifier}: its plan document could not be read`);
      if (!approvedDocument(content)) continue;
      const approved = approvalInterval(content, document.updatedAt);
      if (!approved) continue;
      const annotation = issue.planDocuments.find((entry) => entry.title === `Related work: ${issue.identifier}`);
      const overlap = footprintOverlap(own, planFootprint(composePlan(content, annotation?.content || null), issue.identifier));
      if (!overlap.files.length && !overlap.places.length && !overlap.tickets.length && !overlap.namesOther) continue;
      const existing = byTicket.get(issue.identifier);
      if (existing) { existing.status = "Done"; existing.completedAt = issue.completedAt; continue; }
      const entry: Extract<ChangedSinceEntry, { kind: "approved" }> = { kind: "approved", identifier: issue.identifier, status: "Done", approvedAt: approved[0], completedAt: issue.completedAt, overlap };
      byTicket.set(issue.identifier, entry);
      entries.push(entry);
    }
    return entries
      .map((entry) => ({ entry, at: entry.kind === "merged" ? Date.parse(entry.mergedAt) : entry.approvedAt }))
      .sort((a, b) => b.at - a.at)
      .map(({ entry }) => entry);
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
      const footprint = planFootprint(plan.plan, plan.issue.identifier);
      const reach = reachBody(plan.plan);
      const list = /^#{1,6}\s+Related work\b/im.test(plan.plan) ? "yes" : "no";
      return [
        `### ${plan.issue.identifier} — ${plan.issue.title} (${plan.issue.status}), approved ${plan.label}`,
        `Related-work list: ${list}${footprint.tickets.length ? `, naming ${footprint.tickets.join(", ")}` : ""}.`,
        `Files: ${footprint.files.length ? footprint.files.map((file) => `\`${file}\``).join(", ") : "none named"}.`,
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
