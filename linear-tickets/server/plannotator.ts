import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { IssueState, LinearService } from "./linear";
import type { PluginSettings, Settings } from "./settings";
import { PLANNOTATOR_OPEN_SOURCE } from "./plannotator-open-source";
import { paseoHome } from "./ticket-mcp";
import type { Handover } from "./handover";
import { activeModel } from "./model";
import { APPROVE_LATER, APPROVE_PLAN, decidePlannotatorReview, MAX_SPLIT, planSteps, ReviewClosedError, SEND_BACK, setAgentMode, SPLIT_PLAN, type SessionLink, type SessionRouter } from "./sessions";
import { hasLabel, PLAN_POLICY_LABEL, PLAN_READY_LABEL } from "./plan-policy";
import type { ParkedPlan, ParkedPlans } from "./parked";
import type { ReviewLinks } from "./review-links";
import { autoApproval, parsePlanRisk, ratingText, type ReviewFacts } from "../shared/plan-risk";
import { planHash, reviewOutcome, type PendingReview, type ReviewOutcome } from "./review-outcome";
import { isUntrusted } from "./starter";
import { dispatchLabels } from "./dispatch";
import { orderProblems, type ProjectFlow } from "./project-flow";
import type { PlanFollowUps } from "./plan-follow-ups";
import { feedbackEntry, logQuietly, type DecisionLog } from "./owner-decisions";
import { modelProblem, modelSteps, planTier, strongerTier, TIERS, type Tier } from "../shared/plan-model";
import { labelTier, onlyTierAdded, TIER_LABELS, tierModel, type TierStore } from "./model-tiers";
import type { ReviewDeletions } from "./review-deletions";
import { RateLimitedError, withPriority } from "./rate-budget";
import { DecisionJournal, DecisionPendingError, FencedError, type DecisionAttempt, type ResolveAction, type ReviewGeneration, type RouteSnapshot } from "./decision-journal";
import { applyLater, applySplit, splitProblem, type PanelWork, type Steps } from "./split";

// The plan text of a running review, from the same endpoint its page loads.
export async function readReviewPlan(localUrl: string): Promise<string> {
  const response = await fetch(`${new URL(localUrl).origin}/api/plan`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) return "";
  const body: unknown = await response.json();
  return body && typeof body === "object" && "plan" in body && typeof body.plan === "string" ? body.plan : "";
}

// Opens a review on this machine, as Plannotator would without the hook. LINEAR_TICKETS_OPENER
// replaces the system opener (tests). A missing opener (a server without a desktop has no
// xdg-open) fails asynchronously: logged, never thrown, since an unhandled spawn error would end
// the plugin.
export function openInBrowser(url: string): void {
  const opener = process.env.LINEAR_TICKETS_OPENER || (process.platform === "darwin" ? "open" : "xdg-open");
  const failed = (error: unknown) => console.error(`[linear-tickets] opening ${url} failed: ${error instanceof Error ? error.message : error}`);
  try { spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", failed).unref(); } catch (error) { failed(error); }
}

export const PLANNOTATOR_KIND = "plannotator";
// About a minute of retries at the sweep interval, enough to ride out a Linear hiccup. Only
// `opened` events give up (the review still opens); a decision's event stays until the journal has it.
const MAX_ATTEMPTS = 20;
const SWEEP_MS = 3_000;
const MAX_PLAN_CHARS = 180_000;
// An uncertain decision asks Plannotator (or its saved plans) again at most this often.
const RECHECK_MS = 15_000;
const PRUNE_MS = 60 * 60_000;
// The generation a decision binds to when its review was opened before the journal existed.
const LEGACY_OPENED_AT = "1970-01-01T00:00:00.000Z";

export type PlannotatorRow = { title: string; url?: string; detail?: string };
export type OpenedEvent = { type: "opened"; agentId: string | null; localUrl: string; remoteUrl: string | null; at: string };
// `parked`: a parked plan's decision, reported by the central Plannotator host (parked.ts), which
// names its review (`review`: its server's address and start time).
export type DecidedEvent = { type: "decided"; agentId: string | null; approved: boolean; feedback?: string; planUri?: string; planContent?: string; parked?: true; review?: { localUrl: string; servedAt: string }; at: string };
// The omp extension recorded the plan advisor's review (verdict) for the plan text with this hash.
export type AdvisedEvent = { type: "advised"; agentId: string | null; verdict: string; hash: string; at: string };
// The ticket agent asked for the strong model tier (the omp extension's escalate_model tool).
export type EscalatedEvent = { type: "escalated"; agentId: string | null; reason: string; at: string };
type PlannotatorEvent = OpenedEvent | DecidedEvent | AdvisedEvent | EscalatedEvent;
// Model tiers (README, "Model tiers"): where tier decisions are recorded, the model guard's
// immediate switch of one agent, and sending a working agent back to planning (plan-requests.ts).
export type Tiers = { store: Pick<TierStore, "record">; apply: (agentId: string) => Promise<unknown>; replan: (agent: { id: string; issueId: string; identifier: string }, message: string) => Promise<void> };
type Linear = Pick<LinearService, "comment" | "commentById" | "upsertIssueDocument" | "issueDocument" | "moveToStateNamed" | "moveToReady" | "addLabel" | "removeLabel" | "issueState" | "viewerId" | "appUserId" | "createIssue" | "issueById" | "addBlocker" | "delegate">;
type Sessions = Pick<SessionRouter, "sessionFor" | "plan" | "ask" | "say" | "said" | "expectReview" | "clearReview" | "parked" | "requeueSession" | "holdSession" | "groupSession">;
// What the risk policy made of an opened review: `line` tells the owner, in the panel and on Linear;
// `reasons` why it needs the owner (empty when approved).
type Judgement = { approved: boolean; line: string; reasons: string[] };
type ProjectPlans = Pick<ProjectFlow, "isPlannerRun" | "applyPlan">;
// Parked plans (README, "Parked plans"): `available` while the central Plannotator host runs;
// `retire` closes the agent's own review (when it has one) with the reason, stops and archives the agent.
export type Parking = {
  plans: Pick<ParkedPlans, "forAgent" | "put" | "remove">;
  available: () => boolean;
  retire: (localUrl: string | null, agentId: string, paseo: PaseoApi, reason: string) => Promise<void>;
};
type Advice = { verdict: string; hash: string };
// Where a decision of the owner on a review comes from, and which review generation it is on.
export type OwnerOrigin = { reviewId?: string; openedAt?: string; source: "inbox" | "linear-panel" };
type WorkerSteps = Steps & { optional(name: string, work: () => Promise<unknown>): Promise<void> };

// A step that waits without counting a try (a deletion in progress).
class WaitError extends Error {}
// The ticket was deleted: the decision is never carried out.
class DeletedError extends Error {}

// Workflow states the review moves a ticket through when status write-back is on.
export const PLANNING_STATE = "Planning";
export const CODING_STATE = "In Progress";

export function plannotatorPaths(home = paseoHome()) {
  const directory = join(home, "linear-tickets", "plannotator");
  return { directory, events: join(directory, "events"), script: join(directory, "open.mjs"), launcher: join(directory, "open") };
}

// PLANNOTATOR_BROWSER must be one executable path, so a two-line wrapper starts the hook
// with the daemon's own Node runtime (Electron as Node inside the desktop app).
export async function writeOpenScript(paths = plannotatorPaths(), runtime = { execPath: process.execPath, electron: Boolean(process.versions.electron) }): Promise<string> {
  await mkdir(paths.events, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const wrapper = [
    "#!/bin/sh",
    `${runtime.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}LINEAR_TICKETS_PLANNOTATOR_EVENTS=${quote(paths.events)} exec ${quote(runtime.execPath)} ${quote(paths.script)} "$@"`,
    "",
  ].join("\n");
  for (const [path, content, mode] of [[paths.script, PLANNOTATOR_OPEN_SOURCE, 0o600], [paths.launcher, wrapper, 0o700]] as const) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  return paths.launcher;
}

export function parseEvent(raw: string): PlannotatorEvent | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const event = value as Record<string, unknown>;
  const agentId = typeof event.agentId === "string" && event.agentId ? event.agentId : null;
  const at = typeof event.at === "string" ? event.at : new Date().toISOString();
  if (event.type === "opened" && typeof event.localUrl === "string") {
    return { type: "opened", agentId, localUrl: event.localUrl, remoteUrl: typeof event.remoteUrl === "string" ? event.remoteUrl : null, at };
  }
  if (event.type === "decided" && typeof event.approved === "boolean") {
    const review = event.review && typeof event.review === "object" ? event.review as Record<string, unknown> : null;
    return {
      type: "decided", agentId, approved: event.approved, at,
      ...(typeof event.feedback === "string" && event.feedback.trim() ? { feedback: event.feedback.trim() } : {}),
      ...(typeof event.planUri === "string" ? { planUri: event.planUri } : {}),
      ...(typeof event.planContent === "string" ? { planContent: event.planContent } : {}),
      ...(event.parked === true ? { parked: true as const } : {}),
      ...(review && typeof review.localUrl === "string" && typeof review.servedAt === "string" ? { review: { localUrl: review.localUrl, servedAt: review.servedAt } } : {}),
    };
  }
  if (event.type === "advised" && typeof event.verdict === "string" && typeof event.hash === "string") {
    return { type: "advised", agentId, verdict: event.verdict, hash: event.hash, at };
  }
  if (event.type === "escalated" && typeof event.reason === "string" && event.reason.trim()) {
    return { type: "escalated", agentId, reason: event.reason.trim().slice(0, 1_000), at };
  }
  return null;
}

export function planDocument(event: DecidedEvent, identifier: string, model?: string | null): string {
  const date = event.at.slice(0, 16).replace("T", " ");
  const plan = (event.planContent ?? "").trim() || "_The plan text was not recorded._";
  return [
    `> **${event.approved ? "Approved" : "Sent back with feedback"}** in Plannotator on ${date} UTC for ${identifier}. Replaced on every review round; the decision comments on the ticket keep the history.`,
    model ? `> **Planned with:** \`${model}\`` : "",
    event.feedback ? `\n## Review feedback\n\n${event.feedback}` : "",
    "\n---\n",
    plan.length > MAX_PLAN_CHARS ? `${plan.slice(0, MAX_PLAN_CHARS)}\n\n… (truncated)` : plan,
  ].join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Plannotator ↔ Paseo ↔ Linear. Plannotator's review URL only reaches omp's UI notices, which
// Paseo does not show, so reviews were invisible. The PLANNOTATOR_BROWSER hook and the omp
// plan extension drop events into a directory; this bridge turns each into a row in the
// agent's Paseo chat and — for agents linked to a ticket — a Linear comment with the agent's
// stable review link (ReviewLinks).
//
// Decisions (README, "Decision journal"): every decision on a plan is written to the decision
// journal (decision-journal.ts) before anything is done about it — the owner's in the inbox or the
// Linear panel (decideOwner, decidePanel) and the risk policy's before Plannotator is called,
// Plannotator's reports when their event is read. The worker (applyDue) then carries each accepted
// decision out step by step, recording every step, until all of them went through; only then is
// it `applied`. A step that creates something in Linear reserves its id first and looks it up
// before it is ever sent again, so no retry creates a second one.
export class PlannotatorBridge {
  private paseo: PaseoApi | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  // An escalation event waited for its agent's decision during this drain (see `handle`).
  private heldBack = false;
  private stopped = false;
  private journal: DecisionJournal;
  private readonly attempts = new Map<string, number>();
  // A rate-limited event: when it is tried next.
  private readonly retryAt = new Map<string, number>();
  private readonly pausedEvents = new Map<string, string>();
  // Decisions being carried out right now (the sweep and a panel decision never run one twice).
  private readonly applying = new Map<string, Promise<void>>();
  private readonly rechecked = new Map<string, number>();
  private lastPrune = 0;
  // A project's planner runs and their work orders (project-flow.ts).
  private projectPlans: ProjectPlans | null = null;
  // Files an approved plan's follow-ups (plan-follow-ups.ts); its retries run on this bridge's sweep.
  private followUps: Pick<PlanFollowUps, "file" | "retryPending"> | null = null;
  // Reviews already opened on this machine, so a retried event does not open a second tab.
  private readonly shown = new Set<string>();
  // Where the owner's review feedback is kept for the weekly decision candidates (owner-decisions.ts).
  private decisions: Pick<DecisionLog, "append"> | null = null;
  // Model tiers (README, "Model tiers"): approved plans and escalations set the agent's tier.
  private tiers: Tiers | null = null;
  private deletions: Pick<ReviewDeletions, "get" | "forAgent"> | null = null;
  private deliveryFailure: ((event: OpenedEvent, error: unknown, attempts: number) => Promise<void>) | null = null;
  // What became of a review whose decision Plannotator did not confirm (review-outcome.ts);
  // `probe` false: the address serves another review now, only saved outcomes count.
  private outcomes: (review: PendingReview, probe: boolean) => Promise<ReviewOutcome> = (review, probe) => reviewOutcome(review, undefined, probe ? undefined : async () => false);

  constructor(
    private readonly linear: Linear,
    private readonly settings: Pick<Settings, "read">,
    private readonly events = plannotatorPaths().events,
    private readonly sessions?: Sessions,
    private readonly fetchPlan: (localUrl: string) => Promise<string> = readReviewPlan,
    private readonly handover?: Pick<Handover, "update">,
    private readonly setMode: (agentId: string, modeId: string) => Promise<void> = setAgentMode,
    private readonly reviews?: Pick<ReviewLinks, "opened" | "decided" | "described" | "describedFor"> & Partial<Pick<ReviewLinks, "requiresOwner">>,
    private readonly decide: (localUrl: string, approve: boolean, feedback: string) => Promise<void> = decidePlannotatorReview,
    private readonly open: (url: string) => void = openInBrowser,
    private readonly parking?: Parking,
  ) {
    // Next to the events (decision-journal.ts, decisionsDirectory): the plugin passes its own.
    this.journal = new DecisionJournal(join(dirname(events), "decisions"));
  }

  // The plugin's one journal, shared with the review inbox; set before attach.
  useJournal(journal: DecisionJournal): void {
    this.journal = journal;
  }

  get decisionJournal(): DecisionJournal {
    return this.journal;
  }

  useReviewOutcomes(outcomes: (review: PendingReview, probe: boolean) => Promise<ReviewOutcome>): void {
    this.outcomes = outcomes;
  }

  useDeletions(deletions: Pick<ReviewDeletions, "get" | "forAgent">): void {
    this.deletions = deletions;
  }

  observeDeliveryFailures(observer: (event: OpenedEvent, error: unknown, attempts: number) => Promise<void>): void {
    this.deliveryFailure = observer;
  }

  // The browser hook leaves opening the review to the bridge, so an auto-approved plan never opens
  // a tab. A review with a stable link is in the review inbox (and its notification) instead; only
  // one without it opens a tab here, once, after the risk policy has had its say.
  private show(localUrl: string): void {
    if (this.shown.has(localUrl)) return;
    this.shown.add(localUrl);
    this.open(localUrl);
  }

  // The ticket's Linear agent panel for an opened review: review link, plan checklist and
  // Approve / Send back. Returns whether the agent has a session: then the progress comment
  // carries the plan state instead of separate plan comments.
  private async toSession(event: OpenedEvent, review: ReviewGeneration, agentId: string, model: string | null, reviewLink: string | null, planText: string, judgement: Judgement | null): Promise<boolean> {
    const sessions = this.sessions;
    if (!sessions) return false;
    try {
      const link = await sessions.sessionFor(agentId);
      if (!link) return false;
      const steps = planSteps(planText);
      if (steps.length) await sessions.plan(link.sessionId, steps.map((content) => ({ content, status: "pending" as const })));
      // An auto-approved plan is decided already; the journal carries its approval out.
      if (judgement?.approved) { await sessions.say(link.sessionId, "thought", judgement.line); return true; }
      await sessions.expectReview(link.sessionId, event.localUrl, planText, reviewLink, review.id);
      const split = steps.length > 1 ? [{ label: `Approve & split into ${Math.min(steps.length, MAX_SPLIT)} sub-issues`, value: SPLIT_PLAN }] : [];
      await sessions.ask(link.sessionId, `The plan is ready for review${reviewLink ? ` (full view: ${reviewLink})` : ""}. Approve it, or reply with what to change.${judgement ? `\n\n${judgement.line}` : ""}${model ? `\n\nPlanned with ${model}.` : ""}`, [{ label: "Approve plan", value: APPROVE_PLAN }, { label: "Approve, implement later", value: APPROVE_LATER }, ...split, { label: "Send back", value: SEND_BACK }]);
      return true;
    } catch (error) {
      console.error(`[linear-tickets] Plannotator session update for ${agentId} failed: ${message(error)}`);
      return false;
    }
  }

  // Called with every hook's connection: the latest one wins, so a plugin session (which may add
  // chat rows) replaces the plugin's own fallback connection once any hook runs.
  attach(paseo: PaseoApi): void {
    const first = !this.paseo;
    this.paseo = paseo;
    if (!first) return;
    // A cheap directory sweep; fs.watch proved unreliable for files renamed into place.
    this.timer = setInterval(() => { void this.drain(); void this.followUps?.retryPending(); }, SWEEP_MS);
    this.timer.unref?.();
    void this.drain();
  }

  // Graceful stop (plugin reload): nothing new starts, every admitted producer call, intake pass
  // and worker step finishes, and only then does the journal's lease move to the next instance.
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    await this.journal.stop();
    await this.draining?.catch(() => {});
  }

  onProjectPlan(plans: ProjectPlans): void {
    this.projectPlans = plans;
  }

  useFollowUps(followUps: Pick<PlanFollowUps, "file" | "retryPending">): void {
    this.followUps = followUps;
  }

  recordDecisions(log: Pick<DecisionLog, "append">): void {
    this.decisions = log;
  }

  useTiers(tiers: Tiers): void {
    this.tiers = tiers;
  }

  // --- Producers: the journal first --------------------------------------------------------

  // Takes the journal (once this instance holds its lease) and runs one admitted operation.
  private async admitted<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped || !this.paseo) throw new FencedError();
    await this.journal.acquire();
    return this.journal.run(work);
  }

  // The review generation a decision of the owner is on: the one the inbox entry or the panel's
  // stored review names, else (recorded before the journal) the latest on that address.
  private async ownerReview(agentId: string, localUrl: string, origin: { reviewId?: string; openedAt?: string }): Promise<ReviewGeneration> {
    const named = origin.reviewId ? this.journal.review(origin.reviewId) : null;
    if (named) return named;
    const latest = this.journal.latestReview(agentId, { localUrl });
    if (latest) return latest;
    const parked = this.parking ? await this.parking.plans.forAgent(agentId) : null;
    return this.journal.ensureReview({ agentId, localUrl, openedAt: origin.openedAt ?? LEGACY_OPENED_AT, parked: Boolean(parked), legacy: true });
  }

  // The owner's Approve / Send back from the review inbox or the Linear panel: journaled for its
  // exact review, then sent to Plannotator. A refusal voids it (the review stays decidable); a
  // lost answer leaves it uncertain until Plannotator's report, its saved outcome or the owner
  // settles it. The decision is carried out in the background.
  async decideOwner(localUrl: string, approve: boolean, feedback: string, agentId: string, origin: OwnerOrigin): Promise<void> {
    const attempt = await this.admitted(async () => {
      const review = await this.ownerReview(agentId, localUrl, origin);
      const planContent = await this.fetchPlan(localUrl).catch(() => "");
      const attempt = await this.journal.begin({ review, agentId, planContent, approved: approve, ...(feedback ? { feedback } : {}), source: origin.source, state: "deciding", snapshot: await this.snapshot(agentId, review) });
      try {
        await this.decide(localUrl, approve, feedback);
      } catch (error) {
        await this.journal.settle(attempt.id, error instanceof ReviewClosedError && error.outcomeUnknown ? "unknown" : "refused", message(error));
        throw error;
      }
      return this.journal.settle(attempt.id, "accepted");
    });
    if (attempt.state === "pending") void this.apply(attempt.id);
  }

  // "Approve, implement later" and "Approve & split" from the Linear panel: journaled as the
  // owner's approval (closing Plannotator with a send-back), then carried out right away. Null
  // when it went through (the workflow replied in the panel); otherwise the reply to give.
  async decidePanel(link: SessionLink, mode: "later" | "split"): Promise<string | null> {
    const stored = link.review;
    const agentId = link.agentId;
    if (!stored || !agentId) throw new Error("The plan review is no longer open.");
    const planContent = await this.fetchPlan(stored.localUrl);
    if (!planContent.trim()) throw new Error("The plan could not be read from Plannotator.");
    const problem = mode === "split" ? splitProblem(planContent) : null;
    if (problem) throw new Error(problem);
    const attempt = await this.admitted(async () => {
      const review = await this.ownerReview(agentId, stored.localUrl, { reviewId: stored.reviewId, openedAt: stored.openedAt });
      const snapshot = await this.snapshot(agentId, review);
      return this.journal.begin({ review, agentId, planContent, approved: true, transport: false, mode, source: "linear-panel", state: "pending", snapshot: { ...snapshot, route: mode, issueId: link.issueId, identifier: link.identifier, sessionId: link.sessionId } });
    });
    await this.apply(attempt.id);
    const result = this.journal.attempt(attempt.id);
    if (result?.state === "applied") return null;
    return `Approved — being applied: ${result?.lastError ?? "an earlier decision on this ticket is applied first"}. Retried every minute until it goes through.`;
  }

  // A decision taken on Plannotator's own page, found by the session sweep after the review's
  // server is gone (review-outcome.ts): journaled for the session's stored review before the
  // session lets go of it.
  async recovered(agentId: string, stored: PendingReview, outcome: { approved: boolean; feedback?: string; planContent: string }): Promise<void> {
    await this.admitted(async () => {
      const review = await this.ownerReview(agentId, stored.localUrl, { reviewId: stored.reviewId, openedAt: stored.openedAt });
      const reported = await this.journal.report({ event: `recovered-${review.id}`, agentId, approved: outcome.approved, ...(outcome.feedback ? { feedback: outcome.feedback } : {}), planContent: outcome.planContent, at: new Date(this.journal.now()).toISOString(), review, source: "recovered", exact: true, snapshot: () => this.snapshot(agentId, review) });
      if (reported === "conflict") console.error(`[linear-tickets] the saved outcome of ${agentId}'s review contradicts its decision; it waits for the owner under Being applied`);
    });
    void this.drain();
  }

  // The owner settles an entry listed under "Being applied" (review inbox).
  async resolve(entryId: string, action: ResolveAction): Promise<void> {
    await this.admitted(() => this.journal.resolve(entryId, action, (agentId, review) => this.snapshot(agentId, review)));
    void this.drain();
  }

  // How a decision is carried out, fixed when it is accepted: from local state only (the parked
  // record, the agent's labels, the panel session), never Linear.
  private async snapshot(agentId: string, review: ReviewGeneration | null): Promise<RouteSnapshot> {
    const link = this.sessions ? await this.sessions.sessionFor(agentId) : null;
    const sessionId = link?.sessionId ?? null;
    const parked = this.parking ? await this.parking.plans.forAgent(agentId) : null;
    if (parked && (review?.parked ?? true)) {
      return { route: "parked", issueId: parked.issueId, identifier: parked.identifier, sessionId, model: parked.model, parked: { issueId: parked.issueId, identifier: parked.identifier, plan: parked.plan, model: parked.model, parkedAt: parked.parkedAt, reasons: parked.reasons, line: parked.line } };
    }
    if (!this.paseo) throw new FencedError();
    const agent = (await this.paseo.agents.ref(agentId).refresh())?.agent;
    const labels = agent?.labels ?? {};
    const root = !labels["paseo.parent-agent-id"];
    const runId = root ? labels["linear.plannerRun"] : undefined;
    if (runId) return { route: "work-order", issueId: null, identifier: null, sessionId: null, runId };
    const issueId = root ? labels["linear.issueId"] : undefined;
    if (!issueId) return { route: "none", issueId: null, identifier: null, sessionId: null };
    return { route: "live", issueId, identifier: labels["linear.identifier"] || "this ticket", sessionId, model: activeModel(agent), provider: agent?.provider ?? null, planPolicy: labels[PLAN_POLICY_LABEL] ?? null };
  }

  // --- Tiers, escalations, advice ----------------------------------------------------------

  // The ticket's `model:` label follows its tier, so Linear shows (and filters) which tier a ticket
  // runs on; the owner raises it by setting a stronger `model:` label.
  private async labelTier(issueId: string, tier: Tier, current: { id: string; name: string }[]): Promise<void> {
    await this.linear.addLabel(issueId, TIER_LABELS[tier]);
    for (const other of TIERS) if (other !== tier) await this.linear.removeLabel(issueId, TIER_LABELS[other], current);
  }

  // An approved plan's tier (README, "Model tiers"): the stronger of the plan's `## Model` section
  // and the ticket's label, recorded for this agent (a step that is retried until it went
  // through) and applied by the model guard right away. The label, switch and note are best
  // effort: a failure leaves the agent on the launch model, the safe side. A plan that names no
  // tier (its review text could not be checked) sends the agent back to planning for it.
  private async applyPlanTier(attempt: DecisionAttempt, steps: WorkerSteps, settings: PluginSettings): Promise<void> {
    const tiers = this.tiers;
    const provider = attempt.provider;
    if (!tiers || !attempt.issueId) return;
    const issue = { id: attempt.issueId, identifier: attempt.identifier ?? attempt.issueId };
    const sessionId = attempt.sessionId;
    const recorded = await steps.once("tier-record", async () => {
      const state = await this.linear.issueState(issue.id);
      const planned = planTier(attempt.planContent);
      const tier = strongerTier(labelTier(state.labels), planned?.tier);
      if (!tier) {
        await tiers.replan({ id: attempt.agentId, issueId: issue.id, identifier: issue.identifier }, `The approved plan for ${issue.identifier} has no \`## Model\` section, so it does not say which model implements it. You are back in planning for that section only: do not change code yet. Submit the approved plan unchanged with the \`## Model\` section added; when nothing else changed, the plugin approves it without the owner.\n\n${modelSteps()}`);
        console.log(`[linear-tickets] ${issue.identifier}: the approved plan names no model tier, its agent plans again for it`);
        return { tier: null };
      }
      const reason = tier === planned?.tier ? planned.reason || "the approved plan" : "raised by the ticket's model label";
      const launch = provider ? settings.launchPreferences[provider] : undefined;
      const model = provider && launch ? tierModel(settings, provider, tier, { provider: launch.model }).provider : null;
      await tiers.store.record(issue, { tier, source: "plan", reason, agentId: attempt.agentId, model });
      console.log(`[linear-tickets] ${issue.identifier}: implementing on the ${tier} tier (${reason})`);
      return { tier, reason, model, labels: state.labels };
    }) as { tier: Tier | null; reason?: string; model?: string | null; labels?: { id: string; name: string }[] };
    const tier = recorded.tier;
    if (!tier) {
      if (sessionId) await steps.optional("tier-note", () => this.sessions!.say(sessionId, "thought", "The approved plan names no model tier: back to planning to add its `## Model` section."));
      return;
    }
    if (settings.writeback.status) await steps.optional("tier-label", () => this.labelTier(issue.id, tier, recorded.labels ?? []));
    await steps.optional("tier-switch", () => tiers.apply(attempt.agentId));
    if (sessionId) await steps.optional("tier-note", () => this.sessions!.say(sessionId, "thought", `Implementing on the ${tier} model tier${recorded.model ? ` (${recorded.model})` : ""}: ${recorded.reason}.`));
  }

  // The ticket agent asked for the strong tier (escalate_model). The record comes first: it is what
  // the model guard enforces; the label, switch and note are best-effort so a retry never records twice.
  private async escalate(event: EscalatedEvent, agentId: string, paseo: PaseoApi): Promise<void> {
    const tiers = this.tiers;
    if (!tiers) return;
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    const issueId = agent?.labels["paseo.parent-agent-id"] ? undefined : agent?.labels["linear.issueId"];
    if (!agent || !issueId) return;
    const issue = { id: issueId, identifier: agent.labels["linear.identifier"] || issueId };
    const settings = await this.settings.read();
    const from = activeModel(agent);
    await tiers.store.record(issue, { tier: "strong", source: "escalated", reason: event.reason, agentId, model: settings.launchPreferences[agent.provider]?.model ?? null });
    const quietly = (what: string) => (error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: ${what} after the escalation failed: ${message(error)}`);
    if (settings.writeback.status) await this.linear.issueState(issueId).then((state) => this.labelTier(issueId, "strong", state.labels)).catch(quietly("updating the model label"));
    await tiers.apply(agentId).catch(quietly("switching the model"));
    const note = `Escalated to the strong model tier${from ? ` from ${from}` : ""}: ${event.reason}`;
    const link = await this.sessions?.sessionFor(agentId).catch(() => null);
    await (link ? this.sessions!.say(link.sessionId, "thought", note) : this.linear.comment(issueId, `⬆️ **${note}**`)).catch(quietly("telling the owner"));
    console.log(`[linear-tickets] ${issue.identifier}: ${note}`);
  }

  // The plan document is replaced every round, so the log is where each round's feedback stays.
  // One entry per decision (its time is its id), however often the step is tried.
  private async logFeedback(agentId: string, event: DecidedEvent, issue: { id: string; identifier: string }): Promise<void> {
    const entry = feedbackEntry(agentId, event, issue);
    const log = this.decisions;
    if (entry && log) await logQuietly(() => log.append(entry), `plan feedback on ${issue.identifier}`);
  }

  // The advisor verdict the omp extension recorded last for the agent, with the hash of that plan
  // text. On disk next to the events: a plugin reload between the planner's record and its
  // hand-off must not send the plan to the owner as unreviewed.
  private adviceFile(agentId: string): string {
    return join(dirname(this.events), "advised", `${agentId.replace(/[^0-9A-Za-z-]/g, "")}.json`);
  }

  private async advice(agentId: string): Promise<Advice | null> {
    const value: unknown = await readFile(this.adviceFile(agentId), "utf8").then((text) => JSON.parse(text), () => null);
    if (!value || typeof value !== "object") return null;
    const { verdict, hash } = value as Record<string, unknown>;
    return typeof verdict === "string" && typeof hash === "string" ? { verdict, hash } : null;
  }

  private async remember(agentId: string, advice: Advice): Promise<void> {
    const path = this.adviceFile(agentId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(advice), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  // What the risk policy needs to know about the ticket besides the plan.
  private async reviewFacts(state: IssueState, verdict: string | null, settings: PluginSettings): Promise<ReviewFacts> {
    return {
      verdict,
      untrusted: isUntrusted(state, await this.linear.viewerId(), await this.linear.appUserId()),
      attended: hasLabel(state.labels, dispatchLabels(settings.dispatch.label).attended.toLowerCase()),
    };
  }

  // The risk policy (README, "Plan risk and auto-approval"): approves the plan on the owner's
  // behalf when its `## Risk and impact` rating is within the threshold, the advisor review the
  // extension recorded is for exactly this text, and nothing about the ticket needs the owner.
  // A plan that came back only for its `## Model` section (README, "Model tiers") keeps the
  // approval it had when nothing else changed. A planner run's work order never comes here
  // (deliverWorkOrder). The approval is journaled before Plannotator is told.
  // null: the plan has no readable rating.
  private async judge(review: ReviewGeneration, localUrl: string, agentId: string, issueId: string, planText: string, settings: PluginSettings): Promise<Judgement | null> {
    // A replayed `opened` event: the review's decision is in the journal already.
    const decided = this.journal.attempts(review.id).find((attempt) => attempt.state !== "void");
    if (decided) return { approved: decided.approved, line: decided.approved ? "Approved; the decision is being applied." : "Sent back; the decision is being applied.", reasons: [] };
    if (await this.reviews?.requiresOwner?.(issueId)) return { approved: false, line: "Rechecked plans require your review; automatic approval is disabled.", reasons: ["you requested a fresh review of this plan"] };
    const rated = parsePlanRisk(planText);
    const rating = "problem" in rated ? "" : `Risk: ${ratingText(rated.risk)}.`;
    try {
      const state = await this.linear.issueState(issueId);
      const approvedBefore = await this.linear.issueDocument(issueId, `Plan: ${state.identifier}`).catch(() => null);
      const tierOnly = approvedBefore ? onlyTierAdded(approvedBefore.content, planText) : false;
      if (!tierOnly && "problem" in rated) return null;
      const advice = await this.advice(agentId);
      const outcome = tierOnly || "problem" in rated ? { approve: tierOnly, reasons: [] } : autoApproval(rated.risk, settings.autoApprove, await this.reviewFacts(state, advice && advice.hash === planHash(planText) ? advice.verdict : null, settings));
      if (!outcome.approve) return { approved: false, line: `${rating} Needs your approval: ${outcome.reasons.join("; ")}.`, reasons: outcome.reasons };
      const feedback = tierOnly ? "Approved again: the owner approved this plan before; only its model tier was added." : `Auto-approved by the risk policy. ${rating}`;
      const attempt = await this.journal.begin({ review, agentId, planContent: planText, approved: true, feedback, source: "risk-policy", state: "deciding", snapshot: await this.snapshot(agentId, review) });
      const line = tierOnly ? `Approved without you: the plan you approved, with its model tier added. ${rating}`.trim() : `Auto-approved within your threshold. ${rating}`;
      try {
        await this.decide(localUrl, true, feedback);
      } catch (error) {
        const unknown = error instanceof ReviewClosedError && error.outcomeUnknown;
        await this.journal.settle(attempt.id, unknown ? "unknown" : "refused", message(error));
        // Plannotator may have taken it: the decision is neither parked nor waiting until it confirms.
        if (unknown) return { approved: true, line: `${line} Plannotator did not confirm it yet.`, reasons: [] };
        throw error;
      }
      await this.journal.settle(attempt.id, "accepted");
      return { approved: true, line, reasons: [] };
    } catch (error) {
      if (error instanceof FencedError) throw error;
      console.error(`[linear-tickets] auto-approval check for ${agentId} failed: ${message(error)}`);
      return { approved: false, line: [rating, "The auto-approval check failed, so it needs your approval."].filter(Boolean).join(" "), reasons: ["the auto-approval check failed"] };
    }
  }

  // A parked plan whose advisor review was recorded after it was parked (README, "Parked plans"):
  // its planner, resumed for that, recorded the review for exactly the parked text. The plan is
  // judged again: within the threshold it is approved like the owner's approval on the central
  // host (journaled first); otherwise it stays parked with the new reasons. The planner is
  // retired again either way.
  private async rejudgeParked(parked: ParkedPlan, verdict: string, paseo: PaseoApi): Promise<void> {
    if (await this.reviews?.requiresOwner?.(parked.issueId)) return;
    const rated = parsePlanRisk(parked.plan);
    if ("problem" in rated) return;
    const settings = await this.settings.read();
    const outcome = autoApproval(rated.risk, settings.autoApprove, await this.reviewFacts(await this.linear.issueState(parked.issueId), verdict, settings));
    const rating = `Risk: ${ratingText(rated.risk)}.`;
    if (outcome.approve) {
      const hosted = this.journal.latestReview(parked.agentId, { parked: true });
      const review = hosted && hosted.openedAt >= parked.parkedAt ? hosted : await this.journal.ensureReview({ agentId: parked.agentId, localUrl: `parked:${parked.issueId}`, openedAt: parked.parkedAt, parked: true, planHash: planHash(parked.plan), legacy: true });
      try {
        await this.journal.begin({ review, agentId: parked.agentId, planContent: parked.plan, approved: true, feedback: `Auto-approved by the risk policy. ${rating}`, source: "risk-policy", state: "pending", snapshot: await this.snapshot(parked.agentId, review) });
        console.log(`[linear-tickets] ${parked.identifier}: parked plan auto-approved once its advisor review was recorded (${rating})`);
      } catch (error) {
        // The owner decided it meanwhile: theirs stands.
        if (!(error instanceof DecisionPendingError)) throw error;
      }
    }
    await this.parking!.retire(null, parked.agentId, paseo, "The plan stays parked for the owner: stop now and do not implement anything.");
    if (outcome.approve) return;
    await this.parking!.plans.put({ ...parked, line: `${rating} Needs your approval: ${outcome.reasons.join("; ")}.`, reasons: outcome.reasons });
    await this.reviews?.describedFor(parked.agentId, parked.plan, { approved: false, reasons: outcome.reasons })
      .catch((error: unknown) => console.error(`[linear-tickets] inbox details for ${parked.identifier} skipped: ${message(error)}`));
    console.log(`[linear-tickets] ${parked.identifier}: parked plan judged again with its advisor review, still for the owner (${outcome.reasons.join("; ")})`);
  }

  // --- Intake ------------------------------------------------------------------------------

  // One sweep: every event file in write order (an `opened` written before a report is known when
  // the report binds), then every due decision. Runs only while this instance holds the journal.
  async drain(): Promise<void> {
    if (this.draining) { this.again = true; return this.draining; }
    this.draining = (async () => {
      if (!this.paseo || this.stopped) return;
      if (!await this.journal.acquire()) return;
      do {
        this.again = false;
        try {
          await this.journal.run(() => this.intake());
        } catch (error) {
          if (error instanceof FencedError) return;
          throw error;
        }
      } while (this.again);
      await this.applyDue();
      // Escalations held back behind a decision of their agent that was still being applied.
      if (this.heldBack) {
        this.heldBack = false;
        await this.journal.run(() => this.intake()).catch((error: unknown) => { if (!(error instanceof FencedError)) throw error; });
      }
      if (this.journal.now() - this.lastPrune > PRUNE_MS) {
        this.lastPrune = this.journal.now();
        await this.journal.run(() => this.journal.prune()).catch((error: unknown) => {
          if (!(error instanceof FencedError)) console.error(`[linear-tickets] pruning the decision journal failed: ${message(error)}`);
        });
      }
    })();
    try { await this.draining; } finally { this.draining = null; }
  }

  private async intake(): Promise<void> {
    const names = (await readdir(this.events).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
    for (const name of names) {
      if (!this.journal.active) return;
      await this.handle(name);
    }
  }

  private async handle(name: string): Promise<void> {
    const path = join(this.events, name);
    const paseo = this.paseo;
    if (!paseo) return;
    let event: PlannotatorEvent | null = null;
    try {
      event = parseEvent(await readFile(path, "utf8"));
      // The review generation exists before anything else of its review happens, also while a
      // rate limit pauses the rest of its hand-off.
      const review = event?.type === "opened" && event.agentId ? await this.openedReview(event, event.agentId, name) : null;
      if ((this.retryAt.get(name) ?? 0) > Date.now()) return;
      if (event?.agentId) {
        // The tier an approved plan records must never land after a later escalation's: an
        // escalation waits until its agent's accepted decisions are carried out.
        if (event.type === "escalated" && this.journal.attempts().some((attempt) => attempt.agentId === event!.agentId && (attempt.state === "deciding" || attempt.state === "pending"))) {
          this.heldBack = true;
          return;
        }
        const recorded = await this.deletions?.forAgent(event.agentId);
        const issueId = recorded?.issueId ?? (await paseo.agents.ref(event.agentId).refresh())?.agent.labels?.["linear.issueId"];
        const deletion = recorded ?? (issueId ? await this.deletions?.get(issueId) : null);
        if (deletion?.phase === "pending") return;
        if (!deletion) await this.deliver(event, event.agentId, paseo, name, review);
      }
      else if (event?.type === "opened") this.show(event.localUrl);
      // A decision's event file goes only once the journal has it.
      await rm(path, { force: true });
      this.attempts.delete(name);
      this.retryAt.delete(name);
      this.pausedEvents.delete(name);
    } catch (error) {
      if (error instanceof FencedError) return;
      if (error instanceof RateLimitedError) {
        const pause = `${error.pool}:${error.reason}:${error.resumeAt}`;
        if (this.pausedEvents.get(name) !== pause) console.error(`[linear-tickets] Plannotator event ${name} paused: ${error.message}`);
        this.pausedEvents.set(name, pause);
        this.retryAt.set(name, error.resumeAt);
        return;
      }
      this.pausedEvents.delete(name);
      const tries = (this.attempts.get(name) ?? 0) + 1;
      this.attempts.set(name, tries);
      // A decision is never given up: its event stays until the journal has it.
      if (event?.type === "decided") {
        if (tries === 1 || tries % MAX_ATTEMPTS === 0) console.error(`[linear-tickets] Plannotator decision ${name} could not be journaled yet (attempt ${tries}): ${message(error)}`);
        return;
      }
      console.error(`[linear-tickets] Plannotator event ${name} failed (attempt ${tries}): ${message(error)}`);
      if (event?.type === "opened" && this.deliveryFailure) {
        await this.deliveryFailure(event, error, tries).catch(() => {
          console.error("[linear-tickets] could not record the plan delivery failure");
        });
      }
      if (tries < MAX_ATTEMPTS) return;
      // Given up: the review still opens, so it is not lost.
      if (event?.type === "opened") this.show(event.localUrl);
      await rm(path, { force: true });
      this.attempts.delete(name);
      this.retryAt.delete(name);
    }
  }

  // The journal's review generation for an `opened` event: its address and opening time.
  private async openedReview(event: OpenedEvent, agentId: string, name: string): Promise<ReviewGeneration> {
    const parked = this.parking ? await this.parking.plans.forAgent(agentId) : null;
    return this.journal.ensureReview({ agentId, localUrl: event.localUrl, openedAt: event.at, parked: Boolean(parked), event: name, ...(parked ? { planHash: planHash(parked.plan) } : {}) });
  }

  private async deliver(event: PlannotatorEvent, agentId: string, paseo: PaseoApi, name: string, review: ReviewGeneration | null): Promise<void> {
    if (event.type === "decided") return this.intakeDecision(event, agentId, name);
    if (event.type === "opened") return withPriority("owner", "plan review", () => this.deliverOpened(event, agentId, paseo, review!));
    if (event.type === "advised") {
      await this.remember(agentId, { verdict: event.verdict, hash: event.hash });
      const parked = await this.parking?.plans.forAgent(agentId);
      if (parked && planHash(parked.plan) === event.hash) await this.rejudgeParked(parked, event.verdict, paseo);
      return;
    }
    return this.escalate(event, agentId, paseo);
  }

  // A `decided` report (Plannotator's omp extension, the central host, an event left by an older
  // version) bound to its review generation and journaled (decision-journal.ts, `report`).
  private async intakeDecision(event: DecidedEvent, agentId: string, name: string): Promise<void> {
    const parked = this.parking ? await this.parking.plans.forAgent(agentId) : null;
    // The retired agent's own report of its closed review: the plugin closed it when it parked the plan.
    if (!parked || event.parked) {
      const review = await this.reportedReview(event, agentId, name, parked);
      const outcome = await this.journal.report({
        event: name, agentId, approved: event.approved, ...(event.feedback ? { feedback: event.feedback } : {}),
        ...(event.planContent ?? (event.parked ? parked?.plan : undefined) ? { planContent: event.planContent ?? parked?.plan } : {}),
        at: event.at, review, source: event.parked ? "parked-page" : "plannotator-page", exact: Boolean(event.parked),
        snapshot: () => this.snapshot(agentId, review),
      });
      if (outcome === "unbound") console.error(`[linear-tickets] a Plannotator decision for ${agentId} does not match its review's plan; it waits for the owner under Being applied`);
      if (outcome === "conflict") console.error(`[linear-tickets] Plannotator reported the other decision for ${agentId}'s review; it waits for the owner under Being applied`);
    }
    // A decided review's verdict is spent: the next round records its own.
    await rm(this.adviceFile(agentId), { force: true });
  }

  // The central host names its review (address and start time); the omp extension's report binds
  // to the agent's latest own review opened before it (an agent has one plan review at a time).
  private async reportedReview(event: DecidedEvent, agentId: string, name: string, parked: ParkedPlan | null): Promise<ReviewGeneration> {
    if (event.review) {
      const served = this.journal.reviewServedSince(agentId, event.review.localUrl, event.review.servedAt);
      if (served) return served;
      return this.journal.ensureReview({ agentId, localUrl: event.review.localUrl, openedAt: event.review.servedAt, parked: true, legacy: true });
    }
    if (event.parked) {
      const hosted = this.journal.latestReview(agentId, { before: name, parked: true });
      if (hosted && (!parked || hosted.openedAt >= parked.parkedAt)) return hosted;
      return this.journal.ensureReview({ agentId, localUrl: `parked:${parked?.issueId ?? agentId}`, openedAt: parked?.parkedAt ?? LEGACY_OPENED_AT, parked: true, legacy: true });
    }
    return this.journal.latestReview(agentId, { before: name, parked: false })
      ?? this.journal.ensureReview({ agentId, localUrl: "legacy", openedAt: LEGACY_OPENED_AT, legacy: true });
  }

  private async deliverOpened(event: OpenedEvent, agentId: string, paseo: PaseoApi, review: ReviewGeneration): Promise<void> {
    const parked = this.parking ? await this.parking.plans.forAgent(agentId) : null;
    if (parked) return this.deliverParked(event, parked, review);
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    const labels = refreshed?.agent.labels ?? {};
    const model = activeModel(refreshed?.agent);
    // A planner run's agent (README, "Projects"): no Linear ticket, and its plan is a work order.
    const runId = labels["paseo.parent-agent-id"] ? undefined : labels["linear.plannerRun"];
    if (runId) {
      if (!this.projectPlans || !await this.projectPlans.isPlannerRun(runId)) {
        const reason = "This planner run is no longer open. Ignore this work order and stop.";
        await this.journal.addClosing(review, true, reason);
        await this.decide(event.localUrl, true, reason);
        console.log(`[linear-tickets] the obsolete planner run ${runId.slice(0, 8)} report was ignored`);
        return;
      }
      return this.deliverWorkOrder(event, review, agentId, runId, `planner run ${runId.slice(0, 8)}`, paseo);
    }
    const issueId = labels["paseo.parent-agent-id"] ? undefined : labels["linear.issueId"];
    const identifier = labels["linear.identifier"] || "this ticket";
    const planText = await this.fetchPlan(event.localUrl).catch(() => "");
    // The plan text tells a report on this review from one on another (decision-journal.ts, `unbound`).
    if (planText.trim()) review = await this.journal.ensureReview({ agentId, localUrl: event.localUrl, openedAt: event.at, planHash: planHash(planText) });
    // A ticket plan without a complete `## Model` section (README, "Model tiers") goes back to its
    // planner before anyone reviews it; it never reaches the owner or a default tier. The closing
    // is journaled first, so its report is never taken as the owner's send-back.
    if (issueId) {
      const problem = planText.trim() ? modelProblem(planText) : null;
      if (problem) {
        const reason = `Paseo sent this plan back before review. ${problem}\n\nAdd or fix the section and submit the plan again.`;
        await this.journal.addClosing(review, false, reason);
        await this.decide(event.localUrl, false, reason);
        console.log(`[linear-tickets] ${identifier}: plan sent back to the planner: its model tier is missing or not allowed`);
        return;
      }
    }
    // The agent's stable link when ReviewLinks is up; otherwise this review's own tailnet or local URL.
    const stableLink = await this.reviews?.opened(agentId, event, { identifier: labels["linear.identifier"] || undefined, ...(issueId ? { issueId } : {}), model, reviewId: review.id }) ?? null;
    const url = stableLink ?? event.remoteUrl ?? event.localUrl;
    const settings = await this.settings.read();
    const judgement = issueId ? await this.judge(review, event.localUrl, agentId, issueId, planText, settings) : null;
    if (issueId && !judgement?.approved && planText.trim() && this.parking?.available()) {
      await this.park(event, review, { issueId, identifier, agentId, plan: planText, line: judgement?.line ?? "The plan has no readable risk rating, so it needs your approval.", reasons: judgement?.reasons ?? ["no readable risk rating"], model, parkedAt: new Date().toISOString(), announced: false }, paseo);
      return;
    }
    // The inbox's details are a convenience: a failure must not retry (and repeat) the hand-off.
    await this.reviews?.described(event.localUrl, planText, judgement)
      .catch((error: unknown) => console.error(`[linear-tickets] inbox details for ${agentId} skipped: ${message(error)}`));
    if (!judgement?.approved && !stableLink) this.show(event.localUrl);
    const row: PlannotatorRow = { title: judgement?.approved ? "Plan auto-approved by the risk policy" : "Handed off to Plannotator for review", url, detail: `${event.remoteUrl ? "Opens on any device in your tailnet." : "Local link only: Tailscale was unavailable."}${model ? ` Planned with ${model}.` : ""}${judgement ? ` ${judgement.line}` : ""}` };
    // Only a plugin session may append chat rows; the plugin's own fallback connection is not one.
    // The row is a convenience, so Linear still gets the review either way.
    await handle.timeline.append({ type: "plugin", id: `plannotator-opened-${event.at.replace(/[^0-9A-Za-z]/g, "")}`, kind: PLANNOTATOR_KIND, version: 1, data: row })
      .catch((error: unknown) => console.error(`[linear-tickets] Plannotator chat row for ${agentId} skipped: ${message(error)}`));
    // Tailnet links only: a local-only review has no link worth showing off this machine.
    const inSession = await this.toSession(event, review, agentId, model, event.remoteUrl ? url : null, planText, judgement);
    if (!issueId) return;
    // Planning while a plan is out for review; a new review round removes plan-ready.
    if (settings.writeback.status) {
      const moved = await this.linear.moveToStateNamed(issueId, PLANNING_STATE);
      if (moved.note) console.error(`[linear-tickets] ${identifier}: ${moved.note}`);
      await this.linear.removeLabel(issueId, PLAN_READY_LABEL);
    }
    // With a session the panel shows the review, so the progress comment records it instead of new comments.
    if (inSession && this.handover && refreshed?.agent) {
      await this.handover.update({ id: issueId, identifier }, { id: agentId, title: refreshed.agent.title ?? null, cwd: refreshed.agent.cwd }, { plan: judgement ? `${judgement.approved ? "auto-approved" : "under review"} — ${judgement.line}` : "under review", link: ["Plan review", url], model });
      return;
    }
    const risk = judgement ? `\n\n${judgement.line}` : "";
    await this.linear.comment(issueId, judgement?.approved
      ? `🤖 **Plan auto-approved** by the risk policy${model ? ` (planned with \`${model}\`)` : ""}: ${url}${risk}`
      : `📋 **Plan ready for review in Plannotator**${model ? ` (planned with \`${model}\`)` : ""}: ${url}${event.remoteUrl ? "" : "\n\n(Local link only: Tailscale was unavailable on the host.)"}${risk}`);
  }

  // Parks a plan the owner has to decide (README, "Parked plans"). The record comes first, then
  // the closing of the agent's own review (so its report is a confirmation, never a decision);
  // then the agent is retired, freeing its slot. The central host serves the plan, and its
  // `opened` event tells the owner (deliverParked).
  private async park(event: OpenedEvent, review: ReviewGeneration, plan: ParkedPlan, paseo: PaseoApi): Promise<void> {
    const reason = "The owner has to decide this plan. It is parked in the central Plannotator host and you are being closed to free your slot: stop now and do not implement anything. A new agent continues once the owner decides.";
    await this.parking!.plans.put(plan);
    await this.sessions?.parked(plan.agentId);
    await this.journal.addClosing(review, false, reason);
    await this.parking!.retire(event.localUrl, plan.agentId, paseo, reason);
    if ((await this.settings.read()).writeback.status) {
      const moved = await this.linear.moveToStateNamed(plan.issueId, PLANNING_STATE);
      if (moved.note) console.error(`[linear-tickets] ${plan.identifier}: ${moved.note}`);
      await this.linear.removeLabel(plan.issueId, PLAN_READY_LABEL);
    }
    console.log(`[linear-tickets] ${plan.identifier}: plan parked for the owner (${plan.reasons.join("; ")})`);
  }

  // A planner run's work order needs nobody (README, "Projects"): it only orders the project's
  // tickets, each of which plans on its own. It is approved as soon as it is submitted, with no
  // risk check or Linear read that could fail and send it to the owner, and the project flow writes
  // it into Linear, retrying on later reads. Nothing of a ticket approval (state, plan-ready, a new
  // agent) applies to it. One whose order cannot be read line by line is sent back to the planner
  // instead, so a broken block never closes as an empty order. A plan that cannot be read is
  // retried and, after that, opens for the owner like any review; their approval is journaled and
  // carried out like any decision (applyWorkOrder).
  private async deliverWorkOrder(event: OpenedEvent, review: ReviewGeneration, agentId: string, runId: string, name: string, paseo: PaseoApi): Promise<void> {
    const settings = await this.settings.read();
    const plan = await this.fetchPlan(event.localUrl);
    if (!plan.trim()) throw new Error(`the work order of ${name} could not be read from Plannotator`);
    const problems = orderProblems(plan);
    if (problems.length) {
      const reason = [
        "Paseo cannot apply this work order as written:",
        problems.map((problem) => `- ${problem}`).join("\n"),
        "The `## Work order` section needs one fenced ```project-order block with one change per line: `TUC-1 blocks TUC-2`, `hold TUC-3: reason`, `release TUC-4`, `attended TUC-5: reason` or `unattended TUC-6`. A reason goes after a colon. An empty block means no changes. Fix the block and submit the plan again.",
      ].join("\n\n");
      await this.journal.addClosing(review, false, reason);
      await this.decide(event.localUrl, false, reason);
      console.log(`[linear-tickets] ${name}: work order sent back to the planner: ${problems.join("; ")}`);
      return;
    }
    // The plugin approves it: the extension's report of that approval is a confirmation.
    const reason = "Work order approved automatically: it only orders the project's tickets, each of which plans on its own. Paseo writes it into Linear; stop now.";
    await this.journal.addClosing(review, true, reason);
    await this.decide(event.localUrl, true, reason)
      .catch((error: unknown) => console.error(`[linear-tickets] ${name}: closing the work order's review failed: ${message(error)}`));
    await this.applyWorkOrder(runId, agentId, name, plan, paseo, settings);
  }

  private async applyWorkOrder(runId: string, agentId: string, name: string, plan: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.projectPlans && await this.projectPlans.applyPlan(runId, agentId, plan, paseo, settings)) return;
    console.error(`[linear-tickets] ${name}: the work order was not written: the planner run is no longer open`);
  }

  // A parked plan's `opened` event, from the central host: it binds the stable link, inbox and
  // panel to the host's review (and tells the owner the first time). The owner's decision on it
  // is journaled like any other and carried out on the parked route.
  private async deliverParked(event: OpenedEvent, parked: ParkedPlan, review: ReviewGeneration): Promise<void> {
    const stableLink = await this.reviews?.opened(parked.agentId, event, { identifier: parked.identifier, issueId: parked.issueId, since: parked.parkedAt, model: parked.model, reviewId: review.id }) ?? null;
    const url = stableLink ?? event.remoteUrl ?? event.localUrl;
    await this.reviews?.described(event.localUrl, parked.plan, { approved: false, reasons: parked.reasons })
      .catch((error: unknown) => console.error(`[linear-tickets] inbox details for ${parked.identifier} skipped: ${message(error)}`));
    const reviewLink = event.remoteUrl ? url : null;
    const link = await this.sessions?.sessionFor(parked.agentId) ?? null;
    if (link) await this.sessions!.expectReview(link.sessionId, event.localUrl, parked.plan, reviewLink, review.id);
    if (parked.announced) return;
    if (!stableLink) this.show(event.localUrl);
    const model = parked.model ? `\n\nPlanned with ${parked.model}.` : "";
    if (link) {
      const steps = planSteps(parked.plan);
      if (steps.length) await this.sessions!.plan(link.sessionId, steps.map((content) => ({ content, status: "pending" as const })));
      const split = steps.length > 1 ? [{ label: `Approve & split into ${Math.min(steps.length, MAX_SPLIT)} sub-issues`, value: SPLIT_PLAN }] : [];
      await this.sessions!.ask(link.sessionId, `The plan waits for your review${reviewLink ? ` (full view: ${reviewLink})` : ""}. Its agent was closed to free the slot; a new one starts once you decide. Approve it, or reply with what to change.\n\n${parked.line}${model}`, [{ label: "Approve plan", value: APPROVE_PLAN }, { label: "Approve, implement later", value: APPROVE_LATER }, ...split, { label: "Send back", value: SEND_BACK }]);
    } else {
      await this.linear.comment(parked.issueId, `📋 **Plan waiting for your review in Plannotator**: ${url}${event.remoteUrl ? "" : "\n\n(Local link only: Tailscale was unavailable on the host.)"}\n\n${parked.line}\n\nIts agent was closed to free the slot. Assign Paseo again once you have decided.${model}`);
    }
    await this.parking!.plans.put({ ...parked, announced: true });
  }

  // --- The worker --------------------------------------------------------------------------

  // Every accepted decision that is due, first in its ticket's order; every uncertain one is asked
  // about again.
  private async applyDue(): Promise<void> {
    if (!this.journal.active) return;
    const { pending, uncertain } = this.journal.due();
    for (const attempt of uncertain) await this.recheck(attempt);
    for (const attempt of pending) await this.apply(attempt.id);
  }

  // A ticket's decisions are applied in the order they were accepted, so an earlier decision's
  // state, label or document never lands after a later one's.
  private waitsForEarlier(attempt: DecisionAttempt): boolean {
    const key = (entry: DecisionAttempt) => entry.issueId ?? `agent:${entry.agentId}`;
    const order = (entry: DecisionAttempt) => `${entry.acceptedAt ?? entry.at}\n${entry.id}`;
    return this.journal.attempts().some((other) => other.id !== attempt.id && other.state === "pending" && key(other) === key(attempt) && order(other) < order(attempt));
  }

  // An attempt already being carried out is joined, not skipped: whoever asks returns once it is done.
  private apply(id: string): Promise<void> {
    const running = this.applying.get(id);
    if (running) return running;
    const attempt = this.journal.attempt(id);
    if (!attempt || attempt.state !== "pending" || attempt.pausedBy || this.waitsForEarlier(attempt)) return Promise.resolve();
    const work = this.carryOutRecorded(attempt).finally(() => this.applying.delete(id));
    this.applying.set(id, work);
    return work;
  }

  private async carryOutRecorded(attempt: DecisionAttempt): Promise<void> {
    try {
      await this.journal.run(async () => {
        try {
          await withPriority("owner", "plan decision", () => this.carryOut(attempt));
          await this.journal.applied(attempt);
        } catch (error) {
          if (error instanceof FencedError) return;
          if (error instanceof DeletedError) { await this.journal.abandon(attempt, "The ticket was deleted."); return; }
          if (error instanceof WaitError) { await this.journal.later(attempt, this.journal.now() + SWEEP_MS, error.message); return; }
          if (error instanceof RateLimitedError) { await this.journal.later(attempt, error.resumeAt, error.message); return; }
          const failed = await this.journal.failed(attempt, error);
          console.error(`[linear-tickets] applying the plan decision for ${attempt.identifier ?? attempt.agentId} failed (try ${failed.attempts}): ${message(error)}`);
        }
      });
    } catch (error) {
      if (!(error instanceof FencedError)) console.error(`[linear-tickets] the plan decision ${attempt.id} could not be recorded: ${message(error)}`);
    }
  }

  // The step guard (split.ts, Steps): a recorded step is skipped; no step starts once the plugin
  // is stopping; a create reserves its Linear id and is looked up by it before it is sent again.
  private steps(id: string): WorkerSteps {
    const journal = this.journal;
    const current = () => journal.attempt(id)!;
    const starting = () => { if (journal.closing) throw new FencedError(); };
    return {
      once: async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        const done = current().steps;
        if (name in done) return done[name] as T;
        starting();
        const value = await work();
        await journal.step(current(), name, value === undefined ? true : value);
        return value;
      },
      created: async (name, lookup, create) => {
        const done = current().steps;
        if (name in done) return;
        starting();
        const reserved = done[`${name}:id`];
        if (typeof reserved === "string" && await lookup(reserved)) { await journal.step(current(), name, reserved); return; }
        const reservation = typeof reserved === "string" ? reserved : randomUUID();
        if (reservation !== reserved) await journal.step(current(), `${name}:id`, reservation);
        await create(reservation);
        await journal.step(current(), name, reservation);
      },
      value: <T>(name: string) => current().steps[name] as T | undefined,
      // Cosmetic steps: best effort, recorded as done either way.
      optional: async (name, work) => {
        if (name in current().steps) return;
        starting();
        let failure: string | null = null;
        try { await work(); } catch (error) {
          if (error instanceof FencedError) throw error;
          failure = message(error);
          console.error(`[linear-tickets] ${current().identifier ?? current().agentId}: ${name} skipped: ${failure}`);
        }
        await journal.step(current(), name, failure ? { skipped: failure.slice(0, 300) } : true);
      },
    };
  }

  private eventOf(attempt: DecisionAttempt, plan?: string): DecidedEvent {
    return { type: "decided", agentId: attempt.agentId, approved: attempt.approved, ...(attempt.feedback ? { feedback: attempt.feedback } : {}), planContent: attempt.planContent || plan || "", at: attempt.at };
  }

  private async carryOut(attempt: DecisionAttempt): Promise<void> {
    const deletion = await this.deletions?.forAgent(attempt.agentId) ?? (attempt.issueId ? await this.deletions?.get(attempt.issueId) : null);
    if (deletion?.phase === "pending") throw new WaitError("The ticket is being deleted.");
    if (deletion) throw new DeletedError();
    const steps = this.steps(attempt.id);
    if (attempt.route === "parked") await this.applyParked(attempt, steps);
    else if (attempt.route === "live") await this.applyLive(attempt, steps);
    else if (attempt.route === "work-order") { await this.applyOrder(attempt, steps); return; }
    else if (attempt.route === "later" || attempt.route === "split") await this.applyPanel(attempt, steps);
    else await this.applyNone(attempt, steps);
    // The inbox lists the review decided only now.
    const review = this.journal.review(attempt.reviewId);
    if (review && this.reviews) await steps.once("inbox", () => this.reviews!.decided(attempt.agentId, attempt.approved, { localUrl: review.localUrl, at: attempt.at }));
  }

  // The agent's chat row (a convenience: Paseo has no idempotent post, so it may show twice
  // after a crash in the instant it was posted).
  private async chatRow(attempt: DecisionAttempt, steps: WorkerSteps): Promise<void> {
    const paseo = this.paseo;
    if (!paseo) return;
    const row: PlannotatorRow = { title: attempt.approved ? "Plan approved in Plannotator" : "Plan sent back from Plannotator", ...(attempt.feedback ? { detail: attempt.feedback.slice(0, 4_000) } : {}) };
    await steps.optional("chat", () => paseo.agents.ref(attempt.agentId).timeline.append({ type: "plugin", id: `plannotator-decided-${attempt.at.replace(/[^0-9A-Za-z]/g, "")}`, kind: PLANNOTATOR_KIND, version: 1, data: row }));
  }

  // A parked plan's decision: the plan document, its follow-ups and Todo with plan-ready when
  // approved, then the session thread queues a fresh agent (or a comment asks to assign Paseo).
  // The parking ends last, so a decision not carried out yet keeps the plan parked.
  private async applyParked(attempt: DecisionAttempt, steps: WorkerSteps): Promise<void> {
    const parked = attempt.parked!;
    const issue = { id: parked.issueId, identifier: parked.identifier };
    const event = this.eventOf(attempt, parked.plan);
    await steps.once("log", () => this.logFeedback(attempt.agentId, event, issue));
    const documentUrl = await steps.once("document", () => this.linear.upsertIssueDocument(issue.id, `Plan: ${issue.identifier}`, planDocument(event, issue.identifier, parked.model)));
    if (attempt.approved) {
      await steps.once("follow-ups", async () => { await this.followUps?.file({ issueId: issue.id, identifier: issue.identifier, plan: event.planContent ?? parked.plan, documentUrl: documentUrl || null }); });
      await steps.once("plan-ready", () => this.linear.addLabel(issue.id, PLAN_READY_LABEL));
      await steps.once("ready", async () => {
        const moved = await this.linear.moveToReady(issue.id);
        if (moved.note) console.error(`[linear-tickets] ${issue.identifier}: ${moved.note}`);
      });
    }
    const plan = documentUrl ? ` ([plan](${documentUrl}))` : "";
    const sessionId = attempt.sessionId;
    const sessions = this.sessions;
    const queued = await steps.once("queue", async () => sessionId && sessions ? sessions.requeueSession(sessionId, attempt.agentId) : "none");
    if (queued !== "none" && sessionId && sessions) {
      const note = attempt.approved
        ? `Plan approved${plan}. A new agent implements it as soon as a slot is free.`
        : `Plan sent back${plan}${attempt.feedback ? `: ${attempt.feedback.slice(0, 1_000)}` : ""}. A new agent plans again with your feedback as soon as a slot is free.`;
      await steps.created("notify", (id) => sessions.said(id), (id) => sessions.say(sessionId, "thought", note, false, id));
    } else {
      const body = `${attempt.approved ? "✅ **Plan approved**" : "↩️ **Plan sent back**"} in Plannotator${plan}${attempt.feedback ? `\n\n${attempt.feedback.slice(0, 4_000)}` : ""}\n\nAssign Paseo again to ${attempt.approved ? "implement it" : "plan it again"}.`;
      await steps.created("comment", async (id) => Boolean(await this.linear.commentById(id)), (id) => this.linear.comment(issue.id, body, id));
    }
    if (this.parking) await steps.once("unpark", () => this.parking!.plans.remove(issue.id));
  }

  // A decision on a working ticket agent's own review: its mode and model tier, the ticket's state
  // and plan-ready label, the plan document, follow-ups, and the progress comment (or a comment).
  private async applyLive(attempt: DecisionAttempt, steps: WorkerSteps): Promise<void> {
    const issueId = attempt.issueId!;
    const identifier = attempt.identifier ?? "this ticket";
    const issue = { id: issueId, identifier };
    const event = this.eventOf(attempt);
    const settings = await this.settings.read();
    await steps.once("log", () => this.logFeedback(attempt.agentId, event, issue));
    await this.chatRow(attempt, steps);
    await this.panelDecided(attempt, steps);
    // A required plan started in the provider's safe mode; its approved plan unlocks the usual mode.
    if (attempt.approved && attempt.planPolicy === "required") {
      await steps.once("mode", async () => {
        const preference = settings.lastProvider ? settings.launchPreferences[settings.lastProvider] : undefined;
        if (!preference?.modeId) return "no usual mode";
        try {
          await this.setMode(attempt.agentId, preference.modeId);
          return preference.modeId;
        } catch (error) {
          // An agent that is gone has nothing left to implement with.
          const agent = await this.paseo?.agents.ref(attempt.agentId).refresh().catch(() => undefined);
          if (agent === null || agent?.agent.archivedAt) return "agent gone";
          throw error;
        }
      });
    }
    if (attempt.approved) await this.applyPlanTier(attempt, steps, settings);
    // Planning after a send-back; coding once approved.
    if (settings.writeback.status) {
      await steps.once("state", async () => {
        const moved = await this.linear.moveToStateNamed(issueId, attempt.approved ? CODING_STATE : PLANNING_STATE);
        if (moved.note) console.error(`[linear-tickets] ${identifier}: ${moved.note}`);
      });
      await steps.once("label", () => attempt.approved ? this.linear.addLabel(issueId, PLAN_READY_LABEL) : this.linear.removeLabel(issueId, PLAN_READY_LABEL));
    }
    const documentUrl = await steps.once("document", () => this.linear.upsertIssueDocument(issueId, `Plan: ${identifier}`, planDocument(event, identifier, attempt.model)));
    if (attempt.approved) await steps.once("follow-ups", async () => { await this.followUps?.file({ issueId, identifier, plan: attempt.planContent, documentUrl: documentUrl || null }); });
    // With a session the panel shows the review, so the progress comment records it instead of new comments.
    const via = await steps.once("report-via", async () => {
      const agent = attempt.sessionId && this.handover ? (await this.paseo?.agents.ref(attempt.agentId).refresh())?.agent : null;
      return agent ? { via: "progress", title: agent.title ?? null, cwd: agent.cwd } : { via: "comment" };
    }) as { via: "progress" | "comment"; title?: string | null; cwd?: string };
    if (via.via === "progress" && this.handover) {
      await steps.once("progress", () => this.handover!.update(issue, { id: attempt.agentId, title: via.title ?? null, cwd: via.cwd ?? "" }, { plan: attempt.approved ? "approved" : `sent back${attempt.feedback ? ` — ${attempt.feedback.slice(0, 300)}` : ""}`, ...(documentUrl ? { link: ["Plan", documentUrl] as [string, string] } : {}), model: attempt.model ?? null }));
      return;
    }
    const feedback = attempt.feedback ? `\n\n${attempt.feedback.slice(0, 4_000)}` : "";
    const body = `${attempt.approved ? "✅ **Plan approved** in Plannotator" : "↩️ **Plan sent back** from Plannotator"}${documentUrl ? ` — [plan](${documentUrl})` : ""}${feedback}`;
    await steps.created("comment", async (id) => Boolean(await this.linear.commentById(id)), (id) => this.linear.comment(issueId, body, id));
  }

  // The panel's side of a decision: the review is no longer open there, the plan checklist starts,
  // and a note says what was decided (a convenience: best effort).
  private async panelDecided(attempt: DecisionAttempt, steps: WorkerSteps): Promise<void> {
    const sessions = this.sessions;
    const sessionId = attempt.sessionId;
    if (!sessions || !sessionId) return;
    await steps.optional("panel", async () => {
      await sessions.expectReview(sessionId, null);
      const planned = attempt.approved ? planSteps(attempt.planContent) : [];
      if (planned.length) await sessions.plan(sessionId, planned.map((content, index) => ({ content, status: index === 0 ? "inProgress" as const : "pending" as const })));
    });
    const note = attempt.approved ? "Plan approved — starting on it." : `Plan sent back${attempt.feedback ? `: ${attempt.feedback.slice(0, 1_000)}` : ""}.`;
    await steps.optional("panel-note", () => steps.created("panel-note:posted", (id) => sessions.said(id), (id) => sessions.say(sessionId, "thought", note, false, id)));
  }

  // An agent without a ticket, or a subagent: only its chat row.
  private async applyNone(attempt: DecisionAttempt, steps: WorkerSteps): Promise<void> {
    await this.chatRow(attempt, steps);
    await this.panelDecided(attempt, steps);
  }

  // The owner's approval of a planner run's work order: written by the project flow. A send-back
  // reaches the planner through Plannotator itself; it submits again.
  private async applyOrder(attempt: DecisionAttempt, steps: WorkerSteps): Promise<void> {
    const runId = attempt.runId;
    const name = `planner run ${(runId ?? "").slice(0, 8)}`;
    if (!attempt.approved || !runId) return;
    if (!attempt.planContent.trim()) { console.error(`[linear-tickets] ${name}: the approved work order arrived without its text, so it was not written`); return; }
    const paseo = this.paseo;
    if (!paseo) throw new FencedError();
    await steps.once("work-order", async () => {
      if (!this.projectPlans || !await this.projectPlans.isPlannerRun(runId)) { console.log(`[linear-tickets] the obsolete planner run ${runId.slice(0, 8)} report was ignored`); return; }
      await this.applyWorkOrder(runId, attempt.agentId, name, attempt.planContent, paseo, await this.settings.read());
    });
  }

  // "Approve, implement later" and "Approve & split" (split.ts).
  private async applyPanel(attempt: DecisionAttempt, steps: WorkerSteps): Promise<void> {
    const review = this.journal.review(attempt.reviewId);
    const sessions = this.sessions;
    const sessionId = attempt.sessionId;
    const paseo = this.paseo;
    if (!paseo) throw new FencedError();
    const work: PanelWork = {
      linear: this.linear,
      appUserId: () => this.linear.appUserId(),
      ...(this.followUps ? { followUps: this.followUps } : {}),
      session: sessions && sessionId ? {
        hold: (offer) => sessions.holdSession(sessionId, offer),
        group: () => sessions.groupSession(sessionId),
        clearReview: () => sessions.clearReview(sessionId),
        reply: (body, id) => sessions.say(sessionId, "response", body, false, id),
        replied: (id) => sessions.said(id),
      } : null,
      // An already closed review counts as closed (parking.retire logs and goes on).
      retire: async (reason) => {
        if (this.parking) { await this.parking.retire(review && !review.legacy ? review.localUrl : null, attempt.agentId, paseo, reason); return; }
        if (review && !review.legacy) await this.decide(review.localUrl, false, reason).catch((error: unknown) => { if (!(error instanceof ReviewClosedError)) throw error; });
      },
      ...(attempt.parked && this.parking ? { unpark: () => this.parking!.plans.remove(attempt.parked!.issueId) } : {}),
    };
    const decision = { agentId: attempt.agentId, issueId: attempt.issueId!, identifier: attempt.identifier ?? attempt.issueId!, plan: attempt.planContent, model: attempt.model ?? null, at: attempt.at };
    await (attempt.route === "later" ? applyLater : applySplit)(steps, work, decision);
  }

  // An uncertain decision: Plannotator's answer was lost. A saved outcome for its review settles
  // it; while the review still answers with the same plan, the same decision is sent again; when
  // the review is gone without evidence it waits for the owner (Carry it out / Drop it).
  private async recheck(attempt: DecisionAttempt): Promise<void> {
    const now = this.journal.now();
    if (now - (this.rechecked.get(attempt.id) ?? Number.NEGATIVE_INFINITY) < RECHECK_MS) return;
    this.rechecked.set(attempt.id, now);
    // Plannotator can no longer confirm the decision: it waits for the owner (Carry it out / Drop it).
    const owner = (text: string) => this.journal.awaitOwner(attempt.id, true, text);
    try {
      await this.journal.run(async () => {
        const review = this.journal.review(attempt.reviewId);
        if (!review || review.legacy) { await owner("Plannotator did not confirm this decision: carry it out or drop it."); return; }
        // Plannotator reuses ports: a newer review on the address is not this one.
        const reused = this.journal.all().some((entry) => entry.kind === "review" && entry.localUrl === review.localUrl && entry.openedAt > review.openedAt);
        const outcome = await this.outcomes({ localUrl: review.localUrl, openedAt: review.openedAt, planHash: review.planHash ?? attempt.planHash }, !reused);
        if (outcome && typeof outcome === "object") { await this.journal.evidence(attempt.id, outcome.approved, `saved-${review.id}`); return; }
        if (outcome !== "open") { await owner("Plannotator closed the review without a decision Paseo can find: carry it out or drop it."); return; }
        const shown = await this.fetchPlan(review.localUrl).catch(() => "");
        if (!shown.trim() || planHash(shown) !== attempt.planHash) { await owner("The review's address shows another plan now: carry it out or drop it."); return; }
        // Still open with this plan: sent again, so it is not the owner's to settle.
        await this.journal.awaitOwner(attempt.id, false);
        try {
          await this.decide(review.localUrl, attempt.transport, attempt.feedback ?? "");
          await this.journal.settle(attempt.id, "accepted");
        } catch (error) {
          if (!(error instanceof ReviewClosedError)) throw error;
          await this.journal.settle(attempt.id, error.outcomeUnknown ? "unknown" : "refused", error.outcomeUnknown ? undefined : "Plannotator was decided meanwhile; waiting for its report.");
        }
      });
    } catch (error) {
      if (!(error instanceof FencedError)) console.error(`[linear-tickets] checking the unconfirmed plan decision ${attempt.id} failed: ${message(error)}`);
    }
  }
}
