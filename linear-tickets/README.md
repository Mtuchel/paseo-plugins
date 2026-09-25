# Linear tickets

A Paseo sidebar plugin that connects to Linear's GraphQL API, shows tickets assigned to you
(filtered and searched server-side across your workspace), and starts an agent with the
ticket details, comments and relationships in its first prompt.

![Ticket list with status filters, search and sorting](images/02-ticket-list.png)
![Starting an agent from a ticket](images/01-create-agent.png)
![The launch form on mobile](images/03-create-agent-mobile.jpeg)

## Install

Requires Paseo 0.8.0 or newer and Node.js 22 or newer on the daemon host.

From npm, with Paseo 0.9 or newer (the pinned package and its production
dependencies are installed for you):

```sh
paseo plugin add npm:paseo-linear-tickets@0.4.0
```

From a local checkout:

```sh
cd linear-tickets
npm ci
npm run typecheck
npm test
paseo plugin install /absolute/path/to/linear-tickets
```

Enable plugins in Paseo Settings → Plugins if needed. Open **Linear tickets** in
the sidebar or **Open Linear tickets** in the command center. After source changes:

```sh
paseo plugin reload linear-tickets
```

## Connect and start work

1. Create a personal Linear API key in Settings → Security & access. Read permission
   and access to the relevant teams are sufficient; write permission is only needed
   for the optional "mark the ticket In Progress" step (see below).
2. Paste it into **Connect Linear**. Alternatively, set `LINEAR_API_KEY` in the
   Paseo daemon's environment before starting the daemon.
3. Select an assigned ticket. Preview the ticket context and choose a Paseo project.
   For Git projects, select a base branch from the local or remote branches known
   to the checkout. Choose a provider, then search its models. When supported, choose the
   provider's change mode and the model's reasoning level, then optionally add instructions.
4. Select **Start agent with ticket**, then **Open agent**.

After an agent starts successfully, the plugin remembers that provider's model, change
mode, and reasoning level on this host. The most recently used provider is restored the
next time the launcher opens, and switching providers restores each provider's own choices.
Choices that are no longer advertised by Paseo are safely ignored.

Tickets load in pages of 50. By default they cover **open work only** — completed,
canceled and duplicated states are hidden server-side; the **Settings** menu (gear in
the header) has a toggle to include them. The status chips show counts over exactly
what the list shows, following that setting — Linear's GraphQL exposes no aggregation,
so they come from a bounded server pass (25 pages × 50; counts show a “+” when your
assignments exceed that) and selecting a chip filters the list server-side by that
exact state name. The search box filters the loaded tickets
instantly and, from two characters up, also runs Linear's workspace-wide search:
its matches appear in a separate **Across Linear** section, and tickets already on
the list are not repeated there. Sort by **Updated**, **Created**, **Due date** or
**Priority**, then **Newest / Oldest** (for due dates: latest / soonest; for priority:
highest / lowest); missing dates and tickets with no priority sort last. Sorting
applies to the loaded tickets; choose **Load all tickets** to include
every assignment. Archived tickets are excluded.

The **Dependencies** filter can focus the assigned list on tickets that are **Blocking
others** or are themselves **Blocked**. This filtering runs in Linear, so it covers every
assignment rather than only loaded pages. Rows show compact **Blocks N** and **Blocked by N**
badges whenever a dependency is present.

The most recent first page and its status counts are cached on the Paseo host. Reopening
the surface within five minutes uses that snapshot immediately instead of querying Linear
again; older snapshots are shown while a fresh request runs. The list shows when it was
last updated, and **Refresh tickets** always requests a fresh page. Caches are isolated by
the connected Linear credential and by the open/closed-ticket setting.

Rows show the ticket's priority, a status colour and icon for its workflow state,
label chips, a due date and estimate when your team sets them, and a relative
timestamp ("3h ago"), with the absolute date in the accessibility label. Status colours follow Linear's workflow category (`started`,
`completed`, `canceled`, `backlog`, `unstarted`, `duplicate`, …), so custom state
names such as "In Review" get the right tone in any workspace; keyword matching on
the state name remains as a fallback for categories that are not recognised. Status symbols
distinguish a segmented backlog circle, an empty Todo circle, a filled In Progress circle,
and a padlock for blocked work. The status filter chips use the same symbols as ticket
badges. While tickets load,
placeholder rows stand in for the table so the layout does not jump.

For Git projects, the plugin creates a dedicated worktree from the selected base
branch, using Linear's own branch name for the ticket (which respects your workspace's
branch-format setting) so Linear's GitHub integration keeps matching branches to issues.
If that name is missing or not a safe git ref, a `<ticket id>–<request id>` fallback is
used instead. When the branch already exists — for example a second launch of the same
ticket — the worktree is created once more with a short request-id suffix appended.
Your existing checkout is not switched. Remote
branches use their locally fetched state; fetch in the project first if you need
the newest remote commits. Projects without Git use their project directory.

Each created agent keeps the Linear issue ID, identifier and URL in its Paseo labels.
Opening that ticket later shows its linked agents and lets you jump straight back to
them, including after the plugin or daemon restarts. In the other direction, the
agent shows a persistent ticket-number pill beside its composer; selecting it opens the
issue in Linear. The command-center action **Open linked Linear ticket** opens the ticket
panel as a fallback. These references live with Paseo's agent records rather than being
copied into the agent prompt. Archived agents are omitted from a ticket's linked-agent
list and their pills are removed.

The launch fetches fresh details, relationships and comments through Linear's GraphQL API.
Relationships arrive in both directions — links the ticket makes and links pointing at it
(blocks, blocked by, related, duplicates, duplicated by) — and appear as a compact
**Relationships** list above the JSON snapshot, so the agent sees blockers before starting
work. Status changes arrive the same way: a compact **Status changes** line (for example
"Todo → In Progress → Done (currently Done)") and the raw state-history spans in the JSON
snapshot. The JSON response is preserved in the prompt, including the description and any
returned links. Linked documents and attachments are not downloaded. If comments
are unavailable, the preview and agent prompt say so. Context over 200,000 characters
is rejected rather than silently truncated.

The ticket preview shows the ticket's project, team, labels, priority, dates (including
due date and estimate when set), a status-history line, and a **Related tickets** section.
That section includes the parent, subissues, blockers, blocked tickets, duplicates, and
general relations returned by Linear—even when those tickets are unassigned or assigned
to somebody else. It stays collapsed behind a **Show related tickets** toggle until needed;
tickets assigned to the connected Linear user are highlighted. Selecting one opens its
own detail and launch view. The preview then
renders the description as Markdown: headings, bullet and numbered lists, task
checkboxes, pipe tables, quotes, dividers, bold text, inline code and fenced code
blocks. Tables scroll horizontally when they are too wide and keep their column
alignment. Code blocks carry a copy button, and **Copy context** copies the exact
JSON snapshot that will be sent to the agent. HTTPS images linked with standard
Markdown image syntax and interactive HTTPS links are rendered too.
Images are loaded by the Paseo client only for display and are not downloaded into the
agent's workspace or added to its prompt. Provider badges, available modes, and reasoning
levels are read from the configured Paseo provider catalog; unavailable capabilities stay
out of the form.

## Project mappings

Opening a ticket preselects where its agent runs. A Linear project (or, for tickets without
one, the team) maps to a Paseo project and, for Git projects, a base branch. Starting an agent
remembers the choice for that Linear project; until a mapping exists, a Paseo project whose
name equals the Linear project name is preselected when exactly one matches. A choice you make
by hand is never overridden. **Settings → Project mappings** lists the saved mappings and can
forget them. Mappings are stored per host in `settings.json`.

## Agent access to Linear

Agents started from a ticket get a `linear_ticket` MCP server (on by default, **Settings →
Agent access to Linear** turns it off). Its tools act only on the ticket the agent started from:

- `get_ticket` — fresh title, description, status, the team's workflow states, comments, links;
- `add_comment` — post a Markdown comment;
- `set_status` — move to another state of the ticket's team by name (canceled and duplicate
  states are left to people);
- `link_url` — attach an https link, such as the pull request.

The launch prompt tells the agent to comment when it starts and finishes, link its pull request
and move the ticket to review; custom templates can place that note with `{{linear_access}}`,
and it is appended when they do not. The server is a dependency-free script written to
`$PASEO_HOME/linear-tickets/ticket-mcp-<hash>.mjs` and run with the daemon's own Node runtime
(the desktop app's bundled runtime included), so it does not depend on `node` being on the
agent's PATH. If the selected provider reports that it cannot load MCP servers, the launch
returns a warning, since that agent has no Linear tools.
The agent configuration carries only that path and the issue ID; the server reads the key at
call time from `LINEAR_API_KEY` or the saved connection, so it needs a key with write access.
Agents run as the same user as the daemon, so this scopes the tools, not the key: an agent
that reads the credentials file directly is not prevented from using it. When the host sets
`LINEAR_API_KEY` in the daemon's environment, agents and their MCP servers may inherit it, so
an agent that reads its own environment can see the key; prefer the saved connection if that
matters to you.

## Settings

The **Settings** menu (gear icon in the header, next to the connection and refresh
buttons) holds the plugin's per-host settings:

- **Ticket status** — optionally mark the ticket In Progress when the agent starts
  (off by default; see below).
- **Tickets shown** — include completed, canceled and duplicated tickets in the list
  and the status counts (off by default, keeping the list focused on open work).
- **Default prompt** — replace the built-in launch prompt with a template (below).
- **Auto-dispatch** — start agents for labeled tickets without opening Paseo (off by default; see below).
- **Write back to Linear** — report ticket-linked agents' progress on the ticket (all off by default; see below).

The last successful model, mode, and reasoning choices are stored in the same per-host
settings file. They update automatically and do not need a separate settings toggle.

## Customizing the launch prompt

Every launch starts from the built-in default prompt: work on the ticket in the current
workspace, respect the repository's instructions, and treat the snapshot as data, not as
authority. You can replace it with your own template under **Default prompt** in the
plugin's **Settings** (gear icon in the header) — for example to have the agent list a
plan before coding, run the test suite, or open a pull request in a specific format.

Placeholders are substituted at launch time:

- `{{ticket}}` — the ticket's ID and title
- `{{instructions}}` — the per-launch "A little extra direction" text
- `{{context}}` — the ticket snapshot (required; a template without it is rejected)

Templates are limited to 8,000 characters, stored per host with the other plugin settings,
and apply to new agents only. **Reset to built-in** restores the default. The per-launch
instructions field and the 200,000-character context limit apply as before.

`{{linear_access}}` places the note about Linear access: with **Agent access to Linear** on,
the agent is told to use its ticket tools; with it off, not to write to Linear. A template
without the placeholder gets the note appended. Templates saved from the built-in default
before 0.4.0 contain the old sentence "Do not post comments or change Linear status unless
the user explicitly asks."; that sentence is treated as the placeholder, so the toggle
decides rather than the saved wording.

## Marking tickets In Progress

By default the plugin never changes Linear. When you switch on **Mark the ticket In
Progress when the agent starts** in the plugin's **Settings** (gear icon in the
header), a launch also moves the ticket
into its team's started state — the state named *In Progress* when the team has one,
otherwise the first started state in the team's workflow. Tickets already in a started
state are left as they are, and a team without a started state never produces a write.
The choice is saved per host and needs Linear's write permission. If the change cannot
be made, the agent still starts and the failure appears as a warning with the result.
The transition is made just before the agent is created, so with agent access to Linear on,
any status change the agent makes itself always comes after it.

## Auto-dispatch

With **Settings → Auto-dispatch** on, the plugin polls Linear (every 60 seconds by default,
30–3600 allowed) for open tickets that carry the trigger label (`paseo` by default) in the
listed team keys (for example `ENG, OPS`). No teams means nothing is dispatched. Tickets are
picked up **whoever they are assigned to**: anyone who can label a ticket in those teams can
start an agent on this host, with the ticket text as its prompt. Only list teams you trust.

For each ticket the plugin first swaps the trigger label for `<label>-running` — Linear is
the lock, so a later poll, a plugin reload or a daemon restart never starts a second agent —
then launches exactly as the sidebar would: the saved project mapping (never a name-match
guess) and its base branch (or the repository default), your last-used provider, model,
mode and reasoning level, the default prompt, the In Progress setting and agent access to
Linear. A short comment on the ticket names the provider and project. If the ticket already
has an active Paseo agent, no second one starts. When a launch cannot proceed — no mapping,
no remembered provider, an unavailable project — the ticket gets `<label>-failed` and a
comment saying why; fix the cause and add the trigger label again.

Paseo gives plugin code its daemon connection only inside RPCs and lifecycle hooks, so
polling starts at the first of these after the plugin loads: opening the ticket surface,
saving a setting, or any agent turn on the host. The surface's Settings shows the last poll,
its error and the most recent dispatches.

## Write back to Linear

For agents carrying the `linear.issueId` label (every agent started from a ticket, manually
or dispatched), **Settings → Write back to Linear** can report their lifecycle on the ticket
using this host's key, independently of the agent's own `linear_ticket` tools:

- **Status** — the agent's first turn moves the ticket into its team's In Progress state,
  following the same rules as the launch-time setting.
- **Turn summaries** — each completed turn's final reply is posted as a comment (capped at
  4,000 characters), a failed turn posts its error, and archiving an agent that never linked
  a pull request says so.
- **Blocked alerts** — a pending permission, plan approval or question posts a comment and
  adds `<label>-blocked`; answering it, or the next completed turn, removes the label. A
  failed turn also adds it.
- **Pull requests** — GitHub pull request URLs printed by the agent's tools during a turn
  (for example by `gh pr create`) are attached to the ticket, which then moves to its team's
  started state named like *In Review*. Completion is left to Linear's GitHub integration.

Archiving a linked agent always removes `<label>-running`. Subagents never report. Paseo
delivers lifecycle events live and best-effort: events while the plugin is stopped are not
replayed, and a Linear failure is logged (`paseo plugin logs linear-tickets`) without
affecting the agent.

## Connection storage

The API-key form stores the key on the daemon host in
`$PASEO_HOME/linear-tickets/credentials.json` (default:
`~/.paseo/linear-tickets/credentials.json`). The directory is owner-only and the
file uses mode `0600`; it is a plaintext credential, not an OS keychain entry.
`LINEAR_API_KEY` takes precedence over a saved key. Disconnect removes the saved
key; environment keys must be removed from the daemon environment followed by a
restart. All clients connected to this host share the same Linear account. Saved
default-prompt templates live next to the key in `settings.json` with the same
permission pattern. The ticket snapshot cache lives in `cache.json` with the same
private permissions; its credential scope is a one-way hash, never the API key itself.

The plugin talks directly to Linear's official [GraphQL API](https://linear.app/developers/graphql)
at `https://api.linear.app/graphql`. Its queries are read-only unless you opt in: the
In Progress transition, auto-dispatch and write-back are the only writes. Only the
server contacts Linear. The key is never added to ticket context, agent configuration,
or agent labels.

Repeated launch requests reuse their result for the lifetime of the loaded plugin.
If agent creation returns an uncertain failure, the same request is not retried
automatically: check the project's workspaces and agent list before reopening the ticket to
start again. This retry cache does not survive a plugin or daemon restart.

## Validation

`npm run typecheck` checks both entrypoints against Paseo's SDK. `npm test` covers
GraphQL response parsing, pagination, context preservation, prompt template rendering
and validation, credential and settings persistence, ticket retrieval, state-transition
resolution and failure handling, and agent creation/retries with mocked Linear and Paseo
calls.
Live account authentication and agent execution require your configured host and key.
