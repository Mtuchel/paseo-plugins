import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Focus, FOCUS_REASON } from "./focus";
import type { FocusNode } from "./linear";
import { DEFAULT_DISPATCH, type PluginSettings } from "./settings";
import { TicketStarter } from "./starter";

// Focus mode (focus.ts) against a fake Linear and a fake daemon: what the seed takes as in
// flight, what the walk adds below it, what admission lets start, and the status it reports.

const settings = { dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["TUC"] } } as PluginSettings;
type Agent = { id: string; status: string; issueId: string; waiting?: boolean; subagent?: boolean };

function node(id: string, change: Partial<FocusNode> = {}): FocusNode {
  return { id, identifier: `TUC-${id}`, title: `Ticket ${id}`, url: `https://linear.app/t/${id}`, status: "Todo", statusType: "unstarted", delegateId: null, labels: [], finished: false, agentLinked: false, children: [], blockers: [], ...change };
}

async function world(t: TestContext, tickets: FocusNode[], agents: Agent[], queueBlockers: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "focus-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodes = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  let clock = Date.parse("2026-10-09T12:00:00Z");
  let failing = false;
  const statusLabels = new Set(["paseo-running", "paseo-needs-you", "paseo-blocked", "paseo-failed"]);
  const open = (ticket: FocusNode) => !["completed", "canceled"].includes(ticket.statusType);
  const linear = {
    trustedAppIds: async () => ["app"],
    focusTickets: async (ids: string[]) => {
      if (failing) throw new Error("Linear is unreachable");
      return ids.flatMap((id) => nodes.get(id) ?? []);
    },
    focusSeed: async () => ({
      labelled: [...nodes.values()].filter((ticket) => open(ticket) && ticket.labels.some((name) => statusLabels.has(name))),
      started: [...nodes.values()].filter((ticket) => ticket.statusType === "started"),
    }),
    focusQueueBlockers: async () => {
      if (failing) throw new Error("Linear is unreachable");
      return queueBlockers.flatMap((id) => nodes.get(id) ?? []);
    },
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: agents.map((agent) => ({ agent: { id: agent.id, status: agent.status, labels: { "linear.issueId": agent.issueId, ...(agent.subagent ? { "paseo.parent-agent-id": "p" } : {}) }, pendingPermissions: agent.waiting ? [{ id: "q" }] : [] } })),
        pageInfo: { hasMore: false },
      }),
    },
  } as unknown as PaseoApi;
  const path = join(directory, "focus.json");
  const make = () => new Focus({ linear, settings: { read: async () => settings }, path, now: () => clock });
  return {
    focus: make(), make, paseo, nodes,
    advance: (ms: number) => { clock += ms; },
    fail: (value: boolean) => { failing = value; },
  };
}

test("turning focus on takes the tickets with work under way, but not an approved plan no agent implements yet", async (t) => {
  const w = await world(t, [
    node("labelled", { labels: ["paseo-needs-you"] }),
    node("delegated", { statusType: "started", status: "In Review", delegateId: "app" }),
    node("linked", { statusType: "started", status: "In Progress", agentLinked: true }),
    node("human", { statusType: "started", status: "In Progress", delegateId: "someone" }),
    node("agent", { status: "Todo" }),
    node("parked", { labels: ["plan-ready"] }),
    node("implementing", { labels: ["plan-ready"] }),
    node("fresh"),
  ], [
    { id: "a1", status: "idle", issueId: "agent" },
    { id: "a2", status: "closed", issueId: "parked" },
    { id: "a3", status: "running", issueId: "implementing" },
    { id: "a4", status: "running", issueId: "fresh", subagent: true },
  ]);
  const status = await w.focus.enable(w.paseo);
  assert.equal(status.active, true);
  assert.deepEqual(status.tickets.map((ticket) => ticket.id).sort(), ["agent", "delegated", "implementing", "labelled", "linked"]);
  assert.ok(status.tickets.every((ticket) => ticket.reason === "in-flight"));
  for (const id of ["human", "parked", "fresh"]) assert.equal(await w.focus.admits(id, w.paseo), FOCUS_REASON, id);
  assert.equal(await w.focus.admits("implementing", w.paseo), null);
});

test("sub-issues and blockers of tickets in focus start, down the chain and as they appear; nothing else does", async (t) => {
  const w = await world(t, [
    node("root", { statusType: "started", status: "In Progress", delegateId: "app", children: ["child"], blockers: [{ id: "blocker", identifier: "TUC-blocker" }] }),
    node("child", { blockers: [{ id: "deep", identifier: "TUC-deep" }] }),
    node("blocker"),
    node("deep"),
    node("qb", { title: "Queue blocker: lint" }),
    node("done", { statusType: "completed", status: "Done", delegateId: "app", children: [] }),
    node("other"),
  ], [], ["qb"]);
  await w.focus.enable(w.paseo);
  for (const id of ["root", "child", "blocker", "deep", "qb"]) assert.equal(await w.focus.admits(id, w.paseo), null, id);
  assert.equal(await w.focus.admits("other", w.paseo), FOCUS_REASON);

  // A split plan adds a sub-issue while focus is on: it joins at the next read.
  w.nodes.set("root", { ...w.nodes.get("root")!, children: ["child", "split"] });
  w.nodes.set("split", node("split"));
  w.advance(4 * 60_000);
  assert.equal(await w.focus.admits("split", w.paseo), FOCUS_REASON, "not before the set is read again, at most every 5 minutes");
  w.advance(60_000 + 1);
  assert.equal(await w.focus.admits("split", w.paseo), null);
  const reasons = Object.fromEntries((await w.focus.status(w.paseo)).tickets.map((ticket) => [ticket.id, ticket.reason]));
  assert.deepEqual(reasons, { root: "in-flight", qb: "queue-blocker", child: "sub-issue", blocker: "blocker", split: "sub-issue", deep: "blocker" });
});

test("while Linear cannot be read, the last set read decides, and before any read the roots alone start", async (t) => {
  const w = await world(t, [
    node("root", { statusType: "started", delegateId: "app", children: ["child"] }),
    node("child"),
  ], []);
  await w.focus.enable(w.paseo);
  w.fail(true);
  w.advance(5 * 60_000 + 1);
  assert.equal(await w.focus.admits("child", w.paseo), null, "the last set read");
  const status = await w.focus.status(w.paseo);
  assert.match(status.error ?? "", /unreachable/);
  assert.equal(status.complete, false);

  const reloaded = w.make();
  assert.equal(await reloaded.admits("root", w.paseo), null, "a root needs no read");
  assert.equal(await reloaded.admits("child", w.paseo), FOCUS_REASON, "nothing read yet: only the roots");
  w.fail(false);
  assert.equal(await reloaded.admits("child", w.paseo), null);
});

test("the status says what each ticket waits for, and focus is complete once all are in review or done", async (t) => {
  const w = await world(t, [
    node("working", { statusType: "started", status: "In Progress", delegateId: "app" }),
    node("asking", { statusType: "started", status: "In Progress", delegateId: "app" }),
    node("review", { statusType: "started", status: "In Review", delegateId: "app" }),
    node("merged", { statusType: "started", status: "In Review", delegateId: "app", finished: true }),
    node("blocked", { statusType: "started", status: "In Progress", delegateId: "app", blockers: [{ id: "review", identifier: "TUC-review" }, { id: "merged", identifier: "TUC-merged" }] }),
    node("plan", { statusType: "started", status: "Plan review", delegateId: "app" }),
  ], [
    { id: "a1", status: "running", issueId: "working" },
    { id: "a2", status: "running", issueId: "asking", waiting: true },
  ]);
  const status = await w.focus.enable(w.paseo);
  const phases = Object.fromEntries(status.tickets.map((ticket) => [ticket.id, ticket.phase]));
  assert.deepEqual(phases, { working: "working", asking: "needs-you", review: "review", merged: "done", blocked: "waiting", plan: "needs-you" }, "a plan review waits for you, it is no code review");
  assert.deepEqual(status.tickets.find((ticket) => ticket.id === "blocked")?.waitingOn, ["TUC-review"], "a merged blocker is finished");
  assert.deepEqual({ left: status.left, complete: status.complete }, { left: 4, complete: false });

  for (const id of ["working", "asking", "blocked", "plan"]) w.nodes.set(id, { ...w.nodes.get(id)!, status: "In Review" });
  w.advance(5 * 60_000 + 1);
  const later = await w.make().status({ agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi);
  assert.deepEqual({ left: later.left, complete: later.complete }, { left: 0, complete: true });
});

test("a ticket started by hand joins focus; turning focus off lets everything start again", async (t) => {
  const w = await world(t, [node("root", { statusType: "started", delegateId: "app" }), node("manual")], []);
  await w.focus.include("manual", "TUC-manual");
  await w.focus.enable(w.paseo);
  assert.equal(await w.focus.admits("manual", w.paseo), FOCUS_REASON, "an include while focus is off is not kept");
  await w.focus.include("manual", "TUC-manual");
  assert.equal(await w.make().admits("manual", w.paseo), null, "kept across a reload");
  const off = await w.focus.disable();
  assert.deepEqual({ active: off.active, tickets: off.tickets }, { active: false, tickets: [] });
  assert.equal(await w.make().admits("anything", w.paseo), null);
});

test("ticket admission refuses a ticket outside focus before it reads Linear", async (t) => {
  const w = await world(t, [node("root", { statusType: "started", delegateId: "app" })], []);
  await w.focus.enable(w.paseo);
  let reads = 0;
  const starter = new TicketStarter({
    linear: {
      detail: async () => { throw new Error("not used"); },
      issueState: async (id: string) => { reads += 1; return { id, identifier: "TUC-1", status: "Todo", statusId: "todo", statusType: "unstarted", teamId: null, projectId: null, creatorId: null, labels: [], attachmentUrls: [], blockedBy: [], priority: 0, createdAt: "", unblocks: 0 }; },
      viewerId: async () => "owner",
      trustedAppIds: async () => [],
      issueDocument: async () => null,
    },
    launcher: { start: async () => { throw new Error("not used"); } },
    focus: w.focus,
  });
  assert.deepEqual(await starter.admission("other", w.paseo, settings), { ok: false, reason: FOCUS_REASON });
  assert.equal(reads, 0);
  assert.deepEqual(await starter.admission("root", w.paseo, settings), { ok: true });
});
