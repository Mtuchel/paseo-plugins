import { spawn as spawnNodeProcess, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { CHILD_PROCESS_HELPER_SOURCE } from "./child-process-helper-source";

// Every child process the plugin starts runs from one small long-lived helper program
// (child-process-helper-source.ts) instead of from the plugin process. Forking a process copies
// its page tables, and the plugin's RSS reaches gigabytes (3.4 GB on server087): each fork it made
// itself blocked its event loop for about 93 ms, so every HTTP route and RPC queued behind the
// plugin's own gh/git/ps calls (README, "Plugin child processes"). `execFile` and `spawn` here are
// drop-in replacements for the node:child_process ones: the same options, results and errors,
// because the helper runs the real execFile/spawn — node's timeouts, maxBuffer caps, kill signals
// and event ordering are the ones that apply. A child's stdio is three slots (stdin "ignore" or a
// file, stdout/stderr "ignore", "pipe" or a file); stdout/stderr reach the caller as Readables.
//
// The helper is the bundle's own source, run by the plugin's own runtime (process.execPath, with
// ELECTRON_RUN_AS_NODE so an Electron-as-Node plugin starts an Electron-as-Node helper): it can
// never be a different version than the plugin that starts it, and advanced serialization - which
// only speaks between identical runtimes - always has a matching serializer on both ends.
//
// The helper starts on first use and exits when its channel closes (a plugin exit or reload),
// leaving the children it started running, exactly as the plugin used to. If it dies, calls in
// flight reject and the next call starts a new one.

export type ExecFileOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  encoding?: BufferEncoding | "buffer" | null;
  killSignal?: NodeJS.Signals | number;
  signal?: AbortSignal;
};

export type ExecFileOutput = { stdout: string; stderr: string };
export type ExecFileBuffers = { stdout: Buffer; stderr: Buffer };

// node's execFile error (a non-zero exit, a timeout, an aborted signal, a maxBuffer overflow, a
// binary that is not there), rebuilt in the plugin from the fields the helper ran into.
export type ExecFileFailure = Error & {
  code?: string | number | null;
  errno?: number;
  syscall?: string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  cmd?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export type StdioSlot = "ignore" | "pipe" | { file: string; flags?: string; mode?: number };
export type SpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  // Three slots like node's: fd 0 (no caller pipes into a child), stdout, stderr. A file slot is
  // opened by the helper — fds cannot cross the channel.
  stdio?: "ignore" | readonly StdioSlot[];
  signal?: AbortSignal;
  killSignal?: NodeJS.Signals | number;
};

type FailureFields = { name?: unknown; message?: unknown; code?: unknown; errno?: unknown; syscall?: unknown; signal?: unknown; killed?: unknown; cmd?: unknown; stdout?: unknown; stderr?: unknown };
type ReplyOk = { id: number; ok: true; stdout: string | Buffer; stderr: string | Buffer; handle: number; pid: number | undefined };
type WireMessage = ReplyOk | { id: number; ok: false; error: FailureFields };
type WireEvent =
  | { event: "stdout"; handle: number; data: Buffer }
  | { event: "stderr"; handle: number; data: Buffer }
  | { event: "exit"; handle: number; code: number | null; signal: NodeJS.Signals | null }
  | { event: "close"; handle: number; code: number | null; signal: NodeJS.Signals | null }
  | { event: "error"; handle: number; error: FailureFields };

type Pending = { ok: (reply: ReplyOk) => void; fail: (error: Error) => void; linger?: boolean };
type Helper = { process: ChildProcess; pending: Map<number, Pending>; children: Map<number, SpawnedChild>; references: number };
// One child's side of its helper: the signals it sends, and the one reference it holds while it runs.
type ChildTransport = { kill: (handle: number, signal?: NodeJS.Signals | number) => void; hold: () => void; release: () => void };

let helper: Helper | null = null;
let nextRequest = 1;

function startHelperIfNeeded(): Helper {
  if (helper) return helper;
  const started: Helper = {
    // Advanced serialization: stdout/stderr cross the channel as the bytes the child wrote.
    process: spawnNodeProcess(process.execPath, ["--input-type=module", "-e", CHILD_PROCESS_HELPER_SOURCE], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }),
    pending: new Map(),
    children: new Map(),
    references: 0,
  };
  helper = started;
  // Nothing references the helper yet: neither its process nor its channel may keep the plugin (or
  // a test) alive. Both are referenced again while a call is in flight or a child is running.
  started.process.unref();
  started.process.channel?.unref();
  started.process.on("message", (message) => receive(started, message as WireMessage | WireEvent));
  started.process.on("error", (error) => stopped(started, error.message));
  started.process.on("exit", (code, signal) => stopped(started, `the process exited (${code === null ? signal : `code ${code}`})`));
  started.process.on("disconnect", () => stopped(started, "its channel closed"));
  return started;
}

// One reference on the helper's process and channel: held by every call in flight and by every
// child the caller has not unref'd (node's rule: a running child the caller did not unref keeps the
// parent alive). While the last reference goes away the plugin - or a test - can exit with the
// helper still running.
function reference(started: Helper): void {
  if (started.references++ === 0) {
    started.process.ref();
    started.process.channel?.ref();
  }
}

function unreference(started: Helper): void {
  if (started.references === 0) return;
  if (--started.references === 0) {
    started.process.unref();
    started.process.channel?.unref();
  }
}

// The transport of one child: the signals it sends to the helper, and the one reference it holds
// on the helper while the child runs.
function childTransport(started: Helper): ChildTransport {
  let held = false;
  return {
    kill: (handle, signal) => send(started, { kind: "kill", handle, signal }),
    hold: () => { if (!held) { held = true; reference(started); } },
    release: () => { if (held) { held = false; unreference(started); } },
  };
}

// The helper is gone. Its children are not this process's to kill (a plugin exit never killed
// them), but nothing in flight can finish any more: every waiting call fails, and a child still
// running is closed out, since the plugin cannot see how it ends.
function stopped(started: Helper, reason: string): void {
  if (helper !== started) return;
  helper = null;
  const error = new Error(`Child process helper exited: ${reason}`);
  const calls = [...started.pending.values()];
  const children = [...started.children.values()];
  started.pending.clear();
  started.children.clear();
  // Every reference was a reference to this helper: its handles are gone, so later releases are no-ops.
  started.references = 0;
  for (const call of calls) call.fail(error);
  for (const child of children) child.lost(error);
}

function receive(started: Helper, message: WireMessage | WireEvent): void {
  if ("event" in message) {
    const child = started.children.get(message.handle);
    if (!child) return;
    if (message.event === "stdout" || message.event === "stderr") {
      child.output(message.event, message.data);
      return;
    }
    if (message.event === "error") {
      child.failed(failure(message.error));
      return;
    }
    if (message.event === "exit") {
      child.exited(message.code, message.signal);
      return;
    }
    started.children.delete(message.handle);
    child.closed(message.code, message.signal);
    return;
  }
  const pending = started.pending.get(message.id);
  if (!pending) return;
  started.pending.delete(message.id);
  if (message.ok) pending.ok(message);
  else pending.fail(failure(message.error));
}

// One request to the helper. An AbortSignal cannot cross the channel, so the helper aborts its own
// child when the plugin cancels the request (node's own behaviour: killed with killSignal). A
// spawned child outlives the reply that carries its handle - and node's `signal` stops it at any
// time, so a lingering request keeps its cancel listener and its reference until the child closes:
// the returned function is that release.
function call(started: Helper, kind: "exec" | "spawn", payload: Record<string, unknown>, signal: AbortSignal | undefined, back: Pending): () => void {
  const id = nextRequest++;
  const cancel = () => send(started, { kind: "cancel", target: id });
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", cancel);
    unreference(started);
  };
  reference(started);
  started.pending.set(id, {
    ok: (reply) => { if (!back.linger) done(); back.ok(reply); },
    fail: (error) => { done(); back.fail(error); },
  });
  send(started, { id, kind, ...payload });
  // A signal that aborts later sends a cancel; the helper's own node then kills the child the way
  // it does for a signal of its own. A signal aborted before the call is the caller's to handle
  // (execFile never reaches here with one).
  signal?.addEventListener("abort", cancel, { once: true });
  return done;
}

function send(started: Helper, message: object): void {
  try { started.process.send(message); } catch { /* the helper exited; its calls were rejected */ }
}

// What node rejects an aborted call with, before the helper is asked for anything.
function abortFailure(): Error {
  const error = new Error("The operation was aborted") as Error & { code?: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function failure(fields: FailureFields): ExecFileFailure {
  const message = typeof fields.message === "string" ? fields.message : "The child process failed.";
  const error: ExecFileFailure = fields.name === "RangeError" ? new RangeError(message) : fields.name === "TypeError" ? new TypeError(message) : new Error(message);
  if (typeof fields.name === "string" && error.name !== fields.name) error.name = fields.name;
  if (fields.code !== undefined) error.code = fields.code as string | number | null;
  if (typeof fields.errno === "number") error.errno = fields.errno;
  if (typeof fields.syscall === "string") error.syscall = fields.syscall;
  if (fields.signal !== undefined) error.signal = fields.signal as NodeJS.Signals | null;
  if (fields.killed !== undefined) error.killed = fields.killed as boolean;
  if (fields.cmd !== undefined) error.cmd = fields.cmd as string;
  if (fields.stdout !== undefined) error.stdout = fields.stdout as string | Buffer;
  if (fields.stderr !== undefined) error.stderr = fields.stderr as string | Buffer;
  return error;
}

export function execFile(file: string, args: readonly string[], options: ExecFileOptions & { encoding: "buffer" | null }): Promise<ExecFileBuffers>;
export function execFile(file: string, args?: readonly string[], options?: ExecFileOptions): Promise<ExecFileOutput>;
export function execFile(file: string, args: readonly string[] = [], options: ExecFileOptions = {}): Promise<ExecFileOutput | ExecFileBuffers> {
  // The caller's own keys cross the channel (minus the signal): node's execFile treats an option
  // that is present but undefined differently from one that is absent (`encoding: undefined` is
  // "no encoding", so Buffers), and a replacement must not change that. `env` is always sent, so
  // the child sees the plugin's current environment.
  const { signal, ...sent } = options;
  // node aborts before it starts the child, so nothing is asked of the helper.
  if (signal?.aborted) return Promise.reject(abortFailure());
  return new Promise((resolve, reject) => {
    call(startHelperIfNeeded(), "exec", { file, args: [...args], options: { ...sent, env: sent.env ?? process.env } }, signal, {
      ok: (reply) => resolve({ stdout: reply.stdout, stderr: reply.stderr } as ExecFileOutput),
      fail: reject,
    });
  });
}

// A spawned child, as node's ChildProcess: `pid` appears with "spawn", the streams end before
// "close", and stdout/stderr are null unless the call asked for "pipe".
export class SpawnedChild extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  private handle: number | null = null;
  private finish: (() => void) | null = null;
  private ended = false;

  constructor(slots: readonly StdioSlot[], private readonly transport: ChildTransport) {
    super();
    this.stdout = slots[1] === "pipe" ? new Readable({ read() {} }) : null;
    this.stderr = slots[2] === "pipe" ? new Readable({ read() {} }) : null;
  }

  // node's kill: true while the helper's child may still receive the signal; a signal for a child
  // that is already gone is dropped by the helper.
  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.handle === null || this.ended) return false;
    this.transport.kill(this.handle, signal);
    return true;
  }

  // node's unref: the plugin holds no handle for a child (the helper does), so the child stops
  // keeping the plugin alive; a detached child is unaffected by its parent exiting.
  unref(): this {
    this.transport.release();
    return this;
  }

  // spawned/output/exited/closed/failed/lost are the helper's side of this child: what it reports
  // is applied here (only this module's receive/stopped call them).
  spawned(handle: number, pid: number | undefined, finish: () => void): void {
    this.handle = handle;
    this.pid = pid;
    this.finish = finish;
    // A running child keeps the plugin alive until it closes or the caller unref's it.
    this.transport.hold();
    this.emit("spawn");
  }

  output(kind: "stdout" | "stderr", data: Buffer): void {
    const stream = kind === "stdout" ? this.stdout : this.stderr;
    if (stream && !stream.destroyed) stream.push(data);
  }

  exited(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  // node emits "error" for a spawn that could not happen; the helper forwards those it sees after
  // the spawn (an aborted signal, say).
  failed(error: Error): void {
    this.emit("error", error);
  }

  closed(code: number | null, signal: NodeJS.Signals | null): void {
    this.ended = true;
    this.transport.release();
    this.finish?.();
    // node's "close" comes after the stdio streams are done: a stream the caller read ends, and one
    // nobody read is drained and destroyed the same way node ends an unread pipe. Data the helper
    // already sent arrived before this.
    const streams = [this.stdout, this.stderr].filter((stream): stream is Readable => stream !== null && !stream.destroyed);
    if (streams.length === 0) {
      this.emit("close", code, signal);
      return;
    }
    let open = streams.length;
    for (const stream of streams) {
      stream.once("close", () => { if (--open === 0) this.emit("close", code, signal); });
      stream.push(null);
      stream.resume();
      process.nextTick(() => { if (!stream.destroyed) stream.destroy(); });
    }
  }

  // The helper died, or its spawn request failed. A handle nobody listens to must not end the
  // plugin, so "error" is emitted only with a listener; "close" always, so waiting callers finish.
  lost(error: Error): void {
    if (this.ended) return;
    // A spawn that failed never ran: node's exit code for it is the errno (ENOENT: -2).
    const errno = (error as NodeJS.ErrnoException).errno;
    if (this.exitCode === null && typeof errno === "number") this.exitCode = errno;
    if (this.listenerCount("error") > 0) this.emit("error", error);
    this.closed(this.exitCode, this.signalCode);
  }
}

export function spawn(file: string, args: readonly string[] = [], options: SpawnOptions = {}): SpawnedChild {
  const stdio = options.stdio === undefined || options.stdio === "ignore" ? ["ignore", "ignore", "ignore"] as const : [...options.stdio];
  if (stdio.length !== 3) throw new Error("child-processes spawn: stdio needs three slots (stdin, stdout, stderr)");
  if (stdio[0] === "pipe") throw new Error("child-processes spawn: a child's stdin cannot be piped to the plugin");
  const { signal, ...sent } = options;
  const started = startHelperIfNeeded();
  const child = new SpawnedChild(stdio, childTransport(started));
  // A signal aborted before the call is node's "spawn, then stop the child at once": the child is
  // started without the helper watching a signal, and stopped as soon as its handle is here.
  const aborted = signal?.aborted === true;
  const finish = call(started, "spawn", { file, args: [...args], options: { ...sent, env: sent.env ?? process.env, stdio } }, aborted ? undefined : signal, {
    linger: true,
    // From here the helper's events (output, exit, close) find this child by its handle.
    ok: (reply) => {
      child.spawned(reply.handle, reply.pid, finish);
      started.children.set(reply.handle, child);
      if (aborted) {
        child.failed(abortFailure());
        child.kill(sent.killSignal ?? "SIGTERM");
      }
    },
    fail: (error) => child.lost(error),
  });
  return child;
}

// For the plugin's own disposal (index.server.ts): in-flight calls fail, and the helper exits when
// its channel closes. The children it started keep running — as they did when the plugin exited.
export function stopChildProcessHelper(): void {
  const started = helper;
  if (!started) return;
  helper = null;
  const error = new Error("Child process helper stopped: the plugin is shutting down");
  const calls = [...started.pending.values()];
  const children = [...started.children.values()];
  started.pending.clear();
  started.children.clear();
  for (const call of calls) call.fail(error);
  for (const child of children) child.lost(error);
  started.process.disconnect();
}