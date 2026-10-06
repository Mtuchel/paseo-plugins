import type { ActivationIntake } from "./activation-intake";
import type { DrainRouter } from "./drain";
import type { Settings } from "./settings";
import { ACTIVATION_HEADER, activationJson, deliverRequestSchema, readActivationSecret, secretsMatch, type ActivationRoute } from "./activation";

// The tailnet-only HTTP the two hosts talk over (README, "Draining a host"). It rides the review
// service's existing :8444 listener and proxy, so nothing new is exposed; every route needs the
// shared secret in `x-paseo-activation`, and a host that is draining refuses the receiving routes
// outright, so a forwarded activation can never ping-pong or start locally there.
export type ActivationEndpointDeps = {
  settings: Pick<Settings, "read">;
  secret?: () => Promise<string | null>;
  intake: Pick<ActivationIntake, "accept" | "applyClaims" | "status" | "deliverLocal">;
  drain: Pick<DrainRouter, "deliver" | "status">;
};

function headerSecret(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

export function activationEndpoints(deps: ActivationEndpointDeps): ActivationRoute {
  return async ({ method, path, headers, body }) => {
    if (path !== "/activation" && !path.startsWith("/activation/")) return null;
    const secret = await (deps.secret ?? readActivationSecret)();
    if (!secretsMatch(headerSecret(headers[ACTIVATION_HEADER]), secret)) return activationJson(401, { error: "Not allowed." });
    const { mode } = (await deps.settings.read()).activation;
    const role: "drain" | "intake" = mode === "remote" ? "drain" : "intake";

    if (path === "/activation/health" && (method === "GET" || method === "POST")) {
      const [drain, intake] = await Promise.all([deps.drain.status(), deps.intake.status()]);
      return activationJson(200, {
        role, host: drain.host, mode, peer: drain.peer, secretConfigured: true,
        drain: { seededAt: drain.seededAt, seedSource: drain.seedSource, seedRejected: drain.seedRejected, agents: drain.agents, claims: drain.claims, revision: drain.revision, ackedRevision: drain.ackedRevision, outbox: drain.outbox },
        intake: { claims: intake.claims, revision: intake.revision, appliedAt: intake.appliedAt, pending: intake.pending, handoffs: intake.handoffs, done: intake.done },
      });
    }
    if (method !== "POST") return { status: 405, headers: { allow: "POST" }, body: JSON.stringify({ error: "Use POST." }) };

    if (path === "/activation") {
      if (role === "drain") return activationJson(409, { error: "This host is draining; it forwards activations, it does not accept them." });
      const parsed = parseJson(body);
      if (!parsed.ok) return activationJson(400, { error: "The request is not JSON." });
      return deps.intake.accept(parsed.value);
    }

    if (path === "/activation/claims") {
      if (role === "drain") return activationJson(409, { error: "This host is draining; it registers claims, it does not accept them." });
      const parsed = parseJson(body);
      if (!parsed.ok) return activationJson(400, { error: "The request is not JSON." });
      try {
        const { revision } = await deps.intake.applyClaims(parsed.value);
        return activationJson(200, { ok: true, revision });
      } catch (error) {
        return activationJson(400, { error: `That is not a claims snapshot: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    }

    if (path === "/activation/deliver") {
      const parsed = parseJson(body);
      if (!parsed.ok) return activationJson(400, { error: "The request is not JSON." });
      const request = deliverRequestSchema.safeParse(parsed.value);
      if (!request.success) return activationJson(400, { error: "That is not a delivery." });
      const result = role === "drain"
        ? await deps.drain.deliver(request.data.issueId, request.data.text, request.data.receipt)
        : await deps.intake.deliverLocal(request.data.issueId, request.data.text, request.data.receipt);
      return result.ok ? activationJson(200, { ok: true, delivered: true, ...(result.duplicate ? { duplicate: true } : {}) }) : activationJson(409, { error: result.reason ?? "Not delivered." });
    }

    return activationJson(404, { error: "No such activation route." });
  };
}
