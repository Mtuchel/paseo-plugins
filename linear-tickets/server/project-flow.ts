import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { ProjectStatus } from "../shared/contracts";
import type { Capacity } from "./capacity";
import { dispatchLabels } from "./dispatch";
import { refusedByLinear, type LinearService, type ProjectIssue, type TeamIssue } from "./linear";
import type { Scheduler } from "./scheduler";
import { needsOwner } from "./presence";
import { classifyRunAgents, classifyTicketAgents, type ProcessInspector, type TicketAgents } from "./process-liveness";
import { SetupError, type PlannerStart } from "./launch";
import type { RepairRecord } from "./label-repair";
import { withPriority } from "./rate-budget";
import type { PluginSettings, Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";
import { activeModel } from "./model";
import { availability, candidates, LIMIT_DAY, LIMIT_SPACING, limitError, limitSchedule, limitTime, normalizeModel, type UsageReader } from "./limit-resume";

// Projects carrying the trigger label move forward on their own (README, "Projects"):
// 1. Whenever a project has had unplanned tickets long enough, the plugin starts a planner run of
//    its own (no Linear ticket): an agent asks for the work order of the new tickets: which tickets
//    block which, which must wait for the owner (hold), and which may need them while they run
//    (attended). Its plan is approved automatically and written into Linear as blocking relations
//    and `<trigger>-hold`/`-attended` labels. `linear.plan-project` starts a run right away instead
//    of at the next read, `linear.skip-plan` closes one without an order.
// 2. Every poll, the project's planned, unblocked, unheld tickets that nobody has are handed to
//    Paseo in the scheduler's order, one per free agent slot. Each ticket plans on its own.
// 3. An approved work order is kept with the record before it is written, and every poll writes
//    one that is not in Linear yet (README, "Projects"), so a failed write never stops the project.
// 4. A started run without a live agent is started again after a grace period, a few times, then
//    left to the owner (README, "Projects"), so a failed launch never stalls the project.
// 5. So is a ticket assigned to Paseo whose start failed or never came (README, "Projects"): it
//    stays assigned to Paseo, so the hand-out would never take it again.

// How often the projects are checked; their tickets are read through `projectIssues`, which on the
// host reads only what changed most of the time (project-issues.ts).
const POLL_MS = 2 * 60_000;
// A run waits for the project's tickets to settle: it starts PLAN_QUIET_MS after the newest
// unplanned ticket was first seen (no new ticket came in), or PLAN_MAX_WAIT_MS after the oldest one
// anyway, so a steady trickle still gets its order within the hour (README, "Projects").
const PLAN_QUIET_MS = 15 * 60_000;
const PLAN_MAX_WAIT_MS = 60 * 60_000;
// The planner's brief stays within this. The run's prompt does not ride Linear's 200,000-character
// agent context (the ticket planners before it did, and ERP's 409 open tickets with a description
// excerpt each went past it: TUC-1094 never started), but a bounded brief keeps the planner's
// first read and the context saved for its plan advisor small, and what does not fit is left to
// the planner's Linear search.
const BRIEF_CHARS = 120_000;
// NEW tickets are also given in full, each up to NEW_DESCRIPTION_CHARS and all of them together up
// to NEW_DESCRIPTIONS_BUDGET; past it the planner reads the rest in Linear.
const NEW_DESCRIPTION_CHARS = 4_000;
const NEW_DESCRIPTIONS_BUDGET = 30_000;
// Open tickets of the project's teams outside the project, listed by title (about 100 characters
// each), most recently updated first, as far as BRIEF_CHARS leaves room.
const OTHER_TICKETS = 300;
const HAND_OUT_TYPES = new Set(["backlog", "unstarted"]);
// Polls a work order is retried while Linear refuses some of its changes, before it is closed with
// them skipped. Changes that did not reach Linear (rate limit, outage) are retried without limit.
const APPLY_TRIES = 3;
// A started run without a live agent this long after its (re)start is started again. A start takes
// a couple of minutes (TUC-678: filed 08:26:04, its workspace stood at 08:26:46, the daemon gave up
// waiting for the agent at 08:27:46), so ten minutes never starts a second agent beside one still
// launching, and a project stalls by a failed start for at most that plus one read.
const RESTART_GRACE_MS = 10 * 60_000;
// Starts per run before it is left to the owner: a start that fails this often (another agent
// cannot come up, the daemon keeps timing out) needs them, not another try.
const RESTART_CAP = 3;

const recoveryTime = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const plannerRecoverySchema = z.object({
  attempt: z.number().int().nonnegative(),
  claims: z.array(recoveryTime),
  handledAgentId: z.string().optional(),
  pending: z.object({
    identity: z.string(), error: z.string(), model: z.string().nullable(), failedAt: recoveryTime,
    resumeAt: recoveryTime, fallbackAt: recoveryTime, jitterMs: z.number().min(60_000).max(300_000),
    basis: z.enum(["room", "reset", "retry-after", "default"]), selector: z.string().nullable(),
  }).optional(),
  claim: z.object({ requestId: z.string(), at: recoveryTime }).optional(),
});
type PlannerRecovery = z.infer<typeof plannerRecoverySchema>;

function recoveryOf(run: PlannerRecord): PlannerRecovery | undefined {
  if (run.recovery === undefined) return undefined;
  const parsed = plannerRecoverySchema.safeParse(run.recovery);
  if (!parsed.success) throw new Error(`Planner ${run.id}: corrupt usage-limit recovery metadata; automatic recovery is stopped.`);
  return parsed.data;
}

// `planned`: the tickets in an approved (or closed) plan: those its run listed. Kept by id, not by
// creation time, so a ticket created while a run works, or moved into the project from elsewhere,
// is new until a run lists it. Tickets no longer open in the project drop out when a run closes.
// `plannedThrough`: what older versions kept instead (tickets created up to then were planned);
// `migrated` turns it into `planned` with the project's tickets of that time.
// `planner`: the open run: its `id` (the run uuid; the agent carries it as `linear.plannerRun`),
// the time its ticket list was taken (`listedAt`), the tickets it `listed` and how many new tickets
// it plans; `started`: false until its agent is up; `startedAt`: when it was last (re)started;
// `agentId`: the agent the last start created; `restarts`: how often it was started again without a
// live agent (a stopped agent, or a start that failed); `ownerAsked`: past RESTART_CAP, or on a
// start that cannot succeed, the owner was asked once to start it or skip it; `error`: why it is
// stuck; `approved`: its approved work order, until it is written into Linear, with the changes of
// it already `done` in Linear.
// `closedPlanner`: the run closed last, so a late report of its review is ignored, not applied twice.
// `waiting`: when the flow first saw each unplanned ticket, pruned to them on every read: the
// batching rule starts a run from these times.
// `withheld`: tickets whose `hold` or blocker Linear refused: planned, but never handed out by the
// project; you hand them out yourself.
export type PlannerRecord = {
  id: string; listedAt: string; listed?: string[]; tickets: number; started?: boolean;
  startedAt?: string; agentId?: string; restarts?: number; ownerAsked?: boolean; error?: string;
  approved?: { agentId: string | null; plan: string; done?: string[] };
  recovery?: PlannerRecovery;
};
// A ticket assigned to Paseo whose start failed: `since` it was first seen so or last started
// again, `restarts` so far, `ownerAsked` past RESTART_CAP.
export type StalledRecord = { since: string; restarts: number; ownerAsked?: boolean };

// Validate the durable status fields without stripping lifecycle/recovery metadata or legacy
// planner-ticket fields. Unknown state must fail the status read, not dismiss an owner's alert.
const projectRecordSchema = z.object({
  name: z.string().optional(),
  planner: z.object({
    id: z.string(), listedAt: z.string(), tickets: z.number().int().nonnegative(),
    agentId: z.string().optional(), startedAt: z.string().optional(),
    restarts: z.number().int().nonnegative().optional(), ownerAsked: z.boolean().optional(),
    error: z.string().optional(),
  }).passthrough().nullable(),
}).passthrough();
type PlannerLimitRestart = { runId: string; requestId: string; agentId: string; confirmedAt: string; failedAgentId?: string };
const RESTART_HISTORY_MS = 8 * 24 * 60 * 60_000;

function confirmedRestart(record: ProjectRecord, run: PlannerRecord, requestId: string, agentId: string, now: number): ProjectRecord {
  const entries = record.plannerLimitRestarts ?? [];
  if (entries.some((entry) => entry.runId === run.id && entry.requestId === requestId)) return record;
  return { ...record, plannerLimitRestarts: [...entries, {
    runId: run.id, requestId, agentId, confirmedAt: new Date(now).toISOString(),
    ...(run.recovery?.handledAgentId ? { failedAgentId: run.recovery.handledAgentId } : {}),
  }] };
}
export type ProjectRecord = { name?: string; planned?: string[]; plannedThrough?: string | null; planner: PlannerRecord | null; closedPlanner?: string; waiting?: Record<string, string>; withheld?: string[]; stalled?: Record<string, StalledRecord>; plannerLimitRestarts?: PlannerLimitRestart[] };

type Read = { work: ProjectIssue[]; record: ProjectRecord; owner: string; readAt: string; planned: (issue: ProjectIssue) => boolean; unplanned: ProjectIssue[]; status: ProjectStatus };

// A ticket planner of an older version (a record carrying its Linear ticket's `identifier`): runs
// have no Linear ticket, so it is dropped. Its `listed` tickets are NOT marked planned — the next
// run plans them, and the old ticket itself is left alone (the operator cancels it).
function ticketPlanner(planner: unknown): planner is { identifier: string } {
  return Boolean(planner && typeof planner === "object" && "identifier" in planner && typeof planner.identifier === "string");
}

// A record of an older version, which planned by creation time, with the tickets those times cover
// now as its planned and listed tickets, so what was planned stays planned. The same record when
// there is nothing to migrate.
function migrated(record: ProjectRecord, issues: ProjectIssue[]): ProjectRecord {
  const covered = (through: string | null | undefined) => through ? issues.filter((issue) => issue.createdAt <= through).map((issue) => issue.id) : [];
  const planner = ticketPlanner(record.planner) ? null : record.planner && !record.planner.listed ? { ...record.planner, listed: covered(record.planner.listedAt) } : record.planner;
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

// The label repair's records (label-repair.ts) share projects.json under this key; project ids
// never start with "~", and older versions keep the key because they write the whole file back.
const REPAIRS_KEY = "~repairs";

export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path = join(paseoHome(), "linear-tickets", "projects.json"), private readonly now = Date.now) {}

  private async raw(): Promise<Record<string, unknown>> {
    const source = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The durable project state is malformed: expected a project record object.");
    }
    return value as Record<string, unknown>;
  }

  async all(): Promise<Record<string, ProjectRecord>> {
    const { [REPAIRS_KEY]: _repairs, ...projects } = await this.raw();
    for (const [id, record] of Object.entries(projects)) {
      if (!projectRecordSchema.safeParse(record).success) {
        throw new Error(`The durable project state for ${id} is malformed; planner status is unknown.`);
      }
    }
    return projects as Record<string, ProjectRecord>;
  }

  async repairs(): Promise<Record<string, RepairRecord>> {
    return ((await this.raw())[REPAIRS_KEY] ?? {}) as Record<string, RepairRecord>;
  }

  // Changes run one after another, each on the file as it is then, so a poll and an approval never
  // overwrite each other's record. `change` returns the project's new record, or null to keep it.
  update(projectId: string, change: (current: ProjectRecord | undefined) => ProjectRecord | null): Promise<ProjectRecord | null> {
    return this.queued(async () => {
      const file = await this.raw();
      const next = change(file[projectId] as ProjectRecord | undefined);
      if (next) {
        if (next.plannerLimitRestarts) next.plannerLimitRestarts = next.plannerLimitRestarts.filter((entry) => Date.parse(entry.confirmedAt) >= this.now() - RESTART_HISTORY_MS);
        await this.save({ ...file, [projectId]: next });
      }
      return next;
    });
  }

  // The label repair's records, changed on the same queue as the projects': `change` returns them
  // all as they should be, or null to keep them. Resolves to the records as they are afterwards.
  updateRepairs(change: (current: Record<string, RepairRecord>) => Record<string, RepairRecord> | null): Promise<Record<string, RepairRecord>> {
    return this.queued(async () => {
      const file = await this.raw();
      const current = (file[REPAIRS_KEY] ?? {}) as Record<string, RepairRecord>;
      const next = change(current);
      if (next) await this.save({ ...file, [REPAIRS_KEY]: next });
      return next ?? current;
    });
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async save(file: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
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
  linear: Pick<LinearService, "labeledProjects" | "projectIssues" | "issueDescriptions" | "openTeamIssues" | "issueRef" | "addLabel" | "removeLabel" | "delegate" | "addBlocker" | "relate" | "comment" | "projectUpdate" | "appUserId" | "viewerId">;
  scheduler: Pick<Scheduler, "note" | "admit" | "release">;
  // The cap the starter's start paths admit under (max agents, or a memory lease). Planner runs
  // bypass it: they only order tickets, and while one waits none of its project's new tickets can
  // be handed out (README, "Who starts next").
  capacity: Pick<Capacity, "limit">;
  store?: ProjectStore;
  // Queued operations and launch preparation must not retain ownership after this host drains.
  settings?: Pick<Settings, "read">;
  // A project's open tickets; `full`: read all of them now (after this flow wrote to Linear). The
  // host passes ProjectIssueCache.read; without it every read is a full `linear.projectIssues`.
  projectIssues?: (projectId: string, full: boolean) => Promise<ProjectIssue[]>;
  // Starts the agent of a run (Launcher.startPlanner).
  startPlanner: (input: PlannerStart, paseo: PaseoApi, settings: PluginSettings) => Promise<{ agentId: string }>;
  // Stops the run's turn and archives it once its plan is applied, skipped, or replaced.
  retire: (agentId: string, paseo: PaseoApi) => Promise<void>;
  // Starts a new agent with a new Linear thread for a stalled ticket (SessionRouter.restartFor).
  // Assigning the ticket to Paseo again is no restart: Linear opens no new thread for it, and a
  // thread whose launch failed is in error.
  restart: (issueId: string, identifier: string) => Promise<void>;
  // Whether something still accounts for a missing agent: a start under way, or the ticket's newest
  // Linear thread waits for blockers or a slot, had an agent once or was closed on purpose
  // (Launcher.underWay, SessionRouter.threadHolds).
  accountedFor: (issueId: string) => Promise<boolean>;
  now?: () => number;
  // Provider-process inspection for ghost agents; the tests inject a fake process table.
  inspect?: ProcessInspector;
  usage?: Pick<UsageReader, "read" | "chains">;
  jitter?: () => number;
};

export class ProjectFlow {
  private readonly store: ProjectStore;
  private readonly projectIssues: (projectId: string, full: boolean) => Promise<ProjectIssue[]>;
  private lastPoll = 0;
  private statuses: ProjectStatus[] = [];
  // Reads, launch attempts, Skip and order writes share one queue per project. An RPC waits for
  // an in-flight launch/write before changing its record, so neither can outlive a successful Skip.
  private readonly operations = new Map<string, Promise<unknown>>();
  // Per run, the plan text and the reads in which Linear refused some of its changes.
  private readonly refusedTries = new Map<string, { plan: string; tries: number }>();

  constructor(private readonly deps: Deps) {
    this.store = deps.store ?? new ProjectStore();
    this.projectIssues = deps.projectIssues ?? ((projectId) => deps.linear.projectIssues(projectId));
  }

  private exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(projectId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.operations.set(projectId, result);
    const release = () => { if (this.operations.get(projectId) === result) this.operations.delete(projectId); };
    void result.then(release, release);
    return result;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async currentSettings(settings: PluginSettings): Promise<PluginSettings> {
    return this.deps.settings ? this.deps.settings.read() : settings;
  }

  private requireOwner(settings: PluginSettings): void {
    if (settings.activation.mode === "remote") {
      throw new Error(`This host forwards new Linear work to ${settings.activation.peer ?? "the peer host"}; open that host in Paseo and use Plan or Skip there. Project planners are not forwarded.`);
    }
  }

  private async ownerSettings(settings: PluginSettings): Promise<PluginSettings> {
    this.requireOwner(await this.currentSettings(settings));
    // Keep the operation's label/model snapshot coherent; only fresh ownership can abort it.
    return settings;
  }

  // Whether a top-level agent works on the ticket: live by its status and not a ghost, on any page
  // of its agents. A ghost is logged, so a restart it causes is explained.
  private async working(paseo: PaseoApi, issueId: string, identifier: string): Promise<boolean> {
    const agents = await classifyTicketAgents(paseo, issueId, this.now(), this.deps.inspect);
    for (const ghost of agents.ghosts) console.log(`[linear-tickets] ${identifier}: agent ${ghost.id.slice(0, 8)} shows ${ghost.status} but its OMP process is gone; it counts as stopped`);
    return agents.live.length > 0;
  }

  // Tickets the label repair (label-repair.ts) watches, restarts or left to the owner: the
  // hand-out and the stalled-ticket restart leave them alone, so no second restart cycle starts.
  private async repairing(): Promise<Set<string>> {
    return new Set(Object.entries(await this.store.repairs()).filter(([, record]) => record.state !== "resolved").map(([id]) => id));
  }

  // Keep the last successful ticket read, but take planner state from disk: a reload or Linear
  // outage must neither hide a held run nor keep a failure that has since recovered or closed.
  async status(): Promise<ProjectStatus[]> {
    const records = await this.store.all();
    const cached = new Set(this.statuses.map((status) => status.id));
    const statuses = this.statuses.map((status) => ({
      ...status,
      planner: records[status.id]?.planner ? plannerSummary(records[status.id].planner!) : null,
    }));
    for (const [id, record] of Object.entries(records)) {
      if (cached.has(id) || !record.planner?.ownerAsked || record.planner.approved) continue;
      statuses.push({
        id, name: record.name ?? id, toPlan: 0, plansAt: null,
        planner: plannerSummary(record.planner), readAt: record.planner.listedAt,
      });
    }
    return statuses;
  }

  // Called on every dispatch poll; reads the projects at most every POLL_MS. Each project runs on
  // its own, so one failing project does not stop the others, and within a project a failing
  // work order or planner never stops the hand-out of tickets already planned. Background priority
  // is set here, not left to the dispatch tick that usually calls it, so a direct call pauses at the
  // pool's reserve too (see rate-budget.ts).
  async tick(paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    await withPriority("background", "project-flow", async () => {
      if (settings.activation.mode === "remote") return;
      settings = await this.currentSettings(settings);
      if (settings.activation.mode === "remote") return;
      if (this.now() - this.lastPoll < POLL_MS) return;
      this.lastPoll = this.now();
      const appId = await this.deps.linear.appUserId();
      // Hand-outs start through Linear agent sessions; without the Paseo app nothing would start.
      if (!appId) { this.statuses = []; return; }
      const statuses: ProjectStatus[] = [];
      for (const project of await this.deps.linear.labeledProjects(settings.dispatch.label)) {
        try {
          await this.exclusive(project.id, async () => {
            settings = await this.currentSettings(settings);
            if (settings.activation.mode === "remote") return;
            let read = await this.read(project, settings);
            settings = await this.ownerSettings(settings);
            await this.retireObsolete(project.id, paseo);
            const planner = read.record.planner;
            if (planner?.approved) {
              const written = await this.write(project.id, planner, paseo, settings)
                .catch((error: unknown) => { console.error(`[linear-tickets] project ${project.name}: writing the work order failed, the next read retries: ${message(error)}`); return false; });
              if (written) read = await this.read(project, settings, true);
            }
            const open = read.record.planner;
            let status = read.status;
            if (settings.dispatch.enabled && open && !open.startedAt && !open.approved && !open.ownerAsked) {
              status = await this.launchRun(project, open, read, settings, paseo)
                .catch((error: unknown) => { console.error(`[linear-tickets] project ${project.name}: starting the planner failed: ${message(error)}`); return read.status; });
            } else if (settings.dispatch.enabled && open && !open.approved && !open.ownerAsked) {
              await this.revive(project, open, read, settings, paseo)
                .catch((error: unknown) => console.error(`[linear-tickets] project ${project.name}: restarting the planner failed, the first read after ${RESTART_GRACE_MS / 60_000} minutes retries: ${message(error)}`));
            } else if (settings.dispatch.enabled && !open && read.unplanned.length && this.settled(read.record.waiting ?? {}, read.unplanned)) {
              // The tickets have waited for their plan (none newer than the quiet time, or the oldest
              // at the max wait): start the run.
              status = await this.startRun(project, read, settings, paseo)
                .catch((error: unknown) => { console.error(`[linear-tickets] project ${project.name}: starting the planner failed, the next read retries: ${message(error)}`); return read.status; });
            }
            statuses.push(await this.runStatus(project.id, status));
            settings = await this.currentSettings(settings);
            if (settings.activation.mode === "remote") return;
            await this.handOut(project.id, read, appId, paseo, settings);
            await this.reviveStalled(project.id, read, appId, paseo, settings)
              .catch((error: unknown) => console.error(`[linear-tickets] project ${project.name}: restarting stalled tickets failed, the next read retries: ${message(error)}`));
          });
        } catch (error) {
          console.error(`[linear-tickets] project ${project.name}: ${message(error)}`);
        }
      }
      this.statuses = statuses;
    });
  }

  // The project's open tickets and what is planned. Only tickets the hand-out could take need a
  // plan: sub-issues (their group hands them out), tickets already with Paseo or someone else, and
  // started work never count.
  private async read(project: { id: string; name: string }, settings: PluginSettings, full = false): Promise<Read> {
    // An old ticket planner (README, "Projects"): its ticket is no longer used, and the record is
    // dropped with it (`migrated`), so the next run plans what it listed.
    const legacyPlanner = `${settings.dispatch.label}-planner`.toLowerCase();
    // Taken before the tickets are read: a run started from this read lists no ticket newer.
    const readAt = new Date(this.now()).toISOString();
    const issues = await this.projectIssues(project.id, full);
    const stored = (await this.store.all())[project.id];
    let record: ProjectRecord = stored ? migrated(stored, issues) : { planned: [], planner: null };
    if (stored && record !== stored) await this.store.update(project.id, (current) => current ? migrated(current, issues) : null);
    const legacy = stored?.planner;
    if (ticketPlanner(legacy)) console.log(`[linear-tickets] project ${project.name}: the planner ticket ${legacy.identifier} is no longer used; a plugin run plans its tickets`);
    // An old planner ticket still open would otherwise look like a ticket to hand out.
    const work = issues.filter((issue) => !issue.labels.some((name) => name.toLowerCase() === legacyPlanner));
    const owner = await this.deps.linear.viewerId();
    const plannedIds = new Set(record.planned ?? []);
    const planned = (issue: ProjectIssue) => plannedIds.has(issue.id);
    const unplanned = work.filter((issue) => !planned(issue) && (HAND_OUT_TYPES.has(issue.statusType) || issue.statusType === "triage")
      && !issue.delegateId && !issue.parentId && (!issue.assigneeId || issue.assigneeId === owner));
    // Tickets the open run already lists are with it, not waiting for another plan.
    const listed = new Set(record.planner?.listed ?? []);
    const toPlan = unplanned.filter((issue) => !listed.has(issue.id)).length;
    // When each unplanned ticket was first seen, pruned to them: the batching rule counts from a
    // ticket's own arrival, and a ticket that left delays nothing.
    const updated = await this.store.update(project.id, (current) => {
      const base = current ?? record;
      const waiting = Object.fromEntries(unplanned.map((issue) => [issue.id, base.waiting?.[issue.id] ?? readAt]));
      return { ...base, name: project.name, waiting };
    });
    record = updated ?? record;
    const planner = record.planner ? plannerSummary(record.planner) : null;
    return { work, record, owner, readAt, planned, unplanned, status: { id: project.id, name: project.name, toPlan, plansAt: planner ? null : this.plansAt(record.waiting ?? {}, unplanned), planner, readAt } };
  }

  // `linear.plan-project`: starts a run for the project's unplanned tickets right away instead of
  // at the next read, and replaces a run left to the owner (its agent is archived, the new run
  // starts over). One run per project at a time.
  async planNow(projectId: string, settings: PluginSettings, paseo: PaseoApi, background = false): Promise<ProjectStatus> {
    this.requireOwner(settings);
    return this.exclusive(projectId, async () => {
      settings = await this.ownerSettings(settings);
      const appId = await this.deps.linear.appUserId();
      if (!appId) throw new Error("The Paseo Linear app is not installed on this host, so nothing would start the planner.");
      const project = (await this.deps.linear.labeledProjects(settings.dispatch.label)).find((item) => item.id === projectId);
      if (!project) throw new Error(`This project no longer carries the "${settings.dispatch.label}" label.`);
      let read = await this.read(project, settings);
      const open = read.record.planner;
      if (open && !open.ownerAsked) throw new Error("A planner is already planning the work order of this project.");
      if (open) {
        await this.store.update(project.id, (current) => current?.planner?.id === open.id ? { ...current, planner: null, closedPlanner: open.id } : null);
        await this.retireObsolete(project.id, paseo, open.agentId);
        read = await this.read(project, settings);
      }
      if (!read.unplanned.length) throw new Error("No new tickets to plan.");
      const status = await this.startRun(project, read, settings, paseo, background);
      if (!status.planner) throw new Error("A planner for this project is being started right now.");
      this.statuses = [...this.statuses.filter((item) => item.id !== project.id), status];
      return status;
    });
  }

  // `linear.skip-plan`: stops the open run without an order (README, "Projects"). Its listed
  // tickets count as planned and are handed out unordered, and its agent is archived.
  async skipPlan(projectId: string, settings: PluginSettings, paseo: PaseoApi): Promise<ProjectStatus> {
    this.requireOwner(settings);
    return this.exclusive(projectId, async () => {
      settings = await this.ownerSettings(settings);
      const project = (await this.deps.linear.labeledProjects(settings.dispatch.label)).find((item) => item.id === projectId);
      if (!project) throw new Error(`This project no longer carries the "${settings.dispatch.label}" label.`);
      const read = await this.read(project, settings);
      const open = read.record.planner;
      if (!open) throw new Error("No planner is planning the work order of this project.");
      const stored = await this.store.update(project.id, (current) => current?.planner?.id === open.id
        ? { ...current, planned: plannedAfter(current, current.planner, read.work), planner: null, closedPlanner: current.planner.id }
        : null);
      if (stored) await this.retireObsolete(project.id, paseo, open.agentId);
      if (stored) console.log(`[linear-tickets] project ${project.name}: the work order was skipped; its ${open.tickets} ticket${open.tickets === 1 ? "" : "s"} count as planned`);
      const after = await this.read(project, settings);
      this.statuses = [...this.statuses.filter((item) => item.id !== project.id), after.status];
      return after.status;
    });
  }

  // A creation whose response was lost can become visible after Skip/replacement. The project
  // label lets every later poll retire all obsolete roots, even after another run closes.
  private async retireObsolete(projectId: string, paseo: PaseoApi, recordedAgent?: string): Promise<void> {
    const activeRun = (await this.store.all())[projectId]?.planner?.id;
    const obsolete = new Set(recordedAgent ? [recordedAgent] : []);
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { labels: { "linear.projectId": projectId }, includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) {
        const runId = agent.labels?.["linear.plannerRun"];
        if (runId && runId !== activeRun && !agent.labels?.["paseo.parent-agent-id"]) obsolete.add(agent.id);
      }
      cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    for (const id of obsolete) await this.deps.retire(id, paseo);
  }

  // Starts a run for the project's unplanned tickets: the record first (the next read retries
  // whatever the store says is missing, and no second run starts while one is open), then its
  // agent. A read and Plan at the same time start one run: the other returns the status unchanged.
  private async startRun(project: { id: string; name: string }, read: Read, settings: PluginSettings, paseo: PaseoApi, background = false): Promise<ProjectStatus> {
    // Started since this read (by the other path).
    const current = (await this.store.all())[project.id]?.planner;
    if (current) return { ...read.status, toPlan: 0, plansAt: null, planner: plannerSummary(current) };
    const run: PlannerRecord = { id: randomUUID(), listedAt: read.readAt, listed: read.work.map((issue) => issue.id), tickets: read.unplanned.length, started: false };
    await this.store.update(project.id, (record) => ({ ...(record ?? read.record), planner: run }));
    console.log(`[linear-tickets] project ${project.name}: planner run ${run.id.slice(0, 8)} for ${read.unplanned.length} new ticket${read.unplanned.length === 1 ? "" : "s"}`);
    if (background) {
      // The RPC acknowledges the persisted run, not provider readiness (which can take minutes).
      // Queue behind this operation; a poll already queued may start it first, so recheck attempts.
      void this.exclusive(project.id, async () => {
        const currentSettings = await this.currentSettings(settings);
        if (currentSettings.activation.mode === "remote") return;
        const pending = (await this.store.all())[project.id]?.planner;
        if (pending?.id !== run.id || pending.startedAt || pending.approved || pending.ownerAsked) return;
        await this.launchRun(project, pending, read, currentSettings, paseo);
      }).catch((error: unknown) => console.error(`[linear-tickets] project ${project.name}: starting the planner failed; the next read after the grace retries: ${message(error)}`));
    } else await this.launchRun(project, run, read, settings, paseo);
    const stored = (await this.store.all())[project.id]?.planner ?? run;
    return { ...read.status, toPlan: 0, plansAt: null, planner: plannerSummary(stored) };
  }

  // Recovered runs keep a live recorded root authoritative even if an uncertain older creation
  // appears later. With no live recorded root, adopt deterministically; retire all other roots.
  private async adoptLive(projectId: string, run: PlannerRecord, agents: TicketAgents, paseo: PaseoApi): Promise<boolean> {
    const live = (run.recovery && agents.live.find((agent) => agent.id === run.agentId))
      || agents.live.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id))[0];
    if (!live) return false;
    await this.store.update(projectId, (current) => {
      if (current?.planner?.id !== run.id || current.planner.approved || current.planner.ownerAsked) return null;
      const recovery = recoveryOf(current.planner);
      const requestId = live.labels?.["linear.plannerRequest"];
      const prefix = `planner-${run.id}-limit-`;
      const suffix = requestId?.startsWith(prefix) ? requestId.slice(prefix.length) : "";
      const attempt = /^[1-9]\d*$/.test(suffix) ? Number(suffix) : 0;
      const evidence = recovery?.pending && attempt > 0 && attempt <= recovery.attempt
        && live.id !== current.planner.agentId && live.id !== recovery.handledAgentId
        ? confirmedRestart(current, current.planner, requestId!, live.id, this.now()) : current;
      return { ...evidence, planner: { ...current.planner, started: true, agentId: live.id, startedAt: current.planner.startedAt ?? new Date(this.now()).toISOString(), error: undefined,
        ...(run.recovery ? { recovery: { ...recovery!, pending: undefined, claim: undefined, handledAgentId: undefined } } : {}) } };
    });
    if (run.recovery) {
      for (const agent of [...agents.live, ...agents.stopped, ...agents.ghosts]) {
        if (agent.id !== live.id) await this.deps.retire(agent.id, paseo);
      }
    }
    return true;
  }

  private async launchAvailability(settings: PluginSettings) {
    const selector = settings.lastProvider ? settings.launchPreferences?.[settings.lastProvider]?.model ?? null : null;
    const [chains, reports] = await Promise.all([this.deps.usage?.chains() ?? {}, this.deps.usage?.read() ?? null]);
    return { selector, recovery: reports ? availability(reports, selector ? candidates(chains, selector) : [], this.now()).recovery : null };
  }

  private async scheduleLimit(projectId: string, run: PlannerRecord, identity: string, error: string, model: string | null, settings: PluginSettings, failedAgentId?: string): Promise<void> {
    const hint = limitError(error)!;
    const old = recoveryOf(run) ?? { attempt: 0, claims: [] };
    if (old.pending?.identity === identity) return;
    const reading = await this.launchAvailability(settings);
    const now = this.now();
    const jitterMs = this.deps.jitter?.() ?? 60_000 + Math.floor(Math.random() * 240_001);
    const timing = limitSchedule(reading.recovery, hint.retryAfterMs, now, () => jitterMs);
    const fallback = limitSchedule(null, hint.retryAfterMs, now, () => jitterMs);
    const pending: NonNullable<PlannerRecovery["pending"]> = {
      identity, error, model: model ? normalizeModel(model) : null, failedAt: new Date(now).toISOString(),
      resumeAt: new Date(timing.resumeAt).toISOString(), fallbackAt: new Date(fallback.resumeAt).toISOString(),
      jitterMs, basis: timing.basis, selector: reading.selector,
    };
    await this.store.update(projectId, (current) => current?.planner?.id === run.id && !current.planner.approved && !current.planner.ownerAsked
      ? { ...current, planner: { ...current.planner, agentId: failedAgentId ?? current.planner.agentId,
        recovery: { ...old, handledAgentId: failedAgentId ?? old.handledAgentId, pending }, error } } : null);
  }

  // No new jitter or fallback deadline while waiting. Room can advance a wait, but only for the
  // selector the same settings snapshot will launch; preference changes invalidate old room.
  private async limitReady(projectId: string, run: PlannerRecord, settings: PluginSettings): Promise<boolean> {
    const recovery = recoveryOf(run)!;
    const pending = recovery.pending!;
    const reading = await this.launchAvailability(settings);
    const now = this.now();
    let at = Date.parse(pending.resumeAt);
    let basis = pending.basis;
    if (reading.recovery?.roomNow) { at = now; basis = "room"; }
    else if (pending.selector !== reading.selector || basis === "room") {
      const reset = reading.recovery?.earliestReset;
      at = reset !== null && reset !== undefined ? reset + pending.jitterMs : Date.parse(pending.fallbackAt);
      basis = reset !== null && reset !== undefined ? "reset" : limitError(pending.error)?.retryAfterMs ? "retry-after" : "default";
    } else if (reading.recovery?.earliestReset !== null && reading.recovery?.earliestReset !== undefined && reading.recovery.earliestReset > now) {
      at = Math.max(at, reading.recovery.earliestReset + pending.jitterMs);
      basis = "reset";
    }
    const claims = recovery.claims.filter((claim) => Date.parse(claim) > now - LIMIT_DAY);
    if (claims.length) at = Math.max(at, Math.max(...claims.map(Date.parse)) + LIMIT_SPACING);
    // A lost launch response keeps its original grace even if another account has room.
    if (pending.identity !== run.agentId || recovery.claim) at = Math.max(at, Date.parse(run.startedAt ?? run.listedAt) + RESTART_GRACE_MS);
    const provider = limitError(pending.error)?.provider ?? pending.model?.split("/")[0] ?? "provider";
    const updated = { ...pending, resumeAt: new Date(at).toISOString(), basis, selector: reading.selector };
    await this.store.update(projectId, (current) => current?.planner?.id === run.id && !current.planner.approved && !current.planner.ownerAsked
      ? { ...current, planner: { ...current.planner, recovery: { ...recovery, claims, pending: updated },
        error: `Usage limit on ${provider}: Paseo starts a new agent at ${limitTime(at, now)}.` } } : null);
    return at <= now;
  }

  private async restartLimit(project: { id: string; name: string }, run: PlannerRecord, read: Read, settings: PluginSettings, paseo: PaseoApi): Promise<ProjectStatus> {
    settings = await this.ownerSettings(settings);
    if (!await this.limitReady(project.id, run, settings)) return this.runStatus(project.id, read.status);
    const brief = await this.brief(project, read, settings);
    // Broker/brief reads can outlive an uncertain creation: inspect again before spending a slot.
    run = (await this.store.all())[project.id]?.planner!;
    if (!run || run.approved || run.ownerAsked) return this.runStatus(project.id, read.status);
    const agents = await classifyRunAgents(paseo, run.id, this.now(), this.deps.inspect);
    if (await this.adoptLive(project.id, run, agents, paseo)) return this.runStatus(project.id, read.status);
    if (!await this.limitReady(project.id, run, settings)) return this.runStatus(project.id, read.status);
    run = (await this.store.all())[project.id].planner!;
    settings = await this.ownerSettings(settings);
    const recovery = recoveryOf(run)!;
    if (recovery.claims.length >= 4) {
      await this.askOwner(project, run, "The planner reached four usage-limit restart attempts in twenty-four hours.");
      return this.runStatus(project.id, read.status);
    }
    const at = new Date(this.now()).toISOString();
    const attempt = recovery.attempt + 1;
    const requestId = `planner-${run.id}-limit-${attempt}`;
    await this.store.update(project.id, (current) => current?.planner?.id === run.id && !current.planner.approved && !current.planner.ownerAsked
      ? { ...current, planner: { ...current.planner, startedAt: at, recovery: { ...recovery, attempt, claims: [...recovery.claims, at], claim: { requestId, at } } } } : null);
    let agentId: string;
    try {
      ({ agentId } = await this.deps.startPlanner({ runId: run.id, linearProjectId: project.id, projectName: project.name, teamId: this.busiestTeam(read.work), requestId, brief }, paseo, settings));
    } catch (error) {
      const current = (await this.store.all())[project.id].planner!;
      if (error instanceof SetupError) await this.askOwner(project, current, message(error));
      else if (limitError(message(error))) {
        await this.scheduleLimit(project.id, current, requestId, message(error), /\bmodel=([^\s,)]+)/i.exec(message(error))?.[1] ?? null, settings);
        await this.limitReady(project.id, (await this.store.all())[project.id].planner!, settings);
      } else if (/Agent creation could not be confirmed/i.test(message(error))) {
        // The response is uncertain, not proof no agent was created. Keep the spent claim and
        // pending limit until adoption or the next separately bounded identity after the grace.
        console.error(`[linear-tickets] project ${project.name}: uncertain limit restart: ${message(error)}`);
      } else {
        await this.store.update(project.id, (record) => record?.planner?.id === run.id ? { ...record, planner: { ...record.planner, error: message(error),
          recovery: { ...recoveryOf(record.planner)!, pending: undefined, claim: undefined } } } : null);
        throw error;
      }
      return this.runStatus(project.id, read.status);
    }
    // External creation has succeeded. Persistence/retirement failures are not failed creations.
    await this.store.update(project.id, (current) => current?.planner?.id === run.id
      ? { ...confirmedRestart(current, current.planner, requestId, agentId, this.now()), planner: { ...current.planner, started: true, agentId, error: undefined,
        recovery: { ...recoveryOf(current.planner)!, pending: undefined, claim: undefined } } } : null);
    for (const stopped of [...agents.stopped, ...agents.ghosts]) await this.deps.retire(stopped.id, paseo);
    return this.runStatus(project.id, read.status);
  }

  // Inspect roots before either retry budget. Provider limits use durable reset-aware claims;
  // other failures keep the original grace/cap, and SetupError immediately leaves the run held.
  private async launchRun(project: { id: string; name: string }, run: PlannerRecord, read: Read, settings: PluginSettings, paseo: PaseoApi): Promise<ProjectStatus> {
    settings = await this.ownerSettings(settings);
    const again = run.startedAt !== undefined;
    const agents = await classifyRunAgents(paseo, run.id, this.now(), this.deps.inspect);
    for (const ghost of agents.ghosts) console.log(`[linear-tickets] project ${project.name}: planner agent ${ghost.id.slice(0, 8)} shows ${ghost.status} but its OMP process is gone; it counts as stopped`);
    recoveryOf(run); // Corruption never clears a durable budget or silently takes the generic path.
    if (await this.adoptLive(project.id, run, agents, paseo)) return this.runStatus(project.id, read.status);
    const stopped = run.agentId ? agents.stopped.find((agent) => agent.id === run.agentId)
      : agents.stopped.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
    if (!run.recovery?.pending && stopped?.status === "error" && stopped.id !== run.recovery?.handledAgentId && limitError(stopped.lastError ?? "")) {
      await this.scheduleLimit(project.id, run, stopped.id, stopped.lastError!, activeModel(stopped), settings, stopped.id);
      run = (await this.store.all())[project.id].planner!;
    }
    if (run.recovery?.pending) return this.restartLimit(project, run, read, settings, paseo);
    const restarts = run.restarts ?? 0;
    if (again && restarts >= RESTART_CAP) {
      await this.askOwner(project, run, `Paseo started the planner ${restarts + 1} times, and none of its agents is working on it now (the start failed, or the agent stopped without submitting a plan).`);
      return this.runStatus(project.id, read.status);
    }
    const brief = await this.brief(project, read, settings);
    settings = await this.ownerSettings(settings);
    const counted = again ? restarts + 1 : restarts;
    const attemptAt = new Date(this.now()).toISOString();
    await this.store.update(project.id, (current) => current?.planner?.id === run.id ? { ...current, planner: { ...current.planner, restarts: counted, startedAt: attemptAt } } : null);
    if (again) console.log(`[linear-tickets] project ${project.name}: no live planner agent since its start at ${run.startedAt}; restart ${counted} of ${RESTART_CAP}`);
    let agentId: string;
    const requestId = run.recovery ? `planner-${run.id}-restart-${counted}-after-limit-${run.recovery.attempt}` : `planner-${run.id}-${counted}`;
    try {
      agentId = (await this.deps.startPlanner({ runId: run.id, linearProjectId: project.id, projectName: project.name, teamId: this.busiestTeam(read.work), requestId, brief }, paseo, settings)).agentId;
    } catch (error) {
      if (error instanceof SetupError) {
        await this.askOwner(project, { ...run, restarts: counted }, message(error));
        return this.runStatus(project.id, read.status);
      }
      if (limitError(message(error))) {
        await this.store.update(project.id, (current) => current?.planner?.id === run.id
          ? { ...current, planner: { ...current.planner, restarts } } : null);
        run = (await this.store.all())[project.id].planner!;
        await this.scheduleLimit(project.id, run, requestId, message(error), /\bmodel=([^\s,)]+)/i.exec(message(error))?.[1] ?? null, settings);
        await this.limitReady(project.id, (await this.store.all())[project.id].planner!, settings);
        return this.runStatus(project.id, read.status);
      }
      throw error;
    }
    await this.store.update(project.id, (current) => current?.planner?.id === run.id ? { ...current, planner: { ...current.planner, started: true, agentId, startedAt: new Date(this.now()).toISOString(), error: undefined } } : null);
    for (const stopped of agents.stopped) await paseo.agents.ref(stopped.id).archive().catch((error: unknown) => console.error(`[linear-tickets] project ${project.name}: archiving planner agent ${stopped.id.slice(0, 8)} failed: ${message(error)}`));
    return this.runStatus(project.id, read.status);
  }

  // A started run whose agent stopped without submitting a plan (closed after idling, archived,
  // lost with its process) would hold its project: no new run starts while it is open.
  // RESTART_GRACE_MS after its last start without a live agent it is started again for the same
  // run; a few tries, then the owner is asked once (README, "Projects").
  private async revive(project: { id: string; name: string }, run: PlannerRecord, read: Read, settings: PluginSettings, paseo: PaseoApi): Promise<void> {
    settings = await this.ownerSettings(settings);
    // Inspect every poll for live/limit roots; only the generic path obeys its ten-minute grace.
    recoveryOf(run);
    if (!run.recovery?.pending && this.now() - Date.parse(run.startedAt ?? run.listedAt) < RESTART_GRACE_MS) {
      const agents = await classifyRunAgents(paseo, run.id, this.now(), this.deps.inspect);
      if (await this.adoptLive(project.id, run, agents, paseo)) return;
      const stopped = run.agentId && agents.stopped.find((agent) => agent.id === run.agentId);
      if (!stopped || stopped.status !== "error" || stopped.id === run.recovery?.handledAgentId || !limitError(stopped.lastError ?? "")) return;
    }
    await this.launchRun(project, run, read, settings, paseo);
  }

  // The project's status as the store now has the run: the read's `toPlan` and `plansAt` still
  // hold (the run was open in it), only the run's own fields changed (started, agent, restarts, error).
  private async runStatus(projectId: string, base: ProjectStatus): Promise<ProjectStatus> {
    const planner = (await this.store.all())[projectId]?.planner;
    return planner ? { ...base, planner: plannerSummary(planner) } : base;
  }

  // Asks the owner once per run, as one Linear project update on the project (README, "Projects"),
  // written as the Paseo app. The record is marked first, so later reads neither repeat the notice
  // nor restart the run; a failed write is logged and never retried, and never blocks the project.
  private async askOwner(project: { id: string; name: string }, run: PlannerRecord, problem: string): Promise<void> {
    const stored = await this.store.update(project.id, (current) => current?.planner?.id === run.id && !current.planner.ownerAsked
      ? { ...current, planner: { ...current.planner, ownerAsked: true, error: problem } }
      : null);
    if (!stored) return;
    console.error(`[linear-tickets] project ${project.name}: no agent is planning the work order: ${problem}`);
    const body = `**No agent is planning the work order of ${project.name}.** ${problem}\n\nPress Plan in the Paseo Agents menu bar app to start again, or Skip to hand the tickets out without an order.`;
    await this.deps.linear.projectUpdate(project.id, body, true)
      .catch((error: unknown) => console.error(`[linear-tickets] project ${project.name}: the project update failed: ${message(error)}`));
  }

  // The busiest team of the project's tickets: the mapping fallback, and the team whose other open
  // tickets the brief lists (README, "Projects").
  private busiestTeam(work: ProjectIssue[]): string {
    const teams = new Map<string, number>();
    for (const issue of work) teams.set(issue.teamId, (teams.get(issue.teamId) ?? 0) + 1);
    return [...teams.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // The planner's brief (plannerBrief), from the project's tickets and the team's other open ones
  // (README, "Projects").
  private async brief(project: { id: string; name: string }, read: Read, settings: PluginSettings): Promise<string> {
    const descriptions = await this.deps.linear.issueDescriptions(read.work.map((issue) => issue.id));
    // One more than listed, to tell the planner when the list stops short.
    const teamIssues = await this.deps.linear.openTeamIssues([...new Set(read.work.map((issue) => issue.teamId))], OTHER_TICKETS + read.work.length + 1);
    const others = teamIssues.filter((issue) => issue.projectId !== project.id);
    return plannerBrief(project.name, read.work, read.unplanned, descriptions, others.slice(0, OTHER_TICKETS), others.length > OTHER_TICKETS || teamIssues.length > OTHER_TICKETS + read.work.length, dispatchLabels(settings.dispatch.label));
  }

  // When the batching rule will start a run: PLAN_QUIET_MS after the newest unplanned ticket was
  // first seen, or PLAN_MAX_WAIT_MS after the oldest, whichever comes first. Null when nothing
  // waits.
  private plansAt(waiting: Record<string, string>, unplanned: ProjectIssue[]): string | null {
    const times = unplanned.map((issue) => Date.parse(waiting[issue.id] ?? "")).filter((time) => Number.isFinite(time));
    if (!times.length) return null;
    return new Date(Math.min(Math.max(...times) + PLAN_QUIET_MS, Math.min(...times) + PLAN_MAX_WAIT_MS)).toISOString();
  }

  // Whether the unplanned tickets have waited for their plan (README, "Projects").
  private settled(waiting: Record<string, string>, unplanned: ProjectIssue[]): boolean {
    const at = this.plansAt(waiting, unplanned);
    return at !== null && Date.parse(at) <= this.now();
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
    const repairing = await this.repairing();
    const pending = (await this.store.all())[projectId]?.planner?.approved;
    const ordered = new Set(pending ? parseOrder(pending.plan).flatMap((step) => step.kind === "blocks" ? [step.blocked] : step.kind === "hold" || step.kind === "attended" ? [step.ticket] : []) : []);
    const parents = new Set(read.work.map((issue) => issue.parentId).filter(Boolean));
    const ready = read.work.filter((issue) => read.planned(issue) && !withheld.has(issue.id) && !repairing.has(issue.id) && !ordered.has(issue.identifier) && HAND_OUT_TYPES.has(issue.statusType) && !issue.delegateId && (!issue.assigneeId || issue.assigneeId === read.owner)
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
    const repairing = await this.repairing();
    const suspects = read.work.filter((issue) => issue.delegateId === appId && HAND_OUT_TYPES.has(issue.statusType) && !parents.has(issue.id) && !repairing.has(issue.id)
      && !issue.labels.some((name) => skip.has(name.toLowerCase())) && issue.blockers.every((blocker) => blocker.finished));
    const stalled: ProjectIssue[] = [];
    for (const issue of suspects) {
      if (await this.working(paseo, issue.id, issue.identifier)) continue;
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

  // Whether the run is a project's planner: the open one, or the one closed last (a late report of
  // its review is routed as a work order, and `applyPlan` ignores it).
  async isPlannerRun(runId: string): Promise<boolean> {
    return Object.values(await this.store.all()).some((record) => record.planner?.id === runId || record.closedPlanner === runId);
  }

  // An approved work order of the open run: kept with the record first, so a write that fails is
  // retried by the next read, then written. False when the run is no longer open — a report of a
  // closed run's review is ignored rather than applied twice.
  async applyPlan(runId: string, agentId: string | null, plan: string, paseo: PaseoApi, settings: PluginSettings): Promise<boolean> {
    this.requireOwner(settings);
    settings = await this.ownerSettings(settings);
    const projectId = Object.entries(await this.store.all()).find(([, record]) => record.planner?.id === runId)?.[0];
    if (!projectId) return false;
    return this.exclusive(projectId, async () => {
      settings = await this.ownerSettings(settings);
      const run = (await this.store.all())[projectId]?.planner;
      if (run?.recovery) {
        recoveryOf(run);
        if (!run.approved && !run.ownerAsked) {
          const agents = await classifyRunAgents(paseo, runId, this.now(), this.deps.inspect);
          await this.adoptLive(projectId, run, agents, paseo);
        }
        const canonical = (await this.store.all())[projectId]?.planner?.agentId;
        if (!agentId || canonical !== agentId) return false;
      }
      const stored = await this.store.update(projectId, (current) => current?.planner?.id === runId ? { ...current, planner: { ...current.planner, ownerAsked: false, error: undefined, approved: { agentId, plan } } } : null);
      const planner = stored?.planner;
      if (!planner) return false;
      await this.write(projectId, planner, paseo, settings)
        .catch((error: unknown) => console.error(`[linear-tickets] project ${projectId}: writing the work order failed, the next read retries: ${message(error)}`));
      return true;
    });
  }

  // Writes the order into Linear, marks its tickets planned and retires the run's agent. The
  // changes that went through are kept with the approval, so a write retried by a later read
  // repeats only the others and never redoes what the owner changed since (a removed `paseo-hold`
  // stays removed). Changes that did not reach Linear are retried every read; changes Linear
  // refuses for APPLY_TRIES reads are skipped, and a ticket whose `hold` or blocker was skipped is
  // withheld instead of handed out unordered.
  private async write(projectId: string, planner: PlannerRecord, paseo: PaseoApi, settings: PluginSettings): Promise<boolean> {
    settings = await this.ownerSettings(settings);
    const labels = dispatchLabels(settings.dispatch.label);
    const issues = await this.projectIssues(projectId, true);
    if ((await this.store.all())[projectId]?.planner?.id !== planner.id || !planner.approved) return false;
    this.requireOwner(await this.currentSettings(settings));
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
            await this.deps.linear.comment(target.id, `Closed as a duplicate of ${other.identifier} by the project's work order${step.reason ? `: ${step.reason}` : "."}`);
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
    if (refused.length && this.refusedTries.get(planner.id)!.tries < APPLY_TRIES) throw new Error(`Linear refused ${refused.length} change${refused.length === 1 ? "" : "s"}: ${refused.join("; ")}`);
    // A submission can write outside tick. Refresh the shared cache before tickets become
    // planned, so the next changed-only read cannot hand out a just-blocked ticket.
    await this.projectIssues(projectId, true);
    // The order's summary is one project update on the project (README, "Projects"): the run has
    // no Linear ticket to comment on or to close.
    await this.deps.linear.projectUpdate(projectId, [
      `**Work order applied** (${done.length} change${done.length === 1 ? "" : "s"}). The project's tickets are now handed to Paseo in order as agent slots free up.`,
      done.length ? `Applied:\n${done.map((line) => `- ${line}`).join("\n")}` : "",
      skipped.length || refused.length ? `Skipped:\n${[...skipped, ...refused].map((line) => `- ${line}`).join("\n")}` : "",
      withhold.size ? `Not handed out, because Linear refused their hold or blocker: ${[...withhold.values()].join(", ")}. Assign them to Paseo yourself when they may start.` : "",
    ].filter(Boolean).join("\n\n")).catch((error: unknown) => console.error(`[linear-tickets] project ${projectId}: the work order's project update failed: ${message(error)}`));
    const openIds = new Set(issues.map((issue) => issue.id));
    await this.store.update(projectId, (stored) => {
      const current = stored && migrated(stored, issues);
      return current?.planner?.id === planner.id ? {
        ...current,
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
  }
}

// The status contract's view of the open run (shared/contracts.ts projectStatusSchema).
function plannerSummary(planner: PlannerRecord): NonNullable<ProjectStatus["planner"]> {
  return { runId: planner.id, agentId: planner.agentId ?? null, startedAt: planner.startedAt ?? null, tickets: planner.tickets, restarts: planner.restarts ?? 0, ownerAsked: !planner.approved && (planner.ownerAsked ?? false), error: planner.error ?? null };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The planner's brief: what to decide, the answer format, the open tickets of the
// project one line each (NEW ones also in full) and the other open tickets of its teams, within
// BRIEF_CHARS. Every NEW ticket is always listed; older project tickets, then the tickets outside
// the project, are cut when the room runs out, and the list says so.
export function plannerBrief(projectName: string, work: ProjectIssue[], unplanned: ProjectIssue[], descriptions: Map<string, string>, others: TeamIssue[], othersCut: boolean, labels: { hold: string; attended: string }): string {
  const fresh = new Set(unplanned.map((issue) => issue.id));
  const line = (issue: ProjectIssue) => {
    const blockers = issue.blockers.filter((blocker) => !blocker.finished).map((blocker) => blocker.identifier);
    const linked = issue.linked.map((other) => `${other.kind === "related" ? "related to" : other.kind} ${other.identifier}`);
    const facts = [issue.status, issue.priority ? `P${issue.priority}` : "", issue.labels.join(", "), blockers.length ? `blocked by ${blockers.join(", ")}` : "", ...linked, fresh.has(issue.id) ? "NEW" : ""].filter(Boolean).join(" · ");
    return `- **${issue.identifier}** ${issue.title} (${facts})`;
  };
  let budget = NEW_DESCRIPTIONS_BUDGET;
  const full = work.filter((issue) => fresh.has(issue.id)).map((issue) => {
    const text = (descriptions.get(issue.id) ?? "").trim();
    const room = Math.min(NEW_DESCRIPTION_CHARS, budget);
    const shown = text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text;
    budget -= shown.length;
    const quoted = shown ? shown.split("\n").map((row) => `> ${row}`.trimEnd()).join("\n") : "> (no description)";
    return `### ${issue.identifier} ${issue.title}\n\n${quoted}${shown.length < text.length ? "\n\n(Cut here: read the full description in Linear.)" : ""}`;
  });
  const head = [
    `Paseo hands the open tickets of **${projectName}** to agents on its own, up to the agent limit at once. Before it hands out the tickets marked NEW, decide their work order. Do not change code: you only produce the order.`,
    "Look for overlap first. Compare every NEW ticket with every other ticket below, in this project and outside it, and search Linear (the linear_ticket tool `search_issues`, or another Linear read tool such as `list_issues` with a query) for open tickets the lists do not show. Two tickets overlap when they change the same feature, files or data, or one already asks for what the other does. The lists give each ticket in one line: before you decide on a ticket whose title touches a NEW ticket's topic, read its full description in Linear. Your plan gets an `## Overlaps` section: every overlap found and the line of the order that handles it, or \"None found\" with the search terms you used.",
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
    "Once you submit the plan, Paseo approves it automatically and writes the order into Linear. Nothing is left to implement then: stop.",
  ].join("\n\n");
  const fullSection = full.length ? `## NEW tickets in full\n\n${full.join("\n\n")}` : "";
  // Room for both lists, with some left for their headings and notes.
  let room = BRIEF_CHARS - head.length - fullSection.length - 1_000;
  const listed = new Set<string>();
  for (const issue of work) if (fresh.has(issue.id)) { listed.add(issue.id); room -= line(issue).length + 1; }
  for (const issue of work) {
    if (listed.has(issue.id)) continue;
    const length = line(issue).length + 1;
    if (length > room) break;
    listed.add(issue.id);
    room -= length;
  }
  const projectLines = work.filter((issue) => listed.has(issue.id)).map(line);
  const left = work.length - projectLines.length;
  const otherLines: string[] = [];
  for (const issue of others) {
    const text = `- **${issue.identifier}** ${issue.title} (${[issue.status, issue.projectName || "no project"].join(" · ")})`;
    if (text.length + 1 > room) break;
    otherLines.push(text);
    room -= text.length + 1;
  }
  const othersShort = othersCut || otherLines.length < others.length;
  return [
    head,
    `## Open tickets of ${projectName} (${work.length})\n\n${projectLines.join("\n")}${left ? `\n\n${left} more open ticket${left === 1 ? " is" : "s are"} not listed for length; search Linear for them.` : ""}`,
    fullSection,
    `## Open tickets outside ${projectName}, same team (${otherLines.length}${othersShort ? "+" : ""})\n\n${otherLines.length ? otherLines.join("\n") : "None."}${othersShort ? `\n\nOnly the ${otherLines.length} most recently updated are listed; search Linear for older ones.` : ""}`,
  ].filter(Boolean).join("\n\n");
}
