import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// One isolated, tool-less OMP model call, shared by the deputy for agent questions
// (deputy-evaluator.ts) and the owner-ask extraction (owner-ask-extract.ts). It runs with no
// tools, no MCP servers, no extensions, rules or skills, no memory and no saved session, from an
// empty directory, under a private OMP agent directory holding only the configuration written
// here. Anything unexpected (a tool event, a timeout, an unreadable or oversized answer) is a
// refusal; the caller validates what came back.

export const DEADLINE_MS = 150_000;
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_ANSWER_CHARS = 20_000;

const ISOLATED_CONFIG = [
  "memory:", "  backend: off",
  "mcp:", "  enableProjectConfig: false",
  "extensions: []",
  "disabledExtensions: []",
  "skills:", "  enabled: false",
  "advisor:", "  enabled: false",
  "todo:", "  enabled: false",
  "ttsr:", "  enabled: false",
  "secrets:", "  enabled: false",
  "autoResume: false",
].join("\n");

// The top-level `auth:` block of the owner's omp configuration (the credential broker), so the
// isolated directory can reach the model without copying credentials into it.
export function authBlock(config: string): string {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => /^auth:\s*$/.test(line));
  if (start < 0) return "";
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line);
  }
  return block.join("\n").trimEnd();
}

function ompBinary(env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (existsSync(join(directory, "omp"))) return join(directory, "omp");
  }
  const local = join(homedir(), ".local", "bin", "omp");
  return existsSync(local) ? local : null;
}

export type OmpRun = { code: number | null; stdout: string; timedOut: boolean; overflow: boolean };
export type OmpRunner = (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<OmpRun>;

// Executor form: the plugin's lib is ES2023, without Promise.withResolvers.
export const runOmp: OmpRunner = (binary, args, { cwd, env }) => new Promise((resolve) => {
  const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  let overflow = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, DEADLINE_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_STDOUT_BYTES) { overflow = true; child.kill("SIGKILL"); return; }
    chunks.push(chunk);
  });
  child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout: "", timedOut, overflow }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, overflow }); });
});

// The final assistant text of an `omp --mode json` run, or why there is none usable. Any tool
// event at all fails the run: the caller's call must not have had a tool to call. `subject` names
// the caller in the returned reason ("the evaluator", "the extraction").
export function finalAnswer(output: string, subject = "evaluator"): { text: string } | { error: string } {
  let text: string | null = null;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { return { error: `the ${subject} printed a line that is not JSON` }; }
    if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") continue;
    if (/tool/i.test(event.type)) return { error: `the ${subject} emitted a tool event (${event.type}); it must have no tools` };
    if (event.type !== "message_end" || !("message" in event) || !event.message || typeof event.message !== "object") continue;
    const message = Object.fromEntries(Object.entries(event.message));
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.some((part: unknown) => part && typeof part === "object" && "type" in part && typeof part.type === "string" && /tool/i.test(part.type))) return { error: `the ${subject} tried to call a tool` };
    if (message.stopReason !== "stop") return { error: `the ${subject} stopped with ${String(message.stopReason ?? "no reason")}${typeof message.errorMessage === "string" ? `: ${message.errorMessage.slice(0, 200)}` : ""}` };
    text = content.flatMap((part: unknown) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
  }
  if (text === null) return { error: `the ${subject} returned no answer` };
  if (text.length > MAX_ANSWER_CHARS) return { error: `the ${subject}'s answer is too long` };
  return { text };
}

// What one isolated call runs: `directory` is the caller's private state directory (the isolated
// OMP agent directory lives in it), `promptFile`/`prompt` the file the instruction points at.
export type IsolatedOmp = {
  directory: string;
  systemPrompt: string;
  promptFile: string;
  prompt: string;
  instruction: string;
  model: string;
  thinking: string;
  subject?: string;
};

export type IsolatedAnswer = { ok: true; text: string } | { ok: false; reason: string };

export async function runIsolatedOmp(request: IsolatedOmp, runner: OmpRunner = runOmp, env: NodeJS.ProcessEnv = process.env): Promise<IsolatedAnswer> {
  const subject = request.subject ?? "model";
  const binary = ompBinary(env);
  if (!binary) return { ok: false, reason: "omp is not installed on this host" };
  const agentDirectory = join(request.directory, "omp-agent");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  // Only the configuration written here: nothing the owner's omp loads (MCP servers, extensions,
  // hooks, memory) may exist in the isolated directory.
  for (const name of ["mcp.json", "extensions", "hooks", "skills", "agents", "commands", "rules"]) await rm(join(agentDirectory, name), { recursive: true, force: true });
  const owner = await readFile(join(homedir(), ".omp", "agent", "config.yml"), "utf8").catch(() => "");
  await writeFile(join(agentDirectory, "config.yml"), `${ISOLATED_CONFIG}\n${authBlock(owner)}\n`, { mode: 0o600 });
  const cwd = await mkdtemp(join(tmpdir(), "linear-one-shot-"));
  try {
    await writeFile(join(cwd, request.promptFile), request.prompt, { mode: 0o600 });
    const args = ["-p", "--mode", "json", "--no-session", "--no-tools", "--no-lsp", "--no-pty", "--no-extensions", "--no-skills", "--no-rules", "--no-title",
      "--model", request.model, "--thinking", request.thinking, "--max-time", String(Math.floor(DEADLINE_MS / 1000) - 10), "--system-prompt", request.systemPrompt, `@${request.promptFile}`, request.instruction];
    // Only what the subprocess needs: no Paseo, Linear or GitHub credentials reach it.
    const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: env.HOME ?? homedir(), LANG: env.LANG ?? "C.UTF-8", PI_CODING_AGENT_DIR: agentDirectory, ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}) };
    const result = await runner(binary, args, { cwd, env: childEnv });
    if (result.timedOut) return { ok: false, reason: `the ${subject} did not answer in time` };
    if (result.overflow) return { ok: false, reason: `the ${subject}'s output was too large` };
    if (result.code !== 0) return { ok: false, reason: `the ${subject} exited with ${result.code ?? "a signal"}` };
    const answer = finalAnswer(result.stdout, subject);
    if ("error" in answer) return { ok: false, reason: answer.error };
    return { ok: true, text: answer.text };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
