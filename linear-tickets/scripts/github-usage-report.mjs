// GitHub usage report (README, "GitHub usage"): reads the meter's day files, the router's
// calls.jsonl and the gh guard's hour counters, and prints who spends the bot account's GitHub
// budget — per UTC hour by host, caller and account; per GitHub rate-limit window (lower
// bounds, never sums); the guard counters' unattributed remainder; and the router host's
// agent-session invocations. Read-only; plain ESM with Node built-ins only.
//
//   node scripts/github-usage-report.mjs [--from <ISO>] [--to <ISO>] [--input <file or dir>]…
//        [--guard <dir>] [--guard-host <name>] [--json]
//
// `--input` (repeatable) takes files or directories (every *.jsonl directly inside). Defaults:
// --to now, --from 24 h earlier; the inputs $PASEO_HOME/linear-tickets/github-usage, its
// `laptop/` subdirectory (the copied laptop files) and $PASEO_HOME/github-router/calls.jsonl
// when present; --guard $PASEO_HOME/gh-guard when present; --guard-host this host's name (the
// host whose meter records the guard counters belong to).
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOUR_MS = 3_600_000;
const CLASSES = ["charged", "refused", "free", "uncertain", "cached"];
// The gh guard's byte counters: one file per UTC hour, its size = daemon bot-read invocations.
const COUNTER_FILE = /^bot\.(\d{4})(\d{2})(\d{2})(\d{2})$/;
const SELF = fileURLToPath(import.meta.url);

function paseoHome(env = process.env) {
  return env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
}

function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------- arguments

export function parseArgs(argv) {
  const options = { from: null, to: null, inputs: [], guard: null, guardHost: null, json: false };
  const read = (flag, index) => {
    if (argv[index].startsWith(`${flag}=`) && argv[index].length > flag.length + 1) return [argv[index].slice(flag.length + 1), index];
    if (argv[index + 1] === undefined) throw new Error(`${flag} needs a value`);
    return [argv[index + 1], index + 1];
  };
  const flags = ["--from", "--to", "--input", "--guard", "--guard-host"];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const flag = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!flags.includes(flag)) throw new Error(`unknown argument: ${arg}`);
    const [value, next] = read(flag, i);
    i = next;
    if (flag === "--from") options.from = value;
    else if (flag === "--to") options.to = value;
    else if (flag === "--input") options.inputs.push(value);
    else if (flag === "--guard") options.guard = value;
    else options.guardHost = value;
  }
  return options;
}

// ---------------------------------------------------------------- inputs

// Every input path's JSONL lines, classified by shape. `meter` is deduplicated by (host, call)
// so the same day file passed twice (or a copied file passed beside its original) counts once.
export function readInputs(paths) {
  const meter = new Map();
  const runs = [];
  const router = [];
  let skipped = 0;
  for (const path of paths) {
    for (const file of inputFiles(path)) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          skipped++;
          continue;
        }
        const shape = classify(record);
        if (shape === "run") runs.push(record);
        else if (shape === "router") router.push(record);
        else if (shape === null) skipped++;
        else {
          const key = `${record.host}\u0000${record.call}`;
          if (!meter.has(key)) meter.set(key, record);
        }
      }
    }
  }
  return { meter: [...meter.values()], runs, router, skipped };
}

function inputFiles(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(path, entry.name))
    .sort();
}

// One line's shape: a run record, a router line, a meter record, or nothing known (skipped).
function classify(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return null;
  if (record.kind === "run") return "run";
  if ("agent" in record) return "router";
  if (typeof record.host === "string" && typeof record.call === "string" && Array.isArray(record.responses)) return "meter";
  return null;
}

// The guard's bot counters as hour key (YYYY-MM-DDTHH, UTC) → file size in bytes.
export function readGuard(dir) {
  const counters = new Map();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return counters;
  }
  for (const name of names) {
    const match = COUNTER_FILE.exec(name);
    if (!match) continue;
    let stat;
    try {
      stat = statSync(join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    counters.set(`${match[1]}-${match[2]}-${match[3]}T${match[4]}`, stat.size);
  }
  return counters;
}

// ---------------------------------------------------------------- report

export function buildReport({ meter, runs, router, guard, guardHost, from, to, skipped = 0 }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const fromIso = typeof from === "string" ? from : new Date(fromMs).toISOString();
  const toIso = typeof to === "string" ? to : new Date(toMs).toISOString();
  const within = (ms) => Number.isFinite(ms) && ms >= fromMs && ms < toMs;

  // The account a router-host meter record ran on: the router's lines with the same call id.
  // One distinct account → it; several → mixed; none → unknown.
  const routedAccounts = new Map();
  for (const line of router) {
    if (typeof line.call !== "string" || !line.call) continue;
    const accounts = routedAccounts.get(line.call) ?? new Set();
    accounts.add(line.account ?? "unknown");
    routedAccounts.set(line.call, accounts);
  }
  const accountOf = (record) => {
    if (record.basis !== "router") return record.account ?? "unknown";
    const accounts = routedAccounts.get(record.call);
    if (!accounts?.size) return "unknown";
    return accounts.size === 1 ? [...accounts][0] : "mixed";
  };

  // 1. Responses by class, invocations, GraphQL requests and writes, per UTC hour × host ×
  // caller × account. An invocation (pages unknown) is one call and no response.
  const hourRows = new Map();
  for (const record of meter) {
    const ms = Date.parse(record.at);
    if (!within(ms)) continue;
    const hour = hourKey(ms);
    const host = record.host;
    const caller = record.caller ?? "unknown";
    const account = accountOf(record);
    const key = `${hour}\u0000${host}\u0000${caller}\u0000${account}`;
    let row = hourRows.get(key);
    if (!row) {
      row = { hour, host, caller, account, charged: 0, refused: 0, free: 0, uncertain: 0, cached: 0, invocations: 0, graphql: 0, writes: 0 };
      hourRows.set(key, row);
    }
    if (record.command === "api graphql") row.graphql++;
    if (record.write === true) row.writes++;
    if (record.pages === "unknown") row.invocations++;
    else for (const response of record.responses) if (CLASSES.includes(response?.class)) row[response.class]++;
  }
  const hours = [...hourRows.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.host.localeCompare(b.host) || a.caller.localeCompare(b.caller) || a.account.localeCompare(b.account));

  // 2. Run records and their summed size, per UTC hour × host × caller.
  const runRows = new Map();
  for (const record of runs) {
    const ms = Date.parse(record.at);
    if (!within(ms)) continue;
    const hour = hourKey(ms);
    const host = record.host ?? "unknown";
    const caller = record.caller ?? "unknown";
    const key = `${hour}\u0000${host}\u0000${caller}`;
    let row = runRows.get(key);
    if (!row) {
      row = { hour, host, caller, runs: 0, size: {} };
      runRows.set(key, row);
    }
    row.runs++;
    for (const [field, count] of Object.entries(record.size ?? {})) {
      if (typeof count === "number" && Number.isFinite(count)) row.size[field] = (row.size[field] ?? 0) + count;
    }
  }
  const runList = [...runRows.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.host.localeCompare(b.host) || a.caller.localeCompare(b.caller));

  // 3. GitHub rate-limit windows: per account × resource × reset. maxUsed is the highest `used`
  // any host observed in the window (the highest, never a sum: a lower bound of the window's
  // final use). The window runs [reset − 1 h, reset), which is not a calendar hour.
  const windowRows = new Map();
  for (const record of meter) {
    const ms = Date.parse(record.at);
    if (!within(ms)) continue;
    const account = accountOf(record);
    const caller = record.caller ?? "unknown";
    for (const response of record.responses) {
      if (!Number.isFinite(response?.reset)) continue;
      const resource = response.resource ?? "unknown";
      const key = `${account}\u0000${resource}\u0000${response.reset}`;
      let window = windowRows.get(key);
      if (!window) {
        window = { account, resource, reset: response.reset, maxUsed: null, charged: 0, uncertain: 0, callers: new Map() };
        windowRows.set(key, window);
      }
      if (response.class === "charged" || response.class === "uncertain") {
        window[response.class]++;
        const counts = window.callers.get(caller) ?? { charged: 0, uncertain: 0 };
        counts[response.class]++;
        window.callers.set(caller, counts);
      }
      if (response.class !== "cached" && Number.isFinite(response.used) && (window.maxUsed === null || response.used > window.maxUsed)) window.maxUsed = response.used;
    }
  }
  const windows = [...windowRows.values()]
    .map((window) => {
      const complete = window.reset * 1000 - HOUR_MS >= fromMs && window.reset * 1000 <= toMs;
      const unattributed = window.maxUsed === null ? null : window.maxUsed - window.charged - window.uncertain;
      // A window without any usable `used` cannot be bounded either, so it stays incomplete
      // rather than printing a number; the other marks are as specified.
      const status = !complete || unattributed === null ? "incomplete" : unattributed < 0 ? "inconsistent" : "ok";
      return { window, unattributed, status };
    })
    .sort((a, b) => a.window.reset - b.window.reset || a.window.account.localeCompare(b.window.account) || a.window.resource.localeCompare(b.window.resource));

  // 4. GraphQL points per caller, per ok window: an allocation assuming equal cost per request
  // and complete coverage — an estimate, never a measurement.
  const graphqlEstimate = windows
    .filter(({ window, status }) => status === "ok" && window.resource === "graphql")
    .map(({ window }) => {
      const total = window.charged + window.uncertain;
      const entries = [...window.callers]
        .map(([caller, counts]) => ({
          caller,
          requests: counts.charged + counts.uncertain,
          points: round1(((counts.charged + counts.uncertain) / total) * window.maxUsed),
        }))
        .sort((a, b) => a.caller.localeCompare(b.caller));
      return { account: window.account, resource: window.resource, reset: window.reset, maxUsed: window.maxUsed, entries };
    });

  // 5. The guard host's counters against its bot meter records: what the guard counted and the
  // meter did not see is the unattributed daemon bot-read share.
  const guardBotRecords = new Map();
  for (const record of meter) {
    const ms = Date.parse(record.at);
    if (!within(ms) || record.host !== guardHost || accountOf(record) !== "bot") continue;
    const hour = hourKey(ms);
    guardBotRecords.set(hour, (guardBotRecords.get(hour) ?? 0) + 1);
  }
  const guardRows = [];
  for (const [hour, counter] of guard ?? new Map()) {
    const hourMs = Date.parse(`${hour}:00:00.000Z`);
    if (!(hourMs >= fromMs && hourMs + HOUR_MS <= toMs)) continue;
    const count = guardBotRecords.get(hour) ?? 0;
    const unattributed = counter - count;
    guardRows.push({ hour, counter, meter: count, unattributed: unattributed < 0 ? null : unattributed, status: unattributed < 0 ? "inconsistent" : "ok" });
  }
  guardRows.sort((a, b) => a.hour.localeCompare(b.hour));

  // 6. Router lines: agent ids are agent-session traffic beside the meter; the daemon/plugin
  // sentinels are the meter's or Paseo's own calls, and those without a meter record are
  // invocations outside the meter.
  const callIds = new Set(meter.map((record) => record.call));
  const agentSessions = new Map();
  const outsideMeter = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const line of router) {
    const ms = Date.parse(line.at);
    if (!within(ms)) continue;
    const hour = hourKey(ms);
    const account = line.account ?? "unknown";
    if (typeof line.agent === "string" && line.agent && line.agent !== "daemon" && line.agent !== "plugin") bump(agentSessions, `${hour}\u0000${account}`);
    else if ((line.agent === "daemon" || line.agent === "plugin") && !(typeof line.call === "string" && callIds.has(line.call))) bump(outsideMeter, `${hour}\u0000${account}`);
  }
  const routerRows = (map) =>
    [...map]
      .map(([key, invocations]) => {
        const [hour, account] = key.split("\u0000");
        return { hour, account, invocations };
      })
      .sort((a, b) => a.hour.localeCompare(b.hour) || a.account.localeCompare(b.account));

  return {
    from: fromIso,
    to: toIso,
    skipped,
    hours,
    runs: runList,
    windows: windows.map(({ window, unattributed, status }) => ({
      account: window.account,
      resource: window.resource,
      reset: window.reset,
      maxUsed: window.maxUsed,
      charged: window.charged,
      uncertain: window.uncertain,
      unattributed: status === "ok" ? unattributed : null,
      status,
    })),
    graphqlEstimate,
    guard: guardRows,
    router: { agentSessions: routerRows(agentSessions), outsideMeter: routerRows(outsideMeter) },
  };
}

// ---------------------------------------------------------------- text

function renderTable(columns, rows) {
  if (!rows.length) return [];
  const cells = rows.map((row) => columns.map((column) => String(column.value(row))));
  const widths = columns.map((column, index) => Math.max(column.header.length, ...cells.map((row) => row[index].length)));
  const line = (values) => values.map((value, index) => value.padEnd(widths[index])).join("  ").replace(/\s+$/, "");
  return [line(columns.map((column) => column.header)), ...cells.map(line)];
}

export function formatReport(report) {
  const lines = [];
  lines.push('Method: responses are counted from GitHub\'s headers where the meter read them; "uncertain" = a cache may have answered; invocations have unknown pages; windows are lower bounds (maxUsed is the highest "used" seen on any host, never a sum; unattributed is what no counted response explains).');
  lines.push(`Range: ${report.from} .. ${report.to} (records with from <= at < to; UTC hours; ${report.skipped} unparsable line(s) skipped)`);
  const section = (title, body) => {
    lines.push("", title, ...(body.length ? body : ["none"]));
  };

  section(
    "By UTC hour × host × caller × account — responses by class, invocations, GraphQL requests and writes:",
    renderTable(
      [
        { header: "hour", value: (row) => row.hour },
        { header: "host", value: (row) => row.host },
        { header: "caller", value: (row) => row.caller },
        { header: "account", value: (row) => row.account },
        { header: "charged", value: (row) => row.charged },
        { header: "refused", value: (row) => row.refused },
        { header: "free", value: (row) => row.free },
        { header: "uncertain", value: (row) => row.uncertain },
        { header: "suspected cache", value: (row) => row.cached },
        { header: "invocations", value: (row) => row.invocations },
        { header: "graphql", value: (row) => row.graphql },
        { header: "writes", value: (row) => row.writes },
      ],
      report.hours,
    ),
  );

  const sizeFields = [...new Set(report.runs.flatMap((row) => Object.keys(row.size)))].sort();
  section(
    "Runs by UTC hour × host × caller — run records and their summed size:",
    renderTable(
      [
        { header: "hour", value: (row) => row.hour },
        { header: "host", value: (row) => row.host },
        { header: "caller", value: (row) => row.caller },
        { header: "runs", value: (row) => row.runs },
        ...sizeFields.map((field) => ({ header: field, value: (row) => row.size[field] ?? 0 })),
      ],
      report.runs,
    ),
  );

  section(
    'GitHub rate-limit windows by account × resource × reset — this is GitHub\'s reset window, NOT a calendar hour (the window starts one hour before its reset); maxUsed is the highest "used" seen on any host, a lower bound of the window\'s final use:',
    renderTable(
      [
        { header: "account", value: (row) => row.account },
        { header: "resource", value: (row) => row.resource },
        { header: "reset (UTC)", value: (row) => new Date(row.reset * 1000).toISOString() },
        { header: "maxUsed", value: (row) => row.maxUsed ?? "–" },
        { header: "charged", value: (row) => row.charged },
        { header: "uncertain", value: (row) => row.uncertain },
        { header: "unattributed", value: (row) => (row.status === "ok" ? row.unattributed ?? "–" : row.status) },
      ],
      report.windows,
    ),
  );

  const estimateLines = [];
  for (const estimate of report.graphqlEstimate) {
    estimateLines.push(`window ${estimate.account} ${estimate.resource} reset ${new Date(estimate.reset * 1000).toISOString()} maxUsed ${estimate.maxUsed}`);
    const entries = renderTable(
      [
        { header: "caller", value: (row) => row.caller },
        { header: "requests", value: (row) => row.requests },
        { header: "points", value: (row) => row.points.toFixed(1) },
      ],
      estimate.entries,
    );
    estimateLines.push(...(entries.length ? entries : ["no charged or uncertain GraphQL responses in this window"]));
  }
  section("GraphQL points per caller — an estimate assuming equal cost per request and complete coverage; not a measurement:", estimateLines);

  section(
    "Guard counters per UTC hour — the guard host's byte counters against its bot meter records:",
    renderTable(
      [
        { header: "hour", value: (row) => row.hour },
        { header: "counter", value: (row) => row.counter },
        { header: "meter", value: (row) => row.meter },
        { header: "unattributed daemon bot-read invocations", value: (row) => (row.status === "ok" ? row.unattributed : row.status) },
      ],
      report.guard,
    ),
  );

  section(
    "Router lines (calls.jsonl) — agent-session invocations (beside the table, not added) by UTC hour × account:",
    renderTable(
      [
        { header: "hour", value: (row) => row.hour },
        { header: "account", value: (row) => row.account },
        { header: "invocations", value: (row) => row.invocations },
      ],
      report.router.agentSessions,
    ),
  );
  section(
    "Router lines (calls.jsonl) — daemon invocations outside the meter by UTC hour × account:",
    renderTable(
      [
        { header: "hour", value: (row) => row.hour },
        { header: "account", value: (row) => row.account },
        { header: "invocations", value: (row) => row.invocations },
      ],
      report.router.outsideMeter,
    ),
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------- CLI

function main() {
  const options = parseArgs(process.argv.slice(2));
  const to = options.to ?? new Date().toISOString();
  const from = options.from ?? new Date(Date.parse(to) - 24 * HOUR_MS).toISOString();
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) throw new Error("--from and --to must be ISO timestamps");
  const home = paseoHome();
  const usage = join(home, "linear-tickets", "github-usage");
  const laptop = join(usage, "laptop");
  const calls = join(home, "github-router", "calls.jsonl");
  const inputs = options.inputs.length
    ? options.inputs
    : [usage, ...(existsSync(laptop) ? [laptop] : []), ...(existsSync(calls) ? [calls] : [])];
  const guardDir = options.guard ?? join(home, "gh-guard");
  const guard = existsSync(guardDir) ? readGuard(guardDir) : new Map();
  const guardHost = options.guardHost ?? hostname();
  const input = readInputs(inputs);
  const report = buildReport({ ...input, guard, guardHost, from, to });
  process.stdout.write((options.json ? JSON.stringify(report, null, 2) : formatReport(report)) + "\n");
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (process.argv[1] && real(process.argv[1]) === real(SELF)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`github-usage-report: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
