import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { PlanRequests, planRequestText } from "./plan-requests";
import type { PromptOutcome } from "./sessions";

type Outcome = PromptOutcome;

async function harness(run: (h: { requests: PlanRequests; labels: Map<string, string[]>; prompts: string[]; outcome: { next: Outcome }; files: () => Promise<string[]>; directory: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-requests-"));
  const labels = new Map<string, string[]>([["issue-1", []]]);
  const prompts: string[] = [];
  const outcome = { next: "sent" as Outcome };
  const paseo = {
    agents: { list: async () => ({ entries: [{ agent: { id: "agent-1", labels: { "linear.issueId": "issue-1", "linear.identifier": "TUC-7" } } }, { agent: { id: "sub-1", labels: { "linear.issueId": "issue-1", "paseo.parent-agent-id": "agent-1" } } }], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const requests = new PlanRequests({
    linear: { issueLabels: async (ids) => new Map(ids.filter((id) => labels.has(id)).map((id) => [id, labels.get(id)!])) },
    prompt: async (agentId, text) => { prompts.push(`${agentId}: ${text}`); return outcome.next; },
    directory,
  });
  requests.attach(paseo);
  try {
    await requests.poll();
    await run({ requests, labels, prompts, outcome, directory, files: async () => (await readdir(directory)).filter((name) => name !== "state.json").sort() });
  } finally {
    requests.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

test("adding the plan label to a running agent's ticket writes one request for the agent and tells it once", async () => {
  await harness(async ({ requests, labels, prompts, files }) => {
    assert.deepEqual(prompts, []);
    labels.set("issue-1", ["plan"]);
    await requests.poll();
    assert.deepEqual(await files(), ["agent-1"]);
    assert.deepEqual(prompts, [`agent-1: ${planRequestText("TUC-7")}`]);
    await requests.poll();
    assert.equal(prompts.length, 1);
  });
});

test("a label present when the agent is first seen was the launch's reason and requests nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-requests-"));
  try {
    const prompts: string[] = [];
    const requests = new PlanRequests({ linear: { issueLabels: async () => new Map([["issue-1", ["plan"]]]) }, prompt: async (agentId) => { prompts.push(agentId); return "sent"; }, directory });
    requests.attach({ agents: { list: async () => ({ entries: [{ agent: { id: "agent-1", labels: { "linear.issueId": "issue-1" } } }], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi);
    await requests.poll();
    await requests.poll();
    requests.stop();
    assert.deepEqual(prompts, []);
    assert.deepEqual((await readdir(directory)).filter((name) => name !== "state.json"), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a busy, waiting or crashed agent is told on a later poll unless its omp extension already took the request", async () => {
  // A crashed agent is not restarted here: the pull request watch restarts it. A waiting one has a
  // question open for the owner; the request waits until it takes messages again.
  for (const waiting of ["busy", "waiting", "crashed"] as const) {
    await harness(async ({ requests, labels, prompts, outcome, directory }) => {
      labels.set("issue-1", ["plan"]);
      outcome.next = waiting;
      await requests.poll();
      await requests.poll();
      assert.equal(prompts.length, 2, waiting);
      // The extension removes the file once the agent is planning: nothing left to say.
      await rm(join(directory, "agent-1"));
      await requests.poll();
      assert.equal(prompts.length, 2, waiting);
    });
  }
});

test("removing the label before delivery withdraws the request, and adding it again requests again", async () => {
  await harness(async ({ requests, labels, prompts, outcome, files }) => {
    labels.set("issue-1", ["plan"]);
    outcome.next = "busy";
    await requests.poll();
    labels.set("issue-1", []);
    await requests.poll();
    assert.deepEqual(await files(), []);
    outcome.next = "sent";
    labels.set("issue-1", ["plan"]);
    await requests.poll();
    assert.deepEqual(await files(), ["agent-1"]);
    assert.equal(prompts.length, 2);
  });
});

test("a ticket Linear does not return keeps its state, and requests of agents that are gone are removed", async () => {
  await harness(async ({ requests, labels, prompts, files, directory }) => {
    labels.delete("issue-1");
    await requests.poll();
    labels.set("issue-1", ["plan"]);
    await requests.poll();
    assert.equal(prompts.length, 1);
    await writeFile(join(directory, "archived-agent"), "{}");
    await requests.poll();
    assert.deepEqual(await files(), ["agent-1"]);
  });
});
