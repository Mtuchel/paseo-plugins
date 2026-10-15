import assert from "node:assert/strict";
import test from "node:test";
import { isTier, LEGACY_TIER_READINGS, MAX_IMPACT_BELOW_STRONG, MODEL_SECTION, modelProblem, parsePlanModel, planTier, readTier, strongStepNumbers, TIERS, type PlanModel } from "../shared/plan-model";
import type { PlanRisk } from "../shared/plan-risk";

// The rules of a ticket plan's `## Model` section (README, "Model tiers"): two tiers, the single
// steps that still need the strong model, and the acceptance tests a cheap plan has written first.
// server/plan-advisor.test.ts runs the same rules through the omp extension's review gate.

const risk = (rating: Partial<PlanRisk> = {}): PlanRisk => ({ impact: 1, reversibility: "revert", featureFlag: false, migration: false, auth: false, newRule: false, advisor: null, recommendation: "auto", ...rating });

const plan = (model: string, rest = ""): string => `# Plan\n\n1. Add the column.\n\n## ${MODEL_SECTION}\n\n${model}\n${rest}`;
const section = (tier = "- Tier: cheap — one report column", steps = "- Strong steps: none — routine", tests = "- Acceptance tests: `server/report.test.ts`, client/report.test.tsx — the column and its filter"): string => `${tier}\n${steps}\n${tests}\n`;
const STRONG = "- Tier: strong — the whole ticket is strong\n- Strong steps: none — nothing more is needing judgement\n- Acceptance tests: none — no test file proves it\n";
// The `## Risk and impact` section an impact-3 plan carries.
const RATING = `## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: 3 — writes orders\n- Reversibility: revert — nothing is written outside the report\n- Feature flag: no\n- Migration: no\n- Auth: no\n- New rule: no — a one-off column\n- Failure mode: a wrong column; sales notices the next day\n- Advisor rating: impact 3, reversibility revert\n- Recommendation: auto — nothing for the owner to decide\n`;

function model(text: string, rating: PlanRisk | null = risk()): PlanModel {
  const parsed = parsePlanModel(text, rating);
  assert.ok("model" in parsed, `expected a model, got: ${"problem" in parsed ? parsed.problem : ""}`);
  return parsed.model;
}

function problem(text: string, rating: PlanRisk | null = risk()): string {
  const parsed = parsePlanModel(text, rating);
  assert.ok("problem" in parsed, "expected a problem");
  return parsed.problem;
}

test("a complete cheap plan names the tests it wants written first; a strong plan needs no steps", () => {
  assert.deepEqual(model(plan(section())), { tier: "cheap", reason: "one report column", strongSteps: null, acceptanceTests: ["server/report.test.ts", "client/report.test.tsx"] });
  assert.deepEqual(model(plan(STRONG)), { tier: "strong", reason: "the whole ticket is strong", strongSteps: null, acceptanceTests: null });
  assert.equal(modelProblem(plan(section())), null, "`modelProblem` applies the same rules to the plan's own rating");
});

test("a plan below strong must name the step a migration, an auth change or a new rule rides on", () => {
  const refused = problem(plan(section()), risk({ migration: true, auth: true }));
  assert.match(refused, /"## Risk and impact" names a migration, an auth change, which single steps of the plan carry, but "- Strong steps" names no step/);
  assert.match(refused, /"- Strong steps: <step numbers> — <why>"/);
  assert.match(problem(plan(section()), risk({ newRule: true })), /"- Strong steps" names no step: list the step\(s\) that write .*the rule/);
  assert.equal(model(plan(section("- Tier: cheap — one column", "- Strong steps: 3 — the auth check and the migration it needs\n")), risk({ migration: true, auth: true })).strongSteps, "3 — the auth check and the migration it needs", "the named step accepts the plan on the cheap tier");
  assert.deepEqual([...strongStepNumbers("3, 7 — the auth check")], [3, 7]);
  assert.deepEqual([...strongStepNumbers("3 — the auth check, which needs step 2's fixture")], [3], "only the numbers before the reason are steps");
  assert.deepEqual([...strongStepNumbers("none")], []);
  assert.deepEqual([...strongStepNumbers(null)], []);
});

test("an impact above 2 or anything a revert does not undo takes the strong tier", () => {
  assert.equal(MAX_IMPACT_BELOW_STRONG, 2, "the cheap tier's impact ceiling");
  assert.equal(model(plan(section()), risk({ impact: 2 })).tier, "cheap");
  assert.match(problem(plan(section()), risk({ impact: 3 })), /"- Tier: cheap" is not allowed for this plan \(impact 3 in "## Risk and impact"\): write "- Tier: strong — <why>"\./);
  assert.match(problem(plan(section()), risk({ reversibility: "data-fix" })), /is not allowed for this plan \(data-fix in/);
  assert.match(problem(plan(section()), risk({ impact: 0, reversibility: "irreversible" })), /\(irreversible in/);
  assert.equal(model(plan(STRONG), risk({ impact: 4, reversibility: "data-fix" })).tier, "strong");
});

test("every line of the section is required and its reason spelled out", () => {
  assert.match(problem(plan("- Tier: cheap — one column\n- Strong steps: none — routine\n")), /has no "- Acceptance tests: <none \| test file paths> — <why>" line/);
  assert.match(problem(plan("- Tier: cheap — one column\n- Acceptance tests: none — no test file\n")), /has no "- Strong steps: <none \| step numbers> — <why>" line/);
  assert.match(problem(plan("- Strong steps: none — routine\n- Acceptance tests: none — no test file\n")), /has no readable "- Tier: <cheap \| strong> — <why>" line/);
  assert.match(problem(plan("- Tier: cheap\n- Strong steps: none — routine\n- Acceptance tests: none — no test file\n")), /"- Tier: cheap" gives no reason after the dash/);
  assert.match(problem(plan("- Tier: cheap — one column\n- Strong steps: none — routine\n- Acceptance tests: none\n")), /"- Acceptance tests" gives no reason after the dash \(why no test file proves this plan\)\./);
  assert.match(problem(plan("- Tier: cheap — one column\n- Strong steps: none — routine\n- Acceptance tests: server/x.test.ts\n")), /"- Acceptance tests" gives no reason after the dash\./);
  assert.match(problem("# Plan\n\n1. Add the column.\n"), /has no "## Model" section/);
});

test("readTier reads a dropped tier name as its conservative current one and never defaults", () => {
  assert.deepEqual([...TIERS], ["cheap", "strong"], "the middle tier is gone");
  assert.deepEqual(LEGACY_TIER_READINGS, { standard: "strong" });
  assert.equal(readTier("standard"), "strong");
  assert.equal(readTier(" Standard "), "strong", "case and whitespace fold");
  assert.equal(readTier("cheap"), "cheap");
  assert.equal(readTier("strong"), "strong");
  assert.equal(readTier("fast"), null);
  assert.equal(readTier(""), null);
  assert.equal(readTier(null), null);
  assert.equal(readTier(1), null);
  assert.equal(isTier("standard"), false);
  assert.equal(isTier("cheap"), true);
});

test("a plan from before the cutover is refused by the gate and read conservatively by the reader", () => {
  const legacy = plan("- Tier: standard — a careful column\n- Strong steps: none — routine\n- Acceptance tests: none — no test file\n");
  assert.match(problem(legacy), /"- Tier: standard" is no longer a tier: the standard implementation tier was dropped\. Write "- Tier: cheap — <why>" \(the default\) or "- Tier: strong — <why>"\./);
  assert.equal(modelProblem(legacy)?.includes("no longer a tier"), true, "a plan submitted now must be rewritten");
  assert.equal(planTier(legacy)?.tier, "strong", "an in-flight ticket keeps the conservative tier");
  assert.equal(planTier(legacy)?.reason, "a careful column", "the plan's own reason travels");
});

test("the lenient reader never invents a tier and raises one the plan's rating outgrows", () => {
  assert.equal(planTier(plan(section()))?.tier, "cheap", "the review gate refuses what needs fixing; this reader does not");
  assert.equal(planTier(plan(section()))?.strongSteps, null);
  assert.equal(planTier(plan(section("- Tier: cheap — one column", "- Strong steps: 2 — the migration\n")))?.strongSteps, "2 — the migration", "the named steps travel with the tier");
  const rated = planTier(`${plan(section())}${RATING}`);
  assert.equal(rated?.tier, "strong", "a rating above impact 2 raises a cheap plan");
  assert.match(rated?.reason ?? "", /the plan's risk rating requires it \(impact 3\)/);
  assert.equal(planTier("# Plan\n\n1. Add the column.\n"), null, "no section: no tier, never a default");
  assert.equal(planTier(plan("- Tier: mystery — why\n- Strong steps: none — routine\n- Acceptance tests: none — no test file\n")), null);
});