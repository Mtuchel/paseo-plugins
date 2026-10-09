import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { KnownStates } from "./known-states";

async function file(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-known-states-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "known-states.json");
}

const DONE = { name: "Done", type: "completed" };
const WORKING = { name: "In Progress", type: "started" };

test("the later stamp wins: a read sent before a write, or a slow older read, never replaces a newer state", async (t) => {
  const states = new KnownStates(await file(t));
  await states.observe("i1", DONE, 200);
  // A read sent at 100 that answers after the write confirmed at 200.
  await states.observe("i1", WORKING, 100);
  assert.deepEqual(await states.get("i1"), { ...DONE, at: 200 });
  // A ticket reopened later is read later.
  await states.observe("i1", WORKING, 300);
  assert.deepEqual(await states.get("i1"), { ...WORKING, at: 300 });
  // A state without a name (an unreadable answer) is no observation.
  await states.observe("i1", { name: "", type: "" }, 400);
  assert.deepEqual(await states.get("i1"), { ...WORKING, at: 300 });
});

test("the states survive a restart; tickets without a running agent are forgotten", async (t) => {
  const path = await file(t);
  const first = new KnownStates(path);
  await first.observe("i1", WORKING, 100);
  await first.observe("i2", DONE, 100);
  await first.retain(new Set(["i1"]));
  const second = new KnownStates(path);
  assert.deepEqual(await second.get("i1"), { ...WORKING, at: 100 });
  assert.equal(await second.get("i2"), null);
});

test("an unreadable file counts as empty, is logged once, and the next observation replaces it", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const path = await file(t);
  await writeFile(path, "{ not json");
  const states = new KnownStates(path);
  assert.equal(await states.get("i1"), null);
  assert.equal(await states.get("i2"), null);
  assert.equal(errors.mock.callCount(), 1);
  await states.observe("i1", DONE, 100);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { i1: { ...DONE, at: 100 } });
});
