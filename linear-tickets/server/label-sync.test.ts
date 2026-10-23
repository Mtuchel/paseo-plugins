import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { parseLabelRules, SETTLE_MS, type LabelEvent, type LabelRules, type SweptIssue } from "./label-rules";
import { LabelSync, PullRequestFiles, type PullRequestRead } from "./label-sync";
import type { CatalogLabel } from "./linear";
import { PullRequestNotFoundError } from "./pr-watch";
import { GitHubRateLimitedError } from "./rate-budget";

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

test("covered periodic sweeps reconcile at five minutes, coverage loss restores two minutes, and explicit sync stays immediate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  let covered = true;
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => RULES, covered: () => covered });
  t.after(() => labels.stop());
  labels.start();
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null], "startup does not wait for an event");
  t.mock.timers.tick(4 * 60_000);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null]);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null, new Date(NOW - 60_000).toISOString()]);
  await labels.sync();
  assert.equal(linear.sweeps.length, 3, "an explicit request bypasses the covered interval");
  covered = false;
  t.mock.timers.tick(2 * 60_000);
  await setImmediate();
  assert.equal(linear.sweeps.length, 4);
  t.mock.timers.tick(23 * 60_000);
  await setImmediate();
  assert.equal(linear.sweeps.at(-1), null, "the thirty-minute full sweep still runs");
});

test("creating local rules applies them on the next minute even with five-minute webhook coverage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  linear.issues = [issue("a", "Invoice routing")];
  let rules: LabelRules | null = null;
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => rules, covered: () => true });
  t.after(() => labels.stop());
  labels.start();
  await setImmediate();
  rules = parseLabelRules(JSON.stringify({ teamKeys: ["TUC"], groups: [{ name: "Area", labels: [{ name: "Billing", title: ["invoice"] }] }] }));
  t.mock.timers.tick(60_000);
  await setImmediate();
  const billing = linear.catalog.find((label) => label.name === "Billing");
  assert.ok(billing);
  assert.ok(linear.writes.includes(`a +${billing.id} -`), "new local rules label existing issues without waiting for reconciliation");
});

test("without coverage the periodic sweep retains its original two-minute interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "error", () => {});
  const linear = new FakeLinear();
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => RULES });
  t.after(() => labels.stop());
  labels.start();
  await setImmediate();
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null]);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null, new Date(NOW - 60_000).toISOString()]);
});

test("a covered read failure retries at the fast interval and still finds an issue from the failed window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => RULES, covered: () => true });
  t.after(() => labels.stop());
  labels.start();
  await setImmediate();
  const sweep = linear.labelSweep.bind(linear);
  let failing = true;
  t.mock.method(linear, "labelSweep", async (teams: string[], since: string | null, after: string | null) => {
    if (failing) throw new Error("read refused");
    return sweep(teams, since, after);
  });
  linear.issues = [{ ...issue("missed", "Customer list"), updatedAt: new Date(NOW + 1).toISOString() }];
  t.mock.timers.tick(5 * 60_000);
  await setImmediate();
  failing = false;
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null]);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null, new Date(NOW - 60_000).toISOString()]);
  assert.ok(linear.writes.includes("missed +new-3 -"));
});


test("issue events debounce into incremental sweeps even while a full recovery sweep is due", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  linear.issues = [{ ...issue("new", "Customer list"), createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }];
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => RULES, covered: () => true });
  t.after(() => labels.stop());
  labels.start();
  await setImmediate();
  const watermark = new Date(NOW - 60_000).toISOString();
  labels.issueChanged("new");
  t.mock.timers.tick(1_000);
  labels.issueChanged("another");
  t.mock.timers.tick(1_999);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null]);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null, watermark]);
  labels.stop();
  labels.issueChanged("new");
  t.mock.timers.tick(5_000);
  await setImmediate();
  assert.deepEqual(linear.sweeps, [null, watermark], "stopped hooks do not run");
});

test("catalog events resolve groups again and apply the newly available label without a restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  linear.issues = [issue("a", "Add feature")];
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => RULES, covered: () => true });
  t.after(() => labels.stop());
  labels.start();
  await setImmediate();
  assert.equal(linear.writes.some((write) => write.startsWith("a +")), false);
  linear.catalog.find((entry) => entry.id === "feature")!.parentId = linear.catalog.find((entry) => entry.name === "Type")!.id;
  labels.catalogChanged();
  t.mock.timers.tick(2_000);
  await setImmediate();
  assert.ok(linear.writes.includes("a +feature -"));
});

test("a failed label write keeps the incremental watermark so the next cycle retries the issue", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  let now = NOW;
  const labels = sync(linear, RULES, () => now);
  await labels.sync();
  const watermark = new Date(NOW - 60_000).toISOString();
  linear.issues = [{ ...issue("a", "Customer list"), updatedAt: new Date(NOW + 1).toISOString() }];
  now += 5 * 60_000;
  let failing = true;
  const changeLabels = linear.changeLabels.bind(linear);
  t.mock.method(linear, "changeLabels", async (id: string, added: string[], removed: string[]) => {
    if (failing) throw new Error("write refused");
    await changeLabels(id, added, removed);
  });
  await labels.sync();
  failing = false;
  now += 5 * 60_000;
  await labels.sync();
  assert.deepEqual(linear.sweeps, [null, watermark, watermark]);
  assert.ok(linear.writes.includes("a +new-3 -"));
});

test("a self-write issue event settles after one incremental pass instead of creating a write loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  linear.issues = [issue("a", "Customer list")];
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => RULES, covered: () => true });
  t.after(() => labels.stop());
  const changeLabels = linear.changeLabels.bind(linear);
  t.mock.method(linear, "changeLabels", async (id: string, added: string[], removed: string[]) => {
    await changeLabels(id, added, removed);
    const item = linear.issues.find((entry) => entry.id === id)!;
    item.labelIds = [...item.labelIds.filter((label) => !removed.includes(label)), ...added];
    item.updatedAt = new Date().toISOString();
    labels.issueChanged(id);
  });
  labels.start();
  await setImmediate();
  t.mock.timers.tick(2_000);
  await setImmediate();
  t.mock.timers.tick(2_000);
  await setImmediate();
  assert.deepEqual(linear.writes.filter((write) => write.startsWith("a +")), ["a +new-3 -"]);
  assert.deepEqual(linear.sweeps, [null, new Date(NOW - 60_000).toISOString()]);
});

test("pull request files: merged ones are kept on disk, open ones read again when stale, missing ones never again", async (t) => {
  t.mock.method(console, "error", () => {});
  const home = await mkdtemp(join(tmpdir(), "paseo-pr-files-"));
  try {
    const path = join(home, "pr-files.json");
    const reads: string[] = [];
    const answers: Record<string, () => PullRequestRead> = {
      merged: () => ({ state: "MERGED", files: ["o/r/a.ts"], mergedAt: "2026-10-01T10:00:00Z" }),
      open: () => ({ state: "OPEN", files: ["o/r/b.ts"], mergedAt: null }),
      missing: () => { throw new PullRequestNotFoundError("no pull request"); },
      broken: () => { throw new Error("gh: HTTP 502"); },
      throttled: () => { throw new GitHubRateLimitedError("HTTP 429"); },
      old: () => ({ state: "CLOSED", files: ["o/r/c.ts"], mergedAt: null }),
    };
    let now = NOW;
    const read = async (url: string) => { reads.push(url); return answers[url](); };
    const files = new PullRequestFiles(path, read, () => now);
    await files.refresh(["merged", "open", "missing", "broken", "throttled", "after"], 10);
    assert.deepEqual(reads, ["merged", "open", "missing", "broken", "throttled"], "throttling ends the reads");
    assert.deepEqual([files.filesOf("merged"), files.filesOf("open"), files.filesOf("missing"), files.filesOf("broken"), files.filesOf("after")], [["o/r/a.ts"], ["o/r/b.ts"], [], [], null]);
    assert.deepEqual([files.stateOf("merged"), files.stateOf("open"), files.stateOf("broken"), files.stateOf("after")], [{ state: "MERGED", mergedAt: "2026-10-01T10:00:00Z" }, { state: "OPEN", mergedAt: null }, null, null]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved, { pullRequests: { merged: { files: ["o/r/a.ts"], state: "MERGED", mergedAt: "2026-10-01T10:00:00Z" }, missing: { files: [], state: "MISSING", mergedAt: null } } });
    // An entry saved before the state was kept: its files are used, its state is read again once.
    await writeFile(path, JSON.stringify({ pullRequests: { ...saved.pullRequests, old: ["o/r/c.ts"] } }));
    reads.length = 0;
    now += 31 * 60 * 1000;
    const restarted = new PullRequestFiles(path, read, () => now);
    await restarted.refresh(["merged", "missing", "open"], 1);
    assert.deepEqual(reads, ["open"], "the limit counts reads, not known pull requests");
    assert.deepEqual([restarted.filesOf("merged"), restarted.filesOf("old"), restarted.stateOf("merged"), restarted.stateOf("old")], [["o/r/a.ts"], ["o/r/c.ts"], { state: "MERGED", mergedAt: "2026-10-01T10:00:00Z" }, null]);
    await restarted.refresh(["old"], 10);
    await restarted.refresh(["old"], 10);
    assert.deepEqual(reads, ["open", "old"], "a legacy entry is read again once");
    assert.deepEqual(restarted.stateOf("old"), { state: "CLOSED", mergedAt: null });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a catalog event during group resolution is not lost behind the in-flight catalog snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const linear = new FakeLinear();
  linear.issues = [issue("a", "Add feature")];
  // Executor form: the plugin's ES2023 lib has no Promise.withResolvers.
  let finish!: (catalog: CatalogLabel[]) => void;
  const snapshot = new Promise<CatalogLabel[]>((resolve) => { finish = resolve; });
  const oldCatalog = linear.catalog.map((entry) => ({ ...entry }));
  let reads = 0;
  t.mock.method(linear, "labelCatalog", async () => {
    reads++;
    return reads === 1 ? snapshot : linear.catalog;
  });
  const labels = new LabelSync({ linear, pullRequests: noFiles, rules: async () => RULES, covered: () => true });
  t.after(() => labels.stop());
  labels.start();
  await setImmediate();
  labels.catalogChanged();
  finish(oldCatalog);
  await setImmediate();
  assert.equal(linear.writes.some((write) => write.startsWith("a +")), false);
  linear.catalog.find((entry) => entry.id === "feature")!.parentId = linear.catalog.find((entry) => entry.name === "Type")!.id;
  t.mock.timers.tick(2_000);
  await setImmediate();
  assert.ok(linear.writes.includes("a +feature -"), "the catalog event forces a fresh resolution after the old snapshot completes");
});
