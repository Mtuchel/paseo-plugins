import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { DEFAULT_ACTIVATION, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { openInBrowser, parseEvent, planDocument, PlannotatorBridge, plannotatorPaths, writeOpenScript, type Parking } from "./plannotator";
import type { ParkedPlan } from "./parked";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { planHash } from "./review-outcome";
import { DecisionLog } from "./owner-decisions";
import { ReviewDeletions } from "./review-deletions";
import { AgentApi } from "./agent-app";
import { Credentials } from "./credentials";
import { LinearService, postGraphQL } from "./linear";
import { RateBudget, RateLimitedError, withPriority } from "./rate-budget";

const exec = promisify(execFile);
// Bridges built without an opener use the default one: never open a real browser from the tests.
process.env.LINEAR_TICKETS_OPENER = "true";

test("a host without a browser opener logs the failed open and keeps running", async (t) => {
  // Executor form: the plugin's lib is ES2023, without Promise.withResolvers.
  let reported: (line: string) => void = () => {};
  const logged = new Promise<string>((resolve) => { reported = resolve; });
  t.mock.method(console, "error", (line: string) => { reported(line); });
  const previous = process.env.LINEAR_TICKETS_OPENER;
  process.env.LINEAR_TICKETS_OPENER = join(tmpdir(), "no-such-opener-on-this-host");
  try {
    // The spawn error arrives asynchronously; unhandled, it would end this test process.
    openInBrowser("http://localhost:41429");
    assert.match(await logged, /^\[linear-tickets\] opening http:\/\/localhost:41429 failed: spawn .*ENOENT/);
  } finally { process.env.LINEAR_TICKETS_OPENER = previous; }
});

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
    assert.doesNotMatch(await readFile(log, "utf8"), /opener/, "the bridge opens the review once the risk policy has had its say");
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
  dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, status: true }, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, deputy: DEFAULT_DEPUTY,
};

// `ticket`: who wrote the ticket and its labels, for the risk policy's checks. `documents`: the
// ticket's documents by title (the approved plan).
function setup(labels: Record<string, string>, ticket: { creatorId: string; labels: string[] } = { creatorId: "owner", labels: [] }) {
  const calls: string[] = [];
  const documents: Record<string, string> = {};
  const linear = {
    async comment(issueId: string, body: string) { calls.push(`comment ${issueId}: ${body}`); },
    async upsertIssueDocument(issueId: string, title: string) { calls.push(`document ${issueId} ${title}`); return "https://linear.app/doc/1"; },
    async issueDocument(_issueId: string, title: string) { return title in documents ? { url: "https://linear.app/doc/1", content: documents[title] } : null; },
    async moveToStateNamed(issueId: string, name: string) { calls.push(`state ${issueId} ${name}`); return { changed: true }; },
    async moveToReady(issueId: string) { calls.push(`ready ${issueId}`); return { changed: true }; },
    async addLabel(issueId: string, name: string) { calls.push(`+${name} ${issueId}`); },
    async removeLabel(issueId: string, name: string) { calls.push(`-${name} ${issueId}`); },
    async issueState() { return { identifier: labels["linear.identifier"], creatorId: ticket.creatorId, labels: ticket.labels.map((name, index) => ({ id: `l${index}`, name })) } as never; },
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
  return { calls, documents, linear, paseo };
}

// The events directory sits in a directory of its own, like the plugin's, which keeps the advisor
// verdicts next to it.
async function withEvents(events: object[], run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "paseo-plannotator-"));
  const directory = join(root, "events");
  try {
    await mkdir(directory);
    for (const [index, event] of events.entries()) await writeFile(join(directory, `${index}.json`), JSON.stringify(event));
    await run(directory);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("with review links, the agent's stable link is posted instead of the review's own port, no tab opens, and the inbox learns the plan and why it needs the owner", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const tabs: string[] = [];
  const reviews = {
    async opened(agentId: string, event: { remoteUrl: string | null }, review: { identifier?: string } = {}) { calls.push(`opened ${agentId} ${event.remoteUrl} ${review.identifier}`); return `https://host.ts.net:8444/review/${agentId}`; },
    async decided(agentId: string, approved: boolean) { calls.push(`decided ${agentId} ${approved}`); },
    async described(localUrl: string, plan: string, judgement: { approved: boolean; reasons: string[] } | null) { calls.push(`described ${localUrl} ${plan === RISKY(2)} ${judgement?.approved} ${judgement?.reasons.join("; ")}`); },
    async describedFor() {},
  };
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
    { type: "decided", agentId: "agent-1", approved: true, planContent: "# Plan", at: "2026-01-01T10:05:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, reviews, async () => {}, (url) => tabs.push(url));
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
    assert.ok(calls.includes("opened agent-1 https://host.ts.net:4000/ TUC-25"));
    assert.ok(calls.includes("row agent-1: Handed off to Plannotator for review https://host.ts.net:8444/review/agent-1"));
    assert.ok(calls.some((call) => call.startsWith("comment issue-1: 📋") && call.includes("https://host.ts.net:8444/review/agent-1") && !call.includes(":4000")));
    assert.ok(calls.includes("described http://localhost:4000/ true false no advisor review was recorded for this plan text; impact 2 is above the threshold 1"));
    assert.ok(calls.includes("decided agent-1 true"));
    assert.deepEqual(tabs, [], "the review is in the inbox, so no browser tab opens");
  });
});

const MODEL = (tier: string) => `## Model\n\n- Tier: ${tier} — one report column\n- Strong steps: none — routine\n\n`;
const RISKY = (impact: number, newRule = "no — a one-off column") => `# Plan\n\n1. Add the column to the report.\n\n${MODEL("strong")}## Risk and impact\n\n- Areas: Sales\n- Processes: order report\n- Impact: ${impact} — read-only report\n- Reversibility: revert — no data written\n- Feature flag: no\n- Migration: no\n- Auth: no\n- New rule: ${newRule}\n- Failure mode: the report shows a wrong column; sales notices on the next export\n- Advisor rating: impact ${impact}, reversibility revert\n- Recommendation: auto — nothing for the owner to decide\n\n## Advisor review\n\nGPT-6 Astra, 1 round, agreed.\n`;

// Runs one review: the extension's advised event for `advisedPlan`, then the hand-off of `shownPlan`.
async function review(options: { advisedPlan: string; shownPlan?: string; verdict?: string; ticket?: { creatorId: string; labels: string[] } }) {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" }, options.ticket);
  const decisions: string[] = [];
  const tabs: string[] = [];
  await withEvents([
    { type: "advised", agentId: "agent-1", verdict: options.verdict ?? "agreed", hash: planHash(options.advisedPlan), at: "2026-01-01T09:59:00Z" },
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
  ], async (directory) => {
    const decide = async (url: string, approve: boolean, feedback: string) => { decisions.push(`${url} ${approve} ${feedback}`); };
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => options.shownPlan ?? options.advisedPlan, undefined, undefined, undefined, decide, (url) => tabs.push(url));
    bridge.attach(paseo);
    await bridge.drain();
    // The next sweep: an auto-approval the bridge recorded itself.
    await bridge.drain();
    bridge.stop();
  });
  return { calls, decisions, tabs, comment: calls.find((call) => call.startsWith("comment issue-1")) ?? "" };
}

test("a plan rated within the threshold, agreed by the advisor for exactly that text, is approved without the owner", async () => {
  const { calls, decisions, tabs, comment } = await review({ advisedPlan: RISKY(1) });
  assert.deepEqual(decisions, ["http://localhost:4000/ true Auto-approved by the risk policy. Risk: impact 1/4, revert."]);
  assert.deepEqual(tabs, [], "an auto-approved plan opens no review tab");
  assert.ok(calls.includes("row agent-1: Plan auto-approved by the risk policy https://host.ts.net:4000/"));
  assert.match(comment, /^comment issue-1: 🤖 \*\*Plan auto-approved\*\* by the risk policy: https:\/\/host\.ts\.net:4000\/\n\nAuto-approved within your threshold\. Risk: impact 1\/4, revert\.$/);
  // Plannotator reports no approval of its own plan mode: the bridge records it, so the approval
  // writes the plan document and moves the ticket to coding like the owner's would.
  assert.ok(calls.includes("row agent-1: Plan approved in Plannotator"));
  assert.ok(calls.includes("document issue-1 Plan: TUC-25"));
  assert.ok(calls.includes("state issue-1 In Progress"));
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
    const { decisions, tabs, comment } = await review(options);
    assert.deepEqual(decisions, [], name);
    assert.deepEqual(tabs, ["http://localhost:4000/"], name);
    assert.ok(comment.startsWith("comment issue-1: 📋 **Plan ready for review in Plannotator**"), name);
    assert.match(comment, /Risk: impact \d\/4, revert\. Needs your approval: /, name);
    assert.match(comment, reason, name);
  }
});

test("a plan that sets a new rule goes to the owner although everything else would approve it", async () => {
  const rule = await review({ advisedPlan: RISKY(0, "yes — every report gets a CSV export") });
  assert.deepEqual(rule.decisions, []);
  assert.match(rule.comment, /Needs your approval: it sets a new rule\.$/);
  assert.equal((await review({ advisedPlan: RISKY(0) })).decisions.length, 1, "the same plan without the rule is approved");
});

// A plugin reload (a rollout, a daemon restart) between the planner's record and its hand-off used
// to forget the verdict, so the plan went to the owner with "no advisor review was recorded".
test("an advisor review recorded before a plugin reload still counts for the plan handed off after it", async () => {
  const { linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const decisions: string[] = [];
  await withEvents([{ type: "advised", agentId: "agent-1", verdict: "agreed", hash: planHash(RISKY(1)), at: "2026-01-01T09:59:00Z" }], async (directory) => {
    const run = async () => {
      const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, async (url, approve) => { decisions.push(`${url} ${approve}`); }, () => {});
      bridge.attach(paseo);
      await bridge.drain();
      bridge.stop();
    };
    await run();
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" }));
    await run();
  });
  assert.deepEqual(decisions, ["http://localhost:4000/ true"]);
});

test("approving a plan files its follow-ups, on the Plannotator page or as a parked plan; a send-back files none", async () => {
  const { linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake([]);
  const filed: string[] = [];
  const run = (events: object[]) => withEvents(events, async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.useFollowUps({ file: async (origin) => { filed.push(`${origin.issueId} ${origin.identifier} ${origin.documentUrl} ${origin.plan}`); }, retryPending: async () => {} });
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  await run([{ type: "decided", agentId: "agent-1", approved: false, feedback: "Narrow it", planContent: "# Plan A", at: "2026-01-01T09:00:00Z" }]);
  await run([{ type: "decided", agentId: "agent-1", approved: true, planContent: "# Plan A", at: "2026-01-01T10:00:00Z" }]);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-2", plan: "# Parked plan", line: "", reasons: [], model: null, parkedAt: "2026-01-01T11:00:00Z", announced: true });
  await run([{ type: "decided", agentId: "agent-2", approved: true, parked: true, at: "2026-01-01T12:00:00Z" }]);
  assert.deepEqual(filed, ["issue-1 TUC-25 https://linear.app/doc/1 # Plan A", "issue-1 TUC-25 https://linear.app/doc/1 # Parked plan"]);
});

test("a planner run's work order is approved on submission and handed to the project flow, without a Linear read that could fail", async () => {
  const order = `# Work order\n\n## Work order\n\n\`\`\`project-order\nTUC-12 blocks TUC-15\n\`\`\`\n\n${RISKY(3).replace(/^# Plan\n\n1\. Add the column to the report\.\n\n/, "")}`;
  const { calls, linear, paseo } = setup({ "linear.plannerRun": "run-1" });
  // Linear's hourly limit: the old risk check failed here and parked the work order for the owner.
  linear.issueState = async () => { throw new Error("Linear's hourly request limit is reached"); };
  const decisions: string[] = [];
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
    // What the omp plan extension reports once Plannotator took the plugin's approval.
    { type: "decided", agentId: "agent-1", approved: true, planContent: order, at: new Date().toISOString() },
  ], async (directory) => {
    const decide = async (url: string, approve: boolean) => { decisions.push(`${url} ${approve}`); };
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => order, undefined, undefined, undefined, decide, undefined, parkingFake(calls).parking);
    bridge.onProjectPlan({
      isPlannerRun: async (runId) => runId === "run-1",
      applyPlan: async (runId, agentId, plan) => { calls.push(`apply ${runId} ${agentId} ${plan === order}`); return true; },
    });
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(decisions, ["http://localhost:4000/ true"]);
  assert.deepEqual(calls, ["apply run-1 agent-1 true"], "applied once; never parked, and nothing of a ticket approval (state, plan-ready, comments) applies");
});

test("a work order of a run the flow no longer accepts is reported, not written, and nothing of a ticket review applies", async () => {
  const order = "```project-order\nTUC-1 blocks TUC-2\n```";
  const { calls, linear, paseo } = setup({ "linear.plannerRun": "run-1" });
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => order);
    bridge.onProjectPlan({ isPlannerRun: async () => true, applyPlan: async () => { calls.push("apply"); return false; } });
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(calls, ["apply"], "the flow rejected the write (the run is already closed)");
});

test("an obsolete run report is closed without being handed to the owner or written", async () => {
  const { calls, linear, paseo } = setup({ "linear.plannerRun": "old-run" });
  const decisions: boolean[] = [];
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory,
      undefined, async () => { throw new Error("An obsolete run must not fetch its plan"); },
      undefined, undefined, undefined, async (_url, approved) => { decisions.push(approved); });
    bridge.onProjectPlan({ isPlannerRun: async () => false, applyPlan: async () => { calls.push("apply"); return true; } });
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(calls, [], "no owner review, no order write");
  assert.deepEqual(decisions, [true], "the obsolete review is dismissed so its agent can stop");
});

test("a work order Paseo cannot read line by line is sent back to the planner, never applied as an empty order", async () => {
  for (const order of ["# Work order\n\nTUC-12 blocks TUC-15", "## Work order\n\n```project-order\nTUC-12 blocks TUC-15 and TUC-16\n```"]) {
    const { calls, linear, paseo } = setup({ "linear.plannerRun": "run-1" });
    const decisions: string[] = [];
    await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" }], async (directory) => {
      const decide = async (url: string, approve: boolean, feedback: string) => { decisions.push(`${approve} ${feedback.split("\n\n")[1]}`); };
      const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => order, undefined, undefined, undefined, decide, undefined, parkingFake(calls).parking);
      bridge.onProjectPlan({ isPlannerRun: async () => true, applyPlan: async () => { calls.push("apply"); return true; } });
      bridge.attach(paseo);
      await bridge.drain();
      bridge.stop();
    });
    assert.equal(decisions.length, 1);
    assert.match(decisions[0], order.includes("```") ? /^false - Not one work-order change: "TUC-12 blocks TUC-15 and TUC-16"/ : /^false - The plan has no ```project-order block\./);
    assert.deepEqual(calls, [], "nothing applied, nothing parked");
  }
});

// In-memory parked plans; `available` is the central host running.
function parkingFake(calls: string[], available = true) {
  const plans = new Map<string, ParkedPlan>();
  const parking: Parking = {
    plans: {
      forAgent: async (agentId) => [...plans.values()].find((plan) => plan.agentId === agentId) ?? null,
      put: async (plan) => { plans.set(plan.issueId, plan); },
      remove: async (issueId) => { plans.delete(issueId); },
    },
    available: () => available,
    retire: async (localUrl, agentId) => { calls.push(`retire ${agentId} ${localUrl}`); },
  };
  return { plans, parking };
}

test("a plan that needs the owner is parked and its agent retired; the central host's review is announced once, and the decision moves the ticket on", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  const tabs: string[] = [];
  const decisions: string[] = [];
  const inbox: string[] = [];
  const reviews = {
    async opened(agentId: string, event: { localUrl: string }, review: { since?: string } = {}) { inbox.push(`${agentId} ${event.localUrl} since ${review.since}`); return null; },
    async decided() {},
    async described() {},
    async describedFor() {},
  };
  const run = async (events: object[]) => withEvents(events, async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, reviews,
      async (url, approve) => { decisions.push(`${url} ${approve}`); }, (url) => tabs.push(url), parking);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  await run([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" }]);
  assert.deepEqual(calls, ["retire agent-1 http://localhost:4000/", "state issue-1 Planning", "-plan-ready issue-1"]);
  assert.deepEqual({ decisions, tabs }, { decisions: [], tabs: [] }, "the agent's own review is neither decided nor opened");
  assert.deepEqual({ ...plans.get("issue-1"), parkedAt: "" }, { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "Risk: impact 2/4, revert. Needs your approval: no advisor review was recorded for this plan text; impact 2 is above the threshold 1.", reasons: ["no advisor review was recorded for this plan text", "impact 2 is above the threshold 1"], model: null, parkedAt: "", announced: false });

  // The central host serves it; a restart of the host opens it again without a second announcement.
  calls.length = 0;
  const hosted = { type: "opened", agentId: "agent-1", localUrl: "http://localhost:5000/", remoteUrl: "https://host.ts.net:5000/", at: "2026-01-01T10:01:00Z" };
  await run([hosted]);
  await run([{ ...hosted, localUrl: "http://localhost:5001/", at: "2026-01-01T11:00:00Z" }]);
  assert.deepEqual(tabs, ["http://localhost:5000/"]);
  assert.equal(calls.filter((call) => call.startsWith("comment issue-1: 📋 **Plan waiting for your review in Plannotator**: https://host.ts.net:5000/")).length, 1);
  assert.equal(plans.get("issue-1")?.announced, true);
  const parkedAt = plans.get("issue-1")?.parkedAt;
  assert.deepEqual(inbox.slice(1), [`agent-1 http://localhost:5000/ since ${parkedAt}`, `agent-1 http://localhost:5001/ since ${parkedAt}`], "the inbox keeps the time the plan was parked across host restarts");

  calls.length = 0;
  await run([{ type: "decided", agentId: "agent-1", approved: true, parked: true, planContent: RISKY(2), at: "2026-01-01T12:00:00Z" }]);
  assert.deepEqual(calls, ["document issue-1 Plan: TUC-25", "+plan-ready issue-1", "ready issue-1", "comment issue-1: ✅ **Plan approved** in Plannotator ([plan](https://linear.app/doc/1))\n\nAssign Paseo again to implement it."]);
  assert.equal(plans.size, 0);
});

test("a parked plan sent back keeps no plan-ready and asks for a new plan; the retired agent's own report is ignored", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  await withEvents([
    { type: "decided", agentId: "agent-1", approved: false, feedback: "Closed by the plugin", at: "2026-01-01T10:00:01Z" },
    { type: "decided", agentId: "agent-1", approved: false, parked: true, feedback: "Split step 1", at: "2026-01-01T12:00:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(calls, ["document issue-1 Plan: TUC-25", "comment issue-1: ↩️ **Plan sent back** in Plannotator ([plan](https://linear.app/doc/1))\n\nSplit step 1\n\nAssign Paseo again to plan it again."]);
  assert.equal(plans.size, 0);
});

// The plans parked on 2026-10-05 without a recorded advisor review had one from their planner; only
// the record was missing. Recording it later, for exactly the parked text, gets the plan judged again.
test("a parked plan is judged again once its advisor review is recorded for exactly its text", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  const inbox: string[] = [];
  const reviews = {
    async opened() { return null; },
    async decided() {},
    async described() {},
    async describedFor(agentId: string, _plan: string, judgement: { reasons: string[] }) { inbox.push(`${agentId}: ${judgement.reasons.join("; ")}`); },
  };
  const unrecorded = "no advisor review was recorded for this plan text";
  const park = (plan: string) => plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan, line: `Needs your approval: ${unrecorded}.`, reasons: [unrecorded], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  const advised = (plan: string, verdict = "agreed") => ({ type: "advised", agentId: "agent-1", verdict, hash: planHash(plan), at: "2026-01-01T12:00:00Z" });
  const run = (events: object[]) => withEvents(events, async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, reviews, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    await bridge.drain();
    // The next sweep: an approval the bridge recorded itself.
    await bridge.drain();
    bridge.stop();
  });

  park(RISKY(1));
  await run([advised(`${RISKY(1)}\nOne more step.\n`)]);
  assert.deepEqual({ reasons: plans.get("issue-1")?.reasons, calls, inbox }, { reasons: [unrecorded], calls: [], inbox: [] }, "a review of another text changes nothing");

  park(RISKY(2));
  await run([advised(RISKY(2))]);
  assert.deepEqual({ ...plans.get("issue-1"), parkedAt: "" }, { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "Risk: impact 2/4, revert. Needs your approval: impact 2 is above the threshold 1.", reasons: ["impact 2 is above the threshold 1"], model: null, parkedAt: "", announced: true });
  assert.equal(plans.get("issue-1")?.parkedAt, "2026-01-01T10:00:00Z", "the plan keeps its place: the host does not serve it again");
  assert.deepEqual(inbox, ["agent-1: impact 2 is above the threshold 1"]);
  assert.deepEqual(calls, ["retire agent-1 null"], "the planner that recorded the review is retired again");

  calls.length = 0;
  inbox.length = 0;
  park(RISKY(1));
  await run([advised(RISKY(1), "unavailable")]);
  assert.deepEqual(plans.get("issue-1")?.reasons, ["the advisor was unavailable"]);

  calls.length = 0;
  park(RISKY(1));
  await run([advised(RISKY(1))]);
  assert.equal(plans.size, 0, "approved within the threshold");
  assert.deepEqual(calls, [
    "retire agent-1 null",
    "document issue-1 Plan: TUC-25",
    "+plan-ready issue-1",
    "ready issue-1",
    "comment issue-1: ✅ **Plan approved** in Plannotator ([plan](https://linear.app/doc/1))\n\nAuto-approved by the risk policy. Risk: impact 1/4, revert.\n\nAssign Paseo again to implement it.",
  ]);
});

test("a parked decision whose hand-off fails on a Linear error is delivered in full by the retry, not dropped", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  const upsert = linear.upsertIssueDocument;
  let outage = true;
  linear.upsertIssueDocument = async (issueId: string, title: string) => {
    if (outage) { outage = false; throw new Error("The Linear API request failed (HTTP 503). Try again."); }
    return upsert(issueId, title);
  };
  const errors = test.mock.method(console, "error", () => {});
  await withEvents([{ type: "decided", agentId: "agent-1", approved: false, parked: true, feedback: "Cover every table", at: "2026-01-01T12:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  errors.mock.restore();
  assert.deepEqual(calls, ["document issue-1 Plan: TUC-25", "comment issue-1: ↩️ **Plan sent back** in Plannotator ([plan](https://linear.app/doc/1))\n\nCover every table\n\nAssign Paseo again to plan it again."]);
  assert.equal(plans.size, 0);
});

test("a non-parked approval retries its Linear writes after a rate limit instead of being treated as delivered", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const upsert = linear.upsertIssueDocument;
  let limited = true;
  linear.upsertIssueDocument = async (issueId, title) => {
    if (limited) throw new RateLimitedError("app", Date.now() + 60_000);
    return upsert(issueId, title);
  };
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    Object.assign(bridge, { paseo });
    await bridge.drain();
    assert.deepEqual(await readdir(directory), ["0.json"]);
    limited = false;
    t.mock.timers.tick(60_000);
    await bridge.drain();
    await bridge.drain();
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(calls.filter((call) => call.startsWith("document ")), ["document issue-1 Plan: TUC-25"]);
    assert.deepEqual(calls.filter((call) => call.startsWith("comment ")), ["comment issue-1: ✅ **Plan approved** in Plannotator — [plan](https://linear.app/doc/1)"]);
  });
});

test("parked rate-limited decisions keep their event and attempt count until resumeAt, however often Linear pauses", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  const errors = t.mock.method(console, "error", () => {});
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-10-07T10:00:00Z", announced: true });
  const upsert = linear.upsertIssueDocument;
  let requests = 0;
  let limited = true;
  const maxAttempts = 20;
  linear.upsertIssueDocument = async (issueId, title) => {
    requests++;
    if (limited) throw new RateLimitedError("app", Date.now() + 60_000);
    return upsert(issueId, title);
  };
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, parked: true, at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    Object.assign(bridge, { paseo });
    // The in-process retry map is private; inspect it to prove the pre-existing attempts stay intact.
    const retryState = bridge as unknown as { attempts: Map<string, number> };
    const attempts = retryState.attempts;
    attempts.set("0.json", 2);
    for (let pause = 0; pause < maxAttempts + 2; pause++) {
      await bridge.drain();
      assert.equal(requests, pause + 1);
      assert.equal(attempts.get("0.json"), 2, "rate limits never count as a failed attempt");
      assert.deepEqual(await readdir(directory), ["0.json"]);
      assert.equal(plans.size, 1);
      t.mock.timers.tick(59_999);
      await bridge.drain();
      await bridge.drain();
      assert.equal(requests, pause + 1, "not retried before resumeAt");
      assert.equal(errors.mock.callCount(), pause + 1, "one log per event and pause");
      t.mock.timers.tick(1);
    }
    limited = false;
    await bridge.drain();
    await bridge.drain();
    assert.deepEqual(await readdir(directory), []);
    assert.equal(attempts.has("0.json"), false);
    assert.equal(plans.size, 0);
    assert.equal(calls.filter((call) => call.startsWith("document ")).length, 1);
    assert.equal(calls.filter((call) => call.startsWith("comment ")).length, 1);
  });
});

test("a Plannotator decision reaches its cold-cache reads and writes through real admission at 3% points", async (t) => {
  const budget = new RateBudget(() => 0);
  const headers = { "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "4500", "x-ratelimit-complexity-limit": "2000000", "x-ratelimit-complexity-remaining": "60000", "x-complexity": "100" };
  for (const pool of ["app", "key"] as const) budget.acquire(pool, "owner").done(new Headers(headers), false);
  const sent: string[] = [];
  const data: Record<string, object> = {
    issueState: { issue: { id: "issue-1", identifier: "TUC-25", state: { id: "todo", name: "Todo", type: "unstarted" }, team: { id: "team-1" }, labels: { nodes: [] } } },
    teamStates: { team: { states: { nodes: [{ id: "coding", name: "In Progress", type: "started", position: 1 }] } } },
    issueUpdateState: { issueUpdate: { success: true, issue: { id: "issue-1", state: { id: "coding", name: "In Progress", type: "started" } } } },
    labelByName: { issueLabels: { nodes: [{ id: "ready", name: "plan-ready" }] } },
    addLabel: { issueAddLabel: { success: true } },
    issueDocuments: { issue: { id: "issue-1", documents: { nodes: [] } } },
    documentCreate: { documentCreate: { success: true, document: { id: "doc-1", url: "https://linear.app/doc/1" } } },
    comment: { commentCreate: { success: true, comment: { id: "comment-1" } } },
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body: { query: string } = JSON.parse(String(init?.body));
    const query = body.query;
    const operation = query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? "?";
    sent.push(operation);
    assert.ok(data[operation], `unexpected Linear operation ${operation}`);
    return new Response(JSON.stringify({ data: data[operation] }), { headers });
  });
  const post = (key: string, query: string, variables: Record<string, unknown>) => postGraphQL(key, query, variables, budget);
  const linear = new LinearService(new Credentials("/unused", "owner-key"), post, new AgentApi({ accessToken: async () => "app-token" }, post));
  const { paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, at: "2026-10-07T12:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    Object.assign(bridge, { paseo });
    await withPriority("background", "decision ingress test", () => bridge.drain());
    assert.deepEqual(await readdir(directory), []);
  });
  assert.deepEqual(sent, ["issueState", "teamStates", "issueUpdateState", "labelByName", "addLabel", "issueDocuments", "documentCreate", "comment"]);
  await assert.rejects(linear.comment("issue-1", "ordinary agent progress"), RateLimitedError);
  assert.equal(sent.length, 8, "ordinary interactive comments cannot consume the owner's last share");
});

test("a parked decision is never given up while Linear stays unavailable", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  linear.upsertIssueDocument = async () => { throw new Error("Linear's hourly request limit is reached for the Paseo Linear app"); };
  const errors = test.mock.method(console, "error", () => {});
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, parked: true, planContent: RISKY(2), at: "2026-01-01T12:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    for (let attempt = 0; attempt < 25; attempt++) await bridge.drain();
    bridge.stop();
    assert.deepEqual(await readdir(directory), ["0.json"], "the decision waits for the next retry");
  });
  const failures = errors.mock.callCount();
  errors.mock.restore();
  assert.equal(failures, 20, "past the quick attempts it waits instead of retrying every sweep");
  assert.equal(plans.size, 1);
});

test("without the central host a plan that needs the owner keeps its agent and opens as before", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls, false);
  const tabs: string[] = [];
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, async () => {}, (url) => tabs.push(url), parking);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(tabs, ["http://localhost:4000/"]);
  assert.equal(plans.size, 0);
  assert.ok(!calls.some((call) => call.startsWith("retire")));
  assert.ok(calls.some((call) => call.startsWith("comment issue-1: 📋 **Plan ready for review in Plannotator**")));
});

test("the owner's review feedback is logged for the decision candidates; the risk policy's note and the retired agent's report are not", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-plannotator-decisions-"));
  try {
    const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
    const log = new DecisionLog(home);
    const { plans, parking } = parkingFake(calls);
    // Recent times: the log drops entries older than 60 days.
    const base = Date.now() - 600 * 60_000;
    const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
    plans.set("issue-2", { issueId: "issue-2", identifier: "TUC-26", agentId: "agent-9", plan: "# Plan", line: "", reasons: [], model: null, parkedAt: at(0), announced: true });
    await withEvents([
      { type: "decided", agentId: "agent-1", approved: false, feedback: "Use option B", at: at(60) },
      { type: "decided", agentId: "agent-2", approved: true, feedback: "Auto-approved by the risk policy. Risk: impact 0/4, revert.", at: at(70) },
      { type: "decided", agentId: "agent-3", approved: true, at: at(80) },
      { type: "decided", agentId: "agent-9", approved: false, feedback: "The owner has to decide this plan.", at: at(90) },
      { type: "decided", agentId: "agent-9", approved: true, parked: true, feedback: "Fine, but keep the old export", at: at(180) },
    ], async (directory) => {
      const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
      bridge.recordDecisions(log);
      bridge.attach(paseo);
      await bridge.drain();
      bridge.stop();
    });
    assert.deepEqual((await log.entries()).map((entry) => entry.kind === "plan-feedback" ? [entry.id, entry.identifier, entry.approved, entry.text] : entry.kind), [
      [`agent-1:${at(60)}`, "TUC-25", false, "Use option B"],
      [`agent-9:${at(180)}`, "TUC-26", true, "Fine, but keep the old export"],
    ]);

    // A log that cannot be written never stops the hand-off.
    calls.length = 0;
    const errors = test.mock.method(console, "error", () => {});
    await withEvents([{ type: "decided", agentId: "agent-4", approved: false, feedback: "Split it", at: at(240) }], async (directory) => {
      const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
      bridge.recordDecisions({ append: async () => { throw new Error("disk full"); } });
      bridge.attach(paseo);
      await bridge.drain();
      bridge.stop();
    });
    errors.mock.restore();
    assert.ok(calls.includes("document issue-1 Plan: TUC-25"));
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /decision log: plan feedback on TUC-25 failed: disk full/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Tier decisions as the bridge records them, and the agents it sends back to planning.
function tierFake(calls: string[]) {
  const recorded: string[] = [];
  const tiers = {
    store: { record: async (issue: { identifier: string }, event: { tier: string; source: string; reason: string; agentId: string | null }) => { recorded.push(`${issue.identifier} ${event.source} ${event.tier} ${event.agentId}: ${event.reason}`); return null as never; } },
    apply: async (agentId: string) => { calls.push(`apply ${agentId}`); },
    replan: async (agent: { id: string; identifier: string }, message: string) => { calls.push(`replan ${agent.id} ${agent.identifier}: ${message.split("\n\n")[0]}`); },
  };
  return { recorded, tiers };
}

test("an approved standard plan sets the ticket's tier; an escalation from it records the strong tier first, then relabels, switches and tells the owner", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" }, { creatorId: "owner", labels: ["model:cheap"] });
  const { recorded, tiers } = tierFake(calls);
  const plan = "# Plan\n1. Add the column\n\n## Model\n\n- Tier: standard — one column with a filter\n- Strong steps: none — routine\n";
  await withEvents([
    { type: "decided", agentId: "agent-1", approved: true, planContent: plan, at: "2026-01-01T10:05:00Z" },
    { type: "escalated", agentId: "agent-1", reason: "the migration test still fails after two fixes", at: "2026-01-01T11:00:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    bridge.useTiers(tiers);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(recorded, [
    "TUC-25 plan standard agent-1: one column with a filter",
    "TUC-25 escalated strong agent-1: the migration test still fails after two fixes",
  ]);
  assert.deepEqual(calls, [
    "row agent-1: Plan approved in Plannotator", "+model:standard issue-1", "-model:cheap issue-1", "-model:strong issue-1", "apply agent-1",
    "state issue-1 In Progress", "+plan-ready issue-1", "document issue-1 Plan: TUC-25", "comment issue-1: ✅ **Plan approved** in Plannotator — [plan](https://linear.app/doc/1)",
    "+model:strong issue-1", "-model:cheap issue-1", "-model:standard issue-1", "apply agent-1", "comment issue-1: ⬆️ **Escalated to the strong model tier: the migration test still fails after two fixes**",
  ]);
});

test("an approved plan that names no tier records none and sends its agent back to planning for it", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { recorded, tiers } = tierFake(calls);
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, planContent: "# Plan\n1. Add the column\n", at: "2026-01-01T10:05:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    bridge.useTiers(tiers);
    bridge.attach(paseo);
    await bridge.drain();
    bridge.stop();
  });
  assert.deepEqual(recorded, [], "no default tier");
  assert.ok(calls.includes("replan agent-1 TUC-25: The approved plan for TUC-25 has no `## Model` section, so it does not say which model implements it. You are back in planning for that section only: do not change code yet. Submit the approved plan unchanged with the `## Model` section added; when nothing else changed, the plugin approves it without the owner."));
  assert.ok(!calls.some((call) => call.startsWith("+model:") || call.startsWith("apply")));
});

// One submitted ticket plan: its hand-off and, once the plugin sent it back, the extension's
// report of that send-back.
async function submit(plan: string, approvedDocument?: string) {
  const { calls, documents, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  if (approvedDocument) documents["Plan: TUC-25"] = approvedDocument;
  const decisions: string[] = [];
  const tabs: string[] = [];
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const decide = async (url: string, approve: boolean, feedback: string) => {
      decisions.push(`${approve} ${feedback}`);
      if (!approve) await writeFile(join(directory, "1.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: false, feedback, planContent: plan, at: "2026-01-01T10:00:05Z" }));
    };
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => plan, undefined, undefined, undefined, decide, (url) => tabs.push(url));
    bridge.attach(paseo);
    await bridge.drain();
    await bridge.drain();
    bridge.stop();
  });
  return { calls, decisions, tabs };
}

test("a ticket plan without a usable model tier goes back to its planner, never to the owner", async () => {
  const cases: [string, string, RegExp][] = [
    ["no section", RISKY(1).replace(MODEL("strong"), ""), /^false Paseo sent this plan back before review\. The plan has no "## Model" section\./],
    ["no tier line", RISKY(1).replace("- Tier: strong — one report column\n", ""), /has no readable "- Tier: <cheap \| standard \| strong> — <why>" line/],
    ["below strong at impact 3", RISKY(3).replace("Tier: strong", "Tier: standard"), /"- Tier: standard" is not allowed for this plan \(impact 3 in "## Risk and impact"\): write "- Tier: strong — <why>"\./],
    ["cheap with a migration", RISKY(1).replace("Tier: strong", "Tier: cheap").replace("- Migration: no", "- Migration: yes — a new column"), /"- Tier: cheap" is not allowed for this plan \(a migration in/],
  ];
  for (const [name, plan, problem] of cases) {
    const { calls, decisions, tabs } = await submit(plan);
    assert.equal(decisions.length, 1, name);
    assert.match(decisions[0], problem, name);
    assert.deepEqual({ calls, tabs }, { calls: [], tabs: [] }, `${name}: no review, comment, document or state for the owner, and the send-back is not the owner's`);
  }
});

test("an approved plan resubmitted with only its tier added is approved without the owner; any other change goes to the owner", async () => {
  const legacy = "# Plan\n\n1. Add the column to the report.\n2. Show it in the export.\n";
  const approved = planDocument({ type: "decided", agentId: "agent-0", approved: true, feedback: "Looks good", planContent: legacy, at: "2026-01-01T09:00:00Z" }, "TUC-25");
  // Rated above the owner's threshold: only the earlier approval lets it through.
  const tiered = `${legacy}\n${RISKY(3).slice(RISKY(3).indexOf("## Model"))}`;
  const same = await submit(tiered, approved);
  assert.deepEqual(same.decisions, ["true Approved again: the owner approved this plan before; only its model tier was added."]);
  assert.deepEqual(same.tabs, []);
  assert.ok(same.calls.includes("document issue-1 Plan: TUC-25"), "the approval is recorded like any other");

  const changed = await submit(tiered.replace("Show it in the export.", "Show it in the export and the dashboard."), approved);
  assert.deepEqual(changed.decisions, []);
  assert.deepEqual(changed.tabs, ["http://localhost:4000/"]);
  assert.ok(changed.calls.some((call) => /^comment issue-1: 📋 \*\*Plan ready for review in Plannotator\*\*.*Needs your approval/s.test(call)));

  const sentBack = planDocument({ type: "decided", agentId: "agent-0", approved: false, feedback: "Narrow it", planContent: legacy, at: "2026-01-01T09:00:00Z" }, "TUC-25");
  assert.deepEqual((await submit(tiered, sentBack)).decisions, [], "a plan that was sent back has no approval to keep");
});

test("pending deletion pauses only that ticket's events; confirmed deletion consumes stale events after restart", async () => {
  const issueId = "3b241101-e2bb-4255-8caf-4136c566a962";
  const { calls, linear, paseo } = setup({ "linear.issueId": issueId, "linear.identifier": "TUC-630" });
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const file = join(directory, "..", "deletions.json");
    const journal = new ReviewDeletions(file);
    await journal.put({ issueId, identifier: "TUC-630", agentId: "agent-1", phase: "pending" });
    const paused = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    paused.useDeletions(journal);
    paused.attach(paseo);
    try { await paused.drain(); } finally { paused.stop(); }
    assert.deepEqual(await readdir(directory), ["0.json"]);
    assert.deepEqual(calls, []);
    await journal.put({ issueId, identifier: "TUC-630", agentId: "agent-1", phase: "deleted" });
    const restarted = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    restarted.useDeletions(new ReviewDeletions(file));
    restarted.attach(paseo);
    try { await restarted.drain(); } finally { restarted.stop(); }
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(calls, [], "no approval, denial, new review, comment or successor event");
    const unrelated = setup({ "linear.issueId": "other-issue", "linear.identifier": "TUC-631" });
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "decided", agentId: "agent-2", approved: false, feedback: "Narrow the scope", at: "2026-01-01T10:05:00Z" }));
    const other = new PlannotatorBridge(unrelated.linear, { read: async () => settings }, directory);
    other.useDeletions(new ReviewDeletions(file));
    other.attach(unrelated.paseo);
    try { await other.drain(); } finally { other.stop(); }
    assert.ok(unrelated.calls.includes("state other-issue Planning"));
    assert.ok(unrelated.calls.includes("document other-issue Plan: TUC-631"));
  });
});

test("rechecked plans cannot auto-approve even with matching fresh advice or an approved tier-only predecessor", async () => {
  const { calls, documents, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  documents["Plan: TUC-25"] = planDocument({ type: "decided", agentId: "previous", approved: true, planContent: RISKY(1).replace(MODEL("strong"), ""), at: "2026-01-01T08:00:00Z" }, "TUC-25");
  const decisions: boolean[] = [];
  const reviews = {
    opened: async () => "https://host.ts.net:8444/review/agent-1",
    decided: async () => {}, described: async () => {}, describedFor: async () => {},
    requiresOwner: async () => true,
  };
  await withEvents([
    { type: "advised", agentId: "agent-1", verdict: "agreed", hash: planHash(RISKY(1)), at: "2026-01-01T09:59:00Z" },
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, reviews, async (_url, approved) => { decisions.push(approved); }, () => {});
    bridge.attach(paseo);
    try { await bridge.drain(); await bridge.drain(); } finally { bridge.stop(); }
  });
  assert.equal(decisions.includes(true), false);
  assert.ok(calls.includes("state issue-1 Planning"));
  assert.ok(!calls.includes("+plan-ready issue-1"));
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(1), line: "Requires owner review", reasons: ["recheck"], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  await withEvents([{ type: "advised", agentId: "agent-1", verdict: "agreed", hash: planHash(RISKY(1)), at: "2026-01-01T10:10:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, reviews, async (_url, approved) => { decisions.push(approved); }, () => {}, parking);
    bridge.attach(paseo);
    try { await bridge.drain(); await bridge.drain(); } finally { bridge.stop(); }
  });
  assert.equal(plans.get("issue-1")?.identifier, "TUC-25");
  assert.deepEqual(decisions, []);
});
