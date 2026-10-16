import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { LinearService } from "./linear";
import { paseoHome } from "./ticket-mcp";

// A "Needs you" sub-issue: what an agent waits for after its ticket was already closed (a merge
// commit's "Closes" moves it to Done while the agent still watches the deploy or needs a hand).
// The closed ticket stays done; the sub-issue carries the wait in Needs input, and replies on it
// starting with "@paseo" reach `agentId`.
export const needsYouIssueSchema = z.object({
  id: z.string().min(1), identifier: z.string().min(1),
  parentId: z.string().min(1), agentId: z.string().min(1),
  registrationId: z.string().min(1).optional(),
});
export type NeedsYouIssue = z.infer<typeof needsYouIssueSchema>;

const mutations = new Map<string, Promise<void>>();

// One private file per open sub-issue, so the comment relay can route replies after a restart.
export class NeedsYouIssues {
  constructor(private readonly directory = join(paseoHome(), "linear-tickets", "needs-you")) {}

  async all(): Promise<NeedsYouIssue[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const entries = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(this.directory, name), "utf8").then((text) => JSON.parse(text) as NeedsYouIssue, () => null)));
    return entries.filter((entry): entry is NeedsYouIssue => Boolean(entry?.id && entry.parentId && entry.agentId));
  }

  // Completion authority; unlike the tolerant relay reader, unreadable registered questions
  // cannot disappear from the inventory. Only an absent directory is evidence of no questions.
  async allStrict(): Promise<NeedsYouIssue[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const entry = needsYouIssueSchema.parse(JSON.parse(await readFile(join(this.directory, name), "utf8")));
      if (`${entry.id}.json` !== name) throw new Error(`Needs-you record identity does not match ${name}`);
      return entry;
    }));
  }

  async add(entry: NeedsYouIssue): Promise<void> {
    const registered = needsYouIssueSchema.parse({ ...entry, registrationId: randomUUID() });
    await this.mutate(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, `${registered.id}.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(registered), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    });
  }

  async remove(id: string, expected?: NeedsYouIssue): Promise<void> {
    if (expected && expected.id !== id) throw new Error("Needs-you cleanup identity does not match its issue");
    await this.mutate(async () => {
      const path = join(this.directory, `${id}.json`);
      if (expected) {
        let raw: string;
        try { raw = await readFile(path, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        const current = needsYouIssueSchema.parse(JSON.parse(raw));
        if (current.id !== id) throw new Error(`Needs-you record identity does not match ${id}`);
        if (current.identifier !== expected.identifier || current.parentId !== expected.parentId
          || current.agentId !== expected.agentId || current.registrationId !== expected.registrationId) return;
      }
      await rm(path, { force: true });
    });
  }

  // Compare-and-remove must not interleave with a new registration, including another local
  // store instance for this directory. A retry after replacement owns only the old generation.
  private mutate(work: () => Promise<void>): Promise<void> {
    const key = resolve(this.directory);
    const next = (mutations.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    mutations.set(key, next);
    const release = () => { if (mutations.get(key) === next) mutations.delete(key); };
    next.then(release, release);
    return next;
  }
}

// The owner answered on the sub-issue (a relayed comment or an @mention of the Paseo app): it is
// done, and later comments there stay put.
export async function closeAnswered(needsYou: Pick<NeedsYouIssues, "remove">, linear: Pick<LinearService, "complete">, id: string): Promise<void> {
  await needsYou.remove(id);
  await linear.complete(id).catch((error: unknown) => console.error(`[linear-tickets] closing answered sub-issue ${id} failed: ${error instanceof Error ? error.message : error}`));
}
