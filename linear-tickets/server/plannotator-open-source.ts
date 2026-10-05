// The PLANNOTATOR_BROWSER hook, run by the daemon's own Node runtime (see plannotator.ts).
// Plannotator calls it with the review URL (http://localhost:<port>/…). It
//   1. publishes the port inside the tailnet with `tailscale serve` (HTTPS, tailnet-only),
//   2. records {agent, local URL, tailnet URL} as an event for the linear-tickets plugin, whose
//      bridge opens the review on this machine unless the risk policy approves it first.
// When the event cannot be recorded, the hook opens the review itself (the normal desktop behaviour).
// The plugin's ReviewLinks (review-links.ts) removes the route once the review server stops.
// It must exit quickly and never fail loudly: Plannotator only needs "a browser was opened".
export const PLANNOTATOR_OPEN_SOURCE = String.raw`import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EVENTS = process.env.LINEAR_TICKETS_PLANNOTATOR_EVENTS;

// The two env overrides exist for tests.
function tailscale() {
  if (process.env.LINEAR_TICKETS_TAILSCALE) return process.env.LINEAR_TICKETS_TAILSCALE;
  for (const candidate of ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "tailscale";
}

function localPort(url) {
  const match = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})(\/[^\s]*)?$/.exec(url);
  return match ? { port: Number(match[1]), path: match[2] ?? "" } : null;
}

function openLocally(url) {
  const opener = process.env.LINEAR_TICKETS_OPENER || (process.platform === "darwin" ? "open" : "xdg-open");
  // A missing opener fails asynchronously; without a listener the error would end the hook loudly.
  try { spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch {}
}

function publish(port) {
  const output = execFileSync(tailscale(), ["serve", "--bg", "--https=" + port, "http://127.0.0.1:" + port], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  const found = output.match(new RegExp("https://[^\\s/]+:" + port + "\\b"));
  return found ? found[0] : null;
}

function record(event) {
  if (!EVENTS) return false;
  mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
  const name = Date.now() + "-" + randomUUID() + ".json";
  const temporary = join(EVENTS, "." + name + ".tmp");
  writeFileSync(temporary, JSON.stringify(event), { mode: 0o600 });
  renameSync(temporary, join(EVENTS, name));
  return true;
}

const url = process.argv[2];
if (url) {
  let remoteUrl = null;
  const local = localPort(url);
  if (local) {
    try {
      const origin = publish(local.port);
      if (origin) remoteUrl = origin + local.path;
    } catch {}
  }
  let recorded = false;
  try {
    recorded = record({ type: "opened", agentId: process.env.PASEO_AGENT_ID ?? null, localUrl: url, remoteUrl, at: new Date().toISOString() });
  } catch {}
  if (!recorded) openLocally(url);
}
`;
