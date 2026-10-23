import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// `remoteUrl`: the tailnet link shown in the Linear panel, removed again when the review ends.
// `reviewId`: the decision journal's generation of the review (decision-journal.ts).
export type PendingReview = { localUrl: string; remoteUrl?: string; openedAt?: string; planHash?: string; reviewId?: string };
export type ReviewOutcome = "open" | { approved: boolean; feedback?: string; planContent: string } | null;

// A plan text's identity, also for the risk policy: the omp extension hashes the plan it records
// the advisor review for the same way (omp/linear-tickets-plan-first.ts).
export function planHash(plan: string): string {
  return createHash("sha256").update(plan.trim()).digest("hex");
}

// A `Plan:` document's own text below the plugin's leading `>` header lines and the `---`
// separator; comparisons read this, never the headers.
export function documentPlanText(content: string): string {
  const lines = content.split("\n");
  const separator = lines.findIndex((line) => line.trim() === "---");
  const heading = lines.findIndex((line) => line.trim().startsWith("#"));
  return lines.slice(separator >= 0 ? separator + 1 : heading >= 0 ? heading : 0).join("\n");
}

// A `Plan:` document's own text below its headers, hashed like `planHash`, so a replan request can
// name the plan it is about and be recognised as written against the current one
// (server/plan-relations.ts, plan-requests.ts). A document whose plan was truncated names the whole
// plan's hash in a header line; older documents and untruncated ones are hashed from their text.
export function documentPlanHash(content: string): string {
  const named = /^>\s*\*\*Plan hash:\*\*\s*([0-9a-f]{64})\s*$/m.exec(leadingLines(content));
  return named ? named[1] : planHash(documentPlanText(content));
}

// A `Plan:` document's Approved header names when the plan was approved, to the precision the
// header was written with: "2026-10-01 10:41:10.123 UTC" (exact), "2026-10-01 10:41:10",
// "2026-10-01 10:41" (older writers) or "2026-10-01" (date only). Better precision is explicit;
// the interval covers the uncertainty of coarser headers.
const APPROVED_HEADER = /^>\s*\*\*Approved\*\*[^\n]*?\bon (\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{3}))?)?)?(?:\s*UTC)?/m;
const COARSE_APPROVAL = { day: 86_400_000 - 1, minute: 60_000 - 1, second: 1_000 - 1 };

// The interval a decision was taken in, in epoch milliseconds: [earliest, latest]. A header with
// milliseconds is one instant; a seconds-only header covers its second, a minute-only header its
// minute, and a date-only header its day. A document without an Approved header (never approved, or
// sent back) falls back to when it was last written (`updatedAt`); without that, null.
export function approvalInterval(content: string, updatedAt: string | null = null): [number, number] | null {
  // The plugin's leading header lines only, like `planRound`: a plan body may quote a header line.
  const header = APPROVED_HEADER.exec(leadingLines(content));
  if (!header) {
    const written = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    return Number.isFinite(written) ? [written, written] : null;
  }
  const [year, month, day] = header[1].split("-").map(Number);
  if (!header[2]) return [Date.UTC(year, month - 1, day), Date.UTC(year, month - 1, day) + COARSE_APPROVAL.day];
  const [hour, minute] = header[2].split(":").map(Number);
  const second = header[3] === undefined ? 0 : Number(header[3]);
  const ms = header[4] === undefined ? 0 : Number(header[4]);
  const start = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return [start, start + (header[4] !== undefined ? 0 : header[3] !== undefined ? COARSE_APPROVAL.second : COARSE_APPROVAL.minute)];
}


// Whether the document's leading header records an approval: a plan sent back has a header too,
// and its save time is no approval time.
export function approvedDocument(content: string): boolean {
  return APPROVED_HEADER.test(leadingLines(content));
}

// A document's text before its `---` separator or first heading.
function leadingLines(content: string): string {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    const text = line.trim();
    if (text === "---" || text.startsWith("#")) break;
    lines.push(line);
  }
  return lines.join("\n");
}

// What became of a review the plugin is waiting on. Decisions taken on Plannotator's own page
// reach nobody when omp's plan mode runs the review, but Plannotator saves every decided plan as
// `<slug>-<date>-approved.md` / `-denied.md` (feedback in `<slug>-<date>.annotations.md`).
// "open": the review still answers. null: it closed without a recognisable decision.
export async function reviewOutcome(review: PendingReview, directory = join(homedir(), ".plannotator", "plans"), probe = probeReview): Promise<ReviewOutcome> {
  if (await probe(review.localUrl)) return "open";
  if (!review.planHash) return null;
  const since = review.openedAt ? Date.parse(review.openedAt) - 60_000 : 0;
  let best: { at: number; approved: boolean; path: string; content: string } | null = null;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const decision = /-(approved|denied)\.md$/.exec(name);
    if (!decision) continue;
    const path = join(directory, name);
    const at = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
    if (at < since || (best && at <= best.at)) continue;
    const content = await readFile(path, "utf8").catch(() => "");
    if (planHash(content) === review.planHash) best = { at, approved: decision[1] === "approved", path, content };
  }
  if (!best) return null;
  const feedback = best.approved ? "" : (await readFile(best.path.replace(/-denied\.md$/, ".annotations.md"), "utf8").catch(() => "")).trim();
  return { approved: best.approved, ...(feedback ? { feedback } : {}), planContent: best.content };
}

async function probeReview(localUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${new URL(localUrl).origin}/api/plan`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}
