import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { decide, triggeringUserMessage } from "./decision";
import { changedFiles, coreWebRoot, snapshotTree } from "./git-snapshot";

type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

interface Baseline {
  root: string;
  tree: string;
}

export interface TurnMonitorOptions {
  log?(message: string, error?: unknown): void;
}

/** Delivers a prompt to an agent, normally `paseo.agents.ref(agentId).send(text)`. */
export type AgentSend = (agentId: string, text: string) => Promise<void>;

export interface TurnMonitor {
  turnStarted(event: TurnStarted): Promise<void>;
  turnEnded(event: TurnEnded, send: AgentSend): Promise<void>;
  close(): void;
}

/** How many unfinished turns per agent keep a baseline before the oldest is dropped. */
const QUEUE_LIMIT = 8;

/**
 * Tracks each agent turn's working tree and sends at most one browser-check follow-up per
 * finished turn. Hooks may overlap, so the per-agent baseline queue is consumed in event order.
 */
export function createTurnMonitor(options: TurnMonitorOptions = {}): TurnMonitor {
  const log =
    options.log ??
    ((message: string, error?: unknown) =>
      console.error(`[ui-verify] ${message}`, ...(error === undefined ? [] : [error])));
  const pending = new Map<string, Promise<Baseline | null>[]>();

  async function capture(cwd: string): Promise<Baseline | null> {
    const root = await coreWebRoot(cwd);
    if (!root) return null;
    try {
      return { root, tree: await snapshotTree(root) };
    } catch (error) {
      log(`could not snapshot ${root} at turn start`, error);
      return null;
    }
  }

  return {
    async turnStarted(event) {
      if (!event.agent.cwd) return;
      const queue = pending.get(event.agent.id) ?? [];
      queue.push(capture(event.agent.cwd));
      if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
      pending.set(event.agent.id, queue);
      await queue[queue.length - 1];
    },

    async turnEnded(event, send) {
      const queue = pending.get(event.agent.id);
      const started = queue?.shift();
      if (queue && queue.length === 0) pending.delete(event.agent.id);
      if (!started) return;
      const baseline = await started;
      if (!baseline || event.outcome.kind !== "completed") return;

      let tree: string;
      try {
        tree = await snapshotTree(baseline.root);
      } catch (error) {
        log(`could not snapshot ${baseline.root} at turn end`, error);
        return;
      }

      let files: string[];
      try {
        files = await changedFiles(baseline.root, baseline.tree, tree);
      } catch (error) {
        log(`could not diff ${baseline.root}`, error);
        return;
      }

      const decision = decide({
        coreWeb: true,
        outcome: event.outcome,
        trigger: triggeringUserMessage(event.timeline),
        timeline: event.timeline,
        changedFiles: files,
      });
      if (decision.kind === "skip") return;

      try {
        await send(event.agent.id, decision.text);
      } catch (error) {
        log(`could not send the follow-up to agent ${event.agent.id}`, error);
      }
    },

    close() {
      pending.clear();
    },
  };
}