import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { GreptileOutage, OUTAGE_MARKER, OUTAGE_TITLE, type RetriggerResult } from "./greptile-outage";
import type { RetriggerPull, RetriggerRun } from "./queue-backstop";

const OWNER = "https://linear.app/ws/profiles/owner";
const url = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;
const ASKED = "2026-10-07T08:05:00Z";

type Issue = { id: string; identifier: string; url: string; description: string; statusType: string; comments: string[] };

// Linear as the outage issue sees it. `create`: `lost` stores the issue and then fails (the answer
// was lost), `refused` fails before storing anything; `reads` false makes every lookup fail.
class FakeLinear {
  issues = new Map<string, Issue>();
  creates: Record<string, unknown>[] = [];
  updates = 0;
  create: "ok" | "lost" | "refused" = "ok";
  reads = true;

  async createIssue(input: { id?: string; title: string; description: string }) {
    this.creates.push(input);
    if (this.create === "refused") throw new Error("socket hang up");
    const id = input.id ?? `generated-${this.creates.length}`;
    const issue = { id, identifier: `TUC-${100 + this.issues.size}`, url: `https://linear.app/t/issue/${id}`, description: input.description, statusType: "unstarted", comments: [] };
    this.issues.set(id, issue);
    if (this.create === "lost") throw new Error("timeout");
    return { id, identifier: issue.identifier, url: issue.url };
  }
  async issueById(id: string) {
    if (!this.reads) throw new Error("Linear is unavailable");
    const issue = this.issues.get(id);
    return issue ? { id, identifier: issue.identifier, url: issue.url, createdAt: "2026-10-07T08:00:00Z" } : null;
  }
  async issueState(id: string) {
    const issue = this.issues.get(id);
    if (!issue) throw new Error("Linear did not return this issue.");
    return { statusType: issue.statusType } as never;
  }
  async updateDescription(id: string, description: string) {
    this.updates++;
    this.issues.get(id)!.description = description;
  }
  async comment(id: string, body: string) { this.issues.get(id)!.comments.push(body); }
  async complete(id: string) { this.issues.get(id)!.statusType = "completed"; }
  async teamIdByKey(key: string) { return key === "TUC" ? "team" : null; }
  async viewerId() { return "owner"; }
  async userUrl() { return OWNER; }
  async issuesMentioning(_team: string, text: string, openOnly = false) {
    return [...this.issues.values()]
      .filter((issue) => issue.description.includes(text) && (!openOnly || !["completed", "canceled", "duplicate"].includes(issue.statusType)))
      .map((issue) => ({ ...issue, title: OUTAGE_TITLE, status: "", project: "", comments: [] }));
  }
  open(): Issue[] {
    return [...this.issues.values()].filter((issue) => !["completed", "canceled"].includes(issue.statusType));
  }
}

async function setup(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "paseo-greptile-outage-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const linear = new FakeLinear();
  const path = join(home, "greptile-outage.json");
  const settings = { read: async () => ({ dispatch: { teamKeys: ["TUC"] } }) as never };
  const outage = () => new GreptileOutage(linear, settings, path);
  return { linear, path, outage };
}

const pull = (repo: string, pr: number, overdue: boolean, triggers = [ASKED]): RetriggerPull => ({ pr, url: url(repo, pr), title: `PR ${pr}`, head: "h".repeat(40), since: "2026-10-07T07:30:00Z", triggers, state: "requested", overdue });
const answer = (repo: string, pulls: RetriggerPull[], followed: RetriggerRun["followed"] = [], errors: RetriggerRun["errors"] = []): RetriggerResult => ({ repo, result: "answer", run: { pulls, followed, triggered: [], errors } });

test("the issue opens only once a request is 2 hours old, once, with every waiting pull request (AC-5)", async (t) => {
  const { linear, outage } = await setup(t);
  await outage().sync([answer("o/r", [pull("o/r", 1, false)])]);
  assert.equal(linear.creates.length, 0, "not before 2 hours");

  const run = [answer("o/r", [pull("o/r", 1, true), pull("o/r", 2, false), pull("o/r", 3, false, [])])];
  await outage().sync(run);
  await outage().sync(run);
  assert.equal(linear.creates.length, 1, "opened once");
  const { description, ...fields } = linear.creates[0] as Record<string, unknown> & { description: string; id: string };
  assert.match(fields.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...fields, id: "uuid" }, { id: "uuid", teamId: "team", projectId: null, title: OUTAGE_TITLE, assigneeId: "owner", priority: 2, ready: true });
  assert.ok(description.startsWith(OUTAGE_MARKER), description);
  assert.ok(description.includes(OWNER), "mentions the owner");
  assert.ok(description.includes(`- [#1 PR 1](${url("o/r", 1)}) — Greptile re-requested 10:05 (1×)`), description);
  assert.ok(description.includes(`- [#2 PR 2](${url("o/r", 2)}) — Greptile re-requested 10:05 (1×)`), description);
  assert.ok(description.includes(`- [#3 PR 3](${url("o/r", 3)}) — not asked yet`), description);
  assert.equal(linear.updates, 0, "an unchanged list is not written again");
});

test("a failed repo keeps the issue open with its pull requests not read; outcomes recorded early stay for the closing comment (AC-5)", async (t) => {
  const { linear, outage } = await setup(t);
  await outage().sync([answer("o/r", [pull("o/r", 1, true)]), answer("o/x", [pull("o/x", 7, false)])]);
  assert.deepEqual([...(await outage().follow())], [["o/r", [1]], ["o/x", [7]]]);

  await outage().sync([answer("o/r", [], [{ pr: 1, state: "reviewed" }]), { repo: "o/x", result: "failed", error: "exit 1" }]);
  const [issue] = linear.open();
  assert.ok(issue, "nothing completes while a repo failed");
  assert.ok(issue.description.includes(`[#7 PR 7](${url("o/x", 7)}) — Greptile re-requested 10:05 (1×) (not read this run)`), issue.description);
  assert.ok(issue.description.includes(`[#1 PR 1](${url("o/r", 1)}) — reviewed`), issue.description);
  assert.deepEqual([...(await outage().follow())], [["o/x", [7]]], "a pull request with an outcome is no longer followed");

  await outage().sync([answer("o/r", []), answer("o/x", [], [{ pr: 7, state: "closed" }])]);
  assert.equal(issue.statusType, "completed");
  assert.deepEqual(issue.comments, [`✅ No pull request waits for Greptile any more:\n\n- [#1 PR 1](${url("o/r", 1)}) — reviewed\n- [#7 PR 7](${url("o/x", 7)}) — closed`]);
  assert.deepEqual([...(await outage().follow())], [], "the state is cleared");
  assert.equal(linear.creates.length, 1);
});

test("an errors entry or an unread follow is no recovery (AC-5)", async (t) => {
  const { linear, outage } = await setup(t);
  await outage().sync([answer("o/r", [pull("o/r", 1, true)])]);
  await outage().sync([answer("o/r", [], [{ pr: 1, state: "unread" }], [{ pr: 1, error: "HTTP 502" }])]);
  assert.equal(linear.open().length, 1);
  assert.ok(linear.open()[0].description.includes("(not read this run)"));
});

test("a create whose answer was lost while Linear could not be read is adopted by its id on the next run, then completed (AC-5)", async (t) => {
  const { linear, outage } = await setup(t);
  linear.create = "lost";
  linear.reads = false;
  await assert.rejects(outage().sync([answer("o/r", [pull("o/r", 1, true)])]));
  linear.create = "ok";
  linear.reads = true;
  await outage().sync([answer("o/r", [], [{ pr: 1, state: "reviewed" }])]);
  assert.equal(linear.creates.length, 1, "no second create");
  const [issue] = linear.issues.values();
  assert.equal(issue.statusType, "completed");
  assert.equal(issue.comments.length, 1);
});

test("a create that never went through is retried under the same id while a pull request is overdue (AC-5)", async (t) => {
  const { linear, outage } = await setup(t);
  linear.create = "refused";
  await assert.rejects(outage().sync([answer("o/r", [pull("o/r", 1, true)])]));
  linear.create = "ok";
  await outage().sync([answer("o/r", [pull("o/r", 1, true)])]);
  assert.equal(linear.creates.length, 2);
  assert.equal(linear.creates[1].id, linear.creates[0].id, "the reserved id is reused");
  assert.equal(linear.issues.size, 1);
});

test("a reservation whose issue never came into being is cleared once nothing is overdue, without filing one (AC-5)", async (t) => {
  const { linear, outage } = await setup(t);
  linear.create = "refused";
  await assert.rejects(outage().sync([answer("o/r", [pull("o/r", 1, true)])]));
  linear.create = "ok";
  await outage().sync([answer("o/r", [pull("o/r", 1, false)])]);
  assert.equal(linear.creates.length, 1);
  assert.equal(linear.issues.size, 0);
  assert.deepEqual([...(await outage().follow())], []);
});

test("a lost state file while a pull request is overdue re-adopts the open issue by its marker instead of filing a second (AC-5)", async (t) => {
  const { linear, path, outage } = await setup(t);
  await outage().sync([answer("o/r", [pull("o/r", 1, true)])]);
  await rm(path);
  await outage().sync([answer("o/r", [pull("o/r", 1, true)])]);
  await outage().sync([answer("o/r", [pull("o/r", 1, true), pull("o/r", 2, false)])]);
  assert.equal(linear.creates.length, 1);
  assert.ok(linear.open()[0].description.includes(`[#2 PR 2](${url("o/r", 2)})`), "the adopted issue is updated");
});

test("a lost state file with nothing overdue adopts the open issue, follows its listed pull requests and completes it (AC-5)", async (t) => {
  const { linear, path, outage } = await setup(t);
  await outage().sync([answer("o/r", [pull("o/r", 1, true), pull("o/r", 2, false)])]);
  await rm(path);
  await outage().sync([answer("o/r", [])]);
  assert.equal(linear.open().length, 1, "not completed in the run that adopted it");
  assert.deepEqual([...(await outage().follow())], [["o/r", [1, 2]]]);
  await outage().sync([answer("o/r", [], [{ pr: 1, state: "reviewed" }, { pr: 2, state: "unlabelled" }])]);
  const [issue] = linear.issues.values();
  assert.equal(issue.statusType, "completed");
  assert.ok(issue.comments[0].includes("#1 PR 1") && issue.comments[0].includes("#2 PR 2") && issue.comments[0].includes("`complex-review` removed"), issue.comments[0]);
  assert.equal(linear.creates.length, 1);
});

test("a person's close holds until a complete run finds nothing waiting; a later outage files a new issue (AC-5)", async (t) => {
  const { linear, outage } = await setup(t);
  await outage().sync([answer("o/r", [pull("o/r", 1, true)])]);
  const [first] = linear.issues.values();
  first.statusType = "canceled";
  await outage().sync([answer("o/r", [pull("o/r", 1, true), pull("o/r", 2, true)])]);
  assert.equal(first.statusType, "canceled", "not reopened");
  assert.equal(linear.updates, 0, "not updated");
  assert.equal(linear.creates.length, 1, "no new issue during the same outage");

  await outage().sync([answer("o/r", [], [{ pr: 1, state: "unread" }], [{ pr: 1, error: "HTTP 502" }])]);
  await outage().sync([answer("o/r", [pull("o/r", 2, true)], [{ pr: 1, state: "reviewed" }])]);
  assert.equal(linear.creates.length, 1, "an unread run and a run that still waits keep it dismissed");

  await outage().sync([answer("o/r", [], [{ pr: 2, state: "reviewed" }])]);
  assert.deepEqual([...(await outage().follow())], [], "cleared once nothing waits");
  await outage().sync([answer("o/r", [pull("o/r", 3, true)])]);
  assert.equal(linear.creates.length, 2, "a later outage files a new issue");
  assert.equal(first.comments.length, 0);
});
