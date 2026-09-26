import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_PROJECT_MAPPINGS, type ProjectMapping } from "../shared/mapping";

export const MAX_TEMPLATE_LENGTH = 8_000;

export type LaunchPreference = { model: string; modeId?: string; thinkingOptionId?: string };
// Auto-dispatch starts an agent for every open ticket carrying `label` in one of `teamKeys`,
// whoever it is assigned to. No teams means nothing is dispatched, even when enabled.
// `maxRunning`: at most this many ticket agents work at once (0 = no limit); others wait their turn.
export type DispatchSettings = { enabled: boolean; label: string; teamKeys: string[]; intervalSeconds: number; maxRunning: number };
// Which lifecycle events of ticket-linked agents are written back to their Linear ticket.
// `mentions` is the inbound direction: "@paseo" comments by the key's user reach the agent.
export type WritebackSettings = { status: boolean; summaries: boolean; blocked: boolean; pullRequests: boolean; mentions: boolean; autoResume: boolean };
export const DEFAULT_DISPATCH: DispatchSettings = { enabled: false, label: "paseo", teamKeys: [], intervalSeconds: 60, maxRunning: 0 };
export const MAX_RUNNING_LIMIT = 20;
export const DEFAULT_WRITEBACK: WritebackSettings = { status: false, summaries: false, blocked: false, pullRequests: false, mentions: false, autoResume: false };
export const MIN_DISPATCH_INTERVAL_SECONDS = 30;
export const MAX_DISPATCH_INTERVAL_SECONDS = 3_600;
export const MAX_DISPATCH_TEAMS = 20;
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
  };
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
    };
    if (patch.launchPreference) {
      const { provider, model, modeId, thinkingOptionId } = patch.launchPreference;
      next.lastProvider = provider;
      next.launchPreferences = { ...current.launchPreferences, [provider]: { model, ...(modeId ? { modeId } : {}), ...(thinkingOptionId ? { thinkingOptionId } : {}) } };
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
    if (!value.template && !value.markInProgress && !value.showClosed && !value.lastProvider && !Object.keys(value.launchPreferences).length && !hasMappings && value.agentLinearAccess && !customDispatch && !customWriteback) {
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
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(fileValue), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
    return value;
  }
}
