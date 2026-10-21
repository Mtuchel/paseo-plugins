import assert from "node:assert/strict";
import test from "node:test";
import { Credentials } from "./credentials";
import { FOCUS_SEED_QUERY, LinearService, queueBlockerFilter } from "./linear";

const node = (id: string) => ({ id, identifier: `TUC-${id}`, title: `Queue blocker: ${id}`, url: `https://linear.app/test/${id}`, state: { name: "Plan review", type: "started" }, labels: { nodes: [] }, attachments: { nodes: [] }, children: { nodes: [] }, inverseRelations: { nodes: [] } });

test("blocker inventory reads every page independent of dispatch labels, deduplicating overlapping tickets", async () => {
  const linear = new LinearService(new Credentials("/unused", "key"), async (_key, query, variables) => {
    assert.equal(query, FOCUS_SEED_QUERY);
    assert.deepEqual(variables.filter, { team: { key: { in: ["TUC"] } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } }, ...queueBlockerFilter() });
    return { issues: variables.after === null
      ? { nodes: [node("1")], pageInfo: { hasNextPage: true, endCursor: "next" } }
      : { nodes: [node("1"), node("2")], pageInfo: { hasNextPage: false, endCursor: null } } };
  });
  assert.deepEqual((await linear.focusQueueBlockers(["TUC"])).map(issue => issue.identifier), ["TUC-1", "TUC-2"]);
});

test("missing, cyclic, or failed later blocker pages cannot publish a partial or empty inventory", async () => {
  for (const failure of ["missing metadata", "missing cursor", "repeated cursor", "request failed"] as const) {
    const linear = new LinearService(new Credentials("/unused", "key"), async (_key, _query, variables) => {
      if (variables.after === null) return { issues: { nodes: [node("1")], pageInfo: { hasNextPage: true, endCursor: "next" } } };
      if (failure === "request failed") throw new Error("later page unavailable");
      return { issues: { nodes: [], ...(failure === "missing metadata" ? {} : { pageInfo: { hasNextPage: true, endCursor: failure === "missing cursor" ? null : "next" } }) } };
    });
    await assert.rejects(linear.focusQueueBlockers(["TUC"]), /cursor|metadata|unavailable/, failure);
  }
});
