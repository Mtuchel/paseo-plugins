import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import type { ActivationEnvelope, ActivationRoute, RequestLike } from "./activation";
import { ACTIVATION_HEADER, recoverActivationId } from "./activation";
import { activationEndpoints } from "./activation-endpoints";
import { ActivationIntake } from "./activation-intake";
import { DrainRouter, SEED_FILE } from "./drain";
import { Launcher } from "./launch";
import { PermissionReplies } from "./permission-replies";
import { SessionStore } from "./sessions";
import { ResumeUnavailableError } from "./starter";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, Settings, type ActivationSettings, type PluginSettings } from "./settings";
import { WATCHDOG_LABEL, WatchdogStore } from "./watchdog";

const OWNER = "owner-1";
const ISSUE = "i1";
const SECRET = "sh4red-secret";
const PEER = "https://server087.tail5efd6b.ts.net:8444";
const MAC = "https://macbook-pro-von-mirko.tail5efd6b.ts.net:8444";
// Both hosts read the shared secret from here; the file path has its own test.
process.env.PASEO_ACTIVATION_SECRET = SECRET;

function settingsFor(activation: ActivationSettings = DEFAULT_ACTIVATION): PluginSettings {
  return {
    template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
    dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation, deputy: DEFAULT_DEPUTY,
  };
}

type FakeAgentSpec = {
  id: string;
  issueId: string;
  identifier?: string;
  status?: string;
  createdAt?: string;
  parent?: string;
  pending?: boolean;
  archived?: boolean;
};

type FakeAgent = {
  id: string;
  title: string;
  status: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  labels: Record<string, string>;
  pendingPermissions: unknown[];
};

function fakeAgent(spec: FakeAgentSpec): FakeAgent {
  return {
    id: spec.id,
    title: `${spec.identifier ?? spec.issueId}: work`,
    status: spec.status ?? "running",
    cwd: "/repo/wt",
    createdAt: spec.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: spec.createdAt ?? "2026-01-01T00:00:00Z",
    provider: "omp",
    labels: { "linear.issueId": spec.issueId, "linear.identifier": spec.identifier ?? spec.issueId, ...(spec.parent ? { "paseo.parent-agent-id": spec.parent } : {}) },
    pendingPermissions: spec.pending ? [{}] : [],
  };
}

// A daemon in memory: exactly what the routers read (agents.list / agents.ref).
function fakeDaemon(specs: FakeAgentSpec[]) {
  const agents = specs.map(fakeAgent);
  const archived = new Set(specs.filter((spec) => spec.archived).map((spec) => spec.id));
  const sent: { agentId: string; message: string }[] = [];
  const answers: { agentId: string; requestId: string; response: unknown }[] = [];
  const listed = (filter?: { labels?: Record<string, string>; includeArchived?: boolean }) =>
    agents.filter((agent) => (!archived.has(agent.id) || filter?.includeArchived === true) && Object.entries(filter?.labels ?? {}).every(([key, value]) => agent.labels[key] === value));
  const paseo = {
    agents: {
      list: async (input?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean } }) => ({
        entries: listed(input?.filter).map((agent) => ({ agent })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      ref: (id: string) => ({
        refresh: async () => (agents.find((agent) => agent.id === id) ? { agent: agents.find((agent) => agent.id === id) } : null),
        send: async (message: string) => { sent.push({ agentId: id, message }); },
        archive: async () => { archived.add(id); },
        respondToPermission: async (input: { requestId: string; response: unknown }) => { answers.push({ agentId: id, ...input }); },
      }),
    },
  } as unknown as PaseoApi;
  return { paseo, agents, sent, answers, archived };
}

type PeerCall = { url: string; headers: Record<string, string>; body: unknown };
function fakeRequest(respond?: (url: string, body: unknown) => { ok: boolean; status: number; text?: string }) {
  const calls: PeerCall[] = [];
  const request: RequestLike = async (url, init) => {
    const body: unknown = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    const answer = respond?.(url, body) ?? { ok: true, status: 202 };
    return { ok: answer.ok, status: answer.status, text: async () => answer.text ?? JSON.stringify({ ok: answer.ok }) };
  };
  return { request, calls };
}

async function withHome(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paseo-activation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "linear-tickets");
  await mkdir(home, { recursive: true });
  return home;
}

function drainFor(home: string, daemon: ReturnType<typeof fakeDaemon>, options: {
  request?: RequestLike;
  settings?: ActivationSettings;
  sessionFor?: (agentId: string) => Promise<{ closed?: boolean } | null>;
  ticketState?: (issueId: string) => Promise<{ statusType: string } | null>;
  ghosts?: (agents: FakeAgent[]) => Promise<Set<string>>;
} = {}) {
  return new DrainRouter({
    settings: { read: async () => settingsFor(options.settings ?? { mode: "remote", peer: PEER }) },
    paseo: () => daemon.paseo,
    sessionFor: options.sessionFor,
    ticketState: options.ticketState,
    request: options.request ?? fakeRequest().request,
    home, host: "mac", log: () => {},
    // The process check has its own tests; these fixtures' in-memory agents have no process.
    ghosts: (options.ghosts ?? (async () => new Set<string>())) as never,
  });
}

test("seeding takes every root with a ticket (never a subagent, an archived one or a ghost), and never re-enrolls on reload", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([
    { id: "a-run", issueId: "i1", status: "running" },
    { id: "a-wait", issueId: "i2", status: "idle", pending: true },
    { id: "a-idle", issueId: "i3", status: "idle" },
    { id: "a-sub", issueId: "i4", status: "running", parent: "a-run" },
    { id: "a-ghost", issueId: "i5", status: "running" },
    { id: "a-archived", issueId: "i6", status: "running", archived: true },
  ]);
  const drain = drainFor(home, daemon, { ghosts: async (agents) => new Set(agents.filter((agent) => agent.id === "a-ghost").map((agent) => agent.id)) });
  await drain.readyNow();
  const status = await drain.status();
  assert.deepEqual({ agents: status.agents, seedSource: status.seedSource, seedRejected: status.seedRejected }, { agents: 3, seedSource: "daemon", seedRejected: 0 }, "the working, owner-waiting and turn-ended roots were seeded");
  assert.equal(await drain.ownerFor("i5"), null, "an agent without a process owns nothing");
  assert.ok(await drain.ownerFor("i1"), "a working root owns its ticket");
  assert.ok(await drain.ownerFor("i2"), "a root waiting for the owner owns its ticket");
  assert.ok(await drain.ownerFor("i3"), "a root whose turn ended normally still owns its open ticket");
  assert.equal(await drain.ownerFor("i4"), null, "a subagent never owns a ticket");

  // A later root is never enrolled, even after a reload.
  daemon.agents.push(fakeAgent({ id: "a-new", issueId: "i7", status: "running" }));
  const reloaded = drainFor(home, daemon);
  await reloaded.readyNow();
  assert.equal((await reloaded.status()).agents, 3, "the persisted allowlist is not extended");
  assert.equal(await reloaded.ownerFor("i7"), null, "a later root is not grandfathered");
});

test("the owner's initializer seeds the exact roots: a working one stays local, the daemon's others are forwarded", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([
    { id: "a-pinned", issueId: "i1", status: "running" },
    { id: "a-other", issueId: "i2", status: "running" },
  ]);
  await writeFile(join(home, "activation-allowlist-seed.json"), JSON.stringify({
    agents: [
      { agentId: "a-pinned", issueId: "i1", identifier: "TUC-1" },
      { agentId: "a-broken" },
    ],
  }));
  const { request, calls } = fakeRequest();
  const drain = drainFor(home, daemon, { request });
  await drain.readyNow();
  const status = await drain.status();
  assert.deepEqual({ agents: status.agents, seedSource: status.seedSource, seedRejected: status.seedRejected }, { agents: 1, seedSource: "file", seedRejected: 1 });
  assert.ok(await drain.ownerFor("i1"), "the pinned root owns its ticket");
  assert.equal(await drain.ownerFor("i2"), null, "the daemon's other root was not grandfathered");
  assert.deepEqual(await drain.take({ kind: "session", issueId: "i2", identifier: "TUC-2", sessionId: "s2" }), { peer: "server087" });
  assert.equal(calls.filter((call) => call.url === `${PEER}/activation`).length, 1);
});

test("an initializer that cannot be used seeds nothing and keeps every activation local, never the daemon list", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "a-other", issueId: "i2", status: "running" }]);
  await writeFile(join(home, "activation-allowlist-seed.json"), "{ not json");
  const { request, calls } = fakeRequest();
  const drain = drainFor(home, daemon, { request });
  const unusable = await drain.take({ kind: "session", issueId: "i2", identifier: "TUC-2", sessionId: "s2" });
  assert.ok(unusable && "held" in unusable, "the activation is held, not started or forwarded");
  assert.deepEqual(calls, [], "nothing was forwarded");
  const status = await drain.status();
  assert.deepEqual({ seededAt: status.seededAt, agents: status.agents }, { seededAt: null, agents: 0 });
  assert.equal(await drain.ownerFor("i2"), null);

  // An explicit empty list is a decision, not a mistake: it seeds an empty allowlist.
  await writeFile(join(home, "activation-allowlist-seed.json"), JSON.stringify({ agents: [] }));
  const empty = drainFor(home, daemon);
  await empty.readyNow();
  assert.equal((await empty.status()).seededAt !== null, true, "the empty initializer counts as seeded");
  assert.deepEqual(await empty.take({ kind: "session", issueId: "i2", identifier: "TUC-2", sessionId: "s3" }), { peer: "server087" });
});

test("a host whose daemon is not attached yet keeps activations local until it has seeded", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  const { request, calls } = fakeRequest();
  let paseo: PaseoApi | null = null;
  const drain = new DrainRouter({ settings: { read: async () => settingsFor({ mode: "remote", peer: PEER }) }, paseo: () => paseo, request, home, host: "mac", log: () => {} });
  const held = await drain.take({ kind: "reply", issueId: "i9", identifier: "TUC-9", sessionId: "s1", text: "Retry." });
  assert.ok(held && "held" in held && /not read the agents|acknowledged/.test(held.held), "an unseeded host starts nothing remotely, forwards nothing, and says so");
  assert.equal(calls.length, 0, "nothing was sent before the handshake");
  paseo = daemon.paseo;
  assert.deepEqual(await drain.take({ kind: "reply", issueId: "i9", identifier: "TUC-9", sessionId: "s1", text: "Retry." }), { peer: "server087" });
  const forwarded = calls.filter((call) => call.url === `${PEER}/activation`);
  assert.ok(forwarded.length >= 1, "the activation was forwarded once the handshake was done");
  assert.equal(new Set(forwarded.map((call) => (call.body as ActivationEnvelope).id)).size, 1, "every attempt carried the same activation id");
});

test("ownership is retired for a finished ticket, an archived or failed root, or a closed thread, never for a turn that ended", async (t) => {
  const home = await withHome(t);
  const statuses: Record<string, string> = { i1: "started", i2: "completed", i3: "canceled", i4: "started", i5: "started", i7: "started" };
  const daemon = fakeDaemon([
    { id: "a-keep", issueId: "i1", status: "idle" },
    { id: "a-done", issueId: "i2", status: "idle" },
    { id: "a-canceled", issueId: "i3", status: "running" },
    { id: "a-error", issueId: "i4", status: "error" },
    { id: "a-archived", issueId: "i5", status: "running", archived: true },
    { id: "a-closed", issueId: "i6", status: "running" },
    { id: "a-stopped", issueId: "i7", status: "closed" },
  ]);
  const { request, calls } = fakeRequest();
  const drain = drainFor(home, daemon, {
    request,
    ticketState: async (issueId) => (statuses[issueId] ? { statusType: statuses[issueId] } : null),
    sessionFor: async (agentId) => (agentId === "a-closed" ? { closed: true } : null),
  });
  await drain.readyNow();
  assert.ok(await drain.ownerFor("i1"), "a root whose turn ended normally and whose ticket is open keeps it");
  assert.ok(await drain.ownerFor("i7"), "a root Paseo closed while it idled on an open ticket keeps it");
  assert.equal(await drain.ownerFor("i2"), null, "a finished ticket is retired");
  assert.equal(await drain.ownerFor("i3"), null, "a canceled ticket is retired");
  assert.equal(await drain.ownerFor("i4"), null, "a failed root is retired");
  assert.equal(await drain.ownerFor("i5"), null, "an archived root is retired");
  assert.equal(await drain.ownerFor("i6"), null, "a root whose thread was closed is retired");
  assert.deepEqual(await drain.take({ kind: "reply", issueId: "i2", identifier: "TUC-2", sessionId: "s2", text: "Anything left?" }), { peer: "server087" }, "new work for a finished ticket goes to the peer");
  assert.equal(calls.filter((call) => call.url === `${PEER}/activation`).length, 1);
});

test("an allowlisted root whose thread was closed is retired and released from the claims", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "a-run", issueId: "i1", status: "running" }]);
  const { request, calls } = fakeRequest();
  const closed = new Set<string>();
  const drain = drainFor(home, daemon, { request, sessionFor: async (agentId) => (closed.has(agentId) ? { closed: true } : null) });
  await drain.readyNow();
  assert.ok(await drain.ownerFor("i1"));
  const registered = calls.filter((call) => call.url === `${PEER}/activation/claims`);
  assert.deepEqual((registered.at(-1)!.body as { claims: unknown[] }).claims, [{ issueId: "i1", identifier: "i1", agentId: "a-run" }]);

  closed.add("a-run");
  assert.equal(await drain.ownerFor("i1"), null, "a closed thread no longer owns its ticket");
  await drain.sweep();
  const released = calls.filter((call) => call.url === `${PEER}/activation/claims`);
  assert.deepEqual((released.at(-1)!.body as { claims: unknown[] }).claims, [], "the release is registered");
  assert.ok((released.at(-1)!.body as { revision: number }).revision > (released.at(-2)!.body as { revision: number }).revision, "a release bumps the revision");
});

test("a new session for a ticket nobody here owns is forwarded whole, and never started locally", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  const { request, calls } = fakeRequest();
  const drain = drainFor(home, daemon, { request });
  assert.deepEqual(await drain.take({ kind: "session", issueId: "i9", identifier: "TUC-9", sessionId: "sess-9", text: "Please fix the login." }), { peer: "server087" });
  const forwarded = calls.find((call) => call.url === `${PEER}/activation`);
  assert.ok(forwarded, "the activation was POSTed to the peer");
  assert.equal(forwarded!.headers[ACTIVATION_HEADER], SECRET);
  const envelope = forwarded!.body as ActivationEnvelope;
  assert.deepEqual({ id: envelope.id, kind: envelope.kind, text: envelope.text, host: envelope.host }, { id: "session:sess-9", kind: "session", text: "Please fix the login.", host: "mac" });
});

test("an allowed root keeps its tickets local: no forward, not even while draining", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "a-run", issueId: "i1", status: "running" }]);
  const { request, calls } = fakeRequest();
  const draining = drainFor(home, daemon, { request });
  assert.equal(await draining.take({ kind: "reply", issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "How is it going?" }), null);
  assert.equal(calls.filter((call) => call.url === `${PEER}/activation`).length, 0, "nothing was sent for a ticket the allowlist still owns");
  const local = new DrainRouter({ settings: { read: async () => settingsFor() }, paseo: () => daemon.paseo, request, home, host: "mac", log: () => {} });
  assert.equal(await local.take({ kind: "session", issueId: "i1", identifier: "TUC-1", sessionId: "s2" }), null, "a host that is not draining routes locally");
});

test("an unreachable peer keeps the forward durable: reloaded and retried without a local start", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  const down = fakeRequest(() => ({ ok: false, status: 502, text: JSON.stringify({ error: "peer is restarting" }) }));
  const first = drainFor(home, daemon, { request: down.request });
  // The peer never answered the handshake, so this host forwards nothing yet -- and starts
  // nothing: the prompt is queued durably instead.
  const heldDown = await first.take({ kind: "reply", issueId: "i9", identifier: "TUC-9", sessionId: "s1", activityId: "act-7", text: "Retry the deploy." });
  assert.ok(heldDown && "held" in heldDown, "an unacknowledged peer holds the activation, it does not forward it");
  const stored = JSON.parse(await readFile(join(home, "activation-outbox.json"), "utf8")) as { entries: Record<string, unknown> };
  assert.deepEqual(Object.keys(stored.entries), ["activity:act-7"], "the prompt is persisted before the answer");
  assert.equal((await first.status()).outbox, 1);

  const up = fakeRequest();
  const reloaded = drainFor(home, daemon, { request: up.request });
  await reloaded.sweep();
  const forwarded = up.calls.filter((call) => call.url === `${PEER}/activation`);
  assert.equal(forwarded.length, 1, "the reload retried the same activation once");
  assert.equal((forwarded[0].body as ActivationEnvelope).text, "Retry the deploy.");
  assert.equal((await reloaded.status()).outbox, 0, "the answer clears the outbox");
});

test("the intake starts an unclaimed activation through admission, with the original prompt as the lead", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  const options: unknown[] = [];
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
    paseo: () => daemon.paseo,
    linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({
      admission: async () => ({ ok: true as const }),
      start: async (_issueId, _paseo, _settings, startOptions) => {
        options.push(startOptions);
        return { agentId: "agent-1", warnings: [], provider: "claude/opus", target: "App", resumed: false, untrusted: false, plan: null };
      },
    }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 1, claims: [] });
  const answer = await intake.accept({ id: "session:sess-9", kind: "session", issueId: "i9", identifier: "TUC-9", sessionId: "sess-9", text: "Please fix the login.", host: "mac", requestedAt: "2026-01-01T00:00:00Z" });
  assert.equal(answer.status, 202);
  await intake.idle();
  assert.equal((await intake.status()).done, 1, "the forwarded activation was processed");
  assert.deepEqual(options, [{ retryHint: "mac forwarded it again, or assign Paseo on the ticket here", lead: "Please fix the login." }]);
});

test("a forwarded ticket carries its watchdog history; the receiving host takes it over before the start and labels the watchdog's replacement", async (t) => {
  const home = await withHome(t);
  const now = Date.now();
  const source = new WatchdogStore(join(home, "source-watchdog.json"));
  const started = new Date(now - 60 * 60_000).toISOString();
  await source.update((file) => { file.tickets.i9 = { identifier: "TUC-9", starts: [started], cycle: null, exhausted: null }; });
  const { request, calls } = fakeRequest();
  const drain = new DrainRouter({
    settings: { read: async () => settingsFor({ mode: "remote", peer: PEER }) }, paseo: () => fakeDaemon([]).paseo, request, home, host: "mac", log: () => {},
    ghosts: async () => new Set<string>(),
    watchdog: { history: (issueId, at) => source.history(issueId, at), transferred: (issueId, identifier) => source.transferred(issueId, identifier) },
  });
  assert.deepEqual(await drain.take({ kind: "session", issueId: "i9", identifier: "TUC-9", sessionId: "sess-9", text: "Please fix the login." }), { peer: "server087" });
  const envelope = calls.find((call) => call.url === `${PEER}/activation`)!.body as ActivationEnvelope;
  assert.deepEqual(envelope.watchdog, { v: 1, starts: [started], exhaustedAt: null, cycle: null });
  assert.ok((await source.read()).tickets.i9.transferredAt, "the source stops recovering the ticket");

  const target = new WatchdogStore(join(home, "target-watchdog.json"));
  const options: { labels?: Record<string, string> }[] = [];
  const order: string[] = [];
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
    paseo: () => fakeDaemon([]).paseo,
    linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    watchdog: { adopt: async (...args) => { order.push("adopt"); return target.adopt(...args); } },
    starter: () => ({
      admission: async () => ({ ok: true as const }),
      start: async (_issueId, _paseo, _settings, startOptions) => {
        order.push("start");
        options.push(startOptions);
        return { agentId: "agent-1", warnings: [], provider: "omp/opus", target: "App", resumed: true, untrusted: false, plan: null };
      },
    }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 1, claims: [] });
  const marker = "cycle-1:succeed";
  await intake.accept({ ...envelope, id: "watchdog:i9:cycle-1:succeed", kind: "recover", strictResume: true, watchdog: { v: 1, starts: [started], exhaustedAt: null, cycle: { id: "cycle-1", kind: "ghost", startedAt: started, marker } } });
  await intake.accept({ id: "session:sess-8", kind: "session", issueId: "i8", identifier: "TUC-8", sessionId: "sess-8", host: "mac", requestedAt: "2026-01-01T00:00:00Z" });
  await intake.idle();
  assert.deepEqual(order, ["adopt", "start", "adopt", "start"], "the history is saved before each start");
  const file = await target.read();
  assert.deepEqual(file.tickets.i9.starts, [started], "the budget is not reset by the transfer");
  assert.equal(file.tickets.i9.cycle?.successor?.marker, marker, "the forwarded replacement continues its cycle");
  assert.deepEqual(options[0].labels, { [WATCHDOG_LABEL]: marker });
  assert.ok(file.tickets.i8.quarantineUntil, "a ticket that came without history waits a day");
});

test("a claimed ticket defers to its owner host, and a replayed activation starts nothing", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  let starts = 0;
  const { request, calls } = fakeRequest();
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor({ mode: "local", peer: MAC }) }, home, host: "server087", log: () => {}, request,
    paseo: () => daemon.paseo,
    linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({ admission: async () => ({ ok: true as const }), start: async () => { starts += 1; return { agentId: "agent-1", warnings: [], provider: "claude/opus", target: "App", resumed: false, untrusted: false, plan: null }; } }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 3, claims: [{ issueId: "i1", identifier: "TUC-1", agentId: "a-run" }] });
  const envelope = { id: "session:s1", kind: "session" as const, issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "Any news?", host: "mac", requestedAt: "2026-01-01T00:00:00Z" };
  const first = await intake.accept(envelope);
  assert.equal(first.status, 202);
  await intake.idle();
  assert.equal(starts, 0, "a claimed ticket starts nothing here");
  assert.deepEqual(calls.map((call) => call.url), [`${MAC}/activation/deliver`]);
  assert.deepEqual(calls[0].body, { issueId: "i1", text: "Any news?", receipt: "session:s1" });
  const replay = await intake.accept(envelope);
  assert.equal(JSON.parse(replay.body).duplicate, true);
  assert.equal(starts, 0);
});

test("a released claim lets the pending activation start once; an unreachable owner host is never treated as free", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  let starts = 0;
  let now = Date.parse("2026-01-01T00:00:00Z");
  const down = fakeRequest(() => ({ ok: false, status: 502, text: JSON.stringify({ error: "Mac is asleep" }) }));
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor({ mode: "local", peer: MAC }) }, home, host: "server087", log: () => {}, now: () => now, request: down.request,
    paseo: () => daemon.paseo,
    linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({ admission: async () => ({ ok: true as const }), start: async () => { starts += 1; return { agentId: "agent-1", warnings: [], provider: "claude/opus", target: "App", resumed: false, untrusted: false, plan: null }; } }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 1, claims: [{ issueId: "i1", identifier: "TUC-1", agentId: "a-run" }] });
  const deferred = await intake.accept({ id: "reply:s1:pls", kind: "reply", issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "Please look again.", host: "mac", requestedAt: "2026-01-01T00:00:00Z" });
  assert.equal(deferred.status, 202);
  await intake.idle();
  assert.equal(JSON.parse(deferred.body).state, "pending", "the owner host being unreachable never frees the ticket");
  assert.equal(starts, 0);

  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 2, claims: [] });
  now += 10 * 60 * 1000;
  await intake.retry();
  assert.equal(starts, 1, "the release starts it exactly once");
  await intake.retry();
  assert.equal(starts, 1, "a finished activation is not started again");
});

test("a successor whose recorded branch cannot be continued is queued with its handoff, never replaced by a fresh branch", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  let now = Date.parse("2026-01-01T00:00:00Z");
  const comments: string[] = [];
  const starts: { resumeOnly?: boolean }[] = [];
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {}, now: () => now,
    paseo: () => daemon.paseo,
    linear: () => ({ comment: async (_id: string, body: string) => { comments.push(body); }, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({
      admission: async () => ({ ok: true as const }),
      start: async (_issueId, _paseo, _settings, startOptions) => {
        starts.push(startOptions as never);
        throw new ResumeUnavailableError("Could not continue TUC-1 on mtuchel/tuc-1-fix: the branch does not exist here");
      },
    }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 1, claims: [] });
  const answer = await intake.accept({
    id: recoverActivationId("i1", "a-gone", "Fix the failing check."),
    kind: "recover", issueId: "i1", identifier: "TUC-1", text: "Fix the failing check.", strictResume: true,
    resume: { branch: "mtuchel/tuc-1-fix", handover: "https://github.com/o/r/pull/7" },
    host: "mac", requestedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(answer.status, 202);
  await intake.idle();
  assert.equal((await intake.status()).handoffs, 1, "the successor waits as a handoff");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].resumeOnly, true, "a strict successor never starts fresh");
  assert.equal(comments.length, 1, "the queued handoff is reported once");
  assert.match(comments[0], /queued the work/);
  assert.match(comments[0], /mtuchel\/tuc-1-fix/);
  assert.match(comments[0], /pull\/7/);

  now += 60 * 60 * 1000;
  await intake.retry();
  assert.equal(comments.length, 1, "the report is not repeated on every retry");
});

test("admission keeps an activation pending with its prompt, and the retry starts it once", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  let ok = false;
  let now = Date.parse("2026-01-01T00:00:00Z");
  const leads: (string | undefined)[] = [];
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {}, now: () => now,
    paseo: () => daemon.paseo,
    linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({
      admission: async () => (ok ? { ok: true as const } : { ok: false as const, reason: "Queued: 1 of 1 ticket agents are working." }),
      start: async (_issueId, _paseo, _settings, startOptions) => { leads.push((startOptions as { lead?: string }).lead); return { agentId: "agent-1", warnings: [], provider: "claude/opus", target: "App", resumed: false, untrusted: false, plan: null }; },
    }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 1, claims: [] });
  const queued = await intake.accept({ id: "session:s7", kind: "session", issueId: "i7", identifier: "TUC-7", sessionId: "s7", text: "Do the thing.", host: "mac", requestedAt: "2026-01-01T00:00:00Z" });
  assert.equal(JSON.parse(queued.body).state, "pending");
  assert.deepEqual(leads, []);
  ok = true;
  now += 60 * 60 * 1000;
  await intake.retry();
  assert.deepEqual(leads, ["Do the thing."], "the prompt survives the wait");
});

test("a live root on the receiving host takes the message instead of a second start", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "legacy", issueId: "i1", status: "running" }]);
  let starts = 0;
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
    paseo: () => daemon.paseo,
    linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({ admission: async () => ({ ok: true as const }), start: async () => { starts += 1; return { agentId: "agent-1", warnings: [], provider: "claude/opus", target: "App", resumed: false, untrusted: false, plan: null }; } }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 1, claims: [] });
  const answer = await intake.accept({ id: "reply:s1:hello", kind: "reply", issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "Any update?", host: "mac", requestedAt: "2026-01-01T00:00:00Z" });
  assert.equal(answer.status, 202);
  await intake.idle();
  assert.equal(starts, 0);
  assert.deepEqual(daemon.sent, [{ agentId: "legacy", message: "Any update?" }]);
});

// TUC-1258 AC-5: an activation's message goes through the plugin's one checked answer path like
// every other Linear text. The sender's stable id (the forwarded envelope's id, the delivery
// POST's receipt) is its ref there; an activation names no author, so the text keeps the owner's
// precedence but is never recorded as the owner's answer.
test("a forwarded message reaches the agent once through the shared ledger, unattributed", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "legacy", issueId: "i1", status: "running" }]);
  const effects = { owner: 0, corrections: 0 };
  const replies = new PermissionReplies({ directory: home, daemon: async () => null });
  replies.recordEffects({
    ownerAnswered: async () => { effects.owner += 1; },
    correctLate: async () => { effects.corrections += 1; return { delivered: false, reply: "" }; },
    needsYou: async () => {},
  });
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
    paseo: () => daemon.paseo,
    linear: () => null, starter: () => null, launcher: () => null,
    replies,
  });

  // The delivery route of a host the activation was forwarded to: the POST's receipt is the ref.
  assert.deepEqual(await intake.deliverLocal("i1", "Any news?", "session:s2"), { ok: true });
  // The queue of that host: the forwarded envelope's id is.
  assert.equal((await intake.accept({ id: "reply:s1:hello", kind: "reply", issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "Any update?", host: "mac", requestedAt: "2026-01-01T00:00:00Z" })).status, 202);
  await intake.idle();

  assert.deepEqual(daemon.sent, [
    { agentId: "legacy", message: "Any news?" },
    { agentId: "legacy", message: "Any update?" },
  ]);
  assert.deepEqual([effects.owner, effects.corrections, daemon.answers], [0, 0, []], "an activation names no author: nothing here counts as the owner's answer");
});

// TUC-1258 AC-5: a forwarding host without a receipt (an older one) is still covered: the same
// ticket and text are the same delivery, another text is a new one.
test("without a receipt the same ticket and text reach the agent once", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "legacy", issueId: "i1", status: "running" }]);
  const replies = new PermissionReplies({ directory: home, daemon: async () => null });
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
    paseo: () => daemon.paseo,
    linear: () => null, starter: () => null, launcher: () => null,
    replies,
  });
  assert.deepEqual(await intake.deliverLocal("i1", "Any news?"), { ok: true });
  assert.deepEqual(await intake.deliverLocal("i1", "Any news?"), { ok: true });
  assert.deepEqual(daemon.sent, [{ agentId: "legacy", message: "Any news?" }], "the repeated text is answered from the shared record, not sent again");
  assert.deepEqual(await intake.deliverLocal("i1", "Another thing?"), { ok: true });
  assert.deepEqual(daemon.sent.map((entry) => entry.message), ["Any news?", "Another thing?"]);
});

// TUC-1258 AC-5/AC-19: the retry of a queued activation whose own answer was lost is answered from
// the checked path's record. It sends nothing again, and it cannot land on the question the agent
// asks in the meantime.
test("a queued activation whose answer was lost is retried without a second send, and never answers a newer question", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "legacy", issueId: "i1", status: "running" }]);
  const replies = new PermissionReplies({ directory: home, daemon: async () => null });
  let now = Date.parse("2026-01-01T00:00:00Z");
  let lost = true;
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {}, now: () => now,
    paseo: () => daemon.paseo,
    linear: () => null, starter: () => null, launcher: () => null,
    replies,
    deliver: async (paseo, agentId, text, origin, given) => {
      const result = await given.deliver(paseo, agentId, text, origin);
      // The message went out; the answer to this activation was lost (a crash between the send and
      // the queue's record). The sweep retries the same envelope.
      if (lost) { lost = false; throw new Error("the answer to this delivery was lost"); }
      return result;
    },
  });
  assert.equal((await intake.accept({ id: "reply:s1:hello", kind: "reply", issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "Any update?", host: "mac", requestedAt: "2026-01-01T00:00:00Z" })).status, 202);
  await intake.idle();
  assert.deepEqual(daemon.sent, [{ agentId: "legacy", message: "Any update?" }], "the message went out once");
  assert.equal((await intake.status()).pending, 1, "the lost answer kept the activation queued");

  // The agent can now be waiting for a newer question; the retry must not answer it.
  daemon.agents[0].pendingPermissions = [{ id: "q2", kind: "question", title: "Which one?", description: "A or B?", options: [{ label: "A" }, { label: "B" }] }];
  now += 60 * 60 * 1000;
  await intake.retry();
  assert.deepEqual(daemon.sent, [{ agentId: "legacy", message: "Any update?" }], "the retry sent nothing again");
  assert.deepEqual(daemon.answers, [], "the retry answered no question, the newer one included");
  const status = await intake.status();
  assert.deepEqual({ pending: status.pending, done: status.done }, { pending: 0, done: 1 }, "the retry settled the delivered activation");
});

// TUC-1258 AC-5/AC-13: a delivery Paseo refuses is reported to the sender, is never submitted
// again (the same receipt reports the same outcome), leaves no receipt behind, and keeps the
// activation queued instead of reaching the agent with anything later.
test("a refused delivery is reported, never submitted twice, and leaves the activation queued", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "legacy", issueId: "i1", status: "running" }]);
  daemon.agents[0].pendingPermissions = [{ id: "q1", provider: "omp", name: "ask", kind: "question", title: "Test runner", input: { questions: [{ header: "Runner", question: "Which runner?", options: [{ label: "node:test" }, { label: "vitest" }] }] } }];
  const submitted: string[] = [];
  const replies = new PermissionReplies({ directory: home, daemon: async () => ({ respondToPermissionAndWait: async (_agentId: string, requestId: string) => { submitted.push(requestId); throw new Error(`No pending permission request with id '${requestId}'`); } }) });
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
    paseo: () => daemon.paseo,
    linear: () => null, starter: () => null, launcher: () => null,
    replies,
  });
  const first = await intake.deliverLocal("i1", "Use node:test.", "session:s2");
  assert.equal(first.ok, false, "the daemon's refusal is reported to the sender");
  assert.deepEqual(await intake.deliverLocal("i1", "Use node:test.", "session:s2"), first, "the same receipt reports the same outcome");
  assert.deepEqual(submitted, ["q1"], "one submission, never a retry");
  assert.deepEqual(daemon.answers, [], "a host with a checked connection does not fall back to the untagged response");

  assert.equal((await intake.accept({ id: "reply:s1:hello", kind: "reply", issueId: "i1", identifier: "TUC-1", sessionId: "s1", text: "Any update?", host: "mac", requestedAt: "2026-01-01T00:00:00Z" })).status, 202);
  await intake.idle();
  assert.equal(submitted.length, 2, "the queued activation tried once, and only once");
  const pending = JSON.parse(await readFile(join(home, "activation-pending.json"), "utf8")) as { entries: Record<string, { state: string }> };
  assert.equal(pending.entries["reply:s1:hello"].state, "pending", "a refused message keeps the activation queued");
  const claims = JSON.parse(await readFile(join(home, "activation-claims.json"), "utf8").catch(() => "{\"receipts\":{}}")) as { receipts?: Record<string, string> };
  assert.deepEqual(claims.receipts ?? {}, {}, "a refused delivery leaves no receipt");
});

// TUC-1258 AC-5 (owner-approved addition): the draining host delivers a peer's message for a
// ticket its own allowlisted agent still owns through the same shared ledger, so a receipt that
// could not be written is covered by the record: the agent gets the message once, and what the
// host keeps (its allowlist) is not touched by a delivery.
test("the draining host's delivery survives a lost receipt through the shared ledger, without changing what it keeps", async (t) => {
  const home = await withHome(t);
  await writeFile(join(home, SEED_FILE), JSON.stringify({ agents: [{ agentId: "legacy", issueId: "i1", identifier: "TUC-1" }] }));
  const daemon = fakeDaemon([{ id: "legacy", issueId: "i1", status: "running" }]);
  const { request } = fakeRequest();
  const replies = new PermissionReplies({ directory: home, daemon: async () => null });
  const drain = new DrainRouter({
    settings: { read: async () => settingsFor({ mode: "remote", peer: PEER }) }, paseo: () => daemon.paseo, request, home, host: "mac", log: () => {},
    ghosts: async () => new Set<string>(),
    replies,
  });
  await drain.readyNow();
  const allowlistPath = join(home, "activation-allowlist.json");
  const before = JSON.parse(await readFile(allowlistPath, "utf8")) as { seed: string; seedSource: string; agents: Record<string, { issueId: string; identifier: string }> };
  assert.deepEqual(before.agents, { legacy: { issueId: "i1", identifier: "TUC-1" } });

  // The message goes out, the receipt cannot be written -- the crash window the peer's retry covers.
  await rm(allowlistPath);
  await mkdir(allowlistPath, { recursive: true });
  await assert.rejects(drain.deliver("i1", "Any news?", "session:s2"));
  await rm(allowlistPath, { recursive: true });

  assert.deepEqual(await drain.deliver("i1", "Any news?", "session:s2"), { ok: true }, "the retry is answered from the shared record");
  assert.deepEqual(daemon.sent, [{ agentId: "legacy", message: "Any news?" }], "the agent got the message exactly once");
  const after = JSON.parse(await readFile(allowlistPath, "utf8")) as { seed: string; seedSource: string; agents: Record<string, { issueId: string; identifier: string }>; receipts?: Record<string, string> };
  assert.deepEqual(after.agents, before.agents, "a delivery does not change the agents this host keeps");
  assert.deepEqual([after.seed, after.seedSource], [before.seed, before.seedSource]);
  assert.deepEqual(Object.keys(after.receipts ?? {}), ["session:s2"]);
});

test("the intake defers this host's own new session for a claimed ticket, and never consults the peer for the rest", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  const { request, calls } = fakeRequest();
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor({ mode: "local", peer: MAC }) }, home, host: "server087", log: () => {}, request,
    paseo: () => daemon.paseo,
    linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
    launcher: () => ({ gate: () => ({ release: () => {} }) }),
    starter: () => ({ admission: async () => ({ ok: true as const }), start: async () => { throw new Error("must not start"); } }),
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 1, claims: [{ issueId: "i1", identifier: "TUC-1", agentId: "a-run" }] });
  assert.deepEqual(await intake.take({ kind: "session", issueId: "i1", identifier: "TUC-1", sessionId: "s-new", text: "Over here too." }), { peer: "mac" });
  await intake.idle();
  assert.deepEqual(calls.map((call) => call.url), [`${MAC}/activation/deliver`]);
  assert.equal(await intake.take({ kind: "session", issueId: "i2", identifier: "TUC-2", sessionId: "s-2" }), null, "unclaimed tickets never contact the draining host");
});

test("the activation routes require the shared secret; a draining host refuses them", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  const idleDrain = { deliver: async () => ({ ok: false, reason: "no owner" }), status: async () => ({ mode: "local" as const, peer: null, host: "server087", seededAt: null, seedSource: null, seedRejected: 0, agents: 0, claims: 0, revision: 0, ackedRevision: 0, outbox: 0 }) };
  const route: ActivationRoute = activationEndpoints({
    settings: { read: async () => settingsFor() },
    secret: async () => SECRET,
    intake: new ActivationIntake({
      settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
      paseo: () => daemon.paseo,
      linear: () => ({ comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} }),
      launcher: () => ({ gate: () => ({ release: () => {} }) }),
      starter: () => ({ admission: async () => ({ ok: true as const }), start: async () => ({ agentId: "agent-1", warnings: [], provider: "p/opus", target: "App", resumed: false, untrusted: false, plan: null }) }),
    }),
    drain: idleDrain,
  });
  const call = (headers: Record<string, string>) => route({ method: "POST", path: "/activation", headers, body: "{}" });
  assert.equal((await call({}))!.status, 401);
  assert.equal((await call({ [ACTIVATION_HEADER]: "wrong" }))!.status, 401);
  assert.equal((await call({ [ACTIVATION_HEADER]: SECRET }))!.status, 400, "a malformed activation is refused, not started");
  assert.equal((await route({ method: "GET", path: "/activation/health", headers: { [ACTIVATION_HEADER]: SECRET }, body: "" }))!.status, 200);
  assert.equal(await route({ method: "GET", path: "/api/inbox", headers: { [ACTIVATION_HEADER]: SECRET }, body: "" }), null, "other review routes are not touched");

  const draining: ActivationRoute = activationEndpoints({
    settings: { read: async () => settingsFor({ mode: "remote", peer: PEER }) },
    secret: async () => SECRET,
    intake: new ActivationIntake({ settings: { read: async () => settingsFor({ mode: "remote", peer: PEER }) }, home, host: "mac", log: () => {}, paseo: () => daemon.paseo, linear: () => null, launcher: () => null, starter: () => null }),
    drain: { deliver: async () => ({ ok: false, reason: "no owner" }), status: async () => ({ mode: "remote" as const, peer: PEER, host: "mac", seededAt: "2026-01-01T00:00:00Z", seedSource: "daemon" as const, seedRejected: 0, agents: 1, claims: 1, revision: 1, ackedRevision: 1, outbox: 0 }) },
  });
  assert.equal((await draining({ method: "POST", path: "/activation", headers: { [ACTIVATION_HEADER]: SECRET }, body: "{}" }))!.status, 409);
  assert.equal((await draining({ method: "POST", path: "/activation/claims", headers: { [ACTIVATION_HEADER]: SECRET }, body: "{}" }))!.status, 409);
  const health = JSON.parse((await draining({ method: "GET", path: "/activation/health", headers: { [ACTIVATION_HEADER]: SECRET }, body: "" }))!.body) as { drain: { seedSource: string } };
  assert.equal(health.drain.seedSource, "daemon");
});

test("claims snapshots apply only a newer revision and a re-seed replaces the set", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([]);
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor() }, home, host: "server087", log: () => {},
    paseo: () => daemon.paseo, linear: () => null, launcher: () => null, starter: () => null,
  });
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 5, claims: [{ issueId: "i1", identifier: "TUC-1", agentId: "a1" }] });
  assert.ok(await intake.claimFor("i1"));
  await intake.applyClaims({ host: "mac", seed: "seed-1", revision: 4, claims: [] });
  assert.ok(await intake.claimFor("i1"), "a stale revision never prunes a claim");
  await intake.applyClaims({ host: "mac", seed: "seed-2", revision: 1, claims: [{ issueId: "i2", identifier: "TUC-2", agentId: "a2" }] });
  assert.equal(await intake.claimFor("i1"), null, "seeding again replaces the set");
  assert.ok(await intake.claimFor("i2"));
});

test("the session store names the ticket of a known agent, newest thread first", async (t) => {
  const home = await withHome(t);
  const store = new SessionStore(join(home, "sessions.json"));
  await store.put({ sessionId: "s-old", agentId: "a1", issueId: ISSUE, identifier: "TUC-1", createdAt: "2026-01-01T00:00:00Z", handled: [], review: null, offer: null });
  await store.put({ sessionId: "s-new", agentId: "a1", issueId: "i2", identifier: "TUC-2", createdAt: "2026-02-01T00:00:00Z", handled: [], review: null, offer: null });
  assert.deepEqual(await store.agentTicket("a1"), { issueId: "i2", identifier: "TUC-2" });
  assert.equal(await store.agentTicket("nobody"), null);
});

test("the launcher refuses a blocked start and lets an unblocked one through", async () => {
  const launcher = new Launcher(
    { detail: async () => { throw new Error("Linear was reached, so the guard passed"); }, markInProgress: async () => ({ changed: false }), finishedBlockers: async () => [] },
    undefined, undefined, undefined, undefined, undefined, undefined,
    async (issueId: string) => (issueId === "i1" ? "This host forwards new Linear work to server087." : null),
  );
  const input = { id: "i1", projectId: "p1", baseBranch: "refs/heads/main", provider: "claude/opus", instructions: "", markInProgress: false, requestId: "8a1f2c3d-0000-4000-8000-000000000001" };
  const daemon = fakeDaemon([]);
  (daemon.paseo as unknown as { projects: unknown }).projects = {
    list: async () => ({ projects: [{ projectId: "p1", projectRootPath: process.cwd(), projectKind: "git", projectCustomName: null, projectDisplayName: "App" }] }),
  };
  await assert.rejects(launcher.start(input, daemon.paseo), /forwards new Linear work to server087/);
  await assert.rejects(launcher.start({ ...input, id: "i2" }, daemon.paseo), /the guard passed/);
});

test("the secret never lands in settings.json and the patch stores it host-locally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paseo-activation-settings-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const settings = new Settings();
  const saved = await settings.patch({ activation: { mode: "remote", peer: PEER, secret: SECRET } });
  assert.deepEqual(saved.activation, { mode: "remote", peer: PEER });
  const file = JSON.parse(await readFile(join(root, "linear-tickets", "settings.json"), "utf8")) as { activation?: unknown };
  assert.deepEqual(file.activation, { mode: "remote", peer: PEER }, "the file holds the routing, not the secret");
  const cleared = await settings.patch({ activation: { secret: null } });
  assert.deepEqual(cleared.activation, { mode: "remote", peer: PEER });
  await assert.rejects(readFile(join(root, "linear-tickets", "activation-secret"), "utf8"));
});

test("an ordinary host starts without a drain handshake, but a configured peer gates new work", async (t) => {
  const home = await withHome(t);
  let peer: string | null = null;
  const intake = new ActivationIntake({
    settings: { read: async () => settingsFor({ mode: "local", peer }) },
    home, paseo: () => null, linear: () => null, starter: () => null, launcher: () => null, log: () => {},
  });
  const activation = { kind: "session" as const, issueId: ISSUE, identifier: "TUC-1", sessionId: "new" };
  assert.equal(await intake.take(activation), null);
  peer = MAC;
  assert.match((await intake.take(activation) as { held: string }).held, /has not registered/);
});

test("a queued activation never crosses during a sweep before claims are acknowledged", async (t) => {
  const home = await withHome(t);
  const daemon = fakeDaemon([{ id: "working", issueId: ISSUE }]);
  let acknowledge = false;
  const { request, calls } = fakeRequest((url) => url.endsWith("/activation/claims") && !acknowledge
    ? { ok: false, status: 503, text: "offline" }
    : { ok: true, status: 202 });
  const drain = drainFor(home, daemon, { request });
  const activation = { kind: "session" as const, issueId: "another", identifier: "TUC-2", sessionId: "s2" };
  assert.ok("held" in (await drain.take(activation))!);
  await drain.sweep();
  assert.equal((await drain.status()).outbox, 1);
  assert.deepEqual(calls.filter((call) => call.url.endsWith("/activation")), []);
  acknowledge = true;
  await drain.sweep();
  assert.equal((await drain.status()).outbox, 0);
  assert.equal(calls.filter((call) => call.url.endsWith("/activation")).length, 1);
});
