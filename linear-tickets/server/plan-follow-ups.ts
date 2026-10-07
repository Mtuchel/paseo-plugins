import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planFollowUps } from "../shared/plan-sections";
import type { LinearService } from "./linear";
import { RateLimitedError, withPriority } from "./rate-budget";
import { isUntrusted } from "./starter";
import { paseoHome } from "./ticket-mcp";

// Rounds of Linear failures before the owner is told to file the rest by hand, and their spacing.
export const MAX_ATTEMPTS = 5;
export const RETRY_MS = 10 * 60_000;
// How often the sweep looks for records with a retry due.
const SCAN_MS = 60_000;

type Linear = Pick<LinearService, "issueState" | "viewerId" | "appUserId" | "createIssueAsApp" | "relateAsApp" | "comment">;
type Item = {
  title: string;
  id?: string;
  identifier?: string;
  url?: string;
  related: boolean;
  // Why the item is no longer worked on: the Paseo app could not be used, Linear kept failing, or
  // the ticket is untrusted. A new approval clears it and tries again.
  stopped?: "no-app" | "gave-up" | "untrusted";
};
export type FollowUpRecord = {
  issueId: string;
  identifier: string;
  documentUrl: string | null;
  // The latest approved plan's follow-ups, as keys of `items` (lower-cased titles), in plan order.
  titles: string[];
  // Every follow-up of this ticket's approved plans, so one filed earlier is never filed again.
  items: Record<string, Item>;
  // sha256 of the last comment posted about them.
  notice: string | null;
  // Failed rounds since the last approval; the sweep retries at `retryAt` (epoch ms).
  attempts: number;
  retryAt: number | null;
};

// Follow-ups of an approved plan (README, "Plan follow-ups"): every `follow-up — <title>` of its
// `## Reach` and `## Principles and rules` sections becomes a ticket in Todo, written by the Paseo
// app (never the owner's key), in the origin's project and related to it, and one comment on the
// origin lists them. A ticket not written by the owner or Paseo, or labelled feedback, gets the
// list only. One private record per origin under $PASEO_HOME/linear-tickets/plan-follow-ups,
// written after every Linear write, so a repeated approval files nothing twice and only retries
// what failed. Work for one origin runs one call at a time (the plugin is one process).
export class PlanFollowUps {
  private readonly chains = new Map<string, Promise<void>>();
  private lastScan = Number.NEGATIVE_INFINITY;
  private scanning = false;

  constructor(
    private readonly linear: Linear,
    private readonly directory = join(paseoHome(), "linear-tickets", "plan-follow-ups"),
    private readonly now: () => number = Date.now,
  ) {}

  // Never rejects: filing is not part of the approval, which is never repeated because of it.
  file(origin: { issueId: string; identifier: string; plan: string; documentUrl: string | null }): Promise<void> {
    const titles = planFollowUps(origin.plan);
    if (!titles.length) return Promise.resolve();
    return this.serial(origin.issueId, async () => {
      const record: FollowUpRecord = await this.load(origin.issueId) ?? { issueId: origin.issueId, identifier: origin.identifier, documentUrl: null, titles: [], items: {}, notice: null, attempts: 0, retryAt: null };
      record.identifier = origin.identifier;
      record.documentUrl = origin.documentUrl ?? record.documentUrl;
      record.titles = titles.map((title) => title.toLowerCase());
      for (const title of titles) {
        const item = record.items[title.toLowerCase()];
        if (item) delete item.stopped;
        else record.items[title.toLowerCase()] = { title, related: false };
      }
      record.attempts = 0;
      record.retryAt = null;
      await this.save(record);
      await this.process(record);
    });
  }

  // Called from the Plannotator bridge's sweep: retries records whose retry is due.
  async retryPending(): Promise<void> {
    if (this.scanning || this.now() - this.lastScan < SCAN_MS) return;
    this.scanning = true;
    this.lastScan = this.now();
    const due = (record: FollowUpRecord | null): record is FollowUpRecord => record !== null && record.retryAt !== null && record.retryAt <= this.now();
    try {
      for (const name of await readdir(this.directory).catch(() => [] as string[])) {
        if (!name.endsWith(".json")) continue;
        const found = await this.read(join(this.directory, name));
        if (!due(found)) continue;
        await this.serial(found.issueId, async () => {
          const record = await this.load(found.issueId);
          if (due(record)) await this.process(record);
        });
      }
    } finally {
      this.scanning = false;
    }
  }

  private serial(issueId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(issueId) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      console.error(`[linear-tickets] filing the plan follow-ups of ${issueId} failed: ${error instanceof Error ? error.message : error}`);
    });
    this.chains.set(issueId, run);
    void run.then(() => { if (this.chains.get(issueId) === run) this.chains.delete(issueId); });
    return run;
  }

  // One round: create what is not created, link what is not linked, then tell the owner.
  private process(record: FollowUpRecord): Promise<void> {
    return withPriority("owner", "plan follow-ups", async () => {
      const attempts = record.attempts;
      const active = record.titles.flatMap((key) => record.items[key] && !record.items[key].stopped ? [record.items[key]] : []);
      try {
        await this.processRound(record);
      } catch (error) {
        if (!(error instanceof RateLimitedError)) throw error;
        record.attempts = attempts;
        for (const item of active) if (item.stopped === "gave-up") delete item.stopped;
        record.retryAt = error.resumeAt;
        await this.save(record);
      }
    });
  }

  private async processRound(record: FollowUpRecord): Promise<void> {
    const items = record.titles.flatMap((key) => record.items[key] ?? []);
    let failed = false;
    const create = items.filter((item) => !item.id && !item.stopped);
    const link = items.filter((item) => item.id && !item.related && !item.stopped);
    if (create.length || link.length) {
      try {
        const state = await this.linear.issueState(record.issueId);
        // Checked before every creation, so a feedback label added while one waits stops it.
        const untrusted = create.length > 0 && isUntrusted(state, await this.linear.viewerId(), await this.linear.appUserId());
        for (const item of create) {
          if (untrusted) { item.stopped = "untrusted"; continue; }
          if (!state.teamId) throw new Error("the ticket has no team");
          try {
            const created = await this.linear.createIssueAsApp({
              teamId: state.teamId,
              projectId: state.projectId,
              ready: true,
              title: item.title,
              description: `Follow-up from ${record.identifier}'s approved plan${record.documentUrl ? ` ([plan](${record.documentUrl}))` : ""}: ${item.title}. Filed by Paseo when the plan was approved.`,
            });
            if (!created) item.stopped = "no-app";
            else Object.assign(item, { id: created.id, identifier: created.identifier, url: created.url, related: false });
            await this.save(record);
            if (created) link.push(item);
          } catch (error) {
            if (error instanceof RateLimitedError) throw error;
            failed = true;
            console.error(`[linear-tickets] ${record.identifier}: filing follow-up "${item.title}" failed: ${error instanceof Error ? error.message : error}`);
          }
        }
        for (const item of link) {
          try {
            // null: the app cannot be used right now; the relation is retried, the ticket never re-created.
            if (await this.linear.relateAsApp(item.id!, record.issueId, "related")) {
              item.related = true;
              await this.save(record);
            } else failed = true;
          } catch (error) {
            if (error instanceof RateLimitedError) throw error;
            failed = true;
            console.error(`[linear-tickets] ${record.identifier}: linking follow-up ${item.identifier} failed: ${error instanceof Error ? error.message : error}`);
          }
        }
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        failed = true;
        console.error(`[linear-tickets] ${record.identifier}: filing follow-ups failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    record.retryAt = null;
    if (failed) this.failedRound(record, items);
    await this.save(record);
    await this.announce(record, items);
  }

  private failedRound(record: FollowUpRecord, items: Item[]): void {
    record.attempts += 1;
    if (record.attempts < MAX_ATTEMPTS) { record.retryAt = this.now() + RETRY_MS; return; }
    for (const item of items) if (!item.related && !item.stopped) item.stopped = "gave-up";
  }

  // One comment per distinct outcome; none while a creation still waits for its retry.
  private async announce(record: FollowUpRecord, items: Item[]): Promise<void> {
    const body = noticeText(record, items);
    if (!body) return;
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash === record.notice) return;
    try {
      await this.linear.comment(record.issueId, body);
      record.notice = hash;
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      console.error(`[linear-tickets] ${record.identifier}: the follow-up comment failed: ${error instanceof Error ? error.message : error}`);
      if (record.retryAt === null) this.failedRound(record, []);
    }
    await this.save(record);
  }

  private path(issueId: string): string {
    return join(this.directory, `${issueId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);
  }

  private load(issueId: string): Promise<FollowUpRecord | null> {
    return this.read(this.path(issueId));
  }

  private async read(path: string): Promise<FollowUpRecord | null> {
    const value: unknown = await readFile(path, "utf8").then(JSON.parse, () => null);
    if (!value || typeof value !== "object") return null;
    const record = value as FollowUpRecord;
    return typeof record.issueId === "string" && Array.isArray(record.titles) && record.items && typeof record.items === "object" ? record : null;
  }

  private async save(record: FollowUpRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.issueId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
}

// What the origin's comment says about the latest approved plan's follow-ups; null while a
// creation still waits for its retry.
export function noticeText(record: Pick<FollowUpRecord, "documentUrl">, items: Item[]): string | null {
  if (!items.length || items.some((item) => !item.id && !item.stopped)) return null;
  const plan = record.documentUrl ? ` ([plan](${record.documentUrl}))` : "";
  const groups: [string, Item[]][] = [
    [`📌 Follow-ups filed from the approved plan${plan}:`, items.filter((item) => item.id && item.related)],
    ["Created, but linking them to this ticket is still pending:", items.filter((item) => item.id && !item.related && !item.stopped)],
    ["Created, but Paseo could not link them to this ticket; link them by hand:", items.filter((item) => item.id && !item.related && item.stopped)],
    [`📌 Follow-ups in the approved plan${plan}, not filed because this ticket was not written by you or Paseo:`, items.filter((item) => !item.id && item.stopped === "untrusted")],
    ["Not filed: Paseo could not write to Linear as itself; file them by hand or approve again later:", items.filter((item) => !item.id && item.stopped === "no-app")],
    [`Not filed: Linear failed ${MAX_ATTEMPTS} times; file them by hand or approve again later:`, items.filter((item) => !item.id && item.stopped === "gave-up")],
  ];
  return groups.filter(([, list]) => list.length).map(([head, list]) => `${head}\n${list.map((item) => `- ${item.id ? `${item.url ? `[${item.identifier}](${item.url})` : item.identifier} ` : ""}${item.title}`).join("\n")}`).join("\n\n");
}
