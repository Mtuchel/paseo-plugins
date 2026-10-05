#!/usr/bin/env node
// Model tier report (README, "Model tiers"): how tickets on the cheap tier fare against the strong
// tier. Reads the plugin's tier records ($PASEO_HOME/linear-tickets/model-tiers) and handover
// records (…/handover) on this host; read-only.
//   npm run tier-report [-- --since 2026-10-01]
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
const root = join(home, "linear-tickets");
const sinceArg = process.argv.indexOf("--since");
const since = sinceArg > 0 ? Date.parse(process.argv[sinceArg + 1] ?? "") : Number.NaN;

async function records(directory) {
  const names = await readdir(directory).catch(() => []);
  const all = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(directory, name), "utf8").then(JSON.parse).catch(() => null)));
  return all.filter(Boolean);
}

const handovers = new Map((await records(join(root, "handover"))).map((record) => [record.issueId, record]));
const rows = (await records(join(root, "model-tiers")))
  .map((record) => {
    const history = record.history ?? [];
    const first = history.find((event) => event.source === "plan" || event.source === "start");
    const escalations = history.filter((event) => event.source === "escalated");
    const handover = handovers.get(record.issueId);
    return {
      identifier: record.identifier,
      startedAt: first?.at ?? record.updatedAt,
      tier: first?.tier ?? record.tier,
      escalations,
      status: handover?.status ?? "unknown",
      outcome: handover?.status === "failed" ? "failed" : handover?.links?.["Pull request"] ? "pull request" : handover?.status ?? "unknown",
      pullRequest: handover?.links?.["Pull request"] ?? null,
      model: handover?.model ?? first?.model ?? null,
    };
  })
  .filter((row) => Number.isNaN(since) || Date.parse(row.startedAt) >= since)
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

if (!rows.length) {
  console.log(`No tier records${Number.isNaN(since) ? "" : " since then"} in ${join(root, "model-tiers")}.`);
  process.exit(0);
}

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");
console.log(`Model tiers: ${rows.length} tickets since ${rows[0].startedAt.slice(0, 10)}\n`);
console.log(["tier", "tickets", "escalated", "failed", "pull request"].map((cell) => cell.padEnd(14)).join(""));
for (const tier of ["cheap", "strong"]) {
  const group = rows.filter((row) => row.tier === tier);
  const escalated = group.filter((row) => row.escalations.length).length;
  const failed = group.filter((row) => row.outcome === "failed").length;
  const withPr = group.filter((row) => row.pullRequest).length;
  console.log([tier, String(group.length), tier === "cheap" ? `${escalated} (${percent(escalated, group.length)})` : "–", `${failed} (${percent(failed, group.length)})`, `${withPr} (${percent(withPr, group.length)})`].map((cell) => cell.padEnd(14)).join(""));
}

const escalated = rows.filter((row) => row.escalations.length);
if (escalated.length) {
  console.log("\nEscalations:");
  for (const row of escalated) for (const event of row.escalations) console.log(`  ${row.identifier.padEnd(10)} ${event.at.slice(0, 16).replace("T", " ")}  ${event.reason}`);
}

console.log("\nCheap-tier tickets (spot-check their pull requests and review rounds):");
for (const row of rows.filter((item) => item.tier === "cheap")) {
  console.log(`  ${row.identifier.padEnd(10)} ${row.startedAt.slice(0, 10)}  ${(row.escalations.length ? "escalated" : row.outcome).padEnd(13)} ${row.pullRequest ?? ""}`);
}
