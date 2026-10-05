import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webpush, { type PushSubscription } from "web-push";
import { z } from "zod";

// Web Push for the review inbox (README, "Review inbox"): a browser that opened the inbox and
// allowed notifications is told about every review that starts waiting, with the waiting count
// for the app icon's badge. The keys and subscriptions live in one file next to the reviews.

export type PushKeys = { publicKey: string; privateKey: string };
// What the notification says about one waiting review; `key` tells reviews apart across sweeps.
export type WaitingReview = { key: string; title: string; body: string; url: string };
export type PushMessage = { title: string; body: string; url: string; tag: string; count: number };
// Sends one message; rejects with an error whose `statusCode` is 404 or 410 when the subscription
// is gone (web-push's WebPushError).
export type PushSend = (subscription: PushSubscription, message: PushMessage, keys: PushKeys, subject: string) => Promise<void>;

// `announced`: keys of the reviews already announced; null until the first sweep, which records
// the reviews waiting then without announcing them (no burst when the inbox is first set up).
type PushFile = { keys?: PushKeys; subscriptions: PushSubscription[]; announced: string[] | null };

const MAX_SUBSCRIPTIONS = 20;
const ONE_DAY_S = 86_400;
// More new reviews than this at once arrive as one summary instead of one message each.
const MAX_SINGLE_MESSAGES = 3;

async function sendWebPush(subscription: PushSubscription, message: PushMessage, keys: PushKeys, subject: string): Promise<void> {
  await webpush.sendNotification(subscription, JSON.stringify(message), { vapidDetails: { subject, ...keys }, TTL: ONE_DAY_S, urgency: "high" });
}

// A subscription as the browser's PushSubscription.toJSON() gives it; null for anything else.
const Subscription = z.object({
  endpoint: z.string().max(2_000).regex(/^https:\/\//),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
export function pushSubscription(value: unknown): PushSubscription | null {
  const parsed = Subscription.safeParse(value);
  return parsed.success ? { endpoint: parsed.data.endpoint, keys: { p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth } } : null;
}

function subscriptionGone(error: unknown): boolean {
  const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
  return status === 404 || status === 410;
}

export class ReviewPush {
  private state: PushFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string, private readonly send: PushSend = sendWebPush) {}

  // The VAPID public key browsers subscribe with; created on first use.
  async publicKey(): Promise<string> {
    return (await this.change((state) => { state.keys ??= webpush.generateVAPIDKeys(); })).keys!.publicKey;
  }

  async subscribe(subscription: PushSubscription): Promise<void> {
    await this.change((state) => {
      state.subscriptions = [...state.subscriptions.filter((known) => known.endpoint !== subscription.endpoint), subscription].slice(-MAX_SUBSCRIPTIONS);
    });
  }

  // Announces the reviews waiting now that were not announced before; `subject` is the inbox's
  // https origin (the push services' contact). Subscriptions the push service dropped are removed.
  async announce(waiting: WaitingReview[], subject: string): Promise<void> {
    const state = await this.load();
    const keys = waiting.map((review) => review.key);
    const known = new Set(state.announced ?? keys);
    const fresh = waiting.filter((review) => !known.has(review.key));
    const unchanged = state.announced !== null && keys.length === state.announced.length && !fresh.length;
    if (unchanged) return;
    const messages: PushMessage[] = fresh.length > MAX_SINGLE_MESSAGES
      ? [{ title: `${fresh.length} new plan reviews`, body: fresh.map((review) => review.title).join(", "), url: "/", tag: "reviews", count: waiting.length }]
      : fresh.map((review) => ({ title: review.title, body: review.body, url: review.url, tag: review.key, count: waiting.length }));
    const gone = new Set<string>();
    if (state.keys) {
      for (const subscription of state.subscriptions) {
        for (const message of messages) {
          try { await this.send(subscription, message, state.keys, subject); } catch (error) {
            if (subscriptionGone(error)) { gone.add(subscription.endpoint); break; }
            console.error(`[linear-tickets] a review notification failed: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }
    await this.change((next) => {
      next.announced = keys;
      next.subscriptions = next.subscriptions.filter((subscription) => !gone.has(subscription.endpoint));
    });
  }

  private async load(): Promise<PushFile> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<PushFile>;
      const keys = parsed.keys && typeof parsed.keys.publicKey === "string" && typeof parsed.keys.privateKey === "string" ? parsed.keys : undefined;
      this.state = {
        ...(keys ? { keys } : {}),
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions.flatMap((raw) => pushSubscription(raw) ?? []) : [],
        announced: Array.isArray(parsed.announced) ? parsed.announced.filter((key): key is string => typeof key === "string") : null,
      };
    } catch { this.state = { subscriptions: [], announced: null }; }
    return this.state;
  }

  // Serialised read-modify-write; the private key never leaves this 0600 file.
  private change(mutate: (state: PushFile) => void): Promise<PushFile> {
    const next = this.queue.then(async () => {
      const state = await this.load();
      mutate(state);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
      return state;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
