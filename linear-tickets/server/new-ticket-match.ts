import { planFootprint, sameFile } from "../shared/plan-footprint";
import type { CandidateIssue } from "./linear";
import type { OpenWork } from "./related-work";

// The new-ticket check's matching rules (README, "New-ticket check"): pure, so every rule is tested
// without Linear. new-ticket-check.ts reads the data and writes the comment and labels.

// Words too common in ticket titles to mean two tickets are about the same thing, English and
// German, with the generic words of a ticket title ("fix", "bug", "Fehler").
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "that", "this", "these", "those", "are", "was", "were", "has", "have", "had",
  "not", "but", "all", "any", "can", "should", "must", "when", "then", "than", "after", "before", "only", "also", "its", "our", "your",
  "their", "out", "off", "via", "per", "new", "now", "too", "does", "doesn", "don", "isn", "will", "would", "could", "there", "where",
  "which", "what", "who", "how", "why", "use", "used", "make", "made", "get", "gets", "set", "add", "added", "show", "shows",
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "eines", "und", "oder", "aber", "mit", "von",
  "vom", "zum", "zur", "bei", "beim", "für", "auf", "aus", "nach", "nicht", "kein", "keine", "ist", "sind", "war", "wird", "werden",
  "wenn", "dann", "als", "auch", "noch", "nur", "schon", "sich", "dass", "durch", "über", "unter", "ohne", "wie", "was", "wer",
  "neue", "neuer", "neues", "neuen", "soll", "sollen", "kann", "können", "muss", "müssen", "bitte",
  "fix", "fixed", "bug", "bugs", "error", "errors", "issue", "issues", "problem", "problems", "ticket", "fehler", "beheben",
]);

export const TITLE_SCORE = 0.5;
export const TITLE_SHARED = 2;
export const MAX_FINDINGS = 5;

// Lower-cased Unicode words of 3 or more characters, without stop words.
export function titleWords(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => [...word].length >= 3 && !STOP_WORDS.has(word)));
}

// The Dice score of two titles' words and the words they share; null unless the score reaches
// TITLE_SCORE with at least TITLE_SHARED shared words.
export function similarTitle(a: string, b: string): { score: number; shared: string[] } | null {
  const left = titleWords(a);
  const right = titleWords(b);
  const shared = [...left].filter((word) => right.has(word));
  const score = left.size + right.size ? (2 * shared.length) / (left.size + right.size) : 0;
  return score >= TITLE_SCORE && shared.length >= TITLE_SHARED ? { score, shared } : null;
}

const QUOTED = /„([^“”"\n]+)[“”]|“([^”\n]+)”|"([^"\n]+)"|«([^»\n]+)»/g;
const PATH_LIKE = /[/\\]|^\S+\.[A-Za-z0-9]{1,5}$/;

// Page names: quoted text („…“, “…”, "…", «…») of 3 to 60 characters that is no path, outside code,
// keyed lower-cased with spaces collapsed; the value is the name as written.
export function pageNames(text: string): Map<string, string> {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const names = new Map<string, string>();
  for (const match of prose.matchAll(QUOTED)) {
    const name = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim().replace(/\s+/g, " ");
    if (name.length < 3 || name.length > 60 || PATH_LIKE.test(name)) continue;
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  }
  return names;
}

// The ticket being checked, as the matching rules read it. `areas`: its Area label names.
export type NewTicket = { id: string; identifier: string; title: string; description: string; areas: string[] };
export type FileSource = "description" | "approved plan" | "pull request";
export type Finding = {
  identifier: string;
  title: string;
  status: string;
  similar: { score: number; shared: string[] } | null;
  files: { names: string[]; sources: FileSource[] } | null;
  pages: string[];
  areas: string[];
};

// Open tickets that may be the same work or touch the same place, best first, at most
// MAX_FINDINGS. A shared Area counts only next to another reason. `filesOf`: a pull request's
// changed files from the cache, null when not read.
export function findings(ticket: NewTicket, work: OpenWork, filesOf: (url: string) => string[] | null): Finding[] {
  const ownFiles = planFootprint(ticket.description).files;
  const ownPages = pageNames(`${ticket.title}\n${ticket.description}`);
  const plans = new Map(work.plans.map((plan) => [plan.identifier, plan.files]));
  const found: Finding[] = [];
  for (const candidate of work.open.items) {
    if (candidate.id === ticket.id || candidate.identifier === ticket.identifier) continue;
    const similar = similarTitle(ticket.title, candidate.title);
    const files = sharedFiles(ownFiles, candidate, plans.get(candidate.identifier) ?? [], filesOf);
    const theirPages = pageNames(`${candidate.title}\n${candidate.description}`);
    const pages = [...ownPages].filter(([key]) => theirPages.has(key)).map(([, name]) => name);
    if (!similar && !files && !pages.length) continue;
    const theirAreas = new Set(candidate.labels.filter((label) => /^area: /i.test(label)).map((label) => label.slice(6).toLowerCase()));
    const areas = ticket.areas.filter((area) => theirAreas.has(area.toLowerCase()));
    found.push({ identifier: candidate.identifier, title: candidate.title, status: candidate.status, similar, files, pages, areas });
  }
  const reasons = (finding: Finding) => Number(Boolean(finding.similar)) + Number(Boolean(finding.files)) + Number(finding.pages.length > 0) + Number(finding.areas.length > 0);
  return found.sort((a, b) => reasons(b) - reasons(a) || (b.similar?.score ?? 0) - (a.similar?.score ?? 0) || a.identifier.localeCompare(b.identifier, "en", { numeric: true })).slice(0, MAX_FINDINGS);
}

function sharedFiles(own: string[], candidate: CandidateIssue, planFiles: string[], filesOf: (url: string) => string[] | null): Finding["files"] {
  if (!own.length) return null;
  const sources: [FileSource, string[]][] = [
    ["description", planFootprint(candidate.description).files],
    ["approved plan", planFiles],
    ["pull request", candidate.pullRequests.flatMap((url) => filesOf(url) ?? [])],
  ];
  const names = new Set<string>();
  const from: FileSource[] = [];
  for (const [source, theirs] of sources) {
    const matched = own.filter((file) => theirs.some((other) => sameFile(file, other)));
    if (!matched.length) continue;
    matched.forEach((file) => names.add(file));
    from.push(source);
  }
  return names.size ? { names: [...names], sources: from } : null;
}

export const COMMENT_HEADING = "🔎 **Possibly related work**, checked when this ticket was filed. Paseo added no links for these; the plan decides.";
export const AREA_REQUEST = "**Area:** this ticket has no Area label and no label rule matched. Please set one.";

// The comment, or null when no part applies: the gap line alone is never posted.
export function renderComment(found: Finding[], askArea: boolean, gaps: string[]): string | null {
  if (!found.length && !askArea) return null;
  const parts: string[] = [];
  if (found.length) {
    const lines = found.map((finding) => {
      const reasons: string[] = [];
      if (finding.similar) reasons.push(`similar title (${finding.similar.shared.join(", ")})`);
      if (finding.files) reasons.push(`files named in its ${finding.files.sources.join(", ")}: ${finding.files.names.map((file) => `\`${file}\``).join(", ")}`);
      if (finding.pages.length) reasons.push(`same page: ${finding.pages.map((page) => `“${page}”`).join(", ")}`);
      if (finding.areas.length) reasons.push(`same Area (${finding.areas.join(", ")})`);
      return `- ${finding.identifier} — ${finding.title} (${finding.status}): ${reasons.join("; ")}`;
    });
    parts.push([COMMENT_HEADING, "", ...lines].join("\n"));
  }
  if (askArea) parts.push(AREA_REQUEST);
  if (gaps.length) parts.push(`Not fully checked: ${gaps.join("; ")}.`);
  return parts.join("\n\n");
}

// Tickets Paseo files itself, from either host (README, "New-ticket check"): created by a Paseo
// app, or carrying a title or description marker of a filer that may fall back to the owner's key.
export const FILED_BY_PASEO = {
  titlePrefixes: ["Needs you: ", "Catch up the related work of ", "Decision candidates, week "],
  titles: ["⚠️ Paseo needs attention", "Greptile is not reviewing"],
  descriptionMarkers: ["Filed by Paseo", "Filed by the Paseo agent working on", "Manual task for ", "Marker: `greptile-outage`", "Marker: `ops-kind ", "Marker: `decision-candidates "],
  descriptionPatterns: [/^Step \d+ of \d+ of [A-Z][A-Z0-9]+-\d+\./m],
} as const;

export function filedByPaseo(issue: { creatorId: string | null; title: string; description: string }, appIds: readonly string[]): boolean {
  if (issue.creatorId && appIds.includes(issue.creatorId)) return true;
  if (FILED_BY_PASEO.titlePrefixes.some((prefix) => issue.title.startsWith(prefix)) || FILED_BY_PASEO.titles.some((title) => issue.title === title)) return true;
  return FILED_BY_PASEO.descriptionMarkers.some((marker) => issue.description.includes(marker)) || FILED_BY_PASEO.descriptionPatterns.some((pattern) => pattern.test(issue.description));
}

const ID = "([A-Za-z][A-Za-z0-9]*-\\d+)";
// `defect`: the phrase names the defect itself ("same bug as", "gleicher Fehler wie"); a bare
// "same as" / "wie in" needs the ticket's Bug type.
const REFERENCES: { pattern: RegExp; defect: (match: RegExpMatchArray) => boolean }[] = [
  { pattern: new RegExp(`\\bsame\\s+(?:(bug|error|issue|problem|defect)\\s+)?as\\s+${ID}`, "giu"), defect: (match) => Boolean(match[1]) },
  { pattern: new RegExp(`(?<![\\p{L}])(?:der|die|das|den|dem)?(?:gleiche[rns]?|selbe[rns]?)\\s+(?:fehler|problem|bug)\\s+wie\\s+(?:(?:in|bei)\\s+)?${ID}`, "giu"), defect: () => true },
  { pattern: new RegExp(`\\bwie\\s+(?:in|bei)\\s+${ID}`, "giu"), defect: () => false },
];
const PLACE = /\b(?:pages?|screens?|views?|dialogs?|tabs?|forms?|places?|another|other)\b|(?<![\p{L}])(?:seiten?|masken?|ansichten?|dialoge?n?|reiter[ns]?|formulare?n?|stellen?|anderen)(?![\p{L}])/iu;

// The tickets this one says it is the same bug as, at another place (README, "New-ticket check"):
// in one sentence a reference phrase, a place word and defect evidence; never on a ticket typed
// other than Bug, never the ticket itself. Whether each exists is checked when it is linked.
export function sameAsReferences(issue: { identifier: string; title: string; description: string; labelNames: string[] }): string[] {
  const types = issue.labelNames.filter((name) => /^type:\s/i.test(name));
  const bug = types.some((name) => /^type:\s*bug$/i.test(name));
  if (types.length > (bug ? 1 : 0)) return [];
  const sentences = `${issue.title}\n${issue.description}`.split(/(?<=[.!?])\s+|\n+/);
  const found = new Set<string>();
  for (const sentence of sentences) {
    if (!PLACE.test(sentence)) continue;
    for (const { pattern, defect } of REFERENCES) {
      for (const match of sentence.matchAll(pattern)) {
        const identifier = match[match.length - 1].toUpperCase();
        if (identifier !== issue.identifier.toUpperCase() && (bug || defect(match))) found.add(identifier);
      }
    }
  }
  return [...found];
}
