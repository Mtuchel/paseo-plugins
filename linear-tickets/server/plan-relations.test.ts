import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentPlanHash } from "./review-outcome";
import { PlanRelations, RETRY_MS, summaryText } from "./plan-relations";
import { Credentials } from "./credentials";
import { LABEL_BY_NAME_QUERY, LinearService, type App } from "./linear";

const OWN = { id: "own-id", identifier: "TUC-7", title: "this ticket" };
const OTHER = { id: "other-id", identifier: "TUC-9", title: "the parser" };
const THIRD = { id: "third-id", identifier: "TUC-10", title: "the duplicate" };
const THEIR_PLAN = "# Their plan\n\nDo it.\n## Risk and impact\n\n- Impact: 1\n";
const plan = (lines: string[]) => `## Related work\n\nText.\n\n\`\`\`related-work\n${lines.join("\n")}\n\`\`\`\n`;

type Fake = ReturnType<typeof fake>;

function fake(options: { open?: boolean; unstarted?: boolean; ownLabels?: string[]; targetPlan?: string | null; targetReady?: boolean; commentNull?: boolean; failCommentOnce?: boolean; loseCommentOnce?: boolean; removeNullOnce?: boolean; coreFails?: boolean } = {}) {
  const calls: string[] = [];
  const stated = new Set<string>();
  const state = { targetPlan: options.targetPlan === undefined ? THEIR_PLAN : options.targetPlan, commentNull: options.commentNull === true, failed: false, failCommentOnce: options.failCommentOnce === true, loseCommentOnce: options.loseCommentOnce === true, lost: false, removeNull: options.removeNullOnce === true, removeFailed: false };
  const comments: { issueId: string; body: string; id?: string }[] = [];
  const labels = new Map<string, Set<string>>([["own-id", new Set(options.ownLabels ?? [])], ["other-id", new Set(options.targetReady === false ? [] : ["plan-ready"])]]);
  const status = options.unstarted === false ? "started" : "unstarted";
  const linear = {
    async issueCore(id: string) {
      calls.push(`core ${id}`);
      if (options.coreFails) throw new Error("Linear is unreachable");
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
    async removeLabelAsApp(issueId: string, name: string) { calls.push(`-${name} ${issueId}`); if (state.removeNull && !state.removeFailed) { state.removeFailed = true; return null; } labels.get(issueId)?.delete(name); return true as const; },
    async commentAsApp(issueId: string, body: string, id?: string) { calls.push(`commentAsApp ${issueId}`); if (state.commentNull) return null; if (state.loseCommentOnce && !state.lost) { state.lost = true; comments.push({ issueId, body, id }); return null; } if (state.failCommentOnce && !state.failed) { state.failed = true; return null; } comments.push({ issueId, body, id }); return true as const; },
    async commentById(id: string) { return comments.some((comment) => comment.id === id) ? { id } : null; },
    async issueDocument(_id: string, _title: string) {
      return state.targetPlan ? { url: "https://linear.app/doc/their", content: state.targetPlan } : null;
    },
    async replanComments() { calls.push("replanComments"); return comments.map((comment) => ({ body: comment.body })); },
  };
  return { calls, comments, linear, labels, stated, state };
}

async function harness(options: Parameters<typeof fake>[0], run: (h: { relations: PlanRelations; fake: Fake; directory: string; requests: () => Promise<number>; retry: () => Promise<void> }) => Promise<void>, requestCount = 0) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  const f = fake(options);
  let asked = 0;
  let now = Date.parse("2026-10-05T10:00:00Z");
  const relations = new PlanRelations(f.linear as never, async () => { asked += 1; return Array.from({ length: requestCount }, (_, index) => ({ id: `op:${index}`, at: "2026-10-05T10:00:00.000Z", kind: "comment" as const, authorId: "paseo-app" })); }, () => "server087", directory, () => now);
  // The bridge's sweep, once a retry is due: the later rounds run on the record's own schedule.
  const retry = async () => {
    now += RETRY_MS + 1_000;
    await relations.retryPending();
  };
  try {
    await run({ relations, fake: f, directory, requests: async () => asked, retry });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("AC-2: approving a plan writes its related-work lines as the Paseo app, then one summary comment", async () => {
  await harness({}, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-9 blocks TUC-7: the parser lands first", "TUC-7 relates to TUC-10: same files"]), documentUrl: "https://linear.app/doc/plan", roundStartedAt: null });
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("block") || call.startsWith("relate")), ["block other-id own-id", "relate own-id third-id related"]);
    const summary = fake.comments.at(-1)!;
    assert.equal(summary.issueId, OWN.id);
    assert.match(summary.body, /Related work applied/);
    assert.match(summary.body, /TUC-9 blocks TUC-7/);
  });
});

test("AC-8: a repeated approval writes nothing twice", async () => {
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

test("AC-7: a replan line asks the other ticket to plan again, and only about the plan it names", async () => {
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
  let now = Date.parse("2026-10-05T10:00:00Z");
  try {
    const relations = new PlanRelations(f.linear as never, async () => [], () => "server087", directory, () => now);
    // The first round saves the target hash, then the comment cannot be written.
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: reason"]), documentUrl: null, roundStartedAt: null });
    assert.equal(f.comments.length, 0);
    // The target's plan is replaced before the retry: the request does not move to it.
    f.state.targetPlan = "# A new their plan\n\nOther work.\n## Risk and impact\n\n- Impact: 2\n";
    f.state.commentNull = false;
    now += RETRY_MS + 1_000;
    await relations.retryPending();
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

test("AC-13: a links-only block applies links and leaves the plan label alone", async () => {
  await harness({ ownLabels: ["plan"] }, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-10: same files"]), documentUrl: null, roundStartedAt: "2026-10-05T09:00:00.000Z", cleanup: false });
    assert.ok(!fake.calls.some((call) => call.startsWith("-plan")));
  });
});

test("summaryText says nothing when there is nothing to report", () => {
  assert.equal(summaryText({ identifier: "TUC-7", documentUrl: null, dropped: [], doneElsewhere: [], unreadable: [], removalKept: false, removalRestored: false }, []), null);
});

test("AC-7: a replan of a ticket without an approved plan, or of a done ticket, is skipped with the reason", async () => {
  await harness({ targetReady: false }, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: this replaces its plan"]), documentUrl: null, roundStartedAt: null });
    assert.equal(fake.comments.filter((comment) => comment.issueId === OTHER.id).length, 0);
    assert.match(fake.comments.at(-1)!.body, /this replaces its plan \(the ticket has no approved plan\)/);
  });
  await harness({ open: false }, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: this replaces its plan"]), documentUrl: null, roundStartedAt: null });
    assert.equal(fake.comments.filter((comment) => comment.issueId === OTHER.id).length, 0);
    assert.match(fake.comments.at(-1)!.body, /\(the ticket is not open\)/);
  });
});

test("AC-7: a duplicate of an unstarted ticket gets the hold label, one comment and the link; a crash after the label repeats neither", async () => {
  const request = { issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 duplicates TUC-9: the same work"]), documentUrl: null, roundStartedAt: null };
  await harness({ failCommentOnce: true }, async ({ relations, fake, retry }) => {
    await relations.file(request);
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("+")), ["+paseo-hold own-id"], "the hold is written before the comment");
    assert.equal(fake.comments.filter((comment) => /Closed as a duplicate/.test(comment.body)).length, 0, "the duplicate comment could not be written");
    fake.calls.length = 0;
    await retry();
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("+")), [], "the retry does not add the hold again");
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("relate")), ["relate own-id other-id duplicate"]);
    assert.match(fake.comments.find((comment) => comment.issueId === OWN.id && /Closed as a duplicate/.test(comment.body))!.body, /Closed as a duplicate of TUC-9 by TUC-7's approved plan/);
  });
});

test("AC-13: a replan comment written before the record was saved is found on the restart and not posted twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  const f = fake({ commentNull: true });
  let now = Date.parse("2026-10-05T10:00:00Z");
  try {
    const relations = new PlanRelations(f.linear as never, async () => [], () => "server087", directory, () => now);
    const request = { issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: this plan changes what it builds"]), documentUrl: null, roundStartedAt: null };
    await relations.file(request);
    const record = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    const step = record.steps[record.lines[0]];
    assert.equal(typeof step.opId, "string");
    // Linear created the comment; the process died before the record said so.
    f.comments.push({ issueId: OTHER.id, body: `🔁 **Replan requested**\n\nReason.\n\n<!-- replan-op: ${step.opId} -->\n<!-- replan-for: ${step.replanFor} -->` });
    f.state.commentNull = false;
    now += RETRY_MS + 1_000;
    await relations.retryPending();
    assert.equal(f.comments.filter((comment) => comment.issueId === OTHER.id).length, 1, "the retry posts no second comment");
    assert.ok(f.labels.get("other-id")!.has("plan"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AC-8: a new plan revision asks its `replan` line again with a new operation id", async () => {
  await harness({}, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["replan TUC-9: one reason"]), documentUrl: null, roundStartedAt: null });
    const first = fake.comments.find((comment) => comment.issueId === OTHER.id)!;
    const firstOp = /<!-- replan-op: ([0-9a-f-]{36}) -->/.exec(first.body)![1];
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: `## Related work\n\nRevised.\n\n\`\`\`related-work\nreplan TUC-9: the revised plan changes more\n\`\`\`\n`, documentUrl: null, roundStartedAt: null });
    const requests = fake.comments.filter((comment) => comment.issueId === OTHER.id);
    assert.equal(requests.length, 2);
    const secondOp = /<!-- replan-op: ([0-9a-f-]{36}) -->/.exec(requests[1].body)![1];
    assert.notEqual(secondOp, firstOp, "a revised plan's request is its own request");
    assert.match(requests[1].body, /the revised plan changes more/);
  });
});

test("AC-8: a duplicate of a ticket someone works on is skipped with the reason", async () => {
  await harness({ unstarted: false }, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 duplicates TUC-9: the same work"]), documentUrl: null, roundStartedAt: null });
    assert.ok(!fake.calls.some((call) => call.startsWith("+paseo-hold") || call.startsWith("relate")));
    assert.match(fake.comments.at(-1)!.body, /started or with an agent; only a ticket nobody works on is closed as a duplicate/);
  });
});

test("AC-13: a request that lands while the label is being removed sets the label back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  const f = fake({ ownLabels: ["plan"] });
  let asked = 0;
  try {
    const relations = new PlanRelations(f.linear as never, async () => {
      asked += 1;
      // The removal's first read sees no request; the read after the removal sees one.
      return asked === 2 ? [{ id: "op:late", at: "2026-10-05T09:00:00.000Z", kind: "comment" as const, authorId: "paseo-app" }] : [];
    }, () => "server087", directory);
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-9: same files"]), documentUrl: null, roundStartedAt: "2026-10-05T08:00:00.000Z" });
    assert.deepEqual(f.calls.filter((call) => call.startsWith("-plan") || call.startsWith("+plan")), ["-plan own-id", "+plan own-id"]);
    assert.match(f.comments.at(-1)!.body, /was set again: a replan request arrived while it was being removed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AC-13: a failed label removal is retried on the restart, or kept when a request arrived meanwhile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  const f = fake({ ownLabels: ["plan"], removeNullOnce: true });
  let late = false;
  let now = Date.parse("2026-10-05T10:00:00Z");
  try {
    // The removal's attempt fails; on the restart the ticket has a newer request.
    const relations = new PlanRelations(f.linear as never, async () => (late ? [{ id: "op:late", at: "2026-10-05T09:00:00.000Z", kind: "comment" as const, authorId: "paseo-app" }] : []), () => "server087", directory, () => now);
    const request = { issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-9: same files"]), documentUrl: null, roundStartedAt: "2026-10-05T08:00:00.000Z" };
    await relations.file(request);
    late = true;
    assert.deepEqual(f.calls.filter((call) => call === "-plan own-id"), ["-plan own-id"], "the failed removal is the only attempt");
    assert.ok(f.labels.get("own-id")!.has("plan"), "the label is still there");
    now += RETRY_MS + 1_000;
    await relations.retryPending();
    assert.deepEqual(f.calls.filter((call) => call === "-plan own-id"), ["-plan own-id"], "the retry sees the request and removes nothing");
    assert.ok(f.labels.get("own-id")!.has("plan"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AC-13: a failed label removal with no newer request ends with the label removed on the restart", async () => {
  await harness({ ownLabels: ["plan"], removeNullOnce: true }, async ({ relations, fake, retry }) => {
    const request = { issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-9: same files"]), documentUrl: null, roundStartedAt: "2026-10-05T08:00:00.000Z" };
    await relations.file(request);
    assert.ok(fake.labels.get("own-id")!.has("plan"));
    await retry();
    assert.ok(!fake.labels.get("own-id")!.has("plan"), "the retry removes it");
  });
});

test("AC-14: every write through an unusable app leaves the record retrying, stops after five rounds, and never touches the key", async () => {
  const keyed: string[] = [];
  const post = async (_key: string, query: string) => {
    keyed.push(query);
    if (query === LABEL_BY_NAME_QUERY) return { issueLabels: { nodes: [{ id: "label-plan", name: "plan" }] } };
    throw new Error(`the owner's key was used for a write: ${query}`);
  };
  const app: App = { query: async () => null, mutate: async () => null, viewer: async () => ({ id: "paseo-app", name: "Paseo" }) };
  const direct = new LinearService(new Credentials("/unused", "owner-key"), post, app);
  const f = fake();
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  let now = Date.parse("2026-10-05T10:00:00Z");
  try {
    const relations = new PlanRelations({
      ...f.linear,
      addBlockerAsApp: (blocker: string, blocked: string) => direct.addBlockerAsApp(blocker, blocked),
      relateAsApp: (issueId: string, relatedId: string, type: "related" | "duplicate") => direct.relateAsApp(issueId, relatedId, type),
      addLabelAsApp: (issueId: string, name: string) => direct.addLabelAsApp(issueId, name),
      removeLabelAsApp: (issueId: string, name: string) => direct.removeLabelAsApp(issueId, name),
      commentAsApp: (issueId: string, body: string, id?: string) => direct.commentAsApp(issueId, body, id),
    } as never, async () => [], () => "server087", directory, () => now);
    const blocked = plan(["TUC-9 blocks TUC-7: it lands first", "TUC-9 duplicates TUC-7: the same work", "TUC-7 relates to TUC-10: same files", "replan TUC-9: this changes it"]);
    const request = { issueId: OWN.id, identifier: OWN.identifier, plan: blocked, documentUrl: null, roundStartedAt: null };
    await relations.file(request);
    for (let round = 0; round < 4; round++) {
      now += 11 * 60_000;
      await relations.retryPending();
    }
    const record = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(record.attempts, 5);
    assert.equal(record.stopped, "gave-up");
    assert.ok(keyed.every((query) => query === LABEL_BY_NAME_QUERY), "only the label id lookup used the key");
    // A journal retry of the same decision resolves without a round and without reviving the record.
    await relations.file(request);
    assert.equal(JSON.parse(await readFile(join(directory, "own-id.json"), "utf8")).attempts, 5, "a stopped record is not retried");
    now += 11 * 60_000;
    await relations.retryPending();
    assert.equal(JSON.parse(await readFile(join(directory, "own-id.json"), "utf8")).attempts, 5, "the sweep leaves it alone");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AC-14: a ticket read that keeps failing counts every round and stops after five", async () => {
  await harness({ coreFails: true }, async ({ relations, directory, retry }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-9 blocks TUC-7: it lands first"]), documentUrl: null, roundStartedAt: null });
    for (let round = 0; round < 6; round++) await retry();
    const record = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.deepEqual({ attempts: record.attempts, stopped: record.stopped }, { attempts: 5, stopped: "gave-up" });
  });
});

test("AC-14: an untrusted ticket gets exactly one comment and no link, label or replan write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  const f = fake();
  try {
    const relations = new PlanRelations({ ...f.linear, async issueCore(id: string) { return { id, identifier: "TUC-7", creatorId: "stranger", status: "Todo", statusType: "unstarted", labels: [] } as never; } } as never, async () => [], () => "server087", directory);
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-9 blocks TUC-7: it lands first", "TUC-7 relates to TUC-10: same files", "replan TUC-9: this changes it"]), documentUrl: null, roundStartedAt: null });
    assert.deepEqual(f.calls.filter((call) => /^(block|relate|[+-]|commentAsApp)/.test(call) && call !== "commentAsApp own-id"), []);
    assert.equal(f.calls.filter((call) => call === "commentAsApp own-id").length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AC-14: a retried decision step keeps the record's rounds and schedule, and only a revised plan resets them", async () => {
  await harness({ commentNull: true }, async ({ relations, fake, directory, retry }) => {
    const request = { issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-10: same files"]), documentUrl: null, roundStartedAt: null };
    // The summary cannot be written: the round fails, schedules its retry, and the step resolves.
    await relations.file(request);
    const first = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(first.attempts, 1);
    assert.equal(first.stopped, undefined);
    const calls = fake.calls.length;
    // The decision journal retries the step meanwhile: nothing is due, so nothing runs.
    await relations.file(request);
    const second = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(second.attempts, 1, "a retried step does not reset the rounds");
    assert.equal(second.retryAt, first.retryAt, "its retry schedule is kept");
    assert.equal(fake.calls.length, calls, "no write runs before the retry is due");
    // Due: the sweep runs the next round and counts it.
    await retry();
    assert.equal(JSON.parse(await readFile(join(directory, "own-id.json"), "utf8")).attempts, 2);
    // A revised plan is a fresh attempt, from round zero.
    fake.state.commentNull = false;
    await relations.file({ ...request, plan: plan(["TUC-7 relates to TUC-10: the same files, revised"]) });
    const revised = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(revised.attempts, 0);
    assert.equal(revised.retryAt, null);
    assert.equal(revised.stopped, undefined);
    assert.match(fake.comments.at(-1)!.body, /revised/);
  });
});

test("AC-7: a line may name the plan's own ticket second, and its first ticket is the one a duplicate changes", async () => {
  await harness({}, async ({ relations, fake }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-10 duplicates TUC-7: the same work", "TUC-9 relates to TUC-7: same files"]), documentUrl: null, roundStartedAt: null });
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("+")), ["+paseo-hold third-id"], "the hold goes on the duplicated ticket");
    const explanation = fake.comments.find((comment) => comment.issueId === THIRD.id && /Closed as a duplicate/.test(comment.body))!;
    assert.match(explanation.body, /Closed as a duplicate of TUC-7 by TUC-7's approved plan/);
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("relate")), ["relate third-id own-id duplicate", "relate other-id own-id related"]);
  });
});

test("AC-7: a duplicate explanation whose answer was lost is found again instead of posted twice", async () => {
  await harness({ loseCommentOnce: true }, async ({ relations, fake, directory, retry }) => {
    await relations.file({ issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 duplicates TUC-9: the same work"]), documentUrl: null, roundStartedAt: null });
    const record = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    const step = record.steps[record.lines[0]];
    assert.equal(typeof step.tellId, "string", "the comment id is reserved before it is posted");
    assert.equal(step.told, undefined, "the lost answer leaves the step open");
    assert.equal(fake.comments.filter((comment) => /Closed as a duplicate/.test(comment.body)).length, 1, "Linear created it");
    await retry();
    const explained = fake.comments.filter((comment) => /Closed as a duplicate/.test(comment.body));
    assert.equal(explained.length, 1, "the retry finds the comment instead of posting it again");
    assert.equal(explained[0].id, step.tellId, "it was posted under the reserved id");
    assert.deepEqual(fake.calls.filter((call) => call.startsWith("relate")), ["relate own-id other-id duplicate"]);
  });
});

test("AC-14: an unavailable summary write keeps its reservation, announces nothing and retries within bounds", async () => {
  const request = { issueId: OWN.id, identifier: OWN.identifier, plan: plan(["TUC-7 relates to TUC-10: same files"]), documentUrl: null, roundStartedAt: null };
  await harness({ commentNull: true }, async ({ relations, fake, directory, retry }) => {
    await relations.file(request);
    const first = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(first.summary, null, "the summary is not marked announced");
    assert.equal(typeof first.summaryId, "string");
    assert.equal(typeof first.summaryPending, "string");
    assert.equal(fake.comments.length, 0);
    fake.state.commentNull = false;
    await retry();
    const second = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(typeof second.summary, "string");
    assert.equal(second.summaryId, undefined);
    assert.equal(second.summaryPending, undefined);
    assert.equal(fake.comments.at(-1)!.id, first.summaryId, "the retry posts under the reserved id");
  });
  await harness({ commentNull: true }, async ({ relations, fake, directory, retry }) => {
    await relations.file(request);
    for (let round = 0; round < 4; round++) await retry();
    const record = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(record.attempts, 5);
    assert.equal(record.stopped, "gave-up");
    assert.equal(record.summary, null);
    assert.equal(typeof record.summaryPending, "string", "the reservation is kept");
    assert.equal(fake.comments.length, 0);
  });
  // An untrusted ticket's information-only comment follows the same rule.
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-relations-"));
  const untrusted = fake({ commentNull: true });
  let now = Date.parse("2026-10-05T10:00:00Z");
  try {
    const relations = new PlanRelations({ ...untrusted.linear, async issueCore(id: string) { return { id, identifier: "TUC-7", creatorId: "stranger", status: "Todo", statusType: "unstarted", labels: [] } as never; } } as never, async () => [], () => "server087", directory, () => now);
    await relations.file(request);
    const first = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(first.stopped, "untrusted");
    assert.equal(typeof first.summaryId, "string", "the information comment is reserved");
    untrusted.state.commentNull = false;
    now += RETRY_MS + 1_000;
    await relations.retryPending();
    const second = JSON.parse(await readFile(join(directory, "own-id.json"), "utf8"));
    assert.equal(typeof second.summary, "string");
    assert.equal(untrusted.comments.length, 1);
    assert.equal(untrusted.comments[0].id, first.summaryId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
