import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { takeLease, releaseLease } from "./watchdog";

export type ContinueOperation = { issueId: string; agentId: string; operationId: string; text: string };
export type ContinuationResult = { status: "queued" | "sent" | "started" | "unknown" | "cancelled"; reason?: string };
const schema = z.object({
  issueId: z.string(), agentId: z.string(), operationId: z.string(), text: z.string(),
  status: z.enum(["queued", "sent", "started", "unknown", "cancelled"]),
  reason: z.string().optional(), updatedAt: z.string(),
});
export type ContinuationRecord = z.infer<typeof schema>;

// One file per stable operation: persist the ambiguous state BEFORE dispatch. A process death
// never turns an uncertain send back into a queued retry. Callers reconcile the same identity.
export class Continuations {
  private readonly active = new Map<string, Promise<ContinuationResult>>();
  async pending(): Promise<ContinuationRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: ContinuationRecord[] = [];
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = schema.parse(JSON.parse(await readFile(join(this.directory, name), "utf8")));
      if (record.status === "queued" || ((record.status === "unknown" || record.status === "sent") && Date.now() - Date.parse(record.updatedAt) <= 10 * 60_000)) records.push(record);
    }
    return records;
  }
  constructor(private readonly directory: string) {}
  private path(id: string) { return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`); }
  async get(id: string): Promise<ContinuationRecord | null> {
    try { return schema.parse(JSON.parse(await readFile(this.path(id), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async save(record: ContinuationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path(record.operationId)}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(schema.parse(record))); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path(record.operationId));
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  run(input: ContinueOperation, work: (record: ContinuationRecord, save: (result: ContinuationResult) => Promise<void>) => Promise<ContinuationResult>): Promise<ContinuationResult> {
    const existing = this.active.get(input.operationId);
    if (existing) return existing.then(() => this.run(input, work));
    const run = (async (): Promise<ContinuationResult> => {
      const path = this.path(input.operationId);
      const instance = randomUUID();
      if (!await takeLease(path, instance)) return { status: "unknown", reason: "another sender holds this continuation operation" };
      try {
        let record = await this.get(input.operationId);
        if (record && (record.issueId !== input.issueId || record.agentId !== input.agentId || record.text !== input.text)) throw new Error("Continuation identity was reused with different input.");
        if (!record) {
          record = { ...input, status: "queued", updatedAt: new Date().toISOString() };
          await this.save(record);
        }
        const save = async (result: ContinuationResult) => {
          if (record!.status === result.status && record!.reason === result.reason) return;
          record = { ...record!, ...result, reason: result.reason, updatedAt: new Date().toISOString() };
          await this.save(record);
        };
        return await work(record, save);
      } finally { await releaseLease(path, instance); }
    })();
    this.active.set(input.operationId, run);
    void run.finally(() => { if (this.active.get(input.operationId) === run) this.active.delete(input.operationId); }).catch(() => {});
    return run;
  }
}

export function continuationMarker(operationId: string): string {
  return `[paseo-continuation:${createHash("sha256").update(operationId).digest("hex")}]`;
}

// Only native user messages count as receipt; echoed marker text in assistant output does not.
export async function continuationReceipt(handle: unknown, marker: string): Promise<"sent" | "started" | null> {
  if (typeof handle !== "string" || !handle.startsWith("/") || !handle.endsWith(".jsonl")) return null;
  const file = await open(handle, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start) lines.shift();
    lines.pop(); // An incomplete final record is not evidence.
    type Entry = { id?: string; parentId?: string; type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
    const entries = new Map<string, Entry>();
    let head: string | undefined;
    for (const line of lines) {
      if (!line) continue;
      let entry: Entry;
      try { entry = JSON.parse(line); } catch { return null; }
      if (!entry || typeof entry !== "object") return null;
      if (entry.timestamp && Date.parse(entry.timestamp) > Date.now() + 300_000) return null;
      if (entry.id && entry.type !== "session" && entry.type !== "title") { entries.set(entry.id, entry); head = entry.id; }
    }
    const seen = new Set<string>();
    let progressed = false;
    for (let id = head; id && entries.has(id) && !seen.has(id);) {
      seen.add(id);
      const entry = entries.get(id)!;
      const message = entry.type === "message" ? entry.message : undefined;
      if (message?.role === "user" && (JSON.stringify(message.content) ?? "").includes(marker)) return progressed ? "started" : "sent";
      if (message?.role === "assistant" || message?.role === "toolResult") progressed = true;
      id = entry.parentId;
    }
    return null;
  } finally { await file.close(); }
}
