import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LinearTicketsSurface } from "./client/linear-tickets";
import { AgentLinearTicketPanel } from "./client/agent-ticket";
import { installLinearAgentBadges } from "./client/agent-badges";
import { PlannotatorRow, plannotatorRowSchema } from "./client/plannotator-row";

export default function contribute(client: PluginClientContext) {
  client.addSurface("linear-tickets", LinearTicketsSurface);
  client.addWorkspacePanel({ id: "linear-ticket", title: "Linear ticket", icon: "SquareKanban", context: "agent", locations: ["workspace", "explorer"], Component: AgentLinearTicketPanel });
  const removeAgentBadges = installLinearAgentBadges(client);
  // Must match PLANNOTATOR_KIND in server/plannotator.ts.
  client.addTimelineRenderer({ kind: "plannotator", version: 1, schema: plannotatorRowSchema, Component: PlannotatorRow });
  // Sidebar and Command Center icons must be Lucide names: the host validates them with
  // resolvePluginIcon() and rejects anything else, so the Linear brand mark (used inside the
  // surface) cannot be rendered here. SquareKanban is the closest Lucide stand-in.
  client.addSidebarItem({ id: "linear-tickets", title: "Linear tickets", icon: "SquareKanban", surface: "linear-tickets" });
  client.addCommandCenterItem({
    id: "open-linear-tickets", title: "Open assigned Linear tickets", icon: "SquareKanban", context: "global",
    onSelect({ openSurface }) { openSurface("linear-tickets"); },
  });
  client.addCommandCenterItem({
    id: "open-linked-linear-ticket", title: "Open linked Linear ticket", icon: "SquareKanban", context: "agent", keywords: ["linear", "issue", "ticket"],
    onSelect({ openPanel }) { openPanel("linear-ticket"); },
  });
  return removeAgentBadges;
}
