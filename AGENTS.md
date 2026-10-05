# AGENTS.md — paseo-plugins

Paseo plugins, one directory each (`linear-tickets/`, `peer-agents/`). Each plugin's `README.md` documents its
behavior and changes in the same pull request as the behavior.

## Checks

In every plugin directory the change touches, on the final head of the branch:

```sh
npm ci
npm run typecheck
npm test
```

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
- A merge changes no running host. To roll it out, on each host that runs the plugin (the laptop and server087):
  `git -C ~/dev/paseo-plugins pull --ff-only`, `npm ci` in the plugin directory if its lockfile changed, then
  `paseo plugin reload <id>`.
- Rollback: `git revert` of the merge commit, in a new pull request.
