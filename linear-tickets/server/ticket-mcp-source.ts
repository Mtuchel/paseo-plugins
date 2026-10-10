// Stdio MCP server given to agents launched from a ticket. It is written to disk and run
// by `node`, so it is plain dependency-free ESM; it must not contain backticks or "${".
export const TICKET_MCP_SOURCE = String.raw`
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { request } from "node:http";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
function arg(name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
const paseoHome = arg("--paseo-home");
const readOnly = argv.includes("--read-only");
const issueArg = arg("--issue");
if (readOnly === argv.includes("--issue")) {
  process.stderr.write("linear-ticket MCP: pass exactly one of --issue <id> or --read-only, plus --paseo-home <path>\n");
  process.exit(2);
}
if (!paseoHome) {
  process.stderr.write("linear-ticket MCP: --paseo-home <path> is required\n");
  process.exit(2);
}
// Read-only (a project planner): no ticket, so only the two read tools are mounted, nothing is
// written and no directory is keyed by an issue id.
const issueId = readOnly ? null : issueArg;
if (!readOnly && (!issueId || !/^[A-Za-z0-9-]{1,100}$/.test(issueId))) {
  process.stderr.write("linear-ticket MCP: --issue <id> must be 1 to 100 characters of letters, digits or dashes\n");
  process.exit(2);
}
const socketPath = join(paseoHome, "linear-tickets", "linear-broker.sock");
const toolContext = new AsyncLocalStorage();
// Closing a ticket without its work needs a reason, posted on the ticket before the move.
const REASON_TYPES = ["canceled", "duplicate"];
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

function redact(text, secrets) { return secrets.reduce((result, secret) => secret ? result.split(secret).join("[redacted]") : result, text); }
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

// The Paseo app's access token, which the plugin keeps fresh in the daemon. Read on every call so a
// rotated token is picked up; never refreshed or written here (refresh tokens rotate, so only the
// daemon may use them). Null when the app is not installed or the token is about to expire.
async function appToken() {
  try {
    const saved = JSON.parse(await readFile(join(paseoHome, "linear-tickets", "agent-app", "token.json"), "utf8"));
    const fresh = typeof saved.expires_at !== "number" || saved.expires_at - 60000 > Date.now();
    if (typeof saved.access_token === "string" && saved.access_token && fresh) return saved.access_token;
  } catch {}
  return null;
}

async function post(authorization, query, variables) {
  const reply = await new Promise((resolve, reject) => {
    let connected = false;
    const client = request({ socketPath, path: "/graphql", method: "POST" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", () => reject(new Error("The Linear request may have completed; check the ticket before retrying a write.")));
      response.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("The Linear request may have completed; check the ticket before retrying a write.")); }
      });
    });
    client.on("socket", (socket) => {
      if (!socket.connecting) connected = true;
      socket.once("connect", () => { connected = true; });
    });
    client.on("error", () => reject(new Error(connected
      ? "The Linear request may have completed; check the ticket before retrying a write."
      : "The host's Linear budget service is unavailable; no request was sent. Retry after the plugin is running.")));
    client.setTimeout(35000, () => client.destroy());
    client.end(JSON.stringify({ authorization, query, variables, tool: toolContext.getStore() }));
  });
  if (reply.kind !== "answer") throw new Error(reply.message || "The host's Linear budget service is unavailable; no request was sent. Retry after the plugin is running.");
  const payload = reply.payload;
  const codes = payload && Array.isArray(payload.errors) ? payload.errors.map((e) => e && e.extensions && e.extensions.code) : [];
  return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, payload, codes };
}

// Linear did not accept the credential, so it ran nothing.
function unauthenticated(result) { return result.status === 401 || result.codes.includes("AUTHENTICATION_ERROR"); }

function answer(result, secrets, viaKey) {
  const { payload } = result;
  const who = viaKey ? "the Linear API key" : "the Paseo app";
  const errors = payload && Array.isArray(payload.errors) ? redact(payload.errors.map((e) => (e && (e.extensions && e.extensions.userPresentableMessage || e.message)) || "").filter((m) => typeof m === "string" && m).join("; "), secrets).slice(0, 300) : "";
  if (viaKey && (result.status === 401 || result.status === 403)) throw new Error("Linear rejected the host's API key. Reconnect Linear in the Linear tickets plugin.");
  // Linear answers a spent hourly budget with HTTP 400 and the RATELIMITED code (429 from proxies).
  if (result.status === 429 || result.codes.includes("RATELIMITED")) throw new Error("Linear's hourly request limit is reached for " + who + "; try again in about 10 minutes.");
  if (result.status === 403) throw new Error("Linear refused this request for " + who + (errors ? ": " + errors : "."));
  if (!result.ok || errors) throw new Error("The Linear request failed" + (errors ? ": " + errors : " (HTTP " + result.status + ")."));
  return (payload && payload.data) || {};
}

async function withKey(query, variables, secrets) {
  const key = await apiKey();
  return answer(await post(key, query, variables), [...secrets, key], true);
}

// Every request goes out as the Paseo app, so its writes show "Paseo" in Linear. The owner's key
// is used only when Linear authenticated nothing for the app: no usable token, or a rejected one
// that is still rejected (or unchanged) after reading token.json again. Any other failure (a
// refusal, rate limit, invalid input, outage) goes back to the agent and is never retried with the
// key, so nothing is written twice or under the owner's name by mistake.
async function linear(query, variables) {
  const secrets = [];
  let token = await appToken();
  if (token) {
    secrets.push(token);
    let result = await post("Bearer " + token, query, variables);
    if (unauthenticated(result)) {
      const reread = await appToken();
      result = reread && reread !== token ? await post("Bearer " + reread, query, variables) : null;
      if (reread) secrets.push(reread);
    }
    if (result && !unauthenticated(result)) return answer(result, secrets, false);
  }
  return withKey(query, variables, secrets);
}

// The issue a tool acts on: this agent's ticket, or another one by identifier (ENG-123) or ID.
const ISSUE = "query ticket($id: String!) { issue(id: $id) { id identifier title url description priorityLabel state { name type } assignee { name } project { id name } parent { identifier title } labels(first: 20) { nodes { name } } team { id key name states(first: 50) { nodes { id name type position } } } comments(first: 50) { nodes { body createdAt user { name } } } attachments(first: 20) { nodes { title url } } children(first: 50) { nodes { identifier title state { name } } } relations(first: 50) { nodes { type relatedIssue { identifier title } } } inverseRelations(first: 50) { nodes { type issue { identifier title } } } } }";
// One page of an issue's comments; get_ticket and get_issue only carry the recent ones.
const COMMENTS = "query comments($id: String!, $first: Int!, $after: String) { issue(id: $id) { identifier comments(first: $first, after: $after) { nodes { id body createdAt url user { name } } pageInfo { hasNextPage endCursor } } } }";

function reference(value) {
  if (value === undefined) return issueId;
  const ref = text(value, "issue", 100);
  if (!/^[A-Za-z0-9-]+$/.test(ref)) throw new Error("issue must be an identifier such as ENG-123.");
  return ref;
}

async function loadIssue(ref) {
  const data = await linear(ISSUE, { id: reference(ref) });
  if (!data.issue) throw new Error(ref === undefined ? "Linear did not return this ticket. Check that the host's Linear connection can see it." : "Linear did not return " + ref + ".");
  return data.issue;
}

function states(issue) {
  const nodes = (issue.team && issue.team.states && issue.team.states.nodes) || [];
  return nodes.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
}

// Manual tasks: steps only a person can do (env vars, secrets, settings). Each becomes a sub-issue
// assigned to the owner (the user of the host's key, read with that key, whoever writes), plus a
// private file the plugin's watcher reads. The check command lives only in that file: the plugin
// never runs text taken from Linear.
const MANUAL_WHEN = ["before_merge", "after_merge", "anytime"];
const WHEN_TEXT = { before_merge: "due before the pull request is merged", after_merge: "due once the pull request is merged", anytime: "due now, independent of the merge" };
const MANUAL = "query manual($id: String!) { issue(id: $id) { id identifier project { id } team { id states(first: 50) { nodes { id name type position } } } children(first: 100) { nodes { id identifier url title state { type } } } } }";
const MANUAL_DIRECTORY = join(paseoHome, "linear-tickets", "manual-tasks");
const FINISHED_TYPES = ["completed", "canceled", "duplicate"];

// Atomic, private (0600) JSON record: written to a temporary name, then renamed into place.
async function writePrivate(directory, name, data) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function recordedManualTasks() {
  const names = await readdir(MANUAL_DIRECTORY).catch(() => []);
  const tasks = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(MANUAL_DIRECTORY, name), "utf8").then(JSON.parse, () => null)));
  return tasks.filter((task) => task && typeof task.title === "string");
}

// Issues this agent created (create_issue), one private file each under the agent's ticket, so
// parallel calls cannot overwrite each other's record. Recorded issues count as the agent's own:
// it may edit them. The directory name is the launch's issue ID, checked above; null in read-only
// mode, where no ticket exists and it is neither created nor read.
const CREATED_DIRECTORY = issueId === null ? null : join(paseoHome, "linear-tickets", "agent-issues", issueId);
// Follow-ups land in Todo and may start agents of their own; the cap stops a runaway chain.
const MAX_CREATED = 10;

async function createdIssues() {
  if (CREATED_DIRECTORY === null) return [];
  const names = await readdir(CREATED_DIRECTORY).catch(() => []);
  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(CREATED_DIRECTORY, name), "utf8").then(JSON.parse, () => null)));
  return records.filter((record) => record && typeof record.id === "string" && typeof record.title === "string");
}

// Comments this agent posted (add_comment, set_status reasons), one private file each like the
// issues above (format: agent-records.ts). The plugin's comment relay never takes them for the
// owner's (the key writes them as the owner when the app cannot be used), and the owner's replies
// to one on another issue reach this agent. Null in read-only mode, where nothing posts.
const COMMENTS_DIRECTORY = issueId === null ? null : join(paseoHome, "linear-tickets", "agent-comments", issueId);

// Posts and records the comment; null when Linear did not create it. "recorded" false: posted, but
// the record failed.
async function postComment(target, body) {
  if (COMMENTS_DIRECTORY === null) throw new Error("This server is read-only and does not write to Linear.");
  const data = await linear("mutation comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url createdAt } } }", { input: { issueId: target.id, body } });
  const result = data.commentCreate || {};
  if (!result.success || !result.comment || typeof result.comment.id !== "string") return null;
  const comment = result.comment;
  try {
    await writePrivate(COMMENTS_DIRECTORY, comment.id + ".json", { id: comment.id, issueId: target.id, identifier: target.identifier || null, createdAt: comment.createdAt || new Date().toISOString() });
    return { url: comment.url || null, recorded: true };
  } catch {
    return { url: comment.url || null, recorded: false };
  }
}

// "own": the ticket the agent was launched from; "created": an issue it filed; "other": anything
// else; "read_only": no ticket and no writes, so every issue reads the same.
async function scopeOf(issue) {
  if (readOnly) return "read_only";
  if (issue.id === issueId || issue.identifier === issueId) return "own";
  return (await createdIssues()).some((record) => record.id === issue.id) ? "created" : "other";
}

const ALLOWED = {
  own: ["add_comment", "set_status", "link_url", "add_relation", "add_manual_task"],
  created: ["add_comment", "set_status", "link_url", "add_relation", "update_issue"],
  other: ["add_comment", "add_relation (from your ticket or an issue you created)"],
  read_only: [],
};

// The issue a write targets, when the agent may do that there.
async function writable(ref, action) {
  const issue = await loadIssue(ref);
  const scope = await scopeOf(issue);
  if (scope === "other") throw new Error(issue.identifier + " is neither this agent's ticket nor an issue it created, so " + action + " is not allowed there. On other issues you may only comment (add_comment) and add relations (add_relation); ask the owner for anything else.");
  return { issue, scope };
}

function relationsOf(issue) {
  const outgoing = { blocks: "blocks", related: "related to", duplicate: "duplicate of", similar: "similar to" };
  const incoming = { blocks: "blocked by", related: "related to", duplicate: "duplicated by", similar: "similar to" };
  const out = ((issue.relations && issue.relations.nodes) || []).filter((r) => r.relatedIssue).map((r) => ({ type: outgoing[r.type] || r.type, identifier: r.relatedIssue.identifier, title: r.relatedIssue.title }));
  const into = ((issue.inverseRelations && issue.inverseRelations.nodes) || []).filter((r) => r.issue).map((r) => ({ type: incoming[r.type] || r.type, identifier: r.issue.identifier, title: r.issue.title }));
  return out.concat(into);
}

async function relate(from, to, type) {
  const input = type === "blocked_by" ? { issueId: to.id, relatedIssueId: from.id, type: "blocks" }
    : { issueId: from.id, relatedIssueId: to.id, type: type === "duplicate_of" ? "duplicate" : type };
  const data = await linear("mutation relate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }", { input });
  if (!data.issueRelationCreate || !data.issueRelationCreate.success) throw new Error("Linear did not create the relation.");
}

const RELATION_TYPES = ["related", "blocks", "blocked_by", "duplicate_of"];
const ISSUE_PROPERTY = { type: "string", minLength: 1, maxLength: 100, description: "Identifier such as ENG-123. Omit for this agent's own ticket." };

const tools = [
  {
    name: "get_ticket",
    description: "Read this agent's Linear ticket fresh from Linear: title, description, current status, the team's workflow states, recent comments and links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run() {
      const issue = await loadIssue(undefined);
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
    name: "get_issue",
    description: "Read any Linear issue by identifier: title, description, status, project, labels, parent, sub-issues, relations, recent comments and links, plus what this agent may change on it.",
    inputSchema: { type: "object", properties: { issue: { ...ISSUE_PROPERTY, description: "Identifier such as ENG-123." } }, required: ["issue"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(input) {
      const issue = await loadIssue(text(input.issue, "issue", 100));
      const scope = await scopeOf(issue);
      const comments = ((issue.comments && issue.comments.nodes) || []).slice(-20).map((c) => ({ author: c.user ? c.user.name : null, createdAt: c.createdAt, body: c.body }));
      return {
        identifier: issue.identifier, title: issue.title, url: issue.url, status: issue.state, priority: issue.priorityLabel,
        assignee: issue.assignee ? issue.assignee.name : null, team: issue.team ? issue.team.name : null, project: issue.project ? issue.project.name : null,
        labels: ((issue.labels && issue.labels.nodes) || []).map((l) => l.name), parent: issue.parent || null,
        subIssues: ((issue.children && issue.children.nodes) || []).map((c) => ({ identifier: c.identifier, title: c.title, status: c.state ? c.state.name : null })),
        relations: relationsOf(issue), description: issue.description, comments, links: (issue.attachments && issue.attachments.nodes) || [],
        scope, youMay: ALLOWED[scope],
      };
    },
  },
  {
    name: "get_comments",
    description: "Read the full comment history of this agent's Linear ticket, or of another issue (issue), 50 comments per page, including comments the launch snapshot left out. Pass the returned nextCursor as cursor to read the next page.",
    inputSchema: { type: "object", properties: { issue: ISSUE_PROPERTY, cursor: { type: "string", minLength: 1, maxLength: 500, description: "nextCursor of the previous page; omit for the first page." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(input) {
      const after = input.cursor === undefined ? null : text(input.cursor, "cursor", 500);
      const data = await linear(COMMENTS, { id: reference(input.issue), first: 50, after });
      if (!data.issue) throw new Error(input.issue === undefined ? "Linear did not return this ticket. Check that the host's Linear connection can see it." : "Linear did not return " + input.issue + ".");
      const page = data.issue.comments || {};
      const info = page.pageInfo || {};
      return {
        issue: data.issue.identifier,
        comments: (page.nodes || []).map((c) => ({ id: c.id, author: c.user ? c.user.name : null, createdAt: c.createdAt, url: c.url, body: c.body })),
        nextCursor: info.hasNextPage === true && typeof info.endCursor === "string" && info.endCursor ? info.endCursor : null,
      };
    },
  },
  {
    name: "search_issues",
    description: "Search all Linear issues by text (title, description, comments). Returns identifier, title, status, team and project; read one with get_issue.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(input) {
      const term = text(input.query, "query", 200);
      const first = input.limit === undefined ? 20 : input.limit;
      if (!Number.isInteger(first) || first < 1 || first > 50) throw new Error("limit must be an integer from 1 to 50.");
      const data = await linear("query search($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) { nodes { identifier title url state { name type } team { key } project { name } } } }", { term, first });
      const nodes = (data.searchIssues && data.searchIssues.nodes) || [];
      return nodes.map((n) => ({ identifier: n.identifier, title: n.title, url: n.url, status: n.state ? n.state.name : null, team: n.team ? n.team.key : null, project: n.project ? n.project.name : null }));
    },
  },
  {
    name: "add_comment",
    description: "Post a Markdown comment on this agent's Linear ticket, or on any other issue (issue). Use it for a short start note, meaningful progress, blockers, and the final summary with the PR link.",
    inputSchema: { type: "object", properties: { body: { type: "string", minLength: 1, maxLength: 20000 }, issue: ISSUE_PROPERTY }, required: ["body"], additionalProperties: false },
    async run(input) {
      const body = text(input.body, "body", 20000);
      const target = input.issue === undefined ? { id: issueId, identifier: null } : await loadIssue(input.issue);
      const posted = await postComment(target, body);
      if (!posted) throw new Error("Linear did not create the comment.");
      return { posted: true, issue: target.identifier || undefined, url: posted.url, ...(posted.recorded ? {} : { warning: "Posted, but Paseo could not record it: the owner's replies to it will not reach you." }) };
    },
  },
  {
    name: "set_status",
    description: "Move this agent's Linear ticket, or an issue it created (issue), to another workflow state of its team, by exact state name (see get_ticket/get_issue). A canceled or duplicate state needs a reason, which is posted on the issue first.",
    inputSchema: { type: "object", properties: { status: { type: "string", minLength: 1, maxLength: 200 }, reason: { type: "string", minLength: 1, maxLength: 2000 }, issue: ISSUE_PROPERTY }, required: ["status"], additionalProperties: false },
    async run(input) {
      const wanted = text(input.status, "status", 200).toLowerCase();
      const { issue } = await writable(input.issue, "changing its status");
      const all = states(issue);
      const target = all.find((s) => s.name.trim().toLowerCase() === wanted);
      if (!target) throw new Error("Unknown status. Choose one of: " + all.map((s) => s.name).join(", "));
      if (issue.state && issue.state.name === target.name) return { changed: false, status: target.name };
      if (REASON_TYPES.includes(target.type)) {
        if (input.reason === undefined) throw new Error("Moving the issue to " + target.name + " closes it without its work: give the reason.");
        const reason = text(input.reason, "reason", 2000);
        const posted = await postComment(issue, "Moved to " + target.name + " by its agent: " + reason);
        if (!posted) throw new Error("Linear did not post the reason; the status is unchanged.");
      }
      const data = await linear("mutation status($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { state { name } } } }", { id: issue.id, stateId: target.id });
      if (!data.issueUpdate || !data.issueUpdate.success) throw new Error("Linear did not apply the status change.");
      return { changed: true, from: issue.state ? issue.state.name : null, status: target.name };
    },
  },
  {
    name: "link_url",
    description: "Attach an https link (for example the pull request) to this agent's Linear ticket, or to an issue it created (issue).",
    inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2000 }, title: { type: "string", maxLength: 200 }, issue: ISSUE_PROPERTY }, required: ["url"], additionalProperties: false },
    async run(input) {
      let url;
      try { url = new URL(text(input.url, "url", 2000)); } catch { throw new Error("url must be an absolute https URL of at most 2000 characters."); }
      if (url.protocol !== "https:") throw new Error("url must be an absolute https URL.");
      const title = input.title === undefined ? undefined : text(input.title, "title", 200);
      const target = input.issue === undefined ? { id: issueId } : (await writable(input.issue, "attaching a link")).issue;
      const data = await linear("mutation link($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }", { issueId: target.id, url: url.href, title });
      if (!data.attachmentLinkURL || !data.attachmentLinkURL.success) throw new Error("Linear did not attach the link.");
      return { linked: true, url: url.href };
    },
  },
  {
    name: "add_relation",
    description: "Relate this agent's ticket (or an issue it created, from) to any issue: related, blocks, blocked_by or duplicate_of, read as \"<from> blocks <issue>\".",
    inputSchema: {
      type: "object",
      properties: {
        issue: { ...ISSUE_PROPERTY, description: "The other issue, identifier such as ENG-123." },
        type: { type: "string", enum: RELATION_TYPES },
        from: { ...ISSUE_PROPERTY, description: "This agent's ticket (default) or an issue it created." },
      },
      required: ["issue", "type"],
      additionalProperties: false,
    },
    async run(input) {
      if (!RELATION_TYPES.includes(input.type)) throw new Error("type must be one of: " + RELATION_TYPES.join(", "));
      const { issue: from } = await writable(input.from, "adding relations from it");
      const to = await loadIssue(text(input.issue, "issue", 100));
      if (to.id === from.id) throw new Error("An issue cannot be related to itself.");
      await relate(from, to, input.type);
      return { related: true, from: from.identifier, type: input.type, issue: to.identifier };
    },
  },
  {
    name: "create_issue",
    description: "File a new issue as Paseo: a follow-up related to this agent's ticket (default) or a sub-issue of it. It is created in the team's Todo state and the ticket's project, so it can be picked up like any other ticket; check with search_issues that it does not exist yet. Not for steps only a person can do: use add_manual_task for those.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", minLength: 1, maxLength: 20000, description: "Markdown: the problem, evidence, goal and when it is done, readable without this conversation." },
        kind: { type: "string", enum: ["follow_up", "sub_issue"], description: "Default follow_up." },
        relation: { type: "string", enum: ["related", "blocks", "blocked_by"], description: "Follow-ups only, read as \"<new issue> blocks <this ticket>\". Default related." },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    async run(input) {
      const title = text(input.title, "title", 200);
      const body = text(input.description, "description", 20000);
      const kind = input.kind === undefined ? "follow_up" : input.kind;
      if (kind !== "follow_up" && kind !== "sub_issue") throw new Error("kind must be follow_up or sub_issue.");
      const relation = input.relation === undefined ? "related" : input.relation;
      if (!["related", "blocks", "blocked_by"].includes(relation)) throw new Error("relation must be related, blocks or blocked_by.");
      if (kind === "sub_issue" && input.relation !== undefined) throw new Error("relation applies to follow-ups only; a sub-issue is already linked as a child.");
      const origin = await loadIssue(undefined);
      if (!origin.team) throw new Error("Linear did not return this ticket's team.");
      const created = await createdIssues();
      // A retried call returns the issue it already made instead of filing a duplicate.
      const existing = created.find((record) => record.title.trim().toLowerCase() === title.toLowerCase());
      if (existing) return { identifier: existing.identifier, url: existing.url, deduped: true };
      if (created.length >= MAX_CREATED) throw new Error("This agent already filed " + MAX_CREATED + " issues for " + origin.identifier + ", the limit. Ask the owner before filing more.");
      const todo = states(origin).find((s) => s.type === "unstarted");
      const payload = { teamId: origin.team.id, title, description: body + "\n\n---\nFiled by the Paseo agent working on " + origin.identifier + "." };
      if (todo) payload.stateId = todo.id;
      if (origin.project) payload.projectId = origin.project.id;
      if (kind === "sub_issue") payload.parentId = origin.id;
      const data = await linear("mutation createIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }", { input: payload });
      const issue = data.issueCreate && data.issueCreate.success && data.issueCreate.issue;
      if (!issue) throw new Error("Linear did not create the issue.");
      try {
        await writePrivate(CREATED_DIRECTORY, issue.id + ".json", { id: issue.id, identifier: issue.identifier, url: issue.url, title, kind, origin: origin.identifier, createdAt: new Date().toISOString() });
      } catch (error) {
        throw new Error("Created " + issue.identifier + " but could not record it, so it cannot be edited through these tools: " + (error instanceof Error ? error.message : String(error)));
      }
      if (kind === "follow_up") {
        try { await relate(issue, origin, relation); } catch (error) {
          throw new Error("Created " + issue.identifier + " but could not relate it to " + origin.identifier + " (retry with add_relation): " + (error instanceof Error ? error.message : String(error)));
        }
      }
      return { identifier: issue.identifier, url: issue.url, kind, status: todo ? todo.name : null, deduped: false };
    },
  },
  {
    name: "update_issue",
    description: "Change the title or description of an issue this agent created with create_issue. Other issues, this agent's own ticket included, keep their text: comment instead.",
    inputSchema: {
      type: "object",
      properties: { issue: { ...ISSUE_PROPERTY, description: "Identifier of an issue this agent created." }, title: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", minLength: 1, maxLength: 20000 } },
      required: ["issue"],
      additionalProperties: false,
    },
    async run(input) {
      const changes = {};
      if (input.title !== undefined) changes.title = text(input.title, "title", 200);
      if (input.description !== undefined) changes.description = text(input.description, "description", 20000);
      if (!Object.keys(changes).length) throw new Error("Give a new title, description or both.");
      const { issue, scope } = await writable(text(input.issue, "issue", 100), "editing its text");
      if (scope !== "created") throw new Error(issue.identifier + " is this agent's own ticket; its title and description stay as the owner wrote them. Comment instead.");
      const data = await linear("mutation edit($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: issue.id, input: changes });
      if (!data.issueUpdate || !data.issueUpdate.success) throw new Error("Linear did not apply the change.");
      return { updated: true, issue: issue.identifier, fields: Object.keys(changes) };
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
      if (!issue || !issue.team) throw new Error("Linear did not return this ticket. Check that the host's Linear connection can see it.");
      const owner = await withKey("query owner { viewer { id } }", {}, []);
      const viewer = owner.viewer && owner.viewer.id;
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
      if (issue.project) payload.projectId = issue.project.id;
      const created = await linear("mutation manualTask($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }", { input: payload });
      const task = created.issueCreate && created.issueCreate.success && created.issueCreate.issue;
      if (!task) throw new Error("Linear did not create the task.");
      if (input.when === "before_merge") {
        const related = await linear("mutation manualBlocker($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }", { input: { issueId: task.id, relatedIssueId: issue.id, type: "blocks" } });
        if (!related.issueRelationCreate || !related.issueRelationCreate.success) throw new Error("Created " + task.identifier + " but Linear did not mark it as blocking this ticket.");
      }
      try {
        await writePrivate(MANUAL_DIRECTORY, task.id + ".json", { id: task.id, identifier: task.identifier, url: task.url, title, parentId: issue.id, parentIdentifier: issue.identifier, when: input.when, check, cwd: process.cwd(), createdAt: new Date().toISOString(), announced: false, activated: input.when !== "after_merge", verifiedAt: null });
      } catch (error) {
        throw new Error("Created " + task.identifier + " but could not record it for the Paseo plugin: " + (error instanceof Error ? error.message : String(error)));
      }
      return { identifier: task.identifier, url: task.url, when: input.when, deduped: false };
    },
  },
];

// Write tools are simply not mounted in read-only mode: tools/call for one answers "Unknown tool",
// the same as for a name that was never a tool.
const exposed = readOnly ? tools.filter((tool) => tool.name === "get_issue" || tool.name === "search_issues") : tools;

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
      instructions: readOnly
        ? "Reads cover any Linear issue: search with search_issues, then open one with get_issue. This server is read-only and writes nothing to Linear."
        : "Reads cover any Linear issue. Writes go out as Paseo: comments and relations on any issue; status and links on the ticket this agent was launched from and the issues it created; title and description only on the issues it created.",
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: exposed.map(({ run, ...tool }) => tool) });
  if (method === "tools/call") {
    const tool = exposed.find((t) => t.name === (params && params.name));
    if (!tool) return fail(-32602, "Unknown tool");
    const args = params && params.arguments;
    if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) return fail(-32602, "arguments must be an object");
    if (inFlight >= MAX_IN_FLIGHT) return reply({ content: [{ type: "text", text: "Too many Linear calls at once; retry when the others finish." }], isError: true });
    inFlight++;
    try {
      const result = await toolContext.run(tool.name, () => tool.run((params && params.arguments) || {}));
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
