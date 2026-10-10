# Paseo plugins

Plugins that extend [Paseo](https://paseo.sh) with sidebar views, agent tools, and chat cards.
Each plugin lives in its own folder and is installed independently. See the
[plugin documentation](https://paseo.sh/docs/plugins) for the plugin API.

## Available plugins

| Plugin | Description | Requires |
| --- | --- | --- |
| [linear-tickets](./linear-tickets) | Connects to Linear's GraphQL API (read queries; optionally marks a ticket In Progress on launch), lists the tickets assigned to you, highlights blockers, and shows parent, subissue, and related tickets regardless of assignee. Filter by workflow status or dependency, search, sort, then pick a project, base branch, provider and model before launching. The launch prompt is customizable per host. | Paseo ≥ 0.8.0, Node.js ≥ 22 on the daemon host |
| [peer-agents](./peer-agents) | Lets agents choose a registered project, create an independent peer in a new workspace, and exchange messages with injected MCP tools. | Paseo ≥ 0.9.1 < 0.10.0, Node.js ≥ 22 and Paseo CLI on the daemon host |

## Install

Install a plugin from its folder with the Paseo CLI:

```sh
cd linear-tickets
npm ci
npm run typecheck
npm test
node ../tools/paseo-build.mjs .
paseo plugin install "$PWD"
```

Enable plugins in Paseo Settings → Plugins if needed, then roll out source
changes from the checkout root:

```sh
node tools/plugin-rollout.mjs linear-tickets
```

After a config change, add `--force`. The tool pulls, installs, runs the build
check, and reloads only when needed; see AGENTS.md for the wait rules (a load
takes about 2.5 minutes).

Each plugin's README covers its own setup, permissions and behavior.

## Development

Every plugin is checked with the same three commands before installing:

```sh
npm run typecheck   # tsc --noEmit against the Paseo SDK
npm test            # node --test with the plugin's own test files
node ../tools/paseo-build.mjs .   # Paseo's own plugin build (the daemon's load check)
```

A plugin that excludes the installed Paseo (`peer-agents` today) is checked
against a supported Paseo with `PASEO_SERVER_DIR` (see AGENTS.md, "Checks").
A change under `tools/` also runs `node --test tools/` at the repository root.

## Adding a plugin

Create a new folder at the repository root containing `paseo-plugin.json`, the
`index.client.tsx` / `index.server.ts` entrypoints, and a README describing what
it does and what it requires. Add a row to the table above.
