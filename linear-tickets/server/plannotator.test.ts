import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { parseEvent, planDocument, PlannotatorBridge, plannotatorPaths, writeOpenScript } from "./plannotator";

const exec = promisify(execFile);

test("the browser hook publishes the port in the tailnet and records the link for the agent", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-plannotator-hook-"));
  try {
    const paths = plannotatorPaths(home);
    const launcher = await writeOpenScript(paths, { execPath: process.execPath, electron: false });
    const log = join(home, "calls.log");
    const fake = async (name: string, body: string) => {
      const path = join(home, name);
      await writeFile(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}`);
      await chmod(path, 0o755);
      return path;
    };
    const tailscale = await fake("tailscale", 'echo "Available within your tailnet:"; echo; echo "https://host.tail1.ts.net:41234/"');
    const opener = await fake("opener", "");
    await exec(launcher, ["http://localhost:41234/?review=1"], { env: { ...process.env, PASEO_AGENT_ID: "agent-7", LINEAR_TICKETS_TAILSCALE: tailscale, LINEAR_TICKETS_OPENER: opener } });
    const [name] = (await readdir(paths.events)).filter((file) => file.endsWith(".json"));
    const event = parseEvent(await readFile(join(paths.events, name), "utf8"));
    assert.deepEqual({ ...event, at: "t" }, { type: "opened", agentId: "agent-7", localUrl: "http://localhost:41234/?review=1", remoteUrl: "https://host.tail1.ts.net:41234/?review=1", at: "t" });
    assert.match(await readFile(log, "utf8"), /tailscale serve --bg --https=41234 http:\/\/127\.0\.0\.1:41234/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("events are validated; unknown shapes are rejected", () => {
  assert.equal(parseEvent("nope"), null);
  assert.equal(parseEvent(JSON.stringify({ type: "opened" })), null);
  assert.deepEqual(parseEvent(JSON.stringify({ type: "decided", agentId: "a", approved: false, feedback: "  tighten scope ", at: "2026-01-01T10:00:00Z" })),
    { type: "decided", agentId: "a", approved: false, feedback: "tighten scope", at: "2026-01-01T10:00:00Z" });
});

test("the plan document states the decision and feedback above the plan", () => {
  const document = planDocument({ type: "decided", agentId: "a", approved: false, feedback: "Split step 3", planContent: "# Plan\n\n- step", at: "2026-01-01T10:00:00Z" }, "TUC-25");
  assert.match(document, /^> \*\*Sent back with feedback\*\* in Plannotator on 2026-01-01 10:00 UTC for TUC-25/);
  assert.match(document, /## Review feedback\n\nSplit step 3/);
  assert.ok(document.endsWith("# Plan\n\n- step"));
});

function setup(labels: Record<string, string>) {
  const calls: string[] = [];
  const linear = {
    async comment(issueId: string, body: string) { calls.push(`comment ${issueId}: ${body}`); },
    async upsertIssueDocument(issueId: string, title: string) { calls.push(`document ${issueId} ${title}`); return "https://linear.app/doc/1"; },
  };
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { labels } }),
        timeline: { append: async (item: { data: { title: string; url?: string } }) => { calls.push(`row ${id}: ${item.data.title}${item.data.url ? ` ${item.data.url}` : ""}`); } },
      }),
    },
  } as unknown as PaseoApi;
  return { calls, linear, paseo };
}

async function withEvents(events: object[], run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plannotator-events-"));
  try {
    for (const [index, event] of events.entries()) await writeFile(join(directory, `${index}.json`), JSON.stringify(event));
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("a hand-off shows in the agent's chat and, for a ticket agent, as a Linear comment with the tailnet link", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
    { type: "decided", agentId: "agent-1", approved: true, planContent: "# Plan", at: "2026-01-01T10:05:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(linear, directory);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
    assert.deepEqual(calls, [
      "row agent-1: Handed off to Plannotator for review https://host.ts.net:4000/",
      "comment issue-1: 📋 **Plan ready for review in Plannotator**: https://host.ts.net:4000/",
      "row agent-1: Plan approved in Plannotator",
      "document issue-1 Plan: TUC-25",
      "comment issue-1: ✅ **Plan approved** in Plannotator — [plan](https://linear.app/doc/1)",
    ]);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("agents without a ticket, and subagents, only get the chat row", async () => {
  const cases: Record<string, string>[] = [{}, { "linear.issueId": "issue-1", "paseo.parent-agent-id": "root" }];
  for (const labels of cases) {
    const { calls, linear, paseo } = setup(labels);
    await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
      const bridge = new PlannotatorBridge(linear, directory);
      bridge.attach(paseo);
      await bridge.drain();
      bridge.stop();
      assert.deepEqual(calls, ["row agent-1: Handed off to Plannotator for review http://localhost:4000/"]);
    });
  }
});
