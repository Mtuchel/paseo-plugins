import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import { LOOKBACK_TURNS, readTurnTimeline, type TimelineItem, type TimelineSource } from "../server/timeline";

type Page = Awaited<ReturnType<TimelineSource["refetch"]>>;
type Entry = Page["entries"][number];

const user = (text: string): TimelineItem => ({ type: "user_message", text });
const assistant = (text: string): TimelineItem => ({ type: "assistant_message", text });

/**
 * A daemon timeline of whole turns. `tail` and `before` with `limit: 1, wholeTurns: true` return
 * one whole turn, as Paseo's projected timeline does.
 */
function daemon(turns: Array<{ turnId: string; items: TimelineItem[] }>, epochs: string[] = []) {
  const requests: PaseoAgentTimelineRefetchOptions[] = [];
  let seq = 0;
  const pages = turns.map(({ turnId, items }) =>
    items.map(
      (item): Entry => ({
        provider: "codex",
        item,
        turnId,
        timestamp: "2026-11-21T00:00:00.000Z",
        seqStart: ++seq,
        seqEnd: seq,
        sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        collapsed: [],
      }),
    ),
  );
  const page = (index: number, direction: Page["direction"]): Page => ({
    requestId: `request-${requests.length}`,
    agentId: "agent-1",
    agent: null,
    direction,
    projection: "projected",
    epoch: epochs[index] ?? "epoch-1",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 },
    startCursor: { epoch: epochs[index] ?? "epoch-1", seq: index },
    endCursor: null,
    hasOlder: index > 0,
    hasNewer: index < pages.length - 1,
    entries: pages[index],
    error: null,
  });
  const source: TimelineSource = {
    async refetch(options = {}) {
      requests.push(options);
      assert.equal(options.limit, 1);
      assert.equal(options.wholeTurns, true);
      if (options.direction === "tail") return page(pages.length - 1, "tail");
      assert.equal(options.direction, "before");
      assert.ok(options.cursor);
      return page(options.cursor.seq - 1, "before");
    },
  };
  return { source, requests };
}

test("a turn that starts with a user message is read in one call", async () => {
  const { source, requests } = daemon([
    { turnId: "turn-1", items: [user("Old"), assistant("Old answer")] },
    { turnId: "turn-2", items: [user("Change the page"), assistant("Done")] },
  ]);

  assert.deepEqual(await readTurnTimeline(source, "turn-2"), [user("Change the page"), assistant("Done")]);
  assert.equal(requests.length, 1);
});

test("a continuation turn reaches back to the user message that started the request", async () => {
  const { source, requests } = daemon([
    { turnId: "turn-1", items: [user("Unrelated"), assistant("Ok")] },
    { turnId: "turn-2", items: [user("Change the page"), assistant("Working")] },
    { turnId: "turn-3", items: [assistant("Still working")] },
    { turnId: "turn-4", items: [assistant("Done")] },
  ]);

  assert.deepEqual(await readTurnTimeline(source, "turn-4"), [
    user("Change the page"),
    assistant("Working"),
    assistant("Still working"),
    assistant("Done"),
  ]);
  assert.equal(requests.length, 3);
});

test("the lookback stops after LOOKBACK_TURNS earlier turns", async () => {
  const turns = Array.from({ length: LOOKBACK_TURNS + 3 }, (_, index) => ({
    turnId: `turn-${index}`,
    items: index === 0 ? [user("Long ago")] : [assistant(`step ${index}`)],
  }));
  const { source, requests } = daemon(turns);

  const timeline = await readTurnTimeline(source, turns.at(-1)!.turnId);
  assert.ok(timeline);
  assert.equal(timeline.some((item) => item.type === "user_message"), false);
  assert.equal(requests.length, LOOKBACK_TURNS + 1);
});

test("a replaced timeline stops the lookback at the epoch change", async () => {
  const { source } = daemon(
    [
      { turnId: "turn-1", items: [user("Change the page")] },
      { turnId: "turn-2", items: [assistant("Done")] },
    ],
    ["epoch-old", "epoch-new"],
  );

  assert.deepEqual(await readTurnTimeline(source, "turn-2"), [assistant("Done")]);
});

test("a turn that is not the latest, or has no id, is unreadable", async () => {
  const { source, requests } = daemon([
    { turnId: "turn-1", items: [user("First")] },
    { turnId: "turn-2", items: [user("Second")] },
  ]);

  assert.equal(await readTurnTimeline(source, "turn-1"), null);
  assert.equal(await readTurnTimeline(source, null), null);
  assert.equal(requests.length, 1);
});

test("a daemon error rejects the read", async () => {
  const source: TimelineSource = {
    async refetch() {
      return { ...(await daemon([{ turnId: "turn-1", items: [] }]).source.refetch({ direction: "tail", limit: 1, wholeTurns: true })), error: "agent not found" };
    },
  };

  await assert.rejects(readTurnTimeline(source, "turn-1"), /agent not found/);
});
