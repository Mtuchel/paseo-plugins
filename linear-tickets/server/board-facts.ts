import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { BoardAgentFact, BoardFlowFacts, BoardHostFacts, BoardInside, BoardPlanFact, BoardPullFact, BoardStewardFact, BoardWatchdogFact, BoardWorkGroup } from "../shared/board";
import { PipelineStage, PipelineStatus } from "../shared/plan-pipeline";
import type { AgentDirectory } from "./agent-directory";

// This host's raw half of the factory board (GET /api/board/local): its live ticket agents with
// what each is doing right now, and the state its ledgers hold. Read-only and best effort: a
// ledger that is missing or malformed contributes its empty value, while the Paseo listing and
// the timelines are the only reads whose failure is allowed to fail the answer.

export type BoardFactsDeps = {
  host: string;
  home: string;
  paseo: () => PaseoApi | null;
  // The shared read-only agent listing (TUC-3006).
  agentDirectory: Pick<AgentDirectory, "live">;
  maxRunning: () => Promise<number | null>;
  now?: () => Date;
};

const WINDOW_MS = 24 * 60 * 60_000;
// This many timelines are refetched at once (about 0.3 s each on server087); the rest wait, so one
// host's read stays bounded.
const TIMELINE_CONCURRENCY = 8;
const TIMELINE_TAIL = 200;
const TEXT = 300;
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true };
const RUN_TOOLS: Record<string, true> = { bash: true, eval: true, shell: true };
const TEAM_TOOLS: Record<string, true> = {
  task: true, create_agent: true, send_agent_prompt: true, ask: true, respond_to_permission: true, archive_agent: true,
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown, max = TEXT): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
}
// Every ledger time is normalized to the ISO form the contract validates; anything else is absent.
function at(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
// A ledger is a read-only hint: missing, unreadable or invalid JSON is the same as no file.
async function ledger(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

function workGroup(name: string): BoardWorkGroup {
  if (EDIT_TOOLS[name] === true) return "edit";
  if (RUN_TOOLS[name] === true) return "run";
  if (name === "wait") return "wait";
  if (TEAM_TOOLS[name] === true) return "team";
  if (/linear|save_comment|save_issue/i.test(name)) return "linear";
  return "read";
}

function checklistOf(value: unknown): NonNullable<BoardInside["checklist"]> {
  const items = list(value).map((item) => object(item)).filter((item): item is Record<string, unknown> => item !== null);
  const open: [string, "in_progress" | "pending"][] = [];
  let done = 0;
  for (const item of items) {
    if (item.completed === true || item.status === "completed") { done++; continue; }
    if ((item.status === "in_progress" || item.status === "pending") && open.length < 10) open.push([text(item.text), item.status]);
  }
  return { done, total: items.length, items: open };
}

// The tail, read as the operator sees it: the latest checklist, where the tool calls went, and
// the last six steps. Entries that carry no time keep their place in the daemon's order.
function insideOf(entries: { item: unknown; timestamp: unknown }[]): BoardInside {
  const ordered = entries.map((entry) => ({ entry, time: Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "") }))
    .sort((a, b) => (Number.isFinite(a.time) ? a.time : 0) - (Number.isFinite(b.time) ? b.time : 0))
    .map(({ entry }) => entry);
  let checklist: BoardInside["checklist"] = null;
  const counts = new Map<BoardWorkGroup, number>();
  const steps: string[] = [];
  let said: string | null = null;
  for (const entry of ordered) {
    const item = object(entry.item);
    if (!item) continue;
    if (item.type === "todo") { checklist = checklistOf(item.items); continue; }
    if (item.type === "assistant_message") {
      const message = text(item.text);
      // The tail also carries bare punctuation fragments ("."), which say nothing.
      if (!/[\p{L}\p{N}]/u.test(message)) continue;
      said = message;
      steps.push(message);
      continue;
    }
    if (item.type !== "tool_call") continue;
    const name = text(item.name, 100);
    if (!name) continue;
    const group = workGroup(name);
    counts.set(group, (counts.get(group) ?? 0) + 1);
    const detail = object(item.detail);
    steps.push(detail?.type === "shell" && typeof detail.command === "string" ? `${name}: ${text(detail.command, TEXT - name.length - 2)}` : name);
  }
  const mix = [...counts].sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName));
  return { checklist, mix, recent: steps.slice(-6), said };
}

async function readInside(paseo: PaseoApi, agent: PaseoAgent): Promise<BoardInside> {
  const page = await paseo.agents.ref(agent).timeline.refetch({ direction: "tail", projection: "canonical", limit: TIMELINE_TAIL });
  if (page.error) throw new Error("Public timeline unavailable");
  return insideOf(Array.isArray(page.entries) ? page.entries : []);
}

// `responsibility.observedStage` is the steward's own JSON snapshot of the ticket's stage; the
// status name sits second in its `status` pair ([type, name]).
function observedStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const stage = object(JSON.parse(value));
    const name = list(stage?.status)[1];
    return typeof name === "string" ? text(name, 100) : null;
  } catch { return null; }
}

function stewardTicket(raw: unknown): BoardStewardFact | null {
  const ticket = object(raw);
  const identifier = text(ticket?.identifier, 50);
  if (!ticket || !identifier) return null;
  const responsibility = object(ticket.responsibility);
  return {
    identifier,
    situation: text(ticket.situation, 60),
    since: at(ticket.since),
    restarts: list(ticket.restarts).map(at).filter((when): when is string => when !== null).slice(0, 200),
    refusals: list(ticket.refusals).map((entry) => {
      const refusal = object(entry);
      const when = at(refusal?.at);
      return when === null ? null : { at: when, reason: text(refusal?.reason, 400) };
    }).filter((refusal): refusal is { at: string; reason: string } => refusal !== null).slice(0, 200),
    escalatedAt: at(object(ticket.escalated)?.at),
    log: list(ticket.log).map((entry) => {
      const action = object(entry);
      const when = at(action?.at);
      return when === null ? null : { at: when, action: text(action?.action, 300) };
    }).filter((action): action is { at: string; action: string } => action !== null).slice(-10),
    status: observedStatus(responsibility?.observedStage),
    advancedAt: at(responsibility?.lastVerifiedAdvancementAt),
  };
}

function stewardFacts(raw: unknown): NonNullable<BoardHostFacts["steward"]> | null {
  const file = object(raw);
  const tickets = object(file?.tickets);
  if (!file || !tickets) return null;
  return {
    at: at(object(file.flow)?.at),
    tickets: Object.values(tickets).map(stewardTicket).filter((ticket): ticket is BoardStewardFact => ticket !== null).slice(0, 5_000),
  };
}

function ownershipFacts(raw: unknown): BoardHostFacts["ownership"] {
  const file = object(raw);
  if (!file) return null;
  return {
    at: at(file.checkedAt),
    violations: list(file.violations).map((entry) => {
      const violation = object(entry);
      const identifier = text(violation?.identifier, 50);
      return violation && identifier ? { identifier, kind: text(violation.kind, 100) } : null;
    }).filter((violation): violation is { identifier: string; kind: string } => violation !== null).slice(0, 2_000),
  };
}

function watchdogFacts(raw: unknown): BoardWatchdogFact[] {
  const tickets = object(object(raw)?.tickets);
  if (!tickets) return [];
  return Object.values(tickets).map((entry) => {
    const ticket = object(entry);
    const identifier = text(ticket?.identifier, 50);
    if (!ticket || !identifier) return null;
    return {
      identifier,
      starts: list(ticket.starts).map(at).filter((when): when is string => when !== null).slice(0, 200),
      cycle: text(object(ticket.cycle)?.stage, 60) || null,
      exhaustedAt: at(object(ticket.exhausted)?.at),
    };
  }).filter((ticket): ticket is BoardWatchdogFact => ticket !== null).slice(0, 5_000);
}

function planFacts(raw: unknown): { lastArrivalAt: string | null; rows: BoardPlanFact[]; records: unknown[] } {
  const file = object(raw);
  const newest = new Map<string, BoardPlanFact>();
  for (const entry of list(file?.records)) {
    const row = object(object(entry)?.row);
    const identifier = text(row?.identifier, 50);
    const since = at(row?.since);
    const stage = PipelineStage.safeParse(row?.stage);
    const status = PipelineStatus.safeParse(row?.status);
    if (!row || !identifier || since === null || !stage.success || !status.success) continue;
    const fact: BoardPlanFact = { identifier, stage: stage.data, status: status.data, since, lastProgressAt: at(row.lastProgressAt), detail: text(row.detail, 1_400) };
    const current = newest.get(identifier);
    if (!current || Date.parse(fact.since) > Date.parse(current.since)) newest.set(identifier, fact);
  }
  return {
    lastArrivalAt: at(file?.lastArrivalAt),
    rows: [...newest.values()].sort((left, right) => left.identifier.localeCompare(right.identifier)).slice(0, 1_000),
    records: list(file?.records),
  };
}

function checksOf(value: unknown): { failed: string[]; running: number } {
  if (typeof value !== "string") return { failed: [], running: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { failed: [], running: 0 }; }
  const failed: string[] = [];
  let running = 0;
  for (const entry of list(parsed)) {
    const check = list(entry);
    const name = text(check[0], 200);
    if (check[1] === "failed" && name) failed.push(name);
    else if (check[1] === "pending") running++;
  }
  return { failed: failed.slice(0, 100), running };
}

function pullFacts(raw: unknown): BoardPullFact[] {
  const entries = object(raw);
  if (!entries) return [];
  const pulls: BoardPullFact[] = [];
  for (const [url, value] of Object.entries(entries)) {
    const entry = object(value);
    if (!entry || entry.merged === true || entry.closed === true || entry.missing === true) continue;
    const checks = checksOf(entry.ci);
    const reason = object(entry.pending)?.reason;
    pulls.push({
      url: text(url, 300), failed: checks.failed, running: checks.running,
      drops: list(entry.drops).length, drop: typeof reason === "string" ? text(reason, 1_400) : null, activeAt: at(entry.activeAt),
    });
  }
  return pulls.slice(0, 3_000);
}

// Arrivals at each station in the last day, from the ledgers as this host wrote them. The
// steward's log keeps ten actions per ticket, so a busy ticket's starts are a lower bound.
function flowFacts(now: Date, records: unknown[], steward: BoardHostFacts["steward"], pulls: unknown): BoardFlowFacts {
  const from = now.getTime() - WINDOW_MS;
  const inWindow = (when: string | null) => when !== null && Date.parse(when) >= from && Date.parse(when) <= now.getTime();
  const flow: BoardFlowFacts = { planning: 0, arrived: 0, decided: 0, autoApproved: 0, starts: 0, openedPr: 0, enqueued: 0 };
  for (const entry of records) {
    const record = object(entry);
    const key = text(record?.key, 200);
    const history = list(record?.history).map((item) => object(item)).filter((item): item is Record<string, unknown> => item !== null);
    if (key.startsWith("planning:")) {
      if (inWindow(at(history[0]?.at))) flow.planning++;
      continue;
    }
    if (!key.startsWith("submit:") && !key.startsWith("review:")) continue;
    for (const step of history) {
      const when = at(step.at);
      if (!inWindow(when)) continue;
      if (step.stage === "ready") flow.arrived++;
      if (step.stage === "completed" || step.stage === "auto-approved") {
        flow.decided++;
        if (step.stage === "auto-approved") flow.autoApproved++;
        break;
      }
    }
  }
  for (const ticket of steward?.tickets ?? []) {
    if (ticket.situation === "open-pr" && inWindow(ticket.since)) flow.openedPr++;
    flow.starts += ticket.log.filter((action) => (action.action.startsWith("start: done") || action.action.startsWith("succeed: done")) && inWindow(action.at)).length;
  }
  for (const entry of Object.values(object(pulls) ?? {})) {
    for (const action of list(object(entry)?.actions)) {
      const step = object(action);
      if (object(step?.steps)?.enqueue === "enqueued" && inWindow(at(step?.at))) flow.enqueued++;
    }
  }
  return flow;
}

function liveStatus(agent: PaseoAgent): BoardAgentFact["status"] | null {
  return agent.status === "closed" ? null : agent.status;
}

export async function collectBoardFacts(deps: BoardFactsDeps): Promise<BoardHostFacts> {
  const now = deps.now?.() ?? new Date();
  const collectedAt = now.toISOString();
  const paseo = deps.paseo();
  if (!paseo) throw new Error("Paseo daemon unavailable");
  const [all, maxRunning] = await Promise.all([deps.agentDirectory.live(), deps.maxRunning()]);
  const agentCounts: BoardHostFacts["agentCounts"] = { running: 0, idle: 0, initializing: 0, error: 0, permission: 0 };
  const live: { agent: PaseoAgent; status: BoardAgentFact["status"] }[] = [];
  for (const agent of all) {
    if (agent.archivedAt) continue;
    const status = liveStatus(agent);
    if (!status) continue;
    agentCounts[status]++;
    if ((agent.pendingPermissions ?? []).length) agentCounts.permission++;
    live.push({ agent, status });
  }
  const ticketAgents = live.filter(({ agent }) => agent.labels?.["linear.identifier"] && !agent.labels?.["paseo.parent-agent-id"]).slice(0, 500);
  const [inside, stewardRaw, responsibilityRaw, watchdogRaw, plansRaw, pullsRaw] = await Promise.all([
    pool(ticketAgents, TIMELINE_CONCURRENCY, ({ agent }) => readInside(paseo, agent).catch(() => null)),
    ledger(join(deps.home, "steward.json")),
    ledger(join(deps.home, "responsibility.json")),
    ledger(join(deps.home, "watchdog.json")),
    ledger(join(deps.home, "plan-pipeline.json")),
    ledger(join(deps.home, "pr-watch.json")),
  ]);
  const agents: BoardAgentFact[] = ticketAgents.map(({ agent, status }, index) => ({
    id: text(agent.id, 100),
    identifier: text(agent.labels["linear.identifier"], 50),
    title: text(agent.title, 300),
    status,
    createdAt: at(agent.createdAt) ?? collectedAt,
    updatedAt: at(agent.updatedAt) ?? collectedAt,
    permission: (agent.pendingPermissions ?? []).length > 0,
    inside: inside[index],
  }));
  const steward = stewardFacts(stewardRaw);
  const plans = planFacts(plansRaw);
  return {
    host: deps.host, collectedAt, maxRunning, agentCounts, agents,
    steward,
    ownership: ownershipFacts(responsibilityRaw),
    watchdog: watchdogFacts(watchdogRaw),
    plans: { lastArrivalAt: plans.lastArrivalAt, rows: plans.rows },
    pulls: pullFacts(pullsRaw),
    flow: flowFacts(now, plans.records, steward, pullsRaw),
  };
}