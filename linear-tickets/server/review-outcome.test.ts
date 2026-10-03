import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planHash } from "../shared/plan-risk";
import { reviewOutcome } from "./review-outcome";

const closed = async () => false;
const plan = "# TUC-1 Fix\n\n## Steps\n1. a\n2. b\n";

test("a review decided on Plannotator's page is found in its saved plans; a live review stays open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plannotator-plans-"));
  try {
    const review = { localUrl: "http://localhost:5000", openedAt: "2026-01-01T10:00:00Z", planHash: planHash(plan) };
    const at = (iso: string) => new Date(iso);
    const put = async (name: string, content: string, when: string) => { await writeFile(join(directory, name), content); await utimes(join(directory, name), at(when), at(when)); };
    assert.equal(await reviewOutcome(review, directory, async () => true), "open");
    assert.equal(await reviewOutcome(review, directory, closed), null, "no saved decision: closed without one");
    await put("tuc-1-fix-2026-01-01-approved.md", "# Another plan\n", "2026-01-01T10:05:00Z");
    await put("tuc-1-fix-2025-12-31-approved.md", plan, "2025-12-31T09:00:00Z");
    assert.equal(await reviewOutcome(review, directory, closed), null, "other plans and decisions from before the review do not count");
    await put("tuc-1-fix-2026-01-01-denied.md", plan, "2026-01-01T10:10:00Z");
    await put("tuc-1-fix-2026-01-01.annotations.md", "Split step 2.\n", "2026-01-01T10:10:00Z");
    assert.deepEqual(await reviewOutcome(review, directory, closed), { approved: false, feedback: "Split step 2.", planContent: plan });
    await put("tuc-1-fix-2026-01-01-approved.md", `${plan}\n`, "2026-01-01T10:20:00Z");
    assert.deepEqual(await reviewOutcome(review, directory, closed), { approved: true, planContent: `${plan}\n` }, "the newest decision wins");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
