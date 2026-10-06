import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ghOperation, findBinary } from "./github-router.mjs";
import { apiReader, resourceFor, runNativeApi, watchRun } from "./github-api.mjs";

async function withApiFixture(fetchPage, run, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "github-api-"));
  const previousFetch = globalThis.fetch;
  const previousCwd = process.cwd();
  let failure;
  const server = createServer(async (request, outgoing) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const response = await fetchPage(new URL(request.url, "https://api.github.com"), {
        method: request.method, headers: request.headers, ...(body ? { body } : {}),
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      failure = error;
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  try {
    const config = join(home, "gh");
    mkdirSync(config);
    writeFileSync(join(config, "hosts.yml"), "github.com:\n  user: fixture\n  oauth_token: fixture-token\n");
    const realGh = findBinary("gh"), realGit = findBinary("git");
    const env = { ...process.env, GH_CONFIG_DIR: config, GH_REPO: "", GH_TOKEN: "", GITHUB_TOKEN: "" };
    if (options.setup) process.chdir(await options.setup(home, realGit));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    globalThis.fetch = (url, init) => {
      const remote = new URL(url);
      assert.equal(remote.origin, "https://api.github.com");
      return previousFetch(new URL(remote.pathname + remote.search, `http://127.0.0.1:${server.address().port}`), init);
    };
    const result = await run({
      realGh, realGit, env, home, cacheMs: 0, firstAccount: "bot",
      choose: async () => "owner", environment: () => env,
      observe: async () => {}, record: () => {}, ...options.deps,
    });
    if (failure) throw failure;
    return result;
  } finally {
    globalThis.fetch = previousFetch;
    process.chdir(previousCwd);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

async function fixture(args, fetchPage, choose, options = {}) {
  return withApiFixture(fetchPage, (deps) => runNativeApi({
    real: deps.realGh, args, env: deps.env, stdio: ["ignore", "pipe", "pipe"],
  }, { ...deps, operation: ghOperation(args), ...(choose ? { choose } : {}) }), options);
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

test("preview and formatting values preceding an equal endpoint remain native flags", async () => {
  const result = await fixture(["api", "--jq", ".id", "--preview", "ant-man", ".id"], async (url) => {
    assert.equal(url.pathname, "/.id");
    return new Response('{"id":742}', { headers: { "content-type": "application/json" } });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "742");
});

test("included REST headers keep public next links usable after the native transport closes", async () => {
  const link = '<https://api.github.com/fixtures/pages?page=2>; rel="next", <https://api.github.com/fixtures/pages?page=3>; rel="last"';
  const result = await fixture(["api", "fixtures/pages?page=1", "-i"], async (url) => {
    const page = new URL(url).searchParams.get("page");
    return new Response(JSON.stringify({ items: [{ weight: page === "2" ? 7 : 11 }] }), {
      headers: { "content-type": "application/json", ...(page === "1" ? { link } : {}) },
    });
  });
  assert.equal(result.code, 0, result.stderr);
  const next = result.stdout.match(/^link:\s*<([^>]+)>;\s*rel="next"/im)?.[1];
  assert.equal(next, "https://api.github.com/fixtures/pages?page=2");
  const includedLink = result.stdout.match(/^link:\s*(.+)$/im)?.[1].trim();
  assert.equal(includedLink, link);
  const second = await fixture(["api", next, "--jq", ".items[].weight"], async (url) => {
    assert.equal(new URL(url).searchParams.get("page"), "2");
    return new Response('{"items":[{"weight":7}]}', { headers: { "content-type": "application/json" } });
  });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.trim(), "7");
});

test("explicit native pagination flags preserve pagination and non-pagination behavior", async () => {
  for (const [flag, expected] of [["--paginate=true", [11, 7]], ["--paginate=false", [11]]]) {
    const result = await fixture(["api", "fixtures/pages?page=1", flag, "--jq", ".items[].weight"], async (url) => {
      const second = new URL(url).searchParams.get("page") === "2";
      return new Response(JSON.stringify({ items: [{ weight: second ? 7 : 11 }] }), { headers: {
        "content-type": "application/json", ...(!second ? { link: '<https://api.github.com/fixtures/pages?page=2>; rel="next"' } : {}),
      } });
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\s+/).map(Number), expected);
  }
});

test("native endpoint placeholders resolve the owner, repository and branch from Git", async () => {
  const result = await fixture(["api", "repos/{owner}/{repo}/branches/{branch}", "--jq", ".commit.sha"], async (url) => {
    if (new URL(url).pathname !== "/repos/fixture-owner/fixture-repo/branches/fixture-branch") {
      return new Response('{"message":"Branch not found"}', { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response('{"name":"fixture-branch","commit":{"sha":"branch-head"}}', { headers: { "content-type": "application/json" } });
  }, undefined, { setup: (home, git) => {
    const repo = join(home, "repository");
    mkdirSync(repo);
    execFileSync(git, ["init", "-b", "fixture-branch"], { cwd: repo, stdio: "pipe" });
    execFileSync(git, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture branch"], { cwd: repo, stdio: "pipe" });
    execFileSync(git, ["remote", "add", "origin", "https://github.com/fixture-owner/fixture-repo.git"], { cwd: repo, stdio: "pipe" });
    return repo;
  } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "branch-head");
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

test("native GraphQL operationName selects an operation outside the variable map", async () => {
  const query = "query First($weight:Int!) { first: fixture(weight:$weight) { weight } } query Second($weight:Int!) { second: fixture(weight:$weight) { weight } }";
  const result = await fixture(["api", "graphql", "-f", `query=${query}`, "-f", "operationName=Second", "-F", "weight=7", "--jq", ".data.second.weight"], async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.operationName !== "Second" || Object.hasOwn(body.variables, "operationName")) {
      return new Response('{"errors":[{"message":"A top-level operationName is required for this document"}]}', { headers: { "content-type": "application/json" } });
    }
    assert.equal(body.variables.weight, 7);
    return new Response('{"data":{"second":{"weight":17}}}', { headers: { "content-type": "application/json" } });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "17");
});

test("included GraphQL output does not advertise a dead local cursor URL without pagination", async () => {
  const query = "query { repository { items { nodes { weight } pageInfo { hasNextPage endCursor } } } }";
  const result = await fixture(["api", "graphql", "-i", "-f", `query=${query}`], async () => new Response(JSON.stringify({
    data: { repository: { items: { nodes: [{ weight: 11 }], pageInfo: { hasNextPage: true, endCursor: "page-two" } } } },
  }), { headers: { "content-type": "application/json" } }));
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^link:/im);
  const payload = JSON.parse(result.stdout.split(/\r?\n\r?\n/).slice(1).join("\n\n"));
  assert.equal(payload.data.repository.items.nodes[0].weight, 11);
});

test("watch pacing and failed-CI exit codes honor native interval and boolean flags", async () => {
  for (const [interval, delay, flag, expected] of [
    [undefined, 3000, "--exit-status", 1],
    ["5", 5000, "--exit-status=true", 1],
    ["5", 5000, "--exit-status=false", 0],
  ]) {
    let polls = 0;
    const delays = [];
    const args = ["run", "watch", "42", flag, ...(interval ? ["--interval", interval] : [])];
    const code = await withApiFixture(async (url) => {
      const payload = new URL(url).pathname.endsWith("/jobs")
        ? { jobs: [{ name: "build", status: polls === 1 ? "in_progress" : "completed" }] }
        : { name: "CI", status: ++polls === 1 ? "in_progress" : "completed", conclusion: polls === 1 ? null : "failure" };
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    }, (deps) => watchRun(args, {
      ...deps, env: { ...deps.env, GH_REPO: "fixture-owner/fixture-repo" },
      operation: ghOperation(args), sleep: async (ms) => { delays.push(ms); },
    }));
    assert.equal(code, expected);
    assert.deepEqual(delays, [delay]);
    assert.equal(polls, 2);
  }
});

function readLease() {
  const pending = new Set(["bot:core"]);
  return {
    firstAccount: "bot",
    choose: async (resource) => {
      if (pending.has(`bot:${resource}`)) throw new Error("Read capacity is still pending");
      pending.add(`bot:${resource}`);
      return "bot";
    },
    complete: async (account, resource) => { pending.delete(`${account}:${resource}`); },
  };
}

test("cached API reads release pending capacity for the next read", async () => {
  let requests = 0;
  await withApiFixture(async () => {
    requests++;
    return new Response('{"remaining":17}', { headers: { "content-type": "application/json" } });
  }, async (deps) => {
    const read = apiReader({ ...deps, ...readLease(), cacheMs: 60_000 });
    for (let i = 0; i < 3; i++) assert.deepEqual(await (await read("/fixtures/cached")).json(), { remaining: 17 });
    assert.equal(requests, 1);
  });
});

test("auth failure releases pending API capacity without fetching as another account", async () => {
  let requests = 0;
  await withApiFixture(async () => {
    requests++;
    return new Response('{"remaining":17}', { headers: { "content-type": "application/json" } });
  }, async (deps) => {
    const validEnvironment = deps.environment;
    let authorized = false;
    const emptyConfig = join(deps.home, "empty-gh");
    mkdirSync(emptyConfig);
    const read = apiReader({
      ...deps, ...readLease(),
      environment: () => authorized ? validEnvironment() : { ...deps.env, GH_CONFIG_DIR: emptyConfig },
    });
    await assert.rejects(read("/fixtures/auth"), /credentials unavailable/);
    assert.equal(requests, 0);
    authorized = true;
    assert.deepEqual(await (await read("/fixtures/auth")).json(), { remaining: 17 });
    assert.equal(requests, 1);
  });
});

test("transport failure releases pending API capacity for recovery", async () => {
  await withApiFixture(async () => new Response('{"remaining":17}', { headers: { "content-type": "application/json" } }), async (deps) => {
    const fetchPage = globalThis.fetch;
    const read = apiReader({ ...deps, ...readLease() });
    globalThis.fetch = async () => { throw new Error("Fixture connection closed"); };
    try {
      await assert.rejects(read("/fixtures/recovery"), /Fixture connection closed/);
    } finally { globalThis.fetch = fetchPage; }
    assert.deepEqual(await (await read("/fixtures/recovery")).json(), { remaining: 17 });
  });
});

test("search and code-search requests never consume the core or each other's allowance", () => {
  assert.equal(resourceFor("search/issues?q=test"), "search");
  assert.equal(resourceFor("https://api.github.com/search/code?q=test"), "code_search");
  assert.equal(ghOperation(["search", "code", "test"]).resource, "code_search");
  assert.equal(ghOperation(["api", "search/repositories?q=test"]).resource, "search");
});
