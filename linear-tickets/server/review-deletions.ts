import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { plannotatorPaths } from "./plannotator";

const Deletion = z.object({
  issueId: z.string().uuid(), identifier: z.string(), agentId: z.string(),
  phase: z.enum(["pending", "deleted"]),
});
export type ReviewDeletion = z.infer<typeof Deletion>;

// Pending means the remote outcome may be unknown. Both phases pause launches; only a confirmed
// deletion consumes stale events. Tombstones survive cleanup and host restarts.
export class ReviewDeletions {
  private loading: Promise<Record<string, ReviewDeletion>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = join(plannotatorPaths().directory, "deletions.json")) {}

  private load(): Promise<Record<string, ReviewDeletion>> {
    return this.loading ??= readFile(this.file, "utf8").then(
      (text) => z.record(z.string(), Deletion).parse(JSON.parse(text)),
      (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return {}; throw error; },
    );
  }

  async get(issueId: string): Promise<ReviewDeletion | null> {
    return (await this.load())[issueId] ?? null;
  }

  async forAgent(agentId: string): Promise<ReviewDeletion | null> {
    return Object.values(await this.load()).find((entry) => entry.agentId === agentId) ?? null;
  }

  async blocked(issueId: string): Promise<boolean> { return Boolean(await this.get(issueId)); }

  put(entry: ReviewDeletion): Promise<void> {
    return this.change((entries) => { entries[entry.issueId] = entry; });
  }

  remove(issueId: string): Promise<void> {
    return this.change((entries) => { delete entries[issueId]; });
  }

  private change(mutate: (entries: Record<string, ReviewDeletion>) => void): Promise<void> {
    const result = this.queue.then(async () => {
      const entries = await this.load();
      mutate(entries);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
