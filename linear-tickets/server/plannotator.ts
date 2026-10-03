import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { LinearService } from "./linear";
import type { PluginSettings, Settings } from "./settings";
import { PLANNOTATOR_OPEN_SOURCE } from "./plannotator-open-source";
import { paseoHome } from "./ticket-mcp";
import type { Handover } from "./handover";
import { activeModel } from "./model";
import { APPROVE_LATER, APPROVE_PLAN, decidePlannotatorReview, MAX_SPLIT, planSteps, SEND_BACK, setAgentMode, SPLIT_PLAN, type SessionRouter } from "./sessions";
import { hasLabel, PLAN_POLICY_LABEL, PLAN_READY_LABEL } from "./plan-policy";
import type { ReviewLinks } from "./review-links";
import { autoApproval, parsePlanRisk, planHash, ratingText } from "../shared/plan-risk";
import { isUntrusted } from "./starter";
import { dispatchLabels } from "./dispatch";

// The plan text of a running review, from the same endpoint its page loads.
export async function readReviewPlan(localUrl: string): Promise<string> {
  const response = await fetch(`${new URL(localUrl).origin}/api/plan`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) return "";
  const body: unknown = await response.json();
  return body && typeof body === "object" && "plan" in body && typeof body.plan === "string" ? body.plan : "";
}

// Opens a review on this machine, as Plannotator would without the hook. LINEAR_TICKETS_OPENER
// replaces the system opener (tests).
export function openInBrowser(url: string): void {
  const opener = process.env.LINEAR_TICKETS_OPENER || (process.platform === "darwin" ? "open" : "xdg-open");
  try { spawn(opener, [url], { detached: true, stdio: "ignore" }).unref(); } catch (error) {
    console.error(`[linear-tickets] opening ${url} failed: ${error instanceof Error ? error.message : error}`);
  }
}

export const PLANNOTATOR_KIND = "plannotator";
// About a minute of retries at the sweep interval, enough to ride out a Linear hiccup.
const MAX_ATTEMPTS = 20;
const SWEEP_MS = 3_000;
const MAX_PLAN_CHARS = 180_000;

export type PlannotatorRow = { title: string; url?: string; detail?: string };
export type OpenedEvent = { type: "opened"; agentId: string | null; localUrl: string; remoteUrl: string | null; at: string };
export type DecidedEvent = { type: "decided"; agentId: string | null; approved: boolean; feedback?: string; planUri?: string; planContent?: string; at: string };
// The agent left planning through the omp extension's skip_plan tool, with its reason.
export type SkippedEvent = { type: "skipped"; agentId: string | null; reason: string; at: string };
// The omp extension recorded the plan advisor's review (verdict) for the plan text with this hash.
export type AdvisedEvent = { type: "advised"; agentId: string | null; verdict: string; hash: string; at: string };
type PlannotatorEvent = OpenedEvent | DecidedEvent | SkippedEvent | AdvisedEvent;
type Linear = Pick<LinearService, "comment" | "upsertIssueDocument" | "moveToStateNamed" | "addLabel" | "removeLabel" | "issueState" | "viewerId" | "appUserId">;
// What the risk policy made of an opened review: `line` tells the owner, in the panel and on Linear.
type Judgement = { approved: boolean; line: string };
type ProjectPlans = (issueId: string, agentId: string, plan: string, paseo: PaseoApi, settings: PluginSettings) => Promise<boolean>;

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
    };
  }
  if (event.type === "skipped" && typeof event.reason === "string") {
    return { type: "skipped", agentId, reason: event.reason.trim().slice(0, 1_000) || "No reason given.", at };
  }
  if (event.type === "advised" && typeof event.verdict === "string" && typeof event.hash === "string") {
    return { type: "advised", agentId, verdict: event.verdict, hash: event.hash, at };
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
  // A decision taken in Linear is also reported by the omp plan extension; the second report
  // within this window is the same decision and is skipped.
  private readonly lastDecision = new Map<string, number>();
  // Applies an approved plan of a project's planner ticket (project-flow.ts); true when it was one.
  private projectPlans: ProjectPlans | null = null;
  // Per agent, the advisor verdict the omp extension recorded last and the hash of that plan text.
  // In memory: after a plugin reload the next review simply goes to the owner.
  private readonly advised = new Map<string, { verdict: string; hash: string }>();
  // Reviews already opened on this machine, so a retried event does not open a second tab.
  private readonly shown = new Set<string>();

  constructor(
    private readonly linear: Linear,
    private readonly settings: Pick<Settings, "read">,
    private readonly events = plannotatorPaths().events,
    private readonly sessions?: Pick<SessionRouter, "sessionFor" | "plan" | "ask" | "say" | "expectReview">,
    private readonly fetchPlan: (localUrl: string) => Promise<string> = readReviewPlan,
    private readonly handover?: Pick<Handover, "update">,
    private readonly setMode: (agentId: string, modeId: string) => Promise<void> = setAgentMode,
    private readonly reviews?: Pick<ReviewLinks, "opened" | "decided">,
    private readonly decide: (localUrl: string, approve: boolean, feedback: string) => Promise<void> = decidePlannotatorReview,
    private readonly open: (url: string) => void = openInBrowser,
  ) {}

  // The browser hook leaves opening the review to the bridge, so an auto-approved plan never opens
  // a tab: every other review opens once, after the risk policy has had its say.
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
        // An auto-approved plan is decided already; its approval arrives as the next event.
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
    this.timer = setInterval(() => { void this.drain(); }, SWEEP_MS);
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

  onProjectPlan(apply: ProjectPlans): void {
    this.projectPlans = apply;
  }

  // The risk policy (README, "Plan risk and auto-approval"): approves the plan on the owner's
  // behalf when its `## Risk and impact` rating is within the threshold, the advisor review the
  // extension recorded is for exactly this text, and nothing about the ticket needs the owner.
  // A project planner's work order is judged the same way; its approval is applied by the project
  // flow. null: the plan has no readable rating.
  private async judge(localUrl: string, agentId: string, issueId: string, planText: string, settings: PluginSettings): Promise<Judgement | null> {
    const rated = parsePlanRisk(planText);
    if ("problem" in rated) return null;
    const rating = `Risk: ${ratingText(rated.risk)}.`;
    try {
      const state = await this.linear.issueState(issueId);
      const advice = this.advised.get(agentId);
      const outcome = autoApproval(rated.risk, settings.autoApprove, {
        verdict: advice && advice.hash === planHash(planText) ? advice.verdict : null,
        untrusted: isUntrusted(state, await this.linear.viewerId(), await this.linear.appUserId()),
        attended: hasLabel(state.labels, dispatchLabels(settings.dispatch.label).attended.toLowerCase()),
      });
      if (!outcome.approve) return { approved: false, line: `${rating} Needs your approval: ${outcome.reasons.join("; ")}.` };
      await this.decide(localUrl, true, `Auto-approved by the risk policy. ${rating}`);
      return { approved: true, line: `Auto-approved within your threshold. ${rating}` };
    } catch (error) {
      console.error(`[linear-tickets] auto-approval check for ${agentId} failed: ${error instanceof Error ? error.message : error}`);
      return { approved: false, line: `${rating} The auto-approval check failed, so it needs your approval.` };
    }
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
    let event: PlannotatorEvent | null = null;
    try {
      event = parseEvent(await readFile(path, "utf8"));
      if (event?.agentId) await this.deliver(event, event.agentId, paseo);
      else if (event?.type === "opened") this.show(event.localUrl);
      await rm(path, { force: true });
      this.attempts.delete(name);
    } catch (error) {
      const tries = (this.attempts.get(name) ?? 0) + 1;
      console.error(`[linear-tickets] Plannotator event ${name} failed (attempt ${tries}): ${error instanceof Error ? error.message : error}`);
      if (tries < MAX_ATTEMPTS) { this.attempts.set(name, tries); return; }
      // Given up: the review still opens, so it is not lost.
      if (event?.type === "opened") this.show(event.localUrl);
      await rm(path, { force: true });
      this.attempts.delete(name);
    }
  }

  private async deliver(event: PlannotatorEvent, agentId: string, paseo: PaseoApi): Promise<void> {
    if (event.type === "advised") { this.advised.set(agentId, { verdict: event.verdict, hash: event.hash }); return; }
    if (event.type === "skipped") return this.deliverSkip(event, agentId, paseo);
    if (event.type === "decided") {
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
    // The agent's stable link when ReviewLinks is up; otherwise this review's own tailnet or local URL.
    const url = event.type === "opened" ? (await this.reviews?.opened(agentId, event, labels["linear.identifier"] || undefined)) ?? event.remoteUrl ?? event.localUrl : undefined;
    if (event.type === "decided") await this.reviews?.decided(agentId, event.approved);
    const settings = await this.settings.read();
    const planText = event.type === "opened" ? await this.fetchPlan(event.localUrl).catch(() => "") : "";
    const judgement = event.type === "opened" && issueId ? await this.judge(event.localUrl, agentId, issueId, planText, settings) : null;
    if (event.type === "opened" && !judgement?.approved) this.show(event.localUrl);
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
    // A planner's approved work order is applied by the project flow, which closes its ticket and
    // retires the planner: nothing else of an approval (mode, state, plan-ready) applies to it.
    if (event.type === "decided" && event.approved && this.projectPlans && await this.projectPlans(issueId, agentId, event.planContent ?? "", paseo, settings)) {
      await this.linear.upsertIssueDocument(issueId, `Plan: ${identifier}`, planDocument(event, identifier, model))
        .catch((error: unknown) => console.error(`[linear-tickets] ${identifier}: saving the work-order plan failed: ${error instanceof Error ? error.message : error}`));
      return;
    }
    // A required plan started in the provider's safe mode; its approved plan unlocks the usual mode.
    if (event.type === "decided" && event.approved && labels[PLAN_POLICY_LABEL] === "required") {
      const preference = settings.lastProvider ? settings.launchPreferences[settings.lastProvider] : undefined;
      if (preference?.modeId) await this.setMode(agentId, preference.modeId).catch((error: unknown) => console.error(`[linear-tickets] ${identifier}: restoring the agent mode failed: ${error instanceof Error ? error.message : error}`));
    }
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
    if (progress) {
      await progress({ plan: event.approved ? "approved" : `sent back${event.feedback ? ` — ${event.feedback.slice(0, 300)}` : ""}`, ...(documentUrl ? { link: ["Plan", documentUrl] as [string, string] } : {}) });
      return;
    }
    const feedback = event.feedback ? `\n\n${event.feedback.slice(0, 4_000)}` : "";
    await this.linear.comment(issueId, `${event.approved ? "✅ **Plan approved** in Plannotator" : "↩️ **Plan sent back** from Plannotator"}${documentUrl ? ` — [plan](${documentUrl})` : ""}${feedback}`);
  }

  // A skipped plan changes nothing on the ticket but is recorded with its reason, so the owner
  // can check each skip and add the `plan` label when they disagree.
  private async deliverSkip(event: SkippedEvent, agentId: string, paseo: PaseoApi): Promise<void> {
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    const labels = refreshed?.agent.labels ?? {};
    const issueId = labels["paseo.parent-agent-id"] ? undefined : labels["linear.issueId"];
    const identifier = labels["linear.identifier"] || "this ticket";
    await handle.timeline.append({ type: "plugin", id: `plannotator-skipped-${event.at.replace(/[^0-9A-Za-z]/g, "")}`, kind: PLANNOTATOR_KIND, version: 1, data: { title: "Plan skipped by the agent", detail: event.reason } satisfies PlannotatorRow })
      .catch((error: unknown) => console.error(`[linear-tickets] Plannotator chat row for ${agentId} skipped: ${error instanceof Error ? error.message : error}`));
    if (!issueId) return;
    const link = await this.sessions?.sessionFor(agentId);
    if (link) await this.sessions!.say(link.sessionId, "thought", `No plan: ${event.reason}`);
    if (link && this.handover && refreshed?.agent) {
      await this.handover.update({ id: issueId, identifier }, { id: agentId, title: refreshed.agent.title ?? null, cwd: refreshed.agent.cwd }, { plan: `skipped — ${event.reason.slice(0, 300)}`, model: activeModel(refreshed.agent) });
      return;
    }
    await this.linear.comment(issueId, `⏭️ **No plan**: the agent judged this ticket small enough to implement directly. Its reason: ${event.reason}\n\nAdd the \`plan\` label to make it plan first.`);
  }
}
