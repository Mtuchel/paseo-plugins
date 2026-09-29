import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The omp extension reads its environment when it loads, so it is imported after this setup.
const root = mkdtempSync(join(tmpdir(), "paseo-plan-advisor-"));
const cli = join(root, "paseo");
// Stand-in for `paseo inspect <id> --json`: "astra" is a proper advisor that has answered,
// "busy" one still working, "sol" the wrong model, "stranger" someone else's Astra agent.
writeFileSync(cli, `#!/bin/sh
case "$2" in
  astra) echo '{"Model":"openai-codex/gpt-6-astra","Thinking":"medium","ParentAgentId":"planner-1","Status":"idle"}' ;;
  busy) echo '{"Model":"openai-codex/gpt-6-astra","Thinking":"medium","ParentAgentId":"planner-1","Status":"running"}' ;;
  sol) echo '{"Model":"openai-codex/gpt-6.1-sol","Thinking":"high","ParentAgentId":"planner-1","Status":"idle"}' ;;
  stranger) echo '{"Model":"openai-codex/gpt-6-astra","Thinking":"medium","ParentAgentId":"other","Status":"idle"}' ;;
  *) echo "no agent $2" >&2; exit 1 ;;
esac
`);
chmodSync(cli, 0o755);
Object.assign(process.env, { PASEO_AGENT_ID: "planner-1", PASEO_HOME: root, PASEO_CLI: cli, LINEAR_TICKETS_ISSUE: "ENG-1", LINEAR_TICKETS_CONTEXT: join(root, "ticket.md") });
const { default: extension, submittedPlan } = await import("../omp/linear-tickets-plan-first");

type Result = { content: { text: string }[] };
type Entry = { type: string; customType?: string; data?: unknown };
type Tool = { name: string; execute(id: string, params: Record<string, string>, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<Result> };
type Gate = (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<{ block: true; reason: string } | undefined>;
type Start = (event: unknown, ctx: { sessionManager: { getBranch(): Entry[] } }) => void;

function load() {
  const tools: Tool[] = [];
  const handlers: { gate?: Gate; start?: Start; tree?: Start } = {};
  const entries: Entry[] = [];
  const schema = { object: () => ({}), string: () => ({ optional: () => ({}) }), enum: () => ({}) };
  extension({
    on: (event: string, handler: Gate & Start) => {
      if (event === "tool_call") handlers.gate = handler;
      if (event === "session_start") handlers.start = handler;
      if (event === "session_tree") handlers.tree = handler;
    },
    events: { emit: () => {} },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    sendMessage: () => {},
    registerTool: (tool: Tool) => { tools.push(tool); },
    zod: schema,
  } as never);
  const cwd = mkdtempSync(join(root, "worktree-"));
  const artifacts = mkdtempSync(join(root, "artifacts-"));
  const ctx = { cwd, sessionManager: { getBranch: () => [], getArtifactsDir: () => artifacts } };
  const record = tools.find((tool) => tool.name === "record_plan_advice");
  assert.ok(record, "ticket agents get the record tool");
  assert.ok(handlers.gate && handlers.start && handlers.tree);
  const gate = handlers.gate, start = handlers.start, tree = handlers.tree;
  return {
    cwd,
    entries,
    call: (toolName: string, input: Record<string, unknown>) => gate({ toolName, input }, ctx),
    submit: (filePath: string) => gate({ toolName: "plannotator_submit_plan", input: { filePath } }, ctx),
    record: async (params: Record<string, string>) => (await record.execute("call", params, undefined, undefined, ctx)).content[0].text,
    resume: (branch: Entry[]) => start({}, { sessionManager: { getBranch: () => branch } }),
    navigate: (branch: Entry[]) => tree({}, { sessionManager: { getBranch: () => branch } }),
  };
}

const PLAN = "# Plan\n\nDo the thing.\n\n## Advisor review\n\nGPT-6 Astra, 2 rounds, agreed.\n";

test("a ticket plan cannot reach the owner until a finished GPT-6 Astra advisor review is recorded for that exact text", async () => {
  const h = load();
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  const blocked = await h.submit("PLAN.md");
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /no recorded advisor review/);
  assert.ok(blocked.reason.includes(join(root, "ticket.md")), "the steps point the advisor at the saved ticket prompt");
  assert.ok(blocked.reason.includes("omp/openai-codex/gpt-6-astra"));

  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "sol" }), /does not count as your plan advisor: it runs openai-codex\/gpt-6.1-sol/);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "stranger" }), /not created by this agent/);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "busy" }), /it is running, not idle/);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "missing" }), /Could not look up advisor missing/);
  assert.equal((await h.submit("PLAN.md"))?.block, true, "refused records do not open the gate");

  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "astra" }), /recorded/);
  assert.equal(await h.submit("PLAN.md"), undefined);

  writeFileSync(join(h.cwd, "PLAN.md"), `${PLAN}\nOne more step.\n`);
  const changed = await h.submit("PLAN.md");
  assert.equal(changed?.block, true);
  assert.match(changed.reason, /changed after its advisor review was recorded/);
});

test("a resumed session or a navigated tree keeps the advice of its own branch only", async () => {
  const h = load();
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "astra" });
  const recorded = [...h.entries];
  h.resume(recorded);
  assert.equal(await h.submit("PLAN.md"), undefined, "the recorded advice survives a resume");
  h.resume([]);
  assert.equal((await h.submit("PLAN.md"))?.block, true, "a session without the record does not inherit it");
  h.navigate(recorded);
  assert.equal(await h.submit("PLAN.md"), undefined, "navigating back to the advised branch restores it");
  h.navigate([]);
  assert.equal((await h.submit("PLAN.md"))?.block, true, "a /tree switch to a branch without the record drops it");
});

test("an unavailable advisor is recorded only with a reason the plan itself tells the owner", async () => {
  const h = load();
  writeFileSync(join(h.cwd, "PLAN.md"), "# Plan\n\nDo the thing.\n");
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "astra" }), /no "## Advisor review" section/);
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "unavailable" }), /Give the reason/);
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "unavailable", reason: "quota exhausted" }), /must tell the owner that the advisor was unavailable/);
  assert.equal((await h.submit("PLAN.md"))?.block, true);
  writeFileSync(join(h.cwd, "PLAN.md"), "# Plan\n\nDo the thing.\n\n## Advisor review\n\nThe advisor was unavailable.\n");
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "unavailable", reason: "quota exhausted" }), /with the reason you pass here/, "the owner must see why, not only that");
  writeFileSync(join(h.cwd, "PLAN.md"), "# Plan\n\nDo the thing.\n\n## Advisor review\n\nThe GPT-6 Astra advisor was unavailable: quota exhausted.\n\n## Out of scope\n\nNothing.\n");
  assert.match(await h.record({ filePath: "PLAN.md", verdict: "unavailable", reason: "quota exhausted" }), /recorded/);
  assert.equal(await h.submit("PLAN.md"), undefined, "an explained unavailable advisor lets the owner decide");
});

test("omp's local plan proposals are checked against the text the bridge would submit, and fail closed when unreadable", async () => {
  const h = load();
  const unreadable = await h.call("write", { path: "xd://propose", content: "rework" });
  assert.equal(unreadable?.block, true);
  assert.match(unreadable.reason, /could not be read/);
  // Written but not flushed to disk yet: the gate reads the same cached text the bridge would.
  assert.equal(await h.call("write", { path: "local://rework-plan.md", content: PLAN }), undefined);
  assert.match((await h.call("write", { path: "xd://propose", content: "rework" }))?.reason ?? "", /no recorded advisor review/);
  assert.match(await h.record({ filePath: "local://rework-plan.md", verdict: "agreed", advisorAgentId: "astra" }), /recorded/);
  assert.equal(await h.call("write", { path: "xd://propose", content: "rework" }), undefined);
});

test("every plan submission form is recognized, and nothing else", () => {
  assert.equal(submittedPlan("plannotator_submit_plan", { filePath: " plans/a.md " }), "plans/a.md");
  assert.equal(submittedPlan("write", { path: "xd://plannotator_submit_plan", content: JSON.stringify({ filePath: "PLAN.md" }) }), "PLAN.md");
  assert.equal(submittedPlan("write", { path: "xd://propose", content: "auth-rework" }), "local://auth-rework-plan.md");
  assert.equal(submittedPlan("write", { path: "PLAN.md", content: "# Plan" }), null);
  assert.equal(submittedPlan("write", { path: "xd://plannotator_submit_plan", content: "not json" }), null);
  assert.equal(submittedPlan("bash", { command: "ls" }), null);
});
