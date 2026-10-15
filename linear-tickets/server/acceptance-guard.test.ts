import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { STRONG_MODEL_ENV } from "../shared/acceptance-tests";
import { AcceptanceTestsStore, acceptanceTestsDirectory } from "./acceptance-tests";

// The omp extension reads its environment when it loads, so it is imported after this setup: an
// implementing ticket agent whose cheap plan names acceptance tests.
const root = mkdtempSync(join(tmpdir(), "paseo-acceptance-guard-"));
for (const name of Object.keys(process.env)) if (name.startsWith("LINEAR_TICKETS_")) delete process.env[name];
Object.assign(process.env, { PASEO_AGENT_ID: "ticket-agent-1", PASEO_HOME: root, PI_CODING_AGENT_DIR: root, LINEAR_TICKETS_ISSUE: "TUC-7", [STRONG_MODEL_ENV]: "omp/anthropic/claude-opus-5-5" });
const { default: extension } = await import("../omp/linear-tickets-plan-first");
after(() => rmSync(root, { recursive: true, force: true }));

type Ctx = { cwd: string; agent?: { kind?: string }; models: { current(): { provider: string; id: string } }; sessionManager: { getBranch(): never[] } };
type Hook = (event: { toolName: string; input: Record<string, unknown> }, ctx: Ctx) => Promise<{ block: true; reason: string } | undefined>;

const hooks: Hook[] = [];
extension({
  on: (event: string, handler: Hook) => { if (event === "tool_call") hooks.push(handler); },
  events: { emit: () => {} },
  appendEntry: () => {},
  sendMessage: () => {},
  registerTool: () => {},
  zod: { object: () => ({}), string: () => ({ describe: () => ({}), optional: () => ({}) }), number: () => ({}), enum: () => ({}) },
} as never);

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const FLASH = { provider: "lithos", id: "deepseek-ai/DeepSeek-V4.1-Flash-ultra" };
const store = new AcceptanceTestsStore(acceptanceTestsDirectory(root));

async function write(path: string, model: typeof OPUS, kind?: string) {
  const ctx: Ctx = { cwd: root, agent: kind ? { kind } : undefined, models: { current: () => model }, sessionManager: { getBranch: () => [] } };
  const results = await Promise.all(hooks.map((hook) => hook({ toolName: "write", input: { path, content: "x" } }, ctx)));
  return results.find(Boolean)?.reason ?? null;
}

test("a cheap session cannot write its plan's acceptance tests; the strong model can", async () => {
  await store.save("ticket-agent-1", { identifier: "TUC-7", paths: ["server/foo.test.ts"] });
  assert.match(await write(`${root}/checkout/server/foo.test.ts`, FLASH) ?? "", /acceptance tests.*@slow/s);
  assert.match(await write("server/foo.test.ts", FLASH, "sub") ?? "", /acceptance tests/, "a cheap task subagent is held too");
  assert.equal(await write("server/foo.test.ts", OPUS, "sub"), null, "the @slow subagent on the strong model writes them");
  assert.equal(await write("server/foo.ts", FLASH), null, "the implementation stays open");
});

test("once the plugin clears the agent's tests, the cheap session may write them", async () => {
  await store.clear("ticket-agent-1");
  assert.equal(await write("server/foo.test.ts", FLASH), null);
});
