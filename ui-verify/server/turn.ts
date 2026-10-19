import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { decide, triggeringUserMessageInfo } from "./decision";
import {
  changedFiles,
  coreWebRoot,
  isAbortError,
  snapshotTree,
  type GitOptions,
} from "./git-snapshot";

type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

interface Baseline {
  root: string;
  tree: string;
}

interface TurnBaseline {
  /** Bumped by every turn start; a completed turn only sends while this is still current. */
  generation: number;
  baseline: Promise<Baseline | null>;
}

interface AgentState {
  generation: number;
  turns: TurnBaseline[];
  /** Human requests that already got a follow-up, so autonomous continuations do not repeat it. */
  reminded: Set<string>;
}

export interface TurnMonitorOptions {
  log?(message: string, error?: unknown): void;
  /** Git executable, overridable in tests. */
  gitBinary?: string;
}

/** Delivers a prompt to an agent, normally `paseo.agents.ref(agentId).send(text)`. */
export type AgentSend = (agentId: string, text: string) => Promise<void>;

export interface TurnMonitor {
  turnStarted(event: TurnStarted): Promise<void>;
  turnEnded(event: TurnEnded, send: AgentSend): Promise<void>;
  /** Aborts in-flight git commands and waits for their temporary directories to be removed. */
  close(): Promise<void>;
}

/** How many unfinished turns per agent keep a baseline before the oldest is dropped. */
const QUEUE_LIMIT = 8;

/** How many human requests per agent remember that they were already nudged. */
const REMINDED_LIMIT = 64;

/**
 * Tracks each agent turn's working tree and sends at most one browser-check follow-up per
 * finished turn. Hooks may overlap, so the per-agent baseline queue is consumed in event order.
 *
 * Paseo delivers a prompt to an active turn by interrupting it by default (the only other mode,
 * `steer`, can replace the turn on providers without steering). The plugin therefore never sends
 * once a newer turn has started, rather than risk interrupting it. See README, "A newer turn".
 */
export function createTurnMonitor(options: TurnMonitorOptions = {}): TurnMonitor {
  const log =
    options.log ??
    ((message: string, error?: unknown) =>
      console.error(`[ui-verify] ${message}`, ...(error === undefined ? [] : [error])));
  const states = new Map<string, AgentState>();
  const active = new Set<Promise<unknown>>();
  const controller = new AbortController();
  let closed = false;

  const gitOptions: GitOptions = { signal: controller.signal, binary: options.gitBinary };

  function stateFor(agentId: string): AgentState {
    const existing = states.get(agentId);
    if (existing) return existing;
    const state: AgentState = { generation: 0, turns: [], reminded: new Set() };
    states.set(agentId, state);
    return state;
  }

  /** Keeps the close path waiting for this operation, including temp-directory removal. */
  function track<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      (value) => {
        active.delete(promise);
        return value;
      },
      (error) => {
        active.delete(promise);
        throw error;
      },
    );
    active.add(promise);
    return settled;
  }

  function remember(state: AgentState, key: string): void {
    state.reminded.add(key);
    if (state.reminded.size <= REMINDED_LIMIT) return;
    const oldest = state.reminded.values().next().value;
    if (oldest !== undefined) state.reminded.delete(oldest);
  }

  async function capture(cwd: string): Promise<Baseline | null> {
    let root: string | null = null;
    try {
      root = await coreWebRoot(cwd, gitOptions);
      if (!root) return null;
      return { root, tree: await snapshotTree(root, gitOptions) };
    } catch (error) {
      if (!isAbortError(error)) log(`could not snapshot ${root ?? cwd} at turn start`, error);
      return null;
    }
  }

  return {
    async turnStarted(event) {
      if (closed) return;
      const state = stateFor(event.agent.id);
      state.generation += 1;
      const baseline = track(
        event.agent.cwd ? capture(event.agent.cwd) : Promise.resolve(null),
      );
      state.turns.push({ generation: state.generation, baseline });
      if (state.turns.length > QUEUE_LIMIT) {
        state.turns.splice(0, state.turns.length - QUEUE_LIMIT);
      }
      await baseline;
    },

    async turnEnded(event, send) {
      if (closed) return;
      const state = states.get(event.agent.id);
      const turn = state?.turns.shift();
      if (!state || !turn) return;

      const baseline = await turn.baseline;
      if (closed || !baseline || event.outcome.kind !== "completed") return;
      if (state.generation !== turn.generation) {
        log(`dropped the follow-up for agent ${event.agent.id}: a newer turn started`);
        return;
      }

      let tree: string;
      try {
        tree = await track(snapshotTree(baseline.root, gitOptions));
      } catch (error) {
        if (!isAbortError(error)) log(`could not snapshot ${baseline.root} at turn end`, error);
        return;
      }

      let files: string[];
      try {
        files = await track(changedFiles(baseline.root, baseline.tree, tree, gitOptions));
      } catch (error) {
        if (!isAbortError(error)) log(`could not diff ${baseline.root}`, error);
        return;
      }

      const trigger = triggeringUserMessageInfo(event.timeline);
      const decision = decide({
        coreWeb: true,
        outcome: event.outcome,
        trigger: trigger.text,
        timeline: event.timeline,
        changedFiles: files,
      });
      if (decision.kind === "skip") return;
      if (closed) return;
      if (state.generation !== turn.generation) {
        log(`dropped the follow-up for agent ${event.agent.id}: a newer turn started`);
        return;
      }

      // Reserve synchronously, before the send yield: concurrent turn-end handlers for the same
      // human request (autonomous continuations) must not both deliver a follow-up.
      if (trigger.key) {
        if (state.reminded.has(trigger.key)) return;
        remember(state, trigger.key);
      }

      try {
        await send(event.agent.id, decision.text);
      } catch (error) {
        log(`could not send the follow-up to agent ${event.agent.id}`, error);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      states.clear();
      while (active.size > 0) await Promise.allSettled([...active]);
    },
  };
}