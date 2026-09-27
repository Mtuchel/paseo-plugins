import type { PaseoAgent, PaseoApi } from "@getpaseo/client";

// The model an agent runs right now, e.g. "anthropic/claude-opus-5-5 · thinking medium". The
// provider's runtime report wins over Paseo's configured model: a plan-mode extension can switch
// the model inside the provider (Plannotator restores its pre-planning model on approval).
export function activeModel(agent: Pick<PaseoAgent, "model" | "thinkingOptionId" | "effectiveThinkingOptionId" | "runtimeInfo"> | null | undefined): string | null {
  if (!agent) return null;
  const model = agent.runtimeInfo?.model || agent.model;
  if (!model) return null;
  const thinking = agent.runtimeInfo?.thinkingOptionId || agent.effectiveThinkingOptionId || agent.thinkingOptionId;
  return thinking ? `${model} · thinking ${thinking}` : model;
}

export async function agentModel(paseo: PaseoApi, agentId: string): Promise<string | null> {
  return activeModel((await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent);
}
