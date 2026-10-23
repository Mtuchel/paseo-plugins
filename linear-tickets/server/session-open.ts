import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { resumeGuard, type ResumeGuardDeps } from "./activation-guard";
import { sessionEnv } from "./agent-env";
import { loadProbe, type LoadProbe } from "./load-probe";
import { PLAN_TICKET_ENV } from "./plan-policy";

// The plugin's two `agent.session_open` hooks, both timed by the load probe (README,
// "Diagnostics"): the daemon gives every hook 30 s, so an open that comes close names its slow
// step in the log. Timing never changes what a hook returns or throws.
type Probe = Pick<LoadProbe, "time" | "step">;
type SessionOpenHook<T> = (input: { request: PluginSessionOpenRequest }, context: { paseo: PaseoApi }) => Promise<T>;

// The resume guard (activation-guard.ts) with its awaited reads marked as steps.
export function sessionOpenGuard(deps: ResumeGuardDeps, probe: Probe = loadProbe): SessionOpenHook<void> {
  const { ready, known } = deps;
  const guard = resumeGuard({
    ...deps,
    settings: { read: () => probe.step("settings", () => deps.settings.read()) },
    ready: ready && (() => probe.step("ready", ready)),
    drain: {
      agentTicket: (agentId) => probe.step("ticket", () => deps.drain.agentTicket(agentId)),
      holdsAgent: (agentId) => probe.step("holds", () => deps.drain.holdsAgent(agentId)),
    },
    known: known && ((agentId) => probe.step("ticket", () => known(agentId))),
  });
  return (input, context) => probe.time("session_open.guard", () => guard(input, context), "hook");
}

export type SessionPrepareDeps = {
  attach: (paseo: PaseoApi) => void;
  // The Plannotator browser script's path, or null when it could not be written.
  plannotator: () => Promise<string | null>;
  envs: { read: (agentId: string) => Promise<Record<string, string>> };
};

// A new ticket agent gets its plan policy and ticket environment with its create request; a
// resumed one (daemon restart, reload) gets them back from its labels and its saved launch
// environment, so the omp extension keeps the same rules and tools (agent-env.ts).
export function sessionPrepare(deps: SessionPrepareDeps, probe: Probe = loadProbe): SessionOpenHook<PluginSessionOpenRequest | undefined> {
  return ({ request }, { paseo }) => probe.time("session_open.prepare", async () => {
    deps.attach(paseo);
    const browser = await probe.step("plannotator", deps.plannotator);
    const saved = await probe.step("env", () => deps.envs.read(request.agentId));
    let labels: Record<string, string> | undefined;
    if (request.reason === "resume") {
      const found = await probe.step("refresh", () => paseo.agents.ref(request.agentId).refresh());
      if (!found) throw new Error("The resumed agent's capabilities cannot be verified; the session stays closed.");
      labels = found.agent.labels;
    } else if (!request.env[PLAN_TICKET_ENV]) {
      labels = await probe.step("refresh", () => paseo.agents.ref(request.agentId).refresh().then((found) => found?.agent.labels, () => undefined));
    }
    const env = { ...(browser ? { PLANNOTATOR_BROWSER: browser } : {}), ...sessionEnv(request.env, labels, saved) };
    return Object.keys(env).length ? { ...request, env: { ...request.env, ...env } } : undefined;
  }, "hook");
}
