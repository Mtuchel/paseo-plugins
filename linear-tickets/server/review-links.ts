import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isActivationPath, MAX_ACTIVATION_BODY_BYTES, type ActivationRoute } from "./activation";
import { FUNNEL_PORT } from "./funnel";
import { plannotatorPaths, readReviewPlan, type OpenedEvent } from "./plannotator";
import { ReviewBundles } from "./review-bundle";
import { REVIEW_ICON_PNG } from "./review-icon";
import { closedPage, inboxPage, MANIFEST, planDetails, SERVICE_WORKER, type InboxRow, type InboxView, type PlanDetails } from "./review-page";
import { createReviewProxy } from "./review-proxy";
import { pushSubscription, ReviewPush, type PushSend } from "./review-push";
import { tailscaleBinary } from "./tailscale";

const exec = promisify(execFile);
export const REVIEW_PORT = 47_832;
// The compressing proxy every review's tailnet route points at (review-proxy.ts).
export const REVIEW_PROXY_PORT = 47_833;
// Tailnet-only (`tailscale serve`, never Funnel): 8443 stays the public webhook.
export const REVIEW_SERVE_PORT = 8444;
const SWEEP_MS = 30_000;
const MISSES_TO_CLOSE = 2;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
const RECENT_DECISIONS = 10;
const PEER_TIMEOUT_MS = 4_000;
const MAX_BODY_BYTES = 16_384;
const MAX_FEEDBACK_CHARS = 4_000;

export type ReviewOutcome = "approved" | "sent back";
export type ReviewEntry = {
  agentId: string;
  localUrl: string;
  remoteUrl: string | null;
  identifier?: string;
  openedAt: string;
  // When the owner first got this plan, for a review served again (see `opened`).
  since?: string;
  // The model that wrote the plan.
  model?: string;
  outcome?: ReviewOutcome;
  closedAt?: string;
  details?: PlanDetails;
};
type Registry = Record<string, ReviewEntry>;

// Decides an open review as the owner would on its page (Approve / Send back with a note).
export type DecideReview = (localUrl: string, approve: boolean, feedback: string, agentId: string) => Promise<void>;

export type ReviewLinksOptions = {
  port?: number;
  file?: string;
  sweepMs?: number;
  now?: () => Date;
  // Whether the review's own Plannotator server still answers.
  alive?: (localUrl: string) => Promise<boolean>;
  // Publishes the local port on :8444 and returns the tailnet origin, or null.
  serve?: (localPort: number) => Promise<string | null>;
  // Removes one per-review tailnet route.
  unserve?: (port: number) => Promise<void>;
  // Points one review's tailnet route at the compressing proxy.
  route?: (port: number, proxyPort: number) => Promise<void>;
  proxyPort?: number;
  // The plan text of a running review (Plannotator's /api/plan); "" when it cannot be read.
  fetchPlan?: (localUrl: string) => Promise<string>;
  // The time zone the inbox shows clock times and days in; the host's when absent.
  timeZone?: string;
  // This host's name on inbox rows when the inbox lists several hosts.
  host?: string;
  // Other hosts' inbox origins, read on every inbox load (settings `reviewPeers`).
  peers?: () => Promise<string[]>;
  decide?: DecideReview;
  // The Linear workspace's web address (https://linear.app/<urlKey>), for the rows' ticket links.
  linearWorkspace?: () => Promise<string>;
  // Web Push: where its keys and subscriptions are kept, and how a message is sent (tests).
  pushFile?: string;
  sendPush?: PushSend;
  // Draining a host: the /activation* routes this server also answers (activation-endpoints.ts).
  routes?: ActivationRoute;
};

class DecisionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function backendAlive(localUrl: string): Promise<boolean> {
  try {
    // Any HTTP answer means the review server is up; only a refused or hung connection is "dead".
    await fetch(`${new URL(localUrl).origin}/`, { signal: AbortSignal.timeout(3_000) });
    return true;
  } catch { return false; }
}

async function serveReviews(localPort: number): Promise<string | null> {
  const { stdout, stderr } = await exec(tailscaleBinary(), ["serve", "--bg", `--https=${REVIEW_SERVE_PORT}`, `http://127.0.0.1:${localPort}`], { timeout: 12_000 });
  return `${stdout}\n${stderr}`.match(new RegExp(`https://[^\\s/]+:${REVIEW_SERVE_PORT}\\b`))?.[0] ?? null;
}

async function unserveReview(port: number): Promise<void> {
  await exec(tailscaleBinary(), ["serve", `--https=${port}`, "off"], { timeout: 12_000 });
}

async function routeReview(port: number, proxyPort: number): Promise<void> {
  await exec(tailscaleBinary(), ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${proxyPort}`], { timeout: 12_000 });
}

// The tailnet port of a review's route; null for the ports this plugin must never touch.
function reviewPort(remoteUrl: string | null): number | null {
  const port = remoteUrl ? Number(new URL(remoteUrl).port) : 0;
  return port && port !== FUNNEL_PORT && port !== REVIEW_SERVE_PORT ? port : null;
}

// When the owner got the plan: what the inbox shows, sorts and groups waiting reviews by.
function waitingSince(entry: ReviewEntry): string {
  return entry.since ?? entry.openedAt;
}

function outcomeText(entry: ReviewEntry): string {
  if (entry.outcome === "approved" && entry.details?.autoApproved) return "auto-approved";
  return entry.outcome ?? "ended";
}

const text = (max: number) => z.string().max(max);
const PeerDetails = z.object({
  title: text(2_000).nullable(),
  summary: text(2_000).nullable(),
  risk: z.object({ impact: z.number(), text: text(500) }).nullable(),
  reasons: z.array(text(500)).optional(),
  autoApproved: z.boolean().optional(),
  followUps: z.number().optional(),
  newRule: z.boolean().optional(),
});
// One row of a peer's /api/inbox: links are web links, ticket links point at Linear.
const PeerRow = z.object({
  agentId: z.string().regex(AGENT_ID),
  name: text(200),
  link: text(2_000).regex(/^https?:\/\//),
  since: text(40).refine((value) => !Number.isNaN(Date.parse(value))),
  outcome: text(40).optional(),
  decidedAt: text(40).optional(),
  details: PeerDetails.optional(),
  model: text(200).optional(),
  issueUrl: text(2_000).regex(/^https:\/\/linear\.app\//).optional(),
});
const PeerInbox = z.object({ host: text(100), open: z.array(z.unknown()), decided: z.array(z.unknown()) });
const DecisionRequest = z.object({ approve: z.boolean(), feedback: z.string().optional() });
const ErrorAnswer = z.object({ error: z.string() });

// A peer's rows; a row this inbox could not render is left out, not the whole peer.
function peerRows(rows: unknown[], host: string): InboxRow[] {
  return rows.flatMap((raw) => {
    const parsed = PeerRow.safeParse(raw);
    return parsed.success ? [{ ...parsed.data, host }] : [];
  });
}

// A peer's name before it answered: its machine name (server087.<tailnet>.ts.net → server087), or
// the whole host for an address.
function peerName(origin: string): string {
  const { hostname, host } = new URL(origin);
  return /^[\d.]+$|:/.test(hostname) ? host : hostname.split(".")[0];
}

function json(status: number, value: unknown): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(value) };
}

// One stable tailnet link per agent — https://<host>:8444/review/<agentId> — that redirects to
// the agent's current Plannotator review. Plannotator's page uses absolute /api paths, so each
// review keeps its own `tailscale serve` port; this server only points at the live one and,
// once a review's server is gone, removes that port's route (the plugin owns the cleanup). Its
// root, https://<host>:8444/, is the review inbox: every review waiting for the owner here and on
// the peer hosts, with Approve / Send back, and Web Push for new ones. Each review's route is
// pointed at the compressing proxy (review-proxy.ts) so its page loads over a relay; the proxy
// moves the page's inline Plannotator app to /plannotator/<sha256>.js|css here (review-bundle.ts),
// so a browser loads it once per Plannotator version instead of once per review.
export class ReviewLinks {
  private server: Server | null = null;
  private proxy: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private origin: string | null = null;
  private registry: Registry | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly misses = new Map<string, number>();
  // The peer each listed review belongs to, from the last inbox load: where its decision goes.
  private readonly peerOf = new Map<string, string>();
  private readonly port: number;
  private readonly file: string;
  private readonly sweepMs: number;
  private readonly now: () => Date;
  private readonly alive: (localUrl: string) => Promise<boolean>;
  private readonly serve: (localPort: number) => Promise<string | null>;
  private readonly unserve: (port: number) => Promise<void>;
  private readonly route: (port: number, proxyPort: number) => Promise<void>;
  private readonly proxyPort: number;
  private readonly fetchPlan: (localUrl: string) => Promise<string>;
  private readonly timeZone: string | undefined;
  private readonly host: string;
  private readonly peers: () => Promise<string[]>;
  private readonly decide: DecideReview | null;
  private readonly linearWorkspace: (() => Promise<string>) | null;
  private readonly push: ReviewPush;
  private readonly bundles = new ReviewBundles();
  private readonly routes: ActivationRoute | null;

  constructor(options: ReviewLinksOptions = {}) {
    this.port = options.port ?? REVIEW_PORT;
    this.file = options.file ?? join(plannotatorPaths().directory, "reviews.json");
    this.sweepMs = options.sweepMs ?? SWEEP_MS;
    this.now = options.now ?? (() => new Date());
    this.alive = options.alive ?? backendAlive;
    this.serve = options.serve ?? serveReviews;
    this.unserve = options.unserve ?? unserveReview;
    this.route = options.route ?? routeReview;
    this.proxyPort = options.proxyPort ?? REVIEW_PROXY_PORT;
    this.fetchPlan = options.fetchPlan ?? readReviewPlan;
    this.timeZone = options.timeZone;
    this.host = options.host ?? hostname().replace(/\.local$/, "");
    this.peers = options.peers ?? (async () => []);
    this.decide = options.decide ?? null;
    this.linearWorkspace = options.linearWorkspace ?? null;
    this.push = new ReviewPush(options.pushFile ?? join(dirname(this.file), "push.json"), options.sendPush);
    this.routes = options.routes ?? null;
  }

  // The port actually listened on (differs from the configured one when that is 0).
  get listeningPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  get listeningProxyPort(): number | null {
    const address = this.proxy?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  start(): Promise<void> {
    return this.starting ??= (async () => {
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        // The activation protocol carries a whole prompt and a handover note, so its routes have
        // their own (larger) limit; every other route keeps the small one.
        const limit = isActivationPath(request.url ?? "") ? MAX_ACTIVATION_BODY_BYTES : MAX_BODY_BYTES;
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) { response.writeHead(413).end(); request.destroy(); return; }
          chunks.push(chunk);
        });
        request.on("end", () => {
          if (response.headersSent) return;
          void this.respond(request.method ?? "GET", request.url ?? "/", request.headers, Buffer.concat(chunks).toString("utf8")).then(({ status, headers, body }) => {
            response.writeHead(status, { "cache-control": "no-store", ...headers }).end(body);
          }, (error: unknown) => {
            console.error(`[linear-tickets] review link failed: ${error instanceof Error ? error.message : error}`);
            if (!response.headersSent) response.writeHead(500).end();
          });
        });
      });
      this.server = server;
      // Executor form: the plugin's TypeScript lib predates Promise.withResolvers.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const port = this.listeningPort ?? this.port;
      this.origin = await this.serve(port).catch((error: unknown) => {
        console.error(`[linear-tickets] publishing review links on :${REVIEW_SERVE_PORT} failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
        return null;
      });
      await this.startProxy();
      this.timer = setInterval(() => { void this.sweep().then(() => this.announce()); }, this.sweepMs);
      this.timer.unref?.();
    })().catch((error: unknown) => {
      console.error(`[linear-tickets] starting the review link server failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    this.server?.close();
    this.server = null;
    this.proxy?.close();
    this.proxy?.closeAllConnections();
    this.proxy = null;
    this.starting = null;
  }

  // Without the proxy (its port taken) reviews keep the direct route the open hook published.
  // Open reviews published before (by the hook, or by an earlier plugin version) are moved onto it.
  private async startProxy(): Promise<void> {
    const proxy = createReviewProxy((port) => this.backendFor(port), (page) => this.origin ? this.bundles.externalize(page, this.origin) : page);
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(this.proxyPort, "127.0.0.1", () => { proxy.off("error", reject); resolve(); });
      });
    } catch (error) {
      console.error(`[linear-tickets] the review proxy could not listen on :${this.proxyPort}; reviews are served uncompressed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    this.proxy = proxy;
    for (const entry of Object.values(await this.load())) {
      if (!entry.closedAt) await this.routeThroughProxy(entry.remoteUrl);
    }
  }

  private async routeThroughProxy(remoteUrl: string | null): Promise<void> {
    const port = reviewPort(remoteUrl);
    const proxyPort = this.listeningProxyPort;
    if (port === null || proxyPort === null) return;
    await this.route(port, proxyPort).catch((error: unknown) => {
      console.error(`[linear-tickets] pointing review port ${port} at the compressing proxy failed; it stays uncompressed: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    });
  }

  // The local port of the open review published on tailnet port `port`; null for anything else,
  // so the proxy never reaches a local port that is not a review.
  private async backendFor(port: number): Promise<number | null> {
    for (const entry of Object.values(await this.load())) {
      if (entry.closedAt || reviewPort(entry.remoteUrl) !== port) continue;
      return Number(new URL(entry.localUrl).port) || null;
    }
    return null;
  }

  // Records a new review and returns the agent's stable link, or null when there is none to give
  // (the server is not published, or the review itself is not reachable in the tailnet). `since`
  // is when the owner first got the plan, for a review served again (a parked plan after a restart
  // of the central host); without it the review opened now. `model` wrote the plan.
  async opened(agentId: string, event: OpenedEvent, review: { identifier?: string; since?: string; model?: string | null } = {}): Promise<string | null> {
    await this.starting;
    const { identifier, since, model } = review;
    await this.change((registry) => {
      registry[event.localUrl] = { agentId, localUrl: event.localUrl, remoteUrl: event.remoteUrl, ...(identifier ? { identifier } : {}), openedAt: this.now().toISOString(), ...(since ? { since } : {}), ...(model ? { model } : {}) };
    });
    this.misses.delete(event.localUrl);
    // Before the link is handed out, so the first tap already gets the compressed page.
    await this.routeThroughProxy(event.remoteUrl);
    return this.origin && event.remoteUrl && AGENT_ID.test(agentId) ? `${this.origin}/review/${encodeURIComponent(agentId)}` : null;
  }

  // The review stays open until its server stops; the outcome is what the closed page shows.
  async decided(agentId: string, approved: boolean): Promise<void> {
    await this.change((registry) => {
      const entry = latest(registry, agentId);
      if (entry) entry.outcome = approved ? "approved" : "sent back";
    });
  }

  // The plan's details for the inbox, with what the risk policy made of it (null: not judged).
  async described(localUrl: string, plan: string, judgement: { approved: boolean; reasons: string[] } | null): Promise<void> {
    if (!plan.trim()) return;
    await this.change((registry) => {
      const entry = registry[localUrl];
      if (!entry) return;
      entry.details = { ...planDetails(plan, entry.identifier), ...(judgement ? { reasons: judgement.reasons, autoApproved: judgement.approved } : {}) };
    });
  }

  // The same for the agent's latest review: a parked plan judged again (its review is the central host's).
  async describedFor(agentId: string, plan: string, judgement: { approved: boolean; reasons: string[] }): Promise<void> {
    if (!plan.trim()) return;
    await this.change((registry) => {
      const entry = latest(registry, agentId);
      if (!entry) return;
      entry.details = { ...planDetails(plan, entry.identifier), reasons: judgement.reasons, autoApproved: judgement.approved };
    });
  }

  async sweep(): Promise<void> {
    const open = Object.values(await this.load()).filter((entry) => !entry.closedAt);
    const dead: ReviewEntry[] = [];
    for (const entry of open) {
      if (await this.alive(entry.localUrl)) { this.misses.delete(entry.localUrl); continue; }
      const misses = (this.misses.get(entry.localUrl) ?? 0) + 1;
      this.misses.set(entry.localUrl, misses);
      if (misses >= MISSES_TO_CLOSE) dead.push(entry);
    }
    const closed = new Set<string>();
    for (const entry of dead) {
      const port = reviewPort(entry.remoteUrl);
      if (port !== null) {
        // Left open on failure, so the next sweep retries. A route that no longer exists (removed
        // by hand, or by a restart of Tailscale) is what this step wants, not a failure.
        try { await this.unserve(port); } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/handler does not exist/i.test(message)) {
            console.error(`[linear-tickets] removing the tailnet route for review port ${port} failed: ${message.split("\n")[0]}`);
            continue;
          }
        }
      }
      closed.add(entry.localUrl);
    }
    if (!closed.size) return;
    const at = this.now().toISOString();
    await this.change((registry) => {
      for (const localUrl of closed) {
        const entry = registry[localUrl];
        if (entry && !entry.closedAt) entry.closedAt = at;
        this.misses.delete(localUrl);
      }
    });
  }

  // Tells the subscribed browsers about reviews that started waiting since the last sweep, here or
  // on a peer. Needs the published https origin: push services only accept it as the contact.
  async announce(): Promise<void> {
    if (!this.origin) return;
    const origin = this.origin;
    const view = await this.view();
    await this.push.announce(view.open.map((row) => ({
      key: `${row.agentId}@${row.since}`,
      title: `Plan review: ${row.name}`,
      body: row.details?.title ?? "A plan waits for your review.",
      url: new URL(row.link, origin).href,
    })), origin).catch((error: unknown) => console.error(`[linear-tickets] review notifications failed: ${error instanceof Error ? error.message : error}`));
  }

  private async respond(method: string, url: string, headers: IncomingHttpHeaders, body: string): Promise<{ status: number; headers?: Record<string, string>; body?: string | Buffer }> {
    const path = new URL(url, "http://localhost").pathname;
    // Draining a host: /activation* goes to the authenticated activation protocol, which answers
    // 401 for a request without the shared secret (and null for every other path).
    if (this.routes) {
      const custom = await this.routes({ method, path, headers, body });
      if (custom) return custom;
    }
    const decision = /^\/api\/reviews\/([^/]+)\/decision$/.exec(path);
    if (decision || path === "/api/push/subscribe") {
      if (method !== "POST") return { status: 405, headers: { allow: "POST" } };
      // A page on another site cannot send these: the custom header needs a CORS preflight, which
      // this server never grants, and a browser's own Origin must be this inbox.
      const origin = headers.origin;
      if (headers["x-review-action"] !== "1" || !String(headers["content-type"] ?? "").startsWith("application/json") || (origin && new URL(origin).host !== headers.host)) return json(403, { error: "Not allowed." });
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return json(400, { error: "The request is not JSON." }); }
      if (path === "/api/push/subscribe") {
        const subscription = pushSubscription(parsed);
        if (!subscription) return json(400, { error: "That is not a push subscription." });
        await this.push.subscribe(subscription);
        return json(200, { ok: true });
      }
      const agentId = decodeURIComponent(decision![1]);
      if (!AGENT_ID.test(agentId)) return json(404, { error: "No such review." });
      try {
        await this.decideFor(agentId, parsed);
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof DecisionError) return json(error.status, { error: error.message });
        throw error;
      }
    }
    if (method !== "GET") return { status: 405, headers: { allow: "GET" } };
    const bundle = /^\/plannotator\/([0-9a-f]{64}\.(?:js|css))$/.exec(path);
    if (bundle) {
      const file = this.bundles.file(bundle[1]);
      if (!file) return { status: 404 };
      // Named by its hash, so it never changes; any review's page (another port) may load it.
      const br = /\bbr\b/i.test(String(headers["accept-encoding"] ?? "")) ? await file.br.catch(() => null) : null;
      return { status: 200, headers: { "content-type": file.type, "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", vary: "Accept-Encoding", ...(br ? { "content-encoding": "br" } : {}) }, body: br ?? file.raw };
    }
    if (path === "/") return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: inboxPage(await this.view(), this.now(), this.timeZone) };
    if (path === "/api/inbox") return json(200, { host: this.host, ...await this.rows() });
    if (path === "/api/push/key") return json(200, { publicKey: await this.push.publicKey() });
    if (path === "/manifest.webmanifest") return { status: 200, headers: { "content-type": "application/manifest+json" }, body: MANIFEST };
    if (path === "/sw.js") return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "service-worker-allowed": "/" }, body: SERVICE_WORKER };
    if (path === "/icon.png") return { status: 200, headers: { "content-type": "image/png" }, body: REVIEW_ICON_PNG };
    const match = /^\/review\/([^/]+)\/?$/.exec(path);
    const agentId = match ? decodeURIComponent(match[1]) : null;
    if (!agentId || !AGENT_ID.test(agentId)) return { status: 404 };
    const entry = latest(await this.load(), agentId);
    if (!entry) return { status: 404 };
    if (!entry.closedAt && entry.remoteUrl && await this.alive(entry.localUrl)) return { status: 302, headers: { location: entry.remoteUrl } };
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: closedPage(entry.identifier, entry.outcome ?? "ended") };
  }

  // Approve, or send back with the owner's note, the agent's waiting review: here when it is this
  // host's, else on the peer that listed it (the peer checks it again).
  private async decideFor(agentId: string, raw: unknown): Promise<void> {
    const request = DecisionRequest.safeParse(raw);
    if (!request.success) throw new DecisionError(400, "Say whether to approve.");
    const approve = request.data.approve;
    const feedback = request.data.feedback?.trim().slice(0, MAX_FEEDBACK_CHARS) ?? "";
    if (!approve && !feedback) throw new DecisionError(400, "Say what should change.");
    const entry = latest(await this.load(), agentId);
    if (!entry) {
      const peer = this.peerOf.get(agentId);
      if (!peer) throw new DecisionError(404, "This review is not listed any more.");
      const response = await fetch(`${peer}/api/reviews/${encodeURIComponent(agentId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-review-action": "1" },
        body: JSON.stringify({ approve, feedback }),
        signal: AbortSignal.timeout(15_000),
      }).catch((error: unknown) => { throw new DecisionError(502, `${new URL(peer).hostname} did not answer: ${error instanceof Error ? error.message : error}`); });
      if (response.ok) return;
      const answer = ErrorAnswer.safeParse(await response.json().catch(() => null));
      throw new DecisionError(response.status, answer.success ? answer.data.error : `${new URL(peer).hostname} answered HTTP ${response.status}.`);
    }
    if (entry.closedAt || entry.outcome || !await this.alive(entry.localUrl)) throw new DecisionError(409, "This review is already closed.");
    if (!this.decide) throw new DecisionError(503, "This host cannot decide reviews.");
    try { await this.decide(entry.localUrl, approve, approve ? "" : feedback, agentId); } catch (error) {
      throw new DecisionError(409, error instanceof Error ? error.message : String(error));
    }
    // Listed as decided at once; the decision's own event reports the same outcome again.
    await this.decided(agentId, approve);
  }

  // This host's rows plus every peer's; a peer that does not answer is named, not fatal.
  private async view(): Promise<InboxView> {
    const own = await this.rows();
    const peers = await this.peers().catch(() => []);
    const answers = await Promise.all(peers.map(async (peer) => {
      try {
        const response = await fetch(`${peer}/api/inbox`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const answer = PeerInbox.parse(await response.json());
        return { peer, host: answer.host, open: peerRows(answer.open, answer.host), decided: peerRows(answer.decided, answer.host) };
      } catch { return { peer, host: peerName(peer), unreachable: true as const }; }
    }));
    const open = [...own.open];
    const decided = [...own.decided];
    const unreachable: string[] = [];
    this.peerOf.clear();
    for (const answer of answers) {
      if ("unreachable" in answer) { unreachable.push(answer.host); continue; }
      for (const row of answer.open) this.peerOf.set(row.agentId, answer.peer);
      open.push(...answer.open);
      decided.push(...answer.decided);
    }
    open.sort((a, b) => b.since.localeCompare(a.since));
    decided.sort((a, b) => (b.decidedAt ?? b.since).localeCompare(a.decidedAt ?? a.since));
    const hosts = [this.host, ...answers.map((answer) => answer.host)];
    return { open, decided: decided.slice(0, RECENT_DECISIONS), unreachable, hosts, push: !!this.origin };
  }

  // This host's waiting and recently decided reviews as inbox rows, with absolute links when the
  // inbox is published (a peer's inbox links back here).
  private async rows(): Promise<{ open: InboxRow[]; decided: InboxRow[] }> {
    const { open, decided } = await this.inbox();
    const workspace = this.linearWorkspace ? await this.linearWorkspace().catch(() => null) : null;
    const row = (entry: ReviewEntry): InboxRow => ({
      agentId: entry.agentId,
      name: entry.identifier ?? `Plan review · agent ${entry.agentId.slice(0, 8)}`,
      link: `${this.origin ?? ""}/review/${encodeURIComponent(entry.agentId)}`,
      since: waitingSince(entry),
      host: this.host,
      ...(entry.details ? { details: entry.details } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(workspace && entry.identifier ? { issueUrl: `${workspace}/issue/${encodeURIComponent(entry.identifier)}` } : {}),
    });
    return {
      open: open.map(row),
      decided: decided.map((entry) => ({ ...row(entry), outcome: outcomeText(entry), decidedAt: entry.closedAt ?? entry.openedAt })),
    };
  }

  // Only each agent's latest review counts. Waiting means undecided, reachable from the tailnet
  // and still answering now, so a review that died since the last sweep is not listed. Reviews
  // opened before the plugin recorded details get them from their running server here.
  private async inbox(): Promise<{ open: ReviewEntry[]; decided: ReviewEntry[] }> {
    const registry = await this.load();
    const current = Object.values(registry).filter((entry) => AGENT_ID.test(entry.agentId) && latest(registry, entry.agentId) === entry);
    const candidates = current.filter((entry) => !entry.closedAt && !entry.outcome && entry.remoteUrl);
    const alive = await Promise.all(candidates.map((entry) => this.alive(entry.localUrl)));
    const open = candidates.filter((_, index) => alive[index]).sort((a, b) => waitingSince(b).localeCompare(waitingSince(a)));
    const missing = open.filter((entry) => !entry.details);
    const plans = await Promise.all(missing.map((entry) => this.fetchPlan(entry.localUrl).catch(() => "")));
    if (plans.some((plan) => plan.trim())) {
      await this.change(() => {
        missing.forEach((entry, index) => { if (plans[index].trim()) entry.details = planDetails(plans[index], entry.identifier); });
      });
    }
    const decided = current.filter((entry) => entry.closedAt || entry.outcome)
      .sort((a, b) => (b.closedAt ?? b.openedAt).localeCompare(a.closedAt ?? a.openedAt))
      .slice(0, RECENT_DECISIONS);
    return { open, decided };
  }

  private async load(): Promise<Registry> {
    if (this.registry) return this.registry;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      this.registry = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Registry : {};
    } catch { this.registry = {}; }
    return this.registry;
  }

  // Serialised read-modify-write; closed entries that are not their agent's latest are dropped.
  private change(mutate: (registry: Registry) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const registry = await this.load();
      mutate(registry);
      for (const [localUrl, entry] of Object.entries(registry)) {
        if (entry.closedAt && latest(registry, entry.agentId) !== entry) delete registry[localUrl];
      }
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(registry, null, 2), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

function latest(registry: Registry, agentId: string): ReviewEntry | undefined {
  let found: ReviewEntry | undefined;
  for (const entry of Object.values(registry)) {
    if (entry.agentId === agentId && (!found || entry.openedAt > found.openedAt)) found = entry;
  }
  return found;
}
