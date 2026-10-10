// Tests for the GitHub usage report (scripts/github-usage-report.mjs). Fixture records are built
// here and written as JSONL into a fresh temporary directory per test, removed after.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReport, formatReport, parseArgs, readGuard, readInputs } from "./github-usage-report.mjs";

const FROM = "2026-10-10T10:00:00.000Z";
const TO = "2026-10-10T12:00:00.000Z";
const RESET_12 = Date.parse("2026-10-10T12:00:00.000Z") / 1000;

let nextCall = 0;

function meter(overrides = {}) {
  return {
    at: "2026-10-10T10:00:00.000Z",
    host: "server087",
    call: `call-${++nextCall}`,
    caller: "pr-watch",
    run: null,
    command: "api",
    method: "GET",
    write: false,
    responses: [],
    pages: 1,
    account: "bot",
    basis: "guard rule",
    exit: 0,
    ...overrides,
  };
}

function response(overrides = {}) {
  return { status: 200, class: "charged", resource: "core", used: 1, remaining: 4_999, limit: 5_000, reset: RESET_12, ...overrides };
}

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "github-usage-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeLines(t, lines, name = "2026-10-10.jsonl") {
  const dir = temporary(t);
  const path = join(dir, name);
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return { dir, path };
}

function reportOf(t, { meter: meterRecords = [], runs = [], router = [], guardFiles = [], guardHost = "server087", from, to }) {
  const { dir } = writeLines(t, [...meterRecords, ...runs, ...router]);
  for (const [name, size] of guardFiles) writeFileSync(join(dir, name), "x".repeat(size));
  const input = readInputs([dir]);
  return buildReport({ ...input, guard: readGuard(dir), guardHost, from, to });
}

test("parseArgs reads repeatable --input, the range flags and --json", () => {
  assert.deepEqual(parseArgs(["--from", "2026-10-10T00:00:00.000Z", "--input", "/a", "--input=/b", "--guard", "/g", "--guard-host", "server087", "--json"]), {
    from: "2026-10-10T00:00:00.000Z",
    to: null,
    inputs: ["/a", "/b"],
    guard: "/g",
    guardHost: "server087",
    json: true,
  });
  assert.throws(() => parseArgs(["--wat"]), /unknown argument/);
});

test("a record at 10:59:59 and one at 11:00:00 land in different hours", (t) => {
  const report = reportOf(t, {
    meter: [
      meter({ at: "2026-10-10T10:59:59.000Z", responses: [response()] }),
      meter({ at: "2026-10-10T11:00:00.000Z", responses: [response()] }),
    ],
    from: FROM,
    to: TO,
  });
  assert.deepEqual(report.hours.map((row) => row.hour), ["2026-10-10T10", "2026-10-10T11"]);
  assert.deepEqual(report.hours.map((row) => row.charged), [1, 1]);
});

test("a window whose reset crosses two calendar hours is one window row", (t) => {
  const reset = Date.parse("2026-10-10T12:30:00.000Z") / 1000;
  const report = reportOf(t, {
    meter: [
      meter({ at: "2026-10-10T11:50:00.000Z", responses: [response({ used: 10, reset })] }),
      meter({ at: "2026-10-10T12:10:00.000Z", responses: [response({ used: 22, reset })] }),
    ],
    from: "2026-10-10T11:00:00.000Z",
    to: "2026-10-10T13:00:00.000Z",
  });
  assert.deepEqual(report.hours.map((row) => row.hour), ["2026-10-10T11", "2026-10-10T12"]);
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0].reset, reset);
  assert.equal(report.windows[0].maxUsed, 22);
  assert.equal(report.windows[0].status, "ok");
  assert.equal(report.windows[0].unattributed, 20);
});

test("a 304 counts as free", (t) => {
  const report = reportOf(t, { meter: [meter({ responses: [response({ status: 304, class: "free", used: 42, remaining: 4_958 })] })], from: FROM, to: TO });
  assert.equal(report.hours[0].free, 1);
  assert.equal(report.hours[0].charged, 0);
});

test("a refused 403 with remaining 0 counts as refused, not charged", (t) => {
  const report = reportOf(t, { meter: [meter({ responses: [response({ status: 403, class: "refused", used: 5_000, remaining: 0 })] })], from: FROM, to: TO });
  assert.equal(report.hours[0].refused, 1);
  assert.equal(report.hours[0].charged, 0);
});

test("an uncertain and a cached response are counted in their own columns, cached printed as suspected cache", (t) => {
  const report = reportOf(t, {
    meter: [meter({ responses: [response({ class: "uncertain", used: 3 }), response({ class: "cached", used: 4 })] })],
    from: FROM,
    to: TO,
  });
  const row = report.hours[0];
  assert.equal(row.charged, 0);
  assert.equal(row.uncertain, 1);
  assert.equal(row.cached, 1);
  const text = formatReport(report);
  assert.match(text, /suspected cache/);
  const line = text.split("\n").find((candidate) => candidate.startsWith("2026-10-10T10 "));
  assert.deepEqual(line.trim().split(/\s+/).slice(4), ["0", "0", "0", "1", "1", "0", "0", "0"]);
});

test("a record with pages unknown counts as one invocation and adds no response", (t) => {
  const report = reportOf(t, { meter: [meter({ command: "pr view", responses: [response()], pages: "unknown" })], from: FROM, to: TO });
  assert.equal(report.hours[0].invocations, 1);
  assert.equal(report.hours[0].charged, 0);
});

test("two graphql responses from two callers in one ok window with maxUsed 10 estimate 5.0 each", (t) => {
  const report = reportOf(t, {
    meter: [
      meter({ at: "2026-10-10T11:10:00.000Z", caller: "pr-watch", command: "api graphql", responses: [response({ class: "charged", resource: "graphql", used: 10 })] }),
      meter({ at: "2026-10-10T11:20:00.000Z", caller: "board", command: "api graphql", responses: [response({ class: "uncertain", resource: "graphql", used: 8 })] }),
    ],
    from: "2026-10-10T10:30:00.000Z",
    to: "2026-10-10T12:30:00.000Z",
  });
  assert.deepEqual(report.windows.map((window) => [window.resource, window.maxUsed, window.status]), [["graphql", 10, "ok"]]);
  assert.deepEqual(
    report.graphqlEstimate[0].entries.map((entry) => [entry.caller, entry.requests, entry.points]),
    [
      ["board", 1, 5],
      ["pr-watch", 1, 5],
    ],
  );
  const text = formatReport(report);
  assert.match(text, /estimate assuming equal cost per request and complete coverage/);
  assert.match(text, /5\.0/);
  assert.doesNotMatch(text, /measured/);
});

test("two hosts in one window with used 40 and 55 take maxUsed 55, not 95", (t) => {
  const report = reportOf(t, {
    meter: [
      meter({ at: "2026-10-10T11:00:00.000Z", host: "laptop", responses: [response({ used: 40, reset: RESET_12 })] }),
      meter({ at: "2026-10-10T11:00:00.000Z", host: "server087", responses: [response({ used: 55, reset: RESET_12 })] }),
    ],
    from: "2026-10-10T10:30:00.000Z",
    to: "2026-10-10T12:30:00.000Z",
  });
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0].maxUsed, 55);
});

test("a window starting before from is incomplete", (t) => {
  const report = reportOf(t, {
    meter: [meter({ at: "2026-10-10T12:50:00.000Z", responses: [response({ used: 5, reset: RESET_12 })] })],
    from: "2026-10-10T12:30:00.000Z",
    to: "2026-10-10T14:00:00.000Z",
  });
  assert.equal(report.windows[0].status, "incomplete");
  assert.equal(report.windows[0].unattributed, null);
  const text = formatReport(report);
  const windows = text.slice(text.indexOf("GitHub rate-limit windows"), text.indexOf("GraphQL points per caller"));
  assert.match(windows, /incomplete/);
});

test("maxUsed 3 against 5 charged responses is inconsistent", (t) => {
  const report = reportOf(t, {
    meter: [meter({ at: "2026-10-10T11:30:00.000Z", pages: 5, responses: [1, 2, 3, 4, 5].map(() => response({ used: 3 })) })],
    from: "2026-10-10T10:30:00.000Z",
    to: "2026-10-10T12:30:00.000Z",
  });
  assert.equal(report.windows[0].charged, 5);
  assert.equal(report.windows[0].maxUsed, 3);
  assert.equal(report.windows[0].status, "inconsistent");
  assert.equal(report.windows[0].unattributed, null);
  const text = formatReport(report);
  const windows = text.slice(text.indexOf("GitHub rate-limit windows"), text.indexOf("GraphQL points per caller"));
  assert.match(windows, /inconsistent/);
  assert.doesNotMatch(windows, /-2/);
});

test("router lines with an agent id show as agent sessions and are not added to the hours table", (t) => {
  const report = reportOf(t, {
    router: [{ at: "2026-10-10T10:30:00.000Z", agent: "agent-3hlf2x07", account: "owner", command: "gh", operation: "api repos", call: "router-call" }],
    from: FROM,
    to: TO,
  });
  assert.deepEqual(report.router.agentSessions, [{ hour: "2026-10-10T10", account: "owner", invocations: 1 }]);
  assert.deepEqual(report.hours, []);
});

test("daemon and plugin router lines are not agent sessions; unmatched ones are outside the meter", (t) => {
  const line = (overrides) => ({ at: "2026-10-10T10:05:00.000Z", agent: "daemon", account: "bot", command: "gh", operation: "api repos", ...overrides });
  const report = reportOf(t, {
    meter: [meter({ at: "2026-10-10T10:05:00.000Z", call: "shot" })],
    router: [line({ call: "shot" }), line({ agent: "plugin", call: "plugin-call" }), line({})],
    from: FROM,
    to: TO,
  });
  assert.deepEqual(report.router.agentSessions, []);
  assert.deepEqual(report.router.outsideMeter, [{ hour: "2026-10-10T10", account: "bot", invocations: 2 }]);
});

test("a meter record joined by call takes the router line's account", (t) => {
  const report = reportOf(t, {
    meter: [meter({ basis: "router", account: "unknown", call: "joined" })],
    router: [{ at: "2026-10-10T10:00:00.000Z", agent: "daemon", account: "owner", command: "gh", operation: "api repos", call: "joined" }],
    from: FROM,
    to: TO,
  });
  assert.equal(report.hours[0].account, "owner");
  assert.deepEqual(report.router.outsideMeter, []);
});

test("a router-basis record without a matching router line stays unknown", (t) => {
  const report = reportOf(t, { meter: [meter({ basis: "router", account: "unknown", call: "lonely" })], from: FROM, to: TO });
  assert.equal(report.hours[0].account, "unknown");
});

test("two calls in the same second on different accounts keep their own accounts", (t) => {
  const at = "2026-10-10T10:00:00.000Z";
  const report = reportOf(t, {
    meter: [meter({ at, basis: "router", account: "unknown", call: "one" }), meter({ at, basis: "router", account: "unknown", call: "two" })],
    router: [
      { at, agent: "agent-a", account: "bot", command: "gh", operation: "api repos", call: "one" },
      { at, agent: "agent-b", account: "owner", command: "gh", operation: "api repos", call: "two" },
    ],
    from: FROM,
    to: TO,
  });
  assert.deepEqual(report.hours.map((row) => [row.account, row.host]), [
    ["bot", "server087"],
    ["owner", "server087"],
  ]);
});

test("a guard counter of 100 against 70 bot meter records in the hour shows 30 unattributed", (t) => {
  const report = reportOf(t, {
    meter: Array.from({ length: 70 }, () => meter({ at: "2026-10-10T10:15:00.000Z", host: "server087" })),
    guardFiles: [["bot.2026101010", 100]],
    guardHost: "server087",
    from: "2026-10-10T10:00:00.000Z",
    to: "2026-10-10T11:00:00.000Z",
  });
  assert.deepEqual(report.guard, [{ hour: "2026-10-10T10", counter: 100, meter: 70, unattributed: 30, status: "ok" }]);
});

test("a guard counter of 60 against 70 meter records marks the hour inconsistent", (t) => {
  const report = reportOf(t, {
    meter: Array.from({ length: 70 }, () => meter({ at: "2026-10-10T10:15:00.000Z", host: "server087" })),
    guardFiles: [["bot.2026101010", 60]],
    guardHost: "server087",
    from: "2026-10-10T10:00:00.000Z",
    to: "2026-10-10T11:00:00.000Z",
  });
  assert.equal(report.guard[0].status, "inconsistent");
  assert.equal(report.guard[0].unattributed, null);
});

test("a missing meter record of the hour shows as a gap in that hour's guard row", (t) => {
  const report = reportOf(t, {
    meter: [
      ...Array.from({ length: 69 }, () => meter({ at: "2026-10-10T10:15:00.000Z", host: "server087" })),
      meter({ at: "2026-10-10T09:59:00.000Z", host: "server087" }),
    ],
    guardFiles: [["bot.2026101010", 100]],
    guardHost: "server087",
    from: "2026-10-10T09:00:00.000Z",
    to: "2026-10-10T11:00:00.000Z",
  });
  assert.deepEqual(report.guard, [{ hour: "2026-10-10T10", counter: 100, meter: 69, unattributed: 31, status: "ok" }]);
});

test("the same file passed twice counts each record once", (t) => {
  const { path } = writeLines(t, [meter({ responses: [response()] })]);
  const twice = readInputs([path, path]);
  assert.equal(twice.meter.length, 1);
  const report = buildReport({ ...twice, guard: new Map(), guardHost: "server087", from: FROM, to: TO });
  assert.equal(report.hours.length, 1);
  assert.equal(report.hours[0].charged, 1);
});

test("a malformed line is skipped and counted", (t) => {
  const { path } = writeLines(t, [meter({ responses: [response()] }), "{not json", "{}"]);
  const input = readInputs([path]);
  assert.equal(input.skipped, 2);
  assert.equal(input.meter.length, 1);
});
