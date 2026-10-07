import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { agentStatusRpc } from "../shared/contracts";
import { PlannotatorHost } from "./parked";
import { PlannotatorBridge } from "./plannotator";
import { rateBudget, RateLimitedError, withPriority } from "./rate-budget";
import { ReviewLinks } from "./review-links";

// AC-1: use the production inbox HTTP handler, index callback and decision journal drainer.
test("an inbox approval consumes the owner's reserve through the production decision ingress", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "paseo-review-budget-"));
  const priorHome = process.env.PASEO_HOME;
  const priorKey = process.env.LINEAR_API_KEY;
  process.env.PASEO_HOME = home;
  process.env.LINEAR_API_KEY = "fixture-owner-key";
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await mkdir(join(home, "linear-tickets"));
  await writeFile(join(home, "linear-tickets", "settings.json"), JSON.stringify({ writeback: { status: true } }));
  let approved = false;
  const review = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/approve") approved = true;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ plan: "# Plan\n\n## Model\n\n- Tier: strong — owner decisions\n- Strong steps: all — budget admission\n" }));
  });
  review.listen(0, "127.0.0.1");
  await once(review, "listening");
  const address = review.address();
  assert.ok(address && typeof address === "object");
  const localUrl = `http://127.0.0.1:${address.port}/`;
  let inbox: ReviewLinks | undefined;
  let bridge: PlannotatorBridge | undefined;
  const startInbox = ReviewLinks.prototype.start;
  t.mock.method(ReviewLinks.prototype, "start", function (this: ReviewLinks) {
    inbox = this;
    Object.assign(this, { port: 0, proxyPort: 0, serve: async () => "https://review.fixture.test", peers: async () => [] });
    return startInbox.call(this);
  });
  const attachBridge = PlannotatorBridge.prototype.attach;
  t.mock.method(PlannotatorBridge.prototype, "attach", function (this: PlannotatorBridge, paseo: PaseoApi) {
    bridge = this;
    return attachBridge.call(this, paseo);
  });
  t.mock.method(PlannotatorHost.prototype, "start", async () => {});
  const headers = new Headers({
    "x-ratelimit-requests-limit": "2500", "x-ratelimit-requests-remaining": "2250",
    "x-ratelimit-complexity-limit": "3000000", "x-ratelimit-complexity-remaining": "90000", "x-complexity": "12",
  });
  rateBudget.acquire("key", "owner").done(headers, false);
  const operations: string[] = [];
  const answers: Record<string, object> = {
    issueState: { issue: { id: "issue-1", identifier: "TUC-TEST", state: { id: "todo", name: "Todo", type: "unstarted" }, team: { id: "team-1" }, labels: { nodes: [] } } },
    teamStates: { team: { states: { nodes: [{ id: "coding", name: "In Progress", type: "started", position: 1 }] } } },
    issueUpdateState: { issueUpdate: { success: true, issue: { id: "issue-1", state: { id: "coding", name: "In Progress", type: "started" } } } },
    labelByName: { issueLabels: { nodes: [{ id: "ready", name: "plan-ready" }] } },
    addLabel: { issueAddLabel: { success: true } },
    issueDocuments: { issue: { id: "issue-1", documents: { nodes: [] } } },
    documentCreate: { documentCreate: { success: true, document: { id: "doc-1", url: "https://linear.app/doc/1" } } },
    comment: { commentCreate: { success: true, comment: { id: "comment-1" } } },
  };
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== "https://api.linear.app/graphql") return fetch(url, init);
    const body = JSON.parse(String(init?.body));
    const operation = /^(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "unknown";
    operations.push(operation);
    assert.ok(answers[operation], `unexpected Linear operation ${operation}`);
    return new Response(JSON.stringify({ data: answers[operation] }), { headers });
  });
  let readStatus: ((input: object, context: { paseo: PaseoApi }) => Promise<unknown>) | undefined;
  const cleanup = contribute({
    handle(contract: { name: string }, handler: typeof readStatus) { if (contract.name === agentStatusRpc.name) readStatus = handler; },
    on() { return () => {}; }, before() { return () => {}; },
  } as unknown as PluginServerContext);
  t.after(async () => {
    await cleanup();
    await new Promise<void>((resolve) => review.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = priorHome;
    if (priorKey === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = priorKey;
    await rm(home, { recursive: true, force: true });
  });
  const paseo = { agents: {
    list: async () => ({ entries: [] }), subscribe: () => () => {},
    ref: () => ({ refresh: async () => ({ agent: { id: "agent-1", labels: { "linear.issueId": "issue-1", "linear.identifier": "TUC-TEST" } } }), timeline: { append: async () => {} } }),
  } } as unknown as PaseoApi;
  assert.ok(readStatus);
  await readStatus({}, { paseo });
  assert.ok(inbox && bridge);
  await inbox.start();
  await inbox.opened("agent-1", { type: "opened", agentId: "agent-1", localUrl, remoteUrl: "https://review.fixture.test", at: new Date().toISOString() }, { issueId: "issue-1", identifier: "TUC-TEST" });
  const response = await fetch(`http://127.0.0.1:${inbox.listeningPort}/api/reviews/agent-1/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-review-action": "1" }, body: JSON.stringify({ approve: true }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(approved, true);
  await withPriority("background", "inbox fixture drainer", () => bridge!.drain());
  assert.ok(operations.includes("issueUpdateState"));
  assert.ok(operations.includes("documentCreate"));
  assert.ok(operations.includes("comment"));
  assert.throws(() => rateBudget.acquire("key", "interactive"), RateLimitedError);
});
