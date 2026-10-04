import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { ProjectStatus } from "../shared/contracts";
import type { Capacity } from "./capacity";
import { dispatchLabels } from "./dispatch";
import { refusedByLinear, type LinearService, type ProjectIssue } from "./linear";
import type { Scheduler } from "./scheduler";
import { needsOwner } from "./presence";
import { PLAN_READY_LABEL } from "./plan-policy";
import type { PluginSettings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// Projects carrying the trigger label move forward on their own (README, "Projects"):
// 1. Whenever a project has new tickets and no open planner, a planner ticket asks an agent for the
//    work order of the new tickets: which tickets block which, which must wait for the owner
//    (hold), and which may need them while they run (attended). Its plan is approved automatically
//    and written into Linear as blocking relations and `<trigger>-hold`/`-attended` labels.
//    `linear.plan-project` files it right away instead of at the next poll.
// 2. Every poll, the project's planned, unblocked, unheld tickets that nobody has are handed to
//    Paseo in the scheduler's order, one per free agent slot. Each ticket plans on its own.
// 3. An approved work order is kept with the record before it is written, and every poll writes
//    one that is not in Linear yet (README, "Projects"), so a failed write never stops the project.

// How often a project's tickets are read: a project is a few paginated queries.
const POLL_MS = 2 * 60_000;
// Ticket list in the planner's description: each ticket's description is cut to this, which keeps
// a 200-ticket project near 60,000 characters.
const DESCRIPTION_CHARS = 160;
const HAND_OUT_TYPES = new Set(["backlog", "unstarted"]);
// Polls a work order is retried while Linear refuses some of its changes, before it is closed with
// them skipped. Changes that did not reach Linear (rate limit, outage) are retried without limit.
const APPLY_TRIES = 3;

// `plannedThrough`: tickets created up to this time are in an approved (or closed) plan.
// `planner`: the open planner ticket, the time its ticket list was taken and how many new tickets it
// plans; `started`: false until it carries its label and is assigned to Paseo (records of older
// versions have none: started); `approved`: its approved work order, until it is written into Linear.
// `closedPlanner`: the planner ticket closed last, so a late report of its review is still its own.
// `withheld`: tickets whose `hold` or blocker Linear refused: planned, but never handed out by the
// project; you hand them out yourself.
export type PlannerRecord = { id: string; identifier: string; url: string; listedAt: string; tickets: number; started?: boolean; approved?: { agentId: string | null; plan: string } };
export type ProjectRecord = { plannedThrough: string | null; planner: PlannerRecord | null; closedPlanner?: string; withheld?: string[] };

type Read = { work: ProjectIssue[]; record: ProjectRecord; plannerIssue: ProjectIssue | null; owner: string; planned: (issue: ProjectIssue) => boolean; unplanned: ProjectIssue[]; status: ProjectStatus };

export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path = join(paseoHome(), "linear-tickets", "projects.json")) {}

  async all(): Promise<Record<string, ProjectRecord>> {
    return JSON.parse(await readFile(this.path, "utf8").catch(() => "{}")) as Record<string, ProjectRecord>;
  }

  // Changes run one after another, each on the file as it is then, so a poll and an approval never
  // overwrite each other's record. `change` returns the project's new record, or null to keep it.
  update(projectId: string, change: (current: ProjectRecord | undefined) => ProjectRecord | null): Promise<ProjectRecord | null> {
    const run = this.queue.then(async () => {
      const records = await this.all();
      const next = change(records[projectId]);
      if (next) await this.save({ ...records, [projectId]: next });
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async save(records: Record<string, ProjectRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(records, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}

// One line of the planner's `project-order` block.
export type OrderStep = { kind: "blocks"; blocker: string; blocked: string } | { kind: "hold" | "release" | "attended" | "unattended"; ticket: string; reason: string };

const TICKET = "[A-Z][A-Z0-9]*-\\d+";
// A reason may follow the tickets after `:`, `(`, `#` or a dash, and a line may end in a period;
// anything else (`and TUC-3`, a list) makes the line unreadable rather than half-read.
const BLOCKS_LINE = new RegExp(`^(${TICKET})\\s+blocks\\s+(${TICKET})\\s*(?:\\.?$|[:(#]|[—–-]\\s)`, "i");
const MARK_LINE = new RegExp(`^(hold|release|attended|unattended)\\s+(${TICKET})\\s*(?:\\.?$|[:—–-]\\s*(.*)$)`, "i");

function orderBlock(plan: string): string | null {
  return /```project-order\s*\n([\s\S]*?)```/i.exec(plan)?.[1] ?? null;
}

function orderLines(block: string): string[] {
  return block.split("\n").map((item) => item.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
}

function orderStep(line: string): OrderStep | null {
  const blocks = BLOCKS_LINE.exec(line);
  if (blocks) return { kind: "blocks", blocker: blocks[1].toUpperCase(), blocked: blocks[2].toUpperCase() };
  const mark = MARK_LINE.exec(line);
  return mark ? { kind: mark[1].toLowerCase() as "hold" | "release" | "attended" | "unattended", ticket: mark[2].toUpperCase(), reason: (mark[3] ?? "").trim() } : null;
}

// The approved plan's ```project-order block: `TUC-1 blocks TUC-2`, `hold TUC-3: reason`,
// `release TUC-4`, `attended TUC-5: reason`, `unattended TUC-6`. Unreadable lines are left out
// (see `orderProblems`).
export function parseOrder(plan: string): OrderStep[] {
  return orderLines(orderBlock(plan) ?? "").map(orderStep).filter((step): step is OrderStep => step !== null);
}

// Why a submitted work order cannot be applied as written: no ```project-order block, or lines in
// it that are not one change each. Empty when it can (an empty block is an order with no changes).
export function orderProblems(plan: string): string[] {
  const block = orderBlock(plan);
  if (block === null) return ["The plan has no ```project-order block."];
  return orderLines(block).filter((line) => !orderStep(line)).map((line) => `Not one work-order change: "${line}"`);
}

type Deps = {
  linear: Pick<LinearService, "labeledProjects" | "projectIssues" | "issueDescriptions" | "issueDocument" | "createIssue" | "addLabel" | "removeLabel" | "delegate" | "addBlocker" | "complete" | "comment" | "appUserId" | "viewerId">;
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
  // Planner tickets whose work order is being written, so a poll and an approval never write it twice.
  private readonly applying = new Set<string>();
  // Projects whose planner is being filed, so a poll and Plan never file two.
  private readonly filing = new Set<string>();
  // Per planner ticket, the plan text and the polls in which Linear refused some of its changes.
  private readonly refusedTries = new Map<string, { plan: string; tries: number }>();

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
  // its own, so one failing project does not stop the others, and within a project a failing
  // work order or planner never stops the hand-out of tickets already planned.
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.now() - this.lastPoll < POLL_MS) return;
    this.lastPoll = this.now();
    const appId = await this.deps.linear.appUserId();
    // Hand-outs start through Linear agent sessions; without the Paseo app nothing would start.
    if (!appId) { this.statuses = []; return; }
    const statuses: ProjectStatus[] = [];
    for (const project of await this.deps.linear.labeledProjects(settings.dispatch.label)) {
      try {
        let read = await this.read(project, settings);
        const planner = read.record.planner;
        if (planner) {
          const written = await this.applyApproved(project.id, planner, read.plannerIssue, paseo, settings)
            .catch((error: unknown) => { console.error(`[linear-tickets] ${planner.identifier}: writing the work order failed, the next poll retries: ${message(error)}`); return false; });
          if (written) read = await this.read(project, settings);
        }
        const open = read.record.planner;
        if (open?.started === false && read.plannerIssue) {
          await this.startPlanner(project.id, open, read.plannerIssue, appId, settings)
            .catch((error: unknown) => console.error(`[linear-tickets] ${open.identifier}: starting the planner failed, the next poll retries: ${message(error)}`));
        }
        // Always on: new tickets get a planner as soon as none is open.
        const status = !open && read.unplanned.length
          ? await this.filePlanner(project, read, appId, settings).catch((error: unknown) => { console.error(`[linear-tickets] project ${project.name}: filing the planner failed, the next poll retries: ${message(error)}`); return read.status; })
          : read.status;
        statuses.push(status);
        await this.handOut(project.id, read, appId, paseo, settings);
      } catch (error) {
        console.error(`[linear-tickets] project ${project.name}: ${message(error)}`);
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
    let record: ProjectRecord = (await this.store.all())[project.id] ?? { plannedThrough: null, planner: null };
    // A planner closed without an approved plan (the owner canceled or finished it): its tickets
    // count as planned, so they are not offered for planning again. One with an approved order
    // stays until the order is written (`write` then leaves the ticket as it is).
    const gone = record.planner && !record.planner.approved && !issues.some((issue) => issue.id === record.planner!.id) ? record.planner.id : null;
    if (gone) {
      await this.store.update(project.id, (current) => current?.planner?.id === gone && !current.planner.approved
        ? { ...current, plannedThrough: current.planner.listedAt, planner: null, closedPlanner: gone } : null);
      record = (await this.store.all())[project.id] ?? record;
    }
    const plannerId = record.planner?.id;
    const plannerIssue = plannerId ? issues.find((issue) => issue.id === plannerId) ?? null : null;
    const work = issues.filter((issue) => issue.id !== plannerId && !issue.labels.some((name) => name.toLowerCase() === labels.planner.toLowerCase()));
    const owner = await this.deps.linear.viewerId();
    const planned = (issue: ProjectIssue) => record.plannedThrough !== null && issue.createdAt <= record.plannedThrough;
    const unplanned = work.filter((issue) => !planned(issue) && (HAND_OUT_TYPES.has(issue.statusType) || issue.statusType === "triage")
      && !issue.delegateId && !issue.parentId && (!issue.assigneeId || issue.assigneeId === owner));
    // Tickets the open planner already lists are in review, not waiting for a plan.
    const listedAt = record.planner?.listedAt;
    const toPlan = unplanned.filter((issue) => !listedAt || issue.createdAt > listedAt).length;
    const planner = record.planner ? plannerSummary(record.planner) : null;
    return { work, record, plannerIssue, owner, planned, unplanned, status: { id: project.id, name: project.name, toPlan, planner, readAt: new Date(this.now()).toISOString() } };
  }

  // `linear.plan-project`: files a planner ticket for the project's unplanned tickets right away
  // instead of at the next poll. One planner per project at a time.
  async planNow(projectId: string, settings: PluginSettings): Promise<ProjectStatus> {
    const appId = await this.deps.linear.appUserId();
    if (!appId) throw new Error("The Paseo Linear app is not installed on this host, so nothing would start the planner.");
    const project = (await this.deps.linear.labeledProjects(settings.dispatch.label)).find((item) => item.id === projectId);
    if (!project) throw new Error(`This project no longer carries the "${settings.dispatch.label}" label.`);
    const read = await this.read(project, settings);
    if (read.record.planner) throw new Error(`${read.record.planner.identifier} is still planning the work order.`);
    if (!read.unplanned.length) throw new Error("No new tickets to plan.");
    const status = await this.filePlanner(project, read, appId, settings);
    if (!status.planner) throw new Error("A planner for this project is being filed right now.");
    this.statuses = [...this.statuses.filter((item) => item.id !== project.id), status];
    return status;
  }

  // The record is stored right after the ticket exists, so a later failure never files a second
  // planner; its label and assignment to Paseo are retried by later polls until both went through.
  // A poll and Plan at the same time file one planner: the other returns the status unchanged.
  private async filePlanner(project: { id: string; name: string }, read: Read, appId: string, settings: PluginSettings): Promise<ProjectStatus> {
    if (this.filing.has(project.id)) return read.status;
    this.filing.add(project.id);
    try {
      // Filed since this read (by the other path).
      const current = (await this.store.all())[project.id]?.planner;
      if (current) return { ...read.status, toPlan: 0, planner: plannerSummary(current) };
      const labels = dispatchLabels(settings.dispatch.label);
      const listedAt = new Date(this.now()).toISOString();
      const teams = new Map<string, number>();
      for (const issue of read.work) teams.set(issue.teamId, (teams.get(issue.teamId) ?? 0) + 1);
      const teamId = [...teams.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const descriptions = await this.deps.linear.issueDescriptions(read.work.map((issue) => issue.id));
      const created = await this.deps.linear.createIssue({ teamId, projectId: project.id, ready: true, priority: 1, title: `Plan the work order of ${project.name}`, description: plannerBrief(project.name, read.work, read.unplanned, descriptions, labels) });
      const planner: PlannerRecord = { id: created.id, identifier: created.identifier, url: created.url, listedAt, tickets: read.unplanned.length, started: false };
      await this.store.update(project.id, (record) => ({ ...(record ?? read.record), planner }));
      console.log(`[linear-tickets] project ${project.name}: planner ${created.identifier} for ${read.unplanned.length} new ticket${read.unplanned.length === 1 ? "" : "s"}`);
      await this.startPlanner(project.id, planner, null, appId, settings)
        .catch((error: unknown) => console.error(`[linear-tickets] ${created.identifier}: starting the planner failed, the next poll retries: ${message(error)}`));
      return { ...read.status, toPlan: 0, planner: plannerSummary(planner) };
    } finally {
      this.filing.delete(project.id);
    }
  }

  // Gives the planner ticket its label and assigns it to Paseo, which starts its agent; `issue`:
  // the ticket as last read (null right after filing), so a retry repeats only what is missing.
  private async startPlanner(projectId: string, planner: PlannerRecord, issue: ProjectIssue | null, appId: string, settings: PluginSettings): Promise<void> {
    const label = dispatchLabels(settings.dispatch.label).planner;
    if (!issue?.labels.some((name) => name.toLowerCase() === label.toLowerCase())) await this.deps.linear.addLabel(planner.id, label);
    if (issue?.delegateId !== appId) await this.deps.linear.delegate(planner.id, appId);
    await this.store.update(projectId, (current) => current?.planner?.id === planner.id ? { ...current, planner: { ...current.planner, started: true } } : null);
  }

  // Ranked by the scheduler; each admitted ticket is assigned to Paseo, whose session then starts
  // it in its reserved slot. A ticket with open sub-issues in the project is a group: assigning it
  // takes no slot, its sub-issues are handed out by the group. Withheld tickets are left to you.
  private async handOut(projectId: string, read: Read, appId: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const labels = dispatchLabels(settings.dispatch.label);
    const skip = new Set([labels.hold, labels.manual, labels.needsYou, labels.running, labels.failed, settings.dispatch.label].map((name) => name.toLowerCase()));
    const withheld = new Set(read.record.withheld ?? []);
    const parents = new Set(read.work.map((issue) => issue.parentId).filter(Boolean));
    const ready = read.work.filter((issue) => read.planned(issue) && !withheld.has(issue.id) && HAND_OUT_TYPES.has(issue.statusType) && !issue.delegateId && (!issue.assigneeId || issue.assigneeId === read.owner)
      && !issue.parentId && !issue.labels.some((name) => skip.has(name.toLowerCase())) && issue.blockers.every((blocker) => blocker.finished));
    for (const group of ready.filter((issue) => parents.has(issue.id))) {
      await this.deps.linear.delegate(group.id, appId);
      console.log(`[linear-tickets] project hand-out ${group.identifier}: group`);
    }
    const singles = ready.filter((issue) => !parents.has(issue.id));
    const candidates = singles.map((issue) => ({
      issueId: issue.id, identifier: issue.identifier, projectId, priority: issue.priority, unblocks: issue.blocks.length, createdAt: issue.createdAt,
      attended: needsOwner(issue.labels, settings.dispatch.label),
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
        console.error(`[linear-tickets] project hand-out ${candidate.identifier} failed: ${message(error)}`);
      }
    }
  }

  // Whether the ticket is a project's planner: the open one, or the one closed last (a late report
  // of its review is still a work order, not a ticket plan).
  async isPlanner(issueId: string): Promise<boolean> {
    return Object.values(await this.store.all()).some((record) => record.planner?.id === issueId || record.closedPlanner === issueId);
  }

  // An approved work order of the open planner ticket: kept with the record first, so a write that
  // fails is retried by the next poll, then written. False when the ticket is no open planner.
  async applyPlan(issueId: string, agentId: string | null, plan: string, paseo: PaseoApi, settings: PluginSettings): Promise<boolean> {
    const projectId = Object.entries(await this.store.all()).find(([, record]) => record.planner?.id === issueId)?.[0];
    if (!projectId) return false;
    const stored = await this.store.update(projectId, (current) => current?.planner?.id === issueId ? { ...current, planner: { ...current.planner, approved: { agentId, plan } } } : null);
    const planner = stored?.planner;
    if (!planner) return false;
    await this.write(projectId, planner, true, paseo, settings)
      .catch((error: unknown) => console.error(`[linear-tickets] ${planner.identifier}: writing the work order failed, the next poll retries: ${message(error)}`));
    return true;
  }

  // Every poll: the open planner's approved work order, written now if it is not in Linear yet.
  // A planner ticket carrying plan-ready was approved like a ticket plan (a plugin version that
  // parked work orders for the owner) and its order is read from its plan document. True when written.
  private async applyApproved(projectId: string, planner: PlannerRecord, plannerIssue: ProjectIssue | null, paseo: PaseoApi, settings: PluginSettings): Promise<boolean> {
    let approved = planner.approved ?? null;
    if (!approved && plannerIssue?.labels.some((name) => name.toLowerCase() === PLAN_READY_LABEL)) {
      const document = await this.deps.linear.issueDocument(planner.id, `Plan: ${planner.identifier}`);
      if (document?.content.trim()) approved = { agentId: null, plan: document.content };
    }
    if (!approved) return false;
    return this.write(projectId, { ...planner, approved }, plannerIssue !== null, paseo, settings);
  }

  // Writes the order into Linear, marks its tickets planned, closes the planner ticket and retires
  // its agent. Every change is safe to repeat, so a failed write is simply written again. Changes
  // that did not reach Linear are retried every poll; changes Linear refuses for APPLY_TRIES polls
  // (at once when the planner ticket is no longer open: closing it ends the wait) are skipped, and
  // a ticket whose `hold` or blocker was skipped is withheld instead of handed out unordered.
  // `open`: the planner ticket is open in the project, so it is completed here.
  private async write(projectId: string, planner: PlannerRecord, open: boolean, paseo: PaseoApi, settings: PluginSettings): Promise<boolean> {
    if (this.applying.has(planner.id) || !planner.approved) return false;
    this.applying.add(planner.id);
    try {
      const labels = dispatchLabels(settings.dispatch.label);
      const issues = await this.deps.linear.projectIssues(projectId);
      const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));
      const done: string[] = [];
      const skipped: string[] = [];
      const unreached: string[] = [];
      const refused: string[] = [];
      const withhold = new Map<string, string>();
      const released = new Set<string>();
      for (const step of parseOrder(planner.approved.plan)) {
        const line = step.kind === "blocks" ? `${step.blocker} blocks ${step.blocked}` : `${step.kind} ${step.ticket}${step.reason ? `: ${step.reason}` : ""}`;
        const target = byIdentifier.get(step.kind === "blocks" ? step.blocked : step.ticket);
        try {
          if (step.kind === "blocks") {
            const blocker = byIdentifier.get(step.blocker);
            if (!blocker || !target) { skipped.push(`${line} (not an open ticket of the project)`); continue; }
            // Already there (an earlier write of this order, or the owner): counted as applied.
            if (!target.blockers.some((item) => item.id === blocker.id)) await this.deps.linear.addBlocker(blocker.id, target.id);
          } else {
            if (!target) { skipped.push(`${line} (not an open ticket of the project)`); continue; }
            if (step.kind === "hold") await this.deps.linear.addLabel(target.id, labels.hold);
            else if (step.kind === "release") { await this.deps.linear.removeLabel(target.id, labels.hold); released.add(target.id); }
            else if (step.kind === "attended") await this.deps.linear.addLabel(target.id, labels.attended);
            else await this.deps.linear.removeLabel(target.id, labels.attended);
          }
          done.push(line);
        } catch (error) {
          if (!refusedByLinear(error)) { unreached.push(`${line} (${message(error)})`); continue; }
          refused.push(`${line} (${message(error)})`);
          if (target && (step.kind === "blocks" || step.kind === "hold")) withhold.set(target.id, target.identifier);
        }
      }
      if (refused.length) {
        const previous = this.refusedTries.get(planner.id);
        this.refusedTries.set(planner.id, { plan: planner.approved.plan, tries: previous?.plan === planner.approved.plan ? previous.tries + 1 : 1 });
      }
      if (unreached.length) throw new Error(`${unreached.length} change${unreached.length === 1 ? "" : "s"} did not reach Linear: ${unreached.join("; ")}`);
      if (refused.length && open && this.refusedTries.get(planner.id)!.tries < APPLY_TRIES) throw new Error(`Linear refused ${refused.length} change${refused.length === 1 ? "" : "s"}: ${refused.join("; ")}`);
      await this.deps.linear.comment(planner.id, [
        `**Work order applied** (${done.length} change${done.length === 1 ? "" : "s"}). The project's tickets are now handed to Paseo in order as agent slots free up.`,
        done.length ? `Applied:\n${done.map((line) => `- ${line}`).join("\n")}` : "",
        skipped.length || refused.length ? `Skipped:\n${[...skipped, ...refused].map((line) => `- ${line}`).join("\n")}` : "",
        withhold.size ? `Not handed out, because Linear refused their hold or blocker: ${[...withhold.values()].join(", ")}. Assign them to Paseo yourself when they may start.` : "",
      ].filter(Boolean).join("\n\n"));
      if (open) await this.deps.linear.complete(planner.id);
      const openIds = new Set(issues.map((issue) => issue.id));
      await this.store.update(projectId, (current) => current?.planner?.id === planner.id ? {
        plannedThrough: planner.listedAt,
        planner: null,
        closedPlanner: planner.id,
        withheld: [...new Set([...(current.withheld ?? []).filter((id) => openIds.has(id) && !released.has(id)), ...withhold.keys()])],
      } : null);
      this.refusedTries.delete(planner.id);
      this.statuses = this.statuses.map((status) => status.id === projectId ? { ...status, planner: null } : status);
      if (planner.approved.agentId) await this.deps.retire(planner.approved.agentId, paseo);
      return true;
    } finally {
      this.applying.delete(planner.id);
    }
  }
}

function plannerSummary(planner: PlannerRecord): NonNullable<ProjectStatus["planner"]> {
  return { identifier: planner.identifier, url: planner.url, tickets: planner.tickets };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      `- \`attended X: reason\`: an agent can do X, but will very likely have to stop and ask the owner during the work. X still plans at any time, but its plan always goes to the owner, and its implementation starts only while the owner is present; unmarked tickets also run at night, unattended. Mark a ticket only for one of these: a business decision the ticket leaves open, acceptance criteria too vague to check, user-facing wording or layout the owner must choose, changes to production data, external accounts or spend, or a step only a person can do. Size, difficulty, risk or code review alone are no reason: most tickets stay unmarked. It gets the \`${labels.attended}\` label.`,
      "- `unattended X`: X no longer needs the owner present (removes an earlier `attended`).",
      "- Tickets not mentioned are handed out as soon as they are unblocked; independent tickets run in parallel.",
      "- One change per line, a reason only after a colon (`TUC-1 blocks TUC-2, TUC-3` is not read: write two lines). A block Paseo cannot read line by line is sent back to you.",
    ].join("\n"),
    "Rate the work order itself in the plan's `## Risk and impact` section (the advisor record needs it), not the tickets: it only changes Linear (blocking relations and labels), and every ticket still plans and is approved on its own. That is impact 0 with reversibility `revert`. The work order is applied without the owner, so anything that needs them goes under `hold` or `attended`.",
    "Once you submit the plan, Paseo approves it automatically, writes the order into Linear and closes this ticket. Nothing is left to implement then: stop.",
    `## Open tickets (${work.length})\n\n${lines.join("\n")}`,
  ].join("\n\n");
}
