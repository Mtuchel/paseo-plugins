// The GitHub usage meter's core (README, "GitHub usage"): plain ESM so that both the server
// (in-process, in front of ghJson) and scripts/gh-meter.mjs (in front of the repo scripts' `gh`,
// run by `node` without a loader) share one reading of a gh call.
//
// A call is either intercepted (`gh api` whose output gh prints untransformed: the meter reads
// the response's status line and headers) or untouched (everything else: counted as one
// invocation whose pages are unknown). Intercepted calls without the caller's own `--include`
// get one added, and the header block is cut off again before the caller sees the output, so
// the caller gets exactly the bytes gh would have printed without it. A record never holds
// arguments, bodies or tokens.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const METER_ENV = {
  // `<caller>: <script>` for a repo script's gh calls; inherited by its child processes.
  caller: "LINEAR_TICKETS_GH_CALLER",
  // The poll or backstop run the call belongs to (`<caller>@<start ISO>`).
  run: "LINEAR_TICKETS_GH_RUN",
  // The meter's id for one call; the account router writes it on its calls.jsonl line.
  call: "LINEAR_TICKETS_GH_CALL",
  // The absolute gh the meter runs (the guard, the router or a plain gh).
  next: "LINEAR_TICKETS_GH_NEXT",
  // The wrapper's directory, taken off PATH for the gh behind the meter.
  meterDir: "LINEAR_TICKETS_GH_METER_DIR",
  // How the account of a call is known: "guard rule", "router" or "none".
  basis: "LINEAR_TICKETS_GH_BASIS",
  // Where the day files go.
  dir: "LINEAR_TICKETS_USAGE_DIR",
};

const TRANSFORMS = new Set(["--jq", "-q", "--template", "-t", "--slurp", "--silent"]);
// gh flags that take a value, so the value is never read as a command word.
const VALUE_FLAGS = new Set(["-R", "--repo", "--hostname", "--jq", "-q", "--template", "-t", "--header", "-H", "--preview", "-p", "--paginate-limit", "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input", "--cache", "--json"]);
// Commands that never reach GitHub's API budget: not recorded.
const LOCAL = new Set(["auth", "config", "alias", "help", "completion", "extension", "version"]);
const JSON_TYPE = /^application\/(?:json|vnd\.github(?:\.[\w.-]+)?\+json)$/i;

// What one gh call is. `mode`: "include" (the meter adds `--include` and strips it again),
// "own" (the caller asked for `--include`: read, passed through untouched) or "untouched".
export function meterShape(args) {
  const words = [];
  let commandIndex = -1, method = "", fields = false, input = false, include = false, transform = false, paginate = false, cache = false, acceptOk = true;
  // Over every argument, flag values included (the loop below skips those).
  const mutation = args.some((arg) => /mutation/i.test(arg));
  const queryFile = args.some((arg) => /^(?:--[\w-]+=)?query=@/.test(arg));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = arg.startsWith("-") ? arg.replace(/=.*$/s, "") : null;
    const inline = flag !== null && arg.includes("=") && arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1) : null;
    if (flag === null) {
      if (!words.length) commandIndex = i;
      words.push(arg);
      continue;
    }
    if (TRANSFORMS.has(flag)) transform = true;
    if (flag === "--include" || (flag === "-i" && words[0] === "api")) include = true;
    if (flag === "--paginate") paginate = inline === null || !/^(?:0|f|false)$/i.test(inline);
    if (flag === "--cache") cache = true;
    if (flag === "--input") input = true;
    if (["-f", "-F", "--field", "--raw-field"].includes(flag) || /^-[fF]./.test(arg)) fields = true;
    if (/^-X./.test(arg)) method = arg.slice(2);
    const value = inline ?? (VALUE_FLAGS.has(arg) ? args[i + 1] ?? "" : null);
    if (flag === "-X" || flag === "--method") method = value ?? method;
    if ((flag === "-H" || flag === "--header") && value !== null) {
      const accept = /^\s*accept\s*:\s*(.*)$/i.exec(value);
      if (accept && !accept[1].split(",").every((type) => JSON_TYPE.test(type.trim().replace(/;.*$/, "")))) acceptOk = false;
    }
    if (VALUE_FLAGS.has(arg)) i++;
  }
  const [command = "", action = ""] = words;
  const graphql = command === "api" && action === "graphql";
  // The gh guard's read rule (TUC-263): GraphQL without a mutation or a document from a file or
  // stdin, a REST GET without fields or input, and gh's plain reads.
  let read = false;
  if (command === "api") read = graphql ? !input && !queryFile && !mutation : !fields && !input && (!method || method.toUpperCase() === "GET");
  else if (command === "pr") read = ["view", "list", "status", "checks", "diff"].includes(action);
  else if (command === "repo") read = action === "view";
  else if (command === "run") read = ["view", "list"].includes(action);
  else if (command === "search") read = true;
  const apiMethod = command === "api" ? (method || (fields || input ? "POST" : "GET")).toUpperCase() : null;
  const mode = command !== "api" || transform || paginate || !acceptOk ? "untouched" : include ? "own" : "include";
  return {
    command: command === "api" ? (graphql ? "api graphql" : "api") : [command, action].filter(Boolean).join(" "),
    commandIndex,
    method: apiMethod,
    write: !read,
    graphql,
    cache,
    local: !command || LOCAL.has(command) || ["--version", "-v", "--help", "-h"].includes(args[0] ?? ""),
    mode,
  };
}

// The arguments gh runs with: `--include` right after `api` when the meter reads the headers.
export function meteredArgs(args, shape) {
  if (shape.mode !== "include") return args;
  return [...args.slice(0, shape.commandIndex + 1), "--include", ...args.slice(shape.commandIndex + 1)];
}

// The response's status line and headers at the start of `output` (a string or a Buffer), and
// the bytes after them. gh prints `HTTP/<v> <code> <text>\n`, then `Name: value\r\n` lines and a
// blank line. Null block: the output does not start with one (gh failed before any response).
export function splitIncluded(output) {
  const text = (start, end) => (typeof output === "string" ? output.slice(start, end) : output.subarray(start, end).toString("latin1"));
  if (text(0, 5) !== "HTTP/") return { block: null, body: output };
  let at = output.indexOf("\n");
  if (at < 0) return { block: null, body: output };
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(text(0, at))?.[1] ?? 0);
  const headers = new Map();
  at += 1;
  for (;;) {
    const end = output.indexOf("\n", at);
    if (end < 0) return { block: null, body: output };
    const line = text(at, end).replace(/\r$/, "");
    at = end + 1;
    if (!line) break;
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { block: { status, headers }, body: typeof output === "string" ? output.slice(at) : output.subarray(at) };
}

const number = (value) => (value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

// One HTTP response as recorded. `class`: "free" (304), "refused" (GitHub's rate limit), "charged"
// (no cache can have answered), "uncertain" (a cache may have: the router adds `--cache 30s`, or
// the caller asked for one) or "cached" (uncertain, and GitHub's `date` is more than 2 s older
// than the call: a suspected cache hit). `text`: the body's start and gh's stderr, only searched
// for GitHub's rate-limit wording.
export function responseOf(block, { cachePossible, startedAt, text = "" }) {
  const header = (name) => block.headers.get(name);
  const remaining = number(header("x-ratelimit-remaining"));
  const refused = (block.status === 403 || block.status === 429) && (remaining === 0 || /rate limit/i.test(text));
  const date = Date.parse(header("date") ?? "");
  const kind = block.status === 304 ? "free"
    : refused ? "refused"
    : !cachePossible ? "charged"
    : Number.isFinite(date) && date < startedAt - 2000 ? "cached" : "uncertain";
  const response = {
    status: block.status,
    class: kind,
    resource: header("x-ratelimit-resource") ?? null,
    used: number(header("x-ratelimit-used")),
    remaining,
    limit: number(header("x-ratelimit-limit")),
    reset: number(header("x-ratelimit-reset")),
  };
  const retryAfter = number(header("retry-after"));
  return retryAfter === null ? response : { ...response, retryAfter };
}

// The account a call ran on, from the routing, never from timing. Guard host: the gh guard's rule
// (a daemon descendant without PASEO_AGENT_ID reads on the bot when its login is set up; writes
// stay on the owner). Router host: unknown here, joined from the router's calls.jsonl by `call`.
export function accountOf(basis, shape, env = process.env) {
  if (basis === "guard rule") {
    const home = env.PASEO_HOME || join(homedir(), ".paseo");
    return { account: !shape.write && !env.PASEO_AGENT_ID && botLogin(home) ? "bot" : "owner", basis };
  }
  return { account: "unknown", basis: basis === "router" ? "router" : "none" };
}

// Whether the bot's gh login is set up (the guard reads on it only then); checked once a minute.
let botLoginKnown = null;
function botLogin(home) {
  if (botLoginKnown?.home === home && Date.now() - botLoginKnown.at < 60_000) return botLoginKnown.present;
  botLoginKnown = { home, at: Date.now(), present: existsSync(join(home, "gh-bot", "hosts.yml")) };
  return botLoginKnown.present;
}

export function usageDir(env = process.env) {
  if (env[METER_ENV.dir]) return env[METER_ENV.dir];
  const home = env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
  return join(home, "linear-tickets", "github-usage");
}

export function usageFile(dir, at) {
  return join(dir, `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
}

const MAX_LINE = 4000;

// One record as one line under 4 KB: a single O_APPEND write, so concurrent writers never
// interleave. A record that would be longer keeps only its first responses.
export function usageLine(record) {
  let line = JSON.stringify(record);
  if (line.length > MAX_LINE && Array.isArray(record.responses)) {
    const responses = [...record.responses];
    while (responses.length && line.length > MAX_LINE) {
      responses.pop();
      line = JSON.stringify({ ...record, responses, truncated: record.responses.length - responses.length });
    }
  }
  return `${line.slice(0, MAX_LINE)}\n`;
}

// Appends a record; a failure only loses the record, never the call.
export function appendUsage(dir, record) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(usageFile(dir, Date.parse(record.at) || Date.now()), usageLine(record), { mode: 0o600 });
  } catch {
    // Skipped: the call's output, exit code and signal are unchanged.
  }
}

// PATH without the meter's own directory, so the gh behind the meter never finds the meter.
export function withoutDir(path, dir) {
  if (!dir) return path ?? "";
  const clean = dir.replace(/\/+$/, "");
  return (path ?? "").split(":").filter((entry) => entry && entry.replace(/\/+$/, "") !== clean).join(":");
}
