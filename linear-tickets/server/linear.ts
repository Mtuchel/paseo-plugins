import { MAX_ATTACHMENT_BYTES } from "./attachments";
import type { Issue, TicketDetail } from "../shared/contracts";
import { buildContext, normalizeIssue, issuePage, connection, record, stateHistorySpans, label, ticketRelations } from "./context";
import { Credentials } from "./credentials";

const endpoint = "https://api.linear.app/graphql";
export type Post = (key: string, query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;

// GraphQL error payloads carry a user-facing message, sometimes clearer than the HTTP status alone.
function apiMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { errors?: unknown }).errors)) return "";
  const messages = (payload as { errors: unknown[] }).errors
    .map((error) => {
      if (!error || typeof error !== "object") return "";
      const e = error as { message?: string; extensions?: { userPresentableMessage?: string } };
      return e.extensions?.userPresentableMessage ?? e.message ?? "";
    })
    .filter(Boolean).join("; ");
  return messages.length > 300 ? messages.slice(0, 300) + "…" : messages;
}

export const postGraphQL: Post = async (key, query, variables) => {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      // Linear rejects the Bearer prefix for API keys on the GraphQL API.
      headers: { authorization: key, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Could not reach the Linear API. Check the host's network connection and try again.");
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* Mapped by status below. */ }
  if (!response.ok) {
    const message = apiMessage(payload);
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Linear rejected this API key.${message ? ` ${message}` : ""} Check it in Linear settings and reconnect.`);
    }
    if (response.status === 429) throw new Error(`Linear is rate-limiting this host.${message ? ` ${message}` : ""} Try again in a moment.`);
    if (message) throw new Error(`The Linear API request failed: ${message}`);
    throw new Error(`The Linear API request failed (HTTP ${response.status}). Try again.`);
  }
  if (payload == null) throw new Error("Linear returned an invalid response.");
  const body = record(payload);
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const message = body.errors
      .map((error) => (error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : ""))
      .filter(Boolean).join("; ");
    throw new Error(`The Linear API request failed${message ? `: ${message}` : "."} Check your API key and ticket access, then retry.`);
  }
  return record(body.data);
};

export const VIEWER_QUERY = `query viewerCheck {
  viewer { id }
}`;

export const LIST_ISSUES_QUERY = `query listIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, includeArchived: false, orderBy: updatedAt, filter: $filter) {
    nodes {
      id
      identifier
      title
      description
      url
      state { name type }
      priorityLabel
      dueDate
      estimate
      project { name identifier url }
      team { name key }
      labels(first: 50) { nodes { id name } }
      relations(first: 50) { nodes { type issue { id } relatedIssue { id } } }
      inverseRelations(first: 50) { nodes { type issue { id } relatedIssue { id } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COUNT_ISSUES_QUERY = `query countIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, includeArchived: false, orderBy: updatedAt, filter: $filter) {
    nodes { state { name type } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Same field set as the list query so results normalize identically. Linear's search
// covers every team the key can see, not just the user's assignments.
export const SEARCH_ISSUES_QUERY = `query searchIssues($term: String!, $first: Int!, $after: String) {
  searchIssues(term: $term, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      url
      state { name type }
      priorityLabel
      dueDate
      estimate
      project { name identifier url }
      team { name key }
      labels(first: 50) { nodes { id name } }
      relations(first: 50) { nodes { type issue { id } relatedIssue { id } } }
      inverseRelations(first: 50) { nodes { type issue { id } relatedIssue { id } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// The list filter is built in TypeScript so it stays deterministic (deduped, sorted)
// across caching, tests and request logging. An explicit state-name selection always
// wins over the default scope: picking the Done chip means seeing Done tickets. When
// closed states are not shown, completed, canceled and duplicated work is hidden.
export function listIssueFilter(stateNames?: string[], showClosed?: boolean, relation?: "blocking" | "blocked"): Record<string, unknown> {
  const filter: Record<string, unknown> = { assignee: { isMe: { eq: true } } };
  const state: Record<string, unknown> = {};
  const names = [...new Set((stateNames ?? []).map((name) => name.trim()).filter(Boolean))].sort();
  if (names.length) state.name = { in: names };
  else if (showClosed !== true) state.type = { nin: ["completed", "canceled", "duplicate"] };
  if (Object.keys(state).length) filter.state = state;
  if (relation === "blocking") filter.hasBlockingRelations = { eq: true };
  if (relation === "blocked") filter.hasBlockedByRelations = { eq: true };
  return filter;
}

export const ISSUE_DETAIL_QUERY = `query issueDetail($id: String!) {
  viewer { id }
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    state { name type }
    branchName
    priorityLabel
    dueDate
    estimate
    project { id name identifier url }
    team { id name key }
    labels(first: 50) { nodes { id name } }
    createdAt
    updatedAt
    parent { id identifier title url state { name type } assignee { id name } }
    children(first: 50) { nodes { id identifier title url state { name type } assignee { id name } } }
    relations(first: 50) { nodes { type issue { id identifier title url state { name type } assignee { id name } } relatedIssue { id identifier title url state { name type } assignee { id name } } } }
    inverseRelations(first: 50) { nodes { type issue { id identifier title url state { name type } assignee { id name } } relatedIssue { id identifier title url state { name type } assignee { id name } } } }
    attachments(first: 50) { nodes { id title url } }
    documents(first: 50) { nodes { id title url } }
    stateHistory(first: 20) { nodes { state { name type } startedAt endedAt } }
  }
}`;

// A team's workflow states, used to resolve where "in progress" points at.
export type TeamState = { id: string; name: string; type: string; position: number };

export const TEAM_STATES_QUERY = `query teamStates($teamId: String!) {
  team(id: $teamId) { states(first: 50) { nodes { id name type position } } }
}`;

// Moves one ticket into another state of its team (In Progress at launch, review on a PR).
export const UPDATE_ISSUE_STATE_QUERY = `mutation issueUpdateState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { name type } } }
}`;

// Resolution order matters: a team can have several "started" states ("In Review" and
// "In Progress" in this workspace). Prefer an explicit choice, then a state named
// "in progress", then the lowest-position started state. Never pick any other type.
export function resolveStartedState(states: TeamState[], preferredId?: string): TeamState | null {
  if (preferredId) {
    const chosen = states.find((state) => state.id === preferredId);
    if (chosen) return chosen;
  }
  const started = states
    .filter((state) => state.type.trim().toLowerCase() === "started")
    .sort((a, b) => a.position - b.position);
  return started.find((state) => state.name.trim().toLowerCase() === "in progress") ?? started[0] ?? null;
}

// Where a linked pull request moves the ticket: a "started" state whose name mentions
// review. Teams without one are left alone rather than guessed at.
export function resolveReviewState(states: TeamState[]): TeamState | null {
  return states
    .filter((state) => state.type.trim().toLowerCase() === "started" && /review/i.test(state.name))
    .sort((a, b) => a.position - b.position)[0] ?? null;
}

// Auto-dispatch: open tickets carrying the trigger label in the allowed teams, whoever
// they are assigned to. Completed and canceled work never launches.
export const LABELED_ISSUES_QUERY = `query labeledIssues($first: Int!, $filter: IssueFilter) {
  issues(first: $first, includeArchived: false, orderBy: updatedAt, filter: $filter) {
    nodes { id identifier team { key } labels(first: 50) { nodes { id name } } }
  }
}`;

export function labeledIssueFilter(label: string, teamKeys: string[]): Record<string, unknown> {
  return {
    labels: { some: { name: { eqIgnoreCase: label } } },
    team: { key: { in: [...new Set(teamKeys)].sort() } },
    state: { type: { nin: ["completed", "canceled"] } },
  };
}

export type LabeledIssue = { id: string; identifier: string; teamKey: string; labels: { id: string; name: string }[] };

// The current state, team, labels and attachment links of one ticket: enough for
// write-back decisions without the comment pagination that `detail` performs.
export const ISSUE_STATE_QUERY = `query issueState($id: String!) {
  issue(id: $id) { id state { name type } team { id } labels(first: 50) { nodes { id name } } attachments(first: 50) { nodes { url } } }
}`;

export type IssueState = { id: string; status: string; statusType: string; teamId: string | null; labels: { id: string; name: string }[]; attachmentUrls: string[] };

export const LABEL_BY_NAME_QUERY = `query labelByName($name: String!) {
  issueLabels(first: 1, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name } }
}`;
export const CREATE_LABEL_QUERY = `mutation labelCreate($name: String!) {
  issueLabelCreate(input: { name: $name }) { success issueLabel { id name } }
}`;
export const ADD_LABEL_QUERY = `mutation addLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;
export const REMOVE_LABEL_QUERY = `mutation removeLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success }
}`;
export const CREATE_COMMENT_QUERY = `mutation comment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;
export const LINK_URL_QUERY = `mutation link($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
}`;
export const RELAY_COMMENTS_QUERY = `query relayComments($id: String!, $since: DateTimeOrDuration!, $after: String) {
  issue(id: $id) {
    comments(first: 50, after: $after, filter: { createdAt: { gt: $since } }) {
      nodes { id body createdAt user { id } reactions { emoji user { id } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
export const REACTION_QUERY = `mutation react($commentId: String!, $emoji: String!) {
  reactionCreate(input: { commentId: $commentId, emoji: $emoji }) { success }
}`;

export type RelayComment = { id: string; body: string; createdAt: string; userId: string; reactions: { emoji: string; userId: string }[] };

function labelNodes(value: unknown): { id: string; name: string }[] {
  return connection(value ?? { nodes: [] }).nodes.map((node) => record(node)).map((node) => ({ id: label(node.id), name: label(node.name) })).filter((node) => node.id && node.name);
}

function succeeded(data: Record<string, unknown>, field: string, what: string): void {
  const result = data[field] && typeof data[field] === "object" ? record(data[field]) : {};
  if (result.success !== true) throw new Error(`Linear did not ${what}.`);
}

export const COMMENT_QUERY = `query issueComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    comments(first: $first, after: $after) {
      nodes { id body createdAt url user { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export class LinearService {
  constructor(readonly credentials = new Credentials(), private readonly post: Post = postGraphQL) {}

  async status() {
    const { key, source } = await this.credentials.read();
    return { connected: Boolean(key), source };
  }

  async authenticate(key: string) {
    const data = await this.post(key, VIEWER_QUERY, {});
    const viewer = data.viewer;
    if (!viewer || typeof viewer !== "object" || typeof (viewer as { id?: unknown }).id !== "string") {
      throw new Error("Linear did not confirm this API key. Check it in Linear settings and reconnect.");
    }
    await this.credentials.save(key);
    return this.status();
  }

  async disconnect() {
    await this.credentials.remove();
    return this.status();
  }

  private async withKey<T>(work: (key: string) => Promise<T>): Promise<T> {
    const { key } = await this.credentials.read();
    if (!key) throw new Error("Connect Linear before loading tickets.");
    return work(key);
  }

  async issues(cursor?: string, stateNames?: string[], showClosed?: boolean, relation?: "blocking" | "blocked") {
    return this.withKey(async (key) =>
      issuePage(record(await this.post(key, LIST_ISSUES_QUERY, { first: 50, after: cursor ?? null, filter: listIssueFilter(stateNames, showClosed, relation) })).issues));
  }

  // Linear's GraphQL exposes no aggregation, so chip counts come from a bounded pass over
  // every assignment (25 pages x 50). `complete` is false when the cap was hit; the client
  // then shows counts as a lower bound instead of pretending they are exact.
  async countIssues(showClosed?: boolean): Promise<{ total: number; byName: Record<string, number>; byType: Record<string, number>; complete: boolean }> {
    return this.withKey(async (key) => {
      const byName: Record<string, number> = {};
      const byType: Record<string, number> = {};
      let total = 0;
      let after: string | null = null;
      let complete = false;
      for (let page = 0; page < 25; page++) {
        const data = record(await this.post(key, COUNT_ISSUES_QUERY, { first: 50, after, filter: listIssueFilter(undefined, showClosed) }));
        const pageData = record(data.issues);
        for (const node of Array.isArray(pageData.nodes) ? (pageData.nodes as unknown[]) : []) {
          if (!node || typeof node !== "object") continue;
          const state = (node as { state?: { name?: unknown; type?: unknown } }).state;
          const name = state && typeof state.name === "string" && state.name ? state.name : "No status";
          const type = state && typeof state.type === "string" && state.type ? state.type : "unknown";
          byName[name] = (byName[name] ?? 0) + 1;
          byType[type] = (byType[type] ?? 0) + 1;
          total++;
        }
        const info = pageData.pageInfo && typeof pageData.pageInfo === "object" ? pageData.pageInfo as { hasNextPage?: unknown; endCursor?: unknown } : {};
        after = info.hasNextPage === true && typeof info.endCursor === "string" && info.endCursor ? info.endCursor : null;
        if (!after) { complete = true; break; } // the loop exits at the cap with more pages still available
      }
      return { total, byName, byType, complete };
    });
  }

  async searchIssues(term: string, cursor?: string) {
    return this.withKey(async (key) =>
      issuePage(record(await this.post(key, SEARCH_ISSUES_QUERY, { term: term.trim(), first: 50, after: cursor ?? null })).searchIssues));
  }

  async detail(id: string): Promise<TicketDetail> {
    return this.withKey(async (key) => {
      const data = record(await this.post(key, ISSUE_DETAIL_QUERY, { id }));
      if (!data.issue || typeof data.issue !== "object") {
        throw new Error("Linear did not return this issue. Check that you have access to it.");
      }
      const issueData = record(data.issue);
      const issue = normalizeIssue(issueData);
      const viewerId = data.viewer && typeof data.viewer === "object" ? label((data.viewer as { id?: unknown }).id) : "";
      const teamId = label(record(issueData.team ?? {}).id) || null;
      const projectId = label(record(issueData.project ?? {}).id) || null;
      const warnings: string[] = [];
      let comments: unknown[] = [];
      try {
        let after: string | null = null;
        for (;;) {
          const page = connection(record(record(await this.post(key, COMMENT_QUERY, { id: issue.id, first: 50, after })).issue).comments);
          comments.push(...page.nodes);
          after = page.hasNextPage === true ? page.endCursor : null;
          if (!after) break;
        }
      } catch {
        comments = [];
        warnings.push("Comments could not be loaded; only the ticket details are included.");
      }
      return { issue, teamId, projectId, warnings, relations: ticketRelations(issueData, viewerId), context: buildContext(issueData, comments, stateHistorySpans(issueData)) };
    });
  }

  // The team's workflow states, cached for the plugin's lifetime; they rarely change.
  private readonly teamStatesCache = new Map<string, TeamState[]>();

  private async teamStates(teamId: string): Promise<TeamState[]> {
    const cached = this.teamStatesCache.get(teamId);
    if (cached) return cached;
    const data = record(await this.withKey((key) => this.post(key, TEAM_STATES_QUERY, { teamId })));
    const team = data.team && typeof data.team === "object" ? record(data.team) : {};
    const statesPage = team.states && typeof team.states === "object" ? record(team.states) : { nodes: [] };
    const states = connection(statesPage).nodes
      .map((node) => record(node))
      .map((node) => ({
        id: label(node.id),
        name: label(node.name),
        type: label(node.type),
        position: typeof node.position === "number" && Number.isFinite(node.position) ? node.position : Number.MAX_SAFE_INTEGER,
      }))
      .filter((state) => state.id && state.name);
    this.teamStatesCache.set(teamId, states);
    return states;
  }

  // Best-effort by design: callers surface `note` as a warning,
  // and a failure here must never turn into a launch failure.
  async markInProgress(issue: Pick<Issue, "id" | "status" | "statusType">, teamId: string | null): Promise<{ changed: boolean; note?: string }> {
    // Already in the team's "started" state (e.g. "In Progress"): leave it. A repeat
    // write would only add audit noise to a ticket the agent is about to work on.
    if (issue.statusType.trim().toLowerCase() === "started") return { changed: false };
    if (!teamId) return { changed: false, note: "The ticket has no team, so it could not be marked in progress." };
    let states: TeamState[];
    try {
      states = await this.teamStates(teamId);
    } catch (error) {
      return { changed: false, note: `Could not load the ticket team's states: ${error instanceof Error ? error.message : "unknown error"}` };
    }
    const target = resolveStartedState(states);
    if (!target) {
      return { changed: false, note: `The ticket's team has no \"In Progress\" state, so it was left in ${issue.status || "its current state"}.` };
    }
    let data: Record<string, unknown>;
    try {
      data = record(await this.withKey((key) => this.post(key, UPDATE_ISSUE_STATE_QUERY, { id: issue.id, stateId: target.id })));
    } catch (error) {
      return { changed: false, note: `Linear rejected the change to ${target.name}: ${error instanceof Error ? error.message : "unknown error"}` };
    }
    const result = data.issueUpdate && typeof data.issueUpdate === "object" ? record(data.issueUpdate) : {};
    if (result.success === false) {
      return { changed: false, note: `Linear reported that the change to ${target.name} was not applied; the ticket is unchanged.` };
    }
    return { changed: true };
  }

  async labeledIssues(labelName: string, teamKeys: string[]): Promise<LabeledIssue[]> {
    if (!teamKeys.length) return [];
    const data = record(await this.withKey((key) => this.post(key, LABELED_ISSUES_QUERY, { first: 50, filter: labeledIssueFilter(labelName, teamKeys) })));
    return connection(record(data.issues)).nodes.map((node) => record(node)).map((node) => ({
      id: label(node.id),
      identifier: label(node.identifier),
      teamKey: label(record(node.team ?? {}).key),
      labels: labelNodes(node.labels),
    })).filter((issue) => issue.id);
  }

  async issueState(id: string): Promise<IssueState> {
    const data = record(await this.withKey((key) => this.post(key, ISSUE_STATE_QUERY, { id })));
    if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return this issue. Check that you have access to it.");
    const issue = record(data.issue);
    const state = record(issue.state ?? {});
    const attachmentUrls = connection(issue.attachments ?? { nodes: [] }).nodes.map((node) => label(record(node).url)).filter(Boolean);
    return { id: label(issue.id), status: label(state.name), statusType: label(state.type), teamId: label(record(issue.team ?? {}).id) || null, labels: labelNodes(issue.labels), attachmentUrls };
  }

  // Label IDs by lowercase name, cached for the plugin's lifetime. A missing label is
  // created as a workspace label so every team can use it.
  private readonly labelIds = new Map<string, string>();

  private async labelId(name: string): Promise<string> {
    const wanted = name.trim().toLowerCase();
    const cached = this.labelIds.get(wanted);
    if (cached) return cached;
    const found = labelNodes(record(await this.withKey((key) => this.post(key, LABEL_BY_NAME_QUERY, { name }))).issueLabels)[0];
    let id = found?.id;
    if (!id) {
      const created = record(await this.withKey((key) => this.post(key, CREATE_LABEL_QUERY, { name })));
      succeeded(created, "issueLabelCreate", `create the "${name}" label`);
      id = label(record(record(created.issueLabelCreate).issueLabel ?? {}).id);
      if (!id) throw new Error(`Linear did not return the new "${name}" label.`);
    }
    this.labelIds.set(wanted, id);
    return id;
  }

  async addLabel(issueId: string, name: string): Promise<void> {
    const labelId = await this.labelId(name);
    succeeded(record(await this.withKey((key) => this.post(key, ADD_LABEL_QUERY, { id: issueId, labelId }))), "issueAddLabel", `add the "${name}" label`);
  }

  // Removes every label on the ticket with this name (case-insensitive); a team label and
  // a workspace label can share a name. Missing labels are not an error.
  async removeLabel(issueId: string, name: string, current?: { id: string; name: string }[]): Promise<void> {
    const labels = current ?? (await this.issueState(issueId)).labels;
    const wanted = name.trim().toLowerCase();
    for (const { id } of labels.filter((item) => item.name.trim().toLowerCase() === wanted)) {
      succeeded(record(await this.withKey((key) => this.post(key, REMOVE_LABEL_QUERY, { id: issueId, labelId: id }))), "issueRemoveLabel", `remove the "${name}" label`);
    }
  }

  async comment(issueId: string, body: string): Promise<void> {
    succeeded(record(await this.withKey((key) => this.post(key, CREATE_COMMENT_QUERY, { input: { issueId, body } }))), "commentCreate", "create the comment");
  }

  async linkUrl(issueId: string, url: string, title: string): Promise<void> {
    succeeded(record(await this.withKey((key) => this.post(key, LINK_URL_QUERY, { issueId, url, title }))), "attachmentLinkURL", "attach the link");
  }

  private viewer: string | null = null;

  // The API key's own user; cached because the key cannot change without a reconnect.
  async viewerId(): Promise<string> {
    if (this.viewer) return this.viewer;
    const id = label(record(record(await this.withKey((key) => this.post(key, VIEWER_QUERY, {}))).viewer ?? {}).id);
    if (!id) throw new Error("Linear did not return the connected user.");
    this.viewer = id;
    return id;
  }

  // Comments created after `since`, oldest first, with who wrote and reacted to them.
  async commentsSince(issueId: string, since: string): Promise<RelayComment[]> {
    const comments: RelayComment[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data = record(await this.withKey((key) => this.post(key, RELAY_COMMENTS_QUERY, { id: issueId, since, after })));
      const pageData = connection(record(data.issue ?? {}).comments ?? { nodes: [] });
      for (const node of pageData.nodes.map((item) => record(item))) {
        comments.push({
          id: label(node.id),
          body: label(node.body),
          createdAt: label(node.createdAt),
          userId: label(record(node.user ?? {}).id),
          reactions: (Array.isArray(node.reactions) ? node.reactions : []).map((item) => record(item)).map((reaction) => ({ emoji: label(reaction.emoji), userId: label(record(reaction.user ?? {}).id) })),
        });
      }
      after = pageData.hasNextPage ? pageData.endCursor : null;
      if (!after) break;
    }
    return comments.filter((item) => item.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async react(commentId: string, emoji: string): Promise<void> {
    succeeded(record(await this.withKey((key) => this.post(key, REACTION_QUERY, { commentId, emoji }))), "reactionCreate", "add the reaction");
  }

  // Linear's file storage needs the API key. Only uploads.linear.app is ever sent the key;
  // size is checked from the header and again while reading, so a huge file never buffers.
  async downloadUpload(url: string, maxBytes = MAX_ATTACHMENT_BYTES): Promise<Uint8Array> {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "uploads.linear.app") throw new Error("Only Linear uploads can be downloaded.");
    return this.withKey(async (key) => {
      let response: Response;
      try {
        response = await fetch(target, { headers: { authorization: key }, signal: AbortSignal.timeout(60_000) });
      } catch {
        throw new Error("Could not reach Linear's file storage.");
      }
      if (!response.ok) throw new Error(`Linear's file storage answered HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks);
    });
  }

  // Moves the ticket to its team's review state unless it is already there or past
  // started work (completed or canceled tickets are left to people and integrations).
  async moveToReview(issueId: string): Promise<{ changed: boolean; note?: string }> {
    const state = await this.issueState(issueId);
    const type = state.statusType.trim().toLowerCase();
    if (type === "completed" || type === "canceled") return { changed: false };
    if (/review/i.test(state.status) && type === "started") return { changed: false };
    if (!state.teamId) return { changed: false, note: "The ticket has no team." };
    const target = resolveReviewState(await this.teamStates(state.teamId));
    if (!target) return { changed: false, note: "The ticket's team has no review state." };
    succeeded(record(await this.withKey((key) => this.post(key, UPDATE_ISSUE_STATE_QUERY, { id: issueId, stateId: target.id }))), "issueUpdate", `move the ticket to ${target.name}`);
    return { changed: true };
  }
}
