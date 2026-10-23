import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LinearService } from "./linear";
import { chosenByHand, planLabelChanges, readLabelRules, type LabelRules, type ResolvedGroup, type SweptIssue } from "./label-rules";
import { ghJson, PullRequestNotFoundError } from "./pr-watch";
import { GitHubRateLimitedError, RateLimitedError, withPriority } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";

const SYNC_MS = 2 * 60 * 1000;
const COVERED_SYNC_MS = 300_000;
// Check coverage cheaply each minute so losing it restores the original two-minute cadence.
const TIMER_MS = 60_000;
const SOON_MS = 2_000;
// A full sweep reads every issue of the teams; the ones in between only issues updated since the last.
const FULL_SWEEP_MS = 30 * 60 * 1000;
// Incremental sweeps overlap by this much, so an update made while a sweep ran is not missed.
const SWEEP_OVERLAP_MS = 60 * 1000;
const MAX_FAILURES = 3;
// GitHub reads per cycle: a first sweep over many tickets reads its pull requests over several
// cycles.
const PULL_REQUEST_READS = 150;
// An open pull request's files are read again after this; merged and closed ones never change.
const OPEN_FRESH_MS = 30 * 60 * 1000;

// `final`: merged, closed or missing on GitHub, so its files never change and are kept on disk.
// `state`: GitHub's state (OPEN, MERGED, CLOSED), MISSING for a pull request GitHub does not know,
// or "" when unknown: a failed read, or an entry saved before the state was kept (`legacy`, read
// again once).
type FilesEntry = { files: string[]; state: string; mergedAt: string | null; final: boolean; at: number; legacy?: boolean };
export type PullRequestRead = { state: string; files: string[]; mergedAt: string | null };
export type PullRequestState = { state: string; mergedAt: string | null };

// A pull request's changed files as "owner/repo/path", with its state and merge time.
export async function readPullRequestFiles(url: string): Promise<PullRequestRead> {
  const repo = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? "";
  const data = await ghJson<{ state?: string; files?: { path?: string }[]; mergedAt?: string | null }>(["pr", "view", url, "--json", "state,files,mergedAt"]);
  return { state: data.state ?? "", files: (data.files ?? []).flatMap((file) => file.path ? [`${repo}/${file.path}`] : []), mergedAt: data.mergedAt || null };
}

export class PullRequestFiles {
  private readonly entries = new Map<string, FilesEntry>();
  private loading: Promise<void> | null = null;
  private dirty = false;
  private readonly logged = new Set<string>();

  constructor(
    private readonly path = join(paseoHome(), "linear-tickets", "pr-files.json"),
    private readonly read: (url: string) => Promise<PullRequestRead> = readPullRequestFiles,
    private readonly now: () => number = () => Date.now(),
  ) {}

  filesOf(url: string): string[] | null {
    return this.entries.get(url)?.files ?? null;
  }

  // The pull request's state as last read; null while it is unknown (never read, a failed read, or
  // an entry saved before the state was kept).
  stateOf(url: string): PullRequestState | null {
    const entry = this.entries.get(url);
    return entry?.state ? { state: entry.state, mergedAt: entry.mergedAt } : null;
  }

  // Reads up to `limit` pull requests not known yet or open and stale, in the order given. A read
  // GitHub refuses counts as no files until it is retried; throttling ends the reads for this cycle.
  async refresh(urls: string[], limit: number): Promise<void> {
    await (this.loading ??= this.load());
    const now = this.now();
    const due = [...new Set(urls)].filter((url) => {
      const entry = this.entries.get(url);
      return !entry || ((entry.legacy || !entry.final) && now - entry.at > OPEN_FRESH_MS);
    }).slice(0, limit);
    for (const url of due) {
      try {
        const { state, files, mergedAt } = await this.read(url);
        const final = state === "MERGED" || state === "CLOSED";
        this.entries.set(url, { files, state, mergedAt, final, at: now });
        if (final) this.dirty = true;
      } catch (error) {
        if (error instanceof GitHubRateLimitedError) break;
        if (error instanceof PullRequestNotFoundError) { this.entries.set(url, { files: [], state: "MISSING", mergedAt: null, final: true, at: now }); this.dirty = true; continue; }
        // A legacy entry keeps its files until a read succeeds.
        const known = this.entries.get(url);
        this.entries.set(url, known?.legacy ? { ...known, at: now } : { files: [], state: "", mergedAt: null, final: false, at: now });
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        if (!this.logged.has(message)) { this.logged.add(message); console.error(`[linear-tickets] label rules: reading ${url} failed: ${message}`); }
      }
    }
    await this.save();
  }

  private async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8")) as { pullRequests?: Record<string, unknown> };
      const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((file) => typeof file === "string");
      for (const [url, value] of Object.entries(saved.pullRequests ?? {})) {
        // Saved before the state was kept: the files stay usable, the state is read again once.
        if (strings(value)) { this.entries.set(url, { files: value, state: "", mergedAt: null, final: true, at: 0, legacy: true }); continue; }
        const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
        if (!strings(entry.files) || typeof entry.state !== "string" || !entry.state) continue;
        this.entries.set(url, { files: entry.files, state: entry.state, mergedAt: typeof entry.mergedAt === "string" ? entry.mergedAt : null, final: true, at: 0 });
      }
    } catch {
      // No cache yet, or an unreadable one: the files are read from GitHub again.
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    const pullRequests = Object.fromEntries([...this.entries].filter(([, entry]) => entry.final).map(([url, entry]) => [url, entry.legacy ? entry.files : { files: entry.files, state: entry.state, mergedAt: entry.mergedAt }]));
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ pullRequests }), { mode: 0o600 });
      await rename(temporary, this.path);
      this.dirty = false;
    } catch (error) {
      await rm(temporary, { force: true });
      console.error(`[linear-tickets] label rules: saving the pull request cache failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

type Deps = {
  linear: Pick<LinearService, "labelCatalog" | "createLabel" | "moveLabelIntoGroup" | "labelSweep" | "labelHistory" | "changeLabels" | "appUserId">;
  pullRequests: Pick<PullRequestFiles, "filesOf" | "refresh">;
  rules?: () => Promise<LabelRules | null>;
  now?: () => number;
  covered?: () => boolean;
};

// Keeps the configured label groups on the teams' issues (see label-rules.ts). Every cycle sweeps the
// issues updated since the last one, every FULL_SWEEP_MS all of them, and applies what the rules
// decide, except where a person chose the label. Writes go out as the Paseo app only: its authorship
// is how the plugin tells its own labels from the ones people set.
export class LabelSync {
  private timer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again: "event" | "sync" | null = null;
  private lastAttempt = -Infinity;
  private retry = false;
  private stopped = false;
  private readonly logged = new Set<string>();
  // `complete`: every configured label was found or made in its group; else checked again with the next full sweep.
  private groups: { hash: string; resolved: ResolvedGroup[]; complete: boolean } | null = null;
  private catalogVersion = 0;
  private rulesHash: string | null = null;
  private lastFull = -Infinity;
  private watermark: string | null = null;
  // "<issue id> <group id>" → the issue's updatedAt when a person's choice was found; read again once the issue changes.
  private readonly byHand = new Map<string, string>();

  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void (this.deps.rules ?? readLabelRules)().then((rules) => {
        const interval = this.deps.covered?.() && !this.retry ? COVERED_SYNC_MS : SYNC_MS;
        if ((rules?.hash ?? null) !== this.rulesHash || (this.deps.now?.() ?? Date.now()) - this.lastAttempt >= interval) void this.sync();
      }).catch((error: unknown) => this.report(error));
    }, TIMER_MS);
    this.timer.unref?.();
    void this.sync();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer ?? undefined);
    clearTimeout(this.soonTimer ?? undefined);
    this.timer = this.soonTimer = null;
  }

  // No targeted-ID labelSweep seam exists: debounce issue events into one incremental sweep.
  issueChanged(_issueId: string): void {
    this.soon();
  }

  catalogChanged(): void {
    this.catalogVersion++;
    this.groups = null;
    this.soon();
  }

  private soon(): void {
    if (this.stopped || !this.timer) return;
    clearTimeout(this.soonTimer ?? undefined);
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.requestSync(true);
    }, SOON_MS);
    this.soonTimer.unref?.();
  }

  sync(): Promise<void> {
    return this.requestSync(false);
  }

  private requestSync(event: boolean): Promise<void> {
    if (this.running) {
      if (!event || !this.again) this.again = event ? "event" : "sync";
      return this.running;
    }
    // Event traffic must not postpone the periodic full/recovery sweeps indefinitely.
    if (!event) this.lastAttempt = this.deps.now?.() ?? Date.now();
    this.retry = true;
    this.running = this.run(event).then((success) => { this.retry = !success; }).catch((error: unknown) => this.report(error)).finally(() => {
      this.running = null;
      const again = this.again;
      this.again = null;
      if (again && !this.stopped) void this.requestSync(again === "event");
    });
    return this.running;
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof RateLimitedError ? `rate:${error.pool}` : message;
    if (this.logged.has(cause)) return;
    this.logged.add(cause);
    console.error(`[linear-tickets] label rules: ${message}`);
  }

  private async run(event: boolean): Promise<boolean> {
    // Background priority covers the whole round, the rules read and the app check included, so a
    // direct call pauses at the pool's reserve before its first request (see rate-budget.ts).
    return withPriority("background", "label-sync", async () => {
      if (this.stopped) return false;
      const rules = await (this.deps.rules ?? readLabelRules)();
      this.rulesHash = rules?.hash ?? null;
      if (!rules) { this.groups = null; return true; }
      const pluginUser = await this.deps.linear.appUserId();
      if (!pluginUser) throw new Error("the Paseo Linear app is not usable on this host; labels wait for it, since the app's authorship tells the plugin's labels from people's.");
      const now = this.deps.now?.() ?? Date.now();
      const full = !event && now - this.lastFull >= FULL_SWEEP_MS;
      let groups = this.groups;
      if (groups?.hash !== rules.hash || (!groups.complete && full)) {
        const version = this.catalogVersion;
        groups = { hash: rules.hash, ...await this.ensureGroups(rules) };
        // A catalog event received during resolution must still cause another resolution.
        if (version === this.catalogVersion) this.groups = groups;
        this.watermark = null;
      }
      const issues = await this.sweep(rules.teamKeys, full ? null : this.watermark);
      await this.deps.pullRequests.refresh(issues.flatMap((issue) => issue.pullRequests), PULL_REQUEST_READS);
      const { changes, waiting } = planLabelChanges(issues, groups.resolved, (url) => this.deps.pullRequests.filesOf(url), now);
      let failures = 0;
      let failed = false;
      for (const change of changes) {
        if (failures >= MAX_FAILURES || this.stopped) break;
        const key = `${change.issue.id} ${change.group.id}`;
        if (this.byHand.get(key) === change.issue.updatedAt) continue;
        try {
          const members = new Set(change.group.members);
          const events = await this.deps.linear.labelHistory(change.issue.id, (event) => [...event.added, ...event.removed].some((id) => members.has(id)));
          if (chosenByHand(events, members, change.remove.length > 0, pluginUser)) { this.byHand.set(key, change.issue.updatedAt); continue; }
          await this.deps.linear.changeLabels(change.issue.id, [change.add], change.remove);
          failures = 0;
          const name = change.group.labels.find((entry) => entry.id === change.add)?.rule.name;
          console.log(`[linear-tickets] label rules: ${change.issue.identifier} ${change.group.rule.name}/${name} (${change.reason})`);
        } catch (error) {
          if (error instanceof RateLimitedError) throw error;
          failures++;
          failed = true;
          this.report(error);
        }
      }
      if (this.stopped) return false;
      if (failures >= MAX_FAILURES) throw new Error(`stopped this round after ${MAX_FAILURES} failed label changes; retrying with the next cycle.`);
      // Failed processing must not move the cursor beyond issues that still need a retry.
      if (!failed) {
        // Undecided issues are not updated again by themselves, so the next periodic cycle reads them all.
        if (waiting) this.lastFull = -Infinity;
        else if (full) this.lastFull = now;
        this.watermark = new Date(now - SWEEP_OVERLAP_MS).toISOString();
        this.logged.clear();
      }
      return !failed;
    });
  }

  private async sweep(teamKeys: string[], since: string | null): Promise<SweptIssue[]> {
    const issues: SweptIssue[] = [];
    let after: string | null = null;
    do {
      const page = await this.deps.linear.labelSweep(teamKeys, since, after);
      issues.push(...page.issues);
      after = page.next;
    } while (after && !this.stopped);
    return issues;
  }

  // Finds each configured group and label among the workspace labels, makes the missing ones and
  // moves ungrouped workspace labels of a configured name into their group (existing "Bug" becomes
  // "Type/Bug" with its issues). A label already in another group is reported and left out.
  private async ensureGroups(rules: LabelRules): Promise<{ resolved: ResolvedGroup[]; complete: boolean }> {
    const catalog = (await this.deps.linear.labelCatalog()).filter((entry) => !entry.teamId);
    const named = (name: string, group: boolean) => catalog.find((entry) => entry.isGroup === group && entry.name.toLowerCase() === name.toLowerCase());
    const resolved: ResolvedGroup[] = [];
    let complete = true;
    for (const group of rules.groups) {
      let groupId = named(group.name, true)?.id;
      if (!groupId) {
        if (named(group.name, false)) { complete = false; this.report(new Error(`"${group.name}" is a plain label, not a group; rename it in Linear so the group can be made.`)); continue; }
        groupId = await this.deps.linear.createLabel({ name: group.name, isGroup: true, ...(group.color ? { color: group.color } : {}) });
      }
      const labels: ResolvedGroup["labels"] = [];
      for (const rule of group.labels) {
        const existing = named(rule.name, false);
        try {
          if (!existing) {
            labels.push({ rule, id: await this.deps.linear.createLabel({ name: rule.name, parentId: groupId, ...(rule.color ? { color: rule.color } : {}), ...(rule.description ? { description: rule.description } : {}) }) });
          } else if (existing.parentId === groupId) {
            labels.push({ rule, id: existing.id });
          } else if (!existing.parentId) {
            await this.deps.linear.moveLabelIntoGroup(existing.id, groupId, rule.name);
            labels.push({ rule, id: existing.id });
          } else {
            throw new Error(`"${rule.name}" already belongs to another label group; it is left out of ${group.name}.`);
          }
        } catch (error) {
          if (error instanceof RateLimitedError) throw error;
          complete = false;
          this.report(error);
        }
      }
      const members = [...new Set([...catalog.filter((entry) => entry.parentId === groupId).map((entry) => entry.id), ...labels.map((entry) => entry.id)])];
      resolved.push({ rule: group, id: groupId, labels, members });
    }
    return { resolved, complete };
  }
}
