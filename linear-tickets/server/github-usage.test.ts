import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { GitHubUsage } from "./github-usage";
import { asCaller } from "./linear-usage";

const root = mkdtempSync(join(tmpdir(), "github-usage-"));
after(() => rmSync(root, { recursive: true, force: true }));

// A stand-in for gh that prints FAKE_RESPONSE, with its header block only for `--include`.
const bin = join(root, "bin");
mkdirSync(bin);
const fake = join(bin, "gh-agent-guard");
writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2);
const response = JSON.parse(process.env.FAKE_RESPONSE || "{}");
const include = args.includes("--include") || args.includes("-i");
let out = "";
if (include) out += "HTTP/2.0 " + (response.status ?? 200) + " X\\n" + Object.entries(response.headers ?? {}).map(([k, v]) => k + ": " + v + "\\r\\n").join("") + "\\r\\n";
process.stdout.write(out + (response.body ?? ""));
if (response.stderr) process.stderr.write(response.stderr);
process.exitCode = response.exit ?? 0;
`);
chmodSync(fake, 0o755);

const headers = { "Content-Type": "application/json", "X-Ratelimit-Resource": "core", "X-Ratelimit-Used": "4700", "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": "1791616855" };

let count = 0;
function usage(response: object) {
  const dir = join(root, `case-${++count}`);
  process.env.FAKE_RESPONSE = JSON.stringify(response);
  const meter = new GitHubUsage({ dir: join(dir, "usage"), meterDir: join(dir, "meter"), host: "server087", cli: () => fake, routed: () => false });
  const records = () => existsSync(join(dir, "usage")) ? readdirSync(join(dir, "usage")).flatMap((name) => readFileSync(join(dir, "usage", name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))) : [];
  return { meter, records, dir };
}

test("an in-process call gets gh's output without the header block, and the headers apart", async () => {
  const { meter, records, dir } = usage({ status: 200, headers: { ...headers, "X-Ratelimit-Remaining": "300" }, body: '{"ok":true}' });
  // The guard rule: a read of the daemon (no agent id) runs on the bot once its login is set up.
  mkdirSync(join(dir, "home", "gh-bot"), { recursive: true });
  writeFileSync(join(dir, "home", "gh-bot", "hosts.yml"), "");
  const saved = { home: process.env.PASEO_HOME, agent: process.env.PASEO_AGENT_ID };
  process.env.PASEO_HOME = join(dir, "home");
  delete process.env.PASEO_AGENT_ID;
  try {
    const result = await asCaller("pr-watch", () => meter.exec(fake, ["api", "repos/o/r/pulls/1"], { timeout: 5000, maxBuffer: 1 << 20 }));
    assert.equal(result.stdout, '{"ok":true}');
    assert.equal(result.headers?.get("x-ratelimit-remaining"), "300");
    await meter.exec(fake, ["api", "-X", "POST", "repos/o/r/issues/1/labels", "-f", "labels[]=x"], { timeout: 5000, maxBuffer: 1 << 20 });
  } finally {
    if (saved.home === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = saved.home;
    if (saved.agent !== undefined) process.env.PASEO_AGENT_ID = saved.agent;
  }
  const [read, write] = records();
  assert.equal(read.caller, "pr-watch");
  assert.deepEqual([read.account, read.basis, read.responses[0].class], ["bot", "guard rule", "charged"]);
  assert.deepEqual([write.account, write.write, write.method], ["owner", true, "POST"]);
});

test("a failed call keeps execFile's error, with gh's stdout and the response's headers on it", async () => {
  const { meter, records } = usage({ status: 403, headers, body: '{"message":"API rate limit exceeded"}', stderr: "gh: API rate limit exceeded (HTTP 403)\n", exit: 1 });
  const error = await meter.exec(fake, ["api", "user"], { timeout: 5000, maxBuffer: 1 << 20 }).then(() => null, (failure: unknown) => failure as { stdout: string; stderr: string; code: number; headers: Map<string, string> });
  assert.ok(error);
  assert.equal(error.stdout, '{"message":"API rate limit exceeded"}');
  assert.equal(error.code, 1);
  assert.match(error.stderr, /rate limit/);
  assert.equal(error.headers.get("x-ratelimit-reset"), "1791616855");
  assert.equal(records()[0].responses[0].class, "refused");
  assert.equal(records()[0].caller, "op:api");
});

test("a run records its calls under its id and one run line with its size", async () => {
  const { meter, records } = usage({ body: "[]" });
  await asCaller("queue backstop", () => meter.run("queue backstop", async () => {
    meter.size("repos", 2);
    meter.size("actions", 1);
    meter.size("actions", 1);
    await meter.exec(fake, ["api", "repos/o/r/pulls", "--jq", ".[]"], { timeout: 5000, maxBuffer: 1 << 20 });
  }));
  const [call, run] = records();
  assert.match(call.run, /^queue backstop@\d{4}-/);
  assert.equal(call.pages, "unknown");
  assert.deepEqual(run, { kind: "run", at: run.at, host: "server087", run: call.run, caller: "queue backstop", size: { repos: 2, actions: 2 } });
});

test("a script's environment sends its gh through the meter, tagged with the caller and run", async () => {
  const { meter, dir } = usage({});
  const env = await asCaller("queue backstop", () => meter.run("queue backstop", async () => meter.scriptEnv("/x/tools/ci/enqueue-ready.mjs")));
  assert.equal(env.LINEAR_TICKETS_GH_CALLER, "queue backstop: enqueue-ready.mjs");
  assert.match(env.LINEAR_TICKETS_GH_RUN, /^queue backstop@/);
  assert.equal(env.LINEAR_TICKETS_GH_NEXT, fake);
  assert.equal(env.LINEAR_TICKETS_GH_BASIS, "guard rule");
  assert.equal(env.LINEAR_TICKETS_GH_METER_DIR, join(dir, "meter"));
});

test("the wrapper runs the gh behind it even without the script environment, and is removed without a meter script", () => {
  const dir = join(root, "wrapper");
  const plain = join(dir, "plain");
  mkdirSync(plain, { recursive: true });
  symlinkSync(fake, join(plain, "gh"));
  const script = fileURLToPath(new URL("../scripts/gh-meter.mjs", import.meta.url));
  const meter = new GitHubUsage({ dir: join(dir, "usage"), meterDir: join(dir, "meter"), script });
  assert.equal(meter.install(), true);
  // gt or git's credential helper: no LINEAR_TICKETS_GH_* variables, the wrapper first on PATH.
  const env = { PATH: `${join(dir, "meter")}:${plain}:/usr/bin:/bin`, FAKE_RESPONSE: JSON.stringify({ body: "ok" }), LINEAR_TICKETS_USAGE_DIR: join(dir, "usage") };
  assert.equal(execFileSync(join(dir, "meter", "gh"), ["pr", "view", "1"], { env, timeout: 10_000 }).toString(), "ok");
  rmSync(join(dir, "meter", "gh"));
  assert.equal(meter.install(), true);
  assert.equal(existsSync(join(dir, "meter", "gh")), true);
  const missing = new GitHubUsage({ dir: join(dir, "usage"), meterDir: join(dir, "meter"), script: join(dir, "nowhere.mjs") });
  assert.equal(missing.install(), false);
  assert.equal(existsSync(join(dir, "meter", "gh")), false);
});

test("day files older than 14 days are pruned", async () => {
  const dir = join(root, "prune");
  mkdirSync(dir);
  for (const day of ["2026-09-25", "2026-09-26", "2026-10-10"]) writeFileSync(join(dir, `${day}.jsonl`), "{}\n");
  writeFileSync(join(dir, "notes.txt"), "kept");
  utimesSync(join(dir, "notes.txt"), new Date(0), new Date(0));
  await new GitHubUsage({ dir, now: () => Date.parse("2026-10-10T12:00:00Z") }).prune();
  assert.deepEqual(readdirSync(dir).sort(), ["2026-09-26.jsonl", "2026-10-10.jsonl", "notes.txt"]);
});
