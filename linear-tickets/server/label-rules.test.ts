import assert from "node:assert/strict";
import test from "node:test";
import { chosenByHand, decide, globToRegExp, parseLabelRules, planLabelChanges, SETTLE_MS, type LabelEvent, type ResolvedGroup, type SweptIssue } from "./label-rules";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const OLD = new Date(NOW - SETTLE_MS - 1).toISOString();

function issue(overrides: Partial<SweptIssue> = {}): SweptIssue {
  return { id: "i1", identifier: "TUC-1", title: "", description: "", createdAt: OLD, updatedAt: OLD, projectName: null, parentId: null, parentLabelIds: [], labelIds: [], pullRequests: [], ...overrides };
}

const RULES = parseLabelRules(JSON.stringify({
  teamKeys: ["TUC"],
  groups: [
    { name: "Area", inherit: true, labels: [
      { name: "Quality", paths: ["o/app/**/quality/**"], keywords: ["qualit", "\\blab\\b"] },
      { name: "Sales", paths: ["o/app/**/sales/**", "o/app/**/quality/sales-*"], projects: ["Shop"], keywords: ["customer"] },
      { name: "Platform", paths: ["o/app/.github/**"], title: ["^SENTRY:"] },
    ] },
    { name: "Type", labels: [{ name: "Bug", title: ["\\bfails?\\b"] }, { name: "Feature", title: ["^add\\b"] }] },
  ],
}));
const resolve = (index: number): ResolvedGroup => {
  const rule = RULES.groups[index];
  const labels = rule.labels.map((entry) => ({ rule: entry, id: entry.name.toLowerCase() }));
  return { rule, id: rule.name.toLowerCase(), labels, members: [...labels.map((entry) => entry.id), "by-hand"] };
};
const AREA = resolve(0);
const TYPE = resolve(1);
const PR = "https://github.com/o/app/pull/1";
const PR2 = "https://github.com/o/app/pull/2";

test("the rules file is refused with its reason: bad team keys, repeated names, broken patterns, bad colours", () => {
  const file = (groups: unknown, teamKeys: unknown = ["TUC"]) => JSON.stringify({ teamKeys, groups });
  const label = { name: "Quality" };
  assert.throws(() => parseLabelRules("{"), /not valid JSON/);
  assert.throws(() => parseLabelRules(file([{ name: "Area", labels: [label] }], [])), /teamKeys/);
  assert.throws(() => parseLabelRules(file([{ name: "Area", labels: [label] }], ["T-1"])), /teamKeys/);
  assert.throws(() => parseLabelRules(file([{ name: "Area", labels: [label, { name: "quality" }] }])), /Label "quality" appears twice/);
  assert.throws(() => parseLabelRules(file([{ name: "Area", labels: [label] }, { name: "Type", labels: [{ name: "Area" }] }])), /appears twice/);
  assert.throws(() => parseLabelRules(file([{ name: "Area", labels: [{ name: "Q", keywords: ["("] }] }])), /Area\/Q: keywords: "\(" is not a valid regular expression/);
  assert.throws(() => parseLabelRules(file([{ name: "Area", labels: [{ name: "Q", color: "green" }] }])), /colour/);
  assert.throws(() => parseLabelRules(file([{ name: "Area", labels: [] }])), /at least one label/);
  assert.notEqual(parseLabelRules(file([{ name: "Area", labels: [label] }])).hash, parseLabelRules(file([{ name: "Area", labels: [{ name: "Sales" }] }])).hash);
});

test("globs: ** spans directories (none included), * and ? stay in one segment, case is ignored", () => {
  const glob = globToRegExp("Owner/Repo/**/quality/*.ts");
  assert.ok(glob.test("owner/repo/quality/a.ts"));
  assert.ok(glob.test("owner/repo/apps/x/quality/a.ts"));
  assert.ok(!glob.test("owner/repo/apps/quality/sub/a.ts"));
  assert.ok(!glob.test("owner/repo/apps/qualityx/a.ts"));
  assert.ok(globToRegExp("o/r/a?c.md").test("o/r/abc.md"));
  assert.ok(!globToRegExp("o/r/a?c.md").test("o/r/a/c.md"));
  assert.ok(globToRegExp("o/r/a.b+(c)").test("o/r/a.b+(c)"), "regex characters are literal");
});

test("pull request files decide first; each file counts for the first label that matches it", () => {
  const files: Record<string, string[]> = {
    [PR]: ["o/app/src/quality/a.ts", "o/app/src/quality/sales-b.ts", "o/app/README.md"],
    [PR2]: ["o/app/src/sales/c.ts"],
  };
  const subject = issue({ title: "customer customer", projectName: "Shop", parentId: "p", parentLabelIds: ["sales"], pullRequests: [PR, PR2] });
  // quality/sales-b.ts matches Quality before Sales; README matches nothing: Quality 2, Sales 1.
  assert.deepEqual(decide(subject, AREA, (url) => files[url]), { labelId: "quality", reason: "pull requests" });
  assert.equal(decide(subject, AREA, (url) => (url === PR2 ? null : files[url])), undefined, "an unknown pull request waits");
});

test("a tie between labels keeps the current one when it is among the best, else falls through to weaker evidence", () => {
  const files = { [PR]: ["o/app/x/quality/a.ts", "o/app/x/sales/b.ts"] };
  const filesOf = (url: string) => files[url as keyof typeof files];
  assert.deepEqual(decide(issue({ pullRequests: [PR], labelIds: ["sales"] }), AREA, filesOf), { labelId: "sales", reason: "pull requests" });
  assert.deepEqual(decide(issue({ pullRequests: [PR], labelIds: ["platform"], projectName: "shop" }), AREA, filesOf), { labelId: "sales", reason: "project" });
  assert.equal(decide(issue({ pullRequests: [PR] }), AREA, filesOf), null);
});

test("without pull request evidence: the parent's label (inheriting groups only), then the project, then keywords", () => {
  const none = () => [];
  assert.deepEqual(decide(issue({ parentId: "p", parentLabelIds: ["quality", "bug"], projectName: "Shop" }), AREA, none), { labelId: "quality", reason: "parent" });
  assert.equal(decide(issue({ parentId: "p", parentLabelIds: ["bug"] }), TYPE, none), null, "Type does not inherit");
  assert.deepEqual(decide(issue({ projectName: "SHOP", title: "lab" }), AREA, none), { labelId: "sales", reason: "project" });
  assert.deepEqual(decide(issue({ title: "SENTRY: crash" }), AREA, none), { labelId: "platform", reason: "keywords" }, "title-only patterns count like keywords");
});

test("keywords weigh 3 in the title and 1 in the description; a tie without the current label decides nothing", () => {
  const none = () => [];
  assert.deepEqual(decide(issue({ title: "Customer view", description: "Qualität, lab" }), AREA, none), { labelId: "sales", reason: "keywords" }, "one title match (3) beats two description matches (2)");
  assert.equal(decide(issue({ title: "Customer lab" }), AREA, none), null);
  assert.deepEqual(decide(issue({ title: "Customer lab", labelIds: ["quality"] }), AREA, none), { labelId: "quality", reason: "keywords" });
  assert.equal(decide(issue({ title: "Rename things" }), AREA, none), null);
});

test("the plan swaps a wrong label, keeps a right one, and waits on new issues and unknown pull requests", () => {
  const issues = [
    issue({ id: "right", title: "customer", labelIds: ["sales"] }),
    issue({ id: "wrong", title: "customer fails", labelIds: ["quality", "feature"] }),
    issue({ id: "hand", title: "customer", labelIds: ["by-hand"] }),
    issue({ id: "new", title: "customer", createdAt: new Date(NOW - 1_000).toISOString() }),
    issue({ id: "pr", title: "customer", pullRequests: [PR] }),
  ];
  const { changes, waiting } = planLabelChanges(issues, [AREA, TYPE], () => null, NOW);
  assert.deepEqual(changes.map((change) => [change.issue.id, change.group.id, change.add, change.remove, change.reason]), [
    ["wrong", "area", "sales", ["quality"], "keywords"],
    ["wrong", "type", "bug", ["feature"], "keywords"],
    ["hand", "area", "sales", ["by-hand"], "keywords"],
  ]);
  assert.equal(waiting, 2);
});

test("a label counts as chosen by hand unless the latest change to the group's labels was the plugin's", () => {
  const group = new Set(["quality", "sales"]);
  const event = (at: string, actorId: string | null, added: string[], removed: string[] = []): LabelEvent => ({ at, actorId, added, removed });
  const plugin = "app";
  assert.equal(chosenByHand([event("2026-10-02", plugin, ["sales"], ["quality"])], group, true, plugin), false);
  assert.equal(chosenByHand([event("2026-10-01", plugin, ["sales"]), event("2026-10-02", "mirko", ["quality"], ["sales"])], group, true, plugin), true);
  assert.equal(chosenByHand([event("2026-10-03", "mirko", ["bug"]), event("2026-10-02", plugin, ["sales"])], group, true, plugin), false, "other groups' changes do not count");
  assert.equal(chosenByHand([event("2026-10-02", null, ["quality"])], group, true, plugin), true, "an integration chose it");
  assert.equal(chosenByHand([event("2026-10-02", "mirko", [], ["sales"])], group, false, plugin), true, "a person removed it: none stays");
  assert.equal(chosenByHand([], group, true, plugin), true, "set when the issue was created");
  assert.equal(chosenByHand([], group, false, plugin), false);
});
