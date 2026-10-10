# AGENTS.md — paseo-plugins

Paseo plugins, one directory each (`linear-tickets/`, `peer-agents/`). Each plugin's `README.md` documents its
behavior and changes in the same pull request as the behavior.

## Checks

In every plugin directory the change touches, on the final head of the branch:

```sh
npm ci
npm run typecheck
npm test
node ../tools/paseo-build.mjs .
```

The last line runs Paseo's own plugin build (the one the daemon runs on load) with the Paseo
installed on the host. A plugin whose manifest excludes the host's Paseo (peer-agents today) is
checked against a Paseo version it supports: `npm pack @getpaseo/server@<version>` in a temp dir,
unpack it, `npm install --omit=dev --ignore-scripts` in the unpacked `package/`, then
`PASEO_SERVER_DIR=<that dir> node ../tools/paseo-build.mjs .`. Also run it once without
`PASEO_SERVER_DIR` and put the host's refusal in the PR body. Never widen the plugin's Paseo range
or skip the check to pass. A change under `tools/` also runs `node --test tools/` at the repository
root.

On macOS, use `TMPDIR=/private/tmp npm test`: broker fixtures need short Unix socket paths,
and generated restore commands need a canonical temporary path without `/var` symlink aliases.

There is no GitHub CI: these local checks are the merge gate.

## Pull request lifecycle

- `main` is protected: every change goes through a pull request; nobody pushes to `main`, admins included.
- One concern per branch, cut from `origin/main`, in its own worktree. The checkout `~/dev/paseo-plugins` stays on
  a clean `main`: the hosts load the plugins from it.
- Open the PR with `gh pr create` (`--draft` while work continues). The body says what changed, why, and which
  checks ran with their results.
- Merge path: once the checks pass on the final head and the PR is ready (`gh pr ready`), run
  `gh pr merge <number> --squash --delete-branch`. Squash is the only merge method. Never `--admin`. A PR labelled
  `do-not-merge` is not merged.
- Behind `main`: `git rebase origin/main`, run the checks again, `git push --force-with-lease`. Never merge `main`
  into the branch.
- A merge changes no running host. Roll out on each host that runs the plugin (the laptop and server087) with
  `node ~/dev/paseo-plugins/tools/plugin-rollout.mjs ~/dev/paseo-plugins/<id>` and nothing else: no `git pull`, no
  Settings reload, no `paseo plugin reload` by hand. The tool pulls, installs when the lockfile changed, runs the
  build check, and reloads only when it is needed, one rollout at a time. Use `--force` for a config-only reload,
  and after exit 2 ("cannot tell which code runs") read the reason; if the plugin should run the checkout's code,
  rerun with `--force`.
  - Reading state: a load takes about 2.5 minutes. A 60 s CLI timeout
    (`Timeout waiting for message (60000ms)`) and a `failed` status in `paseo plugin ls` during the first
    ~3 minutes are not failures: wait for `[paseo] Plugin ready` in `paseo plugin logs <id>` (or `running` in
    `paseo plugin ls`), act only on a `[paseo] Plugin failed to load` line, and never reload again while a load
    runs — each reload starts the load over.
  - Known limitation: the tool assumes plugins are reloaded only through it or by a Paseo restart. A reload from
    Paseo Settings (or a bare `paseo plugin reload`) whose log line has already scrolled out of the 500-line
    plugin log goes unnoticed: normally one unnecessary reload later; in one rare case (plugin code changed,
    reloaded from Settings, then a revert restored the exact earlier code) it reports old code as current. Hence:
    reload only through the tool.
- Rollback: `git revert` of the merge commit, in a new pull request.
