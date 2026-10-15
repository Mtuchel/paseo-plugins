#!/usr/bin/env node
// Model tier report (README, "Model tiers"): how tickets on the cheap tier fare against the strong
// tier, including how many review/fix rounds their pull requests needed. Reads the plugin's tier
// records ($PASEO_HOME/linear-tickets/model-tiers), handover records (…/handover) and the pull
// request watch (…/pr-watch.json) on this host; read-only.
//   npm run tier-report [-- --since 2026-10-01]
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
const root = join(home, "linear-tickets");
const sinceArg = process.argv.indexOf("--since");
const since = sinceArg > 0 ? Date.parse(process.argv[sinceArg + 1] ?? "") : Number.NaN;

const TIERS = ["cheap", "strong"];
// A record from before the standard tier was dropped reads as its conservative current tier, the
// same rule as `LEGACY_TIER_READINGS` in shared/plan-model.ts (this script runs without the build).
const LEGACY_TIERS = { standard: "strong" };
const readTier = (value) => (TIERS.includes(value) ? value : LEGACY_TIERS[value] ?? null);
// The pull request watch's nudge stages (server/pr-nudge.ts `Stage`): one entry per round the
// plugin sent the agent back to its pull request. red, changes and findings are fix rounds after
// CI or a review; conflict and draft are not.
const STAGES = ["red", "changes", "findings", "conflict", "draft"];
const FIX_STAGES = new Set(["red", "changes", "findings"]);

async function records(directory) {
  const names = await readdir(directory).catch(() => []);
  const all = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(directory, name), "utf8").then(JSON.parse).catch(() => null)));
  return all.filter(Boolean);
}

const watch = await readFile(join(root, "pr-watch.json"), "utf8").then(JSON.parse).catch(() => ({}));
const handovers = new Map((await records(join(root, "handover"))).map((record) => [record.issueId, record]));
const rows = (await records(join(root, "model-tiers")))
  .map((record) => {
    const history = (record.history ?? []).map((event) => ({ ...event, tier: readTier(event.tier) })).filter((event) => event.tier);
    // The first tier decision: an approved plan's, a launch's, or the small-ticket route's.
    const first = history.find((event) => event.source === "plan" || event.source === "start" || event.source === "route");
    const escalations = history.filter((event) => event.source === "escalated");
    const handover = handovers.get(record.issueId);
    const pullRequest = handover?.links?.["Pull request"] ?? null;
    const seen = pullRequest ? watch[pullRequest] : undefined;
    const nudges = Object.fromEntries(STAGES.map((stage) => [stage, seen?.nudges?.[stage]?.length ?? 0]));
    return {
      identifier: record.identifier,
      startedAt: first?.at ?? record.updatedAt,
      tier: first?.tier ?? readTier(record.tier),
      escalations,
      strongSteps: history.some((event) => event.strongSteps),
      outcome: handover?.status === "failed" ? "failed" : pullRequest ? "pull request" : handover?.status ?? "unknown",
      pullRequest,
      watched: Boolean(seen),
      nudges,
      fixRounds: STAGES.filter((stage) => FIX_STAGES.has(stage)).reduce((sum, stage) => sum + nudges[stage], 0),
      greptile: seen?.greptile?.length ?? 0,
    };
  })
  .filter((row) => row.tier && (Number.isNaN(since) || Date.parse(row.startedAt) >= since))
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

if (!rows.length) {
  console.log(`No tier records${Number.isNaN(since) ? "" : " since then"} in ${join(root, "model-tiers")}.`);
  process.exit(0);
}

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");
const mean = (values) => (values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : "–");
const line = (cells) => console.log(cells.map((cell, index) => String(cell).padEnd(index ? 13 : 8)).join(""));

console.log(`Model tiers: ${rows.length} tickets since ${rows[0].startedAt.slice(0, 10)}\n`);
line(["tier", "tickets", "escalated", "strong steps", "failed", "pull request"]);
for (const tier of TIERS) {
  const group = rows.filter((row) => row.tier === tier);
  const count = (test) => group.filter(test).length;
  const share = (test) => `${count(test)} (${percent(count(test), group.length)})`;
  line([tier, group.length, share((row) => row.escalations.length), tier === "strong" ? "–" : share((row) => row.strongSteps), share((row) => row.outcome === "failed"), share((row) => row.pullRequest)]);
}

// Review/fix rounds: only pull requests the watch still knows (it forgets merged ones over time).
console.log("\nReview/fix rounds per watched pull request (mean nudges; fix = red + changes + findings):\n");
line(["tier", "watched", "fix", ...STAGES, "greptile"]);
for (const tier of TIERS) {
  const group = rows.filter((row) => row.tier === tier && row.watched);
  line([tier, group.length, mean(group.map((row) => row.fixRounds)), ...STAGES.map((stage) => mean(group.map((row) => row.nudges[stage]))), mean(group.map((row) => row.greptile))]);
}

const escalated = rows.filter((row) => row.escalations.length);
if (escalated.length) {
  console.log("\nEscalations:");
  for (const row of escalated) for (const event of row.escalations) console.log(`  ${row.identifier.padEnd(10)} ${event.at.slice(0, 16).replace("T", " ")}  ${event.reason}`);
}

console.log("\nCheap-tier tickets (spot-check their pull requests and review rounds):");
for (const row of rows.filter((item) => item.tier === "cheap")) {
  console.log(`  ${row.identifier.padEnd(10)} ${row.startedAt.slice(0, 10)}  ${(row.escalations.length ? "escalated" : row.outcome).padEnd(13)} fix ${String(row.fixRounds).padEnd(3)} ${row.pullRequest ?? ""}`);
}
