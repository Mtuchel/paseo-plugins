import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import type { DecisionView } from "../shared/decision-inbox";
import type { InboxView } from "./review-page";
import { paseoHome } from "./ticket-mcp";

// The inbox transport (README, "Inbox transport"): the browser-facing inbox pages used to be
// served by the plugin itself, so every reload closed them. A separate, user-supervised process
// -- the frontdoor (inbox-frontdoor.ts, installed by tools/inbox-service-install.mjs) -- now owns
// the public loopback port 127.0.0.1:47832 and the tailnet origin :8444, while the plugin serves
// the checked inbox backend on 127.0.0.1:47834. The frontdoor reads two authenticated GET routes
// from the backend -- /_inbox/ready and /_inbox/snapshot -- and forwards the browser's existing
// mutations exactly once; it never decides anything itself (one decision authority stays in the
// plugin, see README "Decision journal").
//
// The credential is a private 0600 file both processes read, separate from the activation secret:
// it authenticates the frontdoor to the backend, nothing else. The instance id names one
// contribution of the checked backend; a mutation carries the instance it was displayed from, so
// a replaced backend refuses the action instead of receiving one composed against its predecessor.

export const INBOX_FRONTDOOR_PORT = 47_832;
export const INBOX_BACKEND_PORT = 47_834;
export const INBOX_PROTOCOL_VERSION = 1;
// Loopback-only request header both processes exchange for the private routes and forwarded
// mutations; never forwarded from a browser (the frontdoor strips caller-supplied copies).
export const INBOX_AUTH_HEADER = "x-paseo-inbox-auth";
// The checked backend instance a forwarded mutation was displayed from: the frontdoor's own fence
// header to the backend, set by the frontdoor from the page's displayed epoch, never by a caller.
export const INBOX_INSTANCE_HEADER = "x-paseo-inbox-instance";
// The browser-visible displayed epoch: the checked backend instance whose data the page is showing.
// It is not a secret and not a fence, so a page always sends the epoch it actually displayed (kept
// with its own data and drafts) and the frontdoor forwards exactly that instance.
export const INBOX_DISPLAYED_HEADER = "x-paseo-inbox-displayed";
// The approval coordinator's host-to-host routes (approval-claims.ts). Their body limit is larger
// than the 16 KB every other route keeps, on the frontdoor and the backend alike: an owner approval
// is reported with its whole footprint.
export const MAX_CLAIM_BODY_BYTES = 512_000;
export function isApprovalClaimPath(path: string): boolean {
  return path === "/api/approval-claims" || path.startsWith("/api/approval-claims/") || path.startsWith("/api/approval-claims?");
}

// starting: the listener answers but the plugin has not confirmed its checked handlers yet;
// ready: mutations are admitted; draining: teardown began, nothing new is admitted.
export type InboxBackendState = "starting" | "ready" | "draining";

// What a browser needs to know about the data it is looking at. `stale` is true whenever the
// frontdoor has not received a live snapshot from the currently ready backend -- including after
// every restart, whose disk-loaded cache is never presented as current -- and every mutation
// stays disabled while it is.
export type InboxAvailability = {
  protocolVersion: number;
  backendState: InboxBackendState | "unavailable";
  // The instance that is ready now, and the instance whose data this page is showing.
  instanceId: string | null;
  displayedInstanceId: string | null;
  capturedAt: string | null;
  lastCheckedAt: string | null;
  stale: boolean;
  readOnly: boolean;
  reason: string | null;
};

// One coherent read of the checked backend: the review inbox view (review-links.ts) and the
// browser decision view (decision-inbox.ts), with each source's own coverage errors intact.
// DecisionHost.mergeStatus travels inside decisions unchanged, including last-success checkedAt
// and collection errors. The standalone frontdoor validates it and bundles the banner renderer.
export type InboxSnapshot = {
  protocolVersion: number;
  instanceId: string;
  capturedAt: string;
  inbox: InboxView;
  decisions: DecisionView;
};

export function inboxTransportDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "inbox-transport");
}

export function backendSecretPath(home = paseoHome()): string {
  return join(inboxTransportDirectory(home), "backend-secret");
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// Constant-time comparison; both sides are hashed first so a length difference cannot leak.
export function inboxSecretsMatch(given: string | null, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// The private credential, host-local: PASEO_INBOX_SECRET when set (a host that keeps it in its
// service environment), else the file. Never logged and never returned by any route.
export async function readBackendSecret(path = backendSecretPath()): Promise<string | null> {
  const fromEnv = process.env.PASEO_INBOX_SECRET;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || null;
  } catch { return null; }
}

// Creates the credential when neither process has yet (the installer does it before cutover; the
// plugin does it when it starts the backend first). A concurrent creator loses the race and reads
// the winner's value instead of overwriting it.
export async function ensureBackendSecret(path = backendSecretPath()): Promise<string> {
  const existing = await readFile(path, "utf8").then((value) => value.trim()).catch(() => "");
  if (existing) return existing;
  const secret = randomBytes(32).toString("base64url");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, secret, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    const raced = await readFile(path, "utf8").then((value) => value.trim()).catch(() => "");
    if (raced) return raced;
    throw error;
  }
  return secret;
}
