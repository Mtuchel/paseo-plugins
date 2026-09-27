import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { record } from "./context";
import { postGraphQL, type Post } from "./linear";
import { paseoHome } from "./ticket-mcp";

// The "Paseo" Linear app (actor=app): its credentials and tokens live next to the plugin's
// other state, private to the daemon user. Everything the agent says in Linear is posted
// with this token, so it appears as "Paseo" rather than as the workspace owner.
export type AppCredentials = { applicationId?: string; clientId: string; clientSecret: string; webhookSecret: string };
type StoredToken = { access_token: string; refresh_token?: string; expires_in?: number; expires_at?: number };
export type SessionPlanStep = { content: string; status: "pending" | "inProgress" | "completed" | "canceled" };
export type ExternalUrl = { label: string; url: string };
export type SelectOption = { label: string; value: string };
export type AgentActivity = { id: string; createdAt: string; signal: string | null; type: string; body: string; userId: string | null };
export type OpenSession = { id: string; status: string; createdAt: string; creatorId: string | null; issueId: string | null; identifier: string | null };

export function agentAppDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "agent-app");
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export class AppAuth {
  private refreshing: Promise<string> | null = null;

  constructor(private readonly directory = agentAppDirectory(), private readonly fetchImpl: typeof fetch = fetch, private readonly now = () => Date.now()) {}

  async credentials(): Promise<AppCredentials | null> {
    try {
      const value = JSON.parse(await readFile(join(this.directory, "app.json"), "utf8"));
      return typeof value.clientId === "string" && typeof value.clientSecret === "string" && typeof value.webhookSecret === "string" ? value : null;
    } catch { return null; }
  }

  private async stored(): Promise<StoredToken | null> {
    try {
      const value = JSON.parse(await readFile(join(this.directory, "token.json"), "utf8"));
      return typeof value.access_token === "string" ? value : null;
    } catch { return null; }
  }

  // A usable access token, refreshed a minute before it expires. `force` refreshes after a 401.
  async accessToken(force = false): Promise<string> {
    const token = await this.stored();
    if (!token) throw new Error("The Paseo Linear app is not installed on this host.");
    const expiresAt = token.expires_at ?? 0;
    if (!force && (!expiresAt || expiresAt - 60_000 > this.now())) return token.access_token;
    this.refreshing ??= this.refresh(token).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(token: StoredToken): Promise<string> {
    const credentials = await this.credentials();
    if (!credentials || !token.refresh_token) throw new Error("The Paseo Linear app token expired and cannot be refreshed. Reinstall the app.");
    const response = await this.fetchImpl("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: credentials.clientId, client_secret: credentials.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Linear refused to refresh the Paseo app token (HTTP ${response.status}).`);
    const next = record(await response.json()) as StoredToken;
    if (typeof next.access_token !== "string") throw new Error("Linear returned no access token for the Paseo app.");
    const saved: StoredToken = { ...next, refresh_token: next.refresh_token ?? token.refresh_token, expires_at: this.now() + (next.expires_in ?? 86_400) * 1000 };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivate(join(this.directory, "token.json"), saved);
    return saved.access_token;
  }
}

const ACTIVITY_MUTATION = `mutation agentActivity($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success }
}`;
const SESSION_UPDATE_MUTATION = `mutation agentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`;
const SESSION_ON_ISSUE_MUTATION = `mutation agentSessionOnIssue($input: AgentSessionCreateOnIssue!) {
  agentSessionCreateOnIssue(input: $input) { success agentSession { id } }
}`;
const CREATE_COMMENT_MUTATION = `mutation appComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;
const UPDATE_COMMENT_MUTATION = `mutation appCommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success }
}`;
const APP_VIEWER_QUERY = `query appViewer { viewer { id name } }`;
const OPEN_SESSIONS_QUERY = `query openSessions($first: Int!) {
  agentSessions(first: $first, orderBy: updatedAt) { nodes { id status createdAt creator { id } issue { id identifier } } }
}`;
const SESSION_ACTIVITIES_QUERY = `query sessionActivities($id: String!) {
  agentSession(id: $id) { activities(first: 50) { nodes { id createdAt signal user { id } content {
    __typename
    ... on AgentActivityPromptContent { body }
    ... on AgentActivityResponseContent { body }
    ... on AgentActivityElicitationContent { body }
    ... on AgentActivityThoughtContent { body }
    ... on AgentActivityErrorContent { body }
  } } } }
}`;

// The agent-session half of Linear's API, authenticated as the app. A 401 refreshes the
// token once and retries; every other error surfaces to the caller.
export class AgentApi {
  constructor(private readonly auth: Pick<AppAuth, "accessToken">, private readonly post: Post = postGraphQL) {}

  private async call(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.auth.accessToken();
    try {
      return await this.post(`Bearer ${token}`, query, variables);
    } catch (error) {
      if (!(error instanceof Error) || !/rejected this API key/.test(error.message)) throw error;
      return this.post(`Bearer ${await this.auth.accessToken(true)}`, query, variables);
    }
  }

  async viewer(): Promise<{ id: string; name: string }> {
    const viewer = record(record(await this.call(APP_VIEWER_QUERY, {})).viewer ?? {});
    return { id: String(viewer.id ?? ""), name: String(viewer.name ?? "") };
  }

  // Activities are what the user sees in the agent panel. `ephemeral` ones (thoughts,
  // actions) are replaced by the next activity.
  async activity(sessionId: string, content: { type: string; body?: string; action?: string; parameter?: string; result?: string }, options: { signal?: string; options?: SelectOption[]; ephemeral?: boolean } = {}): Promise<void> {
    const input: Record<string, unknown> = { agentSessionId: sessionId, content };
    if (options.signal) input.signal = options.signal;
    if (options.options) input.signalMetadata = { options: options.options };
    if (options.ephemeral) input.ephemeral = true;
    const result = record(record(await this.call(ACTIVITY_MUTATION, { input })).agentActivityCreate ?? {});
    if (result.success !== true) throw new Error("Linear did not accept the agent activity.");
  }

  async updateSession(sessionId: string, input: { plan?: SessionPlanStep[]; addedExternalUrls?: ExternalUrl[]; externalUrls?: ExternalUrl[]; removedExternalUrls?: string[] }): Promise<void> {
    const result = record(record(await this.call(SESSION_UPDATE_MUTATION, { id: sessionId, input })).agentSessionUpdate ?? {});
    if (result.success !== true) throw new Error("Linear did not accept the agent session update.");
  }

  async createSessionOnIssue(issueId: string): Promise<string> {
    const result = record(record(await this.call(SESSION_ON_ISSUE_MUTATION, { input: { issueId } })).agentSessionCreateOnIssue ?? {});
    const id = String(record(result.agentSession ?? {}).id ?? "");
    if (result.success !== true || !id) throw new Error("Linear did not create an agent session on the ticket.");
    return id;
  }

  // A ticket comment written by "Paseo": unlike the owner's own key, it notifies the users it mentions.
  async createComment(issueId: string, body: string): Promise<string> {
    const result = record(record(await this.call(CREATE_COMMENT_MUTATION, { input: { issueId, body } })).commentCreate ?? {});
    const id = String(record(result.comment ?? {}).id ?? "");
    if (result.success !== true || !id) throw new Error("Linear did not create the comment.");
    return id;
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    const result = record(record(await this.call(UPDATE_COMMENT_MUTATION, { id: commentId, input: { body } })).commentUpdate ?? {});
    if (result.success !== true) throw new Error("Linear did not update the comment.");
  }

  async openSessions(first = 50): Promise<OpenSession[]> {
    const page = record(record(await this.call(OPEN_SESSIONS_QUERY, { first })).agentSessions ?? {});
    const nodes = Array.isArray(page.nodes) ? page.nodes : [];
    return nodes.map((node) => record(node)).map((node) => ({
      id: String(node.id ?? ""),
      status: String(node.status ?? ""),
      createdAt: String(node.createdAt ?? ""),
      creatorId: node.creator ? String(record(node.creator).id ?? "") || null : null,
      issueId: node.issue ? String(record(node.issue).id ?? "") || null : null,
      identifier: node.issue ? String(record(node.issue).identifier ?? "") || null : null,
    })).filter((session) => session.id);
  }

  async activities(sessionId: string): Promise<AgentActivity[]> {
    const session = record(record(await this.call(SESSION_ACTIVITIES_QUERY, { id: sessionId })).agentSession ?? {});
    const page = record(session.activities ?? {});
    const nodes = Array.isArray(page.nodes) ? page.nodes : [];
    return nodes.map((node) => record(node)).map((node) => {
      const content = record(node.content ?? {});
      return {
        id: String(node.id ?? ""),
        createdAt: String(node.createdAt ?? ""),
        signal: typeof node.signal === "string" ? node.signal : null,
        type: String(content.__typename ?? "").replace(/^AgentActivity|Content$/g, "").toLowerCase(),
        body: typeof content.body === "string" ? content.body : "",
        userId: node.user ? String(record(node.user).id ?? "") || null : null,
      };
    }).filter((activity) => activity.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
