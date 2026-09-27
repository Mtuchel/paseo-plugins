import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tailscaleBinary } from "./tailscale";

const exec = promisify(execFile);
export const FUNNEL_PORT = 8443;
export const FUNNEL_PATH = "/linear/agent";

export type FunnelStatus = { active: boolean; url: string | null; note: string | null };

// Publishes only the webhook path on :8443. Never :443 — that port carries tailnet-only routes
// that must not become public. Idempotent: re-running with the same target changes nothing.
export async function ensureFunnel(localPort: number): Promise<FunnelStatus> {
  try {
    const { stdout, stderr } = await exec(tailscaleBinary(), ["funnel", "--bg", `--https=${FUNNEL_PORT}`, `--set-path`, FUNNEL_PATH, `http://127.0.0.1:${localPort}`], { timeout: 12_000 });
    const output = `${stdout}\n${stderr}`;
    if (/not enabled/i.test(output)) return { active: false, url: null, note: "Funnel is not enabled for this tailnet." };
    const url = output.match(/https:\/\/\S+:8443\S*/)?.[0] ?? null;
    return { active: true, url, note: null };
  } catch (error) {
    // `tailscale funnel` waits for approval when Funnel is not allowed yet; the timeout lands here.
    return { active: false, url: null, note: error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "tailscale funnel failed" };
  }
}
