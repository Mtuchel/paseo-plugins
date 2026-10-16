import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { AUTONOMY_POLICY_REVISION } from "../shared/autonomy-policy";
import { Deputy, fingerprint, overrideCommand, readCandidates, type ArbitratedOutcome, type Candidate, type PermissionArbiter } from "./deputy";
import { checkVerdict, policyVersion, type EvaluationInput } from "./deputy-evaluator";
import { TECHNICAL_CONTINUATION, TECHNICAL_CONTINUATION_TEMPLATE, supportsTechnicalContinuation, type TechnicalContinuation } from "./deputy-continuation";
import { LIVE_MIN_CASES, shadowEvidence } from "./deputy-evidence";
import { renderReport, verdict, waitStats } from "./deputy-report";
import { assessRisk, type Part } from "./deputy-risk";
import { gatherSources, hash, hostReaders, recallAccess, registerEntries, standingSources, verifyCitation, type Source, type SourceReaders, type TicketHistory } from "./deputy-sources";
import type { IssueState, TicketComment } from "./linear";
import { DecisionLog, questionEntry, type LogEntry } from "./owner-decisions";
import { questionsOf } from "./relay";
import { PermissionReplies } from "./permission-replies";
import { DEFAULT_ACTIVATION, DEFAULT_DEPUTY, DEFAULT_BACKSTOP, DEFAULT_DISPATCH, DEFAULT_WATCHDOG, DEFAULT_STEWARD, DEFAULT_WRITEBACK, DEFAULT_WORKTREE_SHARDS, type DeputySettings, type PluginSettings } from "./settings";

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

test("trusted structured questions qualify independently of planning or attended metadata", () => {
  const verdict = assessRisk(question(), trusted);
  assert.deepEqual(verdict, { ok: true, parts: [{ key: "Runner", question: "Runner: Which test runner should the new module's tests use?", options: ["node:test", "vitest"], effects: {} }] }, "the optional empty comment stays empty");
  assert.equal(assessRisk({ ...question(), kind: "tool" }, trusted).ok, false, "tool approvals stay with the owner");
  assert.equal(assessRisk({ ...question(), kind: "plan" }, trusted).ok, false, "plan approvals stay with the owner");
  assert.deepEqual(assessRisk(question(), { ...trusted, trusted: false }), { ok: false, category: "untrusted", reason: "the ticket was not written by the owner" });
  assert.equal(assessRisk(question(), { ...trusted, planning: true }).ok, true);
  assert.equal(assessRisk(question(), { ...trusted, attended: true }).ok, true);
  const free = question("r2", ["Other (type your own)"]);
  assert.equal((assessRisk(free, trusted) as { category: string }).category, "free-text", "a required free-text part leaves the whole request with the owner");
  const multi = question();
  (multi.input!.questions as Record<string, unknown>[])[0].multiSelect = true;
  assert.equal((assessRisk(multi, trusted) as { category: string }).category, "unsupported");
});

test("domain words and rejected options do not veto semantic action evaluation; descriptions remain intact", () => {
  for (const description of [
    "The PR is above/about the usual size; continue the approved fix.",
    "Correct the purchase fixture without changing purchasing policy.",
    "Repair merge-buffer enumeration and Git read-only branch listing.",
    "Use authorized core-staging credentials in a scoped staging-only process.",
    "Prepare a revised no-reset plan; do not execute the production cutover.",
  ]) {
    const result = assessRisk(question("r", undefined, { description }), trusted);
    assert.equal(result.ok, true, description);
  }
  const request = question("r", ["Read-only investigation", "Destructive production reset"]);
  (request.input!.questions as { options: { label: string; description?: string }[] }[])[0].options[1].description = "DROP production tables and reset Git history";
  const result = assessRisk(request, trusted);
  assert.ok(result.ok);
  assert.equal(result.parts[0].effects["Destructive production reset"], "DROP production tables and reset Git history", "the evaluator must see every bundled consequence, not a sanitized label");
});

test("ambiguous duplicate labels or part keys are ineligible for checked answer construction", () => {
  assert.equal(assessRisk(question("r", ["Yes", "Yes"]), trusted).ok, false);
  const request = question();
  const items = request.input!.questions as Record<string, unknown>[];
  items.push({ ...items[0] });
  assert.equal(assessRisk(request, trusted).ok, false);
});

// --- The evaluator's answer -------------------------------------------------------------------------

const parts: Part[] = [{ key: "Runner", question: "Runner: Which test runner?", options: ["node:test", "vitest"], effects: { vitest: "installs vitest and rewrites the test scripts" } }];
const sources: Source[] = [
  { id: "plan#2", kind: "plan", title: "Plan: TUC-1 — Verification", revision: "aaa", text: "Tests use the node:test runner, like every other module of the plugin.", decisive: true },
  { id: "principles:decision-queue.md:Q-3", kind: "principles", title: "queue", revision: "bbb", text: "Proposal: switch every module to vitest for watch mode.", decisive: false },
  { id: "memory:m1", kind: "memory", title: "Remembered", revision: "m1", text: "The owner once said vitest is nicer to use day to day.", decisive: false },
];
const TECHNICAL_OUTCOME = { scope: "technical", effects: "Technical implementation only; no consequential business/user workflow or permission change." };
const INTACT_INTEGRITY = Object.fromEntries(["preservation", "ownerArtifacts", "acceptance", "gates"].map(key => [key, { state: "not-implicated", reason: "This bounded local action leaves the requirement intact and claims no exception or missing prerequisite." }]));
function answer(body: Record<string, unknown>): string {
  const selections = body.selections && typeof body.selections === "object" ? Object.entries(body.selections) : [];
  const actions = Object.fromEntries(selections.map(([part, option]) => [part, { option, actor: "agent", risk: "low", effects: `Use ${option} for the local test runner`, outcome: TECHNICAL_OUTCOME, integrity: INTACT_INTEGRITY, reason: "Authorized by the cited approved plan", authority: "specific" }]));
  return JSON.stringify({ risk: "low", riskReason: "", decision: "answer", reason: "", actions, ...body });
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

test("an evaluator answer counts only with an offered option and a verbatim quote from a decisive source", () => {
  const good = checkVerdict(answer({ selections: { Runner: "node:test" }, citations: [{ part: "Runner", source: "plan#2", quote: "Tests use the node:test runner" }] }), parts, sources);
  assert.deepEqual(good, { ok: true, standing: false, selections: { Runner: "node:test" }, citations: [{ sourceId: "plan#2", kind: "plan", title: "Plan: TUC-1 — Verification", revision: "aaa", quote: "Tests use the node:test runner" }] });
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
    // No ticket history by default: the tests that need one build it with `history(...)`.
    ticketHistory: async () => ({ ownerId: OWNER, comments: [], recorded: [], recordsFrom: null }),
    recall: async () => [{ id: "m1", text: "vitest test runner discussion" }],
    ...over,
  };
}
const asked = { id: "a1:r1", issueId: "i1", identifier: "TUC-1", cwd: "/repo", text: "Which test runner should the new module's tests use? node:test vitest", planApproved: true };

test("standing delegation is always citable, while proposals, superseded decisions and memories remain blocking-only", async () => {
  const snapshot = await gatherSources(readers(), asked, "/repo/platform");
  assert.equal(snapshot.abstain, null);
  assert.equal(snapshot.sources.find((source) => source.id.includes("approved.md:P-9"))?.decisive, true);
  assert.equal(snapshot.sources.find((source) => source.id.includes("decisions.md:D-4"))?.decisive, false);
  assert.equal(snapshot.sources.find((source) => source.id.includes("decision-queue.md:Q-3"))?.decisive, false);
  assert.equal(snapshot.sources.find((source) => source.kind === "memory")?.decisive, false);
  const unrelated = await gatherSources(readers(), { ...asked, text: "xyzzy", planApproved: false }, null);
  const authority = unrelated.sources.find((source) => source.id === "standing-policy:engineering")!;
  const result = checkVerdict(answer({ selections: { Runner: "node:test" }, actions: { Runner: { option: "node:test", actor: "agent", risk: "low", effects: "Local behavioral test runner, no production changes", outcome: TECHNICAL_OUTCOME, integrity: INTACT_INTEGRITY, reason: "Routine engineering within the authorized outcome", authority: "standing" } }, citations: [{ part: "Runner", source: authority.id, quote: authority.text }] }), parts, unrelated.sources);
  assert.ok(result.ok && result.standing, "standing authority survives zero keyword overlap and need not dictate the exact runner");
  assert.equal(unrelated.sources.some((source) => source.kind === "plan"), false, "no unapproved plan authority");
});

test("an unreadable source that should exist makes the deputy abstain rather than answer from less", async () => {
  assert.match((await gatherSources(readers({ principles: async () => { throw new Error("fetch failed"); } }), asked, "/repo/platform")).abstain ?? "", /principles/);
  assert.equal((await gatherSources(readers(), asked, null)).abstain, null, "an unconfigured optional repository is not an unreadable configured source");
  assert.match((await gatherSources(readers({ recall: async () => { throw new Error("no Hindsight access is configured on this host"); } }), asked, "/repo/platform")).abstain ?? "", /Hindsight/);
  assert.match((await gatherSources(readers({ plan: async () => { throw new Error("HTTP 500"); } }), asked, "/repo/platform")).abstain ?? "", /plan/);
  assert.match((await gatherSources(readers({ plan: async () => null }), asked, "/repo/platform")).abstain ?? "", /no plan document/, "a plan-ready ticket without its plan");
  assert.match((await gatherSources(readers({ plan: async () => ({ url: "https://linear.app/doc/plan", content: "# Draft\n\nTests use node:test." }) }), asked, "/repo/platform")).abstain ?? "", /not marked approved/);
  assert.match((await gatherSources(readers({ ownerAnswers: async () => { throw new Error("journal unavailable"); } }), asked, "/repo/platform")).abstain ?? "", /earlier owner answers/);
});

test("only truly absent optional recall permits an authority snapshot; unreadable and invalid configured recall refuse", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "deputy-recall-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousToken = process.env.HINDSIGHT_API_TOKEN;
  delete process.env.HINDSIGHT_API_TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.HINDSIGHT_API_TOKEN;
    else process.env.HINDSIGHT_API_TOKEN = previousToken;
  });
  const host = hostReaders({ linear: { issueDocument: async () => null, viewerId: async () => OWNER, issueCommentHistory: async () => [] }, log: { entries: async () => [] }, home: directory, directory, template: async () => "" });
  const snapshot = () => gatherSources(readers({ recall: host.recall }), asked, "/repo/platform");
  assert.equal(await recallAccess(directory, {}), null);
  assert.equal((await snapshot()).abstain, null, "missing optional configuration is not a source failure");
  await mkdir(join(directory, "recall.json"));
  assert.match((await snapshot()).abstain ?? "", /Hindsight.*unreadable/, "a configured path that cannot be read must not become no recall");
  await rm(join(directory, "recall.json"), { recursive: true });
  for (const config of ["{secret-not-valid-json", "null", "{}", JSON.stringify({ url: "not-a-url", token: "private-test-token" }), JSON.stringify({ url: "https://recall.invalid", token: "" })]) {
    await writeFile(join(directory, "recall.json"), config);
    const result = await snapshot();
    assert.match(result.abstain ?? "", /Hindsight.*(invalid|requires)/);
    assert.ok(!result.abstain?.includes("secret-not-valid-json") && !result.abstain?.includes("private-test-token"), "source failure diagnostics cannot echo credentials");
  }
  await writeFile(join(directory, "recall.json"), JSON.stringify({ url: "https://recall.invalid/", bank: "test", token: "private-test-token" }));
  assert.deepEqual(await recallAccess(directory, {}), { url: "https://recall.invalid", bank: "test", token: "private-test-token" });
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

// --- The ticket's own history -----------------------------------------------------------------------

// The directive the owner left on TUC-1270 on 2026-10-14 (comment 57c79f7e): it exists as a Linear
// comment and as a resolution the daemon recorded, and neither was evidence before.
const DIRECTIVE = "Retain approved plan and selected temporary P-13 exception; wait for actual TUC-1754 #5189 list/edit backend. Recover exact historical permission/placement choices before final wiring rather than assume unselected recommendations.";
const OWNER_COMMENT = { id: "k-57c79f7e", body: `Owner decision (2026-10-14): ${DIRECTIVE}`, createdAt: "2026-10-14T08:00:00Z", updatedAt: "2026-10-14T08:00:00Z", url: "https://linear.app/tuc/comment/k-57c79f7e", authorId: OWNER };
function history(comments: TicketComment[] = [], recorded: string[] = [], recordsFrom: string | null = "2026-09-01T00:00:00Z"): TicketHistory {
  return { ownerId: OWNER, comments, recorded, recordsFrom };
}

test("the ticket's own comments and recorded resolutions travel whole and can only block", async () => {
  const resolution: LogEntry = { kind: "question", id: "a1:r0", at: "2026-10-14T07:00:00Z", identifier: "TUC-1", issueId: "i1", questions: [{ key: "Response", question: "How should the list/edit wiring proceed?", options: [] }] };
  const resolved: LogEntry = { kind: "answer", id: "a1:r0", at: "2026-10-14T07:30:00Z", answers: { Response: DIRECTIVE } };
  // The demonstrated TUC-1270 shape: the constraint survives as a resolution whose question is no
  // longer in the log, under this agent's id prefix.
  const historical: LogEntry = { kind: "answer", id: "a1:15a81ebb1e45befb", at: "2026-10-16T05:54:46.654Z", answers: { Response: `Owner decision from guided Needs input review (2026-10-14): ${DIRECTIVE}` } };
  const snapshot = await gatherSources(readers({ ticketHistory: async () => history([OWNER_COMMENT]) }, [resolution, resolved, historical]), { ...asked, text: "xyzzy" }, null);
  assert.equal(snapshot.abstain, null);
  const comment = snapshot.sources.find((source) => source.id === `owner-comment:${OWNER_COMMENT.id}`);
  assert.ok(comment, "the owner's own comment on the ticket is evidence");
  assert.equal(comment.text, OWNER_COMMENT.body, "kept whole, with no keyword filter over the ticket's history");
  assert.equal(comment.decisive, false, "a comment constrains; it never authorizes");
  assert.match(comment.title, /^Owner's own comment on TUC-1, 2026-10-14 \(complete history\)$/, "Linear's author beside the plugin's records is what names it the owner's own");
  assert.equal(comment.revision, hash(`${OWNER_COMMENT.updatedAt}\n${OWNER_COMMENT.body}`), "an edit changes the revision it is fenced by");
  const recorded = snapshot.sources.filter((source) => source.kind === "resolution");
  assert.deepEqual(recorded.map((source) => source.id), ["resolution:a1:r0", "resolution:a1:15a81ebb1e45befb"], "a same-ticket resolution is evidence with and without the question it answered");
  assert.match(recorded[0].text, /P-13 exception/);
  assert.match(recorded[1].text, /no longer in the log/);
  assert.ok(recorded.every((source) => source.decisive === false), "the daemon attributes no responder, so it can only block");
  for (const id of [comment.id, ...recorded.map((source) => source.id)]) assert.match(String(verifyCitation(snapshot.sources, id, DIRECTIVE)), /cannot decide an answer/);
  const cited = checkVerdict(answer({ selections: { Runner: "node:test" }, citations: [{ part: "Runner", source: comment.id, quote: OWNER_COMMENT.body }] }), parts, snapshot.sources);
  assert.deepEqual([cited.ok, checkVerdict(answer({ selections: { Runner: "node:test" }, citations: [{ part: "Runner", source: recorded[0].id, quote: DIRECTIVE }] }), parts, snapshot.sources).ok], [false, false], "the ticket's own history is no authority to select anything");
});

test("an edited or deleted owner comment re-fences what a verdict was checked against", async () => {
  const fence = async (comments: (typeof OWNER_COMMENT)[]) => {
    const snapshot = await gatherSources(readers({ ticketHistory: async () => history(comments) }), { ...asked, text: "xyzzy" }, null);
    return { sources: snapshot.sources, revision: snapshot.sources.find((source) => source.kind === "owner-comment")?.revision };
  };
  const before = await fence([OWNER_COMMENT]);
  const edited = await fence([{ ...OWNER_COMMENT, body: `${OWNER_COMMENT.body}\nRevoked: the P-13 exception is withdrawn.`, updatedAt: "2026-10-15T09:00:00Z" }]);
  const deleted = await fence([]);
  assert.notEqual(before.revision, edited.revision, "an edited constraint is fenced by its new revision");
  assert.equal(deleted.revision, undefined, "a deleted comment stops constraining at all");
  // A verdict is checked against the source snapshot with its revisions verbatim (deputy.ts,
  // evidenceFingerprint), so an edited or revoked constraint cannot leave the old evidence intact.
  assert.notEqual(hash(JSON.stringify(before.sources)), hash(JSON.stringify(edited.sources)));
  assert.notEqual(hash(JSON.stringify(before.sources)), hash(JSON.stringify(deleted.sources)));
});

test("the deputy's own answer and an owner answer already delivered are never re-read as an unattributed constraint", async () => {
  const questionEntry: LogEntry = { kind: "question", id: "a1:r2", at: "2026-10-16T13:15:46Z", identifier: "TUC-1", issueId: "i1", questions: [{ key: "Response", question: "Who may see and change ordinary files?", options: ["Einkauf only (Recommended)", "Einkauf and Qualität"] }] };
  const echo: LogEntry[] = [
    questionEntry,
    { kind: "answer", id: "a1:r2", at: "2026-10-16T13:20:55Z", answers: { Response: "Einkauf only (Recommended)" } },
    { kind: "deputy-answer", id: "a1:r2", at: "2026-10-16T13:20:55Z", identifier: "TUC-1", issueId: "i1", version: VERSION, key: "c1", answers: { Response: "Einkauf only (Recommended)" }, citations: [] },
    { kind: "answer", id: "a1:r3", at: "2026-10-16T14:00:00Z", answers: { Response: "Einkauf and Qualität" } },
    { kind: "owner-answer", id: "a1:r3", at: "2026-10-16T14:00:00Z", key: "c2", via: "linear-comment", userId: OWNER, answers: { Response: "Einkauf and Qualität" } },
  ];
  const snapshot = await gatherSources(readers({}, echo), { ...asked, text: "xyzzy" }, null);
  assert.equal(snapshot.abstain, null);
  assert.deepEqual(snapshot.sources.filter((source) => source.kind === "resolution"), [], "automation and already-attributed answers are not constraints, whatever their words");
});

test("only Linear's author beside the plugin's own records tells the owner's words from the app's", async () => {
  const app = { ...OWNER_COMMENT, id: "k-app", body: "Owner: switch every module's tests to vitest.", authorId: APP };
  const keyed = { ...OWNER_COMMENT, id: "k-agent", body: "Owner: switch every module's tests to vitest." };
  const snapshot = await gatherSources(readers({ ticketHistory: async () => history([app, keyed], ["k-agent"]) }), asked, null);
  assert.equal(snapshot.abstain, null);
  assert.deepEqual(snapshot.sources.filter((source) => source.kind === "owner-comment"), [], "neither the app's comment nor the plugin's own writing with the owner's key is the owner's words");
});

test("a comment Linear attributes to no user is read as valid, keeps the owner's own comment as the constraint and is never evidence itself", async () => {
  // Linear's own answer for a comment an app or bot actor wrote (user: null) — the real shape of a
  // history that also holds the owner's own comment.
  const unattributed: TicketComment = { ...OWNER_COMMENT, id: "k-no-user", body: "Owner: switch every module's tests to vitest.", authorId: null };
  const snapshot = await gatherSources(readers({ ticketHistory: async () => history([OWNER_COMMENT, unattributed]) }), asked, null);
  assert.equal(snapshot.abstain, null, "a null author is a valid API answer, not an unreadable history");
  assert.deepEqual(snapshot.sources.filter((source) => source.kind === "owner-comment").map((source) => source.id), [`owner-comment:${OWNER_COMMENT.id}`], "the owner's own comment stays the constraint while the unattributed one is not his words");
  assert.match(snapshot.sources.find((source) => source.id === `owner-comment:${OWNER_COMMENT.id}`)?.title ?? "", /^Owner's own comment on TUC-1, /, "only the attributed comment is named the owner's own");
});

test("a known record folder that is no longer a folder refuses the deputy's evidence, and reads again once it is restored", async () => {
  const home = await mkdtemp(join(tmpdir(), "deputy-records-"));
  try {
    const host = hostReaders({ linear: { issueDocument: async () => null, viewerId: async () => OWNER, issueCommentHistory: async () => [OWNER_COMMENT] }, log: { entries: async () => [] }, home, directory: home, template: async () => "" });
    const records = join(home, "linear-tickets", "agent-comments");
    await mkdir(records, { recursive: true });
    await writeFile(join(records, "plugin"), "not a folder");
    const refused = await gatherSources(readers({ ticketHistory: host.ticketHistory }), asked, null);
    assert.match(refused.abstain ?? "", /could not be read \(the comment record folder plugin is not a folder\)/, "a record folder replaced by a file must abstain, not read as a history with no records");
    await rm(join(records, "plugin"), { force: true });
    await mkdir(join(records, "plugin"));
    await writeFile(join(records, "plugin", "record.json"), JSON.stringify({ id: "k-key-written", issueId: asked.issueId, createdAt: "2026-10-14T08:00:00Z" }));
    const { recorded, recordsFrom } = await host.ticketHistory(asked.issueId);
    assert.deepEqual(recorded, ["k-key-written"], "the record reads again once the folder is restored");
    assert.equal(Date.parse(recordsFrom!), Date.parse("2026-10-14T08:00:00Z"));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a comment older than the kept records stays evidence that may constrain, and says it is unattributable", async () => {
  const older = await gatherSources(readers({ ticketHistory: async () => history([OWNER_COMMENT], [], "2026-10-15T00:00:00Z") }), asked, null);
  const comment = older.sources.find((source) => source.kind === "owner-comment");
  assert.match(comment?.title ?? "", /may be the plugin's own writing/);
  assert.equal(comment?.decisive, false);
  const withoutRecords = await gatherSources(readers({ ticketHistory: async () => history([OWNER_COMMENT], [], null) }), asked, null);
  assert.match(withoutRecords.sources.find((source) => source.kind === "owner-comment")?.title ?? "", /no comment records are kept on this host/);
});

test("a ticket history that cannot be read whole makes the deputy abstain rather than answer without the owner's constraints", async () => {
  const unreadable = await gatherSources(readers({ ticketHistory: async () => { throw new Error("Linear answered HTTP 500"); } }), asked, "/repo/platform");
  assert.match(unreadable.abstain ?? "", /complete comment history.*HTTP 500/);
  const truncated = await gatherSources(readers({ ticketHistory: async () => { throw new Error("Linear returned more than 50 pages of comments for one ticket."); } }), asked, "/repo/platform");
  assert.match(truncated.abstain ?? "", /more than 50 pages/, "an unfinished history is not a history without the constraint");
  const records = await gatherSources(readers({ ticketHistory: async () => { throw new Error("the comment record broken.json is not valid JSON"); } }), asked, "/repo/platform");
  assert.match(records.abstain ?? "", /comment records could not be read/, "a record that cannot be read refuses the history instead of vanishing from it");
  // Through the host's own readers, not only the injected fake: a damaged record on disk refuses
  // the real composition the deputy runs with.
  const home = await mkdtemp(join(tmpdir(), "deputy-history-"));
  try {
    await mkdir(join(home, "linear-tickets", "agent-comments", "plugin"), { recursive: true });
    await writeFile(join(home, "linear-tickets", "agent-comments", "plugin", "broken.json"), "{not json");
    const host = hostReaders({ linear: { issueDocument: async () => null, viewerId: async () => OWNER, issueCommentHistory: async () => [OWNER_COMMENT] }, log: { entries: async () => [] }, home, directory: home, template: async () => "" });
    const refused = await gatherSources(readers({ ticketHistory: host.ticketHistory }), asked, "/repo/platform");
    assert.match(refused.abstain ?? "", /comment records could not be read/, "the host's own reader composition fails closed on a damaged record");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an unrelated owner comment on the ticket leaves routine standing-delegation work answerable", async () => {
  const snapshot = await gatherSources(readers({ ticketHistory: async () => history([{ ...OWNER_COMMENT, body: "Nice work on the previous ticket; keep the changelog line short." }]) }), { ...asked, planApproved: false }, null);
  assert.equal(snapshot.abstain, null);
  assert.ok(snapshot.sources.some((source) => source.kind === "owner-comment"), "the comment is context for the evaluator");
  const authority = snapshot.sources.find((source) => source.id === "standing-policy:engineering")!;
  const result = checkVerdict(answer({ selections: { Runner: "node:test" }, actions: { Runner: { option: "node:test", actor: "agent", risk: "low", effects: "Local behavioral test runner, no production changes", outcome: TECHNICAL_OUTCOME, integrity: INTACT_INTEGRITY, reason: "Routine engineering within the authorized outcome", authority: "standing" } }, citations: [{ part: "Runner", source: authority.id, quote: authority.text }] }), parts, snapshot.sources);
  assert.ok(result.ok && result.standing, "blocking-only context never turns an ordinary technical case into an owner handback");
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

test("refusal retries count one question and recovered predictions do not double-count coverage", () => {
  const refusal: LogEntry = { kind: "deputy-refusal", id: "a:0", at: "2026-10-01T00:00:00Z", identifier: "TUC-1", issueId: "i1", version: VERSION, mode: "shadow", category: "source-unavailable", reason: "offline" };
  const changed: LogEntry = { ...refusal, key: "retry", category: "no-knowledge", reason: "no rule decides" };
  assert.deepEqual(shadowEvidence([refusal, changed], VERSION).refusals, { "no-knowledge": 1 });
  const recovered = shadowEvidence([refusal, changed, ...cases(1, 1)], VERSION);
  assert.deepEqual(recovered.refusals, {});
  assert.equal(recovered.pairs.length, 1);
  assert.equal(recovered.ready, false);
});

test("live-mode predictions and earlier evaluator versions cannot satisfy the shadow gate", () => {
  const live = cases(30, 30).map((entry): LogEntry => entry.kind === "deputy-prediction" ? { ...entry, mode: "live" } : entry);
  assert.equal(shadowEvidence(live, VERSION).pairs.length, 0);
  const old = cases(1, 1, "old-version").filter((entry) => entry.kind === "deputy-prediction");
  assert.equal(shadowEvidence([...old, ...cases(1, 1)], VERSION).pairs.length, 1, "the current version is not masked by an older prediction");
});

// --- The lifecycle ----------------------------------------------------------------------------------

// Grace and settlement retry timers use node:test's mocked setTimeout, moved by `advance` together
// with the deputy's clock.
async function harness(t: TestContext, deputy: Partial<DeputySettings> = {}, options: { arbiter?: PermissionArbiter | null; pending?: AgentPermissionRequest[]; verdictSelections?: Record<string, string> } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = await mkdtemp(join(tmpdir(), "deputy-"));
  const log = new DecisionLog(join(directory, "decisions"));
  const settings: PluginSettings = {
    template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: true,
    dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, steward: DEFAULT_STEWARD, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP,
    deputy: { ...DEFAULT_DEPUTY, model: "omp/test-model", principlesRepository: "/repo/platform", ...deputy },
    worktreeShards: DEFAULT_WORKTREE_SHARDS,
  };
  const state: IssueState = { id: "i1", identifier: "TUC-1", status: "In Progress", statusId: "s", statusType: "started", teamId: "t", projectId: null, creatorId: OWNER, labels: [{ id: "l1", name: "plan-ready" }], attachmentUrls: [], blockedBy: [], priority: 0, createdAt: "2026-10-01T00:00:00Z", unblocks: 0 };
  const comments: string[] = [];
  const said: string[] = [];
  const sent: string[] = [];
  const responses: string[] = [];
  const daemon = { pending: options.pending ?? [question()], archived: false, inventory: false };
  const currentAgent = (id: string) => ({ id, cwd: "/repo", title: "TUC-1: Add module", status: "running", createdAt: "2026-10-01T00:00:00Z", archivedAt: daemon.archived ? "2026-10-02T00:00:00Z" : null, labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" }, pendingPermissions: daemon.pending });
  const paseo = {
    agents: {
      list: async () => ({ entries: daemon.inventory ? [{ agent: currentAgent("a1") }] : [], pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: currentAgent(id) }),
        send: async (text: string) => { sent.push(`${id}: ${text}`); },
        respondToPermission: async () => { responses.push("untagged"); },
      }),
    },
  } as unknown as PaseoApi;
  let clock = Date.parse("2026-10-07T10:00:00Z");
  let evaluations = 0;
  const deps: ConstructorParameters<typeof Deputy>[0] = {
    settings: { read: async () => settings },
    log,
    linear: {
      issueState: async () => state,
      viewerId: async () => OWNER,
      trustedAppIds: async () => [APP],
      upsertComment: async (_issueId: string, body: string) => { comments.push(body); return `notice-${comments.length}`; },
    },
    sessions: { sessionFor: async () => ({ sessionId: "s1" }), say: async (_sessionId, _type, body) => { said.push(body); } },
    readers: readers(),
    evaluate: async (input) => {
      evaluations++;
      return checkVerdict(answer({ selections: options.verdictSelections ?? { Runner: "node:test" }, citations: [{ source: input.sources.find((source) => source.kind === "plan" && source.decisive)?.id, quote: "Tests use the node:test runner" }] }), input.parts, input.sources);
    },
    arbiter: async () => options.arbiter ?? null,
    directory,
    now: () => clock,
  };
  const instance = new Deputy(deps);
  t.after(() => instance.stop());
  instance.attach(paseo);
  const agent = { id: "a1", cwd: "/repo", title: "TUC-1: Add module" };
  return {
    deputy: instance, deps, log, settings, state, comments, said, sent, responses, daemon, paseo, directory, agent,
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

test("a transient ticket outage recovers without another observation and never answers in shadow", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  const read = h.deps.linear.issueState;
  h.deps.linear.issueState = async () => { throw new Error("Linear offline"); };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal((await h.candidate()).refusalCategory, "source-unavailable");
  h.deps.linear.issueState = read;
  h.advance(5 * 60_000 - 1);
  await h.settle();
  assert.equal(h.evaluations(), 0, "no early model retry");
  h.advance(1);
  await h.settle();
  assert.equal((await h.candidate()).status, "predicted");
  assert.equal(h.evaluations(), 1);
  assert.deepEqual(shadowEvidence(await h.log.entries(), VERSION).refusals, {});
  assert.deepEqual([h.responses, h.comments, h.said], [[], [], []]);
});

test("unchanged evidence does not repeat an abstaining model call; changed evidence is revalidated", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  let attempts = 0;
  const evaluate = h.deps.evaluate;
  h.deps.evaluate = async (input, model) => {
    attempts++;
    return attempts === 1 ? { ok: false, reason: "no rule decides this question" } : evaluate(input, model);
  };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal(attempts, 1);
  assert.equal((await h.candidate()).status, "refused");
  h.deps.readers.plan = async () => ({ url: "https://linear.app/doc/plan", content: PLAN.replace("Tests use the node:test runner", "Tests use a different runner") });
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal(attempts, 2);
  assert.equal((await h.candidate()).status, "refused", "the old quote no longer supports an answer");
  assert.equal((await kinds(h)).includes("deputy-prediction"), false);
  h.deps.readers.plan = async () => ({ url: "https://linear.app/doc/plan", content: `${PLAN}\nThis module follows the test runner rule.\n` });
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal(attempts, 3);
  assert.equal((await h.candidate()).status, "predicted");
});

test("an evaluator outage retries the same evidence without classifying it as missing knowledge", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  const evaluate = h.deps.evaluate;
  h.deps.evaluate = async () => { throw new Error("capacity exceeded"); };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal((await h.candidate()).refusalCategory, "evaluator-unavailable");
  h.deps.evaluate = evaluate;
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "predicted");
  assert.deepEqual(h.responses, []);
});

test("source recovery permits attended technical continuation rather than blanket refusal", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  h.deps.readers.recall = async () => { throw new Error("offline"); };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deps.readers.recall = async () => [];
  h.state.labels.push({ id: "attended", name: `${h.settings.dispatch.label}-attended` });
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "predicted");
  assert.equal((await h.candidate()).retryAt, undefined);
  assert.equal(h.evaluations(), 1);
});

for (const change of ["owner", "resolved", "changed", "gone", "off"] as const) {
  test(`a refused question cannot revive after ${change}`, async (t) => {
    const h = await harness(t, { mode: "shadow" });
    h.deps.readers.recall = async () => { throw new Error("offline"); };
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await h.settle();
    h.deps.readers.recall = async () => [];
    if (change === "owner") await h.deputy.ownerAnswered("a1", question(), { behavior: "allow", updatedInput: { answers: { Runner: "vitest" } } }, { via: "menu-bar", activityId: "owner-reply", userId: OWNER }, "2026-10-07T10:01:00Z");
    if (change === "resolved") await h.deputy.resolved("a1", "r1");
    if (change === "changed") h.daemon.pending = [question("r1", ["node:test", "mocha"])];
    if (change === "gone") h.daemon.pending = [];
    if (change === "off") h.settings.deputy.mode = "off";
    h.advance(5 * 60_000);
    await h.settle();
    assert.equal(h.evaluations(), 0);
    assert.equal((await kinds(h)).includes("deputy-prediction"), false);
    assert.deepEqual(h.responses, []);
    assert.ok(["owner-answered", "resolved", "canceled"].includes((await h.candidate()).status));
  });
}

test("an owner answer during reevaluation prevents a prediction even while waiting for its lane", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  h.deps.readers.recall = async () => { throw new Error("offline"); };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deps.readers.recall = async () => [];
  const evaluate = h.deps.evaluate;
  let release!: () => void;
  let entered!: () => void;
  const evaluating = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  h.deps.evaluate = async (input, model) => { entered(); await hold; return evaluate(input, model); };
  h.advance(5 * 60_000);
  await evaluating;
  let recorded!: () => void;
  const logged = new Promise<void>((resolve) => { recorded = resolve; });
  const append = h.log.append.bind(h.log);
  t.mock.method(h.log, "append", async (entry: LogEntry) => { await append(entry); if (entry.kind === "owner-answer") recorded(); });
  const reply = h.deputy.ownerAnswered("a1", question(), { behavior: "allow", updatedInput: { answers: { Runner: "vitest" } } }, { via: "menu-bar", activityId: "racing-owner", userId: OWNER }, "2026-10-07T10:05:00Z");
  await logged;
  release();
  await reply;
  await h.settle();
  assert.equal((await kinds(h)).includes("deputy-prediction"), false);
  assert.deepEqual(h.responses, []);
});

test("a restart recovers legacy source refusals from the journal, not from a guessed risk exemption", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  h.deps.readers.recall = async () => { throw new Error("offline"); };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deputy.stop();
  const store = await readCandidates(h.directory);
  delete store["a1:r1"].refusalCategory;
  delete store["a1:r1"].retryAt;
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  h.deps.readers.recall = async () => [];
  const restarted = new Deputy(h.deps);
  t.after(() => restarted.stop());
  restarted.attach(h.paseo);
  await restarted.idle();
  h.advance(5 * 60_000);
  await restarted.idle();
  assert.equal((await h.candidate()).status, "predicted");
  assert.equal(h.evaluations(), 1);
});

test("a recovered source cannot open the live gate without real shadow pairs", async (t) => {
  const fake = arbiter();
  const h = await harness(t, { mode: "live" }, { arbiter: fake.value });
  h.deps.readers.recall = async () => { throw new Error("offline"); };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deps.readers.recall = async () => [];
  h.advance(5 * 60_000);
  await h.settle();
  h.advance(1);
  await h.settle();
  assert.equal((await h.candidate()).status, "blocked");
  assert.equal(shadowEvidence(await h.log.entries(), VERSION).ready, false);
  assert.deepEqual(fake.calls, []);
});

test("live without a checked answer connection stays blocked and answers nothing", async (t) => {
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
  assert.equal(candidate.reason, "no checked answer connection to the local Paseo daemon");
  assert.deepEqual([h.responses, h.comments], [[], []]);
  assert.deepEqual(await h.deputy.liveBlockers(h.settings), ["no checked answer connection to the local Paseo daemon"]);
});

function arbiter(result: ArbitratedOutcome = "applied") {
  const calls: { requestId: string; fingerprint: string; answers: unknown }[] = [];
  const outcomes = new Map<string, ArbitratedOutcome>();
  const value: PermissionArbiter = {
    respond: async (input) => {
      if (!input.canSubmit()) return "revoked";
      calls.push({ requestId: input.requestId, fingerprint: input.fingerprint, answers: input.response.behavior === "allow" ? input.response.updatedInput : undefined });
      outcomes.set(input.intentId, result);
      return result;
    },
    outcome: async (intentId) => outcomes.get(intentId) ?? null,
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
  assert.deepEqual(await h.deputy.liveBlockers(h.settings), [], "confirmed connection and passing evidence open the live gate");
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

test("an owner answer whose evidence could not be written is not marked recorded and is written once when it can", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  const append = h.log.append.bind(h.log);
  let failing = true;
  t.mock.method(h.log, "append", async (entry: LogEntry) => {
    if (failing && entry.kind === "owner-answer") throw new Error("owner evidence unavailable");
    return append(entry);
  });
  const response = { behavior: "allow" as const, updatedInput: { answers: { Runner: "vitest" } } };
  const activity = { via: "linear-comment" as const, activityId: "c1", userId: OWNER };
  const at = "2026-10-07T10:01:00Z";
  await assert.rejects(h.deputy.ownerAnswered("a1", question(), response, activity, at), /owner evidence unavailable/);
  assert.equal((await h.candidate()).status, "predicted");
  assert.equal((await kinds(h)).includes("owner-answer"), false);
  failing = false;
  await h.deputy.ownerAnswered("a1", question(), response, activity, at);
  await h.deputy.ownerAnswered("a1", question(), response, activity, at);
  assert.equal((await h.candidate()).status, "owner-answered");
  assert.deepEqual((await h.log.entries()).filter((entry) => entry.kind === "owner-answer"), [
    { kind: "owner-answer", id: "a1:r1", at, key: "c1", via: "linear-comment", userId: OWNER, answers: { Runner: "vitest" } },
  ]);
});

test("blank owner identities and non-question responses leave legacy answers unchanged and add no owner evidence", async (t) => {
  const h = await harness(t);
  const at = "2026-10-07T10:00:00Z";
  const legacy: LogEntry = { kind: "answer", id: "a0:r0", at, answers: { Runner: "vitest" } };
  await h.log.append(legacy);
  const response = { behavior: "allow" as const, updatedInput: { answers: { Runner: "node:test" } } };
  await h.deputy.ownerAnswered("a1", question(), response, { via: "linear-session", activityId: "s1", userId: " " }, at);
  await h.deputy.ownerAnswered("a1", question("approval", undefined, { kind: "tool" }), response, { via: "linear-comment", activityId: "c1", userId: OWNER }, at);
  await h.deputy.ownerAnswered("a1", question(), { behavior: "deny" }, { via: "linear-comment", activityId: "c2", userId: OWNER }, at);
  assert.deepEqual(await h.log.entries(), [legacy]);
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

test("an owner who answers at the same moment wins through the plugin: no deputy answer is recorded or shown", async (t) => {
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
  const reloaded = new Deputy({ settings: { read: async () => h.settings }, log: h.log, linear: { issueState: async () => h.state, viewerId: async () => OWNER, trustedAppIds: async () => [APP], upsertComment: async () => "n" }, readers: readers(), evaluate: async () => ({ ok: false, reason: "unused" }), arbiter: async () => fake.value, directory: h.directory });
  reloaded.attach(h.paseo);
  await reloaded.idle();
  assert.deepEqual(fake.calls, []);
  assert.equal((await readCandidates(h.directory))[key].status, "unknown");
});

test("a dispatch interrupted in a reload settles once the checked connection is back, never resubmitted", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deputy.stop();
  // The plugin stopped between recording the intent and hearing back.
  const store = await readCandidates(h.directory);
  store["a1:r1"] = { ...store["a1:r1"], status: "dispatching", intentId: "intent-1" };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  const fake = arbiter();
  t.mock.method(fake.value, "outcome", async () => "applied" as const);
  let connected = false;
  const reloaded = new Deputy({ ...h.deps, arbiter: async () => (connected ? fake.value : null) });
  t.after(() => reloaded.stop());
  reloaded.attach(h.paseo);
  await reloaded.idle();
  assert.equal((await h.candidate()).status, "dispatching", "with no checked connection nothing is concluded: the settlement stays owed");
  connected = true;
  h.advance(5 * 60_000);
  await reloaded.idle();
  assert.equal((await h.candidate()).status, "applied");
  assert.deepEqual((await h.candidate()).notice, { comment: true, session: true, commentId: "notice-1" });
  assert.deepEqual([fake.calls, h.responses, h.comments.length, h.said.length], [[], [], 1, 1], "no second submission; the answer and its notice appear once the connection is there");
});

test("a reload finishes the notice of a durable applied answer once, without another response", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deputy.stop();
  // The answer was confirmed and logged; the notice was not written yet.
  await h.log.append({ kind: "deputy-answer", id: "a1:r1", at: "2026-10-07T10:00:00Z", identifier: "TUC-1", issueId: "i1", version: VERSION, key: "intent-1", answers: { Runner: "node:test" }, citations: [] });
  const store = await readCandidates(h.directory);
  store["a1:r1"] = { ...store["a1:r1"], status: "applied", intentId: "intent-1", notice: { comment: false, session: false, commentId: null } };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  const fake = arbiter();
  const reloaded = new Deputy({ ...h.deps, arbiter: async () => fake.value });
  t.after(() => reloaded.stop());
  reloaded.attach(h.paseo);
  await reloaded.idle();
  h.advance(5 * 60_000);
  await reloaded.idle();
  assert.deepEqual((await h.candidate()).notice, { comment: true, session: true, commentId: "notice-1" });
  assert.equal((await h.log.entries()).filter((entry) => entry.kind === "deputy-answer").length, 1, "the answer was already recorded and is not recorded again");
  assert.deepEqual([fake.calls, h.responses, h.comments.length, h.said.length], [[], [], 1, 1]);
});

test("a late correction survives a settlement append failure and arms its own retry without a restart", async (t) => {
  const fake = arbiter();
  t.mock.method(fake.value, "outcome", async () => "applied" as const);
  const h = await harness(t, { mode: "shadow" }, { arbiter: fake.value });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  const store = await readCandidates(h.directory);
  const candidate = store["a1:r1"];
  store[candidate.key] = { ...candidate, status: "dispatching", intentId: "confirmed-intent" };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  const append = h.log.append.bind(h.log);
  let failing = true;
  t.mock.method(h.log, "append", async (entry: LogEntry) => {
    if (failing && entry.kind === "deputy-answer") throw new Error("settlement storage unavailable");
    return append(entry);
  });
  h.daemon.pending = [question("r2", ["Keep", "Split"])];
  const activity = { via: "linear-session" as const, activityId: "late-1", userId: OWNER };
  const result = await h.deputy.correctLate("a1", "r1", "Use vitest instead.", activity);
  assert.deepEqual(result, {
    delivered: true,
    reply: `The deputy had already answered this question (${candidate.ref}); your answer went to the agent as your correction.`,
  });
  await h.deputy.correctLate("a1", "r1", "Use vitest instead.", activity);
  assert.equal(h.sent.length, 1, "the correction is deduplicated independently of settlement");
  assert.match(h.sent[0], /request r1/);
  assert.match(h.sent[0], /Use vitest instead\./);
  assert.equal((await h.candidate()).status, "dispatching", "the owed settlement stays on disk");
  assert.equal((await kinds(h)).includes("deputy-answer"), false);
  assert.deepEqual([h.comments, h.said, fake.calls, h.responses], [[], [], [], []]);
  failing = false;
  h.advance(5 * 60_000 - 1);
  await h.settle();
  assert.equal((await kinds(h)).includes("deputy-answer"), false);
  h.advance(1);
  await h.settle();
  assert.equal((await h.candidate()).status, "applied");
  assert.deepEqual((await h.candidate()).notice, { comment: true, session: true, commentId: "notice-1" });
  assert.equal((await h.log.entries()).filter((entry) => entry.kind === "deputy-answer").length, 1);
  assert.equal(h.comments.length, 1);
  assert.equal(h.said.length, 1);
  assert.deepEqual([fake.calls, h.responses, h.daemon.pending.map((request) => request.id)], [[], [], ["r2"]]);
  h.advance(10 * 60_000);
  await h.settle();
  assert.deepEqual([h.sent.length, h.comments.length, h.said.length], [1, 1, 1]);
});

test("a confirmed dispatch whose settlement fails is completed by the timer without another response", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  const append = h.log.append.bind(h.log);
  let failing = true;
  t.mock.method(h.log, "append", async (entry: LogEntry) => {
    if (failing && entry.kind === "deputy-answer") throw new Error("settlement append failed");
    return append(entry);
  });
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "dispatching");
  assert.equal(h.calls.length, 1);
  assert.deepEqual([h.comments, h.said], [[], []]);
  failing = false;
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "applied");
  assert.equal((await h.log.entries()).filter((entry) => entry.kind === "deputy-answer").length, 1);
  assert.deepEqual([h.calls.length, h.comments.length, h.said.length], [1, 1, 1]);
});

test("the retry timer stays alive for unfinished notices after the answer has settled", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  const say = h.deps.sessions!.say;
  let failing = true;
  t.mock.method(h.deps.sessions!, "say", async (sessionId: string, type: "thought" | "response" | "error", body: string) => {
    if (failing) throw new Error("session notice unavailable");
    await say(sessionId, type, body);
  });
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "applied");
  assert.deepEqual((await h.candidate()).notice, { comment: true, session: false, commentId: "notice-1" });
  h.advance(5 * 60_000);
  await h.settle();
  assert.deepEqual([h.comments.length, h.said.length], [1, 0]);
  failing = false;
  h.advance(5 * 60_000);
  await h.settle();
  assert.deepEqual((await h.candidate()).notice, { comment: true, session: true, commentId: "notice-1" });
  assert.deepEqual([h.calls.length, h.comments.length, h.said.length], [1, 1, 1]);
  assert.equal((await h.log.entries()).filter((entry) => entry.kind === "deputy-answer").length, 1);
});

test("reload settles a durable applied outcome once, with notices and no second submission", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deputy.stop();
  const store = await readCandidates(h.directory);
  store["a1:r1"] = { ...store["a1:r1"], status: "dispatching", intentId: "confirmed-intent" };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  const fake = arbiter();
  t.mock.method(fake.value, "outcome", async () => "applied" as const);
  const reloaded = new Deputy({ ...h.deps, arbiter: async () => fake.value });
  t.after(() => reloaded.stop());
  reloaded.attach(h.paseo);
  await reloaded.idle();
  assert.equal((await h.candidate()).status, "applied");
  assert.deepEqual((await h.candidate()).notice, { comment: true, session: true, commentId: "notice-1" });
  assert.deepEqual([fake.calls, h.responses], [[], []]);
  assert.deepEqual([h.comments.length, h.said.length], [1, 1]);
  reloaded.stop();
  const again = new Deputy({ ...h.deps, arbiter: async () => fake.value });
  t.after(() => again.stop());
  again.attach(h.paseo);
  await again.idle();
  assert.equal((await h.log.entries()).filter((entry) => entry.kind === "deputy-answer").length, 1);
  assert.deepEqual([fake.calls.length, h.comments.length, h.said.length], [0, 1, 1]);
});

test("one failed candidate does not stop recovery of the others and its settlement retries later", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  await h.deputy.observe({ ...h.agent, id: "a2" }, question("r2"), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deputy.stop();
  const store = await readCandidates(h.directory);
  for (const [key, candidate] of Object.entries(store)) store[key] = { ...candidate, status: "dispatching", intentId: `confirmed:${key}` };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  const append = h.log.append.bind(h.log);
  let failing = true;
  t.mock.method(h.log, "append", async (entry: LogEntry) => {
    if (failing && entry.kind === "deputy-answer" && entry.id === "a1:r1") throw new Error("first candidate append failed");
    return append(entry);
  });
  const fake = arbiter();
  t.mock.method(fake.value, "outcome", async () => "applied" as const);
  const reloaded = new Deputy({ ...h.deps, arbiter: async () => fake.value });
  t.after(() => reloaded.stop());
  reloaded.attach(h.paseo);
  await reloaded.idle();
  const afterRecovery = await readCandidates(h.directory);
  assert.deepEqual([afterRecovery["a1:r1"].status, afterRecovery["a2:r2"].status], ["dispatching", "applied"]);
  assert.deepEqual([h.comments.length, h.said.length, fake.calls.length], [1, 1, 0]);
  h.advance(5 * 60_000);
  await reloaded.idle();
  assert.equal((await readCandidates(h.directory))["a1:r1"].status, "dispatching");
  assert.deepEqual([h.comments.length, h.said.length], [1, 1]);
  failing = false;
  h.advance(5 * 60_000);
  await reloaded.idle();
  assert.deepEqual((await reloaded.candidates()).map((candidate) => candidate.status), ["applied", "applied"]);
  assert.equal((await h.log.entries()).filter((entry) => entry.kind === "deputy-answer").length, 2);
  assert.deepEqual([h.comments.length, h.said.length, fake.calls.length, h.responses.length], [2, 2, 0, 0]);
});

test("stop fences a dispatch queued behind its candidate lane before it can submit", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.advance(5 * 60_000);
  h.deputy.stop();
  await h.settle();
  assert.deepEqual([h.calls, h.responses, h.comments], [[], [], []]);
  assert.equal((await h.candidate()).status, "canceled");
});

test("stop during asynchronous dispatch checks prevents the final external submission", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  t.mock.method(h.deps.linear, "issueState", async () => {
    entered();
    await paused;
    return h.state;
  });
  h.advance(5 * 60_000);
  await checking;
  h.deputy.stop();
  resume();
  await h.settle();
  assert.deepEqual([h.calls, h.responses, h.comments], [[], [], []]);
  assert.equal((await h.candidate()).status, "canceled");
});

test("a late correction waits for the candidate's in-flight checked response before sending a message", async (t) => {
  const fake = arbiter();
  let entered!: () => void;
  const submitting = new Promise<void>((resolve) => { entered = resolve; });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const respond = fake.value.respond;
  t.mock.method(fake.value, "respond", async (input: Parameters<PermissionArbiter["respond"]>[0]) => {
    entered();
    await paused;
    return respond(input);
  });
  const h = await harness(t, { mode: "live" }, { arbiter: fake.value });
  for (const entry of cases(LIVE_MIN_CASES, LIVE_MIN_CASES)) await h.log.append(entry);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.advance(5 * 60_000);
  await submitting;
  const correction = h.deputy.correctLate("a1", "r1", "Use vitest.", { via: "linear-session", activityId: "late-1", userId: OWNER });
  await Promise.resolve();
  assert.equal(h.sent.length, 0, "an unconfirmed in-flight answer does not authorise a correction");
  h.daemon.pending = [question("r2")];
  resume();
  assert.equal((await correction).delivered, true);
  await h.settle();
  assert.deepEqual([fake.calls.length, h.sent.length, h.responses.length], [1, 1, 0]);
  assert.match(h.sent[0], /request r1/);
  assert.deepEqual(h.daemon.pending.map((request) => request.id), ["r2"]);
});

test("a late answer with no confirmed deputy outcome does not become a correction or answer a newer question", async (t) => {
  const fake = arbiter();
  const h = await harness(t, { mode: "shadow" }, { arbiter: fake.value });
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  const store = await readCandidates(h.directory);
  store["a1:r1"] = { ...store["a1:r1"], status: "dispatching", intentId: "unconfirmed" };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
  h.daemon.pending = [question("r2")];
  assert.equal((await h.deputy.correctLate("a1", "r1", "Use vitest.", { via: "linear-session", activityId: "late-1", userId: OWNER })).delivered, false);
  assert.equal((await h.deputy.correctLate("a1", "missing", "Use vitest.", { via: "linear-session", activityId: "late-2", userId: OWNER })).delivered, false);
  assert.deepEqual([h.sent, fake.calls, h.responses], [[], [], []]);
  assert.deepEqual(h.daemon.pending.map((request) => request.id), ["r2"]);
  assert.equal((await kinds(h)).includes("deputy-override"), false);
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

test("a journal outage after evaluation cannot strand the candidate or permit an unchecked prediction", async (t) => {
  const h = await harness(t, { mode: "shadow" });
  const entries = h.log.entries.bind(h.log);
  const evaluate = h.deps.evaluate;
  h.deps.evaluate = async (input, model) => {
    const verdict = await evaluate(input, model);
    h.log.entries = async () => { throw new Error("journal unavailable"); };
    return verdict;
  };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal((await h.candidate()).refusalCategory, "source-unavailable");
  h.log.entries = entries;
  assert.equal((await kinds(h)).includes("deputy-prediction"), false);
  h.deps.evaluate = evaluate;
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "predicted");
  assert.deepEqual(h.responses, []);
});

test("changed evidence gets a fresh evaluation and full new grace before one checked answer", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deps.readers.recall = async () => [{ id: "fresh-context", text: "The module remains an isolated technical repair." }];
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal(h.calls.length, 0, "the stale prediction cannot dispatch");
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal(h.evaluations(), 2, "changed evidence must be evaluated rather than reusing the answer");
  h.advance(5 * 60_000 - 1);
  await h.settle();
  assert.equal(h.calls.length, 0, "the refreshed prediction receives a complete new grace period");
  h.advance(1);
  await h.settle();
  assert.deepEqual(h.calls.map(call => call.requestId), ["r1"]);
  assert.equal(h.responses.length, 0, "delivery remains checked, never an untagged response");
  const predictions = (await h.log.entries()).filter(entry => entry.kind === "deputy-prediction" && entry.id === "a1:r1");
  assert.equal(predictions.length, 2, "both evidence-bound predictions remain auditable");
});

test("a replacement question cannot be resurrected by a delayed evidence-refusal write after restart", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  const entered = signal();
  const release = signal();
  const append = h.log.append.bind(h.log);
  t.mock.method(h.log, "append", async (entry: LogEntry) => {
    if (entry.kind === "deputy-refusal" && entry.category === "evidence-changed") {
      entered.resolve();
      await release.promise;
    }
    await append(entry);
  });
  h.deps.readers.recall = async () => [];
  h.advance(5 * 60_000);
  await entered.promise;
  h.daemon.pending = [question(), question("r2")];
  await h.deputy.observe(h.agent, question("r2"), { issueId: "i1", identifier: "TUC-1" });
  release.resolve();
  await h.settle();
  h.deputy.stop();
  const restarted = new Deputy(h.deps);
  t.after(() => restarted.stop());
  restarted.attach(h.paseo);
  await restarted.idle();
  for (let step = 0; step < 3; step++) {
    h.advance(5 * 60_000);
    await restarted.idle();
  }
  assert.deepEqual(h.calls.map(call => call.requestId), ["r2"]);
});

test("evidence-refresh recovery after restart keeps a fresh grace before checked delivery", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deps.readers.recall = async () => [];
  h.advance(5 * 60_000);
  await h.settle();
  h.deputy.stop();
  const restarted = new Deputy(h.deps);
  t.after(() => restarted.stop());
  restarted.attach(h.paseo);
  await restarted.idle();
  h.advance(5 * 60_000);
  await restarted.idle();
  assert.equal(h.evaluations(), 2);
  h.advance(5 * 60_000 - 1);
  await restarted.idle();
  assert.equal(h.calls.length, 0);
  h.advance(1);
  await restarted.idle();
  assert.deepEqual(h.calls.map(call => call.requestId), ["r1"]);
});

test("refreshed evidence can refuse an earlier answer rather than inheriting its permission", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deps.readers.ticketHistory = async () => history([OWNER_COMMENT]);
  let reviewedCurrentConstraint = false;
  h.deps.evaluate = async input => {
    reviewedCurrentConstraint = input.sources.some(source => source.text.includes(OWNER_COMMENT.body));
    return { ok: false, category: "owner-boundary", reason: "The current owner constraint reserves this action." };
  };
  h.advance(5 * 60_000);
  await h.settle();
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal(reviewedCurrentConstraint, true);
  h.advance(60 * 60_000);
  await h.settle();
  assert.deepEqual([h.calls, h.responses, h.comments], [[], [], []]);
  assert.equal((await h.candidate()).refusalCategory, "owner-boundary");
});

test("an owner answer during evidence refresh prevents reevaluation and delivery", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.deps.readers.recall = async () => [];
  h.advance(5 * 60_000);
  await h.settle();
  await h.deputy.ownerAnswered("a1", question(), { behavior: "allow", updatedInput: { answers: { Runner: "vitest" } } }, { via: "linear-comment", activityId: "refresh-owner", userId: OWNER }, new Date(h.deps.now!()).toISOString());
  h.advance(30 * 60_000);
  await h.settle();
  assert.equal(h.evaluations(), 1);
  assert.deepEqual(h.calls, []);
});

for (const change of ["amended-plan", "blocking-source", "source-revision", "missing-fingerprint"] as const) {
  test(`dispatch invalidates ${change} even when the original citation remains verbatim`, async (t) => {
    const h = await liveHarness(t);
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await h.settle();
    if (change === "amended-plan") h.deps.readers.plan = async () => ({ url: "https://linear.app/doc/plan", content: `${PLAN}\nException: this module's tests must use vitest instead.\n` });
    if (change === "blocking-source") h.deps.readers.recall = async () => [{ id: "m1", text: "vitest test runner discussion" }, { id: "conflict", text: "This module's test runner choice is disputed; do not use node:test." }];
    if (change === "source-revision") {
      const principles = h.deps.readers.principles;
      h.deps.readers.principles = async (repository) => ({ ...await principles(repository), commit: "new-revision" });
    }
    if (change === "missing-fingerprint") {
      const store = await readCandidates(h.directory);
      delete store["a1:r1"].evidenceFingerprint;
      await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
    }
    h.advance(5 * 60_000);
    await h.settle();
    assert.deepEqual([h.calls, h.responses, h.comments], [[], [], []]);
    assert.equal((await kinds(h)).includes("deputy-answer"), false);
  });
}

// The ticket's own history is part of the evidence fingerprint: an owner directive that was edited,
// deleted or written during the grace period invalidates the prediction instead of being outrun.
for (const change of ["added-owner-comment", "edited-owner-comment", "revoked-owner-comment"] as const) {
  test(`dispatch invalidates a constraint the owner ${change.split("-")[0]} while the answer awaited its grace period`, async (t) => {
    const h = await liveHarness(t);
    const withComment = async () => history([OWNER_COMMENT]);
    if (change !== "added-owner-comment") h.deps.readers.ticketHistory = withComment;
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await h.settle();
    if (change === "added-owner-comment") h.deps.readers.ticketHistory = withComment;
    if (change === "edited-owner-comment") h.deps.readers.ticketHistory = async () => history([{ ...OWNER_COMMENT, body: `${OWNER_COMMENT.body} The exception is withdrawn.`, updatedAt: "2026-10-15T00:00:00Z" }]);
    if (change === "revoked-owner-comment") h.deps.readers.ticketHistory = async () => history();
    h.advance(5 * 60_000);
    await h.settle();
    assert.deepEqual([h.calls, h.responses, h.comments], [[], [], []]);
    assert.equal((await kinds(h)).includes("deputy-answer"), false);
  });
}

for (const boundary of ["readiness", "sources", "checked-submit"] as const) {
  for (const change of ["off", "shadow", "model", "off-then-live", "model-then-original"] as const) {
    test(`${change} revokes a dispatch awaiting ${boundary}`, async (t) => {
      const fake = arbiter();
      const h = await harness(t, { mode: "live" }, { arbiter: fake.value });
      for (const entry of cases(LIVE_MIN_CASES, LIVE_MIN_CASES)) await h.log.append(entry);
      await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
      await h.settle();
      let entered!: () => void;
      const checking = new Promise<void>((resolve) => { entered = resolve; });
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => { resume = resolve; });
      if (boundary === "readiness") {
        const entries = h.log.entries.bind(h.log);
        t.mock.method(h.log, "entries", async () => { const snapshot = await entries(); entered(); await paused; return snapshot; });
      } else if (boundary === "sources") {
        const plan = h.deps.readers.plan;
        h.deps.readers.plan = async (...args) => { const snapshot = await plan(...args); entered(); await paused; return snapshot; };
      } else {
        const respond = fake.value.respond;
        t.mock.method(fake.value, "respond", async (input: Parameters<PermissionArbiter["respond"]>[0]) => { entered(); await paused; return respond(input); });
      }
      h.advance(5 * 60_000);
      await checking;
      if (change === "model" || change === "model-then-original") h.settings.deputy.model = "omp/new-model";
      else h.settings.deputy.mode = change === "shadow" ? "shadow" : "off";
      const notifications = [h.deputy.settingsChanged()];
      if (change === "off-then-live" || change === "model-then-original") {
        h.settings.deputy = { ...h.settings.deputy, mode: "live", model: "omp/test-model" };
        notifications.push(h.deputy.settingsChanged());
      }
      resume();
      await Promise.all(notifications);
      await h.settle();
      assert.deepEqual([fake.calls, h.responses, h.comments], [[], [], []]);
      assert.equal((await h.candidate()).status, "canceled");
      assert.equal((await kinds(h)).includes("deputy-answer"), false);
    });
  }
}

test("a live model change cancels waiting predictions; old-model shadow pairs cannot open the new model's gate", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.settings.deputy.model = "omp/new-model";
  await h.deputy.settingsChanged();
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "canceled");
  assert.equal(shadowEvidence(await h.log.entries(), policyVersion("omp/new-model")).ready, false);
  assert.deepEqual(h.calls, []);
});

for (const change of ["off", "model"] as const) {
  test(`${change} revokes at the real checked-send boundary before settingsChanged can finish its own read`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "deputy-boundary-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sent: string[] = [];
    let entered!: () => void;
    const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void;
    const boundaryPause = new Promise<void>((resolve) => { resume = resolve; });
    const replies = new PermissionReplies({
      directory,
      daemon: async () => ({ respondToPermissionAndWait: async (_agentId, requestId) => { sent.push(requestId); } }),
      beforeSubmit: async () => { entered(); await boundaryPause; },
    });
    t.after(() => replies.stop());
    const h = await harness(t, { mode: "live" }, { arbiter: replies });
    replies.attach(h.paseo);
    for (const entry of cases(LIVE_MIN_CASES, LIVE_MIN_CASES)) await h.log.append(entry);
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await h.settle();
    h.advance(5 * 60_000);
    await atBoundary;
    if (change === "off") h.settings.deputy.mode = "off";
    else h.settings.deputy.model = "omp/new-model";
    let finishRead!: () => void;
    const settingsPause = new Promise<void>((resolve) => { finishRead = resolve; });
    t.mock.method(h.deps.settings, "read", async () => { await settingsPause; return h.settings; });
    const changing = h.deputy.settingsChanged();
    resume();
    await h.settle();
    assert.deepEqual(sent, [], "revocation is synchronous; it does not wait for the settings read or deputy lane");
    const candidate = await h.candidate();
    assert.equal(candidate.status, "canceled");
    assert.equal(await replies.outcome(candidate.intentId!), "revoked");
    assert.equal((await kinds(h)).includes("deputy-answer"), false);
    finishRead();
    await changing;
  });
}

test("each selected action requires its own low-consequence assessment and exact offered actor", () => {
  const base = { option: "node:test", actor: "agent", risk: "low", effects: "Local runner only", outcome: TECHNICAL_OUTCOME, integrity: INTACT_INTEGRITY, reason: "Approved technical implementation", authority: "specific" };
  for (const actions of [
    {}, { Runner: { ...base, option: "vitest" } },
    { Runner: { ...base, risk: "production-write" } },
    ...[undefined, null, ["agent"], {}, true, "owner", "external", "mixed", "unknown"].map(actor => ({ Runner: { ...base, actor } })),
    { Runner: { ...base, effects: "" } },
    { Runner: { ...base, authority: "assumed" } },
    { Runner: base, Unasked: base },
  ]) {
    assert.equal(checkVerdict(answer({ selections: { Runner: "node:test" }, actions, citations: [{ source: "plan#2", quote: "Tests use the node:test runner" }] }), parts, sources).ok, false);
  }
  const actorParts = [{ key: "Run", question: "Who runs the trigger?", options: ["Owner runs trigger", "Wait"], effects: {} }];
  assert.equal(checkVerdict(answer({ selections: { Run: "Agent runs trigger" }, actions: { Run: { ...base, option: "Agent runs trigger" } }, citations: [{ source: "plan#2", quote: "Tests use the node:test runner" }] }), actorParts, sources).ok, false, "delegation does not create an unoffered answer");
});

test("preparing a PR cannot launder newly chosen business workflow effects, including one unsafe part in a mixed request", () => {
  const authority = standingSources();
  const engineering = authority.find(source => source.id === "standing-policy:engineering")!;
  const businessParts: Part[] = [
    { key: "Intake", question: "Keep intake off?", options: ["Keep off"], effects: {} },
    { key: "Fields", question: "May staff edit invoice amount/VAT/currency? Build AC3 as a PR; historical approved scope is unavailable.", options: ["Build AC3"], effects: {} },
    { key: "Save", question: "Change immediate record creation to mandatory check-before-save? Build AC4 as code only.", options: ["Build AC4"], effects: {} },
  ];
  const selections = { Intake: "Keep off", Fields: "Build AC3", Save: "Build AC4" };
  const action = (option: string, scope: string) => ({ option, actor: "agent", risk: "low", effects: "Only prepare a PR; no business data is entered today", outcome: { scope, effects: scope === "technical" ? "Leave intake disabled" : "Choose editable financial fields or change when business records are saved" }, integrity: INTACT_INTEGRITY, reason: "Proposed task names an AC; approval is not available", authority: "standing" });
  const actions = { Intake: action("Keep off", "technical"), Fields: action("Build AC3", "new-workflow-choice"), Save: action("Build AC4", "new-workflow-choice") };
  const citations = businessParts.map(part => ({ part: part.key, source: engineering.id, quote: engineering.text }));
  const result = checkVerdict(answer({ selections, actions, citations }), businessParts, authority);
  assert.ok(!result.ok && result.abstention === "owner-boundary");
  const missingScope = { ...actions, Fields: { ...actions.Fields, outcome: undefined } };
  assert.equal(checkVerdict(answer({ selections, actions: missingScope, citations }), businessParts, authority).ok, false, "the old code-only assessment is not valid current-policy evidence");
  const unknownScope = { ...actions, Fields: action("Build AC3", "unknown") };
  const unknown = checkVerdict(answer({ selections, actions: unknownScope, citations }), businessParts, authority);
  assert.ok(!unknown.ok && unknown.abstention === "investigate");
});

test("approved behavior-preserving invoice repair remains delegated, but baseline evidence must be real and cited for that part", () => {
  const authority = standingSources();
  const engineering = authority.find(source => source.id === "standing-policy:engineering")!;
  const baseline: Source = { id: "plan:invoice", kind: "plan", title: "Approved invoice workflow", revision: "approved-1", decisive: true,
    text: "Approved workflow: the linking drawer already permits staff to edit invoice number/date/amount/VAT/currency. Preserve existing save timing and validation while fixing the stale displayed amount." };
  const invoiceParts: Part[] = [{ key: "Repair", question: "Fix the stale amount display without changing approved edit rights, required values or saving behavior?", options: ["Fix stale display"], effects: {} }];
  const outcome = { scope: "preserves-authorized-workflow", effects: "Restore the existing displayed amount; no new edit rights, save timing or validation policy", source: baseline.id, quote: baseline.text };
  const action = { option: "Fix stale display", actor: "agent", risk: "low", effects: "Behavior-preserving invoice UI repair", outcome, integrity: INTACT_INTEGRITY, reason: "Engineering inside the cited approved baseline", authority: "standing" };
  const citations = [{ part: "Repair", source: engineering.id, quote: engineering.text }, { part: "Repair", source: baseline.id, quote: baseline.text }];
  const evaluate = (current: unknown, listed = citations, evidence = [...authority, baseline]) => checkVerdict(answer({ selections: { Repair: "Fix stale display" }, actions: { Repair: current }, citations: listed }), invoiceParts, evidence);
  const accepted = evaluate(action);
  assert.ok(accepted.ok && accepted.standing);
  assert.equal(evaluate(action, citations.slice(0, 1)).ok, false);
  assert.equal(evaluate(action, citations, authority).ok, false);
  assert.equal(evaluate({ ...action, outcome: { ...outcome, source: engineering.id, quote: engineering.text } }).ok, false, "standing engineering does not invent a workflow baseline");
  assert.equal(evaluate({ ...action, outcome: { ...outcome, quote: "The owner approved all invoice changes." } }).ok, false);
  const approvedChange: Source = { ...baseline, id: "plan:approved-change", text: "Owner approved: replace immediate invoice creation with mandatory check-before-save review and allow staff to correct the listed financial fields before saving." };
  const changeParts: Part[] = [{ key: "Save", question: "Implement the specifically approved check-before-save workflow?", options: ["Implement approved workflow"], effects: {} }];
  const changeOutcome = { scope: "authorized-workflow-change", effects: "Mandatory invoice review before creation under the cited approval", source: approvedChange.id, quote: approvedChange.text };
  const change = { ...action, option: "Implement approved workflow", outcome: changeOutcome };
  const changeCitations = [{ part: "Save", source: engineering.id, quote: engineering.text }, { part: "Save", source: approvedChange.id, quote: approvedChange.text }];
  const checkChange = (current: unknown) => checkVerdict(answer({ selections: { Save: "Implement approved workflow" }, actions: { Save: current }, citations: changeCitations }), changeParts, [...authority, approvedChange]);
  assert.equal(checkChange(change).ok, false, "consequential behavior changes cannot use standing-only activation");
  const specificallyApproved = checkChange({ ...change, authority: "specific" });
  assert.ok(specificallyApproved.ok && !specificallyApproved.standing);
});

test("a boundary-only citation cannot activate standing delegation, and mixed authority retains the empirical gate", () => {
  const authority = standingSources();
  const engineering = authority.find((source) => source.id === "standing-policy:engineering")!;
  const boundaries = authority.find((source) => source.id === "standing-policy:boundaries")!;
  const action = { option: "node:test", actor: "agent", risk: "low", effects: "Local runner only", outcome: TECHNICAL_OUTCOME, integrity: INTACT_INTEGRITY, reason: "Routine engineering", authority: "standing" };
  const boundaryOnly = checkVerdict(answer({ selections: { Runner: "node:test" }, actions: { Runner: action }, citations: [{ source: boundaries.id, quote: boundaries.text }] }), parts, authority);
  assert.equal(boundaryOnly.ok, false);
  const mixedParts = [...parts, { key: "Second", question: "Second runner?", options: ["node:test", "vitest"], effects: {} }];
  const mixed = checkVerdict(answer({
    selections: { Runner: "node:test", Second: "node:test" },
    actions: { Runner: action, Second: { ...action, authority: "specific" } },
    citations: [{ part: "Runner", source: engineering.id, quote: engineering.text }, { part: "Second", source: "plan#2", quote: "Tests use the node:test runner" }],
  }), mixedParts, [...authority, ...sources]);
  assert.ok(mixed.ok && !mixed.standing);
});

test("complete plan constraints and authenticated owner overrides cannot be filtered away by lexical relevance", async () => {
  const hold = "Owner security hold: do not expose the recovery vault.";
  const snapshot = await gatherSources(readers({
    plan: async () => ({ url: "https://linear.app/doc/plan", content: `> **Approved** in Plannotator\n\n## Test runner\nTests use the node:test runner\n\n## Unrelated authority\n${hold}` }),
    rules: async () => [{ id: "agents-md", title: "Repository constraints", text: hold }],
    ownerAnswers: async () => [
      { kind: "question", id: "a0:r0", at: "2026-10-07T09:00:00Z", identifier: "TUC-1", issueId: "i1", questions: [] },
      { kind: "deputy-override", id: "a0:r0", at: "2026-10-07T09:01:00Z", key: "c1", via: "linear-comment", userId: OWNER, text: hold, disposition: "failed" },
    ],
  }), { ...asked, text: "xyzzy" }, null);
  assert.equal(snapshot.abstain, null);
  assert.ok(snapshot.sources.some((source) => source.kind === "plan" && source.text.includes(hold)));
  assert.ok(snapshot.sources.some((source) => source.id === "rules:agents-md" && source.text === hold));
  assert.ok(snapshot.sources.some((source) => source.kind === "owner-answer" && source.text === hold && source.decisive));
  // Well past the evaluator's 250,000-char budget: the guard refuses rather than dropping the hold.
  const oversized = await gatherSources(readers({ plan: async () => ({ url: "https://linear.app/doc/plan", content: `> **Approved** in Plannotator\n${"constraint ".repeat(30_000)}` }) }), asked, null);
  assert.match(oversized.abstain ?? "", /budget/);
  assert.deepEqual(oversized.sources, [], "overflow refuses rather than silently dropping a hold");
});

// The complete live snapshots the previous 40,000 budget refused, measured on the serving host on
// 2026-10-16: 24 of 24 refused questions carried 72,391-182,231 chars, the approved plan up to
// 100,967, the repository's AGENTS.md 10,467, the launch template 7,001 and the standing policy
// 8,893. The budget guards the evaluator's input (gpt-6.1-sol: 500K tokens in), so a complete
// real-sized snapshot must travel whole instead of leaving every ticket with the owner.
const measured = { plan: 100_967, agents: 10_467, template: 7_001 };
const filler = "The planning service sizes each production order from the line's throughput per packaging format. ";
const sized = (prefix: string, chars: number) => `${prefix}${filler.repeat(Math.ceil(chars / filler.length))}`.slice(0, chars);

test("a complete real-sized authority snapshot above the old 40k budget travels whole", async () => {
  const hold = "Owner security hold: do not expose the recovery vault.";
  const plan = sized(`> **Approved** in Plannotator on 2026-10-15 19:33 UTC for TUC-25. Replaced on every review round; the decision comments on the ticket keep the history.\n> **Planned with:** \`omp/test-model\`\n\n---\n\n# TUC-25\n\n## Unrelated authority\n${hold}\n\n`, measured.plan);
  const agents = sized("# Repository instructions\n\nRead every applicable AGENTS.md and run the repository's checked-in tools.\n\n", measured.agents);
  const readme = Array.from({ length: 10 }, (_, index) => `## Test runner ${index}\n\nThe module's tests use the node:test runner.\n`).join("\n");
  const snapshot = await gatherSources(readers({
    plan: async () => ({ url: "https://linear.app/doc/plan", content: plan }),
    rules: async () => [
      { id: "plugin-readme", title: "linear-tickets README", text: readme },
      { id: "launch-template", title: "Launch template (the prompt every ticket agent starts with)", text: sized("Work on Linear ticket {{ticket}} in the current workspace.\n\n", measured.template) },
      { id: "agents-md", title: "AGENTS.md (/repo)", text: agents },
    ],
    recall: async () => Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, text: sized("Remembered context ", 2_400) })),
  }), asked, "/repo/platform");
  const total = snapshot.sources.reduce((sum, source) => sum + source.text.length, 0);
  assert.equal(snapshot.abstain, null, "a complete real-sized snapshot must not refuse");
  assert.ok(total > 40_000, `the regression is anchored to the old budget, got ${total}`);
  const complete = snapshot.sources.find((source) => source.id === "plan:approved")!;
  assert.equal(complete.text.length, measured.plan, "the complete approved plan travels whole");
  assert.ok(complete.text.includes(hold), "a nonmatching hold deep in the plan stays visible");
  assert.equal(snapshot.sources.find((source) => source.id === "rules:agents-md")?.text, agents, "the repository's AGENTS.md travels whole");
  assert.equal(snapshot.sources.find((source) => source.id === "rules:launch-template")?.text.length, measured.template, "the effective launch template travels whole");
  assert.equal(snapshot.sources.filter((source) => source.kind === "memory").length, 5, "every configured blocking-only memory is present");
});

test("the complete-snapshot budget is finite and exact: 250,000 chars pass, one character more fails closed", async () => {
  const budget = 250_000;
  const sizing = (planChars: number, agentsChars: number) => readers({
    plan: async () => ({ url: "https://linear.app/doc/plan", content: sized("> **Approved** in Plannotator\n\n", planChars) }),
    rules: async () => [{ id: "agents-md", title: "Repository constraints", text: sized("# Repository instructions\n\n", agentsChars) }],
  });
  // The plan and the repository instructions are added whole, so the plan size sets the total.
  const base = await gatherSources(sizing(1_000, measured.agents), asked, "/repo/platform");
  const baseTotal = base.sources.reduce((sum, source) => sum + source.text.length, 0);
  const exact = budget - baseTotal + 1_000;
  const at = await gatherSources(sizing(exact, measured.agents), asked, "/repo/platform");
  assert.equal(at.sources.reduce((sum, source) => sum + source.text.length, 0), budget, "the budget is inclusive");
  assert.equal(at.abstain, null);
  const over = await gatherSources(sizing(exact + 1, measured.agents), asked, "/repo/platform");
  assert.match(over.abstain ?? "", /budget/);
  assert.deepEqual(over.sources, [], "one character over refuses rather than dropping a constraint");
});

for (const entry of ["startup", "activation"] as const) {
  test(`${entry} discovers an already-pending exact request without a re-ask, evaluates fresh once and preserves full checked grace`, async t => {
    const h = await standingHarness(t);
    await h.settle();
    assert.deepEqual(await readCandidates(h.directory), {});
    let evaluations = 0;
    const evaluate = h.deps.evaluate;
    h.deps.evaluate = async (...args) => { evaluations++; return evaluate(...args); };
    h.daemon.inventory = true;
    let deputy = h.deputy;
    if (entry === "startup") {
      h.deputy.stop();
      deputy = new Deputy(h.deps);
      t.after(() => deputy.stop());
      deputy.attach(h.paseo);
    } else {
      h.settings.deputy.mode = "off";
      const canceled = await deputy.settingsChanged();
      assert.deepEqual(await deputy.reconcile(), { observed: 0, skipped: 0, failed: 0 });
      h.settings.deputy.mode = "live";
      await deputy.recheckPolicy(canceled, true);
    }
    await Promise.all([deputy.reconcile(), deputy.reconcile(), deputy.reconcile()]);
    await deputy.idle();
    const waiting = (await readCandidates(h.directory))["a1:r1"];
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.version, VERSION);
    assert.equal(waiting.requestId, h.daemon.pending[0].id);
    assert.deepEqual(waiting.request, h.daemon.pending[0]);
    assert.equal(evaluations, 1);
    assert.deepEqual(h.calls, []);
    h.advance(4 * 60_000);
    await deputy.idle();
    assert.deepEqual(h.calls, [], "discovery does not borrow grace from earlier history");
    h.advance(60_000);
    await deputy.idle();
    assert.equal(h.calls.length, 1);
    assert.equal((await readCandidates(h.directory))["a1:r1"].status, "applied");
    await deputy.reconcile();
    await deputy.idle();
    assert.equal(evaluations, 1, "a daemon still listing the request cannot resurrect terminal work");
    assert.equal(h.calls.length, 1);
    assert.equal(shadowEvidence(await h.log.entries(), VERSION).pairs.length, 0);
  });
}

test("startup inventory journals the exact question once and authenticated owner correction remains future source evidence", async t => {
  const h = await standingHarness(t);
  await h.settle();
  h.daemon.inventory = true;
  await Promise.all([h.deputy.reconcile(), h.deputy.reconcile()]);
  await h.settle();
  const entries = await h.log.entries();
  assert.deepEqual(entries.filter(entry => entry.kind === "question").map(entry => ({ ...entry, at: "captured" })), [{
    kind: "question", id: "a1:r1", at: "captured", issueId: "i1", identifier: "TUC-1",
    questions: [
      { key: "Runner", question: "Runner: Which test runner should the new module's tests use?", options: ["node:test", "vitest"] },
      { key: "Comment", question: "Comment: Optional comment", options: [] },
    ],
  }]);
  assert.equal(entries.some(entry => entry.kind === "owner-answer"), false, "inventory is not an owner answer");
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.deputy.correctLate("a1", "r1", "Owner hold: do not switch runners until the current release is complete.", {
    activityId: "owner-correction", via: "linear-comment", userId: OWNER,
  })).delivered, true);
  await h.deputy.reconcile();
  const sources = await gatherSources(readers({ ownerAnswers: () => h.log.entries() }), { ...asked, id: "later-agent:later-request", text: "xyzzy" }, null);
  assert.equal(sources.abstain, null);
  assert.ok(sources.sources.some(source => source.kind === "owner-answer" && source.decisive && source.text === "Owner hold: do not switch runners until the current release is complete."));
  assert.equal((await h.log.entries()).filter(entry => entry.kind === "question").length, 1);
  assert.equal((await h.log.entries()).filter(entry => entry.kind === "owner-answer").length, 0);
});

test("observation and recovery cannot evaluate until persisted owner holds are successfully restored", async t => {
  const h = await standingHarness(t);
  await h.settle();
  const gate = signal();
  let fail = true;
  const deputy = new Deputy({ ...h.deps, ready: async () => { await gate.promise; if (fail) throw new Error("owner hold restore failed"); } });
  t.after(() => deputy.stop());
  deputy.attach(h.paseo);
  const observed = deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  const rejected = assert.rejects(observed, /owner hold restore failed/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(await readCandidates(h.directory), {});
  assert.deepEqual(h.calls, []);
  gate.resolve();
  await rejected;
  await deputy.idle();
  assert.deepEqual(await readCandidates(h.directory), {});
  fail = false;
  await deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await deputy.idle();
  assert.equal((await h.candidate()).status, "waiting");
});

async function standingHarness(t: TestContext, audit = true) {
  const checked = arbiter();
  const h = await harness(t, { mode: "live", standingPolicy: AUTONOMY_POLICY_REVISION }, { arbiter: checked.value });
  h.deps.evaluate = async (input) => {
    const source = input.sources.find((source) => source.id === "standing-policy:engineering")!;
    return checkVerdict(answer({
      selections: { Runner: "node:test" },
      actions: { Runner: { option: "node:test", actor: "agent", risk: "low", effects: "Choose a local behavioral test runner; no production write", outcome: TECHNICAL_OUTCOME, integrity: INTACT_INTEGRITY, reason: "Routine engineering under current standing delegation", authority: "standing" } },
      citations: [{ source: source.id, quote: source.text }],
    }), input.parts, input.sources);
  };
  if (audit) await h.log.append({ kind: "deputy-activation", id: "activation", key: "activation", at: "2026-10-07T09:59:00Z", policy: AUTONOMY_POLICY_REVISION, via: "settings-rpc", mode: "live" });
  return { ...h, calls: checked.calls };
}

test("explicit audited standing activation dispatches only checked standing actions without forging shadow readiness", async (t) => {
  const h = await standingHarness(t);
  assert.equal(shadowEvidence(await h.log.entries(), VERSION).ready, false);
  assert.deepEqual(await h.deputy.liveBlockers(h.settings, true), []);
  assert.notDeepEqual(await h.deputy.liveBlockers(h.settings), [], "specific-authority decisions retain empirical readiness");
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal((await h.candidate()).status, "waiting");
  assert.deepEqual(h.calls, []);
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal((await h.candidate()).status, "applied");
  const applied = (await h.log.entries()).find((entry) => entry.kind === "deputy-answer");
  assert.ok(applied?.kind === "deputy-answer" && applied.activation === AUTONOMY_POLICY_REVISION);
  assert.equal(shadowEvidence(await h.log.entries(), VERSION).ready, false, "a deputy answer is not a real attributed owner pairing");
});

test("standing config alone, an audit alone, and a revoked activation cannot authorize dispatch", async (t) => {
  const h = await standingHarness(t, false);
  assert.notDeepEqual(await h.deputy.liveBlockers(h.settings, true), []);
  for (const policy of ["owner-autonomy-2026-10-15-v1", "owner-autonomy-2026-10-15-v2"]) {
    await h.log.append({ kind: "deputy-activation", id: policy, key: policy, at: "2026-10-07T09:58:00Z", policy, via: "settings-rpc", mode: "live" });
    assert.notDeepEqual(await h.deputy.liveBlockers(h.settings, true), [], "old activation audits cannot authorize the current standing policy");
  }
  await h.log.append({ kind: "deputy-activation", id: "activation", key: "activation", at: "2026-10-07T09:59:00Z", policy: AUTONOMY_POLICY_REVISION, via: "settings-rpc", mode: "live" });
  h.settings.deputy.standingPolicy = null;
  assert.notDeepEqual(await h.deputy.liveBlockers(h.settings, true), []);
  h.settings.deputy.standingPolicy = AUTONOMY_POLICY_REVISION;
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  await h.log.append({ kind: "deputy-activation", id: "revoked", key: "revoked", at: "2026-10-07T10:01:00Z", policy: null, via: "settings-rpc", mode: "live" });
  h.advance(5 * 60_000);
  await h.settle();
  assert.deepEqual(h.calls, []);
  assert.equal((await h.candidate()).status, "blocked");
});

test("standing activation does not bypass selected-action authority or the checked arbiter", async (t) => {
  const h = await standingHarness(t);
  h.deps.evaluate = async (input) => checkVerdict(answer({ selections: { Runner: "node:test" }, citations: [{ source: input.sources.find((source) => source.kind === "plan" && source.decisive)?.id, quote: "Tests use the node:test runner" }] }), input.parts, input.sources);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal((await h.deputy.status()).candidates[0].suppressUrgency, false);
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "blocked");
  assert.deepEqual(h.calls, []);
  const disconnected = new Deputy({ ...h.deps, arbiter: async () => null });
  t.after(() => disconnected.stop());
  assert.notDeepEqual(await disconnected.liveBlockers(h.settings, true), []);
});

test("status exposes the exact raw request and fixed deadlines, and fails open on stale same-ID input", async (t) => {
  const h = await standingHarness(t);
  const started = signal();
  const finish = signal();
  const evaluate = h.deps.evaluate!;
  h.deps.evaluate = async (...args) => { started.resolve(); await finish.promise; return evaluate(...args); };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await started.promise;
  const evaluating = (await h.deputy.status({ agentId: "a1", permissionId: "r1" })).candidates[0];
  assert.equal(evaluating.state, "evaluating");
  assert.equal(evaluating.suppressUrgency, true);
  assert.deepEqual(evaluating.request, question());
  h.advance(149_000);
  const polled = (await h.deputy.status({ agentId: "a1", permissionId: "r1" })).candidates[0];
  assert.equal(polled.expiresAt, evaluating.expiresAt, "polls cannot renew an evaluation lease");
  h.advance(1_001);
  assert.equal((await h.deputy.status()).candidates[0].suppressUrgency, false);
  finish.resolve();
  await h.settle();
  const waiting = (await h.deputy.status()).candidates[0];
  assert.equal(waiting.suppressUrgency, true);
  assert.equal(Date.parse(waiting.expiresAt!), Date.parse((await h.candidate()).graceDeadline!) + 10_000);
  h.daemon.pending = [question("r1", ["node:test", "Changed option"])];
  assert.equal((await h.deputy.status()).candidates[0].suppressUrgency, false);
  assert.deepEqual((await h.deputy.status({ agentId: "other" })).candidates, []);
  assert.deepEqual(h.calls, [], "read-only status neither answers nor reschedules requests");
});

test("notification-only source checking is bounded to fifteen seconds and never claims deputy suppression", async (t) => {
  const h = await standingHarness(t);
  const started = signal();
  const finish = signal();
  h.deps.readers.recall = async () => { started.resolve(); await finish.promise; return []; };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await started.promise;
  assert.equal((await h.deputy.status()).candidates[0].suppressUrgency, false);
  assert.equal(await h.deputy.ownerNotificationDelay("a1", "r1"), 15_000);
  h.advance(15_001);
  assert.equal(await h.deputy.ownerNotificationDelay("a1", "r1"), 0);
  finish.resolve();
  await h.settle();
  h.settings.deputy.mode = "off";
  await h.deputy.settingsChanged();
  assert.equal((await h.deputy.status()).candidates[0].suppressUrgency, false);
  assert.equal(await h.deputy.ownerNotificationDelay("a1", "r1"), 0);
});

test("equivalent reissued questions revoke the old candidate and get fresh evaluation and grace, not a reused answer", async (t) => {
  const h = await liveHarness(t);
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  h.advance(60_000);
  h.daemon.pending = [question("r2")];
  const started = signal();
  const finish = signal();
  const evaluate = h.deps.evaluate!;
  h.deps.evaluate = async (...args) => { started.resolve(); await finish.promise; return evaluate(...args); };
  await h.deputy.observe(h.agent, question("r2"), { issueId: "i1", identifier: "TUC-1" });
  await started.promise;
  const store = await readCandidates(h.directory);
  assert.equal(store["a1:r1"].status, "canceled");
  assert.equal(store["a1:r2"].selections, undefined);
  assert.equal(store["a1:r2"].graceDeadline, undefined);
  finish.resolve();
  await h.settle();
  assert.equal(h.evaluations(), 2);
  h.advance(4 * 60_000);
  await h.settle();
  assert.equal(h.calls.length, 0, "the original grace deadline cannot answer the replacement request");
  h.advance(60_000);
  await h.settle();
  assert.deepEqual(h.calls.map((call) => call.requestId), ["r2"]);
});

for (const pending of ["fresh", "resolved", "changed"] as const) {
  test(`a prior-policy refusal is freshly reevaluated only while its exact request remains pending: ${pending}`, async (t) => {
    const h = await harness(t, { mode: "shadow" });
    const evaluate = h.deps.evaluate!;
    h.deps.evaluate = async () => ({ ok: false, category: "owner-reserved", reason: "Old blanket refusal" });
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await h.settle();
    h.deputy.stop();
    const store = await readCandidates(h.directory);
    store["a1:r1"] = { ...store["a1:r1"], version: "deputy-old", selections: { Runner: "stale answer" }, citations: [], graceDeadline: "2026-10-07T09:00:00Z" };
    await writeFile(join(h.directory, "candidates.json"), JSON.stringify(store));
    if (pending === "resolved") h.daemon.pending = [];
    if (pending === "changed") h.daemon.pending = [question("r1", ["Changed", "Other"])];
    h.deps.evaluate = evaluate;
    const restarted = new Deputy(h.deps);
    t.after(() => restarted.stop());
    restarted.attach(h.paseo);
    await restarted.idle();
    const current = (await readCandidates(h.directory))["a1:r1"];
    if (pending === "fresh") {
      assert.equal(current.status, "predicted");
      assert.deepEqual(current.selections, { Runner: "node:test" });
      assert.equal(current.version, VERSION);
      assert.equal(current.graceDeadline, undefined);
      assert.equal(h.evaluations(), 1);
    } else {
      assert.ok(current.status === "resolved" || current.status === "canceled");
      assert.equal(h.evaluations(), 0);
    }
    assert.deepEqual(h.responses, []);
  });
}

test("exact offered labels are preserved, while visually ambiguous whitespace duplicates are refused", () => {
  assert.equal(assessRisk(question("r", ["Continue", " Continue "]), trusted).ok, false);
  const eligibility = assessRisk(question("r", [" Continue ", "Wait"]), trusted);
  assert.ok(eligibility.ok);
  const source = standingSources().find((source) => source.id === "standing-policy:engineering")!;
  const result = (label: string) => checkVerdict(answer({
    selections: { Runner: label },
    actions: { Runner: { option: label, actor: "agent", risk: "low", effects: "Local bounded technical work", outcome: TECHNICAL_OUTCOME, integrity: INTACT_INTEGRITY, reason: "Standing engineering authority", authority: "standing" } },
    citations: [{ source: source.id, quote: source.text }],
  }), eligibility.parts, [source]);
  assert.equal(result("Continue").ok, false, "the checked answer must not silently rewrite an offered label");
  assert.equal(result(" Continue ").ok, true);
});

test("a current-version shadow prediction is reevaluated after restart into live mode, never silently left parked", async (t) => {
  const h = await standingHarness(t);
  h.settings.deputy.mode = "shadow";
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await h.settle();
  assert.equal((await h.candidate()).status, "predicted");
  h.deputy.stop();
  h.advance(60_000);
  h.settings.deputy.mode = "live";
  const reloaded = new Deputy(h.deps);
  t.after(() => reloaded.stop());
  reloaded.attach(h.paseo);
  await reloaded.idle();
  assert.equal((await h.candidate()).status, "waiting");
  assert.equal((await h.candidate()).mode, "live");
  assert.equal(h.calls.length, 0);
  h.advance(5 * 60_000);
  await reloaded.idle();
  assert.equal((await h.candidate()).status, "applied");
  assert.equal(h.calls.length, 1);
});

for (const phase of ["waiting", "blocked"] as const) {
  test(`explicit standing activation freshly reevaluates ${phase} work after revocation and starts a new grace`, async (t) => {
    const h = await standingHarness(t, false);
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await h.settle();
    const oldGrace = (await h.candidate()).graceDeadline;
    h.advance(phase === "waiting" ? 60_000 : 5 * 60_000);
    await h.settle();
    assert.equal((await h.candidate()).status, phase);
    const revoked = await h.deputy.settingsChanged();
    await h.log.append({ kind: "deputy-activation", id: "new-activation", key: "new-activation", at: new Date(h.deps.now!()).toISOString(), policy: AUTONOMY_POLICY_REVISION, via: "settings-rpc", mode: "live" });
    await h.deputy.recheckPolicy(revoked, true);
    await h.settle();
    assert.equal((await h.candidate()).status, "waiting");
    assert.notEqual((await h.candidate()).graceDeadline, oldGrace);
    h.advance(4 * 60_000);
    await h.settle();
    assert.equal(h.calls.length, 0, "activation cannot reuse an earlier grace or dispatch intent");
    h.advance(60_000);
    await h.settle();
    assert.equal(h.calls.length, 1);
    assert.equal((await h.candidate()).status, "applied");
  });
}

for (const stale of ["resolved", "changed"] as const) {
  test(`policy rechecking cannot revive a ${stale} request canceled during settings changes`, async (t) => {
    const h = await standingHarness(t);
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await h.settle();
    const revoked = await h.deputy.settingsChanged();
    h.daemon.pending = stale === "resolved" ? [] : [{ ...question(), title: "Different same-ID question" }];
    await h.deputy.recheckPolicy(revoked, true);
    await h.settle();
    h.advance(5 * 60_000);
    await h.settle();
    assert.equal(h.calls.length, 0);
    assert.equal((await h.deputy.status()).candidates[0].suppressUrgency, false);
  });
}

for (const pause of ["settings-read", "candidate-lane"] as const) {
  test(`settings revocation retains an in-flight evaluation that self-cancels during ${pause}, then starts fresh grace`, async (t) => {
    const h = await standingHarness(t);
    const evaluating = signal();
    const finish = signal();
    let calls = 0;
    const evaluate = h.deps.evaluate;
    h.deps.evaluate = async (...args) => {
      if (++calls === 1) { evaluating.resolve(); await finish.promise; }
      return evaluate(...args);
    };
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    await evaluating.promise;
    const oldObserved = (await h.candidate()).observedAt;
    h.advance(60_000);
    const readEntered = signal();
    const finishRead = signal();
    if (pause === "settings-read") {
      let reads = 0;
      t.mock.method(h.deps.settings, "read", async () => {
        if (++reads === 1) { readEntered.resolve(); await finishRead.promise; }
        return h.settings;
      });
    } else {
      const candidates = h.deputy.candidates.bind(h.deputy);
      t.mock.method(h.deputy, "candidates", async () => {
        const snapshot = await candidates();
        readEntered.resolve();
        return snapshot;
      });
    }
    const changing = h.deputy.settingsChanged();
    await readEntered.promise;
    finish.resolve();
    await h.settle();
    assert.equal((await h.candidate()).status, "canceled", "the old generation cannot publish its successful model result");
    finishRead.resolve();
    const revoked = await changing;
    assert.ok(revoked.includes("a1:r1"), "self-cancellation must not erase this settings write's restart identity");
    await h.deputy.recheckPolicy(revoked);
    await h.settle();
    const current = await h.candidate();
    assert.equal(calls, 2, "the old successful answer is not reused");
    assert.equal(current.status, "waiting");
    assert.notEqual(current.observedAt, oldObserved);
    assert.equal(Date.parse(current.graceDeadline!), h.deps.now!() + 5 * 60_000);
    h.advance(4 * 60_000);
    await h.settle();
    assert.equal(h.calls.length, 0);
    h.advance(60_000);
    await h.settle();
    assert.equal(h.calls.length, 1);
  });
}

for (const change of ["refusal", "off", "revoke"] as const) {
  test(`urgency status fails open when ${change} occurs during daemon refresh`, async (t) => {
    const h = await standingHarness(t);
    const evaluating = signal();
    const finishEvaluation = signal();
    if (change === "refusal") {
      h.deps.evaluate = async () => {
        evaluating.resolve();
        await finishEvaluation.promise;
        return { ok: false, category: "owner-reserved", reason: "Selected action requires owner authority" };
      };
    }
    await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
    if (change === "refusal") await evaluating.promise;
    else await h.settle();
    const refreshing = signal();
    const finishRefresh = signal();
    const ref = h.paseo.agents.ref.bind(h.paseo.agents);
    t.mock.method(h.paseo.agents, "ref", (id: string) => {
      const handle = ref(id);
      return { ...handle, refresh: async () => { refreshing.resolve(); await finishRefresh.promise; return handle.refresh(); } };
    });
    const pendingStatus = h.deputy.status({ agentId: "a1", permissionId: "r1" });
    await refreshing.promise;
    if (change === "refusal") {
      finishEvaluation.resolve();
      await h.settle();
    } else {
      if (change === "off") h.settings.deputy.mode = "off";
      await h.deputy.settingsChanged();
    }
    finishRefresh.resolve();
    const status = await pendingStatus;
    assert.equal(status.candidates[0].suppressUrgency, false);
    assert.equal(status.candidates[0].expiresAt, null);
    assert.equal(status.candidates[0].state, change === "refusal" ? "refused" : "canceled");
    assert.equal(status.mode, change === "off" ? "off" : "live");
  });
}

test("ordinary reconciliation discovers another request without waiting for an owned evaluator and coalesces inventory", async t => {
  const h = await harness(t, { mode: "shadow" });
  await h.settle();
  const entered = signal();
  const release = signal();
  t.after(() => release.resolve());
  const evaluate = h.deps.evaluate;
  h.deps.evaluate = async (...args) => {
    if (args[0].parts[0].options.includes("vitest")) {
      entered.resolve();
      await release.promise;
    }
    return evaluate(...args);
  };
  await h.deputy.observe(h.agent, question(), { issueId: "i1", identifier: "TUC-1" });
  await entered.promise;
  h.daemon.pending.push(question("r2", ["node:test", "jest"]));
  h.daemon.inventory = true;
  const list = h.paseo.agents.list.bind(h.paseo.agents);
  let inventories = 0;
  t.mock.method(h.paseo.agents, "list", async (...args: Parameters<typeof list>) => {
    inventories++;
    return list(...args);
  });
  const results = await Promise.all([h.deputy.reconcile(), h.deputy.reconcile(), h.deputy.reconcile()]);
  assert.deepEqual(results, Array.from({ length: 3 }, () => ({ observed: 2, skipped: 0, failed: 0 })));
  assert.equal(inventories, 1);
  const pending = await readCandidates(h.directory);
  assert.equal(pending["a1:r1"].status, "evaluating", "the first evaluator is still gated");
  assert.equal(pending["a1:r2"].requestId, "r2", "unrelated pending work was discovered before the first evaluator finished");
  release.resolve();
  await h.settle();
  assert.equal(h.evaluations(), 2, "the owned evaluation was not duplicated by recovery");
  assert.deepEqual(h.responses, []);
});

test("a coalesced reconciliation failure reaches every caller and a repaired hold source can retry", async t => {
  const h = await harness(t, { mode: "shadow" });
  await h.settle();
  h.daemon.inventory = true;
  const entered = signal();
  const release = signal();
  t.after(() => release.resolve());
  h.deps.ready = async () => { entered.resolve(); await release.promise; throw new Error("owner holds unreadable"); };
  const attempts = [h.deputy.reconcile(), h.deputy.reconcile(), h.deputy.reconcile()];
  const outcomes = Promise.allSettled(attempts);
  await entered.promise;
  release.resolve();
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(outcome.reason.message, /owner holds unreadable/);
  }
  assert.deepEqual(await readCandidates(h.directory), {});
  h.deps.ready = async () => {};
  assert.deepEqual(await h.deputy.reconcile(), { observed: 1, skipped: 0, failed: 0 });
  await h.settle();
  assert.equal(h.evaluations(), 1);
  assert.equal((await h.candidate()).status, "predicted");
  assert.deepEqual(h.responses, []);
});

// Reconstructed from the parent's captured TUC-2108 / #5798 facts, not a claim
// that the complete live request or a capable independent reviewer was captured here.
function bundledReview(): AgentPermissionRequest {
  const options = [
    { label: "Agent: gebundener Astra-Recheck (Recommended)", description: "Push head 875b6db8b5; review 65c621fd10..875b6db8b5; record a PASS marker, then CI/enqueue/queue/staging for #5798." },
    { label: "Owner handles release", description: "The owner reviews and approves the release." },
  ];
  return { id: "15a8b43698b1fdd8", provider: "omp", name: "OMP ask", kind: "question",
    title: "#5798 was restacked twice; full release scope and AC18 activation are unavailable.",
    input: { questions: [{ header: "Response", question: "How should the agent proceed?", options, allowOther: true, multiSelect: false }] },
    metadata: { ompAsk: true, answerHeader: "Response", optionLabels: options.map(option => option.label) } };
}

function continuationAnswer(input: EvaluationInput) {
  const source = input.sources.find(source => source.id === "standing-policy:engineering")!;
  return {
    risk: "low", decision: "technical-continuation",
    continuation: { template: TECHNICAL_CONTINUATION_TEMPLATE, step: "Read the local 65c621fd10..875b6db8b5 diff and identify the five conflict-resolution changes without modifying files or dispatching workers.", whyNoSafeOption: "The agent option also commits to an unknown release; the other assigns approval to the owner." } satisfies TechnicalContinuation,
    selections: { Response: TECHNICAL_CONTINUATION },
    actions: { Response: { option: TECHNICAL_CONTINUATION, actor: "agent", risk: "low", effects: "Read-only inspection of existing local diff; no release or marker.", outcome: { scope: "technical", effects: "Findings and a scoped technical reframe, not approval or delivery of #5798." }, integrity: INTACT_INTEGRITY, reason: "Existing read-only engineering authority; no owner hold is released.", authority: "standing" } },
    citations: [{ part: "Response", source: source.id, quote: source.text }],
  };
}

function continuationInput(request = bundledReview()): EvaluationInput {
  const risk = assessRisk(request, trusted);
  assert.ok(risk.ok);
  return { identifier: "TUC-2108", parts: risk.parts, context: request.title ?? "", sources: standingSources(), request };
}

test("a bundled unknown release can receive only the checked literal read-only continuation, not a narrowed offered approval", () => {
  const input = continuationInput();
  const raw = continuationAnswer(input);
  const checked = checkVerdict(JSON.stringify(raw), input.parts, input.sources, input.request);
  assert.ok(checked.ok && checked.continuation);
  assert.deepEqual(checked.selections, { Response: TECHNICAL_CONTINUATION });
  assert.equal(checked.standing, true);
  for (const altered of [
    { ...raw, decision: "answer" },
    { ...raw, selections: { Response: `${TECHNICAL_CONTINUATION} Then enqueue.` } },
    { ...raw, continuation: { ...raw.continuation, template: "approve-release" } },
    { ...raw, continuation: { ...raw.continuation, step: "" } },
    { ...raw, continuation: { ...raw.continuation, whyNoSafeOption: "" } },
    { ...raw, selections: { Response: input.parts[0].options[0] } },
  ]) assert.equal(checkVerdict(JSON.stringify(altered), input.parts, input.sources, input.request).ok, false);
});

test("continuation retains actor, consequence, integrity, and positive authority checks", () => {
  const input = continuationInput();
  const raw = continuationAnswer(input);
  for (const action of [
    { ...raw.actions.Response, actor: "owner" },
    { ...raw.actions.Response, risk: "external-accounts-or-spend", effects: "Launch a paid worker and upload a private diff." },
    { ...raw.actions.Response, outcome: { scope: "new-workflow-choice", effects: "Invent missing tax facts." } },
    { ...raw.actions.Response, outcome: { scope: "unknown", effects: "No useful technical path is established." } },
    { ...raw.actions.Response, integrity: { ...INTACT_INTEGRITY, ownerArtifacts: { state: "violated", reason: "Creates approved-test-change as personal owner approval." } } },
    { ...raw.actions.Response, integrity: { ...INTACT_INTEGRITY, gates: { state: "violated", reason: "TUC-2115 owner stop 84cd05b1 permits exactly one extra review 820ebb01d8..4d4145a41e, failed 279c5405; no further fix/review/paid worker." } } },
  ]) assert.equal(checkVerdict(JSON.stringify({ ...raw, actions: { Response: action } }), input.parts, input.sources, input.request).ok, false);
  assert.equal(checkVerdict(JSON.stringify({ ...raw, citations: [] }), input.parts, input.sources, input.request).ok, false);
  assert.equal(checkVerdict(JSON.stringify(raw), input.parts, input.sources).ok, false, "no inferred provider capability");
});

test("only actual single-part OMP ask custom-answer capability enables continuation", () => {
  const good = bundledReview();
  assert.equal(supportsTechnicalContinuation(good), true);
  const part = questionsOf(good)[0];
  for (const request of [
    { ...good, provider: "unknown" }, { ...good, name: "OMP select" },
    { ...good, metadata: { extensionUiMethod: "editor", answerHeader: "Response" } },
    { ...good, metadata: { ...good.metadata, answerHeader: "Different" } },
    { ...good, metadata: { ...good.metadata, optionLabels: ["forged"] } },
    ...[{ allowOther: false }, { multiSelect: true }, { multiSelect: "true" }, { multiSelect: 1 }, { multiSelect: undefined }, { multiple: "true" }, { header: "Different" }].map(change => ({ ...good, input: { questions: [{ ...part, ...change }] } })),
    { ...good, input: { questions: [{ header: part.header, question: part.question, options: part.options, allowOther: true }] } },
    { ...good, input: { questions: [part, part] } },
    { ...good, input: { questions: [part, null] } },
    { ...good, input: { questions: [{ ...part, options: [{ label: TECHNICAL_CONTINUATION }, { label: "Wait" }] }] }, metadata: { ...good.metadata, optionLabels: [TECHNICAL_CONTINUATION, "Wait"] } },
  ]) {
    assert.equal(supportsTechnicalContinuation(request), false);
    const input = continuationInput();
    assert.equal(checkVerdict(JSON.stringify(continuationAnswer(input)), input.parts, input.sources, request).ok, false);
  }
});

async function continuationHarness(t: TestContext) {
  const request = bundledReview();
  let replies: PermissionReplies;
  const arbiter: PermissionArbiter = { respond: intent => replies.respond(intent), outcome: intentId => replies.outcome(intentId) };
  const h = await harness(t, { mode: "live", standingPolicy: AUTONOMY_POLICY_REVISION }, { pending: [request], arbiter });
  const submitted: unknown[] = [];
  replies = new PermissionReplies({ directory: join(h.directory, "replies"), daemon: async () => ({
    respondToPermissionAndWait: async (_agentId, _requestId, response) => { submitted.push(response); h.daemon.pending = []; },
  }) });
  replies.attach(h.paseo);
  t.after(() => replies.stop());
  h.deps.arbiter = async () => replies;
  h.deps.evaluate = async input => checkVerdict(JSON.stringify(continuationAnswer(input)), input.parts, input.sources, input.request);
  await h.log.append({ kind: "deputy-activation", id: "activation", key: "activation", at: "2026-10-07T09:59:00Z", policy: AUTONOMY_POLICY_REVISION, via: "settings-rpc", mode: "live" });
  const entry = questionEntry(h.agent.id, request, { id: "i1", identifier: "TUC-2108" }, "2026-10-07T10:00:00Z");
  assert.ok(entry);
  await h.log.append(entry);
  return { ...h, request, replies, submitted };
}

test("checked continuation waits full grace, journals truthfully, recovers once, and leaves owner correction available", async t => {
  const h = await continuationHarness(t);
  await h.deputy.observe(h.agent, h.request, { issueId: "i1", identifier: "TUC-2108" });
  await h.settle();
  h.advance(5 * 60_000 - 1);
  await h.settle();
  assert.deepEqual(h.submitted, []);
  h.advance(1);
  await h.settle();
  assert.deepEqual(h.submitted, [{ behavior: "allow", updatedInput: { answers: { Response: TECHNICAL_CONTINUATION } } }]);
  const entries = await h.log.entries();
  const continuation = entries.find(entry => entry.kind === "deputy-continuation");
  assert.ok(continuation?.kind === "deputy-continuation");
  assert.equal(continuation.directive, TECHNICAL_CONTINUATION);
  assert.equal(continuation.fingerprint, fingerprint(h.request));
  assert.equal(continuation.key, (await h.candidate()).intentId);
  assert.equal(entries.some(entry => entry.kind === "deputy-answer" || entry.kind === "owner-answer"), false);
  const status = (await h.deputy.status({ agentId: "a1", permissionId: h.request.id })).candidates[0];
  assert.equal(status.state, "technical-instruction-submitted-editor-unobserved");
  assert.equal(status.suppressUrgency, false);
  assert.match(h.comments[0], /Checked technical instruction submitted/);
  assert.match(h.comments[0], /editor consumption.*unobserved/i);
  assert.doesNotMatch(h.comments[0], /Answered by the deputy/);
  assert.deepEqual(h.sent, []);
  await h.deputy.stop();
  const restarted = new Deputy(h.deps);
  t.after(() => restarted.stop());
  restarted.attach(h.paseo);
  await restarted.reconcile();
  await restarted.idle();
  assert.equal(h.submitted.length, 1);
  assert.equal((await h.log.entries()).filter(entry => entry.kind === "deputy-continuation").length, 1);
  const candidate = (await restarted.candidates())[0];
  assert.equal((await restarted.correct(candidate, "Keep the release blocked.", { via: "menu-bar", activityId: "correction", userId: OWNER })).delivered, true);
  assert.match(h.sent[0], /technical instruction/);
  assert.doesNotMatch(h.sent[0], /on the owner's behalf/);
});

for (const fence of ["owner-hold", "revoked", "metadata", "request", "owner-stop"] as const) {
  test(`technical continuation preserves ${fence} at dispatch`, async t => {
    const h = await continuationHarness(t);
    await h.deputy.observe(h.agent, h.request, { issueId: "i1", identifier: "TUC-2108" });
    await h.settle();
    if (fence === "owner-hold") h.replies.holdForOwner(h.agent.id, h.request.id);
    if (fence === "revoked") { h.settings.deputy.mode = "off"; await h.deputy.settingsChanged(); }
    if (fence === "metadata") h.daemon.pending = [{ ...h.request, metadata: { ...h.request.metadata, ompAsk: false } }];
    if (fence === "request") h.daemon.pending = [{ ...h.request, id: "new-request" }];
    if (fence === "owner-stop") h.deps.readers.ticketHistory = async () => history([{ ...OWNER_COMMENT, body: "TUC-2115 owner stop 84cd05b1: no further fix/review/paid worker after failed 279c5405." }]);
    h.advance(5 * 60_000);
    await h.settle();
    assert.deepEqual(h.submitted, []);
    assert.equal((await kinds(h)).includes("deputy-continuation"), false);
  });
}

test("continuation predictions and daemon echoes earn no empirical or substantive-answer credit", async t => {
  const h = await continuationHarness(t);
  h.settings.deputy.mode = "shadow";
  await h.deputy.observe(h.agent, h.request, { issueId: "i1", identifier: "TUC-2108" });
  await h.settle();
  const candidate = await h.candidate();
  await h.log.append({ kind: "owner-answer", id: candidate.key, key: "owner", at: "2026-10-07T10:01:00Z", via: "menu-bar", userId: OWNER, answers: { Response: TECHNICAL_CONTINUATION } });
  assert.equal(shadowEvidence(await h.log.entries(), VERSION).pairs.length, 0);
  const continuation: LogEntry = { kind: "deputy-continuation", id: candidate.key, at: "2026-10-07T10:05:00Z", identifier: "TUC-2108", issueId: "i1", version: VERSION, key: "intent", fingerprint: candidate.fingerprint, directive: TECHNICAL_CONTINUATION, continuation: continuationAnswer(continuationInput()).continuation, citations: [] };
  const entries: LogEntry[] = [(await h.log.entries()).find(entry => entry.kind === "question")!, continuation,
    { kind: "answer", id: candidate.key, at: "2026-10-07T10:05:00Z", answers: { Response: TECHNICAL_CONTINUATION } }];
  const stats = waitStats(entries, { since: "2026-10-07T10:00:00Z", until: "2026-10-07T11:00:00Z" }, 1);
  assert.deepEqual([stats.resolved, stats.byDeputy, stats.ownerAnswers, stats.unresolved], [0, 0, 0, [candidate.key]]);
  const report = renderReport({ entries, candidates: [], version: VERSION, now: "2026-10-07T11:00:00Z" });
  assert.match(report, /Checked technical instructions submitted: 1/);
  assert.match(report, /Answered by the deputy: 0/);
});

test("an eligible OMP ask still delivers a safe exact option as an ordinary answer, never as a continuation", () => {
  const request = bundledReview();
  const part = questionsOf(request)[0];
  const options = [{ label: "Read existing diff without writes", description: "Inspect the existing local range and report findings only." }, { label: "Owner reviews", description: "The owner performs review." }];
  request.input = { questions: [{ ...part, options }] };
  request.metadata = { ...request.metadata, optionLabels: options.map(option => option.label) };
  const input = continuationInput(request);
  const { continuation: _continuation, ...raw } = continuationAnswer(input);
  const option = options[0].label;
  const result = checkVerdict(JSON.stringify({ ...raw, decision: "answer", selections: { Response: option },
    actions: { Response: { ...raw.actions.Response, option } } }), input.parts, input.sources, request);
  assert.ok(result.ok);
  assert.deepEqual(result.selections, { Response: option });
  assert.equal(result.continuation, undefined);
  const bundled = continuationInput();
  assert.equal(checkVerdict(JSON.stringify({ ...raw, decision: "answer", selections: { Response: bundled.parts[0].options[0] },
    actions: { Response: { ...raw.actions.Response, option: bundled.parts[0].options[0], outcome: { scope: "unknown", effects: "Unknown release and AC18 activation." } } } }),
  bundled.parts, bundled.sources, bundled.request).ok, false);
});

test("persisted continuation template mutation fails closed before checked submission", async t => {
  const h = await continuationHarness(t);
  await h.deputy.observe(h.agent, h.request, { issueId: "i1", identifier: "TUC-2108" });
  await h.settle();
  const candidate = await h.candidate();
  assert.ok(candidate.continuation);
  const file = join(h.directory, "candidates.json");
  const store = JSON.parse(await readFile(file, "utf8"));
  store[candidate.key].continuation.template = "approve-release";
  await writeFile(file, JSON.stringify(store));
  h.advance(5 * 60_000);
  await h.settle();
  assert.deepEqual(h.submitted, []);
  assert.equal((await h.candidate()).status, "canceled");
});

test("interrupted continuation receipt settlement recovers without resubmission and a fresh editor stays independently visible", async t => {
  const h = await continuationHarness(t);
  const append = h.log.append.bind(h.log);
  let blocked = true;
  h.log.append = async entry => {
    if (blocked && entry.kind === "deputy-continuation") throw new Error("journal unavailable after checked receipt");
    return append(entry);
  };
  await h.deputy.observe(h.agent, h.request, { issueId: "i1", identifier: "TUC-2108" });
  await h.settle();
  h.advance(5 * 60_000);
  await h.settle();
  assert.equal((await h.candidate()).status, "dispatching");
  assert.deepEqual(h.submitted, [{ behavior: "allow", updatedInput: { answers: { Response: TECHNICAL_CONTINUATION } } }]);
  h.deputy.stop();
  await h.replies.stop();
  blocked = false;
  const replies = new PermissionReplies({ directory: join(h.directory, "replies"), daemon: async () => ({
    respondToPermissionAndWait: async () => { throw new Error("must not resubmit an applied receipt"); },
  }) });
  replies.attach(h.paseo);
  t.after(() => replies.stop());
  h.deps.arbiter = async () => replies;
  const editor: AgentPermissionRequest = { id: "fresh-editor", kind: "question", provider: "omp", name: "OMP editor", title: "Response",
    input: { questions: [{ header: "Response", question: "Response", options: [], allowOther: true }] }, metadata: { extensionUiMethod: "editor", answerHeader: "Response" } };
  h.daemon.pending = [editor];
  const restarted = new Deputy(h.deps);
  t.after(() => restarted.stop());
  restarted.attach(h.paseo);
  await restarted.reconcile();
  await restarted.idle();
  assert.equal((await readCandidates(h.directory))[`a1:${h.request.id}`]?.status, "applied");
  assert.equal((await h.log.entries()).filter(entry => entry.kind === "deputy-continuation").length, 1);
  await restarted.observe(h.agent, editor, { issueId: "i1", identifier: "TUC-2108" });
  await restarted.idle();
  const current = (await restarted.candidates()).find(candidate => candidate.requestId === editor.id);
  assert.ok(current);
  assert.equal(current.status, "refused");
  assert.equal(current.continuation, undefined);
  assert.equal(current.intentId, undefined);
  assert.deepEqual(h.daemon.pending, [editor]);
  assert.equal((await restarted.status({ agentId: "a1", permissionId: editor.id })).candidates[0].suppressUrgency, false);
  assert.equal(h.submitted.length, 1);
});

test("continuation resolution echoes do not become another question's ticket constraint, even before receipt settlement", async () => {
  const input = continuationInput();
  const id = "a1:previous";
  const question: LogEntry = { kind: "question", id, at: "2026-10-07T09:00:00Z", identifier: "TUC-2108", issueId: "i1",
    questions: [{ key: "Response", question: "Release or owner?", options: ["Ship", "Owner"] }] };
  const echo: LogEntry = { kind: "answer", id, at: "2026-10-07T09:05:00Z", answers: { Response: TECHNICAL_CONTINUATION } };
  const result = await gatherSources(readers({}, [question, echo]), { ...asked, id: "a1:new", identifier: input.identifier, text: "Read the release diff?" }, null);
  assert.equal(result.abstain, null);
  assert.equal(result.sources.some(source => source.id === `resolution:${id}` || source.id === `owner-answer:${id}`), false);
  const stats = waitStats([question, echo], { since: "2026-10-07T09:00:00Z", until: "2026-10-07T10:00:00Z" }, 1);
  assert.deepEqual([stats.resolved, stats.ownerAnswers, stats.unresolved], [0, 0, [id]]);
});

async function persistedLegacyContinuation(t: TestContext, status: Candidate["status"]) {
  const h = await continuationHarness(t);
  await h.settle();
  h.deputy.stop();
  const request = structuredClone(h.request);
  const candidate: Candidate = {
    key: `a1:${request.id}`, ref: "D-15a8b436", agentId: "a1", requestId: request.id,
    issueId: "i1", identifier: "TUC-2108", agentTitle: h.agent.title, cwd: h.agent.cwd,
    request, fingerprint: createHash("sha256").update(JSON.stringify({ kind: request.kind, title: request.title ?? "", description: request.description ?? "", questions: questionsOf(request) })).digest("hex").slice(0, 24),
    mode: "live", observedAt: "2026-10-07T09:00:00Z", updatedAt: "2026-10-07T09:01:00Z",
    status, version: "deputy-17-ticket-own-history/owner-autonomy-2026-10-15-v3/omp/test-model/high",
    reason: "old verdict", refusalCategory: "no-knowledge", eligible: true, standing: true,
    selections: { Response: "Agent: gebundener Astra-Recheck (Recommended)" }, citations: [],
    evidenceFingerprint: "old-evidence", graceDeadline: "2026-10-07T09:05:00Z",
    intentId: "discard-this-unsent-intent",
  };
  await writeFile(join(h.directory, "candidates.json"), JSON.stringify({ [candidate.key]: candidate }));
  h.daemon.inventory = true;
  const restart = () => {
    const deputy = new Deputy(h.deps);
    t.after(() => deputy.stop());
    deputy.attach(h.paseo);
    return deputy;
  };
  return { ...h, legacy: candidate, restart };
}

for (const status of ["refused", "waiting"] as const) {
  test(`legacy fingerprint migration reevaluates persisted ${status} with fresh full grace before checked continuation`, async t => {
    const h = await persistedLegacyContinuation(t, status);
    let evaluations = 0;
    const evaluate = h.deps.evaluate;
    h.deps.evaluate = async (input, model) => {
      evaluations++;
      const cleared = await h.candidate();
      assert.equal(cleared.intentId, undefined);
      assert.equal(cleared.selections, undefined);
      assert.equal(cleared.graceDeadline, undefined);
      assert.notEqual(cleared.evidenceFingerprint, h.legacy.evidenceFingerprint);
      return evaluate(input, model);
    };
    const restarted = h.restart();
    await restarted.reconcile();
    await restarted.idle();
    const fresh = await h.candidate();
    assert.equal(fresh.status, "waiting");
    assert.equal(fresh.version, VERSION);
    assert.equal(fresh.fingerprint, fingerprint(h.request));
    assert.equal(fresh.graceDeadline, "2026-10-07T10:05:00.000Z");
    assert.equal(evaluations, 1);
    h.advance(5 * 60_000 - 1);
    await restarted.idle();
    assert.deepEqual(h.submitted, []);
    h.advance(1);
    await restarted.idle();
    assert.deepEqual(h.submitted, [{ behavior: "allow", updatedInput: { answers: { Response: TECHNICAL_CONTINUATION } } }]);
    assert.notEqual((await h.candidate()).intentId, h.legacy.intentId);
    await restarted.reconcile();
    await restarted.idle();
    assert.equal(h.submitted.length, 1);
    assert.equal(evaluations, 1);
  });
}

for (const change of ["raw-input", "raw-envelope", "metadata", "provider", "gone", "already-answered", "unknown-hash"] as const) {
  test(`legacy fingerprint migration refuses ${change} instead of treating it as an unchanged request`, async t => {
    const h = await persistedLegacyContinuation(t, "waiting");
    if (change === "raw-input") h.daemon.pending = [{ ...h.request, input: { ...h.request.input, undisplayedCapability: true } }];
    if (change === "raw-envelope") h.daemon.pending = [Object.assign({ ...h.request }, { unrecognizedRouting: true })];
    if (change === "metadata") h.daemon.pending = [{ ...h.request, metadata: { ...h.request.metadata, ompAsk: false } }];
    if (change === "provider") h.daemon.pending = [{ ...h.request, provider: "unknown-provider" }];
    if (change === "gone") h.daemon.pending = [];
    if (change === "already-answered") await h.log.append({ kind: "owner-answer", id: h.legacy.key, at: "2026-10-07T09:59:00Z", key: "owner-already-answered", via: "menu-bar", userId: OWNER, answers: { Response: "Keep the release held" } });
    if (change === "unknown-hash") await writeFile(join(h.directory, "candidates.json"), JSON.stringify({ [h.legacy.key]: { ...h.legacy, fingerprint: "unrecognized-hash" } }));
    let evaluations = 0;
    h.deps.evaluate = async () => { evaluations++; throw new Error("must not evaluate changed or unknown legacy request"); };
    const restarted = h.restart();
    await restarted.reconcile();
    await restarted.idle();
    h.advance(10 * 60_000);
    await restarted.idle();
    await restarted.observe(h.agent, h.daemon.pending[0] ?? h.request, { issueId: "i1", identifier: "TUC-2108" });
    await restarted.idle();
    assert.equal(evaluations, 0);
    assert.equal((await h.candidate()).status, ["gone", "already-answered"].includes(change) ? "resolved" : "canceled");
    assert.deepEqual(h.submitted, []);
  });
}

for (const status of ["canceled", "applied", "resolved", "owner-answered", "owner-won", "unknown"] as const) {
  test(`legacy fingerprint migration never resurrects terminal ${status}`, async t => {
    const h = await persistedLegacyContinuation(t, status);
    let evaluations = 0;
    h.deps.evaluate = async () => { evaluations++; throw new Error("terminal candidate must not be reevaluated"); };
    const restarted = h.restart();
    await restarted.reconcile();
    await restarted.idle();
    h.advance(10 * 60_000);
    await restarted.idle();
    assert.equal((await h.candidate()).status, status);
    assert.equal(evaluations, 0);
    assert.deepEqual(h.submitted, []);
  });
}

test("legacy fingerprint migration waits for owner-hold restoration and retains checked owner priority", async t => {
  const h = await persistedLegacyContinuation(t, "waiting");
  const restore = signal();
  let restored = false;
  let evaluations = 0;
  const evaluate = h.deps.evaluate;
  h.deps.ready = async () => { await restore.promise; h.replies.holdForOwner("a1", h.request.id); restored = true; };
  h.deps.evaluate = async (input, model) => { assert.equal(restored, true); evaluations++; return evaluate(input, model); };
  const restarted = h.restart();
  await Promise.resolve();
  assert.equal(evaluations, 0);
  assert.equal((await h.candidate()).fingerprint, h.legacy.fingerprint);
  restore.resolve();
  await restarted.reconcile();
  await restarted.idle();
  assert.equal(evaluations, 1);
  h.advance(5 * 60_000);
  await restarted.idle();
  assert.equal((await h.candidate()).status, "owner-won");
  assert.deepEqual(h.submitted, []);
});
