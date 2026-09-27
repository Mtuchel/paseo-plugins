import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { DaemonClient, type DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { ModelSetter } from "./model-guard";
import { record } from "./context";
import { paseoHome } from "./ticket-mcp";

// Paseo hands the plugin a daemon connection only inside hooks and handlers. After a reload with
// no agent activity none arrives, so Linear replies (approvals, answers) would wait indefinitely.
// This opens the plugin's own connection to a local, password-free TCP daemon instead.
// The local daemon's WebSocket, when it listens on loopback without a password.
async function localDaemonUrl(): Promise<string | null> {
  const config = record(JSON.parse(await readFile(join(paseoHome(), "config.json"), "utf8").catch(() => "{}")));
  const daemon = record(config.daemon);
  if (daemon.password || daemon.auth) return null;
  const listen = typeof daemon.listen === "string" ? daemon.listen : "127.0.0.1:6767";
  return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(listen) ? `ws://${listen}/ws` : null;
}

export async function ownConnection(): Promise<PaseoClient | null> {
  const url = await localDaemonUrl();
  if (!url) return null;
  const client = createPaseoClient({ url, clientId: "linear-tickets-plugin", connectTimeoutMs: 5_000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    console.error(`[linear-tickets] own daemon connection failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

// Model and thinking changes for ticket agents. The plugin SDK has no call for them, so this uses
// the daemon client the SDK is built on, over the same local password-free connection.
let setterClient: Promise<DaemonClient | null> | null = null;
export async function modelSetter(): Promise<ModelSetter | null> {
  setterClient ??= (async () => {
    const url = await localDaemonUrl();
    if (!url) return null;
    const client = new DaemonClient({ url, clientId: "linear-tickets-model-guard", connectTimeoutMs: 5_000 } as DaemonClientConfig);
    try { await client.connect(); return client; } catch (error) {
      console.error(`[linear-tickets] model guard connection failed: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  })();
  const client = await setterClient;
  if (!client) { setterClient = null; return null; }
  return {
    setModel: (agentId, modelId) => client.setAgentModel(agentId, modelId),
    setThinking: async (agentId, thinkingOptionId) => { await client.setAgentThinkingOption(agentId, thinkingOptionId); },
  };
}

export async function closeModelSetter(): Promise<void> {
  const client = await setterClient?.catch(() => null);
  setterClient = null;
  await client?.close().catch(() => {});
}
