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
import { planHash, type PendingReview, type ReviewOutcome } from "./review-outcome";
import { dispatchLabels } from "./dispatch";
import type { LinearService } from "./linear";
import { answerableQuestions, approvalDecision, deliverToAgent, matchOption, questionAnswer, questionsOf } from "./relay";
import type { Settings } from "./settings";
import type { TicketStarter } from "./starter";

const exec = promisify(execFile);
const HANDLED_LIMIT = 200;
const SWEEP_MS = 60_000;
const ADOPT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const APPROVE_PLAN = "approve-plan";
export const APPROVE_LATER = "approve-later";
export const SEND_BACK = "send-back";
export const SPLIT_PLAN = "split-plan";
export const MAX_SPLIT = 12;
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
  review: PendingReview | null;
  // "split" / "later": the plugin retired the planner on purpose, so no Resume is offered.
  offer: "resume" | "split" | "later" | null;
  // Waiting for blockers or a free agent slot; the sweep starts it when admitted.
  queued?: boolean;
  // A question with several parts, asked one part at a time.
  questions?: { requestId: string; index: number; answers: Record<string, string> } | null;
  // Replaced by a newer thread on the same ticket (every @mention opens one); told so and completed.
  closed?: boolean;
  // The agent the thread's "Open in Paseo" link points at.
  paseoLinked?: string;
};

// Every @mention or assignment opens a new Linear thread, so a ticket collects threads while one
// agent works. Only the newest thread with an agent stays open; older ones on that ticket
// (and their stale review links or resume offers) are superseded.
export function supersededSessions(links: SessionLink[]): { link: SessionLink; current: SessionLink }[] {
  const result: { link: SessionLink; current: SessionLink }[] = [];
  const byIssue = new Map<string, SessionLink[]>();
  for (const link of links) byIssue.set(link.issueId, [...(byIssue.get(link.issueId) ?? []), link]);
  for (const group of byIssue.values()) {
    const current = group.filter((link) => link.agentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!current) continue;
    for (const link of group) if (link !== current && !link.closed && link.createdAt < current.createdAt) result.push({ link, current });
  }
  return result;
}

// sessionId → Paseo agent, persisted so a reload keeps every conversation connected.
export class SessionStore {
  private links: Record<string, SessionLink> | null = null;
  private loading: Promise<Record<string, SessionLink>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path = join(agentAppDirectory(), "sessions.json")) {}

  // One shared read: two concurrent first loads would each replace the map and drop the other's writes.
  private load(): Promise<Record<string, SessionLink>> {
    return this.loading ??= readFile(this.path, "utf8").then((text) => JSON.parse(text) as Record<string, SessionLink>, () => ({})).then((links) => (this.links = links));
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

  async all(): Promise<SessionLink[]> {
    return Object.values(await this.load());
  }

  async put(link: SessionLink): Promise<void> {
    (await this.load())[link.sessionId] = { ...link, handled: [...link.handled] };
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

// Switches an agent's mode (the plugin SDK cannot), e.g. from plan-first back to the usual mode.
export async function setAgentMode(agentId: string, modeId: string): Promise<void> {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  await exec(paseoCli(), ["agent", "mode", agentId, modeId], { timeout: 15_000, env });
}

// Interrupts the agent's running turn. The plugin SDK has no cancel, so the CLI does it.
export async function stopAgentTurn(agentId: string): Promise<void> {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  await exec(paseoCli(), ["stop", agentId], { timeout: 15_000, env });
}

const OTHER_OPTION = /^other\b/i;

// Buttons for one question part. "Other (type your own)" is not a button: typing an answer is.
export function questionPrompt(request: AgentPermissionRequest, index: number): { body: string; options: SelectOption[] } {
  const parts = answerableQuestions(request);
  const part = parts[index]?.question ?? questionsOf(request)[0] ?? {};
  const labels = (part.options ?? []).map((option) => option.label ?? "").filter(Boolean);
  const other = labels.some((label) => OTHER_OPTION.test(label)) || Boolean((part as { allowOther?: boolean }).allowOther);
  const counter = parts.length > 1 ? `(${index + 1}/${parts.length})` : "";
  const title = index === 0 ? [request.title, request.description].filter(Boolean).join("\n\n") : "";
  const question = part.question && part.question !== request.title ? part.question : "";
  return {
    body: [`${[question || title, counter].filter(Boolean).join(" ")}`, index === 0 && question ? title : "", other ? "Or type your own answer." : ""].filter(Boolean).join("\n\n") || "The agent has a question.",
    options: labels.filter((label) => !OTHER_OPTION.test(label)).map((label) => ({ label, value: label })),
  };
}

// "SFTP" or "sftp" (a clicked option's value) both select the option labelled SFTP.
export function optionsForQuestion(request: AgentPermissionRequest): SelectOption[] {
  return questionPrompt(request, 0).options;
}

// The web app opens the agent directly when this browser is paired with the host.
export function paseoAgentUrl(serverId: string, agentId: string): string {
  return `https://app.paseo.sh/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

let serverIdCache: Promise<string | null> | null = null;
export function daemonServerId(): Promise<string | null> {
  serverIdCache ??= exec(paseoCli(), ["daemon", "status", "--json"], { timeout: 15_000 })
    .then(({ stdout }) => { const id = (JSON.parse(stdout) as { serverId?: unknown }).serverId; return typeof id === "string" ? id : null; })
    .catch(() => null);
  return serverIdCache;
}

const LIVE_FLUSH_MS = 4_000;
const HOLD_MS = 5 * 60 * 1000;

// Checklist entries from a plan's markdown: "- [ ] step", "1. step" or "- step" under a
// Steps heading, falling back to all checkbox lines.
export function planSteps(markdown: string): string[] {
  const lines = markdown.split("\n");
  const checkbox = lines.map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]).filter((text): text is string => Boolean(text));
  if (checkbox.length) return checkbox.slice(0, 30);
  // A "Steps" section wins over "Implementation", which wins over a general "Plan" heading.
  const heading = (word: string) => lines.findIndex((line) => new RegExp(`^#{1,4}\\s+${word}\\b`, "i").test(line));
  const start = [heading("steps"), heading("implementation"), heading("plan")].find((index) => index >= 0) ?? -1;
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
  starter: Pick<TicketStarter, "start" | "admission">;
  settings: Pick<Settings, "read">;
  store: SessionStore;
  stop?: (agentId: string) => Promise<void>;
  decideReview?: (localUrl: string, approve: boolean, feedback: string, agentId: string) => Promise<void>;
  splitPlan?: (link: SessionLink, localUrl: string, paseo: PaseoApi) => Promise<string>;
  approveLater?: (link: SessionLink, localUrl: string, paseo: PaseoApi) => Promise<string>;
  // A review decided on Plannotator's own page, found after its server is gone.
  reviewOutcome?: (review: PendingReview) => Promise<ReviewOutcome>;
  recordOutcome?: (agentId: string, outcome: Exclude<ReviewOutcome, "open" | null>) => Promise<void>;
};

// Linear agent sessions ↔ Paseo agents. Inbound: `created` starts or links an agent, and
// `prompted` answers its question, decides its approval or plan review, stops it, or sends a
// message. Outbound: the helpers below post what the agent does into the session.
export class SessionRouter {
  private paseo: PaseoApi | null = null;
  private waiting: AgentSessionWebhook[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  // Agents the user stopped from Linear: a turn the provider starts on its own is stopped again.
  private readonly held = new Map<string, number>();
  // Live action feed per agent during a turn: the subscription and actions not yet posted.
  // `asking`: Linear shows an elicitation's options only while it is the newest activity, so the
  // feed holds its actions from a question until the owner's reply.
  private readonly live = new Map<string, { sessionId: string; stop: () => void; pending: string[]; timer: NodeJS.Timeout | null; posted: number; asking: boolean }>();

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
    for (const state of this.live.values()) { if (state.timer) clearTimeout(state.timer); state.stop(); }
    this.live.clear();
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
      await this.linkToPaseo(session.id, existing.id);
      const comment = (session.comment ?? {}) as { body?: string };
      const text = typeof comment.body === "string" && !/^This thread is for an agent session/.test(comment.body) ? comment.body.replace(/@paseo\b/gi, "").trim() : "";
      // Same as a relayed comment: answers a pending question or decides a pending approval.
      if (text) await deliverToAgent(this.paseo!, existing.id, text);
      await this.say(session.id, "thought", `Linked to the running agent “${existing.title ?? existing.id}”.${text ? " Your message was passed on." : ""}`);
      await this.closeSuperseded();
      return;
    }
    await this.deps.store.put(link);
    const admission = await this.deps.starter.admission(issueId, this.paseo!, await this.deps.settings.read());
    if (!admission.ok) {
      await this.deps.store.patch(session.id, { queued: true });
      await this.say(session.id, "thought", admission.reason);
      return;
    }
    await this.startFor(link, false);
    await this.closeSuperseded();
  }

  // Completes older threads on a ticket once a newer one has the agent, so the ticket shows one
  // live Paseo thread. A reply in a closed thread still reaches the agent.
  async closeSuperseded(): Promise<void> {
    const superseded = supersededSessions(await this.deps.store.all());
    if (!superseded.length) return;
    // Threads Linear already shows as complete are only marked, not told again.
    const open = new Set((await this.deps.api.openSessions()).filter((session) => session.status !== "complete").map((session) => session.id));
    for (const { link, current } of superseded) {
      await this.clearReview(link.sessionId);
      await this.deps.store.patch(link.sessionId, { closed: true, offer: null, questions: null, queued: false });
      if (!open.has(link.sessionId)) continue;
      const title = current.agentId ? (await this.paseo?.agents.ref(current.agentId).refresh().catch(() => null))?.agent.title : null;
      await this.say(link.sessionId, "response", `Continued in the newest Paseo thread on this ticket${title ? ` (agent “${title}”)` : ""}. Follow and reply there; this thread is closed.`).catch(() => {});
    }
  }

  private async startFor(link: SessionLink, fresh: boolean): Promise<void> {
    const settings = await this.deps.settings.read();
    const running = dispatchLabels(settings.dispatch.label).running;
    await this.deps.linear.addLabel(link.issueId, running).catch(() => {});
    try {
      const started = await this.deps.starter.start(link.issueId, this.paseo!, settings, { labels: { "linear.sessionId": link.sessionId }, retryHint: "assign Paseo again", fresh });
      await this.deps.store.patch(link.sessionId, { agentId: started.agentId, offer: null, queued: false });
      // The stopped agent is closed only after the session points at its successor, so its
      // archive does not offer another resume. Its worktree stays for the new agent.
      if (link.agentId && link.agentId !== started.agentId) await this.paseo!.agents.ref(link.agentId).archive().catch(() => {});
      const warnings = started.warnings.length ? `\n\nWarnings:\n${started.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      await this.say(link.sessionId, "thought", `${started.resumed ? "Resumed the previous agent's work" : "Started"} with ${started.provider} in ${started.target} (Paseo agent ${started.agentId.slice(0, 8)}).${started.untrusted ? " This ticket is not yours, so the agent only plans until you approve." : ""}${warnings}`);
      await this.linkToPaseo(link.sessionId, started.agentId);
    } catch (error) {
      await this.deps.linear.removeLabel(link.issueId, running).catch(() => {});
      throw error;
    }
  }

  async prompted(sessionId: string, activity: Record<string, unknown>): Promise<void> {
    for (const [agentId, state] of this.live) {
      if (state.sessionId !== sessionId || !state.asking) continue;
      state.asking = false;
      state.timer ??= setTimeout(() => { void this.flush(agentId); }, LIVE_FLUSH_MS);
    }
    const activityId = String(activity.id ?? "");
    const content = (activity.content ?? {}) as { body?: string };
    let body = String(content.body ?? activity.body ?? "").trim();
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
    // "Approve, implement later": any reply in this session starts the implementing agent.
    if (link.offer === "later") { await this.startFor(link, false); return; }
    if (!link.agentId) { await this.say(sessionId, "error", "The agent for this session has not started yet."); return; }
    const handle = this.paseo!.agents.ref(link.agentId);
    if (signal === "stop") {
      this.held.set(link.agentId, Date.now());
      await (this.deps.stop ?? stopAgentTurn)(link.agentId);
      await this.say(sessionId, "response", "Stopped the agent's current turn. Reply here to continue.");
      return;
    }
    if (link.review && body.toLowerCase() === SPLIT_PLAN && this.deps.splitPlan) {
      // Marked first: the planner is archived during the split, which must not offer a resume.
      await this.deps.store.patch(sessionId, { offer: "split" });
      const summary = await this.deps.splitPlan(link, link.review.localUrl, this.paseo!);
      await this.clearReview(sessionId);
      await this.say(sessionId, "response", summary);
      return;
    }
    if (link.review && body.toLowerCase() === APPROVE_LATER && this.deps.approveLater) {
      await this.deps.store.patch(sessionId, { offer: "later" });
      const summary = await this.deps.approveLater(link, link.review.localUrl, this.paseo!);
      await this.clearReview(sessionId);
      await this.say(sessionId, "response", summary);
      return;
    }
    if (link.review && this.deps.decideReview) {
      const approve = body.toLowerCase() === APPROVE_PLAN || /^(approve|approved|yes|ok|looks good)\b/i.test(body);
      const feedback = body.toLowerCase() === SEND_BACK ? "Sent back from Linear." : body;
      try {
        await this.deps.decideReview(link.review.localUrl, approve, approve ? "" : feedback, link.agentId);
        await this.clearReview(sessionId);
        await this.say(sessionId, "thought", approve ? "Plan approved — the agent continues." : "Plan sent back with your feedback.");
        return;
      } catch (error) {
        if (!(error instanceof ReviewClosedError)) throw error;
        // The review died with its agent process (restart, cancelled turn). The reply still reaches the agent.
        await this.clearReview(sessionId);
        await this.say(sessionId, "thought", "That plan review had already closed, so your reply goes to the agent, which submits the plan again.");
        body = `Your Plannotator plan review closed before the owner decided (for example after a restart). The owner replied in Linear:\n\n${approve ? "Approved." : feedback}\n\nRevise the plan if needed and submit it for review again.`;
      }
    }
    this.held.delete(link.agentId);
    const pending = (await handle.refresh())?.agent.pendingPermissions ?? [];
    const question = pending.find((request) => request.kind === "question");
    const approval = pending.find((request) => request.kind !== "question");
    if (question) {
      const parts = answerableQuestions(question);
      const progress = link.questions?.requestId === question.id ? link.questions : null;
      const answers = { ...(progress?.answers ?? {}) };
      const next = parts.find(({ key }) => answers[key] === undefined);
      if (next) answers[next.key] = matchOption(next.question, body);
      const answered = parts.filter(({ key }) => answers[key] !== undefined).length;
      if (answered < parts.length) {
        await this.deps.store.patch(sessionId, { questions: { requestId: question.id, index: answered, answers } });
        const prompt = questionPrompt(question, answered);
        await this.ask(sessionId, prompt.body, prompt.options);
        return;
      }
      await this.deps.store.patch(sessionId, { questions: null });
      await handle.respondToPermission({ requestId: question.id, response: questionAnswer(question, "", answers) });
      return;
    }
    if (approval) {
      const decision = approvalDecision(body);
      if (!decision) { await this.say(sessionId, "error", `The agent is waiting for approval of “${approval.title || approval.name}”. Choose Approve or Deny.`); return; }
      await handle.respondToPermission({ requestId: approval.id, response: decision });
      // Parallel tool calls wait on several approvals; Linear shows only the newest question, so the next one is asked again.
      const next = pending.find((request) => request.kind !== "question" && request.id !== approval.id);
      if (next) await this.ask(sessionId, `Approve this action?\n\n${[next.title || next.name, next.description].filter(Boolean).join("\n\n")}`, [{ label: "Approve", value: "approve" }, { label: "Deny", value: "deny" }]);
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
      await this.closeSuperseded();
      await this.settleReviews();
      // Threads opened before the link existed (or linked to a newer agent) get "Open in Paseo".
      for (const link of await this.deps.store.all()) if (link.agentId && !link.closed && link.paseoLinked !== link.agentId) await this.linkToPaseo(link.sessionId, link.agentId);
      const owner = await this.owner();
      for (const session of await this.deps.api.openSessions()) {
        // Linear marks a session "stale" after about half an hour without activity, which a ticket
        // waiting for its blockers easily reaches; it still belongs to Paseo.
        const link = await this.deps.store.get(session.id);
        const waiting = Boolean(link?.queued && !link.agentId);
        if (!["pending", "active", "awaitingInput", ...(waiting ? ["stale"] : [])].includes(session.status)) continue;
        if (link?.queued && !link.agentId) {
          const admission = await this.deps.starter.admission(link.issueId, this.paseo, await this.deps.settings.read());
          if (admission.ok) await this.startFor(link, false).catch((error: unknown) => this.say(link.sessionId, "error", `Paseo could not start the agent: ${error instanceof Error ? error.message : error}`));
          continue;
        }
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

  // Sends the agent a new message, the same way a reply in its Linear thread does: Paseo loads a
  // stopped agent and starts a turn. False when the agent is gone or archived.
  async prompt(agentId: string, text: string): Promise<boolean> {
    if (!this.paseo) throw new Error("Paseo is not connected yet.");
    const handle = this.paseo.agents.ref(agentId);
    const refreshed = await handle.refresh().catch((error: unknown) => {
      if (error instanceof Error && /not found/i.test(error.message)) return null;
      throw error;
    });
    if (!refreshed || refreshed.agent.archivedAt) return false;
    await handle.send(text);
    return true;
  }

  async say(sessionId: string, type: "thought" | "response" | "error", body: string, ephemeral = false): Promise<void> {
    await this.deps.api.activity(sessionId, { type, body }, { ephemeral });
  }

  async action(sessionId: string, action: string, parameter: string, result?: string): Promise<void> {
    await this.deps.api.activity(sessionId, { type: "action", action, parameter, ...(result ? { result } : {}) });
  }

  // First part of a pending question (later parts follow each answer).
  async askQuestion(sessionId: string, request: AgentPermissionRequest): Promise<void> {
    await this.deps.store.patch(sessionId, { questions: null });
    const prompt = questionPrompt(request, 0);
    await this.ask(sessionId, prompt.body, prompt.options);
  }

  // Called when a turn starts: a provider restarting on its own right after a Stop is stopped again.
  async holdIfStopped(agentId: string): Promise<boolean> {
    const since = this.held.get(agentId);
    if (since === undefined || Date.now() - since > HOLD_MS) { this.held.delete(agentId); return false; }
    await (this.deps.stop ?? stopAgentTurn)(agentId).catch(() => {});
    const link = await this.deps.store.forAgent(agentId);
    if (link) await this.say(link.sessionId, "thought", "Kept stopped — reply here to continue.").catch(() => {});
    return true;
  }

  // Posts the agent's completed commands and edits while the turn runs, merged at most every 4 s.
  async follow(agentId: string): Promise<void> {
    if (!this.paseo || this.live.has(agentId)) return;
    const link = await this.deps.store.forAgent(agentId);
    if (!link) return;
    const state = { sessionId: link.sessionId, stop: () => {}, pending: [] as string[], timer: null as NodeJS.Timeout | null, posted: 0, asking: false };
    this.live.set(agentId, state);
    const unsubscribe = this.paseo.agents.ref(agentId).timeline.subscribe((event) => {
      if (event.event.type !== "timeline") return;
      const description = describeTool(event.event.item);
      if (!description) return;
      state.pending.push(description);
      state.timer ??= setTimeout(() => { void this.flush(agentId); }, LIVE_FLUSH_MS);
    });
    state.stop = () => unsubscribe();
  }

  private async flush(agentId: string): Promise<void> {
    const state = this.live.get(agentId);
    if (!state) return;
    state.timer = null;
    if (state.asking) return;
    const items = state.pending.splice(0);
    if (!items.length) return;
    state.posted += items.length;
    const [first] = items;
    const [action, ...rest] = first.split(" ");
    await this.action(state.sessionId, items.length === 1 ? action : `${items.length} steps`, items.length === 1 ? rest.join(" ") : items.join("\n").slice(0, 2_000)).catch(() => {});
  }

  // Ends the live feed at turn end; true when it posted anything, so the turn summary skips its action log.
  async unfollow(agentId: string): Promise<boolean> {
    const state = this.live.get(agentId);
    if (!state) return false;
    if (state.timer) clearTimeout(state.timer);
    await this.flush(agentId);
    state.stop();
    this.live.delete(agentId);
    return state.posted > 0;
  }

  async ask(sessionId: string, body: string, options: SelectOption[]): Promise<void> {
    for (const [agentId, state] of this.live) {
      if (state.sessionId !== sessionId) continue;
      if (state.timer) clearTimeout(state.timer);
      await this.flush(agentId);
      state.asking = true;
    }
    await this.deps.api.activity(sessionId, { type: "elicitation", body }, options.length ? { signal: "select", options } : {});
  }

  async plan(sessionId: string, steps: SessionPlanStep[]): Promise<void> {
    await this.deps.api.updateSession(sessionId, { plan: steps });
  }

  async link(sessionId: string, label: string, url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) return;
    await this.deps.api.updateSession(sessionId, { addedExternalUrls: [{ label, url }] });
  }

  // The review a plain reply decides; its tailnet link is shown in the panel while it is open.
  async expectReview(sessionId: string, localUrl: string | null, plan = "", remoteUrl: string | null = null): Promise<void> {
    if (!localUrl) { await this.clearReview(sessionId); return; }
    await this.clearReview(sessionId);
    await this.deps.store.patch(sessionId, { review: { localUrl, openedAt: new Date().toISOString(), ...(remoteUrl ? { remoteUrl } : {}), ...(plan.trim() ? { planHash: planHash(plan) } : {}) } });
    if (remoteUrl) await this.link(sessionId, "Plan review", remoteUrl);
  }

  async clearReview(sessionId: string): Promise<void> {
    const review = (await this.deps.store.get(sessionId))?.review;
    if (!review) return;
    await this.deps.store.patch(sessionId, { review: null });
    if (review.remoteUrl) await this.deps.api.updateSession(sessionId, { removedExternalUrls: [review.remoteUrl] }).catch(() => {});
  }

  // A review whose server is gone was decided on Plannotator's page (or closed without a
  // decision, e.g. by a restart). Its saved decision is recorded like one taken in Linear.
  async settleReviews(): Promise<void> {
    const { reviewOutcome, recordOutcome } = this.deps;
    if (!reviewOutcome || !recordOutcome) return;
    for (const link of await this.deps.store.all()) {
      if (!link.review || link.closed || !link.agentId) continue;
      const outcome = await reviewOutcome(link.review).catch(() => "open" as const);
      if (outcome === "open") continue;
      await this.clearReview(link.sessionId);
      if (outcome) await recordOutcome(link.agentId, outcome);
      else await this.say(link.sessionId, "thought", "The plan review closed without a decision (for example after a restart). Reply here if the agent should submit the plan again.").catch(() => {});
    }
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
    const offer = (await this.deps.store.get(sessionId))?.offer;
    if (offer === "split" || offer === "later") return;
    await this.deps.store.patch(sessionId, { offer: "resume" });
    await this.ask(sessionId, "The agent stopped. Continue with a new agent on the same branch?", [{ label: "Resume with a new agent", value: RESUME }, { label: "Leave it", value: LEAVE }]);
  }

  async linkToPaseo(sessionId: string, agentId: string): Promise<void> {
    const serverId = await daemonServerId();
    if (!serverId) return;
    await this.link(sessionId, "Open in Paseo", paseoAgentUrl(serverId, agentId)).catch(() => {});
    await this.deps.store.patch(sessionId, { paseoLinked: agentId });
  }

  // A label or sidebar launch gets a session too, so the ticket shows the same agent panel.
  async openFor(issueId: string, identifier: string, agentId: string): Promise<string | null> {
    try {
      const sessionId = await this.deps.api.createSessionOnIssue(issueId);
      await this.deps.store.put({ sessionId, agentId, issueId, identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null });
      await this.linkToPaseo(sessionId, agentId);
      return sessionId;
    } catch (error) {
      console.error(`[linear-tickets] ${identifier}: could not open an agent session: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }
}

// Decides a waiting Plannotator review through its local server (the same endpoints its page uses).
// The review's server is gone or no longer takes decisions.
export class ReviewClosedError extends Error {}

export async function decidePlannotatorReview(localUrl: string, approve: boolean, feedback: string): Promise<void> {
  const origin = new URL(localUrl).origin;
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) throw new Error("Only local Plannotator reviews can be decided.");
  const response = await fetch(`${origin}/api/${approve ? "approve" : "deny"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(approve ? {} : { feedback }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    throw new ReviewClosedError(`Plannotator is not reachable at ${origin}: ${error instanceof Error ? error.message : error}`);
  });
  if (!response.ok) throw new ReviewClosedError(`Plannotator answered HTTP ${response.status}; the review is already closed.`);
}


// One line for the live feed, or null for tools not worth showing (reads, searches, thinking).
export function describeTool(item: { type: string; status?: string; detail?: { type: string; command?: string; filePath?: string } }): string | null {
  if (item.type !== "tool_call" || item.status !== "completed" || !item.detail) return null;
  if (item.detail.type === "shell" && item.detail.command) return `Ran ${item.detail.command.slice(0, 200)}`;
  if ((item.detail.type === "edit" || item.detail.type === "write") && item.detail.filePath) return `Edited ${item.detail.filePath}`;
  return null;
}
