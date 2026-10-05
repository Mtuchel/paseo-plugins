import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parsePlanRisk, combinedRating, ratingText } from "../shared/plan-risk";
import { planFollowUps } from "../shared/plan-sections";
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
// A review waiting this long gets its age highlighted.
const STALE_HOURS = 12;

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
  // The plan's `follow-up` items (filed as tickets on approval) and whether it sets a new rule.
  followUps?: number;
  newRule?: boolean;
};
export type ReviewEntry = {
  agentId: string;
  localUrl: string;
  remoteUrl: string | null;
  identifier?: string;
  openedAt: string;
  // When the owner first got this plan, for a review served again (see `opened`).
  since?: string;
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
  // The time zone the inbox shows clock times and days in; the host's when absent.
  timeZone?: string;
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

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#1c1c1e;--sub:#3c3c43;--muted:#6e6e73;--line:#d8d8dd;--press:#ebebf0;--tint:#0a64d6;--chip:#ececf1;--ok:#1b7a3d;--ok-bg:#dcf5e3;--warn:#8a5a00;--warn-bg:#fdefd0;--bad:#b3261e;--bad-bg:#fde4e1}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f2f2f7;--sub:#d1d1d6;--muted:#98989f;--line:#38383a;--press:#2c2c2e;--tint:#5aa9ff;--chip:#2c2c2e;--ok:#8fe0a8;--ok-bg:#123d22;--warn:#ffd27a;--warn-bg:#4a3500;--bad:#ff9f97;--bad-bg:#4d1512}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:17px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--fg);background:var(--bg);font-variant-numeric:tabular-nums}::selection{background:color-mix(in srgb,var(--tint) 30%,transparent)}a{color:var(--tint)}
.bar{position:sticky;top:0;z-index:2;padding:calc(env(safe-area-inset-top) + 14px) max(20px,env(safe-area-inset-right)) 10px max(20px,env(safe-area-inset-left));background:color-mix(in srgb,var(--bg) 80%,transparent);-webkit-backdrop-filter:saturate(1.8) blur(20px);backdrop-filter:saturate(1.8) blur(20px);border-bottom:.5px solid var(--line)}
.bar>div,main{max-width:36rem;margin:0 auto}h1{margin:0;font-size:1.75rem;line-height:1.15;font-weight:700;letter-spacing:-.02em}.sub{margin:2px 0 0;font-size:.875rem;color:var(--muted)}.sub.offline::after{content:" · offline, retrying";color:var(--warn)}
main{padding:4px max(16px,env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
h2{display:flex;align-items:baseline;gap:8px;margin:28px 4px 4px;font-size:1.25rem;font-weight:700;letter-spacing:-.01em}h2 .n{font-size:1rem;font-weight:600;color:var(--muted)}h2 .hint{margin-left:auto;font-size:.8125rem;font-weight:500;color:var(--muted)}
h3{margin:18px 4px 6px;font-size:.8125rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.list{list-style:none;margin:0;padding:0;background:var(--card);border-radius:14px;overflow:hidden}.list>li{position:relative}.list>li+li::before{content:"";position:absolute;top:0;left:16px;right:0;border-top:.5px solid var(--line)}
.row{position:relative;display:block;padding:12px 16px 13px;color:inherit;text-decoration:none}a.row{padding-right:36px;-webkit-tap-highlight-color:transparent;transition:background-color .25s ease-out}a.row:active{background:var(--press);transition:none}@media(hover:hover){a.row:hover{background:var(--press)}}a.row:focus-visible{outline:2px solid var(--tint);outline-offset:-2px}
.go{position:absolute;right:16px;top:50%;width:8px;height:14px;margin-top:-7px;color:var(--muted);opacity:.55}
.top{display:flex;align-items:baseline;gap:8px}.id{font-size:.8125rem;font-weight:600;color:var(--muted)}.when{margin-left:auto;font-size:.8125rem;color:var(--muted);white-space:nowrap}.when.stale{color:var(--warn);font-weight:600}
.title{margin-top:2px;font-weight:600;line-height:1.3;text-wrap:pretty}.summary{margin-top:4px;font-size:.9375rem;color:var(--sub);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{font-size:.75rem;line-height:1.5;padding:2px 8px;border-radius:7px;background:var(--chip);color:var(--sub)}.low{background:var(--ok-bg);color:var(--ok)}.mid{background:var(--warn-bg);color:var(--warn)}.high{background:var(--bad-bg);color:var(--bad)}
.why{margin-top:6px;font-size:.8125rem;color:var(--muted)}.why b{font-weight:600;color:var(--sub)}
.outcome{font-size:.75rem;font-weight:600;line-height:1.6;padding:0 8px;border-radius:999px;background:var(--chip);color:var(--sub)}.outcome.approved{background:var(--ok-bg);color:var(--ok)}.outcome.back{background:var(--warn-bg);color:var(--warn)}
.empty{margin:0;padding:28px 16px;text-align:center;color:var(--muted);background:var(--card);border-radius:14px}.empty b{display:block;color:var(--fg);font-size:1.0625rem}
.closed{padding:calc(env(safe-area-inset-top) + 48px) 24px 48px}.closed h1{font-size:1.4rem;margin-bottom:.5rem}`;

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(title)}</title>${head}<style>${PAGE_STYLE}</style></head>
<body>${body}</body></html>`;
}

function closedPage(entry: ReviewEntry): string {
  const outcome = entry.outcome ?? "ended";
  const subject = entry.identifier ? `The plan review for ${escapeHtml(entry.identifier)}` : "This plan review";
  return page("Review closed", `<main class="closed"><h1>Review closed — ${escapeHtml(outcome)}</h1><p>${subject} is no longer running. This link opens the agent's next review once it plans again.</p><p><a href="/">All plan reviews</a></p></main>`);
}

// "12 min" for a waiting review; with `suffix`, "12 min ago" for a decision.
function ago(from: string, now: Date, suffix = false): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return "just now";
  const hours = Math.floor(minutes / 60);
  const span = minutes < 60 ? `${minutes} min` : hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
  return suffix ? `${span} ago` : span;
}

// Clock times and calendar days as the owner reads them, in one time zone.
class Dates {
  readonly clock: Intl.DateTimeFormat;
  readonly full: Intl.DateTimeFormat;
  private readonly key: Intl.DateTimeFormat;
  private readonly day: Intl.DateTimeFormat;
  private readonly dayWithYear: Intl.DateTimeFormat;
  private readonly today: number;
  private readonly year: string;

  constructor(now: Date, timeZone: string | undefined) {
    this.clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    this.full = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "short" });
    this.key = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    this.day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" });
    this.dayWithYear = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" });
    this.today = this.dayNumber(now);
    this.year = this.key.format(now).slice(0, 4);
  }

  // Days since the epoch of the calendar date in the time zone, so "yesterday" holds across DST.
  private dayNumber(at: Date): number {
    const [year, month, day] = this.key.format(at).split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86_400_000;
  }

  // "Today", "Yesterday", "Mon 29 Dec", or with the year when it is not this one.
  dayLabel(at: Date): string {
    const days = this.today - this.dayNumber(at);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return (this.key.format(at).startsWith(this.year) ? this.day : this.dayWithYear).format(at);
  }
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
  const followUps = planFollowUps(plan).length;
  return { title, summary: summary || null, risk, ...(followUps ? { followUps } : {}), ...("risk" in rated && rated.risk.newRule ? { newRule: true } : {}) };
}

function riskChip(risk: PlanDetails["risk"]): string {
  if (!risk) return "";
  const level = risk.impact <= 1 ? "low" : risk.impact === 2 ? "mid" : "high";
  return `<span class="chip ${level}">Risk: ${escapeHtml(risk.text.replace(/, /g, " · "))}</span>`;
}

function detailRows(details: PlanDetails | undefined, withSummary: boolean): string {
  if (!details) return "";
  const reasons = details.reasons?.length ? `<div class="why"><b>Needs you:</b> ${escapeHtml(details.reasons.join("; "))}</div>` : "";
  const followUps = details.followUps ? `<span class="chip">${details.followUps} follow-up${details.followUps === 1 ? "" : "s"}</span>` : "";
  const newRule = details.newRule ? `<span class="chip mid">new rule</span>` : "";
  const chips = `${riskChip(details.risk)}${followUps}${newRule}`;
  return `${details.title ? `<div class="title">${escapeHtml(details.title)}</div>` : ""}${withSummary && details.summary ? `<div class="summary">${escapeHtml(details.summary)}</div>` : ""}${chips ? `<div class="chips">${chips}</div>` : ""}${withSummary ? reasons : ""}`;
}

function outcomeText(entry: ReviewEntry): string {
  if (entry.outcome === "approved" && entry.details?.autoApproved) return "auto-approved";
  return entry.outcome ?? "ended";
}

const MANIFEST = JSON.stringify({ name: "Plan reviews", short_name: "Reviews", start_url: "/", display: "standalone", background_color: "#f2f2f7", theme_color: "#f2f2f7" });

const CHEVRON = `<svg class="go" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Swaps in the fresh page every 30 s and whenever the page comes back into view, keeping the
// scroll position (a meta refresh reloads and jumps to the top); without script, the meta refresh.
const REFRESH_SCRIPT = `<script>(()=>{let busy=false;async function refresh(){if(busy||document.hidden)return;busy=true;try{const response=await fetch(location.pathname,{cache:"no-store"});if(!response.ok)throw new Error(String(response.status));const next=new DOMParser().parseFromString(await response.text(),"text/html");document.title=next.title;document.body.replaceChildren(...next.body.childNodes)}catch{document.querySelector(".sub")?.classList.add("offline")}finally{busy=false}}setInterval(refresh,${INBOX_REFRESH_S * 1000});document.addEventListener("visibilitychange",refresh);addEventListener("pageshow",(event)=>{if(event.persisted)refresh()})})()</script>`;

// When the owner got the plan: what the inbox shows, sorts and groups waiting reviews by.
function waitingSince(entry: ReviewEntry): string {
  return entry.since ?? entry.openedAt;
}

function waitingRow(entry: ReviewEntry, now: Date, dates: Dates): string {
  const iso = waitingSince(entry);
  const opened = new Date(iso);
  const stale = now.getTime() - opened.getTime() >= STALE_HOURS * 3_600_000;
  const when = `<span class="when${stale ? " stale" : ""}"><time datetime="${escapeHtml(iso)}" title="Opened ${dates.full.format(opened)}">${dates.clock.format(opened)}</time> · ${ago(iso, now)}</span>`;
  return `<li><a class="row" href="/review/${encodeURIComponent(entry.agentId)}"><div class="top"><span class="id">${reviewName(entry)}</span>${when}</div>${detailRows(entry.details, true)}${CHEVRON}</a></li>`;
}

function decidedRow(entry: ReviewEntry, now: Date, dates: Dates): string {
  const iso = entry.closedAt ?? entry.openedAt;
  const at = new Date(iso);
  const day = dates.dayLabel(at);
  const outcome = outcomeText(entry);
  const tone = outcome === "approved" ? " approved" : outcome === "sent back" ? " back" : "";
  const when = `<span class="when"><time datetime="${escapeHtml(iso)}" title="Decided ${dates.full.format(at)}">${day === "Today" ? "" : `${day} `}${dates.clock.format(at)}</time> · ${ago(iso, now, true)}</span>`;
  return `<li><div class="row"><div class="top"><span class="id">${reviewName(entry)}</span><span class="outcome${tone}">${escapeHtml(outcome)}</span>${when}</div>${detailRows(entry.details, false)}</div></li>`;
}

// The root of :8444: every review waiting for the owner, newest first and grouped by the day it
// opened, plus the latest decisions. Rows link to the agent's stable /review/<agentId> link, which
// shows the closed page if the review ends before it is tapped.
function inboxPage({ open, decided }: { open: ReviewEntry[]; decided: ReviewEntry[] }, now: Date, timeZone: string | undefined): string {
  const dates = new Dates(now, timeZone);
  const days: { label: string; rows: string[] }[] = [];
  for (const entry of open) {
    const label = dates.dayLabel(new Date(waitingSince(entry)));
    const last = days.at(-1);
    if (last?.label === label) last.rows.push(waitingRow(entry, now, dates));
    else days.push({ label, rows: [waitingRow(entry, now, dates)] });
  }
  const waiting = open.length
    ? `<section><h2>Waiting <span class="n">${open.length}</span><span class="hint">newest first</span></h2>${days.map((day) => `<h3>${escapeHtml(day.label)}</h3><ul class="list">${day.rows.join("")}</ul>`).join("")}</section>`
    : `<section><h2>Waiting</h2><p class="empty"><b>Nothing to review.</b>New plan reviews show up here on their own.</p></section>`;
  const recent = decided.length
    ? `<section><h2>Recently decided</h2><ul class="list">${decided.map((entry) => decidedRow(entry, now, dates)).join("")}</ul></section>`
    : "";
  const oldest = open.at(-1);
  const status = [open.length ? `${open.length} waiting` : "Nothing waiting", ...(oldest ? [`oldest ${ago(waitingSince(oldest), now)}`] : []), `updated ${dates.clock.format(now)}`].join(" · ");
  const header = `<header class="bar"><div><h1>Plan reviews</h1><p class="sub">${status}</p></div></header>`;
  const head = `<noscript><meta http-equiv="refresh" content="${INBOX_REFRESH_S}"></noscript><meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Reviews"><link rel="manifest" href="/manifest.webmanifest">${REFRESH_SCRIPT}`;
  return page(open.length ? `Plan reviews (${open.length})` : "Plan reviews", `${header}<main>${waiting}${recent}</main>`, head);
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
  private readonly timeZone: string | undefined;

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
  // (the server is not published, or the review itself is not reachable in the tailnet). `since`
  // is when the owner first got the plan, for a review served again (a parked plan after a restart
  // of the central host); without it the review opened now.
  async opened(agentId: string, event: OpenedEvent, identifier?: string, since?: string): Promise<string | null> {
    await this.starting;
    await this.change((registry) => {
      registry[event.localUrl] = { agentId, localUrl: event.localUrl, remoteUrl: event.remoteUrl, ...(identifier ? { identifier } : {}), openedAt: this.now().toISOString(), ...(since ? { since } : {}) };
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
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: inboxPage(await this.inbox(), this.now(), this.timeZone) };
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
