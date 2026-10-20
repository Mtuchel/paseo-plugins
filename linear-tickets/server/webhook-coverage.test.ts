import assert from "node:assert/strict";
import test from "node:test";
import { WebhookCoverage } from "./webhook-coverage";

const url = "https://example.test:8443/linear/agent";
type Subscription = { enabled: boolean; url: string; secret: string; resourceTypes: string[]; allPublicTeams: boolean; teamIds: string[] | null; team: { id: string } | null };
const hook: Subscription = { enabled: true, url, secret: "secret", resourceTypes: ["Issue", "Comment"], allPublicTeams: true, teamIds: null, team: null };
const teams = [{ id: "public", private: false }, { id: "private", private: true }];

test("coverage requires matching signatures, enabled resource scope, all affected teams, and fresh healthy transport", async () => {
  let clock = 0;
  let hooks = [hook];
  let failed = false;
  const coverage = new WebhookCoverage({ read: async () => ({ key: "key", source: "environment" }) }, async (_key, query) => {
    if (failed) throw new Error("network down");
    return query.includes("reconciliationWebhooks")
      ? { webhooks: { nodes: hooks, pageInfo: { hasNextPage: false, endCursor: null } } }
      : { teams: { nodes: teams, pageInfo: { hasNextPage: false, endCursor: null } } };
  }, () => clock);
  coverage.setTransport(true);
  await coverage.refresh(url, "secret");
  assert.equal(coverage.covers("Issue", "public"), true);
  assert.equal(coverage.covers("Issue", "private"), false);
  assert.equal(coverage.covers("Issue"), false, "a public-team subscription cannot slow private-team polls");
  assert.equal(coverage.covers("Issue", "unknown"), false);
  assert.equal(coverage.covers("IssueLabel", "public"), false);
  hooks = [{ ...hook, allPublicTeams: false, teamIds: ["private"], team: null }, hook];
  await coverage.refresh(url, "secret");
  assert.equal(coverage.covers("Issue"), true);
  hooks = [{ ...hook, secret: "different" }];
  await coverage.refresh(url, "secret");
  assert.equal(coverage.covers("Issue", "public"), false, "the receiver cannot authenticate a different signing secret");
  hooks = [hook];
  await coverage.refresh(url, "secret");
  coverage.noteAgentSession();
  assert.equal(coverage.coversAgentSessions(), true);
  coverage.setTransport(false);
  assert.equal(coverage.coversAgentSessions(), false);
  assert.equal(coverage.covers("Issue", "public"), false);
  coverage.setTransport(true);
  clock = 10 * 60_000;
  assert.equal(coverage.coversAgentSessions(), false, "stale transport health is not coverage");
  assert.equal(coverage.covers("Issue", "public"), false);
  coverage.setTransport(true);
  failed = true;
  await assert.rejects(coverage.refresh(url, "secret"), /network down/);
  assert.equal(coverage.covers("Issue", "public"), false, "a failed subscription read restores fast fallback");
});

test("private-team subscriptions and teams on later pages participate in coverage", async () => {
  const coverage = new WebhookCoverage({ read: async () => ({ key: "key", source: "environment" }) }, async (_key, query, variables) => {
    const second = variables.after === "next";
    const pageInfo = { hasNextPage: !second, endCursor: second ? null : "next" };
    return query.includes("reconciliationWebhooks")
      ? { webhooks: { nodes: second ? [{ ...hook, allPublicTeams: false, team: { id: "private" } }] : [hook], pageInfo } }
      : { teams: { nodes: second ? [teams[1]] : [teams[0]], pageInfo } };
  });
  coverage.setTransport(true);
  assert.equal(coverage.coversAgentSessions(), false, "an installed app alone does not prove delivery");
  await coverage.refresh(url, "secret");
  assert.equal(coverage.covers("Comment"), true);
});
