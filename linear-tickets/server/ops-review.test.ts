import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";
import { LinearService, type CreatedIssueRef, type IssueStatus, type OpsMarkerIssue } from "./linear";
import { analyse, berlinWeek, pidLock, readHistory, runCollect, runFile, sourceOf, type FileDeps, type OpsReader } from "./ops-review";
import { AppOnlyToken, AppWriter, type OpsWriter } from "./owner-decisions";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 2026-10-12 07:30 Berlin (05:30 UTC), ISO week 42: when the schedule runs.
const NOW = Date.parse("2026-10-12T05:30:00Z");
const SERVER = "server087";
const MAC = "mirko@mac";
const DRAFT = "pulls: draft, not published";
const WAITING = "agents: waits for your permission: OMP select";
const ERROR = "agents: in error: rate limit";
const PLANNER_SCHEDULED = "agents: usage-limit restart scheduled";
const PLANNER_CONFIRMED = "agents: usage-limit restart confirmed";
const at = (ms: number) => new Date(ms).toISOString();
const exec = promisify(execFile);
const UNITS: Record<string, boolean> = {
  repo: true, main: true, "main-hold": true, "main-security-scan": true, "core-web-bundle": true, queue: true, drops: true, pulls: true,
  agents: true, silent: true, locks: true, [`agents@${MAC}`]: true, [`silent@${MAC}`]: true,
};

// The digest's history as it would write it: hourly run lines and problems.
class Log {
  lines: string[] = [];
  private problems = 0;

  // Run lines at minute 5 of every hour of [from, to); `units` may change or drop (null) an hour's run.
  runs(from: number, to: number, units: (t: number) => Record<string, boolean | undefined> | null = () => ({})): this {
    for (let t = Math.floor(from / HOUR) * HOUR + 5 * 60_000; t < to; t += HOUR) {
      if (t < from) continue;
      const change = units(t);
      if (change === null) continue;
      const merged = { ...UNITS, ...change };
      const hosts = [merged.agents ? SERVER : null, merged[`agents@${MAC}`] ? MAC : null].filter((host): host is string => host !== null);
      this.lines.push(JSON.stringify({ t: at(t), event: "run", host: SERVER, units: merged, hosts, items: 0 }));
    }
    return this;
  }

  problem(kind: string, opened: number, options: { cleared?: number | null; host?: string | null; owner?: boolean | null; auto?: boolean | null; attention?: boolean; key?: string; ticket?: string | null; open?: { t: number; owner?: boolean | null; auto?: boolean | null }[] } = {}): this {
    const section = kind.split(": ")[0];
    const group = section === "agents" ? (kind.startsWith("agents: waits") ? "waiting" : kind.startsWith("agents: in error") ? "error" : kind.startsWith("agents: usage-limit") ? "planners" : "silent") : null;
    const key = options.key ?? `${section}:${++this.problems}`;
    const base = {
      key, kind, unit: section, first: at(opened), attention: options.attention ?? true, section, group, ticket: options.ticket ?? "TUC-1",
      host: options.host === undefined ? (section === "agents" ? SERVER : null) : options.host, stale: false,
      owner: options.owner === undefined ? false : options.owner, auto: options.auto === undefined ? false : options.auto,
    };
    this.lines.push(JSON.stringify({ t: at(opened), event: "opened", ...base }));
    for (const line of options.open ?? []) this.lines.push(JSON.stringify({ t: at(line.t), event: "open", ...base, owner: line.owner ?? base.owner, auto: line.auto ?? base.auto }));
    const cleared = options.cleared === undefined ? opened + 2 * HOUR : options.cleared;
    if (cleared !== null) this.lines.push(JSON.stringify({ t: at(cleared), event: "cleared", ...base }));
    return this;
  }

  // `count` problems of one kind spread over the 7 days from `from`.
  burst(kind: string, from: number, count: number, options: Parameters<Log["problem"]>[2] = {}): this {
    for (let index = 0; index < count; index++) this.problem(kind, from + DAY / 2 + index * (6 * DAY / Math.max(count, 1)), options);
    return this;
  }

  async write(directory: string, name = "history.jsonl"): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), this.lines.length ? `${this.lines.join("\n")}\n` : "");
  }
}

// Every source read every hour of the last 40 days.
const healthy = () => new Log().runs(NOW - 40 * DAY, NOW);

function marker(number: number, overrides: Partial<OpsMarkerIssue> = {}): OpsMarkerIssue {
  return { id: `issue-${number}`, identifier: `TUC-${number}`, url: `https://linear.app/acme/issue/TUC-${number}`, createdAt: at(NOW - 30 * DAY), completedAt: null, creatorId: "app", statusType: "unstarted", description: "", comments: [], ...overrides };
}

// Linear as the review reads and writes it, the Paseo app's writes landing in the same tickets.
class World implements OpsReader {
  issues: OpsMarkerIssue[] = [];
  writes: string[] = [];
  // Called before a create lands; may throw (a timeout) or insert the ticket (a delayed create).
  beforeCreate: ((input: { id?: string }) => void) | null = null;
  async teamIdByKey() { return "team"; }
  async todoStateId() { return "state:todo"; }
  async projectIdByName(name: string) { return `project:${name}`; }
  async opsMarkerIssues() { return structuredClone(this.issues); }
  async issueById(id: string): Promise<CreatedIssueRef | null> {
    const found = this.issues.find((issue) => issue.id === id);
    return found ? { id: found.id, identifier: found.identifier, url: found.url, createdAt: found.createdAt } : null;
  }
  async issueStatuses(ids: string[]) {
    return new Map<string, IssueStatus>(this.issues.filter((issue) => ids.includes(issue.id)).map((issue) => [issue.id, { status: issue.statusType, statusType: issue.statusType, completedAt: issue.completedAt }]));
  }
  land(input: { id?: string; title: string; description: string; stateId: string; projectId: string }, createdAt = at(NOW)): OpsMarkerIssue {
    const number = 2000 + this.issues.length;
    const issue = marker(number, { id: input.id ?? `issue-${number}`, createdAt, description: input.description, statusType: input.stateId === "state:todo" ? "unstarted" : "backlog" });
    this.issues.push(issue);
    return issue;
  }
  writer: OpsWriter = {
    createIssue: async (input) => {
      this.beforeCreate?.(input);
      if (input.id && this.issues.some((issue) => issue.id === input.id)) throw new Error("Entity already exists");
      const issue = this.land(input);
      this.writes.push(`create ${input.projectId} ${input.stateId} "${input.title}"`);
      return { id: issue.id, identifier: issue.identifier, url: issue.url };
    },
    updateDescription: async (issueId) => { this.writes.push(`describe ${issueId}`); },
    comment: async (issueId, body) => {
      this.writes.push(`comment ${issueId} ${body.split("\n")[0]}`);
      this.issues.find((issue) => issue.id === issueId)!.comments.push({ body, createdAt: at(NOW) });
    },
    moveToState: async (issueId, stateId) => {
      this.writes.push(`move ${issueId} ${stateId}`);
      Object.assign(this.issues.find((issue) => issue.id === issueId)!, { statusType: "unstarted", completedAt: null });
    },
  };
}

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "paseo-ops-review-"));
}

function deps(directory: string, world: World, overrides: Partial<FileDeps> = {}): FileDeps {
  return { directory, linear: world, appViewerId: async () => "app", mergedPullRequests: async () => 20, teamKey: "TUC", now: NOW, writer: world.writer, dryRun: false, ...overrides };
}

async function analysis(log: Log, now = NOW, extraKinds: string[] = []) {
  const directory = await temporary();
  try {
    await log.write(directory);
    return analyse(await readHistory(directory, now - 35 * DAY, now), now, { this: 20, last: 10 }, extraKinds);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("the per-kind table counts problems that needed attention, with owner and automation evidence as known at each window's end", async () => {
  const lastWeek = NOW - 14 * DAY;
  const log = healthy()
    .burst(DRAFT, NOW - 7 * DAY, 4)
    .burst(DRAFT, lastWeek, 2)
    // Last week: owner unknown at first, true later in that week → yes; true, later false → stays yes.
    .problem(WAITING, lastWeek + DAY, { owner: null, open: [{ t: lastWeek + 2 * DAY, owner: true }], cleared: lastWeek + 3 * DAY })
    .problem(WAITING, lastWeek + DAY, { key: "w2", owner: true, open: [{ t: lastWeek + 2 * DAY, owner: false }], cleared: lastWeek + 3 * DAY })
    // Evidence seen only after last week ended never changes last week.
    .problem(WAITING, NOW - 8 * DAY, { key: "w3", owner: false, auto: false, open: [{ t: NOW - 3 * DAY, owner: true, auto: true }], cleared: NOW - 2 * DAY })
    // Normal flow (a queued PR) is kept but never a problem.
    .burst("queue: waiting in the merge queue", NOW - 7 * DAY, 5, { attention: false })
    // Still open at the end of the week.
    .problem(DRAFT, NOW - DAY, { cleared: null, key: "open-draft", open: [{ t: NOW - HOUR }] });
  const result = await analysis(log);
  const rows = new Map(result.rows.map((row) => [row.kind, row]));
  const draft = rows.get(DRAFT)!;
  assert.equal(draft.this.count, 5);
  assert.equal(draft.last.count, 2);
  assert.equal(draft.this.stillOpen, 1);
  assert.equal(draft.this.medianHours, 2);
  assert.equal(draft.this.p90Hours, 2);
  assert.deepEqual(draft.this.owner, { yes: 0, no: 5, unknown: 0 });
  assert.equal(draft.recurring, true);
  assert.ok(draft.all.hoursLost >= 4 * 2 + 23, `hours lost ${draft.all.hoursLost}`);
  const waiting = rows.get(WAITING)!;
  assert.equal(waiting.last.count, 3);
  assert.deepEqual(waiting.last.owner, { yes: 2, no: 1, unknown: 0 });
  assert.deepEqual(waiting.last.auto, { yes: 0, no: 3, unknown: 0 });
  assert.equal(waiting.this.count, 0);
  assert.equal(rows.has("queue: waiting in the merge queue"), false);
  assert.equal(draft.coverage.complete, true);
});

test("coverage: a window is complete only when the kind's own sources were read in 90 % of its hours", async () => {
  const week = NOW - 7 * DAY;
  // No digest run on two of the last seven days.
  let result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, (t) => (t > NOW - 3 * DAY && t < NOW - DAY ? null : {})).burst(DRAFT, week, 3));
  assert.equal(result.rows[0].coverage.complete, false);
  // The repository script failed: repository kinds lack data, agent kinds do not.
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, (t) => (t > NOW - 2 * DAY ? { repo: false } : {})).burst(DRAFT, week, 3).burst(ERROR, week, 3));
  let rows = new Map(result.rows.map((row) => [row.kind, row]));
  assert.equal(rows.get(DRAFT)!.coverage.complete, false);
  assert.equal(rows.get(ERROR)!.coverage.complete, true);
  // Failed pull request units without a repository failure: 2 of 30 is fine, 5 of 30 is not.
  const pulls = (failed: number) => Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`pulls/${index}`, index >= failed]));
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, () => pulls(2)).burst(DRAFT, week, 3));
  assert.equal(result.rows[0].coverage.complete, true);
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, () => pulls(5)).burst(DRAFT, week, 3));
  assert.equal(result.rows[0].coverage.complete, false);
  // The Mac asleep half of the time while server087 is read: its problems are left out, server087's count.
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, (t) => (Math.floor(t / HOUR) % 2 ? { [`agents@${MAC}`]: false, [`silent@${MAC}`]: false } : {}))
    .burst(ERROR, week, 3).burst(ERROR, week, 4, { host: MAC }));
  rows = new Map(result.rows.map((row) => [row.kind, row]));
  assert.equal(rows.get(ERROR)!.coverage.complete, true);
  assert.deepEqual(rows.get(ERROR)!.coverage.hosts, [SERVER]);
  assert.deepEqual(rows.get(ERROR)!.coverage.excluded, [MAC]);
  assert.equal(rows.get(ERROR)!.this.count, 3);
  assert.equal(rows.get(ERROR)!.all.count, 7);
  // Backfilled problems without run lines: not covered.
  result = await analysis(new Log().burst(DRAFT, week, 3));
  assert.equal(result.rows[0].coverage.complete, false);
  // More than 1 % malformed lines.
  const noisy = healthy().burst(DRAFT, week, 3);
  for (let index = 0; index < 40; index++) noisy.lines.splice(noisy.lines.length - 300 + index * 5, 0, `{"t": "2026-10-1${index}`);
  result = await analysis(noisy);
  assert.equal(result.rows[0].coverage.complete, false);
});

test("planner coverage: the planner source decides, not the agent listing", async () => {
  // No planner unit in the history: healthy agents are not enough data for planner kinds.
  let result = await analysis(healthy(), NOW, [PLANNER_SCHEDULED]);
  const row = result.rows.find((found) => found.kind === PLANNER_SCHEDULED)!;
  assert.deepEqual(row.source, { section: "agents", group: "planners" });
  assert.equal(row.coverage.complete, false);
  assert.equal(result.headline.this.complete, true, "missing planner evidence must not invalidate unrelated problem trends");
  // A failed planner unit is not covered even with every agent source healthy.
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, () => ({ planner_recovery: false })), NOW, [PLANNER_SCHEDULED]);
  assert.equal(result.rows.find((found) => found.kind === PLANNER_SCHEDULED)!.coverage.complete, false);
  // The planner file read covers its kinds although the agent listing failed.
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, () => ({ agents: false, silent: false, planner_recovery: true })), NOW, [PLANNER_SCHEDULED]);
  assert.equal(result.rows.find((found) => found.kind === PLANNER_SCHEDULED)!.coverage.complete, true);
  // An unseen kind falls back on its text; a recorded group stays authoritative.
  const unseen = { kinds: new Map<string, { section: string; group: string | null }>() };
  assert.equal(sourceOf(PLANNER_SCHEDULED, unseen).group, "planners");
  assert.equal(sourceOf("agents: usage-limit recovery held for owner", unseen).group, "planners");
  assert.equal(sourceOf(PLANNER_SCHEDULED, { kinds: new Map<string, { section: string; group: string | null }>([[PLANNER_SCHEDULED, { section: "agents", group: "error" }]]) }).group, "error");
});

test("planner coverage: a remote host whose agents were not read is judged by its planner unit", async () => {
  const macUnread = { [`agents@${MAC}`]: false, [`silent@${MAC}`]: false };
  // The Mac's planner file is read while its agents are not: it stays a candidate and is covered.
  let result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, () => ({ ...macUnread, planner_recovery: true, [`planner_recovery@${MAC}`]: true })), NOW, [PLANNER_SCHEDULED]);
  let covered = result.rows.find((found) => found.kind === PLANNER_SCHEDULED)!.coverage;
  assert.deepEqual(covered.hosts, [MAC, SERVER]);
  assert.equal(covered.complete, true);
  // The Mac's planner file unread: named as not counted, server087 stays complete.
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, () => ({ ...macUnread, planner_recovery: true, [`planner_recovery@${MAC}`]: false })), NOW, [PLANNER_SCHEDULED]);
  covered = result.rows.find((found) => found.kind === PLANNER_SCHEDULED)!.coverage;
  assert.deepEqual(covered.hosts, [SERVER]);
  assert.deepEqual(covered.excluded, [MAC]);
  assert.equal(covered.complete, true);
  // The local planner file unread: not complete although the Mac is covered.
  result = await analysis(new Log().runs(NOW - 40 * DAY, NOW, () => ({ ...macUnread, planner_recovery: false, [`planner_recovery@${MAC}`]: true })), NOW, [PLANNER_SCHEDULED]);
  covered = result.rows.find((found) => found.kind === PLANNER_SCHEDULED)!.coverage;
  assert.deepEqual(covered.hosts, [MAC]);
  assert.equal(covered.complete, false);
});

test("planner completion rows are non-attention: no counts, no recurring ticket, while auto is observed", async () => {
  const home = await temporary();
  try {
    const log = new Log().runs(NOW - 40 * DAY, NOW, () => ({ planner_recovery: true }));
    for (let index = 0; index < 5; index++) {
      log.problem(PLANNER_CONFIRMED, NOW - 7 * DAY + index * HOUR, { attention: false, auto: true, key: `planner-confirmed:${SERVER}:p1:run${index}:req${index}`, cleared: null });
    }
    log.problem(PLANNER_SCHEDULED, NOW - 7 * DAY, { attention: false, auto: false, key: `planner-pending:${SERVER}:p1:run`, cleared: null });
    await log.write(home);
    const result = analyse(await readHistory(home, NOW - 35 * DAY, NOW), NOW, { this: 20, last: 10 }, [PLANNER_CONFIRMED, PLANNER_SCHEDULED]);
    const confirmed = result.rows.find((found) => found.kind === PLANNER_CONFIRMED)!;
    assert.equal(confirmed.this.count, 0);
    assert.equal(confirmed.last.count, 0);
    assert.equal(confirmed.all.count, 0);
    assert.equal(confirmed.recurring, false);
    assert.ok(result.byKind.get(PLANNER_CONFIRMED)!.every((occurrence) => occurrence.attentionAt === null && occurrence.autoTrueAt !== null));
    assert.ok(result.byKind.get(PLANNER_SCHEDULED)!.every((occurrence) => occurrence.autoTrueAt === null));
    // The file run files and comments nothing: planner rows never rank as problems.
    const world = new World();
    const report = await runFile(deps(home, world));
    assert.deepEqual(report.created, []);
    assert.deepEqual(world.writes, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// The fixture driver: the real digest module produces its own history lines (planner_items +
// history_events) for a local scheduled restart and a confirmed one on the Mac, whose agents stay
// unread while its planner file is read.
const PLANNER_DRIVER = `
import importlib.util
import json
import sys
from datetime import datetime, timezone

module, out, start, hours, host, mac = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
spec = importlib.util.spec_from_file_location("paseo_ops_digest", module)
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)

def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

sources = {
    "": {"version": 1, "pending": [{"projectId": "proj-1", "runId": "run-1", "resumeAt": iso(start + 3600), "state": "scheduled"}], "completed": []},
    mac: {"version": 1, "pending": [], "completed": [{"projectId": "proj-2", "runId": "run-2", "requestId": "req-1", "agentId": "agent-1", "confirmedAt": iso(start + 600)}]},
}
units = [
    {"unit": "agents", "ok": True},
    {"unit": "planner_recovery", "ok": True},
    {"unit": "agents@" + mac, "ok": False},
    {"unit": "planner_recovery@" + mac, "ok": True},
]
evidence = {"prWatch": None, "crashes": {}, "limitResumes": None, "plannerRecovery": sources}
state = digest.empty_state()
lines = []
previous = state["items"]
for hour in range(hours):
    now = start + hour * 3600
    items = digest.planner_items(sources, now)
    state, _ = digest.merge_run(state, items, [], now)
    lines += digest.history_events(previous, state, units, now, host=host, read_hosts=digest.hosts_read(units, host), evidence=evidence)
    previous = state["items"]
with open(out, "w") as handle:
    json.dump(lines, handle)
`;

test("planner history from the real Python digest feeds the weekly review", async () => {
  const home = await temporary();
  try {
    const module = fileURLToPath(new URL("../ops/paseo-ops-digest.py", import.meta.url));
    const driver = join(home, "driver.py");
    const written = join(home, "lines.json");
    await writeFile(driver, PLANNER_DRIVER);
    await exec("python3", [driver, module, written, String(Math.floor((NOW - 14 * DAY) / 1000)), String(14 * 24), SERVER, MAC]);
    const lines: unknown[] = JSON.parse(await readFile(written, "utf8"));
    await writeFile(join(home, "history.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const history = await readHistory(home, NOW - 35 * DAY, NOW);
    assert.equal(history.malformed.size, 0);
    assert.equal(history.duplicates, 0);
    const result = analyse(history, NOW, { this: 20, last: 10 }, [PLANNER_SCHEDULED, PLANNER_CONFIRMED]);
    for (const kind of [PLANNER_SCHEDULED, PLANNER_CONFIRMED]) {
      const row = result.rows.find((found) => found.kind === kind)!;
      assert.equal(row.source.group, "planners");
      assert.equal(row.coverage.complete, true);
      // The Mac's agents were never read: only its planner unit makes it a covered host.
      assert.deepEqual(row.coverage.hosts, [MAC, SERVER]);
      assert.equal(row.all.count, 0);
      assert.equal(row.recurring, false);
    }
    assert.ok(result.byKind.get(PLANNER_CONFIRMED)!.every((occurrence) => occurrence.attentionAt === null && occurrence.autoTrueAt !== null));
    assert.ok(result.byKind.get(PLANNER_SCHEDULED)!.every((occurrence) => occurrence.autoTrueAt === null));
    const world = new World();
    const report = await runFile(deps(home, world));
    assert.deepEqual(report.created, []);
    assert.deepEqual(world.writes, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("duplicate lines from a replayed run count once", async () => {
  const log = healthy().burst(DRAFT, NOW - 7 * DAY, 3);
  log.lines.push(...log.lines.slice(-6));
  const result = await analysis(log);
  assert.equal(result.rows[0].this.count, 3);
});

test("remote hosts' problems without evidence count as unknown, never as cleared without the owner", async () => {
  const result = await analysis(healthy().burst(ERROR, NOW - 7 * DAY, 3, { host: MAC, owner: null, auto: null }).burst(ERROR, NOW - 7 * DAY, 2));
  const row = result.rows.find((found) => found.kind === ERROR)!;
  assert.deepEqual(row.all.owner, { yes: 0, no: 2, unknown: 3 });
  assert.deepEqual(row.all.auto, { yes: 0, no: 2, unknown: 3 });
  assert.equal(result.headline.this.clearedWithoutOwner, 2);
  assert.equal(result.headline.this.clearedUnknownOwner, 3);
  assert.equal(result.headline.this.shareClearedWithoutOwner, 1);
});

test("headline: problems that needed the owner per merged PR, share cleared without the owner, median time to clear; gh failing → unknown", async () => {
  const home = await temporary();
  try {
    await healthy().burst(WAITING, NOW - 7 * DAY, 4, { owner: true }).burst(DRAFT, NOW - 7 * DAY, 6).write(home);
    const world = new World();
    let text = await runCollect(deps(home, world));
    assert.match(text, /needed you per merged PR \(observed owner involvement\): 0\.2 \(4 of 20 merged PRs\)/);
    assert.match(text, /cleared without you: 60 % \(6 of 10 with known owner, 0 unknown\)/);
    assert.match(text, /Median time to clear: 2 h/);
    text = await runCollect(deps(home, world, { mergedPullRequests: async () => null }));
    assert.match(text, /merged PR \(observed owner involvement\): unknown \(4 of unknown merged PRs\)/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("new tickets: at most 3 a week, ranked by hours open, with marker, numbers and the Done-when line; adopted tickets do not use the cap", async () => {
  const home = await temporary();
  try {
    const log = healthy();
    const kinds = ["pulls: a", "pulls: b", "pulls: c", "pulls: d", "pulls: e"];
    kinds.forEach((kind, index) => log.burst(kind, NOW - 7 * DAY, 3, { cleared: null, open: [] }).burst(kind, NOW - 7 * DAY, index, { key: undefined }));
    await log.write(home);
    const world = new World();
    world.issues.push(marker(1205, { description: "Adopted fix", creatorId: "owner", createdAt: at(NOW - HOUR), comments: [{ body: "Marker: `ops-kind agents: something else`", createdAt: at(NOW - HOUR) }] }));
    const dry = await runFile(deps(home, world, { dryRun: true }));
    assert.deepEqual(dry.created.map((found) => found.kind), ["pulls: e", "pulls: d", "pulls: c"]);
    assert.deepEqual(dry.nextWeek, ["pulls: b", "pulls: a"]);
    assert.deepEqual(world.writes, []);
    const report = await runFile(deps(home, world));
    assert.deepEqual(report.created.map((found) => found.kind), ["pulls: e", "pulls: d", "pulls: c"]);
    assert.deepEqual(world.writes.slice(0, 3), ["create project:Agent tooling state:todo \"Recurring ops problem: pulls: e\"", "create project:Agent tooling state:todo \"Recurring ops problem: pulls: d\"", "create project:Agent tooling state:todo \"Recurring ops problem: pulls: c\""]);
    const description = world.issues.find((issue) => issue.description.includes("pulls: e"))!.description;
    assert.match(description, /^Marker: `ops-kind pulls: e`$/m);
    assert.match(description, /\| Problems \| 7 \| 0 \|/);
    assert.match(description, /Done when: the weekly count of `pulls: e` is at most half of the week before this ticket closes/);
    // A second run the same week: the cap is used up, nothing is created twice, and the tickets
    // filed this week get no weekly comment (their description holds this week's numbers).
    world.writes = [];
    const again = await runFile(deps(home, world));
    assert.equal(again.capLeft, 0);
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.nextWeek, ["pulls: b", "pulls: a"]);
    assert.deepEqual(world.writes, []);
    assert.deepEqual(new Set(again.updated.map((found) => found.comment)), new Set(["present"]));
    // Two filed this week leave room for one.
    const other = new World();
    other.issues.push(marker(1, { description: "Marker: `ops-kind pulls: x`", createdAt: at(NOW - HOUR) }), marker(2, { description: "Marker: `ops-kind pulls: y`", createdAt: at(NOW - 2 * HOUR) }));
    assert.equal((await runFile(deps(home, other, { dryRun: true }))).created.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Berlin weeks: Sunday 23:30 and Monday 00:30 Berlin are different weeks", () => {
  assert.deepEqual(berlinWeek(Date.parse("2026-10-11T21:30:00Z")), { year: 2026, week: 41 });
  assert.deepEqual(berlinWeek(Date.parse("2026-10-11T22:30:00Z")), { year: 2026, week: 42 });
});

test("dedupe: a kind with a ticket (described or adopted) is commented once a week, never created; canceled ones stay closed; two tickets are a conflict", async () => {
  const home = await temporary();
  try {
    await healthy().burst(DRAFT, NOW - 7 * DAY, 5).burst(WAITING, NOW - 7 * DAY, 4).burst(ERROR, NOW - 7 * DAY, 4).burst("pulls: z", NOW - 7 * DAY, 4).write(home);
    const world = new World();
    world.issues.push(
      marker(1211, { creatorId: "owner", comments: [{ body: `Marker: \`ops-kind ${DRAFT}\``, createdAt: at(NOW - 5 * DAY) }] }),
      marker(3000, { description: `Marker: \`ops-kind ${WAITING}\`` }),
      marker(3001, { description: `Marker: \`ops-kind ${ERROR}\``, statusType: "canceled" }),
      marker(3002, { description: "Marker: `ops-kind pulls: z`" }),
      marker(3003, { creatorId: "owner", comments: [{ body: "Marker: `ops-kind pulls: z`", createdAt: at(NOW - DAY) }] }),
    );
    const report = await runFile(deps(home, world));
    assert.deepEqual(report.created, []);
    assert.deepEqual(report.conflicts, [{ kind: "pulls: z", tickets: ["TUC-3002", "TUC-3003"] }]);
    assert.deepEqual(world.writes, ["comment issue-1211 Marker: `ops-review 2026-W42`", "comment issue-3000 Marker: `ops-review 2026-W42`"]);
    assert.match(world.issues[0].comments.at(-1)!.body, new RegExp(`\`${DRAFT}\` \\| 5 \\| 0 \\|`));
    world.writes = [];
    await runFile(deps(home, world));
    assert.deepEqual(world.writes, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("marker comments are read past the first 100 comments", async () => {
  const pages: Record<string, unknown>[] = [
    { issues: { nodes: [{ id: "i1", identifier: "TUC-1", url: "u", createdAt: at(NOW), completedAt: null, creator: { id: "owner" }, state: { type: "started" }, description: "", comments: { nodes: Array.from({ length: 100 }, () => ({ body: "ops-note", createdAt: at(NOW - DAY) })), pageInfo: { hasNextPage: true, endCursor: "c1" } } }], pageInfo: { hasNextPage: false, endCursor: null } } },
    { issue: { comments: { nodes: [{ body: `Marker: \`ops-kind ${DRAFT}\``, createdAt: at(NOW) }], pageInfo: { hasNextPage: false, endCursor: null } } } },
  ];
  const sent: Record<string, unknown>[] = [];
  const linear = new LinearService(new Credentials("/unused", "key"), async (_key, _query, variables) => { sent.push(variables); return pages.shift()!; });
  const [issue] = await linear.opsMarkerIssues("team");
  assert.equal(issue.comments.length, 101);
  assert.equal(issue.comments.at(-1)!.body, `Marker: \`ops-kind ${DRAFT}\``);
  assert.deepEqual(sent[1], { id: "i1", after: "c1" });
});

// A Done ticket of one kind closed 15 days before NOW: B = its kind in the week before the close,
// C = in the second week after it.
async function checkTicket(before: number, after: number, options: { kinds?: string[]; log?: Log; status?: string } = {}) {
  const home = await temporary();
  const closed = NOW - 15 * DAY;
  const log = options.log ?? healthy();
  if (!options.log) log.burst(DRAFT, closed - 7 * DAY, before).burst(DRAFT, closed + 7 * DAY, after);
  await log.write(home);
  const world = new World();
  world.issues.push(marker(1211, { statusType: options.status ?? "completed", completedAt: at(closed), description: (options.kinds ?? [DRAFT]).map((kind) => `Marker: \`ops-kind ${kind}\``).join("\n") }));
  return { home, world, closed, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("check two weeks after Done: halved (also exactly half) is verified, 10 → 6 is reopened, no baseline is neither", async () => {
  for (const [before, after, expected] of [[10, 5, "verified"], [10, 4, "verified"], [10, 6, "failed"], [0, 0, "no baseline"], [0, 4, "no baseline"]] as const) {
    const { home, world, closed, cleanup } = await checkTicket(before, after);
    try {
      const report = await runFile(deps(home, world));
      assert.deepEqual(report.checks[0].kinds.map((kind) => kind.outcome), [expected], `${before} → ${after}`);
      if (expected === "failed") {
        assert.deepEqual(world.writes, [`comment issue-1211 Marker: \`ops-review reopen ${at(closed)}\``, "move issue-1211 state:todo"]);
      } else {
        assert.deepEqual(world.writes, [`comment issue-1211 Marker: \`ops-review checked ${at(closed)}\``]);
        assert.match(world.issues[0].comments[0].body, expected === "verified" ? new RegExp(`^- \`ops-kind ${DRAFT}\`: verified ${before} → ${after}$`, "m") : /: no baseline$/m);
      }
    } finally { await cleanup(); }
  }
});

test("a check is due only two weeks after Done", async () => {
  const home = await temporary();
  try {
    await healthy().write(home);
    const world = new World();
    world.issues.push(marker(1, { statusType: "completed", completedAt: at(NOW - 10 * DAY), description: `Marker: \`ops-kind ${DRAFT}\`` }));
    const report = await runFile(deps(home, world));
    assert.deepEqual(report.checks, [{ ticket: "TUC-1", state: "due", kinds: [], due: at(NOW + 4 * DAY) }]);
    assert.deepEqual(world.writes, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("10 → 0 verifies only when the kind's sources were read; unread sources mean no write", async () => {
  let { home, world, cleanup } = await checkTicket(10, 0);
  try {
    assert.deepEqual((await runFile(deps(home, world))).checks[0].kinds.map((kind) => kind.outcome), ["verified"]);
  } finally { await cleanup(); }
  const closed = NOW - 15 * DAY;
  const log = new Log().runs(NOW - 40 * DAY, NOW, (t) => (t > closed + 7 * DAY && t < closed + 14 * DAY ? { repo: false } : {})).burst(DRAFT, closed - 7 * DAY, 10);
  ({ home, world, cleanup } = await checkTicket(10, 0, { log }));
  try {
    const report = await runFile(deps(home, world));
    assert.equal(report.checks[0].state, "not enough data");
    assert.deepEqual(world.writes, []);
  } finally { await cleanup(); }
});

test("a ticket of several kinds: one failing reopens naming it, one lacking data writes nothing, all passing write one checked comment", async () => {
  const closed = NOW - 15 * DAY;
  const kinds = [DRAFT, WAITING, ERROR];
  const log = (errorAfter: number, unreadAgents: boolean) => new Log().runs(NOW - 40 * DAY, NOW, (t) => (unreadAgents && t > closed + 7 * DAY && t < closed + 14 * DAY ? { agents: false, silent: false } : {}))
    .burst(DRAFT, closed - 7 * DAY, 10).burst(DRAFT, closed + 7 * DAY, 2)
    .burst(WAITING, closed - 7 * DAY, 4).burst(WAITING, closed + 7 * DAY, 2)
    .burst(ERROR, closed - 7 * DAY, 6).burst(ERROR, closed + 7 * DAY, errorAfter);
  for (const [errorAfter, unread, writes] of [
    [5, false, [`comment issue-1211 Marker: \`ops-review reopen ${at(closed)}\``, "move issue-1211 state:todo"]],
    [1, true, []],
    [1, false, [`comment issue-1211 Marker: \`ops-review checked ${at(closed)}\``]],
  ] as const) {
    const { home, world, cleanup } = await checkTicket(0, 0, { kinds, log: log(errorAfter, unread) });
    try {
      await runFile(deps(home, world));
      assert.deepEqual(world.writes, writes);
      const body = world.issues[0].comments[0]?.body ?? "";
      if (errorAfter === 5) assert.match(body, new RegExp(`\`ops-kind ${ERROR}\`: failed \\(6 in the week before it closed → 5`));
      if (writes.length === 1) assert.equal([...body.matchAll(/^- `ops-kind .+`: verified \d+ → \d+$/gm)].length, 3);
    } finally { await cleanup(); }
  }
});

test("after a no-baseline check, a kind that comes back reopens the ticket once; a verified kind at half or less does not", async () => {
  const closed = NOW - 22 * DAY;
  const checked = (lines: string) => ({ body: `Marker: \`ops-review checked ${at(closed)}\`\n\n${lines}`, createdAt: at(closed + 15 * DAY) });
  for (const [lines, count, reopens] of [
    [`- \`ops-kind ${DRAFT}\`: no baseline`, 3, true],
    [`- \`ops-kind ${DRAFT}\`: verified 10 → 4`, 5, false],
    [`- \`ops-kind ${DRAFT}\`: verified 10 → 4`, 10, true],
  ] as const) {
    const home = await temporary();
    try {
      await healthy().burst(DRAFT, NOW - 7 * DAY, count).write(home);
      const world = new World();
      world.issues.push(marker(1211, { statusType: "completed", completedAt: at(closed), description: `Marker: \`ops-kind ${DRAFT}\``, comments: [checked(lines)] }));
      await runFile(deps(home, world));
      assert.deepEqual(world.writes, reopens ? [`comment issue-1211 Marker: \`ops-review reopen ${at(closed)} relapse\``, "move issue-1211 state:todo"] : [], `${lines} at ${count}`);
      // Rerun: reopened once.
      world.writes = [];
      await runFile(deps(home, world));
      assert.ok(!world.writes.some((write) => write.includes("reopen")));
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("reopen: after a crash between comment and move only the move is done; a ticket canceled meanwhile is not moved", async () => {
  const { home, world, closed, cleanup } = await checkTicket(10, 8);
  try {
    world.issues[0].comments.push({ body: `Marker: \`ops-review reopen ${at(closed)}\`\n\nOps review: …`, createdAt: at(NOW - HOUR) });
    await runFile(deps(home, world));
    assert.deepEqual(world.writes, ["move issue-1211 state:todo"]);
  } finally { await cleanup(); }
  const second = await checkTicket(10, 8);
  try {
    // Canceled between the marker read and the move.
    second.world.issueStatuses = async (ids: string[]) => new Map(ids.map((id) => [id, { status: "Canceled", statusType: "canceled", completedAt: null }]));
    const report = await runFile(deps(second.home, second.world));
    assert.deepEqual(second.world.writes, [`comment issue-1211 Marker: \`ops-review reopen ${at(second.closed)}\``]);
    assert.equal(report.reopened[0].moved, false);
  } finally { await second.cleanup(); }
});

test("writes go only through the Paseo app: a missing or expiring token writes nothing, and the key is never used", async () => {
  const home = await temporary();
  try {
    await healthy().burst(DRAFT, NOW - 7 * DAY, 4).write(join(home, "ops"));
    const world = new World();
    world.issues.push(marker(1211, { description: `Marker: \`ops-kind ${DRAFT}\`` }));
    const tokens = join(home, "agent-app");
    await mkdir(tokens, { recursive: true });
    const sent: { authorization: string; query: string }[] = [];
    const post = async (authorization: string, query: string) => {
      sent.push({ authorization, query });
      return query.includes("commentCreate") ? { commentCreate: { success: true } } : { issueUpdate: { success: true } };
    };
    const writer = new AppWriter(new AgentApi(new AppOnlyToken(tokens, () => NOW), post));
    await assert.rejects(runFile(deps(join(home, "ops"), world, { writer })), /nothing was written/);
    await writeFile(join(tokens, "token.json"), JSON.stringify({ access_token: "app", expires_at: NOW + 4 * 60_000 }));
    await assert.rejects(runFile(deps(join(home, "ops"), world, { writer })), /nothing was written/);
    assert.equal(sent.length, 0);
    await writeFile(join(tokens, "token.json"), JSON.stringify({ access_token: "app", expires_at: NOW + DAY }));
    await writer.comment("issue-1", "hello");
    await writer.moveToState("issue-1", "state:todo");
    assert.deepEqual(sent.map((found) => found.authorization), ["Bearer app", "Bearer app"]);
    assert.match(sent[0].query, /commentCreate/);
    assert.match(sent[1].query, /issueUpdate\(id: \$id, input: \{ stateId: \$stateId \}\)/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("one file run at a time: a live holder stops a second run, a dead one on this host is taken over", async () => {
  const home = await temporary();
  try {
    const path = join(home, "review.lock");
    const lock = { pid: 1, host: SERVER, now: () => NOW, alive: (pid: number) => pid === 42 };
    await writeFile(path, JSON.stringify({ pid: 42, host: SERVER, startedAt: at(NOW - DAY) }));
    await assert.rejects(pidLock(path, async () => "ran", lock), /pid 42 on server087/);
    // Another host's lock is never taken over, whatever its pid.
    await writeFile(path, JSON.stringify({ pid: 7, host: "laptop", startedAt: at(NOW - DAY) }));
    await assert.rejects(pidLock(path, async () => "ran", lock), /pid 7 on laptop/);
    await writeFile(path, JSON.stringify({ pid: 7, host: SERVER, startedAt: at(NOW - DAY) }));
    assert.equal(await pidLock(path, async () => "ran", lock), "ran");
    await assert.rejects(readFile(path), /ENOENT/);
    // The real file run holds it too.
    await healthy().write(home);
    await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: at(NOW) }));
    await assert.rejects(runFile(deps(home, new World())), /Another ops review holds/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("create idempotency: a timed-out create that lands late still makes one ticket; an old reservation blocks a new id; collect and dry runs leave reservations alone", async () => {
  const home = await temporary();
  try {
    await healthy().burst(DRAFT, NOW - 7 * DAY, 4).write(home);
    const world = new World();
    let reserved: string | undefined;
    world.beforeCreate = (input) => { reserved = input.id; world.beforeCreate = null; throw new Error("timeout"); };
    await assert.rejects(runFile(deps(home, world)), /timeout/);
    assert.equal(world.issues.length, 0);
    const file = join(home, "review-creates.json");
    const saved = await readFile(file, "utf8");
    assert.equal(JSON.parse(saved).reservations[0].issueId, reserved);
    // Weeks later the reservation still blocks a new id; collect and a dry run only report it.
    const later = NOW + 21 * DAY;
    await healthy().runs(NOW, later).burst(DRAFT, later - 7 * DAY, 4).write(home);
    assert.match(await runCollect(deps(home, world, { now: later })), new RegExp(`\`${DRAFT}\`: issue id ${reserved}`));
    const dry = await runFile(deps(home, world, { now: later, dryRun: true }));
    assert.deepEqual(dry.created, []);
    assert.deepEqual(dry.waiting, [{ kind: DRAFT, issueId: reserved }]);
    assert.equal(await readFile(file, "utf8"), saved);
    // The next real run: the lookup finds nothing, the retry meets the late first create.
    world.beforeCreate = (input) => { world.land({ id: input.id, title: "late", description: `Marker: \`ops-kind ${DRAFT}\``, stateId: "state:todo", projectId: "p" }, at(NOW)); world.beforeCreate = null; };
    const report = await runFile(deps(home, world, { now: later }));
    assert.equal(world.issues.length, 1);
    assert.equal(world.issues[0].id, reserved);
    assert.deepEqual(report.reconciled.map((found) => [found.kind, found.retried]), [[DRAFT, true]]);
    assert.deepEqual(report.created, []);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).reservations, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the cap counts reconciled and retried creates of this week before fresh ones; one created last week does not", async () => {
  const home = await temporary();
  try {
    const log = healthy();
    for (const kind of ["pulls: a", "pulls: b", "pulls: c", "pulls: d", "pulls: e", "pulls: f"]) log.burst(kind, NOW - 7 * DAY, 3);
    await log.write(home);
    const input = (kind: string) => ({ teamId: "team", projectId: "project:Agent tooling", stateId: "state:todo", title: `Recurring ops problem: ${kind}`, description: `Marker: \`ops-kind ${kind}\`` });
    const reservations = [
      { kind: "pulls: a", issueId: "11111111-1111-4111-8111-111111111111", at: at(NOW - HOUR), input: input("pulls: a") },
      { kind: "pulls: b", issueId: "22222222-2222-4222-8222-222222222222", at: at(NOW - HOUR), input: input("pulls: b") },
    ];
    await writeFile(join(home, "review-creates.json"), JSON.stringify({ reservations }));
    const world = new World();
    // "a" landed this week; "b" never did and is created now.
    world.land({ ...input("pulls: a"), id: reservations[0].issueId }, at(NOW - HOUR));
    let report = await runFile(deps(home, world));
    assert.deepEqual(report.reconciled.map((found) => [found.kind, found.retried]), [["pulls: a", false], ["pulls: b", true]]);
    assert.equal(report.created.length, 1);
    assert.equal(world.issues.length, 3);
    // A reconciled ticket created last week leaves this week's cap alone.
    const other = new World();
    other.land({ ...input("pulls: a"), id: reservations[0].issueId }, at(NOW - 8 * DAY));
    await writeFile(join(home, "review-creates.json"), JSON.stringify({ reservations: [reservations[0]] }));
    report = await runFile(deps(home, other));
    assert.equal(report.created.length, 3);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("file writes trend.json for the digest's Trend section; a dry run does not", async () => {
  const home = await temporary();
  try {
    await healthy().burst(DRAFT, NOW - 7 * DAY, 2).burst(WAITING, NOW - 14 * DAY, 1).write(home);
    const world = new World();
    await runFile(deps(home, world, { dryRun: true }));
    await assert.rejects(readFile(join(home, "trend.json")), /ENOENT/);
    await runFile(deps(home, world));
    const trend = JSON.parse(await readFile(join(home, "trend.json"), "utf8"));
    assert.equal(trend.week, "2026-W42");
    assert.deepEqual(trend.kinds, [{ kind: DRAFT, thisWeek: 2, lastWeek: 0, complete: true }, { kind: WAITING, thisWeek: 0, lastWeek: 1, complete: true }]);
    assert.equal(trend.headline.this.mergedPrs, 20);
    assert.equal(trend.window.this.to, at(NOW));
  } finally { await rm(home, { recursive: true, force: true }); }
});
