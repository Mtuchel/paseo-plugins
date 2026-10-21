import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeIssue } from "../server/context";
import { filterIssues, formatIssueDate, formatPriority, hasPriority, priorityTone, statusChangesText, statusCounts, statusIcon, statusTone } from "./issue-list";

const tickets = [
  normalizeIssue({ id: "a", title: "Fix login", status: "In Progress", labels: ["mobile"], updatedAt: "2026-09-18T10:00:00Z", createdAt: "2026-01-01T00:00:00Z" }),
  normalizeIssue({ id: "b", title: "Login tests", status: "Done", updatedAt: "2026-09-17T10:00:00Z", createdAt: "2026-05-01T00:00:00Z" }),
  normalizeIssue({ id: "c", title: "New login", status: "In Progress", updatedAt: "invalid" }),
  normalizeIssue({ id: "d", title: "Custom workflow", status: "Waiting for review", updatedAt: "2026-09-18T13:00:00+04:00" }),
];

test("status and search combine, including labels and custom workflow statuses", () => {
  assert.deepEqual(filterIssues(tickets, " LOGIN ", "In Progress", "updatedAt", "newest").map((item) => item.id), ["a", "c"]);
  assert.deepEqual(filterIssues(tickets, "mobile", null, "updatedAt", "newest").map((item) => item.id), ["a"]);
  assert.deepEqual(statusCounts(tickets), [["Done", 1], ["In Progress", 2], ["Waiting for review", 1]]);
  assert.equal(filterIssues(tickets, "", "Missing status", "updatedAt", "newest").length, 0);
});

test("dependency filters distinguish tickets that block others from tickets that are blocked", () => {
  const dependencies = [
    normalizeIssue({ id: "blocker", title: "Shared API", relations: { nodes: [{ type: "blocks", issue: { id: "blocker" }, relatedIssue: { id: "waiting" } }] } }),
    normalizeIssue({ id: "blocked", title: "Waiting UI", inverseRelations: { nodes: [{ type: "blocks", issue: { id: "upstream" }, relatedIssue: { id: "blocked" } }] } }),
    normalizeIssue({ id: "free", title: "Independent" }),
  ];
  assert.deepEqual(filterIssues(dependencies, "", null, "updatedAt", "newest", "blocking").map((issue) => issue.id), ["blocker"]);
  assert.deepEqual(filterIssues(dependencies, "", null, "updatedAt", "newest", "blocked").map((issue) => issue.id), ["blocked"]);
  assert.equal(dependencies[0].blockingCount, 1);
  assert.equal(dependencies[1].blockedByCount, 1);
});

test("date sort uses actual timestamps, keeps missing dates last and does not mutate the source", () => {
  assert.deepEqual(filterIssues(tickets, "", null, "updatedAt", "newest").map((item) => item.id), ["a", "d", "b", "c"]);
  assert.deepEqual(filterIssues(tickets, "", null, "updatedAt", "oldest").map((item) => item.id), ["b", "d", "a", "c"]);
  assert.deepEqual(filterIssues(tickets, "", null, "createdAt", "newest").map((item) => item.id), ["b", "a", "c", "d"]);
  assert.deepEqual(filterIssues(tickets, "", null, "createdAt", "oldest").map((item) => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(tickets.map((item) => item.id), ["a", "b", "c", "d"]);
});

test("priority sort orders most-urgent first and keeps no-priority tickets last in both directions", () => {
  const prioritized = [
    normalizeIssue({ id: "p-none", title: "No priority", priority: "" }),
    normalizeIssue({ id: "p-low", title: "Low", priority: "4" }),
    normalizeIssue({ id: "p-urgent", title: "Urgent", priority: "1" }),
    normalizeIssue({ id: "p-medium", title: "Medium", priority: "3" }),
    normalizeIssue({ id: "p-high", title: "High", priority: "2" }),
  ];
  assert.deepEqual(filterIssues(prioritized, "", null, "priority", "newest").map((item) => item.id), ["p-urgent", "p-high", "p-medium", "p-low", "p-none"]);
  assert.deepEqual(filterIssues(prioritized, "", null, "priority", "oldest").map((item) => item.id), ["p-low", "p-medium", "p-high", "p-urgent", "p-none"]);
  // Label-form priorities sort the same as their numbers.
  const labeled = [
    normalizeIssue({ id: "l-none", title: "None", priority: "" }),
    normalizeIssue({ id: "l-high", title: "High", priority: "High" }),
    normalizeIssue({ id: "l-urgent", title: "Urgent", priority: "Urgent" }),
  ];
  assert.deepEqual(filterIssues(labeled, "", null, "priority", "newest").map((item) => item.id), ["l-urgent", "l-high", "l-none"]);
});

test("missing statuses and dates are visible, with created dates preserved by normalization", () => {
  assert.deepEqual(statusCounts([normalizeIssue({ id: "empty", title: "No status" })]), [["No status", 1]]);
  assert.equal(formatIssueDate("invalid"), "No date");
  assert.equal(tickets[0].createdAt, "2026-01-01T00:00:00Z");
});

test("workflow statuses map to visual tones without hard-coding a single workflow", () => {
  assert.equal(statusTone("In Progress"), "active");
  assert.equal(statusTone("Waiting for review"), "review");
  assert.equal(statusTone("Backlog"), "backlog");
  assert.equal(statusTone("Done"), "done");
  assert.equal(statusTone("Canceled"), "canceled");
  assert.equal(statusTone("Blocked on vendor"), "neutral");
  assert.equal(statusTone(""), "neutral");
});

test("workflow categories tone states before name keywords, with a safe fallback", () => {
  assert.equal(statusTone("In Progress", "started"), "active");
  assert.equal(statusTone("In Review", "started"), "active");
  assert.equal(statusTone("Mystery", "started"), "active");
  assert.equal(statusTone("Done", "completed"), "done");
  assert.equal(statusTone("Shipped it", "completed"), "done");
  assert.equal(statusTone("Won't do", "canceled"), "canceled");
  assert.equal(statusTone("Duplicate", "duplicate"), "canceled");
  assert.equal(statusTone("Todo", "unstarted"), "backlog");
  assert.equal(statusTone("Backlog", "backlog"), "backlog");
  assert.equal(statusTone("Needs triage", "triage"), "backlog");
  // Category matching is case- and whitespace-insensitive; unknown categories fall back to the name.
  assert.equal(statusTone("In Review", "  STARTED "), "active");
  assert.equal(statusTone("Waiting for review", "weird"), "review");
  assert.equal(statusTone("Blocked on vendor", "weird"), "neutral");
});

test("status icons distinguish backlog, todo, active and blocked work", () => {
  assert.equal(statusIcon("Backlog", "backlog"), "CircleDashed");
  assert.equal(statusIcon("Todo", "unstarted"), "Circle");
  assert.equal(statusIcon("In Progress", "started"), "CircleFilled");
  assert.equal(statusIcon("Blocked", "unstarted"), "Lock");
  assert.equal(statusIcon("Blocked on vendor", "started"), "Lock");
  assert.equal(statusIcon("In Review", "started"), "ScanEye");
  assert.equal(statusIcon("Done", "completed"), "CircleCheck");
});

test("priority accepts labels and Linear's numeric values", () => {
  assert.equal(formatPriority("1"), "Urgent");
  assert.equal(formatPriority("0"), "No priority");
  assert.equal(formatPriority("High"), "High");
  assert.equal(priorityTone("Urgent"), "urgent");
  assert.equal(priorityTone("2"), "high");
  assert.equal(priorityTone("Medium"), "medium");
  assert.equal(priorityTone("4"), "low");
  assert.equal(priorityTone("No priority"), "none");
  assert.equal(priorityTone(""), "none");
  assert.equal(hasPriority("Low"), true);
  assert.equal(hasPriority("No priority"), false);
});

test("due dates sort with missing dates last, in either direction", () => {
  const withDue = [
    normalizeIssue({ id: "d1", title: "Late", dueDate: "2026-10-20", updatedAt: "2026-09-18T00:00:00Z" }),
    normalizeIssue({ id: "d2", title: "Early", dueDate: "2026-10-01", updatedAt: "2026-09-19T00:00:00Z" }),
    normalizeIssue({ id: "d3", title: "No due date", updatedAt: "2026-09-17T00:00:00Z" }),
  ];
  assert.deepEqual(filterIssues(withDue, "", null, "dueDate", "newest").map((item) => item.id), ["d1", "d2", "d3"]);
  assert.deepEqual(filterIssues(withDue, "", null, "dueDate", "oldest").map((item) => item.id), ["d2", "d1", "d3"]);
});

test("status history text summarizes state spans from a context snapshot", () => {
  const context = JSON.stringify({ issue: {}, comments: [], stateHistory: [
    { state: "Todo", startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-02T00:00:00Z" },
    { state: "In Progress", startedAt: "2026-09-02T00:00:00Z", endedAt: null },
  ]});
  assert.equal(statusChangesText(context), "Todo → In Progress");
  assert.equal(statusChangesText(JSON.stringify({ issue: {}, comments: [], stateHistory: [{ state: "Done" }] })), null);
  assert.equal(statusChangesText(JSON.stringify({ issue: {}, comments: [] })), null);
  assert.equal(statusChangesText("not json"), null);
});

