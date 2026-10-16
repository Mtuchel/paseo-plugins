import type { OwnerAskComment } from "./linear";

export type AskSource = { sourceId: string; text: string; createdAt: string };
export type AskContext = {
  sourceId: string;
  currentWait: boolean;
  liveRequest: boolean;
  duplicateOf: string | null;
  complete: boolean;
  timeline: AskSource[];
};
export type AskAssessment = {
  state: "owner" | "agent" | "info" | "review" | "advisor" | "dependency" | "resolved" | "superseded";
  reason: string;
  ownerBoundary: "business" | "identity" | "owner-hold" | null;
  evidence: { sourceId: string; quote: string }[];
  relatedSourceId?: string;
};
const MAX_TIMELINE_CHARS = 32_000;
const MAX_ENTRY_CHARS = 4_000;

// Strip only the generated relay envelope. No fuzzy text/question/topic deduplication: two
// different questions, choices or qualifications are independent even on the same ticket.
export function askContent(text: string): string {
  return text.replace(/^[^\n]*\(Paseo\) (?:finished its turn and is waiting for you|is waiting for (?:an answer|plan approval|permission)):\s*/i, "")
    .replace(/\n\s*Reply here with [“"]@paseo[^\n]*$/i, "").trim();
}

// One timeline feeds many source cards. Normalize each entry once, not once for
// every other card; a changed text invalidates its value and discarded timelines
// retain no cache entries.
const normalizedSources = new WeakMap<AskSource, { text: string; content: string }>();
function normalizedSource(source: AskSource): string {
  const known = normalizedSources.get(source);
  if (known?.text === source.text) return known.content;
  const content = askContent(source.text);
  normalizedSources.set(source, { text: source.text, content });
  return content;
}

export function askTimeline(description: string, comments: OwnerAskComment[]): AskSource[] {
  return [{ sourceId: "description", text: description, createdAt: "" },
    ...[...new Map(comments.map(comment => [comment.id, comment])).values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map(comment => ({ sourceId: comment.id, text: comment.body, createdAt: comment.createdAt }))];
}

export function askContext(sourceId: string, timeline: AskSource[], waitSourceId: string | null, currentWait: boolean, liveRequest: boolean): AskContext {
  const original = timeline.find(source => source.sourceId === sourceId)!;
  const content = normalizedSource(original);
  const same = content ? timeline.filter(source => normalizedSource(source) === content) : [];
  // Prefer the current exact wait; otherwise stable oldest source, not whichever echo a poll
  // happens to return first. Originals remain reviewable; no Linear or ledger mutation occurs.
  same.sort((a, b) => Number(b.sourceId === waitSourceId) - Number(a.sourceId === waitSourceId)
    || a.createdAt.localeCompare(b.createdAt) || a.sourceId.localeCompare(b.sourceId));
  const canonical = same[0]?.sourceId ?? sourceId;
  const selected: AskSource[] = [];
  let remaining = MAX_TIMELINE_CHARS;
  let complete = true;
  for (const source of [original, ...timeline.filter(source => source.sourceId !== sourceId)]) {
    const text = source.text.slice(0, Math.min(remaining, MAX_ENTRY_CHARS));
    if (text.length !== source.text.length) complete = false;
    if (text || !source.text) selected.push({ ...source, text });
    remaining -= text.length;
  }
  return { sourceId, currentWait, liveRequest, duplicateOf: canonical === sourceId ? null : canonical, complete, timeline: selected };
}

// A model label is not source evidence. Check exact quotes against this request's source
// snapshot, and require a positively named human boundary for historical owner admission.
// Incomplete history cannot prove an old question remains unresolved. Missing evidence is
// explicit nonurgent review, never an answer, approval, completion or deferral.
export function checkAssessment(raw: unknown, context?: AskContext): AskAssessment | null {
  if (!context || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!["owner", "agent", "info", "review", "advisor", "dependency", "resolved", "superseded"].includes(String(value.state))) return null;
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 1_000) return null;
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 8) return null;
  const evidence: AskAssessment["evidence"] = [];
  for (const rawCitation of value.evidence) {
    if (!rawCitation || typeof rawCitation !== "object") return null;
    const citation = rawCitation as Record<string, unknown>;
    if (typeof citation.sourceId !== "string" || typeof citation.quote !== "string" || !citation.quote.trim() || citation.quote.length > MAX_ENTRY_CHARS) return null;
    const source = context.timeline.find(source => source.sourceId === citation.sourceId);
    if (!source || !source.text.includes(citation.quote)) return null;
    evidence.push({ sourceId: citation.sourceId, quote: citation.quote });
  }
  if (!evidence.some(citation => citation.sourceId === context.sourceId)) return null;
  const ownerBoundary = value.ownerBoundary === "business" || value.ownerBoundary === "identity" || value.ownerBoundary === "owner-hold" ? value.ownerBoundary : null;
  if (value.state === "owner" && (!ownerBoundary || !context.complete)) return null;
  const relatedSourceId = typeof value.relatedSourceId === "string" ? value.relatedSourceId : undefined;
  if (value.state === "resolved" || value.state === "superseded") {
    const original = context.timeline.find(source => source.sourceId === context.sourceId)!;
    const related = context.timeline.find(source => source.sourceId === relatedSourceId);
    if (!related || related.sourceId === original.sourceId || !evidence.some(citation => citation.sourceId === related.sourceId)) return null;
    // An unrelated newer progress note is not a resolution. The extractor must cite the exact
    // question and the later answer/replacement, and explain their source-specific relationship.
    if (!Number.isFinite(Date.parse(original.createdAt)) || !Number.isFinite(Date.parse(related.createdAt)) || Date.parse(related.createdAt) <= Date.parse(original.createdAt)) return null;
    const originalQuotes = evidence.filter(citation => citation.sourceId === original.sourceId).map(citation => citation.quote);
    if (!related.text.includes(original.sourceId) && !originalQuotes.some(quote => quote.trim().length >= 12 && related.text.includes(quote))) return null;
  }
  return { state: value.state as AskAssessment["state"], reason: value.reason.trim(), ownerBoundary, evidence, ...(relatedSourceId ? { relatedSourceId } : {}) };
}

export function assessmentReason(assessment: AskAssessment): string {
  return `${assessment.state}: ${assessment.reason} Evidence: ${assessment.evidence.map(citation => `${citation.sourceId}: ${JSON.stringify(citation.quote.slice(0, 400))}`).join("; ")}`;
}
