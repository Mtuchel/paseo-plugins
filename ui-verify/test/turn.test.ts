import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { TimelineItem } from "../server/decision";
import { createTurnMonitor, type TurnMonitor } from "../server/turn";

type Started = PluginLifecycleEvents["agent.turn_started"];
type Ended = PluginLifecycleEvents["agent.turn_ended"];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository(t: TestContext, coreWeb = true): string {
  const root = mkdtempSync(join(tmpdir(), "ui-verify-turn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "ui-verify@example.com");
  git(root, "config", "user.name", "ui-verify test");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  if (coreWeb) {
    mkdirSync(join(root, "apps", "core-web", "src"), { recursive: true });
    writeFileSync(join(root, "apps", "core-web", "package.json"), "{}\n");
    writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => null;\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}

function agent(root: string): Started["agent"] {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    parentAgentId: null,
    provider: "codex",
    cwd: root,
    title: "UI work",
  };
}

const user = (text: string): TimelineItem => ({ type: "user_message", text });
const assistant = (text: string): TimelineItem => ({ type: "assistant_message", text });
const tool = (name: string): TimelineItem => ({
  type: "tool_call",
  callId: "call-1",
  name,
  status: "completed",
  error: null,
  detail: { type: "plain_text", text: name },
});

function completedTurn(root: string, timeline: TimelineItem[], turnId = "turn-1"): Ended {
  return { agent: agent(root), turnId, outcome: { kind: "completed" }, timeline };
}

async function deliver(
  monitor: TurnMonitor,
  event: Ended,
  sent: Array<{ agentId: string; text: string }>,
): Promise<void> {
  await monitor.turnEnded(event, async (agentId, text) => {
    sent.push({ agentId, text });
  });
}

test("a UI change without a browser check sends exactly one follow-up", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 'changed';\n");
  await deliver(monitor, completedTurn(root, [user("Change the page"), assistant("Done")]), sent);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].agentId, "agent-1");
  assert.ok(sent[0].text.startsWith("[ui-verify]"));
  assert.match(sent[0].text, /Page\.tsx/);
});

test("a browser screenshot during the turn sends nothing", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 1;\n");
  await deliver(
    monitor,
    completedTurn(root, [user("Change the page"), tool("browser_screenshot"), assistant("Checked")]),
    sent,
  );

  assert.deepEqual(sent, []);
});

test("a test-file-only change sends nothing", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "apps", "core-web", "src", "Page.test.tsx"), "test('page', () => {});\n");
  await deliver(monitor, completedTurn(root, [user("Add a test"), assistant("Done")]), sent);

  assert.deepEqual(sent, []);
});

test("a repository without apps/core-web sends nothing", async (t) => {
  const root = repository(t, false);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "src.tsx"), "export const x = 1;\n");
  await deliver(monitor, completedTurn(root, [user("Change it"), assistant("Done")]), sent);

  assert.deepEqual(sent, []);
});

test("a turn started by [ui-verify] sends nothing", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-2" });
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 2;\n");
  await deliver(
    monitor,
    completedTurn(root, [user("[ui-verify] Check the page in a browser"), assistant("Cannot here")]),
    sent,
  );

  assert.deepEqual(sent, []);
});

test("canceled and failed turns send nothing", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 3;\n");
  await deliver(
    monitor,
    { agent: agent(root), turnId: "turn-1", outcome: { kind: "canceled", reason: "user" }, timeline: [user("Go")] },
    sent,
  );

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-2" });
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 4;\n");
  await deliver(
    monitor,
    {
      agent: agent(root),
      turnId: "turn-2",
      outcome: { kind: "failed", error: { message: "boom" } },
      timeline: [user("Go again")],
    },
    sent,
  );

  assert.deepEqual(sent, []);
});

test("a change committed during the turn is detected", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "apps", "core-web", "src", "Committed.tsx"), "export const C = () => 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "committed inside the turn");
  await deliver(monitor, completedTurn(root, [user("Add it"), assistant("Committed")]), sent);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Committed\.tsx/);
});

test("only the files changed in this turn are named", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "apps", "core-web", "src", "First.tsx"), "export const First = () => 1;\n");
  await deliver(monitor, completedTurn(root, [user("First change"), assistant("Done")], "turn-1"), sent);

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-2" });
  writeFileSync(join(root, "apps", "core-web", "src", "Second.tsx"), "export const Second = () => 1;\n");
  await deliver(monitor, completedTurn(root, [user("Second change"), assistant("Done")], "turn-2"), sent);

  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /First\.tsx/);
  assert.doesNotMatch(sent[0].text, /Second\.tsx/);
  assert.match(sent[1].text, /Second\.tsx/);
  assert.doesNotMatch(sent[1].text, /First\.tsx/);
});

test("a failed send is logged and never rejects", async (t) => {
  const root = repository(t);
  const logs: string[] = [];
  const monitor = createTurnMonitor({ log: (message) => logs.push(message) });

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 5;\n");
  await assert.doesNotReject(
    monitor.turnEnded(completedTurn(root, [user("Change"), assistant("Done")]), async () => {
      throw new Error("daemon gone");
    }),
  );
  assert.ok(logs.some((message) => message.includes("could not send")));
});

test("a git failure at turn end is logged and never rejects", async (t) => {
  const root = repository(t);
  const logs: string[] = [];
  const monitor = createTurnMonitor({ log: (message) => logs.push(message) });
  const sent: Array<{ agentId: string; text: string }> = [];

  await monitor.turnStarted({ agent: agent(root), turnId: "turn-1" });
  rmSync(join(root, ".git"), { recursive: true, force: true });
  await deliver(monitor, completedTurn(root, [user("Change"), assistant("Done")]), sent);

  assert.deepEqual(sent, []);
  assert.ok(logs.some((message) => message.includes("could not snapshot")));
});

test("a turn end without a start does nothing", async (t) => {
  const root = repository(t);
  const monitor = createTurnMonitor({ log: () => {} });
  const sent: Array<{ agentId: string; text: string }> = [];

  await deliver(monitor, completedTurn(root, [user("Change"), assistant("Done")]), sent);

  assert.deepEqual(sent, []);
});