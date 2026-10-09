import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { DEFAULT_WORKTREE_SHARDS, DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { openInBrowser, parseEvent, planDocument, PlannotatorBridge, plannotatorPaths, writeOpenScript, type Parking } from "./plannotator";
import { ReviewClosedError } from "./sessions";
import type { ParkedPlan } from "./parked";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { planHash } from "./review-outcome";
import { DecisionLog, type LogEntry } from "./owner-decisions";
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
  dispatch: DEFAULT_DISPATCH, writeback: { ...DEFAULT_WRITEBACK, status: true }, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};

// `ticket`: who wrote the ticket and its labels, for the risk policy's checks. `documents`: the
// ticket's documents by title (the approved plan).
function setup(labels: Record<string, string>, ticket: { creatorId: string; labels: string[] } = { creatorId: "owner", labels: [] }) {
  const calls: string[] = [];
  const documents: Record<string, string> = {};
  const comments = new Set<string>();
  const linear = {
    async comment(issueId: string, body: string, id?: string) { calls.push(`comment ${issueId}: ${body}`); if (id) comments.add(id); },
    async commentById(id: string) { return comments.has(id) ? { id } : null; },
    async issueById(_id: string) { return null; },
    async createIssue() { throw new Error("createIssue is not expected here"); },
    async addBlocker() {},
    async delegate() {},
    async upsertIssueDocument(issueId: string, title: string) { calls.push(`document ${issueId} ${title}`); return "https://linear.app/doc/1"; },
    async issueDocument(_issueId: string, title: string) { return title in documents ? { url: "https://linear.app/doc/1", content: documents[title] } : null; },
    async moveToStateNamed(issueId: string, name: string) { calls.push(`state ${issueId} ${name}`); return { changed: true }; },
    async moveToReady(issueId: string) { calls.push(`ready ${issueId}`); return { changed: true }; },
    async addLabel(issueId: string, name: string) { calls.push(`+${name} ${issueId}`); },
    async removeLabel(issueId: string, name: string) { calls.push(`-${name} ${issueId}`); },
    async issueState() { return { identifier: labels["linear.identifier"], creatorId: ticket.creatorId, labels: ticket.labels.map((name, index) => ({ id: `l${index}`, name })) } as never; },
    async viewerId() { return "owner"; },
    async appUserId() { return "paseo-app"; },
    async trustedAppIds() { return ["paseo-app"]; },
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
  await withEvents([{ type: "opened", agentId: "agent-2", localUrl: "http://localhost:4002/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory);
    bridge.attach(paseo);
    await bridge.drain();
    // The plugin closes the review itself (implement later): journaled before Plannotator is told.
    const journal = bridge.decisionJournal;
    await journal.addClosing(journal.latestReview("agent-2")!, false, "The owner approved this plan for later implementation");
    calls.length = 0;
    await writeFile(join(directory, `${Date.now()}-echo.json`), JSON.stringify({ type: "decided", agentId: "agent-2", approved: false, feedback: "The owner approved this plan for later implementation", at: new Date().toISOString() }));
    await bridge.drain();
    await bridge.stop();
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
    { type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(2), at: "2026-01-01T10:05:00Z" },
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

// The journal's one attempt of a test's bridge.
function onlyAttempt(bridge: PlannotatorBridge) {
  const attempts = bridge.decisionJournal.attempts();
  assert.equal(attempts.length, 1);
  return attempts[0];
}

test("a parked decision whose hand-off fails on a Linear error is delivered in full by the retry, not dropped", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  const upsert = linear.upsertIssueDocument;
  let outage = true;
  linear.upsertIssueDocument = async (issueId: string, title: string) => {
    if (outage) { outage = false; throw new Error("The Linear API request failed (HTTP 503). Try again."); }
    return upsert(issueId, title);
  };
  t.mock.method(console, "error", () => {});
  await withEvents([{ type: "decided", agentId: "agent-1", approved: false, parked: true, feedback: "Cover every table", at: "2026-01-01T12:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    await bridge.drain();
    assert.deepEqual(await readdir(directory), [], "the journal holds the decision once its event is read");
    assert.equal(onlyAttempt(bridge).state, "pending");
    assert.equal(plans.size, 1, "the parked plan stays until the decision went through");
    t.mock.timers.tick(3_000);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    await bridge.stop();
  });
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
    bridge.attach(paseo);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "pending", "not delivered while Linear pauses");
    // A retry before the pause ends sends nothing, however often the sweep runs.
    await bridge.drain();
    await bridge.drain();
    assert.deepEqual(calls.filter((call) => call.startsWith("document ") || call.startsWith("comment ")), []);
    limited = false;
    t.mock.timers.tick(60_000);
    await bridge.drain();
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    assert.deepEqual(calls.filter((call) => call.startsWith("document ")), ["document issue-1 Plan: TUC-25"]);
    assert.deepEqual(calls.filter((call) => call.startsWith("comment ")), ["comment issue-1: ✅ **Plan approved** in Plannotator — [plan](https://linear.app/doc/1)"]);
    await bridge.stop();
  });
});

test("parked rate-limited decisions wait until resumeAt without counting a failed try, however often Linear pauses", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-10-07T10:00:00Z", announced: true });
  const upsert = linear.upsertIssueDocument;
  let requests = 0;
  let limited = true;
  linear.upsertIssueDocument = async (issueId, title) => {
    requests++;
    if (limited) throw new RateLimitedError("app", Date.now() + 60_000);
    return upsert(issueId, title);
  };
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, parked: true, at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    for (let pause = 0; pause < 22; pause++) {
      await bridge.drain();
      assert.equal(requests, pause + 1);
      assert.equal(onlyAttempt(bridge).attempts, 0, "rate limits never count as a failed try");
      assert.equal(onlyAttempt(bridge).state, "pending");
      assert.equal(plans.size, 1);
      t.mock.timers.tick(59_999);
      await bridge.drain();
      assert.equal(requests, pause + 1, "not retried before resumeAt");
      t.mock.timers.tick(1);
    }
    limited = false;
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    assert.equal(plans.size, 0);
    assert.equal(calls.filter((call) => call.startsWith("document ")).length, 1);
    assert.equal(calls.filter((call) => call.startsWith("comment ")).length, 1);
    await bridge.stop();
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

test("a parked decision is never given up while Linear stays unavailable for over an hour, and is applied once afterwards", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  const upsert = linear.upsertIssueDocument;
  let down = true;
  let requests = 0;
  linear.upsertIssueDocument = async (issueId: string, title: string) => {
    requests++;
    if (down) throw new Error("Linear's hourly request limit is reached for the Paseo Linear app");
    return upsert(issueId, title);
  };
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, parked: true, planContent: RISKY(2), at: "2026-01-01T12:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    // Quick tries every 3 s for a minute, then once a minute: 20 + 75 tries over 76 minutes.
    for (let sweep = 0; sweep < 20; sweep++) { await bridge.drain(); t.mock.timers.tick(3_000); }
    assert.equal(requests, 20);
    await bridge.drain();
    assert.equal(requests, 21);
    await bridge.drain();
    assert.equal(requests, 21, "past the quick tries it waits a minute instead of retrying every sweep");
    for (let minute = 0; minute < 75; minute++) { t.mock.timers.tick(60_000); await bridge.drain(); }
    assert.equal(requests, 96);
    assert.equal(onlyAttempt(bridge).state, "pending");
    assert.match(onlyAttempt(bridge).lastError ?? "", /hourly request limit/);
    assert.equal(plans.size, 1);
    down = false;
    t.mock.timers.tick(60_000);
    await bridge.drain();
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    await bridge.stop();
  });
  assert.equal(plans.size, 0);
  assert.equal(calls.filter((call) => call.startsWith("document ")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("comment ")).length, 1);
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

// The Linear panel's session as the decision worker uses it, and a Linear fake that creates
// sub-issues under the id the worker reserved.
function panelFakes(calls: string[]) {
  const replies = new Set<string>();
  const sessions = {
    sessionFor: async () => null,
    holdSession: async (_sessionId: string, offer: string) => { calls.push(`hold ${offer}`); },
    groupSession: async () => { calls.push("group"); },
    clearReview: async () => { calls.push("clear review"); },
    say: async (_sessionId: string, _type: string, body: string, _ephemeral?: boolean, id?: string) => { calls.push(`reply ${body.split(" (")[0]}`); if (id) replies.add(id); },
    said: async (id: string) => replies.has(id),
  };
  const issues = new Map<string, { id: string; identifier: string; url: string }>();
  const subIssues = {
    issues,
    issueState: async () => ({ id: "issue-1", identifier: "TUC-25", teamId: "team-1", projectId: "project-1", labels: [] }) as never,
    createIssue: async (input: { id?: string; title: string }) => {
      const issue = { id: input.id!, identifier: `TUC-${100 + issues.size}`, url: "" };
      issues.set(issue.id, issue);
      calls.push(`create ${input.title}`);
      return issue;
    },
    issueById: async (id: string) => issues.get(id) ?? null,
    addBlocker: async (blocker: string, blocked: string) => { calls.push(`${issues.get(blocker)?.identifier} blocks ${issues.get(blocked)?.identifier}`); },
    delegate: async (id: string) => { calls.push(`delegate ${issues.get(id)?.identifier}`); },
  };
  return { sessions, subIssues };
}

const SPLIT_PLAN = "# Plan\n## Steps\n1. Add the domain\n2. Add the migration\n3. Wire the API\n";
const PANEL = { sessionId: "session-1", agentId: "agent-1", issueId: "issue-1", identifier: "TUC-25", createdAt: "", handled: [], offer: null, review: { localUrl: "http://localhost:5000/", openedAt: "2026-01-01T10:00:00Z" } };

test("approve, implement later: the session is held before the planner retires, the plan is recorded and the ticket goes back to Todo with plan-ready", async () => {
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { sessions } = panelFakes(calls);
  const { parking } = parkingFake(calls);
  await withEvents([], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, sessions as never, async () => "# Plan\n1. Step", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    assert.equal(await bridge.decidePanel(PANEL as never, "later"), null, "the workflow replied itself");
    assert.equal(onlyAttempt(bridge).state, "applied");
    await bridge.stop();
  });
  assert.deepEqual(calls, ["hold later", "document issue-1 Plan: TUC-25", "retire agent-1 null", "ready issue-1", "+plan-ready issue-1", "clear review", "reply Plan approved for later"]);
});

test("approve & split: a sub-issue Linear created whose answer was lost, then a plugin reload, still leaves every sub-issue created once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const { calls, linear, paseo } = setup({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { sessions, subIssues } = panelFakes(calls);
  const { parking } = parkingFake(calls);
  const create = subIssues.createIssue;
  let lost = true;
  // Linear creates the second sub-issue, but its answer never arrives.
  subIssues.createIssue = async (input) => {
    const issue = await create(input);
    if (input.title === "Add the migration" && lost) { lost = false; throw new Error("socket hang up"); }
    return issue;
  };
  Object.assign(linear, subIssues);
  await withEvents([], async (directory) => {
    const bridge = new PlannotatorBridge(linear, { read: async () => settings }, directory, sessions as never, async () => SPLIT_PLAN, undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(paseo);
    assert.match(await bridge.decidePanel(PANEL as never, "split") ?? "", /^Approved — being applied: socket hang up\. Retried every minute/);
    assert.equal(onlyAttempt(bridge).state, "pending");
    await bridge.stop();
    // A reload: the next instance carries the journaled decision on from its recorded steps.
    const reloaded = new PlannotatorBridge(linear, { read: async () => settings }, directory, sessions as never, async () => SPLIT_PLAN, undefined, undefined, undefined, async () => {}, () => {}, parking);
    reloaded.attach(paseo);
    t.mock.timers.tick(3_000);
    await reloaded.drain();
    assert.equal(onlyAttempt(reloaded).state, "applied");
    await reloaded.stop();
  });
  assert.equal(subIssues.issues.size, 3, "no step became a second sub-issue");
  assert.deepEqual(calls.filter((call) => call.startsWith("create ")), ["create Add the domain", "create Add the migration", "create Wire the API"]);
  assert.deepEqual(calls.filter((call) => call.includes(" blocks ")), ["TUC-100 blocks TUC-101", "TUC-101 blocks TUC-102"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("delegate ")), ["delegate TUC-100", "delegate TUC-101", "delegate TUC-102"]);
  assert.deepEqual(calls.filter((call) => ["hold split", "retire agent-1 null", "group", "clear review"].includes(call)), ["hold split", "retire agent-1 null", "group", "clear review"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("reply ")), ["reply Split into 3 sub-issues"]);
});

// ---------------------------------------------------------------------------------------------
// Decision journal acceptance (TUC-1288, plan Verification AC-1..AC-23). "Reload" here is a
// graceful `await bridge.stop()` and a new bridge (and journal) on the same directories, the way
// a plugin reload behaves.
// ---------------------------------------------------------------------------------------------

type FaultKind = "before" | "after" | "journal";

// A call that fails once the way a crash does: `before` throws without doing the work, `after`
// does the work and throws, so its answer never arrives.
function armedCall<T extends unknown[], R>(kind: "before" | "after", work: (...args: T) => Promise<R>): (...args: T) => Promise<R> {
  let armed = true;
  return async (...args: T) => {
    if (!armed) return work(...args);
    armed = false;
    if (kind === "after") await work(...args);
    throw new Error("Linear's hourly request limit is reached");
  };
}

// A bridge whose journal refuses the named step's first write, as a crash between the effect and
// its record would. Only the first bridge of a test gets it; the reloaded one is left alone.
function faultJournalWrite(bridge: PlannotatorBridge, step: string): void {
  const journal = bridge.decisionJournal;
  const write = journal.step.bind(journal);
  let fired = false;
  journal.step = async (attempt, name, value) => {
    if (!fired && name === step) { fired = true; throw new Error("the decision record could not be written"); }
    return write(attempt, name, value);
  };
}

// A Linear/Paseo fake that records what the worker really did, so a retry is checked for a second
// document, comment, label, ready move or requeue, not only for the final state.
function tracked(agentLabels: Record<string, string> = {}, ticket: { creatorId: string; labels: string[] } = { creatorId: "owner", labels: [] }) {
  const calls: string[] = [];
  const documents = new Map<string, { content: string; creates: number }>();
  const comments = new Map<string, string>();
  const commented: string[] = [];
  const labels = new Set<string>();
  const labelAdds = new Map<string, number>();
  const states: string[] = [];
  let ready = false;
  let readyTransitions = 0;
  const linear = {
    async comment(issueId: string, body: string, id?: string) { calls.push(`comment ${issueId}`); commented.push(body); if (id) comments.set(id, body); },
    async commentById(id: string) { return comments.has(id) ? { id } : null; },
    async issueById(_id: string) { return null; },
    async createIssue() { throw new Error("createIssue is not expected here"); },
    async addBlocker() {},
    async delegate() {},
    async upsertIssueDocument(issueId: string, title: string, content?: string) {
      const known = documents.get(title);
      documents.set(title, { content: content ?? "", creates: (known?.creates ?? 0) + (known ? 0 : 1) });
      calls.push(`document ${issueId} ${title}`);
      return "https://linear.app/doc/1";
    },
    async issueDocument(_issueId: string, title: string) {
      const document = documents.get(title);
      return document ? { url: "https://linear.app/doc/1", content: document.content } : null;
    },
    async moveToStateNamed(issueId: string, name: string) { states.push(name); calls.push(`state ${issueId} ${name}`); return { changed: true }; },
    async moveToReady(issueId: string) { if (!ready) { ready = true; readyTransitions++; } calls.push(`ready ${issueId}`); return { changed: true }; },
    async addLabel(issueId: string, name: string) { labelAdds.set(name, (labelAdds.get(name) ?? 0) + (labels.has(name) ? 0 : 1)); labels.add(name); calls.push(`+${name} ${issueId}`); },
    async removeLabel(issueId: string, name: string) { labels.delete(name); calls.push(`-${name} ${issueId}`); },
    async issueState() { return { identifier: agentLabels["linear.identifier"] ?? "TUC-25", creatorId: ticket.creatorId, labels: ticket.labels.map((name, index) => ({ id: `l${index}`, name })) } as never; },
    async viewerId() { return "owner"; },
    async appUserId() { return "paseo-app"; },
    async trustedAppIds() { return ["paseo-app"]; },
  };
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { labels: agentLabels } }),
        timeline: { append: async (item: { data: { title: string } }) => { calls.push(`row ${id}: ${item.data.title}`); } },
      }),
    },
  } as unknown as PaseoApi;
  return { calls, documents, comments, commented, labels, labelAdds, states, linear, paseo, readied: () => readyTransitions };
}

// The Linear panel session behind a parked plan's decision, with the real requeue rule: the patch
// happens only while the session still names the retired agent.
function parkedSessions() {
  const activities = new Map<string, string>();
  const state: { agentId: string | null; closed: boolean } = { agentId: "agent-1", closed: false };
  let queued = 0;
  const sessions = {
    sessionFor: async (agentId: string) => agentId === "agent-1" ? { sessionId: "session-1", agentId } as never : null,
    requeueSession: async (_sessionId: string, agentId: string) => {
      if (state.closed || state.agentId !== agentId) return "moved-on" as const;
      state.agentId = null;
      queued++;
      return "queued" as const;
    },
    say: async (_sessionId: string, _type: string, body: string, _ephemeral?: boolean, id?: string) => { if (id) activities.set(id, body); },
    said: async (id: string) => activities.has(id),
    plan: async () => {}, ask: async () => {}, expectReview: async () => {}, clearReview: async () => {}, parked: async () => {}, holdSession: async () => {}, groupSession: async () => {},
  };
  return { sessions, activities, queued: () => queued };
}

// AC-1: every mandatory parked step, failed once before it ran, after it ran and in its journal
// write, with a reload between the failure and the retry.
test("every mandatory parked step survives a one-off fault, a reload and a retry, with every effect exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const steps = ["document", "follow-ups", "plan-ready", "ready", "comment", "queue", "notify", "unpark", "inbox"];
  for (const step of steps) {
    for (const kind of ["before", "after", "journal"] as FaultKind[]) {
      const label = `${step} fails ${kind === "journal" ? "its journal write" : kind === "after" ? "after it ran" : "before it runs"}`;
      await withEvents([{ type: "decided", agentId: "agent-1", approved: true, parked: true, planContent: RISKY(2), at: new Date().toISOString() }], async (directory) => {
        const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
        const { plans, parking } = parkingFake(f.calls);
        plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T11:00:00.000Z", announced: true });
        const panel = step === "queue" || step === "notify" ? parkedSessions() : null;
        const filed: string[] = [];
        const followUps = { file: async (origin: { issueId: string }) => { if (!filed.includes(origin.issueId)) filed.push(origin.issueId); }, retryPending: async () => {} };
        const inbox: string[] = [];
        const reviews = {
          opened: async () => null,
          decided: async (agentId: string, approved: boolean) => { const row = `${agentId} ${approved}`; if (!inbox.includes(row)) inbox.push(row); },
          described: async () => {},
          describedFor: async () => {},
        };
        const crash = kind === "journal" ? null : kind;
        if (crash) {
          if (step === "document") f.linear.upsertIssueDocument = armedCall(crash, f.linear.upsertIssueDocument);
          if (step === "follow-ups") followUps.file = armedCall(crash, followUps.file);
          if (step === "plan-ready") f.linear.addLabel = armedCall(crash, f.linear.addLabel);
          if (step === "ready") f.linear.moveToReady = armedCall(crash, f.linear.moveToReady);
          if (step === "comment") f.linear.comment = armedCall(crash, f.linear.comment);
          if (step === "queue") panel!.sessions.requeueSession = armedCall(crash, panel!.sessions.requeueSession);
          if (step === "notify") panel!.sessions.say = armedCall(crash, panel!.sessions.say);
          if (step === "unpark") parking.plans.remove = armedCall(crash, parking.plans.remove);
          if (step === "inbox") reviews.decided = armedCall(crash, reviews.decided);
        }
        let journalFaultArmed = kind === "journal";
        const build = () => {
          const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, (panel?.sessions ?? undefined) as never, async () => "", undefined, undefined, reviews, async () => {}, () => {}, parking);
          bridge.useFollowUps(followUps);
          if (journalFaultArmed) { journalFaultArmed = false; faultJournalWrite(bridge, step); }
          return bridge;
        };
        const first = build();
        first.attach(f.paseo);
        await first.drain();
        assert.equal(onlyAttempt(first).state, "pending", label);
        assert.equal(onlyAttempt(first).appliedAt, undefined, label);
        await first.stop();
        const second = build();
        second.attach(f.paseo);
        t.mock.timers.tick(3_000);
        await second.drain();
        await second.drain();
        const attempt = onlyAttempt(second);
        assert.equal(attempt.state, "applied", label);
        assert.ok(attempt.appliedAt, label);
        assert.equal(plans.size, 0, label);
        assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1, label);
        assert.equal(filed.length, 1, label);
        assert.equal(f.labelAdds.get("plan-ready") ?? 0, 1, label);
        assert.equal(f.readied(), 1, label);
        assert.equal(inbox.length, 1, label);
        if (panel) {
          assert.equal(panel.queued(), 1, label);
          assert.equal(panel.activities.size, 1, label);
          assert.equal(f.comments.size, 0, label);
        } else {
          assert.equal(f.comments.size, 1, label);
        }
        await second.stop();
      });
    }
  }
});

// AC-1: Linear stays down for 61 fake minutes, the plugin is reloaded in the middle, and the
// parked decision is still carried out once afterwards.
test("a parked decision rides out a 61-minute Linear outage with a reload in the middle and is applied once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, parked: true, planContent: RISKY(2), at: new Date().toISOString() }], async (directory) => {
    const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
    const { plans, parking } = parkingFake(f.calls);
    plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T11:00:00.000Z", announced: true });
    const filed: string[] = [];
    const followUps = { file: async (origin: { issueId: string }) => { if (!filed.includes(origin.issueId)) filed.push(origin.issueId); }, retryPending: async () => {} };
    let down = true;
    let requests = 0;
    const upsert = f.linear.upsertIssueDocument;
    f.linear.upsertIssueDocument = async (issueId, title, content) => {
      requests++;
      if (down) throw new Error("Linear's hourly request limit is reached for the Paseo Linear app");
      return upsert(issueId, title, content);
    };
    const build = () => {
      const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
      bridge.useFollowUps(followUps);
      return bridge;
    };
    const first = build();
    first.attach(f.paseo);
    // The quick tries of the first minute.
    for (let sweep = 0; sweep < 20; sweep++) { await first.drain(); t.mock.timers.tick(3_000); }
    assert.equal(onlyAttempt(first).state, "pending");
    assert.equal(plans.size, 1, "the plan stays parked while the decision cannot be carried out");
    // Half an hour more, still down; then a reload.
    for (let minute = 0; minute < 30; minute++) { t.mock.timers.tick(60_000); await first.drain(); }
    assert.equal(onlyAttempt(first).state, "pending");
    await first.stop();
    const second = build();
    second.attach(f.paseo);
    for (let minute = 0; minute < 31; minute++) { t.mock.timers.tick(60_000); await second.drain(); }
    assert.equal(onlyAttempt(second).state, "pending", "over an hour of failures is never a give-up");
    assert.ok(requests >= 60, `kept trying (${requests} requests)`);
    assert.equal(f.documents.size, 0, "nothing was written while Linear stayed down");
    down = false;
    t.mock.timers.tick(60_000);
    await second.drain();
    await second.drain();
    assert.equal(onlyAttempt(second).state, "applied");
    assert.equal(plans.size, 0);
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(f.comments.size, 1);
    assert.equal(filed.length, 1);
    await second.stop();
  });
});

// AC-1: the crash window after unpark; the route comes from the recorded snapshot, not a new
// discovery, so the retry finishes the parked workflow even though the parked record is gone.
test("a decision that crashed after unpark resumes on its recorded parked route after a reload", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, parked: true, planContent: RISKY(2), at: new Date().toISOString() }], async (directory) => {
    const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
    const { plans, parking } = parkingFake(f.calls);
    plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T11:00:00.000Z", announced: true });
    const inbox: string[] = [];
    let inboxDown = true;
    const reviews = {
      opened: async () => null,
      decided: async (agentId: string, approved: boolean) => { if (inboxDown) throw new Error("the review inbox is unreachable"); inbox.push(`${agentId} ${approved}`); },
      described: async () => {},
      describedFor: async () => {},
    };
    const build = () => new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, reviews, async () => {}, () => {}, parking);
    const first = build();
    first.attach(f.paseo);
    await first.drain();
    assert.equal(onlyAttempt(first).state, "pending");
    assert.equal("unpark" in onlyAttempt(first).steps, true, "unpark went through before the crash");
    assert.equal(plans.size, 0);
    assert.equal(f.comments.size, 1, "the decision itself went through");
    await first.stop();
    inboxDown = false;
    const second = build();
    second.attach(f.paseo);
    t.mock.timers.tick(3_000);
    await second.drain();
    const attempt = onlyAttempt(second);
    assert.equal(attempt.state, "applied");
    assert.equal(attempt.route, "parked", "the retry resumed on the recorded route");
    assert.equal(f.readied(), 1);
    assert.equal(f.states.length, 0, "it never fell back to the live route's state write");
    assert.equal(f.comments.size, 1);
    assert.deepEqual(inbox, ["agent-1 true"]);
    await second.stop();
  });
});

// AC-2: every mandatory live step, the same three failures, with a reload between the failure and
// the retry.
test("every mandatory live step survives a one-off fault, a reload and a retry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const steps = ["state", "label", "document", "follow-ups", "comment"];
  for (const step of steps) {
    for (const kind of ["before", "after", "journal"] as FaultKind[]) {
      const label = `${step} fails ${kind === "journal" ? "its journal write" : kind === "after" ? "after it ran" : "before it runs"}`;
      await withEvents([{ type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: new Date().toISOString() }], async (directory) => {
        const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
        const filed: string[] = [];
        const followUps = { file: async (origin: { issueId: string }) => { if (!filed.includes(origin.issueId)) filed.push(origin.issueId); }, retryPending: async () => {} };
        const inbox: string[] = [];
        const reviews = {
          opened: async () => null,
          decided: async (agentId: string, approved: boolean) => { const row = `${agentId} ${approved}`; if (!inbox.includes(row)) inbox.push(row); },
          described: async () => {},
          describedFor: async () => {},
        };
        const crash = kind === "journal" ? null : kind;
        if (crash) {
          if (step === "state") f.linear.moveToStateNamed = armedCall(crash, f.linear.moveToStateNamed);
          if (step === "label") f.linear.addLabel = armedCall(crash, f.linear.addLabel);
          if (step === "document") f.linear.upsertIssueDocument = armedCall(crash, f.linear.upsertIssueDocument);
          if (step === "follow-ups") followUps.file = armedCall(crash, followUps.file);
          if (step === "comment") f.linear.comment = armedCall(crash, f.linear.comment);
        }
        let journalFaultArmed = kind === "journal";
        const build = () => {
          const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, reviews, async () => {}, () => {});
          bridge.useFollowUps(followUps);
          if (journalFaultArmed) { journalFaultArmed = false; faultJournalWrite(bridge, step); }
          return bridge;
        };
        const first = build();
        first.attach(f.paseo);
        await first.drain();
        assert.equal(onlyAttempt(first).state, "pending", label);
        assert.equal(onlyAttempt(first).appliedAt, undefined, label);
        await first.stop();
        const second = build();
        second.attach(f.paseo);
        t.mock.timers.tick(3_000);
        await second.drain();
        await second.drain();
        const attempt = onlyAttempt(second);
        assert.equal(attempt.state, "applied", label);
        assert.equal(f.states.at(-1), "In Progress", label);
        assert.equal(f.labelAdds.get("plan-ready") ?? 0, 1, label);
        assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1, label);
        assert.equal(filed.length, 1, label);
        assert.equal(f.comments.size, 1, label);
        assert.equal(inbox.length, 1, label);
        await second.stop();
      });
    }
  }
});

// AC-2: an optional step (the agent's chat row) is best effort: it is recorded as skipped and the
// approval still goes through.
test("an optional step failing does not block the approval", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: new Date().toISOString() }], async (directory) => {
    const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
    const filed: string[] = [];
    const followUps = { file: async (origin: { issueId: string }) => { if (!filed.includes(origin.issueId)) filed.push(origin.issueId); }, retryPending: async () => {} };
    const paseo = {
      agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "issue-1", "linear.identifier": "TUC-25" } } }), timeline: { append: async () => { throw new Error(`no chat row for ${id}`); } } }) },
    } as unknown as PaseoApi;
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {});
    bridge.useFollowUps(followUps);
    bridge.attach(paseo);
    await bridge.drain();
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "applied");
    assert.ok("chat" in attempt.steps, "the failed optional step is recorded");
    assert.equal(f.states.at(-1), "In Progress");
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(f.comments.size, 1);
    await bridge.stop();
  });
});

// AC-3: the delivery got through the document step and failed before completion; the reload must
// finish it exactly once and must not have marked it applied early.
test("a delivery that got through the document step is finished exactly once after a reload, never marked applied early", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: new Date().toISOString() }], async (directory) => {
    const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
    const filed: string[] = [];
    let followUpFailed = false;
    const followUps = {
      file: async (origin: { issueId: string }) => {
        if (!followUpFailed) { followUpFailed = true; throw new Error("the follow-up write failed"); }
        if (!filed.includes(origin.issueId)) filed.push(origin.issueId);
      },
      retryPending: async () => {},
    };
    const build = () => {
      const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {});
      bridge.useFollowUps(followUps);
      return bridge;
    };
    const first = build();
    first.attach(f.paseo);
    await first.drain();
    const attempt = onlyAttempt(first);
    assert.equal(attempt.state, "pending");
    assert.equal(attempt.appliedAt, undefined, "not applied before the last mandatory step");
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1, "the document step went through");
    assert.equal("follow-ups" in attempt.steps, false);
    assert.equal(f.comments.size, 0);
    await first.stop();
    const second = build();
    second.attach(f.paseo);
    t.mock.timers.tick(3_000);
    await second.drain();
    await second.drain();
    assert.equal(onlyAttempt(second).state, "applied");
    assert.equal(f.calls.filter((call) => call.startsWith("document ")).length, 1, "the document step was not repeated");
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(filed.length, 1);
    assert.equal(f.comments.size, 1);
    await second.stop();
  });
});

// AC-7: a page report is on disk before the event file goes, a replayed file adds nothing, a
// replayed opened event creates no second review, and a failing journal write keeps the file.
test("a page report is journaled before its event file can go, and replays add only to its report list", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const opened = { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" };
  const report = { type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: "2026-01-01T10:05:00Z" };
  await withEvents([], async (directory) => {
    await writeFile(join(directory, "0.json"), JSON.stringify(opened));
    await writeFile(join(directory, "1.json"), JSON.stringify(report));
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, async () => {}, () => {});
    const journal = bridge.decisionJournal;
    const realReport = journal.report.bind(journal);
    let mode: "after" | "before" | null = "after";
    journal.report = async (input) => {
      if (mode === "before") { mode = null; throw new Error("the decision record could not be written"); }
      const outcome = await realReport(input);
      if (mode === "after") { mode = null; throw new Error("the plugin stopped before the event file was removed"); }
      return outcome;
    };
    bridge.attach(f.paseo);
    await bridge.drain();
    assert.deepEqual(await readdir(directory), ["1.json"], "the report's file stays until the journal has it");
    let attempt = onlyAttempt(bridge);
    assert.equal(attempt.source, "plannotator-page");
    assert.equal(attempt.approved, true);
    assert.equal(attempt.feedback, undefined, "an approval without feedback records none");
    assert.deepEqual(attempt.reports, ["1.json"]);
    assert.equal(attempt.state, "applied", "the decision is carried out while its event file waits");
    // The same file again: nothing new.
    await bridge.drain();
    assert.deepEqual(await readdir(directory), []);
    assert.equal(journal.attempts().length, 1);
    assert.equal(f.comments.size, 1);
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    // A failing journal write keeps the event file for the next sweep.
    await writeFile(join(directory, "3.json"), JSON.stringify(report));
    mode = "before";
    await bridge.drain();
    assert.deepEqual(await readdir(directory), ["3.json"]);
    assert.equal(journal.attempts().length, 1);
    await bridge.drain();
    assert.deepEqual(await readdir(directory), []);
    attempt = onlyAttempt(bridge);
    assert.deepEqual(attempt.reports, ["1.json", "3.json"], "the replay only added its report");
    assert.equal(attempt.state, "applied");
    assert.equal(f.comments.size, 1, "one decision, one comment");
    // A replayed opened event creates no second review, and no second decision.
    await writeFile(join(directory, "2.json"), JSON.stringify(opened));
    await bridge.drain();
    assert.equal(journal.all().filter((entry) => entry.kind === "review").length, 1);
    assert.equal(journal.attempts().length, 1);
    await bridge.stop();
  });
});

// AC-7: further reports of the same decision, and a replay after it was applied, are only reports.
test("further reports of one applied decision add only to its report list", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const report = { type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: "2026-01-01T10:05:00Z" };
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" },
    report, report, report, report,
  ], async (directory) => {
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, async () => {}, () => {});
    bridge.attach(f.paseo);
    await bridge.drain();
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "applied");
    assert.deepEqual(attempt.reports, ["1.json", "2.json", "3.json", "4.json"]);
    assert.equal(f.comments.size, 1);
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    // A replay of an already-processed file after it was applied is still nothing new.
    await writeFile(join(directory, "1.json"), JSON.stringify(report));
    await bridge.drain();
    assert.equal(bridge.decisionJournal.attempts().length, 1);
    assert.equal(onlyAttempt(bridge).reports.length, 4);
    await bridge.stop();
  });
});

// AC-7: two successive reviews with identical plan text on a reused address each get their own
// decision, bound by the write order of the event files (A's report is written before B opens,
// even when both files are processed in the same pass).
test("two successive reviews on a reused address each get their own decision bound by event write order", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const url = "http://localhost:4000/?plan=1";
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: url, remoteUrl: null, at: "2026-01-01T10:00:00Z" },
    { type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: "2026-01-01T10:05:00Z" },
    { type: "opened", agentId: "agent-1", localUrl: url, remoteUrl: null, at: "2026-01-01T11:00:00Z" },
    { type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: "2026-01-01T11:05:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, async () => {}, () => {});
    bridge.attach(f.paseo);
    await bridge.drain();
    await bridge.drain();
    const journal = bridge.decisionJournal;
    const reviews = journal.all().filter((entry) => entry.kind === "review");
    assert.equal(reviews.length, 2, "two generations on the reused address");
    assert.equal(new Set(reviews.map((entry) => entry.localUrl)).size, 1);
    assert.notEqual(reviews[0].openedAt, reviews[1].openedAt);
    const attempts = journal.attempts();
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map((entry) => entry.reviewId)).size, 2, "each report bound to its own generation");
    assert.deepEqual(attempts.map((entry) => entry.state), ["applied", "applied"]);
    assert.equal(f.comments.size, 2, "one comment per decision");
    await bridge.stop();
  });
});

// AC-7/AC-23: a report whose plan text is not the text of the generation it would bind to is
// unbound: kept for the owner, applied by nobody until they carry it out.
test("a report whose plan text is not its generation's is unbound, not applied until the owner carries it out", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const reported = RISKY(3).replace("Add the column to the report.", "Add the export to the report.");
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" },
    { type: "decided", agentId: "agent-1", approved: true, planContent: reported, at: "2026-01-01T10:05:00Z" },
  ], async (directory) => {
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, async () => {}, () => {});
    bridge.attach(f.paseo);
    await bridge.drain();
    const journal = bridge.decisionJournal;
    const [unbound] = journal.all().filter((entry) => entry.kind === "unbound");
    assert.ok(unbound, "the report waits for the owner");
    assert.equal(unbound.state, "open");
    assert.equal(journal.attempts().length, 0, "nothing was applied");
    assert.ok(journal.applying().some((row) => row.kind === "unbound"), "listed under Being applied");
    assert.equal(f.documents.size, 0);
    await bridge.resolve(unbound.id, "carry-out");
    await bridge.drain();
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "applied");
    assert.equal(attempt.planContent, reported, "carried out with the reported text");
    assert.match(f.documents.get("Plan: TUC-25")?.content ?? "", /Add the export to the report\./);
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    await bridge.stop();
  });
});

// AC-12: the risk policy's approval is journaled before Plannotator is asked; a refusal voids it
// and the plan goes to the owner like any other.
test("the risk policy journals its approval before calling Plannotator, and a refusal voids it and sends the plan to the owner", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const seen: Array<{ count: number; state: string | undefined; source: string | undefined }> = [];
  const tabs: string[] = [];
  let bridge!: PlannotatorBridge;
  const decide = async (_url: string, _approve: boolean, _feedback: string) => {
    const attempts = bridge.decisionJournal.attempts();
    seen.push({ count: attempts.length, state: attempts[0]?.state, source: attempts[0]?.source });
    throw new ReviewClosedError("Plannotator answered HTTP 409; the review is already closed.");
  };
  await withEvents([
    { type: "advised", agentId: "agent-1", verdict: "agreed", hash: planHash(RISKY(1)), at: "2026-01-01T09:59:00Z" },
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" },
  ], async (directory) => {
    bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, decide, (url) => tabs.push(url));
    bridge.attach(f.paseo);
    await bridge.drain();
    await bridge.drain();
    await bridge.stop();
  });
  assert.deepEqual(seen, [{ count: 1, state: "deciding", source: "risk-policy" }], "journaled before the call");
  const [attempt] = bridge.decisionJournal.attempts();
  assert.ok(attempt);
  assert.equal(attempt.state, "void");
  assert.match(attempt.voidReason ?? "", /409/);
  assert.deepEqual(tabs, ["http://localhost:4000/"], "the owner gets the plan");
  assert.ok(f.commented.some((body) => body.startsWith("📋")), "the owner is told why");
  assert.equal(f.documents.size, 0, "nothing of the refused approval was applied");
  assert.ok(!f.states.includes("In Progress"));
});

// AC-12: a parked plan judged again records its approval before the resumed planner is retired,
// and the approval is applied once.
test("a re-judged parked plan is journaled before its planner retires and is applied once", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(f.calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(1), line: "", reasons: [], model: null, parkedAt: "2026-01-01T11:00:00Z", announced: true });
  const retires: Array<{ count: number; state: string | undefined }> = [];
  let bridge!: PlannotatorBridge;
  parking.retire = async (_localUrl, agentId) => {
    const attempts = bridge.decisionJournal.attempts();
    retires.push({ count: attempts.length, state: attempts[0]?.state });
    f.calls.push(`retire ${agentId}`);
  };
  await withEvents([{ type: "advised", agentId: "agent-1", verdict: "agreed", hash: planHash(RISKY(1)), at: "2026-01-01T12:00:00Z" }], async (directory) => {
    bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(f.paseo);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    await bridge.stop();
  });
  assert.deepEqual(retires, [{ count: 1, state: "pending" }], "journaled before the planner was retired");
  assert.equal(plans.size, 0);
  assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
  assert.equal(f.comments.size, 1);
});

// AC-13/AC-21 (7): a recovered outcome carries the stored review's identity: it binds to that
// generation even after a newer one opened (which stays undecided), and recovering the same
// outcome twice journals one decision.
test("a recovered outcome binds to the stored review even after a newer review opened, and is journaled once", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  let bridge!: PlannotatorBridge;
  await withEvents([], async (directory) => {
    await writeFile(join(directory, "0.json"), JSON.stringify({ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4100/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }));
    bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, async () => {}, () => {});
    bridge.attach(f.paseo);
    await bridge.drain();
    const [first] = bridge.decisionJournal.all().filter((entry) => entry.kind === "review");
    assert.ok(first);
    // A newer review opens; the stored outcome is still the older one's.
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4101/", remoteUrl: null, at: "2026-01-01T11:00:00Z" }));
    await bridge.drain();
    assert.equal(bridge.decisionJournal.all().filter((entry) => entry.kind === "review").length, 2);
    const stored = { localUrl: first.localUrl, openedAt: first.openedAt, reviewId: first.id, planHash: planHash(RISKY(1)) };
    await bridge.recovered("agent-1", stored, { approved: true, planContent: RISKY(1) });
    await bridge.drain();
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.reviewId, first.id, "bound to the review the outcome was recovered from");
    assert.equal(attempt.source, "recovered");
    assert.equal(attempt.state, "applied");
    assert.equal(bridge.decisionJournal.attempts().filter((entry) => entry.reviewId !== first.id).length, 0, "the newer review stays undecided");
    assert.equal([...f.comments.values()].filter((body) => body.startsWith("✅")).length, 1);
    // The same outcome recovered again: a replay, no second decision and no second effect.
    await bridge.recovered("agent-1", stored, { approved: true, planContent: RISKY(1) });
    await bridge.drain();
    assert.equal(bridge.decisionJournal.attempts().length, 1);
    assert.equal([...f.comments.values()].filter((body) => body.startsWith("✅")).length, 1);
    await bridge.stop();
  });
});

// AC-14: parking records a closing on the agent's own review; the retired agent's late echo of that
// send-back is a confirmation, while the owner's decision on the host's review is the real one.
test("parking records a closing; the retired agent's echo after a reload confirms it while the owner's host decision is applied", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(f.calls);
  let bridge!: PlannotatorBridge;
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: "https://host.ts.net:4000/", at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const build = () => new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge = build();
    bridge.attach(f.paseo);
    await bridge.drain();
    const [closing] = bridge.decisionJournal.all().filter((entry) => entry.kind === "closing");
    assert.ok(closing, "the park records a closing");
    assert.equal(closing.transport, false);
    assert.equal(bridge.decisionJournal.attempts().length, 0);
    assert.equal(plans.size, 1);
    await bridge.stop();
    // The host serves the plan and the owner approves it there.
    const reloaded = build();
    reloaded.attach(f.paseo);
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "opened", agentId: "agent-1", localUrl: "http://localhost:5000/", remoteUrl: "https://host.ts.net:5000/", at: "2026-01-01T10:10:00Z" }));
    await reloaded.drain();
    await writeFile(join(directory, "2.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: true, parked: true, planContent: RISKY(2), at: "2026-01-01T11:00:00Z" }));
    await reloaded.drain();
    assert.equal(onlyAttempt(reloaded).state, "applied");
    assert.equal(plans.size, 0);
    // The echo of the plugin's own send-back arrives late: a confirmation, not a decision.
    await writeFile(join(directory, "3.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: false, feedback: "The owner has to decide this plan.", at: "2026-01-01T11:05:00Z" }));
    await reloaded.drain();
    assert.equal(reloaded.decisionJournal.attempts().length, 1, "the echo added no decision");
    const [confirmed] = reloaded.decisionJournal.all().filter((entry) => entry.kind === "closing");
    assert.ok(confirmed);
    assert.deepEqual(confirmed.reports, ["3.json"]);
    await reloaded.stop();
  });
  assert.equal(f.labelAdds.get("plan-ready") ?? 0, 1);
  assert.equal(f.readied(), 1);
});

// AC-14: a plan sent back before review for its model tier records a closing; the extension's echo
// of it after a reload is a confirmation and nothing of a ticket review is written.
test("the pre-review tier send-back records a closing and the agent's echo after a reload confirms it", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const decisions: string[] = [];
  const plan = "# Plan\n\n1. Add the column to the report.\n";
  let bridge!: PlannotatorBridge;
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const build = () => new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => plan, undefined, undefined, undefined, async (_url, approve, feedback) => { decisions.push(`${approve} ${feedback.split("\n")[0]}`); }, () => {});
    bridge = build();
    bridge.attach(f.paseo);
    await bridge.drain();
    const [closing] = bridge.decisionJournal.all().filter((entry) => entry.kind === "closing");
    assert.ok(closing);
    assert.equal(closing.transport, false);
    assert.equal(bridge.decisionJournal.attempts().length, 0);
    assert.equal(decisions.length, 1);
    await bridge.stop();
    const reloaded = build();
    reloaded.attach(f.paseo);
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: false, feedback: "Paseo sent this plan back before review.", at: "2026-01-01T10:05:00Z" }));
    await reloaded.drain();
    assert.equal(reloaded.decisionJournal.attempts().length, 0, "the echo is not a decision");
    const [confirmed] = reloaded.decisionJournal.all().filter((entry) => entry.kind === "closing");
    assert.ok(confirmed);
    assert.deepEqual(confirmed.reports, ["1.json"]);
    assert.equal(f.calls.filter((call) => call.startsWith("document ")).length, 0);
    assert.equal(f.comments.size, 0);
    await reloaded.stop();
  });
});

// AC-14: a work order's automatic approval records a closing; the extension's report after a
// reload confirms it and the order is written once.
test("a work order's automatic approval records a closing and its report after a reload confirms it", async () => {
  const f = tracked({ "linear.plannerRun": "run-1" });
  const order = "# Work order\n\n```project-order\nTUC-12 blocks TUC-15\n```";
  let written = 0;
  let bridge!: PlannotatorBridge;
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const build = () => {
      const plan = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => order, undefined, undefined, undefined, async () => {}, () => {});
      plan.onProjectPlan({ isPlannerRun: async () => true, applyPlan: async () => { written++; return true; } });
      return plan;
    };
    bridge = build();
    bridge.attach(f.paseo);
    await bridge.drain();
    const [closing] = bridge.decisionJournal.all().filter((entry) => entry.kind === "closing");
    assert.ok(closing);
    assert.equal(closing.transport, true);
    assert.equal(bridge.decisionJournal.attempts().length, 0);
    assert.equal(written, 1);
    await bridge.stop();
    const reloaded = build();
    reloaded.attach(f.paseo);
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: true, planContent: order, at: "2026-01-01T10:05:00Z" }));
    await reloaded.drain();
    assert.equal(reloaded.decisionJournal.attempts().length, 0);
    const [confirmed] = reloaded.decisionJournal.all().filter((entry) => entry.kind === "closing");
    assert.ok(confirmed);
    assert.deepEqual(confirmed.reports, ["1.json"]);
    assert.equal(written, 1, "the work order was not written again");
    await reloaded.stop();
  });
});

// AC-15: an owner-approved work order is written by the project flow exactly once, also after the
// first attempt failed.
test("an owner-approved work order is written once, also after a first attempt failed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const f = tracked({ "linear.plannerRun": "run-1" });
  const order = "# Work order\n\n```project-order\nTUC-12 blocks TUC-15\n```";
  let attempts = 0;
  let written = 0;
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, planContent: order, at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {});
    bridge.onProjectPlan({
      isPlannerRun: async () => true,
      applyPlan: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Linear is down");
        written++;
        return true;
      },
    });
    bridge.attach(f.paseo);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "pending");
    assert.equal(onlyAttempt(bridge).route, "work-order");
    assert.equal(written, 0);
    t.mock.timers.tick(3_000);
    await bridge.drain();
    await bridge.drain();
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "applied");
    assert.equal(attempts, 2);
    assert.equal(written, 1);
    assert.equal(attempt.steps["work-order"], true);
    assert.equal(f.documents.size, 0, "nothing of a ticket approval applies to a work order");
    assert.equal(f.comments.size, 0);
    assert.equal(f.states.length, 0);
    await bridge.stop();
  });
});

// AC-17: one decision-log entry per decision, however often the carrying out is retried; an
// approval without feedback is not a decision candidate but is in the journal.
test("feedback is logged once per decision across retries, and an approval without feedback is only in the journal", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const entries: LogEntry[] = [];
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const upsert = f.linear.upsertIssueDocument;
  let failed = false;
  f.linear.upsertIssueDocument = async (issueId, title, content) => {
    if (!failed) { failed = true; throw new Error("Linear is down"); }
    return upsert(issueId, title, content);
  };
  await withEvents([{ type: "decided", agentId: "agent-1", approved: false, feedback: "Use option B", at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {});
    bridge.recordDecisions({ append: async (entry) => { entries.push(entry); } });
    bridge.attach(f.paseo);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "pending", "the failed try retries");
    t.mock.timers.tick(3_000);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    await bridge.stop();
  });
  assert.equal(entries.length, 1, "one entry for the retried decision");
  const [logged] = entries;
  assert.ok(logged);
  assert.equal(logged.kind, "plan-feedback");
  if (logged.kind === "plan-feedback") assert.equal(logged.text, "Use option B");
  // An approval without feedback is journaled, not logged.
  const approvals: LogEntry[] = [];
  const g = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, at: new Date().toISOString() }], async (directory) => {
    const bridge = new PlannotatorBridge(g.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {});
    bridge.recordDecisions({ append: async (entry) => { approvals.push(entry); } });
    bridge.attach(g.paseo);
    await bridge.drain();
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "applied");
    assert.equal(attempt.approved, true);
    assert.equal(attempt.feedback, undefined);
    await bridge.stop();
  });
  assert.deepEqual(approvals, [], "an approval without feedback is not a decision candidate");
});

// AC-18: decided event files already on disk when the plugin first sweeps are journaled and
// applied once, parked and live, even though no review was journaled for them.
test("decided events present before the first sweep, parked and live, are journaled and applied once", async () => {
  const live = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: "2026-01-01T10:05:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(live.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {});
    bridge.attach(live.paseo);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    assert.equal(live.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(live.comments.size, 1);
    await bridge.stop();
  });
  const parked = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { plans, parking } = parkingFake(parked.calls);
  plans.set("issue-1", { issueId: "issue-1", identifier: "TUC-25", agentId: "agent-1", plan: RISKY(2), line: "", reasons: [], model: null, parkedAt: "2026-01-01T10:00:00Z", announced: true });
  await withEvents([{ type: "decided", agentId: "agent-1", approved: false, parked: true, feedback: "Narrow it", at: "2026-01-01T12:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(parked.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {}, parking);
    bridge.attach(parked.paseo);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    assert.equal(plans.size, 0);
    assert.equal(parked.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(parked.comments.size, 1);
    await bridge.stop();
  });
});

// AC-19: a pending deletion pauses the carrying out without counting a try; a completed deletion
// voids the decision and nothing is written.
test("a pending deletion pauses a decision without counting a try, and a completed deletion voids it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const issueId = "3b241101-e2bb-4255-8caf-4136c566a962";
  const f = tracked({ "linear.issueId": issueId, "linear.identifier": "TUC-630" });
  await withEvents([{ type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(1), at: new Date().toISOString() }], async (directory) => {
    const deletions = new ReviewDeletions(join(directory, "..", "deletions.json"));
    let down = true;
    const upsert = f.linear.upsertIssueDocument;
    f.linear.upsertIssueDocument = async (id, title, content) => {
      if (down) { down = false; throw new Error("Linear is down"); }
      return upsert(id, title, content);
    };
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => "", undefined, undefined, undefined, async () => {}, () => {});
    bridge.useDeletions(deletions);
    bridge.attach(f.paseo);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "pending");
    assert.equal(onlyAttempt(bridge).attempts, 1, "the Linear failure counted");
    await deletions.put({ issueId, identifier: "TUC-630", agentId: "agent-1", phase: "pending" });
    t.mock.timers.tick(3_000);
    await bridge.drain();
    const paused = onlyAttempt(bridge);
    assert.equal(paused.state, "pending");
    assert.equal(paused.attempts, 1, "waiting for the deletion does not count a try");
    assert.equal(f.documents.size, 0);
    await deletions.put({ issueId, identifier: "TUC-630", agentId: "agent-1", phase: "deleted" });
    t.mock.timers.tick(3_000);
    await bridge.drain();
    const voided = onlyAttempt(bridge);
    assert.equal(voided.state, "void");
    assert.match(voided.voidReason ?? "", /deleted/);
    assert.equal(f.comments.size, 0, "nothing was carried out");
    await bridge.stop();
  });
});

// AC-21 (1)/(3): an accepted decision whose answer was lost becomes uncertain, and Plannotator's
// matching report confirms it; it is applied once.
test("a lost Plannotator answer becomes uncertain and a matching report applies it once", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  let bridge!: PlannotatorBridge;
  let calls = 0;
  const decide = async () => { calls++; throw new ReviewClosedError("Plannotator did not answer; the outcome is unknown.", true); };
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, decide, () => {});
    bridge.attach(f.paseo);
    await bridge.drain();
    await assert.rejects(bridge.decideOwner("http://localhost:4000/", true, "", "agent-1", { source: "inbox" }));
    const uncertain = onlyAttempt(bridge);
    assert.equal(uncertain.state, "uncertain");
    assert.equal(uncertain.appliedAt, undefined);
    assert.equal(f.documents.size, 0, "nothing is applied while unconfirmed");
    // The extension's report of the accepted decision arrives.
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(2), at: "2026-01-01T10:05:00Z" }));
    await bridge.drain();
    const applied = onlyAttempt(bridge);
    assert.equal(applied.state, "applied");
    assert.deepEqual(applied.reports, ["1.json"]);
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(f.commented.filter((body) => body.startsWith("✅")).length, 1);
    assert.equal(calls, 1, "the report needed no second Plannotator call");
    await bridge.stop();
  });
});

// AC-21 (2): an uncertain decision whose review is gone and that is never reported stays
// uncertain: no timeout voids it and nothing is applied.
test("an uncertain decision whose review is gone and never reported stays uncertain and is never applied", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  let bridge!: PlannotatorBridge;
  const decide = async () => { throw new ReviewClosedError("Plannotator is not reachable at http://localhost:4000: connect ECONNREFUSED", true); };
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, decide, () => {});
    bridge.useReviewOutcomes(async () => null);
    bridge.attach(f.paseo);
    await bridge.drain();
    await assert.rejects(bridge.decideOwner("http://localhost:4000/", true, "", "agent-1", { source: "inbox" }));
    assert.equal(onlyAttempt(bridge).state, "uncertain");
    for (let minute = 0; minute < 60; minute++) { t.mock.timers.tick(60_000); await bridge.drain(); }
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "uncertain", "no timeout voids an unconfirmed decision");
    assert.equal(attempt.voidReason, undefined);
    assert.equal(attempt.appliedAt, undefined);
    assert.equal(attempt.waitsForOwner, true, "the owner is told Plannotator cannot confirm it");
    assert.equal(f.documents.size, 0);
    await bridge.stop();
  });
});

// AC-21 (6): while the review still answers with the same plan the decision is sent again; the
// delayed report of the original then only confirms the one decision.
test("a resend that wins the race with the delayed original applies the decision once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  let bridge!: PlannotatorBridge;
  const calls: string[] = [];
  const decide = async (url: string, approve: boolean, feedback: string) => {
    calls.push(`${url} ${approve} "${feedback}"`);
    if (calls.length === 1) throw new ReviewClosedError("Plannotator did not answer; the outcome is unknown.", true);
  };
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, decide, () => {});
    bridge.useReviewOutcomes(async () => "open");
    bridge.attach(f.paseo);
    await bridge.drain();
    await assert.rejects(bridge.decideOwner("http://localhost:4000/", true, "", "agent-1", { source: "inbox" }));
    assert.equal(onlyAttempt(bridge).state, "uncertain");
    // The next recheck sends the same decision again, on the same generation.
    t.mock.timers.tick(15_000);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "pending");
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    // The original's report arrives late: a confirmation, not a second decision.
    await writeFile(join(directory, "1.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(2), at: "2026-01-01T10:05:00Z" }));
    await bridge.drain();
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "applied");
    assert.deepEqual(attempt.reports, ["1.json"]);
    assert.deepEqual(calls, ['http://localhost:4000/ true ""', 'http://localhost:4000/ true ""']);
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(f.commented.filter((body) => body.startsWith("✅")).length, 1);
    await bridge.stop();
  });
});

// AC-21 (16): the panel's immediate carrying out and the same sweep's worker run one apply.
test("the panel's immediate apply and the sweep together run one apply", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  const { sessions } = panelFakes(f.calls);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const documentEntered = new Promise<void>((resolve) => { entered = resolve; });
  const upsert = f.linear.upsertIssueDocument;
  f.linear.upsertIssueDocument = async (issueId, title, content) => { entered(); await gate; return upsert(issueId, title, content); };
  await withEvents([], async (directory) => {
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, sessions as never, async () => SPLIT_PLAN, undefined, undefined, undefined, async () => {}, () => {});
    bridge.attach(f.paseo);
    const panel = bridge.decidePanel(PANEL as never, "later");
    await documentEntered;
    const sweep = bridge.drain();
    release();
    assert.equal(await panel, null);
    await sweep;
    assert.equal(onlyAttempt(bridge).state, "applied");
    assert.equal(f.calls.filter((call) => call.startsWith("document ")).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith("reply ")).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith("hold ")).length, 1);
    await bridge.stop();
  });
});

// A contradicting report recorded while the worker waits on a Linear call pauses the decision:
// the step in flight finishes, no further step starts, and it is never marked applied.
test("a conflict recorded while the worker is mid-step stops it before the next step", async () => {
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const documentEntered = new Promise<void>((resolve) => { entered = resolve; });
  const upsert = f.linear.upsertIssueDocument;
  f.linear.upsertIssueDocument = async (issueId, title, content) => { entered(); await gate; return upsert(issueId, title, content); };
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    const bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, async () => {}, () => {});
    bridge.attach(f.paseo);
    await bridge.drain();
    const decision = bridge.decideOwner("http://localhost:4000/", true, "", "agent-1", { source: "inbox" });
    await documentEntered;
    await writeFile(join(directory, "2.json"), JSON.stringify({ type: "decided", agentId: "agent-1", approved: false, feedback: "No, plan again.", planContent: RISKY(2), at: "2026-01-01T10:05:00Z" }));
    const sweep = bridge.drain();
    const journal = bridge.decisionJournal;
    for (let turn = 0; turn < 1_000 && !journal.applying().some((row) => row.kind === "conflict"); turn++) await immediate();
    assert.ok(journal.applying().some((row) => row.kind === "conflict"), "the report is a conflict");
    release();
    await decision;
    await sweep;
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "pending");
    assert.equal(attempt.appliedAt, undefined, "a paused decision is never marked applied");
    assert.ok(journal.paused(attempt.id));
    assert.equal(f.commented.filter((body) => body.startsWith("✅")).length, 0, "no step after the one in flight");
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "pending", "the sweep does not carry it out either");
    await bridge.stop();
  });
});

// AC-23: the owner settles what Plannotator could not: carrying an uncertain decision out needs
// the journal to have given up on Plannotator first, and dropping an unbound report applies
// nothing.
test("the owner settles an uncertain decision and an unbound report: carry-out applies once, drop applies nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const f = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  let bridge!: PlannotatorBridge;
  let decideCalls = 0;
  const decide = async () => { decideCalls++; throw new ReviewClosedError("Plannotator is not reachable at http://localhost:4000: connect ECONNREFUSED", true); };
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4000/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    bridge = new PlannotatorBridge(f.linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, decide, () => {});
    bridge.useReviewOutcomes(async () => null);
    bridge.attach(f.paseo);
    await bridge.drain();
    await assert.rejects(bridge.decideOwner("http://localhost:4000/", true, "", "agent-1", { source: "inbox" }));
    const attempt = onlyAttempt(bridge);
    assert.equal(attempt.state, "uncertain");
    // Still being sent to Plannotator: not the owner's to settle yet.
    await assert.rejects(bridge.resolve(attempt.id, "carry-out"), /still sending that decision/);
    assert.equal(onlyAttempt(bridge).state, "uncertain", "the refusal changed nothing");
    // Once the review is gone for good, carrying it out applies the decision once.
    t.mock.timers.tick(60_000);
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).waitsForOwner, true);
    await bridge.resolve(attempt.id, "carry-out");
    await bridge.drain();
    assert.equal(onlyAttempt(bridge).state, "applied");
    assert.equal(f.documents.get("Plan: TUC-25")?.creates ?? 0, 1);
    assert.equal(f.commented.filter((body) => body.startsWith("✅")).length, 1);
    assert.equal(decideCalls, 1, "carrying out asks Plannotator nothing");
    // A decision that went through cannot be resolved again.
    await assert.rejects(bridge.resolve(attempt.id, "drop"), /changed meanwhile/);
    await bridge.stop();
  });
  // An unbound report: dropping it applies nothing.
  const g = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  await withEvents([
    { type: "opened", agentId: "agent-1", localUrl: "http://localhost:4200/", remoteUrl: null, at: "2026-01-01T10:00:00Z" },
    { type: "decided", agentId: "agent-1", approved: true, planContent: RISKY(3).replace("Add the column to the report.", "Add the export to the report."), at: "2026-01-01T10:05:00Z" },
  ], async (directory) => {
    const dropBridge = new PlannotatorBridge(g.linear, { read: async () => settings }, directory, undefined, async () => RISKY(1), undefined, undefined, undefined, async () => {}, () => {});
    dropBridge.attach(g.paseo);
    await dropBridge.drain();
    const [unbound] = dropBridge.decisionJournal.all().filter((entry) => entry.kind === "unbound");
    assert.ok(unbound);
    const writes = g.calls.length;
    await dropBridge.resolve(unbound.id, "drop");
    const [dropped] = dropBridge.decisionJournal.all().filter((entry) => entry.kind === "unbound");
    assert.ok(dropped);
    assert.equal(dropped.state, "dropped");
    assert.equal(dropBridge.decisionJournal.attempts().length, 0, "nothing was applied");
    assert.equal(g.documents.size, 0);
    assert.equal(g.commented.filter((body) => body.startsWith("✅")).length, 0);
    assert.equal(g.calls.length, writes, "dropping wrote nothing");
    await dropBridge.stop();
  });
  // Dropping an unconfirmed decision voids it and applies nothing.
  const h = tracked({ "linear.issueId": "issue-1", "linear.identifier": "TUC-25" });
  let voidBridge!: PlannotatorBridge;
  await withEvents([{ type: "opened", agentId: "agent-1", localUrl: "http://localhost:4300/", remoteUrl: null, at: "2026-01-01T10:00:00Z" }], async (directory) => {
    voidBridge = new PlannotatorBridge(h.linear, { read: async () => settings }, directory, undefined, async () => RISKY(2), undefined, undefined, undefined, async () => { throw new ReviewClosedError("Plannotator is not reachable at http://localhost:4300: connect ECONNREFUSED", true); }, () => {});
    voidBridge.useReviewOutcomes(async () => null);
    voidBridge.attach(h.paseo);
    await voidBridge.drain();
    await assert.rejects(voidBridge.decideOwner("http://localhost:4300/", true, "", "agent-1", { source: "inbox" }));
    const uncertain = onlyAttempt(voidBridge);
    assert.equal(uncertain.state, "uncertain");
    t.mock.timers.tick(60_000);
    await voidBridge.drain();
    assert.equal(onlyAttempt(voidBridge).waitsForOwner, true);
    await voidBridge.resolve(uncertain.id, "drop");
    const voided = onlyAttempt(voidBridge);
    assert.equal(voided.state, "void");
    assert.match(voided.voidReason ?? "", /Dropped by the owner/);
    assert.equal(h.documents.size, 0, "nothing was applied");
    assert.equal(h.commented.filter((body) => body.startsWith("✅")).length, 0);
    await voidBridge.stop();
  });
});
