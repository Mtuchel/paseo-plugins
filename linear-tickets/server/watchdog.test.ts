import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HandoverRecord } from "./handover";
import type { OpenPull } from "./pr-watch";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import type { SessionLink } from "./sessions";
import {
  historyOf, importHistory, readActivity, Watchdog, WATCHDOG_LABEL, WATCHDOG_LINES, WATCHDOG_MENTION, WatchdogStore,
  type ActivityResult, type WatchdogDeps, type WatchdogOutcome, type WatchdogRequest, type WatchedAgent,
} from "./watchdog";

const ISSUE = { id: "issue-1", identifier: "TUC-1" };
const MINUTE = 60_000;
const T0 = Date.parse("2026-10-07T08:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();

const settings = (change: Partial<PluginSettings> = {}): PluginSettings => ({
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp", launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
  dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE,
  cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, ...change,
});

const agent = (id: string, change: Partial<WatchedAgent> = {}): WatchedAgent => ({
  id, provider: "omp", cwd: "/repo/wt", status: "running", createdAt: iso(T0 - 60 * MINUTE), updatedAt: iso(T0), lastUserMessageAt: null,
  pendingPermissions: [], title: `${ISSUE.identifier}: work`, labels: { "linear.issueId": ISSUE.id, "linear.identifier": ISSUE.identifier },
  persistence: { provider: "omp", sessionId: `native-${id}`, nativeHandle: `/sessions/${id}.jsonl` },
  activeTurn: { turnId: "turn-1", startedAt: iso(T0) },
  ...change,
} as WatchedAgent);

const record = (change: Partial<HandoverRecord> = {}): HandoverRecord => ({
  issueId: ISSUE.id, identifier: ISSUE.identifier, agentId: "agent-1", agentTitle: "work", branch: "mtuchel/tuc-1-work", worktreePath: "/repo/wt",
  lastCommit: null, summaries: [], links: {}, status: "working", progressCommentId: null, resumedFrom: null, updatedAt: iso(T0), ...change,
});

const pull = (change: Partial<OpenPull> = {}): OpenPull => ({
  number: 7, url: "https://github.com/o/r/pull/7", title: "TUC-1: work", headBranch: "mtuchel/tuc-1-work", headSha: "abc", baseBranch: "main", trunk: "main", draft: false, labels: [], ...change,
});
// What a test changes between polls.
type HarnessState = {
  now: number;
  roots: WatchedAgent[];
  ghosts: Set<string>;
  activity: ActivityResult;
  status: { status: string; statusType: string; labels: string[] };
  pulls: OpenPull[] | null;
  records: HandoverRecord[];
  thread: SessionLink | null;
  settings: PluginSettings;
  answer: (request: WatchdogRequest) => Promise<WatchdogOutcome>;
};
type Harness = { state: HarnessState; store: WatchdogStore };

// The watchdog against fakes: one ticket whose root agents the test sets, the native evidence it
// reads (`activity`), and a router that re-checks, claims and then answers as `answer` says.
async function harness(options: { settings?: PluginSettings } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-"));
  const store = new WatchdogStore(join(directory, "watchdog.json"));
  const state: HarnessState = {
    now: T0,
    roots: [agent("agent-1")],
    ghosts: new Set<string>(),
    activity: { ok: true, activity: { progressAt: T0, touchedAt: T0, head: "h1", awaitingChild: false } },
    status: { status: "In Progress", statusType: "started", labels: [] },
    pulls: [],
    records: [record()],
    thread: null,
    settings: options.settings ?? settings(),
    answer: async () => ({ kind: "done" }),
  };
  const acts: { action: string; text: string; marker: string; claimedBefore: boolean }[] = [];
  const said: string[] = [];
  const comments: string[] = [];
  const sessions = {
    watchdogRoots: async () => new Map(state.roots.length ? [[ISSUE.id, { issueId: ISSUE.id, identifier: ISSUE.identifier, roots: state.roots, ghosts: state.ghosts }]] : []),
    // As SessionRouter.watchdogAct: the deep check, then the claim, then the effect.
    watchdogAct: async (request: WatchdogRequest): Promise<WatchdogOutcome> => {
      const current = state.roots.find((item) => item.id === request.rootId) ?? null;
      const reason = await request.check(current, true);
      if (reason) return { kind: "skipped", reason, end: true };
      await request.claim();
      const claimed = (await store.read()).tickets[ISSUE.id]?.cycle?.claim;
      acts.push({ action: request.action, text: request.text, marker: request.marker, claimedBefore: claimed?.state === "claimed" && claimed.marker === request.marker });
      return state.answer(request);
    },
    watchdogThread: async () => state.thread,
    sessionFor: async (agentId: string): Promise<SessionLink | null> => ({ sessionId: `s-${agentId}`, agentId, issueId: ISSUE.id, identifier: ISSUE.identifier, createdAt: iso(T0), handled: [], review: null, offer: null }),
    say: async (_sessionId: string, _type: string, body: string) => { said.push(body); },
  };
  const linear = {
    issueState: async () => ({ id: ISSUE.id, identifier: ISSUE.identifier, status: state.status.status, statusType: state.status.statusType, statusId: "s", teamId: "t", projectId: null, creatorId: null, labels: state.status.labels.map((name) => ({ id: name, name })), blockedBy: [], priority: 0, createdAt: iso(T0), unblocks: 0, attachmentUrls: [] }),
    comment: async (_issueId: string, body: string) => { comments.push(body); },
    hasComment: async (_issueId: string, mark: string) => comments.some((body) => body.includes(mark)),
    viewerId: async () => "owner-1",
    userUrl: async () => "https://linear.app/t/profiles/owner",
  };
  const deps: WatchdogDeps = {
    store, sessions, linear, settings: { read: async () => state.settings },
    handover: { all: async () => state.records }, needsYou: { all: async () => [] },
    activity: async () => state.activity, now: () => state.now,
  };
  const watchdog = new Watchdog(deps);
  const reserved = new Set<string>();
  const poll = async (minutes?: number) => {
    if (minutes !== undefined) state.now = T0 + minutes * MINUTE;
    await watchdog.pass({ records: state.records, reserved, pulls: async () => state.pulls });
  };
  const progress = (at: number) => {
    const head = state.activity.ok ? state.activity.activity.head : null;
    state.activity = { ok: true, activity: { progressAt: at, touchedAt: at, head, awaitingChild: false } };
  };
  return { directory, store, state, deps, acts, said, comments, watchdog, poll, progress, reserved, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const quiet = (t: { mock: { method: (object: object, name: string, impl: () => void) => unknown } }) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
};

test("a silent running agent is steered, stopped, reloaded and replaced on schedule, then the owner is mentioned once", async (t) => {
  quiet(t);
  const h = await harness();
  await h.poll(44);
  assert.equal(h.acts.length, 0, "44 quiet minutes are not silence yet");
  await h.poll(46);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer"]);
  assert.ok(h.acts[0].claimedBefore, "the step is claimed before its effect");
  assert.ok(h.reserved.has("agent-1"), "the rest of the poll leaves the agent alone");
  assert.deepEqual(h.said, [WATCHDOG_LINES.steer]);
  const [file] = [(await h.store.read()).tickets[ISSUE.id]];
  assert.equal(file.starts.length, 1, "the cycle counts once it starts");

  await h.poll(65);
  assert.equal(h.acts.length, 1, "the steer's 20 minutes are not over");
  await h.poll(67);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer", "interrupt"]);
  // The interrupt's resume opened a new turn: the watchdog's own transition, not someone else's.
  h.state.roots = [agent("agent-1", { activeTurn: { turnId: "turn-2", startedAt: iso(T0 + 67 * MINUTE) } })];
  await h.poll(80);
  assert.equal(h.acts.length, 2);
  await h.poll(88);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer", "interrupt", "reload"]);
  h.state.answer = async (request) => (request.action === "succeed" ? { kind: "done", successor: { id: "agent-2", title: null, cwd: "/repo/wt" } } : { kind: "done" });
  await h.poll(109);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer", "interrupt", "reload", "succeed"]);
  // The replacement carries the cycle's label and stays silent as well.
  const marker = h.acts[3].marker;
  h.state.roots = [agent("agent-2", { createdAt: iso(T0 + 109 * MINUTE), labels: { "linear.issueId": ISSUE.id, [WATCHDOG_LABEL]: marker }, activeTurn: { turnId: "turn-9", startedAt: iso(T0 + 110 * MINUTE) } })];
  await h.poll(120);
  assert.equal(h.comments.length, 0);
  await h.poll(131);
  assert.equal(h.acts.length, 4, "no second replacement");
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0], new RegExp(`^https://linear.app/t/profiles/owner ${WATCHDOG_MENTION.replace(/\./g, "\\.")}`));
  await h.poll(200);
  await h.poll(400);
  assert.equal(h.acts.length, 4);
  assert.equal(h.comments.length, 1, "the owner is mentioned once");
  assert.deepEqual(h.said, [WATCHDOG_LINES.steer, WATCHDOG_LINES.interrupt, WATCHDOG_LINES.reload, WATCHDOG_LINES.succeed]);
  await h.cleanup();
});

test("progress ends a cycle; at most two cycles start per rolling day, then the owner is mentioned once", async (t) => {
  quiet(t);
  const h = await harness();
  await h.poll(46);
  h.progress(T0 + 50 * MINUTE);
  await h.poll(52);
  assert.equal((await h.store.read()).tickets[ISSUE.id].cycle, null, "new execution progress ends the cycle");
  assert.deepEqual(h.acts.map((act) => act.action), ["steer"]);

  await h.poll(96);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer", "steer"], "a second cycle");
  h.progress(T0 + 100 * MINUTE);
  await h.poll(102);
  await h.poll(150);
  assert.equal(h.acts.length, 2, "the third silence within 24 hours takes no action");
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0], /Please take over\./);
  await h.poll(170);
  assert.equal(h.comments.length, 1, "one mention for the exhausted budget");

  // A day after the first cycle the budget is back, and new progress lifted the suppression.
  h.progress(T0 + 24 * 60 * MINUTE);
  await h.poll(24 * 60 + 50);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer", "steer", "steer"]);
  await h.cleanup();
});

test("owner waits, holds, plan reviews, subagents, vetoes and unreadable evidence keep the watchdog's hands off", async (t) => {
  quiet(t);
  const cases: { name: string; change: (h: Harness) => void | Promise<void> }[] = [
    { name: "a pending permission", change: (h) => { h.state.roots = [agent("agent-1", { pendingPermissions: [{ id: "q" }] as never })]; } },
    { name: "the owner's Stop", change: (h) => h.store.hold(ISSUE.id, "agent-1") },
    { name: "Needs input", change: (h) => { h.state.status = { status: "Needs input", statusType: "started", labels: [] }; } },
    { name: "a done ticket", change: (h) => { h.state.status = { status: "Done", statusType: "completed", labels: [] }; } },
    { name: "do-not-merge on the ticket", change: (h) => { h.state.status = { status: "In Progress", statusType: "started", labels: ["do-not-merge"] }; } },
    { name: "do-not-merge on an open pull request", change: (h) => { h.state.pulls = [pull({ labels: ["do-not-merge"] })]; } },
    { name: "unreadable pull requests", change: (h) => { h.state.pulls = null; } },
    { name: "a plan review", change: (h) => { h.state.thread = { sessionId: "s", agentId: "agent-1", issueId: ISSUE.id, identifier: ISSUE.identifier, createdAt: iso(T0), handled: [], review: { localUrl: "http://x/" }, offer: null }; } },
    { name: "a waiting handover record", change: (h) => { h.state.records = [record({ waiting: { previousStateId: null, commentId: null } })]; } },
    { name: "a subagent", change: (h) => { h.state.roots = [agent("agent-1", { labels: { "linear.issueId": ISSUE.id, "paseo.parent-agent-id": "p" } })]; } },
    { name: "a provider without trusted history", change: (h) => { h.state.roots = [agent("agent-1", { provider: "claude" })]; } },
    { name: "a malformed native session", change: (h) => { h.state.activity = { ok: false, problem: "the native session has a malformed record" }; } },
    { name: "the switch turned off", change: (h) => { h.state.settings = settings({ writeback: { ...DEFAULT_WRITEBACK, watchdog: false } }); } },
  ];
  for (const { name, change } of cases) {
    const h = await harness();
    await change(h);
    await h.poll(90);
    assert.equal(h.acts.length, 0, `${name}: no action`);
    assert.equal((await h.store.read()).tickets[ISSUE.id]?.starts.length ?? 0, 0, `${name}: no cycle is counted`);
    await h.cleanup();
  }
});

test("a step whose outcome a restart lost is never repeated; the next step follows after its window", async (t) => {
  quiet(t);
  const h = await harness();
  h.state.answer = async () => { throw new Error("the daemon restarted"); };
  await h.poll(46);
  assert.equal((await h.store.read()).tickets[ISSUE.id].cycle?.claim?.state, "claimed");
  // The next plugin instance finds the claim.
  const next = new Watchdog(h.deps);
  h.state.answer = async () => ({ kind: "done" });
  const poll = (minutes: number) => { h.state.now = T0 + minutes * MINUTE; return next.pass({ records: h.state.records, reserved: new Set(), pulls: async () => h.state.pulls }); };
  await poll(48);
  assert.equal(h.acts.length, 1, "the unknown steer is not sent again");
  await poll(60);
  assert.equal(h.acts.length, 1);
  await poll(67);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer", "interrupt"]);
  await h.cleanup();
});

test("an unreadable watchdog state runs no recovery and is never reset", async (t) => {
  quiet(t);
  const h = await harness();
  await writeFile(h.store.path, "{ not json");
  await h.poll(90);
  assert.equal(h.acts.length, 0);
  assert.equal(await readFile(h.store.path, "utf8"), "{ not json");
  await h.cleanup();
});

test("a closed agent quiet for two hours is resumed once unless its ticket has an open pull request; a ghost is replaced at once", async (t) => {
  quiet(t);
  const closed = () => agent("agent-1", { status: "closed", activeTurn: null });
  const open = await harness();
  open.state.roots = [closed()];
  open.state.pulls = [pull()];
  await open.poll(130);
  assert.equal(open.acts.length, 0, "an open pull request has its own nudges");
  await open.cleanup();

  const h = await harness();
  h.state.roots = [closed()];
  await h.poll(110);
  assert.equal(h.acts.length, 0);
  await h.poll(121);
  assert.deepEqual(h.acts.map((act) => act.action), ["resume"]);
  assert.match(h.acts[0].text, /git status/, "a resume that may arrive twice looks at the state first");
  await h.poll(142);
  assert.equal(h.acts.length, 1, "no second resume");
  assert.equal(h.comments.length, 1, "the owner is mentioned when the resume brought no progress");
  await h.cleanup();

  const ghost = await harness();
  ghost.state.roots = [agent("agent-1", { status: "idle", activeTurn: null })];
  ghost.state.ghosts.add("agent-1");
  await ghost.poll(1);
  assert.deepEqual(ghost.acts.map((act) => act.action), ["succeed"], "a proven ghost is replaced without waiting");
  await ghost.cleanup();
});

test("a replacement that cannot prove its predecessor gone is retried until its window ends, then the owner is mentioned", async (t) => {
  quiet(t);
  const h = await harness();
  h.state.roots = [agent("agent-1", { status: "idle", activeTurn: null })];
  h.state.ghosts.add("agent-1");
  h.state.answer = async () => ({ kind: "failed", reason: "a provider process of the ticket is still running", retry: true });
  await h.poll(1);
  await h.poll(10);
  assert.deepEqual(h.acts.map((act) => act.action), ["succeed", "succeed"]);
  await h.poll(22);
  assert.equal(h.acts.length, 2, "no replacement once the retirement window is over");
  assert.equal(h.comments.length, 1);
  await h.cleanup();
});

test("the owner's continuation ends a cycle, and an unloaded watchdog starts nothing", async (t) => {
  quiet(t);
  const h = await harness();
  await h.poll(46);
  // The owner replied: the reply is the latest message to the agent, which postpones the next cycle.
  await h.store.continued(ISSUE.id, iso(T0 + 50 * MINUTE));
  h.state.roots = [agent("agent-1", { lastUserMessageAt: iso(T0 + 50 * MINUTE) })];
  await h.poll(70);
  assert.equal(h.acts.length, 1);
  assert.equal((await h.store.read()).tickets[ISSUE.id].cycle, null);

  const unloaded = await harness();
  unloaded.watchdog.stop();
  await unloaded.poll(90);
  assert.equal(unloaded.acts.length, 0);
  await unloaded.cleanup();
  await h.cleanup();
});

test("recovery history travels with the ticket: starts merge, and a ticket without history waits a day", async (t) => {
  quiet(t);
  const now = T0 + 60 * MINUTE;
  const source = { identifier: ISSUE.identifier, starts: [iso(T0 - 25 * 60 * MINUTE), iso(T0)], cycle: null, exhausted: null };
  const history = historyOf(source, now);
  assert.deepEqual(history.starts, [iso(T0)], "only the rolling day travels");

  const file = { version: 1 as const, tickets: {}, holds: {} };
  assert.equal(importHistory(file, ISSUE.id, ISSUE.identifier, history, now, DEFAULT_WATCHDOG), "imported");
  assert.equal(importHistory(file, ISSUE.id, ISSUE.identifier, { ...history, starts: [iso(T0), iso(T0 + 10 * MINUTE)] }, now, DEFAULT_WATCHDOG), "imported");
  assert.deepEqual((file.tickets as Record<string, { starts: string[] }>)[ISSUE.id].starts, [iso(T0), iso(T0 + 10 * MINUTE)], "merged, never reset");
  assert.equal(importHistory(file, "issue-2", "TUC-2", undefined, now, DEFAULT_WATCHDOG), "quarantined");
  assert.equal(importHistory(file, "issue-3", "TUC-3", { v: 2 }, now, DEFAULT_WATCHDOG), "quarantined", "an unknown version is unknown history");

  const h = await harness();
  await h.store.adopt(ISSUE.id, ISSUE.identifier, undefined, DEFAULT_WATCHDOG, T0);
  await h.poll(90);
  assert.equal(h.acts.length, 0, "no recovery while the history is unknown");
  await h.poll(24 * 60 + 1);
  assert.deepEqual(h.acts.map((act) => act.action), ["steer"]);
  await h.cleanup();
});

test("native evidence counts assistant and tool records on the current branch only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-native-"));
  const path = join(directory, "session.jsonl");
  const line = (value: object) => `${JSON.stringify(value)}\n`;
  const at = (minutes: number) => iso(T0 + minutes * MINUTE);
  const records = [
    { type: "session", id: "root", timestamp: at(0) },
    { type: "message", id: "u1", parentId: null, timestamp: at(1), message: { role: "user" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: at(2), message: { role: "assistant" } },
    // An abandoned branch (a rewind): its newer record is not progress.
    { type: "message", id: "x1", parentId: "a1", timestamp: at(9), message: { role: "assistant" } },
    { type: "custom", customType: "tool_execution_start", id: "t1", parentId: "a1", timestamp: at(3), data: { toolName: "bash", toolCallId: "c1" } },
    { type: "message", id: "u2", parentId: "t1", timestamp: at(8), message: { role: "user" } },
  ];
  await writeFile(path, records.map(line).join(""));
  const read = await readActivity(path, T0 + 10 * MINUTE);
  assert.ok(read.ok);
  assert.equal(read.activity.progressAt, T0 + 3 * MINUTE, "a later user message is no progress");
  assert.equal(read.activity.awaitingChild, false);

  await writeFile(path, records.map(line).join("") + line({ type: "message", id: "f", parentId: "u2", timestamp: at(60), message: { role: "assistant" } }));
  assert.deepEqual(await readActivity(path, T0 + 10 * MINUTE), { ok: false, problem: "the native session has a future-dated record" });
  await writeFile(path, records.map(line).join("") + "{ broken\n");
  assert.deepEqual(await readActivity(path, T0 + 10 * MINUTE), { ok: false, problem: "the native session has a malformed record" });
  assert.equal((await readActivity("relative.jsonl", T0)).ok, false);
  await rm(directory, { recursive: true, force: true });
});
