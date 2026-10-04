import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { ProjectStatus } from "../shared/contracts";
import type { Capacity } from "./capacity";
import { dispatchLabels } from "./dispatch";
import { refusedByLinear, type LinearService, type ProjectIssue, type TeamIssue } from "./linear";
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
// 4. A started planner without a live agent is started again after a grace period, a few times,
//    then left to the owner (README, "Projects"), so a failed launch never stalls the project.
// 5. So is a ticket assigned to Paseo whose start failed or never came (README, "Projects"): it
//    stays assigned to Paseo, so the hand-out would never take it again.

// How often a project's tickets are read: a project is a few paginated queries.
const POLL_MS = 2 * 60_000;
// Ticket list in the planner's description: each ticket's description is cut to this, which keeps
// a 200-ticket project near 60,000 characters.
const DESCRIPTION_CHARS = 160;
// NEW tickets are also given in full, each up to NEW_DESCRIPTION_CHARS and all of them together up
// to NEW_DESCRIPTIONS_BUDGET; past it the planner reads the rest in Linear. With the lists this keeps
// a 200-ticket project's description near 120,000 characters (Linear took 73,000 without complaint).
const NEW_DESCRIPTION_CHARS = 4_000;
const NEW_DESCRIPTIONS_BUDGET = 30_000;
// Open tickets of the project's teams outside the project, listed by title (about 100 characters
// each), most recently updated first.
const OTHER_TICKETS = 300;
const HAND_OUT_TYPES = new Set(["backlog", "unstarted"]);
// Polls a work order is retried while Linear refuses some of its changes, before it is closed with
// them skipped. Changes that did not reach Linear (rate limit, outage) are retried without limit.
const APPLY_TRIES = 3;
// A started planner without a live agent this long after its (re)start is started again. A start
// takes a couple of minutes (TUC-678: filed 08:26:04, its workspace stood at 08:26:46, the daemon
// gave up waiting for the agent at 08:27:46), so ten minutes never starts a second agent beside one
// still launching, and a project stalls by a failed start for at most that plus one poll.
const RESTART_GRACE_MS = 10 * 60_000;
// Restarts per planner before it is left to the owner: a start that fails this often (no project
// mapping, a provider that does not come up) needs them, not another try.
const RESTART_CAP = 3;
// Agent states that still work on the plan. A closed agent (idle too long) or one in error never
// submits it on its own.
const LIVE_AGENT: Record<string, true> = { initializing: true, idle: true, running: true };

// `planned`: the tickets in an approved (or closed) plan: those its planner listed. Kept by id, not
// by creation time, so a ticket created while the planner was filed, or moved into the project from
// elsewhere, is new until a planner lists it. Tickets no longer open in the project drop out when a
// planner closes. `plannedThrough`: what older versions kept instead (tickets created up to then
// were planned); `migrated` turns it into `planned` with the project's tickets of that time.
// `planner`: the open planner ticket, the time its ticket list was taken, the tickets it `listed`
// and how many new tickets it plans; `started`: false until it carries its label and is assigned to
// Paseo (records of older versions have none: started); `startedAt`: when it was last (re)started
// (absent: `listedAt`); `restarts`: how often it was started again without a live agent;
// `ownerAsked`: past RESTART_CAP, the owner was asked to start it; `approved`: its approved work
// order, until it is written into Linear, with the changes of it already `done` in Linear.
// `closedPlanner`: the planner ticket closed last, so a late report of its review is still its own.
// `withheld`: tickets whose `hold` or blocker Linear refused: planned, but never handed out by the
// project; you hand them out yourself.
export type PlannerRecord = {
  id: string; identifier: string; url: string; listedAt: string; listed?: string[]; tickets: number; started?: boolean;
  startedAt?: string; restarts?: number; ownerAsked?: boolean; approved?: { agentId: string | null; plan: string; done?: string[] };
};
// A ticket assigned to Paseo whose start failed: `since` it was first seen so or last started
// again, `restarts` so far, `ownerAsked` past RESTART_CAP.
export type StalledRecord = { since: string; restarts: number; ownerAsked?: boolean };
export type ProjectRecord = { planned?: string[]; plannedThrough?: string | null; planner: PlannerRecord | null; closedPlanner?: string; withheld?: string[]; stalled?: Record<string, StalledRecord> };

type Read = { work: ProjectIssue[]; record: ProjectRecord; plannerIssue: ProjectIssue | null; owner: string; readAt: string; planned: (issue: ProjectIssue) => boolean; unplanned: ProjectIssue[]; status: ProjectStatus };

// A record of an older version, which planned by creation time, with the tickets those times cover
// now as its planned and listed tickets, so what was planned stays planned. The same record when
// there is nothing to migrate.
function migrated(record: ProjectRecord, issues: ProjectIssue[]): ProjectRecord {
  const covered = (through: string | null | undefined) => through ? issues.filter((issue) => issue.createdAt <= through).map((issue) => issue.id) : [];
  const planner = record.planner && !record.planner.listed ? { ...record.planner, listed: covered(record.planner.listedAt) } : record.planner;
  if (record.planned && planner === record.planner) return record;
  const { plannedThrough, ...rest } = record;
  return { ...rest, planned: rest.planned ?? covered(plannedThrough), planner };
}

// The planned tickets once `planner` closes: what it listed joins them, and tickets no longer open
// in the project drop out (one moved out and back in, or reopened, is new again).
function plannedAfter(record: ProjectRecord, planner: PlannerRecord, issues: ProjectIssue[]): string[] {
  const open = new Set(issues.map((issue) => issue.id));
  return [...new Set([...(record.planned ?? []), ...(planner.listed ?? [])])].filter((id) => open.has(id));
}

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
export type OrderStep = { kind: "blocks"; blocker: string; blocked: string }
  | { kind: "duplicates" | "relates"; ticket: string; other: string; reason: string }
  | { kind: "hold" | "release" | "attended" | "unattended"; ticket: string; reason: string };

const TICKET = "[A-Z][A-Z0-9]*-\\d+";
// A reason may follow the tickets after `:`, `(`, `#` or a dash, and a line may end in a period;
// anything else (`and TUC-3`, a list) makes the line unreadable rather than half-read.
const BLOCKS_LINE = new RegExp(`^(${TICKET})\\s+blocks\\s+(${TICKET})\\s*(?:\\.?$|[:(#]|[—–-]\\s)`, "i");
const LINK_LINE = new RegExp(`^(${TICKET})\\s+(duplicates|relates\\s+to)\\s+(${TICKET})\\s*(?:\\.?$|[:—–-]\\s*(.*)$)`, "i");
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
  const link = LINK_LINE.exec(line);
  if (link) return { kind: link[2].toLowerCase() === "duplicates" ? "duplicates" : "relates", ticket: link[1].toUpperCase(), other: link[3].toUpperCase(), reason: (link[4] ?? "").trim() };
  const mark = MARK_LINE.exec(line);
  return mark ? { kind: mark[1].toLowerCase() as "hold" | "release" | "attended" | "unattended", ticket: mark[2].toUpperCase(), reason: (mark[3] ?? "").trim() } : null;
}

// The approved plan's ```project-order block: `TUC-1 blocks TUC-2`, `TUC-3 duplicates TUC-9: reason`,
// `TUC-4 relates to TUC-8: reason`, `hold TUC-3: reason`, `release TUC-4`, `attended TUC-5: reason`,
// `unattended TUC-6`. Unreadable lines are left out (see `orderProblems`).
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

function orderLine(step: OrderStep): string {
  if (step.kind === "blocks") return `${step.blocker} blocks ${step.blocked}`;
  const reason = step.reason ? `: ${step.reason}` : "";
  if (step.kind === "duplicates") return `${step.ticket} duplicates ${step.other}${reason}`;
  if (step.kind === "relates") return `${step.ticket} relates to ${step.other}${reason}`;
  return `${step.kind} ${step.ticket}${reason}`;
}

type Deps = {
  linear: Pick<LinearService, "labeledProjects" | "projectIssues" | "issueDescriptions" | "openTeamIssues" | "issueRef" | "issueDocument" | "createIssue" | "addLabel" | "removeLabel" | "delegate" | "addBlocker" | "relate" | "complete" | "comment" | "appUserId" | "viewerId">;
  scheduler: Pick<Scheduler, "note" | "admit" | "release">;
  // The cap the starter's start paths admit under (max agents, or a memory lease).
  capacity: Pick<Capacity, "limit">;
  store?: ProjectStore;
  // Stops the planner's turn and archives it once its plan is applied.
  retire: (agentId: string, paseo: PaseoApi) => Promise<void>;
  // Starts a new agent with a new Linear thread for a planner ticket (SessionRouter.restartFor).
  // Assigning the ticket to Paseo again is no restart: Linear opens no new thread for it, and a
  // thread whose launch failed is in error.
  restart: (issueId: string, identifier: string) => Promise<void>;
  // Whether something still accounts for a missing agent: a start under way, or the ticket's newest
  // Linear thread waits for blockers or a slot, had an agent once or was closed on purpose
  // (Launcher.underWay, SessionRouter.threadHolds).
  accountedFor: (issueId: string) => Promise<boolean>;
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
        } else if (open && read.plannerIssue && !open.approved && !read.plannerIssue.labels.some((name) => name.toLowerCase() === PLAN_READY_LABEL)) {
          await this.revive(project.id, open, paseo)
            .catch((error: unknown) => console.error(`[linear-tickets] ${open.identifier}: restarting the planner failed, the first poll after ${RESTART_GRACE_MS / 60_000} minutes retries: ${message(error)}`));
        }
        // Always on: new tickets get a planner as soon as none is open.
        const status = !open && read.unplanned.length
          ? await this.filePlanner(project, read, appId, settings).catch((error: unknown) => { console.error(`[linear-tickets] project ${project.name}: filing the planner failed, the next poll retries: ${message(error)}`); return read.status; })
          : read.status;
        statuses.push(status);
        await this.handOut(project.id, read, appId, paseo, settings);
        await this.reviveStalled(project.id, read, appId, paseo, settings)
          .catch((error: unknown) => console.error(`[linear-tickets] project ${project.name}: restarting stalled tickets failed, the next poll retries: ${message(error)}`));
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
    // Taken before the tickets are read: a planner filed from this read lists no ticket newer.
    const readAt = new Date(this.now()).toISOString();
    const issues = await this.deps.linear.projectIssues(project.id);
    const stored = (await this.store.all())[project.id];
    let record: ProjectRecord = stored ? migrated(stored, issues) : { planned: [], planner: null };
    if (stored && record !== stored) await this.store.update(project.id, (current) => current ? migrated(current, issues) : null);
    // A planner closed without an approved plan (the owner canceled or finished it): its tickets
    // count as planned, so they are not offered for planning again. One with an approved order
    // stays until the order is written (`write` then leaves the ticket as it is).
    const gone = record.planner && !record.planner.approved && !issues.some((issue) => issue.id === record.planner!.id) ? record.planner.id : null;
    if (gone) {
      await this.store.update(project.id, (current) => {
        const next = current && migrated(current, issues);
        return next?.planner?.id === gone && !next.planner.approved ? { ...next, planned: plannedAfter(next, next.planner, issues), planner: null, closedPlanner: gone } : null;
      });
      record = (await this.store.all())[project.id] ?? record;
    }
    const plannerId = record.planner?.id;
    const plannerIssue = plannerId ? issues.find((issue) => issue.id === plannerId) ?? null : null;
    const work = issues.filter((issue) => issue.id !== plannerId && !issue.labels.some((name) => name.toLowerCase() === labels.planner.toLowerCase()));
    const owner = await this.deps.linear.viewerId();
    const plannedIds = new Set(record.planned ?? []);
    const planned = (issue: ProjectIssue) => plannedIds.has(issue.id);
    const unplanned = work.filter((issue) => !planned(issue) && (HAND_OUT_TYPES.has(issue.statusType) || issue.statusType === "triage")
      && !issue.delegateId && !issue.parentId && (!issue.assigneeId || issue.assigneeId === owner));
    // Tickets the open planner already lists are in review, not waiting for a plan.
    const listed = new Set(record.planner?.listed ?? []);
    const toPlan = unplanned.filter((issue) => !listed.has(issue.id)).length;
    const planner = record.planner ? plannerSummary(record.planner) : null;
    return { work, record, plannerIssue, owner, readAt, planned, unplanned, status: { id: project.id, name: project.name, toPlan, planner, readAt } };
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
      const teams = new Map<string, number>();
      for (const issue of read.work) teams.set(issue.teamId, (teams.get(issue.teamId) ?? 0) + 1);
      const teamId = [...teams.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const descriptions = await this.deps.linear.issueDescriptions(read.work.map((issue) => issue.id));
      // One more than listed, to tell the planner when the list stops short.
      const teamIssues = await this.deps.linear.openTeamIssues([...teams.keys()], OTHER_TICKETS + read.work.length + 1);
      const others = teamIssues.filter((issue) => issue.projectId !== project.id);
      const created = await this.deps.linear.createIssue({ teamId, projectId: project.id, ready: true, priority: 1, title: `Plan the work order of ${project.name}`, description: plannerBrief(project.name, read.work, read.unplanned, descriptions, others.slice(0, OTHER_TICKETS), others.length > OTHER_TICKETS || teamIssues.length > OTHER_TICKETS + read.work.length, labels) });
      const planner: PlannerRecord = { id: created.id, identifier: created.identifier, url: created.url, listedAt: read.readAt, listed: read.work.map((issue) => issue.id), tickets: read.unplanned.length, started: false };
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
    await this.store.update(projectId, (current) => current?.planner?.id === planner.id ? { ...current, planner: { ...current.planner, started: true, startedAt: new Date(this.now()).toISOString() } } : null);
  }

  // A started planner whose agent never came up (TUC-678: its launch timed out) or stopped without
  // a plan (closed after idling, archived) would hold its project for good: no new planner is filed
  // while it is open. RESTART_GRACE_MS after its (re)start without a live agent it is started again
  // with a new thread, at most RESTART_CAP times; then the owner is asked once on the ticket.
  private async revive(projectId: string, planner: PlannerRecord, paseo: PaseoApi): Promise<void> {
    const since = planner.startedAt ?? planner.listedAt;
    if (planner.ownerAsked || this.now() - Date.parse(since) < RESTART_GRACE_MS) return;
    const page = await paseo.agents.list({ filter: { labels: { "linear.issueId": planner.id }, includeArchived: false }, page: { limit: 20 } });
    if (page.entries.some(({ agent }) => !agent.labels?.["paseo.parent-agent-id"] && LIVE_AGENT[agent.status])) return;
    const restarts = planner.restarts ?? 0;
    if (restarts >= RESTART_CAP) {
      await this.deps.linear.comment(planner.id, `**No agent is planning this work order.** Paseo started this planner ${restarts + 1} times, and none of its agents is working on it now (the start failed, or the agent stopped without submitting a plan), so it stops trying. Start an agent for it from the Linear tickets sidebar, or close this ticket to skip the work order: its tickets then count as planned and are handed out without one.`);
      await this.store.update(projectId, (current) => current?.planner?.id === planner.id ? { ...current, planner: { ...current.planner, ownerAsked: true } } : null);
      console.error(`[linear-tickets] ${planner.identifier}: no live planner agent after ${restarts} restarts; left to the owner`);
      return;
    }
    // Counted before the start, so a start that keeps failing still reaches the cap, and the grace
    // runs from now: a start still under way when the next poll comes is not doubled.
    await this.store.update(projectId, (current) => current?.planner?.id === planner.id ? { ...current, planner: { ...current.planner, restarts: restarts + 1, startedAt: new Date(this.now()).toISOString() } } : null);
    console.log(`[linear-tickets] ${planner.identifier}: no live planner agent since its start at ${since}; restart ${restarts + 1} of ${RESTART_CAP}`);
    await this.deps.restart(planner.id, planner.identifier);
  }

  // Ranked by the scheduler; each admitted ticket is assigned to Paseo, whose session then starts
  // it in its reserved slot. A ticket with open sub-issues in the project is a group: assigning it
  // takes no slot, its sub-issues are handed out by the group. Withheld tickets are left to you, and
  // so are, until it is written, those an approved order not yet in Linear blocks, holds or marks
  // attended: Linear does not show that order yet, so they would start against it.
  private async handOut(projectId: string, read: Read, appId: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const labels = dispatchLabels(settings.dispatch.label);
    const skip = new Set([labels.hold, labels.manual, labels.needsYou, labels.running, labels.failed, settings.dispatch.label].map((name) => name.toLowerCase()));
    const withheld = new Set(read.record.withheld ?? []);
    const pending = (await this.store.all())[projectId]?.planner?.approved;
    const ordered = new Set(pending ? parseOrder(pending.plan).flatMap((step) => step.kind === "blocks" ? [step.blocked] : step.kind === "hold" || step.kind === "attended" ? [step.ticket] : []) : []);
    const parents = new Set(read.work.map((issue) => issue.parentId).filter(Boolean));
    const ready = read.work.filter((issue) => read.planned(issue) && !withheld.has(issue.id) && !ordered.has(issue.identifier) && HAND_OUT_TYPES.has(issue.statusType) && !issue.delegateId && (!issue.assigneeId || issue.assigneeId === read.owner)
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

  // Tickets assigned to Paseo that never got an agent: the launch failed (TUC-53: "Daemon client
  // closed", TUC-534: OMP did not come up) or Linear's webhook never arrived (TUC-290). The ticket
  // stays assigned to Paseo, so the hand-out never takes it again, and assigning Paseo once more
  // opens no new thread. Such a ticket still waits in Backlog or Todo (a started agent moves it
  // on), is not a group (a parent waits there while its sub-issues work), has no live agent, no
  // start under way, and its newest thread neither waits for a slot, ever had an agent nor was
  // closed on purpose (a plan approved for later is back in Todo on purpose, a delegation by
  // someone else was refused). RESTART_GRACE_MS after it is first seen so it is started again with
  // a new thread, admitted like any start, at most RESTART_CAP times; then the owner is asked once.
  // One restart per poll: a start takes a minute or two, and the dispatcher's poll waits for it.
  private async reviveStalled(projectId: string, read: Read, appId: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const labels = dispatchLabels(settings.dispatch.label);
    // Labelled tickets belong to the label dispatch, held ones and the owner's tasks to the owner.
    const skip = new Set([labels.hold, labels.manual, labels.needsYou, labels.running, labels.failed, settings.dispatch.label].map((name) => name.toLowerCase()));
    const parents = new Set(read.work.map((issue) => issue.parentId).filter(Boolean));
    const suspects = read.work.filter((issue) => issue.delegateId === appId && HAND_OUT_TYPES.has(issue.statusType) && !parents.has(issue.id)
      && !issue.labels.some((name) => skip.has(name.toLowerCase())) && issue.blockers.every((blocker) => blocker.finished));
    const stalled: ProjectIssue[] = [];
    for (const issue of suspects) {
      const page = await paseo.agents.list({ filter: { labels: { "linear.issueId": issue.id }, includeArchived: false }, page: { limit: 20 } });
      if (page.entries.some(({ agent }) => !agent.labels?.["paseo.parent-agent-id"] && LIVE_AGENT[agent.status])) continue;
      if (await this.deps.accountedFor(issue.id)) continue;
      stalled.push(issue);
    }
    const now = new Date(this.now()).toISOString();
    const records = await this.store.update(projectId, (current) => {
      const base = current ?? read.record;
      const previous = base.stalled ?? {};
      const next = Object.fromEntries(stalled.map((issue) => [issue.id, previous[issue.id] ?? { since: now, restarts: 0 }]));
      return JSON.stringify(next) === JSON.stringify(previous) ? null : { ...base, stalled: next };
    }).then((record) => record?.stalled ?? read.record.stalled ?? {});
    for (const issue of stalled) {
      const entry = records[issue.id];
      if (!entry || entry.ownerAsked || this.now() - Date.parse(entry.since) < RESTART_GRACE_MS) continue;
      if (entry.restarts >= RESTART_CAP) {
        await this.deps.linear.comment(issue.id, `**Paseo could not start an agent for this ticket.** It is assigned to Paseo, but Paseo restarted it ${entry.restarts} times and no agent is working on it now (the start failed, or the agent never came up), so it stops trying. Start an agent for it from the Linear tickets sidebar, or add the \`${settings.dispatch.label}\` label to try again.`);
        await this.store.update(projectId, (current) => current?.stalled?.[issue.id] ? { ...current, stalled: { ...current.stalled, [issue.id]: { ...entry, ownerAsked: true } } } : null);
        console.error(`[linear-tickets] ${issue.identifier}: no live agent after ${entry.restarts} restarts; left to the owner`);
        continue;
      }
      // Admitted like a hand-out, so a restart never takes more than the free slots; one that
      // waits for its turn is not counted.
      const admission = await this.deps.scheduler.admit({
        issueId: issue.id, identifier: issue.identifier, projectId, priority: issue.priority, unblocks: issue.blocks.length, createdAt: issue.createdAt,
        attended: needsOwner(issue.labels, settings.dispatch.label),
      }, paseo, this.deps.capacity.limit(settings.dispatch.maxRunning));
      if (!admission.ok) continue;
      // Counted before the start, so a start that keeps failing still reaches the cap, and the
      // grace runs from now: a start still under way at the next poll is not doubled.
      await this.store.update(projectId, (current) => current?.stalled?.[issue.id] ? { ...current, stalled: { ...current.stalled, [issue.id]: { since: now, restarts: entry.restarts + 1 } } } : null);
      console.log(`[linear-tickets] ${issue.identifier}: assigned to Paseo without an agent since ${entry.since}; restart ${entry.restarts + 1} of ${RESTART_CAP}`);
      await this.deps.restart(issue.id, issue.identifier).catch((error: unknown) => {
        this.deps.scheduler.release(issue.id);
        console.error(`[linear-tickets] ${issue.identifier}: restart failed, the first poll after ${RESTART_GRACE_MS / 60_000} minutes retries: ${message(error)}`);
      });
      return;
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
  // its agent. The changes that went through are kept with the approval, so a write retried by a
  // later poll repeats only the others and never redoes what the owner changed since (a removed
  // `paseo-hold` stays removed). Changes that did not reach Linear are retried every poll; changes
  // Linear refuses for APPLY_TRIES polls (at once when the planner ticket is no longer open:
  // closing it ends the wait) are skipped, and a ticket whose `hold` or blocker was skipped is
  // withheld instead of handed out unordered.
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
      const already = new Set(planner.approved.done ?? []);
      for (const step of parseOrder(planner.approved.plan)) {
        const line = orderLine(step);
        const target = byIdentifier.get(step.kind === "blocks" ? step.blocked : step.ticket);
        if (already.has(line)) {
          done.push(line);
          if (step.kind === "release" && target) released.add(target.id);
          continue;
        }
        try {
          if (step.kind === "blocks") {
            const blocker = byIdentifier.get(step.blocker);
            if (!blocker || !target) { skipped.push(`${line} (not an open ticket of the project)`); continue; }
            // Already there (an earlier write of this order, or the owner): counted as applied.
            if (!target.blockers.some((item) => item.id === blocker.id)) await this.deps.linear.addBlocker(blocker.id, target.id);
          } else if (step.kind === "duplicates" || step.kind === "relates") {
            if (!target) { skipped.push(`${line} (not an open ticket of the project)`); continue; }
            // The other side may be any ticket, in this project or not, open or done.
            const other = byIdentifier.get(step.other) ?? await this.deps.linear.issueRef(step.other);
            if (!other) { skipped.push(`${line} (${step.other} does not exist)`); continue; }
            if (other.id === target.id) { skipped.push(`${line} (a ticket cannot be linked to itself)`); continue; }
            // Already linked (an earlier write of this order, or the owner): counted as applied. Any
            // link counts for `relates to`; only A's own duplicate link to B for `duplicates`.
            if (target.linked.some((item) => item.id === other.id && (step.kind === "relates" || item.kind === "duplicates"))) { done.push(line); continue; }
            if (step.kind === "relates") await this.deps.linear.relate(target.id, other.id, "related");
            else {
              // A duplicate closes the ticket in Linear: never one that is started or with an agent.
              if (!(HAND_OUT_TYPES.has(target.statusType) || target.statusType === "triage") || target.delegateId) { skipped.push(`${line} (started or with an agent; only a ticket nobody works on is closed as a duplicate)`); continue; }
              // Held first, so it is never handed out should Linear not close it.
              await this.deps.linear.addLabel(target.id, labels.hold);
              await this.deps.linear.comment(target.id, `Closed as a duplicate of ${other.identifier} by the work order of ${planner.identifier}${step.reason ? `: ${step.reason}` : "."}`);
              await this.deps.linear.relate(target.id, other.id, "duplicate");
            }
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
      const approved = planner.approved;
      if (done.some((line) => !already.has(line))) {
        await this.store.update(projectId, (current) => current?.planner?.id === planner.id && (current.planner.approved?.plan ?? approved.plan) === approved.plan
          ? { ...current, planner: { ...current.planner, approved: { ...approved, done } } } : null);
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
      await this.store.update(projectId, (stored) => {
        const current = stored && migrated(stored, issues);
        return current?.planner?.id === planner.id ? {
          planned: plannedAfter(current, current.planner, issues),
          planner: null,
          closedPlanner: planner.id,
          withheld: [...new Set([...(current.withheld ?? []).filter((id) => openIds.has(id) && !released.has(id)), ...withhold.keys()])],
        } : null;
      });
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

// The planner ticket's description: what to decide, the answer format, every open ticket of the
// project (NEW ones also in full) and the other open tickets of its teams.
export function plannerBrief(projectName: string, work: ProjectIssue[], unplanned: ProjectIssue[], descriptions: Map<string, string>, others: TeamIssue[], othersCut: boolean, labels: { hold: string; attended: string }): string {
  const fresh = new Set(unplanned.map((issue) => issue.id));
  const lines = work.map((issue) => {
    const blockers = issue.blockers.filter((blocker) => !blocker.finished).map((blocker) => blocker.identifier);
    const linked = issue.linked.map((other) => `${other.kind === "related" ? "related to" : other.kind} ${other.identifier}`);
    const text = (descriptions.get(issue.id) ?? "").replace(/\s+/g, " ").trim();
    const facts = [issue.status, issue.priority ? `P${issue.priority}` : "", issue.labels.join(", "), blockers.length ? `blocked by ${blockers.join(", ")}` : "", ...linked, fresh.has(issue.id) ? "NEW" : ""].filter(Boolean).join(" · ");
    return `- **${issue.identifier}** ${issue.title} (${facts})${text ? `\n  ${text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1)}…` : text}` : ""}`;
  });
  let budget = NEW_DESCRIPTIONS_BUDGET;
  const full = work.filter((issue) => fresh.has(issue.id)).map((issue) => {
    const text = (descriptions.get(issue.id) ?? "").trim();
    const room = Math.min(NEW_DESCRIPTION_CHARS, budget);
    const shown = text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text;
    budget -= shown.length;
    const quoted = shown ? shown.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n") : "> (no description)";
    return `### ${issue.identifier} ${issue.title}\n\n${quoted}${shown.length < text.length ? "\n\n(Cut here: read the full description in Linear.)" : ""}`;
  });
  const otherLines = others.map((issue) => `- **${issue.identifier}** ${issue.title} (${[issue.status, issue.projectName || "no project"].join(" · ")})`);
  return [
    `Paseo hands the open tickets of **${projectName}** to agents on its own, up to the agent limit at once. Before it hands out the tickets marked NEW, decide their work order. Do not change code: this ticket only produces the order.`,
    "Look for overlap first. Compare every NEW ticket with every other ticket below, in this project and outside it, and search Linear (the linear_ticket tool `search_issues`, or another Linear read tool such as `list_issues` with a query) for open tickets the lists do not show. Two tickets overlap when they change the same feature, files or data, or one already asks for what the other does. Before you decide on a ticket whose title or excerpt touches a NEW ticket's topic, read its full description in Linear. Your plan gets an `## Overlaps` section: every overlap found and the line of the order that handles it, or \"None found\" with the search terms you used.",
    `Read the tickets below and the code they touch, then write a plan with a \`## Work order\` section holding a fenced block in exactly this format:`,
    "```project-order\nTUC-12 blocks TUC-15\nTUC-24 duplicates TUC-9: TUC-9 already adds the export, including the CSV columns\nTUC-25 relates to TUC-31: both change the dunning e-mails\nhold TUC-20: too big, split it first\nrelease TUC-21\nattended TUC-23: which customer groups get the discount is not decided\n```",
    [
      "- `A blocks B`: B must not start before A is finished. Add one where B builds on A, or where both change the same files and would conflict as parallel pull requests. Both must be open tickets of this project.",
      `- \`A duplicates B: reason\`: A asks for nothing that B does not already cover. A is a ticket of this project that is not started and not with an agent; B is any ticket, in this project or not, open or done. A gets the \`${labels.hold}\` label, the reason as a comment and the duplicate link to B, which closes A in Linear. Only for complete coverage: a partial overlap is \`relates to\`, plus \`blocks\` where one must land first.`,
      "- `A relates to B: reason`: A (open, in this project) and B (any ticket) touch the same feature, files or data, but each keeps work of its own. The link shows each ticket's agent the other one.",
      `- \`hold X: reason\`: X must not start at all until the owner acts (too big, should be split, waits on a decision outside the code). It gets the \`${labels.hold}\` label and is not handed out until the owner removes it.`,
      "- `release X`: a ticket held earlier may now be handed out.",
      `- \`attended X: reason\`: an agent can do X, but will very likely have to stop and ask the owner during the work. X still plans at any time, but its plan always goes to the owner, and its implementation starts only while the owner is present; unmarked tickets also run at night, unattended. Mark a ticket only for one of these: a business decision the ticket leaves open, acceptance criteria too vague to check, user-facing wording or layout the owner must choose, changes to production data, external accounts or spend, or a step only a person can do. Size, difficulty, risk or code review alone are no reason: most tickets stay unmarked. It gets the \`${labels.attended}\` label.`,
      "- `unattended X`: X no longer needs the owner present (removes an earlier `attended`).",
      "- Tickets not mentioned are handed out as soon as they are unblocked; independent tickets run in parallel.",
      "- One change per line, a reason only after a colon (`TUC-1 blocks TUC-2, TUC-3` is not read: write two lines). A block Paseo cannot read line by line is sent back to you.",
    ].join("\n"),
    "Rate the work order itself in the plan's `## Risk and impact` section (the advisor record needs it), not the tickets: it only changes Linear (blocking relations, related and duplicate links, and labels; a duplicate is closed, and reopening it undoes that), and every ticket still plans and is approved on its own. That is impact 0 with reversibility `revert`, and `- New rule: no`. Answer `## Reach` and `## Principles and rules` in one line each (e.g. \"Only this project's tickets in Linear; each ticket's own plan answers where else it applies.\" and \"None apply; no new rule.\"). The work order is applied without the owner, so anything that needs them goes under `hold` or `attended`.",
    "Once you submit the plan, Paseo approves it automatically, writes the order into Linear and closes this ticket. Nothing is left to implement then: stop.",
    `## Open tickets of ${projectName} (${work.length})\n\n${lines.join("\n")}`,
    full.length ? `## NEW tickets in full\n\n${full.join("\n\n")}` : "",
    `## Open tickets outside ${projectName}, same team (${others.length}${othersCut ? "+" : ""})\n\n${otherLines.length ? otherLines.join("\n") : "None."}${othersCut ? `\n\nOnly the ${others.length} most recently updated are listed; search Linear for older ones.` : ""}`,
  ].filter(Boolean).join("\n\n");
}
