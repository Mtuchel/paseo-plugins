import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { drift, ModelGuard } from "./model-guard";

const settings = { launchPreferences: { omp: { model: "omp/anthropic/claude-opus-5-5", modeId: "full", thinkingOptionId: "medium" } }, cheapModels: {} };
const ticketAgent = (runtime: string, thinking = "medium", labels: Record<string, string> = { "linear.issueId": "i1" }) =>
  ({ id: "a1", provider: "omp", model: "anthropic/claude-opus-5-5", thinkingOptionId: "medium", runtimeInfo: { provider: "omp", sessionId: "s", model: runtime, thinkingOptionId: thinking }, labels, archivedAt: null }) as never;

test("a ticket agent drifting from the launch model is detected; others are left alone", () => {
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5"), settings), null);
  assert.deepEqual(drift(ticketAgent("deepseek/deepseek-v4-flash"), settings), { agentId: "a1", from: "deepseek/deepseek-v4-flash · thinking medium", to: "anthropic/claude-opus-5-5 · thinking medium", model: "anthropic/claude-opus-5-5", thinking: null, tier: null });
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5", "high"), settings)?.thinking, "medium");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash", "medium", {}), settings), null, "not a ticket agent");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash", "medium", { "linear.issueId": "i1", "paseo.parent-agent-id": "p" }), settings), null, "subagents follow their parent");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash"), { launchPreferences: {}, cheapModels: {} }), null, "no launch model chosen");
});

test("the guard restores the model once and announces it in the ticket's panel", async () => {
  const calls: string[] = [];
  let runtime = "deepseek/deepseek-v4-flash";
  const guard = new ModelGuard({ read: async () => settings as never }, async () => ({
    setModel: async (id, model) => { calls.push(`model ${id} ${model}`); runtime = model; },
    setThinking: async (id, level) => { calls.push(`thinking ${id} ${level}`); },
  }), async (change) => { calls.push(`announce ${change.from} -> ${change.to}`); });
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

const tiered = { ...settings, cheapModels: { omp: { model: "omp/deepseek/deepseek-flash", thinkingOptionId: "max" } } };

test("an agent on the cheap tier runs the provider's cheap model; without one, or on the strong tier, the launch model", () => {
  assert.deepEqual(drift(ticketAgent("anthropic/claude-opus-5-5"), tiered, "cheap"), { agentId: "a1", from: "anthropic/claude-opus-5-5 · thinking medium", to: "deepseek/deepseek-flash · thinking max", model: "deepseek/deepseek-flash", thinking: "max", tier: "cheap" });
  assert.equal(drift(ticketAgent("deepseek/deepseek-flash", "max"), tiered, "cheap"), null);
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5"), settings, "cheap"), null, "no cheap model for this provider");
  assert.equal(drift(ticketAgent("deepseek/deepseek-flash", "max"), tiered, "strong")?.model, "anthropic/claude-opus-5-5", "an escalated agent goes back to the launch model");
});

test("a tier decided right after a restore is applied at once, not after the quiet window", async () => {
  const calls: string[] = [];
  let runtime = "deepseek/deepseek-v4-flash";
  let thinking = "medium";
  let tier: "cheap" | "strong" | null = null;
  const guard = new ModelGuard({ read: async () => tiered as never }, async () => ({
    setModel: async (_id, model) => { calls.push(`model ${model}`); runtime = model; },
    setThinking: async (_id, level) => { calls.push(`thinking ${level}`); thinking = level; },
  }), async (change) => { calls.push(`announce ${change.tier ?? "launch"} ${change.to}`); }, async () => tier);
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
