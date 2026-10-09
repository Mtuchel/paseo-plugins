import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { entityNotFound, type LinearService } from "./linear";
import { withPriority } from "./rate-budget";
import { paseoHome } from "./ticket-mcp";

const INTERVAL_MS = 60 * 1000;
// The line lives in memory: after a reload every start path asks again within its own cadence
// (the scheduler forgets a ticket not asked for in 3 minutes), so labels only come off once the
// line had that long to fill again.
const SETTLE_MS = 3 * 60 * 1000;
const QUEUED_COLOR = "#95a2b3";

type Linear = Pick<LinearService, "addLabel" | "removeLabel">;

// The wait line in Linear (README, "Wait line label"): every ticket waiting in this host's line
// for an agent slot carries `<trigger>-queued`, and loses it once it starts or stops waiting.
// The label is shown only; nothing reads it back to decide anything. Each host labels and
// unlabels only the tickets it labelled itself (kept on disk across reloads), so two hosts with
// their own lines never take each other's label off.
export class QueuedLabels {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private startedAt: number | null = null;

  constructor(
    private readonly deps: {
      linear: Linear;
      // Issue ids waiting in this host's line right now.
      waiting: () => Promise<string[]>;
      label: () => Promise<string>;
      now?: () => number;
    },
    private readonly path = join(paseoHome(), "linear-tickets", "queued-labels.json"),
  ) {}

  start(): void {
    if (this.timer) return;
    this.startedAt = (this.deps.now ?? Date.now)();
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
    const want = new Set(await this.deps.waiting());
    const label = await this.deps.label();
    const owned = await this.read();
    const settled = this.startedAt === null || (this.deps.now ?? Date.now)() - this.startedAt >= SETTLE_MS;
    try {
      for (const [issueId, name] of Object.entries(owned)) {
        // A renamed trigger: the old name comes off and the new one goes on below.
        if (name === label && (want.has(issueId) || !settled)) continue;
        await this.write(() => this.deps.linear.removeLabel(issueId, name));
        delete owned[issueId];
      }
      for (const issueId of want) {
        if (owned[issueId]) continue;
        const added = await this.write(() => this.deps.linear.addLabel(issueId, label, QUEUED_COLOR));
        if (added) owned[issueId] = label;
      }
    } finally {
      await this.save(owned);
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
