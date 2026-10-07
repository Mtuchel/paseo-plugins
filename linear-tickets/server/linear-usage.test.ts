import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { asCaller, LinearUsage, usageLines, type LinearUsageHistory, type LinearUsageOptions } from "./linear-usage";
import { currentCaller, RateBudget, RateLimitedError } from "./rate-budget";
import { postGraphQL } from "./linear";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const START = Date.parse("2026-10-07T12:00:00.000Z");
const START_ISO = "2026-10-07T12:00:00.000Z";

function headers(requests: number | null, points: number | null, cost: number | null = 100): Headers {
  const result = new Headers();
  if (requests !== null) {
    result.set("x-ratelimit-requests-limit", "3600");
    result.set("x-ratelimit-requests-remaining", String(requests));
  }
  if (points !== null) {
    result.set("x-ratelimit-complexity-limit", "360000");
    result.set("x-ratelimit-complexity-remaining", String(points));
  }
  if (cost !== null) result.set("x-complexity", String(cost));
  return result;
}

async function fixture(t: TestContext, start = START) {
  const directory = await mkdtemp(join(tmpdir(), "linear-usage-"));
  const path = join(directory, "linear-usage.json");
  let now = start;
  let tick: (() => Promise<void>) | null = null;
  let installations = 0;
  let cancellations = 0;
  const logs: string[] = [];
  const instances: LinearUsage[] = [];
  const options: LinearUsageOptions = {
    path,
    timer: (work, intervalMs) => {
      assert.equal(intervalMs, MINUTE);
      installations++;
      tick = work;
      return () => { cancellations++; tick = null; };
    },
    log: (message) => { logs.push(message); },
  };
  const create = () => {
    const instance = new LinearUsage(() => now, options);
    instances.push(instance);
    return instance;
  };
  const usage = create();
  t.after(async () => {
    for (const instance of instances) await instance.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    usage, create, path, directory, logs,
    set: (at: number) => { now = at; },
    advance: (milliseconds: number) => { now += milliseconds; },
    timerState: () => ({ installations, cancellations, active: tick !== null }),
    tick: async () => { assert.ok(tick, "usage timer is active"); await tick(); },
    saved: async (): Promise<LinearUsageHistory> => JSON.parse(await readFile(path, "utf8")),
  };
}

test("answered requests, estimates, limits and refusals are attributed to each caller and pool", async (t) => {
  const f = await fixture(t);
  await f.usage.start();
  f.usage.begin("app", "dispatch poll", "dispatch poll").done(headers(3000, 300000, 150), false, 100);
  f.usage.begin("app", "plan decision", "plan decision").done(headers(2000, 250000, null), true, 180);
  f.usage.begin("key", "op:AssignedIssues", "AssignedIssues").done(headers(3200, 350000, 25), false, 100);
  f.usage.refused("app", "dispatch poll", "background");
  f.usage.refused("app", "agent comment", "interactive");
  await f.usage.stop();
  const history = await f.saved();
  assert.equal(history.version, 1);
  const app = history.hours[START_ISO].app!;
  assert.equal(app.requests, 2);
  assert.equal(app.points, 330);
  assert.equal(app.estimatedPoints, 180);
  assert.equal(app.limited, 1);
  assert.deepEqual(app.limits, { requests: 3600, points: 360000 });
  assert.deepEqual(app.minRemaining, { requests: 2000 / 3600, points: 250000 / 360000 });
  assert.deepEqual(app.refused, { background: 1, interactive: 1 });
  assert.deepEqual(app.callers, {
    "dispatch poll": { requests: 1, points: 150, refused: 1 },
    "plan decision": { requests: 1, points: 180, refused: 0 },
    "agent comment": { requests: 0, points: 0, refused: 1 },
  });
  assert.deepEqual(history.hours[START_ISO].key!.callers, {
    "op:AssignedIssues": { requests: 1, points: 25, refused: 0 },
  });
  assert.deepEqual(f.usage.summary().map(({ pool, callers }) => ({ pool, callers })), [
    { pool: "app", callers: [
      { caller: "plan decision", requests: 1, points: 180 },
      { caller: "dispatch poll", requests: 1, points: 150 },
      { caller: "agent comment", requests: 0, points: 0 },
    ] },
    { pool: "key", callers: [{ caller: "op:AssignedIssues", requests: 1, points: 25 }] },
  ]);
});

test("network failures do not count as answers and completion is idempotent", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "read", "read").done(headers(1000, 100000), false, 100);
  f.advance(1000);
  const failed = f.usage.begin("app", "failed read", "failed read");
  failed.done(null, false, 100);
  failed.done(headers(900, 90000), false, 100);
  f.advance(1000);
  const answered = f.usage.begin("app", "read", "read");
  answered.done(headers(800, 80000), false, 100);
  answered.done(headers(700, 70000), true, 100);
  await f.usage.stop();
  const bucket = (await f.saved()).hours[START_ISO].app!;
  assert.equal(bucket.requests, 2);
  assert.equal(bucket.points, 200);
  assert.equal(bucket.limited, 0);
  assert.equal(bucket.callers["failed read"], undefined);
  assert.deepEqual(bucket.outside, {
    requests: { spent: 0, observedMs: 0 }, points: { spent: 0, observedMs: 0 },
  });
});

test("outside spend is signed in history while display estimates never go below zero", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "poll", "poll").done(headers(1000, 100000), false, 100);
  f.advance(1000);
  f.usage.begin("app", "poll", "poll").done(headers(995, 99000), false, 100);
  assert.deepEqual(f.usage.summary()[0].outside, {
    requests: { spent: 5, observedShare: 1000 / HOUR },
    points: { spent: 1000, observedShare: 1000 / HOUR },
  });
  f.advance(1000);
  f.usage.begin("app", "poll", "poll").done(headers(1003, 100500), false, 100);
  await f.usage.stop();
  assert.deepEqual((await f.saved()).hours[START_ISO].app!.outside, {
    requests: { spent: -3, observedMs: 2000 }, points: { spent: -500, observedMs: 2000 },
  });
  assert.deepEqual(f.usage.summary()[0].outside, {
    requests: { spent: 0, observedShare: 2000 / HOUR }, points: { spent: 0, observedShare: 2000 / HOUR },
  });
});

test("a refilled full bucket subtracts only the request itself without inventing outside spend", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "poll", "poll").done(headers(3599, 359900), false, 100);
  f.advance(MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(3599, 359900), false, 100);
  await f.usage.stop();
  assert.deepEqual((await f.saved()).hours[START_ISO].app!.outside, {
    requests: { spent: 0, observedMs: MINUTE }, points: { spent: 0, observedMs: MINUTE },
  });
});

test("responses at full capacity do not turn refilled own costs into negative outside spend", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "poll", "poll").done(headers(3600, 360000), false, 100);
  f.advance(MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(3600, 360000), false, 100);
  await f.usage.stop();
  assert.deepEqual((await f.saved()).hours[START_ISO].app!.outside, {
    requests: { spent: 0, observedMs: MINUTE }, points: { spent: 0, observedMs: MINUTE },
  });
});

test("a ten-minute sample gap is unobserved and the next short interval establishes fresh coverage", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  f.advance(10 * MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(2000, 200000), false, 100);
  assert.equal(f.usage.summary()[0].outside.requests.observedShare, 0);
  assert.equal(f.usage.summary()[0].outside.points.observedShare, 0);
  f.advance(1000);
  f.usage.begin("app", "poll", "poll").done(headers(2000, 200000), false, 100);
  await f.usage.stop();
  assert.deepEqual((await f.saved()).hours[START_ISO].app!.outside, {
    requests: { spent: 0, observedMs: 1000 }, points: { spent: 0, observedMs: 1000 },
  });
});

for (const answerFirst of ["first", "second"] as const) {
  test(`overlap invalidates both own samples when ${answerFirst} request answers first`, async (t) => {
    const f = await fixture(t);
    f.usage.begin("app", "prime", "prime").done(headers(3000, 300000), false, 100);
    f.advance(1000);
    const first = f.usage.begin("app", "first", "first");
    f.advance(500);
    const second = f.usage.begin("app", "second", "second");
    f.advance(500);
    (answerFirst === "first" ? first : second).done(headers(2500, 250000), false, 100);
    assert.equal(f.usage.summary()[0].outside.requests.observedShare, 0, "the first answer was invalidated too");
    f.advance(1000);
    (answerFirst === "first" ? second : first).done(headers(2000, 200000), false, 100);
    f.advance(1000);
    f.usage.begin("app", "after overlap", "after overlap").done(headers(1500, 150000), false, 100);
    await f.usage.stop();
    const bucket = (await f.saved()).hours[START_ISO].app!;
    assert.equal(bucket.requests, 4);
    assert.equal(bucket.points, 400);
    assert.deepEqual(bucket.outside, {
      requests: { spent: 0, observedMs: 0 }, points: { spent: 0, observedMs: 0 },
    });
    f.advance(1000);
    f.usage.begin("app", "fresh", "fresh").done(headers(1500, 150000), false, 100);
    assert.equal(f.usage.summary()[0].outside.requests.observedShare, 1000 / HOUR);
    assert.equal(f.usage.summary()[0].outside.points.observedShare, 1000 / HOUR);
  });
}

test("requests in separate credential pools do not invalidate each other's samples", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "app prime", "app prime").done(headers(3000, 300000), false, 100);
  f.usage.begin("key", "key prime", "key prime").done(headers(2000, 200000), false, 100);
  f.advance(1000);
  const app = f.usage.begin("app", "app poll", "app poll");
  const key = f.usage.begin("key", "key poll", "key poll");
  app.done(headers(3000, 300000), false, 100);
  key.done(headers(2000, 200000), false, 100);
  assert.ok(f.usage.summary().every((summary) => summary.outside.points.observedShare === 1000 / HOUR));
});

test("missing dimension headers break only that dimension's observation interval", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  f.advance(MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(3000, null), false, 100);
  assert.equal(f.usage.summary()[0].outside.requests.observedShare, MINUTE / HOUR);
  assert.equal(f.usage.summary()[0].outside.points.observedShare, 0);
  f.advance(MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(3000, 100000), false, 100);
  assert.equal(f.usage.summary()[0].outside.points.observedShare, 0, "no interval bridges the missing answer");
  f.advance(MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(3000, 100000), false, 100);
  await f.usage.stop();
  const bucket = (await f.saved()).hours[START_ISO].app!;
  assert.equal(bucket.outside.requests.observedMs, 3 * MINUTE);
  assert.equal(bucket.outside.points.observedMs, MINUTE);
  assert.equal(bucket.outside.points.spent, 5900);
  assert.deepEqual(bucket.limits, { requests: 3600, points: 360000 });
});

test("cross-hour outside steps and coverage retain only the later hour's portion", async (t) => {
  const f = await fixture(t, START - 30_000);
  f.usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  f.advance(MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(2900, 290000), false, 100);
  await f.usage.stop();
  const history = await f.saved();
  assert.deepEqual(history.hours["2026-10-07T11:00:00.000Z"].app!.outside, {
    requests: { spent: 0, observedMs: 0 }, points: { spent: 0, observedMs: 0 },
  });
  assert.deepEqual(history.hours[START_ISO].app!.outside, {
    requests: { spent: 79.5, observedMs: 30_000 }, points: { spent: 7950, observedMs: 30_000 },
  });
});

test("observed coverage never exceeds an hour even when samples span both hour boundaries", async (t) => {
  const f = await fixture(t, START - MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  for (let minute = 1; minute <= 61; minute++) {
    f.advance(MINUTE);
    f.usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  }
  await f.usage.stop();
  const history = await f.saved();
  const completed = history.hours[START_ISO].app!;
  assert.equal(completed.outside.requests.observedMs, 59 * MINUTE);
  assert.equal(completed.outside.points.observedMs, 59 * MINUTE);
  const next = history.hours["2026-10-07T13:00:00.000Z"].app!;
  assert.equal(next.outside.requests.observedMs, 0, "an answer on the boundary contributes no earlier-hour interval");
  for (const pools of Object.values(history.hours)) {
    for (const bucket of Object.values(pools)) {
      assert.ok(bucket.outside.requests.observedMs <= HOUR);
      assert.ok(bucket.outside.points.observedMs <= HOUR);
    }
  }
});

test("overlapping blocks form an elapsed union split across hours and do not survive as predicted future time", async (t) => {
  const f = await fixture(t, START - MINUTE);
  await f.usage.start();
  f.usage.block("app", START + 2 * MINUTE);
  f.advance(30_000);
  f.usage.block("app", START + 3 * MINUTE);
  f.usage.block("app", START + MINUTE);
  f.set(START + 3 * MINUTE);
  await f.tick();
  await f.tick();
  const history = await f.saved();
  assert.equal(history.hours["2026-10-07T11:00:00.000Z"].app!.blockedMs, MINUTE);
  assert.equal(history.hours[START_ISO].app!.blockedMs, 3 * MINUTE);
  assert.equal(history.hours[START_ISO].key!.blockedMs, 0);
  f.usage.block("app", START + 10 * MINUTE);
  f.advance(MINUTE);
  await f.usage.stop();
  const reopened = f.create();
  await reopened.start();
  f.advance(MINUTE);
  await f.tick();
  assert.equal((await f.saved()).hours[START_ISO].app!.blockedMs, 4 * MINUTE,
    "a restarted admission budget is unknown, not still blocked by the previous process");
});

test("the minute timer rolls both pools into the next UTC hour without traffic", async (t) => {
  const f = await fixture(t, START + HOUR - MINUTE);
  await f.usage.start();
  await f.tick();
  f.advance(MINUTE);
  await f.tick();
  const history = await f.saved();
  const next = "2026-10-07T13:00:00.000Z";
  assert.deepEqual(Object.keys(history.hours).sort(), [START_ISO, next]);
  assert.equal(history.hours[next].app!.requests, 0);
  assert.equal(history.hours[next].key!.requests, 0);
  assert.ok(f.usage.summary().every((summary) => summary.start === next && summary.callers.length === 0));
  await f.usage.stop();
  assert.equal(f.timerState().active, false);
});

test("reload preserves hourly history and merges answers arriving before asynchronous startup completes", async (t) => {
  const f = await fixture(t);
  f.usage.begin("app", "poll", "poll").done(headers(3000, 300000, 200), false, 100);
  f.usage.refused("app", "poll", "background");
  await f.usage.stop();
  const reopened = f.create();
  const starting = reopened.start();
  reopened.begin("app", "poll", "poll").done(headers(2000, 200000, 300), false, 100);
  reopened.begin("key", "decision", "decision").done(headers(3100, 310000, null), false, 160);
  reopened.refused("app", "poll", "interactive");
  await starting;
  await reopened.stop();
  const history = await f.saved();
  assert.equal(history.hours[START_ISO].app!.requests, 2);
  assert.equal(history.hours[START_ISO].app!.points, 500);
  assert.deepEqual(history.hours[START_ISO].app!.refused, { background: 1, interactive: 1 });
  assert.deepEqual(history.hours[START_ISO].app!.callers.poll, { requests: 2, points: 500, refused: 2 });
  assert.equal(history.hours[START_ISO].key!.estimatedPoints, 160);
  assert.equal(history.hours[START_ISO].app!.minRemaining.points, 200000 / 360000);
  assert.deepEqual(history.hours[START_ISO].app!.outside, {
    requests: { spent: 0, observedMs: 0 }, points: { spent: 0, observedMs: 0 },
  });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.directory), ["linear-usage.json"], "atomic saves leave no temporary files");
});

for (const corrupt of ["{not json", JSON.stringify({ version: 1, hours: { [START_ISO]: { app: {} } } })]) {
  test("a corrupt usage file logs once and starts with empty accounting", async (t) => {
    const f = await fixture(t);
    await writeFile(f.path, corrupt);
    await f.usage.start();
    await f.usage.start();
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /load failed; starting empty/);
    assert.ok(f.usage.summary().every((summary) => summary.callers.length === 0));
    f.usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
    await f.tick();
    assert.equal((await f.saved()).hours[START_ISO].app!.requests, 1);
    assert.equal(f.logs.length, 1);
  });
}

test("failed writes log once, retain live counting and recover when the path becomes writable", async (t) => {
  const f = await fixture(t);
  const obstruction = join(f.directory, "not-a-directory");
  const timer: { tick: () => Promise<void> } = { tick: async () => { assert.fail("usage timer has not started"); } };
  const usage = new LinearUsage(() => START, {
    path: join(obstruction, "linear-usage.json"),
    timer: (work) => { timer.tick = work; return () => {}; },
    log: (message) => { f.logs.push(message); },
  });
  await usage.start();
  await writeFile(obstruction, "blocking file");
  usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  await timer.tick();
  usage.begin("app", "poll", "poll").done(headers(2900, 290000), false, 100);
  await timer.tick();
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /write failed/);
  assert.equal(usage.summary()[0].callers[0].requests, 2);
  await rm(obstruction);
  await timer.tick();
  const history: LinearUsageHistory = JSON.parse(await readFile(join(obstruction, "linear-usage.json"), "utf8"));
  assert.equal(history.hours[START_ISO].app!.requests, 2);
  assert.equal(f.logs.length, 1);
  await usage.stop();
});

test("unload persists admitted responses and their limit block after both pools settle", async (t) => {
  const f = await fixture(t);
  await f.usage.start();
  const budget = new RateBudget(() => START, f.usage);
  const app = budget.acquire("app", "owner", "plan decision", "decision");
  const key = budget.acquire("key", "owner", "status change", "state");
  let stopped = false;
  const stopping = f.usage.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "shutdown waits for admitted responses");
  app.done(headers(0, 0, 150), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "the other pool still has an admitted request");
  f.advance(30_000);
  key.done(headers(3000, 300000, 25), false);
  await stopping;
  const saved = await f.saved();
  assert.equal(saved.hours[START_ISO].app!.points, 150);
  assert.equal(saved.hours[START_ISO].app!.limited, 1);
  assert.equal(saved.hours[START_ISO].app!.blockedMs, 30_000);
  assert.equal(saved.hours[START_ISO].key!.points, 25);
  assert.equal(saved.hours[START_ISO].app!.callers["plan decision"].requests, 1);
  assert.equal(saved.hours[START_ISO].key!.callers["status change"].requests, 1);
  assert.equal(f.timerState().active, false);
});

test("hours older than eight days are removed while an exactly eight-day-old hour is retained", async (t) => {
  const f = await fixture(t);
  await f.usage.start();
  f.usage.begin("app", "old", "old").done(headers(3000, 300000), false, 100);
  f.advance(24 * HOUR);
  f.usage.begin("app", "retained", "retained").done(headers(3000, 300000), false, 100);
  f.set(START + 9 * 24 * HOUR);
  await f.tick();
  const history = await f.saved();
  assert.equal(history.hours[START_ISO], undefined);
  assert.equal(history.hours["2026-10-08T12:00:00.000Z"].app!.requests, 1);
  assert.ok(history.hours["2026-10-16T12:00:00.000Z"]);
  await f.usage.stop();
  const reopened = f.create();
  f.advance(24 * HOUR);
  await reopened.start();
  await reopened.stop();
  assert.equal((await f.saved()).hours["2026-10-08T12:00:00.000Z"], undefined, "load applies the same retention rule");
});

test("summary keeps only the top ten callers and treats object-prototype names as ordinary callers", async (t) => {
  const f = await fixture(t);
  for (let index = 1; index <= 12; index++) {
    f.usage.begin("app", `caller ${index}`, `caller ${index}`).done(headers(3000, 300000, index * 100), false, 100);
  }
  f.usage.begin("key", "constructor", "constructor").done(headers(3000, 300000), false, 100);
  f.usage.begin("key", "__proto__", "__proto__").done(headers(3000, 300000), false, 100);
  const summaries = f.usage.summary();
  assert.equal(summaries[0].callers.length, 10);
  assert.equal(summaries[0].callers[0].caller, "caller 12");
  assert.equal(summaries[0].callers[9].caller, "caller 3");
  assert.deepEqual(summaries[1].callers.map((caller) => caller.caller).sort(), ["__proto__", "constructor"]);
  await f.usage.stop();
  const reopened = f.create();
  await reopened.start();
  reopened.refused("key", "__proto__", "background");
  await reopened.stop();
  assert.deepEqual((await f.saved()).hours[START_ISO].key!.callers.__proto__, { requests: 1, points: 100, refused: 1 });
});

test("stop during initial load cancels startup and later starts do not duplicate accounting or timers", async (t) => {
  const f = await fixture(t);
  const starting = f.usage.start();
  const stopping = f.usage.stop();
  f.usage.begin("app", "early answer", "early answer").done(headers(3000, 300000), false, 100);
  await Promise.all([starting, stopping]);
  assert.deepEqual(f.timerState(), { installations: 0, cancellations: 0, active: false });
  await f.usage.start();
  await f.usage.start();
  assert.deepEqual(f.timerState(), { installations: 1, cancellations: 0, active: true });
  await f.usage.stop();
  await f.usage.start();
  assert.deepEqual(f.timerState(), { installations: 2, cancellations: 1, active: true });
  await f.usage.stop();
  assert.equal((await f.saved()).hours[START_ISO].app!.requests, 1);
});

test("concurrent timer saves and unload serialize without losing the latest answers", async (t) => {
  const f = await fixture(t);
  await f.usage.start();
  f.usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  const firstSave = f.tick();
  f.advance(MINUTE);
  f.usage.begin("app", "poll", "poll").done(headers(2900, 290000), false, 100);
  const secondSave = f.tick();
  f.usage.begin("app", "decision", "decision").done(headers(2800, 280000, 250), false, 100);
  const unloading = f.usage.stop();
  await Promise.all([firstSave, secondSave, unloading]);
  const bucket = (await f.saved()).hours[START_ISO].app!;
  assert.equal(bucket.requests, 3);
  assert.equal(bucket.points, 450);
  assert.equal(bucket.callers.decision.requests, 1);
  assert.deepEqual(await readdir(f.directory), ["linear-usage.json"]);
});

test("the default path is resolved on startup rather than while importing or constructing usage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "linear-usage-home-"));
  const previousHome = process.env.PASEO_HOME;
  const usage = new LinearUsage(() => START, { timer: () => () => {}, log: () => {} });
  process.env.PASEO_HOME = directory;
  t.after(async () => {
    await usage.stop();
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  });
  await usage.start();
  usage.begin("app", "poll", "poll").done(headers(3000, 300000), false, 100);
  await usage.stop();
  const history: LinearUsageHistory = JSON.parse(await readFile(join(directory, "linear-tickets", "linear-usage.json"), "utf8"));
  assert.equal(history.hours[START_ISO].app!.requests, 1);
});

const metered = (points: string) => new Headers({ "x-complexity": points });

test("overlapping callers and nested work retain their own attribution across awaits", async () => {
  const usage = new LinearUsage(() => 0);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await Promise.all([
    asCaller("slow", async () => {
      await wait;
      usage.begin("app", currentCaller("ticket"), "ticket").done(metered("498"), false, 100);
      await asCaller("nested", async () => {
        await Promise.resolve();
        usage.begin("app", currentCaller("update"), "update").done(metered("7"), false, 100);
      });
      usage.begin("app", currentCaller("ticket"), "ticket").done(metered("502"), false, 100);
    }),
    asCaller("fast", async () => {
      await Promise.resolve();
      usage.begin("key", currentCaller("ticket"), "ticket").done(metered("1004"), false, 100);
      release();
    }),
  ]);
  assert.deepEqual(usage.snapshot().rows, [
    { pool: "key", caller: "fast", operation: "ticket", requests: 1, points: 1004, unmetered: 0 },
    { pool: "app", caller: "slow", operation: "ticket", requests: 2, points: 1000, unmetered: 0 },
    { pool: "app", caller: "nested", operation: "update", requests: 1, points: 7, unmetered: 0 },
  ]);
});

test("the last 60 minute buckets expire even when no further request arrives", () => {
  let now = 30_000;
  const usage = new LinearUsage(() => now);
  usage.begin("app", "other", "first").done(metered("90"), false, 100);
  now = MINUTE;
  usage.begin("app", "other", "second").done(metered("7"), false, 100);
  now = 60 * MINUTE;
  assert.deepEqual(usage.snapshot().rows.map((row) => [row.operation, row.points]), [["second", 7]]);
  assert.equal(usage.snapshot().since, new Date(MINUTE).toISOString());
  now = 61 * MINUTE;
  assert.deepEqual(usage.snapshot().rows, []);
  assert.equal(usage.snapshot().pools[0].requests, 0);
});

test("missing, invalid and failed measurements are unknown, while zero complexity is metered", () => {
  const usage = new LinearUsage(() => 0);
  for (const value of [null, new Headers(), metered(""), metered("garbage"), metered("-1"), metered("Infinity"), metered("0"), metered("12")]) {
    usage.begin("app", "other", "anonymous").done(value, false, 100);
  }
  assert.deepEqual(usage.snapshot().rows, [{ pool: "app", caller: "other", operation: "anonymous", requests: 8, points: 12, unmetered: 6 }]);
});

test("each credential reports its last observed budget, never extrapolated own usage", () => {
  let now = 0;
  const usage = new LinearUsage(() => now);
  usage.begin("app", "other", "sample").done(new Headers({
    "x-complexity": "2", "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "123",
    "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": "456",
  }), false, 100);
  now = MINUTE;
  usage.begin("key", "other", "sample").done(metered("7"), false, 100);
  now = 2 * MINUTE;
  usage.begin("app", "other", "sample").done(null, false, 100);
  assert.deepEqual(usage.snapshot().pools[0], {
    pool: "app", observedAt: new Date(0).toISOString(), requestsRemaining: 123, requestsLimit: 5000,
    pointsRemaining: 456, pointsLimit: 2000000, requests: 2, points: 2, unmetered: 1,
    sources: { plugin: { requests: 2, points: 2, unmetered: 1 }, mcp: { requests: 0, points: 0, unmetered: 0 } },
  });
  assert.equal(usage.snapshot().pools[1].points, 7);
  assert.equal(usage.snapshot().pools[1].pointsRemaining, null);
  assert.equal(usage.snapshot().since, new Date(0).toISOString());
});

test("agent MCP traffic is reported as its own source, summed over every caller beyond the top ten", () => {
  const usage = new LinearUsage(() => START);
  for (let index = 0; index < 11; index++) usage.begin("app", `plugin-${index}`, "sample").done(metered("100"), false, 100);
  usage.begin("app", "mcp:get_issue", "issue").done(metered("3"), false, 100);
  usage.begin("app", "mcp:add_comment", "commentCreate").done(null, false, 100);
  const pool = usage.snapshot().pools[0];
  assert.deepEqual(pool.sources, { plugin: { requests: 11, points: 1100, unmetered: 0 }, mcp: { requests: 2, points: 3, unmetered: 1 } });
  assert.equal(pool.sources.plugin.requests + pool.sources.mcp.requests, pool.requests);
  const hour = usage.summary().find((entry) => entry.pool === "app")!;
  assert.equal(hour.callers.length, 10);
  assert.ok(hour.callers.every((caller) => !caller.caller.startsWith("mcp:")), "the cheap MCP callers fall outside the top ten");
  // Hourly history keeps its existing rule: a send without any answer has no measured cost.
  assert.deepEqual(hour.sources, { plugin: { requests: 11, points: 1100 }, mcp: { requests: 1, points: 3 } });
  assert.match(usageLines(usage.snapshot())[0], /plugin 1100\/11, agent MCP 3\/2;/);
});

test("real transport meters refused responses once, excludes local pauses, and counts failed sends", async (t) => {
  const usage = new LinearUsage();
  const budget = new RateBudget(() => Date.now(), usage);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ errors: [{ extensions: { code: "RATELIMITED" } }] }), {
    status: 400, headers: { "x-complexity": "498" },
  }));
  await asCaller("transport-counter-test", async () => {
    await assert.rejects(postGraphQL("Bearer test", "query sample { viewer { id } }", {}, budget), RateLimitedError);
    await assert.rejects(postGraphQL("Bearer test", "query sample { viewer { id } }", {}, budget), RateLimitedError);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("network unavailable"); });
    await assert.rejects(postGraphQL("key", "query sample { viewer { id } }", {}, new RateBudget(() => Date.now(), usage)), /Could not reach/);
  });
  assert.deepEqual(usage.snapshot().rows.filter((row) => row.caller === "transport-counter-test"), [
    { pool: "app", caller: "transport-counter-test", operation: "sample", requests: 1, points: 498, unmetered: 0 },
    { pool: "key", caller: "transport-counter-test", operation: "sample", requests: 1, points: 0, unmetered: 1 },
  ]);
});
