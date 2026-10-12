// The installed, supervised entry point of the persistent inbox frontdoor (README, "Inbox
// transport"). tools/inbox-service-install.mjs builds this file into a versioned standalone bundle
// together with the modules it imports, writes the protected configuration it reads here, and
// supervises `node <this file> <config.json>` with launchd or systemd --user:
//
//   node inbox-frontdoor.mjs <config.json>   run until SIGTERM/SIGINT
//   node inbox-frontdoor.mjs --check         render both pages from a synthetic snapshot and
//                                            print the fingerprint (the installer's own proof
//                                            that the built artifact runs)
//
// The configuration is pinned by absolute paths and validated here; a bad one exits non-zero with
// the reason, and so does a listener whose port the current owner still holds (the frontdoor never
// kills or displaces it).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { decisionPage } from "./decision-page";
import { startInboxFrontdoor } from "./inbox-frontdoor";
import { INBOX_PROTOCOL_VERSION } from "./inbox-transport";
import { inboxPage } from "./review-page";

const configSchema = z.object({
  version: z.literal(1),
  // Informational, written by the installer: the version directory this bundle was installed
  // from and the host/toolchain that staged it. Pinned paths below are what the frontdoor uses.
  bundle: z.string().optional(),
  host: z.string().optional(),
  node: z.string().optional(),
  installedVersion: z.string().optional(),
  installedAt: z.string().optional(),
  publicOrigin: z.string().min(1),
  loopbackPort: z.number().int().min(1).max(65_535).optional(),
  backendPort: z.number().int().min(1).max(65_535).optional(),
  stateDirectory: z.string().min(1),
  credentialFile: z.string().min(1).optional(),
  timeZone: z.string().optional(),
}).strict();

// Both pages, rendered in-process: the installer runs this before it stages the bundle, so a
// broken build is never installed. The digest covers the whole presentation, not just module load.
function selfCheck(): void {
  const now = new Date("2026-01-02T03:04:05.000Z");
  const availability = { protocolVersion: INBOX_PROTOCOL_VERSION, backendState: "unavailable" as const, instanceId: null, displayedInstanceId: null, capturedAt: null, lastCheckedAt: null, stale: true, readOnly: true, reason: "self-check" };
  const review = inboxPage({ open: [], decided: [], applying: [], unreachable: [], hosts: [], push: false }, now, "UTC", availability);
  const decisions = decisionPage({ hosts: [], canonicalHost: null, unreachable: [] }, availability);
  console.log(JSON.stringify({ protocolVersion: INBOX_PROTOCOL_VERSION, reviewBytes: review.length, decisionBytes: decisions.length, digest: createHash("sha256").update(review).update(decisions).digest("hex").slice(0, 16) }));
}

async function main(): Promise<void> {
  const [first] = process.argv.slice(2);
  if (first === "--check") { selfCheck(); return; }
  const configPath = first ?? process.env.INBOX_FRONTDOOR_CONFIG;
  if (!configPath) {
    console.error("usage: inbox-frontdoor.mjs <config.json> | --check");
    process.exitCode = 64;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    console.error(`[inbox-frontdoor] reading ${configPath} failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 78;
    return;
  }
  const config = configSchema.safeParse(parsed);
  if (!config.success) {
    console.error(`[inbox-frontdoor] ${configPath} is not a valid inbox frontdoor configuration: ${config.error.issues.map((issue) => `${issue.path.join(".") || "config"} ${issue.message}`).join("; ")}`);
    process.exitCode = 78;
    return;
  }
  const frontdoor = await startInboxFrontdoor({
    port: config.data.loopbackPort,
    backendPort: config.data.backendPort,
    publicOrigin: config.data.publicOrigin,
    stateDirectory: config.data.stateDirectory,
    ...(config.data.credentialFile ? { credentialFile: config.data.credentialFile } : {}),
    ...(config.data.timeZone ? { timeZone: config.data.timeZone } : {}),
  });
  console.log(`[inbox-frontdoor] listening on 127.0.0.1:${frontdoor.port} for ${config.data.publicOrigin}, reading the checked inbox backend on 127.0.0.1:${config.data.backendPort ?? 47_834}`);
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[inbox-frontdoor] ${signal}: closing`);
    void frontdoor.close().then(() => process.exit(0), (error: unknown) => {
      console.error(`[inbox-frontdoor] closing failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

await main().catch((error: unknown) => {
  console.error(`[inbox-frontdoor] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
