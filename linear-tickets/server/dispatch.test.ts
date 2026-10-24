import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { launchAgentRpc, TicketDetail } from "../shared/contracts";
import { Dispatcher, type GroupHandoff } from "./dispatch";
import { Launcher } from "./launch";
import { MISSED_REACH_NOTE, MODEL_NOTE, RELATED_WORK_NOTE, QUESTIONS_NOTE, TicketStarter, WAITING_PLAN_REASON } from "./starter";
import { advisorNote, PLAN_REQUIRED_NOTE, PLAN_SECTIONS_NOTE, PLAN_SLICING_NOTE } from "./plan-policy";
import { RepairBusyError } from "./repair-exclusion";
import { RateLimitedError } from "./rate-budget";
import type { IssueGroup, LabeledIssue } from "./linear";
import { DEFAULT_WORKTREE_SHARDS, DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_STEWARD, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParkedPlans } from "./parked";
import { AgentDirectory } from "./agent-directory";
import { SessionRouter, SessionStore } from "./sessions";
import { ParentStore } from "./parents";
import { WatchdogStore } from "./watchdog";

const baseSettings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false,
  lastProvider: "claude", launchPreferences: { claude: { model: "claude/opus", modeId: "default" } },
  projectMappings: { "project:lp-1": { projectId: "p1", label: "App", baseBranch: "refs/heads/dev" } },
  agentLinearAccess: true,
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["ENG"] },
  writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, steward: DEFAULT_STEWARD, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};

// A Linear workspace in memory: tickets with label names, and every write recorded.
class FakeLinear {
  readonly writes: string[] = [];
  readonly labels: Map<string, Set<string>>;
  readonly blocked: Record<string, string[]> = {};
  readonly parents = new Set<string>();

  constructor(tickets: Record<string, string[]>, private readonly options: { failRemove?: boolean } = {}) {
    this.labels = new Map(Object.entries(tickets).map(([id, names]) => [id, new Set(names)]));
  }

  async labeledIssues(label: string, teamKeys: string[]): Promise<LabeledIssue[]> {
    this.writes.push(`query ${label} ${teamKeys.join(",")}`);
    return [...this.labels].filter(([, names]) => [...names].some((name) => name.toLowerCase() === label.toLowerCase()))
      .map(([id, names]) => ({ id, identifier: id.toUpperCase(), teamKey: "ENG", priority: 0, labels: [...names].map((name) => ({ id: `l-${name}`, name })), openChildren: this.parents.has(id) }));
  }

  async removeLabel(id: string, name: string) {
    if (this.options.failRemove) throw new Error("write access required");
    this.labels.get(id)?.delete(name);
    this.writes.push(`-${name} ${id}`);
  }

  async addLabel(id: string, name: string) {
    this.labels.get(id)?.add(name);
    this.writes.push(`+${name} ${id}`);
  }

  async comment(id: string, body: string) { this.writes.push(`comment ${id}: ${body}`); }

  async viewerId() { return "owner"; }

  async trustedAppIds() { return ["paseo-app"]; }

  async issueDocument() { return null; }

  async moveToStateNamed() { return { changed: false }; }

  async issueState(id: string) {
    return { id, identifier: id.toUpperCase(), status: "Todo", statusId: "todo", statusType: "unstarted", teamId: "t1", projectId: null, creatorId: "owner", labels: [], attachmentUrls: [], blockedBy: this.blocked[id] ?? [], priority: 0, createdAt: "", unblocks: 0 };
  }

  async issueCore(id: string) { return this.issueState(id); }

  async detail(id: string): Promise<TicketDetail> {
    // Only the fields dispatch reads; the fixture is not a full Linear snapshot.
    const detail = { issue: { id, identifier: id.toUpperCase(), project: "App", team: "Engineering" }, projectId: id === "unmapped" ? "lp-2" : "lp-1", teamId: "t1" };
    return detail as unknown as TicketDetail;
  }
}

function fakePaseo(activeAgents: { id: string; title: string }[] = []): PaseoApi {
  return {
    agents: { list: async () => ({ entries: activeAgents.map((agent) => ({ agent })) }) },
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectKind: "git", projectRootPath: "/repo", projectDisplayName: "repo" }] }) },
  } as unknown as PaseoApi;
}

function setup(t: TestContext, linear: FakeLinear, settings: PluginSettings = baseSettings, paseo = fakePaseo(), handOff?: (issueId: string, openChildren: boolean) => Promise<GroupHandoff>, gates = new Launcher(linear as never), failure: { error?: Error } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const launches: RpcInput<typeof launchAgentRpc>[] = [];
  const starter = new TicketStarter({
    linear,
    launcher: { start: async (input) => { launches.push(input); if (failure.error) throw failure.error; return { agentId: "agent-1", warnings: [] }; } },
    branches: async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }, { id: "refs/heads/main", label: "main" }], defaultBranch: "refs/heads/main" }),
  });
  const dispatcher = new Dispatcher({ linear, starter, launcher: gates, settings: { read: async () => settings }, handOff });
  dispatcher.attach(paseo);
  return { dispatcher, launches };
}

test("a labeled ticket is claimed before its agent launches, and is not launched again on the next poll", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo", "bug"] });
  const { dispatcher, launches } = setup(t, linear);
  await dispatcher.tick();
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0], {
    id: "eng-1", projectId: "p1", baseBranch: "refs/heads/dev", provider: "claude/opus", modeId: "plan", thinkingOptionId: undefined,
    instructions: `${PLAN_REQUIRED_NOTE}\n\n${RELATED_WORK_NOTE}\n\n${PLAN_SECTIONS_NOTE}\n\n${PLAN_SLICING_NOTE}\n\n${MODEL_NOTE}\n\n${advisorNote("claude")}\n\n${MISSED_REACH_NOTE}\n\n${QUESTIONS_NOTE}`, markInProgress: false, requestId: launches[0].requestId,
  });
  assert.deepEqual(linear.writes.slice(1, 3), ["-paseo eng-1", "+paseo-running eng-1"]);
  assert.deepEqual([...linear.labels.get("eng-1")!].sort(), ["bug", "paseo-running"]);
  assert.match(linear.writes.at(-1)!, /^comment eng-1: Paseo started an agent .*claude\/opus in repo/);
  await dispatcher.tick();
  assert.equal(launches.length, 1);
  assert.equal(dispatcher.snapshot().recent[0].outcome, "launched");
});

test("a start refused while a repair holds the ticket restores the trigger, never fails the ticket, and retries on the next poll", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"] });
  const failure: { error?: Error } = { error: new RepairBusyError() };
  const { dispatcher, launches } = setup(t, linear, baseSettings, fakePaseo(), undefined, undefined, failure);
  await dispatcher.tick();
  assert.equal(launches.length, 1, "one attempt, no fallback launch");
  assert.deepEqual([...linear.labels.get("eng-1")!], ["paseo"], "the trigger is back; no -running and no -failed label");
  assert.ok(!linear.writes.some((write) => write.includes("could not start an agent")), "no failure note on the ticket");
  assert.deepEqual(dispatcher.snapshot().recent, [], "no launched or failed attempt is recorded");

  failure.error = undefined;
  await dispatcher.tick();
  assert.equal(launches.length, 2, "the next poll tries again");
  assert.deepEqual([...linear.labels.get("eng-1")!], ["paseo-running"]);
});

test("a labelled ticket with open sub-issues is handed to Paseo as a group: the label comes off and no agent starts for it", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"], "eng-2": ["paseo"] });
  linear.parents.add("eng-1");
  const asked: string[] = [];
  const { dispatcher, launches } = setup(t, linear, baseSettings, fakePaseo(), async (id, openChildren) => { asked.push(id); return openChildren ? "grouped" : "not-group"; });
  await dispatcher.tick();
  assert.deepEqual(asked, ["eng-1", "eng-2"], "the cheap handoff hint also permits tracked parents without open children");
  assert.deepEqual([...linear.labels.get("eng-1")!], []);
  assert.deepEqual(launches.map((launch) => launch.id), ["eng-2"]);
  assert.deepEqual(dispatcher.snapshot().recent.map((item) => `${item.identifier} ${item.outcome}`), ["ENG-2 launched", "ENG-1 grouped"]);
});

async function groupDispatch(t: TestContext, owner: () => Promise<"here" | "elsewhere" | "unknown">) {
  const directory = await mkdtemp(join(tmpdir(), "group-dispatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const group: IssueGroup = {
    id: "eng-1", identifier: "ENG-1", status: "Todo", statusType: "unstarted", delegateId: null, finished: false,
    children: [{ id: "eng-child", identifier: "ENG-2", status: "Todo", statusType: "unstarted", delegateId: null, finished: false, assigneeId: null, labels: [], blockers: [] }],
  };
  const linear = Object.assign(new FakeLinear({ "eng-1": ["paseo"] }), {
    appUserId: async () => "paseo-app",
    issueGroup: async () => structuredClone(group),
    delegate: async (id: string, appId: string): Promise<void> => {
      linear.writes.push(`delegate ${id}`);
      if (id === group.id) group.delegateId = appId;
      else group.children.find((child) => child.id === id)!.delegateId = appId;
    },
  });
  linear.parents.add(group.id);
  const store = new SessionStore(join(directory, "sessions.json"));
  const parents = new ParentStore(directory);
  const watchdog = new WatchdogStore(join(directory, "watchdog.json"));
  const router = new SessionRouter({
    agentDirectory: new AgentDirectory(),
    linear: linear as never, store, parents, watchdog, owner, settings: { read: async () => baseSettings },
    api: { activity: async () => {}, updateSession: async () => {} } as never,
    starter: { admission: async () => ({ ok: true }), start: async () => { throw new Error("Group must not launch an implementation worker"); } },
    handover: { resumeTarget: async () => null, handOff: async () => true },
    launcher: new Launcher(linear as never),
  });
  const { dispatcher, launches } = setup(t, linear, baseSettings, fakePaseo(), (id, open) => router.handOffGroup(id, open));
  t.after(() => { dispatcher.stop(); router.stop(); });
  return { group, linear, store, parents, watchdog, router, dispatcher, launches };
}

test("a host denied group ownership preserves the shared activation and never starts a parent worker", async (t) => {
  for (const denied of ["elsewhere", "unknown", "unreadable"] as const) await t.test(denied, async (t) => {
    let local = false;
    const h = await groupDispatch(t, async () => {
      if (local) return "here";
      if (denied === "unreadable") throw new Error("claims unavailable");
      return denied;
    });
    await h.dispatcher.tick();
    assert.equal(h.linear.labels.get("eng-1")?.has("paseo"), true);
    assert.equal(h.launches.length, 0);
    assert.equal(h.linear.writes.some((write) => write.startsWith("delegate ")), false);
    assert.equal(await h.parents.get("eng-1"), null);
    local = true;
    await h.dispatcher.tick();
    assert.equal(h.linear.labels.get("eng-1")?.has("paseo"), false);
    assert.equal(h.launches.length, 0);
    assert.deepEqual(h.linear.writes.filter((write) => write.startsWith("delegate ")), ["delegate eng-1", "delegate eng-child"]);
    assert.equal((await h.parents.get("eng-1"))?.phase, "children");
  });
});

test("an explicit trigger reactivates stopped or unassigned durable groups instead of consuming it without work", async (t) => {
  for (const stopped of ["owner", "unassigned", "finished-children"] as const) await t.test(stopped, async (t) => {
    const h = await groupDispatch(t, async () => "here");
    if (stopped !== "unassigned") {
      h.group.delegateId = "paseo-app";
      await h.watchdog.hold("eng-1", null);
    }
    if (stopped === "finished-children") {
      h.group.children[0].status = "Done"; h.group.children[0].statusType = "completed";
      h.linear.parents.delete("eng-1");
    }
    await h.store.put({ sessionId: "old", agentId: null, issueId: "eng-1", identifier: "ENG-1",
      createdAt: "2026-10-14T00:00:00.000Z", handled: [], review: null, offer: null, closed: true,
      group: { delegated: true, stopped: stopped !== "unassigned" },
    });
    await h.router.advanceGroups();
    assert.equal((await h.parents.get("eng-1"))?.phase, "closed");
    await h.parents.update("eng-1", (current) => ({ ...current!, handedOut: ["eng-child"] }));
    await h.dispatcher.tick();
    assert.equal(h.linear.labels.get("eng-1")?.has("paseo"), false);
    assert.equal(h.launches.length, 0);
    assert.equal((await h.parents.get("eng-1"))?.phase, stopped === "finished-children" ? "verification" : "children");
    assert.equal(Object.hasOwn((await h.watchdog.read()).holds, "eng-1"), false, "explicit continuation releases the durable owner Stop");
    assert.equal((await h.store.get("old"))?.closed, true, "reactivation does not resurrect obsolete UI threads");
    assert.deepEqual(h.linear.writes.filter((write) => write.startsWith("delegate ")),
      stopped === "finished-children" ? [] : stopped === "owner" ? ["delegate eng-child"] : ["delegate eng-1", "delegate eng-child"]);
  });
});

test("a denied explicit reactivation preserves both the trigger and the stopped responsibility", async (t) => {
  const h = await groupDispatch(t, async () => "elsewhere");
  await h.watchdog.hold("eng-1", null);
  await h.store.put({ sessionId: "old", agentId: null, issueId: "eng-1", identifier: "ENG-1",
    createdAt: "2026-10-14T00:00:00.000Z", handled: [], review: null, offer: null, closed: true,
    group: { delegated: true, stopped: true },
  });
  await h.dispatcher.tick();
  assert.equal(h.linear.labels.get("eng-1")?.has("paseo"), true);
  assert.equal(Object.hasOwn((await h.watchdog.read()).holds, "eng-1"), true);
  assert.equal((await h.parents.get("eng-1"))?.phase, "closed");
  assert.equal((await h.store.get("old"))?.group?.stopped, true);
  assert.equal(h.launches.length, 0);
  assert.equal(h.linear.writes.some((write) => write.startsWith("delegate ")), false);
});

test("a failed durable Stop release preserves the activation and cannot hand out children", async (t) => {
  const h = await groupDispatch(t, async () => "here");
  h.group.delegateId = "paseo-app";
  await h.watchdog.hold("eng-1", null);
  await h.store.put({ sessionId: "old", agentId: null, issueId: "eng-1", identifier: "ENG-1",
    createdAt: "2026-10-14T00:00:00.000Z", handled: [], review: null, offer: null, closed: true,
    group: { delegated: true, stopped: true },
  });
  t.mock.method(h.watchdog, "continued", async () => { throw new Error("watchdog storage unavailable"); });
  await h.dispatcher.tick();
  assert.equal(h.linear.labels.get("eng-1")?.has("paseo"), true);
  assert.equal(Object.hasOwn((await h.watchdog.read()).holds, "eng-1"), true);
  assert.equal((await h.parents.get("eng-1"))?.phase, "closed");
  assert.equal(h.linear.writes.some((write) => write.startsWith("delegate ")), false);
  assert.equal(h.launches.length, 0);
});

test("a ticket without a saved project mapping is marked failed with the reason instead of launching", async (t) => {
  const linear = new FakeLinear({ unmapped: ["paseo"] });
  const { dispatcher, launches } = setup(t, linear);
  await dispatcher.tick();
  assert.equal(launches.length, 0);
  assert.deepEqual([...linear.labels.get("unmapped")!], ["paseo-failed"]);
  assert.match(linear.writes.at(-1)!, /could not start an agent for this ticket: No Paseo project is mapped to App/);
  assert.equal(dispatcher.snapshot().recent[0].outcome, "failed");
});

test("without a remembered provider nothing launches and the ticket says why", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"] });
  const { dispatcher, launches } = setup(t, linear, { ...baseSettings, lastProvider: null });
  await dispatcher.tick();
  assert.equal(launches.length, 0);
  assert.match(linear.writes.at(-1)!, /No provider has been chosen/);
});

test("a ticket that already has an active agent is linked, not launched twice", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"] });
  const { dispatcher, launches } = setup(t, linear, baseSettings, fakePaseo([{ id: "a1", title: "ENG-1: Fix" }]));
  await dispatcher.tick();
  assert.equal(launches.length, 0);
  assert.deepEqual([...linear.labels.get("eng-1")!], ["paseo-running"]);
  assert.equal(dispatcher.snapshot().recent[0].outcome, "linked");
});

test("a ticket whose plan waits for the owner starts nothing: its trigger label is consumed even while focus holds it, and starts wait until the plan is decided", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-parked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parked = new ParkedPlans(directory);
  await parked.put({ issueId: "eng-1", identifier: "ENG-1", agentId: "planner-1", plan: "# Plan", line: "", reasons: [], model: null, parkedAt: "2026-01-01T00:00:00Z", announced: true });
  const linear = new FakeLinear({ "eng-1": ["paseo"], "eng-2": ["paseo"] });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const launches: string[] = [];
  const starter = new TicketStarter({
    linear, parked,
    launcher: { start: async (input) => { launches.push(input.id); return { agentId: `agent-${input.id}`, warnings: [] }; } },
    branches: async () => ({ branches: [{ id: "refs/heads/dev", label: "dev" }], defaultBranch: "refs/heads/dev" }),
  });
  // Focus mode holds ENG-1: once it ends, a held label would start a second planner.
  const focus = { admits: async (issueId: string) => issueId === "eng-1" ? "outside focus" : null };
  const dispatcher = new Dispatcher({ linear, starter, launcher: new Launcher(linear as never), settings: { read: async () => baseSettings }, focus, parked });
  dispatcher.attach(fakePaseo());
  await dispatcher.tick();
  assert.deepEqual(launches, ["eng-2"]);
  assert.deepEqual([...linear.labels.get("eng-1")!], [], "the owner's decision starts the next agent, not the label");
  assert.deepEqual(dispatcher.snapshot().recent.map((item) => `${item.identifier} ${item.outcome}`), ["ENG-2 launched", "ENG-1 linked"]);
  // Every other start path (a queued thread, a restart, a forwarded activation) asks admission.
  assert.deepEqual(await starter.admission("eng-1", fakePaseo(), baseSettings), { ok: false, reason: WAITING_PLAN_REASON });
  // The decision unparks the plan last; its queued thread is admitted from then on.
  await parked.remove("eng-1");
  assert.equal((await starter.admission("eng-1", fakePaseo(), baseSettings)).ok, true);
});

test("when the claim cannot be written nothing launches and the ticket keeps its trigger label", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"] }, { failRemove: true });
  const { dispatcher, launches } = setup(t, linear);
  await dispatcher.tick();
  assert.equal(launches.length, 0);
  assert.deepEqual([...linear.labels.get("eng-1")!], ["paseo"]);
  assert.match(dispatcher.snapshot().lastError ?? "", /write access required/);
});

test("disabled dispatch, or enabled without teams, never queries Linear", async (t) => {
  for (const dispatch of [{ ...baseSettings.dispatch, enabled: false }, { ...baseSettings.dispatch, teamKeys: [] }]) {
    const linear = new FakeLinear({ "eng-1": ["paseo"] });
    const { dispatcher } = setup(t, linear, { ...baseSettings, dispatch });
    await dispatcher.tick();
    assert.deepEqual(linear.writes, []);
    assert.equal(dispatcher.snapshot().active, false);
    t.mock.timers.reset();
  }
});

test("the new-ticket check is the last pass of every poll, and its rate limit pauses the poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order: string[] = [];
  let limited = false;
  const pass = (name: string) => ({ tick: async () => { order.push(name); if (name === "new-tickets" && limited) throw new RateLimitedError("app", Date.now() + 60_000); } });
  const linear = new FakeLinear({});
  const dispatcher = new Dispatcher({ linear, starter: new TicketStarter({ linear, launcher: { start: async () => ({ agentId: "a", warnings: [] }) }, branches: async () => ({ branches: [], defaultBranch: "refs/heads/main" }) }), launcher: new Launcher(linear as never), settings: { read: async () => baseSettings }, projects: pass("projects"), catchUp: pass("catch-up"), newTickets: pass("new-tickets") });
  dispatcher.attach(fakePaseo());
  await dispatcher.tick();
  assert.deepEqual(order, ["projects", "catch-up", "new-tickets"]);
  limited = true;
  await dispatcher.tick();
  assert.match(dispatcher.snapshot().lastError ?? "", /^paused/);
});

test("the mapped base branch falls back to the repository default when it no longer exists", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"] });
  const settings = { ...baseSettings, projectMappings: { "project:lp-1": { projectId: "p1", label: "App", baseBranch: "refs/heads/deleted" } } };
  const { dispatcher, launches } = setup(t, linear, settings);
  await dispatcher.tick();
  assert.equal(launches[0].baseBranch, "refs/heads/main");
});
