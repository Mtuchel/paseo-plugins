import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createTurnMonitor } from "./server/turn";

export default function contribute(server: PluginServerContext) {
  const monitor = createTurnMonitor();

  server.on("agent.turn_started", (event) => monitor.turnStarted(event));
  server.on("agent.turn_ended", (event, { paseo }) =>
    monitor.turnEnded(event, (agentId, text) => paseo.agents.ref(agentId).send(text)),
  );

  return () => monitor.close();
}