// What a plan names, for comparing plans with each other and with pull requests (README, "Overlap
// check"). Files: backticked tokens and markdown link targets that contain a "/" or end in a code
// extension, as repo-relative paths ("server/x.ts", not "./server/x.ts:12"). Planners are told to
// name files that way; other spellings are not recognised. Places: the `include` places of
// `## Reach`. Tickets: those named in the plan's ```related-work block, in `## Related work`, or,
// for an old plan with neither, in `## Overlapping tickets`.

import { ADVISOR_SECTION } from "./plan-advisor";
import { decisions, hasSection, RELATED_WORK_SECTION, reachBody, ticketRefs } from "./plan-sections";
import { sectionBody } from "./plan-risk";
import { parseRelatedWork, RELATED_WORK_TAG, type WorkOrderStep } from "./work-order";

const OVERLAPPING_SECTION = "Overlapping tickets";
const CODE_EXTENSIONS: Record<string, true> = {
  ts: true, tsx: true, js: true, jsx: true, mjs: true, cjs: true, json: true, md: true, mdx: true, py: true, go: true, rs: true,
  java: true, kt: true, swift: true, rb: true, php: true, css: true, scss: true, html: true, vue: true, svelte: true, yml: true,
  yaml: true, toml: true, sql: true, sh: true, prisma: true, graphql: true, proto: true,
};
const PATH = /^[\w@.+-]+(?:\/[\w@.+-]+)*\/?$/;
// `## Advisor review` names the advisor's model ("omp/openai-codex/gpt-6-astra"), not files the
// plan changes; read as files it would make every plan one advisor reviewed overlap. The section
// ends where `sectionBody` ends it.
const ADVISOR_REVIEW = new RegExp(`^#{1,6}\\s+${ADVISOR_SECTION}\\b[^\\n]*\\n[\\s\\S]*?(?=^#{1,2}\\s|(?![\\s\\S]))`, "gim");

// `ticket`: the plan's own identifier, so `footprintOverlap` can tell that another plan names it.
export type PlanFootprint = { files: string[]; places: string[]; tickets: string[]; ticket: string | null };
// The parts of two footprints that match: files (equal, or one carrying the other's `owner/repo/`
// prefix), places (case- and spacing-insensitive), tickets, and whether either plan names the
// other's ticket.
export type FootprintOverlap = { files: string[]; places: string[]; tickets: string[]; namesOther: boolean };

export function planFootprint(plan: string, ticket: string | null = null): PlanFootprint {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const file = filePath(raw);
    if (file && !seen.has(file)) { seen.add(file); files.push(file); }
  };
  const text = plan.replace(ADVISOR_REVIEW, "");
  for (const match of text.matchAll(/`([^`\n]+)`/g)) add(match[1]);
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) add(match[1]);
  return { files, places: planPlaces(plan), tickets: planTickets(plan, ticket), ticket };
}

export function footprintOverlap(a: PlanFootprint, b: PlanFootprint): FootprintOverlap {
  const places = new Set(b.places.map(normalizePlace));
  const tickets = new Set(b.tickets);
  return {
    files: a.files.filter((file) => b.files.some((other) => sameFile(file, other))),
    places: a.places.filter((place) => places.has(normalizePlace(place))),
    tickets: a.tickets.filter((ticket) => tickets.has(ticket)),
    namesOther: Boolean((a.ticket && tickets.has(a.ticket)) || (b.ticket && a.tickets.includes(b.ticket))),
  };
}

// A different `owner/repo` with the same suffix is a different file: a pull request names its paths
// with the repository's owner and name in front, a plan names them relative to the repository root.
export function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.endsWith(`/${short}`) && long.split("/").length - short.split("/").length === 2;
}

// A place as written, for matching: unmatched case and spacing, a trailing full stop or colon.
function normalizePlace(place: string): string {
  return place.toLowerCase().replace(/\s+/g, " ").replace(/[.;:]+$/, "").trim();
}

function planPlaces(plan: string): string[] {
  const places: string[] = [];
  const seen = new Set<string>();
  for (const decision of decisions(reachBody(plan) ?? "")) {
    if (decision.kind !== "include") continue;
    const key = normalizePlace(decision.place);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    places.push(decision.place);
  }
  return places;
}

// The related tickets a plan names, without its own identifier. A plan with a `## Related work`
// section states its relations there, in the block and in prose; an old plan says it in
// `## Overlapping tickets`.
function planTickets(plan: string, own: string | null): string[] {
  const tickets: string[] = [];
  const add = (ref: string) => {
    if (ref !== own && !tickets.includes(ref)) tickets.push(ref);
  };
  const block = parseRelatedWork(plan);
  for (const step of block) for (const ref of stepTickets(step)) add(ref);
  if (hasSection(plan, RELATED_WORK_SECTION)) {
    for (const ref of ticketRefs(sectionBody(plan, RELATED_WORK_SECTION) ?? "")) add(ref);
  } else if (!block.length) {
    for (const ref of ticketRefs(sectionBody(plan, OVERLAPPING_SECTION) ?? "")) add(ref);
  }
  return tickets;
}

// The tickets a related-work step names; other steps never appear in the block.
function stepTickets(step: WorkOrderStep): string[] {
  switch (step.kind) {
    case "blocks": return [step.blocker, step.blocked];
    case "duplicates":
    case "relates": return [step.ticket, step.other];
    case "replan": return [step.ticket];
    default: return [];
  }
}

// The repo-relative path a token names, or null when it names no file.
function filePath(raw: string): string | null {
  let token = raw.trim();
  if (!token || token.includes("://") || token.startsWith("#")) return null;
  token = token.replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?:[-:]\d+)*$/, "").replace(/^(?:\.\/)+/, "");
  if (!token || token.startsWith("/") || token.startsWith("..") || !PATH.test(token)) return null;
  const extension = /\.([A-Za-z0-9]+)$/.exec(token)?.[1]?.toLowerCase() ?? "";
  if (Object.hasOwn(CODE_EXTENSIONS, extension) && token.length > extension.length + 1) return token;
  // "and/or", "TUC-1/TUC-2": two plain words or ticket keys around a slash are no path; nor is a
  // ticket branch ("mtuchel/tuc-597-retire-n8n", "origin/mtuchel/tuc-597-retire-n8n").
  if (!token.includes("/") || /^[A-Za-z]+\/[A-Za-z]+$/.test(token) || /^[A-Z][A-Z0-9]*-\d+(?:\/[A-Z][A-Z0-9]*-\d+)+$/.test(token) || /^(?:origin\/)?[\w.-]+\/[A-Za-z][A-Za-z0-9]*-\d+-[\w.-]+$/.test(token)) return null;
  return token;
}
