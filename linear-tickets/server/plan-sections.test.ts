import assert from "node:assert/strict";
import test from "node:test";
import { parsePlanSections, planExistingRefs, planFollowUps, ruleMismatch, type PlanSections } from "../shared/plan-sections";

const VERIFICATION = "## Verification\n\n- AC-1: the order page shows the date\n- AC-2: the CSV export carries it\n- AC-3: the check fails on a page without the date\n";
const REACH = "## Reach\n\n- Changes: the order's delivery date\n- Order page (sales, warehouse): include — AC-1\n- CSV export: include — AC-2\n- Help page: follow-up — Document the delivery date\n- Seed data: n/a — no new data\n";
const NO_RULE = "## Principles and rules\n\n- Applies: none apply — no principle covers dates\n- Exceptions: none\n- New rule: none — a one-off column\n";
const RULE = "## Principles and rules\n\n- Applies: P-4\n- Exceptions: none\n- New rule: every order page shows the delivery date — AC-3\n- Replaces: nothing\n- Lives in: CONTRIBUTING.md\n- Enforced by: a check with a known-exceptions baseline\n- Existing violations:\n  - Returns page: follow-up — Show the delivery date on returns\n  - Offers page: fixed now\n";
const plan = (...sections: string[]) => ["# Plan\n\nShow the delivery date.\n", ...sections, "## Risk and impact\n\n- Impact: 2\n"].join("\n");

const parsed = (text: string, impact: 0 | 1 | 2 | 3 | 4 | null = 2): PlanSections => {
  const result = parsePlanSections(text, impact);
  assert.ok("sections" in result, "problem" in result ? result.problem : "");
  return result.sections;
};
const problem = (text: string, impact: 0 | 1 | 2 | 3 | 4 | null = 2): string => {
  const result = parsePlanSections(text, impact);
  assert.ok("problem" in result, "expected a problem");
  return result.problem;
};

test("a plan without either section is refused, naming the missing one", () => {
  assert.match(problem(plan(VERIFICATION, NO_RULE)), /^The plan has no "## Reach" section\.$/);
  assert.match(problem(plan(VERIFICATION, REACH)), /^The plan has no "## Principles and rules" section\.$/);
  assert.match(problem(plan(VERIFICATION)), /^The plan has no "## Reach" and no "## Principles and rules" section\.$/);
  assert.match(problem(plan("## Reach\n", NO_RULE), 0), /"## Reach" section is empty/);
});

test("at impact 0–1 one line per section passes; from impact 2, or with no known impact, the full format is required", () => {
  const brief = plan("## Reach\n\nOnly the menu bar app, because nothing else shows it.\n", "## Principles and rules\n\nNone apply; no new rule.\n");
  assert.deepEqual(parsed(brief, 1), { followUps: [], newRule: null });
  assert.deepEqual(parsed(plan("## Reach: only the menu bar app\n", "## Principles and rules — none apply\n"), 0), { followUps: [], newRule: null }, "the heading line itself may carry the answer");
  for (const impact of [2, null] as const) {
    const named = problem(brief, impact);
    assert.match(named, /"## Reach" has no "- Changes:/);
    assert.match(named, /"## Reach" has no place with a decision/);
    assert.match(named, /has no "- Applies:" line/);
    assert.match(named, /has no "- New rule:" line/);
  }
});

test("a full plan yields its follow-ups from both sections and whether it sets a rule", () => {
  assert.deepEqual(parsed(plan(VERIFICATION, REACH, NO_RULE)), { followUps: ["Document the delivery date"], newRule: false });
  assert.deepEqual(parsed(plan(VERIFICATION, REACH, RULE), 4), { followUps: ["Document the delivery date", "Show the delivery date on returns"], newRule: true });
});

test("every include and the new rule name their own acceptance criterion, defined elsewhere in the plan", () => {
  assert.match(problem(plan(VERIFICATION, REACH.replace("include — AC-2", "include"), NO_RULE)), /"CSV export" names no acceptance criterion of its own/);
  assert.match(problem(plan(VERIFICATION, REACH.replace("include — AC-2", "include — AC-7"), NO_RULE)), /"CSV export" names AC-7, which the plan does not define/);
  assert.match(problem(plan(VERIFICATION, REACH.replace("include — AC-2", "include — AC-1"), NO_RULE)), /AC-1 is named by both "Order page \(sales, warehouse\)" and "CSV export"/);
  assert.match(problem(plan(VERIFICATION, REACH, RULE.replace(" — AC-3", ""))), /the new rule names no acceptance criterion of its own/);
  assert.match(problem(plan(VERIFICATION, REACH, RULE.replace("— AC-3", "— AC-2"))), /AC-2 is named by both "CSV export" and the new rule/);
  // A criterion only mentioned inside these sections is not defined.
  assert.match(problem(plan(REACH, NO_RULE)), /"Order page \(sales, warehouse\)" names AC-1, which the plan does not define/);
  // The reference check holds at low impact too.
  assert.match(problem(plan("## Reach\n\n- Menu bar: include\n", "## Principles and rules\n\nNone apply.\n"), 0), /"Menu bar" names no acceptance criterion/);
});

test("a follow-up needs a title, an n/a a reason, and a new rule its four lines", () => {
  const named = problem(plan(VERIFICATION, REACH.replace("follow-up — Document the delivery date", "follow-up").replace("n/a — no new data", "n/a"), RULE.replace("- Lives in: CONTRIBUTING.md\n", "")));
  assert.match(named, /"Help page" is a follow-up without a title/);
  assert.match(named, /"Seed data" is n\/a without a reason/);
  assert.match(named, /The new rule has no "- Lives in:" line/);
});

test("the risk section's New rule and the principles section must agree", () => {
  assert.match(ruleMismatch(true, { followUps: [], newRule: false }) ?? "", /says "New rule: yes", but "## Principles and rules" states no rule/);
  assert.match(ruleMismatch(true, { followUps: [], newRule: null }) ?? "", /states no rule/);
  assert.match(ruleMismatch(false, { followUps: [], newRule: true }) ?? "", /sets a new rule, but "## Risk and impact" says "New rule: no"/);
  assert.equal(ruleMismatch(false, { followUps: [], newRule: null }), null);
  assert.equal(ruleMismatch(true, { followUps: [], newRule: true }), null);
});

test("follow-ups are read leniently from both sections only: bold labels, numbered items, duplicates and placeholders", () => {
  const text = [
    "# Plan\n\n- Old page: follow-up — Not in a section\n",
    "## Reach\n\n- **Help page**: **follow-up** — `Document the date`\n1. Mobile: follow-up: Show it on mobile\n- Exports: follow-up — <title>\n",
    "## Principles and rules\n\n- Existing violations: follow-up — document the date\n  - follow-up — Fix the returns page\n",
    "## Risk and impact\n\n- Impact: 0\n",
  ].join("\n");
  assert.deepEqual(planFollowUps(text), ["Document the date", "Show it on mobile", "Fix the returns page"]);
  assert.deepEqual(planFollowUps("# Plan\n\n- Help page: n/a — no follow-up needed\n"), []);
});

test("a plan carries at most three follow-ups across both sections", () => {
  const three = "## Reach\n\n- Changes: the order's delivery date\n- Order page: include — AC-1\n- CSV export: include — AC-2\n- Help page: follow-up — Document the delivery date\n- Mobile app: follow-up — Warn on mobile too\n- Returns page: follow-up — Show the date on returns\n";
  assert.equal(parsed(plan(VERIFICATION, three, NO_RULE)).followUps.length, 3, "three follow-ups pass");
  const four = three.replace("- Returns page: follow-up — Show the date on returns\n", "- Returns page: follow-up — Show the date on returns\n- Seed data: follow-up — Seed the dates\n");
  assert.match(problem(plan(VERIFICATION, four, NO_RULE)), /The plan has 4 follow-ups; a plan files at most 3\. Keep the 3 that matter most and turn the rest into "include" \(fixed now\) or "n\/a — minor: <what>"\./);
  // The cap holds at impact 0–1 too: a short section never files a fourth follow-up.
  assert.match(problem(plan(`## Reach\n\n${four.replace("## Reach\n\n", "")}`, "## Principles and rules\n\nNone apply; no new rule.\n"), 1), /The plan has 4 follow-ups/);
  // The principles section counts too: its "Existing violations" follow-ups file the same way.
  assert.match(problem(plan(VERIFICATION, three, RULE)), /The plan has 4 follow-ups/);
});

test("a follow-up that only points at an open ticket is refused; existing names the ticket it defers to", () => {
  const ref = (line: string) => plan(VERIFICATION, REACH.replace("- Seed data: n/a — no new data", line), NO_RULE);
  assert.match(problem(ref("- Seed data: follow-up — TUC-935")), /"Seed data" is a follow-up for TUC-935, which already covers that place; write "- Seed data: existing — TUC-935"/);
  assert.match(problem(ref("- Seed data: follow-up — Backfill the seed dates (TUC-935, already Todo)")), /"Seed data" is a follow-up for TUC-935/);
  assert.match(problem(ref("- Seed data: existing — the backfill is planned elsewhere")), /"Seed data" is existing without a ticket identifier; write "- Seed data: existing — <TICKET-ID>"/);
  const ok = ref("- Seed data: existing — TUC-12 (the backfill covers it)");
  assert.deepEqual(parsed(ok), { followUps: ["Document the delivery date"], newRule: false }, "an existing place files nothing");
  assert.deepEqual(planExistingRefs(ok), ["TUC-12"]);
  // A covered word and a ticket apart from each other state a finding of their own.
  assert.deepEqual(parsed(ref("- Seed data: follow-up — Duplicate payments after retry (related to TUC-971)")).followUps, ["Document the delivery date", "Duplicate payments after retry (related to TUC-971)"]);
});

test("the reader files only titles that state a finding: bare identifiers and 'already filed' references stay with their tickets", () => {
  const text = [
    "# Plan\n\n## Reach\n\n- Changes: the delivery date\n",
    "- Help page: follow-up — Document the delivery date\n",
    "- Mobile app: follow-up — TUC-935\n",
    "- CSV export: follow-up — Carry the date into the export (TUC-827, already Todo)\n",
    "- Delivery notes: follow-up — Print the date on notes (existing TUC-583; same comment)\n",
    "- Returns page: follow-up — Backfill the seed dates — TUC-563, exists\n",
    "- Claims: follow-up — Existing ticket TUC-583 covers the seed data\n",
    "- Invoices: follow-up — Already filed as TUC-563, the backfill\n",
    "- Reports: follow-up — Menu stops pulling texts (related to TUC-971)\n",
    "- Seed data: existing — TUC-12 (the backfill covers it)\n",
    "## Principles and rules\n\nNone apply; no new rule.\n",
  ].join("\n");
  assert.deepEqual(planFollowUps(text), ["Document the delivery date", "Menu stops pulling texts (related to TUC-971)"]);
  assert.deepEqual(planExistingRefs(text), ["TUC-12"]);
  assert.deepEqual(planExistingRefs("# Plan\n\n## Reach\n\n- Changes: x\n- Order page: include — AC-1\n"), []);
});

test("a covered word or a ticket outside its own clause states a finding and is filed", () => {
  const text = [
    "# Plan\n\n## Reach\n\n- Changes: the delivery date\n",
    "- Help page: follow-up — Document the delivery date\n",
    "- Records: follow-up — Existing records truncate ISO-8601 timestamps\n",
    "- Payments: follow-up — Duplicate payments after retry (related to TUC-971)\n",
    "- Imports: follow-up — Fix UTF-8 handling: SHA-256 sums differ\n",
    "## Principles and rules\n\nNone apply; no new rule.\n",
  ].join("\n");
  assert.deepEqual(planFollowUps(text), [
    "Document the delivery date",
    "Existing records truncate ISO-8601 timestamps",
    "Duplicate payments after retry (related to TUC-971)",
    "Fix UTF-8 handling: SHA-256 sums differ",
  ]);
});
