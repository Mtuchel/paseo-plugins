// Who plans before coding (README, "Plan-first"). Shared by the launch paths, write-back, the
// Plannotator bridge and the mid-run plan requests; the omp extension
// (omp/linear-tickets-plan-first.ts) reads the policy from PLAN_POLICY_ENV.

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
