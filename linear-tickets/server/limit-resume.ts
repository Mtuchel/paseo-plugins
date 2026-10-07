import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { paseoHome } from "./ticket-mcp";

const MINUTE = 60_000;
export const LIMIT_DAY = 24 * 60 * MINUTE;
export const LIMIT_SPACING = 15 * MINUTE;
export type FallbackChains = Record<string, string[]>;

export function normalizeModel(model: string): string {
  return model.trim().replace(/^omp\//, "").split(/\s+·\s+/)[0].replace(/:[^/:]+$/, "");
}

export function limitError(text: string): { provider: string | null; retryAfterMs: number | null } | null {
  if (!/\b429\b|rate.?limit|usage limit/i.test(text)) return null;
  const selector = /\bmodel=((?:omp\/)?[^\s,)]+)/i.exec(text)?.[1];
  const model = selector ? normalizeModel(selector) : "";
  const hintMs = /retry-after-ms\s*[=:]\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1];
  const hintSeconds = /retry-after\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1];
  const hint = hintMs ? Number(hintMs) : hintSeconds ? Number(hintSeconds) * 1000 : 0;
  return { provider: model.includes("/") ? model.split("/")[0] : null, retryAfterMs: hint > 0 && hint <= 30 * LIMIT_DAY ? hint : null };
}

export function candidates(chains: FallbackChains, model: string): string[] {
  const first = normalizeModel(model);
  if (!first.includes("/")) return [];
  const result = new Set([first]);
  for (const [key, entries] of Object.entries(chains)) {
    if (!key.includes("/")) continue;
    const match = normalizeModel(key);
    if (match !== first && !(match.endsWith("*") && first.startsWith(match.slice(0, -1)))) continue;
    for (const entry of entries) {
      let next = normalizeModel(entry);
      if (next.endsWith("/*")) next = next.slice(0, -1) + first.slice(first.indexOf("/") + 1);
      if (next.includes("/") && !next.includes("*")) result.add(next);
    }
  }
  return [...result];
}

export type UsageWindow = {
  scope?: { tier?: string };
  amount?: { usedFraction?: number; remainingFraction?: number };
  status?: string;
  window?: { resetsAt?: number | string };
};
export type UsageReport = { provider: string; fetchedAt?: number | string; limits: UsageWindow[] };
export type Availability = {
  recovery: { roomNow: boolean; earliestReset: number | null; exhausted: boolean };
  episode: { state: "exhausted" | "room" | "unknown"; until: number | null };
};

function timestamp(value: number | string | undefined): number {
  return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
}
function exhausted(window: UsageWindow): boolean {
  return window.status === "exhausted" || (window.amount?.usedFraction ?? 0) >= 1 || (window.amount?.remainingFraction ?? 1) <= 0;
}
function measurable(window: UsageWindow): boolean {
  return Boolean(window.status && window.status !== "unknown") || Number.isFinite(window.amount?.usedFraction) || Number.isFinite(window.amount?.remainingFraction);
}
function account(report: UsageReport, model: string | null, now: number): { state: "exhausted" | "room" | "unknown"; until: number | null } {
  const fetched = timestamp(report.fetchedAt);
  const shared = report.limits.filter((window) => !window.scope?.tier);
  const relevant = model === null ? shared : report.limits.filter((window) => !window.scope?.tier || model.includes(window.scope.tier));
  if (!Number.isFinite(fetched) || fetched > now || now - fetched > 30 * MINUTE || !shared.length || !relevant.every(measurable)) return { state: "unknown", until: null };
  const used = relevant.filter(exhausted);
  if (!used.length) return { state: "room", until: null };
  const resets = used.map((window) => timestamp(window.window?.resetsAt));
  if (!resets.every(Number.isFinite)) return { state: "unknown", until: null };
  return { state: "exhausted", until: Math.max(...resets) };
}

export function availability(reports: UsageReport[], models: string[], now: number): Availability {
  const recoveryAccounts = models.flatMap((model) => reports.filter((report) => report.provider === model.split("/")[0]).map((report) => account(report, model, now)));
  // A missing candidate provider is unknown, not proof of full exhaustion.
  const allPresent = models.length > 0 && models.every((model) => reports.some((report) => report.provider === model.split("/")[0]));
  const resets = recoveryAccounts.flatMap((item) => item.state === "exhausted" && item.until !== null ? [item.until] : []);
  const own = reports.filter((report) => report.provider === models[0]?.split("/")[0]).map((report) => account(report, null, now));
  const ownResets = own.flatMap((item) => item.until !== null ? [item.until] : []);
  const state = own.some((item) => item.state === "room") ? "room" : own.length && own.every((item) => item.state === "exhausted") ? "exhausted" : "unknown";
  return {
    recovery: { roomNow: recoveryAccounts.some((item) => item.state === "room"), earliestReset: resets.length ? Math.min(...resets) : null, exhausted: allPresent && recoveryAccounts.every((item) => item.state === "exhausted") },
    episode: { state, until: state === "exhausted" ? Math.min(...ownResets) : null },
  };
}

// Shared initial timing; callers own durable budgets, deadlines and due-time revalidation.
export function limitSchedule(recovery: Availability["recovery"] | null | undefined, retryAfterMs: number | null, now: number, jitter: () => number): { basis: LimitPending["basis"]; resumeAt: number } {
  const basis = recovery?.roomNow ? "room" : recovery?.earliestReset !== null && recovery?.earliestReset !== undefined ? "reset" : retryAfterMs ? "retry-after" : "default";
  const resumeAt = basis === "room" ? now : basis === "reset" ? recovery!.earliestReset! + jitter() : basis === "retry-after" ? now + retryAfterMs! + jitter() : now + 30 * MINUTE;
  return { basis, resumeAt };
}

const exec = promisify(execFile);
const reportSchema = z.object({ provider: z.string(), fetchedAt: z.union([z.number(), z.string()]).optional(), limits: z.array(z.object({ scope: z.object({ tier: z.string().optional() }).optional(), amount: z.object({ usedFraction: z.number().optional(), remainingFraction: z.number().optional() }).optional(), status: z.string().optional(), window: z.object({ resetsAt: z.union([z.number(), z.string()]).optional() }).optional() })) });

// Only /v1/usage is read. /v1/snapshot carries credentials and must never be fetched here.
export class UsageReader {
  private configUntil = 0;
  private configPromise: Promise<{ url: string; token: string; chains: FallbackChains } | null> | null = null;
  private usageUntil = 0;
  private usagePromise: Promise<UsageReport[] | null> | null = null;
  private readonly logged = new Set<string>();

  constructor(private readonly deps: {
    now?: () => number;
    config?: () => Promise<{ url: string; token: string; chains: FallbackChains }>;
    fetch?: typeof fetch;
    log?: (message: string) => void;
  } = {}) {}

  private clock(): number { return this.deps.now?.() ?? Date.now(); }
  private failed(message: string): null {
    if (!this.logged.has(message)) { this.logged.add(message); (this.deps.log ?? console.error)(`[linear-tickets] limit resumes: ${message}`); }
    return null;
  }
  private configuration(): Promise<{ url: string; token: string; chains: FallbackChains } | null> {
    if (this.configPromise && this.clock() < this.configUntil) return this.configPromise;
    this.configUntil = this.clock() + 10 * MINUTE;
    this.configPromise = (async () => {
      if (this.deps.config) return this.deps.config();
      const binary = (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "omp")).find(existsSync) ?? join(homedir(), ".local", "bin", "omp");
      const [url, chains, token] = await Promise.all([
        exec(binary, ["config", "get", "auth.broker.url"], { timeout: 10_000 }),
        exec(binary, ["config", "get", "retry.fallbackChains", "--json"], { timeout: 10_000 }),
        readFile(join(homedir(), ".omp", "auth-broker.token"), "utf8"),
      ]);
      const parsed = z.object({ value: z.record(z.string(), z.array(z.string())) }).parse(JSON.parse(chains.stdout));
      const base = url.stdout.trim();
      if (!/^https?:\/\//.test(base) || !token.trim()) throw new Error("invalid broker configuration");
      return { url: base.replace(/\/+$/, ""), token: token.trim(), chains: parsed.value };
    })().catch(() => this.failed("broker configuration cannot be read"));
    return this.configPromise;
  }
  async chains(): Promise<FallbackChains | null> { return (await this.configuration())?.chains ?? null; }
  read(): Promise<UsageReport[] | null> {
    if (this.usagePromise && this.clock() < this.usageUntil) return this.usagePromise;
    this.usageUntil = this.clock() + MINUTE;
    this.usagePromise = (async () => {
      const config = await this.configuration();
      if (!config) return null;
      const response = await (this.deps.fetch ?? fetch)(`${config.url}/v1/usage`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return this.failed(`broker usage HTTP ${response.status}`);
      const parsed = z.object({ reports: z.array(reportSchema) }).safeParse(await response.json());
      return parsed.success ? parsed.data.reports : this.failed("broker usage has an unknown shape");
    })().catch(() => this.failed("broker usage cannot be read"));
    return this.usagePromise;
  }
}

const iso = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const basisSchema = z.enum(["room", "reset", "retry-after", "default"]);
const resolutionSchema = z.enum(["pending", "claimed", "started", "forwarded", "failed", "cancelled", "superseded", "bounded", "switched-off"]);
const pendingSchema = z.object({ identifier: z.string(), sessionId: z.string(), agentId: z.string(), provider: z.string(), model: z.string(), failedAt: iso, resumeAt: iso, basis: basisSchema });
const incidentSchema = z.object({ failedAgentId: z.string(), failedAt: iso, provider: z.string(), exhausted: z.boolean(), basis: basisSchema, claimedAt: iso.optional(), startedAt: iso.optional(), resolution: resolutionSchema });
const episodeSchema = z.object({ since: iso, until: iso.nullable(), lastConfirmedAt: iso, mention: z.object({ issueId: z.string(), key: z.string(), attempted: z.boolean(), posted: z.boolean() }).nullable() });
const fileSchema = z.object({ version: z.literal(1), pending: z.record(z.string(), pendingSchema), incidents: z.record(z.string(), z.array(incidentSchema)), episodes: z.record(z.string(), episodeSchema) });
export type LimitPending = z.infer<typeof pendingSchema>;
export type LimitIncident = z.infer<typeof incidentSchema>;
export type LimitResumeFile = z.infer<typeof fileSchema>;
export type LimitBasis = LimitPending["basis"];
export class LimitResumeStateError extends Error {}

export class LimitResumeStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path = join(paseoHome(), "linear-tickets", "limit-resumes.json"), private readonly now = Date.now) {}
  async read(): Promise<LimitResumeFile> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pending: {}, incidents: {}, episodes: {} };
      throw new LimitResumeStateError("limit-resumes.json cannot be read");
    }
    try { return fileSchema.parse(JSON.parse(text)); } catch { throw new LimitResumeStateError("limit-resumes.json has an unknown shape or version"); }
  }
  update<T>(work: (file: LimitResumeFile) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const file = await this.read();
      const result = await work(file);
      for (const [issueId, incidents] of Object.entries(file.incidents)) {
        file.incidents[issueId] = incidents.filter((incident) =>
          Math.max(Date.parse(incident.failedAt), Date.parse(incident.claimedAt ?? incident.failedAt), Date.parse(incident.startedAt ?? incident.failedAt)) >= this.now() - 8 * LIMIT_DAY
          || (file.pending[issueId]?.agentId === incident.failedAgentId && file.pending[issueId]?.failedAt === incident.failedAt));
        if (!file.incidents[issueId].length) delete file.incidents[issueId];
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(file), { mode: 0o600, flag: "wx" }); await rename(temporary, this.path); }
      finally { await rm(temporary, { force: true }); }
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export function incidentFor(file: LimitResumeFile, issueId: string, entry: LimitPending): LimitIncident {
  const incident = file.incidents[issueId]?.findLast((item) => item.failedAgentId === entry.agentId && item.failedAt === entry.failedAt);
  if (!incident) throw new LimitResumeStateError("limit resume schedule has no failure incident");
  return incident;
}
export function finishPending(file: LimitResumeFile, issueId: string, resolution: LimitIncident["resolution"]): void {
  const entry = file.pending[issueId];
  if (!entry) return;
  incidentFor(file, issueId, entry).resolution = resolution;
  delete file.pending[issueId];
}
export function claims(file: LimitResumeFile, issueId: string, now: number): number[] {
  return (file.incidents[issueId] ?? []).flatMap((incident) => incident.claimedAt && Date.parse(incident.claimedAt) > now - LIMIT_DAY ? [Date.parse(incident.claimedAt)] : []);
}
export function updateEpisode(file: LimitResumeFile, provider: string, reading: Availability["episode"], now: number): void {
  if (reading.state === "room") { delete file.episodes[provider]; return; }
  if (reading.state !== "exhausted") return;
  const at = new Date(now).toISOString();
  const episode = file.episodes[provider] ??= { since: at, until: null, lastConfirmedAt: at, mention: null };
  episode.until = reading.until === null ? null : new Date(reading.until).toISOString();
  episode.lastConfirmedAt = at;
}

const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });
const berlinTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const berlinDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit" });
export function limitTime(at: number, now: number, alwaysDate = false): string {
  return `${alwaysDate || berlinDay.format(at) !== berlinDay.format(now) ? `${berlinDate.format(at)} ` : ""}${berlinTime.format(at)} (Berlin time)`;
}
