import type { Candidate } from "./deputy";
import { LIVE_MIN_AGREEMENT, LIVE_MIN_CASES, shadowEvidence, type Evidence } from "./deputy-evidence";
import type { LogEntry } from "./owner-decisions";
import { TECHNICAL_CONTINUATION } from "./deputy-continuation";

// The deputy's outcome report (README, "Deputy for agent questions"), read-only: the shadow
// evidence for one evaluator version, what the deputy refused and answered, the owner's overrides,
// candidates still open, and, for two equally long windows, how long questions waited and how many
// owner answers each merged pull request cost.

export type Window = { since: string; until: string };
export type WaitStats = {
  window: Window;
  questions: number;
  resolved: number;
  unresolved: string[];
  medianMinutes: number | null;
  byDeputy: number;
  ownerAnswers: number;
  mergedPullRequests: number | null;
  ownerAnswersPerMergedPullRequest: number | null;
};

const inWindow = (at: string, window: Window) => at >= window.since && at < window.until;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Questions asked in the window, from the time they were asked to the first answer of any kind
// (the owner's in Linear or the Paseo app, or the deputy's). A question still unanswered when the
// window ends is listed, never left out of the count. Owner answers: every resolution the deputy
// did not cause.
export function waitStats(entries: LogEntry[], window: Window, mergedPullRequests: number | null): WaitStats {
  const ends = new Map<string, { at: string; deputy: boolean }>();
  // The daemon echoes the initial Other response, not substantive completion.
  const continued = new Set(entries.flatMap(entry => entry.kind === "deputy-continuation" ? [entry.id] : []));
  for (const entry of entries) {
    if (entry.kind !== "answer" && entry.kind !== "owner-answer" && entry.kind !== "deputy-answer") continue;
    if (entry.answers?.Response === TECHNICAL_CONTINUATION) continue;
    if (continued.has(entry.id) && entry.kind !== "owner-answer") continue;
    const known = ends.get(entry.id);
    if (!known || entry.at < known.at) ends.set(entry.id, { at: entry.at, deputy: entry.kind === "deputy-answer" });
  }
  const deputyAnswered = new Set(entries.flatMap((entry) => entry.kind === "deputy-answer" ? [entry.id] : []));
  const asked = new Map<string, string>();
  for (const entry of entries) if (entry.kind === "question" && inWindow(entry.at, window) && !asked.has(entry.id)) asked.set(entry.id, entry.at);
  const waits: number[] = [];
  const unresolved: string[] = [];
  let byDeputy = 0;
  for (const [id, at] of asked) {
    const end = ends.get(id);
    if (!end || end.at < at || end.at >= window.until) { unresolved.push(id); continue; }
    waits.push((Date.parse(end.at) - Date.parse(at)) / 60_000);
    if (end.deputy) byDeputy++;
  }
  const ownerAnswers = new Set(entries.flatMap((entry) => (entry.kind === "answer" || entry.kind === "owner-answer") && entry.answers?.Response !== TECHNICAL_CONTINUATION && inWindow(entry.at, window) && !deputyAnswered.has(entry.id) && (entry.kind === "owner-answer" || !continued.has(entry.id)) ? [entry.id] : [])).size;
  return {
    window,
    questions: asked.size,
    resolved: waits.length,
    unresolved,
    medianMinutes: median(waits),
    byDeputy,
    ownerAnswers,
    mergedPullRequests,
    ownerAnswersPerMergedPullRequest: mergedPullRequests ? ownerAnswers / mergedPullRequests : null,
  };
}

// The operational acceptance: questions clear in under 15 minutes at the median in the live window
// and owner answers per merged pull request fall against the baseline. Missing data is inconclusive.
export function verdict(baseline: WaitStats, live: WaitStats): { pass: boolean | null; reasons: string[] } {
  const reasons: string[] = [];
  if (Date.parse(baseline.window.until) - Date.parse(baseline.window.since) !== Date.parse(live.window.until) - Date.parse(live.window.since)) reasons.push("the windows are not equally long");
  if (live.medianMinutes === null) reasons.push("no question was answered in the live window");
  if (baseline.ownerAnswersPerMergedPullRequest === null || live.ownerAnswersPerMergedPullRequest === null) reasons.push("a window has no merged pull request (or the count is unknown)");
  if (!baseline.questions) reasons.push("the baseline window has no questions to compare with");
  if (reasons.length) return { pass: null, reasons };
  const fast = (live.medianMinutes ?? Infinity) < 15;
  const fewer = (live.ownerAnswersPerMergedPullRequest ?? Infinity) < (baseline.ownerAnswersPerMergedPullRequest ?? 0);
  if (!fast) reasons.push(`the live median wait is ${live.medianMinutes?.toFixed(1)} min, not under 15`);
  if (!fewer) reasons.push("owner answers per merged pull request did not fall");
  return { pass: fast && fewer, reasons };
}

const minutes = (value: number | null) => value === null ? "n/a" : `${value.toFixed(1)} min`;
const ratio = (value: number | null) => value === null ? "n/a" : value.toFixed(2);

function evidenceLines(evidence: Evidence): string[] {
  const predictions = evidence.pairs.length + evidence.unknown.length + evidence.late.length + evidence.unpaired.length;
  const refused = Object.values(evidence.refusals).reduce((sum, count) => sum + count, 0);
  const seen = predictions + refused;
  const lines = [
    `## Shadow evidence for ${evidence.version}`,
    "",
    `- Ready for live: ${evidence.ready ? "yes" : "no"} (needs ${LIVE_MIN_CASES} paired cases at ${LIVE_MIN_AGREEMENT * 100}% agreement)`,
    `- Paired with the owner's own answer: ${evidence.pairs.length}; matches ${evidence.matches}, mismatches ${evidence.pairs.length - evidence.matches}; agreement ${evidence.agreement === null ? "n/a" : `${(evidence.agreement * 100).toFixed(1)}%`}`,
    `- Readiness blockers: ${[
      ...(evidence.pairs.length < LIVE_MIN_CASES ? [`${LIVE_MIN_CASES - evidence.pairs.length} more qualifying paired cases required`] : []),
      ...(evidence.agreement === null ? ["agreement cannot be measured without paired cases"] : evidence.agreement < LIVE_MIN_AGREEMENT ? [`agreement is below ${LIVE_MIN_AGREEMENT * 100}%`] : []),
    ].join("; ") || "none (the checked answer connection is a separate live gate)"}`,
    `- Coverage: predicted ${predictions} of ${seen} questions seen${seen ? ` (${((predictions / seen) * 100).toFixed(1)}%)` : ""}; refused ${refused}`,
    `- Owner answer unusable for comparison: ${evidence.unknown.length}; predicted too late: ${evidence.late.length}; not (yet) paired: ${evidence.unpaired.length}`,
    "",
  ];
  if (Object.keys(evidence.refusals).length) lines.push("Refusals by reason:", "", ...Object.entries(evidence.refusals).sort((a, b) => b[1] - a[1]).map(([category, count]) => `- ${category}: ${count}`), "");
  const mismatches = evidence.pairs.filter((pair) => !pair.match);
  if (mismatches.length) lines.push("Mismatches:", "", ...mismatches.map((pair) => `- ${pair.identifier} \`${pair.id}\`: deputy ${JSON.stringify(pair.predicted)}, owner ${JSON.stringify(pair.owner)}`), "");
  if (evidence.unknown.length) lines.push("Unusable owner answers:", "", ...evidence.unknown.map((found) => `- ${found.identifier} \`${found.id}\`: ${found.reason}`), "");
  return lines;
}

function statsLines(title: string, stats: WaitStats): string[] {
  return [
    `### ${title}: ${stats.window.since} – ${stats.window.until}`,
    "",
    `- Questions: ${stats.questions}; answered ${stats.resolved} (by the deputy ${stats.byDeputy}); unanswered ${stats.unresolved.length}`,
    `- Median wait: ${minutes(stats.medianMinutes)}`,
    `- Owner answers: ${stats.ownerAnswers}; merged pull requests: ${stats.mergedPullRequests ?? "unknown"}; owner answers per merged pull request: ${ratio(stats.ownerAnswersPerMergedPullRequest)}`,
    ...(stats.unresolved.length ? ["", "Unanswered:", "", ...stats.unresolved.map((id) => `- \`${id}\``)] : []),
    "",
  ];
}

export function renderReport(input: { entries: LogEntry[]; candidates: Candidate[]; version: string | null; now: string; windows?: { baseline: WaitStats; live: WaitStats } }): string {
  const { entries, candidates, version } = input;
  const lines = [`# Deputy report (${input.now})`, ""];
  if (version) lines.push(...evidenceLines(shadowEvidence(entries, version)));
  else lines.push("No evaluator model is configured (deputy.model): there is no version to report evidence for.", "");
  const answers = entries.filter((entry): entry is Extract<LogEntry, { kind: "deputy-answer" }> => entry.kind === "deputy-answer");
  const continuedIds = new Set(entries.flatMap(entry => entry.kind === "deputy-continuation" ? [entry.id] : []));
  const overrides = entries.filter((entry): entry is Extract<LogEntry, { kind: "deputy-override" }> => entry.kind === "deputy-override" && !continuedIds.has(entry.id));
  const outcomes = entries.filter((entry): entry is Extract<LogEntry, { kind: "deputy-outcome" }> => entry.kind === "deputy-outcome");
  lines.push("## Live answers", "", `- Answered by the deputy: ${answers.length}; overridden by the owner: ${new Set(overrides.map((entry) => entry.id)).size} (corrections delivered ${overrides.filter((entry) => entry.disposition === "delivered").length}, failed ${overrides.filter((entry) => entry.disposition === "failed").length})`);
  const byOutcome = new Map<string, number>();
  for (const entry of outcomes) byOutcome.set(entry.key, (byOutcome.get(entry.key) ?? 0) + 1);
  lines.push(`- Not answered after the grace period: ${[...byOutcome].map(([key, count]) => `${key} ${count}`).join(", ") || "none"}`, "");
  for (const entry of answers) {
    const overridden = overrides.filter((override) => override.id === entry.id);
    lines.push(`- ${entry.identifier} \`${entry.id}\` ${entry.at}: ${JSON.stringify(entry.answers)}; sources ${entry.citations.map((citation) => `${citation.sourceId}@${citation.revision}`).join(", ")}${overridden.length ? `; overridden: ${overridden.map((override) => JSON.stringify(override.text)).join(", ")}` : ""}`);
  }
  if (answers.length) lines.push("");
  const continuations = entries.filter((entry): entry is Extract<LogEntry, { kind: "deputy-continuation" }> => entry.kind === "deputy-continuation");
  lines.push("## Bounded technical continuations", "", `- Checked technical instructions submitted: ${continuations.length}; later editor consumption and agent execution unobserved. Not substantive answers, owner approvals or empirical calibration.`, "");
  for (const entry of continuations) lines.push(`- ${entry.identifier} \`${entry.id}\` ${entry.at}: intent \`${entry.key}\`, fingerprint \`${entry.fingerprint}\`, template \`${entry.continuation.template}\`; intended directive ${JSON.stringify(entry.directive)}; assessed step ${JSON.stringify(entry.continuation.step)}; sources ${entry.citations.map(citation => `${citation.sourceId}@${citation.revision}`).join(", ")}`);
  if (continuations.length) lines.push("");
  const refusals = new Map<string, Extract<LogEntry, { kind: "deputy-refusal" }>>();
  for (const entry of entries) if (entry.kind === "deputy-refusal" && entry.version === version) refusals.set(entry.id, entry);
  const predicted = new Set(entries.flatMap((entry) => entry.kind === "deputy-prediction" && entry.version === version ? [entry.id] : []));
  const reasons = new Map<string, number>();
  for (const refusal of refusals.values()) if (!predicted.has(refusal.id)) {
    const reason = `${refusal.category ?? "no-knowledge"}: ${refusal.reason}`;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  lines.push("## Abstention diagnostics", "", ...([...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `- ${count} question(s): ${reason}`)), "");
  const retrying = candidates.filter((candidate) => candidate.status === "refused" && candidate.retryAt);
  if (retrying.length) lines.push("Pending evidence rechecks (not permission to answer):", "", ...retrying.map((candidate) => `- ${candidate.identifier} ${candidate.ref}: ${candidate.refusalCategory}, next check ${candidate.retryAt}; ${candidate.reason}`), "");
  const open = candidates.filter((candidate) => ["evaluating", "waiting", "dispatching"].includes(candidate.status) || (candidate.status === "applied" && candidate.notice && !(candidate.notice.comment && candidate.notice.session)));
  lines.push("## Open cases", "", ...(open.length ? open.map((candidate) => `- ${candidate.identifier} ${candidate.ref} \`${candidate.key}\`: ${candidate.status}${candidate.status === "applied" ? " (notice not delivered yet)" : ""}${candidate.graceDeadline ? `, grace until ${candidate.graceDeadline}` : ""}`) : ["None."]), "");
  if (input.windows) {
    const { baseline, live } = input.windows;
    const result = verdict(baseline, live);
    lines.push("## Waiting time and owner workload", "", ...statsLines("Baseline", baseline), ...statsLines("Live", live), `Verdict: ${result.pass === null ? "inconclusive" : result.pass ? "pass" : "fail"}${result.reasons.length ? ` (${result.reasons.join("; ")})` : ""}`, "");
  }
  return lines.join("\n");
}
