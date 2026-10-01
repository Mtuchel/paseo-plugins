import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenedEvent } from "./plannotator";
import { ReviewLinks } from "./review-links";

const ORIGIN = "https://host.tail1.ts.net:8444";

function opened(port: number): OpenedEvent {
  return { type: "opened", agentId: "agent-1", localUrl: `http://localhost:${port}/?r=1`, remoteUrl: `https://host.tail1.ts.net:${port}/?r=1`, at: "t" };
}

// `live` holds the local ports whose Plannotator server answers; `unserved` the routes turned off.
async function withLinks(run: (links: ReviewLinks, get: (path: string, method?: string) => Promise<Response>, live: Set<number>, unserved: number[]) => Promise<void>, unserveError?: (port: number) => Error | null) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const live = new Set<number>();
  const unserved: number[] = [];
  let clock = Date.parse("2026-01-01T10:00:00Z");
  const links = new ReviewLinks({
    port: 0, file: join(directory, "reviews.json"), sweepMs: 3_600_000,
    now: () => new Date(clock += 1_000),
    alive: async (localUrl) => live.has(Number(new URL(localUrl).port)),
    serve: async () => ORIGIN,
    unserve: async (port) => {
      unserved.push(port);
      const error = unserveError?.(port);
      if (error) throw error;
    },
  });
  try {
    await links.start();
    const get = (path: string, method = "GET") => fetch(`http://127.0.0.1:${links.listeningPort}${path}`, { method, redirect: "manual" });
    await run(links, get, live, unserved);
  } finally {
    links.stop();
    await rm(directory, { recursive: true, force: true });
  }
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
    assert.equal((await get("/")).status, 404);
    assert.equal((await get("/review/agent-1", "POST")).status, 405);
  });
});

test("without a published origin there is no stable link to give", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const links = new ReviewLinks({ port: 0, file: join(directory, "reviews.json"), serve: async () => { throw new Error("no tailscale"); } });
  try {
    await links.start();
    assert.equal(await links.opened("agent-1", opened(50_001)), null);
  } finally {
    links.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
