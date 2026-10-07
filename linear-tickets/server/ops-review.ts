import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { CreatedIssueRef, IssueStatus, OpsMarkerIssue } from "./linear";
import { isoWeek, type OpsWriter } from "./owner-decisions";
import { paseoHome } from "./ticket-mcp";

// The weekly ops review (README, "Ops digest and weekly ops review"). The hourly ops digest
// (ops/paseo-ops-digest.py) appends what it saw to `history*.jsonl` in its directory: one `run`
// line per run (every unit it attempted and whether it read it, the hosts whose agents it read) and
// one line per item (`opened`, `open`, `cleared`) with the item's kind, never its text. This module
// counts each kind for the last 7 days against the 7 before, files one "Recurring ops problem"
// ticket per kind that keeps coming back (at most 3 a week), comments the week's numbers on the
// kinds' tickets, and two weeks after such a ticket is Done checks that its kinds got at least twice
// as rare, reopening it otherwise. Missing data is never read as improvement: a window whose sources
// were not read in at least 90 % of its hours is "not enough data", and nothing is verified or
// reopened on it. Writes go through the Paseo app only (AppWriter), from one host (`file` holds a
// PID lock in the history directory).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// A kind keeps coming back at this many problems in the last 7 days (owner decision 2).
export const RECURRING_MIN = 3;
export const NEW_TICKETS_PER_WEEK = 3;
const COVERED_SHARE = 0.9;
const MALFORMED_SHARE = 0.01;
const FAILED_SUBUNIT_SHARE = 0.1;
const LOOKBACK = 35 * DAY;
const CHECK_AFTER = 14 * DAY;
const TREND_KINDS = 5;
const EXAMPLES = 5;
const PROJECT = "Agent tooling";
const GITHUB_REPO = "tuchel-sohn/tuchel-platform";
const CLOSED_TYPES = ["completed", "canceled", "duplicate"];
const DROPPED_TYPES = ["canceled", "duplicate"];
const REPO_SECTIONS = ["main", "queue", "drops", "pulls", "deploys"];
// The repository units (tuchel-platform `tools/ci/ops-digest.mjs`) behind each section's items.
const SECTION_UNITS: Record<string, string[]> = { main: ["main", "main-hold", "main-security-scan", "core-web-bundle"], queue: ["queue"], drops: ["drops"], pulls: ["pulls"], deploys: [] };
const SUBUNITS: Record<string, RegExp> = { pulls: /^pulls\//, deploys: /^deploy:[^/]+\/./ };
const AGENT_GROUPS = ["error", "waiting", "silent", "locks"];
export const KIND_MARKER = "ops-kind";
export const REVIEW_MARKER = "ops-review";
const KIND_LINE = /^Marker: `ops-kind ([^`\r\n]+)`[ \t]*$/gm;
const REVIEW_LINE = /^Marker: `ops-review ([^`\r\n]+)`[ \t]*$/gm;
const CHECKED_KIND_LINE = /^- `ops-kind ([^`\r\n]+)`: (?:verified (\d+) → (\d+)|no baseline)[ \t]*$/gm;

export function opsDirectory(home = paseoHome()): string {
  return join(home, "ops-digest");
}

// ---------------------------------------------------------------------------------------------
// Time

const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });
const berlinTime = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// ISO week of the Berlin calendar date at that instant: Sunday 23:30 and Monday 00:30 Berlin fall
// into different weeks whatever the UTC date is.
export function berlinWeek(at: number): { year: number; week: number } {
  const [year, month, day] = berlinDay.format(new Date(at)).split("-").map(Number);
  return isoWeek(new Date(Date.UTC(year, month - 1, day)));
}

export function weekLabel(at: number): string {
  const { year, week } = berlinWeek(at);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const berlin = (at: number) => berlinTime.format(new Date(at));
const iso = (at: number) => new Date(at).toISOString();

// ---------------------------------------------------------------------------------------------
// Reading the history

type RunRecord = { t: number; host: string; units: Record<string, boolean>; hosts: string[] };
// One problem from the hour it appeared (`first`) until it cleared. Evidence fields hold the first
// time a line said so; `null` when none did.
export type Occurrence = {
  key: string; first: number; kind: string; section: string; group: string | null; host: string | null; ticket: string | null;
  attentionAt: number | null; firstLineAt: number; lastLineAt: number; clearedAt: number | null;
  ownerTrueAt: number | null; ownerNullAt: number | null; autoTrueAt: number | null; autoNullAt: number | null;
};
export type History = {
  runs: RunRecord[];
  occurrences: Occurrence[];
  // Lines and malformed lines per UTC hour (hour index = floor(t / HOUR)); a malformed line counts
  // in the hour of the valid line before it.
  lines: Map<number, number>;
  malformed: Map<number, number>;
  // The section and group each kind was seen with.
  kinds: Map<string, { section: string; group: string | null }>;
  // Every host whose agents some run read, and the host the digest itself runs on (latest run).
  hosts: Set<string>;
  primaryHost: string | null;
  duplicates: number;
};

const time = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const min = (current: number | null, value: number) => (current === null || value < current ? value : current);

function historyFiles(from: number, now: number): string[] {
  const files = ["history-backfill.jsonl"];
  const cursor = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1));
  while (cursor.getTime() <= now) {
    files.push(`history-${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  files.push("history.jsonl");
  return files;
}

// Streams the files that can hold lines of [from, now] (the monthly files of those months, the
// current file and the one-off backfill). Identical lines (a run appended twice after a crash) count
// once; a line that is not a valid record is counted as malformed in its hour.
export async function readHistory(directory: string, from: number, now: number): Promise<History> {
  const history: History = { runs: [], occurrences: [], lines: new Map(), malformed: new Map(), kinds: new Map(), hosts: new Set(), primaryHost: null, duplicates: 0 };
  const seen = new Set<string>();
  const occurrences = new Map<string, Occurrence>();
  let latestRun = -Infinity;
  for (const name of historyFiles(from, now)) {
    let stream;
    try {
      stream = createReadStream(join(directory, name), { encoding: "utf8" });
      await new Promise<void>((resolve, reject) => { stream!.once("open", () => resolve()); stream!.once("error", reject); });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let lastAt: number | null = null;
    let pendingMalformed = 0;
    const count = (map: Map<number, number>, at: number, by = 1) => map.set(Math.floor(at / HOUR), (map.get(Math.floor(at / HOUR)) ?? 0) + by);
    for await (const raw of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!raw.trim()) continue;
      const digest = createHash("sha1").update(raw).digest("base64");
      if (seen.has(digest)) { history.duplicates++; continue; }
      seen.add(digest);
      const line = parseLine(raw);
      if (!line) {
        if (lastAt === null) pendingMalformed++;
        else { count(history.malformed, lastAt); count(history.lines, lastAt); }
        continue;
      }
      if (pendingMalformed) { count(history.malformed, line.t, pendingMalformed); count(history.lines, line.t, pendingMalformed); pendingMalformed = 0; }
      lastAt = line.t;
      count(history.lines, line.t);
      if (line.event === "run") {
        history.runs.push(line);
        for (const host of line.hosts) history.hosts.add(host);
        if (line.t > latestRun) { latestRun = line.t; history.primaryHost = line.host; }
        continue;
      }
      if (line.event === "gap") continue;
      const item = line;
      const id = `${item.key}\u0000${item.first}`;
      let occurrence = occurrences.get(id);
      if (!occurrence) {
        occurrence = {
          key: item.key, first: item.first, kind: item.kind, section: item.section, group: item.group, host: item.host, ticket: item.ticket,
          attentionAt: null, firstLineAt: item.t, lastLineAt: item.t, clearedAt: null, ownerTrueAt: null, ownerNullAt: null, autoTrueAt: null, autoNullAt: null,
        };
        occurrences.set(id, occurrence);
      }
      if (!history.kinds.has(item.kind)) history.kinds.set(item.kind, { section: item.section, group: item.group });
      if (item.host && item.section === "agents") history.hosts.add(item.host);
      occurrence.firstLineAt = Math.min(occurrence.firstLineAt, item.t);
      if (item.event === "cleared") occurrence.clearedAt = min(occurrence.clearedAt, item.t);
      else occurrence.lastLineAt = Math.max(occurrence.lastLineAt, item.t);
      if (item.attention) occurrence.attentionAt = min(occurrence.attentionAt, item.t);
      if (item.owner === true) occurrence.ownerTrueAt = min(occurrence.ownerTrueAt, item.t);
      else if (item.owner === null) occurrence.ownerNullAt = min(occurrence.ownerNullAt, item.t);
      if (item.auto === true) occurrence.autoTrueAt = min(occurrence.autoTrueAt, item.t);
      else if (item.auto === null) occurrence.autoNullAt = min(occurrence.autoNullAt, item.t);
    }
  }
  history.occurrences = [...occurrences.values()];
  history.runs.sort((a, b) => a.t - b.t);
  return history;
}

type ItemLine = {
  t: number; event: "opened" | "open" | "cleared"; key: string; kind: string; first: number; attention: boolean; section: string;
  group: string | null; ticket: string | null; host: string | null; owner: boolean | null; auto: boolean | null;
};
type Line = (RunRecord & { event: "run" }) | { t: number; event: "gap" } | ItemLine;

function parseLine(raw: string): Line | null {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch { return null; }
  const t = time(value.t);
  if (t === null) return null;
  if (value.event === "run") {
    if (typeof value.host !== "string" || !value.units || typeof value.units !== "object" || !Array.isArray(value.hosts)) return null;
    const units: Record<string, boolean> = {};
    for (const [unit, ok] of Object.entries(value.units as Record<string, unknown>)) units[unit] = ok === true;
    return { t, event: "run", host: value.host, units, hosts: value.hosts.filter((host): host is string => typeof host === "string") };
  }
  if (value.event === "gap") return { t, event: "gap" };
  if (value.event !== "opened" && value.event !== "open" && value.event !== "cleared") return null;
  const first = time(value.first);
  if (first === null || typeof value.key !== "string" || typeof value.kind !== "string" || typeof value.section !== "string") return null;
  const evidence = (field: unknown) => (field === true ? true : field === false ? false : null);
  return {
    t, event: value.event, key: value.key, kind: value.kind, first, attention: value.attention === true, section: value.section,
    group: value.group === null || value.group === undefined ? null : String(value.group), ticket: typeof value.ticket === "string" ? value.ticket : null,
    host: typeof value.host === "string" ? value.host : null, owner: evidence(value.owner), auto: evidence(value.auto),
  };
}

// ---------------------------------------------------------------------------------------------
// Coverage: was a kind's source read in enough hours of a window?

export type Window = { from: number; to: number };
type Source = { section: string; group: string | null };

// A kind's source comes from its section and group, never from its problems, so a kind without
// any problem in a window is still judged (its sources read and nothing found is a valid 0).
export function sourceOf(kind: string, history: Pick<History, "kinds">): Source {
  const seen = history.kinds.get(kind);
  const section = seen?.section ?? kind.split(": ")[0];
  if (section !== "agents") return { section, group: null };
  if (seen?.group && AGENT_GROUPS.includes(seen.group)) return { section, group: seen.group };
  const detail = kind.slice("agents: ".length);
  return { section, group: /^in error/.test(detail) ? "error" : /^waits for/.test(detail) ? "waiting" : /running agent/.test(detail) ? "locks" : "silent" };
}

function repositoryRead(run: RunRecord, section: string): boolean {
  if (run.units.repo !== true) return false;
  if ((SECTION_UNITS[section] ?? []).some((unit) => run.units[unit] === false)) return false;
  if (section === "deploys" && Object.entries(run.units).some(([unit, ok]) => /^deploy:[^/]+$/.test(unit) && !ok)) return false;
  const pattern = SUBUNITS[section];
  if (pattern) {
    const attempted = Object.entries(run.units).filter(([unit]) => pattern.test(unit));
    const failed = attempted.filter(([, ok]) => !ok).length;
    if (attempted.length && failed / attempted.length > FAILED_SUBUNIT_SHARE) return false;
  }
  return true;
}

function agentsRead(run: RunRecord, group: string | null, host: string): boolean {
  if (group === "locks") return host === run.host && run.units.locks === true;
  const at = host === run.host ? "" : `@${host}`;
  if (run.units[`agents${at}`] !== true) return false;
  return group !== "silent" || run.units[`silent${at}`] === true;
}

function coveredShare(history: History, window: Window, read: (run: RunRecord) => boolean): number {
  const hours = Math.ceil((window.to - window.from) / HOUR);
  if (hours <= 0) return 0;
  const covered = new Set<number>();
  for (const run of history.runs) {
    if (run.t < window.from || run.t >= window.to) continue;
    if (read(run)) covered.add(Math.floor((run.t - window.from) / HOUR));
  }
  return covered.size / hours;
}

function malformedShare(history: History, window: Window): number {
  let lines = 0;
  let malformed = 0;
  for (let hour = Math.floor(window.from / HOUR); hour < Math.ceil(window.to / HOUR); hour++) {
    lines += history.lines.get(hour) ?? 0;
    malformed += history.malformed.get(hour) ?? 0;
  }
  return lines ? malformed / lines : 0;
}

// `hosts`: for agent kinds, the hosts complete in every window (only their problems are counted);
// null for repository kinds. Complete needs the digest's own host among them.
export type Coverage = { complete: boolean; hosts: string[] | null; excluded: string[] };

export function coverage(history: History, source: Source, windows: Window[]): Coverage {
  const clean = windows.every((window) => malformedShare(history, window) < MALFORMED_SHARE);
  if (source.section !== "agents") {
    const complete = clean && windows.every((window) => coveredShare(history, window, (run) => repositoryRead(run, source.section)) >= COVERED_SHARE);
    return { complete, hosts: null, excluded: [] };
  }
  const primary = history.primaryHost;
  const candidates = source.group === "locks" ? (primary ? [primary] : []) : [...new Set([...(primary ? [primary] : []), ...history.hosts])].sort();
  const hosts = candidates.filter((host) => windows.every((window) => coveredShare(history, window, (run) => agentsRead(run, source.group, host)) >= COVERED_SHARE));
  return { complete: clean && primary !== null && hosts.includes(primary), hosts, excluded: candidates.filter((host) => !hosts.includes(host)) };
}

// ---------------------------------------------------------------------------------------------
// Numbers per kind and window

type Evidence = "yes" | "no" | "unknown";
export type Tally = { yes: number; no: number; unknown: number };
export type KindWindow = {
  count: number; stillOpen: number; clearedCount: number; medianHours: number | null; p90Hours: number | null;
  owner: Tally; auto: Tally; hoursLost: number; examples: { key: string; ticket: string | null }[];
};

// Evidence as known at the window's end: any line up to then saying true wins; else unknown when one
// said unknown (null); else no. Lines after the window never change it.
function evidenceAt(trueAt: number | null, nullAt: number | null, firstLineAt: number, end: number): Evidence {
  if (trueAt !== null && trueAt <= end) return "yes";
  if (nullAt !== null && nullAt <= end) return "unknown";
  return firstLineAt <= end ? "no" : "unknown";
}
const ownerAt = (occurrence: Occurrence, end: number) => evidenceAt(occurrence.ownerTrueAt, occurrence.ownerNullAt, occurrence.firstLineAt, end);

// A problem counts once it needed attention by the window's end.
const attentionBy = (occurrence: Occurrence, end: number) => occurrence.attentionAt !== null && occurrence.attentionAt < end;

function quantile(sorted: number[], share: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
}
const round1 = (value: number) => Math.round(value * 10) / 10;

export function kindWindow(occurrences: Occurrence[], window: Window, hosts: string[] | null): KindWindow {
  const mine = occurrences.filter((occurrence) => attentionBy(occurrence, window.to) && (hosts === null || (occurrence.host !== null && hosts.includes(occurrence.host))));
  const counted = mine.filter((occurrence) => occurrence.first >= window.from && occurrence.first < window.to);
  const cleared = mine.filter((occurrence) => occurrence.clearedAt !== null && occurrence.clearedAt >= window.from && occurrence.clearedAt < window.to);
  const durations = cleared.map((occurrence) => (occurrence.clearedAt! - occurrence.first) / HOUR).sort((a, b) => a - b);
  const tally = (pick: (occurrence: Occurrence) => Evidence): Tally => {
    const result = { yes: 0, no: 0, unknown: 0 };
    for (const occurrence of counted) result[pick(occurrence)]++;
    return result;
  };
  let hoursLost = 0;
  for (const occurrence of mine) {
    const end = Math.min(occurrence.clearedAt ?? occurrence.lastLineAt, window.to);
    const start = Math.max(occurrence.first, window.from);
    if (end > start) hoursLost += (end - start) / HOUR;
  }
  const median = quantile(durations, 0.5);
  const p90 = quantile(durations, 0.9);
  return {
    count: counted.length,
    stillOpen: counted.filter((occurrence) => occurrence.clearedAt === null || occurrence.clearedAt >= window.to).length,
    clearedCount: cleared.length,
    medianHours: median === null ? null : round1(median),
    p90Hours: p90 === null ? null : round1(p90),
    owner: tally((occurrence) => ownerAt(occurrence, window.to)),
    auto: tally((occurrence) => evidenceAt(occurrence.autoTrueAt, occurrence.autoNullAt, occurrence.firstLineAt, window.to)),
    hoursLost: round1(hoursLost),
    examples: counted.slice(0, EXAMPLES).map((occurrence) => ({ key: occurrence.key, ticket: occurrence.ticket })),
  };
}

export type KindRow = {
  kind: string; source: Source;
  // The comparison of the last 7 days with the 7 before, counting only hosts complete in both.
  this: KindWindow; last: KindWindow; coverage: Coverage;
  // Every host's problems in the last 7 days: what makes a kind recurring and ranks it.
  all: KindWindow; recurring: boolean;
};

export type Headline = {
  ownerTrue: number; mergedPrs: number | null; ownerPerMergedPr: number | null;
  clearedWithoutOwner: number; clearedKnownOwner: number; clearedUnknownOwner: number; shareClearedWithoutOwner: number | null;
  medianHoursToClear: number | null; complete: boolean;
};

export type Analysis = { now: number; windows: { this: Window; last: Window }; rows: KindRow[]; headline: { this: Headline; last: Headline }; byKind: Map<string, Occurrence[]> };

function byKind(history: History): Map<string, Occurrence[]> {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of history.occurrences) {
    if (!groups.has(occurrence.kind)) groups.set(occurrence.kind, []);
    groups.get(occurrence.kind)!.push(occurrence);
  }
  for (const list of groups.values()) list.sort((a, b) => a.first - b.first || a.key.localeCompare(b.key));
  return groups;
}

function headline(history: History, window: Window, mergedPrs: number | null): Headline {
  const attention = history.occurrences.filter((occurrence) => attentionBy(occurrence, window.to));
  const ownerTrue = attention.filter((occurrence) => occurrence.first >= window.from && occurrence.first < window.to && ownerAt(occurrence, window.to) === "yes").length;
  const cleared = attention.filter((occurrence) => occurrence.clearedAt !== null && occurrence.clearedAt >= window.from && occurrence.clearedAt < window.to);
  const owners = cleared.map((occurrence) => ownerAt(occurrence, window.to));
  const without = owners.filter((owner) => owner === "no").length;
  const known = owners.filter((owner) => owner !== "unknown").length;
  const durations = cleared.map((occurrence) => (occurrence.clearedAt! - occurrence.first) / HOUR).sort((a, b) => a - b);
  const median = quantile(durations, 0.5);
  const sources: Source[] = [...REPO_SECTIONS.map((section) => ({ section, group: null })), ...AGENT_GROUPS.map((group) => ({ section: "agents", group }))];
  return {
    ownerTrue, mergedPrs, ownerPerMergedPr: mergedPrs ? Math.round((ownerTrue / mergedPrs) * 100) / 100 : null,
    clearedWithoutOwner: without, clearedKnownOwner: known, clearedUnknownOwner: owners.length - known,
    shareClearedWithoutOwner: known ? Math.round((without / known) * 100) / 100 : null,
    medianHoursToClear: median === null ? null : round1(median),
    complete: sources.every((source) => coverage(history, source, [window]).complete),
  };
}

// `extraKinds`: kinds that have a ticket, so they are listed even without problems.
export function analyse(history: History, now: number, merged: { this: number | null; last: number | null }, extraKinds: Iterable<string> = []): Analysis {
  const windows = { this: { from: now - WEEK, to: now }, last: { from: now - 2 * WEEK, to: now - WEEK } };
  const groups = byKind(history);
  const kinds = new Set<string>([...extraKinds]);
  for (const [kind, list] of groups) {
    if (list.some((occurrence) => attentionBy(occurrence, windows.this.to) && occurrence.first >= windows.last.from && occurrence.first < windows.this.to)) kinds.add(kind);
  }
  const rows = [...kinds].map((kind): KindRow => {
    const list = groups.get(kind) ?? [];
    const source = sourceOf(kind, history);
    const covered = coverage(history, source, [windows.last, windows.this]);
    const hosts = covered.complete ? covered.hosts : null;
    const all = kindWindow(list, windows.this, null);
    return { kind, source, this: kindWindow(list, windows.this, hosts), last: kindWindow(list, windows.last, hosts), coverage: covered, all, recurring: all.count >= RECURRING_MIN };
  });
  rows.sort(rank);
  return { now, windows, rows, headline: { this: headline(history, windows.this, merged.this), last: headline(history, windows.last, merged.last) }, byKind: groups };
}

// Owner decision 1: every hour a kind's problems stayed open, then how many, then the kind.
function rank(a: KindRow, b: KindRow): number {
  return b.all.hoursLost - a.all.hoursLost || b.all.count - a.all.count || a.kind.localeCompare(b.kind);
}

// ---------------------------------------------------------------------------------------------
// Marker tickets

// `filed`: the review filed it (marker line in the description, created by the Paseo app); an
// adopted ticket carries its marker lines in a comment and never counts against the weekly cap.
export type MarkerTicket = OpsMarkerIssue & { kinds: string[]; filed: boolean; markers: Set<string>; checkedComment: string | null };

const matches = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].map((match) => match[1].trim());

export function markerTickets(issues: OpsMarkerIssue[], appId: string | null): MarkerTicket[] {
  return issues.flatMap((issue) => {
    const described = matches(KIND_LINE, issue.description);
    const commented = issue.comments.flatMap((comment) => matches(KIND_LINE, comment.body));
    const kinds = [...new Set([...described, ...commented])];
    if (!kinds.length) return [];
    const markers = new Set(issue.comments.flatMap((comment) => matches(REVIEW_LINE, comment.body)));
    const checked = issue.completedAt ? issue.comments.find((comment) => matches(REVIEW_LINE, comment.body).includes(`checked ${issue.completedAt}`)) : undefined;
    return [{ ...issue, kinds, filed: described.length > 0 && appId !== null && issue.creatorId === appId, markers, checkedComment: checked?.body ?? null }];
  });
}

// Kinds with two or more tickets that are not canceled or duplicates: nothing is done for them.
export function conflicts(tickets: MarkerTicket[]): Map<string, MarkerTicket[]> {
  const owners = new Map<string, MarkerTicket[]>();
  for (const ticket of tickets) {
    if (DROPPED_TYPES.includes(ticket.statusType)) continue;
    for (const kind of ticket.kinds) owners.set(kind, [...(owners.get(kind) ?? []), ticket]);
  }
  return new Map([...owners].filter(([, list]) => list.length > 1));
}

// ---------------------------------------------------------------------------------------------
// Assessment of Done tickets

export type KindOutcome = { kind: string; outcome: "verified" | "no baseline" | "failed" | "lacks data"; before: number | null; after: number | null };
export type Assessment =
  | { state: "due"; at: number }
  | { state: "checked" | "reopen" | "not enough data"; kinds: KindOutcome[] };

// B = problems in the week before it closed, C = in the second week after it closed, counted only
// where both weeks were read. No baseline (B = 0) is neither verified nor failed.
export function assess(history: History, ticket: { completedAt: string }, kinds: string[], now: number): Assessment {
  const closed = Date.parse(ticket.completedAt);
  if (now < closed + CHECK_AFTER) return { state: "due", at: closed + CHECK_AFTER };
  const groups = byKind(history);
  const before = { from: closed - WEEK, to: closed };
  const after = { from: closed + WEEK, to: closed + CHECK_AFTER };
  const outcomes = kinds.map((kind): KindOutcome => {
    const covered = coverage(history, sourceOf(kind, history), [before, after]);
    if (!covered.complete) return { kind, outcome: "lacks data", before: null, after: null };
    const list = groups.get(kind) ?? [];
    const b = kindWindow(list, before, covered.hosts).count;
    const c = kindWindow(list, after, covered.hosts).count;
    return { kind, outcome: b === 0 ? "no baseline" : c <= b / 2 ? "verified" : "failed", before: b, after: c };
  });
  const state = outcomes.some((found) => found.outcome === "failed") ? "reopen" : outcomes.some((found) => found.outcome === "lacks data") ? "not enough data" : "checked";
  return { state, kinds: outcomes };
}

// The baseline each kind was checked against, from the ticket's `checked` comment; null for a kind
// checked without a baseline or not listed there.
export function checkedBaselines(body: string): Map<string, number | null> {
  const baselines = new Map<string, number | null>();
  for (const match of body.matchAll(CHECKED_KIND_LINE)) baselines.set(match[1].trim(), match[2] === undefined ? null : Number(match[2]));
  return baselines;
}

// A checked ticket's kinds in the last 7 days, once that week starts two weeks after it closed: one
// that is back at RECURRING_MIN or more and above half its baseline (any count without a baseline)
// reopens it.
export function relapse(history: History, ticket: { completedAt: string }, kinds: string[], baselines: Map<string, number | null>, now: number): { state: "later" | "not enough data" | "fine" | "relapse"; kinds: { kind: string; count: number | null; baseline: number | null }[] } {
  const closed = Date.parse(ticket.completedAt);
  const week = { from: now - WEEK, to: now };
  if (week.from < closed + CHECK_AFTER) return { state: "later", kinds: [] };
  const groups = byKind(history);
  let lacking = false;
  const found = kinds.map((kind) => {
    const baseline = baselines.get(kind) ?? null;
    const covered = coverage(history, sourceOf(kind, history), [week]);
    if (!covered.complete) { lacking = true; return { kind, count: null, baseline }; }
    return { kind, count: kindWindow(groups.get(kind) ?? [], week, covered.hosts).count, baseline };
  });
  const back = found.filter((entry) => entry.count !== null && entry.count >= RECURRING_MIN && (entry.baseline === null || entry.count > entry.baseline / 2));
  return { state: back.length ? "relapse" : lacking ? "not enough data" : "fine", kinds: back.length ? back : found };
}

// ---------------------------------------------------------------------------------------------
// Texts

const num = (value: number | null, unit = "") => (value === null ? "unknown" : `${value}${unit}`);
const tally = (value: Tally) => `${value.yes} / ${value.no} / ${value.unknown}`;
const dataNote = (row: KindRow) => (row.coverage.complete ? (row.coverage.excluded.length ? `complete (${row.coverage.hosts!.join(", ")} only)` : "complete") : "not enough data");

function kindTable(rows: KindRow[]): string[] {
  if (!rows.length) return ["- no problems in the last two weeks"];
  return [
    "| Kind | Last 7 days | 7 days before | Still open | Median h to clear | p90 h | Needed the owner (yes / no / unknown) | Plugin acted (yes / no / unknown) | Hours open (all hosts) | Data |",
    "| -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |",
    ...rows.map((row) => `| \`${row.kind}\` | ${row.this.count} | ${row.last.count} | ${row.this.stillOpen} | ${num(row.this.medianHours)} | ${num(row.this.p90Hours)} | ${tally(row.this.owner)} | ${tally(row.this.auto)} | ${row.all.hoursLost} | ${dataNote(row)} |`),
  ];
}

function headlineLines(analysis: Analysis): string[] {
  const { this: now, last } = analysis.headline;
  const partial = (value: Headline) => (value.complete ? "" : " _(not enough data)_");
  const perPr = (value: Headline) => `${num(value.ownerPerMergedPr)} (${value.ownerTrue} of ${num(value.mergedPrs)} merged PRs)${partial(value)}`;
  const share = (value: Headline) => `${value.shareClearedWithoutOwner === null ? "unknown" : `${Math.round(value.shareClearedWithoutOwner * 100)} %`} (${value.clearedWithoutOwner} of ${value.clearedKnownOwner} with known owner, ${value.clearedUnknownOwner} unknown)${partial(value)}`;
  const median = (value: Headline) => `${num(value.medianHoursToClear, " h")}${partial(value)}`;
  return [
    `- Problems that needed you per merged PR (observed owner involvement): ${perPr(now)} — last week ${perPr(last)}`,
    `- Share of problems cleared without you: ${share(now)} — last week ${share(last)}`,
    `- Median time to clear: ${median(now)} — last week ${median(last)}`,
  ];
}

export function ticketDescription(row: KindRow, analysis: Analysis): string {
  const pair = (pick: (value: KindWindow) => string) => `| ${pick(row.this)} | ${pick(row.last)} |`;
  return [
    `Marker: \`${KIND_MARKER} ${row.kind}\``,
    "",
    `The weekly ops review (linear-tickets README, "Ops digest and weekly ops review") saw this kind of ops problem ${row.all.count} times in the 7 days to ${berlin(analysis.windows.this.to)} Berlin. The fix must make it at least twice as rare.`,
    "",
    "| | Last 7 days | 7 days before |",
    "| -- | -- | -- |",
    `| Problems ${pair((value) => String(value.count))}`,
    `| Still open at the end ${pair((value) => String(value.stillOpen))}`,
    `| Median / p90 hours to clear ${pair((value) => `${num(value.medianHours)} / ${num(value.p90Hours)}`)}`,
    `| Needed the owner (yes / no / unknown) ${pair((value) => tally(value.owner))}`,
    `| The plugin acted on it (yes / no / unknown) ${pair((value) => tally(value.auto))}`,
    `| Hours open ${pair((value) => String(value.hoursLost))}`,
    "",
    `Data: ${dataNote(row)}${row.coverage.excluded.length ? `; not counted: ${row.coverage.excluded.join(", ")} (not read often enough)` : ""}. All hosts together: ${row.all.count} problems, ${row.all.hoursLost} hours open.`,
    "",
    "Examples (last 7 days):",
    "",
    ...(row.all.examples.length ? row.all.examples.map((example) => `- \`${example.key}\`${example.ticket ? ` ${example.ticket}` : ""}`) : ["- none"]),
    "",
    `Done when: the weekly count of \`${row.kind}\` is at most half of the week before this ticket closes, measured in the second week after it closes; the review reopens it otherwise.`,
  ].join("\n");
}

function weeklyComment(ticket: MarkerTicket, rows: Map<string, KindRow>, analysis: Analysis, week: string): string {
  const mine = ticket.kinds.flatMap((kind) => (rows.has(kind) ? [rows.get(kind)!] : []));
  return [
    `Marker: \`${REVIEW_MARKER} ${week}\``,
    "",
    `Weekly ops review, 7 days to ${berlin(analysis.windows.this.to)} Berlin, against the 7 days before:`,
    "",
    ...kindTable(mine),
  ].join("\n");
}

function checkedComment(ticket: MarkerTicket, outcomes: KindOutcome[]): string {
  return [
    `Marker: \`${REVIEW_MARKER} checked ${ticket.completedAt}\``,
    "",
    "Ops review: two weeks after this ticket was closed, its kinds of problem got at least twice as rare (week before it closed → second week after):",
    "",
    ...outcomes.map((found) => (found.outcome === "verified" ? `- \`${KIND_MARKER} ${found.kind}\`: verified ${found.before} → ${found.after}` : `- \`${KIND_MARKER} ${found.kind}\`: no baseline`)),
    "",
    "A kind marked \"no baseline\" did not happen in the week before the close, so the fix could not be measured; the review reopens this ticket if it comes back.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Create reservations: a create is written down (with the issue id it will carry) before it is
// sent, so a timeout or crash can never make a second ticket for the kind: Linear refuses a second
// issue with the same id, and a kind with an open reservation is never created under a new id.

export type Reservation = { kind: string; issueId: string; at: string; input: { teamId: string; projectId: string; stateId: string; title: string; description: string } };
const reservationsFile = (directory: string) => join(directory, "review-creates.json");

export async function readReservations(directory: string): Promise<Reservation[]> {
  let raw: string;
  try {
    raw = await readFile(reservationsFile(directory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as { reservations?: Reservation[] };
  if (!Array.isArray(parsed.reservations)) throw new Error(`${reservationsFile(directory)} is not a reservation file; fix or remove it by hand.`);
  return parsed.reservations;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const saveReservations = (directory: string, reservations: Reservation[]) => writeAtomic(reservationsFile(directory), `${JSON.stringify({ reservations }, null, 1)}\n`);

// ---------------------------------------------------------------------------------------------
// Single writer: a PID lock, taken over only from a process of this host that is gone.

export type LockDeps = { pid: number; host: string; alive: (pid: number) => boolean; now: () => number };
const realLock: LockDeps = {
  pid: process.pid, host: hostname(), now: () => Date.now(),
  alive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
};

export async function pidLock<T>(path: string, work: () => Promise<T>, deps: LockDeps = realLock): Promise<T> {
  const mine = JSON.stringify({ pid: deps.pid, host: deps.host, startedAt: iso(deps.now()), token: randomUUID() });
  const create = () => writeFile(path, mine, { flag: "wx", mode: 0o600 });
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = await readFile(path, "utf8").catch(() => null);
    let holder: { pid?: unknown; host?: unknown; startedAt?: unknown } | null = null;
    try { holder = held ? JSON.parse(held) : null; } catch { holder = null; }
    const pid = typeof holder?.pid === "number" ? holder.pid : null;
    if (held === null || pid === null || holder?.host !== deps.host || deps.alive(pid)) {
      throw new Error(`Another ops review holds ${path} (${held === null ? "gone while checking; try again" : pid === null ? "unreadable; remove it by hand once no review runs" : `pid ${pid} on ${String(holder?.host)} since ${String(holder?.startedAt)}`}).`);
    }
    // The holder is gone. Only one run can move this very file aside; one that moved a newer lock
    // (another run took over in between) puts it back and stops.
    const aside = `${path}.${randomUUID()}.dead`;
    await rename(path, aside);
    if ((await readFile(aside, "utf8")) !== held) {
      await link(aside, path).catch(() => undefined);
      await rm(aside, { force: true });
      throw new Error(`Another ops review took over ${path} at the same time.`);
    }
    await rm(aside, { force: true });
    await create();
  }
  try {
    return await work();
  } finally {
    if ((await readFile(path, "utf8").catch(() => null)) === mine) await rm(path, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub: pull requests of tuchel-platform that landed in a window (the headline's denominator).
// The Graphite merge queue lands a stack through its own draft PR and closes the stack's pull
// requests unmerged with the label `externally-merged`; GitHub's `is:merged` counts only the rest.

const run = promisify(execFile);

export async function mergedPullRequests(from: number, to: number): Promise<number | null> {
  const range = `${iso(from).replace(/\.\d{3}Z$/, "Z")}..${iso(to).replace(/\.\d{3}Z$/, "Z")}`;
  try {
    let total = 0;
    for (const query of [`is:merged merged:${range}`, `is:unmerged label:externally-merged closed:${range}`]) {
      const { stdout } = await run("gh", ["api", "-X", "GET", "search/issues", "-f", `q=repo:${GITHUB_REPO} is:pr ${query}`, "--jq", ".total_count"], { timeout: 60_000 });
      const count = Number(stdout.trim());
      if (!Number.isInteger(count) || count < 0) return null;
      total += count;
    }
    return total;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// The two commands (scripts/ops-review.ts wires them to the real host)

export type OpsReader = {
  teamIdByKey(key: string): Promise<string | null>;
  todoStateId(teamId: string): Promise<string | null>;
  projectIdByName(name: string): Promise<string | null>;
  opsMarkerIssues(teamId: string): Promise<OpsMarkerIssue[]>;
  issueById(id: string): Promise<CreatedIssueRef | null>;
  issueStatuses(ids: string[]): Promise<Map<string, IssueStatus>>;
};
export type ReviewDeps = {
  directory: string;
  linear: OpsReader;
  appViewerId: () => Promise<string>;
  mergedPullRequests: (from: number, to: number) => Promise<number | null>;
  teamKey: string;
  now: number;
};

type Prepared = { teamId: string; tickets: MarkerTicket[]; conflicts: Map<string, MarkerTicket[]>; history: History; analysis: Analysis; reservations: Reservation[] };

async function prepare(deps: ReviewDeps): Promise<Prepared> {
  const teamId = await deps.linear.teamIdByKey(deps.teamKey);
  if (!teamId) throw new Error(`Linear has no team ${deps.teamKey}.`);
  const appId = await deps.appViewerId();
  const tickets = markerTickets(await deps.linear.opsMarkerIssues(teamId), appId);
  // The history back to the week before the oldest Done ticket still waiting for its check.
  const waiting = tickets.filter((ticket) => ticket.statusType === "completed" && ticket.completedAt && !ticket.markers.has(`checked ${ticket.completedAt}`) && !ticket.markers.has(`reopen ${ticket.completedAt}`));
  const from = Math.min(deps.now - LOOKBACK, ...waiting.map((ticket) => Date.parse(ticket.completedAt!) - WEEK));
  const history = await readHistory(deps.directory, from, deps.now);
  const [thisWeek, lastWeek] = await Promise.all([deps.mergedPullRequests(deps.now - WEEK, deps.now), deps.mergedPullRequests(deps.now - 2 * WEEK, deps.now - WEEK)]);
  const analysis = analyse(history, deps.now, { this: thisWeek, last: lastWeek }, tickets.flatMap((ticket) => ticket.kinds));
  return { teamId, tickets, conflicts: conflicts(tickets), history, analysis, reservations: await readReservations(deps.directory) };
}

export async function runCollect(deps: ReviewDeps): Promise<string> {
  const { tickets, conflicts: conflicted, analysis, reservations, history } = await prepare(deps);
  const lines = [
    `# Ops review ${weekLabel(deps.now)}: 7 days to ${berlin(deps.now)} Berlin`,
    "",
    `History: ${history.runs.length} digest runs, ${history.occurrences.length} problems, ${[...history.malformed.values()].reduce((sum, value) => sum + value, 0)} malformed lines, ${history.duplicates} duplicate lines dropped.`,
    "",
    "## Headline",
    "",
    ...headlineLines(analysis),
    "",
    "## Kinds (problems that needed attention)",
    "",
    ...kindTable(analysis.rows),
    "",
    `Recurring (${RECURRING_MIN} or more in the last 7 days, all hosts): ${analysis.rows.filter((row) => row.recurring).map((row) => `\`${row.kind}\``).join(", ") || "none"}`,
    "",
    "## Tickets of kinds",
    "",
    ...(tickets.length ? tickets.map((ticket) => `- ${ticket.identifier} (${ticket.url}) ${ticket.statusType}${ticket.completedAt ? ` since ${ticket.completedAt}` : ""}, ${ticket.filed ? "filed" : "adopted"}: ${ticket.kinds.map((kind) => `\`${kind}\``).join(", ")}`) : ["- none"]),
  ];
  if (conflicted.size) lines.push("", "## Conflicts (no action)", "", ...[...conflicted].map(([kind, list]) => `- \`${kind}\`: ${list.map((ticket) => `${ticket.identifier} (${ticket.url})`).join(", ")}`));
  if (reservations.length) lines.push("", "## Create reservations not reconciled", "", ...reservations.map((found) => `- \`${found.kind}\`: issue id ${found.issueId} since ${found.at}; \`file\` looks it up before creating anything`));
  return lines.join("\n");
}

export type FileReport = {
  week: string;
  reconciled: { kind: string; ticket: string; retried: boolean }[];
  created: { kind: string; ticket: string | null }[];
  nextWeek: string[];
  capLeft: number;
  updated: { ticket: string; comment: "written" | "due" | "present" }[];
  checks: { ticket: string; state: string; kinds: KindOutcome[]; due?: string }[];
  relapses: { ticket: string; state: string; kinds: { kind: string; count: number | null; baseline: number | null }[] }[];
  reopened: { ticket: string; marker: string; commented: boolean; moved: boolean }[];
  conflicts: { kind: string; tickets: string[] }[];
  waiting: { kind: string; issueId: string }[];
  trend: boolean;
};

export type FileDeps = ReviewDeps & { writer: OpsWriter; dryRun: boolean; lock?: LockDeps };

export async function runFile(deps: FileDeps): Promise<FileReport> {
  if (deps.dryRun) return fileReview(deps);
  await mkdir(deps.directory, { recursive: true });
  return pidLock(join(deps.directory, "review.lock"), () => fileReview(deps), deps.lock);
}

async function fileReview(deps: FileDeps): Promise<FileReport> {
  const prepared = await prepare(deps);
  const { teamId, tickets, analysis } = prepared;
  const week = weekLabel(deps.now);
  const report: FileReport = { week, reconciled: [], created: [], nextWeek: [], capLeft: 0, updated: [], checks: [], relapses: [], reopened: [], conflicts: [], waiting: [], trend: false };
  report.conflicts = [...prepared.conflicts].map(([kind, list]) => ({ kind, tickets: list.map((ticket) => ticket.identifier) }));
  const stateId = await deps.linear.todoStateId(teamId);
  if (!stateId) throw new Error(`Team ${deps.teamKey} has no unstarted (Todo) state.`);
  const thisWeek = (at: string) => weekLabel(Date.parse(at)) === week;
  const filedThisWeek = new Set(tickets.filter((ticket) => ticket.filed && thisWeek(ticket.createdAt)).map((ticket) => ticket.id));
  const ticketKinds = new Set(tickets.flatMap((ticket) => ticket.kinds));
  const createdNow = new Set<string>();

  // 1. Reservations of earlier runs: the ticket exists (counted in its creation week) or is
  // created now under the same id. A dry run only reports them.
  let reservations = [...prepared.reservations];
  for (const reservation of prepared.reservations) {
    ticketKinds.add(reservation.kind);
    if (deps.dryRun) { report.waiting.push({ kind: reservation.kind, issueId: reservation.issueId }); continue; }
    let found = await deps.linear.issueById(reservation.issueId);
    let retried = false;
    if (!found) {
      retried = true;
      try {
        const created = await deps.writer.createIssue({ ...reservation.input, id: reservation.issueId });
        found = { ...created, createdAt: iso(deps.now) };
      } catch (error) {
        // "Already exists": the first create went through after all.
        found = await deps.linear.issueById(reservation.issueId);
        if (!found) throw error;
      }
    }
    if (thisWeek(found.createdAt)) filedThisWeek.add(found.id);
    createdNow.add(found.id);
    report.reconciled.push({ kind: reservation.kind, ticket: found.url || found.identifier, retried });
    reservations = reservations.filter((entry) => entry.issueId !== reservation.issueId);
    await saveReservations(deps.directory, reservations);
  }

  // 2. New tickets for recurring kinds without one, within this week's cap.
  report.capLeft = Math.max(0, NEW_TICKETS_PER_WEEK - filedThisWeek.size);
  const fresh = analysis.rows.filter((row) => row.recurring && !ticketKinds.has(row.kind));
  const projectId = fresh.length && report.capLeft ? await deps.linear.projectIdByName(PROJECT) : null;
  if (fresh.length && report.capLeft && !projectId) throw new Error(`Linear has no project ${PROJECT}.`);
  for (const [index, row] of fresh.entries()) {
    if (index >= report.capLeft) { report.nextWeek.push(row.kind); continue; }
    const input = { teamId, projectId: projectId!, stateId, title: `Recurring ops problem: ${row.kind}`, description: ticketDescription(row, analysis) };
    if (deps.dryRun) { report.created.push({ kind: row.kind, ticket: null }); continue; }
    const reservation: Reservation = { kind: row.kind, issueId: randomUUID(), at: iso(deps.now), input };
    reservations = [...reservations, reservation];
    await saveReservations(deps.directory, reservations);
    const created = await deps.writer.createIssue({ ...input, id: reservation.issueId });
    createdNow.add(created.id || reservation.issueId);
    report.created.push({ kind: row.kind, ticket: created.url || created.identifier });
    reservations = reservations.filter((entry) => entry.issueId !== reservation.issueId);
    await saveReservations(deps.directory, reservations);
  }

  // 3. Per marker ticket over all its kinds (a kind in conflict is left out).
  const rows = new Map(analysis.rows.map((row) => [row.kind, row]));
  for (const ticket of tickets) {
    if (createdNow.has(ticket.id) || DROPPED_TYPES.includes(ticket.statusType)) continue;
    const kinds = ticket.kinds.filter((kind) => !prepared.conflicts.has(kind));
    if (!kinds.length) continue;
    const scoped = { ...ticket, kinds };
    if (!CLOSED_TYPES.includes(ticket.statusType)) {
      // A ticket filed this week already carries this week's numbers in its description.
      const present = ticket.markers.has(week) || filedThisWeek.has(ticket.id);
      if (!present && !deps.dryRun) await deps.writer.comment(ticket.id, weeklyComment(scoped, rows, analysis, week));
      report.updated.push({ ticket: ticket.identifier, comment: present ? "present" : deps.dryRun ? "due" : "written" });
      continue;
    }
    if (ticket.statusType !== "completed" || !ticket.completedAt) continue;
    const closedAt = ticket.completedAt;
    const reopenedFor = [`reopen ${closedAt}`, `reopen ${closedAt} relapse`].find((marker) => ticket.markers.has(marker));
    if (reopenedFor) {
      // Commented earlier, the move did not happen (a crash, a failed write): only the move.
      report.reopened.push(await reopen(deps, scoped, stateId, reopenedFor, "", []));
      continue;
    }
    if (ticket.checkedComment !== null) {
      const result = relapse(prepared.history, { completedAt: closedAt }, kinds, checkedBaselines(ticket.checkedComment), deps.now);
      report.relapses.push({ ticket: ticket.identifier, state: result.state, kinds: result.kinds });
      if (result.state === "relapse") {
        const lines = result.kinds.map((found) => `- \`${KIND_MARKER} ${found.kind}\`: ${found.count} in the last 7 days, baseline ${found.baseline === null ? "none" : found.baseline}`);
        report.reopened.push(await reopen(deps, scoped, stateId, `reopen ${closedAt} relapse`, "Ops review: a kind this ticket fixed came back (at least 3 in the last 7 days and more than half of its count in the week before the ticket closed).", lines));
      }
      continue;
    }
    const result = assess(prepared.history, { completedAt: closedAt }, kinds, deps.now);
    if (result.state === "due") { report.checks.push({ ticket: ticket.identifier, state: "due", kinds: [], due: iso(result.at) }); continue; }
    report.checks.push({ ticket: ticket.identifier, state: result.state, kinds: result.kinds });
    if (result.state === "checked" && !deps.dryRun) await deps.writer.comment(ticket.id, checkedComment(scoped, result.kinds));
    if (result.state === "reopen") {
      const lines = result.kinds.map((found) => `- \`${KIND_MARKER} ${found.kind}\`: ${found.outcome}${found.before === null ? "" : ` (${found.before} in the week before it closed → ${found.after} in the second week after)`}`);
      report.reopened.push(await reopen(deps, scoped, stateId, `reopen ${closedAt}`, "Ops review: two weeks after this ticket was closed, at least one of its kinds did not get twice as rare.", lines));
    }
  }

  // 4. The digest document's Trend section reads this.
  if (!deps.dryRun) {
    await writeTrend(deps.directory, analysis, week);
    report.trend = true;
  }
  return report;
}

// (a) the comment with its marker unless it is there, (b) the state read again right before the
// move, which happens only while the ticket is still Done (a cancel in between is respected; Linear
// has no compare-and-set, so a change in the milliseconds between read and move is not).
async function reopen(deps: FileDeps, ticket: MarkerTicket, stateId: string, marker: string, why: string, lines: string[]): Promise<FileReport["reopened"][number]> {
  const result = { ticket: ticket.identifier, marker, commented: false, moved: false };
  if (deps.dryRun) return result;
  if (!ticket.markers.has(marker)) {
    await deps.writer.comment(ticket.id, [`Marker: \`${REVIEW_MARKER} ${marker}\``, "", why, "", ...lines, "", "Moved back to Todo by the weekly ops review."].join("\n"));
    result.commented = true;
  }
  const status = (await deps.linear.issueStatuses([ticket.id])).get(ticket.id);
  if (status?.statusType === "completed") {
    await deps.writer.moveToState(ticket.id, stateId);
    result.moved = true;
  }
  return result;
}

export type Trend = {
  week: string; generatedAt: string;
  window: { this: { from: string; to: string }; last: { from: string; to: string } };
  headline: { this: Headline; last: Headline };
  kinds: { kind: string; thisWeek: number; lastWeek: number; complete: boolean }[];
};

export function trendOf(analysis: Analysis, week: string): Trend {
  const top = [...analysis.rows].filter((row) => row.this.count || row.last.count).sort((a, b) => b.this.count - a.this.count || b.last.count - a.last.count || a.kind.localeCompare(b.kind)).slice(0, TREND_KINDS);
  const span = (window: Window) => ({ from: iso(window.from), to: iso(window.to) });
  return {
    week, generatedAt: iso(analysis.now), window: { this: span(analysis.windows.this), last: span(analysis.windows.last) }, headline: analysis.headline,
    kinds: top.map((row) => ({ kind: row.kind, thisWeek: row.this.count, lastWeek: row.last.count, complete: row.coverage.complete })),
  };
}

async function writeTrend(directory: string, analysis: Analysis, week: string): Promise<void> {
  await writeAtomic(join(directory, "trend.json"), `${JSON.stringify(trendOf(analysis, week), null, 1)}\n`);
}

export function renderFileReport(report: FileReport, dryRun: boolean): string {
  const lines = [`Ops review ${report.week}${dryRun ? " (dry run: nothing written)" : ""}`];
  for (const found of report.reconciled) lines.push(`reconciled: \`${found.kind}\` → ${found.ticket}${found.retried ? " (created now under its reserved id)" : ""}`);
  for (const found of report.waiting) lines.push(`reservation: \`${found.kind}\` (issue id ${found.issueId}) is looked up before anything is created`);
  lines.push(`new tickets left this week: ${report.capLeft}`);
  for (const found of report.created) lines.push(`create: Recurring ops problem: ${found.kind}${found.ticket ? ` → ${found.ticket}` : ""}`);
  for (const kind of report.nextWeek) lines.push(`next week (cap reached): \`${kind}\``);
  for (const found of report.updated) lines.push(`update: ${found.ticket} ${found.comment === "present" ? "weekly comment already there" : found.comment === "due" ? "weekly comment to write" : "weekly comment written"}`);
  for (const found of report.checks) lines.push(`check: ${found.ticket} ${found.state}${found.due ? ` (from ${found.due})` : ""}${found.kinds.map((kind) => `\n  ${kind.kind}: ${kind.outcome}${kind.before === null ? "" : ` ${kind.before} → ${kind.after}`}`).join("")}`);
  for (const found of report.relapses) lines.push(`relapse look: ${found.ticket} ${found.state}${found.kinds.map((kind) => `\n  ${kind.kind}: ${kind.count === null ? "not enough data" : kind.count} (baseline ${kind.baseline === null ? "none" : kind.baseline})`).join("")}`);
  for (const found of report.reopened) lines.push(`reopen: ${found.ticket} (${found.marker})${dryRun ? "" : `: comment ${found.commented ? "written" : "already there"}, ${found.moved ? "moved to Todo" : "not moved (no longer Done)"}`}`);
  for (const found of report.conflicts) lines.push(`conflict (no action): \`${found.kind}\` has ${found.tickets.join(", ")}`);
  if (report.trend) lines.push("trend.json written");
  return lines.join("\n");
}
