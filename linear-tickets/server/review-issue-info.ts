import { areaLabels, type AreaLabels } from "./area-labels";
import { UUID, type LinearService } from "./linear";

export type ReviewIssueInfo = { issueId: string; areas: string[] };
type Reader = Pick<LinearService, "issueState" | "labelCatalog">;
type Entry = { value: ReviewIssueInfo | null; expiresAt: number; retryAt: number };
const TTL = 5 * 60_000;
const FAILURE_DELAY = 30_000;
const MAX_ENTRIES = 500;
const IDENTIFIER = /^[A-Z][A-Z0-9_]*-\d+$/;

// Optional inbox metadata must not make the inbox unavailable. Only fresh reads may authorize
// deletion: a cached UUID can belong to an issue whose identifier changed since the last read.
export class ReviewIssueInfos {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<ReviewIssueInfo | null>>();
  private readonly freshPending = new Map<string, Promise<ReviewIssueInfo | null>>();
  private catalog: { areasOf: AreaLabels; expiresAt: number } | null = null;
  private catalogPending: Promise<AreaLabels> | null = null;
  private catalogRetryAt = 0;

  constructor(private readonly linear: Reader, private readonly now: () => number = Date.now) {}

  async forIdentifier(identifier: string, options: { fresh?: boolean } = {}): Promise<ReviewIssueInfo | null> {
    const key = identifier.trim().toUpperCase();
    if (!IDENTIFIER.test(key)) return null;
    const fresh = options.fresh === true;
    const refreshing = this.freshPending.get(key);
    if (refreshing) return refreshing;
    if (!fresh) {
      const cached = this.cache.get(key);
      if (cached && (cached.expiresAt > this.now() || cached.retryAt > this.now())) return cached.value;
    }
    // A fresh read waits for older enrichment before revalidating, so the older answer cannot
    // overwrite a newly discovered identifier mismatch.
    const pending = fresh ? this.freshPending : this.pending;
    const running = pending.get(key);
    if (running) return running;
    const read = (fresh
      ? Promise.resolve(this.pending.get(key)).then(() => this.read(key, true))
      : this.read(key, false)).finally(() => { pending.delete(key); });
    pending.set(key, read);
    return read;
  }

  private save(key: string, entry: Entry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private async read(key: string, fresh: boolean): Promise<ReviewIssueInfo | null> {
    try {
      const state = await this.linear.issueState(key);
      if (state.identifier !== key || !UUID.test(state.id)) {
        this.save(key, { value: null, expiresAt: this.now() + TTL, retryAt: 0 });
        return null;
      }
      const areasOf = await this.areasOf(fresh);
      const value = { issueId: state.id, areas: areasOf(state.labels) };
      this.save(key, { value, expiresAt: this.now() + TTL, retryAt: 0 });
      return value;
    } catch {
      const previous = this.cache.get(key);
      this.save(key, { value: previous?.value ?? null, expiresAt: previous?.expiresAt ?? 0, retryAt: this.now() + FAILURE_DELAY });
      return fresh ? null : previous?.value ?? null;
    }
  }

  private async areasOf(fresh: boolean): Promise<AreaLabels> {
    if (this.catalog && this.catalog.expiresAt > this.now()) return this.catalog.areasOf;
    if (this.catalogPending) return this.catalogPending;
    if (!fresh && this.catalogRetryAt > this.now()) throw new Error("Linear label catalog refresh is throttled.");
    const read = this.linear.labelCatalog().then((catalog) => {
      const areasOf = areaLabels(catalog);
      this.catalog = { areasOf, expiresAt: this.now() + TTL };
      this.catalogRetryAt = 0;
      return areasOf;
    }).catch((error: unknown) => {
      this.catalogRetryAt = this.now() + FAILURE_DELAY;
      throw error;
    }).finally(() => { this.catalogPending = null; });
    this.catalogPending = read;
    return read;
  }
}
