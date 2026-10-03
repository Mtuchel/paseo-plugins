import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenedEvent } from "./plannotator";
import { planDetails, ReviewLinks } from "./review-links";

const ORIGIN = "https://host.tail1.ts.net:8444";

function opened(port: number): OpenedEvent {
  return { type: "opened", agentId: "agent-1", localUrl: `http://localhost:${port}/?r=1`, remoteUrl: `https://host.tail1.ts.net:${port}/?r=1`, at: "t" };
}

const RISK = (impact: number, reversibility = "revert") => `## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: ${impact} — why\n- Reversibility: ${reversibility} — why\n- Feature flag: no\n- Migration: no\n- Auth: no\n- Failure mode: a wrong column\n- Advisor rating: impact ${impact}, reversibility ${reversibility}\n- Recommendation: auto — routine\n`;

// `live` holds the local ports whose Plannotator server answers; `unserved` the routes turned off;
// `plans` the plan text each port's server returns.
async function withLinks(run: (links: ReviewLinks, get: (path: string, method?: string) => Promise<Response>, live: Set<number>, unserved: number[], plans: Map<number, string>) => Promise<void>, unserveError?: (port: number) => Error | null) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-review-links-"));
  const live = new Set<number>();
  const unserved: number[] = [];
  const plans = new Map<number, string>();
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
    fetchPlan: async (localUrl) => plans.get(Number(new URL(localUrl).port)) ?? "",
  });
  try {
    await links.start();
    const get = (path: string, method = "GET") => fetch(`http://127.0.0.1:${links.listeningPort}${path}`, { method, redirect: "manual" });
    await run(links, get, live, unserved, plans);
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
    assert.equal((await get("/nothing")).status, 404);
    assert.equal((await get("/review/agent-1", "POST")).status, 405);
    assert.equal((await get("/", "POST")).status, 405);
  });
});

test("the inbox lists only reviews the owner can open now, oldest first, and the latest decisions", async () => {
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
    assert.deepEqual(listed, ["agent-1", "agent-2", "agent-3"]);
    assert.match(waiting, /&#60;TUC-2&#62;/);
    assert.doesNotMatch(page, /TUC-3-old/);
    assert.match(recent, /TUC-6/);
    assert.match(recent, /approved/);
    assert.match(recent, /TUC-4/, "the dead review was closed by the sweep");
    assert.doesNotMatch(page, /TUC-5/);
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
    await links.described("http://localhost:50001/?r=1", `# TUC-1 — Warn when a <delay> breaks a date\n\n## Summary\n\nWhen a **container** is late, the [sales](https://x) team gets a notice.\n\n${RISK(3, "data-fix")}`, { approved: false, reasons: ["impact 3 is above the threshold 1", "reversibility is data-fix"] });
    // Opened before the plugin recorded details: read from its running server when the inbox loads.
    await links.opened("agent-2", { ...opened(50_002), agentId: "agent-2" }, "TUC-2");
    plans.set(50_002, `# TUC-2 · Report column\n\n| a | b |\n|---|---|\n\nAdds a column to the order report.\n\n${RISK(1)}`);
    // Decided while its server still answers: not waiting any more.
    await links.opened("agent-3", { ...opened(50_003), agentId: "agent-3" }, "TUC-3");
    await links.described("http://localhost:50003/?r=1", `# TUC-3 Tooling\n\nCI only.\n\n${RISK(0)}`, { approved: true, reasons: [] });
    await links.decided("agent-3", true);

    const page = await (await get("/")).text();
    const [waiting, recent] = page.split("Recently decided");
    assert.deepEqual([...waiting.matchAll(/href="\/review\/([^"]+)"/g)].map((match) => match[1]), ["agent-1", "agent-2"]);
    assert.match(waiting, /<div class="title">Warn when a &#60;delay&#62; breaks a date<\/div>/);
    assert.match(waiting, /<div class="summary">When a container is late, the sales team gets a notice\.<\/div>/);
    assert.match(waiting, /<span class="chip high">Risk: impact 3\/4 · data-fix<\/span>/);
    assert.match(waiting, /Needs you: impact 3 is above the threshold 1; reversibility is data-fix/);
    assert.match(waiting, /<div class="title">Report column<\/div><div class="summary">Adds a column to the order report\.<\/div><span class="chip low">Risk: impact 1\/4 · revert<\/span>/);
    assert.match(recent, /TUC-3<\/span><span class="meta">auto-approved/);
    assert.match(recent, /<div class="title">Tooling<\/div><span class="chip low">/);
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
