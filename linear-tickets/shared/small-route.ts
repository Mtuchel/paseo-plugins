// The small-ticket route (README, "Small-ticket route"; TUC-1854): a small, low-risk ticket the
// owner wrote skips the plan review. Only omp planners get the tool, and only when the plugin
// offers it at launch (server/starter.ts `planSetup`). The tool checks the ticket's facts; the
// plugin checks them again with the ticket's and the owner's current state before anything
// happens (server/small-route.ts). Both read this module.
// No imports beyond ./plan-risk and ./plan-model: Paseo's shared bundle refuses Node modules, and
// the omp extension imports it from outside the plugin's build.

import { strongRequired, routeRisk, TIERS, type Tier } from "./plan-model";
import { MAX_IMPACT, REVERSIBILITY, type Impact, type Reversibility } from "./plan-risk";

export const SMALL_ROUTE_ENV = "LINEAR_TICKETS_SMALL_ROUTE";
export const SMALL_ROUTE_TOOL = "take_small_ticket_route";
// Ticket label of a ticket implemented on the small route; the owner's `plan` label wins over it.
export const NO_PLAN_LABEL = "no-plan";
// More than one acceptance criterion is still small up to this many expected changed lines.
export const SMALL_ROUTE_MAX_LINES = 300;
// How long the tool waits for the plugin's answer; a later answer never counts (the route event's
// `expiresAt`).
export const SMALL_ROUTE_WAIT_MS = 60_000;

export type RouteFacts = {
  acceptanceCriteria: number;
  expectedChangedLines: number;
  impact: Impact;
  reversibility: Reversibility;
  migration: boolean;
  auth: boolean;
  moneyOrErp: boolean;
  crossPackageContract: boolean;
  newRule: boolean;
  ownerDecisionNeeded: boolean;
  tier: Tier;
  tierReason: string;
  // The `Reach:` bullet the pull request body carries instead of a plan's `## Reach`.
  reach: string;
  reason: string;
};

const FLAGS = ["migration", "auth", "moneyOrErp", "crossPackageContract", "newRule", "ownerDecisionNeeded"] as const;
const FLAG_TEXT: Record<(typeof FLAGS)[number], string> = {
  migration: "it includes a database migration",
  auth: "it changes login or permissions",
  moneyOrErp: "it touches money or the ERP",
  crossPackageContract: "it changes a contract other packages build on",
  newRule: "it sets a new rule",
  ownerDecisionNeeded: "it needs a decision from the owner",
};
const MAX_TEXT = 2_000;

function flag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "yes" || value === "true") return true;
  if (value === "no" || value === "false") return false;
  return null;
}

function count(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function words(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : null;
}

// The facts a tool call or route event names, or what is missing. Flags read `yes`/`no` (the tool)
// or booleans (the event).
export function parseRouteFacts(value: unknown): { facts: RouteFacts } | { problem: string } {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const missing: string[] = [];
  const read = <T>(name: string, parse: (raw: unknown) => T | null): T => {
    const parsed = parse(input[name]);
    if (parsed === null) missing.push(name);
    return parsed as T;
  };
  const impact = read("impact", (raw) => { const n = count(raw); return n !== null && n <= MAX_IMPACT ? n as Impact : null; });
  const facts: RouteFacts = {
    acceptanceCriteria: read("acceptanceCriteria", count),
    expectedChangedLines: read("expectedChangedLines", count),
    impact,
    reversibility: read("reversibility", (raw) => (REVERSIBILITY as readonly unknown[]).includes(raw) ? raw as Reversibility : null),
    migration: read("migration", flag),
    auth: read("auth", flag),
    moneyOrErp: read("moneyOrErp", flag),
    crossPackageContract: read("crossPackageContract", flag),
    newRule: read("newRule", flag),
    ownerDecisionNeeded: read("ownerDecisionNeeded", flag),
    tier: read("tier", (raw) => (TIERS as readonly unknown[]).includes(raw) ? raw as Tier : null),
    tierReason: read("tierReason", words),
    reach: read("reach", words),
    reason: read("reason", words),
  };
  return missing.length ? { problem: `Missing or unreadable: ${missing.join(", ")}.` } : { facts };
}

// Why the ticket does not qualify for the small route by its own facts (empty: it does). The
// plugin adds the ticket's and the owner's current state (server/small-route.ts).
export function routeRefusals(facts: RouteFacts): string[] {
  const reasons = [
    facts.acceptanceCriteria > 1 && facts.expectedChangedLines > SMALL_ROUTE_MAX_LINES ? `${facts.acceptanceCriteria} acceptance criteria and about ${facts.expectedChangedLines} changed lines (more than one criterion needs ${SMALL_ROUTE_MAX_LINES} lines or fewer)` : "",
    facts.acceptanceCriteria === 0 ? "no acceptance criterion" : "",
    facts.reversibility !== "revert" ? `reversibility is ${facts.reversibility}, not a revert` : "",
    ...FLAGS.map((name) => (facts[name] ? FLAG_TEXT[name] : "")),
  ].filter(Boolean);
  const required = strongRequired(routeRisk(facts));
  if (facts.tier !== "strong" && required) reasons.push(`the ${facts.tier} tier is not allowed (${required}): take strong`);
  return reasons;
}

// The conditions, for the planner's instructions and the tool's description.
export function smallRouteNote(): string {
  return [
    `Small-ticket route: you may skip the plan review with the \`${SMALL_ROUTE_TOOL}\` tool when every one of these holds, and only then:`,
    `- one acceptance criterion, or about ${SMALL_ROUTE_MAX_LINES} changed lines at most in total;`,
    "- no database migration, no login or permission change, nothing touching money or the ERP, no contract other packages build on;",
    "- no new rule and no question or decision for the owner;",
    "- your impact rating (0-4, as in `## Risk and impact`) is within the owner's auto-approval threshold, and a revert undoes it;",
    "- the model tier follows the `## Model` rules (above impact 2, or anything a revert does not undo, takes strong).",
    "Investigate first, then call the tool with the facts. The plugin checks them again with the ticket and the owner's settings; when it accepts, you leave planning and implement on the tier you named, with no plan document. The pull request body's `Reach:` and `Principles and rules:` bullets are then the plan. When the tool refuses, write and submit a plan as usual. If in doubt, plan.",
  ].join("\n");
}

// A route attempt's decision (`<routeId>.decision`, written once by whichever side is first).
export type RouteDecision = { decision: "accepted" } | { decision: "refused"; reason: string } | { decision: "cancelled"; reason: string };

export function decisionText(decision: RouteDecision, by: "plugin" | "tool"): string {
  return `${JSON.stringify({ ...decision, by, at: new Date().toISOString() })}\n`;
}

// null: unreadable, which never counts as accepted.
export function parseDecision(raw: string): RouteDecision | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { decision, reason } = value as Record<string, unknown>;
  if (decision === "accepted") return { decision };
  if ((decision === "refused" || decision === "cancelled") && typeof reason === "string") return { decision, reason };
  return null;
}
