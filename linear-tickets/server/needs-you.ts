import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paseoHome } from "./ticket-mcp";

// A "Needs you" sub-issue: what an agent waits for after its ticket was already closed (a merge
// commit's "Closes" moves it to Done while the agent still watches the deploy or needs a hand).
// The closed ticket stays done; the sub-issue carries the wait in Needs input, and replies on it
// starting with "@paseo" reach `agentId`.
export type NeedsYouIssue = { id: string; identifier: string; parentId: string; agentId: string };

// One private file per open sub-issue, so the comment relay can route replies after a restart.
export class NeedsYouIssues {
  constructor(private readonly directory = join(paseoHome(), "linear-tickets", "needs-you")) {}

  async all(): Promise<NeedsYouIssue[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const entries = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(this.directory, name), "utf8").then((text) => JSON.parse(text) as NeedsYouIssue, () => null)));
    return entries.filter((entry): entry is NeedsYouIssue => Boolean(entry?.id && entry.parentId && entry.agentId));
  }

  async add(entry: NeedsYouIssue): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${entry.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async remove(id: string): Promise<void> {
    await rm(join(this.directory, `${id}.json`), { force: true });
  }
}
