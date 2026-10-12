// The persistent inbox frontdoor against a fake checked backend: pages keep answering while the
// backend stops and restarts, cached state is labelled stale and its actions blocked, recovery
// freshens the forms only after a live read, an admitted mutation whose acknowledgement is lost is
// reported unknown exactly once, the private routes stay private, and the activation protocol's
// headers and large body travel unchanged.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_ACTIVATION_BODY_BYTES } from "./activation";
import { startInboxFrontdoor, type InboxFrontdoor, type InboxFrontdoorOptions } from "./inbox-frontdoor";
import { INBOX_AUTH_HEADER, INBOX_DISPLAYED_HEADER, INBOX_INSTANCE_HEADER, type InboxAvailability } from "./inbox-transport";

const ORIGIN = "https://host.tail1.ts.net:8444";
const HOST = "host.tail1.ts.net:8444";
const SECRET = "test-backend-secret";

type Call = { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer };
type Fake = {
  port: number;
  settings: { instance: string; state: "starting" | "ready" | "draining"; hold: ((call: Call, response: ServerResponse) => boolean) | null; reviewStatus: number };
  calls: Call[];
  close(): Promise<void>;
};

function inboxView(): Record<string, unknown> {
  return {
    open: [{ agentId: "agent-1", name: "TUC-9 — plan", link: `${ORIGIN}/review/agent-1`, since: "2026-01-01T09:00:00.000Z", host: "laptop" }],
    decided: [], applying: [], unreachable: [], hosts: ["laptop"], push: false,
  };
}
function decisionView(): Record<string, unknown> {
  return { hosts: [{ host: "laptop", asks: [], live: [], history: [], updatedAt: "2026-01-01T09:00:00.000Z", error: null }], canonicalHost: "laptop", unreachable: [] };
}

async function fakeBackend(options: { instance?: string; port?: number } = {}): Promise<Fake> {
  const settings: Fake["settings"] = { instance: options.instance ?? randomUUID(), state: "ready", hold: null, reviewStatus: 302 };
  const calls: Call[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const call: Call = { method: incoming.method ?? "GET", path: incoming.url ?? "/", headers: incoming.headers, body: Buffer.concat(chunks) };
      calls.push(call);
      const path = new URL(call.path, "http://localhost").pathname;
      if (settings.hold?.(call, response)) return;
      const json = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      switch (path) {
        case "/_inbox/ready":
          if (call.headers[INBOX_AUTH_HEADER] !== SECRET) return json(401, { error: "Not allowed." });
          return json(200, { protocolVersion: 1, instanceId: settings.instance, state: settings.state });
        case "/_inbox/snapshot":
          if (call.headers[INBOX_AUTH_HEADER] !== SECRET) return json(401, { error: "Not allowed." });
          return json(200, { protocolVersion: 1, instanceId: settings.instance, capturedAt: new Date().toISOString(), inbox: inboxView(), decisions: decisionView() });
        case "/api/inbox":
          return json(200, { host: "laptop", open: [], decided: [], applying: [], pipeline: null });
        case "/api/decisions/local":
          return json(200, decisionView());
        case "/api/push/key":
          return json(200, { publicKey: "key" });
        case "/activation":
          return json(200, { ok: true, received: call.body.length });
        case "/activation/health":
          return json(200, { ok: true });
        default:
          break;
      }
      if (/^\/api\/reviews\/[^/]+\/decision$/.test(path)) return json(200, { ok: true });
      if (/^\/plannotator\/[0-9a-f]{64}\.(?:js|css)$/.test(path)) {
        const br = /\bbr\b/i.test(String(call.headers["accept-encoding"] ?? ""));
        const body = br ? Buffer.from("brotli-bytes") : Buffer.from("console.log('plannotator')");
        return response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", vary: "Accept-Encoding", ...(br ? { "content-encoding": "br" } : {}) }).end(body);
      }
      if (path.startsWith("/review/")) return response.writeHead(settings.reviewStatus, { location: "https://host.tail1.ts.net:50001/?r=1" }).end(settings.reviewStatus === 302 ? "" : "closed");
      return json(404, { error: "no such route" });
    });
  });
  await listenOn(server, options.port);
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port: (server.address() as AddressInfo).port, settings, calls, close };
}

// Rebinding the same loopback port right after a close is the fake plugin's own "restart on
// 47834"; the kernel may need a moment, so a bind conflict is retried, never a different port.
async function listenOn(server: Server, port?: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(port ?? 0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
      });
      return;
    } catch (error) {
      if (port === undefined || (error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

type Answer = { status: number; headers: IncomingHttpHeaders; text: string; body: Buffer };
function call(port: number, method: string, path: string, options: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: options.headers ?? {} }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => { const body = Buffer.concat(chunks); resolve({ status: response.statusCode ?? 0, headers: response.headers, text: body.toString("utf8"), body }); });
    });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

// A browser-shaped mutation: the page's own displayed epoch travels with it (the frontdoor forwards
// exactly that instance, so a caller may override it to prove an older page is refused).
async function mutation(port: number, body: unknown = { approve: true }, headers: Record<string, string> = {}): Promise<Answer> {
  const displayed = headers[INBOX_DISPLAYED_HEADER] ?? (await readAvailability(port)).displayedInstanceId ?? "";
  return call(port, "POST", "/api/reviews/agent-1/decision", {
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-review-action": "1", [INBOX_DISPLAYED_HEADER]: displayed, ...headers },
    body: JSON.stringify(body),
  });
}

// Parsed JSON at the boundary: the shallow shape the assertions need, read as an indexable record.
function jsonBody(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const readAvailability = async (port: number): Promise<InboxAvailability> => {
  const answer = await call(port, "GET", "/api/inbox/availability");
  // The route's envelope, read as its declared shape; the assertions are what check its values.
  const envelope: InboxAvailability = JSON.parse(answer.text) as InboxAvailability;
  return envelope;
};

function frontdoorOptions(backendPort: number, stateDirectory: string, overrides: Partial<InboxFrontdoorOptions> = {}): InboxFrontdoorOptions {
  return {
    port: 0, backendPort, publicOrigin: ORIGIN, stateDirectory, credentialFile: join(stateDirectory, "backend-secret"),
    probeMs: 25, refreshMs: 50, probeDeadlineMs: 400, snapshotDeadlineMs: 800, mutationDeadlineMs: 600, readDeadlineMs: 600, assetDeadlineMs: 600,
    ...overrides,
  };
}

// A temporary credential next to the state directory, the same private file both processes share.
function withFrontdoor(fake: Fake, run: (frontdoor: InboxFrontdoor, directory: string) => Promise<void>, overrides: Partial<InboxFrontdoorOptions> = {}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "paseo-inbox-frontdoor-"));
  mkdirSync(join(directory, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "state", "backend-secret"), SECRET, { mode: 0o600 });
  return (async () => {
    const frontdoor = await startInboxFrontdoor(frontdoorOptions(fake.port, join(directory, "state"), overrides));
    try { await run(frontdoor, join(directory, "state")); } finally {
      await frontdoor.close();
      await fake.close();
      rmSync(directory, { recursive: true, force: true });
    }
  })();
}

test("close drains an admitted snapshot read before its cache can be removed", async () => {
  const fake = await fakeBackend();
  let captured!: (response: ServerResponse) => void;
  const pending = new Promise<ServerResponse>((resolve) => { captured = resolve; });
  fake.settings.hold = (call, response) => {
    if (call.path !== "/_inbox/snapshot") return false;
    captured(response);
    return true;
  };
  await withFrontdoor(fake, async (frontdoor, state) => {
    const response = await pending;
    let closed = false;
    const closing = frontdoor.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "shutdown waits for the admitted read");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      protocolVersion: 1, instanceId: fake.settings.instance, capturedAt: new Date().toISOString(),
      inbox: inboxView(), decisions: decisionView(),
    }));
    await closing;
    const saved = jsonBody(readFileSync(join(state, "snapshot.json"), "utf8"));
    assert.equal(saved.instanceId, fake.settings.instance);
    assert.equal(saved.origin, ORIGIN);
  });
});

test("serves the existing pages from a live snapshot and forwards what it checked", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    const page = await call(frontdoor.port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /TUC-9 — plan/);
    assert.match(page.text, /data-readonly="0"/);
    assert.match(page.text, /<button type="button" class="approve" data-act="approve">Approve<\/button>/);
    const decisions = await call(frontdoor.port, "GET", "/decisions");
    assert.equal(decisions.status, 200);
    assert.match(decisions.text, /"canonicalHost":"laptop"/);
    const envelope = jsonBody((await call(frontdoor.port, "GET", "/api/decisions")).text);
    assert.equal((envelope.hosts as unknown[]).length, 1);
    assert.equal((envelope.availability as InboxAvailability).stale, false);
    // Availability metadata stays outside the host objects the strict peer and page clients parse.
    assert.equal(JSON.stringify(envelope.hosts).includes("availability"), false);
    // A same-origin mutation is forwarded exactly once with the instance the page was shown from.
    assert.equal((await mutation(frontdoor.port)).status, 200);
    const forwarded = fake.calls.filter((item) => item.path === "/api/reviews/agent-1/decision");
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].headers[INBOX_INSTANCE_HEADER], fake.settings.instance);
    assert.equal(forwarded[0].headers[INBOX_AUTH_HEADER], SECRET);
    assert.equal(forwarded[0].headers.origin, ORIGIN);
    assert.equal(forwarded[0].headers.host, HOST);
    assert.equal(forwarded[0].headers["x-review-action"], "1");
  });
});

test("keeps answering while the backend is away, marks the cache stale and blocks every action", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor, state) => {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    await fake.close();
    await until(async () => (await readAvailability(frontdoor.port)).backendState === "unavailable");
    const page = await call(frontdoor.port, "GET", "/");
    assert.equal(page.status, 200, "the review page keeps answering during the outage");
    assert.match(page.text, /data-readonly="1"/);
    assert.match(page.text, /<b>Backend unavailable<\/b> — cached snapshot from/);
    assert.match(page.text, /<button type="button" class="approve" data-act="approve" disabled data-gate="1">/);
    assert.equal(/<button type="button" class="approve" data-act="approve">/.test(page.text), false, "no action control stays enabled");
    const decisions = await call(frontdoor.port, "GET", "/decisions");
    assert.equal(decisions.status, 200, "the decision page keeps answering during the outage");
    assert.match(decisions.text, /"readOnly":true/, "the decision page carries the unavailable gate the client disables actions with");
    // Peer reads and live-only routes are never answered from the cache.
    assert.equal((await call(frontdoor.port, "GET", "/api/inbox")).status, 503);
    assert.equal((await call(frontdoor.port, "GET", "/api/decisions/local")).status, 503);
    assert.equal((await call(frontdoor.port, "GET", "/api/push/key")).status, 503);
    const refused = jsonBody((await mutation(frontdoor.port)).text);
    assert.equal(refused.outcomeUnknown ?? false, false, "a pre-dispatch refusal is not an unknown outcome");
    const activation = await call(frontdoor.port, "POST", "/activation", { headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(activation.status, 503);
    const cache = jsonBody(readFileSync(join(state, "snapshot.json"), "utf8"));
    assert.equal(cache.origin, ORIGIN);
    assert.equal(cache.version, 1);
  });
});

test("a restarted backend on its port brings the actions back only after a live read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-inbox-frontdoor-"));
  const state = join(directory, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "backend-secret"), SECRET, { mode: 0o600 });
  const first = await fakeBackend();
  let frontdoor: InboxFrontdoor | null = null;
  let second: Fake | null = null;
  try {
    frontdoor = await startInboxFrontdoor(frontdoorOptions(first.port, state));
    await until(async () => (await readAvailability(frontdoor!.port)).stale === false);
    await first.close();
    await until(async () => (await readAvailability(frontdoor!.port)).stale === true);
    assert.match((await call(frontdoor.port, "GET", "/")).text, /data-readonly="1"/);
    // The plugin comes back on its port with a new contribution (a new instance id).
    second = await fakeBackend({ port: first.port });
    await until(async () => (await readAvailability(frontdoor!.port)).stale === false);
    assert.equal(second.port, first.port);
    const page = await call(frontdoor.port, "GET", "/");
    assert.match(page.text, /data-readonly="0"/);
    assert.match(page.text, /<button type="button" class="approve" data-act="approve">Approve<\/button>/);
    assert.equal((await mutation(frontdoor.port)).status, 200);
    const forwarded = second.calls.filter((item) => item.path === "/api/reviews/agent-1/decision");
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].headers[INBOX_INSTANCE_HEADER], second.settings.instance);
  } finally {
    await frontdoor?.close();
    await first.close().catch(() => {});
    await second?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a replaced backend refuses the displayed page's action instead of rebinding it", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    // The plugin reloaded: same port, new contribution, new instance id. The page still displays the
    // previous instance's snapshot, so its action carries that displayed epoch -- not the ready one.
    const displayedBefore = (await readAvailability(frontdoor.port)).displayedInstanceId;
    assert.ok(displayedBefore);
    fake.settings.instance = randomUUID();
    const refused = await mutation(frontdoor.port, { approve: true }, { [INBOX_DISPLAYED_HEADER]: displayedBefore });
    assert.equal(refused.status, 409);
    assert.equal(jsonBody(refused.text).outcomeUnknown ?? false, false);
    assert.equal(fake.calls.filter((item) => item.path === "/api/reviews/agent-1/decision").length, 0, "nothing reached the replacement backend");
    // After the page's own refresh the action goes to the instance that is ready now.
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    assert.equal((await mutation(frontdoor.port)).status, 200);
    assert.equal(fake.calls.filter((item) => item.path === "/api/reviews/agent-1/decision")[0].headers[INBOX_INSTANCE_HEADER], fake.settings.instance);
  });
});

test("an admitted mutation whose acknowledgement is lost is unknown and is never retried", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    // Received, never answered: the plugin may be working on it. Only the decision is parked, so
    // the page's own readiness checks keep answering and the action stays admitted.
    fake.settings.hold = (call) => call.path.endsWith("/decision");
    const lost = await mutation(frontdoor.port);
    assert.equal(lost.status, 502);
    const answer = jsonBody(lost.text);
    assert.equal(answer.outcomeUnknown, true);
    assert.match(String(answer.error), /not retried/);
    fake.settings.hold = null;
    // Ordinary page and availability traffic never replays the mutation.
    await call(frontdoor.port, "GET", "/");
    await readAvailability(frontdoor.port);
    assert.equal(fake.calls.filter((item) => item.path === "/api/reviews/agent-1/decision").length, 1);
  });
});

test("an action is only admitted for the instance its page displayed", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    const displayed = (await readAvailability(frontdoor.port)).displayedInstanceId;
    assert.ok(displayed);
    // A page that never carried a displayed epoch (an old page, or a hand-made request) is refused
    // before anything is dispatched or any private credential is used.
    const anonymous = await mutation(frontdoor.port, { approve: true }, { [INBOX_DISPLAYED_HEADER]: "" });
    assert.equal(anonymous.status, 409);
    const foreign = await mutation(frontdoor.port, { approve: true }, { [INBOX_DISPLAYED_HEADER]: "another-instance" });
    assert.equal(foreign.status, 409);
    assert.equal(fake.calls.filter((item) => item.path === "/api/reviews/agent-1/decision").length, 0, "nothing reached the backend");
    // The displayed instance is what the backend is asked to admit, and the only fence it sees.
    assert.equal((await mutation(frontdoor.port)).status, 200);
    const forwarded = fake.calls.filter((item) => item.path === "/api/reviews/agent-1/decision");
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].headers[INBOX_INSTANCE_HEADER], displayed);
    assert.equal(forwarded[0].headers[INBOX_DISPLAYED_HEADER], undefined, "the public epoch is not a fence the backend reads");
  });
});

test("a request line cannot pick what the backend is asked for", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    // Absolute-form and protocol-relative targets are normalized to the origin-form the backend
    // is asked for; the backend is always 127.0.0.1:47834, never the host in the request line.
    for (const target of ["http://elsewhere.example/api/inbox", "//elsewhere.example/api/inbox"]) {
      const answer = await call(frontdoor.port, "GET", target, { headers: { host: HOST } });
      assert.equal(answer.status, 200, target);
      assert.match(answer.text, /"host":"laptop"/, target);
    }
    const forwarded = fake.calls.filter((item) => item.path === "/api/inbox");
    assert.equal(forwarded.length, 2);
    assert.equal(fake.calls.some((item) => item.path.startsWith("http")), false);
  });
});

test("the private backend routes are not part of the public surface", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    for (const path of ["/_inbox", "/_inbox/ready", "/_inbox/snapshot", "/_inbox/snapshot?instance=x"]) {
      assert.equal((await call(frontdoor.port, "GET", path, { headers: { [INBOX_AUTH_HEADER]: SECRET } })).status, 404, path);
    }
    // Even a forged credential is useless: the routes only exist on the loopback backend.
    assert.equal((await call(frontdoor.port, "GET", "/_inbox/ready", { headers: { [INBOX_AUTH_HEADER]: "guess" } })).status, 404);
  });
});

test("activation keeps its routes, methods, headers and large body", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    const payload = JSON.stringify({ text: "x".repeat(300_000) });
    const answer = await call(frontdoor.port, "POST", "/activation", {
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-paseo-activation": "secret-value", [INBOX_AUTH_HEADER]: "caller-copy", [INBOX_INSTANCE_HEADER]: "caller-copy" },
      body: payload,
    });
    assert.equal(answer.status, 200);
    assert.equal(jsonBody(answer.text).received, Buffer.byteLength(payload));
    const delivered = fake.calls.find((item) => item.path === "/activation");
    assert.ok(delivered);
    assert.equal(delivered.body.toString("utf8"), payload);
    assert.equal(delivered.headers["x-paseo-activation"], "secret-value");
    assert.equal(delivered.headers.host, HOST);
    assert.equal(delivered.headers.origin, ORIGIN);
    // Caller-supplied copies of the private fence headers never travel.
    assert.equal(delivered.headers[INBOX_AUTH_HEADER], undefined);
    assert.equal(delivered.headers[INBOX_INSTANCE_HEADER], undefined);
    // The health route keeps its method and its own authentication.
    assert.equal((await call(frontdoor.port, "GET", "/activation/health")).status, 200);
    assert.equal(fake.calls.find((item) => item.path === "/activation/health")?.method, "GET");
    // The activation limit (512,000 bytes) is preserved, not the small JSON one, and the refusal is
    // readable rather than an opaque reset.
    assert.equal((await call(frontdoor.port, "POST", "/activation", { headers: { "content-type": "application/json" }, body: "y".repeat(512_001) })).status, 413);
    assert.equal((await call(frontdoor.port, "POST", "/api/decisions/action", { headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-review-action": "1" }, body: "z".repeat(16_385) })).status, 413);
    assert.equal(fake.calls.some((item) => item.body.length > MAX_ACTIVATION_BODY_BYTES || (item.path === "/api/decisions/action" && item.body.length > 16_384)), false, "an oversize body never reaches the checked backend");
  });
});

test("mutations from another origin, without the custom header or off the allowed host are refused", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    assert.equal((await mutation(frontdoor.port, { approve: true }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await mutation(frontdoor.port, { approve: true }, { "x-review-action": "" })).status, 403);
    assert.equal((await mutation(frontdoor.port, { approve: true }, { host: "elsewhere.example:8444", origin: "https://elsewhere.example:8444" })).status, 403);
    assert.equal((await mutation(frontdoor.port, { approve: true }, { "content-type": "text/plain" })).status, 403);
    assert.equal(fake.calls.filter((item) => item.path === "/api/reviews/agent-1/decision").length, 0);
  });
});

test("the snapshot cache is private, scoped and always stale after a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-inbox-frontdoor-"));
  const state = join(directory, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "backend-secret"), SECRET, { mode: 0o600 });
  const fake = await fakeBackend();
  let frontdoor: InboxFrontdoor | null = null;
  try {
    frontdoor = await startInboxFrontdoor(frontdoorOptions(fake.port, state));
    await until(async () => (await readAvailability(frontdoor!.port)).stale === false);
    const record = jsonBody(readFileSync(join(state, "snapshot.json"), "utf8"));
    assert.equal(record.version, 1);
    assert.equal(record.origin, ORIGIN);
    assert.equal(record.instanceId, fake.settings.instance);
    assert.equal(statSync(join(state, "snapshot.json")).mode & 0o777, 0o600);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    await frontdoor.close();
    // A restart with the backend gone: the cached rows are shown, labelled with their capture time
    // and read-only; they are never presented as current.
    await fake.close();
    frontdoor = await startInboxFrontdoor(frontdoorOptions(fake.port, state));
    const page = await call(frontdoor.port, "GET", "/");
    assert.match(page.text, /TUC-9 — plan/);
    assert.match(page.text, /data-readonly="1"/);
    assert.match(page.text, /cached snapshot from/);
    const live = await readAvailability(frontdoor.port);
    assert.equal(live.readOnly, true);
    assert.equal(live.stale, true);
    assert.equal(live.capturedAt, record.capturedAt);
    await frontdoor.close();
    // A cache scoped to another origin is refused.
    writeFileSync(join(state, "snapshot.json"), JSON.stringify({ ...record, origin: "https://other.tail1.ts.net:8444" }));
    frontdoor = await startInboxFrontdoor(frontdoorOptions(fake.port, state));
    assert.match((await call(frontdoor.port, "GET", "/")).text, /Inbox contents unknown/);
    await frontdoor.close();
    // A corrupt cache is refused the same way.
    writeFileSync(join(state, "snapshot.json"), "{not json");
    frontdoor = await startInboxFrontdoor(frontdoorOptions(fake.port, state));
    assert.match((await call(frontdoor.port, "GET", "/")).text, /No snapshot received/);
  } finally {
    await frontdoor?.close();
    await fake.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test("immutable assets survive a backend restart from the bounded cache", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    const name = `${createHash("sha256").update("app").digest("hex")}.js`;
    const first = await call(frontdoor.port, "GET", `/plannotator/${name}`, { headers: { "accept-encoding": "br" } });
    assert.equal(first.status, 200);
    assert.equal(first.headers["content-encoding"], "br");
    assert.equal(first.text, "brotli-bytes");
    await fake.close();
    const cached = await call(frontdoor.port, "GET", `/plannotator/${name}`, { headers: { "accept-encoding": "br" } });
    assert.equal(cached.status, 200);
    assert.equal(cached.text, "brotli-bytes");
    assert.equal(cached.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal((await call(frontdoor.port, "GET", `/plannotator/${createHash("sha256").update("other").digest("hex")}.js`)).status, 503);
  });
});

test("review links pass through while the plugin is there and get a labelled card while it is away", async () => {
  const fake = await fakeBackend();
  await withFrontdoor(fake, async (frontdoor) => {
    const redirect = await call(frontdoor.port, "GET", "/review/agent-1");
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, "https://host.tail1.ts.net:50001/?r=1");
    fake.settings.reviewStatus = 404;
    assert.equal((await call(frontdoor.port, "GET", "/review/agent-1")).status, 404);
    await fake.close();
    const offline = await call(frontdoor.port, "GET", "/review/agent-1");
    assert.equal(offline.status, 200);
    assert.match(offline.text, /Review closed — unavailable/);
  });
});

test("a busy listener is an explicit startup failure that never displaces the current owner", async () => {
  const fake = await fakeBackend();
  const directory = mkdtempSync(join(tmpdir(), "paseo-inbox-frontdoor-"));
  try {
    const owner = createServer(() => {});
    await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
    const port = (owner.address() as AddressInfo).port;
    await assert.rejects(startInboxFrontdoor(frontdoorOptions(fake.port, directory, { port })), /already in use/);
    assert.ok(owner.listening, "the current owner keeps its port");
    await new Promise<void>((resolve) => owner.close(() => resolve()));
  } finally {
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("without any snapshot the shell says the contents are unknown", async () => {
  const fake = await fakeBackend();
  await fake.close();
  await withFrontdoor(fake, async (frontdoor) => {
    const page = await call(frontdoor.port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /Inbox contents unknown/);
    assert.match(page.text, /No snapshot received/);
    assert.equal(/data-act="approve">/.test(page.text), false);
    const decisions = await call(frontdoor.port, "GET", "/decisions");
    assert.match(decisions.text, /"readOnly":true/);
    assert.match(decisions.text, /"capturedAt":null/);
    assert.match(decisions.text, /No checked inbox backend/, "the page says why nothing is shown");
  });
});

test("a missing credential is reported, never guessed, and the cache stays writable for the next service", async () => {
  const fake = await fakeBackend();
  const directory = mkdtempSync(join(tmpdir(), "paseo-inbox-frontdoor-"));
  try {
    const frontdoor = await startInboxFrontdoor(frontdoorOptions(fake.port, directory));
    await until(async () => (await readAvailability(frontdoor.port)).backendState === "unavailable");
    assert.match(String((await readAvailability(frontdoor.port)).reason), /credential/);
    await frontdoor.close();
    // The plugin (or the installer) creates the credential later; a new service start picks it up.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "backend-secret"), SECRET, { mode: 0o600 });
    const recovered = await startInboxFrontdoor(frontdoorOptions(fake.port, directory));
    await until(async () => (await readAvailability(recovered.port)).stale === false);
    await recovered.close();
  } finally {
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the cache file and its directory keep the promised modes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-inbox-frontdoor-"));
  const state = join(directory, "state");
  mkdirSync(state, { recursive: true });
  chmodSync(state, 0o700);
  writeFileSync(join(state, "backend-secret"), SECRET, { mode: 0o600 });
  const fake = await fakeBackend();
  const frontdoor = await startInboxFrontdoor(frontdoorOptions(fake.port, state));
  try {
    await until(async () => (await readAvailability(frontdoor.port)).stale === false);
    assert.equal(statSync(join(state, "snapshot.json")).mode & 0o777, 0o600);
    assert.equal(statSync(state).mode & 0o777, 0o700);
  } finally {
    await frontdoor.close();
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
