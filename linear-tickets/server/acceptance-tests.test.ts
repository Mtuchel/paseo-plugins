import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blockedTestWrite, isStrongModel, protectedWrite, STRONG_MODEL_ENV, writtenPaths, type AcceptanceTests } from "../shared/acceptance-tests";
import { AcceptanceTestsStore, acceptanceTestsDirectory } from "./acceptance-tests";

// The rules a cheap plan's acceptance tests follow (README, "Model tiers"), shared by the plugin
// (`server/acceptance-tests.ts` writes them) and the omp extension
// (omp/linear-tickets-plan-first.ts refuses a write from a session that is not on the strong
// model). `server/acceptance-guard.test.ts` runs the extension's hook end to end; this file holds
// the rules themselves and the store's own behavior.

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const FLASH = { provider: "lithos", id: "deepseek-ai/DeepSeek-V4.1-Flash-ultra" };
const SPEC = "omp/anthropic/claude-opus-5-5";
const TESTS: AcceptanceTests = { identifier: "TUC-7", paths: ["server/report.test.ts", "client/report.test.tsx"] };

// The store's file as the omp extension reads it: the raw JSON, narrowed before use.
async function savedFile(path: string): Promise<{ identifier: unknown; paths: unknown; at: unknown }> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(parsed !== null && typeof parsed === "object" && "identifier" in parsed && "paths" in parsed && "at" in parsed, "the saved file is JSON carrying the plan's fields");
  return parsed;
}

test("the store keeps one file per agent, replaces a replanned ticket's paths and clears them", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-acceptance-tests-"));
  try {
    const store = new AcceptanceTestsStore(acceptanceTestsDirectory(home));
    await store.save("agent-1", TESTS);
    const path = join(acceptanceTestsDirectory(home), "agent-1");
    const saved = await savedFile(path);
    assert.deepEqual({ identifier: saved.identifier, paths: saved.paths }, TESTS);
    assert.ok(typeof saved.at === "string" && !Number.isNaN(Date.parse(saved.at)), "the save records when");
    assert.equal((await stat(acceptanceTestsDirectory(home))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await store.save("agent-1", { identifier: "TUC-8", paths: ["server/other.test.ts"] });
    assert.deepEqual((await savedFile(path)).paths, ["server/other.test.ts"], "a replanned ticket replaces what its predecessor named");
    assert.deepEqual(await readdir(acceptanceTestsDirectory(home)), ["agent-1"], "no temporary file is left behind");
    await store.clear("agent-1");
    assert.deepEqual(await readdir(acceptanceTestsDirectory(home)), []);
    await store.clear("agent-1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("writtenPaths reads the write-ish tools' own path fields, an edit's patch headers and a device write's arguments", () => {
  assert.deepEqual(writtenPaths("write", { path: " server/report.test.ts ", content: "x" }), ["server/report.test.ts"]);
  assert.deepEqual(writtenPaths("edit", { path: "b.ts", paths: ["a.ts"] }), ["b.ts", "a.ts"]);
  assert.deepEqual(writtenPaths("ast_edit", { path: "server/report.test.ts" }), ["server/report.test.ts"]);
  const patch = "*** Begin Patch\n*** Update File: server/report.test.ts\n@@\n-old\n+new\n*** Move to: client/moved.test.ts\n*** End Patch";
  assert.deepEqual(writtenPaths("edit", { input: patch }), ["server/report.test.ts", "client/moved.test.ts"], "an edit's patch names its targets only in its headers");
  assert.deepEqual(writtenPaths("write", { path: "xd://write", content: JSON.stringify({ path: "server/report.test.ts" }) }), ["server/report.test.ts"], "a device write's own fields are read out of its JSON content");
  assert.deepEqual(writtenPaths("write", { path: "xd://mcp__linear_save_issue", content: JSON.stringify({ id: "TUC-7" }) }), [], "a Linear write names no file");
  assert.deepEqual(writtenPaths("write", { path: "xd://write", content: "not json" }), []);
  assert.deepEqual(writtenPaths("bash", { path: "server/report.test.ts" }), [], "a shell write is not seen: the guard catches accidental routing, it is not isolation");
  assert.deepEqual(writtenPaths("read", { path: "server/report.test.ts" }), []);
  assert.deepEqual(writtenPaths("write", undefined), []);
});

test("the guard matches a relative and an absolute path either way, and lifts for the strong model", () => {
  assert.equal(protectedWrite(TESTS, "write", { path: "/Users/x/checkout/server/report.test.ts" }), "server/report.test.ts", "an absolute path's suffix counts");
  assert.equal(protectedWrite(TESTS, "edit", { paths: ["./client/report.test.tsx"] }), "client/report.test.tsx");
  assert.equal(protectedWrite(TESTS, "write", { path: "server/report.test.tsx" }), null, "a near miss does not count");
  assert.equal(protectedWrite(TESTS, "write", { path: "other/server/report.test.ts.bak" }), null);
  assert.equal(protectedWrite({ identifier: "TUC-7", paths: [] }, "write", { path: "server/report.test.ts" }), null, "a plan that names no test file protects nothing");
  assert.equal(protectedWrite(null, "write", { path: "server/report.test.ts" }), null);
  assert.equal(protectedWrite(TESTS, "bash", { path: "server/report.test.ts" }), null);
});

test("isStrongModel needs the launch's own model, and a launch that recorded none is allowed", () => {
  assert.equal(STRONG_MODEL_ENV, "LINEAR_TICKETS_STRONG_MODEL");
  assert.equal(isStrongModel(OPUS, SPEC), true);
  assert.equal(isStrongModel(OPUS, "anthropic/claude-opus-5-5"), true, "the spec may arrive without omp's provider prefix");
  assert.equal(isStrongModel(OPUS, ` ${SPEC} `), true, "the environment is trimmed");
  assert.equal(isStrongModel(FLASH, SPEC), false);
  assert.equal(isStrongModel(OPUS, ""), false);
  assert.equal(isStrongModel(OPUS, null), false);
  assert.equal(isStrongModel(undefined, SPEC), false);
  assert.equal(isStrongModel({ provider: "anthropic" }, SPEC), false, "a model that has not loaded yet is not the strong one");
  assert.equal(blockedTestWrite(TESTS, "write", { path: "server/report.test.ts" }, FLASH, SPEC), "server/report.test.ts");
  assert.equal(blockedTestWrite(TESTS, "edit", { input: "*** Update File: client/report.test.tsx" }, FLASH, SPEC), "client/report.test.tsx", "a patch to the tests is held too");
  assert.equal(blockedTestWrite(TESTS, "write", { path: "server/report.test.ts" }, OPUS, SPEC), null, "the strong model wrote them, so it may change them");
  assert.equal(blockedTestWrite(TESTS, "write", { path: "server/report.test.ts" }, FLASH, null), null, "a launch that recorded no strong model (a resume, an older plugin) is allowed");
  assert.equal(blockedTestWrite(TESTS, "write", { path: "server/report.ts" }, FLASH, SPEC), null);
});

test("only the configured owner-approved Sol/high substitute gains strong test-writing authority", () => {
  const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
  const chains = { "anthropic/claude-opus-5-5": ["openai-codex/gpt-6.1-sol:high", "lithos/deepseek-ai/DeepSeek-V4.1-Flash-ultra:max", "openai-codex/arbitrary:high"] };
  const input = { path: "server/report.test.ts" };
  const blocked = (model: typeof OPUS, thinking: string | undefined, configured = chains) =>
    blockedTestWrite(TESTS, "write", input, model, SPEC, { chains: configured, thinking });
  assert.equal(blocked(FLASH, "high"), input.path, "a configured cheap fallback never gets the capability");
  assert.equal(blocked(OPUS, "low"), null, "the exact launch strong model stays allowed");
  assert.equal(blocked(sol, "high"), null);
  assert.equal(blocked(sol, "medium"), input.path);
  assert.equal(blocked(sol, undefined), input.path, "unknown live reasoning cannot prove the approved capability");
  assert.equal(blocked({ provider: "openai-codex", id: "arbitrary" }, "high"), input.path);
  assert.equal(blockedTestWrite(TESTS, "write", input, sol, SPEC, { chains: null, thinking: "high" }), input.path);
  assert.equal(blockedTestWrite(TESTS, "write", input, sol, SPEC, { chains: {}, thinking: "high" }), input.path);
  assert.equal(blockedTestWrite(TESTS, "write", input, sol, SPEC, { chains: { "anthropic/claude-opus-5-5": ["openai-codex/gpt-6.1-sol"] }, thinking: "high" }), input.path, "an unpinned fallback is not the approved high capability");
  assert.equal(blockedTestWrite(TESTS, "write", input, sol, SPEC, { chains: { "anthropic/claude-fable-5": ["openai-codex/gpt-6.1-sol:high"] }, thinking: "high" }), input.path, "another model's chain grants nothing");
  assert.equal(blockedTestWrite(TESTS, "write", input, sol, SPEC, { chains: { slow: ["openai-codex/gpt-6.1-sol:high"] }, thinking: "high" }), input.path, "role names are not configured model selectors");
  assert.equal(blockedTestWrite(TESTS, "write", input, sol, SPEC, { chains: { "omp/anthropic/*": ["omp/openai-codex/gpt-6.1-sol:high"] }, thinking: "high" }), null, "existing provider-prefix and wildcard selector conventions are shared");
});