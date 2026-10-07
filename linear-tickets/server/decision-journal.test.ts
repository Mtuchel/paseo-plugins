import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import {
  DecisionJournal, DecisionPendingError, FencedError, StaleResolutionError, retryDelay, reviewEntryId,
  type AttemptInput, type DecisionConflict, type ReportInput, type ReviewGeneration, type RouteSnapshot, type UnboundReport,
} from "./decision-journal";
import { planHash } from "./review-outcome";

// The decision journal on its own (decision-journal.ts): the publish protocol, the lease and its
// drain, the per-review lock, attempt states and backoff, generation identity, report binding, the
// owner's resolutions and pruning. The bridge's use of the journal (intake, worker, recovery) is
// tested in plannotator.test.ts; every call here is a direct one on a temp directory.

const URL = "http://localhost:5000/";
const OPENED = "2026-01-01T10:00:00Z";
const AT = "2026-01-01T10:05:00Z";
const PLAN = "# TUC-25 — Plan\n\n1. Add the column.\n";
const SNAPSHOT: RouteSnapshot = { route: "live", issueId: "issue-1", identifier: "TUC-25", sessionId: null };

// A journal on its own temp directory, held for the duration of one test. `prepare` writes into
// the directory before the journal opens it, for records that are already on disk.
async function withJournal(run: (journal: DecisionJournal, directory: string) => Promise<void>, prepare?: (directory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "paseo-decision-journal-"));
  const directory = join(root, "decisions");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (prepare) await prepare(directory);
    const journal = new DecisionJournal(directory);
    try {
      assert.equal(await journal.acquire(), true);
      await run(journal, directory);
    } finally {
      await journal.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A review generation in the journal; `extra` names its plan and its `opened` event file.
function openReview(journal: DecisionJournal, agentId = "agent-1", openedAt = OPENED, extra: { localUrl?: string; planHash?: string; parked?: boolean; event?: string } = {}): Promise<ReviewGeneration> {
  return journal.ensureReview({
    agentId, localUrl: extra.localUrl ?? URL, openedAt,
    ...(extra.planHash ? { planHash: extra.planHash } : {}),
    ...(extra.parked !== undefined ? { parked: extra.parked } : {}),
    ...(extra.event ? { event: extra.event } : {}),
  });
}

function input(review: ReviewGeneration, overrides: Partial<AttemptInput> = {}): AttemptInput {
  return { review, agentId: "agent-1", planContent: PLAN, approved: true, source: "inbox", state: "pending", snapshot: SNAPSHOT, ...overrides };
}

function reportInput(review: ReviewGeneration, overrides: Partial<ReportInput> = {}): ReportInput {
  return { event: "report-1.json", agentId: "agent-1", approved: true, planContent: PLAN, at: AT, review, source: "plannotator-page", exact: false, snapshot: async () => SNAPSHOT, ...overrides };
}

// The attempts the review counts as decided (the ones that hold it).
function accepted(journal: DecisionJournal, reviewId: string) {
  return journal.attempts(reviewId).filter((entry) => entry.state === "pending" || entry.state === "applied");
}

function conflictOf(journal: DecisionJournal, reviewId: string): DecisionConflict {
  const conflict = journal.all().find((entry): entry is DecisionConflict => entry.kind === "conflict" && entry.reviewId === reviewId);
  assert.ok(conflict, `no conflict on ${reviewId}`);
  return conflict;
}

function unboundOf(journal: DecisionJournal, state: UnboundReport["state"] = "open"): UnboundReport {
  const unbound = journal.all().find((entry): entry is UnboundReport => entry.kind === "unbound" && entry.state === state);
  assert.ok(unbound, `no ${state} unbound report`);
  return unbound;
}

test("readers skip dot-files, so a record being written is never read half-written", async () => {
  await withJournal(async (journal, directory) => {
    assert.deepEqual(journal.all(), [], "a dot-file is not an entry");
    assert.deepEqual(journal.applying(), [], "and not an unreadable record either");
    const review = await openReview(journal);
    const attempt = await journal.begin(input(review));
    assert.equal(journal.all().length, 2);
    const names = (await readdir(directory)).sort();
    assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), [".write.tmp"], "the publish cleaned up its own temporary file");
    const record = names.find((name) => name.endsWith(`${attempt.id}.json`));
    assert.ok(record, "the decision has its own record");
    const onDisk = JSON.parse(await readFile(join(directory, record!), "utf8")) as { kind: string; state: string };
    assert.equal(onDisk.kind, "attempt");
    assert.equal(onDisk.state, "pending");
    assert.ok(names.includes(".half-written.json"), "the dot-file stayed where it was, unread");
  }, async (directory) => {
    await writeFile(join(directory, ".half-written.json"), JSON.stringify({ kind: "attempt", id: "not-a-decision", state: "pending" }));
    await writeFile(join(directory, ".write.tmp"), "{ half");
  });
});

test("an update rewrites its record in place under the same name", async () => {
  await withJournal(async (journal, directory) => {
    const review = await openReview(journal);
    const attempt = await journal.begin(input(review, { state: "deciding" }));
    const before = (await readdir(directory)).sort();
    const settled = await journal.settle(attempt.id, "accepted");
    assert.equal(settled.state, "pending");
    const after = (await readdir(directory)).sort();
    assert.deepEqual(after, before, "the update keeps the record's name");
    const record = after.find((name) => name.endsWith(`${attempt.id}.json`))!;
    const onDisk = JSON.parse(await readFile(join(directory, record), "utf8")) as { state: string };
    assert.equal(onDisk.state, "pending", "the record under the final name is whole");
    assert.ok(!after.some((name) => name.endsWith(".tmp")), "no temporary file is left behind");
  });
});

test("a create that finds the name taken keeps the existing record", async () => {
  const id = reviewEntryId("agent-1", URL, OPENED);
  await withJournal(async (journal, directory) => {
    const existing = { kind: "review", id, agentId: "agent-1", localUrl: URL, openedAt: OPENED, planHash: "beef", parked: false, at: "2026-01-01T09:00:00.000Z" };
    await writeFile(join(directory, `${id}.json`), JSON.stringify(existing, null, 2));
    const review = await openReview(journal);
    assert.equal(review.id, id);
    assert.equal(review.planHash, "beef", "the record that exists wins");
    assert.deepEqual(JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")), existing, "the existing record is not overwritten");
    assert.ok((await readdir(directory)).every((name) => !name.endsWith(".tmp")));
    await journal.begin(input(review));
    assert.equal(journal.attempts(id).length, 1, "the existing record is usable");
  });
});

test("a record that does not parse is kept and listed as unreadable", async (t) => {
  t.mock.method(console, "error", () => {});
  await withJournal(async (journal, directory) => {
    const review = await openReview(journal);
    assert.equal(journal.get(review.id)?.kind, "review", "a valid record next to it still loads");
    assert.deepEqual(journal.applying(), [{ kind: "unreadable", file: "20260101-broken.json" }]);
    await journal.prune();
    assert.deepEqual((await readdir(directory)).filter((name) => !name.startsWith(".")).sort(), [`${review.id}.json`, "20260101-broken.json"].sort());
    assert.deepEqual(journal.applying(), [{ kind: "unreadable", file: "20260101-broken.json" }], "it is never deleted");
  }, async (directory) => {
    await writeFile(join(directory, "20260101-broken.json"), "{ this is not json");
  });
});

test("one journal holds the directory until it stops; a second cannot write before that", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-decision-journal-"));
  const directory = join(root, "decisions");
  const first = new DecisionJournal(directory);
  const second = new DecisionJournal(directory);
  try {
    assert.equal(await first.acquire(), true);
    assert.equal(await second.acquire(), false, "the lease is held");
    assert.equal(second.active, false);
    await assert.rejects(second.run(async () => "never"), FencedError);
    const review = await openReview(first);
    await assert.rejects(second.begin(input(review)), FencedError);
    assert.equal(first.attempts().length, 0, "the fenced instance wrote nothing");
    await first.stop();
    assert.equal(await second.acquire(), true, "the lease moved after the stop");
    const recorded = await second.run(() => openReview(second, "agent-2", "2026-01-01T11:00:00Z"));
    assert.equal(recorded.agentId, "agent-2");
    await second.stop();
    assert.equal(first.active, false);
  } finally {
    await first.stop().catch(() => {});
    await second.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("stop refuses new work at once and waits for the admitted work to finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-decision-journal-"));
  const directory = join(root, "decisions");
  const journal = new DecisionJournal(directory);
  const gate = new EventEmitter();
  let started = 0;
  let finished = 0;
  let late = 0;
  try {
    assert.equal(await journal.acquire(), true);
    const admitted = journal.run(async () => { started++; await once(gate, "open"); finished++; return "done"; });
    let stopped = false;
    const stopping = journal.stop().then(() => { stopped = true; });
    await immediate();
    assert.equal(stopped, false, "the stop waits for the admitted work");
    await assert.rejects(journal.run(async () => { late++; return "late"; }), FencedError);
    gate.emit("open");
    assert.equal(await admitted, "done");
    await stopping;
    assert.equal(stopped, true);
    assert.equal(started, 1);
    assert.equal(finished, 1);
    assert.equal(late, 0, "the refused work never ran");
    assert.equal(journal.active, false);
    const next = new DecisionJournal(directory);
    assert.equal(await next.acquire(), true, "the lease is free for the next instance");
    await next.stop();
  } finally {
    await journal.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("one review takes one decision: a second decision is refused while the first stands", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const results = await Promise.allSettled([
      journal.begin(input(review, { approved: true })),
      journal.begin(input(review, { approved: false })),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.ok(results[1].status === "rejected" && results[1].reason instanceof DecisionPendingError);
    const attempts = journal.attempts(review.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].approved, true);
  });
});

test("a decision racing the plugin's own closing leaves exactly one winner", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const decisionFirst = await Promise.allSettled([
      journal.begin(input(review)),
      journal.addClosing(review, true, "The planner was retired."),
    ]);
    assert.equal(decisionFirst[0].status, "fulfilled");
    assert.equal(decisionFirst[1].status, "rejected");
    assert.ok(decisionFirst[1].status === "rejected" && decisionFirst[1].reason instanceof DecisionPendingError);

    const other = await openReview(journal, "agent-2", "2026-01-01T11:00:00Z");
    const closingFirst = await Promise.allSettled([
      journal.addClosing(other, false, "The planner was retired."),
      journal.begin(input(other, { agentId: "agent-2" })),
    ]);
    assert.equal(closingFirst[0].status, "fulfilled");
    assert.equal(closingFirst[1].status, "rejected");
    assert.ok(closingFirst[1].status === "rejected" && closingFirst[1].reason instanceof DecisionPendingError);
    assert.equal(journal.attempts(other.id).length, 0, "the closing keeps the review closed");
  });
});

test("a decision is deciding until Plannotator takes it; a refusal voids it and leaves the review decidable", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const attempt = await journal.begin(input(review, { state: "deciding" }));
    assert.equal(attempt.state, "deciding");
    const settled = await journal.settle(attempt.id, "accepted");
    assert.equal(settled.state, "pending");
    assert.ok(settled.acceptedAt);

    const refusedReview = await openReview(journal, "agent-2", "2026-01-01T11:00:00Z");
    const refused = await journal.begin(input(refusedReview, { agentId: "agent-2", state: "deciding" }));
    const voided = await journal.settle(refused.id, "refused", "The review was closed.");
    assert.equal(voided.state, "void");
    assert.equal(voided.voidReason, "The review was closed.");
    const again = await journal.begin(input(refusedReview, { agentId: "agent-2", approved: false }));
    assert.equal(again.state, "pending", "a refused decision does not consume the review");
    assert.equal(accepted(journal, refusedReview.id).length, 1);
  });
});

test("a lost answer turns the attempt uncertain; evidence settles it either way", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const lost = await journal.begin(input(review, { state: "deciding" }));
    const uncertain = await journal.settle(lost.id, "unknown", "The request timed out.");
    assert.equal(uncertain.state, "uncertain");
    assert.equal(uncertain.lastError, "The request timed out.");
    assert.equal(journal.applying().filter((row) => row.kind === "attempt").length, 1);

    const confirmed = await journal.evidence(lost.id, true, "saved-outcome-1");
    assert.equal(confirmed?.state, "pending");
    assert.deepEqual(confirmed?.reports, ["saved-outcome-1"]);

    const otherReview = await openReview(journal, "agent-2", "2026-01-01T11:00:00Z");
    const lost2 = await journal.begin(input(otherReview, { agentId: "agent-2", state: "deciding" }));
    await journal.settle(lost2.id, "unknown");
    const contradicted = await journal.evidence(lost2.id, false, "saved-outcome-2");
    assert.equal(contradicted, null);
    const voided = journal.attempt(lost2.id)!;
    assert.equal(voided.state, "void");
    assert.equal(voided.voidReason, "Plannotator accepted the other decision.");
  });
});

test("failed tries back off 3 s for the first 20 attempts, then a minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(AT) });
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    let attempt = await journal.begin(input(review));
    for (let tries = 1; tries <= 20; tries++) {
      attempt = await journal.failed(attempt, new Error("Linear is down."));
      assert.equal(attempt.attempts, tries);
      assert.equal(attempt.nextAttemptAt, new Date(Date.parse(AT) + 3_000).toISOString());
    }
    attempt = await journal.failed(attempt, new Error("Linear is still down."));
    assert.equal(attempt.attempts, 21);
    assert.equal(attempt.nextAttemptAt, new Date(Date.parse(AT) + 60_000).toISOString());
    assert.equal(attempt.lastError, "Linear is still down.");
    assert.equal(retryDelay(20), 3_000);
    assert.equal(retryDelay(21), 60_000);
  });
});

test("a later wait does not count as a failed try", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(AT) });
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const attempt = await journal.begin(input(review));
    const waited = await journal.later(attempt, Date.parse("2026-01-01T13:00:00Z"), "The ticket's deletion is in progress.");
    assert.equal(waited.state, "pending");
    assert.equal(waited.attempts, 0);
    assert.equal(waited.nextAttemptAt, new Date("2026-01-01T13:00:00Z").toISOString());
    assert.equal(waited.lastError, "The ticket's deletion is in progress.");
  });
});

test("applying clears the failure bookkeeping", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(AT) });
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    let attempt = await journal.begin(input(review));
    attempt = await journal.failed(attempt, new Error("The Linear API request failed."));
    assert.equal(attempt.lastError, "The Linear API request failed.");
    assert.ok(attempt.nextAttemptAt);
    attempt = await journal.applied(attempt);
    assert.equal(attempt.state, "applied");
    assert.equal(attempt.appliedAt, new Date(Date.parse(AT)).toISOString());
    assert.equal(attempt.lastError, undefined);
    assert.equal(attempt.nextAttemptAt, undefined);
  });
});

test("a review generation's entry id comes from the agent, the address and the open time", () => {
  assert.equal(reviewEntryId("agent-1", URL, OPENED), reviewEntryId("agent-1", URL, OPENED));
  assert.notEqual(reviewEntryId("agent-1", URL, OPENED), reviewEntryId("agent-1", URL, "2026-01-01T10:00:01Z"));
  assert.notEqual(reviewEntryId("agent-1", URL, OPENED), reviewEntryId("agent-1", "http://localhost:5001/", OPENED));
  assert.notEqual(reviewEntryId("agent-1", URL, OPENED), reviewEntryId("agent-2", URL, OPENED));
});

test("a replayed opened event finds its generation; two generations on one address stay apart", async () => {
  await withJournal(async (journal, directory) => {
    const first = await openReview(journal, "agent-1", OPENED, { planHash: planHash("# One\n"), event: "100-1.json" });
    const replay = await openReview(journal, "agent-1", OPENED, { planHash: planHash("# One\n"), event: "100-1.json" });
    assert.equal(replay.id, first.id);
    assert.equal(replay.planHash, planHash("# One\n"));
    assert.equal(journal.all().filter((entry) => entry.kind === "review").length, 1);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".json")).length, 1, "no second record");

    const second = await openReview(journal, "agent-1", "2026-01-01T11:00:00Z", { planHash: planHash("# Two\n"), event: "200-2.json" });
    assert.notEqual(second.id, first.id);
    assert.equal(journal.review(first.id)?.id, first.id);
    assert.equal(journal.latestReview("agent-1", { localUrl: URL })?.id, second.id);
    assert.equal(journal.latestReview("agent-1", { localUrl: URL, before: "200-2.json" })?.id, first.id);

    const attempt = await journal.begin(input(first, { state: "deciding" }));
    await journal.settle(attempt.id, "accepted");
    assert.equal(journal.attempts(second.id).length, 0, "the decision stays on its generation");
    assert.equal(journal.attempts(first.id).length, 1);
  });
});

test("a report that matches an accepted decision confirms it without a second decision", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal, "agent-1", OPENED, { planHash: planHash(PLAN) });
    const attempt = await journal.begin(input(review));
    const outcome = await journal.report(reportInput(review, { event: "300-1.json", planContent: PLAN }));
    assert.equal(outcome, "confirmed");
    assert.equal(journal.attempts(review.id).length, 1);
    const current = journal.attempt(attempt.id)!;
    assert.equal(current.state, "pending");
    assert.deepEqual(current.reports, ["300-1.json"]);
  });
});

test("reports after the decision was carried out only record themselves", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const attempt = await journal.begin(input(review));
    await journal.report(reportInput(review, { event: "300-1.json" }));
    await journal.applied(journal.attempt(attempt.id)!);
    assert.equal(await journal.report(reportInput(review, { event: "300-2.json" })), "confirmed");
    assert.equal(await journal.report(reportInput(review, { event: "300-3.json" })), "confirmed");
    assert.deepEqual(journal.attempt(attempt.id)!.reports, ["300-1.json", "300-2.json", "300-3.json"]);
    assert.equal(journal.attempt(attempt.id)!.state, "applied");
    assert.equal(await journal.report(reportInput(review, { event: "300-1.json" })), "replay");
    assert.deepEqual(journal.attempt(attempt.id)!.reports, ["300-1.json", "300-2.json", "300-3.json"], "a replayed event is not recorded twice");
  });
});

test("a report for another plan text waits as unbound and records nothing", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal, "agent-1", OPENED, { planHash: planHash(PLAN) });
    const outcome = await journal.report(reportInput(review, { event: "310-1.json", planContent: "# A different plan\n" }));
    assert.equal(outcome, "unbound");
    assert.equal(journal.attempts(review.id).length, 0, "no decision runs");
    assert.deepEqual(journal.applying().map((row) => row.kind), ["unbound"]);
    assert.equal(unboundOf(journal).state, "open");
    assert.equal(journal.busy("agent-1"), true);

    const matching = await journal.report(reportInput(review, { event: "310-2.json", planContent: PLAN }));
    assert.equal(matching, "recorded");
    assert.equal(journal.attempts(review.id).length, 1);
  });
});

test("a report contradicting an accepted decision pauses it as a conflict", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const attempt = await journal.begin(input(review));
    const outcome = await journal.report(reportInput(review, { event: "320-1.json", approved: false, exact: true }));
    assert.equal(outcome, "conflict");
    const paused = journal.attempt(attempt.id)!;
    assert.equal(paused.state, "pending");
    assert.ok(paused.pausedBy, "the attempt waits for the owner's choice");
    const conflict = conflictOf(journal, review.id);
    assert.equal(conflict.attemptId, attempt.id);
    assert.equal(conflict.afterApply, false);
    assert.equal(conflict.reportOutcome, false);
    assert.equal(journal.due().pending.length, 0, "a paused decision is not tried");
    const rows = journal.applying();
    assert.equal(rows.length, 2, "the paused decision and the conflict wait for the owner");
    assert.ok(rows.some((row) => row.kind === "conflict"));
    assert.ok(rows.some((row) => row.kind === "attempt" && row.entry.id === attempt.id && row.entry.pausedBy === conflict.id));
  });
});

test("a report contradicting a carried-out decision keeps the attempt's history", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    let attempt = await journal.begin(input(review));
    attempt = await journal.step(attempt, "document", "https://linear.app/doc/1");
    attempt = await journal.applied(attempt);
    const outcome = await journal.report(reportInput(review, { event: "330-1.json", approved: false, exact: true }));
    assert.equal(outcome, "conflict");
    assert.equal(conflictOf(journal, review.id).afterApply, true);
    const kept = journal.attempt(attempt.id)!;
    assert.equal(kept.state, "applied");
    assert.equal(kept.steps.document, "https://linear.app/doc/1");
    assert.deepEqual(journal.applying().map((row) => row.kind), ["conflict"], "nothing runs again");
  });
});

test("a report contradicting an open decision voids it and becomes the review's decision", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const open = await journal.begin(input(review, { state: "deciding" }));
    const outcome = await journal.report(reportInput(review, { event: "340-1.json", approved: false, exact: true }));
    assert.equal(outcome, "recorded");
    assert.equal(journal.attempt(open.id)!.state, "void");
    assert.equal(journal.attempt(open.id)!.voidReason, "Plannotator accepted the other decision.");
    const attempts = journal.attempts(review.id);
    assert.equal(attempts.length, 2);
    const decision = attempts.find((entry) => entry.state === "pending")!;
    assert.equal(decision.approved, false);
    assert.equal(decision.planHash, planHash(PLAN));
    assert.deepEqual(decision.reports, ["340-1.json"]);
    assert.equal(accepted(journal, review.id).length, 1);
  });
});

test("the owner carries out or drops an uncertain decision", async () => {
  await withJournal(async (journal) => {
    const carried = await openReview(journal, "agent-1", OPENED);
    const lost = await journal.begin(input(carried, { state: "deciding" }));
    await journal.settle(lost.id, "unknown");
    await journal.awaitOwner(lost.id, true, "Plannotator is gone; the owner decides.");
    assert.equal(journal.attempt(lost.id)!.waitsForOwner, true);
    await journal.resolve(lost.id, "carry-out", async () => SNAPSHOT);
    const acceptedAttempt = journal.attempt(lost.id)!;
    assert.equal(acceptedAttempt.state, "pending");
    assert.ok(acceptedAttempt.acceptedAt);
    assert.ok(!acceptedAttempt.waitsForOwner, "carrying it out clears the owner's wait");

    const dropped = await openReview(journal, "agent-2", "2026-01-01T11:00:00Z");
    const other = await journal.begin(input(dropped, { agentId: "agent-2", state: "deciding" }));
    await journal.settle(other.id, "unknown");
    await journal.awaitOwner(other.id, true, "Plannotator is gone; the owner decides.");
    await journal.resolve(other.id, "drop", async () => SNAPSHOT);
    const voided = journal.attempt(other.id)!;
    assert.equal(voided.state, "void");
    assert.equal(voided.voidReason, "Dropped by the owner.");
    const again = await journal.begin(input(dropped, { agentId: "agent-2", approved: false }));
    assert.equal(again.state, "pending", "dropping frees the review for a new decision");
  });
});

test("an uncertain decision is resolved only once it waits for the owner", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const lost = await journal.begin(input(review, { state: "deciding" }));
    await journal.settle(lost.id, "unknown");
    await assert.rejects(journal.resolve(lost.id, "carry-out", async () => SNAPSHOT), StaleResolutionError, "it is still being sent to Plannotator again");
    await assert.rejects(journal.resolve(lost.id, "drop", async () => SNAPSHOT), StaleResolutionError);
    await journal.awaitOwner(lost.id, true, "The review is gone; the owner decides.");
    await journal.resolve(lost.id, "carry-out", async () => SNAPSHOT);
    assert.equal(journal.attempt(lost.id)!.state, "pending");

    const resent = await openReview(journal, "agent-2", "2026-01-01T11:00:00Z");
    const openAgain = await journal.begin(input(resent, { agentId: "agent-2", state: "deciding" }));
    await journal.settle(openAgain.id, "unknown");
    await journal.awaitOwner(openAgain.id, true, "The review is gone; the owner decides.");
    await journal.awaitOwner(openAgain.id, false, "The review answers again; sending it once more.");
    assert.ok(!journal.attempt(openAgain.id)!.waitsForOwner, "cleared before the resend");
    await assert.rejects(journal.resolve(openAgain.id, "drop", async () => SNAPSHOT), StaleResolutionError);
  });
});

test("the owner carries out or drops a report that did not bind to a review", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal, "agent-1", OPENED, { planHash: planHash(PLAN) });
    await journal.report(reportInput(review, { event: "350-1.json", planContent: "# Another plan\n" }));
    const droppedId = unboundOf(journal).id;
    await journal.resolve(droppedId, "drop", async () => SNAPSHOT);
    assert.equal(unboundOf(journal, "dropped").state, "dropped");
    assert.equal(journal.attempts(review.id).length, 0, "dropping runs nothing");

    await journal.report(reportInput(review, { event: "350-2.json", planContent: "# Another plan\n" }));
    const carriedId = unboundOf(journal).id;
    await journal.resolve(carriedId, "carry-out", async () => SNAPSHOT);
    const carried = unboundOf(journal, "carried");
    assert.equal(carried.state, "carried");
    const attempts = journal.attempts(review.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].state, "pending");
    assert.equal(attempts[0].approved, true);
    assert.equal(attempts[0].source, "plannotator-page");
    assert.equal(attempts[0].reviewId, review.id);
    assert.equal(carried.attemptId, attempts[0].id);
  });
});

test("keep settles a conflict on the accepted decision; other voids it and accepts the report", async () => {
  await withJournal(async (journal) => {
    const keptReview = await openReview(journal, "agent-1", OPENED);
    const kept = await journal.begin(input(keptReview));
    await journal.report(reportInput(keptReview, { event: "360-1.json", approved: false, exact: true }));
    await journal.resolve(conflictOf(journal, keptReview.id).id, "keep", async () => SNAPSHOT);
    assert.equal(journal.attempt(kept.id)!.pausedBy, undefined);
    assert.equal(journal.attempt(kept.id)!.state, "pending");
    assert.equal(conflictOf(journal, keptReview.id).resolution, "keep");
    assert.equal(accepted(journal, keptReview.id).length, 1);

    const otherReview = await openReview(journal, "agent-2", "2026-01-01T11:00:00Z");
    const other = await journal.begin(input(otherReview, { agentId: "agent-2" }));
    await journal.report(reportInput(otherReview, { event: "360-2.json", agentId: "agent-2", approved: false, exact: true }));
    await journal.resolve(conflictOf(journal, otherReview.id).id, "other", async () => SNAPSHOT);
    const voided = journal.attempt(other.id)!;
    assert.equal(voided.state, "void");
    assert.equal(voided.voidReason, "The owner chose the other decision.");
    const decision = accepted(journal, otherReview.id);
    assert.equal(decision.length, 1, "exactly one side ends up accepted");
    assert.equal(decision[0].approved, false);
    assert.equal(decision[0].transport, false);
    assert.equal(conflictOf(journal, otherReview.id).resolution, "other");
  });
});

test("an after-apply conflict can only be dismissed", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    const attempt = await journal.applied(await journal.begin(input(review)));
    await journal.report(reportInput(review, { event: "370-1.json", approved: false, exact: true }));
    const conflict = conflictOf(journal, review.id);
    assert.equal(conflict.afterApply, true);
    await assert.rejects(journal.resolve(conflict.id, "keep", async () => SNAPSHOT), StaleResolutionError);
    await journal.resolve(conflict.id, "dismiss", async () => SNAPSHOT);
    assert.equal(conflictOf(journal, review.id).resolution, "dismiss");
    assert.equal(journal.attempts(review.id).length, 1);
    assert.deepEqual(journal.applying(), [], "nothing waits for the owner any more");
    assert.equal(journal.attempt(attempt.id)!.state, "applied");
  });
});

test("resolving an entry whose state changed is refused as stale", async () => {
  await withJournal(async (journal) => {
    const review = await openReview(journal);
    await assert.rejects(journal.resolve("no-such-entry", "drop", async () => SNAPSHOT), StaleResolutionError);
    await assert.rejects(journal.resolve(review.id, "drop", async () => SNAPSHOT), StaleResolutionError, "a review is not the owner's to resolve");

    const attempt = await journal.applied(await journal.begin(input(review)));
    await assert.rejects(journal.resolve(attempt.id, "carry-out", async () => SNAPSHOT), StaleResolutionError);

    const conflictReview = await openReview(journal, "agent-2", "2026-01-01T11:00:00Z");
    await journal.begin(input(conflictReview, { agentId: "agent-2" }));
    await journal.report(reportInput(conflictReview, { event: "380-1.json", agentId: "agent-2", approved: false, exact: true }));
    const conflict = conflictOf(journal, conflictReview.id);
    await journal.resolve(conflict.id, "keep", async () => SNAPSHOT);
    await assert.rejects(journal.resolve(conflict.id, "keep", async () => SNAPSHOT), StaleResolutionError, "a settled conflict stays settled");
  });
});

test("prune drops settled records and keeps working ones with their reviews", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(AT) });
  await withJournal(async (journal, directory) => {
    // Settled long ago: the decision and its review go.
    const settled = await openReview(journal, "agent-old", OPENED);
    const settledAttempt = await journal.applied(await journal.begin(input(settled, { agentId: "agent-old" })));
    // Still being applied: kept with its review.
    const working = await openReview(journal, "agent-working", "2026-01-01T10:30:00Z");
    const workingAttempt = await journal.begin(input(working, { agentId: "agent-working" }));
    // Waiting for the owner: kept.
    const conflicting = await openReview(journal, "agent-conflict", "2026-01-01T10:40:00Z");
    await journal.begin(input(conflicting, { agentId: "agent-conflict" }));
    await journal.report(reportInput(conflicting, { event: "390-1.json", agentId: "agent-conflict", approved: false, exact: true }));

    t.mock.timers.tick(61 * 24 * 60 * 60 * 1000);
    await journal.prune();

    assert.equal(journal.get(settled.id), null, "the settled review is gone");
    assert.equal(journal.attempt(settledAttempt.id), null, "the settled decision is gone");
    assert.equal(journal.get(working.id)?.kind, "review", "an in-progress decision keeps its review");
    assert.equal(journal.attempt(workingAttempt.id)?.state, "pending");
    assert.equal(journal.get(conflicting.id)?.kind, "review", "a conflict waiting for the owner keeps its review");
    assert.equal(conflictOf(journal, conflicting.id).resolution, undefined);
    const files = await readdir(directory);
    assert.ok(!files.some((name) => name.includes(settled.id)), "the settled review's record is gone from disk");
    assert.ok(!files.some((name) => name.includes(settledAttempt.id)), "the settled decision's record is gone from disk");
    assert.ok(files.some((name) => name.includes(workingAttempt.id)), "the working decision keeps its record");
  });
});
