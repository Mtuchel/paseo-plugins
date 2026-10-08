import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planFollowUps } from "../shared/plan-sections";
import type { LinearService } from "./linear";
import { RateLimitedError, withPriority } from "./rate-budget";
import { isUntrusted } from "./starter";
import { paseoHome } from "./ticket-mcp";

// Spacing between the sweep's retries of a record whose last round failed.
export const RETRY_MS = 10 * 60_000;
// How often the sweep looks for records with a retry due.
const SCAN_MS = 60_000;

type Linear = Pick<LinearService, "issueState" | "viewerId" | "trustedAppIds" | "createIssueAsApp" | "relateAsApp" | "comment" | "issueById" | "commentById">;
type Item = {
  title: string;
  // The Linear id reserved before the create, saved first: a retry looks it up and only creates
  // when Linear has none (a create whose answer was lost must not file a second ticket).
  reservedId?: string;
  id?: string;
  identifier?: string;
  url?: string;
  related: boolean;
  // Why the item is no longer worked on: the Paseo app could not be used, the ticket is not
  // trusted, or (records written before the step stopped giving up) Linear kept failing. A new
  // approval clears it and tries again.
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
  // A comment reserved before it was posted: its id and the sha256 of the body it carries, so a
  // retry looks it up instead of posting a second one.
  noticeId?: string;
  noticePending?: string;
  // Rounds that failed since the last approval; the sweep retries at `retryAt` (epoch ms).
  attempts: number;
  retryAt: number | null;
};

// Follow-ups of an approved plan (README, "Plan follow-ups"): every `follow-up — <title>` of its
// `## Reach` and `## Principles and rules` sections becomes a ticket in Todo, written by the Paseo
// app (never the owner's key), in the origin's project and related to it, and one comment on the
// origin lists them. A ticket not written by the owner or Paseo, or labelled feedback, gets the
// list only. One private record per origin under $PASEO_HOME/linear-tickets/plan-follow-ups,
// written after every Linear write, so a repeated approval files nothing twice and only retries
// what failed. Work for one origin runs one call at a time (the plugin is one process). `file()`
// runs one round and rejects until every follow-up of the latest approved plan is filed and
// related (or stopped for `no-app`/`untrusted`, which an approval cannot fix) and the notice about
// them is posted; the decision worker calls it again on its own retry schedule. The ids of tickets
// and of the notice are reserved before their creates, so an answer lost on the way back is
// recovered by lookup instead of writing twice.
export class PlanFollowUps {
  private readonly chains = new Map<string, Promise<void>>();
  private lastScan = Number.NEGATIVE_INFINITY;
  private scanning = false;

  constructor(
    private readonly linear: Linear,
    private readonly directory = join(paseoHome(), "linear-tickets", "plan-follow-ups"),
    private readonly now: () => number = Date.now,
  ) {}

  // One round of filing. Rejects — a rate limit as the same RateLimitedError — while anything is
  // left: an item of the latest approved plan that is neither filed and related nor stopped for
  // `no-app`/`untrusted`, or a notice that is still owed. Resolves only when the record is
  // complete; the decision worker calls it again until then.
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

  // Called from the Plannotator bridge's sweep: retries records with a retry due, including ones
  // written before `file()` started rejecting. Never rejects itself: a failed round is logged and
  // left for the next sweep.
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
        }).catch((error: unknown) => {
          console.error(`[linear-tickets] retrying the plan follow-ups of ${found.issueId} failed: ${error instanceof Error ? error.message : error}`);
        });
      }
    } finally {
      this.scanning = false;
    }
  }

  // Work for one origin runs one call at a time. The caller gets its own outcome (file() rejects
  // while incomplete); the chain keeps a settled entry so the next call waits for it and runs
  // whatever that one did.
  private serial(issueId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(issueId) ?? Promise.resolve()).then(work);
    const chain = run.catch(() => {});
    this.chains.set(issueId, chain);
    void chain.then(() => { if (this.chains.get(issueId) === chain) this.chains.delete(issueId); });
    return run;
  }

  // One round: create what is not created, link what is not linked, then tell the owner. A rate
  // limit propagates as such — it spends no round, and the record keeps its resume time for the
  // sweep too.
  private process(record: FollowUpRecord): Promise<void> {
    return withPriority("owner", "plan follow-ups", async () => {
      const attempts = record.attempts;
      try {
        await this.processRound(record);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          record.attempts = attempts;
          record.retryAt = error.resumeAt;
          await this.save(record);
        }
        throw error;
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
        const untrusted = create.length > 0 && isUntrusted(state, await this.linear.viewerId(), await this.linear.trustedAppIds());
        for (const item of create) {
          if (untrusted) { item.stopped = "untrusted"; continue; }
          if (!state.teamId) throw new Error("the ticket has no team");
          try {
            // A reserved id means an earlier round may have created the ticket: only a confirmed
            // absence creates, and a lookup that failed never creates (the create error is never
            // taken as "it already exists").
            if (item.reservedId) {
              const found = await this.linear.issueById(item.reservedId);
              if (found) {
                Object.assign(item, { id: found.id, identifier: found.identifier, url: found.url, related: false });
                await this.save(record);
                link.push(item);
                continue;
              }
            } else {
              item.reservedId = randomUUID();
              await this.save(record);
            }
            const created = await this.linear.createIssueAsApp({
              id: item.reservedId,
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
    if (failed) this.failedRound(record);
    await this.save(record);
    await this.announce(record, items);
    if (!this.settled(record, items)) throw new Error(`The plan follow-ups of ${record.identifier} are not filed yet.`);
  }

  // The step is complete only when every item of the latest approved plan is filed and related, or
  // stopped for a reason a new approval cannot fix, and the notice about them is posted.
  private settled(record: FollowUpRecord, items: Item[]): boolean {
    const terminal = (item: Item) => Boolean(item.id && item.related) || item.stopped === "no-app" || item.stopped === "untrusted";
    if (!items.length || !items.every(terminal)) return false;
    const body = noticeText(record, items);
    return body !== null && createHash("sha256").update(body).digest("hex") === record.notice;
  }

  private failedRound(record: FollowUpRecord): void {
    record.attempts += 1;
    record.retryAt = this.now() + RETRY_MS;
  }

  // One comment per distinct outcome; none while a creation still waits for its retry. The id is
  // reserved (and saved) before the post, and a pending notice is looked up by it, so a lost
  // answer or a crash between the post and the save never posts it twice.
  private async announce(record: FollowUpRecord, items: Item[]): Promise<void> {
    const body = noticeText(record, items);
    if (!body) return;
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash === record.notice) return;
    try {
      const reserved = record.noticePending === hash ? record.noticeId : undefined;
      const id = reserved ?? randomUUID();
      const posted = reserved ? (await this.linear.commentById(reserved)) !== null : false;
      if (!reserved) {
        record.noticeId = id;
        record.noticePending = hash;
        await this.save(record);
      }
      if (!posted) await this.linear.comment(record.issueId, body, id);
      record.notice = hash;
      delete record.noticeId;
      delete record.noticePending;
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      console.error(`[linear-tickets] ${record.identifier}: the follow-up comment failed: ${error instanceof Error ? error.message : error}`);
      if (record.retryAt === null) this.failedRound(record);
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
  ];
  return groups.filter(([, list]) => list.length).map(([head, list]) => `${head}\n${list.map((item) => `- ${item.id ? `${item.url ? `[${item.identifier}](${item.url})` : item.identifier} ` : ""}${item.title}`).join("\n")}`).join("\n\n");
}
