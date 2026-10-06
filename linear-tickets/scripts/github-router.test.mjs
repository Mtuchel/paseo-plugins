import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ghOperation, pickRead, route } from "./github-router.mjs";

// Misclassification can publish activity as the human account: only explicit reads balance.
test("mutations, opaque documents and unknown commands never enter the read pool", () => {
  const writes = [
    ["pr", "create", "--title", "query status"],
    ["pr", "ready", "42"], ["pr", "merge", "42"], ["pr", "review", "42", "--approve"],
    ["api", "-X", "POST", "repos/o/r/issues/42/comments", "-f", "body=hello"],
    ["api", "graphql", "-f", "query=mutation { addComment(input: {}) { clientMutationId } }"],
    ["api", "graphql", "--input", "document.json"],
    ["api", "graphql", "-f", "query=@document.graphql"],
    ["api", "graphql", "-F", "query=unknown"],
    ["api", "repos/o/r/issues", "-f", "title=hello"],
    ["api", "repos/o/r/issues", "--method=PATCH"],
    ["extension", "exec", "anything"], ["custom-alias"],
    ["auth", "token"],
  ];
  for (const args of writes) assert.equal(ghOperation(args).read, false, args.join(" "));
});

test("included headers, repo flags and GraphQL variables do not turn reads into writes", () => {
  const reads = [
    ["api", "-i", "repos/o/r/issues/42"],
    ["-R", "o/r", "pr", "view", "42", "--json", "state"],
    ["api", "-H", "If-None-Match: abc", "repos/o/r/issues/42"],
    ["api", "graphql", "-f", "query=query($id: ID!) { node(id: $id) { id } }", "-f", "id=42"],
    ["api", "graphql", "--raw-field=query={ viewer { login } }"],
    ["api", "repos/o/r/issues", "--method", "GET", "-f", "state=open"],
  ];
  for (const args of reads) assert.equal(ghOperation(args).read, true, args.join(" "));
  assert.equal(ghOperation(["api", "-i", "repos/o/r/issues/42"]).resource, "core");
});

test("read selection uses available capacity after the write reserve", () => {
  const now = 1_000;
  const state = { bot: { remaining: 1_000, resetAt: 9_000 }, owner: { remaining: 900, resetAt: 9_000 } };
  assert.equal(pickRead(state, "core", now), "owner");
  state.owner.remaining = 300;
  assert.equal(pickRead(state, "core", now), "bot");
  state.bot.remaining = 750;
  assert.equal(pickRead(state, "core", now), null);
  state.owner.remaining = 301;
  assert.equal(pickRead(state, "core", now), "owner");
  state.owner.remaining--;
  assert.equal(pickRead(state, "core", now), null);
});

test("expired and unavailable pools cannot authorize a read", () => {
  assert.equal(pickRead({ bot: { remaining: 5_000, resetAt: 999 }, owner: { remaining: 0, resetAt: 9_000 } }, "graphql", 1_000), null);
  assert.equal(pickRead({ owner: { remaining: 2_000, resetAt: 9_000 } }, "graphql", 1_000), "owner");
});

test("read reservations are serialized across concurrent callers at the boundary", async () => {
  const home = mkdtempSync(join(tmpdir(), "github-routing-"));
  try {
    mkdirSync(join(home, "gh-bot")); writeFileSync(join(home, "gh-bot", "hosts.yml"), "github.com:\n  user: bot112112121\n  oauth_token: fixture\n");
    mkdirSync(join(home, "github-router"));
    const now = Date.now();
    writeFileSync(join(home, "github-router", "budgets.json"), JSON.stringify({ botTokenDigest: createHash("sha256").update("fixture").digest("hex"), core: {
      bot: { remaining: 750, resetAt: now + 600_000, at: now, identity: "bot112112121" },
      owner: { remaining: 301, resetAt: now + 600_000, at: now },
    } }));
    const env = { ...process.env, PASEO_HOME: home, PASEO_AGENT_ID: "boundary-agent" };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => route("gh", ["api", "repos/o/r/issues/42"], env)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results.filter((r) => r.status === "rejected")) assert.match(r.reason.message, /GitHub read budgets exhausted/);
    // Writes remain admitted when both read pools are at their reserves.
    const write = await route("gh", ["api", "-X", "POST", "repos/o/r/issues/42/comments", "-f", "body=hi"], env);
    assert.equal(write.env.GH_CONFIG_DIR, join(home, "gh-bot"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("missing bot credentials block automated writes instead of falling back", async () => {
  const home = mkdtempSync(join(tmpdir(), "github-no-bot-"));
  try {
    await assert.rejects(route("gh", ["pr", "create"], { ...process.env, PASEO_HOME: home, PASEO_AGENT_ID: "a", GH_TOKEN: "owner-token" }), /bot credentials missing/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
