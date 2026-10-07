// Who plans before coding (README, "Plan-first"). Shared by the launch paths, write-back, the
// Plannotator bridge and the mid-run plan requests; the omp extension
// (omp/linear-tickets-plan-first.ts) reads the policy from PLAN_POLICY_ENV.

import { advisorSteps } from "../shared/plan-advisor";
import { sectionSteps } from "../shared/plan-sections";

// Plan-first modes where the provider's plan mode lets the planner read without asking. omp has
// none: its "write" mode asks before every shell command, reads included, so the planner would
// wait on the owner from its first `git status`. omp keeps the usual mode; the plugin's omp
// extension (omp/linear-tickets-plan-first.ts) starts it in Plannotator's planning phase instead.
export const SAFE_MODES: Record<string, string> = { claude: "plan", codex: "auto" };
// Every ticket plans first (README, "Plan-first"); the risk policy approves plans within the
// owner's threshold, the owner the rest.
export const PLAN_REQUIRED_NOTE = "Every ticket gets a plan first. Investigate and write a plan; do not change code until it is approved, by the owner or automatically when its risk rating is within the owner's threshold. Keep the plan as short as the ticket allows: a one-line fix needs a few lines of plan, not a document.";
// Every plan a ticket agent writes gets a second opinion before the owner sees it (README, "Plan
// advisor"). omp planners have the extension's record tool and submission gate.
export function advisorNote(providerKey: string): string {
  return advisorSteps({ omp: providerKey === "omp" });
}
// Every ticket plan says where else the change applies and which rules it follows or sets
// (README, "Plan-first"); the omp extension's record gate reads the same format.
export const PLAN_SECTIONS_NOTE = sectionSteps();

// Marks a ticket whose plan is approved (TUC-9's feedback intake reads it as "planned").
export const PLAN_READY_LABEL = "plan-ready";
// Ticket label the owner sets while an agent works: `plan` sends it back to planning (see
// plan-requests.ts).
export const PLAN_LABEL = "plan";
// The agent label and provider environment variable carrying the policy.
export const PLAN_POLICY_LABEL = "linear.plan";
export const PLAN_POLICY_ENV = "LINEAR_TICKETS_PLAN";
// Every ticket agent carries its ticket identifier here; the omp extension gates plan submission
// on the plan advisor's review for these agents (README, "Plan advisor").
export const PLAN_TICKET_ENV = "LINEAR_TICKETS_ISSUE";
// Path of the ticket prompt the agent was started with, when the launch could save it. The plan
// advisor reads it so both models plan from the same ticket context.
export const PLAN_CONTEXT_ENV = "LINEAR_TICKETS_CONTEXT";
// "required": the agent plans first; the plan is approved by the owner or by the risk policy.
export type PlanPolicy = "required";

export function isPlanPolicy(value: unknown): value is PlanPolicy {
  return value === "required";
}

export function hasLabel(labels: { name: string }[], name: string): boolean {
  return labels.some((item) => item.name.trim().toLowerCase() === name);
}

// Every ticket plans first (README, "Plan-first"); only a ticket whose plan is already approved
// (plan-ready) is implemented straight away. null: no planning.
export function planPolicy(labels: { name: string }[]): PlanPolicy | null {
  return hasLabel(labels, PLAN_READY_LABEL) ? null : "required";
}
