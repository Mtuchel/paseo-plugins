import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPlanPolicy, PLAN_CONTEXT_ENV, PLAN_POLICY_ENV, PLAN_POLICY_LABEL, PLAN_TICKET_ENV } from "./plan-policy";
import { paseoHome, TICKET_MCP_ENV } from "./ticket-mcp";

// What a launch gives a ticket agent's provider process besides its plan policy: its ticket, the
// saved ticket prompt and the ticket server (README, "Plan advisor", "Agent access to Linear").
// Paseo hands a session it resumes (after a daemon restart or a reload) only the daemon's own
// environment, not the one the agent was created with. Without these the omp extension neither
// gates the plan on its advisor review nor offers `record_plan_advice`, the Linear write guard and
// the ticket tools, so the launch saves them per agent and the session_open hook gives them back.
const TICKET_ENV = [PLAN_TICKET_ENV, PLAN_CONTEXT_ENV, TICKET_MCP_ENV];

export class AgentEnvs {
  constructor(private readonly directory = join(paseoHome(), "linear-tickets", "agent-env")) {}

  private path(agentId: string): string {
    return join(this.directory, `${agentId.replace(/[^0-9A-Za-z-]/g, "")}.json`);
  }

  async save(agentId: string, env: Record<string, string>): Promise<void> {
    const ticket = Object.fromEntries(TICKET_ENV.filter((name) => env[name]).map((name) => [name, env[name]]));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(agentId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(ticket), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  // {} when the launch saved nothing (an agent from before this was saved, or a failed save).
  async read(agentId: string): Promise<Record<string, string>> {
    const saved: unknown = await readFile(this.path(agentId), "utf8").then((text) => JSON.parse(text), () => null);
    if (!saved || typeof saved !== "object") return {};
    const values = saved as Record<string, unknown>;
    return Object.fromEntries(TICKET_ENV.filter((name) => typeof values[name] === "string").map((name) => [name, values[name] as string]));
  }
}

// What a session of the agent needs added to the environment it opens with. A create request
// carries the launch's own; a resumed ticket agent (labelled with its ticket, not a child agent
// such as its plan advisor) gets its policy from its label and its ticket environment from the
// saved launch environment, its ticket from its label when nothing was saved. A resumed planner
// run's agent has no ticket: its tools hang on the run label (README, "Projects").
export function sessionEnv(request: Record<string, string>, labels: Record<string, string> | undefined, saved: Record<string, string>): Record<string, string> {
  const added: Record<string, string> = {};
  const policy = labels?.[PLAN_POLICY_LABEL];
  if (!request[PLAN_POLICY_ENV] && isPlanPolicy(policy)) added[PLAN_POLICY_ENV] = policy;
  const runId = labels?.["linear.plannerRun"];
  if (labels?.["paseo.parent-agent-id"] === undefined && runId) {
    // The value is a flag to the plugin's omp extension; no Linear ticket is behind it.
    if (!request[PLAN_POLICY_ENV]) added[PLAN_POLICY_ENV] = "required";
    if (!request[PLAN_TICKET_ENV]) added[PLAN_TICKET_ENV] = `project-planner:${runId}`;
    for (const [name, value] of Object.entries(saved)) if (!request[name]) added[name] = value;
    return added;
  }
  const identifier = labels?.["linear.identifier"];
  if (request[PLAN_TICKET_ENV] || !labels?.["linear.issueId"] || !identifier || labels["paseo.parent-agent-id"]) return added;
  for (const [name, value] of Object.entries({ [PLAN_TICKET_ENV]: identifier, ...saved })) if (!request[name]) added[name] = value;
  return added;
}
