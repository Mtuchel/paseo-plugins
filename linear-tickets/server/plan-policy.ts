// Who plans before coding (README, "Plan-first"). Shared by the launch paths, write-back, the
// Plannotator bridge and the mid-run plan requests; the omp extension
// (omp/linear-tickets-plan-first.ts) reads the policy from PLAN_POLICY_ENV.

// Marks a ticket whose plan is approved (TUC-9's feedback intake reads it as "planned").
export const PLAN_READY_LABEL = "plan-ready";
// Ticket labels the owner sets: `plan` asks for a plan (also while an agent works, see
// plan-requests.ts), `no-plan` skips planning on a ticket the owner wrote.
export const PLAN_LABEL = "plan";
export const NO_PLAN_LABEL = "no-plan";
// The agent label and provider environment variable carrying the policy.
export const PLAN_POLICY_LABEL = "linear.plan";
export const PLAN_POLICY_ENV = "LINEAR_TICKETS_PLAN";
// "required": the agent plans and waits for the owner's approval. "agent": the agent decides.
export type PlanPolicy = "required" | "agent";

export function isPlanPolicy(value: unknown): value is PlanPolicy {
  return value === "required" || value === "agent";
}

export function hasLabel(labels: { name: string }[], name: string): boolean {
  return labels.some((item) => item.name.trim().toLowerCase() === name);
}

// Precedence: an approved plan (plan-ready) is implemented. A ticket someone else wrote, or from
// the feedback intake, always plans: its text must not be able to skip its own review, so
// `no-plan` does not apply to it. Then the `plan` label or the launch's "Plan first" toggle, then
// `no-plan`; otherwise the agent decides. null: no planning.
export function planPolicy(input: { untrusted: boolean; labels: { name: string }[]; planFirst?: boolean }): PlanPolicy | null {
  if (hasLabel(input.labels, PLAN_READY_LABEL)) return null;
  if (input.untrusted || input.planFirst || hasLabel(input.labels, PLAN_LABEL)) return "required";
  if (hasLabel(input.labels, NO_PLAN_LABEL)) return null;
  return "agent";
}
