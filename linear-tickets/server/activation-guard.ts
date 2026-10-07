import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { ActivationIntake } from "./activation-intake";
import type { DrainRouter } from "./drain";
import type { HostOwnership } from "./sessions";
import type { Settings } from "./settings";

// The resume guard (README, "Draining a host"): this host's Paseo asks before it opens a stopped
// agent's session (the plugin SDK's `server.before("agent.session_open")`). While this host
// drains, an interactive resume of a ticket root that no longer owns its ticket is refused, so a
// Linear heartbeat, a schedule or an internal actor cannot wake a retired agent here, and no
// second root is started beside the peer's. Reading a thread (`purpose: "history"`), brand-new
// agents (`create`) and agents that are not ticket roots at all -- ordinary Desktop chats -- pass
// untouched. A refusal throws with the reason; the sender keeps its prompt, and the host reports
// the failed open.
export type ResumeGuardDeps = {
  settings: Pick<Settings, "read">;
  // The guard only needs the ticket's name; the drain's fuller record is assignable.
  drain: Pick<DrainRouter, "holdsAgent"> & { agentTicket: (agentId: string) => Promise<{ identifier: string } | null> };
  // Other records of ticket agents (the session store), for roots this host's allowlist does not
  // name: still recognized, so a heartbeat to an old agent is refused instead of resurrected.
  known?: (agentId: string) => Promise<{ identifier: string } | null>;
  // Hands the hook's daemon connection to the plugin before the question is decided, so a resume
  // right after a reload (a daemon restart restoring the grandfathered agents) is judged on the
  // live agents, not on a connection that has not been attached yet.
  attach?: (paseo: PaseoApi) => void;
  // Waits for the drain to have read its allowlist, so the very first resume after a deployment
  // is not refused just because the seed was still being written.
  ready?: () => Promise<void>;
  log?: (message: string) => void;
};

export function resumeGuard(deps: ResumeGuardDeps): (input: { request: PluginSessionOpenRequest }, context: { paseo: PaseoApi }) => Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(`[linear-tickets] ${message}`));
  return async ({ request }, context) => {
    if (request.reason !== "resume" || request.purpose !== "interactive") return;
    const { mode, peer } = (await deps.settings.read()).activation;
    if (mode !== "remote" || !peer) return;
    deps.attach?.(context.paseo);
    await deps.ready?.();
    const ticket = await deps.drain.agentTicket(request.agentId) ?? await deps.known?.(request.agentId) ?? null;
    if (!ticket) return;
    let held: boolean;
    try {
      held = await deps.drain.holdsAgent(request.agentId);
    } catch (error) {
      // A read that failed is not a licence to wake a root this host may have retired.
      log(`activation routing: could not judge the resume of ${request.agentId.slice(0, 8)} (${error instanceof Error ? error.message : error}); it stays closed`);
      throw new Error(`This host could not tell whether ${ticket.identifier} still runs here (Paseo or Linear is unreadable), so it left it closed. Try again in a minute.`);
    }
    if (held) return;
    log(`activation routing: refused to resume retired ticket agent ${request.agentId.slice(0, 8)} (${ticket.identifier})`);
    throw new Error(`This host no longer runs new work for ${ticket.identifier}: Linear ticket work is routed to ${peer}. The ticket continues on the other host; open a new chat for anything else.`);
  };
}

// Which host owns a ticket's automatic work, read from the same claims as the activation guard
// but without forwarding or starting anything (SessionRouter.whileIdle, TUC-1209): a draining host
// owns only the roots it still runs; a receiving host with a peer owns a ticket only after the
// claims handshake and while the peer claims none for it; a host without a peer owns every ticket.
// A read that fails throws, which the caller takes as unknown.
export function ticketOwnership(deps: {
  settings: Pick<Settings, "read">;
  drain: Pick<DrainRouter, "ownerFor">;
  intake: Pick<ActivationIntake, "status" | "claimFor">;
}): (issueId: string) => Promise<HostOwnership> {
  return async (issueId) => {
    const { mode, peer } = (await deps.settings.read()).activation;
    if (mode === "remote") return (await deps.drain.ownerFor(issueId)) ? "here" : "elsewhere";
    if (!peer) return "here";
    if (!(await deps.intake.status()).appliedAt) return "unknown";
    return (await deps.intake.claimFor(issueId)) ? "elsewhere" : "here";
  };
}
