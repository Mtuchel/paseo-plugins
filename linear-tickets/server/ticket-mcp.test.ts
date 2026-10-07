import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import { LINEAR_ACCESS_NOTE, NO_LINEAR_ACCESS_NOTE } from "../shared/contracts";
import { buildPrompt, normalizeIssue } from "./context";
import { Launcher } from "./launch";
import { LinearBroker } from "./linear-broker";
import { LinearUsage } from "./linear-usage";
import { RateBudget } from "./rate-budget";
import { Settings } from "./settings";
import { ticketMcpServer, writeTicketMcpScript } from "./ticket-mcp";
import { postedComments } from "./agent-records";

// Launches save the ticket prompt for the plan advisor under PASEO_HOME; keep it out of the real one.
process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "paseo-ticket-mcp-home-"));

const ISSUE_ID = "6b1f0c2a-1111-4222-8333-444455556666";
const detail = { issue: normalizeIssue({ id: ISSUE_ID, identifier: "ENG-42", title: "Fix sign-in", url: "https://linear.app/x/issue/ENG-42" }), teamId: "team-1", projectId: "lp-1", context: "{}", warnings: [], relations: { parent: null, subissues: [], related: [] } };
const input = { id: ISSUE_ID, projectId: "project-1", provider: "test/model", instructions: "", markInProgress: false, requestId: "5f6f1154-5838-4439-b981-b3c9d9831488" };
const noMark = { markInProgress: async () => ({ changed: false }), finishedBlockers: async () => [] };

function capturePaseo(onCreate: (options: PaseoWorkspaceAgentCreateOptions) => void) {
  return {
    projects: { list: async () => ({ projects: [{ projectId: "project-1", projectKind: "directory", projectRootPath: "/repo" }] }) },
    workspaces: { create: async () => ({ agents: { create: async (options: PaseoWorkspaceAgentCreateOptions) => { onCreate(options); return { id: "agent-1" }; } } }) },
  } as unknown as PaseoApi;
}

test("a launch with Linear access injects a ticket-scoped MCP server that carries no key", async () => {
  let options: PaseoWorkspaceAgentCreateOptions | undefined;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/home/.paseo/linear-tickets/ticket-mcp-abc.mjs");
  await launcher.start(input, capturePaseo((value) => { options = value; }), { linearAccess: true });
  const servers = (options?.config as { mcpServers?: Record<string, { type: string; command: string; args: string[] }> }).mcpServers;
  assert.deepEqual(Object.keys(servers ?? {}), ["linear_ticket"]);
  const server = servers!.linear_ticket;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args.slice(0, 3), ["/home/.paseo/linear-tickets/ticket-mcp-abc.mjs", "--issue", ISSUE_ID]);
  assert.ok(!JSON.stringify(options).match(/lin_api|apiKey|LINEAR_API_KEY|access_token|Bearer/));
  assert.ok(options?.prompt?.includes(LINEAR_ACCESS_NOTE));
  assert.ok(!options?.prompt?.includes(NO_LINEAR_ACCESS_NOTE));
});

test("a launch without Linear access adds no MCP server and keeps the no-write instruction", async () => {
  let options: PaseoWorkspaceAgentCreateOptions | undefined;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => { throw new Error("Should not write the script"); });
  await launcher.start(input, capturePaseo((value) => { options = value; }), { linearAccess: false });
  assert.equal((options?.config as { mcpServers?: unknown }).mcpServers, undefined);
  assert.ok(options?.prompt?.includes(NO_LINEAR_ACCESS_NOTE));
});

test("the MCP server runs on the daemon's runtime, as Node even under Electron", () => {
  const plain = ticketMcpServer("/s.mjs", ISSUE_ID, "/home", { execPath: "/usr/bin/node", electron: false });
  assert.deepEqual(plain, { type: "stdio", command: "/usr/bin/node", args: ["/s.mjs", "--issue", ISSUE_ID, "--paseo-home", "/home"] });
  const electron = ticketMcpServer("/s.mjs", ISSUE_ID, "/home", { execPath: "/Applications/Paseo.app/Helper", electron: true });
  assert.equal(electron.command, "/Applications/Paseo.app/Helper");
  assert.deepEqual(electron.env, { ELECTRON_RUN_AS_NODE: "1" });
});

test("a null issue id launches the MCP server read-only", () => {
  const plain = ticketMcpServer("/s.mjs", null, "/home", { execPath: "/usr/bin/node", electron: false });
  assert.deepEqual(plain, { type: "stdio", command: "/usr/bin/node", args: ["/s.mjs", "--read-only", "--paseo-home", "/home"] });
  const electron = ticketMcpServer("/s.mjs", null, "/home", { execPath: "/Applications/Paseo.app/Helper", electron: true });
  assert.deepEqual(electron.env, { ELECTRON_RUN_AS_NODE: "1" });
});

test("a provider that reports no MCP support gets a launch warning", async () => {
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "project-1", projectKind: "directory", projectRootPath: "/repo" }] }) },
    workspaces: { create: async () => ({ agents: { create: async () => ({ id: "agent-1", capabilities: { supportsMcpServers: false } }) } }) },
  } as unknown as PaseoApi;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/s.mjs");
  const withAccess = await launcher.start(input, paseo, { linearAccess: true });
  assert.ok(withAccess.warnings.some((warning) => warning.includes("no Linear tools")));
  const without = await launcher.start({ ...input, requestId: "6f6f1154-5838-4439-b981-b3c9d9831488" }, paseo, { linearAccess: false });
  assert.ok(!without.warnings.some((warning) => warning.includes("no Linear tools")));
});

test("a provider the daemon refuses MCP servers for starts once more without the ticket tools", async () => {
  const calls: PaseoWorkspaceAgentCreateOptions[] = [];
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "project-1", projectKind: "directory", projectRootPath: "/repo" }] }) },
    workspaces: { create: async () => ({ agents: { create: async (options: PaseoWorkspaceAgentCreateOptions) => {
      calls.push(options);
      if ("mcpServers" in options.config) throw new Error("Provider 'omp' does not support MCP servers");
      return { id: "agent-1", capabilities: { supportsMcpServers: false } };
    } } }) },
  } as unknown as PaseoApi;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/s.mjs");
  const result = await launcher.start(input, paseo, { linearAccess: true });
  assert.equal(result.agentId, "agent-1");
  assert.equal(calls.length, 2);
  assert.ok(!("mcpServers" in calls[1].config));
  assert.notEqual(calls[1].requestId, calls[0].requestId);
  assert.ok(calls[1].prompt?.includes(NO_LINEAR_ACCESS_NOTE));
  assert.ok(!calls[1].prompt?.includes(LINEAR_ACCESS_NOTE));
  assert.equal(result.warnings.filter((warning) => warning.includes("does not load MCP servers")).length, 1);
});

test("an omp launch hands the ticket tools to the plugin's omp extension instead of the daemon", async () => {
  const calls: PaseoWorkspaceAgentCreateOptions[] = [];
  const paseo = capturePaseo((options) => {
    if ("mcpServers" in options.config) throw new Error("Provider 'omp' does not support MCP servers");
    calls.push(options);
  });
  const launch = (installed: boolean) => new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/s.mjs", undefined, undefined, () => installed)
    .start({ ...input, provider: "omp", requestId: installed ? input.requestId : "7f6f1154-5838-4439-b981-b3c9d9831488" }, paseo, { linearAccess: true });
  const result = await launch(true);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.length, 1, "no attempt with an MCP server");
  assert.deepEqual(JSON.parse(calls[0].env?.LINEAR_TICKETS_MCP ?? "null")?.args?.slice(0, 3), ["/s.mjs", "--issue", ISSUE_ID]);
  assert.ok(calls[0].prompt?.includes(LINEAR_ACCESS_NOTE));

  const without = await launch(false);
  assert.ok(without.warnings.some((warning) => warning.includes("does not load MCP servers")));
  assert.ok(calls[1].prompt?.includes(NO_LINEAR_ACCESS_NOTE));
  assert.equal(calls[1].env?.LINEAR_TICKETS_MCP, undefined);
});

test("any other creation failure is not retried", async () => {
  let calls = 0;
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "project-1", projectKind: "directory", projectRootPath: "/repo" }] }) },
    workspaces: { create: async () => ({ agents: { create: async () => { calls++; throw new Error("Provider 'omp' failed to start"); } } }) },
  } as unknown as PaseoApi;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/s.mjs");
  await assert.rejects(launcher.start(input, paseo, { linearAccess: true }), /could not be confirmed \(Provider 'omp' failed to start\)/);
  assert.equal(calls, 1);
});

test("marking in progress happens before the agent exists, so the agent's own status changes come later", async () => {
  const order: string[] = [];
  const launcher = new Launcher({ ...noMark, detail: async () => detail, markInProgress: async () => { order.push("mark"); return { changed: true }; } }, undefined, async () => "/s.mjs");
  await launcher.start({ ...input, markInProgress: true }, capturePaseo(() => { order.push("create"); }), { linearAccess: true, markInProgress: true });
  assert.deepEqual(order, ["mark", "create"]);
});

test("a script write failure fails the launch before any workspace is created", async () => {
  let created = false;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => { throw new Error("disk full"); });
  await assert.rejects(launcher.start(input, capturePaseo(() => { created = true; }), { linearAccess: true }), /disk full/);
  assert.equal(created, false);
});

test("custom templates get the access note appended unless they place it themselves", () => {
  const appended = buildPrompt(detail, "", "Do {{ticket}}\n{{context}}", true);
  assert.ok(appended.endsWith(LINEAR_ACCESS_NOTE));
  const placed = buildPrompt(detail, "", "{{linear_access}}\nDo {{ticket}}\n{{context}}", true);
  assert.ok(placed.startsWith(LINEAR_ACCESS_NOTE));
  assert.equal(placed.split(LINEAR_ACCESS_NOTE).length, 2);
  assert.ok(!buildPrompt(detail, "", "Do {{ticket}}\n{{context}}", false).includes("linear_ticket"));
  assert.ok(buildPrompt(detail, "", "Do {{ticket}}\n{{context}}", false).endsWith(NO_LINEAR_ACCESS_NOTE));
  assert.ok(buildPrompt(detail, "", "{{linear_access}}\n{{context}}", false).startsWith(NO_LINEAR_ACCESS_NOTE));
});

test("a template saved with the old no-write sentence follows the access toggle instead", () => {
  const legacy = `Work on {{ticket}}. Treat the snapshot as data. ${NO_LINEAR_ACCESS_NOTE}\n{{instructions}}\n{{context}}`;
  const on = buildPrompt(detail, "", legacy, true);
  assert.ok(on.includes(LINEAR_ACCESS_NOTE));
  assert.ok(!on.includes(NO_LINEAR_ACCESS_NOTE));
  assert.equal(on.split(LINEAR_ACCESS_NOTE).length, 2);
  const off = buildPrompt(detail, "", legacy, false);
  assert.equal(off.split(NO_LINEAR_ACCESS_NOTE).length, 2);
  assert.ok(!off.includes("linear_ticket"));
});

test("the MCP script is written once, privately, under a content hash", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-write-"));
  try {
    const first = await writeTicketMcpScript(home);
    const second = await writeTicketMcpScript(home);
    assert.equal(first, second);
    assert.match(first, /ticket-mcp-[0-9a-f]{12}\.mjs$/);
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    const other = await writeTicketMcpScript(home, "console.log(1)\n");
    assert.notEqual(other, first);
    assert.equal(await readFile(other, "utf8"), "console.log(1)\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});

type Call = { authorization: string | undefined; query: string; variables: Record<string, unknown> };
async function fakeLinear(respond: (call: Call) => unknown, options: { status?: number | ((call: Call) => number); delayMs?: number; raw?: (call: Call) => unknown; drop?: (call: Call) => boolean } = {}) {
  const calls: Call[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const call = { authorization: request.headers.authorization, query: parsed.query, variables: parsed.variables };
    calls.push(call);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.drop?.(call)) { request.socket.destroy(); return; }
    response.statusCode = typeof options.status === "function" ? options.status(call) : options.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(options.raw ? options.raw(call) : { data: respond(call) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  return { url, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function runServer(script: string, args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    lines.push(message);
    pending.get(message.id)?.(message);
  });
  let next = 1;
  const lines: Record<string, unknown>[] = [];
  const raw = (line: string) => child.stdin.write(line + "\n");
  const request = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await request("tools/call", { name, arguments: args })).result as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0].text, isError: result.isError === true };
  };
  return { child, request, call, raw, lines, stop: () => { child.kill(); } };
}

const states = [
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-progress", name: "In Progress", type: "started", position: 2 },
  { id: "s-review", name: "In Review", type: "started", position: 3 },
  { id: "s-canceled", name: "Canceled", type: "canceled", position: 4 },
];
const issue = { id: ISSUE_ID, identifier: "ENG-42", title: "Fix sign-in", url: "https://linear.app/x/issue/ENG-42", description: "desc", priorityLabel: "High", state: { name: "In Progress", type: "started" }, assignee: { name: "Teo" }, team: { id: "team-1", name: "Eng", states: { nodes: states } }, comments: { nodes: [{ body: "hi", createdAt: "2026-09-24T00:00:00Z", user: { name: "Teo" } }] }, attachments: { nodes: [] } };

test("the MCP server reads, comments, moves and links only its own ticket over stdio", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-e2e-"));
  const linear = await fakeLinear((call) => {
    if (call.query.includes("query ticket")) return { issue };
    if (call.query.includes("commentCreate")) return { commentCreate: { success: true, comment: { id: "c-1", url: "https://linear.app/c/1", createdAt: "2026-02-01T00:00:00.000Z" } } };
    if (call.query.includes("issueUpdate")) return { issueUpdate: { success: true, issue: { state: { name: "In Review" } } } };
    if (call.query.includes("attachmentLinkURL")) return { attachmentLinkURL: { success: true } };
    return {};
  });
  await mkdir(join(home, "linear-tickets"), { recursive: true });
  await writeFile(join(home, "linear-tickets", "credentials.json"), JSON.stringify({ apiKey: "saved-key" }));
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const server = ticketMcpServer(script, ISSUE_ID, home);
  const mcp = runServer(server.args[0], server.args.slice(1), {});
  try {
    const init = (await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result as { protocolVersion: string };
    assert.equal(init.protocolVersion, "2025-06-18");
    const list = (await mcp.request("tools/list")).result as { tools: { name: string }[] };
    assert.deepEqual(list.tools.map((tool) => tool.name), ["get_ticket", "get_issue", "search_issues", "add_comment", "set_status", "link_url", "add_relation", "create_issue", "update_issue", "add_manual_task"]);

    const ticket = JSON.parse((await mcp.call("get_ticket")).text);
    assert.equal(ticket.identifier, "ENG-42");
    assert.deepEqual(ticket.availableStatuses.map((s: { name: string }) => s.name), ["Todo", "In Progress", "In Review", "Canceled"]);

    assert.equal((await mcp.call("add_comment", { body: "Started." })).isError, false);
    const comment = linear.calls.find((c) => c.query.includes("commentCreate"))!;
    assert.deepEqual(comment.variables, { input: { issueId: ISSUE_ID, body: "Started." } });
    assert.equal(comment.authorization, "saved-key");

    assert.match((await mcp.call("set_status", { status: "Shipped" })).text, /Unknown status.*In Review/);
    assert.match((await mcp.call("set_status", { status: "canceled" })).text, /give the reason/);
    assert.equal((await mcp.call("set_status", { status: "in progress" })).text.includes("\"changed\": false"), true);
    const moved = await mcp.call("set_status", { status: "in review" });
    assert.equal(moved.isError, false);
    assert.deepEqual(linear.calls.filter((c) => c.query.includes("issueUpdate")).map((c) => c.variables), [{ id: ISSUE_ID, stateId: "s-review" }], "a cancel without a reason changes nothing");
    assert.equal((await mcp.call("set_status", { status: "Canceled", reason: "ENG-7 already shipped this." })).isError, false);
    const reason = linear.calls.findIndex((c) => JSON.stringify(c.variables) === JSON.stringify({ input: { issueId: ISSUE_ID, body: "Moved to Canceled by its agent: ENG-7 already shipped this." } }));
    const canceled = linear.calls.findIndex((c) => JSON.stringify(c.variables) === JSON.stringify({ id: ISSUE_ID, stateId: "s-canceled" }));
    assert.ok(reason >= 0 && canceled > reason, "the reason is on the ticket before it closes");

    assert.equal((await mcp.call("link_url", { url: "http://example.com/pr/1" })).isError, true);
    assert.equal((await mcp.call("link_url", { url: "https://github.com/o/r/pull/1", title: "PR" })).isError, false);
    assert.deepEqual(linear.calls.find((c) => c.query.includes("attachmentLinkURL"))!.variables, { issueId: ISSUE_ID, url: "https://github.com/o/r/pull/1", title: "PR" });

    assert.equal(((await mcp.request("tools/call", { name: "delete_everything" })).error as { code: number }).code, -32602);
    assert.equal(((await mcp.request("resources/list")).error as { code: number }).code, -32601);
    assert.ok(linear.calls.every((c) => !JSON.stringify(c.variables).includes("saved-key")));
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("a read-only MCP server reads any issue, mounts no write tools and never touches Linear or disk", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-read-only-"));
  const linear = await fakeLinear((call) => {
    if (call.query.includes("query ticket")) return { issue };
    if (call.query.includes("searchIssues")) return { searchIssues: { nodes: [{ identifier: "ENG-7", title: "Other work", url: "https://linear.app/x/issue/ENG-7", state: { name: "Todo", type: "unstarted" }, team: { key: "ENG" }, project: { name: "Tooling" } }] } };
    return {};
  });
  await mkdir(join(home, "linear-tickets"), { recursive: true });
  await writeFile(join(home, "linear-tickets", "credentials.json"), JSON.stringify({ apiKey: "saved-key" }));
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const server = ticketMcpServer(script, null, home);
  const mcp = runServer(server.args[0], server.args.slice(1), {});
  try {
    const init = (await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result as { instructions: string };
    assert.match(init.instructions, /Reads cover any Linear issue/);
    assert.match(init.instructions, /writes nothing/);

    const list = (await mcp.request("tools/list")).result as { tools: { name: string }[] };
    assert.deepEqual(list.tools.map((tool) => tool.name), ["get_issue", "search_issues"]);

    const read = JSON.parse((await mcp.call("get_issue", { issue: "ENG-42" })).text);
    assert.equal(read.identifier, "ENG-42");
    assert.equal(read.scope, "read_only");
    assert.deepEqual(read.youMay, []);

    const found = JSON.parse((await mcp.call("search_issues", { query: "sign-in" })).text);
    assert.deepEqual(found, [{ identifier: "ENG-7", title: "Other work", url: "https://linear.app/x/issue/ENG-7", status: "Todo", team: "ENG", project: "Tooling" }]);

    const before = linear.calls.length;
    const refused = await mcp.request("tools/call", { name: "add_comment", arguments: { body: "Started." } });
    assert.deepEqual(refused.error, { code: -32602, message: "Unknown tool" });
    assert.equal(linear.calls.length, before, "a refused tool call reaches Linear in no way");
    assert.ok(linear.calls.every((call) => !call.query.includes("mutation")), "no write was sent");

    assert.ok(!existsSync(join(home, "linear-tickets", "agent-issues")), "read-only mode creates no created-issues directory");
    assert.ok(!existsSync(join(home, "linear-tickets", "agent-comments")), "read-only mode creates no comments directory");
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("add_manual_task creates an assigned sub-issue, blocks the ticket only before merge, dedups by title and records the check locally", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-manual-"));
  const withBacklog = [{ id: "s-backlog", name: "Backlog", type: "backlog", position: 0 }, ...states];
  let created = 0;
  const children = [{ id: "c-old", identifier: "ENG-40", url: "https://linear.app/x/issue/ENG-40", title: "Set API_KEY on staging", state: { type: "unstarted" } }];
  const linear = await fakeLinear((call) => {
    if (call.query.includes("query owner")) return { viewer: { id: "me" } };
    if (call.query.includes("query manual")) return { issue: { ...issue, team: { id: "team-1", states: { nodes: withBacklog } }, children: { nodes: children } } };
    if (call.query.includes("issueCreate")) { created++; return { issueCreate: { success: true, issue: { id: `task-${created}`, identifier: `ENG-5${created}`, url: `https://linear.app/x/issue/ENG-5${created}` } } }; }
    if (call.query.includes("issueRelationCreate")) return { issueRelationCreate: { success: true } };
    return {};
  });
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], { LINEAR_API_KEY: "k" });
  try {
    const before = JSON.parse((await mcp.call("add_manual_task", { title: "Set LINEAR_API_KEY on batch-service (staging)", steps: "Railway → batch-service → Variables", when: "before_merge", check: "true" })).text);
    assert.equal(before.identifier, "ENG-51");
    const createBefore = linear.calls.filter((c) => c.query.includes("issueCreate"))[0].variables.input as Record<string, unknown>;
    assert.deepEqual({ ...createBefore, description: undefined }, { teamId: "team-1", title: "Set LINEAR_API_KEY on batch-service (staging)", description: undefined, parentId: ISSUE_ID, assigneeId: "me", stateId: "s-todo" });
    assert.match(String(createBefore.description), /ENG-42, due before the pull request is merged[\s\S]*\n {4}true$/);
    assert.deepEqual(linear.calls.find((c) => c.query.includes("issueRelationCreate"))!.variables, { input: { issueId: "task-1", relatedIssueId: ISSUE_ID, type: "blocks" } });

    await mcp.call("add_manual_task", { title: "Register the webhook", steps: "Linear → Settings → API", when: "after_merge" });
    const createAfter = linear.calls.filter((c) => c.query.includes("issueCreate"))[1].variables.input as Record<string, unknown>;
    assert.equal(createAfter.stateId, "s-backlog");
    assert.equal(linear.calls.filter((c) => c.query.includes("issueRelationCreate")).length, 1);
    // Linear's children list (static here) has not caught up with ENG-52 yet; the local record has.
    const again = JSON.parse((await mcp.call("add_manual_task", { title: "register the webhook", steps: "retry", when: "after_merge" })).text);
    assert.deepEqual(again, { identifier: "ENG-52", url: "https://linear.app/x/issue/ENG-52", deduped: true });

    const dup = JSON.parse((await mcp.call("add_manual_task", { title: "  set api_key on STAGING ", steps: "x", when: "anytime" })).text);
    assert.deepEqual(dup, { identifier: "ENG-40", url: "https://linear.app/x/issue/ENG-40", deduped: true });
    assert.equal(created, 2);

    assert.match((await mcp.call("add_manual_task", { title: "x", steps: "y", when: "someday" })).text, /when must be one of/);

    const directory = join(home, "linear-tickets", "manual-tasks");
    const file = JSON.parse(await readFile(join(directory, "task-1.json"), "utf8"));
    assert.deepEqual({ ...file, createdAt: undefined, cwd: undefined }, { id: "task-1", identifier: "ENG-51", url: "https://linear.app/x/issue/ENG-51", title: "Set LINEAR_API_KEY on batch-service (staging)", parentId: ISSUE_ID, parentIdentifier: "ENG-42", when: "before_merge", check: "true", createdAt: undefined, cwd: undefined, announced: false, activated: true, verifiedAt: null });
    assert.equal((await stat(join(directory, "task-1.json"))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(directory, "task-2.json"), "utf8")).activated, false);
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("writes follow the issue's scope: own ticket, issues the agent created, anything else", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-scope-"));
  const own = { ...issue, project: { id: "lp-1", name: "Tooling" } };
  const other = { ...issue, id: "other-1", identifier: "ENG-7", title: "Someone else's" };
  let created = 0;
  const filed = new Map<string, typeof issue>();
  const linear = await fakeLinear((call) => {
    const id = call.variables.id;
    if (call.query.includes("query ticket")) {
      if (id === ISSUE_ID || id === "ENG-42") return { issue: own };
      if (id === "ENG-7") return { issue: other };
      return { issue: [...filed.values()].find((node) => node.identifier === id || node.id === id) ?? null };
    }
    if (call.query.includes("issueCreate")) {
      created++;
      const node = { ...issue, id: `new-${created}`, identifier: `ENG-6${created}`, url: `https://linear.app/x/issue/ENG-6${created}` };
      filed.set(node.id, node);
      return { issueCreate: { success: true, issue: { id: node.id, identifier: node.identifier, url: node.url } } };
    }
    if (call.query.includes("issueRelationCreate")) return { issueRelationCreate: { success: true } };
    if (call.query.includes("commentCreate")) {
      const input = call.variables.input;
      const target = input && typeof input === "object" && "issueId" in input ? String(input.issueId) : "unknown";
      return { commentCreate: { success: true, comment: { id: `c-${target}`, url: "https://linear.app/c/2", createdAt: "2026-02-01T00:00:00.000Z" } } };
    }
    if (call.query.includes("issueUpdate")) return { issueUpdate: { success: true, issue: { state: { name: "In Progress" } } } };
    return {};
  });
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], { LINEAR_API_KEY: "k" });
  const writes = (name: string) => linear.calls.filter((c) => c.query.includes(name)).map((c) => c.variables);
  try {
    const followUp = JSON.parse((await mcp.call("create_issue", { title: "Add retry", description: "Why and when done." })).text);
    assert.deepEqual(followUp, { identifier: "ENG-61", url: "https://linear.app/x/issue/ENG-61", kind: "follow_up", status: "Todo", deduped: false });
    const input = writes("issueCreate")[0].input as Record<string, unknown>;
    assert.deepEqual({ ...input, description: undefined }, { teamId: "team-1", title: "Add retry", description: undefined, stateId: "s-todo", projectId: "lp-1" });
    assert.match(String(input.description), /^Why and when done\.[\s\S]*ENG-42\.$/);
    assert.deepEqual(writes("issueRelationCreate"), [{ input: { issueId: "new-1", relatedIssueId: ISSUE_ID, type: "related" } }]);
    assert.equal(JSON.parse((await mcp.call("create_issue", { title: "add RETRY", description: "again" })).text).deduped, true);
    assert.equal(created, 1, "a repeated title files nothing new");

    // Another issue: comments and relations only.
    const refused = await mcp.call("set_status", { issue: "ENG-7", status: "In Progress" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /ENG-7 is neither this agent's ticket nor an issue it created/);
    assert.equal((await mcp.call("link_url", { issue: "ENG-7", url: "https://example.com/x" })).isError, true);
    assert.equal((await mcp.call("update_issue", { issue: "ENG-7", title: "Mine now" })).isError, true);
    assert.equal((await mcp.call("add_relation", { issue: "ENG-42", type: "related", from: "ENG-7" })).isError, true);
    assert.equal(writes("issueUpdate").length, 0);
    assert.equal((await mcp.call("add_comment", { issue: "ENG-7", body: "FYI" })).isError, false);
    assert.deepEqual(writes("commentCreate").at(-1), { input: { issueId: "other-1", body: "FYI" } });
    // Recorded under this ticket, so the relay routes the owner's replies on ENG-7 back to this agent.
    assert.deepEqual(await postedComments(join(home, "linear-tickets"), ISSUE_ID), [{ id: "c-other-1", issueId: "other-1", identifier: "ENG-7", createdAt: "2026-02-01T00:00:00.000Z" }]);
    assert.equal((await mcp.call("add_relation", { issue: "ENG-7", type: "blocked_by" })).isError, false);
    assert.deepEqual(writes("issueRelationCreate").at(-1), { input: { issueId: "other-1", relatedIssueId: ISSUE_ID, type: "blocks" } });
    assert.equal(JSON.parse((await mcp.call("get_issue", { issue: "ENG-7" })).text).scope, "other");

    // The issue it filed: text and status too. Its own ticket keeps the owner's text.
    assert.equal((await mcp.call("update_issue", { issue: "ENG-61", title: "Add retry with backoff" })).isError, false);
    assert.deepEqual(writes("issueUpdate").at(-1), { id: "new-1", input: { title: "Add retry with backoff" } });
    assert.equal((await mcp.call("set_status", { issue: "ENG-61", status: "In Review" })).isError, false);
    assert.deepEqual(writes("issueUpdate").at(-1), { id: "new-1", stateId: "s-review" });
    assert.match((await mcp.call("update_issue", { issue: "ENG-42", title: "x" })).text, /own ticket/);

    const sub = JSON.parse((await mcp.call("create_issue", { title: "Split part", description: "d", kind: "sub_issue" })).text);
    assert.equal(sub.kind, "sub_issue");
    assert.equal((writes("issueCreate")[1].input as Record<string, unknown>).parentId, ISSUE_ID);
    assert.equal(writes("issueRelationCreate").length, 2, "a sub-issue gets no extra relation");

    // The cap counts every recorded issue of this ticket.
    const directory = join(home, "linear-tickets", "agent-issues", ISSUE_ID);
    for (let i = 0; i < 8; i++) await writeFile(join(directory, `pad-${i}.json`), JSON.stringify({ id: `pad-${i}`, identifier: `ENG-9${i}`, url: "u", title: `pad ${i}` }));
    assert.match((await mcp.call("create_issue", { title: "One too many", description: "d" })).text, /already filed 10 issues/);
    assert.equal(created, 2);
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("the MCP server prefers LINEAR_API_KEY and reports a missing key", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-key-"));
  const linear = await fakeLinear(() => ({ issue }));
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const withEnv = runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], { LINEAR_API_KEY: "env-key" });
  const without = runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], {});
  try {
    assert.equal((await withEnv.call("get_ticket")).isError, false);
    assert.equal(linear.calls[0].authorization, "env-key");
    const missing = await without.call("get_ticket");
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not connected/);
    assert.equal(linear.calls.length, 1);
  } finally { withEnv.stop(); without.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("the MCP server refuses to start without a valid issue id", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-args-"));
  try {
    const script = await writeTicketMcpScript(home);
    const code = await new Promise<number | null>((resolve) => {
      spawn(process.execPath, [script, "--issue", "../../etc", "--paseo-home", home], { stdio: "ignore" }).on("exit", resolve);
    });
    assert.equal(code, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the MCP script refuses to start without exactly one of --issue and --read-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-mode-"));
  try {
    const script = await writeTicketMcpScript(home);
    const run = (args: string[]) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stderr }));
    });
    const neither = await run(["--paseo-home", home]);
    assert.equal(neither.code, 2);
    assert.match(neither.stderr, /--issue <id> or --read-only/);
    const both = await run(["--issue", ISSUE_ID, "--read-only", "--paseo-home", home]);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /--issue <id> or --read-only/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("settings serialize concurrent patches so none is lost, and keep orphaned launch preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-settings-race-"));
  const path = join(directory, "settings.json");
  try {
    const settings = new Settings(path);
    await Promise.all([
      settings.patch({ launchPreference: { provider: "codex", model: "codex/model" } }),
      settings.patch({ projectMapping: { key: "project:p", projectId: "repo", label: "P" } }),
      settings.patch({ showClosed: true }),
    ]);
    const saved = await settings.read();
    assert.equal(saved.lastProvider, "codex");
    assert.deepEqual(Object.keys(saved.projectMappings), ["project:p"]);
    assert.equal(saved.showClosed, true);
    await writeFile(path, JSON.stringify({ launchPreferences: { codex: { model: "codex/model" } } }));
    await settings.patch({});
    assert.deepEqual((await settings.read()).launchPreferences, { codex: { model: "codex/model" } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("API error text never carries the key back to the agent", async () => {
  const echo = (call: Call) => ({ errors: [{ message: "rejected: " + call.authorization }] });
  const unauthorized = await fakeLinear(() => ({}), { status: 401, raw: echo });
  const failing = await fakeLinear(() => ({}), { raw: echo });
  const env = { LINEAR_API_KEY: "lin_api_SECRETSECRET" };
  // Two fake upstreams need two broker homes: one broker serves one upstream.
  const left = await host("paseo-linear-mcp-redact-");
  const right = await host("paseo-linear-mcp-redact-");
  const leftBroker = await brokerOn(left.home, unauthorized);
  const rightBroker = await brokerOn(right.home, failing);
  samples(leftBroker.budget);
  samples(rightBroker.budget);
  const a = runServer(left.script, ["--issue", ISSUE_ID, "--paseo-home", left.home], env);
  const b = runServer(right.script, ["--issue", ISSUE_ID, "--paseo-home", right.home], env);
  try {
    const first = await a.call("get_ticket");
    assert.equal(first.isError, true);
    assert.doesNotMatch(first.text, /SECRET/);
    const second = await b.call("add_comment", { body: "x" });
    assert.equal(second.isError, true);
    assert.match(second.text, /\[redacted\]/);
    assert.doesNotMatch(second.text, /SECRET/);
  } finally {
    a.stop(); b.stop(); await leftBroker.broker.stop(); await rightBroker.broker.stop();
    await unauthorized.close(); await failing.close();
    await rm(left.home, { recursive: true, force: true }); await rm(right.home, { recursive: true, force: true });
  }
});

test("a rate-limited Linear answer tells the agent to try again later instead of a generic failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-ratelimit-"));
  const limited = await fakeLinear(() => ({}), { status: 400, raw: () => ({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }) });
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, limited);
  samples(budget);
  const mcp = runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], { LINEAR_API_KEY: "k" });
  try {
    const result = await mcp.call("get_ticket");
    assert.equal(result.isError, true);
    assert.match(result.text, /Linear's hourly request limit is reached for the Linear API key; try again in about 10 minutes\./);
    assert.equal(limited.calls.length, 1);
  } finally { mcp.stop(); await broker.stop(); await limited.close(); await rm(home, { recursive: true, force: true }); }
});

test("the MCP server validates envelopes, never runs tools for notifications, and bounds input", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-envelope-"));
  const linear = await fakeLinear(() => ({ commentCreate: { success: true, comment: { id: "c-1", url: "u" } }, attachmentLinkURL: { success: true } }));
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], { LINEAR_API_KEY: "k" });
  try {
    mcp.raw("null"); mcp.raw("[]"); mcp.raw(JSON.stringify({ jsonrpc: "1.0", id: 3, method: "ping" }));
    mcp.raw(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "add_comment", arguments: { body: "sneaky" } } }));
    mcp.raw(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping", params: { pad: "x".repeat(1_100_000) } }));
    assert.deepEqual(await mcp.request("ping"), { jsonrpc: "2.0", id: 1, result: {} });
    const invalid = mcp.lines.filter((line) => (line.error as { code?: number } | undefined)?.code === -32600);
    assert.equal(invalid.length, 4);
    assert.ok(invalid.some((line) => (line.error as { message: string }).message === "Request too large"));
    assert.ok(!mcp.lines.some((line) => line.id === 99));
    const long = await mcp.call("link_url", { url: "https://example.com/" + "a".repeat(3000) });
    assert.equal(long.isError, true);
    assert.equal((await mcp.request("tools/call", { name: "add_comment", arguments: [] })).error !== undefined, true);
    assert.equal(linear.calls.length, 0);
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("the MCP server caps concurrent Linear calls", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-linear-mcp-limits-"));
  const slow = await fakeLinear(() => ({ commentCreate: { success: true, comment: { id: "c-1", url: "u" } } }), { delayMs: 300 });
  const script = await writeTicketMcpScript(home);
  const { broker, budget } = await brokerOn(home, slow);
  samples(budget);
  const mcp = runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], { LINEAR_API_KEY: "k" });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => mcp.call("add_comment", { body: "x" })));
    assert.equal(results.filter((result) => result.isError && /Too many/.test(result.text)).length, 2);
    assert.equal(slow.calls.length, 4);
  } finally { mcp.stop(); await broker.stop(); await slow.close(); await rm(home, { recursive: true, force: true }); }
});

// The Paseo app's token as the daemon keeps it; null leaves expires_at out. Sync, so a fake
// Linear can rotate it while it answers a request.
function writeToken(home: string, token: string, expiresAt: number | null = Date.now() + 3_600_000) {
  mkdirSync(join(home, "linear-tickets", "agent-app"), { recursive: true });
  writeFileSync(join(home, "linear-tickets", "agent-app", "token.json"), JSON.stringify({ access_token: token, refresh_token: "refresh-1", ...(expiresAt === null ? {} : { expires_at: expiresAt }) }));
}

// A host with the owner's key saved as "saved-key" and the MCP script written.
async function host(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(home, "linear-tickets"), { recursive: true });
  await writeFile(join(home, "linear-tickets", "credentials.json"), JSON.stringify({ apiKey: "saved-key" }));
  return { home, script: await writeTicketMcpScript(home) };
}

function headersFor(requests: number, points: number): Headers {
  return new Headers({ "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": String(requests),
    "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": String(points), "x-complexity": "1" });
}

// Known samples per pool so a cold pool never first sends its own discovery probe, which would
// shift the operation and authentication call sequences these tests assert. "Ample" stays well
// above the 5% interactive reserve plus the 10,000-point ceiling one MCP request reserves.
function samples(budget: RateBudget, overrides: Partial<Record<"app" | "key", Headers>> = {}) {
  for (const pool of ["app", "key"] as const) budget.acquire(pool, "owner").done(overrides[pool] ?? headersFor(4_500, 1_900_000), false);
}

// The daemon's broker on this home; the fake Linear server is injected here, at construction,
// never through the child's environment.
async function brokerOn(home: string, linear: { url: string }) {
  const usage = new LinearUsage(() => Date.now(), { path: join(home, "usage.json") });
  const budget = new RateBudget(() => Date.now(), usage);
  const broker = new LinearBroker({ home, budget, usage, upstream: (authorization, query, variables, signal) =>
    fetch(linear.url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal }) });
  await broker.start();
  return { broker, budget };
}

function startOn(home: string, script: string) {
  return runServer(script, ["--issue", ISSUE_ID, "--paseo-home", home], {});
}

function answers(call: Call) {
  if (call.query.includes("query ticket")) return { issue };
  if (call.query.includes("commentCreate")) return { commentCreate: { success: true, comment: { id: "c-1", url: "https://linear.app/c/1" } } };
  if (call.query.includes("issueUpdate")) return { issueUpdate: { success: true, issue: { state: { name: "In Review" } } } };
  if (call.query.includes("attachmentLinkURL")) return { attachmentLinkURL: { success: true } };
  return {};
}

const authorizations = (calls: Call[]) => calls.map((call) => call.authorization);

test("every ticket tool acts as the Paseo app while its token is fresh", async () => {
  const { home, script } = await host("paseo-linear-mcp-app-");
  writeToken(home, "app-1");
  const linear = await fakeLinear(answers);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = startOn(home, script);
  try {
    assert.equal((await mcp.call("get_ticket")).isError, false);
    assert.equal((await mcp.call("add_comment", { body: "Started." })).isError, false);
    assert.equal((await mcp.call("set_status", { status: "In Review" })).isError, false);
    assert.equal((await mcp.call("set_status", { status: "Canceled", reason: "Done elsewhere." })).isError, false);
    assert.equal((await mcp.call("link_url", { url: "https://github.com/o/r/pull/1" })).isError, false);
    for (const kind of ["query ticket", "commentCreate", "issueUpdate", "attachmentLinkURL"]) assert.ok(linear.calls.some((call) => call.query.includes(kind)), kind);
    assert.ok(linear.calls.every((call) => call.authorization === "Bearer app-1"), JSON.stringify(authorizations(linear.calls)));
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("a token the daemon rotated between two calls is used for the next one", async () => {
  const { home, script } = await host("paseo-linear-mcp-rotate-");
  writeToken(home, "app-1");
  const linear = await fakeLinear(answers);
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = startOn(home, script);
  try {
    await mcp.call("get_ticket");
    writeToken(home, "app-2");
    assert.equal((await mcp.call("add_comment", { body: "x" })).isError, false);
    assert.deepEqual(authorizations(linear.calls), ["Bearer app-1", "Bearer app-2"]);
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("a rejected token is retried once with the token rotated meanwhile, never with the key", async () => {
  const { home, script } = await host("paseo-linear-mcp-rejected-");
  writeToken(home, "app-1");
  const linear = await fakeLinear(answers, { status: (call) => {
    if (call.authorization !== "Bearer app-1") return 200;
    writeToken(home, "app-2");
    return 401;
  } });
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = startOn(home, script);
  try {
    assert.equal((await mcp.call("add_comment", { body: "x" })).isError, false);
    assert.deepEqual(authorizations(linear.calls), ["Bearer app-1", "Bearer app-2"]);
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("the owner's key is used only when Linear still does not accept the app", async () => {
  const cases = [
    { name: "401, token unchanged", rotate: false, status: () => 401, raw: undefined, expected: ["Bearer app-1", "saved-key"] },
    { name: "AUTHENTICATION_ERROR, token unchanged", rotate: false, status: () => 400, raw: { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, expected: ["Bearer app-1", "saved-key"] },
    { name: "401, rotated token rejected too", rotate: true, status: () => 401, raw: undefined, expected: ["Bearer app-1", "Bearer app-2", "saved-key"] },
  ];
  for (const { name, rotate, status, raw, expected } of cases) {
    const { home, script } = await host("paseo-linear-mcp-fallback-");
    writeToken(home, "app-1");
    const linear = await fakeLinear(answers, {
      status: (call) => {
        if (call.authorization === "saved-key") return 200;
        if (rotate && call.authorization === "Bearer app-1") writeToken(home, "app-2");
        return status();
      },
      raw: (call) => (call.authorization === "saved-key" || !raw ? { data: answers(call) } : raw),
    });
    const { broker, budget } = await brokerOn(home, linear);
    samples(budget);
    const mcp = startOn(home, script);
    try {
      assert.equal((await mcp.call("add_comment", { body: "x" })).isError, false, name);
      assert.deepEqual(authorizations(linear.calls), expected, name);
    } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
  }
});

test("a refusal of the rotated token goes back to the agent, never to the key", async () => {
  const { home, script } = await host("paseo-linear-mcp-refused-");
  writeToken(home, "app-1");
  const linear = await fakeLinear(answers, {
    status: (call) => {
      if (call.authorization === "Bearer app-1") { writeToken(home, "app-2"); return 401; }
      return call.authorization === "Bearer app-2" ? 403 : 200;
    },
    raw: (call) => (call.authorization === "Bearer app-2" ? { errors: [{ message: "Forbidden" }] } : { data: answers(call) }),
  });
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = startOn(home, script);
  try {
    const result = await mcp.call("add_comment", { body: "x" });
    assert.equal(result.isError, true);
    assert.match(result.text, /^Linear refused this request for the Paseo app: Forbidden/);
    assert.deepEqual(authorizations(linear.calls), ["Bearer app-1", "Bearer app-2"]);
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("an outage, a lost connection or a spent rate limit on the app is not retried with the key", async () => {
  const cases = [
    { name: "HTTP 500", options: { status: 500, raw: () => ({}) }, message: "The Linear request failed (HTTP 500)." },
    { name: "network", options: { drop: () => true }, message: "The Linear request may have completed; check the ticket before retrying a write." },
    { name: "rate limit", options: { status: 400, raw: () => ({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }) }, message: "Linear's hourly request limit is reached for the Paseo app; try again in about 10 minutes." },
  ];
  for (const { name, options, message } of cases) {
    const { home, script } = await host("paseo-linear-mcp-nofallback-");
    writeToken(home, "app-1");
    const linear = await fakeLinear(answers, options);
    const { broker, budget } = await brokerOn(home, linear);
    samples(budget);
    const mcp = startOn(home, script);
    try {
      const result = await mcp.call("add_comment", { body: "x" });
      assert.equal(result.isError, true, name);
      assert.equal(result.text, message, name);
      assert.deepEqual(authorizations(linear.calls), ["Bearer app-1"], name);
    } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
  }
});

test("without a usable app token the owner's key is used; a token without an expiry counts as fresh", async () => {
  const cases: { name: string; token: number | null | "none"; expected: string }[] = [
    { name: "no token.json", token: "none", expected: "saved-key" },
    { name: "expired", token: Date.now() - 1_000, expected: "saved-key" },
    { name: "expires within a minute", token: Date.now() + 30_000, expected: "saved-key" },
    { name: "no expires_at", token: null, expected: "Bearer app-1" },
  ];
  const linear = await fakeLinear(answers);
  try {
    for (const { name, token, expected } of cases) {
      const { home, script } = await host("paseo-linear-mcp-stale-");
      if (token !== "none") writeToken(home, "app-1", token);
      const { broker, budget } = await brokerOn(home, linear);
      samples(budget);
      const mcp = startOn(home, script);
      try {
        const before = linear.calls.length;
        assert.equal((await mcp.call("get_ticket")).isError, false, name);
        assert.deepEqual(authorizations(linear.calls.slice(before)), [expected], name);
      } finally { mcp.stop(); await broker.stop(); await rm(home, { recursive: true, force: true }); }
    }
  } finally { await linear.close(); }
});

test("a manual task is assigned to the key's owner but created by the Paseo app", async () => {
  const { home, script } = await host("paseo-linear-mcp-manual-app-");
  writeToken(home, "app-1");
  const linear = await fakeLinear((call) => {
    if (call.query.includes("query owner")) return { viewer: { id: call.authorization === "saved-key" ? "owner-id" : "paseo-app-id" } };
    if (call.query.includes("query manual")) return { issue: { ...issue, team: { id: "team-1", states: { nodes: states } }, children: { nodes: [] } } };
    if (call.query.includes("issueCreate")) return { issueCreate: { success: true, issue: { id: "task-1", identifier: "ENG-51", url: "https://linear.app/x/issue/ENG-51" } } };
    if (call.query.includes("issueRelationCreate")) return { issueRelationCreate: { success: true } };
    return {};
  });
  const { broker, budget } = await brokerOn(home, linear);
  samples(budget);
  const mcp = startOn(home, script);
  try {
    const result = await mcp.call("add_manual_task", { title: "Set a secret", steps: "Railway → Variables", when: "before_merge" });
    assert.equal(result.isError, false, result.text);
    const by = (kind: string) => linear.calls.filter((call) => call.query.includes(kind));
    assert.deepEqual(authorizations(by("query owner")), ["saved-key"]);
    assert.deepEqual(authorizations(by("query manual")), ["Bearer app-1"]);
    assert.deepEqual(authorizations(by("issueCreate")), ["Bearer app-1"]);
    assert.deepEqual(authorizations(by("issueRelationCreate")), ["Bearer app-1"]);
    assert.equal((by("issueCreate")[0].variables.input as Record<string, unknown>).assigneeId, "owner-id");
  } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});

test("Linear error text never carries the app's tokens or the key back to the agent", async () => {
  const echo = (call: Call) => ({ errors: [{ message: "rejected: " + call.authorization }] });
  const cases = [
    { name: "app request fails", status: () => 200 },
    { name: "rotated token refused", status: (call: Call, home: string) => {
      if (call.authorization === "Bearer app-TOKENSECRET") { writeToken(home, "app-ROTATEDSECRET"); return 401; }
      return 403;
    } },
    { name: "key request fails after the app was rejected", status: (call: Call) => (call.authorization?.startsWith("Bearer") ? 401 : 400) },
  ];
  for (const { name, status } of cases) {
    const { home, script } = await host("paseo-linear-mcp-redact-app-");
    await writeFile(join(home, "linear-tickets", "credentials.json"), JSON.stringify({ apiKey: "lin_api_KEYSECRET" }));
    writeToken(home, "app-TOKENSECRET");
    const linear = await fakeLinear(answers, { status: (call) => status(call, home), raw: echo });
    const { broker, budget } = await brokerOn(home, linear);
    samples(budget);
    const mcp = startOn(home, script);
    try {
      const result = await mcp.call("add_comment", { body: "x" });
      assert.equal(result.isError, true, name);
      assert.match(result.text, /\[redacted\]/, name);
      assert.doesNotMatch(result.text, /SECRET/, name);
    } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
  }
});

test("at three percent the agent's reads and writes pause locally before anything is sent", async () => {
  const cases: { name: string; token: boolean; override: Partial<Record<"app" | "key", Headers>> }[] = [
    { name: "app points", token: true, override: { app: headersFor(4_500, 60_000) } },
    { name: "app requests", token: true, override: { app: headersFor(100, 1_900_000) } },
    { name: "key points", token: false, override: { key: headersFor(4_500, 60_000) } },
  ];
  for (const { name, token, override } of cases) {
    const { home, script } = await host("paseo-linear-mcp-hold-");
    if (token) writeToken(home, "app-1");
    const linear = await fakeLinear(answers);
    const { broker, budget } = await brokerOn(home, linear);
    // Only the pool the request will spend is nearly empty; the other stays ample, so a forbidden
    // fallback (to the key, or past the reserve) would reach the fake upstream and fail below.
    samples(budget, override);
    const mcp = startOn(home, script);
    try {
      for (const call of [() => mcp.call("get_ticket"), () => mcp.call("add_comment", { body: "Started." })]) {
        const result = await call();
        assert.equal(result.isError, true, name);
        assert.match(result.text, /^Agent Linear work is paused to keep the last budget for owner decisions; retry after \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/, name + ": " + result.text);
      }
      assert.equal(linear.calls.length, 0, name);
    } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
  }
});

test("at three percent a read-only planner's searches pause too", async () => {
  const cases: { name: string; token: boolean; override: Partial<Record<"app" | "key", Headers>> }[] = [
    { name: "app", token: true, override: { app: headersFor(4_500, 60_000) } },
    { name: "key", token: false, override: { key: headersFor(100, 1_900_000) } },
  ];
  for (const { name, token, override } of cases) {
    const { home, script } = await host("paseo-linear-mcp-hold-read-only-");
    if (token) writeToken(home, "app-1");
    const linear = await fakeLinear(answers);
    const { broker, budget } = await brokerOn(home, linear);
    samples(budget, override);
    const mcp = runServer(script, ["--read-only", "--paseo-home", home], {});
    try {
      const list = (await mcp.request("tools/list")).result as { tools: { name: string }[] };
      assert.deepEqual(list.tools.map((tool) => tool.name), ["get_issue", "search_issues"], name);
      for (const call of [() => mcp.call("search_issues", { query: "sign-in" }), () => mcp.call("get_issue", { issue: "ENG-42" })]) {
        const result = await call();
        assert.equal(result.isError, true, name);
        assert.match(result.text, /^Agent Linear work is paused to keep the last budget for owner decisions; retry after \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/, name + ": " + result.text);
      }
      assert.equal(linear.calls.length, 0, name);
    } finally { mcp.stop(); await broker.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
  }
});

test("without the broker the tools stay available and every request fails closed", async () => {
  const { home, script } = await host("paseo-linear-mcp-nobroker-");
  const linear = await fakeLinear(answers);
  const mcp = startOn(home, script);
  try {
    const init = (await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result as { protocolVersion: string };
    assert.equal(init.protocolVersion, "2025-06-18");
    const list = (await mcp.request("tools/list")).result as { tools: { name: string }[] };
    assert.equal(list.tools.length, 10, "the tools stay mounted when the broker is down");
    for (const call of [() => mcp.call("get_ticket"), () => mcp.call("add_comment", { body: "Started." })]) {
      const result = await call();
      assert.equal(result.isError, true);
      assert.equal(result.text, "The host's Linear budget service is unavailable; no request was sent. Retry after the plugin is running.");
    }
    assert.equal(linear.calls.length, 0, "nothing fell back to a direct Linear connection");
  } finally { mcp.stop(); await linear.close(); await rm(home, { recursive: true, force: true }); }
});
