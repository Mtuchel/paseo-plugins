// The one-time correction for the plan stages (README, "Statuses and labels"; TUC-1289), run per
// host through scripts/plan-stages-migration.ts. Every subcommand lists first and writes only with
// `apply`; before each write it reads the ticket again and skips it when its status or labels
// changed since the listing, so a rerun after an interrupted apply skips what is done and finishes
// the rest.
//
// - stages: tickets in Planning or Plan review, or with `plan-ready` before work started, get the
//   plan stage this host's evidence proves (a parked plan or an open own review: Plan review; a
//   queued thread with `plan-ready`: Plan approved). Missing evidence never moves a ticket: the
//   other host may own it.
// - review-victims: tickets a Paseo app moved into Plan review before the cutoff (the review-move
//   defect fixed in PR #171) that carry a pull request and have no review on this host. Listed for
//   a check by hand; only the identifiers named with apply move to In Review.
// - model-labels: issues with two or more `model:` labels keep the strongest; then the three labels
//   join the `model` group (only once both hosts run the one-write tier swap), or leave it again.
import type { LabeledTicket, LinearService, StateMove, StewardIssue } from "./linear";
import { labelTier, TIER_GROUP, TIER_LABELS } from "./model-tiers";
import { hasLabel, PLAN_APPROVED_STATE, PLAN_READY_LABEL, PLAN_REVIEW_STATE, PLANNING_STATE, planStage, type PlanStage } from "./plan-policy";
import { TIERS } from "../shared/plan-model";

export type MigrationLinear = Pick<LinearService,
  "stewardIssues" | "issueCore" | "moveToPlanStage" | "moveToReview" | "stateMoves" | "trustedAppIds" | "issuesWithLabels" | "changeLabels" | "labelCatalog" | "createLabel" | "moveLabelIntoGroup" | "moveLabelOutOfGroup">;

// What this host knows about a ticket. `reviewAgent`: the agent whose own review is open (it is
// live while it waits, so it is no other agent working on the ticket).
export type HostEvidence = {
  parked: (issueId: string) => Promise<boolean>;
  review: (issueId: string) => Promise<{ agentId: string | null } | null>;
  queued: (issueId: string) => Promise<boolean>;
  liveAgents: (issueId: string) => Promise<string[]>;
};

type Listed = Pick<StewardIssue, "id" | "identifier" | "status" | "statusType" | "labels">;
export type StageRow = { identifier: string; status: string; evidence: string[]; verdict: string; target: PlanStage | null; result?: string };

const BEFORE_WORK = new Set(["triage", "backlog", "unstarted"]);
const labelKey = (labels: { name: string }[]) => labels.map((item) => item.name.trim().toLowerCase()).sort().join(",");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Whether the ticket still looks as listed: same status, same labels.
async function unchanged(linear: Pick<MigrationLinear, "issueCore">, ticket: Listed): Promise<string | null> {
  const now = await linear.issueCore(ticket.id);
  if (now.status !== ticket.status) return `skipped: status changed to ${now.status} since the listing`;
  if (labelKey(now.labels) !== labelKey(ticket.labels)) return "skipped: labels changed since the listing";
  return null;
}

export async function stageVerdict(ticket: Listed, host: HostEvidence): Promise<StageRow> {
  const stage = planStage(ticket.status, ticket.statusType);
  const parked = await host.parked(ticket.id);
  const review = await host.review(ticket.id);
  const queued = await host.queued(ticket.id);
  const ready = hasLabel(ticket.labels, PLAN_READY_LABEL);
  const others = (await host.liveAgents(ticket.id)).filter((agentId) => agentId !== review?.agentId);
  const evidence = [
    ...parked ? ["parked plan"] : [], ...review ? [`open review${review.agentId ? ` (${review.agentId})` : ""}`] : [],
    ...ready ? [PLAN_READY_LABEL] : [], ...queued ? ["queued thread"] : [], ...others.map((agentId) => `live agent ${agentId}`),
  ];
  const row = (verdict: string, target: PlanStage | null = null): StageRow => ({ identifier: ticket.identifier, status: ticket.status, evidence, verdict, target });
  const reviewing = parked || Boolean(review);
  const approved = ready || queued;
  if (reviewing && approved) return row("unresolved - review and approval evidence conflict");
  if (others.length) return row("unresolved - an agent works on the ticket");
  if (stage === PLAN_REVIEW_STATE) return reviewing ? row("correct - waits for the owner's review") : row("unresolved - no review on this host");
  if (stage === PLAN_APPROVED_STATE) return ready && queued ? row("correct - a queued thread takes it over") : row("unresolved - no queued thread with plan-ready on this host");
  if (stage === PLANNING_STATE && reviewing) return row(`move to ${PLAN_REVIEW_STATE}`, PLAN_REVIEW_STATE);
  if ((stage === PLANNING_STATE || BEFORE_WORK.has(ticket.statusType.trim().toLowerCase())) && ready && queued) return row(`move to ${PLAN_APPROVED_STATE}`, PLAN_APPROVED_STATE);
  return row("unresolved - no evidence on this host");
}

export async function runStages(input: { linear: MigrationLinear; host: HostEvidence; teamKeys: string[]; apply: boolean }): Promise<StageRow[]> {
  const found = await input.linear.stewardIssues({ labels: [PLAN_READY_LABEL], teamKeys: input.teamKeys, ids: [], appIds: [], states: [PLANNING_STATE, PLAN_REVIEW_STATE, PLAN_APPROVED_STATE] });
  const tickets = found.filter((ticket) => planStage(ticket.status, ticket.statusType) || (BEFORE_WORK.has(ticket.statusType.trim().toLowerCase()) && hasLabel(ticket.labels, PLAN_READY_LABEL)))
    .sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
  const rows: StageRow[] = [];
  for (const ticket of tickets) {
    const row = await stageVerdict(ticket, input.host);
    if (input.apply && row.target) {
      try {
        const changed = await unchanged(input.linear, ticket);
        if (changed) row.result = changed;
        else {
          const moved = await input.linear.moveToPlanStage(ticket.id, row.target);
          row.result = moved.changed ? `moved to ${moved.moved ?? row.target}` : `not moved${moved.note ? `: ${moved.note}` : ""}`;
        }
      } catch (error) { row.result = `failed: ${message(error)}`; }
    }
    rows.push(row);
  }
  return rows;
}

export type VictimRow = { identifier: string; movedAt: string; pullRequests: string[]; result?: string };

// Tickets one of the Paseo apps (this host's or the peer's) moved into Plan review before `cutoff`,
// with a pull request attached and no parked plan or open review on this host. `apply`: the
// identifiers to move to In Review; any other identifier is refused.
export async function runReviewVictims(input: { linear: MigrationLinear; host: Pick<HostEvidence, "parked" | "review">; teamKeys: string[]; cutoff: string; apply: string[] }): Promise<{ rows: VictimRow[]; refused: string[] }> {
  const apps = new Set(await input.linear.trustedAppIds());
  if (!apps.size) throw new Error("The Paseo app's Linear user is unknown on this host, so no move can be attributed to it.");
  const found = await input.linear.stewardIssues({ labels: [PLAN_READY_LABEL], teamKeys: input.teamKeys, ids: [], appIds: [], states: [PLAN_REVIEW_STATE] });
  const rows: VictimRow[] = [];
  const named = new Set(input.apply.map((identifier) => identifier.trim().toUpperCase()));
  for (const ticket of found.filter((item) => planStage(item.status, item.statusType) === PLAN_REVIEW_STATE).sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))) {
    if (await input.host.parked(ticket.id) || await input.host.review(ticket.id)) continue;
    const core = await input.linear.issueCore(ticket.id);
    const pullRequests = core.attachmentUrls.filter((url) => /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(url));
    if (!pullRequests.length) continue;
    const entered = (move: StateMove) => planStage(move.status, move.statusType) === PLAN_REVIEW_STATE;
    const move = (await input.linear.stateMoves(ticket.id, entered)).find(entered);
    if (!move || !move.actorId || !apps.has(move.actorId) || move.at >= input.cutoff) continue;
    const row: VictimRow = { identifier: ticket.identifier, movedAt: move.at, pullRequests };
    if (named.has(ticket.identifier.toUpperCase())) {
      named.delete(ticket.identifier.toUpperCase());
      try {
        const changed = await unchanged(input.linear, ticket);
        if (changed) row.result = changed;
        else {
          const moved = await input.linear.moveToReview(ticket.id);
          row.result = moved.changed ? "moved to In Review" : `not moved${moved.note ? `: ${moved.note}` : ""}`;
        }
      } catch (error) { row.result = `failed: ${message(error)}`; }
    }
    rows.push(row);
  }
  return { rows, refused: [...named] };
}

export type TierRow = { identifier: string; status: string; labels: string[]; keep: string; result?: string };
export type ModelLabelsReport = { duplicates: TierRow[]; group: string[] };

const tierName = (name: string) => TIERS.find((tier) => TIER_LABELS[tier] === name.trim().toLowerCase()) ?? null;

// `apply`: remove the extra tier labels, then group (only with `hostsReady`, and only when no
// duplicate is left). `ungroup`: take the tier labels out of the `model` group again.
export async function runModelLabels(input: { linear: MigrationLinear; apply: boolean; hostsReady: boolean; ungroup: boolean }): Promise<ModelLabelsReport> {
  const { linear } = input;
  const group: string[] = [];
  const catalog = await linear.labelCatalog();
  const modelGroup = catalog.find((item) => item.isGroup && !item.teamId && item.name.trim().toLowerCase() === TIER_GROUP) ?? null;
  const tierLabels = catalog.filter((item) => !item.isGroup && tierName(item.name));
  if (input.ungroup) {
    const grouped = modelGroup ? tierLabels.filter((item) => item.parentId === modelGroup.id) : [];
    if (!grouped.length) group.push("nothing to ungroup: no tier label is in the model group");
    for (const item of grouped) {
      if (!input.apply) { group.push(`would move ${item.name} out of the model group`); continue; }
      await linear.moveLabelOutOfGroup(item.id, item.name);
      group.push(`moved ${item.name} out of the model group`);
    }
    return { duplicates: [], group };
  }
  const tickets: LabeledTicket[] = await linear.issuesWithLabels(Object.values(TIER_LABELS));
  // A workspace label is kept before a team label of the same name: only it joins the group.
  const workspaceIds = new Set(tierLabels.filter((item) => !item.teamId).map((item) => item.id));
  const duplicates: TierRow[] = [];
  for (const ticket of tickets.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))) {
    const tiers = ticket.labels.filter((item) => tierName(item.name));
    if (tiers.length < 2) continue;
    const keep = labelTier(tiers)!;
    const strongest = tiers.filter((item) => tierName(item.name) === keep);
    const kept = strongest.find((item) => workspaceIds.has(item.id)) ?? strongest[0];
    const row: TierRow = { identifier: ticket.identifier, status: ticket.status, labels: tiers.map((item) => item.name), keep: TIER_LABELS[keep] };
    if (input.apply) {
      try {
        const changed = await unchanged(linear, ticket);
        if (changed) row.result = changed;
        else {
          await linear.changeLabels(ticket.id, [], tiers.filter((item) => item.id !== kept.id).map((item) => item.id));
          row.result = `kept ${TIER_LABELS[keep]}`;
        }
      } catch (error) { row.result = `failed: ${message(error)}`; }
    }
    duplicates.push(row);
  }
  const outside = tierLabels.filter((item) => !modelGroup || item.parentId !== modelGroup.id);
  const teamLabels = outside.filter((item) => item.teamId);
  for (const item of teamLabels) group.push(`left alone: ${item.name} is a team label (${item.teamId}); a workspace group cannot hold it`);
  const workspace = outside.filter((item) => !item.teamId);
  if (!workspace.length) { group.push(modelGroup ? "already grouped: every workspace tier label is in the model group" : "no workspace tier label to group"); return { duplicates, group }; }
  const pending = duplicates.filter((row) => !input.apply || !row.result?.startsWith("kept "));
  if (!input.apply) group.push(`would ${modelGroup ? "use" : "create"} the model group and move ${workspace.map((item) => item.name).join(", ")} into it (needs --hosts-ready)`);
  else if (!input.hostsReady) group.push("not grouped: --hosts-ready is missing (both hosts must run the one-write tier swap first)");
  else if (pending.length) group.push(`not grouped: ${pending.map((row) => row.identifier).join(", ")} still carry two tier labels`);
  else {
    const groupId = modelGroup?.id ?? await linear.createLabel({ name: TIER_GROUP, isGroup: true });
    if (!modelGroup) group.push("created the model group");
    for (const item of workspace) {
      await linear.moveLabelIntoGroup(item.id, groupId, item.name);
      group.push(`moved ${item.name} into the model group`);
    }
  }
  return { duplicates, group };
}

export function renderStages(rows: StageRow[], apply: boolean): string {
  if (!rows.length) return "No ticket in Planning, Plan review, Plan approved, or with plan-ready before work started.";
  const lines = rows.map((row) => `${row.identifier} | ${row.status} | ${row.evidence.join(", ") || "-"} | ${row.verdict}${row.result ? ` | ${row.result}` : ""}`);
  return [`${apply ? "Applied" : "Dry run (nothing written)"}: ${rows.filter((row) => row.target).length} to move, ${rows.filter((row) => row.verdict.startsWith("unresolved")).length} unresolved.`, "ticket | status | evidence | verdict | result", ...lines].join("\n");
}

export function renderVictims(report: { rows: VictimRow[]; refused: string[] }, cutoff: string): string {
  const lines = report.rows.map((row) => `${row.identifier} | moved into Plan review ${row.movedAt} | ${row.pullRequests.join(" ")}${row.result ? ` | ${row.result}` : ""}`);
  return [
    `Plan review tickets a Paseo app moved there before ${cutoff}, with a pull request and no review on this host: ${report.rows.length}. Check each in the review inbox and on its agent before naming it with --apply.`,
    ...lines,
    ...report.refused.length ? [`refused (not a candidate): ${report.refused.join(", ")}`] : [],
  ].join("\n");
}

export function renderModelLabels(report: ModelLabelsReport, apply: boolean): string {
  return [
    `${apply ? "Applied" : "Dry run (nothing written)"}: ${report.duplicates.length} issue(s) with two or more tier labels.`,
    ...report.duplicates.map((row) => `${row.identifier} | ${row.status} | ${row.labels.join(", ")} | keep ${row.keep}${row.result ? ` | ${row.result}` : ""}`),
    ...report.group,
  ].join("\n");
}
