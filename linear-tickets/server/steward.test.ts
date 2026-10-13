import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  classifyTicket, isDefect, StewardStateError, StewardStore, STEWARD_ACTION, STEWARD_SITUATIONS, STEWARD_STATES,
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
    children: { total: 0, open: 0, canceledOnly: false }, blocker: null,
    live: true, idleMinutes: null, ownerWait: "none", resumed: false,
    queuedThread: false, queuedSince: null,
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
  // MOVING, WAITING_OWNER, WAITING_BLOCKER, QUEUED and CLOSEABLE are the states the invariant
  // names: everything else is a defect the pass repairs.
  const states = STEWARD_SITUATIONS.filter((situation) => STEWARD_STATES[situation]);
  assert.deepEqual(states, ["moving", "waiting-owner", "waiting-blocker", "queued", "closeable"]);
  for (const situation of STEWARD_SITUATIONS) {
    assert.equal(isDefect(situation), situation !== "closed" && !STEWARD_STATES[situation], `${situation}: a defect is a ticket in no state`);
    // A ticket in one of the five states needs no repair: its only action, if any, is the normal
    // completion a closeable ticket gets.
    if (STEWARD_STATES[situation]) assert.equal(STEWARD_ACTION[situation], situation === "closeable" ? "complete" : null, `${situation} needs no repair`);
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
  assert.equal(classifyTicket(facts({ live: false, started: false, startable: false, queuedThread: true, queuedSince: at(30) })), "queued", "a thread in the wait line");
  assert.equal(classifyTicket(facts({ children: { total: 3, open: 0, canceledOnly: false } })), "closeable", "a parent whose sub-issues are all finished");
});

test("a finished ticket beats every other fact, and its live agents are archived", () => {
  const busy = facts({ terminal: true, live: true, openPulls: [pull("https://github.com/o/r/pull/1")], children: { total: 2, open: 1, canceledOnly: false } });
  assert.equal(classifyTicket(busy), "terminal-agents", "a Done ticket with live agents");
  assert.equal(classifyTicket(facts({ terminal: true, live: false })), "closed", "a Done ticket with none");
  // A verifier's claim, a stale wait and a watchdog cycle are all beaten by a terminal state.
  assert.equal(classifyTicket(facts({ terminal: true, live: false, verifier: true, ownerWait: "stale", watchdog: "exhausted" })), "closed");
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

test("an idle agent is resumed once, then judged by a verifier", () => {
  assert.equal(classifyTicket(facts({ idleMinutes: 45 })), "idle");
  assert.equal(classifyTicket(facts({ idleMinutes: 45, resumed: true })), "idle-unresponsive");
  // An idle agent with an open pull request is still moving: the pull request's own watch nudges it.
  assert.equal(classifyTicket(facts({ idleMinutes: 45, openPulls: [pull("https://github.com/o/r/pull/1")] })), "moving");
});

test("the budgets cap restarts and refusals, and a stuck ticket reaches the owner", () => {
  assert.equal(classifyTicket(facts({ live: false, restarts: RESTART_CAP - 1 })), "stalled");
  assert.equal(classifyTicket(facts({ live: false, restarts: RESTART_CAP })), "restart-exhausted");
  assert.equal(classifyTicket(facts({ live: false, restarts: 0, refusals: 3, lastRefusal: "the launcher refused" })), "refused");
  // A refusal on a ticket that may not start now either: refused, not unstarted.
  assert.equal(classifyTicket(facts({ live: false, started: false, startable: false, refusals: 1 })), "refused");
  // An unstarted ticket that may not start, for no recorded reason, is the steward's own defect.
  assert.equal(classifyTicket(facts({ live: false, started: false, startable: false })), "escalated");
});

test("a parent with open sub-issues is not closeable, whatever else is true", () => {
  const partial = facts({ children: { total: 2, open: 1, canceledOnly: false }, live: false, openPulls: [pull("https://github.com/o/r/pull/1")] });
  assert.equal(classifyTicket(partial), "open-pr", "the parent is judged like any ticket while a sub-issue is open");
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
    two.claim = { action: "complete", marker: "c1", at: at(4), state: "done", result: "closed it" };
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
