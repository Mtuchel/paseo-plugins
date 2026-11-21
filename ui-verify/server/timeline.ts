import type { PaseoAgentTimelineHandle, PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export type TimelineItem = AgentTimelineItem;
export type Timeline = TimelineItem[];

/** The one timeline call this module makes, so tests can serve pages without a daemon. */
export type TimelineSource = Pick<PaseoAgentTimelineHandle, "refetch">;

/**
 * How many earlier turns are read to find the user message behind an autonomous continuation
 * turn, which starts without one. Beyond that the turn is treated as having no user message.
 */
export const LOOKBACK_TURNS = 16;

async function readPage(source: TimelineSource, options: PaseoAgentTimelineRefetchOptions) {
  const page = await source.refetch(options);
  if (page.error) throw new Error(`timeline read failed: ${page.error}`);
  return page;
}

/**
 * The agent's timeline up to the end of turn `turnId`, reaching back to the user message that
 * started it. Paseo 0.16 removed the timeline from the turn-end payload; this reads it the way
 * the payload's documentation describes. Null when `turnId` is null or the turn is no longer the
 * latest one (a newer turn started before the read).
 */
export async function readTurnTimeline(
  source: TimelineSource,
  turnId: string | null,
): Promise<Timeline | null> {
  if (!turnId) return null;
  let page = await readPage(source, { direction: "tail", limit: 1, wholeTurns: true });
  const last = page.entries.findLastIndex((entry) => entry.turnId === turnId);
  if (last < 0) return null;

  const epoch = page.epoch;
  let entries = page.entries.slice(0, last + 1);
  for (
    let older = 0;
    older < LOOKBACK_TURNS &&
    page.hasOlder &&
    page.startCursor &&
    !entries.some((entry) => entry.item.type === "user_message");
    older += 1
  ) {
    page = await readPage(source, {
      direction: "before",
      cursor: page.startCursor,
      limit: 1,
      wholeTurns: true,
    });
    // A replaced timeline renumbers its entries; older pages of the new epoch do not continue this one.
    if (page.epoch !== epoch) break;
    entries = [...page.entries, ...entries];
  }
  return entries.map((entry) => entry.item);
}
