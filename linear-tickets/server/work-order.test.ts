import assert from "node:assert/strict";
import test from "node:test";
import { autoApproval, parsePlanRisk } from "../shared/plan-risk";
import { blockProblems, orderProblems, orderLine, parseOrder, parseRelatedWork, relatedWorkProblems, stepOf, WORK_ORDER_KINDS, RELATED_WORK_KINDS } from "../shared/work-order";

const block = (tag: string, lines: string[]) => `## Section\n\nText.\n\n\`\`\`${tag}\n${lines.join("\n")}\n\`\`\`\n`;
const related = (...lines: string[]) => block("related-work", lines);
const order = (...lines: string[]) => block("project-order", lines);

test("AC-11: the related-work block reads each line as one change, synonyms included", () => {
  const plan = related(
    "TUC-9 blocks TUC-7: the parser lands first",
    "TUC-7 blocks TUC-10",
    "TUC-7 relates to TUC-20: same files",
    "TUC-7 related TUC-21: same data",
    "TUC-7 related to TUC-22: same feature",
    "TUC-7 duplicates TUC-30: nobody started it",
    "replan TUC-40: its plan is out of date",
  );
  assert.deepEqual(parseRelatedWork(plan), [
    { kind: "blocks", blocker: "TUC-9", blocked: "TUC-7" },
    { kind: "blocks", blocker: "TUC-7", blocked: "TUC-10" },
    { kind: "relates", ticket: "TUC-7", other: "TUC-20", reason: "same files" },
    { kind: "relates", ticket: "TUC-7", other: "TUC-21", reason: "same data" },
    { kind: "relates", ticket: "TUC-7", other: "TUC-22", reason: "same feature" },
    { kind: "duplicates", ticket: "TUC-7", other: "TUC-30", reason: "nobody started it" },
    { kind: "replan", ticket: "TUC-40", reason: "its plan is out of date" },
  ]);
  assert.equal(orderLine(stepOf("TUC-7 related to TUC-22: x")!), "TUC-7 relates to TUC-22: x");
});

test("AC-2: D2 refuses a line that names two other tickets, and hold/release in a ticket plan", () => {
  const problems = relatedWorkProblems(related(
    "TUC-1 blocks TUC-2: neither is this ticket",
    "hold TUC-3: not a ticket plan's job",
    "attended TUC-4",
    "TUC-7 relates to TUC-5: this one is fine",
  ), "TUC-7");
  assert.equal(problems.length, 3);
  assert.match(problems.join("\n"), /Every line names TUC-7/);
  assert.match(problems.join("\n"), /Not allowed in a ticket plan: "hold TUC-3: not a ticket plan's job"/);
  assert.match(problems.join("\n"), /Not allowed in a ticket plan: "attended TUC-4"/);
});

test("AC-2: a related-work section without the block is a problem; an old plan with neither is not", () => {
  assert.deepEqual(relatedWorkProblems("## Related work\n\nTUC-9 blocks TUC-7.\n", "TUC-7"), ['The plan has a "## Related work" section but no ```related-work block.']);
  assert.deepEqual(relatedWorkProblems("## Overlapping tickets\n\nTUC-9 overlaps.\n", "TUC-7"), []);
  assert.deepEqual(relatedWorkProblems("A plan with nothing.\n", "TUC-7"), []);
});

test("AC-2: an unreadable line is named in the send-back", () => {
  const problems = relatedWorkProblems(related("TUC-7 relates to TUC-8 and TUC-9"), "TUC-7");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Not one related-work line/);
});

test("AC-2: an empty related-work block is a valid plan with nothing related", () => {
  assert.deepEqual(relatedWorkProblems(related(), "TUC-7"), []);
  assert.deepEqual(parseRelatedWork(related()), []);
});

test("AC-11: a work order still reads its own block, and refuses replan", () => {
  assert.equal(orderProblems(order("TUC-1 blocks TUC-2", "TUC-3 duplicates TUC-4: same ask")).length, 0);
  const problems = orderProblems(order("replan TUC-9: a work order cannot ask for a replan"));
  assert.deepEqual(problems, ['A work order cannot ask for a replan: "replan TUC-9: a work order cannot ask for a replan"']);
  assert.deepEqual(parseOrder(order("hold TUC-3: owner asked")).map(orderLine), ["hold TUC-3: owner asked"]);
});

test("AC-12: a block that makes this ticket wait for an open ticket is a reason to need the owner", () => {
  const plan = `# Plan\n\n${related("TUC-9 blocks TUC-7: the parser lands first", "TUC-7 relates to TUC-20: same files")}\n\n## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: 1 — read-only\n- Reversibility: revert — nothing written\n- Feature flag: no\n- Migration: no\n- Auth: no\n- New rule: no — a one-off report column\n- Failure mode: a wrong column\n- Advisor rating: impact 1, reversibility revert\n- Recommendation: auto — routine\n`;
  const rated = parsePlanRisk(plan);
  assert.ok(!("problem" in rated));
  const policy = { enabled: true, maxImpact: 5, maxImpactWithFlag: 5 };
  const verdict = { verdict: "agreed", untrusted: false, attended: false };
  assert.deepEqual(autoApproval(rated.risk, policy, verdict).approve, true);
  const waiting = autoApproval(rated.risk, policy, { ...verdict, waitsFor: ["TUC-9"] });
  assert.equal(waiting.approve, false);
  assert.deepEqual(waiting.reasons, ["it waits for TUC-9, still open"]);
  // A line that makes another ticket wait for this one does not stop automatic approval.
  const outgoing = autoApproval(rated.risk, policy, { verdict: "agreed", untrusted: false, attended: false, waitsFor: [] });
  assert.equal(outgoing.approve, true);
});

test("AC-11: blockProblems keeps the work order's rules unchanged", () => {
  assert.deepEqual(blockProblems(order(), "project-order", WORK_ORDER_KINDS), []);
  assert.deepEqual(blockProblems(related("TUC-7 duplicates TUC-8"), "related-work", RELATED_WORK_KINDS, "TUC-7"), []);
});
