import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { parseEvent, planDocument, PlannotatorBridge, plannotatorPaths, writeOpenScript } from "./plannotator";
import { DEFAULT_AUTO_APPROVE, planHash } from "../shared/plan-risk";

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

const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true,
  dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, status: true }, autoApprove: DEFAULT_AUTO_APPROVE,
};

// `ticket`: who wrote the ticket and its labels, for the risk policy's checks.
function setup(labels: Record<string, string>, ticket: { creatorId: string; labels: string[] } = { creatorId: "owner", labels: [] }) {
  const calls: string[] = [];
  const linear = {
    async comment(issueId: string, body: string) { calls.push(`comment ${issueId}: ${body}`); },
    async upsertIssueDocument(issueId: string, title: string) { calls.push(`document ${issueId} ${title}`); return "https://linear.app/doc/1"; },
    async moveToStateNamed(issueId: string, name: string) { calls.push(`state ${issueId} ${name}`); return { changed: true }; },
    async addLabel(issueId: string, name: string) { calls.push(`+${name} ${issueId}`); },
    async removeLabel(issueId: string, name: string) { calls.push(`-${name} ${issueId}`); },
    async issueState() { return { creatorId: ticket.creatorId, labels: ticket.labels.map((name, index) => ({ id: `l${index}`, name })) } as never; },
    async viewerId() { return "owner"; },
    async appUserId() { return "paseo-app"; },
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
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
    assert.deepEqual(calls, [
      "row agent-1: Handed off to Plannotator for review https://host.ts.net:4000/",
      "state issue-1 Planning",
      "-plan-ready issue-1",
      "comment issue-1: 📋 **Plan ready for review in Plannotator**: https://host.ts.net:4000/",
      "row agent-1: Plan approved in Plannotator",
      "state issue-1 In Progress",
      "+plan-ready issue-1",
      "document issue-1 Plan: TUC-25",
      "comment issue-1: ✅ **Plan approved** in Plannotator — [plan](https://linear.app/doc/1)",
    ]);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("a plan sent back loses plan-ready, and a review the plugin closed itself is not taken as a decision", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  await withEvents([{ type: "decided", agentId: "agent-1", approved: false, feedback: "Split step 2", at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
    assert.ok(calls.includes("-plan-ready issue-1"));
    assert.ok(calls.includes("state issue-1 Planning"));
    assert.ok(!calls.some((call) => call.startsWith("+plan-ready")));
  });
  calls.length = 0;
  await withEvents([{ type: "decided", agentId: "agent-2", approved: false, feedback: "The owner approved this plan for later implementation", at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    bridge.settled("agent-2");
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("a skipped plan is noted on the ticket with the agent's reason and leaves its state and labels alone", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  await withEvents([{ type: "skipped", agentId: "agent-1", reason: "One-line fix in format.ts, no schema or API change.", at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
    assert.deepEqual(calls, [
      "row agent-1: Plan skipped by the agent",
      "comment issue-1: ⏭️ **No plan**: the agent judged this ticket small enough to implement directly. Its reason: One-line fix in format.ts, no schema or API change.\n\nAdd the `plan` label to make it plan first.",
    ]);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("agents without a ticket, and subagents, only get the chat row", async () => {
  const cases: Record<string, string>[] = [{}, { "linear.issueId": "issue-1", "paseo.parent-agent-id": "root" }];
  for (const labels of cases) {
    const { calls, linear, paseo } = setup(labels);
    await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
      const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
      bridge.attach(paseo);
      await bridge.drain();
      bridge.stop();
      assert.deepEqual(calls, ["row agent-1: Handed off to Plannotator for review http://localhost:4000/"]);
    });
  }
});

test("with review links, the agent's stable link is posted instead of the review's own port", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const reviews = {
    async opened(agentId: string, event: { remoteUrl: string | null }, identifier?: string) { calls.push(`opened ${agentId} ${event.remoteUrl} ${identifier}`); return `https://host.ts.net:8444/review/${agentId}`; },
    async decided(agentId: string, approved: boolean) { calls.push(`decided ${agentId} ${approved}`); },
  };
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
    { type: "decided", agentId: "agent-1", approved: true, planContent: "# Plan", at: "2026-01-01T10:05:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, undefined, undefined, undefined, reviews);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
    assert.ok(calls.includes("opened agent-1 https://host.ts.net:4000/ TUC-25"));
    assert.ok(calls.includes("row agent-1: Handed off to Plannotator for review https://host.ts.net:8444/review/agent-1"));
    assert.ok(calls.some((call) => call.startsWith("comment issue-1: 📋") && call.includes("https://host.ts.net:8444/review/agent-1") && !call.includes(":4000")));
    assert.ok(calls.includes("decided agent-1 true"));
  });
});

const RISKY = (impact: number) => `# Plan\n\n1. Add the column to the report.\n\n## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: ${impact} — read-only report\n- Reversibility: revert — no data written\n- Feature flag: no\n- Migration: no\n- Auth: no\n- Failure mode: the report shows a wrong column; sales notices on the next export\n- Advisor rating: impact ${impact}, reversibility revert\n- Recommendation: auto — nothing for the owner to decide\n\n## Advisor review\n\nGPT-6 Astra, 1 round, agreed.\n`;

// Runs one review: the extension's advised event for `advisedPlan`, then the hand-off of `shownPlan`.
async function review(options: { advisedPlan: string; shownPlan?: string; verdict?: string; ticket?: { creatorId: string; labels: string[] } }) {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" }, options.ticket);
  const decisions: string[] = [];
  await withEvents([
    { type: "advised", agentId: "agent-1", verdict: options.verdict ?? "agreed", hash: planHash(options.advisedPlan), at: "2026-01-01T09:59:00Z" },
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
  ], async (directory) => {
    const decide = async (url: string, approve: boolean, feedback: string) => { decisions.push(`${url} ${approve} ${feedback}`); };
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => options.shownPlan ?? options.advisedPlan, undefined, undefined, undefined, decide);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  return { calls, decisions, comment: calls.find((call) => call.startsWith("comment issue-1")) ?? "" };
}

test("a plan rated within the threshold, agreed by the advisor for exactly that text, is approved without the owner", async () => {
  const { calls, decisions, comment } = await review({ advisedPlan: RISKY(1) });
  assert.deepEqual(decisions, ["http://localhost:4000/ true Auto-approved by the risk policy. Risk: impact 1/4, revert."]);
  assert.ok(calls.includes("row agent-1: Plan auto-approved by the risk policy https://host.ts.net:4000/"));
  assert.match(comment, /^comment issue-1: 🤖 \*\*Plan auto-approved\*\* by the risk policy: https:\/\/host\.ts\.net:4000\/\n\nAuto-approved within your threshold\. Risk: impact 1\/4, revert\.$/);
});

test("a plan goes to the owner, with the rating and why, when anything the policy relies on does not hold", async () => {
  const cases: [string, Parameters<typeof review>[0], RegExp][] = [
    ["above the threshold", { advisedPlan: RISKY(2) }, /impact 2 is above the threshold 1/],
    ["edited after the advisor review", { advisedPlan: RISKY(1), shownPlan: `${RISKY(1)}\nOne more step.\n` }, /no advisor review was recorded for this plan text/],
    ["open disagreements", { advisedPlan: RISKY(1), verdict: "disagreements" }, /the advisor review left open disagreements/],
    ["someone else's ticket", { advisedPlan: RISKY(1), ticket: { creatorId: "colleague", labels: [] } }, /the ticket was not written by the owner/],
    ["attended ticket", { advisedPlan: RISKY(1), ticket: { creatorId: "owner", labels: ["paseo-attended"] } }, /the ticket is marked attended/],
  ];
  for (const [name, options, reason] of cases) {
    const { decisions, comment } = await review(options);
    assert.deepEqual(decisions, [], name);
    assert.ok(comment.startsWith("comment issue-1: 📋 **Plan ready for review in Plannotator**"), name);
    assert.match(comment, /Risk: impact \d\/4, revert\. Needs your approval: /, name);
    assert.match(comment, reason, name);
  }
});

test("a project planner's work order within the threshold is approved without the owner and applied by the project flow", async () => {
  const order = `# Work order\n\n## Work order\n\n\`\`\`project-order\nTUC-12 blocks TUC-15\n\`\`\`\n\n${RISKY(0).replace(/^# Plan\n\n1\. Add the column to the report\.\n\n/, "")}`;
  const { calls, linear, paseo } = setup({ "linear.issueId": "planner-1", "linear.identifier": "TUC-90" }, { creatorId: "paseo-app", labels: ["paseo-planner", "plan"] });
  const decisions: string[] = [];
  await withEvents([
    { type: "advised", agentId: "agent-1", verdict: "agreed", hash: planHash(order), at: "2026-01-01T09:59:00Z" },
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
    // What the omp plan extension reports once Plannotator took the approval.
    { type: "decided", agentId: "agent-1", approved: true, planContent: order, at: "2026-01-01T10:00:05Z" },
  ], async (directory) => {
    const decide = async (url: string, approve: boolean) => { decisions.push(`${url} ${approve}`); };
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => order, undefined, undefined, undefined, decide);
    bridge.onProjectPlan(async (issueId, agentId, plan) => { calls.push(`apply ${issueId} ${agentId} ${plan === order}`); return true; });
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(decisions, ["http://localhost:4000/ true"]);
  assert.ok(calls.some((call) => call.startsWith("comment planner-1: 🤖 **Plan auto-approved**")));
  assert.ok(calls.includes("apply planner-1 agent-1 true"));
  assert.ok(!calls.includes("+plan-ready planner-1") && !calls.includes("state planner-1 In Progress"), "nothing else of an approval applies to a planner");
});
