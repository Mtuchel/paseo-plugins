import { MAX_ATTACHMENT_BYTES } from "./attachments";
import type { Issue, TicketDetail } from "../shared/contracts";
import { buildContext, normalizeIssue, issuePage, connection, record, stateHistorySpans, label, ticketRelations, type FinishedBlocker } from "./context";
import { Credentials } from "./credentials";
import type { LabelEvent, SweptIssue } from "./label-rules";
import { currentCaller, currentPriority, poolOf, rateBudget, RateLimitedError, withPriority, type RateBudget } from "./rate-budget";
import { operationName } from "./linear-usage";

const endpoint = "https://api.linear.app/graphql";
export type Post = (key: string, query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;
// The Paseo app's side of LinearService (AgentApi): reads on its request pool and writes authored as
// "Paseo". Both return null when the app cannot be used on this host (see AgentApi.query/mutate).
export type App = {
  query(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  mutate(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  viewer(): Promise<{ id: string; name: string }>;
};

// A Linear request that Linear answered with an error: its HTTP status (200 for GraphQL errors),
// the errors' codes and raw messages, and the top-level field each error names (its alias in a
// batched read), so callers decide on the failure, not on its wording.
export class LinearApiError extends Error {
  constructor(message: string, readonly status: number, readonly codes: string[] = [], readonly reasons: string[] = [], readonly fields: string[] = []) {
    super(message);
  }
}
// Linear did not accept the credential (HTTP 401 or AUTHENTICATION_ERROR), so it ran nothing.
export class AuthenticationError extends LinearApiError {}
// Linear answered a mutation with `success: false`: it ran, and refused the change.
export class LinearRefusedError extends Error {}

// Whether Linear itself refused the request, so sending it again changes nothing: a mutation it
// answered with `success: false` or an error answer below HTTP 500 (rate limits, a rejected key,
// server errors and an unreachable API pass and are worth retrying).
export function refusedByLinear(error: unknown): boolean {
  if (error instanceof LinearRefusedError) return true;
  return error instanceof LinearApiError && !(error instanceof AuthenticationError) && error.status !== 429 && error.status < 500;
}

// Linear answers a lookup of an id it has no entity for with an "Entity not found" error: a caller
// deciding whether to write (or whether its write landed) can tell "there is none" apart from a
// failure that may have run; network, rate-limit and auth failures all propagate.
export function entityNotFound(error: unknown): boolean {
  return error instanceof LinearApiError && error.reasons.some((reason) => /^Entity not found\b/.test(reason));
}

function errorDetails(payload: unknown): { codes: string[]; reasons: string[]; fields: string[] } {
  const codes: string[] = [];
  const reasons: string[] = [];
  const fields: string[] = [];
  const errors = payload && typeof payload === "object" && "errors" in payload && Array.isArray(payload.errors) ? payload.errors : [];
  for (const error of errors) {
    if (!error || typeof error !== "object") continue;
    if ("message" in error && typeof error.message === "string") reasons.push(error.message);
    if ("extensions" in error && error.extensions && typeof error.extensions === "object" && "code" in error.extensions && typeof error.extensions.code === "string") codes.push(error.extensions.code);
    if ("path" in error && Array.isArray(error.path) && typeof error.path[0] === "string") fields.push(error.path[0]);
  }
  return { codes, reasons, fields };
}

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

// Every request passes the pool's budget first (see rate-budget.ts); the response headers update it.
export async function postGraphQL(key: string, query: string, variables: Record<string, unknown>, budget: RateBudget = rateBudget): Promise<Record<string, unknown>> {
  const pool = poolOf(key);
  const operation = operationName(query);
  const ticket = budget.acquire(pool, undefined, currentCaller(operation), operation);
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
    ticket.done(null, false);
    throw new Error("Could not reach the Linear API. Check the host's network connection and try again.");
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* Mapped by status below. */ }
  // Linear answers an exhausted limit with HTTP 400 and the RATELIMITED code, not with 429.
  const limited = response.status === 429 || Boolean(payload && typeof payload === "object" && "errors" in payload && Array.isArray(payload.errors)
    && payload.errors.some((error: unknown) => Boolean(error && typeof error === "object" && "extensions" in error && error.extensions
      && typeof error.extensions === "object" && "code" in error.extensions && error.extensions.code === "RATELIMITED")));
  ticket.done(response.headers, limited);
  if (limited) throw new RateLimitedError(pool, budget.blockedUntil(pool));
  const { codes, reasons, fields } = errorDetails(payload);
  if (!response.ok) {
    const message = apiMessage(payload);
    if (response.status === 401 || response.status === 403 || codes.includes("AUTHENTICATION_ERROR")) {
      const text = `Linear rejected this API key.${message ? ` ${message}` : ""} Check it in Linear settings and reconnect.`;
      // A 403 refuses this request, not the credential: it is never a reason to refresh or switch.
      if (response.status === 403 && !codes.includes("AUTHENTICATION_ERROR")) throw new LinearApiError(text, 403, codes, reasons);
      throw new AuthenticationError(text, response.status, codes, reasons);
    }
    if (message) throw new LinearApiError(`The Linear API request failed: ${message}`, response.status, codes, reasons, fields);
    throw new LinearApiError(`The Linear API request failed (HTTP ${response.status}). Try again.`, response.status, codes, reasons, fields);
  }
  if (payload == null) throw new Error("Linear returned an invalid response.");
  const body = record(payload);
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    // Linear's `message` is often generic ("Unable to create issue attachment"); the reason is in
    // `userPresentableMessage` ("This URL has already been linked with TUC-96."), so both are kept.
    const message = body.errors
      .map((error) => {
        if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return "";
        const detail = "extensions" in error && error.extensions && typeof error.extensions === "object" && "userPresentableMessage" in error.extensions
          && typeof error.extensions.userPresentableMessage === "string" && error.extensions.userPresentableMessage !== error.message ? ` (${error.extensions.userPresentableMessage})` : "";
        return error.message + detail;
      })
      .filter(Boolean).join("; ");
    const text = `The Linear API request failed${message ? `: ${message}` : "."} Check your API key and ticket access, then retry.`;
    throw codes.includes("AUTHENTICATION_ERROR") ? new AuthenticationError(text, response.status, codes, reasons, fields) : new LinearApiError(text, response.status, codes, reasons, fields);
  }
  return record(body.data);
}

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
    nodes { id identifier priority team { key } labels(first: 50) { nodes { id name } } children(first: 1, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id } } }
  }
}`;

// Queue-blocker tickets (README, "Auto-dispatch"): tuchel-platform's tools/ci/queue-blocker-alert.mjs
// opens one per failing merge-queue check, as a sub-issue of TUC-538 titled "Queue blocker: <…>"
// with "Queue blocker id: <…>" as its description's first line. Either marker identifies one, so a
// re-titled or re-parented ticket is still found.
export const QUEUE_BLOCKER_TITLE_PREFIX = "Queue blocker:";
export const QUEUE_BLOCKER_DESCRIPTION_MARKER = "Queue blocker id:";
// The filter both queue-blocker reads share: the title the alert tool writes, or the description
// marker for one whose title changed. The marker must start the description: a ticket that only
// quotes it (an issue about the alert itself, e.g. TUC-1813) is not a blocker.
export function queueBlockerFilter(): Record<string, unknown> {
  return { or: [{ title: { startsWith: QUEUE_BLOCKER_TITLE_PREFIX } }, { description: { startsWith: QUEUE_BLOCKER_DESCRIPTION_MARKER } }] };
}

export function labeledIssueFilter(label: string, teamKeys: string[], options: { queueBlockers?: boolean } = {}): Record<string, unknown> {
  return {
    labels: { some: { name: { eqIgnoreCase: label } } },
    team: { key: { in: [...new Set(teamKeys)].sort() } },
    state: { type: { nin: ["completed", "canceled"] } },
    ...(options.queueBlockers ? queueBlockerFilter() : {}),
  };
}

// The labels of the tickets running agents work on, for mid-run plan requests (plan-requests.ts).
export const ISSUE_LABELS_QUERY = `query issueLabels($first: Int!, $ids: [ID!]) {
  issues(first: $first, includeArchived: true, filter: { id: { in: $ids } }) {
    nodes { id labels(first: 50) { nodes { id name } } }
  }
}`;
const ISSUE_LABELS_BATCH = 50;

// `priority`: Linear's 1 (urgent) … 4 (low); 0 means none and sorts last.
// `openChildren`: the ticket has at least one sub-issue that is not completed or canceled.
export type LabeledIssue = { id: string; identifier: string; teamKey: string; priority: number; labels: { id: string; name: string }[]; openChildren: boolean };

// The label repair (label-repair.ts): open tickets of the dispatch teams carrying a stale-able
// label, and the tickets of its open records whatever their labels or state, all pages.
export const REPAIR_CANDIDATES_QUERY = `query repairCandidates($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, includeArchived: false, filter: $filter) {
    nodes { id identifier title state { name type } project { id } labels(first: 50) { nodes { id name } } children(first: 1, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
// `queueBlocker`: the ticket is a queue blocker (README, "Auto-dispatch"): a read filtered to the
// markers marks every candidate, the unfiltered read recognizes the title prefix.
export type RepairCandidate = { id: string; identifier: string; status: string; statusType: string; projectId: string | null; labels: { id: string; name: string }[]; openChildren: boolean; queueBlocker: boolean };

// Two reads, merged by id: Linear's `or` around this multi-field filter matched every ticket of
// the team (1210 of TUC, 2026-10-07), so the record ids are read on their own. `queueBlockers`
// adds the marker filter, so only queue-blocker tickets are returned (the dispatch fallback's
// read while the background share is paused).
export function repairCandidateFilter(labels: string[], teamKeys: string[], options: { queueBlockers?: boolean } = {}): Record<string, unknown> {
  return {
    labels: { some: { or: labels.map((name) => ({ name: { eqIgnoreCase: name } })) } },
    team: { key: { in: [...new Set(teamKeys)].sort() } },
    state: { type: { nin: ["completed", "canceled"] } },
    ...(options.queueBlockers ? queueBlockerFilter() : {}),
  };
}
const REPAIR_IDS_BATCH = 50;

// The current state, team, labels and attachment links of one ticket: enough for
// write-back decisions without the comment pagination that `detail` performs.
export const ISSUE_STATE_QUERY = `query issueState($id: String!) {
  issue(id: $id) {
    id identifier priority createdAt state { id name type } team { id } project { id } creator { id } labels(first: 50) { nodes { id name } } attachments(first: 50) { nodes { url } }
    inverseRelations(first: 50) { nodes { type issue { identifier state { name type } attachments(first: 25) { nodes { url sourceType metadata } } } } }
    relations(first: 50) { nodes { type relatedIssue { state { type } } } }
  }
}`;
// Review inbox enrichment must not read blockers or PR attachments.
export const ISSUE_METADATA_QUERY = `query issueMetadata($id: String!) {
  issue(id: $id) { id identifier labels(first: 50) { nodes { id name } } }
}`;
// PR discovery needs URLs, not dependency relations or ticket metadata.
export const ISSUE_ATTACHMENT_URLS_QUERY = `query issueAttachmentUrls($id: String!) {
  issue(id: $id) { attachments(first: 50) { nodes { url } } }
}`;
// Watchdog exclusions need only workflow state and veto/owner/hold labels.
export const ISSUE_WATCH_STATE_QUERY = `query issueWatchState($id: String!) {
  issue(id: $id) { state { name type } labels(first: 50) { nodes { id name } } }
}`;
// Queued threads check terminal state before capacity; admission separately reads dependencies.
export const ISSUE_STATUS_QUERY = `query issueStatus($id: String!) {
  issue(id: $id) { state { name type } }
}`;
// `status`: the workflow state's name ("In Review"); `statusType` its kind ("started").
export type IssueStatus = { status: string; statusType: string; completedAt: string | null };
export const ISSUE_STATUSES_BATCH = 250;
export const ISSUE_STATUSES_QUERY = `query issueStatuses($ids: [ID!]!, $first: Int!) {
  issues(first: $first, filter: { id: { in: $ids } }) { nodes { id state { name type } completedAt } }
}`;
// Everything the queue's admission decides on (TicketStarter.admission), for up to 50 waiting
// tickets in one request: measured 2026-10-09 on 50 live tickets, 502 points against 498 for one
// `issueState` read (README, "Rate limits"). Parsed by the same function as `issueState`.
export const ADMISSION_STATES_BATCH = 50;
export const ADMISSION_STATES_QUERY = `query admissionStates($ids: [ID!]!, $first: Int!) {
  issues(first: $first, filter: { id: { in: $ids } }) { nodes {
    id identifier priority createdAt state { id name type } project { id } labels(first: 50) { nodes { id name } }
    inverseRelations(first: 50) { nodes { type issue { id identifier state { name type } attachments(first: 25) { nodes { url sourceType metadata } } } } }
    relations(first: 50) { nodes { type relatedIssue { state { type } } } }
  } }
}`;
// A state the plugin itself just moved a ticket into, from the mutation's own answer.
export type WrittenState = { name: string; type: string };

// A blocker in review (In Review, Ready to merge) whose pull requests are merged has its code in:
// the tickets waiting on it may start before someone marks it Done. Only pull requests Linear's
// GitHub integration tracks have a status; at least one must be merged and none open or draft.
export function inReviewState(name: string, type: string): boolean {
  return type === "started" && /review|merge/i.test(name);
}
function pullRequestsMerged(attachments: unknown): boolean {
  const statuses = connection(attachments ?? { nodes: [] }).nodes.map((node) => record(node))
    .filter((node) => label(node.sourceType) === "github" && /\/pull\/\d+/.test(label(node.url)) && node.metadata && typeof node.metadata === "object")
    .map((node) => label(record(node.metadata).status));
  return statuses.includes("merged") && !statuses.some((status) => status === "open" || status === "draft");
}

// Finished as a blocker counts it (README, "Waiting their turn"): Done, Canceled or a duplicate,
// or in review with its pull requests merged. `node`: an issue with `state` and `attachments`.
function finishedIssue(node: Record<string, unknown>): boolean {
  const state = record(node.state ?? {});
  if (["completed", "canceled", "duplicate"].includes(label(state.type))) return true;
  return inReviewState(label(state.name), label(state.type)) && pullRequestsMerged(node.attachments);
}

// A parent and its sub-issues, for handing the group to Paseo (groups.ts): each sub-issue's
// assignee, delegate (the Paseo app once handed out), labels and blockers.
export const ISSUE_GROUP_QUERY = `query issueGroup($id: String!) {
  issue(id: $id) {
    id identifier state { name type } delegate { id }
    children(first: 50) { nodes {
      id identifier state { name type } assignee { id } delegate { id } labels(first: 20) { nodes { name } }
      attachments(first: 10) { nodes { url sourceType metadata } }
      inverseRelations(first: 10) { nodes { type issue { id identifier state { name type } delegate { id } attachments(first: 10) { nodes { url sourceType metadata } } } } }
    } }
  }
}`;
export type GroupIssue = { id: string; identifier: string; status: string; statusType: string; delegateId: string | null; finished: boolean };
export type GroupChild = GroupIssue & { assigneeId: string | null; labels: string[]; blockers: GroupIssue[] };
export type IssueGroup = GroupIssue & { children: GroupChild[] };
function groupIssue(node: Record<string, unknown>): GroupIssue {
  const state = record(node.state ?? {});
  return { id: label(node.id), identifier: label(node.identifier), status: label(state.name), statusType: label(state.type), delegateId: label(record(node.delegate ?? {}).id) || null, finished: finishedIssue(node) };
}

// `blockedBy`: identifiers of unfinished tickets that block this one (merged reviews count as finished).
// `unblocks`: how many open tickets this one blocks. `priority`: Linear's 1 (urgent) … 4 (low), 0 none.
export type IssueState = {
  id: string; identifier: string; status: string; statusId: string; statusType: string; teamId: string | null; projectId: string | null; creatorId: string | null;
  labels: { id: string; name: string }[]; attachmentUrls: string[]; blockedBy: string[]; priority: number; createdAt: string; unblocks: number;
};
// The part of IssueState that ADMISSION_STATES_QUERY reads: what TicketStarter.admission decides on.
export type AdmissionState = Pick<IssueState, "id" | "identifier" | "status" | "statusType" | "projectId" | "labels" | "blockedBy" | "priority" | "createdAt" | "unblocks">;

// An ISSUE_STATUS_QUERY answer's workflow state, whichever pool sent it.
function issueStatusOf(data: Record<string, unknown>): Pick<IssueState, "status" | "statusType"> {
  if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return this issue. Check that you have access to it.");
  const state = record(record(data.issue).state ?? {});
  return { status: label(state.name), statusType: label(state.type) };
}

// One ticket node of ISSUE_STATE_QUERY or ADMISSION_STATES_QUERY; fields a query does not ask for
// come out empty. Both reads decide blockers and `unblocks` here, so the queue's batched read and a
// single read give the same admission.
function parseIssueState(issue: Record<string, unknown>): IssueState {
  const state = record(issue.state ?? {});
  const attachmentUrls = connection(issue.attachments ?? { nodes: [] }).nodes.map((node) => label(record(node).url)).filter(Boolean);
  const blockedBy = connection(issue.inverseRelations ?? { nodes: [] }).nodes.map((node) => record(node))
    .filter((relation) => label(relation.type) === "blocks")
    .map((relation) => record(relation.issue ?? {}))
    .filter((blocker) => !finishedIssue(blocker))
    .map((blocker) => label(blocker.identifier)).filter(Boolean);
  const unblocks = connection(issue.relations ?? { nodes: [] }).nodes.map((node) => record(node))
    .filter((relation) => label(relation.type) === "blocks" && !["completed", "canceled", "duplicate"].includes(label(record(record(relation.relatedIssue ?? {}).state ?? {}).type))).length;
  return {
    id: label(issue.id), identifier: label(issue.identifier), status: label(state.name), statusId: label(state.id), statusType: label(state.type),
    teamId: label(record(issue.team ?? {}).id) || null, projectId: label(record(issue.project ?? {}).id) || null, creatorId: label(record(issue.creator ?? {}).id) || null,
    labels: labelNodes(issue.labels), attachmentUrls, blockedBy,
    priority: typeof issue.priority === "number" ? issue.priority : 0, createdAt: label(issue.createdAt), unblocks,
  };
}
export type IssueMetadata = Pick<IssueState, "id" | "identifier" | "labels">;

// Projects carrying the trigger label (README, "Projects"), and their open tickets with what the
// project flow reads: state, team, parent, who has it, labels, blockers, what they block and links.
export const LABELED_PROJECTS_QUERY = `query labeledProjects($label: String!) {
  projects(first: 50, filter: { labels: { name: { eqIgnoreCase: $label } } }) { nodes { id name } }
}`;
// Relation types that link two tickets without ordering them (`ProjectIssue.linked`), by how they
// read from the ticket's side: as the relation's subject, and as its object.
const FORWARD_LINKS: Record<string, "related" | "duplicates"> = { related: "related", duplicate: "duplicates" };
const INVERSE_LINKS: Record<string, "related" | "duplicated by"> = { related: "related", duplicate: "duplicated by", duplicated: "duplicated by" };
const PROJECT_ISSUE_FIELDS = `id identifier title priority createdAt state { name type } team { id key } creator { id } assignee { id } delegate { id } labels(first: 20) { nodes { name } }
      parent { id state { type } project { id } }
      inverseRelations(first: 15) { nodes { type issue { id identifier state { name type } delegate { id } attachments(first: 10) { nodes { url sourceType metadata } } } } }
      relations(first: 15) { nodes { type relatedIssue { id identifier state { type } } } }`;
export const PROJECT_ISSUES_QUERY = `query projectIssues($id: String!, $after: String) {
  project(id: $id) { issues(first: 25, after: $after, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
    nodes {
      ${PROJECT_ISSUE_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  } }
}`;
// The tickets changed since `$since` (ProjectIssueCache, README "Projects"): the project's, and the
// ones known as its so far (`$ids`), in any state and archived ones too, so a ticket that was
// closed, archived or moved to another project is seen leaving.
export const PROJECT_ISSUES_CHANGED_QUERY = `query projectIssuesChanged($id: ID!, $ids: [ID!], $since: DateTimeOrDuration!, $after: String) {
  issues(first: 25, after: $after, includeArchived: true, filter: { updatedAt: { gte: $since }, or: [{ project: { id: { eq: $id } } }, { id: { in: $ids } }] }) {
    nodes {
      ${PROJECT_ISSUE_FIELDS}
      archivedAt project { id }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
// Blockers as `ProjectIssue.blockers` reads them, by id: whether each is finished yet.
export const BLOCKER_STATES_QUERY = `query blockerStates($first: Int!, $ids: [ID!]) {
  issues(first: $first, includeArchived: true, filter: { id: { in: $ids } }) {
    nodes { id identifier state { name type } delegate { id } attachments(first: 10) { nodes { url sourceType metadata } } }
  }
}`;
const BLOCKER_STATES_BATCH = 50;
export const ISSUE_DESCRIPTIONS_QUERY = `query issueDescriptions($ids: [ID!]!) {
  issues(first: 50, filter: { id: { in: $ids } }) { nodes { id description } }
}`;
// The planner's view beyond its project (README, "Projects"): every open ticket of the teams,
// most recently updated first.
export const TEAM_OPEN_ISSUES_QUERY = `query teamOpenIssues($teams: [ID!]!, $after: String) {
  issues(first: 100, after: $after, orderBy: updatedAt, filter: { team: { id: { in: $teams } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
    nodes { id identifier title state { name } project { id name } }
    pageInfo { hasNextPage endCursor }
  }
}`;
// A ticket by its identifier, in any state; an empty list when no such ticket exists.
export const ISSUE_BY_NUMBER_QUERY = `query issueByNumber($team: String!, $number: Float!) {
  issues(first: 1, includeArchived: true, filter: { team: { key: { eqIgnoreCase: $team } }, number: { eq: $number } }) { nodes { id identifier title } }
}`;
// The workspace's URL key, for web links to tickets (https://linear.app/<urlKey>/issue/TUC-1).
export const ORGANIZATION_QUERY = `query organizationUrlKey {
  organization { urlKey }
}`;
export type LabeledProject = { id: string; name: string };
export type TicketRef = { id: string; identifier: string; title: string };
export type TeamIssue = TicketRef & { status: string; projectId: string | null; projectName: string };
// `parentId`: the ticket's parent when it is open and in the same project (the parent's group hands it out).
// `blocks`: ids of open tickets this one blocks. `linked`: tickets it is related to, a duplicate of
// ("duplicates") or duplicated by.
export type ProjectLink = { id: string; identifier: string; kind: "related" | "duplicates" | "duplicated by" };
export type ProjectIssue = {
  id: string; identifier: string; title: string; priority: number; createdAt: string; status: string; statusType: string;
  teamId: string; teamKey: string; creatorId: string | null; assigneeId: string | null; delegateId: string | null; labels: string[];
  parentId: string | null; blockers: GroupIssue[]; blocks: string[]; linked: ProjectLink[];
};
// What changed in a project since a time (`projectIssuesChanged`): `open`, its open tickets that
// changed; `closed`, tickets that were its own and are finished or archived now; `moved`, open
// tickets that are in another project now (or in none).
export type ProjectChanges = { open: ProjectIssue[]; closed: string[]; moved: string[] };
const FINISHED_TYPES = ["completed", "canceled", "duplicate"];
function projectIssue(node: Record<string, unknown>, projectId: string): ProjectIssue {
  const team = record(node.team ?? {});
  const parent = record(node.parent ?? {});
  return {
    id: label(node.id), identifier: label(node.identifier), title: label(node.title),
    priority: typeof node.priority === "number" ? node.priority : 0, createdAt: label(node.createdAt),
    status: label(record(node.state ?? {}).name), statusType: label(record(node.state ?? {}).type),
    teamId: label(team.id), teamKey: label(team.key), creatorId: label(record(node.creator ?? {}).id) || null,
    assigneeId: label(record(node.assignee ?? {}).id) || null, delegateId: label(record(node.delegate ?? {}).id) || null,
    labels: connection(node.labels ?? { nodes: [] }).nodes.map((item) => label(record(item).name)).filter(Boolean),
    parentId: label(parent.id) && label(record(parent.project ?? {}).id) === projectId && !FINISHED_TYPES.includes(label(record(parent.state ?? {}).type)) ? label(parent.id) : null,
    blockers: connection(node.inverseRelations ?? { nodes: [] }).nodes.map((item) => record(item))
      .filter((relation) => label(relation.type) === "blocks").map((relation) => groupIssue(record(relation.issue ?? {}))).filter((blocker) => blocker.id),
    blocks: connection(node.relations ?? { nodes: [] }).nodes.map((item) => record(item))
      .filter((relation) => label(relation.type) === "blocks").map((relation) => record(relation.relatedIssue ?? {}))
      .filter((related) => !FINISHED_TYPES.includes(label(record(related.state ?? {}).type))).map((related) => label(related.id)).filter(Boolean),
    linked: [
      ...connection(node.relations ?? { nodes: [] }).nodes.map((item) => record(item))
        .filter((relation) => Object.hasOwn(FORWARD_LINKS, label(relation.type)))
        .map((relation) => ({ other: record(relation.relatedIssue ?? {}), kind: FORWARD_LINKS[label(relation.type)] })),
      ...connection(node.inverseRelations ?? { nodes: [] }).nodes.map((item) => record(item))
        .filter((relation) => Object.hasOwn(INVERSE_LINKS, label(relation.type)))
        .map((relation) => ({ other: record(relation.issue ?? {}), kind: INVERSE_LINKS[label(relation.type)] })),
    ].map(({ other, kind }) => ({ id: label(other.id), identifier: label(other.identifier), kind })).filter((other) => other.id),
  };
}
export const CREATE_ISSUE_QUERY = `mutation issueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;
// The project update a run's outcome is posted as (README, "Projects"): one per run, written as
// the Paseo app, so the project's overview shows how its tickets came to be ordered.
export const PROJECT_UPDATE_QUERY = `mutation projectUpdate($input: ProjectUpdateCreateInput!) {
  projectUpdateCreate(input: $input) { success projectUpdate { id url } }
}`;
export const DELEGATE_QUERY = `mutation delegate($id: String!, $delegateId: String!) {
  issueUpdate(id: $id, input: { delegateId: $delegateId }) { success }
}`;
export const RELATION_QUERY = `mutation relation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;
export const TEAM_BY_KEY_QUERY = `query teamByKey($key: String!) {
  teams(first: 1, filter: { key: { eq: $key } }) { nodes { id } }
}`;

export const LABEL_BY_NAME_QUERY = `query labelByName($name: String!) {
  issueLabels(first: 1, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name } }
}`;
export const CREATE_LABEL_QUERY = `mutation labelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name } }
}`;
// Label rules (label-sync.ts): the workspace's labels with their groups, a page of the teams'
// issues with what the rules read, an issue's label history, and the label writes.
export const LABEL_CATALOG_QUERY = `query labelCatalog($after: String) {
  issueLabels(first: 250, after: $after, includeArchived: false) { nodes { id name isGroup parent { id } team { id } } pageInfo { hasNextPage endCursor } }
}`;
export const LABEL_SWEEP_QUERY = `query labelSweep($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, includeArchived: false, orderBy: updatedAt, filter: $filter) {
    nodes { id identifier title description createdAt updatedAt project { name } parent { id labels(first: 25) { nodes { id } } } labels(first: 25) { nodes { id } } attachments(first: 25) { nodes { url } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const LABEL_HISTORY_QUERY = `query labelHistory($id: String!, $after: String) {
  issue(id: $id) { history(first: 100, after: $after) { nodes { createdAt actorId addedLabelIds removedLabelIds } pageInfo { hasNextPage endCursor } } }
}`;
export const UPDATE_LABEL_QUERY = `mutation labelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
  issueLabelUpdate(id: $id, input: $input) { success }
}`;
export const CHANGE_LABELS_QUERY = `mutation changeLabels($id: String!, $added: [String!], $removed: [String!]) {
  issueUpdate(id: $id, input: { addedLabelIds: $added, removedLabelIds: $removed }) { success }
}`;
// `teamId` null: a workspace label.
export type CatalogLabel = { id: string; name: string; isGroup: boolean; parentId: string | null; teamId: string | null };
export const LABEL_SWEEP_PAGE = 50;
const HISTORY_PAGES = 5;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
// A user's profile URL (https://linear.app/<workspace>/profiles/<name>): in a comment, Linear
// renders it as an @mention and notifies that user.
export const USER_URL_QUERY = `query userUrl($id: String!) {
  user(id: $id) { url }
}`;
// Whether a user is an app or integration rather than a person.
export const USER_KIND_QUERY = `query userKind($id: String!) {
  user(id: $id) { app }
}`;
export const ADD_LABEL_QUERY = `mutation addLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;
export const REMOVE_LABEL_QUERY = `mutation removeLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success }
}`;
export const CREATE_COMMENT_QUERY = `mutation comment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;
// `comment(id:)` is a lookup, not the issue's comment list: an id Linear has no comment for comes
// back as an "Entity not found" error, which `commentById` and `commentBody` map to null.
export const COMMENT_BY_ID_QUERY = `query commentById($id: String!) {
  comment(id: $id) { id body }
}`;
export const UPDATE_COMMENT_QUERY = `mutation commentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success }
}`;
// Whether a ticket has a comment containing a text (a marker a retried comment is looked up by).
// Linear's filter only narrows the search; each body is checked for the exact text (see hasComment).
export const MARKED_COMMENT_QUERY = `query markedComment($id: String!, $text: String!) {
  issue(id: $id) { comments(first: 50, filter: { body: { contains: $text } }) { nodes { id body } } }
}`;
// One attachment per ticket links to the Paseo agent working on it; Linear updates an
// attachment in place when the issue and URL match.
export const UPSERT_ATTACHMENT_QUERY = `mutation upsertAttachment($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`;
export const ISSUE_ATTACHMENTS_QUERY = `query issueAttachments($id: String!) {
  issue(id: $id) { attachments(first: 100) { nodes { id url } } }
}`;
export const DELETE_ATTACHMENT_QUERY = `mutation deleteAttachment($id: String!) {
  attachmentDelete(id: $id) { success }
}`;
// Linear's public schema: issueDelete(id: String!) deletes (trashes), unlike issueArchive.
export const DELETE_ISSUE_QUERY = `mutation deleteIssue($id: String!) {
  issueDelete(id: $id) { success }
}`;
export const LINK_URL_QUERY = `mutation link($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
}`;
// The relay's read: the owner's comments on up to RELAY_BATCH issues in one request, each issue
// from its own cursor (`$sN`, inclusive) and page (`$aN`). `plain`: all of them; otherwise only
// "@paseo" comments and thread replies. `issues(filter: id eq)` rather than `issue(id:)`: an issue
// the token cannot see comes back empty instead of failing the query.
export const RELAY_BATCH = 50;
export function relayCommentsQuery(count: number, plain = false): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const declarations = indexes.map((index) => `$i${index}: ID!, $s${index}: DateTimeOrDuration!, $a${index}: String`).join(", ");
  const addressed = plain ? "" : `, or: [{ body: { containsIgnoreCase: "@paseo" } }, { parent: { null: false } }]`;
  const fields = indexes.map((index) => `t${index}: issues(first: 1, filter: { id: { eq: $i${index} } }) {
    nodes { id comments(first: 50, after: $a${index}, filter: { createdAt: { gte: $s${index} }, user: { id: { eq: $u } }${addressed} }) {
      nodes { id body createdAt user { id } reactions { emoji user { id } } agentSession { id } parent { id user { id } agentSession { id } } }
      pageInfo { hasNextPage endCursor }
    } }
  }`).join("\n  ");
  return `query relayComments($u: ID!, ${declarations}) {\n  ${fields}\n}`;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_UNUSABLE = Symbol("app unusable");
export const REACTION_QUERY = `mutation react($commentId: String!, $emoji: String!) {
  reactionCreate(input: { commentId: $commentId, emoji: $emoji }) { success }
}`;

// `sessionId`: the Paseo agent session the comment opened or replied in (an @mention of the app);
// those reach the agent through the session webhook, not the relay. `parent`: the thread's first
// comment when this one is a reply (its `sessionId` set when the thread is an agent session's).
export type RelayComment = { id: string; body: string; createdAt: string; userId: string; reactions: { emoji: string; userId: string }[]; sessionId: string | null; parent: { id: string; userId: string; sessionId: string | null } | null };

export const ISSUE_DOCUMENTS_QUERY = `query issueDocuments($id: String!) {
  issue(id: $id) { id documents(first: 50) { nodes { id title url content } } }
}`;
export const CREATE_DOCUMENT_QUERY = `mutation documentCreate($input: DocumentCreateInput!) {
  documentCreate(input: $input) { success document { id url } }
}`;
export const UPDATE_DOCUMENT_QUERY = `mutation documentUpdate($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) { success document { id url } }
}`;

function labelNodes(value: unknown): { id: string; name: string }[] {
  return connection(value ?? { nodes: [] }).nodes.map((node) => record(node)).map((node) => ({ id: label(node.id), name: label(node.name) })).filter((node) => node.id && node.name);
}

function succeeded(data: Record<string, unknown>, field: string, what: string): void {
  const result = data[field] && typeof data[field] === "object" ? record(data[field]) : {};
  if (result.success !== true) throw new LinearRefusedError(`Linear did not ${what}.`);
}

// `id`: a client-chosen UUID, so a create whose answer was lost can be looked up and retried
// under the same id without filing a second ticket (see greptile-outage.ts).
type CreateIssueInput = { id?: string; teamId: string; title: string; description: string; parentId?: string; projectId?: string | null; assigneeId?: string; priority?: number; ready?: boolean; startedState?: string };

function createdIssue(data: Record<string, unknown>): { id: string; identifier: string; url: string } {
  succeeded(data, "issueCreate", "create the ticket");
  const issue = record(record(data.issueCreate).issue ?? {});
  return { id: label(issue.id), identifier: label(issue.identifier), url: label(issue.url) };
}

export const COMMENT_QUERY = `query issueComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    comments(first: $first, after: $after) {
      nodes { id body createdAt url user { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

// What finished blockers left behind, for the agent that starts after them: links (pull requests,
// plan documents) and the latest comments (the agents' summaries), oldest first as Linear returns them.
// State and pull request status tell a merged review apart from one still open.
export const FINISHED_BLOCKERS_QUERY = `query finishedBlockers($ids: [ID!]!) {
  issues(first: 50, filter: { id: { in: $ids } }) { nodes {
    id identifier title url completedAt state { name type }
    attachments(first: 20) { nodes { title url sourceType metadata } }
    documents(first: 10) { nodes { title url } }
    comments(last: 20) { nodes { body createdAt } }
  } }
}`;

// Decision candidates (owner-decisions.ts): the comments, plan documents and tickets of a time
// window, read with the key, page by page.
export const WINDOW_COMMENTS_QUERY = `query windowComments($filter: CommentFilter!, $after: String) {
  comments(first: 100, after: $after, filter: $filter) {
    nodes { id body createdAt url user { id } issue { id identifier title url project { name } parent { id } } parent { body } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const PLAN_DOCUMENTS_QUERY = `query planDocuments($since: DateTimeOrDuration!, $after: String) {
  documents(first: 50, after: $after, filter: { title: { startsWith: "Plan: " }, updatedAt: { gte: $since } }) {
    nodes { id title url content updatedAt issue { id identifier url project { name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const MENTIONING_ISSUES_QUERY = `query mentioningIssues($filter: IssueFilter!, $after: String) {
  issues(first: 50, after: $after, includeArchived: true, filter: $filter) {
    nodes { id identifier title url state { name type } description project { name } comments(first: 100) { nodes { body createdAt url user { name } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const ISSUE_LINKS_QUERY = `query issueLinks($ids: [ID!]!) {
  issues(first: 50, includeArchived: true, filter: { id: { in: $ids } }) { nodes { id identifier url project { name } } }
}`;
export const PROJECT_BY_NAME_QUERY = `query projectByName($name: String!) {
  projects(first: 1, filter: { name: { eqIgnoreCase: $name } }) { nodes { id } }
}`;
// The weekly ops review (ops-review.ts): the team's tickets with an `ops-kind ` marker in the
// description or in a comment, archived ones too, with every comment holding an `ops-` marker
// (paged per ticket past the first 100); and one ticket by its id, in any state.
export const OPS_MARKER_ISSUES_QUERY = `query opsMarkerIssues($filter: IssueFilter!, $after: String) {
  issues(first: 50, after: $after, includeArchived: true, filter: $filter) {
    nodes { id identifier url createdAt completedAt creator { id } state { type } description
      comments(first: 100, filter: { body: { contains: "ops-" } }) { nodes { body createdAt } pageInfo { hasNextPage endCursor } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const OPS_MARKER_COMMENTS_QUERY = `query opsMarkerComments($id: String!, $after: String) {
  issue(id: $id) { comments(first: 100, after: $after, filter: { body: { contains: "ops-" } }) { nodes { body createdAt } pageInfo { hasNextPage endCursor } } }
}`;
export const ISSUE_BY_ID_QUERY = `query issueById($id: ID!) {
  issues(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id identifier url createdAt } }
}`;
export type OpsMarkerIssue = {
  id: string; identifier: string; url: string; createdAt: string; completedAt: string | null; creatorId: string | null; statusType: string; description: string;
  comments: { body: string; createdAt: string }[];
};
export type CreatedIssueRef = { id: string; identifier: string; url: string; createdAt: string };
const WINDOW_PAGES = 50;
export type IssueLink = { id: string; identifier: string; url: string; project: string };
// `issue.parentId`: the ticket's parent (a "Needs you" sub-issue's ticket); `parentBody`: the
// comment this one replies to.
export type WindowComment = { id: string; body: string; createdAt: string; url: string; userId: string; issue: (IssueLink & { title: string; parentId: string | null }) | null; parentBody: string | null };
export type PlanDocument = { id: string; title: string; url: string; content: string; updatedAt: string; issue: IssueLink | null };
export type MentioningIssue = IssueLink & { title: string; status: string; statusType: string; description: string; comments: { body: string; createdAt: string; url: string; author: string }[] };

function issueLink(value: unknown): IssueLink | null {
  const node = record(value ?? {});
  return label(node.id) ? { id: label(node.id), identifier: label(node.identifier), url: label(node.url), project: label(record(node.project ?? {}).name) } : null;
}

export class LinearService {
  private readonly stateWritten: ((issueId: string, state: WrittenState) => void)[] = [];

  constructor(readonly credentials = new Credentials(), private readonly post: Post = postGraphQL, private readonly app?: App, private readonly budget: RateBudget = rateBudget) {}

  // Told about every state change the plugin makes (launch, write-back, review, PR watch), so
  // views of the ticket's state can follow at once instead of at the next poll.
  onStateWritten(listener: (issueId: string, state: WrittenState) => void): void {
    this.stateWritten.push(listener);
  }

  private async writeState(issueId: string, stateId: string): Promise<Record<string, unknown>> {
    const data = record(await this.write(UPDATE_ISSUE_STATE_QUERY, { id: issueId, stateId }));
    const result = record(data.issueUpdate ?? {});
    const state = record(record(result.issue ?? {}).state ?? {});
    if (result.success !== false && label(state.name)) for (const listener of this.stateWritten) listener(issueId, { name: label(state.name), type: label(state.type) });
    return data;
  }

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

  // Background reads (pollers, sweeps) go to the API key's pool first: the Paseo app's pool keeps
  // its requests for the writes the owner sees as Paseo's and for interactive reads. The app reads
  // one only when the key cannot see everything asked for (`complete` false, or "Entity not found").
  // While the key is at its background reserve, or none is connected, a background read takes the
  // interactive path. A key rate limit on a key-first read propagates; the app does not repeat it.
  // Interactive and owner reads go to the app first; the key reads instead when the app cannot be
  // used (`app.query` returns null) or cannot see everything asked for. An app rate limit is not a
  // reason: it propagates, so the work pauses instead of draining the key (README, "Rate limits").
  private async read(query: string, variables: Record<string, unknown>, complete: (data: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    const notFound = (error: unknown) => {
      if (error instanceof Error && /Entity not found/i.test(error.message)) return null;
      throw error;
    };
    if (this.app && currentPriority() === "background" && this.budget.pausedUntil("key", "background") === null) {
      const { key } = await this.credentials.read();
      if (key) {
        let missing: unknown = null;
        const data = await this.post(key, query, variables).catch((error: unknown) => {
          missing = error;
          return notFound(error);
        });
        if (data && complete(data)) return data;
        const fromApp = await this.app.query(query, variables).catch(notFound);
        if (fromApp) return fromApp;
        if (data) return data;
        throw missing;
      }
    }
    const data = this.app ? await this.app.query(query, variables).catch(notFound) : null;
    return data && complete(data) ? data : this.withKey((key) => this.post(key, query, variables));
  }

  private warnedKeyWrites = false;
  // Told about every comment the key creates although the Paseo app is set up (it could not be
  // used at that moment): the comment shows the owner as its author, so the relay must not take it
  // for one of the owner's messages.
  onOwnerComment?: (commentId: string, issueId: string) => Promise<void>;

  // Every automated write is authored by the Paseo app. The key writes only when the app cannot be
  // used here (`app.mutate` returns null: Linear authenticated nothing, so nothing ran); every other
  // failure propagates, so a write is never repeated under the owner's name.
  private async write(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = this.app ? await this.app.mutate(query, variables) : null;
    if (data) return data;
    if (!this.warnedKeyWrites) {
      this.warnedKeyWrites = true;
      console.error("[linear-tickets] the Paseo app is not usable on this host; Linear writes appear as the key's owner");
    }
    const result = await this.withKey((key) => this.post(key, query, variables));
    const commentId = label(record(record(record(result).commentCreate ?? {}).comment ?? {}).id);
    const issueId = label(record(variables.input ?? {}).issueId);
    if (this.app && this.onOwnerComment && commentId && issueId) {
      await this.onOwnerComment(commentId, issueId).catch((error: unknown) => console.error(`[linear-tickets] recording comment ${commentId} failed: ${error instanceof Error ? error.message : error}`));
    }
    return result;
  }

  private appUser: string | null = null;

  // The Paseo app's own user; null when the app cannot be used here. Cached once known.
  async appUserId(): Promise<string | null> {
    if (this.appUser || !this.app) return this.appUser;
    this.appUser = await this.app.viewer().then((viewer) => viewer.id || null, (error: unknown) => {
      if (error instanceof RateLimitedError) throw error;
      return null;
    });
    return this.appUser;
  }

  // The peer host's app user (peer-identity.ts); unset on a host that has no peer.
  peerAppUser?: () => Promise<string | null>;

  // The app users whose tickets count as the owner's (starter.ts isUntrusted): this host's app and
  // the peer host's, each only once known. A peer that cannot be asked adds nothing.
  async trustedAppIds(): Promise<string[]> {
    const own = await this.appUserId();
    const peer = await (this.peerAppUser?.() ?? Promise.resolve(null)).catch(() => null);
    return [own, peer].filter((id): id is string => Boolean(id));
  }

  private readonly people = new Map<string, boolean>();

  // Whether the user is a person rather than an app or integration (read with the key, so it works
  // while the Paseo app is broken). False when Linear does not say.
  async isPerson(userId: string): Promise<boolean> {
    if (userId === this.appUser) return false;
    const known = this.people.get(userId);
    if (known !== undefined) return known;
    const person = await this.withKey((key) => this.post(key, USER_KIND_QUERY, { id: userId })).then((data) => record(data.user ?? {}).app === false, () => null);
    if (person === null) return false;
    this.people.set(userId, person);
    return person;
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

  // The blockers among `ids` that are finished: Done, or in review with their pull requests merged.
  // Read on the app's pool; tickets the app cannot see are read again with the key. Returned in the order of `ids`.
  async finishedBlockers(ids: string[]): Promise<FinishedBlocker[]> {
    if (!ids.length) return [];
    const data = await this.read(FINISHED_BLOCKERS_QUERY, { ids }, (result) => connection(record(result.issues)).nodes.length === ids.length);
    const nodes = connection(record(data.issues)).nodes.map((node) => record(node)).filter((node) => {
      const state = record(node.state ?? {});
      return label(state.type) === "completed" || (inReviewState(label(state.name), label(state.type)) && pullRequestsMerged(node.attachments));
    });
    return nodes.sort((a, b) => ids.indexOf(label(a.id)) - ids.indexOf(label(b.id))).map((node) => ({
      identifier: label(node.identifier),
      title: label(node.title),
      url: label(node.url),
      status: label(record(node.state ?? {}).name),
      completedAt: label(node.completedAt) || null,
      links: [...connection(node.attachments ?? { nodes: [] }).nodes, ...connection(node.documents ?? { nodes: [] }).nodes]
        .map((link) => ({ title: label(record(link).title), url: label(record(link).url) }))
        // The Paseo agent's own link points at an agent session, not at the work.
        .filter((link) => link.url && !link.url.startsWith("https://app.paseo.sh/")),
      comments: connection(node.comments ?? { nodes: [] }).nodes.map((comment) => ({ body: label(record(comment).body), createdAt: label(record(comment).createdAt) })),
    }));
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

  // The team's first unstarted state (Todo): where the plugin files planned work, since the
  // project hand-out never takes a ticket out of Triage. Null when the team has none.
  async todoStateId(teamId: string): Promise<string | null> {
    return (await this.teamStates(teamId)).filter((state) => state.type === "unstarted").sort((a, b) => a.position - b.position)[0]?.id ?? null;
  }

  // Best-effort by design: callers surface `note` as a warning,
  // and a failure here must never turn into a launch failure. `fromStarted`: move even out of a
  // started state that is not work (writeback.ts sends a ticket whose wait ended back to work when
  // nothing recorded the state the wait left); a closed ticket is still left alone.
  async markInProgress(issue: Pick<Issue, "id" | "status" | "statusType">, teamId: string | null, options: { fromStarted?: boolean } = {}): Promise<{ changed: boolean; note?: string }> {
    return withPriority("owner", "status change", async () => {
      // Already started: avoid a repeat write and needless audit noise.
      const type = issue.statusType.trim().toLowerCase();
      if (!options.fromStarted && type === "started") return { changed: false };
      if (options.fromStarted && (type === "completed" || type === "canceled" || type === "duplicate")) return { changed: false };
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
        data = await this.writeState(issue.id, target.id);
      } catch (error) {
        return { changed: false, note: `Linear rejected the change to ${target.name}: ${error instanceof Error ? error.message : "unknown error"}` };
      }
      const result = data.issueUpdate && typeof data.issueUpdate === "object" ? record(data.issueUpdate) : {};
      if (result.success === false) {
        return { changed: false, note: `Linear reported that the change to ${target.name} was not applied; the ticket is unchanged.` };
      }
      return { changed: true };
    });
  }

  async labeledIssues(labelName: string, teamKeys: string[], options: { queueBlockers?: boolean } = {}): Promise<LabeledIssue[]> {
    if (!teamKeys.length) return [];
    const data = record(await this.read(LABELED_ISSUES_QUERY, { first: 50, filter: labeledIssueFilter(labelName, teamKeys, options) }));
    return connection(record(data.issues)).nodes.map((node) => record(node)).map((node) => ({
      id: label(node.id),
      identifier: label(node.identifier),
      teamKey: label(record(node.team ?? {}).key),
      priority: typeof node.priority === "number" ? node.priority : 0,
      labels: labelNodes(node.labels),
      openChildren: connection(node.children ?? { nodes: [] }).nodes.length > 0,
    })).filter((issue) => issue.id)
      // Most urgent first; tickets without a priority last. Stable otherwise (Linear's order).
      .sort((a, b) => (a.priority || 5) - (b.priority || 5));
  }

  async repairCandidates(input: { labels: string[]; teamKeys: string[]; ids: string[]; queueBlockers?: boolean }): Promise<RepairCandidate[]> {
    const found = new Map<string, RepairCandidate>();
    const ids = [...new Set(input.ids)].sort();
    const filters = [
      ...input.teamKeys.length ? [repairCandidateFilter(input.labels, input.teamKeys, { queueBlockers: input.queueBlockers })] : [],
      // A queue-blocker read names the tickets it means: the record-id read would return the other
      // records' tickets too.
      ...(input.queueBlockers ? [] : Array.from({ length: Math.ceil(ids.length / REPAIR_IDS_BATCH) }, (_, index) => ({ id: { in: ids.slice(index * REPAIR_IDS_BATCH, (index + 1) * REPAIR_IDS_BATCH) } }))),
    ];
    for (const filter of filters) {
      let after: string | null = null;
      do {
        const data = record(await this.read(REPAIR_CANDIDATES_QUERY, { first: 100, after, filter }));
        const page = record(data.issues ?? {});
        for (const node of connection(page).nodes.map((item) => record(item))) {
          const state = record(node.state ?? {});
          const id = label(node.id);
          if (id) found.set(id, {
            id, identifier: label(node.identifier), status: label(state.name), statusType: label(state.type),
            projectId: label(record(node.project ?? {}).id) || null, labels: labelNodes(node.labels),
            openChildren: connection(node.children ?? { nodes: [] }).nodes.length > 0,
            queueBlocker: input.queueBlockers === true || label(node.title).startsWith(QUEUE_BLOCKER_TITLE_PREFIX),
          });
        }
        const info = record(page.pageInfo ?? {});
        after = info.hasNextPage === true && label(info.endCursor) ? label(info.endCursor) : null;
      } while (after);
    }
    return [...found.values()];
  }

  // Label names by ticket id, lower-cased. The Paseo app's pool first; the key when the app cannot
  // see every ticket asked for. Ids Linear does not return are missing from the map.
  async issueLabels(ids: string[]): Promise<Map<string, string[]>> {
    const labels = new Map<string, string[]>();
    const valid = [...new Set(ids)].filter((id) => UUID.test(id));
    for (let start = 0; start < valid.length; start += ISSUE_LABELS_BATCH) {
      const batch = valid.slice(start, start + ISSUE_LABELS_BATCH);
      const data = record(await this.read(ISSUE_LABELS_QUERY, { first: batch.length, ids: batch }, (found) => connection(record(found.issues)).nodes.length === batch.length));
      for (const node of connection(record(data.issues)).nodes.map((item) => record(item))) {
        const id = label(node.id);
        if (id) labels.set(id, labelNodes(node.labels).map((item) => item.name.trim().toLowerCase()));
      }
    }
    return labels;
  }

  async issueState(id: string): Promise<IssueState> {
    const data = record(await this.read(ISSUE_STATE_QUERY, { id }, (found) => Boolean(found.issue && typeof found.issue === "object")));
    if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return this issue. Check that you have access to it.");
    return parseIssueState(record(data.issue));
  }

  // What admission decides on, for many tickets in requests of 50 (ADMISSION_STATES_QUERY), parsed
  // exactly as `issueState`. Each id is asked for once; tickets Linear does not return are missing.
  async admissionStates(ids: string[]): Promise<Map<string, AdmissionState>> {
    const result = new Map<string, AdmissionState>();
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += ADMISSION_STATES_BATCH) {
      const chunk = unique.slice(start, start + ADMISSION_STATES_BATCH);
      const data = record(await this.read(ADMISSION_STATES_QUERY, { ids: chunk, first: chunk.length }, (found) => connection(record(found.issues ?? {})).nodes.length === chunk.length));
      for (const node of connection(record(data.issues ?? {})).nodes.map((item) => record(item))) {
        const { id, identifier, status, statusType, projectId, labels, blockedBy, priority, createdAt, unblocks } = parseIssueState(node);
        if (id) result.set(id, { id, identifier, status, statusType, projectId, labels, blockedBy, priority, createdAt, unblocks });
      }
    }
    return result;
  }

  async issueMetadata(id: string): Promise<IssueMetadata> {
    const data = await this.read(ISSUE_METADATA_QUERY, { id }, (found) => Boolean(found.issue && typeof found.issue === "object"));
    if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return this issue. Check that you have access to it.");
    const issue = record(data.issue);
    return { id: label(issue.id), identifier: label(issue.identifier), labels: labelNodes(issue.labels) };
  }

  async issueStatus(id: string): Promise<Pick<IssueState, "status" | "statusType">> {
    return issueStatusOf(await this.read(ISSUE_STATUS_QUERY, { id }, (found) => Boolean(found.issue && typeof found.issue === "object")));
  }

  // `issueStatus` on whichever pool can answer: the app's as usual, the key's when the app's refuses
  // (its reserve or a Linear rate limit). Crash recovery's ticket check (pr-watch.ts) must not wait
  // for one exhausted pool; when no key is connected, the app's refusal propagates. `sentAt`: when
  // the request that answered was sent (milliseconds since the epoch), for KnownStates' precedence.
  async issueStatusAnyPool(id: string): Promise<Pick<IssueState, "status" | "statusType"> & { sentAt: number }> {
    const sentAt = Date.now();
    try {
      return { ...await this.issueStatus(id), sentAt };
    } catch (error) {
      if (!(error instanceof RateLimitedError) || error.pool !== "app") throw error;
      const { key } = await this.credentials.read();
      if (!key) throw error;
      const keySentAt = Date.now();
      return { ...issueStatusOf(await this.post(key, ISSUE_STATUS_QUERY, { id })), sentAt: keySentAt };
    }
  }

  async issueAttachments(id: string): Promise<string[]> {
    const data = await this.read(ISSUE_ATTACHMENT_URLS_QUERY, { id }, (found) => Boolean(found.issue && typeof found.issue === "object"));
    if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return this issue. Check that you have access to it.");
    return connection(record(data.issue).attachments ?? { nodes: [] }).nodes.map((node) => label(record(node).url)).filter(Boolean);
  }

  async issueWatchState(id: string): Promise<Pick<IssueState, "status" | "statusType" | "labels">> {
    const data = await this.read(ISSUE_WATCH_STATE_QUERY, { id }, (found) => Boolean(found.issue && typeof found.issue === "object"));
    if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return this issue. Check that you have access to it.");
    const issue = record(data.issue);
    const state = record(issue.state ?? {});
    return { status: label(state.name), statusType: label(state.type), labels: labelNodes(issue.labels) };
  }

  async labeledProjects(labelName: string): Promise<LabeledProject[]> {
    const data = record(await this.read(LABELED_PROJECTS_QUERY, { label: labelName }));
    return connection(record(data.projects ?? {})).nodes.map((node) => record(node)).map((node) => ({ id: label(node.id), name: label(node.name) })).filter((project) => project.id);
  }

  // Every open ticket of the project, all pages.
  async projectIssues(projectId: string): Promise<ProjectIssue[]> {
    const issues: ProjectIssue[] = [];
    let after: string | null = null;
    do {
      const data = record(await this.read(PROJECT_ISSUES_QUERY, { id: projectId, after }, (found) => Boolean(found.project && typeof found.project === "object")));
      if (!data.project || typeof data.project !== "object") throw new Error("Linear did not return this project. Check that you have access to it.");
      const page = record(record(data.project).issues ?? {});
      for (const node of connection(page).nodes.map((item) => record(item))) issues.push(projectIssue(node, projectId));
      const info = record(page.pageInfo ?? {});
      after = info.hasNextPage === true && label(info.endCursor) ? label(info.endCursor) : null;
    } while (after);
    return issues;
  }

  // The project's tickets changed since `since` (an ISO time), and of `known` (the tickets last
  // read as the project's) the ones that left it, all pages.
  async projectIssuesChanged(projectId: string, since: string, known: string[]): Promise<ProjectChanges> {
    const changes: ProjectChanges = { open: [], closed: [], moved: [] };
    let after: string | null = null;
    do {
      const page = record(record(await this.read(PROJECT_ISSUES_CHANGED_QUERY, { id: projectId, ids: known, since, after })).issues ?? {});
      for (const node of connection(page).nodes.map((item) => record(item))) {
        const id = label(node.id);
        if (!id) continue;
        if (node.archivedAt || FINISHED_TYPES.includes(label(record(node.state ?? {}).type))) changes.closed.push(id);
        else if (label(record(node.project ?? {}).id) !== projectId) changes.moved.push(id);
        else changes.open.push(projectIssue(node, projectId));
      }
      const info = record(page.pageInfo ?? {});
      after = info.hasNextPage === true && label(info.endCursor) ? label(info.endCursor) : null;
    } while (after);
    return changes;
  }

  // Blockers by id as they stand now (finished or not). Ids Linear does not return are left out.
  async blockerStates(ids: string[]): Promise<GroupIssue[]> {
    const states: GroupIssue[] = [];
    const valid = [...new Set(ids)].filter((id) => UUID.test(id));
    for (let start = 0; start < valid.length; start += BLOCKER_STATES_BATCH) {
      const batch = valid.slice(start, start + BLOCKER_STATES_BATCH);
      const data = record(await this.read(BLOCKER_STATES_QUERY, { first: batch.length, ids: batch }, (found) => connection(record(found.issues)).nodes.length === batch.length));
      for (const node of connection(record(data.issues)).nodes.map((item) => record(item))) {
        const state = groupIssue(node);
        if (state.id) states.push(state);
      }
    }
    return states;
  }

  // Descriptions by ticket id, for the project planner's ticket list.
  async issueDescriptions(ids: string[]): Promise<Map<string, string>> {
    const descriptions = new Map<string, string>();
    for (let start = 0; start < ids.length; start += 50) {
      const data = record(await this.read(ISSUE_DESCRIPTIONS_QUERY, { ids: ids.slice(start, start + 50) }));
      for (const node of connection(record(data.issues ?? {})).nodes.map((item) => record(item))) descriptions.set(label(node.id), label(node.description));
    }
    return descriptions;
  }

  // Open tickets of the teams, most recently updated first, up to `limit`.
  async openTeamIssues(teamIds: string[], limit: number): Promise<TeamIssue[]> {
    const issues: TeamIssue[] = [];
    let after: string | null = null;
    do {
      const page = record(record(await this.read(TEAM_OPEN_ISSUES_QUERY, { teams: teamIds, after })).issues ?? {});
      for (const node of connection(page).nodes.map((item) => record(item))) {
        const project = record(node.project ?? {});
        issues.push({ id: label(node.id), identifier: label(node.identifier), title: label(node.title), status: label(record(node.state ?? {}).name), projectId: label(project.id) || null, projectName: label(project.name) });
      }
      const info = record(page.pageInfo ?? {});
      after = issues.length < limit && info.hasNextPage === true && label(info.endCursor) ? label(info.endCursor) : null;
    } while (after);
    return issues.slice(0, limit);
  }

  // The ticket with this identifier (for example TUC-12), in any state; null when there is none.
  async issueRef(identifier: string): Promise<TicketRef | null> {
    const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
    if (!match) return null;
    const data = record(await this.read(ISSUE_BY_NUMBER_QUERY, { team: match[1], number: Number(match[2]) }));
    const node = connection(record(data.issues ?? {})).nodes.map((item) => record(item))[0];
    return node && label(node.id) ? { id: label(node.id), identifier: label(node.identifier), title: label(node.title) } : null;
  }

  async issueGroup(id: string): Promise<IssueGroup> {
    const data = record(await this.read(ISSUE_GROUP_QUERY, { id }, (found) => Boolean(found.issue && typeof found.issue === "object")));
    if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return this issue. Check that you have access to it.");
    const issue = record(data.issue);
    const children = connection(issue.children ?? { nodes: [] }).nodes.map((node) => record(node)).map((child) => ({
      ...groupIssue(child),
      assigneeId: label(record(child.assignee ?? {}).id) || null,
      labels: connection(child.labels ?? { nodes: [] }).nodes.map((node) => label(record(node).name)).filter(Boolean),
      blockers: connection(child.inverseRelations ?? { nodes: [] }).nodes.map((node) => record(node))
        .filter((relation) => label(relation.type) === "blocks")
        .map((relation) => groupIssue(record(relation.issue ?? {})))
        .filter((blocker) => blocker.id),
    }));
    // Lowest number first: the order they were filed in, and the order they are handed out.
    children.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
    return { ...groupIssue(issue), children };
  }

  // `ready` puts the ticket into the team's first unstarted state (Todo) instead of Triage, for
  // tickets the plugin creates as planned work; `startedState` into the started state of that name.
  async createIssue(input: CreateIssueInput): Promise<{ id: string; identifier: string; url: string }> {
    return createdIssue(record(await this.write(CREATE_ISSUE_QUERY, { input: await this.issuePayload(input) })));
  }

  // Only ever as the Paseo app (follow-ups filed from an approved plan must not appear as the
  // owner's): null when the app cannot be used here, and then nothing is written. Reading the
  // team's states may use either credential.
  async createIssueAsApp(input: CreateIssueInput): Promise<{ id: string; identifier: string; url: string } | null> {
    const payload = await this.issuePayload(input);
    const data = this.app ? await this.app.mutate(CREATE_ISSUE_QUERY, { input: payload }) : null;
    return data ? createdIssue(record(data)) : null;
  }

  // A project update a planner run leaves on its project (README, "Projects"). `atRisk` only for the
  // notice that asks the owner, so it stands out in Linear's overview; an applied order leaves the
  // project's health alone. Written like every automated write (as the Paseo app), and the caller
  // treats a failure as best effort: a lost update never blocks the project.
  async projectUpdate(projectId: string, body: string, atRisk = false): Promise<void> {
    succeeded(record(await this.write(PROJECT_UPDATE_QUERY, { input: { projectId, body, ...(atRisk ? { health: "atRisk" } : {}) } })), "projectUpdateCreate", "write the project update");
  }

  private async issuePayload(input: CreateIssueInput): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { teamId: input.teamId, title: input.title, description: input.description };
    if (input.id) payload.id = input.id;
    if (input.ready || input.startedState) {
      const states = await this.teamStates(input.teamId);
      const wanted = input.startedState?.trim().toLowerCase();
      const target = (wanted ? states.find((state) => state.type === "started" && state.name.trim().toLowerCase() === wanted) : undefined)
        ?? (input.ready ? states.filter((state) => state.type === "unstarted").sort((a, b) => a.position - b.position)[0] : undefined);
      if (target) payload.stateId = target.id;
    }
    if (input.priority) payload.priority = input.priority;
    if (input.parentId) payload.parentId = input.parentId;
    if (input.projectId) payload.projectId = input.projectId;
    if (input.assigneeId) payload.assigneeId = input.assigneeId;
    return payload;
  }

  // Stays on the key: delegating is the owner's instruction that opens the ticket's Linear agent
  // session, and SessionRouter only accepts sessions the owner started.
  async delegate(issueId: string, delegateId: string): Promise<void> {
    succeeded(record(await this.withKey((key) => this.post(key, DELEGATE_QUERY, { id: issueId, delegateId }))), "issueUpdate", "assign the ticket to Paseo");
  }

  // `blocker` must be finished before `blocked` can start.
  async addBlocker(blockerId: string, blockedId: string): Promise<void> {
    succeeded(record(await this.write(RELATION_QUERY, { input: { issueId: blockerId, relatedIssueId: blockedId, type: "blocks" } })), "issueRelationCreate", "link the tickets");
  }

  // `related`: both tickets touch the same work. `duplicate`: `issueId` is a duplicate of
  // `relatedId`; Linear then moves it to its Duplicate status.
  async relate(issueId: string, relatedId: string, type: "related" | "duplicate"): Promise<void> {
    succeeded(record(await this.write(RELATION_QUERY, { input: { issueId, relatedIssueId: relatedId, type } })), "issueRelationCreate", "link the tickets");
  }

  // relate, only ever as the Paseo app (see createIssueAsApp): null when the app cannot be used here.
  async relateAsApp(issueId: string, relatedId: string, type: "related" | "duplicate"): Promise<true | null> {
    const data = this.app ? await this.app.mutate(RELATION_QUERY, { input: { issueId, relatedIssueId: relatedId, type } }) : null;
    if (!data) return null;
    succeeded(record(data), "issueRelationCreate", "link the tickets");
    return true;
  }

  async ping(): Promise<void> {
    const data = record(await this.withKey((key) => this.post(key, VIEWER_QUERY, {})));
    if (!label(record(data.viewer ?? {}).id)) throw new Error("Linear did not confirm the API key.");
  }

  async updateDescription(issueId: string, description: string): Promise<void> {
    succeeded(record(await this.write(`mutation describe($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success } }`, { id: issueId, description })), "issueUpdate", "update the ticket");
  }

  // Moves the ticket to its team's first completed state (Done).
  async complete(issueId: string): Promise<void> {
    return withPriority("owner", "status change", async () => {
      const state = await this.issueState(issueId);
      if (!state.teamId || state.statusType === "completed") return;
      const done = (await this.teamStates(state.teamId)).filter((item) => item.type === "completed").sort((a, b) => a.position - b.position)[0];
      if (!done) return;
      succeeded(await this.writeState(issueId, done.id), "issueUpdate", "complete the ticket");
    });
  }

  // Moves the ticket to its team's first canceled state, with the reason posted first.
  async cancel(issueId: string, reason: string): Promise<void> {
    return withPriority("owner", "status change", async () => {
      const state = await this.issueState(issueId);
      if (!state.teamId || ["completed", "canceled", "duplicate"].includes(state.statusType)) return;
      const canceled = (await this.teamStates(state.teamId)).filter((item) => item.type === "canceled").sort((a, b) => a.position - b.position)[0];
      if (!canceled) return;
      await this.comment(issueId, reason);
      succeeded(await this.writeState(issueId, canceled.id), "issueUpdate", "cancel the ticket");
    });
  }

  async deleteIssue(issueId: string): Promise<void> {
    succeeded(record(await this.write(DELETE_ISSUE_QUERY, { id: issueId })), "issueDelete", "delete the ticket");
  }

  async teamIdByKey(teamKey: string): Promise<string | null> {
    const data = record(await this.withKey((key) => this.post(key, TEAM_BY_KEY_QUERY, { key: teamKey })));
    return connection(record(data.teams ?? {})).nodes.map((node) => label(record(node).id))[0] || null;
  }

  // Label IDs by lowercase name, cached for the plugin's lifetime. A missing label is
  // created as a workspace label so every team can use it, in `color` when given.
  private readonly labelIds = new Map<string, string>();

  private async labelId(name: string, color?: string): Promise<string> {
    const wanted = name.trim().toLowerCase();
    const cached = this.labelIds.get(wanted);
    if (cached) return cached;
    const found = labelNodes(record(await this.withKey((key) => this.post(key, LABEL_BY_NAME_QUERY, { name }))).issueLabels)[0];
    let id = found?.id;
    if (!id) {
      const created = record(await this.write(CREATE_LABEL_QUERY, { input: { name, ...(color ? { color } : {}) } }));
      succeeded(created, "issueLabelCreate", `create the "${name}" label`);
      id = label(record(record(created.issueLabelCreate).issueLabel ?? {}).id);
      if (!id) throw new Error(`Linear did not return the new "${name}" label.`);
    }
    this.labelIds.set(wanted, id);
    return id;
  }

  async addLabel(issueId: string, name: string, color?: string): Promise<void> {
    const labelId = await this.labelId(name, color);
    succeeded(record(await this.write(ADD_LABEL_QUERY, { id: issueId, labelId })), "issueAddLabel", `add the "${name}" label`);
  }

  // Removes every label on the ticket with this name (case-insensitive); a team label and
  // a workspace label can share a name. Missing labels are not an error.
  async removeLabel(issueId: string, name: string, current?: { id: string; name: string }[]): Promise<void> {
    const labels = current ?? (await this.issueState(issueId)).labels;
    const wanted = name.trim().toLowerCase();
    for (const { id } of labels.filter((item) => item.name.trim().toLowerCase() === wanted)) {
      try {
        succeeded(record(await this.write(REMOVE_LABEL_QUERY, { id: issueId, labelId: id })), "issueRemoveLabel", `remove the "${name}" label`);
      } catch (error) {
        // `current` can be stale: another write removed the label meanwhile, which is the goal anyway.
        if (!/Label not on issue/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }

  // Every label of the workspace and its teams, groups included.
  async labelCatalog(): Promise<CatalogLabel[]> {
    const labels: CatalogLabel[] = [];
    let after: string | null = null;
    do {
      const page = connection(record(await this.read(LABEL_CATALOG_QUERY, { after })).issueLabels);
      for (const node of page.nodes.map((item) => record(item))) {
        const id = label(node.id);
        if (id) labels.push({ id, name: label(node.name), isGroup: node.isGroup === true, parentId: label(record(node.parent ?? {}).id) || null, teamId: label(record(node.team ?? {}).id) || null });
      }
      after = page.hasNextPage ? page.endCursor : null;
    } while (after);
    return labels;
  }

  // A workspace label (a group with `isGroup`, a member of one with `parentId`). Returns its id.
  async createLabel(input: { name: string; color?: string; description?: string; isGroup?: boolean; parentId?: string }): Promise<string> {
    const created = record(await this.write(CREATE_LABEL_QUERY, { input }));
    succeeded(created, "issueLabelCreate", `create the "${input.name}" label`);
    const id = label(record(record(created.issueLabelCreate).issueLabel ?? {}).id);
    if (!id) throw new Error(`Linear did not return the new "${input.name}" label.`);
    return id;
  }

  async moveLabelIntoGroup(labelId: string, groupId: string, name: string): Promise<void> {
    succeeded(record(await this.write(UPDATE_LABEL_QUERY, { id: labelId, input: { parentId: groupId } })), "issueLabelUpdate", `move the "${name}" label into its group`);
  }

  // One page of the teams' issues, most recently updated first; `since` limits it to issues updated after then.
  async labelSweep(teamKeys: string[], since: string | null, after: string | null): Promise<{ issues: SweptIssue[]; next: string | null }> {
    const filter = { team: { key: { in: teamKeys } }, ...(since ? { updatedAt: { gt: since } } : {}) };
    const page = connection(record(await this.read(LABEL_SWEEP_QUERY, { first: LABEL_SWEEP_PAGE, after, filter })).issues);
    const ids = (value: unknown) => connection(value ?? { nodes: [] }).nodes.map((node) => label(record(node).id)).filter(Boolean);
    const issues = page.nodes.map((item) => record(item)).map((node): SweptIssue => {
      const parent = node.parent ? record(node.parent) : null;
      const urls = connection(node.attachments ?? { nodes: [] }).nodes.map((attachment) => label(record(attachment).url).match(PULL_REQUEST_URL)?.[0]);
      return {
        id: label(node.id), identifier: label(node.identifier), title: label(node.title), description: typeof node.description === "string" ? node.description : "",
        createdAt: label(node.createdAt), updatedAt: label(node.updatedAt), projectName: label(node.project ?? null) || null,
        parentId: parent ? label(parent.id) || null : null, parentLabelIds: parent ? ids(parent.labels) : [], labelIds: ids(node.labels),
        pullRequests: [...new Set(urls.filter((url): url is string => Boolean(url)))],
      };
    }).filter((issue) => issue.id && issue.createdAt);
    return { issues, next: page.hasNextPage ? page.endCursor : null };
  }

  // The issue's label changes, newest first, read until a page holds one `relevant` to the caller.
  async labelHistory(issueId: string, relevant: (event: LabelEvent) => boolean): Promise<LabelEvent[]> {
    const events: LabelEvent[] = [];
    let after: string | null = null;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const history = connection(record(record(await this.read(LABEL_HISTORY_QUERY, { id: issueId, after })).issue ?? {}).history ?? { nodes: [] });
      const found = history.nodes.map((item) => record(item)).map((node): LabelEvent => ({
        at: label(node.createdAt), actorId: label(node.actorId) || null,
        added: Array.isArray(node.addedLabelIds) ? node.addedLabelIds.map(label) : [],
        removed: Array.isArray(node.removedLabelIds) ? node.removedLabelIds.map(label) : [],
      })).filter((event) => event.added.length || event.removed.length);
      events.push(...found);
      if (found.some(relevant) || !history.hasNextPage) break;
      after = history.endCursor;
    }
    return events;
  }

  // One write: Linear applies both lists together, so swapping a group's label never leaves two.
  async changeLabels(issueId: string, added: string[], removed: string[]): Promise<void> {
    succeeded(record(await this.write(CHANGE_LABELS_QUERY, { id: issueId, added, removed })), "issueUpdate", "change the ticket's labels");
  }

  // `id`: a client-chosen UUID, so a comment whose answer was lost can be looked up (commentById)
  // and only posted once under it.
  async comment(issueId: string, body: string, id?: string): Promise<void> {
    succeeded(record(await this.write(CREATE_COMMENT_QUERY, { input: { issueId, body, ...(id ? { id } : {}) } })), "commentCreate", "create the comment");
  }

  // One comment by its id, with the key like `issueById`; null when Linear has no comment with that
  // id, so a caller that may have posted it already retries under the same id instead of trusting
  // its own record. Any other failure (network, rate limit, auth) propagates.
  async commentById(id: string): Promise<{ id: string } | null> {
    try {
      const comment = record(record(await this.withKey((key) => this.post(key, COMMENT_BY_ID_QUERY, { id }))).comment ?? {});
      return label(comment.id) ? { id: label(comment.id) } : null;
    } catch (error) {
      if (entityNotFound(error)) return null;
      throw error;
    }
  }

  // One comment's body by its id, with the key like `commentById`; null when Linear has no comment
  // with that id. A recorded waiting period's own comment says what opened it, so writeback can
  // classify waits from before it recorded that. Any other failure propagates.
  async commentBody(id: string): Promise<string | null> {
    try {
      const comment = record(record(await this.withKey((key) => this.post(key, COMMENT_BY_ID_QUERY, { id }))).comment ?? {});
      return label(comment.id) ? label(comment.body) : null;
    } catch (error) {
      if (entityNotFound(error)) return null;
      throw error;
    }
  }

  // Whether one of the ticket's comments contains `text`, checked on the bodies Linear returns
  // rather than trusted to its filter. Throws when Linear does not return the ticket: a caller that
  // would post the comment otherwise must not post it blind.
  async hasComment(issueId: string, text: string): Promise<boolean> {
    const data = await this.read(MARKED_COMMENT_QUERY, { id: issueId, text }, (result) => Boolean(result.issue));
    if (!data.issue || typeof data.issue !== "object") throw new Error("Linear did not return the ticket whose comments were looked up.");
    return connection(record(data.issue).comments).nodes.some((node) => label(record(node).body).includes(text));
  }

  // Edits the tracked comment (the progress or waiting comment), or posts a new one when there is
  // none or Linear no longer has it (deleted); any other failure propagates, so a comment is never
  // posted twice. Returns its id.
  async upsertComment(issueId: string, body: string, commentId: string | null): Promise<string> {
    if (commentId) {
      const variables = { id: commentId, input: { body } };
      try {
        const data = await this.write(UPDATE_COMMENT_QUERY, variables).catch((error: unknown) => {
          // Linear lets only a comment's author edit it: a comment the key wrote before writes moved
          // to the app stays the key's. Measured 2026-10-01: the app gets INPUT_ERROR "Cannot modify
          // Comment"; attachments and documents the key wrote, the app may change.
          if (!(error instanceof LinearApiError && error.codes.includes("INPUT_ERROR") && error.reasons.some((reason) => /^Cannot modify Comment\b/.test(reason)))) throw error;
          return this.withKey((key) => this.post(key, UPDATE_COMMENT_QUERY, variables));
        });
        succeeded(record(data), "commentUpdate", "update the comment");
        return commentId;
      } catch (error) {
        if (!entityNotFound(error)) throw error;
      }
    }
    const data = record(await this.write(CREATE_COMMENT_QUERY, { input: { issueId, body } }));
    succeeded(data, "commentCreate", "create the comment");
    return label(record(record(data.commentCreate).comment ?? {}).id);
  }

  async upsertAttachment(issueId: string, url: string, title: string, subtitle: string, iconUrl?: string): Promise<void> {
    const input = { issueId, url, title, subtitle, ...(iconUrl ? { iconUrl } : {}) };
    succeeded(record(await this.write(UPSERT_ATTACHMENT_QUERY, { input })), "attachmentCreate", "update the Paseo agent link");
  }

  // Removes attachments whose URL starts with `prefix`, except `keep` (a previous agent's link).
  async removeAttachments(issueId: string, prefix: string, keep: string): Promise<void> {
    const issue = record(record(await this.withKey((key) => this.post(key, ISSUE_ATTACHMENTS_QUERY, { id: issueId }))).issue ?? {});
    for (const node of connection(issue.attachments ?? { nodes: [] }).nodes.map((item) => record(item))) {
      const url = label(node.url);
      if (url.startsWith(prefix) && url !== keep) succeeded(record(await this.write(DELETE_ATTACHMENT_QUERY, { id: label(node.id) })), "attachmentDelete", "remove the old Paseo agent link");
    }
  }

  // Linear refuses a URL that is already linked to this ticket (its GitHub integration often links
  // the pull request first) or, for a pull request, to another one. Retrying cannot change either,
  // so "already been linked" ends the step instead of failing the write-back on every turn.
  async linkUrl(issueId: string, url: string, title: string): Promise<void> {
    try {
      succeeded(record(await this.write(LINK_URL_QUERY, { issueId, url, title })), "attachmentLinkURL", "attach the link");
    } catch (error) {
      if (!(error instanceof Error && /already been linked/i.test(error.message))) throw error;
    }
  }

  private viewer: string | null = null;
  private workspace: string | null = null;

  // The workspace's web address (https://linear.app/<urlKey>); cached: a key belongs to one workspace.
  async workspaceUrl(): Promise<string> {
    if (this.workspace) return this.workspace;
    const urlKey = label(record(record(await this.read(ORGANIZATION_QUERY, {})).organization ?? {}).urlKey);
    if (!urlKey) throw new Error("Linear did not return the workspace's URL key.");
    this.workspace = `https://linear.app/${encodeURIComponent(urlKey)}`;
    return this.workspace;
  }

  // The API key's own user; cached because the key cannot change without a reconnect.
  async viewerId(): Promise<string> {
    if (this.viewer) return this.viewer;
    const id = label(record(record(await this.withKey((key) => this.post(key, VIEWER_QUERY, {}))).viewer ?? {}).id);
    if (!id) throw new Error("Linear did not return the connected user.");
    this.viewer = id;
    return id;
  }

  private readonly userUrls = new Map<string, string>();

  // The user's profile URL, which a comment turns into an @mention.
  async userUrl(userId: string): Promise<string> {
    const cached = this.userUrls.get(userId);
    if (cached) return cached;
    const url = label(record(record(await this.withKey((key) => this.post(key, USER_URL_QUERY, { id: userId }))).user ?? {}).url);
    if (!url) throw new Error("Linear did not return the user's profile link.");
    this.userUrls.set(userId, url);
    return url;
  }

  // The owner's "@paseo" comments and thread replies since each ticket's cursor (inclusive), oldest first, in one
  // request per RELAY_BATCH tickets on the app's pool; tickets the app cannot see are read with
  // the key. `unseen`: tickets neither credential returned (deleted, no access, not a Linear id).
  async relayComments(userId: string, cursors: { issueId: string; since: string }[], plain = false): Promise<{ comments: Map<string, RelayComment[]>; unseen: string[] }> {
    const comments = new Map<string, RelayComment[]>();
    const unseen = cursors.filter((cursor) => !UUID.test(cursor.issueId)).map((cursor) => cursor.issueId);
    const valid = cursors.filter((cursor) => UUID.test(cursor.issueId));
    const viaKey = (query: string, variables: Record<string, unknown>) => this.withKey((key) => this.post(key, query, variables));
    const reader = this.app;
    for (let start = 0; start < valid.length; start += RELAY_BATCH) {
      const batch = valid.slice(start, start + RELAY_BATCH);
      const fromApp = reader ? await this.relayPages(userId, batch, comments, plain, async (query, variables) => {
        const data = await reader.query(query, variables);
        if (!data) throw APP_UNUSABLE;
        return data;
      }).catch((error: unknown) => {
        if (error === APP_UNUSABLE) return null;
        throw error;
      }) : null;
      const retry = fromApp === null ? batch : batch.filter((cursor) => fromApp.includes(cursor.issueId));
      if (retry.length) unseen.push(...await this.relayPages(userId, retry, comments, plain, viaKey));
    }
    for (const list of comments.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { comments, unseen };
  }

  // Pages through the batch, one request per round for every ticket that still has a next page
  // (at most 10 rounds; the rest comes on the next poll). Returns the tickets that came back empty.
  private async relayPages(userId: string, batch: { issueId: string; since: string }[], into: Map<string, RelayComment[]>, plain: boolean, send: (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<string[]> {
    const empty: string[] = [];
    let round = batch.map((cursor) => ({ ...cursor, after: null as string | null }));
    for (let page = 0; page < 10 && round.length; page++) {
      const variables: Record<string, unknown> = { u: userId };
      round.forEach((item, index) => Object.assign(variables, { [`i${index}`]: item.issueId, [`s${index}`]: item.since, [`a${index}`]: item.after }));
      const data = record(await send(relayCommentsQuery(round.length, plain), variables));
      const next: typeof round = [];
      round.forEach((item, index) => {
        const issue = connection(data[`t${index}`] ?? { nodes: [] }).nodes[0];
        if (!issue) {
          if (page === 0) empty.push(item.issueId);
          return;
        }
        const found = connection(record(issue).comments ?? { nodes: [] });
        const list = into.get(item.issueId) ?? [];
        into.set(item.issueId, list);
        for (const node of found.nodes.map((entry) => record(entry))) {
          const id = label(node.id);
          if (!id) continue;
          list.push({
            id,
            body: label(node.body),
            createdAt: label(node.createdAt),
            userId: label(record(node.user ?? {}).id),
            reactions: (Array.isArray(node.reactions) ? node.reactions : []).map((entry) => record(entry)).map((reaction) => ({ emoji: label(reaction.emoji), userId: label(record(reaction.user ?? {}).id) })),
            sessionId: label(record(node.agentSession ?? {}).id) || null,
            parent: node.parent ? { id: label(record(node.parent).id), userId: label(record(record(node.parent).user ?? {}).id), sessionId: label(record(record(node.parent).agentSession ?? {}).id) || null } : null,
          });
        }
        if (found.hasNextPage && found.endCursor) next.push({ ...item, after: found.endCursor });
      });
      round = next;
    }
    return empty;
  }

  // Every page of a connection read with the key (at most WINDOW_PAGES), for the windowed reads below.
  private async allPages(query: string, variables: Record<string, unknown>, field: string): Promise<Record<string, unknown>[]> {
    const nodes: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (let page = 0; page < WINDOW_PAGES; page++) {
      const data = record(await this.withKey((key) => this.post(key, query, { ...variables, after })));
      const found = connection(record(data[field] ?? {}));
      nodes.push(...found.nodes.map((node) => record(node)));
      if (!found.hasNextPage || !found.endCursor) return nodes;
      after = found.endCursor;
    }
    throw new Error(`Linear returned more than ${WINDOW_PAGES} pages of ${field}; narrow the window.`);
  }

  private async windowComments(filter: Record<string, unknown>): Promise<WindowComment[]> {
    return (await this.allPages(WINDOW_COMMENTS_QUERY, { filter }, "comments")).map((node) => {
      const issue = issueLink(node.issue);
      const raw = record(node.issue ?? {});
      return {
        id: label(node.id), body: label(node.body), createdAt: label(node.createdAt), url: label(node.url), userId: label(record(node.user ?? {}).id),
        issue: issue ? { ...issue, title: label(raw.title), parentId: label(record(raw.parent ?? {}).id) || null } : null,
        parentBody: node.parent ? label(record(node.parent).body) : null,
      };
    }).filter((comment) => comment.id);
  }

  // The user's comments created since then, on every issue the key can see.
  async ownerCommentsSince(userId: string, since: string): Promise<WindowComment[]> {
    return this.windowComments({ user: { id: { eq: userId } }, createdAt: { gte: since } });
  }

  // The "↩️ Plan sent back" comments (PlannotatorBridge) created since then.
  async planSentBackSince(since: string): Promise<WindowComment[]> {
    return this.windowComments({ body: { contains: "Plan sent back" }, createdAt: { gte: since } });
  }

  // "Plan: <ID>" documents updated since then, with their ticket.
  async planDocumentsSince(since: string): Promise<PlanDocument[]> {
    return (await this.allPages(PLAN_DOCUMENTS_QUERY, { since }, "documents")).map((node) => ({
      id: label(node.id), title: label(node.title), url: label(node.url), content: typeof node.content === "string" ? node.content : "", updatedAt: label(node.updatedAt), issue: issueLink(node.issue),
    })).filter((document) => document.id);
  }

  // The team's tickets whose description contains `text` (archived ones too), with their comments;
  // `openOnly` leaves out completed, canceled and duplicate ones.
  async issuesMentioning(teamId: string, text: string, openOnly = false): Promise<MentioningIssue[]> {
    const filter = { team: { id: { eq: teamId } }, description: { contains: text }, ...(openOnly ? { state: { type: { nin: ["completed", "canceled", "duplicate"] } } } : {}) };
    return (await this.allPages(MENTIONING_ISSUES_QUERY, { filter }, "issues")).flatMap((node) => {
      const link = issueLink(node);
      if (!link) return [];
      const state = record(node.state ?? {});
      return [{
        ...link, title: label(node.title), status: label(state.name), statusType: label(state.type), description: label(node.description),
        comments: connection(node.comments ?? { nodes: [] }).nodes.map((item) => record(item))
          .map((item) => ({ body: label(item.body), createdAt: label(item.createdAt), url: label(item.url), author: label(record(item.user ?? {}).name) }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      }];
    });
  }

  // The ops review's marker tickets (see OPS_MARKER_ISSUES_QUERY), each with all its `ops-`
  // comments, oldest first; a ticket whose comments do not fit one page is read on until complete.
  async opsMarkerIssues(teamId: string): Promise<OpsMarkerIssue[]> {
    const filter = { team: { id: { eq: teamId } }, or: [{ description: { contains: "ops-kind " } }, { comments: { some: { body: { contains: "ops-kind " } } } }] };
    const issues: OpsMarkerIssue[] = [];
    for (const node of await this.allPages(OPS_MARKER_ISSUES_QUERY, { filter }, "issues")) {
      const id = label(node.id);
      if (!id) continue;
      const page = connection(record(node.comments ?? { nodes: [] }));
      const comments = page.nodes.map((item) => record(item));
      let after = page.hasNextPage ? page.endCursor : null;
      for (let round = 0; after; round++) {
        if (round >= WINDOW_PAGES) throw new Error(`Linear returned more than ${WINDOW_PAGES} pages of comments on ${label(node.identifier)}.`);
        const data = record(await this.withKey((key) => this.post(key, OPS_MARKER_COMMENTS_QUERY, { id, after })));
        const next = connection(record(record(data.issue ?? {}).comments ?? {}));
        comments.push(...next.nodes.map((item) => record(item)));
        after = next.hasNextPage ? next.endCursor : null;
      }
      issues.push({
        id, identifier: label(node.identifier), url: label(node.url), createdAt: label(node.createdAt), completedAt: label(node.completedAt) || null,
        creatorId: label(record(node.creator ?? {}).id) || null, statusType: label(record(node.state ?? {}).type), description: label(node.description),
        comments: comments.map((item) => ({ body: label(item.body), createdAt: label(item.createdAt) })).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      });
    }
    return issues;
  }

  // One ticket by its id (archived too); null when Linear has none with that id.
  async issueById(id: string): Promise<CreatedIssueRef | null> {
    const data = record(await this.withKey((key) => this.post(key, ISSUE_BY_ID_QUERY, { id })));
    const node = connection(record(data.issues ?? {})).nodes.map((item) => record(item))[0];
    return node && label(node.id) ? { id: label(node.id), identifier: label(node.identifier), url: label(node.url), createdAt: label(node.createdAt) } : null;
  }

  // Identifier, URL and project of tickets by id; tickets the key cannot see are missing.
  async issueLinks(ids: string[]): Promise<Map<string, IssueLink>> {
    const links = new Map<string, IssueLink>();
    const valid = [...new Set(ids)].filter((id) => UUID.test(id));
    for (let start = 0; start < valid.length; start += 50) {
      const data = record(await this.withKey((key) => this.post(key, ISSUE_LINKS_QUERY, { ids: valid.slice(start, start + 50) })));
      for (const node of connection(record(data.issues ?? {})).nodes) {
        const link = issueLink(node);
        if (link) links.set(link.id, link);
      }
    }
    return links;
  }

  async projectIdByName(name: string): Promise<string | null> {
    const data = record(await this.withKey((key) => this.post(key, PROJECT_BY_NAME_QUERY, { name })));
    return connection(record(data.projects ?? {})).nodes.map((node) => label(record(node).id))[0] || null;
  }

  async react(commentId: string, emoji: string): Promise<void> {
    succeeded(record(await this.write(REACTION_QUERY, { commentId, emoji })), "reactionCreate", "add the reaction");
  }

  // The ticket's document with this title (for example "Plan: TUC-9"), or null.
  async issueDocument(issueId: string, title: string): Promise<{ url: string; content: string } | null> {
    const data = record(await this.withKey((key) => this.post(key, ISSUE_DOCUMENTS_QUERY, { id: issueId })));
    const found = connection(record(data.issue ?? {}).documents ?? { nodes: [] }).nodes.map((node) => record(node)).find((node) => label(node.title) === title);
    return found ? { url: label(found.url), content: typeof found.content === "string" ? found.content : "" } : null;
  }

  // One document per title on the ticket: replaced when it exists, created otherwise.
  // Returns the document URL for linking from a comment.
  async upsertIssueDocument(issueId: string, title: string, content: string): Promise<string> {
    const data = record(await this.withKey((key) => this.post(key, ISSUE_DOCUMENTS_QUERY, { id: issueId })));
    const issue = record(data.issue ?? {});
    const existing = connection(issue.documents ?? { nodes: [] }).nodes.map((node) => record(node)).find((node) => label(node.title) === title);
    const result = existing
      ? record(await this.write(UPDATE_DOCUMENT_QUERY, { id: label(existing.id), input: { title, content } }))
      : record(await this.write(CREATE_DOCUMENT_QUERY, { input: { title, content, issueId: label(issue.id) || issueId } }));
    const field = existing ? "documentUpdate" : "documentCreate";
    succeeded(result, field, existing ? "update the plan document" : "create the plan document");
    return label(record(record(result[field]).document ?? {}).url);
  }

  // Moves the ticket into its team's "started" state with this name (for example Planning or
  // In Progress), unless it is already there or finished. Teams without it are left alone.
  // `current`: the ticket's state when the caller already read it.
  async moveToStateNamed(issueId: string, name: string, current?: IssueState): Promise<{ changed: boolean; note?: string }> {
    return withPriority("owner", "status change", async () => {
      const state = current ?? await this.issueState(issueId);
      const type = state.statusType.trim().toLowerCase();
      if (type === "completed" || type === "canceled" || type === "duplicate") return { changed: false };
      if (state.status.trim().toLowerCase() === name.toLowerCase()) return { changed: false };
      if (!state.teamId) return { changed: false, note: "The ticket has no team." };
      const target = (await this.teamStates(state.teamId)).find((item) => item.type.trim().toLowerCase() === "started" && item.name.trim().toLowerCase() === name.toLowerCase());
      if (!target) return { changed: false, note: `The ticket's team has no started state named "${name}".` };
      succeeded(await this.writeState(issueId, target.id), "issueUpdate", `move the ticket to ${target.name}`);
      return { changed: true };
    });
  }

  // Moves the ticket to one known state of its team (for example back to where it was).
  async moveToState(issueId: string, stateId: string): Promise<void> {
    return withPriority("owner", "status change", async () => {
      succeeded(await this.writeState(issueId, stateId), "issueUpdate", "move the ticket");
    });
  }

  // Moves the ticket back to its team's first unstarted state (Todo): planned, not being worked on.
  async moveToReady(issueId: string): Promise<{ changed: boolean; note?: string }> {
    return withPriority("owner", "status change", async () => {
      const state = await this.issueState(issueId);
      const type = state.statusType.trim().toLowerCase();
      if (type === "completed" || type === "canceled" || type === "duplicate" || type === "unstarted") return { changed: false };
      if (!state.teamId) return { changed: false, note: "The ticket has no team." };
      const target = (await this.teamStates(state.teamId)).filter((item) => item.type === "unstarted").sort((a, b) => a.position - b.position)[0];
      if (!target) return { changed: false, note: "The ticket's team has no unstarted state." };
      succeeded(await this.writeState(issueId, target.id), "issueUpdate", `move the ticket to ${target.name}`);
      return { changed: true };
    });
  }

  // Moves a finished ticket back to its team's first unstarted state (Todo), for example a manual
  // task whose check failed after it was marked done.
  async reopen(issueId: string): Promise<void> {
    return withPriority("owner", "status change", async () => {
      const state = await this.issueState(issueId);
      if (!state.teamId) return;
      const target = (await this.teamStates(state.teamId)).filter((item) => item.type === "unstarted").sort((a, b) => a.position - b.position)[0];
      if (!target || target.id === state.statusId) return;
      succeeded(await this.writeState(issueId, target.id), "issueUpdate", `move the ticket to ${target.name}`);
    });
  }

  // State name, type and completion time of up to 250 issues per request. Deleted, archived or
  // invisible issues are absent from the result. Issues the app cannot see are read again with the key.
  async issueStatuses(ids: string[]): Promise<Map<string, IssueStatus>> {
    const result = new Map<string, IssueStatus>();
    for (let start = 0; start < ids.length; start += ISSUE_STATUSES_BATCH) {
      const chunk = ids.slice(start, start + ISSUE_STATUSES_BATCH);
      const data = record(await this.read(ISSUE_STATUSES_QUERY, { ids: chunk, first: chunk.length }, (found) => connection(record(found.issues ?? {})).nodes.length === new Set(chunk).size));
      for (const node of connection(record(data.issues ?? {})).nodes.map((item) => record(item))) {
        const state = record(node.state ?? {});
        result.set(label(node.id), { status: label(state.name), statusType: label(state.type), completedAt: label(node.completedAt) || null });
      }
    }
    return result;
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
    return withPriority("owner", "status change", async () => {
      const state = await this.issueState(issueId);
      const type = state.statusType.trim().toLowerCase();
      if (type === "completed" || type === "canceled") return { changed: false };
      if (/review/i.test(state.status) && type === "started") return { changed: false };
      if (!state.teamId) return { changed: false, note: "The ticket has no team." };
      const target = resolveReviewState(await this.teamStates(state.teamId));
      if (!target) return { changed: false, note: "The ticket's team has no review state." };
      succeeded(await this.writeState(issueId, target.id), "issueUpdate", `move the ticket to ${target.name}`);
      return { changed: true };
    });
  }
}
