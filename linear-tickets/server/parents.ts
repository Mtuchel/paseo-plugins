import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentAppDirectory } from "./agent-app";

export type ParentPhase = "children" | "verification" | "paused" | "closed";
export type ParentProgress = {
  issueId: string;
  identifier: string;
  sessionId: string | null;
  phase: ParentPhase;
  updatedAt: string;
  nextAction: string;
  blockers: string[];
  children: { issueId: string; identifier: string; status: string; finished: boolean }[];
  // Whether removing the Paseo delegate explicitly ends this responsibility.
  delegated: boolean;
  // A successful assignment is not repeated on stale Linear reads or after a restart.
  handedOut: string[];
  status?: string;
};

// Issue-keyed responsibility, not a UI session's lifetime. Reads never create or repair files.
export class ParentStore {
  readonly path: string;
  private loading: Promise<Record<string, ParentProgress>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory = agentAppDirectory()) { this.path = join(directory, "parents.json"); }

  private load(): Promise<Record<string, ParentProgress>> {
    return this.loading ??= readFile(this.path, "utf8").then((text) => {
      const records = JSON.parse(text) as Record<string, ParentProgress>;
      if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("Invalid parent progress store");
      for (const [id, parent] of Object.entries(records)) {
        if (!parent || parent.issueId !== id || !["children", "verification", "paused", "closed"].includes(parent.phase)
          || !Array.isArray(parent.children) || !Array.isArray(parent.blockers) || !Array.isArray(parent.handedOut)) {
          throw new Error(`Invalid parent progress for ${id}`);
        }
      }
      return records;
    }, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
  }

  async all(): Promise<ParentProgress[]> {
    await this.queue;
    return structuredClone(Object.values(await this.load()));
  }

  async get(issueId: string): Promise<ParentProgress | null> {
    await this.queue;
    return structuredClone((await this.load())[issueId] ?? null);
  }

  // Serialize the read/modify/write, publishing memory only after the atomic rename succeeds.
  update(issueId: string, change: (current: ParentProgress | null) => ParentProgress): Promise<ParentProgress> {
    const run = async () => {
      const records = await this.load();
      const next = change(structuredClone(records[issueId] ?? null));
      if (next.issueId !== issueId) throw new Error("Parent progress issue ID cannot change");
      await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ ...records, [issueId]: next }), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
        records[issueId] = structuredClone(next);
      } finally { await rm(temporary, { force: true }); }
      return structuredClone(next);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
