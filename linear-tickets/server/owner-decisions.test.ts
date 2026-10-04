import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentApi } from "./agent-app";
import { oldestRecord, pluginComments, recordedComments, recordPluginComment } from "./agent-records";
import { AuthenticationError, type MentioningIssue, type PlanDocument, type WindowComment } from "./linear";
import {
  AppOnlyToken, AppWriter, candidateKey, collectOwnerDecisions, collectWindow, DecisionLog, documentFeedback, InvalidInput, isoWeek, runCollect, runFile,
  sentBackFeedback, verbatim, withLock, type Batch, type FileWriter, type Item,
} from "./owner-decisions";

const DAY = 24 * 60 * 60 * 1000;
// Monday 2026-10-05 07:00 UTC: ISO week 41.
const NOW = Date.parse("2026-10-05T07:00:00Z");
const ago = (days: number, hours = 0) => new Date(NOW - days * DAY - hours * 3_600_000).toISOString();
const REGISTER = { approved: "## P-1 — Gleiches Postfach-Verhalten\n", decisions: "## D-12 — Q-8 document reading\n", queue: "## Q-11 — May QM evaluation block?\n" };

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "paseo-owner-decisions-"));
}

// Promise.withResolvers without the ES2024 lib this package compiles against.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function comment(id: string, body: string, createdAt: string, issueId = "issue-1", overrides: Partial<WindowComment> = {}): WindowComment {
  return { id, body, createdAt, url: `https://linear.app/acme/issue/${issueId}#comment-${id}`, userId: "owner", issue: { id: issueId, identifier: issueId.toUpperCase(), url: `https://linear.app/acme/issue/${issueId}`, project: "ERP", title: "A ticket", parentId: null }, parentBody: null, ...overrides };
}

// Linear as the collector and the filer see it: comments and documents to read, candidate tickets to
// find, and the Paseo app's writes landing in the same ticket list.
class World {
  comments: WindowComment[] = [];
  documents: PlanDocument[] = [];
  tickets: MentioningIssue[] = [];
  writes: string[] = [];
  failOn: string | null = null;
  async teamIdByKey() { return "team"; }
  async projectIdByName(name: string) { return `project:${name}`; }
  async viewerId() { return "owner"; }
  async issuesMentioning(_team: string, text: string, openOnly = false) {
    return this.tickets.filter((ticket) => ticket.description.includes(text) && (!openOnly || !["completed", "canceled"].includes(ticket.statusType)));
  }
  async ownerCommentsSince(userId: string, since: string) { return this.comments.filter((found) => found.userId === userId && found.createdAt >= since); }
  async planSentBackSince(since: string) { return this.comments.filter((found) => found.body.includes("Plan sent back") && found.createdAt >= since); }
  async planDocumentsSince(since: string) { return this.documents.filter((document) => document.updatedAt >= since); }
  async issueLinks(ids: string[]) { return new Map(ids.map((id) => [id, { id, identifier: id.toUpperCase(), url: `https://linear.app/acme/issue/${id}`, project: "ERP" }])); }
  writer: FileWriter = {
    createIssue: async (input) => {
      if (this.failOn && input.projectId.endsWith(this.failOn)) throw new Error("Linear is down");
      const number = this.tickets.length + 100;
      this.writes.push(`create ${input.projectId} "${input.title}"`);
      const ticket = { id: `t${number}`, identifier: `TUC-${number}`, url: `https://linear.app/acme/issue/TUC-${number}`, project: input.projectId.replace("project:", ""), title: input.title, status: "Backlog", statusType: "backlog", description: input.description, comments: [] };
      this.tickets.push(ticket);
      return { id: ticket.id, identifier: ticket.identifier, url: ticket.url };
    },
    updateDescription: async (issueId, description) => {
      this.writes.push(`update ${issueId}`);
      this.tickets.find((ticket) => ticket.id === issueId)!.description = description;
    },
  };
}

// `recordsFrom`: comment records are kept since long before the window unless a test says otherwise.
async function collect(home: string, world: World, now = NOW, log = new DecisionLog(join(home, "owner-decisions"), () => now), recordsFrom: () => Promise<string | null> = async () => ago(30)) {
  return runCollect({
    directory: join(home, "owner-decisions"), log, linear: world, register: async () => REGISTER,
    recorded: () => recordedComments(home, now), recordsFrom, agentTickets: async () => new Set(["issue-1", "issue-2"]), ruleSources: ["README.md"], teamKey: "TUC", now: () => now,
  });
}

function file(home: string, world: World, batch: Batch, input: unknown, options: { dryRun?: boolean; writer?: FileWriter } = {}) {
  return runFile({ directory: join(home, "owner-decisions"), batch: batch.until, input, linear: world, writer: options.writer ?? world.writer, teamKey: "TUC", dryRun: options.dryRun ?? false, now: () => NOW });
}

function candidate(item: Item, quote: string, title = "Always A") {
  return { title, type: "principle", wording: `${title}.`, scope: "every page", question: `${title}?`, options: "Yes / No", recommendation: "Yes", evidence: [{ sourceId: item.sourceId, url: item.sourceUrl, quote }] };
}

async function state(home: string) {
  return JSON.parse(await readFile(join(home, "owner-decisions", "state.json"), "utf8"));
}

test("the collector lists the owner's own comments on agent tickets, never agents', the plugin's or candidate tickets'", async () => {
  const home = await temporary();
  try {
    const world = new World();
    await mkdir(join(home, "agent-comments", "11111111-1111-4111-8111-111111111111"), { recursive: true });
    await writeFile(join(home, "agent-comments", "11111111-1111-4111-8111-111111111111", "a.json"), JSON.stringify({ id: "by-agent", issueId: "issue-1", createdAt: ago(1) }));
    // A key-written plugin comment, 20 days old: its record must still be there.
    await recordPluginComment(home, "by-plugin", "issue-1", new Date(NOW - 20 * DAY));
    world.comments = [
      comment("mine", "We always do A.", ago(1)),
      comment("by-agent", "Agent summary as the owner", ago(1)),
      comment("by-plugin", "Plugin fallback comment", ago(1)),
      comment("someone", "Not the owner", ago(1), "issue-1", { userId: "colleague" }),
      comment("no-agent", "On a ticket no agent touched", ago(1), "issue-9"),
      comment("on-candidates", "Answer on the candidates ticket", ago(1), "cand"),
      comment("needs-you", "Option B", ago(2), "sub-1", { issue: { id: "sub-1", identifier: "TUC-9", url: "https://linear.app/acme/issue/TUC-9", project: "ERP", title: "Needs you: which option?", parentId: "issue-2" } }),
    ];
    world.tickets = [{ id: "cand", identifier: "TUC-50", url: "u", project: "ERP", title: "Decision candidates, week 40", status: "Todo", statusType: "unstarted", description: "Marker: `decision-candidates ERP 2026-W40`", comments: [] }];
    const { batch, markdown } = await collect(home, world);
    assert.deepEqual(batch.items.map((found) => [found.sourceId, found.kind]), [["comment:needs-you", "answer"], ["comment:mine", "comment"]]);
    assert.match(markdown, /https:\/\/linear\.app\/acme\/issue\/issue-1#comment-mine/);
    assert.match(markdown, /TUC-50 — Decision candidates, week 40/);
    assert.match(markdown, /## Register: docs\/principles\/decisions\.md/);
    assert.equal(batch.registerMaxQ, 11);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("plugin comment records are kept 35 days now", async () => {
  const home = await temporary();
  try {
    await recordPluginComment(home, "twenty", "issue-1", new Date(NOW - 20 * DAY));
    await recordPluginComment(home, "thirtysix", "issue-1", new Date(NOW - 36 * DAY));
    assert.deepEqual(await pluginComments(home, NOW), ["twenty"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the window starts at the checkpoint, at most 28 days back and never before coverage began", () => {
  assert.deepEqual(collectWindow({}, NOW, ago(30)), { since: ago(7), until: ago(0), coverageFrom: ago(7), commentsFrom: ago(30) });
  // Without any comment record kept, owner comments count from the first collect on.
  assert.equal(collectWindow({}, NOW).commentsFrom, ago(0));
  assert.equal(collectWindow({ commentsFrom: ago(2) }, NOW, ago(30)).commentsFrom, ago(2));
  // Coverage fixed by the first collect: a comment older than it may have lost its record.
  assert.equal(collectWindow({ coverageFrom: ago(10), checkpoint: ago(20) }, NOW).since, ago(10));
  assert.equal(collectWindow({ coverageFrom: ago(60), checkpoint: ago(40) }, NOW).since, ago(28));
  assert.equal(collectWindow({ coverageFrom: ago(60), checkpoint: ago(3) }, NOW).since, ago(3));
});

test("window edges: the start is in, the end is out; answers count by the answer's time", async () => {
  const home = await temporary();
  try {
    const log = new DecisionLog(home, () => NOW);
    const world = new World();
    world.comments = [comment("start", "At the start", ago(7)), comment("end", "At the end", ago(0))];
    const question = (id: string, at: string) => log.append({ kind: "question", id, at, identifier: "ISSUE-1", issueId: "issue-1", questions: [{ key: "Merge", question: "Merge: may I merge?", options: ["Yes", "No"] }] });
    await question("a:early", ago(9));
    await log.answer("a:early", { behavior: "allow", updatedInput: { answers: { Merge: "Yes" } } }, ago(1));
    await question("a:old", ago(9));
    await log.answer("a:old", { behavior: "allow", updatedInput: { answers: { Merge: "No" } } }, ago(8));
    const items = await collectOwnerDecisions({ log, linear: world, recorded: new Set(), agentTickets: new Set(["issue-1"]), excluded: new Set() }, { since: ago(7), until: ago(0) });
    assert.deepEqual(items.map((found) => found.sourceId), ["comment:start", "log:answer:a:early"]);
    assert.equal(items[1].text, "Question: Merge: may I merge?\nOptions: Yes / No\nAnswer: Yes");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("owner comments count only from the oldest comment record; plan feedback before it still counts", async () => {
  const home = await temporary();
  try {
    const world = new World();
    // Records started 3 days ago: an older comment "by the owner" may be an agent's written with the key.
    await recordPluginComment(home, "first-record", "issue-1", new Date(NOW - 3 * DAY));
    assert.equal(await oldestRecord(home), ago(3));
    world.comments = [comment("before", "Progress report, written with the key", ago(5)), comment("after", "We always do A.", ago(1))];
    world.documents = [{ id: "doc", title: "Plan: ISSUE-1", url: "https://linear.app/acme/document/plan", updatedAt: ago(5), issue: { id: "issue-1", identifier: "ISSUE-1", url: "https://linear.app/acme/issue/issue-1", project: "ERP" }, content: "> **Sent back with feedback** in Plannotator on x\n\n## Review feedback\n\nUse option B.\n\n---\n\n# Plan" }];
    const { batch, markdown } = await collect(home, world, NOW, undefined, () => oldestRecord(home));
    assert.deepEqual(batch.items.map((found) => found.sourceId), [`doc:doc:${ago(5)}`, "comment:after"]);
    assert.match(markdown, new RegExp(`Owner comments count from ${ago(3).replace(/[.]/g, "\\.")} only`));
    // Fixed by the first collect: records expiring later never move it.
    assert.equal((await state(home)).commentsFrom, ago(3));
    await rm(join(home, "agent-comments"), { recursive: true, force: true });
    assert.equal((await collect(home, world, NOW, undefined, () => oldestRecord(home))).batch.commentsFrom, ago(3));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("plan feedback from the log, the plan document and the sent-back comment is kept once", async () => {
  const home = await temporary();
  try {
    const log = new DecisionLog(home, () => NOW);
    const feedback = `Use option B.\n\n${"Long reasoning. ".repeat(300)}`;
    await log.append({ kind: "plan-feedback", id: "agent:t", at: ago(2), identifier: "ISSUE-1", issueId: "issue-1", approved: false, text: feedback });
    const world = new World();
    world.documents = [
      { id: "doc", title: "Plan: ISSUE-1", url: "https://linear.app/acme/document/plan", updatedAt: ago(2), issue: { id: "issue-1", identifier: "ISSUE-1", url: "https://linear.app/acme/issue/issue-1", project: "ERP" }, content: `> **Sent back with feedback** in Plannotator on 2026-10-03 07:00 UTC for ISSUE-1.\n> **Planned with:** \`m\`\n\n## Review feedback\n\n${feedback}\n\n---\n\n# Plan` },
      { id: "auto", title: "Plan: ISSUE-2", url: "https://linear.app/acme/document/auto", updatedAt: ago(2), issue: { id: "issue-2", identifier: "ISSUE-2", url: "u", project: "ERP" }, content: "> **Approved** in Plannotator on x\n\n## Review feedback\n\nAuto-approved by the risk policy. Risk: impact 0/4, revert.\n\n---\n\n# Plan" },
    ];
    world.comments = [comment("sent", `↩️ **Plan sent back** from Plannotator — [plan](u)\n\n${feedback.slice(0, 4_000)}`, ago(2), "issue-1", { userId: "paseo-app" })];
    const items = await collectOwnerDecisions({ log, linear: world, recorded: new Set(), agentTickets: new Set(["issue-1"]), excluded: new Set() }, { since: ago(7), until: ago(0) });
    assert.deepEqual(items.map((found) => found.sourceId), ["log:plan-feedback:agent:t"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the plugin's plan documents and sent-back comments yield the owner's feedback only", () => {
  // As Linear returns a document the plugin wrote: separators get blank lines around them.
  assert.deepEqual(documentFeedback("> **Sent back with feedback** in Plannotator on 2026-10-04 14:17 UTC for TUC-728.\n> **Planned with:** `m`\n\n## Review feedback\n\n# Plan Feedback\n\n> do i have to move the domain?\n\n---\n\n---\n\n# TUC-728"),
    { approved: false, text: "# Plan Feedback\n\n> do i have to move the domain?" });
  assert.equal(documentFeedback("> **Approved** in Plannotator on x\n\n---\n\n# Plan\n\n## Review feedback\n\nnot ours"), null);
  assert.equal(documentFeedback("# Somebody's own plan\n\n## Review feedback\n\nx"), null);
  assert.equal(sentBackFeedback("↩️ **Plan sent back** in Plannotator ([plan](u))\n\nSplit step 1\n\nAssign Paseo again to plan it again."), "Split step 1");
  assert.equal(sentBackFeedback("✅ **Plan approved** in Plannotator"), null);
});

test("candidate identity: two decisions in one comment differ, a new review round is new, a reworded retry is the same", () => {
  const first = candidateKey("ERP", [{ sourceId: "comment:c1", url: "https://a", quote: "Always A." }]);
  assert.notEqual(first, candidateKey("ERP", [{ sourceId: "comment:c1", url: "https://a", quote: "Never B." }]));
  assert.notEqual(candidateKey("ERP", [{ sourceId: "doc:d:2026-10-01T00:00:00Z", url: "https://doc", quote: "Use B." }]), candidateKey("ERP", [{ sourceId: "doc:d:2026-10-03T00:00:00Z", url: "https://doc", quote: "Use B." }]));
  assert.equal(first, candidateKey("ERP", [{ sourceId: "comment:c1", url: "https://elsewhere", quote: "  Always\nA. " }]));
  assert.notEqual(first, candidateKey("Agent tooling", [{ sourceId: "comment:c1", url: "https://a", quote: "Always A." }]));
});

test("ISO weeks: the year-week comes from the batch's end", () => {
  assert.deepEqual(isoWeek(new Date("2026-10-04T23:59:00Z")), { year: 2026, week: 40 });
  assert.deepEqual(isoWeek(new Date("2026-10-05T00:00:00Z")), { year: 2026, week: 41 });
  assert.deepEqual(isoWeek(new Date("2027-01-01T12:00:00Z")), { year: 2026, week: 53 });
});

test("filing: one ticket per project, nothing twice, appended within the week, a new run after the week's ticket closed", async () => {
  const home = await temporary();
  try {
    const world = new World();
    world.comments = [comment("c1", "We always do A. And we never do B.", ago(1)), comment("c2", "Agents always fetch main first.", ago(1), "issue-2")];
    const { batch } = await collect(home, world);
    const [c1, c2] = [batch.items.find((found) => found.sourceId === "comment:c1")!, batch.items.find((found) => found.sourceId === "comment:c2")!];
    const input = { projects: [
      { project: "ERP", candidates: [candidate(c1, "We always do A."), candidate(c1, "we never do B.", "Never B")] },
      { project: "Agent tooling", candidates: [candidate(c2, "Agents always fetch main first.", "Fetch main first")] },
    ] };
    const reports = await file(home, world, batch, input);
    assert.deepEqual(reports.map((report) => [report.project, report.action, report.proposals]), [
      ["ERP", "created", ["Q-12 — Always A", "Q-13 — Never B"]],
      ["Agent tooling", "created", ["Q-14 — Fetch main first"]],
    ]);
    assert.deepEqual(world.writes, ['create project:ERP "Decision candidates, week 41"', 'create project:Agent tooling "Decision candidates, week 41"']);
    const erp = world.tickets[0];
    assert.match(erp.description, /^Marker: `decision-candidates ERP 2026-W41`/);
    assert.match(erp.description, /- Evidence:\n {2}- 2026-10-04 07:00 UTC, \[ISSUE-1\]\(https:\/\/linear\.app\/acme\/issue\/issue-1#comment-c1\) \(comment\):\n {4}> We always do A\./);
    assert.match(erp.description, /record a proposal only after the owner answered that proposal/);
    assert.equal((await state(home)).checkpoint, batch.until);

    // The same batch again, and a reworded retry of the same decision: nothing new.
    world.writes = [];
    const again = await file(home, world, batch, { projects: [{ project: "ERP", candidates: [candidate(c1, "We  always do A.", "A, always (reworded)")] }] });
    assert.deepEqual(again.map((report) => report.action), ["none"]);
    assert.deepEqual(world.writes, []);

    // A new decision in the same week goes into that week's open ticket.
    world.comments.push(comment("c3", "Every list sorts newest first.", new Date(NOW + 1_800_000).toISOString()));
    const second = await collect(home, world, NOW + 3_600_000);
    const c3 = second.batch.items.find((found) => found.sourceId === "comment:c3")!;
    await file(home, world, second.batch, { projects: [{ project: "ERP", candidates: [candidate(c3, "Every list sorts newest first.", "Newest first")] }] });
    assert.deepEqual(world.writes, [`update ${erp.id}`]);
    assert.match(erp.description, /## Q-15 — Newest first/);

    // That ticket closed: the next new decision of the week gets one new ticket, numbered as run 2.
    erp.statusType = "completed";
    world.writes = [];
    world.comments.push(comment("c4", "Totals always show the currency.", new Date(NOW + 5_400_000).toISOString()));
    const third = await collect(home, world, NOW + 7_200_000);
    const c4 = third.batch.items.find((found) => found.sourceId === "comment:c4")!;
    await file(home, world, third.batch, { projects: [{ project: "ERP", candidates: [candidate(c4, "Totals always show the currency.", "Currency")] }] });
    assert.deepEqual(world.writes, ['create project:ERP "Decision candidates, week 41"']);
    assert.match(world.tickets.at(-1)!.description, /^Marker: `decision-candidates ERP 2026-W41 run 2`/);
    assert.match(world.tickets.at(-1)!.description, /## Q-16 — Currency/);
    // A proposal of the closed ticket is not raised again.
    world.writes = [];
    assert.deepEqual((await file(home, world, batch, { projects: [{ project: "ERP", candidates: [candidate(c1, "We always do A.")] }] })).map((report) => report.action), ["none"]);
    assert.deepEqual(world.writes, []);
    assert.equal((await state(home)).checkpoint, third.batch.until);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a crash after the first project leaves the checkpoint; the retry files only what is missing", async () => {
  const home = await temporary();
  try {
    const world = new World();
    world.comments = [comment("c1", "Always A.", ago(1)), comment("c2", "Agents fetch main.", ago(1))];
    const { batch } = await collect(home, world);
    const [c1, c2] = batch.items;
    const input = { projects: [{ project: "ERP", candidates: [candidate(c1, "Always A.")] }, { project: "Agent tooling", candidates: [candidate(c2, "Agents fetch main.", "Fetch")] }] };
    world.failOn = "Agent tooling";
    await assert.rejects(file(home, world, batch, input), /Linear is down/);
    assert.equal((await state(home)).checkpoint, undefined);
    world.failOn = null;
    world.tickets[0].statusType = "completed";
    world.writes = [];
    await file(home, world, batch, input);
    assert.deepEqual(world.writes, ['create project:Agent tooling "Decision candidates, week 41"']);
    assert.equal((await state(home)).checkpoint, batch.until);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an older batch filed after a newer one never moves the checkpoint back; empty input files nothing and moves it", async () => {
  const home = await temporary();
  try {
    const world = new World();
    const older = (await collect(home, world, NOW - DAY)).batch;
    const newer = (await collect(home, world)).batch;
    assert.deepEqual(await file(home, world, newer, { projects: [] }), []);
    assert.equal((await state(home)).checkpoint, newer.until);
    await file(home, world, older, { projects: [] });
    assert.equal((await state(home)).checkpoint, newer.until);
    assert.deepEqual(world.writes, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("invalid candidates and a dry run write nothing; a held lock stops a second run", async () => {
  const home = await temporary();
  try {
    const world = new World();
    world.comments = [comment("c1", "Always A.", ago(1))];
    const { batch } = await collect(home, world);
    const good = candidate(batch.items[0], "Always A.");
    await assert.rejects(file(home, world, batch, { projects: [{ project: "ERP", candidates: [good, { ...good, title: "", evidence: [{ sourceId: "comment:c1", url: "http://x", quote: "Never said this" }] }] }] }),
      (error: unknown) => error instanceof InvalidInput && error.errors.length === 3);
    await assert.rejects(file(home, world, batch, { projects: [{ project: "Sales", candidates: [good] }] }), InvalidInput);
    const dry = await file(home, world, batch, { projects: [{ project: "ERP", candidates: [good] }] }, { dryRun: true });
    assert.deepEqual(dry.map((report) => [report.action, report.ticket]), [["created", null]]);
    assert.deepEqual(world.writes, []);
    assert.equal((await state(home)).checkpoint, undefined);
    await withLock(join(home, "owner-decisions"), async () => {
      await assert.rejects(file(home, world, batch, { projects: [] }), /Another decision-candidates run holds/);
    }, () => NOW);
    // A lock its holder took more than 30 minutes ago is stale: the next run takes over.
    await withLock(join(home, "owner-decisions"), async () => {
      assert.deepEqual(await file(home, world, batch, { projects: [] }), []);
    }, () => NOW - 31 * 60_000);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the lock: a stale holder never removes its successor's lock, one run takes a stale lock over, a cut lock file expires", async () => {
  const home = await temporary();
  const directory = join(home, "owner-decisions");
  const path = join(directory, "lock");
  try {
    // A holder past 30 minutes is taken over; when it finally ends it leaves the new lock alone.
    const staleHolds = deferred();
    const staleRelease = deferred();
    const stale = withLock(directory, async () => { staleHolds.resolve(); await staleRelease.promise; }, () => NOW - 31 * 60_000);
    await staleHolds.promise;
    const successorHolds = deferred();
    const successorRelease = deferred();
    const successor = withLock(directory, async () => { successorHolds.resolve(); await successorRelease.promise; }, () => NOW);
    await successorHolds.promise;
    staleRelease.resolve();
    await stale;
    await assert.rejects(withLock(directory, async () => {}, () => NOW), /Another decision-candidates run holds/);
    successorRelease.resolve();
    await successor;
    await assert.rejects(stat(path), { code: "ENOENT" });

    // Two runs finding the same stale lock: one takes it over, the other stops.
    await writeFile(path, JSON.stringify({ pid: 1, token: "old", at: new Date(NOW - 40 * 60_000).toISOString() }));
    const gate = deferred();
    const runs = [1, 2].map(() => withLock(directory, () => gate.promise, () => NOW));
    // The run that lost stops at once; the winner waits at the gate.
    assert.equal(await Promise.race(runs.map((run) => run.then(() => "ran", () => "stopped"))), "stopped");
    gate.resolve();
    const results = await Promise.allSettled(runs);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);

    // A lock its holder died writing (empty): fresh it blocks, by its mtime it expires.
    await writeFile(path, "");
    await assert.rejects(withLock(directory, async () => {}), /Another decision-candidates run holds/);
    const old = new Date(Date.now() - 31 * 60_000);
    await utimes(path, old, old);
    assert.equal(await withLock(directory, async () => "ran"), "ran");

    // While a release is checking its lock (guard held), no run takes that lock over; the release
    // then removes only its own lock.
    const holds = deferred();
    const releasing = deferred();
    const holder = withLock(directory, async () => { holds.resolve(); await releasing.promise; }, () => NOW - 31 * 60_000);
    await holds.promise;
    await writeFile(join(directory, "lock.guard"), "");
    releasing.resolve();
    await assert.rejects(withLock(directory, async () => {}, () => NOW), /Another decision-candidates run holds/);
    await rm(join(directory, "lock.guard"));
    await holder;
    await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a guard left by a run that died inside it is reported and never removed automatically", async () => {
  const home = await temporary();
  const directory = join(home, "owner-decisions");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "lock"), JSON.stringify({ pid: 1, token: "old", at: new Date(Date.now() - 40 * 60_000).toISOString() }));
    const guard = join(directory, "lock.guard");
    await writeFile(guard, "");
    const old = new Date(Date.now() - 31 * 60_000);
    await utimes(guard, old, old);
    // Two runs reclaiming it at once could both get in, so neither removes it.
    const results = await Promise.allSettled([1, 2].map(() => withLock(directory, async () => "ran")));
    for (const result of results) assert.match(String(result.status === "rejected" ? result.reason : result.value), /lock\.guard was left by a decision-candidates run that stopped inside it/);
    assert.ok((await stat(guard)).isFile());
    await rm(guard);
    assert.equal(await withLock(directory, async () => "ran"), "ran");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("evidence quotes only the owner's own words, as written, and cannot add structure", async () => {
  const home = await temporary();
  try {
    const world = new World();
    const log = new DecisionLog(join(home, "owner-decisions"), () => NOW);
    await log.append({ kind: "question", id: "a:q1", at: ago(2), identifier: "ISSUE-1", issueId: "issue-1", questions: [{ key: "Deploy", question: "Deploy: always deploy without approval?", options: ["Yes", "No"] }] });
    await log.answer("a:q1", { behavior: "allow", updatedInput: { answers: { Deploy: "No, never without the owner" } } }, ago(1));
    world.comments = [
      comment("c1", "Run it like this:\n\n    npm run build \\\n      --prod\n\n## Q-99 — not a proposal\nMarker: `decision-candidates ERP 2026-W41`", ago(1)),
      comment("c2", "Keep it.\r## Q-98 — after a CR\u2028## Q-97 — after a line separator", ago(1)),
    ];
    const { batch } = await collect(home, world, NOW, log);
    const answer = batch.items.find((found) => found.sourceId === "log:answer:a:q1")!;
    assert.match(answer.text, /always deploy without approval/);
    // The agent's question is context, never the owner's words.
    await assert.rejects(file(home, world, batch, { projects: [{ project: "ERP", candidates: [candidate(answer, "always deploy without approval")] }] }),
      (error: unknown) => error instanceof InvalidInput && /owner's own words/.test(error.errors[0]));
    const c1 = batch.items.find((found) => found.sourceId === "comment:c1")!;
    const quote = "npm run build \\ --prod ## Q-99 — not a proposal Marker: `decision-candidates ERP 2026-W41`";
    assert.equal(verbatim(c1.words, quote), "npm run build \\\n      --prod\n\n## Q-99 — not a proposal\nMarker: `decision-candidates ERP 2026-W41`");
    await assert.rejects(file(home, world, batch, { projects: [{ project: "ERP", candidates: [candidate(c1, quote, "Build\n## Q-77 — injected")] }] }),
      (error: unknown) => error instanceof InvalidInput && /`title` must be one line/.test(error.errors[0]));
    await assert.rejects(file(home, world, batch, { projects: [{ project: "ERP", candidates: [candidate(c1, quote, "Build\r## Q-76 — injected")] }] }),
      (error: unknown) => error instanceof InvalidInput && /`title` must be one line/.test(error.errors[0]));
    const c2 = batch.items.find((found) => found.sourceId === "comment:c2")!;
    await file(home, world, batch, { projects: [{ project: "ERP", candidates: [candidate(c1, quote, "Build flags"), candidate(c2, "Keep it. ## Q-98 — after a CR ## Q-97 — after a line separator", "Keep it")] }] });
    const description = world.tickets[0].description;
    assert.match(description, / {4}> npm run build \\\n {4}> {7}--prod\n {4}>\n {4}> ## Q-99 — not a proposal\n {4}> Marker:/);
    assert.match(description, / {4}> Keep it\.\n {4}> ## Q-98 — after a CR\n {4}> ## Q-97 — after a line separator/);
    // Every way JavaScript's multiline `^` (and Markdown) starts a line.
    assert.deepEqual([...description.matchAll(/^## Q-(\d+) — /gm)].map((match) => match[1]), ["12", "13"]);
    assert.equal([...description.matchAll(/^Marker: /gm)].length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("filing writes only as the Paseo app: a missing, expiring or rejected token writes nothing with the key", async () => {
  const home = await temporary();
  try {
    const world = new World();
    world.comments = [comment("c1", "Always A.", ago(1)), comment("c2", "Fetch main.", ago(1))];
    const { batch } = await collect(home, world);
    const input = { projects: [{ project: "ERP", candidates: [candidate(batch.items[0], "Always A.")] }, { project: "Agent tooling", candidates: [candidate(batch.items[1], "Fetch main.", "Fetch")] }] };
    const tokenDirectory = join(home, "agent-app");
    await mkdir(tokenDirectory, { recursive: true });
    const sent: string[] = [];
    let rejectAfter = Infinity;
    const post = async (authorization: string) => {
      sent.push(authorization);
      if (sent.length > rejectAfter) throw new AuthenticationError("Linear rejected this token.", 401);
      return { issueCreate: { success: true, issue: { id: `i${sent.length}`, identifier: `TUC-${sent.length}`, url: `https://linear.app/acme/issue/TUC-${sent.length}` } } };
    };
    const writer = new AppWriter(new AgentApi(new AppOnlyToken(tokenDirectory, () => NOW), post));
    // No token.
    await assert.rejects(file(home, world, batch, input, { writer }), /nothing was written/);
    // A token expiring within 5 minutes.
    await writeFile(join(tokenDirectory, "token.json"), JSON.stringify({ access_token: "app", expires_at: NOW + 4 * 60_000 }));
    await assert.rejects(file(home, world, batch, input, { writer }), /nothing was written/);
    // A valid token Linear rejects after the first write: the second project fails, never as the owner.
    await writeFile(join(tokenDirectory, "token.json"), JSON.stringify({ access_token: "app", expires_at: NOW + DAY }));
    rejectAfter = 1;
    await assert.rejects(file(home, world, batch, input, { writer }), /nothing was written/);
    assert.deepEqual(sent, ["Bearer app", "Bearer app"]);
    assert.equal((await state(home)).checkpoint, undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("collect and file touch no file outside owner-decisions", async () => {
  const home = await temporary();
  try {
    const world = new World();
    world.comments = [comment("c1", "Always A.", ago(1))];
    const before = await readdir(home);
    const { batch } = await collect(home, world);
    await file(home, world, batch, { projects: [{ project: "ERP", candidates: [candidate(batch.items[0], "Always A.")] }] });
    assert.deepEqual((await readdir(home)).filter((name) => !before.includes(name)), ["owner-decisions"]);
    assert.deepEqual((await readdir(join(home, "owner-decisions"))).sort(), ["batches", "state.json"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the log: duplicates once, only answers to logged questions, private files, kept across a reload", async () => {
  const home = await temporary();
  try {
    const log = new DecisionLog(join(home, "log"), () => NOW);
    await log.append({ kind: "question", id: "a:q1", at: ago(1), identifier: "ISSUE-1", issueId: "issue-1", questions: [{ key: "q0", question: "Which?", options: [] }] });
    // A reload: a new instance reads what the old one wrote.
    const reloaded = new DecisionLog(join(home, "log"), () => NOW);
    await reloaded.answer("a:q1", { behavior: "allow", updatedInput: { answers: { q0: "B" } } });
    await reloaded.answer("a:q1", { behavior: "allow", updatedInput: { answers: { q0: "C" } } });
    await reloaded.answer("a:tool", { behavior: "deny", message: "no" });
    await reloaded.append({ kind: "plan-feedback", id: "old", at: ago(61), identifier: "X", issueId: "x", approved: false, text: "old" });
    await reloaded.append({ kind: "plan-feedback", id: "new", at: ago(0), identifier: "X", issueId: "x", approved: false, text: "new" });
    const entries = await reloaded.entries();
    assert.deepEqual(entries.map((entry) => `${entry.kind} ${entry.id}`), ["question a:q1", "answer a:q1", "plan-feedback new"]);
    assert.deepEqual(entries[1], { kind: "answer", id: "a:q1", at: new Date(NOW).toISOString(), answers: { q0: "B" } });
    assert.equal((await stat(join(home, "log", "log.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, "log"))).mode & 0o777, 0o700);
  } finally { await rm(home, { recursive: true, force: true }); }
});
