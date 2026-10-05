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
import { APPROVE_LATER, APPROVE_PLAN, decidePlannotatorReview, MAX_SPLIT, planSteps, SEND_BACK, setAgentMode, SPLIT_PLAN, type SessionRouter } from "./sessions";
import { hasLabel, PLAN_POLICY_LABEL, PLAN_READY_LABEL } from "./plan-policy";
import type { ParkedPlan, ParkedPlans } from "./parked";
import type { ReviewLinks } from "./review-links";
import { autoApproval, parsePlanRisk, ratingText, type ReviewFacts } from "../shared/plan-risk";
import { planHash } from "./review-outcome";
import { isUntrusted } from "./starter";
import { dispatchLabels } from "./dispatch";
import { orderProblems, type ProjectFlow } from "./project-flow";
import type { PlanFollowUps } from "./plan-follow-ups";
import { feedbackEntry, logQuietly, type DecisionLog } from "./owner-decisions";
import { modelProblem, modelSteps, planTier, strongerTier, TIERS, type Tier } from "../shared/plan-model";
import { labelTier, onlyTierAdded, TIER_LABELS, tierModel, type TierStore } from "./model-tiers";
import type { ReviewDeletions } from "./review-deletions";

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
// About a minute of retries at the sweep interval, enough to ride out a Linear hiccup.
const MAX_ATTEMPTS = 20;
// The owner's decision on a parked plan exists nowhere else (its agent is retired), so it is never
// given up: past the quick attempts it is retried at this pace until Linear takes it (the
// hourly request limit lasts up to an hour).
const PARKED_DECISION_RETRY_MS = 60_000;
const SWEEP_MS = 3_000;
const MAX_PLAN_CHARS = 180_000;

export type PlannotatorRow = { title: string; url?: string; detail?: string };
export type OpenedEvent = { type: "opened"; agentId: string | null; localUrl: string; remoteUrl: string | null; at: string };
// `parked`: a parked plan's decision, reported by the central Plannotator host (parked.ts) or, for a
// plan the risk policy approves once its advisor review is recorded, by the bridge (rejudgeParked).
export type DecidedEvent = { type: "decided"; agentId: string | null; approved: boolean; feedback?: string; planUri?: string; planContent?: string; parked?: true; at: string };
// The omp extension recorded the plan advisor's review (verdict) for the plan text with this hash.
export type AdvisedEvent = { type: "advised"; agentId: string | null; verdict: string; hash: string; at: string };
// The ticket agent asked for the strong model tier (the omp extension's escalate_model tool).
export type EscalatedEvent = { type: "escalated"; agentId: string | null; reason: string; at: string };
type PlannotatorEvent = OpenedEvent | DecidedEvent | AdvisedEvent | EscalatedEvent;
// Model tiers (README, "Model tiers"): where tier decisions are recorded, the model guard's
// immediate switch of one agent, and sending a working agent back to planning (plan-requests.ts).
export type Tiers = { store: Pick<TierStore, "record">; apply: (agentId: string) => Promise<unknown>; replan: (agent: { id: string; issueId: string; identifier: string }, message: string) => Promise<void> };
type Linear = Pick<LinearService, "comment" | "upsertIssueDocument" | "issueDocument" | "moveToStateNamed" | "moveToReady" | "addLabel" | "removeLabel" | "issueState" | "viewerId" | "appUserId">;
// What the risk policy made of an opened review: `line` tells the owner, in the panel and on Linear;
// `reasons` why it needs the owner (empty when approved).
type Judgement = { approved: boolean; line: string; reasons: string[] };
type ProjectPlans = Pick<ProjectFlow, "isPlanner" | "applyPlan">;
// Parked plans (README, "Parked plans"): `available` while the central Plannotator host runs;
// `retire` closes the agent's own review (when it has one) with the reason, stops and archives the agent.
export type Parking = {
  plans: Pick<ParkedPlans, "forAgent" | "put" | "remove">;
  available: () => boolean;
  retire: (localUrl: string | null, agentId: string, paseo: PaseoApi, reason: string) => Promise<void>;
};
type Advice = { verdict: string; hash: string };

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

// Records a decision made outside Plannotator's page (the Linear agent panel), so the bridge
// handles it like one reported by the omp plan extension.
export async function recordDecision(event: DecidedEvent, events = plannotatorPaths().events): Promise<void> {
  await mkdir(events, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${randomUUID()}.json`;
  const temporary = join(events, `.${name}.tmp`);
  await writeFile(temporary, JSON.stringify(event), { mode: 0o600 });
  await rename(temporary, join(events, name));
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
    return {
      type: "decided", agentId, approved: event.approved, at,
      ...(typeof event.feedback === "string" && event.feedback.trim() ? { feedback: event.feedback.trim() } : {}),
      ...(typeof event.planUri === "string" ? { planUri: event.planUri } : {}),
      ...(typeof event.planContent === "string" ? { planContent: event.planContent } : {}),
      ...(event.parked === true ? { parked: true as const } : {}),
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

// Plannotator ↔ Paseo ↔ Linear. Plannotator's review URL only reaches omp's UI notices, which
// Paseo does not show, so reviews were invisible. The PLANNOTATOR_BROWSER hook and the omp
// plan extension drop events into a directory; this bridge turns each into a row in the
// agent's Paseo chat and — for agents linked to a ticket — a Linear comment with the agent's
// stable review link (ReviewLinks), and on a decision the plan document on the ticket.
export class PlannotatorBridge {
  private paseo: PaseoApi | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private readonly attempts = new Map<string, number>();
  // A parked decision past its quick attempts: when it is tried next.
  private readonly retryAt = new Map<string, number>();
  // A decision taken in Linear is also reported by the omp plan extension; the second report
  // within this window is the same decision and is skipped.
  private readonly lastDecision = new Map<string, number>();
  // A project's planner tickets and their work orders (project-flow.ts).
  private projectPlans: ProjectPlans | null = null;
  // Files an approved plan's follow-ups (plan-follow-ups.ts); its retries run on this bridge's sweep.
  private followUps: Pick<PlanFollowUps, "file" | "retryPending"> | null = null;
  // Reviews already opened on this machine, so a retried event does not open a second tab.
  private readonly shown = new Set<string>();
  // Where the owner's review feedback is kept for the weekly decision candidates (owner-decisions.ts).
  private decisions: Pick<DecisionLog, "append"> | null = null;
  // Model tiers (README, "Model tiers"): approved plans and escalations set the agent's tier.
  private tiers: Tiers | null = null;
  // Agents whose plan the plugin sent back for its `## Model` section: the omp extension's report
  // of that send-back is not the owner's decision. Cleared by the agent's next review.
  private readonly tierSendBacks = new Set<string>();
  private deletions: Pick<ReviewDeletions, "get" | "forAgent"> | null = null;
  private deliveryFailure: ((event: OpenedEvent, error: unknown, attempts: number) => Promise<void>) | null = null;

  constructor(
    private readonly linear: Linear,
    private readonly settings: Pick<Settings, "read">,
    private readonly events = plannotatorPaths().events,
    private readonly sessions?: Pick<SessionRouter, "sessionFor" | "plan" | "ask" | "say" | "expectReview" | "parked" | "requeue">,
    private readonly fetchPlan: (localUrl: string) => Promise<string> = readReviewPlan,
    private readonly handover?: Pick<Handover, "update">,
    private readonly setMode: (agentId: string, modeId: string) => Promise<void> = setAgentMode,
    private readonly reviews?: Pick<ReviewLinks, "opened" | "decided" | "described" | "describedFor"> & Partial<Pick<ReviewLinks, "requiresOwner">>,
    private readonly decide: (localUrl: string, approve: boolean, feedback: string) => Promise<void> = decidePlannotatorReview,
    private readonly open: (url: string) => void = openInBrowser,
    private readonly parking?: Parking,
  ) {}

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

  // The ticket's Linear agent panel: review link, plan checklist and Approve / Send back.
  // Returns whether the agent has a session: then the progress comment carries the plan state
  // instead of separate plan comments.
  private async toSession(event: OpenedEvent | DecidedEvent, agentId: string, model: string | null, reviewLink: string | null, planText: string, judgement: Judgement | null): Promise<boolean> {
    const sessions = this.sessions;
    if (!sessions) return false;
    try {
      const link = await sessions.sessionFor(agentId);
      if (!link) return false;
      if (event.type === "opened") {
        const steps = planSteps(planText);
        if (steps.length) await sessions.plan(link.sessionId, steps.map((content) => ({ content, status: "pending" as const })));
        // An auto-approved plan is decided already; its approval arrives as the next event (judge).
        if (judgement?.approved) { await sessions.say(link.sessionId, "thought", judgement.line); return true; }
        await sessions.expectReview(link.sessionId, event.localUrl, planText, reviewLink);
        const split = steps.length > 1 ? [{ label: `Approve & split into ${Math.min(steps.length, MAX_SPLIT)} sub-issues`, value: SPLIT_PLAN }] : [];
        await sessions.ask(link.sessionId, `The plan is ready for review${reviewLink ? ` (full view: ${reviewLink})` : ""}. Approve it, or reply with what to change.${judgement ? `\n\n${judgement.line}` : ""}${model ? `\n\nPlanned with ${model}.` : ""}`, [{ label: "Approve plan", value: APPROVE_PLAN }, { label: "Approve, implement later", value: APPROVE_LATER }, ...split, { label: "Send back", value: SEND_BACK }]);
        return true;
      }
      await sessions.expectReview(link.sessionId, null);
      if (event.approved && event.planContent) {
        const steps = planSteps(event.planContent);
        if (steps.length) await sessions.plan(link.sessionId, steps.map((content, index) => ({ content, status: index === 0 ? "inProgress" as const : "pending" as const })));
      }
      await sessions.say(link.sessionId, "thought", event.approved ? "Plan approved — starting on it." : `Plan sent back${event.feedback ? `: ${event.feedback.slice(0, 1_000)}` : ""}.`);
      return true;
    } catch (error) {
      console.error(`[linear-tickets] Plannotator session update for ${agentId} failed: ${error instanceof Error ? error.message : error}`);
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The plugin closed this agent's review itself (split, implement later); the omp extension's
  // report of that closing is not the owner's decision and is skipped like a duplicate.
  settled(agentId: string): void {
    this.lastDecision.set(agentId, Date.now());
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

  // The ticket's `model:` label follows its tier, so Linear shows (and filters) which tier a ticket
  // runs on; the owner raises it by setting a stronger `model:` label.
  private async labelTier(issueId: string, tier: Tier, current: { id: string; name: string }[]): Promise<void> {
    await this.linear.addLabel(issueId, TIER_LABELS[tier]);
    for (const other of TIERS) if (other !== tier) await this.linear.removeLabel(issueId, TIER_LABELS[other], current);
  }

  // An approved plan's tier (README, "Model tiers"): the stronger of the plan's `## Model` section
  // and the ticket's label, recorded for this agent and applied by the model guard right away. A
  // failure leaves the agent on the launch model, the safe side. A plan that names no tier (its
  // review text could not be checked) sends the agent back to planning for it.
  private async applyPlanTier(agentId: string, provider: string, issue: { id: string; identifier: string }, plan: string, settings: PluginSettings): Promise<void> {
    const tiers = this.tiers;
    if (!tiers) return;
    try {
      const state = await this.linear.issueState(issue.id);
      const planned = planTier(plan);
      const tier = strongerTier(labelTier(state.labels), planned?.tier);
      const link = await this.sessions?.sessionFor(agentId);
      if (!tier) {
        await tiers.replan({ id: agentId, issueId: issue.id, identifier: issue.identifier }, `The approved plan for ${issue.identifier} has no \`## Model\` section, so it does not say which model implements it. You are back in planning for that section only: do not change code yet. Submit the approved plan unchanged with the \`## Model\` section added; when nothing else changed, the plugin approves it without the owner.\n\n${modelSteps()}`);
        if (link) await this.sessions!.say(link.sessionId, "thought", "The approved plan names no model tier: back to planning to add its `## Model` section.");
        console.log(`[linear-tickets] ${issue.identifier}: the approved plan names no model tier, its agent plans again for it`);
        return;
      }
      const reason = tier === planned?.tier ? planned.reason || "the approved plan" : "raised by the ticket's model label";
      const launch = settings.launchPreferences[provider];
      const model = launch ? tierModel(settings, provider, tier, { provider: launch.model }).provider : null;
      await tiers.store.record(issue, { tier, source: "plan", reason, agentId, model });
      if (settings.writeback.status) await this.labelTier(issue.id, tier, state.labels);
      await tiers.apply(agentId);
      if (link) await this.sessions!.say(link.sessionId, "thought", `Implementing on the ${tier} model tier${model ? ` (${model})` : ""}: ${reason}.`);
      console.log(`[linear-tickets] ${issue.identifier}: implementing on the ${tier} tier (${reason})`);
    } catch (error) {
      console.error(`[linear-tickets] ${issue.identifier}: applying the plan's model tier failed, the agent stays on the launch model: ${error instanceof Error ? error.message : error}`);
    }
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
    const quietly = (what: string) => (error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: ${what} after the escalation failed: ${error instanceof Error ? error.message : error}`);
    if (settings.writeback.status) await this.linear.issueState(issueId).then((state) => this.labelTier(issueId, "strong", state.labels)).catch(quietly("updating the model label"));
    await tiers.apply(agentId).catch(quietly("switching the model"));
    const note = `Escalated to the strong model tier${from ? ` from ${from}` : ""}: ${event.reason}`;
    const link = await this.sessions?.sessionFor(agentId).catch(() => null);
    await (link ? this.sessions!.say(link.sessionId, "thought", note) : this.linear.comment(issueId, `⬆️ **${note}**`)).catch(quietly("telling the owner"));
    console.log(`[linear-tickets] ${issue.identifier}: ${note}`);
  }

  // The plan document is replaced every round, so the log is where each round's feedback stays.
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
  // approval it had when nothing else changed. A project planner's work order never comes here
  // (deliverWorkOrder).
  // null: the plan has no readable rating.
  private async judge(localUrl: string, agentId: string, issueId: string, planText: string, settings: PluginSettings): Promise<Judgement | null> {
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
      await this.decide(localUrl, true, feedback);
      // Plannotator reports no approval of its own plan mode, so the bridge records it like the
      // panel's: the plan document, the coding state and the model tier follow from that event.
      // When the omp plan extension reports it too, the second report is skipped as a duplicate.
      await recordDecision({ type: "decided", agentId, approved: true, feedback, planContent: planText, at: new Date().toISOString() }, this.events)
        .catch((error: unknown) => console.error(`[linear-tickets] recording the auto-approval of ${agentId} failed: ${error instanceof Error ? error.message : error}`));
      return { approved: true, line: tierOnly ? `Approved without you: the plan you approved, with its model tier added. ${rating}`.trim() : `Auto-approved within your threshold. ${rating}`, reasons: [] };
    } catch (error) {
      console.error(`[linear-tickets] auto-approval check for ${agentId} failed: ${error instanceof Error ? error.message : error}`);
      return { approved: false, line: [rating, "The auto-approval check failed, so it needs your approval."].filter(Boolean).join(" "), reasons: ["the auto-approval check failed"] };
    }
  }

  // A parked plan whose advisor review was recorded after it was parked (README, "Parked plans"):
  // its planner, resumed for that, recorded the review for exactly the parked text. The plan is
  // judged again: within the threshold it is approved like the owner's approval on the central
  // host; otherwise it stays parked with the new reasons. The planner is retired again either way.
  private async rejudgeParked(parked: ParkedPlan, verdict: string, paseo: PaseoApi): Promise<void> {
    if (await this.reviews?.requiresOwner?.(parked.issueId)) return;
    const rated = parsePlanRisk(parked.plan);
    if ("problem" in rated) return;
    const settings = await this.settings.read();
    const outcome = autoApproval(rated.risk, settings.autoApprove, await this.reviewFacts(await this.linear.issueState(parked.issueId), verdict, settings));
    const rating = `Risk: ${ratingText(rated.risk)}.`;
    await this.parking!.retire(null, parked.agentId, paseo, "The plan stays parked for the owner: stop now and do not implement anything.");
    if (outcome.approve) {
      await recordDecision({ type: "decided", parked: true, agentId: parked.agentId, approved: true, feedback: `Auto-approved by the risk policy. ${rating}`, planContent: parked.plan, at: new Date().toISOString() }, this.events);
      console.log(`[linear-tickets] ${parked.identifier}: parked plan auto-approved once its advisor review was recorded (${rating})`);
      return;
    }
    await this.parking!.plans.put({ ...parked, line: `${rating} Needs your approval: ${outcome.reasons.join("; ")}.`, reasons: outcome.reasons });
    await this.reviews?.describedFor(parked.agentId, parked.plan, { approved: false, reasons: outcome.reasons })
      .catch((error: unknown) => console.error(`[linear-tickets] inbox details for ${parked.identifier} skipped: ${error instanceof Error ? error.message : error}`));
    console.log(`[linear-tickets] ${parked.identifier}: parked plan judged again with its advisor review, still for the owner (${outcome.reasons.join("; ")})`);
  }

  async drain(): Promise<void> {
    if (this.draining) { this.again = true; return this.draining; }
    this.draining = (async () => {
      do {
        this.again = false;
        const names = (await readdir(this.events).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
        for (const name of names) await this.handle(name);
      } while (this.again);
    })();
    try { await this.draining; } finally { this.draining = null; }
  }

  private async handle(name: string): Promise<void> {
    const path = join(this.events, name);
    const paseo = this.paseo;
    if (!paseo) return;
    if ((this.retryAt.get(name) ?? 0) > Date.now()) return;
    let event: PlannotatorEvent | null = null;
    try {
      event = parseEvent(await readFile(path, "utf8"));
      if (event?.agentId) {
        const recorded = await this.deletions?.forAgent(event.agentId);
        const issueId = recorded?.issueId ?? (await paseo.agents.ref(event.agentId).refresh())?.agent.labels?.["linear.issueId"];
        const deletion = recorded ?? (issueId ? await this.deletions?.get(issueId) : null);
        if (deletion?.phase === "pending") return;
        if (!deletion) await this.deliver(event, event.agentId, paseo);
      }
      else if (event?.type === "opened") this.show(event.localUrl);
      await rm(path, { force: true });
      this.attempts.delete(name);
      this.retryAt.delete(name);
    } catch (error) {
      const tries = (this.attempts.get(name) ?? 0) + 1;
      console.error(`[linear-tickets] Plannotator event ${name} failed (attempt ${tries}): ${error instanceof Error ? error.message : error}`);
      if (event?.type === "opened" && this.deliveryFailure) {
        await this.deliveryFailure(event, error, tries).catch(() => {
          console.error("[linear-tickets] could not record the plan delivery failure");
        });
      }
      this.attempts.set(name, tries);
      if (tries < MAX_ATTEMPTS) return;
      if (event?.type === "decided" && event.parked) { this.retryAt.set(name, Date.now() + PARKED_DECISION_RETRY_MS); return; }
      // Given up: the review still opens, so it is not lost.
      if (event?.type === "opened") this.show(event.localUrl);
      await rm(path, { force: true });
      this.attempts.delete(name);
    }
  }

  private async deliver(event: PlannotatorEvent, agentId: string, paseo: PaseoApi): Promise<void> {
    if (event.type === "advised") {
      await this.remember(agentId, { verdict: event.verdict, hash: event.hash });
      const parked = await this.parking?.plans.forAgent(agentId);
      if (parked && planHash(parked.plan) === event.hash) await this.rejudgeParked(parked, event.verdict, paseo);
      return;
    }
    // A decided review's verdict is spent: the next round records its own.
    if (event.type === "decided") await rm(this.adviceFile(agentId), { force: true });
    if (event.type === "escalated") return this.escalate(event, agentId, paseo);
    const parked = this.parking ? await this.parking.plans.forAgent(agentId) : null;
    if (parked) return this.deliverParked(event, parked);
    if (event.type === "decided") {
      if (!event.approved && this.tierSendBacks.delete(agentId)) return;
      const previous = this.lastDecision.get(agentId);
      const at = Date.parse(event.at) || Date.now();
      if (previous !== undefined && Math.abs(at - previous) < 120_000) return;
      this.lastDecision.set(agentId, at);
    }
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    const labels = refreshed?.agent.labels ?? {};
    const model = activeModel(refreshed?.agent);
    const issueId = labels["paseo.parent-agent-id"] ? undefined : labels["linear.issueId"];
    const identifier = labels["linear.identifier"] || "this ticket";
    if (issueId && this.projectPlans && await this.projectPlans.isPlanner(issueId)) return this.deliverWorkOrder(event, agentId, issueId, identifier, paseo);
    if (event.type === "decided" && issueId) await this.logFeedback(agentId, event, { id: issueId, identifier });
    const planText = event.type === "opened" ? await this.fetchPlan(event.localUrl).catch(() => "") : "";
    // A ticket plan without a complete `## Model` section (README, "Model tiers") goes back to its
    // planner before anyone reviews it; it never reaches the owner or a default tier.
    if (event.type === "opened" && issueId) {
      this.tierSendBacks.delete(agentId);
      const problem = planText.trim() ? modelProblem(planText) : null;
      if (problem) {
        this.tierSendBacks.add(agentId);
        await this.decide(event.localUrl, false, `Paseo sent this plan back before review. ${problem}\n\nAdd or fix the section and submit the plan again.`);
        console.log(`[linear-tickets] ${identifier}: plan sent back to the planner: its model tier is missing or not allowed`);
        return;
      }
    }
    // The agent's stable link when ReviewLinks is up; otherwise this review's own tailnet or local URL.
    const stableLink = event.type === "opened" ? await this.reviews?.opened(agentId, event, { identifier: labels["linear.identifier"] || undefined, ...(issueId ? { issueId } : {}), model }) ?? null : null;
    const url = event.type === "opened" ? stableLink ?? event.remoteUrl ?? event.localUrl : undefined;
    if (event.type === "decided") await this.reviews?.decided(agentId, event.approved);
    const settings = await this.settings.read();
    const judgement = event.type === "opened" && issueId ? await this.judge(event.localUrl, agentId, issueId, planText, settings) : null;
    if (event.type === "opened" && issueId && !judgement?.approved && planText.trim() && this.parking?.available()) {
      await this.park(event, { issueId, identifier, agentId, plan: planText, line: judgement?.line ?? "The plan has no readable risk rating, so it needs your approval.", reasons: judgement?.reasons ?? ["no readable risk rating"], model, parkedAt: new Date().toISOString(), announced: false }, paseo);
      return;
    }
    // The inbox's details are a convenience: a failure must not retry (and repeat) the hand-off.
    if (event.type === "opened") await this.reviews?.described(event.localUrl, planText, judgement)
      .catch((error: unknown) => console.error(`[linear-tickets] inbox details for ${agentId} skipped: ${error instanceof Error ? error.message : error}`));
    if (event.type === "opened" && !judgement?.approved && !stableLink) this.show(event.localUrl);
    const row: PlannotatorRow = event.type === "opened"
      ? { title: judgement?.approved ? "Plan auto-approved by the risk policy" : "Handed off to Plannotator for review", url, detail: `${event.remoteUrl ? "Opens on any device in your tailnet." : "Local link only: Tailscale was unavailable."}${model ? ` Planned with ${model}.` : ""}${judgement ? ` ${judgement.line}` : ""}` }
      : { title: event.approved ? "Plan approved in Plannotator" : "Plan sent back from Plannotator", ...(event.feedback ? { detail: event.feedback.slice(0, 4_000) } : {}) };
    // Only a plugin session may append chat rows; the plugin's own fallback connection is not one.
    // The row is a convenience, so Linear still gets the review either way.
    await handle.timeline.append({ type: "plugin", id: `plannotator-${event.type}-${event.at.replace(/[^0-9A-Za-z]/g, "")}`, kind: PLANNOTATOR_KIND, version: 1, data: row })
      .catch((error: unknown) => console.error(`[linear-tickets] Plannotator chat row for ${agentId} skipped: ${error instanceof Error ? error.message : error}`));
    // Tailnet links only: a local-only review has no link worth showing off this machine.
    const inSession = await this.toSession(event, agentId, model, event.type === "opened" && event.remoteUrl ? url ?? null : null, planText, judgement);
    if (!issueId) return;
    // A required plan started in the provider's safe mode; its approved plan unlocks the usual mode.
    if (event.type === "decided" && event.approved && labels[PLAN_POLICY_LABEL] === "required") {
      const preference = settings.lastProvider ? settings.launchPreferences[settings.lastProvider] : undefined;
      if (preference?.modeId) await this.setMode(agentId, preference.modeId).catch((error: unknown) => console.error(`[linear-tickets] ${identifier}: restoring the agent mode failed: ${error instanceof Error ? error.message : error}`));
    }
    if (event.type === "decided" && event.approved && refreshed?.agent) await this.applyPlanTier(agentId, refreshed.agent.provider, { id: issueId, identifier }, event.planContent ?? "", settings);
    // Planning while a plan is out for review (and after it is sent back); coding once approved.
    if (settings.writeback.status) {
      const approved = event.type === "decided" && event.approved;
      const moved = await this.linear.moveToStateNamed(issueId, approved ? CODING_STATE : PLANNING_STATE);
      if (moved.note) console.error(`[linear-tickets] ${identifier}: ${moved.note}`);
      // Approved plans carry the label; a new review round or a sent-back plan removes it.
      await (approved ? this.linear.addLabel(issueId, PLAN_READY_LABEL) : this.linear.removeLabel(issueId, PLAN_READY_LABEL));
    }
    // With a session the panel shows the review, so the progress comment records it instead of new comments.
    const progress = inSession && this.handover && refreshed?.agent
      ? (change: { plan: string; link?: [string, string] }) => this.handover!.update({ id: issueId, identifier }, { id: agentId, title: refreshed.agent.title ?? null, cwd: refreshed.agent.cwd }, { ...change, model })
      : null;
    if (event.type === "opened") {
      if (progress) { await progress({ plan: judgement ? `${judgement.approved ? "auto-approved" : "under review"} — ${judgement.line}` : "under review", ...(url ? { link: ["Plan review", url] as [string, string] } : {}) }); return; }
      const risk = judgement ? `\n\n${judgement.line}` : "";
      await this.linear.comment(issueId, judgement?.approved
        ? `🤖 **Plan auto-approved** by the risk policy${model ? ` (planned with \`${model}\`)` : ""}: ${url}${risk}`
        : `📋 **Plan ready for review in Plannotator**${model ? ` (planned with \`${model}\`)` : ""}: ${url}${event.remoteUrl ? "" : "\n\n(Local link only: Tailscale was unavailable on the host.)"}${risk}`);
      return;
    }
    const documentUrl = await this.linear.upsertIssueDocument(issueId, `Plan: ${identifier}`, planDocument(event, identifier, model));
    if (event.approved) await this.followUps?.file({ issueId, identifier, plan: event.planContent ?? "", documentUrl: documentUrl || null });
    if (progress) {
      await progress({ plan: event.approved ? "approved" : `sent back${event.feedback ? ` — ${event.feedback.slice(0, 300)}` : ""}`, ...(documentUrl ? { link: ["Plan", documentUrl] as [string, string] } : {}) });
      return;
    }
    const feedback = event.feedback ? `\n\n${event.feedback.slice(0, 4_000)}` : "";
    await this.linear.comment(issueId, `${event.approved ? "✅ **Plan approved** in Plannotator" : "↩️ **Plan sent back** from Plannotator"}${documentUrl ? ` — [plan](${documentUrl})` : ""}${feedback}`);
  }

  // Parks a plan the owner has to decide (README, "Parked plans"). The record comes first, so the
  // agent's own report of its closed review is ignored; then the agent is retired, freeing its
  // slot. The central host serves the plan, and its `opened` event tells the owner (deliverParked).
  private async park(event: OpenedEvent, plan: ParkedPlan, paseo: PaseoApi): Promise<void> {
    await this.parking!.plans.put(plan);
    await this.sessions?.parked(plan.agentId);
    await this.parking!.retire(event.localUrl, plan.agentId, paseo, "The owner has to decide this plan. It is parked in the central Plannotator host and you are being closed to free your slot: stop now and do not implement anything. A new agent continues once the owner decides.");
    if ((await this.settings.read()).writeback.status) {
      const moved = await this.linear.moveToStateNamed(plan.issueId, PLANNING_STATE);
      if (moved.note) console.error(`[linear-tickets] ${plan.identifier}: ${moved.note}`);
      await this.linear.removeLabel(plan.issueId, PLAN_READY_LABEL);
    }
    console.log(`[linear-tickets] ${plan.identifier}: plan parked for the owner (${plan.reasons.join("; ")})`);
  }

  // A project planner's work order needs nobody (README, "Projects"): it only orders the project's
  // tickets, each of which plans on its own. It is approved as soon as it is submitted, with no
  // risk check or Linear read that could fail and send it to the owner, and the project flow writes
  // it into Linear, retrying on later polls. Nothing of a ticket approval (state, plan-ready, a new
  // agent) applies to it. One whose order cannot be read line by line is sent back to the planner
  // instead, so a broken block never closes as an empty order. A plan that cannot be read is
  // retried and, after that, opens for the owner like any review; their approval then arrives as
  // a `decided` event.
  private async deliverWorkOrder(event: OpenedEvent | DecidedEvent, agentId: string, issueId: string, identifier: string, paseo: PaseoApi): Promise<void> {
    const settings = await this.settings.read();
    if (event.type === "decided") {
      // A send-back reaches the agent through Plannotator itself; it submits again.
      if (!event.approved) return;
      if (!event.planContent?.trim()) { console.error(`[linear-tickets] ${identifier}: the approved work order arrived without its text, so it was not written`); return; }
      await this.applyWorkOrder(issueId, agentId, identifier, event.planContent, paseo, settings);
      return;
    }
    const plan = await this.fetchPlan(event.localUrl);
    if (!plan.trim()) throw new Error(`the work order of ${identifier} could not be read from Plannotator`);
    const problems = orderProblems(plan);
    if (problems.length) {
      await this.decide(event.localUrl, false, [
        "Paseo cannot apply this work order as written:",
        problems.map((problem) => `- ${problem}`).join("\n"),
        "The `## Work order` section needs one fenced ```project-order block with one change per line: `TUC-1 blocks TUC-2`, `hold TUC-3: reason`, `release TUC-4`, `attended TUC-5: reason` or `unattended TUC-6`. A reason goes after a colon. An empty block means no changes. Fix the block and submit the plan again.",
      ].join("\n\n"));
      console.log(`[linear-tickets] ${identifier}: work order sent back to the planner: ${problems.join("; ")}`);
      return;
    }
    // The plugin approves it: the extension's report of that approval is not a second decision.
    this.settled(agentId);
    await this.decide(event.localUrl, true, "Work order approved automatically: it only orders the project's tickets, each of which plans on its own. Paseo writes it into Linear; stop now.")
      .catch((error: unknown) => console.error(`[linear-tickets] ${identifier}: closing the work order's review failed: ${error instanceof Error ? error.message : error}`));
    await this.applyWorkOrder(issueId, agentId, identifier, plan, paseo, settings);
  }

  private async applyWorkOrder(issueId: string, agentId: string, identifier: string, plan: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (await this.projectPlans!.applyPlan(issueId, agentId, plan, paseo, settings)) return;
    console.error(`[linear-tickets] ${identifier}: the work order was not written: the ticket is no longer its project's open planner`);
  }

  // A parked plan's events, all from the central host: `opened` binds the stable link, inbox and
  // panel to the host's review (and tells the owner the first time); the owner's `decided` ends
  // the parking and queues a fresh agent. The retired agent's own report is ignored.
  // The parking ends only after the hand-off: a failed attempt (a Linear outage) leaves the plan
  // parked and the decision unrecorded, so the event's retry repeats the whole hand-off.
  private async deliverParked(event: OpenedEvent | DecidedEvent, parked: ParkedPlan): Promise<void> {
    if (event.type === "opened") {
      const stableLink = await this.reviews?.opened(parked.agentId, event, { identifier: parked.identifier, issueId: parked.issueId, since: parked.parkedAt, model: parked.model }) ?? null;
      const url = stableLink ?? event.remoteUrl ?? event.localUrl;
      await this.reviews?.described(event.localUrl, parked.plan, { approved: false, reasons: parked.reasons })
        .catch((error: unknown) => console.error(`[linear-tickets] inbox details for ${parked.identifier} skipped: ${error instanceof Error ? error.message : error}`));
      const reviewLink = event.remoteUrl ? url : null;
      const link = await this.sessions?.sessionFor(parked.agentId) ?? null;
      if (link) await this.sessions!.expectReview(link.sessionId, event.localUrl, parked.plan, reviewLink);
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
      return;
    }
    if (!event.parked) return;
    const at = Date.parse(event.at) || Date.now();
    const previous = this.lastDecision.get(parked.agentId);
    // The plugin closed the review itself (approve later, split), which already moved the ticket on.
    if (previous === undefined || Math.abs(at - previous) >= 120_000) await this.handOffParked(event, parked);
    await this.parking!.plans.remove(parked.issueId);
    await this.reviews?.decided(parked.agentId, event.approved);
    this.lastDecision.set(parked.agentId, at);
  }

  // Every step is safe to repeat: the log skips a known entry, the document is upserted, labels
  // and states are set, and follow-ups are filed by title.
  private async handOffParked(event: DecidedEvent, parked: ParkedPlan): Promise<void> {
    await this.logFeedback(parked.agentId, event, { id: parked.issueId, identifier: parked.identifier });
    const documentUrl = await this.linear.upsertIssueDocument(parked.issueId, `Plan: ${parked.identifier}`, planDocument({ ...event, planContent: event.planContent ?? parked.plan }, parked.identifier, parked.model));
    if (event.approved) {
      await this.followUps?.file({ issueId: parked.issueId, identifier: parked.identifier, plan: event.planContent ?? parked.plan, documentUrl: documentUrl || null });
      await this.linear.addLabel(parked.issueId, PLAN_READY_LABEL);
      const moved = await this.linear.moveToReady(parked.issueId).catch((error: unknown) => ({ changed: false, note: error instanceof Error ? error.message : String(error) }));
      if (moved.note) console.error(`[linear-tickets] ${parked.identifier}: ${moved.note}`);
    }
    const plan = documentUrl ? ` ([plan](${documentUrl}))` : "";
    const note = event.approved
      ? `Plan approved${plan}. A new agent implements it as soon as a slot is free.`
      : `Plan sent back${plan}${event.feedback ? `: ${event.feedback.slice(0, 1_000)}` : ""}. A new agent plans again with your feedback as soon as a slot is free.`;
    if (await this.sessions?.requeue(parked.agentId, note)) return;
    await this.linear.comment(parked.issueId, `${event.approved ? "✅ **Plan approved**" : "↩️ **Plan sent back**"} in Plannotator${plan}${event.feedback ? `\n\n${event.feedback.slice(0, 4_000)}` : ""}\n\nAssign Paseo again to ${event.approved ? "implement it" : "plan it again"}.`);
  }
}
