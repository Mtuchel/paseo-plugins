import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import { AgentEnvs, sessionEnv } from "./agent-env";
import { normalizeIssue } from "./context";
import { Launcher } from "./launch";

const ISSUE_ID = "6b1f0c2a-1111-4222-8333-444455556666";
const detail = { issue: normalizeIssue({ id: ISSUE_ID, identifier: "ENG-42", title: "Fix sign-in", url: "https://linear.app/x/issue/ENG-42" }), teamId: "team-1", projectId: "lp-1", context: "{}", warnings: [], relations: { parent: null, subissues: [], related: [] } };
const input = { id: ISSUE_ID, projectId: "project-1", provider: "omp", instructions: "", markInProgress: false, requestId: "5f6f1154-5838-4439-b981-b3c9d9831488" };
const noMark = { markInProgress: async () => ({ changed: false }), finishedBlockers: async () => [] };

// Paseo hands a resumed session (after a daemon restart, a reload) only the daemon's environment,
// not the one the agent was created with. On server087 on 2026-10-05 every ticket agent resumed
// after the daemon crash ran without LINEAR_TICKETS_ISSUE: the omp extension then offered no
// `record_plan_advice` and did not gate the submission, so 11 plans reached the risk policy with
// "no advisor review was recorded for this plan text".
test("a resumed ticket agent gets back the ticket environment its launch gave it, so the omp extension still gates its plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-agent-env-"));
  try {
    const envs = new AgentEnvs(directory);
    let created: PaseoWorkspaceAgentCreateOptions | undefined;
    const paseo = {
      projects: { list: async () => ({ projects: [{ projectId: "project-1", projectKind: "directory", projectRootPath: "/repo" }] }) },
      workspaces: { create: async () => ({ agents: { create: async (options: PaseoWorkspaceAgentCreateOptions) => { created = options; return { id: "agent-1" }; } } }) },
    } as unknown as PaseoApi;
    const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/s.mjs", undefined, async () => "/ctx/agent-1.md", () => true, envs);
    await launcher.start(input, paseo, { linearAccess: true, env: { LINEAR_TICKETS_PLAN: "required" }, labels: { "linear.plan": "required" } });
    const launched = created!.env!;
    assert.equal(launched.LINEAR_TICKETS_ISSUE, "ENG-42");

    // The create itself carries the launch's environment: nothing to add.
    assert.deepEqual(sessionEnv(launched, created!.labels, await envs.read("agent-1")), {});
    // The resume carries none of it: the agent gets all of it back.
    assert.deepEqual(sessionEnv({}, created!.labels, await envs.read("agent-1")), launched);

    // An agent launched before its environment was saved still gets its ticket from its labels:
    // enough for the plan gate, `record_plan_advice` and the Linear write guard.
    assert.deepEqual(sessionEnv({}, created!.labels, await envs.read("agent-0")), { LINEAR_TICKETS_PLAN: "required", LINEAR_TICKETS_ISSUE: "ENG-42" });
    // A plan advisor or any other child agent of a ticket agent is not a ticket agent.
    assert.deepEqual(sessionEnv({}, { ...created!.labels, "paseo.parent-agent-id": "agent-1" }, await envs.read("agent-1")), { LINEAR_TICKETS_PLAN: "required" });
    // Nor is an agent without a ticket.
    assert.deepEqual(sessionEnv({}, {}, {}), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});
