import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { ghostAgents, ticketProcessLiveness, type ProcessAgent, type ProcessInspector } from "./process-liveness";

const ISSUE = "issue-1";
const HANDLE = "/home/mirko/.omp/agent/sessions/worktree/2026-10-05T11-05-57-212Z_01a10bbd-e6dc-7761-93d1-081ca47d9501.jsonl";
const worker = (change: ProcessAgent = {}): ProcessAgent => ({
  id: "root-1", provider: "omp", cwd: "/repo/worktree", status: "closed",
  labels: { "linear.issueId": ISSUE },
  runtimeInfo: { provider: "omp", sessionId: "01a10bbd-e6dc-7761-93d1-081ca47d9501" },
  persistence: { provider: "omp", sessionId: "01a10bbd-e6dc-7761-93d1-081ca47d9501", nativeHandle: HANDLE },
  ...change,
});

function daemon(agents: ProcessAgent[], pageSize = 200): PaseoApi {
  return {
    agents: {
      list: async (input: { filter: { labels: Record<string, string>; includeArchived: boolean }; page: { cursor?: string } }) => {
        const roots = agents.filter((agent) => agent.labels?.["linear.issueId"] === input.filter.labels["linear.issueId"]
          && (input.filter.includeArchived || !agent.archivedAt));
        const offset = Number(input.page.cursor ?? 0);
        const hasMore = offset + pageSize < roots.length;
        return { entries: roots.slice(offset, offset + pageSize).map((agent) => ({ agent })), pageInfo: { hasMore, nextCursor: hasMore ? String(offset + pageSize) : null } };
      },
    },
  } as unknown as PaseoApi;
}

function inspection(output: string, cwds: Record<number, string | Error> = {}): ProcessInspector {
  return {
    processes: async () => output,
    cwd: async (pid) => {
      const cwd = cwds[pid];
      if (typeof cwd !== "string") throw cwd ?? new Error("Cannot inspect cwd.");
      return cwd;
    },
    canonicalPath: async (path) => path,
  };
}

// Each test invokes the production ticket-wide enumeration and exact-identity decision.
test("closed and archived OMP roots retain ownership while their exact native process is alive", async () => {
  for (const change of [{}, { status: "idle", archivedAt: "2026-10-06T00:00:00Z" }] as const) {
    assert.equal(await ticketProcessLiveness(daemon([worker(change)]), ISSUE, [], inspection(`2100185 omp --mode rpc-ui --session ${HANDLE}\n`)), "alive");
  }
});

test("an archived older sibling on a later page is checked, not just the predecessor", async () => {
  const agents = [worker({ id: "predecessor", persistence: null, runtimeInfo: undefined }), worker({ id: "older", archivedAt: "now" })];
  assert.equal(await ticketProcessLiveness(daemon(agents, 1), ISSUE, [], inspection(`2100185 /usr/bin/omp --mode=rpc-ui --session=${HANDLE}\n`)), "alive");
});

test("exact identities, not session substrings or unrelated processes, determine ownership", async () => {
  for (const output of [
    `1 omp --mode rpc-ui --session ${HANDLE}.other\n`,
    `1 omp --mode rpc-ui --session /unrelated.jsonl\n`,
    `1 echo omp --mode rpc-ui --session ${HANDLE}\n`,
    `1 omp --mode print --session ${HANDLE}\n`,
    "",
  ]) {
    assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection(output)), "absent", output);
  }
  assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection("1 node /usr/bin/omp --mode rpc-ui --session 01a10bbd-e6dc-7761-93d1-081ca47d9501\n")), "alive");
});

test("sessionless fresh OMP workers use exact worktree cwd; another worktree does not block", async () => {
  const output = "2100185 omp --mode rpc-ui\n";
  assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection(output, { 2100185: "/repo/worktree" })), "alive");
  assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection(output, { 2100185: "/repo/worktree-other" })), "absent");
  assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection(output, { 2100185: new Error("EACCES") })), "unknown");
});

test("an unarchived idle or running agent's expected process is not an orphan", async () => {
  const failing: ProcessInspector = { ...inspection(""), processes: async () => { throw new Error("Must not inspect an expected managed process."); } };
  for (const status of ["idle", "running", "initializing"] as const) {
    assert.equal(await ticketProcessLiveness(daemon([worker({ status })]), ISSUE, [], failing), "absent");
  }
});

test("other tickets, subagents and non-OMP recovery do not inherit the OMP guard", async () => {
  const agents = [worker({ labels: { "linear.issueId": "other-ticket" } }), worker({ id: "child", labels: { "linear.issueId": ISSUE, "paseo.parent-agent-id": "root" } }), worker({ id: "claude", provider: "claude" })];
  assert.equal(await ticketProcessLiveness(daemon(agents), ISSUE, [], inspection(`2100185 omp --mode rpc-ui --session ${HANDLE}\n`)), "absent");
});

test("failed or incomplete inspection is not confirmed absence", async () => {
  const paseo = daemon([worker()]);
  const failed: ProcessInspector = { ...inspection(""), processes: async () => { throw new Error("ps failed"); } };
  assert.equal(await ticketProcessLiveness(paseo, ISSUE, [], failed), "unknown");
  assert.equal(await ticketProcessLiveness(paseo, ISSUE, [], inspection("truncated listing\n")), "unknown");
  assert.equal(await ticketProcessLiveness(paseo, ISSUE, [], inspection("1 omp --mode rpc-ui --session\n")), "unknown");
  const inaccessible = { agents: { list: async () => { throw new Error("daemon disconnected"); } } } as unknown as PaseoApi;
  assert.equal(await ticketProcessLiveness(inaccessible, ISSUE, [], inspection("")), "unknown");
  const incomplete = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } }) } } as unknown as PaseoApi;
  assert.equal(await ticketProcessLiveness(incomplete, ISSUE, [], inspection("")), "unknown");
});

test("a missing native handle does not mistake an absolute JSONL argument for a different session", async () => {
  assert.equal(await ticketProcessLiveness(daemon([worker({ persistence: null })]), ISSUE, [], inspection(`1 omp --mode rpc-ui --session ${HANDLE}\n`)), "unknown");
  assert.equal(await ticketProcessLiveness(daemon([worker({ persistence: null })]), ISSUE, [], inspection("")), "absent");
});

test("a removed worktree does not discard the recorded native handle", async () => {
  const inspect = inspection(`2100185 omp --mode rpc-ui --session ${HANDLE}\n`);
  // canonicalPath returns the original path on ENOENT, just as the default reader does.
  assert.equal(await ticketProcessLiveness(daemon([worker({ cwd: "/removed/worktree" })]), ISSUE, [], inspect), "alive");
});

test("an earlier direct idle snapshot cannot erase a newly archived process owner", async () => {
  assert.equal(await ticketProcessLiveness(daemon([worker({ archivedAt: "now" })]), ISSUE, [worker({ status: "idle" })], inspection(`2100185 omp --mode rpc-ui --session ${HANDLE}\n`)), "alive");
});

test("an interpreter-launched rpc-ui worker cannot hide a same-worktree owner", async () => {
  const output = "2100185 bun /opt/omp/packages/coding-agent/src/cli.ts --mode rpc-ui\n";
  assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection(output, { 2100185: "/repo/worktree" })), "alive");
  assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection(output, { 2100185: "/repo/other" })), "absent");
});

test("missing pagination metadata and ambiguous session arguments cannot establish absence", async () => {
  const missingPage = { agents: { list: async () => ({ entries: [{ agent: worker() }] }) } } as unknown as PaseoApi;
  assert.equal(await ticketProcessLiveness(missingPage, ISSUE, [], inspection("")), "unknown");
  assert.equal(await ticketProcessLiveness(daemon([worker()]), ISSUE, [], inspection(`1 omp --mode rpc-ui --session /other.jsonl --session ${HANDLE}\n`)), "unknown");
});

// 2026-10-05 18:09: a daemon crash left agents listed running or idle without a process.
const NOW = Date.parse("2026-10-06T10:00:00Z");
const quiet = (change: ProcessAgent = {}) => worker({ status: "running", updatedAt: "2026-10-05T18:09:44Z", ...change });
const ghosts = async (agents: ProcessAgent[], inspect: ProcessInspector) => [...await ghostAgents(agents, NOW, inspect)];

test("an idle or running OMP agent with no process of its session or in its worktree is a ghost", async () => {
  const other = "2100190 omp --mode rpc-ui --session /home/mirko/.omp/agent/sessions/x/other.jsonl\n2100191 omp --mode rpc-ui\n";
  for (const status of ["running", "idle"] as const) {
    assert.deepEqual(await ghosts([quiet({ status })], inspection(other, { 2100190: "/repo/other", 2100191: "/repo/other" })), ["root-1"], status);
    assert.deepEqual(await ghosts([quiet({ status })], inspection("")), ["root-1"], `${status}, no OMP process at all`);
  }
});

test("its session, any rpc-ui process in its worktree, or a recent update keeps an agent live", async () => {
  assert.deepEqual(await ghosts([quiet()], inspection(`2100185 omp --mode rpc-ui --session ${HANDLE}\n`)), [], "its session");
  assert.deepEqual(await ghosts([quiet()], inspection("2100185 omp --mode rpc-ui --session 01a10bbd-e6dc-7761-93d1-081ca47d9501\n")), [], "its session id");
  assert.deepEqual(await ghosts([quiet()], inspection("2100185 omp --mode rpc-ui\n", { 2100185: "/repo/worktree" })), [], "a fresh process in its worktree");
  assert.deepEqual(await ghosts([quiet()], inspection("2100185 omp --mode rpc-ui --session /x/other.jsonl\n", { 2100185: "/repo/worktree" })), [], "another session in its worktree");
  assert.deepEqual(await ghosts([quiet({ updatedAt: "2026-10-06T09:57:00Z" })], inspection("")), [], "updated 3 minutes ago: may still be starting");
});

test("only unarchived idle or running OMP agents with a full identity can be ghosts", async () => {
  for (const change of [{ status: "initializing" }, { status: "closed" }, { status: "error" }, { archivedAt: "2026-10-06T00:00:00Z" }, { provider: "claude" },
    { persistence: null }, { persistence: { provider: "omp", sessionId: "s", nativeHandle: "/path with space.jsonl" } }, { cwd: "relative" }, { updatedAt: undefined }] as const) {
    assert.deepEqual(await ghosts([quiet(change as ProcessAgent)], inspection("")), [], JSON.stringify(change));
  }
});

test("an inspection that fails anywhere reports no ghost", async () => {
  const failed: ProcessInspector = { ...inspection(""), processes: async () => { throw new Error("ps failed"); } };
  assert.deepEqual(await ghosts([quiet()], failed), []);
  assert.deepEqual(await ghosts([quiet()], inspection("2100185 omp --mode rpc-ui\n", { 2100185: new Error("ENOENT") })), [], "a process vanished mid-inspection");
  assert.deepEqual(await ghosts([quiet()], inspection("truncated listing\n")), []);
});

test("one live agent in a worktree does not hide another agent's absence elsewhere", async () => {
  const elsewhere = quiet({ id: "root-2", cwd: "/repo/worktree-2", persistence: { provider: "omp", sessionId: "s2", nativeHandle: "/sessions/s2.jsonl" }, runtimeInfo: undefined });
  assert.deepEqual(await ghosts([quiet(), elsewhere], inspection(`2100185 omp --mode rpc-ui --session ${HANDLE}\n`)), ["root-2"]);
});
