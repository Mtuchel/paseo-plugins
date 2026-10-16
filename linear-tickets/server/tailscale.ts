import { execFile } from "./child-processes";
import { existsSync } from "node:fs";

// The daemon's PATH rarely includes Tailscale's CLI, so the usual install locations come first.
export function tailscaleBinary(): string {
  for (const candidate of ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "tailscale";
}

// This host's tailnet origin for the review service, `https://<machine>.<tailnet>.ts.net:8444`,
// read from Tailscale itself. The persistent inbox frontdoor publishes that port (the installer
// runs `tailscale serve`; never Funnel); the plugin only derives the URL its links are written
// with, so the review link a Linear comment carries keeps working across reloads.
export async function tailnetOrigin(port = 8444): Promise<string | null> {
  try {
    const { stdout } = await execFile(tailscaleBinary(), ["status", "--json"], { timeout: 8_000 });
    const self = JSON.parse(stdout) as { Self?: { DNSName?: unknown } };
    const dns = String(self.Self?.DNSName ?? "").replace(/\.$/, "");
    return dns ? `https://${dns}:${port}` : null;
  } catch { return null; }
}
