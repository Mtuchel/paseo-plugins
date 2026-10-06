import { spawnSync } from "node:child_process";

const BOT = "bot112112121";
const GITHUB = "https://github.com";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Keep Git's own option parsing for repository selection and configuration queries.
function splitInvocation(args) {
  let i = 0;
  const context = [];
  while (i < args.length && args[i].startsWith("-")) {
    const arg = args[i++];
    if (arg === "--") break;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) {
      if (i === args.length) throw new Error(`GitHub router: missing value for ${arg}`);
      context.push(arg, args[i++]);
    } else if (/^(?:-C.|-c.|--(?:git-dir|work-tree|namespace|config-env)=)/.test(arg) || arg === "--bare") {
      context.push(arg);
    }
  }
  return { prefix: args.slice(0, i), command: args.slice(i), context };
}

function gitConfig(realGit, context, env, args, missing = false) {
  const result = spawnSync(realGit, [...context, "config", "--includes", "--null", ...args], {
    env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (missing && result.status === 1) return [];
  if (result.error || result.status !== 0) throw new Error("GitHub router: cannot inspect inherited Git configuration");
  return result.stdout.split("\0").filter(Boolean);
}

function githubScope(scope) {
  // Git permits wildcard domain labels, default ports, users, and path-specific scopes.
  const host = scope.match(/^(?:https?:\/\/)?(?:[^/@]*@)?([^/:]+)(?::\d+)?(?:\/|$)/i)?.[1];
  if (!host) return false;
  const pattern = host.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.]*");
  return new RegExp(`^${pattern}$`, "i").test("github.com");
}

function githubUrl(value) {
  const scp = value.match(/^(?:git@)?github\.com:(.+)$/i);
  if (scp) return `${GITHUB}/${scp[1].replace(/^\/+/, "")}`;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["github.com", "ssh.github.com"].includes(url.hostname.toLowerCase())) return null;
  if (url.hostname.toLowerCase() === "github.com" && url.protocol === "https:") return url.href;
  if (url.hostname.toLowerCase() === "github.com" && url.protocol === "ssh:" &&
      (!url.username || url.username === "git") && !url.password && (!url.port || url.port === "22")) {
    return `${GITHUB}${url.pathname}`;
  }
  throw new Error("GitHub router: unresolved GitHub transport; use a github.com HTTPS URL");
}

// Parse only literal shell words. Expansions, pipelines and custom launchers cannot
// be inspected safely without executing them, so SSH operations fail closed.
function sshWords(command) {
  const words = [];
  let word = "", started = false, quoted = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quoted === "'") {
      if (char === "'") quoted = "";
      else word += char;
    } else if (char === "\\" && command[i + 1] !== undefined) {
      const next = command[++i];
      if (quoted === '"' && !['$', '`', '"', "\\"].includes(next)) word += "\\";
      if (next === "\n") throw new Error("unsupported SSH shell continuation");
      word += next;
    } else if (quoted === '"') {
      if (char === '"') quoted = "";
      else if (char === "$" || char === "`") throw new Error("unsupported SSH shell expansion");
      else word += char;
    } else if (char === "'" || char === '"') {
      quoted = char;
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
      continue;
    } else if (/[\\$`;&|<>(){}*?!~#]/.test(char)) {
      throw new Error("unsupported SSH shell command");
    } else {
      word += char;
    }
    started = true;
  }
  if (quoted) throw new Error("unterminated SSH shell quote");
  if (started) words.push(word);
  return words;
}

// Serialized into GIT_SSH_COMMAND so the guard runs after Git applies URL
// rewrites and chooses the actual destination, including inherited child calls.
function guardedSsh(selection, gitArgs) {
  const { spawnSync } = require("node:child_process");
  const fail = (message) => {
    console.error(`GitHub router: ${message}`);
    process.exit(1);
  };
  if (selection.error) fail(selection.error);
  if (!["ssh", "auto"].includes(selection.variant)) fail("unsupported SSH variant; refusing uninspected transport");
  const inherited = selection.args;
  // These are OpenSSH connection options, not alternate execution modes such as
  // -O (control command), -W (stdio forwarding), or an inherited -G/-V/-Q.
  const optionEnd = (args) => {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) {
      const option = args[i++];
      if (option === "--") break;
      for (let j = 1; j < option.length; j++) {
        const flag = option[j];
        if ("46AaCqTtvxXYn".includes(flag)) continue;
        if (!"BbcDEeFIiJLlmopRSw".includes(flag)) fail("unsupported SSH option; refusing uninspected transport");
        if (j === option.length - 1 && i++ >= args.length) fail("missing SSH option value");
        break;
      }
      if (option === "-") fail("unsupported SSH destination");
    }
    return i;
  };
  if (optionEnd(inherited) !== inherited.length) fail("unsupported inherited SSH destination");
  const args = [...inherited, ...gitArgs];
  const destinationIndex = optionEnd(args);
  const destination = args[destinationIndex];
  if (!destination || destination.startsWith("-") || args.length > destinationIndex + 2) {
    fail("cannot inspect SSH destination");
  }
  // -G evaluates Host/Include/Match and command-line overrides without opening a
  // connection or running ProxyCommand. Never probe with a remote transfer.
  const probe = spawnSync("/usr/bin/ssh", ["-G", ...args], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
  });
  if (probe.error || probe.status !== 0) fail("cannot inspect effective OpenSSH configuration");
  const hosts = probe.stdout.split(/\r?\n/).filter((line) => /^hostname\s/i.test(line));
  if (hosts.length !== 1) fail("cannot inspect effective SSH hostname");
  const hostname = hosts[0].replace(/^hostname\s+/i, "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || /\s/.test(hostname)) fail("cannot inspect effective SSH hostname");
  if (["github.com", "ssh.github.com"].includes(hostname)) {
    fail("GitHub SSH is disabled for bot operations");
  }
  const result = spawnSync("/usr/bin/ssh", args, { stdio: "inherit" });
  if (result.error) fail("cannot launch inspected OpenSSH transport");
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exit(result.status ?? 1);
}

function sshGuard(command, variant) {
  const script = `(${guardedSsh.toString()})(JSON.parse(process.argv[1]), process.argv.slice(2))`;
  let selection;
  try {
    const words = sshWords(command);
    // args=[] guards are inherited by intercepted Git children. Recognize only
    // our exact literal wrapper, not an arbitrary command claiming to be guarded.
    if (words.length === 4 && words[0] === process.execPath && words[1] === "-e" && words[2] === script) {
      selection = JSON.parse(words[3]);
    } else {
      if (!["ssh", "/usr/bin/ssh", "/bin/ssh"].includes(words[0])) {
        throw new Error("unsupported SSH command; refusing uninspected transport");
      }
      selection = { args: words.slice(1), variant };
    }
  } catch (error) {
    selection = { error: error.message };
  }
  // Pin real OpenSSH, rather than trusting a PATH shim's -G output.
  return `${quote(process.execPath)} -e ${quote(script)} ${quote(JSON.stringify(selection))}`;
}

/**
 * The caller supplies a bot GH_CONFIG_DIR environment and a guarded shell helper
 * command (without Git's leading !). That helper owns token/identity validation.
 * No credentials are fetched here and no configuration files are modified.
 * args=[] returns a guard environment for gh/gt children in the current context;
 * intercepted Git children must call this again with their actual repository/options.
 */
export function botGitInvocation(realGit, _realGh, _home, args, env, credentialHelper) {
  if (!credentialHelper?.trim()) throw new Error("GitHub router: guarded bot credential helper is required");
  const { prefix, command, context } = splitInvocation(args);
  const keys = gitConfig(realGit, context, env, ["--name-only", "--list"]);
  // Only read routing values; authentication header/token values are not needed.
  const routes = gitConfig(realGit, context, env, ["--get-regexp", "^(url\\..*\\.(insteadof|pushinsteadof)|remote\\..*\\.(url|pushurl)|core\\.(sshcommand|askpass)|ssh\\.variant)$"], true)
    .map((entry) => {
      const newline = entry.indexOf("\n");
      return [newline < 0 ? entry : entry.slice(0, newline), newline < 0 ? "" : entry.slice(newline + 1)];
    });
  const overrides = [];
  for (const key of new Set(keys)) {
    const match = key.match(/^(http|credential)\.(.+)\.(extraheader|helper|username)$/i);
    if (!match || !githubScope(match[2])) continue;
    overrides.push([key, match[3].toLowerCase() === "username" ? BOT : ""]);
  }

  const concrete = new Set();
  const remotes = new Map();
  for (const [key, value] of routes) {
    if (!/^remote\..*\.(url|pushurl)$/i.test(key)) continue;
    const values = remotes.get(key) ?? [];
    values.push(value);
    remotes.set(key, values);
  }
  for (const [key, values] of remotes) {
    let changed = false;
    const normalized = values.map((value) => {
      const github = githubUrl(value);
      if (!github) return value;
      concrete.add(github);
      changed ||= github !== value;
      return github;
    });
    if (changed) overrides.push([key, ""], ...normalized.map((value) => [key, value]));
  }
  const normalizedCommand = command.map((arg) => {
    const github = githubUrl(arg);
    if (!github) return arg;
    concrete.add(github);
    return github;
  });

  for (const url of concrete) {
    for (const kind of ["insteadof", "pushinsteadof"]) {
      // A later rule cannot win an exact-length tie against an earlier base.
      const conflict = routes.some(([key, value]) => {
        const match = key.match(/^url\.(.*)\.(insteadof|pushinsteadof)$/i);
        return match && match[2].toLowerCase() === kind && value === url && match[1] !== url;
      });
      if (conflict) throw new Error("GitHub router: conflicting exact GitHub URL rewrite; refusing owner transport");
      overrides.push([`url.${url}.${kind}`, url]);
    }
  }
  // Credential matching collects all matching scopes, unlike HTTP's best match.
  // This final reset removes global and repository-specific helpers for GitHub.
  overrides.push(
    [`http.${GITHUB}/.extraHeader`, ""],
    [`credential.${GITHUB}.helper`, ""],
    [`credential.${GITHUB}.helper`, `!${credentialHelper}`],
    [`credential.${GITHUB}.username`, BOT],
    ["core.askPass", "/usr/bin/false"],
  );
  const next = { ...env };
  // COUNT entries precede PARAMETERS; preserve both and append after all inherited
  // PARAMETERS as well. Explicit -c still wins, hence the final argv overrides.
  next.GIT_CONFIG_PARAMETERS = [env.GIT_CONFIG_PARAMETERS, ...overrides.map(([key, value]) => quote(`${key}=${value}`))].filter(Boolean).join(" ");
  const last = (key) => routes.filter(([name]) => name.toLowerCase() === key).at(-1)?.[1];
  const ssh = env.GIT_SSH_COMMAND || last("core.sshcommand") || (env.GIT_SSH ? quote(env.GIT_SSH) : "ssh");
  next.GIT_SSH_COMMAND = sshGuard(ssh, env.GIT_SSH_VARIANT || last("ssh.variant") || "ssh");
  next.GIT_SSH_VARIANT = "ssh";
  next.GIT_TERMINAL_PROMPT = "0";
  next.GIT_ASKPASS = "/usr/bin/false";
  next.SSH_ASKPASS = "/usr/bin/false";
  return {
    args: args.length ? [...prefix, ...overrides.flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...normalizedCommand] : [],
    env: next,
  };
}
