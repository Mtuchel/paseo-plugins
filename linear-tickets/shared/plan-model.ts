// Model tiers (README, "Model tiers"). Every ticket plan carries a `## Model` section that names
// the tier its implementation runs on — `cheap` (the provider's cheap model, e.g. DeepSeek Flash)
// or `strong` (the launch model, e.g. Opus) — the single steps that still need the strong model,
// and the acceptance tests the plan wants written before the implementation starts. Planning
// always runs on the strong model. The omp extension refuses to record the advisor review without
// a readable section, and the plugin sends a submitted plan without one back to its planner; the
// plugin applies the tier when the plan is approved and when a later agent implements it.
//
// The rule is ticket-level on purpose (2026-10-15). A migration, an auth change or a new rule used
// to force the whole ticket to the strong tier, and one such step then paid Opus for every
// mechanical step around it: 445 of 603 tickets implemented fully on Opus since 2026-10-05, while
// the measured cheap tier escalated 6% of its tickets and its tool-error rate equalled Opus's.
// Those reasons are the plan's to name as strong steps (`strongStepReasons`), not the ticket's.
// No imports beyond ./plan-risk: Paseo's shared bundle refuses Node modules, and the omp extension
// imports it from outside the plugin's build.

import { combinedRating, field, parsePlanRisk, sectionBody, type PlanRisk } from "./plan-risk";

export const MODEL_SECTION = "Model";
// Weakest first: the stronger of two tiers is the later one. The `standard` implementation tier
// (GPT-6.1 Sol) was dropped on 2026-10-15: it sat between cheap and strong without a rule that
// picked it, so a plan that was not cheap took the launch model anyway, and its few tickets paid
// Sol's price for work the cheap tier measured as safe. Sol stays the independent reviewer
// (README, "Independent review"), which is a review route, not a tier.
export const TIERS = ["cheap", "strong"] as const;
export type Tier = (typeof TIERS)[number];
// Tier names that are no longer tiers, read as the conservative current one: plans, labels and
// tier records from before the cutover keep in-flight tickets on the strong model instead of
// dropping them to a tier the plan never picked. Never written again (`TIER_LABELS`).
export const LEGACY_TIER_READINGS: Record<string, Tier> = { standard: "strong" };
// The agent tool (omp extension) that moves a running ticket agent to the strong tier.
export const ESCALATE_TOOL = "escalate_model";
// Plans rated above this impact always implement on the strong tier.
export const MAX_IMPACT_BELOW_STRONG = 2;

export type PlanModel = { tier: Tier; reason: string; strongSteps: string | null; acceptanceTests: string[] | null };

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

// A tier name as the current rules read it: a name that is no longer a tier as its conservative
// current one, anything else as null (never a default tier). Every read boundary uses this: a plan
// text, a `model:` label, the agent label, a tier record.
export function readTier(value: unknown): Tier | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return isTier(name) ? name : LEGACY_TIER_READINGS[name] ?? null;
}

// The stronger of two tiers; null when neither is known.
export function strongerTier(a: Tier | null | undefined, b: Tier | null | undefined): Tier | null {
  if (!a || !b) return a ?? b ?? null;
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

// Why this plan's rating requires the strong tier for the whole ticket, or null when a lower tier
// is allowed. Only the ticket-level reasons are here: the rating's migration, auth and new-rule
// flags are single steps, which the plan names under `Strong steps` instead (`strongStepReasons`).
export function strongRequired(risk: PlanRisk): string | null {
  const { impact, reversibility } = combinedRating(risk);
  const reasons = [
    impact > MAX_IMPACT_BELOW_STRONG ? `impact ${impact}` : "",
    reversibility !== "revert" ? reversibility : "",
  ].filter(Boolean);
  return reasons.length ? reasons.join(", ") : null;
}

// The rating's step-level reasons: a migration, an auth change or a new rule is one step of the
// plan, not the ticket. A plan below the strong tier is valid only when its `Strong steps` line
// names the step(s) that carry them, which `parsePlanModel` refuses otherwise; the steps that
// define a contract run first (modelSteps).
export function strongStepReasons(risk: PlanRisk): string | null {
  const reasons = [risk.migration ? "a migration" : "", risk.auth ? "an auth change" : "", risk.newRule ? "a new rule" : ""].filter(Boolean);
  return reasons.length ? reasons.join(", ") : null;
}

// A small-ticket route's rating (shared/small-route.ts) as a plan rating, so the same rule decides
// whether its tier may be below strong (`strongRequired`). There is no advisor and no plan text.
// The route refuses a migration, an auth change or a new rule outright (routeRefusals), so only
// the ticket-level reasons can apply here.
export function routeRisk(rating: { impact: PlanRisk["impact"]; reversibility: PlanRisk["reversibility"]; migration: boolean; auth: boolean; newRule: boolean }): PlanRisk {
  return { impact: rating.impact, reversibility: rating.reversibility, featureFlag: false, migration: rating.migration, auth: rating.auth, newRule: rating.newRule, advisor: null, recommendation: "auto" };
}

// Shared by planning and every implementation tier, including strong ticket owners.
export function workerDelegationNote(): string {
  return "Worker allocation is slice-specific, not inherited from the ticket's tier or risk rating. Keep the ticket owner responsible for framing, integration and verification. For useful independent slices whose interfaces, invariants and expected behavior the approved plan already settles, use the cheap worker (in omp the `task` tool without a model override, which runs on the cheap model); examples: prescribed predicate/validator replacements, established-pattern caller updates, settled behavioral fixtures, exact review fixes and specified smoke checks. Do not spawn on the strong model merely because the ticket is strong, touches several files or requires careful execution. Use the strong model only for unresolved design or diagnosis, authorization/identity/financial/solver decisions, concurrency/recovery/external-effect boundaries, or substantial rescue; state that slice-specific reason in the brief. A cheap-tier owner does the mechanical remainder itself and hands each strong step — and the acceptance tests its plan names, written first (`## Model` in the plan) — to a subagent on the strong model (in omp: the `task` tool with `model: \"@slow\"`) with its slice-specific reason; the strong model implements exactly those, never the rest. Give workers exact writable scope, rules and an observable verification scenario. A worker returns new decisions or an unresolved failure after two honest fix attempts to the owner rather than improvising. Do not force delegation for a trivial or tightly coupled edit. This applies to implementation workers only: Opus planning/ownership, Astra plan advice and independent Sol review routing stay unchanged.";
}

// The routing note for a Paseo session that is not a ticket agent (README, "Model tiers"): the
// same Flash-first allocation as a ticket, without the plan that settles it there. The omp
// extension adds it once to such a session's first prompt (`sessionRouting`). `strong`: the
// session itself runs on a strong model (an owner session on Opus), so it frames and hands off;
// a session on the cheap model implements itself and hands off only what needs the strong model.
export function sessionRoutingNote(strong: boolean): string {
  const shared = [
    "Model routing for this session (linear-tickets plugin, README \"Model tiers\"): implementation runs on the cheap model (DeepSeek Flash; in omp the `task` tool without a model override) unless a step needs the strong model, and quality does not drop for it: what makes cheap work safe is settled premises, contracts and tests, not the model.",
    "Premises first: before building on an existing function, field, behavior or data shape, have a cheap scout verify it against the current code, and treat an unverified premise as open.",
    "Strong steps — a migration, an auth/identity/financial/solver decision, a concurrency, recovery or check-then-write boundary, an interface others build on, or an open design or diagnosis — run on the strong model (in omp: the `task` tool with `model: \"@slow\"`), each with its slice-specific reason; the strong model does exactly those, never the mechanical remainder.",
    "When behavior changes, the strong model writes the failing acceptance tests first from the acceptance criteria, and the cheap side makes them pass without editing them.",
    "Give every worker exact writable scope, the settled contract (signatures, the authoritative function, invariants) and an observable verification scenario. A worker that fails the same check after two honest fix attempts, or meets a decision nobody settled, returns it instead of improvising.",
    "Do not force delegation for a trivial or tightly coupled edit.",
  ];
  return [
    ...shared,
    strong
      ? "You run on the strong model: frame the work, verify premises, settle contracts and write the acceptance tests yourself, keep the strong steps, and hand every settled implementation slice to cheap workers. Integration, verification and review stay with you."
      : "You run on the cheap model: implement settled work yourself, hand strong steps and acceptance tests to `@slow` subagents, and return unresolved design questions or a repeated failure to whoever started this session.",
  ].join(" ");
}

// The model families the cheap tier runs on (settings' `cheapModels`, omp's fallback chain behind
// it): any other model is treated as strong, so an unknown model frames and hands off rather than
// implementing everything itself.
const CHEAP_MODEL = /^(lithos|deepseek)$|flash/i;

// The routing note for this session's prompt, or null when it gets none: only a primary Paseo
// session (`agentId`, from PASEO_AGENT_ID) that is not a ticket agent (`ticket`, from
// LINEAR_TICKETS_ISSUE: a ticket's plan already carries its routing) and has not had it (`routed`).
// `kind`: omp's agent kind; a `task` subagent ("sub") follows its parent's brief instead.
export function sessionRouting(session: { ticket: string | undefined; agentId: string | undefined; kind: string | undefined; model: { provider?: string; id?: string } | undefined; routed: boolean }): string | null {
  if (!session.agentId || session.ticket || session.kind === "sub" || session.routed) return null;
  const cheap = [session.model?.provider, session.model?.id].some((name) => typeof name === "string" && CHEAP_MODEL.test(name));
  return sessionRoutingNote(!cheap);
}

// The section the planner writes, word for word in the prompt so the parser below can read it.
export function modelSteps(): string {
  return [
    `Before \`## Risk and impact\`, the plan carries a \`## ${MODEL_SECTION}\` section that picks the model its implementation runs on, in exactly this format. It is required: a plan without it goes back to you.`,
    "- Tier: <cheap | strong> — <why>",
    "- Strong steps: <none | the step numbers that need the strong model> — <why>",
    "- Acceptance tests: <none | the test file paths that prove this plan> — <why>",
    "Planning always runs on the strong model, and `cheap` is the default tier for the implementation: the judgment a ticket needs is spent on planning it, and a plan that spells out its steps does not need the launch model to carry them out. Write the plan so the cheap tier can implement it, and settle its contracts in the plan text — the exact signatures of what it adds or changes, which function is authoritative for a computation, the invariants that hold, the expected behavior. That is what these used to ask for the strong model: the change spans four or more layers (e.g. UI, API, persistence, scheduler), it designs or changes an interface others build on, several call sites must agree on one authoritative computation, there is a gap between a check and the write it guards (TOCTOU), or it touches more than about 15–20 files. Settle each of them in the plan; name the steps that still need judgment after that under `Strong steps`, exact signatures and all, with their reason. A step that defines a contract (a signature, an interface, the authoritative computation) comes first, and the rest of the plan builds on what it settles.",
    `Pick \`strong\` only when: the plan's rating requires it (below), the approach itself cannot be settled up front (open diagnosis, the design is the work), or the strong steps would be most of the work. Name that reason after the dash.`,
    `A plan rated above impact ${MAX_IMPACT_BELOW_STRONG}, or one a revert does not undo, always takes \`strong\`. A migration, an auth change or a new rule no longer makes the whole ticket strong: name the step that writes the migration, the auth check or the rule under \`Strong steps\` (a plan below strong without one is refused).`,
    `\`Strong steps\` names single steps of a cheap plan that still need the strong model: the implementing agent hands each to a subagent on the strong model (in omp: the task tool with \`model: "@slow"\`, which the plugin's extension runs on the launch's strong model), with its slice-specific reason, and integrates the result itself.`,
    `\`Acceptance tests\` names the test files that prove this plan's acceptance criteria. On a plan below strong they are written first and by the strong model: the implementing agent hands a strong subagent the job of writing them failing from the plan's acceptance criteria, then makes them pass without editing them — the omp extension blocks a cheap agent's edits to those paths (a guard against accidental routing, not isolation: a shell can still write). \`none\` with a reason (e.g. no behavior change) is allowed.`,
    "Premises: before you submit, list the premises this plan relies on — existing functions, fields, behavior and data shapes — and verify every one against the current code with a cheap scout (in omp: the `task` tool without a model override). State a cheap plan's premises as verified; a plan built on an unverified premise spends an implementation round on a wrong premise, not on the ticket.",
    workerDelegationNote(),
    `On the cheap tier, the implementing agent calls \`${ESCALATE_TOOL}\` with the reason when the same check still fails after two honest fix attempts, the work turns out to need judgment the plan did not settle, or a review finds a design problem; the plugin then switches it to the strong model.`,
  ].join("\n");
}

// The section's lines as written: tier and reason from `- Tier: cheap — <reason>`, the strong
// steps (null for `none` or no line) and whether that line exists, the acceptance-test paths (null
// for `none`) and that line's reason. `legacyTier`: the tier line names a tier that no longer
// exists (`standard`), which `parsePlanModel` refuses and the lenient reader (`planTier`) reads as
// its conservative current one. `name`: the tier word as written, for the problem text.
// null: no section.
function readSection(plan: string): { tier: Tier | null; legacyTier: Tier | null; name: string | null; reason: string; strongSteps: string | null; hasSteps: boolean; acceptanceTests: string[] | null; testsReason: string; hasTests: boolean } | null {
  const body = sectionBody(plan, MODEL_SECTION);
  if (body === null) return null;
  const raw = field(body, "Tier") ?? "";
  const name = /^\W*(\w+)/.exec(raw)?.[1]?.toLowerCase() ?? null;
  const tier = isTier(name) ? name : null;
  const steps = field(body, "Strong steps");
  const tests = field(body, "Acceptance tests");
  return {
    tier,
    legacyTier: tier ? null : readTier(name),
    name,
    reason: raw.replace(/^\W*\w+\W*/, "").trim(),
    strongSteps: steps && !/^\W*none\b/i.test(steps) ? steps : null,
    hasSteps: steps !== null,
    acceptanceTests: tests ? testPaths(tests) : null,
    testsReason: (tests?.split(/\s[—–-]\s/)[1] ?? "").trim(),
    hasTests: tests !== null,
  };
}

// The test file paths in an `Acceptance tests` value (`a/b.test.ts, c/d.test.ts — <why>`): the
// part before the reason, comma-separated, backticks and whitespace trimmed. null: `none`, or
// nothing readable before the dash.
function testPaths(value: string): string[] | null {
  if (/^\W*none\b/i.test(value)) return null;
  const paths = value.split(/\s[—–-]\s/)[0].split(",").map((path) => path.replace(/[`*]/g, "").trim()).filter(Boolean);
  return paths.length ? paths : null;
}

// The step numbers in a `Strong steps` value (`2, 4 — <why>`): only those before the reason.
export function strongStepNumbers(strongSteps: string | null): Set<number> {
  const list = (strongSteps ?? "").split(/\s[—–-]\s/)[0];
  return new Set([...list.matchAll(/\d+/g)].map((match) => Number(match[0])));
}

// The plan's tier, leniently: null when the section or its tier is missing or unreadable (the
// plan goes back to planning; it never defaults to a tier). A readable risk rating that requires
// the strong tier raises a lower one; a legacy `standard` line is read as its conservative tier
// (`LEGACY_TIER_READINGS`), which is what an in-flight ticket from before the cutover keeps. The
// rating's step-level reasons decide nothing here: the review gate (`parsePlanModel`) makes a plan
// below strong name the step that carries them before it can be approved at all.
export function planTier(plan: string): PlanModel | null {
  const section = readSection(plan);
  if (!section) return null;
  const tier = section.tier ?? section.legacyTier;
  if (!tier) return null;
  const rated = parsePlanRisk(plan);
  const required = tier === "strong" || "problem" in rated ? null : strongRequired(rated.risk);
  return required
    ? { tier: "strong", reason: `the plan's risk rating requires it (${required})`, strongSteps: null, acceptanceTests: null }
    : { tier, reason: section.reason, strongSteps: section.strongSteps, acceptanceTests: section.acceptanceTests };
}

// The plan's tier, or the problem the planner must fix (the record tool and the plugin's review
// gate return it). `risk`: the plan's parsed `## Risk and impact`, which can require the strong
// tier; null when it is unreadable (the review then goes to the owner, who sees that).
export function parsePlanModel(plan: string, risk: PlanRisk | null): { model: PlanModel } | { problem: string } {
  const section = readSection(plan);
  if (section === null) return { problem: `The plan has no "## ${MODEL_SECTION}" section.\n\n${modelSteps()}` };
  const { tier, legacyTier, name, reason, strongSteps, hasSteps, acceptanceTests, testsReason, hasTests } = section;
  const problems: string[] = [];
  if (!tier) problems.push(legacyTier
    ? `"- Tier: ${name}" is no longer a tier: the standard implementation tier was dropped. Write "- Tier: cheap — <why>" (the default) or "- Tier: strong — <why>".`
    : `"## ${MODEL_SECTION}" has no readable "- Tier: <cheap | strong> — <why>" line.`);
  else if (!reason) problems.push(`"- Tier: ${tier}" gives no reason after the dash.`);
  if (!hasSteps) problems.push(`"## ${MODEL_SECTION}" has no "- Strong steps: <none | step numbers> — <why>" line.`);
  if (!hasTests) problems.push(`"## ${MODEL_SECTION}" has no "- Acceptance tests: <none | test file paths> — <why>" line.`);
  else if (!testsReason) problems.push(`"- Acceptance tests" gives no reason after the dash${acceptanceTests ? "" : " (why no test file proves this plan)"}.`);
  const required = risk ? strongRequired(risk) : null;
  if (tier && tier !== "strong" && required) problems.push(`"- Tier: ${tier}" is not allowed for this plan (${required} in "## Risk and impact"): write "- Tier: strong — <why>".`);
  const stepReasons = tier && tier !== "strong" && risk ? strongStepReasons(risk) : null;
  if (stepReasons && !strongSteps) problems.push(`"## Risk and impact" names ${stepReasons}, which single steps of the plan carry, but "- Strong steps" names no step: list the step(s) that write the migration, the auth check or the rule ("- Strong steps: <step numbers> — <why>"), or write "- Tier: strong — <why>".`);
  if (problems.length || !tier) return { problem: `The plan's "## ${MODEL_SECTION}" section needs fixing:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\n${modelSteps()}` };
  return { model: { tier, reason, strongSteps, acceptanceTests } };
}

// What a submitted ticket plan's `## Model` section lacks, or null when it is complete. The
// plugin sends a plan with a problem back to its planner before anyone reviews it.
export function modelProblem(plan: string): string | null {
  const rated = parsePlanRisk(plan);
  const parsed = parsePlanModel(plan, "problem" in rated ? null : rated.risk);
  return "problem" in parsed ? parsed.problem : null;
}