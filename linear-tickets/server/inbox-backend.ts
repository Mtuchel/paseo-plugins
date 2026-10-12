import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { DecisionView } from "../shared/decision-inbox";
import { headerValue, INBOX_AUTH_HEADER, INBOX_INSTANCE_HEADER, INBOX_PROTOCOL_VERSION, inboxSecretsMatch, readBackendSecret, type InboxBackendState } from "./inbox-transport";
import type { InboxView } from "./review-page";

// The checked inbox backend's private seam (README, "Inbox transport"): the two authenticated
// routes the frontdoor reads (/_inbox/ready, /_inbox/snapshot), the admission fence every
// forwarded mutation passes before an action handler sees it, and the backend instance epoch.
// The routes never answer to a browser -- the frontdoor's public dispatcher refuses /_inbox/* --
// and the action handlers stay exactly the ones the plugin already had (review-links.ts,
// decision-inbox.ts): this module adds no decision logic, no ledger and no second writer.

export type InboxBackendRefusal = { status: number; headers?: Record<string, string>; body: string };

export type InboxBackendOptions = {
  // The review inbox view (review-links.ts): waiting, decided, being-applied rows and pipeline.
  inbox: () => Promise<InboxView>;
  // The browser decision view (decision-inbox.ts): owner asks, live requests and receipts.
  decisions: () => Promise<DecisionView>;
  // The private credential; the file both processes share by default.
  credential?: () => Promise<string | null>;
  now?: () => Date;
};

const json = (status: number, value: unknown): InboxBackendRefusal => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(value) });
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class InboxBackend {
  // A new epoch for every plugin contribution: the frontdoor (and a reload's leftover client)
  // cannot hand a mutation composed against the previous backend to this one.
  readonly instanceId = randomUUID();
  private state: InboxBackendState = "starting";
  private readonly credential: () => Promise<string | null>;
  private readonly now: () => Date;
  private readonly options: InboxBackendOptions;

  constructor(options: InboxBackendOptions) {
    this.options = options;
    this.credential = options.credential ?? (() => readBackendSecret());
    this.now = options.now ?? (() => new Date());
  }

  get currentState(): InboxBackendState {
    return this.state;
  }

  // The plugin's checked handlers are wired and its listener answers. Called once the review
  // links have started; before that a ready probe would only describe an open socket.
  ready(): void {
    if (this.state === "starting") this.state = "ready";
  }

  // Teardown began (plannotator.stop and everything after it): refuse new work before any of it
  // runs, so a forwarded mutation can never be rebound to the replacement plugin.
  draining(): void {
    this.state = "draining";
  }

  // The private routes, or null for every other path. `/`-exact paths only: the frontdoor's
  // public dispatcher never forwards them, but they are authenticated here as well.
  async route(request: { method: string; path: string; headers: IncomingHttpHeaders }): Promise<InboxBackendRefusal | null> {
    const { method, path, headers } = request;
    if (path !== "/_inbox/ready" && path !== "/_inbox/snapshot") return null;
    if (!inboxSecretsMatch(headerValue(headers, INBOX_AUTH_HEADER), await this.credential())) return json(401, { error: "Not allowed." });
    if (method !== "GET") return { status: 405, headers: { allow: "GET" }, body: JSON.stringify({ error: "Use GET." }) };
    if (path === "/_inbox/ready") return json(200, { protocolVersion: INBOX_PROTOCOL_VERSION, instanceId: this.instanceId, state: this.state });
    // A draining backend's views are already being torn down; the frontdoor keeps serving its
    // last snapshot as stale instead of capturing half of one.
    if (this.state === "draining") return json(409, { error: "This inbox backend is draining; it serves no snapshot." });
    const capturedAt = this.now().toISOString();
    try {
      const [inbox, decisions] = await Promise.all([this.options.inbox(), this.options.decisions()]);
      return json(200, { protocolVersion: INBOX_PROTOCOL_VERSION, instanceId: this.instanceId, state: this.state, capturedAt, inbox, decisions });
    } catch (error) {
      return json(503, { error: `The inbox snapshot could not be composed: ${reasonOf(error)}` });
    }
  }

  // The admission fence in front of every mutation route: null admits, anything else is the
  // refusal the caller returns instead of entering an action handler. A request without the
  // frontdoor's instance header is not a forwarded browser action and is refused.
  admit(headers: IncomingHttpHeaders): InboxBackendRefusal | null {
    const expected = headerValue(headers, INBOX_INSTANCE_HEADER);
    if (expected === null) return json(400, { error: "This route is only served through the inbox frontdoor; the action was not delivered." });
    if (expected !== this.instanceId) return json(409, { error: "The inbox backend was replaced since this page was loaded; the action was not delivered. Refresh the page and try again." });
    if (this.state === "draining") return json(503, { error: "The inbox backend is draining for a reload; the action was not delivered." });
    if (this.state === "starting") return json(503, { error: "The inbox backend is still starting; the action was not delivered." });
    return null;
  }
}
