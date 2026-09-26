import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { LinearService } from "./linear";
import type { Settings } from "./settings";
import { PLANNOTATOR_OPEN_SOURCE } from "./plannotator-open-source";
import { paseoHome } from "./ticket-mcp";
import { APPROVE_PLAN, planSteps, SEND_BACK, type SessionRouter } from "./sessions";

// The plan text of a running review, from the same endpoint its page loads.
export async function readReviewPlan(localUrl: string): Promise<string> {
  const response = await fetch(`${new URL(localUrl).origin}/api/plan`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) return "";
  const body: unknown = await response.json();
  return body && typeof body === "object" && "plan" in body && typeof body.plan === "string" ? body.plan : "";
}

export const PLANNOTATOR_KIND = "plannotator";
// About a minute of retries at the sweep interval, enough to ride out a Linear hiccup.
const MAX_ATTEMPTS = 20;
const SWEEP_MS = 3_000;
const MAX_PLAN_CHARS = 180_000;

export type PlannotatorRow = { title: string; url?: string; detail?: string };
export type OpenedEvent = { type: "opened"; agentId: string | null; localUrl: string; remoteUrl: string | null; at: string };
export type DecidedEvent = { type: "decided"; agentId: string | null; approved: boolean; feedback?: string; planUri?: string; planContent?: string; at: string };
type PlannotatorEvent = OpenedEvent | DecidedEvent;
type Linear = Pick<LinearService, "comment" | "upsertIssueDocument" | "moveToStateNamed">;

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
  return null;
}

export function planDocument(event: DecidedEvent, identifier: string): string {
  const date = event.at.slice(0, 16).replace("T", " ");
  const plan = (event.planContent ?? "").trim() || "_The plan text was not recorded._";
  return [
    `> **${event.approved ? "Approved" : "Sent back with feedback"}** in Plannotator on ${date} UTC for ${identifier}. Replaced on every review round; the decision comments on the ticket keep the history.`,
    event.feedback ? `\n## Review feedback\n\n${event.feedback}` : "",
    "\n---\n",
    plan.length > MAX_PLAN_CHARS ? `${plan.slice(0, MAX_PLAN_CHARS)}\n\n… (truncated)` : plan,
  ].join("\n");
}

// Plannotator ↔ Paseo ↔ Linear. Plannotator's review URL only reaches omp's UI notices, which
// Paseo does not show, so reviews were invisible. The PLANNOTATOR_BROWSER hook and the omp
// plan extension drop events into a directory; this bridge turns each into a row in the
// agent's Paseo chat and — for agents linked to a ticket — a Linear comment with the tailnet
// link, and on a decision the plan document on the ticket.
export class PlannotatorBridge {
  private paseo: PaseoApi | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private readonly attempts = new Map<string, number>();
  // A decision taken in Linear is also reported by the omp plan extension; the second report
  // within this window is the same decision and is skipped.
  private readonly lastDecision = new Map<string, number>();

  constructor(
    private readonly linear: Linear,
    private readonly settings: Pick<Settings, "read">,
    private readonly events = plannotatorPaths().events,
    private readonly sessions?: Pick<SessionRouter, "sessionFor" | "link" | "plan" | "ask" | "say" | "expectReview">,
    private readonly fetchPlan: (localUrl: string) => Promise<string> = readReviewPlan,
  ) {}

  // The ticket's Linear agent panel: review link, plan checklist and Approve / Send back.
  private async toSession(event: PlannotatorEvent, agentId: string): Promise<void> {
    const sessions = this.sessions;
    if (!sessions) return;
    try {
      const link = await sessions.sessionFor(agentId);
      if (!link) return;
      if (event.type === "opened") {
        if (event.remoteUrl) await sessions.link(link.sessionId, "Plan review", event.remoteUrl);
        const steps = planSteps(await this.fetchPlan(event.localUrl).catch(() => ""));
        if (steps.length) await sessions.plan(link.sessionId, steps.map((content) => ({ content, status: "pending" as const })));
        await sessions.expectReview(link.sessionId, event.localUrl);
        await sessions.ask(link.sessionId, `The plan is ready for review${event.remoteUrl ? ` (full view: ${event.remoteUrl})` : ""}. Approve it, or reply with what to change.`, [{ label: "Approve plan", value: APPROVE_PLAN }, { label: "Send back", value: SEND_BACK }]);
        return;
      }
      await sessions.expectReview(link.sessionId, null);
      if (event.approved && event.planContent) {
        const steps = planSteps(event.planContent);
        if (steps.length) await sessions.plan(link.sessionId, steps.map((content, index) => ({ content, status: index === 0 ? "inProgress" as const : "pending" as const })));
      }
      await sessions.say(link.sessionId, "thought", event.approved ? "Plan approved — starting on it." : `Plan sent back${event.feedback ? `: ${event.feedback.slice(0, 1_000)}` : ""}.`);
    } catch (error) {
      console.error(`[linear-tickets] Plannotator session update for ${agentId} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  attach(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    // A cheap directory sweep; fs.watch proved unreliable for files renamed into place.
    this.timer = setInterval(() => { void this.drain(); }, SWEEP_MS);
    this.timer.unref?.();
    void this.drain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    try {
      const event = parseEvent(await readFile(path, "utf8"));
      if (event?.agentId) await this.deliver(event, event.agentId, paseo);
      await rm(path, { force: true });
      this.attempts.delete(name);
    } catch (error) {
      const tries = (this.attempts.get(name) ?? 0) + 1;
      console.error(`[linear-tickets] Plannotator event ${name} failed (attempt ${tries}): ${error instanceof Error ? error.message : error}`);
      if (tries >= MAX_ATTEMPTS) { await rm(path, { force: true }); this.attempts.delete(name); } else this.attempts.set(name, tries);
    }
  }

  private async deliver(event: PlannotatorEvent, agentId: string, paseo: PaseoApi): Promise<void> {
    if (event.type === "decided") {
      const previous = this.lastDecision.get(agentId);
      const at = Date.parse(event.at) || Date.now();
      if (previous !== undefined && Math.abs(at - previous) < 120_000) return;
      this.lastDecision.set(agentId, at);
    }
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    const labels = refreshed?.agent.labels ?? {};
    const issueId = labels["paseo.parent-agent-id"] ? undefined : labels["linear.issueId"];
    const identifier = labels["linear.identifier"] || "this ticket";
    const url = event.type === "opened" ? event.remoteUrl ?? event.localUrl : undefined;
    const row: PlannotatorRow = event.type === "opened"
      ? { title: "Handed off to Plannotator for review", url, detail: event.remoteUrl ? "Opens on any device in your tailnet." : "Local link only: Tailscale was unavailable." }
      : { title: event.approved ? "Plan approved in Plannotator" : "Plan sent back from Plannotator", ...(event.feedback ? { detail: event.feedback.slice(0, 4_000) } : {}) };
    await handle.timeline.append({ type: "plugin", id: `plannotator-${event.type}-${event.at.replace(/[^0-9A-Za-z]/g, "")}`, kind: PLANNOTATOR_KIND, version: 1, data: row });
    await this.toSession(event, agentId);
    if (!issueId) return;
    // Planning while a plan is out for review (and after it is sent back); coding once approved.
    if ((await this.settings.read()).writeback.status) {
      const moved = await this.linear.moveToStateNamed(issueId, event.type === "decided" && event.approved ? CODING_STATE : PLANNING_STATE);
      if (moved.note) console.error(`[linear-tickets] ${identifier}: ${moved.note}`);
    }
    if (event.type === "opened") {
      await this.linear.comment(issueId, `📋 **Plan ready for review in Plannotator**: ${url}${event.remoteUrl ? "" : "\n\n(Local link only: Tailscale was unavailable on the host.)"}`);
      return;
    }
    const documentUrl = await this.linear.upsertIssueDocument(issueId, `Plan: ${identifier}`, planDocument(event, identifier));
    const feedback = event.feedback ? `\n\n${event.feedback.slice(0, 4_000)}` : "";
    await this.linear.comment(issueId, `${event.approved ? "✅ **Plan approved** in Plannotator" : "↩️ **Plan sent back** from Plannotator"}${documentUrl ? ` — [plan](${documentUrl})` : ""}${feedback}`);
  }
}
