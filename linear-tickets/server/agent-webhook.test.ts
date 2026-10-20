import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { AgentWebhookServer, type AgentSessionWebhook, type ResourceWebhook } from "./agent-webhook";

async function receiver() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const sessions: AgentSessionWebhook[] = [];
  const resources: ResourceWebhook[] = [];
  const server = new AgentWebhookServer(async () => "test-secret", (event) => sessions.push(event), address.port, (event) => resources.push(event));
  await server.start();
  const deliver = async (delivery: string, payload: Record<string, unknown>, secret = "test-secret") => {
    const body = JSON.stringify({ webhookId: "same-subscription", webhookTimestamp: Date.now(), ...payload });
    return fetch(`http://127.0.0.1:${address.port}/`, { method: "POST", headers: {
      "linear-delivery": delivery, "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
    }, body });
  };
  return { server, sessions, resources, deliver };
}

test("one subscription delivers successive changes, while a repeated delivery is handled once", async () => {
  const h = await receiver();
  try {
    const issue = { type: "Issue", action: "update", data: { id: "i1", title: "First" } };
    assert.equal((await h.deliver("delivery-1", issue)).status, 200);
    assert.equal((await h.deliver("delivery-1", issue)).status, 200);
    assert.equal((await h.deliver("delivery-2", { ...issue, data: { id: "i1", title: "Second" } })).status, 200);
    assert.deepEqual(h.resources.map((event) => event.data.title), ["First", "Second"]);
    assert.equal((await h.deliver("delivery-3", { type: "AgentSessionEvent", action: "prompted", agentSession: { id: "s1" } })).status, 200);
    assert.deepEqual(h.sessions.map((event) => event.agentSession.id), ["s1"]);
    assert.equal((await h.deliver("forged", issue, "wrong-secret")).status, 401);
    assert.equal(h.resources.length, 2, "an invalid signature cannot enqueue reconciliation");
  } finally { h.server.stop(); }
});

test("resource descriptions above one MiB fit Linear's five-MiB delivery limit", async () => {
  const h = await receiver();
  try {
    const description = "x".repeat(1024 * 1024 + 1);
    assert.equal((await h.deliver("large-issue", { type: "Issue", action: "update", data: { id: "i1", description } })).status, 200);
    assert.equal(h.resources[0]?.data.description, description);
  } finally { h.server.stop(); }
});
