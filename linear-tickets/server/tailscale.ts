import { existsSync } from "node:fs";

// The daemon's PATH rarely includes Tailscale's CLI, so the usual install locations come first.
export function tailscaleBinary(): string {
  for (const candidate of ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "tailscale";
}
