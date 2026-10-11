import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { HandoverRecord } from "./handover";
import type { OwnerAskComment, OwnerAskIssue } from "./linear";
import { answerText, asksOwner, askRoute, deliveryText, OwnerAsks, selectAskText, type AnswerAskInput, type ContinueOutcome, type OwnerAsksDeps } from "./owner-asks";
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

type Harness = {
  ownerAsks: OwnerAsks; paseo: PaseoApi; directory: string; events: string[]; deps: OwnerAsksDeps;
  delivered: { agentId: string; message: string; origin: DeliveryOrigin }[];
  continued: { issueId: string; identifier: string; lead: string; decision: { id: string; intent?: "triage" } }[];
  queued: { text: string; from: { activityId: string; userId: string; intent?: "triage" } }[];
  extractedWith: { identifier: string; kind: string }[];
  state: {
    issues: OwnerAskIssue[]; comments: Map<string, OwnerAskComment[]>;
    needsYou: { id: string; identifier: string; parentId: string; agentId: string }[];
    records: Map<string, HandoverRecord | null>; now: number; extraction: () => Promise<Extraction>;
  };
};

async function setup(options: {
  issues: OwnerAskIssue[];
  comments?: Map<string, OwnerAskComment[]>;
  needsYou?: { id: string; identifier: string; parentId: string; agentId: string }[];
  records?: Map<string, HandoverRecord | null>;
  agents?: { id: string; status: string; createdAt: string; issueId?: string }[];
  extraction?: () => Promise<Extraction>;
  continueOutcome?: ContinueOutcome;
  queueError?: string;
} = { issues: [] }): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "owner-asks-"));
  const events: string[] = [];
  const extractedWith: { identifier: string; kind: string }[] = [];
  const state = {
    issues: options.issues,
    comments: options.comments ?? new Map<string, OwnerAskComment[]>(),
    needsYou: options.needsYou ?? [],
    records: options.records ?? new Map<string, HandoverRecord | null>(),
    now: NOW,
    extraction: options.extraction ?? (async (): Promise<Extraction> => ({ ok: true, value: { kind: "decision", summary: "Choose the scope.", questions: [{ key: "q1", question: "Which scope?", options: [{ label: "Agent does it", description: "Only the approved ticket scope." }, { label: "You or the team", description: "" }], multiSelect: false }] } })),
  };
  const delivered: { agentId: string; message: string; origin: DeliveryOrigin }[] = [];
  const continued: { issueId: string; identifier: string; lead: string; decision: { id: string; intent?: "triage" } }[] = [];
  const queued: { text: string; from: { activityId: string; userId: string; intent?: "triage" } }[] = [];
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
    remoteAgent: async () => false,
    labels: async () => ({ needsYou: "paseo-needs-you", manual: "paseo-manual" }),
    resolveModel: async () => "omp/test-model",
    extract: async (input) => { extractedWith.push({ identifier: input.identifier, kind: input.kind }); return state.extraction(); },
    deliver: async (_paseo, agentId, message, origin) => {
      delivered.push({ agentId, message, origin });
      return { status: "applied", reply: null, delivered: true, at } as DeliveryResult;
    },
    continueTicket: async (issueId, identifier, lead, decision) => { continued.push({ issueId, identifier, lead, decision }); return options.continueOutcome ?? { kind: "started" }; },
    queueAnswer: async (issueId, identifier, text, from, reason) => {
      if (options.queueError) throw new Error(options.queueError);
      events.push(`queue ${issueId} ${identifier} from ${from.userId}: ${text} (${reason})`);
      queued.push({ text, from });
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
  return { ownerAsks, paseo, directory, events, delivered, continued, queued, extractedWith, deps, state };
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

const inputFor = async (h: Harness, issueId = "i1", answers: Record<string, string> = { q1: "Agent does it" }, extra: Pick<AnswerAskInput, "note" | "done"> = {}): Promise<AnswerAskInput> => {
  let ask: OwnerAsk | undefined;
  await untilAsync(async () => {
    ask = (await h.ownerAsks.snapshot(h.paseo)).asks.find((item) => item.issueId === issueId);
    return Boolean(ask?.extracted);
  });
  return { issueId, revision: ask!.revision, answers, ...extra };
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
  const input = { issueId: "i1", revision: "r1", answers: { q1: "Agent does it", q2: "Yes, on open" }, note: "Mention it in the plan." };
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
  assert.equal(first.asks[0].attention, "owner", "pending extraction must not move the ask out of the inbox");
  assert.equal(first.asks[0].extracted, false);
  assert.equal(first.asks[0].route, "agent");
  assert.equal(first.asks[0].source, issue().description);
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

test("exact answer retries deliver once, persist full scope and survive restart and a new question", async (t) => {
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    agents: [{ id: "a1", status: "running", createdAt: at, issueId: "p1" }],
  });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h, "i1", { q1: "You or the team" }, { note: "Do not deploy." });
  const [first, duplicate] = await Promise.all([h.ownerAsks.answer(input, h.paseo), h.ownerAsks.answer(input, h.paseo)]);
  assert.deepEqual(duplicate, first);
  assert.equal(first.delivered, "agent");
  assert.equal(h.delivered.length, 1);
  const snapshot = await h.ownerAsks.snapshot(h.paseo);
  assert.deepEqual(snapshot.asks, []);
  assert.equal(snapshot.history.length, 1);
  const receipt = snapshot.history[0];
  assert.equal(receipt.revision, input.revision);
  assert.equal(receipt.action, "answer");
  assert.ok(receipt.text.includes(issue().description), "receipt keeps exact source, including choices not selected");
  assert.match(receipt.text, /Which scope\? → You or the team\nDo not deploy\./);
  assert.match(receipt.text, /Only the approved ticket scope/);
  assert.equal(receipt.delivery, "agent");
  h.state.issues[0] = { ...h.state.issues[0], description: "May I deploy to production now?" };
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  assert.deepEqual(await reloaded.answer(input, h.paseo), first, "retry reports old success, never applies it to the new question");
  assert.equal(h.delivered.length, 1);
  const next = await reloaded.snapshot(h.paseo);
  assert.equal(next.asks.length, 1);
  assert.notEqual(next.asks[0].revision, input.revision);
  assert.deepEqual(next.history, snapshot.history);
});

test("source edits without updatedAt changes and changed extraction payloads reject stale answers", async (t) => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  const oldTimestamp = h.state.issues[0].updatedAt;
  const path = join(h.directory, "extract", "i1.json");
  const cached = JSON.parse(await readFile(path, "utf8"));
  cached.result.questions[0].options[0].description = "New authority: deploy everywhere";
  await writeFile(path, JSON.stringify(cached));
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  await assert.rejects(reloaded.answer(input, h.paseo), /ask changed/);
  assert.equal(h.state.issues[0].updatedAt, oldTimestamp);
  h.state.issues[0] = { ...h.state.issues[0], description: "Please approve deleting the production database." };
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /ask changed/);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual((await reloaded.snapshot(h.paseo)).history, []);
});

test("an edited wait comment and a new comment with identical wording change the source revision", async (t) => {
  const h = await setup({
    issues: [issue({ title: "Ticket", labels: [], parentId: null })],
    comments: new Map([["i1", [comment("c1", waitComment)]]]),
  });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  h.state.comments.set("i1", [comment("c1", waitComment.replace("block refresh live", "production database be deleted"))]);
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /ask changed/);
  h.state.comments.set("i1", [comment("c2", waitComment)]);
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /ask changed/);
  assert.deepEqual(h.events, []);
});

test("pending-to-extracted transition changes revision; unknown question keys never become free-form approvals", async (t) => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const pending = (await h.ownerAsks.snapshot(h.paseo)).asks[0];
  const input = await inputFor(h);
  assert.notEqual(pending.revision, input.revision);
  await assert.rejects(h.ownerAsks.answer({ ...input, revision: pending.revision }, h.paseo), /ask changed/);
  await assert.rejects(h.ownerAsks.answer({ ...input, answers: { q99: "Approve everything" } }, h.paseo), /Unknown question key/);
  assert.deepEqual(h.events, []);
});

test("trailing comment failure retries effects only, including after restart", async (t) => {
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    agents: [{ id: "a1", status: "running", createdAt: at, issueId: "p1" }],
  });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  const comment = h.deps.linear.comment;
  h.deps.linear.comment = async () => { throw new Error("Linear comment unavailable"); };
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /Linear comment unavailable/);
  assert.equal(h.delivered.length, 1);
  assert.equal((await h.ownerAsks.snapshot(h.paseo)).history[0].delivery, "agent");
  h.deps.linear.comment = comment;
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  assert.equal((await reloaded.answer(input, h.paseo)).delivered, "agent");
  assert.equal(h.delivered.length, 1);
  assert.equal(h.events.filter((event) => event.startsWith("comment ")).length, 1);
});

test("history read failures fail closed, and a failed initial write cannot deliver", async (t) => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  const path = join(h.directory, "decisions.json");
  await mkdir(path);
  await assert.rejects(h.ownerAsks.answer(input, h.paseo));
  assert.deepEqual(h.events, []);
  await rm(path, { recursive: true });
  await writeFile(path, "{bad json");
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  await assert.rejects(reloaded.snapshot(h.paseo));
  await assert.rejects(reloaded.answer(input, h.paseo));
  assert.deepEqual(h.events, []);
});

test("a receipt write failure after external delivery remains unconfirmed and never resends", async (t) => {
  const h = await setup({
    issues: [issue()],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    agents: [{ id: "a1", status: "running", createdAt: at, issueId: "p1" }],
  });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  const deliver = h.deps.deliver;
  const path = join(h.directory, "decisions.json");
  const reserved = join(h.directory, "reserved.json");
  h.deps.deliver = async (...args) => {
    const result = await deliver(...args);
    await rename(path, reserved);
    await mkdir(path);
    return result;
  };
  await assert.rejects(h.ownerAsks.answer(input, h.paseo));
  assert.equal(h.delivered.length, 1);
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /unconfirmed/);
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).history, [], "a failed journal commit is not reported as success");
  await rm(path, { recursive: true });
  await rename(reserved, path);
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  await assert.rejects(reloaded.answer(input, h.paseo), /unconfirmed/);
  assert.equal(h.delivered.length, 1);
});

test("continuation and queued answers carry the exact scoped receipt and close only the answered sub-issue", async (t) => {
  for (const outcome of [{ kind: "started" }, { kind: "deferred", reason: "No free agent slot." }, { kind: "forwarded", peer: "other-host" }] as const) {
    const h = await setup({
      issues: [issue()],
      needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "gone" }],
      continueOutcome: outcome,
    });
    t.after(() => h.ownerAsks.stop());
    const input = await inputFor(h);
    const result = await h.ownerAsks.answer(input, h.paseo);
    assert.equal(result.delivered, outcome.kind === "deferred" ? "queued" : "continued");
    const receipt = (await h.ownerAsks.snapshot(h.paseo)).history[0];
    assert.equal(h.continued[0].lead, receipt.text);
    assert.equal(h.continued[0].issueId, "p1");
    assert.match(h.continued[0].lead, /Which scope\? → Agent does it/);
    if (outcome.kind === "deferred") assert.equal(h.queued[0].text, receipt.text);
    assert.ok(h.events.includes("complete i1"));
    assert.ok(h.events.includes("needsYou.remove i1"));
    await h.ownerAsks.answer(input, h.paseo);
    assert.equal(h.continued.length, 1);
  }
});

test("failed continuation/queue has no completion or delivered receipt", async (t) => {
  for (const failQueue of [false, true]) {
    const h = await setup({
      issues: [issue()], needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "gone" }],
      continueOutcome: failQueue ? { kind: "deferred", reason: "No slot." } : { kind: "failed", reason: "Start failed" },
      queueError: failQueue ? "Queue unavailable" : undefined,
    });
    t.after(() => h.ownerAsks.stop());
    const input = await inputFor(h);
    await assert.rejects(h.ownerAsks.answer(input, h.paseo), /Start failed|Queue unavailable/);
    assert.deepEqual(h.events, []);
    assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).history, []);
  }
});

test("a ticket under an epic continues itself, not the epic; queued source changes return immediately", async (t) => {
  const h = await setup({
    issues: [issue({ title: "Actual ticket", labels: [] })],
    agents: [{ id: "gone", status: "closed", createdAt: at, issueId: "i1" }],
    continueOutcome: { kind: "deferred", reason: "No slot" },
  });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  await h.ownerAsks.answer(input, h.paseo);
  assert.equal(h.continued[0].issueId, "i1");
  h.state.issues[0] = { ...h.state.issues[0], description: "Please choose a new production policy." };
  const next = await h.ownerAsks.snapshot(h.paseo);
  assert.equal(next.asks.length, 1, "queued older answers never hide new questions");
  assert.notEqual(next.asks[0].revision, input.revision);
});

test("manual Done completes only that task; a ticket Done comments without completing it", async (t) => {
  const h = await setup({ issues: [
    issue({ labels: ["paseo-manual"], title: "Rotate token" }),
    issue({ id: "i2", title: "Ticket", labels: [] }),
  ] });
  t.after(() => h.ownerAsks.stop());
  const manual = await inputFor(h, "i1", {}, { done: true });
  assert.equal((await h.ownerAsks.answer(manual, h.paseo)).delivered, "closed");
  const ticket = await inputFor(h, "i2", {}, { done: true });
  assert.equal((await h.ownerAsks.answer(ticket, h.paseo)).delivered, "comment");
  assert.deepEqual(h.events.filter((event) => event.startsWith("complete")), ["complete i1"]);
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).history.map((receipt) => receipt.action), ["done", "done"]);
});

test("research and delegate preserve open tasks, scope, disposition and history across restart", async (t) => {
  for (const action of ["research", "delegate"] as const) {
    for (const live of [false, true]) {
      const h = await setup({
        issues: [issue()],
        needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
        agents: live ? [{ id: "a1", status: "running", createdAt: at, issueId: "p1" }] : [],
        continueOutcome: { kind: "deferred", reason: "No slot." },
      });
      t.after(() => h.ownerAsks.stop());
      const ask = await inputFor(h);
      const input = { issueId: ask.issueId, revision: ask.revision, action, note: "Compare reversible cache implementations; do not deploy." };
      const result = await h.ownerAsks.triage(input, h.paseo);
      assert.equal(result.delivered, live ? "agent" : "queued");
      assert.deepEqual(h.events.filter((event) => /^(?:complete|needsYou.remove) /.test(event)), []);
      const snapshot = await h.ownerAsks.snapshot(h.paseo);
      assert.equal(snapshot.asks[0].disposition, action === "research" ? "research" : "delegated");
      assert.equal(snapshot.history[0].action, action);
      assert.match(snapshot.history[0].text, /Owner (?:instruction|scope): Compare reversible cache implementations/);
      assert.match(snapshot.history[0].text, /No unselected recommendation is accepted/);
      if (live) assert.equal(h.delivered[0].origin.intent, "triage");
      else {
        assert.equal(h.continued[0].decision.intent, "triage");
        assert.equal(h.queued[0].from.intent, "triage");
      }
      const reloaded = new OwnerAsks(h.deps);
      t.after(() => reloaded.stop());
      assert.deepEqual(await reloaded.triage(input, h.paseo), result);
      assert.equal(h.delivered.length + h.continued.length, 1);
      assert.deepEqual((await reloaded.snapshot(h.paseo)).history, snapshot.history);
      assert.equal((await reloaded.snapshot(h.paseo)).asks[0].disposition, snapshot.asks[0].disposition);
    }
  }
});

test("manual/comment-only research and delegate reject instead of claiming dispatch, even with recommendations", async (t) => {
  for (const manual of [false, true]) {
    const h = await setup({ issues: [issue({ title: "Rotate token", labels: manual ? ["paseo-manual"] : [] })] });
    t.after(() => h.ownerAsks.stop());
    const ask = await inputFor(h);
    for (const action of ["research", "delegate"] as const) {
      await assert.rejects(h.ownerAsks.triage({ issueId: "i1", revision: ask.revision, action, note: "" }, h.paseo), /explicit research instruction/);
      await assert.rejects(h.ownerAsks.triage({ issueId: "i1", revision: ask.revision, action, note: "Do the recommended thing" }, h.paseo), /no agent route/);
    }
    assert.deepEqual(h.events, []);
    assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).history, []);
  }
});

test("defer persists, expires, wakes on new source and reopen is local-only", async (t) => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const ask = await inputFor(h);
  const input = { issueId: "i1", revision: ask.revision, action: "defer" as const, until: new Date(NOW + 60_000).toISOString() };
  await h.ownerAsks.triage(input, h.paseo);
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  assert.equal((await reloaded.snapshot(h.paseo)).asks[0].disposition, "deferred");
  h.state.now += 60_000;
  assert.equal((await reloaded.snapshot(h.paseo)).asks[0].disposition, null);
  h.state.now = NOW;
  await reloaded.triage({ issueId: "i1", revision: ask.revision, action: "reopen" }, h.paseo);
  assert.equal((await reloaded.snapshot(h.paseo)).asks[0].disposition, null);
  await reloaded.triage(input, h.paseo);
  h.state.issues[0] = { ...h.state.issues[0], description: "A different question needs you now." };
  const changed = await reloaded.snapshot(h.paseo);
  assert.equal(changed.asks[0].disposition, null);
  assert.notEqual(changed.asks[0].revision, ask.revision);
  await assert.rejects(reloaded.triage({ issueId: "i1", revision: ask.revision, action: "reopen" }, h.paseo), /ask changed/);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(h.continued, []);
  assert.deepEqual(h.events, []);
});

test("defer rejects invalid/past expiry and empty answers never create receipts", async (t) => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const ask = await inputFor(h);
  for (const until of [undefined, "tomorrow", at]) {
    await assert.rejects(h.ownerAsks.triage({ issueId: "i1", revision: ask.revision, action: "defer", until }, h.paseo), /future ISO timestamp/);
  }
  await assert.rejects(h.ownerAsks.answer({ ...ask, answers: {} }, h.paseo), /Nothing to answer/);
  await assert.rejects(h.ownerAsks.answer({ ...ask, issueId: "gone" }, h.paseo), /not waiting for you in Linear/);
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).history, []);
});

test("canonical host routes a peer-owned ask through continuation even without local agent history", async (t) => {
  const h = await setup({ issues: [issue({ title: "Ticket", labels: [] })], continueOutcome: { kind: "forwarded", peer: "mac" } });
  t.after(() => h.ownerAsks.stop());
  h.deps.remoteAgent = async () => true;
  const input = await inputFor(h, "i1", { q1: "Approve" });
  const ask = (await h.ownerAsks.snapshot(h.paseo)).asks[0];
  assert.equal(ask.route, "continue");
  const result = await h.ownerAsks.answer(input, h.paseo);
  assert.equal(result.delivered, "continued");
  assert.equal(h.continued[0].issueId, "i1");
  assert.match(h.continued[0].lead, /^Approve\n\nDecision inbox/);
  assert.match(h.continued[0].lead, new RegExp(input.revision));
  assert.equal(h.delivered.length, 0);
  await h.ownerAsks.answer(input, h.paseo);
  assert.equal(h.continued.length, 1);
});

test("snapshot history caps at newest 100 while durable exact receipts are retained", async (t) => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const ask = await inputFor(h);
  for (let index = 0; index < 102; index++) {
    h.state.now++;
    await h.ownerAsks.triage({ issueId: "i1", revision: ask.revision, action: "reopen", note: `Review ${index}` }, h.paseo);
  }
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  const { history } = await reloaded.snapshot(h.paseo);
  assert.equal(history.length, 100);
  assert.match(history[0].text, /Owner note: Review 101/);
  assert.match(history[99].text, /Owner note: Review 2\b/);
  const persisted = JSON.parse(await readFile(join(h.directory, "decisions.json"), "utf8"));
  assert.equal(Object.keys(persisted.records).length, 102, "the API limit does not discard durable receipts");
});

test("an unfinished completion effect cannot close a revised ask when its delivered answer is retried", async (t) => {
  const h = await setup({
    issues: [issue()], needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "gone" }],
  });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  const remove = h.deps.needsYou.remove;
  h.deps.needsYou.remove = async () => { throw new Error("Tracking store unavailable"); };
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /Tracking store unavailable/);
  h.deps.needsYou.remove = remove;
  h.state.issues[0] = { ...h.state.issues[0], description: "May I deploy a different production change?" };
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  assert.equal((await reloaded.answer(input, h.paseo)).delivered, "continued");
  assert.equal(h.continued.length, 1);
  assert.deepEqual(h.events.filter((event) => /^(?:complete|needsYou.remove) /.test(event)), []);
  assert.equal((await reloaded.snapshot(h.paseo)).asks.length, 1);
});
