import assert from "node:assert/strict";
import test from "node:test";
import { groupRowsByTicket } from "./decision-groups";
import type { DecisionRow } from "./decision-groups";

const HOST_MAC = "macbook-pro-von-mirko";
const HOST_SERVER = "server087";

function source(
  host: string,
  target: DecisionRow["target"],
  id: string,
  revision: string,
  data: DecisionRow["data"],
): DecisionRow {
  return { host, target, id, revision, data };
}

test("groups one ticket's owner and live sources across hosts and targets", () => {
  // The owner source below sits on a sub-issue (identifier TUC-599) whose ticket is TUC-601:
  // owner rows take the ticket, never the identifier, so it belongs to TUC-601.
  const ownerMac = source(HOST_MAC, "owner", '["issue-601","comment-1"]', "owner-r1", {
    identifier: "TUC-599", ticketIdentifier: "TUC-601", summary: "Ship the migration?",
  });
  const liveMac = source(HOST_MAC, "live", '["agent-601","request-1"]', "live-r1", {
    identifier: "TUC-601", title: "Approve the migration?",
  });
  const ownerServer = source(HOST_SERVER, "owner", '["issue-601","comment-2"]', "owner-r2", {
    identifier: "TUC-601", ticketIdentifier: "TUC-601", summary: "Ship the migration?",
  });
  const liveServer = source(HOST_SERVER, "live", '["agent-601","request-2"]', "live-r2", {
    identifier: "TUC-601", title: "Approve the migration?",
  });

  const groups = groupRowsByTicket([ownerMac, liveMac, ownerServer, liveServer]);

  assert.equal(groups.length, 1, "one ticket is one group on the page");
  assert.equal(groups[0].key, "TUC-601");
  assert.equal(groups[0].ticket, "TUC-601");
  assert.deepEqual(groups[0].rows, [ownerMac, liveMac, ownerServer, liveServer]);
});

test("rows without a ticket stay separate, keyed by source identity", () => {
  // An owner source with an identifier but no resolved ticket must not borrow the identifier:
  // it keeps its own group, exactly like a live request without an identifier.
  const ownerNoTicket = source(HOST_MAC, "owner", '["issue-9","comment-1"]', "owner-r1", {
    identifier: "TUC-9", ticketIdentifier: null,
  });
  const ownerEmptyTicket = source(HOST_MAC, "owner", '["issue-10","comment-1"]', "owner-r2", {
    identifier: "", ticketIdentifier: "",
  });
  const liveNoTicket = source(HOST_MAC, "live", '["agent-11","request-1"]', "live-r1", {
    identifier: null,
  });
  const liveEmptyTicket = source(HOST_SERVER, "live", '["agent-11","request-1"]', "live-r2", {
    identifier: "",
  });

  const groups = groupRowsByTicket([ownerNoTicket, ownerEmptyTicket, liveNoTicket, liveEmptyTicket]);

  assert.equal(groups.length, 4, "ticketless sources never merge with each other");
  assert.deepEqual(groups.map(group => group.key), [
    JSON.stringify([HOST_MAC, "owner", '["issue-9","comment-1"]', "owner-r1"]),
    JSON.stringify([HOST_MAC, "owner", '["issue-10","comment-1"]', "owner-r2"]),
    JSON.stringify([HOST_MAC, "live", '["agent-11","request-1"]', "live-r1"]),
    JSON.stringify([HOST_SERVER, "live", '["agent-11","request-1"]', "live-r2"]),
  ]);
  assert.deepEqual(groups.map(group => group.ticket), [null, null, null, null]);
  assert.deepEqual(groups.map(group => group.rows), [[ownerNoTicket], [ownerEmptyTicket], [liveNoTicket], [liveEmptyTicket]]);
});

test("orders groups by first appearance and keeps members in input order", () => {
  const ticket2Live = source(HOST_MAC, "live", '["agent-2","request-1"]', "ticket2-live", {
    identifier: "TUC-2",
  });
  const ticket1Owner = source(HOST_MAC, "owner", '["issue-1","comment-1"]', "ticket1-owner", {
    identifier: "TUC-1", ticketIdentifier: "TUC-1",
  });
  const ticket1Live = source(HOST_SERVER, "live", '["agent-1","request-1"]', "ticket1-live", {
    identifier: "TUC-1",
  });
  const ticket2Owner = source(HOST_SERVER, "owner", '["issue-2","comment-1"]', "ticket2-owner", {
    identifier: "TUC-2", ticketIdentifier: "TUC-2",
  });
  const ticket1Later = source(HOST_MAC, "owner", '["issue-1","comment-2"]', "ticket1-later", {
    identifier: "TUC-1", ticketIdentifier: "TUC-1",
  });

  const groups = groupRowsByTicket([ticket2Live, ticket1Owner, ticket1Live, ticket2Owner, ticket1Later]);

  assert.deepEqual(groups.map(group => group.ticket), ["TUC-2", "TUC-1"]);
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[0].rows[0], ticket2Live, "the first member stays first");
  assert.equal(groups[0].rows[1], ticket2Owner);
  assert.deepEqual(groups[1].rows, [ticket1Owner, ticket1Live, ticket1Later]);
});

test("preserves every input row exactly once by reference", () => {
  const rows = [
    source(HOST_MAC, "owner", '["issue-1","comment-1"]', "r1", { identifier: "TUC-1", ticketIdentifier: "TUC-1" }),
    source(HOST_MAC, "live", '["agent-1","request-1"]', "r2", { identifier: "TUC-1" }),
    source(HOST_SERVER, "owner", '["issue-2","comment-1"]', "r3", { identifier: "TUC-2", ticketIdentifier: "TUC-2" }),
    source(HOST_SERVER, "live", '["agent-3","request-1"]', "r4", { identifier: null }),
    source(HOST_MAC, "owner", '["issue-4","comment-1"]', "r5", { identifier: null, ticketIdentifier: null }),
  ];

  const flattened = groupRowsByTicket(rows).flatMap(group => group.rows);

  assert.equal(flattened.length, rows.length, "no row is dropped or duplicated");
  for (const row of rows) {
    assert.equal(flattened.filter(candidate => candidate === row).length, 1, "the page keeps the original row object");
  }
});

test("identical summaries and questions on different tickets stay separate", () => {
  const summary = "Label PR #4816 as ready.";
  const questions = [{
    key: "q1", question: "Label PR #4816?", multiSelect: false,
    options: [{ label: "A. Label it", description: "Mark the PR ready." }, { label: "B. Wait", description: "Keep the draft." }],
  }];
  const tuc937 = source(HOST_MAC, "owner", '["issue-937","comment-1"]', "r1", {
    identifier: "TUC-937", ticketIdentifier: "TUC-937", summary, questions,
  });
  const tuc2143 = source(HOST_SERVER, "owner", '["issue-2143","comment-1"]', "r2", {
    identifier: "TUC-2143", ticketIdentifier: "TUC-2143", summary, questions,
  });
  const live937 = source(HOST_MAC, "live", '["agent-937","request-1"]', "r3", {
    identifier: "TUC-937", title: summary, questions,
  });

  const groups = groupRowsByTicket([tuc937, tuc2143, live937]);

  assert.deepEqual(groups.map(group => group.ticket), ["TUC-937", "TUC-2143"]);
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[1].rows.length, 1);
  assert.equal(groups[0].rows[1], live937);
  assert.equal(groups[1].rows[0], tuc2143);
});

test("empty input has no groups", () => {
  assert.deepEqual(groupRowsByTicket([]), []);
});