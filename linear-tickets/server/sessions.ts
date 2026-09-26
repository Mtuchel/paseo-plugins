import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentApi, SelectOption, SessionPlanStep } from "./agent-app";
import { agentAppDirectory } from "./agent-app";
import type { AgentSessionWebhook } from "./agent-webhook";
import { dispatchLabels } from "./dispatch";
import type { LinearService } from "./linear";
import { approvalDecision, questionAnswer, questionsOf } from "./relay";
import type { Settings } from "./settings";
import type { TicketStarter } from "./starter";

const exec = promisify(execFile);
const HANDLED_LIMIT = 200;
const SWEEP_MS = 60_000;
const ADOPT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const APPROVE_PLAN = "approve-plan";
export const SEND_BACK = "send-back";
export const RESUME = "resume";
export const LEAVE = "leave";

export type SessionLink = {
  sessionId: string;
  agentId: string | null;
  issueId: string;
  identifier: string;
  createdAt: string;
  handled: string[];
  // What a plain reply in the panel means right now, besides a pending permission.
  review: { localUrl: string } | null;
  offer: "resume" | null;
};

// sessionId → Paseo agent, persisted so a reload keeps every conversation connected.
export class SessionStore {
  private links: Record<string, SessionLink> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path = join(agentAppDirectory(), "sessions.json")) {}

  private async load(): Promise<Record<string, SessionLink>> {
    if (this.links) return this.links;
    try { this.links = JSON.parse(await readFile(this.path, "utf8")); } catch { this.links = {}; }
    return this.links!;
  }

  private persist(): Promise<void> {
    const run = async () => {
      await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(this.links ?? {}), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async get(sessionId: string): Promise<SessionLink | null> {
    return (await this.load())[sessionId] ?? null;
  }

  // The newest session of an agent: the one its activities go to.
  async forAgent(agentId: string): Promise<SessionLink | null> {
    const links = Object.values(await this.load()).filter((link) => link.agentId === agentId);
    return links.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async put(link: SessionLink): Promise<void> {
    (await this.load())[link.sessionId] = link;
    await this.persist();
  }

  async patch(sessionId: string, change: Partial<SessionLink>): Promise<void> {
    const links = await this.load();
    if (!links[sessionId]) return;
    links[sessionId] = { ...links[sessionId], ...change };
    await this.persist();
  }

  // True the first time an activity is seen; webhook and sweep both deliver prompts.
  async claim(sessionId: string, activityId: string): Promise<boolean> {
    const link = (await this.load())[sessionId];
    if (!link || link.handled.includes(activityId)) return false;
    link.handled = [...link.handled, activityId].slice(-HANDLED_LIMIT);
    await this.persist();
    return true;
  }
}

function paseoCli(): string {
  for (const candidate of [process.env.PASEO_CLI, "/Applications/Paseo.app/Contents/Resources/bin/paseo", join(process.env.HOME ?? "", ".local/bin/paseo")]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "paseo";
}

// Interrupts the agent's running turn. The plugin SDK has no cancel, so the CLI does it.
export async function stopAgentTurn(agentId: string): Promise<void> {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  await exec(paseoCli(), ["stop", agentId], { timeout: 15_000, env });
}

// "SFTP" or "sftp" (a clicked option's value) both select the option labelled SFTP.
export function optionsForQuestion(request: AgentPermissionRequest): SelectOption[] {
  return (questionsOf(request)[0]?.options ?? []).map((option) => option.label ?? "").filter(Boolean).map((label) => ({ label, value: label }));
}

// Checklist entries from a plan's markdown: "- [ ] step", "1. step" or "- step" under a
// Steps heading, falling back to all checkbox lines.
export function planSteps(markdown: string): string[] {
  const lines = markdown.split("\n");
  const checkbox = lines.map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]).filter((text): text is string => Boolean(text));
  if (checkbox.length) return checkbox.slice(0, 30);
  const start = lines.findIndex((line) => /^#{1,4}\s+(steps|implementation|plan)\b/i.test(line));
  if (start < 0) return [];
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line)) break;
    const step = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)?.[1];
    if (step) steps.push(step);
  }
  return steps.slice(0, 30);
}

type Deps = {
  api: AgentApi;
  linear: Pick<LinearService, "viewerId" | "addLabel" | "removeLabel">;
  starter: Pick<TicketStarter, "start">;
  settings: Pick<Settings, "read">;
  store: SessionStore;
  stop?: (agentId: string) => Promise<void>;
  decideReview?: (localUrl: string, approve: boolean, feedback: string, agentId: string) => Promise<void>;
};

// Linear agent sessions ↔ Paseo agents. Inbound: `created` starts or links an agent, and
// `prompted` answers its question, decides its approval or plan review, stops it, or sends a
// message. Outbound: the helpers below post what the agent does into the session.
export class SessionRouter {
  private paseo: PaseoApi | null = null;
  private waiting: AgentSessionWebhook[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly deps: Deps) {}

  attach(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    for (const event of this.waiting.splice(0)) void this.handle(event);
    this.timer = setInterval(() => { void this.sweep(); }, SWEEP_MS);
    this.timer.unref?.();
    void this.sweep();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Entry point for webhooks. Acknowledges `created` right away — Linear marks sessions without
  // an activity within 10 s as unresponsive — even before Paseo is reachable.
  receive(event: AgentSessionWebhook): void {
    if (event.action === "created") void this.say(event.agentSession.id, "thought", "Paseo received this — preparing an agent…").catch(() => {});
    if (!this.paseo) { this.waiting.push(event); return; }
    void this.handle(event);
  }

  private async handle(event: AgentSessionWebhook): Promise<void> {
    try {
      if (event.action === "created") await this.created(event.agentSession);
      else if (event.action === "prompted" && event.agentActivity) await this.prompted(event.agentSession.id, event.agentActivity);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`[linear-tickets] agent session ${event.agentSession.id}: ${message}`);
      await this.say(event.agentSession.id, "error", `Paseo could not handle this: ${message}`).catch(() => {});
    }
  }

  private async owner(): Promise<string> {
    return this.deps.linear.viewerId();
  }

  private async activeAgentFor(issueId: string): Promise<{ id: string; title: string | null } | null> {
    const page = await this.paseo!.agents.list({ filter: { labels: { "linear.issueId": issueId }, includeArchived: false }, page: { limit: 20 } });
    const agent = page.entries.map((entry) => entry.agent).find((candidate) => !candidate.labels?.["paseo.parent-agent-id"]);
    return agent ? { id: agent.id, title: agent.title ?? null } : null;
  }

  async created(session: Record<string, unknown> & { id: string }): Promise<void> {
    const issue = (session.issue ?? {}) as { id?: string; identifier?: string };
    const issueId = String(session.issueId ?? issue.id ?? "");
    const identifier = String(issue.identifier ?? "this ticket");
    if (!issueId) throw new Error("The session has no ticket.");
    if ((await this.deps.store.get(session.id))?.agentId) return;
    // One-person workspace: other integrations acting in Linear must not start agents here.
    if (String(session.creatorId ?? "") !== await this.owner()) {
      await this.say(session.id, "error", "Only the workspace owner can start Paseo agents.");
      return;
    }
    const link: SessionLink = { sessionId: session.id, agentId: null, issueId, identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null };
    const existing = await this.activeAgentFor(issueId);
    if (existing) {
      await this.deps.store.put({ ...link, agentId: existing.id });
      const comment = (session.comment ?? {}) as { body?: string };
      const text = typeof comment.body === "string" && !/^This thread is for an agent session/.test(comment.body) ? comment.body.replace(/@paseo\b/gi, "").trim() : "";
      if (text) await this.paseo!.agents.ref(existing.id).send(text);
      await this.say(session.id, "thought", `Linked to the running agent “${existing.title ?? existing.id}”.${text ? " Your message was passed on." : ""}`);
      return;
    }
    await this.deps.store.put(link);
    await this.startFor(link, false);
  }

  private async startFor(link: SessionLink, fresh: boolean): Promise<void> {
    const settings = await this.deps.settings.read();
    const running = dispatchLabels(settings.dispatch.label).running;
    await this.deps.linear.addLabel(link.issueId, running).catch(() => {});
    try {
      const started = await this.deps.starter.start(link.issueId, this.paseo!, settings, { labels: { "linear.sessionId": link.sessionId }, retryHint: "assign Paseo again", fresh });
      await this.deps.store.patch(link.sessionId, { agentId: started.agentId, offer: null });
      // The stopped agent is closed only after the session points at its successor, so its
      // archive does not offer another resume. Its worktree stays for the new agent.
      if (link.agentId && link.agentId !== started.agentId) await this.paseo!.agents.ref(link.agentId).archive().catch(() => {});
      const warnings = started.warnings.length ? `\n\nWarnings:\n${started.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      await this.say(link.sessionId, "thought", `${started.resumed ? "Resumed the previous agent's work" : "Started"} with ${started.provider} in ${started.target} (Paseo agent ${started.agentId.slice(0, 8)}).${warnings}`);
    } catch (error) {
      await this.deps.linear.removeLabel(link.issueId, running).catch(() => {});
      throw error;
    }
  }

  async prompted(sessionId: string, activity: Record<string, unknown>): Promise<void> {
    const activityId = String(activity.id ?? "");
    const content = (activity.content ?? {}) as { body?: string };
    const body = String(content.body ?? activity.body ?? "").trim();
    const signal = typeof activity.signal === "string" ? activity.signal : null;
    const link = await this.deps.store.get(sessionId);
    if (!link) { await this.say(sessionId, "error", "No Paseo agent is linked to this session. Assign Paseo to the ticket again."); return; }
    if (activityId && !await this.deps.store.claim(sessionId, activityId)) return;
    const userId = typeof activity.userId === "string" ? activity.userId : String(((activity.user ?? {}) as { id?: string }).id ?? "");
    if (userId && userId !== await this.owner()) { await this.say(sessionId, "error", "Only the workspace owner can steer Paseo agents."); return; }

    if (link.offer === "resume") {
      if (body.toLowerCase() === RESUME || /resume/i.test(body)) { await this.startFor(link, false); return; }
      await this.deps.store.patch(sessionId, { offer: null });
      if (body.toLowerCase() === LEAVE) { await this.say(sessionId, "response", "Left as it is. Assign Paseo again whenever you want it continued."); return; }
    }
    if (!link.agentId) { await this.say(sessionId, "error", "The agent for this session has not started yet."); return; }
    const handle = this.paseo!.agents.ref(link.agentId);
    if (signal === "stop") {
      await (this.deps.stop ?? stopAgentTurn)(link.agentId);
      await this.say(sessionId, "response", "Stopped the agent's current turn. Reply here to continue.");
      return;
    }
    if (link.review && this.deps.decideReview) {
      const approve = body.toLowerCase() === APPROVE_PLAN || /^(approve|approved|yes|ok|looks good)\b/i.test(body);
      const feedback = body.toLowerCase() === SEND_BACK ? "Sent back from Linear." : body;
      await this.deps.decideReview(link.review.localUrl, approve, approve ? "" : feedback, link.agentId);
      await this.deps.store.patch(sessionId, { review: null });
      await this.say(sessionId, "thought", approve ? "Plan approved — the agent continues." : "Plan sent back with your feedback.");
      return;
    }
    const pending = (await handle.refresh())?.agent.pendingPermissions ?? [];
    const question = pending.find((request) => request.kind === "question");
    const approval = pending.find((request) => request.kind !== "question");
    if (question) {
      await handle.respondToPermission({ requestId: question.id, response: questionAnswer(question, body) });
      return;
    }
    if (approval) {
      const decision = approvalDecision(body);
      if (!decision) { await this.say(sessionId, "error", `The agent is waiting for approval of “${approval.title || approval.name}”. Choose Approve or Deny.`); return; }
      await handle.respondToPermission({ requestId: approval.id, response: decision });
      return;
    }
    if (!body) return;
    await handle.send(body);
  }

  // Catch-up for missed webhooks: new sessions nobody started, and prompts not yet handled.
  async sweep(): Promise<void> {
    if (this.sweeping || !this.paseo) return;
    this.sweeping = true;
    try {
      const owner = await this.owner();
      for (const session of await this.deps.api.openSessions()) {
        if (!["pending", "active", "awaitingInput"].includes(session.status)) continue;
        const link = await this.deps.store.get(session.id);
        if (!link) {
          if (session.status === "pending" && Date.now() - Date.parse(session.createdAt) < ADOPT_WINDOW_MS && session.issueId) {
            await this.handle({ type: "AgentSessionEvent", action: "created", agentSession: { id: session.id, creatorId: session.creatorId, issueId: session.issueId, issue: { id: session.issueId, identifier: session.identifier } } });
          }
          continue;
        }
        for (const activity of await this.deps.api.activities(session.id)) {
          if (activity.type !== "prompt" || activity.userId !== owner || activity.createdAt < link.createdAt || link.handled.includes(activity.id)) continue;
          await this.handle({ type: "AgentSessionEvent", action: "prompted", agentSession: { id: session.id }, agentActivity: { id: activity.id, content: { body: activity.body }, signal: activity.signal, userId: activity.userId } });
        }
      }
    } catch (error) {
      console.error(`[linear-tickets] agent session sweep failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ---- outbound -------------------------------------------------------------------------

  async sessionFor(agentId: string): Promise<SessionLink | null> {
    return this.deps.store.forAgent(agentId);
  }

  async say(sessionId: string, type: "thought" | "response" | "error", body: string, ephemeral = false): Promise<void> {
    await this.deps.api.activity(sessionId, { type, body }, { ephemeral });
  }

  async action(sessionId: string, action: string, parameter: string, result?: string): Promise<void> {
    await this.deps.api.activity(sessionId, { type: "action", action, parameter, ...(result ? { result } : {}) });
  }

  async ask(sessionId: string, body: string, options: SelectOption[]): Promise<void> {
    await this.deps.api.activity(sessionId, { type: "elicitation", body }, options.length ? { signal: "select", options } : {});
  }

  async plan(sessionId: string, steps: SessionPlanStep[]): Promise<void> {
    await this.deps.api.updateSession(sessionId, { plan: steps });
  }

  async link(sessionId: string, label: string, url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) return;
    await this.deps.api.updateSession(sessionId, { addedExternalUrls: [{ label, url }] });
  }

  async expectReview(sessionId: string, localUrl: string | null): Promise<void> {
    await this.deps.store.patch(sessionId, { review: localUrl ? { localUrl } : null });
  }

  // Automatic retry after a failure, at most once an hour per ticket.
  private readonly lastAutoResume = new Map<string, number>();

  async resumeNow(sessionId: string): Promise<boolean> {
    const link = await this.deps.store.get(sessionId);
    if (!link || !this.paseo) return false;
    const last = this.lastAutoResume.get(link.issueId) ?? 0;
    if (Date.now() - last < 60 * 60 * 1000) return false;
    this.lastAutoResume.set(link.issueId, Date.now());
    await this.startFor(link, false);
    return true;
  }

  async offerResume(sessionId: string): Promise<void> {
    await this.deps.store.patch(sessionId, { offer: "resume" });
    await this.ask(sessionId, "The agent stopped. Continue with a new agent on the same branch?", [{ label: "Resume with a new agent", value: RESUME }, { label: "Leave it", value: LEAVE }]);
  }

  // A label or sidebar launch gets a session too, so the ticket shows the same agent panel.
  async openFor(issueId: string, identifier: string, agentId: string): Promise<string | null> {
    try {
      const sessionId = await this.deps.api.createSessionOnIssue(issueId);
      await this.deps.store.put({ sessionId, agentId, issueId, identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null });
      return sessionId;
    } catch (error) {
      console.error(`[linear-tickets] ${identifier}: could not open an agent session: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }
}

// Decides a waiting Plannotator review through its local server (the same endpoints its page uses).
export async function decidePlannotatorReview(localUrl: string, approve: boolean, feedback: string): Promise<void> {
  const origin = new URL(localUrl).origin;
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) throw new Error("Only local Plannotator reviews can be decided.");
  const response = await fetch(`${origin}/api/${approve ? "approve" : "deny"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(approve ? {} : { feedback }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Plannotator answered HTTP ${response.status}; the review may already be closed.`);
}

