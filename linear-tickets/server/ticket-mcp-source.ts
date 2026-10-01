// Stdio MCP server given to agents launched from a ticket. It is written to disk and run
// by `node`, so it is plain dependency-free ESM; it must not contain backticks or "${".
export const TICKET_MCP_SOURCE = String.raw`
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
function arg(name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
const issueId = arg("--issue");
const paseoHome = arg("--paseo-home");
if (!issueId || !/^[A-Za-z0-9-]{1,100}$/.test(issueId) || !paseoHome) {
  process.stderr.write("linear-ticket MCP: --issue <id> and --paseo-home <path> are required\n");
  process.exit(2);
}
const override = process.env.LINEAR_TICKET_MCP_ENDPOINT;
const endpoint = override && /^http:\/\/127\.0\.0\.1:\d+\//.test(override) ? override : "https://api.linear.app/graphql";
// Closing a ticket without its work needs a reason, posted on the ticket before the move.
const REASON_TYPES = ["canceled", "duplicate"];
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

function redact(text, key) { return key ? text.split(key).join("[redacted]") : text; }
function text(value, name, max) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new Error(name + " must be 1 to " + max + " characters.");
  return result;
}

async function apiKey() {
  const fromEnv = (process.env.LINEAR_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = JSON.parse(await readFile(join(paseoHome, "linear-tickets", "credentials.json"), "utf8"));
    if (typeof saved.apiKey === "string" && saved.apiKey.trim()) return saved.apiKey.trim();
  } catch {}
  throw new Error("Linear is not connected on this Paseo host. Ask the user to connect it in the Linear tickets plugin.");
}

async function linear(query, variables) {
  const key = await apiKey();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST", redirect: "error",
      headers: { authorization: key, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error("Could not reach the Linear API."); }
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (response.status === 401 || response.status === 403) throw new Error("Linear rejected the host's API key. Reconnect Linear in the Linear tickets plugin.");
  // Linear answers a spent hourly budget with HTTP 400 and the RATELIMITED code (429 from proxies).
  const rateLimited = response.status === 429 || (payload && Array.isArray(payload.errors) && payload.errors.some((e) => e && e.extensions && e.extensions.code === "RATELIMITED"));
  if (rateLimited) throw new Error("Linear's hourly request limit is reached for the Linear API key; try again in about 10 minutes.");
  const errors = payload && Array.isArray(payload.errors) ? redact(payload.errors.map((e) => (e && (e.extensions && e.extensions.userPresentableMessage || e.message)) || "").filter((m) => typeof m === "string" && m).join("; "), key).slice(0, 300) : "";
  if (!response.ok || errors) throw new Error("The Linear request failed" + (errors ? ": " + errors : " (HTTP " + response.status + ")."));
  return (payload && payload.data) || {};
}

const ISSUE = "query ticket($id: String!) { issue(id: $id) { id identifier title url description priorityLabel state { name type } assignee { name } team { id name states(first: 50) { nodes { id name type position } } } comments(first: 50) { nodes { body createdAt user { name } } } attachments(first: 20) { nodes { title url } } } }";

async function loadIssue() {
  const data = await linear(ISSUE, { id: issueId });
  if (!data.issue) throw new Error("Linear did not return this ticket. Check that the host's key can see it.");
  return data.issue;
}

function states(issue) {
  const nodes = (issue.team && issue.team.states && issue.team.states.nodes) || [];
  return nodes.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
}

// Manual tasks: steps only a person can do (env vars, secrets, settings). Each becomes a sub-issue
// assigned to the key's owner, plus a private file the plugin's watcher reads. The check command
// lives only in that file: the plugin never runs text taken from Linear.
const MANUAL_WHEN = ["before_merge", "after_merge", "anytime"];
const WHEN_TEXT = { before_merge: "due before the pull request is merged", after_merge: "due once the pull request is merged", anytime: "due now, independent of the merge" };
const MANUAL = "query manual($id: String!) { viewer { id } issue(id: $id) { id identifier team { id states(first: 50) { nodes { id name type position } } } children(first: 100) { nodes { id identifier url title state { type } } } } }";
const MANUAL_DIRECTORY = join(paseoHome, "linear-tickets", "manual-tasks");
const FINISHED_TYPES = ["completed", "canceled", "duplicate"];

async function recordManualTask(task) {
  await mkdir(MANUAL_DIRECTORY, { recursive: true, mode: 0o700 });
  const path = join(MANUAL_DIRECTORY, task.id + ".json");
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(task, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function recordedManualTasks() {
  const names = await readdir(MANUAL_DIRECTORY).catch(() => []);
  const tasks = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(MANUAL_DIRECTORY, name), "utf8").then(JSON.parse, () => null)));
  return tasks.filter((task) => task && typeof task.title === "string");
}

const tools = [
  {
    name: "get_ticket",
    description: "Read this agent's Linear ticket fresh from Linear: title, description, current status, the team's workflow states, recent comments and links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run() {
      const issue = await loadIssue();
      const comments = ((issue.comments && issue.comments.nodes) || []).slice(-20).map((c) => ({ author: c.user ? c.user.name : null, createdAt: c.createdAt, body: c.body }));
      return {
        identifier: issue.identifier, title: issue.title, url: issue.url, status: issue.state, priority: issue.priorityLabel,
        assignee: issue.assignee ? issue.assignee.name : null, team: issue.team ? issue.team.name : null,
        availableStatuses: states(issue).map((s) => ({ name: s.name, type: s.type })),
        description: issue.description, comments, links: (issue.attachments && issue.attachments.nodes) || [],
      };
    },
  },
  {
    name: "add_comment",
    description: "Post a Markdown comment on this agent's Linear ticket. Use it for a short start note, meaningful progress, blockers, and the final summary with the PR link.",
    inputSchema: { type: "object", properties: { body: { type: "string", minLength: 1, maxLength: 20000 } }, required: ["body"], additionalProperties: false },
    async run(input) {
      const body = text(input.body, "body", 20000);
      const data = await linear("mutation comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }", { input: { issueId, body } });
      const result = data.commentCreate || {};
      if (!result.success) throw new Error("Linear did not create the comment.");
      return { posted: true, url: result.comment ? result.comment.url : null };
    },
  },
  {
    name: "set_status",
    description: "Move this agent's Linear ticket to another workflow state of its team, by exact state name (see get_ticket availableStatuses). A canceled or duplicate state needs a reason, which is posted on the ticket first.",
    inputSchema: { type: "object", properties: { status: { type: "string", minLength: 1, maxLength: 200 }, reason: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["status"], additionalProperties: false },
    async run(input) {
      const wanted = text(input.status, "status", 200).toLowerCase();
      const issue = await loadIssue();
      const all = states(issue);
      const target = all.find((s) => s.name.trim().toLowerCase() === wanted);
      if (!target) throw new Error("Unknown status. Choose one of: " + all.map((s) => s.name).join(", "));
      if (issue.state && issue.state.name === target.name) return { changed: false, status: target.name };
      if (REASON_TYPES.includes(target.type)) {
        if (input.reason === undefined) throw new Error("Moving the ticket to " + target.name + " closes it without its work: give the reason.");
        const reason = text(input.reason, "reason", 2000);
        const posted = await linear("mutation comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId, body: "Moved to " + target.name + " by its agent: " + reason } });
        if (!posted.commentCreate || !posted.commentCreate.success) throw new Error("Linear did not post the reason; the status is unchanged.");
      }
      const data = await linear("mutation status($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { state { name } } } }", { id: issueId, stateId: target.id });
      if (!data.issueUpdate || !data.issueUpdate.success) throw new Error("Linear did not apply the status change.");
      return { changed: true, from: issue.state ? issue.state.name : null, status: target.name };
    },
  },
  {
    name: "link_url",
    description: "Attach an https link (for example the pull request) to this agent's Linear ticket.",
    inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2000 }, title: { type: "string", maxLength: 200 } }, required: ["url"], additionalProperties: false },
    async run(input) {
      let url;
      try { url = new URL(text(input.url, "url", 2000)); } catch { throw new Error("url must be an absolute https URL of at most 2000 characters."); }
      if (url.protocol !== "https:") throw new Error("url must be an absolute https URL.");
      const title = input.title === undefined ? undefined : text(input.title, "title", 200);
      const data = await linear("mutation link($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }", { issueId, url: url.href, title });
      if (!data.attachmentLinkURL || !data.attachmentLinkURL.success) throw new Error("Linear did not attach the link.");
      return { linked: true, url: url.href };
    },
  },
  {
    name: "add_manual_task",
    description: "Register a step a person must do outside the pull request (environment variables, secrets, Railway/Linear/GitHub/Paseo settings, webhooks, integrations). It becomes a sub-issue of this ticket assigned to the owner, who is notified. Never put secret values in it. Give a check command whenever one can prove the step is done: it runs when the owner marks the task done, and a failing check reopens it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200, description: "Short imperative, for example: Set LINEAR_API_KEY on batch-service (staging)" },
        steps: { type: "string", minLength: 1, maxLength: 10000, description: "Markdown: exact names, commands and UI paths; where to get each secret, never its value." },
        when: { type: "string", enum: MANUAL_WHEN, description: "before_merge blocks the merge; after_merge becomes due when the pull request is merged; anytime is due now without blocking." },
        check: { type: "string", minLength: 1, maxLength: 2000, description: "Optional shell command that exits 0 once the step is done. It must not print secret values." },
      },
      required: ["title", "steps", "when"],
      additionalProperties: false,
    },
    async run(input) {
      const title = text(input.title, "title", 200);
      const steps = text(input.steps, "steps", 10000);
      if (!MANUAL_WHEN.includes(input.when)) throw new Error("when must be one of: " + MANUAL_WHEN.join(", "));
      const check = input.check === undefined ? null : text(input.check, "check", 2000);
      const data = await linear(MANUAL, { id: issueId });
      const issue = data.issue;
      if (!issue || !issue.team) throw new Error("Linear did not return this ticket. Check that the host's key can see it.");
      const viewer = data.viewer && data.viewer.id;
      if (!viewer) throw new Error("Linear did not return the connected user.");
      const wanted = title.toLowerCase();
      const children = (issue.children && issue.children.nodes) || [];
      const finished = (child) => FINISHED_TYPES.includes(child.state && child.state.type);
      // Linear's children list can lag behind a task created a moment ago; the local record does not.
      const existing = children.find((child) => child.title.trim().toLowerCase() === wanted && !finished(child))
        || (await recordedManualTasks()).find((task) => task.parentId === issue.id && task.title.trim().toLowerCase() === wanted && !children.some((child) => child.id === task.id && finished(child)));
      if (existing) return { identifier: existing.identifier, url: existing.url, deduped: true };
      const all = states(issue);
      const unstarted = all.find((s) => s.type === "unstarted");
      const target = input.when === "after_merge" ? all.find((s) => s.type === "backlog") || unstarted : unstarted;
      const description = steps + "\n\n---\nManual task for " + issue.identifier + ", " + WHEN_TEXT[input.when] + "." + (check ? " Marking it done runs this check, and a failing check reopens it:\n\n    " + check.split("\n").join("\n    ") : "");
      const payload = { teamId: issue.team.id, title, description, parentId: issue.id, assigneeId: viewer };
      if (target) payload.stateId = target.id;
      const created = await linear("mutation manualTask($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }", { input: payload });
      const task = created.issueCreate && created.issueCreate.success && created.issueCreate.issue;
      if (!task) throw new Error("Linear did not create the task.");
      if (input.when === "before_merge") {
        const related = await linear("mutation manualBlocker($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }", { input: { issueId: task.id, relatedIssueId: issue.id, type: "blocks" } });
        if (!related.issueRelationCreate || !related.issueRelationCreate.success) throw new Error("Created " + task.identifier + " but Linear did not mark it as blocking this ticket.");
      }
      try {
        await recordManualTask({ id: task.id, identifier: task.identifier, url: task.url, title, parentId: issue.id, parentIdentifier: issue.identifier, when: input.when, check, cwd: process.cwd(), createdAt: new Date().toISOString(), announced: false, activated: input.when !== "after_merge", verifiedAt: null });
      } catch (error) {
        throw new Error("Created " + task.identifier + " but could not record it for the Paseo plugin: " + (error instanceof Error ? error.message : String(error)));
      }
      return { identifier: task.identifier, url: task.url, when: input.when, deduped: false };
    },
  },
];

function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  const { id, method, params } = message;
  const validId = id === undefined || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  if (message.jsonrpc !== "2.0" || typeof method !== "string" || !validId) {
    return send({ jsonrpc: "2.0", id: validId && id !== undefined ? id : null, error: { code: -32600, message: "Invalid Request" } });
  }
  // A message without an id is a notification: never run a tool for it.
  if (id === undefined) return;
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); };
  const fail = (code, text) => { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code, message: text } }); };
  if (method === "initialize") {
    return reply({
      protocolVersion: (params && params.protocolVersion) || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "linear-ticket", version: "1.0.0" },
      instructions: "Every tool acts only on the Linear ticket this agent was launched from.",
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: tools.map(({ run, ...tool }) => tool) });
  if (method === "tools/call") {
    const tool = tools.find((t) => t.name === (params && params.name));
    if (!tool) return fail(-32602, "Unknown tool");
    const args = params && params.arguments;
    if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) return fail(-32602, "arguments must be an object");
    if (inFlight >= MAX_IN_FLIGHT) return reply({ content: [{ type: "text", text: "Too many Linear calls at once; retry when the others finish." }], isError: true });
    inFlight++;
    try {
      const result = await tool.run((params && params.arguments) || {});
      return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (error) {
      return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : "The Linear request failed." }], isError: true });
    } finally { inFlight--; }
  }
  fail(-32601, "Method not found");
}

function receive(line) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  void handle(message).catch(() => send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
}

// Lines are capped before parsing; an oversized line is dropped up to its newline.
let buffer = "";
let discarding = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (discarding) { discarding = false; continue; }
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }); continue; }
    receive(line);
  }
  if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
    if (!discarding) send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
    discarding = true;
    buffer = "";
  }
});
process.stdin.on("end", () => { if (!discarding) receive(buffer); });
`;
