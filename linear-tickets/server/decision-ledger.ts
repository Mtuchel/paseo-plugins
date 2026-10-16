import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { decisionReceiptSchema, type DecisionReceipt } from "../shared/contracts";
import { needsYouIssueSchema } from "./needs-you";

const decisionRecordSchema = z.object({
  receipt: decisionReceiptSchema,
  sourceId: z.string().optional(),
  sourceHash: z.string().optional(),
  // Material title/parent/ticket/source scope, independent of unrelated timeline progress.
  sourceScope: z.string().optional(),
  result: z.object({ delivered: z.enum(["agent", "continued", "queued", "comment", "closed", "local"]), message: z.string() }).nullable(),
  disposition: z.enum(["research", "delegated", "deferred"]).nullable(),
  deferredUntil: z.string().datetime().nullable(),
  comment: z.object({ issueId: z.string(), body: z.string(), done: z.boolean() }).nullable(),
  close: z.object({
    issueId: z.string(), needsYou: z.boolean(), done: z.boolean(),
    completed: z.boolean().optional(),
    tracking: needsYouIssueSchema.nullable().optional(),
  }).nullable(),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
const ledgerSchema = z.object({ version: z.literal(1), records: z.record(z.string(), decisionRecordSchema) });

// Persist the reservation before any external action. A crash in the external-send window is
// explicitly unconfirmed, never automatically retried into a possibly different live question.
// Completed sends are committed before optional Linear effects, which can be retried separately.
export class DecisionLedger {
  private records: Record<string, DecisionRecord> = {};
  private loaded: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work, work);
    this.tail = task.catch(() => {});
    return task;
  }

  async load(): Promise<void> {
    if (!this.loaded) this.loaded = this.read().catch((error: unknown) => { this.loaded = null; throw error; });
    return this.loaded;
  }

  private async read(): Promise<void> {
    let raw: string;
    try { raw = await readFile(join(this.directory, "decisions.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    this.records = ledgerSchema.parse(JSON.parse(raw)).records;
  }

  get(id: string): DecisionRecord | undefined { return this.records[id]; }

  latest(issueId: string, revision: string): DecisionRecord | undefined {
    return Object.values(this.records).reverse().find((record) => record.receipt.issueId === issueId && record.receipt.revision === revision);
  }

  // Never carry consent across material scope changes. Legacy body-only receipts can
  // conservatively retain an unknown-delivery fence, but cannot approve another revision.
  forSource(issueId: string, sourceId: string, sourceHash: string, sourceScope: string): DecisionRecord | undefined {
    return Object.values(this.records).reverse().find(record => record.receipt.issueId === issueId && record.sourceId === sourceId && record.sourceHash === sourceHash
      && (record.sourceScope === sourceScope || (record.sourceScope === undefined && record.result === null)));
  }

  history(): DecisionReceipt[] {
    return Object.values(this.records).filter((record) => record.result).reverse()
      .sort((a, b) => b.receipt.at.localeCompare(a.receipt.at)).slice(0, 100).map((record) => record.receipt);
  }

  async put(id: string, record: DecisionRecord): Promise<void> {
    const records = { ...this.records, [id]: decisionRecordSchema.parse(record) };
    const path = join(this.directory, "decisions.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, records })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.records = records;
    } finally { await rm(temporary, { force: true }); }
  }
}
