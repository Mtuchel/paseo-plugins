import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isActivationPath, MAX_ACTIVATION_BODY_BYTES } from "./activation";
import { decisionPage } from "./decision-page";
import { backendSecretPath, headerValue, INBOX_AUTH_HEADER, INBOX_BACKEND_PORT, INBOX_FRONTDOOR_PORT, INBOX_INSTANCE_HEADER, INBOX_DISPLAYED_HEADER, INBOX_PROTOCOL_VERSION, readBackendSecret, type InboxAvailability, type InboxBackendState, type InboxSnapshot } from "./inbox-transport";
import { closedPage, inboxPage, MANIFEST, SERVICE_WORKER, type InboxView } from "./review-page";
import { REVIEW_ICON_PNG } from "./review-icon";
import type { DecisionView } from "../shared/decision-inbox";
import { summarizeDecisions } from "../shared/decision-summary";
import { mergeStatusSchema } from "../shared/merge-status";

// The persistent inbox frontdoor (README, "Inbox transport"): a stand-alone process, supervised by
// launchd or systemd --user (tools/inbox-service-install.mjs), that owns the browser-facing
// loopback port 127.0.0.1:47832 and the host's tailnet origin :8444, so the review and decision
// pages stay reachable while the plugin is reloading. It renders the existing pages from the last
// snapshot the checked backend (127.0.0.1:47834) served, clearly marked stale -- and read-only --
// until a live snapshot from the currently ready backend replaces it, and forwards the browser's
// existing mutations exactly once to the plugin's unchanged, checked handlers. It decides nothing:
// no ledger, no permission logic, no second writer.
//
// Everything the frontdoor keeps on disk is its own validated snapshot cache, atomically replaced
// under a 0700 directory with 0600 files. A cache loaded from disk always starts stale, so a
// restart can never present yesterday's inbox as current.

const MAX_BODY_BYTES = 16_384;
// One JSON answer from the backend (the inbox and decision views).
const MAX_JSON_BYTES = 16 * 1024 * 1024;
// Immutable Plannotator bundles are tens of MB (review-bundle.ts); keep a few of them, bounded.
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_ASSET_CACHE_BYTES = 96 * 1024 * 1024;
const CACHE_VERSION = 1;
// A failed snapshot is retried no sooner than this (the readiness probe's own cadence).
const MIN_SNAPSHOT_GAP_MS = 2_000;
// Headers a hop never forwards: framing is this process's to set, and the private fence headers
// are the frontdoor's own (a caller-supplied copy is stripped, never passed through).
const HOP_BY_HOP: Record<string, true> = { connection: true, "keep-alive": true, "proxy-authenticate": true, "proxy-authorization": true, te: true, trailer: true, "transfer-encoding": true, upgrade: true, expect: true, "content-length": true, [INBOX_AUTH_HEADER]: true, [INBOX_INSTANCE_HEADER]: true };
const MUTATION = /^\/api\/reviews\/([^/]+)\/(decision|recheck|delete|resolve)$/;

export type InboxFrontdoorOptions = {
  // 127.0.0.1:47832: the port the installer publishes on the tailnet origin.
  port?: number;
  // 127.0.0.1:47834: the plugin's checked inbox backend.
  backendPort?: number;
  // The unchanged public origin, https://<machine>.<tailnet>.ts.net:8444. Required: it is the
  // mutation host allowlist and what the cache record is scoped to.
  publicOrigin: string;
  // The frontdoor's own state: the snapshot cache lives here (0700 directory, 0600 files).
  stateDirectory: string;
  // The private credential both processes share (inbox-transport.ts).
  credentialFile?: string;
  // The time zone the pages show clock times and days in; the host's when absent.
  timeZone?: string;
  // How long a live snapshot counts as current before a page load or availability check refreshes
  // it, and how often the readiness probe may run, with their deadlines.
  refreshMs?: number;
  probeMs?: number;
  probeDeadlineMs?: number;
  snapshotDeadlineMs?: number;
  // Browser mutations: long enough for the existing 65-second peer decision deadline.
  mutationDeadlineMs?: number;
  readDeadlineMs?: number;
  assetDeadlineMs?: number;
  assetCacheBytes?: number;
  now?: () => Date;
};

export type InboxFrontdoor = { readonly port: number; close(): Promise<void> };

type Answer = { status: number; headers?: Record<string, string>; body?: string | Buffer };
type BackendState = InboxBackendState | "unavailable";
type Upstream = { status: number; headers: IncomingHttpHeaders; body: Buffer };

const json = (status: number, value: unknown): Answer => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(value) });
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The snapshot the backend composes (inbox-backend.ts). Validated at the boundary: a corrupt,
// incompatible or differently scoped answer is refused, never cached or rendered.
const rowSchema = z.object({ agentId: z.string(), name: z.string(), link: z.string(), since: z.string(), host: z.string() }).loose();
const inboxViewSchema = z.object({ open: z.array(rowSchema), decided: z.array(rowSchema), applying: z.array(rowSchema), unreachable: z.array(z.string()), hosts: z.array(z.string()), push: z.boolean(), pipeline: z.unknown().optional() }).loose();
const decisionViewSchema = z.object({
  hosts: z.array(z.object({ host: z.string(), asks: z.array(z.unknown()), live: z.array(z.unknown()), history: z.array(z.unknown()), updatedAt: z.string(), error: z.string().nullable(), mergeStatus: mergeStatusSchema.optional() }).loose()),
  canonicalHost: z.string().nullable(), unreachable: z.array(z.string()),
}).loose();
const snapshotSchema = z.object({ protocolVersion: z.literal(INBOX_PROTOCOL_VERSION), instanceId: z.string().min(1), capturedAt: z.string().min(1), inbox: inboxViewSchema, decisions: decisionViewSchema }).loose();
const readySchema = z.object({ protocolVersion: z.literal(INBOX_PROTOCOL_VERSION), instanceId: z.string().min(1), state: z.enum(["starting", "ready", "draining"]) }).loose();
const cacheSchema = z.object({ version: z.literal(CACHE_VERSION), origin: z.string(), storedAt: z.string(), protocolVersion: z.literal(INBOX_PROTOCOL_VERSION), instanceId: z.string().min(1), capturedAt: z.string().min(1), inbox: inboxViewSchema, decisions: decisionViewSchema }).loose();

function parseJsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

class Frontdoor implements InboxFrontdoor {
  // The port this frontdoor actually answers on: LOOPBACK_PORT in production, and whatever the
  // kernel picked when a caller asks for 0 (the tests).
  port: number;
  private readonly backendPort: number;
  private readonly publicHost: string;
  private readonly publicOrigin: string;
  private readonly stateDirectory: string;
  private readonly snapshotPath: string;
  private readonly credentialFile: string;
  private readonly timeZone: string | undefined;
  private readonly refreshMs: number;
  private readonly probeMs: number;
  private readonly probeDeadlineMs: number;
  private readonly snapshotDeadlineMs: number;
  private readonly mutationDeadlineMs: number;
  private readonly readDeadlineMs: number;
  private readonly assetDeadlineMs: number;
  private readonly assetCacheBytes: number;
  private readonly now: () => Date;
  private server: Server | null = null;
  private cache: { snapshot: InboxSnapshot; storedAt: number } | null = null;
  // What the last probe and snapshot attempt made of the backend. `fresh` is true only right after
  // a live snapshot from the currently ready instance: every other combination is stale.
  private state: { state: BackendState; instanceId: string | null; reason: string | null } = { state: "unavailable", instanceId: null, reason: null };
  private fresh = false;
  private lastProbeAt = 0;
  private lastSnapshotAt = 0;
  private lastSnapshotAttemptAt = 0;
  private flight: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly assets = new Map<string, { bytes: Buffer; type: string; encoding: string | null; cacheControl: string; cors: string; vary: string }>();
  private assetBytes = 0;
  private closed = false;

  constructor(options: InboxFrontdoorOptions) {
    const origin = (() => {
      try { return new URL(options.publicOrigin); } catch { throw new Error(`The inbox frontdoor's publicOrigin is not a URL: ${options.publicOrigin}`); }
    })();
    if (origin.protocol !== "https:" || !origin.host || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
      throw new Error(`The inbox frontdoor's publicOrigin must be an https origin without a path, e.g. https://host.tailnet.ts.net:8444 (got ${options.publicOrigin}).`);
    }
    if (!options.stateDirectory) throw new Error("The inbox frontdoor needs a stateDirectory for its snapshot cache.");
    this.publicOrigin = origin.origin;
    this.publicHost = origin.host;
    this.port = options.port ?? INBOX_FRONTDOOR_PORT;
    this.backendPort = options.backendPort ?? INBOX_BACKEND_PORT;
    this.stateDirectory = options.stateDirectory;
    this.snapshotPath = join(this.stateDirectory, "snapshot.json");
    this.credentialFile = options.credentialFile ?? backendSecretPath();
    this.timeZone = options.timeZone;
    this.refreshMs = options.refreshMs ?? 30_000;
    this.probeMs = options.probeMs ?? 2_000;
    this.probeDeadlineMs = options.probeDeadlineMs ?? 2_000;
    this.snapshotDeadlineMs = options.snapshotDeadlineMs ?? 5_000;
    this.mutationDeadlineMs = options.mutationDeadlineMs ?? 90_000;
    this.readDeadlineMs = options.readDeadlineMs ?? 15_000;
    this.assetDeadlineMs = options.assetDeadlineMs ?? 30_000;
    this.assetCacheBytes = options.assetCacheBytes ?? DEFAULT_ASSET_CACHE_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await this.loadCache();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      const limit = isActivationPath(request.url ?? "") ? MAX_ACTIVATION_BODY_BYTES : MAX_BODY_BYTES;
      request.on("data", (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        // The same limits the plugin serves: the activation routes keep their larger one. The
        // refusal is written before the socket closes and the request is drained, so a caller
        // streaming an oversize body reads the 413 instead of an opaque reset.
        if (size > limit) {
          refused = true;
          response.writeHead(413, { connection: "close" }).end();
          request.on("end", () => request.destroy());
          request.resume();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (refused || response.headersSent) return;
        const target = request.url ?? "/";
        void this.respond(request.method ?? "GET", target, request.headers, Buffer.concat(chunks).toString("utf8")).then((answer) => {
          response.writeHead(answer.status, { "cache-control": "no-store", ...answer.headers }).end(answer.body ?? "");
        }, (error: unknown) => {
          console.error(`[inbox-frontdoor] request failed: ${reasonOf(error)}`);
          if (!response.headersSent) response.writeHead(500).end();
        });
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    }).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === "EADDRINUSE"
        ? `127.0.0.1:${this.port} is already in use; the current owner (a plugin still serving the inbox) was not touched, and no other port was chosen.`
        : `The inbox frontdoor could not listen on 127.0.0.1:${this.port}: ${reasonOf(error)}`);
    });
    const bound = server.address();
    if (typeof bound === "object" && bound) this.port = bound.port;
    // A first bounded read, so a page load right after a restart finds current data; the request
    // path never waits for it.
    void this.freshen().catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    // An admitted snapshot read may enqueue its cache write after close starts.
    await this.flight?.catch(() => {});
    await this.writes.catch(() => {});
  }

  // ------------------------------------------------------------------------------------------
  // The data the pages are rendered from
  // ------------------------------------------------------------------------------------------

  // Probes the backend when the last check is due and refreshes the snapshot when it is missing,
  // stale or older than `refreshMs`; every caller shares one in-flight read. `force` skips the
  // retry gap for a read an owner's action is waiting on.
  private async freshen(force = false): Promise<void> {
    if (this.closed) return;
    if (this.flight) return this.flight;
    const now = Date.now();
    const probeDue = now - this.lastProbeAt >= this.probeMs;
    // Partial host coverage is a live snapshot, not a backend outage. Recheck it soon so
    // completed background peer reads are published before their own cache expires.
    const incomplete = this.cache?.snapshot.inbox.unreachable.length || this.cache?.snapshot.decisions.unreachable.length;
    const refreshMs = incomplete ? Math.min(this.refreshMs, MIN_SNAPSHOT_GAP_MS) : this.refreshMs;
    const snapshotDue = !this.fresh || now - this.lastSnapshotAt >= refreshMs;
    if (!probeDue && !snapshotDue) return;
    const flight = (async () => {
      if (probeDue) {
        const probe = await this.probe();
        this.lastProbeAt = Date.now();
        const changed = probe.instanceId !== this.state.instanceId || probe.state !== this.state.state;
        this.state = probe;
        if (probe.state !== "ready" || changed || probe.instanceId !== this.cache?.snapshot.instanceId) this.fresh = false;
      }
      if (this.state.state !== "ready" || this.fresh && Date.now() - this.lastSnapshotAt < refreshMs) return;
      if (!force && Date.now() - this.lastSnapshotAttemptAt < MIN_SNAPSHOT_GAP_MS) return;
      this.lastSnapshotAttemptAt = Date.now();
      const snapshot = await this.fetchSnapshot();
      if (!snapshot) {
        this.fresh = false;
        if (this.state.state === "ready") this.state = { ...this.state, reason: "The last live read failed; the page shows the last received snapshot." };
        return;
      }
      this.cache = { snapshot, storedAt: Date.now() };
      this.fresh = true;
      this.lastSnapshotAt = Date.now();
      this.state = { state: "ready", instanceId: snapshot.instanceId, reason: null };
      await this.writeCache(snapshot);
    })().finally(() => { this.flight = null; });
    this.flight = flight;
    return flight;
  }

  // The current page envelope: only a live snapshot from the currently ready instance is not
  // stale, and `readOnly` follows `stale` exactly.
  private availability(): InboxAvailability {
    const snapshot = this.cache?.snapshot ?? null;
    const stale = !this.fresh;
    return {
      protocolVersion: INBOX_PROTOCOL_VERSION,
      backendState: this.state.state,
      instanceId: this.state.instanceId ?? snapshot?.instanceId ?? null,
      displayedInstanceId: snapshot?.instanceId ?? null,
      capturedAt: snapshot?.capturedAt ?? null,
      lastCheckedAt: this.lastSnapshotAt ? new Date(this.lastSnapshotAt).toISOString() : null,
      stale,
      readOnly: stale,
      reason: stale ? this.staleReason(snapshot) : null,
    };
  }

  private staleReason(snapshot: InboxSnapshot | null): string | null {
    if (this.state.state === "unavailable") return this.state.reason ?? `No checked inbox backend answered on 127.0.0.1:${this.backendPort}.`;
    if (this.state.state === "starting") return "The checked inbox backend is still starting.";
    if (this.state.state === "draining") return "The checked inbox backend is draining for a reload.";
    if (snapshot && snapshot.instanceId !== this.state.instanceId) return "The checked inbox backend was replaced; this page was composed against the previous one.";
    return this.state.reason ?? "No live snapshot has been received since this service started.";
  }

  // The credentials are re-read per use: the plugin may create the file after this service started.
  private secret(): Promise<string | null> {
    return readBackendSecret(this.credentialFile);
  }

  private loopbackHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { host: `127.0.0.1:${this.backendPort}`, accept: "application/json", "accept-encoding": "identity", ...extra };
  }

  private async probe(): Promise<{ state: BackendState; instanceId: string | null; reason: string | null }> {
    const secret = await this.secret();
    if (!secret) return { state: "unavailable", instanceId: null, reason: `No inbox backend credential exists yet at ${this.credentialFile}.` };
    const answer = await this.upstream("GET", "/_inbox/ready", this.loopbackHeaders({ [INBOX_AUTH_HEADER]: secret }), null, this.probeDeadlineMs);
    if (!answer.response) return { state: "unavailable", instanceId: null, reason: `No checked inbox backend answered on 127.0.0.1:${this.backendPort} (${reasonOf(answer.error)}).` };
    if (answer.response.status === 401) return { state: "unavailable", instanceId: null, reason: "The checked inbox backend refused this service's private credential." };
    if (answer.response.status !== 200) return { state: "unavailable", instanceId: null, reason: `The checked inbox backend answered HTTP ${answer.response.status} to a readiness check.` };
    const parsed = readySchema.safeParse(parseJsonObject(answer.response.body));
    if (!parsed.success) return { state: "unavailable", instanceId: null, reason: `The readiness answer does not speak inbox protocol ${INBOX_PROTOCOL_VERSION}.` };
    return {
      state: parsed.data.state,
      instanceId: parsed.data.instanceId,
      reason: parsed.data.state === "ready" ? null : parsed.data.state === "starting" ? "The checked inbox backend is still starting." : "The checked inbox backend is draining for a reload.",
    };
  }

  private async fetchSnapshot(): Promise<InboxSnapshot | null> {
    const secret = await this.secret();
    if (!secret) return null;
    const answer = await this.upstream("GET", "/_inbox/snapshot", this.loopbackHeaders({ [INBOX_AUTH_HEADER]: secret }), null, this.snapshotDeadlineMs);
    if (!answer.response || answer.response.status !== 200) return null;
    const parsed = snapshotSchema.safeParse(parseJsonObject(answer.response.body));
    if (!parsed.success) {
      console.error(`[inbox-frontdoor] refusing an inbox snapshot that does not match protocol ${INBOX_PROTOCOL_VERSION}`);
      return null;
    }
    // The envelope is validated above; the nested views are the shapes the pages render and the
    // backend's own types (inbox-backend.ts).
    const snapshot: InboxSnapshot = parsed.data as InboxSnapshot;
    return snapshot;
  }

  // ------------------------------------------------------------------------------------------
  // The public dispatcher
  // ------------------------------------------------------------------------------------------

  private async respond(method: string, target: string, headers: IncomingHttpHeaders, body: string): Promise<Answer> {
    // Routing and forwarding use the origin-form of whatever the request line carried: a caller
    // cannot put a scheme or an authority into what the backend is asked for, and the backend is
    // always 127.0.0.1:47834.
    const parsed = new URL(target, `http://127.0.0.1:${this.backendPort}`);
    const path = parsed.pathname;
    const originForm = `${parsed.pathname}${parsed.search}`;
    // The private backend routes are never part of the public surface, with or without a path
    // suffix: only this process talks to 127.0.0.1:47834.
    if (path === "/_inbox" || path.startsWith("/_inbox/")) return { status: 404 };
    // The activation protocol keeps its exact routes, methods, headers and body: it is forwarded
    // whole and its authentication stays in the backend.
    if (isActivationPath(path)) return this.forward("activation", method, originForm, headers, body);
    // Browser mutations: the same origin, custom-header and JSON checks the backend enforces,
    // then one forwarded attempt with the instance this page was displayed from.
    if (MUTATION.test(path) || path === "/api/decisions/action" || path === "/api/push/subscribe") {
      const refused = this.mutationGuard(method, headers);
      if (refused) return refused;
      return this.forwardMutation(method, originForm, headers, body);
    }
    if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { allow: "GET" } };
    if (path === "/" || path === "/decisions") return this.page(path);
    if (path === "/api/inbox/availability") {
      await this.freshen();
      return json(200, this.availability());
    }
    if (path === "/api/decisions") {
      await this.freshen();
      const view: DecisionView = this.cache?.snapshot.decisions ?? { hosts: [], canonicalHost: null, unreachable: [] };
      // Availability metadata sits beside the view's own fields, never inside a host object: the
      // existing clients and the strict peer schemas keep their shape.
      const availability = this.availability();
      const summary = summarizeDecisions(view, this.now().getTime());
      if (availability.stale || availability.readOnly || availability.backendState !== "ready") {
        summary.complete = false;
        summary.coverageComplete = false;
        summary.reasons.push(availability.reason || "The inbox backend is not ready.");
      }
      return json(200, { ...view, summary, availability });
    }
    // Source review pages and recovery evidence are read live from the backend with their query,
    // never from the snapshot: only the owning host can answer them (decision-inbox.ts).
    if (path === "/api/inbox" || path === "/api/decisions/local" || path === "/api/decisions/reviews" || path === "/api/decisions/reviews/local"
      || path === "/api/decisions/flow" || path === "/api/decisions/flow/local" || path === "/api/push/key") return this.forward("read", method, originForm, headers, null);
    if (path === "/manifest.webmanifest") return { status: 200, headers: { "content-type": "application/manifest+json" }, body: MANIFEST };
    if (path === "/sw.js") return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "service-worker-allowed": "/" }, body: SERVICE_WORKER };
    if (path === "/icon.png") return { status: 200, headers: { "content-type": "image/png" }, body: REVIEW_ICON_PNG };
    if (/^\/plannotator\/[0-9a-f]{64}\.(?:js|css)$/.test(path)) return this.asset(method, originForm, headers);
    const review = /^\/review\/([^/]+)\/?$/.exec(path);
    if (review) return this.review(method, originForm, headers);
    return { status: 404 };
  }

  private mutationGuard(method: string, headers: IncomingHttpHeaders): Answer | null {
    if (method !== "POST") return { status: 405, headers: { allow: "POST" } };
    const host = String(headers.host ?? "");
    // The published origin or this listener's own loopback name; nothing else may drive a mutation.
    if (host !== this.publicHost && host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return json(403, { error: "Not allowed." });
    let sameOrigin = !headers.origin;
    try { if (headers.origin) sameOrigin = new URL(String(headers.origin)).host === host; } catch { sameOrigin = false; }
    if (headers["x-review-action"] !== "1" || !String(headers["content-type"] ?? "").startsWith("application/json") || !sameOrigin) return json(403, { error: "Not allowed." });
    return null;
  }

  private async page(path: string): Promise<Answer> {
    await this.freshen();
    const availability = this.availability();
    const snapshot = this.cache?.snapshot ?? null;
    const body = path === "/"
      ? inboxPage(snapshot?.inbox ?? { open: [], decided: [], applying: [], unreachable: [], hosts: [], push: false }, this.now(), this.timeZone, availability)
      : decisionPage(snapshot?.decisions ?? { hosts: [], canonicalHost: null, unreachable: [] }, availability);
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body };
  }

  // ------------------------------------------------------------------------------------------
  // Forwarding
  // ------------------------------------------------------------------------------------------

  // Headers a forwarded request keeps: the original Host and Origin (the backend's own checks
  // compare them), the custom action header, the activation secret, and the content negotiation
  // the caller asked for. Hop-by-hop headers and caller-supplied copies of the private fence
  // headers never pass.
  private forwardHeaders(headers: IncomingHttpHeaders, extra: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || HOP_BY_HOP[name.toLowerCase()] || name.toLowerCase() === INBOX_DISPLAYED_HEADER) continue;
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return { ...out, ...extra };
  }

  // Executor form: the plugin's TypeScript lib (ES2023) predates Promise.withResolvers.
  private upstream(method: string, target: string, headers: Record<string, string>, body: Buffer | null, deadlineMs: number, limit = MAX_JSON_BYTES): Promise<{ response: Upstream | null; error: Error | null }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { response: Upstream | null; error: Error | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const request = httpRequest({ host: "127.0.0.1", port: this.backendPort, method, path: target, headers }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) { request.destroy(new Error(`the answer exceeded ${limit} bytes`)); return; }
          chunks.push(chunk);
        });
        response.on("end", () => finish({ response: { status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }, error: null }));
        response.on("error", (error: Error) => finish({ response: null, error }));
      });
      const timer = setTimeout(() => request.destroy(new Error(`the deadline of ${deadlineMs} ms passed`)), deadlineMs);
      request.on("error", (error: Error) => finish({ response: null, error }));
      request.end(body ?? undefined);
    });
  }

  private passthrough(upstream: Upstream): Answer {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || HOP_BY_HOP[name.toLowerCase()] || name.toLowerCase() === "content-length") continue;
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return { status: upstream.status, headers, body: upstream.body };
  }

  // One forwarded attempt, no retry middleware and no redirect following: a lost answer after the
  // backend was asked is an unknown outcome (the browsers lock their controls on it), and only the
  // frontdoor's own pre-dispatch refusals say that nothing was sent.
  private async forwardMutation(method: string, target: string, headers: IncomingHttpHeaders, body: string): Promise<Answer> {
    // The page's displayed epoch, captured before any await: admission compares this exact value
    // and the backend is asked to admit the same one. A poll or another tab that captured a
    // replacement backend in the meantime cannot rebind an action composed against the old one.
    const displayed = String(headers[INBOX_DISPLAYED_HEADER] ?? "").trim();
    const admission = await this.admission(displayed);
    if (admission) return admission;
    const secret = await this.secret();
    const outgoing = this.forwardHeaders(headers, { host: String(headers.host ?? this.publicHost), [INBOX_AUTH_HEADER]: secret ?? "", [INBOX_INSTANCE_HEADER]: displayed });
    const answer = await this.upstream(method, target, outgoing, Buffer.from(body, "utf8"), this.mutationDeadlineMs);
    this.invalidate();
    if (!answer.response) return json(502, { error: `The checked inbox backend did not answer; the action's outcome is unknown and it was not retried: ${reasonOf(answer.error)}`, outcomeUnknown: true });
    if (!parseJsonObject(answer.response.body)) return json(502, { error: `The checked inbox backend's answer could not be read; the action's outcome is unknown and it was not retried (HTTP ${answer.response.status}).`, outcomeUnknown: true });
    return this.passthrough(answer.response);
  }

  // The backend must be ready right now, the displayed snapshot must be live and from that same
  // instance; a replaced backend refuses here rather than receiving an action composed against its
  // predecessor.
  private async admission(displayed: string): Promise<Answer | null> {
    const probe = await this.probe();
    this.lastProbeAt = Date.now();
    const changed = probe.instanceId !== this.state.instanceId || probe.state !== this.state.state;
    this.state = probe;
    if (probe.state !== "ready" || changed || probe.instanceId !== this.cache?.snapshot.instanceId) this.fresh = false;
    if (!displayed) return json(409, { error: "This page does not say which checked backend its data came from. Nothing was sent; reload the page and try again." });
    if (probe.state === "unavailable") return json(503, { error: `${probe.reason ?? "The checked inbox backend is unreachable."} Nothing was sent.` });
    if (probe.state !== "ready") return json(503, { error: `${probe.reason ?? "The checked inbox backend is not ready."} Nothing was sent.` });
    if (probe.instanceId !== displayed) return json(409, { error: "This page was displayed from a different checked backend instance than the one that is ready now, so its action cannot be applied to what it shows. Nothing was sent; reload the page and try again." });
    // Only page loads and availability checks on this host refresh the snapshot, and a peer inbox
    // forwards actions without either: after a plugin reload this snapshot is still the previous
    // instance's. Read the ready one live now (a shared in-flight read first, then a fresh one)
    // rather than refusing every action until someone opens this host's own page.
    if (!this.fresh || this.cache?.snapshot.instanceId !== displayed) {
      await this.flight?.catch(() => {});
      if (!this.fresh || this.cache?.snapshot.instanceId !== displayed) await this.freshen(true).catch(() => {});
    }
    if (!this.fresh || !this.cache || this.cache.snapshot.instanceId !== displayed) return json(409, { error: "This page's snapshot is not current: it was not received from the backend that is ready now. Nothing was sent; refresh the page and try again." });
    return null;
  }

  private async forward(kind: "activation" | "read", method: string, target: string, headers: IncomingHttpHeaders, body: string | null): Promise<Answer> {
    const answer = await this.upstream(method, target, this.forwardHeaders(headers, { host: String(headers.host ?? this.publicHost) }), body === null ? null : Buffer.from(body, "utf8"), this.readDeadlineMs);
    if (!answer.response) {
      return json(503, { error: kind === "activation"
        ? (method === "POST" || method === "PUT" || method === "DELETE"
          ? `The activation service did not confirm this request (${reasonOf(answer.error)}); it was sent, so it may have been received and the outcome is unconfirmed. Nothing is retried automatically, and the activation service's receipts make an explicit repeat safe if the sender's own protocol asks for one.`
          : `The activation service is unavailable on this host; this read was refused before it was dispatched (${reasonOf(answer.error)}).`)
        : `The checked inbox backend is unavailable (${reasonOf(answer.error)}).` });
    }
    return this.passthrough(answer.response);
  }

  // A review link forwards the checked redirect/closed-page answer; while the plugin is away it
  // serves a labelled card instead of replaying a cached redirect to a possibly replaced review.
  private async review(method: string, target: string, headers: IncomingHttpHeaders): Promise<Answer> {
    const answer = await this.upstream(method, target, this.forwardHeaders(headers, { host: String(headers.host ?? this.publicHost) }), null, this.readDeadlineMs);
    if (!answer.response) {
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: closedPage(undefined, "unavailable") };
    }
    return this.passthrough(answer.response);
  }

  // Immutable Plannotator bundles (their names are content hashes): forwarded while the plugin is
  // there, and retained across reloads within a bounded budget. An uncached asset while the
  // plugin is absent cannot be manufactured.
  private async asset(method: string, target: string, headers: IncomingHttpHeaders): Promise<Answer> {
    const name = target.split("?", 1)[0];
    const accepted = /\bbr\b/i.test(String(headers["accept-encoding"] ?? "")) ? "br" : null;
    const answer = await this.upstream(method, target, this.forwardHeaders(headers, { host: String(headers.host ?? this.publicHost) }), null, this.assetDeadlineMs, MAX_ASSET_BYTES);
    if (answer.response && answer.response.status === 200) {
      const type = String(answer.response.headers["content-type"] ?? "application/octet-stream");
      const encoding = String(answer.response.headers["content-encoding"] ?? "") || null;
      this.remember(name, { bytes: answer.response.body, type, encoding, cacheControl: String(answer.response.headers["cache-control"] ?? "public, max-age=31536000, immutable"), cors: String(answer.response.headers["access-control-allow-origin"] ?? "*"), vary: String(answer.response.headers.vary ?? "Accept-Encoding") });
      return this.passthrough(answer.response);
    }
    if (answer.response) return this.passthrough(answer.response);
    const wanted = this.assets.get(`${name}\u0000${accepted ?? ""}`) ?? this.assets.get(`${name}\u0000`);
    if (!wanted) return json(503, { error: `This immutable asset is not cached yet and the inbox backend is unavailable (${reasonOf(answer.error)}).` });
    return { status: 200, headers: { "content-type": wanted.type, "cache-control": wanted.cacheControl, "access-control-allow-origin": wanted.cors, vary: wanted.vary, ...(wanted.encoding ? { "content-encoding": wanted.encoding } : {}) }, body: wanted.bytes };
  }

  private remember(name: string, file: { bytes: Buffer; type: string; encoding: string | null; cacheControl: string; cors: string; vary: string }): void {
    this.assets.set(`${name}\u0000${file.encoding ?? ""}`, file);
    this.assetBytes += file.bytes.length;
    for (const [key, kept] of this.assets) {
      if (this.assetBytes <= this.assetCacheBytes) break;
      if (key === `${name}\u0000${file.encoding ?? ""}`) continue;
      this.assets.delete(key);
      this.assetBytes -= kept.bytes.length;
    }
  }

  // A confirmed or uncertain attempt invalidates the displayed cache: the next page load and
  // availability check read the backend again instead of showing what was there before the action.
  private invalidate(): void {
    this.fresh = false;
    this.lastSnapshotAt = 0;
    this.lastSnapshotAttemptAt = 0;
    void this.freshen().catch(() => {});
  }

  // ------------------------------------------------------------------------------------------
  // The snapshot cache
  // ------------------------------------------------------------------------------------------

  private async loadCache(): Promise<void> {
    try {
      const record = cacheSchema.safeParse(JSON.parse(await readFile(this.snapshotPath, "utf8")) as unknown);
      if (!record.success) { console.error("[inbox-frontdoor] ignoring a snapshot cache that does not match this version or protocol"); return; }
      if (record.data.origin !== this.publicOrigin) { console.error(`[inbox-frontdoor] ignoring a snapshot cache scoped to ${record.data.origin}`); return; }
      this.cache = { snapshot: { protocolVersion: record.data.protocolVersion, instanceId: record.data.instanceId, capturedAt: record.data.capturedAt, inbox: record.data.inbox as InboxView, decisions: record.data.decisions as DecisionView }, storedAt: Date.parse(record.data.storedAt) || Date.now() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[inbox-frontdoor] reading the snapshot cache failed: ${reasonOf(error)}`);
    }
  }

  // Atomic replacement under a 0700 directory with a 0600 file; the cached snapshot is never
  // presented as current on load anyway.
  private writeCache(snapshot: InboxSnapshot): Promise<void> {
    const record = JSON.stringify({ version: CACHE_VERSION, origin: this.publicOrigin, storedAt: new Date().toISOString(), ...snapshot });
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.snapshotPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.snapshotPath), 0o700).catch(() => {});
      const temporary = `${this.snapshotPath}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, record, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.snapshotPath);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    }).catch((error: unknown) => { console.error(`[inbox-frontdoor] writing the snapshot cache failed: ${reasonOf(error)}`); });
    this.writes = write;
    return write;
  }
}

export async function startInboxFrontdoor(options: InboxFrontdoorOptions): Promise<InboxFrontdoor> {
  const frontdoor = new Frontdoor(options);
  await frontdoor.start();
  return frontdoor;
}
