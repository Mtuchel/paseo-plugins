import type { LogEntry } from "./owner-decisions";
import { normalize } from "./owner-decisions";

// Prove it before trusting it (README, "Deputy for agent questions"): live answers need at least
// LIVE_MIN_CASES real questions where the deputy's prediction, recorded before anyone answered,
// can be compared with the owner's own answer, and at least LIVE_MIN_AGREEMENT of them matching,
// all under the current evaluator version. Only owner answers the plugin delivered for the
// authenticated owner (`owner-answer`) count: a resolution the daemon reports names no responder,
// so neither it, nor an identical answer text, nor answering soon after proves who answered.

export const LIVE_MIN_CASES = 30;
export const LIVE_MIN_AGREEMENT = 0.9;

export type Pair = { id: string; identifier: string; predictedAt: string; answeredAt: string; predicted: Record<string, string>; owner: Record<string, string>; match: boolean };
export type Evidence = {
  version: string;
  pairs: Pair[];
  matches: number;
  agreement: number | null;
  // Owner answers that do not say anything for a predicted part: shown, never counted either way.
  unknown: { id: string; identifier: string; reason: string }[];
  // Predictions recorded after the request was already answered or resolved: they prove nothing.
  late: string[];
  // Predictions still without an attributed owner answer (pending, answered in the Paseo app, or by the deputy).
  unpaired: string[];
  refusals: Record<string, number>;
  ready: boolean;
};

const same = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

export function shadowEvidence(entries: LogEntry[], version: string): Evidence {
  const by = <K extends LogEntry["kind"]>(kind: K) => {
    const found = new Map<string, Extract<LogEntry, { kind: K }>>();
    for (const entry of entries) if (entry.kind === kind && !found.has(entry.id)) found.set(entry.id, entry as Extract<LogEntry, { kind: K }>);
    return found;
  };
  const questions = by("question");
  const resolutions = by("answer");
  const owners = new Map<string, Extract<LogEntry, { kind: "owner-answer" }>>();
  for (const entry of entries) if (entry.kind === "owner-answer" && entry.userId.trim() && !owners.has(entry.id)) owners.set(entry.id, entry);
  const applied = by("deputy-answer");
  const evidence: Evidence = { version, pairs: [], matches: 0, agreement: null, unknown: [], late: [], unpaired: [], refusals: {}, ready: false };
  for (const entry of entries) {
    if (entry.kind === "deputy-refusal" && entry.version === version) evidence.refusals[entry.category ?? "no-knowledge"] = (evidence.refusals[entry.category ?? "no-knowledge"] ?? 0) + 1;
  }
  for (const prediction of by("deputy-prediction").values()) {
    if (prediction.version !== version || applied.has(prediction.id)) continue;
    const predictedAt = Date.parse(prediction.at);
    const resolved = resolutions.get(prediction.id);
    const owner = owners.get(prediction.id);
    if ((resolved && Date.parse(resolved.at) <= predictedAt) || (owner && Date.parse(owner.at) <= predictedAt)) { evidence.late.push(prediction.id); continue; }
    if (!owner) { evidence.unpaired.push(prediction.id); continue; }
    const missing = Object.keys(prediction.selections).find((key) => !owner.answers[key]?.trim());
    const identifier = questions.get(prediction.id)?.identifier ?? prediction.identifier;
    if (missing !== undefined) { evidence.unknown.push({ id: prediction.id, identifier, reason: `the owner's answer has nothing for “${missing}”` }); continue; }
    const match = Object.entries(prediction.selections).every(([key, label]) => same(owner.answers[key], label));
    evidence.pairs.push({ id: prediction.id, identifier, predictedAt: prediction.at, answeredAt: owner.at, predicted: prediction.selections, owner: owner.answers, match });
    if (match) evidence.matches++;
  }
  evidence.agreement = evidence.pairs.length ? evidence.matches / evidence.pairs.length : null;
  evidence.ready = evidence.pairs.length >= LIVE_MIN_CASES && (evidence.agreement ?? 0) >= LIVE_MIN_AGREEMENT;
  return evidence;
}

export function evidenceSummary(evidence: Evidence): string {
  const rate = evidence.agreement === null ? "no paired cases" : `${Math.round(evidence.agreement * 1000) / 10}% agreement`;
  return `${evidence.pairs.length} of ${LIVE_MIN_CASES} paired cases, ${rate} (needs ${LIVE_MIN_AGREEMENT * 100}%)`;
}
