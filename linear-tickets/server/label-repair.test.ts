import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Dispatcher } from "./dispatch";
import { LabelRepair, type RepairRecord } from "./label-repair";
import { Launcher, SetupError } from "./launch";
import { LinearApiError, type IssueState, type LabeledIssue, type RepairCandidate } from "./linear";
import type { ProcessInspector } from "./process-liveness";
import { ProjectStore } from "./project-flow";
import { RateLimitedError } from "./rate-budget";
import { restartOrThrow, type RestartOptions, type RestartResult } from "./sessions";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-07T10:00:00Z");
const OWNER_URL = "https://linear.app/acme/profiles/owner";

type Agent = { id: string; status: string; provider: string; cwd: string; createdAt: string; updatedAt: string; labels: Record<string, string>; persistence?: { nativeHandle: string } };
// `outcome` of the next restart: "start" brings up a live agent, as restartFor would.
type Outcome = "start" | RestartResult;

const settingsFor = (label = "paseo", change: Partial<PluginSettings["activation"]> = {}) => ({
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["TUC"], label },
  writeback: DEFAULT_WRITEBACK,
  activation: { ...DEFAULT_ACTIVATION, mode: "local", ...change },
}) as PluginSettings;

// The repair logs each step; a test asserts on Linear, not on the log.
const quieted = new WeakSet<TestContext>();
function quiet(t: TestContext): void {
  if (quieted.has(t)) return;
  quieted.add(t);
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
}

// A world of tickets, agents, peer claims and queued activations around one LabelRepair. `at(m)`
// runs a pass m minutes after T0. Restarts go through the real launcher gate and the repair's
// `eligible` check, the way SessionRouter.restartFor runs them.
async function world(t: TestContext, options: { label?: string; pageSize?: number; inspect?: ProcessInspector } = {}) {
  quiet(t);
  const directory = await mkdtemp(join(tmpdir(), "label-repair-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const label = options.label ?? "paseo";
  let settings = settingsFor(label);
  let now = T0;
  const tickets = new Map<string, RepairCandidate>();
  const agents: Agent[] = [];
  const calls: string[] = [];
  const comments: string[] = [];
  const restarts: string[] = [];
  const outcomes: Outcome[] = [];
  const claims = new Set<string>();
  const pending = new Set<string>();
  const intakeState = { ready: true as boolean | Error };
  const fail = { comment: false, remove: 0 };
  let created = 0;
  const byId = (id: string) => tickets.get(id)!;
  const linear = {
    repairCandidates: async ({ labels, ids, queueBlockers }: { labels: string[]; teamKeys: string[]; ids: string[]; queueBlockers?: boolean }) => [...tickets.values()]
      .filter((ticket) => ids.includes(ticket.id) || (!["completed", "canceled"].includes(ticket.statusType) && (!queueBlockers || ticket.queueBlocker) && ticket.labels.some((item) => labels.some((name) => name.toLowerCase() === item.name.toLowerCase()))))
      .map((ticket) => ({ ...ticket, labels: [...ticket.labels] })),
    addLabel: async (id: string, name: string) => {
      calls.push(`${byId(id).identifier} +${name}`);
      if (!byId(id).labels.some((item) => item.name === name)) byId(id).labels.push({ id: name, name });
    },
    removeLabel: async (id: string, name: string) => {
      if (fail.remove) { fail.remove--; throw new Error("Linear is down"); }
      calls.push(`${byId(id).identifier} -${name}`);
      byId(id).labels = byId(id).labels.filter((item) => item.name !== name);
    },
    comment: async (id: string, body: string) => {
      if (fail.comment) throw new Error("Linear's hourly request limit is reached");
      comments.push(`${byId(id).identifier}: ${body}`);
    },
    issueState: async (id: string) => ({ ...byId(id), labels: [...byId(id).labels] }) as unknown as IssueState,
    userUrl: async () => OWNER_URL,
    viewerId: async () => "owner",
  };
  const paseo = { agents: { list: async ({ filter, page }: { filter: { labels: Record<string, string> }; page?: { limit?: number; cursor?: string } }) => {
    const mine = agents.filter((agent) => agent.labels["linear.issueId"] === filter.labels["linear.issueId"]);
    const size = options.pageSize ?? page?.limit ?? 200;
    const start = Number(page?.cursor ?? 0);
    const more = start + size < mine.length;
    return { entries: mine.slice(start, start + size).map((agent) => ({ agent })), pageInfo: { hasMore: more, nextCursor: more ? String(start + size) : null } };
  } } } as unknown as PaseoApi;
  const store = new ProjectStore(join(directory, "projects.json"));
  const launcher = new Launcher({} as never);
  const intake = {
    claimFor: async (id: string) => claims.has(id) ? { issueId: id, identifier: "", agentId: "mac-agent", host: "mac", claimedAt: "", updatedAt: "" } : null,
    pendingFor: async (id: string) => pending.has(id),
    claimsReady: async () => { if (intakeState.ready instanceof Error) throw intakeState.ready; return intakeState.ready; },
  };
  const restart = async (issueId: string, identifier: string, restartOptions: RestartOptions): Promise<RestartResult> => {
    restarts.push(identifier);
    const gate = launcher.gate(issueId);
    if (!gate) return { kind: "deferred", reason: "A launch for this ticket is under way." };
    try {
      const refused = await restartOptions.eligible?.();
      if (refused) return { kind: "deferred", reason: refused };
      const next = outcomes.shift() ?? "start";
      if (next !== "start") return next;
      const agentId = `new-${++created}`;
      agents.push(agent(agentId, issueId, "running", now));
      await linear.addLabel(issueId, `${label}-running`);
      return { kind: "started", agentId, marked: true };
    } finally {
      gate.release();
    }
  };
  const make = () => new LabelRepair({ linear, store, launcher, intake, restart, now: () => now, inspect: options.inspect });
  let repair = make();
  return {
    tickets, agents, calls, comments, restarts, outcomes, claims, pending, intakeState, fail, store, launcher, linear, paseo,
    get repair() { return repair; },
    settings: () => settings,
    setSettings: (next: PluginSettings) => { settings = next; },
    now: () => now,
    at: async (minutes: number) => { now = T0 + minutes * MINUTE; await repair.tick(paseo, settings); },
    // The paused poll's blocker-only pass (the dispatcher's fallback): m minutes after T0.
    blockers: async (minutes: number) => { now = T0 + minutes * MINUTE; await repair.tickQueueBlockers(paseo, settings); },
    // A reload of the plugin: the same projects.json, a new repair.
    reload: () => { repair = make(); },
    record: async (id = "i1"): Promise<RepairRecord | undefined> => (await store.repairs())[id],
    labels: (id = "i1") => byId(id).labels.map((item) => item.name).sort(),
    add: (n: number, labels: string[], change: Partial<RepairCandidate> = {}) => {
      tickets.set(`i${n}`, { id: `i${n}`, identifier: `TUC-${n}`, status: "Todo", statusType: "unstarted", projectId: null, openChildren: false, queueBlocker: false, labels: labels.map((name) => ({ id: name, name })), ...change });
    },
  };
}

function agent(id: string, issueId: string, status: string, createdAt = T0 - 60 * MINUTE, change: Partial<Agent> = {}): Agent {
  const at = new Date(createdAt).toISOString();
  return { id, status, provider: "claude", cwd: `/work/${id}`, createdAt: at, updatedAt: at, labels: { "linear.issueId": issueId }, ...change };
}

const VANISHED = "**No agent was working on this ticket.**";

test("a running label without an agent comes off after 15 minutes, once, and the ticket starts again; also with a custom trigger", async (t) => {
  for (const label of ["paseo", "agent"]) {
    const w = await world(t, { label });
    w.add(1, [`${label}-running`]);
    await w.at(0);
    await w.at(14);
    assert.deepEqual(w.calls, [], "nothing within the grace");
    assert.equal((await w.record())?.state, "watching");
    await w.at(16);
    assert.deepEqual(w.calls, [`TUC-1 -${label}-running`, `TUC-1 +${label}-running`], "removed under the gate, put back by the new agent's start");
    assert.deepEqual(w.restarts, ["TUC-1"]);
    assert.equal(w.comments.length, 1);
    assert.match(w.comments[0], new RegExp(`carried \`${label}-running\` for 15 minutes.*starts a new agent; it tries up to 3 times\\.`));
    const record = await w.record();
    assert.equal(record?.state, "resolved");
    assert.equal(record?.attempts, 1);
    assert.equal(record?.startedAgentId, "new-1");
    await w.at(20);
    await w.at(60);
    assert.deepEqual(w.restarts, ["TUC-1"], "the new agent works on it");
    assert.equal(w.comments.length, 1);
  }
});

test("a ghost agent counts as gone; the same agent with its process does not", async (t) => {
  const ghost = agent("ghost", "i1", "idle", T0 - 60 * MINUTE, { provider: "omp", cwd: "/work/tuc-1", persistence: { nativeHandle: "/sessions/ghost.jsonl" } });
  let ps = "";
  const inspect: ProcessInspector = { processes: async () => ps, cwd: async () => "/elsewhere", canonicalPath: async (path) => path };
  const w = await world(t, { inspect });
  w.add(1, ["paseo-running"]);
  w.agents.push(ghost);
  ps = "4242 omp --mode rpc-ui --session /sessions/ghost.jsonl\n";
  await w.at(0);
  await w.at(30);
  assert.deepEqual(w.calls, []);
  assert.equal(await w.record(), undefined, "a working process: no incident");
  ps = "";
  await w.at(32);
  await w.at(48);
  assert.deepEqual(w.restarts, ["TUC-1"]);
  assert.deepEqual(w.labels(), ["paseo-running"], "the replacement carries the label");
});

test("an agent on the other host, a queued activation, a start under way or a stopped agent is never a vanished one", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-running"]);
  w.add(2, ["paseo-running"]);
  w.add(3, ["paseo-running"]);
  w.add(4, ["paseo-running"]);
  w.add(5, ["paseo-running"]);
  w.claims.add("i1");
  w.pending.add("i2");
  w.agents.push(agent("closed", "i3", "closed"), agent("errored", "i4", "error"));
  const gate = w.launcher.gate("i5");
  for (const minutes of [0, 20, 60, 600]) await w.at(minutes);
  gate?.release();
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.restarts, []);
  assert.deepEqual(w.comments, []);
});

test("without the peer's claims, with unreadable claims, or on a draining host the pass changes nothing", async (t) => {
  for (const setup of ["handshake", "unreadable", "remote"] as const) {
    const w = await world(t);
    w.add(1, ["paseo-running"]);
    w.add(2, ["paseo-failed"]);
    if (setup === "handshake") w.intakeState.ready = false;
    if (setup === "unreadable") w.intakeState.ready = new Error("activation-claims.json is not usable");
    if (setup === "remote") w.setSettings(settingsFor("paseo", { mode: "remote" }));
    for (const minutes of [0, 20, 200]) await w.at(minutes);
    assert.deepEqual([w.calls, w.restarts, w.comments], [[], [], []], setup);
    assert.deepEqual(await w.store.repairs(), {}, setup);
  }
});

test("outside the work states, or held, the running label only comes off, with the comment for that state", async (t) => {
  const cases: [Partial<RepairCandidate>, string[], RegExp][] = [
    [{ status: "Needs input", statusType: "started" }, [], /your answer here starts one\.$/],
    [{ status: "In Review", statusType: "started" }, [], /The pull request watch starts a new agent/],
    [{ status: "Ready to merge", statusType: "started" }, [], /The pull request watch starts a new agent/],
    [{}, ["paseo-hold"], /no agent starts while the ticket is held\.$/],
    [{}, ["paseo-manual"], /no agent starts while the ticket is held\.$/],
    [{ status: "Testing", statusType: "started" }, [], /while the ticket is in Testing\.$/],
  ];
  for (const [state, extra, comment] of cases) {
    const w = await world(t);
    w.add(1, ["paseo-running", ...extra], state);
    await w.at(0);
    await w.at(16);
    assert.deepEqual(w.calls, ["TUC-1 -paseo-running"]);
    assert.deepEqual(w.restarts, []);
    assert.equal(w.comments.length, 1);
    assert.ok(w.comments[0].startsWith(`TUC-1: ${VANISHED}`));
    assert.match(w.comments[0], comment);
    assert.equal((await w.record())?.state, "resolved");
    await w.at(40);
    assert.deepEqual(w.restarts, []);
  }
});

test("Planning and In Progress restart; one restart per pass", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-running"], { status: "Planning", statusType: "started" });
  w.add(2, ["paseo-running"], { status: "In Progress", statusType: "started" });
  await w.at(0);
  await w.at(16);
  assert.deepEqual(w.restarts, ["TUC-1"], "both labels come off, one restart");
  assert.ok(w.calls.includes("TUC-2 -paseo-running"));
  await w.at(18);
  assert.deepEqual(w.restarts, ["TUC-1", "TUC-2"]);
});

test("a vanished agent is restarted at most three times, 15 minutes apart; a no-start gives the attempt back; a reload keeps the count", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-running"]);
  const failure = (n: number): RestartResult => ({ kind: "failed", error: new Error(`Transport closed ${n}`) });
  w.outcomes.push({ kind: "deferred", reason: "Waiting for TUC-9 to finish." }, failure(1), { kind: "forwarded", peer: "mac" }, { kind: "skipped" }, failure(2), failure(3));
  await w.at(0);
  await w.at(16);
  assert.equal((await w.record())?.attempts, 0, "deferred: given back");
  await w.at(18);
  assert.equal((await w.record())?.attempts, 1, "failed: kept, the next one 15 minutes later");
  await w.at(30);
  assert.equal(w.restarts.length, 2);
  await w.at(34);
  assert.equal((await w.record())?.attempts, 1, "forwarded: given back");
  w.reload();
  await w.at(36);
  assert.equal((await w.record())?.attempts, 1, "skipped: given back");
  await w.at(38);
  assert.equal((await w.record())?.attempts, 2);
  w.reload();
  await w.at(50);
  assert.equal(w.restarts.length, 5, "still within 15 minutes of the last failure");
  await w.at(54);
  const record = await w.record();
  assert.equal(record?.state, "exhausted");
  assert.equal(record?.attempts, 3);
  assert.equal(w.comments.length, 2);
  assert.match(w.comments[1], /^TUC-1: \*\*Paseo could not start an agent for this ticket\.\*\* .*3 times.*Last failure: Transport closed 3\. Start an agent for it from the Linear tickets sidebar, or add the `paseo` label to try again\.$/);
  w.reload();
  for (const minutes of [70, 200, 2000]) await w.at(minutes);
  assert.equal(w.restarts.length, 6, "no fourth restart, also after a reload");
  assert.equal(w.comments.length, 2);
});

test("a failed start is retried 10, 30 and 90 minutes after each failure, then the owner is mentioned once and the label stays", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-failed"]);
  w.outcomes.push(...[1, 2, 3].map((n): RestartResult => ({ kind: "failed", error: new Error(`Agent creation could not be confirmed (${n})`) })));
  await w.at(0);
  await w.at(8);
  assert.deepEqual(w.restarts, []);
  await w.at(10);
  assert.equal(w.restarts.length, 1);
  await w.at(38);
  assert.equal(w.restarts.length, 1);
  await w.at(40);
  assert.equal(w.restarts.length, 2);
  await w.at(128);
  assert.equal(w.restarts.length, 2);
  await w.at(130);
  assert.equal(w.restarts.length, 3);
  assert.equal((await w.record())?.state, "exhausted");
  assert.deepEqual(w.labels(), ["paseo-failed"]);
  assert.deepEqual(w.comments, [`TUC-1: ${OWNER_URL} **Paseo could not start an agent for this ticket**, also after 3 more tries (10, 30 and 90 minutes after each failure). Last failure: Agent creation could not be confirmed (3). The ticket stays \`paseo-failed\`: start an agent from the Linear tickets sidebar, or add the \`paseo\` label.`]);
  for (const minutes of [200, 3000]) await w.at(minutes);
  assert.equal(w.restarts.length, 3);
  assert.equal(w.comments.length, 1);
});

test("a queue blocker's failed start is retried while the background share is paused: a pause, a 5xx and an unreachable API give the attempt back, and the owner is never mentioned", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-failed"], { queueBlocker: true });
  w.outcomes.push(
    { kind: "failed", error: new RateLimitedError("app", T0 + 10 * MINUTE, "reserve") },
    { kind: "failed", error: new LinearApiError("The Linear API request failed (HTTP 500). Try again.", 500) },
    { kind: "failed", error: new Error("Could not reach the Linear API. Check the host's network connection and try again.") },
    "start",
  );
  await w.blockers(0);
  assert.deepEqual(w.restarts, [], "the first pass only opens the incident");
  await w.blockers(10);
  assert.deepEqual(w.restarts, ["TUC-1"]);
  assert.deepEqual([(await w.record())?.state, (await w.record())?.attempts], ["watching", 0], "the pause did not count against its restarts");
  await w.blockers(15);
  assert.equal(w.restarts.length, 1, "the retry waits the failed backoff");
  await w.blockers(20);
  await w.blockers(30);
  assert.deepEqual((await w.record())?.state, "watching", "a 5xx and an unreachable API did not count either");
  assert.equal((await w.record())?.attempts, 0);
  await w.blockers(40);
  assert.deepEqual(w.restarts.length, 4);
  assert.deepEqual(w.labels(), ["paseo-running"]);
  assert.equal(w.comments.length, 1);
  assert.ok(!w.comments.some((comment) => comment.includes(OWNER_URL)), "no owner mention");
});

test("a queue blocker whose retries ended in a setup error is not retried: today's mention-once and stop", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-failed"], { queueBlocker: true });
  const setup = new SetupError("No Paseo project is mapped to the TUC team. Start one agent for it from the Linear tickets sidebar (that saves the mapping), then add the \"paseo\" label again.");
  w.outcomes.push({ kind: "failed", error: setup });
  await w.blockers(0);
  await w.blockers(10);
  assert.deepEqual(w.restarts, ["TUC-1"]);
  assert.deepEqual([(await w.record())?.state, (await w.record())?.setup], ["exhausted", true]);
  assert.deepEqual(w.labels(), ["paseo-failed"]);
  assert.equal(w.comments.filter((comment) => comment.includes(OWNER_URL)).length, 1);
  for (const minutes of [60, 2000]) await w.blockers(minutes);
  assert.equal(w.restarts.length, 1, "it does not retry");
});

test("the blocker pass reads only the marker-filtered tickets: non-blockers are left to the full pass", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-failed"], { queueBlocker: true });
  w.add(2, ["paseo-failed"]);
  w.outcomes.push("start", "start");
  await w.blockers(0);
  assert.deepEqual(Object.keys(await w.store.repairs()), ["i1"], "only the blocker opened an incident");
  await w.blockers(10);
  assert.deepEqual(w.restarts, ["TUC-1"]);
  assert.equal(await w.record("i2"), undefined, "the non-blocker was not read or repaired");
});

test("a retry that starts an agent removes the failed label and says so", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-failed"]);
  await w.at(0);
  await w.at(10);
  assert.deepEqual(w.labels(), ["paseo-running"]);
  assert.deepEqual(w.comments, ["TUC-1: Paseo started an agent for this ticket on retry 1 of 3 after its failed start, and removed `paseo-failed`."]);
  assert.equal((await w.record())?.state, "resolved");
});

test("a start that fails on setup is not retried, for either kind: the ticket is marked failed and the owner mentioned once", async (t) => {
  const setup = new SetupError("No Paseo project is mapped to the TUC team. Start one agent for it from the Linear tickets sidebar (that saves the mapping), then add the \"paseo\" label again.");
  const w = await world(t);
  w.add(1, ["paseo-failed"]);
  w.add(2, ["paseo-running"]);
  w.outcomes.push({ kind: "failed", error: setup }, { kind: "failed", error: setup });
  await w.at(0);
  await w.at(10);
  await w.at(16);
  assert.deepEqual(w.restarts, ["TUC-1", "TUC-2"]);
  assert.deepEqual(w.labels("i1"), ["paseo-failed"]);
  assert.deepEqual(w.labels("i2"), ["paseo-failed"], "the running orphan's start failed: it shows so");
  const mentions = w.comments.filter((comment) => comment.includes(OWNER_URL));
  assert.deepEqual(mentions.map((comment) => comment.slice(0, 6)), ["TUC-1:", "TUC-2:"]);
  assert.match(mentions[0], /until its setup is fixed:\*\* No Paseo project is mapped to the TUC team\. .* add the "paseo" label again\. It does not retry; the ticket is marked `paseo-failed`\.$/);
  assert.equal((await w.record("i2"))?.setup, true);
  w.reload();
  for (const minutes of [60, 200, 2000]) await w.at(minutes);
  assert.equal(w.restarts.length, 2);
  assert.equal(w.comments.filter((comment) => comment.includes(OWNER_URL)).length, 2);
});

test("a failed label on a ticket that has an agent by now comes off; a failed removal is retried without a second comment", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-failed"]);
  w.agents.push(agent("closed", "i1", "closed"));
  w.fail.remove = 1;
  await w.at(0);
  assert.deepEqual(w.comments, []);
  await w.at(2);
  assert.deepEqual(w.labels(), []);
  assert.deepEqual(w.comments, ["TUC-1: Paseo removed `paseo-failed`: an agent works on this ticket now."]);
  await w.at(4);
  assert.equal(w.comments.length, 1);
  assert.deepEqual(w.restarts, []);
});

test("both labels: with an agent only the failed one comes off; without one both come off and the restart leaves only running", async (t) => {
  const owned = await world(t);
  owned.add(1, ["paseo-running", "paseo-failed"]);
  owned.claims.add("i1");
  await owned.at(0);
  await owned.at(30);
  assert.deepEqual(owned.labels(), ["paseo-running"]);
  assert.deepEqual(owned.restarts, []);

  const orphan = await world(t);
  orphan.add(1, ["paseo-running", "paseo-failed"]);
  await orphan.at(0);
  await orphan.at(16);
  assert.deepEqual(orphan.calls.slice(0, 2), ["TUC-1 -paseo-running", "TUC-1 -paseo-failed"]);
  assert.deepEqual(orphan.restarts, ["TUC-1"]);
  assert.deepEqual(orphan.labels(), ["paseo-running"]);
  assert.equal(orphan.comments.length, 1);
});

test("a busy gate or an agent that comes up at the last look keeps the label; a ticket that changed during admission gets no agent", async (t) => {
  const busy = await world(t);
  busy.add(1, ["paseo-running"]);
  await busy.at(0);
  const gate = busy.launcher.gate("i1");
  await busy.at(16);
  assert.deepEqual(busy.calls, [], "another start holds the gate");
  gate?.release();

  // An agent that appears between the first look and the look under the gate.
  const late = await world(t);
  late.add(1, ["paseo-running"]);
  await late.at(0);
  const list = late.paseo.agents.list;
  let reads = 0;
  late.paseo.agents.list = (async (input: Parameters<typeof list>[0]) => {
    if (++reads === 2) late.agents.push(agent("late", "i1", "initializing", T0));
    return list(input);
  }) as typeof list;
  await late.at(16);
  assert.deepEqual(late.calls, []);
  assert.deepEqual(late.restarts, []);

  // Refreshed right before the start: moved to Needs input, held, claimed or queued meanwhile.
  for (const change of ["needs-input", "hold", "claim", "pending", "closed"] as const) {
    const w = await world(t);
    w.add(1, ["paseo-running"]);
    await w.at(0);
    const eligible = w.linear.issueState;
    w.linear.issueState = async (id: string) => {
      const ticket = w.tickets.get(id)!;
      if (change === "needs-input") Object.assign(ticket, { status: "Needs input", statusType: "started" });
      if (change === "hold") ticket.labels.push({ id: "h", name: "paseo-hold" });
      if (change === "claim") w.claims.add(id);
      if (change === "pending") w.pending.add(id);
      if (change === "closed") Object.assign(ticket, { status: "Done", statusType: "completed" });
      return eligible(id);
    };
    await w.at(16);
    assert.deepEqual(w.restarts, ["TUC-1"], change);
    assert.equal(w.agents.length, 0, `${change}: no new agent`);
    assert.equal((await w.record())?.attempts ?? 0, 0, `${change}: the attempt is given back`);
  }
});

test("an interrupted restart waits out the grace, then counts; one that left an agent resolves; neither is given back", async (t) => {
  const seed = (record: Partial<RepairRecord>): Record<string, RepairRecord> => ({ i1: { incident: "inc-1", identifier: "TUC-1", kind: "running", state: "restarting", attempts: 1, orphanSince: new Date(T0 - 20 * MINUTE).toISOString(), attemptAt: new Date(T0).toISOString(), cleared: true, comments: ["cleanup"], log: [], ...record } });
  const lost = await world(t);
  lost.add(1, []);
  await lost.store.updateRepairs(() => seed({}));
  await lost.at(10);
  assert.equal((await lost.record())?.state, "restarting", "a start may still be under way");
  await lost.at(15);
  const counted = await lost.record();
  assert.deepEqual([counted?.state, counted?.attempts, counted?.orphanSince], ["watching", 1, new Date(T0).toISOString()]);
  await lost.at(17);
  assert.equal(lost.restarts.length, 1, "the next restart came 15 minutes after the interrupted one");
  assert.equal((await lost.record())?.attempts, 2);

  const last = await world(t);
  last.add(1, []);
  await last.store.updateRepairs(() => seed({ attempts: 3 }));
  await last.at(16);
  assert.equal((await last.record())?.state, "exhausted", "never a fourth attempt");
  assert.deepEqual(last.restarts, []);
  assert.equal(last.comments.length, 1);

  const came = await world(t);
  came.add(1, ["paseo-failed"]);
  came.agents.push(agent("started", "i1", "running", T0));
  await came.store.updateRepairs(() => seed({}));
  await came.at(2);
  const resolved = await came.record();
  assert.deepEqual([resolved?.state, resolved?.attempts, resolved?.startedAgentId], ["resolved", 1, "started"]);
  assert.deepEqual(came.labels(), ["paseo-running"]);
});

test("an agent that vanishes again within a day continues the incident; one started by the owner after it gave up begins a new one", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-running"]);
  await w.at(0);
  await w.at(16);
  assert.equal((await w.record())?.attempts, 1);
  w.agents.length = 0;
  w.outcomes.push({ kind: "failed", error: new Error("no") }, { kind: "failed", error: new Error("no") });
  await w.at(60);
  await w.at(76);
  assert.equal(w.comments.length, 1, "the same incident: no second removal comment");
  await w.at(92);
  assert.equal((await w.record())?.state, "exhausted", "the count went on: 1 + 2");
  // The owner starts an agent; when it vanishes, that is a new incident.
  w.agents.push(agent("owners", "i1", "running", T0 + 100 * MINUTE));
  w.tickets.get("i1")!.labels.push({ id: "r", name: "paseo-running" });
  await w.at(102);
  assert.equal(await w.record(), undefined);
  w.agents.length = 0;
  await w.at(104);
  const fresh = await w.record();
  assert.deepEqual([fresh?.state, fresh?.attempts], ["watching", 0]);
});

test("the owner's trigger label resets an exhausted incident before dispatch consumes it; the failed start then gets fresh retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = await world(t);
  w.add(1, []);
  await w.store.updateRepairs(() => ({ i1: { incident: "old", identifier: "TUC-1", kind: "running", state: "exhausted", attempts: 3, exhaustedAt: new Date(T0 - HOURS(5)).toISOString(), cleared: true, comments: ["cleanup", "cap"], log: [] } }));
  w.tickets.get("i1")!.labels.push({ id: "p", name: "paseo" });
  const labeled = (): LabeledIssue[] => [...w.tickets.values()].filter((ticket) => ticket.labels.some((item) => item.name === "paseo")).map((ticket) => ({ id: ticket.id, identifier: ticket.identifier, teamKey: "TUC", priority: 0, labels: ticket.labels, openChildren: false }));
  const dispatcher = new Dispatcher({
    linear: { labeledIssues: async () => labeled(), addLabel: w.linear.addLabel, removeLabel: w.linear.removeLabel, comment: w.linear.comment },
    starter: { admission: async () => ({ ok: true as const }), start: async () => { throw new Error("Transport closed"); } },
    launcher: w.launcher,
    settings: { read: async () => w.settings() },
    repairs: w.repair,
  });
  dispatcher.attach(w.paseo);
  await dispatcher.tick();
  dispatcher.stop();
  assert.deepEqual(w.labels(), ["paseo-failed"]);
  const fresh = await w.record();
  assert.deepEqual([fresh?.state, fresh?.attempts, fresh?.kind, fresh?.comments], ["watching", 0, "failed", undefined]);
  assert.notEqual(fresh?.incident, "old");
  await w.at(10);
  assert.deepEqual(w.restarts, ["TUC-1"], "retry 1 of a fresh backoff");
  assert.deepEqual(w.labels(), ["paseo-running"]);
});

test("a failed sidebar start on an exhausted label-less orphan begins a new incident that restarts it", async (t) => {
  const w = await world(t);
  w.add(1, []);
  await w.store.updateRepairs(() => ({ i1: { incident: "old", identifier: "TUC-1", kind: "running", state: "exhausted", attempts: 3, exhaustedAt: new Date(T0 - HOURS(1)).toISOString(), cleared: true, comments: ["cleanup", "cap"], log: [] } }));
  await w.repair.ownerRetried("TUC-1");
  await w.at(0);
  assert.equal((await w.record())?.orphanSince, new Date(T0).toISOString());
  await w.at(16);
  assert.deepEqual(w.restarts, ["TUC-1"]);
  assert.equal(w.comments.length, 0, "no label to remove, so nothing to say");
  await assert.doesNotReject(w.repair.ownerRetried("TUC-404"), "no record: nothing to reset");
  assert.deepEqual(Object.keys(await w.store.repairs()), ["i1"]);
});

test("a failed comment never blocks the label change; a legacy planner label no longer shields a ticket; trigger, group and closed tickets are left alone", async (t) => {
  const w = await world(t);
  w.add(1, ["paseo-running"]);
  w.add(2, ["paseo-running", "paseo"]);
  w.add(3, ["paseo-running", "paseo-planner"]);
  w.add(4, ["paseo-running"], { openChildren: true });
  w.add(5, ["paseo-running"], { status: "Done", statusType: "completed" });
  w.fail.comment = true;
  await w.at(0);
  await w.at(16);
  // TUC-3 is repaired like TUC-1: the old `paseo-planner` label is no longer recognized, and only
  // one ticket restarts per pass.
  assert.deepEqual(w.calls, ["TUC-1 -paseo-running", "TUC-1 +paseo-running", "TUC-3 -paseo-running"]);
  assert.deepEqual(w.restarts, ["TUC-1"]);
  w.fail.comment = false;
  await w.at(18);
  assert.deepEqual(w.calls, ["TUC-1 -paseo-running", "TUC-1 +paseo-running", "TUC-3 -paseo-running", "TUC-3 +paseo-running"]);
  assert.deepEqual(w.restarts, ["TUC-1", "TUC-3"], "the next pass restarts TUC-3");
  assert.deepEqual(w.comments, [], "claimed once: a lost comment is not posted twice");
  assert.deepEqual(Object.keys(await w.store.repairs()), ["i1", "i3"]);
});

test("a live agent on the second page of the ticket's agents is found", async (t) => {
  const w = await world(t, { pageSize: 1 });
  w.add(1, ["paseo-running"]);
  w.agents.push(agent("archived-ish", "i1", "closed"), agent("live", "i1", "running"));
  w.agents[0].labels["paseo.parent-agent-id"] = "x";
  await w.at(0);
  await w.at(30);
  assert.deepEqual(w.restarts, []);
  assert.equal(await w.record(), undefined);
});

test("the projects and the repairs share projects.json without losing each other's records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "label-repair-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(join(directory, "projects.json"));
  const erp: RepairRecord = { incident: "x", identifier: "TUC-1", kind: "failed", state: "exhausted", attempts: 3, failedSince: "a", attemptAt: "b", startedAgentId: "c", exhaustedAt: "d", resolvedAt: "e", cleared: true, owner: true, setup: true, lastReason: "f", comments: ["cap"], log: [{ at: "g", action: "h" }] };
  await store.updateRepairs(() => ({ i1: erp }));
  await Promise.all([store.update("p1", () => ({ planner: null, planned: ["i1"] })), store.updateRepairs((current) => ({ ...current, i2: { ...erp, identifier: "TUC-2" } }))]);
  const again = new ProjectStore(join(directory, "projects.json"));
  assert.deepEqual(await again.all(), { p1: { planner: null, planned: ["i1"] } }, "the projects' view has no repairs");
  assert.deepEqual((await again.repairs()).i1, erp);
  assert.equal((await again.repairs()).i2.identifier, "TUC-2");
});

test("the project flow's restart throws for a deferred or failed result only", () => {
  assert.throws(() => restartOrThrow({ kind: "deferred", reason: "Waiting for TUC-9 to finish." }), /^Error: Waiting for TUC-9 to finish\.$/);
  assert.throws(() => restartOrThrow({ kind: "failed", error: new SetupError("Select an available base branch for this project.") }), SetupError);
  for (const result of [{ kind: "started", agentId: "a", marked: true }, { kind: "live" }, { kind: "forwarded", peer: "mac" }, { kind: "skipped" }] as RestartResult[]) {
    assert.doesNotThrow(() => restartOrThrow(result), result.kind);
  }
});

function HOURS(n: number): number {
  return n * 60 * MINUTE;
}
