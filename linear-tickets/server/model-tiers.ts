import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ADVISOR_SECTION } from "../shared/plan-advisor";
import { ESCALATE_TOOL, MODEL_SECTION, readTier, strongerTier, TIERS, workerDelegationNote, type Tier } from "../shared/plan-model";
import { RISK_SECTION } from "../shared/plan-risk";
import type { LinearService } from "./linear";
import { RateLimitedError } from "./rate-budget";
import type { PluginSettings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// Model tiers (README, "Model tiers"): a ticket plans on the strong (launch) model and implements on
// the tier its approved plan picks. The ticket labels mirror the tier and can raise it; the agent
// label carries the tier a launch started on; this store keeps each ticket's tier decisions, which
// the model guard enforces and `npm run tier-report` summarises.

export const TIER_LABELS: Record<Tier, string> = { cheap: "model:cheap", strong: "model:strong" };
export const TIER_AGENT_LABEL = "linear.tier";

// `plan`: an approved plan picked it; `start`: an agent started implementing on it; `escalated`:
// the agent asked for the strong model; `route`: the small-ticket route picked it (small-route.ts),
// or set strong again when the owner sent the ticket back to planning.
export type TierSource = "plan" | "start" | "escalated" | "route";
// `strongSteps`: the `Strong steps` line of the plan this decision came from (null: none, or a
// decision that came from no plan text). The tier report counts the tickets it split this way.
export type TierEvent = { tier: Tier; source: TierSource; reason: string; agentId: string | null; model: string | null; strongSteps?: string | null; at: string };
// `agentId`: the agent the latest decision applies to; other agents on the ticket (a new planner)
// run on the launch model until their own plan is approved.
export type TierRecord = { issueId: string; identifier: string; tier: Tier; agentId: string | null; history: TierEvent[]; updatedAt: string };

const MAX_HISTORY = 50;

// The tier a `model:` label name asks for. A name that is no longer a tier (`model:standard`) is
// read as its conservative current one (shared/plan-model.ts `readTier`): an in-flight ticket
// keeps the strong model until its tier is written again, which removes the retired label
// (writeTierLabel). null: not a tier label.
function tierOfLabel(name: string): Tier | null {
  const label = name.trim().toLowerCase();
  return label.startsWith(`${TIER_GROUP}:`) ? readTier(label.slice(TIER_GROUP.length + 1)) : null;
}

// The tier a ticket's labels ask for: the strongest `model:` label; null without one.
export function labelTier(labels: { name: string }[]): Tier | null {
  return labels.map((label) => tierOfLabel(label.name)).reduce<Tier | null>(strongerTier, null);
}

// The Linear label group holding the tier labels (README, "Statuses and labels"): Linear allows one
// label of a group per ticket.
export const TIER_GROUP = "model";
type TierLinear = Pick<LinearService, "labelCatalog" | "createLabel" | "changeLabels">;
// Tier label ids per LinearService, looked up once in the label catalog.
const tierLabelIds = new WeakMap<object, Map<Tier, string>>();

// The ticket's tier label in one write: `tier` added and every other tier label it carries
// (`current`) removed together, so the `model` group accepts the swap and the ticket never shows two
// tiers, with or without the group. Nothing is written when it carries exactly this tier. A missing
// tier label is created inside the group when the group exists. A write refused with a cached id
// (the label was deleted and made again meanwhile) is tried once more with the ids read afresh.
export async function writeTierLabel(linear: TierLinear, issueId: string, tier: Tier, current: { id: string; name: string }[]): Promise<void> {
  const named = (label: { name: string }, wanted: Tier) => label.name.trim().toLowerCase() === TIER_LABELS[wanted];
  // Every other label of the `model` group goes, including one that names a dropped tier
  // (`model:standard`, read as strong, never written again): Linear allows one label of the group
  // per ticket, and a stale one would keep the ticket looking labelled for a tier that no longer
  // exists.
  const others = current.filter((label) => label.name.trim().toLowerCase().startsWith(`${TIER_GROUP}:`) && !named(label, tier));
  const has = current.some((label) => named(label, tier));
  if (has && !others.length) return;
  const write = async () => linear.changeLabels(issueId, has ? [] : [await tierLabelId(linear, tier)], others.map((label) => label.id));
  const cached = !has && tierLabelIds.get(linear)?.has(tier);
  try {
    await write();
  } catch (error) {
    if (!cached || error instanceof RateLimitedError) throw error;
    tierLabelIds.delete(linear);
    await write();
  }
}

async function tierLabelId(linear: TierLinear, tier: Tier): Promise<string> {
  const cached = tierLabelIds.get(linear)?.get(tier);
  if (cached) return cached;
  const catalog = await linear.labelCatalog();
  const ids = new Map<Tier, string>();
  for (const each of TIERS) {
    // A workspace label first: a team label cannot go on another team's ticket.
    const found = catalog.filter((label) => !label.isGroup && label.name.trim().toLowerCase() === TIER_LABELS[each]).sort((a, b) => Number(Boolean(a.teamId)) - Number(Boolean(b.teamId)))[0];
    if (found) ids.set(each, found.id);
  }
  if (!ids.has(tier)) {
    const group = catalog.find((label) => label.isGroup && !label.teamId && label.name.trim().toLowerCase() === TIER_GROUP);
    ids.set(tier, await linear.createLabel({ name: TIER_LABELS[tier], ...group ? { parentId: group.id } : {} }));
  }
  tierLabelIds.set(linear, ids);
  return ids.get(tier)!;
}

// The model and thinking level a launch on `tier` uses. `base` is the launch choice (the strong
// tier); the cheap tier uses the provider's model for that tier, or the launch choice when it has
// none.
export function tierModel(settings: Pick<PluginSettings, "cheapModels">, providerKey: string, tier: Tier | null, base: { provider: string; thinkingOptionId?: string }): { provider: string; thinkingOptionId?: string } {
  const own = tier === "cheap" ? settings.cheapModels[providerKey] : undefined;
  return own ? { provider: own.model, ...(own.thinkingOptionId ? { thinkingOptionId: own.thinkingOptionId } : {}) } : base;
}

// What the implementing agent is told about its tier (the planner learned the rules from the plan
// steps; this reaches a later agent that implements an approved plan). `plan`: the approved plan's
// `## Model` reading when the tier is the plan's own (`starter.ts`), so the note repeats its strong
// steps and its acceptance tests; null when the tier came from a label or an escalation instead.
export function tierNote(tier: Tier, plan: { strongSteps: string | null; acceptanceTests: string[] | null } | null): string {
  if (tier === "strong") return `This ticket implements on the strong model tier (its plan's \`## ${MODEL_SECTION}\` section or the ticket's \`model:strong\` label). ${workerDelegationNote()}`;
  return [
    "This ticket implements on the cheap model tier (its plan's `## Model` section): you run on a fast, inexpensive model, and the approved plan is what settles your steps.",
    plan?.strongSteps ? `Strong steps: ${plan.strongSteps}. Call \`${ESCALATE_TOOL}\` with each step's slice-specific reason and wait for the plugin's confirmed switch to the strong model, then do those steps yourself and keep them; the installed omp \`task\` tool accepts a model override only for \`seance\` historical consults, so hand only the settled implementation to cheap workers.` : "",
    plan?.acceptanceTests?.length ? `Your plan's acceptance tests (${plan.acceptanceTests.join(", ")}) are written first, by the strong model: call \`${ESCALATE_TOOL}\`, wait for the confirmed switch, write them failing yourself from the plan's acceptance criteria, then make the implementation pass them without editing them (the omp extension blocks a cheap agent's edits to those files).` : "",
    workerDelegationNote(),
    `Call \`${ESCALATE_TOOL}\` with the reason when the same check still fails after two honest fix attempts, the work needs judgment the plan did not settle, or a review finds a design problem; the plugin then switches you to the strong model. Wait for the confirmed switch, keep the strong work and the acceptance tests, and hand the settled implementation to cheap workers.`,
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
export async function recordStart(tiers: Pick<TierStore, "record"> | undefined, issue: { id: string; identifier: string }, tier: { tier: Tier; reason: string; strongSteps?: string | null } | null, agentId: string, model: string): Promise<void> {
  if (!tiers || !tier) return;
  await tiers.record(issue, { tier: tier.tier, source: "start", reason: tier.reason, agentId, model, strongSteps: tier.strongSteps ?? null })
    .catch((error: unknown) => console.error(`[linear-tickets] ${issue.identifier}: recording the model tier failed: ${error instanceof Error ? error.message : error}`));
}

// A stored record with every tier name as the current rules read it: a record from before the
// cutover may say `standard` (`LEGACY_TIER_READINGS`), and every reader behind this boundary —
// `launchTier`, the model guard, the tier report's own reader — must see the conservative current
// tier instead, or an in-flight ticket would land on a tier that no longer has a model or a label.
// null: unreadable, or a record whose tier names nothing.
export function readRecord(value: unknown): TierRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as TierRecord;
  const tier = readTier(stored.tier);
  if (!tier) return null;
  const history = (Array.isArray(stored.history) ? stored.history : []).flatMap((event) => {
    const named = readTier(event?.tier);
    return named ? [{ ...event, tier: named }] : [];
  });
  return { ...stored, tier, history };
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
    try { record = readRecord(JSON.parse(await readFile(this.path(issueId), "utf8"))); } catch { record = null; }
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
