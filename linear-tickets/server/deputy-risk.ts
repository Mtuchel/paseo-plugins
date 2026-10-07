import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { questionKey, questionsOf } from "./relay";

// Risk first (README, "Deputy for agent questions"): a question reaches the knowledge search and
// the evaluator only when nothing about it, its options or its ticket is in a category the owner
// keeps. These rules are the floor; the evaluator also rates the risk, and anything but "low"
// from it leaves the question with the owner too. Unknown risk counts as high.

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

// Words that put a question in a category, matched on the request's title, description, every
// question and every option (label and description), in English and German. Deliberately broad:
// a refused question waits for the owner exactly as before, a wrongly answered one does not.
const RULES: Record<RiskCategory, RegExp> = {
  "business-decision": /\b(?:who (?:may|can|should|decides|is allowed)|business|pricing|prices?|discounts?|customers?|suppliers?|carriers?|vendors?|contracts?|tax|vat|invoices?|orders?|stock|warehouse|purchas\w*|sales|quality|policy|legal|gdpr|compliance|requirements?|acceptance criteria|scope|priorit\w*|preis\w*|rabatt\w*|kunde\w*|lieferant\w*|vertr(?:a|ä)g\w*|steuer\w*|rechnung\w*|auftr(?:a|ä)g\w*|bestell\w*|lager\w*|einkauf\w*|verkauf\w*|qualit(?:ä|a)t\w*)\b/i,
  "user-facing-wording": /\b(?:wording|copy|phrasing|text (?:of|for)|label text|button|layout|design|styl(?:e|ing)|colou?rs?|fonts?|icons?|translation|translate|german|english|ui|ux|screen|page|dialog|e-?mail text|beschriftung\w*|formulierung\w*|übersetz\w*|oberfl(?:ä|a)che)\b/i,
  "production-data": /\b(?:production|prod|live (?:data|database|system)|real data|customer data|backfill|data ?fix|migrat\w* (?:the )?data|seed (?:prod|live)|produktiv\w*|echtdaten)\b/i,
  "external-accounts-or-spend": /\b(?:billing|payments?|pay|paid|spend\w*|costs?|budget|subscriptions?|purchase|buy|credits?|quota|upgrade (?:the )?plan|accounts? (?:creation|signup)|sign ?up|vendor accounts?|third[- ]party accounts?|api keys?|usage (?:fees?|charges?)|provider usage|kosten|bezahl\w*|abo\w*)\b/i,
  "security-or-permissions": /\b(?:security|secure|permissions?|authori[sz]\w*|authenticat\w*|auth|roles?|rights|access|secrets?|tokens?|credentials?|passwords?|encrypt\w*|rls|cors|csrf|sudo|chmod|firewall|exposure|expose|public(?:ly)?|berechtigung\w*|rechte|zugriff\w*|rolle\w*)\b/i,
  "deleting-data-or-history": /\b(?:delet\w*|remov\w* (?:the )?(?:data|records?|rows?|files?|history|issues?|tickets?|comments?|branch\w*)|drop(?:s|ped|ping)? (?:the )?(?:table|column|database|index)\w*|truncat\w*|purg\w*|wip\w*|eras\w*|destroy\w*|clean ?up (?:data|history)|l(?:ö|o)sch\w*|entfern\w*)\b/i,
  "irreversible": /\b(?:irreversibl\w*|cannot be undone|can't be undone|no way back|permanent(?:ly)?|one-way|unwiderruflich\w*|endg(?:ü|u)ltig\w*)\b/i,
  "destructive-git": /\b(?:force[- ]?push\w*|push --force|--force(?:-with-lease)?|reset --hard|git clean|rebas\w*|rewrit\w* (?:the )?history|amend|filter-branch|delete (?:the )?branch|push (?:directly )?to main|merg\w*|squash\w*|revert\w*|cherry-pick\w*|tags?)\b/i,
  // What the launch template, AGENTS.md and the plugin README reserve for the owner: approvals,
  // pushes and labels, secrets and settings, manual steps, plans and anything sent outside.
  "owner-reserved": /\b(?:approv\w*|push\w*|labels?|settings?|config\w*|environment variables?|env vars?|manual (?:step|task)s?|do-not-merge|plans?|planning|deploy\w*|releas\w*|publish\w*|send (?:an? )?(?:e-?mail|message|mail|notification)|notify|webhooks?|railway|linear|github|slack|owner|your (?:decision|call|choice|approval)|freigab\w*)\b/i,
};

// The label omp adds for free text ("Other (type your own)"): the deputy never writes free text.
export const FREE_TEXT_OPTION = /^\s*other\b.*\btype\b.*$/i;

export type RiskFacts = {
  // The ticket was written by the owner (or the Paseo app in a flow they started) and is not
  // feedback: the same trust rule the launch uses (starter.ts isUntrusted).
  trusted: boolean;
  // The agent is planning (its plan is not approved yet): planning questions decide the plan.
  planning: boolean;
  // The ticket carries the `<trigger>-attended` label: the project planner expects the owner.
  attended: boolean;
};

// `effects`: what an option says it does (its description), by label; the evaluator rates those
// too, not just the labels.
export type Part = { key: string; question: string; options: string[]; effects: Record<string, string> };
export type RiskVerdict = { ok: true; parts: Part[] } | { ok: false; category: RiskCategory | "not-a-question" | "untrusted" | "planning" | "attended" | "free-text" | "unsupported"; reason: string };

// Every text the request shows, the effects of each offered choice included.
function requestTexts(request: AgentPermissionRequest): string[] {
  const texts = [request.title ?? "", request.name ?? "", request.description ?? ""];
  for (const item of questionsOf(request)) {
    texts.push(item.header ?? "", item.question ?? "");
    for (const option of item.options ?? []) texts.push(option.label ?? "", "description" in option && typeof option.description === "string" ? option.description : "");
  }
  return texts.filter(Boolean);
}

export function assessRisk(request: AgentPermissionRequest, facts: RiskFacts): RiskVerdict {
  if (request.kind !== "question") return { ok: false, category: "not-a-question", reason: "only question requests can be delegated; tool, plan and mode approvals stay with the owner" };
  if (!facts.trusted) return { ok: false, category: "untrusted", reason: "the ticket was not written by the owner" };
  if (facts.planning) return { ok: false, category: "planning", reason: "questions while a plan is written decide the plan and stay with the owner" };
  if (facts.attended) return { ok: false, category: "attended", reason: "the ticket is marked attended: its decisions are left to the owner" };
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
    const offered = (item.options ?? []).map((option) => ({ label: option.label?.trim() ?? "", effect: "description" in option && typeof option.description === "string" ? option.description.trim() : "" }))
      .filter((option) => option.label && !FREE_TEXT_OPTION.test(option.label));
    const options = offered.map((option) => option.label);
    if (options.length < 2) return { ok: false, category: "free-text", reason: "a required part has no choice of options to decide between" };
    const effects = Object.fromEntries(offered.filter((option) => option.effect).map((option) => [option.label, option.effect]));
    parts.push({ key: questionKey(item, index), question: [item.header, item.question].filter(Boolean).join(": "), options, effects });
  }
  if (!parts.length) return { ok: false, category: "free-text", reason: "nothing in the request can be answered by picking an option" };
  const text = requestTexts(request).join("\n");
  for (const category of RISK_CATEGORIES) {
    const match = RULES[category].exec(text);
    if (match) return { ok: false, category, reason: `mentions “${match[0]}” (${category.replace(/-/g, " ")})` };
  }
  return { ok: true, parts };
}
