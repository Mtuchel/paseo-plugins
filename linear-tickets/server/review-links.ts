import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { FUNNEL_PORT } from "./funnel";
import { plannotatorPaths, type OpenedEvent } from "./plannotator";
import { tailscaleBinary } from "./tailscale";

const exec = promisify(execFile);
export const REVIEW_PORT = 47_832;
// Tailnet-only (`tailscale serve`, never Funnel): 8443 stays the public webhook.
export const REVIEW_SERVE_PORT = 8444;
const SWEEP_MS = 30_000;
const MISSES_TO_CLOSE = 2;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

export type ReviewOutcome = "approved" | "sent back";
export type ReviewEntry = {
  agentId: string;
  localUrl: string;
  remoteUrl: string | null;
  identifier?: string;
  openedAt: string;
  outcome?: ReviewOutcome;
  closedAt?: string;
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function closedPage(entry: ReviewEntry): string {
  const outcome = entry.outcome ?? "ended";
  const subject = entry.identifier ? `The plan review for ${escapeHtml(entry.identifier)}` : "This plan review";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review closed</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:48px 24px;color:#1c1c1e;background:#f2f2f7}main{max-width:32rem;margin:auto}h1{font-size:1.4rem;margin:0 0 .5rem}@media(prefers-color-scheme:dark){body{color:#f2f2f7;background:#1c1c1e}}</style></head>
<body><main><h1>Review closed — ${escapeHtml(outcome)}</h1><p>${subject} is no longer running. This link opens the agent's next review once it plans again.</p></main></body></html>`;
}

// One stable tailnet link per agent — https://<host>:8444/review/<agentId> — that redirects to
// the agent's current Plannotator review. Plannotator's page uses absolute /api paths, so each
// review keeps its own `tailscale serve` port; this server only points at the live one and,
// once a review's server is gone, removes that port's route (the plugin owns the cleanup).
export class ReviewLinks {
  private server: Server | null = null;
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

  constructor(options: ReviewLinksOptions = {}) {
    this.port = options.port ?? REVIEW_PORT;
    this.file = options.file ?? join(plannotatorPaths().directory, "reviews.json");
    this.sweepMs = options.sweepMs ?? SWEEP_MS;
    this.now = options.now ?? (() => new Date());
    this.alive = options.alive ?? backendAlive;
    this.serve = options.serve ?? serveReviews;
    this.unserve = options.unserve ?? unserveReview;
  }

  // The port actually listened on (differs from the configured one when that is 0).
  get listeningPort(): number | null {
    const address = this.server?.address();
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
    this.starting = null;
  }

  // Records a new review and returns the agent's stable link, or null when there is none to give
  // (the server is not published, or the review itself is not reachable in the tailnet).
  async opened(agentId: string, event: OpenedEvent, identifier?: string): Promise<string | null> {
    await this.starting;
    await this.change((registry) => {
      registry[event.localUrl] = { agentId, localUrl: event.localUrl, remoteUrl: event.remoteUrl, ...(identifier ? { identifier } : {}), openedAt: this.now().toISOString() };
    });
    this.misses.delete(event.localUrl);
    return this.origin && event.remoteUrl && AGENT_ID.test(agentId) ? `${this.origin}/review/${encodeURIComponent(agentId)}` : null;
  }

  // The review stays open until its server stops; the outcome is what the closed page shows.
  async decided(agentId: string, approved: boolean): Promise<void> {
    await this.change((registry) => {
      const entry = latest(registry, agentId);
      if (entry) entry.outcome = approved ? "approved" : "sent back";
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
      const port = entry.remoteUrl ? Number(new URL(entry.remoteUrl).port) : 0;
      if (port && port !== FUNNEL_PORT && port !== REVIEW_SERVE_PORT) {
        // Left open on failure, so the next sweep retries.
        try { await this.unserve(port); } catch (error) {
          console.error(`[linear-tickets] removing the tailnet route for review port ${port} failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
          continue;
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
    const match = /^\/review\/([^/]+)\/?$/.exec(new URL(url, "http://localhost").pathname);
    const agentId = match ? decodeURIComponent(match[1]) : null;
    if (!agentId || !AGENT_ID.test(agentId)) return { status: 404 };
    if (method !== "GET") return { status: 405, headers: { allow: "GET" } };
    const entry = latest(await this.load(), agentId);
    if (!entry) return { status: 404 };
    if (!entry.closedAt && entry.remoteUrl && await this.alive(entry.localUrl)) return { status: 302, headers: { location: entry.remoteUrl } };
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: closedPage(entry) };
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
