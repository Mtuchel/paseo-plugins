import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions, PaseoWorkspaceCreateOptions } from "@getpaseo/client";
import type { TicketDetail } from "../shared/contracts";
import { Dispatcher } from "./dispatch";
import { Handover } from "./handover";
import { Launcher, LEAD_INTRO, type ResumeTarget } from "./launch";
import type { IssueState, LabeledIssue } from "./linear";
import { SessionRouter, SessionStore, type SessionLink, type Succession } from "./sessions";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { ResumeUnavailableError, TicketStarter, type Started } from "./starter";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";

const OWNER = "owner-1";
const APP = "paseo-app";
const ISSUE = { id: "issue-1", identifier: "TUC-1" };
const BRANCH = "mtuchel/tuc-1-fix";

const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false,
  lastProvider: "claude", launchPreferences: { claude: { model: "claude/opus", modeId: "default" } },
  projectMappings: { "project:lp-1": { projectId: "p1", label: "App", baseBranch: "refs/heads/dev" } },
  agentLinearAccess: false,
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["ENG"], maxRunning: 2 },
  writeback: DEFAULT_WRITEBACK, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [],
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
};

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
  );
  return { instance, prompts, daemon };
}

// --- The router, on its own (fake starter, real Launcher gate) ---------------------------------

function routerHarness(options: {
  agents?: FakeAgent[];
  pageSize?: number;
  resumeTarget?: ResumeTarget | null;
  handOff?: () => Promise<boolean> | never;
  admission?: { ok: true } | { ok: false; reason: string };
  failStart?: boolean;
  // Called inside the start, before the agent exists; the start goes on once it settles.
  pauseStart?: () => Promise<void>;
  openFails?: boolean;
  statusType?: string;
  gates?: Launcher;
  daemon?: Daemon;
} = {}) {
  const calls: string[] = [];
  const daemon = options.daemon ?? fakeDaemon(options.agents ?? [], { pageSize: options.pageSize });
  const directory = join(tmpdir(), `paseo-successor-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = new SessionStore(join(directory, "sessions.json"));
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
    admission: async () => options.admission ?? { ok: true as const },
  };
  const router = new SessionRouter({
    api: {
      activity: async (_session: string, content: { type: string; body?: string }) => { calls.push(`${content.type}:${(content.body ?? "").split("\n")[0]}`); },
      updateSession: async () => {},
      createSessionOnIssue: async () => { if (options.openFails) throw new Error("Linear is rate-limited"); return "s-new"; },
      openSessions: async () => [],
      activities: async () => [],
      sessionStatus: async () => "active",
    } as never,
    linear: linear as never,
    starter: starter as never,
    handover: handover as never,
    launcher: { gate: (issueId: string) => gates.gate(issueId) },
    settings: { read: async () => settings },
    store,
    stop: async (agentId: string) => { calls.push(`stop ${agentId}`); },
  });
  // Connected without attach(): the startup sweep would run alongside the test.
  Object.assign(router, { paseo: daemon.paseo });
  return { router, store, calls, daemon, starts, gates, linear, cleanup: () => rm(directory, { recursive: true, force: true }) };
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

function starterHarness(options: { resumeTarget?: ResumeTarget | null; projectKind?: string; resumeFails?: boolean } = {}) {
  const launches: { resume?: ResumeTarget }[] = [];
  const branches = { branches: [{ id: "refs/heads/dev", label: "dev" }], defaultBranch: "refs/heads/dev" };
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
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectKind: options.projectKind ?? "git", projectRootPath: "/repo", projectDisplayName: "repo" }] }) },
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

// --- AC-16: the project planner restart ---------------------------------------------------------

test("restartFor refuses while the gate is held and starts nothing behind a live successor", async () => {
  const held = routerHarness();
  const gate = held.gates.gate(ISSUE.id);
  assert.ok(gate);
  await assert.rejects(held.router.restartFor(ISSUE.id, ISSUE.identifier), /A launch for this ticket is under way\./);
  gate.release();
  assertGateFree(held.gates);
  await held.cleanup();

  const live = routerHarness({ agents: [ticketAgent("agent-live", "2026-01-02T00:00:00Z")] });
  await live.router.restartFor(ISSUE.id, ISSUE.identifier);
  assert.equal(live.starts.length, 0, "a live successor is no planner to restart");
  assert.deepEqual(live.calls, []);
  assertGateFree(live.gates);
  await live.cleanup();

  const stopped = routerHarness({
    agents: [
      ticketAgent("agent-closed", "2026-01-01T00:00:00Z", { status: "closed" }),
      ticketAgent("agent-error", "2026-01-02T00:00:00Z", { status: "error", lastError: "OMP RPC process is closed" }),
    ],
  });
  await stopped.router.restartFor(ISSUE.id, ISSUE.identifier);
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

test("a comment that cannot be delivered keeps the thread queued and goes out once on the next sweep", async () => {
  const h = routerHarness();
  await h.store.put(thread({ queued: true, pendingText: "rebase it please" }));
  h.daemon.add(ticketAgent("agent-new", "2026-02-01T00:00:00Z"));
  h.daemon.state.failSend = true;

  await h.router.startQueued();
  const failed = await h.store.get("s1");
  assert.deepEqual({ queued: failed?.queued, pendingText: failed?.pendingText, agentId: failed?.agentId }, { queued: true, pendingText: "rebase it please", agentId: null });
  assert.deepEqual(h.daemon.sent, []);
  assertGateFree(h.gates);

  h.daemon.state.failSend = false;
  await h.router.startQueued();
  assert.deepEqual(h.daemon.sent, ["agent-new: rebase it please"]);
  assert.deepEqual({ queued: (await h.store.get("s1"))?.queued, pendingText: (await h.store.get("s1"))?.pendingText }, { queued: false, pendingText: null });
  await h.router.startQueued();
  assert.deepEqual(h.daemon.sent, ["agent-new: rebase it please"], "delivered exactly once");
  await h.cleanup();
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
