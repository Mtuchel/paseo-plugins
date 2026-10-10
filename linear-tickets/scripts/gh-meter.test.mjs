import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { meteredArgs, meterShape, splitIncluded, responseOf } from "../server/gh-meter-core.mjs";

const METER = fileURLToPath(new URL("./gh-meter.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gh-meter-"));
after(() => rmSync(root, { recursive: true, force: true }));

// A stand-in for gh: prints FAKE_RESPONSE (status, headers, body, stderr, exit), with the header
// block only when asked for `--include`/`-i`, and writes its arguments and caller to FAKE_LOG.
const fake = join(root, "bin", "gh");
mkdirSync(join(root, "bin"));
writeFileSync(fake, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const response = JSON.parse(process.env.FAKE_RESPONSE || "{}");
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, caller: process.env.LINEAR_TICKETS_GH_CALLER ?? null, call: process.env.LINEAR_TICKETS_GH_CALL ?? null, path: process.env.PATH }) + "\\n");
if (response.hang) {
  process.on("SIGTERM", () => { appendFileSync(process.env.FAKE_LOG, "TERM\\n"); process.removeAllListeners("SIGTERM"); process.kill(process.pid, "SIGTERM"); });
  process.stdout.write("started\\n");
  setInterval(() => {}, 1000);
} else {
  const include = args.includes("--include") || args.includes("-i");
  let out = "";
  if (include) out += "HTTP/2.0 " + (response.status ?? 200) + " X\\n" + Object.entries(response.headers ?? {}).map(([k, v]) => k + ": " + v + "\\r\\n").join("") + "\\r\\n";
  out += response.body ?? "";
  process.stdout.write(out);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.exit ?? 0;
}
`);
chmodSync(fake, 0o755);

const headers = { "Content-Type": "application/json; charset=utf-8", "X-Ratelimit-Resource": "core", "X-Ratelimit-Used": "120", "X-Ratelimit-Remaining": "4880", "X-Ratelimit-Limit": "5000", "X-Ratelimit-Reset": "1791616855", Date: new Date().toUTCString() };

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    const out = [], err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code, signal) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString(), code, signal, child }));
  });
}

let counter = 0;
function setup(response, extra = {}) {
  const dir = join(root, `case-${++counter}`);
  mkdirSync(dir);
  const env = { FAKE_RESPONSE: JSON.stringify(response), FAKE_LOG: join(dir, "log"), LINEAR_TICKETS_USAGE_DIR: join(dir, "usage"), LINEAR_TICKETS_GH_NEXT: fake, LINEAR_TICKETS_GH_CALLER: "queue backstop: enqueue-ready.mjs", LINEAR_TICKETS_GH_BASIS: "none", ...extra };
  const records = () => {
    const usage = join(dir, "usage");
    if (!existsSync(usage)) return [];
    return readdirSync(usage).flatMap((name) => readFileSync(join(usage, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  };
  const log = () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean) : []);
  return { dir, env, records, log };
}

// The meter's output against gh's own output without `--include`: byte for byte.
async function compare(args, response) {
  const meter = setup(response);
  const direct = await run(fake, args, { FAKE_RESPONSE: JSON.stringify(response) });
  const metered = await run(process.execPath, [METER, ...args], meter.env);
  assert.deepEqual(metered.stdout, direct.stdout);
  assert.equal(metered.stderr, direct.stderr);
  assert.equal(metered.code, direct.code);
  return meter;
}

test("an intercepted call prints exactly what gh prints without --include, and records the response", async () => {
  const meter = await compare(["api", "repos/o/r/pulls/1"], { headers, body: '{"number":1}' });
  assert.equal(JSON.parse(meter.log()[0]).args.includes("--include"), true);
  const [record] = meter.records();
  assert.equal(record.caller, "queue backstop: enqueue-ready.mjs");
  assert.equal(record.pages, 1);
  assert.deepEqual(record.responses.map((item) => [item.status, item.class, item.resource, item.used, item.remaining, item.reset]), [[200, "charged", "core", 120, 4880, 1791616855]]);
});

test("a 304, a 404 with its body and a non-JSON body with a header-like line pass through unchanged", async () => {
  const notModified = await compare(["api", "repos/o/r/pulls/1", "-H", "If-None-Match: x"], { status: 304, headers, exit: 1, stderr: "gh: HTTP 304\n" });
  assert.equal(notModified.records()[0].responses[0].class, "free");
  const missing = await compare(["api", "repos/o/r/nope"], { status: 404, headers, body: '{\r\n  "message": "Not Found"\r\n}', exit: 1, stderr: "gh: Not Found (HTTP 404)\n" });
  assert.equal(missing.records()[0].responses[0].status, 404);
  assert.equal(missing.records()[0].exit, 1);
  await compare(["api", "zen"], { headers: { ...headers, "Content-Type": "text/plain" }, body: "HTTP/2.0 200 OK\r\nX-Ratelimit-Used: 1\r\n\r\nforged" });
});

test("GitHub's refusal is recorded as refused, not charged", async () => {
  const refused = await compare(["api", "user"], { status: 403, headers: { ...headers, "X-Ratelimit-Remaining": "0" }, body: '{"message":"API rate limit exceeded for user ID 1."}', exit: 1, stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n" });
  assert.equal(refused.records()[0].responses[0].class, "refused");
});

test("transformed, slurped, paginated and non-JSON calls are not given --include and count as invocations", async () => {
  for (const args of [
    ["api", "repos/o/r/pulls", "--jq", ".[].number"],
    ["api", "repos/o/r/pulls", "-q", ".[]"],
    ["api", "repos/o/r/pulls", "--template", "{{.}}"],
    ["api", "repos/o/r/pulls", "--paginate", "--slurp"],
    ["api", "repos/o/r/pulls", "--paginate"],
    ["api", "repos/o/r/pulls/1", "-H", "Accept: application/vnd.github.v3.diff"],
    ["pr", "view", "1", "--json", "state"],
  ]) {
    const meter = await compare(args, { headers, body: "[1]" });
    assert.equal(JSON.parse(meter.log()[0]).args.includes("--include"), false, args.join(" "));
    const [record] = meter.records();
    assert.equal(record.pages, "unknown", args.join(" "));
    assert.deepEqual(record.responses, []);
  }
});

test("the caller's own --include passes untouched and is still read", async () => {
  for (const flag of ["--include", "-i"]) {
    const meter = setup({ headers, body: "{}" });
    const args = ["api", flag, "repos/o/r/pulls/1"];
    const direct = await run(fake, args, { FAKE_RESPONSE: meter.env.FAKE_RESPONSE });
    const metered = await run(process.execPath, [METER, ...args], meter.env);
    assert.deepEqual(metered.stdout, direct.stdout);
    assert.match(metered.stdout.toString(), /^HTTP\/2\.0 200/);
    assert.deepEqual(JSON.parse(meter.log()[0]).args, args);
    assert.equal(meter.records()[0].responses[0].used, 120);
  }
});

test("stderr and the exit codes 0, 1 and 75 pass through", async () => {
  for (const exit of [0, 1, 75]) await compare(["pr", "list"], { body: "x", stderr: `said ${exit}\n`, exit });
});

test("SIGTERM to the meter reaches gh, and the meter ends with it", async () => {
  const meter = setup({ hang: true });
  const child = spawn(process.execPath, [METER, "api", "repos/o/r"], { env: { ...process.env, ...meter.env } });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  assert.deepEqual(await ended, { code: null, signal: "SIGTERM" });
  assert.equal(meter.log().includes("TERM"), true);
});

test("a bare gh is found past the meter's directory, and the meter never runs itself", async () => {
  const meterDir = join(root, "meter-bin");
  mkdirSync(meterDir);
  writeFileSync(join(meterDir, "gh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(METER)} "$@"\n`, { mode: 0o755 });
  const meter = setup({ body: "ok" }, { LINEAR_TICKETS_GH_NEXT: "", LINEAR_TICKETS_GH_METER_DIR: meterDir, PATH: `${meterDir}:${join(root, "bin")}:${process.env.PATH}` });
  const found = await run(join(meterDir, "gh"), ["pr", "list"], meter.env);
  assert.equal(found.stdout.toString(), "ok");
  assert.equal(JSON.parse(meter.log()[0]).path.split(":").includes(meterDir), false);
  const self = setup({ body: "ok" }, { LINEAR_TICKETS_GH_NEXT: join(meterDir, "gh"), LINEAR_TICKETS_GH_METER_DIR: meterDir });
  const refused = await run(process.execPath, [METER, "pr", "list"], self.env);
  assert.equal(refused.code, 127);
  assert.match(refused.stderr, /gh-meter: no gh behind the meter/);
  const linked = join(root, "linked-gh");
  symlinkSync(join(meterDir, "gh"), linked);
  assert.equal((await run(process.execPath, [METER, "pr", "list"], { ...self.env, LINEAR_TICKETS_GH_NEXT: linked })).code, 127);
});

test("a day file that cannot be written changes nothing about the call", async () => {
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "a file, not a directory");
  const meter = setup({ headers, body: "{}" }, { LINEAR_TICKETS_USAGE_DIR: blocked });
  const direct = await run(fake, ["api", "user"], { FAKE_RESPONSE: meter.env.FAKE_RESPONSE });
  const metered = await run(process.execPath, [METER, "api", "user"], meter.env);
  assert.deepEqual(metered.stdout, direct.stdout);
  assert.equal(metered.code, 0);
});

test("the caller tag and a call id reach the gh behind the meter", async () => {
  const meter = setup({ body: "{}" });
  await run(process.execPath, [METER, "pr", "view", "1"], meter.env);
  const seen = JSON.parse(meter.log()[0]);
  assert.equal(seen.caller, "queue backstop: enqueue-ready.mjs");
  assert.equal(seen.call, meter.records()[0].call);
});

test("the router basis makes a non-304 response uncertain, or cached when GitHub's date is old", () => {
  const block = (date) => ({ status: 200, headers: new Map([["date", date]]) });
  const startedAt = Date.parse("2026-10-10T10:00:10Z");
  assert.equal(responseOf(block("Sat, 10 Oct 2026 10:00:09 GMT"), { cachePossible: true, startedAt }).class, "uncertain");
  assert.equal(responseOf(block("Sat, 10 Oct 2026 10:00:00 GMT"), { cachePossible: true, startedAt }).class, "cached");
  assert.equal(responseOf(block("Sat, 10 Oct 2026 10:00:00 GMT"), { cachePossible: false, startedAt }).class, "charged");
});

test("the guard's read rule decides writes; --include goes right after api", () => {
  assert.equal(meterShape(["api", "repos/o/r/issues/1/comments", "-f", "body=hi"]).write, true);
  assert.equal(meterShape(["api", "-X", "PATCH", "repos/o/r/pulls/1"]).write, true);
  assert.equal(meterShape(["api", "graphql", "-f", "query=mutation { x }"]).write, true);
  assert.equal(meterShape(["api", "graphql", "-f", "query={ viewer { login } }"]).write, false);
  assert.equal(meterShape(["pr", "view", "1"]).write, false);
  assert.equal(meterShape(["pr", "merge", "1"]).write, true);
  assert.equal(meterShape(["auth", "status"]).local, true);
  const shape = meterShape(["api", "graphql", "-f", "query={ viewer { login } }"]);
  assert.deepEqual(meteredArgs(["api", "graphql", "-f", "query={ viewer { login } }"], shape), ["api", "--include", "graphql", "-f", "query={ viewer { login } }"]);
  assert.equal(shape.command, "api graphql");
  const split = splitIncluded(Buffer.from("HTTP/2.0 200 OK\nA: b\r\n\r\nbody"));
  assert.equal(split.block.headers.get("a"), "b");
  assert.equal(split.body.toString(), "body");
});
