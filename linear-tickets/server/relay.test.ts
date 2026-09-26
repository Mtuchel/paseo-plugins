import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { RelayComment } from "./linear";
import { approvalDecision, CommentRelay, mentionMessage, questionAnswer } from "./relay";

const ME = "user-me";

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

function setup(agents: AgentFixture[], comments: Record<string, RelayComment[]>) {
  const events: string[] = [];
  const since: string[] = [];
  const linear = {
    async viewerId() { return ME; },
    async commentsSince(issueId: string, from: string) { since.push(`${issueId}@${from}`); return comments[issueId] ?? []; },
    async comment(issueId: string, body: string) { events.push(`comment ${issueId}: ${body}`); },
    async react(commentId: string, emoji: string) { events.push(`react ${commentId} ${emoji}`); },
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
  return { relay: new CommentRelay(linear), paseo, events, since };
}

const comment = (id: string, body: string, extra: Partial<RelayComment> = {}): RelayComment => ({ id, body, createdAt: `2026-01-01T00:00:0${id.length}Z`, userId: ME, reactions: [], ...extra });

test("my @paseo comments reach the newest agent on the ticket and are marked delivered; everything else is ignored", async () => {
  const { relay, paseo, events, since } = setup([
    { id: "old", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "new", issueId: "i1", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "child", issueId: "i1", createdAt: "2026-01-04T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z", parent: "new" },
  ], {
    i1: [
      comment("c1", "@paseo please also handle returns"),
      comment("c2", "just a note for the team"),
      comment("c3", "@paseo from someone else", { userId: "user-other" }),
      comment("c4", "@paseo already delivered", { reactions: [{ emoji: "eyes", userId: ME }] }),
      comment("c5", "**TUC-1** (Paseo) finished a turn: @paseo mentioned in a summary"),
    ],
  });
  await relay.poll(paseo);
  assert.deepEqual(since, ["i1@2026-01-02T00:00:00Z"]);
  assert.deepEqual(events, ["send new: please also handle returns", "react c1 eyes"]);
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

test("a comment that cannot be delivered is marked failed and explained on the ticket", async () => {
  const tool: AgentPermissionRequest = { id: "t", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash" };
  const { relay, paseo, events } = setup([{ id: "a", issueId: "i1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pending: [tool] }], { i1: [comment("c1", "@paseo what are you doing?")] });
  await relay.poll(paseo);
  assert.equal(events[0], "react c1 x");
  assert.match(events[1], /^comment i1: Paseo could not deliver that comment to the agent: The agent is waiting for approval of "Allow tool: bash"\. Reply "@paseo approve"/);
});
