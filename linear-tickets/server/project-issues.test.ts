import assert from "node:assert/strict";
import test from "node:test";
import type { GroupIssue, ProjectChanges, ProjectIssue } from "./linear";
import { FULL_READ_MS, OVERLAP_MS, ProjectIssueCache } from "./project-issues";

const MINUTE = 60_000;
const START = Date.parse("2026-10-07T10:00:00Z");
const issue = (n: number, change: Partial<ProjectIssue> = {}): ProjectIssue => ({
  id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, priority: 3, createdAt: "2026-10-01T00:00:00Z", status: "Todo", statusType: "unstarted",
  teamId: "t1", teamKey: "TUC", creatorId: null, assigneeId: null, delegateId: null, labels: [], parentId: null, blockers: [], blocks: [], linked: [], ...change,
});
const blocker = (id: string, finished: boolean): GroupIssue => ({ id, identifier: id.toUpperCase(), status: finished ? "Done" : "In Progress", statusType: finished ? "completed" : "started", delegateId: null, finished });

// Linear as the cache reads it: `project`, what a full read returns; `changes`, what the next
// changed-only read returns; `blockers`, the blockers' current states. `reads` logs each call.
function harness() {
  let now = START;
  const reads: string[] = [];
  const linear = {
    project: [] as ProjectIssue[],
    changes: { open: [], closed: [], moved: [] } as ProjectChanges,
    blockers: [] as GroupIssue[],
    fail: false,
    projectIssues: async (projectId: string) => { reads.push(`full ${projectId}`); return linear.project; },
    projectIssuesChanged: async (projectId: string, since: string, known: string[]) => {
      reads.push(`changed ${projectId} since ${since} of ${known.join(",")}`);
      if (linear.fail) throw new Error("Linear's hourly request limit is reached");
      return linear.changes;
    },
    blockerStates: async (ids: string[]) => { reads.push(`blockers ${ids.join(",")}`); return linear.blockers.filter((item) => ids.includes(item.id)); },
  };
  const cache = new ProjectIssueCache(linear, () => now);
  return { linear, cache, reads, advance: (ms: number) => { now += ms; } };
}

test("a project is read in full first, then only as changed until the full read is due again, or when asked for", async () => {
  const h = harness();
  h.linear.project = [issue(1)];
  await h.cache.read("erp");
  h.advance(3 * MINUTE);
  await h.cache.read("erp");
  h.advance(FULL_READ_MS - 3 * MINUTE - 1);
  await h.cache.read("erp");
  h.advance(1);
  await h.cache.read("erp");
  await h.cache.read("erp", true);
  assert.deepEqual(h.reads.filter((read) => !read.startsWith("blockers")).map((read) => read.split(" since ")[0]), ["full erp", "changed erp", "changed erp", "full erp", "full erp"]);
  assert.equal(h.reads[1], `changed erp since ${new Date(START - OVERLAP_MS).toISOString()} of i1`, "from the start of the last read, with an overlap, over the tickets known so far");
});

test("a changed-only read updates changed tickets, adds new ones, and drops the ones closed or moved away with what pointed at them", async () => {
  const h = harness();
  h.linear.project = [issue(1), issue(2, { parentId: "i1", blocks: ["i3"] }), issue(3), issue(4, { parentId: "i5" }), issue(5)];
  await h.cache.read("erp");
  h.advance(3 * MINUTE);
  h.linear.changes = { open: [issue(6), issue(2, { parentId: "i1", blocks: ["i3"], delegateId: "paseo-app" })], closed: ["i3"], moved: ["i5"] };
  const read = await h.cache.read("erp");
  assert.deepEqual(read.map((item) => [item.id, item.delegateId, item.parentId, item.blocks]), [
    ["i1", null, null, []],
    ["i2", "paseo-app", "i1", []],
    ["i4", null, null, []],
    ["i6", null, null, []],
  ]);
});

test("a ticket waiting on a blocker is free once the blocker finishes, though the ticket itself did not change", async () => {
  const h = harness();
  h.linear.project = [issue(1, { blockers: [blocker("b1", false), blocker("b2", false), blocker("b3", true)] })];
  await h.cache.read("erp");
  h.advance(3 * MINUTE);
  h.linear.blockers = [blocker("b1", true)];
  const [waiting] = await h.cache.read("erp");
  assert.deepEqual(waiting.blockers.map((item) => [item.id, item.finished]), [["b1", true], ["b2", false], ["b3", true]], "b2 Linear did not return: still waited on; b3 finished: not asked again");
  assert.equal(h.reads.at(-1), "blockers b1,b2");
});

test("a failed changed-only read changes nothing, so the next one covers the same time again", async () => {
  const h = harness();
  h.linear.project = [issue(1)];
  await h.cache.read("erp");
  h.advance(3 * MINUTE);
  h.linear.fail = true;
  await assert.rejects(h.cache.read("erp"), /hourly request limit/);
  h.advance(3 * MINUTE);
  h.linear.fail = false;
  h.linear.changes = { open: [], closed: ["i1"], moved: [] };
  assert.deepEqual(await h.cache.read("erp"), []);
  const since = h.reads.filter((read) => read.startsWith("changed")).map((read) => read.split(" since ")[1].split(" ")[0]);
  assert.deepEqual(since, [new Date(START - OVERLAP_MS).toISOString(), new Date(START - OVERLAP_MS).toISOString()]);
});
