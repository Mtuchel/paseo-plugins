import assert from "node:assert/strict";
import test from "node:test";
import { footprintOverlap, planFootprint, sameFile } from "../shared/plan-footprint";

// What a plan names, for comparing it with other plans and pull requests (README, "Related work"):
// files, Reach places and related tickets, and how two footprints overlap.

test("a plan's footprint names its files, its Reach places and its related tickets, never its own", () => {
  const text = [
    "# Plan",
    "",
    "Change `server/x.ts` and [the schema](shared/db/schema.ts); `and/or` and `TUC-1/TUC-2` are no files.",
    "",
    "## Reach",
    "",
    "- Settings page: include — AC-1",
    "- Billing export: n/a — the export stays",
    "- settings  page: include — AC-7",
    "",
    "## Related work",
    "",
    "```related-work",
    "TUC-7 blocks TUC-9: the parser lands first",
    "TUC-7 relates to TUC-20: same files",
    "```",
    "",
    "TUC-21 reports the same fields.",
  ].join("\n");
  assert.deepEqual(planFootprint(text, "TUC-7"), {
    files: ["server/x.ts", "shared/db/schema.ts"],
    places: ["Settings page"],
    tickets: ["TUC-9", "TUC-20", "TUC-21"],
    ticket: "TUC-7",
  });
});

test("an old plan's tickets come from `## Overlapping tickets`, and a plan with a Related work section ignores it", () => {
  const old = "# Plan\n\n## Overlapping tickets\n\n- TUC-4 — the same parser\n- TUC-5\n";
  assert.deepEqual(planFootprint(old, "TUC-1").tickets, ["TUC-4", "TUC-5"]);
  const both = "# Plan\n\n## Related work\n\nTUC-8 reports the same fields.\n\n## Overlapping tickets\n\n- TUC-4\n";
  assert.deepEqual(planFootprint(both, "TUC-1").tickets, ["TUC-8"]);
});

test("an overlap names the files, places and tickets two plans share, and whether either names the other's ticket", () => {
  const mine = planFootprint("# Plan\n\nChange `server/x.ts` and `server/y.ts`.\n\n## Reach\n\n- Settings Page: include — AC-1\n\n## Related work\n\nTUC-9 blocks TUC-1: order\n", "TUC-1");
  const other = planFootprint("# Plan\n\nChange `o/r/server/x.ts` and `o/r/server/z.ts`.\n\n## Reach\n\n- settings page: include — AC-2\n\n## Related work\n\nTUC-1 relates to TUC-30\n", "TUC-9");
  assert.deepEqual(footprintOverlap(mine, other), { files: ["server/x.ts"], places: ["Settings Page"], tickets: [], namesOther: true });

  // The same comparison backwards finds the same parts and the same naming.
  assert.deepEqual(footprintOverlap(other, mine), { files: ["o/r/server/x.ts"], places: ["settings page"], tickets: [], namesOther: true });

  const shared = planFootprint("# Plan\n\nChange `server/x.ts`.\n\n## Related work\n\nTUC-9 relates to TUC-30\n", "TUC-2");
  const apart = planFootprint("# Plan\n\nChange `server/z.ts`.\n\n## Reach\n\n- Billing export: include — AC-1\n\n## Related work\n\nTUC-40 relates to TUC-30\n", "TUC-3");
  assert.deepEqual(footprintOverlap(shared, apart), { files: [], places: [], tickets: ["TUC-30"], namesOther: false });
});

test("the advisor's model named in `## Advisor review` is no file, so two plans reviewed by one advisor do not overlap", () => {
  const review = "## Advisor review\n\nAstra (`omp/openai-codex/gpt-6-astra`, medium), round 1: **agreed**.\n* Model: `openai-codex/gpt-6-astra`.\n";
  const mine = planFootprint(`# Plan\n\nChange \`server/x.ts\`.\n\n${review}`, "TUC-1");
  const other = planFootprint(`# Plan\n\nChange \`server/z.ts\`.\n\n${review}\n## Later\n\nAlso \`server/w.ts\`.\n`, "TUC-2");
  assert.deepEqual(mine.files, ["server/x.ts"]);
  assert.deepEqual(other.files, ["server/z.ts", "server/w.ts"], "a section after the review is read again");
  assert.deepEqual(footprintOverlap(mine, other), { files: [], places: [], tickets: [], namesOther: false });
});

test("a file matches its equal path or the same path with owner/repo in front, never another repository's path", () => {
  assert.equal(sameFile("server/x.ts", "server/x.ts"), true);
  assert.equal(sameFile("server/x.ts", "o/r/server/x.ts"), true);
  assert.equal(sameFile("o/r/server/x.ts", "server/x.ts"), true);
  assert.equal(sameFile("o/r/lib/server/x.ts", "lib/server/x.ts"), true);
  assert.equal(sameFile("server/x.ts", "server/xy.ts"), false);
  assert.equal(sameFile("lib/server/x.ts", "server/x.ts"), false, "one extra segment is not the owner/repo prefix");
  assert.equal(sameFile("o/r/server/x.ts", "o/other/server/x.ts"), false);
  assert.equal(sameFile("o/r/server/x.ts", "o/r/server/y.ts"), false);
});
