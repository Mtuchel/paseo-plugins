import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { IssueState } from "./linear";
import { TierStore } from "./model-tiers";
import { parseEvent } from "./plannotator";
import { DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_WORKTREE_SHARDS, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { SmallRoutes, smallRouteDirectory, type RouteEvent } from "./small-route";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";

// The omp extension reads its environment when it loads, so it is imported after this setup: an
// omp ticket planner the plugin offered the small-ticket route.
const root = mkdtempSync(join(tmpdir(), "paseo-small-route-tool-"));
for (const name of Object.keys(process.env)) if (name.startsWith("LINEAR_TICKETS_")) delete process.env[name];
Object.assign(process.env, { PASEO_AGENT_ID: "planner-1", PASEO_HOME: root, LINEAR_TICKETS_ISSUE: "TUC-7", LINEAR_TICKETS_PLAN: "required", LINEAR_TICKETS_SMALL_ROUTE: "1", PI_CODING_AGENT_DIR: root });
const { default: extension } = await import("../omp/linear-tickets-plan-first");
after(() => rmSync(root, { recursive: true, force: true }));

type Result = { content: { text: string }[] };
type Tool = { name: string; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<Result> };
type Request = { payload: { mode: string }; respond(response: { status: string; result: { phase: string } }): void };

const FACTS = {
  acceptanceCriteria: 1, expectedChangedLines: 40, impact: 1, reversibility: "revert",
  migration: "no", auth: "no", moneyOrErp: "no", crossPackageContract: "no", newRule: "no", ownerDecisionNeeded: "no",
  tier: "cheap", tierReason: "a copy change", reach: "Only the settings page.", reason: "One label text.",
};
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp", launchPreferences: { omp: { model: "omp/opus", modeId: "full" } },
  projectMappings: {}, agentLinearAccess: false,
  dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};

function load() {
  const tools: Tool[] = [];
  const entries: { customType: string }[] = [];
  const modes: string[] = [];
  const phase = { now: "planning" };
  const field = () => ({ describe: field, optional: () => ({}) });
  extension({
    on: () => {},
    events: { emit: (_channel: string, request: Request) => {
      modes.push(request.payload.mode);
      if (request.payload.mode === "exit") phase.now = "idle";
      request.respond({ status: "handled", result: { phase: phase.now } });
    } },
    appendEntry: (customType: string) => { entries.push({ customType }); },
    sendMessage: () => {},
    registerTool: (tool: Tool) => { tools.push(tool); },
    zod: { object: () => ({}), string: field, number: field, enum: field },
  } as never);
  const tool = tools.find((candidate) => candidate.name === "take_small_ticket_route");
  assert.ok(tool, "an offered omp planner gets the tool");
  const ctx = { cwd: root, sessionManager: { getBranch: () => [] } };
  return { modes, entries, call: async (params: Record<string, unknown>, signal?: AbortSignal) => (await tool.execute("call", params, signal, undefined, ctx)).content[0].text };
}

// The plugin side on the same PASEO_HOME, handed the tool's event as the bridge's intake would.
function plugin() {
  const state: IssueState = { id: "issue-1", identifier: "TUC-7", status: "Planning", statusId: "s", statusType: "started", teamId: "t1", projectId: null, creatorId: "owner", labels: [], attachmentUrls: [], blockedBy: [], priority: 0, createdAt: "2026-10-01T00:00:00Z", unblocks: 0 };
  const routes = new SmallRoutes({
    linear: { issueState: async () => state, comment: async () => {}, commentById: async () => null, addLabel: async () => {}, removeLabel: async () => {}, moveToStateNamed: async () => ({ changed: true }) },
    untrusted: async () => false,
    settings: { read: async () => settings },
    tiers: new TierStore(join(root, "linear-tickets", "model-tiers")),
    applyTier: async () => {}, setMode: async () => {}, setLabel: async () => {}, agentGone: async () => false,
    directory: smallRouteDirectory(root),
    requests: join(root, "linear-tickets", "plan-requests"),
  });
  const events = join(root, "linear-tickets", "plannotator", "events");
  const nextEvent = async (): Promise<RouteEvent> => {
    for (;;) {
      const names = (() => { try { return readdirSync(events).filter((name) => name.endsWith(".json") && !name.startsWith(".")); } catch { return []; } })();
      for (const name of names) {
        const parsed = parseEvent(readFileSync(join(events, name), "utf8"));
        rmSync(join(events, name), { force: true });
        if (parsed?.type === "route") return parsed;
      }
      await sleep(20);
    }
  };
  return { routes, nextEvent };
}

test("AC-3: the tool refuses facts that do not qualify without asking the plugin", async () => {
  const h = load();
  assert.match(await h.call({ ...FACTS, migration: "yes" }), /does not qualify.*database migration/);
  assert.match(await h.call({ ...FACTS, acceptanceCriteria: 2, expectedChangedLines: 900 }), /does not qualify/);
  assert.match(await h.call({ ...FACTS, impact: 3, tier: "cheap" }), /cheap tier is not allowed/);
  assert.deepEqual(h.modes, [], "no question to Plannotator, so no event either");
});

test("AC-3: the plugin's acceptance takes the agent out of planning, the route marker written first", async () => {
  const h = load();
  const { routes, nextEvent } = plugin();
  const answer = h.call(FACTS);
  await routes.handle(await nextEvent(), { id: "planner-1", issueId: "issue-1", identifier: "TUC-7", provider: "omp", planPolicy: "required", planDecisionOpen: false });
  assert.match(await answer, /Small-ticket route taken/);
  assert.deepEqual(h.modes, ["status", "exit"]);
  assert.deepEqual(h.entries.map((entry) => entry.customType), ["linear-tickets.small-route"]);
});

test("AC-3: a refusal keeps the agent planning", async () => {
  const h = load();
  const { routes, nextEvent } = plugin();
  const answer = h.call(FACTS);
  await routes.handle(await nextEvent(), { id: "planner-1", issueId: "issue-1", identifier: "TUC-7", provider: "omp", planPolicy: "required", planDecisionOpen: true });
  assert.match(await answer, /did not accept the small-ticket route \(a plan decision/);
  assert.deepEqual(h.modes, ["status"]);
});

test("AC-3: once the tool stops waiting its cancellation stands; the plugin's later answer starts nothing", async () => {
  const h = load();
  const { routes, nextEvent } = plugin();
  const abort = new AbortController();
  const answer = h.call(FACTS, abort.signal);
  const event = await nextEvent();
  abort.abort();
  assert.match(await answer, /did not accept the small-ticket route \(the tool call was aborted\)/);
  // Its own ticket: the acceptance test above left a route record for issue-1 in the shared home.
  await routes.handle(event, { id: "planner-1", issueId: "issue-2", identifier: "TUC-8", provider: "omp", planPolicy: "required", planDecisionOpen: false });
  assert.equal(await routes.get("issue-2"), null);
  assert.deepEqual(h.modes, ["status"]);
});
