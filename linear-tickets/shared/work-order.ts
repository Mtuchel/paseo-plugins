// One line of a plan's fenced order block (README, "Projects" and "Related work").
// `project-order` is a planner run's work order; `related-work` is a ticket plan's list of related
// tickets that the approval writes into Linear. No Node imports: the omp extension and Paseo's
// shared bundle may import it.
//
// A reason may follow the tickets after `:`, `(`, `#` or a dash, and a line may end in a period;
// anything else (`and TUC-3`, a list) makes the line unreadable rather than half-read. Unreadable
// lines are left out of `parseOrder`/`parseRelatedWork` and reported by `blockProblems`.

import { hasSection, RELATED_WORK_SECTION } from "./plan-sections";

export const WORK_ORDER_TAG = "project-order";
export const RELATED_WORK_TAG = "related-work";
export const WORK_ORDER_KINDS: Record<string, true> = { blocks: true, duplicates: true, relates: true, hold: true, release: true, attended: true, unattended: true };
// A ticket plan may link its own ticket, close a ticket nobody works on as its duplicate, and ask
// another ticket's approved plan to be revised. It may not put tickets on hold: that stays the
// project planner's job.
export const RELATED_WORK_KINDS: Record<string, true> = { blocks: true, duplicates: true, relates: true, replan: true };

export type WorkOrderStep = { kind: "blocks"; blocker: string; blocked: string }
  | { kind: "duplicates" | "relates"; ticket: string; other: string; reason: string }
  | { kind: "hold" | "release" | "attended" | "unattended"; ticket: string; reason: string }
  | { kind: "replan"; ticket: string; reason: string };

const TICKET = "[A-Z][A-Z0-9]*-\\d+";
const BLOCKS_LINE = new RegExp(`^(${TICKET})\\s+blocks\\s+(${TICKET})\\s*(?:\\.?$|[:(#]|[—–-]\\s)`, "i");
// `related` and `related to` are accepted for `relates to`; every line reads as the same kind, so
// the done keys of an applied plan stay stable.
const LINK_LINE = new RegExp(`^(${TICKET})\\s+(duplicates|relates\\s+to|related(?:\\s+to)?)\\s+(${TICKET})\\s*(?:\\.?$|[:—–-]\\s*(.*)$)`, "i");
const MARK_LINE = new RegExp(`^(hold|release|attended|unattended)\\s+(${TICKET})\\s*(?:\\.?$|[:—–-]\\s*(.*)$)`, "i");
const REPLAN_LINE = new RegExp(`^replan\\s+(${TICKET})\\s*(?:\\.?$|[:—–-]\\s*(.*)$)`, "i");

// The text of the plan's fenced ```tag block; null when the plan has none.
export function parseBlock(plan: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("```" + escaped + "\\s*\\n([\\s\\S]*?)```", "i").exec(plan)?.[1] ?? null;
}

// A block's lines without bullets or blank lines.
export function blockLines(block: string): string[] {
  return block.split("\n").map((item) => item.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
}

// One line of either block, or null when it is not exactly one change.
export function stepOf(line: string): WorkOrderStep | null {
  const blocks = BLOCKS_LINE.exec(line);
  if (blocks) return { kind: "blocks", blocker: blocks[1].toUpperCase(), blocked: blocks[2].toUpperCase() };
  const link = LINK_LINE.exec(line);
  if (link) return { kind: link[2].toLowerCase() === "duplicates" ? "duplicates" : "relates", ticket: link[1].toUpperCase(), other: link[3].toUpperCase(), reason: (link[4] ?? "").trim() };
  const replan = REPLAN_LINE.exec(line);
  if (replan) return { kind: "replan", ticket: replan[1].toUpperCase(), reason: (replan[2] ?? "").trim() };
  const mark = MARK_LINE.exec(line);
  return mark ? { kind: mark[1].toLowerCase() as "hold" | "release" | "attended" | "unattended", ticket: mark[2].toUpperCase(), reason: (mark[3] ?? "").trim() } : null;
}

// The canonical line of a change: the same text for the same change, whatever synonyms or reason
// whitespace the plan used. Saved records key their done steps by it.
export function orderLine(step: WorkOrderStep): string {
  if (step.kind === "blocks") return `${step.blocker} blocks ${step.blocked}`;
  const reason = step.reason ? `: ${step.reason}` : "";
  if (step.kind === "duplicates") return `${step.ticket} duplicates ${step.other}${reason}`;
  if (step.kind === "relates") return `${step.ticket} relates to ${step.other}${reason}`;
  if (step.kind === "replan") return `replan ${step.ticket}${reason}`;
  return `${step.kind} ${step.ticket}${reason}`;
}

// The ticket plan's ```related-work block (README, "Related work"), one change per line.
export function parseRelatedWork(plan: string): WorkOrderStep[] {
  return blockLines(parseBlock(plan, RELATED_WORK_TAG) ?? "").map(stepOf).filter((step): step is WorkOrderStep => step !== null);
}

// The approved work order's ```project-order block, one change per line: `TUC-1 blocks TUC-2`,
// `TUC-3 duplicates TUC-9: reason`, `TUC-4 relates to TUC-8: reason`, `hold TUC-3: reason`,
// `release TUC-4`, `attended TUC-5: reason`, `unattended TUC-6`. Unreadable lines are left out
// (see `blockProblems`).
export function parseOrder(plan: string): WorkOrderStep[] {
  return blockLines(parseBlock(plan, WORK_ORDER_TAG) ?? "").map(stepOf).filter((step): step is WorkOrderStep => step !== null);
}

// Why a submitted block cannot be applied as written: no block, lines that are not one change
// each, a kind this plan may not use, or (ticket plans, `own` given) a line that names two other
// tickets instead of the plan's own (D2). Empty when it can; an empty block is an order with no
// changes.
export function blockProblems(plan: string, tag: string, allowed: Record<string, true>, own?: string): string[] {
  const block = parseBlock(plan, tag);
  if (block === null) return [`The plan has no \`\`\`${tag} block.`];
  const noun = tag === WORK_ORDER_TAG ? "work-order change" : "related-work line";
  const problems: string[] = [];
  for (const line of blockLines(block)) {
    const step = stepOf(line);
    if (!step) { problems.push(`Not one ${noun}: "${line}"`); continue; }
    if (!allowed[step.kind]) {
      problems.push(step.kind === "replan" ? `A work order cannot ask for a replan: "${line}"` : `Not allowed in a ticket plan: "${line}"`);
      continue;
    }
    // A ticket plan may change only its own ticket's links; `replan` names the ticket whose plan
    // it asks to revise and names no link of this plan's.
    if (own && step.kind !== "replan") {
      const named = step.kind === "blocks" ? [step.blocker, step.blocked] : step.kind === "relates" || step.kind === "duplicates" ? [step.ticket, step.other] : [step.ticket];
      if (!named.includes(own)) problems.push(`Every line names ${own} except \`replan\`: "${line}"`);
    }
  }
  return problems;
}

// Why a submitted work order cannot be applied as written (see `blockProblems`).
export function orderProblems(plan: string): string[] {
  return blockProblems(plan, WORK_ORDER_TAG, WORK_ORDER_KINDS);
}

// Why a ticket plan's related work cannot be applied as written: a `## Related work` section
// without the block, or block lines that break D2 (see `blockProblems`). A plan with neither the
// section nor the block (one from before the rollout, carrying only `## Overlapping tickets`) is
// not sent back: the catch-up covers it.
export function relatedWorkProblems(plan: string, identifier: string): string[] {
  if (parseBlock(plan, RELATED_WORK_TAG) === null) {
    return hasSection(plan, RELATED_WORK_SECTION) ? [`The plan has a "## ${RELATED_WORK_SECTION}" section but no \`\`\`${RELATED_WORK_TAG} block.`] : [];
  }
  return blockProblems(plan, RELATED_WORK_TAG, RELATED_WORK_KINDS, identifier);
}
