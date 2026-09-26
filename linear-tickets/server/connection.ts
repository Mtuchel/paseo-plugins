import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { record } from "./context";
import { paseoHome } from "./ticket-mcp";

// Paseo hands the plugin a daemon connection only inside hooks and handlers. After a reload with
// no agent activity none arrives, so Linear replies (approvals, answers) would wait indefinitely.
// This opens the plugin's own connection to a local, password-free TCP daemon instead.
export async function ownConnection(): Promise<PaseoClient | null> {
  const config = record(JSON.parse(await readFile(join(paseoHome(), "config.json"), "utf8").catch(() => "{}")));
  const daemon = record(config.daemon);
  if (daemon.password || daemon.auth) return null;
  const listen = typeof daemon.listen === "string" ? daemon.listen : "127.0.0.1:6767";
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(listen)) return null;
  const client = createPaseoClient({ url: `ws://${listen}/ws`, clientId: "linear-tickets-plugin", connectTimeoutMs: 5_000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    console.error(`[linear-tickets] own daemon connection failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
