import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IssueState } from "./linear";
import { TierStore } from "./model-tiers";
import { DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_WORKTREE_SHARDS, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { SmallRoutes, type RouteAgent, type RouteEvent } from "./small-route";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { decisionText, type RouteFacts } from "../shared/small-route";

const ROUTE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const NOW = Date.parse("2026-10-10T08:00:00Z");
const FACTS: RouteFacts = {
  acceptanceCriteria: 1, expectedChangedLines: 40, impact: 1, reversibility: "revert",
  migration: false, auth: false, moneyOrErp: false, crossPackageContract: false, newRule: false, ownerDecisionNeeded: false,
  tier: "cheap", tierReason: "a copy change", reach: "Only the settings page.", reason: "One label text.",
};
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp", launchPreferences: { omp: { model: "omp/opus", modeId: "full" } },
  projectMappings: {}, agentLinearAccess: false,
  dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, status: true }, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};
const AGENT: RouteAgent = { id: "agent-1", issueId: "issue-1", identifier: "TUC-7", provider: "omp", planPolicy: "required", planDecisionOpen: false };

function event(facts: unknown = FACTS, expiresAt = NOW + 60_000): RouteEvent {
  return { type: "route", agentId: "agent-1", routeId: ROUTE, expiresAt: new Date(expiresAt).toISOString(), facts, at: new Date(NOW).toISOString() };
}

type Harness = {
  routes: SmallRoutes; calls: string[]; labels: string[]; comments: Map<string, string>; tiers: TierStore; directory: string;
  clock: { now: number }; fail: Set<string>; gone: Set<string>; owner: { untrusted: boolean };
  decision: () => Promise<Record<string, unknown> | null>; record: () => Promise<Record<string, unknown> | null>;
};

async function harness(run: (h: Harness) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-small-route-"));
  const calls: string[] = [];
  const labels: string[] = [];
  const comments = new Map<string, string>();
  const clock = { now: NOW };
  const fail = new Set<string>();
  const gone = new Set<string>();
  const owner = { untrusted: false };
  const tiers = new TierStore(join(directory, "tiers"), () => new Date(clock.now).toISOString());
  const failing = (name: string) => { if (fail.has(name)) { fail.delete(name); throw new Error(`${name} failed`); } };
  const state = (): IssueState => ({
    id: "issue-1", identifier: "TUC-7", status: "Planning", statusId: "s", statusType: "started", teamId: "t1", projectId: null, creatorId: "owner",
    labels: labels.map((name) => ({ id: name, name })), attachmentUrls: [], blockedBy: [], priority: 0, createdAt: "2026-10-01T00:00:00Z", unblocks: 0,
  });
  const routes = new SmallRoutes({
    linear: {
      issueState: async () => state(),
      comment: async (_issueId, body, id) => { failing("comment"); comments.set(id ?? "none", body); calls.push("comment"); failing("comment-after"); },
      commentById: async (id) => comments.has(id) ? { id } : null,
      addLabel: async (_issueId, name) => { if (!labels.includes(name)) labels.push(name); calls.push(`+${name}`); },
      removeLabel: async (_issueId, name) => { const at = labels.indexOf(name); if (at !== -1) labels.splice(at, 1); calls.push(`-${name}`); },
      moveToStateNamed: async (_issueId, name) => { calls.push(`state ${name}`); return { changed: true }; },
    },
    untrusted: async () => owner.untrusted,
    settings: { read: async () => settings },
    tiers,
    applyTier: async (agentId) => { calls.push(`apply ${agentId}`); },
    setMode: async (agentId, modeId) => { failing("mode"); calls.push(`mode ${agentId} ${modeId}`); },
    setLabel: async (agentId, name, value) => { failing("label"); calls.push(`label ${agentId} ${name}=${value}`); },
    agentGone: async (agentId) => gone.has(agentId),
    directory: join(directory, "small-route"),
    requests: join(directory, "plan-requests"),
    now: () => clock.now,
  });
  const json = async (path: string) => { try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch { return null; } };
  try {
    await run({
      routes, calls, labels, comments, tiers, directory, clock, fail, gone, owner,
      decision: () => json(join(directory, "small-route", "decisions", `${ROUTE}.decision`)),
      record: () => json(join(directory, "small-route", "routes", "issue-1.json")),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("AC-3: an eligible attempt is accepted once, then recorded, switched, commented and labelled in order", async () => {
  await harness(async ({ routes, calls, labels, comments, tiers, decision, record }) => {
    await routes.handle(event(), AGENT);
    assert.equal((await decision())?.decision, "accepted");
    assert.deepEqual(calls, ["mode agent-1 full", "label agent-1 linear.plan=small-route", "state In Progress", "comment", "+no-plan", "+model:cheap", "-model:standard", "-model:strong", "apply agent-1"]);
    assert.deepEqual(labels, ["no-plan", "model:cheap"]);
    assert.equal((await tiers.get("issue-1"))?.tier, "cheap");
    assert.equal((await tiers.get("issue-1"))?.history.at(-1)?.source, "route");
    assert.deepEqual({ routeId: (await record())?.routeId, tier: (await record())?.tier }, { routeId: ROUTE, tier: "cheap" });
    const [body] = [...comments.values()];
    assert.match(body, /Reach: Only the settings page\./);
    assert.match(body, /Add the `plan` label to send the ticket to planning\./);
    // The event comes again (a retried intake): nothing repeats.
    await routes.handle(event(), AGENT);
    assert.equal(calls.filter((call) => call === "comment").length, 1);
  });
});

test("AC-3: the plugin refuses with the reason and does nothing when the ticket or settings no longer allow the route", async () => {
  for (const [name, setup, reason] of [
    ["attended", (h: Harness) => { h.labels.push("paseo-attended"); }, /attended/],
    ["plan label", (h: Harness) => { h.labels.push("plan"); }, /asked for a plan/],
    ["not the owner's", (h: Harness) => { h.owner.untrusted = true; }, /not written by the owner/],
    ["refused facts", () => undefined, /migration/],
  ] as const) {
    await harness(async (h) => {
      setup(h);
      await h.routes.handle(event(name === "refused facts" ? { ...FACTS, migration: true } : FACTS), AGENT);
      const published = await h.decision();
      assert.equal(published?.decision, "refused", name);
      assert.match(String(published?.reason), reason, name);
      assert.deepEqual(h.calls, [], name);
      assert.equal(await h.record(), null, name);
    });
  }
});

test("AC-3: an impact above today's auto-approval threshold, a non-omp agent or an open plan decision is refused", async () => {
  for (const [name, facts, agent] of [
    ["impact", { ...FACTS, impact: 2, tier: "standard" }, AGENT],
    ["claude", FACTS, { ...AGENT, provider: "claude" }],
    ["plan decision", FACTS, { ...AGENT, planDecisionOpen: true }],
  ] as const) {
    await harness(async ({ routes, decision, calls }) => {
      await routes.handle(event(facts), agent);
      assert.equal((await decision())?.decision, "refused", name);
      assert.deepEqual(calls, [], name);
    });
  }
});

test("AC-3: the tool's cancelled decision written first wins; a late plugin never starts the route", async () => {
  await harness(async ({ routes, calls, decision, directory, record }) => {
    await mkdir(join(directory, "small-route", "decisions"), { recursive: true });
    await writeFile(join(directory, "small-route", "decisions", `${ROUTE}.decision`), decisionText({ decision: "cancelled", reason: "the plugin did not answer in time" }, "tool"));
    await routes.handle(event(), AGENT);
    assert.equal((await decision())?.decision, "cancelled");
    assert.equal((await decision())?.by, "tool");
    assert.deepEqual(calls, []);
    assert.equal(await record(), null);
    // Publishing again never replaces the decision that stands.
    assert.equal((await routes.publish(ROUTE, { decision: "accepted" }))?.decision, "cancelled");
  });
});

test("AC-3: an unreadable decision file counts as not accepted", async () => {
  await harness(async ({ routes, calls, directory, record }) => {
    await mkdir(join(directory, "small-route", "decisions"), { recursive: true });
    await writeFile(join(directory, "small-route", "decisions", `${ROUTE}.decision`), "{\"decision\":\"acc");
    await routes.handle(event(), AGENT);
    assert.deepEqual(calls, []);
    assert.equal(await record(), null);
  });
});

test("AC-3: a pending attempt found expired after a restart is cancelled by the plugin and closed", async () => {
  await harness(async ({ routes, calls, clock, decision, directory }) => {
    await mkdir(join(directory, "small-route", "attempts"), { recursive: true });
    await writeFile(join(directory, "small-route", "attempts", `${ROUTE}.json`), JSON.stringify({ routeId: ROUTE, agentId: "agent-1", issueId: "issue-1", identifier: "TUC-7", provider: "omp", facts: FACTS, expiresAt: new Date(NOW + 60_000).toISOString(), state: "pending", steps: {} }));
    await routes.sweep();
    assert.equal(await decision(), null, "the tool still waits");
    clock.now = NOW + 61_000;
    await routes.sweep();
    assert.equal((await decision())?.decision, "cancelled");
    assert.deepEqual(calls, []);
  });
});

test("AC-3: a failed step resumes on the next sweep without repeating earlier steps or the comment", async () => {
  await harness(async ({ routes, calls, fail, comments, labels }) => {
    fail.add("comment-after");
    await assert.rejects(routes.handle(event(), AGENT), /comment-after failed/);
    assert.deepEqual(labels, []);
    await routes.sweep();
    assert.equal(comments.size, 1);
    assert.equal(calls.filter((call) => call.startsWith("mode")).length, 1);
    assert.deepEqual(labels, ["no-plan", "model:cheap"]);
  });
});

test("AC-3: a model:strong label keeps the strong tier; the route never downgrades it", async () => {
  await harness(async ({ routes, labels, tiers }) => {
    labels.push("model:strong");
    await routes.handle(event(), AGENT);
    assert.equal((await tiers.get("issue-1"))?.tier, "strong");
  });
});

test("AC-3: an archived agent does not stop the route; its own steps are skipped", async () => {
  await harness(async ({ routes, fail, gone, labels }) => {
    fail.add("mode");
    gone.add("agent-1");
    await routes.handle(event(), AGENT);
    assert.deepEqual(labels, ["no-plan", "model:cheap"]);
  });
});

test("AC-3: the owner's plan request after the route undoes it: no record, no no-plan, strong tier, planning label", async () => {
  await harness(async ({ routes, calls, labels, tiers, record, clock }) => {
    await routes.handle(event(), AGENT);
    clock.now = NOW + 5_000;
    await routes.ownerRequested("issue-1");
    calls.length = 0;
    await routes.sweep();
    assert.equal(await record(), null);
    assert.ok(!labels.includes("no-plan"));
    assert.equal((await tiers.get("issue-1"))?.tier, "strong");
    assert.ok(calls.includes("label agent-1 linear.plan=required"));
    calls.length = 0;
    await routes.sweep();
    assert.deepEqual(calls, [], "a reverted attempt is never carried out again");
  });
});

test("AC-3: an owner request between steps stops the remaining steps and restores planning", async () => {
  await harness(async ({ routes, calls, labels, fail, record, clock }) => {
    fail.add("comment");
    await assert.rejects(routes.handle(event(), AGENT));
    clock.now = NOW + 5_000;
    await routes.ownerRequested("issue-1");
    await routes.sweep();
    assert.ok(!calls.includes("comment"));
    assert.ok(!labels.includes("no-plan"));
    assert.equal(await record(), null);
  });
});

test("AC-3: an approved plan later removes the route record and no-plan", async () => {
  await harness(async ({ routes, labels, record, calls }) => {
    await routes.handle(event(), AGENT);
    await routes.planApproved("issue-1");
    assert.equal(await record(), null);
    assert.ok(!labels.includes("no-plan"));
    calls.length = 0;
    await routes.sweep();
    assert.deepEqual(calls, [], "the closed attempt has nothing left to undo");
  });
});
