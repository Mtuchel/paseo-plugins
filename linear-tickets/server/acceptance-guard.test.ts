import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
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
const priorPath = process.env.PATH;
process.env.PATH = `${root}:${priorPath ?? ""}`;
const configPath = join(root, "fallback-config.json");
const binary = join(root, "omp");
// The actual hook executes its normal config command, isolated from the owner's configuration.
writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["config", "get", "retry.fallbackChains", "--json"])) process.exit(2);
(async () => {
  if (process.env.ACCEPTANCE_GUARD_BARRIER_PORT) await new Promise((resolve, reject) => {
    const socket = require("node:net").connect(Number(process.env.ACCEPTANCE_GUARD_BARRIER_PORT), "127.0.0.1");
    socket.once("error", reject);
    socket.once("data", () => { socket.end(); resolve(); });
  });
  process.stdout.write(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
})().catch(() => process.exit(1));
`);
chmodSync(binary, 0o700);
const { default: extension } = await import("../omp/linear-tickets-plan-first");
after(() => {
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
  rmSync(root, { recursive: true, force: true });
});

type Ctx = { cwd: string; agent?: { kind?: string }; models: { current(): { provider: string; id: string } }; sessionManager: { getBranch(): never[] } };
type Hook = (event: { toolName: string; input: Record<string, unknown> }, ctx: Ctx) => Promise<{ block: true; reason: string } | undefined>;

const hooks: Hook[] = [];
let thinking = "max";
let currentOverride: { provider: string; id: string } | null = null;
extension({
  on: (event: string, handler: Hook) => { if (event === "tool_call") hooks.push(handler); },
  events: { emit: () => {} },
  appendEntry: () => {},
  sendMessage: () => {},
  registerTool: () => {},
  zod: { object: () => ({}), string: () => ({ describe: () => ({}), optional: () => ({}) }), number: () => ({}), enum: () => ({}) },
  getThinkingLevel: () => thinking,
} as never);

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const FLASH = { provider: "lithos", id: "deepseek-ai/DeepSeek-V4.1-Flash" };
const SOL = { provider: "openai-codex", id: "gpt-6.1-sol" };
const CHAIN = { value: { "anthropic/claude-opus-5-5": ["openai-codex/gpt-6.1-sol:high", "lithos/deepseek-ai/DeepSeek-V4.1-Flash:max", "openai-codex/arbitrary:high"] } };
const store = new AcceptanceTestsStore(acceptanceTestsDirectory(root));

async function write(path: string, model: typeof OPUS, kind?: string, level = "max") {
  thinking = level;
  const ctx: Ctx = { cwd: root, agent: kind ? { kind } : undefined, models: { current: () => currentOverride ?? model }, sessionManager: { getBranch: () => [] } };
  const results = await Promise.all(hooks.map((hook) => hook({ toolName: "write", input: { path, content: "x" } }, ctx)));
  return results.find(Boolean)?.reason ?? null;
}

test("a cheap session cannot write its plan's acceptance tests; the strong model can", async () => {
  await store.save("ticket-agent-1", { identifier: "TUC-7", paths: ["server/foo.test.ts"] });
  assert.notEqual(await write(`${root}/checkout/server/foo.test.ts`, FLASH), null);
  assert.match(await write("server/foo.test.ts", FLASH, "sub") ?? "", /acceptance tests/, "a cheap task subagent is held too");
  assert.equal(await write("server/foo.test.ts", OPUS, "sub"), null, "a session actually on the strong model writes them");
  assert.equal(await write("server/foo.ts", FLASH), null, "the implementation stays open");
});

test("the live hook allows only the configured approved strong fallback at high reasoning", async () => {
  await store.save("ticket-agent-1", { identifier: "TUC-7", paths: ["server/foo.test.ts"] });
  writeFileSync(configPath, JSON.stringify(CHAIN));
  assert.equal(await write("server/foo.test.ts", SOL, "sub", "high"), null);
  assert.match(await write("server/foo.test.ts", SOL, "sub", "medium") ?? "", /acceptance tests/);
  assert.match(await write("server/foo.test.ts", FLASH, "sub", "high") ?? "", /acceptance tests/, "even a configured Flash fallback cannot edit tests");
  assert.match(await write("server/foo.test.ts", { provider: "openai-codex", id: "arbitrary" }, "sub", "high") ?? "", /acceptance tests/);
  assert.equal(await write("server/foo.test.ts", OPUS, "sub", "low"), null);
});

test("invalid, unreadable or revoked fallback configuration does not authorize a substitute", async () => {
  await store.save("ticket-agent-1", { identifier: "TUC-7", paths: ["server/foo.test.ts"] });
  for (const raw of ["broken", "null", '{"value":null}', '{"value":{"anthropic/claude-opus-5-5":[7]}}', '{"value":{}}']) {
    writeFileSync(configPath, raw);
    assert.match(await write("server/foo.test.ts", SOL, "sub", "high") ?? "", /acceptance tests/);
  }
  rmSync(configPath);
  assert.match(await write("server/foo.test.ts", SOL, "sub", "high") ?? "", /acceptance tests/);
  writeFileSync(configPath, JSON.stringify(CHAIN));
  assert.equal(await write("server/foo.test.ts", SOL, "sub", "high"), null);
  writeFileSync(configPath, '{"value":{}}');
  assert.match(await write("server/foo.test.ts", SOL, "sub", "high") ?? "", /acceptance tests/, "no positive cache masks revocation");
});

test("a model switch during the fallback lookup cannot lend strong authority to Flash", { timeout: 10_000 }, async () => {
  await store.save("ticket-agent-1", { identifier: "TUC-7", paths: ["server/foo.test.ts"] });
  writeFileSync(configPath, JSON.stringify(CHAIN));
  const server = createServer();
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.ACCEPTANCE_GUARD_BARRIER_PORT = String(address.port);
  const incoming = once(server, "connection").then(([socket]) => socket as Socket);
  const pending = write("server/foo.test.ts", SOL, "sub", "high");
  let socket: Socket | undefined;
  try {
    socket = await Promise.race([incoming, pending.then(() => { throw new Error("the config command completed before reaching its IPC barrier"); })]);
    currentOverride = FLASH;
    thinking = "max";
    socket.end("release");
    assert.match(await pending ?? "", /acceptance tests/);
  } finally {
    delete process.env.ACCEPTANCE_GUARD_BARRIER_PORT;
    socket?.destroy();
    server.close();
    await pending;
    currentOverride = null;
  }
});

test("once the plugin clears the agent's tests, the cheap session may write them", async () => {
  await store.clear("ticket-agent-1");
  assert.equal(await write("server/foo.test.ts", FLASH), null);
});
