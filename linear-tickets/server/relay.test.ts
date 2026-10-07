import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { RelayComment } from "./linear";
import type { Candidate } from "./deputy";
import { RateLimitedError } from "./rate-budget";
import { NeedsYouIssues } from "./needs-you";
import { recordPluginComment } from "./agent-records";
import { approvalDecision, CommentRelay, mentionMessage, questionAnswer } from "./relay";

const ME = "user-me";
const APP = "paseo-app";

test("only comments that start with @paseo are addressed to the agent", () => {
  assert.equal(mentionMessage("@paseo use SFTP"), "use SFTP");
  assert.equal(mentionMessage("  @Paseo: yes"), "yes");
  assert.equal(mentionMessage("[@paseo](https://linear.app/x) go ahead"), "go ahead");
  assert.equal(mentionMessage("@paseo"), "");
  assert.equal(mentionMessage("thanks @paseo"), null);
  assert.equal(mentionMessage("@paseobot hi"), null);
});

test("an answer fills the first question, snapping to an option label, and leaves follow-ups empty", () => {
  const request: AgentPermissionRequest = {
    id: "q1", provider: "omp", name: "ask", kind: "question", title: "Transfer?",
    input: { questions: [{ question: "Transfer?", header: "Response", options: [{ label: "SFTP" }, { label: "Mail" }] }, { question: "Optional comment", header: "Comment", options: [] }] },
  };
  assert.deepEqual(questionAnswer(request, "sftp"), { behavior: "allow", updatedInput: { answers: { Response: "SFTP", Comment: "" } } });
  assert.deepEqual(questionAnswer(request, "both, SFTP first"), { behavior: "allow", updatedInput: { answers: { Response: "both, SFTP first", Comment: "" } } });
});

test("approval replies are recognised, with an optional deny reason; other text is not a decision", () => {
  assert.deepEqual(approvalDecision("approve"), { behavior: "allow" });
  assert.deepEqual(approvalDecision("Yes!"), { behavior: "allow" });
  assert.deepEqual(approvalDecision("deny: use the staging bucket"), { behavior: "deny", message: "use the staging bucket" });
  assert.deepEqual(approvalDecision("no"), { behavior: "deny" });
  assert.equal(approvalDecision("yesterday's export is fine"), null);
  assert.equal(approvalDecision("please continue"), null);
});

type AgentFixture = { id: string; issueId: string; createdAt: string; updatedAt: string; parent?: string; pending?: AgentPermissionRequest[] };

// `appId`: the Paseo app's user, or null when the app is not usable on this host.
type Fake = { comments: Record<string, RelayComment[]>; appId: string | null; failRead?: Error | null; failReact?: Error | null };

// A throwaway cursor file per setup; pass `path` to reuse one (a plugin restart).
function setup(agents: AgentFixture[], comments: Record<string, RelayComment[]>, path = join(mkdtempSync(join(tmpdir(), "relay-")), "cursors.json"), needsYou?: NeedsYouIssues) {
  const events: string[] = [];
  const since: string[] = [];
  const reads: number[] = [];
  const fake: Fake = { comments, appId: APP };
  const linear = {
    async viewerId() { return ME; },
    async appUserId() { return fake.appId; },
    // Like Linear: comments at or after each ticket's cursor.
    async relayComments(_userId: string, cursors: { issueId: string; since: string }[]) {
      reads.push(cursors.length);
      if (fake.failRead) throw fake.failRead;
      const found = new Map<string, RelayComment[]>();
      for (const cursor of cursors) {
        since.push(`${cursor.issueId}@${cursor.since}`);
        found.set(cursor.issueId, (fake.comments[cursor.issueId] ?? []).filter((item) => item.createdAt >= cursor.since));
      }
      return { comments: found, unseen: [] };
    },
    async comment(issueId: string, body: string) { events.push(`comment ${issueId}: ${body}`); },
    async complete(issueId: string) { events.push(`complete ${issueId}`); },
    async react(commentId: string, emoji: string) {
      if (fake.failReact) throw fake.failReact;
      events.push(`react ${commentId} ${emoji}`);
    },
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: agents.map((agent) => ({ agent: { id: agent.id, createdAt: agent.createdAt, updatedAt: agent.updatedAt, labels: { "linear.issueId": agent.issueId, ...(agent.parent ? { "paseo.parent-agent-id": agent.parent } : {}) } } })),
        pageInfo: { hasMore: false },
      }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: { pendingPermissions: agents.find((agent) => agent.id === id)?.pending ?? [] } }),
        send: async (text: string) => { events.push(`send ${id}: ${text}`); },
        respondToPermission: async ({ requestId, response }: { requestId: string; response: AgentPermissionResponse }) => { events.push(`respond ${id} ${requestId} ${JSON.stringify(response)}`); },
      }),
    },
  } as unknown as PaseoApi;
  return { relay: new CommentRelay(linear, path, needsYou), paseo, events, since, reads, fake, path };
}

const comment = (id: string, body: string, extra: Partial<RelayComment> = {}): RelayComment => ({ id, body, createdAt: `2026-02-01T00:00:0${id.length}Z`, userId: ME, reactions: [], sessionId: null, parent: null, ...extra });

test("my comments on the ticket reach the newest agent and are marked delivered; anyone else's, handled ones and the plugin's own do not", async () => {
  const { relay, paseo, events, since, path } = setup([
    { id: "old", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "new", issueId: "i1", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "child", issueId: "i1", createdAt: "2026-01-04T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z", parent: "new" },
  ], {
    i1: [
      comment("c1", "@paseo please also handle returns"),
      comment("c2", "  also check the export  "),
      comment("c3", "@paseo from someone else", { userId: "user-other" }),
      comment("c4", "@paseo already delivered", { reactions: [{ emoji: "eyes", userId: ME }] }),
      // Written by the plugin with the key while the app was not usable: it shows me as its author.
      comment("c5", "**TUC-1** (Paseo) finished a turn"),
      // A real @mention of the Paseo app: its agent session delivers it, not the relay.
      comment("c6", "@paseo via the app mention", { sessionId: "session-1" }),
    ],
  });
  await recordPluginComment(dirname(path), "c5", "i1");
  await relay.poll(paseo);
  assert.deepEqual(since, ["i1@2026-01-02T00:00:00Z"]);
  assert.deepEqual(events, ["send new: please also handle returns", "send new: also check the export", "react c1 eyes", "react c2 eyes"]);
});

test("my replies reach the agent except in agent session threads; without a usable app only @paseo and replies to Paseo count", async () => {
  const agent = { id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const comments = {
    i1: [
      comment("c1", "  go with option 2 ", { parent: { id: "p-app", userId: APP, sessionId: null } }),
      comment("c22", "@paseo also mentioned", { parent: { id: "p-app", userId: APP, sessionId: null } }),
      comment("c333", "reply to my own note", { parent: { id: "p-me", userId: ME, sessionId: null } }),
      // The session webhook delivers replies in an agent session's thread.
      comment("c4444", "in the session thread", { parent: { id: "p-s", userId: ME, sessionId: "session-1" } }),
      comment("c55555", "@paseo in the session thread", { parent: { id: "p-s", userId: ME, sessionId: "session-1" } }),
    ],
  };
  const { relay, paseo, events } = setup([agent], comments);
  await relay.poll(paseo);
  assert.deepEqual(events, ["send a: go with option 2", "send a: also mentioned", "send a: reply to my own note", "react c1 eyes", "react c22 eyes", "react c333 eyes"]);

  // Without a usable app, Paseo's comments cannot be told apart from mine.
  const keyOnly = setup([agent], { i1: [comment("c1", "go with option 2", { parent: { id: "p-app", userId: APP, sessionId: null } }), comment("c22", "a plain note"), comment("c333", "@paseo go")] });
  keyOnly.fake.appId = null;
  await keyOnly.relay.poll(keyOnly.paseo);
  assert.deepEqual(keyOnly.events, ["send a: go", "react c333 eyes"]);
});

test("my comments on an issue the agent filed and replies to its comments elsewhere reach it, naming the issue", async () => {
  const T = "00000000-0000-4000-8000-000000000001";
  const FILED = "00000000-0000-4000-8000-000000000002";
  const TAKEN = "00000000-0000-4000-8000-000000000003";
  const OTHER = "00000000-0000-4000-8000-000000000004";
  const path = join(mkdtempSync(join(tmpdir(), "relay-")), "cursors.json");
  const record = (folder: string, name: string, value: object) => {
    mkdirSync(join(dirname(path), folder), { recursive: true });
    writeFileSync(join(dirname(path), folder, `${name}.json`), JSON.stringify(value));
  };
  record(`agent-issues/${T}`, FILED, { id: FILED, identifier: "TUC-9", title: "Follow-up", createdAt: "2026-01-02T00:00:00Z" });
  // A filed issue with an agent of its own belongs to that agent.
  record(`agent-issues/${T}`, TAKEN, { id: TAKEN, identifier: "TUC-10", title: "Taken", createdAt: "2026-01-02T00:00:00Z" });
  record(`agent-comments/${T}`, "p1", { id: "p1", issueId: OTHER, identifier: "TUC-7", createdAt: "2026-01-03T00:00:00Z" });
  // The agent's own comment on its ticket, written with the key: it shows me as its author.
  record(`agent-comments/${T}`, "own", { id: "own", issueId: T, identifier: null, createdAt: "2026-01-03T00:00:00Z" });
  const { relay, paseo, events, since } = setup([
    { id: "a", issueId: T, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "b", issueId: TAKEN, createdAt: "2026-01-04T00:00:00Z", updatedAt: "2026-01-04T00:00:00Z" },
  ], {
    [T]: [comment("own", "Started.")],
    [FILED]: [comment("f1", "use the staging bucket")],
    [TAKEN]: [comment("t1", "on it?")],
    [OTHER]: [
      comment("o1", "sounds right", { parent: { id: "p1", userId: ME, sessionId: null } }),
      comment("o22", "unrelated note"),
      comment("o333", "reply in another thread", { parent: { id: "p9", userId: ME, sessionId: null } }),
    ],
  }, path);
  await relay.poll(paseo);
  assert.deepEqual(since.sort(), [`${FILED}@2026-01-02T00:00:00Z`, `${OTHER}@2026-01-03T00:00:00Z`, `${TAKEN}@2026-01-04T00:00:00Z`, `${T}@2026-01-01T00:00:00Z`].sort());
  assert.deepEqual(events.filter((event) => event.startsWith("send")).sort(), [
    "send a: Comment on TUC-9, the issue you filed: use the staging bucket",
    "send a: Reply to your comment on TUC-7: sounds right",
    "send b: on it?",
  ]);
});

test("cursors saved before plain comments counted skip the plain comments written before the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "relay-")), "cursors.json");
  writeFileSync(path, JSON.stringify({ cursors: { i1: { agentId: "a", since: "2026-01-01T00:00:00Z", boundaryIds: [] } }, acks: [] }));
  const { relay, paseo, events } = setup([{ id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], {
    i1: [comment("c1", "an old note"), comment("c22", "a new note", { createdAt: "2999-01-01T00:00:00Z" })],
  }, path);
  await relay.poll(paseo);
  assert.deepEqual(events, ["send a: a new note", "react c22 eyes"]);
});

test("a comment the Paseo app already marked is not relayed again, even when the ack record was lost; without a usable app, someone else's reaction does not count", async () => {
  const agent = { id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const comments = {
    i1: [
      comment("c1", "@paseo delivered before the cursor file was lost", { reactions: [{ emoji: "eyes", userId: APP }] }),
      comment("c22", "@paseo failed before", { reactions: [{ emoji: "x", userId: APP }] }),
      comment("c333", "@paseo new one"),
    ],
  };
  // A fresh cursor file: no saved acks.
  const known = setup([agent], comments);
  await known.relay.poll(known.paseo);
  assert.deepEqual(known.events, ["send a: new one", "react c333 eyes"]);

  const unknown = setup([agent], { i1: [comment("c1", "@paseo marked by an unknown user", { reactions: [{ emoji: "eyes", userId: APP }] })] });
  unknown.fake.appId = null;
  await unknown.relay.poll(unknown.paseo);
  assert.deepEqual(unknown.events, ["send a: marked by an unknown user", "react c1 eyes"]);
});

test("a pending question is answered and a pending approval is decided from the comment", async () => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Format?", header: "Response", options: [{ label: "CSV" }] }] } };
  const tool: AgentPermissionRequest = { id: "t", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash" };
  const asking = setup([{ id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pending: [question] }], { i1: [comment("c1", "@paseo csv")] });
  await asking.relay.poll(asking.paseo);
  assert.deepEqual(asking.events, [`respond a q ${JSON.stringify({ behavior: "allow", updatedInput: { answers: { Response: "CSV" } } })}`, "react c1 eyes"]);

  const approving = setup([{ id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pending: [tool] }], { i1: [comment("c1", "@paseo deny not on prod")] });
  await approving.relay.poll(approving.paseo);
  assert.deepEqual(approving.events, [`respond a t ${JSON.stringify({ behavior: "deny", message: "not on prod" })}`, "react c1 eyes"]);
});

test("a reply on a Needs you sub-issue reaches the agent that asked and closes the sub-issue", async () => {
  const needsYou = new NeedsYouIssues(mkdtempSync(join(tmpdir(), "needs-you-")));
  await needsYou.add({ id: "sub-1", identifier: "TUC-2", parentId: "i1", agentId: "a" });
  // An entry whose agent is gone (archived) routes nothing.
  await needsYou.add({ id: "sub-9", identifier: "TUC-9", parentId: "i9", agentId: "gone" });
  const { relay, paseo, events } = setup([{ id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], {
    "sub-1": [comment("c1", "@paseo yes, enqueue it")],
    "sub-9": [comment("c9", "@paseo hello?")],
  }, undefined, needsYou);
  await relay.poll(paseo);
  assert.deepEqual(events, ["send a: yes, enqueue it", "complete sub-1", "react c1 eyes"]);
  assert.deepEqual((await needsYou.all()).map((entry) => entry.id), ["sub-9"]);
});

test("a comment that cannot be delivered is marked failed and explained on the ticket", async () => {
  const tool: AgentPermissionRequest = { id: "t", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash" };
  const { relay, paseo, events } = setup([{ id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pending: [tool] }], { i1: [comment("c1", "@paseo what are you doing?")] });
  await relay.poll(paseo);
  assert.equal(events[0], "react c1 x");
  assert.match(events[1], /^comment i1: Paseo could not deliver that comment to the agent: The agent is waiting for approval of "Allow tool: bash"\. Reply "@paseo approve"/);
});

test("all linked tickets are read in one call, each from its own agent's start", async () => {
  const { relay, paseo, reads, since } = setup([
    { id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "b", issueId: "i2", createdAt: "2026-01-05T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z" },
  ], {});
  await relay.poll(paseo);
  assert.deepEqual(reads, [2]);
  assert.deepEqual(since, ["i1@2026-01-01T00:00:00Z", "i2@2026-01-05T00:00:00Z"]);
});

test("a failed read moves no cursor: the next poll delivers everything", async () => {
  const agent = { id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const { relay, paseo, events, fake } = setup([agent], { i1: [comment("c1", "@paseo first"), comment("c22", "@paseo second")] });
  fake.failRead = new Error("The Linear API request failed: Internal error");
  await assert.rejects(relay.poll(paseo), /Internal error/);
  assert.deepEqual(events, []);
  fake.failRead = null;
  await relay.poll(paseo);
  assert.deepEqual(events, ["send a: first", "send a: second", "react c1 eyes", "react c22 eyes"]);
});

test("after a long pause and a restart, every comment written meanwhile arrives once, and handled ones never again", async () => {
  const agent = { id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const comments: Record<string, RelayComment[]> = { i1: [comment("c1", "@paseo before", { createdAt: "2026-01-01T01:00:00Z" })] };
  const first = setup([agent], comments);
  await first.relay.poll(first.paseo);
  assert.deepEqual(first.events, ["send a: before", "react c1 eyes"]);

  // Three hours of comments while the relay was paused; the new instance reads the saved cursor.
  comments.i1.push(
    comment("c2", "@paseo during one", { createdAt: "2026-01-01T02:00:00Z" }),
    // Same instant as c2: the inclusive cursor must still deliver it exactly once.
    comment("c3", "@paseo during two", { createdAt: "2026-01-01T02:00:00Z" }),
    comment("c4", "@paseo during three", { createdAt: "2026-01-01T04:00:00Z" }),
  );
  const second = setup([agent], comments, first.path);
  await second.relay.poll(second.paseo);
  assert.deepEqual(second.since, ["i1@2026-01-01T01:00:00Z"]);
  assert.deepEqual(second.events, ["send a: during one", "send a: during two", "send a: during three", "react c2 eyes", "react c3 eyes", "react c4 eyes"]);
  await second.relay.poll(second.paseo);
  assert.equal(second.events.length, 6);
});

test("a reaction the key cannot send yet stays queued; the comment is not delivered twice", async () => {
  const agent = { id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const { relay, paseo, events, fake, path } = setup([agent], { i1: [comment("c1", "@paseo go")] });
  fake.failReact = new RateLimitedError("key", Date.now() + 60_000);
  await relay.poll(paseo);
  assert.deepEqual(events, ["send a: go"]);
  // Still queued after a restart.
  const restarted = setup([agent], { i1: [comment("c1", "@paseo go")] }, path);
  await restarted.relay.poll(restarted.paseo);
  assert.deepEqual(restarted.events, ["react c1 eyes"]);
});

test("a reply to a deputy answer corrects that answer, not the newer question pending meanwhile; my answers are recorded as mine", async () => {
  const newer: AgentPermissionRequest = { id: "q2", provider: "omp", name: "ask", kind: "question", title: "Split?", input: { questions: [{ question: "Split the module?", header: "Response", options: [{ label: "Keep" }, { label: "Split" }] }] } };
  const agent = { id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pending: [newer] };
  const { relay, paseo, events } = setup([agent], { i1: [
    comment("c1", "use vitest instead", { parent: { id: "notice-1", userId: APP, sessionId: null } }),
    comment("c22", "override D-0000000f not mine"),
    comment("c333", "Keep"),
  ] });
  const corrections: string[] = [];
  const answers: string[] = [];
  const applied = { ref: "D-1a2b3c4d", identifier: "TUC-1" } as Candidate;
  relay.recordDeputy({
    noticeFor: async (commentId) => commentId === "notice-1" ? applied : null,
    byRef: async () => null,
    correct: async (candidate, text, activity) => { corrections.push(`${candidate.ref} ${text} ${activity.activityId} ${activity.userId}`); return { delivered: true, reply: "" }; },
    ownerAnswered: async (agentId, request, _response, activity) => { answers.push(`${agentId} ${request.id} ${activity.via} ${activity.activityId} ${activity.userId}`); },
  });
  await relay.poll(paseo);
  assert.deepEqual(corrections, [`D-1a2b3c4d use vitest instead c1 ${ME}`]);
  assert.deepEqual(answers, [`a q2 linear-comment c333 ${ME}`]);
  assert.deepEqual(events.filter((event) => event.startsWith("respond") || event.startsWith("send")), [`respond a q2 ${JSON.stringify({ behavior: "allow", updatedInput: { answers: { Response: "Keep" } } })}`], "only my plain answer answers the pending question");
  assert.ok(events.includes("react c22 x"), "an override of an unknown deputy answer is refused, not delivered");
});
