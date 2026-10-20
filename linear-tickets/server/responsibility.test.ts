import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { type ApplyingEntry, DecisionPendingError, type DecisionAttempt, type JournalEntry, type ReviewGeneration, type ReviewSupersession, reviewEntryId, type UnboundReport } from "./decision-journal";
import type { ParkedPlan } from "./parked";
import { RepairExclusion } from "./repair-exclusion";
import { type Evidence, judge, type ResponsibilityDeps, type ResponsibilityFile, type ResponsibilityTicket, ResponsibilityCheck, ResponsibilityStore, submittedPlanFile } from "./responsibility";
import type { ReviewDeletion } from "./review-deletions";
import type { ReviewEntry, TicketReviews } from "./review-links";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ISSUE = "11111111-1111-4111-8111-111111111111";
const PLAN = "# Plan\n\nDo the thing.\n";
const REVISION = createHash("sha256").update(PLAN).digest("hex");
const LOCAL_URL = "http://127.0.0.1:19432";
const OPENED = iso(T0 - 120 * MIN);

function evidence(extra: Partial<Evidence>): Evidence {
  return { status: "Planning", statusType: "started", ownerHold: false, liveRoots: [], queued: false, reviews: [], question: null, reviewsKnown: true, handoff: null, ...extra };
}

test("backlog shapes: each 2026-10-07 shape gets the verdict its status expects", () => {
  assert.equal(judge(evidence({ status: "Todo", statusType: "unstarted" })), null, "Todo + plan-ready: not judged");
  assert.equal(judge(evidence({ status: "Backlog", statusType: "backlog" })), null, "Backlog + plan-ready: not judged");
  assert.deepEqual(judge(evidence({ status: "Plan approved" })), { verdict: "violation", kind: "approved-no-handoff" });
  assert.deepEqual(judge(evidence({ status: "Plan review" })), { verdict: "violation", kind: "review-missing" });
  assert.deepEqual(judge(evidence({ liveRoots: ["a1"] })), { verdict: "fine" }, "Planning with a live agent");
  assert.deepEqual(judge(evidence({ queued: true })), { verdict: "fine" }, "Planning with only a queued thread");
  assert.deepEqual(judge(evidence({})), { verdict: "violation", kind: "planning-no-agent" });
});

test("re-approved with a new implementer: In Progress with its live root, and Plan approved with a queued thread, are fine", () => {
  assert.deepEqual(judge(evidence({ status: "In Progress", liveRoots: ["impl"] })), { verdict: "fine" });
  assert.deepEqual(judge(evidence({ status: "Plan approved", queued: true })), { verdict: "fine" });
  assert.deepEqual(judge(evidence({ status: "Plan approved", reviews: [{ agentId: "a1", source: "applying" }] })), { verdict: "fine" }, "a decision being applied is the hand-off");
  assert.deepEqual(judge(evidence({ status: "In Progress" })), { verdict: "violation", kind: "in-progress-no-agent" });
});

test("steps merge per agent; two distinct steps are reported, a step of the wrong kind names what was found", () => {
  const review = { agentId: "a1", source: "open" as const };
  assert.deepEqual(judge(evidence({ status: "Plan review", reviews: [review, { agentId: "a1", source: "parked" }, { agentId: null, source: "thread" }], liveRoots: ["a1"] })), { verdict: "fine" }, "one agent's review, parked plan, thread and live root are one step");
  assert.deepEqual(judge(evidence({ status: "Plan review", reviews: [review, { agentId: "a2", source: "open" }] })), { verdict: "violation", kind: "two-steps", why: "found: an open review, an open review" });
  assert.deepEqual(judge(evidence({ liveRoots: ["a1", "a2"] })), { verdict: "violation", kind: "two-steps", why: "found: a running agent, a running agent" });
  assert.deepEqual(judge(evidence({ liveRoots: ["a1"], queued: true })), { verdict: "violation", kind: "two-steps", why: "found: a running agent, a queued thread" });
  assert.deepEqual(judge(evidence({ reviews: [review] })), { verdict: "violation", kind: "planning-no-agent", why: "found: an open review" });
  assert.deepEqual(judge(evidence({ status: "Needs input", statusType: "started", question: { agentId: "a1" }, liveRoots: ["a1"] })), { verdict: "fine" }, "the question's own agent is part of it");
  assert.deepEqual(judge(evidence({ status: "Needs input", liveRoots: ["a1"] })), { verdict: "violation", kind: "needs-input-no-question", why: "found: a running agent" });
});

test("an owner hold or blocker is fine under any status; unread peers make plan reviews unknown; a repair's parked plan is the Planning hand-off", () => {
  assert.deepEqual(judge(evidence({ status: "Plan review", ownerHold: true })), { verdict: "fine" });
  assert.deepEqual(judge(evidence({ status: "Plan review", reviewsKnown: false })), { verdict: "unknown", why: "a peer's reviews could not be read" });
  const parked = { reviews: [{ agentId: "a1", source: "parked" as const }] };
  assert.deepEqual(judge(evidence({ ...parked, handoff: "a1" })), { verdict: "fine" });
  assert.deepEqual(judge(evidence(parked))?.verdict, "violation", "an ordinary parked plan is no Planning hand-off");
});

test("the plan file is the transcript's last submission, in every submission form", () => {
  const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } });
  const handle = "/sessions/s1.jsonl";
  assert.equal(submittedPlanFile(call("plannotator_submit_plan", { filePath: "PLAN.md" }), handle, "/work"), "/work/PLAN.md");
  assert.equal(submittedPlanFile(call("write", { path: "xd://propose", content: "rework" }), handle, "/work"), "/sessions/s1/local/rework-plan.md");
  assert.equal(submittedPlanFile(call("write", { path: "xd://plannotator_submit_plan", content: JSON.stringify({ filePath: "/abs/P.md" }) }), handle, "/work"), "/abs/P.md");
  const both = [call("plannotator_submit_plan", { filePath: "OLD.md" }), "not json xd://propose", call("plannotator_submit_plan", { filePath: "NEW.md" })].join("\n");
  assert.equal(submittedPlanFile(both, handle, "/work"), "/work/NEW.md");
  assert.equal(submittedPlanFile(call("write", { path: "notes.md", content: "x" }), handle, "/work"), null);
});

// --- The check against fakes of its stores ------------------------------------------------------

type Harness = {
  check: ResponsibilityCheck;
  store: ResponsibilityStore;
  journal: JournalEntry[];
  parked: Map<string, ParkedPlan>;
  puts: ParkedPlan[];
  deletions: { issue: ReviewDeletion | null; agent: ReviewDeletion | null };
  reviews: { entry: ReviewEntry | null; inbox: TicketReviews };
  agents: PaseoAgent[];
  exclusion: RepairExclusion;
  clock: { now: number };
  files: Map<string, string>;
  paseo: PaseoApi;
  cleanup(): Promise<void>;
};

function journalOf(list: JournalEntry[]): ResponsibilityDeps["journal"] {
  const find = <T extends JournalEntry>(match: (entry: JournalEntry) => entry is T) => list.find(match) ?? null;
  return {
    all: () => list,
    review: (id) => find((entry): entry is ReviewGeneration => entry.kind === "review" && entry.id === id),
    attempts: (reviewId) => list.filter((entry): entry is DecisionAttempt => entry.kind === "attempt" && (!reviewId || entry.reviewId === reviewId)),
    applying: () => list.flatMap((entry): ApplyingEntry[] => entry.kind === "attempt" && (entry.state === "pending" || entry.state === "uncertain") ? [{ kind: "attempt", entry, review: null }]
      : entry.kind === "unbound" && entry.state === "open" ? [{ kind: "unbound", entry, review: null }] : []),
    busy: (agentId) => list.some((entry) => entry.kind === "attempt" && entry.agentId === agentId && ["deciding", "uncertain", "pending"].includes(entry.state)),
    superseded: (reviewId) => find((entry): entry is ReviewSupersession => entry.kind === "superseded" && entry.reviewId === reviewId),
    replacement: (repairId) => find((entry): entry is ReviewGeneration => entry.kind === "review" && entry.repairId === repairId),
    supersession: (repairId) => find((entry): entry is ReviewSupersession => entry.kind === "superseded" && entry.repairId === repairId),
    supersede: async ({ review, issueId, repairId, parkedAt }) => {
      const known = list.find((entry): entry is ReviewSupersession => entry.kind === "superseded" && entry.reviewId === review.id);
      if (known && known.repairId !== repairId) throw new DecisionPendingError("This review was restored by another repair already.");
      if (known) return known;
      const marker: ReviewSupersession = { kind: "superseded", id: `superseded-${review.id}`, reviewId: review.id, agentId: review.agentId, issueId, repairId, parkedAt, at: iso(T0) };
      list.push(marker);
      return marker;
    },
  };
}

const REVIEW: ReviewGeneration = { kind: "review", id: reviewEntryId("a1", LOCAL_URL, OPENED), agentId: "a1", localUrl: LOCAL_URL, openedAt: OPENED, planHash: REVISION, parked: false, at: OPENED };

function agent(extra: Partial<PaseoAgent> = {}): PaseoAgent {
  return { id: "a1", cwd: "/work", createdAt: iso(T0 - 180 * MIN), archivedAt: iso(T0 - 40 * MIN), status: "closed", labels: { "linear.issueId": ISSUE }, persistence: { nativeHandle: "/sessions/a1.jsonl" }, ...extra } as PaseoAgent;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "responsibility-"));
  const clock = { now: T0 };
  const store = new ResponsibilityStore("server087", join(dir, "responsibility.json"));
  const journal: JournalEntry[] = [REVIEW];
  const parked = new Map<string, ParkedPlan>();
  const puts: ParkedPlan[] = [];
  const deletions: Harness["deletions"] = { issue: null, agent: null };
  const reviews: Harness["reviews"] = {
    entry: { agentId: "a1", localUrl: LOCAL_URL, remoteUrl: null, identifier: "TUC-9", issueId: ISSUE, openedAt: OPENED, reviewId: REVIEW.id, closedAt: iso(T0 - 30 * MIN), revision: REVISION, model: "sol" },
    inbox: { rows: [], unreachable: [] },
  };
  const agents = [agent()];
  const transcript = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "plannotator_submit_plan", arguments: { filePath: "PLAN.md" } }] } });
  const files = new Map([["/sessions/a1.jsonl", transcript], ["/work/PLAN.md", PLAN]]);
  const exclusion = new RepairExclusion();
  const paseo = { agents: { list: async () => ({ entries: agents.map((entry) => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } }) } } as unknown as PaseoApi;
  const check = new ResponsibilityCheck({
    store,
    reviews: { ticketReviews: async () => reviews.inbox, latestFor: async () => reviews.entry },
    journal: journalOf(journal),
    parked: {
      get: async (issueId) => parked.get(issueId) ?? null,
      putIfAbsent: async (plan) => { puts.push(plan); if (parked.has(plan.issueId)) return false; parked.set(plan.issueId, plan); return true; },
    },
    deletions: { get: async () => deletions.issue, forAgent: async () => deletions.agent },
    exclusion,
    workspaceUrl: async () => "https://linear.app/tuchel",
    now: () => clock.now,
    readText: async (path) => { const text = files.get(path); if (text === undefined) throw new Error("ENOENT"); return text; },
  });
  return { check, store, journal, parked, puts, deletions, reviews, agents, exclusion, clock, files, paseo, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function ticket(extra: Partial<ResponsibilityTicket> = {}): ResponsibilityTicket {
  return { issue: { id: ISSUE, identifier: "TUC-9", status: "Planning", statusType: "started" }, ownerHold: false, question: null, liveRoots: [], queued: false, reviewThread: null, stewardAt: null, ...extra };
}

const clear = async () => null;
async function run(h: Harness, extra: Partial<ResponsibilityTicket> = {}, options: { enabled?: boolean; fence?: () => Promise<string | null> } = {}): Promise<ResponsibilityFile> {
  await h.check.run({ tickets: [ticket(extra)], enabled: options.enabled ?? true, fence: options.fence ?? clear, paseo: h.paseo });
  return h.store.read();
}
const KEY = `${ISSUE}:${REVISION}`;

test("a lost review is parked again once: supersession, the attributed record, done, and nothing on the next run", async () => {
  const h = await harness();
  try {
    assert.equal(await h.check.holds({ id: ISSUE, identifier: "TUC-9" }), true, "held while repairable");
    const file = await run(h);
    assert.equal(h.puts.length, 1);
    const repair = file.repairs[KEY];
    assert.equal(repair.state, "done");
    assert.deepEqual(h.puts[0], {
      issueId: ISSUE, identifier: "TUC-9", agentId: "a1", plan: PLAN,
      line: "Parked again: the review was lost before your decision was carried out",
      reasons: ["review lost; parked again by the responsibility check"],
      model: "sol", parkedAt: repair.parkedAt, announced: false, responsibilityRepairId: repair.repairId,
    });
    const marker = h.journal.find((entry) => entry.kind === "superseded");
    assert.equal(marker?.kind === "superseded" && marker.repairId, repair.repairId, "the original review is superseded by this repair");
    assert.deepEqual([file.violations, file.candidates, file.holds], [[], [], {}]);
    // Before delivery the repair's parked plan is the one hand-off: no false mismatch.
    h.clock.now = T0 + 12 * MIN;
    const next = await run(h);
    assert.equal(h.puts.length, 1, "no second write");
    assert.deepEqual([next.violations, next.candidates], [[], []]);
    assert.equal(await h.check.holds({ id: ISSUE, identifier: "TUC-9" }), false, "a done repair holds nothing");
    // Delivered: Plan review with the parked plan is fine as any review.
    h.clock.now = T0 + 24 * MIN;
    assert.deepEqual((await run(h, { issue: { ...ticket().issue, status: "Plan review" } })).candidates, []);
    // Undelivered after the hour: reported like any other mismatch.
    h.clock.now = T0 + 70 * MIN;
    assert.equal((await run(h)).candidates[0]?.kind, "planning-no-agent");
  } finally { await h.cleanup(); }
});

test("a Plan review ticket without a review is repaired the same way", async () => {
  const h = await harness();
  try {
    const file = await run(h, { issue: { ...ticket().issue, status: "Plan review" } });
    assert.equal(file.repairs[KEY].state, "done");
    assert.equal(file.repairs[KEY].kind, "review-missing");
    assert.equal(file.repairs[KEY].previousStatus, "Plan review");
  } finally { await h.cleanup(); }
});

test("temporary guard failures keep the hold, write nothing, and do not report", async (t) => {
  const cases: [string, (h: Harness) => void][] = [
    ["an applying journal entry", (h) => h.journal.push({ kind: "attempt", id: "x", reviewId: "other", issueId: null, state: "pending", agentId: "zz" } as DecisionAttempt)],
    ["an open unbound report", (h) => h.journal.push({ kind: "unbound", id: "u", agentId: "zz", at: iso(T0), approved: true, planContent: "", event: "e", state: "open" } satisfies UnboundReport)],
    ["an agent created 3 min ago, archived", (h) => h.agents.push(agent({ id: "a2", createdAt: iso(T0 - 3 * MIN) }))],
    ["an unreachable peer", (h) => { h.reviews.inbox = { rows: [], unreachable: ["laptop"] }; }],
    ["an open review on a peer", (h) => { h.reviews.inbox = { rows: [{ host: "laptop", agentId: "a9", identifier: "TUC-9", state: "open" }], unreachable: [] }; }],
    ["a review closed 5 min ago", (h) => { h.reviews.entry = { ...h.reviews.entry!, closedAt: iso(T0 - 5 * MIN) }; }],
    ["the steward's fence", () => undefined],
  ];
  for (const [name, arrange] of cases) {
    await t.test(name, async () => {
      const h = await harness();
      try {
        arrange(h);
        const file = await run(h, {}, name === "the steward's fence" ? { fence: async () => "the ticket's status changed" } : {});
        assert.equal(h.puts.length, 0);
        assert.equal(h.journal.some((entry) => entry.kind === "superseded"), false, "no supersession");
        assert.notEqual(file.repairs[KEY]?.state, "done");
        assert.ok(file.holds[KEY], "the hold stays");
        assert.equal(await h.check.holds({ id: ISSUE, identifier: "TUC-9" }), true);
        assert.deepEqual([file.violations, file.candidates], [[], []], "a pending repair is not reported");
      } finally { await h.cleanup(); }
    });
  }
});

test("permanent guard failures end the hold and leave the ticket to the report", async (t) => {
  const cases: [string, (h: Harness) => void, string | null][] = [
    ["an applied attempt", (h) => h.journal.push({ kind: "attempt", id: "x", reviewId: REVIEW.id, issueId: ISSUE, state: "applied", agentId: "a1" } as DecisionAttempt), null],
    ["an owner drop", (h) => h.journal.push({ kind: "attempt", id: "x", reviewId: REVIEW.id, issueId: ISSUE, state: "void", voidReason: "Dropped by the owner.", agentId: "a1" } as DecisionAttempt), null],
    ["a dropped unbound report of the agent", (h) => h.journal.push({ kind: "unbound", id: "u", agentId: "a1", at: iso(T0 - 60 * MIN), approved: true, planContent: "", event: "e", state: "dropped" } satisfies UnboundReport), null],
    ["a deletion pause", (h) => { h.deletions.issue = { issueId: ISSUE, identifier: "TUC-9", agentId: "a1", phase: "pending" }; }, null],
    ["a deleted review agent", (h) => { h.deletions.agent = { issueId: ISSUE, identifier: "TUC-9", agentId: "a1", phase: "deleted" }; }, null],
    ["a hash mismatch", (h) => h.files.set("/work/PLAN.md", `${PLAN}edited\n`), "the plan file changed since the review"],
    ["no plan file in the transcript", (h) => h.files.set("/sessions/a1.jsonl", "{}"), "the transcript names no plan file"],
    ["an unproven opening", (h) => h.journal.splice(0, 1, { ...REVIEW, legacy: true }), "the review's history is not complete in the journal"],
    ["an opening at the retention boundary", (h) => { h.clock.now = Date.parse(OPENED) + 60 * 24 * 60 * MIN; h.reviews.entry = { ...h.reviews.entry!, closedAt: iso(h.clock.now - 30 * MIN) }; }, "the review's history is not complete in the journal"],
  ];
  for (const [name, arrange, why] of cases) {
    await t.test(name, async () => {
      const h = await harness();
      try {
        arrange(h);
        const file = await run(h);
        assert.equal(h.puts.length, 0);
        assert.equal(file.repairs[KEY]?.state ?? null, why ? "report-only" : null);
        if (why) assert.equal(file.repairs[KEY].why, why);
        assert.equal(file.holds[KEY], undefined, "no hold");
        assert.equal(await h.check.holds({ id: ISSUE, identifier: "TUC-9" }), false);
        assert.equal(file.candidates[0]?.kind, "planning-no-agent", "reported (first sighting)");
      } finally { await h.cleanup(); }
    });
  }
});

test("a settled repair is never tried again, however old; a second revision is its own case", async () => {
  const h = await harness();
  try {
    await run(h);
    h.parked.clear(); // consumed by delivery and a decision long since
    h.clock.now = T0 + 40 * 24 * 60 * MIN;
    h.journal.splice(0, 1, { ...REVIEW, openedAt: iso(h.clock.now - 120 * MIN) });
    h.reviews.entry = { ...h.reviews.entry!, openedAt: iso(h.clock.now - 120 * MIN), closedAt: iso(h.clock.now - 30 * MIN) };
    await run(h);
    assert.equal(h.puts.length, 1, "already repaired 40 days ago: no write");
    const revised = `${PLAN}Second revision.\n`;
    const revision = createHash("sha256").update(revised).digest("hex");
    h.files.set("/work/PLAN.md", revised);
    h.journal.push({ ...REVIEW, id: "rev2", openedAt: iso(h.clock.now - 90 * MIN), planHash: revision });
    h.reviews.entry = { ...h.reviews.entry!, reviewId: "rev2", openedAt: iso(h.clock.now - 90 * MIN), revision };
    const file = await run(h);
    assert.equal(h.puts.length, 2);
    assert.equal(file.repairs[`${ISSUE}:${revision}`].state, "done");
  } finally { await h.cleanup(); }
});

test("disabled: no repair and no write; the mismatch is reported over two runs", async () => {
  const h = await harness();
  try {
    const first = await run(h, {}, { enabled: false });
    assert.deepEqual([h.puts.length, Object.keys(first.repairs).length, first.candidates.length, first.violations.length], [0, 0, 1, 0]);
    h.clock.now = T0 + 10 * MIN;
    const second = await run(h, {}, { enabled: false });
    assert.deepEqual([second.candidates.length, second.violations.length, second.violations[0].seen, second.violations[0].since], [0, 1, 2, iso(T0)]);
    assert.equal(second.violations[0].url, "https://linear.app/tuchel/issue/TUC-9");
  } finally { await h.cleanup(); }
});

test("a ticket the steward acted on in the last ten minutes is not reported", async () => {
  const h = await harness();
  try {
    const file = await run(h, { stewardAt: T0 - 4 * MIN }, { enabled: false });
    assert.deepEqual([file.candidates, file.violations], [[], []]);
  } finally { await h.cleanup(); }
});

test("an effect under way on the ticket keeps the repair from its reservation", async () => {
  const h = await harness();
  try {
    const token = h.exclusion.enterEffect(ISSUE);
    const file = await run(h);
    assert.equal(h.puts.length, 0);
    assert.equal(file.repairs[KEY].state, "released");
    token.release();
    h.clock.now = T0 + 10 * MIN;
    assert.equal((await run(h)).repairs[KEY].state, "done", "judged afresh once the effect ended");
  } finally { await h.cleanup(); }
});

test("the hold lasts an hour from its first sighting, across runs and restarts", async () => {
  const h = await harness();
  try {
    h.reviews.entry = { ...h.reviews.entry!, closedAt: iso(T0 - 5 * MIN) };
    assert.equal(await h.check.holds({ id: ISSUE, identifier: "TUC-9" }), true);
    h.clock.now = T0 + 30 * MIN;
    h.agents.push(agent({ id: "a2", createdAt: iso(h.clock.now - 2 * MIN) }));
    await run(h);
    h.clock.now = T0 + 61 * MIN;
    assert.equal(await h.check.holds({ id: ISSUE, identifier: "TUC-9" }), false, "expired");
    const file = await run(h);
    assert.deepEqual([file.repairs[KEY].state, file.repairs[KEY].why, h.puts.length], ["report-only", "not repaired within an hour", 0]);
  } finally { await h.cleanup(); }
});

test("recovery of an own claim: the exact record proves it, a supersession is redone once, a second failure ends it", async (t) => {
  const claim = (h: Harness, extra: Partial<ResponsibilityFile["repairs"][string]> = {}) => h.store.update((file) => {
    file.repairs[KEY] = { issueId: ISSUE, identifier: "TUC-9", url: "https://linear.app/tuchel/issue/TUC-9", kind: "planning-no-agent", detail: "Planning without an agent", revision: REVISION, reviewId: REVIEW.id, agentId: "a1", repairId: "r1", previousStatus: "Planning", parkedAt: iso(T0 - 20 * MIN), state: "claimed", tries: 1, at: iso(T0 - 20 * MIN), ...extra };
    file.holds[KEY] = { since: iso(T0 - 20 * MIN) };
  });
  const parkedOf = (extra: Partial<ParkedPlan> = {}): ParkedPlan => ({ issueId: ISSUE, identifier: "TUC-9", agentId: "a1", plan: PLAN, line: "", reasons: [], model: null, parkedAt: iso(T0 - 20 * MIN), announced: false, responsibilityRepairId: "r1", ...extra });
  await t.test("crash after the write: the exact generation is adopted", async () => {
    const h = await harness();
    try {
      await claim(h);
      h.parked.set(ISSUE, parkedOf());
      assert.deepEqual([(await run(h)).repairs[KEY].state, h.puts.length], ["done", 0]);
    } finally { await h.cleanup(); }
  });
  await t.test("the same plan in another generation is not adopted", async () => {
    const h = await harness();
    try {
      await claim(h);
      h.parked.set(ISSUE, parkedOf({ responsibilityRepairId: undefined }));
      const file = await run(h);
      assert.equal(h.puts.length, 0);
      assert.notEqual(file.repairs[KEY].state, "done");
    } finally { await h.cleanup(); }
  });
  await t.test("a consumed replacement proven by its review generation is not re-created", async () => {
    const h = await harness();
    try {
      await claim(h);
      h.journal.push({ ...REVIEW, id: "replacement", repairId: "r1", parked: true });
      assert.deepEqual([(await run(h)).repairs[KEY].state, h.puts.length], ["done", 0]);
    } finally { await h.cleanup(); }
  });
  await t.test("crash between supersession and write: redone once with the same ids", async () => {
    const h = await harness();
    try {
      await claim(h);
      h.journal.push({ kind: "superseded", id: `superseded-${REVIEW.id}`, reviewId: REVIEW.id, agentId: "a1", issueId: ISSUE, repairId: "r1", parkedAt: iso(T0 - 20 * MIN), at: iso(T0 - 20 * MIN) });
      const file = await run(h);
      assert.deepEqual([file.repairs[KEY].state, file.repairs[KEY].tries, h.puts[0]?.responsibilityRepairId, h.puts[0]?.parkedAt], ["done", 2, "r1", iso(T0 - 20 * MIN)]);
    } finally { await h.cleanup(); }
  });
  await t.test("an owner drop during downtime: no write", async () => {
    const h = await harness();
    try {
      await claim(h);
      h.journal.push({ kind: "attempt", id: "x", reviewId: REVIEW.id, issueId: ISSUE, state: "void", voidReason: "Dropped by the owner.", agentId: "a1" } as DecisionAttempt);
      assert.deepEqual([(await run(h)).repairs[KEY]?.state, h.puts.length], ["claimed", 0], "no longer lost: the claim stays unproven, nothing is written");
      assert.equal(await h.check.holds({ id: ISSUE, identifier: "TUC-9" }), false);
    } finally { await h.cleanup(); }
  });
  await t.test("a second try that fails again ends as failed", async () => {
    const h = await harness();
    try {
      await claim(h, { tries: 2 });
      assert.deepEqual([(await run(h)).repairs[KEY].state, h.puts.length], ["failed", 0]);
    } finally { await h.cleanup(); }
  });
});

test("the snapshot is the digest's shape, written owner-only", async () => {
  const h = await harness();
  try {
    await run(h, {}, { enabled: false });
    const text = await readFile(h.store.path, "utf8");
    const file = JSON.parse(text) as ResponsibilityFile;
    assert.deepEqual(Object.keys(file).sort(), ["candidates", "checkedAt", "holds", "host", "repairs", "unknown", "version", "violations"]);
    assert.deepEqual([file.version, file.host, file.checkedAt], [1, "server087", iso(T0)]);
    await mkdir(join(h.store.path, ".."), { recursive: true });
    await writeFile(h.store.path, "{");
    await assert.rejects(h.store.read(), /not valid JSON/);
  } finally { await h.cleanup(); }
});
