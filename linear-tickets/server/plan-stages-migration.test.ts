import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogLabel, IssueCore, LabeledTicket, StateMove, StewardIssue } from "./linear";
import { runModelLabels, runReviewVictims, runStages, type HostEvidence, type MigrationLinear } from "./plan-stages-migration";

type Ticket = StewardIssue & { attachmentUrls: string[]; moves: StateMove[]; archived?: boolean };

function ticket(n: number, status: string, labels: string[] = [], extra: Partial<Ticket> = {}): Ticket {
  const statusType = ["Todo"].includes(status) ? "unstarted" : status === "Backlog" ? "backlog" : status === "Done" ? "completed" : "started";
  return { id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, status, statusType, teamId: "t1", teamKey: "TUC", projectId: null, projectName: null, delegateId: "app", parentId: null, labels: labels.map((name) => ({ id: name, name })), children: [], blockers: [], attachments: [], updatedAt: null, attachmentUrls: [], moves: [], ...extra };
}

// A Linear holding `tickets`, recording every write. `onRead`: runs before each issueCore read, so a
// test can change a ticket between the listing and the write.
function fakeLinear(tickets: Ticket[], catalog: CatalogLabel[] = [], options: { onRead?: (id: string) => void; failMove?: Set<string> } = {}) {
  const writes: string[] = [];
  const byId = new Map(tickets.map((item) => [item.id, item]));
  // Listings are snapshots, like Linear's answers.
  const linear: MigrationLinear = {
    stewardIssues: async ({ labels, states }) => tickets.filter((item) => !["completed", "canceled"].includes(item.statusType)
      && (item.labels.some((label) => labels.includes(label.name)) || (item.statusType === "started" && (states ?? []).includes(item.status)))).map((item) => ({ ...item, labels: [...item.labels] })),
    issueCore: async (id) => {
      options.onRead?.(id);
      const found = byId.get(id)!;
      return { id, identifier: found.identifier, status: found.status, statusId: found.status, statusType: found.statusType, teamId: "t1", projectId: null, creatorId: null, labels: found.labels, attachmentUrls: found.attachmentUrls } satisfies IssueCore;
    },
    moveToPlanStage: async (id, stage) => {
      if (options.failMove?.has(id)) { options.failMove.delete(id); throw new Error("Linear is down"); }
      const found = byId.get(id)!;
      if (found.status === stage) return { changed: false };
      writes.push(`${found.identifier} -> ${stage}`);
      found.status = stage; found.statusType = "started";
      return { changed: true, moved: stage };
    },
    moveToReview: async (id) => { const found = byId.get(id)!; writes.push(`${found.identifier} -> In Review`); found.status = "In Review"; return { changed: true }; },
    stateMoves: async (id) => byId.get(id)!.moves,
    trustedAppIds: async () => ["app", "peer-app"],
    issuesWithLabels: async (names) => tickets.filter((item) => item.labels.some((label) => names.includes(label.name))).map((item): LabeledTicket => ({ id: item.id, identifier: item.identifier, status: item.status, statusType: item.statusType, labels: item.labels })),
    changeLabels: async (id, added, removed) => {
      const found = byId.get(id)!;
      writes.push(`${found.identifier} +${added.join(",")} -${removed.join(",")}`);
      found.labels = [...found.labels.filter((label) => !removed.includes(label.id)), ...added.map((name) => ({ id: name, name }))];
    },
    labelCatalog: async () => catalog,
    createLabel: async (input) => { writes.push(`create ${input.name}${input.isGroup ? " (group)" : ""}`); catalog.push({ id: "g", name: input.name, isGroup: Boolean(input.isGroup), parentId: null, teamId: null }); return "g"; },
    moveLabelIntoGroup: async (labelId, groupId, name) => { writes.push(`group ${name}`); catalog.find((item) => item.id === labelId)!.parentId = groupId; },
    moveLabelOutOfGroup: async (labelId, name) => { writes.push(`ungroup ${name}`); catalog.find((item) => item.id === labelId)!.parentId = null; },
  };
  return { linear, writes };
}

function host(evidence: { parked?: string[]; review?: Record<string, string | null>; queued?: string[]; live?: Record<string, string[]> }): HostEvidence {
  return {
    parked: async (id) => (evidence.parked ?? []).includes(id),
    review: async (id) => id in (evidence.review ?? {}) ? { agentId: evidence.review![id] } : null,
    queued: async (id) => (evidence.queued ?? []).includes(id),
    liveAgents: async (id) => evidence.live?.[id] ?? [],
  };
}

// AC-13 (TUC-1289): the stage correction moves only what this host's evidence proves.
test("stages: a dry run lists every ticket with evidence and verdict and writes nothing; apply writes only the two proven moves", async () => {
  const tickets = () => [
    ticket(1, "Planning"), // parked plan -> Plan review
    ticket(2, "Planning"), // its agent's own review is open; that agent is live -> Plan review
    ticket(3, "Todo", ["plan-ready"]), // queued thread -> Plan approved
    ticket(4, "Planning", ["plan-ready"]), // queued thread -> Plan approved
    ticket(5, "Planning"), // nothing on this host: the other host may own it
    ticket(6, "Planning", ["plan-ready"]), // parked and plan-ready: conflict
    ticket(7, "Planning"), // an agent drafts it
    ticket(8, "Todo", ["plan-ready"]), // approved for later: no queued thread
    ticket(9, "Plan review"), // parked: already right
    ticket(10, "In Progress", ["plan-ready"]), // implementing: not listed
    ticket(11, "Todo"), // not listed
  ];
  const evidence = host({ parked: ["i1", "i6", "i9"], review: { i2: "planner-2" }, queued: ["i3", "i4"], live: { i2: ["planner-2"], i7: ["planner-7"] } });
  const dry = fakeLinear(tickets());
  const rows = await runStages({ linear: dry.linear, host: evidence, teamKeys: ["TUC"], apply: false });
  assert.deepEqual(dry.writes, []);
  assert.deepEqual(rows.map((row) => `${row.identifier}: ${row.verdict}`), [
    "TUC-1: move to Plan review",
    "TUC-2: move to Plan review",
    "TUC-3: move to Plan approved",
    "TUC-4: move to Plan approved",
    "TUC-5: unresolved - no evidence on this host",
    "TUC-6: unresolved - review and approval evidence conflict",
    "TUC-7: unresolved - an agent works on the ticket",
    "TUC-8: unresolved - no evidence on this host",
    "TUC-9: correct - waits for the owner's review",
  ]);
  assert.deepEqual(rows.find((row) => row.identifier === "TUC-6")?.evidence, ["parked plan", "plan-ready"]);
  const wet = fakeLinear(tickets());
  await runStages({ linear: wet.linear, host: evidence, teamKeys: ["TUC"], apply: true });
  assert.deepEqual(wet.writes, ["TUC-1 -> Plan review", "TUC-2 -> Plan review", "TUC-3 -> Plan approved", "TUC-4 -> Plan approved"]);
});

test("stages: a ticket changed since the listing is skipped, and a rerun after an interrupted apply finishes the rest without repeating", async () => {
  const tickets = [ticket(1, "Planning"), ticket(2, "Planning"), ticket(3, "Planning")];
  let changed = false;
  const { linear, writes } = fakeLinear(tickets, [], {
    // TUC-2 gets plan-ready between the listing and its write; TUC-3's write fails once.
    onRead: (id) => { if (id === "i2" && !changed) { changed = true; tickets[1].labels = [{ id: "plan-ready", name: "plan-ready" }]; } },
    failMove: new Set(["i3"]),
  });
  const evidence = host({ parked: ["i1", "i2", "i3"] });
  const first = await runStages({ linear, host: evidence, teamKeys: ["TUC"], apply: true });
  assert.deepEqual(first.map((row) => `${row.identifier}: ${row.result}`), ["TUC-1: moved to Plan review", "TUC-2: skipped: labels changed since the listing", "TUC-3: failed: Linear is down"]);
  const second = await runStages({ linear, host: evidence, teamKeys: ["TUC"], apply: true });
  assert.deepEqual(writes, ["TUC-1 -> Plan review", "TUC-3 -> Plan review"]);
  assert.deepEqual(second.map((row) => `${row.identifier}: ${row.verdict}${row.result ? ` (${row.result})` : ""}`), ["TUC-1: correct - waits for the owner's review", "TUC-2: unresolved - review and approval evidence conflict", "TUC-3: move to Plan review (moved to Plan review)"]);
});

test("review-victims: lists Paseo app moves into Plan review before the cutoff with a pull request and no review here; apply moves only named, unchanged candidates", async () => {
  const pr = ["https://github.com/o/r/pull/1"];
  const before = (actorId: string | null = "app"): StateMove[] => [{ at: "2026-10-10T09:00:00.000Z", actorId, status: "Plan review", statusType: "started" }];
  const tickets = [
    ticket(1, "Plan review", [], { attachmentUrls: pr, moves: before() }), // victim
    ticket(2, "Plan review", [], { attachmentUrls: pr, moves: before("peer-app") }), // victim of the peer's app, not named
    ticket(3, "Plan review", [], { attachmentUrls: pr, moves: before() }), // parked here: a real review
    ticket(4, "Plan review", [], { attachmentUrls: pr, moves: [{ ...before()[0], at: "2026-10-11T09:00:00.000Z" }] }), // after the cutoff
    ticket(5, "Plan review", [], { attachmentUrls: pr, moves: before("owner") }), // moved by the owner
    ticket(6, "Plan review", [], { moves: before() }), // no pull request
    ticket(7, "Plan review", [], { attachmentUrls: pr, moves: before("other-app") }), // another Linear app
    ticket(8, "Plan review", [], { attachmentUrls: pr, moves: before() }), // victim whose labels change before the write
  ];
  let reads = 0;
  const { linear, writes } = fakeLinear(tickets, [], { onRead: (id) => { if (id === "i8" && ++reads === 2) tickets[7].labels.push({ id: "plan-rework", name: "plan-rework" }); } });
  const evidence = host({ parked: ["i3"] });
  const listed = await runReviewVictims({ linear, host: evidence, teamKeys: ["TUC"], cutoff: "2026-10-11T00:00:00.000Z", apply: [] });
  assert.deepEqual(listed.rows.map((row) => row.identifier), ["TUC-1", "TUC-2", "TUC-8"]);
  assert.deepEqual(writes, []);
  const applied = await runReviewVictims({ linear, host: evidence, teamKeys: ["TUC"], cutoff: "2026-10-11T00:00:00.000Z", apply: ["tuc-1", "TUC-3", "TUC-8"] });
  assert.deepEqual(writes, ["TUC-1 -> In Review"]);
  assert.deepEqual(applied.refused, ["TUC-3"]);
  assert.equal(applied.rows.find((row) => row.identifier === "TUC-8")?.result, "skipped: labels changed since the listing");
  await assert.rejects(runReviewVictims({ linear: { ...linear, trustedAppIds: async () => [] }, host: evidence, teamKeys: ["TUC"], cutoff: "2026-10-11T00:00:00.000Z", apply: [] }), /unknown on this host/);
});

test("model-labels: duplicates on closed and other teams' issues keep the strongest before grouping; grouping waits for --hosts-ready; ungroup reverses it", async () => {
  const catalog = (): CatalogLabel[] => [
    { id: "model:cheap", name: "model:cheap", isGroup: false, parentId: null, teamId: null },
    { id: "model:standard", name: "model:standard", isGroup: false, parentId: null, teamId: null },
    { id: "model:strong", name: "Model:Strong", isGroup: false, parentId: null, teamId: null },
  ];
  const tickets = () => [
    ticket(1, "Done", ["model:cheap", "Model:Strong"]),
    ticket(2, "In Progress", ["model:standard", "model:cheap", "paseo"]),
    ticket(3, "Todo", ["model:cheap"]),
  ];
  const dry = fakeLinear(tickets(), catalog());
  const listed = await runModelLabels({ linear: dry.linear, apply: false, hostsReady: false, ungroup: false });
  assert.deepEqual(dry.writes, []);
  assert.deepEqual(listed.duplicates.map((row) => `${row.identifier} keep ${row.keep}`), ["TUC-1 keep model:strong", "TUC-2 keep model:standard"]);
  const labels = catalog();
  const gated = fakeLinear(tickets(), labels);
  const report = await runModelLabels({ linear: gated.linear, apply: true, hostsReady: false, ungroup: false });
  assert.deepEqual(gated.writes, ["TUC-1 + -model:cheap", "TUC-2 + -model:cheap"]);
  assert.ok(report.group.some((line) => line.includes("--hosts-ready is missing")));
  const ready = fakeLinear(tickets(), labels);
  await runModelLabels({ linear: ready.linear, apply: true, hostsReady: true, ungroup: false });
  assert.deepEqual(ready.writes.filter((write) => !write.startsWith("TUC-")), ["create model (group)", "group model:cheap", "group model:standard", "group Model:Strong"]);
  const again = await runModelLabels({ linear: ready.linear, apply: true, hostsReady: true, ungroup: false });
  assert.deepEqual(again.group, ["already grouped: every workspace tier label is in the model group"]);
  const undo = fakeLinear([], labels);
  await runModelLabels({ linear: undo.linear, apply: true, hostsReady: false, ungroup: true });
  assert.deepEqual(undo.writes, ["ungroup model:cheap", "ungroup model:standard", "ungroup Model:Strong"]);
  assert.ok(labels.every((label) => label.isGroup || label.parentId === null));
});

test("model-labels: a duplicate that could not be cleaned blocks the grouping", async () => {
  const labels: CatalogLabel[] = [{ id: "model:cheap", name: "model:cheap", isGroup: false, parentId: null, teamId: null }, { id: "model:strong", name: "model:strong", isGroup: false, parentId: null, teamId: null }];
  const tickets = [ticket(1, "Todo", ["model:cheap", "model:strong"])];
  const { linear, writes } = fakeLinear(tickets, labels, { onRead: () => { tickets[0].status = "In Progress"; } });
  const report = await runModelLabels({ linear, apply: true, hostsReady: true, ungroup: false });
  assert.deepEqual(writes, []);
  assert.deepEqual(report.group, ["not grouped: TUC-1 still carry two tier labels"]);
});

// A workspace and a team label of the same tier on one ticket: the workspace one stays (only it
// joins the group), every other tier label goes in the same write.
test("model-labels: a duplicate of the strongest tier itself keeps one label, the workspace one", async () => {
  const labels: CatalogLabel[] = [
    { id: "ws-strong", name: "model:strong", isGroup: false, parentId: null, teamId: null },
    { id: "team-strong", name: "model:strong", isGroup: false, parentId: null, teamId: "t1" },
    { id: "model:cheap", name: "model:cheap", isGroup: false, parentId: null, teamId: null },
  ];
  const tickets = [ticket(1, "Todo", [], { labels: [{ id: "team-strong", name: "model:strong" }, { id: "ws-strong", name: "model:strong" }, { id: "model:cheap", name: "model:cheap" }] })];
  const { linear, writes } = fakeLinear(tickets, labels);
  const report = await runModelLabels({ linear, apply: true, hostsReady: false, ungroup: false });
  assert.deepEqual(writes, ["TUC-1 + -team-strong,model:cheap"]);
  assert.deepEqual(tickets[0].labels.map((label) => label.id), ["ws-strong"]);
  assert.equal(report.duplicates[0].result, "kept model:strong");
});
