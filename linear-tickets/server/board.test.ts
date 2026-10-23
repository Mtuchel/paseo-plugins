import assert from "node:assert/strict";
import test from "node:test";
import type { BoardAgentFact, BoardHostFacts, BoardInput, BoardIssue, BoardOpenPull, BoardRow, BoardStewardFact, BoardView } from "../shared/board";
import { deriveBoard } from "./board";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const hours = (h: number) => ago(h * 60);

function host(name: string, overrides: Partial<BoardHostFacts> = {}): BoardHostFacts {
  return {
    host: name, collectedAt: ago(0), maxRunning: 10,
    agentCounts: { running: 0, idle: 0, initializing: 0, error: 0, permission: 0 },
    agents: [], steward: null, ownership: null, watchdog: [],
    plans: { lastArrivalAt: null, rows: [] }, pulls: [],
    flow: { planning: 0, arrived: 0, decided: 0, autoApproved: 0, starts: 0, openedPr: 0, enqueued: 0 },
    ...overrides,
  };
}
function issue(identifier: string, status: string, overrides: Partial<BoardIssue> = {}): BoardIssue {
  const statusType = ({ Todo: "unstarted", Backlog: "backlog", Triage: "triage", Done: "completed", Canceled: "canceled" } as Record<string, string>)[status] ?? "started";
  return {
    identifier, title: `Title of ${identifier}`, url: `https://linear.app/acme/issue/${identifier}`, status, statusType,
    project: null, labels: ["paseo"], startedAt: null, completedAt: null, updatedAt: ago(5), ...overrides,
  };
}
function agent(identifier: string, overrides: Partial<BoardAgentFact> = {}): BoardAgentFact {
  return {
    id: `agent-${identifier}`, identifier, title: `${identifier}: Agent title`, status: "running",
    createdAt: hours(1), updatedAt: ago(1), permission: false, inside: null, ...overrides,
  };
}
function steward(identifier: string, situation: string, overrides: Partial<BoardStewardFact> = {}): BoardStewardFact {
  return { identifier, situation, since: hours(1), restarts: [], refusals: [], escalatedAt: null, log: [], status: null, advancedAt: null, ...overrides };
}
function pull(number: number, branch: string, overrides: Partial<BoardOpenPull> = {}): BoardOpenPull {
  return { url: `https://github.com/acme/app/pull/${number}`, number, title: "Some change", branch, draft: false, conflict: false, doNotMerge: false, updatedAt: ago(10), ...overrides };
}
function input(overrides: Partial<BoardInput> = {}): BoardInput {
  return { now: NOW, hosts: [host("server087")], unreachable: [], issues: [], issuesAt: ago(0), pulls: [], pullsAt: ago(0), ...overrides };
}
function row(view: BoardView, id: string): BoardRow {
  const found = view.rows.find((candidate) => candidate.id === id);
  assert.ok(found, `row ${id} missing`);
  return found;
}

test("Linear status names place tickets on their belt", () => {
  const view = deriveBoard(input({
    issues: [issue("T-1", "Todo"), issue("T-2", "Plan review"), issue("T-3", "In Progress"), issue("T-4", "In Review"), issue("T-5", "Ready to merge"), issue("T-6", "Plan approved"), issue("T-7", "Planning")],
    hosts: [host("server087", { agents: [agent("T-3")] })],
  }));
  assert.deepEqual(Object.fromEntries(view.rows.map((r) => [r.id, r.stage])), { "T-1": "labelled", "T-2": "you", "T-3": "working", "T-4": "pr", "T-5": "queue", "T-6": "approved", "T-7": "planning" });
  assert.equal(row(view, "T-3").health, "ok");
  assert.deepEqual(row(view, "T-2").reasons.you, ["Plan waits for your review"]);
  assert.equal(row(view, "T-2").health, "you");
});

test("an unknown status name falls back to the Linear state type", () => {
  const view = deriveBoard(input({ issues: [issue("T-1", "Doing it", { statusType: "started" }), issue("T-2", "Icebox", { statusType: "backlog" })] }));
  assert.equal(row(view, "T-1").stage, "working");
  assert.equal(row(view, "T-2").stage, "labelled");
});

test("a recent plan run lifts an early ticket into planning or waiting on you; an old one does not", () => {
  const plan = (identifier: string, stage: "preparing" | "ready", since: string) => ({ identifier, stage, status: "normal" as const, since, lastProgressAt: since, detail: "" });
  const view = deriveBoard(input({
    issues: [issue("T-1", "Todo"), issue("T-2", "Todo"), issue("T-3", "Todo")],
    hosts: [host("server087", { plans: { lastArrivalAt: null, rows: [plan("T-1", "preparing", hours(1)), plan("T-2", "ready", hours(2)), plan("T-3", "preparing", hours(72))] } })],
  }));
  assert.equal(row(view, "T-1").stage, "planning");
  assert.equal(row(view, "T-2").stage, "you");
  assert.equal(row(view, "T-3").stage, "labelled");
});

test("merged keeps tickets completed in the last 24 hours, judged clean; older, canceled and duplicate tickets leave the board", () => {
  const view = deriveBoard(input({
    issues: [
      issue("T-1", "Done", { completedAt: hours(3) }), issue("T-2", "Done", { completedAt: hours(30) }),
      issue("T-3", "Canceled"), issue("T-4", "Duplicate", { statusType: "canceled" }),
    ],
    hosts: [host("server087", { steward: { at: ago(0), tickets: [steward("T-1", "watchdog-exhausted")] } })],
  }));
  assert.deepEqual(view.rows.map((r) => r.id), ["T-1"]);
  const merged = row(view, "T-1");
  assert.equal(merged.stage, "merged");
  assert.equal(merged.health, "ok");
  assert.equal(merged.since, hours(3));
  assert.deepEqual(merged.causes, []);
  assert.deepEqual(merged.reasons, { broken: [], stale: [], you: [], slow: [], blocked: [] });
});

test("steward verdicts and Linear labels break or stale a ticket, with grouped causes", () => {
  const view = deriveBoard(input({
    issues: [issue("T-1", "In Progress"), issue("T-2", "In Progress"), issue("T-3", "In Progress", { labels: ["paseo", "paseo-blocked"] })],
    hosts: [host("server087", { steward: { at: ago(0), tickets: [steward("T-1", "watchdog-exhausted"), steward("T-2", "stalled")] } })],
  }));
  assert.deepEqual(row(view, "T-1").reasons.broken, ["Watchdog gave up: restarts used up"]);
  assert.equal(row(view, "T-1").health, "broken");
  assert.deepEqual(row(view, "T-1").causes, [["broken", "Watchdog gave up: restarts used up"]]);
  assert.deepEqual(row(view, "T-2").reasons.stale, ["Stalled: no verified advancement"]);
  assert.equal(row(view, "T-2").health, "stale");
  assert.equal(row(view, "T-2").situation, "stalled");
  assert.deepEqual(row(view, "T-3").reasons.broken, ["Agent reported blocked"]);
});

test("agent errors, silent running agents and permission waits name the host", () => {
  const view = deriveBoard(input({
    issues: [issue("T-1", "In Progress"), issue("T-2", "In Progress"), issue("T-3", "In Progress"), issue("T-4", "In Progress")],
    hosts: [
      host("server087", { agents: [agent("T-1", { status: "error" }), agent("T-2", { updatedAt: ago(45) }), agent("T-4", { updatedAt: hours(3) })] }),
      host("mbp", { agents: [agent("T-3", { permission: true, status: "idle" })] }),
    ],
  }));
  assert.deepEqual(row(view, "T-1").reasons.broken, ["Agent error on server087"]);
  assert.deepEqual(row(view, "T-1").causes, [["broken", "Agent error"]]);
  assert.deepEqual(row(view, "T-2").reasons.stale, ["server087 agent shows running, no update for 45 min"]);
  assert.deepEqual(row(view, "T-2").causes, [["stale", "Agent says running, but silent"]]);
  assert.equal(row(view, "T-2").agents[0]?.quietMin, 45);
  assert.deepEqual(row(view, "T-4").reasons.stale, ["server087 agent shows running, no update for 3 h"]);
  assert.deepEqual(row(view, "T-3").reasons.you, ["Agent waits for a permission on mbp"]);
  assert.deepEqual(row(view, "T-3").hosts, ["mbp"]);
  assert.equal(row(view, "T-3").health, "you");
});

test("open pull requests join by ticket id in branch or title and carry CI, conflicts and queue drops", () => {
  const view = deriveBoard(input({
    issues: [issue("T-1", "In Review"), issue("T-2", "In Review"), issue("T-3", "In Review")],
    pulls: [
      pull(12, "me/t-1-fix-it"),
      pull(13, "unrelated", { title: "T-2: tidy", conflict: true, draft: true, doNotMerge: true }),
      pull(14, "me/t-3-x"),
      pull(15, "utf-8-cleanup", { title: "UTF-8 everywhere" }),
    ],
    hosts: [host("server087", { pulls: [
      { url: "https://github.com/acme/app/pull/12", failed: ["lint", "unit", "e2e"], running: 2, drops: 0, drop: null, activeAt: ago(30) },
      { url: "https://github.com/acme/app/pull/14", failed: [], running: 0, drops: 3, drop: "Merge queue: checks failed", activeAt: ago(20) },
    ] })],
  }));
  assert.deepEqual(view.rows.map((r) => r.id), ["T-1", "T-2", "T-3"]);
  const red = row(view, "T-1");
  assert.deepEqual(red.reasons.broken, ["CI red on #12: lint, unit"]);
  assert.equal(red.ciOnly, true);
  assert.equal(red.health, "broken");
  assert.deepEqual(red.causes, [["ci", "lint"], ["ci", "unit"], ["ci", "e2e"]]);
  assert.deepEqual(red.prs, [{ num: "12", url: "https://github.com/acme/app/pull/12", running: 2, conflict: false, dnm: false, draft: false, drops: 0, failed: true, drop: false }]);
  const conflicted = row(view, "T-2");
  assert.deepEqual(conflicted.reasons.stale, ["#13 has merge conflicts"]);
  assert.deepEqual(conflicted.causes, [["stale", "PR has merge conflicts"]]);
  assert.equal(conflicted.prs[0]?.draft, true);
  assert.equal(conflicted.prs[0]?.dnm, true);
  const dropped = row(view, "T-3");
  assert.deepEqual(dropped.reasons.broken, ["Dropped from merge queue (#14, 3 drops so far)"]);
  assert.deepEqual(dropped.causes, [["broken", "Dropped from merge queue"]]);
  assert.equal(dropped.ciOnly, false);
  assert.equal(dropped.repair.drops, 3);
  assert.equal(red.last, ago(10)); // the later of pr-watch's last activity and GitHub's update
  assert.equal(dropped.last, ago(10));
});

test("a ticket over its red limit is slow; health keeps broken over stale over you over slow", () => {
  const view = deriveBoard(input({
    issues: [issue("T-1", "In Progress", { startedAt: hours(13) }), issue("T-2", "Plan review", { labels: ["paseo"] }), issue("T-3", "Needs input")],
    hosts: [host("server087", {
      agents: [agent("T-2", { status: "error" }), agent("T-3", { updatedAt: ago(30) })],
      steward: { at: ago(0), tickets: [steward("T-2", "stalled", { since: hours(20) })] },
    })],
  }));
  assert.deepEqual(row(view, "T-1").reasons.slow, ["Working for 13 h (red limit 12 h)"]);
  assert.equal(row(view, "T-1").health, "slow");
  assert.equal(row(view, "T-1").since, hours(13));
  const both = row(view, "T-2");
  assert.equal(both.health, "broken");
  assert.deepEqual(both.reasons.stale, ["Stalled: no verified advancement"]);
  assert.deepEqual(both.reasons.you, ["Plan waits for your review"]);
  assert.deepEqual(both.reasons.slow, ["Waiting on you for 20 h (red limit 12 h)"]);
  assert.equal(row(view, "T-3").health, "stale");
  assert.deepEqual(row(view, "T-3").reasons.you, ["Agent asked you a question"]);
});

test("ownership violations and failed or stuck plan runs explain themselves", () => {
  const view = deriveBoard(input({
    issues: [issue("T-1", "In Progress"), issue("T-2", "Planning"), issue("T-3", "Planning")],
    hosts: [host("server087", {
      ownership: { at: ago(1), violations: [{ identifier: "T-1", kind: "in-progress-no-agent" }] },
      plans: { lastArrivalAt: null, rows: [
        { identifier: "T-2", stage: "preparing", status: "failed", since: hours(1), lastProgressAt: null, detail: "model refused" },
        { identifier: "T-3", stage: "preparing", status: "attention", since: hours(1), lastProgressAt: null, detail: "No progress for 25 min" },
      ] },
    })],
  }));
  assert.deepEqual(row(view, "T-1").reasons.stale, ["In Progress, but no agent and no queue entry"]);
  assert.deepEqual(row(view, "T-2").reasons.broken, ["Plan run failed: model refused"]);
  assert.deepEqual(row(view, "T-2").causes, [["broken", "Plan run failed"]]);
  assert.deepEqual(row(view, "T-3").causes, [["stale", "No progress for 25 min"]]);
  assert.deepEqual(row(view, "T-3").reasons.stale, ["No progress for 25 min"]);
});

test("a verdict resting only on an old steward pass is unverified", () => {
  const facts = (at: string) => host("server087", { steward: { at, tickets: [steward("T-1", "stalled"), steward("T-2", "moving")] } });
  const issues = [issue("T-1", "In Progress"), issue("T-2", "In Review"), issue("T-3", "In Progress")];
  const old = deriveBoard(input({ issues, hosts: [facts(ago(5)), host("mbp", { agents: [agent("T-3")] })] }));
  assert.equal(row(old, "T-1").unverified, true);
  assert.equal(row(old, "T-2").unverified, true);
  assert.equal(row(old, "T-3").unverified, false);
  const fresh = deriveBoard(input({ issues, hosts: [facts(ago(0.5))] }));
  assert.equal(row(fresh, "T-1").unverified, false);
  assert.equal(row(fresh, "T-2").unverified, false);
});

test("without Linear the board still shows agent and steward tickets and live plan runs, not finished or old ones", () => {
  const plan = (identifier: string, stage: "preparing" | "superseded", since: string) => ({ identifier, stage, status: "normal" as const, since, lastProgressAt: since, detail: "" });
  const view = deriveBoard(input({
    issues: null, issuesAt: null,
    hosts: [host("server087", {
      agents: [agent("T-9")],
      steward: { at: ago(0), tickets: [steward("T-8", "waiting-owner", { status: "Needs input" }), steward("T-7", "closed", { status: "Done" })] },
      plans: { lastArrivalAt: null, rows: [plan("T-4", "preparing", hours(1)), plan("T-5", "preparing", hours(72)), plan("T-6", "superseded", hours(1))] },
    })],
  }));
  assert.deepEqual(view.rows.map((r) => r.id), ["T-4", "T-8", "T-9"]);
  assert.equal(row(view, "T-4").stage, "planning");
  assert.equal(row(view, "T-9").stage, "working");
  assert.equal(row(view, "T-9").title, "Agent title");
  assert.equal(row(view, "T-8").stage, "you");
  assert.equal(row(view, "T-8").status, "Needs input");
  assert.deepEqual(view.sources, [["Linear", null], ["GitHub", ago(0)]]);
});

test("rows sort by ticket number", () => {
  const view = deriveBoard(input({ issues: [issue("T-10", "Todo"), issue("T-9", "Todo"), issue("A-2", "Todo")] }));
  assert.deepEqual(view.rows.map((r) => r.id), ["A-2", "T-9", "T-10"]);
});

test("repair shows what watchdog and steward already tried in the last day", () => {
  const view = deriveBoard(input({
    issues: [issue("T-1", "In Progress")],
    hosts: [host("server087", {
      watchdog: [{ identifier: "T-1", starts: [hours(30), hours(26), hours(2)], cycle: "working", exhaustedAt: null }],
      steward: { at: ago(0), tickets: [steward("T-1", "moving", {
        restarts: [hours(3)], refusals: [{ at: hours(1), reason: "x".repeat(200) }],
        log: [{ at: hours(30), action: "start: done" }, { at: hours(3), action: "restart: done" }, { at: hours(2), action: "resume: done" }, { at: hours(1), action: "verify: failed" }, { at: ago(5), action: "verify: done" }],
      })] },
    })],
  }));
  const repair = row(view, "T-1").repair;
  assert.deepEqual(repair.watchdog, { used24: 1, cap: 2, total: 3, exhaustedAt: null, cycle: "working" });
  assert.deepEqual(repair.steward, { used24: 1, cap: 3, total: 1, refusals: 1, lastRefusal: "x".repeat(180), escalatedAt: null });
  assert.deepEqual(repair.log, [[hours(3), "restart: done"], [hours(2), "resume: done"], [hours(1), "verify: failed"], [ago(5), "verify: done"]]);
  assert.deepEqual(repair.acts24, { resume: 1, verify: 2 });
});

test("hosts, unreachable peers, flow and sources describe where the board comes from", () => {
  const counts = { running: 3, idle: 1, initializing: 0, error: 1, permission: 0 };
  const view = deriveBoard(input({
    issues: [issue("T-1", "Done", { completedAt: hours(2) }), issue("T-2", "Done", { completedAt: hours(20) })],
    hosts: [
      host("server087", {
        agentCounts: counts, maxRunning: 50,
        steward: { at: ago(1), tickets: [] }, ownership: { at: ago(2), violations: [] },
        plans: { lastArrivalAt: hours(1), rows: [] },
        flow: { planning: 4, arrived: 3, decided: 2, autoApproved: 1, starts: 5, openedPr: 2, enqueued: 1 },
      }),
      host("mbp", { flow: { planning: 1, arrived: 1, decided: 1, autoApproved: 0, starts: 0, openedPr: 0, enqueued: 2 } }),
    ],
    unreachable: ["https://peer.example:8444"],
  }));
  assert.deepEqual(view.unreachable, ["https://peer.example:8444"]);
  assert.deepEqual(view.hosts.map((h) => h.key), ["server087", "mbp"]);
  assert.deepEqual(view.hosts[0], { key: "server087", agents: counts, maxRunning: 50, facts: [["Agent list", ago(0)], ["Steward: last pass", ago(1)], ["Ownership check", ago(2)], ["Plan journal: last plan arrived", hours(1)]] });
  assert.deepEqual(view.hosts[1]?.facts, [["Agent list", ago(0)], ["Plan journal: last plan arrived", null]]);
  assert.equal(view.flow.labelled, null);
  assert.deepEqual(view.flow.planning, { n: 5, what: "plan runs started" });
  assert.deepEqual(view.flow.you, { n: 4, what: "plans arrived" });
  assert.deepEqual(view.flow.approved, { n: 3, what: "plans decided", extra: "1 auto-approved" });
  assert.equal(view.flow.working?.n, 5);
  assert.equal(view.flow.pr?.n, 2);
  assert.equal(view.flow.queue?.n, 3);
  assert.deepEqual(view.flow.merged, { n: 2, what: "tickets done" });
  assert.deepEqual(view.stages, ["labelled", "planning", "you", "approved", "working", "pr", "queue", "merged"]);
  assert.equal(view.labels.merged, "Merged (24 h)");
  assert.deepEqual(view.limits.working, [4, 12]);
  assert.equal(view.limits.merged, undefined);
  assert.equal(view.now, NOW.toISOString());
});
