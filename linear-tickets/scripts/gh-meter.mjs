// The GitHub usage meter in front of the repo scripts' `gh` (README, "GitHub usage"). The plugin
// writes `$PASEO_HOME/linear-tickets/gh-meter/gh` (`exec <node> <this script> "$@"`) and puts its
// directory first on the scripts' PATH. It runs the gh behind it ($LINEAR_TICKETS_GH_NEXT, or the
// first gh on PATH without the meter's directory) with the same arguments, stdin and stderr,
// passes its signals on, and ends with its exit code or signal. Stdout reaches the caller as gh
// printed it; for an intercepted call (see server/gh-meter-core.mjs) the header block the meter
// asked for is cut off first. One record per call goes to the day file.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountOf, appendUsage, meteredArgs, meterShape, METER_ENV, responseOf, splitIncluded, usageDir, withoutDir } from "../server/gh-meter-core.mjs";

const SELF = fileURLToPath(import.meta.url);

function real(path) {
  try { return realpathSync(path); } catch { return path; }
}

// The gh behind the meter: never the meter itself or its wrapper.
export function target(env, path) {
  const meterDir = env[METER_ENV.meterDir] ? real(env[METER_ENV.meterDir]) : null;
  const self = (candidate) => {
    const resolved = real(candidate);
    return resolved === real(SELF) || (meterDir !== null && (resolved === join(meterDir, "gh") || resolved.startsWith(`${meterDir}/`)));
  };
  const next = env[METER_ENV.next];
  if (next) {
    if (isAbsolute(next)) return self(next) ? null : next;
    return lookup(next, path, self);
  }
  return lookup("gh", path, self);
}

function lookup(command, path, self) {
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (!self(candidate)) return candidate;
    } catch {}
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const env = process.env;
  const path = withoutDir(env.PATH, env[METER_ENV.meterDir]);
  const gh = target(env, path);
  if (!gh) {
    process.stderr.write("gh-meter: no gh behind the meter\n");
    process.exitCode = 127;
    return;
  }
  const shape = meterShape(args);
  const call = randomBytes(6).toString("hex");
  const startedAt = Date.now();
  const run = shape.local ? args : meteredArgs(args, shape);
  const reading = !shape.local && shape.mode !== "untouched";
  const child = spawn(gh, run, {
    env: { ...env, PATH: path, ...(shape.local ? {} : { [METER_ENV.call]: call }) },
    stdio: ["inherit", reading ? "pipe" : "inherit", "inherit"],
  });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = signals.map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return forward;
  });
  // Intercepted: the output is held until its header block is complete, then the rest streams
  // through. `kept`: the body's first bytes, only searched for GitHub's rate-limit wording.
  let held = Buffer.alloc(0);
  let block = null;
  let decided = !reading;
  let kept = "";
  const pass = (chunk) => {
    if (kept.length < 2048) kept += chunk.subarray(0, 2048).toString("utf8");
    process.stdout.write(chunk);
  };
  const decide = (final) => {
    const split = splitIncluded(held);
    // Output that does not start like a status line never becomes one: it streams at once.
    const blockless = held.length >= 5 && held.subarray(0, 5).toString("latin1") !== "HTTP/";
    if (!split.block && !final && !blockless) return;
    decided = true;
    block = split.block;
    const rest = shape.mode === "own" ? held : split.body;
    if (shape.mode === "own" && split.block) kept = split.body.subarray(0, 2048).toString("utf8");
    held = Buffer.alloc(0);
    if (rest.length) {
      if (shape.mode === "own") process.stdout.write(rest);
      else pass(rest);
    }
  };
  child.stdout?.on("data", (chunk) => {
    if (decided) {
      if (shape.mode === "own") process.stdout.write(chunk);
      else pass(chunk);
      return;
    }
    held = Buffer.concat([held, chunk]);
    // A header block is a few kilobytes; past 64 KB nothing that big is one.
    decide(held.length > 64 * 1024);
  });
  let outcome;
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
    process.stderr.write(`gh-meter: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 127;
    return;
  }
  if (!decided) decide(true);
  signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
  if (!shape.local) {
    const basis = env[METER_ENV.basis] === "guard rule" || env[METER_ENV.basis] === "router" ? env[METER_ENV.basis] : "none";
    const responses = block ? [responseOf(block, { cachePossible: shape.cache || basis === "router", startedAt, text: kept })] : [];
    appendUsage(usageDir(env), {
      at: new Date(startedAt).toISOString(),
      host: hostname(),
      call,
      caller: env[METER_ENV.caller] || "unknown",
      run: env[METER_ENV.run] || null,
      command: shape.command,
      method: shape.method,
      write: shape.write,
      responses,
      pages: reading ? responses.length : "unknown",
      ...accountOf(basis, shape, env),
      exit: outcome.signal ?? outcome.code,
    });
  }
  if (outcome.signal) {
    // Ends the way gh ended, once everything it printed has been written.
    process.stdout.write("", () => {
      process.removeAllListeners(outcome.signal);
      process.kill(process.pid, outcome.signal);
    });
    return;
  }
  process.exitCode = outcome.code ?? 1;
}

if (process.argv[1] && real(process.argv[1]) === real(SELF)) {
  main().catch((error) => {
    process.stderr.write(`gh-meter: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 127;
  });
}
