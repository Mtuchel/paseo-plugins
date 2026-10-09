import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { HandoverRecord } from "./handover";
import type { OwnerAskComment, OwnerAskIssue } from "./linear";
import { ANSWER_HIDE_MS, answerText, asksOwner, askRoute, deliveryText, OwnerAsks, selectAskText, type ContinueOutcome, type OwnerAsksDeps } from "./owner-asks";
import type { OwnerAsk } from "../shared/contracts";
import type { Extraction } from "./owner-ask-extract";
import type { DeliveryOrigin, DeliveryResult } from "./permission-replies";

const at = "2026-10-09T12:00:00.000Z";
const NOW = Date.parse(at);

const issue = (change: Partial<OwnerAskIssue> = {}): OwnerAskIssue => ({
  id: "i1", identifier: "TUC-1616", title: "Needs you: Decision for you: who takes TUC-1562?",
  url: "https://linear.app/tuchel/issue/TUC-1616", updatedAt: "2026-10-09T11:00:00.000Z",
  description: "**Decision for you: who takes TUC-1562?**\n\n* **Agent does it:** I plan TUC-1562.\n* **You or the team:** someone else picks it up.\n\nReply here with “@paseo <your answer>”.",
  status: "Needs input", statusType: "started", parentId: "p1", parentIdentifier: "TUC-1453",
  labels: ["paseo-needs-you", "Platform"], ...change,
});

const comment = (id: string, body: string, createdAt = "2026-10-09T10:00:00.000Z"): OwnerAskComment => ({ id, body, createdAt });

const waitComment = "**TUC-1015: Post-Sale C2** (Paseo) finished its turn and is waiting for you:\n\n**Two questions for you**\n\n1. May the block refresh live?\n\nReply here with “@paseo <your answer>”.";

type Harness = { ownerAsks: OwnerAsks; paseo: PaseoApi; directory: string; events: string[]; delivered: { agentId: string; message: string; origin: DeliveryOrigin }[]; continued: { issueId: string; identifier: string; lead: string }[]; extractedWith: { identifier: string; kind: string }[]; deps: OwnerAsksDeps; state: { issues: OwnerAskIssue[]; now: number } };

async function setup(options: {
  issues: OwnerAskIssue[];
  comments?: Map<string, OwnerAskComment[]>;
  needsYou?: { id: string; identifier: string; parentId: string; agentId: string }[];
  records?: Map<string, HandoverRecord | null>;
  agents?: { id: string; status: string; createdAt: string; issueId?: string }[];
  extraction?: () => Promise<Extraction>;
  continueOutcome?: ContinueOutcome;
  queueError?: string;
} = { issues: [] }) {
  const directory = await mkdtemp(join(tmpdir(), "owner-asks-"));
  const events: string[] = [];
  const extractedWith: { identifier: string; kind: string }[] = [];
  const state = {
    issues: options.issues,
    comments: options.comments ?? new Map<string, OwnerAskComment[]>(),
    needsYou: options.needsYou ?? [],
    records: options.records ?? new Map<string, HandoverRecord | null>(),
    now: NOW,
    extraction: options.extraction ?? (async () => ({ ok: false as const, reason: "extraction not configured" })),
  };
  const delivered: { agentId: string; message: string; origin: DeliveryOrigin }[] = [];
  const continued: { issueId: string; identifier: string; lead: string }[] = [];
  const deps: OwnerAsksDeps = {
    linear: {
      ownerAskIssues: async () => state.issues,
      ownerAskIssuesByIds: async () => state.issues,
      ownerAskComments: async (ids) => new Map(ids.map((id) => [id, state.comments.get(id) ?? []])),
      commentBody: async (id) => [...state.comments.values()].flat().find((entry) => entry.id === id)?.body ?? null,
      comment: async (issueId, body) => { events.push(`comment ${issueId}: ${body}`); },
      complete: async (issueId) => { events.push(`complete ${issueId}`); },
      viewerId: async () => "owner-1",
    },
    needsYou: { all: async () => state.needsYou, remove: async (id) => { events.push(`needsYou.remove ${id}`); } },
    handover: { read: async (issueId) => state.records.get(issueId) ?? null },
    labels: async () => ({ needsYou: "paseo-needs-you", manual: "paseo-manual" }),
    resolveModel: async () => "omp/test-model",
    extract: async (input) => { extractedWith.push({ identifier: input.identifier, kind: input.kind }); return state.extraction(); },
    deliver: async (_paseo, agentId, message, origin) => {
      delivered.push({ agentId, message, origin });
      return { status: "applied", reply: null, delivered: true, at } as DeliveryResult;
    },
    continueTicket: async (issueId, identifier, lead) => { continued.push({ issueId, identifier, lead }); return options.continueOutcome ?? { kind: "started", agentId: "new-agent" }; },
    queueAnswer: async (issueId, identifier, text, from, reason) => {
      if (options.queueError) throw new Error(options.queueError);
      events.push(`queue ${issueId} ${identifier} from ${from.userId}: ${text} (${reason})`);
    },
    directory,
    now: () => state.now,
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: (options.agents ?? []).map((agent) => ({ agent: { id: agent.id, status: agent.status, createdAt: agent.createdAt, labels: agent.issueId ? { "linear.issueId": agent.issueId } : {} } })),
        pageInfo: { hasMore: false },
      }),
    },
  } as unknown as PaseoApi;
  const ownerAsks = new OwnerAsks(deps);
  const harness: Harness = { ownerAsks, paseo, directory, events, delivered, continued, extractedWith, deps, state };
  return harness;
}

// setImmediate turns starve Node's poll phase (the extraction's file writes): what waits here is
// the read's own outcome, asked again until the background work has landed.
const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the condition was not met in time");
};

const untilAsync = async (check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the condition was not met in time");
};

// The first ask, re-read until the background extraction has landed in it.
const untilAsk = async (h: Harness, predicate: (ask: OwnerAsk) => boolean): Promise<OwnerAsk> => {
  const deadline = Date.now() + 5_000;
  let ask: OwnerAsk | undefined;
  while (Date.now() < deadline) {
    ask = (await h.ownerAsks.snapshot(h.paseo)).asks[0];
    if (ask && predicate(ask)) return ask;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`the ask never reached the expected state: ${JSON.stringify(ask)}`);
};

test("the ask text comes from the description for Needs-you and manual issues, the wait comment, the newest asking comment, else the description", () => {
  const comments = [comment("c3", "A later status update.", "2026-10-09T11:00:00.000Z"), comment("c2", waitComment), comment("c1", "An older note.")];
  assert.equal(selectAskText({ needsYou: true, manual: false, waitCommentId: "c2", comments }, { description: "sub-issue text" }), "sub-issue text");
  assert.equal(selectAskText({ needsYou: false, manual: true, waitCommentId: "c2", comments }, { description: "manual text" }), "manual text");
  assert.equal(selectAskText({ needsYou: false, manual: false, waitCommentId: "c2", comments }, { description: "ticket text" }), waitComment);
  assert.equal(selectAskText({ needsYou: false, manual: false, waitCommentId: null, comments }, { description: "ticket text" }), waitComment, "the newest comment that asks the owner wins, not the newest comment");
  assert.equal(selectAskText({ needsYou: false, manual: false, waitCommentId: null, comments: [comment("c1", "A status update.")] }, { description: "ticket text" }), "ticket text");
  assert.equal(selectAskText({ needsYou: false, manual: false, waitCommentId: "gone", comments: [] }, { description: "ticket text" }), "ticket text");
  assert.equal(asksOwner("Nothing for you here."), false);
  assert.equal(asksOwner("**TUC-1** (Paseo) is waiting for an answer: which one?"), true);
  assert.equal(asksOwner("Please reply yes and I'll proceed once you decide."), true, "the same detector write-back uses for a turn that ended by asking");
});

test("the answer goes to the live asking agent, to a continuation when the ticket's agent is gone, and to a comment otherwise", () => {
  assert.deepEqual(askRoute({ manual: false, asking: "a1", live: new Set(["a1"]), history: true }), { route: "agent", agentId: "a1" });
  assert.deepEqual(askRoute({ manual: false, asking: "a1", live: new Set(), history: true }), { route: "continue", agentId: null });
  assert.deepEqual(askRoute({ manual: false, asking: "a1", live: new Set(), history: false }), { route: "comment", agentId: null });
  assert.deepEqual(askRoute({ manual: true, asking: "a1", live: new Set(["a1"]), history: true }), { route: "comment", agentId: null }, "a manual task is the owner's own step");
  assert.deepEqual(askRoute({ manual: false, asking: null, live: new Set(["a1"]), history: true }), { route: "continue", agentId: null }, "without a record of who asked, the live agent is not the asker");
});

test("the answer text names each question with the owner's choice, then the note", () => {
  const questions = [
    { key: "q1", question: "Who takes TUC-1562?", options: [{ label: "Agent does it", description: "" }], multiSelect: false },
    { key: "q2", question: "Refresh live?", options: [], multiSelect: false },
  ];
  const input = { issueId: "i1", answers: { q1: "Agent does it", q2: "Yes, on open" }, note: "Mention it in the plan." };
  assert.equal(answerText({ questions }, input), "Who takes TUC-1562? → Agent does it\nRefresh live? → Yes, on open\nMention it in the plan.");
  assert.equal(deliveryText({ questions }, { ...input, note: "", answers: { q1: "Agent does it" } }), "Agent does it", "a bare answer reaches the agent as the exact option an “@paseo” reply would pick");
  assert.equal(deliveryText({ questions }, { ...input, answers: { q1: "Agent does it" } }), "Agent does it\n\nMention it in the plan.", "the owner's note is never dropped");
  assert.equal(deliveryText({ questions }, input), answerText({ questions }, input), "several answers go as one message");
});

test("an ask arrives unextracted (kind info, its title) and is extracted in the background", async () => {
  const record: HandoverRecord = { issueId: "p1", identifier: "TUC-1453", agentId: "a1", agentTitle: "agent", branch: null, worktreePath: null, lastCommit: null, summaries: [], links: {}, status: "waiting", progressCommentId: null, resumedFrom: null, updatedAt: at };
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    records: new Map([["p1", record]]),
    agents: [{ id: "a1", status: "running", createdAt: "2026-10-01T00:00:00.000Z", issueId: "p1" }],
    extraction: async () => ({ ok: true, value: { kind: "decision", summary: "The agent asks who takes TUC-1562.", questions: [{ key: "q1", question: "Who takes TUC-1562?", options: [{ label: "Agent does it", description: "" }], multiSelect: false }] } }),
  });
  const first = await h.ownerAsks.snapshot(h.paseo);
  assert.equal(first.asks.length, 1);
  assert.deepEqual(first.asks[0], {
    issueId: "i1", identifier: "TUC-1616", title: "Needs you: Decision for you: who takes TUC-1562?", url: "https://linear.app/tuchel/issue/TUC-1616",
    parentIdentifier: "TUC-1453", ticketIdentifier: "TUC-1453", kind: "info", summary: "Needs you: Decision for you: who takes TUC-1562?",
    questions: [], source: issue().description, route: "agent", agentId: "a1", extracted: false, updatedAt: "2026-10-09T11:00:00.000Z",
  });
  await until(() => h.extractedWith.length === 1);
  assert.deepEqual(h.extractedWith, [{ identifier: "TUC-1616", kind: "needs-you" }], "the extraction reads the sub-issue's description");
  const second = await untilAsk(h, (ask) => ask.extracted);
  assert.equal(second.extracted, true);
  assert.equal(second.kind, "decision");
  assert.equal(second.summary, "The agent asks who takes TUC-1562.");
  assert.deepEqual(second.questions, [{ key: "q1", question: "Who takes TUC-1562?", options: [{ label: "Agent does it", description: "" }], multiSelect: false }]);
  h.ownerAsks.stop();
});

test("a failing extraction leaves the ask unextracted without blocking the read, and is retried with backoff", async () => {
  let release: (() => void) | null = null;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const h = await setup({
    issues: [issue({ id: "i2", identifier: "TUC-1784", title: "Telegram bot: rotate token", parentId: null, parentIdentifier: null, labels: ["paseo-manual"] })],
    extraction: async () => { calls++; await pending; return { ok: false, reason: "the extraction returned no summary" }; },
  });
  const stored = async (): Promise<{ attempts?: number; nextAt?: string | null; result?: unknown }> =>
    JSON.parse(await readFile(join(h.directory, "extract", "i2.json"), "utf8").catch(() => "{}"));
  const asks = await h.ownerAsks.snapshot(h.paseo);
  assert.equal(asks.asks[0].extracted, false, "the read never waits for the model");
  assert.equal(asks.asks[0].kind, "info");
  assert.equal(asks.asks[0].summary, "Telegram bot: rotate token");
  assert.equal(asks.asks[0].route, "comment", "a manual task is the owner's own step");
  await until(() => calls === 1);
  release!();
  await untilAsync(async () => (await stored()).attempts === 1);
  assert.equal((await stored()).nextAt, "2026-10-09T12:00:15.000Z", "the failed attempt records when it may be retried");
  h.state.now += 15_000;
  await untilAsync(async () => { await h.ownerAsks.snapshot(h.paseo); return calls === 2; }, 10_000);
  await untilAsync(async () => (await stored()).attempts === 2);
  assert.equal((await stored()).result, null, "a failing extraction lands no value");
  h.ownerAsks.stop();
});

test("an answer is delivered once per issue and answer text, however often it is sent", async () => {
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    records: new Map([["p1", null]]),
    agents: [{ id: "a1", status: "running", createdAt: "2026-10-01T00:00:00.000Z", issueId: "p1" }],
  });
  const input = { issueId: "i1", answers: { q1: "Agent does it" }, note: "" };
  const [first, second] = await Promise.all([h.ownerAsks.answer(input, h.paseo), h.ownerAsks.answer(input, h.paseo)]);
  assert.deepEqual(first, second);
  assert.equal(h.delivered.length, 1, "a double click is one delivery");
  assert.deepEqual(await h.ownerAsks.answer(input, h.paseo), first, "and a repeat reports what happened the first time");
  assert.equal(h.delivered.length, 1);
  assert.deepEqual(h.delivered[0].origin, { ref: h.delivered[0].origin.ref, responder: { kind: "owner", via: "menu-bar", activityId: "owner-ask:i1", userId: "owner-1" }, issueId: "i1" });
  assert.match(h.delivered[0].message, /Agent does it/);
  assert.ok(h.events.some((event) => event.startsWith("comment i1: Answered from the menu bar:")));

  const other = await h.ownerAsks.answer({ issueId: "i1", answers: { q1: "You or the team" } }, h.paseo);
  assert.equal(other.delivered, "agent");
  assert.equal(h.delivered.length, 2, "a different answer is a new delivery");
  h.ownerAsks.stop();
});

test("an answered ask stays out of the read until Linear says something new, across a reload", async () => {
  const h = await setup({
    issues: [issue({ id: "i3", identifier: "TUC-1015", title: "Post-Sale C2", parentId: "p3", parentIdentifier: "TUC-33", labels: [] })],
    comments: new Map([["i3", [comment("c1", waitComment)]]]),
    records: new Map([["p3", null]]),
  });
  assert.equal((await h.ownerAsks.snapshot(h.paseo)).asks.length, 1);
  await h.ownerAsks.answer({ issueId: "i3", answers: { q1: "Yes, on open" }, note: "" }, h.paseo);
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).asks, [], "the answer hides the ask at once");
  h.state.now += ANSWER_HIDE_MS - 1_000;
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).asks, [], "the plugin's own record comment and state move do not resurrect it");
  // A reload of the plugin: the answered set comes back from the ledger.
  const reloaded = new OwnerAsks(h.deps);
  assert.deepEqual((await reloaded.snapshot(h.paseo)).asks, []);
  // Linear moved on: the ask is new again.
  h.state.issues = [issue({ id: "i3", identifier: "TUC-1015", title: "Post-Sale C2", parentId: "p3", parentIdentifier: "TUC-33", labels: [], updatedAt: new Date(NOW + ANSWER_HIDE_MS + 60_000).toISOString() })];
  assert.equal((await reloaded.snapshot(h.paseo)).asks.length, 1);
  reloaded.stop();
  h.ownerAsks.stop();
});

test("answering a Needs-you sub-issue whose agent is gone continues the ticket with the answer and closes the sub-issue", async () => {
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    records: new Map([["p1", null]]),
    agents: [{ id: "a1", status: "closed", createdAt: "2026-10-01T00:00:00.000Z", issueId: "p1" }],
  });
  const asks = await h.ownerAsks.snapshot(h.paseo);
  assert.equal(asks.asks[0].route, "continue");
  const result = await h.ownerAsks.answer({ issueId: "i1", answers: { q1: "Agent does it" }, note: "" }, h.paseo);
  assert.equal(result.delivered, "continued");
  assert.deepEqual(h.continued, [{ issueId: "p1", identifier: "TUC-1453", lead: "Agent does it" }]);
  assert.ok(h.events.includes("needsYou.remove i1"));
  assert.ok(h.events.includes("complete i1"));
  assert.ok(h.events.some((event) => event.startsWith("comment p1: Answered from the menu bar: Agent does it")));
  h.ownerAsks.stop();
});

test("an answer whose ticket has no free agent slot joins the wait line with the answer instead of failing", async () => {
  const reason = "Queued: 2 of 2 ticket agents are working. It starts when one finishes.";
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    records: new Map([["p1", null]]),
    agents: [{ id: "a1", status: "closed", createdAt: "2026-10-01T00:00:00.000Z", issueId: "p1" }],
    continueOutcome: { kind: "deferred", reason },
  });
  await h.ownerAsks.snapshot(h.paseo);
  const result = await h.ownerAsks.answer({ issueId: "i1", answers: { q1: "Agent does it" }, note: "" }, h.paseo);
  assert.equal(result.delivered, "queued");
  assert.match(result.message, /TUC-1453 is in the wait line with your answer\. Queued: 2 of 2/);
  assert.ok(h.events.includes(`queue p1 TUC-1453 from owner-1: Agent does it (${reason})`), "the parent ticket waits, with the owner's answer as its lead");
  assert.ok(h.events.includes("needsYou.remove i1"), "the sub-issue is answered");
  assert.ok(h.events.some((event) => event.startsWith("comment p1: Answered from the menu bar: Agent does it")));
  h.ownerAsks.stop();
});

test("an answer that can neither start an agent nor join the wait line fails and changes nothing in Linear", async () => {
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    records: new Map([["p1", null]]),
    agents: [{ id: "a1", status: "closed", createdAt: "2026-10-01T00:00:00.000Z", issueId: "p1" }],
    continueOutcome: { kind: "deferred", reason: "Queued: 1 of 1 ticket agents are working." },
    queueError: "Linear did not create an agent session on the ticket.",
  });
  await h.ownerAsks.snapshot(h.paseo);
  await assert.rejects(() => h.ownerAsks.answer({ issueId: "i1", answers: { q1: "Agent does it" }, note: "" }, h.paseo), /TUC-1453 cannot start an agent now \(Queued: 1 of 1.*could not join the wait line: Linear did not create/);
  assert.deepEqual(h.events, [], "no comment, no closed sub-issue");
  h.ownerAsks.stop();
});

test("a ticket under an epic is its own ticket: its gone agent's answer continues it, not the epic", async () => {
  const record: HandoverRecord = { issueId: "i3", identifier: "TUC-1015", agentId: "a3", agentTitle: "agent", branch: null, worktreePath: null, lastCommit: null, summaries: [], links: {}, status: "waiting", progressCommentId: null, resumedFrom: null, updatedAt: at };
  const h = await setup({
    issues: [issue({ id: "i3", identifier: "TUC-1015", title: "Post-Sale C2", parentId: "p3", parentIdentifier: "TUC-33", labels: [] })],
    comments: new Map([["i3", [comment("c1", waitComment)]]]),
    records: new Map([["i3", record]]),
    agents: [{ id: "a3", status: "closed", createdAt: "2026-10-01T00:00:00.000Z", issueId: "i3" }],
  });
  const [ask] = (await h.ownerAsks.snapshot(h.paseo)).asks;
  assert.equal(ask.ticketIdentifier, "TUC-1015");
  assert.equal(ask.parentIdentifier, "TUC-33");
  assert.equal(ask.route, "continue");
  await h.ownerAsks.answer({ issueId: "i3", answers: { q1: "Yes" }, note: "" }, h.paseo);
  assert.deepEqual(h.continued.map(({ issueId, identifier }) => ({ issueId, identifier })), [{ issueId: "i3", identifier: "TUC-1015" }]);
  assert.ok(h.events.some((event) => event.startsWith("comment i3: Answered from the menu bar:")));
  h.ownerAsks.stop();
});

test("a manual ask's Done completes the issue; a ticket's Done only comments and leaves the state to the agent", async () => {
  const h = await setup({
    issues: [
      issue({ id: "i1", identifier: "TUC-1784", title: "Telegram bot: rotate token", parentId: null, parentIdentifier: null, labels: ["paseo-manual"] }),
      issue({ id: "i2", identifier: "TUC-1015", title: "Post-Sale C2", parentId: "p3", parentIdentifier: "TUC-33", labels: [] }),
    ],
    comments: new Map([["i2", [comment("c1", waitComment)]]]),
  });
  const done = await h.ownerAsks.answer({ issueId: "i1", answers: {}, note: "", done: true }, h.paseo);
  assert.equal(done.delivered, "closed");
  assert.ok(h.events.includes("complete i1"));
  const ticket = await h.ownerAsks.answer({ issueId: "i2", answers: { q1: "Yes" }, note: "", done: true }, h.paseo);
  assert.equal(ticket.delivered, "comment");
  assert.ok(h.events.some((event) => event.startsWith("comment i2: Answered from the menu bar:")));
  assert.equal(h.events.filter((event) => event.startsWith("complete")).length, 1, "a parent ticket keeps its state");
  h.ownerAsks.stop();
});

test("an answer with nothing to say, and an ask that is not waiting any more, are refused with a sentence", async () => {
  const h = await setup({ issues: [issue()] });
  await assert.rejects(() => h.ownerAsks.answer({ issueId: "i1", answers: {}, note: "" }, h.paseo), /Nothing to answer/);
  await assert.rejects(() => h.ownerAsks.answer({ issueId: "gone", answers: { q1: "x" }, note: "" }, h.paseo), /not waiting for you in Linear any more/);
  h.ownerAsks.stop();
});
