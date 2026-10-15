import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { questionKey, questionsOf } from "./relay";

// Structural/trust eligibility only. Consequences belong to semantic evaluation of
// the selected action, not keyword matches across the question and rejected options.

export const RISK_CATEGORIES = [
  "business-decision",
  "user-facing-wording",
  "production-data",
  "external-accounts-or-spend",
  "security-or-permissions",
  "deleting-data-or-history",
  "irreversible",
  "destructive-git",
  "owner-reserved",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];


// The label omp adds for free text ("Other (type your own)"): the deputy never writes free text.
export const FREE_TEXT_OPTION = /^\s*other\b.*\btype\b.*$/i;

export type RiskFacts = {
  // The ticket was written by the owner (or the Paseo app in a flow they started) and is not
  // feedback: the same trust rule the launch uses (starter.ts isUntrusted).
  trusted: boolean;
  // Context, not a blanket veto: planning and attended questions can still be technical.
  planning: boolean;
  attended: boolean;
};

// `effects`: what an option says it does (its description), by label; the evaluator rates those
// too, not just the labels.
export type Part = { key: string; question: string; options: string[]; effects: Record<string, string> };
export type RiskVerdict = { ok: true; parts: Part[] } | { ok: false; category: "not-a-question" | "untrusted" | "free-text" | "unsupported"; reason: string };


export function assessRisk(request: AgentPermissionRequest, facts: RiskFacts): RiskVerdict {
  if (request.kind !== "question") return { ok: false, category: "not-a-question", reason: "only question requests can be delegated; tool, plan and mode approvals stay with the owner" };
  if (!facts.trusted) return { ok: false, category: "untrusted", reason: "the ticket was not written by the owner" };
  const items = questionsOf(request);
  if (!items.length) return { ok: false, category: "unsupported", reason: "the question offers no structured options" };
  const parts: Part[] = [];
  for (const [index, item] of items.entries()) {
    const extra = item as { multiSelect?: boolean; multiple?: boolean; allowEmpty?: boolean };
    const flag = (name: keyof typeof extra) => extra[name] === true;
    if (flag("multiSelect") || flag("multiple")) return { ok: false, category: "unsupported", reason: "multiple-choice selections are not delegated" };
    // An optional empty follow-up (omp's "Optional comment") stays empty; a required free-text
    // part leaves the whole request with the owner.
    if (!item.options?.length && flag("allowEmpty")) continue;
    const offered = (item.options ?? []).map((option) => ({ label: option.label ?? "", effect: "description" in option && typeof option.description === "string" ? option.description.trim() : "" }))
      .filter((option) => option.label.trim() && !FREE_TEXT_OPTION.test(option.label));
    if (new Set(offered.map((option) => option.label.trim())).size !== offered.length) return { ok: false, category: "unsupported", reason: "option labels must be unique" };
    const options = offered.map((option) => option.label);
    if (options.length < 2) return { ok: false, category: "free-text", reason: "a required part has no choice of options to decide between" };
    if (parts.some((part) => part.key === questionKey(item, index))) return { ok: false, category: "unsupported", reason: "question keys must be unique" };
    const effects = Object.fromEntries(offered.filter((option) => option.effect).map((option) => [option.label, option.effect]));
    parts.push({ key: questionKey(item, index), question: [item.header, item.question].filter(Boolean).join(": "), options, effects });
  }
  if (!parts.length) return { ok: false, category: "free-text", reason: "nothing in the request can be answered by picking an option" };
  return { ok: true, parts };
}
