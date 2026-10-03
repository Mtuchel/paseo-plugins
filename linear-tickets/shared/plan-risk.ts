// Plan risk rating and auto-approval (README, "Plan risk and auto-approval"). Every ticket plan
// carries a `## Risk and impact` section in a fixed format; the omp extension refuses to record the
// advisor review without it, and the Plannotator bridge approves a plan on the owner's behalf when
// the rating is within the owner's threshold. The model rates; this module's rule decides.
// No npm dependencies: the omp extension imports it from outside the plugin's build.

import { createHash } from "node:crypto";

export const RISK_SECTION = "Risk and impact";

// A plan text's identity: the extension hashes the plan it records the advisor review for, the
// server the text Plannotator shows the owner and the decisions Plannotator saved.
export function planHash(plan: string): string {
  return createHash("sha256").update(plan.trim()).digest("hex");
}

export const IMPACT_LEVELS = [
  "no business process (agent tooling, CI, docs, refactor without behavior change)",
  "read-only (reports, views, dashboards, logs): nobody's work or records change",
  "changes how people do a step (screens, validation, defaults, internal notifications)",
  "changes business records (orders, stock, batches, QM decisions, specifications, master data)",
  "external, financial or legal effect (Business Central postings, payroll, EDI or mail to customers and suppliers, certificates, food-safety alerts)",
] as const;
export const MAX_IMPACT = IMPACT_LEVELS.length - 1;
export type Impact = 0 | 1 | 2 | 3 | 4;

// Worst last: the combined rating takes the later of two values.
export const REVERSIBILITY = ["revert", "data-fix", "irreversible"] as const;
export type Reversibility = (typeof REVERSIBILITY)[number];
const REVERSIBILITY_TEXT: Record<Reversibility, string> = {
  revert: "reverting the pull request restores everything",
  "data-fix": "records written in the meantime need a manual fix",
  irreversible: "effects outside our systems cannot be undone",
};

export type Rating = { impact: Impact; reversibility: Reversibility };
export type PlanRisk = Rating & {
  featureFlag: boolean;
  migration: boolean;
  auth: boolean;
  // The advisor's own rating; null when the advisor was unavailable.
  advisor: Rating | null;
  recommendation: "auto" | "owner";
};

// The section the planner writes, word for word in the prompt so the parser below can read it.
export function riskSteps(): string {
  return [
    `End the plan with a \`## ${RISK_SECTION}\` section (before \`## Advisor review\`) in exactly this format, one line per field, the value first and your reason after a dash:`,
    "- Areas: <the affected Area labels, e.g. Sales, Warehouse>",
    "- Processes: <the business processes and steps affected, e.g. order → delivery note>",
    "- Impact: <0-4> — <why>",
    "- Reversibility: <revert | data-fix | irreversible> — <why>",
    "- Feature flag: <yes | no> — <which flag keeps the change off until it is switched on>",
    "- Migration: <yes | no>",
    "- Auth: <yes | no> (authentication, authorization or permissions)",
    "- Failure mode: <what breaks for whom if the change is wrong, and how we would notice>",
    "- Advisor rating: <impact 0-4, reversibility revert | data-fix | irreversible> (the advisor's own rating, or `unavailable`)",
    "- Recommendation: <auto | owner> — <owner when the plan needs a business decision, wording or layout the owner chooses, production data changes, external accounts or spend>",
    "Impact levels:",
    ...IMPACT_LEVELS.map((text, level) => `${level} — ${text}`),
    "Reversibility:",
    ...REVERSIBILITY.map((value) => `${value} — ${REVERSIBILITY_TEXT[value]}`),
    "Rate the worst plausible outcome of the change, not its size. When unsure between two levels, take the higher.",
  ].join("\n");
}

function field(body: string, name: string): string | null {
  const match = new RegExp(`^\\s*[-*]\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*(.+)$`, "im").exec(body);
  return match ? match[1].trim() : null;
}

function reversibilityOf(value: string): Reversibility | null {
  const match = /\b(revert|data-fix|irreversible)\b/i.exec(value);
  return match ? (match[1].toLowerCase() as Reversibility) : null;
}

function yesNo(value: string): boolean | null {
  const match = /^\W*(yes|no)\b/i.exec(value);
  return match ? match[1].toLowerCase() === "yes" : null;
}

// The plan's rating, or the problem the planner must fix (the record tool returns it).
export function parsePlanRisk(plan: string): { risk: PlanRisk } | { problem: string } {
  // The section's body up to the next heading of level 1 or 2.
  const body = new RegExp(`^#{1,6}\\s+${RISK_SECTION}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, "im").exec(plan)?.[1] ?? null;
  if (body === null) return { problem: `The plan has no "## ${RISK_SECTION}" section.\n\n${riskSteps()}` };
  const missing: string[] = [];
  const read = <T>(name: string, parse: (value: string) => T | null): T | null => {
    const raw = field(body, name);
    const value = raw === null ? null : parse(raw);
    if (value === null) missing.push(name);
    return value;
  };
  const impact = read("Impact", (value) => {
    const match = /^\D{0,20}?\b([0-4])\b/.exec(value);
    return match ? (Number(match[1]) as Impact) : null;
  });
  const reversibility = read("Reversibility", reversibilityOf);
  const featureFlag = read("Feature flag", yesNo);
  const migration = read("Migration", yesNo);
  const auth = read("Auth", yesNo);
  const recommendation = read("Recommendation", (value) => /^\W*(auto|owner)\b/i.exec(value)?.[1].toLowerCase() as "auto" | "owner" | undefined ?? null);
  const advisor = read("Advisor rating", (value): { rating: Rating | null } | null => {
    if (/^\W*unavailable\b/i.test(value)) return { rating: null };
    const level = /impact\s*:?\s*([0-4])\b/i.exec(value);
    const undo = reversibilityOf(value);
    return level && undo ? { rating: { impact: Number(level[1]) as Impact, reversibility: undo } } : null;
  });
  for (const name of ["Areas", "Processes", "Failure mode"]) if (!field(body, name)) missing.push(name);
  if (missing.length || impact === null || reversibility === null || featureFlag === null || migration === null || auth === null || recommendation === null || advisor === null) {
    return { problem: `The "## ${RISK_SECTION}" section is missing or has an unreadable value for: ${missing.join(", ")}.\n\n${riskSteps()}` };
  }
  return { risk: { impact, reversibility, featureFlag, migration, auth, advisor: advisor.rating, recommendation } };
}

// The planner's and the advisor's rating combined: the higher impact, the worse reversibility.
export function combinedRating(risk: PlanRisk): Rating {
  const advisor = risk.advisor ?? risk;
  return {
    impact: Math.max(risk.impact, advisor.impact) as Impact,
    reversibility: REVERSIBILITY[Math.max(REVERSIBILITY.indexOf(risk.reversibility), REVERSIBILITY.indexOf(advisor.reversibility))],
  };
}

export function ratingText(risk: PlanRisk): string {
  const { impact, reversibility } = combinedRating(risk);
  const extras = [risk.featureFlag ? "behind a feature flag" : "", risk.migration ? "migration" : "", risk.auth ? "auth" : ""].filter(Boolean);
  return `impact ${impact}/${MAX_IMPACT}, ${reversibility}${extras.length ? `, ${extras.join(", ")}` : ""}`;
}

// The owner's threshold: plans rated at or below `maxImpact` (`maxImpactWithFlag` behind a feature
// flag) are approved without the owner.
export type AutoApprovePolicy = { enabled: boolean; maxImpact: number; maxImpactWithFlag: number };
export const DEFAULT_AUTO_APPROVE: AutoApprovePolicy = { enabled: true, maxImpact: 1, maxImpactWithFlag: 2 };

// What the plugin knows about the review besides the plan text. `verdict`: the advisor verdict the
// omp extension recorded for exactly this text (null: none, so the rating is unverified).
export type ReviewFacts = { verdict: string | null; untrusted: boolean; attended: boolean };

// Whether the plan is approved without the owner, and why (shown to the owner either way).
export function autoApproval(risk: PlanRisk, policy: AutoApprovePolicy, facts: ReviewFacts): { approve: boolean; reasons: string[] } {
  const { impact, reversibility } = combinedRating(risk);
  const limit = risk.featureFlag ? Math.max(policy.maxImpact, policy.maxImpactWithFlag) : policy.maxImpact;
  const reasons = [
    policy.enabled ? "" : "auto-approval is off",
    facts.untrusted ? "the ticket was not written by the owner" : "",
    facts.attended ? "the ticket is marked attended" : "",
    facts.verdict === null ? "no advisor review was recorded for this plan text" : "",
    facts.verdict === "unavailable" || (facts.verdict !== null && !risk.advisor) ? "the advisor was unavailable" : "",
    facts.verdict === "disagreements" ? "the advisor review left open disagreements" : "",
    risk.recommendation === "owner" ? "the planner asks for the owner" : "",
    impact > limit ? `impact ${impact} is above the threshold ${limit}` : "",
    reversibility !== "revert" ? `reversibility is ${reversibility}` : "",
    risk.migration ? "it includes a migration" : "",
    risk.auth ? "it changes auth or permissions" : "",
  ].filter(Boolean);
  return { approve: reasons.length === 0, reasons };
}
