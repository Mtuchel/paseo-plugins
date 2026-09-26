import type { PaseoApi } from "@getpaseo/client";
import type { LinearService } from "./linear";
import { CODING_STATE, planDocument } from "./plannotator";
import { MAX_SPLIT, planSteps } from "./sessions";

type Deps = {
  linear: Pick<LinearService, "issueState" | "createIssue" | "addBlocker" | "delegate" | "upsertIssueDocument" | "moveToStateNamed">;
  appUserId: () => Promise<string>;
  readPlan: (localUrl: string) => Promise<string>;
  // Closes the review without implementing, stops the planning agent and archives it.
  retirePlanner: (localUrl: string, agentId: string, paseo: PaseoApi) => Promise<void>;
};

export function subIssueTitle(step: string): string {
  const plain = step.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  return plain.length <= 120 ? plain : `${plain.slice(0, 117).trimEnd()}…`;
}

// "Approve & split": the approved plan becomes the parent's plan document and each step a
// sub-issue assigned to Paseo. Each step is blocked by the one before, so the agents run one
// after another: a step starts when its predecessor is done (normally when its PR is merged).
export async function splitIntoSubIssues(deps: Deps, link: { issueId: string; identifier: string; agentId: string | null }, localUrl: string, paseo: PaseoApi): Promise<string> {
  const planText = await deps.readPlan(localUrl);
  const steps = planSteps(planText);
  if (steps.length < 2) throw new Error("The plan has fewer than two recognisable steps, so there is nothing to split. Approve it instead.");
  if (steps.length > MAX_SPLIT) throw new Error(`The plan has ${steps.length} steps; at most ${MAX_SPLIT} sub-issues are created. Merge steps in the plan, or approve it as one ticket.`);
  const parent = await deps.linear.issueState(link.issueId);
  if (!parent.teamId) throw new Error("The ticket has no team.");
  const documentUrl = await deps.linear.upsertIssueDocument(link.issueId, `Plan: ${link.identifier}`, planDocument({ type: "decided", agentId: link.agentId, approved: true, planContent: planText, at: new Date().toISOString() }, link.identifier));
  if (link.agentId) await deps.retirePlanner(localUrl, link.agentId, paseo);
  const created: { id: string; identifier: string }[] = [];
  for (const [index, step] of steps.entries()) {
    const issue = await deps.linear.createIssue({
      teamId: parent.teamId,
      projectId: parent.projectId,
      parentId: link.issueId,
      ready: true,
      title: subIssueTitle(step),
      description: [`Step ${index + 1} of ${steps.length} of ${link.identifier}.`, `**This step:** ${step}`, `The full approved plan is in the parent's document${documentUrl ? `: ${documentUrl}` : "."} Only do this step.`].join("\n\n"),
    });
    const previous = created.at(-1);
    if (previous) await deps.linear.addBlocker(previous.id, issue.id);
    created.push(issue);
  }
  const appUserId = await deps.appUserId();
  for (const issue of created) await deps.linear.delegate(issue.id, appUserId);
  // The plan is approved; the work now runs in the sub-issues.
  const moved = await deps.linear.moveToStateNamed(link.issueId, CODING_STATE).catch((error: unknown) => ({ changed: false, note: error instanceof Error ? error.message : String(error) }));
  if (moved.note) console.error(`[linear-tickets] ${link.identifier}: ${moved.note}`);
  return `Split into ${created.length} sub-issues (${created.map((issue) => issue.identifier).join(", ")}), assigned to Paseo. They run one after another; each starts when the one before it is done.`;
}
