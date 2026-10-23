import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import { normalizeIssue } from "./context";
import { PullRequestFiles, type PullRequestRead } from "./label-sync";
import { Launcher } from "./launch";
import type { CandidateIssue, DoneIssue, Pages, PlanDocument } from "./linear";
import { CANDIDATE_PULL_REQUEST_READS, CANDIDATE_TTL_MS, composePlan, PRECEDENCE_RULE, relatedWorkDocument, RelatedWork } from "./related-work";
import { DEFAULT_WORKTREE_SHARDS, DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, DEFAULT_WATCHDOG, DEFAULT_STEWARD, DEFAULT_DEPUTY, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { planFootprint } from "../shared/plan-footprint";
import { documentPlanHash, documentPlanText } from "./review-outcome";
import { planSetup } from "./starter";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const pr = (n: number) => `https://github.com/o/r/pull/${n}`;

function candidate(n: number, over: Partial<CandidateIssue> = {}): CandidateIssue {
  return { id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, description: "", updatedAt: "2026-10-14T00:00:00Z", status: "Todo", statusType: "unstarted", labels: [], pullRequests: [], planDocuments: [], ...over };
}

// A Linear fake counting the candidate list's reads; `fail` makes the next read of that kind throw.
function fakeLinear(open: CandidateIssue[], documents: Record<string, { content: string; updatedAt: string }> = {}, done: DoneIssue[] = [], plans: PlanDocument[] = []) {
  const calls = { teamCandidates: [] as string[], doneSince: [] as string[], documentContents: [] as string[][], planDocumentsSince: [] as string[] };
  const fail: { teamCandidates?: boolean; doneSince?: boolean; documentContents?: boolean; planDocumentsSince?: boolean } = {};
  const linear = {
    teamCandidates: async (teamId: string): Promise<Pages<CandidateIssue>> => {
      calls.teamCandidates.push(teamId);
      if (fail.teamCandidates) { fail.teamCandidates = false; throw new Error("Linear unavailable"); }
      return { items: open, complete: true };
    },
    doneSince: async (_teamId: string, since: string): Promise<Pages<DoneIssue>> => {
      calls.doneSince.push(since);
      if (fail.doneSince) throw new Error("HTTP 503");
      return { items: done, complete: true };
    },
    documentContents: async (ids: string[]) => {
      calls.documentContents.push(ids);
      if (fail.documentContents) throw new Error("HTTP 503");
      return new Map(ids.filter((id) => documents[id]).map((id) => [id, documents[id]]));
    },
    planDocumentsSince: async (since: string): Promise<PlanDocument[]> => {
      calls.planDocumentsSince.push(since);
      if (fail.planDocumentsSince) { fail.planDocumentsSince = false; throw new Error("Linear unavailable"); }
      return plans.filter((plan) => plan.updatedAt >= since);
    },
  };
  return { linear, calls, fail };
}

async function pullRequests(t: TestContext, answers: Record<string, PullRequestRead>, now: () => number) {
  const home = await mkdtemp(join(tmpdir(), "paseo-related-work-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const reads: string[] = [];
  const files = new PullRequestFiles(join(home, "pr-files.json"), async (url) => { reads.push(url); return answers[url]; }, now);
  return { files, reads };
}

// The text of one `## ` section of the list, up to the next one.
function section(list: string, heading: string): string {
  const start = list.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `the list has a "${heading}" section`);
  const end = list.indexOf("\n## ", start + 1);
  return list.slice(start + 1, end < 0 ? undefined : end).trim();
}

test("AC-1: the candidate list gives the team's open tickets, approved plans with reach and files, Planning tickets, pull request files and done tickets", async (t) => {
  const open = [
    candidate(1, { description: `Export the ledger.\n\n${"x".repeat(300)}`, labels: ["Area: Sales"], pullRequests: [pr(1), pr(2), pr(3)], planDocuments: [{ id: "d1", title: "Plan: TUC-1", updatedAt: "2026-10-12T09:31:00Z" }] }),
    candidate(2, { status: "Planning", statusType: "started", planDocuments: [{ id: "d2", title: "Plan: TUC-2", updatedAt: "2026-10-13T10:00:00Z" }] }),
    candidate(3, { status: "In Progress", statusType: "started", planDocuments: [{ id: "d3", title: "Plan: TUC-3", updatedAt: "2026-10-02T00:00:00Z" }, { id: "d9", title: "Notes", updatedAt: "2026-10-02T00:00:00Z" }] }),
  ];
  const documents = {
    d1: { updatedAt: "2026-10-12T09:31:00Z", content: "> **Approved** in Plannotator on 2026-10-12 09:30 UTC for TUC-1.\n\n# Plan\n\nChange `server/x.ts`.\n\n## Reach\n\nAlso the CSV export.\n\n## Related work\n\n- TUC-9\n" },
    d2: { updatedAt: "2026-10-13T10:00:00Z", content: "> **Sent back with feedback** in Plannotator on 2026-10-13 10:00 UTC for TUC-2.\n\n# Plan\n\n## Reach\n\nNowhere else.\n" },
    d3: { updatedAt: "2026-10-02T00:00:00Z", content: "> **Approved** in Plannotator on 2026-10-01 for TUC-3.\n\n# Plan\n\nNothing else.\n" },
  };
  const { linear, calls } = fakeLinear(open, documents, [{ id: "i90", identifier: "TUC-90", title: "Shipped export", completedAt: "2026-10-01T08:00:00Z", pullRequests: [], planDocuments: [] }]);
  const { files } = await pullRequests(t, {
    [pr(1)]: { state: "OPEN", files: ["o/r/server/y.ts"], mergedAt: null },
    [pr(2)]: { state: "MERGED", files: ["o/r/server/z.ts"], mergedAt: "2026-10-10T08:00:00Z" },
    [pr(3)]: { state: "CLOSED", files: ["o/r/server/w.ts"], mergedAt: null },
  }, () => NOW);
  const list = await new RelatedWork({ linear, pullRequests: files, now: () => NOW }).candidates("team-1");

  assert.match(list, /^This list covers the team's own tickets \(TUC\); search Linear for other teams' tickets\./);
  assert.ok(list.includes(PRECEDENCE_RULE));
  assert.deepEqual(calls.teamCandidates, ["team-1"]);
  assert.deepEqual(calls.doneSince, ["2026-08-16T12:00:00.000Z"], "done since 60 days before now");
  assert.deepEqual(calls.documentContents, [["d1", "d2", "d3"]], "only the tickets' own plan documents are read");

  const tickets = section(list, "Open tickets").split("\n");
  assert.deepEqual(tickets.slice(0, 2), ["## Open tickets (3)", "Complete."]);
  assert.equal(tickets[2], `- TUC-1 — Ticket 1 — Todo — labels: Area: Sales — Export the ledger. ${"x".repeat(240 - "Export the ledger. ".length)}…`);

  const plans = section(list, "Approved plans");
  assert.equal(plans, [
    "## Approved plans of open tickets, newest approval first (2)",
    "Complete.",
    "### TUC-1 — Ticket 1 (Todo), approved 2026-10-12 09:30 UTC\nRelated-work list: yes, naming TUC-9.\nFiles: `server/x.ts`.\nReach:\n\nAlso the CSV export.",
    "### TUC-3 — Ticket 3 (In Progress), approved 2026-10-01\nRelated-work list: no.\nFiles: none named.\nReach: the plan has no `## Reach` section.",
  ].join("\n\n"), "a plan sent back is not listed");

  assert.equal(section(list, "Tickets in Planning"), "## Tickets in Planning (1)\nComplete.\n- TUC-2 — Ticket 2");
  assert.equal(section(list, "Pull request files"), [
    "## Pull request files of open tickets",
    "Complete.",
    "Pull requests closed without merging are left out.",
    "### Open (1)",
    `- TUC-1 (Todo) ${pr(1)}: \`o/r/server/y.ts\``,
    "### Merged, newest merge first (1)",
    `- TUC-1 (Todo) ${pr(2)}, merged 2026-10-10T08:00:00Z: \`o/r/server/z.ts\``,
  ].join("\n"));
  assert.equal(section(list, "Done in the last"), "## Done in the last 60 days (1)\nComplete.\n- TUC-90 — Shipped export (done 2026-10-01)");
});

test("pull requests past the read limit are listed as not read yet, and a later build reads them", async (t) => {
  let now = NOW;
  const limit = CANDIDATE_PULL_REQUEST_READS;
  const urls = Array.from({ length: limit + 1 }, (_, n) => pr(n + 1));
  const { linear } = fakeLinear([candidate(1, { pullRequests: urls })]);
  const { files, reads } = await pullRequests(t, Object.fromEntries(urls.map((url) => [url, { state: "MERGED", files: ["o/r/a.ts"], mergedAt: "2026-10-01T00:00:00Z" }])), () => now);
  const related = new RelatedWork({ linear, pullRequests: files, now: () => now });

  const first = section(await related.candidates("team-1"), "Pull request files");
  assert.equal(reads.length, limit);
  assert.match(first, /^## Pull request files of open tickets\nIncomplete: 1 pull request is not read yet/);
  assert.ok(first.endsWith(`### Not read yet (1)\n- TUC-1 ${pr(limit + 1)} — not read yet: \`gh pr view ${pr(limit + 1)} --json files\``));

  now += CANDIDATE_TTL_MS + 1;
  const second = section(await related.candidates("team-1"), "Pull request files");
  assert.deepEqual(reads.slice(limit), [pr(limit + 1)], "merged pull requests are not read again");
  assert.match(second, /^## Pull request files of open tickets\nComplete\./);
  assert.match(second, new RegExp(`### Merged, newest merge first \\(${limit + 1}\\)`));
});

test("planners within CANDIDATE_TTL_MS share one build; a failed build is not kept; plan documents are read again only when changed", async (t) => {
  let now = NOW;
  const documents = { d1: { updatedAt: "2026-10-12T00:00:00Z", content: "> **Approved** in Plannotator on 2026-10-12 for TUC-1.\n\n# Plan\n" } };
  const open = [candidate(1, { planDocuments: [{ id: "d1", title: "Plan: TUC-1", updatedAt: "2026-10-12T00:00:00Z" }] })];
  const { linear, calls, fail } = fakeLinear(open, documents);
  const { files } = await pullRequests(t, {}, () => now);
  const related = new RelatedWork({ linear, pullRequests: files, now: () => now });

  const [a, b] = await Promise.all([related.candidates("team-1"), related.candidates("team-1")]);
  now += CANDIDATE_TTL_MS - 1;
  assert.equal(await related.candidates("team-1"), a);
  assert.equal(a, b);
  assert.equal(calls.teamCandidates.length, 1, "one build for every planner within the TTL");

  now += 2;
  fail.teamCandidates = true;
  await assert.rejects(related.candidates("team-1"), /Linear unavailable/);
  assert.match(await related.candidates("team-1"), /## Open tickets \(1\)/, "the next planner builds again");
  assert.equal(calls.teamCandidates.length, 3);
  assert.equal(calls.documentContents.length, 1, "an unchanged plan document is not read again");

  now += CANDIDATE_TTL_MS + 1;
  open[0].planDocuments = [{ id: "d1", title: "Plan: TUC-1", updatedAt: "2026-10-15T00:00:00Z" }];
  fail.documentContents = true;
  fail.doneSince = true;
  const partial = await related.candidates("team-1");
  assert.equal(section(partial, "Approved plans"), "## Approved plans of open tickets, newest approval first (0)\n\nIncomplete: these plan documents could not be read; read them in Linear: Plan: TUC-1.");
  assert.equal(section(partial, "Done in the last"), "## Done in the last 60 days\nIncomplete: could not be read (HTTP 503); search Linear for the team's tickets completed since 2026-08-16.");
});

const ISSUE_ID = "6b1f0c2a-1111-4222-8333-444455556666";
const detail = { issue: normalizeIssue({ id: ISSUE_ID, identifier: "TUC-42", title: "Fix sign-in", url: "https://linear.app/x/issue/TUC-42" }), teamId: "team-1", projectId: "lp-1", context: "{}", warnings: [], relations: { parent: null, subissues: [], related: [] } };
const noMark = { markInProgress: async () => ({ changed: false }), finishedBlockers: async () => [] };
const paseo = {
  projects: { list: async () => ({ projects: [{ projectId: "p1", projectKind: "directory", projectRootPath: "/repo" }] }) },
  workspaces: { create: async () => ({ agents: { create: async (_options: PaseoWorkspaceAgentCreateOptions) => ({ id: "agent-1" }) } }) },
} as unknown as PaseoApi;
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp", launchPreferences: { omp: { model: "omp/opus", modeId: "full" } },
  projectMappings: { "project:lp-1": { projectId: "p1", label: "App", baseBranch: "refs/heads/main" } }, agentLinearAccess: true,
  dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, steward: DEFAULT_STEWARD, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};

test("AC-5/AC-6: every planning launch's context file ends with the team's candidate list from one build; an implementing launch gets none", async (t) => {
  const { linear, calls } = fakeLinear([candidate(7)]);
  const { files } = await pullRequests(t, {}, () => NOW);
  const related = new RelatedWork({ linear, pullRequests: files, now: () => NOW });
  const saved: string[] = [];
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/s.mjs", undefined, async (_id, text) => { saved.push(text); return "/ctx.md"; }, () => true);
  launcher.useCandidates((teamId) => related.candidates(teamId));
  const list = await related.candidates("team-1");
  const plan = { linearAccess: true, env: { LINEAR_TICKETS_PLAN: "required" } };

  let request = 0;
  const requestId = () => `5f6f1154-5838-4439-b981-${String(++request).padStart(12, "0")}`;
  for (const provider of ["omp/opus", "claude/opus", "codex/gpt-5.4"]) {
    await launcher.start({ id: ISSUE_ID, projectId: "p1", provider, instructions: "", markInProgress: false, requestId: requestId() }, paseo, plan);
  }
  await launcher.startPlanner({ runId: "run-1", linearProjectId: "lp-1", projectName: "App", teamId: "team-1", requestId: requestId(), brief: "Plan the work order of App." }, paseo, settings);
  assert.equal(saved.length, 4);
  for (const text of saved) assert.ok(text.endsWith(`\n\n# Candidate list\n\n${list}`), "the planner reads the list from its context file");
  assert.deepEqual(calls.teamCandidates, ["team-1"], "one build for the ticket planners and the project planner");

  saved.length = 0;
  await launcher.start({ id: ISSUE_ID, projectId: "p1", provider: "omp/opus", instructions: "", markInProgress: false, requestId: requestId() }, paseo, { linearAccess: true });
  assert.equal(saved.length, 1);
  assert.ok(!saved[0].includes("# Candidate list"), "an implementer gets no candidate list");
});

test("a candidate list that cannot be built warns and tells the planner to search Linear instead", async () => {
  const saved: string[] = [];
  const launcher = new Launcher({ ...noMark, detail: async () => detail }, undefined, async () => "/s.mjs", undefined, async (_id, text) => { saved.push(text); return "/ctx.md"; }, () => true);
  launcher.useCandidates(async () => { throw new Error("Linear unavailable"); });
  const result = await launcher.start({ id: ISSUE_ID, projectId: "p1", provider: "omp/opus", instructions: "", markInProgress: false, requestId: "5f6f1154-5838-4439-b981-b3c9d9831400" }, paseo, { linearAccess: true, env: { LINEAR_TICKETS_PLAN: "required" } });
  assert.equal(result.agentId, "agent-1");
  assert.ok(result.warnings.includes("Could not build the candidate list of related work: Linear unavailable"));
  assert.ok(saved[0].endsWith("# Candidate list\n\nThe candidate list could not be built (Linear unavailable). Search Linear's open tickets and those done in the last 60 days for related work instead."));
});

test("AC-19: an old approved plan is read with its catch-up document while that one covers it, and without it after a new approval", async (t) => {
  const approved = `> **Approved** in Plannotator on 2026-10-12 09:30 UTC for TUC-1.

# Plan

Change \`server/x.ts\`.

## Model

- Tier: cheap — one file
- Strong steps: none — routine
- Acceptance tests: none — no test seam
`;
  const analysis = "### TUC-4 — it changes the same file\n\n- TUC-4 — related: it changes the same file.\n- TUC-9 blocks TUC-1: it lands first.";
  const reach = "- `server/z.ts`: include — AC-2, its export path.\n- `server/y.ts`: include — AC-3, the label.";
  const annotation = relatedWorkDocument({ planHash: documentPlanHash(approved), section: analysis, catchUp: "TUC-8", approvedAt: "2026-10-15T09:00:00.000Z", reach });
  const open = [candidate(1, { planDocuments: [
    { id: "d1", title: "Plan: TUC-1", updatedAt: "2026-10-12T09:31:00Z" },
    { id: "d10", title: "Related work: TUC-1", updatedAt: "2026-10-15T09:01:00Z" },
  ] })];
  const documents: Record<string, { content: string; updatedAt: string }> = {
    d1: { content: approved, updatedAt: "2026-10-12T09:31:00Z" },
    d10: { content: annotation, updatedAt: "2026-10-15T09:01:00Z" },
  };
  const tuc2Plan = "> **Approved** in Plannotator on 2026-10-10 08:00 UTC for TUC-2.\n\n# Plan\n\nTouch `server/y.ts`.\n";
  const plans: PlanDocument[] = [{
    id: "d1", title: "Plan: TUC-1", url: "https://linear.app/doc/d1", content: approved, updatedAt: "2026-10-12T09:31:00Z",
    issue: { id: "i1", identifier: "TUC-1", url: "https://linear.app/x/issue/TUC-1", project: "App" }, relatedWork: annotation,
  }];
  const { linear, calls } = fakeLinear(open, documents, [], plans);
  const { files } = await pullRequests(t, {}, () => NOW);
  const related = new RelatedWork({ linear, pullRequests: files, now: () => NOW });

  // The catch-up's eligibility reads the plan's own hash, block and reach, and the composed plan.
  const [info] = await related.approvedPlans("team-1");
  assert.equal(info.identifier, "TUC-1");
  assert.equal(info.planHash, documentPlanHash(approved));
  assert.equal(info.hasBlock, false, "the old plan has no related-work block of its own");
  assert.equal(info.hasReach, false, "and no Reach of its own: the catch-up's is composed in");
  assert.match(info.plan, /TUC-4 — related: it changes the same file\./);
  assert.deepEqual(calls.documentContents.at(-1), ["d1", "d10"], "the catch-up document is read with the plan it covers");

  // The candidate list shows TUC-1's related-work list: its tickets, its files, its reach.
  const plansSection = section(await related.candidates("team-1"), "Approved plans");
  assert.match(plansSection, /Related-work list: yes, naming TUC-4, TUC-9\./);
  assert.match(plansSection, /Files: `server\/x\.ts`, `server\/z\.ts`, `server\/y\.ts`\./);
  assert.match(plansSection, /Reach:\n\n- `server\/z\.ts`: include — AC-2/);

  const composed = planFootprint(composePlan(approved, annotation), "TUC-1");
  assert.deepEqual(composed.tickets, ["TUC-4", "TUC-9"]);
  assert.deepEqual(composed.places, ["`server/z.ts`", "`server/y.ts`"]);

  // TUC-2's plan names a file only the catch-up's reach named for TUC-1.
  const changed = await related.changedSince({ issueId: "i2", identifier: "TUC-2", teamId: "team-1", plan: documentPlanText(tuc2Plan), approved: tuc2Plan });
  assert.deepEqual(changed, [{
    kind: "approved", identifier: "TUC-1", status: "Todo", approvedAt: Date.parse("2026-10-12T09:30:00Z"), completedAt: null,
    overlap: { files: ["server/y.ts"], places: [], tickets: [], namesOther: false },
  }]);
  plans[0] = { ...plans[0], relatedWork: undefined };
  assert.deepEqual(await related.changedSince({ issueId: "i2", identifier: "TUC-2", teamId: "team-1", plan: documentPlanText(tuc2Plan), approved: tuc2Plan }), [], "without the catch-up the old plan names no server/y.ts");

  // What the implementing agent reads: the approved plan plus the analysis.
  const setup = await planSetup({
    issueCore: async () => ({ id: "i1", identifier: "TUC-1", creatorId: "owner-1", status: "Todo", statusType: "unstarted", teamId: "team-1", labels: [{ id: "l1", name: "plan-ready" }] }) as never,
    viewerId: async () => "owner-1",
    trustedAppIds: async () => [],
    issueDocument: async (_id: string, title: string) => ({ url: `https://linear.app/doc/${title.startsWith("Plan: ") ? "d1" : "d10"}`, content: title.startsWith("Plan: ") ? approved : annotation }),
  } as never, "i1", "omp/opus", undefined, {});
  assert.equal(setup.policy, null, "an approved plan is implemented");
  const note = setup.notes.find((entry) => entry.startsWith("The owner already approved a plan")) ?? "";
  assert.match(note, /TUC-4 — related: it changes the same file\./);
  assert.match(note, /`server\/y\.ts`: include/);

  // TUC-1 approved again: the document covers the older hash and is ignored by every reader.
  const reapproved = "> **Approved** in Plannotator on 2026-10-16 08:00 UTC for TUC-1.\n\n# Plan\n\nChange `server/x2.ts`.\n";
  documents.d1 = { content: reapproved, updatedAt: "2026-10-16T08:01:00Z" };
  open[0].planDocuments = [
    { id: "d1", title: "Plan: TUC-1", updatedAt: "2026-10-16T08:01:00Z" },
    { id: "d10", title: "Related work: TUC-1", updatedAt: "2026-10-15T09:01:00Z" },
  ];
  plans[0] = { ...plans[0], content: reapproved, updatedAt: "2026-10-16T08:01:00Z" };
  const again = new RelatedWork({ linear, pullRequests: files, now: () => NOW });
  const stale = section(await again.candidates("team-1"), "Approved plans");
  assert.match(stale, /Related-work list: no\./);
  assert.doesNotMatch(stale, /TUC-4|server\/y\.ts|server\/z\.ts/, "the new plan carries no related-work list, and the stale document adds none");
  assert.deepEqual(planFootprint(composePlan(reapproved, annotation), "TUC-1").tickets, []);
  assert.deepEqual(await again.changedSince({ issueId: "i2", identifier: "TUC-2", teamId: "team-1", plan: documentPlanText(tuc2Plan), approved: tuc2Plan }), [], "the re-approved plan names no server/y.ts either");
});
