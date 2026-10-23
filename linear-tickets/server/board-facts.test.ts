import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { BoardHostFacts } from "../shared/board";
import { AgentDirectory } from "./agent-directory";
import { collectBoardFacts } from "./board-facts";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const hours = (h: number) => ago(h * 60);

type Entry = { item: Record<string, unknown>; timestamp: string };
function factsDirectory(paseo: PaseoApi): AgentDirectory {
  const directory = new AgentDirectory({ liveTtlMs: 0 });
  directory.attach(paseo);
  return directory;
}
function fakePaseo(agents: Partial<PaseoAgent>[], timelines: Record<string, Entry[] | "fail">): PaseoApi {
  return {
    agents: {
      list: async () => ({ requestId: "r", entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (agent: { id: string } | string) => {
        const id = typeof agent === "string" ? agent : agent.id;
        return {
          id,
          timeline: {
            refetch: async () => {
              const entries = timelines[id];
              if (entries === "fail" || !entries) throw new Error("timeline unavailable");
              return { entries, error: null };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
}
function liveAgent(id: string, status: string, labels: Record<string, string>, overrides: Partial<PaseoAgent> = {}): Partial<PaseoAgent> {
  return {
    id, title: `${labels["linear.identifier"] ?? "Helper"}: Do the thing`, status: status as PaseoAgent["status"], labels,
    createdAt: hours(2), updatedAt: ago(3), pendingPermissions: [], archivedAt: null, ...overrides,
  } as Partial<PaseoAgent>;
}
const ticket = (identifier: string) => ({ "linear.issueId": `id-${identifier}`, "linear.identifier": identifier });

async function home(t: TestContext, files: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "board-facts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(content));
  return directory;
}

test("a host's facts come from its ledgers and its live ticket agents", async (t) => {
  const log = Array.from({ length: 12 }, (_, index) => ({ at: hours(40 - index), action: `verify: done (${index})` }));
  log.push({ at: hours(3), action: "start: done" });
  const directory = await home(t, {
    "steward.json": {
      version: 1, flow: { at: ago(1), counts: {}, oldest: null },
      tickets: {
        "id-T-1": {
          identifier: "T-1", situation: "stalled", since: hours(30), restarts: [hours(5)], refusals: [{ at: hours(4), reason: "busy" }],
          escalated: { key: "k", signature: "s", at: hours(1) }, log,
          responsibility: { observedStage: JSON.stringify({ status: ["started", "Planning"], children: [], pulls: [], parentPhase: null }), lastVerifiedAdvancementAt: hours(6) },
        },
        "id-T-2": { identifier: "T-2", situation: "open-pr", since: hours(2), restarts: [], refusals: [], escalated: null, log: [] },
      },
    },
    "responsibility.json": { checkedAt: ago(2), violations: [{ issueId: "id-T-3", identifier: "T-3", url: "u", status: "In Progress", kind: "in-progress-no-agent", detail: "d", since: hours(1) }] },
    "watchdog.json": { version: 1, holds: {}, tickets: { "id-T-1": { identifier: "T-1", starts: [hours(8)], cycle: { stage: "working", kind: "restart" }, exhausted: { at: hours(7) }, reports: [] } } },
    "plan-pipeline.json": {
      version: 1, checkedAt: ago(1), lastArrivalAt: hours(1), cursors: {}, deliveries: {},
      records: [
        { key: "planning:p1", row: { id: "a", agentId: "x", identifier: "T-4", host: "h", stage: "preparing", status: "normal", since: hours(20), lastProgressAt: null, detail: "old" }, history: [{ stage: "preparing", status: "normal", at: hours(2) }] },
        { key: "submit:s1", row: { id: "b", agentId: "x", identifier: "T-4", host: "h", stage: "ready", status: "attention", since: hours(1), lastProgressAt: ago(30), detail: "new" }, history: [{ stage: "ready", status: "normal", at: hours(3) }, { stage: "completed", status: "normal", at: hours(1) }] },
        { key: "review:r1", row: { id: "c", agentId: "y", identifier: "T-5", host: "h", stage: "auto-approved", status: "normal", since: hours(30), lastProgressAt: null, detail: "" }, history: [{ stage: "auto-approved", status: "normal", at: hours(5) }] },
      ],
    },
    "pr-watch.json": {
      "https://github.com/acme/app/pull/7": {
        reviewedAt: null, decision: null, merged: false, drops: ["#1", "#2"], pending: { key: "k", reason: "checks failed in the queue", facts: "", fix: "" }, activeAt: ago(9),
        ci: JSON.stringify([["build", "passed", "success"], ["lint", "failed", "failure"], ["unit", "pending", ""]]),
        actions: [{ id: "a1", at: hours(1), steps: { enqueue: "enqueued" } }, { id: "a2", at: hours(30), steps: { enqueue: "enqueued" } }],
      },
      "https://github.com/acme/app/pull/8": { reviewedAt: null, decision: null, merged: true },
      "https://github.com/acme/app/pull/9": { reviewedAt: null, decision: null, merged: false, closed: true },
    },
  });
  const paseo = fakePaseo([
    liveAgent("a-1", "running", ticket("T-1"), { pendingPermissions: [{ id: "p", provider: "omp", name: "bash", kind: "tool" }] as PaseoAgent["pendingPermissions"] }),
    liveAgent("a-2", "idle", ticket("T-2")),
    liveAgent("child", "running", { ...ticket("T-1"), "paseo.parent-agent-id": "a-1" }),
    liveAgent("gone", "idle", ticket("T-6"), { archivedAt: hours(1) }),
    liveAgent("done", "closed", ticket("T-7")),
    liveAgent("helper", "running", {}),
  ], {
    "a-1": [
      { timestamp: ago(20), item: { type: "todo", items: [{ text: "Read", completed: true, status: "completed" }, { text: "Fix", completed: false, status: "in_progress" }, { text: "Ship", completed: false, status: "pending" }] } },
      { timestamp: ago(15), item: { type: "tool_call", callId: "1", name: "bash", status: "completed", error: null, detail: { type: "shell", command: "npm test" } } },
      { timestamp: ago(14), item: { type: "tool_call", callId: "2", name: "edit", status: "completed", error: null, detail: { type: "unknown", input: null, output: null } } },
      { timestamp: ago(13), item: { type: "tool_call", callId: "3", name: "read", status: "completed", error: null, detail: { type: "unknown", input: null, output: null } } },
      { timestamp: ago(12), item: { type: "assistant_message", text: "Tests pass now; opening the pull request." } },
      { timestamp: ago(11), item: { type: "tool_call", callId: "4", name: "bash", status: "running", error: null, detail: { type: "shell", command: "gh pr create --draft" } } },
    ],
    "a-2": "fail",
  });
  const facts = await collectBoardFacts({ host: "server087", home: directory, paseo: () => paseo, agentDirectory: factsDirectory(paseo), maxRunning: async () => 50, now: () => NOW });

  assert.equal(BoardHostFacts.safeParse(facts).success, true);
  assert.equal(facts.host, "server087");
  assert.equal(facts.collectedAt, NOW.toISOString());
  assert.equal(facts.maxRunning, 50);
  // Every live agent counts (the child and the helper too); archived and closed ones do not.
  assert.deepEqual(facts.agentCounts, { running: 3, idle: 1, initializing: 0, error: 0, permission: 1 });

  assert.deepEqual(facts.agents.map((agent) => [agent.id, agent.identifier, agent.status, agent.permission]), [["a-1", "T-1", "running", true], ["a-2", "T-2", "idle", false]]);
  const inside = facts.agents[0]?.inside;
  assert.ok(inside);
  assert.deepEqual(inside.checklist, { done: 1, total: 3, items: [["Fix", "in_progress"], ["Ship", "pending"]] });
  assert.deepEqual(inside.mix, [["run", 2], ["edit", 1], ["read", 1]]);
  assert.equal(inside.said, "Tests pass now; opening the pull request.");
  assert.ok(inside.recent.length <= 6);
  assert.match(inside.recent.at(-1) ?? "", /gh pr create --draft/);
  assert.equal(facts.agents[1]?.inside, null);

  assert.equal(facts.steward?.at, ago(1));
  const stalled = facts.steward?.tickets.find((entry) => entry.identifier === "T-1");
  assert.deepEqual(stalled && { ...stalled, log: stalled.log.length }, {
    identifier: "T-1", situation: "stalled", since: hours(30), restarts: [hours(5)], refusals: [{ at: hours(4), reason: "busy" }],
    escalatedAt: hours(1), log: 10, status: "Planning", advancedAt: hours(6),
  });
  assert.deepEqual(stalled?.log.at(-1), { at: hours(3), action: "start: done" });
  assert.deepEqual(facts.ownership, { at: ago(2), violations: [{ identifier: "T-3", kind: "in-progress-no-agent" }] });
  assert.deepEqual(facts.watchdog, [{ identifier: "T-1", starts: [hours(8)], cycle: "working", exhaustedAt: hours(7) }]);
  assert.deepEqual(facts.plans, {
    lastArrivalAt: hours(1),
    rows: [
      { identifier: "T-4", stage: "ready", status: "attention", since: hours(1), lastProgressAt: ago(30), detail: "new" },
      { identifier: "T-5", stage: "auto-approved", status: "normal", since: hours(30), lastProgressAt: null, detail: "" },
    ],
  });
  assert.deepEqual(facts.pulls, [{ url: "https://github.com/acme/app/pull/7", failed: ["lint"], running: 1, drops: 2, drop: "checks failed in the queue", activeAt: ago(9) }]);
  assert.deepEqual(facts.flow, { planning: 1, arrived: 1, decided: 2, autoApproved: 1, starts: 1, openedPr: 1, enqueued: 1 });
});

test("a host without ledgers still answers with its agents", async (t) => {
  const directory = await home(t, {});
  const paseo = fakePaseo([liveAgent("a", "error", ticket("T-1"))], { a: [] });
  const facts = await collectBoardFacts({ host: "mbp", home: directory, paseo: () => paseo, agentDirectory: factsDirectory(paseo), maxRunning: async () => null, now: () => NOW });
  assert.equal(facts.steward, null);
  assert.equal(facts.ownership, null);
  assert.deepEqual(facts.watchdog, []);
  assert.deepEqual(facts.plans, { lastArrivalAt: null, rows: [] });
  assert.deepEqual(facts.pulls, []);
  assert.deepEqual(facts.agents.map((agent) => [agent.identifier, agent.status, agent.inside]), [["T-1", "error", { checklist: null, mix: [], recent: [], said: null }]]);
  assert.deepEqual(facts.agentCounts, { running: 0, idle: 0, initializing: 0, error: 1, permission: 0 });
});

test("facts fail loudly without the Paseo daemon", async (t) => {
  const directory = await home(t, {});
  await assert.rejects(collectBoardFacts({ host: "mbp", home: directory, paseo: () => null, agentDirectory: new AgentDirectory(), maxRunning: async () => null, now: () => NOW }));
});
