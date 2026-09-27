import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type PendingReview = { localUrl: string; openedAt?: string; planHash?: string };
export type ReviewOutcome = "open" | { approved: boolean; feedback?: string; planContent: string } | null;

export function planHash(plan: string): string {
  return createHash("sha256").update(plan.trim()).digest("hex");
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
