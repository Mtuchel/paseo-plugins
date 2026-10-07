import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { DecisionJournal, FencedError, type ResolveAction, type RouteSnapshot } from "./decision-journal";
import type { PipelineReview } from "./plan-pipeline";
import type { OpenedEvent } from "./plannotator";
import { ReviewLinks, type DecideReview, type ReviewLinksOptions } from "./review-links";
import { planDetails } from "./review-page";

const ORIGIN = "https://host.tail1.ts.net:8444";
// What the bridge knows locally about the agent: the journal entry carries it, never the review.
const SNAPSHOT: RouteSnapshot = { route: "live", issueId: null, identifier: "TUC-1", sessionId: null };

function opened(port: number): OpenedEvent {
  return { type: "opened", agentId: "agent-1", localUrl: `http://localhost:${port}/?r=1`, remoteUrl: `https://host.tail1.ts.net:${port}/?r=1`, at: "t" };
}

const RISK = (impact: number, reversibility = "revert", newRule = "no — none") => `## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: ${impact} — why\n- Reversibility: ${reversibility} — why\n- Feature flag: no\n- Migration: no\n- Auth: no\n- New rule: ${newRule}\n- Failure mode: a wrong column\n- Advisor rating: impact ${impact}, reversibility ${reversibility}\n- Recommendation: auto — routine\n`;

// `live` holds the local ports whose Plannotator server answers; `unserved` the routes turned off;
// `plans` the plan text each port's server returns; `routed` the routes pointed at the proxy;
// `setNow` moves the clock (each reading advances it by a second). Times show in Berlin time.
async function withLinks(run: (links: ReviewLinks, get: (path: string, method?: string) => Promise<Response>, live: Set<number>, unserved: number[], plans: Map<number, string>, routed: number[], setNow: (iso: string) => void) => Promise<void>, unserveError?: (port: number) => Error | null, options: ReviewLinksOptions = {}) {
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
    ...options,
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

// A decision journal on its own temp directory, held for the duration of one test.
async function withJournal(run: (journal: DecisionJournal) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-decisions-"));
  const journal = new DecisionJournal(join(directory, "decisions"));
  try {
    assert.equal(await journal.acquire(), true);
    await run(journal);
  } finally {
    await journal.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

type ProducerCall = { localUrl: string; approve: boolean; feedback: string; agentId: string; review: { reviewId?: string; source: "inbox" } };

// The inbox's lists: everything before "Being applied", its list, and the recent decisions. A
// section is absent from the page while its list is empty, so its part reads "".
function sections(page: string): { waiting: string; applying: string; recent: string } {
  const [waiting, afterWaiting = ""] = page.split("Being applied");
  const [applying, recent = ""] = afterWaiting.split("Recently decided");
  return { waiting, applying, recent };
}

// The producer side of an inbox decision, as plannotator.ts runs it: journal it on the review
// generation the click names, then record Plannotator's answer (`unknown` loses it).
function producer(journal: DecisionJournal, answer: "accepted" | "unknown", calls: ProducerCall[]): DecideReview {
  return async (localUrl, approve, feedback, agentId, review) => {
    calls.push({ localUrl, approve, feedback, agentId, review });
    const generation = review.reviewId ? journal.review(review.reviewId) : null;
    if (!generation) throw new Error(`no review generation ${review.reviewId ?? ""}`);
    const attempt = await journal.begin({ review: generation, agentId, planContent: "# TUC-1 — Plan\n", approved: approve, ...(feedback ? { feedback } : {}), source: review.source, state: "deciding", snapshot: SNAPSHOT });
    await journal.settle(attempt.id, answer);
  };
}

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
    assert.equal(await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" }), `${ORIGIN}/review/agent-1`);
    const response = await get("/review/agent-1");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://host.tail1.ts.net:50001/?r=1");
  });
});

test("a review whose server stopped shows the closed page with its outcome", async () => {
  await withLinks(async (links, get) => {
    await links.opened("agent-1", opened(50_001), { identifier: "<TUC-1>" });
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
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "<TUC-2>" });
    // Superseded by the same agent's newer review: only the newer one is listed.
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, { identifier: "TUC-3-old" });
    await links.opened("agent-3", { ...opened(50_005), agentId: "agent-3" }, { identifier: "TUC-3" });
    // Not answering any more (not yet swept), and local-only: neither can be opened from a phone.
    await links.opened("agent-4", { ...opened(50_004), agentId: "agent-4" }, { identifier: "TUC-4" });
    await links.opened("agent-5", { ...opened(50_006), agentId: "agent-5", remoteUrl: null }, { identifier: "TUC-5" });
    live.add(50_006);
    // Decided and closed: listed under recent decisions instead.
    await links.opened("agent-6", { ...opened(50_007), agentId: "agent-6" }, { identifier: "TUC-6" });
    await links.decided("agent-6", true);
    await links.sweep();
    await links.sweep();

    const response = await get("/");
    assert.equal(response.status, 200);
    const page = await response.text();
    const [waiting, recent] = page.split("Recently decided");
    const listed = [...waiting.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(listed, ["agent-3", "agent-2", "agent-1"]);
    assert.match(waiting, /&#60;TUC-2&#62;/);
    assert.doesNotMatch(page, /TUC-3-old/);
    assert.match(recent, /TUC-6/);
    assert.match(recent, /approved/);
    assert.match(recent, /TUC-4/, "the dead review was closed by the sweep");
    assert.doesNotMatch(page, /TUC-5/);
  });
});

test("waiting review age uses the owner's time zone and restored reviews keep their original arrival", async () => {
  await withLinks(async (links, get, live, _unserved, _plans, _routed, setNow) => {
    live.add(50_001).add(50_002).add(50_004);
    // 23:30 UTC on 1 Jan is already 2 Jan in Berlin; 22:30 UTC is still 1 Jan there.
    setNow("2026-01-01T23:30:00Z");
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    setNow("2026-01-01T22:30:00Z");
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2" });
    setNow("2025-12-29T09:00:00Z");
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, { identifier: "TUC-3" });
    // Served again after a restart: it keeps the time the owner got it, and the new server.
    setNow("2026-01-02T08:00:00Z");
    await links.opened("agent-3", { ...opened(50_004), agentId: "agent-3" }, { identifier: "TUC-3", since: "2025-12-29T09:00:00.000Z" });
    setNow("2026-01-02T09:00:00Z");

    const page = await (await get("/")).text();
    assert.match(page, /<span class="when">[^]*?>00:30<\/time> · 9 h<\/span>/, "opened 00:30 Berlin time, waiting 9 h");
    assert.match(page, /<span class="when stale">[^]*?>10:00<\/time> · 4 d<\/span>/, "a review waiting over 12 h is highlighted");
    assert.match(page, /3 waiting · oldest 4 d · updated 10:00/);
    assert.equal((await get("/review/agent-3")).headers.get("location"), "https://host.tail1.ts.net:50004/?r=1");
  });
});


test("inbox rows show the plan's title, opening paragraph, risk rating and why it needs the owner", async () => {
  await withLinks(async (links, get, live, _unserved, plans) => {
    live.add(50_001).add(50_002).add(50_003);
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    const reach = "## Reach\n\n- Changes: date warnings\n- Delivery notes: include — AC-1\n- Help page: follow-up — Document the delay warning\n- Mobile app: follow-up — Warn on mobile too\n\n";
    await links.described("http://localhost:50001/?r=1", `# TUC-1 — Warn when a <delay> breaks a date\n\n## Summary\n\nWhen a **container** is late, the [sales](https://x) team gets a notice.\n\n${reach}${RISK(3, "data-fix", "yes — every late date warns")}`, { approved: false, reasons: ["impact 3 is above the threshold 1", "reversibility is data-fix", "it sets a new rule"] });
    // Opened before the plugin recorded details: read from its running server when the inbox loads.
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2" });
    plans.set(50_002, `# TUC-2 · Report column\n\n| a | b |\n|---|---|\n\nAdds a column to the order report.\n\n${RISK(1)}`);
    // Decided while its server still answers: not waiting any more.
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, { identifier: "TUC-3" });
    await links.described("http://localhost:50003/?r=1", `# TUC-3 Tooling\n\nCI only.\n\n## Reach\n\n- Changes: CI\n- Deploy script: follow-up — Use the new check in deploys\n\n${RISK(0, "revert", "yes — every job runs the check")}`, { approved: true, reasons: [] });
    await links.decided("agent-3", true);

    const page = await (await get("/")).text();
    const [waiting, recent] = page.split("Recently decided");
    assert.deepEqual([...waiting.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1]), ["agent-2", "agent-1"]);
    const [second, first] = waiting.split('data-agent="').slice(1);
    assert.match(first, /<div class="title">Warn when a &#60;delay&#62; breaks a date<\/div>/);
    assert.match(first, /<div class="summary">When a container is late, the sales team gets a notice\.<\/div>/);
    assert.match(first, /Needs you:<\/b> impact 3 is above the threshold 1; reversibility is data-fix; it sets a new rule/);
    assert.match(second, /<div class="title">Report column<\/div><div class="summary">Adds a column to the order report\.<\/div>/);
    assert.match(second, /<div class="chips"><span class="chip low">Risk: impact 1\/4 · revert<\/span><\/div>/, "a plan without follow-ups or a rule shows neither chip");
    assert.match(recent, /TUC-3<\/span><span class="outcome">auto-approved/);
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

test("a review page's inline app moves to a cached URL on the inbox, named by its content", async () => {
  const app = `console.log(${JSON.stringify("app ".repeat(40_000))});`;
  const style = `body{color:red}${".x{}".repeat(20_000)}`;
  const page = `<!doctype html><html><head><script type="module" crossorigin>${app}</script><style rel="stylesheet" crossorigin>${style}</style><script type="module">tiny()</script></head><body><div id="root"></div></body></html>`;
  const backend = createServer((_incoming, response) => { response.writeHead(200, { "content-type": "text/html" }).end(page); });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const port = (backend.address() as AddressInfo).port;
  try {
    await withLinks(async (links, get) => {
      await links.opened("agent-1", reviewAt(port, "agent-1"));
      const shells = [];
      for (const encoding of ["br", undefined]) {
        const response = await viaProxy(links, `host.tail1.ts.net:${port}`, "/", encoding);
        const raw = await body(response);
        shells.push(encoding === "br" ? brotliDecompressSync(raw).toString() : raw.toString());
      }
      assert.equal(shells[0], shells[1]);
      const shell = shells[0];
      const script = /<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(shell)?.[1];
      const sheet = /<link rel="stylesheet" href="([^"]+)">/.exec(shell)?.[1];
      assert.ok(script?.startsWith(`${ORIGIN}/plannotator/`) && sheet?.startsWith(`${ORIGIN}/plannotator/`), shell);
      assert.ok(shell.includes("<script type=\"module\">tiny()</script>"), "a small inline script stays");
      assert.ok(shell.length < 1_000, `shell is ${shell.length} bytes`);

      const js = await get(new URL(script!).pathname);
      assert.equal(js.status, 200);
      assert.equal(await js.text(), app);
      assert.match(js.headers.get("cache-control") ?? "", /immutable/);
      assert.equal(js.headers.get("access-control-allow-origin"), "*");
      assert.equal(await (await get(new URL(sheet!).pathname)).text(), style);
      assert.equal((await get(`/plannotator/${"0".repeat(64)}.js`)).status, 404);
    });
  } finally {
    backend.closeAllConnections();
    backend.close();
  }
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

// A peer host's inbox: answers /api/inbox with `inbox` and records the decisions sent to it.
async function withPeer(inbox: unknown, run: (origin: string, decisions: string[]) => Promise<void>) {
  const decisions: string[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      if (incoming.url === "/api/inbox") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(inbox)); return; }
      if (incoming.method === "POST" && (incoming.url?.endsWith("/decision") || incoming.url?.endsWith("/resolve"))) {
        decisions.push(`${incoming.url} ${incoming.headers["x-review-action"]} ${Buffer.concat(chunks).toString()}`);
        response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "This review is already closed." }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, decisions);
  } finally {
    server.close();
  }
}

function action(links: ReviewLinks, path: string, body: unknown, headers: Record<string, string> = { "x-review-action": "1" }): Promise<Response> {
  return fetch(`http://127.0.0.1:${links.listeningPort}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const PEER_INBOX = {
  host: "server087",
  open: [
    { agentId: "agent-9", name: "TUC-9", link: "https://server087.tail1.ts.net:8444/review/agent-9", since: "2026-01-01T10:00:30.000Z", model: "omp/opus" },
    { agentId: "bad id", name: "TUC-8", link: "https://server087.tail1.ts.net:8444/review/bad", since: "2026-01-01T10:00:40.000Z" },
    { agentId: "agent-7", name: "TUC-7", link: "javascript:alert(1)", since: "2026-01-01T10:00:50.000Z" },
  ],
  decided: [],
};

test("the inbox lists a peer host's waiting reviews among this host's, newest first, names each row's host, and says which peer did not answer", async () => {
  await withPeer(PEER_INBOX, async (peer) => {
    await withLinks(async (links, get, live) => {
      live.add(50_001);
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", model: "claude/opus" });
      const page = await (await get("/")).text();
      const [waiting] = page.split("Recently decided");
      assert.deepEqual([...waiting.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1]), ["agent-9", "agent-1"], "rows a page could not render safely are left out");
      assert.match(waiting, /href="https:\/\/server087\.tail1\.ts\.net:8444\/review\/agent-9"/);
      assert.match(waiting, /<span>server087<\/span>/);
      assert.match(waiting, /<span>mac<\/span>/);
      assert.match(waiting, /<span>opus<\/span>/, "the model that planned it, without its provider");
      assert.match(page, /Not reachable, so its reviews are missing: localhost/);
      assert.doesNotMatch(page, /TUC-7|TUC-8/);
    }, undefined, { host: "mac", peers: async () => [peer, "http://localhost:1"] });
  });
});

test("approve and send back from the inbox decide this host's review, forward a peer's to that peer, and refuse anything a page on another site could send", async () => {
  const decided: string[] = [];
  await withPeer(PEER_INBOX, async (peer, forwarded) => {
    await withLinks(async (links, get, live) => {
      live.add(50_001).add(50_002);
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", reviewId: "review-1" });
      await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2" });
      await get("/");

      assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: true }, {})).status, 403, "without the inbox's own header");
      assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: true }, { "x-review-action": "1", origin: "https://evil.example" })).status, 403, "from another site");
      assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: false, feedback: "  " })).status, 400, "sending back needs a note");
      assert.deepEqual(decided, []);

      assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: true, feedback: "ignored" })).status, 200);
      assert.equal((await action(links, "/api/reviews/agent-2/decision", { approve: false, feedback: " Split step 2 " })).status, 200);
      assert.deepEqual(decided, [
        'http://localhost:50001/?r=1 true  agent-1 {"reviewId":"review-1","source":"inbox"}',
        'http://localhost:50002/?r=1 false Split step 2 agent-2 {"source":"inbox"}',
      ], "the review generation and the inbox as the source are journaled with the decision");
      // Only after the worker reports what the journal applied does the inbox list them decided.
      await links.decided("agent-1", true, { localUrl: "http://localhost:50001/?r=1", at: "2026-01-01T10:00:05.000Z" });
      await links.decided("agent-2", false, { localUrl: "http://localhost:50002/?r=1", at: "2026-01-01T10:00:06.000Z" });
      const again = await action(links, "/api/reviews/agent-1/decision", { approve: true });
      assert.equal(again.status, 409, "a review carried out is not decided twice");
      const [waiting, recent] = (await (await get("/")).text()).split("Recently decided");
      assert.doesNotMatch(waiting, /data-agent="agent-[12]"/);
      assert.match(recent, /TUC-1<\/span><span class="outcome[^"]*">approved/);
      assert.match(recent, /TUC-2<\/span><span class="outcome[^"]*">sent back/);

      const remote = await action(links, "/api/reviews/agent-9/decision", { approve: true });
      assert.deepEqual([remote.status, await remote.json()], [409, { error: "This review is already closed." }], "the peer's answer is passed on");
      assert.deepEqual(forwarded, ['/api/reviews/agent-9/decision 1 {"approve":true,"feedback":""}']);
      assert.equal((await action(links, "/api/reviews/agent-unknown/decision", { approve: true })).status, 404);
    }, undefined, { peers: async () => [peer], decide: async (localUrl, approve, feedback, agentId, review) => { decided.push(`${localUrl} ${approve} ${feedback} ${agentId} ${JSON.stringify(review)}`); } });
  });
});

test("each review that starts waiting is pushed once to the subscribed browsers; the reviews waiting at setup and dropped subscriptions are not", async () => {
  const sent: string[] = [];
  let gone = false;
  await withLinks(async (links, get, live) => {
    const subscription = { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } };
    assert.match((await (await get("/api/push/key")).json()).publicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal((await action(links, "/api/push/subscribe", { endpoint: "http://push.example/1", keys: subscription.keys })).status, 400);
    assert.equal((await action(links, "/api/push/subscribe", subscription)).status, 200);
    live.add(50_001).add(50_002).add(50_003);
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    await links.announce();
    assert.deepEqual(sent, [], "what already waits when notifications start is not announced");

    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2" });
    await links.announce();
    await links.announce();
    assert.deepEqual(sent, [`https://push.example/1 Plan review: TUC-2 ${ORIGIN}/review/agent-2 2`]);

    gone = true;
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, { identifier: "TUC-3" });
    await links.announce();
    gone = false;
    await links.opened("agent-4", { ...opened(50_004), agentId: "agent-4" }, { identifier: "TUC-4" });
    live.add(50_004);
    await links.announce();
    assert.equal(sent.length, 1, "the push service dropped the subscription, so it is not used again");
  }, undefined, {
    sendPush: async (subscription, message) => {
      if (gone) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      sent.push(`${subscription.endpoint} ${message.title} ${message.url} ${message.count}`);
    },
  });
});

// A review replaced in the same millisecond, or one republished on its old URL: the registry is
// keyed by the review's URL, so the current review is the one with the newest timestamp and, among
// equal ones, the publication this plugin recorded last.

// The event's URLs, as `opened` builds them.
function reviewLocal(port: number): string { return `http://localhost:${port}/?r=1`; }
function reviewRemote(port: number): string { return `https://host.tail1.ts.net:${port}/?r=1`; }

// One frozen instant: every publication in a test shares one millisecond, so their timestamps tie.
function frozen(iso = "2026-01-01T10:00:00.000Z"): () => Date {
  const at = Date.parse(iso);
  return () => new Date(at);
}

// What these tests read from `/api/inbox`.
type InboxRowJson = { agentId: string; name: string; details?: { title: string | null; summary: string | null; risk: { impact: number; text: string } | null; reasons?: string[]; autoApproved?: boolean } };

// The plugin restarted: a second instance over the registry JSON alone, with every review alive.
async function withRestarted(file: string, run: (links: ReviewLinks, get: (path: string) => Promise<Response>) => Promise<void>): Promise<void> {
  const links = new ReviewLinks({
    port: 0, proxyPort: 0, file, sweepMs: 3_600_000, timeZone: "Europe/Berlin",
    now: () => new Date("2026-01-01T10:00:00.000Z"),
    alive: async () => true,
    serve: async () => ORIGIN,
    route: async () => {},
    unserve: async () => {},
    fetchPlan: async () => "",
  });
  try {
    await links.start();
    await run(links, (path) => fetch(`http://127.0.0.1:${links.listeningPort}${path}`, { redirect: "manual" }));
  } finally {
    links.stop();
  }
}

test("a review republished on its own URL wins a tied instant at its stable link and row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const file = join(directory, "reviews.json");
  try {
    await withLinks(async (links, get, live) => {
      live.add(50_001).add(50_002).add(50_009);
      // agent-1's plan, a review in between, then the first URL published again — all one instant.
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1-old" });
      await links.described(reviewLocal(50_001), `# TUC-1 — Old plan\n\nWhat the agent first planned.\n\n${RISK(3, "data-fix")}`, { approved: false, reasons: ["impact 3 is above the threshold 1"] });
      await links.opened("agent-1", opened(50_002), { identifier: "TUC-1-mid" });
      await links.described(reviewLocal(50_002), `# TUC-1 — Middle plan\n\nWhat the agent planned in between.\n\n${RISK(2)}`, { approved: false, reasons: [] });
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
      await links.described(reviewLocal(50_001), `# TUC-1 — Current plan\n\nWhat the review shows now.\n\n${RISK(1)}`, { approved: true, reasons: [] });
      await links.opened("agent-2", { ...opened(50_009), agentId: "agent-2" }, { identifier: "TUC-2" });

      assert.equal((await get("/review/agent-1")).headers.get("location"), reviewRemote(50_001), "the publication recorded last on the reused URL wins the tie");
      assert.equal((await get("/review/agent-2")).headers.get("location"), reviewRemote(50_009), "another agent's link is untouched");
      const [waiting] = (await (await get("/")).text()).split("Recently decided");
      assert.deepEqual([...waiting.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1]), ["agent-1", "agent-2"]);
      assert.match(waiting, /<span class="id">TUC-1<\/span>/);
      assert.match(waiting, /<div class="title">Current plan<\/div>/);
      assert.match(waiting, /<div class="summary">What the review shows now\.<\/div>/);
      assert.match(waiting, /<span class="chip low">Risk: impact 1\/4 · revert<\/span>/);
      assert.doesNotMatch(waiting, /TUC-1-old|TUC-1-mid|Old plan|Middle plan|impact 3\/4/);

      await withRestarted(file, async (_reloaded, restartedGet) => {
        assert.equal((await restartedGet("/review/agent-1")).headers.get("location"), reviewRemote(50_001), "the reloaded registry keeps the same winner");
        const [reloadedWaiting] = (await (await restartedGet("/")).text()).split("Recently decided");
        assert.deepEqual([...reloadedWaiting.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1]), ["agent-1", "agent-2"]);
        assert.match(reloadedWaiting, /<div class="title">Current plan<\/div>/);
        assert.doesNotMatch(reloadedWaiting, /TUC-1-old|TUC-1-mid|Old plan|Middle plan/);
      });
    }, undefined, { file, now: frozen() });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a registry loaded from disk keeps the newest timestamp and the last stored entry of a tie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const file = join(directory, "reviews.json");
  const entry = (port: number, agentId: string, identifier: string, openedAt: string) => ({ agentId, localUrl: reviewLocal(port), remoteUrl: reviewRemote(port), identifier, openedAt });
  try {
    // What the previous plugin version wrote: no new fields, and an order that does not match the
    // timestamps (a review recorded later can still be older).
    await writeFile(file, JSON.stringify({
      [reviewLocal(50_001)]: entry(50_001, "agent-1", "TUC-1-newest", "2026-01-01T10:00:05.000Z"),
      [reviewLocal(50_002)]: entry(50_002, "agent-1", "TUC-1-recorded-last", "2026-01-01T10:00:00.000Z"),
      [reviewLocal(50_003)]: entry(50_003, "agent-2", "TUC-2-tied-first", "2026-01-01T10:00:05.000Z"),
      [reviewLocal(50_004)]: entry(50_004, "agent-2", "TUC-2-tied-last", "2026-01-01T10:00:05.000Z"),
    }));
    await withRestarted(file, async (_reloaded, get) => {
      assert.equal((await get("/review/agent-1")).headers.get("location"), reviewRemote(50_001), "the newest timestamp wins although the file stores it first");
      assert.equal((await get("/review/agent-2")).headers.get("location"), reviewRemote(50_004), "of a tie, the entry stored last wins");
      const [waiting] = (await (await get("/")).text()).split("Recently decided");
      assert.deepEqual([...waiting.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1]), ["agent-1", "agent-2"]);
      assert.match(waiting, /TUC-1-newest/);
      assert.match(waiting, /TUC-2-tied-last/);
      assert.doesNotMatch(waiting, /TUC-1-recorded-last|TUC-2-tied-first/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("describedFor re-describes the tied replacement, not the reviews it replaced", async () => {
  await withLinks(async (links, get, live) => {
    live.add(50_001).add(50_002);
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1-old" });
    await links.described(reviewLocal(50_001), `# TUC-1 — Old plan\n\nWhat the agent first planned.\n\n${RISK(3, "data-fix")}`, { approved: false, reasons: ["impact 3 is above the threshold 1"] });
    await links.opened("agent-1", opened(50_002), { identifier: "TUC-1-mid" });
    await links.described(reviewLocal(50_002), `# TUC-1 — Middle plan\n\nWhat the agent planned in between.\n\n${RISK(2)}`, { approved: false, reasons: [] });
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    const plan = `# TUC-1 — Latest plan\n\nWhat the review now shows.\n\n${RISK(2, "data-fix")}`;
    await links.describedFor("agent-1", plan, { approved: true, reasons: [] });

    const inbox = await (await get("/api/inbox")).json() as { open: InboxRowJson[] };
    const row = inbox.open.find((item) => item.agentId === "agent-1");
    assert.equal(row?.name, "TUC-1");
    assert.equal(row?.details?.title, "Latest plan");
    assert.equal(row?.details?.summary, "What the review now shows.");
    assert.deepEqual(row?.details?.risk, { impact: 2, text: "impact 2/4, data-fix" });
    assert.deepEqual(row?.details?.reasons, []);
    assert.equal(row?.details?.autoApproved, true, "the replacement's fresh judgement");
    const [waiting] = (await (await get("/")).text()).split("Recently decided");
    assert.match(waiting, /<div class="title">Latest plan<\/div>/);
    assert.doesNotMatch(waiting, /Old plan|Middle plan|TUC-1-old|TUC-1-mid/);
  }, undefined, { now: frozen() });
});

test("the sweep closes the superseded review of a tie and keeps the last publication's link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const file = join(directory, "reviews.json");
  try {
    await withLinks(async (links, get, live, unserved) => {
      live.add(50_001);
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1-old" });
      await links.opened("agent-1", opened(50_002), { identifier: "TUC-1-mid" });
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
      await links.sweep();
      await links.sweep();
      assert.deepEqual(unserved, [50_002], "only the superseded review's route is removed");
      assert.equal((await get("/review/agent-1")).headers.get("location"), reviewRemote(50_001), "the tie winner stays open");
      const page = await (await get("/")).text();
      const [waiting] = page.split("Recently decided");
      assert.match(waiting, /<span class="id">TUC-1<\/span>/);
      assert.doesNotMatch(page, /TUC-1-old|TUC-1-mid/, "the closed review is dropped, not listed as decided");
      await withRestarted(file, async (_reloaded, restartedGet) => {
        assert.equal((await restartedGet("/review/agent-1")).headers.get("location"), reviewRemote(50_001), "the reloaded registry keeps the same link");
        const [reloadedWaiting] = (await (await restartedGet("/")).text()).split("Recently decided");
        assert.match(reloadedWaiting, /<span class="id">TUC-1<\/span>/);
        assert.doesNotMatch(reloadedWaiting, /TUC-1-old|TUC-1-mid/);
      });
    }, undefined, { file, now: frozen() });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approving from the inbox decides a tied replacement republished on its old URL", async () => {
  const decided: string[] = [];
  await withLinks(async (links, get, live) => {
    live.add(50_001).add(50_002);
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1-old" });
    await links.opened("agent-1", opened(50_002), { identifier: "TUC-1-mid" });
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: true })).status, 200);
    assert.deepEqual(decided, [`${reviewLocal(50_001)} true  agent-1 {"source":"inbox"}`], "the review republished on the old URL is the one decided");
    // The worker reports the applied decision for that same review, not the agent's latest other one.
    await links.decided("agent-1", true, { localUrl: reviewLocal(50_001), at: "2026-01-01T10:00:05.000Z" });
    const [waiting, recent] = (await (await get("/")).text()).split("Recently decided");
    assert.doesNotMatch(waiting, /data-agent="agent-1"/);
    assert.match(recent, /TUC-1<\/span><span class="outcome[^"]*">approved/);
    assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: true })).status, 409, "an approved review is not decided twice");
  }, undefined, {
    now: frozen(),
    decide: async (localUrl, approve, feedback, agentId, review) => { decided.push(`${localUrl} ${approve} ${feedback} ${agentId} ${JSON.stringify(review)}`); },
  });
});

test("sending back and rechecking decide a tied replacement published at a new URL", async () => {
  const decided: string[] = [];
  await withLinks(async (links, get, live) => {
    live.add(50_001).add(50_002).add(50_003).add(50_004);
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1-old" });
    await links.opened("agent-1", opened(50_002), { identifier: "TUC-1" });
    assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: false, feedback: " Split step 2 " })).status, 200);
    assert.deepEqual(decided, [`${reviewLocal(50_002)} false Split step 2 agent-1 {"source":"inbox"}`], "the replacement is the one sent back");
    await links.decided("agent-1", false, { localUrl: reviewLocal(50_002), at: "2026-01-01T10:00:05.000Z" });
    await links.opened("agent-2", { ...opened(50_003), agentId: "agent-2" }, { identifier: "TUC-2-old" });
    await links.opened("agent-2", { ...opened(50_004), agentId: "agent-2" }, { identifier: "TUC-2" });
    assert.equal((await action(links, "/api/reviews/agent-2/recheck", {})).status, 200);
    assert.match(decided[1], /^http:\/\/localhost:50004\/\?r=1 false Recheck this plan against the current code/, "recheck sends the replacement back first");
    assert.equal(await links.requiresOwner("issue-2"), true, "the replacement is the review marked for recheck");
    await links.decided("agent-2", false, { localUrl: reviewLocal(50_004), at: "2026-01-01T10:00:06.000Z" });
    assert.equal((await action(links, "/api/reviews/agent-2/recheck", {})).status, 409, "a review already sent back is not rechecked twice");
    const [, recent] = (await (await get("/")).text()).split("Recently decided");
    assert.match(recent, /TUC-1<\/span><span class="outcome[^"]*">sent back/);
    assert.match(recent, /TUC-2<\/span><span class="outcome[^"]*">sent back/);
  }, undefined, {
    now: frozen(),
    decide: async (localUrl, approve, feedback, agentId, review) => { decided.push(`${localUrl} ${approve} ${feedback} ${agentId} ${JSON.stringify(review)}`); },
    issueLink: async () => ({ issueId: "issue-2", identifier: "TUC-2" }),
  });
});

test("a tied replacement keeps the announced push key and resolves the stable link", async () => {
  const sent: string[] = [];
  await withLinks(async (links, get, live) => {
    const subscription = { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } };
    assert.match((await (await get("/api/push/key")).json()).publicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal((await action(links, "/api/push/subscribe", subscription)).status, 200);
    live.add(50_001).add(50_002).add(50_003);
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2" });
    await links.announce();
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1-old" });
    await links.announce();
    assert.deepEqual(sent, [`https://push.example/1 Plan review: TUC-1-old ${ORIGIN}/review/agent-1 2`]);

    // The same agent's replacement at the same instant: the same `agentId@since` key, so no second push.
    await links.opened("agent-1", opened(50_003), { identifier: "TUC-1" });
    await links.announce();
    assert.equal(sent.length, 1, "the announced key is not pushed again");
    const [waiting] = (await (await get("/")).text()).split("Recently decided");
    assert.match(waiting, /<span class="id">TUC-1<\/span>/, "the row already shows the replacement");
    assert.equal((await get("/review/agent-1")).headers.get("location"), reviewRemote(50_003), "the pushed stable link resolves to the replacement");
  }, undefined, {
    now: frozen(),
    sendPush: async (subscription, message) => { sent.push(`${subscription.endpoint} ${message.title} ${message.url} ${message.count}`); },
  });
});

test("an inbox approval journals the decision on its review generation, lists it as being applied, and refuses a second one", async () => {
  await withJournal(async (journal) => {
    const calls: ProducerCall[] = [];
    const generation = await journal.ensureReview({ agentId: "agent-1", localUrl: reviewLocal(50_001), openedAt: "2026-01-01T10:00:00.000Z" });
    await withLinks(async (links, get, live) => {
      live.add(50_001);
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", reviewId: generation.id });
      assert.equal((await action(links, "/api/reviews/agent-1/decision", { approve: true })).status, 200);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].review, { reviewId: generation.id, source: "inbox" }, "the click journals against the review's own generation");
      const { waiting, applying, recent } = sections(await (await get("/")).text());
      assert.doesNotMatch(waiting, /data-agent="agent-1"/, "a decision being applied is not waiting");
      assert.match(applying, /data-agent="agent-1"/);
      assert.match(applying, /approved — being applied/);
      assert.doesNotMatch(recent, /TUC-1/, "listed decided only once the journal applied it");
      const again = await action(links, "/api/reviews/agent-1/decision", { approve: false, feedback: "no" });
      assert.deepEqual([again.status, (await again.json()).error], [409, "Already decided; it is being applied."]);
    }, undefined, { decide: producer(journal, "accepted", calls), decisions: { applying: () => journal.applying(), resolve: async () => {} } });
  });
});

test("an inbox decision the restarting plugin fences is answered 503", async () => {
  await withLinks(async (links, get, live) => {
    live.add(50_001);
    await links.opened("agent-1", opened(50_001), { identifier: "TUC-1" });
    const response = await action(links, "/api/reviews/agent-1/decision", { approve: true });
    assert.deepEqual([response.status, (await response.json()).error], [503, "The plugin is restarting; try again in a few seconds."]);
  }, undefined, { decide: async () => { throw new FencedError(); } });
});

test("a decision being applied shows its last failure and next try, an unconfirmed one is not confirmed, and neither waits or is decided", async () => {
  await withJournal(async (journal) => {
    const first = await journal.ensureReview({ agentId: "agent-1", localUrl: reviewLocal(50_001), openedAt: "2026-01-01T10:00:00.000Z" });
    const second = await journal.ensureReview({ agentId: "agent-2", localUrl: reviewLocal(50_002), openedAt: "2026-01-01T10:00:00.000Z" });
    const pending = await journal.begin({ review: first, agentId: "agent-1", planContent: "# TUC-1\n", approved: true, source: "inbox", state: "pending", snapshot: SNAPSHOT });
    await journal.failed(pending, new Error("Linear is down"));
    const lost = await journal.begin({ review: second, agentId: "agent-2", planContent: "# TUC-2\n", approved: false, source: "inbox", state: "deciding", snapshot: SNAPSHOT });
    await journal.settle(lost.id, "unknown");
    await journal.awaitOwner(lost.id, true, "Plannotator did not confirm this decision: carry it out or drop it.");
    await withLinks(async (links, get, live) => {
      live.add(50_001).add(50_002);
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", reviewId: first.id });
      await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2", reviewId: second.id });
      const { waiting, applying, recent } = sections(await (await get("/")).text());
      assert.doesNotMatch(waiting, /data-agent="agent-[12]"/);
      assert.doesNotMatch(recent, /TUC-[12]/);
      assert.match(applying, /TUC-1[\s\S]*?approved — being applied/);
      assert.match(applying, /Last try failed: Linear is down · next try \d{2}:\d{2}/);
      assert.match(applying, /TUC-2[\s\S]*?sent back — not confirmed by Plannotator/);
      assert.match(applying, /data-action="carry-out">Carry it out</);
      assert.match(applying, /data-action="drop">Drop it</);
      // The worker reports the applied decision: recently decided, and no longer being applied.
      await journal.applied(pending);
      await links.decided("agent-1", true, { localUrl: reviewLocal(50_001), at: "2026-01-01T10:00:05.000Z" });
      const after = await (await get("/")).text();
      const { waiting: waitingAfter, applying: applyingAfter, recent: recentAfter } = sections(after);
      assert.doesNotMatch(waitingAfter, /data-agent="agent-1"/);
      assert.doesNotMatch(applyingAfter, /TUC-1/);
      assert.match(recentAfter, /TUC-1<\/span><span class="outcome[^"]*">approved/);
      assert.match(applyingAfter, /TUC-2/, "the unconfirmed decision still waits for the owner");
    }, undefined, { decisions: { applying: () => journal.applying(), resolve: async () => {} } });
  });
});

const PEER_APPLYING = {
  host: "server087",
  open: [],
  decided: [],
  applying: [
    { agentId: "agent-9", name: "TUC-9", link: "https://server087.tail1.ts.net:8444/review/agent-9", since: "2026-01-01T10:00:30.000Z", applyState: "pending", entryId: "entry-9", approved: true, applyError: "Linear is down", nextAttemptAt: "2026-01-01T10:01:00.000Z" },
  ],
};

test("a peer's being-applied rows render with their host, and a peer answer without any parses", async () => {
  await withPeer(PEER_APPLYING, async (peer) => {
    await withLinks(async (links, get) => {
      const page = await (await get("/")).text();
      const [waiting, rest] = page.split("Being applied");
      const [applying] = rest.split("Recently decided");
      assert.match(waiting, /Nothing to review/, "the peer's applied review is not waiting");
      assert.match(applying, /data-agent="agent-9"/);
      assert.match(applying, /approved — being applied/);
      assert.match(applying, /Last try failed: Linear is down/);
      assert.match(applying, /<span>server087<\/span>/);
    }, undefined, { peers: async () => [peer] });
  });
  await withPeer(PEER_INBOX, async (peer) => {
    await withLinks(async (links, get) => {
      const answer = await (await get("/api/inbox")).json() as { applying: unknown };
      assert.deepEqual(answer.applying, [], "this host is applying nothing itself");
      const page = await (await get("/")).text();
      assert.match(page, /TUC-9/, "a peer answer without applying parses as before");
      assert.doesNotMatch(page, /Being applied/);
    }, undefined, { peers: async () => [peer] });
  });
});

test("a closed review's page says its decision is being applied until the journal carried it out", async () => {
  await withJournal(async (journal) => {
    const generation = await journal.ensureReview({ agentId: "agent-1", localUrl: reviewLocal(50_001), openedAt: "2026-01-01T10:00:00.000Z" });
    const attempt = await journal.begin({ review: generation, agentId: "agent-1", planContent: "# TUC-1\n", approved: true, source: "inbox", state: "pending", snapshot: SNAPSHOT });
    await withLinks(async (links, get) => {
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", reviewId: generation.id });
      // The review's server stopped: the sweep closes it and its stable link shows the closed page.
      await links.sweep();
      await links.sweep();
      assert.match(await (await get("/review/agent-1")).text(), /Review closed — approved — being applied/);
      await journal.applied(attempt);
      await links.decided("agent-1", true, { localUrl: reviewLocal(50_001), at: "2026-01-01T10:00:05.000Z" });
      const after = await (await get("/review/agent-1")).text();
      assert.match(after, /Review closed — approved</);
      assert.doesNotMatch(after, /being applied/);
    }, undefined, { decisions: { applying: () => journal.applying(), resolve: async () => {} } });
  });
});

test("a pending decision counts as decided for the plan pipeline; an unconfirmed one counts as open", async () => {
  await withJournal(async (journal) => {
    const first = await journal.ensureReview({ agentId: "agent-1", localUrl: reviewLocal(50_001), openedAt: "2026-01-01T10:00:00.000Z" });
    const second = await journal.ensureReview({ agentId: "agent-2", localUrl: reviewLocal(50_002), openedAt: "2026-01-01T10:00:00.000Z" });
    await journal.begin({ review: first, agentId: "agent-1", planContent: "# TUC-1\n", approved: true, source: "inbox", state: "pending", snapshot: SNAPSHOT });
    const lost = await journal.begin({ review: second, agentId: "agent-2", planContent: "# TUC-2\n", approved: false, source: "inbox", state: "deciding", snapshot: SNAPSHOT });
    await journal.settle(lost.id, "unknown");
    const observed: { open: (PipelineReview & { applyState?: string })[]; decided: (PipelineReview & { applyState?: string })[] }[] = [];
    await withLinks(async (links, get, live) => {
      live.add(50_001).add(50_002);
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", reviewId: first.id });
      await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2", reviewId: second.id });
      await get("/");
      assert.equal(observed.length, 1);
      const decidedRow = observed[0].decided.find((row) => row.agentId === "agent-1");
      assert.deepEqual([decidedRow?.applyState, decidedRow?.outcome], ["pending", "approved"]);
      const openRow = observed[0].open.find((row) => row.agentId === "agent-2");
      assert.deepEqual([openRow?.applyState, openRow?.outcome], ["uncertain", undefined]);
    }, undefined, {
      pipeline: async (open, decided) => { observed.push({ open: [...open], decided: [...decided] }); return { host: "self", checkedAt: null, lastArrivalAt: null, rows: [] }; },
      decisions: { applying: () => journal.applying(), resolve: async () => {} },
    });
  });
});

test("the owner carries out or drops an unconfirmed decision, and a stale answer is refused", async () => {
  await withJournal(async (journal) => {
    const calls: [string, string][] = [];
    const first = await journal.ensureReview({ agentId: "agent-1", localUrl: reviewLocal(50_001), openedAt: "2026-01-01T10:00:00.000Z" });
    const second = await journal.ensureReview({ agentId: "agent-2", localUrl: reviewLocal(50_002), openedAt: "2026-01-01T10:00:00.000Z" });
    const carry = await journal.begin({ review: first, agentId: "agent-1", planContent: "# TUC-1\n", approved: true, source: "inbox", state: "deciding", snapshot: SNAPSHOT });
    await journal.settle(carry.id, "unknown");
    const drop = await journal.begin({ review: second, agentId: "agent-2", planContent: "# TUC-2\n", approved: false, source: "inbox", state: "deciding", snapshot: SNAPSHOT });
    await journal.settle(drop.id, "unknown");
    const decisions = {
      applying: () => journal.applying(),
      resolve: async (entryId: string, action: ResolveAction) => { calls.push([entryId, action]); await journal.resolve(entryId, action, async () => SNAPSHOT); },
    };
    await withLinks(async (links, get, live) => {
      live.add(50_001).add(50_002);
      await links.opened("agent-1", opened(50_001), { identifier: "TUC-1", reviewId: first.id });
      await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, { identifier: "TUC-2", reviewId: second.id });
      assert.equal((await action(links, "/api/reviews/agent-1/resolve", { entryId: carry.id, action: "carry-out" }, {})).status, 403, "resolving needs the inbox's own header");
      assert.equal((await action(links, "/api/reviews/agent-1/resolve", { entryId: carry.id, action: "explode" })).status, 400, "only the five actions");
      // While Plannotator may still confirm it, the decision is sent again, not the owner's to settle.
      const early = await action(links, "/api/reviews/agent-1/resolve", { entryId: carry.id, action: "carry-out" });
      assert.equal(early.status, 409);
      assert.equal(journal.attempt(carry.id)?.state, "uncertain");
      const button = `data-entry="${carry.id}" data-action="carry-out"`;
      const sending = await (await get("/")).text();
      assert.ok(!sending.includes(button) && sending.includes("Sending it to Plannotator again"), "no buttons while it is sent again");
      await journal.awaitOwner(carry.id, true, "Plannotator did not confirm this decision: carry it out or drop it.");
      await journal.awaitOwner(drop.id, true, "Plannotator did not confirm this decision: carry it out or drop it.");
      const waiting = await (await get("/")).text();
      assert.ok(waiting.includes(button) && waiting.includes("Plannotator did not confirm this decision"), "the owner's buttons once Plannotator cannot confirm it");
      calls.length = 0;
      assert.equal((await action(links, "/api/reviews/agent-1/resolve", { entryId: carry.id, action: "carry-out" })).status, 200);
      assert.deepEqual(calls, [[carry.id, "carry-out"]]);
      assert.equal(journal.attempt(carry.id)?.state, "pending", "carrying it out accepts the decision");
      const stale = await action(links, "/api/reviews/agent-1/resolve", { entryId: carry.id, action: "drop" });
      assert.deepEqual([stale.status, (await stale.json()).error], [409, "That decision changed meanwhile; reload the inbox."]);
      assert.equal((await action(links, "/api/reviews/agent-2/resolve", { entryId: drop.id, action: "drop" })).status, 200);
      assert.equal(journal.attempt(drop.id)?.state, "void", "dropping voids the decision");
      assert.equal((await action(links, "/api/reviews/agent-2/resolve", { entryId: "nobody", action: "drop" })).status, 404);
    }, undefined, { decisions });
  });
});

test("a resolve for a decision only a peer lists is forwarded to that peer", async () => {
  await withPeer(PEER_APPLYING, async (peer, forwarded) => {
    await withLinks(async (links, get) => {
      await get("/");
      const response = await action(links, "/api/reviews/agent-9/resolve", { entryId: "entry-9", action: "carry-out" });
      assert.equal(response.status, 409, "the peer's answer is passed on");
      assert.equal(forwarded.length, 1);
      assert.match(forwarded[0], /^\/api\/reviews\/agent-9\/resolve 1 /);
      assert.deepEqual(JSON.parse(forwarded[0].slice(forwarded[0].indexOf("{"))), { entryId: "entry-9", action: "carry-out" });
    }, undefined, { peers: async () => [peer], decisions: { applying: () => [], resolve: async () => { throw new Error("resolved locally"); } } });
  });
});
