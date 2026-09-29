import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The omp extension reads its environment when it loads, so it is imported after this setup.
const root = mkdtempSync(join(tmpdir(), "paseo-plan-advisor-"));
const cli = join(root, "paseo");
// Stand-in for `paseo inspect <id> --json`: "astra" is a proper advisor, "sol" the wrong model,
// "stranger" someone else's Astra agent.
writeFileSync(cli, `#!/bin/sh
case "$2" in
  astra) echo '{"Model":"openai-codex/gpt-6-astra","Thinking":"medium","ParentAgentId":"planner-1"}' ;;
  sol) echo '{"Model":"openai-codex/gpt-6.1-sol","Thinking":"high","ParentAgentId":"planner-1"}' ;;
  stranger) echo '{"Model":"openai-codex/gpt-6-astra","Thinking":"medium","ParentAgentId":"other"}' ;;
  *) echo "no agent $2" >&2; exit 1 ;;
esac
`);
chmodSync(cli, 0o755);
Object.assign(process.env, { PASEO_AGENT_ID: "planner-1", PASEO_HOME: root, PASEO_CLI: cli, LINEAR_TICKETS_CONTEXT: join(root, "ticket.md") });
const { default: extension, submittedPlan } = await import("../omp/linear-tickets-plan-first");

type Result = { content: { text: string }[] };
type Tool = { name: string; execute(id: string, params: Record<string, string>, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<Result> };
type Gate = (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<{ block: true; reason: string } | undefined>;

function load() {
  const tools: Tool[] = [];
  const gates: Gate[] = [];
  const entries: unknown[] = [];
  const schema = { object: () => ({}), string: () => ({ optional: () => ({}) }), enum: () => ({}) };
  extension({
    on: (event: string, handler: Gate) => { if (event === "tool_call") gates.push(handler); },
    events: { emit: () => {} },
    appendEntry: (_type: string, data: unknown) => { entries.push(data); },
    sendMessage: () => {},
    registerTool: (tool: Tool) => { tools.push(tool); },
    zod: schema,
  } as never);
  const cwd = mkdtempSync(join(root, "worktree-"));
  const ctx = { cwd, sessionManager: { getBranch: () => [] } };
  const record = tools.find((tool) => tool.name === "record_plan_advice");
  assert.ok(record, "ticket agents get the record tool");
  return {
    cwd,
    entries,
    submit: (filePath: string) => gates[0]({ toolName: "plannotator_submit_plan", input: { filePath } }, ctx),
    record: async (params: Record<string, string>) => (await record.execute("call", params, undefined, undefined, ctx)).content[0].text,
  };
}

const PLAN = "# Plan\n\nDo the thing.\n\n## Advisor review\n\nGPT-6 Astra, 2 rounds, agreed.\n";

test("a ticket plan cannot reach the owner until its GPT-6 Astra advisor review is recorded for that exact text", async () => {
  const h = load();
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  const blocked = await h.submit("PLAN.md");
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /no recorded advisor review/);
  assert.ok(blocked.reason.includes(join(root, "ticket.md")), "the steps point the advisor at the saved ticket prompt");
  assert.ok(blocked.reason.includes("omp/openai-codex/gpt-6-astra"));

  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "sol" }), /not your plan advisor: it runs openai-codex\/gpt-6.1-sol/);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "stranger" }), /not created by this agent/);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "missing" }), /Could not look up advisor missing/);
  assert.equal((await h.submit("PLAN.md"))?.block, true, "refused records do not open the gate");

  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "astra" }), /recorded/);
  assert.equal(await h.submit("PLAN.md"), undefined);
  assert.equal(h.entries.length, 1, "the record survives a session resume");

  writeFileSync(join(h.cwd, "PLAN.md"), `${PLAN}\nOne more step.\n`);
  const changed = await h.submit("PLAN.md");
  assert.equal(changed?.block, true);
  assert.match(changed.reason, /changed after its advisor review was recorded/);
});

test("a plan without its advisor section, or an unavailable advisor without a reason, is not recorded", async () => {
  const h = load();
  writeFileSync(join(h.cwd, "PLAN.md"), "# Plan\n\nDo the thing.\n");
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "astra" }), /no "## Advisor review" section/);
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "unavailable" }), /Give the reason/);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "unavailable", reason: "Astra quota exhausted" }), /recorded/);
  assert.equal(await h.submit("PLAN.md"), undefined, "an explained unavailable advisor lets the owner decide");
});

test("every plan submission form is recognized, and nothing else", () => {
  assert.equal(submittedPlan("plannotator_submit_plan", { filePath: " plans/a.md " }), "plans/a.md");
  assert.equal(submittedPlan("write", { path: "xd://plannotator_submit_plan", content: JSON.stringify({ filePath: "PLAN.md" }) }), "PLAN.md");
  assert.equal(submittedPlan("write", { path: "xd://propose", content: "auth-rework" }), "local://auth-rework-plan.md");
  assert.equal(submittedPlan("write", { path: "PLAN.md", content: "# Plan" }), null);
  assert.equal(submittedPlan("write", { path: "xd://plannotator_submit_plan", content: "not json" }), null);
  assert.equal(submittedPlan("bash", { command: "ls" }), null);
});
