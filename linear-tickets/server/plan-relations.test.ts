import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentPlanHash } from "./review-outcome";
import { PlanRelations, summaryText } from "./plan-relations";

const OWN = { id: "own-id", identifier: "TUC-7", title: "this ticket" };
const OTHER = { id: "other-id", identifier: "TUC-9", title: "the parser" };
const THIRD = { id: "third-id", identifier: "TUC-10", title: "the duplicate" };
const THEIR_PLAN = "# Their plan\n\nDo it.\n## Risk and impact\n\n- Impact: 1\n";
const plan = (lines: string[]) => `## Related work\n\nText.\n\n\`\`\`related-work\n${lines.join("\n")}\n\`\`\`\n`;

type Fake = ReturnType<typeof fake>;

function fake(options: { open?: boolean; unstarted?: boolean; ownLabels?: string[]; targetPlan?: string | null; targetReady?: boolean; commentNull?: boolean } = {}) {
  const calls: string[] = [];
  const stated = new Set<string>();
  const state = { targetPlan: options.targetPlan === undefined ? THEIR_PLAN : options.targetPlan, commentNull: options.commentNull === true };
  const comments: { issueId: string; body: string; id?: string }[] = [];
  const labels = new Map<string, Set<string>>([["own-id", new Set(options.ownLabels ?? [])], ["other-id", new Set(options.targetReady === false ? [] : ["plan-ready"])]]);
  const status = options.unstarted === false ? "started" : "unstarted";
  const linear = {
    async issueCore(id: string) {
      calls.push(`core ${id}`);
      return { id, identifier: id === "own-id" ? "TUC-7" : "TUC-9", creatorId: "owner", status: "Todo", statusType: status, labels: [...(labels.get(id) ?? [])].map((name, index) => ({ id: `l${index}`, name })) } as never;
    },
    async issueRef(identifier: string) {
      calls.push(`ref ${identifier}`);
      return identifier === "TUC-7" ? { ...OWN } : identifier === "TUC-9" ? { ...OTHER } : identifier === "TUC-10" ? { ...THIRD } : null;
    },
    async issueRelations() { calls.push("relations"); return []; },
    async blockerStates(ids: string[]) {
      calls.push(`blockers ${ids.join(",")}`);
      return ids.map((id) => ({ id, identifier: id === "own-id" ? "TUC-7" : "TUC-9", status: "Todo", statusType: options.open === false ? "completed" : status, delegateId: null, finished: options.open === false }));
    },
    async viewerId() { return "owner"; },
    async trustedAppIds() { return ["paseo-app"]; },
    async addBlockerAsApp(blockerId: string, blockedId: string) { calls.push(`block ${blockerId} ${blockedId}`); return true as const; },
    async relateAsApp(issueId: string, relatedId: string, type: string) { calls.push(`relate ${issueId} ${relatedId} ${type}`); return true as const; },
    async addLabelAsApp(issueId: string, name: string) { calls.push(`+${name} ${issueId}`); labels.get(issueId)?.add(name); return true as const; },
    async removeLabelAsApp(issueId: string, name: string) { calls.push(`-${name} ${issueId}`); labels.get(issueId)?.delete(name); return true as const; },
    async commentAsApp(issueId: string, body: string, id?: string) { calls.push(`commentAsApp ${issueId}`); if (state.commentNull) return null; comments.push({ issueId, body, id }); return true as const; },
    async commentById(id: string) { return comments.some((comment) => comment.id === id) ? { id } : null; },
    async issueDocument(_id: string, _title: string) {
      return state.targetPlan ? { url: "https://linear.app/doc/their", content: state.targetPlan } : null;
    },
    async replanComments() { calls.push("replanComments"); return []; },
  };
  return { calls, comments, linear, labels, stated, state };
}

async function harness(options: Parameters<typeof fake>[0], run: (h: { relations: PlanRelations; fake: Fake; directory: string; requests: () => Promise<number> }) => Promise<void>, requestCount = 0) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  const f = fake(options);
  let asked = 0;
  const relations = new PlanRelations(f.linear as never, async () => { asked += 1; return Array.from({ length: requestCount }, (_, index) => ({ id: `op:${index}`, at: "2026-10-05T10:00:00.000Z", kind: "comment" as const, authorId: "paseo-app" })); }, () => "server087", directory);
  try {
    await run({ relations, fake: f, directory, requests: async () => asked });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("AC-11: approving a plan writes its related-work lines as the Paseo app, then one summary comment", async () => {
  await harness({}, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-9 blocks TUC-7: the parser lands first", "TUC-7 relates to TUC-10: same files"]), documentUrl: "https://linear.app/doc/plan", roundStartedAt: null });
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("block") || call.startsWith("relate")), ["block other-id own-id", "relate own-id third-id related"]);
    const summary = fake.comments.at(-1)!;
    assert.equal(summary.issueId, OWN.id);
    assert.match(summary.body, /Related work applied/);
    assert.match(summary.body, /TUC-9 blocks TUC-7/);
  });
});

test("AC-11: a repeated approval writes nothing twice", async () => {
  await harness({}, async ({ relations, fake }) => {
    const request = { issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-9 blocks TUC-7: the parser lands first"]), documentUrl: null, roundStartedAt: null };
    await relations.file(request);
    const writes = fake.calls.filter((call) => call.startsWith("block") || call.startsWith("relate"));
    const comments = fake.comments.length;
    await relations.file(request);
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("block") || call.startsWith("relate")), writes);
    assert.equal(fake.comments.length, comments);
  });
});

test("AC-13: a replan line asks the other ticket to plan again, and only about the plan it names", async () => {
  await harness({}, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: this plan changes what it builds"]), documentUrl: "https://linear.app/doc/plan", roundStartedAt: null });
    const request = fake.comments.find((comment) => comment.issueId === OTHER.id)!;
    assert.ok(request, "the request comment goes on the other ticket");
    assert.match(request.body, /Replan requested/);
    assert.match(request.body, /<!-- replan-op: [0-9a-f-]{36} -->/);
    assert.match(request.body, new RegExp(`<!-- replan-for: ${documentPlanHash(THEIR_PLAN)} -->`));
    assert.ok(fake.labels.get("other-id")!.has("plan"), "the plan label is the visible indicator");
  });
});

test("AC-13: a replan request is not moved to a plan that replaced the one it was written for", async () => {
  const f = fake({ commentNull: true });
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  try {
    const relations = new PlanRelations(f.linear as never, async () => [], () => "server087", directory);
    // The first round saves the target hash, then the comment cannot be written.
    await assert.rejects(relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: reason"]), documentUrl: null, roundStartedAt: null }));
    assert.equal(f.comments.length, 0);
    // The target's plan is replaced before the retry: the request does not move to it.
    f.state.targetPlan = "# A new their plan\n\nOther work.\n## Risk and impact\n\n- Impact: 2\n";
    f.state.commentNull = false;
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: reason"]), documentUrl: null, roundStartedAt: null });
    assert.equal(f.comments.filter((comment) => comment.issueId === OTHER.id).length, 0);
    assert.match(f.comments.at(-1)!.body, /replaced since this request/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AC-13: the plan label is removed after the round, and kept when a request is newer", async () => {
  await harness({ ownLabels: ["plan"] }, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-9: same files"]), documentUrl: null, roundStartedAt: "2026-10-05T09:00:00.000Z" });
    assert.ok(fake.calls.includes("-plan own-id"));
  });
  await harness({ ownLabels: ["plan"] }, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-9: same files"]), documentUrl: null, roundStartedAt: "2026-10-05T09:00:00.000Z" });
    assert.ok(!fake.calls.includes("-plan own-id"), "a request arrived: the label stays");
    assert.match(fake.comments.at(-1)!.body, /label stays/);
  }, 1);
});

test("AC-14: a ticket not written by the owner or Paseo gets no writes, and the summary asks for a hand review", async () => {
  await harness({}, async ({ relations: _unused }) => {
    const f = fake();
    const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
    try {
      const relations = new PlanRelations({ ...f.linear, async issueCore(id: string) { return { id, identifier: "TUC-7", creatorId: "stranger", status: "Todo", statusType: "unstarted", labels: [] } as never; } } as never, async () => [], () => "server087", directory);
      await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-9 blocks TUC-7: x"]), documentUrl: null, roundStartedAt: null });
      assert.deepEqual(f.calls.filter((call) => call.startsWith("block")), []);
      assert.match(f.comments.at(-1)!.body, /not applied because this ticket was not written by you or Paseo/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test("a links-only block applies links and leaves the plan label alone", async () => {
  await harness({ ownLabels: ["plan"] }, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-10: same files"]), documentUrl: null, roundStartedAt: "2026-10-05T09:00:00.000Z", cleanup: false });
    assert.ok(!fake.calls.some((call) => call.startsWith("-plan")));
  });
});

test("summaryText says nothing when there is nothing to report", () => {
  assert.equal(summaryText({ identifier: "TUC-7", documentUrl: null, dropped: [], doneElsewhere: [], unreadable: [], removalKept: false, removalRestored: false }, []), null);
});
