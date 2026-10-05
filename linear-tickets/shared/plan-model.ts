// Model tiers (README, "Model tiers"). Every ticket plan carries a `## Model` section that names
// the tier its implementation runs on: `cheap` (the provider's cheap model, e.g. DeepSeek) or
// `strong` (the launch model, e.g. Opus). Planning always runs on the strong model. The omp
// extension refuses to record the advisor review without a readable section; the plugin applies
// the tier when the plan is approved and when a later agent implements it.
// No imports beyond ./plan-risk: Paseo's shared bundle refuses Node modules, and the omp extension
// imports it from outside the plugin's build.

import { combinedRating, field, sectionBody, type PlanRisk } from "./plan-risk";

export const MODEL_SECTION = "Model";
export const TIERS = ["cheap", "strong"] as const;
export type Tier = (typeof TIERS)[number];
// The agent tool (omp extension) that moves a running ticket agent to the strong tier.
export const ESCALATE_TOOL = "escalate_model";
// Plans rated above this impact always implement on the strong tier.
export const MAX_CHEAP_IMPACT = 2;

export type PlanModel = { tier: Tier; reason: string; strongSteps: string | null };

// The stronger of two tiers; null when neither is known.
export function strongerTier(a: Tier | null | undefined, b: Tier | null | undefined): Tier | null {
  if (a === "strong" || b === "strong") return "strong";
  return a ?? b ?? null;
}

// Why this plan's rating rules out the cheap tier, or null when cheap is allowed.
export function cheapRuledOut(risk: PlanRisk): string | null {
  const { impact, reversibility } = combinedRating(risk);
  const reasons = [
    impact > MAX_CHEAP_IMPACT ? `impact ${impact}` : "",
    reversibility !== "revert" ? reversibility : "",
    risk.migration ? "a migration" : "",
    risk.auth ? "an auth change" : "",
    risk.newRule ? "a new rule" : "",
  ].filter(Boolean);
  return reasons.length ? reasons.join(", ") : null;
}

// The section the planner writes, word for word in the prompt so the parser below can read it.
export function modelSteps(): string {
  return [
    `Before \`## Risk and impact\`, the plan carries a \`## ${MODEL_SECTION}\` section that picks the model its implementation runs on, in exactly this format:`,
    "- Tier: <cheap | strong> — <why>",
    "- Strong steps: <none | the step numbers that need the strong model> — <why>",
    "Planning always runs on the strong model. Once the plan is approved, the implementing agent runs on the tier you pick: `cheap` is a fast, inexpensive model for well-specified work; `strong` is the launch model. Pick `cheap` by default. Pick `strong` when the implementation needs judgment the plan cannot settle up front: the change spans four or more layers (e.g. UI, API, persistence, scheduler), it designs or changes an interface others build on, several call sites must agree on one authoritative computation, there is a gap between a check and the write it guards (TOCTOU), or it touches more than about 15–20 files. Name that reason after the dash.",
    `A plan rated above impact ${MAX_CHEAP_IMPACT}, not reversible by a revert, or with a migration, an auth change or a new rule always takes \`strong\`.`,
    `\`Strong steps\` names single steps of a cheap plan that still need the strong model: the implementing agent hands each to a subagent on the strong model (in omp: the task tool with \`model: "@slow"\`). Every other subagent runs on the cheap model.`,
    `On the cheap tier, the implementing agent calls \`${ESCALATE_TOOL}\` with the reason when the same check still fails after two honest fix attempts, the work turns out to need one of the strong reasons above, or a review finds a design problem; the plugin then switches it to the strong model.`,
  ].join("\n");
}

// The section's lines as written: tier and reason from `- Tier: cheap — <reason>`, the strong
// steps (null for `none` or no line), and whether the `Strong steps` line exists. null: no section.
function readSection(plan: string): { tier: Tier | null; reason: string; strongSteps: string | null; hasSteps: boolean } | null {
  const body = sectionBody(plan, MODEL_SECTION);
  if (body === null) return null;
  const raw = field(body, "Tier") ?? "";
  const tier = /^\W*(cheap|strong)\b/i.exec(raw)?.[1].toLowerCase() as Tier | undefined;
  const steps = field(body, "Strong steps");
  return { tier: tier ?? null, reason: raw.replace(/^\W*\w+\W*/, "").trim(), strongSteps: steps && !/^\W*none\b/i.test(steps) ? steps : null, hasSteps: steps !== null };
}

// The step numbers in a `Strong steps` value (`2, 4 — <why>`): only those before the reason.
export function strongStepNumbers(strongSteps: string | null): Set<number> {
  const list = (strongSteps ?? "").split(/\s[—–-]\s/)[0];
  return new Set([...list.matchAll(/\d+/g)].map((match) => Number(match[0])));
}

// The plan's tier, leniently: null when the section or its tier is missing or unreadable. Plans
// approved before model tiers have none and implement on the strong tier.
export function planTier(plan: string): PlanModel | null {
  const section = readSection(plan);
  return section?.tier ? { tier: section.tier, reason: section.reason, strongSteps: section.strongSteps } : null;
}

// The plan's tier, or the problem the planner must fix (the record tool returns it). `risk`: the
// plan's parsed `## Risk and impact`, which can rule out the cheap tier.
export function parsePlanModel(plan: string, risk: PlanRisk): { model: PlanModel } | { problem: string } {
  const section = readSection(plan);
  if (section === null) return { problem: `The plan has no "## ${MODEL_SECTION}" section.\n\n${modelSteps()}` };
  const { tier, reason, strongSteps, hasSteps } = section;
  const problems: string[] = [];
  if (!tier) problems.push(`"## ${MODEL_SECTION}" has no readable "- Tier: <cheap | strong> — <why>" line.`);
  else if (!reason) problems.push(`"- Tier: ${tier}" gives no reason after the dash.`);
  if (!hasSteps) problems.push(`"## ${MODEL_SECTION}" has no "- Strong steps: <none | step numbers> — <why>" line.`);
  const ruledOut = cheapRuledOut(risk);
  if (tier === "cheap" && ruledOut) problems.push(`"- Tier: cheap" is not allowed for this plan (${ruledOut} in "## Risk and impact"): write "- Tier: strong — <why>".`);
  if (problems.length || !tier) return { problem: `The plan's "## ${MODEL_SECTION}" section needs fixing:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\n${modelSteps()}` };
  return { model: { tier, reason, strongSteps } };
}
