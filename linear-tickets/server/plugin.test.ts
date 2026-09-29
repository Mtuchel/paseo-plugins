import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions, PaseoWorkspaceCreateOptions } from "@getpaseo/client";
import { buildContext, buildPrompt, issuePage, normalizeIssue, connection, relationships, stateHistorySpans, ticketRelations } from "./context";
import { Credentials } from "./credentials";
import { Launcher, safeBranchName } from "./launch";
import { Settings, MAX_TEMPLATE_LENGTH, normalizeTemplate, DEFAULT_DISPATCH, DEFAULT_WRITEBACK } from "./settings";
import { LinearService, postGraphQL, ADD_LABEL_QUERY, CREATE_LABEL_QUERY, LABEL_BY_NAME_QUERY, resolveReviewState, COMMENT_QUERY, ISSUE_DETAIL_QUERY, LIST_ISSUES_QUERY, SEARCH_ISSUES_QUERY, VIEWER_QUERY, TEAM_STATES_QUERY, UPDATE_ISSUE_STATE_QUERY, resolveStartedState, listIssueFilter, type Post, type TeamState } from "./linear";
import { RateBudget, RateLimitedError } from "./rate-budget";
import { cachedOverviewRpc, countIssuesRpc, listIssuesRpc, searchIssuesRpc } from "../shared/contracts";

// Launches save the ticket prompt for the plan advisor under PASEO_HOME; keep it out of the real one.
process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "paseo-plugin-home-"));

// GraphQL-shaped fixture: workflow state, priority label, label connection,
// and the relationship fields the detail query requests.
const rawIssue = {
  id: "issue-1", identifier: "ENG-42", title: "Fix the sign-in flow",
  description: "Keep the existing session alive.", url: "https://linear.app/example/issue/ENG-42",
  state: { name: "In Progress", type: "started" }, priorityLabel: "P1",
  project: { id: "project-1", name: "App", identifier: "APP", url: "https://linear.app/example/project/app" },
  team: { id: "team-1", name: "Engineering", key: "ENG" },
  labels: { nodes: [{ id: "label-1", name: "bug" }] },
  createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z",
  parent: null,
  children: { nodes: [{ id: "issue-3", identifier: "ENG-44", title: "Child task" }] },
  relations: { nodes: [{ type: "blocks", issue: null, relatedIssue: { id: "issue-2", identifier: "ENG-43", title: "Blocked work" } }] },
  attachments: { nodes: [{ id: "attachment-1", title: "screenshot.png", url: "https://files.example.com/screenshot.png" }] },
  documents: { nodes: [] },
};
const comment = {
  id: "comment-1", body: "Regression on mobile", createdAt: "2025-01-02T01:00:00.000Z",
  url: "https://linear.app/example/issue/ENG-42#comment-1", user: { name: "Tofu" },
};
const detail = { issue: normalizeIssue(rawIssue), teamId: "team-1", projectId: "project-1", context: buildContext(rawIssue, [comment]), warnings: [], relations: ticketRelations(rawIssue) };
const input = { id: "ENG-42", projectId: "project-1", provider: "test/model", instructions: "Add a regression check.", markInProgress: false, requestId: "5f6f1154-5838-4439-b981-b3c9d9831488" };
// Test fakes that do not exercise the state transition: a no-op stub keeps the contract strict.
const noMark = { markInProgress: async () => ({ changed: false }) };
const automationDefaults = { dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK };

test("server entrypoint loads and registers valid Paseo RPC contracts", () => {
  const names: string[] = [];
  const cleanup = contribute({ handle(contract: { name: string }) { names.push(contract.name); }, on() { return () => {}; }, before() { return () => {}; } } as unknown as PluginServerContext);
  assert.deepEqual(names, ["linear.status", "linear.dispatch-status", "linear.connect", "linear.disconnect", "linear.list-issues", "linear.count-issues", "linear.cached-overview", "linear.search-issues", "linear.issue-context", "linear.project-branches", "linear.get-default-prompt", "linear.set-default-prompt", "linear.get-settings", "linear.set-settings", "linear.launch-agent", "linear.agent-status"]);
  cleanup();
});

function mockFetch(t: TestContext, makeResponse: () => Response): void {
  t.mock.method(globalThis, "fetch", ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(makeResponse())) as typeof fetch);
}

test("Linear API requests carry the key, exact query and variables, and never follow redirects", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } }), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch);
  const data = await postGraphQL("secret-key", "query q { viewer { id } }", { a: 1 });
  assert.deepEqual(data, { viewer: { id: "user-1" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  const headers = calls[0].init.headers as Record<string, string>;
  // Linear's GraphQL API takes the raw key; a Bearer prefix is rejected with HTTP 400.
  assert.equal(headers.authorization, "secret-key");
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { query: "query q { viewer { id } }", variables: { a: 1 } });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("authentication, rate-limit and server failures map to user-actionable errors", async (t) => {
  const cases: Array<{ status: number; body: unknown; message: RegExp }> = [
    { status: 401, body: { errors: [{ message: "Authentication required" }] }, message: /rejected this API key. Authentication required/ },
    { status: 403, body: { errors: [{ message: "forbidden" }] }, message: /rejected this API key. forbidden/ },
    { status: 429, body: { errors: [{ message: "rate limited" }] }, message: /hourly request limit is reached for the Linear API key/ },
    // What Linear actually sends when the hourly limit is used up.
    { status: 400, body: { errors: [{ message: "Rate limit exceeded. Only 2500 requests are allowed per 1 hour.", extensions: { code: "RATELIMITED" } }] }, message: /hourly request limit is reached for the Linear API key/ },
    { status: 400, body: { errors: [{ message: "Remove the Bearer prefix from the Authorization header." }] }, message: /request failed: Remove the Bearer prefix/ },
    { status: 500, body: { errors: [{ message: "boom" }] }, message: /request failed: boom/ },
    { status: 502, body: "gateway html", message: /HTTP 502/ },
  ];
  for (const { status, body, message } of cases) {
    mockFetch(t, () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    await assert.rejects(postGraphQL("key", "query q { viewer { id } }", {}, new RateBudget()), message);
  }
});

test("a RATELIMITED answer blocks only its own pool, and later calls on it fail without reaching Linear", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", (() => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify({ data: null, errors: [{ message: "Rate limit exceeded.", extensions: { code: "RATELIMITED" } }] }), {
      status: 200, headers: { "content-type": "application/json", "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "0" },
    }));
  }) as typeof fetch);
  const budget = new RateBudget();
  const error = await postGraphQL("Bearer app-token", "q", {}, budget).then(() => null, (failure: unknown) => failure);
  assert.ok(error instanceof RateLimitedError);
  assert.equal(error.pool, "app");
  assert.ok(error.resumeAt > Date.now());
  await assert.rejects(postGraphQL("Bearer app-token", "q", {}, budget), RateLimitedError);
  assert.equal(calls, 1);
  assert.equal(budget.pausedUntil("key"), null);
});

test("GraphQL error payloads fail visibly with the API message", async (t) => {
  mockFetch(t, () => new Response(JSON.stringify({ data: null, errors: [{ message: "Issue not found" }] }), { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(postGraphQL("key", "query q { issue(id: \"x\") { id } }", {}), /Issue not found/);
});

// Linear's answer when the pull request is already on the ticket (captured from TUC-96).
const ALREADY_LINKED = { data: null, errors: [{ message: "Unable to create issue attachment", path: ["attachmentLinkURL"], extensions: { type: "invalid input", code: "INPUT_ERROR", statusCode: 400, userError: true, userPresentableMessage: "This URL has already been linked with TUC-96." } }] };

test("a GraphQL error names Linear's reason, not only its generic message", async (t) => {
  mockFetch(t, () => new Response(JSON.stringify(ALREADY_LINKED), { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(postGraphQL("key", "q", {}, new RateBudget()), /Unable to create issue attachment \(This URL has already been linked with TUC-96\.\)/);
});

test("linking a URL that is already linked succeeds; other link failures still fail", async (t) => {
  let answer: unknown = ALREADY_LINKED;
  mockFetch(t, () => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
  const service = new LinearService(new Credentials("/unused", "env-key"), (key, query, variables) => postGraphQL(key, query, variables, new RateBudget()));
  await service.linkUrl("issue-1", "https://github.com/o/r/pull/287", "Pull request");
  answer = { data: null, errors: [{ message: "Unable to create issue attachment", extensions: { userPresentableMessage: "Invalid URL." } }] };
  await assert.rejects(service.linkUrl("issue-1", "not a url", "Pull request"), /Invalid URL/);
});

test("invalid response bodies fail loudly", async (t) => {
  mockFetch(t, () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }));
  await assert.rejects(postGraphQL("key", "q", {}), /invalid response/);
  mockFetch(t, () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(postGraphQL("key", "q", {}), /unexpected response/);
});

test("network failures surface as connection errors", async (t) => {
  t.mock.method(globalThis, "fetch", (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch);
  await assert.rejects(postGraphQL("key", "q", {}), /Could not reach/);
});

test("issue normalization reads workflow state, its category, priority labels and label connections", () => {
  const issue = normalizeIssue(rawIssue);
  assert.equal(issue.identifier, "ENG-42");
  assert.equal(issue.status, "In Progress");
  assert.equal(issue.statusType, "started");
  assert.equal(issue.priority, "P1");
  assert.equal(issue.project, "App");
  assert.equal(issue.team, "Engineering");
  assert.deepEqual(issue.labels, ["bug"]);
  assert.equal(issue.description, rawIssue.description);
  assert.equal(issue.updatedAt, rawIssue.updatedAt);
  assert.equal(issue.blockingCount, 1);
  assert.equal(issue.blockedByCount, 0);
  assert.equal(normalizeIssue({ id: "x", title: "No category", state: { name: "Weird" } }).statusType, "");
  assert.equal(normalizeIssue({ id: "x", title: "No state at all" }).statusType, "");
  assert.throws(() => normalizeIssue({ title: "Missing ID" }), /without an ID/);
});

test("ticket relations expose parent, subissues and both relation directions with assignees", () => {
  const value = ticketRelations({
    id: "issue-1",
    parent: { id: "parent", identifier: "ENG-1", title: "Parent", state: { name: "Todo", type: "unstarted" }, assignee: null },
    children: { nodes: [{ id: "child", identifier: "ENG-3", title: "Child", url: "https://linear.app/child", state: { name: "In Progress", type: "started" }, assignee: { id: "viewer-1", name: "Ada" } }] },
    relations: { nodes: [{ type: "blocks", issue: { id: "issue-1" }, relatedIssue: { id: "downstream", identifier: "ENG-4", title: "Downstream" } }] },
    inverseRelations: { nodes: [{ type: "blocks", issue: { id: "upstream", identifier: "ENG-5", title: "Upstream", assignee: { name: "Lin" } }, relatedIssue: { id: "issue-1" } }] },
  }, "viewer-1");
  assert.equal(value.parent?.identifier, "ENG-1");
  assert.equal(value.parent?.assignee, "");
  assert.deepEqual(value.subissues.map((ticket) => [ticket.identifier, ticket.assignee]), [["ENG-3", "Ada"]]);
  assert.equal(value.subissues[0].assignedToViewer, true);
  assert.equal(value.related[0].assignedToViewer, false);
  assert.deepEqual(value.related.map((ticket) => [ticket.direction, ticket.identifier, ticket.assignee]), [
    ["blocks", "ENG-4", ""],
    ["blocked by", "ENG-5", "Lin"],
  ]);
});

test("connections expose nodes, page cursors and missing-page detection", () => {
  assert.deepEqual(connection({ nodes: [rawIssue], pageInfo: { hasNextPage: true, endCursor: "next" } }).endCursor, "next");
  assert.equal(connection({ nodes: [], pageInfo: { hasNextPage: false, endCursor: "last" } }).hasNextPage, false);
  assert.deepEqual(connection({}).nodes, []);
});

test("issue pagination follows pageInfo cursors and rejects missing ones", () => {
  const page = issuePage({ nodes: [rawIssue], pageInfo: { hasNextPage: true, endCursor: "next" } });
  assert.equal(page.nextCursor, "next");
  assert.equal(page.issues[0].identifier, "ENG-42");
  assert.equal(issuePage({ nodes: [], pageInfo: { hasNextPage: false, endCursor: "last" } }).nextCursor, null);
  assert.throws(() => issuePage({ nodes: [], pageInfo: { hasNextPage: true } }), /cursor/);
  assert.throws(() => issuePage({}), /issue list/);
});

test("prompt preserves description, relationships, comments, user instructions and context warnings", () => {
  const prompt = buildPrompt({ ...detail, warnings: ["Some context unavailable"] }, input.instructions);
  assert.ok(prompt.includes(rawIssue.description));
  assert.ok(prompt.includes("ENG-43"));
  assert.ok(prompt.includes("Regression on mobile"));
  assert.ok(prompt.includes(input.instructions));
  assert.ok(prompt.includes("Some context unavailable"));
  assert.ok(prompt.includes("external task data"));
  assert.throws(() => buildContext({ description: "x".repeat(200_001) }, []), /too large/);
});

test("relationships normalize relations and inverse relations into directed, de-duplicated statements", () => {
  const both = relationships({
    id: "issue-1",
    relations: { nodes: [
      { type: "blocks", issue: { id: "issue-1" }, relatedIssue: { id: "issue-2", identifier: "ENG-43", title: "Blocked work", url: "https://linear.app/example/issue/ENG-43" } },
      { type: "duplicate", issue: { id: "issue-1" }, relatedIssue: { id: "issue-3", identifier: "ENG-44", title: "Copy ticket" } },
      { type: "related", issue: { id: "issue-1" }, relatedIssue: { id: "issue-4", identifier: "ENG-45", title: "Nearby work" } },
    ] },
    inverseRelations: { nodes: [
      { type: "blocks", issue: { id: "issue-5", identifier: "ENG-46", title: "Upstream" }, relatedIssue: { id: "issue-1" } },
      { type: "duplicated", issue: { id: "issue-6", identifier: "ENG-47", title: "The copy" }, relatedIssue: { id: "issue-1" } },
      { type: "related", issue: { id: "issue-7", identifier: "ENG-48", title: "Nearby too" }, relatedIssue: { id: "issue-1" } },
    ] },
  });
  assert.deepEqual(both, [
    { direction: "blocks", identifier: "ENG-43", title: "Blocked work", url: "https://linear.app/example/issue/ENG-43" },
    { direction: "duplicates", identifier: "ENG-44", title: "Copy ticket" },
    { direction: "related to", identifier: "ENG-45", title: "Nearby work" },
    { direction: "blocked by", identifier: "ENG-46", title: "Upstream" },
    { direction: "duplicated by", identifier: "ENG-47", title: "The copy" },
    { direction: "related to", identifier: "ENG-48", title: "Nearby too" },
  ]);
  // The OW-1731 shape: no forward relations, inverse-only must still surface.
  const inverseOnly = relationships({
    id: "issue-1",
    relations: { nodes: [] },
    inverseRelations: { nodes: [{ type: "related", issue: { id: "issue-9", identifier: "OW-1732", title: "Other ticket" }, relatedIssue: { id: "issue-1" } }] },
  });
  assert.deepEqual(inverseOnly, [{ direction: "related to", identifier: "OW-1732", title: "Other ticket" }]);
  // Relations-only still works, and unresolvable sides fall back to the list's direction.
  const forwardOnly = relationships({
    id: "issue-1",
    relations: { nodes: [{ type: "blocks", issue: null, relatedIssue: { id: "issue-2", identifier: "ENG-43", title: "Blocked work" } }] },
  });
  assert.deepEqual(forwardOnly, [{ direction: "blocks", identifier: "ENG-43", title: "Blocked work" }]);
  // Self-referencing entries and identical (direction, otherId) pairs are not emitted twice.
  const duplicated = relationships({
    id: "issue-1",
    relations: { nodes: [
      { type: "related", issue: { id: "issue-1" }, relatedIssue: { id: "issue-1" } },
      { type: "related", issue: { id: "issue-1" }, relatedIssue: { id: "issue-9", identifier: "OW-1732", title: "Other ticket" } },
    ] },
    inverseRelations: { nodes: [{ type: "related", issue: { id: "issue-9", identifier: "OW-1732", title: "Other ticket" }, relatedIssue: { id: "issue-1" } }] },
  });
  assert.deepEqual(duplicated, [{ direction: "related to", identifier: "OW-1732", title: "Other ticket" }]);
  // Missing or absent payloads produce nothing, never a crash.
  assert.deepEqual(relationships({ id: "issue-1" }), []);
  assert.deepEqual(relationships({}), []);
  assert.deepEqual(relationships(null), []);
});

test("prompts render a relationships block above the snapshot only when the ticket has relationships", () => {
  const inverseOnly = { ...rawIssue, relations: { nodes: [] }, inverseRelations: { nodes: [{ type: "related", issue: { id: "issue-9", identifier: "OW-1732", title: "Other ticket" }, relatedIssue: { id: "issue-1" } }] } };
  const withRelations = { issue: normalizeIssue(inverseOnly), teamId: null, projectId: null, context: buildContext(inverseOnly, []), warnings: [], relations: ticketRelations(inverseOnly) };
  const prompt = buildPrompt(withRelations, "");
  assert.ok(prompt.includes("Relationships:\n- related to OW-1732: Other ticket"));
  assert.ok(prompt.indexOf("Relationships:") < prompt.indexOf("Linear ticket snapshot (JSON):"));
  const template = "Handle {{ticket}}.\n\n{{instructions}}\n\n{{context}}";
  const templated = buildPrompt(withRelations, "", template);
  assert.ok(templated.includes("Relationships:\n- related to OW-1732: Other ticket"));
  assert.ok(templated.indexOf("Relationships:") < templated.indexOf(`"id": "issue-1"`), "relationships precede the JSON snapshot in template prompts");
  const without = { issue: normalizeIssue({ ...rawIssue, relations: undefined, inverseRelations: undefined }), teamId: null, projectId: null, context: buildContext({ ...rawIssue, relations: undefined, inverseRelations: undefined }, []), warnings: [], relations: ticketRelations({ ...rawIssue, relations: undefined, inverseRelations: undefined }) };
  const plain = buildPrompt(without, "");
  assert.ok(!plain.includes("Relationships:"), "no empty Relationships header");
  assert.ok(!buildPrompt("raw context string", "").includes("Relationships:"));
});

test("a custom default prompt template renders ticket, instructions and context in place", () => {
  const template = "Handle {{ticket}}.\n\nPlan first, then implement and run the tests.\n\n{{instructions}}\n\n\nSnapshot:\n{{context}}";
  const prompt = buildPrompt({ ...detail, warnings: ["Comments unavailable"] }, input.instructions, template);
  assert.ok(prompt.startsWith("Handle ENG-42: Fix the sign-in flow."));
  assert.ok(prompt.includes("Add a regression check."));
  assert.ok(prompt.includes("Regression on mobile"));
  assert.ok(prompt.endsWith("Context limitations:\nComments unavailable"));
  assert.ok(!prompt.includes("{{"), "no placeholders may survive rendering");
  assert.ok(!prompt.includes("\n\n\n"), "blank runs collapse to a single blank line");
  const noInstructions = buildPrompt(detail, "", "Check {{ticket}}\n{{instructions}}\n{{context}}");
  assert.ok(!noInstructions.includes("{{") && !noInstructions.includes("\n\n\n"));
});

test("template validation rejects missing context placeholders and oversized text", () => {
  assert.equal(normalizeTemplate(""), null);
  assert.equal(normalizeTemplate("  "), null);
  assert.equal(normalizeTemplate("  do {{context}}  "), "do {{context}}");
  assert.throws(() => normalizeTemplate("no placeholder at all"), /must include \{\{context\}\}/);
  assert.throws(() => normalizeTemplate(`x${"y".repeat(MAX_TEMPLATE_LENGTH)}`), /limited to/);
});

test("settings persist the template with private permissions and reset removes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-settings-"));
  const path = join(directory, "settings.json");
  try {
    const settings = new Settings(path);
    assert.deepEqual(await settings.read(), { template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
    const saved = await settings.save("Handle {{ticket}}\n{{context}}");
    assert.equal(saved.template, "Handle {{ticket}}\n{{context}}");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await settings.read(), saved);
    assert.deepEqual(await settings.save(""), { template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.deepEqual(await settings.read(), { template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the mark-in-progress setting round-trips without disturbing the saved template", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-settings-mark-"));
  const path = join(directory, "settings.json");
  try {
    const settings = new Settings(path);
    await settings.patch({ markInProgress: true });
    assert.deepEqual(await settings.read(), { template: null, markInProgress: true, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
    await settings.save("Handle {{ticket}}\n{{context}}");
    assert.deepEqual(await settings.read(), { template: "Handle {{ticket}}\n{{context}}", markInProgress: true, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
    // The closed-states setting round-trips the same way and never disturbs the other fields.
    await settings.patch({ showClosed: true });
    assert.deepEqual(await settings.read(), { template: "Handle {{ticket}}\n{{context}}", markInProgress: true, showClosed: true, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
    // Clearing the template keeps the flags; clearing the last flag with no template removes the file.
    await settings.patch({ template: "" });
    assert.deepEqual(await settings.read(), { template: null, markInProgress: true, showClosed: true, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
    await settings.patch({ markInProgress: false, showClosed: false });
    assert.deepEqual(await settings.read(), { template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true, ...automationDefaults });
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("settings remember the last successful launch choices per provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-settings-launch-"));
  const path = join(directory, "settings.json");
  try {
    const settings = new Settings(path);
    await settings.patch({ launchPreference: { provider: "codex", model: "codex/gpt-5", modeId: "code", thinkingOptionId: "high" } });
    await settings.patch({ launchPreference: { provider: "claude", model: "claude/sonnet" } });
    assert.deepEqual(await settings.read(), {
      template: null, markInProgress: false, showClosed: false, lastProvider: "claude",
      launchPreferences: {
        codex: { model: "codex/gpt-5", modeId: "code", thinkingOptionId: "high" },
        claude: { model: "claude/sonnet" },
      },
      projectMappings: {}, agentLinearAccess: true, ...automationDefaults,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("saved credentials stay on disk with private permissions and environment credentials take precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-credentials-"));
  const path = join(directory, "connection", "credentials.json");
  try {
    const saved = new Credentials(path, "");
    assert.deepEqual(await saved.read(), { key: null, source: "none" });
    await saved.save("test-key");
    assert.deepEqual(await saved.read(), { key: "test-key", source: "saved" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "connection"))).mode & 0o777, 0o700);
    const environment = new Credentials(path, "environment-key");
    assert.deepEqual(await environment.read(), { key: "environment-key", source: "environment" });
    await assert.rejects(environment.save("replacement"), /LINEAR_API_KEY/);
    await assert.rejects(environment.remove(), /LINEAR_API_KEY/);
    await saved.remove();
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

type PostCall = { key: string; query: string; variables: Record<string, unknown> };

function mockLinear(post: Post, environmentKey = "test-key") {
  return new LinearService(new Credentials("/unused", environmentKey), post);
}

test("ticket listing requests the authenticated user's assignments and forwards the cursor", async () => {
  const calls: PostCall[] = [];
  const post: Post = async (key, query, variables) => {
    calls.push({ key, query, variables });
    return { issues: { nodes: [rawIssue], pageInfo: { hasNextPage: false, endCursor: null } } };
  };
  const service = mockLinear(post);
  assert.deepEqual((await service.issues()).nextCursor, null);
  const page = await service.issues("page-2");
  assert.equal(page.issues[0].identifier, "ENG-42");
  assert.equal(page.issues[0].status, "In Progress");
  assert.equal(page.issues[0].labels[0], "bug");
  assert.equal(page.nextCursor, null);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.key, "test-key");
    assert.equal(call.query, LIST_ISSUES_QUERY);
  }
  assert.deepEqual(calls[0].variables, { first: 50, after: null, filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } } });
  assert.deepEqual(calls[1].variables, { first: 50, after: "page-2", filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } } });
});

test("the list filter is deterministic; an explicit status selection beats the closed-states setting", () => {
  assert.deepEqual(listIssueFilter(), { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } });
  assert.deepEqual(listIssueFilter(undefined, true), { assignee: { isMe: { eq: true } } });
  assert.deepEqual(listIssueFilter([], false), { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } });
  assert.deepEqual(listIssueFilter(["Done", "  In Progress", "Done", "  "]), { assignee: { isMe: { eq: true } }, state: { name: { in: ["Done", "In Progress"] } } });
  assert.deepEqual(listIssueFilter(["Done"], true), listIssueFilter(["Done"]));
  assert.deepEqual(listIssueFilter(undefined, false, "blocking"), {
    assignee: { isMe: { eq: true } },
    state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    hasBlockingRelations: { eq: true },
  });
  assert.deepEqual(listIssueFilter(["Todo"], false, "blocked"), {
    assignee: { isMe: { eq: true } },
    state: { name: { in: ["Todo"] } },
    hasBlockedByRelations: { eq: true },
  });
});

test("ticket listing forwards the built filter to Linear", async () => {
  const calls: PostCall[] = [];
  const post: Post = async (_key, _query, variables) => {
    calls.push({ key: "test-key", query: LIST_ISSUES_QUERY, variables });
    return { issues: { nodes: [rawIssue], pageInfo: { hasNextPage: false, endCursor: null } } };
  };
  const service = mockLinear(post);
  await service.issues();
  assert.deepEqual(calls[0].variables, { first: 50, after: null, filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } } });
  await service.issues(undefined, undefined, true);
  assert.deepEqual(calls[1].variables, { first: 50, after: null, filter: { assignee: { isMe: { eq: true } } } });
  await service.issues(undefined, ["In Progress"]);
  assert.deepEqual(calls[2].variables, { first: 50, after: null, filter: { assignee: { isMe: { eq: true } }, state: { name: { in: ["In Progress"] } } } });
  await service.issues(undefined, undefined, false, "blocking");
  assert.deepEqual(calls[3].variables, { first: 50, after: null, filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } }, hasBlockingRelations: { eq: true } } });
});

test("issue counts aggregate across pages, skip malformed nodes, and report completeness", async () => {
  const calls: PostCall[] = [];
  const pages = [
    { issues: { nodes: [
      { state: { name: "In Progress", type: "started" } },
      { state: { name: "Done", type: "completed" } },
      { state: null },
      null,
    ], pageInfo: { hasNextPage: true, endCursor: "c2" } } },
    { issues: { nodes: [{ state: { name: "In Progress", type: "started" } }], pageInfo: { hasNextPage: false, endCursor: "c3" } } },
  ];
  const post: Post = async (key, query, variables) => {
    calls.push({ key, query, variables });
    return pages[calls.length - 1];
  };
  const counts = await mockLinear(post).countIssues();
  assert.deepEqual(counts, { total: 4, byName: { "In Progress": 2, Done: 1, "No status": 1 }, byType: { started: 2, completed: 1, unknown: 1 }, complete: true });
  assert.deepEqual(calls[0].variables, { first: 50, after: null, filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } } });
  assert.deepEqual(calls[1].variables, { first: 50, after: "c2", filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } } });
});

test("issue counts follow the closed-states setting", async () => {
  const calls: PostCall[] = [];
  const post: Post = async (key, query, variables) => {
    calls.push({ key, query, variables });
    return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
  };
  await mockLinear(post).countIssues(true);
  assert.deepEqual(calls[0].variables, { first: 50, after: null, filter: { assignee: { isMe: { eq: true } } } });
});

test("issue counts stop at the page cap and flag the sweep as incomplete", async () => {
  let calls = 0;
  const post: Post = async () => {
    calls++;
    return { issues: { nodes: [{ state: { name: "Todo", type: "unstarted" } }], pageInfo: { hasNextPage: true, endCursor: `c${calls}` } } };
  };
  const counts = await mockLinear(post).countIssues();
  assert.equal(calls, 25);
  assert.equal(counts.total, 25);
  assert.equal(counts.complete, false);
});

test("list and count RPC contracts validate their inputs and outputs", () => {
  assert.equal(listIssuesRpc.input.safeParse({ stateNames: ["Done"] }).success, true);
  assert.equal(listIssuesRpc.input.safeParse({ relation: "blocking" }).success, true);
  assert.equal(listIssuesRpc.input.safeParse({ relation: "blocked" }).success, true);
  assert.equal(listIssuesRpc.input.safeParse({ relation: "related" }).success, false);
  assert.equal(listIssuesRpc.input.safeParse({ stateNames: Array.from({ length: 13 }, (_, i) => `s${i}`) }).success, false);
  assert.equal(listIssuesRpc.input.safeParse({ cursor: "x", stateNames: ["a", "b"] }).success, true);
  assert.equal(countIssuesRpc.input.safeParse({}).success, true);
  assert.equal(countIssuesRpc.output.safeParse({ total: 3, byName: { a: 3 }, byType: { backlog: 3 }, complete: true }).success, true);
  assert.equal(countIssuesRpc.output.safeParse({ total: -1, byName: {}, byType: {}, complete: true }).success, false);
  assert.equal(cachedOverviewRpc.output.safeParse({ issues: [normalizeIssue(rawIssue)], nextCursor: null, updatedAt: "2026-09-21T10:00:00Z" }).success, true);
  assert.equal(cachedOverviewRpc.output.safeParse({ issues: [], nextCursor: null }).success, false);
  assert.equal(searchIssuesRpc.input.safeParse({ term: "ab" }).success, true);
  assert.equal(searchIssuesRpc.input.safeParse({ term: "a" }).success, false);
  assert.equal(searchIssuesRpc.input.safeParse({ term: "x".repeat(201) }).success, false);
});

test("workspace search forwards the trimmed term and normalizes a result page", async () => {
  const calls: PostCall[] = [];
  const post: Post = async (key, query, variables) => {
    calls.push({ key, query, variables });
    return { searchIssues: { nodes: [rawIssue], pageInfo: { hasNextPage: true, endCursor: "s2" } } };
  };
  const service = mockLinear(post);
  const page = await service.searchIssues("  pr template  ");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, SEARCH_ISSUES_QUERY);
  assert.deepEqual(calls[0].variables, { term: "pr template", first: 50, after: null });
  assert.equal(page.nextCursor, "s2");
  assert.equal(page.issues[0].identifier, "ENG-42");
  const next = await service.searchIssues("pr template", "s2");
  assert.deepEqual(calls[1].variables, { term: "pr template", first: 50, after: "s2" });
  assert.equal(next.nextCursor, "s2");
});

test("details fetch relations and paginated comments using the resolved issue ID", async () => {
  const calls: PostCall[] = [];
  const post: Post = async (key, query, variables) => {
    calls.push({ key, query, variables });
    if (query === ISSUE_DETAIL_QUERY) return { issue: rawIssue };
    if (query === COMMENT_QUERY) {
      assert.equal(variables.id, "issue-1");
      assert.equal(variables.first, 50);
      return variables.after == null
        ? { issue: { comments: { nodes: [comment], pageInfo: { hasNextPage: true, endCursor: "c2" } } } }
        : { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "c3" } } } };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  const result = await mockLinear(post).detail("ENG-42");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].query, ISSUE_DETAIL_QUERY);
  assert.deepEqual(calls[0].variables, { id: "ENG-42" });
  assert.equal(calls[1].query, COMMENT_QUERY);
  assert.deepEqual(calls[1].variables, { id: "issue-1", first: 50, after: null });
  assert.deepEqual(calls[2].variables, { id: "issue-1", first: 50, after: "c2" });
  assert.equal(JSON.parse(result.context).comments.length, 1);
  assert.equal(JSON.parse(result.context).comments[0].body, "Regression on mobile");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.relations.parent, null);
  assert.deepEqual(result.relations.subissues.map((ticket) => ticket.identifier), ["ENG-44"]);
  assert.deepEqual(result.relations.related.map((ticket) => [ticket.direction, ticket.identifier]), [["blocks", "ENG-43"]]);
});

test("detail queries state history and folds it into the context snapshot and prompt", async () => {
  const calls: PostCall[] = [];
  const post: Post = async (key, query, variables) => {
    calls.push({ key, query, variables });
    if (query === ISSUE_DETAIL_QUERY) return { issue: { ...rawIssue, dueDate: "2026-10-01", estimate: 3, stateHistory: { nodes: [
      { state: { name: "Todo", type: "unstarted" }, startedAt: "2026-09-18T20:56:19Z", endedAt: "2026-09-18T21:02:05Z" },
      { state: { name: "In Progress", type: "started" }, startedAt: "2026-09-18T21:02:05Z", endedAt: null },
      { state: null },
    ] } } };
    return { issue: { comments: { nodes: [comment], pageInfo: { hasNextPage: false, endCursor: null } } } };
  };
  const result = await mockLinear(post).detail("ENG-42");
  const parsed = JSON.parse(result.context);
  assert.equal(result.issue.dueDate, "2026-10-01");
  assert.equal(result.issue.estimate, 3);
  assert.deepEqual(parsed.stateHistory.map((span: { state: string }) => span.state), ["Todo", "In Progress"]);
  assert.equal(parsed.stateHistory[1].endedAt, null);
  assert.match(buildPrompt(result, ""), /Status changes: Todo → In Progress \(currently In Progress\)/);
  assert.doesNotMatch(buildPrompt(JSON.stringify({ issue: rawIssue, comments: [] }), ""), /Status changes/);
});

test("due dates and estimates normalize to explicit nulls when absent", () => {
  assert.equal(normalizeIssue({ ...rawIssue, dueDate: "2026-10-01", estimate: 5 }).dueDate, "2026-10-01");
  assert.equal(normalizeIssue({ ...rawIssue, dueDate: "2026-10-01", estimate: 5 }).estimate, 5);
  assert.equal(normalizeIssue(rawIssue).dueDate, null);
  assert.equal(normalizeIssue(rawIssue).estimate, null);
});

test("state history spans drop malformed entries and only appear in context when present", () => {
  assert.deepEqual(stateHistorySpans({ stateHistory: { nodes: [
    { state: { name: "Todo" }, startedAt: "s", endedAt: "e" },
    { state: { name: "" } },
    null,
    42,
    { state: { name: "Done" }, startedAt: "x", endedAt: null },
  ] } }), [{ state: "Todo", startedAt: "s", endedAt: "e" }, { state: "Done", startedAt: "x", endedAt: null }]);
  assert.deepEqual(stateHistorySpans(rawIssue), []);
  assert.doesNotMatch(buildContext(rawIssue, [], []), /stateHistory/);
  assert.match(buildContext(rawIssue, [], [{ state: "Todo", startedAt: "s", endedAt: null }]), /\"stateHistory\"/);
});

test("comment failures produce an explicit warning while the ticket details remain", async () => {
  const post: Post = async (_key, query) => {
    if (query === ISSUE_DETAIL_QUERY) return { issue: rawIssue };
    throw new Error("Connection lost");
  };
  const result = await mockLinear(post).detail("ENG-42");
  assert.match(result.warnings[0], /Comments could not be loaded/);
  assert.deepEqual(JSON.parse(result.context).comments, []);
});

test("missing issues fail explicitly and unconnected access asks for a connection", async () => {
  const post: Post = async () => ({ issue: null });
  await assert.rejects(mockLinear(post).detail("ENG-99"), /did not return this issue/);
  await assert.rejects(mockLinear(post, "").issues(), /Connect Linear/);
});

test("authenticate confirms the viewer and saves the key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-auth-"));
  const path = join(directory, "credentials.json");
  try {
    const calls: PostCall[] = [];
    const post: Post = async (key, query, variables) => {
      calls.push({ key, query, variables });
      return { viewer: { id: "user-1" } };
    };
    const service = new LinearService(new Credentials(path, ""), post);
    const status = await service.authenticate("fresh-key");
    assert.deepEqual(status, { connected: true, source: "saved" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "fresh-key");
    assert.equal(calls[0].query, VIEWER_QUERY);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { apiKey: "fresh-key" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("authenticate rejects keys Linear cannot confirm", async () => {
  const post: Post = async () => ({ viewer: null });
  await assert.rejects(mockLinear(post).authenticate("bad-key"), /did not confirm this API key/);
});

function mockPaseo(create: (options: PaseoWorkspaceAgentCreateOptions) => Promise<{ id: string }>, project: object | null = { projectId: "project-1", projectKind: "directory", projectRootPath: "/repo" }, onWorkspace?: (options: PaseoWorkspaceCreateOptions) => void) {
  return {
    projects: { list: async () => ({ projects: project ? [project] : [] }) },
    workspaces: { create: async (options: PaseoWorkspaceCreateOptions) => {
      onWorkspace?.(options);
      return { agents: { create } };
    } },
  } as unknown as PaseoApi;
}

test("launch fetches fresh context and starts exactly one agent for concurrent calls and response retries", async () => {
  let fetches = 0, creates = 0;
  const launcher = new Launcher({ ...noMark, detail: async () => { fetches++; return detail; } });
  const configured = { ...input, modeId: "code", thinkingOptionId: "high" };
  const paseo = mockPaseo(async (options) => {
    creates++;
    assert.deepEqual(options.config, { provider: input.provider, modeId: "code", thinkingOptionId: "high" });
    assert.equal(options.labels?.["linear.issueId"], "issue-1");
    assert.ok(options.prompt?.includes("Regression on mobile"));
    assert.ok(options.prompt?.includes(input.instructions));
    return { id: "agent-1" };
  });
  const alias = { ...configured, requestId: "3bca04b9-12a5-4764-8b11-98ad10c15c95" };
  const results = await Promise.all([launcher.start(configured, paseo), launcher.start(configured, paseo), launcher.start(alias, paseo)]);
  assert.ok(results.every((result) => result.agentId === "agent-1"));
  await launcher.start(configured, paseo);
  await launcher.start(alias, paseo);
  assert.equal(fetches, 1);
  assert.equal(creates, 1);
  await assert.rejects(launcher.start({ ...configured, id: "ENG-99" }, paseo), /already been used/);
});

test("a saved default prompt template shapes the agent's first prompt", async () => {
  let captured: string | undefined;
  const launcher = new Launcher({ ...noMark, detail: async () => detail });
  const paseo = mockPaseo(async (options) => { captured = options.prompt; return { id: "agent-1" }; });
  const template = "Handle {{ticket}}.\nPlan first, then code.\n\n{{instructions}}\n\n{{context}}";
  const result = await launcher.start(input, paseo, { promptTemplate: template });
  assert.equal(result.agentId, "agent-1");
  assert.ok(captured?.startsWith("Handle ENG-42: Fix the sign-in flow."));
  assert.ok(captured?.includes("Add a regression check."));
  assert.ok(captured?.includes("Regression on mobile"));
  // Changing the template is a new launch, not a retry of the same request.
  await assert.rejects(launcher.start({ ...input, instructions: "" }, paseo, { promptTemplate: "other {{context}}" }), /already been used/);
});

test("the plan advisor reads the same ticket prompt the agent starts with", async () => {
  let options: PaseoWorkspaceAgentCreateOptions | undefined;
  const launcher = new Launcher({ ...noMark, detail: async () => detail });
  await launcher.start({ ...input, requestId: "8a1f2c3d-0000-4000-8000-000000000001" }, mockPaseo(async (created) => { options = created; return { id: "agent-1" }; }), { env: { LINEAR_TICKETS_PLAN: "required" } });
  const path = options?.env?.LINEAR_TICKETS_CONTEXT;
  assert.ok(path, "every ticket agent gets the context path");
  assert.equal(options?.env?.LINEAR_TICKETS_PLAN, "required", "the plan policy env is kept");
  assert.equal(await readFile(path, "utf8"), options?.prompt);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a ticket context that cannot be saved warns and still launches, without the path", async () => {
  let options: PaseoWorkspaceAgentCreateOptions | undefined;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, undefined, undefined, async () => { throw new Error("disk full"); });
  const result = await launcher.start({ ...input, requestId: "8a1f2c3d-0000-4000-8000-000000000002" }, mockPaseo(async (created) => { options = created; return { id: "agent-1" }; }));
  assert.equal(result.agentId, "agent-1");
  assert.equal(options?.env, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("disk full")));
});

test("pre-launch errors can retry, but uncertain agent creation is never automatically repeated", async () => {
  let fetches = 0, creates = 0;
  const launcher = new Launcher({ ...noMark, detail: async () => {
    if (++fetches === 1) throw new Error("Linear unavailable");
    return detail;
  } });
  const paseo = mockPaseo(async () => { creates++; throw new Error("Response lost after creation"); });
  await assert.rejects(launcher.start(input, paseo), /Linear unavailable/);
  await assert.rejects(launcher.start(input, paseo), /could not be confirmed/);
  await assert.rejects(launcher.start(input, paseo), /could not be confirmed/);
  assert.equal(fetches, 2);
  assert.equal(creates, 1);
});

test("a missing project cannot create an agent", async () => {
  const launcher = new Launcher({ ...noMark, detail: async () => { throw new Error("Should not fetch"); } });
  const paseo = mockPaseo(async () => { throw new Error("Should not create"); }, null);
  await assert.rejects(launcher.start(input, paseo), /project is no longer available/);
});


test("safeBranchName accepts canonical Linear names and rejects unsafe git refs", () => {
  assert.equal(safeBranchName("victor/ow-1748-define-a-pr-template"), "victor/ow-1748-define-a-pr-template");
  assert.equal(safeBranchName("  main  "), "main");
  assert.equal(safeBranchName(""), null);
  assert.equal(safeBranchName("   "), null);
  assert.equal(safeBranchName(null), null);
  assert.equal(safeBranchName(42), null);
  assert.equal(safeBranchName("bad name"), null);
  assert.equal(safeBranchName("a..b"), null);
  assert.equal(safeBranchName("a~1"), null);
  assert.equal(safeBranchName("a^b"), null);
  assert.equal(safeBranchName("a:b"), null);
  assert.equal(safeBranchName("a?b"), null);
  assert.equal(safeBranchName("a*b"), null);
  assert.equal(safeBranchName("a[b]"), null);
  assert.equal(safeBranchName("a\\b"), null);
  assert.equal(safeBranchName("a\u0000b"), null);
  assert.equal(safeBranchName("/leading"), null);
  assert.equal(safeBranchName(".hidden"), null);
  assert.equal(safeBranchName("trailing/"), null);
  assert.equal(safeBranchName("trailing."), null);
  assert.equal(safeBranchName("@{u}"), null);
  assert.equal(safeBranchName("branch.lock"), null);
  assert.equal(safeBranchName(`long-${"x".repeat(250)}`), null);
});

test("Git launches create a new ticket worktree from the chosen project and base branch", async () => {
  let workspaces = 0;
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, async () => ({ branches: [{ id: "refs/remotes/origin/main", label: "origin/main" }], defaultBranch: null }));
  const paseo = mockPaseo(async () => ({ id: "agent-1" }), { projectId: "project-1", projectKind: "git", projectRootPath: "/repo" }, (options) => {
    workspaces++;
    assert.deepEqual(options.source, { kind: "worktree", projectId: "project-1", cwd: "/repo", action: "branch-off", baseBranch: "refs/remotes/origin/main", branchName: "eng-42-5f6f1154" });
    assert.equal(options.title, "ENG-42: Fix the sign-in flow");
  });
  const request = { ...input, baseBranch: "refs/remotes/origin/main" };
  await launcher.start(request, paseo);
  await launcher.start(request, paseo);
  assert.equal(workspaces, 1);
  await assert.rejects(launcher.start({ ...request, baseBranch: "refs/heads/other" }, paseo), /already been used/);
});

test("Git launches use Linear's canonical branch name when present and safe", async () => {
  const withBranch = { ...detail, issue: { ...detail.issue, branchName: "victor/ow-1748-define-a-pr-template-in-ow-back" } };
  const launcher = new Launcher({ ...noMark, detail: async () => withBranch }, async () => ({ branches: [{ id: "refs/remotes/origin/main", label: "origin/main" }], defaultBranch: null }));
  const paseo = mockPaseo(async () => ({ id: "agent-1" }), { projectId: "project-1", projectKind: "git", projectRootPath: "/repo" }, (options) => {
    assert.deepEqual(options.source, { kind: "worktree", projectId: "project-1", cwd: "/repo", action: "branch-off", baseBranch: "refs/remotes/origin/main", branchName: "victor/ow-1748-define-a-pr-template-in-ow-back" });
  });
  const request = { ...input, baseBranch: "refs/remotes/origin/main" };
  await launcher.start(request, paseo);
});

test("unsafe Linear branch names fall back to the synthesized slug", async () => {
  const withBranch = { ...detail, issue: { ...detail.issue, branchName: "bad name~1" } };
  const launcher = new Launcher({ ...noMark, detail: async () => withBranch }, async () => ({ branches: [{ id: "refs/remotes/origin/main", label: "origin/main" }], defaultBranch: null }));
  const paseo = mockPaseo(async () => ({ id: "agent-1" }), { projectId: "project-1", projectKind: "git", projectRootPath: "/repo" }, (options) => {
    assert.equal((options.source as { branchName?: string }).branchName, "eng-42-5f6f1154");
  });
  const request = { ...input, baseBranch: "refs/remotes/origin/main" };
  await launcher.start(request, paseo);
});

test("a colliding Linear branch name is retried exactly once with the request suffix", async () => {
  const withBranch = { ...detail, issue: { ...detail.issue, branchName: "victor/ow-1748" } };
  const attempts: PaseoWorkspaceCreateOptions[] = [];
  const launcher = new Launcher({ ...noMark, detail: async () => withBranch }, async () => ({ branches: [{ id: "refs/remotes/origin/main", label: "origin/main" }], defaultBranch: null }));
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "project-1", projectKind: "git", projectRootPath: "/repo" }] }) },
    workspaces: { create: async (options: PaseoWorkspaceCreateOptions) => {
      attempts.push(options);
      if (attempts.length === 1) throw new Error("fatal: a branch named 'victor/ow-1748' already exists");
      return { agents: { create: async () => ({ id: "agent-1" }) } };
    } },
  } as unknown as PaseoApi;
  const request = { ...input, baseBranch: "refs/remotes/origin/main" };
  const result = await launcher.start(request, paseo);
  assert.equal(result.agentId, "agent-1");
  assert.equal(attempts.length, 2);
  assert.equal((attempts[0].source as { branchName?: string }).branchName, "victor/ow-1748");
  assert.equal((attempts[1].source as { branchName?: string }).branchName, "victor/ow-1748-5f6f1154");
  assert.equal(attempts[1].requestId, "5f6f1154-5838-4439-b981-b3c9d9831488-workspace-retry");
});

test("non-collision workspace failures are never retried", async () => {
  const withBranch = { ...detail, issue: { ...detail.issue, branchName: "victor/ow-1748" } };
  let attempts = 0;
  const launcher = new Launcher({ ...noMark, detail: async () => withBranch }, async () => ({ branches: [{ id: "refs/remotes/origin/main", label: "origin/main" }], defaultBranch: null }));
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "project-1", projectKind: "git", projectRootPath: "/repo" }] }) },
    workspaces: { create: async () => { attempts++; throw new Error("network connection lost"); } },
  } as unknown as PaseoApi;
  const request = { ...input, baseBranch: "refs/remotes/origin/main" };
  await assert.rejects(launcher.start(request, paseo), /could not be confirmed/);
  assert.equal(attempts, 1);
});

test("removed or missing base branches fail before creating a workspace", async () => {
  const launcher = new Launcher({ ...noMark, detail: async () => { throw new Error("Should not fetch"); } }, async () => ({ branches: [], defaultBranch: null }));
  const paseo = mockPaseo(async () => { throw new Error("Should not create"); }, { projectId: "project-1", projectKind: "git", projectRootPath: "/repo" }, () => { throw new Error("Should not create workspace"); });
  await assert.rejects(launcher.start({ ...input, baseBranch: "refs/heads/deleted" }, paseo), /available base branch/);
});

test("uncertain workspace creation is not repeated on request retry", async () => {
  let attempts = 0;
  const launcher = new Launcher({ ...noMark, detail: async () => detail });
  const paseo = mockPaseo(async () => { throw new Error("Should not create agent"); }, undefined, () => {
    attempts++;
    throw new Error("Response lost after workspace creation");
  });
  await assert.rejects(launcher.start(input, paseo), /Workspace creation could not be confirmed/);
  await assert.rejects(launcher.start(input, paseo), /Workspace creation could not be confirmed/);
  assert.equal(attempts, 1);
});

test("started-state resolution prefers an explicit choice, then the in-progress name, then position", () => {
  const states: TeamState[] = [
    { id: "s1", name: "Todo", type: "unstarted", position: 1 },
    { id: "s2", name: "In Review", type: "started", position: 2 },
    { id: "s3", name: "In Progress", type: "started", position: 3 },
    { id: "s4", name: "Done", type: "completed", position: 4 },
  ];
  assert.equal(resolveStartedState(states)?.name, "In Progress");
  // An explicit choice wins over the name heuristic.
  assert.equal(resolveStartedState(states, "s2")?.name, "In Review");
  // Without an "in progress" name, the lowest-position started state wins.
  assert.equal(resolveStartedState(states.filter((state) => state.id !== "s3"))?.name, "In Review");
  // A team with no started states gets no target — never a write to "Todo" or "Done".
  assert.equal(resolveStartedState(states.filter((state) => state.type === "unstarted")), null);
});

function makeStateService(path: string, states: unknown, mutationResponse: Record<string, unknown>, calls: unknown[][]): LinearService {
  return new LinearService(new Credentials(path, "env-key"), (key, query, variables) => {
    calls.push([query, variables]);
    return Promise.resolve(query === UPDATE_ISSUE_STATE_QUERY ? mutationResponse : { team: { states: { nodes: states } } });
  });
}

test("marking in progress is a no-op for tickets already in a started state", async () => {
  const calls: unknown[][] = [];
  const service = makeStateService(join(tmpdir(), `paseo-linear-mark-${process.pid}`), [], {}, calls);
  const result = await service.markInProgress(normalizeIssue(rawIssue), "team-1");
  assert.deepEqual(result, { changed: false });
  assert.equal(calls.length, 0);
});

test("marking in progress sends exactly one mutation to the resolved state", async () => {
  const calls: unknown[][] = [];
  const service = makeStateService(
    join(tmpdir(), `paseo-linear-mark2-${process.pid}`),
    [{ id: "ip", name: "In Progress", type: "started", position: 2 }, { id: "ir", name: "In Review", type: "started", position: 1 }],
    { issueUpdate: { success: true, issue: { id: "issue-1", state: { name: "In Progress" } } } },
    calls,
  );
  const result = await service.markInProgress({ ...normalizeIssue(rawIssue), status: "Todo", statusType: "unstarted" }, "team-1");
  assert.deepEqual(result, { changed: true });
  const mutations = calls.filter(([query]) => query === UPDATE_ISSUE_STATE_QUERY);
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0][1], { id: "issue-1", stateId: "ip" });
});

test("mutation failures become notes: success=false, thrown errors, and teams without a started state", async () => {
  const ticket = { ...normalizeIssue(rawIssue), status: "Todo", statusType: "unstarted" };
  const rejected = makeStateService(join(tmpdir(), `paseo-linear-mark3-${process.pid}`), [{ id: "ip", name: "In Progress", type: "started", position: 2 }], { issueUpdate: { success: false } }, []);
  const rejectedResult = await rejected.markInProgress(ticket, "team-1");
  assert.equal(rejectedResult.changed, false);
  assert.match(rejectedResult.note ?? "", /not applied/);

  const throwing = makeStateService(join(tmpdir(), `paseo-linear-mark4-${process.pid}`), [{ id: "ip", name: "In Progress", type: "started", position: 2 }], {}, []);
  (throwing as unknown as { post: Post }).post = (async (key: string, query: string, variables: Record<string, unknown>) => {
    if (query === UPDATE_ISSUE_STATE_QUERY) throw new Error("mutation requires write access");
    return { team: { states: { nodes: [{ id: "ip", name: "In Progress", type: "started", position: 2 }] } } };
  }) as Post;
  const thrownResult = await throwing.markInProgress(ticket, "team-1");
  assert.equal(thrownResult.changed, false);
  assert.match(thrownResult.note ?? "", /write access/);

  const noStarted = makeStateService(join(tmpdir(), `paseo-linear-mark5-${process.pid}`), [{ id: "todo", name: "Todo", type: "unstarted", position: 1 }, { id: "done", name: "Done", type: "completed", position: 2 }], {}, []);
  const noneResult = await noStarted.markInProgress(ticket, "team-1");
  assert.equal(noneResult.changed, false);
  assert.match(noneResult.note ?? "", /no "In Progress" state/);

  const noTeam = makeStateService(join(tmpdir(), `paseo-linear-mark6-${process.pid}`), [], {}, []);
  const teamless = await noTeam.markInProgress(ticket, null);
  assert.equal(teamless.changed, false);
  assert.match(teamless.note ?? "", /no team/);

  const badTeam = makeStateService(join(tmpdir(), `paseo-linear-mark7-${process.pid}`), [], {}, []);
  (badTeam as unknown as { post: Post }).post = (async () => { throw new Error("Entity not found: Team"); }) as Post;
  const badResult = await badTeam.markInProgress(ticket, "team-1");
  assert.equal(badResult.changed, false);
  assert.match(badResult.note ?? "", /Could not load the ticket team's states/);
});

test("launch marks the ticket in progress only when opted in, and demotes failures to warnings", async () => {
  const calls: unknown[][] = [];
  const detailIssue = { ...rawIssue, state: { name: "Todo", type: "unstarted" } };
  const linear = new LinearService(new Credentials(join(tmpdir(), `paseo-linear-launch-${process.pid}`), "env-key"), (key, query, variables) => {
    calls.push([query, variables]);
    if (query === ISSUE_DETAIL_QUERY) return Promise.resolve({ issue: detailIssue });
    if (query === COMMENT_QUERY) return Promise.resolve({ issue: { comments: { nodes: [] } } });
    if (query === TEAM_STATES_QUERY) return Promise.resolve({ team: { states: { nodes: [{ id: "ip", name: "In Progress", type: "started", position: 2 }] } } });
    return Promise.resolve({ issueUpdate: { success: false } });
  });
  const launcher = new Launcher(linear);
  const paseo = mockPaseo(async () => ({ id: "agent-1" }));

  // Off (the default): the agent launches and no state mutation is attempted.
  const off = await launcher.start({ ...input, markInProgress: false }, paseo);
  assert.equal(off.warnings.length, 0);
  assert.equal(calls.filter(([query]) => query === UPDATE_ISSUE_STATE_QUERY).length, 0);

  // On: the mutation runs, and Linear's refusal becomes a warning, not a failure.
  const on = await launcher.start({ ...input, markInProgress: true, requestId: "6f7f2265-5949-4548-a092-c4d0e4942599" }, paseo, { markInProgress: true });
  assert.equal(on.agentId, "agent-1");
  assert.equal(on.warnings.length, 1);
  assert.match(on.warnings[0], /not applied/);
  const mutations = calls.filter(([query]) => query === UPDATE_ISSUE_STATE_QUERY);
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0][1], { id: "issue-1", stateId: "ip" });
});

test("dispatch settings normalize team keys, reject invalid edits, and are forgotten when back to defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linear-dispatch-settings-"));
  const path = join(directory, "settings.json");
  const settings = new Settings(path);
  try {
    const saved = await settings.patch({ dispatch: { enabled: true, teamKeys: ["eng", "ENG", " ops "] } });
    assert.deepEqual(saved.dispatch, { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["ENG", "OPS"] });
    assert.deepEqual((await settings.read()).dispatch, saved.dispatch);
    await assert.rejects(settings.patch({ dispatch: { teamKeys: ["not a key"] } }), /"not a key" is not a Linear team key/);
    await assert.rejects(settings.patch({ dispatch: { intervalSeconds: 5 } }), /between 30 and 3600/);
    await assert.rejects(settings.patch({ dispatch: { label: "a,b" } }), /without commas/);
    assert.deepEqual((await settings.read()).dispatch, saved.dispatch);
    await settings.patch({ writeback: { summaries: true } });
    assert.deepEqual((await settings.read()).writeback, { ...DEFAULT_WRITEBACK, summaries: true });
    await settings.patch({ dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK });
    await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a pull request only moves the ticket to a started state named for review", () => {
  const states: TeamState[] = [
    { id: "todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "ip", name: "In Progress", type: "started", position: 2 },
    { id: "rev", name: "In Review", type: "started", position: 3 },
    { id: "done", name: "Reviewed", type: "completed", position: 4 },
  ];
  assert.equal(resolveReviewState(states)?.id, "rev");
  assert.equal(resolveReviewState(states.filter((state) => state.id !== "rev")), null);
});

test("labels are created once when missing and removed by name, case-insensitively", async () => {
  const calls: unknown[][] = [];
  const service = new LinearService(new Credentials(join(tmpdir(), `paseo-linear-labels-${process.pid}`), "env-key"), (_key, query, variables) => {
    calls.push([query, variables]);
    if (query === LABEL_BY_NAME_QUERY) return Promise.resolve({ issueLabels: { nodes: [] } });
    if (query === CREATE_LABEL_QUERY) return Promise.resolve({ issueLabelCreate: { success: true, issueLabel: { id: "new-label", name: variables.name } } });
    if (query === ADD_LABEL_QUERY) return Promise.resolve({ issueAddLabel: { success: true } });
    return Promise.resolve({ issueRemoveLabel: { success: true } });
  });
  await service.addLabel("issue-1", "paseo-running");
  await service.addLabel("issue-2", "paseo-running");
  assert.equal(calls.filter(([query]) => query === CREATE_LABEL_QUERY).length, 1);
  assert.deepEqual(calls.filter(([query]) => query === ADD_LABEL_QUERY).map(([, variables]) => variables), [{ id: "issue-1", labelId: "new-label" }, { id: "issue-2", labelId: "new-label" }]);
  calls.length = 0;
  await service.removeLabel("issue-1", "Paseo", [{ id: "a", name: "paseo" }, { id: "b", name: "PASEO" }, { id: "c", name: "paseo-running" }]);
  assert.deepEqual(calls.map(([, variables]) => variables), [{ id: "issue-1", labelId: "a" }, { id: "issue-1", labelId: "b" }]);
});

test("the planning/coding transitions pick the named started state and leave finished or unchanged tickets alone", async () => {
  const states = [
    { id: "plan", name: "Planning", type: "started", position: 1.5 },
    { id: "ip", name: "In Progress", type: "started", position: 2 },
    { id: "done", name: "Done", type: "completed", position: 3 },
  ];
  const run = async (current: { name: string; type: string }, target: string) => {
    const updates: unknown[] = [];
    const service = new LinearService(new Credentials(join(tmpdir(), `paseo-linear-named-${process.pid}`), "env-key"), (_key, query, variables) => {
      if (query === UPDATE_ISSUE_STATE_QUERY) { updates.push(variables); return Promise.resolve({ issueUpdate: { success: true } }); }
      if (query === TEAM_STATES_QUERY) return Promise.resolve({ team: { states: { nodes: states } } });
      return Promise.resolve({ issue: { id: "i1", state: current, team: { id: "t1" }, labels: { nodes: [] }, attachments: { nodes: [] } } });
    });
    return { result: await service.moveToStateNamed("i1", target), updates };
  };
  assert.deepEqual(await run({ name: "In Progress", type: "started" }, "Planning"), { result: { changed: true }, updates: [{ id: "i1", stateId: "plan" }] });
  assert.deepEqual(await run({ name: "Planning", type: "started" }, "planning"), { result: { changed: false }, updates: [] });
  assert.deepEqual(await run({ name: "Done", type: "completed" }, "In Progress"), { result: { changed: false }, updates: [] });
  assert.match((await run({ name: "Todo", type: "unstarted" }, "Coding")).result.note ?? "", /no started state named "Coding"/);
});
