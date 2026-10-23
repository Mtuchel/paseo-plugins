import type { LinearService } from "./linear";
import { CODING_STATE, planDocument, roundStep, type CatchUpHooks } from "./plannotator";
import { PLAN_READY_LABEL, PLAN_REWORK_LABEL } from "./plan-policy";
import { MAX_SPLIT, planSteps } from "./sessions";
import type { PlanFollowUps } from "./plan-follow-ups";
import type { PlanRelations } from "./plan-relations";
import { planTier, strongStepNumbers } from "../shared/plan-model";
import { writeTierLabel } from "./model-tiers";

// The decision worker's step guard (plannotator.ts): a step recorded as done is skipped, and a
// create reserves its Linear id first and is looked up by it before it is ever sent again.
export type Steps = {
  once<T>(name: string, work: () => Promise<T>): Promise<T>;
  created(name: string, lookup: (id: string) => Promise<boolean>, create: (id: string) => Promise<unknown>): Promise<void>;
  value<T>(name: string): T | undefined;
};

// What "Approve, implement later" and "Approve & split" do besides Linear: the Linear panel
// session (null without one), retiring the planner and finishing the decision.
export type PanelWork = {
  linear: Pick<LinearService, "issueState" | "createIssue" | "issueById" | "addBlocker" | "delegate" | "upsertIssueDocument" | "issueDocument" | "moveToStateNamed" | "moveToReady" | "addLabel" | "removeLabel" | "changeLabels" | "labelCatalog" | "createLabel">;
  appUserId: () => Promise<string | null>;
  followUps?: Pick<PlanFollowUps, "file">;
  relations?: Pick<PlanRelations, "file">;
  // The approval coordinator's outbox: the owner's approval is saved before its `Plan:` document
  // exists, and reported until the coordinator acknowledged it (README, "Plan risk and auto-approval").
  claims?: { ownerApproval(input: { issueId: string; identifier: string; plan: string; approvedAt: string }): Promise<void> };
  // The catch-up of older approved plans (related-catch-up.ts), when its plan is the one decided:
  // it is approved or sent back, never split, and its approval writes no ticket plan.
  catchUp?: Pick<CatchUpHooks, "isCatchUp" | "apply">;
  // When the planning round behind the approved plan began (README, "Related work").
  roundStartedAt: string | null;
  // The session is held first (offer "later" / "split"), so retiring the planner offers no Resume
  // and starts no agent while the decision is applied.
  session: {
    hold(offer: "later" | "split"): Promise<void>;
    group(): Promise<void>;
    clearReview(): Promise<void>;
    reply(body: string, id: string): Promise<void>;
    replied(id: string): Promise<boolean>;
  } | null;
  // Closes the review with a send-back (telling the agent why), stops the planner and archives it.
  retire(reason: string): Promise<void>;
  // A parked plan's record ends with the decision.
  unpark?: () => Promise<void>;
};

export type ApprovedPlan = { agentId: string | null; issueId: string; identifier: string; plan: string; model: string | null; at: string };

// A catch-up's plan holds per-ticket verdicts, not steps of its own, so there is nothing to split
// (related-catch-up.ts).
export const CATCH_UP_SPLIT = "a catch-up is approved or sent back, not split";
// What an approved catch-up's agent is told when it is retired: its result was the plan, not code.
export const CATCH_UP_RETIRE = "The owner approved this catch-up. Paseo applies it to the listed tickets: stop now and do not implement anything.";

async function approvedDocument(steps: Steps, work: PanelWork, decision: ApprovedPlan): Promise<string> {
  await steps.once("approval-outbox", () => work.claims?.ownerApproval({ issueId: decision.issueId, identifier: decision.identifier, plan: decision.plan, approvedAt: decision.at }) ?? Promise.resolve());
  const round = await roundStep(steps, work.linear, decision.issueId, decision.identifier);
  const documentUrl = await steps.once("document", () => work.linear.upsertIssueDocument(decision.issueId, `Plan: ${decision.identifier}`, planDocument({ type: "decided", agentId: decision.agentId, approved: true, planContent: decision.plan, at: decision.at }, decision.identifier, decision.model, round)));
  await steps.once("follow-ups", async () => { await work.followUps?.file({ issueId: decision.issueId, identifier: decision.identifier, plan: decision.plan, documentUrl: documentUrl || null }); });
  await steps.once("relations", async () => { await work.relations?.file({ issueId: decision.issueId, identifier: decision.identifier, plan: decision.plan, documentUrl: documentUrl || null, roundStartedAt: work.roundStartedAt }); });
  return documentUrl;
}

async function finish(steps: Steps, work: PanelWork, summary: string): Promise<void> {
  if (work.unpark) await steps.once("unpark", work.unpark);
  const session = work.session;
  if (!session) return;
  await steps.once("clear-review", () => session.clearReview());
  await steps.created("reply", (id) => session.replied(id), (id) => session.reply(summary, id));
}

// "Approve, implement later": the plan is approved and recorded, but nobody codes yet. The
// planner is retired, the ticket goes back to Todo with the plan-ready label (README, "Statuses
// and labels": Todo, not Plan approved, since nothing starts it until the owner does), and the
// next agent (assigned, labelled or a reply in this session) implements the plan instead of
// planning again.
export async function applyLater(steps: Steps, work: PanelWork, decision: ApprovedPlan): Promise<void> {
  if (work.session) await steps.once("hold", () => work.session!.hold("later"));
  // A catch-up has no ticket work to start later: its approval applies the plan to the listed
  // tickets and ends its agent here, so no ticket-plan step follows.
  const catchUp = work.catchUp;
  if (catchUp && await catchUp.isCatchUp(decision.issueId)) {
    await steps.once("catch-up", () => catchUp.apply(decision.issueId, decision.agentId, decision.plan));
    await steps.once("retire", () => work.retire(CATCH_UP_RETIRE));
    await finish(steps, work, "Catch-up approved. Paseo applies it to the listed tickets.");
    return;
  }
  const documentUrl = await approvedDocument(steps, work, decision);
  await steps.once("retire", () => work.retire("The owner approved this plan for later implementation by another agent. Stop now and do not implement anything."));
  await steps.once("ready", async () => {
    const moved = await work.linear.moveToReady(decision.issueId);
    if (moved.note) console.error(`[linear-tickets] ${decision.identifier}: ${moved.note}`);
  });
  await steps.once("plan-ready", async () => {
    await work.linear.addLabel(decision.issueId, PLAN_READY_LABEL);
    await work.linear.removeLabel(decision.issueId, PLAN_REWORK_LABEL);
  });
  await finish(steps, work, `Plan approved for later${documentUrl ? ` ([plan](${documentUrl}))` : ""}. The ticket is back in Todo with \`${PLAN_READY_LABEL}\`. Reply here, assign Paseo again or add the \`paseo\` label to implement it.`);
}

export function subIssueTitle(step: string): string {
  const plain = step.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  return plain.length <= 120 ? plain : `${plain.slice(0, 117).trimEnd()}…`;
}

// Why a plan cannot be split, checked before the decision is recorded; null when it can.
export function splitProblem(plan: string): string | null {
  const steps = planSteps(plan);
  if (steps.length < 2) return "The plan has fewer than two recognisable steps, so there is nothing to split. Approve it instead.";
  if (steps.length > MAX_SPLIT) return `The plan has ${steps.length} steps; at most ${MAX_SPLIT} sub-issues are created. Merge steps in the plan, or approve it as one ticket.`;
  return null;
}

// "Approve & split": the approved plan becomes the parent's plan document and each step a
// sub-issue assigned to Paseo. Each step is blocked by the one before, so the agents run one
// after another: a step starts when its predecessor is done (normally when its PR is merged).
// Each sub-issue plans again and picks its own model tier; a strong plan, or a step its `## Model`
// section names as strong, gets the `model:strong` label, which that plan cannot lower. Every
// sub-issue gets its Linear id before it is created, so a retry never creates a second one.
export async function applySplit(steps: Steps, work: PanelWork, decision: ApprovedPlan): Promise<void> {
  if (work.catchUp && await work.catchUp.isCatchUp(decision.issueId)) throw new Error(CATCH_UP_SPLIT);
  const planned = planSteps(decision.plan);
  const problem = splitProblem(decision.plan);
  if (problem) throw new Error(problem);
  if (work.session) await steps.once("hold", () => work.session!.hold("split"));
  const parent = await steps.once("parent", async () => {
    const state = await work.linear.issueState(decision.issueId);
    if (!state.teamId) throw new Error("The ticket has no team.");
    return { teamId: state.teamId, projectId: state.projectId ?? null };
  });
  const documentUrl = await approvedDocument(steps, work, decision);
  await steps.once("retire", () => work.retire("The owner split this plan into Linear sub-issues, each handled by its own agent. Stop now and do not implement anything."));
  const tier = planTier(decision.plan);
  const strongSteps = strongStepNumbers(tier?.strongSteps ?? null);
  const created: { id: string; identifier: string }[] = [];
  for (const [index, step] of planned.entries()) {
    const name = `sub-issue:${index + 1}`;
    await steps.created(name, async (id) => {
      const found = await work.linear.issueById(id);
      if (found) await steps.once(`${name}:issue`, async () => ({ id: found.id, identifier: found.identifier }));
      return Boolean(found);
    }, async (id) => {
      const issue = await work.linear.createIssue({
        id,
        teamId: parent.teamId,
        projectId: parent.projectId,
        parentId: decision.issueId,
        ready: true,
        title: subIssueTitle(step),
        description: [`Step ${index + 1} of ${planned.length} of ${decision.identifier}.`, `**This step:** ${step}`, `The full approved plan is in the parent's document${documentUrl ? `: ${documentUrl}` : "."} Only do this step.`].join("\n\n"),
      });
      await steps.once(`${name}:issue`, async () => ({ id: issue.id, identifier: issue.identifier }));
    });
    const issue = steps.value<{ id: string; identifier: string }>(`${name}:issue`)!;
    const previous = created.at(-1);
    if (previous) await steps.once(`blocker:${index + 1}`, () => work.linear.addBlocker(previous.id, issue.id));
    if (tier?.tier === "strong" || strongSteps.has(index + 1)) await steps.once(`tier-label:${index + 1}`, () => writeTierLabel(work.linear, issue.id, "strong", []));
    created.push(issue);
  }
  const appUserId = await work.appUserId();
  if (!appUserId) throw new Error("The Paseo app is not available, so the sub-issues cannot be assigned to it yet.");
  for (const [index, issue] of created.entries()) await steps.once(`delegate:${index + 1}`, () => work.linear.delegate(issue.id, appUserId));
  // The plan is approved; the work now runs in the sub-issues.
  await steps.once("state", async () => {
    const moved = await work.linear.moveToStateNamed(decision.issueId, CODING_STATE);
    if (moved.note) console.error(`[linear-tickets] ${decision.identifier}: ${moved.note}`);
  });
  await steps.once("plan-ready", async () => {
    await work.linear.addLabel(decision.issueId, PLAN_READY_LABEL);
    await work.linear.removeLabel(decision.issueId, PLAN_REWORK_LABEL);
  });
  // The steps are the parent's sub-issues now: the parent closes when they are finished.
  if (work.session) await steps.once("group", () => work.session!.group());
  await finish(steps, work, `Split into ${created.length} sub-issues (${created.map((issue) => issue.identifier).join(", ")}), assigned to Paseo. They run one after another; each starts when the one before it is done.`);
}
