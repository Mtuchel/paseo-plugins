// The one-time plan-stage correction (README, "Statuses and labels"), run from the plugin folder on
// each host that runs the plugin:
//
//   node --import tsx scripts/plan-stages-migration.ts stages [--apply]
//   node --import tsx scripts/plan-stages-migration.ts review-victims [--cutoff <iso>] [--apply TUC-1,TUC-2]
//   node --import tsx scripts/plan-stages-migration.ts model-labels [--apply [--hosts-ready]] [--ungroup]
//
// Without --apply nothing is written. `stages` moves only tickets this host's parked plans, open
// reviews and queued threads prove; `review-victims` moves only the identifiers named; `model-labels`
// groups the tier labels only with --hosts-ready (both hosts run the one-write tier swap). Options:
// --team <key> (default TUC). Exits non-zero on any failure.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { AgentApi } from "../server/agent-app";
import { Credentials } from "../server/credentials";
import { LinearService } from "../server/linear";
import { AppOnlyToken } from "../server/owner-decisions";
import { ParkedPlans } from "../server/parked";
import { PeerAppUser } from "../server/peer-identity";
import { renderModelLabels, renderStages, renderVictims, runModelLabels, runReviewVictims, runStages, type HostEvidence } from "../server/plan-stages-migration";
import { SessionStore } from "../server/sessions";
import { Settings } from "../server/settings";

const run = promisify(execFile);
const USAGE = "usage: plan-stages-migration.ts stages [--apply] | review-victims [--cutoff <iso>] [--apply <TUC-1,...>] | model-labels [--apply [--hosts-ready]] [--ungroup]  [--team <key>]";

// This host's evidence: its parked plans, the session store's open reviews and queued threads, and
// the daemon's ticket agents that are not archived (`paseo ls`).
function hostEvidence(): HostEvidence {
  const parked = new ParkedPlans();
  const store = new SessionStore();
  const links = async (issueId: string) => (await store.all()).filter((link) => link.issueId === issueId && !link.closed);
  return {
    parked: (issueId) => parked.has(issueId),
    review: async (issueId) => {
      const link = (await links(issueId)).find((item) => item.review);
      return link ? { agentId: link.agentId } : null;
    },
    queued: async (issueId) => (await links(issueId)).some((link) => link.queued && !link.agentId),
    liveAgents: async (issueId) => {
      const { stdout } = await run("paseo", ["ls", "-g", "--json", "--label", `linear.issueId=${issueId}`], { maxBuffer: 16 * 1024 * 1024 });
      const agents: unknown = JSON.parse(stdout || "[]");
      return Array.isArray(agents) ? agents.flatMap((agent: unknown) => agent && typeof agent === "object" && "id" in agent && typeof agent.id === "string" && agent.id ? [agent.id] : []) : [];
    },
  };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      apply: { type: "boolean", default: false }, "hosts-ready": { type: "boolean", default: false }, ungroup: { type: "boolean", default: false },
      cutoff: { type: "string" }, team: { type: "string", default: "TUC" },
    },
    strict: false,
  });
  // Writes are authored by this host's Paseo app, like the plugin's own; its user and the peer's
  // tell review-victims which moves a Paseo app made.
  const linear = new LinearService(new Credentials(), undefined, new AgentApi(new AppOnlyToken()));
  const peer = new PeerAppUser({ settings: new Settings() });
  linear.peerAppUser = () => peer.id();
  const teamKeys = [String(values.team ?? "TUC")];
  const apply = values.apply;
  const command = positionals[0];
  if (command === "stages" && positionals.length === 1 && typeof apply !== "string") {
    const rows = await runStages({ linear, host: hostEvidence(), teamKeys, apply: apply === true });
    process.stdout.write(`${renderStages(rows, apply === true)}\n`);
    if (rows.some((row) => row.result?.startsWith("failed"))) process.exitCode = 1;
    return;
  }
  if (command === "review-victims") {
    // `--apply TUC-1,TUC-2`: parseArgs with strict off takes the list as the next positional.
    const named = apply === true ? (positionals[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean) : [];
    if (apply === true && !named.length) throw new Error("--apply needs the identifiers to move, e.g. --apply TUC-1,TUC-2");
    if (positionals.length > (apply === true ? 2 : 1)) throw new Error(USAGE);
    const cutoff = typeof values.cutoff === "string" ? new Date(values.cutoff).toISOString() : new Date().toISOString();
    const report = await runReviewVictims({ linear, host: hostEvidence(), teamKeys, cutoff, apply: named });
    process.stdout.write(`${renderVictims(report, cutoff)}\n`);
    if (report.refused.length || report.rows.some((row) => row.result?.startsWith("failed"))) process.exitCode = 1;
    return;
  }
  if (command === "model-labels" && positionals.length === 1) {
    const report = await runModelLabels({ linear, apply: apply === true, hostsReady: values["hosts-ready"] === true, ungroup: values.ungroup === true });
    process.stdout.write(`${renderModelLabels(report, apply === true)}\n`);
    if (report.duplicates.some((row) => row.result?.startsWith("failed"))) process.exitCode = 1;
    return;
  }
  throw new Error(USAGE);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
