import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readTurnTimeline } from "./server/timeline";
import { createTurnMonitor } from "./server/turn";

export default function contribute(server: PluginServerContext) {
  const monitor = createTurnMonitor();

  server.addHook("agent.turn.before", (event) => monitor.turnStarted(event));
  server.addHook("agent.turn.after", (event, { paseo }) =>
    monitor.turnEnded(event, {
      send: (agentId, text) => paseo.agents.ref(agentId).send(text),
      readTimeline: (agentId, turnId) => readTurnTimeline(paseo.agents.ref(agentId).timeline, turnId),
    }),
  );

  return () => monitor.close();
}
