import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { HealthMonitor } from "./health";
import { reviewChange, type PullRequestView } from "./pr-watch";
import { decidePlannotatorReview, describeTool, questionPrompt, SessionRouter, SessionStore } from "./sessions";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { approveForLater, splitIntoSubIssues } from "./split";
import { AWAY_REASON } from "./scheduler";
import { advisorNote, isUntrusted, OVERLAP_NOTE, PLAN_REQUIRED_NOTE, TicketStarter, QUESTIONS_NOTE, UNTRUSTED_NOTE } from "./starter";
import { planPolicy } from "./plan-policy";

const OWNER = "owner-1";
const APP = "paseo-app";
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp", launchPreferences: { omp: { model: "omp/opus", modeId: "full" } },
  projectMappings: { "team:t1": { projectId: "p1", label: "Team", baseBranch: "refs/heads/main" } }, agentLinearAccess: false,
  dispatch: { ...DEFAULT_DISPATCH, maxRunning: 2 }, writeback: DEFAULT_WRITEBACK, autoApprove: DEFAULT_AUTO_APPROVE,
};

const twoPart: AgentPermissionRequest = {
  id: "q", provider: "claude", name: "AskUserQuestion", kind: "question", title: "Setup",
  input: { questions: [
    { question: "Transfer?", header: "transfer", options: [{ label: "SFTP" }, { label: "Mail" }, { label: "Other (type your own)" }] },
    { question: "Format?", header: "format", options: [{ label: "CSV" }, { label: "XML" }] },
    { question: "Optional comment", header: "Comment", options: [], allowEmpty: true },
  ] },
};

test("question parts are asked one at a time, and Other is a hint rather than a button", () => {
  const first = questionPrompt(twoPart, 0);
  assert.deepEqual(first.options.map((option) => option.label), ["SFTP", "Mail"]);
  assert.match(first.body, /^Transfer\? \(1\/2\)/);
  assert.match(first.body, /Or type your own answer\.$/);
  assert.match(questionPrompt(twoPart, 1).body, /^Format\? \(2\/2\)/);
});

function routerHarness(pending: AgentPermissionRequest[], extra: Partial<ConstructorParameters<typeof SessionRouter>[0]> = {}, listed: { id: string; title: string }[] = []) {
  const calls: string[] = [];
  const feeds: ((event: unknown) => void)[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: listed.map((agent) => ({ agent: { ...agent, labels: {} } })), pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: { pendingPermissions: pending } }),
        send: async (text: string) => { calls.push(`send ${id}: ${text}`); },
        respondToPermission: async ({ response }: { response: unknown }) => { calls.push(`respond ${JSON.stringify(response)}`); },
        timeline: { subscribe: (handler: (event: unknown) => void) => { feeds.push(handler); return () => {}; } },
      }),
    },
  } as unknown as PaseoApi;
  const directory = join(tmpdir(), `paseo-flow-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = new SessionStore(join(directory, "sessions.json"));
  const router = new SessionRouter({
    api: { activity: async (_s: string, content: { type: string; body?: string }) => { calls.push(`${content.type}:${(content.body ?? "").split("\n")[0]}`); }, openSessions: async () => [], activities: async () => [] } as never,
    linear: { viewerId: async () => OWNER, appUserId: async () => APP, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, cancel: async () => {}, issueState: async () => { throw new Error("unused"); }, issueGroup: async () => { throw new Error("unused"); }, moveToStateNamed: async () => ({ changed: false }), delegate: async () => {} },
    starter: { start: async () => { throw new Error("unused"); }, admission: async () => ({ ok: true as const }) },
    settings: { read: async () => settings },
    store,
    stop: async (agentId) => { calls.push(`stop ${agentId}`); },
    ...extra,
  });
  // Connected without attach(): its startup sweep would run alongside the test and, once the
  // daemon's server id is cached, post "Open in Paseo" links mid-test. Tests call sweep() themselves.
  Object.assign(router, { paseo });
  return { router, store, calls, feeds, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const link = { sessionId: "s1", agentId: "a1", issueId: "i1", identifier: "TUC-1", createdAt: "2026-01-01T00:00:00Z", handled: [], review: null, offer: null };

test("a ticket's newest thread accounts for a missing agent only while it waits, once its agent came up, or once it was refused", async () => {
  const h = routerHarness([]);
  assert.equal(await h.router.threadHolds("i1"), false, "no thread: the webhook never arrived");
  // TUC-534: the launch failed; an older thread whose agent ran does not count.
  await h.store.put({ ...link, offer: "later" });
  await h.store.put({ ...link, sessionId: "s2", agentId: null, createdAt: "2026-01-02T00:00:00Z" });
  assert.equal(await h.router.threadHolds("i1"), false);
  await h.store.patch("s2", { queued: true });
  assert.equal(await h.router.threadHolds("i1"), true, "it waits for blockers or a slot");
  // A plan approved for later: back in Todo on purpose, its planner retired.
  await h.store.put({ ...link, sessionId: "s3", offer: "later", createdAt: "2026-01-03T00:00:00Z" });
  assert.equal(await h.router.threadHolds("i1"), true);
  // Handed to Paseo by someone else: refused, and not taken for a failed start either.
  await h.store.put({ ...link, sessionId: "s4", agentId: null, createdAt: "2026-01-04T00:00:00Z" });
  assert.equal(await h.router.threadHolds("i1"), false);
  await h.router.created({ id: "s5", issueId: "i1", issue: { identifier: "TUC-1" }, creatorId: "teammate" });
  assert.equal(await h.router.threadHolds("i1"), true);
  await h.cleanup();
});

test("a start under way accounts for the ticket until it ends", async () => {
  const gate: { fail?: (error: Error) => void } = {};
  const h = routerHarness([], {
    // Executor form: the plugin's lib is ES2023, without Promise.withResolvers.
    starter: { admission: async () => ({ ok: true as const }), start: () => new Promise((_resolve, reject) => { gate.fail = reject; }) },
  });
  const restart = h.router.restartFor("i9", "TUC-9");
  while (!gate.fail) await setImmediate();
  assert.equal(await h.router.threadHolds("i9"), true, "the agent takes a minute or two to show up");
  gate.fail(new Error("Timed out waiting for OMP to become ready"));
  await assert.rejects(restart, /Timed out/);
  assert.equal(await h.router.threadHolds("i9"), false);
  await h.cleanup();
});

test("a multi-part question collects every answer before answering the agent once", async () => {
  const h = routerHarness([twoPart]);
  await h.store.put(link);
  await h.router.prompted("s1", { id: "p1", content: { body: "sftp" } });
  assert.deepEqual(h.calls, ["elicitation:Format? (2/2)"]);
  await h.router.prompted("s1", { id: "p2", content: { body: "CSV" } });
  assert.equal(h.calls.at(-1), 'respond {"behavior":"allow","updatedInput":{"answers":{"transfer":"SFTP","format":"CSV","Comment":""}}}');
  await h.cleanup();
});

test("after Stop, a turn the provider starts on its own is stopped again until the owner replies", async () => {
  const h = routerHarness([]);
  await h.store.put(link);
  await h.router.prompted("s1", { id: "p1", signal: "stop", content: { body: "stop" } });
  assert.equal(await h.router.holdIfStopped("a1"), true);
  assert.deepEqual(h.calls.filter((call) => call.startsWith("stop")), ["stop a1", "stop a1"]);
  await h.router.prompted("s1", { id: "p2", content: { body: "carry on" } });
  assert.equal(await h.router.holdIfStopped("a1"), false);
  await h.cleanup();
});

test("while a question is open the live feed holds its actions, so Linear keeps showing the options", async () => {
  const h = routerHarness([]);
  await h.store.put(link);
  await h.router.follow("a1");
  const ran = (command: string) => h.feeds[0]({ event: { type: "timeline", item: { type: "tool_call", status: "completed", detail: { type: "shell", command } } } });
  ran("ls");
  await h.router.ask("s1", "The plan is ready for review", [{ label: "Approve plan", value: "approve-plan" }]);
  ran("cat PLAN.md");
  await h.router.unfollow("a1");
  assert.deepEqual(h.calls, ["action:", "elicitation:The plan is ready for review"]);
  await h.router.follow("a1");
  await h.router.ask("s1", "Which?", [{ label: "A", value: "a" }]);
  h.feeds[1]({ event: { type: "timeline", item: { type: "tool_call", status: "completed", detail: { type: "shell", command: "pwd" } } } });
  await h.router.prompted("s1", { id: "p1", content: { body: "A" } });
  await h.router.unfollow("a1");
  assert.equal(h.calls.at(-1), "action:");
  await h.cleanup();
});

test("feedback for a review whose Plannotator server is gone reaches the agent instead of failing", async () => {
  const h = routerHarness([], { decideReview: (url, approve, feedback) => decidePlannotatorReview(url, approve, feedback) });
  await h.store.put({ ...link, review: { localUrl: "http://127.0.0.1:1" } });
  await h.router.prompted("s1", { id: "p1", content: { body: "Split step 2 in two" } });
  assert.equal((await h.store.get("s1"))?.review, null);
  assert.match(h.calls.at(-1) ?? "", /^send a1: Your Plannotator plan review closed[\s\S]*Split step 2 in two/);
  await h.cleanup();
});

test("a ticket keeps one open Paseo thread: older threads are closed once a newer one has the agent", async () => {
  const calls: string[] = [];
  const h = routerHarness([], {
    api: {
      activity: async (sessionId: string, content: { type: string; body?: string }) => { calls.push(`${sessionId} ${content.type}: ${(content.body ?? "").slice(0, 40)}`); },
      openSessions: async () => [{ id: "old", status: "active" }, { id: "older", status: "complete" }, { id: "current", status: "active" }],
      activities: async () => [],
    } as never,
  });
  const at = (hour: number) => `2026-01-01T${String(hour).padStart(2, "0")}:00:00Z`;
  await h.store.put({ ...link, sessionId: "older", agentId: "a0", createdAt: at(8) });
  await h.store.put({ ...link, sessionId: "old", agentId: "a1", createdAt: at(9), review: { localUrl: "http://localhost:5000" } });
  await h.store.put({ ...link, sessionId: "current", agentId: "a1", createdAt: at(10) });
  await h.store.put({ ...link, sessionId: "waiting", agentId: null, createdAt: at(11), queued: true });
  await h.store.put({ ...link, sessionId: "elsewhere", issueId: "i2", agentId: "a2", createdAt: at(7) });
  await h.router.closeSuperseded();
  assert.deepEqual(calls, ["old response: Continued in the newest Paseo thread on "]);
  assert.equal((await h.store.get("old"))?.closed, true);
  assert.equal((await h.store.get("old"))?.review, null);
  assert.equal((await h.store.get("older"))?.closed, true, "already complete in Linear: marked, not told again");
  for (const id of ["current", "waiting", "elsewhere"]) assert.equal((await h.store.get(id))?.closed, undefined, id);
  assert.equal((await h.store.forAgent("a1"))?.sessionId, "current");
  await h.router.closeSuperseded();
  assert.equal(calls.length, 1, "closing happens once");
  await h.cleanup();
});

test("one failed Linear read skips only its part of the sweep: a reply in another thread still reaches its agent", async () => {
  let lists = 0;
  const h = routerHarness([], {
    api: {
      activity: async () => {},
      // The first list (closing superseded threads) fails, the way Linear's 503s do; so does one thread's read.
      openSessions: async () => { if (++lists === 1) throw new Error("HTTP 503"); return [{ id: "s1", status: "active" }, { id: "s2", status: "active" }]; },
      activities: async (id: string) => {
        if (id === "s1") throw new Error("HTTP 503");
        return [{ id: "p1", type: "prompt", userId: OWNER, createdAt: "2026-01-02T00:00:00Z", body: "Also update the README" }];
      },
    } as never,
  });
  // `old` is superseded by `s1`, so closing it lists the sessions first, and that list fails.
  await h.store.put({ ...link, sessionId: "old", agentId: "a0", createdAt: "2025-12-31T00:00:00Z", paseoLinked: "a0" });
  await h.store.put({ ...link, sessionId: "s1", agentId: "a1", paseoLinked: "a1" });
  await h.store.put({ ...link, sessionId: "s2", agentId: "a2", issueId: "i2", paseoLinked: "a2" });
  await h.router.sweep();
  assert.ok(h.calls.some((call) => call.startsWith("send a2:") && call.includes("Also update the README")), JSON.stringify(h.calls));
  assert.ok(!h.calls.some((call) => call.startsWith("send a1")));
  assert.equal(lists, 2);
  await h.cleanup();
});

test("a queued thread starts once its blockers finish, even after it dropped out of Linear's recent sessions", async () => {
  const events: string[] = [];
  const blocked = new Set(["i1", "i2", "i3", "i4", "i5"]);
  const sessionStatus: Record<string, string | null> = { q1: "stale", q2: "complete", q3: "stale", q4: "stale", q5: "awaitingInput" };
  const h = routerHarness([], {
    // Linear's session list no longer contains any of the waiting threads.
    api: { activity: async (sessionId: string, content: { type: string; body?: string }) => { if (content.type !== "thought") events.push(`${sessionId} ${content.type}: ${content.body}`); }, openSessions: async () => [], activities: async () => [], sessionStatus: async (id: string) => sessionStatus[id] } as never,
    linear: { viewerId: async () => OWNER, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, issueState: async (id: string) => ({ statusType: id === "i3" ? "canceled" : "unstarted", status: id === "i3" ? "Canceled" : "Todo" }) } as never,
    starter: {
      admission: async (id: string) => (blocked.has(id) ? { ok: false as const, reason: "Waiting for TUC-9 to finish." } : { ok: true as const }),
      start: async (id: string) => {
        if (id === "i4") throw new Error("No Paseo project is mapped");
        events.push(`start ${id}`);
        return { agentId: `agent-${id}`, warnings: [], provider: "omp", target: "repo", resumed: false, untrusted: false, plan: null };
      },
    },
  });
  for (const n of [1, 2, 3, 4, 5]) await h.store.put({ ...link, sessionId: `q${n}`, issueId: `i${n}`, identifier: `TUC-${n}`, agentId: null, queued: true });

  await h.router.sweep();
  assert.deepEqual(events, [], "nothing starts while the blockers are open");

  blocked.clear();
  await h.router.sweep();
  assert.deepEqual(events, [
    "start i1",
    "q3 response: TUC-3 was moved to Canceled while it waited, so no agent was started. Assign Paseo again to start one.",
    "q4 error: Paseo could not start the agent: No Paseo project is mapped",
    "start i5",
  ]);
  assert.equal((await h.store.get("q1"))?.agentId, "agent-i1");
  assert.equal((await h.store.get("q5"))?.agentId, "agent-i5");
  for (const id of ["q1", "q2", "q3", "q4", "q5"]) assert.equal((await h.store.get(id))?.queued, false, id);
  assert.equal((await h.store.get("q2"))?.agentId, null, "a thread the owner ended starts nothing");

  await h.router.sweep();
  assert.equal(events.length, 4, "an ended, closed or failed wait is not tried again");
  await h.cleanup();
});

test("a queued thread whose ticket already has a running agent is linked to it instead of starting a second", async () => {
  const starts: string[] = [];
  const h = routerHarness([], {
    api: { activity: async () => {}, openSessions: async () => [], activities: async () => [], sessionStatus: async () => "stale" } as never,
    linear: { viewerId: async () => OWNER, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, issueState: async () => ({ statusType: "unstarted", status: "Todo" }) } as never,
    starter: { admission: async () => ({ ok: true as const }), start: async (id: string) => { starts.push(id); throw new Error("unused"); } },
  }, [{ id: "labelled", title: "Started by the paseo label" }]);
  await h.store.put({ ...link, sessionId: "q1", agentId: null, queued: true });
  await h.router.startQueued();
  assert.deepEqual(starts, []);
  assert.deepEqual([(await h.store.get("q1"))?.agentId, (await h.store.get("q1"))?.queued], ["labelled", false]);
  await h.cleanup();
});

test("a parked plan's thread offers no resume when its agent is retired, and starts a fresh agent once the owner decided", async () => {
  const starts: string[] = [];
  const h = routerHarness([], {
    api: { activity: async (_s: string, content: { type: string; body?: string }) => { h.calls.push(`${content.type}:${(content.body ?? "").split("\n")[0]}`); }, openSessions: async () => [], activities: async () => [], sessionStatus: async () => "stale" } as never,
    linear: { viewerId: async () => OWNER, addLabel: async () => {}, removeLabel: async () => {}, complete: async () => {}, issueState: async () => ({ statusType: "unstarted", status: "Todo" }) } as never,
    starter: {
      admission: async () => ({ ok: true as const }),
      start: async (id: string) => { starts.push(id); return { agentId: "fresh", warnings: [], provider: "omp", target: "repo", resumed: false, untrusted: false, plan: null }; },
    },
  });
  await h.store.put({ ...link, review: { localUrl: "http://localhost:4000/" } });
  await h.router.parked("a1");
  assert.deepEqual([(await h.store.get("s1"))?.offer, (await h.store.get("s1"))?.review], ["parked", null]);
  await h.router.offerResume("s1");
  assert.ok(!h.calls.some((call) => call.includes("Resume")), "the retired agent offers no resume");
  assert.equal(await h.router.requeue("a1", "Plan approved. A new agent implements it as soon as a slot is free."), true);
  assert.ok(h.calls.includes("thought:Plan approved. A new agent implements it as soon as a slot is free."));
  await h.router.startQueued();
  assert.deepEqual(starts, ["i1"]);
  assert.deepEqual([(await h.store.get("s1"))?.agentId, (await h.store.get("s1"))?.queued, (await h.store.get("s1"))?.offer], ["fresh", false, null]);
  assert.equal(await h.router.requeue("a1", "again"), false, "the retired agent no longer owns the thread");
  await h.cleanup();
});

test("a review decided or closed outside Linear is settled by the sweep", async () => {
  const recorded: unknown[] = [];
  const outcomes: Record<string, "open" | null | { approved: boolean; planContent: string }> = { "http://localhost:1": "open", "http://localhost:2": { approved: true, planContent: "# Plan" }, "http://localhost:3": null };
  const h = routerHarness([], { reviewOutcome: async (review) => outcomes[review.localUrl], recordOutcome: async (agentId, outcome) => { recorded.push([agentId, outcome]); } });
  for (const n of [1, 2, 3]) await h.store.put({ ...link, sessionId: `s${n}`, agentId: `a${n}`, issueId: `i${n}`, review: { localUrl: `http://localhost:${n}` } });
  await h.router.settleReviews();
  assert.deepEqual(recorded, [["a2", { approved: true, planContent: "# Plan" }]]);
  assert.deepEqual(h.calls, ["thought:The plan review closed without a decision (for example after a restart). Reply here if the agent should submit the plan again."]);
  assert.deepEqual([(await h.store.get("s1"))?.review?.localUrl, (await h.store.get("s2"))?.review, (await h.store.get("s3"))?.review], ["http://localhost:1", null, null]);
  await h.cleanup();
});

test("the panel's Plan review link lives exactly as long as the review", async () => {
  const updates: unknown[] = [];
  const h = routerHarness([], { api: { activity: async () => {}, openSessions: async () => [], activities: async () => [], updateSession: async (_s: string, input: unknown) => { updates.push(input); } } as never });
  await h.store.put(link);
  await h.router.expectReview("s1", "http://localhost:5000", "# Plan", "https://mac.ts.net:5000");
  await h.router.expectReview("s1", "http://localhost:6000", "# Plan v2", "https://mac.ts.net:6000");
  await h.router.expectReview("s1", null);
  assert.deepEqual(updates, [
    { addedExternalUrls: [{ label: "Plan review", url: "https://mac.ts.net:5000" }] },
    { removedExternalUrls: ["https://mac.ts.net:5000"] },
    { addedExternalUrls: [{ label: "Plan review", url: "https://mac.ts.net:6000" }] },
    { removedExternalUrls: ["https://mac.ts.net:6000"] },
  ]);
  assert.equal((await h.store.get("s1"))?.review, null);
  await h.cleanup();
});

test("the live feed shows completed commands and edits only", () => {
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "shell", command: "npm test" } }), "Ran npm test");
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "edit", filePath: "src/a.ts" } }), "Edited src/a.ts");
  assert.equal(describeTool({ type: "tool_call", status: "running", detail: { type: "shell", command: "npm test" } }), null);
  assert.equal(describeTool({ type: "tool_call", status: "completed", detail: { type: "read", filePath: "a" } }), null);
});

// `appId`: the Paseo app's user, or null when the app is not usable on this host.
function starterHarness(state: { creatorId: string | null; labels: { id: string; name: string }[]; blockedBy: string[] }, running: number, appId: string | null = APP, away = false) {
  const launches: { modeId?: string; instructions: string; labels?: Record<string, string>; env?: Record<string, string>; markInProgress?: boolean }[] = [];
  const starter = new TicketStarter({
    linear: {
      detail: async () => ({ issue: { identifier: "TUC-1", project: "", team: "Team" }, projectId: null, teamId: "t1" }) as never,
      issueState: async () => ({ id: "i1", identifier: "TUC-1", status: "Todo", statusId: "todo", statusType: "unstarted", teamId: "t1", projectId: null, attachmentUrls: [], priority: 0, createdAt: "", unblocks: 0, ...state }),
      viewerId: async () => OWNER,
      appUserId: async () => appId,
      issueDocument: async (_id: string, title: string) => title === "Plan: TUC-1" ? { url: "https://linear.app/doc/plan", content: "# Plan\n1. Add the table" } : null,
    },
    launcher: { start: async (input, _paseo, options) => { launches.push({ modeId: input.modeId, instructions: input.instructions, labels: options?.labels, env: options?.env, markInProgress: options?.markInProgress }); return { agentId: "new", warnings: [] }; } },
    branches: async () => ({ branches: [{ id: "refs/heads/main", label: "main" }], defaultBranch: "refs/heads/main" }),
    presence: { away: async () => away },
  });
  const paseo = {
    agents: { list: async () => ({ entries: Array.from({ length: running }, (_, index) => ({ agent: { id: `r${index}`, status: "running", labels: { "linear.issueId": `x${index}` } } })), pageInfo: { hasMore: false } }) },
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectKind: "git", projectRootPath: "/repo", projectDisplayName: "repo" }] }) },
  } as unknown as PaseoApi;
  return { starter, paseo, launches };
}

test("admission waits for unfinished blockers and for a free agent slot", async () => {
  const blocked = starterHarness({ creatorId: OWNER, labels: [], blockedBy: ["TUC-9"] }, 0);
  assert.deepEqual(await blocked.starter.admission("i1", blocked.paseo, settings), { ok: false, reason: "Waiting for TUC-9 to finish." });
  const full = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 2);
  assert.match((await full.starter.admission("i1", full.paseo, settings) as { reason: string }).reason, /Queued: 2 of 2/);
  const room = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 1);
  assert.deepEqual(await room.starter.admission("i1", room.paseo, settings), { ok: true });
  assert.deepEqual(await room.starter.admission("i1", room.paseo, { ...settings, dispatch: { ...settings.dispatch, maxRunning: 0 } }), { ok: true });
});

test("a project planner starts even when every agent slot is taken, also under a memory lease of 0", async () => {
  const planner = { creatorId: APP, labels: [{ id: "p", name: "paseo-planner" }], blockedBy: [] };
  const full = starterHarness(planner, 2);
  assert.deepEqual(await full.starter.admission("i1", full.paseo, settings), { ok: true }, "2 of 2 slots used");
  const leased = starterHarness(planner, 2);
  leased.starter.capacity.set({ limit: 0, ttlSeconds: 60, reason: "low memory" });
  assert.deepEqual(await leased.starter.admission("i1", leased.paseo, settings), { ok: true }, "a lease of 0 starts nothing else");
  const ticket = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  ticket.starter.capacity.set({ limit: 0, ttlSeconds: 60, reason: "low memory" });
  assert.match((await ticket.starter.admission("i1", ticket.paseo, settings) as { reason: string }).reason, /RAM-limited/);
});

test("while the owner is away, only the implementation of an attended ticket waits; planning never does, even with no agent limit", async () => {
  const unlimited = { ...settings, dispatch: { ...settings.dispatch, maxRunning: 0 } };
  const approved = starterHarness({ creatorId: OWNER, labels: [{ id: "l1", name: "paseo-attended" }, { id: "r", name: "plan-ready" }], blockedBy: [] }, 0, APP, true);
  assert.deepEqual(await approved.starter.admission("i1", approved.paseo, unlimited), { ok: false, reason: AWAY_REASON });
  const present = starterHarness({ creatorId: OWNER, labels: [{ id: "l1", name: "paseo-attended" }, { id: "r", name: "plan-ready" }], blockedBy: [] }, 0, APP, false);
  assert.deepEqual(await present.starter.admission("i1", present.paseo, unlimited), { ok: true });
  for (const [why, state] of [
    ["attended, still to plan", { creatorId: OWNER, labels: [{ id: "l1", name: "paseo-attended" }] }],
    ["written by someone else", { creatorId: "colleague", labels: [] }],
    ["an approved plan, not attended", { creatorId: OWNER, labels: [{ id: "r", name: "plan-ready" }] }],
    ["plain", { creatorId: OWNER, labels: [] }],
  ] as const) {
    const away = starterHarness({ ...state, labels: [...state.labels], blockedBy: [] }, 0, APP, true);
    assert.deepEqual(await away.starter.admission("i1", away.paseo, unlimited), { ok: true }, why);
  }
});

test("every ticket starts plan-first; someone else's ticket is marked untrusted; omp keeps the usual mode so the planner never waits for approvals", async () => {
  assert.equal(isUntrusted({ creatorId: OWNER, labels: [] }, OWNER, APP), false);
  assert.equal(isUntrusted({ creatorId: "customer", labels: [] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: OWNER, labels: [{ name: "Feedback" }] }, OWNER, APP), true);
  const h = starterHarness({ creatorId: "customer", labels: [], blockedBy: [] }, 0);
  const started = await h.starter.start("i1", h.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: started.untrusted, plan: started.plan }, { untrusted: true, plan: "required" });
  assert.deepEqual(h.launches[0], { modeId: "full", instructions: `${UNTRUSTED_NOTE}\n\n${OVERLAP_NOTE}\n\n${advisorNote("omp")}\n\n${QUESTIONS_NOTE}`, labels: { "linear.plan": "required" }, env: { LINEAR_TICKETS_PLAN: "required" }, markInProgress: false });
  const mine = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  const own = await mine.starter.start("i1", mine.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: own.untrusted, plan: own.plan }, { untrusted: false, plan: "required" });
  assert.deepEqual(mine.launches[0], { modeId: "full", instructions: `${PLAN_REQUIRED_NOTE}\n\n${OVERLAP_NOTE}\n\n${advisorNote("omp")}\n\n${QUESTIONS_NOTE}`, labels: { "linear.plan": "required" }, env: { LINEAR_TICKETS_PLAN: "required" }, markInProgress: false });
});

test("tickets the Paseo app wrote are trusted like the owner's, unless they came from the feedback intake or the app is unknown here", async () => {
  assert.equal(isUntrusted({ creatorId: APP, labels: [] }, OWNER, APP), false);
  assert.equal(isUntrusted({ creatorId: APP, labels: [{ name: "feedback" }] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: "customer", labels: [] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: null, labels: [] }, OWNER, APP), true);
  assert.equal(isUntrusted({ creatorId: null, labels: [] }, OWNER, null), true, "an unknown creator never matches an unknown app");
  assert.equal(isUntrusted({ creatorId: APP, labels: [] }, OWNER, null), true);
  const byApp = starterHarness({ creatorId: APP, labels: [], blockedBy: [] }, 0);
  const trusted = await byApp.starter.start("i1", byApp.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: trusted.untrusted, plan: trusted.plan }, { untrusted: false, plan: "required" });
  const appUnknown = starterHarness({ creatorId: APP, labels: [], blockedBy: [] }, 0, null);
  const untrusted = await appUnknown.starter.start("i1", appUnknown.paseo, settings, { retryHint: "retry" });
  assert.deepEqual({ untrusted: untrusted.untrusted, plan: untrusted.plan }, { untrusted: true, plan: "required" });
});

test("plan policy: an approved plan is implemented, every other ticket plans; the old no-plan label skips nothing", () => {
  const labels = (...names: string[]) => names.map((name) => ({ name }));
  assert.equal(planPolicy(labels()), "required");
  assert.equal(planPolicy(labels("no-plan")), "required");
  assert.equal(planPolicy(labels("Plan-Ready")), null);
  assert.equal(planPolicy(labels("plan-ready", "plan")), null);
});

test("a plan starts in the provider's safe mode, and not in progress", async () => {
  const h = starterHarness({ creatorId: OWNER, labels: [], blockedBy: [] }, 0);
  const started = await h.starter.start("i1", h.paseo, { ...settings, markInProgress: true, lastProvider: "claude", launchPreferences: { claude: { model: "claude/opus", modeId: "default" } } }, { retryHint: "retry" });
  assert.deepEqual({ untrusted: started.untrusted, plan: started.plan }, { untrusted: false, plan: "required" });
  assert.deepEqual(h.launches[0], { modeId: "plan", instructions: `${PLAN_REQUIRED_NOTE}\n\n${OVERLAP_NOTE}\n\n${advisorNote("claude")}\n\n${QUESTIONS_NOTE}`, labels: { "linear.plan": "required" }, env: { LINEAR_TICKETS_PLAN: "required" }, markInProgress: false });
});

test("a project's planner gets no ticket overlap note: its description holds its own", async () => {
  const h = starterHarness({ creatorId: APP, labels: [{ id: "p", name: "paseo-planner" }], blockedBy: [] }, 0);
  await h.starter.start("i1", h.paseo, settings, { retryHint: "retry" });
  assert.deepEqual(h.launches[0].instructions, `${PLAN_REQUIRED_NOTE}\n\n${advisorNote("omp")}\n\n${QUESTIONS_NOTE}`);
});

test("a plan-first ticket is not marked in progress; once its plan is approved (plan-ready) the next agent implements it in the usual mode", async () => {
  const syncing = { ...settings, markInProgress: true, writeback: { ...DEFAULT_WRITEBACK, status: true } };
  const first = starterHarness({ creatorId: "customer", labels: [{ id: "f", name: "feedback" }], blockedBy: [] }, 0);
  await first.starter.start("i1", first.paseo, syncing, { retryHint: "retry" });
  assert.equal(first.launches[0].markInProgress, false);
  const later = starterHarness({ creatorId: "customer", labels: [{ id: "f", name: "feedback" }, { id: "r", name: "plan-ready" }], blockedBy: [] }, 0);
  const started = await later.starter.start("i1", later.paseo, syncing, { retryHint: "retry" });
  assert.equal(started.plan, null);
  assert.equal(later.launches[0].modeId, "full");
  assert.equal(later.launches[0].markInProgress, true);
  assert.deepEqual(later.launches[0].labels, {});
  assert.match(later.launches[0].instructions, /untrusted input/);
  assert.doesNotMatch(later.launches[0].instructions, /write a plan only/);
  assert.match(later.launches[0].instructions, /already approved a plan.*https:\/\/linear\.app\/doc\/plan/);
  assert.match(later.launches[0].instructions, /1\. Add the table/);
});

test("approve, implement later: plan recorded, planner retired, ticket back in Todo with plan-ready", async () => {
  const calls: string[] = [];
  const summary = await approveForLater({
    linear: {
      upsertIssueDocument: async (_id: string, title: string) => { calls.push(`document ${title}`); return "https://linear.app/doc/plan"; },
      moveToReady: async (id: string) => { calls.push(`todo ${id}`); return { changed: true }; },
      addLabel: async (id: string, name: string) => { calls.push(`+${name} ${id}`); },
    },
    readPlan: async () => "# Plan\n1. Step",
    retirePlanner: async (_url: string, agentId: string, _paseo: PaseoApi, reason: string) => { calls.push(`retire ${agentId}: ${reason.slice(0, 40)}`); },
  }, { issueId: "i1", identifier: "TUC-1", agentId: "planner" }, "http://localhost:5000/", { agents: { ref: () => ({ refresh: async () => ({ agent: { model: "omp/opus" } }) }) } } as unknown as PaseoApi);
  assert.deepEqual(calls, ["document Plan: TUC-1", "retire planner: The owner approved this plan for later i", "todo i1", "+plan-ready i1"]);
  assert.match(summary, /back in Todo with `plan-ready`/);
});

const PR: PullRequestView = { state: "OPEN", isDraft: false, headSha: "h", headBranch: "tuc-1", baseBranch: "main", updatedAt: "", reviewDecision: "", labels: [], mergeActivity: null, comments: [], reviews: [], lastCommitAt: null, checks: [] };

test("the review mirror: approval means ready to merge, and commits after it send the ticket back to review", () => {
  const approved = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "APPROVED", submittedAt: "2026-01-01T12:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T11:00:00Z" }, { reviewedAt: null, decision: null, merged: false });
  assert.equal(approved.change?.state, "Ready to merge");
  assert.equal(reviewChange({ ...PR, state: "OPEN", reviews: [], lastCommitAt: "2026-01-01T11:00:00Z" }, approved.seen).change, null, "nothing new");
  const pushed = reviewChange({ ...PR, state: "OPEN", reviews: [], lastCommitAt: "2026-01-01T13:00:00Z" }, approved.seen);
  assert.equal(pushed.change?.state, "In Review");
  assert.equal(reviewChange({ ...PR, state: "OPEN", reviews: [], lastCommitAt: "2026-01-01T13:00:00Z" }, pushed.seen).change, null, "reported once");
});

test("pull request reviews become ticket updates: changes requested, fixes pushed, approved, merged", () => {
  const start = { reviewedAt: null, decision: null, merged: false };
  const requested = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T09:00:00Z" }, start);
  assert.equal(requested.change?.state, "In Progress");
  assert.equal(requested.change?.review, "changes requested by @ada");
  assert.equal(reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T09:00:00Z" }, requested.seen).change, null, "nothing new");
  const pushed = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T10:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T11:00:00Z" }, requested.seen);
  assert.equal(pushed.change?.state, "In Review");
  const approved = reviewChange({ ...PR, state: "OPEN", reviews: [{ author: "ada", state: "APPROVED", submittedAt: "2026-01-01T12:00:00Z", body: "", commit: null }], lastCommitAt: "2026-01-01T11:00:00Z" }, pushed.seen);
  assert.equal(approved.change?.review, "approved by @ada");
  const merged = reviewChange({ ...PR, state: "MERGED", reviews: [], lastCommitAt: null }, approved.seen);
  assert.equal(merged.change?.review, "merged");
  assert.equal(reviewChange({ ...PR, state: "MERGED", reviews: [], lastCommitAt: null }, merged.seen).change, null);
});

test("splitting creates one sub-issue per step, each blocked by the previous, all assigned to Paseo", async () => {
  const calls: string[] = [];
  let n = 0;
  const deps = {
    linear: {
      issueState: async () => ({ id: "parent", identifier: "TUC-1", status: "Planning", statusId: "planning", statusType: "started", teamId: "t1", projectId: "p9", creatorId: OWNER, labels: [], attachmentUrls: [], blockedBy: [], priority: 0, createdAt: "", unblocks: 0 }),
      upsertIssueDocument: async (_id: string, _title: string, body: string) => { calls.push(`document ${body.split("\n").find((line) => line.includes("Planned with"))}`); return "https://linear.app/doc/plan"; },
      createIssue: async (input: { title: string; parentId?: string; projectId?: string | null; ready?: boolean }) => { n++; calls.push(`create ${input.title} parent=${input.parentId} project=${input.projectId}${input.ready ? " ready" : ""}`); return { id: `s${n}`, identifier: `TUC-${10 + n}`, url: "" }; },
      addBlocker: async (blocker: string, blocked: string) => { calls.push(`${blocker} blocks ${blocked}`); },
      delegate: async (id: string, to: string) => { calls.push(`delegate ${id} to ${to}`); },
      moveToStateNamed: async (id: string, name: string) => { calls.push(`move ${id} to ${name}`); return { changed: true }; },
      addLabel: async (id: string, name: string) => { calls.push(`+${name} ${id}`); },
    },
    appUserId: async () => APP,
    readPlan: async () => "# Plan\n## Steps\n1. Add the domain\n2. Add the migration\n3. Wire the API",
    retirePlanner: async (_url: string, agentId: string) => { calls.push(`retire ${agentId}`); },
  };
  const planner = { agents: { ref: () => ({ refresh: async () => ({ agent: { model: "omp/opus", effectiveThinkingOptionId: "medium" } }) }) } } as unknown as PaseoApi;
  const summary = await splitIntoSubIssues(deps, { issueId: "parent", identifier: "TUC-1", agentId: "planner" }, "http://localhost:5000/", planner);
  assert.deepEqual(calls, [
    "document > **Planned with:** `omp/opus · thinking medium`",
    "retire planner",
    "create Add the domain parent=parent project=p9 ready",
    "create Add the migration parent=parent project=p9 ready",
    "s1 blocks s2",
    "create Wire the API parent=parent project=p9 ready",
    "s2 blocks s3",
    "delegate s1 to paseo-app", "delegate s2 to paseo-app", "delegate s3 to paseo-app",
    "move parent to In Progress",
    "+plan-ready parent",
  ]);
  assert.match(summary, /Split into 3 sub-issues \(TUC-11, TUC-12, TUC-13\)/);
  await assert.rejects(splitIntoSubIssues({ ...deps, readPlan: async () => "just prose" }, { issueId: "parent", identifier: "TUC-1", agentId: "planner" }, "http://localhost:5000/", {} as PaseoApi), /fewer than two/);
});

test("health problems open one urgent ticket after two failed checks, update it, and complete it on recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-health-"));
  const calls: string[] = [];
  let funnelOk = false;
  let receiverOk = true;
  try {
    const monitor = new HealthMonitor({
      createIssue: async (input: { title: string; priority?: number }) => { calls.push(`create ${input.title} p${input.priority}`); return { id: "h1", identifier: "TUC-99", url: "" }; },
      updateDescription: async () => { calls.push("describe"); },
      comment: async (_id: string, body: string) => { calls.push(`comment ${body}`); },
      complete: async () => { calls.push("complete"); },
      teamIdByKey: async () => "t1",
      viewerId: async () => OWNER,
    }, { read: async () => ({ ...settings, dispatch: { ...settings.dispatch, teamKeys: ["TUC"] } }) }, [
      { name: "Tailscale Funnel", run: async () => { if (!funnelOk) throw new Error("Funnel is off"); } },
      { name: "Webhook receiver", run: async () => { if (!receiverOk) throw new Error("down"); } },
    ], join(directory, "health.json"));
    assert.deepEqual(await monitor.check(), {}, "one failure is not confirmed");
    assert.deepEqual(await monitor.check(), { "Tailscale Funnel": "Funnel is off" });
    assert.deepEqual(calls, ["create ⚠️ Paseo needs attention p1"]);
    receiverOk = false;
    await monitor.check();
    await monitor.check();
    assert.deepEqual(calls.slice(1), ["describe", "comment Problems now: Tailscale Funnel, Webhook receiver."]);
    funnelOk = true;
    receiverOk = true;
    await monitor.check();
    assert.deepEqual(calls.slice(3), ["comment ✅ All checks pass again.", "complete"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
