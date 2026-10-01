import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// The omp extension reads its environment when it loads, so it is imported after this setup.
const root = mkdtempSync(join(tmpdir(), "paseo-plan-advisor-"));
const cli = join(root, "paseo");
// Stand-in for `paseo inspect <id> --json`: "astra" is a proper advisor that has answered,
// "busy" one still working, "sol" the wrong model, "stranger" someone else's Astra agent.
// Every lookup is logged, so a test can tell whether a record was checked again.
writeFileSync(cli, `#!/bin/sh
echo "$2" >> "$PASEO_HOME/inspect.log"
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
type Gate = (event: { toolName: string; toolCallId?: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<{ block: true; reason: string } | undefined>;
type Start = (event: unknown, ctx: { sessionManager: { getBranch(): Entry[] } }) => void;

const inspections = () => (existsSync(join(root, "inspect.log")) ? readFileSync(join(root, "inspect.log"), "utf8").split("\n").filter(Boolean).length : 0);

function load() {
  const tools: Tool[] = [];
  const handlers: { gate?: Gate; start?: Start; tree?: Start; turn?: () => void } = {};
  const entries: Entry[] = [];
  const schema = { object: () => ({}), string: () => ({ optional: () => ({}) }), enum: () => ({}) };
  extension({
    on: (event: string, handler: Gate & Start) => {
      if (event === "tool_call") handlers.gate = handler;
      if (event === "session_start") handlers.start = handler;
      if (event === "session_tree") handlers.tree = handler;
      if (event === "turn_start") handlers.turn = handler as unknown as () => void;
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
  assert.ok(handlers.gate && handlers.start && handlers.tree && handlers.turn);
  const gate = handlers.gate, start = handlers.start, tree = handlers.tree, turn = handlers.turn;
  return {
    cwd,
    entries,
    call: (toolName: string, input: Record<string, unknown>) => gate({ toolName, input }, ctx),
    submit: (filePath: string) => gate({ toolName: "plannotator_submit_plan", input: { filePath } }, ctx),
    record: async (params: Record<string, string>) => (await record.execute("call", params, undefined, undefined, ctx)).content[0].text,
    // omp's dispatch of one assistant message: every call's tool_call handler in order, then the tools.
    hook: (toolName: string, toolCallId: string, input: Record<string, unknown>, agent?: { kind: string }) => gate({ toolName, toolCallId, input }, { ...ctx, agent }),
    run: async (toolCallId: string, params: Record<string, string>) => (await record.execute(toolCallId, params, undefined, undefined, ctx)).content[0].text,
    turn,
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
  h.turn();
  assert.match((await h.call("write", { path: "xd://propose", content: "rework" }))?.reason ?? "", /no recorded advisor review/);
  assert.match(await h.record({ filePath: "local://rework-plan.md", verdict: "agreed", advisorAgentId: "astra" }), /recorded/);
  assert.equal(await h.call("write", { path: "xd://propose", content: "rework" }), undefined);
});

test("a record and a submission in the same message count in that order: omp runs every call's handler before any tool", async () => {
  const h = load();
  const astra = { filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "astra" };
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  writeFileSync(join(h.cwd, "OTHER.md"), PLAN.replace("Do the thing.", "Do another thing."));

  // Submission first: the review is not recorded yet when its handler runs.
  assert.match((await h.hook("plannotator_submit_plan", "s1", { filePath: "PLAN.md" }))?.reason ?? "", /no recorded advisor review/);
  h.turn();

  // Record first: its handler checks it, so the submission's handler already sees the review,
  // and the record's execute returns that result without looking the advisor up again.
  const before = inspections();
  assert.equal(await h.hook("record_plan_advice", "r1", astra), undefined);
  assert.equal(await h.hook("plannotator_submit_plan", "s2", { filePath: "PLAN.md" }), undefined);
  assert.match(await h.run("r1", astra), /Advisor review recorded for PLAN.md/);
  assert.equal(inspections(), before + 1);
  assert.equal(h.entries.filter((entry) => entry.customType === "linear-tickets.plan-advice").length, 1);
  // A review of one plan does not cover another.
  assert.equal((await h.hook("plannotator_submit_plan", "s3", { filePath: "OTHER.md" }))?.block, true);
  h.turn();

  // A refused record opens nothing new and keeps the earlier review of the same text.
  assert.equal(await h.hook("record_plan_advice", "r2", { ...astra, advisorAgentId: "sol" }), undefined);
  assert.equal(await h.hook("plannotator_submit_plan", "s4", { filePath: "PLAN.md" }), undefined);
  assert.match(await h.run("r2", astra), /does not count as your plan advisor/);
  h.turn();
  assert.equal(await h.hook("record_plan_advice", "r3", { ...astra, filePath: "OTHER.md", advisorAgentId: "sol" }), undefined);
  assert.equal((await h.hook("plannotator_submit_plan", "s5", { filePath: "OTHER.md" }))?.block, true);
  h.turn();

  // The file changed on disk between the record's handler and the submission's.
  assert.equal(await h.hook("record_plan_advice", "r4", astra), undefined);
  writeFileSync(join(h.cwd, "PLAN.md"), `${PLAN}\nOne more step.\n`);
  assert.match((await h.hook("plannotator_submit_plan", "s6", { filePath: "PLAN.md" }))?.reason ?? "", /changed after its advisor review was recorded/);

  // A checked record whose execute never ran in its turn is checked again when it does run.
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  assert.equal(await h.hook("record_plan_advice", "r5", astra), undefined);
  h.turn();
  const stale = inspections();
  assert.match(await h.run("r5", astra), /recorded/);
  assert.equal(inspections(), stale + 1);
});

test("a plan write or edit queued in the same message keeps that message's record and submission from vouching for it", async () => {
  const h = load();
  const astra = { filePath: "PLAN.md", verdict: "agreed", advisorAgentId: "astra" };
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);

  // Record, then a queued write of the plan, then the submission: the file on disk is still the
  // reviewed text when the submission's handler runs, but the write would change it before it is sent.
  assert.equal(await h.hook("record_plan_advice", "r1", astra), undefined);
  assert.equal(await h.hook("write", "w1", { path: "PLAN.md", content: `${PLAN}\nMore.\n` }), undefined);
  assert.match((await h.hook("plannotator_submit_plan", "s1", { filePath: "PLAN.md" }))?.reason ?? "", /changed after its advisor review was recorded/);
  h.turn();
  // An edit (omp passes a hashline patch's targets as `paths`) holds it back the same way.
  assert.equal(await h.hook("edit", "e1", { input: "[PLAN.md#ABCD]\n…", paths: ["PLAN.md"], path: "PLAN.md" }), undefined);
  assert.equal((await h.hook("plannotator_submit_plan", "s2", { filePath: "PLAN.md" }))?.block, true);
  h.turn();
  // So does an apply_patch edit, which names its targets only in the patch headers.
  assert.equal(await h.hook("record_plan_advice", "r9", astra), undefined);
  assert.equal(await h.hook("edit", "e2", { input: "*** Begin Patch\n*** Update File: PLAN.md\n@@\n-Do the thing.\n+Do it.\n*** End Patch" }), undefined);
  assert.match((await h.hook("plannotator_submit_plan", "s7", { filePath: "PLAN.md" }))?.reason ?? "", /changed after its advisor review was recorded/);
  h.turn();
  assert.equal(await h.hook("edit", "e3", { input: "*** Begin Patch\n*** Update File: draft.txt\n*** Move to: PLAN.md\n*** End Patch" }), undefined);
  assert.equal((await h.hook("plannotator_submit_plan", "s8", { filePath: "PLAN.md" }))?.block, true);
  h.turn();
  // Writes to other files do not.
  assert.equal(await h.hook("write", "w2", { path: "notes.txt", content: "x" }), undefined);
  assert.equal(await h.hook("plannotator_submit_plan", "s3", { filePath: "PLAN.md" }), undefined);
  h.turn();

  // A queued write before the record: the record refuses, with or without an earlier review,
  // and the submission is held back.
  for (const fresh of [false, true]) {
    const g = fresh ? load() : h;
    writeFileSync(join(g.cwd, "PLAN.md"), PLAN);
    assert.equal(await g.hook("write", "w3", { path: "PLAN.md", content: PLAN }), undefined);
    assert.equal(await g.hook("record_plan_advice", "r2", astra), undefined);
    assert.equal((await g.hook("plannotator_submit_plan", "s4", { filePath: "PLAN.md" }))?.block, true);
    assert.match(await g.run("r2", astra), /queued in this step/);
    g.turn();
    // Next message: the write has run, so record and submit go through.
    assert.equal(await g.hook("record_plan_advice", "r3", astra), undefined);
    assert.equal(await g.hook("plannotator_submit_plan", "s5", { filePath: "PLAN.md" }), undefined);
    assert.match(await g.run("r3", astra), /recorded/);
  }
});

test("subagents are not held to the advisor rule; the ticket agent is", async () => {
  const h = load();
  writeFileSync(join(h.cwd, "PLAN.md"), PLAN);
  assert.equal(await h.hook("plannotator_submit_plan", "s1", { filePath: "PLAN.md" }, { kind: "sub" }), undefined);
  assert.equal((await h.hook("plannotator_submit_plan", "s2", { filePath: "PLAN.md" }, { kind: "main" }))?.block, true);
  assert.equal((await h.hook("plannotator_submit_plan", "s3", { filePath: "PLAN.md" }))?.block, true);
});

test("every plan submission form is recognized, and nothing else", () => {
  assert.equal(submittedPlan("plannotator_submit_plan", { filePath: " plans/a.md " }), "plans/a.md");
  assert.equal(submittedPlan("write", { path: "xd://plannotator_submit_plan", content: JSON.stringify({ filePath: "PLAN.md" }) }), "PLAN.md");
  assert.equal(submittedPlan("write", { path: "xd://propose", content: "auth-rework" }), "local://auth-rework-plan.md");
  assert.equal(submittedPlan("write", { path: "PLAN.md", content: "# Plan" }), null);
  assert.equal(submittedPlan("write", { path: "xd://plannotator_submit_plan", content: "not json" }), null);
  assert.equal(submittedPlan("bash", { command: "ls" }), null);
});

test("ticket agents and their subagents change Linear only through the linear_ticket tools", async () => {
  const h = load();
  const blocked = [
    h.call("mcp__linear_save_comment", { issueId: "ENG-1", body: "x" }),
    h.call("write", { path: "xd://mcp__linear_save_issue", content: "{}" }),
    h.call("mcp__linear_new_tool", {}),
    h.hook("mcp__linear_save_comment", "s1", { issueId: "ENG-1", body: "x" }, { kind: "sub" }),
  ];
  const names = ["mcp__linear_save_comment", "mcp__linear_save_issue", "mcp__linear_new_tool", "mcp__linear_save_comment"];
  for (const [index, result] of (await Promise.all(blocked)).entries()) {
    assert.equal(result?.block, true, names[index]);
    assert.match(result.reason, /^Stopped by the linear-tickets plugin: ticket agents change Linear only through the linear_ticket tools/);
    assert.ok(result.reason.includes(names[index]));
  }
  assert.equal(await h.call("mcp__linear_get_issue", { id: "ENG-1" }), undefined);
  assert.equal(await h.call("write", { path: "xd://mcp__linear_list_issues", content: "{}" }), undefined);
  assert.equal(await h.call("mcp__linear_ticket_add_comment", { body: "x" }), undefined);
});

test("outside ticket agents the Linear tools are not blocked", async () => {
  // The extension reads LINEAR_TICKETS_ISSUE when it loads, so each case loads it in its own
  // process with an environment built from scratch (the test's own may name a ticket).
  const script = `
    const { default: extension } = await import(process.env.EXTENSION);
    let gate;
    extension({ on: (event, handler) => { if (event === "tool_call") gate = handler; }, events: { emit() {} }, appendEntry() {}, sendMessage() {}, registerTool() {}, zod: { object: () => ({}), string: () => ({ optional: () => ({}) }), enum: () => ({}) } });
    const result = await gate({ toolName: "mcp__linear_save_comment", input: { issueId: "ENG-1", body: "x" } }, { sessionManager: { getBranch: () => [] } });
    process.stdout.write(JSON.stringify(result ?? null));
  `;
  const outcome = async (extra: Record<string, string>) => {
    const env = { PATH: process.env.PATH ?? "", PASEO_AGENT_ID: "solo-1", PASEO_HOME: root, EXTENSION: new URL("../omp/linear-tickets-plan-first.ts", import.meta.url).href, ...extra };
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), env });
    return JSON.parse(stdout) as { block?: boolean } | null;
  };
  assert.equal(await outcome({}), null);
  assert.equal((await outcome({ LINEAR_TICKETS_ISSUE: "ENG-1" }))?.block, true, "the same load blocks it for a ticket agent");
});
