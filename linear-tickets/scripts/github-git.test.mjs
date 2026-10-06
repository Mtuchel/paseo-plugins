import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { botGitInvocation } from "./github-git.mjs";

const realGit = process.env.PASEO_TEST_REAL_GIT || "/usr/bin/git";
const BOT = "bot112112121";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "github-git-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "repo with spaces");
  mkdirSync(repo);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"),
    GH_CONFIG_DIR: join(home, "gh-bot"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "global") };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM)|DIR|COMMON_DIR|WORK_TREE|SSH(?:_COMMAND|_VARIANT)?|ASKPASS)$/.test(key) ||
        ["GH_TOKEN", "GITHUB_TOKEN", "SSH_ASKPASS"].includes(key)) delete env[key];
  }
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  function run(args, options = {}) {
    const result = spawnSync(realGit, args, { cwd: repo, env, encoding: "utf8", timeout: 5_000, ...options });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  run(["init", "--quiet"]);
  const ownerStore = join(home, "owner credentials");
  const botStore = join(home, "bot's credentials");
  writeFileSync(ownerStore, "https://owner:owner-fixture@github.com\nhttps://owner:elsewhere-fixture@git.example.net\n");
  writeFileSync(botStore, `https://${BOT}:bot-fixture@github.com\n`);
  const ownerHelper = `!${quote(realGit)} credential-store --file ${quote(ownerStore)}`;
  const botHelper = `${quote(realGit)} credential-store --file ${quote(botStore)}`;
  const config = (key, value, global = false) => run(["config", ...(global ? ["--global"] : []), "--add", key, value]);
  const invocation = (args, extraEnv = {}) => botGitInvocation(realGit, "unused-gh", home, args, { ...env, ...extraEnv }, botHelper);
  const guarded = (args, options = {}) => {
    const safe = invocation(["-C", repo, ...args], options.env);
    return run(safe.args, { ...options, env: safe.env });
  };
  const fill = (url, args = [], extraEnv = {}) => guarded([...args, "credential", "fill"], { env: extraEnv, input: `url=${url}\n\n` });
  return { home, repo, env, run, config, invocation, guarded, fill, ownerHelper, botHelper };
}

function openSshFixture(t) {
  const f = fixture(t);
  const key = join(f.home, "existing owner key");
  const keygen = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
    env: f.env, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(keygen.error, undefined);
  assert.equal(keygen.status, 0, keygen.stderr);
  const marker = join(f.home, "proxy-reached");
  const hosts = join(f.home, "included hosts");
  const config = join(f.home, "owner ssh config");
  writeFileSync(hosts, [
    "Host github-personal", "  HostName github.com",
    "Host github-alternative", "  HostName ssh.github.com", "  Port 443",
    "Host github-dotted", "  HostName GITHUB.COM.",
    "Host retained", "  HostName localhost", "  User retained-user", "  Port 2222",
    "",
  ].join("\n"));
  // A local failing proxy makes accidental transfer attempts observable without
  // reaching any network. OpenSSH expands the actual connection parameters.
  const proxy = `printf '%%s\\n' '%h' '%p' '%r' > ${quote(marker)}; exit 1`;
  writeFileSync(config, [
    `Include "${hosts}"`, "Host *", "  User git", "  BatchMode yes",
    `  IdentityFile "${key}"`, "  IdentitiesOnly yes",
    `  ProxyCommand /bin/sh -c ${quote(proxy)}`, "",
  ].join("\n"));
  f.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture"]);
  f.config("push.default", "current");
  const command = `/usr/bin/ssh -F ${quote(config)}`;
  const inspect = (destination, options = []) => {
    const result = spawnSync("/usr/bin/ssh", ["-G", "-F", config, ...options, destination], {
      env: f.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false, "-G must not start the transfer proxy");
    return result.stdout;
  };
  const push = (args = ["push", "origin"], extraEnv = {}, inherited = false) => {
    const env = inherited ? f.invocation([], { ...extraEnv, GIT_DIR: join(f.repo, ".git") }).env : extraEnv;
    const safe = f.invocation(["-C", f.repo, ...args], env);
    const result = spawnSync(realGit, safe.args, {
      cwd: f.repo, env: safe.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 128, result.stderr);
    return result;
  };
  return { ...f, key, marker, command, inspect, push };
}

test("global, included, repository and URL-scoped credentials cannot win on GitHub", (t) => {
  const f = fixture(t);
  const included = join(f.home, "included");
  writeFileSync(included, `[credential "https://github.com/o/r.git"]\n\thelper = ${JSON.stringify(f.ownerHelper)}\n\tusername = owner\n`);
  f.config("include.path", included, true);
  f.config("credential.helper", f.ownerHelper, true);
  f.config("credential.username", "owner", true);
  f.config("credential.https://github.com/o.helper", f.ownerHelper);
  f.config("credential.https://github.com/o/r.git.username", "owner");
  const before = f.run(["credential", "fill"], { input: "url=https://github.com/o/r.git\n\n" });
  assert.match(before, /username=owner\n/);
  assert.match(before, /password=owner-fixture\n/);
  const after = f.fill("https://github.com/o/r.git");
  assert.match(after, new RegExp(`username=${BOT}\\n`));
  assert.match(after, /password=bot-fixture\n/);
  assert.doesNotMatch(after, /owner-fixture/);
  // Other hosts retain their own helper chain, not the bot credentials.
  assert.match(f.fill("https://git.example.net/r.git"), /password=elsewhere-fixture\n/);
});

test("bot overrides outrank -c, --config-env, COUNT and inherited PARAMETERS credentials", (t) => {
  const f = fixture(t);
  const env = {
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: f.ownerHelper,
    GIT_CONFIG_KEY_1: "credential.https://github.com/o/r.git.username", GIT_CONFIG_VALUE_1: "owner",
    GIT_CONFIG_PARAMETERS: `${quote(`credential.helper=${f.ownerHelper}`)} ${quote("diff.algorithm=histogram")}`,
    OWNER_HELPER: f.ownerHelper,
  };
  const result = f.fill("https://github.com/o/r.git", [
    "-c", `credential.https://github.com/o/r.git.helper=${f.ownerHelper}`,
    "-c", "credential.https://github.com/o/r.git.username=owner",
    "--config-env=credential.helper=OWNER_HELPER",
  ], env);
  assert.match(result, /password=bot-fixture\n/);
  assert.match(result, new RegExp(`username=${BOT}\\n`));
  assert.equal(f.guarded(["config", "--get", "diff.algorithm"], { env }).trim(), "histogram");
});

test("all matching HTTP authorization headers are reset, including path and wildcard scopes", (t) => {
  const f = fixture(t);
  for (const [key, global] of [
    ["http.extraHeader", true],
    ["http.https://github.com/.extraHeader", true],
    ["http.https://*.com/o.extraHeader", true],
    ["http.https://github.com:443/o/r.git.extraHeader", false],
  ]) {
    f.config(key, "Authorization: owner-fixture", global);
    f.config(key, "X-Owner: owner-fixture", global);
  }
  f.config("http.https://git.example.net/.extraHeader", "X-Other: retained");
  assert.match(f.run(["config", "--get-urlmatch", "http.extraHeader", "https://github.com/o/r.git"]), /owner-fixture/);
  for (const url of ["https://github.com/o/r.git", "https://github.com/unseen/repo.git"]) {
    assert.equal(f.guarded([
      "-c", "http.https://github.com/o/r.git.extraHeader=Authorization: command-owner",
      "config", "--get-urlmatch", "http.extraHeader", url,
    ]).trim(), "");
  }
  assert.equal(f.guarded(["config", "--get-urlmatch", "http.extraHeader", "https://git.example.net/r.git"]).trim(), "X-Other: retained");
});

for (const url of ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com:22/o/r.git"]) {
  test(`fetch and push use HTTPS despite inherited SSH rewrites: ${url}`, (t) => {
    const f = fixture(t);
    f.config("url.git@github.com:.insteadOf", "https://github.com/", true);
    f.config("url.ssh://git@github.com:22/.pushInsteadOf", "https://github.com/", true);
    // A longer repository-prefix owner rule must lose to the concrete self mapping.
    f.config("url.git@github.com:o/.insteadOf", "https://github.com/o/");
    f.run(["remote", "add", "origin", url]);
    const originalConfig = readFileSync(join(f.repo, ".git", "config"), "utf8");
    const originalGlobal = readFileSync(f.env.GIT_CONFIG_GLOBAL, "utf8");
    assert.equal(f.guarded(["remote", "get-url", "origin"]).trim(), "https://github.com/o/r.git");
    assert.equal(f.guarded(["remote", "get-url", "--push", "origin"]).trim(), "https://github.com/o/r.git");
    assert.equal(readFileSync(join(f.repo, ".git", "config"), "utf8"), originalConfig);
    assert.equal(readFileSync(f.env.GIT_CONFIG_GLOBAL, "utf8"), originalGlobal);
  });
}

test("multiple fetch/push URLs and unrelated SSH remotes retain their destinations", (t) => {
  const f = fixture(t);
  f.config("remote.origin.url", "git@github.com:o/r.git");
  f.config("remote.origin.url", "git@git.example.net:o/mirror.git");
  f.config("remote.origin.pushurl", "ssh://git@github.com:22/o/write.git");
  f.config("remote.origin.pushurl", "git@git.example.net:o/write.git");
  f.config("url.git@github.com:.insteadOf", "https://github.com/", true);
  assert.deepEqual(f.guarded(["remote", "get-url", "--all", "origin"]).trim().split("\n"), [
    "https://github.com/o/r.git", "git@git.example.net:o/mirror.git",
  ]);
  assert.deepEqual(f.guarded(["remote", "get-url", "--push", "--all", "origin"]).trim().split("\n"), [
    "https://github.com/o/write.git", "git@git.example.net:o/write.git",
  ]);
});

test("explicit SSH URLs are normalized before Git interprets remote add", (t) => {
  const f = fixture(t);
  f.config("url.git@github.com:.insteadOf", "https://github.com/", true);
  f.guarded(["remote", "add", "origin", "ssh://git@github.com:22/o/r.git"]);
  // The stored URL is HTTPS, not an argv echo from a stand-in binary.
  assert.equal(f.run(["config", "--get", "remote.origin.url"]).trim(), "https://github.com/o/r.git");
});

test("--git-dir and unrelated -c options select and configure the actual repository", (t) => {
  const f = fixture(t);
  f.config("remote.origin.url", "git@github.com:o/r.git");
  const safe = f.invocation(["--git-dir", join(f.repo, ".git"), "-c", "diff.algorithm=patience", "remote", "get-url", "origin"]);
  assert.equal(f.run(safe.args, { env: safe.env }).trim(), "https://github.com/o/r.git");
  assert.equal(f.guarded(["-c", "diff.algorithm=patience", "config", "--get", "diff.algorithm"]).trim(), "patience");
});

test("conflicting exact rewrites fail closed instead of relying on later equal-length rules", (t) => {
  const f = fixture(t);
  f.config("remote.origin.url", "https://github.com/o/r.git");
  for (const kind of ["insteadOf", "pushInsteadOf"]) {
    f.config(`url.git@github.com:o/owner.git.${kind}`, "https://github.com/o/r.git");
    assert.match(f.run(["remote", "get-url", ...(kind === "pushInsteadOf" ? ["--push"] : []), "origin"]), /git@github.com:/);
    assert.throws(() => f.invocation(["-C", f.repo, "fetch", "origin"]), /conflicting exact GitHub URL rewrite/);
    f.run(["config", "--unset-all", `url.git@github.com:o/owner.git.${kind}`]);
  }
});

test("args=[] provides effective bot credentials and routes for Git children", (t) => {
  const f = fixture(t);
  f.config("remote.origin.url", "git@github.com:o/r.git");
  f.config("credential.helper", f.ownerHelper);
  f.config("http.https://github.com/o/r.git.extraHeader", "Authorization: owner-fixture");
  const safe = f.invocation([], { GIT_DIR: join(f.repo, ".git") });
  assert.equal(f.run(["remote", "get-url", "origin"], { env: safe.env }).trim(), "https://github.com/o/r.git");
  assert.match(f.run(["credential", "fill"], { env: safe.env, input: "url=https://github.com/o/r.git\n\n" }), /password=bot-fixture\n/);
  assert.equal(f.run(["config", "--get-urlmatch", "http.extraHeader", "https://github.com/o/r.git"], { env: safe.env }).trim(), "");
});

test("remaining GitHub SSH is blocked while non-GitHub SSH reaches the existing command", (t) => {
  const f = fixture(t);
  // Real SSH with a failing local proxy: deterministic, no external network.
  f.config("core.sshCommand", "ssh -F /dev/null -o BatchMode=yes -o ProxyCommand=false");
  f.config("url.git@github.com:.insteadOf", "gh:");
  const safe = f.invocation([], { GIT_DIR: join(f.repo, ".git") });
  const blocked = spawnSync(realGit, ["ls-remote", "gh:o/r.git"], { env: safe.env, cwd: f.repo, encoding: "utf8", timeout: 5_000 });
  assert.equal(blocked.error, undefined);
  assert.equal(blocked.status, 128);
  assert.match(blocked.stderr, /GitHub SSH is disabled/);
  const other = spawnSync(realGit, ["ls-remote", "git@localhost:r.git"], { env: safe.env, cwd: f.repo, encoding: "utf8", timeout: 5_000 });
  assert.equal(other.error, undefined);
  assert.equal(other.status, 128);
  assert.doesNotMatch(other.stderr, /GitHub SSH is disabled/);
  assert.match(other.stderr, /Connection closed|kex_exchange_identification/);
});

for (const [destination, hostname] of [
  ["git@github-personal:o/r.git", "github.com"],
  ["ssh://git@github-alternative:443/o/r.git", "ssh.github.com"],
  ["git@github-dotted:o/r.git", "GITHUB.COM."],
]) {
  test(`real OpenSSH GitHub aliases are blocked before push: ${destination}`, (t) => {
    const f = openSshFixture(t);
    const host = destination.includes("alternative") ? "github-alternative" :
      destination.includes("dotted") ? "github-dotted" : "github-personal";
    const effective = f.inspect(host);
    assert.match(effective, new RegExp(`^hostname ${hostname.replaceAll(".", "\\.")}$`, "mi"));
    assert.match(effective, /^user git$/m);
    assert.ok(effective.split("\n").includes(`identityfile ${f.key}`));
    f.config("core.sshCommand", f.command);
    f.run(["remote", "add", "origin", destination]);
    assert.match(f.push().stderr, /GitHub SSH is disabled/);
    assert.equal(existsSync(f.marker), false);
  });
}

for (const kind of ["insteadOf", "pushInsteadOf"]) {
  test(`GitHub SSH aliases reached through ${kind} are blocked before push`, (t) => {
    const f = openSshFixture(t);
    f.config("core.sshCommand", f.command);
    f.config(`url.git@github-personal:.${kind}`, "gh:");
    f.run(["remote", "add", "origin", "gh:o/r.git"]);
    assert.equal(f.run(["remote", "get-url", "--push", "origin"]).trim(), "git@github-personal:o/r.git");
    assert.match(f.push(["push", "origin"], {}, true).stderr, /GitHub SSH is disabled/);
    assert.equal(existsSync(f.marker), false);
  });
}

test("non-GitHub aliases retain inherited OpenSSH config through guarded Git children", (t) => {
  const f = openSshFixture(t);
  const effective = f.inspect("retained");
  assert.match(effective, /^hostname localhost$/m);
  assert.match(effective, /^user retained-user$/m);
  assert.match(effective, /^port 2222$/m);
  assert.ok(effective.split("\n").includes(`identityfile ${f.key}`));
  f.config("core.sshCommand", f.command);
  f.run(["remote", "add", "origin", "retained:o/r.git"]);
  const result = f.push(["push", "origin"], {}, true);
  assert.doesNotMatch(result.stderr, /GitHub router:/);
  assert.match(result.stderr, /Connection closed|kex_exchange_identification/);
  assert.equal(readFileSync(f.marker, "utf8"), "localhost\n2222\nretained-user\n");
});

test("inherited SSH command environment outranks a safe repository command", (t) => {
  const f = openSshFixture(t);
  f.config("core.sshCommand", "ssh -F /dev/null -o ProxyCommand=false");
  f.run(["remote", "add", "origin", "git@github-personal:o/r.git"]);
  assert.match(f.push(["push", "origin"], { GIT_SSH_COMMAND: f.command }).stderr, /GitHub SSH is disabled/);
  assert.equal(existsSync(f.marker), false);
});

test("effective HostName command-line overrides cannot hide GitHub behind a retained alias", (t) => {
  const f = openSshFixture(t);
  assert.match(f.inspect("retained", ["-o", "HostName=github.com"]), /^hostname github.com$/m);
  f.run(["remote", "add", "origin", "retained:o/r.git"]);
  const result = f.push(["-c", `core.sshCommand=${f.command} -o HostName=github.com`, "push", "origin"]);
  assert.match(result.stderr, /GitHub SSH is disabled/);
  assert.equal(existsSync(f.marker), false);
});

test("failed effective OpenSSH inspection refuses transfer", (t) => {
  const f = openSshFixture(t);
  f.config("core.sshCommand", `/usr/bin/ssh -F ${quote(join(f.home, "missing config"))}`);
  f.run(["remote", "add", "origin", "git@github-personal:o/r.git"]);
  assert.match(f.push().stderr, /cannot inspect effective OpenSSH configuration/);
  assert.equal(existsSync(f.marker), false);
});

test("custom SSH executables and shell launchers fail closed without executing them", (t) => {
  const f = openSshFixture(t);
  const custom = join(f.home, "custom ssh");
  const marker = join(f.home, "custom-command-executed");
  writeFileSync(custom, `#!/bin/sh\ntouch ${quote(marker)}\nexec ${f.command} "$@"\n`, { mode: 0o700 });
  f.run(["remote", "add", "origin", "git@github-personal:o/r.git"]);
  for (const env of [
    { GIT_SSH: custom },
    { GIT_SSH_COMMAND: quote(custom) },
    { GIT_SSH_COMMAND: `${f.command}; touch ${quote(marker)}` },
  ]) {
    assert.match(f.push(["push", "origin"], env).stderr, /unsupported SSH (?:command|shell command)/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(f.marker), false);
  }
});

test("non-OpenSSH variants and alternate SSH execution modes fail closed", (t) => {
  const f = openSshFixture(t);
  f.run(["remote", "add", "origin", "retained:o/r.git"]);
  assert.match(f.push(["push", "origin"], { GIT_SSH_COMMAND: f.command, GIT_SSH_VARIANT: "plink" }).stderr,
    /unsupported SSH variant/);
  assert.match(f.push(["push", "origin"], { GIT_SSH_COMMAND: `${f.command} -W github.com:22` }).stderr,
    /unsupported SSH option/);
  assert.equal(existsSync(f.marker), false);
});

test("a failed guarded helper cannot fall back to inherited owner askpass", (t) => {
  const f = fixture(t);
  const marker = join(f.home, "askpass-used");
  const askpass = join(f.home, "askpass");
  writeFileSync(askpass, `#!/bin/sh\ntouch ${quote(marker)}\nprintf 'owner-fixture\\n'\n`, { mode: 0o700 });
  f.config("core.askPass", askpass);
  f.config("credential.helper", f.ownerHelper);
  const safe = botGitInvocation(realGit, "unused-gh", f.home, ["-C", f.repo, "credential", "fill"],
    { ...f.env, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass }, "/usr/bin/false");
  const result = spawnSync(realGit, safe.args, { env: safe.env, encoding: "utf8", input: "url=https://github.com/o/r.git\n\n", timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 128);
  assert.doesNotMatch(result.stdout, /password=/);
  assert.equal(existsSync(marker), false);
});

test("unsupported concrete GitHub SSH transports are rejected before using owner keys", (t) => {
  const f = fixture(t);
  for (const url of ["ssh://git@github.com:2222/o/r.git", "ssh://git@ssh.github.com:443/o/r.git"]) {
    assert.throws(() => f.invocation(["-C", f.repo, "ls-remote", url]), /unresolved GitHub transport/);
  }
});
