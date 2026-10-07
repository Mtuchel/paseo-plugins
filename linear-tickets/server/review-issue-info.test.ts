import assert from "node:assert/strict";
import { test } from "node:test";
import { areaLabels } from "./area-labels";
import type { CatalogLabel, IssueMetadata } from "./linear";
import { ReviewIssueInfos } from "./review-issue-info";

const ISSUE_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const AREA_ID = "3692d838-bf25-40cf-a1f1-96193846b21d";
const PURCHASING_ID = "e9e963f8-284e-4a52-a4d2-84decf0f9de0";
const TTL = 5 * 60_000;
const catalog: CatalogLabel[] = [
  { id: AREA_ID, name: "Area", isGroup: true, parentId: null, teamId: null },
  { id: PURCHASING_ID, name: "Purchasing", isGroup: false, parentId: AREA_ID, teamId: null },
  { id: "sales", name: "Sales", isGroup: false, parentId: AREA_ID, teamId: "team" },
  { id: "type", name: "Type", isGroup: true, parentId: null, teamId: null },
  { id: "bug", name: "Bug", isGroup: false, parentId: "type", teamId: null },
  { id: "prefix", name: "Area/Fake", isGroup: false, parentId: null, teamId: null },
  { id: "ungrouped", name: "Purchasing", isGroup: false, parentId: null, teamId: null },
];

function harness() {
  const h = {
    time: 0, reads: 0, catalogReads: 0, failIssue: false, failCatalog: false,
    identifier: null as string | null, issueId: ISSUE_ID,
    labels: [{ id: PURCHASING_ID, name: "Purchasing" }],
    catalog, block: null as Promise<void> | null,
  };
  const infos = new ReviewIssueInfos({
    issueMetadata: async (identifier): Promise<IssueMetadata> => {
      h.reads++;
      if (h.block) await h.block;
      if (h.failIssue) throw new Error("Linear temporarily unavailable");
      return { id: h.issueId, identifier: h.identifier ?? identifier, labels: h.labels };
    },
    labelCatalog: async () => {
      h.catalogReads++;
      if (h.failCatalog) throw new Error("Catalog temporarily unavailable");
      return h.catalog;
    },
  }, () => h.time);
  return { h, infos };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("area metadata uses actual Area membership, preserves plain child names and deduplicates deterministically", () => {
  const areasOf = areaLabels(catalog);
  assert.deepEqual(areasOf([
    { id: "sales" }, { id: "bug" }, { id: PURCHASING_ID }, { id: "prefix" },
    { id: "ungrouped" }, { id: "sales" }, { id: AREA_ID }, { id: "missing" },
  ]), ["Purchasing", "Sales"]);
  assert.deepEqual(areasOf([{ id: "ungrouped" }, { id: "prefix" }]), []);
});

test("review lookup verifies the exact current identifier and UUID before returning linkage", async () => {
  const { h, infos } = harness();
  h.identifier = "TUC-631";
  assert.equal(await infos.forIdentifier("TUC-630"), null);
  assert.equal(h.catalogReads, 0);
  h.identifier = "TUC-630";
  h.issueId = "not-a-uuid";
  assert.equal(await infos.forIdentifier("TUC-630", { fresh: true }), null);
  assert.equal(await infos.forIdentifier(ISSUE_ID), null, "a UUID is not an identifier lookup");
  assert.equal(h.catalogReads, 0);
  h.issueId = ISSUE_ID;
  assert.deepEqual(await infos.forIdentifier(" tuc-630 ", { fresh: true }), { issueId: ISSUE_ID, areas: ["Purchasing"] });
});

test("verified metadata has a per-identifier five-minute TTL and shares the catalog across identifiers", async () => {
  const { h, infos } = harness();
  await infos.forIdentifier("TUC-630");
  h.time = 60_000;
  await infos.forIdentifier("TUC-631");
  assert.equal(h.catalogReads, 1);
  h.labels = [{ id: "sales", name: "Sales" }];
  h.time = TTL - 1;
  assert.deepEqual((await infos.forIdentifier("TUC-630"))?.areas, ["Purchasing"]);
  assert.equal(h.reads, 2);
  h.time = TTL;
  assert.deepEqual((await infos.forIdentifier("TUC-630"))?.areas, ["Sales"]);
  assert.deepEqual((await infos.forIdentifier("TUC-631"))?.areas, ["Purchasing"]);
  assert.equal(h.reads, 3, "reading one identifier must not refresh another's TTL");
  assert.equal(h.catalogReads, 2);
});

test("concurrent failed refreshes retain verified metadata and throttle reads before recovering", async () => {
  const { h, infos } = harness();
  const verified = await infos.forIdentifier("TUC-630");
  h.time = TTL;
  h.failIssue = true;
  const gate = barrier();
  h.block = gate.promise;
  const first = infos.forIdentifier("TUC-630");
  const second = infos.forIdentifier("TUC-630");
  assert.equal(h.reads, 2);
  gate.release();
  assert.deepEqual(await Promise.all([first, second]), [verified, verified]);
  h.block = null;
  h.failIssue = false;
  h.labels = [{ id: "sales", name: "Sales" }];
  h.time += 29_999;
  assert.deepEqual(await infos.forIdentifier("TUC-630"), verified);
  assert.equal(h.reads, 2);
  h.time++;
  assert.deepEqual((await infos.forIdentifier("TUC-630"))?.areas, ["Sales"]);
  assert.equal(h.reads, 3);
});

test("unknown linkage is nonfatal and failed initial reads are throttled", async () => {
  const { h, infos } = harness();
  h.failIssue = true;
  assert.equal(await infos.forIdentifier("TUC-630"), null);
  assert.equal(await infos.forIdentifier("TUC-630"), null);
  assert.equal(h.reads, 1);
  h.failIssue = false;
  assert.deepEqual(await infos.forIdentifier("TUC-630", { fresh: true }), { issueId: ISSUE_ID, areas: ["Purchasing"] });
  assert.equal(h.reads, 2, "fresh lookup bypasses failure throttling");
});

test("catalog failures retain verified metadata and throttle a shared failed catalog refresh", async () => {
  const { h, infos } = harness();
  const verified = await infos.forIdentifier("TUC-630");
  h.time = TTL;
  h.failCatalog = true;
  assert.deepEqual(await infos.forIdentifier("TUC-630"), verified);
  assert.equal(await infos.forIdentifier("TUC-631"), null);
  assert.equal(h.catalogReads, 2, "another identifier does not immediately retry the failed catalog");
  assert.equal(await infos.forIdentifier("TUC-630", { fresh: true }), null, "fresh authorization cannot use stale metadata on failure");
  assert.equal(h.catalogReads, 3, "fresh lookup bypasses the catalog failure throttle");
  h.failCatalog = false;
  h.time += 30_000;
  h.labels = [{ id: "sales", name: "Sales" }];
  assert.deepEqual((await infos.forIdentifier("TUC-630"))?.areas, ["Sales"]);
});

test("fresh revalidation fails closed, retains optional enrichment on transient errors and invalidates changed identity", async () => {
  const { h, infos } = harness();
  const verified = await infos.forIdentifier("TUC-630");
  h.failIssue = true;
  assert.equal(await infos.forIdentifier("TUC-630", { fresh: true }), null);
  assert.deepEqual(await infos.forIdentifier("TUC-630"), verified);
  h.failIssue = false;
  h.identifier = "TUC-999";
  assert.equal(await infos.forIdentifier("TUC-630", { fresh: true }), null);
  assert.equal(await infos.forIdentifier("TUC-630"), null, "an identity mismatch discards prior linkage");
});

test("fresh revalidation waits for older enrichment and concurrent fresh calls share a new read", async () => {
  const { h, infos } = harness();
  const gate = barrier();
  h.block = gate.promise;
  const enrichment = infos.forIdentifier("TUC-630");
  const fresh = infos.forIdentifier("TUC-630", { fresh: true });
  const another = infos.forIdentifier("TUC-630", { fresh: true });
  assert.equal(h.reads, 1);
  gate.release();
  await enrichment;
  assert.deepEqual(await Promise.all([fresh, another]), [
    { issueId: ISSUE_ID, areas: ["Purchasing"] }, { issueId: ISSUE_ID, areas: ["Purchasing"] },
  ]);
  assert.equal(h.reads, 2, "fresh reads must not authorize using the older enrichment request");
});

test("bounded cache evicts older identifiers without losing the newest verified lookup", async () => {
  const { h, infos } = harness();
  for (let number = 1; number <= 501; number++) await infos.forIdentifier(`TUC-${number}`);
  const reads = h.reads;
  assert.deepEqual(await infos.forIdentifier("TUC-501"), { issueId: ISSUE_ID, areas: ["Purchasing"] });
  assert.equal(h.reads, reads);
  await infos.forIdentifier("TUC-1");
  assert.equal(h.reads, reads + 1, "old linkage must be read again after capacity eviction");
});
