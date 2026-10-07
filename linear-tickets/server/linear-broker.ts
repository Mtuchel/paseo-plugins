import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { operationName, linearUsage, type LinearUsage } from "./linear-usage";
import { poolOf, RateBudget, rateBudget, RateLimitedError, type Pool } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";

const PERIOD = 3_600_000;
const MAX_POINTS = 10_000;
const MAX_BODY = 1024 * 1024;
const TOOLS: Record<string, true> = { get_ticket: true, get_issue: true, search_issues: true, add_comment: true,
  set_status: true, link_url: true, add_relation: true, create_issue: true, update_issue: true, add_manual_task: true };
const UNAVAILABLE = "The host's Linear budget service is unavailable; no request was sent. Retry after the plugin is running.";
const UNKNOWN = "The Linear request may have completed; check the ticket before retrying a write.";
export type BrokerRequest = { authorization: string; query: string; variables: Record<string, unknown>; tool: string };
export type BrokerAnswer = { kind: "answer"; status: number; payload: unknown };
export type BrokerReply = BrokerAnswer | { kind: "held"; pool: Pool; reason: string; resumeAt: number; message: string }
  | { kind: "unsent" | "unknown"; message: string };
type Intent = { id: string; pool: Pool; sentAt: number; requests: number; points: number; fenceUntil?: number };
type Journal = { version: 1; intents: Intent[] };
export type BrokerOptions = {
  home?: string; budget?: RateBudget; usage?: LinearUsage; now?: () => number; deadlineMs?: number;
  // Tests supply an upstream here, never through an agent-selected URL or environment variable.
  upstream?: (authorization: string, query: string, variables: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;
};

export class LinearBroker {
  private readonly home: string;
  private readonly budget: RateBudget;
  private readonly usage: LinearUsage;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly upstream: NonNullable<BrokerOptions["upstream"]>;
  private readonly intents = new Map<string, Intent>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly reading = new Set<IncomingMessage>();
  private readonly bootstrap: Partial<Record<Pool, { authorization: string; work: Promise<BrokerReply> }>> = {};
  private readonly retryAt: Record<Pool, number> = { app: 0, key: 0 };
  private writes = Promise.resolve();
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private broken = false;
  private socketIdentity: { ino: number; dev: number } | null = null;

  constructor(options: BrokerOptions = {}) {
    this.home = options.home ?? paseoHome();
    this.budget = options.budget ?? rateBudget;
    this.usage = options.usage ?? linearUsage;
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? 30_000;
    this.upstream = options.upstream ?? ((authorization, query, variables, signal) => fetch("https://api.linear.app/graphql", {
      method: "POST", redirect: "error", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }), signal,
    }));
  }

  get socketPath(): string { return join(this.home, "linear-tickets", "linear-broker.sock"); }
  private get journalPath(): string { return join(this.home, "linear-tickets", "linear-broker-journal.json"); }

  start(): Promise<void> {
    return this.starting ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    const directory = join(this.home, "linear-tickets");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    // First establish exclusive listener ownership, then load/recover state before accepting work.
    const old = await lstat(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (old) {
      if (!old.isSocket() || (typeof process.getuid === "function" && old.uid !== process.getuid())) throw new Error("Unsafe Linear broker socket path");
      const live = await new Promise<boolean>((resolve, reject) => {
        const socket = connect(this.socketPath);
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", (error: NodeJS.ErrnoException) => {
          socket.destroy();
          if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false); else reject(error);
        });
        socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
      });
      if (live) throw new Error("Linear broker already listening");
      const current = await lstat(this.socketPath).catch(() => null);
      if (current && (current.ino !== old.ino || current.dev !== old.dev)) throw new Error("Linear broker socket changed during recovery");
      if (current) await rm(this.socketPath);
    }
    const server = createServer((request, response) => {
      this.reading.add(request);
      request.setTimeout(this.deadlineMs, () => request.destroy());
      const work = this.handle(request, response);
      this.active.add(work);
      void work.finally(() => { this.active.delete(work); this.reading.delete(request); });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, resolve); });
    await chmod(this.socketPath, 0o600);
    const identity = await lstat(this.socketPath);
    this.socketIdentity = { ino: identity.ino, dev: identity.dev };
    try {
      const info = await lstat(this.journalPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info) {
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Unsafe journal");
        const journal: unknown = JSON.parse(await readFile(this.journalPath, "utf8"));
        if (!validJournal(journal)) throw new Error("Invalid journal");
        for (const intent of journal.intents) {
          const recovered = { ...intent, fenceUntil: intent.fenceUntil ?? this.now() + PERIOD };
          this.intents.set(intent.id, recovered);
          this.budget.retainDebt(intent.pool, intent.id, intent.requests, intent.points);
          this.usage.invalidateContinuity(intent.pool);
        }
        if (this.intents.size) await this.persist();
      }
    } catch {
      this.broken = true;
      console.error("[linear-tickets] Linear broker journal unreadable; agent requests held pending repair. Unresolved debt must not be deleted based on time or new headers.");
    }
  }

  private persist(): Promise<void> {
    const write = this.writes.then(async () => {
      const temporary = this.journalPath + "." + randomUUID() + ".tmp";
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, intents: [...this.intents.values()] })); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.journalPath);
        const directory = await open(join(this.home, "linear-tickets"), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private held(pool: Pool, reason: string, resumeAt: number): BrokerReply {
    return { kind: "held", pool, reason, resumeAt,
      message: "Agent Linear work is paused to keep the last budget for owner decisions; retry after " + new Date(resumeAt).toISOString() + "." };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let reply: BrokerReply = { kind: "unsent", message: UNAVAILABLE };
    try {
      await this.starting;
      if (this.stopped || this.broken) return this.reply(response, reply);
      if (request.method !== "POST" || request.url !== "/graphql") return this.reply(response, { kind: "unsent", message: "Invalid Linear broker request." });
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      this.reading.delete(request);
      request.setTimeout(0);
      if (!validRequest(body)) return this.reply(response, { kind: "unsent", message: "Invalid Linear broker request." });
      const pool = poolOf(body.authorization);
      let fenceUntil = 0;
      for (const intent of this.intents.values()) if (intent.pool === pool) fenceUntil = Math.max(fenceUntil, intent.fenceUntil ?? 0);
      if (fenceUntil > this.now()) return this.reply(response, this.held(pool, "uncertain", fenceUntil));
      if (!this.budget.hasSamples(pool, fenceUntil)) {
        let bootstrap = this.bootstrap[pool];
        if (!bootstrap) {
          if (this.retryAt[pool] > this.now()) return this.reply(response, this.held(pool, "samples", this.retryAt[pool]));
          this.retryAt[pool] = this.now() + 60_000;
          bootstrap = { authorization: body.authorization, work: this.send({ authorization: body.authorization, query: "query McpBudgetProbe { viewer { id } }", variables: {}, tool: "budget-probe" }) };
          this.bootstrap[pool] = bootstrap;
          void bootstrap.work.finally(() => { delete this.bootstrap[pool]; });
        }
        const discovery = await bootstrap.work;
        const authFailed = discovery.kind === "answer" && (discovery.status === 401 || hasCode(discovery.payload, "AUTHENTICATION_ERROR"));
        // A different caller's rejected old token is not evidence that this credential failed.
        if (!(authFailed && bootstrap.authorization !== body.authorization)
          && (discovery.kind !== "answer" || discovery.status >= 400
            || (!!discovery.payload && typeof discovery.payload === "object" && "errors" in discovery.payload && Array.isArray(discovery.payload.errors) && discovery.payload.errors.length > 0))) return this.reply(response, discovery);
        if (!this.budget.hasSamples(pool, fenceUntil)) return this.reply(response, this.held(pool, "samples", this.retryAt[pool]));
      }
      if (response.destroyed) return;
      reply = await this.send(body, () => response.destroyed);
    } catch (error) {
      if (error instanceof RateLimitedError) reply = this.held(error.pool, error.reason, error.resumeAt);
    }
    this.reply(response, reply);
  }

  private reply(response: ServerResponse, reply: BrokerReply): void {
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  }

  private async send(body: BrokerRequest, disconnected: () => boolean = () => false): Promise<BrokerReply> {
    const pool = poolOf(body.authorization);
    if (this.broken || this.stopped) return { kind: "unsent", message: UNAVAILABLE };
    let pendingFence = 0;
    for (const saved of this.intents.values()) if (saved.pool === pool) pendingFence = Math.max(pendingFence, saved.fenceUntil ?? 0);
    if (pendingFence > this.now()) return this.held(pool, "uncertain", pendingFence);
    let ticket;
    try { ticket = this.budget.acquire(pool, "interactive", "mcp:" + body.tool, operationName(body.query), { points: MAX_POINTS, deferred: true }); }
    catch (error) {
      if (error instanceof RateLimitedError) return this.held(pool, error.reason, error.resumeAt);
      return { kind: "unsent", message: UNAVAILABLE };
    }
    const intent: Intent = { id: randomUUID(), pool, sentAt: this.now(), requests: 1, points: MAX_POINTS };
    this.intents.set(intent.id, intent);
    try { await this.persist(); }
    catch {
      this.intents.delete(intent.id);
      ticket.cancel();
      this.broken = true;
      return { kind: "unsent", message: UNAVAILABLE };
    }
    // Journal persistence yields: another attempted request may have become uncertain meanwhile.
    let fence = 0;
    for (const saved of this.intents.values()) if (saved.pool === pool) fence = Math.max(fence, saved.fenceUntil ?? 0);
    if (disconnected() || this.stopped || this.broken || fence > this.now()) {
      ticket.cancel();
      this.intents.delete(intent.id);
      try { await this.persist(); } catch { this.broken = true; }
      return fence > this.now() ? this.held(pool, "uncertain", fence) : { kind: "unsent", message: UNAVAILABLE };
    }
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    ticket.start();
    const attempt = Promise.resolve().then(() => this.upstream(body.authorization, body.query, body.variables, controller.signal)).then(async (response) => {
      let payload: unknown = null;
      try { payload = await response.json(); } catch { /* Preserve HTTP status even for a non-JSON response. */ }
      return { response, payload };
    });
    try {
      const { response, payload } = await Promise.race([attempt, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error("Upstream deadline")); }, this.deadlineMs);
      })]);
      const limited = response.status === 429 || hasCode(payload, "RATELIMITED");
      ticket.done(response.headers, limited);
      this.intents.delete(intent.id);
      try { await this.persist(); } catch {
        this.intents.set(intent.id, { ...intent, fenceUntil: this.now() + PERIOD });
        this.budget.retainDebt(pool, intent.id, 1, MAX_POINTS);
        this.broken = true;
      }
      return { kind: "answer", status: response.status, payload };
    } catch {
      const uncertain = { ...intent, fenceUntil: this.now() + PERIOD };
      this.intents.set(intent.id, uncertain);
      ticket.done(null, false, intent.id);
      this.usage.invalidateContinuity(pool);
      try { await this.persist(); } catch { this.broken = true; }
      // A transport ignoring abort can answer late. Release safety debt, never recount usage.
      const late = attempt.then(async ({ response }) => {
        if (!this.intents.has(intent.id)) return;
        this.intents.delete(intent.id);
        try { await this.persist(); this.budget.releaseDebt(pool, intent.id, response.headers); } catch {
          this.intents.set(intent.id, uncertain); this.broken = true;
        }
      }, () => {});
      // Deliberately do not block shutdown on an upstream which ignored cancellation.
      void late;
      return { kind: "unknown", message: UNKNOWN };
    } finally { clearTimeout(timeout); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const request of this.reading) request.destroy();
    await this.starting?.catch(() => {});
    const server = this.server;
    if (server) {
      server.close();
      server.closeIdleConnections();
    }
    await Promise.allSettled([...this.active]);
    await this.writes;
    server?.closeAllConnections();
    if (this.socketIdentity) {
      const current = await lstat(this.socketPath).catch(() => null);
      if (current?.ino === this.socketIdentity.ino && current.dev === this.socketIdentity.dev) await rm(this.socketPath, { force: true });
    }
  }
}

function validRequest(value: unknown): value is BrokerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every((key) => ["authorization", "query", "variables", "tool"].includes(key))
    && typeof body.authorization === "string" && body.authorization.length > 0 && body.authorization.length <= 4096
    && typeof body.query === "string" && body.query.length > 0 && typeof body.tool === "string" && Object.hasOwn(TOOLS, body.tool)
    && !!body.variables && typeof body.variables === "object" && !Array.isArray(body.variables);
}

function validJournal(value: unknown): value is Journal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Journal;
  if (journal.version !== 1 || !Array.isArray(journal.intents)) return false;
  const ids = new Set<string>();
  return journal.intents.every((intent) => {
    if (!intent || typeof intent.id !== "string" || ids.has(intent.id) || !["app", "key"].includes(intent.pool)
      || !Number.isFinite(intent.sentAt) || intent.sentAt < 0 || intent.requests !== 1 || intent.points !== MAX_POINTS
      || (intent.fenceUntil !== undefined && (!Number.isFinite(intent.fenceUntil) || intent.fenceUntil < 0))) return false;
    ids.add(intent.id);
    return true;
  });
}

function hasCode(payload: unknown, code: string): boolean {
  if (!payload || typeof payload !== "object" || !("errors" in payload) || !Array.isArray(payload.errors)) return false;
  return payload.errors.some((error: unknown) => !!error && typeof error === "object" && "extensions" in error
    && !!error.extensions && typeof error.extensions === "object" && "code" in error.extensions && error.extensions.code === code);
}
