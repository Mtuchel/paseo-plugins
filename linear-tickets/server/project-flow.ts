import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { dispatchLabels } from "./dispatch";
import type { LinearService, ProjectIssue } from "./linear";
import { PLAN_LABEL } from "./plan-policy";
import type { Scheduler } from "./scheduler";
import type { PluginSettings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// Projects carrying the trigger label move forward on their own (README, "Projects"):
// 1. A planner ticket in the project asks an agent for the work order: which tickets block which,
//    and which must wait for the owner (hold). The owner approves its plan like any other; the
//    approved order is written into Linear as blocking relations and `<trigger>-hold` labels.
// 2. Every poll, the project's planned, unblocked, unheld tickets that nobody has are handed to
//    Paseo in the scheduler's order, one per free agent slot.
// Tickets filed after the last plan wait for the next one, which starts once no new ticket has
// arrived for a while.

// How often a project's tickets are read: a project is a few paginated queries.
const POLL_MS = 2 * 60_000;
// A new ticket starts the next planner only after this long without another new one, so a batch
// of tickets gets one planner.
const SETTLE_MS = 10 * 60_000;
// Ticket list in the planner's description: each ticket's description is cut to this, which keeps
// a 200-ticket project near 60,000 characters.
const DESCRIPTION_CHARS = 160;
const HAND_OUT_TYPES = new Set(["backlog", "unstarted"]);

// `plannedThrough`: tickets created up to this time are in an approved (or closed) plan.
// `planner`: the open planner ticket and the time its ticket list was taken.
export type ProjectRecord = { plannedThrough: string | null; planner: { id: string; identifier: string; listedAt: string } | null };

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
export type OrderStep = { kind: "blocks"; blocker: string; blocked: string } | { kind: "hold" | "release"; ticket: string; reason: string };

// The approved plan's ```project-order block: `TUC-1 blocks TUC-2`, `hold TUC-3: reason`,
// `release TUC-4`. Other lines are ignored.
export function parseOrder(plan: string): OrderStep[] {
  const block = /```project-order\s*\n([\s\S]*?)```/i.exec(plan)?.[1] ?? "";
  const steps: OrderStep[] = [];
  for (const line of block.split("\n").map((item) => item.replace(/^\s*[-*]\s*/, "").trim())) {
    const blocks = /^([A-Z][A-Z0-9]*-\d+)\s+blocks\s+([A-Z][A-Z0-9]*-\d+)\b/i.exec(line);
    if (blocks) { steps.push({ kind: "blocks", blocker: blocks[1].toUpperCase(), blocked: blocks[2].toUpperCase() }); continue; }
    const hold = /^(hold|release)\s+([A-Z][A-Z0-9]*-\d+)\s*[:—-]?\s*(.*)$/i.exec(line);
    if (hold) steps.push({ kind: hold[1].toLowerCase() as "hold" | "release", ticket: hold[2].toUpperCase(), reason: hold[3].trim() });
  }
  return steps;
}

type Deps = {
  linear: Pick<LinearService, "labeledProjects" | "projectIssues" | "issueDescriptions" | "createIssue" | "addLabel" | "removeLabel" | "delegate" | "addBlocker" | "complete" | "comment" | "appUserId" | "viewerId">;
  scheduler: Pick<Scheduler, "note" | "admit" | "release">;
  store?: ProjectStore;
  // Stops the planner's turn and archives it once its plan is applied.
  retire: (agentId: string, paseo: PaseoApi) => Promise<void>;
  now?: () => number;
};

export class ProjectFlow {
  private readonly store: ProjectStore;
  private lastPoll = 0;

  constructor(private readonly deps: Deps) {
    this.store = deps.store ?? new ProjectStore();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // Called on every dispatch poll; reads the projects at most every POLL_MS. Each project runs on
  // its own, so one failing project does not stop the others.
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    if (this.now() - this.lastPoll < POLL_MS) return;
    this.lastPoll = this.now();
    const appId = await this.deps.linear.appUserId();
    // Hand-outs start through Linear agent sessions; without the Paseo app nothing would start.
    if (!appId) return;
    for (const project of await this.deps.linear.labeledProjects(settings.dispatch.label)) {
      try {
        await this.advance(project, appId, paseo, settings);
      } catch (error) {
        console.error(`[linear-tickets] project ${project.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async advance(project: { id: string; name: string }, appId: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const labels = dispatchLabels(settings.dispatch.label);
    const issues = await this.deps.linear.projectIssues(project.id);
    let record = (await this.store.all())[project.id] ?? { plannedThrough: null, planner: null };
    // A planner closed without an applied plan (the owner canceled or finished it): its tickets
    // count as planned, so the project does not ask again for the same tickets.
    if (record.planner && !issues.some((issue) => issue.id === record.planner!.id)) {
      record = { plannedThrough: record.planner.listedAt, planner: null };
      await this.store.put(project.id, record);
    }
    const work = issues.filter((issue) => !issue.labels.some((name) => name.toLowerCase() === labels.planner.toLowerCase()));
    const planned = (issue: ProjectIssue) => record.plannedThrough !== null && issue.createdAt <= record.plannedThrough;
    const unplanned = work.filter((issue) => !planned(issue));
    const newest = Math.max(0, ...unplanned.map((issue) => Date.parse(issue.createdAt) || 0));
    if (!record.planner && unplanned.length && this.now() - newest >= SETTLE_MS) await this.plan(project, work, unplanned, appId, settings);
    await this.handOut(project.id, work, work.filter(planned), appId, paseo, settings);
  }

  private async plan(project: { id: string; name: string }, work: ProjectIssue[], unplanned: ProjectIssue[], appId: string, settings: PluginSettings): Promise<void> {
    const labels = dispatchLabels(settings.dispatch.label);
    const listedAt = new Date(this.now()).toISOString();
    const teams = new Map<string, number>();
    for (const issue of work) teams.set(issue.teamId, (teams.get(issue.teamId) ?? 0) + 1);
    const teamId = [...teams.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const descriptions = await this.deps.linear.issueDescriptions(work.map((issue) => issue.id));
    const created = await this.deps.linear.createIssue({ teamId, projectId: project.id, ready: true, priority: 1, title: `Plan the work order of ${project.name}`, description: plannerBrief(project.name, work, unplanned, descriptions, labels.hold) });
    await this.deps.linear.addLabel(created.id, labels.planner);
    await this.deps.linear.addLabel(created.id, PLAN_LABEL);
    await this.store.put(project.id, { plannedThrough: (await this.store.all())[project.id]?.plannedThrough ?? null, planner: { id: created.id, identifier: created.identifier, listedAt } });
    await this.deps.linear.delegate(created.id, appId);
    console.log(`[linear-tickets] project ${project.name}: planner ${created.identifier} for ${unplanned.length} new ticket${unplanned.length === 1 ? "" : "s"}`);
  }

  // Ranked by the scheduler; each admitted ticket is assigned to Paseo, whose session then starts
  // it in its reserved slot. A ticket with open sub-issues in the project is a group: assigning it
  // takes no slot, its sub-issues are handed out by the group.
  private async handOut(projectId: string, work: ProjectIssue[], planned: ProjectIssue[], appId: string, paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    const labels = dispatchLabels(settings.dispatch.label);
    const owner = await this.deps.linear.viewerId();
    const skip = new Set([labels.hold, labels.manual, labels.needsYou, labels.running, labels.failed, settings.dispatch.label].map((name) => name.toLowerCase()));
    const parents = new Set(work.map((issue) => issue.parentId).filter(Boolean));
    const ready = planned.filter((issue) => HAND_OUT_TYPES.has(issue.statusType) && !issue.delegateId && (!issue.assigneeId || issue.assigneeId === owner)
      && !issue.parentId && !issue.labels.some((name) => skip.has(name.toLowerCase())) && issue.blockers.every((blocker) => blocker.finished));
    for (const group of ready.filter((issue) => parents.has(issue.id))) {
      await this.deps.linear.delegate(group.id, appId);
      console.log(`[linear-tickets] project hand-out ${group.identifier}: group`);
    }
    const singles = ready.filter((issue) => !parents.has(issue.id));
    const candidates = singles.map((issue) => ({ issueId: issue.id, identifier: issue.identifier, projectId, priority: issue.priority, unblocks: issue.blocks.length, createdAt: issue.createdAt }));
    this.deps.scheduler.note(candidates);
    for (const candidate of candidates) {
      const admission = await this.deps.scheduler.admit(candidate, paseo, settings.dispatch.maxRunning);
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
      const line = step.kind === "blocks" ? `${step.blocker} blocks ${step.blocked}` : `${step.kind} ${step.ticket}`;
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
          else await this.deps.linear.removeLabel(ticket.id, labels.hold);
        }
        done.push(line);
      } catch (error) {
        skipped.push(`${line} (${error instanceof Error ? error.message : error})`);
      }
    }
    await this.store.put(projectId, { plannedThrough: record.planner!.listedAt, planner: null });
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
export function plannerBrief(projectName: string, work: ProjectIssue[], unplanned: ProjectIssue[], descriptions: Map<string, string>, holdLabel: string): string {
  const fresh = new Set(unplanned.map((issue) => issue.id));
  const lines = work.map((issue) => {
    const blockers = issue.blockers.filter((blocker) => !blocker.finished).map((blocker) => blocker.identifier);
    const text = (descriptions.get(issue.id) ?? "").replace(/\s+/g, " ").trim();
    const facts = [issue.status, issue.priority ? `P${issue.priority}` : "", issue.labels.join(", "), blockers.length ? `blocked by ${blockers.join(", ")}` : "", fresh.has(issue.id) ? "NEW" : ""].filter(Boolean).join(" · ");
    return `- **${issue.identifier}** ${issue.title} (${facts})${text ? `\n  ${text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1)}…` : text}` : ""}`;
  });
  return [
    `Paseo hands the open tickets of **${projectName}** to agents on its own, up to the agent limit at once. Before it hands out the tickets marked NEW, decide their work order. Do not change code: this ticket only produces the order.`,
    `Read the tickets below and the code they touch, then write a plan whose last section is a fenced block in exactly this format:`,
    "```project-order\nTUC-12 blocks TUC-15\nhold TUC-20: needs the owner's decision on pricing\nrelease TUC-21\n```",
    [
      "- `A blocks B`: B must not start before A is finished. Add one where B builds on A, or where both change the same files and would conflict as parallel pull requests.",
      `- \`hold X: reason\`: X waits for the owner (unclear, too big, needs a decision). It gets the \`${holdLabel}\` label and is not handed out until the owner removes it.`,
      "- `release X`: a ticket held earlier may now be handed out.",
      "- Tickets not mentioned are handed out as soon as they are unblocked; independent tickets run in parallel.",
    ].join("\n"),
    "Once the owner approves the plan, Paseo writes the order into Linear and closes this ticket. Nothing is left to implement then: stop.",
    `## Open tickets (${work.length})\n\n${lines.join("\n")}`,
  ].join("\n\n");
}
