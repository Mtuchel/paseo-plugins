import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcceptanceTests } from "../shared/acceptance-tests";
import { paseoHome } from "./ticket-mcp";

// The acceptance tests a cheap-tier plan names (README, "Model tiers"): the plan's `## Model`
// section lists the test files that prove it, the implementing agent hands the strong model the
// job of writing them failing first, and the cheap model must not edit them afterwards. The plugin
// writes the plan's paths here for the agent that implements it — at the plan's approval and at
// every launch of an approved cheap plan — and the omp extension
// (omp/linear-tickets-plan-first.ts) reads them by its agent id and refuses a session that is not
// on the strong model. One file per agent, named by its Paseo agent id, like the plan requests
// (plan-requests.ts); keep the two in sync. `shared/acceptance-tests.ts` holds the rules, and the
// strong model's own name travels in the launch environment (`STRONG_MODEL_ENV`).
export function acceptanceTestsDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "acceptance-tests");
}

export class AcceptanceTestsStore {
  constructor(private readonly directory = acceptanceTestsDirectory()) {}

  // Overwrites an earlier save: a replanned ticket replaces the tests its predecessor named.
  async save(agentId: string, tests: AcceptanceTests): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, agentId);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...tests, at: new Date().toISOString() }), { mode: 0o600 });
    await rename(temporary, path);
  }

  // A strong tier, a plan that names no tests, or a plan the owner approved without one: the
  // agent's paths stop being protected.
  async clear(agentId: string): Promise<void> {
    await rm(join(this.directory, agentId), { force: true });
  }
}