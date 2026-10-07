// The deputy's outcome report (README, "Deputy for agent questions"), run from the plugin folder:
//
//   node --import tsx scripts/deputy-report.ts
//   node --import tsx scripts/deputy-report.ts --baseline <since>..<until> --live <since>..<until> --repo <owner/name> [--repo …]
//
// Read-only on the deputy's state and the decision log. Prints the shadow evidence for the
// configured evaluator, refusals, live answers and overrides and open cases; with two equally long
// windows (ISO times) also the waiting time of questions and the owner answers per merged pull
// request (merged pull requests counted on GitHub for each --repo). Every run is also archived in
// ~/.paseo/linear-tickets/deputy/reports/, so cases outlive the decision log's retention.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { DEPUTY_DIRECTORY, readCandidates } from "../server/deputy";
import { policyVersion } from "../server/deputy-evaluator";
import { renderReport, waitStats, type Window } from "../server/deputy-report";
import { githubCli } from "../server/github-cli";
import { decisionsDirectory, DecisionLog } from "../server/owner-decisions";
import { Settings } from "../server/settings";
import { paseoHome } from "../server/ticket-mcp";

const USAGE = "usage: deputy-report.ts [--baseline <since>..<until> --live <since>..<until> [--repo <owner/name>]...]";
const run = promisify(execFile);

function window(value: string): Window {
  const [since, until] = value.split("..");
  if (!since || !until || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until)) || since >= until) throw new Error(`${JSON.stringify(value)} is not <since>..<until> in ISO time. ${USAGE}`);
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

// Pull requests merged in the window across the repositories, or null when none is given.
async function mergedPullRequests(repositories: string[], range: Window): Promise<number | null> {
  if (!repositories.length) return null;
  let total = 0;
  for (const repository of repositories) {
    const query = `repo:${repository} is:pr is:merged merged:${range.since.replace(/\.\d{3}Z$/, "Z")}..${range.until.replace(/\.\d{3}Z$/, "Z")}`;
    const { stdout } = await run(githubCli(), ["api", "-X", "GET", "search/issues", "-f", `q=${query}`, "-f", "per_page=1", "--jq", ".total_count"], { timeout: 60_000 });
    const count = Number(stdout.trim());
    if (!Number.isInteger(count)) throw new Error(`GitHub did not return a count for ${repository}`);
    total += count;
  }
  return total;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { baseline: { type: "string" }, live: { type: "string" }, repo: { type: "string", multiple: true } } });
  if (positionals.length || Boolean(values.baseline) !== Boolean(values.live)) throw new Error(USAGE);
  const home = paseoHome();
  const entries = await new DecisionLog(decisionsDirectory(home)).entries();
  const candidates = Object.values(await readCandidates(DEPUTY_DIRECTORY()));
  const { deputy } = await new Settings().read();
  const repositories = values.repo ?? [];
  let windows;
  if (values.baseline && values.live) {
    const baseline = window(values.baseline);
    const live = window(values.live);
    windows = { baseline: waitStats(entries, baseline, await mergedPullRequests(repositories, baseline)), live: waitStats(entries, live, await mergedPullRequests(repositories, live)) };
  }
  const now = new Date().toISOString();
  const report = renderReport({ entries, candidates, version: deputy.model ? policyVersion(deputy.model) : null, now, windows });
  const archive = join(DEPUTY_DIRECTORY(), "reports");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await writeFile(join(archive, `${now.replace(/[:.]/g, "-")}.md`), `${report}\n`, { mode: 0o600 });
  process.stdout.write(`${report}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
