import { BOARD_STAGES, type BoardAgentFact, type BoardCauseKind, type BoardFlow, type BoardFlowFacts, type BoardHealth, type BoardInput, type BoardIssue, type BoardOpenPull, type BoardPlanFact, type BoardPullFact, type BoardRepair, type BoardRow, type BoardRowAgent, type BoardRowPull, type BoardStage, type BoardStewardFact, type BoardView, type BoardWatchdogFact } from "../shared/board";
import { RESTART_CAP } from "./steward";
import { WATCHDOG_CYCLES } from "./watchdog";

// The factory board's derivation (the plan's "Derivation" section): pure, so the route can hand it
// a snapshot and the tests can pin every string. A port of the v3-factory prototype's build.py,
// with the corrections the plan lists: "merged" means completed in the last 24 h, unknown Linear
// status names fall back to the state's type, and the ticket set also holds agent- and plan-only
// tickets.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// A running agent that has not touched its session for this long is stale, not busy.
const QUIET_MS = 20 * MINUTE_MS;
// A verdict that rests only on the steward is trusted for this long (the steward passes every minute).
const STALE_SOURCE_MS = 90_000;
// A plan row older than this says nothing about where its ticket is now.
const PLAN_WINDOW_MS = 2 * DAY_MS;

// Orange / red limits per stage, in hours: the stage's age turns the card orange, then red.
const LIMITS: Partial<Record<BoardStage, [number, number]>> = {
  labelled: [2, 6], planning: [1, 2], you: [2, 12], approved: [0.5, 2], working: [4, 12], pr: [12, 48], queue: [0.5, 2],
};
const STAGE_LABEL: Record<BoardStage, string> = {
  labelled: "Labelled", planning: "Planning", you: "Waiting on you", approved: "Approved", working: "Working",
  pr: "Pull request", queue: "Ready / queue", merged: "Merged (24 h)",
};
const STATUS_STAGE: Record<string, BoardStage> = {
  Todo: "labelled", Backlog: "labelled", Triage: "labelled", Planning: "planning", "Plan review": "you",
  "Needs input": "you", "Plan approved": "approved", "In Progress": "working", "In Review": "pr",
  "Ready to merge": "queue", Done: "merged",
};
// Linear lets a team rename its states; the state's type still says where the ticket sits.
const STATUS_TYPE_STAGE: Record<string, BoardStage> = {
  triage: "labelled", backlog: "labelled", unstarted: "labelled", started: "working", completed: "merged",
};
const PLAN_RUNNING = ["preparing", "advisor", "publishing", "queued"];
const PLAN_WAITING = ["waiting", "ready"];
const STEWARD_BROKEN: Record<string, string> = {
  "watchdog-exhausted": "Watchdog gave up: restarts used up",
  "restart-exhausted": "Restarts used up",
  escalated: "Escalated by the steward",
};
const STEWARD_STALE: Record<string, string> = {
  stalled: "Stalled: no verified advancement",
  "idle-unresponsive": "Agent idle and not responding",
  "wait-stale": "Waiting, but the wait went stale",
  "queued-too-long": "Queued too long",
  idle: "Agent idle while the ticket is open",
};
const VIOLATION: Record<string, string> = {
  "in-progress-no-agent": "In Progress, but no agent and no queue entry",
  "needs-input-no-question": "Needs input, but no open question",
  "planning-no-agent": "Planning, but no planner running",
  "review-missing": "Plan review, but the review is missing",
  "approved-no-handoff": "Plan approved, but nobody picked it up",
};
const WAITING_REASON: Record<string, string> = {
  "Plan review": "Plan waits for your review",
  "Needs input": "Agent asked you a question",
  "Ready to merge": "Ready to merge: waiting on you",
};
// Reasons that are the same failure across tickets, so the board counts them once.
const CAUSE_PATTERNS: [RegExp, string][] = [
  [/^Dropped from merge queue/, "Dropped from merge queue"],
  [/has merge conflicts$/, "PR has merge conflicts"],
  [/agent shows running, no update/, "Agent says running, but silent"],
  [/^Agent error on/, "Agent error"],
  [/^Agent waits for a permission/, "Agent waits for a permission"],
  [/^Plan run failed/, "Plan run failed"],
];

// Rows read like the belt: project prefix first, then ticket number (T-9 before T-10).
function ticketOrder(left: string, right: string) {
  const a = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(left);
  const b = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(right);
  if (a && b) return a[1] === b[1] ? Number(a[2]) - Number(b[2]) : a[1] < b[1] ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deriveBoard(input: BoardInput): BoardView {
  const now = input.now.getTime();
  const dayAgo = now - DAY_MS;
  const inDay = (at: string | null) => {
    if (!at) return false;
    const time = Date.parse(at);
    return time >= dayAgo && time <= now;
  };

  // Facts from the hosts that ran them: a ticket's steward judgement and ownership violation live
  // on the host that keeps the ledger, so the first host with one supplies them all.
  const agentsByTicket = new Map<string, { host: string; agent: BoardAgentFact }[]>();
  const stewardTickets = new Map<string, BoardStewardFact>();
  const violations = new Map<string, string>();
  const watchdogs = new Map<string, BoardWatchdogFact>();
  const plans = new Map<string, BoardPlanFact>();
  const watchedPulls = new Map<string, BoardPullFact>();
  let stewardAt: string | null = null;
  let haveSteward = false;
  let haveOwnership = false;
  for (const host of input.hosts) {
    for (const agent of host.agents) {
      const entries = agentsByTicket.get(agent.identifier);
      if (entries) entries.push({ host: host.host, agent });
      else agentsByTicket.set(agent.identifier, [{ host: host.host, agent }]);
    }
    if (!haveSteward && host.steward) {
      haveSteward = true;
      stewardAt = host.steward.at;
      for (const ticket of host.steward.tickets) stewardTickets.set(ticket.identifier, ticket);
    }
    if (!haveOwnership && host.ownership) {
      haveOwnership = true;
      for (const violation of host.ownership.violations) violations.set(violation.identifier, violation.kind);
    }
    for (const entry of host.watchdog) if (!watchdogs.has(entry.identifier)) watchdogs.set(entry.identifier, entry);
    for (const row of host.plans.rows) {
      const current = plans.get(row.identifier);
      if (!current || Date.parse(row.since) > Date.parse(current.since)) plans.set(row.identifier, row);
    }
    for (const pull of host.pulls) if (!watchedPulls.has(pull.url)) watchedPulls.set(pull.url, pull);
  }

  const issues = new Map<string, BoardIssue>((input.issues ?? []).map((issue) => [issue.identifier, issue]));
  // Agent-only tickets have no URL of their own; any Linear URL names the workspace that holds them.
  const issueBase = /^(https:\/\/linear\.app\/[^/]+\/issue\/)/.exec(input.issues?.[0]?.url ?? "")?.[1] ?? null;
  // A plan row brings its ticket on board only while its run is fresh and still going or waiting:
  // finished, superseded and old rows describe tickets Linear has already moved past.
  const livePlans = [...plans.values()].filter((plan) => Date.parse(plan.since) > now - PLAN_WINDOW_MS && [...PLAN_RUNNING, ...PLAN_WAITING].includes(plan.stage));
  const known = new Set<string>([...issues.keys(), ...agentsByTicket.keys(), ...livePlans.map((plan) => plan.identifier)]);
  // Linear also reports the tickets it does not know: closed situations would come back as rows.
  if (input.issues === null) for (const [identifier, ticket] of stewardTickets) if (ticket.situation !== "closed") known.add(identifier);

  // Open pull requests join a ticket by its id in the title or in the (upper-cased) branch, matched
  // only against tickets the board has: UTF-8 in a branch is not a ticket.
  const pullsByTicket = new Map<string, BoardOpenPull[]>();
  for (const pull of input.pulls ?? []) {
    for (const identifier of new Set(`${pull.title} ${pull.branch.toUpperCase()}`.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [])) {
      if (!known.has(identifier)) continue;
      const matched = pullsByTicket.get(identifier);
      if (matched) matched.push(pull);
      else pullsByTicket.set(identifier, [pull]);
    }
  }

  const rows: BoardRow[] = [];
  for (const identifier of known) {
    const issue = issues.get(identifier);
    const ticket = stewardTickets.get(identifier);
    const status = issue?.status ?? ticket?.status ?? null;
    const statusType = issue?.statusType;
    const listed = (status ? STATUS_STAGE[status] : undefined) ?? (statusType ? STATUS_TYPE_STAGE[statusType] : undefined);
    if (status === "Canceled" || status === "Duplicate" || statusType === "canceled") continue;
    // "Merged" is a 24 h window, not a state: older completions leave the board, and a ticket the
    // steward alone saw as Done has no completion time to place it in the window.
    if (listed === "merged" && !inDay(issue?.completedAt ?? null)) continue;

    const plan = plans.get(identifier);
    let stage = listed;
    // A fresh plan run lifts an early ticket only, never an approved or working one.
    if (plan && Date.parse(plan.since) > now - PLAN_WINDOW_MS && (stage === undefined || stage === "labelled" || stage === "planning")) {
      if (PLAN_RUNNING.includes(plan.stage)) stage = "planning";
      else if (PLAN_WAITING.includes(plan.stage)) stage = "you";
    }
    const agents = agentsByTicket.get(identifier) ?? [];
    if (stage === undefined) stage = agents.some(({ agent }) => agent.status === "running") ? "working" : "labelled";
    const labels = issue?.labels ?? [];

    const matched = pullsByTicket.get(identifier) ?? [];
    const prs: BoardRowPull[] = matched.map((pull) => {
      const watch = watchedPulls.get(pull.url);
      return {
        num: String(pull.number), url: pull.url, running: watch?.running ?? 0, conflict: pull.conflict,
        dnm: pull.doNotMerge, draft: pull.draft, drops: watch?.drops ?? 0,
        failed: (watch?.failed.length ?? 0) > 0, drop: Boolean(watch?.drop),
      };
    });

    const broken: string[] = [];
    const stale: string[] = [];
    const you: string[] = [];
    const slow: string[] = [];
    const blocked: string[] = [];
    const situation = ticket?.situation ?? null;
    if (situation && Object.hasOwn(STEWARD_BROKEN, situation)) broken.push(STEWARD_BROKEN[situation]);
    if (labels.includes("paseo-blocked")) broken.push("Agent reported blocked");
    if (labels.includes("paseo-failed")) broken.push("Agent launch failed");
    for (const { host, agent } of agents) if (agent.status === "error") broken.push(`Agent error on ${host}`);
    const ci: string[] = [];
    for (const pull of matched) {
      const watch = watchedPulls.get(pull.url);
      const failed = watch?.failed ?? [];
      if (failed.length) ci.push(`CI red on #${pull.number}: ${failed.slice(0, 2).join(", ")}`);
      if (watch?.drop) broken.push(`Dropped from merge queue (#${pull.number}${watch.drops >= 2 ? `, ${watch.drops} drops so far)` : ")"}`);
      if (pull.conflict) stale.push(`#${pull.number} has merge conflicts`);
    }
    // The core failures describe the ticket; red CI is recorded separately so the board can say
    // "only CI" and group each failing check.
    const core = [...broken];
    broken.push(...ci);
    const planBroken = plan?.status === "failed" ? [`Plan run failed: ${plan.detail}`.trim()] : [];
    broken.push(...planBroken);

    if (situation && Object.hasOwn(STEWARD_STALE, situation)) stale.push(STEWARD_STALE[situation]);
    const violation = violations.get(identifier);
    if (violation) stale.push(VIOLATION[violation] ?? violation);
    if (plan?.status === "attention") stale.push(plan.detail || "Plan run needs attention");

    const rowAgents: BoardRowAgent[] = [];
    for (const { host, agent } of agents) {
      const updated = Date.parse(agent.updatedAt);
      const quietMin = Number.isFinite(updated) ? Math.floor((now - updated) / MINUTE_MS) : null;
      if (agent.status === "running" && quietMin !== null && now - updated > QUIET_MS) {
        stale.push(`${host} agent shows running, no update for ${quietMin < 120 ? `${quietMin} min` : `${Math.floor(quietMin / 60)} h`}`);
      }
      if (agent.permission) you.push(`Agent waits for a permission on ${host}`);
      rowAgents.push({ host, status: agent.status, permission: agent.permission, quietMin, inside: agent.inside });
    }

    if (stage === "you" || labels.includes("paseo-needs-you") || (situation === "waiting-owner" && stage === "queue")) {
      you.push((status ? WAITING_REASON[status] : undefined) ?? "Waiting on you");
    }
    if (situation === "waiting-blocker") blocked.push("Waiting on another ticket");

    // Time in this stage: the steward's situation start when it matches, else the ticket's own
    // start (working) or its completion (merged), else the last Linear update.
    let since = ticket?.since ?? null;
    if (stage === "merged") since = issue?.completedAt ?? null;
    else if (stage === "working" && issue?.startedAt && !since) since = issue.startedAt;
    if (!since) since = issue?.updatedAt ?? agents[0]?.agent.createdAt ?? null;
    const limit = LIMITS[stage];
    const sinceAt = since ? Date.parse(since) : Number.NaN;
    if (limit && Number.isFinite(sinceAt) && now - sinceAt > limit[1] * HOUR_MS) {
      slow.push(`${STAGE_LABEL[stage]} for ${Math.round((now - sinceAt) / HOUR_MS)} h (red limit ${String(limit[1])} h)`);
    }

    // The last sign of activity anywhere: the agent, the pull request (pr-watch or GitHub), the
    // plan journal, the steward's verified advancement.
    const activity = [
      ...agents.map(({ agent }) => agent.updatedAt),
      ...matched.map((pull) => {
        const activeAt = watchedPulls.get(pull.url)?.activeAt;
        return activeAt && Date.parse(activeAt) > Date.parse(pull.updatedAt) ? activeAt : pull.updatedAt;
      }),
      ...(plan?.lastProgressAt ? [plan.lastProgressAt] : []),
      ...(ticket?.advancedAt ? [ticket.advancedAt] : []),
    ];
    const last = activity.reduce<string | null>((latest, at) => (latest === null || Date.parse(at) > Date.parse(latest) ? at : latest), null);

    const causes: [BoardCauseKind, string][] = [];
    const addCause = (kind: BoardCauseKind, reason: string) => {
      const label = CAUSE_PATTERNS.find(([pattern]) => pattern.test(reason))?.[1] ?? reason;
      if (!causes.some(([existingKind, existing]) => existingKind === kind && existing === label)) causes.push([kind, label]);
    };
    for (const reason of [...core, ...planBroken]) addCause("broken", reason);
    for (const reason of stale) addCause("stale", reason);
    for (const reason of you) addCause("you", reason);
    for (const pull of matched) for (const name of watchedPulls.get(pull.url)?.failed ?? []) addCause("ci", name);

    let ciOnly = ci.length > 0 && broken.length === ci.length;
    if (stage === "merged") {
      // Landed: nothing left to judge on the card, not even the steward's last verdict.
      broken.length = 0; stale.length = 0; you.length = 0; slow.length = 0; blocked.length = 0; causes.length = 0;
      ciOnly = false;
    }
    const health: BoardHealth = broken.length ? "broken" : stale.length ? "stale" : you.length ? "you" : slow.length ? "slow" : blocked.length ? "blocked" : "ok";

    // A verdict that rests only on steward data older than 90 s is dashed, never plain green: an
    // empty green card may mean the steward is dead, not the ticket fine.
    const stewardOld = stewardAt !== null && now - Date.parse(stewardAt) > STALE_SOURCE_MS;
    const stewardOnly = ((situation !== null && (Object.hasOwn(STEWARD_BROKEN, situation) || Object.hasOwn(STEWARD_STALE, situation))) || violation !== undefined || blocked.length > 0)
      && broken.length + stale.length <= (situation !== null && Object.hasOwn(STEWARD_BROKEN, situation) ? 1 : 0) + (situation !== null && Object.hasOwn(STEWARD_STALE, situation) ? 1 : 0) + (violation !== undefined ? 1 : 0);
    const unverified = stage !== "merged" && stewardOld && (stewardOnly || (health === "ok" && agents.length === 0 && matched.length === 0));

    const title = agents[0]?.agent.title ?? "";
    const cut = title.indexOf(": ");
    rows.push({
      id: identifier,
      title: issue?.title ?? (cut < 0 ? title : title.slice(cut + 2)),
      url: issue?.url ?? (issueBase && `${issueBase}${identifier}`),
      project: issue?.project ?? null, status, stage, health, since, last,
      hosts: [...new Set(agents.map(({ host }) => host))].sort(),
      agents: rowAgents,
      repair: repairOf(ticket, watchdogs.get(identifier), prs, inDay),
      causes, prs,
      reasons: { broken, stale, you, slow, blocked },
      ciOnly, situation, unverified,
    });
  }
  rows.sort((left, right) => ticketOrder(left.id, right.id));

  const sum = (key: keyof BoardFlowFacts) => input.hosts.reduce((total, host) => total + host.flow[key], 0);
  const flow: Record<BoardStage, BoardFlow> = {
    labelled: null,
    planning: { n: sum("planning"), what: "plan runs started" },
    you: { n: sum("arrived"), what: "plans arrived" },
    approved: { n: sum("decided"), what: "plans decided", extra: `${sum("autoApproved")} auto-approved` },
    working: { n: sum("starts"), what: "agent starts", extra: "lower bound: log keeps 10 per ticket" },
    pr: { n: sum("openedPr"), what: "tickets opened a PR" },
    queue: { n: sum("enqueued"), what: "enqueued by the backstop", extra: "agents also enqueue themselves: not counted" },
    merged: { n: rows.filter((row) => row.stage === "merged").length, what: "tickets done" },
  };

  const hosts = input.hosts.map((host) => {
    const facts: [string, string | null][] = [["Agent list", host.collectedAt]];
    if (host.steward) facts.push(["Steward: last pass", host.steward.at]);
    if (host.ownership) facts.push(["Ownership check", host.ownership.at]);
    facts.push(["Plan journal: last plan arrived", host.plans.lastArrivalAt]);
    return { key: host.host, agents: host.agentCounts, maxRunning: host.maxRunning, facts };
  });

  return {
    now: input.now.toISOString(),
    stages: [...BOARD_STAGES],
    labels: { ...STAGE_LABEL },
    limits: { ...LIMITS },
    hosts,
    unreachable: input.unreachable,
    sources: [["Linear", input.issuesAt], ["GitHub", input.pullsAt]],
    rows,
    flow,
  };
}

// What automatic repair already tried. No dedicated repair agent exists, so the slot is only the
// watchdog's and steward's recorded budget.
function repairOf(ticket: BoardStewardFact | undefined, watchdog: BoardWatchdogFact | undefined, pulls: BoardRowPull[], inDay: (at: string | null) => boolean): BoardRepair {
  const repair: BoardRepair = {};
  if (watchdog?.starts.length) {
    repair.watchdog = { used24: watchdog.starts.filter((at) => inDay(at)).length, cap: WATCHDOG_CYCLES, total: watchdog.starts.length, exhaustedAt: watchdog.exhaustedAt, cycle: watchdog.cycle };
  }
  if (ticket && (ticket.restarts.length || ticket.refusals.length || ticket.escalatedAt)) {
    repair.steward = {
      used24: ticket.restarts.filter((at) => inDay(at)).length, cap: RESTART_CAP, total: ticket.restarts.length,
      refusals: ticket.refusals.length, lastRefusal: ticket.refusals.at(-1)?.reason.slice(0, 180) ?? "",
      escalatedAt: ticket.escalatedAt,
    };
  }
  const drops = pulls.reduce((total, pull) => total + pull.drops, 0);
  if (drops) repair.drops = drops;
  const log = (ticket?.log.slice(-4) ?? []).map((entry): [string, string] => [entry.at, entry.action.slice(0, 140)]);
  if (log.length) repair.log = log;
  const acts: Record<string, number> = {};
  for (const entry of ticket?.log ?? []) {
    const match = inDay(entry.at) ? /^(resume|escalate|succeed|diagnostic|start|verify): (?:done|failed|timeout)/.exec(entry.action) : null;
    if (match) acts[match[1]] = (acts[match[1]] ?? 0) + 1;
  }
  if (Object.keys(acts).length) repair.acts24 = acts;
  return repair;
}