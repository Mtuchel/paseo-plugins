import assert from "node:assert/strict";
import test from "node:test";
import { layoutProblem, requiredParts } from "../shared/plan-layout";

test("the template's part headings are read once each, in part order, whatever order it mentions them in", () => {
  const template = "Part 2 first: `# Part 2 — Implementation`. Then `# Part 1 — Overview`. Again: `# Part 1 — Overview`. Sections use `##`.";
  assert.deepEqual(requiredParts(template), ["# Part 1 — Overview", "# Part 2 — Implementation"]);
  assert.deepEqual(requiredParts("Write a plan with `##` sections: Context, Approach, Steps."), [], "Plannotator's built-in instructions name no parts");
});

test("a part heading counts only as a level-1 heading outside a code block", () => {
  const parts = ["# Part 1 — Overview", "# Part 2 — Implementation"];
  assert.equal(layoutProblem("# Plan\n\nNo parts at all.\n", []), null, "a template without parts asks for none");
  const fenced = "# Plan\n\n# Part 1 — Overview\n\n```md\n# Part 2 — Implementation\n```\n";
  assert.match(layoutProblem(fenced, parts) ?? "", /no "# Part 2 — Implementation" heading/);
  const nested = "# Plan\n\n# Part 1 — Overview\n\n## Part 2 — Implementation\n";
  assert.match(layoutProblem(nested, parts) ?? "", /no "# Part 2 — Implementation" heading/);
  assert.equal(layoutProblem("# Plan\n\n#  Part 1 – overview\n\n# Part 2—Implementation\n\n## Reach\n", parts), null);
});
