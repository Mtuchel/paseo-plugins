import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paseoHome } from "./ticket-mcp";

// A ticket's workflow state as Paseo last saw it. `at`: for a read, when its request was sent; for
// a state the plugin wrote, when Linear confirmed the write (milliseconds since the epoch).
export type KnownState = { name: string; type: string; at: number };

// The last workflow state Paseo saw of each ticket with a running agent, in known-states.json, for
// crash recovery when Linear refuses even its small ticket check on both pools (README, "Crashed
// agents"). Fed by every state the plugin writes, by crash recovery's own reads and by one batched
// read per pull request watch poll. Of two observations the later stamp wins: a read sent before a
// write never overwrites the write, and a fresh "completed" is never replaced by an older "started".
export class KnownStates {
  private states: Record<string, KnownState> | null = null;
  private loading: Promise<Record<string, KnownState>> | null = null;
  // Saves go out one at a time, each with the states as they are when it starts.
  private saving: Promise<void> = Promise.resolve();

  constructor(readonly path = join(paseoHome(), "linear-tickets", "known-states.json")) {}

  // The file is read once; a missing or unreadable one counts as empty (logged when unreadable):
  // the next successful read fills it.
  private load(): Promise<Record<string, KnownState>> {
    if (this.states) return Promise.resolve(this.states);
    this.loading ??= readFile(this.path, "utf8").then((text) => {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      const valid: Record<string, KnownState> = {};
      for (const [id, entry] of Object.entries(parsed as Record<string, Partial<KnownState>>)) {
        if (entry && typeof entry.name === "string" && typeof entry.type === "string" && typeof entry.at === "number") valid[id] = { name: entry.name, type: entry.type, at: entry.at };
      }
      return valid;
    }, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return {};
    }).catch((error: unknown) => {
      console.error(`[linear-tickets] ${this.path} is unreadable, so no ticket state is known until the next read: ${error instanceof Error ? error.message : error}`);
      return {};
    }).then((states) => {
      this.states = states;
      return states;
    });
    return this.loading;
  }

  async get(issueId: string): Promise<KnownState | null> {
    return (await this.load())[issueId] ?? null;
  }

  // Keeps the state unless the ticket's known one has a later stamp. Saved when the state changed:
  // a newer stamp on the same state stays in memory only, as every later observation is newer still.
  async observe(issueId: string, state: { name: string; type: string }, at: number): Promise<void> {
    if (!state.name) return;
    const states = await this.load();
    const known = states[issueId];
    if (known && known.at > at) return;
    states[issueId] = { name: state.name, type: state.type, at };
    if (!known || known.name !== state.name || known.type !== state.type) await this.save();
  }

  // Forgets the tickets not in `issueIds` (those without a running agent's record); saved when it changed.
  async retain(issueIds: Set<string>): Promise<void> {
    const states = await this.load();
    const gone = Object.keys(states).filter((id) => !issueIds.has(id));
    if (!gone.length) return;
    for (const id of gone) delete states[id];
    await this.save();
  }

  // A failed save is logged; the states stay in memory and the next change saves them all.
  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(this.states), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    }).catch((error: unknown) => {
      console.error(`[linear-tickets] saving ${this.path} failed: ${error instanceof Error ? error.message : error}`);
    });
    return this.saving;
  }
}
