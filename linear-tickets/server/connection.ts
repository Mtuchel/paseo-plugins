import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { DaemonClient, type DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { ModelSetter } from "./model-guard";
import { record } from "./context";
import { paseoHome } from "./ticket-mcp";

// Paseo hands the plugin a daemon connection only inside hooks and handlers. After a reload with
// no agent activity none arrives, so Linear replies (approvals, answers) would wait indefinitely.
// This opens the plugin's own connection to the local daemon instead.
type LocalDaemon = { url: string; password?: string };

// The local daemon as the `paseo` CLI finds it: the address the running daemon recorded in
// paseo.pid (else the configured one), and the password from PASEO_PASSWORD. Loopback TCP only;
// a daemon that requires a password nobody provided is left alone.
async function localDaemon(): Promise<LocalDaemon | null> {
  const home = paseoHome();
  const config = record(JSON.parse(await readFile(join(home, "config.json"), "utf8").catch(() => "{}")));
  const lock = record(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8").catch(() => "{}")));
  const daemon = record(config.daemon);
  const password = process.env.PASEO_PASSWORD || undefined;
  if ((daemon.password || daemon.auth) && !password) return null;
  const configured = typeof lock.listen === "string" ? lock.listen : typeof daemon.listen === "string" ? daemon.listen : "127.0.0.1:6767";
  const listen = /^\d+$/.test(configured) ? `127.0.0.1:${configured}` : configured;
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(listen)) return null;
  return { url: `ws://${listen}/ws`, ...(password ? { password } : {}) };
}

export async function ownConnection(): Promise<PaseoClient | null> {
  const target = await localDaemon();
  if (!target) return null;
  const client = createPaseoClient({ ...target, clientId: "linear-tickets-plugin", connectTimeoutMs: 5_000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    console.error(`[linear-tickets] own daemon connection failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

// Calls missing from the plugin SDK retain its client's legacy subscription protocol.
// Permission submissions need their own owned-subscription connection: the 0.8.0 client's
// workspace-label subscriptions send client-assigned IDs, which that protocol rejects.
const internalClients = new Map<"general" | "permission", Promise<DaemonClient | null>>();
const connectFailures = new Map<"general" | "permission", string>();
async function daemonConnection(kind: "general" | "permission"): Promise<DaemonClient | null> {
  let connecting = internalClients.get(kind);
  if (!connecting) {
    connecting = (async () => {
      const target = await localDaemon();
      if (!target) return null;
      const client = new DaemonClient({ ...target, clientId: `linear-tickets-internal-${kind}`, connectTimeoutMs: 5_000,
        ...(kind === "permission" ? { capabilities: { owned_subscriptions: true } } : {}),
      } as DaemonClientConfig);
      try {
        await client.connect();
        connectFailures.delete(kind);
        return client;
      } catch (error) {
        await client.close().catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        if (message !== connectFailures.get(kind)) console.error(`[linear-tickets] ${kind} daemon connection failed: ${message}`);
        connectFailures.set(kind, message);
        return null;
      }
    })();
    internalClients.set(kind, connecting);
  }
  const client = await connecting;
  if (!client && internalClients.get(kind) === connecting) internalClients.delete(kind);
  return client;
}

export function internalDaemon(): Promise<DaemonClient | null> { return daemonConnection("general"); }
export function permissionDaemon(): Promise<DaemonClient | null> { return daemonConnection("permission"); }

export async function modelSetter(): Promise<ModelSetter | null> {
  const client = await internalDaemon();
  if (!client) return null;
  return {
    setModel: (agentId, modelId) => client.setAgentModel(agentId, modelId),
    setThinking: async (agentId, thinkingOptionId) => { await client.setAgentThinkingOption(agentId, thinkingOptionId); },
  };
}

export async function closeInternalDaemon(): Promise<void> {
  const connecting = [...internalClients.values()];
  internalClients.clear();
  await Promise.all(connecting.map(async (pending) => { const client = await pending.catch(() => null); await client?.close().catch(() => {}); }));
}
