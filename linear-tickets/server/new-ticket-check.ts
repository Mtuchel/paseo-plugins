// The new-ticket check (README, "New-ticket check"): on every dispatch poll, the tickets filed in
// the dispatch teams since the last poll are checked once against the team's open tickets and
// approved plans, and get at most one comment as the Paseo app naming likely related work and
// asking for a missing Area. Ten minutes after filing, a bug that says it is the same bug as
// another ticket at another place gets the `missed-reach` label and a relation to that ticket.
// The three planning-miss labels are created on the first poll.
//
// State lives in `$PASEO_HOME/linear-tickets/new-ticket-check.json`, private to the daemon user.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { areaLabels } from "./area-labels";
import type { PullRequestFiles } from "./label-sync";
import { decide, labelRulesPath, readLabelRules, resolveGroupFromCatalog, type LabelRules } from "./label-rules";
import type { CatalogLabel, LinearService, NewIssue } from "./linear";
import { filedByPaseo, findings, renderComment, sameAsReferences } from "./new-ticket-match";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { OpenWork, RelatedWork } from "./related-work";
import type { PluginSettings, Settings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// The planning-miss labels (README, "Statuses and labels"): workspace labels, ungrouped, set by people; the ops
// digest counts them. Only `missed-reach` is ever set by Paseo (the "same as" rule).
export const MISS_LABELS = [
  { name: "missed-reach", color: "#f2994a", description: "Planning miss: the plan did not reach a place the change had to reach. Counted in the ops digest." },
  { name: "missed-conflict", color: "#eb5757", description: "Planning miss: the plan missed a conflict with other work. Counted in the ops digest." },
  { name: "broke-rule", color: "#9b51e0", description: "Planning miss: the plan broke an approved rule or principle. Counted in the ops digest." },
] as const;
export const SAME_AS_LABEL = "missed-reach";
// The "same as" rule waits this long after filing, a grace period that usually lets label sync set
// the ticket's Type first.
export const SAME_AS_DELAY_MS = 10 * 60_000;
// Discovery pages read per poll; a longer discovery continues on the next poll.
export const DISCOVERY_PAGES = 10;
// Polls a ticket waits for complete inputs before it is checked with what could be read.
export const INCOMPLETE_POLLS = 5;
// Thrown input reads in one poll after which phase 1 waits for the next poll.
const FAILED_READS = 3;
const PRUNE_MS = 14 * 24 * 60 * 60_000;
// Tickets re-read per request.
const REREAD_BATCH = 50;
const TERMINAL: Record<string, true> = { completed: true, canceled: true, duplicate: true };

const ticketSchema = z.object({
  identifier: z.string(),
  teamId: z.string(),
  createdAt: z.string(),
  tries: z.number().int().nonnegative(),
  commentId: z.string().optional(),
  commented: z.boolean(),
  sameAsDone: z.boolean(),
});
const stateSchema = z.object({
  since: z.string().nullable(),
  scan: z.object({ after: z.string(), max: z.string() }).nullable(),
  tickets: z.record(z.string(), ticketSchema),
});
export type NewTicketState = z.infer<typeof stateSchema>;
type Entry = NewTicketState["tickets"][string];

// One file, every write a whole-file replacement through a temporary file, one at a time.
export class NewTicketStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path = join(paseoHome(), "linear-tickets", "new-ticket-check.json")) {}

  async load(): Promise<NewTicketState> {
    const source = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (source === null) return { since: null, scan: null, tickets: {} };
    let value: unknown;
    try { value = JSON.parse(source); } catch { value = undefined; }
    const checked = stateSchema.safeParse(value);
    if (!checked.success) throw new Error(`${this.path} is malformed; new tickets are not checked until it is fixed or removed.`);
    return checked.data;
  }

  save(state: NewTicketState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    const run = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, snapshot, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

// The rules the Area request predicts label sync from (README, "New-ticket check"): this host's
// label-rules.json, else the copy `label-rules.json.mac-owned` a host keeps when label sync runs on
// the laptop only (server087), so the dispatch host predicts what the laptop's label sync will set.
// Read only: label sync itself never reads the copy.
export async function readCheckRules(path = labelRulesPath()): Promise<LabelRules | null> {
  return (await readLabelRules(path)) ?? (await readLabelRules(`${path}.mac-owned`));
}

export type NewTicketCheckDeps = {
  linear: Pick<LinearService, "appUserId" | "trustedAppIds" | "newIssues" | "issuesById" | "labelCatalog" | "createLabel" | "commentAsApp" | "commentById" | "addLabelAsApp" | "relateAsApp" | "issueRelations" | "issueRef">;
  related: Pick<RelatedWork, "openWork">;
  pullRequests: Pick<PullRequestFiles, "filesOf">;
  settings?: Pick<Settings, "read">;
  rules?: () => Promise<LabelRules | null>;
  store?: NewTicketStore;
  now?: () => number;
};

// One poll's reads, each made at most once (a failed one again for the next ticket).
type PollReads = { catalog: CatalogLabel[] | null; rules: { value: LabelRules | null } | { error: string } | null; appIds: string[] | null; work: Map<string, OpenWork> };

export class NewTicketCheck {
  private readonly store: NewTicketStore;
  private readonly now: () => number;
  // The miss labels this process found usable ("ready") or never applies ("conflicting"); empty
  // after every start, so the catalog is checked again before a label is applied.
  private readonly labels = new Map<string, "ready" | "conflicting">();
  private readonly logged = new Set<string>();

  constructor(private readonly deps: NewTicketCheckDeps) {
    this.store = deps.store ?? new NewTicketStore();
    this.now = deps.now ?? Date.now;
  }

  // Called on every dispatch poll, after the other passes. Only a rate limit is passed on: the
  // dispatcher runs its passes without isolation.
  async tick(_paseo: PaseoApi, settings: PluginSettings): Promise<void> {
    await withPriority("background", "new-ticket check", async () => {
      try {
        await this.run(settings);
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        this.logOnce(message(error));
      }
    });
  }

  private async run(settings: PluginSettings): Promise<void> {
    if (settings.activation.mode === "remote") return;
    const current = this.deps.settings ? await this.deps.settings.read() : settings;
    if (current.activation.mode === "remote" || !current.dispatch.enabled) return;
    const teamKeys = current.dispatch.teamKeys.filter(Boolean);
    if (!teamKeys.length) return;
    if (!(await this.deps.linear.appUserId())) return;
    const reads: PollReads = { catalog: null, rules: null, appIds: null, work: new Map() };
    await this.provisionLabels(reads);
    const state = await this.store.load();
    const fresh = await this.discover(state, teamKeys);
    const now = this.now();
    const entries = Object.entries(state.tickets).sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
    const firstPhase = entries.filter(([, entry]) => !entry.commented);
    const secondPhase = entries.filter(([, entry]) => !entry.sameAsDone && now - Date.parse(entry.createdAt) >= SAME_AS_DELAY_MS);
    const reread = await this.reread([...new Set([...firstPhase.filter(([id]) => !fresh.has(id)), ...secondPhase].map(([id]) => id))]);
    await this.phaseOne(state, firstPhase, fresh, reread, reads);
    await this.phaseTwo(state, secondPhase, reread);
  }

  // The miss labels: created when missing, usable when exactly one ungrouped workspace label has
  // the name; anything else is reported once and never applied. Retried every poll until resolved.
  private async provisionLabels(reads: PollReads): Promise<void> {
    const open = MISS_LABELS.filter((label) => !this.labels.has(label.name));
    if (!open.length) return;
    try {
      const catalog = await this.catalog(reads);
      for (const label of open) {
        const same = catalog.filter((entry) => entry.name.trim().toLowerCase() === label.name);
        if (!same.length) {
          await this.deps.linear.createLabel({ name: label.name, color: label.color, description: label.description });
          this.labels.set(label.name, "ready");
        } else if (same.length === 1 && !same[0].teamId && !same[0].parentId && !same[0].isGroup) {
          this.labels.set(label.name, "ready");
        } else {
          this.labels.set(label.name, "conflicting");
          console.error(`[linear-tickets] new-ticket check: the "${label.name}" label exists ${same.length > 1 ? `${same.length} times` : "inside a group, as a group or for one team only"}; Paseo never applies it until only one ungrouped workspace label has that name (README, "New-ticket check")`);
        }
      }
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      this.logOnce(`creating the planning-miss labels failed: ${message(error)}`);
    }
  }

  // The tickets filed since the cursor: unseen ones become pending, the cursor moves only after a
  // discovery read its last page, and a capped discovery continues on the next poll. One save.
  private async discover(state: NewTicketState, teamKeys: string[]): Promise<Map<string, NewIssue>> {
    const fresh = new Map<string, NewIssue>();
    if (state.since === null) {
      state.since = new Date(this.now()).toISOString();
      await this.store.save(state);
      console.log(`[linear-tickets] new-ticket check: started at ${state.since}; older tickets are not checked`);
      return fresh;
    }
    const since = state.since;
    let after = state.scan?.after ?? null;
    let max = state.scan?.max ?? null;
    const found: NewIssue[] = [];
    try {
      let pages = 0;
      do {
        const page = await this.deps.linear.newIssues(teamKeys, since, after);
        pages++;
        found.push(...page.issues);
        after = page.next;
      } while (after && pages < DISCOVERY_PAGES);
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      this.logOnce(`reading new tickets failed: ${message(error)}`);
      return fresh;
    }
    for (const issue of found) {
      if (!max || issue.createdAt > max) max = issue.createdAt;
      if (state.tickets[issue.id]) continue;
      state.tickets[issue.id] = { identifier: issue.identifier, teamId: issue.teamId, createdAt: issue.createdAt, tries: 0, commented: false, sameAsDone: false };
      fresh.set(issue.id, issue);
    }
    if (after) state.scan = { after, max: max ?? since };
    else {
      state.since = max && max > since ? max : since;
      state.scan = null;
    }
    const cutoff = Date.parse(state.since) - PRUNE_MS;
    for (const [id, entry] of Object.entries(state.tickets)) {
      if (entry.commented && entry.sameAsDone && Date.parse(entry.createdAt) < cutoff) delete state.tickets[id];
    }
    await this.store.save(state);
    return fresh;
  }

  // The tickets left pending by an earlier poll, read again; null when the read failed (they wait).
  private async reread(ids: string[]): Promise<Map<string, NewIssue> | null> {
    const issues = new Map<string, NewIssue>();
    try {
      for (let start = 0; start < ids.length; start += REREAD_BATCH) {
        for (const issue of await this.deps.linear.issuesById(ids.slice(start, start + REREAD_BATCH))) issues.set(issue.id, issue);
      }
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      this.logOnce(`reading pending tickets failed: ${message(error)}`);
      return null;
    }
    return issues;
  }

  // Phase 1: the comment, once per ticket, in the poll that first sees it.
  private async phaseOne(state: NewTicketState, pending: [string, Entry][], fresh: Map<string, NewIssue>, reread: Map<string, NewIssue> | null, reads: PollReads): Promise<void> {
    let failures = 0;
    for (const [id, entry] of pending) {
      if (failures >= FAILED_READS) return;
      const issue = fresh.get(id) ?? reread?.get(id);
      if (!issue) {
        // Not read this poll, or deleted (a re-read that does not return it).
        if (!reread) continue;
        await this.finish(state, entry);
        continue;
      }
      if (TERMINAL[issue.statusType]) { await this.finish(state, entry); continue; }
      try {
        reads.appIds ??= await this.deps.linear.trustedAppIds();
        if (filedByPaseo(issue, reads.appIds)) { await this.finish(state, entry); continue; }
        const work = reads.work.get(issue.teamId) ?? await this.deps.related.openWork(issue.teamId);
        reads.work.set(issue.teamId, work);
        const catalog = await this.catalog(reads);
        const rules = await this.rules(reads);
        const gaps = this.gaps(work, rules);
        if (gaps.length && entry.tries + 1 < INCOMPLETE_POLLS) {
          entry.tries++;
          await this.store.save(state);
          continue;
        }
        const areas = areaLabels(catalog)(issue.labelIds.map((labelId) => ({ id: labelId })));
        const found = findings({ id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description, areas }, work, (url) => this.deps.pullRequests.filesOf(url));
        const askArea = !("error" in rules) && this.asksArea(issue, catalog, rules.value, areas);
        const body = renderComment(found, askArea, gaps);
        if (body && !(await this.comment(state, issue, entry, body))) continue;
        if (!body && gaps.length) console.log(`[linear-tickets] new-ticket check ${issue.identifier}: nothing to say; not fully checked: ${gaps.join("; ")}`);
        entry.commented = true;
        await this.store.save(state);
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        failures++;
        this.logOnce(`checking ${issue.identifier} failed: ${message(error)}`);
      }
    }
  }

  // Posts the comment once: its id is reserved and saved first, so a post whose answer (or save) was
  // lost is found on the retry instead of posted twice. False when the app could not post.
  private async comment(state: NewTicketState, issue: NewIssue, entry: Entry, body: string): Promise<boolean> {
    const reserved = entry.commentId;
    if (!reserved) {
      entry.commentId = randomUUID();
      await this.store.save(state);
    } else if (await this.deps.linear.commentById(reserved)) return true;
    return (await this.deps.linear.commentAsApp(issue.id, body, entry.commentId)) !== null;
  }

  // What could not be read, as the comment's "Not fully checked" names it.
  private gaps(work: OpenWork, rules: NonNullable<PollReads["rules"]>): string[] {
    const gaps: string[] = [];
    if (!work.open.complete) gaps.push("only part of the team's open tickets could be read");
    if (work.unreadPlans.length) gaps.push(`the plans of ${work.unreadPlans.map((title) => /[A-Z][A-Z0-9]*-\d+/.exec(title)?.[0] ?? title).join(", ")} could not be read`);
    if ("error" in rules) gaps.push(`the label rules could not be read (${rules.error})`);
    return gaps;
  }

  // Whether to ask for an Area (README, "New-ticket check"): Linear has a workspace Area group, the
  // ticket has no Area label, and label sync will not set one. A ticket label sync cannot decide yet
  // (a pull request's files are unknown) is left to label sync.
  private asksArea(issue: NewIssue, catalog: CatalogLabel[], rules: LabelRules | null, areas: string[]): boolean {
    if (!catalog.some((label) => label.isGroup && !label.teamId && label.name.trim().toLowerCase() === "area")) {
      this.logOnce("Linear has no workspace Area label group; no Area is asked for");
      return false;
    }
    if (areas.length) return false;
    if (!rules || !rules.groups.some((group) => group.name.toLowerCase() === "area")) return true;
    if (!rules.teamKeys.some((key) => key.toUpperCase() === issue.teamKey.toUpperCase())) return true;
    const group = resolveGroupFromCatalog(rules, catalog, "Area");
    if (!group) return true;
    return decide(issue, group, (url) => this.deps.pullRequests.filesOf(url)) === null;
  }

  // Phase 2: "same as" bugs get the `missed-reach` label and a relation to each ticket named, ten
  // minutes after filing, on a fresh read. Every write is skipped when already there, so a replay
  // after a crash writes nothing twice.
  private async phaseTwo(state: NewTicketState, due: [string, Entry][], reread: Map<string, NewIssue> | null): Promise<void> {
    if (!reread) return;
    for (const [id, entry] of due) {
      const issue = reread.get(id);
      if (!issue || TERMINAL[issue.statusType]) { await this.finish(state, entry); continue; }
      const references = sameAsReferences(issue);
      try {
        if (references.length && !(await this.sameAs(issue, references))) continue;
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        this.logOnce(`linking ${issue.identifier} to the ticket it names failed: ${message(error)}`);
        continue;
      }
      entry.sameAsDone = true;
      await this.store.save(state);
    }
  }

  // False when a write must be retried on the next poll.
  private async sameAs(issue: NewIssue, references: string[]): Promise<boolean> {
    const relations = await this.deps.linear.issueRelations(issue.id);
    const related = new Set(relations.map((relation) => relation.identifier.toUpperCase()));
    const known: string[] = [];
    const missing: string[] = [];
    for (const reference of references) {
      if (related.has(reference)) { known.push(reference); continue; }
      const found = await this.deps.linear.issueRef(reference);
      if (found && found.id !== issue.id) missing.push(found.id);
    }
    if (!known.length && !missing.length) return true;
    const label = this.labels.get(SAME_AS_LABEL);
    if (!label) return false;
    if (label === "ready" && !issue.labelNames.some((name) => name.toLowerCase() === SAME_AS_LABEL)) {
      if ((await this.deps.linear.addLabelAsApp(issue.id, SAME_AS_LABEL)) === null) return false;
    }
    for (const relatedId of missing) {
      if ((await this.deps.linear.relateAsApp(issue.id, relatedId, "related")) === null) return false;
    }
    return true;
  }

  private async finish(state: NewTicketState, entry: Entry): Promise<void> {
    entry.commented = true;
    entry.sameAsDone = true;
    await this.store.save(state);
  }

  private async catalog(reads: PollReads): Promise<CatalogLabel[]> {
    reads.catalog ??= await this.deps.linear.labelCatalog();
    return reads.catalog;
  }

  // An unreadable rules file is an incomplete input, not a failed read.
  private async rules(reads: PollReads): Promise<NonNullable<PollReads["rules"]>> {
    reads.rules ??= await (this.deps.rules ?? readCheckRules)().then((value) => ({ value }), (error: unknown) => ({ error: message(error) }));
    return reads.rules;
  }

  private logOnce(text: string): void {
    if (this.logged.has(text)) return;
    if (this.logged.size >= 100) this.logged.clear();
    this.logged.add(text);
    console.error(`[linear-tickets] new-ticket check: ${text}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
