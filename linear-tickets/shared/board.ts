import { z } from "zod";
import { PipelineStage, PipelineStatus } from "./plan-pipeline";

// The factory board (/board): every ticket the plugin works on, across both hosts, as one belt per
// stage. Each host answers GET /api/board/local with its own raw facts (BoardHostFacts); the host
// that serves /api/board adds the Linear tickets and open GitHub pull requests and derives the
// view (server/board.ts deriveBoard) from all of it.

export const BOARD_STAGES = ["labelled", "planning", "you", "approved", "working", "pr", "queue", "merged"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];
export type BoardHealth = "broken" | "stale" | "you" | "slow" | "blocked" | "ok";
export const BOARD_HEALTH: readonly BoardHealth[] = ["broken", "stale", "you", "slow", "blocked", "ok"];
// What an agent spent its recent tool calls on (BoardInside.mix).
export const BoardWorkGroup = z.enum(["edit", "run", "read", "wait", "team", "linear"]);
export type BoardWorkGroup = z.infer<typeof BoardWorkGroup>;

const at = z.string().datetime();
const text = (max: number) => z.string().max(max);

// What one agent is doing, read from its public timeline tail when the facts were collected.
// `checklist`: its latest todo list (null: none in the tail); `items` are the open ones, at most 10.
// `mix`: tool calls per work group, largest first; `recent`: the last six steps, oldest first;
// `said`: the start of its last message.
export const BoardInside = z.object({
  checklist: z.object({
    done: z.number().int().min(0), total: z.number().int().min(0),
    items: z.array(z.tuple([text(300), z.enum(["in_progress", "pending"])])).max(10),
  }).nullable(),
  mix: z.array(z.tuple([BoardWorkGroup, z.number().int().min(0)])).max(6),
  recent: z.array(text(300)).max(6),
  said: text(300).nullable(),
});
export type BoardInside = z.infer<typeof BoardInside>;

// A live ticket agent (labelled linear.identifier, not a child agent, not archived or closed).
// `inside`: null when its timeline could not be read.
export const BoardAgentFact = z.object({
  id: text(100), identifier: text(50), title: text(300),
  status: z.enum(["initializing", "idle", "running", "error"]),
  createdAt: at, updatedAt: at, permission: z.boolean(),
  inside: BoardInside.nullable(),
});
export type BoardAgentFact = z.infer<typeof BoardAgentFact>;

// One ticket in the steward's file (steward.ts StewardTicket). `status`: the Linear status the
// steward last observed (responsibility.observedStage), null when unknown; `advancedAt`: its last
// verified advancement; `log`: the last ten actions.
export const BoardStewardFact = z.object({
  identifier: text(50), situation: text(60), since: at.nullable(),
  restarts: z.array(at).max(200), refusals: z.array(z.object({ at, reason: text(400) })).max(200),
  escalatedAt: at.nullable(), log: z.array(z.object({ at, action: text(300) })).max(10),
  status: text(100).nullable(), advancedAt: at.nullable(),
});
export type BoardStewardFact = z.infer<typeof BoardStewardFact>;

export const BoardWatchdogFact = z.object({
  identifier: text(50), starts: z.array(at).max(200), cycle: text(60).nullable(), exhaustedAt: at.nullable(),
});
export type BoardWatchdogFact = z.infer<typeof BoardWatchdogFact>;

// The newest plan pipeline row per ticket (plan-pipeline.json).
export const BoardPlanFact = z.object({
  identifier: text(50), stage: PipelineStage, status: PipelineStatus, since: at, lastProgressAt: at.nullable(), detail: text(1_400),
});
export type BoardPlanFact = z.infer<typeof BoardPlanFact>;

// One open pull request pr-watch follows (pr-watch.json, not merged, closed or missing).
// `failed`: names of failed checks on the head; `running`: pending checks; `drops`: merge queue
// drops so far; `drop`: the reason of an undelivered drop, else null.
export const BoardPullFact = z.object({
  url: text(300), failed: z.array(text(200)).max(100), running: z.number().int().min(0),
  drops: z.number().int().min(0), drop: text(1_400).nullable(), activeAt: at.nullable(),
});
export type BoardPullFact = z.infer<typeof BoardPullFact>;

// Arrivals at each station in the 24 hours before collectedAt, from this host's ledgers.
// planning: plan runs started (planning: records, first history entry); arrived: plans that reached
// "ready" (submit:/review: records, one per record and time); decided: submit:/review: records that
// reached completed or auto-approved, autoApproved the latter; starts: steward log "start: done" or
// "succeed: done"; openedPr: steward tickets whose situation open-pr began; enqueued: pr-watch
// actions whose enqueue step is "enqueued".
export const BoardFlowFacts = z.object({
  planning: z.number().int().min(0), arrived: z.number().int().min(0), decided: z.number().int().min(0),
  autoApproved: z.number().int().min(0), starts: z.number().int().min(0), openedPr: z.number().int().min(0),
  enqueued: z.number().int().min(0),
});
export type BoardFlowFacts = z.infer<typeof BoardFlowFacts>;

// GET /api/board/local. `host`: the short host name (os.hostname() up to the first dot, lower case).
// `agentCounts`: every live agent on the host, ticket or not. `steward` / `ownership`: null when the
// host keeps no such file (only the host that runs the steward has them).
export const BoardHostFacts = z.object({
  host: text(100), collectedAt: at, maxRunning: z.number().int().min(0).nullable(),
  agentCounts: z.object({
    running: z.number().int().min(0), idle: z.number().int().min(0), initializing: z.number().int().min(0),
    error: z.number().int().min(0), permission: z.number().int().min(0),
  }),
  agents: z.array(BoardAgentFact).max(500),
  steward: z.object({ at: at.nullable(), tickets: z.array(BoardStewardFact).max(5_000) }).nullable(),
  ownership: z.object({ at: at.nullable(), violations: z.array(z.object({ identifier: text(50), kind: text(100) })).max(2_000) }).nullable(),
  watchdog: z.array(BoardWatchdogFact).max(5_000),
  plans: z.object({ lastArrivalAt: at.nullable(), rows: z.array(BoardPlanFact).max(1_000) }),
  pulls: z.array(BoardPullFact).max(3_000),
  flow: BoardFlowFacts,
});
export type BoardHostFacts = z.infer<typeof BoardHostFacts>;

// A Linear ticket carrying the dispatch label: open, or completed in the last 24 hours.
export type BoardIssue = {
  identifier: string; title: string; url: string; status: string;
  statusType: string; // Linear state type: triage, backlog, unstarted, started, completed, canceled
  project: string | null; labels: string[];
  startedAt: string | null; completedAt: string | null; updatedAt: string;
};

// An open GitHub pull request in a repository pr-watch follows. `conflict`: GitHub reports merge
// conflicts (mergeStateStatus DIRTY); `doNotMerge`: labelled do-not-merge.
export type BoardOpenPull = {
  url: string; number: number; title: string; branch: string;
  draft: boolean; conflict: boolean; doNotMerge: boolean; updatedAt: string;
};

// `issues` / `pulls`: null when Linear / GitHub could not be read; the board then works from the
// hosts' facts alone. `unreachable`: peers whose facts are missing.
export type BoardInput = {
  now: Date;
  hosts: BoardHostFacts[];
  unreachable: string[];
  issues: BoardIssue[] | null;
  issuesAt: string | null;
  pulls: BoardOpenPull[] | null;
  pullsAt: string | null;
};

export type BoardRepair = {
  watchdog?: { used24: number; cap: number; total: number; exhaustedAt: string | null; cycle: string | null };
  steward?: { used24: number; cap: number; total: number; refusals: number; lastRefusal: string; escalatedAt: string | null };
  drops?: number;
  log?: [string, string][];
  acts24?: Record<string, number>;
};

export type BoardRowAgent = { host: string; status: BoardAgentFact["status"]; permission: boolean; quietMin: number | null; inside: BoardInside | null };
export type BoardRowPull = { num: string; url: string; running: number; conflict: boolean; dnm: boolean; draft: boolean; drops: number; failed: boolean; drop: boolean };
export type BoardReasons = { broken: string[]; stale: string[]; you: string[]; slow: string[]; blocked: string[] };
export type BoardCauseKind = "broken" | "stale" | "you" | "ci";

export type BoardRow = {
  id: string; title: string; url: string | null; project: string | null; status: string | null;
  stage: BoardStage; health: BoardHealth;
  since: string | null; // in this stage since
  last: string | null; // last sign of activity anywhere
  hosts: string[]; agents: BoardRowAgent[]; repair: BoardRepair;
  causes: [BoardCauseKind, string][]; prs: BoardRowPull[]; reasons: BoardReasons;
  ciOnly: boolean; // broken only because of red CI
  situation: string | null; // the steward's situation
  unverified: boolean; // the verdict rests on a steward pass older than 90 s
};

export type BoardFlow = { n: number; what: string; extra?: string } | null;

export type BoardHostView = {
  key: string;
  agents: BoardHostFacts["agentCounts"];
  maxRunning: number | null;
  facts: [string, string | null][]; // [what, when it was last read or written]
};

// GET /api/board.
export type BoardView = {
  now: string;
  stages: BoardStage[];
  labels: Record<BoardStage, string>;
  limits: Partial<Record<BoardStage, [number, number]>>; // orange / red hours in stage
  hosts: BoardHostView[];
  unreachable: string[];
  sources: [string, string | null][]; // Linear and GitHub: when read, null when unavailable
  rows: BoardRow[];
  flow: Record<BoardStage, BoardFlow>;
};
