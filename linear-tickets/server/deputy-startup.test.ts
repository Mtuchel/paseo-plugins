import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import contribute from "../index.server";
import { Deputy, fingerprint } from "./deputy";
import { PermissionReplies } from "./permission-replies";
import { SessionRouter, SessionStore } from "./sessions";
import { ReviewLinks } from "./review-links";
import { PlannotatorHost } from "./parked";
import { LinearBroker } from "./linear-broker";

for (const entry of ["reconcile", "settings"] as const) {
  test(`${entry} as first RPC awaits restored multipart owner holds and the checked SDK; a failed restore is retryable`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const home = await mkdtemp(join(tmpdir(), "deputy-startup-"));
    const prior = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:0" } }));
    t.mock.method(globalThis, "fetch", async () => { throw new Error("No network in isolated startup regression"); });
    for (const type of [ReviewLinks, PlannotatorHost, LinearBroker]) t.mock.method(type.prototype, "start", async () => {});
    t.mock.method(DaemonClient.prototype, "connect", async function(this: DaemonClient) {
      const config = Reflect.get(this, "config") as { clientId: string };
      if (config.clientId !== "linear-tickets-internal-permission") throw new Error("Isolated fixture disables background daemon connections");
    });
    const submitted: string[] = [];
    t.mock.method(DaemonClient.prototype, "respondToPermissionAndWait", async (_agent: string, id: string) => { submitted.push(id); });
    const request = (id: string) => ({ id, provider: "omp", name: "ask", kind: "question" as const,
      input: { questions: [{ header: "First", question: "Which runner?", options: [{ label: "node:test" }, { label: "vitest" }] },
        { header: "Second", question: "Which format?", options: [{ label: "JSON" }, { label: "CSV" }] }] } });
    const held = request("held");
    const unheld = request("unheld");
    await new SessionStore().put({ sessionId: "persisted", agentId: "a1", issueId: "i1", identifier: "TUC-1", createdAt: new Date().toISOString(), handled: [], review: null, offer: null,
      questions: { requestId: held.id, request: held, index: 1, answers: { First: "vitest" } } });
    let replies: PermissionReplies;
    const effects = PermissionReplies.prototype.recordEffects;
    t.mock.method(PermissionReplies.prototype, "recordEffects", function(this: PermissionReplies, ...args: Parameters<typeof effects>) { replies = this; effects.apply(this, args); });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let restores = 0;
    let fail = true;
    const seed = SessionRouter.prototype.seedHolds;
    t.mock.method(SessionRouter.prototype, "seedHolds", async function(this: SessionRouter) {
      restores++;
      await gate;
      if (fail) throw new Error("persisted owner holds unreadable");
      await seed.call(this);
    });
    // Exercise the real reply arbiter/ledger at the point discovery would first submit.
    // Selection itself is outside this startup regression and supplied deterministically.
    let discoveries = 0;
    const deliver = async () => {
      discoveries++;
      const outcomes = [];
      for (const pending of [held, unheld]) outcomes.push(await replies.respond({ agentId: "a1", requestId: pending.id, fingerprint: fingerprint(pending), intentId: `intent-${pending.id}`,
        canSubmit: () => true, response: { behavior: "allow" as const, updatedInput: { answers: { First: "node:test", Second: "JSON" } } } }));
      assert.deepEqual(outcomes, ["owner-first", "applied"]);
      return { observed: 2, skipped: 0, failed: 0 };
    };
    t.mock.method(Deputy.prototype, "attach", () => {});
    t.mock.method(Deputy.prototype, "reconcile", deliver);
    t.mock.method(Deputy.prototype, "recheckPolicy", deliver);
    const handlers = new Map<string, (input: object, context: { paseo: PaseoApi }) => Promise<unknown>>();
    const cleanup = contribute({ handle: (contract: { name: string }, handler: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(contract.name, handler), on() { return () => {}; }, before() { return () => {}; } } as unknown as PluginServerContext);
    t.after(async () => {
      await cleanup();
      if (prior === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = prior;
      await rm(home, { recursive: true, force: true });
    });
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }), subscribe: () => () => {}, ref: () => ({ refresh: async () => ({ agent: { pendingPermissions: [held, unheld] } }) }) } } as unknown as PaseoApi;
    const invoke = () => handlers.get(entry === "reconcile" ? "linear.reconcile-deputy" : "linear.set-settings")!(entry === "reconcile" ? {} : { deputy: { mode: "shadow" } }, { paseo });
    const first = invoke();
    const rejected = assert.rejects(first, /persisted owner holds unreadable/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(discoveries, 0, "no recovery or inventory can run while persisted owner holds are unresolved");
    assert.deepEqual(submitted, []);
    release();
    await rejected;
    assert.equal(discoveries, 0, "failed restoration cannot become permission to evaluate/dispatch");
    fail = false;
    await invoke();
    assert.equal(restores, 2, "a later authorized operation retries the failed restoration");
    assert.deepEqual(submitted, ["unheld"], "the first successfully initialized operation submits only the unheld exact request through the attached SDK");
  });
}
