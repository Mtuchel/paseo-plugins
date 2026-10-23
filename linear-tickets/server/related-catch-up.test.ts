import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { DEFAULT_AUTO_APPROVE, combinedRating, parsePlanRisk, sectionBody } from "../shared/plan-risk";
import { modelProblem } from "../shared/plan-model";
import { parsePlanSections } from "../shared/plan-sections";
import { layoutProblem } from "../shared/plan-layout";
import { RELATED_WORK_TAG, blockLines, parseBlock } from "../shared/work-order";
import { type ApprovedPlanInfo, type ChangedSinceEntry, type ChangedSinceQuery, relatedWorkHeader } from "./related-work";
import type { RelationsOutcome } from "./plan-relations";
import {
  CatchUpStore, RelatedCatchUp, catchUpBrief, catchUpSections,
  type CatchUpListed, type CatchUpState, type RelatedCatchUpDeps,
} from "./related-catch-up";
import { documentPlanHash, documentPlanText, planHash } from "./review-outcome";
import {
  DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_STEWARD, DEFAULT_WATCHDOG,
  DEFAULT_WORKTREE_SHARDS, DEFAULT_WRITEBACK, type PluginSettings,
} from "./settings";

const OWNER = "owner-1";
const APP = "paseo-app";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TEAM = "t1";

const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: "omp",
  launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["TUC"] }, writeback: DEFAULT_WRITEBACK,
  watchdog: DEFAULT_WATCHDOG, steward: DEFAULT_STEWARD, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [],
  activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};

type Agent = { id: string; status: string; labels: Record<string, string>; createdAt?: string };
const paseoOf = (agents: Agent[]) => ({ agents: {
  list: async ({ filter }: { filter: { labels: Record<string, string> } }) => {
    const [key, value] = Object.entries(filter.labels)[0] ?? [];
    return { entries: agents.filter((agent) => key !== undefined && agent.labels[key] === value).map((agent) => ({ agent })), pageInfo: { hasMore: false } };
  },
  ref: (id: string) => ({ archive: async () => {}, refresh: async () => ({ agent: agents.find((agent) => agent.id === id) ?? null }) }),
} }) as unknown as PaseoApi;

type FakeIssue = { id: string; identifier: string; title: string; status: string; statusType: string; creatorId: string; labels: { id: string; name: string }[] };
type FakeDocument = { title: string; content: string; url: string };
type RelationsRequest = Parameters<NonNullable<RelatedCatchUpDeps["relations"]["file"]>>[0];

// An old approved plan of a listed ticket: valid for its own gate except TUC-3's, which predates
// the `## Reach` section (the catch-up's section then carries the reach list).
const oldPlan = (identifier: string, { reach = true } = {}) => [
  `# Plan: ${identifier}`,
  "",
  "1. Keep the column in the report.",
  "",
  ...(reach ? ["## Reach", "", "- Changes: the report", "- server/x.ts: include — AC-1", ""] : []),
  "## Principles and rules",
  "",
  "- Applies: report rules",
  "- Exceptions: none",
  "- New rule: none — no rule changes",
  "",
  "## Verification",
  "",
  "- AC-1: the report keeps the column",
  "",
  "## Model",
  "",
  "- Tier: cheap — a small edit",
  "- Strong steps: none — a small edit",
  "- Acceptance tests: none — no test file proves a column",
  "",
  "## Risk and impact",
  "",
  "- Areas: Reports",
  "- Processes: n/a — read-only report",
  "- Impact: 1 — read-only",
  "- Reversibility: revert — a revert restores it",
  "- Feature flag: no — nothing is enabled",
  "- Migration: no",
  "- Auth: no",
  "- New rule: no — no rule changes",
  "- Failure mode: the column disappears; we notice in the report",
  "- Advisor rating: unavailable",
  "- Recommendation: auto",
  "",
].join("\n");

const planDocument = (identifier: string, body: string, approved = "2026-01-05 10:00") =>
  `<!-- linear-tickets: plan -->\n> **Approved** by the owner on ${approved} UTC\n\n${body}\n`;

const VERDICT_HOLDS = "**Verdict: holds** — nothing it relies on changed.";
const sectionOf = (identifier: string, verdict: string, block: string, reach?: string) => [
  `### ${identifier}`,
  "",
  verdict,
  "",
  ...(reach ? ["#### Reach", "", reach, ""] : []),
  "```related-work",
  block,
  "```",
].join("\n");

const S1 = sectionOf("TUC-1", VERDICT_HOLDS, "TUC-1 blocks TUC-4");
const S2 = sectionOf("TUC-2", "**Verdict: replan** — TUC-9 replaced its step.", "replan TUC-2: TUC-9 replaced its step");
const S3 = sectionOf("TUC-3", VERDICT_HOLDS, "", "- report: include");
// The part headings of the owner's planning instructions on the hosts (README, "Plan-first").
const PARTS = ["# Part 1 — Overview", "# Part 2 — Implementation"];

const catchUpPlan = (...sections: string[]) => [
  PARTS[0],
  "",
  "Catches up the related work of older approved plans.",
  "",
  PARTS[1],
  "",
  "## Reach",
  "",
  "- Changes: the related work recorded for older approved plans",
  "- The listed tickets' documents, links and replan requests: include — AC-1",
  "- Other tickets: n/a — only the listed tickets are written",
  "",
  "## Principles and rules",
  "",
  "- Applies: the related-work rules of ticket plans",
  "- Exceptions: none",
  "- New rule: none — it applies existing rules",
  "",
  "## Verification",
  "",
  "- AC-1: Paseo's summary lists every listed ticket as applied or skipped, with the reason",
  "",
  "## Model",
  "",
  "- Tier: strong — the plan changes no code",
  "- Strong steps: none — nothing is implemented",
  "- Acceptance tests: none — the plan changes no code",
  "",
  "## Risk and impact",
  "",
  "- Areas: Agent tooling",
  "- Processes: n/a — no business process changes",
  "- Impact: 2 — it writes links and replan requests on other tickets",
  "- Reversibility: data-fix — written links stay",
  "- Feature flag: no — nothing is enabled",
  "- Migration: no",
  "- Auth: no",
  "- New rule: no — it applies existing rules",
  "- Failure mode: a wrong link stays until the owner removes it",
  "- Advisor rating: unavailable",
  "- Recommendation: owner",
  "",
  "## Listed tickets",
  "",
  ...sections,
  "",
].join("\n");

// One team's fake Linear, relations record, run store and the catch-up over them.
async function room(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "related-catch-up-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-01-10T00:00:00Z");
  const issues = new Map<string, FakeIssue>();
  const documents = new Map<string, FakeDocument[]>();
  const comments: { issueId: string; body: string; id?: string }[] = [];
  const creates: { id?: string; teamId: string; title: string; description: string }[] = [];
  const completed: string[] = [];
  const calls: string[] = [];
  const approvals: ApprovedPlanInfo[] = [];
  const changes = new Map<string, ChangedSinceEntry[]>();
  const queries: ChangedSinceQuery[] = [];
  const agents: Agent[] = [];
  const starts: { issueId: string; brief: string }[] = [];
  const sessions: string[] = [];
  const archived: string[] = [];
  const parked = new Set<string>();
  const fail = { document: 0, comment: 0, create: 0, start: 0 };

  // `failing`: how many `file` rounds of that record are refused before it writes.
  const relations = (() => {
    const calls: RelationsRequest[] = [];
    const records = new Map<string, { hash: string; lines: string[]; done: Set<string>; rounds: number; stopped?: "gave-up" }>();
    const failing = new Map<string, number>();
    const writes: string[] = [];
    return {
      calls, records, writes, failing,
      file: async (request: RelationsRequest): Promise<void> => {
        calls.push(request);
        const id = request.recordId ?? request.issueId;
        const seeded = records.get(id);
        const record = seeded ?? { hash: "", lines: [], done: new Set<string>(), rounds: 0 };
        records.set(id, record);
        const hash = planHash(request.plan);
        if (record.hash !== hash) {
          // A revised section: the same line keeps its done state, a line it no longer lists is dropped.
          record.lines = [];
          record.hash = hash;
        }
        record.stopped = undefined;
        record.rounds++;
        for (const line of blockLines(parseBlock(request.plan, RELATED_WORK_TAG) ?? "")) {
          if (!record.lines.includes(line)) record.lines.push(line);
        }
        const refused = failing.get(id) ?? 0;
        if (record.rounds <= refused) {
          if (record.rounds === refused) record.stopped = "gave-up";
          return;
        }
        for (const line of record.lines) {
          if (record.done.has(line)) continue;
          record.done.add(line);
          writes.push(`${request.identifier}: ${line}`);
        }
      },
      outcome: async (id: string): Promise<RelationsOutcome> => {
        const record = records.get(id);
        if (!record) return { status: "pending" };
        if (record.stopped) return { status: "stopped", reason: record.stopped };
        return record.lines.every((line) => record.done.has(line)) ? { status: "done" } : { status: "pending" };
      },
    };
  })();

  const linear: RelatedCatchUpDeps["linear"] = {
    teamIdByKey: async (key: string) => { calls.push(`teamIdByKey ${key}`); return key === "TUC" ? TEAM : null; },
    issueCore: async (id: string) => {
      calls.push(`issueCore ${id}`);
      const issue = issues.get(id);
      if (!issue) throw new Error(`Linear did not return ${id}.`);
      return { id: issue.id, identifier: issue.identifier, status: issue.status, statusId: "s1", statusType: issue.statusType, teamId: TEAM, projectId: null, creatorId: issue.creatorId, labels: issue.labels, attachmentUrls: [] };
    },
    issueDocument: async (issueId: string, title: string) => {
      calls.push(`issueDocument ${issueId} ${title}`);
      const found = documents.get(issueId)?.find((document) => document.title === title);
      return found ? { url: found.url, content: found.content } : null;
    },
    upsertDocumentAsApp: async (issueId: string, title: string, content: string) => {
      calls.push(`document ${issueId} ${title}`);
      if (fail.document > 0) { fail.document--; return null; }
      const list = documents.get(issueId) ?? [];
      const found = list.find((document) => document.title === title);
      if (found) found.content = content;
      else list.push({ title, content, url: `https://linear.app/doc/${issueId}-${list.length + 1}` });
      documents.set(issueId, list);
      calls.push(`wrote-document ${issueId} ${title}`);
      return (list.find((document) => document.title === title) ?? list[list.length - 1]).url;
    },
    commentAsApp: async (issueId: string, body: string, id?: string) => {
      calls.push(`comment ${issueId}`);
      if (fail.comment > 0) { fail.comment--; return null; }
      if (id && comments.some((comment) => comment.id === id)) return true;
      comments.push({ issueId, body, ...(id ? { id } : {}) });
      return true;
    },
    createIssueAsApp: async (input: { teamId: string; title: string; description: string }) => {
      calls.push(`create ${input.title}`);
      if (fail.create > 0) { fail.create--; return null; }
      creates.push(input);
      const issue: FakeIssue = { id: `c${creates.length}`, identifier: `TUC-${89 + creates.length}`, title: input.title, status: "Todo", statusType: "unstarted", creatorId: APP, labels: [] };
      issues.set(issue.id, issue);
      return { id: issue.id, identifier: issue.identifier, url: `https://linear.app/tuc/issue/${issue.identifier}` };
    },
    complete: async (issueId: string) => {
      calls.push(`complete ${issueId}`);
      const issue = issues.get(issueId);
      if (issue) { issue.status = "Done"; issue.statusType = "completed"; }
      completed.push(issueId);
    },
    viewerId: async () => OWNER,
    trustedAppIds: async () => [APP],
  };

  const related: RelatedCatchUpDeps["related"] = {
    approvedPlans: async () => [...approvals].sort((left, right) => right.approvedAt.localeCompare(left.approvedAt)),
    changedSince: async (query: ChangedSinceQuery) => { queries.push(query); return changes.get(query.identifier) ?? []; },
  };

  const storePath = join(directory, "related-catch-up.json");
  const store = new CatchUpStore(storePath);
  const paseo = paseoOf(agents);
  const catchUp = new RelatedCatchUp({
    linear, related, relations,
    startTicket: async (issueId: string, _paseo: PaseoApi, _settings: PluginSettings, options: { retryHint: string; lead: string }) => {
      starts.push({ issueId, brief: options.lead });
      if (fail.start > 0) { fail.start--; throw new Error("the launch failed"); }
      const agentId = `agent-${agents.length + 1}`;
      agents.push({ id: agentId, status: "running", labels: { "linear.issueId": issueId }, createdAt: new Date(now).toISOString() });
      return { agentId };
    },
    openSession: async (issueId: string, identifier: string) => { sessions.push(`${issueId} ${identifier}`); return true; },
    retire: async (agentId: string) => { archived.push(agentId); },
    paseo: () => paseo,
    parked: { has: async (issueId: string) => parked.has(issueId) },
    store,
    now: () => now,
  });

  const add = (n: number, change: Partial<FakeIssue> = {}) => {
    const issue: FakeIssue = { id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, status: "Todo", statusType: "unstarted", creatorId: OWNER, labels: [], ...change };
    issues.set(issue.id, issue);
    return issue;
  };
  const approve = (n: number, body: string, approved = "2026-01-05 10:00") => {
    if (!issues.has(`i${n}`)) add(n);
    const content = planDocument(`TUC-${n}`, body, approved);
    documents.set(`i${n}`, [{ title: `Plan: TUC-${n}`, content, url: `https://linear.app/doc/plan-${n}` }]);
    const text = documentPlanText(content);
    const plan: ApprovedPlanInfo = {
      issueId: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, status: "Todo", statusType: "unstarted",
      approvedAt: `${approved.replace(" ", "T")}:00.000Z`, planHash: documentPlanHash(content),
      hasBlock: parseBlock(text, RELATED_WORK_TAG) !== null, hasReach: sectionBody(text, "Reach") !== null, plan: text,
    };
    approvals.push(plan);
    return plan;
  };
  const state = async (): Promise<CatchUpState | null> => store.team(TEAM);
  const tick = async (advance = 6 * MINUTE) => { now += advance; await catchUp.tick(paseo, settings); };
  // The catch-up ticket filed last; a test that expects one fails here when none was filed.
  const catchUpIssue = () => {
    const issue = issues.get(`c${creates.length}`);
    assert.ok(issue, "a catch-up ticket was filed");
    return issue;
  };
  const writePlan = async (runId: string, plan: string) => {
    documents.set(runId, [{ title: "Plan: TUC-90", content: planDocument("TUC-90", plan), url: "https://linear.app/doc/plan-90" }]);
    await catchUp.opened(runId);
  };
  return {
    catchUp, store, storePath, linear, related, relations, issues, documents, comments, creates, completed, calls,
    approvals, changes, queries, agents, starts, sessions, archived, parked, fail, state, tick,
    add, approve, catchUpIssue, writePlan,
    now: () => now, setNow: (value: number) => { now = value; },
  };
}

test("filing lists the eligible older plans once, oldest approval first", async (t) => {
  const r = await room(t);
  // Newest approval first, as RelatedWork returns them.
  r.approve(4, oldPlan("TUC-4").replace("## Reach", "```related-work\nTUC-4 blocks TUC-9\n```\n\n## Reach"));
  const seventh = r.approve(7, oldPlan("TUC-7").replace("## Verification", "## Work order\n\n```project-order\nTUC-1 blocks TUC-2\n```\n\n## Verification"));
  r.approve(3, oldPlan("TUC-3", { reach: false }), "2026-01-03 09:00");
  r.approve(2, oldPlan("TUC-2"), "2026-01-02 09:00");
  r.approve(1, oldPlan("TUC-1"), "2026-01-01 09:00");
  const covered = r.approve(8, oldPlan("TUC-8"), "2026-01-04 09:00");
  await r.store.update(TEAM, () => ({ planner: null, lastClosed: null, closedIds: [], covered: { i8: { planHash: covered.planHash, outcome: "applied" } } }));
  r.add(5, { status: "Done", statusType: "completed" });

  await r.tick();

  assert.equal(r.creates.length, 1, "exactly one catch-up ticket is filed");
  assert.equal(r.creates[0].title, "Catch up the related work of 3 approved plans");
  const brief = r.creates[0].description;
  assert.ok(brief.includes("### TUC-1 — Ticket 1 (Todo), approved 2026-01-01T09:00"), "the oldest approval comes first");
  assert.ok(brief.indexOf("### TUC-1") < brief.indexOf("### TUC-2") && brief.indexOf("### TUC-2") < brief.indexOf("### TUC-3"));
  for (const missing of ["### TUC-4", "### TUC-7", "### TUC-8", "### TUC-5"]) assert.ok(!brief.includes(missing), `${missing} is not listed`);
  assert.ok(!r.calls.some((call) => call.startsWith("create ") && call.includes("TUC-7")), "a work order is not a ticket plan");
  assert.ok(r.starts.length === 1 && r.sessions.length === 1, "the catch-up's own agent starts, with its thread");
  const filed = await r.state();
  assert.equal(filed?.planner?.identifier, "TUC-90");
  assert.deepEqual(filed?.planner?.listed, ["i1", "i2", "i3"], "listed oldest approval first");
  assert.equal(filed?.planner?.state, "planning");
  assert.equal(filed?.planner?.agentId, "agent-1");

  await r.tick();
  assert.equal(r.creates.length, 1, "a second tick files no second ticket");
  assert.equal(r.starts.length, 1, "and starts no second agent");
});

test("a failed start is retried and never files a second ticket", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  r.fail.start = 1;

  await r.tick();
  assert.equal(r.creates.length, 1);
  assert.equal(r.starts.length, 1);
  assert.equal((await r.state())?.planner?.agentId, undefined, "no agent was recorded");

  await r.tick(11 * MINUTE);
  assert.equal(r.creates.length, 1, "the retry files nothing new");
  assert.equal(r.starts.length, 2);
  assert.equal((await r.state())?.planner?.agentId, "agent-1");
});

test("the run is never restarted while it waits for review or while it is parked", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  await r.tick();
  const issueId = r.catchUpIssue().id;

  await r.catchUp.opened(issueId);
  await r.catchUp.opened(issueId);
  assert.equal((await r.state())?.planner?.state, "awaiting-review");
  await r.tick(11 * MINUTE);
  assert.equal(r.starts.length, 1, "a plan in review is not restarted");

  await r.catchUp.sentBack(issueId);
  assert.equal((await r.state())?.planner?.state, "planning");
  r.agents[0].status = "closed";
  r.parked.add(issueId);
  await r.tick(11 * MINUTE);
  assert.equal(r.starts.length, 1, "a parked catch-up is not restarted");

  r.parked.delete(issueId);
  await r.tick(11 * MINUTE);
  assert.equal(r.starts.length, 2, "an unparked run whose agent stopped plans again");
  assert.ok(r.catchUp.isCatchUp(issueId));
});

test("the owner closing the catch-up declines it, and the next one waits seven days", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  await r.tick();
  const issue = r.catchUpIssue();
  const issueId = issue.id;
  issue.statusType = "completed";

  await r.tick(6 * MINUTE);
  const state = await r.state();
  assert.equal(state?.planner, null, "the open record is cleared");
  assert.equal(state?.lastClosed?.outcome, "declined");
  assert.deepEqual(state?.closedIds, [issueId]);
  assert.ok(r.archived.includes("agent-1"), "its agent is retired");
  assert.ok(await r.catchUp.isCatchUp(issueId), "a closed catch-up is still routed as one");

  r.approve(9, oldPlan("TUC-9"), "2026-01-09 09:00");
  await r.tick(6 * MINUTE);
  assert.equal(r.creates.length, 1, "not before seven days");
  await r.tick(7 * DAY);
  assert.equal(r.creates.length, 2, "a week later the eligible plans are listed again");
});

test("an applied catch-up covers its plans, waits a day, and lists one approved again", async (t) => {
  const r = await room(t);
  const first = r.approve(1, oldPlan("TUC-1"));
  await r.tick();
  const runIssue = r.catchUpIssue();
  await r.writePlan(runIssue.id, catchUpPlan(S1));
  await r.catchUp.apply(runIssue.id, "agent-1", catchUpPlan(S1));

  const state = await r.state();
  assert.equal(state?.planner, null);
  assert.equal(state?.lastClosed?.outcome, "applied");
  assert.deepEqual(state?.covered, { i1: { planHash: first.planHash, outcome: "applied" } });
  assert.deepEqual(r.completed, [runIssue.id]);

  r.approve(9, oldPlan("TUC-9"), "2026-01-09 09:00");
  await r.tick(HOUR);
  assert.equal(r.creates.length, 1, "a day has not passed");
  await r.tick(DAY);
  assert.equal(r.creates.length, 2);
  const second = r.catchUpIssue();
  const nine = catchUpPlan(sectionOf("TUC-9", VERDICT_HOLDS, ""));
  await r.writePlan(second.id, nine);
  await r.catchUp.apply(second.id, null, nine);

  // TUC-1 approved again with new text: a new hash is not covered, so it is eligible again.
  const again = r.approve(1, oldPlan("TUC-1").replace("Keep the column", "Keep the total"), "2026-01-11 09:00");
  assert.notEqual(again.planHash, first.planHash);
  r.approvals.splice(0, r.approvals.length, again, r.approvals.find((plan) => plan.identifier === "TUC-9") ?? again);
  await r.tick(DAY);
  assert.equal(r.creates.length, 3);
  assert.ok(r.creates[2].description.includes("### TUC-1"), "the re-approved plan is listed with its new hash");
});

test("the plan gate names the problems of each listed ticket", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  r.approve(2, oldPlan("TUC-2"));
  r.approve(3, oldPlan("TUC-3", { reach: false }));
  await r.tick();
  const issueId = r.catchUpIssue().id;
  const valid = catchUpPlan(S1, S2, S3);

  assert.deepEqual(await r.catchUp.problems(issueId, valid), [], "the fixture plan passes");
  const problems = async (plan: string) => (await r.catchUp.problems(issueId, plan)).join("\n");

  assert.match(await problems(catchUpPlan(S1, S2)), /TUC-3/, "a listed ticket without a section");
  assert.match(await problems(catchUpPlan(S1, S2, S3, sectionOf("TUC-9", VERDICT_HOLDS, "TUC-9 blocks TUC-4"))), /TUC-9/, "a section for an unlisted ticket");
  assert.match(await problems(catchUpPlan(`${S1}\n\n${S1}`, S2, S3)), /TUC-1/, "two sections for one ticket");
  assert.match(await problems(catchUpPlan(["### TUC-1", "", VERDICT_HOLDS].join("\n"), S2, S3)), /TUC-1/, "a section without a block");
  assert.match(await problems(catchUpPlan(sectionOf("TUC-1", VERDICT_HOLDS, "TUC-1 blocks TUC-4\n\n```related-work\nTUC-1 related TUC-5\n```"), S2, S3)), /TUC-1/, "two blocks in one section");
  assert.match(await problems(catchUpPlan(sectionOf("TUC-1", VERDICT_HOLDS, "TUC-9 blocks TUC-4"), S2, S3)), /TUC-9 blocks TUC-4|names TUC-1/, "a line naming two other tickets (D2)");
  assert.match(await problems(catchUpPlan(sectionOf("TUC-1", VERDICT_HOLDS, "TUC-1 duplicates TUC-4"), S2, S3)), /duplicates/, "a duplicates line is refused");
  assert.match(await problems(catchUpPlan(sectionOf("TUC-1", "**Verdict: holds** — nothing changed.", "replan TUC-1: not really"), S2, S3)), /TUC-1|replan/, "holds with a replan");
  assert.match(await problems(catchUpPlan(S1, sectionOf("TUC-2", "**Verdict: replan** — TUC-9 replaced its step.", "TUC-2 related TUC-5"), S3)), /replan/, "replan without its line");
  assert.match(await problems(catchUpPlan(S1, S2, sectionOf("TUC-3", VERDICT_HOLDS, ""))), /Reach|reach/, "no reach for a plan without one");
  assert.match(await problems(catchUpPlan(S1, S2, S3).replace("## Risk and impact", "## Risk")), /Risk and impact/);
  assert.match(await problems(catchUpPlan(S1, S2, S3).replace("- Tier: strong — the plan changes no code", "- Tier: cheap — a small plan")), /Tier|strong/i);
  assert.deepEqual(await r.catchUp.problems("unknown-issue", valid), [], "not a catch-up: this gate stays out of it");
});

test("the plan generated from the brief passes the record gate", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  r.approve(3, oldPlan("TUC-3", { reach: false }), "2026-01-03 09:00");
  await r.tick();
  const brief = r.creates[0].description;
  assert.ok(brief.includes("## Risk and impact") && brief.includes("- Tier: strong"), "the brief gives the fixed template");
  assert.ok(brief.includes("origin/main"), "and the step to check a merged change on it");
  assert.ok(brief.includes("deliberately replaces"), "and the rule that a later decision stays valid");

  // The plan an agent writes from the brief: the planning instructions' parts, the brief's own
  // template with the advisor's rating, the listed tickets' sections, then the advisor's review.
  const template = /```markdown\n([\s\S]*?)\n```/.exec(brief)?.[1];
  assert.ok(template, "the brief carries the template as a markdown block");
  const generated = [
    PARTS[0], "", "Catches up the related work of two older approved plans.", "",
    PARTS[1], "",
    template.replace(/^- Advisor rating: .*$/m, "- Advisor rating: impact 2, data-fix"),
    "", "## Listed tickets", "", S1, S3, "",
    "## Advisor review", "", "One round with the advisor; it agreed.", "",
  ].join("\n");
  const risk = parsePlanRisk(generated);
  assert.ok("risk" in risk, "the plan has a readable rating");
  if ("risk" in risk) {
    assert.equal(risk.risk.impact, 2);
    assert.equal(risk.risk.reversibility, "data-fix");
    assert.ok(risk.risk.advisor, "the advisor's own rating is read");
    assert.equal(combinedRating(risk.risk).impact, 2);
    assert.ok(!risk.risk.newRule);
  }
  const sections = parsePlanSections(generated, 2);
  assert.ok("sections" in sections);
  assert.ok(sectionBody(generated, "Reach")?.includes("- Changes:"), "a listed ticket's #### Reach is not read as the plan's");
  assert.equal(modelProblem(generated), null);
  assert.equal(layoutProblem(generated, PARTS), null);
  assert.deepEqual(await r.catchUp.problems(r.catchUpIssue().id, generated), []);
});

test("approving writes each listed ticket once, never its plan document", async (t) => {
  const r = await room(t);
  const one = r.approve(1, oldPlan("TUC-1"));
  const two = r.approve(2, oldPlan("TUC-2"), "2026-01-02 09:00");
  r.approve(3, oldPlan("TUC-3", { reach: false }), "2026-01-03 09:00");
  await r.tick();
  const runIssue = r.catchUpIssue();
  const plan = catchUpPlan(S1, S2, S3);
  const before = new Map([...r.documents].map(([issueId, list]) => [issueId, list.map((document) => document.content)]));
  await r.writePlan(runIssue.id, plan);
  await r.catchUp.apply(runIssue.id, null, plan);

  // The documents: one per listed ticket, its approved section, and the reach for TUC-3.
  const documentOf = (issueId: string, identifier: string) => r.documents.get(issueId)?.filter((document) => document.title === `Related work: ${identifier}`) ?? [];
  assert.equal(documentOf("i1", "TUC-1").length, 1);
  assert.equal(documentOf("i2", "TUC-2").length, 1);
  assert.equal(documentOf("i3", "TUC-3").length, 1);
  const firstSection = catchUpSections(plan).find((section) => section.identifier === "TUC-1");
  assert.ok(firstSection);
  const written = documentOf("i1", "TUC-1")[0].content;
  assert.equal(relatedWorkHeader(written).coversPlan, one.planHash, "the document covers the plan it was written for");
  assert.equal(relatedWorkHeader(written).analysis, planHash(firstSection.text));
  assert.deepEqual(blockLines(parseBlock(written, RELATED_WORK_TAG) ?? ""), ["TUC-1 blocks TUC-4"]);
  assert.deepEqual(blockLines(parseBlock(documentOf("i3", "TUC-3")[0].content, RELATED_WORK_TAG) ?? ""), [], "an empty block is an empty list");
  assert.ok(sectionBody(documentOf("i3", "TUC-3")[0].content, "Reach")?.includes("- report: include"), "TUC-3's document carries the reach");
  for (const [issueId, contents] of before) {
    const plans = r.documents.get(issueId)?.filter((document) => document.title.startsWith("Plan: ")).map((document) => document.content) ?? [];
    assert.deepEqual(plans, contents, `no Plan: document of ${issueId} changed`);
  }
  assert.ok(!r.calls.some((call) => call.startsWith("document ") && call.includes("Plan: ")), "no Plan: document is written");

  // The links: one record per section, applying only, guarded by the plan's hash, crediting the catch-up.
  assert.equal(r.relations.calls.length, 3);
  for (const request of r.relations.calls) {
    assert.equal(request.cleanup, false, "a catch-up section never touches the label");
    assert.equal(request.origin, runIssue.identifier);
  }
  const second = r.relations.calls.find((request) => request.identifier === "TUC-2");
  assert.ok(second);
  assert.equal(second.recordId, `catch-up:i2:${two.planHash}`);
  assert.deepEqual(second.guard, { issueId: "i2", planHash: two.planHash });
  assert.deepEqual(r.relations.writes, ["TUC-2: replan TUC-2: TUC-9 replaced its step", "TUC-1: TUC-1 blocks TUC-4"]);

  // The summary, the completion and the close.
  const summary = r.comments.filter((comment) => comment.issueId === runIssue.id);
  assert.equal(summary.length, 1);
  assert.ok(summary[0].body.includes("TUC-1") && summary[0].body.includes("TUC-2") && summary[0].body.includes("TUC-3"));
  assert.ok(summary[0].body.includes("replan") && summary[0].body.includes("holds"), "each ticket's verdict");
  assert.deepEqual(r.completed, [runIssue.id]);
  const state = await r.state();
  assert.equal(state?.planner, null);
  assert.equal(state?.lastClosed?.outcome, "applied");
  assert.deepEqual(Object.keys(state?.covered ?? {}).sort(), ["i1", "i2", "i3"]);
  assert.equal(r.starts.length, 1, "only the planning agent was started");
  assert.ok(!r.archived.includes("agent-1"), "no agent was recorded for the run, so none is retired");
});

test("a document write that fails leaves the section pending, and the next pass writes nothing twice", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  r.approve(2, oldPlan("TUC-2"), "2026-01-02 09:00");
  await r.tick();
  const runIssue = r.catchUpIssue();
  const plan = catchUpPlan(S1, S2);
  await r.writePlan(runIssue.id, plan);
  // The oldest listing comes first: TUC-2's document write is refused (the app cannot be used).
  r.fail.document = 1;
  await r.catchUp.apply(runIssue.id, null, plan);
  let state = await r.state();
  assert.equal(state?.planner?.outcomes.i2?.status, "pending");
  assert.equal(state?.planner?.outcomes.i1?.status, "pending");
  assert.equal(r.relations.calls.length, 0, "the pending section writes no links");
  assert.deepEqual(r.completed, [], "nothing is completed while a section is pending");

  await r.tick(6 * MINUTE);
  state = await r.state();
  assert.equal(state?.planner, null, "the next pass settles the last section and closes");
  assert.equal(state?.lastClosed?.outcome, "applied");
  assert.deepEqual(Object.keys(state?.covered ?? {}).sort(), ["i1", "i2"]);
  assert.equal(r.calls.filter((call) => call === "wrote-document i2 Related work: TUC-2").length, 1, "the retried document is written once, not again after it landed");
  assert.equal(r.calls.filter((call) => call === "wrote-document i1 Related work: TUC-1").length, 1, "and the section after it once");
  assert.equal(r.comments.filter((comment) => comment.issueId === runIssue.id).length, 1, "the summary is posted once");
  assert.deepEqual(r.completed, [runIssue.id]);
});

test("refused links skip the section, and a later catch-up resumes it once", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  const two = r.approve(2, oldPlan("TUC-2"), "2026-01-02 09:00");
  await r.tick();
  const first = r.catchUpIssue();
  const plan = catchUpPlan(S1, S2);
  await r.writePlan(first.id, plan);
  r.relations.failing.set(`catch-up:i2:${two.planHash}`, 5);
  await r.catchUp.apply(first.id, null, plan);

  // Five refused rounds: the section stays pending, the sweep's rounds are the later ticks.
  let state = await r.state();
  assert.equal(state?.planner?.outcomes.i2?.status, "pending");
  assert.equal(state?.planner?.outcomes.i1?.status, "pending", "the sweep stops at the pending section");
  assert.deepEqual(state?.covered, {}, "nothing is covered before the catch-up closes");
  for (let round = 2; round <= 5; round++) {
    await r.tick(6 * MINUTE);
    state = await r.state();
  }
  assert.equal(state?.planner, null, "the catch-up closes with the section skipped");
  assert.equal(state?.lastClosed?.outcome, "applied");
  assert.equal(state?.covered.i2, undefined, "a skipped ticket stays eligible");
  const comment = r.comments.find((entry) => entry.issueId === first.id);
  assert.ok(comment);
  assert.ok(comment.body.includes("TUC-2") && comment.body.includes("skipped"), "the summary names the skipped ticket and its reason");
  assert.ok(!r.relations.writes.includes("TUC-2: replan TUC-2: TUC-9 replaced its step"), "the refused replan was never written");

  // The app recovers: the next catch-up lists TUC-2 again, reuses its record and writes its one replan once.
  await r.tick(DAY);
  assert.equal(r.creates.length, 2);
  assert.ok(!r.creates[1].description.includes("### TUC-1"), "the applied ticket is covered");
  const second = r.catchUpIssue();
  await r.writePlan(second.id, catchUpPlan(S2));
  await r.catchUp.apply(second.id, null, catchUpPlan(S2));
  assert.equal(r.relations.calls.at(-1)?.recordId, `catch-up:i2:${two.planHash}`, "the same relations record is resumed");
  assert.equal(r.relations.writes.filter((line) => line === "TUC-2: replan TUC-2: TUC-9 replaced its step").length, 1, "the replan is written exactly once");
  assert.deepEqual((await r.state())?.covered.i2, { planHash: two.planHash, outcome: "applied" });
});

test("an untrusted listed ticket gets one comment and no write", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  r.add(5, { creatorId: "someone-else" });
  const five = r.approve(5, oldPlan("TUC-5"), "2026-01-05 11:00");
  await r.tick();
  const runIssue = r.catchUpIssue();
  const plan = catchUpPlan(S1, sectionOf("TUC-5", VERDICT_HOLDS, "TUC-5 related TUC-6"));
  await r.writePlan(runIssue.id, plan);
  await r.catchUp.apply(runIssue.id, null, plan);

  const comments = r.comments.filter((comment) => comment.issueId === "i5");
  assert.equal(comments.length, 1, "exactly one information comment");
  assert.ok(comments[0].body.includes("TUC-5 related TUC-6"), "it lists the section's lines");
  assert.equal(r.documents.get("i5")?.filter((document) => document.title === "Related work: TUC-5").length ?? 0, 0, "no document is written");
  assert.ok(!r.relations.calls.some((request) => request.issueId === "i5"), "no link is written");
  assert.ok(!r.calls.some((call) => call.includes("i5") && call.startsWith("complete ")));
  const state = await r.state();
  assert.deepEqual(state?.covered, { i1: { planHash: r.approvals[0].planHash, outcome: "applied" }, i5: { planHash: five.planHash, outcome: "untrusted" } });
  assert.equal(state?.planner, null);

  // Covered as untrusted, TUC-5 is not listed again for the same plan.
  await r.tick(DAY);
  assert.equal(r.creates.length, 1);
});

test("a plan approved again before its section is applied is skipped", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  r.approve(2, oldPlan("TUC-2"), "2026-01-02 09:00");
  await r.tick();
  const runIssue = r.catchUpIssue();
  const plan = catchUpPlan(S1, S2);
  await r.writePlan(runIssue.id, plan);
  // Another host approves TUC-2 again between the listing and the application.
  const replanned = planDocument("TUC-2", oldPlan("TUC-2").replace("Keep the column", "Keep the total"), "2026-01-10 00:10");
  r.documents.set("i2", [{ title: "Plan: TUC-2", content: replanned, url: "https://linear.app/doc/plan-2b" }]);
  await r.catchUp.apply(runIssue.id, null, plan);

  const state = await r.state();
  assert.equal(state?.planner, null);
  assert.equal(state?.planner, null, "the run still closes");
  assert.deepEqual(state?.covered.i1?.outcome, "applied");
  assert.equal(state?.covered.i2, undefined, "the re-approved plan is listed by its own catch-up");
  assert.deepEqual(r.documents.get("i2")?.map((document) => document.title), ["Plan: TUC-2"], "nothing was written on its ticket");
  assert.deepEqual(r.documents.get("i2")?.[0].content, replanned, "the new plan document survives unchanged");
  assert.ok(!r.relations.calls.some((request) => request.issueId === "i2"));
  const comment = r.comments.find((entry) => entry.issueId === runIssue.id);
  assert.ok(comment);
  assert.ok(comment.body.includes("TUC-2") && comment.body.includes("approved again"), "the summary gives the reason");
});

test("the brief names what changed since each approval, newest first", async (t) => {
  const listed: CatchUpListed[] = [
    { issueId: "i3", identifier: "TUC-3", title: "Third", status: "Todo", planHash: "c", approvedAt: "2026-01-03T09:00:00.000Z", hasReach: false },
    { issueId: "i1", identifier: "TUC-1", title: "First", status: "In Progress", planHash: "a", approvedAt: "2026-01-01T10:00:00.000Z", hasReach: true },
  ];
  const changes: Record<string, ChangedSinceEntry[]> = {
    i1: [
      { kind: "approved", identifier: "TUC-9", status: "In Review", approvedAt: Date.parse("2026-01-05T10:30:00Z"), completedAt: null, overlap: { files: ["server/x.ts"], places: [], tickets: [], namesOther: false } },
      { kind: "merged", identifier: "TUC-8", status: "In Review", url: "https://github.com/o/r/pull/8", mergedAt: "2026-01-05T11:00:00Z", files: ["server/x.ts"] },
    ],
  };

  const brief = catchUpBrief(listed, changes);

  const first = brief.indexOf("### TUC-1 — First (In Progress), approved 2026-01-01T10:00:00.000Z");
  const third = brief.indexOf("### TUC-3 — Third (Todo)");
  assert.ok(first >= 0 && third > first, "oldest approval first");
  const merged = brief.indexOf("*merged 2026-01-05T11:00:00Z*");
  const approved = brief.indexOf("*approved 2026-01-05T10:30:00.000Z*");
  assert.ok(merged > first && approved > merged, "what changed newest first, after its section's heading");
  assert.ok(brief.includes("https://github.com/o/r/pull/8") && brief.includes("(In Review)"), "the pull request and its ticket's state");
  assert.ok(brief.includes("`server/x.ts`"), "the shared file");
  assert.ok(brief.includes("Nothing changed since its approval."), "a ticket without changes says so");
  assert.ok(brief.includes("Its plan has no `## Reach` section"), "a plan without one needs a reach list");
  assert.ok(brief.includes("`## Related work`") || brief.includes("Related work"), "the rule that a catch-up writes no plan document");
  assert.ok(brief.includes("Check `origin/main`") || brief.includes("origin/main"), "the step to check a merged change");
});

test("the store keeps each team's record across instances", async (t) => {
  const r = await room(t);
  r.approve(1, oldPlan("TUC-1"));
  await r.tick();
  const other = new CatchUpStore(r.storePath);
  const state = await other.all();
  assert.equal(state[TEAM]?.planner?.identifier, "TUC-90");
  assert.equal(state[TEAM]?.planner?.tickets, 1);
  assert.equal(catchUpSections(catchUpPlan(S1)).length, 1);
});