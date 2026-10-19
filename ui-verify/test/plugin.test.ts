import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "ui-verify-plugin-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "ui-verify@example.com");
  git(root, "config", "user.name", "ui-verify test");
  mkdirSync(join(root, "apps", "core-web", "src"), { recursive: true });
  writeFileSync(join(root, "apps", "core-web", "package.json"), "{}\n");
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => null;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}

test("the server entry registers both turn hooks and sends through paseo.agents.ref", async (t) => {
  const root = repository();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const server = {
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
      handlers.set(name, handler);
      return () => {};
    },
  } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  assert.deepEqual([...handlers.keys()], ["agent.turn_started", "agent.turn_ended"]);

  const sent: Array<{ agentId: string; text: string }> = [];
  const context = {
    paseo: {
      agents: {
        ref: (agentId: string) => ({
          send: async (text: string) => {
            sent.push({ agentId, text });
          },
        }),
      },
    },
  };
  const agent = {
    id: "agent-1",
    workspaceId: "workspace-1",
    parentAgentId: null,
    provider: "codex",
    cwd: root,
    title: null,
  };

  await handlers.get("agent.turn_started")!({ agent, turnId: "turn-1" }, context);
  writeFileSync(join(root, "apps", "core-web", "src", "Page.tsx"), "export const Page = () => 1;\n");
  await handlers.get("agent.turn_ended")!(
    {
      agent,
      turnId: "turn-1",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "Change the page" },
        { type: "assistant_message", text: "Done" },
      ],
    },
    context,
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].agentId, "agent-1");
  assert.ok(sent[0].text.startsWith("[ui-verify]"));
  cleanup();
});