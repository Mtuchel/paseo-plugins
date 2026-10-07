import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { record } from "./context";
import { AuthenticationError, entityNotFound, LinearApiError, postGraphQL, type Post } from "./linear";
import { paseoHome } from "./ticket-mcp";

// The "Paseo" Linear app (actor=app): its credentials and tokens live next to the plugin's
// other state, private to the daemon user. Everything the plugin and its agents write in Linear is
// sent with this token, so it appears as "Paseo" rather than as the workspace owner.
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

// Refreshes this long before the token expires, so the agents' `linear_ticket` servers, which read
// token.json but never refresh it (refresh tokens rotate; only the daemon may use them), find a
// valid token between two keep-fresh ticks.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const KEEP_FRESH_MS = 5 * 60 * 1000;

export class AppAuth {
  private refreshing: Promise<string> | null = null;
  private keeping: NodeJS.Timeout | null = null;

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

  // A usable access token, refreshed ten minutes before it expires. `force` refreshes after a 401.
  async accessToken(force = false): Promise<string> {
    const token = await this.stored();
    if (!token) throw new Error("The Paseo Linear app is not installed on this host.");
    const expiresAt = token.expires_at ?? 0;
    if (!force && (!expiresAt || expiresAt - REFRESH_MARGIN_MS > this.now())) return token.access_token;
    this.refreshing ??= this.refresh(token).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // Refreshes the token when due, now and every few minutes, until the returned stop is called.
  // One timer per instance: a second call keeps the running one.
  keepFresh(intervalMs = KEEP_FRESH_MS): () => void {
    if (!this.keeping) {
      const tick = () => {
        this.accessToken().catch((error: unknown) => console.error(`[linear-tickets] keeping the Paseo app token fresh failed: ${error instanceof Error ? error.message : error}`));
      };
      tick();
      this.keeping = setInterval(tick, intervalMs);
      this.keeping.unref();
    }
    return () => {
      clearInterval(this.keeping ?? undefined);
      this.keeping = null;
    };
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
// `agentActivity(id:)` is a lookup: an id Linear has no activity for comes back as an "Entity not
// found" error, which `activityById` maps to null.
const ACTIVITY_BY_ID_QUERY = `query agentActivityById($id: String!) {
  agentActivity(id: $id) { id }
}`;
const SESSION_UPDATE_MUTATION = `mutation agentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`;
const SESSION_ON_ISSUE_MUTATION = `mutation agentSessionOnIssue($input: AgentSessionCreateOnIssue!) {
  agentSessionCreateOnIssue(input: $input) { success agentSession { id } }
}`;
const APP_VIEWER_QUERY = `query appViewer { viewer { id name } }`;
// `agentSessions` lists every app's sessions in the workspace, not only this app's. Each host has
// its own app (README, "Several hosts"), so the viewer read alongside tells this host's apart.
const OPEN_SESSIONS_QUERY = `query openSessions($first: Int!) {
  viewer { id }
  agentSessions(first: $first, orderBy: updatedAt) { nodes { id status createdAt appUser { id } creator { id } issue { id identifier } } }
}`;
const SESSION_STATUS_QUERY = `query sessionStatus($id: String!) {
  agentSession(id: $id) { status }
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
      if (!(error instanceof AuthenticationError)) throw error;
      return this.post(`Bearer ${await this.auth.accessToken(true)}`, query, variables);
    }
  }

  // A request authenticated as the app, or null when Linear authenticated nothing: no token before
  // sending (not installed, refresh refused or failed), or a rejected token whose refresh then failed
  // or was rejected too. Nothing ran then, so LinearService may send it with the owner's key instead.
  // Every other failure propagates: the request may have run, and must not run again as the owner.
  async mutate(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    for (const force of [false, true]) {
      let token: string;
      try {
        token = await this.auth.accessToken(force);
      } catch {
        return null;
      }
      try {
        return await this.post(`Bearer ${token}`, query, variables);
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
      }
    }
    return null;
  }

  // Reads on the app's own request pool for LinearService: null as for `mutate`, and when Linear
  // refuses the app this read (HTTP 403), so the caller reads with the owner's key; rate limits and
  // every other failure propagate.
  async query(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.mutate(query, variables).catch((error: unknown) => {
      if (error instanceof LinearApiError && error.status === 403) return null;
      throw error;
    });
  }

  async viewer(): Promise<{ id: string; name: string }> {
    const viewer = record(record(await this.call(APP_VIEWER_QUERY, {})).viewer ?? {});
    return { id: String(viewer.id ?? ""), name: String(viewer.name ?? "") };
  }

  // Activities are what the user sees in the agent panel. `ephemeral` ones (thoughts,
  // actions) are replaced by the next activity. `id`: a client-chosen UUID, so an activity whose
  // answer was lost can be looked up (activityById) and only posted once under it.
  async activity(sessionId: string, content: { type: string; body?: string; action?: string; parameter?: string; result?: string }, options: { signal?: string; options?: SelectOption[]; ephemeral?: boolean; id?: string } = {}): Promise<void> {
    const input: Record<string, unknown> = { agentSessionId: sessionId, content };
    if (options.id) input.id = options.id;
    if (options.signal) input.signal = options.signal;
    if (options.options) input.signalMetadata = { options: options.options };
    if (options.ephemeral) input.ephemeral = true;
    const result = record(record(await this.call(ACTIVITY_MUTATION, { input })).agentActivityCreate ?? {});
    if (result.success !== true) throw new Error("Linear did not accept the agent activity.");
  }

  // One activity by its id; null when Linear has no activity with that id, so a caller that may
  // have posted it already retries under the same id instead of trusting its own record. Any other
  // failure (network, rate limit, auth) propagates.
  async activityById(id: string): Promise<{ id: string } | null> {
    try {
      const activity = record(record(await this.call(ACTIVITY_BY_ID_QUERY, { id })).agentActivity ?? {});
      const found = String(activity.id ?? "");
      return found ? { id: found } : null;
    } catch (error) {
      if (entityNotFound(error)) return null;
      throw error;
    }
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

  // This app's sessions among the workspace's `first` most recently updated: another host's
  // sessions are never adopted, linked or closed here.
  async openSessions(first = 50): Promise<OpenSession[]> {
    const data = record(await this.call(OPEN_SESSIONS_QUERY, { first }));
    const appId = String(record(data.viewer ?? {}).id ?? "");
    const page = record(data.agentSessions ?? {});
    const nodes = Array.isArray(page.nodes) ? page.nodes : [];
    return nodes.map((node) => record(node)).filter((node) => appId && String(record(node.appUser ?? {}).id ?? "") === appId).map((node) => ({
      id: String(node.id ?? ""),
      status: String(node.status ?? ""),
      createdAt: String(node.createdAt ?? ""),
      creatorId: node.creator ? String(record(node.creator).id ?? "") || null : null,
      issueId: node.issue ? String(record(node.issue).id ?? "") || null : null,
      identifier: node.issue ? String(record(node.issue).identifier ?? "") || null : null,
    })).filter((session) => session.id);
  }

  // One session's status ("pending", "active", "awaitingInput", "stale", "complete", "error"); null when Linear has no such session.
  async sessionStatus(sessionId: string): Promise<string | null> {
    const session = record(await this.call(SESSION_STATUS_QUERY, { id: sessionId })).agentSession;
    return session ? String(record(session).status ?? "") || null : null;
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
