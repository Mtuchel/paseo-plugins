import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { Tier } from "../shared/plan-model";
import type { PluginSettings, Settings } from "./settings";

// Ticket agents run the model of their tier (README, "Model tiers"): the launch model while they
// plan and on the strong tier, the provider's cheap or standard model on those tiers. Plannotator's plan
// mode restores the model it saved when planning began once a plan is approved; an agent that
// started on another model (or was switched during planning) then silently implements on that
// one. Seen on TUC-9: approved at 11:51 UTC, merged a pull request on DeepSeek flash instead of Opus.
export type ModelSetter = {
  setModel: (agentId: string, modelId: string) => Promise<void>;
  setThinking: (agentId: string, thinkingOptionId: string) => Promise<void>;
};
type Snapshot = Pick<PaseoAgent, "id" | "provider" | "model" | "thinkingOptionId" | "effectiveThinkingOptionId" | "runtimeInfo" | "labels" | "archivedAt">;
// `tier`: the tier the agent should run on (null: the launch model, no tier decided).
export type Drift = { agentId: string; from: string; to: string; model: string; thinking: string | null; tier: Tier | null };
// The tier decided for this ticket agent, or null (index.server.ts: the tier store, then the launch label).
export type TierOf = (agent: Snapshot) => Promise<Tier | null>;

const CHECK_MS = 20_000;
const RESTORE_QUIET_MS = 30_000;

// The model (without the provider prefix) and thinking level this ticket agent should run: its
// provider's model for the cheap or standard tier on those tiers, the launch model otherwise. null
// when no launch model is chosen or the agent is not a ticket agent.
export function intendedModel(agent: Snapshot, settings: Pick<PluginSettings, "launchPreferences" | "cheapModels" | "standardModels">, tier: Tier | null = null): { model: string; thinking: string | null } | null {
  if (!agent.labels?.["linear.issueId"] || agent.labels["paseo.parent-agent-id"] || agent.archivedAt) return null;
  const preference = (tier === "cheap" ? settings.cheapModels[agent.provider] : tier === "standard" ? settings.standardModels[agent.provider] : undefined) ?? settings.launchPreferences[agent.provider];
  if (!preference?.model) return null;
  const prefix = `${agent.provider}/`;
  return { model: preference.model.startsWith(prefix) ? preference.model.slice(prefix.length) : preference.model, thinking: preference.thinkingOptionId ?? null };
}

export function drift(agent: Snapshot, settings: Pick<PluginSettings, "launchPreferences" | "cheapModels" | "standardModels">, tier: Tier | null = null): Drift | null {
  const intended = intendedModel(agent, settings, tier);
  const running = agent.runtimeInfo?.model || agent.model;
  if (!intended || !running) return null;
  const thinking = agent.runtimeInfo?.thinkingOptionId || agent.effectiveThinkingOptionId || agent.thinkingOptionId || null;
  const modelOff = running !== intended.model;
  const thinkingOff = Boolean(intended.thinking && thinking && thinking !== intended.thinking);
  if (!modelOff && !thinkingOff) return null;
  const show = (model: string, level: string | null) => (level ? `${model} · thinking ${level}` : model);
  return { agentId: agent.id, from: show(running, thinking), to: show(intended.model, intended.thinking ?? thinking), model: intended.model, thinking: thinkingOff ? intended.thinking : null, tier };
}

export class ModelGuard {
  private paseo: PaseoApi | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly checking = new Set<string>();
  // Snapshots taken before a restore can arrive after it; they must not restore (and announce) again.
  private readonly restoredAt = new Map<string, number>();

  constructor(
    private readonly settings: Pick<Settings, "read">,
    private readonly setter: () => Promise<ModelSetter | null>,
    private readonly announce: (change: Drift) => Promise<void>,
    private readonly tierOf: TierOf = async () => null,
  ) {}

  attach(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    this.timer = setInterval(() => { void this.sweep(); }, CHECK_MS);
    this.timer.unref?.();
    // Immediate reaction when the daemon reports a changed agent; the sweep covers missed updates.
    try {
      this.unsubscribe = paseo.agents.subscribe((update) => { if (update.kind === "upsert") void this.check(update.agent); });
    } catch { this.unsubscribe = null; }
    void this.sweep();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async sweep(): Promise<void> {
    if (!this.paseo) return;
    try {
      const page = await this.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } } as never);
      for (const entry of (page as { entries?: { agent: Snapshot }[] }).entries ?? []) await this.check(entry.agent);
    } catch (error) {
      console.error(`[linear-tickets] model check failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // A tier was just decided for this agent (plan approved, escalation): switch it now instead of at
  // the next sweep, even right after an earlier restore.
  async apply(agentId: string): Promise<Drift | null> {
    if (!this.paseo) return null;
    this.restoredAt.delete(agentId);
    const refreshed = await this.paseo.agents.ref(agentId).refresh().catch(() => null);
    return this.check(refreshed?.agent);
  }

  async check(agent: Snapshot | null | undefined): Promise<Drift | null> {
    if (!agent || this.checking.has(agent.id) || Date.now() - (this.restoredAt.get(agent.id) ?? 0) < RESTORE_QUIET_MS) return null;
    this.checking.add(agent.id);
    try {
      const tier = agent.labels?.["linear.issueId"] ? await this.tierOf(agent) : null;
      const change = drift(agent, await this.settings.read(), tier);
      if (!change) return null;
      const setter = await this.setter();
      if (!setter) { console.error(`[linear-tickets] agent ${agent.id} runs ${change.from} instead of ${change.to}, and the model cannot be changed from here.`); return null; }
      if (change.from.split(" · ")[0] !== change.model) await setter.setModel(agent.id, change.model);
      if (change.thinking) await setter.setThinking(agent.id, change.thinking);
      this.restoredAt.set(agent.id, Date.now());
      console.error(`[linear-tickets] agent ${agent.id}: restored ${change.to} (was ${change.from})`);
      await this.announce(change).catch(() => {});
      return change;
    } catch (error) {
      console.error(`[linear-tickets] restoring the model of ${agent.id} failed: ${error instanceof Error ? error.message : error}`);
      return null;
    } finally {
      this.checking.delete(agent.id);
    }
  }
}
