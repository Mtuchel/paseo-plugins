// The child-process helper program (server/child-processes.ts), embedded in the bundle the way
// PLANNOTATOR_HOST_SOURCE is. The plugin is evaluated from memory, so a helper looked up on disk -
// through the plan-first extension's link into a checkout, say - could be an older or newer version
// than the running bundle, and its message protocol would be skewed; if the link were missing,
// every spawn would fail. The bundle's own source cannot lag behind the plugin that runs it.
//
// child-processes.ts runs this with the plugin's own runtime (process.execPath) as
// `--input-type=module -e`, so an Electron-as-Node plugin starts an Electron-as-Node helper:
// advanced serialization only exchanges messages between identical runtimes.
export const CHILD_PROCESS_HELPER_SOURCE = String.raw`
// Every child process the plugin starts runs from here (server/child-processes.ts). The plugin runs
// this program from its own source with its own runtime, so the helper is never a version other
// than the plugin that starts it. It is small and long-lived: starting a process from a large
// parent copies that parent's page tables, and the plugin's RSS reaches gigabytes (3.4 GB on
// server087: about 93 ms of blocked event loop per fork it did itself; README, "Plugin child
// processes").
//
// Advanced serialization carries Buffers intact, so stdout/stderr reach the plugin as the bytes the
// child wrote, whatever caps and encodings the call asked for.
//
//   plugin → helper  { id, kind: "exec", file, args, options }   → reply { id, ok, stdout, stderr }
//                    { id, kind: "spawn", file, args, options }  → reply { id, ok, handle, pid }
//                    { kind: "kill", handle, signal }            → no reply
//                    { kind: "cancel", target }                  → no reply (aborts an exec/spawn)
//   helper → plugin  { event: "stdout" | "stderr", handle, data }
//                    { event: "exit" | "close", handle, code, signal }
//                    { event: "error", handle, error }
//
// Errors travel as plain fields (name, message, code, errno, syscall, signal, killed, cmd, stdout,
// stderr); the plugin rebuilds the error. They come from node's own execFile/spawn here, so node's
// timeouts, maxBuffer caps, kill signals and error ordering are the ones that apply.
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

// Running children, by the handle the plugin uses for them.
const children = new Map();
// The abort controller of every exec/spawn request that has not replied yet: a "cancel" aborts it,
// which is how the plugin stops a child whose call was given an AbortSignal.
const inFlight = new Map();
let nextHandle = 1;

// The plugin's end of the channel closed: it exited or reloaded. Its children are not the helper's
// to kill (a reload leaves them running, exactly as the plugin itself used to), so the helper just
// goes away.
process.on("disconnect", () => process.exit(0));

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.kind === "exec") void execCall(message);
  else if (message.kind === "spawn") spawnCall(message);
  else if (message.kind === "kill") killChild(message.handle, message.signal);
  else if (message.kind === "cancel") inFlight.get(message.target)?.abort();
});

async function execCall(message) {
  const controller = new AbortController();
  inFlight.set(message.id, controller);
  try {
    const { stdout, stderr } = await run(message.file, message.args, { ...message.options, signal: controller.signal });
    send({ id: message.id, ok: true, stdout, stderr });
  } catch (error) {
    send({ id: message.id, ok: false, error: failure(error) });
  } finally {
    inFlight.delete(message.id);
  }
}

function spawnCall(message) {
  const options = message.options ?? {};
  const opened = [];
  let stdio;
  try {
    stdio = (options.stdio ?? ["ignore", "ignore", "ignore"]).map((slot) => {
      if (slot === "ignore" || slot === "pipe") return slot;
      // A file the plugin wants the child's output in: fds do not cross the channel, so the path
      // does and the helper opens it (closeSync below: the child has its own copy from spawn).
      const fd = openSync(slot.file, slot.flags ?? "a", slot.mode ?? 0o666);
      opened.push(fd);
      return fd;
    });
  } catch (error) {
    send({ id: message.id, ok: false, error: failure(error) });
    return;
  }
  const controller = new AbortController();
  inFlight.set(message.id, controller);
  const child = spawn(message.file, message.args, {
    ...options,
    stdio,
    // node's own abort handling: the child is killed with killSignal when the plugin cancels.
    signal: controller.signal,
  });
  for (const fd of opened) closeSync(fd);
  const handle = nextHandle++;
  children.set(handle, child);
  // Nothing reaches the plugin before the reply that tells it the child's pid: the reply comes
  // first so the plugin's handle emits "spawn" before any output or exit.
  let replied = false;
  const queued = [];
  const emit = (event) => { if (replied) send(event); else queued.push(event); };
  const release = () => { replied = true; for (const event of queued) send(event); queued.length = 0; };
  child.on("spawn", () => {
    send({ id: message.id, ok: true, handle, pid: child.pid });
    release();
  });
  child.on("error", (error) => {
    if (replied) send({ event: "error", handle, error: failure(error) });
    else { send({ id: message.id, ok: false, error: failure(error) }); release(); inFlight.delete(message.id); }
  });
  child.on("exit", (code, signal) => emit({ event: "exit", handle, code, signal }));
  child.on("close", (code, signal) => {
    children.delete(handle);
    // The plugin's signal applies to the whole life of the child, not just its spawn: the
    // controller stays reachable for "cancel" until the child is gone.
    inFlight.delete(message.id);
    emit({ event: "close", handle, code, signal });
  });
  for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
    if (stream) stream.on("data", (data) => emit({ event: name, handle, data }));
  }
}

function killChild(handle, signal) {
  try { children.get(handle)?.kill(signal); } catch { /* already gone */ }
}

function failure(error) {
  const fields = {};
  if (error && typeof error === "object") {
    for (const key of ["name", "message", "code", "errno", "syscall", "signal", "killed", "cmd", "stdout", "stderr"]) {
      if (key in error) fields[key] = error[key];
    }
  }
  if (typeof fields.message !== "string") fields.message = String(error);
  return fields;
}

// The callback is the error path: a send that fails (the plugin is gone) must not throw into the
// middle of another reply.
function send(message) {
  if (!process.connected) return;
  try { process.send(message, () => {}); } catch { /* the plugin is gone; it starts a new helper */ }
}
`;