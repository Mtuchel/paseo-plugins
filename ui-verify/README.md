# ui-verify

ui-verify watches agent turns in a repository that contains `apps/core-web` and asks the agent to
look at its own UI work before it finishes.

When a completed turn changed core-web UI source files but ran no browser check, the plugin sends
the agent one follow-up prompt. The prompt names the changed files and asks the agent to:

- start the worktree's `core-web` service,
- check every affected route in a browser following `apps/core-web/docs/ui-check.md`,
- add the screenshots to the pull request's `## Screenshots and recordings` section and link them
  in its reply,
- or say why a browser check is impossible.

The follow-up arrives as a normal user message in the agent's chat, so the agent can act on it in
the same workspace. The plugin has no screens, sidebar items, or settings; everything happens on
the daemon side.

## When it fires

An agent turn triggers the check only when all of these hold:

- The agent's working directory is inside a git repository whose root contains
  `apps/core-web/package.json`.
- The turn finished with `completed` — canceled and failed turns are ignored.
- The turn changed at least one UI source file under `apps/core-web/src/`: `*.tsx` or `*.css`.
- The change is new in this turn. The plugin snapshots the working tree into a temporary git tree
  object at turn start and again at turn end, so committed changes made during the turn count too.
- No tool call in the turn used a browser or Playwright. The check looks only at the tool's name
  and, for shell tools, the executed command. A browser tool name such as `browser_screenshot`,
  `browser_snapshot`, `browser_navigate`, `browser_take_screenshot` (including provider prefixes
  such as `mcp__paseo__browser_screenshot` and `paseo.browser_screenshot`) counts. A command that
  runs `playwright test`, `playwright-test`, or `playwright screenshot` counts, including through
  `npx`, `pnpm exec`, and similar runners. Tool outputs and file contents are ignored: reading
  `ui-check.md`, grepping for a command, or writing a file that mentions Playwright is not a
  browser check.

Test and fixture files do not count: `*.test.tsx`, `*.spec.tsx`, `*.test.css`, `*.spec.css`, files
under `__tests__/`, and files under `e2e/` are ignored.

The snapshot stages into a copy of the git index (`GIT_INDEX_FILE`) and never touches the real
index, so the agent's staged and unstaged changes stay exactly as they were.

## Loop guard

Every follow-up starts with `[ui-verify]`. A turn whose triggering user message starts with that
marker is never nudged again, and only completed turns produce a nudge.

The plugin also remembers the identity of the human user message that triggered a follow-up (its
`messageId` when present, otherwise its position and text) and reserves one follow-up per message
before sending. Autonomous continuation turns that add no new user message therefore cannot send
the same reminder again, and two concurrent turn ends for one request send at most one.

## A newer turn

Paseo's send API has no queue or skip-when-busy mode: a prompt sent while a turn is active
interrupts that turn by default. The only other mode, `steer`, can fall back to replacing the turn
on providers that do not support steering. The plugin therefore increments a per-agent turn
generation on every `agent.turn_started` and drops the follow-up if a newer turn has started by the
time the end-of-turn snapshot and decision finish. The check is best effort for the small window
between that check and the daemon accepting the send; the plugin never deliberately interrupts a
newer turn.

## Failures

Not being in a git repository, a git error, or a failed send is logged with a `[ui-verify]` prefix
in the plugin logs and skipped. The plugin never throws into the agent lifecycle. If the turn-start
snapshot fails, that turn gets no follow-up.

On plugin shutdown the monitor aborts any in-flight git command and waits for its temporary index
directory to be removed before the cleanup resolves. Paseo gives cleanup 2 seconds before it sends
`SIGTERM`, which is enough for the aborted git process and the directory removal.

## Install

Requires Paseo 0.10.3 or newer and Node.js 22 or newer on the daemon host. The target repository
must document its browser check in `apps/core-web/docs/ui-check.md` and expose its web app through
a `core-web` service in the worktree's Paseo setup.

From a local checkout:

```sh
cd ui-verify
npm ci
npm run typecheck
TMPDIR=/private/tmp npm test
node ../tools/paseo-build.mjs .
paseo plugin install "$PWD"
```

Turns that are already running when the plugin loads have no turn-start snapshot and are skipped;
the next turn is checked normally. Paseo runs hooks without waiting for them, so the turn-start
snapshot races the agent's first tool call: an edit landing before the snapshot finishes is not
counted for that turn.

## Disable

Turn the plugin off in Paseo **Settings → Plugins**, which stops it for every project on that
daemon, or disable it from the CLI:

```sh
paseo plugin disable ui-verify
```

`paseo plugin enable ui-verify` turns it back on. Removing the plugin also removes the follow-up.

## Development

```sh
npm ci
npm run typecheck
TMPDIR=/private/tmp npm test
node ../tools/paseo-build.mjs .
```

`server/decision.ts` is the pure decision logic (path filter, browser-check matcher, loop guard,
message text); `server/git-snapshot.ts` owns the temporary-index git snapshots, abort signals, and
is tested against real temporary repositories; `server/turn.ts` holds the per-agent turn
generations, baselines, per-request reservations, cleanup, and sends the follow-up through
`paseo.agents.ref(agentId).send(text)`.

Roll out with `node ~/dev/paseo-plugins/tools/plugin-rollout.mjs ~/dev/paseo-plugins/ui-verify`.