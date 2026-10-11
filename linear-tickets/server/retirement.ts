import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { dispatchLabels } from "./dispatch";
import type { HandoverRecord } from "./handover";
import type { IssueStatus, LinearService } from "./linear";
import type { NeedsYouIssues } from "./needs-you";
import { ghostAgents, type ProcessInspector } from "./process-liveness";
import { RateLimitedError, withPriority } from "./rate-budget";
import type { ReviewDeletions } from "./review-deletions";
import type { HostOwnership, SessionRouter } from "./sessions";
import type { Settings } from "./settings";
import { classifyTicketAgents } from "./starter";
import { paseoHome } from "./ticket-mcp";
import type { TicketRoots, WatchdogStore, WatchedAgent } from "./watchdog";

// Finished ticket agents (README, "Ghost agents" and "Who starts next"): an agent whose ticket is
// Done or Canceled and that has been quiet for more than an hour holds no agent slot, and the pull
// request watch's poll archives it; a ghost quiet for more than a day is archived too. Agents that
// wait for the owner, tickets whose stack has not landed, the peer host's tickets and the
// watchdog's recoveries are left alone.

export const QUIET_DONE_MS = 60 * 60_000;
export const OLD_GHOST_MS = 24 * 60 * 60_000;
// A candidate left alone because the owner has something to answer is judged again after this.
const WAIT_RECHECK_MS = 15 * 60_000;
const TERMINAL: Record<string, true> = { completed: true, canceled: true, duplicate: true };
const NEEDS_INPUT = "needs input";

// How long the agent has been quiet: since its last update in Paseo. Null for an unreadable or
// future time, which never counts as quiet.
export function quietFor(updatedAt: string | null | undefined, now: number): number | null {
  const at = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(at) && at <= now ? now - at : null;
}

const short = (id: string) => id.slice(0, 8);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// The last workflow state type Paseo saw of each ticket with a candidate agent, for the slot count
// (TicketStarter's scheduler) and the retire pass. Of two observations the later stamp wins: a read
// is stamped when its request was sent, a state the plugin wrote when Linear confirmed it, and a
// write wins a tie. So a reopen written after a poll's read is never undone by that read. Kept in
// memory: after a reload every agent counts until the first poll observed its ticket.
export class DoneTickets {
  private readonly seen = new Map<string, { type: string; at: number }>();

  // A successful read that returned the ticket.
  read(issueId: string, type: string, at: number): void {
    const known = this.seen.get(issueId);
    if (known && known.at >= at) return;
    this.seen.set(issueId, { type: type.trim().toLowerCase(), at });
  }

  // A state the plugin wrote (LinearService.onStateWritten).
  written(issueId: string, type: string, at: number): void {
    const known = this.seen.get(issueId);
    if (known && known.at > at) return;
    this.seen.set(issueId, { type: type.trim().toLowerCase(), at });
  }

  // A successful read that did not return the ticket (deleted, no access): its agent counts again,
  // unless a later observation exists. A failed read changes nothing.
  missing(issueId: string, at: number): void {
    const known = this.seen.get(issueId);
    if (known && known.at < at) this.seen.delete(issueId);
  }

  // Forgets the tickets without a candidate agent.
  retain(issueIds: Set<string>): void {
    for (const issueId of [...this.seen.keys()]) if (!issueIds.has(issueId)) this.seen.delete(issueId);
  }

  type(issueId: string): string | null {
    return this.seen.get(issueId)?.type ?? null;
  }

  // The agent frees its slot: its ticket was last seen Done, Canceled or Duplicate, and it has been
  // quiet for more than QUIET_DONE_MS. Any activity, or a state the plugin writes, counts it again.
  releases(agent: Pick<PaseoAgent, "labels" | "updatedAt">, now: number): boolean {
    const issueId = agent.labels?.["linear.issueId"];
    const type = issueId ? this.type(issueId) : null;
    if (!type || !TERMINAL[type]) return false;
    const quiet = quietFor(agent.updatedAt, now);
    return quiet !== null && quiet > QUIET_DONE_MS;
  }
}

// The `<trigger>-running` labels still to remove after an archive, one per archived agent, in
// retired-labels.json next to pr-watch.json: written before the archive, so a reload between the
// archive and the label step loses nothing. Only a missing file starts empty; an unreadable one
// throws, so nothing is archived while it cannot be written.
export type RetiredLabel = { issueId: string; identifier: string; agentId: string };

export class RetiredLabels {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path = join(paseoHome(), "linear-tickets", "retired-labels.json")) {}

  async all(): Promise<RetiredLabel[]> {
    return Object.values(await this.read());
  }

  add(entry: RetiredLabel): Promise<void> {
    return this.update((entries) => { entries[entry.agentId] = entry; });
  }

  remove(agentId: string): Promise<void> {
    return this.update((entries) => { delete entries[agentId]; });
  }

  private async read(): Promise<Record<string, RetiredLabel>> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`retired-labels.json cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("retired-labels.json is not valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("retired-labels.json has an unknown shape");
    const entries: Record<string, RetiredLabel> = {};
    for (const [agentId, value] of Object.entries(parsed as Record<string, Partial<RetiredLabel>>)) {
      if (value && typeof value.issueId === "string" && typeof value.identifier === "string" && value.agentId === agentId) entries[agentId] = { issueId: value.issueId, identifier: value.identifier, agentId };
    }
    return entries;
  }

  private update(change: (entries: Record<string, RetiredLabel>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = await this.read();
      change(entries);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// Whether a Done ticket's stack landed (PullRequestWatch.stackSettled): `open` while the stack
// policy would reopen it or reopened it, `unknown` while its pull requests cannot be read.
export type StackState = "settled" | "open" | "unknown";

// What one pull request watch poll hands the pass.
export type RetirePoll = {
  // The poll's one batch read of its tickets' states, when it was sent and which tickets it asked
  // for; `states` is null when it did not come back (PullRequestWatch.observeStates).
  states: Map<string, IssueStatus> | null;
  sentAt: number;
  asked: ReadonlySet<string>;
  stack: (issueId: string) => Promise<StackState>;
};

export type RetireOutcome =
  | { kind: "archived"; status: string }
  // `wait`: the owner has something to answer; the candidate is judged again after WAIT_RECHECK_MS.
  | { kind: "skipped"; reason: string; wait?: true };

type Candidate = { issueId: string; identifier: string; agent: WatchedAgent; kind: "done" | "ghost"; quiet: number };

export type RetireDeps = {
  sessions: Pick<SessionRouter, "watchdogRoots" | "retireTurn" | "sessionFor" | "watchdogThread">;
  linear: Pick<LinearService, "issueStatuses" | "issueWatchState" | "issueCore" | "removeLabel">;
  settings: Pick<Settings, "read">;
  handover: { all(): Promise<HandoverRecord[]> };
  needsYou?: Pick<NeedsYouIssues, "all">;
  // The watchdog's owner Stops and recovery cycles (watchdog.ts): a ticket in either is left alone.
  watchdog: Pick<WatchdogStore, "read">;
  deletions?: Pick<ReviewDeletions, "blocked">;
  // Which host works on the ticket (activation-guard.ts); absent: this one.
  owner?: (issueId: string) => Promise<HostOwnership>;
  doneTickets: DoneTickets;
  labels: Pick<RetiredLabels, "all" | "add" | "remove">;
  inspect?: ProcessInspector;
  now?: () => number;
};

const skip = (reason: string): RetireOutcome => ({ kind: "skipped", reason });
const wait = (reason: string): RetireOutcome => ({ kind: "skipped", reason, wait: true });

// Runs in every pull request watch poll, right after the stack policy reopened what it reopens.
export class RetirePass {
  private revoked = false;
  private readonly logged = new Map<string, string>();
  private readonly waitUntil = new Map<string, number>();

  constructor(private readonly deps: RetireDeps) {}

  // Unload: no archive or label write starts after this.
  stop(): void {
    this.revoked = true;
  }

  private alive = (): boolean => !this.revoked;

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // A condition logged once until it changes, so a two-minute poll does not flood the log.
  private once(key: string, text: string): void {
    if (this.logged.get(key) === text) return;
    this.logged.set(key, text);
    console.log(`[linear-tickets] ${text}`);
  }

  // A rate limit ends the pass (RateLimitedError is thrown); every other failure is logged and
  // tried again on the next poll.
  async pass(poll: RetirePoll): Promise<void> {
    if (this.revoked) return;
    // The labels of the agents archived by earlier passes first: never in the poll of the archive,
    // so the archive's own write-back (Writeback.archived) had its turn.
    await this.settleLabels();
    let tickets: Map<string, TicketRoots>;
    try {
      tickets = await this.deps.sessions.watchdogRoots();
    } catch (error) {
      this.once("roots", `retiring finished agents: ${message(error)}; the next poll tries again`);
      return;
    }
    this.logged.delete("roots");
    const now = this.clock();
    const candidates = this.candidates(tickets, now);
    this.deps.doneTickets.retain(new Set(candidates.map((candidate) => candidate.issueId)));
    for (const id of [...this.waitUntil.keys()]) if (!candidates.some((candidate) => candidate.agent.id === id)) this.waitUntil.delete(id);
    if (!candidates.length) return;
    const known = await this.observe(candidates, poll);
    for (const candidate of candidates) {
      if (!this.alive()) return;
      if (!known.has(candidate.issueId) || (this.waitUntil.get(candidate.agent.id) ?? 0) > now) continue;
      if (candidate.kind === "done") {
        const type = this.deps.doneTickets.type(candidate.issueId);
        if (!type || !TERMINAL[type]) continue;
        if (type === "completed") {
          const stack = await poll.stack(candidate.issueId);
          const key = `retire:${candidate.agent.id}`;
          if (stack === "open") { this.once(key, `${candidate.identifier}: its quiet agent ${short(candidate.agent.id)} stays; the ticket's stack has open pull requests`); continue; }
          if (stack === "unknown") { this.once(key, `${candidate.identifier}: its quiet agent ${short(candidate.agent.id)} stays; the ticket's open pull requests cannot be read`); continue; }
        }
      }
      await this.retire(candidate, now);
    }
  }

  // Running or starting roots quiet for more than an hour (archived only once their ticket is Done
  // or Canceled), and ghosts quiet for more than a day (whatever their ticket's state).
  private candidates(tickets: Map<string, TicketRoots>, now: number): Candidate[] {
    const found: Candidate[] = [];
    for (const ticket of tickets.values()) {
      for (const agent of ticket.roots) {
        const quiet = quietFor(agent.updatedAt, now);
        if (quiet === null || agent.archivedAt || agent.labels?.["paseo.parent-agent-id"]) continue;
        const base = { issueId: ticket.issueId, identifier: ticket.identifier, agent, quiet };
        if (ticket.ghosts.has(agent.id) && quiet > OLD_GHOST_MS) found.push({ ...base, kind: "ghost" });
        else if ((agent.status === "running" || agent.status === "initializing") && quiet > QUIET_DONE_MS && !agent.pendingPermissions?.length) found.push({ ...base, kind: "done" });
      }
    }
    return found;
  }

  // The candidates' ticket states from the poll's read, and one background read for the tickets it
  // lacks. Returns the tickets with a state from this poll; no other ticket is archived.
  private async observe(candidates: Candidate[], poll: RetirePoll): Promise<Set<string>> {
    const known = new Set<string>();
    const lacking: string[] = [];
    for (const issueId of new Set(candidates.map((candidate) => candidate.issueId))) {
      const state = poll.states?.get(issueId);
      if (state) {
        this.deps.doneTickets.read(issueId, state.statusType, poll.sentAt);
        known.add(issueId);
      } else if (poll.states && poll.asked.has(issueId)) {
        // Asked for and absent from a successful read: deleted or out of reach, so the agent counts.
        this.deps.doneTickets.missing(issueId, poll.sentAt);
      } else lacking.push(issueId);
    }
    if (!lacking.length) return known;
    const sent = this.clock();
    try {
      const states = await withPriority("background", "retire", () => this.deps.linear.issueStatuses(lacking));
      for (const issueId of lacking) {
        const state = states.get(issueId);
        if (!state) { this.deps.doneTickets.missing(issueId, sent); continue; }
        this.deps.doneTickets.read(issueId, state.statusType, sent);
        known.add(issueId);
      }
      this.logged.delete("states");
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      this.once("states", `retiring finished agents: reading their tickets' states failed: ${message(error)}; the next poll tries again`);
    }
    return known;
  }

  private async retire(candidate: Candidate, now: number): Promise<void> {
    const { identifier, agent, kind, quiet } = candidate;
    const what = kind === "done" ? `its quiet agent ${short(agent.id)}` : `its ghost ${short(agent.id)}`;
    const key = `retire:${agent.id}`;
    let outcome: RetireOutcome;
    try {
      const turn = await this.deps.sessions.retireTurn(candidate.issueId, (paseo) => this.archive(paseo, candidate));
      outcome = turn.ran ? turn.value : skip(turn.reason);
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      this.once(key, `${identifier}: archiving ${what} failed: ${message(error)}; the next poll retries`);
      return;
    }
    const hours = `${Math.floor(quiet / 3_600_000)} h`;
    if (outcome.kind === "archived") {
      this.logged.delete(key);
      this.waitUntil.delete(agent.id);
      console.log(`[linear-tickets] ${identifier}: archived ${what} (${kind === "done" ? `ticket ${outcome.status}, ` : ""}quiet ${hours})`);
      return;
    }
    if (outcome.wait) this.waitUntil.set(agent.id, now + WAIT_RECHECK_MS);
    this.once(key, `${identifier}: ${what} is not archived: ${outcome.reason}`);
  }

  // In the ticket's turn and under its start gate (SessionRouter.retireTurn): the fences, the fresh
  // agent, the owner's waits and the ticket's fresh state; then the label debt; then the final
  // look after every remote read; then the archive. The daemon has no conditional archive, so an
  // agent waking between the final look and the archive (one round trip) is still archived; it
  // stays resumable from the archive.
  private async archive(paseo: PaseoApi, candidate: Candidate): Promise<RetireOutcome> {
    const { issueId, identifier, kind } = candidate;
    const agentId = candidate.agent.id;
    const unloading = skip("the plugin is unloading");
    if (!this.alive()) return unloading;
    const fenced = await this.fences(issueId, agentId);
    if (fenced) return fenced;
    const first = await snapshot(paseo, agentId);
    const vetoed = await this.agentVeto(first, kind);
    if (vetoed) return vetoed;
    const sent = this.clock();
    const state = await withPriority("background", "retire", () => this.deps.linear.issueWatchState(issueId));
    const type = state.statusType.trim().toLowerCase();
    if (kind === "done" && !TERMINAL[type]) {
      this.deps.doneTickets.read(issueId, type, sent);
      return skip(`${identifier} is ${state.status}`);
    }
    if (state.status.trim().toLowerCase() === NEEDS_INPUT) return wait(`${identifier} waits for the owner in ${state.status}`);
    const needsYou = dispatchLabels((await this.deps.settings.read()).dispatch.label).needsYou;
    if (state.labels.some((label) => label.name.trim().toLowerCase() === needsYou.toLowerCase())) return wait(`${identifier} waits for the owner (${needsYou})`);
    if (!this.alive()) return unloading;
    // Before the archive: a failed write archives nothing.
    await this.deps.labels.add({ issueId, identifier, agentId });
    if (!this.alive()) return unloading;
    const fencedAgain = await this.fences(issueId, agentId);
    if (fencedAgain) return fencedAgain;
    const last = await snapshot(paseo, agentId);
    if (!last || last.archivedAt) return skip("the agent is gone");
    if (last.updatedAt !== first!.updatedAt || (kind === "done" && last.status !== "running" && last.status !== "initializing")) return skip("the agent was active again");
    if (last.pendingPermissions?.length) return wait("the agent waits for the owner's answer or approval");
    if (!this.alive()) return unloading;
    try {
      await paseo.agents.ref(agentId).archive();
    } catch (error) {
      if (/not found/i.test(message(error))) return skip("the agent is gone");
      throw error;
    }
    return { kind: "archived", status: state.status };
  }

  // The host, the watchdog and the owner's waits this plugin keeps locally; cheap, so they are read
  // again right before the archive.
  private async fences(issueId: string, agentId: string): Promise<RetireOutcome | null> {
    const owner = this.deps.owner ? await this.deps.owner(issueId) : "here";
    if (owner === "elsewhere") return skip("the other host works on the ticket");
    if (owner === "unknown") return skip("which host works on the ticket cannot be told right now");
    if (await this.deps.deletions?.blocked(issueId)) return skip("the ticket is paused for deletion");
    let file;
    try { file = await this.deps.watchdog.read(); } catch { return skip("the watchdog state cannot be read"); }
    if (file.holds[issueId]) return wait("the owner stopped the ticket's agent");
    if (file.tickets[issueId]?.cycle) return skip("the watchdog is recovering the ticket");
    if ((await this.deps.sessions.sessionFor(agentId))?.review) return wait("the agent's plan is under review");
    const thread = await this.deps.sessions.watchdogThread(issueId);
    if (thread?.review) return wait("a plan review is open");
    if (thread?.queued) return skip("the ticket's thread is queued");
    if (thread?.remote) return skip("the ticket's thread is with the peer host");
    if (thread?.group) return skip("the ticket hands out sub-issues");
    if (thread?.offer && ["split", "later", "parked"].includes(thread.offer)) return wait(`the ticket's plan is ${thread.offer === "later" ? "approved for later" : thread.offer}`);
    if ((await this.deps.handover.all()).find((record) => record.issueId === issueId)?.waiting) return wait("the agent waits for the owner");
    if ((await this.deps.needsYou?.all())?.some((entry) => entry.parentId === issueId)) return wait("a Needs you sub-issue waits for the owner");
    return null;
  }

  // The fresh agent: still an unarchived root, without a pending permission, and still quiet; a
  // ghost still without its process.
  private async agentVeto(agent: PaseoAgent | null, kind: Candidate["kind"]): Promise<RetireOutcome | null> {
    if (!agent || agent.archivedAt) return skip("the agent is gone");
    if (agent.labels?.["paseo.parent-agent-id"]) return skip("the agent is a subagent");
    if (agent.pendingPermissions?.length) return wait("the agent waits for the owner's answer or approval");
    const now = this.clock();
    const quiet = quietFor(agent.updatedAt, now);
    if (kind === "done") {
      if (agent.status !== "running" && agent.status !== "initializing") return skip(`the agent is ${agent.status}`);
      if (quiet === null || quiet <= QUIET_DONE_MS) return skip("the agent was active within the hour");
      return null;
    }
    if (quiet === null || quiet <= OLD_GHOST_MS) return skip("the ghost was active within the day");
    if (!(await ghostAgents([agent], now, this.deps.inspect)).has(agent.id)) return skip("the agent's process runs again");
    return null;
  }

  // The label step for every agent an earlier pass archived, in the ticket's turn and under its
  // start gate. One effective removal: the archive's write-back may have removed it first.
  private async settleLabels(): Promise<void> {
    let entries: RetiredLabel[];
    try {
      entries = await this.deps.labels.all();
    } catch (error) {
      this.once("labels", `retiring finished agents: ${message(error)}; their running labels wait`);
      return;
    }
    this.logged.delete("labels");
    for (const entry of entries) {
      if (!this.alive()) return;
      const key = `label:${entry.agentId}`;
      try {
        await this.deps.sessions.retireTurn(entry.issueId, (paseo) => this.settleLabel(paseo, entry, key));
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        // A deleted ticket has no label left to remove.
        if (/did not return this issue/i.test(message(error))) { await this.deps.labels.remove(entry.agentId).catch(() => {}); continue; }
        this.once(key, `${entry.identifier}: removing the running label after archiving agent ${short(entry.agentId)} failed: ${message(error)}; the next poll retries`);
      }
    }
  }

  private async settleLabel(paseo: PaseoApi, entry: RetiredLabel, key: string): Promise<void> {
    const { issueId, identifier, agentId } = entry;
    const agent = await snapshot(paseo, agentId);
    // The archive failed, was skipped or never ran: the next archive writes a new entry.
    if (agent && !agent.archivedAt) { await this.deps.labels.remove(agentId); return; }
    const owner = this.deps.owner ? await this.deps.owner(issueId) : "here";
    if (owner === "unknown") { this.once(key, `${identifier}: its running label waits until which host works on the ticket can be told`); return; }
    if (owner === "elsewhere") {
      this.once(key, `${identifier}: the other host works on the ticket now; its running label is left to it`);
      await this.deps.labels.remove(agentId);
      return;
    }
    // Another root still works on the ticket (a successor): it keeps the label. Stopped roots and
    // ghosts do not.
    if ((await classifyTicketAgents(paseo, issueId, this.clock(), this.deps.inspect)).live.length) { await this.deps.labels.remove(agentId); return; }
    const running = dispatchLabels((await this.deps.settings.read()).dispatch.label).running;
    const core = await withPriority("background", "retire", () => this.deps.linear.issueCore(issueId));
    if (core.labels.some((label) => label.name.trim().toLowerCase() === running.toLowerCase())) {
      if (!this.alive()) return;
      await this.deps.linear.removeLabel(issueId, running, core.labels);
      console.log(`[linear-tickets] ${identifier}: removed ${running} after archiving its agent ${short(agentId)}`);
    }
    this.logged.delete(key);
    await this.deps.labels.remove(agentId);
  }
}

// The agent as the daemon shows it now, archived ones included; null once it no longer exists.
async function snapshot(paseo: PaseoApi, agentId: string): Promise<PaseoAgent | null> {
  const found = await paseo.agents.ref(agentId).refresh().catch((error: unknown) => {
    if (/not found/i.test(message(error))) return null;
    throw error;
  });
  return found?.agent ?? null;
}
