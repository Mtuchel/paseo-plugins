import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import { paseoHome } from "./ticket-mcp";

// Draining a host (README, "Draining a host"): the small protocol two hosts use to move new
// Linear work from the host that is being drained to the host that keeps working.
//
// The draining host keeps its Linear app, its threads and its running agents. Every new automatic
// activation for a ticket it does not own (a new session, an @paseo or thread reply, a comment on
// a thread, the trigger label, a pull-request successor or a parked plan's approval) is written to
// a durable outbox and POSTed to the peer's `/activation`. The peer persists it, deduplicates it
// by the original action id and starts or answers through its normal admission, scheduler and
// launcher paths.
//
// The draining host also registers the agents it may keep running as claims (`/activation/claims`,
// one full snapshot with a monotonic revision). The peer holds them durably and fails closed for
// those tickets -- a native activation for a claimed ticket is deferred or delivered to its owner
// there, never started twice -- while every unclaimed ticket starts without contacting the
// draining host at all (it may be asleep). When a claim's agent finishes, the next snapshot no
// longer lists it, which releases it.
//
// Nothing is decided on unreadable state. A host that cannot read its own allowlist, claims or
// queue holds the activation durably and tells the owner why; it never forwards on a guess and
// never starts locally as a fallback.
//
// Both hosts read the same shared secret from a 0600 file next to the plugin's settings
// (`activation-secret`); it never goes into settings.json, the settings UI or a log.

export const ACTIVATION_HEADER = "x-paseo-activation";
// One prompt or comment, carried whole: Linear bodies and the plugin's own successor leads stay
// well below this, and anything longer is refused with its size instead of being clipped (the
// original prompt is what the receiving host starts from).
export const MAX_ACTIVATION_TEXT = 120_000;
// What the review service accepts on the activation routes only: an envelope with the longest
// text plus a handover note (review-links.ts keeps its smaller limit for every other route).
export const MAX_ACTIVATION_BODY_BYTES = 512_000;
const DELIVER_TIMEOUT_MS = 8_000;

export function activationDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets");
}

// The shared secret, host-local: PASEO_ACTIVATION_SECRET when set (for a host that keeps it in its
// service environment), else the file. Never logged, never returned by a settings read.
export function activationSecretPath(home = paseoHome()): string {
  return join(activationDirectory(home), "activation-secret");
}

export async function readActivationSecret(path = activationSecretPath()): Promise<string | null> {
  const fromEnv = process.env.PASEO_ACTIVATION_SECRET;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || null;
  } catch { return null; }
}

export async function writeActivationSecret(secret: string | null, path = activationSecretPath()): Promise<void> {
  const value = secret?.trim() ?? "";
  if (!value) {
    await rm(path, { force: true });
    return;
  }
  if (value.length > 500) throw new Error("The activation secret is limited to 500 characters.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

// Constant-time comparison; both sides are hashed first so a length difference cannot leak.
export function secretsMatch(given: string | null, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// The action ids the two hosts deduplicate by: the original Linear session, activity, comment,
// label or pull-request action. Both hosts build them the same way (`<kind>:<original id>`, so
// `session:<id>`, `activity:<id>`, `comment:<id>`, `label:<issue id>:<label>:<occurrence>`), and
// the pull-request successor's also hashes the message, so the same activation arriving natively
// on the peer and forwarded by the draining host is started once. A label has no immutable source
// id, so the draining host adds the occurrence it saw (`occurrenceFor` in drain.ts) and only a
// label that is added again after the previous occurrence was acknowledged is a new activation.
export function recoverActivationId(issueId: string, predecessorId: string | null, lead: string): string {
  return `recover:${issueId}:${predecessorId ?? "none"}:${createHash("sha256").update(lead).digest("hex").slice(0, 16)}`;
}

export const activationKindSchema = z.enum(["session", "reply", "ticket", "recover"]);
export type ActivationKind = z.infer<typeof activationKindSchema>;
// What travelling to another host may carry about the branch work continues on. Only the branch
// name, the commit it is expected at and whether the draining host had uncommitted changes: a
// receiving host never walks into another host's worktree path, and it blocks (with the handover
// note) rather than picking an unrelated branch or pretending missing work was copied.
export const resumeSchema = z.object({
  branch: z.string().max(250).nullable(),
  commit: z.string().max(100).nullable().optional(),
  dirty: z.boolean().nullable().optional(),
  handover: z.string().max(MAX_ACTIVATION_TEXT).nullable(),
});
export type ActivationResume = z.infer<typeof resumeSchema>;
// What a start path asks the activation routing (sessions.ts, dispatch.ts, relay.ts): the original
// action is named (`id`, or its parts) so both hosts deduplicate by it. `text` is the owner's
// message, `strictResume` forbids a fresh branch (pull-request successors), `resume` is the
// draining host's handover snapshot, `watchdog` the ticket's recovery history (watchdog.ts) when
// the caller already snapshotted it; else the router reads it itself.
export type ActivationRequest = {
  kind: ActivationKind;
  issueId: string;
  identifier: string;
  sessionId?: string;
  activityId?: string;
  id?: string;
  label?: string;
  text?: string;
  strictResume?: boolean;
  resume?: ActivationResume;
  watchdog?: unknown;
};
// What a start path gets back: `{ peer }` -- handed over, the caller starts nothing; `null` --
// stays on this host; `{ held }` -- nothing started anywhere, because this host could not confirm
// that it still owns the ticket or because the peer has not acknowledged its claims yet. A held
// request is durably queued and retried, so the caller tells the owner and never starts locally.
export type ActivationTake = { peer: string } | { held: string } | null;
// The seam every automatic start path calls before it starts.
export type ActivationSink = {
  take(request: ActivationRequest): Promise<ActivationTake>;
};
// One activation: what the owner asked for, preserved whole. `text` is the original prompt or
// message (it becomes the successor's lead, or is delivered to a live agent); `strictResume`
// forbids a fresh branch when the recorded one cannot be continued (`recover`).
export const activationEnvelopeSchema = z.object({
  id: z.string().min(1).max(300),
  kind: activationKindSchema,
  issueId: z.string().min(1).max(100),
  identifier: z.string().min(1).max(100),
  sessionId: z.string().max(100).optional(),
  text: z.string().max(MAX_ACTIVATION_TEXT).optional(),
  // The trigger label a ticket activation carried, so the receiving host claims the same one.
  label: z.string().max(80).optional(),
  strictResume: z.boolean().optional(),
  resume: resumeSchema.optional(),
  // The ticket's watchdog history (watchdog.ts, WatchdogHistory), opaque here: the receiving host
  // parses it and treats an unknown or missing one as unknown history, so a newer or older peer
  // never makes the envelope itself invalid.
  watchdog: z.unknown().optional(),
  host: z.string().min(1).max(100),
  requestedAt: z.string().max(40),
});
export type ActivationEnvelope = z.infer<typeof activationEnvelopeSchema>;

export const claimsSyncSchema = z.object({
  host: z.string().min(1).max(100),
  // Changes when the draining host is seeded again, so a restarted counter is not read as stale.
  seed: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
  claims: z.array(z.object({ issueId: z.string().min(1).max(100), identifier: z.string().min(1).max(100), agentId: z.string().min(1).max(100) })).max(500),
});
export type ClaimsSync = z.infer<typeof claimsSyncSchema>;

// One message to the live agent a ticket has on the other host. `receipt` is the activation id it
// belongs to (or another stable id the sender reuses on every retry), so a response lost on the
// way does not deliver the same message twice. Delivery itself is at-least-once: a crash between
// the daemon call and the receipt leaves the sender retrying, which may repeat the message.
export const deliverRequestSchema = z.object({
  issueId: z.string().min(1).max(100),
  text: z.string().min(1).max(MAX_ACTIVATION_TEXT),
  receipt: z.string().min(1).max(300),
});
export type DeliverRequest = z.infer<typeof deliverRequestSchema>;

export type ActivationResult = { status: number; body: string };
export function activationJson(status: number, value: unknown): ActivationResult {
  return { status, body: JSON.stringify(value) };
}

// The tailnet review service (review-links.ts) hands every /activation* request to these routes,
// which authenticate it themselves (activation-endpoints.ts). Null: not an activation route.
export type ActivationRouteRequest = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
export type ActivationRouteResult = { status: number; headers?: Record<string, string>; body: string };
export type ActivationRoute = (request: ActivationRouteRequest) => Promise<ActivationRouteResult | null>;

export function isActivationPath(path: string): boolean {
  return path === "/activation" || path.startsWith("/activation/") || path.startsWith("/activation?");
}

// The text one activation carries. An empty message is nothing to send; a message past the
// protocol maximum is refused here, with its length, so no caller forwards (or starts from) a
// quietly shortened prompt.
export function activationText(text: string | null | undefined): string | undefined {
  const value = text?.trim();
  if (!value) return undefined;
  if (value.length > MAX_ACTIVATION_TEXT) {
    throw new Error(`The message is ${value.length} characters, more than the ${MAX_ACTIVATION_TEXT} an activation can carry; it was not changed or truncated.`);
  }
  return value;
}

export type RequestLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

// POSTs one JSON body to a peer's activation service. Throws with the peer's own words when it
// refuses; the callers keep their work pending instead of starting anything locally.
export async function postToPeer(request: RequestLike, origin: string, path: string, secret: string, body: unknown, timeoutMs = DELIVER_TIMEOUT_MS): Promise<unknown> {
  const response = await request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [ACTIVATION_HEADER]: secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let reason = text.slice(0, 300);
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") reason = parsed.error;
    } catch { /* not JSON */ }
    throw new Error(`${new URL(origin).hostname} refused it (HTTP ${response.status}${reason ? `: ${reason}` : ""}).`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

// One small JSON file owned by the plugin: loaded once, written atomically (0600) after every
// change, shared by the outbox, the allowlist, the claims and the pending queue. Every caller
// brings its own reader, so a file from an older version is parsed at the boundary.
//
// A file that is missing starts from `initial`; a file that cannot be read or parsed throws, and
// so does a change that could not be written. A caller therefore never decides on a silently
// emptied state (the claims of a draining host, the queued activations) and never treats a change
// as recorded when it only exists in memory.
export class JsonFile<T> {
  private value: T | null = null;
  private loading: Promise<T> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string, private readonly initial: () => T, private readonly parse: (raw: unknown) => T) {}

  // One read per file per process, shared by concurrent callers. Only `ENOENT` starts from
  // `initial`; a read or parse failure rejects and is retried by the next caller.
  load(): Promise<T> {
    if (this.value) return Promise.resolve(this.value);
    this.loading ??= readFile(this.path, "utf8").then((text) => {
      let parsed: T;
      try { parsed = this.parse(JSON.parse(text)); }
      catch (error) {
        this.loading = null;
        throw new Error(`${this.path} is not usable: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      return (this.value = parsed);
    }, (error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") return (this.value = this.initial());
      this.loading = null;
      throw new Error(`${this.path} could not be read: ${error?.message ?? "unknown error"}`);
    });
    return this.loading;
  }

  // Serialised read-modify-write, so two changes cannot drop each other. The change lands on a
  // copy and the cached value is replaced only after the file was renamed over the old one.
  update(mutate: (value: T) => void): Promise<T> {
    const run = async () => {
      const current = await this.load();
      const next = structuredClone(current);
      mutate(next);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      this.value = next;
      return next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
