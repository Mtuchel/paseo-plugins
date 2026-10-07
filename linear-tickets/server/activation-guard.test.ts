import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { DEFAULT_AUTO_APPROVE } from "../shared/plan-risk";
import { resumeGuard } from "./activation-guard";
import { DEFAULT_ACTIVATION, DEFAULT_DEPUTY, DEFAULT_DISPATCH, DEFAULT_WRITEBACK, type ActivationSettings, type PluginSettings } from "./settings";

const PEER = "https://server087.tail5efd6b.ts.net:8444";

function settingsFor(activation: ActivationSettings = DEFAULT_ACTIVATION): PluginSettings {
  return {
    template: null, markInProgress: false, showClosed: false, lastProvider: null, launchPreferences: {}, projectMappings: {}, agentLinearAccess: false,
    dispatch: DEFAULT_DISPATCH, writeback: DEFAULT_WRITEBACK, autoApprove: DEFAULT_AUTO_APPROVE, cheapModels: {}, standardModels: {}, reviewPeers: [], activation, deputy: DEFAULT_DEPUTY,
  };
}

const paseo = {} as PaseoApi;

function open(change: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest {
  return { agentId: "agent-retired", workspaceId: null, provider: "omp", cwd: "/repo/wt", reason: "resume", purpose: "interactive", env: {}, ...change };
}

// The guard's world: the allowlist entry the drain knows, whether the agent still holds its
// ticket, and the plugin's own session records.
function guardFor(options: { activation?: ActivationSettings; ticket?: { identifier: string } | null; known?: { identifier: string } | null; held?: boolean } = {}) {
  const calls: string[] = [];
  const guard = resumeGuard({
    settings: { read: async () => settingsFor(options.activation ?? { mode: "remote", peer: PEER }) },
    drain: {
      agentTicket: async () => { calls.push("agentTicket"); return options.ticket === undefined ? { identifier: "TUC-1" } : options.ticket; },
      holdsAgent: async () => { calls.push("holdsAgent"); return options.held === true; },
    },
    ...(options.known === undefined ? {} : { known: async () => { calls.push("known"); return options.known!; } }),
    attach: () => { calls.push("attach"); },
    log: () => {},
  });
  return { guard, calls };
}

test("refuses an interactive resume of a retired ticket root, naming what happens instead", async () => {
  const { guard, calls } = guardFor({ held: false });
  await assert.rejects(guard({ request: open() }, { paseo }), /TUC-1.*routed to/);
  assert.deepEqual(calls, ["attach", "agentTicket", "holdsAgent"], "the hook's connection is attached before the question is decided");
});

test("lets a grandfathered root resume and keeps its ticket", async () => {
  const { guard } = guardFor({ held: true });
  await guard({ request: open() }, { paseo });
});

test("leaves agents that are no ticket root at all alone: fresh Desktop chats are not blocked", async () => {
  const { guard, calls } = guardFor({ ticket: null, known: null });
  await guard({ request: open({ agentId: "chat-1", cwd: "/Users/mirko" }) }, { paseo });
  assert.equal(calls.includes("holdsAgent"), false, "no ownership question is asked for an unrelated agent");
});

test("refuses a retired root the plugin knows from its own records, even without an allowlist entry", async () => {
  const { guard } = guardFor({ ticket: null, known: { identifier: "TUC-9" }, held: false });
  await assert.rejects(guard({ request: open() }, { paseo }), /TUC-9/);
});

test("refuses with its own words when the ownership read fails, never waking on an unreadable state", async () => {
  let calls = 0;
  const guard = resumeGuard({
    settings: { read: async () => settingsFor({ mode: "remote", peer: PEER }) },
    drain: { agentTicket: async () => ({ identifier: "TUC-1" }), holdsAgent: async () => { calls += 1; throw new Error("the daemon is unreachable"); } },
    log: () => {},
  });
  await assert.rejects(guard({ request: open() }, { paseo }), /left it closed/);
  assert.equal(calls, 1);
});

test("is inert while this host does not drain, or has no peer to answer", async () => {
  const local = guardFor({ activation: { mode: "local", peer: PEER }, held: false, ticket: { identifier: "TUC-1" } });
  await local.guard({ request: open() }, { paseo });
  assert.deepEqual(local.calls, [], "nothing is read while this host starts its own work");
  const peerless = guardFor({ activation: { mode: "remote", peer: null }, held: false });
  await peerless.guard({ request: open() }, { paseo });
  assert.deepEqual(peerless.calls, []);
});

test("guards only interactive resumes: a create, a refresh, an import or a history read passes", async () => {
  for (const request of [
    open({ reason: "create", purpose: "interactive" }),
    open({ reason: "refresh", purpose: "interactive" }),
    open({ reason: "import", purpose: "interactive" }),
    open({ reason: "resume", purpose: "history" }),
  ]) {
    const { guard, calls } = guardFor({ held: false });
    await guard({ request }, { paseo });
    assert.deepEqual(calls, [], `${request.reason}/${request.purpose} is not guarded`);
  }
});
