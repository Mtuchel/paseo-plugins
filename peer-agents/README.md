# Peer agents

Peer agents gives Paseo-managed agents three MCP tools:

- `list_peer_projects` lists the registered projects and their IDs.
- `create_peer_agent` creates a new workspace in a selected project and starts an **independent, top-level agent** there. It returns the new agent ID and puts the creator's ID in the new agent's first prompt. The creator's chat shows a pending card while creation runs, then a card with the task, project name, and a link to the new agent. The new agent's chat shows a task card with a link back to the creator, hiding the tool instructions. By default, it uses the calling agent's provider and effective model.
- `send_peer_message` sends a prompt to an agent ID on the same Paseo host, including a peer in another workspace. Paseo's chat renders it as a **Peer agent** card showing the message and a link to the sender.

The creation, task, and message cards render Markdown in their text, including headings, lists, code, links, tables, and images.

![A peer agent created in a separate workspace](images/01-peer-created.png)
![Task and message cards in the peer agent's conversation](images/02-peer-conversation.png)

The plugin injects its tools into new Claude, Codex, and OpenCode sessions and preapproves those tools through Paseo's tool policy so agents can use them without a human confirmation. Paseo 0.9.1 cannot preapprove exact MCP tools for Pi, so the plugin leaves Pi sessions alone. It does not need Paseo's global `injectIntoAgents` switch. The agent provider must accept stdio MCP servers. Existing sessions must be reloaded to receive the tools. On Linux, the tools also recover the Paseo agent ID from their provider parent process when a provider such as Codex strips environment variables from MCP children.

## Install

Requires Paseo 0.9.1 or newer in the 0.9 line, Node.js 22 or newer, and a `paseo` CLI on the daemon host's `PATH` that connects to the same daemon as the agent. If the daemon uses a nondefault host or home, set `PASEO_HOST` or `PASEO_HOME` in the daemon's environment so the injected MCP process uses the same target.

From npm:

```sh
paseo plugin add npm:paseo-peer-agents@0.1.1
```

From a local checkout:

```sh
cd peer-agents
npm ci
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-plugins/peer-agents
```

Reload an existing agent or start a new one after installation. It can call `list_peer_projects`, then pass the chosen `projectId` and task prompt to `create_peer_agent`. Omit `provider` and `model` to use the caller's provider and model; set either field to override it. For a separate checkout, specify `isolation: "worktree"` and optionally a branch name and base ref. With `isolation: "local"`, the new workspace has its own Paseo identity but shares the selected project's directory.

The creator receives the peer's agent ID from the tool. The peer receives the creator's ID in its first prompt, and both agents receive `send_peer_message`. No human needs to detach or copy IDs.

If agent launch fails after workspace creation, the tool checks for an agent tagged with that workspace ID. It archives the empty workspace; if an agent may have started or the check fails, it keeps the workspace and reports its ID for inspection.

## How it works

Paseo normally records an agent-launched session as a subagent, even when it is placed in another workspace. `create_peer_agent` calls `paseo workspace create --project <id>` to create the workspace in the selected registered project. It then invokes `paseo run --background --workspace <id>` with `PASEO_AGENT_ID` cleared **for that launch only**. Paseo therefore creates a root agent directly. The tool returns the workspace and agent IDs after checking `paseo agent inspect` for a parent. It uses argument arrays rather than a shell.

`send_peer_message` uses `paseo send --no-wait`, so the receiving agent can act on the message. The client timeline transformers display peer creation, tasks, and messages as cards. The links use Paseo's agent routes in the browser and app links in native clients. Both tools address only agents on the same Paseo daemon host.

## Development

```sh
cd peer-agents
npm ci
npm run typecheck
npm test
node ../tools/paseo-build.mjs .
```

peer-agents declares Paseo >=0.9.1 <0.10.0, so on a 0.10 host this check refuses it with Paseo's own message; check it against a supported Paseo with `PASEO_SERVER_DIR` (see AGENTS.md, "Checks"). Roll out with `node ~/dev/paseo-plugins/tools/plugin-rollout.mjs ~/dev/paseo-plugins/peer-agents`.
