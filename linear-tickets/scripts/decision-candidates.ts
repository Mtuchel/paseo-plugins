// The weekly decision candidates (README, "Decision candidates"), run from the plugin folder:
//
//   node --import tsx scripts/decision-candidates.ts collect
//   node --import tsx scripts/decision-candidates.ts file --batch <until> --input <candidates.json> [--dry-run]
//
// `collect` prints the owner's decisions of the window, earlier candidate tickets and the
// principles register as Markdown; `file` files the chosen candidates, at most one ticket per
// project, written only as the Paseo app. Options: --repo <tuchel-platform checkout> (default
// ~/tuchel-platform), --team <key> (default TUC). Exits non-zero on any failure.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AgentApi } from "../server/agent-app";
import { oldestRecord, recordedComments } from "../server/agent-records";
import { Credentials } from "../server/credentials";
import { LinearService } from "../server/linear";
import { agentTicketIds, AppOnlyToken, AppWriter, decisionsDirectory, DecisionLog, readRegister, runCollect, runFile } from "../server/owner-decisions";
import { paseoHome } from "../server/ticket-mcp";

const USAGE = "usage: decision-candidates.ts collect | file --batch <until> --input <file.json> [--dry-run]  [--repo <path>] [--team <key>]";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { batch: { type: "string" }, input: { type: "string" }, "dry-run": { type: "boolean", default: false }, repo: { type: "string" }, team: { type: "string", default: "TUC" } },
  });
  const home = paseoHome();
  const directory = decisionsDirectory(home);
  const linear = new LinearService(new Credentials());
  const teamKey = values.team ?? "TUC";
  const now = () => Date.now();
  if (positionals[0] === "collect" && positionals.length === 1) {
    const repository = values.repo ?? join(homedir(), "tuchel-platform");
    const { markdown } = await runCollect({
      directory, linear, teamKey, now,
      log: new DecisionLog(directory),
      register: () => readRegister(repository),
      recorded: () => recordedComments(join(home, "linear-tickets")),
      recordsFrom: () => oldestRecord(join(home, "linear-tickets")),
      agentTickets: () => agentTicketIds(home),
      ruleSources: [
        `${fileURLToPath(new URL("../README.md", import.meta.url))} (the linear-tickets plugin's rules for agents)`,
        `${join(home, "linear-tickets", "settings.json")}, field \`template\` (the launch prompt every ticket agent gets)`,
      ],
    });
    process.stdout.write(`${markdown}\n`);
    return;
  }
  if (positionals[0] === "file" && positionals.length === 1 && values.batch && values.input) {
    const input: unknown = JSON.parse(await readFile(values.input, "utf8"));
    const reports = await runFile({ directory, linear, teamKey, now, batch: values.batch, input, dryRun: values["dry-run"] ?? false, writer: new AppWriter(new AgentApi(new AppOnlyToken())) });
    if (!reports.length) process.stdout.write("Nothing to file.\n");
    for (const report of reports) {
      const where = report.ticket ?? (values["dry-run"] ? "(dry run: not written)" : "-");
      process.stdout.write(`${report.project}: ${report.action} ${where}\n${report.proposals.map((proposal) => `  + ${proposal}\n`).join("")}${report.skipped.map((skipped) => `  - ${skipped}\n`).join("")}`);
    }
    return;
  }
  throw new Error(USAGE);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
