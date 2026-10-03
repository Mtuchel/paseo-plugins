import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { ProjectStatus } from "../shared/contracts";
import type { Capacity } from "./capacity";
import { dispatchLabels } from "./dispatch";
import type { LinearService, ProjectIssue } from "./linear";
import { PLAN_LABEL } from "./plan-policy";
import type { Scheduler } from "./scheduler";
import { needsOwner } from "./presence";
import { isUntrusted } from "./starter";
import type { PluginSettings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// Projects carrying the trigger label move forward on their own (README, "Projects"):
// 1. The owner asks for a plan (`linear.plan-project`, the Paseo Agents menu bar's "Plan"): a planner ticket in the project asks an agent
//    for the work order of the new tickets: which tickets block which, and which must wait for the
//    owner (hold). The owner approves its plan like any other; the approved order is written into
//    Linear as blocking relations and `<trigger>-hold` labels.
// 2. Every poll, the project's planned, unblocked, unheld tickets that nobody has are handed to
//    Paseo in the scheduler's order, one per free agent slot.
// Tickets filed after the last plan wait until the owner plans them; `linear.projects-status` counts them.

// How often a project's tickets are read: a project is a few paginated queries.
const POLL_MS = 2 * 60_000;
// Ticket list in the planner's description: each ticket's description is cut to this, which keeps
// a 200-ticket project near 60,000 characters.
const DESCRIPTION_CHARS = 160;
const HAND_OUT_TYPES = new Set(["backlog", "unstarted"]);

// `plannedThrough`: tickets created up to this time are in an approved (or closed) plan.
// `planner`: the open planner ticket, the time its ticket list was taken and how many new tickets it plans.
export type ProjectRecord = { plannedThrough: string | null; planner: { id: string; identifier: string; url: string; listedAt: string; tickets: number } | null };

type Read = { work: ProjectIssue[]; record: ProjectRecord; owner: string; planned: (issue: ProjectIssue) => boolean; unplanned: ProjectIssue[]; status: ProjectStatus };

export class ProjectStore {
  constructor(private readonly path = join(paseoHome(), "linear-tickets", "projects.json")) {}

  async all(): Promise<Record<string, ProjectRecord>> {
    return JSON.parse(await readFile(this.path, "utf8").catch(() => "{}")) as Record<string, ProjectRecord>;
  }

  async put(projectId: string, entry: ProjectRecord): Promise<void> {
    const next = { ...await this.all(), [projectId]: entry };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}

// One line of the planner's `project-order` block.
export type OrderStep = { kind: "blocks"; blocker: string; blocked: string } | { kind: "hold" | "release" | "attended" | "unattended"; ticket: string; reason: string };

// The approved plan's ```project-order block: `TUC-1 blocks TUC-2`, `hold TUC-3: reason`,
// `release TUC-4`, `attended TUC-5: reason`, `unattended TUC-6`. Other lines are ignored.
export function parseOrder(plan: string): OrderStep[] {
  const block = /```project-order\s*\n([\s\S]*?)```/i.exec(plan)?.[1] ?? "";
  const steps: OrderStep[] = [];
  for (const line of block.split("\n").map((item) => item.replace(/^\s*[-*]\s*/, "").trim())) {
    const blocks = /^([A-Z][A-Z0-9]*-\d+)\s+blocks\s+([A-Z][A-Z0-9]*-\d+)\b/i.exec(line);
    if (blocks) { steps.push({ kind: "blocks", blocker: blocks[1].toUpperCase(), blocked: blocks[2].toUpperCase() }); continue; }
    const mark = /^(hold|release|attended|unattended)\s+([A-Z][A-Z0-9]*-\d+)\s*[:—-]?\s*(.*)$/i.exec(line);
    if (mark) steps.push({ kind: mark[1].toLowerCase() as "hold" | "release" | "attended" | "unattended", ticket: mark[2].toUpperCase(), reason: mark[3].trim() });
  }
  return steps;
}

type Deps = {
  linear: Pick<LinearService, "labeledProjects" | "projectIssues" | "issueDescriptions" | "createIssue" | "addLabel" | "removeLabel" | "delegate" | "addBlocker" | "complete" | "comment" | "appUserId" | "viewerId">;
  scheduler: Pick<Scheduler, "note" | "admit" | "release">;
  // The cap the starter's start paths admit under (max agents, or a memory lease).
  capacity: Pick<Capacity, "limit">;
  store?: ProjectStore;
  // Stops the planner's turn and archives it once its plan is applied.
  retire: (agentId: string, paseo: PaseoApi) => Promise<void>;
  now?: () => number;
};

export class ProjectFlow {
  private readonly store: ProjectStore;
  private lastPoll = 0;
  private statuses: ProjectStatus[] = [];

  constructor(private readonly deps: Deps) {
    this.store = deps.store ?? new ProjectStore();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // The labelled projects as of the last poll (`linear.projects-status`).
  status(): ProjectStatus[] {
    return this.statuses.map((status) => ({ ...status }));
  }

  // Called on every dispatch poll; reads the projects at most every POLL_MS. Each project runs on
  // its own, so one failing project does not stop the others.
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.now() - this.lastPoll < POLL_MS) return;
    this.lastPoll = this.now();
    const appId = await this.deps.linear.appUserId();
    // Hand-outs start through Linear agent sessions; without the Paseo app nothing would start.
    if (!appId) { this.statuses = []; return; }
    const statuses: ProjectStatus[] = [];
    for (const project of await this.deps.linear.labeledProjects(settings.dispatch.label)) {
      try {
        const read = await this.read(project, settings);
        statuses.push(read.status);
        await this.handOut(project.id, read.work, read.work.filter(read.planned), read.owner, appId, paseo, settings);
      } catch (error) {
        console.error(`[linear-tickets] project ${project.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    this.statuses = statuses;
  }

  // The project's open tickets and what is planned. Only tickets the hand-out could take need a
  // plan: sub-issues (their group hands them out), tickets already with Paseo or someone else, and
  // started work never count.
  private async read(project: { id: string; name: string }, settings: PluginSettings): Promise<Read> {
    const labels = dispatchLabels(settings.dispatch.label);
    const issues = await this.deps.linear.projectIssues(project.id);
    let record = (await this.store.all())[project.id] ?? { plannedThrough: null, planner: null };
    // A planner closed without an applied plan (the owner canceled or finished it): its tickets
    // count as planned, so they are not offered for planning again.
    if (record.planner && !issues.some((issue) => issue.id === record.planner!.id)) {
      record = { plannedThrough: record.planner.listedAt, planner: null };
      await this.store.put(project.id, record);
    }
    const work = issues.filter((issue) => !issue.labels.some((name) => name.toLowerCase() === labels.planner.toLowerCase()));
    const owner = await this.deps.linear.viewerId();
    const planned = (issue: ProjectIssue) => record.plannedThrough !== null && issue.createdAt <= record.plannedThrough;
    const unplanned = work.filter((issue) => !planned(issue) && (HAND_OUT_TYPES.has(issue.statusType) || issue.statusType === "triage")
      && !issue.delegateId && !issue.parentId && (!issue.assigneeId || issue.assigneeId === owner));
    // Tickets the open planner already lists are in review, not waiting for a plan.
    const listedAt = record.planner?.listedAt;
    const toPlan = unplanned.filter((issue) => !listedAt || issue.createdAt > listedAt).length;
    const planner = record.planner ? { identifier: record.planner.identifier, url: record.planner.url, tickets: record.planner.tickets } : null;
    return { work, record, owner, planned, unplanned, status: { id: project.id, name: project.name, toPlan, planner, readAt: new Date(this.now()).toISOString() } };
  }

  // `linear.plan-project`: files a planner ticket for the project's unplanned tickets. One
  // planner per project at a time.
  async planNow(projectId: string, settings: PluginSettings): Promise<ProjectStatus> {
    const appId = await this.deps.linear.appUserId();
    if (!appId) throw new Error("The Paseo Linear app is not installed on this host, so nothing would start the planner.");
    const project = (await this.deps.linear.labeledProjects(settings.dispatch.label)).find((item) => item.id === projectId);
    if (!project) throw new Error(`This project no longer carries the "${settings.dispatch.label}" label.`);
    const read = await this.read(project, settings);
    if (read.record.planner) throw new Error(`${read.record.planner.identifier} is still waiting for your approval. Approve or close it first.`);
    if (!read.unplanned.length) throw new Error("No new tickets to plan.");
    const labels = dispatchLabels(settings.dispatch.label);
    const listedAt = new Date(this.now()).toISOString();
    const teams = new Map<string, number>();
    for (const issue of read.work) teams.set(issue.teamId, (teams.get(issue.teamId) ?? 0) + 1);
    const teamId = [...teams.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const descriptions = await this.deps.linear.issueDescriptions(read.work.map((issue) => issue.id));
    const created = await this.deps.linear.createIssue({ teamId, projectId: project.id, ready: true, priority: 1, title: `Plan the work order of ${project.name}`, description: plannerBrief(project.name, read.work, read.unplanned, descriptions, labels) });
    await this.deps.linear.addLabel(created.id, labels.planner);
    await this.deps.linear.addLabel(created.id, PLAN_LABEL);
    const planner = { identifier: created.identifier, url: created.url, tickets: read.unplanned.length };
    await this.store.put(project.id, { plannedThrough: read.record.plannedThrough, planner: { id: created.id, listedAt, ...planner } });
    await this.deps.linear.delegate(created.id, appId);
    console.log(`[linear-tickets] project ${project.name}: planner ${created.identifier} for ${read.unplanned.length} new ticket${read.unplanned.length === 1 ? "" : "s"}`);
    const status: ProjectStatus = { ...read.status, toPlan: 0, planner };
    this.statuses = [...this.statuses.filter((item) => item.id !== project.id), status];
    return status;
  }

  // Ranked by the scheduler; each admitted ticket is assigned to Paseo, whose session then starts
  // it in its reserved slot. A ticket with open sub-issues in the project is a group: assigning it
  // takes no slot, its sub-issues are handed out by the group.
  private async handOut(projectId: string, work: ProjectIssue[], planned: ProjectIssue[], owner: string, appId: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const labels = dispatchLabels(settings.dispatch.label);
    const skip = new Set([labels.hold, labels.manual, labels.needsYou, labels.running, labels.failed, settings.dispatch.label].map((name) => name.toLowerCase()));
    const parents = new Set(work.map((issue) => issue.parentId).filter(Boolean));
    const ready = planned.filter((issue) => HAND_OUT_TYPES.has(issue.statusType) && !issue.delegateId && (!issue.assigneeId || issue.assigneeId === owner)
      && !issue.parentId && !issue.labels.some((name) => skip.has(name.toLowerCase())) && issue.blockers.every((blocker) => blocker.finished));
    for (const group of ready.filter((issue) => parents.has(issue.id))) {
      await this.deps.linear.delegate(group.id, appId);
      console.log(`[linear-tickets] project hand-out ${group.identifier}: group`);
    }
    const singles = ready.filter((issue) => !parents.has(issue.id));
    const candidates = singles.map((issue) => ({
      issueId: issue.id, identifier: issue.identifier, projectId, priority: issue.priority, unblocks: issue.blocks.length, createdAt: issue.createdAt,
      attended: needsOwner(issue.labels, isUntrusted({ creatorId: issue.creatorId, labels: issue.labels.map((name) => ({ name })) }, owner, appId), settings.dispatch.label),
    }));
    this.deps.scheduler.note(candidates);
    for (const candidate of candidates) {
      const admission = await this.deps.scheduler.admit(candidate, paseo, this.deps.capacity.limit(settings.dispatch.maxRunning));
      if (!admission.ok) continue;
      try {
        await this.deps.linear.delegate(candidate.issueId, appId);
        console.log(`[linear-tickets] project hand-out ${candidate.identifier}: assigned to Paseo`);
      } catch (error) {
        this.deps.scheduler.release(candidate.issueId);
        console.error(`[linear-tickets] project hand-out ${candidate.identifier} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // An approved plan of a planner ticket: writes its order into Linear, marks its tickets planned,
  // closes the planner ticket and retires its agent. False when the ticket is no planner.
  async applyPlan(issueId: string, agentId: string, plan: string, paseo: PaseoApi, settings: PluginSettings): Promise<boolean> {
    const entry = Object.entries(await this.store.all()).find(([, record]) => record.planner?.id === issueId);
    if (!entry) return false;
    const [projectId, record] = entry;
    const labels = dispatchLabels(settings.dispatch.label);
    const byIdentifier = new Map((await this.deps.linear.projectIssues(projectId)).map((issue) => [issue.identifier, issue]));
    const done: string[] = [];
    const skipped: string[] = [];
    for (const step of parseOrder(plan)) {
      const line = step.kind === "blocks" ? `${step.blocker} blocks ${step.blocked}` : `${step.kind} ${step.ticket}${step.reason ? `: ${step.reason}` : ""}`;
      try {
        if (step.kind === "blocks") {
          const blocker = byIdentifier.get(step.blocker);
          const blocked = byIdentifier.get(step.blocked);
          if (!blocker || !blocked) { skipped.push(`${line} (not an open ticket of the project)`); continue; }
          if (blocked.blockers.some((item) => item.id === blocker.id)) continue;
          await this.deps.linear.addBlocker(blocker.id, blocked.id);
        } else {
          const ticket = byIdentifier.get(step.ticket);
          if (!ticket) { skipped.push(`${line} (not an open ticket of the project)`); continue; }
          if (step.kind === "hold") await this.deps.linear.addLabel(ticket.id, labels.hold);
          else if (step.kind === "release") await this.deps.linear.removeLabel(ticket.id, labels.hold);
          else if (step.kind === "attended") await this.deps.linear.addLabel(ticket.id, labels.attended);
          else await this.deps.linear.removeLabel(ticket.id, labels.attended);
        }
        done.push(line);
      } catch (error) {
        skipped.push(`${line} (${error instanceof Error ? error.message : error})`);
      }
    }
    await this.store.put(projectId, { plannedThrough: record.planner!.listedAt, planner: null });
    this.statuses = this.statuses.map((status) => status.id === projectId ? { ...status, planner: null } : status);
    await this.deps.linear.comment(issueId, [
      `**Work order applied** (${done.length} change${done.length === 1 ? "" : "s"}). The project's tickets are now handed to Paseo in order as agent slots free up.`,
      done.length ? `Applied:\n${done.map((line) => `- ${line}`).join("\n")}` : "",
      skipped.length ? `Skipped:\n${skipped.map((line) => `- ${line}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n"));
    await this.deps.linear.complete(issueId);
    await this.deps.retire(agentId, paseo);
    return true;
  }
}

// The planner ticket's description: what to decide, the answer format, and every open ticket.
export function plannerBrief(projectName: string, work: ProjectIssue[], unplanned: ProjectIssue[], descriptions: Map<string, string>, labels: { hold: string; attended: string }): string {
  const fresh = new Set(unplanned.map((issue) => issue.id));
  const lines = work.map((issue) => {
    const blockers = issue.blockers.filter((blocker) => !blocker.finished).map((blocker) => blocker.identifier);
    const text = (descriptions.get(issue.id) ?? "").replace(/\s+/g, " ").trim();
    const facts = [issue.status, issue.priority ? `P${issue.priority}` : "", issue.labels.join(", "), blockers.length ? `blocked by ${blockers.join(", ")}` : "", fresh.has(issue.id) ? "NEW" : ""].filter(Boolean).join(" · ");
    return `- **${issue.identifier}** ${issue.title} (${facts})${text ? `\n  ${text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1)}…` : text}` : ""}`;
  });
  return [
    `Paseo hands the open tickets of **${projectName}** to agents on its own, up to the agent limit at once. Before it hands out the tickets marked NEW, decide their work order. Do not change code: this ticket only produces the order.`,
    `Read the tickets below and the code they touch, then write a plan with a \`## Work order\` section holding a fenced block in exactly this format:`,
    "```project-order\nTUC-12 blocks TUC-15\nhold TUC-20: too big, split it first\nrelease TUC-21\nattended TUC-23: which customer groups get the discount is not decided\n```",
    [
      "- `A blocks B`: B must not start before A is finished. Add one where B builds on A, or where both change the same files and would conflict as parallel pull requests.",
      `- \`hold X: reason\`: X must not start at all until the owner acts (too big, should be split, waits on a decision outside the code). It gets the \`${labels.hold}\` label and is not handed out until the owner removes it.`,
      "- `release X`: a ticket held earlier may now be handed out.",
      `- \`attended X: reason\`: an agent can do X, but will very likely have to stop and ask the owner during the work. Paseo starts X only while the owner is present; unmarked tickets also run at night, unattended. Mark a ticket only for one of these: a business decision the ticket leaves open, acceptance criteria too vague to check, user-facing wording or layout the owner must choose, changes to production data, external accounts or spend, or a step only a person can do. Size, difficulty, risk or code review alone are no reason: most tickets stay unmarked. It gets the \`${labels.attended}\` label.`,
      "- `unattended X`: X no longer needs the owner present (removes an earlier `attended`).",
      "- Tickets not mentioned are handed out as soon as they are unblocked; independent tickets run in parallel.",
    ].join("\n"),
    "Rate the work order itself in the plan's `## Risk and impact` section, not the tickets: it only changes Linear (blocking relations and labels), and every ticket is still planned and approved on its own. That is impact 0 with reversibility `revert`, unless the order itself affects a business process, for example by holding back a ticket a deadline depends on. Put tickets that need the owner under `hold` or `attended` rather than recommending `owner`; recommend `owner` only when the order needs a decision you cannot make from the tickets, for example two tickets that contradict each other.",
    "Once the plan is approved (by the owner, or automatically when its rating is within the owner's threshold), Paseo writes the order into Linear and closes this ticket. Nothing is left to implement then: stop.",
    `## Open tickets (${work.length})\n\n${lines.join("\n")}`,
  ].join("\n\n");
}
