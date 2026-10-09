import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { entityNotFound, type LinearService } from "./linear";
import { withPriority } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";

const INTERVAL_MS = 60 * 1000;
// Some start paths ask the scheduler only every 15 minutes (a failed start's retry), and the line
// forgets a ticket not asked for in 3: a label stays this long after the ticket was last seen
// waiting, so it does not flap, and comes off at once when the ticket is admitted.
const LINGER_MS = 20 * 60 * 1000;
const QUEUED_COLOR = "#95a2b3";

type Linear = Pick<LinearService, "addLabel" | "removeLabel">;

// The wait line in Linear (README, "Wait line label"): every ticket waiting in this host's line
// for an agent slot carries `<trigger>-queued`, and loses it once it is admitted, or LINGER_MS
// after it was last seen waiting.
// The label is shown only; nothing reads it back to decide anything. Each host labels and
// unlabels only the tickets it labelled itself (kept on disk across reloads), so two hosts with
// their own lines never take each other's label off.
export class QueuedLabels {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  // When each labelled ticket was last seen waiting; a ticket labelled before a reload counts as
  // seen at the first pass after it.
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly deps: {
      linear: Linear;
      // Issue ids waiting in this host's line right now, and those it admitted or that work.
      waiting: () => Promise<string[]>;
      admitted: () => string[];
      label: () => Promise<string>;
      now?: () => number;
    },
    private readonly path = join(paseoHome(), "linear-tickets", "queued-labels.json"),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sync(); }, INTERVAL_MS);
    this.timer.unref?.();
    void this.sync();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // One pass at a time; a pass asked for while one runs shares it.
  sync(): Promise<void> {
    return this.running ??= this.pass().catch((error: unknown) => {
      console.error(`[linear-tickets] queued labels: ${error instanceof Error ? error.message : error}`);
    }).finally(() => { this.running = null; });
  }

  private async pass(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const want = new Set(await this.deps.waiting());
    const admitted = new Set(this.deps.admitted());
    const label = await this.deps.label();
    const owned = await this.read();
    for (const issueId of want) this.seen.set(issueId, now);
    for (const issueId of Object.keys(owned)) if (!this.seen.has(issueId)) this.seen.set(issueId, now);
    try {
      for (const [issueId, name] of Object.entries(owned)) {
        const waiting = want.has(issueId) || (!admitted.has(issueId) && now - this.seen.get(issueId)! < LINGER_MS);
        // A renamed trigger: the old name comes off and the new one goes on below.
        if (name === label && waiting) continue;
        await this.write(() => this.deps.linear.removeLabel(issueId, name));
        delete owned[issueId];
        this.seen.delete(issueId);
      }
      for (const issueId of want) {
        if (owned[issueId]) continue;
        const added = await this.write(() => this.deps.linear.addLabel(issueId, label, QUEUED_COLOR));
        if (added) owned[issueId] = label;
      }
    } finally {
      await this.save(owned);
      for (const issueId of this.seen.keys()) if (!owned[issueId] && !want.has(issueId)) this.seen.delete(issueId);
    }
  }

  // false: the ticket is gone in Linear, so there is nothing to label. Any other failure (a rate
  // limit included) ends the pass with what it did so far saved; the next pass retries the rest.
  private async write(work: () => Promise<void>): Promise<boolean> {
    try {
      await withPriority("background", "queued-labels", work);
      return true;
    } catch (error) {
      if (entityNotFound(error)) return false;
      throw error;
    }
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return {};
    }
  }

  private async save(owned: Record<string, string>): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(owned), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
