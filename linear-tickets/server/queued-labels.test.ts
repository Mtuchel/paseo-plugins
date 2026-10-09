import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LinearApiError } from "./linear";
import { QueuedLabels } from "./queued-labels";
import { RateLimitedError } from "./rate-budget";

const MINUTE = 60_000;

async function setup(t: TestContext, directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), "queued-labels-"));
  if (!directory) t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { waiting: [] as string[], admitted: [] as string[], label: "paseo-queued", now: 0, fail: null as ((issueId: string) => Error | null) | null };
  const calls: string[] = [];
  const write = (call: string, issueId: string) => {
    const error = state.fail?.(issueId);
    if (error) throw error;
    calls.push(call);
  };
  const labels = new QueuedLabels({
    linear: {
      addLabel: async (issueId, name) => write(`+${name} ${issueId}`, issueId),
      removeLabel: async (issueId, name) => write(`-${name} ${issueId}`, issueId),
    },
    waiting: async () => state.waiting,
    admitted: () => state.admitted,
    label: async () => state.label,
    now: () => state.now,
  }, join(dir, "queued-labels.json"));
  t.after(() => labels.stop());
  return { labels, state, calls, dir };
}

test("a ticket gets the label once while it waits and loses it as soon as it is admitted", async (t) => {
  const h = await setup(t);
  h.state.waiting = ["i1", "i2"];
  await h.labels.sync();
  await h.labels.sync();
  assert.deepEqual(h.calls, ["+paseo-queued i1", "+paseo-queued i2"]);
  h.state.waiting = ["i2"];
  h.state.admitted = ["i1"];
  h.state.now = MINUTE;
  await h.labels.sync();
  assert.deepEqual(h.calls.slice(2), ["-paseo-queued i1"]);
});

test("a ticket no longer asked for keeps its label for 20 minutes, so a start path that asks every 15 does not flap it", async (t) => {
  const h = await setup(t);
  h.state.waiting = ["i1"];
  await h.labels.sync();
  h.state.waiting = [];
  h.state.now = 15 * MINUTE;
  await h.labels.sync();
  h.state.waiting = ["i1"];
  await h.labels.sync();
  h.state.waiting = [];
  h.state.now = 34 * MINUTE;
  await h.labels.sync();
  assert.deepEqual(h.calls, ["+paseo-queued i1"], "seen again at 15 minutes: still in line at 34");
  h.state.now = 35 * MINUTE;
  await h.labels.sync();
  assert.deepEqual(h.calls, ["+paseo-queued i1", "-paseo-queued i1"]);
});

test("a label this host did not put on (the other host's line, the owner's own) is never taken off", async (t) => {
  const h = await setup(t);
  h.state.admitted = ["i9"];
  h.state.now = 60 * MINUTE;
  await h.labels.sync();
  assert.deepEqual(h.calls, []);
});

test("after a reload the labels it put on stay until their ticket is admitted or 20 minutes passed without it waiting", async (t) => {
  const first = await setup(t);
  first.state.waiting = ["i1", "i2"];
  await first.labels.sync();
  const h = await setup(t, first.dir);
  h.state.now = 100 * MINUTE;
  await h.labels.sync();
  assert.deepEqual(h.calls, [], "the line is still empty in memory");
  h.state.admitted = ["i2"];
  await h.labels.sync();
  assert.deepEqual(h.calls, ["-paseo-queued i2"]);
  h.state.now = 120 * MINUTE;
  await h.labels.sync();
  assert.deepEqual(h.calls, ["-paseo-queued i2", "-paseo-queued i1"]);
});

test("a renamed trigger moves the label to the new name", async (t) => {
  const h = await setup(t);
  h.state.waiting = ["i1"];
  await h.labels.sync();
  h.state.label = "agent-queued";
  await h.labels.sync();
  assert.deepEqual(h.calls, ["+paseo-queued i1", "-paseo-queued i1", "+agent-queued i1"]);
});

test("a rate limit ends the pass with its progress kept; a deleted ticket is forgotten", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = await setup(t);
  h.state.waiting = ["i1", "i2", "gone"];
  const notFound = () => new LinearApiError("Entity not found: Issue", 400, [], ["Entity not found: Issue"]);
  h.state.fail = (issueId) => issueId === "i2" ? new RateLimitedError("key", Date.now() + MINUTE) : issueId === "gone" ? notFound() : null;
  await h.labels.sync();
  assert.deepEqual(h.calls, ["+paseo-queued i1"]);
  h.state.fail = (issueId) => issueId === "gone" ? notFound() : null;
  await h.labels.sync();
  assert.deepEqual(h.calls, ["+paseo-queued i1", "+paseo-queued i2"], "i1 is not labelled twice; gone is not retried as labelled");
  h.state.fail = null;
  h.state.waiting = [];
  h.state.admitted = ["i1", "i2", "gone"];
  await h.labels.sync();
  assert.deepEqual(h.calls.slice(2).sort(), ["-paseo-queued i1", "-paseo-queued i2"], "only what it labelled comes off");
});
