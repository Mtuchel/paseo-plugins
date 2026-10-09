import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import { dispatchLabels } from "./dispatch";
import type { HandoverRecord } from "./handover";
import type { LinearService } from "./linear";
import type { NeedsYouIssues } from "./needs-you";
import type { OpenPull } from "./pr-watch";
import { RateLimitedError } from "./rate-budget";
import type { SessionLink } from "./sessions";
import type { PluginSettings, Settings, WatchdogTimings } from "./settings";
import { paseoHome } from "./ticket-mcp";

// The watchdog for silent and stuck ticket agents (README, "Silent and stuck agents"). It runs in
// the pull request watch's two-minute poll, before any other recovery, and walks each ticket's
// current root agent through bounded steps: a non-cancelling steer, a stop with a resume, a reload
// with a resume, a replacement on the recorded branch, then one mention of the owner. A closed or
// idle root gets one resume; a proven ghost goes straight to the replacement. Every step is
// claimed in watchdog.json before it is taken, so a restart never repeats one blindly.

export const WATCHDOG_CYCLES = 2;
export const WATCHDOG_WINDOW_MS = 24 * 60 * 60 * 1000;
// How long a ticket whose recovery history is unknown (adopted from the peer without it) waits.
export const WATCHDOG_QUARANTINE_MS = 24 * 60 * 60 * 1000;
// The agent label a watchdog replacement carries: `<cycle id>:succeed`, its correlation evidence.
export const WATCHDOG_LABEL = "linear-tickets.watchdog";
// A message newer than the watchdog's own last dispatch by more than this came from someone else.
const FOREIGN_MESSAGE_SLACK_MS = 60_000;
// A native record dated this far in the future is not trusted as evidence.
const FUTURE_SKEW_MS = 5 * 60_000;
const TAIL_BYTES = 1024 * 1024;
const CHILD_FILES = 16;
const MINUTE = 60_000;
// How long a quiet but excluded root is left before its exclusions are read again (README,
// "Silent and stuck agents"): the deep check reads Linear and GitHub, whose hourly budgets the
// plugin's other polls share.
const EXCLUSION_RECHECK_MS = 15 * MINUTE;
const DO_NOT_MERGE = "do-not-merge";
const NEEDS_INPUT = "needs input";
const TERMINAL = ["completed", "canceled", "duplicate"];
// Exclusions that say nothing about the ticket itself: a cycle's end waits them out instead of
// ending without the owner mention.
const UNKNOWN_VETOES = new Set([
  "the plugin is unloading", "the watchdog is turned off", "the watchdog state cannot be read",
  "the ticket's open pull requests cannot be read", "the agent is starting",
]);

export type WatchdogKind = "silent" | "idle" | "ghost";
export type WatchdogAction = "steer" | "interrupt" | "reload" | "resume" | "succeed" | "mention";
export type WatchdogEffect = Exclude<WatchdogAction, "mention">;

// The steps of each kind, in order; the last is always the owner mention.
const STEPS: Record<WatchdogKind, WatchdogAction[]> = {
  silent: ["steer", "interrupt", "reload", "succeed", "mention"],
  idle: ["resume", "mention"],
  ghost: ["succeed", "mention"],
};

export const WATCHDOG_LINES: Record<WatchdogEffect, string> = {
  steer: "Watchdog: asked the silent agent to report and continue.",
  interrupt: "Watchdog: stopped the silent turn and asked the agent to continue.",
  reload: "Watchdog: reloaded the silent agent and asked it to continue.",
  succeed: "Watchdog: started a replacement on the recorded branch.",
  resume: "Watchdog: asked the stopped agent to continue the lifecycle step it was on.",
};
const FAILED_ACTIONS: Record<WatchdogEffect, string> = {
  steer: "asking the silent agent to report and continue",
  interrupt: "stopping the silent turn",
  reload: "reloading the silent agent",
  succeed: "starting a replacement",
  resume: "asking the stopped agent to continue",
};
export const WATCHDOG_MENTION = "Automatic recovery could not restore progress on this ticket. Please take over.";

export function watchdogFailure(action: WatchdogEffect, reason: string): string {
  return `Watchdog: ${FAILED_ACTIONS[action]} failed; ${reason.replace(/[.\s]+$/, "")}.`;
}

// What the agent is told at each step. Each can arrive twice (a restart between the send and its
// receipt), so each one makes the agent look at the actual state first.
export function watchdogText(action: WatchdogEffect, minutes: number, identifier: string): string {
  const quiet = `no progress was recorded in this session for ${minutes} minutes`;
  const check = "Before anything else, run `git status` in your worktree: finish or abort an interrupted rebase, merge or cherry-pick, and check the current state of your pull requests and lifecycle step (this message can arrive twice).";
  if (action === "steer") return `Paseo watchdog: ${quiet}. Report in one line which lifecycle step of ${identifier} you are on and what you are waiting for, then continue that step. Do not start over.`;
  if (action === "interrupt") return `Paseo's watchdog stopped your turn because ${quiet}. ${check} Then continue the lifecycle step you were on.`;
  if (action === "reload") return `Paseo's watchdog reloaded you because ${quiet}. ${check} Then continue the lifecycle step you were on.`;
  if (action === "resume") return `Your ticket ${identifier} is still open and ${quiet}. ${check} Then continue the lifecycle step you were on.`;
  return `The previous agent on ${identifier} stopped making progress (${quiet}), so Paseo's watchdog retired it. ${check} Then continue the lifecycle step it was on.`;
}

// --- Durable state --------------------------------------------------------------------------------

// `claimed`: saved right before the effect; a restart that finds it cannot know whether the effect
// happened (the crash gap) and never repeats it. `done`/`failed`: the effect's outcome.
export type WatchdogClaim = { action: WatchdogEffect; marker: string; at: string; state: "claimed" | "done" | "failed"; result?: string };
export type WatchdogCycle = {
  id: string; kind: WatchdogKind; startedAt: string;
  // The root the cycle watches, its turn and native session when the cycle (or its last step) began.
  rootId: string; turnId: string | null; nativeHandle: string | null;
  // Execution progress newer than this ends the cycle.
  baseline: string;
  stage: WatchdogAction; dueAt: string;
  claim: WatchdogClaim | null;
  // The watchdog's last message or start: a turn or message after it is the expected transition.
  dispatchedAt: string | null;
  // A replacement the cycle started (or forwarded): bound by its label once it shows up.
  successor: { marker: string; at: string } | null;
  // The replacement must wait for proof the predecessor is gone, at most until then.
  retireBy?: string | null;
};
// A ticket line or the owner mention still to post; `attempted` once a send may have gone out.
export type WatchdogReport = { key: string; body: string; agentId: string | null; mention: boolean; attempted?: boolean };
export type WatchdogTicket = {
  identifier: string;
  // When each cycle started, within the rolling day; a cycle counts before its first effect.
  starts: string[];
  cycle: WatchdogCycle | null;
  // Both cycles were used up: one mention, then nothing until progress or the owner continues.
  exhausted: { at: string; mentioned: boolean } | null;
  // The last explicit owner continuation (a reply, a resume, a new thread).
  ownerAt?: string | null;
  // History unknown (taken over from a peer that sent none): no recovery until then.
  quarantineUntil?: string | null;
  // This host forwarded the ticket's work to the peer; its older roots are no longer its to recover.
  transferredAt?: string | null;
  reports?: WatchdogReport[];
};
// The owner's Stop: it belongs to the ticket and lasts until the owner continues.
export type WatchdogHold = { agentId: string | null; at: string };
export type WatchdogFile = { version: 1; tickets: Record<string, WatchdogTicket>; holds: Record<string, WatchdogHold> };

export class WatchdogStateError extends Error {}

function emptyFile(): WatchdogFile {
  return { version: 1, tickets: {}, holds: {} };
}

function parseFile(text: string): WatchdogFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new WatchdogStateError("watchdog.json is not valid JSON"); }
  const file = value as Partial<WatchdogFile> | null;
  if (!file || typeof file !== "object" || file.version !== 1 || !file.tickets || typeof file.tickets !== "object" || !file.holds || typeof file.holds !== "object") {
    throw new WatchdogStateError("watchdog.json has an unknown shape or version");
  }
  for (const [issueId, ticket] of Object.entries(file.tickets)) {
    if (!ticket || typeof ticket !== "object" || !Array.isArray(ticket.starts) || ticket.starts.some((at) => typeof at !== "string" || !Number.isFinite(Date.parse(at)))) {
      throw new WatchdogStateError(`watchdog.json has a malformed entry for ${issueId}`);
    }
  }
  return file as WatchdogFile;
}

// watchdog.json next to pr-watch.json: atomic, owner-only, every change serialized. Only a missing
// file starts empty; an unreadable or corrupt one throws, so no budget is ever reset by a bad read.
export class WatchdogStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path = join(paseoHome(), "linear-tickets", "watchdog.json")) {}

  async read(): Promise<WatchdogFile> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw new WatchdogStateError(`watchdog.json cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    return parseFile(text);
  }

  update<T>(work: (file: WatchdogFile) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const file = await this.read();
      const result = await work(file);
      await this.write(file);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(file: WatchdogFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(file), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  ticket(file: WatchdogFile, issueId: string, identifier: string): WatchdogTicket {
    file.tickets[issueId] ??= { identifier, starts: [], cycle: null, exhausted: null };
    if (identifier && identifier !== issueId) file.tickets[issueId].identifier = identifier;
    return file.tickets[issueId];
  }

  // The owner stopped the ticket's agent from Linear. Saved before the Stop goes out.
  hold(issueId: string, agentId: string | null, at = new Date().toISOString()): Promise<void> {
    return this.update((file) => { file.holds[issueId] = { agentId, at }; });
  }

  // An explicit owner continuation: the Stop no longer holds, a cycle under way and an exhausted
  // budget's suppression end (the owner took the ticket's next step in hand).
  continued(issueId: string, at = new Date().toISOString()): Promise<void> {
    return this.update((file) => {
      delete file.holds[issueId];
      const ticket = file.tickets[issueId];
      if (ticket) { ticket.ownerAt = at; ticket.cycle = null; ticket.exhausted = null; }
    });
  }

  // A ticket whose ownership moved to the peer: its local roots are no longer this host's to
  // recover. A cycle under way ends on the next poll, after its step's report was queued.
  transferred(issueId: string, identifier: string, at = new Date().toISOString()): Promise<void> {
    return this.update((file) => {
      this.ticket(file, issueId, identifier).transferredAt = at;
    });
  }

  // The recovery history the ticket's next owner continues with (see importHistory).
  async history(issueId: string, now: number): Promise<WatchdogHistory> {
    const ticket = (await this.read()).tickets[issueId];
    return historyOf(ticket, now);
  }

  // The tickets this host forwarded to the peer (with the time of the hand-over): their local
  // records are no longer this host's to recover, and a wait recorded here for one of them is the
  // peer's plugin's to end (writeback.ts, the left-behind waits).
  async handedOver(): Promise<Map<string, string>> {
    const tickets = (await this.read()).tickets;
    return new Map(Object.entries(tickets).flatMap(([issueId, ticket]) => ticket.transferredAt ? [[issueId, ticket.transferredAt] as const] : []));
  }

  // A ticket handed over from the peer: its history is taken over before anything starts here.
  adopt(issueId: string, identifier: string, value: unknown, timings: WatchdogTimings, now = Date.now()): Promise<"imported" | "quarantined"> {
    return this.update((file) => importHistory(file, issueId, identifier, value, now, timings));
  }
}

// --- Cross-host history ---------------------------------------------------------------------------

// What travels with every ticket handed to the peer (activation envelopes, ownership claims): the
// rolling day's cycle starts, an exhausted budget, and a replacement the cycle forwarded. Unknown
// versions are rejected by parseHistory, which the receiver treats as unknown history.
export type WatchdogHistory = {
  v: 1;
  starts: string[];
  exhaustedAt: string | null;
  cycle: { id: string; kind: WatchdogKind; startedAt: string; marker: string } | null;
};

export function historyOf(ticket: WatchdogTicket | undefined, now: number, marker?: string): WatchdogHistory {
  const cycle = ticket?.cycle;
  return {
    v: 1,
    starts: recentStarts(ticket?.starts ?? [], now),
    exhaustedAt: ticket?.exhausted?.at ?? null,
    cycle: cycle && marker ? { id: cycle.id, kind: cycle.kind, startedAt: cycle.startedAt, marker } : null,
  };
}

export function parseHistory(value: unknown): WatchdogHistory | null {
  if (!value || typeof value !== "object") return null;
  const history = value as Partial<WatchdogHistory>;
  if (history.v !== 1 || !Array.isArray(history.starts) || history.starts.length > 64) return null;
  if (history.starts.some((at) => typeof at !== "string" || !Number.isFinite(Date.parse(at)))) return null;
  if (history.exhaustedAt !== null && (typeof history.exhaustedAt !== "string" || !Number.isFinite(Date.parse(history.exhaustedAt)))) return null;
  const cycle = history.cycle;
  if (cycle !== null && (!cycle || typeof cycle !== "object" || typeof cycle.id !== "string" || typeof cycle.marker !== "string"
    || !["silent", "idle", "ghost"].includes(cycle.kind) || typeof cycle.startedAt !== "string" || !Number.isFinite(Date.parse(cycle.startedAt)))) return null;
  return { v: 1, starts: history.starts, exhaustedAt: history.exhaustedAt ?? null, cycle: cycle ?? null };
}

// The receiving host takes over a ticket's history: starts are merged (the stricter budget wins),
// an exhausted budget stays exhausted, and a forwarded replacement continues the same cycle once
// the successor with its label shows up. No history (an older peer, or an unknown version): the
// ticket waits WATCHDOG_QUARANTINE_MS rather than getting a fresh budget on a guess.
export function importHistory(file: WatchdogFile, issueId: string, identifier: string, value: unknown, now: number, timings: WatchdogTimings): "imported" | "quarantined" {
  file.tickets[issueId] ??= { identifier, starts: [], cycle: null, exhausted: null };
  const ticket = file.tickets[issueId];
  // The ticket comes back to this host: an earlier hand-over to the peer no longer applies.
  ticket.transferredAt = null;
  const history = parseHistory(value);
  if (!history) {
    const until = now + WATCHDOG_QUARANTINE_MS;
    if (!ticket.quarantineUntil || Date.parse(ticket.quarantineUntil) < until) ticket.quarantineUntil = new Date(until).toISOString();
    return "quarantined";
  }
  ticket.starts = recentStarts([...new Set([...ticket.starts, ...history.starts])].sort(), now);
  if (history.exhaustedAt && (!ticket.exhausted || ticket.exhausted.at < history.exhaustedAt)) ticket.exhausted = { at: history.exhaustedAt, mentioned: true };
  if (history.cycle && ticket.cycle?.id !== history.cycle.id) {
    const at = new Date(now).toISOString();
    ticket.cycle = {
      id: history.cycle.id, kind: history.cycle.kind, startedAt: history.cycle.startedAt,
      rootId: "", turnId: null, nativeHandle: null, baseline: at,
      stage: "mention", dueAt: new Date(now + timings.recoveryGraceMinutes * MINUTE).toISOString(),
      claim: null, dispatchedAt: at, successor: { marker: history.cycle.marker, at },
    };
  }
  return "imported";
}

// --- Budget and steps -----------------------------------------------------------------------------

export function recentStarts(starts: string[], now: number): string[] {
  return starts.filter((at) => now - Date.parse(at) < WATCHDOG_WINDOW_MS).slice(-64);
}

export function budgetLeft(starts: string[], now: number): number {
  return Math.max(0, WATCHDOG_CYCLES - recentStarts(starts, now).length);
}

// An action outside the kind's own sequence (the replacement an idle cycle takes when its agent
// cannot be loaded) is followed by the kind's last step, the owner mention.
export function nextStep(kind: WatchdogKind, action: WatchdogAction): WatchdogAction {
  const steps = STEPS[kind];
  const index = steps.indexOf(action);
  return steps[index < 0 ? steps.length - 1 : Math.min(steps.length - 1, index + 1)];
}

export function graceMinutes(action: WatchdogAction, timings: WatchdogTimings): number {
  return action === "steer" ? timings.steerGraceMinutes : timings.recoveryGraceMinutes;
}

// --- Activity evidence ----------------------------------------------------------------------------

// What the provider-native OMP session (the public persistence handle) shows: the newest execution
// progress on its current branch (an assistant message, a tool start or a tool result; never a user
// message, a title, a session exit or a reload's bookkeeping), the file's last change, and whether
// the root waits on a subagent (`task`) whose own transcripts then count for it.
export type Activity = { progressAt: number | null; touchedAt: number; head: string | null; awaitingChild: boolean };
export type ActivityResult = { ok: true; activity: Activity } | { ok: false; problem: string };

type Entry = { id: string | null; parentId: string | null; at: number | null; progress: boolean; task: string | null; result: string | null };

function entryOf(value: unknown): Entry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry.type === "session" || entry.type === "title") return null;
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : null;
  const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : null;
  const toolStart = entry.type === "custom" && entry.customType === "tool_execution_start";
  const role = entry.type === "message" ? message?.role : null;
  return {
    id: typeof entry.id === "string" ? entry.id : null,
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    at: Number.isFinite(at) ? at : null,
    progress: toolStart || role === "assistant" || role === "toolResult",
    task: toolStart && data?.toolName === "task" && typeof data.toolCallId === "string" ? data.toolCallId : null,
    result: role === "toolResult" && typeof message?.toolCallId === "string" ? message.toolCallId : null,
  };
}

// The last TAIL_BYTES of a session file: complete lines only (the first may be cut, the last may
// still be written). A malformed complete line or a record from the future makes it unusable.
async function tail(path: string, now: number): Promise<{ entries: Entry[]; touchedAt: number } | { problem: string }> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) return { problem: "the native session is not a file" };
    const start = Math.max(0, info.size - TAIL_BYTES);
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const first = text.indexOf("\n");
      if (first < 0) return { problem: "a native record exceeds the safe bound" };
      text = text.slice(first + 1);
    }
    const last = text.lastIndexOf("\n");
    text = last < 0 ? "" : text.slice(0, last);
    const entries: Entry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return { problem: "the native session has a malformed record" }; }
      const entry = entryOf(parsed);
      if (!entry) continue;
      if (entry.at !== null && entry.at > now + FUTURE_SKEW_MS) return { problem: "the native session has a future-dated record" };
      entries.push(entry);
    }
    return { entries, touchedAt: info.mtimeMs };
  } finally { await file.close(); }
}

// Progress counts only on the current branch: from the last record back through its parents. A
// rewound session's abandoned branch, or an old record discovered late, is no new progress (its
// time stamp is compared with the cycle's baseline, never its discovery).
function branchActivity(entries: Entry[]): { progressAt: number | null; head: string | null; openTasks: Set<string> } {
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
  const head = [...entries].reverse().find((entry) => entry.id)?.id ?? null;
  const branch: Entry[] = [];
  const seen = new Set<string>();
  for (let id = head; id && byId.has(id) && !seen.has(id); id = byId.get(id)!.parentId) {
    seen.add(id);
    branch.push(byId.get(id)!);
  }
  let progressAt: number | null = null;
  const results = new Set(branch.flatMap((entry) => entry.result ? [entry.result] : []));
  const openTasks = new Set<string>();
  for (const entry of branch) {
    if (entry.progress && entry.at !== null && (progressAt === null || entry.at > progressAt)) progressAt = entry.at;
    if (entry.task && !results.has(entry.task)) openTasks.add(entry.task);
  }
  return { progressAt, head, openTasks };
}

export async function readActivity(handle: unknown, now: number): Promise<ActivityResult> {
  if (typeof handle !== "string" || !isAbsolute(handle) || !handle.endsWith(".jsonl")) return { ok: false, problem: "the agent has no readable OMP session" };
  try {
    const read = await tail(handle, now);
    if ("problem" in read) return { ok: false, problem: read.problem };
    const { progressAt, head, openTasks } = branchActivity(read.entries);
    let latest = progressAt;
    if (openTasks.size) {
      // A root that waits on its subagents: their transcripts sit next to its session file.
      const directory = handle.slice(0, -".jsonl".length);
      // No directory yet means no subagent transcript was written; any other failure is unreadable
      // evidence (the outer catch).
      const listed = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
      const names = listed.filter((name) => name.endsWith(".jsonl"));
      const files = (await Promise.all(names.map(async (name) => ({ path: join(directory, name), mtime: (await stat(join(directory, name)).catch(() => null))?.mtimeMs ?? 0 }))))
        .sort((a, b) => b.mtime - a.mtime).slice(0, CHILD_FILES);
      for (const child of files) {
        const childRead = await tail(child.path, now);
        if ("problem" in childRead) return { ok: false, problem: `a subagent transcript: ${childRead.problem}` };
        const childProgress = branchActivity(childRead.entries).progressAt;
        if (childProgress !== null && (latest === null || childProgress > latest)) latest = childProgress;
      }
    }
    return { ok: true, activity: { progressAt: latest, touchedAt: read.touchedAt, head, awaitingChild: openTasks.size > 0 } };
  } catch (error) {
    return { ok: false, problem: `the OMP session cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
}

// --- Host-local lease (unload fencing) ------------------------------------------------------------

// One watchdog pass per host at a time, across plugin instances: a reloaded plugin's new instance
// runs in the same process while the old one may still finish an effect, so the lease lives on the
// process (and, against a second daemon on the same home, in a lease file with its pid). It is
// released only when the pass drained, or taken over once its process is proven dead.
const LEASES_KEY = Symbol.for("linear-tickets.watchdog-leases");
const leases: Map<string, string> = ((globalThis as Record<symbol, unknown>)[LEASES_KEY] ??= new Map<string, string>()) as Map<string, string>;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// The process-local reservation is taken before the first await, so two instances of this process
// never both pass; the lease file is created exclusively (`wx`), and a file left by a dead process
// (or an unreadable one older than a minute) is removed and the creation retried once. The file is
// read back afterwards: a second daemon that replaced it in between keeps it, this pass yields.
export async function takeLease(path: string, instance: string): Promise<boolean> {
  if (leases.has(path)) return false;
  leases.set(path, instance);
  const file = `${path}.lease`;
  const body = JSON.stringify({ pid: process.pid, instance });
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(file, body, { mode: 0o600, flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) return releaseReservation(path, instance);
      }
      if (!await staleLease(file)) return releaseReservation(path, instance);
      await rm(file, { force: true });
    }
    const written = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown; instance?: unknown };
    if (written.pid !== process.pid || written.instance !== instance) return releaseReservation(path, instance);
    return true;
  } catch {
    return releaseReservation(path, instance);
  }
}

// A lease file whose holder is gone: its process is dead, or (in this process) no instance holds
// the reservation any more. Unreadable content counts only once it is a minute old (a holder may be
// writing it right now).
export async function staleLease(file: string): Promise<boolean> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  try {
    const held = JSON.parse(text) as { pid?: unknown };
    if (typeof held.pid === "number") return held.pid === process.pid || !processAlive(held.pid);
  } catch { /* judged by age below */ }
  const changed = await stat(file).then((info) => info.mtimeMs, () => null);
  return changed !== null && Date.now() - changed > MINUTE;
}

function releaseReservation(path: string, instance: string): false {
  if (leases.get(path) === instance) leases.delete(path);
  return false;
}

export async function releaseLease(path: string, instance: string): Promise<void> {
  if (leases.get(path) !== instance) return;
  await rm(`${path}.lease`, { force: true }).catch(() => {});
  leases.delete(path);
}

// --- The watchdog ---------------------------------------------------------------------------------

export type WatchedAgent = Pick<PaseoAgent, "id" | "provider" | "cwd" | "status" | "createdAt" | "updatedAt" | "lastUserMessageAt" | "pendingPermissions" | "labels" | "persistence" | "title">
  & Partial<Pick<PaseoAgent, "activeTurn" | "archivedAt" | "lastError" | "runtimeInfo">>;
// One ticket's unarchived root agents (no subagents) and which of them are proven ghosts.
export type TicketRoots = { issueId: string; identifier: string; roots: WatchedAgent[]; ghosts: Set<string> };

// What SessionRouter.watchdogAct came to. `done`: the effect went out. `skipped`: nothing was sent
// (`end`: the cycle no longer applies; else try again on the next poll). `failed`: the effect was
// claimed and attempted but did not succeed (`retry`: the same step may run again, e.g. while the
// predecessor's absence is not proven yet).
export type WatchdogOutcome =
  | { kind: "done"; successor?: { id: string; title: string | null; cwd: string } | null; peer?: string; note?: string }
  | { kind: "skipped"; reason: string; end: boolean; dispatched?: boolean }
  | { kind: "failed"; reason: string; retry?: boolean; unloadable?: boolean };

export type WatchdogRequest = {
  issueId: string; identifier: string; rootId: string; action: WatchdogEffect;
  text: string; marker: string; turnId: string | null;
  // Re-checked inside the ticket's turn and start gate, right before the first effect (`deep`) and
  // after every later await: a reason means the cycle no longer applies.
  check: (agent: WatchedAgent | null, deep: boolean) => Promise<string | null>;
  // False once the plugin instance unloads: no further effect.
  alive: () => boolean;
  // Saves the claim right before the first effect.
  claim: () => Promise<void>;
  history?: WatchdogHistory;
};

export type WatchdogSessions = {
  watchdogRoots(): Promise<Map<string, TicketRoots>>;
  watchdogAct(request: WatchdogRequest): Promise<WatchdogOutcome>;
  watchdogThread(issueId: string): Promise<SessionLink | null>;
  sessionFor(agentId: string): Promise<SessionLink | null>;
  say(sessionId: string, type: "thought" | "response" | "error", body: string): Promise<void>;
};

// The ticket facts one poll reads at most once: the open pull requests that name it (null: they
// could not be read, which defers every step).
export type WatchdogPoll = {
  records: HandoverRecord[];
  pulls: (ticket: { issueId: string; identifier: string; worktree: string | null; link: string | null }) => Promise<OpenPull[] | null>;
  // Agents the rest of the poll must not message: the roots of tickets in a cycle.
  reserved: Set<string>;
};

export type WatchdogDeps = {
  store: WatchdogStore;
  sessions: WatchdogSessions;
  linear: Pick<LinearService, "issueWatchState" | "comment" | "hasComment" | "viewerId" | "userUrl">;
  settings: Pick<Settings, "read">;
  handover: { all(): Promise<HandoverRecord[]> };
  needsYou?: Pick<NeedsYouIssues, "all">;
  // The owner's open manual tasks (manual-tasks.ts keeps one per task until it is done).
  manualTasks?: { tasks(): Promise<{ parentId: string; identifier: string }[]> };
  activity?: (handle: unknown, now: number) => Promise<ActivityResult>;
  now?: () => number;
};

const ms = (at: string | null | undefined): number | null => {
  const value = at ? Date.parse(at) : NaN;
  return Number.isFinite(value) ? value : null;
};
const iso = (at: number) => new Date(at).toISOString();
const short = (id: string) => id.slice(0, 8);

export class Watchdog {
  private revoked = false;
  private readonly instance = randomUUID();
  private readonly logged = new Map<string, string>();
  // A quiet root that an exclusion keeps out (a Done ticket, an owner wait, an open pull request)
  // is judged again after EXCLUSION_RECHECK_MS, not every poll: each judgement reads Linear and
  // GitHub. Keyed by ticket, root and kind, so a new root or a new kind of silence is judged at once.
  private readonly excludedUntil = new Map<string, number>();

  constructor(private readonly deps: WatchdogDeps) {}

  // Unload: no effect starts after this; a pass in flight drains, then releases the lease.
  stop(): void {
    this.revoked = true;
  }

  private alive = (): boolean => !this.revoked;

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // A condition logged once until it changes, so a two-minute poll does not flood the log.
  private once(key: string, message: string): void {
    if (this.logged.get(key) === message) return;
    this.logged.set(key, message);
    console.log(`[linear-tickets] ${message}`);
  }

  async pass(poll: WatchdogPoll): Promise<void> {
    if (this.revoked) return;
    const settings = await this.deps.settings.read();
    if (!settings.writeback.watchdog) return;
    const path = this.deps.store.path;
    if (!await takeLease(path, this.instance)) {
      this.once("lease", "watchdog: another plugin instance's pass is still draining; this one waits for the next poll");
      return;
    }
    this.logged.delete("lease");
    try {
      let file: WatchdogFile;
      try { file = await this.deps.store.read(); } catch (error) {
        this.once("state", `watchdog: ${error instanceof Error ? error.message : error}; no recovery runs until it is readable`);
        return;
      }
      this.logged.delete("state");
      const roots = await this.deps.sessions.watchdogRoots();
      for (const [issueId, ticket] of Object.entries(file.tickets)) {
        if (!ticket.cycle) continue;
        // A ticket in a cycle belongs to the watchdog this poll: its root, its recorded agent and
        // every other root of it are reserved.
        if (ticket.cycle.rootId) poll.reserved.add(ticket.cycle.rootId);
        for (const record of poll.records) if (record.issueId === issueId) poll.reserved.add(record.agentId);
        for (const agent of roots.get(issueId)?.roots ?? []) poll.reserved.add(agent.id);
      }
      const issues = [...new Set([...Object.keys(file.tickets), ...roots.keys()])];
      for (const issueId of issues) {
        if (!this.alive()) return;
        try {
          await this.ticket(issueId, roots.get(issueId) ?? null, poll, settings);
        } catch (error) {
          if (error instanceof RateLimitedError) throw error;
          const label = roots.get(issueId)?.identifier ?? file.tickets[issueId]?.identifier ?? issueId;
          console.error(`[linear-tickets] ${label}: watchdog: ${error instanceof Error ? error.message : error}`);
        }
      }
    } finally {
      await releaseLease(path, this.instance);
    }
  }

  private async ticket(issueId: string, found: TicketRoots | null, poll: WatchdogPoll, settings: PluginSettings): Promise<void> {
    const now = this.clock();
    let entry = (await this.deps.store.read()).tickets[issueId];
    if (entry?.reports?.length) {
      await this.flushReports(issueId);
      entry = (await this.deps.store.read()).tickets[issueId];
    }
    const identifier = found?.identifier ?? entry?.identifier ?? issueId;
    const label = `${identifier}: watchdog`;
    const record = poll.records.find((item) => item.issueId === issueId) ?? null;
    const owner = this.authoritative(found, record, entry?.cycle ?? null);
    if (owner && "ambiguous" in owner) { this.once(`owner:${issueId}`, `${label}: ${owner.ambiguous}; nothing is done`); return; }
    const root = owner?.root ?? null;
    if (entry?.transferredAt) {
      const transferred = ms(entry.transferredAt)!;
      if (!root || (ms(root.createdAt) ?? 0) <= transferred) { if (entry.cycle) await this.endCycle(issueId, `${label}: the ticket went to the peer host; this host stops recovering it`); return; }
      // A local root after the hand-over: the peer's cycles are unknown here.
      await this.deps.store.update((file) => {
        const ticket = this.deps.store.ticket(file, issueId, identifier);
        ticket.transferredAt = null;
        ticket.quarantineUntil = iso(now + WATCHDOG_QUARANTINE_MS);
      });
      console.log(`[linear-tickets] ${label}: the ticket came back from the peer host with unknown recovery history; no recovery for 24 hours`);
      return;
    }
    if (entry?.quarantineUntil && now < ms(entry.quarantineUntil)!) {
      this.once(`quarantine:${issueId}`, `${label}: recovery history unknown; no recovery until ${entry.quarantineUntil}`);
      return;
    }
    if (entry?.cycle) {
      await this.continueCycle(issueId, identifier, entry, entry.cycle, root, found, poll, settings);
      return;
    }
    if (!root) return;
    await this.maybeStart(issueId, identifier, entry ?? null, root, found!, record, poll, settings);
  }

  // The ticket's current root: the handover record's agent while it is an unarchived root, else
  // the only one; two live roots are no single owner, and nothing is done for them. A cycle that
  // waits for its forwarded or started replacement binds it by its label.
  private authoritative(found: TicketRoots | null, record: HandoverRecord | null, cycle: WatchdogCycle | null): { root: WatchedAgent } | { ambiguous: string } | null {
    const roots = found?.roots ?? [];
    if (!roots.length) return null;
    const marked = cycle?.successor ? roots.find((agent) => agent.labels?.[WATCHDOG_LABEL] === cycle.successor!.marker) : undefined;
    if (marked) return { root: marked };
    const live = roots.filter((agent) => ["initializing", "idle", "running"].includes(agent.status) && !found!.ghosts.has(agent.id));
    if (live.length > 1) return { ambiguous: `${live.length} live root agents (${live.map((agent) => short(agent.id)).join(", ")})` };
    if (live.length === 1) return { root: live[0] };
    const recorded = record ? roots.find((agent) => agent.id === record.agentId) : undefined;
    if (recorded) return { root: recorded };
    return { root: [...roots].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] };
  }

  private async evidence(agent: WatchedAgent, now: number): Promise<ActivityResult> {
    if (agent.provider !== "omp") return { ok: false, problem: `${agent.provider} agents have no trusted execution history` };
    return (this.deps.activity ?? readActivity)(agent.persistence?.nativeHandle, now);
  }

  // Everything that keeps the watchdog's hands off a ticket. `deep` also reads Linear, the
  // owner's waits and the open pull requests; the cheap part runs after every await of an effect.
  private async exclusion(issueId: string, identifier: string, agent: WatchedAgent | null, deep: boolean, poll: WatchdogPoll, kind: WatchdogKind | null, settings?: PluginSettings): Promise<string | null> {
    if (!this.alive()) return "the plugin is unloading";
    const current = settings ?? await this.deps.settings.read();
    if (!current.writeback.watchdog) return "the watchdog is turned off";
    let file: WatchdogFile;
    try { file = await this.deps.store.read(); } catch { return "the watchdog state cannot be read"; }
    if (file.holds[issueId]) return "the owner stopped the agent";
    if (agent) {
      if (agent.labels?.["paseo.parent-agent-id"]) return "the agent is a subagent";
      if (agent.archivedAt) return "the agent is archived";
      if (agent.status === "initializing") return "the agent is starting";
      if (agent.pendingPermissions?.length) return "the agent waits for the owner's answer or approval";
      const link = await this.deps.sessions.sessionFor(agent.id);
      if (link?.review) return "the agent's plan is under review";
    }
    const thread = await this.deps.sessions.watchdogThread(issueId);
    if (thread?.review) return "a plan review is open";
    if (thread?.queued) return "the ticket's thread is queued";
    if (thread?.remote) return "the ticket's thread is with the peer host";
    if (thread?.group) return "the ticket hands out sub-issues";
    if (thread?.offer && ["split", "later", "parked"].includes(thread.offer)) return `the ticket's plan is ${thread.offer === "later" ? "approved for later" : thread.offer}`;
    if (!deep) return null;
    const state = await this.deps.linear.issueWatchState(issueId);
    if (TERMINAL.includes(state.statusType.trim().toLowerCase())) return `${identifier} is ${state.status}`;
    if (state.status.trim().toLowerCase() === NEEDS_INPUT) return `${identifier} waits for the owner in ${state.status}`;
    const labels = dispatchLabels(current.dispatch.label);
    const names = state.labels.map((item) => item.name.toLowerCase());
    if (names.includes(DO_NOT_MERGE)) return `${identifier} carries ${DO_NOT_MERGE}`;
    if (names.includes(labels.needsYou.toLowerCase())) return `${identifier} waits for the owner (${labels.needsYou})`;
    if (names.includes(labels.hold.toLowerCase())) return `${identifier} is on hold (${labels.hold})`;
    const record = (await this.deps.handover.all()).find((item) => item.issueId === issueId) ?? null;
    if (record?.waiting) return "the agent waits for the owner";
    if ((await this.deps.needsYou?.all())?.some((entry) => entry.parentId === issueId)) return "a Needs you sub-issue waits for the owner";
    // A stopped agent whose ticket waits for the owner's manual step has nothing to continue.
    const manual = kind === "idle" ? (await this.deps.manualTasks?.tasks())?.find((task) => task.parentId === issueId) : undefined;
    if (manual) return `the manual task ${manual.identifier} waits for the owner`;
    const pulls = await poll.pulls({ issueId, identifier, worktree: record?.worktreePath ?? agent?.cwd ?? null, link: record?.links["Pull request"] ?? null });
    if (!pulls) return "the ticket's open pull requests cannot be read";
    if (pulls.some((pull) => pull.labels.map((name) => name.toLowerCase()).includes(DO_NOT_MERGE))) return `an open pull request of ${identifier} carries ${DO_NOT_MERGE}`;
    if (kind === "idle" && pulls.length) return `${identifier} has an open pull request`;
    return null;
  }

  // Silent since: the newest execution progress, the turn's start, the session file's last change
  // and the last message to the agent, whichever is latest (a recent message or file change only
  // postpones the first step; it never ends a cycle).
  private silentSince(agent: WatchedAgent, activity: Activity): number {
    return Math.max(activity.progressAt ?? 0, ms(agent.activeTurn?.startedAt) ?? 0, activity.touchedAt, ms(agent.lastUserMessageAt) ?? 0);
  }

  private async maybeStart(issueId: string, identifier: string, entry: WatchdogTicket | null, root: WatchedAgent, found: TicketRoots, record: HandoverRecord | null, poll: WatchdogPoll, settings: PluginSettings): Promise<void> {
    const now = this.clock();
    const label = `${identifier}: watchdog`;
    const timings = settings.watchdog;
    if (root.labels?.["paseo.parent-agent-id"] || root.archivedAt || root.status === "initializing" || root.status === "error") return;
    const ghost = found.ghosts.has(root.id);
    const activity = await this.evidence(root, now);
    if (!activity.ok) {
      if (root.status === "running" || ghost || root.status === "idle" || root.status === "closed") this.once(`evidence:${issueId}`, `${label}: ${activity.problem}; ${short(root.id)} is not judged`);
      return;
    }
    this.logged.delete(`evidence:${issueId}`);
    // Progress after an exhausted budget, or the owner continuing, lifts its suppression.
    if (entry?.exhausted) {
      const lifted = (activity.activity.progressAt ?? 0) > ms(entry.exhausted.at)! || (ms(entry.ownerAt) ?? 0) > ms(entry.exhausted.at)!;
      if (!lifted) return;
      await this.deps.store.update((file) => { this.deps.store.ticket(file, issueId, identifier).exhausted = null; });
    }
    let kind: WatchdogKind | null = null;
    const since = this.silentSince(root, activity.activity);
    if (ghost) kind = "ghost";
    else if (root.status === "running" && now - since >= timings.silentMinutes * MINUTE) kind = "silent";
    else if ((root.status === "idle" || root.status === "closed") && now - since >= timings.idleMinutes * MINUTE) kind = "idle";
    if (!kind) return;
    const excludedKey = `${issueId}:${root.id}:${kind}`;
    if ((this.excludedUntil.get(excludedKey) ?? 0) > now) return;
    const reason = await this.exclusion(issueId, identifier, root, true, poll, kind, settings);
    if (reason) {
      this.excludedUntil.set(excludedKey, now + EXCLUSION_RECHECK_MS);
      this.once(`excluded:${issueId}`, `${label}: ${short(root.id)} is ${kind === "silent" ? "silent" : kind === "ghost" ? "a ghost" : `${root.status} and quiet`}, but ${reason}`);
      return;
    }
    this.excludedUntil.delete(excludedKey);
    this.logged.delete(`excluded:${issueId}`);
    const starts = entry?.starts ?? [];
    if (!budgetLeft(starts, now)) {
      await this.exhaust(issueId, identifier, root.id, `both recovery cycles of the last 24 hours are used up`);
      return;
    }
    const first = STEPS[kind][0];
    const cycle: WatchdogCycle = {
      id: randomUUID(), kind, startedAt: iso(now),
      rootId: root.id, turnId: root.activeTurn?.turnId ?? null, nativeHandle: typeof root.persistence?.nativeHandle === "string" ? root.persistence.nativeHandle : null,
      baseline: iso(Math.max(activity.activity.progressAt ?? 0, ms(root.activeTurn?.startedAt) ?? 0)),
      stage: first, dueAt: iso(now), claim: null, dispatchedAt: null, successor: null,
    };
    // The cycle counts before its first effect: a restart right after this keeps the budget used.
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issueId, identifier);
      ticket.starts = [...recentStarts(ticket.starts, now), cycle.startedAt];
      ticket.cycle = cycle;
    });
    poll.reserved.add(root.id);
    console.log(`[linear-tickets] ${label}: ${short(root.id)} ${kind === "silent" ? `has been silent for ${Math.round((now - since) / MINUTE)} minutes in its turn` : kind === "ghost" ? "is a ghost (no process works for it)" : `has been ${root.status} for ${Math.round((now - since) / MINUTE)} minutes with the ticket open`}; recovery cycle ${short(cycle.id)} starts (${STEPS[kind].join(" → ")})`);
    await this.act(issueId, identifier, cycle, root, record, poll, settings);
  }

  private async continueCycle(issueId: string, identifier: string, entry: WatchdogTicket, cycle: WatchdogCycle, root: WatchedAgent | null, found: TicketRoots | null, poll: WatchdogPoll, settings: PluginSettings): Promise<void> {
    const now = this.clock();
    const label = `${identifier}: watchdog`;
    const record = poll.records.find((item) => item.issueId === issueId) ?? null;
    if (cycle.rootId) poll.reserved.add(cycle.rootId);
    // An explicit owner continuation or Stop ends the cycle.
    if ((ms(entry.ownerAt) ?? 0) > ms(cycle.startedAt)!) return this.endCycle(issueId, `${label}: the owner took over; cycle ${short(cycle.id)} ends`);
    if ((await this.deps.store.read()).holds[issueId]) return this.endCycle(issueId, `${label}: the owner stopped the agent; cycle ${short(cycle.id)} ends`);
    // A claim whose outcome was never recorded: the crash gap. Never repeated blindly.
    if (cycle.claim?.state === "claimed") {
      await this.reconcileGap(issueId, identifier, cycle, root);
      return;
    }
    // A replacement the cycle started or forwarded: bound by its label, or escalated after the window.
    if (cycle.successor && root?.labels?.[WATCHDOG_LABEL] === cycle.successor.marker && cycle.rootId !== root.id) {
      cycle = await this.patchCycle(issueId, identifier, { rootId: root.id, turnId: root.activeTurn?.turnId ?? null, nativeHandle: typeof root.persistence?.nativeHandle === "string" ? root.persistence.nativeHandle : null, baseline: cycle.successor.at });
      console.log(`[linear-tickets] ${label}: replacement ${short(root.id)} continues cycle ${short(cycle.id)}`);
    }
    if (!root || (cycle.rootId && root.id !== cycle.rootId)) {
      if (cycle.successor && !cycle.rootId && now < ms(cycle.dueAt)!) return;
      if (cycle.stage === "succeed" || cycle.stage === "mention") {
        // The retired root is gone on purpose; the replacement (if any) is awaited until the window ends.
        if (now >= ms(cycle.dueAt)! && cycle.stage === "mention") await this.act(issueId, identifier, cycle, root, record, poll, settings);
        else if (cycle.stage === "succeed") await this.act(issueId, identifier, cycle, root, record, poll, settings);
        return;
      }
      return this.endCycle(issueId, `${label}: another agent (${root ? short(root.id) : "none"}) now owns the ticket; cycle ${short(cycle.id)} ends without further steps`);
    }
    const activity = await this.evidence(root, now);
    if (!activity.ok) { this.once(`evidence:${issueId}`, `${label}: ${activity.problem}; cycle ${short(cycle.id)} waits`); return; }
    this.logged.delete(`evidence:${issueId}`);
    if ((activity.activity.progressAt ?? 0) > ms(cycle.baseline)!) {
      await this.endCycle(issueId, `${label}: ${short(root.id)} made progress again; cycle ${short(cycle.id)} ends`, true);
      return;
    }
    // A turn, session or message the watchdog did not cause: someone else is handling the agent.
    const turn = root.activeTurn?.turnId ?? null;
    const dispatched = ms(cycle.dispatchedAt);
    const handle = typeof root.persistence?.nativeHandle === "string" ? root.persistence.nativeHandle : null;
    const expected = dispatched !== null && cycle.claim?.action !== "steer";
    if (turn !== cycle.turnId || handle !== cycle.nativeHandle) {
      const startedAfter = (ms(root.activeTurn?.startedAt) ?? now) >= (dispatched ?? Infinity) - FOREIGN_MESSAGE_SLACK_MS;
      if (expected && (turn === null || startedAfter)) cycle = await this.patchCycle(issueId, identifier, { turnId: turn, nativeHandle: handle });
      else if (turn === null && cycle.turnId !== null && cycle.kind === "silent") return this.endCycle(issueId, `${label}: the silent turn of ${short(root.id)} ended without new progress; cycle ${short(cycle.id)} ends`);
      else return this.endCycle(issueId, `${label}: ${short(root.id)} has a new turn or session the watchdog did not start; cycle ${short(cycle.id)} ends`);
    }
    const lastMessage = ms(root.lastUserMessageAt);
    if (lastMessage !== null && lastMessage > Math.max(dispatched ?? 0, ms(cycle.startedAt)!) + FOREIGN_MESSAGE_SLACK_MS) {
      return this.endCycle(issueId, `${label}: someone else messaged ${short(root.id)}; cycle ${short(cycle.id)} ends`);
    }
    if (now < ms(cycle.dueAt)!) return;
    await this.act(issueId, identifier, cycle, root, record, poll, settings);
  }

  // The claim was saved, its outcome was not (a restart, a failed save): whether the effect went
  // out is unknown. A replacement that shows up with the cycle's label is adopted; anything else
  // moves on as if the step had been taken at its claim time, so the next step (never this one
  // again) follows after its window, and an unproven replacement ends with the owner mention.
  private async reconcileGap(issueId: string, identifier: string, cycle: WatchdogCycle, root: WatchedAgent | null): Promise<void> {
    const claim = cycle.claim!;
    const label = `${identifier}: watchdog`;
    const at = ms(claim.at)!;
    const settings = await this.deps.settings.read();
    const window = graceMinutes(claim.action, settings.watchdog) * MINUTE;
    if (claim.action === "succeed") {
      const adopted = root?.labels?.[WATCHDOG_LABEL] === claim.marker ? root : null;
      await this.patchCycle(issueId, identifier, {
        claim: { ...claim, state: adopted ? "done" : "failed", result: adopted ? `replacement ${short(adopted.id)} found after a restart` : "outcome unknown after a restart" },
        stage: "mention", dueAt: iso(at + window), dispatchedAt: claim.at, successor: { marker: claim.marker, at: claim.at },
        ...(adopted ? { rootId: adopted.id, turnId: adopted.activeTurn?.turnId ?? null, nativeHandle: typeof adopted.persistence?.nativeHandle === "string" ? adopted.persistence.nativeHandle : null, baseline: claim.at } : {}),
      });
      console.error(`[linear-tickets] ${label}: the replacement claimed at ${claim.at} ${adopted ? `is ${short(adopted.id)}` : "may or may not have started"}; it is not started again`);
      return;
    }
    await this.patchCycle(issueId, identifier, {
      claim: { ...claim, state: "failed", result: "outcome unknown after a restart" },
      stage: nextStep(cycle.kind, claim.action), dueAt: iso(at + window), dispatchedAt: claim.at,
      turnId: root?.activeTurn?.turnId ?? cycle.turnId, nativeHandle: typeof root?.persistence?.nativeHandle === "string" ? root.persistence.nativeHandle : cycle.nativeHandle,
    });
    console.error(`[linear-tickets] ${label}: the ${claim.action} claimed at ${claim.at} may or may not have gone out; it is not repeated, the next step follows after its window`);
  }

  private async patchCycle(issueId: string, identifier: string, patch: Partial<WatchdogCycle>): Promise<WatchdogCycle> {
    return this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issueId, identifier);
      if (!ticket.cycle) throw new WatchdogStateError("the cycle ended meanwhile");
      ticket.cycle = { ...ticket.cycle, ...patch };
      return ticket.cycle;
    });
  }

  private async endCycle(issueId: string, message: string, progressed = false): Promise<void> {
    await this.deps.store.update((file) => {
      const ticket = file.tickets[issueId];
      if (!ticket) return;
      ticket.cycle = null;
      if (progressed) ticket.exhausted = null;
    });
    console.log(`[linear-tickets] ${message}`);
  }

  // One step of the cycle: re-checked and claimed inside the ticket's turn, taken, recorded, and
  // reported on the ticket.
  private async act(issueId: string, identifier: string, cycle: WatchdogCycle, root: WatchedAgent | null, record: HandoverRecord | null, poll: WatchdogPoll, settings: PluginSettings): Promise<void> {
    const label = `${identifier}: watchdog`;
    const now = this.clock();
    // The final mention and a replacement past its retirement deadline answer to the same
    // exclusions as an effect: a ticket that meanwhile waits for the owner, closed or got vetoed
    // ends its cycle without a mention; one whose state cannot be read waits.
    if (cycle.stage === "mention" || (cycle.stage === "succeed" && cycle.retireBy && now >= ms(cycle.retireBy)!)) {
      let veto: string | null;
      try { veto = await this.exclusion(issueId, identifier, root, true, poll, cycle.kind, settings); } catch (error) {
        this.once(`wait:${issueId}`, `${label}: the end of cycle ${short(cycle.id)} waits: ${error instanceof Error ? error.message : error}`);
        return;
      }
      if (veto && UNKNOWN_VETOES.has(veto)) { this.once(`wait:${issueId}`, `${label}: the end of cycle ${short(cycle.id)} waits: ${veto}`); return; }
      if (veto) return this.endCycle(issueId, `${label}: ${veto}; cycle ${short(cycle.id)} ends without mentioning the owner`);
    }
    if (cycle.stage === "mention") {
      await this.exhaust(issueId, identifier, root?.id ?? cycle.rootId, `cycle ${short(cycle.id)} did not restore progress`);
      return;
    }
    const action = cycle.stage as WatchdogEffect;
    if (action === "succeed") {
      if (!settings.writeback.watchdog) return;
      cycle = cycle.retireBy ? cycle : await this.patchCycle(issueId, identifier, { retireBy: iso(now + settings.watchdog.recoveryGraceMinutes * MINUTE) });
      if (now >= ms(cycle.retireBy)!) {
        await this.exhaust(issueId, identifier, cycle.rootId, `the silent agent ${short(cycle.rootId)} could not be proven gone within ${settings.watchdog.recoveryGraceMinutes} minutes, so no replacement was started`);
        return;
      }
    }
    const marker = `${cycle.id}:${action}`;
    const minutes = Math.max(1, Math.round((now - ms(cycle.baseline)!) / MINUTE));
    const history = action === "succeed" ? historyOf((await this.deps.store.read()).tickets[issueId], now, marker) : undefined;
    const outcome = await this.deps.sessions.watchdogAct({
      issueId, identifier, rootId: root?.id ?? cycle.rootId, action, text: watchdogText(action, minutes, identifier), marker, turnId: cycle.turnId,
      check: (agent, deep) => this.exclusion(issueId, identifier, agent, deep, poll, cycle.kind),
      alive: this.alive,
      claim: async () => {
        await this.patchCycle(issueId, identifier, { claim: { action, marker, at: iso(this.clock()), state: "claimed" } });
      },
      ...(history ? { history } : {}),
    });
    const at = this.clock();
    const grace = graceMinutes(action, settings.watchdog) * MINUTE;
    if (outcome.kind === "skipped") {
      if (outcome.end) await this.endCycle(issueId, `${label}: ${outcome.reason}; cycle ${short(cycle.id)} ends${outcome.dispatched ? " (the turn was already stopped)" : ""}`);
      else this.once(`wait:${issueId}`, `${label}: the ${action} of cycle ${short(cycle.id)} waits: ${outcome.reason}`);
      return;
    }
    this.logged.delete(`wait:${issueId}`);
    const agentId = outcome.kind === "done" && outcome.successor ? outcome.successor.id : root?.id ?? cycle.rootId;
    if (outcome.kind === "failed") {
      const unloadable = action === "resume" && outcome.unloadable;
      await this.deps.store.update((file) => {
        const ticket = this.deps.store.ticket(file, issueId, identifier);
        if (!ticket.cycle) return;
        ticket.cycle.claim = { action, marker, at: ticket.cycle.claim?.at ?? iso(at), state: "failed", result: outcome.reason };
        // A failed step moves on to the next one now; a replacement still waiting for the
        // predecessor's absence is retried until its deadline; a resume the agent could not take
        // becomes a replacement.
        if (outcome.retry) ticket.cycle.claim = null;
        else { ticket.cycle.stage = unloadable ? "succeed" : nextStep(ticket.cycle.kind, action); ticket.cycle.dueAt = iso(at); }
        if (!outcome.retry) this.queueReport(ticket, `${ticket.cycle.id}:${action}:failed`, watchdogFailure(action, outcome.reason), agentId, false);
      });
      console.error(`[linear-tickets] ${label}: the ${action} of ${short(cycle.rootId)} failed: ${outcome.reason}${outcome.retry ? " (tried again next poll)" : ""}`);
      await this.flushReports(issueId);
      return;
    }
    await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issueId, identifier);
      if (!ticket.cycle) return;
      // Progress counts from the claim, the last moment before the effect, never from after the
      // effect's own bookkeeping (a replacement may work while its thread is opened).
      const claimedAt = ticket.cycle.claim?.at ?? iso(at);
      ticket.cycle.claim = { action, marker, at: claimedAt, state: "done", ...(outcome.note ? { result: outcome.note } : {}) };
      ticket.cycle.stage = nextStep(ticket.cycle.kind, action);
      ticket.cycle.dueAt = iso(at + grace);
      ticket.cycle.dispatchedAt = claimedAt;
      if (action !== "steer") ticket.cycle.baseline = claimedAt;
      if (action === "succeed") {
        ticket.cycle.successor = { marker, at: claimedAt };
        if (outcome.successor) {
          ticket.cycle.rootId = outcome.successor.id;
          ticket.cycle.turnId = null;
          ticket.cycle.nativeHandle = null;
        } else ticket.cycle.rootId = "";
      }
      this.queueReport(ticket, `${ticket.cycle.id}:${action}`, WATCHDOG_LINES[action], agentId, false);
    });
    console.log(`[linear-tickets] ${label}: ${WATCHDOG_LINES[action].replace(/^Watchdog: /, "")} (${short(cycle.rootId || agentId)}${outcome.successor ? ` → ${short(outcome.successor.id)}` : ""}${outcome.peer ? ` → ${outcome.peer}` : ""}, cycle ${short(cycle.id)})`);
    if (outcome.peer) await this.deps.store.transferred(issueId, identifier, iso(at));
    if (outcome.successor) poll.reserved.add(outcome.successor.id);
    await this.flushReports(issueId);
  }

  // Both cycles used up, or the last step of a cycle passed without progress: one owner mention,
  // then nothing until progress or the owner continues.
  private async exhaust(issueId: string, identifier: string, agentId: string | null, why: string): Promise<void> {
    const now = this.clock();
    const queued = await this.deps.store.update((file) => {
      const ticket = this.deps.store.ticket(file, issueId, identifier);
      const cycleId = ticket.cycle?.id ?? `budget:${iso(now)}`;
      ticket.cycle = null;
      if (ticket.exhausted) return false;
      ticket.exhausted = { at: iso(now), mentioned: true };
      this.queueReport(ticket, `${cycleId}:mention`, WATCHDOG_MENTION, agentId, true);
      return true;
    });
    if (queued) console.log(`[linear-tickets] ${identifier}: watchdog: ${why}; the owner is asked to take over`);
    await this.flushReports(issueId);
  }

  private queueReport(ticket: WatchdogTicket, key: string, body: string, agentId: string | null, mention: boolean): void {
    ticket.reports = [...(ticket.reports ?? []).filter((report) => report.key !== key), { key, body, agentId, mention }];
  }

  // Ticket lines and the owner mention, each posted once: the panel of the agent's session when it
  // has one, else a comment on the ticket marked with its key, which a retry looks for before
  // posting again. A failed post is retried on the next poll; the recovery step is never repeated.
  private async flushReports(issueId: string): Promise<void> {
    const ticket = (await this.deps.store.read()).tickets[issueId];
    for (const report of ticket?.reports ?? []) {
      const mark = `\`watchdog:${report.key}\``;
      try {
        const link = !report.mention && report.agentId ? await this.deps.sessions.sessionFor(report.agentId) : null;
        if (link) {
          await this.deps.sessions.say(link.sessionId, "thought", report.body);
        } else {
          if (report.attempted && await this.deps.linear.hasComment(issueId, mark)) { await this.dropReport(issueId, report.key); continue; }
          await this.deps.store.update((file) => {
            const entry = file.tickets[issueId]?.reports?.find((item) => item.key === report.key);
            if (entry) entry.attempted = true;
          });
          const mention = report.mention ? `${await this.deps.linear.userUrl(await this.deps.linear.viewerId())} ` : "";
          await this.deps.linear.comment(issueId, `${mention}${report.body}\n\n${mark}`);
        }
        await this.dropReport(issueId, report.key);
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        console.error(`[linear-tickets] ${ticket?.identifier ?? issueId}: watchdog: posting "${report.body}" failed (${error instanceof Error ? error.message : error}); it is posted on the next poll`);
      }
    }
  }

  private async dropReport(issueId: string, key: string): Promise<void> {
    await this.deps.store.update((file) => {
      const ticket = file.tickets[issueId];
      if (ticket?.reports) ticket.reports = ticket.reports.filter((report) => report.key !== key);
    });
  }
}
