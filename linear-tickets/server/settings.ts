import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_PROJECT_MAPPINGS, type ProjectMapping } from "../shared/mapping";
import { type AutoApprovePolicy, DEFAULT_AUTO_APPROVE, MAX_IMPACT } from "../shared/plan-risk";
import { writeActivationSecret } from "./activation";

export const MAX_TEMPLATE_LENGTH = 8_000;

export type LaunchPreference = { model: string; modeId?: string; thinkingOptionId?: string };
// A lower model tier's model per provider (README, "Model tiers"); a provider without one
// implements plans of that tier on its launch model.
export type TierModel = { model: string; thinkingOptionId?: string };
export const DEFAULT_CHEAP_MODELS: Record<string, TierModel> = { omp: { model: "omp/deepseek/deepseek-flash", thinkingOptionId: "max" } };
// GPT-6.1 Sol runs on the OpenAI account, apart from the launch model's Claude account.
export const DEFAULT_STANDARD_MODELS: Record<string, TierModel> = { omp: { model: "omp/openai-codex/gpt-6.1-sol", thinkingOptionId: "high" } };
// Auto-dispatch starts an agent for every open ticket carrying `label` in one of `teamKeys`,
// whoever it is assigned to. No teams means nothing is dispatched, even when enabled.
// `maxRunning`: at most this many ticket agents work at once (0 = no limit); others wait their turn.
export type DispatchSettings = { enabled: boolean; label: string; teamKeys: string[]; intervalSeconds: number; maxRunning: number };
// Which lifecycle events of ticket-linked agents are written back to their Linear ticket.
// `mentions` is the inbound direction: "@paseo" comments and replies to Paseo's comments by the key's user reach the agent.
// `watchdog` (README, "Silent and stuck agents") has its own switch; `autoResume` keeps controlling the existing successors.
export type WritebackSettings = { status: boolean; summaries: boolean; blocked: boolean; pullRequests: boolean; mentions: boolean; autoResume: boolean; watchdog: boolean };
export const DEFAULT_DISPATCH: DispatchSettings = { enabled: false, label: "paseo", teamKeys: [], intervalSeconds: 60, maxRunning: 0 };
export const MAX_RUNNING_LIMIT = 50;
export const DEFAULT_WRITEBACK: WritebackSettings = { status: false, summaries: false, blocked: false, pullRequests: false, mentions: false, autoResume: false, watchdog: true };
// The watchdog's silence thresholds (README, "Silent and stuck agents"), in minutes.
export type WatchdogTimings = { silentMinutes: number; steerGraceMinutes: number; recoveryGraceMinutes: number; idleMinutes: number };
export const DEFAULT_WATCHDOG: WatchdogTimings = { silentMinutes: 45, steerGraceMinutes: 20, recoveryGraceMinutes: 20, idleMinutes: 120 };
export const MIN_WATCHDOG_MINUTES = 1;
export const MAX_WATCHDOG_MINUTES = 1440;
// Draining a host (README, "Draining a host"): which host starts the agents Linear asks for.
// `local` (the default) starts them here. `remote` starts none here: every new automatic
// activation for a ticket without an allowed local owner is forwarded to `peer`, the other host's
// tailnet origin (https://<host>.<tailnet>.ts.net:8444). A host that is not draining still needs
// `peer` to hand a ticket's messages to the agent that the draining host registered as its owner.
// The shared secret is not part of this: it lives in the host-local `activation-secret` file.
export type ActivationSettings = { mode: "local" | "remote"; peer: string | null };
export const DEFAULT_ACTIVATION: ActivationSettings = { mode: "local", peer: null };
// The queue backstop (README, "Queue backstop"): its repo-wide half (the repo's
// `enqueue-ready.mjs` listing, the enqueues it starts, and the stranded-stack moves) may drive one
// repo from one host only, so `run` says which one: `auto` (the default) is the host with
// auto-dispatch enabled, which already drives the repo's ticket work, and `always`/`never` pin it.
// Every host still follows up the enqueues it claimed for its own tickets.
export type BackstopSettings = { run: "auto" | "always" | "never" };
export const DEFAULT_BACKSTOP: BackstopSettings = { run: "auto" };
const BACKSTOP_RUN = ["auto", "always", "never"] as const;
export const MIN_DISPATCH_INTERVAL_SECONDS = 30;
export const MAX_DISPATCH_INTERVAL_SECONDS = 3_600;
export const MAX_DISPATCH_TEAMS = 20;
// The deputy for agent questions (README, "Deputy for agent questions"): `off` (the default) does
// nothing, `shadow` records what it would answer without answering, `live` may answer once the
// shadow evidence and the plugin's checked owner-priority reply path allow it. `model`: the evaluator's
// OMP model (none: every question stays with the owner); `principlesRepository`: the local
// tuchel-platform checkout whose `origin/main` holds `docs/principles/`.
export type DeputyMode = "off" | "shadow" | "live";
export type DeputySettings = { mode: DeputyMode; graceMinutes: number; model: string | null; principlesRepository: string | null };
export const DEFAULT_DEPUTY: DeputySettings = { mode: "off", graceMinutes: 5, model: null, principlesRepository: null };
export const MIN_DEPUTY_GRACE_MINUTES = 1;
export const MAX_DEPUTY_GRACE_MINUTES = 120;
const DEPUTY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
// Worktree shards (README, "Worktree shards"): one repository's ticket worktrees split across
// independent clones, so a filesystem event in one clone's git directory costs work for fewer
// worktrees. `pools` maps the root path of the Paseo project a Linear project is mapped to, as
// this host sees it (the original), to its clones' root paths. Off on every host until its own
// settings file turns it on.
export type WorktreeShardSettings = { enabled: boolean; pools: Record<string, string[]> };
export const DEFAULT_WORKTREE_SHARDS: WorktreeShardSettings = { enabled: false, pools: {} };
export const MAX_SHARD_POOLS = 10;
export const MAX_SHARD_ROOTS = 12;
export type PluginSettings = {
  template: string | null;
  markInProgress: boolean;
  showClosed: boolean;
  lastProvider: string | null;
  launchPreferences: Record<string, LaunchPreference>;
  projectMappings: Record<string, ProjectMapping>;
  agentLinearAccess: boolean;
  dispatch: DispatchSettings;
  writeback: WritebackSettings;
  // The watchdog's timing thresholds (README, "Silent and stuck agents").
  watchdog: WatchdogTimings;
  // Plans rated at or below the threshold are approved without the owner (README, "Plan risk and auto-approval").
  autoApprove: AutoApprovePolicy;
  // The cheap and standard tiers' models per provider; `{}` turns that tier's own model off.
  cheapModels: Record<string, TierModel>;
  standardModels: Record<string, TierModel>;
  // Other hosts' review inboxes (https://<host>.<tailnet>.ts.net:8444) this host's inbox also lists.
  reviewPeers: string[];
  // Activation routing (README, "Draining a host"); the secret is a separate host-local file.
  activation: ActivationSettings;
  // Which host runs the repo-wide half of the queue backstop (README, "Queue backstop").
  backstop: BackstopSettings;
  deputy: DeputySettings;
  // Splitting ticket worktrees across clones (README, "Worktree shards").
  worktreeShards: WorktreeShardSettings;
};

type SettingsFile = {
  template?: string;
  markInProgress?: boolean;
  showClosed?: boolean;
  lastProvider?: string;
  launchPreferences?: Record<string, LaunchPreference>;
  projectMappings?: Record<string, ProjectMapping>;
  agentLinearAccess?: boolean;
  dispatch?: Partial<DispatchSettings>;
  writeback?: Partial<WritebackSettings>;
  watchdog?: Partial<WatchdogTimings>;
  autoApprove?: Partial<AutoApprovePolicy>;
  cheapModels?: Record<string, TierModel>;
  standardModels?: Record<string, TierModel>;
  reviewPeers?: string[];
  activation?: { mode?: unknown; peer?: unknown };
  backstop?: { run?: unknown };
  deputy?: Partial<DeputySettings>;
  worktreeShards?: { enabled?: unknown; pools?: unknown };
};

function savedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 500 ? value : undefined;
}

function normalizeLaunchPreferences(value: unknown): Record<string, LaunchPreference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 50).flatMap(([provider, raw]) => {
    if (!savedString(provider) || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const candidate = raw as Record<string, unknown>;
    const model = savedString(candidate.model);
    if (!model) return [];
    const modeId = savedString(candidate.modeId);
    const thinkingOptionId = savedString(candidate.thinkingOptionId);
    return [[provider, { model, ...(modeId ? { modeId } : {}), ...(thinkingOptionId ? { thinkingOptionId } : {}) }]];
  }));
}

// A missing setting means the defaults; a saved one (even `{}`) replaces them.
function normalizeTierModels(value: unknown, defaults: Record<string, TierModel>): Record<string, TierModel> {
  if (value === undefined) return defaults;
  return Object.fromEntries(Object.entries(normalizeLaunchPreferences(value)).map(([provider, { model, thinkingOptionId }]) => [provider, { model, ...(thinkingOptionId ? { thinkingOptionId } : {}) }]));
}

export const MAX_REVIEW_PEERS = 10;
// Origins of other hosts' review inboxes; anything that is not an http(s) origin is dropped.
export function normalizeReviewPeers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const origins = value.flatMap((raw) => {
    if (typeof raw !== "string") return [];
    try {
      const url = new URL(raw.trim());
      return url.protocol === "https:" || url.protocol === "http:" ? [url.origin] : [];
    } catch { return []; }
  });
  return [...new Set(origins)].slice(0, MAX_REVIEW_PEERS);
}

const MAPPING_KEY = /^(project|team):[A-Za-z0-9_-]{1,100}$/;
export function normalizeProjectMappings(value: unknown): Record<string, ProjectMapping> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, MAX_PROJECT_MAPPINGS).flatMap(([key, raw]) => {
    if (!MAPPING_KEY.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const candidate = raw as Record<string, unknown>;
    const projectId = savedString(candidate.projectId);
    if (!projectId) return [];
    const baseBranch = savedString(candidate.baseBranch);
    const label = savedString(candidate.label) ?? key;
    return [[key, { projectId, label, ...(baseBranch ? { baseBranch } : {}) }]];
  }));
}

const TEAM_KEY = /^[A-Za-z0-9]{1,10}$/;
// One Linear label name: no commas (the settings field is comma-separated), no edge spaces.
const DISPATCH_LABEL = /^[^\s,]([^,]{0,78}[^\s,])?$/;

export function normalizeDispatch(value: unknown): DispatchSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_DISPATCH };
  const candidate = value as Record<string, unknown>;
  const label = typeof candidate.label === "string" && DISPATCH_LABEL.test(candidate.label.trim()) ? candidate.label.trim() : DEFAULT_DISPATCH.label;
  const teamKeys = Array.isArray(candidate.teamKeys)
    ? [...new Set(candidate.teamKeys.filter((key): key is string => typeof key === "string" && TEAM_KEY.test(key.trim())).map((key) => key.trim().toUpperCase()))].slice(0, MAX_DISPATCH_TEAMS)
    : [];
  const interval = typeof candidate.intervalSeconds === "number" && Number.isFinite(candidate.intervalSeconds) ? Math.round(candidate.intervalSeconds) : DEFAULT_DISPATCH.intervalSeconds;
  return {
    enabled: candidate.enabled === true,
    label,
    teamKeys,
    intervalSeconds: Math.min(MAX_DISPATCH_INTERVAL_SECONDS, Math.max(MIN_DISPATCH_INTERVAL_SECONDS, interval)),
    maxRunning: typeof candidate.maxRunning === "number" && Number.isInteger(candidate.maxRunning) ? Math.min(MAX_RUNNING_LIMIT, Math.max(0, candidate.maxRunning)) : 0,
  };
}

// A user edit is rejected rather than silently repaired, so the settings form can say why.
function validDispatch(value: DispatchSettings): DispatchSettings {
  if (!DISPATCH_LABEL.test(value.label.trim())) throw new Error("The trigger label must be one Linear label name without commas.");
  if (value.teamKeys.length > MAX_DISPATCH_TEAMS) throw new Error(`At most ${MAX_DISPATCH_TEAMS} teams can be dispatched from.`);
  const badKey = value.teamKeys.find((key) => !TEAM_KEY.test(key.trim()));
  if (badKey !== undefined) throw new Error(`"${badKey}" is not a Linear team key (for example ENG).`);
  if (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < MIN_DISPATCH_INTERVAL_SECONDS || value.intervalSeconds > MAX_DISPATCH_INTERVAL_SECONDS) {
    throw new Error(`The poll interval must be a whole number of seconds between ${MIN_DISPATCH_INTERVAL_SECONDS} and ${MAX_DISPATCH_INTERVAL_SECONDS}.`);
  }
  if (!Number.isInteger(value.maxRunning) || value.maxRunning < 0 || value.maxRunning > MAX_RUNNING_LIMIT) {
    throw new Error(`The agent limit must be a whole number from 0 (no limit) to ${MAX_RUNNING_LIMIT}.`);
  }
  return normalizeDispatch(value);
}

export function normalizeWriteback(value: unknown): WritebackSettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    status: candidate.status === true,
    summaries: candidate.summaries === true,
    blocked: candidate.blocked === true,
    pullRequests: candidate.pullRequests === true,
    mentions: candidate.mentions === true,
    autoResume: candidate.autoResume === true,
    // Omitted or malformed means on; only an explicit false turns the watchdog off.
    watchdog: candidate.watchdog !== false,
  };
}

// Malformed stored values fall back to that field's default rather than breaking the settings read.
export function normalizeWatchdog(value: unknown): WatchdogTimings {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const [silentMinutes, steerGraceMinutes, recoveryGraceMinutes, idleMinutes] = (["silentMinutes", "steerGraceMinutes", "recoveryGraceMinutes", "idleMinutes"] as const).map((key) => {
    const raw = candidate[key];
    return typeof raw === "number" && Number.isInteger(raw) && raw >= MIN_WATCHDOG_MINUTES && raw <= MAX_WATCHDOG_MINUTES ? raw : DEFAULT_WATCHDOG[key];
  });
  return { silentMinutes, steerGraceMinutes, recoveryGraceMinutes, idleMinutes };
}

// A user edit is rejected rather than silently repaired, so the settings form can say why.
function validWatchdog(value: WatchdogTimings): WatchdogTimings {
  if (!Number.isInteger(value.silentMinutes) || value.silentMinutes < MIN_WATCHDOG_MINUTES || value.silentMinutes > MAX_WATCHDOG_MINUTES) {
    throw new Error(`The silence threshold must be a whole number of minutes from ${MIN_WATCHDOG_MINUTES} to ${MAX_WATCHDOG_MINUTES}.`);
  }
  if (!Number.isInteger(value.steerGraceMinutes) || value.steerGraceMinutes < MIN_WATCHDOG_MINUTES || value.steerGraceMinutes > MAX_WATCHDOG_MINUTES) {
    throw new Error(`The steer grace period must be a whole number of minutes from ${MIN_WATCHDOG_MINUTES} to ${MAX_WATCHDOG_MINUTES}.`);
  }
  if (!Number.isInteger(value.recoveryGraceMinutes) || value.recoveryGraceMinutes < MIN_WATCHDOG_MINUTES || value.recoveryGraceMinutes > MAX_WATCHDOG_MINUTES) {
    throw new Error(`The recovery grace period must be a whole number of minutes from ${MIN_WATCHDOG_MINUTES} to ${MAX_WATCHDOG_MINUTES}.`);
  }
  if (!Number.isInteger(value.idleMinutes) || value.idleMinutes < MIN_WATCHDOG_MINUTES || value.idleMinutes > MAX_WATCHDOG_MINUTES) {
    throw new Error(`The idle threshold must be a whole number of minutes from ${MIN_WATCHDOG_MINUTES} to ${MAX_WATCHDOG_MINUTES}.`);
  }
  return normalizeWatchdog(value);
}

// Anything that is not a usable http(s) origin is dropped, so a half-typed address cannot make
// the host forward nowhere instead of nowhere-yet.
export function normalizeActivation(value: unknown): ActivationSettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { mode: candidate.mode === "remote" ? "remote" : "local", peer: normalizeOrigin(candidate.peer) };
}

function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch { return null; }
}

// A user edit is rejected rather than silently repaired, so the settings form can say why.
function validActivation(value: ActivationSettings): ActivationSettings {
  if (value.peer !== null && !normalizeOrigin(value.peer)) throw new Error("The peer host must be an http(s) origin, for example https://server087.tail5efd6b.ts.net:8444.");
  if (value.mode === "remote" && !normalizeOrigin(value.peer)) throw new Error("Routing new activations to the peer needs the peer host's origin, for example https://server087.tail5efd6b.ts.net:8444.");
  return normalizeActivation(value);
}

// Malformed stored values fall back to that field's default rather than breaking the settings read.
export function normalizeBackstop(value: unknown): BackstopSettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const run = BACKSTOP_RUN.find((mode) => mode === candidate.run);
  return { run: run ?? DEFAULT_BACKSTOP.run };
}

// A user edit is rejected rather than silently repaired, so the settings form can say why.
function validBackstop(value: { run?: unknown }): BackstopSettings {
  const run = BACKSTOP_RUN.find((mode) => mode === value.run);
  if (!run) throw new Error(`The queue backstop can run "auto", "always" or "never", not ${JSON.stringify(value.run)}.`);
  return { run };
}

export function normalizeAutoApprove(value: unknown): AutoApprovePolicy {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const [maxImpact, maxImpactWithFlag] = (["maxImpact", "maxImpactWithFlag"] as const).map((key) => {
    const raw = candidate[key];
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_IMPACT ? raw : DEFAULT_AUTO_APPROVE[key];
  });
  return { enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_AUTO_APPROVE.enabled, maxImpact, maxImpactWithFlag };
}

export function normalizeDeputy(value: unknown): DeputySettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const grace = candidate.graceMinutes;
  const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
  const repository = typeof candidate.principlesRepository === "string" ? candidate.principlesRepository.trim() : "";
  return {
    mode: candidate.mode === "shadow" || candidate.mode === "live" ? candidate.mode : "off",
    graceMinutes: typeof grace === "number" && Number.isInteger(grace) && grace >= MIN_DEPUTY_GRACE_MINUTES && grace <= MAX_DEPUTY_GRACE_MINUTES ? grace : DEFAULT_DEPUTY.graceMinutes,
    model: DEPUTY_MODEL.test(model) ? model : null,
    principlesRepository: repository.startsWith("/") && repository.length <= 500 ? repository : null,
  };
}

// A user edit is rejected rather than silently repaired, so the settings form can say why.
function validDeputy(value: { mode?: unknown; graceMinutes?: unknown; model?: unknown; principlesRepository?: unknown }): DeputySettings {
  if (!["off", "shadow", "live"].includes(String(value.mode))) throw new Error("The deputy mode must be off, shadow or live.");
  const grace = value.graceMinutes;
  if (typeof grace !== "number" || !Number.isInteger(grace) || grace < MIN_DEPUTY_GRACE_MINUTES || grace > MAX_DEPUTY_GRACE_MINUTES) {
    throw new Error(`The deputy's grace period must be a whole number of minutes from ${MIN_DEPUTY_GRACE_MINUTES} to ${MAX_DEPUTY_GRACE_MINUTES}.`);
  }
  if (value.model !== null && (typeof value.model !== "string" || !DEPUTY_MODEL.test(value.model.trim()))) throw new Error("The deputy's evaluator model must be an OMP model id such as openai-codex/gpt-6.1-sol, or null.");
  if (value.principlesRepository !== null && (typeof value.principlesRepository !== "string" || !value.principlesRepository.trim().startsWith("/"))) throw new Error("The principles repository must be an absolute path to a tuchel-platform checkout, or null.");
  return normalizeDeputy(value);
}

// An absolute directory path, without its trailing slashes (worktree shards key and list roots).
function shardPath(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text.startsWith("/") || text.length > 500) return null;
  return text.replace(/\/+$/, "") || "/";
}

// Malformed stored values fall back to that field's default rather than breaking the settings read:
// a pool without a usable root, or a clone that is the original's own path, is dropped.
export function normalizeWorktreeShards(value: unknown): WorktreeShardSettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const pools: Record<string, string[]> = {};
  const raw = candidate.pools;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, list] of Object.entries(raw).slice(0, MAX_SHARD_POOLS)) {
      const mappedRoot = shardPath(key);
      if (!mappedRoot || !Array.isArray(list)) continue;
      const roots = [...new Set(list.flatMap((item) => shardPath(item) ?? []))].filter((root) => root !== mappedRoot).slice(0, MAX_SHARD_ROOTS);
      if (roots.length) pools[mappedRoot] = roots;
    }
  }
  return { enabled: candidate.enabled === true, pools };
}

// A user edit is rejected rather than silently repaired, so the settings form can say why.
export function validWorktreeShards(value: { enabled?: unknown; pools?: unknown }): WorktreeShardSettings {
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("The worktree shards switch must be true or false.");
  const raw = value.pools;
  if (raw !== undefined) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Worktree shards take a pools object: the mapped project's root path to the clones' root paths.");
    const entries = Object.entries(raw);
    if (entries.length > MAX_SHARD_POOLS) throw new Error(`At most ${MAX_SHARD_POOLS} repositories can have their ticket worktrees sharded.`);
    for (const [key, list] of entries) {
      if (!shardPath(key)) throw new Error(`"${key}" is not an absolute project root path.`);
      if (!Array.isArray(list) || !list.length || !list.every((item) => shardPath(item))) throw new Error(`The shard list of ${key} must be absolute root paths of its clones.`);
      if (list.length > MAX_SHARD_ROOTS) throw new Error(`At most ${MAX_SHARD_ROOTS} clones can share one repository's ticket worktrees.`);
    }
  }
  return normalizeWorktreeShards(value);
}

export type SettingsPatch = {
  template?: string;
  markInProgress?: boolean;
  showClosed?: boolean;
  agentLinearAccess?: boolean;
  launchPreference?: { provider: string } & LaunchPreference;
  projectMapping?: { key: string } & ProjectMapping;
  forgetProjectMapping?: string;
  dispatch?: Partial<DispatchSettings>;
  writeback?: Partial<WritebackSettings>;
  watchdog?: Partial<WatchdogTimings>;
  autoApprove?: Partial<AutoApprovePolicy>;
  // Sets one provider's model for the cheap or standard tier; `model: null` removes it (that
  // tier then implements on the provider's launch model).
  tierModel?: { tier: "cheap" | "standard"; provider: string; model: string | null; thinkingOptionId?: string };
  // Activation routing; `secret` is write-only (the host-local file) and `null`/`""` removes it.
  activation?: { mode?: "local" | "remote"; peer?: string | null; secret?: string | null };
  // Queue backstop: which host runs its repo-wide half (README, "Queue backstop").
  backstop?: { run?: "auto" | "always" | "never" };
  deputy?: Partial<DeputySettings>;
  // Worktree shards: `pools` replaces the whole map when given (README, "Worktree shards").
  worktreeShards?: { enabled?: boolean; pools?: Record<string, string[]> };
};

// Returns null for an empty template (meaning: use the built-in default).
export function normalizeTemplate(raw: string): string | null {
  const template = raw.trim();
  if (!template) return null;
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`The default prompt template is limited to ${MAX_TEMPLATE_LENGTH.toLocaleString("en-US")} characters.`);
  }
  if (!template.includes("{{context}}")) {
    throw new Error("The default prompt template must include {{context}} — that is where the ticket snapshot goes.");
  }
  return template;
}

export class Settings {
  // Every read-modify-write runs in order, so concurrent patches cannot drop each other.
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  constructor(
    private readonly path = join(process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo"), "linear-tickets", "settings.json"),
  ) {}

  private async readFile(): Promise<SettingsFile> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return value && typeof value === "object" ? (value as SettingsFile) : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Could not read the saved plugin settings.");
    }
  }

  async read(): Promise<PluginSettings> {
    const value = await this.readFile();
    const launchPreferences = normalizeLaunchPreferences(value.launchPreferences);
    const lastProvider = savedString(value.lastProvider);
    return {
      template: typeof value.template === "string" && value.template.trim() ? value.template : null,
      markInProgress: value.markInProgress === true,
      showClosed: value.showClosed === true,
      lastProvider: lastProvider && launchPreferences[lastProvider] ? lastProvider : null,
      launchPreferences,
      projectMappings: normalizeProjectMappings(value.projectMappings),
      agentLinearAccess: value.agentLinearAccess !== false,
      dispatch: normalizeDispatch(value.dispatch),
      writeback: normalizeWriteback(value.writeback),
      watchdog: normalizeWatchdog(value.watchdog),
      autoApprove: normalizeAutoApprove(value.autoApprove),
      cheapModels: normalizeTierModels(value.cheapModels, DEFAULT_CHEAP_MODELS),
      standardModels: normalizeTierModels(value.standardModels, DEFAULT_STANDARD_MODELS),
      reviewPeers: normalizeReviewPeers(value.reviewPeers),
      activation: normalizeActivation(value.activation),
      backstop: normalizeBackstop(value.backstop),
      deputy: normalizeDeputy(value.deputy),
      worktreeShards: normalizeWorktreeShards(value.worktreeShards),
    };
  }

  save(raw: string): Promise<PluginSettings> {
    return this.serialize(() => this.saveNow(raw));
  }

  private async saveNow(raw: string): Promise<PluginSettings> {
    const current = await this.read();
    return this.write({ ...current, template: normalizeTemplate(raw) });
  }

  // Patches only the provided fields; `template: ""` clears the template (built-in default).
  patch(patch: SettingsPatch): Promise<PluginSettings> {
    return this.serialize(() => this.patchNow(patch));
  }

  private async patchNow(patch: SettingsPatch): Promise<PluginSettings> {
    const current = await this.read();
    const next: PluginSettings = {
      ...current,
      template: patch.template === undefined ? current.template : normalizeTemplate(patch.template),
      markInProgress: patch.markInProgress ?? current.markInProgress,
      showClosed: patch.showClosed ?? current.showClosed,
      agentLinearAccess: patch.agentLinearAccess ?? current.agentLinearAccess,
      dispatch: patch.dispatch ? validDispatch({ ...current.dispatch, ...patch.dispatch }) : current.dispatch,
      writeback: patch.writeback ? normalizeWriteback({ ...current.writeback, ...patch.writeback }) : current.writeback,
      watchdog: patch.watchdog ? validWatchdog({ ...current.watchdog, ...patch.watchdog }) : current.watchdog,
      autoApprove: patch.autoApprove ? normalizeAutoApprove({ ...current.autoApprove, ...patch.autoApprove }) : current.autoApprove,
      deputy: patch.deputy ? validDeputy({ ...current.deputy, ...patch.deputy }) : current.deputy,
      backstop: patch.backstop ? validBackstop({ run: patch.backstop.run ?? current.backstop.run }) : current.backstop,
      worktreeShards: patch.worktreeShards
        ? validWorktreeShards({ enabled: patch.worktreeShards.enabled ?? current.worktreeShards.enabled, pools: patch.worktreeShards.pools ?? current.worktreeShards.pools })
        : current.worktreeShards,
    };
    if (patch.launchPreference) {
      const { provider, model, modeId, thinkingOptionId } = patch.launchPreference;
      next.lastProvider = provider;
      next.launchPreferences = { ...current.launchPreferences, [provider]: { model, ...(modeId ? { modeId } : {}), ...(thinkingOptionId ? { thinkingOptionId } : {}) } };
    }
    if (patch.tierModel) {
      const { tier, provider, model, thinkingOptionId } = patch.tierModel;
      const key = tier === "cheap" ? "cheapModels" : "standardModels";
      const models = { ...current[key] };
      if (model) models[provider] = { model, ...(thinkingOptionId ? { thinkingOptionId } : {}) };
      else delete models[provider];
      next[key] = normalizeTierModels(models, {});
    }
    if (patch.activation) {
      const { secret, ...change } = patch.activation;
      if (secret !== undefined) await writeActivationSecret(secret);
      next.activation = validActivation({ ...current.activation, ...change });
    }
    if (patch.projectMapping || patch.forgetProjectMapping) {
      const mappings = { ...current.projectMappings };
      if (patch.forgetProjectMapping) delete mappings[patch.forgetProjectMapping];
      if (patch.projectMapping) {
        const { key, ...mapping } = patch.projectMapping;
        delete mappings[key];
        if (Object.keys(mappings).length >= MAX_PROJECT_MAPPINGS) throw new Error(`At most ${MAX_PROJECT_MAPPINGS} project mappings can be saved. Forget one in Settings first.`);
        mappings[key] = mapping;
      }
      next.projectMappings = normalizeProjectMappings(mappings);
      if (patch.projectMapping && !next.projectMappings[patch.projectMapping.key]) throw new Error("This project mapping is not valid.");
    }
    return this.write(next);
  }

  private async write(value: PluginSettings): Promise<PluginSettings> {
    const hasMappings = Object.keys(value.projectMappings).length > 0;
    const customDispatch = JSON.stringify(value.dispatch) !== JSON.stringify(DEFAULT_DISPATCH);
    const customWriteback = JSON.stringify(value.writeback) !== JSON.stringify(DEFAULT_WRITEBACK);
    const customWatchdog = JSON.stringify(value.watchdog) !== JSON.stringify(DEFAULT_WATCHDOG);
    const customAutoApprove = JSON.stringify(value.autoApprove) !== JSON.stringify(DEFAULT_AUTO_APPROVE);
    const customCheapModels = JSON.stringify(value.cheapModels) !== JSON.stringify(DEFAULT_CHEAP_MODELS);
    const customStandardModels = JSON.stringify(value.standardModels) !== JSON.stringify(DEFAULT_STANDARD_MODELS);
    const customActivation = JSON.stringify(value.activation) !== JSON.stringify(DEFAULT_ACTIVATION);
    const customDeputy = JSON.stringify(value.deputy) !== JSON.stringify(DEFAULT_DEPUTY);
    const customBackstop = JSON.stringify(value.backstop) !== JSON.stringify(DEFAULT_BACKSTOP);
    const customWorktreeShards = JSON.stringify(value.worktreeShards) !== JSON.stringify(DEFAULT_WORKTREE_SHARDS);
    if (!value.template && !value.markInProgress && !value.showClosed && !value.lastProvider && !Object.keys(value.launchPreferences).length && !hasMappings && value.agentLinearAccess && !customDispatch && !customWriteback && !customWatchdog && !customAutoApprove && !customCheapModels && !customStandardModels && !value.reviewPeers.length && !customActivation && !customDeputy && !customBackstop && !customWorktreeShards) {
      await rm(this.path, { force: true });
      return value;
    }
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const fileValue: SettingsFile = {};
    if (value.template) fileValue.template = value.template;
    if (value.markInProgress) fileValue.markInProgress = true;
    if (value.showClosed) fileValue.showClosed = true;
    if (value.lastProvider) fileValue.lastProvider = value.lastProvider;
    if (Object.keys(value.launchPreferences).length) fileValue.launchPreferences = value.launchPreferences;
    if (hasMappings) fileValue.projectMappings = value.projectMappings;
    if (!value.agentLinearAccess) fileValue.agentLinearAccess = false;
    if (customDispatch) fileValue.dispatch = value.dispatch;
    if (customWriteback) fileValue.writeback = value.writeback;
    if (customWatchdog) fileValue.watchdog = value.watchdog;
    if (customAutoApprove) fileValue.autoApprove = value.autoApprove;
    if (customCheapModels) fileValue.cheapModels = value.cheapModels;
    if (customStandardModels) fileValue.standardModels = value.standardModels;
    if (value.reviewPeers.length) fileValue.reviewPeers = value.reviewPeers;
    if (customActivation) fileValue.activation = value.activation;
    if (customBackstop) fileValue.backstop = value.backstop;
    if (customDeputy) fileValue.deputy = value.deputy;
    if (customWorktreeShards) fileValue.worktreeShards = value.worktreeShards;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(fileValue), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
    return value;
  }
}
