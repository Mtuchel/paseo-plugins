// Where else a change applies and which rules it follows or sets (README, "Plan-first"). Every
// ticket plan carries a `## Reach` and a `## Principles and rules` section in a fixed format; the
// omp extension refuses to record the advisor review without them, and approving a plan files the
// plan's substantial `follow-up` items as tickets in Backlog, at most MAX_PLAN_FOLLOW_UPS
// (server/plan-follow-ups.ts). A place an open ticket already covers is `existing — <TICKET-ID>`
// there: nothing is filed for it.
// No imports beyond ./plan-risk: Paseo's shared bundle refuses Node modules, and the omp extension
// imports it from outside the plugin's build.

import { field, type Impact } from "./plan-risk";

export const REACH_SECTION = "Reach";
export const PRINCIPLES_SECTION = "Principles and rules";
// A plan files at most this many follow-ups (in Backlog, when the plan is approved); everything
// past it becomes an `include` or an `n/a — minor`. The filer enforces it too, on the plans the
// gate never saw, and records the items it stopped as `over-cap` (server/plan-follow-ups.ts).
export const MAX_PLAN_FOLLOW_UPS = 3;
// Every place a change can reach; the planner goes through each.
export const REACH_DIMENSIONS = [
  "workspaces/pages and roles",
  "shared components",
  "existing records (data fix or backfill)",
  "exports, PDFs and labels",
  "EDI, Business Central, mail and notifications",
  "help pages and German labels",
  "permissions",
  "seed and test data",
  "other repositories (e.g. tuchel-timefold)",
  "work outside the software (work instructions, training)",
] as const;
// The lines a new rule needs besides `New rule:` itself.
const RULE_FIELDS = ["Replaces", "Lives in", "Enforced by", "Existing violations"] as const;

export type PlanSections = {
  // The `follow-up — <title>` items of both sections, in plan order, without duplicates.
  followUps: string[];
  // Whether `## Principles and rules` sets a new rule; null when it has no `New rule:` line (a
  // one-line section of a low-impact plan).
  newRule: boolean | null;
};

// The sections the planner writes, word for word in the prompt so the parser below can read them.
export function sectionSteps(): string {
  return [
    `Before \`## Risk and impact\`, the plan carries two sections in exactly this format, one line per item:`,
    `\`## ${REACH_SECTION}\`: everywhere else the thing this ticket changes is used.`,
    "- Changes: <the concept the ticket changes, not the page it names>",
    "- <place>: include — AC-N",
    "- <place>: follow-up — <title of the follow-up ticket>",
    "- <place>: existing — <TICKET-ID> [note]",
    "- <place>: n/a — <reason | minor: <what>>",
    `Go through every dimension: ${REACH_DIMENSIONS.join("; ")}. Every \`include\` names its own acceptance criterion (AC-N, defined in the plan's verification) that proves that place; no two places share one. Repository records that describe the change (principles and decisions, glossary, process map, runbooks, env examples) are not places: they ship in the pull request of the code they describe, under its acceptance criterion, and are an \`include\` with their own only when no code changes (e.g. an owner decision). A \`follow-up\` is only for a substantial finding outside this ticket — a defect, a data, security or money risk, or a missing guarantee a user or another system relies on — and becomes a ticket in Backlog, with that title and related to this ticket, when the plan is approved: search Linear's open tickets (\`search_issues\`) before writing one, and keep at most ${MAX_PLAN_FOLLOW_UPS} per plan. Small work on code this ticket already touches is an \`include\` (fixed now); polish, docs, naming, refactors, ideas and "could consider" are \`n/a — minor: <what>\`, never a ticket. \`existing — <TICKET-ID>\` says an open ticket already covers the place: nothing is filed. When the right behaviour for a role is a business choice that no approved principle covers, ask the owner instead of guessing.`,
    `\`## ${PRINCIPLES_SECTION}\`: which approved rules apply, and whether this change sets a new one.`,
    "- Applies: <IDs of the approved principles and ADRs that apply | none apply — reason>",
    "- Exceptions: <none | ID — why this change needs one>",
    "- New rule: <none — reason | the rule in one sentence — AC-N>",
    "For a new rule also:",
    "- Replaces: <the rule it replaces, or nothing>",
    "- Lives in: <where it is written down, following the repository's routing (e.g. tuchel-platform's CONTRIBUTING.md decision tree)>",
    "- Enforced by: <a check with a known-exceptions baseline, a test, or review>",
    "- Existing violations: <none | fixed now | follow-up — <title> (counts toward the three), one line each>",
    "A new rule names its own acceptance criterion that proves it, and `## Risk and impact` then says `- New rule: yes`: such a plan always goes to the owner. In tuchel-platform a new rule is a `Q-N` proposal in `docs/principles/decision-queue.md`, never an approved principle.",
    `At impact 0–1 each section may be one line, e.g. "Only the menu bar app, because …" under \`## ${REACH_SECTION}\` and "None apply; no new rule." under \`## ${PRINCIPLES_SECTION}\`.`,
  ].join("\n");
}

// A section's text: the rest of its heading line (`## Reach: only X`) and its body up to the next
// heading of level 1 or 2. null: no such heading.
function sectionText(plan: string, name: string): { body: string; text: string } | null {
  const match = new RegExp(`^#{1,6}\\s+${name}\\b([^\\n]*)\\n?([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, "im").exec(plan);
  if (!match) return null;
  return { body: match[2], text: `${match[1].replace(/^\s*[:—–-]\s*/, "")}\n${match[2]}`.trim() };
}

const ITEM = String.raw`^\s*(?:[-*+]|\d+[.)])\s+`;
// `- <place>: include | follow-up | existing | n/a <rest>`
const DECISION = new RegExp(`${ITEM}(?:\\*\\*)?(.+?)(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*(include|follow-up|existing|n/a)\\b(?:\\*\\*)?\\s*(?:[—–:-]+\\s*)?(.*)$`, "i");
// A follow-up item: at the start of a list item or right after its label's colon.
const FOLLOW_UP = new RegExp(`${ITEM}(?:[^\\n]*?:\\s*)?(?:\\*\\*)?follow-up\\b(?:\\*\\*)?\\s*(?:[—–:-]+\\s*)?(.*)$`, "i");
const MAX_TITLE = 200;
// A ticket a plan's text names: an uppercase team key and a number ("TUC-935"). AC-N is a plan
// criterion, never a ticket.
const TICKET_ID = /\b(?!AC-)[A-Z][A-Z0-9]+-\d+\b/g;
// A word saying that the work a follow-up points at exists already.
const COVERED = /\b(already|existing|exists|filed|covered|tracked|duplicate|reopened)\b|same comment/i;

function cleanTitle(raw: string): string {
  const title = raw.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().replace(/^[`"'“„]+|[`"'”“]+$/g, "").trim();
  if (/^<[^>]*>$/.test(title)) return "";
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

// The identifiers a line names, in order, without AC-N.
const ticketRefs = (text: string): string[] => [...text.matchAll(TICKET_ID)].map((match) => match[0]);

// The identifier a follow-up title defers to when it carries no finding of its own: the title is
// nothing but ticket identifiers and punctuation, or names a ticket together with a word saying
// its work exists (README, "Reach and principles"). null: the title states its own finding and is
// filed — a title that merely mentions a related ticket ("Menu stops pulling texts (related to
// TUC-971)") is filed too.
function coveredFollowUp(title: string): string | null {
  const ids = ticketRefs(title);
  if (!ids.length) return null;
  if (COVERED.test(title)) return ids[0];
  return title.replace(TICKET_ID, "").replace(/[^A-Za-z0-9]+/g, "") ? null : ids[0];
}

function decisions(body: string): { place: string; kind: "include" | "follow-up" | "existing" | "n/a"; rest: string }[] {
  return body.split("\n").flatMap((line) => {
    const match = DECISION.exec(line);
    return match ? [{ place: match[1].trim(), kind: match[2].toLowerCase() as "include" | "follow-up" | "existing" | "n/a", rest: match[3].trim() }] : [];
  });
}

// The `follow-up — <title>` items of both sections, read leniently (the inbox and the filing use
// it on plans the gate never saw): trimmed, case-insensitively deduplicated, in plan order. Items
// without a finding of their own — a bare ticket identifier, or one with a word saying the work
// exists — are left out; the ticket they name already covers the place.
export function planFollowUps(plan: string): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const name of [REACH_SECTION, PRINCIPLES_SECTION]) {
    for (const line of (sectionText(plan, name)?.text ?? "").split("\n")) {
      const title = cleanTitle(FOLLOW_UP.exec(line)?.[1] ?? "");
      if (!title || coveredFollowUp(title) || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      titles.push(title);
    }
  }
  return titles;
}

// The identifiers a plan's `existing — <TICKET-ID>` items name: those places are covered by open
// tickets and nothing is filed for them. The origin's notice lists them next to what was filed.
// Deduplicated, in plan order.
export function planExistingRefs(plan: string): string[] {
  const refs: string[] = [];
  for (const name of [REACH_SECTION, PRINCIPLES_SECTION]) {
    for (const place of decisions(sectionText(plan, name)?.text ?? "")) {
      if (place.kind !== "existing") continue;
      for (const id of ticketRefs(place.rest)) if (!refs.includes(id)) refs.push(id);
    }
  }
  return refs;
}

const criteria = (text: string): string[] => [...new Set([...text.matchAll(/\bAC-(\d+)\b/g)].map((match) => `AC-${match[1]}`))];

// The plan's sections, or the problems the planner must fix (the record tool returns them).
// `impact`: the plan's rating (the higher of planner and advisor); 0–1 allows one-line sections,
// null (unknown) does not. At any impact, every `include` and a new rule name an acceptance
// criterion defined elsewhere in the plan, and no two share one: a reference check only, whether
// the criterion proves the place is the advisor's and the owner's call. A plan carries at most
// MAX_PLAN_FOLLOW_UPS follow-ups across both sections, each a finding of its own (not a ticket
// that already covers the place) and each `existing` names the ticket it defers to.
export function parsePlanSections(plan: string, impact: Impact | null): { sections: PlanSections } | { problem: string } {
  const reach = sectionText(plan, REACH_SECTION);
  const principles = sectionText(plan, PRINCIPLES_SECTION);
  const absent = [reach ? "" : REACH_SECTION, principles ? "" : PRINCIPLES_SECTION].filter(Boolean);
  if (absent.length) return { problem: `The plan has no ${absent.map((name) => `"## ${name}"`).join(" and no ")} section.` };
  const empty = [reach!.text ? "" : REACH_SECTION, principles!.text ? "" : PRINCIPLES_SECTION].filter(Boolean);
  if (empty.length) return { problem: `The ${empty.map((name) => `"## ${name}"`).join(" and the ")} section${empty.length > 1 ? "s are" : " is"} empty.` };
  const problems: string[] = [];
  const brief = impact !== null && impact <= 1;
  const places = decisions(reach!.text);
  const rule = field(principles!.text, "New rule");
  const newRule = rule === null ? null : !/^\W*(?:none|no)\b/i.test(rule);
  if (!brief) {
    if (!field(reach!.text, "Changes")) problems.push(`"## ${REACH_SECTION}" has no "- Changes: <the concept the ticket changes>" line.`);
    if (!places.length) problems.push(`"## ${REACH_SECTION}" has no place with a decision ("- <place>: include — AC-N", "follow-up — <title>", "existing — <TICKET-ID>" or "n/a — <reason>").`);
    for (const place of places) {
      if (place.kind === "follow-up" && !cleanTitle(place.rest)) problems.push(`"${place.place}" is a follow-up without a title.`);
      if (place.kind === "n/a" && !place.rest) problems.push(`"${place.place}" is n/a without a reason.`);
      if (place.kind === "existing" && !ticketRefs(place.rest).length) problems.push(`"${place.place}" is existing without a ticket identifier; write "- ${place.place}: existing — <TICKET-ID>".`);
    }
    const followUps = [...places, ...decisions(principles!.text)].filter((place) => place.kind === "follow-up");
    if (followUps.length > MAX_PLAN_FOLLOW_UPS) problems.push(`The plan has ${followUps.length} follow-ups; a plan files at most ${MAX_PLAN_FOLLOW_UPS}. Keep the ${MAX_PLAN_FOLLOW_UPS} that matter most and turn the rest into "include" (fixed now) or "n/a — minor: <what>".`);
    for (const place of followUps) {
      const title = cleanTitle(place.rest);
      const covered = title ? coveredFollowUp(title) : null;
      if (covered) problems.push(`"${place.place}" is a follow-up for ${covered}, which already covers that place; write "- ${place.place}: existing — ${covered}".`);
    }
    for (const name of ["Applies", "New rule"]) if (!field(principles!.text, name)) problems.push(`"## ${PRINCIPLES_SECTION}" has no "- ${name}:" line.`);
    if (newRule) for (const name of RULE_FIELDS) if (!field(principles!.text, name)) problems.push(`The new rule has no "- ${name}:" line.`);
  }
  // Acceptance criteria: defined outside these two sections, one owner each.
  const outside = plan.replace(reach!.body, "").replace(principles!.body, "");
  const defined = new Set(criteria(outside));
  const owners = new Map<string, string>();
  const claims = [...places.filter((place) => place.kind === "include").map((place) => ({ owner: `"${place.place}"`, text: place.rest })), ...(newRule && rule ? [{ owner: "the new rule", text: rule }] : [])];
  for (const { owner, text } of claims) {
    const named = criteria(text);
    if (!named.length) problems.push(`${owner} names no acceptance criterion of its own (… — AC-N).`);
    for (const id of named) {
      if (!defined.has(id)) problems.push(`${owner} names ${id}, which the plan does not define (outside these two sections).`);
      const other = owners.get(id);
      if (other) problems.push(`${id} is named by both ${other} and ${owner}; each needs its own acceptance criterion.`);
      else owners.set(id, owner);
    }
  }
  if (problems.length) return { problem: `The plan's "## ${REACH_SECTION}" and "## ${PRINCIPLES_SECTION}" sections need fixing:\n${problems.map((problem) => `- ${problem}`).join("\n")}` };
  return { sections: { followUps: planFollowUps(plan), newRule } };
}

// The two places a plan states its new rule must agree: `## Risk and impact` decides auto-approval.
export function ruleMismatch(riskNewRule: boolean, sections: PlanSections): string | null {
  if (riskNewRule && sections.newRule !== true) return `"## Risk and impact" says "New rule: yes", but "## ${PRINCIPLES_SECTION}" states no rule. Write it there as "- New rule: <the rule in one sentence> — AC-N".`;
  if (!riskNewRule && sections.newRule === true) return `"## ${PRINCIPLES_SECTION}" sets a new rule, but "## Risk and impact" says "New rule: no". Write "- New rule: yes" there, or "- New rule: none — <reason>" in "## ${PRINCIPLES_SECTION}".`;
  return null;
}
