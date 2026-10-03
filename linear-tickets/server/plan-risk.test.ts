import assert from "node:assert/strict";
import test from "node:test";
import { autoApproval, DEFAULT_AUTO_APPROVE, parsePlanRisk, type PlanRisk, type ReviewFacts } from "../shared/plan-risk";

const section = (fields: Record<string, string>) => {
  const values = {
    Areas: "Warehouse", Processes: "stock transfer", Impact: "1 — read-only", Reversibility: "revert — nothing written", "Feature flag": "no",
    Migration: "no", Auth: "no", "Failure mode": "wrong totals in the view", "Advisor rating": "impact 1, reversibility revert", Recommendation: "auto — routine",
    ...fields,
  };
  return `# Plan\n\n## Risk and impact\n\n${Object.entries(values).map(([name, value]) => `- ${name}: ${value}`).join("\n")}\n\n## Advisor review\n\nAgreed.\n`;
};

const risk = (fields: Record<string, string> = {}): PlanRisk => {
  const parsed = parsePlanRisk(section(fields));
  assert.ok("risk" in parsed, "problem" in parsed ? parsed.problem : "");
  return parsed.risk;
};

const trusted: ReviewFacts = { verdict: "agreed", untrusted: false, attended: false };

test("the rating section is read from its fixed lines, bold labels included, and a missing or unreadable field is named", () => {
  assert.deepEqual(risk({ Impact: "3 — writes orders", Reversibility: "data-fix", "Feature flag": "yes — sales.newFlow", "Advisor rating": "impact 4, reversibility irreversible" }), {
    impact: 3, reversibility: "data-fix", featureFlag: true, migration: false, auth: false, advisor: { impact: 4, reversibility: "irreversible" }, recommendation: "auto",
  });
  assert.equal(risk({ "Advisor rating": "unavailable" }).advisor, null);
  const bold = parsePlanRisk(section({}).replace("- Impact:", "- **Impact:**"));
  assert.ok("risk" in bold && bold.risk.impact === 1);
  const broken = parsePlanRisk(section({ Impact: "high", Migration: "maybe" }).replace("- Failure mode: wrong totals in the view\n", ""));
  assert.ok("problem" in broken);
  assert.match(broken.problem, /unreadable value for: Impact, Migration, Failure mode/);
  const none = parsePlanRisk("# Plan\n\nDo it.\n");
  assert.ok("problem" in none && /no "## Risk and impact" section/.test(none.problem));
});

test("the threshold is inclusive, a feature flag raises it, and the advisor's higher rating counts", () => {
  assert.equal(autoApproval(risk(), DEFAULT_AUTO_APPROVE, trusted).approve, true);
  assert.deepEqual(autoApproval(risk({ Impact: "2", "Advisor rating": "impact 2, reversibility revert" }), DEFAULT_AUTO_APPROVE, trusted).reasons, ["impact 2 is above the threshold 1"]);
  assert.equal(autoApproval(risk({ Impact: "2", "Advisor rating": "impact 2, reversibility revert", "Feature flag": "yes — flag" }), DEFAULT_AUTO_APPROVE, trusted).approve, true);
  assert.deepEqual(autoApproval(risk({ Impact: "3", "Advisor rating": "impact 3, reversibility revert", "Feature flag": "yes — flag" }), DEFAULT_AUTO_APPROVE, trusted).reasons, ["impact 3 is above the threshold 2"]);
  assert.deepEqual(autoApproval(risk({ Impact: "0", "Advisor rating": "impact 2, reversibility data-fix" }), DEFAULT_AUTO_APPROVE, trusted).reasons, ["impact 2 is above the threshold 1", "reversibility is data-fix"]);
  assert.equal(autoApproval(risk({ Impact: "4", "Advisor rating": "impact 4, reversibility revert" }), { enabled: true, maxImpact: 4, maxImpactWithFlag: 4 }, trusted).approve, true);
});

test("hard stops hold whatever the impact: owner request, migration, auth, no revert, missing or split advice, off switch", () => {
  const reasons = (fields: Record<string, string>, facts = trusted, policy = DEFAULT_AUTO_APPROVE) => autoApproval(risk(fields), policy, facts).reasons;
  assert.deepEqual(reasons({ Recommendation: "owner — wording is the owner's call" }), ["the planner asks for the owner"]);
  assert.deepEqual(reasons({ Migration: "yes" }), ["it includes a migration"]);
  assert.deepEqual(reasons({ Auth: "yes" }), ["it changes auth or permissions"]);
  assert.deepEqual(reasons({ Reversibility: "irreversible — sends EDI" }), ["reversibility is irreversible"]);
  assert.deepEqual(reasons({}, { ...trusted, verdict: null }), ["no advisor review was recorded for this plan text"]);
  assert.deepEqual(reasons({ "Advisor rating": "unavailable" }, { ...trusted, verdict: "unavailable" }), ["the advisor was unavailable"]);
  assert.deepEqual(reasons({}, { ...trusted, verdict: "disagreements" }), ["the advisor review left open disagreements"]);
  assert.deepEqual(reasons({}, trusted, { ...DEFAULT_AUTO_APPROVE, enabled: false }), ["auto-approval is off"]);
});
