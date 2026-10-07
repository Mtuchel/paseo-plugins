import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { Deputy, fingerprint, overrideCommand, readCandidates, type ArbitratedOutcome, type PermissionArbiter } from "./deputy";
import { checkVerdict, evaluationPrompt, policyVersion } from "./deputy-evaluator";
import { LIVE_MIN_CASES, shadowEvidence } from "./deputy-evidence";
import { renderReport, verdict, waitStats } from "./deputy-report";
import { assessRisk, type Part } from "./deputy-risk";
import { gatherSources, registerEntries, type Source, type SourceReaders } from "./deputy-sources";
import type { IssueState } from "./linear";
import { DecisionLog, type LogEntry } from "./owner-decisions";
import { DEFAULT_ACTIVATION, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_WRITEBACK, type DeputySettings, type PluginSettings } from "./settings";

const OWNER = "owner-1";
const APP = "paseo-app";
const VERSION = policyVersion("omp/test-model");
const trusted = { trusted: true, planning: false, attended: false };

function question(id = "r1", options = ["node:test", "vitest"], extra: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    id, provider: "omp", name: "ask", kind: "question", title: "Test runner",
    input: { questions: [
      { header: "Runner", question: "Which test runner should the new module's tests use?", options: options.map((label) => ({ label })) },
      { header: "Comment", question: "Optional comment", options: [], allowEmpty: true },
    ] },
    ...extra,
  };
}

// --- Risk first -----------------------------------------------------------------------------------

test("only a trusted, plan-approved, unattended question with options for every required part gets past the risk floor", () => {
  const verdict = assessRisk(question(), trusted);
  assert.deepEqual(verdict, { ok: true, parts: [{ key: "Runner", question: "Runner: Which test runner should the new module's tests use?", options: ["node:test", "vitest"], effects: {} }] }, "the optional empty comment stays empty");
  assert.equal(assessRisk({ ...question(), kind: "tool" }, trusted).ok, false, "tool approvals stay with the owner");
  assert.equal(assessRisk({ ...question(), kind: "plan" }, trusted).ok, false, "plan approvals stay with the owner");
  assert.deepEqual(assessRisk(question(), { ...trusted, trusted: false }), { ok: false, category: "untrusted", reason: "the ticket was not written by the owner" });
  assert.equal(assessRisk(question(), { ...trusted, planning: true }).ok && "x", false, "a question while planning decides the plan");
  assert.equal(assessRisk(question(), { ...trusted, attended: true }).ok, false);
  const free = question("r2", ["Other (type your own)"]);
  assert.equal((assessRisk(free, trusted) as { category: string }).category, "free-text", "a required free-text part leaves the whole request with the owner");
  const multi = question();
  (multi.input!.questions as Record<string, unknown>[])[0].multiSelect = true;
  assert.equal((assessRisk(multi, trusted) as { category: string }).category, "unsupported");
});

test("every owner-kept category is refused, wherever in the request it shows, including an option's effect", () => {
  const cases: [string, string][] = [
    ["business-decision", "Which discount applies to returning customers?"],
    ["user-facing-wording", "Which button label should the dialog show?"],
    ["production-data", "Run the backfill against production now?"],
    ["external-accounts-or-spend", "Upgrade the plan to get more API credits?"],
    ["security-or-permissions", "Should the service token get write permissions?"],
    ["deleting-data-or-history", "Delete the old upload records?"],
    ["irreversible", "Apply the change permanently?"],
    ["destructive-git", "Force-push the rewritten branch?"],
    ["owner-reserved", "Deploy the service to Railway now?"],
  ];
  for (const [category, text] of cases) {
    const request = question("r", ["Yes", "No"]);
    (request.input!.questions as Record<string, unknown>[])[0].question = text;
    const verdict = assessRisk(request, trusted);
    assert.equal(verdict.ok, false, text);
    assert.equal((verdict as { category: string }).category, category, text);
  }
  // A harmless label with a risky effect.
  const misleading = question("r", ["Option A", "Option B"]);
  (misleading.input!.questions as { options: { label: string; description?: string }[] }[])[0].options[1].description = "also drops table uploads";
  assert.equal((assessRisk(misleading, trusted) as { category: string }).category, "deleting-data-or-history");
});

// --- The evaluator's answer -------------------------------------------------------------------------

const parts: Part[] = [{ key: "Runner", question: "Runner: Which test runner?", options: ["node:test", "vitest"], effects: { vitest: "installs vitest and rewrites the test scripts" } }];
const sources: Source[] = [
  { id: "plan#2", kind: "plan", title: "Plan: TUC-1 — Verification", revision: "aaa", text: "Tests use the node:test runner, like every other module of the plugin.", decisive: true },
  { id: "principles:decision-queue.md:Q-3", kind: "principles", title: "queue", revision: "bbb", text: "Proposal: switch every module to vitest for watch mode.", decisive: false },
  { id: "memory:m1", kind: "memory", title: "Remembered", revision: "m1", text: "The owner once said vitest is nicer to use day to day.", decisive: false },
];
const answer = (body: Record<string, unknown>) => JSON.stringify({ risk: "low", riskReason: "", decision: "answer", reason: "", ...body });

test("an evaluator answer counts only with an offered option and a verbatim quote from a decisive source", () => {
  const good = checkVerdict(answer({ selections: { Runner: "node:test" }, citations: [{ part: "Runner", source: "plan#2", quote: "Tests use the node:test runner" }] }), parts, sources);
  assert.deepEqual(good, { ok: true, selections: { Runner: "node:test" }, citations: [{ sourceId: "plan#2", kind: "plan", title: "Plan: TUC-1 — Verification", revision: "aaa", quote: "Tests use the node:test runner" }] });
  const refused = (raw: string) => {
    const result = checkVerdict(raw, parts, sources);
    assert.equal(result.ok, false, raw);
    return result as { reason: string; category?: string };
  };
  refused(answer({ selections: { Runner: "node:test" }, citations: [] }));
  refused(answer({ selections: { Runner: "jest" }, citations: [{ source: "plan#2", quote: "Tests use the node:test runner" }] }));
  refused(answer({ selections: { Runner: "node:test" }, citations: [{ source: "plan#2", quote: "Tests should use node:test as the runner" }] }));
  refused(answer({ selections: { Runner: "vitest" }, citations: [{ source: "principles:decision-queue.md:Q-3", quote: "switch every module to vitest" }] }));
  refused(answer({ selections: { Runner: "vitest" }, citations: [{ source: "memory:m1", quote: "vitest is nicer to use day to day" }] }));
  refused(answer({ selections: { Runner: "node:test", Extra: "x" }, citations: [{ source: "plan#2", quote: "Tests use the node:test runner" }] }));
  assert.equal(refused(JSON.stringify({ risk: "unknown", decision: "answer" })).category, "unknown", "unknown risk counts as high");
  assert.equal(refused(JSON.stringify({ risk: "production-data", decision: "answer" })).category, "production-data");
  refused("I would pick node:test.");
});

test("the evaluator sees what every option does, not only its label", () => {
  assert.match(evaluationPrompt({ identifier: "TUC-1", parts, context: "", sources }), /"vitest" \(effect: "installs vitest and rewrites the test scripts"\)/);
});

// --- Knowledge second -------------------------------------------------------------------------------

const PLAN = "> **Approved** in Plannotator on 2026-10-01 for TUC-1.\n\n# Plan\n\n## Verification\n\nTests use the node:test runner, like every other module of the plugin.\n";
function readers(over: Partial<SourceReaders> = {}, entries: LogEntry[] = []): SourceReaders {
  return {
    plan: async () => ({ url: "https://linear.app/doc/plan", content: PLAN }),
    principles: async () => ({ commit: "c0ffee", files: {
      "approved.md": "# Approved\n\n## P-9 - Test runner\n\n- Statement: every module's tests use the node:test runner.\n",
      "decisions.md": "# Decisions\n\n## D-4 - Test runner choice\n\n- Outcome: superseded by P-9\n- vitest test runner for modules.\n",
      "decision-queue.md": "# Queue\n\n## Q-3 - Test runner\n\nProposal: use vitest as the runner for new module tests.\n",
    } }),
    rules: async () => [],
    ownerAnswers: async () => entries,
    recall: async () => [{ id: "m1", text: "vitest test runner discussion" }],
    ...over,
  };
}
const asked = { id: "a1:r1", issueId: "i1", identifier: "TUC-1", cwd: "/repo", text: "Which test runner should the new module's tests use? node:test vitest", planApproved: true };

test("sources come in the owner's order; proposals, superseded decisions and memories can only block", async () => {
  const snapshot = await gatherSources(readers(), asked, "/repo/platform");
  assert.equal(snapshot.abstain, null);
  assert.deepEqual(snapshot.sources.map((source) => [source.kind, source.decisive]), [["plan", true], ["principles", true], ["principles", false], ["principles", false], ["memory", false]]);
  assert.match(snapshot.sources[1].title, /P-9/);
  assert.equal((await gatherSources(readers(), { ...asked, planApproved: false }, "/repo/platform")).sources[0].kind, "principles", "a plan that is not approved is no source");
});

test("an unreadable source that should exist makes the deputy abstain rather than answer from less", async () => {
  assert.match((await gatherSources(readers({ principles: async () => { throw new Error("fetch failed"); } }), asked, "/repo/platform")).abstain ?? "", /principles/);
  assert.match((await gatherSources(readers(), asked, null)).abstain ?? "", /no principles repository/);
  assert.match((await gatherSources(readers({ recall: async () => { throw new Error("no Hindsight access is configured on this host"); } }), asked, "/repo/platform")).abstain ?? "", /Hindsight/);
  assert.match((await gatherSources(readers({ plan: async () => { throw new Error("HTTP 500"); } }), asked, "/repo/platform")).abstain ?? "", /plan/);
  assert.match((await gatherSources(readers({ plan: async () => null }), asked, "/repo/platform")).abstain ?? "", /no plan document/, "a plan-ready ticket without its plan");
  assert.match((await gatherSources(readers({ plan: async () => ({ url: "https://linear.app/doc/plan", content: "# Draft\n\nTests use node:test." }) }), asked, "/repo/platform")).abstain ?? "", /not marked approved/);
});

test("a decision that is not binding stays so in every excerpt: its subsections and the cut-off rest of a long one", async () => {
  const long = `${"Background on test runners and their history in this repository. ".repeat(60)}\n\n`;
  const decisions = `# Decisions\n\n## D-4 - Test runner choice\n\n- Outcome: superseded by P-9\n\n${long}The vitest test runner is used for module tests.\n\n### Scope\n\nvitest test runner for every module test.\n\n## D-5 - Logging\n\nLogs go to stderr.\n`;
  const entries = registerEntries(decisions);
  assert.deepEqual(entries.map((entry) => entry.binding), entries.map((entry) => !entry.id.startsWith("D-4")));
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length, "every excerpt has its own id");
  const snapshot = await gatherSources(readers({ principles: async () => ({ commit: "c0ffee", files: { "decisions.md": decisions } }) }), asked, "/repo/platform");
  const d4 = snapshot.sources.filter((source) => source.id.includes(":D-4"));
  assert.ok(d4.length >= 2, "the continuation and the subsection are retrieved");
  assert.ok(d4.every((source) => !source.decisive));
});

test("only answers the plugin delivered for the authenticated owner ground later questions; daemon-reported resolutions never do", async () => {
  const loggedQuestion: LogEntry = { kind: "question", id: "a0:r0", at: "2026-10-01T00:00:00Z", identifier: "TUC-0", issueId: "i0", questions: [{ key: "Runner", question: "Which test runner for the module tests?", options: ["node:test", "vitest"] }] };
  const legacy: LogEntry = { kind: "answer", id: "a0:r0", at: "2026-10-01T00:01:00Z", answers: { Runner: "vitest" } };
  const without = await gatherSources(readers({}, [loggedQuestion, legacy]), asked, "/repo/platform");
  assert.equal(without.sources.some((source) => source.kind === "owner-answer"), false);
  const verified: LogEntry = { kind: "owner-answer", id: "a0:r0", at: "2026-10-01T00:01:00Z", key: "c9", via: "linear-comment", userId: OWNER, answers: { Runner: "node:test" } };
  const withOwner = await gatherSources(readers({}, [loggedQuestion, legacy, verified]), asked, "/repo/platform");
  const found = withOwner.sources.find((source) => source.kind === "owner-answer");
  assert.ok(found?.decisive);
  assert.match(found.text, /Owner answered: node:test/);
});

// --- Evidence ---------------------------------------------------------------------------------------

function cases(count: number, matching: number, version = VERSION): LogEntry[] {
  return Array.from({ length: count }, (_, index): LogEntry[] => [
    { kind: "deputy-prediction", id: `a:${index}`, at: "2026-10-01T00:00:00Z", identifier: "TUC-1", issueId: "i1", version, mode: "shadow", selections: { Runner: "node:test" }, citations: [] },
    { kind: "owner-answer", id: `a:${index}`, at: "2026-10-01T00:10:00Z", key: `c${index}`, via: "linear-comment", userId: OWNER, answers: { Runner: index < matching ? "Node:Test" : "vitest" } },
  ]).flat();
}

test("live needs at least 30 real paired cases at 90% agreement for the current version", () => {
  assert.equal(shadowEvidence(cases(LIVE_MIN_CASES, 27), VERSION).ready, true, "27 of 30 is 90%");
  assert.equal(shadowEvidence(cases(LIVE_MIN_CASES, 26), VERSION).ready, false);
  assert.equal(shadowEvidence(cases(LIVE_MIN_CASES - 1, LIVE_MIN_CASES - 1), VERSION).ready, false);
  assert.equal(shadowEvidence(cases(LIVE_MIN_CASES, LIVE_MIN_CASES, policyVersion("omp/older")), VERSION).pairs.length, 0, "a model or policy change starts over");
});

test("unverified, blank, late and deputy-answered cases never count as agreement", () => {
  const prediction: LogEntry = { kind: "deputy-prediction", id: "a:1", at: "2026-10-01T00:05:00Z", identifier: "TUC-1", issueId: "i1", version: VERSION, mode: "shadow", selections: { Runner: "node:test" }, citations: [] };
  const legacy = shadowEvidence([prediction, { kind: "answer", id: "a:1", at: "2026-10-01T00:10:00Z", answers: { Runner: "node:test" } }], VERSION);
  assert.deepEqual([legacy.pairs.length, legacy.unpaired], [0, ["a:1"]], "a resolution the daemon reports names no responder");
  const blank = shadowEvidence([prediction, { kind: "owner-answer", id: "a:1", at: "2026-10-01T00:10:00Z", key: "s1", via: "linear-session", userId: " ", answers: { Runner: "node:test" } }], VERSION);
  assert.equal(blank.pairs.length, 0);
  const late = shadowEvidence([prediction, { kind: "owner-answer", id: "a:1", at: "2026-10-01T00:04:00Z", key: "c1", via: "linear-comment", userId: OWNER, answers: { Runner: "node:test" } }], VERSION);
  assert.deepEqual(late.late, ["a:1"]);
  const unusable = shadowEvidence([prediction, { kind: "owner-answer", id: "a:1", at: "2026-10-01T00:10:00Z", key: "c1", via: "linear-comment", userId: OWNER, answers: { Runner: "" } }], VERSION);
  assert.equal(unusable.unknown.length, 1);
});

// --- The lifecycle ----------------------------------------------------------------------------------

// The grace timers run on node:test's mocked setTimeout, moved by `advance` together with the
// deputy's clock.
async function harness(t: TestContext, deputy: Partial<DeputySettings> = {}, options: { arbiter?: PermissionArbiter | null; pending?: AgentPermissionRequest[]; verdictSelections?: Record<string, string> } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = await mkdtemp(join(tmpdir(), "deputy-"));
  const log = new DecisionLog(join(directory, "decisions"));
  const settings: PluginSettings = {
    template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true,
    dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION,
    deputy: { ...DEFAULT_DEPUTY, model: "omp/test-model", principlesRepository: "/repo/platform", ...deputy },
  };
  const state: IssueState = { id: "i1", identifier: "TUC-1", status: "In Progress", statusId: "s", statusType: "started", teamId: "t", projectId: null, creatorId: OWNER, labels: [{ id: "l1", name: "plan-ready" }], attachmentUrls: [], blockedBy: [], priority: 0, createdAt: "2026-10-01T00:00:00Z", unblocks: 0 };
  const comments: string[] = [];
  const said: string[] = [];
  const sent: string[] = [];
  const responses: string[] = [];
  const daemon = { pending: options.pending ?? [question()], archived: false };
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { id, status: "running", archivedAt: daemon.archived ? "2026-10-02T00:00:00Z" : null, labels: { "linear.issueId": "i1" }, pendingPermissions: daemon.pending } }),
        send: async (text: string) => { sent.push(`${id}: ${text}`); },
        respondToPermission: async () => { responses.push("untagged"); },
      }),
    },
  } as unknown as PaseoApi;
  let clock = Date.parse("2026-10-07T10:00:00Z");
  let evaluations = 0;
  const instance = new Deputy({
    settings: { read: async () => settings },
    log,
    linear: {
      issueState: async () => state,
      viewerId: async () => OWNER,
      appUserId: async () => APP,
      upsertComment: async (_issueId: string, body: string) => { comments.push(body); return `notice-${comments.length}`; },
    },
    sessions: { sessionFor: async () => ({ sessionId: "s1" }), say: async (_sessionId, _type, body) => { said.push(body); } },
    readers: readers(),
    evaluate: async (input) => {
      evaluations++;
      return checkVerdict(answer({ selections: options.verdictSelections ?? { Runner: "node:test" }, citations: [{ source: input.sources.find((source) => source.kind === "plan")?.id, quote: "Tests use the node:test runner" }] }), input.parts, input.sources);
    },
    arbiter: async () => options.arbiter ?? null,
    directory,
    now: () => clock,
  });
  instance.attach(paseo);
  const agent = { id: "a1", cwd: "/repo", title: "TUC-1: Add module" };
  return {
    deputy: instance, log, settings, state, comments, said, sent, responses, daemon, paseo, directory, agent,
    evaluations: () => evaluations,
    advance: (ms: number) => { clock += ms; t.mock.timers.tick(ms); },
    // Waits for the background work started so far (evaluations, dispatches).
    settle: () => instance.idle(),
    candidate: async () => Object.values(await readCandidates(directory))[0],
  };
}

const kinds = async (h: { log: DecisionLog }) => (await h.log.entries()).map((entry) => entry.kind);

test("off does nothing at all", async (t) => {
  const h = await harness(t, { mode: "off" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal(h.evaluations(), 0);
  assert.equal(await h.candidate(), undefined);
  assert.deepEqual(await kinds(h), []);
});

test("shadow records what it would answer, with its sources, and writes nothing to the agent or the ticket", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.advance(60 * 60_000);
  await h.settle();
  const [prediction] = (await h.log.entries()).filter((entry) => entry.kind === "deputy-prediction");
  assert.equal(prediction.kind === "deputy-prediction" && prediction.version, VERSION);
  assert.deepEqual(prediction.kind === "deputy-prediction" && prediction.selections, { Runner: "node:test" });
  assert.equal(prediction.kind === "deputy-prediction" && prediction.citations[0].quote, "Tests use the node:test runner");
  assert.equal((await h.candidate()).status, "predicted");
  assert.deepEqual([h.responses, h.sent, h.comments, h.said], [[], [], [], []]);
  h.deputy.stop();
});

test("a refused question is logged with its reason and stays with the owner", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  h.state.labels.push({ id: "l2", name: "feedback" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  const refusal = (await h.log.entries()).find((entry) => entry.kind === "deputy-refusal");
  assert.equal(refusal?.kind === "deputy-refusal" && refusal.category, "untrusted");
  assert.equal(h.evaluations(), 0, "risk is checked before any knowledge is looked up");
  assert.equal((await h.candidate()).status, "refused");
});

test("live without the daemon's owner-priority response stays blocked and answers nothing", async (t) => {
  const h = await harness(t, { mode: "live" });
  await h.log.append({ kind: "question", id: "seed", at: "2026-10-01T00:00:00Z", identifier: "TUC-0", issueId: "i0", questions: [] });
  for (const entry of cases(LIVE_MIN_CASES, LIVE_MIN_CASES)) await h.log.append(entry);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal((await h.candidate()).status, "waiting", "the owner keeps the grace period");
  h.advance(5 * 60_000);
  await h.settle();
  const candidate = await h.candidate();
  assert.equal(candidate.status, "blocked");
  assert.match(candidate.reason ?? "", /TUC-1258/);
  assert.deepEqual([h.responses, h.comments], [[], []]);
  assert.deepEqual(await h.deputy.liveBlockers(h.settings), ["the Paseo daemon does not offer owner-priority permission responses with an authoritative responder yet (TUC-1258)"]);
});

function arbiter(result: ArbitratedOutcome = "applied") {
  const calls: { requestId: string; fingerprint: string; answers: unknown }[] = [];
  const value: PermissionArbiter = {
    respond: async (input) => { calls.push({ requestId: input.requestId, fingerprint: input.fingerprint, answers: input.response.behavior === "allow" ? input.response.updatedInput : undefined }); return result; },
    outcome: async () => null,
  };
  return { value, calls };
}

async function liveHarness(t: TestContext, result: ArbitratedOutcome = "applied") {
  const fake = arbiter(result);
  const h = await harness(t, { mode: "live" }, { arbiter: fake.value });
  for (const entry of cases(LIVE_MIN_CASES, LIVE_MIN_CASES)) await h.log.append(entry);
  return { ...h, calls: fake.calls };
}

test("live answers after the grace period through the arbitrated response, then shows the answer, its sources and how to override", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.deepEqual(h.calls, [], "nothing before the grace period ends");
  h.advance(5 * 60_000);
  await h.settle();
  assert.deepEqual(h.calls, [{ requestId: "r1", fingerprint: fingerprint(question()), answers: { answers: { Runner: "node:test", Comment: "" } } }]);
  assert.deepEqual(h.responses, [], "never through the untagged response");
  assert.ok((await kinds(h)).includes("deputy-answer"));
  const candidate = await h.candidate();
  assert.equal(candidate.status, "applied");
  assert.match(h.comments[0], /Answered by the deputy/);
  assert.match(h.comments[0], /Runner: Which test runner.*\*\*node:test\*\*/);
  assert.match(h.comments[0], /“Tests use the node:test runner”/);
  assert.match(h.comments[0], /Reply to override/);
  assert.match(h.said[0], new RegExp(`override ${candidate.ref}`));
});

test("an owner answer during the grace period wins: nothing is sent", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  await h.deputy.ownerAnswered("a1", question(), { behavior: "allow", updatedInput: { answers: { Runner: "vitest" } } }, { via: "linear-comment", activityId: "c1", userId: OWNER }, new Date().toISOString());
  h.advance(10 * 60_000);
  await h.settle();
  assert.deepEqual(h.calls, []);
  assert.equal((await h.candidate()).status, "owner-answered");
});

test("a request that changed since the prediction is not answered", async (t) => {
  const changed = await liveHarness(t);
  await changed.deputy.observe(changed.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await changed.settle();
  changed.daemon.pending = [question("r1", ["node:test", "vitest", "mocha"])];
  changed.advance(5 * 60_000);
  await changed.settle();
  assert.deepEqual([changed.calls, (await changed.candidate()).status], [[], "canceled"]);
});

test("a request answered elsewhere during the grace period is not answered, and neither is the newer one", async (t) => {
  const gone = await liveHarness(t);
  await gone.deputy.observe(gone.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await gone.settle();
  gone.daemon.pending = [question("r2")];
  gone.advance(5 * 60_000);
  await gone.settle();
  assert.deepEqual([gone.calls, (await gone.candidate()).status], [[], "resolved"]);
});

test("an owner who answers at the same moment wins at the daemon: no deputy answer is recorded or shown", async (t) => {
  const raced = await liveHarness(t, "owner-first");
  await raced.deputy.observe(raced.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await raced.settle();
  raced.advance(5 * 60_000);
  await raced.settle();
  assert.equal((await raced.candidate()).status, "owner-won");
  assert.equal((await kinds(raced)).includes("deputy-answer"), false);
  assert.deepEqual(raced.comments, []);
});

test("switching to shadow or off ends waiting candidates at once", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.settings.deputy = { ...h.settings.deputy, mode: "shadow" };
  await h.deputy.settingsChanged();
  h.advance(5 * 60_000);
  await h.settle();
  assert.deepEqual(h.calls, []);
  assert.equal((await h.candidate()).status, "canceled");
});

test("an answer interrupted by a reload is never submitted again", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deputy.stop();
  // The plugin stopped between recording the intent and hearing back.
  const store = await readCandidates(h.directory);
  const key = Object.keys(store)[0];
  store[key] = { ...store[key], status: "dispatching", intentId: "intent-1" };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  const fake = arbiter();
  const reloaded = new Deputy({ settings: { read: async () => h.settings }, log: h.log, linear: { issueState: async () => h.state, viewerId: async () => OWNER, appUserId: async () => APP, upsertComment: async () => "n" }, readers: readers(), evaluate: async () => ({ ok: false, reason: "unused" }), arbiter: async () => fake.value, directory: h.directory });
  reloaded.attach(h.paseo);
  await reloaded.idle();
  assert.deepEqual(fake.calls, []);
  assert.equal((await readCandidates(h.directory))[key].status, "unknown");
});

test("an override goes to the agent that got the deputy's answer, once per owner activity, never as an answer", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.advance(5 * 60_000);
  await h.settle();
  const candidate = await h.candidate();
  // The agent asks something new meanwhile; the correction must not answer it.
  h.daemon.pending = [question("r2", ["Keep", "Split"])];
  const done = await h.deputy.correct(candidate, "Use vitest instead.", { via: "linear-comment", activityId: "c7", userId: OWNER });
  assert.equal(done.delivered, true);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^a1: Correction from the owner/);
  assert.match(h.sent[0], /request r1/);
  assert.match(h.sent[0], /Use vitest instead\./);
  assert.deepEqual(h.responses, []);
  await h.deputy.correct(candidate, "Use vitest instead.", { via: "linear-comment", activityId: "c7", userId: OWNER });
  assert.equal(h.sent.length, 1, "the same owner activity is handled once");
  const override = (await h.log.entries()).filter((entry) => entry.kind === "deputy-override");
  assert.equal(override.length, 1);
  assert.equal((await h.deputy.correct(candidate, "x", { via: "linear-session", activityId: "s9", userId: "" })).delivered, false, "a blank identity is not the owner");
  h.daemon.archived = true;
  const failed = await h.deputy.correct(candidate, "Again.", { via: "linear-comment", activityId: "c8", userId: OWNER });
  assert.equal(failed.delivered, false, "a correction that did not arrive is never reported delivered");
  assert.match(failed.reply, /not delivered/);
});

test("override commands name the deputy answer they correct", () => {
  assert.deepEqual(overrideCommand("override D-1A2B3C4D use vitest"), { ref: "D-1a2b3c4d", text: "use vitest" });
  assert.deepEqual(overrideCommand("Override D-1a2b3c4d: no"), { ref: "D-1a2b3c4d", text: "no" });
  assert.equal(overrideCommand("please override the earlier answer"), null);
});

// --- The report -------------------------------------------------------------------------------------

test("waiting time counts every question asked in the window, unanswered ones listed, and needs comparable windows to pass", () => {
  const entries: LogEntry[] = [
    { kind: "question", id: "q1", at: "2026-10-01T00:00:00Z", identifier: "TUC-1", issueId: "i1", questions: [] },
    { kind: "answer", id: "q1", at: "2026-10-01T00:30:00Z", answers: {} },
    { kind: "question", id: "q2", at: "2026-10-01T01:00:00Z", identifier: "TUC-1", issueId: "i1", questions: [] },
    { kind: "deputy-answer", id: "q2", at: "2026-10-01T01:06:00Z", identifier: "TUC-1", issueId: "i1", version: VERSION, key: "x", answers: {}, citations: [] },
    { kind: "answer", id: "q2", at: "2026-10-01T01:06:01Z", answers: {} },
    { kind: "question", id: "q3", at: "2026-10-01T02:00:00Z", identifier: "TUC-1", issueId: "i1", questions: [] },
  ];
  const live = waitStats(entries, { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" }, 2);
  assert.deepEqual([live.questions, live.resolved, live.unresolved, live.medianMinutes, live.byDeputy, live.ownerAnswers, live.ownerAnswersPerMergedPullRequest], [3, 2, ["q3"], 18, 1, 1, 0.5]);
  const baseline = waitStats([], { since: "2026-09-30T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" }, 0);
  assert.equal(verdict(baseline, live).pass, null, "no comparable history is inconclusive, not a pass");
  const report = renderReport({ entries, candidates: [], version: VERSION, now: "2026-10-07T00:00:00Z" });
  assert.ok(report.includes(`Shadow evidence for ${VERSION}`));
  assert.match(report, /Answered by the deputy: 1/);
});
