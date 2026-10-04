import assert from "node:assert/strict";
import test from "node:test";
import { parsePlanSections, planFollowUps, ruleMismatch, type PlanSections } from "../shared/plan-sections";

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
