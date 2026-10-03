import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parsePlanRisk, combinedRating, ratingText } from "../shared/plan-risk";
import { FUNNEL_PORT } from "./funnel";
import { plannotatorPaths, readReviewPlan, type OpenedEvent } from "./plannotator";
import { createReviewProxy } from "./review-proxy";
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
const INBOX_REFRESH_S = 30;
const SUMMARY_CHARS = 280;

export type ReviewOutcome = "approved" | "sent back";
// What the inbox shows about a review's plan, read once from the plan text.
export type PlanDetails = {
  title: string | null;
  summary: string | null;
  // The `## Risk and impact` rating (planner and advisor combined); null when the plan has none.
  risk: { impact: number; text: string } | null;
  // Why the risk policy left it to the owner; absent when the policy did not judge the review.
  reasons?: string[];
  autoApproved?: boolean;
};
export type ReviewEntry = {
  agentId: string;
  localUrl: string;
  remoteUrl: string | null;
  identifier?: string;
  openedAt: string;
  outcome?: ReviewOutcome;
  closedAt?: string;
  details?: PlanDetails;
};
type Registry = Record<string, ReviewEntry>;

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
};

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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const PAGE_STYLE = `body{font:17px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:48px 24px;color:#1c1c1e;background:#f2f2f7}main{max-width:32rem;margin:auto}h1{font-size:1.4rem;margin:0 0 .5rem}h2{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#8e8e93;margin:2rem 0 .5rem}
ul{list-style:none;margin:0;padding:0;border-radius:12px;overflow:hidden;background:#fff}li+li{border-top:1px solid #e5e5ea}li>a,li>div{display:block;padding:14px 16px;color:inherit;text-decoration:none}li>a:active{background:#e5e5ea}
.head{display:flex;justify-content:space-between;gap:12px}.id{font-weight:600}.meta{color:#8e8e93;white-space:nowrap}.empty{color:#8e8e93}.title{margin-top:2px}.summary{margin-top:4px;font-size:15px;color:#3c3c43;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.chip{display:inline-block;margin-top:8px;font-size:13px;padding:2px 10px;border-radius:999px;background:#e5e5ea}.low{background:#d6f5df;color:#1b6e35}.mid{background:#fdecc8;color:#7a4f00}.high{background:#fde1df;color:#a3221b}.why{margin-top:6px;font-size:13px;color:#8e8e93}
@media(prefers-color-scheme:dark){body{color:#f2f2f7;background:#000}ul{background:#1c1c1e}li+li{border-color:#38383a}li>a:active{background:#2c2c2e}.summary{color:#c7c7cc}.chip{background:#2c2c2e}.low{background:#123d22;color:#8fe0a8}.mid{background:#4a3500;color:#ffd27a}.high{background:#4d1512;color:#ff9f97}}`;

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${head}<style>${PAGE_STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function closedPage(entry: ReviewEntry): string {
  const outcome = entry.outcome ?? "ended";
  const subject = entry.identifier ? `The plan review for ${escapeHtml(entry.identifier)}` : "This plan review";
  return page("Review closed", `<h1>Review closed — ${escapeHtml(outcome)}</h1><p>${subject} is no longer running. This link opens the agent's next review once it plans again.</p>`);
}

// "12 min" for a waiting review; with `suffix`, "12 min ago" for a decision.
function ago(from: string, now: Date, suffix = false): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return "just now";
  const hours = Math.floor(minutes / 60);
  const span = minutes < 60 ? `${minutes} min` : hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
  return suffix ? `${span} ago` : span;
}

function reviewName(entry: ReviewEntry): string {
  return escapeHtml(entry.identifier ?? `Plan review · agent ${entry.agentId.slice(0, 8)}`);
}

// Markdown reduced to the words a one-glance summary needs.
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*(?:[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2)).trimEnd()}…`;
}

// The plan's title (its first `# ` heading, without the ticket identifier the row already shows),
// its opening paragraph and its risk rating.
export function planDetails(plan: string, identifier?: string): PlanDetails {
  const lines = plan.split("\n");
  const start = lines.findIndex((line) => /^#\s+\S/.test(line));
  let title = start >= 0 ? plainText(lines[start].replace(/^#\s+/, "")) : null;
  if (title && identifier && title.toLowerCase().startsWith(identifier.toLowerCase())) title = title.slice(identifier.length).replace(/^[\s—–·:|-]+/, "") || null;
  let summary: string | null = null;
  let paragraph: string[] = [];
  for (const line of [...lines.slice(start + 1), ""]) {
    if (line.trim() && !/^#{1,6}\s/.test(line)) { paragraph.push(line); continue; }
    // Tables, code and rules are not a summary.
    if (paragraph.length && !/^\s*(?:\||```|---|\*\*\*)/.test(paragraph[0])) { summary = clip(plainText(paragraph.join(" ")), SUMMARY_CHARS); break; }
    paragraph = [];
  }
  const rated = parsePlanRisk(plan);
  const risk = "risk" in rated ? { impact: combinedRating(rated.risk).impact, text: ratingText(rated.risk) } : null;
  return { title, summary: summary || null, risk };
}

function riskChip(risk: PlanDetails["risk"]): string {
  if (!risk) return "";
  const level = risk.impact <= 1 ? "low" : risk.impact === 2 ? "mid" : "high";
  return `<span class="chip ${level}">Risk: ${escapeHtml(risk.text.replace(/, /g, " · "))}</span>`;
}

function detailRows(details: PlanDetails | undefined, withSummary: boolean): string {
  if (!details) return "";
  const reasons = details.reasons?.length ? `<div class="why">Needs you: ${escapeHtml(details.reasons.join("; "))}</div>` : "";
  return `${details.title ? `<div class="title">${escapeHtml(details.title)}</div>` : ""}${withSummary && details.summary ? `<div class="summary">${escapeHtml(details.summary)}</div>` : ""}${riskChip(details.risk)}${withSummary ? reasons : ""}`;
}

function outcomeText(entry: ReviewEntry): string {
  if (entry.outcome === "approved" && entry.details?.autoApproved) return "auto-approved";
  return entry.outcome ?? "ended";
}

const MANIFEST = JSON.stringify({ name: "Plan reviews", short_name: "Reviews", start_url: "/", display: "standalone", background_color: "#f2f2f7", theme_color: "#f2f2f7" });

// The root of :8444: every review waiting for the owner, oldest first, plus the latest decisions.
// Rows link to the agent's stable /review/<agentId> link, which shows the closed page if the review
// ends before it is tapped.
function inboxPage({ open, decided }: { open: ReviewEntry[]; decided: ReviewEntry[] }, now: Date): string {
  const waiting = open.length
    ? `<ul>${open.map((entry) => `<li><a href="/review/${encodeURIComponent(entry.agentId)}"><div class="head"><span class="id">${reviewName(entry)}</span><span class="meta">${ago(entry.openedAt, now)}</span></div>${detailRows(entry.details, true)}</a></li>`).join("")}</ul>`
    : `<p class="empty">Nothing to review.</p>`;
  const recent = decided.length
    ? `<h2>Recently decided</h2><ul>${decided.map((entry) => `<li><div><div class="head"><span class="id">${reviewName(entry)}</span><span class="meta">${escapeHtml(outcomeText(entry))} · ${ago(entry.closedAt ?? entry.openedAt, now, true)}</span></div>${detailRows(entry.details, false)}</div></li>`).join("")}</ul>`
    : "";
  const head = `<meta http-equiv="refresh" content="${INBOX_REFRESH_S}"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Reviews"><link rel="manifest" href="/manifest.webmanifest">`;
  return page(open.length ? `Plan reviews (${open.length})` : "Plan reviews", `<h1>Plan reviews</h1>${waiting}${recent}`, head);
}

// One stable tailnet link per agent — https://<host>:8444/review/<agentId> — that redirects to
// the agent's current Plannotator review. Plannotator's page uses absolute /api paths, so each
// review keeps its own `tailscale serve` port; this server only points at the live one and,
// once a review's server is gone, removes that port's route (the plugin owns the cleanup). Its
// root, https://<host>:8444/, lists every review still waiting for the owner. Each review's
// route is pointed at the compressing proxy (review-proxy.ts) so its page loads over a relay.
export class ReviewLinks {
  private server: Server | null = null;
  private proxy: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private origin: string | null = null;
  private registry: Registry | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly misses = new Map<string, number>();
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
        void this.respond(request.method ?? "GET", request.url ?? "/").then(({ status, headers, body }) => {
          response.writeHead(status, { "cache-control": "no-store", ...headers }).end(body);
        }, (error: unknown) => {
          console.error(`[linear-tickets] review link failed: ${error instanceof Error ? error.message : error}`);
          if (!response.headersSent) response.writeHead(500).end();
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
      this.timer = setInterval(() => { void this.sweep(); }, this.sweepMs);
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
    const proxy = createReviewProxy((port) => this.backendFor(port));
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
  // (the server is not published, or the review itself is not reachable in the tailnet).
  async opened(agentId: string, event: OpenedEvent, identifier?: string): Promise<string | null> {
    await this.starting;
    await this.change((registry) => {
      registry[event.localUrl] = { agentId, localUrl: event.localUrl, remoteUrl: event.remoteUrl, ...(identifier ? { identifier } : {}), openedAt: this.now().toISOString() };
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

  private async respond(method: string, url: string): Promise<{ status: number; headers?: Record<string, string>; body?: string }> {
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/" || path === "/manifest.webmanifest") {
      if (method !== "GET") return { status: 405, headers: { allow: "GET" } };
      if (path === "/manifest.webmanifest") return { status: 200, headers: { "content-type": "application/manifest+json" }, body: MANIFEST };
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: inboxPage(await this.inbox(), this.now()) };
    }
    const match = /^\/review\/([^/]+)\/?$/.exec(path);
    const agentId = match ? decodeURIComponent(match[1]) : null;
    if (!agentId || !AGENT_ID.test(agentId)) return { status: 404 };
    if (method !== "GET") return { status: 405, headers: { allow: "GET" } };
    const entry = latest(await this.load(), agentId);
    if (!entry) return { status: 404 };
    if (!entry.closedAt && entry.remoteUrl && await this.alive(entry.localUrl)) return { status: 302, headers: { location: entry.remoteUrl } };
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: closedPage(entry) };
  }

  // Only each agent's latest review counts. Waiting means undecided, reachable from the tailnet
  // and still answering now, so a review that died since the last sweep is not listed. Reviews
  // opened before the plugin recorded details get them from their running server here.
  private async inbox(): Promise<{ open: ReviewEntry[]; decided: ReviewEntry[] }> {
    const registry = await this.load();
    const current = Object.values(registry).filter((entry) => AGENT_ID.test(entry.agentId) && latest(registry, entry.agentId) === entry);
    const candidates = current.filter((entry) => !entry.closedAt && !entry.outcome && entry.remoteUrl);
    const alive = await Promise.all(candidates.map((entry) => this.alive(entry.localUrl)));
    const open = candidates.filter((_, index) => alive[index]).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
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
