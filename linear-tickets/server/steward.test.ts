import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  calendarDate, classifyTicket, DoneTickets, isDefect, parseVerdict, Steward, StewardStateError, StewardStore, STEWARD_ACTION, STEWARD_SITUATIONS, STEWARD_STATES,
  RESTART_CAP, type StewardFacts, type StewardSituation,
} from "./steward";

// The classifier's own tests: every fact set lands on exactly one situation, and the precedence
// between them is pinned here (steward.ts's order is what runs).

const T0 = Date.parse("2026-10-13T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString();
const pull = (url: string, over: Partial<{ merged: boolean; closed: boolean; missing: boolean; decision: string | null; replay: "due" | "asked" | null }> = {}) =>
  ({ url, merged: false, closed: false, missing: false, decision: null, replay: null, ...over });

// A ticket in the steward's most ordinary state: an open In Progress ticket with a live, working
// agent and nothing else. Every test changes only what it is about.
function facts(over: Partial<StewardFacts> = {}): StewardFacts {
  return {
    identifier: "TUC-1", status: "In Progress", statusType: "started", terminal: false,
    children: { total: 0, open: 0, complete: true }, deliberate: null, groupLinked: false, parked: false, blocker: null,
    live: true, idleMinutes: null, idleThreshold: 30, ownerWait: "none", resumed: false,
    queuedThread: false, queuedAt: null, queuedSince: null, queuedTooLong: false, queuedHours: 24,
    openPulls: [], landedPulls: [], closedPulls: [], beforeMerge: 0,
    started: true, startable: true, restarts: 0, refusals: 0, lastRefusal: null,
    watchdog: "none", verifier: false, verified: null, landedSignature: "", escalated: null,
    ...over,
  };
}

test("every situation has exactly one action and a state flag, and no other situation exists", () => {
  assert.equal(new Set(STEWARD_SITUATIONS).size, STEWARD_SITUATIONS.length, "no duplicate situation");
  for (const situation of STEWARD_SITUATIONS) {
    assert.ok(situation in STEWARD_ACTION, `${situation} has an action entry`);
    assert.equal(typeof STEWARD_STATES[situation], "boolean", `${situation} has a state flag`);
  }
  assert.equal(Object.keys(STEWARD_ACTION).length, STEWARD_SITUATIONS.length, "no stray action entry");
  assert.equal(Object.keys(STEWARD_STATES).length, STEWARD_SITUATIONS.length, "no stray state entry");
  // The five states of the invariant: everything else is a defect the pass repairs.
  const states = STEWARD_SITUATIONS.filter((situation) => STEWARD_STATES[situation]);
  assert.deepEqual(states, ["moving", "waiting-owner", "waiting-blocker", "queued", "parked"]);
  for (const situation of STEWARD_SITUATIONS) {
    assert.equal(isDefect(situation), situation !== "closed" && !STEWARD_STATES[situation], `${situation}: a defect is a ticket in no state`);
    // A ticket in one of the five states needs no repair: it has no action at all.
    if (STEWARD_STATES[situation]) assert.equal(STEWARD_ACTION[situation], null, `${situation} needs no repair`);
  }
  // Every defect but a ticket a verifier is already judging has an action: the pass repairs it.
  for (const situation of STEWARD_SITUATIONS.filter(isDefect)) {
    if (situation !== "verifying") assert.notEqual(STEWARD_ACTION[situation], null, `${situation} is repaired`);
  }
});

test("the ordinary tickets of each state classify as that state", () => {
  assert.equal(classifyTicket(facts()), "moving", "a live agent that is working");
  assert.equal(classifyTicket(facts({ live: false, ownerWait: "live" })), "waiting-owner", "a recorded wait nothing must end");
  assert.equal(classifyTicket(facts({ live: false, blocker: "TUC-9" })), "waiting-blocker", "an unfinished blocker");
  assert.equal(classifyTicket(facts({ live: false, parked: true })), "parked", "a verifier's park");
  assert.equal(classifyTicket(facts({ live: false, started: false, startable: false, queuedThread: true, queuedSince: at(30) })), "queued", "a thread in the wait line");
});

test("a finished ticket beats every other fact, and its live agents are archived", () => {
  const busy = facts({ terminal: true, live: true, openPulls: [pull("https://github.com/o/r/pull/1")], children: { total: 2, open: 1, complete: true } });
  assert.equal(classifyTicket(busy), "terminal-agents", "a Done ticket with live agents");
  assert.equal(classifyTicket(facts({ terminal: true, live: false })), "closed", "a Done ticket with none");
  // A verifier's claim, a stale wait and a watchdog cycle are all beaten by a terminal state.
  assert.equal(classifyTicket(facts({ terminal: true, live: false, verifier: true, ownerWait: "stale", watchdog: "exhausted" })), "closed");
});

test("deliberate waits are states, not defects: no recovery reaches them", () => {
  for (const deliberate of ["hold", "manual", "do-not-merge", "plan-review", "stopped", "permissions", "needs-you"] as const) {
    assert.equal(classifyTicket(facts({ live: false, deliberate })), "waiting-owner", `${deliberate} without an agent`);
    // Every other fact a recovery would act on is present too: the deliberate wait still wins.
    const loaded = facts({
      live: true, deliberate, idleMinutes: 90, openPulls: [pull("https://github.com/o/r/pull/2")],
      landedPulls: [pull("https://github.com/o/r/pull/1", { merged: true })], children: { total: 2, open: 0, complete: true },
    });
    assert.equal(classifyTicket(loaded), "waiting-owner", `${deliberate} beats live agents, idle roots, pull requests and finished children`);
    assert.equal(STEWARD_ACTION[STEWARD_ACTION[classifyTicket(loaded)] ? classifyTicket(loaded) : "parked"], null, `${deliberate} is not acted on`);
  }
  // Focus mode and a thread the peer host owns are queue waits: they start when their turn comes.
  assert.equal(classifyTicket(facts({ live: false, deliberate: "focus" })), "queued");
  assert.equal(classifyTicket(facts({ live: false, deliberate: "remote" })), "queued");
});

test("an open pull request beats a landed one, whatever the landed set looks like", () => {
  const landed = [pull("https://github.com/o/r/pull/1", { merged: true })];
  assert.equal(classifyTicket(facts({ live: false, openPulls: [pull("https://github.com/o/r/pull/2")], landedPulls: landed, closedPulls: [] })), "open-pr");
  assert.equal(classifyTicket(facts({ live: false, landedPulls: landed, closedPulls: [pull("https://github.com/o/r/pull/3", { closed: true })] })), "landed", "landed work with nothing open");
});

test("a landed stack whose before-merge manual task is still open is not verified yet", () => {
  const landed = [pull("https://github.com/o/r/pull/1", { merged: true })];
  // The open before-merge task holds the ready state back: the ticket's work is not done, so no
  // verifier starts over it (facts.beforeMerge). The manual task's own path asks the owner for the
  // step; the ticket itself is a ticket without an agent and without an open pull request.
  const situation = classifyTicket(facts({ live: false, landedPulls: landed, beforeMerge: 1 }));
  assert.notEqual(situation, "landed", "no verifier over a stack whose merge is held back");
  assert.equal(situation, "stalled", "the ticket still has work: its agent is restarted");
  assert.equal(STEWARD_ACTION[situation], "restart");
  assert.equal(classifyTicket(facts({ live: false, landedPulls: landed, beforeMerge: 0 })), "landed", "the task done: the landed stack is verified");
});

test("a landed stack already verified once escalates instead of verifying again", () => {
  const landed = [pull("https://github.com/o/r/pull/1", { merged: true })];
  const verified = facts({ live: false, landedPulls: landed, landedSignature: "sig-1", verified: "sig-1" });
  assert.equal(classifyTicket(verified), "escalated", "the same landed set twice is not verified twice");
  assert.equal(classifyTicket({ ...verified, landedSignature: "sig-2" }), "landed", "new landed work is verified again");
});

test("a claimed verifier beats the landed facts it is judging, and the ticket's silence", () => {
  assert.equal(classifyTicket(facts({ live: false, verifier: true, landedPulls: [pull("https://github.com/o/r/pull/1", { merged: true })] })), "verifying");
  assert.equal(classifyTicket(facts({ verifier: true })), "verifying", "a live agent too: one verifier per ticket");
});

test("a closed-unmerged pull request is replayed once, then left to the owner", () => {
  const closed = [pull("https://github.com/o/r/pull/1", { closed: true, replay: "due" })];
  assert.equal(classifyTicket(facts({ live: false, closedPulls: closed })), "closed-unmerged");
  assert.equal(classifyTicket(facts({ live: false, closedPulls: [{ ...closed[0], replay: "asked" }] })), "escalated", "already asked to replay");
  assert.equal(classifyTicket(facts({ live: false, closedPulls: [{ ...closed[0], replay: null }] })), "closed-unmerged", "never looked at");
});

test("a stale owner wait is repaired, a live one is a state", () => {
  assert.equal(classifyTicket(facts({ live: true, ownerWait: "live" })), "waiting-owner", "even with a live agent");
  assert.equal(classifyTicket(facts({ live: false, ownerWait: "stale" })), "wait-stale");
  assert.equal(STEWARD_ACTION["wait-stale"], "clear-wait", "the stale wait is cleared, not commented on");
});

test("a recovering watchdog cycle counts as moving; its exhaustion is a defect", () => {
  assert.equal(classifyTicket(facts({ live: false, watchdog: "active" })), "moving", "the watchdog is already recovering it");
  const exhausted = classifyTicket(facts({ live: false, watchdog: "exhausted" }));
  assert.equal(exhausted, "watchdog-exhausted");
  assert.equal(STEWARD_ACTION[exhausted], "escalate", "its terminal step is the owner, not a mention");
});

test("an idle agent is resumed once (past the configured threshold), then judged by a verifier", () => {
  assert.equal(classifyTicket(facts({ idleMinutes: 20 })), "moving", "quieter than steward.idleMinutes is still moving");
  assert.equal(classifyTicket(facts({ idleMinutes: 45 })), "idle");
  assert.equal(classifyTicket(facts({ idleMinutes: 45, idleThreshold: 120 })), "moving", "the threshold is the settings', not a constant");
  assert.equal(classifyTicket(facts({ idleMinutes: 45, resumed: true })), "idle-unresponsive");
  // An idle agent with an open pull request is still moving: the pull request's own watch nudges it.
  assert.equal(classifyTicket(facts({ idleMinutes: 45, openPulls: [pull("https://github.com/o/r/pull/1")] })), "moving");
});

test("the budgets cap restarts and refusals before any successor branch is picked", () => {
  const open = [pull("https://github.com/o/r/pull/1")];
  assert.equal(classifyTicket(facts({ live: false, restarts: RESTART_CAP - 1 })), "stalled");
  assert.equal(classifyTicket(facts({ live: false, restarts: RESTART_CAP })), "restart-exhausted");
  // The spent budget is checked before the pull-request branch, so a successor cannot be started
  // around it, however quickly the agents it started vanish again.
  assert.equal(classifyTicket(facts({ live: false, restarts: RESTART_CAP, openPulls: open })), "restart-exhausted");
  assert.equal(classifyTicket(facts({ live: false, restarts: RESTART_CAP, closedPulls: [pull("https://github.com/o/r/pull/2", { closed: true, replay: "due" })] })), "restart-exhausted");
  assert.equal(classifyTicket(facts({ live: false, restarts: 0, refusals: 3, lastRefusal: "the launcher refused" })), "refused");
  // A refusal on a ticket that may not start now either: refused, not unstarted.
  assert.equal(classifyTicket(facts({ live: false, started: false, startable: false, refusals: 1 })), "refused");
  // An unstarted ticket that may not start, for no recorded reason, is the steward's own defect.
  assert.equal(classifyTicket(facts({ live: false, started: false, startable: false })), "escalated");
});

test("a thread that waited longer than steward.queuedEscalateHours reaches the owner", () => {
  const queued = facts({ live: false, started: false, startable: false, queuedThread: true });
  assert.equal(classifyTicket({ ...queued, queuedSince: at(23 * 60), queuedTooLong: false }), "queued", "inside the deadline it waits");
  const expired = classifyTicket({ ...queued, queuedSince: at(25 * 60), queuedTooLong: true });
  assert.equal(expired, "queued-too-long");
  assert.equal(STEWARD_ACTION[expired], "escalate", "the expired queue is put in front of the owner");
});

test("a parent is judged like any ticket while a sub-issue is open, and never closed directly", () => {
  const open = [pull("https://github.com/o/r/pull/1")];
  const partial = facts({ children: { total: 2, open: 1, complete: true }, live: false, openPulls: open });
  assert.equal(classifyTicket(partial), "open-pr", "the parent is judged like any ticket while a sub-issue is open");
  // All children finished: the parent's own work comes first (live agent, owner, blocker, pull
  // requests), and what is left over goes to a verifier — never to a straight completion.
  const done = facts({ children: { total: 2, open: 0, complete: true }, live: false });
  assert.equal(classifyTicket(done), "landed", "a finished parent without its own open work is verified");
  assert.equal(classifyTicket({ ...done, openPulls: open }), "open-pr", "its own open pull request is a successor's job");
  assert.equal(classifyTicket({ ...done, live: true }), "moving", "a live agent on the parent keeps working");
  assert.equal(classifyTicket({ ...done, blocker: "TUC-9" }), "waiting-blocker");
  assert.equal(classifyTicket({ ...done, ownerWait: "live" }), "waiting-owner");
  assert.equal(classifyTicket({ ...done, restarts: RESTART_CAP }), "restart-exhausted", "the budget is checked first");
  assert.equal(classifyTicket({ ...done, verified: "", landedSignature: "" }), "escalated", "an empty signature is never a verified set");
});

test("a parent whose child list was not read in full is never treated as finished", () => {
  const truncated = facts({ children: { total: 60, open: 0, complete: false }, live: false });
  assert.equal(classifyTicket(truncated), "stalled", "an unfinished list is a ticket with its own work, not a finished parent");
  assert.notEqual(classifyTicket(truncated), "landed", "no verifier over a parent that may still have open children");
});

test("a group-linked parent is left to the group step, whatever its own facts look like", () => {
  const linked = facts({ groupLinked: true, children: { total: 2, open: 0, complete: true }, live: false, openPulls: [pull("https://github.com/o/r/pull/1")] });
  assert.equal(classifyTicket(linked), "moving", "sessions.ts stepGroup hands out the members and closes the parent");
  assert.equal(STEWARD_ACTION[classifyTicket(linked)], null, "the steward does nothing to it");
});

// --- The durable store -----------------------------------------------------------------------------

async function store(t: TestContext): Promise<{ store: StewardStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-steward-"));
  const path = join(directory, "steward.json");
  return { store: new StewardStore(path), path };
}

test("a claim is written before the effect and survives a reload", async (t) => {
  const { store: first, path } = await store(t);
  await first.update((file) => {
    const ticket = first.ticket(file, "i1", "TUC-1", at(5));
    ticket.claim = { action: "restart", marker: "m1", at: at(5), state: "claimed" };
    ticket.restarts = [at(60)];
  });
  // A crash right after the claim, read by a fresh instance: the claim is there, still claimed.
  const reloaded = new StewardStore(path);
  const ticket = (await reloaded.read()).tickets.i1;
  assert.deepEqual(ticket?.claim?.state, "claimed");
  assert.deepEqual(ticket?.restarts, [at(60)]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).version, 1);
});

test("a claim's outcome is recorded on the same ticket, and the journals are kept per ticket", async (t) => {
  const { store: journal } = await store(t);
  await journal.update((file) => {
    const one = journal.ticket(file, "i1", "TUC-1", at(5));
    one.claim = { action: "verify", marker: "v1", at: at(5), state: "claimed" };
    const two = journal.ticket(file, "i2", "TUC-2", at(4));
    two.claim = { action: "escalate", marker: "c1", at: at(4), state: "done", result: "asked the owner" };
  });
  await journal.update((file) => {
    journal.ticket(file, "i1", "TUC-1", at(5)).claim = { action: "verify", marker: "v1", at: at(5), state: "done", result: "verifier a1" };
  });
  const file = await journal.read();
  assert.equal(file.tickets.i1.claim?.state, "done");
  assert.equal(file.tickets.i1.claim?.result, "verifier a1");
  assert.equal(file.tickets.i2.claim?.state, "done", "the other ticket's journal is untouched");
});

test("the flow summary and the per-ticket state are the store's own, and a corrupted file is refused", async (t) => {
  const { store: flow, path } = await store(t);
  await flow.update((file) => { file.flow = { at: at(1), counts: { moving: 2, landed: 1 }, oldest: [{ identifier: "TUC-3", situation: "landed", since: at(600) }] }; });
  assert.deepEqual((await new StewardStore(path).read()).flow?.counts, { moving: 2, landed: 1 });
  // A file that is not the version-1 shape is refused: the pass then writes nothing rather than
  // acting on a guess.
  await writeFile(path, JSON.stringify({ version: 2, tickets: {} }));
  await assert.rejects(() => new StewardStore(path).read(), StewardStateError);
  await writeFile(path, "not json");
  await assert.rejects(() => new StewardStore(path).read(), StewardStateError);
});

test("an unreadable store starts empty only when it is missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-steward-"));
  const missing = new StewardStore(join(directory, "steward.json"));
  assert.deepEqual(await missing.read(), { version: 1, tickets: {}, flow: null });
});

test("the situation the store remembers is one of the classifier's own", async (t) => {
  const { store: journal } = await store(t);
  await journal.update((file) => {
    const ticket = journal.ticket(file, "i1", "TUC-1", at(3));
    ticket.situation = classifyTicket(facts({ live: false, openPulls: [pull("https://github.com/o/r/pull/1")] }));
  });
  const situation: StewardSituation = (await journal.read()).tickets.i1.situation;
  assert.equal(situation, "open-pr");
  assert.equal(STEWARD_ACTION[situation], "succeed", "an open pull request nobody works on gets a successor");
});

// --- the pass, end to end -------------------------------------------------------------------------
// The acts below drive the real Steward over fakes and a real store file: what one pass does to a
// ticket, what it refuses to repeat, and which of its budgets it respects.

const stewardSettings = (cap = 5, teamKeys: string[] = ["ENG"]) => ({
  dispatch: { label: "paseo", teamKeys, intervalSeconds: 60 },
  steward: { enabled: true, queuedEscalateHours: 24, idleMinutes: 30, maxActionsPerPass: cap },
  agentLinearAccess: true,
}) as any;

const ticketIssue = (over: Record<string, unknown> = {}) => ({
  id: "i1", identifier: "ENG-1", title: "Ticket", status: "In Progress", statusType: "started",
  teamId: "t1", teamKey: "ENG", projectId: null, projectName: null, delegateId: "app1", parentId: null,
  labels: [{ id: "l1", name: "paseo" }], children: [], childrenComplete: true, blockers: [], attachments: [], updatedAt: at(3),
  ...over,
}) as any;

const recordFor = (issueId: string, identifier: string, pullRequests: string[] = [], waiting: unknown = null) =>
  ({ issueId, identifier, agentId: `agent-${identifier}`, links: {}, pullRequests, waiting }) as any;

const childIssue = (identifier: string, id: string, statusType: string) =>
  ({ id, identifier, status: statusType === "canceled" ? "Canceled" : "Done", statusType, delegateId: null, assigneeId: null }) as any;

const merged = (url: string) => new Map([[url, pull(url, { merged: true })]]);

// The steward's own calls, one fake per dependency it was built to use.
async function passFixture(t: any, over: {
  issues?: any[];
  roots?: Map<string, any>;
  records?: any[];
  pullStates?: Map<string, any>;
  cap?: number;
  clockNow?: number;
  verdicts?: (issueId: string) => Promise<any[]>;
  restart?: () => Promise<any>;
  succession?: () => Promise<any>;
  admission?: { ok: boolean; reason?: string };
  completionPulls?: string;
  listing?: any[];
  teams?: string[];
  thread?: any;
} = {}) {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const dir = await mkdtemp(join(tmpdir(), "paseo-steward-pass-"));
  const store = new StewardStore(join(dir, "steward.json"));
  const calls = {
    restarts: [] as string[], successions: [] as string[], starts: [] as string[], completed: [] as string[],
    escalates: [] as string[], clears: [] as string[], prompts: [] as string[], relates: [] as string[],
    dueDates: [] as string[], moves: [] as string[], labels: [] as string[], archives: [] as string[],
    completionUrls: [] as string[][],
  };
  const clock = { now: over.clockNow ?? T0 + 5 * 60_000 };
  const admission = { value: over.admission ?? { ok: true as boolean, reason: undefined as string | undefined } };
  const records = over.records ?? [];
  // The effects a test can make fail, to see what a half-applied verdict leaves behind.
  const fail = { complete: false, escalate: false };
  // The roots map is the fixture's own object: a test can give a ticket an agent between passes.
  const roots = over.roots ?? new Map<string, any>();
  // A Paseo whose every listing is empty and whose agents answer like the real API: the steward
  // reads its ticket's agents and archives the ones it is done with through it.
  const page = () => ({ entries: [], pageInfo: { hasMore: false }, nextCursor: null });
  const paseo: any = {
    agents: {
      list: async () => ({ ...page(), entries: (over.listing ?? []).map((agent) => ({ agent })) }),
      ref: (agentId: string) => ({
        refresh: async () => ({ agent: { id: agentId, archivedAt: null, updatedAt: new Date(clock.now).toISOString() } }),
        archive: async () => { calls.archives.push(agentId); },
      }),
    },
  };
  const build = () => new Steward({
    store,
    linear: {
      trustedAppIds: async () => ["app1"],
      stewardIssues: async () => over.issues ?? [],
      issueStatus: async () => ({ status: "In Progress", statusType: "started", completedAt: null }),
      issueCore: async () => ({ id: "i1", identifier: "ENG-1", labels: [{ id: "l1", name: "paseo" }] }),
      issueRef: async (identifier: string) => (identifier === "ENG-2" ? { id: "i2", identifier: "ENG-2" } : null),
      addLabel: async (_id: string, name: string) => { calls.labels.push(`+${name}`); },
      removeLabel: async (_id: string, name: string) => { calls.labels.push(`-${name}`); },
      comment: async () => {}, upsertComment: async () => "c1",
      createIssue: async () => ({ id: "f1", identifier: "ENG-99" }),
      relate: async (blocker: string, blocked: string) => { calls.relates.push(`${blocker}->${blocked}`); },
      complete: async (id: string) => { if (fail.complete) throw new Error("Linear did not confirm the write."); calls.completed.push(id); },
      moveToReady: async (id: string) => { calls.moves.push(id); return { changed: true }; },
      setDueDate: async (_id: string, date: string) => { calls.dueDates.push(date); },
    } as any,
    sessions: {
      watchdogRoots: async () => roots,
      restartFor: async (issueId: string) => { calls.restarts.push(issueId); return over.restart ? await over.restart() : { kind: "started", agentId: "a9" }; },
      succeed: async (issueId: string) => { calls.successions.push(issueId); return over.succession ? await over.succession() : { kind: "started", agent: { id: "a10", title: null, cwd: "" } }; },
      prompt: async () => { calls.prompts.push("resume"); return "sent"; },
      watchdogThread: async () => over.thread ?? null, threadQueued: async () => false,
      retireTurn: async (_issueId: string, work: () => Promise<number>) => work(),
    } as any,
    starter: {
      admission: async () => admission.value,
      start: async () => { calls.starts.push("verifier"); return { agentId: "v1" }; },
    } as any,
    launcher: { gate: () => ({ release: () => {} }) } as any,
    handover: { all: async () => records } as any,
    writeback: {
      escalate: async (issueId: string) => { if (fail.escalate) throw new Error("Writeback is down."); calls.escalates.push(issueId); },
      clearWait: async (issueId: string) => { calls.clears.push(issueId); },
    } as any,
    watchdog: { read: async () => null, handedOver: async () => new Map() } as any,
    manualTasks: { openBlockers: async () => [] } as any,
    needsYou: { all: async () => [] } as any,
    settings: { read: async () => stewardSettings(over.cap) } as any,
    owner: async () => "here",
    pulls: async () => over.pullStates ?? new Map(),
    completionPulls: async (_issueId: string, _identifier: string, urls: string[]) => { calls.completionUrls.push(urls); return (over.completionPulls ?? "settled") as any; },
    intake: { claimsReady: async () => true } as any,
    doneTickets: new DoneTickets(),
    labels: { all: async () => [], add: async () => {}, remove: async () => {} } as any,
    now: () => clock.now,
    verdicts: over.verdicts,
  } as any);
  const seed = async (issueId: string, identifier: string, patch: Record<string, unknown> = {}) => {
    await store.update((file: any) => {
      const ticket = store.ticket(file, issueId, identifier, at(30));
      Object.assign(ticket, patch);
    });
  };
  const ticket = async (issueId: string) => (await store.read()).tickets[issueId];
  return { store, calls, clock, paseo, seed, ticket, records, roots, admission, fail, build, pass: async (cap?: number) => await build().tick(paseo, stewardSettings(cap ?? over.cap, over.teams)) };
}

test("a claim written before the effect is not repeated after a reload, and is retried after the grace", async (t) => {
  const f = await passFixture(t, { issues: [ticketIssue()], records: [recordFor("i1", "ENG-1")] });
  // A pass that claimed a restart and died before the effect: only the claim is on disk.
  await f.seed("i1", "ENG-1", { situation: "stalled", claim: { action: "restart", marker: "m1", at: at(1), state: "claimed" } });
  await f.pass();
  assert.deepEqual(f.calls.restarts, [], "the open claim is not repeated blindly");
  // A new instance over the same file (a reload) sees the claim too, and waits it out.
  await f.build().tick(f.paseo, stewardSettings());
  assert.deepEqual(f.calls.restarts, [], "one restart and no repeat while the claim holds");
  f.clock.now = T0 + 20 * 60_000; // past the claim grace
  await f.pass();
  assert.deepEqual(f.calls.restarts, ["i1"], "after the grace the restart is claimed and tried once");
});

test("a used-up restart budget escalates once, and a later pass does not ask again", async (t) => {
  const f = await passFixture(t, { issues: [ticketIssue()], records: [recordFor("i1", "ENG-1")] });
  await f.seed("i1", "ENG-1", { situation: "restart-exhausted", restarts: [at(600), at(300), at(60)] });
  await f.pass();
  assert.deepEqual(f.calls.escalates, ["i1"], "the exhausted budget reaches the owner");
  assert.deepEqual(f.calls.restarts, [], "no fourth restart");
  f.clock.now += 5 * 60_000;
  await f.pass();
  assert.deepEqual(f.calls.escalates, ["i1"], "the owner is asked once, not once per pass");
});

test("an escalation the owner has not answered stands across passes and is never cleared", async (t) => {
  const f = await passFixture(t, { issues: [ticketIssue()], records: [recordFor("i1", "ENG-1")] });
  await f.seed("i1", "ENG-1", { situation: "restart-exhausted", restarts: [at(600), at(300), at(60)] });
  await f.pass();
  assert.deepEqual(f.calls.escalates, ["i1"], "the decision is put in front of the owner");
  // The wait the escalation persisted is a decision wait: only the owner's answer or retry ends it.
  f.records.push(recordFor("i1", "ENG-1", [], { kind: "decision", at: new Date(f.clock.now).toISOString() }));
  f.clock.now += 40 * 60_000;
  await f.pass();
  await f.pass();
  assert.deepEqual(f.calls.clears, [], "an unanswered decision is never cleared as a stale wait");
  assert.deepEqual(f.calls.escalates, ["i1"], "and it is not asked again");
  assert.deepEqual(f.calls.restarts, [], "no recovery runs beside it");
  const ticket = await f.ticket("i1");
  assert.equal(ticket?.escalated?.key, "restart-exhausted", "the escalation stays on the ticket record");
});

test("the per-pass cap spreads heavy actions over passes, deterministically", async (t) => {
  const f = await passFixture(t, {
    issues: [ticketIssue(), ticketIssue({ id: "i2", identifier: "ENG-2" })],
    records: [recordFor("i1", "ENG-1"), recordFor("i2", "ENG-2")],
    cap: 1,
    clockNow: T0,
  });
  await f.seed("i1", "ENG-1", { situation: "stalled", since: at(120) });
  await f.seed("i2", "ENG-2", { situation: "stalled", since: at(120) });
  await f.pass(1);
  assert.deepEqual(f.calls.restarts, ["i1"], "one heavy action per pass");
  assert.deepEqual(await f.ticket("i2").then((ticket) => ticket?.restarts), [], "the deferred ticket spends no budget");
  // The restart worked: i1 has a live agent again, so the next pass's one slot is i2's.
  f.roots.set("i1", { roots: [{ id: "a1", status: "running", updatedAt: new Date(f.clock.now).toISOString(), createdAt: at(60) }], ghosts: new Set<string>() });
  f.clock.now += 30 * 60_000;
  await f.pass(1);
  assert.deepEqual(f.calls.restarts, ["i1", "i2"], "the next pass takes the ticket the cap deferred");
});

test("deliberate waits are untouched by a whole pass", async (t) => {
  const held = ticketIssue({ id: "i2", identifier: "ENG-2", labels: [{ id: "l1", name: "paseo" }, { id: "l2", name: "paseo-hold" }] });
  const planned = ticketIssue({ id: "i3", identifier: "ENG-3", status: "Plan review", statusType: "started" });
  const f = await passFixture(t, {
    issues: [held, planned],
    records: [recordFor("i2", "ENG-2"), recordFor("i3", "ENG-3")],
  });
  await f.seed("i2", "ENG-2", { situation: "stalled", since: at(600) });
  await f.seed("i3", "ENG-3", { situation: "landed", since: at(600) });
  await f.pass();
  assert.deepEqual(f.calls.restarts, [], "a held ticket is not recovered");
  assert.deepEqual(f.calls.starts, [], "a plan under review gets no verifier");
  assert.deepEqual(f.calls.escalates, [], "and neither is escalated into Needs input");
});

test("a landed ticket gets a verifier through admission, claimed on its ticket", async (t) => {
  const f = await passFixture(t, {
    issues: [ticketIssue()],
    records: [recordFor("i1", "ENG-1", ["https://github.com/o/r/pull/7"])],
    pullStates: merged("https://github.com/o/r/pull/7"),
  });
  await f.seed("i1", "ENG-1", { situation: "landed" });
  await f.pass();
  assert.deepEqual(f.calls.starts, ["verifier"], "a landed ticket is judged by a verifier, not restarted");
  const ticket = await f.ticket("i1");
  assert.equal(ticket?.verifier?.agentId, "v1", "the verifier is claimed on the ticket");
  assert.ok(ticket?.verifier?.marker, "with the marker its verdict must carry");
});

test("an admission refusal defers a verifier into the queue, it does not fail it", async (t) => {
  const f = await passFixture(t, {
    issues: [ticketIssue()],
    records: [recordFor("i1", "ENG-1", ["https://github.com/o/r/pull/7"])],
    pullStates: merged("https://github.com/o/r/pull/7"),
    admission: { ok: false, reason: "Queued: 8 of 8 agents are running." },
  });
  await f.seed("i1", "ENG-1", { situation: "landed" });
  await f.pass();
  assert.deepEqual(f.calls.starts, [], "no verifier while the scheduler has no slot");
  const ticket = await f.ticket("i1");
  assert.equal(ticket?.queued?.action, "verify", "the verifier waits in the queue");
  assert.equal(ticket?.claim?.state, "deferred", "the deferral is not a failure");
  assert.deepEqual(ticket?.refusals, [], "an admission wait spends no refusal budget");
  assert.deepEqual(ticket?.restarts, [], "and no restart budget");
  // The queue entry is retried once admission admits it, without a new classification.
  f.admission.value = { ok: true, reason: undefined };
  f.clock.now += 2 * 60_000;
  await f.pass();
  assert.deepEqual(f.calls.starts, ["verifier"], "the queued verifier starts when its slot comes");
  assert.equal((await f.ticket("i1"))?.queued, null, "the queue entry is gone once it ran");
});

test("a verifier's verdict closes the ticket, archives its agents and lands the signature", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue()],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "close", instruction: null, blockedBy: null, dueDate: null, reason: null, question: null, options: null }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  await f.pass();
  assert.deepEqual(f.calls.completed, ["i1"], "the verdict completes the ticket");
  const ticket = await f.ticket("i1");
  assert.equal(ticket?.verifier, null, "the verifier is consumed");
  assert.equal(ticket?.verified, url, "the landed set it judged is remembered");
  assert.equal(ticket?.applying, null, "and the application journal is closed");
  assert.deepEqual(f.calls.archives, ["v1"], "the verifier's agent is archived when its verdict is applied");
});

test("a verdict application that fails keeps its journal, and the next pass finishes it", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue()],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "close", instruction: null, blockedBy: null, dueDate: null, reason: null, question: null, options: null }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  f.fail.complete = true;
  await f.pass();
  assert.deepEqual(f.calls.completed, [], "the close did not go through");
  const half = await f.ticket("i1");
  assert.equal(half?.applying?.step, "claimed", "the application is journaled before its first effect");
  assert.equal(half?.verifier?.marker, "m1", "and the verifier is not consumed");
  // The next pass applies the same verdict again: no completion is lost to the failed write.
  f.fail.complete = false;
  f.clock.now += 20 * 60_000;
  await f.pass();
  assert.deepEqual(f.calls.completed, ["i1"], "the retry completes the ticket");
  assert.equal((await f.ticket("i1"))?.verifier, null, "and only then consumes the verifier");
});

test("a verifier's verdict resumes the work with its instruction", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue()],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "resume", instruction: "finish the CSV export", blockedBy: null, dueDate: null, reason: null, question: null, options: null }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  await f.pass();
  assert.deepEqual(f.calls.successions, ["i1"], "the successor continues the ticket");
  assert.deepEqual(f.calls.completed, [], "nothing is completed");
  assert.equal((await f.ticket("i1"))?.verifier, null, "the verdict is consumed");
});

test("a resumed verdict honors the restart budget and the steward switch", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const record = () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "resume", instruction: "keep going", blockedBy: null, dueDate: null, reason: null, question: null, options: null }];
  const f = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url), verdicts: async () => record(),
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) }, restarts: [at(600), at(300), at(60)] });
  await f.pass();
  assert.deepEqual(f.calls.successions, [], "the spent recovery budget is not bypassed by a verdict");
  assert.deepEqual(f.calls.escalates, ["i1"], "the owner hears why the work stops");
  // The steward switch off: a verdict mutates nothing at all.
  const off = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url),
    verdicts: async () => [{ issueId: "i1", at: new Date().toISOString(), verifier: "m1", verdict: "close", instruction: null, blockedBy: null, dueDate: null, reason: null, question: null, options: null }],
  });
  await off.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  await off.build().tick(off.paseo, { ...stewardSettings(), steward: { ...stewardSettings().steward, enabled: false } });
  assert.deepEqual(off.calls.completed, [], "a disabled steward completes nothing");
  assert.equal((await off.ticket("i1"))?.verifier?.marker, "m1", "the verdict waits for the switch");
});

test("a verdict never starts a successor beside a deliberate wait", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue({ labels: [{ id: "l1", name: "paseo" }, { id: "l2", name: "paseo-hold" }] })],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "resume", instruction: "keep going", blockedBy: null, dueDate: null, reason: null, question: null, options: null }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  await f.pass();
  assert.deepEqual(f.calls.successions, [], "the hold the owner added while the verifier ran wins");
  assert.equal((await f.ticket("i1"))?.verifier?.marker, "m1", "the verdict waits for the wait to end");
});

test("a verdict from a stale verifier generation is ignored", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue()],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    // The marker of an older verifier generation: its verdict answers a claim this host replaced.
    verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "older", verdict: "close", instruction: null, blockedBy: null, dueDate: null, reason: null, question: null, options: null }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  await f.pass();
  assert.deepEqual(f.calls.completed, [], "no close from another generation's verdict");
  assert.deepEqual(f.calls.escalates, [], "and no escalation either");
  assert.equal((await f.ticket("i1"))?.verifier?.marker, "m1", "the verifier it does not answer stays claimed");
});

test("a close verdict re-reads the pull requests: an open one blocks it and re-classifies the ticket", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue({ attachments: [{ url, sourceType: "github", status: null, linkKind: null }] })],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    completionPulls: "open",
    verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "close", instruction: null, blockedBy: null, dueDate: null, reason: null, question: null, options: null }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  await f.pass();
  assert.deepEqual(f.calls.completed, [], "the ticket stays open over an open pull request");
  const ticket = await f.ticket("i1");
  assert.equal(ticket?.verifier, null, "the verifier is consumed: its verdict cannot be applied as it stands");
  assert.equal(ticket?.verified, null, "and the landed set is not marked verified");
});

test("a park verdict hands the ticket back to Linear as startable work", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const park = async (verdict: Record<string, unknown>) => {
    const f = await passFixture(t, {
      issues: [ticketIssue()],
      records: [recordFor("i1", "ENG-1", [url])],
      pullStates: merged(url),
      verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "park", instruction: null, blockedBy: null, dueDate: null, reason: "the schema must settle first", question: null, options: null, ...verdict }],
    });
    await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
    await f.pass();
    return f;
  };
  const blocked = await park({ blockedBy: "ENG-2", dueDate: "2026-11-01" });
  assert.deepEqual(blocked.calls.relates, ["i2->i1"], "ENG-2 blocks ENG-1");
  assert.deepEqual(blocked.calls.dueDates, ["2026-11-01"]);
  assert.deepEqual(blocked.calls.moves, ["i1"], "the ticket goes back to Todo");
  assert.deepEqual(blocked.calls.labels, ["+paseo"], "with the trigger label only when a blocker must finish first");
  assert.equal((await blocked.ticket("i1"))?.parked?.blockedBy, "ENG-2", "the park is recorded");
  // A park without a blocker is nobody's to start: no trigger label, no dispatch.
  const dated = await park({ dueDate: "2026-11-01" });
  assert.deepEqual(dated.calls.labels, [], "no trigger label without a blocker");
  assert.deepEqual(dated.calls.moves, ["i1"], "still moved out of the working state");
  assert.deepEqual(dated.calls.completed, [], "never completed");
});

test("an ask_owner verdict puts the decision in front of the owner", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue()],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    verdicts: async () => [{ issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "ask_owner", instruction: null, blockedBy: null, dueDate: null, reason: null, question: "which host runs it?", options: ["this one", "the other"] }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(10) } });
  await f.pass();
  assert.deepEqual(f.calls.escalates, ["i1"], "the question reaches the owner");
  assert.deepEqual(f.calls.completed, [], "nothing is completed");
  assert.equal((await f.ticket("i1"))?.verifier, null, "the verdict is consumed");
});

// --- the safety re-review's cases ---------------------------------------------------------------

const VERIFIER = { agentId: "v1", marker: "m1", at: at(10) };
const verifierVerdict = (f: { clock: { now: number } }, over: Record<string, unknown>) => ({
  issueId: "i1", at: new Date(f.clock.now).toISOString(), verifier: "m1", verdict: "close",
  instruction: null, blockedBy: null, dueDate: null, reason: null, question: null, options: null, ...over,
});

test("an interrupted verifier launch is adopted by its marker instead of losing its verdict", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url),
    // The agent the launch created, labelled with the generation the store persisted before it.
    listing: [{ id: "a7", status: "running", labels: { "linear-tickets.steward": "m1" }, createdAt: at(6) }],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: null, marker: "m1", at: at(6) } });
  await f.pass();
  assert.deepEqual(f.calls.starts, [], "no second verifier: the generation's own agent is adopted");
  const ticket = await f.ticket("i1");
  assert.equal(ticket?.verifier?.agentId, "a7", "the agent is recorded on the generation");
  assert.equal(ticket?.verifier?.marker, "m1");
});

test("a pending verifier generation whose launch left no agent is dropped after the grace", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const fresh = await passFixture(t, { issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url) });
  await fresh.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: null, marker: "m1", at: at(2) } });
  await fresh.pass();
  assert.equal((await fresh.ticket("i1"))?.verifier?.marker, "m1", "inside the grace the launch is still being confirmed");
  assert.deepEqual(fresh.calls.starts, [], "and nothing else is started beside it");
  const late = await passFixture(t, { issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url) });
  await late.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: null, marker: "m1", at: at(30) } });
  await late.pass();
  const ticket = await late.ticket("i1");
  assert.equal(ticket?.verifier, null, "past the grace the lost generation is dropped");
  assert.equal(ticket?.refusals?.length, 1, "and counted as a refusal, not retried forever");
});

test("a timeout escalation is journaled: a failed call keeps the decision for the next pass", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, { issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url) });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: { agentId: "v1", marker: "m1", at: at(60) } });
  f.fail.escalate = true;
  await f.pass();
  const half = await f.ticket("i1");
  assert.equal(half?.applying?.verdict, "timeout", "the terminal outcome is journaled");
  assert.equal(half?.applying?.step, "claimed", "before its owner-facing effect");
  assert.equal(half?.verifier?.marker, "m1", "and the verifier is not consumed by a failed call");
  f.fail.escalate = false;
  f.clock.now += 20 * 60_000;
  await f.pass();
  assert.deepEqual(f.calls.escalates, ["i1"], "the retry commits the decision");
  assert.equal((await f.ticket("i1"))?.verifier, null, "and only then consumes the verifier");
});

test("a verdict successor is charged, and its repeated failures reach the owner", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const impossible = { kind: "impossible", reason: "no branch to continue" };
  const f = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url),
    succession: async () => impossible, verdicts: async () => [verifierVerdict(f as any, { verdict: "resume", instruction: "finish it" })],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: VERIFIER });
  await f.pass();
  const once = await f.ticket("i1");
  assert.equal(once?.restarts?.length, 1, "the admitted attempt is charged");
  assert.equal(once?.refusals?.length, 1, "and the failure is counted");
  assert.equal(once?.verifier?.marker, "m1", "the verdict is not consumed while it can be retried");
  // The refusal budget spent: the verdict becomes the owner's decision, journaled before consuming.
  const spent = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url),
    succession: async () => impossible, verdicts: async () => [verifierVerdict(f as any, { verdict: "resume", instruction: "finish it" })],
  });
  await spent.seed("i1", "ENG-1", { situation: "verifying", verifier: VERIFIER, restarts: [at(600), at(300)], refusals: [{ at: at(120), reason: "a" }, { at: at(90), reason: "b" }] });
  await spent.pass();
  assert.deepEqual(spent.calls.successions, ["i1"], "the start was attempted once more");
  assert.deepEqual(spent.calls.escalates, ["i1"], "and the owner is asked instead of retrying forever");
  assert.equal((await spent.ticket("i1"))?.verifier, null, "the verdict is consumed into the decision");
});

test("a verifier is never the successor a resume takes over from", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const f = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url),
    succession: async () => ({ kind: "live", agent: { id: "v1", title: null, cwd: "" } }),
    verdicts: async () => [verifierVerdict(f as any, { verdict: "resume", instruction: "finish it" })],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: VERIFIER });
  await f.pass();
  const ticket = await f.ticket("i1");
  assert.equal(ticket?.verifier?.marker, "m1", "the verdict is not consumed on an empty hand-off");
  assert.equal(ticket?.refusals?.length, 1, "the no-op is counted, not treated as a continuation");
  assert.deepEqual(f.calls.archives, ["v1"], "the verifier is archived before the successor is looked for");
});

test("a close verdict honors a hold, an owner wait or a child that appeared while it verified", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const attempt = async (over: Record<string, unknown>) => {
    const f = await passFixture(t, {
      issues: [ticketIssue(over)],
      records: [recordFor("i1", "ENG-1", [url], (over.ownerWait as unknown) ?? null)],
      pullStates: merged(url),
      verdicts: async () => [verifierVerdict(f as any, { verdict: "close" })],
    });
    await f.seed("i1", "ENG-1", { situation: "verifying", verifier: VERIFIER });
    await f.pass();
    return f;
  };
  const held = await attempt({ labels: [{ id: "l1", name: "paseo" }, { id: "l2", name: "paseo-hold" }] });
  assert.deepEqual(held.calls.completed, [], "a hold that appeared during the verification stops the close");
  const child = await attempt({ children: [childIssue("ENG-1.1", "c1", "started")], childrenComplete: true });
  assert.deepEqual(child.calls.completed, [], "a newly open sub-issue stops the close");
  const owned = await attempt({ ownerWait: { kind: "decision", at: at(5) } });
  assert.deepEqual(owned.calls.completed, [], "an owner decision that is still open stops the close");
  const blocker = await attempt({ blockers: [{ identifier: "ENG-9", statusType: "started", merged: false }] });
  assert.deepEqual(blocker.calls.completed, [], "a fresh blocker stops the close");
  for (const f of [held, child, owned, blocker]) {
    assert.equal((await f.ticket("i1"))?.verifier, null, "the verifier is consumed: the next pass classifies the ticket anew");
  }
});

test("the close asks for the complete fresh pull-request set, and an open or unreadable one stops it", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const attached = "https://github.com/o/r2/pull/9";
  const f = await passFixture(t, {
    issues: [ticketIssue({ attachments: [{ url: attached, sourceType: "github", status: null, linkKind: null }] })],
    records: [recordFor("i1", "ENG-1", [url])],
    pullStates: merged(url),
    completionPulls: "settled",
    verdicts: async () => [verifierVerdict(f as any, { verdict: "close" })],
  });
  await f.seed("i1", "ENG-1", { situation: "verifying", verifier: VERIFIER });
  await f.pass();
  assert.deepEqual(f.calls.completed, ["i1"], "a settled inventory closes");
  assert.deepEqual(f.calls.completionUrls.at(-1)?.sort(), [attached, url].sort(), "every recorded and attached pull request is re-read fresh");
  const open = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url),
    completionPulls: "open", verdicts: async () => [verifierVerdict(f as any, { verdict: "close" })],
  });
  await open.seed("i1", "ENG-1", { situation: "verifying", verifier: VERIFIER });
  await open.pass();
  assert.deepEqual(open.calls.completed, [], "a reopened or unrecorded pull request stops the close");
  const unreadable = await passFixture(t, {
    issues: [ticketIssue()], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url),
    completionPulls: "unknown", verdicts: async () => [verifierVerdict(f as any, { verdict: "close" })],
  });
  await unreadable.seed("i1", "ENG-1", { situation: "verifying", verifier: VERIFIER });
  await unreadable.pass();
  assert.deepEqual(unreadable.calls.completed, [], "an unreadable inventory never closes a ticket");
});

test("a park ends when its blocker finishes, its date arrives, or the owner retries", async (t) => {
  const parkedTicket = (parked: Record<string, unknown>, blockers: any[] = []) => ticketIssue({ blockers });
  const waiting = async (parked: Record<string, unknown>, blockers: any[] = []) => {
    const f = await passFixture(t, { issues: [parkedTicket(parked, blockers)], records: [recordFor("i1", "ENG-1")] });
    await f.seed("i1", "ENG-1", { situation: "parked", parked, since: at(120) });
    return f;
  };
  // A date in the future and an unfinished blocker: the ticket waits, nothing is recovered.
  const holds = await waiting({ at: at(30), blockedBy: "ENG-2", dueDate: "2027-01-01", reason: "wait" }, [{ identifier: "ENG-2", statusType: "started", merged: false }]);
  await holds.pass();
  assert.deepEqual(holds.calls.restarts, [], "a live park is not recovered");
  assert.equal((await holds.ticket("i1"))?.parked?.blockedBy, "ENG-2", "and its record stays");
  // The blocker finished: the park is over, and the next pass recovers the ticket again.
  const released = await waiting({ at: at(30), blockedBy: "ENG-2", dueDate: null, reason: "wait" }, [{ identifier: "ENG-2", statusType: "completed", merged: false }]);
  await released.pass();
  assert.equal((await released.ticket("i1"))?.parked, null, "a finished blocker ends the park");
  released.clock.now += 20 * 60_000;
  await released.pass();
  released.clock.now += 20 * 60_000;
  await released.pass();
  assert.deepEqual(released.calls.restarts, ["i1"], "and the ticket is recovered like any other");
  // The date passed.
  const dated = await waiting({ at: at(30), blockedBy: null, dueDate: "2026-10-12", reason: "wait" });
  dated.clock.now = Date.parse("2026-10-13T09:05:00.000Z");
  await dated.pass();
  assert.equal((await dated.ticket("i1"))?.parked, null, "a due date that arrived ends the park");
  dated.clock.now += 20 * 60_000;
  await dated.pass();
  dated.clock.now += 20 * 60_000;
  await dated.pass();
  assert.deepEqual(dated.calls.restarts, ["i1"], "and it is recovered too");
  // A date that has not arrived yet still waits.
  const tomorrow = await waiting({ at: at(30), blockedBy: null, dueDate: "2026-11-01", reason: "wait" });
  await tomorrow.pass();
  assert.deepEqual(tomorrow.calls.restarts, [], "a park for a future date keeps waiting");
  assert.equal((await tomorrow.ticket("i1"))?.parked?.dueDate, "2026-11-01");
  // The owner's own continuation ends the park outright.
  const owner = await waiting({ at: at(30), blockedBy: "ENG-2", dueDate: "2027-01-01", reason: "wait" }, [{ identifier: "ENG-2", statusType: "started", merged: false }]);
  await owner.build().ownerRetried("i1");
  assert.equal((await owner.ticket("i1"))?.parked, null, "the owner's retry clears the park marker");
});

test("the dispatch teams bound the steward's scope, inventory ids included", async (t) => {
  const other = ticketIssue({ teamKey: "OTHER", delegateId: "app1" });
  const f = await passFixture(t, { issues: [other], records: [recordFor("i1", "ENG-1")] });
  await f.seed("i1", "ENG-1", { situation: "stalled", since: at(120) });
  await f.pass();
  assert.deepEqual(f.calls.restarts, [], "a ticket outside the configured teams is never moved");
  assert.deepEqual(f.calls.escalates, [], "nor escalated");
  const empty = await passFixture(t, { issues: [ticketIssue()], records: [recordFor("i1", "ENG-1")], teams: [] });
  await empty.seed("i1", "ENG-1", { situation: "stalled", since: at(120) });
  await empty.pass();
  assert.deepEqual(empty.calls.restarts, [], "an empty team list puts nothing in scope, however it was tracked");
});

test("a verdict that names no gate is refused, and so is an impossible calendar date", () => {
  const base = { issueId: "i1", at: at(1), verifier: "m1" };
  assert.equal(parseVerdict({ ...base, verdict: "park", reason: "wait" }), null, "a park without a blocker or a date waits for nothing");
  assert.equal(parseVerdict({ ...base, verdict: "park", reason: "wait", dueDate: "2026-02-31" }), null, "31 February is not a date");
  assert.equal(parseVerdict({ ...base, verdict: "park", reason: "wait", blockedBy: "ENG-2" })?.blockedBy, "ENG-2", "a blocker alone is a gate");
  assert.equal(parseVerdict({ ...base, verdict: "park", dueDate: "2026-11-01" }), null, "a park always says why");
  assert.equal(parseVerdict({ ...base, verdict: "park", reason: "wait", dueDate: "2026-11-01" })?.dueDate, "2026-11-01");
  assert.equal(parseVerdict({ ...base, verdict: "resume" }), null, "a resume always says what remains");
  assert.equal(parseVerdict({ ...base, verdict: "ask_owner", question: "which?" }), null, "an owner question needs its options");
  assert.equal(calendarDate("2024-02-29"), true, "a leap day is a date");
  assert.equal(calendarDate("2026-02-29"), false, "a non-leap 29 February is not");
});

test("a parent is never closed by the steward: it reaches a verifier like any other ticket", async (t) => {
  const url = "https://github.com/o/r/pull/7";
  const children = [childIssue("ENG-1.1", "c1", "completed"), childIssue("ENG-1.2", "c2", "completed")];
  // A group link owns the parent: sessions.ts stepGroup hands out the members and closes it.
  const linked = await passFixture(t, { issues: [ticketIssue({ children })], records: [recordFor("i1", "ENG-1")], thread: { group: "g1" } });
  await linked.seed("i1", "ENG-1", { situation: "moving" });
  await linked.pass();
  assert.deepEqual(linked.calls.completed, [], "a group-linked parent is not closed by the steward");
  assert.deepEqual(linked.calls.starts, [], "and gets no verifier");
  // Every other finished parent goes to the verifier, never straight to Done.
  const plain = await passFixture(t, { issues: [ticketIssue({ children })], records: [recordFor("i1", "ENG-1", [url])], pullStates: merged(url) });
  await plain.seed("i1", "ENG-1", { situation: "landed" });
  await plain.pass();
  assert.deepEqual(plain.calls.completed, [], "the finished parent is not completed directly");
  assert.deepEqual(plain.calls.starts, ["verifier"], "it is verified first");
  // A parent whose own agent is still alive keeps working.
  const live = await passFixture(t, {
    issues: [ticketIssue({ children })],
    records: [recordFor("i1", "ENG-1")],
    roots: new Map([["i1", { roots: [{ id: "a1", status: "running", updatedAt: at(1), createdAt: at(600) }], ghosts: new Set<string>() }]]),
  });
  await live.seed("i1", "ENG-1", { situation: "moving" });
  await live.pass();
  assert.deepEqual(live.calls.completed, [], "a live parent agent keeps the ticket moving");
  assert.deepEqual(live.calls.starts, []);
});
