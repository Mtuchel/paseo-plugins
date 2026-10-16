import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { HandoverRecord } from "./handover";
import type { OwnerAskComment, OwnerAskIssue } from "./linear";
import { answerText, askRoute, deliveryText, extractionInputParts, OwnerAsks, ownerAsksPage, selectAskSources, type AnswerAskInput, type ContinueOutcome, type OwnerAsksDeps } from "./owner-asks";
import { answerAskRpc, ownerAsksRpc, triageAskRpc, type OwnerAsk } from "../shared/contracts";
import { isSourceReview, type BrowserOwnerAsk } from "../shared/decision-inbox";
import { checkExtraction, type ExtractInput, type Extraction } from "./owner-ask-extract";
import { askContext, askTimeline, type AskContext, type AskSource } from "./owner-ask-admission";
import { PermissionReplies, type DeliveryOrigin, type DeliveryResult } from "./permission-replies";
import { NeedsYouIssues } from "./needs-you";

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
    records: Map<string, HandoverRecord | null>; now: number; extraction: (input: ExtractInput) => Promise<Extraction>;
  };
};

async function setup(options: {
  issues: OwnerAskIssue[];
  comments?: Map<string, OwnerAskComment[]>;
  needsYou?: { id: string; identifier: string; parentId: string; agentId: string }[];
  records?: Map<string, HandoverRecord | null>;
  agents?: { id: string; status: string; createdAt: string; issueId?: string; pending?: boolean }[];
  extraction?: (input: ExtractInput) => Promise<Extraction>;
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
      // Every comment present counts as changed; like Linear, a deleted one is not reported.
      ownerAskCommentChanges: async (ids) => new Map(ids.flatMap((id) => state.comments.has(id) ? [[id, state.comments.get(id)!] as const] : [])),
      commentBody: async (id) => [...state.comments.values()].flat().find((entry) => entry.id === id)?.body ?? null,
      comment: async (issueId, body) => { events.push(`comment ${issueId}: ${body}`); },
      complete: async (issueId) => { events.push(`complete ${issueId}`); },
      viewerId: async () => "owner-1",
    },
    needsYou: { all: async () => state.needsYou, allStrict: async () => state.needsYou, remove: async (id) => { events.push(`needsYou.remove ${id}`); } },
    handover: { read: async (issueId) => state.records.get(issueId) ?? null },
    remoteAgent: async () => false,
    labels: async () => ({ needsYou: "paseo-needs-you", manual: "paseo-manual" }),
    resolveModel: async () => "omp/test-model",
    extract: async (input) => { extractedWith.push({ identifier: input.identifier, kind: input.kind }); return state.extraction(input); },
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
        entries: (options.agents ?? []).map((agent) => ({ agent: { id: agent.id, status: agent.status, createdAt: agent.createdAt, labels: agent.issueId ? { "linear.issueId": agent.issueId } : {}, pendingPermissions: agent.pending ? [{ id: "q", provider: "omp", name: "ask", kind: "question" }] : [] } })),
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

// Re-read the requested source until its background extraction has landed.
const untilAsk = async (h: Harness, predicate: (ask: BrowserOwnerAsk) => boolean): Promise<BrowserOwnerAsk> => {
  const deadline = Date.now() + 5_000;
  let ask: BrowserOwnerAsk | undefined;
  while (Date.now() < deadline) {
    ask = (await h.ownerAsks.snapshot(h.paseo)).asks.find(predicate);
    if (ask) return ask;
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

test("a retired request loses urgency without deleting its source or authorizing a repeated answer", async (t) => {
  const record = (kind: "request" | "turn-end"): HandoverRecord => ({ issueId: "i1", identifier: "TUC-1616", agentId: "a1", agentTitle: "agent", branch: null, worktreePath: null, lastCommit: null, summaries: [], links: {}, status: "waiting", progressCommentId: null, resumedFrom: null, updatedAt: at, waiting: { previousStateId: "ip", commentId: "c1", kind, at } });
  const agents = [{ id: "a1", status: "idle", createdAt: at, issueId: "i1", pending: true }];
  const h = await setup({
    issues: [issue({ title: "Ticket", description: "", labels: [], parentId: null })],
    comments: new Map([["i1", [comment("c1", waitComment)]]]),
    records: new Map([["i1", record("request")]]),
    agents,
  });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).asks.map((ask) => [ask.issueId, ask.route, ask.mirrorsLiveRequest]), [["i1", "agent", true]]);
  agents[0].pending = false;
  const retired = (await h.ownerAsks.snapshot(h.paseo)).asks;
  assert.deepEqual(retired.map(ask => [ask.sourceId, ask.attention, ask.mirrorsLiveRequest]), [["c1", "info", false]]);
  assert.equal(retired[0].source, waitComment, "original request remains available for source review");
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /not waiting for you/);
  assert.deepEqual(h.delivered, []);
  // A wait the agent opened by ending its turn with a question has no request to answer: it stays.
  h.state.records.set("i1", record("turn-end"));
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).asks.map((ask) => [ask.issueId, ask.mirrorsLiveRequest]), [["i1", false]]);
});

test("independently current business evidence survives a retired request without resurrecting its dispatch", async t => {
  const question = "Which contracted quantity is authorized for this shipment?";
  const corroboration = "Source c1 still needs the owner's contracted quantity decision; no quantity has been authorized.";
  const h = await setup({
    issues: [issue({ title: "Shipment", status: "In progress", description: "", labels: [], parentId: null })],
    comments: new Map([["i1", [comment("c1", question), comment("c2", corroboration, at)]]]),
    records: new Map([["i1", { issueId: "i1", identifier: "TUC-1616", agentId: "a1", agentTitle: "agent",
      branch: null, worktreePath: null, lastCommit: null, summaries: [], links: {}, status: "waiting",
      progressCommentId: null, resumedFrom: null, updatedAt: at,
      waiting: { previousStateId: "ip", commentId: "c1", kind: "request", at } }]]),
    agents: [{ id: "a1", status: "idle", createdAt: at, issueId: "i1", pending: false }],
    extraction: async input => checkExtraction(JSON.stringify({
      kind: "info", summary: "The contract fact is unresolved, independently of the old daemon request.",
      assessment: input.context?.sourceId === "c1" ? {
        state: "owner", ownerBoundary: "business", reason: "A later source explicitly confirms the original contract decision remains unresolved.",
        evidence: [{ sourceId: "c1", quote: question }, { sourceId: "c2", quote: corroboration }],
      } : { state: "info", reason: "Corroborates the original decision.", evidence: [{ sourceId: "c2", quote: corroboration }] },
    }), input.text, input.context),
  });
  t.after(() => h.ownerAsks.stop());
  let current: OwnerAsk | undefined;
  await untilAsync(async () => {
    current = (await h.ownerAsks.snapshot(h.paseo)).asks.find(ask => ask.sourceId === "c1" && ask.extracted);
    return current !== undefined;
  });
  assert.equal(current?.attention, "owner");
  assert.equal(current?.mirrorsLiveRequest, false);
  await assert.rejects(h.ownerAsks.answer({
    issueId: "i1", sourceId: "c1", revision: current!.revision, answers: {}, note: "Must not reuse the retired request",
  }, h.paseo), /not waiting for you/);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(h.continued, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual((await h.ownerAsks.snapshot(h.paseo)).history, []);
});

test("an unrelated pending live request cannot veto cited resolution of an older wait source", async t => {
  const old = "Which contract quantity applies to this shipment?";
  const answer = "For source original: Which contract quantity applies to this shipment? Owner answered 12 pallets; this request is resolved.";
  const h = await setup({
    issues: [issue({ title: "Shipment", description: "", labels: [], parentId: null })],
    comments: new Map([["i1", [comment("original", old), comment("answer", answer, at)]]]),
    records: new Map([["i1", { issueId: "i1", identifier: "TUC-1616", agentId: "a1", agentTitle: "agent",
      branch: null, worktreePath: null, lastCommit: null, summaries: [], links: {}, status: "waiting",
      progressCommentId: null, resumedFrom: null, updatedAt: at,
      waiting: { previousStateId: "ip", commentId: "original", kind: "request", at } }]]),
    agents: [{ id: "a1", status: "idle", createdAt: at, issueId: "i1", pending: true }],
    extraction: async input => checkExtraction(JSON.stringify({
      kind: "info", summary: "Earlier source resolved; no assumption about another live request.",
      assessment: input.context?.sourceId === "original" ? {
        state: "resolved", reason: "Later owner answer explicitly identifies this original question.",
        relatedSourceId: "answer", evidence: [{ sourceId: "original", quote: old }, { sourceId: "answer", quote: answer }],
      } : { state: "info", reason: "Resolution receipt.", evidence: [{ sourceId: "answer", quote: answer }] },
    }), input.text, input.context),
  });
  t.after(() => h.ownerAsks.stop());
  let asks: OwnerAsk[] = [];
  await untilAsync(async () => {
    asks = (await h.ownerAsks.snapshot(h.paseo)).asks;
    return asks.length === 2 && asks.every(ask => ask.extracted);
  });
  assert.equal(asks.find(ask => ask.sourceId === "original")?.attention, "info");
  const original = asks.find(ask => ask.sourceId === "original")!;
  await assert.rejects(h.ownerAsks.answer({ issueId: "i1", sourceId: "original", revision: original.revision, answers: {}, note: "Re-answer old quantity" }, h.paseo), /reconciled/);
  assert.deepEqual(h.delivered, []);
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
  const complete = h.deps.linear.complete;
  h.deps.linear.complete = async () => { throw new Error("Completion unavailable"); };
  await assert.rejects(h.ownerAsks.answer(input, h.paseo));
  h.deps.linear.complete = complete;
  h.state.issues[0] = { ...h.state.issues[0], description: "May I deploy a different production change?" };
  const reloaded = new OwnerAsks(h.deps);
  t.after(() => reloaded.stop());
  assert.equal((await reloaded.answer(input, h.paseo)).delivered, "continued");
  assert.equal(h.continued.length, 1);
  assert.deepEqual(h.events.filter((event) => /^(?:complete|needsYou.remove) /.test(event)), []);
  assert.equal((await reloaded.snapshot(h.paseo)).asks.length, 1);
});

test("normal issue questions and recovery comments remain independent without a live agent", async t => {
  const normal = issue({ title: "Rollout policy", labels: [], parentId: null, description: "Which rollout policy?", status: "In Progress" });
  const h = await setup({ issues: [normal], comments: new Map([["i1", [
    comment("recovery", "Which replacement generation should recover the job?"),
    comment("pricing", "Which pricing policy should this use?"),
  ]]]) });
  t.after(() => h.ownerAsks.stop());
  h.deps.issues = async () => h.state.issues;
  h.deps.linear.ownerAskIssues = async () => { throw new Error("the narrow reader must not be used"); };
  await untilAsync(async () => {
    const asks = (await h.ownerAsks.snapshot(null)).asks;
    return asks.length === 3 && asks.every(ask => ask.extracted);
  });
  const snapshot = await h.ownerAsks.snapshot(null);
  assert.deepEqual(snapshot.coverage, []);
  assert.deepEqual(new Set(snapshot.asks.map(ask => ask.sourceId)), new Set(["description", "recovery", "pricing"]));
  assert.ok(snapshot.asks.every(ask => ask.route === "comment"));
  const recovery = snapshot.asks.find(ask => ask.sourceId === "recovery")!;
  await h.ownerAsks.answer({ issueId: recovery.issueId, revision: recovery.revision, answers: { q1: "Agent does it" } }, null);
  assert.deepEqual(new Set((await h.ownerAsks.snapshot(null)).asks.map(ask => ask.sourceId)), new Set(["description", "pricing"]));
  assert.equal(h.delivered.length, 0);
  assert.equal(h.continued.length, 0);
  const pricing = snapshot.asks.find(ask => ask.sourceId === "pricing")!;
  h.state.comments.get("i1")!.find(comment => comment.id === "pricing")!.body = "Which production deletion policy should this use?";
  await assert.rejects(h.ownerAsks.answer({ issueId: pricing.issueId, revision: pricing.revision, answers: { q1: "Agent does it" } }, null), /ask changed/);
  assert.equal(h.events.filter(event => event.startsWith("comment ")).length, 1);
});

test("source collection deduplicates comment IDs, not wording or ticket identity", () => {
  const text = "Which policy?";
  const sources = selectAskSources({ comments: [comment("c1", text), comment("c1", text), comment("c2", text)] }, { description: text });
  assert.deepEqual(sources.map(source => source.sourceId), ["description", "c1", "c2"]);
});

test("an unconfirmed owner delivery remains visible and cannot be bypassed by changing the answer", async t => {
  const h = await setup({ issues: [issue()], agents: [{ id: "a1", status: "running", createdAt: at, issueId: "p1" }],
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }] });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  let deliveries = 0;
  h.deps.deliver = async () => { deliveries++; throw new Error("transport disconnected after submission"); };
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /transport disconnected/);
  const snapshot = await h.ownerAsks.snapshot(h.paseo);
  assert.equal(snapshot.asks[0].deliveryUnknown, true);
  await assert.rejects(h.ownerAsks.answer({ ...input, answers: { q1: "You or the team" } }, h.paseo), /unconfirmed/);
  await assert.rejects(h.ownerAsks.triage({ issueId: input.issueId, revision: input.revision, action: "defer", until: new Date(NOW + 60_000).toISOString() }, h.paseo), /unconfirmed/);
  assert.equal(deliveries, 1);
});

test("a manual label alone does not make unresolved extraction urgent human work", async t => {
  const h = await setup({ issues: [issue({ title: "Scoped staging setup", labels: ["paseo-manual"], description: "Use the existing scoped staging role." })],
    extraction: async () => ({ ok: false, reason: "extraction unavailable" }) });
  t.after(() => h.ownerAsks.stop());
  const snapshot = await h.ownerAsks.snapshot(null);
  assert.deepEqual(snapshot.asks.map(ask => ({ kind: ask.kind, attention: ask.attention, extracted: ask.extracted, source: ask.source })),
    [{ kind: "manual", attention: "info", extracted: false, source: "Use the existing scoped staging role." }]);
});

test("overlapping menu reads share work but explicit refresh and owner-action invalidation read current sources", async t => {
  const h = await setup({ issues: [issue({ title: "Original scope" })] });
  h.ownerAsks.stop();
  t.after(() => rm(h.directory, { recursive: true, force: true }));
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0;
  h.deps.handover.read = async () => {
    if (++reads === 1) { entered(); await held; }
    return null;
  };
  const first = h.ownerAsks.snapshot(null);
  await started;
  const shared = h.ownerAsks.snapshot(null);
  h.state.issues = [issue({ title: "Changed material scope" })];
  const refreshed = await h.ownerAsks.snapshot(null, true);
  assert.equal(refreshed.asks[0].title, "Changed material scope");
  await assert.rejects(h.ownerAsks.answer({ issueId: "i1", revision: "stale", answers: {} }, null), /ask changed/);
  const current = await h.ownerAsks.snapshot(null);
  assert.equal(current.asks[0].title, "Changed material scope");
  release();
  const [original, joined] = await Promise.all([first, shared]);
  assert.equal(original.asks[0].title, "Original scope");
  assert.deepEqual(joined, original);
  assert.equal(reads, 4, "the two overlapping menu reads must not duplicate collection");
  assert.deepEqual(h.events, []);
  assert.equal((await h.ownerAsks.snapshot(null)).asks[0].revision, current.asks[0].revision);
});

test("failed shared collection does not prevent a repaired inbox from being read", async t => {
  const h = await setup({ issues: [issue()] });
  h.ownerAsks.stop();
  t.after(() => rm(h.directory, { recursive: true, force: true }));
  h.deps.handover.read = async () => { throw new Error("temporary read failure"); };
  await assert.rejects(h.ownerAsks.snapshot(null), /temporary read failure/);
  h.deps.handover.read = async () => null;
  const repaired = await h.ownerAsks.snapshot(null);
  assert.equal(repaired.asks[0].sourceId, "description");
  assert.equal(repaired.asks[0].source, h.state.issues[0].description);
  assert.deepEqual(h.events, []);
});

test("owner inbox shows new Linear questions within a minute without rescanning every menu refresh", async t => {
  const h = await setup({ issues: [issue({ title: "Rollout policy", labels: [], parentId: null, status: "In Progress", description: "" })],
    comments: new Map([["i1", [comment("c1", "Which rollout policy?")]]]) });
  t.after(() => h.ownerAsks.stop());
  let inventoryReads = 0;
  let historyReads = 0;
  const changeReads: string[] = [];
  h.deps.issues = async () => { inventoryReads++; return h.state.issues; };
  h.deps.linear.ownerAskComments = async ids => {
    historyReads++;
    return new Map(ids.map(id => [id, h.state.comments.get(id) ?? []]));
  };
  h.deps.linear.ownerAskCommentChanges = async (ids, since) => {
    changeReads.push(since);
    return new Map(ids.map(id => [id, h.state.comments.get(id) ?? []]));
  };
  assert.deepEqual((await h.ownerAsks.snapshot(null)).asks.map(ask => ask.sourceId), ["c1"]);
  h.state.comments.set("i1", [comment("c2", "Which new approval is needed?"), comment("c1", "Which rollout policy?")]);
  h.state.now += 30_000;
  assert.deepEqual((await h.ownerAsks.snapshot(null)).asks.map(ask => ask.sourceId), ["c1"]);
  assert.deepEqual([inventoryReads, historyReads, changeReads.length], [1, 1, 0]);
  assert.deepEqual(new Set((await h.ownerAsks.snapshot(null, true)).asks.map(ask => ask.sourceId)), new Set(["c1", "c2"]),
    "the browser's explicit collection bypasses the menu cache");
  assert.deepEqual([inventoryReads, historyReads, changeReads], [2, 1, [new Date(NOW - 5 * 60_000).toISOString()]],
    "a known issue's history is not read again: only the changes since the last read, with a five-minute overlap");
  h.state.now += 31_000;
  assert.deepEqual(new Set((await h.ownerAsks.snapshot(null)).asks.map(ask => ask.sourceId)), new Set(["c1", "c2"]));
  assert.deepEqual([inventoryReads, historyReads, changeReads.length], [3, 1, 1], "the explicit collection's comment read serves the menu for a minute");
});

test("owner-ask comments: changes merge into the kept history, a new issue reads its own, deletions leave on the half-hourly whole read", async t => {
  const h = await setup({ issues: [issue({ title: "Rollout policy", labels: [], parentId: null, status: "In Progress", description: "" })],
    comments: new Map([["i1", [comment("c1", "Which rollout policy?"), comment("c0", "Which region first?", "2026-10-09T09:00:00.000Z")]]]) });
  t.after(() => h.ownerAsks.stop());
  const historiesRead: string[][] = [];
  const sources = async () => new Map((await h.ownerAsks.snapshot(null, true)).asks.map(ask => [ask.sourceId, ask.source]));
  h.deps.linear.ownerAskComments = async ids => {
    historiesRead.push(ids);
    return new Map(ids.map(id => [id, h.state.comments.get(id) ?? []]));
  };
  // Linear reports only what changed: an edit of c1 and a new c2, not the untouched c0.
  let changed: OwnerAskComment[] = [];
  h.deps.linear.ownerAskCommentChanges = async ids => new Map(ids.includes("i1") && changed.length ? [["i1", changed]] : []);
  assert.deepEqual([...await sources()], [["c1", "Which rollout policy?"], ["c0", "Which region first?"]]);

  changed = [comment("c1", "Which rollout policy for EU?"), comment("c2", "Which approver?", "2026-10-09T11:00:00.000Z")];
  h.state.comments.set("i1", [...changed, comment("c0", "Which region first?", "2026-10-09T09:00:00.000Z")]);
  h.state.issues = [...h.state.issues, issue({ id: "i2", identifier: "TUC-2", title: "Billing", labels: [], parentId: null, status: "In Progress", description: "" })];
  h.state.comments.set("i2", [comment("d1", "Which invoice cadence?")]);
  h.state.now += 61_000;
  assert.deepEqual(new Map([...await sources()].filter(([id]) => id !== "d1")),
    new Map([["c2", "Which approver?"], ["c1", "Which rollout policy for EU?"], ["c0", "Which region first?"]]),
    "edits replace a comment's text; untouched history is kept without a re-read");
  assert.ok((await sources()).has("d1"), "the issue that joined the inventory shows its comments");
  assert.deepEqual(historiesRead, [["i1"], ["i2"]], "only the new issue's history is read");

  changed = [];
  h.state.comments.set("i1", [comment("c2", "Which approver?", "2026-10-09T11:00:00.000Z")]);
  h.state.now += 10 * 60_000;
  assert.ok((await sources()).has("c0"), "a change read cannot see a deletion");
  h.state.now += 20 * 60_000;
  assert.deepEqual([...(await sources()).keys()].filter(id => id?.startsWith("c")), ["c2"], "the whole read half an hour later drops deleted comments");
  assert.deepEqual(historiesRead.at(-1), ["i1", "i2"]);
});

test("all-status snapshot separates historical discovery from source-evidenced owner urgency", async t => {
  const historical = [
    comment("progress", "Why stop now? The agent continues the approved staging checks."),
    comment("plan", "Plan ready for advisor review; nothing needed from you yet."),
    comment("old-relay", "**TUC-1616** (Paseo) is waiting for an answer:\n\nWhich delivery date should the supplier contract use?", "2026-10-01T09:00:00.000Z"),
    comment("resolution", 'Resolved source old-relay: "Which delivery date should the supplier contract use?" Owner chose November 1.', "2026-10-02T09:00:00.000Z"),
    comment("business", "Owner decision still required: which package quantity is contracted?", "2026-10-01T10:00:00.000Z"),
    comment("identity", "The owner must complete personal SSO with physical security key; waiting on that identity step.", "2026-10-01T11:00:00.000Z"),
    comment("unknown", "Could this have been the previous workflow?"),
    comment("echo", "Owner decision still required: which package quantity is contracted?", "2026-10-02T10:00:00.000Z"),
    comment("later", "Implementation progress: another unrelated check passed.", "2026-10-03T09:00:00.000Z"),
  ];
  const h = await setup({ issues: [issue({ title: "Contract delivery", description: "", labels: [], parentId: null, status: "In Progress" })],
    comments: new Map([["i1", historical]]), extraction: async input => {
      const id = input.context!.sourceId;
      if (id === "unknown") return { ok: false, reason: "unclassified archival source" };
      const owner = id === "business" || id === "identity";
      const state = id === "old-relay" ? "resolved" : owner ? "owner" : "info";
      const evidence = [{ sourceId: id, quote: input.text }];
      if (id === "old-relay") evidence.push({ sourceId: "resolution", quote: historical.find(c => c.id === "resolution")!.body });
      return checkExtraction(JSON.stringify({ kind: owner ? "decision" : "info", summary: input.text,
        questions: owner ? [{ question: input.text, options: [] }] : [],
        assessment: { state, reason: owner ? "A current business or personal identity decision is explicitly still outstanding." : "Timeline evidence concerns only this source.",
          ownerBoundary: id === "business" ? "business" : id === "identity" ? "identity" : null,
          evidence, ...(id === "old-relay" ? { relatedSourceId: "resolution" } : {}) } }), input.text, input.context);
    } });
  t.after(() => h.ownerAsks.stop());
  h.deps.issues = async () => h.state.issues;
  const first = await h.ownerAsks.snapshot(null);
  assert.ok(first.asks.every(ask => ask.attention !== "owner"), "historical text and ? alone cannot notify while extraction is pending");
  await untilAsync(async () => (await h.ownerAsks.snapshot(null)).asks.filter(ask => ask.sourceId !== "unknown" && ask.sourceId !== "echo").every(ask => ask.extracted));
  const snapshot = await h.ownerAsks.snapshot(null);
  assert.deepEqual(snapshot.asks.filter(ask => ask.attention === "owner").map(ask => ask.sourceId).sort(), ["business", "identity"]);
  assert.deepEqual(new Set(snapshot.asks.map(ask => ask.sourceId)), new Set(historical.map(c => c.id)), "original sources remain traceable, not ledger-completed");
  assert.match(snapshot.asks.find(ask => ask.sourceId === "old-relay")!.attentionReason, /resolved|resolution/i);
  assert.match(snapshot.asks.find(ask => ask.sourceId === "echo")!.attentionReason, /echo|duplicate/i);
  assert.match(snapshot.asks.find(ask => ask.sourceId === "unknown")!.attentionReason, /review|currentness/i);
  assert.equal(snapshot.asks.find(ask => ask.sourceId === "unknown")!.attention, "info");
  assert.deepEqual(snapshot.history, []);
  assert.deepEqual(h.events, []);
  const validated = ownerAsksRpc.output.parse(ownerAsksPage(snapshot));
  assert.deepEqual(validated.asks.map(ask => ask.sourceId), snapshot.asks.filter(ask => !isSourceReview(ask)).map(ask => ask.sourceId), "validated RPC retains per-source identity");
  assert.equal(validated.sourceReviews, snapshot.asks.filter(isSourceReview).length);
  const business = validated.asks.find(ask => ask.sourceId === "business")!;
  const mismatched = answerAskRpc.input.parse({ issueId: "i1", sourceId: "identity", revision: business.revision, answers: { q1: "50" } });
  await assert.rejects(h.ownerAsks.answer(mismatched, null), /changed|source/i);
  const triage = triageAskRpc.input.parse({ issueId: "i1", sourceId: "identity", revision: business.revision, action: "defer", until: "2026-10-10T12:00:00.000Z" });
  await assert.rejects(h.ownerAsks.triage(triage, null), /changed|source/i);
  const relay = snapshot.asks.find(ask => ask.sourceId === "old-relay")!;
  await assert.rejects(h.ownerAsks.answer({ issueId: "i1", sourceId: relay.sourceId, revision: relay.revision, answers: {}, note: "Approve" }, null), /reconciled|resolved|source/i);
  await h.ownerAsks.answer({ issueId: "i1", sourceId: business.sourceId, revision: business.revision, answers: { q1: "50" } }, null);
  const retained = (await h.ownerAsks.snapshot(null)).asks;
  assert.equal(retained.find(ask => ask.sourceId === "identity")!.attention, "owner", "one answer never completes another independent source");
  await assert.rejects(h.ownerAsks.answer({ ...mismatched, sourceId: "identity" }, null), /source|changed/i, "receipt retries cannot bypass a supplied source identity");
});

test("exact current owner wait remains urgent on extraction failure; status/manual labels alone do not", async t => {
  const waiting: HandoverRecord = { issueId: "i1", identifier: "TUC-1616", agentId: "gone", agentTitle: "agent", branch: null,
    worktreePath: null, lastCommit: null, summaries: [], links: {}, status: "waiting", progressCommentId: null, resumedFrom: null,
    updatedAt: at, waiting: { previousStateId: "ip", commentId: "live", kind: "request", at } };
  const h = await setup({ issues: [issue({ title: "Contract quantity", description: "", labels: [], parentId: null, status: "Todo" }),
    issue({ id: "manual", title: "Staging setup", description: "Agent can configure the scoped staging access.", labels: ["paseo-manual"], parentId: null })],
    comments: new Map([["i1", [comment("live", "Which contract quantity is correct?"), comment("old", "Which old technical plan?")]]]),
    records: new Map([["i1", waiting]]), extraction: async () => ({ ok: false, reason: "offline" }) });
  t.after(() => h.ownerAsks.stop());
  h.deps.issues = async () => h.state.issues;
  const snapshot = await h.ownerAsks.snapshot(null);
  assert.deepEqual(snapshot.asks.filter(ask => ask.attention === "owner").map(ask => ask.sourceId), ["live"]);
  assert.ok(snapshot.asks.every(ask => !ask.extracted));
  assert.equal(snapshot.asks.find(ask => ask.issueId === "manual")!.attention, "info", "manual label is not evidence of human-only work");
  waiting.status = "working";
  const revised = (await h.ownerAsks.snapshot(null, true)).asks.find(ask => ask.sourceId === "live")!;
  assert.equal(revised.attention, "info", "revoked wait does not retain urgent admission");
  assert.notEqual(revised.revision, snapshot.asks.find(ask => ask.sourceId === "live")!.revision);
  await assert.rejects(h.ownerAsks.answer({ issueId: "i1", sourceId: "live", revision: snapshot.asks[0].revision, answers: {}, note: "50" }, null), /changed/);
  assert.deepEqual(h.events, []);
});

test("an unchanged source's confirmed answer does not resurrect when unrelated timeline context changes", async t => {
  const h = await setup({ issues: [issue({ title: "Business questions", description: "", labels: [], parentId: null, status: "Todo" })],
    comments: new Map([["i1", [comment("first", "Which contracted quantity?"), comment("second", "Which supplier contract applies?")]]]) });
  t.after(() => h.ownerAsks.stop());
  await untilAsync(async () => (await h.ownerAsks.snapshot(null)).asks.every(ask => ask.extracted));
  const first = (await h.ownerAsks.snapshot(null)).asks.find(ask => ask.sourceId === "first")!;
  await h.ownerAsks.answer({ issueId: "i1", sourceId: "first", revision: first.revision, answers: { q1: "You or the team" } }, null);
  h.state.comments.get("i1")!.push(comment("progress", "Unrelated implementation checks passed.", "2026-10-09T12:01:00Z"));
  const updated = await h.ownerAsks.snapshot(null, true);
  assert.equal(updated.asks.some(ask => ask.sourceId === "first"), false);
  assert.ok(updated.asks.some(ask => ask.sourceId === "second"));
  assert.equal(updated.history.length, 1);
  assert.equal(h.events.filter(event => event.startsWith("comment ")).length, 1);
});

test("unconfirmed source delivery cannot be bypassed after a timeline-driven revision change", async t => {
  const h = await setup({ issues: [issue({ title: "Business question", description: "Which contracted quantity?", labels: [], parentId: null, status: "Todo" })] });
  t.after(() => h.ownerAsks.stop());
  let sends = 0;
  h.deps.linear.comment = async () => { sends++; throw new Error("delivery result unknown"); };
  const original = await inputFor(h);
  await assert.rejects(h.ownerAsks.answer({ ...original, sourceId: "description" }, null), /unknown/);
  h.state.comments.set("i1", [comment("progress", "Unrelated tests passed.", "2026-10-09T12:01:00Z")]);
  await h.ownerAsks.snapshot(null, true);
  const current = await untilAsk(h, ask => ask.sourceId === "description" && ask.extracted);
  assert.notEqual(current.revision, original.revision);
  assert.equal(current.deliveryUnknown, true);
  await assert.rejects(h.ownerAsks.answer({ issueId: "i1", sourceId: "description", revision: current.revision, answers: { q1: "You or the team" } }, null), /unconfirmed/);
  assert.equal(sends, 1);
});

test("captured TUC-835 report excerpt with a query-string URL remains nonurgent review when extraction fails", async t => {
  // Exact excerpts from source 072c92ff-8f17-428f-a1e0-dd7797fed533 in the
  // preserved 2026-10-15 incident snapshot; no unprovided chronology is inferred.
  const source = "No different/exact_failed/compare_failed rows returned; absent groups are not failure-free coverage proof. No new owner instruction. [Sentry dashboard](https://tuchel-sohn-gmbh.sentry.io/explore/metrics/?project=4512091960836176&statsPeriod=14d).\n\nNo owner decision is pending.";
  const h = await setup({ issues: [issue({ identifier: "TUC-835", title: "Monitoring", description: "", parentId: null, labels: [], status: "In Progress" })],
    comments: new Map([["i1", [comment("072c92ff-8f17-428f-a1e0-dd7797fed533", source)]]]),
    extraction: async () => ({ ok: false, reason: "offline historical extraction" }) });
  t.after(() => h.ownerAsks.stop());
  const snapshot = await h.ownerAsks.snapshot(null);
  assert.deepEqual(snapshot.asks.map(ask => ({ sourceId: ask.sourceId, attention: ask.attention, extracted: ask.extracted })),
    [{ sourceId: "072c92ff-8f17-428f-a1e0-dd7797fed533", attention: "info", extracted: false }]);
  assert.match(snapshot.asks[0].attentionReason, /review/);
  assert.deepEqual(snapshot.history, []);
  // The menu bar's page counts the review instead of listing it as an owner decision.
  assert.deepEqual(ownerAsksRpc.output.parse(ownerAsksPage(snapshot)), { asks: [], updatedAt: snapshot.updatedAt, history: [], sourceReviews: 1 });
  assert.deepEqual(h.events, []);
});

test("an independent Needs-you comment cannot consent to another live question with the same Yes label", async t => {
  const production = "May I DROP the production database?";
  const research = "May I investigate the staging fixture?";
  const h = await setup({
    issues: [issue({ description: `${production}\nYes / No` })],
    comments: new Map([["i1", [comment("independent", `${research}\nYes / No`), comment("unanswered", "Which supplier contract applies?")]]]),
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }],
    agents: [{ id: "a1", status: "running", createdAt: at, issueId: "p1", pending: true }],
    extraction: async input => ({ ok: true, value: { kind: "decision", summary: input.text, questions: [{ key: "q1", question: input.text.split("\n")[0], options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false }] } }),
  });
  t.after(() => h.ownerAsks.stop());
  const pending = { id: "real-production-request", provider: "omp", name: "ask", kind: "question" as const,
    input: { questions: [{ question: production, options: [{ label: "Yes" }, { label: "No" }] }] } };
  const responses: unknown[] = [];
  const replies = new PermissionReplies({ directory: join(h.directory, "replies"), daemon: async () => ({
    respondToPermissionAndWait: async (_agent, id, response) => { assert.equal(id, pending.id); responses.push(response); },
  }) });
  let wholeIssueEffects = 0;
  replies.recordEffects({
    ownerAnswered: async () => {},
    correctLate: async () => ({ delivered: false, reply: "" }),
    needsYou: async () => { wholeIssueEffects++; },
  });
  t.after(() => replies.stop());
  const paseo = { agents: { list: h.paseo.agents.list, ref: () => ({ refresh: async () => ({ agent: { pendingPermissions: [pending] } }) }) } } as unknown as PaseoApi;
  h.deps.deliver = (sdk, agent, message, origin) => replies.deliver(sdk, agent, message, origin);
  await untilAsync(async () => (await h.ownerAsks.snapshot(paseo)).asks.every(ask => ask.extracted));
  const independent = (await h.ownerAsks.snapshot(paseo)).asks.find(ask => ask.sourceId === "independent")!;
  assert.equal((await h.ownerAsks.answer({ issueId: "i1", sourceId: independent.sourceId, revision: independent.revision, answers: { q1: "Yes" } }, paseo)).delivered, "comment");
  assert.deepEqual(responses, [], "no daemon consent from an independently scoped comment");
  assert.match(h.events.find(event => event.startsWith("comment ")) ?? "", /Source ID: independent/);
  const description = await untilAsk(h, ask => ask.sourceId === "description" && ask.extracted);
  await h.ownerAsks.answer({ issueId: "i1", sourceId: "description", revision: description.revision, answers: { q1: "Yes" } }, paseo);
  assert.equal(responses.length, 1, "the legitimate original source still reaches its live request");
  await replies.recoverEffects();
  assert.equal(wholeIssueEffects, 0, "shared reply recovery must not close the whole issue by agent affinity");
  assert.deepEqual(h.events.filter(event => /^(complete|needsYou.remove) /.test(event)), []);
  assert.deepEqual((await h.ownerAsks.snapshot(paseo)).asks.map(ask => ask.sourceId), ["unanswered"]);
});

test("answering one Needs-you source leaves independent requests visible and closes only after the final answer", async t => {
  const h = await setup({ issues: [issue()], comments: new Map([["i1", [comment("business", "Which contracted quantity?")]]]),
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }] });
  t.after(() => h.ownerAsks.stop());
  await untilAsync(async () => (await h.ownerAsks.snapshot(null)).asks.every(ask => ask.extracted));
  const first = (await h.ownerAsks.snapshot(null)).asks.find(ask => ask.sourceId === "business")!;
  await h.ownerAsks.answer({ issueId: "i1", sourceId: "business", revision: first.revision, answers: { q1: "You or the team" } }, null);
  assert.deepEqual(h.events.filter(event => /^(complete|needsYou.remove) /.test(event)), []);
  const remaining = (await h.ownerAsks.snapshot(null)).asks;
  assert.deepEqual(remaining.map(ask => ask.sourceId), ["description"]);
  await h.ownerAsks.answer({ issueId: "i1", sourceId: "description", revision: remaining[0].revision, answers: { q1: "Agent does it" } }, null);
  assert.deepEqual(new Set(h.events.filter(event => /^(complete|needsYou.remove) /.test(event))), new Set(["complete i1", "needsYou.remove i1"]));
  assert.equal((await h.ownerAsks.snapshot(null)).history.length, 2, "two real answers, not a bulk ledger completion");
});

for (const retryClose of [false, true]) {
  test(`the last comment answer closes its Needs-you issue with its real receipt in the timeline${retryClose ? " after a failed close and exact retry" : ""}`, async t => {
    const h = await setup({ issues: [issue()], comments: new Map([["i1", [comment("business", "Which contracted quantity?")]]]),
      needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }] });
    t.after(() => h.ownerAsks.stop());
    let receipts = 0;
    h.deps.linear.comment = async (issueId, body) => {
      h.events.push(`comment ${issueId}: ${body}`);
      h.state.comments.set(issueId, [...h.state.comments.get(issueId) ?? [], comment(`receipt-${++receipts}`, body, new Date(NOW + receipts * 1000).toISOString())]);
    };
    let failClose = retryClose;
    h.deps.linear.complete = async issueId => {
      if (failClose) throw new Error("Linear completion temporarily unavailable");
      h.events.push(`complete ${issueId}`);
    };
    const description = await untilAsk(h, ask => ask.sourceId === "description" && ask.extracted);
    await h.ownerAsks.answer({ issueId: "i1", sourceId: "description", revision: description.revision, answers: { q1: "Agent does it" } }, null);
    assert.deepEqual(h.events.filter(event => event.startsWith("complete ")), [], "the independent business question remains unanswered");
    const last = await untilAsk(h, ask => ask.sourceId === "business" && ask.extracted);
    const input = { issueId: "i1", sourceId: "business", revision: last.revision, answers: { q1: "You or the team" } };
    if (retryClose) {
      await assert.rejects(h.ownerAsks.answer(input, null), /completion temporarily unavailable/);
      failClose = false;
    }
    await h.ownerAsks.answer(input, null);
    await h.ownerAsks.answer(input, null);
    assert.equal(receipts, 2, "exact retries never post a second answer receipt");
    assert.equal(h.state.comments.get("i1")?.filter(entry => entry.body.startsWith("Answered from the decision inbox:")).length, 2, "the completion check consumed the actual returned receipt timeline");
    assert.deepEqual(h.events.filter(event => event.startsWith("complete ")), ["complete i1"], "the final settled source closes once, despite nonmaterial receipt context changes");
    assert.ok(h.events.includes("needsYou.remove i1"));
    assert.deepEqual((await h.ownerAsks.snapshot(null, true)).asks, []);
    assert.equal((await h.ownerAsks.snapshot(null)).history.length, 2);
  });
}

test("an unclassified independent source blocks whole-issue completion even when the owner answers another part", async t => {
  const h = await setup({ issues: [issue()], comments: new Map([["i1", [comment("unknown", "Historical context not yet classified")]]]),
    needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }] });
  t.after(() => h.ownerAsks.stop());
  const extract = h.state.extraction;
  h.state.extraction = input => input.context?.sourceId === "unknown" ? Promise.resolve({ ok: false, reason: "unclassified history" }) : extract(input);
  const original = await inputFor(h);
  await assert.rejects(h.ownerAsks.answer({ ...original, done: true }, null), /independent|unsettled/i);
  await h.ownerAsks.answer(original, null);
  assert.deepEqual(h.events.filter(event => /^(complete|needsYou.remove) /.test(event)), []);
  assert.equal((await h.ownerAsks.snapshot(null)).asks.find(ask => ask.sourceId === "unknown")?.extracted, false);
});

for (const legacy of [false, true]) for (const change of ["title", "parent"] as const) {
  test(`${legacy ? "legacy body-only" : "scoped"} answered-source receipt cannot approve a changed ${change}`, async t => {
    const h = await setup({ issues: [issue({ title: "Staging rollout", description: "Approve this rollout?", labels: [] })] });
    t.after(() => h.ownerAsks.stop());
    const first = await inputFor(h);
    await h.ownerAsks.answer(first, null);
    if (legacy) {
      const path = join(h.directory, "decisions.json");
      const ledger = JSON.parse(await readFile(path, "utf8")) as { records: Record<string, { sourceScope?: string }> };
      for (const record of Object.values(ledger.records)) delete record.sourceScope;
      await writeFile(path, JSON.stringify(ledger));
    }
    h.state.issues[0] = { ...h.state.issues[0], ...(change === "title" ? { title: "Production rollout" } : { title: "Needs you: Staging rollout", parentId: "production", parentIdentifier: "TUC-PROD" }) };
    const reloaded = new OwnerAsks(h.deps);
    t.after(() => reloaded.stop());
    assert.equal((await reloaded.snapshot(null)).asks.length, 1, "an old answer is not authority for the changed business scope");
    let current: BrowserOwnerAsk | undefined;
    await untilAsync(async () => { current = (await reloaded.snapshot(null)).asks.find(ask => ask.extracted); return current !== undefined; });
    assert.notEqual(current!.revision, first.revision);
    await reloaded.answer(first, null);
    assert.equal(h.events.filter(event => event.startsWith("comment ")).length, 1, "an exact old receipt replay never delivers into the changed scope");
    await reloaded.answer({ issueId: "i1", sourceId: "description", revision: current!.revision, answers: { q1: "You or the team" } }, null);
    assert.equal(h.events.filter(event => event.startsWith("comment ")).length, 2, "the new material scope needs its own explicit answer");
  });
}

for (const parentField of ["parentId", "parentIdentifier"] as const) {
  test(`an ordinary ticket ${parentField}-only change cannot reuse an exact-revision answer receipt`, async t => {
    const h = await setup({ issues: [issue({ title: "Staging rollout", description: "Approve this rollout?", labels: [] })] });
    t.after(() => h.ownerAsks.stop());
    const first = await inputFor(h);
    await h.ownerAsks.answer(first, null);
    const original = h.state.issues[0];
    h.state.issues[0] = { ...original, [parentField]: parentField === "parentId" ? "new-parent" : "TUC-NEW-PARENT" };
    const reloaded = new OwnerAsks(h.deps);
    t.after(() => reloaded.stop());
    assert.equal((await reloaded.snapshot(null)).asks.length, 1, "unchanged title/kind/body cannot hide a materially reparented ticket under its old exact receipt");
    let current: BrowserOwnerAsk | undefined;
    await untilAsync(async () => { current = (await reloaded.snapshot(null)).asks.find(ask => ask.extracted); return current !== undefined; });
    assert.notEqual(current!.revision, first.revision, "parent scope is part of the consumer revision, even for an ordinary ticket");
    assert.equal(current!.title, original.title);
    assert.equal(h.state.issues[0].description, original.description);
    assert.deepEqual(h.state.issues[0].labels, original.labels);
    await assert.rejects(reloaded.answer({ ...first, answers: { q1: "You or the team" } }, null), /ask changed/);
    assert.equal(h.events.filter(event => event.startsWith("comment ")).length, 1);
    const input = { issueId: "i1", sourceId: "description", revision: current!.revision, answers: { q1: "You or the team" } };
    await reloaded.answer(input, null);
    await reloaded.answer(input, null);
    assert.equal(h.events.filter(event => event.startsWith("comment ")).length, 2, "the new parent scope has its own explicit exactly-once owner answer");
    assert.equal((await reloaded.snapshot(null)).history.length, 2);
  });
}

for (const retryBeforeRestart of [false, true]) {
  test(`confirmed completion retries only tracking cleanup when the completed issue leaves open discovery${retryBeforeRestart ? " before and after restart" : " after restart"}`, async t => {
    const h = await setup({ issues: [issue()] });
    t.after(() => h.ownerAsks.stop());
    const tracked = new NeedsYouIssues(join(h.directory, "needs-you"));
    await tracked.add({ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" });
    h.deps.needsYou = tracked;
    const remove = tracked.remove.bind(tracked);
    let failRemoval = true;
    tracked.remove = async (...args: Parameters<NeedsYouIssues["remove"]>) => {
      if (failRemoval) throw new Error("Tracking removal temporarily unavailable");
      await remove(...args);
    };
    h.deps.linear.complete = async id => {
      h.events.push(`complete ${id}`);
      h.state.issues = h.state.issues.filter(current => current.id !== id);
    };
    const input = await inputFor(h);
    await assert.rejects(h.ownerAsks.answer(input, h.paseo), /Tracking removal temporarily unavailable/);
    assert.deepEqual(await h.deps.linear.ownerAskIssues(), [], "completed issues no longer appear in the actual discovery response");
    failRemoval = false;
    if (retryBeforeRestart) await h.ownerAsks.answer(input, h.paseo);
    h.ownerAsks.stop();
    h.ownerAsks = new OwnerAsks(h.deps);
    await h.ownerAsks.answer(input, h.paseo);
    await h.ownerAsks.answer(input, h.paseo);
    assert.deepEqual(await tracked.allStrict(), [], "the original registered owner blocker is removed after confirmed completion");
    assert.equal(h.continued.length, 1, "the confirmed answer/continuation is never dispatched again");
    assert.deepEqual(h.events.filter(event => event.startsWith("complete ")), ["complete i1"], "tracking recovery never repeats Linear completion");
  });
}

test("completed-answer cleanup cannot remove a replacement owner registration after the same issue reopens", async t => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const tracked = new NeedsYouIssues(join(h.directory, "needs-you"));
  const registration = { id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" };
  await tracked.add(registration);
  h.deps.needsYou = tracked;
  const remove = tracked.remove.bind(tracked);
  let failRemoval = true;
  tracked.remove = async (...args: Parameters<NeedsYouIssues["remove"]>) => {
    if (failRemoval) throw new Error("Tracking removal temporarily unavailable");
    await remove(...args);
  };
  h.deps.linear.complete = async id => {
    h.events.push(`complete ${id}`);
    h.state.issues = h.state.issues.filter(current => current.id !== id);
  };
  const input = await inputFor(h);
  await assert.rejects(h.ownerAsks.answer(input, h.paseo), /Tracking removal temporarily unavailable/);
  await tracked.add(registration);
  const replacement = await tracked.allStrict();
  h.state.issues = [issue()];
  failRemoval = false;
  h.ownerAsks.stop();
  h.ownerAsks = new OwnerAsks(h.deps);
  await h.ownerAsks.answer(input, h.paseo);
  await h.ownerAsks.answer(input, h.paseo);
  assert.deepEqual(await tracked.allStrict(), replacement, "the prior completion does not authorize deletion of a new registration with the same issue/agent/parent");
  const current = await untilAsk(h, ask => ask.sourceId === "description" && ask.extracted);
  assert.notEqual(current.revision, input.revision, "a new registered wait cannot inherit old consent even with identical question text");
  assert.equal(h.continued.length, 1);
  assert.deepEqual(h.events.filter(event => event.startsWith("complete ")), ["complete i1"], "old exact retries do not complete reopened owner work");
});

for (const action of ["answer", "Done", "research"] as const) {
  for (const fault of ["unreadable blocker", "invalid asking agent", "numeric selected generation", "array blocker generation"] as const) {
    test(`${action} checks strict registration authority before effects with a matching display revision: ${fault}`, async t => {
      const h = await setup({ issues: [issue()], agents: [{ id: "a1", status: "running", createdAt: at, issueId: "p1" }] });
      t.after(() => h.ownerAsks.stop());
      const directory = join(h.directory, "needs-you");
      await mkdir(directory, { mode: 0o700 });
      const selected = { id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1", registrationId: "selected-generation" };
      const blocker = { id: "other", identifier: "TUC-OTHER", parentId: "other-parent", agentId: "other-agent", registrationId: "blocker-generation" };
      await writeFile(join(directory, "i1.json"), JSON.stringify(fault === "invalid asking agent" ? { ...selected, agentId: 42 }
        : fault === "numeric selected generation" ? { ...selected, registrationId: 42 } : selected));
      const blockerPath = join(directory, "other.json");
      if (fault === "unreadable blocker") await mkdir(blockerPath);
      else await writeFile(blockerPath, JSON.stringify(fault === "array blocker generation" ? { ...blocker, registrationId: ["blocker-generation"] } : blocker));
      h.deps.needsYou = new NeedsYouIssues(directory);
      // Use the actual resilient background display while the fault is present: rejection
      // must come from authority verification, not a revision manufactured before corruption.
      const input = { ...await inputFor(h), sourceId: "description", ...(action === "Done" ? { done: true } : {}) };
      const invoke = (current: AnswerAskInput) => action === "research"
        ? h.ownerAsks.triage({ issueId: current.issueId, sourceId: current.sourceId, revision: current.revision, action: "research", note: "Collect evidence only; do not decide or close." }, h.paseo)
        : h.ownerAsks.answer(current, h.paseo);
      let refusal: unknown;
      try { await invoke(input); } catch (error) { refusal = error; }
      assert.deepEqual({ delivered: h.delivered.length, continued: h.continued.length, queued: h.queued.length, effects: h.events },
        { delivered: 0, continued: 0, queued: 0, effects: [] }, "invalid tracking must stop before answer dispatch, completion, cleanup or receipt posting");
      assert.ok(refusal, "a matching display revision cannot authorize an unreadable or invalid registration");
      await rm(blockerPath, { recursive: true, force: true });
      await writeFile(blockerPath, JSON.stringify(blocker));
      await writeFile(join(directory, "i1.json"), JSON.stringify(selected));
      const repaired = { ...await inputFor(h), sourceId: "description", ...(action === "Done" ? { done: true } : {}) };
      if (fault === "numeric selected generation") {
        assert.notEqual(repaired.revision, input.revision);
        await assert.rejects(invoke(input), /ask changed/, "repair of material identity still requires the current displayed revision");
      } else assert.equal(repaired.revision, input.revision, "nonmaterial record repair permits retrying the exact original request");
      const result = await invoke(repaired);
      assert.equal(result.delivered, action === "Done" ? "closed" : "agent");
      assert.equal(h.delivered.length, action === "Done" ? 0 : 1);
      assert.deepEqual(h.events.filter(event => event.startsWith("complete ")), action === "research" ? [] : ["complete i1"]);
    });
  }
}

test("Done rechecks strict tracking before whole-issue completion after the first authority read succeeds", async t => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const directory = join(h.directory, "needs-you");
  const tracking = new NeedsYouIssues(directory);
  await tracking.add({ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" });
  h.deps.needsYou = tracking;
  const input = { ...await inputFor(h), sourceId: "description", done: true };
  const strict = tracking.allStrict.bind(tracking);
  let introduceFault = true;
  tracking.allStrict = async () => {
    const registered = await strict();
    if (introduceFault) {
      introduceFault = false;
      await writeFile(join(directory, "other.json"), JSON.stringify({ id: "other", identifier: "TUC-OTHER", parentId: "other-parent", agentId: "other-agent", registrationId: 42 }));
    }
    return registered;
  };
  let refusal: unknown;
  try { await h.ownerAsks.answer(input, h.paseo); } catch (error) { refusal = error; }
  assert.equal(h.events.length, 0, "a registration invalidated between authority reads must stop before Linear completion");
  assert.ok(refusal);
  await rm(join(directory, "other.json"), { force: true });
  assert.equal((await h.ownerAsks.answer(input, h.paseo)).delivered, "closed");
  assert.deepEqual(h.events.filter(event => event.startsWith("complete ")), ["complete i1"]);
});

for (const change of ["replacement generation", "body edit without timestamp change", "parent-only edit", "title-only edit"] as const) {
  test(`Done rejects a selected source changed between authority reads: ${change}`, async t => {
    const h = await setup({ issues: [issue()] });
    t.after(() => h.ownerAsks.stop());
    const tracking = new NeedsYouIssues(join(h.directory, "needs-you"));
    const registration = { id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" };
    await tracking.add(registration);
    h.deps.needsYou = tracking;
    h.deps.linear.complete = async id => {
      h.events.push(`complete ${id}`);
      h.state.issues = h.state.issues.filter(item => item.id !== id);
    };
    h.deps.linear.comment = async (id, body) => {
      h.events.push(`comment ${id}`);
      h.state.comments.set(id, [...h.state.comments.get(id) ?? [], comment(`receipt-${h.events.length}`, body)]);
    };
    const input = { ...await inputFor(h), sourceId: "description", done: true };
    const strict = tracking.allStrict.bind(tracking);
    const initial = await strict();
    let replace = true;
    tracking.allStrict = async () => {
      const registered = await strict();
      if (replace) {
        replace = false;
        // The initial admission receives A; the completion read must inspect the real B.
        if (change === "replacement generation") await tracking.add(registration);
        else h.state.issues = [issue(change === "body edit without timestamp change"
          ? { description: `${issue().description}\n\nThe selected request now has a different business requirement.` }
          : change === "parent-only edit" ? { parentId: "p2" } : { title: "Needs you: a different business scope" })];
      }
      return registered;
    };
    let refusal: unknown;
    try { await h.ownerAsks.answer(input, h.paseo); } catch (error) { refusal = error; }
    assert.deepEqual({ delivered: h.delivered.length, continued: h.continued.length, queued: h.queued.length, effects: h.events },
      { delivered: 0, continued: 0, queued: 0, effects: [] }, "old consent cannot complete or dispatch a changed selected source");
    assert.ok(refusal);
    assert.equal(h.state.issues.some(item => item.id === "i1"), true, "replacement owner work must remain open");
    const currentTracking = await strict();
    if (change === "replacement generation") assert.notEqual(currentTracking[0]!.registrationId, initial[0]!.registrationId);
    else assert.deepEqual(currentTracking, initial);
    const visible = await untilAsk(h, ask => ask.sourceId === "description" && ask.extracted && ask.revision !== input.revision);
    assert.equal(visible.attention, "owner");
    assert.equal(visible.deliveryUnknown, false, "refusal must not reserve the old decision or conceal the new work");
    await assert.rejects(h.ownerAsks.answer(input, h.paseo));
    assert.equal(h.events.length, 0);
    const current = { ...input, revision: visible.revision };
    assert.equal((await h.ownerAsks.answer(current, h.paseo)).delivered, "closed");
    await h.ownerAsks.answer(current, h.paseo);
    assert.deepEqual(h.events, ["complete i1", "comment i1"]);
    assert.deepEqual(await strict(), []);
    assert.equal(h.state.issues.length, 0);
  });
}

const waitRecord = (kind: "request" | "turn-end", commentId: string): HandoverRecord => ({
  issueId: "i1", identifier: "TUC-1616", agentId: "a1", agentTitle: "agent", branch: null, worktreePath: null,
  lastCommit: null, summaries: [], links: {}, status: "waiting", progressCommentId: null, resumedFrom: null,
  updatedAt: at, waiting: { previousStateId: "ip", commentId, kind, at },
});

const settled = async (h: Harness, owner: OwnerAsks = h.ownerAsks): Promise<BrowserOwnerAsk[]> => {
  await untilAsync(async () => (await owner.snapshot(h.paseo)).asks.every((ask) => ask.extracted));
  return (await owner.snapshot(h.paseo)).asks;
};

test("a restart preserves every source revision and its retired-request attention", async (t) => {
  const h = await setup({
    issues: [issue({ title: "Ticket", labels: [], parentId: null, parentIdentifier: null }), issue({ id: "i2", identifier: "TUC-1617", title: "Needs you: Decision for you: who takes TUC-1563?",
      url: "https://linear.app/tuchel/issue/TUC-1617", description: "**Decision for you: who takes TUC-1563?**\n\n* **Agent does it:** I plan TUC-1563." })],
    comments: new Map([["i1", [comment("c1", waitComment)]], ["i2", [comment("c2", waitComment.replace("block refresh live", "ship the migration"))]]]),
    records: new Map([["i1", waitRecord("request", "c1")]]),
    agents: [{ id: "a1", status: "idle", createdAt: at, issueId: "i1" }],
  });
  t.after(() => h.ownerAsks.stop());
  const first = await settled(h);
  assert.equal(first.length, 4, "two sources on the first issue, two on the second");
  assert.ok(first.some((ask) => ask.attentionReason.includes("has no pending request on this host")),
    `retired-request attention must remain visible: ${JSON.stringify(first.map((ask) => [ask.sourceId, ask.attention, ask.attentionReason]))}`);
  const resumed = new OwnerAsks(h.deps);
  t.after(() => resumed.stop());
  assert.deepEqual(await settled(h, resumed), first, "a restart resumes every source's revision and attention");
});

test("a source revision changes when it stops being this host's current wait", async (t) => {
  const h = await setup({
    issues: [issue({ title: "Ticket", description: "**Decision for you: who takes TUC-1562?**", labels: [], parentId: null })],
    comments: new Map([["i1", [comment("c1", waitComment)]]]),
    records: new Map([["i1", waitRecord("turn-end", "c1")]]),
  });
  t.after(() => h.ownerAsks.stop());
  const first = await settled(h);
  const before = first.find((ask) => ask.sourceId === "c1")!;
  assert.equal(before.attention, "owner");
  // The agent asks a second comment: c1 is no longer the exact wait comment this host holds.
  h.state.comments.set("i1", [comment("c1", waitComment), comment("c2", `${waitComment}\n\n2. May I ship the migration?`)]);
  h.state.records.set("i1", waitRecord("turn-end", "c2"));
  const resumed = new OwnerAsks(h.deps);
  t.after(() => resumed.stop());
  const moved = await settled(h, resumed);
  assert.notEqual(moved.find((ask) => ask.sourceId === "c1")!.revision, before.revision,
    "a stored revision cannot stand once the host's wait state moved");
});


// The extraction hash and every source revision are taken over the bytes of the serialized input.
// They are deliberately `JSON.stringify(input)` and nothing else: a stored extraction is reused
// only while its hash matches, so a serialization one byte off re-extracts the whole inventory
// through the model, and a revision off by a byte stops matching the receipts the ledger holds.
test("the serialized input pieces are JSON.stringify of the input, byte for byte", () => {
  const inputs: (ExtractInput & { context: AskContext })[] = [
    { identifier: "TUC-1616", title: "Ticket", ticket: null, kind: "needs-you", text: "May I ship?",
      context: { sourceId: "c1", currentWait: true, liveRequest: false, duplicateOf: null, complete: false, timeline: [] } },
    { identifier: "TUC-1617", title: "Ünicode — 決策", ticket: "TUC-1000", kind: "ticket", text: "May the block refresh live?\n\n“quoted”…",
      context: { sourceId: "description", currentWait: false, liveRequest: true, duplicateOf: "c1", complete: true, timeline: [
        { sourceId: "description", text: "**Decision for you**\n\n* a\n* b", createdAt: "2026-10-09T10:00:00.000Z" },
        { sourceId: "c1", text: "😀 an entry with \u0000 and \"quotes\"", createdAt: "2026-10-09T11:00:00.000Z" },
      ] } },
  ];
  const bytes = new WeakMap<AskSource, Buffer>();
  for (const input of inputs) {
    assert.equal(extractionInputParts(input, bytes).join(""), JSON.stringify(input));
  }
  // One collection encodes an untruncated entry once for every card of its issue: the cards quote
  // the very object `askTimeline` built, so the second card reads those bytes back, not new ones.
  const shared: AskSource = { sourceId: "c1", text: "😀 an entry with \u0000 and \"quotes\"", createdAt: "2026-10-09T11:00:00.000Z" };
  const one = { ...inputs[0], context: { ...inputs[0].context, timeline: [shared] } };
  const two = { ...inputs[1], context: { ...inputs[1].context, timeline: [shared, inputs[1].context.timeline[0]!] } };
  const once = extractionInputParts(one, bytes);
  const twice = extractionInputParts(two, bytes);
  assert.equal(once[1], twice[1], "one entry object is encoded once, however many cards quote it");
  assert.equal(once.join(""), JSON.stringify(one));
  assert.equal(twice.join(""), JSON.stringify(two));
});

// `askContext` bounds each card's context by that card's own remaining budget, so one entry can
// reach a card truncated and another whole. Keying the entry cache by the source id served the
// first card's shorter bytes to the second card and produced an input that was not
// `JSON.stringify(input)`: the extraction hash moved and the revision did not match the source.
test("a truncated entry never serves a card whose budget keeps it whole", () => {
  const comments = Array.from({ length: 8 }, (_, index) => ({ id: `c${index + 1}`, body: "c".repeat(4_000), createdAt: `2026-10-16T11:0${index}:00.000Z` }));
  const timeline = askTimeline("d".repeat(1_000), comments);
  const build = (sourceId: string): ExtractInput & { context: AskContext } => ({ identifier: "TUC-1616", title: "Ticket", ticket: null, kind: "ticket", text: "May I ship?",
    context: askContext(sourceId, timeline, null, false, false) });
  const bytes = new WeakMap<AskSource, Buffer>();
  // The description's budget truncates the oldest comment; that comment's own card quotes it whole.
  // Both orders are read, because either card can be encoded first.
  for (const sourceId of ["description", "c1", "c1", "description"]) {
    const input = build(sourceId);
    assert.equal(extractionInputParts(input, bytes).join(""), JSON.stringify(input), `${sourceId} must assemble byte for byte`);
  }
});

for (const field of ["hash", "version"] as const) {
  test(`a restarted inbox rejects an extraction whose ${field} no longer matches`, async t => {
    const h = await setup({ issues: [issue()], needsYou: [{ id: "i1", identifier: "TUC-1616", parentId: "p1", agentId: "a1" }] });
    t.after(() => h.ownerAsks.stop());
    const [before] = await settled(h);
    h.ownerAsks.stop();
    const path = join(h.directory, "extract", (await readdir(join(h.directory, "extract")))[0]!);
    const stored = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...stored, [field]: "obsolete" }));
    h.deps.resolveModel = () => new Promise<string>(() => {});
    const restarted = new OwnerAsks(h.deps);
    t.after(() => restarted.stop());
    const [current] = (await restarted.snapshot(h.paseo)).asks;
    assert.equal(current?.extracted, false, "an obsolete extraction must not supply displayed questions");
    assert.notEqual(current?.revision, before?.revision);
    assert.equal(current?.sourceId, "description");
    assert.equal(current?.attention, "owner", "unavailable extraction must not hide an owner wait");
  });
}

test("a current durable extraction stays usable in memory after its cache file is lost", async t => {
  const h = await setup({ issues: [issue()] });
  t.after(() => h.ownerAsks.stop());
  const input = await inputFor(h);
  await rm(join(h.directory, "extract"), { recursive: true, force: true });
  const [current] = (await h.ownerAsks.snapshot(h.paseo, true)).asks;
  assert.equal(current?.extracted, true);
  assert.equal(current?.revision, input.revision, "display and fresh action must use the same valid extraction");
  assert.equal((await h.ownerAsks.answer({ ...input, done: true }, h.paseo)).delivered, "closed");
  assert.deepEqual(h.events.filter(event => event.startsWith("complete ")), ["complete i1"]);
});

test("an unchanged comment history retries failed persistence and survives restart", async t => {
  const h = await setup({ issues: [issue()], comments: new Map([["i1", [comment("c1", waitComment)]]]) });
  t.after(() => h.ownerAsks.stop());
  h.deps.resolveModel = () => new Promise<string>(() => {});
  const cachePath = join(h.directory, "comments.json");
  await mkdir(cachePath);
  const first = await h.ownerAsks.snapshot(h.paseo);
  await rm(cachePath, { recursive: true });
  await h.ownerAsks.snapshot(h.paseo, true);
  h.ownerAsks.stop();
  h.deps.linear.ownerAskComments = async () => { throw new Error("the recovered history must survive restart"); };
  const restarted = new OwnerAsks(h.deps);
  t.after(() => restarted.stop());
  const current = await restarted.snapshot(h.paseo);
  assert.deepEqual(current.asks, first.asks, "all original sources and revisions survive without another full-history read");
});
