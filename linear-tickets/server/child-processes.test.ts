import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { execFile, spawn, type SpawnedChild } from "./child-processes";

// The plugin's child processes, started by the helper program the bundle embeds
// (child-process-helper-source.ts, see child-processes.ts). These tests run that helper for real:
// the plugin holds no child processes itself, so everything here is what a caller of execFile/spawn
// sees.

const pluginDirectory = fileURLToPath(new URL("..", import.meta.url));

async function withDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-child-processes-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("execFile resolves what the child printed on each stream", async () => {
  const { stdout, stderr } = await execFile("sh", ["-c", "echo out; echo err >&2"]);
  assert.equal(stdout, "out\n");
  assert.equal(stderr, "err\n");
});

test("a non-zero exit rejects with the command, its streams and its code", async () => {
  const error = await execFile("sh", ["-c", "echo out; echo err >&2; exit 3"]).then(() => null, (reason: unknown) => reason as Error & Record<string, unknown>);
  assert.ok(error);
  assert.equal(error.name, "Error");
  assert.equal(error.code, 3);
  assert.equal(error.signal, null);
  assert.equal(error.killed, false);
  assert.equal(typeof error.cmd, "string");
  assert.match(String(error.cmd), /^sh -c echo out/);
  assert.equal(error.stdout, "out\n");
  assert.equal(error.stderr, "err\n");
  assert.match(error.message, /Command failed: sh -c/);
});

test("a command that is not there rejects as ENOENT, as node does", async () => {
  const error = await execFile(join(pluginDirectory, "no-such-binary-xyz"), []).then(() => null, (reason: unknown) => reason as Error & Record<string, unknown>);
  assert.ok(error);
  assert.equal(error.code, "ENOENT");
  assert.equal(error.errno, -2);
  assert.match(String(error.syscall), /^spawn /);
  assert.equal(error.stdout, "");
  assert.equal(error.stderr, "");
});

test("timeout kills the child and reports it", async () => {
  // A real wait, deliberately: node's own timeout has to kill a real child, which this test can
  // only observe by what the child never gets to write.
  await withDirectory(async (directory) => {
    const marker = join(directory, "late");
    const error = await execFile("sh", ["-c", `echo started; sleep 1; echo late > ${marker}`], { timeout: 300 }).then(() => null, (reason: unknown) => reason as Error & Record<string, unknown>);
    assert.ok(error);
    assert.equal(error.killed, true);
    assert.equal(error.signal, "SIGTERM");
    assert.equal(error.code, null);
    assert.equal(error.stdout, "started\n");
    await sleep(1_300);
    assert.equal(await readFile(marker, "utf8").then(() => true, () => false), false, "the timed out child was killed, not left running");
  });
});

test("maxBuffer overflow rejects with node's code and the output so far", async () => {
  const error = await execFile("sh", ["-c", "yes abcdefghij | head -c 100000"], { maxBuffer: 1024 }).then(() => null, (reason: unknown) => reason as Error & Record<string, unknown>);
  assert.ok(error);
  assert.equal(error.name, "RangeError");
  assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(String(error.stdout).slice(0, 10), "abcdefghij");
});

test("encoding \"buffer\" hands over the bytes", async () => {
  const { stdout, stderr } = await execFile("sh", ["-c", "printf '\\000\\377'"], { encoding: "buffer" });
  assert.ok(Buffer.isBuffer(stdout));
  assert.deepEqual([...stdout], [0, 255]);
  assert.ok(Buffer.isBuffer(stderr));
});

test("the child sees the caller's cwd and environment, and the plugin's own without one", async () => {
  await withDirectory(async (directory) => {
    const here = await execFile("pwd", [], { cwd: directory });
    assert.equal(here.stdout.trim(), await realpath(directory));
  });
  process.env.PASEO_CHILD_PROCESSES_PROBE = "from-the-plugin";
  try {
    const passed = await execFile("sh", ["-c", "echo $PASEO_CHILD_PROCESSES_PROBE"], { env: { ...process.env, PASEO_CHILD_PROCESSES_PROBE: "passed" } });
    assert.equal(passed.stdout.trim(), "passed");
    const inherited = await execFile("sh", ["-c", "echo $PASEO_CHILD_PROCESSES_PROBE"]);
    assert.equal(inherited.stdout.trim(), "from-the-plugin");
  } finally {
    delete process.env.PASEO_CHILD_PROCESSES_PROBE;
  }
});

test("an aborted signal rejects an execFile call and a signal aborted before it starts none", async () => {
  const controller = new AbortController();
  // The request and its cancel reach the helper in order, so the child is stopped either way.
  const pending = execFile("sh", ["-c", "sleep 30"], { signal: controller.signal }).then(() => null, (reason: unknown) => reason as Error & Record<string, unknown>);
  queueMicrotask(() => controller.abort());
  const error = await pending;
  assert.ok(error);
  assert.equal(error.name, "AbortError");
  assert.equal(error.code, "ABORT_ERR");

  const early = new AbortController();
  early.abort();
  const before = await execFile("sh", ["-c", "echo never"], { signal: early.signal }).then(() => null, (reason: unknown) => reason as Error & Record<string, unknown>);
  assert.ok(before);
  assert.equal(before.name, "AbortError");
  assert.equal(before.code, "ABORT_ERR");
});

test("spawn streams both streams, gives the pid on \"spawn\", and closes after them", async () => {
  const child = spawn("sh", ["-c", "echo one; echo two >&2; exit 4"], { stdio: ["ignore", "pipe", "pipe"] });
  const seen: string[] = [];
  let stdout = "";
  let stderr = "";
  // The stdio slots above pipe both streams, so they are Readables.
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("spawn", () => seen.push(`spawn:${typeof child.pid}`));
  child.on("exit", (code, signal) => seen.push(`exit:${code}:${signal}:exitCode=${child.exitCode}`));
  const closed = new Promise<void>((resolve) => {
    child.on("close", (code, signal) => {
      seen.push(`close:${code}:${signal}:ended=${child.stdout?.readableEnded}:${child.stderr?.readableEnded}`);
      resolve();
    });
  });
  await closed;
  assert.deepEqual(seen, ["spawn:number", "exit:4:null:exitCode=4", "close:4:null:ended=true:true"]);
  assert.equal(stdout, "one\n");
  assert.equal(stderr, "two\n");
  assert.equal(child.signalCode, null);
});

test("kill(SIGKILL) ends a running child and its close carries the signal", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
  assert.equal(child.kill("SIGKILL"), true);
  await closed;
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(child.exitCode, null);
  assert.equal(child.kill("SIGKILL"), false, "a child that closed cannot be killed again");
});

test("a child that cannot start emits error and then close, as node does", async () => {
  const child = spawn(join(pluginDirectory, "no-such-binary-xyz"), [], { stdio: ["ignore", "pipe", "pipe"] });
  const events: string[] = [];
  const errors: NodeJS.ErrnoException[] = [];
  child.on("error", (error) => { errors.push(error as NodeJS.ErrnoException); events.push("error"); });
  const closed = new Promise<void>((resolve) => child.on("close", (code, signal) => { events.push(`close:${code}:${signal}`); resolve(); }));
  await closed;
  // node's code for a child that never ran is the negated errno (ENOENT: -2).
  assert.deepEqual(events, ["error", "close:-2:null"]);
  assert.equal(errors[0].code, "ENOENT");
  assert.equal(child.exitCode, -2);
  assert.equal(child.stdout?.readableEnded, true);
  assert.equal(child.stdout?.destroyed, true);
  assert.equal(child.kill("SIGKILL"), false);
});

test("an aborted signal ends a spawned child the way node does", async () => {
  const controller = new AbortController();
  const child = spawn("sleep", ["30"], { stdio: "ignore", signal: controller.signal });
  const events: string[] = [];
  child.on("spawn", () => { events.push("spawn"); controller.abort(); });
  child.on("error", (error) => events.push(`error:${error.name}`));
  child.on("exit", (code, signal) => events.push(`exit:${code}:${signal}`));
  await new Promise<void>((resolve) => child.on("close", (code, signal) => { events.push(`close:${code}:${signal}`); resolve(); }));
  assert.deepEqual(events, ["spawn", "error:AbortError", "exit:null:SIGTERM", "close:null:SIGTERM"]);
  assert.equal(child.signalCode, "SIGTERM");

  // A signal aborted before the call still spawns the child, then stops it.
  const early = new AbortController();
  early.abort();
  const child2 = spawn("sleep", ["30"], { stdio: "ignore", signal: early.signal });
  const events2: string[] = [];
  child2.on("spawn", () => events2.push("spawn"));
  child2.on("error", (error) => events2.push(`error:${error.name}:${(error as NodeJS.ErrnoException).code}`));
  child2.on("exit", (code, signal) => events2.push(`exit:${code}:${signal}`));
  await new Promise<void>((resolve) => child2.on("close", (code, signal) => { events2.push(`close:${code}:${signal}`); resolve(); }));
  assert.deepEqual(events2, ["spawn", "error:AbortError:ABORT_ERR", "exit:null:SIGTERM", "close:null:SIGTERM"]);
});

test("spawn writes a child's output to the file slot it was given", async () => {
  // How parked.ts gives the Plannotator host its log: it names the file, the helper opens it.
  await withDirectory(async (directory) => {
    const log = join(directory, "host.log");
    const child = spawn("sh", ["-c", "echo out; echo err >&2"], { stdio: ["ignore", { file: log, flags: "a", mode: 0o600 }, { file: log, flags: "a", mode: 0o600 }] });
    assert.equal(child.stdout, null);
    assert.equal(child.stderr, null);
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    assert.equal(await readFile(log, "utf8"), "out\nerr\n");
  });
});

test("the helper dying fails the calls in flight, and the next call starts a new helper", async () => {
  const child: SpawnedChild = spawn("sleep", ["5"], { stdio: "ignore" });
  const events: string[] = [];
  child.on("error", (error) => events.push(error.message));
  const closed = new Promise<void>((resolve) => child.on("close", () => { events.push("close"); resolve(); }));
  await new Promise<void>((resolve) => child.on("spawn", () => resolve()));

  // $PPID of a child the helper started is the helper itself.
  const error = await execFile("sh", ["-c", "kill -9 $PPID"]).then(() => null, (reason: unknown) => reason as Error);
  assert.ok(error);
  assert.match(error.message, /^Child process helper exited/);
  await closed;
  assert.equal(events.length, 2, `a child still running is closed out (${events.join(", ")})`);
  assert.match(events[0], /^Child process helper exited/);
  assert.equal(events[1], "close");

  const again = await execFile("sh", ["-c", "echo again"]);
  assert.equal(again.stdout, "again\n");
});

test("a process whose calls have finished exits on its own", async () => {
  // The helper and its channel are unref'd while nothing is in flight, so a script (or a test run)
  // that only used execFile does not hang on the helper.
  const moduleUrl = new URL("./child-processes.ts", import.meta.url).href;
  const script = `import { execFile } from ${JSON.stringify(moduleUrl)};
const { stdout } = await execFile("sh", ["-c", "echo it-exits"]);
process.stdout.write(stdout);
`;
  await withDirectory(async (directory) => {
    const program = join(directory, "script.mjs");
    await writeFile(program, script);
    const { stdout } = await execFile(process.execPath, ["--import", "tsx", program], { cwd: pluginDirectory, timeout: 60_000 });
    assert.equal(stdout, "it-exits\n");
  });
});