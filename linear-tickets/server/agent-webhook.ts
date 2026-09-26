import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export const WEBHOOK_PORT = 47_831;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_AGE_MS = 60_000;
const SEEN_LIMIT = 500;

export type AgentSessionWebhook = {
  type: "AgentSessionEvent";
  action: "created" | "prompted" | string;
  webhookId?: string;
  webhookTimestamp?: number;
  agentSession: Record<string, unknown> & { id: string };
  agentActivity?: Record<string, unknown>;
  promptContext?: string;
  guidance?: unknown;
};

// Linear signs the raw body with HMAC-SHA256 (hex) in `Linear-Signature`, and puts the send
// time in `webhookTimestamp`. Old or unsigned requests are refused: Funnel makes this public.
export function verifyWebhook(body: Buffer, signature: string | undefined, secret: string, now = Date.now()): Record<string, unknown> | null {
  if (!signature) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try { payload = JSON.parse(body.toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  const timestamp = (payload as { webhookTimestamp?: unknown }).webhookTimestamp;
  if (typeof timestamp !== "number" || Math.abs(now - timestamp) > MAX_AGE_MS) return null;
  return payload as Record<string, unknown>;
}

// Answers Linear within its 5 s budget — 200 as soon as the signature checks out — and
// hands agent session events to `onEvent` afterwards. Retries of the same delivery are
// dropped by webhook id.
export class AgentWebhookServer {
  private server: Server | null = null;
  private readonly seen = new Set<string>();
  lastEventAt: string | null = null;

  constructor(
    private readonly secret: () => Promise<string | null>,
    private readonly onEvent: (event: AgentSessionWebhook) => void,
    private readonly port = WEBHOOK_PORT,
  ) {}

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { response.writeHead(413).end(); request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on("end", () => {
        void (async () => {
          if (request.method !== "POST") { response.writeHead(405).end(); return; }
          const secret = await this.secret();
          const payload = secret ? verifyWebhook(Buffer.concat(chunks), request.headers["linear-signature"] as string | undefined, secret) : null;
          if (!payload) { response.writeHead(401).end(); return; }
          response.writeHead(200).end();
          if (payload.type !== "AgentSessionEvent") return;
          const id = typeof payload.webhookId === "string" ? payload.webhookId : "";
          if (id) {
            if (this.seen.has(id)) return;
            this.seen.add(id);
            if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
          }
          this.lastEventAt = new Date().toISOString();
          this.onEvent(payload as AgentSessionWebhook);
        })().catch((error: unknown) => {
          console.error(`[linear-tickets] agent webhook failed: ${error instanceof Error ? error.message : error}`);
          if (!response.headersSent) response.writeHead(500).end();
        });
      });
    });
    this.server = server;
    // Executor form: the plugin's TypeScript lib predates Promise.withResolvers.
    return new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
