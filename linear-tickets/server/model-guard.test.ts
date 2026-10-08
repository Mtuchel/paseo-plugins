import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { drift, ModelGuard } from "./model-guard";
import { launchTier, type TierRecord, type TierSource } from "./model-tiers";
import type { Tier } from "../shared/plan-model";

const settings = { launchPreferences: { omp: { model: "omp/anthropic/claude-opus-5-5", modeId: "full", thinkingOptionId: "medium" } }, cheapModels: {}, standardModels: {} };
const ticketAgent = (runtime: string, thinking = "medium", labels: Record<string, string> = { "linear.issueId": "i1" }) =>
  ({ id: "a1", provider: "omp", model: "anthropic/claude-opus-5-5", thinkingOptionId: "medium", runtimeInfo: { provider: "omp", sessionId: "s", model: runtime, thinkingOptionId: thinking }, labels, archivedAt: null }) as never;
// omp's fallback chains (retry.fallbackChains): the Claude account inside its usage reserve runs on
// GPT-6.1 Sol. `noFallbacks`: readable, nothing configured. The tests pass `async () => null` where
// the chains cannot be read.
const fallbackChains: Record<string, string[]> = { "anthropic/claude-opus-5-5": ["openai-codex/gpt-6.1-sol:high"], "anthropic/claude-fable-5": ["anthropic/claude-opus-5:high"] };
const noFallbacks: Record<string, string[]> = {};
const noTier = async () => null;

test("a ticket agent drifting from the launch model is detected; others are left alone", () => {
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5"), settings), null);
  assert.deepEqual(drift(ticketAgent("deepseek/deepseek-v4-flash"), settings), { agentId: "a1", from: "deepseek/deepseek-v4-flash · thinking medium", to: "anthropic/claude-opus-5-5 · thinking medium", model: "anthropic/claude-opus-5-5", thinking: null, tier: null });
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5", "high"), settings)?.thinking, "medium");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash", "medium", {}), settings), null, "not a ticket agent");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash", "medium", { "linear.issueId": "i1", "paseo.parent-agent-id": "p" }), settings), null, "subagents follow their parent");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash"), { launchPreferences: {}, cheapModels: {}, standardModels: {} }), null, "no launch model chosen");
});

test("the guard restores the model once and announces it in the ticket's panel", async () => {
  const calls: string[] = [];
  let runtime = "deepseek/deepseek-v4-flash";
  const guard = new ModelGuard({ read: async () => settings as never }, async () => ({
    setModel: async (id, model) => { calls.push(`model ${id} ${model}`); runtime = model; },
    setThinking: async (id, level) => { calls.push(`thinking ${id} ${level}`); },
  }), async (change) => { calls.push(`announce ${change.from} -> ${change.to}`); }, noTier, async () => noFallbacks);
  const paseo = { agents: { subscribe: () => () => {}, list: async () => ({ entries: [{ agent: ticketAgent(runtime) }] }) } } as unknown as PaseoApi;
  guard.attach(paseo);
  guard.stop();
  await guard.sweep();
  await guard.check(ticketAgent(runtime));
  // attach() started a sweep of its own; let it settle so a second restore would show.
  await setImmediate();
  assert.deepEqual(calls, [
    "model a1 anthropic/claude-opus-5-5",
    "announce deepseek/deepseek-v4-flash · thinking medium -> anthropic/claude-opus-5-5 · thinking medium",
  ]);
});

test("a model omp's own usage fallback picked is left alone: no restore, no announcement", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const calls: string[] = [];
  const guard = new ModelGuard({ read: async () => settings as never }, async () => ({
    setModel: async (id, model) => { calls.push(`model ${id} ${model}`); },
    setThinking: async (id, level) => { calls.push(`thinking ${id} ${level}`); },
  }), async (change) => { calls.push(`announce ${change.from} -> ${change.to}`); }, noTier, async () => fallbackChains);
  // The Claude account is inside its reserve margin: omp runs the session on GPT-6.1 Sol, thinking high.
  assert.equal(await guard.check(ticketAgent("openai-codex/gpt-6.1-sol", "high")), null);
  assert.deepEqual(calls, [], "neither the model nor the thinking level is touched");
  assert.deepEqual(errors.mock.calls, [], "nothing is restored or announced");
});

test("a drift that is not one of the intended model's fallbacks is still restored", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const calls: string[] = [];
  const guard = new ModelGuard({ read: async () => settings as never }, async () => ({
    setModel: async (id, model) => { calls.push(`model ${id} ${model}`); },
    setThinking: async (id, level) => { calls.push(`thinking ${id} ${level}`); },
  }), async (change) => { calls.push(`announce ${change.from} -> ${change.to}`); }, noTier, async () => fallbackChains);
  // Plannotator restored the model it saved before planning; DeepSeek flash is nobody's fallback for Opus.
  assert.deepEqual(await guard.check(ticketAgent("deepseek/deepseek-v4-flash")), { agentId: "a1", from: "deepseek/deepseek-v4-flash · thinking medium", to: "anthropic/claude-opus-5-5 · thinking medium", model: "anthropic/claude-opus-5-5", thinking: null, tier: null });
  assert.deepEqual(calls, ["model a1 anthropic/claude-opus-5-5", "announce deepseek/deepseek-v4-flash · thinking medium -> anthropic/claude-opus-5-5 · thinking medium"]);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /agent a1: restored anthropic\/claude-opus-5-5 · thinking medium \(was deepseek\/deepseek-v4-flash/);
  // Opus-5 is a fallback of Fable-5, not of the intended Opus-5-5.
  const other = new ModelGuard({ read: async () => settings as never }, async () => ({ setModel: async () => {}, setThinking: async () => {} }), async () => {}, noTier, async () => fallbackChains);
  assert.equal((await other.check(ticketAgent("anthropic/claude-opus-5")))?.model, "anthropic/claude-opus-5-5");
});

test("when the chains cannot be read, a switched model is left alone, the reason logged once", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const calls: string[] = [];
  const guard = new ModelGuard({ read: async () => settings as never }, async () => ({
    setModel: async (id, model) => { calls.push(`model ${id} ${model}`); },
    setThinking: async (id, level) => { calls.push(`thinking ${id} ${level}`); },
  }), async (change) => { calls.push(`announce ${change.to}`); }, noTier, async () => null);
  // Restoring is the side that can loop, so an unattributable switch stays.
  assert.equal(await guard.check(ticketAgent("openai-codex/gpt-6.1-sol", "high")), null);
  assert.equal(await guard.check(ticketAgent("openai-codex/gpt-6.1-sol", "high")), null);
  assert.deepEqual(calls, []);
  assert.equal(errors.mock.calls.length, 1);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /agent a1: omp's fallback chains cannot be read; keeping openai-codex\/gpt-6.1-sol instead of restoring anthropic\/claude-opus-5-5/);
});

test("a thinking level that drifted is restored whether or not the chains can be read", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls: string[] = [];
  const guard = new ModelGuard({ read: async () => settings as never }, async () => ({
    setModel: async (id, model) => { calls.push(`model ${id} ${model}`); },
    setThinking: async (id, level) => { calls.push(`thinking ${id} ${level}`); },
  }), async (change) => { calls.push(`announce ${change.to}`); }, noTier, async () => null);
  // No model switch: omp's fallback always moves the model with it.
  assert.equal((await guard.check(ticketAgent("anthropic/claude-opus-5-5", "high")))?.thinking, "medium");
  assert.deepEqual(calls, ["thinking a1 medium", "announce anthropic/claude-opus-5-5 · thinking medium"]);
});

const tiered = { ...settings, cheapModels: { omp: { model: "omp/deepseek/deepseek-flash", thinkingOptionId: "max" } }, standardModels: { omp: { model: "omp/openai-codex/gpt-6.1-sol", thinkingOptionId: "high" } } };

test("an agent on the cheap or standard tier runs the provider's model for it; without one, or on the strong tier, the launch model", () => {
  assert.deepEqual(drift(ticketAgent("anthropic/claude-opus-5-5"), tiered, "cheap"), { agentId: "a1", from: "anthropic/claude-opus-5-5 · thinking medium", to: "deepseek/deepseek-flash · thinking max", model: "deepseek/deepseek-flash", thinking: "max", tier: "cheap" });
  assert.deepEqual(drift(ticketAgent("anthropic/claude-opus-5-5"), tiered, "standard"), { agentId: "a1", from: "anthropic/claude-opus-5-5 · thinking medium", to: "openai-codex/gpt-6.1-sol · thinking high", model: "openai-codex/gpt-6.1-sol", thinking: "high", tier: "standard" });
  assert.equal(drift(ticketAgent("deepseek/deepseek-flash", "max"), tiered, "cheap"), null);
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5"), settings, "cheap"), null, "no cheap model for this provider");
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5"), settings, "standard"), null, "no standard model for this provider");
  assert.equal(drift(ticketAgent("deepseek/deepseek-flash", "max"), tiered, "strong")?.model, "anthropic/claude-opus-5-5", "an escalated agent goes back to the launch model");
  assert.equal(drift(ticketAgent("openai-codex/gpt-6.1-sol", "high"), tiered, "strong")?.model, "anthropic/claude-opus-5-5", "an agent escalated from standard goes to the launch model");
});

test("a launch's tier is the strongest of label, decided record and plan; a recorded start alone decides nothing", () => {
  const record = (...events: [TierSource, Tier][]): TierRecord => ({ issueId: "i1", identifier: "TUC-1", tier: events.at(-1)![1], agentId: "a1", updatedAt: "", history: events.map(([source, tier]) => ({ source, tier, reason: "", agentId: "a1", model: null, at: "" })) });
  assert.equal(launchTier([], null, "standard"), "standard");
  assert.equal(launchTier([{ name: "model:cheap" }], null, "standard"), "standard", "the plan raises a lower label");
  assert.equal(launchTier([{ name: "Model:Strong" }], null, "cheap"), "strong");
  assert.equal(launchTier([], record(["plan", "standard"], ["escalated", "strong"], ["start", "strong"]), "standard"), "strong", "an escalation stays");
  assert.equal(launchTier([], record(["start", "strong"]), null), null, "a start from before plans named a tier is no decision");
  assert.equal(launchTier([], null, null), null);
});

test("a tier decided right after a restore is applied at once, not after the quiet window", async () => {
  const calls: string[] = [];
  let runtime = "deepseek/deepseek-v4-flash";
  let thinking = "medium";
  let tier: "cheap" | "strong" | null = null;
  const guard = new ModelGuard({ read: async () => tiered as never }, async () => ({
    setModel: async (_id, model) => { calls.push(`model ${model}`); runtime = model; },
    setThinking: async (_id, level) => { calls.push(`thinking ${level}`); thinking = level; },
  }), async (change) => { calls.push(`announce ${change.tier ?? "launch"} ${change.to}`); }, async () => tier, async () => noFallbacks);
  const paseo = { agents: { subscribe: () => () => {}, list: async () => ({ entries: [] }), ref: () => ({ refresh: async () => ({ agent: ticketAgent(runtime, thinking) }) }) } } as unknown as PaseoApi;
  guard.attach(paseo);
  guard.stop();
  await guard.check(ticketAgent(runtime, thinking));
  tier = "cheap";
  assert.equal(await guard.check(ticketAgent(runtime, thinking)), null, "the quiet window holds back an ordinary check");
  await guard.apply("a1");
  assert.deepEqual(calls, [
    "model anthropic/claude-opus-5-5",
    "announce launch anthropic/claude-opus-5-5 · thinking medium",
    "model deepseek/deepseek-flash",
    "thinking max",
    "announce cheap deepseek/deepseek-flash · thinking max",
  ]);
});
