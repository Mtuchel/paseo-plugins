import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions, PaseoWorkspaceCreateOptions } from "@getpaseo/client";
import type { TicketDetail } from "../shared/contracts";
import type { ActivationResume } from "./activation";
import { Dispatcher } from "./dispatch";
import { Handover } from "./handover";
import { Launcher, LEAD_INTRO, type ResumeTarget } from "./launch";
import type { IssueState, LabeledIssue } from "./linear";
import { SessionRouter, SessionStore, type HostOwnership, type SessionLink, type Succession } from "./sessions";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { ResumeUnavailableError, TicketStarter, type Started } from "./starter";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { ticketProcessLiveness, type ProcessAgent, type ProcessInspector } from "./process-liveness";
import { WATCHDOG_LABEL, type WatchdogHistory, type WatchdogRequest } from "./watchdog";

const OWNER = "owner-1";
const APP = "paseo-app";
const ISSUE = { id: "issue-1", identifier: "TUC-1" };
const BRANCH = "mtuchel/tuc-1-fix";

const exec = promisify(execFile);

const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false,
  lastProvider: "claude", launchPreferences: { claude: { model: "claude/opus", modeId: "default" } },
  projectMappings: { "project:lp-1": { projectId: "p1", label: "App", baseBranch: "refs/heads/dev" } },
  agentLinearAccess: false,
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["ENG"], maxRunning: 2 },
  writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, deputy: DEFAULT_DEPUTY,
};

// --- The daemon ---------------------------------------------------------------------------------

type FakeAgent = {
  id: string;
  title?: string | null;
  status?: string;
  cwd?: string;
  createdAt: string;
  labels?: Record<string, string>;
  pendingPermissions?: { id: string; kind: string }[];
  lastError?: string | null;
  archivedAt?: string | null;
  activeTurn?: { turnId: string; startedAt: string } | null;
} & Pick<ProcessAgent, "provider" | "runtimeInfo" | "persistence" | "updatedAt">;

type StartOptions = { labels?: Record<string, string>; retryHint: string; fresh?: boolean; resumeOnly?: boolean; lead?: string };

const ticketAgent = (id: string, createdAt: string, change: Partial<FakeAgent> = {}): FakeAgent => ({
  id, title: `${ISSUE.identifier}: Fix sign-in (${id})`, status: "idle", cwd: "/repo/wt", createdAt,
  labels: { "linear.issueId": ISSUE.id, "linear.identifier": ISSUE.identifier }, ...change,
});

// The daemon as the plugin reads it: the ticket's agents on pages, a workspace whose create adds
// one, and the two calls a queued thread uses (refresh + send).
function fakeDaemon(agents: FakeAgent[] = [], options: { pageSize?: number } = {}) {
  const listed = [...agents];
  const created: PaseoWorkspaceAgentCreateOptions[] = [];
  const sources: PaseoWorkspaceCreateOptions[] = [];
  const sent: string[] = [];
  const archived: string[] = [];
  const state = { pauseCreate: null as null | (() => Promise<void>), failSend: false };
  let counter = 0;
  const paseo = {
    agents: {
      list: async (input: { filter?: { labels?: Record<string, string>; includeArchived?: boolean }; page?: { limit?: number; cursor?: string | null } } = {}) => {
        const wanted = input.filter?.labels;
        const matching = listed.filter((agent) => (input.filter?.includeArchived || !agent.archivedAt)
          && (!wanted || Object.entries(wanted).every(([name, value]) => agent.labels?.[name] === value)));
        const size = Math.max(1, Math.min(input.page?.limit ?? matching.length, options.pageSize ?? matching.length));
        const start = input.page?.cursor ? Number(input.page.cursor) : 0;
        const entries = matching.slice(start, start + size).map((agent) => ({ agent }));
        const hasMore = start + size < matching.length;
        return { entries, pageInfo: { hasMore, nextCursor: hasMore ? String(start + size) : null } };
      },
      ref: (id: string) => ({
        refresh: async () => {
          const found = listed.find((agent) => agent.id === id);
          if (!found) throw new Error(`Agent not found: ${id}`);
          return { agent: found };
        },
        archive: async () => {
          archived.push(id);
          const found = listed.find((agent) => agent.id === id);
          if (found) found.archivedAt = "now";
          return { archivedAt: "now" };
        },
        send: async (text: string) => {
          if (state.failSend) throw new Error("The agent is unreachable.");
          sent.push(`${id}: ${text}`);
        },
        respondToPermission: async () => {},
      }),
    },
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectKind: "git", projectRootPath: "/repo", projectDisplayName: "repo" }] }) },
    workspaces: {
      create: async (input: PaseoWorkspaceCreateOptions) => {
        sources.push(input);
        if (state.pauseCreate) await state.pauseCreate();
        return {
          directory: "/repo/wt",
          agents: {
            create: async (create: PaseoWorkspaceAgentCreateOptions) => {
              created.push(create);
              const id = `agent-created-${++counter}`;
              listed.push({ id, title: create.title ?? id, status: "idle", cwd: "/repo/wt", createdAt: `2026-02-01T00:00:0${counter}Z`, labels: create.labels ?? {} });
              return { id, capabilities: { supportsMcpServers: true } };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  const add = (agent: FakeAgent) => listed.push(agent);
  return { paseo, state, listed, created, sources, sent, archived, add };
}

type Daemon = ReturnType<typeof fakeDaemon>;

// --- Linear -------------------------------------------------------------------------------------

const identifierOf = (id: string) => (id === ISSUE.id ? ISSUE.identifier : id.toUpperCase());

class FakeLinear {
  readonly writes: string[] = [];
  readonly labels = new Map<string, Set<string>>([["eng-1", new Set(["paseo"])]]);
  statusType = "unstarted";
  status = "Todo";

  async labeledIssues(label: string, _teamKeys: string[]): Promise<LabeledIssue[]> {
    this.writes.push(`query ${label}`);
    return [...this.labels].filter(([, names]) => [...names].some((name) => name.toLowerCase() === label.toLowerCase()))
      .map(([id, names]) => ({ id, identifier: id.toUpperCase(), teamKey: "ENG", priority: 0, labels: [...names].map((name) => ({ id: `l-${name}`, name })), openChildren: false }));
  }

  async addLabel(id: string, name: string) { this.labels.get(id)?.add(name); this.writes.push(`+${name} ${id}`); }
  async removeLabel(id: string, name: string) { this.labels.get(id)?.delete(name); this.writes.push(`-${name} ${id}`); }
  async comment(id: string, body: string) { this.writes.push(`comment ${id}: ${body}`); }
  async viewerId() { return OWNER; }
  async appUserId() { return APP; }
  async issueDocument() { return null; }
  async upsertComment() { return "comment-1"; }
  async moveToStateNamed() { return { changed: false }; }

  async issueState(id: string): Promise<IssueState> {
    return {
      id, identifier: identifierOf(id), projectId: "lp-1", creatorId: OWNER, blockedBy: [], status: this.status, statusId: "todo",
      statusType: this.statusType, teamId: "t1", labels: [...(this.labels.get(id) ?? [])].map((name) => ({ id: `l-${name}`, name })),
      attachmentUrls: [], priority: 0, createdAt: "2026-01-01T00:00:00Z", unblocks: 0,
    };
  }

  async issueStatus(_id: string) {
    return { status: this.status, statusType: this.statusType };
  }

  async detail(id: string): Promise<TicketDetail> {
    return {
      issue: { id, identifier: identifierOf(id), title: "Fix the sign-in flow", url: `https://linear.app/i/${id}`, branchName: BRANCH, project: "App", team: "Engineering", labels: [] },
      teamId: "t1", projectId: "lp-1", context: "{}", warnings: [], relations: { related: [] },
    } as unknown as TicketDetail;
  }
}

// --- The Launcher, without the daemon or Linear behind it --------------------------------------

function launcher(daemon: Daemon) {
  const prompts: string[] = [];
  const instance = new Launcher(
    { detail: async (id: string) => new FakeLinear().detail(id), markInProgress: async () => ({ changed: false }), finishedBlockers: async () => [] },
    async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }, { id: "refs/heads/main", label: "main" }], defaultBranch: "refs/heads/main" }),
    async () => "/ticket-mcp.mjs",
    undefined,
    async (_requestId: string, prompt: string) => { prompts.push(prompt); return "/plan-context.md"; },
    () => false,
    { save: async () => {} },
  );
  return { instance, prompts, daemon };
}

// --- The router, on its own (fake starter, real Launcher gate) ---------------------------------

function routerHarness(options: {
  agents?: FakeAgent[];
  pageSize?: number;
  resumeTarget?: ResumeTarget | null;
  handOff?: () => Promise<boolean> | never;
  admission?: { ok: true } | { ok: false; reason: string } | (() => Promise<{ ok: true } | { ok: false; reason: string }>);
  sessionStatus?: () => Promise<string | null>;
  route?: ConstructorParameters<typeof SessionRouter>[0]["route"];
  processLiveness?: typeof ticketProcessLiveness;
  failStart?: boolean;
  // Called inside the start, before the agent exists; the start goes on once it settles.
  pauseStart?: () => Promise<void>;
  openFails?: boolean;
  statusType?: string;
  gates?: Launcher;
  daemon?: Daemon;
  store?: SessionStore;
  processInspector?: ProcessInspector;
  // Called with the agent a Stop went to (the watchdog's interrupt and retirement).
  onStop?: (agentId: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  owner?: (issueId: string) => Promise<HostOwnership>;
} = {}) {
  const calls: string[] = [];
  const daemon = options.daemon ?? fakeDaemon(options.agents ?? [], { pageSize: options.pageSize });
  const directory = join(tmpdir(), `paseo-successor-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = options.store ?? new SessionStore(join(directory, "sessions.json"));
  const gates = options.gates ?? launcher(daemon).instance;
  const starts: { issueId: string; options: StartOptions }[] = [];
  const linear = new FakeLinear();
  linear.statusType = options.statusType ?? "unstarted";
  linear.addLabel = async (_id: string, name: string) => { calls.push(`+${name}`); };
  linear.removeLabel = async (_id: string, name: string) => { calls.push(`-${name}`); };
  const handover = {
    resumeTarget: async (): Promise<ResumeTarget | null> => ("resumeTarget" in options ? options.resumeTarget ?? null : { branch: BRANCH, worktreePath: null, handover: "Continue the work." }),
    handOff: async (_issue: { id: string; identifier: string }, predecessor: string, successor: { id: string }) => {
      calls.push(`handOff ${predecessor} -> ${successor.id}`);
      return options.handOff ? options.handOff() : true;
    },
  };
  const starter = {
    start: async (issueId: string, _paseo: PaseoApi, _settings: PluginSettings, startOptions: StartOptions): Promise<Started> => {
      calls.push("start");
      starts.push({ issueId, options: startOptions });
      if (options.pauseStart) await options.pauseStart();
      if (options.failStart) throw new Error("Paseo is not connected yet.");
      daemon.add(ticketAgent("agent-new", "2026-02-01T00:00:09Z"));
      return { agentId: "agent-new", warnings: [], provider: "claude/opus", target: "repo", resumed: true, untrusted: false, plan: null };
    },
    admission: async () => typeof options.admission === "function" ? options.admission() : options.admission ?? { ok: true as const },
  };
  const router = new SessionRouter({
    api: {
      activity: async (_session: string, content: { type: string; body?: string }) => { calls.push(`${content.type}:${(content.body ?? "").split("\n")[0]}`); },
      updateSession: async () => {},
      createSessionOnIssue: async () => { if (options.openFails) throw new Error("Linear is rate-limited"); return "s-new"; },
      openSessions: async () => [],
      activities: async () => [],
      sessionStatus: options.sessionStatus ?? (async () => "active"),
    } as never,
    linear: linear as never,
    starter: starter as never,
    handover: handover as never,
    launcher: { gate: (issueId: string) => gates.gate(issueId) },
    settings: { read: async () => settings },
    store,
    route: options.route,
    owner: options.owner,
    processLiveness: options.processLiveness,
    stop: async (agentId: string) => { calls.push(`stop ${agentId}`); options.onStop?.(agentId); },
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.processInspector ? { processLiveness: (paseo: PaseoApi, issueId: string, extra?: ProcessAgent[], _inspect?: ProcessInspector, mode?: { subagents?: boolean }) => ticketProcessLiveness(paseo, issueId, extra, options.processInspector, mode), processInspector: options.processInspector } : {}),
  });
  // Connected without attach(): the startup sweep would run alongside the test.
  Object.assign(router, { paseo: daemon.paseo });
  return { router, store, directory, calls, daemon, starts, gates, linear, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

// A gate acquired and released proves the ticket's gate is free again (AC-19).
function assertGateFree(gates: Launcher, issueId = ISSUE.id): void {
  const gate = gates.gate(issueId);
  assert.ok(gate, `the start gate of ${issueId} was never released`);
  gate.release();
}

const thread = (change: Partial<SessionLink> = {}): SessionLink => ({ sessionId: "s1", agentId: null, issueId: ISSUE.id, identifier: ISSUE.identifier, createdAt: "2026-01-01T00:00:00Z", handled: [], review: null, offer: null, ...change });

const succeed = (h: { router: SessionRouter; calls: string[] }, lead = "Fix the failing check.") =>
  h.router.succeed(ISSUE.id, ISSUE.identifier, "agent-gone", lead, async () => { h.calls.push("claim"); });

test("succession is impossible for a closed ticket and for one without a recorded branch", async () => {
  const closed = routerHarness({ statusType: "completed", resumeTarget: null });
  assert.deepEqual(await succeed(closed), { kind: "impossible", reason: "TUC-1 is Todo" });
  assert.deepEqual(closed.calls, [], "a closed ticket is not claimed");
  assertGateFree(closed.gates);
  await closed.cleanup();

  const noBranch = routerHarness({ resumeTarget: null });
  assert.deepEqual(await succeed(noBranch), { kind: "impossible", reason: "no branch is recorded for the ticket" });
  assert.deepEqual(noBranch.calls, []);
  assertGateFree(noBranch.gates);
  await noBranch.cleanup();
});

test("a live agent of the ticket takes the record over instead of a new start, branch or not", async (t) => {
  t.mock.method(console, "error", () => {});
  const live = routerHarness({
    resumeTarget: null,
    agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" }), ticketAgent("agent-live", "2026-01-02T00:00:00Z")],
  });
  const succession = await succeed(live);
  assert.deepEqual(succession, { kind: "live", agent: { id: "agent-live", title: "TUC-1: Fix sign-in (agent-live)", cwd: "/repo/wt" } });
  assert.deepEqual(live.calls, ["handOff agent-gone -> agent-live"], "nothing is claimed and nothing starts");
  assert.equal(live.starts.length, 0);
  assertGateFree(live.gates);
  await live.cleanup();

  // A failed hand-off is logged (the next poll retries it) and still reports the live agent.
  const failing = routerHarness({
    agents: [ticketAgent("agent-live", "2026-01-02T00:00:00Z")],
    handOff: async () => { throw new Error("Linear is rate-limited"); },
  });
  assert.equal((await succeed(failing)).kind, "live");
  assert.equal(failing.starts.length, 0);
  await failing.cleanup();
});

test("succession waits on admission without claiming the message or starting anything", async () => {
  const h = routerHarness({ admission: { ok: false, reason: "Queued: 1 of 1 ticket agents are working. It starts when one finishes." } });
  assert.deepEqual(await succeed(h), { kind: "wait", reason: "Queued: 1 of 1 ticket agents are working. It starts when one finishes." });
  assert.deepEqual(h.calls, [], "the message stays unclaimed");
  assert.equal(h.starts.length, 0);
  assertGateFree(h.gates);
  await h.cleanup();
});

test("a started successor claims the message before its resume-only start with the lead, and survives a failing panel line", async (t) => {
  t.mock.method(console, "error", () => {});
  // The successor's thread cannot be opened: the start still stands.
  const h = routerHarness({ agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })], openFails: true });

  const succession = await succeed(h, "The pull request's checks fail.");
  assert.deepEqual(succession, { kind: "started", agent: { id: "agent-new", title: "TUC-1: Fix sign-in (agent-new)", cwd: "/repo/wt" } });
  assert.deepEqual(h.calls.slice(0, 3), ["claim", "+paseo-running", "start"], "the message is claimed right before the start");
  assert.deepEqual(h.starts[0].options, { retryHint: "assign Paseo again", resumeOnly: true, lead: "The pull request's checks fail." });
  assert.deepEqual(h.daemon.archived, ["agent-gone"], "the gone agent is archived once the successor runs");
  assertGateFree(h.gates);
  await h.cleanup();

  // The hand-off after the start fails too: the successor is still the outcome.
  const failing = routerHarness({
    agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })],
    handOff: async () => { throw new Error("Linear is down"); },
  });
  assert.equal((await succeed(failing)).kind, "started");
  await failing.cleanup();
});

test("a start that throws leaves the ticket unclaimed by a successor and says impossible", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = routerHarness({ failStart: true, agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })] });
  const succession = await succeed(h);
  assert.deepEqual(succession, { kind: "impossible", reason: "Paseo is not connected yet." });
  assert.equal(h.calls[0], "claim", "the message was claimed before the start, as the caller expects");
  assert.ok(h.calls.includes("+paseo-running") && h.calls.includes("-paseo-running"), "the running label is taken back");
  assertGateFree(h.gates);
  await h.cleanup();
});

// --- TicketStarter: resume-only never falls back to a fresh agent ------------------------------

function starterHarness(options: { resumeTarget?: ResumeTarget | null; projectKind?: string; resumeFails?: boolean; projectRootPath?: string; branchName?: string } = {}) {
  const launches: { resume?: ResumeTarget }[] = [];
  const branchName = options.branchName ?? "dev";
  const branches = { branches: [{ id: `refs/heads/${branchName}`, label: branchName }], defaultBranch: `refs/heads/${branchName}` };
  const starter = new TicketStarter({
    linear: new FakeLinear() as never,
    handover: { resumeTarget: async () => options.resumeTarget ?? null } as never,
    launcher: { start: async (_input: unknown, _paseo: unknown, launchOptions: { resume?: ResumeTarget }) => {
      launches.push({ resume: launchOptions.resume });
      if (options.resumeFails && launchOptions.resume) throw new Error("Could not reopen branch");
      return { agentId: "agent-new", warnings: [] };
    } } as never,
    branches: async () => branches,
  });
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectKind: options.projectKind ?? "git", projectRootPath: options.projectRootPath ?? "/repo", projectDisplayName: "repo" }] }) },
  } as unknown as PaseoApi;
  return { starter, paseo, launches };
}

test("a resume-only start refuses a missing target, a non-git project and a failed resume instead of starting fresh", async () => {
  const missing = starterHarness();
  await assert.rejects(missing.starter.start(ISSUE.id, missing.paseo, settings, { retryHint: "assign Paseo again", resumeOnly: true, lead: "x" }), (error: unknown) => error instanceof ResumeUnavailableError && /has no recorded branch to continue on/.test(error.message));
  assert.deepEqual(missing.launches, [], "no fresh agent on a new branch");

  const noGit = starterHarness({ resumeTarget: { branch: BRANCH, worktreePath: null, handover: "Continue." }, projectKind: "directory" });
  await assert.rejects(noGit.starter.start(ISSUE.id, noGit.paseo, settings, { retryHint: "assign Paseo again", resumeOnly: true, lead: "x" }), (error: unknown) => error instanceof ResumeUnavailableError && /is not a Git project/.test(error.message));
  assert.deepEqual(noGit.launches, []);

  const failed = starterHarness({ resumeTarget: { branch: BRANCH, worktreePath: null, handover: "Continue." }, resumeFails: true });
  await assert.rejects(failed.starter.start(ISSUE.id, failed.paseo, settings, { retryHint: "assign Paseo again", resumeOnly: true, lead: "x" }), (error: unknown) => error instanceof ResumeUnavailableError && new RegExp(`Could not continue TUC-1 on ${BRANCH}`).test(error.message));
  assert.equal(failed.launches.length, 1, "the resume was tried once and not replaced by a fresh start");
  assert.ok(failed.launches[0].resume, "and it was a resume, not a branch-off");

  // Without resumeOnly a failed resume still falls back to a fresh start.
  const fallback = starterHarness({ resumeTarget: { branch: BRANCH, worktreePath: null, handover: "Continue." }, resumeFails: true });
  const started = await fallback.starter.start(ISSUE.id, fallback.paseo, settings, { retryHint: "assign Paseo again" });
  assert.equal(started.resumed, false);
  assert.equal(fallback.launches.length, 2);
  assert.equal(fallback.launches[1].resume, undefined, "the fallback branches off instead");
});

// The resume an activation forwards is continued exactly (starter.ts importedResume): this host
// resumes the recorded branch only while it is here at the recorded commit. Dirty work, a commit
// the branch is not at and a branch that is not here hold the activation; none falls back to a
// fresh start.
test("an imported resume continues only the exact recorded commit; dirty work, a wrong SHA and a missing branch hold", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "paseo-imported-resume-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args], { maxBuffer: 1_000_000 })).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(repo, "work.txt"), "the fix\n");
  await git("add", "work.txt");
  await git("commit", "--quiet", "-m", "fix");
  await git("checkout", "--quiet", "-b", BRANCH);
  const head = await git("rev-parse", "HEAD");
  const start = { retryHint: "assign Paseo again", resumeOnly: true, lead: "Continue." };
  const resume: ActivationResume = { branch: BRANCH, commit: head, dirty: false, handover: "Continue the recorded work." };

  const h = starterHarness({ branchName: BRANCH, projectRootPath: repo });
  const started = await h.starter.start(ISSUE.id, h.paseo, settings, { ...start, resume });
  assert.equal(started.resumed, true);
  assert.deepEqual(h.launches, [{ resume: { branch: BRANCH, worktreePath: null, handover: "Continue the recorded work." } }], "the recorded branch is continued, never a fresh one");

  const dirty = starterHarness({ branchName: BRANCH, projectRootPath: repo });
  await assert.rejects(dirty.starter.start(ISSUE.id, dirty.paseo, settings, { ...start, resume: { ...resume, dirty: true } }), (error: unknown) => error instanceof ResumeUnavailableError && /uncommitted changes/.test(error.message));
  assert.deepEqual(dirty.launches, [], "dirty work is never continued as if it had been pushed");

  const wrongSha = starterHarness({ branchName: BRANCH, projectRootPath: repo });
  await assert.rejects(wrongSha.starter.start(ISSUE.id, wrongSha.paseo, settings, { ...start, resume: { ...resume, commit: "0".repeat(40) } }), (error: unknown) => error instanceof ResumeUnavailableError && /the work was not transferred/.test(error.message));
  assert.deepEqual(wrongSha.launches, [], "a branch at another commit is not the recorded work");

  const absent = starterHarness({ branchName: "dev", projectRootPath: repo });
  await assert.rejects(absent.starter.start(ISSUE.id, absent.paseo, settings, { ...start, resume }), (error: unknown) => error instanceof ResumeUnavailableError && /is not on this host/.test(error.message));
  assert.deepEqual(absent.launches, []);

  const branchless = starterHarness({ branchName: BRANCH, projectRootPath: repo });
  await assert.rejects(branchless.starter.start(ISSUE.id, branchless.paseo, settings, { ...start, resume: { branch: null, handover: null } }), (error: unknown) => error instanceof ResumeUnavailableError && /has no recorded branch/.test(error.message));
  assert.deepEqual(branchless.launches, [], "a resume that points nowhere is held, never a fresh start");
});

// --- Composed: real Launcher + real TicketStarter + real SessionRouter -------------------------

test("the claimed instruction is the last part of the created agent's first prompt, on the recorded worktree", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "paseo-successor-worktree-"));
  const directory = await mkdtemp(join(tmpdir(), "paseo-successor-handover-"));
  try {
    const daemon = fakeDaemon([ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })], { pageSize: 5 });
    const linear = new FakeLinear();
    const gates = launcher(daemon).instance;
    const handover = new Handover(linear as never, directory, async () => ({ branch: BRANCH, lastCommit: "abc123 push the fix" }), () => "2026-01-01T10:00:00Z");
    await handover.update(ISSUE, { id: "agent-gone", title: "TUC-1: Fix sign-in", cwd: worktree }, { summary: "Rebased on main." });
    const starter = new TicketStarter({
      linear: linear as never,
      launcher: gates,
      handover,
      branches: async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }], defaultBranch: "refs/heads/dev" }),
    } as never);

    const calls: string[] = [];
    const router = new SessionRouter({
      api: { activity: async () => {}, updateSession: async () => {}, createSessionOnIssue: async () => "s-new", openSessions: async () => [], activities: async () => [], sessionStatus: async () => "active" } as never,
      linear: linear as never,
      starter: starter as never,
      handover,
      launcher: { gate: (issueId: string) => gates.gate(issueId) },
      settings: { read: async () => settings },
      store: new SessionStore(join(directory, "sessions.json")),
    });
    Object.assign(router, { paseo: daemon.paseo });

    const succession: Succession = await router.succeed(ISSUE.id, ISSUE.identifier, "agent-gone", "The pull request's checks fail now.", async () => { calls.push("claim"); });
    assert.equal(succession.kind, "started");
    assert.deepEqual(calls, ["claim"]);
    assert.equal(daemon.created.length, 1);
    const created = daemon.created[0];
    assert.ok(created.prompt?.endsWith(`${LEAD_INTRO}\n\nThe pull request's checks fail now.`), `lead is the last part of the prompt:\n${created.prompt?.slice(-200)}`);
    assert.match(created.prompt ?? "", /continuing work on Linear ticket TUC-1/);
    assert.equal(created.env?.LINEAR_TICKETS_ISSUE, ISSUE.identifier);
    assert.deepEqual(daemon.sources[0].source, { kind: "directory", projectId: "p1", path: worktree }, "the recorded worktree is reopened, not a new one");
    assert.equal((await handover.read(ISSUE.id))?.agentId, "agent-created-1", "the record moved to the created agent");
    assert.deepEqual((await handover.read(ISSUE.id))?.status, "working");
    assertGateFree(gates);
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real admission refusal leaves the instruction unclaimed", async (t) => {
  t.mock.method(console, "error", () => {});
  const daemon = fakeDaemon([ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" }), ticketAgent("agent-busy", "2026-01-02T00:00:00Z", { status: "running", labels: { "linear.issueId": "issue-2", "linear.identifier": "TUC-2" } })]);
  const linear = new FakeLinear();
  const gates = new Launcher(linear as never);
  const starter = new TicketStarter({
    linear: linear as never,
    launcher: gates,
    branches: async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }], defaultBranch: "refs/heads/dev" }),
  } as never);
  const calls: string[] = [];
  const router = new SessionRouter({
    api: { activity: async () => {}, updateSession: async () => {}, createSessionOnIssue: async () => "s-new", openSessions: async () => [], activities: async () => [], sessionStatus: async () => "active" } as never,
    linear: linear as never,
    starter: starter as never,
    handover: { resumeTarget: async () => ({ branch: BRANCH, worktreePath: null, handover: "Continue." }), handOff: async () => true } as never,
    launcher: { gate: (issueId: string) => gates.gate(issueId) },
    settings: { read: async () => ({ ...settings, dispatch: { ...settings.dispatch, maxRunning: 1 } }) },
    store: new SessionStore(join(tmpdir(), `paseo-successor-${process.pid}-${Math.random().toString(36).slice(2)}`, "sessions.json")),
  });
  Object.assign(router, { paseo: daemon.paseo });

  const succession = await router.succeed(ISSUE.id, ISSUE.identifier, "agent-gone", "Fix the check.", async () => { calls.push("claim"); });
  assert.equal(succession.kind, "wait");
  assert.match((succession as { reason: string }).reason, /Queued: 1 of 1 ticket agents are working/);
  assert.deepEqual(calls, [], "nothing is claimed while the ticket waits for a slot");
  assert.equal(daemon.created.length, 0);
  assertGateFree(gates);
});

// --- AC-13: a sidebar launch in flight ----------------------------------------------------------

test("a sidebar launch in flight makes the watch wait; the agent it creates is taken as the live successor", async () => {
  const daemon = fakeDaemon();
  const { instance, prompts } = launcher(daemon);
  const h = routerHarness({ gates: instance, daemon });
  let release = () => {};
  const paused = new Promise<void>((resolve) => { release = resolve; });
  daemon.state.pauseCreate = () => paused;

  const sidebar = instance.start({ id: ISSUE.id, projectId: "p1", baseBranch: "refs/heads/dev", provider: "claude/opus", modeId: "default", instructions: "Fix it.", markInProgress: false, requestId: "3bca04b9-12a5-4764-8b11-98ad10c15c95" }, daemon.paseo);
  const waited = await succeed(h);
  assert.deepEqual(waited, { kind: "wait", reason: "a launch for this ticket is under way" });
  assert.deepEqual(h.calls, [], "the sidebar's agent is not duplicated");
  assert.equal(daemon.created.length, 0, "the sidebar's launch has not created anything yet");

  release();
  assert.equal((await sidebar).agentId, "agent-created-1");
  assert.equal(prompts.length, 1);

  const live = await succeed(h);
  assert.deepEqual(live, { kind: "live", agent: { id: "agent-created-1", title: "TUC-1: Fix the sign-in flow", cwd: "/repo/wt" } });
  assert.equal(daemon.created.length, 1, "exactly one agent for the ticket");
  assert.deepEqual(h.calls, ["handOff agent-gone -> agent-created-1"]);
  assertGateFree(instance);
  await h.cleanup();
});

// --- AC-15: label dispatch behind the ticket's gate --------------------------------------------

test("a held gate keeps a labelled ticket's trigger label and reports no failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const daemon = fakeDaemon([ticketAgent("agent-live", "2026-01-02T00:00:00Z", { labels: { "linear.issueId": "eng-1", "linear.identifier": "ENG-1" } })]);
  const linear = new FakeLinear();
  const gates = new Launcher(linear as never);
  const starter = new TicketStarter({ linear: linear as never, launcher: gates, branches: async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }], defaultBranch: "refs/heads/dev" }) } as never);
  const dispatcher = new Dispatcher({ linear: linear as never, starter: starter as never, launcher: gates, settings: { read: async () => settings } });
  dispatcher.attach(daemon.paseo);

  const gate = gates.gate("eng-1");
  assert.ok(gate);
  await dispatcher.tick();
  assert.equal(daemon.created.length, 0, "nothing starts while another path holds the gate");
  assert.deepEqual([...(linear.labels.get("eng-1") ?? [])], ["paseo"], "the trigger label stays for the next poll");
  assert.ok(!linear.writes.some((write) => write.includes("paseo-failed")), "no failed label");
  assert.ok(!linear.writes.some((write) => write.includes("could not start an agent")), "no failure comment");
  assert.deepEqual(dispatcher.snapshot().recent, []);

  gate.release();
  await dispatcher.tick();
  assert.equal(daemon.created.length, 0);
  assert.deepEqual([...(linear.labels.get("eng-1") ?? [])], ["paseo-running"]);
  assert.equal(dispatcher.snapshot().recent[0].outcome, "linked");
  assert.ok(linear.writes.some((write) => write.includes("Paseo already has an active agent for this ticket")));
  dispatcher.stop();
});

test("a dispatch paused inside the start holds the ticket's gate: the watch waits, then finds the dispatched agent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const daemon = fakeDaemon();
  const linear = new FakeLinear();
  const gates = launcher(daemon).instance;
  const starter = new TicketStarter({ linear: linear as never, launcher: gates, branches: async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }], defaultBranch: "refs/heads/dev" }) } as never);
  const dispatcher = new Dispatcher({ linear: linear as never, starter: starter as never, launcher: gates, settings: { read: async () => settings } });
  let release = () => {};
  const paused = new Promise<void>((resolve) => { release = resolve; });
  daemon.state.pauseCreate = () => paused;

  const calls: string[] = [];
  const claim = async () => { calls.push("claim"); };
  const router = new SessionRouter({
    api: { activity: async () => {}, updateSession: async () => {}, createSessionOnIssue: async () => "s-new", openSessions: async () => [], activities: async () => [], sessionStatus: async () => "active" } as never,
    linear: linear as never,
    starter: starter as never,
    handover: { resumeTarget: async () => ({ branch: BRANCH, worktreePath: null, handover: "Continue." }), handOff: async () => true } as never,
    launcher: { gate: (issueId: string) => gates.gate(issueId) },
    settings: { read: async () => settings },
    store: new SessionStore(join(tmpdir(), `paseo-successor-${process.pid}-${Math.random().toString(36).slice(2)}`, "sessions.json")),
  });
  Object.assign(router, { paseo: daemon.paseo });

  dispatcher.attach(daemon.paseo);
  const tick = dispatcher.tick();
  const waited = await router.succeed("eng-1", "ENG-1", "agent-gone", "Fix the check.", claim);
  assert.deepEqual(waited, { kind: "wait", reason: "a launch for this ticket is under way" });
  assert.deepEqual(calls, []);

  release();
  await tick;
  assert.deepEqual(dispatcher.snapshot().recent.map((entry) => entry.outcome), ["launched"]);
  assert.equal(daemon.created.length, 1, "the dispatch's agent is the ticket's only one");
  const live = await router.succeed("eng-1", "ENG-1", "agent-gone", "Fix the check.", claim);
  assert.equal(live.kind, "live");
  assert.deepEqual(calls, [], "the dispatched agent takes the message from the next poll");
  assert.equal(daemon.created.length, 1);
  dispatcher.stop();
});

// --- AC-16: restarting a stalled ticket (SessionRouter.restartFor) ---------------------------------

test("restartFor refuses while the gate is held and starts nothing behind a live successor", async () => {
  const held = routerHarness();
  const gate = held.gates.gate(ISSUE.id);
  assert.ok(gate);
  assert.deepEqual(await held.router.restartFor(ISSUE.id, ISSUE.identifier), { kind: "deferred", reason: "A launch for this ticket is under way." });
  gate.release();
  assertGateFree(held.gates);
  await held.cleanup();

  const live = routerHarness({ agents: [ticketAgent("agent-live", "2026-01-02T00:00:00Z")] });
  assert.deepEqual(await live.router.restartFor(ISSUE.id, ISSUE.identifier), { kind: "live" });
  assert.equal(live.starts.length, 0, "a live successor is no ticket to restart");
  assert.deepEqual(live.calls, []);
  assertGateFree(live.gates);
  await live.cleanup();

  const stopped = routerHarness({
    agents: [
      ticketAgent("agent-closed", "2026-01-01T00:00:00Z", { status: "closed" }),
      ticketAgent("agent-error", "2026-01-02T00:00:00Z", { status: "error", lastError: "OMP RPC process is closed" }),
    ],
  });
  assert.equal((await stopped.router.restartFor(ISSUE.id, ISSUE.identifier)).kind, "started");
  assert.equal(stopped.starts.length, 1, "closed and crashed agents are no live successor");
  assert.equal(stopped.starts[0].options.retryHint, "the project's next read starts it again");
  assertGateFree(stopped.gates);
  await stopped.cleanup();
});

// --- AC-17: auto-resume after a failure ---------------------------------------------------------

test("auto-resume behind a live successor starts nothing; behind a held gate it waits without using up the hour", async () => {
  const h = routerHarness({ agents: [ticketAgent("agent-old", "2026-01-01T00:00:00Z", { status: "closed" }), ticketAgent("agent-live", "2026-01-02T00:00:00Z")] });
  await h.store.put(thread({ agentId: "agent-old" }));
  assert.equal(await h.router.resumeNow("s1"), true, "a live successor owns the ticket");
  assert.equal(h.starts.length, 0);
  assert.deepEqual(h.calls, []);
  await h.cleanup();

  const gated = routerHarness();
  await gated.store.put(thread({ agentId: "agent-old" }));
  const gate = gated.gates.gate(ISSUE.id);
  assert.ok(gate);
  assert.equal(await gated.router.resumeNow("s1"), false, "another start is under way");
  assert.equal(gated.starts.length, 0);
  gate.release();
  assert.equal(await gated.router.resumeNow("s1"), true, "the hour was not used up, so the resume still starts");
  assert.equal(gated.starts.length, 1);
  assert.equal(gated.starts[0].options.fresh, false);
  assertGateFree(gated.gates);
  await gated.cleanup();
});

// --- AC-18: a thread that arrives during a launch -----------------------------------------------

test("a thread that arrives during a launch waits with its comment and is linked to the successor once", async () => {
  const h = routerHarness({ agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })] });
  const gate = h.gates.gate(ISSUE.id);
  assert.ok(gate);
  await h.router.created({ id: "s1", creatorId: OWNER, issueId: ISSUE.id, issue: { identifier: ISSUE.identifier }, comment: { body: "@paseo rebase it please" } });
  const queued = await h.store.get("s1");
  assert.deepEqual({ queued: queued?.queued, pendingText: queued?.pendingText, agentId: queued?.agentId }, { queued: true, pendingText: "rebase it please", agentId: null });
  assert.match(h.calls.at(-1) ?? "", /^thought:A launch for this ticket is under way/);
  assert.equal(h.daemon.sent.length, 0);

  gate.release();
  // The successor start that held the gate archived the gone agent once its successor ran.
  h.daemon.listed[0].archivedAt = "now";
  h.daemon.add(ticketAgent("agent-new", "2026-02-01T00:00:00Z"));
  await h.router.startQueued();
  const linked = await h.store.get("s1");
  assert.deepEqual({ queued: linked?.queued, pendingText: linked?.pendingText, agentId: linked?.agentId }, { queued: false, pendingText: null, agentId: "agent-new" });
  assert.deepEqual(h.daemon.sent, ["agent-new: rebase it please"], "the successor got the comment");
  assertGateFree(h.gates);
  await h.cleanup();
});

test("a thread opened while a successor starts keeps its comment through the successor's new thread and passes it on once", async (t) => {
  t.mock.method(console, "log", () => {});
  // Executor form: the plugin's TypeScript lib predates Promise.withResolvers.
  let reachedStart = () => {};
  const reached = new Promise<void>((resolve) => { reachedStart = resolve; });
  let resume = () => {};
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const h = routerHarness({
    agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })],
    pauseStart: () => { reachedStart(); return paused; },
  });
  const starting = succeed(h);
  await reached;

  await h.router.created({ id: "s-owner", creatorId: OWNER, issueId: ISSUE.id, issue: { identifier: ISSUE.identifier }, comment: { body: "@paseo rebase it please" } });
  // The owner's thread is older than the one the successor start opens next.
  await h.store.patch("s-owner", { createdAt: "2026-01-01T00:00:00Z" });
  resume();
  assert.equal((await starting).kind, "started");
  const waiting = await h.store.get("s-owner");
  assert.deepEqual({ queued: waiting?.queued, closed: Boolean(waiting?.closed), pendingText: waiting?.pendingText }, { queued: true, closed: false, pendingText: "rebase it please" }, "the successor's thread does not supersede an undelivered comment");

  await h.router.startQueued();
  await h.router.startQueued();
  assert.deepEqual(h.daemon.sent, ["agent-new: rebase it please"], "the successor got the comment, once");
  assert.equal((await h.store.get("s-owner"))?.agentId, "agent-new");
  assertGateFree(h.gates);
  await h.cleanup();
});

test("a successor that cannot be read after its start keeps the predecessor's record for a later hand-off", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = routerHarness({ agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })] });
  const agents = h.daemon.paseo.agents;
  const ref = agents.ref.bind(agents);
  agents.ref = ((id: string) => (id === "agent-new" ? { ...ref(id), refresh: async () => { throw new Error("daemon went away"); } } : ref(id))) as typeof agents.ref;

  assert.deepEqual(await succeed(h), { kind: "started", agent: { id: "agent-new", title: null, cwd: "" } });
  assert.ok(!h.calls.some((call) => call.startsWith("handOff")), "no hand-off with an unknown worktree");
  // The next succession finds the successor live and hands the record over with its worktree.
  agents.ref = ref;
  assert.equal((await succeed(h)).kind, "live");
  assert.deepEqual(h.calls.filter((call) => call.startsWith("handOff")), ["handOff agent-gone -> agent-new"]);
  await h.cleanup();
});

test("a comment whose delivery could not be confirmed is reported and never sent again", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = routerHarness();
  await h.store.put(thread({ queued: true, pendingText: "rebase it please" }));
  h.daemon.add(ticketAgent("agent-new", "2026-02-01T00:00:00Z"));
  h.daemon.state.failSend = true;

  // The first sweep attempts the send; the sweeps after it only replay the record it left behind.
  await h.router.startQueued();
  await h.router.startQueued();
  assert.deepEqual(h.daemon.sent, [], "the failed message never went out");
  assert.ok(h.calls.some((call) => /^error:Paseo could not confirm that your answer reached the agent:/.test(call)), "the owner is told it did not go out");
  const waiting = await h.store.get("s1");
  assert.deepEqual({ queued: waiting?.queued, pendingText: waiting?.pendingText, agentId: waiting?.agentId }, { queued: true, pendingText: "rebase it please", agentId: null }, "the unconfirmed text stays queued, never to be sent");
  assertGateFree(h.gates);

  // The daemon taking sends again changes nothing: an interrupted submission is never sent twice.
  h.daemon.state.failSend = false;
  await h.router.startQueued();
  assert.deepEqual(h.daemon.sent, [], "never sent again");
  await h.cleanup();
});

test("a stale queue reconnects its retired exact-session owner without restarting or changing the owner's decision", async (t) => {
  const offers: SessionLink["offer"][] = [null, "resume", "later", "parked", "split"];
  for (const [index, offer] of offers.entries()) {
    await t.test(offer ?? "no decision", async (t) => {
      const retired = ticketAgent("agent-retired", "2026-01-02T00:00:00Z", {
        labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" },
        ...(index % 2 ? { status: "closed" } : { archivedAt: "2026-01-03T00:00:00Z" }),
      });
      const h = routerHarness({ agents: [retired], admission: { ok: false, reason: "Waiting for TUC-9 to finish." } });
      t.after(h.cleanup);
      await h.store.put(thread({ queued: true, queueReason: "Waiting for TUC-9 to finish.", offer }));
      await h.router.startQueued();
      await h.router.startQueued();
      const settled = await h.store.get("s1");
      assert.equal(settled?.agentId, retired.id);
      assert.equal(settled?.queued, false);
      assert.equal(settled?.queueReason, undefined);
      assert.equal(settled?.offer, offer);
      assert.equal(Boolean(settled?.closed), false, "a stopped run is not a completed Linear thread");
      assert.deepEqual(h.starts, []);
      assert.deepEqual(h.daemon.sent, []);
      assertGateFree(h.gates);
    });
  }
});

test("a retired exact-session owner keeps its undelivered message for an explicit resume, never for the dead agent", async (t) => {
  const retired = ticketAgent("agent-retired", "2026-01-02T00:00:00Z", {
    status: "error", lastError: "OMP RPC process is closed",
    labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" },
  });
  const h = routerHarness({ agents: [retired], processLiveness: async () => "absent" });
  t.after(h.cleanup);
  await h.store.put(thread({ queued: true, pendingText: "Keep the existing branch.", offer: "resume" }));
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.pendingText, "Keep the existing branch.");
  assert.equal((await h.store.get("s1"))?.queued, true);
  assert.equal((await h.store.get("s1"))?.agentId, null);
  assert.equal((await h.store.get("s1"))?.offer, "resume");
  assert.deepEqual(h.daemon.sent, []);
  assert.deepEqual(h.starts, []);

  await h.router.prompted("s1", { id: "resume-message", userId: OWNER, body: "resume" });
  assert.equal((await h.store.get("s1"))?.agentId, "agent-new");
  assert.equal((await h.store.get("s1"))?.pendingText, null);
  assert.deepEqual(h.daemon.sent, [], "the saved text belongs in the successor's first prompt");
});

test("a live exact-session owner links once and receives its queued message even when admission is full", async (t) => {
  const agent = ticketAgent("agent-owner", "2026-01-02T00:00:00Z", { labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" } });
  const h = routerHarness({ agents: [agent], admission: { ok: false, reason: "Queued: 2 of 2 slots used." } });
  t.after(h.cleanup);
  await h.store.put(thread({ queued: true, pendingText: "Use the smaller change.", queueReason: "Queued: 2 of 2 slots used.", offer: "resume" }));
  await h.router.startQueued();
  await h.router.startQueued();
  const settled = await h.store.get("s1");
  assert.equal(settled?.agentId, agent.id);
  assert.equal(settled?.queued, false);
  assert.equal(settled?.pendingText, null);
  assert.equal(settled?.queueReason, undefined);
  assert.equal(settled?.offer, null, "the current owner replaces a stale resume offer");
  assert.deepEqual(h.daemon.sent, ["agent-owner: Use the smaller change."]);
  assert.deepEqual(h.starts, []);
});

test("the current ticket owner takes precedence over retired exact-session history, across agent pages", async (t) => {
  const h = routerHarness({
    agents: [
      ticketAgent("retired", "2026-01-02T00:00:00Z", { archivedAt: "now", labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" } }),
      ticketAgent("older-live", "2026-01-03T00:00:00Z"),
      ticketAgent("current", "2026-01-04T00:00:00Z"),
    ],
    pageSize: 1,
    admission: { ok: false, reason: "Waiting for TUC-9 to finish." },
  });
  t.after(h.cleanup);
  await h.store.put(thread({ queued: true, pendingText: "Keep the fix minimal." }));
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.agentId, "current");
  assert.deepEqual(h.daemon.sent, ["current: Keep the fix minimal."]);
  assert.deepEqual(h.starts, []);
});

test("unrelated same-ticket session history and exact-session subagents cannot settle a new queued root", async (t) => {
  const h = routerHarness({
    agents: [
      ticketAgent("old-root", "2025-12-01T00:00:00Z", { archivedAt: "now", labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "older-session" } }),
      ticketAgent("advisor", "2026-01-02T00:00:00Z", { labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1", "paseo.parent-agent-id": "old-root" } }),
    ],
  });
  t.after(h.cleanup);
  await h.store.put(thread({ queued: true, pendingText: "Start with the failing case." }));
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.agentId, "agent-new");
  assert.equal(h.starts.length, 1);
  assert.deepEqual(h.daemon.sent, []);
});

test("ended, errored and vanished Linear threads settle before capacity, routing or orphan-process waits", async (t) => {
  for (const status of ["complete", "error", null]) {
    await t.test(status ?? "gone", async (t) => {
      const h = routerHarness({
        sessionStatus: async () => status,
        admission: { ok: false, reason: "Queued: 2 of 2 slots used." },
        processLiveness: async () => "alive",
        route: { take: async () => ({ held: "The peer still owns this ticket." }) },
      });
      t.after(h.cleanup);
      await h.store.put(thread({ queued: true, queueReason: "Queued: 2 of 2 slots used.", pendingText: "Undelivered owner instruction." }));
      await h.router.startQueued();
      const settled = await h.store.get("s1");
      assert.equal(settled?.queued, false);
      assert.equal(settled?.queueReason, undefined);
      assert.equal(Boolean(settled?.closed), status === "complete");
      assert.equal(settled?.pendingText, "Undelivered owner instruction.");
      assert.deepEqual(h.starts, []);
      assert.deepEqual(h.daemon.sent, []);
      assertGateFree(h.gates);
    });
  }
});

test("a failed Linear status read keeps the queue and owner text, without inferring a historical outcome", async (t) => {
  let readable = false;
  const h = routerHarness({
    agents: [ticketAgent("retired", "2026-01-02T00:00:00Z", { archivedAt: "now", labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" } })],
    sessionStatus: async () => { if (!readable) throw new Error("Linear is rate-limited."); return "active"; },
  });
  t.after(h.cleanup);
  await h.store.put(thread({ queued: true, pendingText: "Keep my branch." }));
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.queued, true);
  assert.equal((await h.store.get("s1"))?.agentId, null);
  assert.equal((await h.store.get("s1"))?.pendingText, "Keep my branch.");
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.daemon.sent, []);
  assertGateFree(h.gates);

  readable = true;
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.queued, true, "the historical run cannot consume a legitimate owner message");
  assert.equal((await h.store.get("s1"))?.agentId, null);
  assert.equal((await h.store.get("s1"))?.pendingText, "Keep my branch.");
});

test("a real dependency wait retains its reason and message until admission permits the launch", async (t) => {
  let blocked = true;
  const reason = "Waiting for TUC-9 to finish.";
  const h = routerHarness({ admission: async () => blocked ? { ok: false, reason } : { ok: true } });
  t.after(h.cleanup);
  await h.store.put(thread({ queued: true, pendingText: "Build on the dependency's branch." }));
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.queueReason, reason);
  assert.equal((await h.store.get("s1"))?.pendingText, "Build on the dependency's branch.");
  assert.deepEqual(h.starts, []);
  assertGateFree(h.gates);

  blocked = false;
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.agentId, "agent-new");
  assert.equal((await h.store.get("s1"))?.queued, false);
  assert.equal((await h.store.get("s1"))?.queueReason, undefined);
  assert.equal((await h.store.get("s1"))?.pendingText, null);
  assert.equal(h.starts.length, 1);
});

test("routing and unknown process waits retain the actual blocker without sending the owner's pending text", async (t) => {
  for (const routing of [false, true]) {
    await t.test(routing ? "peer ownership" : "unknown orphan process", async (t) => {
      const h = routerHarness({
        processLiveness: async () => routing ? "absent" : "unknown",
        ...(routing ? { route: { take: async () => ({ held: "The peer still owns this ticket." }) } } : {}),
      });
      t.after(h.cleanup);
      await h.store.put(thread({ queued: true, pendingText: "Do not lose this instruction." }));
      await h.router.startQueued();
      assert.equal((await h.store.get("s1"))?.queueReason, routing ? "The peer still owns this ticket." : "the OMP workers for this ticket could not be inspected");
      assert.equal((await h.store.get("s1"))?.queued, true);
      assert.equal((await h.store.get("s1"))?.pendingText, "Do not lose this instruction.");
      assert.deepEqual(h.starts, []);
      assert.deepEqual(h.daemon.sent, []);
      assertGateFree(h.gates);
    });
  }
});

test("an explicitly decided parked plan still starts after reload despite its retired exact-session history", async (t) => {
  const retired = ticketAgent("planner", "2026-01-02T00:00:00Z", {
    archivedAt: "now", labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" },
  });
  const h = routerHarness({ agents: [retired] });
  t.after(h.cleanup);
  await h.store.put(thread({ agentId: "planner", offer: "parked" }));
  assert.equal(await h.router.requeue("planner", "The owner approved implementation."), true);
  const restored = routerHarness({ daemon: h.daemon, store: new SessionStore(join(h.directory, "sessions.json")) });
  t.after(restored.cleanup);
  await restored.router.startQueued();
  assert.equal(restored.starts.length, 1);
  assert.equal((await restored.store.get("s1"))?.agentId, "agent-new");
  assert.equal((await restored.store.get("s1"))?.queued, false);
  assert.equal((await restored.store.get("s1"))?.offer, null);
  assert.equal((await restored.store.get("s1"))?.restartRequested, undefined);
});

test("a queued owner message with only retired history remains deliverable when a current owner appears", async (t) => {
  const h = routerHarness({ agents: [
    ticketAgent("retired", "2026-01-02T00:00:00Z", { archivedAt: "now", labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" } }),
  ] });
  t.after(h.cleanup);
  await h.store.put(thread({ queued: true, pendingText: "Preserve the existing data." }));
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.queued, true);
  assert.equal((await h.store.get("s1"))?.agentId, null);
  assert.equal((await h.store.get("s1"))?.pendingText, "Preserve the existing data.");
  assert.deepEqual(h.daemon.sent, []);
  assert.deepEqual(h.starts, []);

  h.daemon.add(ticketAgent("current", "2026-01-03T00:00:00Z"));
  await h.router.startQueued();
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.agentId, "current");
  assert.equal((await h.store.get("s1"))?.pendingText, null);
  assert.equal((await h.store.get("s1"))?.queueReason, undefined);
  assert.deepEqual(h.daemon.sent, ["current: Preserve the existing data."]);
  assert.deepEqual(h.starts, []);
});

test("retirement after the agent directory read cannot send queued text to the now-closed owner", async (t) => {
  const owner = ticketAgent("owner", "2026-01-02T00:00:00Z", { labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" } });
  const h = routerHarness({ agents: [owner] });
  t.after(h.cleanup);
  const issueStatus = h.linear.issueStatus.bind(h.linear);
  h.linear.issueStatus = async (id) => { owner.status = "closed"; return issueStatus(id); };
  await h.store.put(thread({ queued: true, pendingText: "Keep this instruction queued." }));
  await h.router.startQueued();
  await h.router.startQueued();
  assert.equal((await h.store.get("s1"))?.queued, true);
  assert.equal((await h.store.get("s1"))?.agentId, null);
  assert.equal((await h.store.get("s1"))?.pendingText, "Keep this instruction queued.");
  assert.deepEqual(h.daemon.sent, []);
  assert.deepEqual(h.starts, []);
});

test("an explicitly resumed queued owner message reaches the real successor's first prompt on the recorded worktree", async (t) => {
  const worktree = await mkdtemp(join(tmpdir(), "paseo-queued-worktree-"));
  const directory = await mkdtemp(join(tmpdir(), "paseo-queued-handover-"));
  t.after(async () => {
    await rm(worktree, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const daemon = fakeDaemon([ticketAgent("retired", "2026-01-02T00:00:00Z", {
    status: "closed", labels: { "linear.issueId": ISSUE.id, "linear.sessionId": "s1" },
  })]);
  const linear = new FakeLinear();
  const gates = launcher(daemon).instance;
  const handover = new Handover(linear as never, directory, async () => ({ branch: BRANCH, lastCommit: "abc123" }), () => "2026-01-02T10:00:00Z");
  await handover.update(ISSUE, { id: "retired", title: "TUC-1", cwd: worktree }, { summary: "The branch already contains the first change." });
  const starter = new TicketStarter({
    linear: linear as never, launcher: gates, handover,
    branches: async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }], defaultBranch: "refs/heads/dev" }),
  } as never);
  const store = new SessionStore(join(directory, "sessions.json"));
  const router = new SessionRouter({
    api: { activity: async () => {}, updateSession: async () => {}, sessionStatus: async () => "active" } as never,
    linear: linear as never, starter, handover, launcher: gates, settings: { read: async () => settings }, store,
  });
  Object.assign(router, { paseo: daemon.paseo });
  await store.put(thread({ queued: true, pendingText: "Keep the current API compatible.", offer: "resume" }));
  await router.startQueued();
  assert.equal(daemon.created.length, 0, "history alone cannot restart the planner");
  assert.equal((await store.get("s1"))?.queued, true);

  await router.prompted("s1", { id: "owner-resume", userId: OWNER, body: "resume" });
  assert.equal(daemon.created.length, 1);
  assert.ok(daemon.created[0].prompt?.endsWith(`${LEAD_INTRO}\n\nKeep the current API compatible.`), "the owner's retained instruction is in the real launch prompt");
  assert.deepEqual(daemon.sources[0].source, { kind: "directory", projectId: "p1", path: worktree });
  assert.equal((await store.get("s1"))?.agentId, "agent-created-1");
  assert.equal((await store.get("s1"))?.pendingText, null);
  assertGateFree(gates);
});

// --- AC-19: the live-successor predicate and the gate's hygiene ---------------------------------

test("the live-successor predicate finds the newest live root agent behind subagents and beyond the first page", async () => {
  const h = routerHarness({
    pageSize: 2,
    agents: [
      ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" }),
      ticketAgent("sub-1", "2026-01-05T00:00:00Z", { labels: { "linear.issueId": ISSUE.id, "paseo.parent-agent-id": "agent-gone" } }),
      ticketAgent("agent-closed", "2026-01-02T00:00:00Z", { status: "closed" }),
      ticketAgent("agent-crashed", "2026-01-03T00:00:00Z", { status: "error", lastError: "OMP RPC process is closed" }),
      ticketAgent("agent-old", "2026-01-04T00:00:00Z"),
      ticketAgent("agent-new", "2026-01-06T00:00:00Z"),
    ],
  });
  assert.deepEqual(await h.router.liveSuccessorFor(ISSUE.id), { id: "agent-new", title: "TUC-1: Fix sign-in (agent-new)", cwd: "/repo/wt" });
  assert.deepEqual(await h.router.liveSuccessorFor(ISSUE.id, ["agent-gone"]), { id: "agent-new", title: "TUC-1: Fix sign-in (agent-new)", cwd: "/repo/wt" });
  assert.deepEqual(await h.router.liveSuccessorFor(ISSUE.id, ["agent-new"]), { id: "agent-old", title: "TUC-1: Fix sign-in (agent-old)", cwd: "/repo/wt" }, "an excluded id is skipped, not the whole ticket");
  assert.equal(await h.router.liveSuccessorFor(ISSUE.id, ["agent-new", "agent-old"]), null, "the subagent, the closed and the crashed agent are no successor");
  await h.cleanup();
});

test("every gated start path gives the ticket's gate back", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = routerHarness({ agents: [ticketAgent("agent-gone", "2026-01-01T00:00:00Z", { status: "closed" })] });
  await h.store.put(thread({ agentId: "agent-gone" }));

  assert.equal((await succeed(h)).kind, "started");
  assertGateFree(h.gates);
  assert.equal((await succeed(h)).kind, "live");
  assertGateFree(h.gates);
  await h.router.startQueued();
  assertGateFree(h.gates);
  assert.equal(await h.router.resumeNow("s1"), true);
  assertGateFree(h.gates);
  await h.router.restartFor(ISSUE.id, ISSUE.identifier);
  assertGateFree(h.gates);

  // A throwing start and a refused restart leave nothing held either.
  h.daemon.listed.length = 0;
  const failing = routerHarness({ failStart: true });
  assert.equal((await succeed(failing)).kind, "impossible");
  assertGateFree(failing.gates);
  await failing.cleanup();
  await h.cleanup();
});

// Closed/archive is a daemon lifecycle state, not proof that the writable owner exited.
const NATIVE_HANDLE = "/home/mirko/.omp/agent/sessions/worktree/2026-10-05T11-05-57-212Z_01a10bbd-e6dc-7761-93d1-081ca47d9501.jsonl";
const ompRoot = (id: string, change: Partial<FakeAgent> = {}) => ticketAgent(id, "2026-01-01T00:00:00Z", {
  provider: "omp", status: "closed",
  runtimeInfo: { provider: "omp", sessionId: "01a10bbd-e6dc-7761-93d1-081ca47d9501" },
  persistence: { provider: "omp", sessionId: "01a10bbd-e6dc-7761-93d1-081ca47d9501", nativeHandle: NATIVE_HANDLE },
  ...change,
});

function processInspection(output: string, cwd = "/repo/wt"): ProcessInspector {
  return { processes: async () => output, cwd: async () => cwd, canonicalPath: async (path) => path };
}

test("a closed or archived root with an exact live process prevents successor dispatch, send and launch", async () => {
  for (const change of [{}, { archivedAt: "now" }]) {
    const h = routerHarness({ agents: [ompRoot("agent-gone", change)], processInspector: processInspection(`2100185 omp --mode rpc-ui --session ${NATIVE_HANDLE}\n`) });
    try {
      assert.equal((await succeed(h)).kind, "wait");
      assert.deepEqual(h.calls, [], "the dispatch claim stays pending");
      assert.deepEqual(h.starts, []);
      assert.deepEqual(h.daemon.sent, []);
      assert.deepEqual(h.daemon.archived, []);
      assertGateFree(h.gates);
    } finally { await h.cleanup(); }
  }
});

test("an archived older root blocks a hand-off to a live successor, including across pages", async () => {
  const h = routerHarness({
    agents: [ticketAgent("agent-live", "2026-01-02T00:00:00Z"), ompRoot("older-root", { archivedAt: "now" })],
    pageSize: 1, processInspector: processInspection(`2100185 omp --mode rpc-ui --session ${NATIVE_HANDLE}\n`),
  });
  try {
    assert.equal((await succeed(h)).kind, "wait");
    assert.deepEqual(h.calls, [], "no hand-off can authorize another writable owner");
    assert.deepEqual(h.daemon.sent, []);
    assertGateFree(h.gates);
  } finally { await h.cleanup(); }
});

test("confirmed absence permits ordinary successor recovery with claim-before-start ordering", async () => {
  for (const output of ["", `2100185 omp --mode rpc-ui --session ${NATIVE_HANDLE}.different\n`]) {
    const h = routerHarness({ agents: [ompRoot("agent-gone")], processInspector: processInspection(output) });
    try {
      assert.equal((await succeed(h)).kind, "started");
      assert.deepEqual(h.calls.slice(0, 3), ["claim", "+paseo-running", "start"]);
      assert.equal(h.starts[0].options.resumeOnly, true);
      assertGateFree(h.gates);
    } finally { await h.cleanup(); }
  }
});

test("process inspection failure leaves successor dispatch pending", async () => {
  const inspect = processInspection("");
  inspect.processes = async () => { throw new Error("ps failed"); };
  const h = routerHarness({ agents: [ompRoot("agent-gone")], processInspector: inspect });
  try {
    assert.equal((await succeed(h)).kind, "wait");
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.starts, []);
    assertGateFree(h.gates);
  } finally { await h.cleanup(); }
});

test("native auto-resume and a ticket restart wait for terminal processes without consuming a retry", async () => {
  let output = "2100185 omp --mode rpc-ui\n";
  const inspect = processInspection("");
  inspect.processes = async () => output;
  const h = routerHarness({ agents: [ompRoot("agent-old", { archivedAt: "now" })], processInspector: inspect });
  try {
    await h.store.put(thread({ agentId: "agent-old" }));
    assert.equal(await h.router.resumeNow("s1"), false);
    const waited = await h.router.restartFor(ISSUE.id, ISSUE.identifier);
    assert.match(waited.kind === "deferred" ? waited.reason : waited.kind, /OMP worker.*still alive/);
    assert.deepEqual(h.starts, []);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.daemon.archived, []);
    assertGateFree(h.gates);
    output = "";
    assert.equal(await h.router.resumeNow("s1"), true, "a process wait did not use the hourly resume");
    assert.equal(h.starts.length, 1);
    assertGateFree(h.gates);
  } finally { await h.cleanup(); }
});

test("a ticket restart replaces a root agent that shows running without a process, and keeps one whose process works", async () => {
  let output = `2100185 omp --mode rpc-ui --session ${NATIVE_HANDLE}\n`;
  const inspect = processInspection("", "/repo/other");
  inspect.processes = async () => output;
  // As a ticket's root agent stood after the 2026-10-05 daemon crash: running, last updated at the crash.
  const h = routerHarness({ agents: [ompRoot("agent-ghost", { status: "running", updatedAt: "2026-01-01T00:09:44Z" })], processInspector: inspect });
  try {
    await h.router.restartFor(ISSUE.id, ISSUE.identifier);
    assert.deepEqual(h.starts, [], "its process works: a long turn, no restart");
    output = "";
    await h.router.restartFor(ISSUE.id, ISSUE.identifier);
    assert.equal(h.starts.length, 1, "the ghost is no live successor");
    assertGateFree(h.gates);
  } finally { await h.cleanup(); }
});


test("the process inspection and dispatch claim both execute under the ticket start gate", async () => {
  const inspect = processInspection("");
  const h = routerHarness({ agents: [ompRoot("agent-gone")], processInspector: inspect });
  inspect.processes = async () => {
    assert.equal(h.gates.gate(ISSUE.id), null, "inspection cannot race another automatic start");
    h.calls.push("inspect");
    return "";
  };
  try {
    const outcome = await h.router.succeed(ISSUE.id, ISSUE.identifier, "agent-gone", "fix it", async () => {
      assert.equal(h.gates.gate(ISSUE.id), null);
      h.calls.push("claim");
    });
    assert.equal(outcome.kind, "started");
    assert.deepEqual(h.calls.slice(0, 4), ["inspect", "claim", "+paseo-running", "start"]);
    assertGateFree(h.gates);
  } finally { await h.cleanup(); }
});

// --- The watchdog's effects (watchdog.ts) -------------------------------------------------------

const watchdogRequest = (calls: string[], change: Partial<WatchdogRequest> = {}): WatchdogRequest => ({
  issueId: ISSUE.id, identifier: ISSUE.identifier, rootId: "agent-old", action: "steer", text: "Report and continue.", marker: "cycle-1:steer", turnId: "turn-1",
  check: async () => null, alive: () => true, claim: async () => { calls.push("claim"); }, ...change,
});
const silent = (change: Partial<FakeAgent> = {}) => ticketAgent("agent-old", "2026-01-01T00:00:00Z", { provider: "omp", status: "running", activeTurn: { turnId: "turn-1", startedAt: "2026-01-01T00:00:00Z" }, ...change });

test("the watchdog steers an OMP turn without stopping it, and never steers a provider that would lose its turn", async () => {
  const h = routerHarness({ agents: [silent()] });
  assert.deepEqual(await h.router.watchdogAct(watchdogRequest(h.calls)), { kind: "done" });
  assert.deepEqual(h.calls, ["claim"], "claimed, and no Stop");
  assert.deepEqual(h.daemon.sent, ["agent-old: /steer Report and continue."]);
  assertGateFree(h.gates);
  await h.cleanup();

  const other = routerHarness({ agents: [silent({ provider: "claude" })] });
  const outcome = await other.router.watchdogAct(watchdogRequest(other.calls));
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(other.calls, [], "nothing is claimed");
  assert.deepEqual(other.daemon.sent, []);
  await other.cleanup();
});

test("a watchdog step whose re-check fails, or whose turn already ended, claims and sends nothing", async () => {
  const h = routerHarness({ agents: [silent()] });
  assert.deepEqual(await h.router.watchdogAct(watchdogRequest(h.calls, { check: async () => "the agent waits for the owner's answer or approval" })),
    { kind: "skipped", reason: "the agent waits for the owner's answer or approval", end: true });
  assert.deepEqual(await h.router.watchdogAct(watchdogRequest(h.calls, { turnId: "turn-0" })), { kind: "skipped", reason: "the silent turn already ended", end: true });
  assert.deepEqual(await h.router.watchdogAct(watchdogRequest(h.calls, { alive: () => false })), { kind: "skipped", reason: "the plugin is unloading", end: false });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.daemon.sent, []);
  await h.cleanup();
});

test("the watchdog's interrupt stops the turn before its resume, and a turn that will not stop gets no resume", async () => {
  const agents = [silent()];
  const h = routerHarness({ agents, onStop: () => { agents[0].activeTurn = null; agents[0].status = "idle"; } });
  assert.deepEqual(await h.router.watchdogAct(watchdogRequest(h.calls, { action: "interrupt", marker: "cycle-1:interrupt" })), { kind: "done" });
  assert.deepEqual(h.calls, ["claim", "stop agent-old"]);
  assert.deepEqual(h.daemon.sent, ["agent-old: Report and continue."]);
  await h.cleanup();

  let clock = Date.parse("2026-02-01T00:00:00Z");
  const stuck = routerHarness({ agents: [silent()], now: () => clock, sleep: async (ms) => { clock += ms; } });
  const outcome = await stuck.router.watchdogAct(watchdogRequest(stuck.calls, { action: "interrupt" }));
  assert.deepEqual(outcome, { kind: "failed", reason: "the turn did not stop within 60 seconds" });
  assert.deepEqual(stuck.daemon.sent, [], "a resume would have gone into the still running turn");
  assertGateFree(stuck.gates);
  await stuck.cleanup();
});

test("a watchdog replacement retires its predecessor, waits while a worker lives, and then starts on the recorded branch with the cycle's label", async () => {
  let liveness: "alive" | "absent" = "alive";
  const agents = [silent()];
  const h = routerHarness({ agents, processLiveness: async () => liveness, onStop: () => { agents[0].activeTurn = null; agents[0].status = "idle"; } });
  const request = watchdogRequest(h.calls, { action: "succeed", marker: "cycle-1:succeed", text: "The previous agent stopped making progress." });
  const waiting = await h.router.watchdogAct(request);
  assert.equal(waiting.kind, "failed");
  assert.ok(waiting.kind === "failed" && waiting.retry, "retried until the retirement window ends");
  assert.deepEqual(h.calls, ["claim", "stop agent-old"]);
  assert.deepEqual(h.daemon.archived, ["agent-old"], "the predecessor is retired so it cannot come back");
  assert.equal(h.starts.length, 0, "no replacement beside a live worker");

  liveness = "absent";
  const started = await h.router.watchdogAct(request);
  assert.equal(started.kind, "done");
  assert.equal(started.kind === "done" ? started.successor?.id : null, "agent-new");
  assert.deepEqual(h.starts[0].options, { retryHint: "assign Paseo again", resumeOnly: true, lead: "The previous agent stopped making progress.", labels: { [WATCHDOG_LABEL]: "cycle-1:succeed" } });
  assertGateFree(h.gates);
  await h.cleanup();
});

test("a watchdog replacement bound for the peer is forwarded with its history and never starts here", async () => {
  const taken: unknown[] = [];
  const history: WatchdogHistory = { v: 1, starts: ["2026-01-01T00:00:00.000Z"], exhaustedAt: null, cycle: { id: "cycle-1", kind: "ghost", startedAt: "2026-01-01T00:00:00.000Z", marker: "cycle-1:succeed" } };
  const forwarded = routerHarness({ processLiveness: async () => "absent", route: { take: async (request) => { taken.push(request); return { peer: "server087" }; } } });
  const outcome = await forwarded.router.watchdogAct(watchdogRequest(forwarded.calls, { action: "succeed", rootId: "agent-gone", marker: "cycle-1:succeed", history }));
  assert.deepEqual(outcome, { kind: "done", peer: "server087" });
  assert.equal(forwarded.starts.length, 0);
  assert.deepEqual(forwarded.calls, ["claim"], "claimed before it was handed to the router");
  assert.deepEqual(taken, [{ kind: "recover", issueId: ISSUE.id, identifier: ISSUE.identifier, id: `watchdog:${ISSUE.id}:cycle-1:succeed`, text: "Report and continue.", strictResume: true, watchdog: history }]);
  await forwarded.cleanup();

  const held = routerHarness({ processLiveness: async () => "absent", route: { take: async () => ({ held: "the other host has not acknowledged this host's agents yet" }) } });
  const waiting = await held.router.watchdogAct(watchdogRequest(held.calls, { action: "succeed", rootId: "agent-gone" }));
  assert.equal(waiting.kind, "failed");
  assert.equal(held.starts.length, 0, "a held forward never falls back to a local start");
  await held.cleanup();
});

test("an owner Stop that arrives while a watchdog step is prepared keeps the steer and the replacement from going out", async () => {
  // The deep check before the claim passes; the owner's Stop is saved while the step prepares.
  const stopped = async (_agent: unknown, deep: boolean) => deep ? null : "the owner stopped the agent";
  const h = routerHarness({ agents: [silent()] });
  const steer = await h.router.watchdogAct(watchdogRequest(h.calls, { check: stopped }));
  assert.deepEqual(steer, { kind: "skipped", reason: "the owner stopped the agent", end: true });
  assert.deepEqual(h.daemon.sent, []);
  await h.cleanup();

  const replacement = routerHarness({ processLiveness: async () => "absent" });
  const outcome = await replacement.router.watchdogAct(watchdogRequest(replacement.calls, { action: "succeed", rootId: "agent-gone", marker: "cycle-1:succeed", check: stopped }));
  assert.deepEqual(outcome, { kind: "skipped", reason: "the owner stopped the agent", end: true });
  assert.equal(replacement.starts.length, 0);
  assertGateFree(replacement.gates);
  await replacement.cleanup();
});

// TUC-1209 AC-5/AC-16: SessionRouter.whileIdle runs the queue backstop's move only while no agent
// of the ticket works and this host owns the ticket; it never starts or forwards anything.
test("whileIdle runs its work only while no agent of the ticket works and this host owns the ticket", async (t) => {
  const idle = ticketAgent("agent-1", "2026-02-01T00:00:01Z");
  const cases: { name: string; agents: FakeAgent[]; liveness?: "absent" | "alive" | "unknown"; owner?: HostOwnership | "throws"; launching?: boolean; disconnected?: boolean; expected: string }[] = [
    { name: "idle, closed and archived agents", agents: [idle, ticketAgent("agent-2", "2026-02-01T00:00:02Z", { status: "closed" }), ticketAgent("agent-3", "2026-02-01T00:00:03Z", { status: "running", archivedAt: "then" })], expected: "ran" },
    { name: "no agent at all", agents: [], expected: "ran" },
    { name: "an agent in a turn", agents: [ticketAgent("agent-1", "2026-02-01T00:00:01Z", { status: "running" })], expected: "busy" },
    { name: "an agent waiting for the owner", agents: [ticketAgent("agent-1", "2026-02-01T00:00:01Z", { pendingPermissions: [{ id: "p1", kind: "question" }] })], expected: "waiting" },
    { name: "a live successor in a turn next to an idle predecessor", agents: [idle, ticketAgent("agent-2", "2026-02-01T00:00:02Z", { status: "running" })], expected: "busy" },
    { name: "an orphan worker process", agents: [idle], liveness: "alive", expected: "busy" },
    { name: "worker processes that cannot be inspected", agents: [idle], liveness: "unknown", expected: "busy" },
    { name: "a launch under way", agents: [idle], launching: true, expected: "busy" },
    { name: "the peer host owns the ticket", agents: [idle], owner: "elsewhere", expected: "elsewhere" },
    { name: "ownership not confirmed (no handshake yet)", agents: [idle], owner: "unknown", expected: "unavailable" },
    { name: "ownership unreadable", agents: [idle], owner: "throws", expected: "unavailable" },
    { name: "Paseo not connected", agents: [idle], disconnected: true, expected: "unavailable" },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const h = routerHarness({
        agents: item.agents,
        processLiveness: async () => item.liveness ?? "absent",
        owner: async () => {
          if (item.owner === "throws") throw new Error("the activation claims cannot be read");
          return item.owner ?? "here";
        },
      });
      try {
        if (item.disconnected) Object.assign(h.router, { paseo: null });
        const held = item.launching ? h.gates.gate(ISSUE.id) : null;
        let ran = 0;
        const run = await h.router.whileIdle(ISSUE.id, async () => { ran++; return "moved"; });
        held?.release();
        assert.equal(run.outcome, item.expected);
        assert.equal(ran, item.expected === "ran" ? 1 : 0);
        if (run.outcome === "ran") assert.equal(run.value, "moved");
        assert.deepEqual(h.starts, [], "nothing is started");
        assert.deepEqual(h.daemon.sent, [], "nothing is sent");
        assertGateFree(h.gates);
      } finally { await h.cleanup(); }
    });
  }
});

test("whileIdle holds the ticket's start gate while its work runs, and frees it when the work throws", async () => {
  const h = routerHarness({ agents: [ticketAgent("agent-1", "2026-02-01T00:00:01Z")], processLiveness: async () => "absent" });
  try {
    await h.router.whileIdle(ISSUE.id, async () => {
      assert.equal(h.gates.gate(ISSUE.id), null, "no start of the ticket can begin during the move");
    });
    await assert.rejects(h.router.whileIdle(ISSUE.id, async () => { throw new Error("the script failed"); }), /the script failed/);
    assertGateFree(h.gates);
  } finally { await h.cleanup(); }
});

test("whileIdle does not run while a closed or archived subagent's worker of the ticket still lives", async () => {
  for (const change of [{}, { archivedAt: "now" }]) {
    const subagent = ompRoot("agent-sub", { ...change, labels: { "linear.issueId": ISSUE.id, "linear.identifier": ISSUE.identifier, "paseo.parent-agent-id": "agent-1" } });
    const live = routerHarness({ agents: [ticketAgent("agent-1", "2026-02-01T00:00:01Z"), subagent], processInspector: processInspection(`2100185 omp --mode rpc-ui --session ${NATIVE_HANDLE}\n`) });
    const gone = routerHarness({ agents: [ticketAgent("agent-1", "2026-02-01T00:00:01Z"), subagent], processInspector: processInspection("2100185 omp --mode rpc-ui --session /home/mirko/.omp/agent/sessions/other.jsonl\n") });
    try {
      let ran = 0;
      assert.equal((await live.router.whileIdle(ISSUE.id, async () => { ran++; })).outcome, "busy", JSON.stringify(change));
      assert.equal((await gone.router.whileIdle(ISSUE.id, async () => { ran++; })).outcome, "ran", JSON.stringify(change));
      assert.equal(ran, 1);
      assertGateFree(live.gates);
    } finally {
      await live.cleanup();
      await gone.cleanup();
    }
  }
});
