import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { drift, ModelGuard } from "./model-guard";

const settings = { launchPreferences: { omp: { model: "omp/anthropic/claude-opus-5-5", modeId: "full", thinkingOptionId: "medium" } } };
const ticketAgent = (runtime: string, thinking = "medium", labels: Record<string, string> = { "linear.issueId": "i1" }) =>
  ({ id: "a1", provider: "omp", model: "anthropic/claude-opus-5-5", thinkingOptionId: "medium", runtimeInfo: { provider: "omp", sessionId: "s", model: runtime, thinkingOptionId: thinking }, labels, archivedAt: null }) as never;

test("a ticket agent drifting from the launch model is detected; others are left alone", () => {
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5"), settings), null);
  assert.deepEqual(drift(ticketAgent("deepseek/deepseek-v4-flash"), settings), { agentId: "a1", from: "deepseek/deepseek-v4-flash · thinking medium", to: "anthropic/claude-opus-5-5 · thinking medium", model: "anthropic/claude-opus-5-5", thinking: null });
  assert.equal(drift(ticketAgent("anthropic/claude-opus-5-5", "high"), settings)?.thinking, "medium");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash", "medium", {}), settings), null, "not a ticket agent");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash", "medium", { "linear.issueId": "i1", "paseo.parent-agent-id": "p" }), settings), null, "subagents follow their parent");
  assert.equal(drift(ticketAgent("deepseek/deepseek-v4-flash"), { launchPreferences: {} }), null, "no launch model chosen");
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
  assert.deepEqual(calls, [
    "model a1 anthropic/claude-opus-5-5",
    "announce deepseek/deepseek-v4-flash · thinking medium -> anthropic/claude-opus-5-5 · thinking medium",
  ]);
});
