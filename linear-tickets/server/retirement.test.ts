import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { HandoverRecord } from "./handover";
import type { NeedsYouIssue } from "./needs-you";
import { ghostAgents, type ProcessInspector } from "./process-liveness";
import { DoneTickets, RetiredLabels, RetirePass, type RetireDeps, type StackState } from "./retirement";
import type { HostOwnership, SessionLink } from "./sessions";
import { runningTicketAgents } from "./starter";
import type { TicketRoots, WatchdogFile } from "./watchdog";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const IDENTIFIERS: Record<string, string> = { i1: "TUC-1", i2: "TUC-2" };

type Ticket = { status: string; statusType: string; labels: { id: string; name: string }[] };

// One host: the daemon's agents, the tickets in Linear, the plugin's local state, and a RetirePass
// over them. `make()` builds a new plugin instance on the same files (a reload).
function world(t: TestContext) {
  const logs = t.mock.method(console, "log", () => {});
  const clock = { now: Date.parse("2026-10-11T12:00:00.000Z") };
  const ago = (ms: number) => new Date(clock.now - ms).toISOString();
  const agents = new Map<string, PaseoAgent>();
  const tickets: Record<string, Ticket> = {
    i1: { status: "Done", statusType: "completed", labels: [{ id: "l-run", name: "paseo-running" }] },
    i2: { status: "In Progress", statusType: "started", labels: [{ id: "l-run", name: "paseo-running" }] },
  };
  const events: string[] = [];
  const s = {
    owner: "here" as HostOwnership,
    gateBusy: false,
    stack: "settled" as StackState,
    watchdog: { version: 1, tickets: {}, holds: {} } as WatchdogFile,
    records: [] as HandoverRecord[],
    needsYou: [] as NeedsYouIssue[],
    links: {} as Record<string, Partial<SessionLink>>,
    thread: null as Partial<SessionLink> | null,
    // The rpc-ui processes `ps` lists: none, so every agent with a session file is a ghost.
    processes: "",
    hooks: { roots: async () => {}, watchState: async () => {}, debt: async () => {} },
    failures: { archive: null as Error | null, removeLabel: null as Error | null, debt: null as Error | null },
  };
  // `ghost`: the agent has a session file but no process (see ghostAgents); others have no session
  // file and are never ghosts.
  const add = (id: string, options: { quiet?: number; issueId?: string; ghost?: boolean } & Partial<PaseoAgent> = {}) => {
    const { quiet = 61 * MINUTE, issueId = "i1", ghost = false, ...over } = options;
    const agent = {
      id, provider: "omp", cwd: `/wt/${id}`, status: "running", createdAt: ago(48 * HOUR), updatedAt: ago(quiet), lastUserMessageAt: null, pendingPermissions: [], title: id,
      labels: { "linear.issueId": issueId, "linear.identifier": IDENTIFIERS[issueId] }, persistence: ghost ? { provider: "omp", sessionId: id, nativeHandle: `/sessions/${id}.jsonl` } : null, archivedAt: null, ...over,
    } as unknown as PaseoAgent;
    agents.set(id, agent);
    return agent;
  };
  const touch = (id: string, change: Partial<PaseoAgent> = { updatedAt: ago(0) }) => { agents.set(id, { ...agents.get(id)!, ...change }); };
  const inspect: ProcessInspector = { processes: async () => s.processes, cwd: async () => "/nowhere", canonicalPath: async (path) => path };
  const paseo = { agents: {
    ref: (id: string) => ({
      refresh: async () => {
        const agent = agents.get(id);
        if (!agent) throw new Error(`Agent not found: ${id}`);
        return { agent: { ...agent } };
      },
      archive: async () => {
        events.push(`archive ${id}`);
        if (s.failures.archive) throw s.failures.archive;
        agents.set(id, { ...agents.get(id)!, archivedAt: ago(0) });
      },
    }),
    list: async ({ filter }: { filter: { labels?: Record<string, string>; includeArchived?: boolean } }) => ({
      entries: [...agents.values()]
        .filter((agent) => (filter.includeArchived || !agent.archivedAt) && Object.entries(filter.labels ?? {}).every(([key, value]) => agent.labels?.[key] === value))
        .map((agent) => ({ agent })),
      pageInfo: { hasMore: false, nextCursor: null },
    }),
  } } as unknown as PaseoApi;
  const store = new RetiredLabels(join(mkdtempSync(join(tmpdir(), "paseo-retire-")), "retired-labels.json"));
  const doneTickets = new DoneTickets();
  const deps: RetireDeps = {
    sessions: {
      watchdogRoots: async () => {
        const found = new Map<string, TicketRoots>();
        for (const agent of agents.values()) {
          const issueId = agent.labels["linear.issueId"];
          if (agent.archivedAt || agent.labels["paseo.parent-agent-id"]) continue;
          const ticket = found.get(issueId) ?? { issueId, identifier: IDENTIFIERS[issueId], roots: [], ghosts: new Set<string>() };
          ticket.roots.push(agent);
          found.set(issueId, ticket);
        }
        const ghosts = await ghostAgents([...found.values()].flatMap((ticket) => ticket.roots), clock.now, inspect);
        for (const ticket of found.values()) for (const agent of ticket.roots) if (ghosts.has(agent.id)) ticket.ghosts.add(agent.id);
        await s.hooks.roots();
        return found;
      },
      retireTurn: async <T>(issueId: string, work: (paseo: PaseoApi) => Promise<T>) => {
        if (s.gateBusy) return { ran: false as const, reason: "a launch for this ticket is under way" };
        events.push(`turn ${issueId}`);
        return { ran: true as const, value: await work(paseo) };
      },
      sessionFor: async (agentId) => (agentId && s.links[agentId] ? s.links[agentId] : null) as SessionLink | null,
      watchdogThread: async () => s.thread as SessionLink | null,
    },
    linear: {
      issueStatuses: async (ids) => {
        events.push(`statuses ${ids.join(",")}`);
        return new Map(ids.filter((id) => tickets[id]).map((id) => [id, { status: tickets[id].status, statusType: tickets[id].statusType, completedAt: null }]));
      },
      issueWatchState: async (id) => {
        events.push(`watch ${id}`);
        await s.hooks.watchState();
        return { status: tickets[id].status, statusType: tickets[id].statusType, labels: tickets[id].labels };
      },
      issueCore: async (id) => {
        events.push(`core ${id}`);
        if (!tickets[id]) throw new Error("Linear did not return this issue. Check that you have access to it.");
        return { labels: [...tickets[id].labels] } as never;
      },
      removeLabel: async (id, name) => {
        events.push(`-${name} ${id}`);
        if (s.failures.removeLabel) throw s.failures.removeLabel;
        tickets[id].labels = tickets[id].labels.filter((label) => label.name !== name);
      },
    },
    settings: { read: async () => ({ dispatch: { label: "paseo" } }) as never },
    handover: { all: async () => s.records },
    needsYou: { all: async () => s.needsYou },
    watchdog: { read: async () => s.watchdog },
    owner: async () => s.owner,
    doneTickets,
    labels: {
      all: () => store.all(),
      add: async (entry) => {
        events.push(`debt ${entry.agentId}`);
        await s.hooks.debt();
        if (s.failures.debt) throw s.failures.debt;
        await store.add(entry);
      },
      remove: (agentId) => store.remove(agentId),
    },
    inspect,
    now: () => clock.now,
  };
  const make = () => new RetirePass(deps);
  let retire = make();
  // One poll; `states`: the poll's own batch read (absent: it did not come back, so the pass reads).
  const pass = async (states?: Record<string, Ticket>) => {
    events.length = 0;
    await retire.pass({
      states: states ? new Map(Object.entries(states).map(([id, ticket]) => [id, { status: ticket.status, statusType: ticket.statusType, completedAt: null }])) : null,
      sentAt: clock.now - 1_000,
      stack: async () => s.stack,
    });
    return [...events];
  };
  const reload = () => { retire = make(); };
  const debts = async () => (await store.all()).map((entry) => entry.agentId);
  const logged = (pattern: RegExp) => logs.mock.calls.filter((call) => pattern.test(String(call.arguments[0]))).length;
  const archived = (id: string) => Boolean(agents.get(id)?.archivedAt);
  return { s, clock, ago, add, touch, tickets, agents, pass, reload, retire: () => retire, debts, logged, archived, doneTickets, store };
}

const running = (ticket: Ticket) => ticket.labels.some((label) => label.name === "paseo-running");

// --- AC-1: the slot count ------------------------------------------------------------------------

test("an agent of a Done or Canceled ticket quiet for more than an hour frees its slot; at or under the hour, or without a readable time, it counts", async () => {
  const now = Date.now();
  const agent = (id: string, issueId: string, updatedAt: string, extra: Record<string, string> = {}) =>
    ({ id, provider: "claude", status: "running", updatedAt, pendingPermissions: [], labels: { "linear.issueId": issueId, ...extra } }) as unknown as PaseoAgent;
  const at = (ms: number) => new Date(now - ms).toISOString();
  const agents = [
    agent("done-61", "done-61", at(61 * MINUTE)),
    agent("done-59", "done-59", at(59 * MINUTE)),
    // A few seconds inside the hour: the count runs right after this setup.
    agent("done-60", "done-60", at(60 * MINUTE - 5_000)),
    agent("canceled-61", "canceled-61", at(61 * MINUTE)),
    agent("unparsable", "unparsable", "not a time"),
    agent("future", "future", at(-HOUR)),
    agent("unseen", "unseen", at(5 * HOUR)),
    agent("started-61", "started-61", at(61 * MINUTE)),
    agent("child", "child", at(MINUTE), { "paseo.parent-agent-id": "done-61" }),
  ];
  const done = new DoneTickets();
  for (const id of ["done-61", "done-59", "done-60", "unparsable", "future", "child"]) done.read(id, "completed", now);
  done.read("canceled-61", "Canceled", now);
  done.read("started-61", "started", now);
  const paseo = { agents: { list: async () => ({ entries: agents.map((item) => ({ agent: item })), pageInfo: { hasMore: false, nextCursor: null } }) } } as unknown as PaseoApi;
  const counted = await runningTicketAgents(paseo, undefined, (item, time) => done.releases(item, time));
  assert.deepEqual(counted.sort(), ["done-59", "done-60", "future", "started-61", "unparsable", "unseen"]);
  assert.equal((await runningTicketAgents(paseo)).length, 8, "without the registry every root counts, as before");
});

test("the Done-ticket registry: a later stamp wins, a write wins a tie, and only a newer successful read that lacks the ticket forgets it", () => {
  const quiet = { labels: { "linear.issueId": "i1" }, updatedAt: new Date(10 * HOUR - 2 * HOUR).toISOString() };
  const now = 10 * HOUR;
  const done = new DoneTickets();
  done.read("i1", "completed", 100);
  assert.equal(done.releases(quiet, now), true);
  // A failed read or a paused poll observes nothing: the agent stays released.
  done.read("i1", "started", 50);
  assert.equal(done.releases(quiet, now), true, "an older read never overwrites");
  done.missing("i1", 100);
  assert.equal(done.releases(quiet, now), true, "a read as old as the observation does not forget it");
  done.missing("i1", 101);
  assert.equal(done.releases(quiet, now), false, "a newer read without the ticket (deleted, no access) counts it again");
  // A write against reads: a tie goes to the write, a newer read replaces it.
  done.written("i1", "started", 200);
  done.read("i1", "completed", 200);
  assert.equal(done.type("i1"), "started", "the write wins a tie");
  done.missing("i1", 150);
  assert.equal(done.type("i1"), "started", "a read lacking the ticket, older than the write, keeps the write");
  done.read("i1", "completed", 300);
  assert.equal(done.releases(quiet, now), true);
  done.written("i1", "started", 300);
  assert.equal(done.releases(quiet, now), false, "a newer confirmed non-terminal write counts it again");
  done.retain(new Set());
  assert.equal(done.type("i1"), null, "tickets without a candidate agent are forgotten");
});

// --- AC-2: archiving a Done ticket's quiet agent -------------------------------------------------

test("a Done ticket's agent quiet for more than an hour is archived after its label debt is saved; its running label goes one poll later", async (t) => {
  const w = world(t);
  w.add("agent-01");
  const first = await w.pass();
  assert.deepEqual(first.filter((event) => /^(statuses|watch|debt|archive)/.test(event)), ["statuses i1", "watch i1", "debt agent-01", "archive agent-01"], "the debt is on disk before the archive");
  assert.equal(w.logged(/^\[linear-tickets\] TUC-1: archived its quiet agent agent-01 \(ticket Done, quiet 1 h\)$/), 1);
  assert.ok(running(w.tickets.i1), "the label waits for the next poll, after the archive's own write-back");
  assert.deepEqual(await w.debts(), ["agent-01"]);
  const second = await w.pass();
  assert.deepEqual(second.filter((event) => /^(core|-paseo)/.test(event)), ["core i1", "-paseo-running i1"]);
  assert.ok(!running(w.tickets.i1));
  assert.deepEqual(await w.debts(), []);
  assert.deepEqual(await w.pass(), [], "nothing left to do");
});

test("an hour is not enough: 59 and exactly 60 quiet minutes stay; a Canceled ticket's agent goes without a stack check", async (t) => {
  for (const quiet of [59 * MINUTE, 60 * MINUTE]) {
    const w = world(t);
    w.add("agent-01", { quiet });
    await w.pass();
    assert.equal(w.archived("agent-01"), false, `${quiet / MINUTE} minutes`);
  }
  const canceled = world(t);
  canceled.tickets.i1 = { ...canceled.tickets.i1, status: "Canceled", statusType: "canceled" };
  canceled.s.stack = "unknown";
  canceled.add("agent-01");
  await canceled.pass();
  assert.equal(canceled.archived("agent-01"), true);
});

test("a Done ticket's agent waits for its stack: open or unreadable pull requests keep it, logged once", async (t) => {
  const w = world(t);
  w.add("agent-01");
  w.s.stack = "open";
  await w.pass();
  await w.pass();
  assert.equal(w.archived("agent-01"), false);
  assert.equal(w.logged(/TUC-1: its quiet agent agent-01 stays; the ticket's stack has open pull requests/), 1);
  w.s.stack = "unknown";
  await w.pass();
  assert.equal(w.archived("agent-01"), false);
  assert.equal(w.logged(/TUC-1: its quiet agent agent-01 stays; the ticket's open pull requests cannot be read/), 1);
  w.s.stack = "settled";
  await w.pass();
  assert.equal(w.archived("agent-01"), true);
});

test("an agent waiting for the owner is left alone: permission, handover wait, Needs you sub-issue, needs-you label, plan review, owner Stop", async (t) => {
  const names = ["pending permission", "handover wait", "Needs you sub-issue", "needs-you label", "plan review", "parked plan", "owner Stop"];
  for (const name of names) {
    const w = world(t);
    w.add("agent-01");
    const setups: Record<string, () => void> = {
      "pending permission": () => w.touch("agent-01", { pendingPermissions: [{ id: "p" }] as never }),
      "handover wait": () => { w.s.records = [{ issueId: "i1", waiting: { kind: "question" } } as unknown as HandoverRecord]; },
      "Needs you sub-issue": () => { w.s.needsYou = [{ id: "sub", identifier: "TUC-9", parentId: "i1", agentId: "agent-01" }]; },
      "needs-you label": () => { w.tickets.i1.labels.push({ id: "l-ny", name: "paseo-needs-you" }); },
      "plan review": () => { w.s.links["agent-01"] = { review: { localUrl: "http://review" } } as never; },
      "parked plan": () => { w.s.thread = { offer: "parked" }; },
      "owner Stop": () => { w.s.watchdog.holds.i1 = { agentId: "agent-01", at: w.ago(0) }; },
    };
    setups[name]();
    const events = await w.pass();
    assert.equal(w.archived("agent-01"), false, name);
    assert.ok(!events.some((event) => event.startsWith("debt")), `${name}: no label debt`);
  }
});

test("an owner wait, activity or a permission that appears while the prerequisites are read stops the archive", async (t) => {
  const appear: [string, "watchState" | "debt"][] = [["handover wait", "watchState"], ["Needs you sub-issue", "watchState"], ["plan review", "watchState"], ["permission", "watchState"], ["activity", "debt"]];
  for (const [name, when] of appear) {
    const w = world(t);
    w.add("agent-01");
    const changes: Record<string, () => void> = {
      "handover wait": () => { w.s.records = [{ issueId: "i1", waiting: { kind: "question" } } as unknown as HandoverRecord]; },
      "Needs you sub-issue": () => { w.s.needsYou = [{ id: "sub", identifier: "TUC-9", parentId: "i1", agentId: "agent-01" }]; },
      "plan review": () => { w.s.links["agent-01"] = { review: { localUrl: "http://review" } } as never; },
      permission: () => w.touch("agent-01", { pendingPermissions: [{ id: "p" }] as never }),
      activity: () => w.touch("agent-01"),
    };
    w.s.hooks[when] = async () => changes[name]();
    await w.pass();
    assert.equal(w.archived("agent-01"), false, name);
    assert.deepEqual(await w.debts(), ["agent-01"], `${name}: the debt was written before the final look`);
    // The next pass drops the debt of an agent that still exists, and writes no label.
    w.s.hooks[when] = async () => {};
    w.clock.now += 2 * MINUTE;
    const next = await w.pass();
    assert.deepEqual(await w.debts(), [], name);
    assert.ok(!next.some((event) => event.startsWith("-paseo")), `${name}: no label write`);
    assert.ok(running(w.tickets.i1));
  }
  // The plugin unloads while the ticket's state is read: nothing goes out.
  const w = world(t);
  w.add("agent-01");
  w.s.hooks.watchState = async () => w.retire().stop();
  const events = await w.pass();
  assert.equal(w.archived("agent-01"), false);
  assert.ok(!events.some((event) => event.startsWith("debt")));
});

test("a ticket found open on the fresh read is not archived and its agent counts again", async (t) => {
  const w = world(t);
  const agent = w.add("agent-01");
  // The poll's batch read is older than the ticket's reopen.
  w.tickets.i1 = { ...w.tickets.i1, status: "In Progress", statusType: "started" };
  await w.pass({ i1: { status: "Done", statusType: "completed", labels: [] } });
  assert.equal(w.archived("agent-01"), false);
  assert.equal(w.doneTickets.type("i1"), "started");
  assert.equal(w.doneTickets.releases(agent, w.clock.now), false);
});

test("a failed label debt write or archive is logged and retried on the next poll", async (t) => {
  const w = world(t);
  w.add("agent-01");
  w.s.failures.debt = new Error("disk full");
  const first = await w.pass();
  assert.ok(!first.includes("archive agent-01"), "no archive without its debt");
  assert.equal(w.logged(/TUC-1: archiving its quiet agent agent-01 failed: disk full; the next poll retries/), 1);
  w.s.failures.debt = null;
  w.s.failures.archive = new Error("daemon unavailable");
  await w.pass();
  await w.pass();
  assert.equal(w.archived("agent-01"), false);
  assert.equal(w.logged(/TUC-1: archiving its quiet agent agent-01 failed: daemon unavailable; the next poll retries/), 1, "logged once");
  w.s.failures.archive = null;
  const last = await w.pass();
  assert.equal(w.archived("agent-01"), true, "judged again from scratch");
  assert.ok(!last.includes("-paseo-running i1"), "the failed attempts' debt was dropped, the new one waits a poll");
  assert.deepEqual(await w.debts(), ["agent-01"]);
});

test("a failed label removal is logged once and retried, also after a reload; a stopped sibling does not keep the label, a launch holding the gate defers it", async (t) => {
  const w = world(t);
  w.add("agent-01");
  w.add("agent-02", { status: "closed", quiet: 10 * MINUTE });
  await w.pass();
  assert.equal(w.archived("agent-01"), true);
  w.s.failures.removeLabel = new Error("Linear is unavailable");
  await w.pass();
  await w.pass();
  assert.equal(w.logged(/TUC-1: removing the running label after archiving agent agent-01 failed: Linear is unavailable; the next poll retries/), 1);
  w.s.failures.removeLabel = null;
  w.reload();
  w.s.gateBusy = true;
  const deferred = await w.pass();
  assert.ok(!deferred.some((event) => event.startsWith("core")), "nothing read or written while a launch holds the gate");
  assert.deepEqual(await w.debts(), ["agent-01"]);
  w.s.gateBusy = false;
  await w.pass();
  assert.ok(!running(w.tickets.i1));
  assert.deepEqual(await w.debts(), []);
});

test("a second working root keeps the label until it is archived too; a label the archive's write-back removed is not written again", async (t) => {
  const w = world(t);
  w.add("agent-01");
  w.add("agent-02", { quiet: 30 * MINUTE });
  await w.pass();
  assert.equal(w.archived("agent-01"), true);
  assert.equal(w.archived("agent-02"), false);
  w.clock.now += 2 * MINUTE;
  const kept = await w.pass();
  assert.ok(!kept.some((event) => event.startsWith("core") || event.startsWith("-paseo")), "the working root keeps it");
  assert.deepEqual(await w.debts(), []);
  w.clock.now += 30 * MINUTE;
  await w.pass();
  assert.equal(w.archived("agent-02"), true);
  // Writeback.archived got there first.
  w.tickets.i1.labels = [];
  const after = await w.pass();
  assert.ok(after.includes("core i1"));
  assert.ok(!after.some((event) => event.startsWith("-paseo")), "no second removal");
  assert.deepEqual(await w.debts(), []);
});

test("a candidate left alone for an owner wait is judged again only after 15 minutes", async (t) => {
  const w = world(t);
  w.add("agent-01");
  w.s.records = [{ issueId: "i1", waiting: { kind: "question" } } as unknown as HandoverRecord];
  assert.ok((await w.pass()).includes("turn i1"));
  w.clock.now += 2 * MINUTE;
  assert.ok(!(await w.pass()).includes("turn i1"), "within the cool-down");
  w.clock.now += 14 * MINUTE;
  w.s.records = [];
  await w.pass();
  assert.equal(w.archived("agent-01"), true);
});

// --- AC-3: ghosts quiet for more than a day ------------------------------------------------------

test("a ghost whose process is back by the time it is archived stays", async (t) => {
  const w = world(t);
  w.add("ghost-01", { issueId: "i2", ghost: true, quiet: 25 * HOUR });
  w.s.hooks.roots = async () => { w.s.processes = "4242 omp --mode rpc-ui --session /sessions/ghost-01.jsonl"; };
  await w.pass();
  assert.equal(w.archived("ghost-01"), false);
  assert.equal(w.logged(/TUC-2: its ghost ghost-01 is not archived: the agent's process runs again/), 1);
});

test("a ghost quiet for more than a day is archived whatever its ticket's state; at a day or under it stays", async (t) => {
  const w = world(t);
  w.add("ghost-01", { issueId: "i2", ghost: true, quiet: 24 * HOUR + MINUTE });
  w.add("ghost-02", { issueId: "i2", ghost: true, quiet: 24 * HOUR, status: "idle" });
  w.add("ghost-03", { issueId: "i2", ghost: true, quiet: 24 * HOUR - MINUTE });
  await w.pass();
  assert.equal(w.archived("ghost-01"), true);
  assert.equal(w.archived("ghost-02"), false, "exactly a day");
  assert.equal(w.archived("ghost-03"), false);
  assert.equal(w.logged(/^\[linear-tickets\] TUC-2: archived its ghost ghost-01 \(quiet 24 h\)$/), 1);
});

test("a ghost is left alone while the owner is asked or the watchdog recovers its ticket; with a live successor it goes and the label stays", async (t) => {
  for (const name of ["Needs input", "needs-you label", "watchdog cycle"]) {
    const w = world(t);
    w.add("ghost-01", { issueId: "i2", ghost: true, quiet: 25 * HOUR });
    const setups: Record<string, () => void> = {
      "Needs input": () => { w.tickets.i2.status = "Needs input"; },
      "needs-you label": () => { w.tickets.i2.labels.push({ id: "l-ny", name: "paseo-needs-you" }); },
      "watchdog cycle": () => { w.s.watchdog.tickets.i2 = { identifier: "TUC-2", starts: [], cycle: { id: "c" } as never, exhausted: null }; },
    };
    setups[name]();
    await w.pass();
    assert.equal(w.archived("ghost-01"), false, name);
  }
  const w = world(t);
  w.add("ghost-01", { issueId: "i2", ghost: true, quiet: 25 * HOUR });
  w.add("agent-02", { issueId: "i2", quiet: MINUTE });
  await w.pass();
  assert.equal(w.archived("ghost-01"), true);
  const next = await w.pass();
  assert.ok(!next.some((event) => event.startsWith("-paseo")));
  assert.ok(running(w.tickets.i2), "the successor keeps the running label");
  assert.deepEqual(await w.debts(), []);
});

// --- AC-6: the other host's tickets --------------------------------------------------------------

test("a ticket the other host works on, or whose host cannot be told, is left alone, logged once", async (t) => {
  for (const owner of ["elsewhere", "unknown"] as const) {
    const w = world(t);
    w.add("agent-01");
    w.s.owner = owner;
    await w.pass();
    const second = await w.pass();
    assert.equal(w.archived("agent-01"), false, owner);
    assert.ok(!second.some((event) => event.startsWith("debt")), owner);
    assert.equal(w.logged(/TUC-1: its quiet agent agent-01 is not archived: (the other host works on the ticket|which host works on the ticket cannot be told right now)$/), 1, owner);
  }
  // The ticket moves to the other host while its state is read.
  const moved = world(t);
  moved.add("agent-01");
  moved.s.hooks.watchState = async () => { moved.s.owner = "elsewhere"; };
  await moved.pass();
  assert.equal(moved.archived("agent-01"), false);
});

test("the label step leaves the other host's label alone and waits while the host cannot be told", async (t) => {
  const w = world(t);
  w.add("agent-01");
  await w.pass();
  w.s.owner = "unknown";
  assert.ok(!(await w.pass()).some((event) => event.startsWith("core")));
  assert.deepEqual(await w.debts(), ["agent-01"], "kept");
  w.s.owner = "elsewhere";
  assert.ok(!(await w.pass()).some((event) => event.startsWith("core")));
  assert.deepEqual(await w.debts(), [], "dropped: the label is the other host's");
  assert.ok(running(w.tickets.i1));
});
