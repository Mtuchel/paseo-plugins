import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ParentStore, type ParentProgress } from "./parents";

const progress = (issueId: string): ParentProgress => ({
  issueId, identifier: issueId, sessionId: null, phase: "children",
  updatedAt: "2026-10-14T00:00:00.000Z", nextAction: "Wait for terminal child states",
  blockers: [], children: [{ issueId: "child", identifier: "TUC-2", status: "Todo", finished: false }],
  delegated: true, handedOut: [],
});

test("parent updates serialize concurrent migration and handout receipts without losing either issue", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "parents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parents = new ParentStore(directory);
  await Promise.all([
    parents.update("TUC-1", (current) => current ?? progress("TUC-1")),
    parents.update("TUC-1", (current) => ({ ...current!, handedOut: [...current!.handedOut, "child"] })),
    parents.update("TUC-3", () => progress("TUC-3")),
  ]);
  const restarted = new ParentStore(directory);
  assert.deepEqual((await restarted.get("TUC-1"))?.handedOut, ["child"]);
  assert.deepEqual((await restarted.all()).map((parent) => parent.issueId).sort(), ["TUC-1", "TUC-3"]);
  const snapshot = await parents.get("TUC-1");
  snapshot!.children[0].finished = true;
  snapshot!.handedOut.push("not-accepted");
  assert.equal((await parents.get("TUC-1"))?.children[0].finished, false);
  assert.deepEqual((await parents.get("TUC-1"))?.handedOut, ["child"]);
});

test("missing parent state reads do not create files; corrupt state is never reset to empty", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "parents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parents = new ParentStore(directory);
  assert.equal(await parents.get("TUC-1"), null);
  assert.deepEqual(await parents.all(), []);
  await assert.rejects(readFile(parents.path), { code: "ENOENT" });
  await writeFile(parents.path, "corrupt");
  const restarted = new ParentStore(directory);
  await assert.rejects(restarted.all(), SyntaxError);
  await assert.rejects(restarted.update("TUC-1", () => progress("TUC-1")), SyntaxError);
  assert.equal(await readFile(parents.path, "utf8"), "corrupt");
});

test("a rejected update preserves durable stopped responsibility and later valid updates still work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "parents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parents = new ParentStore(directory);
  await parents.update("TUC-1", () => ({ ...progress("TUC-1"), phase: "closed" }));
  await assert.rejects(parents.update("TUC-1", (current) => {
    current!.phase = "verification";
    throw new Error("interrupted update");
  }), /interrupted update/);
  await parents.update("TUC-3", () => progress("TUC-3"));
  assert.equal((await parents.get("TUC-1"))?.phase, "closed");
  assert.equal((await new ParentStore(directory).get("TUC-1"))?.phase, "closed");
  assert.equal((await new ParentStore(directory).get("TUC-3"))?.phase, "children");
});
