// The weekly ops review (README, "Ops digest and weekly ops review"), run from the plugin folder:
//
//   node --import tsx scripts/ops-review.ts collect [--now <iso>]
//   node --import tsx scripts/ops-review.ts file [--dry-run] [--now <iso>]
//
// `collect` prints the per-kind table of the last 7 days against the 7 before, the headline numbers
// and the kinds' tickets; `file --dry-run` prints what `file` would create, comment, check and
// reopen; `file` does it, written only as the Paseo app, and writes trend.json for the digest's
// Trend section. Run `file` on server087 only. Options: --history <dir> (default
// $PASEO_HOME/ops-digest), --team <key> (default TUC). Exits non-zero on any failure.
import { parseArgs } from "node:util";
import { AgentApi } from "../server/agent-app";
import { Credentials } from "../server/credentials";
import { LinearService } from "../server/linear";
import { mergedPullRequests, opsDirectory, renderFileReport, runCollect, runFile } from "../server/ops-review";
import { AppOnlyToken, AppWriter } from "../server/owner-decisions";

const USAGE = "usage: ops-review.ts collect [--now <iso>] | file [--dry-run] [--now <iso>]  [--history <dir>] [--team <key>]";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, now: { type: "string" }, history: { type: "string" }, team: { type: "string", default: "TUC" } },
  });
  const now = values.now ? Date.parse(values.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error(`--now is not a time: ${values.now}`);
  const api = new AgentApi(new AppOnlyToken());
  const deps = {
    directory: values.history ?? opsDirectory(),
    linear: new LinearService(new Credentials()),
    appViewerId: async () => (await api.viewer()).id,
    mergedPullRequests,
    teamKey: values.team ?? "TUC",
    now,
  };
  if (positionals[0] === "collect" && positionals.length === 1) {
    process.stdout.write(`${await runCollect(deps)}\n`);
    return;
  }
  if (positionals[0] === "file" && positionals.length === 1) {
    const dryRun = values["dry-run"] ?? false;
    const report = await runFile({ ...deps, writer: new AppWriter(api), dryRun });
    process.stdout.write(`${renderFileReport(report, dryRun)}\n`);
    return;
  }
  throw new Error(USAGE);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
