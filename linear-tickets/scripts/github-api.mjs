import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function resourceFor(path) {
  const pathname = new URL(path, "https://api.github.com/").pathname;
  if (pathname === "/graphql") return "graphql";
  if (pathname.startsWith("/search/code")) return "code_search";
  if (pathname.startsWith("/search/")) return "search";
  return "core";
}

function cursorIn(value) {
  if (!value || typeof value !== "object") return null;
  if (value.pageInfo?.hasNextPage && value.pageInfo.endCursor) return value.pageInfo.endCursor;
  for (const nested of Object.values(value)) {
    const cursor = cursorIn(nested);
    if (cursor) return cursor;
  }
  return null;
}

// One actual API request, not one CLI process. The native CLI retains its output formatters,
// pagination and flags; this transport chooses an identity separately for every request.
export function apiReader(deps) {
  const tokens = new Map();
  let first = deps.firstAccount;
  return async (path, init = {}) => {
    const resource = resourceFor(path);
    const account = first ?? await deps.choose(resource);
    first = null;
    let credential = tokens.get(account);
    if (!credential || Date.now() - credential.at > 60_000) {
      const auth = spawnSync(deps.realGh, ["auth", "token", "--hostname", "github.com"], { env: deps.environment(account), encoding: "utf8", timeout: 3_000 });
      if (auth.status !== 0 || !auth.stdout.trim()) throw new Error(`GitHub router: ${account} credentials unavailable`);
      credential = { token: auth.stdout.trim(), at: Date.now() };
      tokens.set(account, credential);
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential.token}`);
    headers.set("User-Agent", "paseo-github-router");
    headers.delete("host");
    headers.delete("connection");
    headers.delete("content-length");
    headers.delete("x-paseo-router");
    const keyHeaders = [...headers].filter(([key]) => key !== "authorization");
    const key = createHash("sha256").update(JSON.stringify([account, path, init.method ?? "GET", init.body ?? "", keyHeaders, createHash("sha256").update(credential.token).digest("hex")])).digest("hex");
    const file = deps.home && join(deps.home, "github-router", "response-cache", key.slice(0, 2) + ".json");
    if (file && deps.cacheMs > 0) {
      try {
        const cached = JSON.parse(readFileSync(file, "utf8"));
        if (cached.key === key && Date.now() - cached.at < deps.cacheMs) return new Response(Buffer.from(cached.body, "base64"), { status: cached.status, headers: cached.headers });
      } catch {}
    }
    const response = await fetch(new URL(path, "https://api.github.com/"), { ...init, headers, redirect: "manual" });
    await deps.observe(account, resource, response.headers);
    deps.record(account, resource);
    if (file && deps.cacheMs > 0 && response.status === 200) {
      const body = Buffer.from(await response.clone().arrayBuffer());
      // Fixed slots and a per-entry bound keep the private response cache bounded.
      if (body.length <= 256 * 1024) {
        const directory = join(deps.home, "github-router", "response-cache");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}`;
        writeFileSync(temp, JSON.stringify({ key, at: Date.now(), status: response.status, headers: Object.fromEntries(response.headers), body: body.toString("base64") }), { mode: 0o600 });
        renameSync(temp, file);
      }
    }
    return response;
  };
}

export async function runNativeApi(invocation, deps) {
  const args = [...invocation.args];
  const operation = deps.operation;
  const endpoint = operation.action;
  const endpointIndex = args.indexOf(endpoint);
  const actual = new URL(endpoint === "graphql" ? "/graphql" : endpoint, "https://api.github.com/");
  if (actual.origin !== "https://api.github.com") throw new Error("GitHub router: routed API reads must target api.github.com");
  const read = apiReader(deps);
  const nonce = randomBytes(24).toString("hex");
  let firstBody = null, refusal = null;
  const server = createServer(async (request, outgoing) => {
    try {
      if (request.headers["x-paseo-router"] !== nonce) { outgoing.writeHead(403); outgoing.end(); return; }
      const url = new URL(request.url, "http://localhost");
      let body = "";
      for await (const chunk of request) body += chunk;
      if (url.pathname === "/graphql") {
        const parsed = body ? JSON.parse(body) : firstBody;
        if (!parsed?.query || /\bmutation\b/i.test(parsed.query)) throw new Error("GitHub router: read transport refuses GraphQL mutations");
        firstBody ??= parsed;
        const { query, variables, ...fields } = parsed;
        const cursor = url.searchParams.get("paseoCursor");
        body = JSON.stringify({ query, variables: { ...fields, ...variables, ...(cursor ? { endCursor: cursor } : {}) } });
      }
      if (request.method !== "GET" && !(url.pathname === "/graphql" && request.method === "POST")) throw new Error("GitHub router: read transport refuses writes");
      const remotePath = url.pathname === "/graphql" ? "/graphql" : url.pathname + url.search;
      const response = await read(remotePath, { method: request.method, headers: request.headers, ...(body ? { body } : {}) });
      const headers = Object.fromEntries(response.headers);
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      const payload = Buffer.from(await response.arrayBuffer());
      if (headers.link) headers.link = headers.link.replaceAll("https://api.github.com", `http://127.0.0.1:${server.address().port}`);
      if (headers.location) headers.location = headers.location.replace("https://api.github.com", `http://127.0.0.1:${server.address().port}`);
      if (url.pathname === "/graphql" && response.ok) {
        const result = JSON.parse(payload.toString("utf8"));
        if (result.errors?.length) {
          outgoing.writeHead(422, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ message: result.errors.map((e) => e.message).join("; ") }));
          return;
        }
        const next = cursorIn(result.data);
        if (next) headers.link = `<http://127.0.0.1:${server.address().port}/graphql?paseoCursor=${encodeURIComponent(next)}>; rel="next"`;
      }
      outgoing.writeHead(response.status, headers);
      outgoing.end(payload);
    } catch (error) {
      refusal = error;
      outgoing.writeHead(503, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ message: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  args[endpointIndex] = `http://127.0.0.1:${server.address().port}${actual.pathname}${actual.search}`;
  args.push("-H", `X-Paseo-Router: ${nonce}`);
  const env = { ...invocation.env, GH_TOKEN: "paseo-local-transport" };
  delete env.GITHUB_TOKEN;
  let child;
  const forward = (signal) => child?.kill(signal);
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = signals.map((s) => { const fn = () => forward(s); process.on(s, fn); return fn; });
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(invocation.real, args, { env, stdio: invocation.stdio ?? "inherit" });
      let stdout = "", stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    if (refusal) throw refusal;
    return result;
  } finally {
    signals.forEach((s, i) => process.removeListener(s, handlers[i]));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

export async function watchRun(args, deps) {
  const operation = deps.operation;
  const id = operation.words[2];
  if (!/^\d+$/.test(id ?? "")) throw new Error("GitHub router: automated gh run watch requires a numeric run ID");
  let repo = deps.env.GH_REPO;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" || args[i] === "--repo") repo = args[i + 1];
    else if (args[i].startsWith("--repo=")) repo = args[i].slice(7);
  }
  if (!repo) {
    const remote = spawnSync(deps.realGit, ["remote", "get-url", "origin"], { encoding: "utf8" });
    repo = remote.stdout.trim().replace(/^https:\/\/github.com\//, "").replace(/^git@github.com:/, "").replace(/\.git$/, "");
  }
  repo = repo?.replace(/^https:\/\/github.com\//, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("GitHub router: gh run watch needs --repo OWNER/REPO");
  const read = apiReader(deps);
  while (true) {
    const response = await read(`repos/${repo}/actions/runs/${id}`);
    if (!response.ok) throw new Error(`GitHub run watch failed (HTTP ${response.status})`);
    const run = await response.json();
    console.log(`${run.name}: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}`);
    const jobsResponse = await read(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`);
    if (!jobsResponse.ok) throw new Error(`GitHub run jobs failed (HTTP ${jobsResponse.status})`);
    const jobs = await jobsResponse.json();
    for (const job of jobs.jobs ?? []) console.log(`  ${job.name}: ${job.status}${job.conclusion ? ` (${job.conclusion})` : ""}`);
    if (run.status === "completed") return args.includes("--exit-status") && run.conclusion !== "success" ? 1 : 0;
    await new Promise((resolve) => setTimeout(resolve, Number(operation.interval) * 1000));
  }
}
