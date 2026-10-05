import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { launchAgentRpc, TicketDetail } from "../shared/contracts";
import { Dispatcher } from "./dispatch";
import { Launcher } from "./launch";
import { advisorNote, MISSED_REACH_NOTE, MODEL_NOTE, OVERLAP_NOTE, PLAN_REQUIRED_NOTE, PLAN_SECTIONS_NOTE, QUESTIONS_NOTE, TicketStarter } from "./starter";
import type { LabeledIssue } from "./linear";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";

const baseSettings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false,
  lastProvider: "claude", launchPreferences: { claude: { model: "claude/opus", modeId: "default" } },
  projectMappings: { "project:lp-1": { projectId: "p1", label: "App", baseBranch: "refs/heads/dev" } },
  agentLinearAccess: true,
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["ENG"] },
  writeback: DEFAULT_WRITEBACK, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [],
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

  async appUserId() { return "paseo-app"; }

  async issueDocument() { return null; }

  async moveToStateNamed() { return { changed: false }; }

  async issueState(id: string) {
    return { id, identifier: id.toUpperCase(), status: "Todo", statusId: "todo", statusType: "unstarted", teamId: "t1", projectId: null, creatorId: "owner", labels: [], attachmentUrls: [], blockedBy: this.blocked[id] ?? [], priority: 0, createdAt: "", unblocks: 0 };
  }

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

function setup(t: TestContext, linear: FakeLinear, settings: PluginSettings = baseSettings, paseo = fakePaseo(), handOff?: (issueId: string) => Promise<boolean>, gates = new Launcher(linear as never)) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const launches: RpcInput<typeof launchAgentRpc>[] = [];
  const starter = new TicketStarter({
    linear,
    launcher: { start: async (input) => { launches.push(input); return { agentId: "agent-1", warnings: [] }; } },
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
    instructions: `${PLAN_REQUIRED_NOTE}\n\n${OVERLAP_NOTE}\n\n${PLAN_SECTIONS_NOTE}\n\n${MODEL_NOTE}\n\n${advisorNote("claude")}\n\n${MISSED_REACH_NOTE}\n\n${QUESTIONS_NOTE}`, markInProgress: false, requestId: launches[0].requestId,
  });
  assert.deepEqual(linear.writes.slice(1, 3), ["-paseo eng-1", "+paseo-running eng-1"]);
  assert.deepEqual([...linear.labels.get("eng-1")!].sort(), ["bug", "paseo-running"]);
  assert.match(linear.writes.at(-1)!, /^comment eng-1: Paseo started an agent .*claude\/opus in repo/);
  await dispatcher.tick();
  assert.equal(launches.length, 1);
  assert.equal(dispatcher.snapshot().recent[0].outcome, "launched");
});

test("a labelled ticket with open sub-issues is handed to Paseo as a group: the label comes off and no agent starts for it", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"], "eng-2": ["paseo"] });
  linear.parents.add("eng-1");
  const asked: string[] = [];
  const { dispatcher, launches } = setup(t, linear, baseSettings, fakePaseo(), async (id) => { asked.push(id); return true; });
  await dispatcher.tick();
  assert.deepEqual(asked, ["eng-1"], "tickets without open sub-issues are not looked at");
  assert.deepEqual([...linear.labels.get("eng-1")!], []);
  assert.deepEqual(launches.map((launch) => launch.id), ["eng-2"]);
  assert.deepEqual(dispatcher.snapshot().recent.map((item) => `${item.identifier} ${item.outcome}`), ["ENG-2 launched", "ENG-1 grouped"]);
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

test("the mapped base branch falls back to the repository default when it no longer exists", async (t) => {
  const linear = new FakeLinear({ "eng-1": ["paseo"] });
  const settings = { ...baseSettings, projectMappings: { "project:lp-1": { projectId: "p1", label: "App", baseBranch: "refs/heads/deleted" } } };
  const { dispatcher, launches } = setup(t, linear, settings);
  await dispatcher.tick();
  assert.equal(launches[0].baseBranch, "refs/heads/main");
});
