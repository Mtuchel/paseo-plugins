import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { activationEndpoints } from "./activation-endpoints";
import { ticketOwnership } from "./activation-guard";
import { ActivationIntake } from "./activation-intake";
import { DrainRouter } from "./drain";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, type ActivationSettings, type PluginSettings } from "./settings";

// The two hosts over real HTTP (the review service's :8444 listener, activation-endpoints.ts):
// the Mac drains, the server answers, and both talk to each other exactly as they do in the
// cutover. Nothing here mocks the wire, so this is also the smoke fixture for a live pair.
const SECRET = "sh4red-secret";
process.env.PASEO_ACTIVATION_SECRET = SECRET;

function settingsFor(activation: ActivationSettings): PluginSettings {
  return {
    template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
    dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation, deputy: DEFAULT_DEPUTY,
  };
}

type AgentSpec = { id: string; issueId: string; identifier?: string; status?: string; createdAt?: string };

function fakeDaemon(specs: AgentSpec[]) {
  const agents = specs.map((spec) => ({
    id: spec.id,
    title: `${spec.identifier ?? spec.issueId}: work`,
    status: spec.status ?? "running",
    cwd: "/repo/wt",
    createdAt: spec.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: spec.createdAt ?? "2026-01-01T00:00:00Z",
    provider: "omp",
    labels: { "linear.issueId": spec.issueId, "linear.identifier": spec.identifier ?? spec.issueId } as Record<string, string>,
    pendingPermissions: [] as unknown[],
  }));
  const sent: { agentId: string; message: string }[] = [];
  const paseo = {
    agents: {
      list: async (input?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean } }) => ({
        entries: agents.filter((agent) => Object.entries(input?.filter?.labels ?? {}).every(([key, value]) => agent.labels[key] === value)).map((agent) => ({ agent })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      ref: (id: string) => ({
        refresh: async () => (agents.find((agent) => agent.id === id) ? { agent: agents.find((agent) => agent.id === id) } : null),
        send: async (message: string) => { sent.push({ agentId: id, message }); },
        archive: async () => {},
        respondToPermission: async () => {},
      }),
    },
  } as unknown as PaseoApi;
  return { paseo, sent, agents };
}

async function tempHome(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paseo-activation-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// One host: its daemon, its routers and the activation routes on a real loopback listener.
async function hostOverHttp(t: TestContext, options: { name: string; activation: () => ActivationSettings; agents?: AgentSpec[]; peerHost?: () => string }) {
  const home = await tempHome(t);
  const daemon = fakeDaemon(options.agents ?? []);
  const starts: { issueId: string; options: unknown }[] = [];
  const comments: string[] = [];
  const settings = { read: async () => settingsFor(options.activation()) };
  const intake = new ActivationIntake({
    settings, paseo: () => daemon.paseo, host: options.name, home: join(home, options.name), log: () => {},
    linear: () => ({ comment: async (_id: string, body: string) => { comments.push(body); }, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({
      admission: async () => ({ ok: true as const }),
      start: async (issueId, _paseo, _settings, startOptions) => {
        starts.push({ issueId, options: startOptions });
        return { agentId: "agent-1", warnings: [], provider: "p/opus", target: "App", resumed: false, untrusted: false, plan: null };
      },
    }),
  });
  // The process check has its own tests (process-liveness.test.ts): the fixture's agents have no
  // process of their own, so a real check would call every one of them a ghost.
  const drain = new DrainRouter({ settings, paseo: () => daemon.paseo, host: options.name, home: join(home, options.name), log: () => {}, ghosts: async () => new Set<string>() });
  const routes = activationEndpoints({ settings, secret: async () => SECRET, intake, drain });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const answer = await routes({ method: request.method ?? "GET", path, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (!answer) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      response.end(answer.body);
    })().catch(() => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture failed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, root: home, daemon, starts, comments, intake, drain };
}

// The draining host without a listener of its own: it observes (take) and pushes (fetch).
async function macRouter(t: TestContext, options: { peer: () => string; agents?: AgentSpec[] }) {
  const home = await tempHome(t);
  const daemon = fakeDaemon(options.agents ?? []);
  return { home, daemon, drain: new DrainRouter({ settings: { read: async () => settingsFor({ mode: "remote", peer: options.peer() }) }, paseo: () => daemon.paseo, home: join(home, "mac"), host: "mac", log: () => {}, ghosts: async () => new Set<string>() }) };
}

test("a new session while the Mac drains is started by the server over HTTP; a replay starts nothing", async (t) => {
  const server = await hostOverHttp(t, { name: "server087", activation: () => ({ mode: "local", peer: null }) });
  const mac = await macRouter(t, { peer: () => server.url });
  const request = { kind: "session" as const, issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "Please fix the login." };
  assert.ok(await mac.drain.take(request), "the activation was handed to the peer");
  await server.intake.idle();
  assert.deepEqual(server.starts.map((start) => start.issueId), ["i1"]);
  assert.deepEqual((server.starts[0].options as { lead?: string }).lead, "Please fix the login.", "the original prompt arrived whole");
  assert.deepEqual((await mac.drain.status()).outbox, 0, "the peer's answer cleared the outbox");

  // The same activation again (the answer crossed a reload): the peer's record deduplicates it.
  assert.ok(await mac.drain.take(request));
  assert.equal(server.starts.length, 1, "the replay started nothing");
});

test("the Mac's claims cross the wire: the server defers its ticket and delivers to the owner by HTTP", async (t) => {
  let macUrl = "";
  const server = await hostOverHttp(t, { name: "server087", activation: () => ({ mode: "local", peer: macUrl }) });
  const mac = await hostOverHttp(t, {
    name: "mac",
    activation: () => ({ mode: "remote", peer: server.url }),
    agents: [{ id: "a-run", issueId: "i1", identifier: "TUC-1", status: "running" }],
  });
  macUrl = mac.url;
  await mac.drain.readyNow();
  assert.equal((await mac.drain.status()).agents, 1, "the working root seeded the allowlist");
  assert.equal((await server.intake.status()).claims, 1, "the claim crossed the wire");
  assert.equal((await server.intake.claimFor("i1"))?.agentId, "a-run");

  assert.deepEqual(await server.intake.take({ kind: "session", issueId: "i1", identifier: "TUC-1", sessionId: "s2", text: "Any news?" }), { peer: "mac" });
  await server.intake.idle();
  assert.equal(server.starts.length, 0, "a claimed ticket starts nothing on the server");
  assert.deepEqual(mac.daemon.sent, [{ agentId: "a-run", message: "Any news?" }], "the message reached the agent that owns the ticket");
  assert.equal(server.comments.length, 0, "a deferred message posts no start comment");

  // The wire is authenticated: another host without the shared secret gets nowhere.
  const denied = await fetch(`${mac.url}/activation`, { method: "POST", headers: { "content-type": "application/json", "x-paseo-activation": "wrong" }, body: "{}" });
  assert.equal(denied.status, 401);

  // The root fails (or its ticket closes): the next snapshot releases it, and the next work the
  // Mac forwards starts on the server.
  mac.daemon.agents[0].status = "error";
  await mac.drain.sweep();
  assert.equal(await server.intake.claimFor("i1"), null, "the release crossed the wire");
  assert.ok(await mac.drain.take({ kind: "session", issueId: "i1", identifier: "TUC-1", sessionId: "s3", text: "One more thing." }), "the retired ticket's new work is forwarded");
  await server.intake.idle();
  assert.deepEqual(server.starts.map((start) => start.issueId), ["i1"], "the released ticket starts on the server");
});

test("a peer that refuses (it drains too) leaves the activation durable, and a later sweep delivers it once", async (t) => {
  let peerDrains = true;
  const server = await hostOverHttp(t, { name: "server087", activation: () => (peerDrains ? { mode: "remote", peer: "https://elsewhere.example:8444" } : { mode: "local", peer: null }) });
  const mac = await macRouter(t, { peer: () => server.url });
  assert.ok(await mac.drain.take({ kind: "reply", issueId: "i1", identifier: "TUC-1", sessionId: "s1", activityId: "act-1", text: "Rebase it." }));
  assert.equal((await mac.drain.status()).outbox, 1, "the refusal kept the prompt durably");
  assert.equal(server.starts.length, 0);

  peerDrains = false;
  await mac.drain.sweep();
  await server.intake.idle();
  assert.deepEqual(server.starts.map((start) => start.issueId), ["i1"]);
  assert.deepEqual((server.starts[0].options as { lead?: string }).lead, "Rebase it.");
  assert.deepEqual((await mac.drain.status()).outbox, 0);
  await mac.drain.sweep();
  assert.equal(server.starts.length, 1, "the sweep delivers a finished activation exactly once");
});

// TUC-1258 AC-5: a forwarded message is kept on the destination under the sender's own receipt, so
// the sender's retry -- its answer to the POST was lost, or the receipt could not be written -- is
// answered from that record: the agent gets the message once, and nothing lands on a newer
// question.
test("a forwarded message is kept under its receipt: the sender's retry reaches the agent once", async (t) => {
  const host = await hostOverHttp(t, { name: "server087", activation: () => ({ mode: "local", peer: null }), agents: [{ id: "a-run", issueId: "i1", identifier: "TUC-1", status: "running" }] });
  const deliver = (issueId: string, text: string, receipt: string) => fetch(`${host.url}/activation/deliver`, {
    method: "POST", headers: { "content-type": "application/json", "x-paseo-activation": SECRET }, body: JSON.stringify({ issueId, text, receipt }),
  });

  // Warm the claims file into the intake's cache (this ticket has no agent), then make that path
  // unwritable for the receipt: the message goes out, the receipt cannot be recorded.
  assert.equal((await deliver("i9", "Nobody works on this ticket.", "warm")).status, 409);
  const claimsPath = join(host.root, "server087", "activation-claims.json");
  await mkdir(claimsPath, { recursive: true });
  assert.equal((await deliver("i1", "Any news?", "session:s2")).status, 500, "the message went out, the receipt could not be written");
  await rm(claimsPath, { recursive: true });

  const retry = await deliver("i1", "Any news?", "session:s2");
  assert.equal(retry.status, 200, "the retry is answered from the record, not from the agent");
  assert.equal((await retry.json() as { ok: boolean }).ok, true);
  assert.deepEqual(host.daemon.sent, [{ agentId: "a-run", message: "Any news?" }], "the agent got the message exactly once");
  const again = await deliver("i1", "Any news?", "session:s2");
  assert.equal(again.status, 200, "the receipt the retry wrote answers the next repeat");
  assert.deepEqual(host.daemon.sent, [{ agentId: "a-run", message: "Any news?" }]);
});

test("the health route answers the routing state the smoke run reads", async (t) => {
  const server = await hostOverHttp(t, { name: "server087", activation: () => ({ mode: "local", peer: null }) });
  const mac = await hostOverHttp(t, {
    name: "mac",
    activation: () => ({ mode: "remote", peer: server.url }),
    agents: [{ id: "a-run", issueId: "i1", identifier: "TUC-1", status: "running" }],
  });
  await mac.drain.readyNow();
  const unauthorized = await fetch(`${mac.url}/activation/health`);
  assert.equal(unauthorized.status, 401);
  const answer = await fetch(`${mac.url}/activation/health`, { headers: { "x-paseo-activation": SECRET } });
  assert.equal(answer.status, 200);
  const health = await answer.json() as { role: string; mode: string; drain: { seededAt: string | null; seedSource: string; agents: number; claims: number } };
  assert.deepEqual({ role: health.role, mode: health.mode, seedSource: health.drain.seedSource, agents: health.drain.agents, claims: health.drain.claims, seeded: health.drain.seededAt !== null }, { role: "drain", mode: "remote", seedSource: "daemon", agents: 1, claims: 1, seeded: true });
});

// TUC-1209 AC-16: the queue backstop moves a stranded stack only on the host that owns its ticket,
// read from the real claims of both hosts; neither reader forwards or starts anything.
test("ticket ownership for the queue backstop's moves follows the two hosts' real claims", async (t) => {
  let macUrl = "";
  const server = await hostOverHttp(t, { name: "server087", activation: () => ({ mode: "local", peer: macUrl }) });
  const mac = await hostOverHttp(t, {
    name: "mac",
    activation: () => ({ mode: "remote", peer: server.url }),
    agents: [{ id: "a-run", issueId: "i1", identifier: "TUC-1", status: "running" }],
  });
  macUrl = mac.url;
  const serverOwns = ticketOwnership({ settings: { read: async () => settingsFor({ mode: "local", peer: macUrl }) }, drain: server.drain, intake: server.intake });
  const macOwns = ticketOwnership({ settings: { read: async () => settingsFor({ mode: "remote", peer: server.url }) }, drain: mac.drain, intake: mac.intake });
  assert.equal(await serverOwns("i1"), "unknown", "before the claims handshake the receiving host moves nothing");
  assert.equal(await serverOwns("i2"), "unknown");

  await mac.drain.readyNow();
  assert.deepEqual([await macOwns("i1"), await serverOwns("i1")], ["here", "elsewhere"], "the ticket the Mac still runs is the Mac's alone");
  assert.deepEqual([await macOwns("i2"), await serverOwns("i2")], ["elsewhere", "here"], "every other ticket is the server's alone");

  mac.daemon.agents[0].status = "error";
  await mac.drain.sweep();
  assert.deepEqual([await macOwns("i1"), await serverOwns("i1")], ["elsewhere", "here"], "a released ticket moves to the server");
  assert.deepEqual([server.starts, mac.daemon.sent], [[], []], "reading ownership started and sent nothing");

  const alone = ticketOwnership({ settings: { read: async () => settingsFor({ mode: "local", peer: null }) }, drain: server.drain, intake: server.intake });
  assert.equal(await alone("i1"), "here", "a host without a peer owns every ticket");
});
