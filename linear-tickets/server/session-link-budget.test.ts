import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentApi } from "./agent-app";
import { postGraphQL } from "./linear";
import { RateBudget, RateLimitedError, withPriority } from "./rate-budget";
import { SessionRouter, SessionStore } from "./sessions";

test("a refused background session link stays undelivered and is retried after refill", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-session-link-budget-"));
  const cli = join(directory, "paseo");
  await writeFile(cli, '#!/bin/sh\nprintf \'{"serverId":"fixture-server"}\\n\'\n', { mode: 0o700 });
  const previousCli = process.env.PASEO_CLI;
  process.env.PASEO_CLI = cli;
  t.after(async () => {
    if (previousCli === undefined) delete process.env.PASEO_CLI; else process.env.PASEO_CLI = previousCli;
    await rm(directory, { recursive: true, force: true });
  });
  const store = new SessionStore(join(directory, "sessions.json"));
  await store.put({ sessionId: "s1", issueId: "issue-1", identifier: "TUC-1", agentId: "agent-1", createdAt: new Date().toISOString(), handled: [], review: null, offer: null });
  const budget = new RateBudget(() => 0);
  const sample = (points: number) => budget.acquire("app", "owner").done(new Headers({
    "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "4500",
    "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": String(points),
  }), false);
  sample(380_000);
  const writes: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    writes.push(body.variables.input);
    return new Response(JSON.stringify({ data: { agentSessionUpdate: { success: true } } }));
  });
  const api = new AgentApi({ accessToken: async () => "app-token" }, (key, query, variables) => postGraphQL(key, query, variables, budget));
  const router = new SessionRouter({ api, store } as never);
  const deliver = () => withPriority("background", "session sweep: session links", () => router.linkToPaseo("s1", "agent-1"));
  await assert.rejects(deliver(), RateLimitedError);
  assert.equal(writes.length, 0);
  assert.equal((await store.get("s1"))?.paseoLinked, undefined);
  sample(420_000);
  await deliver();
  assert.equal((await store.get("s1"))?.paseoLinked, "agent-1");
  assert.deepEqual(writes, [{ addedExternalUrls: [{ label: "Open in Paseo", url: "https://app.paseo.sh/h/fixture-server/agent/agent-1" }] }]);
});
