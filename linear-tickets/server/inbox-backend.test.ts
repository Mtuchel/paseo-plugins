// The checked inbox backend's private seam through ReviewLinks: the two routes only answer the
// private credential, they stay off the browser surface, and every forwarded mutation is fenced by
// the instance it was displayed from and by the draining state -- a replaced or closing backend
// refuses before any action handler -- while the activation protocol is not fenced at all.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InboxBackend } from "./inbox-backend";
import { INBOX_AUTH_HEADER, INBOX_INSTANCE_HEADER, INBOX_PROTOCOL_VERSION } from "./inbox-transport";
import type { OpenedEvent } from "./plannotator";
import { ReviewLinks } from "./review-links";

const SECRET = "private-secret";

function call(port: number, method: string, path: string, options: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: { host: "127.0.0.1", ...options.headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

type Backend = { links: ReviewLinks; port: number; backend: InboxBackend; counters: { activations: number } };

async function withBackend(run: (context: Backend) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-inbox-backend-"));
  const counters = { activations: 0 };
  const links = new ReviewLinks({
    port: 0, proxyPort: 0, file: join(directory, "reviews.json"), sweepMs: 3_600_000,
    origin: async () => "https://host.tail1.ts.net:8444",
    route: async () => {}, unserve: async () => {},
    inbox: {
      credential: async () => SECRET,
      decisions: async () => ({ hosts: [{ host: "laptop", asks: [], live: [], history: [], updatedAt: "2026-01-01T09:00:00.000Z", error: null, flow: null }], canonicalHost: "laptop", unreachable: [] }),
    },
    routes: async ({ path, headers }) => {
      if (path !== "/activation") return null;
      counters.activations++;
      return { status: 200, body: JSON.stringify({ activation: true, instance: headers[INBOX_INSTANCE_HEADER] ?? null }) };
    },
  });
  await links.start();
  const port = links.listeningPort;
  assert.ok(port, "the backend listener answers");
  try {
    await run({ links, port, backend: links.seam!, counters });
  } finally {
    links.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

const opened = (port: number): OpenedEvent => ({ type: "opened", agentId: "agent-1", localUrl: `http://localhost:${port}/?r=1`, remoteUrl: `https://host.tail1.ts.net:${port}/?r=1`, at: "t" });
const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

test("the ready and snapshot routes need the private credential and describe the checked backend", async () => {
  await withBackend(async ({ links, port, backend }) => {
    assert.equal((await call(port, "GET", "/_inbox/ready")).status, 401);
    assert.equal((await call(port, "GET", "/_inbox/ready", { headers: { [INBOX_AUTH_HEADER]: "wrong" } })).status, 401);
    const starting = await call(port, "GET", "/_inbox/ready", { headers: { [INBOX_AUTH_HEADER]: SECRET } });
    assert.equal(starting.status, 200);
    assert.equal(json(starting.text).protocolVersion, INBOX_PROTOCOL_VERSION);
    assert.equal(json(starting.text).instanceId, backend.instanceId);
    // An open socket alone is not readiness: the plugin says when its checked handlers are wired.
    assert.equal(json(starting.text).state, "starting");
    backend.ready();
    assert.equal(json((await call(port, "GET", "/_inbox/ready", { headers: { [INBOX_AUTH_HEADER]: SECRET } })).text).state, "ready");

    // The snapshot composes both existing views, without another live ReviewLinks instance.
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    const snapshot = json((await call(port, "GET", "/_inbox/snapshot", { headers: { [INBOX_AUTH_HEADER]: SECRET } })).text);
    assert.equal(snapshot.protocolVersion, INBOX_PROTOCOL_VERSION);
    assert.equal(snapshot.instanceId, backend.instanceId);
    assert.ok(Date.parse(String(snapshot.capturedAt)));
    assert.equal((snapshot.decisions as { canonicalHost: string }).canonicalHost, "laptop");
    assert.equal(Array.isArray((snapshot.inbox as { open: unknown[] }).open), true);
    assert.equal((await call(port, "POST", "/_inbox/ready", { headers: { [INBOX_AUTH_HEADER]: SECRET } })).status, 405);
  });
});

test("a forwarded mutation is fenced by instance and draining state before any handler", async () => {
  await withBackend(async ({ port, backend }) => {
    backend.ready();
    const action = { "content-type": "application/json", "x-review-action": "1", host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    const body = JSON.stringify({ approve: true, reviewId: "review-1", backendInstanceId: backend.instanceId });
    // Without the frontdoor's instance header this is not a forwarded browser action.
    const bare = await call(port, "POST", "/api/reviews/agent-1/decision", { headers: action, body });
    assert.equal(bare.status, 400);
    assert.match(bare.text, /only served through the inbox frontdoor/);
    // A replaced backend refuses instead of receiving an action composed against its predecessor.
    const replaced = await call(port, "POST", "/api/reviews/agent-1/decision", { headers: { ...action, [INBOX_INSTANCE_HEADER]: "an-older-instance" }, body });
    assert.equal(replaced.status, 409);
    assert.match(replaced.text, /replaced/);
    // With the right instance the existing checked handler runs (here: no such review is listed).
    assert.equal((await call(port, "POST", "/api/reviews/agent-1/decision", { headers: { ...action, [INBOX_INSTANCE_HEADER]: backend.instanceId }, body })).status, 404);
    // Draining: nothing new is admitted, and no snapshot is captured from a closing backend.
    backend.draining();
    const draining = await call(port, "POST", "/api/reviews/agent-1/decision", { headers: { ...action, [INBOX_INSTANCE_HEADER]: backend.instanceId }, body });
    assert.equal(draining.status, 503);
    assert.match(draining.text, /draining/);
    assert.equal((await call(port, "GET", "/_inbox/snapshot", { headers: { [INBOX_AUTH_HEADER]: SECRET } })).status, 409);
    assert.equal(json((await call(port, "GET", "/_inbox/ready", { headers: { [INBOX_AUTH_HEADER]: SECRET } })).text).state, "draining");
  });
});

test("the activation protocol rides the same listener unfenced", async () => {
  await withBackend(async ({ port, counters }) => {
    const answer = await call(port, "POST", "/activation", { headers: { "content-type": "application/json", "x-paseo-activation": "shared" }, body: "{}" });
    assert.equal(answer.status, 200);
    assert.equal(json(answer.text).instance, null, "an activation never carries the mutation fence");
    assert.equal(counters.activations, 1);
  });
});

test("the browser-shaped checks stay in place behind the fence", async () => {
  await withBackend(async ({ links, port, backend }) => {
    backend.ready();
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", reviewId: "review-1" });
    const body = JSON.stringify({ approve: true, reviewId: "review-1", backendInstanceId: backend.instanceId });
    const fenced = { [INBOX_INSTANCE_HEADER]: backend.instanceId };
    assert.equal((await call(port, "POST", "/api/reviews/agent-1/decision", { headers: { "content-type": "application/json", "x-review-action": "1", host: `127.0.0.1:${port}`, origin: "https://evil.example", ...fenced }, body })).status, 403);
    assert.equal((await call(port, "POST", "/api/reviews/agent-1/decision", { headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...fenced }, body })).status, 403);
    const page = await call(port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /Plan reviews/);
  });
});

test("a new contribution always gets a new instance id", () => {
  const empty = { inbox: async () => ({ open: [], decided: [], applying: [], unreachable: [], hosts: [], push: false }), decisions: async () => ({ hosts: [], canonicalHost: null, unreachable: [] }) };
  assert.notEqual(new InboxBackend(empty).instanceId, new InboxBackend(empty).instanceId);
});
