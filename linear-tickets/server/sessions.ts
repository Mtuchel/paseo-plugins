import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentApi, SelectOption, SessionPlanStep } from "./agent-app";
import { agentAppDirectory } from "./agent-app";
import type { AgentSessionWebhook } from "./agent-webhook";
import { groupProgress, groupStatus, isGroup } from "./groups";
import { planHash, type PendingReview, type ReviewOutcome } from "./review-outcome";
import { dispatchLabels } from "./dispatch";
import type { IssueGroup, LinearService } from "./linear";
import { CODING_STATE } from "./plannotator";
import { closeAnswered, type NeedsYouIssues } from "./needs-you";
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

// A crashed agent: Paseo shows it in error and its provider process exited or is closed (OMP:
// "OMP RPC process exited with code 1 …", "OMP RPC process is closed"). A message reaches nobody
// until the agent is reloaded. An agent in error for another reason (a failed API call) still has
// its process and takes messages.
const CLOSED_PROCESS = /\bprocess (exited|is closed)\b/i;

export function crashedProcess(agent: { status?: string; lastError?: string | null }): string | null {
  return agent.status === "error" && agent.lastError && CLOSED_PROCESS.test(agent.lastError) ? agent.lastError : null;
}

// What a restarted agent is sent: the crash, the git state to check first, then the message it
// would have got. It can arrive twice (see PullRequestWatch's pending resumes).
export function crashResume(error: string, next: string): string {
  return [
    `Your previous run crashed (\`${error}\`), and Paseo restarted you. Before anything else, run \`git status\` in your worktree: if a rebase is in progress, finish it (\`git rebase --continue\` once its conflicts are resolved) or abort it (\`git rebase --abort\`) and redo that step; the same for an interrupted merge or cherry-pick. Check the current state of your pull requests and lifecycle step before acting (this message can arrive twice). Then continue with the step below.`,
    "",
    next,
  ].join("\n");
}

// `restarted`: the agent had crashed, was reloaded and got the resume. `reloaded`: it was reloaded,
// but the resume did not go out (busy right after, or the send failed). `crashed`: it is crashed and
// was not (or could not be) reloaded; nothing was sent.
export type PromptOutcome = "sent" | "restarted" | "reloaded" | "crashed" | "busy" | "gone" | "unavailable";
// How a crashed agent is recovered: `before` runs with the resume text and the crash right before
// the reload, so the caller can claim the attempt and keep the resume until it went out.
export type Recovery = { issueId: string; before: (resume: string, error: string) => Promise<void> };
type Snapshot = { status?: string; lastError?: string | null; activeTurn?: unknown; pendingPermissions?: unknown[] | null; archivedAt?: string | null; labels?: Record<string, string> | null; id?: string };

// Running, starting, in a turn or waiting for an answer: a message would interrupt the turn or drop
// the question.
function busy(agent: Snapshot): boolean {
  return Boolean(agent.activeTurn || agent.status === "running" || agent.status === "initializing" || agent.pendingPermissions?.length);
}

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
  // "parked": its plan waits for the owner in the central Plannotator host (parked.ts).
  offer: "resume" | "split" | "later" | "parked" | null;
  // Waiting for blockers or a free agent slot; the sweep starts it when admitted.
  queued?: boolean;
  // A question with several parts, asked one part at a time.
  questions?: { requestId: string; index: number; answers: Record<string, string> } | null;
  // Replaced by a newer thread on the same ticket (every @mention opens one); told so and completed.
  closed?: boolean;
  // The agent the thread's "Open in Paseo" link points at.
  paseoLinked?: string;
  // Handed to Paseo as a group (groups.ts): no agent of its own; its sub-issues are handed out and
  // it closes when they are finished. `delegated`: the ticket was assigned to Paseo when the group
  // started, so unassigning it stops the group. `status`: the last status posted in the panel.
  group?: { delegated: boolean; status?: string };
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
  linear: Pick<LinearService, "viewerId" | "appUserId" | "addLabel" | "removeLabel" | "complete" | "cancel" | "issueState" | "issueGroup" | "delegate" | "moveToStateNamed">;
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
  // Open "Needs you" sub-issues: an @mention there goes to the agent that asked, not a new one.
  needsYou?: NeedsYouIssues;
  // The daemon's agent reload (`paseo agent reload`), resolved per use: null while the plugin has
  // no daemon connection of its own.
  reloader?: () => Promise<((agentId: string) => Promise<void>) | null>;
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
    const known = await this.deps.store.get(session.id);
    if (known?.agentId || known?.group) return;
    // One-person workspace: other integrations acting in Linear must not start agents here.
    if (String(session.creatorId ?? "") !== await this.owner()) {
      await this.say(session.id, "error", "Only the workspace owner can start Paseo agents.");
      return;
    }
    const link: SessionLink = { sessionId: session.id, agentId: null, issueId, identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null };
    const asked = (await this.deps.needsYou?.all())?.find((entry) => entry.id === issueId);
    const existing = asked
      ? { id: asked.agentId, title: (await this.paseo!.agents.ref(asked.agentId).refresh().catch(() => null))?.agent.title ?? null }
      : await this.activeAgentFor(issueId);
    if (existing) {
      await this.deps.store.put({ ...link, agentId: existing.id });
      await this.linkToPaseo(session.id, existing.id);
      const comment = (session.comment ?? {}) as { body?: string };
      const text = typeof comment.body === "string" && !/^This thread is for an agent session/.test(comment.body) ? comment.body.replace(/@paseo\b/gi, "").trim() : "";
      // Same as a relayed comment: answers a pending question or decides a pending approval.
      if (text) await deliverToAgent(this.paseo!, existing.id, text);
      if (text && asked) await closeAnswered(this.deps.needsYou!, this.deps.linear, issueId);
      await this.say(session.id, "thought", `Linked to the running agent “${existing.title ?? existing.id}”.${text ? " Your message was passed on." : ""}`);
      await this.closeSuperseded();
      return;
    }
    if (await this.startGroup(link)) return;
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

  // A new agent for the thread's ticket. It runs in the ticket's turn (see exclusive), so a crash
  // recovery of the predecessor waits until the successor started and the predecessor is archived.
  private startFor(link: SessionLink, fresh: boolean): Promise<void> {
    return this.exclusive(link.issueId, () => this.startNow(link, fresh));
  }

  private async startNow(link: SessionLink, fresh: boolean): Promise<void> {
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
      const plan = started.plan === "required"
        ? started.untrusted ? " This ticket is not yours, so its plan waits for your approval." : " The agent plans first; a plan within your risk threshold is approved automatically, any other waits for you."
        : "";
      await this.say(link.sessionId, "thought", `${started.resumed ? "Resumed the previous agent's work" : "Started"} with ${started.provider} in ${started.target} (Paseo agent ${started.agentId.slice(0, 8)}).${plan}${warnings}`);
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
    if (link.group && link.closed) { await this.say(sessionId, "response", `Paseo no longer hands out ${link.identifier}'s sub-issues. Assign Paseo to it again to continue.`); return; }
    if (link.group && !link.review) {
      if (signal === "stop") {
        await this.deps.store.patch(sessionId, { closed: true });
        await this.say(sessionId, "response", "Stopped handing out sub-issues. Agents already working continue; assign Paseo again to continue.");
        return;
      }
      // Any reply asks for the current status, posted even when it has not changed.
      await this.advanceGroup({ ...link, group: { ...link.group, status: undefined } });
      return;
    }
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
      // The steps are the parent's sub-issues now: the parent closes when they are finished.
      await this.deps.store.patch(sessionId, { group: { delegated: false } });
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
        await this.say(sessionId, "thought", approve ? "Plan approved." : "Plan sent back with your feedback.");
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

  // Threads waiting for blockers or an agent slot. Read from the store, not from `openSessions`:
  // that is Linear's 50 most recently updated sessions in the whole workspace, and a waiting
  // thread posts nothing, so it drops out of that list hours before a slow blocker finishes.
  // Each thread is tried on its own: a failed read leaves it queued for the next sweep, a failed
  // start ends the wait with an error in the thread (as for a ticket that was never queued).
  async startQueued(): Promise<void> {
    for (const link of await this.deps.store.all()) {
      if (!link.queued || link.agentId || link.closed) continue;
      try {
        const admission = await this.deps.starter.admission(link.issueId, this.paseo!, await this.deps.settings.read());
        if (!admission.ok) continue;
        // The owner may have ended the thread or closed the ticket while it waited.
        const status = await this.deps.api.sessionStatus(link.sessionId);
        if (!status || status === "complete" || status === "error") {
          await this.deps.store.patch(link.sessionId, { queued: false });
          console.log(`[linear-tickets] ${link.identifier}: queued thread ended in Linear (${status ?? "gone"}); no agent started`);
          continue;
        }
        const ticket = await this.deps.linear.issueState(link.issueId);
        if (ticket.statusType === "completed" || ticket.statusType === "canceled") {
          await this.deps.store.patch(link.sessionId, { queued: false });
          await this.say(link.sessionId, "response", `${link.identifier} was moved to ${ticket.status} while it waited, so no agent was started. Assign Paseo again to start one.`);
          continue;
        }
        // Another path (the trigger label, a newer thread) may have started the ticket's agent meanwhile.
        const existing = await this.activeAgentFor(link.issueId);
        if (existing) {
          await this.deps.store.patch(link.sessionId, { agentId: existing.id, queued: false });
          await this.linkToPaseo(link.sessionId, existing.id);
          await this.say(link.sessionId, "thought", `Linked to the running agent “${existing.title ?? existing.id}”.`);
          continue;
        }
      } catch (error) {
        console.error(`[linear-tickets] ${link.identifier}: checking the queued thread failed: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      try {
        await this.startFor(link, false);
      } catch (error) {
        if ((await this.deps.store.get(link.sessionId))?.agentId) {
          console.error(`[linear-tickets] ${link.identifier}: queued agent started, reporting it failed: ${error instanceof Error ? error.message : error}`);
          continue;
        }
        await this.deps.store.patch(link.sessionId, { queued: false });
        await this.say(link.sessionId, "error", `Paseo could not start the agent: ${error instanceof Error ? error.message : error}`).catch(() => {});
      }
    }
  }

  // A ticket with open sub-issues is worked on through them instead of by an agent of its own:
  // each open sub-issue nobody else has is assigned to Paseo (its own thread then starts it once
  // its blockers are finished), and the ticket closes when all of them are finished.
  private async startGroup(link: SessionLink, read?: { group: IssueGroup; appId: string }): Promise<boolean> {
    const known = read ?? await this.readGroup(link.issueId);
    if (!isGroup(groupProgress(known.group, await this.owner(), known.appId, await this.ownLabels()))) return false;
    const group = { delegated: known.group.delegateId === known.appId };
    await this.deps.store.put({ ...link, group });
    for (const other of await this.deps.store.all()) {
      if (other.issueId !== link.issueId || !other.group || other.closed || other.sessionId === link.sessionId) continue;
      await this.deps.store.patch(other.sessionId, { closed: true });
      await this.say(other.sessionId, "response", "Continued in the newest Paseo thread on this ticket. Follow and reply there; this thread is closed.").catch(() => {});
    }
    await this.say(link.sessionId, "thought", `${link.identifier} has open sub-issues, so Paseo works on them instead of on ${link.identifier} itself: each one is assigned to Paseo and starts once its blockers are finished. ${link.identifier} closes when they are all finished.`);
    await this.advanceGroup({ ...link, group }, known);
    return true;
  }

  // A labelled ticket with open sub-issues becomes a group too: it is assigned to Paseo, whose
  // thread hands out the sub-issues. True when the ticket is a group; without a usable Paseo app
  // there are no threads, so the ticket starts an agent like any other.
  async handOffGroup(issueId: string): Promise<boolean> {
    if (!await this.deps.linear.appUserId()) return false;
    const known = await this.readGroup(issueId);
    if (!isGroup(groupProgress(known.group, await this.owner(), known.appId, await this.ownLabels()))) return false;
    // Assigning opens the ticket's thread, which starts the group (`created`).
    if (known.group.delegateId !== known.appId) { await this.deps.linear.delegate(issueId, known.appId); return true; }
    if ((await this.deps.store.all()).some((other) => other.issueId === issueId && other.group && !other.closed)) return true;
    const sessionId = await this.deps.api.createSessionOnIssue(issueId);
    await this.startGroup({ sessionId, agentId: null, issueId, identifier: known.group.identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null }, known);
    return true;
  }

  private async readGroup(issueId: string): Promise<{ group: IssueGroup; appId: string }> {
    const appId = await this.deps.linear.appUserId();
    if (!appId) throw new Error("The Paseo Linear app is not usable on this host, so sub-issues cannot be assigned to it.");
    return { group: await this.deps.linear.issueGroup(issueId), appId };
  }

  // Sub-issues the plugin made for the owner (manual tasks, "Needs you" questions): never group members.
  private async ownLabels(): Promise<string[]> {
    const labels = dispatchLabels((await this.deps.settings.read()).dispatch.label);
    return [labels.manual, labels.needsYou];
  }

  async advanceGroups(): Promise<void> {
    for (const link of await this.deps.store.all()) {
      if (!link.group || link.closed) continue;
      try {
        await this.advanceGroup({ ...link, group: link.group });
      } catch (error) {
        console.error(`[linear-tickets] ${link.identifier}: advancing the group failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Hands out the group's new sub-issues once the parent itself is not blocked, closes the parent
  // when every sub-issue is finished, and posts what each one waits for whenever that changes.
  // One advance per thread at a time: the minute sweep, a reply and the thread's start can overlap,
  // and two would close the parent or post the same status twice. A skipped one is redone next minute.
  private readonly advancing = new Set<string>();
  private async advanceGroup(link: SessionLink & { group: NonNullable<SessionLink["group"]> }, read?: { group: IssueGroup; appId: string }): Promise<void> {
    if (this.advancing.has(link.sessionId)) return;
    this.advancing.add(link.sessionId);
    try {
      await this.stepGroup(link, read);
    } finally {
      this.advancing.delete(link.sessionId);
    }
  }

  private async stepGroup(link: SessionLink & { group: NonNullable<SessionLink["group"]> }, read?: { group: IssueGroup; appId: string }): Promise<void> {
    const { group, appId } = read ?? await this.readGroup(link.issueId);
    const end = async (body: string) => {
      await this.deps.store.patch(link.sessionId, { closed: true });
      await this.say(link.sessionId, "response", body);
    };
    if (["completed", "canceled", "duplicate"].includes(group.statusType)) return end(`${link.identifier} was moved to ${group.status}, so Paseo stopped handing out its sub-issues.`);
    if (link.group.delegated && group.delegateId !== appId) return end(`Paseo was unassigned from ${link.identifier}, so it stopped handing out sub-issues. Agents already working continue.`);
    const progress = groupProgress(group, await this.owner(), appId, await this.ownLabels());
    if (progress.finished) {
      const list = progress.members.map((child) => `- ${child.identifier}: ${child.status}`).join("\n");
      if (progress.outcome === "canceled") await this.deps.linear.cancel(link.issueId, `Every sub-issue was canceled, so ${link.identifier} is canceled too.\n\n${list}`);
      else await this.deps.linear.complete(link.issueId);
      return end(`All sub-issues are finished, so ${link.identifier} is ${progress.outcome === "canceled" ? "canceled" : "done"}.\n\n${list}`);
    }
    let parentBlockers: string[] = [];
    const failures: string[] = [];
    if (progress.handOut.length) {
      const parent = await this.deps.linear.issueState(link.issueId);
      parentBlockers = parent.blockedBy;
      if (!parentBlockers.length) {
        for (const child of progress.handOut) {
          try {
            await this.deps.linear.delegate(child.id, appId);
            child.delegateId = appId;
          } catch (error) {
            failures.push(`Could not assign ${child.identifier} to Paseo: ${error instanceof Error ? error.message : error}`);
          }
        }
        if (progress.handOut.some((child) => child.delegateId === appId)) {
          const moved = await this.deps.linear.moveToStateNamed(link.issueId, CODING_STATE, parent).catch((error: unknown) => ({ changed: false, note: error instanceof Error ? error.message : String(error) }));
          if (moved.note) console.error(`[linear-tickets] ${link.identifier}: ${moved.note}`);
        }
      }
    }
    const agents = new Map<string, "working" | "queued" | "group">();
    for (const other of await this.deps.store.all()) {
      if (other.closed || agents.get(other.issueId) === "working") continue;
      if (other.group) agents.set(other.issueId, "group");
      else if (other.agentId) agents.set(other.issueId, "working");
      else if (other.queued) agents.set(other.issueId, "queued");
    }
    const status = [groupStatus(link.identifier, progress, appId, agents, parentBlockers), ...failures].join("\n");
    if (status === link.group.status) return;
    await this.deps.store.patch(link.sessionId, { group: { ...link.group, status } });
    await this.say(link.sessionId, "thought", status);
  }

  // Catch-up for missed webhooks: queued threads now admitted, new sessions nobody started, and prompts
  // not yet handled. Each part runs on its own, so one failed Linear request skips only the part it hit.
  async sweep(): Promise<void> {
    if (this.sweeping || !this.paseo) return;
    this.sweeping = true;
    try {
      await this.sweepPart("queued threads", () => this.startQueued());
      await this.sweepPart("groups", () => this.advanceGroups());
      await this.sweepPart("superseded threads", () => this.closeSuperseded());
      await this.sweepPart("reviews", () => this.settleReviews());
      // Threads opened before the link existed (or linked to a newer agent) get "Open in Paseo".
      await this.sweepPart("Open in Paseo links", async () => {
        for (const link of await this.deps.store.all()) if (link.agentId && !link.closed && link.paseoLinked !== link.agentId) await this.linkToPaseo(link.sessionId, link.agentId);
      });
      await this.sweepPart("missed replies", () => this.catchUp());
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepPart(part: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      console.error(`[linear-tickets] agent session sweep (${part}) failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // New sessions nobody started and prompts not yet handled. A thread whose read fails is tried
  // again next minute; the threads after it go ahead.
  private async catchUp(): Promise<void> {
    const owner = await this.owner();
    const sessions = await this.deps.api.openSessions();
    const failures: string[] = [];
    for (const session of sessions) {
      try {
        const link = await this.deps.store.get(session.id);
        // Still waiting: `startQueued` owns it.
        if (link?.queued && !link.agentId) continue;
        if (!["pending", "active", "awaitingInput"].includes(session.status)) continue;
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
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) throw new Error(`${failures.length} of ${sessions.length} threads skipped until the next sweep: ${failures[0]}`);
  }

  // ---- outbound -------------------------------------------------------------------------

  async sessionFor(agentId: string): Promise<SessionLink | null> {
    return this.deps.store.forAgent(agentId);
  }

  // Sends an idle agent a new message, the same way a reply in its Linear thread does: Paseo loads
  // a stopped agent and starts a turn. Nothing is sent while the agent is in a turn or waiting for
  // an answer (Paseo would interrupt the turn or drop the question): `busy`. `gone`: the agent no
  // longer exists or is archived; `unavailable`: Paseo is not connected, try again later.
  // `onDispatch` runs once the agent is known to take it, right before the message is sent.
  // A crashed agent (see crashedProcess) takes no message: `crashed`, unless `recovery` asks to
  // reload it and send it the resume (see recover).
  async prompt(agentId: string, text: string, onDispatch?: () => Promise<void>, recovery?: Recovery): Promise<PromptOutcome> {
    if (!this.paseo) return "unavailable";
    const found = await this.agent(agentId);
    if (!found) return "gone";
    if (busy(found.agent)) return "busy";
    if (!crashedProcess(found.agent)) {
      await onDispatch?.();
      await found.handle.send(text);
      return "sent";
    }
    if (!recovery) return "crashed";
    return this.exclusive(recovery.issueId, () => this.recover(agentId, text, onDispatch, recovery));
  }

  // The crashed process of an existing, unarchived agent (its last error), else null.
  async crashed(agentId: string): Promise<string | null> {
    if (!this.paseo) return null;
    const found = await this.agent(agentId);
    return found ? crashedProcess(found.agent) : null;
  }

  // Reloads a crashed agent (as `paseo agent reload` does) and sends it the resume, in its ticket's
  // turn: an earlier recovery or a successor start for the ticket has finished, so the agent is read
  // and judged again first. A live, uncrashed agent of the same ticket is taking over (`busy`).
  // `before` claims the attempt right before the reload; nothing after it throws: the reload
  // throwing or leaving the agent in error is `crashed`, a resume that does not go out `reloaded`.
  private async recover(agentId: string, text: string, onDispatch: (() => Promise<void>) | undefined, recovery: Recovery): Promise<PromptOutcome> {
    const found = await this.agent(agentId);
    if (!found) return "gone";
    if (busy(found.agent)) return "busy";
    const error = crashedProcess(found.agent);
    if (!error) {
      await onDispatch?.();
      await found.handle.send(text);
      return "sent";
    }
    const page = await this.paseo!.agents.list({ filter: { labels: { "linear.issueId": recovery.issueId }, includeArchived: false }, page: { limit: 20 } });
    if (page.entries.some(({ agent }) => agent.id !== agentId && !agent.archivedAt && !agent.labels?.["paseo.parent-agent-id"] && !crashedProcess(agent))) return "busy";
    const reload = await this.deps.reloader?.();
    if (!reload) return "unavailable";
    const resume = crashResume(error, text);
    await recovery.before(resume, error);
    try {
      await reload(agentId);
    } catch (failure) {
      console.error(`[linear-tickets] reloading crashed agent ${agentId} failed: ${failure instanceof Error ? failure.message : failure}`);
      return "crashed";
    }
    const reloaded = await this.agent(agentId).catch((failure: unknown) => {
      console.error(`[linear-tickets] reading restarted agent ${agentId} failed: ${failure instanceof Error ? failure.message : failure}`);
      return undefined;
    });
    if (reloaded === undefined) return "reloaded";
    if (!reloaded) return "gone";
    if (reloaded.agent.status === "error") return "crashed";
    if (busy(reloaded.agent)) return "reloaded";
    try {
      await reloaded.handle.send(resume);
    } catch (failure) {
      console.error(`[linear-tickets] the resume for restarted agent ${agentId} failed: ${failure instanceof Error ? failure.message : failure}`);
      return "reloaded";
    }
    return "restarted";
  }

  // The agent's current snapshot; null when it no longer exists or is archived.
  private async agent(agentId: string): Promise<{ handle: PaseoAgentHandle; agent: Snapshot } | null> {
    const handle = this.paseo!.agents.ref(agentId);
    const refreshed = await handle.refresh().catch((error: unknown) => {
      if (error instanceof Error && /not found/i.test(error.message)) return null;
      throw error;
    });
    return refreshed && !refreshed.agent.archivedAt ? { handle, agent: refreshed.agent } : null;
  }

  // One recovery or successor start per ticket at a time, in call order.
  private readonly turns = new Map<string, Promise<unknown>>();

  private exclusive<T>(issueId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.turns.get(issueId) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    this.turns.set(issueId, settled);
    void settled.then(() => { if (this.turns.get(issueId) === settled) this.turns.delete(issueId); });
    return run;
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
      // A parked plan's review moves to the central host, which may restart: it stays bound.
      if (!link.review || link.closed || !link.agentId || link.offer === "parked") continue;
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

  // A project planner without a live agent (README, "Projects"): a new agent and a new thread, as
  // for a label launch, admitted like any start. Its earlier thread cannot be reused: one whose
  // launch failed is in error in Linear, and Linear opens no new thread when the ticket is assigned
  // to Paseo again. Its stopped agents are archived once the new one runs, so a later reply or
  // mention never reaches them, and its earlier threads are closed as superseded.
  async restartFor(issueId: string, identifier: string): Promise<void> {
    if (!this.paseo) throw new Error("Paseo is not connected yet.");
    const settings = await this.deps.settings.read();
    const admission = await this.deps.starter.admission(issueId, this.paseo, settings);
    if (!admission.ok) throw new Error(admission.reason);
    const stopped = new Set((await this.deps.store.all()).filter((link) => link.issueId === issueId && link.agentId).map((link) => link.agentId!));
    const running = dispatchLabels(settings.dispatch.label).running;
    await this.deps.linear.addLabel(issueId, running).catch(() => {});
    let agentId: string;
    try {
      agentId = (await this.deps.starter.start(issueId, this.paseo, settings, { retryHint: "the project's next read starts it again" })).agentId;
    } catch (error) {
      await this.deps.linear.removeLabel(issueId, running).catch(() => {});
      throw error;
    }
    await this.openFor(issueId, identifier, agentId);
    for (const old of stopped) if (old !== agentId) await this.paseo.agents.ref(old).archive().catch(() => {});
    await this.closeSuperseded();
  }

  async offerResume(sessionId: string): Promise<void> {
    const offer = (await this.deps.store.get(sessionId))?.offer;
    if (offer === "split" || offer === "later" || offer === "parked") return;
    await this.deps.store.patch(sessionId, { offer: "resume" });
    await this.ask(sessionId, "The agent stopped. Continue with a new agent on the same branch?", [{ label: "Resume with a new agent", value: RESUME }, { label: "Leave it", value: LEAVE }]);
  }

  // The plan waits for the owner in the central Plannotator host and its agent is retired: no
  // Resume is offered, and the review is bound again once the host serves the plan.
  async parked(agentId: string): Promise<void> {
    const link = await this.sessionFor(agentId);
    if (!link) return;
    await this.deps.store.patch(link.sessionId, { offer: "parked" });
    await this.clearReview(link.sessionId);
  }

  // The owner decided a parked plan: the thread waits for a slot like a queued one, and the queue
  // sweep starts a fresh agent that implements the approved plan or plans again. False: no thread.
  async requeue(agentId: string, note: string): Promise<boolean> {
    const link = await this.sessionFor(agentId);
    if (!link) return false;
    await this.clearReview(link.sessionId);
    await this.deps.store.patch(link.sessionId, { agentId: null, queued: true, offer: null });
    await this.say(link.sessionId, "thought", note);
    return true;
  }

  async linkToPaseo(sessionId: string, agentId: string): Promise<void> {
    const serverId = await daemonServerId();
    if (!serverId) return;
    await this.link(sessionId, "Open in Paseo", paseoAgentUrl(serverId, agentId)).catch(() => {});
    await this.deps.store.patch(sessionId, { paseoLinked: agentId });
  }

  // A label or sidebar launch gets a session too, so the ticket shows the same agent panel, and
  // is delegated to the Paseo app like a ticket assigned in Linear: a ticket with an agent always
  // names Paseo. Delegated only after the session links the agent, so the delegation cannot start
  // a second one; a failed delegation keeps the session.
  async openFor(issueId: string, identifier: string, agentId: string): Promise<string | null> {
    let sessionId: string;
    try {
      sessionId = await this.deps.api.createSessionOnIssue(issueId);
      await this.deps.store.put({ sessionId, agentId, issueId, identifier, createdAt: new Date().toISOString(), handled: [], review: null, offer: null });
      await this.linkToPaseo(sessionId, agentId);
    } catch (error) {
      console.error(`[linear-tickets] ${identifier}: could not open an agent session: ${error instanceof Error ? error.message : error}`);
      return null;
    }
    try {
      await this.deps.linear.delegate(issueId, (await this.deps.api.viewer()).id);
    } catch (error) {
      console.error(`[linear-tickets] ${identifier}: could not delegate the ticket to Paseo: ${error instanceof Error ? error.message : error}`);
    }
    return sessionId;
  }
}

// Decides a waiting Plannotator review through its local server (the same endpoints its page uses).
// The review's server is gone or no longer takes decisions.
export class ReviewClosedError extends Error {}

// `feedback` on an approval reaches the agent as Plannotator's approval notes.
export async function decidePlannotatorReview(localUrl: string, approve: boolean, feedback: string): Promise<void> {
  const origin = new URL(localUrl).origin;
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) throw new Error("Only local Plannotator reviews can be decided.");
  const response = await fetch(`${origin}/api/${approve ? "approve" : "deny"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(approve && !feedback ? {} : { feedback }),
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
