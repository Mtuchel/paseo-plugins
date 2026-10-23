import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { PlanRequests, planRequestText } from "./plan-requests";
import { documentPlanHash } from "./review-outcome";

// A replan request is a trusted comment for this plan's hash, or the owner's `plan` label add.
// These tests pin what counts, what reaches the agent, and what is never delivered twice.

type Comment = { id: string; at: string; authorId: string | null; body: string };
type LabelEvent = { at: string; actorId: string | null; added: string[]; removed: string[] };

const PLAN = "# Plan\n\nDo the work.\n\n## Risk and impact\n\n- Impact: 1\n";
const APPROVED_AT = "2026-10-01T10:00:00.000Z";
const CREATED_AT = "2026-10-02T10:00:00.000Z";
const hash = documentPlanHash(PLAN);
const marker = (op: string, about = hash) => `🔁 **Replan requested**\n\nReason here.\n\n<!-- replan-op: ${op} -->\n<!-- replan-for: ${about} -->`;
const comment = (id: string, at: string, authorId: string | null, op = "11111111-1111-4111-8111-111111111111", about = hash): Comment => ({ id, at, authorId, body: marker(op, about) });

async function harness(run: (h: {
  requests: PlanRequests;
  prompts: string[];
  comments: Comment[];
  events: LabelEvent[];
  files: () => Promise<string[]>;
  file: (agentId: string) => Promise<{ identifier: string; at: string; message: string }>;
  directory: string;
}) => Promise<void>, options: { comments?: Comment[]; events?: LabelEvent[]; plan?: string | null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-requests-"));
  const prompts: string[] = [];
  const comments = options.comments ?? [];
  const events = options.events ?? [];
  const plan = options.plan === undefined ? { content: PLAN } : options.plan === null ? null : { content: options.plan };
  const paseo = {
    agents: { list: async () => ({ entries: [{ agent: { id: "agent-1", createdAt: CREATED_AT, labels: { "linear.issueId": "issue-1", "linear.identifier": "TUC-7" } } }], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const requests = new PlanRequests({
    linear: {
      issueCore: async (issueId: string) => ({ id: issueId, identifier: "TUC-7", labels: [{ id: "label-plan", name: "plan" }] }),
      issueDocument: async () => plan,
      replanComments: async (_issueId: string, since: string) => comments.filter((item) => item.at > since),
      labelHistory: async (_issueId: string, relevant: (event: LabelEvent) => boolean) => events.filter(relevant),
      viewerId: async () => "owner-1",
    } as never,
    apps: { ids: async () => ["app-1"] },
    prompt: async (agentId: string, text: string) => { prompts.push(`${agentId}: ${text}`); return "sent" as const; },
    directory,
  });
  requests.attach(paseo);
  const files = async () => (await readdir(directory)).filter((name) => name !== "state.json").sort();
  try {
    await requests.poll();
    await run({ requests, prompts, comments, events, files, directory, file: async (agentId) => JSON.parse(await readFile(join(directory, agentId), "utf8")) });
  } finally {
    requests.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

test("AC-7: a trusted replan comment for the current plan reaches the agent once, with the request's text", async () => {
  await harness(async ({ requests, prompts, comments, files, file }) => {
    assert.deepEqual(prompts, []);
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1"));
    await requests.poll();
    assert.deepEqual(await files(), ["agent-1"]);
    const written = await file("agent-1");
    assert.equal(written.identifier, "TUC-7");
    assert.match(written.message, /asked for this plan to be revised/);
    assert.equal(prompts.length, 1);
    await requests.poll();
    assert.equal(prompts.length, 1, "a handled request is never delivered twice");
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-03T10:00:00.000Z");
  });
});

test("AC-7: a replan comment from anyone but a trusted Paseo app is ignored", async () => {
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { comments: [comment("c-1", "2026-10-03T10:00:00.000Z", "owner-1")] });
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { comments: [comment("c-1", "2026-10-03T10:00:00.000Z", null)] });
});

test("AC-7: a replan comment written for another plan is ignored", async () => {
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { comments: [comment("c-1", "2026-10-03T10:00:00.000Z", "app-1", "22222222-2222-4222-8222-222222222222", "3333333333333333333333333333333333333333333333333333333333333333")] });
});

test("AC-7: a comment on a ticket without an approved plan asks for nothing", async () => {
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { plan: null, comments: [comment("c-1", "2026-10-03T10:00:00.000Z", "app-1")] });
});

test("AC-8: the owner's plan label add is a request; an app's add is only the comment's indicator", async () => {
  const ownerAdd: LabelEvent[] = [{ at: "2026-10-03T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] }];
  await harness(async ({ files }) => { assert.deepEqual(await files(), ["agent-1"]); }, { events: ownerAdd });
  await harness(async ({ files, prompts }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { events: [{ at: "2026-10-03T09:00:00.000Z", actorId: "app-1", added: ["label-plan"], removed: [] }] });
});

test("AC-8: a label add from before the agent started asks for nothing", async () => {
  await harness(async ({ files, prompts }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { events: [{ at: "2026-10-01T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] }] });
});

test("the round's start is the newest request delivered to the agent, and null before any", async () => {
  await harness(async ({ requests }) => {
    assert.equal(await requests.roundStartedAt("agent-1"), null);
  });
  await harness(async ({ requests, comments }) => {
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1", "11111111-1111-4111-8111-111111111111"), comment("c-2", "2026-10-04T10:00:00.000Z", "app-1", "22222222-2222-4222-8222-222222222222"));
    await requests.poll();
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-04T10:00:00.000Z");
    assert.equal(await requests.roundStartedAt("agent-2"), null);
  });
});

test("the plugin's own send writes a request file for the agent", async () => {
  await harness(async ({ requests, files, file, prompts }) => {
    await requests.send({ id: "agent-1", issueId: "issue-1", identifier: "TUC-7" }, "Plan again for the cheap tier.");
    assert.deepEqual(await files(), ["agent-1"]);
    assert.match((await file("agent-1")).message, /cheap tier/);
    assert.deepEqual(prompts, ["agent-1: Plan again for the cheap tier."]);
  });
});

test("a comment for this plan is delivered with its reason, not the label's text", async () => {
  const request = { id: "op:1", at: "2026-10-03T10:00:00.000Z", kind: "comment" as const, authorId: "app-1" };
  assert.match(planRequestText("TUC-7", request), /another ticket's approved plan/i);
  assert.match(planRequestText("TUC-7"), /owner added the `plan` label/i);
});