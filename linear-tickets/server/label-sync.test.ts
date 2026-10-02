import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseLabelRules, SETTLE_MS, type LabelEvent, type LabelRules, type SweptIssue } from "./label-rules";
import { LabelSync, PullRequestFiles, type PullRequestRead } from "./label-sync";
import type { CatalogLabel } from "./linear";
import { GitHubRateLimitedError, PullRequestNotFoundError } from "./pr-watch";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const OLD = new Date(NOW - SETTLE_MS - 1).toISOString();
const APP = "paseo-app";

const RULES = parseLabelRules(JSON.stringify({
  teamKeys: ["TUC"],
  groups: [
    { name: "Area", inherit: true, labels: [{ name: "Quality", color: "#16a34a", description: "QM", keywords: ["qualit"] }, { name: "Sales", keywords: ["customer"] }] },
    { name: "Type", labels: [{ name: "Bug", title: ["\\bfails\\b"] }, { name: "Feature", title: ["^add\\b"] }] },
  ],
}));

function issue(id: string, title: string, labelIds: string[] = []): SweptIssue {
  return { id, identifier: id.toUpperCase(), title, description: "", createdAt: OLD, updatedAt: OLD, projectName: null, parentId: null, parentLabelIds: [], labelIds, pullRequests: [] };
}

class FakeLinear {
  catalog: CatalogLabel[] = [
    { id: "bug", name: "Bug", isGroup: false, parentId: null, teamId: null },
    { id: "team-quality", name: "Quality", isGroup: false, parentId: null, teamId: "team" },
    { id: "old", name: "Old", isGroup: true, parentId: null, teamId: null },
    { id: "feature", name: "Feature", isGroup: false, parentId: "old", teamId: null },
  ];
  issues: SweptIssue[] = [];
  history = new Map<string, LabelEvent[]>();
  sweeps: (string | null)[] = [];
  writes: string[] = [];
  appUser: string | null = APP;
  private created = 0;

  async appUserId() { return this.appUser; }
  async labelCatalog() { return this.catalog; }
  async createLabel(input: { name: string; color?: string; description?: string; isGroup?: boolean; parentId?: string }) {
    const id = `new-${++this.created}`;
    this.writes.push(`create ${input.name}${input.isGroup ? " (group)" : ""}${input.parentId ? ` in ${input.parentId}` : ""}${input.color ? ` ${input.color}` : ""}${input.description ? ` "${input.description}"` : ""}`);
    this.catalog.push({ id, name: input.name, isGroup: input.isGroup === true, parentId: input.parentId ?? null, teamId: null });
    return id;
  }
  async moveLabelIntoGroup(labelId: string, groupId: string) { this.writes.push(`move ${labelId} into ${groupId}`); }
  async labelSweep(_teamKeys: string[], since: string | null, after: string | null) {
    if (!after) this.sweeps.push(since);
    const issues = since ? this.issues.filter((item) => item.updatedAt > since) : this.issues;
    return after ? { issues: issues.slice(1), next: null } : { issues: issues.slice(0, 1), next: issues.length > 1 ? "page-2" : null };
  }
  async labelHistory(issueId: string) { return this.history.get(issueId) ?? []; }
  async changeLabels(issueId: string, added: string[], removed: string[]) { this.writes.push(`${issueId} +${added.join(",")} -${removed.join(",")}`); }
}

const noFiles = { filesOf: () => null, refresh: async () => {} };

function sync(linear: FakeLinear, rules: LabelRules | null = RULES, now = () => NOW) {
  return new LabelSync({ linear, pullRequests: noFiles, rules: async () => rules, now });
}

test("the groups are made in Linear: missing labels created in them, ungrouped ones moved in, another group's label left out", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  await sync(linear).sync();
  assert.deepEqual(linear.writes, [
    "create Area (group)",
    "create Quality in new-1 #16a34a \"QM\"",
    "create Sales in new-1",
    "create Type (group)",
    "move bug into new-4",
  ]);
  assert.match(String(errors.mock.calls[0].arguments[0]), /"Feature" already belongs to another label group/);
});

test("each issue gets the rules' label; labels people chose stay; the plugin's own earlier labels are corrected", async (t) => {
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  linear.catalog = [
    { id: "area", name: "Area", isGroup: true, parentId: null, teamId: null },
    { id: "quality", name: "Quality", isGroup: false, parentId: "area", teamId: null },
    { id: "sales", name: "Sales", isGroup: false, parentId: "area", teamId: null },
    { id: "type", name: "Type", isGroup: true, parentId: null, teamId: null },
    { id: "bug", name: "Bug", isGroup: false, parentId: "type", teamId: null },
    { id: "feature", name: "Feature", isGroup: false, parentId: "type", teamId: null },
  ];
  linear.issues = [
    issue("fresh", "Customer import fails"),
    issue("ours", "Customer list", ["quality"]),
    issue("theirs", "Customer list", ["quality", "feature"]),
    issue("right", "Customer list", ["sales"]),
    issue("new", "Customer list"),
  ];
  linear.issues[4].createdAt = new Date(NOW - 1_000).toISOString();
  linear.history.set("ours", [{ at: "2026-10-01", actorId: APP, added: ["quality"], removed: [] }]);
  // A person picked Quality after the plugin's Sales; Feature came with the issue (no history).
  linear.history.set("theirs", [{ at: "2026-10-01", actorId: "mirko", added: ["quality"], removed: ["sales"] }, { at: "2026-09-30", actorId: APP, added: ["sales"], removed: [] }]);
  const labels = sync(linear);
  await labels.sync();
  assert.deepEqual(linear.writes, ["fresh +sales -", "fresh +bug -", "ours +sales -quality"]);
  assert.deepEqual(linear.sweeps, [null]);
});

test("later cycles read only issues updated since the last, unless issues are still undecided", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  let now = NOW;
  const labels = sync(linear, RULES, () => now);
  linear.issues = [issue("a", "Customer list")];
  await labels.sync();
  now += 2 * 60 * 1000;
  await labels.sync();
  const watermark = new Date(NOW - 60 * 1000).toISOString();
  assert.deepEqual(linear.sweeps, [null, watermark], "the second cycle overlaps the first by a minute");
  linear.issues.push({ ...issue("b", "Customer list"), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
  now += 2 * 60 * 1000;
  await labels.sync();
  now += 2 * 60 * 1000;
  await labels.sync();
  assert.equal(linear.sweeps[3], null, "a new issue inside Linear's creation window brings a full sweep next");
});

test("without the Paseo app nothing is written: its authorship is what marks the plugin's labels", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  linear.appUser = null;
  await sync(linear).sync();
  assert.deepEqual(linear.writes, []);
  assert.match(String(errors.mock.calls[0].arguments[0]), /Paseo Linear app is not usable/);
  const off = new FakeLinear();
  await sync(off, null).sync();
  assert.deepEqual([off.writes, off.sweeps], [[], []], "no rules file: the feature is off");
});

test("pull request files: merged ones are kept on disk, open ones read again when stale, missing ones never again", async (t) => {
  t.mock.method(console, "error", () => {});
  const home = await mkdtemp(join(tmpdir(), "paseo-pr-files-"));
  try {
    const path = join(home, "pr-files.json");
    const reads: string[] = [];
    const answers: Record<string, () => PullRequestRead> = {
      merged: () => ({ state: "MERGED", files: ["o/r/a.ts"] }),
      open: () => ({ state: "OPEN", files: ["o/r/b.ts"] }),
      missing: () => { throw new PullRequestNotFoundError("no pull request"); },
      broken: () => { throw new Error("gh: HTTP 502"); },
      throttled: () => { throw new GitHubRateLimitedError("HTTP 429"); },
    };
    let now = NOW;
    const read = async (url: string) => { reads.push(url); return answers[url](); };
    const files = new PullRequestFiles(path, read, () => now);
    await files.refresh(["merged", "open", "missing", "broken", "throttled", "after"], 10);
    assert.deepEqual(reads, ["merged", "open", "missing", "broken", "throttled"], "throttling ends the reads");
    assert.deepEqual([files.filesOf("merged"), files.filesOf("open"), files.filesOf("missing"), files.filesOf("broken"), files.filesOf("after")], [["o/r/a.ts"], ["o/r/b.ts"], [], [], null]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { pullRequests: { merged: ["o/r/a.ts"], missing: [] } });
    reads.length = 0;
    now += 31 * 60 * 1000;
    const restarted = new PullRequestFiles(path, read, () => now);
    await restarted.refresh(["merged", "missing", "open"], 1);
    assert.deepEqual(reads, ["open"], "the limit counts reads, not known pull requests");
    assert.deepEqual(restarted.filesOf("merged"), ["o/r/a.ts"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
