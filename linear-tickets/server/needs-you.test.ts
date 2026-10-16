import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NeedsYouIssues, type NeedsYouIssue } from "./needs-you";

const question: NeedsYouIssue = { id: "q1", identifier: "ENG-9", parentId: "parent", agentId: "a1" };

test("strict owner-question inventory distinguishes absence from enumeration failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-needs-you-"));
  const directory = join(root, "questions");
  const questions = new NeedsYouIssues(directory);
  try {
    assert.deepEqual(await questions.allStrict(), []);
    await writeFile(directory, "not a directory");
    await assert.rejects(questions.allStrict(), { code: "ENOTDIR" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("strict owner-question inventory never loses an unreadable or malformed registered question", async () => {
  for (const fault of ["directory", "missing-record", "invalid-json", "invalid-shape", "wrong-id"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "paseo-needs-you-"));
    const questions = new NeedsYouIssues(directory);
    const path = join(directory, "q1.json");
    try {
      if (fault === "directory") await mkdir(path);
      if (fault === "missing-record") await symlink(join(directory, "missing"), path);
      if (fault === "invalid-json") await writeFile(path, "{");
      if (fault === "invalid-shape") await writeFile(path, JSON.stringify({ id: "q1", parentId: "parent" }));
      if (fault === "wrong-id") await writeFile(path, JSON.stringify({ ...question, id: "q2" }));
      await assert.rejects(questions.allStrict(), fault);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("strict owner-question inventory follows registration and removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-needs-you-"));
  const questions = new NeedsYouIssues(directory);
  try {
    await questions.add(question);
    const registered = (await questions.allStrict())[0];
    assert.deepEqual({ id: registered.id, identifier: registered.identifier, parentId: registered.parentId, agentId: registered.agentId }, question);
    await questions.remove(question.id, registered);
    assert.deepEqual(await questions.allStrict(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const replacementFirst of [false, true]) {
  test(`checked cleanup preserves a concurrent replacement registration ${replacementFirst ? "queued before" : "queued after"} removal`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-needs-you-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const questions = new NeedsYouIssues(directory);
    const another = new NeedsYouIssues(directory);
    await questions.add(question);
    const original = (await questions.allStrict())[0];
    const operations = replacementFirst
      ? [another.add(question), questions.remove(question.id, original)]
      : [questions.remove(question.id, original), another.add(question)];
    await Promise.all(operations);
    const current = (await questions.allStrict())[0];
    await questions.remove(question.id, original);
    assert.deepEqual(await questions.allStrict(), [current], "stale cleanup cannot delete the replacement even when issue, parent and agent are unchanged");
    await questions.remove(question.id, current);
    assert.deepEqual(await questions.allStrict(), []);
  });
}

test("legacy registration cleanup cannot delete a new generation and invalid current tracking fails closed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-needs-you-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const questions = new NeedsYouIssues(directory);
  await writeFile(join(directory, `${question.id}.json`), JSON.stringify(question));
  const legacy = (await questions.allStrict())[0];
  await questions.add(question);
  const replacement = await questions.allStrict();
  await questions.remove(question.id, legacy);
  assert.deepEqual(await questions.allStrict(), replacement);
  await writeFile(join(directory, `${question.id}.json`), "{");
  await assert.rejects(questions.remove(question.id, replacement[0]), SyntaxError);
  await assert.rejects(questions.allStrict(), SyntaxError, "failed identity verification cannot delete a registered owner blocker");
});
