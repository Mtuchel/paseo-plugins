import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { parseLabelRules, type LabelRules } from "./label-rules";
import type { CandidateIssue, CatalogLabel, IssueRelation, NewIssue } from "./linear";
import { NewTicketCheck, NewTicketStore, SAME_AS_DELAY_MS } from "./new-ticket-check";
import { AREA_REQUEST, COMMENT_HEADING } from "./new-ticket-match";
import { RateLimitedError } from "./rate-budget";
import type { OpenWork } from "./related-work";
import { DEFAULT_ACTIVATION, DEFAULT_BACKSTOP, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_STEWARD, DEFAULT_WATCHDOG, DEFAULT_WORKTREE_SHARDS, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";

const START = Date.parse("2026-10-15T12:00:00Z");
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false,
  lastProvider: "claude", launchPreferences: {}, projectMappings: {}, agentLinearAccess: true,
  dispatch: { ...DEFAULT_DISPATCH, enabled: true, teamKeys: ["TUC"] },
  writeback: DEFAULT_WRITEBACK, watchdog: DEFAULT_WATCHDOG, steward: DEFAULT_STEWARD, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, reviewPeers: [], activation: DEFAULT_ACTIVATION, backstop: DEFAULT_BACKSTOP, deputy: DEFAULT_DEPUTY, worktreeShards: DEFAULT_WORKTREE_SHARDS,
};
const AREA_RULES = [{ name: "Area", labels: [{ name: "Sales", keywords: ["customer"], paths: ["o/r/**/sales/**"] }, { name: "Quality", keywords: ["qualit"] }] }];
const RULES = parseLabelRules(JSON.stringify({ teamKeys: ["TUC"], groups: AREA_RULES }));
const AREA_CATALOG: CatalogLabel[] = [
  { id: "area", name: "Area", isGroup: true, parentId: null, teamId: null },
  { id: "sales", name: "Sales", isGroup: false, parentId: "area", teamId: null },
  { id: "quality", name: "Quality", isGroup: false, parentId: "area", teamId: null },
];
const MISS_CATALOG: CatalogLabel[] = ["missed-reach", "missed-conflict", "broke-rule"].map((name) => ({ id: name, name, isGroup: false, parentId: null, teamId: null }));
const paseo = {} as PaseoApi;

function candidate(n: number, over: Partial<CandidateIssue> = {}): CandidateIssue {
  return { id: `o${n}`, identifier: `TUC-${n}`, title: `Open ticket ${n}`, description: "", updatedAt: "2026-10-14T00:00:00Z", status: "Todo", statusType: "unstarted", labels: [], pullRequests: [], planDocuments: [], ...over };
}

// A Linear workspace in memory: new tickets, open work, labels, comments, relations; every call counted.
class World {
  clock = START;
  tickets: NewIssue[] = [];
  open: CandidateIssue[] = [candidate(640, { title: "Gutschrift PDF falsche USt bei Teilgutschrift" })];
  plans: OpenWork["plans"] = [];
  unreadPlans: string[] = [];
  openComplete = true;
  catalog: CatalogLabel[] = [...AREA_CATALOG, ...MISS_CATALOG];
  rules: () => Promise<LabelRules | null> = async () => RULES;
  comments: { id: string; issueId: string; body: string }[] = [];
  relations = new Map<string, IssueRelation[]>();
  calls: string[] = [];
  created: { name: string; color?: string; description?: string }[] = [];
  pageSize = 50;
  failPage: number | null = null;
  failOpenWork = false;
  failCreate = 0;
  failRelate = 0;
  loseCommentAnswer = false;
  app: string | null = "app-server";
  private seq = 0;

  file(over: Partial<NewIssue> = {}): NewIssue {
    const n = 900 + this.tickets.length;
    const issue: NewIssue = {
      id: `n${n}`, identifier: `TUC-${n}`, title: `Neues Thema ${n}`, description: "", createdAt: new Date(this.clock).toISOString(), updatedAt: new Date(this.clock).toISOString(),
      projectName: null, parentId: null, parentLabelIds: [], labelIds: [], pullRequests: [], teamId: "team-tuc", teamKey: "TUC", url: `https://linear.app/t/issue/TUC-${n}`,
      creatorId: "owner", statusType: "unstarted", labelNames: [], ...over,
    };
    this.tickets.push(issue);
    return issue;
  }

  count(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }

  readonly linear = {
    appUserId: async () => this.app,
    trustedAppIds: async () => ["app-server", "app-laptop"],
    newIssues: async (teamKeys: string[], since: string, after: string | null) => {
      this.calls.push("newIssues");
      const all = this.tickets.filter((issue) => teamKeys.includes(issue.teamKey) && issue.createdAt >= since)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const start = after === null ? 0 : all.findIndex((issue) => issue.id === after) + 1;
      if (this.failPage !== null && start > 0 && Math.floor(start / this.pageSize) + 1 === this.failPage) throw new Error("page read failed");
      const issues = all.slice(start, start + this.pageSize).map((issue) => structuredClone(issue));
      return { issues, next: start + this.pageSize < all.length ? issues[issues.length - 1].id : null };
    },
    issuesById: async (ids: string[]) => {
      this.calls.push("issuesById");
      return this.tickets.filter((issue) => ids.includes(issue.id)).map((issue) => structuredClone(issue));
    },
    labelCatalog: async () => {
      this.calls.push("labelCatalog");
      return structuredClone(this.catalog);
    },
    createLabel: async (input: { name: string; color?: string; description?: string }) => {
      this.calls.push("createLabel");
      if (this.failCreate > 0) { this.failCreate--; throw new Error("create failed"); }
      this.created.push(input);
      this.catalog.push({ id: input.name, name: input.name, isGroup: false, parentId: null, teamId: null });
      return input.name;
    },
    commentAsApp: async (issueId: string, body: string, id?: string) => {
      this.calls.push("commentAsApp");
      this.comments.push({ id: id ?? `c${++this.seq}`, issueId, body });
      if (this.loseCommentAnswer) { this.loseCommentAnswer = false; throw new Error("connection reset"); }
      return true as const;
    },
    commentById: async (id: string) => {
      this.calls.push("commentById");
      return this.comments.some((comment) => comment.id === id) ? ({ id } as never) : null;
    },
    addLabelAsApp: async (issueId: string, name: string) => {
      this.calls.push("addLabelAsApp");
      const label = this.catalog.find((entry) => entry.name === name && !entry.isGroup);
      const issue = this.tickets.find((entry) => entry.id === issueId);
      if (!label || !issue) return null;
      issue.labelIds.push(label.id);
      issue.labelNames.push(name);
      return true as const;
    },
    relateAsApp: async (issueId: string, relatedId: string, type: string) => {
      this.calls.push("relateAsApp");
      if (this.failRelate > 0) { this.failRelate--; return null; }
      const target = [...this.tickets, ...this.open].find((issue) => issue.id === relatedId)!;
      this.relations.set(issueId, [...(this.relations.get(issueId) ?? []), { type, direction: "out", id: relatedId, identifier: target.identifier }]);
      return true as const;
    },
    issueRelations: async (issueId: string) => {
      this.calls.push("issueRelations");
      return this.relations.get(issueId) ?? [];
    },
    issueRef: async (identifier: string) => {
      this.calls.push("issueRef");
      const found = [...this.tickets, ...this.open].find((issue) => issue.identifier === identifier);
      return found ? { id: found.id, identifier: found.identifier, title: found.title } : null;
    },
  };

  readonly related = {
    openWork: async (_teamId: string): Promise<OpenWork> => {
      this.calls.push("openWork");
      if (this.failOpenWork) throw new Error("Linear is unavailable");
      return { open: { items: this.open, complete: this.openComplete }, plans: this.plans, unreadPlans: this.unreadPlans };
    },
  };
}

type Harness = { world: World; check: () => NewTicketCheck; tick: (check?: NewTicketCheck) => Promise<void>; store: NewTicketStore; path: string };

// A world and a check whose first poll has run (the cursor starts at START), unless `started` is false.
async function harness(t: TestContext, options: { started?: boolean; files?: Record<string, string[]> } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "new-ticket-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "new-ticket-check.json");
  const world = new World();
  const store = new NewTicketStore(path);
  const make = () => new NewTicketCheck({
    linear: world.linear, related: world.related, store, now: () => world.clock,
    pullRequests: { filesOf: (url) => options.files?.[url] ?? null }, rules: () => world.rules(),
  });
  let current = make();
  const tick = (check: NewTicketCheck = current) => check.tick(paseo, settings);
  if (options.started !== false) {
    await tick();
    world.clock += 1000;
    world.calls.length = 0;
  }
  return { world, check: () => (current = make()), tick, store, path };
}

const commentsOn = (world: World, issue: NewIssue) => world.comments.filter((comment) => comment.issueId === issue.id);

test("AC-1: a ticket close to an open one gets exactly one comment in the poll that finds it, never again", async (t) => {
  const { world, tick, check } = await harness(t);
  const issue = world.file({ title: "Gutschrift-PDF zeigt falsche USt", labelIds: ["sales"], labelNames: ["Area: Sales"] });
  await tick();
  const [comment] = commentsOn(world, issue);
  assert.equal(commentsOn(world, issue).length, 1);
  assert.ok(comment.body.startsWith(`${COMMENT_HEADING}\n\n- TUC-640 — Gutschrift PDF falsche USt bei Teilgutschrift (Todo): similar title (gutschrift, pdf, falsche, ust)`));
  assert.equal(world.count("issuesById"), 0, "the ticket found by this poll is checked from that read");
  await tick();
  await tick(check());
  assert.equal(commentsOn(world, issue).length, 1, "a second poll and a restart post nothing");
});

test("AC-1: a backticked file shared with an approved plan is named; a shared Area alone is no comment", async (t) => {
  const { world, tick } = await harness(t);
  world.open.push(candidate(656, { title: "Plan only", labels: ["Area: Sales"] }));
  world.plans = [{ identifier: "TUC-656", files: ["server/billing/vat.ts"] }];
  const filed = world.file({ title: "Rundung", description: "Betrifft `server/billing/vat.ts`.", labelIds: ["sales"], labelNames: ["Area: Sales"] });
  const alone = world.file({ title: "Etwas anderes", labelIds: ["sales"], labelNames: ["Area: Sales"] });
  await tick();
  assert.match(commentsOn(world, filed)[0].body, /^- TUC-656 — Plan only \(Todo\): files named in its approved plan: `server\/billing\/vat\.ts`; same Area \(Sales\)$/m);
  assert.equal(commentsOn(world, alone).length, 0);
  await tick();
  assert.equal(world.count("openWork"), 1, "the Area-only ticket is done, not retried");
});

test("AC-1: a post whose answer was lost is found by its reserved id on the next poll, not posted twice", async (t) => {
  const { world, tick, check } = await harness(t);
  const issue = world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  world.loseCommentAnswer = true;
  await tick();
  assert.equal(commentsOn(world, issue).length, 1);
  await tick(check());
  assert.equal(commentsOn(world, issue).length, 1);
  assert.equal(world.count("commentById"), 1);
  await tick();
  assert.equal(world.count("commentById"), 1, "done after the lookup");
});

test("AC-1: the cursor — first run, equal times across a page boundary, a failed page, an empty poll", async (t) => {
  const { world, tick, path } = await harness(t, { started: false });
  world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  world.clock += 1000;
  await tick();
  assert.equal(world.comments.length, 0, "the first run checks nothing filed before it");
  assert.equal(world.count("newIssues"), 0);
  const started = JSON.parse(await readFile(path, "utf8")).since;
  assert.equal(started, new Date(START + 1000).toISOString());

  world.pageSize = 1;
  const first = world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  const second = world.file({ title: "Gutschrift PDF falsche USt zeigt Summe" });
  world.failPage = 2;
  await tick();
  assert.equal(world.comments.length, 0);
  assert.equal(JSON.parse(await readFile(path, "utf8")).since, started, "a failed second page leaves the cursor");
  world.failPage = null;
  await tick();
  assert.deepEqual(world.comments.map((comment) => comment.issueId).sort(), [first.id, second.id], "both tickets of the same second, across pages");
  const since = JSON.parse(await readFile(path, "utf8")).since;
  assert.equal(since, first.createdAt);
  await tick();
  assert.equal(JSON.parse(await readFile(path, "utf8")).since, since, "an empty poll keeps the cursor");
  assert.equal(world.comments.length, 2);
  world.clock += 1000;
  const after = world.file({ title: "Gutschrift PDF falsche USt im Export" });
  await tick();
  assert.equal(commentsOn(world, after).length, 1, "a ticket filed after an empty poll is found by the next one");
});

test("AC-1: a discovery longer than 10 pages continues on the next poll", async (t) => {
  const { world, tick, path } = await harness(t);
  world.pageSize = 1;
  for (let n = 0; n < 12; n++) { world.file({ title: `Gutschrift PDF falsche USt Variante ${n}` }); world.clock += 1000; }
  await tick();
  assert.equal(world.count("newIssues"), 10);
  assert.equal(world.comments.length, 10);
  const scanned = JSON.parse(await readFile(path, "utf8"));
  assert.ok(scanned.scan);
  await tick();
  assert.equal(world.comments.length, 12);
  const done = JSON.parse(await readFile(path, "utf8"));
  assert.equal(done.scan, null);
  assert.equal(done.since, world.tickets[11].createdAt);
});

test("AC-1/AC-2: a ticket canceled while pending, and a Paseo-filed one, are done without a comment", async (t) => {
  const { world, tick } = await harness(t);
  world.openComplete = false;
  const canceled = world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  world.file({ title: "Gutschrift-PDF zeigt falsche USt", creatorId: "app-laptop" });
  world.file({ title: "Gutschrift-PDF zeigt falsche USt", description: "Filed by Paseo for the owner." });
  await tick();
  assert.equal(world.comments.length, 0);
  canceled.statusType = "canceled";
  world.openComplete = true;
  await tick();
  assert.equal(world.comments.length, 0);
  assert.equal(world.count("openWork"), 1, "only the waiting ticket read open work; the Paseo-filed ones read nothing");
  await tick();
  assert.equal(world.count("issuesById"), 1, "nothing is pending any more");
});

test("AC-1: thrown reads keep a ticket pending without using up its tries; three stop the poll", async (t) => {
  const { world, tick, path } = await harness(t);
  world.failOpenWork = true;
  for (let n = 0; n < 4; n++) world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  for (let n = 0; n < 6; n++) await tick();
  assert.equal(world.count("openWork"), 18, "three failed reads per poll");
  const stored = JSON.parse(await readFile(path, "utf8")).tickets as Record<string, { tries: number; commented: boolean }>;
  assert.ok(Object.values(stored).every((entry) => entry.tries === 0 && !entry.commented), "pending, tries unchanged");
  world.failOpenWork = false;
  await tick();
  assert.equal(world.comments.length, 4);
  assert.ok(world.comments.every((comment) => !comment.body.includes("Not fully checked")), "failures are no gap");
});

test("AC-1: incomplete inputs wait up to 5 polls, then the comment names what was not read", async (t) => {
  const { world, tick, path } = await harness(t);
  world.unreadPlans = ["Plan: TUC-650"];
  const later = world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  await tick();
  assert.equal(world.comments.length, 0);
  world.unreadPlans = [];
  await tick();
  assert.equal(commentsOn(world, later).length, 1);
  assert.ok(!commentsOn(world, later)[0].body.includes("Not fully checked"), "a plan readable on the next poll leaves no gap");

  world.unreadPlans = ["Plan: TUC-650"];
  world.openComplete = false;
  const gapped = world.file({ title: "Gutschrift PDF zeigt falsche USt" });
  for (let n = 0; n < 4; n++) await tick();
  assert.equal(commentsOn(world, gapped).length, 0);
  await tick();
  assert.match(commentsOn(world, gapped)[0].body, /Not fully checked: only part of the team's open tickets could be read; the plans of TUC-650 could not be read\.$/);

  // Nothing to say after 5 incomplete polls: no comment, and phase 1 is over.
  const quiet = world.file({ title: "Etwas anderes", labelIds: ["sales"], labelNames: ["Area: Sales"] });
  for (let n = 0; n < 5; n++) await tick();
  assert.equal(commentsOn(world, quiet).length, 0);
  assert.equal(JSON.parse(await readFile(path, "utf8")).tickets[quiet.id].commented, true);
});

test("AC-1/AC-4: an invalid label-rules.json is a gap, and no Area is asked for", async (t) => {
  const { world, tick } = await harness(t);
  world.rules = async () => { throw new Error("label-rules.json is not valid JSON"); };
  const issue = world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  for (let n = 0; n < 5; n++) await tick();
  const [comment] = commentsOn(world, issue);
  assert.ok(!comment.body.includes(AREA_REQUEST));
  assert.match(comment.body, /Not fully checked: the label rules could not be read \(label-rules\.json is not valid JSON\)\.$/);
});

test("AC-4: the Area is asked for only when Linear has the group, the ticket has none and label sync sets none", async (t) => {
  const cases: { name: string; ask: boolean; setup?: (world: World) => void; over?: Partial<NewIssue>; files?: Record<string, string[]> }[] = [
    { name: "no rule matches", ask: true },
    { name: "a keyword sets Sales", ask: false, over: { description: "A customer reports it." } },
    { name: "the ticket has an Area", ask: false, over: { labelIds: ["quality"], labelNames: ["Area: Quality"] } },
    { name: "Linear has no workspace Area group", ask: false, setup: (world) => { world.catalog = [...MISS_CATALOG]; } },
    { name: "the Area group is a team's", ask: false, setup: (world) => { world.catalog = [{ ...AREA_CATALOG[0], teamId: "team-tuc" }, ...MISS_CATALOG]; } },
    { name: "no rules file", ask: true, setup: (world) => { world.rules = async () => null; } },
    { name: "the rules leave out the team", ask: true, setup: (world) => { world.rules = async () => parseLabelRules(JSON.stringify({ teamKeys: ["ENG"], groups: AREA_RULES })); } },
    { name: "the rules have no Area group", ask: true, setup: (world) => { world.rules = async () => parseLabelRules(JSON.stringify({ teamKeys: ["TUC"], groups: [{ name: "Type", labels: [{ name: "Bug" }] }] })); } },
    { name: "a pull request's files are not read yet", ask: false, over: { pullRequests: ["https://github.com/o/r/pull/1"] } },
  ];
  for (const entry of cases) {
    const { world, tick } = await harness(t);
    entry.setup?.(world);
    const issue = world.file({ title: "Etwas anderes", ...entry.over });
    await tick();
    const comments = commentsOn(world, issue);
    assert.deepEqual(comments.map((comment) => comment.body), entry.ask ? [AREA_REQUEST] : [], entry.name);
  }
});

test("AC-5: the miss labels are created once, a failed create is retried, a conflicting one is never applied", async (t) => {
  const { world, tick, check } = await harness(t, { started: false });
  world.catalog = [...AREA_CATALOG];
  world.failCreate = 1;
  await tick();
  assert.equal(world.count("createLabel"), 1);
  await tick();
  assert.deepEqual(world.catalog.filter((label) => !label.parentId && !label.isGroup).map((label) => label.name).sort(), ["broke-rule", "missed-conflict", "missed-reach"]);
  assert.ok(world.created.length === 3 && world.created.every((label) => label.color && label.description), "each with a colour and a description");
  world.calls.length = 0;
  await tick();
  assert.deepEqual(world.calls, ["newIssues"], "an idle poll after the labels resolved reads only new tickets (AC-8)");

  // A grouped `missed-reach`: reported, never applied, also after a restart.
  world.catalog = [...AREA_CATALOG, { id: "g", name: "Misses", isGroup: true, parentId: null, teamId: null }, { id: "mr", name: "missed-reach", isGroup: false, parentId: "g", teamId: null }, ...MISS_CATALOG.slice(1)];
  for (let restart = 0; restart < 2; restart++) {
    const issue = world.file({ title: "Mahnung", description: "Same bug as TUC-640, here on the dunning page." });
    world.clock += SAME_AS_DELAY_MS;
    await tick(check());
    assert.equal(world.count("addLabelAsApp"), 0);
    assert.deepEqual((world.relations.get(issue.id) ?? []).map((relation) => relation.identifier), ["TUC-640"], "the relation is still written");
  }
});

test("AC-5: a same-as bug gets the label and its relations after 10 minutes, once", async (t) => {
  const { world, tick, check } = await harness(t);
  world.open.push(candidate(641, { title: "Dunning totals" }));
  const issue = world.file({ title: "Mahnung zeigt falsche Summe", description: "Same bug as TUC-640 on the dunning page. Same bug as TUC-641 on another page. Same bug as TUC-999 on the third page." });
  await tick();
  assert.equal(world.count("relateAsApp"), 0, "not before 10 minutes");
  world.clock += SAME_AS_DELAY_MS;
  world.failOpenWork = true;
  world.failRelate = 1;
  await tick();
  assert.equal(world.count("relateAsApp"), 1, "a failed relation stops this poll");
  world.calls.length = 0;
  await tick(check());
  assert.deepEqual(issue.labelNames, ["missed-reach"], "one label, not added twice");
  assert.deepEqual(world.relations.get(issue.id)!.map((relation) => relation.identifier), ["TUC-640", "TUC-641"]);
  assert.deepEqual(world.calls.filter((call) => call !== "newIssues" && call !== "labelCatalog"), ["issuesById", "issueRelations", "issueRef", "issueRef", "issueRef", "relateAsApp", "relateAsApp"], "the label is there; an unknown identifier writes nothing (AC-8)");
  world.calls.length = 0;
  await tick();
  assert.deepEqual(world.calls, ["newIssues"]);
});

test("AC-5: a crash after the writes replays as no-ops; a ticket canceled between the phases gets none", async (t) => {
  const { world, tick, path } = await harness(t);
  const issue = world.file({ title: "Mahnung", description: "Same bug as TUC-640 on another page." });
  const canceled = world.file({ title: "Lieferschein", description: "Same issue as TUC-640 on the delivery note." });
  await tick();
  const saved = await readFile(path, "utf8");
  canceled.statusType = "canceled";
  world.clock += SAME_AS_DELAY_MS;
  await tick();
  assert.equal(world.relations.get(canceled.id), undefined);
  assert.equal(world.count("addLabelAsApp"), 1);
  await writeFile(path, saved);
  world.calls.length = 0;
  await tick();
  assert.equal(world.count("addLabelAsApp") + world.count("relateAsApp"), 0, "label and relation present: skipped");
  assert.equal(world.relations.get(issue.id)!.length, 1);
});

test("AC-7: no Linear call when activation is remote, dispatch is off or no team is set", async (t) => {
  const { world, check } = await harness(t, { started: false });
  const instance = check();
  for (const variant of [
    { ...settings, activation: { ...settings.activation, mode: "remote" as const } },
    { ...settings, dispatch: { ...settings.dispatch, enabled: false } },
    { ...settings, dispatch: { ...settings.dispatch, teamKeys: [] } },
  ]) await instance.tick(paseo, variant);
  assert.deepEqual(world.calls, []);
});

test("AC-8: two new tickets of one team share one read of open work", async (t) => {
  const { world, tick } = await harness(t);
  world.file({ title: "Gutschrift-PDF zeigt falsche USt" });
  world.file({ title: "Gutschrift PDF zeigt falsche USt erneut" });
  await tick();
  assert.equal(world.comments.length, 2);
  assert.deepEqual(world.calls.filter((call) => call === "openWork" || call === "labelCatalog"), ["openWork", "labelCatalog"]);
});

test("a rate limit is passed on to the dispatcher; other failures are not", async (t) => {
  const { world, tick } = await harness(t);
  world.linear.newIssues = async () => { throw new RateLimitedError("app", START + 60_000); };
  await assert.rejects(tick(), RateLimitedError);
  world.linear.newIssues = async () => { throw new Error("boom"); };
  await tick();
});
