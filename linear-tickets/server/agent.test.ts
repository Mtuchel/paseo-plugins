import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { AgentApi, AppAuth } from "./agent-app";
import { verifyWebhook } from "./agent-webhook";
import { Handover, handoverPrompt, progressBody, type HandoverRecord } from "./handover";
import { planSteps, SessionRouter, SessionStore, type SessionLink } from "./sessions";
import { DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type PluginSettings } from "./settings";

const OWNER = "owner-1";
const settings: PluginSettings = {
  template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
  dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK,
};

test("only fresh, correctly signed webhooks are accepted", () => {
  const secret = "lin_wh_test";
  const body = Buffer.from(JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: 1_000_000 }));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.ok(verifyWebhook(body, signature, secret, 1_000_500));
  assert.equal(verifyWebhook(body, signature, "other-secret", 1_000_500), null);
  assert.equal(verifyWebhook(body, undefined, secret, 1_000_500), null);
  assert.equal(verifyWebhook(body, signature.slice(2), secret, 1_000_500), null);
  assert.equal(verifyWebhook(body, signature, secret, 1_000_000 + 61_000), null, "older than 60 s");
});

test("the app token is refreshed before it expires and once more after a 401", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-agent-auth-"));
  try {
    await writeFile(join(directory, "app.json"), JSON.stringify({ clientId: "c", clientSecret: "s", webhookSecret: "w" }));
    await writeFile(join(directory, "token.json"), JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: 1_000 }));
    const refreshes: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      refreshes.push(String(init.body));
      return new Response(JSON.stringify({ access_token: `new-${refreshes.length}`, expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const auth = new AppAuth(directory, fakeFetch, () => 900_000);
    assert.equal(await auth.accessToken(), "new-1", "expired token refreshed");
    assert.match(refreshes[0], /grant_type=refresh_token&refresh_token=r1/);
    const saved = JSON.parse(await readFile(join(directory, "token.json"), "utf8"));
    assert.equal(saved.refresh_token, "r1", "refresh token kept when Linear does not rotate it");

    const posted: string[] = [];
    const api = new AgentApi(auth, async (key) => {
      posted.push(key);
      if (key === "Bearer new-1") throw new Error("Linear rejected this API key. Check it in Linear settings and reconnect.");
      return { agentActivityCreate: { success: true } };
    });
    await api.activity("session-1", { type: "thought", body: "hi" });
    assert.deepEqual(posted, ["Bearer new-1", "Bearer new-2"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plan checklists come from checkboxes, or numbered steps under a Steps heading", () => {
  assert.deepEqual(planSteps("# Plan\n- [ ] AC-1 domain\n- [x] AC-2 migration\ntext"), ["AC-1 domain", "AC-2 migration"]);
  assert.deepEqual(planSteps("## Context\n1. not a step\n## Steps\n1. First\n2. Second\n## Verification\n1. no"), ["First", "Second"]);
  assert.deepEqual(planSteps("no structure here"), []);
});

type Call = string;
function harness(options: { pending?: AgentPermissionRequest[]; activeAgent?: { id: string; title: string } | null } = {}) {
  const calls: Call[] = [];
  const api = {
    activity: async (sessionId: string, content: { type: string; body?: string }, extra: { options?: { value: string }[] } = {}) => { calls.push(`${content.type}:${content.body ?? ""}${extra.options ? ` [${extra.options.map((o) => o.value).join("|")}]` : ""}`); },
    updateSession: async () => {},
    createSessionOnIssue: async () => "s-new",
    openSessions: async () => [],
    activities: async () => [],
  };
  const paseo = {
    agents: {
      list: async () => ({ entries: options.activeAgent ? [{ agent: { ...options.activeAgent, labels: {} } }] : [] }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: { pendingPermissions: options.pending ?? [] } }),
        send: async (text: string) => { calls.push(`send ${id}: ${text}`); },
        respondToPermission: async ({ requestId, response }: { requestId: string; response: unknown }) => { calls.push(`respond ${requestId} ${JSON.stringify(response)}`); },
        archive: async () => { calls.push(`archive ${id}`); return { archivedAt: "now" }; },
      }),
    },
  } as unknown as PaseoApi;
  const directory = join(tmpdir(), `paseo-sessions-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const store = new SessionStore(join(directory, "sessions.json"));
  const router = new SessionRouter({
    api: api as never,
    linear: { viewerId: async () => OWNER, addLabel: async (_id: string, name: string) => { calls.push(`+${name}`); }, removeLabel: async (_id: string, name: string) => { calls.push(`-${name}`); } },
    starter: { start: async (_issue: string, _paseo: PaseoApi, _settings: PluginSettings, launch: { labels?: Record<string, string> }) => { calls.push(`start ${JSON.stringify(launch.labels)}`); return { agentId: "agent-new", warnings: [], provider: "omp/x", target: "repo", resumed: false, untrusted: false }; }, admission: async () => ({ ok: true as const }) },
    settings: { read: async () => settings },
    store,
    stop: async (agentId) => { calls.push(`stop ${agentId}`); },
    decideReview: async (url, approve, feedback) => { calls.push(`review ${url} ${approve ? "approve" : `deny:${feedback}`}`); },
  });
  router.attach(paseo);
  router.stop();
  return { router, store, calls, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const link = (change: Partial<SessionLink> = {}): SessionLink => ({ sessionId: "s1", agentId: "agent-1", issueId: "i1", identifier: "TUC-1", createdAt: "2026-01-01T00:00:00Z", handled: [], review: null, offer: null, ...change });

test("a delegation from someone else is refused; the owner's starts an agent linked to the session", async () => {
  const other = harness();
  await other.router.created({ id: "s1", creatorId: "someone-else", issueId: "i1", issue: { identifier: "TUC-1" } });
  assert.deepEqual(other.calls, ["error:Only the workspace owner can start Paseo agents."]);
  await other.cleanup();

  const mine = harness();
  await mine.router.created({ id: "s1", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" } });
  assert.deepEqual(mine.calls.slice(0, 2), ["+paseo-running", 'start {"linear.sessionId":"s1"}']);
  assert.equal((await mine.store.get("s1"))?.agentId, "agent-new");
  await mine.cleanup();
});

test("a mention on a ticket with a running agent is passed to that agent instead of starting another", async () => {
  const h = harness({ activeAgent: { id: "agent-1", title: "TUC-1: Fix" } });
  await h.router.created({ id: "s2", creatorId: OWNER, issueId: "i1", issue: { identifier: "TUC-1" }, comment: { body: "@paseo also cover returns" } });
  assert.equal(h.calls[0], "send agent-1: also cover returns");
  assert.equal((await h.store.get("s2"))?.agentId, "agent-1");
  await h.cleanup();
});

test("replies route to stop, question, approval, plan review or message, and each is handled once", async () => {
  const question: AgentPermissionRequest = { id: "q", provider: "omp", name: "ask", kind: "question", input: { questions: [{ question: "Transfer?", header: "Response", options: [{ label: "SFTP" }, { label: "Mail" }] }] } };
  const tool: AgentPermissionRequest = { id: "t", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash" };
  const cases: { pending?: AgentPermissionRequest[]; change?: Partial<SessionLink>; activity: Record<string, unknown>; expect: string }[] = [
    { activity: { id: "a1", signal: "stop", content: { body: "stop" } }, expect: "stop agent-1" },
    { pending: [question], activity: { id: "a2", content: { body: "SFTP" } }, expect: 'respond q {"behavior":"allow","updatedInput":{"answers":{"Response":"SFTP"}}}' },
    { pending: [tool], activity: { id: "a3", content: { body: "deny" } }, expect: 'respond t {"behavior":"deny"}' },
    { change: { review: { localUrl: "http://localhost:5000/" } }, activity: { id: "a4", content: { body: "approve-plan" } }, expect: "review http://localhost:5000/ approve" },
    { change: { review: { localUrl: "http://localhost:5000/" } }, activity: { id: "a5", content: { body: "Split step 2" } }, expect: "review http://localhost:5000/ deny:Split step 2" },
    { activity: { id: "a6", content: { body: "Also update the README" } }, expect: "send agent-1: Also update the README" },
  ];
  for (const item of cases) {
    const h = harness({ pending: item.pending });
    await h.store.put(link(item.change));
    await h.router.prompted("s1", item.activity);
    await h.router.prompted("s1", item.activity);
    assert.equal(h.calls.filter((call) => call === item.expect).length, 1, `${item.expect} once`);
    await h.cleanup();
  }
});

test("a stopped agent's Resume choice starts its successor and closes the old agent", async () => {
  const h = harness();
  await h.store.put(link({ offer: "resume" }));
  await h.router.prompted("s1", { id: "a1", content: { body: "resume" } });
  assert.ok(h.calls.includes('start {"linear.sessionId":"s1"}'));
  assert.ok(h.calls.includes("archive agent-1"));
  assert.equal((await h.store.get("s1"))?.agentId, "agent-new");
  await h.cleanup();
});

test("a plan approved for later offers no Resume when the planner is archived, and any reply starts the implementer", async () => {
  const h = harness();
  await h.store.put(link({ offer: "later" }));
  await h.router.offerResume("s1");
  assert.ok(!h.calls.some((call) => call.includes("[resume|leave]")));
  await h.router.prompted("s1", { id: "a1", content: { body: "go ahead" } });
  assert.ok(h.calls.includes('start {"linear.sessionId":"s1"}'));
  assert.equal((await h.store.get("s1"))?.offer, null);
  await h.cleanup();
});

test("the progress comment is created once and edited in place; the next agent gets its own and a resume prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-handover-"));
  const calls: string[] = [];
  const links: string[] = [];
  try {
    const handover = new Handover({
      createComment: async (_issue: string, body: string) => { calls.push(`create ${body.split("\n")[0]}`); return `c${calls.length}`; },
      updateComment: async (id: string, body: string) => { calls.push(`update ${id} ${body.split("\n")[0]}`); },
      comment: async (_issue: string, body: string) => { calls.push(`final ${body.split("\n")[0]}`); },
      upsertAttachment: async (_issue: string, url: string, title: string, subtitle: string) => { links.push(`${url} | ${title} | ${subtitle}`); },
      removeAttachments: async (_issue: string, prefix: string, keep: string) => { links.push(`remove ${prefix}* except ${keep}`); },
    }, directory, async () => ({ branch: "mtuchel/tuc-1-fix", lastCommit: "abc123 wip" }), () => "2026-01-01T10:00:00Z", async (agentId) => `https://app.paseo.sh/h/srv/agent/${agentId}`);
    const issue = { id: "i1", identifier: "TUC-1" };
    const first = { id: "agent-1", title: "TUC-1: Fix", cwd: "/wt/tuc-1" };
    await handover.update(issue, first, { summary: "Did step 1" });
    await handover.update(issue, first, { summary: "Did step 2", model: "omp/opus · thinking medium" });
    const record: HandoverRecord = await handover.finish(issue, first, "failed", "provider login expired");
    assert.deepEqual(calls, ["create 🛠 **Paseo progress** — TUC-1: Fix", "update c1 🛠 **Paseo progress** — TUC-1: Fix", "update c1 🛠 **Paseo progress** — TUC-1: Fix", "final 🏁 **Paseo final report** — TUC-1: Fix"]);
    assert.deepEqual(record.summaries, ["Did step 1", "Did step 2"]);
    const target = await handover.resumeTarget("i1");
    assert.equal(target?.branch, "mtuchel/tuc-1-fix");
    assert.equal(target?.worktreePath, "/wt/tuc-1");
    assert.match(handoverPrompt(record), /continuing work on Linear ticket TUC-1 .*Stopped with an error/s);
    assert.match(target?.handover ?? "", /report 2 ---\nDid step 2/);
    await handover.update(issue, { id: "agent-2", title: "TUC-1: Fix (resumed)", cwd: "/wt/tuc-1" }, { summary: "Continued" });
    assert.equal(calls.at(-1), "create 🛠 **Paseo progress** — TUC-1: Fix (resumed)");
    assert.equal((await handover.read("i1"))?.resumedFrom, "agent-1");
    // The ticket's agent link: one attachment, its subtitle following the phase and model, moved to the next agent.
    assert.deepEqual(links, [
      "https://app.paseo.sh/h/srv/agent/agent-1 | Paseo agent · TUC-1: Fix | Working",
      "remove https://app.paseo.sh/h/* except https://app.paseo.sh/h/srv/agent/agent-1",
      "https://app.paseo.sh/h/srv/agent/agent-1 | Paseo agent · TUC-1: Fix | Working · omp/opus · thinking medium",
      "https://app.paseo.sh/h/srv/agent/agent-1 | Paseo agent · TUC-1: Fix | Stopped with an error · omp/opus · thinking medium",
      "https://app.paseo.sh/h/srv/agent/agent-2 | Paseo agent · TUC-1: Fix (resumed) | Working",
      "remove https://app.paseo.sh/h/* except https://app.paseo.sh/h/srv/agent/agent-2",
    ]);
    assert.match(progressBody((await handover.read("i1"))!), /\*\*Links:\*\* \[Open in Paseo\]\(https:\/\/app\.paseo\.sh\/h\/srv\/agent\/agent-2\)/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a permission shows in the agent panel only while still pending, and the ticket then mentions the session's owner as the Paseo app", async () => {
  const { Writeback } = await import("./writeback");
  const request: AgentPermissionRequest = { id: "p1", provider: "omp", name: "bash", kind: "tool", title: "Allow tool: bash", description: "Command: ls" };
  for (const pending of [[], [request]]) {
    const calls: string[] = [];
    const linear = {
      issueState: async () => ({ id: "i1", identifier: "TUC-1", status: "In Progress", statusId: "ip", statusType: "started", teamId: "t", projectId: null, creatorId: "customer", labels: [], attachmentUrls: [], blockedBy: [] }),
      markInProgress: async () => ({ changed: false }), moveToReview: async () => ({ changed: false }), linkUrl: async () => {}, moveToState: async () => {},
      moveToStateNamed: async (_i: string, name: string) => { calls.push(`move ${name}`); return { changed: true }; },
      comment: async (_i: string, body: string) => { calls.push(`comment ${body.slice(0, 30)}`); },
      createComment: async (): Promise<string> => { throw new Error("the app writes this comment"); }, updateComment: async () => {},
      viewerId: async () => OWNER, userUrl: async (id: string) => `https://linear.app/ws/profiles/${id}`,
      addLabel: async (_i: string, name: string) => { calls.push(`+${name}`); }, removeLabel: async () => {},
    };
    const sessions = {
      sessionFor: async () => ({ sessionId: "s1" }), say: async () => {}, action: async () => {}, link: async () => {}, offerResume: async () => {}, resumeNow: async () => false,
      ask: async (_s: string, body: string, options: { value: string }[]) => { calls.push(`ask ${body.split("\n")[0]} [${options.map((o) => o.value).join("|")}]`); },
    };
    const comments = { createComment: async (_i: string, body: string) => { calls.push(`app comment ${body.split("\n")[0]}`); return "c1"; }, updateComment: async () => {} };
    const handover = { update: async () => ({}) as never, finish: async () => ({}) as never, waiting: async () => null, setWaiting: async () => {} };
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "linear.issueId": "i1", "linear.identifier": "TUC-1" }, pendingPermissions: pending } }) }) } } as unknown as PaseoApi;
    const writeback = new Writeback(linear, { read: async () => ({ ...settings, writeback: { ...DEFAULT_WRITEBACK, blocked: true } }) }, { sessions: sessions as never, handover, comments }, 0);
    await writeback.permissionRequested({ agent: { id: "a1", workspaceId: "w", parentAgentId: null, provider: "omp", cwd: "/x", title: "T" }, request }, paseo);
    assert.deepEqual(calls, pending.length ? ["ask Approve this action? [approve|deny]", "move Needs input", "+paseo-needs-you", `app comment https://linear.app/ws/profiles/${OWNER} **T** (Paseo) is waiting for permission: Allow tool: bash`] : []);
  }
});
