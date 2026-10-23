import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { PlanRequests, TrustedApps, planRequestText, type PlanRequest } from "./plan-requests";
import { planSetup } from "./starter";
import { documentPlanHash } from "./review-outcome";

// A replan request is a trusted comment for this plan's hash, or the owner's `plan` label add.
// These tests pin what counts, what reaches the agent, and what is never delivered twice.

type Comment = { id: string; at: string; authorId: string | null; body: string };
type LabelEvent = { at: string; actorId: string | null; added: string[]; removed: string[] };

const PLAN = "# Plan\n\nDo the work.\n\n## Risk and impact\n\n- Impact: 1\n";
const APPROVED_AT = "2026-10-01T10:00:00.000Z";
const CREATED_AT = "2026-10-02T10:00:00.000Z";
const hash = documentPlanHash(PLAN);
const marker = (op: string, about = hash) => `🔁 **Replan requested**\n\nReason here.\n\n<!-- replan-op: ${op} -->\n<!-- replan-for: ${about} -->`;
const comment = (id: string, at: string, authorId: string | null, op = "11111111-1111-4111-8111-111111111111", about = hash): Comment => ({ id, at, authorId, body: marker(op, about) });

async function harness(run: (h: {
  requests: PlanRequests;
  restart: () => Promise<PlanRequests>;
  prompts: string[];
  comments: Comment[];
  events: LabelEvent[];
  files: () => Promise<string[]>;
  file: (agentId: string) => Promise<{ identifier: string; at: string; message: string }>;
  directory: string;
  delivery: { outcome: "sent" | "busy" | "waiting" | "unavailable" };
}) => Promise<void>, options: { comments?: Comment[]; events?: LabelEvent[]; plan?: string | null; labels?: { id: string; name: string }[]; apps?: string[]; provider?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-requests-"));
  const prompts: string[] = [];
  const comments = options.comments ?? [];
  const events = options.events ?? [];
  const plan = options.plan === undefined ? { content: PLAN } : options.plan === null ? null : { content: options.plan };
  const labels = options.labels ?? [{ id: "label-plan", name: "plan" }];
  const paseo = {
    agents: { list: async () => ({ entries: [{ agent: { id: "agent-1", createdAt: CREATED_AT, provider: options.provider ?? "omp", labels: { "linear.issueId": "issue-1", "linear.identifier": "TUC-7" } } }], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const delivery = { outcome: "sent" as "sent" | "busy" | "waiting" | "unavailable" };
  const build = () => new PlanRequests({
    linear: {
      // As Linear's: a label change moves the ticket's `updatedAt`, a replan comment is its newest.
      // The fixture's dates are older than the clock, so the read's `since` window is not modelled.
      planRequestStamps: async (ids: string[]) => new Map(ids.map((id) => [id, {
        updatedAt: [CREATED_AT, ...events.map((event) => event.at)].sort().at(-1)!,
        replanAt: comments.map((item) => item.at).sort().at(-1) ?? null,
      }])),
      issueDocument: async () => plan,
      replanComments: async (_issueId: string, since: string) => comments.filter((item) => item.at > since),
      existingLabelId: async (name: string) => labels.find((label) => label.name.trim().toLowerCase() === name)?.id ?? null,
      // As Linear's: the predicate only ends the paging, every label change read is returned.
      labelHistory: async () => events,
      viewerId: async () => "owner-1",
    } as never,
    apps: { ids: async () => options.apps ?? ["app-1"] },
    prompt: async (agentId: string, text: string) => { prompts.push(`${agentId}: ${text}`); return delivery.outcome; },
    directory,
  });
  let requests = build();
  requests.attach(paseo);
  const files = async () => (await readdir(directory)).filter((name) => name !== "state.json").sort();
  try {
    await requests.poll();
    await run({
      get requests() { return requests; },
      restart: async () => {
        requests.stop();
        requests = build();
        requests.attach(paseo);
        await requests.poll();
        return requests;
      },
      prompts, comments, events, files, directory, delivery, file: async (agentId) => JSON.parse(await readFile(join(directory, agentId), "utf8")),
    });
  } finally {
    requests.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

test("AC-13: a trusted replan comment for the current plan reaches the agent once, with the request's text", async () => {
  await harness(async ({ requests, prompts, comments, files, file }) => {
    assert.deepEqual(prompts, []);
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1"));
    await requests.poll();
    assert.deepEqual(await files(), ["agent-1"]);
    const written = await file("agent-1");
    assert.equal(written.identifier, "TUC-7");
    assert.match(written.message, /asked for this plan to be revised/);
    assert.equal(prompts.length, 1);
    await requests.poll();
    assert.equal(prompts.length, 1, "a handled request is never delivered twice");
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-03T10:00:00.000Z");
  });
});

test("AC-13: a replan comment from anyone but a trusted Paseo app is ignored", async () => {
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { comments: [comment("c-1", "2026-10-03T10:00:00.000Z", "owner-1")] });
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { comments: [comment("c-1", "2026-10-03T10:00:00.000Z", null)] });
});

test("AC-13: a replan comment written for another plan is ignored", async () => {
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { comments: [comment("c-1", "2026-10-03T10:00:00.000Z", "app-1", "22222222-2222-4222-8222-222222222222", "3333333333333333333333333333333333333333333333333333333333333333")] });
});

test("AC-13: a comment on a ticket without an approved plan asks for nothing", async () => {
  await harness(async ({ prompts, files }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { plan: null, comments: [comment("c-1", "2026-10-03T10:00:00.000Z", "app-1")] });
});

test("AC-13: the owner's plan label add is a request; an app's add is only the comment's indicator", async () => {
  const ownerAdd: LabelEvent[] = [{ at: "2026-10-03T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] }];
  await harness(async ({ files }) => { assert.deepEqual(await files(), ["agent-1"]); }, { events: ownerAdd });
  await harness(async ({ files, prompts }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { events: [{ at: "2026-10-03T09:00:00.000Z", actorId: "app-1", added: ["label-plan"], removed: [] }] });
});

test("AC-13: a label add from before the agent started asks for nothing", async () => {
  await harness(async ({ files, prompts }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
  }, { events: [{ at: "2026-10-01T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] }] });
});

test("AC-13: the owner's other label changes, and removing the plan label, ask for nothing", async () => {
  await harness(async ({ files, prompts, requests }) => {
    assert.deepEqual(await files(), []);
    assert.deepEqual(prompts, []);
    assert.equal(await requests.roundStartedAt("agent-1"), null);
  }, { events: [
    { at: "2026-10-03T09:00:00.000Z", actorId: "owner-1", added: ["label-bug"], removed: [] },
    { at: "2026-10-03T10:00:00.000Z", actorId: "owner-1", added: [], removed: ["label-plan"] },
  ] });
});

test("the round's start is the newest request delivered to the agent, and null before any", async () => {
  await harness(async ({ requests }) => {
    assert.equal(await requests.roundStartedAt("agent-1"), null);
  });
  await harness(async ({ requests, comments }) => {
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1", "11111111-1111-4111-8111-111111111111"), comment("c-2", "2026-10-04T10:00:00.000Z", "app-1", "22222222-2222-4222-8222-222222222222"));
    await requests.poll();
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-04T10:00:00.000Z");
    assert.equal(await requests.roundStartedAt("agent-2"), null);
  });
});

test("a peer's older comment trusted after a newer request does not move the round's start back", async () => {
  const apps = ["app-1"];
  await harness(async ({ requests, comments }) => {
    comments.push(comment("c-old", "2026-10-03T10:00:00.000Z", "peer-app", "33333333-3333-4333-8333-333333333333"), comment("c-new", "2026-10-04T10:00:00.000Z", "app-1", "44444444-4444-4444-8444-444444444444"));
    await requests.poll();
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-04T10:00:00.000Z");
    apps.push("peer-app");
    await requests.poll();
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-04T10:00:00.000Z");
  }, { apps });
});

test("the plugin's own send writes a request file for the agent", async () => {
  await harness(async ({ requests, files, file, prompts }) => {
    await requests.send({ id: "agent-1", issueId: "issue-1", identifier: "TUC-7" }, "Plan again for the cheap tier.");
    assert.deepEqual(await files(), ["agent-1"]);
    assert.match((await file("agent-1")).message, /cheap tier/);
    assert.deepEqual(prompts, ["agent-1: Plan again for the cheap tier."]);
  });
});

test("a comment for this plan is delivered with its reason, not the label's text", async () => {
  const request = { id: "op:1", at: "2026-10-03T10:00:00.000Z", kind: "comment" as const, authorId: "app-1" };
  assert.match(planRequestText("TUC-7", request), /another ticket's approved plan/i);
  assert.match(planRequestText("TUC-7"), /owner added the `plan` label/i);
});
test("AC-13: a second replan comment while the label stays set is a second request", async () => {
  await harness(async ({ requests, prompts, comments }) => {
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1"));
    await requests.poll();
    comments.push(comment("c-2", "2026-10-04T10:00:00.000Z", "app-1", "22222222-2222-4222-8222-222222222222"));
    await requests.poll();
    assert.equal(prompts.length, 2, "each request reaches the agent once");
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-04T10:00:00.000Z");
  });
});

test("AC-13: the owner removes and re-adds the plan label between polls, asking a second time", async () => {
  const first = { at: "2026-10-03T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] };
  await harness(async ({ requests, events, prompts }) => {
    events.push(first, { at: "2026-10-03T09:05:00.000Z", actorId: "owner-1", added: [], removed: ["label-plan"] });
    await requests.poll();
    assert.equal(prompts.length, 1);
    events.push({ at: "2026-10-04T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] });
    await requests.poll();
    assert.equal(prompts.length, 2, "the new label add is a request of its own");
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-04T09:00:00.000Z");
  });
});

test("AC-13: a restart re-reads the delivered state and asks for nothing again", async () => {
  await harness(async ({ requests, restart, prompts, comments, files }) => {
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1"));
    await requests.poll();
    assert.equal(prompts.length, 1);
    await restart();
    assert.equal(prompts.length, 1, "the state file carries the handled request across the restart");
    assert.deepEqual(await files(), ["agent-1"]);
  });
});

test("AC-13: the extension consuming the request file leaves the round's start alone, and a newer request moves it", async () => {
  await harness(async ({ requests, comments, events, files, directory }) => {
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1"));
    await requests.poll();
    await rm(join(directory, "agent-1"));
    await requests.poll();
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-03T10:00:00.000Z", "a consumed file is not a new round");
    assert.deepEqual(await files(), []);
    events.push({ at: "2026-10-04T10:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] });
    await requests.poll();
    assert.deepEqual(await files(), ["agent-1"], "the newer request writes its file again");
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-04T10:00:00.000Z");
  });
});

test("AC-13: a peer app's replan comment and label add is one request on this host, and an app comment needs no label to count", async () => {
  const peer = comment("c-1", "2026-10-03T10:00:00.000Z", "peer-app");
  const label = { at: "2026-10-03T10:00:01.000Z", actorId: "peer-app", added: ["label-plan"], removed: [] };
  await harness(async ({ requests, prompts, files }) => {
    await requests.poll();
    assert.deepEqual(prompts, [], "the peer's app is not in the trusted set yet");
    assert.deepEqual(await files(), []);
  }, { comments: [peer], events: [label] });
  await harness(async ({ requests, prompts }) => {
    await requests.poll();
    assert.equal(prompts.length, 1, "the peer's comment and its indicator are one request");
    assert.match(prompts[0], /asked for this plan to be revised/);
  }, { comments: [peer], events: [label], apps: ["app-1", "peer-app"] });
  // A comment posted while the ticket carries no `plan` label is still a request.
  await harness(async ({ requests, prompts }) => {
    await requests.poll();
    assert.equal(prompts.length, 1);
  }, { comments: [comment("c-1", "2026-10-03T10:00:00.000Z", "app-1")], labels: [] });
});

test("AC-13: the trusted app set keeps an unreachable listed peer, forgets one no longer listed, and writes it per origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-trusted-apps-"));
  let now = Date.parse("2026-10-03T10:00:00Z");
  let peers: { origin: string; reachable: boolean; appUserId: string | null }[] = [{ origin: "https://mac.ts.net:8444", reachable: true, appUserId: "peer-app" }];
  const apps = new TrustedApps({
    appUserId: async () => "app-1",
    peerApps: async () => peers,
    directory,
    now: () => now,
  });
  try {
    assert.deepEqual(await apps.ids(), ["app-1", "peer-app"]);
    // Past the cache, the peer no longer answers but stays listed: its last verified id is kept.
    now += 61_000;
    peers = [{ origin: "https://mac.ts.net:8444", reachable: false, appUserId: null }];
    assert.deepEqual(await apps.ids(), ["app-1", "peer-app"]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "trusted-apps.json"), "utf8")), { "https://mac.ts.net:8444": { appUserId: "peer-app", at: "2026-10-03T10:00:00.000Z" } });
    // Removed from `reviewPeers`: no longer asked, and its trust is gone.
    now += 61_000;
    peers = [{ origin: "https://other.ts.net:8444", reachable: true, appUserId: "other-app" }];
    assert.deepEqual(await apps.ids(), ["app-1", "other-app"]);
    now += 61_000;
    assert.deepEqual(JSON.parse(await readFile(join(directory, "trusted-apps.json"), "utf8")), { "https://other.ts.net:8444": { appUserId: "other-app", at: "2026-10-03T10:02:02.000Z" } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AC-13: planSetup plans again for an unhandled request, and a `plan` label add only when it is a request", async () => {
  const labels = (names: string[]) => names.map((name) => ({ id: `label-${name}`, name }));
  const qualified = `${PLAN}\n## Model\n\n- Tier: cheap — one column\n- Strong steps: none — routine\n`;
  const setup = (names: string[], requests: PlanRequest[]) => planSetup({
    issueCore: async () => ({ id: "issue-1", identifier: "TUC-7", creatorId: "owner-1", status: "Todo", statusType: "unstarted", labels: labels(names) }) as never,
    viewerId: async () => "owner-1",
    trustedAppIds: async () => ["app-1"],
    issueDocument: async () => ({ content: qualified, url: "https://linear.app/doc/plan" }),
  } as never, "issue-1", "omp", undefined, { requests: async () => requests });
  const comment: PlanRequest = { id: "comment:c-1", at: "2026-10-03T10:00:00.000Z", kind: "comment", authorId: "app-1", body: "Please add the migration step.", commentId: "c-1" };
  const revised = await setup(["plan-ready"], [comment]);
  assert.equal(revised.policy, "required", "the unhandled request sends the ticket back to planning");
  assert.match(revised.notes.join("\n"), /Please add the migration step\./);
  // The app's indicator label alone is not a request: the ticket still implements its plan.
  const indicator = await setup(["plan-ready", "plan"], []);
  assert.equal(indicator.policy, null);
  // The owner's label add is a request, recorded whatever the label says now.
  const owner = await setup(["plan-ready", "plan"], [{ id: "label:l-1", at: "2026-10-03T10:00:00.000Z", kind: "label", authorId: "owner-1" }]);
  assert.equal(owner.policy, "required");
  assert.match(owner.notes.join("\n"), /the owner added the `plan` label/);
});

test("AC-13 (regression): a plan approved at 10:00:50.000 is newer than a request written at 10:00:10.000, so the next launch implements", async () => {
  const labels = [{ id: "label-plan-ready", name: "plan-ready" }];
  const request: PlanRequest = { id: "comment:c-1", at: "2026-10-03T10:00:10.000Z", kind: "comment", authorId: "app-1", body: "Change it.", commentId: "c-1" };
  const plan = `> **Approved** in Plannotator on 2026-10-03 10:00:50.000 UTC for TUC-7.\n\n---\n\n${PLAN}\n## Model\n\n- Tier: cheap — one column\n- Strong steps: none — routine\n`;
  const seen: (string | null)[] = [];
  // The request fake filters on the cutoff as `PlanRequests.requests` does; the cutoff itself is
  // the launch's question.
  const setup = (content: string) => planSetup({
    issueCore: async () => ({ id: "issue-1", identifier: "TUC-7", creatorId: "owner-1", status: "Todo", statusType: "unstarted", labels }) as never,
    viewerId: async () => "owner-1",
    trustedAppIds: async () => ["app-1"],
    issueDocument: async () => ({ content, url: "https://linear.app/doc/plan" }),
  } as never, "issue-1", "omp", undefined, { requests: async (_issueId: string, _identifier: string, since: string | null) => { seen.push(since); return since && request.at > since ? [request] : []; } });

  const exact = await setup(plan);
  assert.deepEqual(seen, ["2026-10-03T10:00:50.000Z"], "the cutoff is the exact approval instant, not the start of its minute");
  assert.equal(exact.policy, null, "the request is older than the approval: the launch implements");
  assert.doesNotMatch(exact.notes.join("\n"), /Change it\./);

  // A legacy minute-only header is approved somewhere in its minute, so its earliest bound is the
  // cutoff and the request at :10 may be newer.
  seen.length = 0;
  const legacy = await setup(plan.replace("2026-10-03 10:00:50.000", "2026-10-03 10:00"));
  assert.deepEqual(seen, ["2026-10-03T10:00:00.000Z"]);
  assert.equal(legacy.policy, "required");
});

test("AC-13: an owner's label add counts after an app removed the label before the poll", async () => {
  await harness(async ({ requests, events, prompts }) => {
    events.push(
      { at: "2026-10-03T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] },
      // The approval's cleanup removes the label again before this poll reads the ticket.
      { at: "2026-10-03T09:05:00.000Z", actorId: "app-1", added: [], removed: ["label-plan"] },
    );
    await requests.poll();
    assert.equal(prompts.length, 1, "the add counts even though the ticket no longer carries the label");
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-03T09:00:00.000Z");
  });
});

test("AC-13: a request for a provider without the extension stays pending until a prompt is delivered", async () => {
  await harness(async ({ requests, comments, prompts, files, directory, delivery }) => {
    comments.push(comment("c-1", "2026-10-03T10:00:00.000Z", "app-1"));
    delivery.outcome = "busy";
    await requests.poll();
    assert.equal(prompts.length, 1, "the prompt was attempted");
    assert.deepEqual(await files(), [], "no request file is written for a provider that cannot read it");
    assert.equal(await requests.roundStartedAt("agent-1"), null, "an undelivered request starts no round");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8"))["agent-1"].handled, [], "it stays pending");
    delivery.outcome = "sent";
    await requests.poll();
    assert.equal(prompts.length, 2, "the next poll sends it again");
    assert.equal(await requests.roundStartedAt("agent-1"), "2026-10-03T10:00:00.000Z");
    await requests.poll();
    assert.equal(prompts.length, 2, "a delivered request is never sent twice");
  }, { provider: "claude-code" });
});

test("a poll reads every ticket's own history only when the ticket changed since the poll before", async (t) => {
  t.mock.method(console, "error", () => {});
  const directory = await mkdtemp(join(tmpdir(), "paseo-plan-requests-"));
  const calls: string[] = [];
  const updated: Record<string, string> = { "issue-1": CREATED_AT, "issue-2": CREATED_AT, "issue-3": CREATED_AT };
  const events: LabelEvent[] = [];
  // The budget pause refuses a read part way through a poll.
  const refused = new Set(["issue-3"]);
  const agent = (n: number) => ({ agent: { id: `agent-${n}`, createdAt: CREATED_AT, provider: "omp", labels: { "linear.issueId": `issue-${n}`, "linear.identifier": `TUC-${n}` } } });
  const paseo = { agents: { list: async () => ({ entries: [agent(1), agent(2), agent(3)], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
  const requests = new PlanRequests({
    linear: {
      planRequestStamps: async (ids: string[]) => { calls.push(`stamps ${ids.length}`); return new Map(ids.map((id) => [id, { updatedAt: updated[id], replanAt: null }])); },
      issueDocument: async (issueId: string) => { calls.push(`document ${issueId}`); return { content: PLAN }; },
      replanComments: async (issueId: string) => { calls.push(`comments ${issueId}`); return []; },
      existingLabelId: async () => "label-plan",
      labelHistory: async (issueId: string) => {
        calls.push(`history ${issueId}`);
        if (refused.has(issueId)) throw new Error("Background Linear work is paused");
        return issueId === "issue-2" ? events : [];
      },
      viewerId: async () => "owner-1",
    } as never,
    apps: { ids: async () => ["app-1"] },
    prompt: async () => "sent",
    directory,
  });
  requests.attach(paseo);
  try {
    await requests.poll();
    assert.deepEqual(calls.filter((call) => call.startsWith("history")).length, 3, "an agent seen the first time has its ticket read");
    calls.length = 0;
    refused.clear();
    await requests.poll();
    assert.deepEqual(calls, ["stamps 3", "comments issue-3", "history issue-3"], "after a refusal part way, the next poll reads only the tickets it did not finish");
    calls.length = 0;
    await requests.poll();
    assert.deepEqual(calls, ["stamps 3"], "nothing changed: one read for all tickets");
    calls.length = 0;
    events.push({ at: "2026-10-03T09:00:00.000Z", actorId: "owner-1", added: ["label-plan"], removed: [] });
    updated["issue-2"] = "2026-10-03T09:00:00.000Z";
    await requests.poll();
    assert.deepEqual(calls, ["stamps 3", "history issue-2"], "only the changed ticket's history is read");
    assert.equal(await requests.roundStartedAt("agent-2"), "2026-10-03T09:00:00.000Z");
    calls.length = 0;
    await requests.poll();
    assert.deepEqual(calls, ["stamps 3"], "a change already read is not read again");
  } finally {
    requests.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
