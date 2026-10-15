import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sessionRouting, sessionRoutingNote } from "../shared/plan-model";

// The omp extension reads its environment when it loads, so it is imported after this setup: a
// Paseo session the plugin did not start for a ticket.
const root = mkdtempSync(join(tmpdir(), "paseo-session-routing-"));
for (const name of Object.keys(process.env)) if (name.startsWith("LINEAR_TICKETS_")) delete process.env[name];
Object.assign(process.env, { PASEO_AGENT_ID: "owner-session-1", PASEO_HOME: root, PI_CODING_AGENT_DIR: root });
const { default: extension } = await import("../omp/linear-tickets-plan-first");
after(() => rmSync(root, { recursive: true, force: true }));

type Entry = { type: string; customType?: string };
type Ctx = { agent?: { kind?: string }; models: { current(): { provider: string; id: string } }; sessionManager: { getBranch(): Entry[] } };
type Hook = (event: unknown, ctx: Ctx) => Promise<unknown> | unknown;

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const FLASH = { provider: "lithos", id: "deepseek-ai/DeepSeek-V4.1-Flash-ultra" };

// One loaded extension per session; `branch`: the session's entries when it starts (a resume).
function session(model = OPUS, kind?: string, branch: Entry[] = []) {
  const handlers = new Map<string, Hook[]>();
  const entries: Entry[] = [...branch];
  extension({
    on: (event: string, handler: Hook) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    events: { emit: () => {} },
    appendEntry: (customType: string) => { entries.push({ type: "custom", customType }); },
    sendMessage: () => {},
    registerTool: () => {},
    zod: { object: () => ({}), string: () => ({}), number: () => ({}), enum: () => ({}) },
  } as never);
  const ctx: Ctx = { agent: kind ? { kind } : undefined, models: { current: () => model }, sessionManager: { getBranch: () => entries } };
  for (const hook of handlers.get("session_start") ?? []) hook({}, ctx);
  // The messages one prompt gets from this extension's before_agent_start handlers.
  const prompt = async () => (await Promise.all((handlers.get("before_agent_start") ?? []).map((hook) => hook({}, ctx)))).flatMap((result) => (result && typeof result === "object" && "message" in result ? [result.message as { customType: string; content: string }] : []));
  return { prompt, entries };
}

test("a Paseo session outside the ticket flow gets the routing note on its first prompt only", async () => {
  const owner = session(OPUS);
  const first = await owner.prompt();
  assert.deepEqual(first.map((message) => message.content), [sessionRoutingNote(true)]);
  assert.deepEqual(await owner.prompt(), [], "a later prompt in the same session gets nothing");
  const resumed = session(OPUS, undefined, owner.entries);
  assert.deepEqual(await resumed.prompt(), [], "a resumed session that had it gets nothing");
});

test("a task subagent of such a session gets no routing note", async () => {
  assert.deepEqual(await session(FLASH, "sub").prompt(), []);
});

test("the note follows the session's own model: a strong session hands off, a cheap one implements", () => {
  const base = { ticket: undefined, agentId: "a", kind: undefined, routed: false };
  assert.equal(sessionRouting({ ...base, model: OPUS }), sessionRoutingNote(true));
  assert.equal(sessionRouting({ ...base, model: FLASH }), sessionRoutingNote(false));
  assert.equal(sessionRouting({ ...base, model: { provider: "deepseek", id: "deepseek-flash" } }), sessionRoutingNote(false));
  assert.equal(sessionRouting({ ...base, model: undefined }), sessionRoutingNote(true), "an unknown model frames and hands off");
  assert.notEqual(sessionRoutingNote(true), sessionRoutingNote(false));
});

test("ticket agents and sessions outside Paseo get no session routing note", () => {
  const base = { kind: undefined, model: OPUS, routed: false };
  assert.equal(sessionRouting({ ...base, ticket: "TUC-7", agentId: "a" }), null, "a ticket's plan carries its routing");
  assert.equal(sessionRouting({ ...base, ticket: "project-planner:run-1", agentId: "a" }), null, "a planner run is in the ticket flow");
  assert.equal(sessionRouting({ ...base, ticket: undefined, agentId: undefined }), null);
});
