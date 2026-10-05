import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { OpenedEvent } from "./plannotator";
import { planDetails, ReviewLinks } from "./review-links";

const ORIGIN = "https://host.tail1.ts.net:8444";

function opened(port: number): OpenedEvent {
  return { type: "opened", agentId: "agent-1", localUrl: `http://localhost:${port}/?r=1`, remoteUrl: `https://host.tail1.ts.net:${port}/?r=1`, at: "t" };
}

const RISK = (impact: number, reversibility = "revert", newRule = "no — none") => `## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: ${impact} — why\n- Reversibility: ${reversibility} — why\n- Feature flag: no\n- Migration: no\n- Auth: no\n- New rule: ${newRule}\n- Failure mode: a wrong column\n- Advisor rating: impact ${impact}, reversibility ${reversibility}\n- Recommendation: auto — routine\n`;

// `live` holds the local ports whose Plannotator server answers; `unserved` the routes turned off;
// `plans` the plan text each port's server returns; `routed` the routes pointed at the proxy;
// `setNow` moves the clock (each reading advances it by a second). Times show in Berlin time.
async function withLinks(run: (links: ReviewLinks, get: (path: string, method?: string) => Promise<Response>, live: Set<number>, unserved: number[], plans: Map<number, string>, routed: number[], setNow: (iso: string) => void) => Promise<void>, unserveError?: (port: number) => Error | null) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const live = new Set<number>();
  const unserved: number[] = [];
  const plans = new Map<number, string>();
  const routed: number[] = [];
  let clock = Date.parse("2026-01-01T10:00:00Z");
  const links = new ReviewLinks({
    port: 0, proxyPort: 0, file: join(directory, "reviews.json"), sweepMs: 3_600_000, timeZone: "Europe/Berlin",
    now: () => new Date(clock += 1_000),
    alive: async (localUrl) => live.has(Number(new URL(localUrl).port)),
    serve: async () => ORIGIN,
    unserve: async (port) => {
      unserved.push(port);
      const error = unserveError?.(port);
      if (error) throw error;
    },
    route: async (port) => { routed.push(port); },
    fetchPlan: async (localUrl) => plans.get(Number(new URL(localUrl).port)) ?? "",
  });
  try {
    await links.start();
    const get = (path: string, method = "GET") => fetch(`http://127.0.0.1:${links.listeningPort}${path}`, { method, redirect: "manual" });
    await run(links, get, live, unserved, plans, routed, (iso) => { clock = Date.parse(iso); });
  } finally {
    links.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

const PAGE = `<!doctype html>${"<p>A plan review page.</p>".repeat(40_000)}`;

// A stand-in Plannotator server: its big page, an event stream that stays open, a binary file,
// and WebSockets that echo.
async function withBackend(run: (port: number) => Promise<void>) {
  const server = createServer((incoming, response) => {
    if (incoming.url === "/") { response.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(PAGE) }).end(PAGE); return; }
    if (incoming.url === "/api/stream") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: first\n\n"); return; }
    if (incoming.url === "/logo.png") { response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([137, 80, 78, 71])); return; }
    response.writeHead(404).end();
  });
  server.on("upgrade", (_incoming, socket: Socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(data));
    socket.on("end", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function reviewAt(port: number, agentId = "agent-1"): OpenedEvent {
  return { type: "opened", agentId, localUrl: `http://localhost:${port}/`, remoteUrl: `https://host.tail1.ts.net:${port}/`, at: "t" };
}

// A request as `tailscale serve` forwards it: the tailnet host and port in the Host header.
async function viaProxy(links: ReviewLinks, host: string, path: string, acceptEncoding?: string): Promise<IncomingMessage> {
  const outgoing = request({ host: "127.0.0.1", port: links.listeningProxyPort!, path, headers: { host, ...(acceptEncoding ? { "accept-encoding": acceptEncoding } : {}) } });
  outgoing.end();
  const [response] = await once(outgoing, "response") as [IncomingMessage];
  return response;
}

async function body(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Sends a WebSocket upgrade through the proxy; resolves with the socket once the reply is read.
async function upgradeViaProxy(links: ReviewLinks, host: string): Promise<{ socket: Socket; reply: string }> {
  const socket = connect(links.listeningProxyPort!, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  const [reply] = await once(socket, "data") as [Buffer];
  return { socket, reply: reply.toString() };
}

test("a live review redirects the agent's stable link to the review's tailnet URL", async () => {
  await withLinks(async (links, get, live) => {
    live.add(50_001);
    assert.equal(await links.opened("agent-1", opened(50_001), "TUC-1"), `${ORIGIN}/review/agent-1`);
    const response = await get("/review/agent-1");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://host.tail1.ts.net:50001/?r=1");
  });
});

test("a review whose server stopped shows the closed page with its outcome", async () => {
  await withLinks(async (links, get) => {
    await links.opened("agent-1", opened(50_001), "<TUC-1>");
    await links.decided("agent-1", false);
    const response = await get("/review/agent-1");
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /sent back/);
    assert.match(page, /&#60;TUC-1&#62;/);
  });
});

test("a new review for the same agent takes over its stable link", async () => {
  await withLinks(async (links, get, live) => {
    live.add(50_001).add(50_002);
    await links.opened("agent-1", opened(50_001));
    await links.opened("agent-1", opened(50_002));
    assert.equal((await get("/review/agent-1")).headers.get("location"), "https://host.tail1.ts.net:50002/?r=1");
  });
});

test("the sweep removes only dead review routes, and only after two misses", async () => {
  await withLinks(async (links, get, live, unserved) => {
    live.add(50_002);
    await links.opened("agent-1", opened(50_001));
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" });
    await links.sweep();
    assert.deepEqual(unserved, []);
    await links.sweep();
    assert.deepEqual(unserved, [50_001]);
    await links.sweep();
    assert.deepEqual(unserved, [50_001]);
    // Closed, so the link no longer redirects even if the port comes back.
    live.add(50_001);
    assert.equal((await get("/review/agent-1")).status, 200);
    assert.equal((await get("/review/agent-2")).status, 302);
  });
});

test("a route that is already gone counts as removed; any other failure is retried on the next sweep", async () => {
  const gone = new Error("Command failed: tailscale serve --https=50001 off\nerror: failed to remove web serve: handler does not exist");
  const down = new Error("Command failed: tailscale serve --https=50002 off\nfailed to connect to local tailscaled");
  await withLinks(async (links, _get, _live, unserved) => {
    await links.opened("agent-1", opened(50_001));
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" });
    await links.sweep();
    await links.sweep();
    assert.deepEqual(unserved.sort(), [50_001, 50_002]);
    unserved.length = 0;
    await links.sweep();
    assert.deepEqual(unserved, [50_002], "the missing route is closed; the failed one is tried again");
  }, (port) => (port === 50_001 ? gone : down));
});

test("unknown agents and malformed ids are 404; other methods are refused", async () => {
  await withLinks(async (links, get) => {
    await links.opened("agent-1", opened(50_001));
    assert.equal((await get("/review/nobody")).status, 404);
    assert.equal((await get("/review/a.b")).status, 404);
    assert.equal((await get("/nothing")).status, 404);
    assert.equal((await get("/review/agent-1", "POST")).status, 405);
    assert.equal((await get("/", "POST")).status, 405);
  });
});

test("the inbox lists only reviews the owner can open now, newest first, and the latest decisions", async () => {
  await withLinks(async (links, get, live) => {
    live.add(50_001).add(50_002).add(50_003).add(50_005);
    await links.opened("agent-1", opened(50_001), "TUC-1");
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, "<TUC-2>");
    // Superseded by the same agent's newer review: only the newer one is listed.
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, "TUC-3-old");
    await links.opened("agent-3", { ...opened(50_005), agentId: "agent-3" }, "TUC-3");
    // Not answering any more (not yet swept), and local-only: neither can be opened from a phone.
    await links.opened("agent-4", { ...opened(50_004), agentId: "agent-4" }, "TUC-4");
    await links.opened("agent-5", { ...opened(50_006), agentId: "agent-5", remoteUrl: null }, "TUC-5");
    live.add(50_006);
    // Decided and closed: listed under recent decisions instead.
    await links.opened("agent-6", { ...opened(50_007), agentId: "agent-6" }, "TUC-6");
    await links.decided("agent-6", true);
    await links.sweep();
    await links.sweep();

    const response = await get("/");
    assert.equal(response.status, 200);
    const page = await response.text();
    const [waiting, recent] = page.split("Recently decided");
    const listed = [...waiting.matchAll(/href="\/review\/([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(listed, ["agent-3", "agent-2", "agent-1"]);
    assert.match(waiting, /&#60;TUC-2&#62;/);
    assert.doesNotMatch(page, /TUC-3-old/);
    assert.match(recent, /TUC-6/);
    assert.match(recent, /approved/);
    assert.match(recent, /TUC-4/, "the dead review was closed by the sweep");
    assert.doesNotMatch(page, /TUC-5/);
  });
});

test("waiting reviews show when the owner got them, grouped by the owner's calendar day, with the oldest age in the header", async () => {
  await withLinks(async (links, get, live, _unserved, _plans, _routed, setNow) => {
    live.add(50_001).add(50_002).add(50_004);
    // 23:30 UTC on 1 Jan is already 2 Jan in Berlin; 22:30 UTC is still 1 Jan there.
    setNow("2026-01-01T23:30:00Z");
    await links.opened("agent-1", opened(50_001), "TUC-1");
    setNow("2026-01-01T22:30:00Z");
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, "TUC-2");
    setNow("2025-12-29T09:00:00Z");
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, "TUC-3");
    // Served again after a restart: it keeps the time the owner got it, and the new server.
    setNow("2026-01-02T08:00:00Z");
    await links.opened("agent-3", { ...opened(50_004), agentId: "agent-3" }, "TUC-3", "2025-12-29T09:00:00.000Z");
    setNow("2026-01-02T09:00:00Z");

    const page = await (await get("/")).text();
    const order = [...page.matchAll(/<h3>([^<]+)<\/h3>|href="\/review\/([^"]+)"/g)].map((match) => match[1] ?? match[2]);
    assert.deepEqual(order, ["Today", "agent-1", "Yesterday", "agent-2", "Mon, 29 Dec 2025", "agent-3"]);
    assert.match(page, /<span class="when">[^]*?>00:30<\/time> · 9 h<\/span>/, "opened 00:30 Berlin time, waiting 9 h");
    assert.match(page, /<span class="when stale">[^]*?>10:00<\/time> · 4 d<\/span>/, "a review waiting over 12 h is highlighted");
    assert.match(page, /3 waiting · oldest 4 d · updated 10:00/);
    assert.equal((await get("/review/agent-3")).headers.get("location"), "https://host.tail1.ts.net:50004/?r=1");
  });
});

test("the inbox says so when nothing is waiting", async () => {
  await withLinks(async (_links, get) => {
    assert.match(await (await get("/")).text(), /Nothing to review/);
  });
});

test("inbox rows show the plan's title, opening paragraph, risk rating and why it needs the owner", async () => {
  await withLinks(async (links, get, live, _unserved, plans) => {
    live.add(50_001).add(50_002).add(50_003);
    await links.opened("agent-1", opened(50_001), "TUC-1");
    const reach = "## Reach\n\n- Changes: date warnings\n- Delivery notes: include — AC-1\n- Help page: follow-up — Document the delay warning\n- Mobile app: follow-up — Warn on mobile too\n\n";
    await links.described("http://localhost:50001/?r=1", `# TUC-1 — Warn when a <delay> breaks a date\n\n## Summary\n\nWhen a **container** is late, the [sales](https://x) team gets a notice.\n\n${reach}${RISK(3, "data-fix", "yes — every late date warns")}`, { approved: false, reasons: ["impact 3 is above the threshold 1", "reversibility is data-fix", "it sets a new rule"] });
    // Opened before the plugin recorded details: read from its running server when the inbox loads.
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, "TUC-2");
    plans.set(50_002, `# TUC-2 · Report column\n\n| a | b |\n|---|---|\n\nAdds a column to the order report.\n\n${RISK(1)}`);
    // Decided while its server still answers: not waiting any more.
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, "TUC-3");
    await links.described("http://localhost:50003/?r=1", `# TUC-3 Tooling\n\nCI only.\n\n## Reach\n\n- Changes: CI\n- Deploy script: follow-up — Use the new check in deploys\n\n${RISK(0, "revert", "yes — every job runs the check")}`, { approved: true, reasons: [] });
    await links.decided("agent-3", true);

    const page = await (await get("/")).text();
    const [waiting, recent] = page.split("Recently decided");
    assert.deepEqual([...waiting.matchAll(/href="\/review\/([^"]+)"/g)].map((match) => match[1]), ["agent-2", "agent-1"]);
    const [second, first] = waiting.split('href="/review/').slice(1);
    assert.match(first, /<div class="title">Warn when a &#60;delay&#62; breaks a date<\/div>/);
    assert.match(first, /<div class="summary">When a container is late, the sales team gets a notice\.<\/div>/);
    assert.match(first, /<span class="chip high">Risk: impact 3\/4 · data-fix<\/span><span class="chip">2 follow-ups<\/span><span class="chip mid">new rule<\/span>/);
    assert.match(first, /Needs you:<\/b> impact 3 is above the threshold 1; reversibility is data-fix; it sets a new rule/);
    assert.match(second, /<div class="title">Report column<\/div><div class="summary">Adds a column to the order report\.<\/div>/);
    assert.match(second, /<div class="chips"><span class="chip low">Risk: impact 1\/4 · revert<\/span><\/div>/, "a plan without follow-ups or a rule shows neither chip");
    assert.match(recent, /TUC-3<\/span><span class="outcome">auto-approved/);
    assert.match(recent, /<div class="title">Tooling<\/div><div class="chips"><span class="chip low">Risk: impact 0\/4 · revert<\/span><span class="chip">1 follow-up<\/span><span class="chip mid">new rule<\/span><\/div>/);
    assert.doesNotMatch(recent, /CI only/, "decided rows stay one-glance");
  });
});

test("plan details tolerate plans without a title, summary or rating", () => {
  assert.deepEqual(planDetails("", "TUC-1"), { title: null, summary: null, risk: null });
  assert.deepEqual(planDetails("# TUC-1\n\n## Steps\n\n```ts\ncode\n```\n", "TUC-1"), { title: null, summary: null, risk: null });
  const long = planDetails(`# Plan\n\n${"word ".repeat(100)}\n`);
  assert.equal(long.title, "Plan");
  assert.ok(long.summary && long.summary.length <= 281 && long.summary.endsWith("word…"));
});

test("a review page reaches the tailnet compressed, brotli or gzip as the browser accepts, and identical once decoded", async () => {
  await withBackend(async (backend) => {
    await withLinks(async (links, _get, _live, _unserved, _plans, routed) => {
      await links.opened("agent-1", reviewAt(backend));
      assert.deepEqual(routed, [backend], "the review's route points at the proxy before its link is handed out");
      const host = `host.tail1.ts.net:${backend}`;

      const br = await viaProxy(links, host, "/", "gzip, deflate, br");
      assert.equal(br.headers["content-encoding"], "br");
      const compressed = await body(br);
      assert.equal(brotliDecompressSync(compressed).toString(), PAGE);
      assert.ok(compressed.length < PAGE.length / 10, `brotli body ${compressed.length} bytes for a ${PAGE.length}-byte page`);

      const gzip = await viaProxy(links, host, "/", "gzip");
      assert.equal(gzip.headers["content-encoding"], "gzip");
      assert.equal(gunzipSync(await body(gzip)).toString(), PAGE);

      const plain = await viaProxy(links, host, "/");
      assert.equal(plain.headers["content-encoding"], undefined);
      assert.equal((await body(plain)).toString(), PAGE);

      const image = await viaProxy(links, host, "/logo.png", "br");
      assert.equal(image.headers["content-encoding"], undefined, "binary responses pass through");
      assert.deepEqual([...await body(image)], [137, 80, 78, 71]);
    });
  });
});

test("event streams and WebSockets pass through the proxy as they happen", async () => {
  await withBackend(async (backend) => {
    await withLinks(async (links) => {
      await links.opened("agent-1", reviewAt(backend));
      const host = `host.tail1.ts.net:${backend}`;

      const stream = await viaProxy(links, host, "/api/stream", "br");
      assert.equal(stream.headers["content-encoding"], undefined);
      const [first] = await once(stream, "data") as [Buffer];
      assert.equal(first.toString(), "data: first\n\n", "the event arrives while the stream is still open");
      stream.destroy();

      const { socket, reply } = await upgradeViaProxy(links, host);
      assert.match(reply, /^HTTP\/1\.1 101 /);
      socket.write("ping");
      const [echo] = await once(socket, "data") as [Buffer];
      assert.equal(echo.toString(), "ping");
      socket.destroy();
    });
  });
});

test("the proxy reaches only open reviews: other ports, closed reviews and hosts without a port get 404", async () => {
  await withBackend(async (backend) => {
    await withLinks(async (links) => {
      await links.opened("agent-1", reviewAt(backend));
      assert.equal((await viaProxy(links, "host.tail1.ts.net:50999", "/")).statusCode, 404);
      assert.equal((await viaProxy(links, "host.tail1.ts.net", "/")).statusCode, 404);
      const { socket, reply } = await upgradeViaProxy(links, "host.tail1.ts.net:50999");
      assert.match(reply, /^HTTP\/1\.1 404 /);
      socket.destroy();
      // `live` is empty, so two sweeps close the review.
      await links.sweep();
      await links.sweep();
      assert.equal((await viaProxy(links, `host.tail1.ts.net:${backend}`, "/")).statusCode, 404);
    });
  });
});

test("starting moves the routes of reviews still open onto the proxy, and leaves closed ones and the plugin's own ports alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const file = join(directory, "reviews.json");
  const entry = (port: number, extra: object = {}) => ({ agentId: `agent-${port}`, localUrl: `http://localhost:${port}`, remoteUrl: `https://host.tail1.ts.net:${port}`, openedAt: "2026-01-01T09:00:00Z", ...extra });
  await writeFile(file, JSON.stringify({
    a: entry(50_001),
    b: entry(50_002, { closedAt: "2026-01-01T09:30:00Z" }),
    c: entry(8443),
    d: { ...entry(50_004), remoteUrl: null },
  }));
  const routed: number[] = [];
  const links = new ReviewLinks({ port: 0, proxyPort: 0, file, sweepMs: 3_600_000, serve: async () => ORIGIN, route: async (port) => { routed.push(port); } });
  try {
    await links.start();
    assert.deepEqual(routed, [50_001]);
  } finally {
    links.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("without a published origin there is no stable link to give", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const links = new ReviewLinks({ port: 0, proxyPort: 0, file: join(directory, "reviews.json"), serve: async () => { throw new Error("no tailscale"); }, route: async () => {} });
  try {
    await links.start();
    assert.equal(await links.opened("agent-1", opened(50_001)), null);
  } finally {
    links.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
