import assert from "node:assert/strict";
import test from "node:test";
import { localPlanImages, planImageProblem, replacePlanImages } from "../shared/plan-images";

const files = new Set(["/Users/o/.plannotator/mocks/p/order.png", "/Users/o/.plannotator/mocks/p/order-phone.webp"]);
const isFile = (path: string): boolean => files.has(path);

test("a plan whose local images are absolute, supported and present passes", () => {
  const plan = [
    "# Plan",
    "![Mock: order page](/Users/o/.plannotator/mocks/p/order.png)",
    '<img src="/Users/o/.plannotator/mocks/p/order-phone.webp" alt="phone">',
    "![remote](https://example.com/a.png) ![inline](data:image/png;base64,AAAA)",
  ].join("\n");
  assert.equal(planImageProblem(plan, isFile), null);
  assert.equal(planImageProblem("# Plan\n\nNo images.\n", isFile), null);
});

test("a missing, relative, home-relative or unsupported local image is refused, naming each", () => {
  const plan = [
    "![a](/Users/o/.plannotator/mocks/p/gone.png)",
    "![b](mocks/order.png)",
    "![c](~/.plannotator/mocks/p/order.png)",
    "![d](/Users/o/.plannotator/mocks/p/order.html)",
    '<img alt="e" src="/Users/o/missing.jpg">',
  ].join("\n\n");
  const problem = planImageProblem(plan, isFile) ?? "";
  assert.match(problem, /\/Users\/o\/\.plannotator\/mocks\/p\/gone\.png/);
  assert.match(problem, /mocks\/order\.png/);
  assert.match(problem, /~\/\.plannotator\/mocks\/p\/order\.png/);
  assert.match(problem, /order\.html/);
  assert.match(problem, /\/Users\/o\/missing\.jpg/);
  assert.equal(planImageProblem("![x](/Users/o/.plannotator/mocks/p/ORDER.PNG)", (path) => path.endsWith("ORDER.PNG")), null, "extensions compare case-insensitively");
});

test("image syntax inside fenced or inline code is text, not an image", () => {
  const plan = [
    "Embed it as `![Mock: <screen>](<absolute path>)` on its own line.",
    "```md",
    "![example](relative/example.png)",
    '<img src="nope.png">',
    "```",
    "~~~",
    "![tilde fence](also/nope.png)",
    "~~~",
  ].join("\n");
  assert.deepEqual(localPlanImages(plan), []);
  assert.equal(planImageProblem(plan, isFile), null);
});

test("local images are listed in order with the exact source the plan uses", () => {
  const plan = "Intro ![one](/a/one.png) and `![skip](/a/skip.png)`\n<img width=\"300\" src='/a/two.svg'>\n![three](https://x.test/three.png)\n";
  assert.deepEqual(localPlanImages(plan).map((image) => image.src), ["/a/one.png", "/a/two.svg"]);
});

test("replacing images swaps only the mapped local sources, in both syntaxes, and leaves code untouched", () => {
  const plan = [
    "![Mock](/a/one.png) ![Again](/a/one.png)",
    '<img src="/a/two.png" alt="two">',
    "![Unmapped](/a/three.png)",
    "```",
    "![Code](/a/one.png)",
    "```",
  ].join("\n");
  const urls = new Map([
    ["/a/one.png", "https://uploads.linear.app/x/one"],
    ["/a/two.png", "https://uploads.linear.app/x/two"],
  ]);
  assert.equal(
    replacePlanImages(plan, urls),
    [
      "![Mock](https://uploads.linear.app/x/one) ![Again](https://uploads.linear.app/x/one)",
      '<img src="https://uploads.linear.app/x/two" alt="two">',
      "![Unmapped](/a/three.png)",
      "```",
      "![Code](/a/one.png)",
      "```",
    ].join("\n"),
  );
  assert.equal(replacePlanImages(plan, new Map()), plan);
});
