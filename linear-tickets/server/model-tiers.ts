import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ADVISOR_SECTION } from "../shared/plan-advisor";
import { ESCALATE_TOOL, MODEL_SECTION, strongerTier, TIERS, workerDelegationNote, type Tier } from "../shared/plan-model";
import { RISK_SECTION } from "../shared/plan-risk";
import type { PluginSettings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// Model tiers (README, "Model tiers"): a ticket plans on the strong (launch) model and implements on
// the tier its approved plan picks. The ticket labels mirror the tier and can raise it; the agent
// label carries the tier a launch started on; this store keeps each ticket's tier decisions, which
// the model guard enforces and `npm run tier-report` summarises.

export const TIER_LABELS: Record<Tier, string> = { cheap: "model:cheap", standard: "model:standard", strong: "model:strong" };
export const TIER_AGENT_LABEL = "linear.tier";

// `plan`: an approved plan picked it; `start`: an agent started implementing on it; `escalated`:
// the agent asked for the strong model.
export type TierSource = "plan" | "start" | "escalated";
export type TierEvent = { tier: Tier; source: TierSource; reason: string; agentId: string | null; model: string | null; at: string };
// `agentId`: the agent the latest decision applies to; other agents on the ticket (a new planner)
// run on the launch model until their own plan is approved.
export type TierRecord = { issueId: string; identifier: string; tier: Tier; agentId: string | null; history: TierEvent[]; updatedAt: string };

const MAX_HISTORY = 50;

// The tier a ticket's labels ask for: the strongest `model:` label; null without one.
export function labelTier(labels: { name: string }[]): Tier | null {
  const names = new Set(labels.map((label) => label.name.trim().toLowerCase()));
  return TIERS.filter((tier) => names.has(TIER_LABELS[tier])).reduce<Tier | null>(strongerTier, null);
}

// The model and thinking level a launch on `tier` uses. `base` is the launch choice (the strong
// tier); the cheap and standard tiers use the provider's model for that tier, or the launch
// choice when it has none.
export function tierModel(settings: Pick<PluginSettings, "cheapModels" | "standardModels">, providerKey: string, tier: Tier | null, base: { provider: string; thinkingOptionId?: string }): { provider: string; thinkingOptionId?: string } {
  const own = tier === "cheap" ? settings.cheapModels[providerKey] : tier === "standard" ? settings.standardModels[providerKey] : undefined;
  return own ? { provider: own.model, ...(own.thinkingOptionId ? { thinkingOptionId: own.thinkingOptionId } : {}) } : base;
}

// What the implementing agent is told about its tier (the planner learned the rules from the plan
// steps; this reaches a later agent that implements an approved plan).
export function tierNote(tier: Tier, strongSteps: string | null): string {
  if (tier === "strong") return `This ticket implements on the strong model tier (its plan's \`## Model\` section or the ticket's \`model:strong\` label). ${workerDelegationNote()}`;
  return [
    tier === "cheap"
      ? "This ticket implements on the cheap model tier (its plan's `## Model` section): you run on a fast, inexpensive model."
      : "This ticket implements on the standard model tier (its plan's `## Model` section): you run on a capable mid-priced model, not the strong one.",
    strongSteps ? `Strong steps: ${strongSteps}. Hand each of them to a subagent on the strong model (in omp: the task tool with \`model: "@slow"\`).` : "",
    workerDelegationNote(),
    `Call \`${ESCALATE_TOOL}\` with the reason when the same check still fails after two honest fix attempts, the work needs judgment the plan did not settle, or a review finds a design problem; the plugin then switches you to the strong model.`,
  ].filter(Boolean).join(" ");
}

// The tier a ticket's record decided: its latest approved plan or escalation. A `start` only
// repeats the decision its launch made, so it decides nothing on its own.
export function decidedTier(record: TierRecord | null): Tier | null {
  return record?.history.findLast((event) => event.source !== "start")?.tier ?? null;
}

// The tier an implementing launch runs on: the strongest of the ticket's label, its recorded
// decision (an escalation stays) and its approved plan. null when none of them names one: the
// approved plan then goes back to planning to add its `## Model` section (starter.ts).
export function launchTier(labels: { name: string }[], record: TierRecord | null, plan: Tier | null): Tier | null {
  return strongerTier(strongerTier(labelTier(labels), decidedTier(record)), plan);
}

// Sections a plan sent back only for its missing tier may add or change without a new review:
// the tier itself, the risk rating it is checked against, and the advisor review of that round.
const TIER_ONLY_SECTIONS = [MODEL_SECTION, RISK_SECTION, ADVISOR_SECTION];

// The plan's words, without the sections above: what the owner approved.
function approvedWords(plan: string): string {
  const body = TIER_ONLY_SECTIONS.reduce((text, name) => text.replace(new RegExp(`^#{1,6}\\s+${name}\\b[^\\n]*\\n[\\s\\S]*?(?=^#{1,2}\\s|(?![\\s\\S]))`, "gim"), ""), plan);
  return (body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

// Whether `plan` is the plan in the ticket's approved plan document (server/plannotator.ts
// planDocument) with only its tier added: then the owner's approval still holds. Compares words,
// so Linear's markdown formatting does not matter; any changed word does.
export function onlyTierAdded(approvedDocument: string, plan: string): boolean {
  if (!/^>\s*\*\*Approved\*\*/.test(approvedDocument.trim())) return false;
  const rule = /^\s*(?:-{3,}|\*{3,}|_{3,}|(?:\*\s*){3,})\s*$/m.exec(approvedDocument);
  if (!rule) return false;
  const approved = approvedWords(approvedDocument.slice(rule.index + rule[0].length));
  return approved.length > 0 && approved === approvedWords(plan);
}

// Records that an agent started implementing on its tier (the launch label carries it until then).
// Best-effort: a failed record never fails or repeats the launch.
export async function recordStart(tiers: Pick<TierStore, "record"> | undefined, issue: { id: string; identifier: string }, tier: { tier: Tier; reason: string } | null, agentId: string, model: string): Promise<void> {
  if (!tiers || !tier) return;
  await tiers.record(issue, { tier: tier.tier, source: "start", reason: tier.reason, agentId, model })
    .catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: recording the model tier failed: ${error instanceof Error ? error.message : error}`));
}

export class TierStore {
  private readonly cache = new Map<string, TierRecord | null>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory = join(paseoHome(), "linear-tickets", "model-tiers"), private readonly now = () => new Date().toISOString()) {}

  private path(issueId: string): string {
    return join(this.directory, `${issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
  }

  async get(issueId: string): Promise<TierRecord | null> {
    if (this.cache.has(issueId)) return this.cache.get(issueId) ?? null;
    let record: TierRecord | null = null;
    try { record = JSON.parse(await readFile(this.path(issueId), "utf8")) as TierRecord; } catch { record = null; }
    this.cache.set(issueId, record);
    return record;
  }

  // The tier the latest decision gives this agent, or null when it applies to another agent.
  async forAgent(issueId: string, agentId: string): Promise<Tier | null> {
    const record = await this.get(issueId);
    return record?.agentId === agentId ? record.tier : null;
  }

  // Records a tier decision; the latest one decides for its agent, every one stays in the history.
  record(issue: { id: string; identifier: string }, event: Omit<TierEvent, "at">): Promise<TierRecord> {
    const work = async () => {
      const previous = await this.get(issue.id);
      const at = this.now();
      const next: TierRecord = { issueId: issue.id, identifier: issue.identifier, tier: event.tier, agentId: event.agentId, history: [...(previous?.history ?? []), { ...event, at }].slice(-MAX_HISTORY), updatedAt: at };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.path(issue.id);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      this.cache.set(issue.id, next);
      return next;
    };
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
