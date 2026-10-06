import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ghOperation, findBinary } from "./github-router.mjs";
import { resourceFor, runNativeApi } from "./github-api.mjs";

async function fixture(args, fetchPage, choose) {
  const home = mkdtempSync(join(tmpdir(), "github-api-"));
  const previous = globalThis.fetch;
  globalThis.fetch = fetchPage;
  try {
    const config = join(home, "gh");
    mkdirSync(config);
    writeFileSync(join(config, "hosts.yml"), "github.com:\n  user: fixture\n  oauth_token: fixture-token\n");
    const realGh = findBinary("gh");
    return await runNativeApi({ real: realGh, args, env: process.env, stdio: ["ignore", "pipe", "pipe"] }, {
      realGh, firstAccount: "bot", operation: ghOperation(args), choose,
      environment: () => ({ ...process.env, GH_CONFIG_DIR: config, GH_TOKEN: "", GITHUB_TOKEN: "" }),
      observe: async () => {}, record: () => {},
    });
  } finally { globalThis.fetch = previous; rmSync(home, { recursive: true, force: true }); }
}

test("native REST pagination and slurp produce the complete consumer result", async () => {
  const result = await fixture(["api", "fixtures/pages?page=1", "--paginate", "--slurp"], async (url) => {
    const second = new URL(url).searchParams.get("page") === "2";
    return new Response(JSON.stringify({ items: [{ weight: second ? 7 : 11 }] }), { headers: {
      "content-type": "application/json", ...(!second ? { link: '<https://api.github.com/fixtures/pages?page=2>; rel="next"' } : {}),
    } });
  }, async () => "owner");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).flatMap((page) => page.items).reduce((sum, item) => sum + item.weight, 0), 18);
});

test("pagination refuses the next page before it spends reserved capacity", async () => {
  let fetchedSecond = false;
  await assert.rejects(fixture(["api", "fixtures/pages?page=1", "--paginate", "--slurp"], async (url) => {
    if (new URL(url).searchParams.get("page") === "2") fetchedSecond = true;
    return new Response(JSON.stringify({ items: [{ weight: 11 }] }), { headers: { "content-type": "application/json", link: '<https://api.github.com/fixtures/pages?page=2>; rel="next"' } });
  }, async () => { throw new Error("GitHub read budgets exhausted; reserved capacity cannot be spent"); }), /GitHub read budgets exhausted/);
  assert.equal(fetchedSecond, false);
});

test("GraphQL pagination carries endCursor and keeps native jq semantics", async () => {
  const query = "query($endCursor:String) { repository { items(after:$endCursor) { nodes { weight } pageInfo { hasNextPage endCursor } } } }";
  const result = await fixture(["api", "graphql", "--paginate", "-f", `query=${query}`, "--jq", ".data.repository.items.nodes[].weight"], async (_url, init) => {
    const variables = JSON.parse(init.body).variables;
    const second = variables.endCursor === "page-two";
    return new Response(JSON.stringify({ data: { repository: { items: {
      nodes: [{ weight: second ? 7 : 11 }], pageInfo: { hasNextPage: !second, endCursor: second ? null : "page-two" },
    } } } }), { headers: { "content-type": "application/json" } });
  }, async () => "owner");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\s+/).reduce((sum, weight) => sum + Number(weight), 0), 18);
});

test("search and code-search requests never consume the core or each other's allowance", () => {
  assert.equal(resourceFor("search/issues?q=test"), "search");
  assert.equal(resourceFor("https://api.github.com/search/code?q=test"), "code_search");
  assert.equal(ghOperation(["search", "code", "test"]).resource, "code_search");
  assert.equal(ghOperation(["api", "search/repositories?q=test"]).resource, "search");
});
