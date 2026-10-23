// The catch-up of older approved plans (README, "Catch-up of older plans"): the approved plans
// written before a plan carried its own `## Related work` list get that information afterwards, on
// their tickets, as one `Related work:` document each, their links and the replan requests they ask
// for. One catch-up ticket per team files it: the ticket lists the plans, its own plan gives the
// verdict and the lines per listed ticket, and the owner approves it like any plan; Paseo applies
// the approved sections to the listed tickets and closes the ticket.
//
// The ticket's lifecycle is `PlannerTickets` (planner-tickets.ts), as for a project's planner run:
// its record is written before its agent starts, a run without a live agent is restarted after a
// grace period, and it is closed with its agent retired. This file keeps what is the catch-up's:
// which plans it lists, the brief their analysis is written from, the gate of that analysis, and the
// application to the listed tickets — record-first and idempotent, so a crash repeats only a
// missing step and never a second replan request or a second comment.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { modelProblem } from "../shared/plan-model";
import { combinedRating, parsePlanRisk, sectionBody } from "../shared/plan-risk";
import { parsePlanSections, ruleMismatch } from "../shared/plan-sections";
import { blockLines, blockProblems, parseBlock, stepOf, WORK_ORDER_TAG, RELATED_WORK_TAG } from "../shared/work-order";
import type { LinearService } from "./linear";
import type { ParkedPlans } from "./parked";
import type { PlanRelations } from "./plan-relations";
import { PlannerTickets, plannerRecoverySchema, type PlannerRecord, type PlannerRestart, type PlannerStore, type PlannerTarget } from "./planner-tickets";
import type { ProcessInspector } from "./process-liveness";
import { withPriority } from "./rate-budget";
import { documentPlanHash, documentPlanText, planHash } from "./review-outcome";
import { PRECEDENCE_RULE, relatedWorkDocument, relatedWorkHeader, type ApprovedPlanInfo, type ChangedSinceEntry, type RelatedWork } from "./related-work";
import type { PluginSettings, Settings } from "./settings";
import { classifyTicketAgents, isUntrusted } from "./starter";
import { paseoHome } from "./ticket-mcp";

// How often a team's catch-up is looked at. It is a once-in-a-rollout job, so this only bounds how
// long a pending section or a failed start waits; ProjectFlow polls at half the rate for work that
// comes in every day.
const POLL_MS = 5 * 60_000;
// The next catch-up waits this long after its predecessor, so the owner sees the outcome of one
// before the next arrives. A declined catch-up waits a week (D4).
const APPLIED_GAP_MS = 24 * 60 * 60_000;
const DECLINED_GAP_MS = 7 * 24 * 60 * 60_000;
// Closed catch-up ids kept for `isCatchUp`: a review of an old one is rare, and the open one is
// always there.
const CLOSED_KEEP = 50;
const FINISHED: Record<string, true> = { completed: true, canceled: true, duplicate: true };
// A catch-up section writes links only (D5): no hold label and no duplicate closing.
const CATCH_UP_KINDS: Record<string, true> = { blocks: true, relates: true, replan: true };
// The gate of a catch-up plan, as written by `catchUpBrief`.
const TICKET_ID = /^###\s+([A-Z][A-Z0-9]*-\d+)\b([^\n]*)$/;

const sectionSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  ticketStatus: z.string(),
  planHash: z.string(),
  approvedAt: z.string(),
  hasReach: z.boolean(),
  // `steps`: what this section already did ("comment", "document", "links"), so a retried
  // application repeats only what is missing.
  status: z.enum(["pending", "applied", "skipped"]),
  reason: z.string().optional(),
  steps: z.array(z.string()),
  documentUrl: z.string().optional(),
  commentId: z.string(),
});
export type CatchUpSection = z.infer<typeof sectionSchema>;

const runSchema = z.object({
  id: z.string(), listedAt: z.string(), tickets: z.number(),
  started: z.boolean().optional(), startedAt: z.string().optional(), agentId: z.string().optional(),
  restarts: z.number().optional(), ownerAsked: z.boolean().optional(), error: z.string().optional(),
  approved: z.object({ agentId: z.string().nullable(), plan: z.string(), done: z.array(z.string()).optional() }).optional(),
  recovery: plannerRecoverySchema.optional(),
  issueId: z.string(), identifier: z.string(), url: z.string(),
  state: z.enum(["planning", "awaiting-review", "applying"]),
  // The listed tickets' issue ids, oldest approval first; each one's section state is in
  // `outcomes` (the field names `PlannerRecord` defines, so the store satisfies `PlannerStore`).
  listed: z.array(z.string()),
  outcomes: z.record(z.string(), sectionSchema),
  // The one closing comment on the catch-up ticket, reserved before it is posted.
  summary: z.object({ hash: z.string(), id: z.string(), posted: z.boolean() }).optional(),
});
export type CatchUpRecord = z.infer<typeof runSchema>;

const stateSchema = z.object({
  planner: runSchema.nullable(),
  closedPlanner: z.string().optional(),
  lastClosed: z.object({ id: z.string(), outcome: z.enum(["applied", "declined"]), at: z.string() }).nullable(),
  closedIds: z.array(z.string()),
  // The plans a catch-up applied (or gave up on as untrusted), by the hash they were written for:
  // a plan approved again has a new hash and is listed again.
  covered: z.record(z.string(), z.object({ planHash: z.string(), outcome: z.enum(["applied", "untrusted"]) })),
});
export type CatchUpState = z.infer<typeof stateSchema>;

// One listed plan, as the brief and the record need it.
export type CatchUpListed = {
  issueId: string; identifier: string; title: string; status: string;
  planHash: string; approvedAt: string; hasReach: boolean;
};

export type RelatedCatchUpDeps = {
  linear: Pick<LinearService,
    | "teamIdByKey" | "issueCore" | "issueDocument" | "upsertDocumentAsApp" | "commentAsApp"
    | "createIssueAsApp" | "complete" | "viewerId" | "trustedAppIds">;
  related: Pick<RelatedWork, "approvedPlans" | "changedSince">;
  relations: Pick<PlanRelations, "file" | "outcome">;
  // Starts the catch-up ticket's planning agent (TicketStarter.start) and opens its Linear thread.
  startTicket: (issueId: string, paseo: PaseoApi, settings: PluginSettings, options: { retryHint: string; lead: string }) => Promise<{ agentId: string }>;
  openSession: (issueId: string, identifier: string, agentId: string) => Promise<boolean>;
  // Stops the run's agent and archives it (the same `retire` ProjectFlow gets).
  retire: (agentId: string, paseo: PaseoApi) => Promise<void>;
  // The live daemon connection, for the paths that only get an issue id (CatchUpHooks).
  paseo: () => PaseoApi | null;
  // Setup: a plan parked for the owner is not restarted behind the review.
  parked?: Pick<ParkedPlans, "has">;
  settings?: Pick<Settings, "read">;
  store?: CatchUpStore;
  inspect?: ProcessInspector;
  now?: () => number;
};

// `$PASEO_HOME/linear-tickets/related-catch-up.json`, one record per team id, on the ProjectStore
// pattern: every change is one serialized write, so a poll, an approval and a start never overwrite
// each other's state.
export class CatchUpStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path = join(paseoHome(), "linear-tickets", "related-catch-up.json")) {}

  async all(): Promise<Record<string, CatchUpState>> {
    const states: Record<string, CatchUpState> = {};
    for (const [teamId, value] of Object.entries(await this.raw())) states[teamId] = parsed(teamId, value);
    return states;
  }

  async team(teamId: string): Promise<CatchUpState | null> {
    const found = (await this.raw())[teamId];
    return found === undefined ? null : parsed(teamId, found);
  }

  // Changes run one after another, each on the file as it is then. `change` returns the team's new
  // state, or null to keep it.
  update(teamId: string, change: (current: CatchUpState | undefined) => CatchUpState | null): Promise<CatchUpState | null> {
    return this.queued(async () => {
      const file = await this.raw();
      const current = file[teamId] === undefined ? undefined : parsed(teamId, file[teamId]);
      const next = change(current);
      if (next) await this.save({ ...file, [teamId]: next });
      return next;
    });
  }

  private async raw(): Promise<Record<string, unknown>> {
    const source = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The durable catch-up state is malformed: expected a team record object.");
    }
    return value as Record<string, unknown>;
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async save(file: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}

// A team's stored state, or a failure that keeps the catch-up from acting on a record it cannot
// read (an older approved plan stays uncatched up rather than written from a guess).
function parsed(teamId: string, value: unknown): CatchUpState {
  const checked = stateSchema.safeParse(value);
  if (!checked.success) throw new Error(`The durable catch-up state for team ${teamId} is malformed; older approved plans stay uncatched up.`);
  return checked.data;
}

// The brief of a catch-up ticket: the precedence rule, what changed since each listed plan was
// approved, the steps of the analysis, its format and the plan's fixed template. Pure, so a test
// reads it without Linear.
export function catchUpBrief(listed: CatchUpListed[], changes: Record<string, ChangedSinceEntry[]>): string {
  const oldestFirst = [...listed].sort((left, right) => left.approvedAt.localeCompare(right.approvedAt));
  const entries = oldestFirst.map((entry) => {
    const changed = [...(changes[entry.issueId] ?? [])].sort((left, right) => {
      const leftAt = left.kind === "merged" ? Date.parse(left.mergedAt) : left.approvedAt;
      const rightAt = right.kind === "merged" ? Date.parse(right.mergedAt) : right.approvedAt;
      return rightAt - leftAt;
    });
    return [
      `### ${entry.identifier} — ${entry.title} (${entry.status}), approved ${entry.approvedAt}`,
      entry.hasReach
        ? "Its plan has a `## Reach` section."
        : "Its plan has no `## Reach` section, so the section you write for it needs a `#### Reach` list.",
      ...(changed.length
        ? ["Changed since its approval, newest first:", ...changed.map(changeLine)]
        : ["Nothing changed since its approval."]),
    ].join("\n");
  });
  const count = listed.length;
  return [
    `# Catch up the related work of ${count} older approved plan${count === 1 ? "" : "s"}`,
    PRECEDENCE_RULE,
    "## The listed plans, oldest approval first",
    entries.join("\n\n"),
    "## What to do",
    [
      "1. Read each listed ticket's full `Plan:` document before giving it a verdict. The list below names every plan's approval and what changed since; it is not the plan.",
      "2. For a merged change that seems to contradict a plan, read the current file on `origin/main`: it may have been reverted or replaced since.",
      "3. A later approved plan that deliberately replaces the behaviour is not a contradiction of the older plan: say so under `Verdict: holds` and give the newer decision as the reason.",
      "4. Give every listed ticket exactly one section, and no other ticket a section: the owner approves the whole plan at once.",
      "5. Write only links on the listed tickets, and the one replan request its verdict needs. Paseo writes `Related work: <identifier>` on each listed ticket from your section, never into its `Plan:` document.",
    ].join("\n"),
    "## Format",
    [
      "One `### TUC-N` section per listed ticket, under a `## Listed tickets` heading, containing:",
      "- `Verdict: holds — <why>` or `Verdict: replan — <the later work that wins and what no longer holds>`;",
      "- the typed related-work lines, as in `## Related work`;",
      "- for a plan without `## Reach`, a `#### Reach` list of `- <place>: include` lines;",
      "- exactly one ```related-work block whose lines name TUC-N (D2), with `replan TUC-N: <reason>` exactly when the verdict is replan (an empty block when nothing relates). A catch-up block allows only `blocks`, `related` and `replan`: `duplicates` is refused, so a catch-up never adds a hold label or closes a ticket as a duplicate.",
    ].join("\n"),
    "## Layout",
    [
      "Lay the plan out as your planning instructions say: their `#` part headings, in their order, the first part a short overview of this catch-up. After the last part heading come, in this order: the sections below, word for word except the `Advisor rating` line, which carries your advisor's own rating as for any plan; then `## Listed tickets` with the `### TUC-N` sections; then `## Advisor review`, as for any plan. The plan's own `## Reach` must come before every `#### Reach` of a listed ticket, because the first `Reach` heading is read as the plan's.",
      "",
      "```markdown",
      "## Reach",
      "- Changes: the related work recorded for older approved plans",
      "- Listed tickets' related-work documents, links and replan requests: include — AC-1",
      "- Other tickets: n/a — only the listed tickets are written",
      "",
      "## Principles and rules",
      "- Applies: the related-work rules of ticket plans",
      "- Exceptions: none",
      "- New rule: none — it applies existing rules",
      "",
      "## Verification",
      "- AC-1: Paseo's summary on this ticket lists every listed ticket as applied or skipped, with the reason",
      "",
      "## Model",
      "- Tier: strong — the rating requires it; the plan changes no code, Paseo applies its lines",
      "- Strong steps: none — nothing is implemented",
      "- Acceptance tests: none — the plan changes no code; the summary names every write",
      "",
      "## Risk and impact",
      "- Areas: Agent tooling",
      "- Processes: n/a — no business process changes",
      "- Impact: 2 — it writes links and replan requests on other tickets",
      "- Reversibility: data-fix — written links and requests stay after a revert",
      "- Feature flag: no — nothing is enabled",
      "- Migration: no",
      "- Auth: no",
      "- New rule: no — it applies existing rules",
      "- Failure mode: a wrong link or replan request stays on a listed ticket until the owner removes it; the summary names every write",
      "- Advisor rating: <your advisor's impact and reversibility, or `unavailable`>",
      "- Recommendation: owner",
      "```",
    ].join("\n"),
  ].join("\n\n") + "\n";
}

// The `### TUC-N` sections of a catch-up plan, in plan order, each with its heading and body up to
// the next heading of level three or higher.
export function catchUpSections(plan: string): { identifier: string; text: string }[] {
  const lines = plan.split("\n");
  const sections: { identifier: string; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    const heading = TICKET_ID.exec(line);
    if (!heading) continue;
    const body = [line];
    for (let next = index + 1; next < lines.length && !/^#{1,3}\s/.test(lines[next]); next++) body.push(lines[next]);
    sections.push({ identifier: heading[1].toUpperCase(), text: body.join("\n") });
  }
  return sections;
}

function changeLine(entry: ChangedSinceEntry): string {
  if (entry.kind === "merged") {
    const files = entry.files.length ? entry.files.map((file) => `\`${file}\``).join(", ") : "no named file";
    return `- ${entry.identifier} (${entry.status}) ${entry.url} *merged ${entry.mergedAt}*: ${files}`;
  }
  const shared = [
    entry.overlap.files.length ? `files: ${entry.overlap.files.map((file) => `\`${file}\``).join(", ")}` : "",
    entry.overlap.places.length ? `places: ${entry.overlap.places.join(", ")}` : "",
    entry.overlap.tickets.length ? `tickets: ${entry.overlap.tickets.join(", ")}` : "",
    entry.overlap.namesOther ? "it names the listed ticket" : "",
  ].filter(Boolean);
  return `- ${entry.identifier} (${entry.status ?? "no longer open"}) *approved ${new Date(entry.approvedAt).toISOString()}*${entry.completedAt ? `, done ${entry.completedAt}` : ""}: ${shared.join("; ") || "the plans overlap without naming a file, place or ticket"}`;
}

// One catch-up of older approved plans per team, implementing the bridge's `CatchUpHooks`
// (plannotator.ts): the ticket's own plan is gated and decided here, and its approval writes the
// listed tickets, never this one.
export class RelatedCatchUp {
  private readonly store: CatchUpStore;
  private readonly operations = new Map<string, Promise<unknown>>();
  private lastPoll = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: RelatedCatchUpDeps) {
    this.store = deps.store ?? new CatchUpStore();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async currentSettings(settings: PluginSettings): Promise<PluginSettings> {
    return this.deps.settings ? this.deps.settings.read() : settings;
  }

  private requireOwner(settings: PluginSettings): PluginSettings {
    if (settings.activation.mode === "remote") {
      throw new Error(`This host forwards new Linear work to ${settings.activation.peer ?? "the peer host"}; the catch-up of older approved plans runs on the host that owns them.`);
    }
    return settings;
  }

  // One catch-up per team at a time: an approval, a poll and a start never interleave their steps.
  private exclusive<T>(teamId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(teamId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    this.operations.set(teamId, result);
    const release = () => { if (this.operations.get(teamId) === result) this.operations.delete(teamId); };
    void result.then(release, release);
    return result;
  }

  // The open catch-up of this ticket, or any closed one: a late report of its review is routed as a
  // catch-up, never as a ticket plan.
  async isCatchUp(issueId: string): Promise<boolean> {
    if (!issueId) return false;
    for (const state of Object.values(await this.store.all())) {
      if (state.planner?.issueId === issueId || state.closedIds.includes(issueId)) return true;
    }
    return false;
  }

  // Why the catch-up's plan cannot be applied as written; empty when it can. Its verdicts belong to
  // the listed tickets, so the ticket-plan gate of `plannotator.ts` does not apply.
  async problems(issueId: string, plan: string): Promise<string[]> {
    const found = await this.find(issueId);
    if (!found) return [];
    const problems: string[] = [];
    const sections = catchUpSections(plan);
    const listed = found.record.listed.flatMap((id) => {
      const section = found.record.outcomes[id];
      return section ? [section] : [];
    });
    for (const section of listed) {
      const own = sections.filter((candidate) => candidate.identifier === section.identifier);
      if (!own.length) { problems.push(`The plan has no "### ${section.identifier}" section for that listed ticket.`); continue; }
      if (own.length > 1) { problems.push(`The plan has ${own.length} "### ${section.identifier}" sections; a listed ticket gets one.`); continue; }
      problems.push(...this.sectionProblems(own[0].text, section));
    }
    const known = new Set(listed.map((section) => section.identifier));
    for (const section of sections) {
      if (!known.has(section.identifier)) problems.push(`The plan has a "### ${section.identifier}" section, but that ticket is not listed.`);
    }
    const blocks = [...plan.matchAll(/```related-work\b/gi)].length;
    if (blocks > listed.length) problems.push(`The plan has ${blocks} \`\`\`related-work blocks; each section carries exactly one.`);
    const rated = parsePlanRisk(plan);
    if ("problem" in rated) problems.push(rated.problem);
    else {
      const parsed = parsePlanSections(plan, combinedRating(rated.risk).impact);
      if ("problem" in parsed) problems.push(parsed.problem);
      else {
        const mismatch = ruleMismatch(rated.risk.newRule, parsed.sections);
        if (mismatch) problems.push(mismatch);
      }
    }
    const model = modelProblem(plan);
    if (model) problems.push(model);
    return problems;
  }

  // The plan was opened for review: its record says so, so a later poll neither restarts it nor
  // files another one. Repeated calls (a parked plan delivered again) keep it.
  async opened(issueId: string): Promise<void> {
    await this.recordUpdate(issueId, (run) => run.state === "awaiting-review" ? null : { ...run, state: "awaiting-review" });
  }

  // The owner sent the plan back: it plans again, and the poll restarts its agent after the grace.
  async sentBack(issueId: string): Promise<void> {
    await this.recordUpdate(issueId, (run) => run.state === "applying" ? null : { ...run, state: "planning" });
  }

  // The owner approved it: the approved plan and the `applying` state are stored first, so a failed
  // or interrupted application repeats only its missing steps on the next poll.
  async apply(issueId: string, agentId: string | null, plan: string): Promise<void> {
    const paseo = this.deps.paseo();
    if (!paseo) throw new Error("No daemon connection to apply the catch-up.");
    const found = await this.find(issueId);
    if (!found) return;
    await this.exclusive(found.teamId, async () => {
      const stored = await this.store.update(found.teamId, (state) => {
        const run = state?.planner;
        if (!state || !run || run.id !== found.record.id) return null;
        return { ...state, planner: { ...run, state: "applying", approved: { agentId, plan }, ownerAsked: false, error: undefined } };
      });
      const record = stored?.planner;
      if (!record) return;
      await this.advance(found.teamId, record, paseo);
    });
  }

  // Called on every dispatch poll beside the projects: it continues an approved catch-up, restarts
  // one whose agent stopped while it still plans, notices one the owner closed instead of deciding,
  // and files the next one when eligible plans wait.
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    await withPriority("background", "related catch-up", async () => {
      if (settings.activation.mode === "remote") return;
      const current = await this.currentSettings(settings);
      if (current.activation.mode === "remote") return;
      if (!current.dispatch.enabled || !current.dispatch.teamKeys.length) return;
      if (this.now() - this.lastPoll < POLL_MS) return;
      this.lastPoll = this.now();
      for (const key of current.dispatch.teamKeys) {
        if (!key) continue;
        const teamId = await this.deps.linear.teamIdByKey(key).catch((error: unknown) => {
          console.error(`[linear-tickets] catch-up ${key}: reading the team failed: ${message(error)}`);
          return null;
        });
        if (!teamId) continue;
        try {
          await this.exclusive(teamId, () => this.pollTeam(teamId, paseo, current));
        } catch (error) {
          console.error(`[linear-tickets] catch-up ${key}: ${message(error)}`);
        }
      }
    });
  }

  private async pollTeam(teamId: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const state = await this.store.team(teamId);
    const open = state?.planner ?? null;
    if (open) {
      const core = await this.deps.linear.issueCore(open.issueId).catch(() => null);
      if (!open.approved && (!core || FINISHED[core.statusType])) {
        await this.decline(teamId, open, paseo);
        return;
      }
      if (open.state === "applying" && open.approved) {
        await this.advance(teamId, open, paseo);
        return;
      }
      // Only a run that still plans is restarted: one awaiting the owner's review, or one parked
      // with it, never starts a second agent behind the review.
      if (open.state !== "planning" || open.approved || open.ownerAsked) return;
      if (this.deps.parked && await this.deps.parked.has(open.issueId)) return;
      await this.tickets(teamId).revive(this.target(teamId, open), open, settings, paseo);
      return;
    }
    const closed = state?.lastClosed ?? null;
    if (closed && this.now() - Date.parse(closed.at) < (closed.outcome === "declined" ? DECLINED_GAP_MS : APPLIED_GAP_MS)) return;
    const plans = await this.deps.related.approvedPlans(teamId);
    const eligible = plans.filter((plan) => eligiblePlan(state, plan));
    if (!eligible.length) return;
    // Oldest approval first: the plans that waited longest are analysed first.
    await this.file(teamId, eligible.reverse(), paseo, settings);
  }

  private async file(teamId: string, plans: ApprovedPlanInfo[], paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const listed: CatchUpListed[] = plans.map((plan) => ({
      issueId: plan.issueId, identifier: plan.identifier, title: plan.title, status: plan.status,
      planHash: plan.planHash, approvedAt: plan.approvedAt, hasReach: plan.hasReach,
    }));
    const changes = await this.changes(teamId, listed);
    const brief = catchUpBrief(listed, changes);
    const count = listed.length;
    const title = `Catch up the related work of ${count} approved plan${count === 1 ? "" : "s"}`;
    const created = await this.deps.linear.createIssueAsApp({ teamId, title, description: brief });
    if (!created) {
      console.log("[linear-tickets] catch-up: the Paseo app could not file the ticket; the next read retries");
      return;
    }
    const run: CatchUpRecord = {
      id: randomUUID(), issueId: created.id, identifier: created.identifier, url: created.url,
      listedAt: new Date(this.now()).toISOString(), tickets: count, started: false, state: "planning",
      listed: listed.map((entry) => entry.issueId),
      outcomes: Object.fromEntries(listed.map((entry) => [entry.issueId, {
        identifier: entry.identifier, title: entry.title, ticketStatus: entry.status,
        planHash: entry.planHash, approvedAt: entry.approvedAt, hasReach: entry.hasReach,
        status: "pending" as const, steps: [], commentId: randomUUID(),
      }])),
    };
    // The record is written before anything is started: a failed start is retried by the next poll
    // (`revive`), never with a second ticket.
    const opened = await this.plannerStore(teamId).open(run, { planner: null, lastClosed: null, closedIds: [], covered: {} });
    if (!opened.opened) return;
    console.log(`[linear-tickets] catch-up ${run.identifier}: filed for ${count} approved plan${count === 1 ? "" : "s"}`);
    await this.tickets(teamId).launch(this.target(teamId, run), run, settings, paseo);
  }

  // What changed since each listed plan's approval, read from its `Plan:` document (the cutoff is
  // the approval in its header). A failed read leaves that ticket's changes unknown rather than
  // failing the whole brief: the agent then compares itself.
  private async changes(teamId: string, listed: CatchUpListed[]): Promise<Record<string, ChangedSinceEntry[]>> {
    const changes: Record<string, ChangedSinceEntry[]> = {};
    for (const entry of listed) {
      const document = await this.deps.linear.issueDocument(entry.issueId, `Plan: ${entry.identifier}`).catch(() => null);
      if (!document) { changes[entry.issueId] = []; continue; }
      changes[entry.issueId] = await this.deps.related.changedSince({
        issueId: entry.issueId, identifier: entry.identifier, teamId,
        plan: documentPlanText(document.content), approved: document.content,
      }).catch((error: unknown) => {
        console.error(`[linear-tickets] catch-up: what changed since ${entry.identifier}'s approval could not be read: ${message(error)}`);
        return [];
      });
    }
    return changes;
  }

  private async brief(teamId: string, record: CatchUpRecord): Promise<string> {
    const listed = record.listed.flatMap((issueId) => {
      const section = record.outcomes[issueId];
      return section ? [{
        issueId, identifier: section.identifier, title: section.title, status: section.ticketStatus,
        planHash: section.planHash, approvedAt: section.approvedAt, hasReach: section.hasReach,
      }] : [];
    });
    return catchUpBrief(listed, await this.changes(teamId, listed));
  }

  // The run lifecycle's view of one team (planner-tickets.ts): the open catch-up and its record.
  private tickets(teamId: string): PlannerTickets<CatchUpState> {
    return new PlannerTickets<CatchUpState>({ retire: this.deps.retire, now: this.deps.now, inspect: this.deps.inspect }, this.plannerStore(teamId));
  }

  private plannerStore(teamId: string): PlannerStore<CatchUpState> {
    return {
      current: async () => (await this.store.team(teamId))?.planner ?? null,
      open: async (run, record) => {
        const checked = runSchema.safeParse(run);
        if (!checked.success) throw new Error("A catch-up run carries the plans it lists and the state of each of them.");
        let opened = false;
        await this.store.update(teamId, (state) => {
          if (state?.planner) return null;
          opened = true;
          return { ...(state ?? record), planner: checked.data };
        });
        const stored = (await this.store.team(teamId))?.planner;
        return stored ? { run: stored, opened } : { run: checked.data, opened: false };
      },
      update: (runId, change, restart) => this.store.update(teamId, (state) => {
        const run = state?.planner;
        if (!state || !run || run.id !== runId) return null;
        return change(restart ? confirmedRestart(state, run, restart) : state, run);
      }),
    };
  }

  // The catch-up's side of the run lifecycle: its agent (a ticket agent of the catch-up ticket),
  // its brief, its start, and the one comment that asks the owner.
  private target(teamId: string, record: CatchUpRecord): PlannerTarget {
    return {
      label: `catch-up ${record.identifier}`,
      own: async (settings) => this.requireOwner(settings),
      fresh: async (settings) => {
        const current = await this.currentSettings(settings);
        return current.activation.mode === "remote" ? null : current;
      },
      agents: async (_run, paseo) => classifyTicketAgents(paseo, record.issueId, this.now(), this.deps.inspect),
      brief: () => this.brief(teamId, record),
      start: async (input, paseo, settings) => {
        const started = await this.deps.startTicket(record.issueId, paseo, settings, {
          retryHint: "start the catch-up again from the Paseo menu bar app",
          lead: input.brief,
        });
        // The thread is a convenience: the plan reaches Plannotator without it, and a failed open is
        // retried by the next start rather than spending the restart budget.
        const opened = await this.deps.openSession(record.issueId, record.identifier, started.agentId)
          .catch((error: unknown) => { console.error(`[linear-tickets] catch-up ${record.identifier}: opening the thread failed: ${message(error)}`); return false; });
        if (!opened) console.log(`[linear-tickets] catch-up ${record.identifier}: agent ${started.agentId.slice(0, 8)} has no Linear thread`);
        return started;
      },
      ask: async (_run, problem) => {
        const body = `**No agent is planning the catch-up of older approved plans.** ${problem}\n\nStart it again from the Paseo menu bar app, or close this ticket to leave the older plans as they are.`;
        await this.deps.linear.commentAsApp(record.issueId, body)
          .catch((error: unknown) => console.error(`[linear-tickets] catch-up ${record.identifier}: the owner notice failed: ${message(error)}`));
      },
      defer: (work) => this.exclusive(record.id, work),
    };
  }

  // The sections of the approved plan, in order, each saved as it is applied. A section that stays
  // pending (the Paseo app unusable, a retrying relations record) ends this pass; the next poll
  // continues it.
  private async advance(teamId: string, record: CatchUpRecord, paseo: PaseoApi): Promise<void> {
    for (;;) {
      const current = await this.store.team(teamId);
      const run = current?.planner;
      if (!run || run.id !== record.id || run.state !== "applying" || !run.approved) return;
      const issueId = run.listed.find((id) => run.outcomes[id]?.status === "pending");
      if (issueId === undefined) {
        await this.finish(teamId, run, paseo);
        return;
      }
      if (!(await this.section(teamId, run, issueId))) return;
    }
  }

  // One listed ticket, in the approved plan's order: re-read the ticket and its plan, write the
  // `Related work:` document, file its links, and keep what each step reached.
  private async section(teamId: string, record: CatchUpRecord, issueId: string): Promise<boolean> {
    const listed = record.outcomes[issueId];
    const plan = record.approved?.plan ?? "";
    if (!listed) return true;
    const section = catchUpSections(plan).find((candidate) => candidate.identifier === listed.identifier);
    if (!section) return false;
    // 1. The ticket as it is now: closed, or approved again since it was listed, keeps its new plan.
    const core = await this.deps.linear.issueCore(issueId);
    if (FINISHED[core.statusType]) {
      await this.skip(teamId, record.id, issueId, `${listed.identifier} is closed now, so nothing was written on it`);
      return true;
    }
    const document = await this.deps.linear.issueDocument(issueId, `Plan: ${listed.identifier}`);
    if (!document || documentPlanHash(document.content) !== listed.planHash) {
      await this.skip(teamId, record.id, issueId, `${listed.identifier}'s plan was approved again since it was listed, and its new plan carries its own list`);
      return true;
    }
    if (isUntrusted(core, await this.deps.linear.viewerId(), await this.deps.linear.trustedAppIds())) {
      const informed = listed.steps.includes("comment") || await this.deps.linear.commentAsApp(issueId, this.untrustedText(record, listed, section.text), listed.commentId) !== null;
      if (!informed) return false;
      await this.save(teamId, record.id, issueId, (current) => ({ ...current, steps: [...current.steps, "comment"] }));
      await this.skip(teamId, record.id, issueId, `${listed.identifier} was not written by you or Paseo; its lines wait in one comment for your review`, "untrusted");
      return true;
    }
    // 2. The analysis as a document beside the plan, rewritten only when it changed: its header
    // hashes the section, so a later catch-up of the same plan does not repeat an unchanged one.
    const title = `Related work: ${listed.identifier}`;
    const existing = await this.deps.linear.issueDocument(issueId, title);
    let url = existing?.url ?? listed.documentUrl ?? null;
    if (!existing || relatedWorkHeader(existing.content).analysis !== planHash(section.text)) {
      const reach = listed.hasReach ? null : reachBlock(section.text);
      const written = await this.deps.linear.upsertDocumentAsApp(issueId, title, relatedWorkDocument({
        planHash: listed.planHash, section: section.text, catchUp: record.identifier, approvedAt: listed.approvedAt, reach,
      }));
      if (written === null) return false;
      url = written;
      await this.save(teamId, record.id, issueId, (current) => ({ ...current, documentUrl: written, steps: [...current.steps, "document"] }));
    }
    // 3. The links and the replan request, as the Paseo app: never this ticket's own.
    const recordId = `catch-up:${issueId}:${listed.planHash}`;
    await this.deps.relations.file({
      issueId, identifier: listed.identifier, plan: section.text, documentUrl: url,
      origin: record.identifier, cleanup: false, guard: { issueId, planHash: listed.planHash }, recordId,
    });
    // 4. What the record reached: applied, skipped with its reason, or still pending.
    const reached = await this.deps.relations.outcome(recordId);
    if (reached.status === "pending") return false;
    if (reached.status === "done") {
      await this.applied(teamId, record.id, issueId);
      return true;
    }
    await this.skip(teamId, record.id, issueId, stoppedReason(listed.identifier, reached.reason));
    return true;
  }

  // Every section settled: one summary comment, the ticket completed, the run closed with its agent
  // retired. The summary is reserved and posted once, so a crash between the two repeats neither.
  private async finish(teamId: string, record: CatchUpRecord, paseo: PaseoApi): Promise<void> {
    const approved = record.approved;
    if (!approved) return;
    if (record.listed.some((issueId) => record.outcomes[issueId]?.status === "pending")) return;
    const hash = planHash(approved.plan);
    let summary = record.summary;
    if (!summary || summary.hash !== hash) {
      summary = { hash, id: randomUUID(), posted: false };
      const reserved = summary;
      await this.store.update(teamId, (state) => {
        const run = state?.planner;
        return state && run && run.id === record.id ? { ...state, planner: { ...run, summary: reserved } } : null;
      });
    }
    if (!summary.posted) {
      const posted = await this.deps.linear.commentAsApp(record.issueId, this.summary(record), summary.id);
      if (posted === null) return;
      await this.store.update(teamId, (state) => {
        const run = state?.planner;
        return state && run && run.id === record.id ? { ...state, planner: { ...run, summary: { ...summary, posted: true } } } : null;
      });
    }
    await this.deps.linear.complete(record.issueId);
    const applied = record.listed.filter((issueId) => record.outcomes[issueId]?.status === "applied").length;
    const counted = record.listed.length;
    const closed = await this.tickets(teamId).close(record, (state) => ({
      ...state,
      lastClosed: { id: record.id, outcome: "applied", at: new Date(this.now()).toISOString() },
      closedIds: [...state.closedIds.filter((id) => id !== record.issueId), record.issueId].slice(-CLOSED_KEEP),
    }), paseo);
    if (closed) console.log(`[linear-tickets] catch-up ${record.identifier}: ${applied} of ${counted} listed plan${counted === 1 ? "" : "s"} applied`);
  }

  // The owner closed the catch-up ticket instead of approving it: its listed plans stay as they
  // are, and the next catch-up waits a week (D4).
  private async decline(teamId: string, record: CatchUpRecord, paseo: PaseoApi): Promise<void> {
    const closed = await this.tickets(teamId).close(record, (state) => ({
      ...state,
      lastClosed: { id: record.id, outcome: "declined", at: new Date(this.now()).toISOString() },
      closedIds: [...state.closedIds.filter((id) => id !== record.issueId), record.issueId].slice(-CLOSED_KEEP),
    }), paseo);
    if (!closed) return;
    // A run closed while its agent still planned: stop the agents the ticket may have left. The
    // lifecycle retires an approved run's agent; a declined one has none recorded until adoption.
    const agents = await classifyTicketAgents(paseo, record.issueId, this.now(), this.deps.inspect);
    const roots = new Set([...agents.live, ...agents.ghosts].map((agent) => agent.id));
    if (record.agentId) roots.add(record.agentId);
    for (const id of roots) {
      if (id !== record.approved?.agentId) await this.deps.retire(id, paseo);
    }
    console.log(`[linear-tickets] catch-up ${record.identifier}: closed without approval; the next catch-up waits ${DECLINED_GAP_MS / (24 * 60 * 60_000)} days`);
  }

  private async applied(teamId: string, runId: string, issueId: string): Promise<void> {
    await this.save(teamId, runId, issueId, (current) => ({ ...current, status: "applied", steps: [...current.steps, "links"] }), "applied");
  }

  // A skipped section is never covered unless the Paseo app could not be trusted: a plan whose
  // document was written stays eligible, and the next catch-up resumes it.
  private async skip(teamId: string, runId: string, issueId: string, reason: string, outcome?: "untrusted"): Promise<void> {
    await this.save(teamId, runId, issueId, (current) => ({ ...current, status: "skipped", reason }), outcome);
  }

  private async save(
    teamId: string, runId: string, issueId: string,
    change: (current: CatchUpSection) => CatchUpSection,
    cover?: "applied" | "untrusted",
  ): Promise<void> {
    await this.store.update(teamId, (state) => {
      const run = state?.planner;
      const current = run?.outcomes[issueId];
      if (!state || !run || run.id !== runId || !current) return null;
      const next = change(current);
      return {
        ...state,
        planner: { ...run, outcomes: { ...run.outcomes, [issueId]: next } },
        ...(cover ? { covered: { ...state.covered, [issueId]: { planHash: next.planHash, outcome: cover } } } : {}),
      };
    });
  }

  private async recordUpdate(issueId: string, change: (run: CatchUpRecord) => CatchUpRecord | null): Promise<void> {
    const found = await this.find(issueId);
    if (!found) return;
    await this.store.update(found.teamId, (state) => {
      const run = state?.planner;
      if (!state || !run || run.id !== found.record.id) return null;
      const next = change(run);
      return next ? { ...state, planner: next } : null;
    });
  }

  private async find(issueId: string): Promise<{ teamId: string; record: CatchUpRecord } | null> {
    for (const [teamId, state] of Object.entries(await this.store.all())) {
      if (state.planner?.issueId === issueId) return { teamId, record: state.planner };
    }
    return null;
  }

  private sectionProblems(section: string, listed: CatchUpSection): string[] {
    const problems: string[] = [];
    const blocks = [...section.matchAll(/```related-work\b/gi)].length;
    const block = parseBlock(section, RELATED_WORK_TAG);
    if (blocks !== 1) problems.push(`The "### ${listed.identifier}" section has ${blocks} \`\`\`${RELATED_WORK_TAG} blocks; it needs exactly one.`);
    else problems.push(...blockProblems(section, RELATED_WORK_TAG, CATCH_UP_KINDS, listed.identifier));
    const verdict = verdictOf(section);
    const replan = blockLines(block ?? "").map(stepOf).filter((step) => step?.kind === "replan");
    if (verdict === null) problems.push(`The "### ${listed.identifier}" section has no \`Verdict: holds — <why>\` or \`Verdict: replan — <what no longer holds>\` line.`);
    else if (verdict === "replan" && !replan.length) problems.push(`The "### ${listed.identifier}" section says \`Verdict: replan\` but its block has no \`replan\` line.`);
    else if (verdict === "holds" && replan.length) problems.push(`The "### ${listed.identifier}" section says \`Verdict: holds\` but its block asks for a replan.`);
    for (const step of replan) {
      const ticket = step?.kind === "replan" ? step.ticket : null;
      if (ticket && ticket !== listed.identifier) problems.push(`The "### ${listed.identifier}" section asks for \`replan ${ticket}\`; it revises its own ticket's plan, so write \`replan ${listed.identifier}\`.`);
    }
    if (!listed.hasReach && !reachBlock(section)) {
      problems.push(`The "### ${listed.identifier}" section has no "#### Reach" list, and its plan has no "## Reach": give it \`- <place>: include\` lines.`);
    }
    return problems;
  }

  private untrustedText(record: CatchUpRecord, listed: CatchUpSection, section: string): string {
    const lines = blockLines(parseBlock(section, RELATED_WORK_TAG) ?? "");
    return [
      `**Related work of the approved plan of ${listed.identifier}** (catch-up ${record.identifier})`,
      `${listed.identifier} was not written by you or Paseo, so Paseo did not change it. Its plan's related work:`,
      ...(lines.length ? lines.map((line) => `- ${line}`) : ["- nothing relates."]),
    ].join("\n");
  }

  private summary(record: CatchUpRecord): string {
    const sections = catchUpSections(record.approved?.plan ?? "");
    const lines = record.listed.map((issueId) => {
      const listed = record.outcomes[issueId];
      if (!listed) return `- ${issueId}`;
      const verdict = verdictOf(sections.find((section) => section.identifier === listed.identifier)?.text ?? "") ?? "holds";
      const outcome = listed.status === "applied"
        ? `applied — its \`Related work:\` document and its links are written; its plan comment names any line already done elsewhere`
        : `skipped — ${listed.reason ?? "it was not written"}`;
      return `- ${listed.identifier} (${verdict}): ${outcome}`;
    });
    return [
      `**Related work of ${record.listed.length} older approved plan${record.listed.length === 1 ? "" : "s"}**`,
      lines.join("\n"),
    ].join("\n\n");
  }
}

// Whether an approved plan is one the catch-up lists: no related-work block of its own, not covered
// for this hash, not a catch-up ticket, and not a project planner's work order.
function eligiblePlan(state: CatchUpState | null, plan: ApprovedPlanInfo): boolean {
  if (plan.hasBlock) return false;
  if (state?.covered[plan.issueId]?.planHash === plan.planHash) return false;
  if (state?.planner?.issueId === plan.issueId || state?.closedIds.includes(plan.issueId)) return false;
  return parseBlock(plan.plan, WORK_ORDER_TAG) === null && sectionBody(plan.plan, "Work order") === null;
}

// The verdict line of a catch-up section, with its bullets, bold and code markers removed.
function verdictOf(section: string): "holds" | "replan" | null {
  for (const line of section.split("\n")) {
    const plain = line.replace(/^[-*]\s*/, "").replace(/[`*]/g, "").trim();
    const found = /^Verdict\s*:\s*(holds|replan)\b/i.exec(plain);
    if (found) return found[1].toLowerCase() === "replan" ? "replan" : "holds";
  }
  return null;
}

// A section's `#### Reach` list as its lines, for the plan of a ticket that has no `## Reach` of its
// own; null without that heading (or an empty one).
function reachBlock(section: string): string | null {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => /^####\s+Reach\b/i.test(line));
  if (start < 0) return null;
  const body: string[] = [];
  for (let next = start + 1; next < lines.length && !/^#{1,4}\s/.test(lines[next]); next++) body.push(lines[next].trim());
  return body.filter(Boolean).join("\n") || null;
}

function stoppedReason(identifier: string, reason: "gave-up" | "untrusted" | "changed"): string {
  if (reason === "untrusted") return `${identifier} was not trusted when its links were written, so nothing more was written on it`;
  if (reason === "changed") return `${identifier}'s plan was approved again while its links were being written, so nothing more was written on it`;
  return `Linear refused some of ${identifier}'s links in five rounds; write them by hand`;
}

function confirmedRestart(state: CatchUpState, run: CatchUpRecord, restart: PlannerRestart): CatchUpState {
  const claims = [...(run.recovery?.claims ?? []), new Date(restart.at).toISOString()].slice(-8);
  return {
    ...state,
    planner: { ...run, recovery: { ...(run.recovery ?? { attempt: 0, claims: [] }), attempt: (run.recovery?.attempt ?? 0) + 1, claims, handledAgentId: restart.agentId } },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}