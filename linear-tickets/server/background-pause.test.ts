import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";
import { Dispatcher } from "./dispatch";
import { LinearService, postGraphQL } from "./linear";
import { ManualTasks, type ManualTask } from "./manual-tasks";
import { RateBudget } from "./rate-budget";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import type { TicketStarter } from "./starter";

// The real request path (LinearService → postGraphQL → budget) against a fake Linear: every
// request is recorded with its credential, and answers carry the pool's remaining requests.
type Call = { pool: "key" | "app"; operation: string };

function fakeLinear(t: TestContext, answer: (call: Call, variables: Record<string, unknown>) => { data: Record<string, unknown>; remaining: number }) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", (async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).authorization;
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const call: Call = { pool: auth.startsWith("Bearer ") ? "app" : "key", operation: body.query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? "?" };
    calls.push(call);
    const { data, remaining } = answer(call, body.variables);
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-requests-limit": call.pool === "key" ? "2500" : "5000", "x-ratelimit-requests-remaining": String(remaining) },
    });
  }) as typeof fetch);
  const budget = new RateBudget();
  const post = (key: string, query: string, variables: Record<string, unknown>) => postGraphQL(key, query, variables, budget);
  const linear = new LinearService(new Credentials("/unused", "env-key"), post, new AgentApi({ accessToken: async () => "app-token" }, post));
  return { calls, budget, linear };
}

function prime(budget: RateBudget, pool: "key" | "app", limit: number, remaining: number) {
  budget.acquire(pool, "interactive").done(new Headers({ "x-ratelimit-requests-limit": String(limit), "x-ratelimit-requests-remaining": String(remaining) }), false);
}

const settings = { dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["ENG"] }, writeback: DEFAULT_WRITEBACK } as unknown as PluginSettings;
const labeled = { issues: { nodes: [{ id: "3b241101-e2bb-4255-8caf-4136c566a962", identifier: "ENG-1", priority: 0, team: { key: "ENG" }, labels: { nodes: [{ id: "l1", name: "paseo" }] } }] } };
const starter = {
  admission: async () => { throw new Error("no launch while the key is paused"); },
  start: async () => { throw new Error("no launch while the key is paused"); },
} as unknown as TicketStarter;

function dispatcher(t: TestContext, linear: LinearService, budget: RateBudget) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = new Dispatcher({ linear, starter, settings: { read: async () => settings }, budget });
  result.attach({} as PaseoApi);
  return result;
}

test("with the key at its reserve, the dispatch poll still reads on the app and sends nothing with the key", async (t) => {
  const { calls, budget, linear } = fakeLinear(t, () => ({ data: labeled, remaining: 4900 }));
  prime(budget, "key", 2500, 100);
  const dispatch = dispatcher(t, linear, budget);
  await dispatch.tick();
  assert.deepEqual(calls, [{ pool: "app", operation: "labeledIssues" }]);
  assert.match(dispatch.snapshot().lastError ?? "", /^paused: Background Linear work is paused to keep the Linear API key's last requests/);
});

test("with the app at its reserve, the dispatch poll reads nothing and does not fall back to the key", async (t) => {
  const { calls, budget, linear } = fakeLinear(t, () => ({ data: labeled, remaining: 2400 }));
  prime(budget, "app", 5000, 100);
  const dispatch = dispatcher(t, linear, budget);
  await dispatch.tick();
  assert.deepEqual(calls, []);
  assert.match(dispatch.snapshot().lastError ?? "", /^paused: .*the Paseo Linear app/);
});

test("a key that reaches its reserve during a poll stops the remaining writes; the pause is logged once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-pause-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = (id: string, parentId: string): ManualTask => ({ id, identifier: id.toUpperCase(), url: `https://linear.app/x/issue/${id}`, title: `Do ${id}`, parentId, parentIdentifier: parentId.toUpperCase(), when: "anytime", check: null, cwd: "/nowhere", createdAt: `2026-09-28T00:00:0${id.length}Z`, announced: false, activated: true, verifiedAt: null });
  const tasks = [task("a", "p1"), task("bb", "p2")];
  for (const item of tasks) await writeFile(join(directory, `${item.id}.json`), JSON.stringify(item));
  // The key starts 5 requests above its reserve (375 of 2,500) and loses one per request.
  let keyRemaining = 380;
  const { calls, linear } = fakeLinear(t, (call, variables) => {
    if (call.pool === "app") return { data: { issues: { nodes: (variables.ids as string[]).map((id) => ({ id, state: { type: "unstarted" }, completedAt: null })) } }, remaining: 4900 };
    const remaining = keyRemaining--;
    const data: Record<string, Record<string, unknown>> = {
      labelByName: { issueLabels: { nodes: [{ id: "l-manual", name: "paseo-manual" }] } },
      addLabel: { issueAddLabel: { success: true } },
      viewerCheck: { viewer: { id: "me" } },
      userUrl: { user: { url: "https://linear.app/ws/profiles/me" } },
      comment: { commentCreate: { success: true, comment: { id: "c1" } } },
    };
    return { data: data[call.operation], remaining };
  });
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.join(" ")); });
  const manual = new ManualTasks({ linear, settings: { read: async () => settings } }, directory);

  await manual.poll();
  assert.deepEqual(calls.map((call) => `${call.pool} ${call.operation}`), [
    "app issueStatuses",
    "key labelByName", "key addLabel", "key viewerCheck", "key userUrl", "key comment",
    // The second ticket's label goes out; its mention would dip into the reserve and waits.
    "key addLabel",
  ]);
  assert.equal(JSON.parse(await readFile(join(directory, "a.json"), "utf8")).announced, true);
  assert.equal(JSON.parse(await readFile(join(directory, "bb.json"), "utf8")).announced, false);

  calls.length = 0;
  await manual.poll();
  assert.deepEqual(calls.map((call) => `${call.pool} ${call.operation}`), ["app issueStatuses"]);
  assert.equal(errors.filter((line) => line.includes("manual tasks paused")).length, 1);
});
