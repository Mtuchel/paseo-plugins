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
// separator, hashed like `planHash`, so a replan request can name the plan it is about and be
// recognised as written against the current one (server/plan-relations.ts, plan-requests.ts).
export function documentPlanHash(content: string): string {
  const lines = content.split("\n");
  const separator = lines.findIndex((line) => line.trim() === "---");
  const heading = lines.findIndex((line) => line.trim().startsWith("#"));
  const start = separator >= 0 ? separator + 1 : heading >= 0 ? heading : 0;
  return planHash(lines.slice(start).join("\n"));
}

// The date a `Plan:` document's Approved header names ("2026-10-06 11:01 UTC"), as an epoch time;
// null when it has no Approved header or no readable date.
export function documentApprovedAt(content: string): number | null {
  const header = /^>\s*\*\*Approved\*\*.*?on (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\b/m.exec(content);
  return header ? Date.parse(`${header[1]}T${header[2]}:00Z`) : null;
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
