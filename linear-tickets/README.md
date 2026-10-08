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

## GitHub automation identity

Hosts can install `scripts/github-router.mjs` as their `gh`, `git` and `gt` shims.
Paseo agents and daemon children use `bot112112121` for GitHub-visible changes:
PRs, comments, labels, reviews, ready/merge operations and Git pushes. Read-only
GitHub API calls share the bot and owner's independent REST/GraphQL budgets,
choosing the account with more capacity after a reserve of 750 bot requests and
300 owner requests. Search has its own smaller reserve. Budget probes are cached
for one minute; admission is serialized across processes. Outstanding reads remain
reserved when a concurrent write refreshes the budget. The router never retries
a write under the owner's identity.

Manual commands outside the Paseo process tree keep their existing GitHub and
Graphite authentication. Agent attribution is recovered from ancestor processes
when a Python kernel loses `PASEO_AGENT_ID`; the per-agent 60 GraphQL reads/hour
limit and existing restrictions on check polling apply on either account.

Native `gh api` pagination admits and records each page separately, including
GraphQL cursor pages, without changing the CLI's `--jq`, `--slurp` or template
formatting. Cached REST responses do not spend another request. Search and code
search use their own quotas, not the core REST allowance. Write credentials are
verified against the bot identity and the exact verified token is used, so a
credential rotation cannot silently publish under the owner's account.

### Host setup

Before installing, authenticate GitHub CLI as the bot in `$PASEO_HOME/gh-bot`
(`PASEO_HOME` defaults to `~/.paseo`) and place the bot's **Graphite CLI token** in
`$PASEO_HOME/graphite-bot/token` (directory mode 0700, file mode 0600). A GitHub token
cannot replace a Graphite token. The bot must have a Graphite account and repository
access; Team-plan queues require PR authors to have Graphite accounts. Do not
change billing without the account owner's approval.

```sh
node scripts/install-github-router.mjs
paseo plugin reload linear-tickets
```

The installer verifies both bot identities before changing any command path.
It installs shims in `~/.local/bin`, saves real executable paths and backs up replaced
commands under `$PASEO_HOME/github-router/backups/`. Put `~/.local/bin` first on
the agent/daemon PATH. The plugin does this for its queue and manual-check children.
Its direct `gh` calls prefer the installed shim; `LINEAR_TICKETS_GH` can name a
custom CLI. A custom path alone does not imply two-account budgeting: set
`LINEAR_TICKETS_GITHUB_ROUTED=1` only when that CLI implements the router contract.
Without the router, portable installations retain single-login quota admission.

GitHub SSH Git URLs are rewritten to HTTPS only in automated child processes.
Git uses the bot credential helper, without changing global Git configuration or
commit author fields.
Inherited OpenSSH host aliases are inspected before transfer; aliases targeting
GitHub and unsupported custom SSH launchers fail closed. Inspected non-GitHub
SSH destinations retain their existing authentication and configuration.

Graphite receives the bot token through its documented
`GRAPHITE_AUTH_TOKEN` override, checked with `gt auth`; missing or wrong credentials
fail closed. Merges still use the repository's documented Graphite queue, never a
`gh pr merge` bypass where the queue is required.

This is command routing, not a sandbox: explicit calls to unguarded binary paths
or programs supplying their own credentials bypass these shims. Invoke `gh`,
`git` and `gt` through the installed PATH. Safe attribution (no tokens or bodies)
is recorded in `$PASEO_HOME/github-router/calls.jsonl`; quota snapshots contain no
credentials. Roll back source changes with a revert PR and reinstall that version;
the host backup manifest also records pre-install command paths for recovery.

## Connect and start work

1. Create a personal Linear API key in Settings → Security & access, with access to the
   relevant teams. Browsing tickets needs read permission only; the plugin's writes need write
   permission (with the [Paseo app](#native-linear-agent) installed, the key writes only in the
   cases listed under [Who Linear shows as the author](#who-linear-shows-as-the-author)).
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
canceled and duplicated states are hidden server-side; the Paseo Agents menu bar app's
Control panel has a toggle to include them. The status chips show counts over exactly
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

**Finished blockers.** When a ticket starts after blockers that are finished (see *Waiting their turn*), its prompt gets a
**Finished blockers** section after the instructions: for each one, its links (pull requests,
plan documents; not the Paseo agent link) and its latest comments, newest first, up to 6,000
characters per blocker and 24,000 in total. The plugin's progress and final-report cards,
Linear's agent-thread stub and plan-approval questions are left out, so the room goes to the
agents' own summaries. The agent is told to build on that work and to check that its base
branch contains the merged changes. Blockers that still hold the ticket back never reach this
point. If Linear cannot be read, the agent starts without the section
and the launch warns.

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
by hand is never overridden. The Paseo Agents menu bar app's **Control panel → Project mappings** lists the saved mappings and can
forget them. Mappings are stored per host in `settings.json`.

## Worktree shards

By default every ticket of a repository gets its worktree from the same git directory, and the
Paseo daemon watches that directory: every filesystem event in it (git and Graphite rewrite
`config`, take `packed-refs.lock`, drop temporary files) costs the daemon work proportional to the
number of worktrees sharing it. On a repository with hundreds of live worktrees those events pile
up and the daemon stalls, taking the app, the relay and the plugins with it.

Worktree shards split a repository's ticket worktrees across independent clones, each with its own
git directory (its own refs, config, hooks and remotes), dividing that cost by the number of
shards. Every clone is registered as its own Paseo project, and the plugin assigns a new ticket to
one of them instead of always using the mapped project:

- A ticket whose work already exists in a clone keeps that clone: the worktree a follow-up
  continues, its recorded worktree (the handover record), or its own branch as a local ref.
- A ticket that stacks on, or is blocked by, another ticket's work goes to the clone that holds
  that work: the parent sub-issue's or the blocker's recorded worktree, or the base branch when
  only one clone has it as a local ref. Local branches and Graphite metadata exist in one clone
  only, so a stack whose lower branches live elsewhere would find neither.
- A launch that already names one of the clones (a project picked by hand) keeps it.
- Everything else goes to the clone with the fewest registered worktrees, so new tickets build up
  in the least loaded clone. Ties break on a stable hash of the ticket, so a retried launch lands
  in the same clone.

Tickets with worktrees in the original repository keep the original; nothing is migrated. Before a
new ticket branches off a clone that has not fetched for ten minutes, the plugin fetches it, so the
new branch starts from the current base branch. A clone that cannot be read or fetched is skipped
with a warning on the launch, and a failed assignment keeps the mapped project: the setting never
blocks a launch.

Off by default, enabled per host through `linear.set-settings` (`worktreeShards`) or in
`$PASEO_HOME/linear-tickets/settings.json`:

```json
"worktreeShards": {
  "enabled": true,
  "pools": {
    "/home/mirko/paseo/tuchel-platform-git-source": [
      "/home/mirko/paseo/tuchel-platform-2",
      "/home/mirko/paseo/tuchel-platform-3",
      "/home/mirko/paseo/tuchel-platform-4"
    ]
  }
}
```

`pools` maps the root path of the Paseo project a Linear project's mapping points to (the
original, as this host sees it) to its clones' root paths; each clone must be registered as a Paseo
project on the same host. The clones are plain `git clone --reference` copies of the original's git
directory: they borrow its objects and keep their own branches, remotes and Graphite stack
metadata. Each clone is its own repository for its agents, so its `git config` (identity, rerere),
its lefthook hooks and its Graphite trunk are set up like the original's.

## Agent access to Linear

Agents started from a ticket get a `linear_ticket` MCP server (on by default, the Paseo Agents
menu bar app's **Control panel → Agent access to Linear** turns it off). Agents read all of
Linear; write scope depends on how an issue relates to the ticket the agent started from.

Every managed ticket/planner tool request uses the host's private Linear broker and the same
app/key request and complexity budget as the plugin. Agent work leaves the last **5%** for
owner decisions. A hold never switches to the owner's key. `initialize` and `tools/list` stay
local. With no broker, tools fail closed: no direct Linear access or endpoint override.
An interrupted submitted request says it **may have completed**; check the ticket before retrying
a write. Multi-request tools can still partly complete before a later hold.


| Scope | Write (as Paseo) |
| --- | --- |
| The agent's own ticket | comment, status, links, relations, manual tasks |
| Issues the agent created with `create_issue` | comment, status, links, relations, title and description |
| Any other issue | comment and relations only |

Deleting or archiving issues, changing another issue's status, assignee or priority, and project,
team or label settings are not possible. The server checks every target itself, so the limits hold
whatever the agent is told. Its tools (`issue` is an identifier such as `ENG-123`; omitted, the
agent's own ticket):

- `get_ticket` — fresh title, description, status, the team's workflow states, comments, links;
- `get_issue` — any issue: text, status, project, labels, parent, sub-issues, relations,
  comments, links, and what the agent may change on it;
- `search_issues` — full-text search over all issues;
- `add_comment` — post a Markdown comment, on any issue;
- `set_status` — move the ticket (or an issue the agent created) to another state of its team by
  name; a canceled or duplicate state needs a `reason`, posted on the issue before the move;
- `link_url` — attach an https link, such as the pull request;
- `add_relation` — relate the ticket (or an issue the agent created) to any issue: related,
  blocks, blocked by or duplicate of;
- `create_issue` — file a follow-up, related to the ticket (or blocking it, or blocked by it), or a
  sub-issue of it. It is created in the team's Todo state and the ticket's project, so the usual
  pickup applies: a project that carries the dispatch label plans it, otherwise it waits in Todo.
  A repeated title returns the issue already filed, and an agent files at most 10 issues per
  ticket. Created issues are recorded under `$PASEO_HOME/linear-tickets/agent-issues/<ticket>/`;
- `update_issue` — change the title or description of an issue the agent created;
- `add_manual_task` — register a step only a person can do; see [Manual tasks](#manual-tasks).

The agent closes its own ticket, so finished work never waits on you: once the ticket meets its
definition of done it moves it to Done, unless a merged pull request already closed it. That
covers work outside a repository and pull requests that only mention the ticket ("Part of"),
which close nothing on their own. A step left for a person becomes a manual task and does not
keep the ticket open. Work that turns out unnecessary (already done, obsolete, a duplicate) is
moved to Canceled or Duplicate with the reason. Agents limited to planning never close a ticket.

The launch prompt tells the agent to comment when it starts and finishes, link its pull request,
move the ticket to review, register every manual step as a manual task and close the ticket as above; custom templates can place that note with `{{linear_access}}`,
and it is appended when they do not. The server is a dependency-free script written to
`$PASEO_HOME/linear-tickets/ticket-mcp-<hash>.mjs` and run with the daemon's own Node runtime
(the desktop app's bundled runtime included), so it does not depend on `node` being on the
agent's PATH. omp cannot load MCP servers, so an omp agent gets the server's command in
`LINEAR_TICKETS_MCP` instead, and the plugin's omp extension (`omp/linear-tickets-plan-first.ts`,
installed as described under **The omp extension** in [Native Linear agent](#native-linear-agent))
mounts the same tools as `linear_ticket_<tool>`, running each call
through the script. The read tools are direct tools, so they also work while Plannotator's
planning phase refuses every `xd://` call. Without the extension, and for any other provider that
cannot load MCP servers, the agent starts once more without the server and with the no-write note
instead of `{{linear_access}}`, and the launch returns a warning, since that agent has no Linear
tools. The agent configuration and environment carry only that path and the issue ID; no
credential is put into them.

### Who Linear shows as the author

Everything the plugin and the `linear_ticket` tools write (comments, status moves, labels, links,
new sub-issues, reactions, plan documents) is sent with the [Paseo Linear app](#native-linear-agent)'s
token, so Linear's history shows **Paseo**, not you. Your own comments stay yours, so they
still steer agents ([Replies from Linear](#write-back-to-linear)). The `linear_ticket` server reads the app's token from
`agent-app/token.json` on every call; only the daemon refreshes it (ten minutes before it expires,
checked every five minutes), so a running agent always picks up the current one. Manual tasks are
still assigned to you: the server reads your user ID with the API key, whoever writes.

The API key still writes in three cases:

- **Handing a ticket to Paseo** (delegation) stays your instruction, because Paseo only accepts
  Linear agent sessions that you start.
- **Editing a comment the key wrote** before this change: Linear lets only a comment's author edit
  it. Attachments and documents the key wrote, the app may change.
- **Fallback when the app cannot be used** on this host: it is not installed, its token cannot be
  refreshed, or Linear rejects it even after a refresh. Linear authenticated nothing then, so the
  write goes out with the key and shows your name; the daemon logs `the Paseo app is not usable on
  this host; Linear writes appear as the key's owner` once, and the plugin's health check (see
  **Health** under [Native Linear agent](#native-linear-agent)) raises its alert ticket while the
  installed app is broken. Every other failure (a refusal, rate limit, invalid input, outage) is
  reported and never retried with the key, so nothing is written twice or under your name by
  mistake.

So the key needs write access. Agents run as the same user as the daemon, so this scopes the
tools, not the credentials: an agent that reads the credentials or token file directly is not
prevented from using it. When the host sets `LINEAR_API_KEY` in the daemon's environment, agents
and their MCP servers may inherit it, so an agent that reads its own environment can see the key;
prefer the saved connection if that matters to you.

### Other Linear tools

A coding tool's own Linear connection (for example omp's Linear MCP server, signed in as you)
writes as you. Ticket agents running omp may use only its read tools (`get_*`, `list_*`,
`search_documentation`, `extract_images`, listed by name in
`omp/linear-tickets-plan-first.ts`): the plugin's omp extension blocks every other tool of that
server, called directly or through its `xd://` device, and tells the agent to use the
`linear_ticket` tools instead. It guards against mistakes, not against an agent that sets out to
get around it; other providers are not covered.

## Settings

The plugin's per-host settings live in the Paseo Agents menu bar app's Control panel,
which reads and saves them through the plugin's `linear.get-settings` / `linear.set-settings`
(and `linear.get-default-prompt` / `linear.set-default-prompt`) RPCs; its status lines come from
`linear.dispatch-status` and `linear.agent-status`. The sidebar no longer
has a settings view; it keeps the Linear connection (the **Connection** button), the ticket
list and the launch flow.

- **Ticket status** — optionally mark the ticket In Progress when the agent starts
  (off by default; see below).
- **Tickets shown** — include completed, canceled and duplicated tickets in the list
  and the status counts (off by default, keeping the list focused on open work).
- **Agent access to Linear** — give ticket agents the `linear_ticket` tools (on by default; see [Agent access to Linear](#agent-access-to-linear)).
- **Project mappings** — the saved Linear project → Paseo project mappings, each with Forget (see [Project mappings](#project-mappings)).
- **Default prompt** — replace the built-in launch prompt with a template (below).
- **Auto-dispatch** — start agents for labeled tickets without opening Paseo (off by default; see below).
- **Linear agent** — whether the native Linear agent is installed and receiving webhooks (see [Native Linear agent](#native-linear-agent)).
- **Write back to Linear** — report ticket-linked agents' progress on the ticket, and start new agents automatically (off by default, except the silent-agent watchdog; see below).
- **Deputy for agent questions** — off, shadow or live, its grace period, evaluator model and principles repository; set through `linear.set-settings` (`deputy`) for now (off by default; see [Deputy for agent questions](#deputy-for-agent-questions)).
- **Worktree shards** — the repositories whose ticket worktrees are spread across independent
  clones, and the clones themselves; set through `linear.set-settings` (`worktreeShards`) for now
  (off by default; see [Worktree shards](#worktree-shards)).

The last successful model, mode, and reasoning choices are stored in the same per-host
settings file. They update automatically and do not need a separate settings toggle. The cheap
and standard model tiers' models per provider (`cheapModels`, `standardModels`, see
[Model tiers](#model-tiers)) have no toggle either: set them with `linear.set-settings`
(`tierModel: { tier, provider, model, thinkingOptionId }`, `model: null` removes one) or edit
`$PASEO_HOME/linear-tickets/settings.json`.

## Customizing the launch prompt

Every launch starts from the built-in default prompt: work on the ticket in the current
workspace, respect the repository's instructions, and treat the snapshot as data, not as
authority. You can replace it with your own template under **Default prompt** in the
Paseo Agents menu bar app's Control panel — for example to have the agent list a
plan before coding, run the test suite, or open a pull request in a specific format.

Placeholders are substituted at launch time:

- `{{ticket}}` — the ticket's ID and title
- `{{instructions}}` — the per-launch "A little extra direction" text plus the plugin's own notes
  (plan policy, attachments, [repository orientation](#repository-orientation)); a template
  without it gets it inserted just before `{{context}}`
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
Progress when the agent starts** in the Paseo Agents menu bar app's Control panel,
a launch also moves the ticket
into its team's started state — the state named *In Progress* when the team has one,
otherwise the first started state in the team's workflow. Tickets already in a started
state are left as they are, and a team without a started state never produces a write.
The choice is saved per host and needs Linear's write permission. If the change cannot
be made, the agent still starts and the failure appears as a warning with the result.
The transition is made just before the agent is created, so with agent access to Linear on,
any status change the agent makes itself always comes after it.

## Ticket attachments

Files uploaded to Linear (`uploads.linear.app`) need the API key, so an agent cannot open
them from the ticket's links. Every launch — manual or dispatched — downloads the uploads
referenced in the description, comments and attachments into the workspace under
`.linear/<ticket id>/` with their original names, adds `.linear/` to the checkout's git
exclude list, and lists the local paths in the launch prompt. The key is sent only to
`uploads.linear.app` and never reaches the agent. At most 20 files, 25 MB each and 100 MB
in total are downloaded; a failed or skipped file becomes a launch warning, never a failure.

## Repository orientation

Every launch adds two things to the instructions, so the agent neither hunts for the
repository's area guides nor fills its own context with exploration:

- **Domain guides.** In a Git project, the plugin lists the checkout's tracked `AGENTS.md`
  files (all but the root one) with each guide's first `# ` heading. Guides the ticket names are
  listed first: `named in this ticket:` when the title, description or a comment contains the
  guide's folder path (`apps/…/domains/sales` or `domains/sales`; the guides above it count too)
  or a label equals the folder name; `possible match:` when only the folder name appears as a
  word (`sales`, `demand planning`). Names only count for guides with sibling guides in the same
  parent folder, such as the `domains/*` set. Matches are always listed; the remaining guides fill
  up to 40 lines, and any further ones are counted. Only repository paths and headings are
  written, never ticket text.
- **Scout delegation.** After brief inline scoping, the agent delegates broad exploration to
  read-only subagents in the same workspace (omp: `task` with the `scout` agent; Claude: the
  Explore subagent; others: whatever their harness offers), asks them to cite the file and line
  behind each claim, checks every claim it acts on in that file, and reads the files it changes
  itself.

A guide that cannot be read is listed without its heading, and a failed `git ls-files` drops
the list; both become a launch warning, never a failure. Non-Git projects get the scout
sentence only.

## Native Linear agent

With a private Linear OAuth app named **Paseo** installed (`actor=app`), you can assign a ticket
to Paseo or @mention it, and the whole conversation runs in Linear's agent panel on the ticket:
- a "thinking" update within a second,
- the commands the agent ran and its replies,
- option buttons for its questions, and Approve/Deny for actions that need permission,
- the plan as a checklist, with Approve plan / Send back deciding the Plannotator review directly,
- Stop, which interrupts the running turn,
- links to the plan review and the pull request.

A delegation starts an agent exactly like the label: the saved project mapping and remembered
provider are used, and the agent gets the label `linear.sessionId` next to `linear.issueId`. A
mention on a ticket whose agent is running passes the text to that agent instead. Label and
sidebar launches open a session too and then delegate the ticket to Paseo, so every ticket with
an agent names Paseo however it started. Only the workspace owner (the user of the plugin's
personal key) can start or steer agents; sessions from anyone or anything else get an error.
The app is also the author of everything the plugin and its agents write in Linear; see
[Who Linear shows as the author](#who-linear-shows-as-the-author).

**Setup**
1. In Linear → Settings → API → Applications, create an app "Paseo":
   - redirect URI `http://localhost:47832/callback`,
   - webhooks on, URL `https://<machine>.<tailnet>.ts.net:8443/linear/agent`, categories *Agent session events* and *Permission changes*.
2. Put `{"clientId","clientSecret","webhookSecret"}` into `$PASEO_HOME/linear-tickets/agent-app/app.json` (mode 0600).
3. Install the app with `actor=app` and the scopes `read,write,app:assignable,app:mentionable`, and store the token response as `token.json` next to it.
   The plugin refreshes it with the refresh token.
4. Allow Tailscale Funnel for the machine.

The plugin receives webhooks on `127.0.0.1:47831` and publishes only `/linear/agent` on port
8443 with `tailscale funnel` (never 443). Each webhook is checked for its HMAC signature and a
timestamp newer than 60 s, answered at once, and deduplicated. The minute sweep is the fallback
for what a webhook did not deliver: a session Linear has webhooked for is re-read on a 5-minute
cadence instead of every minute, and a webhook whose read is due pulls that read forward to the
webhook. A session it never webhooked for, or without one for over 5 minutes, is read every minute
as before, so a missed webhook costs what the sweep always cost and no reply is missed (see
[Rate limits](#rate-limits) for what that saves and how it is measured); the sweep also picks up a
new thread Linear already marked stale because this host was down when it arrived (up to two hours
old, unless the ticket got a newer thread since). Ordinary failures skip only the affected sweep
part or thread. A rate limit stops the part with one pause log; while the app's background budget
is paused, the whole sweep is skipped until it refills.
The Paseo Agents menu bar app's **Control panel → Linear agent** shows the state.

**Several hosts.** Each host that runs the plugin installs its own app (for example "Paseo" on the
laptop, "Paseo Server" on a server), with its own webhook URL on that host's Funnel and its own
`app.json`/`token.json`; never copy `token.json` to a second host, because each refresh rotates
the token the other host still holds. By default, a ticket delegated to (or mentioning) an app
runs on that app's host. The sweep takes only its own app's threads, since Linear lists every
app's sessions to each of them. Keep `dispatch.enabled` on one host only. Without activation
routing, the label poll and project flow cannot see another host's agents.

**Drain one host into another.** Activation routing lets the old host keep its Linear app and
threads while sending new work to the destination. In the old host's
`$PASEO_HOME/linear-tickets/settings.json`, set:

```json
{
  "activation": {
    "mode": "remote",
    "peer": "https://server087.example.ts.net:8444"
  }
}
```

The destination uses `"mode": "local"` and a `peer` pointing back to the old host's tailnet
review inbox. Put the same secret in both hosts'
`$PASEO_HOME/linear-tickets/activation-secret` files, mode `0600`; it is never returned by the
settings RPC. These requests use the tailnet-only review service, not the public Linear webhook.
Before enabling drain mode, write `$PASEO_HOME/linear-tickets/activation-allowlist-seed.json`
on the old host: `{"agents":[{"agentId":"<existing root>","issueId":"<issue UUID>","identifier":"TUC-123"}]}`.
Only those roots are grandfathered; the list is seeded once and never grows on reload. An empty
list keeps none. A malformed list holds new work without starting or forwarding it. Without the
file, the initializer discovers existing non-archived ticket roots once; use an explicit list
when the daemon has stale roots.

Deploy and reload the destination first, with its secret and local mode plus the old host's
peer URL. Until it receives its first claims snapshot it queues automatic starts. Then deploy
the old host, enable remote mode and reload. Authenticate `/activation/health` on both hosts
with `x-paseo-activation`; require a non-null `drain.seededAt`, an acknowledged claims revision,
and the matching `intake.claims` count before restoring destination dispatch. A local host with
no peer configured does not require this handshake.

The old host retains ownership of its grandfathered working or owner-waiting ticket agents.
Replies, questions and approvals for those agents stay local while their existing work finishes;
they are not stopped or moved. Ownership is registered durably on the destination, which does
not start a second agent for a claimed ticket. An offline old host blocks only its claimed
tickets, not unrelated new server work. Once an owner retires, later work goes to the destination.

A root keeps ownership across normal turn endings, idle waits and an open ticket thread whose
process was closed. It retires when archived, failed, confirmed as a processless ghost, its
thread closes, or its ticket completes or is canceled. Existing agents on the destination keep
their own replies and approvals even if the old host also claims that ticket; existing overlap
is not resolved by stopping workers. Resuming a retired ticket root on the old host is refused,
including a heartbeat or a manual resume; unrelated chats are unaffected.

New native threads, replies without a retained local owner, project work, parked-plan
implementations and automatic replacements go to the destination's normal start gate,
scheduler and plan policy. Old thread replies still reach the destination. New ticket starts
from the old host's sidebar are refused; select the destination host instead. Unrelated manual
Paseo chats are unchanged.

Routing governs Linear ticket activations, not unrelated Paseo schedules. Move fresh-agent
schedules separately and pause their old copies. Existing worker heartbeats can remain while
their tasks finish; retire those heartbeats when their worker retires. Preserve host-specific
analysis inputs when moving a scheduled job rather than substituting the destination's history.

Forwarded requests are persisted and deduplicated by their source IDs. If the destination is
unreachable or full, work stays queued; there is no local fallback. Replacement work retains
its branch and handover context and never silently starts on an unrelated fresh branch: a strict
resume travels with the source's handover snapshot — the recorded branch, its exact commit,
whether uncommitted changes are next to it and the handover text, never its worktree path. The
destination continues that branch only while it has it at exactly the recorded commit. A strict
resume launches only on that complete evidence: a snapshot missing the branch, the full commit
or the dirty state stays held. A partial re-send never enriches a snapshot-less entry, so a later
complete one still can. Dirty work, another commit, a branch that is not there, or no
complete snapshot -- including none at all -- keep the activation a queued handoff rather than
discarding the work, and the ticket says what to push or fetch (or that the sending host must
forward the recorded branch's exact commit and dirty state). A queued strict resume that arrived
without its snapshot (an older forwarding host) can be enriched in place: the same action
re-sent with the recorded branch's complete evidence fills the stored envelope, keeps its
identity, text and watchdog history, and runs once the branch is available; a finished activation
is never reopened and a stored snapshot is never replaced -- an entry an older host left with a
partial snapshot stays held. Every activation is processed from its current durable record, so a
pass that captured an older state can neither reopen a finished activation nor start a second
agent.
The destination acknowledges a forwarded activation after persisting it, then processes it
asynchronously. Delivery receipts avoid repeats after a lost HTTP response, and a message a host
passes to its own live agent -- the destination's intake, or the draining host for a ticket one of
its allowlisted agents still owns -- carries the activation id into the checked answer path
([Answers to agent questions](#answers-to-agent-questions)), whose record outlives the receipt: a
retry after a delivery whose outcome was lost is answered from that record instead of reaching the
agent twice, and a delivery Paseo does not confirm is reported unconfirmed, never repeated.
Delivering a message never changes the agents a host keeps.
Pending source activations are never evicted.


**In the panel.**
- The agent's commands and file edits show up while it works, merged at most every 4 seconds.
- Each session links **Open in Paseo** (the web app at app.paseo.sh opens the agent when that browser is paired with this host).
- Questions with several parts are asked one part at a time, and are answered together once all parts are in. "Other" options are not buttons: type your own answer instead.
- **Stop** interrupts the turn and keeps the agent stopped (a turn the provider starts by itself within 5 minutes is stopped again) until you reply.
- When a session exists, the plan review, its decision and pull-request review changes update the progress comment instead of adding comments. The panel's own messages are copied into the ticket thread by Linear.

**Plan-first.** Every ticket plans first, whatever launched it (sidebar, auto-dispatch,
delegation, mention) and however small it is. The only exception is a ticket carrying
`plan-ready`: its approved plan is implemented (below). There is no way to skip a plan: the old
`no-plan` label and the sidebar's Plan-first toggle are gone, and so is omp's `skip_plan`. The
prompt asks to keep the plan as short as the ticket allows.

**Overlap check.** Tickets are filed (by you, by agents, by intake) without a look at what else is
open, so every plan starts with one. The prompt has the agent search Linear's open tickets
(`search_issues`, or another Linear read tool), across every team and project and including work
in review whose pull request is not merged yet, for tickets that change the same feature, files or
data or already ask for the same thing, and read each candidate in full. The plan gets an
`## Overlapping tickets` section (each overlap and what the plan does about it, or "None found"
with the search terms). With [agent access to Linear](#agent-access-to-linear) on, real overlaps
are linked with `add_relation related` while the agent plans; a ticket another one fully covers
gets a plan that proposes closing it as that ticket's duplicate. A planner run gets its own
overlap instructions (see **Projects** below).

**Reach and principles.** A decision made in one ticket should apply everywhere it belongs and not
come back in the next one, so every plan carries two more sections before `## Risk and impact`, in
a fixed format ([`shared/plan-sections.ts`](shared/plan-sections.ts)):

```markdown
## Reach

- Changes: <the concept the ticket changes, not the page it names>
- <place>: include — AC-N
- <place>: follow-up — <title of the follow-up ticket>
- <place>: n/a — <reason>

## Principles and rules

- Applies: <IDs of the approved principles and ADRs | none apply — reason>
- Exceptions: <none | ID — why>
- New rule: <none — reason | the rule in one sentence — AC-N>
- Replaces: / Lives in: / Enforced by: / Existing violations:   (for a new rule only)
```

`## Reach` goes through every place the changed thing is used: workspaces, pages and roles, shared
components, existing records (data fix or backfill), exports, PDFs and labels, EDI, Business
Central, mail and notifications, help pages and German labels, permissions, seed and test data,
other repositories, and work outside the software. Each place gets one decision. When the right
behaviour per role is a business choice no approved principle covers, the planner asks you instead
of guessing. `## Principles and rules` names the rules the plan follows and whether it sets a new
one: where it lives, what it replaces, how it is enforced and what already violates it (`fixed
now` or `follow-up — <title>` lines). In tuchel-platform a new rule is a `Q-N` proposal in
`docs/principles/decision-queue.md`, never an approved principle. A plan rated impact 0–1 (the
higher of planner and advisor) may answer each section in one line ("Only the menu bar app,
because …"). Every `include` and every new rule name their own acceptance criterion (`AC-N`,
defined in the plan's verification), so the implementer cannot skip a place unnoticed: the omp gate
checks that each named criterion exists outside these two sections and that no two share one,
not that it really proves the place (that is the advisor's question and yours). Repository records
that describe the change (principles and decisions, glossary, process map, runbooks, env examples)
are not places: they ship in the pull request of the code they describe, under its criterion, so a
stack gets no records-only pull request. They are an `include` with a criterion of their own only
when no code changes, e.g. an owner decision (TUC-1644). Every
`follow-up` is filed as a ticket when the plan is approved (**Plan follow-ups** below). Every
ticket agent, the one that plans and then implements as well as one that implements an approved
plan later, is told to file a place the plan missed as a follow-up ticket (`create_issue`, related
to the ticket) instead of quietly doing more.

### Model tiers

Planning always runs on the launch model (the strong tier, e.g. Opus). The plan then picks the
tier its implementation runs on, in a required `## Model` section ([`shared/plan-model.ts`](shared/plan-model.ts)):

```markdown
## Model

- Tier: <cheap | standard | strong> — <why>
- Strong steps: <none | step numbers> — <why>
```

`cheap` is for well-specified work where every step is spelled out; `standard` for ordinary work
that needs more care than that but none of the strong reasons; `strong` needs a reason: work
spanning four or more layers, interface design, several call sites that must agree on one
computation, a gap between a check and the write it guards, or more than 15–20 files. A plan
rated (planner or advisor, the higher) above impact 2, not reversible by a revert, or with a
migration, an auth change or a new rule always takes `strong`. The omp gate refuses to record the
advisor review without a readable section or with a lower tier such a plan cannot take. The
GPT-6 Astra advisor checks the choice like the rest of the plan. A planner run's work order
carries no tier: each ticket's own plan picks one.

The section is never assumed. A ticket plan that reaches review without a readable section (or
with a tier its rating rules out) goes straight back to its planner with what to fix; neither the
owner nor the risk policy sees it. An approved plan without one, from before the section was
required, does not implement on a default tier: its agent (or the next one launched for it) goes
back to planning for the section only. When the resubmitted plan differs from the approved
document only by the added section, the plugin approves it without the owner; any other change is
reviewed like a new plan. A `model:` label or an earlier decided tier on the ticket is a tier and
skips this.

When the approved plan is implemented, the agent starts on the strongest of: the ticket's
`model:cheap` / `model:standard` / `model:strong` label (set by the plugin on approval; change it to
override), the ticket's latest decided tier (an approved plan or an escalation; an escalation
stays), and the plan's tier, which its risk rating raises to `strong` when a rule above requires
it. The cheap tier runs the provider's model in `cheapModels` (default for omp:
`deepseek/deepseek-flash`, thinking `max`), the standard tier the one in `standardModels` (default
for omp: `openai-codex/gpt-6.1-sol`, thinking `high`, on the OpenAI account rather than the launch
model's Claude account); a provider without one implements on the launch model. After
**Approve & split**, each sub-issue plans again and picks its own tier; a sub-issue of a strong
plan, or of a step the plan lists under `Strong steps`, gets `model:strong` first, so its own plan
cannot lower it.

On the cheap or standard tier, the agent hands the plan's strong steps to subagents on the strong
model (omp: `model: "@slow"`), and calls `escalate_model` with a reason when the same check still
fails after two honest fix attempts, the work needs judgment the plan did not settle, or a review
finds a design problem. The plugin then switches the agent to the strong model within seconds,
records the reason and posts it in the ticket's panel. Subagents cannot call it.

Worker allocation is slice-specific on **every** tier, including strong ticket owners. Keep
Opus ownership/planning, Astra advice and independent Sol review unchanged. Use the cheap worker
(OMP `task` without a model override; DeepSeek by default) for useful independent slices whose
interfaces, invariants and expected behavior are settled: prescribed validators/predicates,
established-pattern caller updates, settled behavioral fixtures, exact review fixes and specified
smoke checks. Give each worker exact writable scope, rules and an observable verification scenario.
A strong ticket, several files or careful execution alone does not justify `@slow`: the brief
must name unresolved design/diagnosis, authorization/identity/financial/solver decisions,
concurrency/recovery/external-effect boundaries or substantial rescue. New decisions and failures
after two honest fix attempts return to the owner, who integrates and verifies; trivial or tightly
coupled edits need no forced delegation. This is an instruction policy, not a tool-enforced model
restriction, and does not change the existing tier maps or reviewer routing.

Every decision (plan, start, escalation) is kept per ticket in
`$PASEO_HOME/linear-tickets/model-tiers/`. `npm run tier-report [-- --since 2026-10-01]` compares
the tiers each ticket started implementing on, from those records and the handover records:
tickets per tier (cheap, standard, strong), escalations, failures, and how many reached a pull
request.

Claude starts in `plan` mode and Codex in `auto`; omp keeps your usual mode (its `write` mode asks
before every shell command, reads included) and starts in Plannotator's planning phase instead.
The prompt asks only for a plan and, for a ticket someone else wrote or labelled `feedback`, marks
its text as untrusted input. With status write-back on, the ticket starts in **Planning** instead
of In Progress. Approving the plan switches the agent to your usual mode. A plan you sent back is
planned again by the next agent, which gets the previous plan and your feedback from the ticket's
plan document.

**Plan on a running agent.** Add `plan` to the ticket while its agent implements an approved plan:
within a minute the plugin asks the agent for a new plan. An omp agent enters the planning phase at
its next tool call (that call is stopped and the reason follows as a message) or prompt. Other
providers only get the message. A label that was there when the agent started does nothing;
remove and add it again to ask once more.

**Plan advisor.** Every plan a ticket agent writes gets a second opinion before it reaches you.
The planner (the model you launch tickets with; the model guard keeps it there) creates a GPT-6
Astra advisor (`omp/openai-codex/gpt-6-astra`, thinking `medium`) with Paseo's `create_agent`, in
its own workspace, so the advisor can read the same code. Both work from the same ticket context:
each launch saves the agent's first prompt to `$PASEO_HOME/linear-tickets/plan-context/<request>.md`
and passes the path in `LINEAR_TICKETS_CONTEXT`, and the advisor reads that file first (when the
save fails, the launch warns and the planner pastes the ticket into the advisor's prompt). The
planner adopts or answers each point and sends changes back to the same advisor with
`send_agent_prompt` until they agree, at most three rounds. The plan then ends with an
`## Advisor review` section: the advisor's model, the rounds, what changed, and every point still
disputed with both positions, for you to decide in Plannotator.

omp planners cannot skip this. Every ticket agent carries its ticket in `LINEAR_TICKETS_ISSUE`,
also in a session Paseo resumes after a daemon restart or reload (see "The omp extension" below),
and for those agents the extension blocks `plannotator_submit_plan`, its `xd://` device and omp's
`xd://propose` until `record_plan_advice` has recorded the review for exactly the plan text being
submitted; a plan the gate cannot read is blocked too. The tool checks with `paseo inspect` that
the advisor runs GPT-6 Astra at medium, was created by this agent and has finished its latest
turn; any later edit to the plan needs a new record, and the record follows the session branch
(resume, `/tree` and branch switches rebuild it). The record also needs readable `## Reach` and
`## Principles and rules` sections; a refusal names the missing section or line and shows the
format. It cannot check what the advisor said: the
plan's advisor section is your record of that. Recording and submitting in one step works when the
record comes first: the record is checked before any tool of that step runs, and a plan edit queued
in the same step holds both back. Subagents of a ticket agent (`task` children) are not gated; the
plan you review always comes from the ticket agent. An advisor that cannot be created (quota,
provider error) is recorded as `unavailable` only when the plan's advisor section says so and gives
the same reason. Claude and Codex planners get the steps as instructions when they launch in a
planning policy, without the gate.

**Plan risk and auto-approval.** Every ticket plan ends with a `## Risk and impact` section, before
`## Advisor review`, in a fixed format ([`shared/plan-risk.ts`](shared/plan-risk.ts)): affected
Area labels and business processes, an **impact** level, **reversibility**, feature flag yes/no,
migration yes/no, auth yes/no, **new rule** yes/no (the plan sets a rule for future work, stated in
`## Principles and rules`), the failure mode, the advisor's own rating, and a recommendation
(`auto` or `owner`).

| Impact | Meaning |
|---|---|
| 0 | No business process: agent tooling, CI, docs, refactor without behavior change |
| 1 | Read-only: reports, views, dashboards, logs |
| 2 | Changes how people do a step: screens, validation, defaults, internal notifications |
| 3 | Changes business records: orders, stock, batches, QM decisions, specifications, master data |
| 4 | External, financial or legal effect: Business Central postings, payroll, EDI or mail to customers and suppliers, certificates, food-safety alerts |

Reversibility is `revert` (reverting the pull request restores everything), `data-fix` (records
written in the meantime need fixing) or `irreversible`. The advisor rates the plan itself from the
ticket and the code; a plan rated lower than the advisor is a must-change point, and the policy
takes the higher of both ratings. For omp planners, `record_plan_advice` refuses a plan without a
readable section (or with `agreed`/`disagreements` but no advisor rating, or a `New rule` that
disagrees with `## Principles and rules`) and tells the plugin which verdict was recorded for which
plan text.

It also refuses a ticket plan that does not follow the owner's plan layout
([`shared/plan-layout.ts`](shared/plan-layout.ts)). The layout is read at every record from
Plannotator's global config (`$PI_CODING_AGENT_DIR/plannotator.json`, by default
`~/.pi/agent/plannotator.json`, `phases.planning.instructions`): every part heading the
instructions name in backticks (e.g. `` `# Part 1 — Overview` ``, `` `# Part 2 — Implementation` ``)
must be a `#` heading of the plan, in that order (any dash counts), and `## Reach`,
`## Principles and rules`, `## Model`, `## Risk and impact` and `## Advisor review` come after the
last one. Instructions that name no parts (Plannotator's built-in ones) or a missing or unreadable
file ask for nothing; a planner run's work order is exempt. The check does not rely on the agent
having received the instructions: on 2026-10-07 omp dropped them for some sessions (a hook
returning `systemPrompt` made it re-run the start hooks after Plannotator had marked them
delivered), and their plans reached the owner in the wrong layout for hours.

When the review opens, the plugin approves it on your behalf only if all of these hold:

- impact at or below `maxImpact` (default 1), or `maxImpactWithFlag` (default 2) behind a feature flag;
- reversibility `revert`, no migration, no auth change, no new rule (a plan with `New rule: yes`
  always reaches you, whatever its impact: "it sets a new rule"), and the planner recommends `auto`;
- the advisor `agreed`, recorded for exactly the text Plannotator shows (an edited plan, an
  unavailable advisor or open disagreements send it to you; the recorded verdict is kept in
  `$PASEO_HOME/linear-tickets/plannotator/advised/<agent>.json` until the review is decided, so a
  plugin reload in between does not);
- the ticket is yours (not someone else's, not `feedback`) and not marked attended.

A planner run's work order never goes through this policy: it only orders the project's
tickets (blocking relations and labels), and every ticket still plans and is judged on its own
(see "Projects").

An auto-approved plan goes through the same approval as yours (state, `plan-ready`, the plan
document, the agent's usual mode and its [model tier](#model-tiers)): the plugin records the
approval itself, because Plannotator reports none for its own plan mode. The agent gets
"Auto-approved by the risk policy" with the rating as its approval notes, and the panel, chat row
and ticket say so. Every other plan reaches
you with the rating and the reasons it needs you, parked (below) when it can be. The threshold
lives in `$PASEO_HOME/linear-tickets/settings.json` and the `linear.set-settings` RPC as
`"autoApprove": { "enabled": true, "maxImpact": 1, "maxImpactWithFlag": 2 }`; `enabled: false`
sends every plan to you. Claude and Codex planners write the section too, but without the
extension's record their plans always reach you.

**Parked plans.** A plan that needs you does not keep its agent (an agent slot and its memory)
waiting. The plugin saves it to `$PASEO_HOME/linear-tickets/plannotator/parked/<issue>.json`,
closes the agent's own review, archives the agent, and moves the ticket to **Planning** without
`plan-ready`. A central Plannotator host the plugin runs (`plannotator/host.mjs`, a detached Bun
process) serves every parked plan with Plannotator's own review page, published in the tailnet
like any review, so the review inbox, the agent's stable link, the panel and the Linear comment
work as before; like any review with a stable link, it opens no browser tab (the inbox and its
notification take that place).
Your decision there, or **Approve plan** / **Send back** in the panel:

- approve: the plan document, `plan-ready`, the ticket back to Todo, and a fresh agent that
  implements the plan as soon as a slot is free (with a Linear agent session; otherwise assign
  Paseo again);
- send back: the plan document with your feedback, and a fresh agent that plans again from it.

Plans stay parked across plugin and host restarts, and until your decision has been carried out
(see **Decision journal** below): when Linear fails (an outage, the hourly request limit), the
decision is retried every few seconds for about a minute, then once a minute until it goes
through; it is never dropped, and the host does not serve that plan again meanwhile, even after a
restart (it reads the journal on every sweep). The host needs
Bun (`~/.bun/bin/bun`, Homebrew or `LINEAR_TICKETS_BUN`) and the Plannotator omp plugin
(`~/.omp/plugins/node_modules/@plannotator/pi-extension`, or `LINEAR_TICKETS_PLANNOTATOR_PACKAGE`);
without them plans are not parked and their agents wait for you as before.

The host outlives plugin reloads (a deploy runs `paseo plugin reload`): the next plugin run adopts
it through its heartbeat (`plannotator/host.json`), so a review you have open keeps its server and
your annotations. During the reload itself (about a minute on the server) the page cannot reach
its server, because the tailnet route goes through the plugin's compressing proxy: a note saved
or a decision sent then fails visibly and goes through when you try again. The plugin replaces
the host when its version changes (this plugin's host code, Bun, or the Plannotator package) and
starts it again within seconds when it stops answering; its output goes to `plannotator/host.log`
and into the plugin's log. Each parked issue keeps its port (from 28600–28699, recorded in
`plannotator/ports.json`), so after such a restart an open page reaches the new server on the same
address: Plannotator asks you to reload the page instead of taking a decision meant for the old
server, and your unsent annotations come back with it. The host exits by itself ten minutes after
the plugin stopped running (disabled or removed).

A parked plan is judged again when its planner records the advisor review for exactly the parked
text after the plan was parked (a planner resumed for that, e.g. one whose session had lost
`record_plan_advice`): within your threshold it is approved like your approval above, otherwise it
stays parked with the new reasons in the inbox. The planner is retired again either way.

**Decision journal.** Every decision on a plan — yours in the review inbox, on Plannotator's page
(an agent's own review or a parked plan), **Approve plan** / **Approve, implement later** /
**Approve & split** / **Send back** in the panel, and the risk policy's approvals — is written to
`$PASEO_HOME/linear-tickets/plannotator/decisions/` (one private file per entry) before anything
is done about it, also when it carries no note. An entry names the agent, the ticket, the exact
review it was taken on (its server's address and the time it opened, since Plannotator reuses
ports), the plan's hash and text, approve or send back, your note and where it came from. A
worker carries it out step by step (chat row, ticket state, labels, plan document, follow-ups,
comment, queueing the next agent, …) and records each step, so after a failure, a plugin reload
or a daemon restart it continues where it stopped instead of starting over. Comments, panel
replies, sub-issues and follow-up tickets get their Linear id before they are sent and are looked
up by it before any retry, so a write whose answer was lost is never made twice. Failed steps are
retried every 3 seconds for a minute, then once a minute, without giving up; a ticket's decisions
are carried out in the order they were taken. Only one decision is accepted per review: a second
click on a plan whose decision is being applied answers `Already decided; it is being applied.`,
while a click Plannotator refused does not count and the plan stays decidable. While the plugin
reloads, it first stops taking decisions (the inbox and panel answer `The plugin is restarting;
try again in a few seconds.`), lets every running step finish, and only then hands the journal to
the new instance. The plugin's own closings of a review (retiring a planner, sending a plan back
for its `## Model` section, approving a project work order, the send-back with which **Approve,
implement later** and **Approve & split** close Plannotator) are journaled too, so their echo is
never taken for your decision. Plannotator's answer can be lost (the connection broke after the
request was sent): the decision then counts as not confirmed, is sent again while the review is
still open, and is carried out once Plannotator confirms it; if the review is gone without a
saved outcome, it waits for you (**Carry it out** / **Drop it** in the inbox). The same applies
to a report the plugin cannot tie to one plan, and to Plannotator reporting the opposite of a
decision not yet carried out (**Keep this one** / **Carry out the other**): from that moment no
further step of the decision starts (one already on its way to Linear finishes) and it is not
counted as carried out until you choose. A ticket's decisions are carried out one at a time, in
the order they were accepted. Settled entries are
kept for 60 days. Two limits: a decision on Plannotator's page is protected once Plannotator's omp
extension has written its report, and the "Plan approved" chat row in Paseo can appear twice if
the plugin dies right after posting it. To roll back the journal, revert the change only while
the inbox's **Being applied** is empty.

**Plan follow-ups.** When a ticket plan is approved, by you on Plannotator's page, by **Approve
plan**, **Approve, implement later** or **Approve & split** in the panel, as a parked plan or by
the risk policy, every `follow-up — <title>` line of its `## Reach` and `## Principles and rules`
sections becomes a ticket: in Todo, without assignee or labels, in the original ticket's team and
project, related to it, with a description pointing at the plan. One comment on the original
ticket lists them ("Follow-ups filed from the approved plan: …"). They are written only by the
Paseo app, never under your name: when the app cannot write at that moment, nothing is filed and
the comment says so ("file them by hand or approve again later"). For a ticket someone else wrote,
or one labelled `feedback`, nothing is filed; the comment lists the titles for you instead. Paseo
keeps what it filed per ticket in `$PASEO_HOME/linear-tickets/plan-follow-ups/<issue>.json`, so a
repeated approval files nothing twice, and a ticket filed but not yet linked is only linked on the
next try. Linear failures are retried every 10 minutes until every item is filed (the trust check
is repeated before each pending creation); the approval counts as carried out only once they are.
Each ticket and the comment get their Linear id before they are sent, so a retry whose first
answer was lost finds them instead of filing a second one. A planner run's work order files
nothing.

**The omp extension.** The planning phase and the plan advisor gate come from
[`omp/linear-tickets-plan-first.ts`](omp/linear-tickets-plan-first.ts), which omp loads from its
extensions directory. Install it once with a symlink, so plugin updates reach it:

```sh
ln -s "$PWD/omp/linear-tickets-plan-first.ts" ~/.omp/agent/extensions/
```

It needs the Plannotator omp plugin (`@plannotator/pi-extension`). The plugin gives ticket agents
the policy in `LINEAR_TICKETS_PLAN` and writes mid-run requests to
`$PASEO_HOME/linear-tickets/plan-requests/<agent id>`. Only fresh sessions start in planning; a
resumed agent keeps its phase. Paseo hands a session it resumes (daemon restart, reload) only the
daemon's environment, not the one the agent was created with, so the plugin gives it back when the
session opens: the policy from the agent's `linear.plan` label, and `LINEAR_TICKETS_ISSUE`,
`LINEAR_TICKETS_CONTEXT` and `LINEAR_TICKETS_MCP` from what the launch saved in
`$PASEO_HOME/linear-tickets/agent-env/<agent>.json` (the ticket from the agent's labels when
nothing was saved, as for agents started before; a planner run's agent, labelled
`linear.plannerRun`, gets its `project-planner:<run id>` and policy back the same way). Without
them a resumed agent had no
`record_plan_advice`, no submission gate and no Linear write guard, and its plan reached the risk
policy with "no advisor review was recorded for this plan text".

**Planning smoke check.** On 2026-10-07 ticket agents started planning without Plannotator's
planning instructions (its "framing"), so their plans came out in the wrong layout: omp 18.7
re-runs every extension's `before_agent_start` handler when one of them returns `systemPrompt`
and the base system prompt changed meanwhile, and drops the messages of the first round, the
framing included. [`scripts/planning-smoke.mjs`](scripts/planning-smoke.mjs) checks each host for
this:

- **framing** / **launch**: it starts omp in `rpc-ui` mode as a fresh ticket agent
  (`LINEAR_TICKETS_PLAN=required`, model `deepseek/deepseek-flash`, no ticket, so nothing touches
  Linear) in a temporary git repository, sends one prompt and reads the session file: the
  plan-first launch marker must be there (else `launch`: omp did not start, did not answer within
  3 minutes, or did not enter planning) and Plannotator's framing must come before the first reply
  (else `framing`). The temporary directory and omp's processes are always removed.
- **system-prompt-hook**: no omp extension (the `extensions:` list of `~/.omp/agent/config.yml`
  and everything in `~/.omp/agent/extensions/`) may return `systemPrompt` from
  `before_agent_start`. Each one is loaded in its own child process (TypeScript through the
  plugin's `tsx`) against a stub `pi`, with a private `HOME` and `PASEO_HOME`; its `session_start`
  handlers run first, then every `before_agent_start` handler with a stub event and a
  non-DeepSeek model. An extension that cannot be loaded or called under the stub is listed as
  not checked, not as a failure. Blind spots: a handler that returns `systemPrompt` only for
  some prompts, models, environment variables (a real ticket agent's) or session states, and
  extensions loaded some other way (omp plugins such as Plannotator itself, project
  `.omp` directories); the framing check still catches their effect.

The result goes to `$PASEO_HOME/linear-tickets/planning-smoke.json` (private, replaced
atomically), which the ops digest reads:
`{"version":1,"checkedAt":…,"fingerprint":…,"ok":…,"failures":[{"check":"framing|system-prompt-hook|launch","detail":…}]}`.
The fingerprint is a SHA-256 of `omp --version`, `~/.omp/plugins/omp-plugins.lock.json`, the
Plannotator package's version, `~/.omp/agent/config.yml`, every configured extension, every file
in `~/.omp/agent/extensions/` (links followed) and Plannotator's `plannotator.json`; a missing
input counts as absent. The plugin runs the check on every host two minutes after it starts and
then every 15 minutes in its `--if-changed` mode, one run at a time and stopped after 10 minutes:
it runs only when the fingerprint differs from the stored result's, and a failed result is tried
again for the same fingerprint at most once an hour. Passes and failures go to the plugin's log;
skipped rounds are silent. The plugin finds the script through the plan-first extension's link
(above), so a host without that link logs once that the check is skipped. By hand, in this
directory (always runs, prints a summary, exits non-zero on a failure):

```sh
npm run smoke:planning                       # add -- --if-changed for the plugin's mode
npm run smoke:planning -- --omp-config /tmp/config.yml --omp-extensions /tmp/extensions
```

`--omp-config` / `--omp-extensions` replace omp's config and extensions directory for the
extension check and the fingerprint only (to try a hook before installing it); the omp run always
uses omp's own setup. Every run writes the result file; point `PASEO_HOME` at a temporary
directory to keep a trial out of the ops digest.

**`plan-ready`.** Every approved plan adds the `plan-ready` label: always for a split or
“Approve, implement later”, and with status write-back on for Plannotator and panel approvals,
where a new review round or a plan sent back removes it again.
A ticket that carries it starts its next agent in your usual mode, with the approved
“Plan: <ticket>” document in the prompt and the instruction to implement it rather than plan
again.

**Approve, implement later.** The plan review also offers **Approve, implement later**. The
plan is saved as the plan document, the planning agent is closed (no Resume offer), and the
ticket goes back to Todo with `plan-ready`. Reply in the panel, assign Paseo again or add the
trigger label to start the implementing agent. Like **Approve & split**, it is journaled first
(see **Decision journal**): if a step fails, the panel answers `Approved — being applied:
<reason>. Retried every minute until it goes through.` and the rest follows on its own, without a
second set of sub-issues, follow-up tickets or agents.

**Link to the agent.** Each ticket gets an attachment "Paseo agent · <agent title>" next to its
pull requests, linking to the agent in the Paseo web app (app.paseo.sh opens it on devices paired
with this host). Its subtitle shows the phase and model; a new agent on the ticket replaces it.
Every Linear thread linked to an agent has "Open in Paseo" under Links, and the Plan review link
is there only while the review is open.

**Ticket agents keep their tier's model.** A ticket agent plans on the model and thinking level
chosen for launches in the plugin and implements on its [model tier](#model-tiers)'s model.
Plannotator's plan mode switches back to the model it saved when planning began once a plan is
approved; the plugin notices within seconds (at most 20 s), switches the agent to its tier's model
and says so in the ticket's panel. To use another model for ticket work, change the launch model
or `cheapModels` / `standardModels` in the plugin, or the ticket's `model:` label; changing it on one agent in Paseo
is undone.

OMP's own fallback is left alone. When an account nears its usage reserve, omp switches the session
to a model in the intended model's `retry.fallbackChains` (e.g. `anthropic/claude-opus-5-5` →
`openai-codex/gpt-6.1-sol:high`). The guard treats a switch to such a model as omp's, not as drift:
it neither restores nor announces anything. Restoring would only make omp fall back again — on
2026-10-08 the two traded agents every 30 s to 8 min for a day, 276 restores over 69 agents.
Whether and when omp returns the agent to its model is omp's (`retry.fallbackRevertPolicy`). A
switch the guard cannot attribute is left alone the same way: with the chains unreadable (no `omp`,
broken configuration) it keeps the model, logs the reason once, and still restores a drifted
thinking level. A manual switch to one of the intended model's fallback targets therefore stays
too.

**Which model is working.** The progress comment, the final report, the plan review question and
the plan document ("Planned with") show the model the agent runs, with its thinking level. When
it changes between turns (you picked another model in Paseo, or Plannotator restored the model it
saved before planning), the panel says so: `Model changed: A → B`.

**Questions stay answerable.** Linear shows a question's buttons only while it is the newest
entry in the panel, so the live feed holds the agent's commands until you reply. If an agent
waits on several approvals at once (parallel tool calls), each is asked in turn.

**After a reload.** The webhook receiver starts about a second after the plugin loads. If no
agent activity hands the plugin a daemon connection within three seconds, it connects to the
local daemon itself (only a loopback, password-free daemon), so replies sent while it was
reloading are picked up by the minute sweep. Plannotator chat rows in Paseo need a hook's
connection and are skipped until one arrives; Linear still gets the review.

**Waiting their turn.** A ticket blocked by unfinished tickets, or started while *max agents*
(Paseo Agents menu bar app's Control panel → Auto-dispatch, up to 50; 0 means no limit)
are already working, waits. A labelled ticket keeps its label; a delegated one says why in its
panel. The minute sweep starts it once it is admitted, however long it waited. A delegated ticket
whose thread was ended, or which was closed meanwhile, starts nothing; one that already has an
agent (from its label, say) is linked to it; a failed start is reported in the panel once.
Queued threads also reconcile bounded public agent history by the exact Linear session ID.
An empty thread whose agent already retired is linked back for accounting and removed from the
admission queue; this neither restarts the agent nor declares the ticket complete. An undelivered
owner message stays queued until a live owner can receive it or you explicitly continue it.
Current ownership takes precedence, and explicit Resume, Later and parked-plan decisions are
preserved. Genuine dependency, routing, capacity and process-exit waits retain their actual
reason; terminal threads settle without waiting behind those gates.
See *Who starts next* for the order in which waiting tickets get free slots.
A blocker is finished when it is Done or Canceled, or when it is in review (a started state named
like *In Review* or *Ready to merge*) and its pull requests are merged: at least one merged and
none open or draft, as Linear's GitHub integration reports them. Links added by hand or by
`link_url` carry no status and do not count. A blocker In Progress, Needs input or In Review with
an open pull request still holds the ticket back.

**Who starts next.** Every way a ticket starts (label, assignment, group, project) waits in one
line. While slots under *max agents* are short, a free slot goes to:

1. the project with the fewest agents working, so one project gets every slot while nothing
   else waits, and a ticket of another project gets the next free slot;
2. then tickets that may need you (see *Present and away*), so the time you are around is used
   for them;
3. then the higher priority (Urgent first, no priority last);
4. then the ticket that unblocks the most open tickets;
5. then the oldest ticket.

The count is of agents that work: one the daemon still lists as running although its OMP process
is gone (a ghost, see **Ghost agents**) holds no slot. An admitted ticket keeps its slot for 3
minutes while its agent starts. Tickets you start from the sidebar skip the line. So does a
project's planner run (see **Projects**): it only orders tickets, and while it waits none of its
project's new tickets can be handed out, so its agent starts even when every slot under *max agents*
is taken and under any memory lease. It still counts as a working agent.

**Present and away.** Planning never waits: every ticket plans at any time, also at night. A plan
that needs you is parked (see **Parked plans**) and takes no slot, so the plans are ready for your
review when you are back. While you are away, only the implementation of a ticket that may need
you during the run waits: one that carries `paseo-attended` (a planner run marks these, and
you can add or remove the label yourself) and has an approved plan (`plan-ready`). Its plan always
goes to you (the risk policy never approves an attended ticket), so an attended ticket you approve
while away starts once you are present again. Waiting tickets keep their place and start within a
few minutes of you being present again; agents already working continue. A ticket that asks you
something anyway stops in Needs input and frees its slot.

You switch with the Present/Away toggle of the Paseo Agents menu bar app, or with a schedule
(off by default; host-local times such as away 22:00–07:00). A toggle holds until the
schedule's next switch, or, without a schedule, until you toggle again. Changing the schedule
drops an earlier toggle. Both are kept in `~/.paseo/linear-tickets/presence.json` and are read
and changed through the `linear.presence` and `linear.set-presence` RPCs.

**Memory lease.** The Paseo Agents menu bar app can cap new ticket-agent starts by free memory.
It sends a lease (a slot count, a reason, and a lifetime of 30–600 seconds) through
`linear.set-capacity` and renews it while it runs; `linear.capacity` reads the cap in effect and
how many ticket agents are working, reserved and waiting. With *max agents* set, the lower of the
two applies; with no limit there, the lease alone does. A lease of 0 starts nothing new except a
planner run's agent, which no cap holds back (see *Who starts next*). Tickets
held back by the lease wait in the same line, with a reason like `Queued: RAM-limited, 12 of 12
slots used (…)`. The lease lives in the plugin's memory only: when it runs out, the app sends
`lease: null`, or the daemon restarts, *max agents* applies again. It only gates new starts and
never stops or touches agents already working.

**Split into sub-issues.** A plan with 2–12 steps also offers **Approve & split into N
sub-issues**. The plan becomes the parent's plan document and the planning agent is closed.
Each step becomes a sub-issue in Todo, assigned to Paseo, blocked by the step before, and the
parent moves to In Progress with `plan-ready`. The steps run one after another: each starts when the previous
one is finished, which for code means Done or in review with its pull requests merged.

**Groups.** Assigning Paseo to a ticket that has open sub-issues, or adding the trigger label
to it, hands the whole group to Paseo instead of starting an agent on the parent:

- Every open sub-issue that is unassigned or assigned to you, and not handed to Paseo yet, is
  assigned to Paseo, lowest number first. Each gets its own thread and agent and goes through
  the rules above: it starts once its blockers are finished and a slot under *max agents* is free.
  Blocking relations are the only ordering; sub-issues that do not block each other run side by
  side. A sub-issue that has sub-issues of its own becomes a group too.
- Sub-issues assigned to someone else are not taken but waited for. Your [manual
  tasks](#manual-tasks) and "Needs you" sub-issues are neither taken nor waited for.
- A parent that is itself blocked hands out nothing until its blockers are finished. Once the
  first sub-issue is handed out, the parent moves to In Progress.
- The parent's panel lists what each sub-issue waits for and is updated whenever that changes,
  so a blocker nobody works on ("TUC-88 (not with Paseo …)") shows up. Any reply in the panel
  posts the current list. Sub-issues added later are handed out within a minute.
- When every sub-issue is finished (by the blocker rule above), the parent moves to Done, or
  to Canceled with the reason when all of them were canceled, and the thread completes. Split
  plans close their parent the same way.
- Unassigning Paseo from the parent, Stop in its panel, or closing the parent stops handing out.
  Agents already working continue.

A ticket whose sub-issues are all finished, or are only your manual tasks, starts an agent of
its own as before. Without a usable Paseo app (no threads), a labelled parent starts an agent
as before.

**Projects.** Adding the trigger label (`paseo`) to a Linear *project* lets Paseo work through
the whole project without you assigning each ticket. Auto-dispatch must be on; projects are read
with every dispatch poll, at most every 2 minutes. Reading every open ticket of a project with its
labels and relations is expensive in Linear's hourly complexity budget (about 175 points a ticket;
on 2026-10-07 the 518 open tickets of two projects cost 90,618 points a read, about 1.8M of the
app's 2M points an hour), so a project is read in full every 30 minutes and right after Paseo
writes a work order; in between only its tickets changed since the last read are read, plus the
current state of the blockers its tickets wait on. A relation you add or remove in Linear without
the ticket itself changing, or a deleted ticket, shows up with the next full read.

- **Planning on its own.** Whenever a labelled project has new tickets and no open planner run,
  the plugin starts a run itself: no Linear ticket, no label, no agent session in between. A run
  waits for the project's tickets to settle: it starts 15 minutes after the newest new ticket was
  first seen, or an hour after the oldest one at the latest, so a steady trickle still gets its
  order within the hour. The Paseo Agents menu bar app uses three RPCs: `linear.projects-status`
  lists each labelled project with how many new tickets wait for a plan, when a run would start
  (`plansAt`) and the open run (its id, agent, start time, tickets, restarts and `ownerAsked`);
  persisted owner-needed failures remain visible after reload or a Linear outage. `linear.plan-project`
  saves a run right away and returns it before agent startup finishes, instead of waiting for the
  next read. Startup continues in the project's queue; the request does not wait for provider
  readiness. It replaces a run left to you; `linear.skip-plan` stops the open run, whose tickets are
  then handed out without a work order.
- **Host ownership.** Project planning belongs to the host with `activation.mode: "local"`.
  A forwarding host (`"remote"`) refuses Plan and Skip and names its configured peer; it never
  starts, restarts, skips or applies a project work order. Queued starts re-read ownership before
  launching, so a handover cannot launch a planner on the old host from captured settings.
  Turning off auto-dispatch on a local host still permits an intentional manual Plan.
- **Planner run.** The plugin launches the run's agent itself, in the Paseo project the
  [project mappings](#project-mappings) give the Linear project (else the busiest team of its
  tickets), in that project's own checkout with no worktree or branch: the run changes no code. No agent slot and no memory lease holds it back: it only
  orders tickets, and while it waits none of its project's new tickets can be handed out. Its
  first prompt is the brief: every open ticket of the project (In Progress and In Review included)
  in one line with its state, priority, labels, open blockers and links, the new ones marked and
  also given in full (up to 4,000 characters each and 30,000 in all; past that the agent reads
  them in Linear), and the 300 most recently updated open tickets of the same team outside the
  project by title. The brief stays within 120,000 characters, so it fits any project size (the
  ticket planners before it rode Linear's 200,000-character agent context, and ERP's 409 open
  tickets went past it: TUC-1094 never started); every new ticket is always listed, and when the
  room runs out the other project tickets, then those outside it, are cut, with a note to search
  Linear for them. Its agent looks for overlap first:
  it compares every new ticket with all of those, searches Linear with its read tools for open
  tickets the lists miss, reads the full text of any candidate, and its plan lists every overlap
  in an `## Overlaps` section (or "None found" with the search terms). It then reads the code and
  plans which tickets block which (because one builds on another, or both touch the same files),
  which duplicate or relate to other tickets, which must wait for you, and which may need you
  while they run. Its plan is always approved automatically: it only changes Linear, and every
  ticket still plans on its own. Its `## Work order` section holds a block like:

  ````
  ```project-order
  TUC-12 blocks TUC-15
  TUC-24 duplicates TUC-9: TUC-9 already adds the export, including the CSV columns
  TUC-25 relates to TUC-31: both change the dunning e-mails
  hold TUC-20: too big, split it first
  release TUC-21
  attended TUC-23: which customer groups get the discount is not decided
  ```
  ````

  The plan is approved the moment the agent submits it: no risk check, no inbox, no parking, and
  no Linear read that could fail and send it to you. A plan whose block is missing, or has a line
  that is not exactly one change (`TUC-1 blocks TUC-2, TUC-3`), is sent back to the planner with
  the unreadable lines instead of closing as an empty order. Paseo then adds the blocking
  relations, links related tickets, puts `paseo-hold` on held tickets (removes it from released
  ones) and `paseo-attended` on attended ones (`unattended X` removes it), posts one update on the
  *project* saying what it applied and skipped, and archives the run's agent. If that summary update
  fails, the failure is logged; the applied order still closes. `A duplicates B` puts `paseo-hold`
  on A, posts the reason on it and links it as a duplicate of B, which moves A to
  Linear's Duplicate status; B may be any ticket, in the project or not, open or done, while A
  must be a ticket of the project that is not started and not with an agent (others are listed
  as skipped). `A relates to B` needs A open in the project and B any ticket. Links that exist
  count as applied. Nothing else of a ticket approval (In Progress, `plan-ready`,
  a new agent) applies to it. The approved order is kept in `projects.json` before it is
  written, and every project read writes one that is not in Linear yet, so Linear being down or
  rate-limited only delays it, for as long as it lasts. The changes that went through are kept
  with it, so a later read repeats only the rest: a `paseo-hold` you removed meanwhile is not
  added again. Until the order is written, the tickets it blocks, holds or marks attended are not
  handed out, even when they were planned before. A change Linear itself refuses three reads
  in a row is listed as skipped and the order closes anyway; a ticket whose `hold` or blocker was
  skipped is not handed out by the project (the project update names it), so assign it yourself
  when it may start. The planner is told to mark a ticket
  attended only for an open business decision, acceptance criteria too vague to check,
  user-facing wording or layout you choose, changes to production data, external accounts or
  spend, or a step only a person can do; never for size or risk alone. A run that cannot be
  started or written never holds back the hand-out of tickets that are already planned.
- **Restarting the run.** A run whose agent never came up (its start failed) or stopped without
  submitting a plan (closed after idling, or archived) would hold the project: no new run starts
  while it is open. So every project read checks the open run without an approved order for a live
  agent (one labelled with the run's `linear.plannerRun` that is initializing, idle or running,
  and no ghost: see **Ghost agents**). For failures other than provider rate/usage limits, ten
  minutes after its last start without one, the plugin starts another agent for the same run;
  its stopped agents are archived. A start that cannot succeed (no project mapped, no provider
  chosen) leaves the run to you right away instead of retrying. After three ordinary restarts
  without a live agent the plugin posts one update on the project, marked at risk, and stops:
  press Plan in the menu bar app to start again, or Skip to hand the tickets out without an order.
  Every start and restart is kept with the project's record in `projects.json`, and a late
  report of a run you skipped or replaced is ignored rather than written.
  **Provider rate/usage limits** use the same broker account/fallback availability and initial
  timing as ticket-agent usage-limit recovery below: room on a configured account/model, the
  earliest usable reset plus one-to-five-minute jitter, retry-after plus that jitter, or thirty
  minutes without a reliable hint. A pending planner checks fresh capacity every project read,
  even before its scheduled reset. New room can advance the wait; stale/missing usage never
  proves room. Changed saved provider/model preferences are revalidated for the actual launch,
  not authorized by the old model's capacity. Repeated errors do not redraw jitter or move the
  original fallback deadline; a renewed exhausted window can postpone the restart.
  Limit replacements are at least fifteen minutes apart and at most four in a rolling
  twenty-four hours per host/run, independent of the ordinary three-restart counter. Waiting
  spends neither counter. A lost creation response keeps its claim and ten-minute startup
  grace; a later bounded attempt has a unique durable request identity. External creation is
  not exactly once: a late duplicate may briefly exist, but the recorded live planner stays
  authoritative, redundant same-run roots are retired, and their stale orders are rejected.
  If a replacement fails before creation for an ordinary reason, its retry returns to the
  ordinary grace/cap; the already handled predecessor limit cannot be scheduled again.
  A predecessor agent id is not confirmation of a new creation: an unconfirmed usage-limited
  ordinary restart still keeps the full ten-minute grace, including after reload.
  At the limit bound, one project-update notification is attempted and the run stays owner-held
  until Plan or Skip, even after day rollover. A failed notification is logged, not repeated.
  The saved `ownerAsked` failure also appears in the menu bar's **Needs your input** list and
  count, with Plan and Skip actions, and in the hourly ops digest's **Needs attention** and
  **Waiting on you** lists. These do not depend on the Linear project update succeeding.
  A scheduled automatic retry alone is not an owner-needed planner failure. A failed menu-bar
  status refresh retains known failures with a stale-state warning; a successful refresh removes
  a failure once its run is replaced, skipped or completed.
  Auto-dispatch controls automatic project recovery; the ticket-only automatic-start switch
  does not. Disabling dispatch or removing the project's trigger prevents automatic attempts
  and retains the wait for revalidation when enabled again. Approved work orders and already
  planned tickets keep their existing paths.
  The project status reports “Usage limit on {provider}: Paseo starts a new agent at {time}.”
  with Berlin time. Optional `planner.recovery` metadata in `projects.json` survives reload,
  needs no backfill and preserves existing label-repair records. Malformed recovery metadata
  stops automatic recovery with a logged reason, never resets its budget. Confirmed usage-limit
  replacements are retained outside the open run in optional `plannerLimitRestarts` for eight days,
  so Skip, a replaced run or a finished plan does not erase their reporting evidence. Confirmation
  is saved atomically with the run update; a failed save retains the claim for labeled-root
  reconciliation, and retirement failure cannot turn saved confirmation into failed creation.
  **Plan pipeline** in the review inbox observes the saved restart time as described below;
  ticket-agent digest behavior is unchanged.
  Skip and order application wait for any start or write already in flight. Each later project
  poll also archives obsolete run agents, including one whose creation response was lost and
  became visible only after Skip.
- **Hand-out.** Planned tickets in Backlog or Todo that are unassigned or yours, not handed to
  Paseo yet, without `paseo-hold` (or other `paseo-` state labels) and with every blocker
  finished are assigned to Paseo in the *Who starts next* order, one per free slot. Tickets in
  Triage or already started, someone else's, and sub-issues (their parent's group hands them
  out) are left alone. A ticket with open sub-issues in the project is assigned as a group and
  takes no slot itself. Removing `paseo-hold` releases a ticket.
- **Restarting a failed start.** A ticket stays assigned to Paseo when its start fails (the
  launch timed out, the daemon connection dropped) or Linear's webhook never arrives, so the
  hand-out never takes it again. So every project read also checks each ticket assigned to Paseo
  that is still in Backlog or Todo (a started agent moves it on), is not a group, carries none of
  the `paseo`, `paseo-running`, `paseo-failed`, `paseo-hold`, `paseo-manual` or `paseo-needs-you`
  labels and has every blocker finished. When it has no live agent and no start under way, and its
  newest thread neither waits for its turn, ever had an agent nor was closed on purpose (a plan
  approved for later is back in Todo on purpose; a ticket someone else handed to Paseo was
  refused; a waiting thread you completed is left alone), it is started again ten minutes after
  it was first seen so, admitted like any start (a full agent limit is waited out without
  counting), with a new agent and thread, as for a planner run, one ticket per poll. After three
  restarts without a live agent Paseo comments on the ticket and stops: start an agent from the
  sidebar, or add the `paseo` label. Kept under `stalled` in `projects.json`; a ticket drops out
  once an agent works on it. Tickets carrying `paseo-running` or `paseo-failed` are left to
  **Repairing stale running and failed labels** below.
- **Repairing stale running and failed labels.** `paseo-running` says an agent works on the
  ticket and `paseo-failed` that its start failed; with another trigger label the names change
  with it. Nothing else removes them when the agent is deleted in the app, lost with its host's
  records or left without its process (a ghost, see **Ghost agents**), and a failed start would
  wait for you even after a passing glitch. So every two minutes the host that hands out tickets
  (never a draining host, and only once the peer's claims arrived) reads the open tickets of the
  dispatch teams with either label and applies one rule: each label is reconciled with what is
  true, and a replacement agent starts only for a proven orphan in a work state.
  - *An agent works on the ticket* when this host has one that is live (no ghost) or stopped but
    still there (closed or in error: crash recovery and the pull request watch handle it), the
    peer host claims the ticket, an activation for it is queued, or a start is under way. Then
    `paseo-running` stays, and `paseo-failed` comes off with a comment.
  - *`paseo-running` without one for 15 minutes:* the label (and `paseo-failed`, if it carries
    both) comes off under the ticket's start lock, after a last look, with one comment. A ticket
    in Triage, Backlog, Todo, Planning or In Progress without `paseo-hold`, `paseo-manual` or
    `paseo-needs-you` is started again, continuing its recorded branch, 15 minutes apart, at most
    three times; then Paseo comments once and stops. Other tickets only lose the label: in Needs
    input your answer starts the next agent, in review the pull request watch does.
  - *`paseo-failed` without one,* in the same states and without those labels: started again 10
    minutes after the failure was first seen, then 30 and 90 minutes after each failed retry. A
    retry that starts an agent removes `paseo-failed` and says so; after the third failure you are
    mentioned once and the label stays.
  - *A start that fails on this host's setup* (no Paseo project mapped, no provider chosen, no
    usable base branch, a project without Git) is not retried: the ticket gets `paseo-failed` and
    you are mentioned once.
  - At most one ticket is restarted per pass. Before each restart the ticket is read again: one that closed, got `paseo-hold`, moved to
    Needs input or review, or got an agent, a claim or a queued activation meanwhile is not
    started. Tickets carrying the trigger label (the dispatch has them), groups
    and tickets being deleted are left alone.
  - Each incident is kept under `~repairs` in `projects.json` with its last ten steps. A restart
    and a comment are claimed there before they happen, so a reload never doubles one and never
    resets the count; an interrupted restart counts once 15 minutes passed without an agent. An
    agent that vanishes again within a day of the repair continues the same incident. The
    hand-out and **Restarting a failed start** leave tickets with an open incident alone. Adding
    the trigger label or starting an agent from the sidebar ends the incident: a later failure
    starts with fresh retries.
- **New tickets.** A ticket is planned once a run listed it (by ticket, not by creation
  time), so a ticket filed while a run starts, or moved into the project from
  another one, is new too. Tickets that leave the project's open tickets (closed, moved out) drop
  out of the planned ones when a run closes, so they are new again if they come back. New
  tickets are not handed out until the next run has ordered them; `linear.projects-status`
  counts them and says when a run would start. Only tickets the project could hand out count: new
  sub-issues, tickets already with Paseo or someone else, and started ones do not. There is at
  most one run per project at a time, also when Plan is pressed while one starts: tickets filed
  while one works are listed by the next. Records of older versions, which planned by creation
  time, keep what they had planned; the record of an old planner ticket is dropped (the ticket
  itself is left alone, and the project's new tickets are planned on their own).
- **Skipping a work order.** Skip in the menu bar app (`linear.skip-plan`) stops the open run: its
  tickets count as planned and are handed out without a work order.
- Removing the label from the project stops new hand-outs; agents already working continue.
  Without a usable Paseo app (no threads) projects are not worked on.

What has been planned is kept in `~/.paseo/linear-tickets/projects.json`.

**Pull request reviews.** Every 2 minutes the plugin looks at each ticket's pull request, but reads
it in full — one `gh pr view` GraphQL query — only when something actually changed. The first look is
REST and conditional: the pull request read as an issue (`repos/…/issues/<n>`; the single-pull
endpoint's ETag moves on every request, the issue resource's does not), its comments (Graphite edits
its Merge activity comment in place), its reviews, and the head's check runs and combined status. An
unchanged resource answers `304 Not Modified`, which GitHub does not meter, so a quiet pull request
costs the GraphQL budget nothing; the detail read runs only when one of them moved, while the
merge queue is testing the pull request (its comment can end the attempt at any poll), or when the
cached view is older than 10 minutes. The detail read includes GitHub's mergeability against the
base; a base that moved without touching the pull request shows its conflict at that 10-minute
refresh at the latest. The members of a ticket's connected stack (see **Stalled pull requests**)
are read the same way, each once per poll. Every one of those REST reads passes the GitHub budget
first — the router's account pick where it is installed, the [single-login
reserve](#pull-request-view) that keeps the agents' own `gh` calls working where it is not.
Requested changes post a panel update and move the ticket back to In Progress; fixes
pushed after them move it to In Review again. An approval moves it to the team's started state
**Ready to merge** (teams without one stay in In Review), once no [manual task](#manual-tasks)
due before merge is open; commits pushed after the approval move
it back to In Review. The merge is noted, and Done comes from Linear's GitHub integration, or from
the agent when no pull request closes the ticket ([Agent access to Linear](#agent-access-to-linear)).
Requested changes on the current head also reach the agent itself; see the nudges below.

**Graphite merge queue.** The queue lands a stack by fast-forwarding the base branch and closes
the pull requests instead of merging them. A closed pull request labelled `externally-merged`
(or whose last Graphite "Merge activity" bullet is "Merged by the Graphite merge queue") counts
as merged, including its after-merge [manual tasks](#manual-tasks). A queue drop is noticed on
an open pull request when Graphite's last Merge activity bullet ends the attempt (a conflict,
"merge when ready" turned off, a failed check), or when the draft its latest "CI is running"
bullet names was closed without its head reaching the base branch and no newer queue draft for
the pull request is open. Without Merge activity, drafts alone never count. The repo decides
what kind of drop it is: the plugin runs `tools/ci/wait-queue.mjs <pr> --draft <n>` (`--last`
without a draft) from the [queue backstop's checkout](#queue-backstop) and reads its `class`,
`requeue`, `evidence`, `revision` and failed checks (`docs/automation/merge-queue.md`). A repo
without that checkout has no classes: its drops are genuine. A run that fails or prints no JSON
claims nothing, and the next poll decides again. The class counts on every pull request of the
dropped range: `conflictOnly` toward up to five restacks, `mainBroken` toward nothing (it never
escalates), every other class (`infra`, `flaky`, `genuine`) toward one fix request. A range
counts as its most-dropped pull request: the next drop past a limit on any of them only mentions
you ("the merge queue dropped this stack again", with both counts), every pull request of the
range is marked escalated, and after that drops of any kind are only logged; a drop of a range
one of whose pull requests escalated already escalates the whole range, too. Drops claimed
before the kinds existed count as plain, and three of them as escalated. A newer round of a range
retires the backstop's enqueues of it that had not gone through yet (unless the range changed
since the drop). Then, by class and revision:

- not the stack's fault (`requeue`), the code provably the code that dropped (`revision` is
  `same`, or the backstop's own enqueue of these very heads came right before this round) and no
  [manual task](#manual-tasks) due before the merge open (one that cannot be read counts as
  open): the [queue backstop](#queue-backstop) re-enqueues the range, nothing goes to the agent.
  A main-broken range waits there until `main` is green;
- not genuine, but the range changed since the drop (`changed`): nothing is sent; the new heads
  go through the ready rule;
- not genuine, but the code could not be compared (`unknown`), or a manual task is open: the
  kind's request goes to the agent, saying why Paseo did not re-enqueue it. An `unknown` range is
  blocked like a genuine one;
- genuine: today's fix request. The range is blocked at its heads: the backstop leaves it alone
  until one of them changes.

The ticket's agent gets the reason, the checks that did not pass on the draft, the kind with its
evidence and the runbook for it. All re-enqueue the dropped queue range from its top branch, the
one enqueued before the drop: the range `wait-queue.mjs` compared, else the dropped pull
request's own chain among the open pull requests the queue's draft listed (a draft can test
other stacks too); never the stack's top branch, which would enqueue pull requests above the
range that are not ready. Every enqueue goes through the repo's `node tools/ci/enqueue.mjs`,
never a bare `gt merge`: it refuses a range that conflicts with `main` or the queue tip and names
the fix. A genuine drop: on the stack's top branch `git fetch origin main && git rebase
--update-refs --onto origin/main "$(git merge-base HEAD origin/main)"`, which moves only its own
branches, never `gt sync`/`gt restack`; fix, `gt submit --stack --ignore-out-of-sync-trunk`, then
`git switch <range top> && node tools/ci/enqueue.mjs` and `node tools/ci/wait-queue.mjs <its
PR>`. A conflict-only drop: the same rebase (only when every branch below is the agent's own),
regenerate generated files instead of merging them, the focused checks, the same `gt submit`,
then right away `git switch <range top> && node tools/ci/enqueue.mjs` and `node
tools/ci/wait-queue.mjs <its PR>`, without waiting for the pull request's checks: the queue's
draft runs the full suite (only when `gt merge` refuses because checks still run: `node
tools/ci/wait-checks.mjs <its PR>`, then `enqueue.mjs` once more). A main-broken drop needs no
restack or fix of its own, and asks for `git switch <range top> && node tools/ci/enqueue.mjs
--wait-main` (it waits until `main` is green, then checks and enqueues) and `node
tools/ci/wait-queue.mjs <its PR>`; its message carries all three counts. The message goes out
once the agent is idle; Paseo resumes it if it has stopped. While the agent is in a turn or
waiting for an answer, or Paseo is not connected, the message waits for a later poll. When the
agent is gone or archived, a successor starts with the same text (see **Gone agents** below);
when none can start, it becomes a
ticket comment mentioning you, and the ticket moves back to In Progress (when status write-back
is on). Each drop is claimed in
`$PASEO_HOME/linear-tickets/pr-watch.json` (by its draft, or by the bullet when there is none)
before anything is sent, so it is delivered at most once, also across restarts. A message for a
pull request that still holds an undelivered one waits behind it and goes out after it. An
archived agent's open pull request stays watched until that escalation or 14 days without
activity. When GitHub throttles `gh`, the rest of the poll waits for the next one.

**Queue backstop.** Every 10 minutes, and right after a poll claimed a drop to re-enqueue, the
plugin enqueues on its own what nobody else did. It runs the repo's scripts, never its own
judgment, from a detached worktree per repo at
`$PASEO_HOME/linear-tickets/queue-backstop/<owner>-<repo>`, made from the git common dir of any
recorded worktree of the repo and reset to `origin/main` (fetched first) before every run; a repo
whose `main` has no `tools/ci/enqueue-ready.mjs` gets no backstop. One run at a time, taking turns
with the poll:

1. Re-enqueues claimed above, and earlier enqueues that are still due or held, move on. Right
   before each enqueue the range is checked again as it is now: a round on any pull request of
   the range (someone may have enqueued only part of it) that ended and nobody claimed yet is
   claimed first, like the poll's. The enqueue is dropped for good when a newer round superseded
   it, a pull request of the range closed or has a new head, the range escalated, or a pull
   request of it is blocked at its head; it waits for the next run while such a round is not
   judged yet, a message about the range is still pending, or a before-merge manual task of its
   tickets is open (or cannot be read).
2. `node tools/ci/enqueue-ready.mjs --ready-minutes 10 --exclude <pr>… --skip <action>…` lists
   the stacks that have been green, reviewed and without open threads for 10 minutes and nobody
   enqueued, and the drops it saw. Excluded are escalated pull requests, ones blocked at their
   head, ones with a drop message or re-enqueue still pending, and the pull requests of tickets
   whose before-merge manual tasks are open (or cannot be read); skipped are refused enqueues not
   released yet. The script's scope is the shared login's own pull requests only: never
   Dependabot, another author, or a range with `do-not-merge`.
3. Drops of pull requests no ticket's agent watches are claimed like the poll's.
4. Each ready stack is enqueued with `node tools/ci/backstop-enqueue.mjs <top branch> --expect
   <pr>@<sha>,… --action <id> --comment-file <file>`, which re-checks every head and runs the
   checkout's `tools/ci/enqueue.mjs`.

   Each invocation uses a fresh private clone with its own branch refs and Graphite metadata,
   borrowing objects from the trusted checkout without copying the worker's refs or metadata.
   The clone's `origin` is the actual GitHub remote, its trunk starts at the trusted checkout's
   fetched head, and Graphite reconstructs the range from the expected PRs. Only the trusted
   checkout's script executes. The invocation removes its private clone on completion or failure.
   A worker's stale branch, unpublished commits, dirty files or changed Graphite parents cannot
   block this enqueue and are never overwritten. The expected-head, author, veto, main-health,
   queue-conflict and gate checks still apply.
5. Open stacks stranded on an orphaned `graphite-base/<n>` branch are moved onto `main` (see
   "Stranded stacks" below), only when the checkout's `main` has `tools/ci/retarget-orphan.mjs`.
6. On the dispatch host only, `complex-review` pull requests Greptile never reviewed get a review
   request (see "Greptile re-request" below), only when the checkout's `main` has
   `tools/ci/greptile-retrigger.mjs`.

Every enqueue is an action (`drop:<drop key>:<top>`, since one queue draft can test several
stacks, or `ready:<top>@<heads>`) saved in `pr-watch.json` before each step: the number and last
text of the top pull request's Merge activity bullets right before the enqueue, then the enqueue,
the pull request comment, the ticket comment and the note to the agent. Enqueued: the script
comments on the top pull request (marked `<!-- queue-backstop:<action> -->`, never twice), the
plugin comments on each ticket (ending in `` `queue-backstop:<action>` ``; the ticket's comments
are searched for this whole mark, backticks included, and only a comment whose body carries it
counts, so another action's mark that starts with the same text never does; a ticket counts as
done only once Linear confirmed it, so a lost answer never doubles it and a crash never skips it)
and tells a running agent that nothing is needed from it. Held (`main` red or unknown, or already
queued): retried on the next run. Refused: routed once per refusal (action and kind, plus the
draft for a queue-tip conflict)
to the agent (including crash restart or automatic successor recovery), the ticket when no agent
can recover, or as one marked comment on the pull request when there is no ticket. Repair text
identifies the ticket's agent as the worker; it is not an instruction for the owner to run commands.
A refusal is retried only after the change that can fix it: a new head (a new action), the end of
the queue draft for a queue-tip conflict (read by its number; a state that cannot be read keeps the
refusal), at most hourly for other repairable conditions, or the `do-not-merge` label's removal for
a veto. Previously persisted `local-differs` and `stack-differs` refusals are released on the next
backstop run because private refs remove their shared-checkout cause. An `enqueue.mjs` that ran
`gt merge` and enqueued nothing (`not-enqueued`, for example "The stack is already merging") is a
refusal of kind `not-enqueued`, routed once and released only by a new head: an enqueue someone
else made meanwhile is never taken for the backstop's. An answer that is not the
script's JSON, or an exit it does not document, never counts as an enqueue. After a restart an
enqueue whose outcome was not recorded is decided by the Merge activity: an enqueue bullet after
the saved bullets means it went through, none means it is retried while the pull request is open,
and a comment that no longer starts with the saved bullets means nothing can be told: it is not
retried, the range is blocked and the agent is asked to check. Comments owed for an enqueue still
go out once after the pull request closed or landed. To switch the backstop off, revert the
plugin change and `paseo plugin reload linear-tickets`; ranges already in the queue stay there.

If a handover record has no pull-request link, or its link moved or disappeared after routing,
the backstop still delivers the repair to that ticket's agent through the same crash/successor
recovery path. Busy agents keep their requests pending across restarts; in-flight claims prevent
duplicate sends. Owner fallback is reserved for escalation or a missing/unrecoverable agent record.

**Stranded stacks.** When the bottom of a stack lands, Graphite sometimes leaves the pull request
above it based on a helper branch `graphite-base/<n>` that no open pull request owns; it cannot
reach the merge queue until it is moved onto `main` (the ops digest's "base branch
graphite-base/N has no open PR"). The repo's `tools/ci/retarget-orphan.mjs` decides and writes,
always in a fresh private clone like the enqueue: `--list` names such stacks and whether each may
move (the pull request below demonstrably landed on `main`; one linear stack; every pull request
the shared login's own, none `do-not-merge`), `--prepare <pr> --expect <heads> --stamp <unix>`
computes the new heads without writing (a conflict with `main` is reported, nothing else), and
`--apply <pr> --record <file>` pushes every branch at once with explicit leases and points the
bottom pull request at `main`, or finishes or refuses by exact SHAs when it ran before. The
plugin moves a stack only when it names exactly one ticket, this host has that ticket's handover
record, and nothing holds it back (escalated, blocked at its head, a message about it pending
that is not its own, open before-merge manual tasks, read again in the ticket's turn right before
the preparation and before the write: a task opened meanwhile keeps a prepared move waiting), at
most three per run, and only while no agent of the ticket works and this host owns the ticket
(`SessionRouter.whileIdle`: every agent of the ticket idle, closed or gone, no OMP worker process
left, a closed or archived subagent's included, the activation claims read without forwarding
anything: a draining host owns only the roots it still runs, a receiving host with a peer only
after the claims handshake and while the peer claims none). A move not yet prepared takes each
listing's tickets, branches and bases as they are now. The move is saved on the bottom pull
request in `pr-watch.json` before each step: the preparation (old and new heads, `onto`, stamp)
before anything is written, `applying` right before `--apply`, which a restart runs again with
the saved record, never a new listing. A finished, conflicting or refused move is forgotten only
once its stack is no longer listed at the same heads, so a stack still stranded is never asked
about or written again. Moved: a comment on the bottom pull request (marked
`<!-- queue-backstop:retarget:<pr>@<old bottom head> -->`) and on the ticket with old and new
base and every head plus the agent's local sync commands, each claimed before it goes out and
found by its marker after a restart (at least once, never twice while the marker reads), then the
same as a note to a living agent, at most once. While an agent of the ticket works or waits for
the owner, the agent is asked once to move the stack by hand, and a later run moves it once no
agent works (an instruction that had not gone out yet is dropped). A conflict, a stack of several
tickets (to the bottom ticket's agent) and a stack that changed while it was moved go to the
agent like a drop: a successor when it is gone, the ticket when none can start. A turn the owner
starts directly is not serialized with a move; the leases keep the push safe, the final base
change has no compare-and-swap.

**Greptile re-request.** Greptile reviews only `complex-review` pull requests that are not drafts,
and misses a label added after publish (or is down), so such a pull request can wait forever for
its first review (the ops digest's "complex-review: no Greptile review yet"). Per repo and run,
`node tools/ci/greptile-retrigger.mjs --trigger [--follow <pr>]…` decides and posts: every open,
published `complex-review` pull request without a Greptile review gets one comment `@greptileai`
(marked `<!-- greptile-retrigger:<head sha> -->`, from the bot) once 30 minutes have passed since
it was published, labelled or last asked. The repo caps it from the markers on the pull request,
so a restart or a lost state file never asks again: once per head, at most twice in any 24 hours,
never after a Greptile review has been observed. Every request is also kept on the pull request's entry in
`pr-watch.json` (`greptile`, evidence for the ops digest only, kept 14 days). **One writer:** only
the host whose `dispatch.enabled` is on runs it (README "Several hosts" allows that on one host
only), one backstop run at a time; every other host logs `greptile re-request: skipped, dispatch
is off on this host` once and asks nobody. A script error, an undocumented exit or answer is that
repo's failure, never a stop of the backstop.

Once a request is 2 hours old without a review, the dispatch host files one Linear issue
**"Greptile is not reviewing"** (`server/greptile-outage.ts`, state in
`$PASEO_HOME/linear-tickets/greptile-outage.json`): in the first auto-dispatch team, no project
(so no ticket agent starts on it), Todo, assigned to the owner, priority High, mentioning the
owner. It lists every pull request that waits (with when Greptile was last asked, or "not asked
yet") and keeps the ones that no longer wait with their outcome (reviewed, closed, back to draft,
label removed); the backstop passes the listed ones as `--follow`, and the list is synced once per
run after every repo, rewritten only when it changed. The issue is created under an id chosen and
saved first, so a lost answer is looked up and retried under that id; with the state file lost,
the open issue is found again by its `Marker: \`greptile-outage\`` line. Once a run read every
repo without an error and every listed pull request has an outcome, the issue gets a closing
comment with each outcome and completes itself. A repo whose run failed (or stopped at GitHub's
budget) and a pull request that could not be read ("not read this run") keep it open. If you
close it while pull requests still wait, it stays closed until a complete run finds none; a later
outage files a new one. To switch it off, revert the plugin change (or the repo's script) and
`paseo plugin reload linear-tickets`; comments already posted, and reviews already started, stay.

The poll and backstop also recover a missing handover PR link before deciding the ticket's next
step. They identify the repository from the recorded worktree's validated GitHub origin, or
from canonical PR attachments on the ticket when that source is unavailable. Conflicting
attachment repositories are skipped. The lowest open PR whose title names the whole ticket
is relinked in Linear, the handover, and its agent session, then handled in the same poll.
Archived linkless records use the same 14-day relevance window; no worker branch is changed
by discovery.

**Partial landings.** When the ticket's recorded pull request lands (merged, or closed by the
queue as above) while other pull requests of the ticket are still open (the rest of its stack,
or pull requests the agent replayed onto main), the ticket links the lowest of them (the one no
other open pull request of the ticket sits on; ties go to the lower number), the agent panel
and the handover record point at it, and the plugin watches and nudges it from the next poll,
also for an archived agent. This repeats with each landing until none of the ticket's pull
requests is open. The ticket's pull requests are the ones whose title names it as a whole word
(`Add TUC-34 [area] …` is TUC-34's, never TUC-343's). A lookup or link move that fails, or a poll
that ends before it (a rate limit), is retried on the next poll, also across restarts.

**Replacement pull requests.** When the queue lands part of a stack, Graphite deletes the
landed branch, and GitHub closes the pull request based on it for good (it cannot be reopened
onto a deleted base). For a ticket's pull request closed without merging, the plugin looks for
an open pull request from the same branch in the repo's open pull requests on every poll; when
there is one, the ticket links it, the agent panel and the handover record point at it, and the
plugin watches it from the next poll. Without one, the closure is looked at once: when the base
branch is gone, the agent is told once, as one `sh` block on the top branch of its stack, to
replay the rest of its stack onto main from the landed branch (`git rebase --update-refs --onto
origin/main <landed branch>`), `git push --force-with-lease` each replayed branch, open a new
pull request onto main whose body links the old one, and `gt track <branch> --parent main`; the
same builder writes the open stranded stack's instruction above. It is claimed and delivered like
a nudge; a gone or archived agent's message
starts a successor or, when none can, goes to the ticket. After that request an archived agent's
closed pull request stays watched for its
replacement until 14 days pass without activity.

**Stalled pull requests.** Agents often stop before their pull request reaches the merge queue.
On each poll, an open pull request whose agent is idle gets the next step of its lifecycle as a
new message, the first that applies:

| Stage | When | Next step sent |
|---|---|---|
| Draft | a draft with no new commit and no pull request activity for 30 minutes | run the background Sol review if not done, then publish only the reviewed part of the stack, bottom first: `git switch <branch> && node tools/ci/publish.mjs` once the branch and every branch below it are reviewed and each passed `verify:pre-pr --body-file` (`publish.mjs` is the only way to publish: it refuses until PR metadata is green and prints any owner question). **Exception (owner, Q-29, 2026-10-05):** a branch whose local `verify:pre-pr` was killed from outside, timed out, or failed twice only on tests unrelated to its change may be published without a passing receipt. Everything else still holds: only the reviewed part of the stack, bottom first; the branches above stay drafts. In order: (1) write the evidence into each such PR's `## Verification` section, outside code fences: `- CI is the proof: <killed \| timed out \| failed twice on unrelated tests> — <evidence>` (for `failed twice on unrelated tests`: `run 1: …; run 2: …; unrelated because …`); (2) make sure every branch up to this one is reviewed and none of the ticket's questions to the owner is still unanswered; (3) run `git switch <branch> && node tools/ci/publish.mjs --ci-proof`, which still checks everything else, and run it again until it publishes. CI is the proof; continue to the merge. |
| Failed checks | a ready pull request whose latest run of a check failed (pending runs and `Graphite / mergeability_check` do not count) | the failed checks with links; fix, then `gt submit --stack` |
| Base conflict | GitHub confirms the pull request conflicts with its base (`mergeable: CONFLICTING`; a mergeability GitHub is still computing never counts) | the branch, head and base; rebase only the agent's own stack onto the current base, run the checks and resubmit the way the repository's AGENTS.md prescribes; never `gt sync` or `gt restack`, never another ticket's branches, never an enqueue around the parent |
| Changes requested | a reviewer's latest approving, change-requesting or dismissed review asks for changes (on any commit), or GitHub's review decision is "changes requested" | each such review and the unresolved review threads; address them, then `gt submit --stack` (for a review on an earlier commit: reply on its threads and re-request the review) |
| Findings | unresolved review threads a bot started (Greptile, any bot reviewer) | the findings; run the AGENTS.md review loop |

The stages look at the ticket's recorded pull request and, where the repository's pull request
titles name their ticket (tuchel-platform), at its **connected stack**: the open pull requests of
the same repository, from branches of that repository (never a fork's), whose titles name the
same ticket as a whole word (`TUC-1`, never `TUC-10`), joined to the recorded one by exact
base → head branch edges, below and above it. The repo's
trunk and another ticket's pull request end the stack and are never nudged; a pull request of the
ticket that is not on the chain is not part of it. Every member is a candidate, bottom first,
whatever the recorded one's position, so a green pull request waiting for a red, conflicting or
unreviewed one below it (the ops digest's "green; waits for #N") gets that one repaired, and so
does a blocked branch above the recorded one. Each member keeps its own stages, claims and budget
in `pr-watch.json`; members are only nudged: their reviews are not mirrored into the ticket, their
merge queue drops are not claimed here, and the ticket's link does not move. Before anything is
sent the whole stack is read and checked; it falls back to the recorded pull request alone, and
the log says why once, when the branches are not one plain chain (a base branch without an open
pull request, a branch two open pull requests share, two of the ticket's pull requests on one
branch, a cycle), when a member cannot be read or no longer matches the listing (state, head,
branch, base), or when a hold covers any member: `do-not-merge`, a drop escalated to you (also
the third drop from before drops had kinds), a merge queue message still to deliver, the head a
genuine drop left, or another ticket's record linking it (compared by repository and number,
whatever the URL's spelling). While the stack is deferred its other pull requests are not
nudged, so a permission wait of theirs starts from zero once they are again. In a repository
whose titles carry no ticket identifier only the recorded pull request is nudged. A ready pull
request gets no nudge:
the [queue backstop](#queue-backstop) enqueues it.

Nothing is sent for a pull request labelled `do-not-merge`, while [manual tasks](#manual-tasks)
due before the merge are open, while the merge queue has it (its last Merge activity bullet
queues it, runs its CI or merged it, or an open queue draft lists it), or while a merge queue
drop is being handled; these are settled before review threads are read. An agent gets at most
one message per poll: merge queue drops of all its pull requests come first, then nudges, so the
pull requests of one stack take turns; within a connected stack, the first member whose step went
(or tried to go) to the agent ends the poll's pass, so a busy or waiting agent is asked about one
pull request at a time. Each stage is claimed per head right before it goes out:
a new head can be nudged again, at most twice per stage and pull request. Requested changes are
claimed per review instead: a change request is sent once, however many commits follow it (it
keeps holding the merge until the reviewer settles it), and a new request is sent again. The next time that
stage stalls, you get one comment instead ("Paseo asked the agent 2 times to …"), and after
that only the log. A busy or disconnected agent is asked on a later poll; a gone or archived
agent's nudge starts a successor or goes to the ticket like a drop's fix request (it counts toward
the same two).
Review threads are read (GraphQL, every page) only when a stage needs them.

**Gone agents.** A nudge, merge queue fix request (the queue backstop's refused enqueues
included) or replacement request for an agent that is archived or no longer exists starts a
successor: a new agent on the ticket's recorded branch and worktree, which gets the handover of
the previous agent's reports and, as the last part of its first prompt, "Paseo started you
because the pull request needs this now:" with the message. It is claimed right before the start
and counts like a message sent (the two nudges per stage, the drop limits), so a pull request
that keeps stalling still reaches you. The ticket's panel shows "The agent was gone; Paseo
started a successor (agent 1a2b3c4d) on `<branch>` and asked it to …"; it gets its own thread,
the gone agent is archived and the handover record names the successor. When no slot is free
(blockers, the agent limit, memory, away mode) or another start of the ticket is under way, the
message waits and is judged again on the next poll, without a comment. When another live agent of
the ticket already runs, it takes over the record and gets the message on the next poll. When no
successor can start (the ticket is closed, no branch is recorded, the branch cannot be
continued, the start fails), the message goes to the ticket as before: back to In Progress and a
comment mentioning you. The same happens for a pull request labelled `do-not-merge` and while
*Start a new agent automatically* (see **Write back to Linear**) is off. A crash right between the claim and the
start (the plugin stops in that second) loses the message: the log names the claim, and it is not
repeated.

**Native process ownership.** `CLOSED`, archive and a closed-process error do not prove an OMP
worker exited. Native thread starts, automatic resumes, successor dispatch
and recovery prompts check all same-ticket root snapshots, including archived ones, while
holding the start gate. Exact native session identities are compared with the local process
listing; sessionless or ambiguous RPC workers also require an exact worktree-cwd check
(`/proc` on Linux, `lsof` on macOS). A live or unobservable terminal worker leaves recovery
pending, before any dispatch claim, send, reload or launch. The check never kills a process,
removes a worktree or changes a branch.

**Waiting for your answer.** An agent waiting for your answer or approval takes no message, so
the pull request waits with it. When a nudge, fix request or replacement request has waited 60
minutes for such an agent, you get one comment, "The agent has waited over 60 minutes for your
answer while the pull request waits for it to …", and the message counts as escalated (the
stage's nudges, the drop, the replacement request then only reach the log). The wait is kept in
`pr-watch.json` across polls, restarts and a busy or disconnected agent, and starts again for a
new head, review or stage, or once a message went out.

**One start per ticket.** Every automatic start (the trigger label, a new thread on the ticket,
the automatic resume, a successor) takes the ticket's start gate
and checks for a live agent first, so two of them never start two agents for one ticket. One that
finds the gate taken waits: the label stays for the next poll, a thread is queued with its comment
and joins the agent once it runs, a project restart is retried on the next read, the automatic
resume leaves you the "Resume with a new agent" offer, a successor waits for the next poll.
Sidebar starts retain their existing user-controlled launch behavior. Answering "Resume" now
also takes the ticket gate and checks native process ownership before starting another agent.

*Rollback.* Reverting the change stops new successors; agents already started keep running until
archived (`paseo ls`, label `linear.issueId`), and the messages they got count as sent. Switching
*Start a new agent automatically* off stops new successor starts at once; successors already
running keep running. A message claimed for a successor that never started (the log line "is
claimed; starting a successor" without a following "started a successor") is repaired by sending
its step to the ticket's agent by hand.

**Ghost agents.** After a daemon crash the daemon lists the agents it had loaded with their last
status, idle or running, although no process works for them any more (2026-10-05: `spawn ps
EAGAIN` crashed the daemon on server087, twenty agents stayed "running" for 16 hours, and the
TUC-949 planner was never restarted). Such a ghost never takes the next step, so the planner
restart, the restart of a failed start, the check for a live agent above and the slot count behind
*max agents* do not count it: an OMP agent shown idle or running, not updated for five minutes,
with no `--mode rpc-ui` process carrying its session and none running in its worktree, counts as
stopped. Without that, the ghosts of the run before would fill the slots of the restarted daemon
and refuse their own replacement starts (2026-10-08: 26 of 43 counted agents were ghosts, and a
restart reported `Queued: RAM-limited, 43 of 40 slots used`). The log names each
ghost (`agent … shows running but its OMP process is gone`). Only proven absence counts: an agent
without a recorded session file or worktree, or a process table that cannot be read completely,
keeps the agent live until the next poll.

**Crashed agents.** An agent whose provider process exited or closed (Paseo shows it in error,
for example "OMP RPC process is closed") receives no message. Before a nudge, a merge queue fix
request or a replacement request goes out, the watch reads the agent: a crashed one is restarted
the way `paseo agent reload` does it, keeping its conversation and worktree, and then gets one
message that names the crash, tells it to run `git status` and finish or abort an interrupted
rebase, and repeats the step it was about to be asked for. The agent panel shows "The agent had
crashed (…); Paseo restarted it …". A restart counts as a nudge for its stage even on an
unchanged head, so an agent that crashes on every turn still reaches the owner after two. When
the restart fails, the attempt still counts; a fix or replacement request then goes to the ticket
(no successor: the agent still exists). A busy agent, an agent waiting for an answer, and an agent whose ticket has
another live agent (for example a successor the automatic resume just started) are never
restarted. If the message does not go out after the restart (the agent is busy right away, the
send fails, or the plugin stops), it is sent on a later poll, at least once: a duplicate is
possible, so the message asks the agent to check its state first. It is dropped unsent once the
ticket is no longer started, another agent took it over, or the step went to the owner.
An agent whose ticket has no open pull request (none yet, or the last one merged or closed) is
restarted the same way while its ticket is in a started state: up to two restarts, then one
comment to the owner, then nothing. The state lives in `$PASEO_HOME/linear-tickets/crash-recovery.json`.
A plan request (see `plan` label) waits until the watch restarted the agent.

**Silent and stuck agents.** A ticket agent that stops making progress is recovered by the
watchdog ([`server/watchdog.ts`](server/watchdog.ts)), which runs first in every two-minute poll
of the pull request watch. It judges each ticket's current root agent (never a subagent) and
walks it through bounded steps, each one leaving a line in the agent panel (else a ticket
comment):

| Situation | Step | Next look |
| --- | --- | --- |
| Running, no progress for 45 min | OMP `/steer` (the turn keeps running): report the lifecycle step and continue it — "Watchdog: asked the silent agent to report and continue." | 20 min |
| Still silent | Stop the turn (waiting up to 60 s for it to end), then a resume that runs `git status` first — "Watchdog: stopped the silent turn and asked the agent to continue." | 20 min |
| Still silent | Stop if needed, reload the agent (`paseo agent reload`), resume — "Watchdog: reloaded the silent agent and asked it to continue." | 20 min |
| Still silent | Retire the agent (Stop, archive), prove no OMP process of the ticket remains, start a successor on the recorded branch and worktree — "Watchdog: started a replacement on the recorded branch." | 20 min |
| Closed or idle for 2 h, ticket open, no open pull request, nobody waited on | One resume ("continue the lifecycle step you were on"); an agent that cannot be loaded goes to the replacement step — "Watchdog: asked the stopped agent to continue the lifecycle step it was on." | 20 min |
| A ghost (see **Ghost agents**) | The replacement step at once | 20 min |
| No progress after the last step, or a predecessor that cannot be proven gone within 20 min | One comment mentioning you: "Automatic recovery could not restore progress on this ticket. Please take over." No further agent. | — |

A failed step says so ("Watchdog: <action> failed; <reason>.") and the next step follows.
Progress means a new assistant message, tool start or tool result on the current branch of the
agent's OMP session file (its public persistence handle), or of a subagent's transcript while
the root waits on it; a user message, a title, a reload's bookkeeping or the file's time stamp
alone never ends a cycle (a recent message or file change only postpones the first step). Only
OMP agents with a readable session are judged: other providers, a missing, malformed, cut or
future-dated session, or a process table that cannot be read leave the agent alone and log why.

Nothing is done while the agent waits for you (a question, a permission, a plan review, a
waiting handover record, a "Needs you" sub-issue, the ticket in Needs input or carrying
`<label>-needs-you` or `<label>-hold`; a closed or idle agent also while one of its ticket's
manual tasks is open), while the ticket is done or canceled, carries
`do-not-merge` (the ticket or any open pull request of it; pull requests that cannot be read
count as a veto), is queued, forwarded to the peer, handing out sub-issues, parked or approved
for later, paused for deletion, or has two live root agents. A quiet agent kept out this way is
judged again 15 minutes later, not every poll (each judgement reads Linear and GitHub), so its
recovery can start up to 15 minutes after the reason ends. Your Stop in Linear holds the ticket
until you reply, resume or open a new thread: it is saved before the Stop goes out and survives
reloads. Every step is re-checked inside the ticket's turn and start gate right before it, and
claimed in `$PASEO_HOME/linear-tickets/watchdog.json` before its effect. A claim whose outcome a
restart lost is never repeated: the next step follows after its window, and an unproven
replacement is awaited by its label (`linear-tickets.watchdog`) or ends with the mention. A turn,
message or session the watchdog did not cause (yours, another nudge's) ends the cycle; new
progress ends it too. At most two cycles start per ticket in any 24 hours; a third silence gets
the mention once and nothing more until the agent makes progress or you continue. A corrupt or
unreadable `watchdog.json` stops all recovery (it is never reset). Unloading the plugin stops new
steps; a step in flight finishes under a host-local lease the next instance waits for.

The ticket's watchdog history (cycle starts of the last 24 hours, an exhausted budget, a
forwarded replacement's cycle) travels with every activation a draining host forwards (see
**Drain one host into another** under [Native Linear agent](#native-linear-agent)), and the receiving host saves it before the agent starts,
so a transfer never resets the budget. A ticket that arrives without it (an older peer) is not
recovered for 24 hours; the forwarding host stops recovering it. A replacement for the peer is
claimed before it is forwarded, carries the recorded branch, its exact commit, the dirty state
and the handover (see **Drain one host into another** under [Native Linear agent](#native-linear-agent)),
and never falls back to a local start.

**Watchdog** has its own switch, independent of *Start a new agent automatically*, and is on by
default. Turn it off, or change the minutes (whole numbers 1–1440), with `linear.set-settings`:
`"writeback": { "watchdog": false }` and `"watchdog": { "silentMinutes": 45, "steerGraceMinutes": 20,
"recoveryGraceMinutes": 20, "idleMinutes": 120 }` (omitted fields keep their value). Turning it
off stops further steps; it does not undo a step already taken. To roll back, revert the change
and reload the plugin; keep `watchdog.json`, which holds the claims and budgets. A long quiet
command (a build, a test run) without output can be interrupted after 45 minutes: raise
`silentMinutes` where that is normal.

**Health.** Every 5 minutes the plugin checks the Linear key, the Paseo app, Tailscale Funnel
and the local receiver. A problem confirmed twice opens one urgent ticket, "⚠️ Paseo needs
attention", assigned to you (in the first auto-dispatch team), so Linear notifies you. The ticket
is updated while problems change and completed when all checks pass again. Failed Linear writes
caused by outages (HTTP 5xx, rate limits, network) are retried after 30 s and 2 min.

**Durable record and resume.** Every ticket agent keeps one "Paseo progress" comment, edited
in place: phase, branch, last commit, links, latest report. When the agent fails or is
archived while the ticket is open, it also posts a final report. For a failed agent,
*Start a new agent automatically* (see **Write back to Linear**) can start a replacement.
Other failures retain the hourly retry; when its cap or another start prevents that, the panel
offers **Resume with a new agent**. Rate/usage limits follow the durable schedule below.
Archiving alone never starts one: for an open ticket without another agent, the panel offers
**Resume with a new agent**.
Assigning Paseo again, @mentioning it or re-adding the label
also resumes. The new agent continues on the same branch, reusing the old worktree while it
exists so uncommitted work survives. It starts with a handover of the previous agent's reports,
and the old agent is archived. The ticket's links, its pull request among them, stay on the
record, so the pull request watch keeps following them; only "Open in Paseo" moves to the new
agent. The record changes owner at a takeover only while it still names the old agent (or none):
once the new agent wrote to it, the old agent's archive leaves it alone, and the old agent's final
report then only says who took over. A third agent's record is never touched.

**Usage-limit resumes.** With the automatic-start switch on, a failed turn whose error says
429, rate limit or usage limit is checked against the OMP broker's `/v1/usage` reports. A fresh,
measurable shared window is required: stale (>30 min), empty, tier-only or unknown readings
never prove room. The agent's model and configured `retry.fallbackChains` are considered,
including matching tier windows; exact selector keys and prefix `*` keys are supported, role
keys are not. OMP chooses the account and fallback model, not the plugin.

If any candidate account has room, a replacement starts on the next minute sweep. Otherwise
it waits until the earliest account reset (the latest exhausted window on that account),
plus 1–5 min jitter. Without a broker reset it uses the provider's retry hint plus jitter,
or 30 min when neither is known. Every basis waits at least 15 min after the previous claim.
At most four limit restarts are claimed per ticket in a rolling 24 h **on each host**, separate
from the hourly retry for other errors; a fifth gets the usual Resume offer.

The schedule, incidents (kept eight days) and provider episodes live in the owner-only,
atomically written `$PASEO_HOME/linear-tickets/limit-resumes.json`. Reloads preserve them.
Unreadable state fails closed, never resets the budget. Before a due start, the switch, owner
Stop, thread's agent, live successors, deletion, start gate and process ownership are checked
again. A held route returns the claim to the schedule for five minutes later; a peer handoff
counts here as forwarded, with its remote start unverified. A crash between claim and start
is counted but never replayed and makes no Resume offer: the digest still shows the error.

Your reply or Stop cancels a pending schedule durably. Reply and due start take the same ticket
lock: the first wins; a reply arriving during a start reaches its replacement. Stop also holds
later failures until you continue. Turning the switch off makes a due schedule offer Resume
instead of starting.

When fresh shared-window reports show every account of the failed agent's provider used up
for over six hours (including a known reset over six hours away), one waiting ticket gets one
owner mention with the Berlin reset time. Unknown readings neither open nor end an episode;
confirmed room ends it even when no restart is due. Tier-only exhaustion never mentions you.
Failed mention posts retry with a durable marker, preventing another post after a lost reply.
No broker reading means no exhaustion mention.

## Plannotator reviews

Plannotator shows its review URL only in omp's own status line, which Paseo does not display.
The plugin sets `PLANNOTATOR_BROWSER` for every agent session to a small hook
(`$PASEO_HOME/linear-tickets/plannotator/open`). When a review starts, the hook publishes the
review port inside your tailnet with `tailscale serve` (HTTPS, reachable only from your devices)
and hands the review to the plugin. A review that gets a stable link (below) opens no browser tab:
it is listed in the review inbox, which can notify your devices. Only a review without one (`:8444`
not published) opens on the host within a few seconds, after the risk policy has looked at it, and
an auto-approved plan opens no tab either way. When the plugin cannot take the
review (no events directory), the hook opens it itself. The agent's Paseo chat then gets a “Handed off to
Plannotator” row with the link. Agents linked to a ticket also get it in the Linear comment (or
the panel's “Plan review” link), so reviews open on your phone.

**One stable link per agent.** Each review gets its own port, and Plannotator's server stops
once the plan is decided or the agent restarts, so a per-review link goes dead with the next
round. The link the plugin posts is therefore the agent's stable one,
`https://<machine>.<tailnet>.ts.net:8444/review/<agentId>`, served from `127.0.0.1:47832` with
`tailscale serve` (tailnet-only; never Funnel — 8443 stays the only public port):

- while the agent's latest review is running it redirects there, so a link already on Linear
  opens the next review after a re-plan;
- once that review has ended it shows a small “Review closed” page with the outcome (approved,
  sent back or ended) and the ticket;
- an agent the plugin never saw a review for gets 404.

Current-review selection uses the opening timestamp first. When timestamps are equal, the last
publication wins, including a new plan served again at an earlier review's URL. Stable links,
inbox details and actions use that same selection; saved registries preserve it across reloads.

Reviews are tracked in `$PASEO_HOME/linear-tickets/plannotator/reviews.json`. Every 30 s the
plugin checks each open review's server; after two failed checks it removes that review's
`tailscale serve` route and marks the review closed. Only ports recorded there are ever turned
off. When `:8444` cannot be published, the per-review link is posted as before.

**Compressed reviews.** Plannotator serves its review page as one ~25 MB uncompressed file. A
phone outside the Mac's network reaches the Mac through a Tailscale relay, where a transfer that
size breaks off (Safari: "network connection lost"). Each review's tailnet route therefore points
at a proxy the plugin runs on `127.0.0.1:47833`: it picks the review by the port the request came
in on, forwards only to reviews recorded as open, and compresses text responses with brotli (or
gzip), about 7 MB for the page. Event streams, WebSockets and binary files pass through as they
are. The route is switched when the review opens, before its link is posted, and on plugin start
for reviews still open. If the proxy cannot listen, reviews keep their direct, uncompressed route.

**One download of Plannotator per version.** Nearly all of that page is Plannotator's app (a 22 MB
script and a 2 MB stylesheet), the same for every review, but each review has its own port, so a
browser would fetch and compile it again for every review. The proxy therefore moves the app out
of the page to `https://<machine>.<tailnet>.ts.net:8444/plannotator/<sha256>.js` (and `.css`),
named by its content and served from memory with `cache-control: immutable` (brotli, compressed
once). A review's page is then under 1 KB plus the app from the browser's cache: about 0.8 s
instead of 1.2 s on the Mac for a review served by the Mac, and the ~7 MB transfer per review over
the tailnet is gone. The first review after a Plannotator update loads the app once. A page without
the inline app (another Plannotator build) passes through unchanged.

**Review inbox.** `https://<machine>.<tailnet>.ts.net:8444/` lists every review still waiting
for you, newest first and grouped by day (Today, Yesterday, then the date, in the host's time
zone), each with the clock time you got it and how long it has waited (amber after 12 hours), and
the last ten decisions below with their outcome and when they were decided. The header counts the
waiting reviews and how long the oldest has waited. A parked plan the central host serves again
after a restart keeps the time it was parked, and its address. A review
is listed while it is the agent's latest, undecided, was published in the tailnet and its server
still answers; each row opens the agent's stable link. Each waiting row shows the plan's title
(its `# ` heading without the ticket number), its opening paragraph, the
risk rating (see *Plan risk and auto-approval*) as a coloured badge (green impact 0–1, amber 2, red
3–4; planner and advisor combined, as the policy reads it) and why the risk policy left it to
you. Next to the badge, `2 follow-ups` counts the plan's `follow-up` items (filed as tickets on
approval) and **Rule change** marks a plan whose risk section says it introduces a new rule.
Each ticket-backed row also shows its actual Linear **Area** labels, not an area inferred from
the plan's wording. Below it: **Linear ↗** (the ticket), the model that wrote the plan, and the
host it runs on when the inbox lists several. Decided rows keep the title and the chips, and say
`auto-approved` when the policy approved it. Plan details are read once when the review opens
(plans that predate the rating have no badge). The page refreshes in place every 30 s and when
you return to it, keeping your scroll position and search (not while you are writing a note);
when the host cannot be reached it says so and keeps retrying.

A review you decided stays out of **Recently decided** until the decision journal (see
**Decision journal**) carried it out: until then it is listed under **Being applied**, between
the waiting reviews and the decided ones, with `approved — being applied` or `sent back — being
applied` and below it `Applying…`, or after a failure `Last try failed: <reason> · next try
<time>`. The review's own link (`/review/<agent>`) says the same. A decision Plannotator did not
confirm shows `not confirmed by Plannotator`; while its review is still open with the same plan
the plugin sends it again (`Sending it to Plannotator again…`, no buttons). Once the review is
gone or closed without a saved outcome, or its address shows another plan, it gets **Carry it
out** and **Drop it** with the reason, as does a `report not matched to a review`;
`conflicting decisions` gets **Keep this one** and **Carry out the other**, and a conflict found
after the decision was carried out gets **Dismiss**. A record the plugin cannot read shows as
`Unreadable decision record <file>` and is kept on disk. Rows from peer hosts carry their host,
and their buttons are forwarded to it.

- **Plan pipeline** shows preparing, advisor review, publishing, ready, and any queued or
  owner-waiting plans above the review queue. Expand **Pipeline details** for **On the way**,
  **Needs attention**, source health, last real progress, and the last inbox arrival.
  Ready counts the reviews actually reachable in the inbox, not successful submission calls
  or parked records alone. Published plan text is matched by its content hash; restored reviews
  keep their original arrival time. Already-delivered reviews survive planner retirement.
  Submissions without a native content hash inherit the delivered revision, preserving their
  identity across refresh and reload. Delivery supersedes older pending content rather than
  leaving a duplicate publishing row; an older review never resolves a newer submission.
  A legacy decision without a content hash resolves only attempts observed before its actual
  decision time. Submission attempts, including unchanged-content resubmissions, stay distinct.
  Explicit native execution and recorded owner handovers retire predecessor planning; a missing
  agent alone does not. Exact-session agent history clears historical admission rows, while
  explicit requeues and undelivered owner messages remain pending.
  Owner questions, permissions and admission queues are legitimate waits. Local handover and
  Needs-you records identify owner waits even after a session retires, without transferring that
  wait to an unrelated successor. Twenty minutes without observed assistant/tool progress is
  suspected quiet work, not proof of failure. Normal session disposal warns about unfinished
  planning rather than declaring a crash. Actual submission/delivery errors, abnormal exits,
  confirmed stopped unfinished planners and provider rate limits remain failures; rate-limit
  diagnostics show a recorded retry delay without retrying the provider.
  Direct project planners with current persisted usage-limit recovery instead show
  **Waiting · Normal**: “Usage limit: restart scheduled for {Berlin date and time}.
  Recovery is checked when automatic dispatch is active and the project is eligible.”
  This is the saved schedule, not proof a restart occurred; disabled dispatch or a removed
  project trigger retains the wait without launching. Dates are always included in Berlin time.
  An unconfirmed launch says “Usage-limit restart requested at {Berlin date and time};
  waiting for agent confirmation.” A retained claim followed by another recorded limit failure
  shows the new saved deadline instead. Held recovery is **Needs attention**:
  “Automatic planner recovery stopped; owner action required. Use Plan or Skip.”
  Initial failed launches stay visible without an agent link. Exact project/run/root ownership
  prevents transferring a wait to a ticket planner, another run or a late duplicate.
  Successful replacements supersede predecessor waits; recorded approvals or run closure
  complete them. Missing records/agents alone never prove closure. Reload revalidates the saved
  observation against current project evidence, and unreadable recovery or malformed saved
  ownership removes the restart promise as **Unknown**. A ghost predecessor with a genuinely live
  duplicate stays unconfirmed until ownership is reconciled. Owner-source failures also keep
  recovery Unknown. Submission alone never preserves an obsolete restart promise after root loss;
  actual submission/delivery failures remain visible across reload even when that root is absent.
  Delivered reviews, owner waits and newer actual progress keep precedence; polling does not count
  as progress or recompute the schedule.
  Missing, unreadable, unsupported, incomplete, stale or unreachable evidence is **Unknown**,
  never an all-clear; known failures remain visible.
  Auto-approved, completed, superseded and explicitly cancelled revisions are accounted for,
  rather than left indefinitely on the way.
  Monitoring is read-only: it never restarts, resubmits, approves or rejects agents.
  Each host samples public agent metadata, provider-native OMP session paths, and existing local
  request/session/parked/owner records in bounded background reads every 30 seconds. HTTP reads use the cached
  observation; fetching the inbox does not advance progress or the successful source-check time.
  Bounded history backfill starts unknown. State and revision history survive plugin reloads in
  `$PASEO_HOME/linear-tickets/plan-pipeline.json`; peer inboxes without pipeline support are unknown.
  Refresh preserves expanded details, search/cursor position and the full Plannotator frame.

- **Search reviews** filters waiting plans and recent decisions by ticket, plan title or summary,
  Area, host, model, outcome, or `rule change`. Words match together, ignoring case. Matching
  counts replace the section counts and empty day groups disappear; the app badge and header
  still count every waiting review. Search never reloads or closes the selected Plannotator pane.
- **Approve / Send back** on each waiting row decide the review as on its page: approve at once,
  or send back with the note you type there. It goes the same way as **Approve plan** / **Send
  back** in the Linear panel, so a parked plan moves on and an agent's own review gets its answer.
  Only the inbox's own page can send these (a custom header, no cross-site requests).
- **Recheck landscape** sends the plan back with a fixed request to check current code and main,
  open and recently merged PRs, related Linear issues and plans, and other active reviews. The
  planner must cite evidence, resolve overlap or conflicts, revise the direction where necessary,
  explain changes, get a fresh advisor review of the revised text, and resubmit. This is feedback,
  not an automated approval or permission to implement; subsequent reviews still require you.
- **Delete plan + issue** is available on waiting reviews with a verified Linear ticket. The
  confirmation names that ticket and requires typing its identifier exactly. It removes the
  waiting plan and uses Linear's normal issue deletion (moves the issue to Trash, not archive
  or permanent purge), stops its queued work, and prevents stale reviews or cached starts from
  reviving it. A refused deletion leaves the review actionable; a deletion that succeeded but
  still needs local cleanup says so, and retrying completes cleanup without deleting twice.
  Deletion state is saved in `linear-tickets/plannotator/deletions.json`, so the pause and
  completed-deletion guard survive a restart. An inconclusive Linear response keeps work paused;
  retry requires a fresh check of the captured ticket identity. A missing or inaccessible ticket
  is not treated as proof that deletion succeeded.
  If the agent publishes a replacement during that fresh identity check, deletion stops with
  “The waiting review changed while its ticket was verified; nothing was deleted.” This also
  applies to equal-time publications: the issue and replacement stay available, and the owner
  must review the replacement before trying deletion again.
- **Review pane on a wide screen.** From 1100 px wide the list sits on the left and a row opens
  its review on the right, inside the inbox: the full Plannotator page (annotate, comment, Approve,
  Send Feedback), as on its own tab. Each review you open keeps its page, so switching between rows
  keeps unsent annotations; it closes once the review leaves the list (not while a peer is
  unreachable). The address ends in `#<agentId>`, so a reload reopens it; **Open in new tab ↗**
  above the pane and Cmd/Ctrl-click on a row open the review on its own. Narrower screens (the
  phone) open the review as before. Resting the pointer on a row for a moment starts loading its
  review out of sight, so the click mostly finds it loaded.
- **All hosts in one inbox.** List the other hosts' inboxes in `reviewPeers` in
  `$PASEO_HOME/linear-tickets/settings.json` (no toggle), e.g.
  `"reviewPeers": ["https://server087.<tailnet>.ts.net:8444"]`, and this inbox shows their waiting
  reviews and decisions too, each marked with its host; a decision on one of them is passed to its
  host. A peer that does not answer is named at the top. Each host reads the others over the tailnet
  (`/api/inbox`), so the same list is on every host that names its peers.
- **Notifications.** **Notify me** subscribes the browser (Web Push): each review that starts
  waiting, here or on a peer, arrives as one notification that opens it, and the app icon shows the
  waiting count. Reviews already waiting when the first browser subscribes are not announced. On an
  iPhone, first add the inbox to the Home Screen (Share → Add to Home Screen) and tap **Notify me**
  there; iOS allows web notifications only for Home Screen apps. The keys and subscriptions are kept
  in `$PASEO_HOME/linear-tickets/plannotator/push.json` (private); a subscription the push service
  drops is removed. Subscribe on one host's inbox: each host notifies its own subscribers.

With status write-back on, a ticket moves to its team's started state named **Planning**
when a plan is handed off (and stays there when it is sent back), and to **In Progress** once
the plan is approved. Create a “Planning” state of type *started* in the team for this; teams
without one are left alone.

When a review is decided, the omp plan extension (`~/.omp/agent/extensions/plannotator-omp-plan.ts`)
records the plan and your feedback. The plugin then adds a chat row and, for ticket agents,
replaces the ticket's “Plan: <ticket>” document with the reviewed plan, and comments the outcome
with a link to it. Plannotator's own plan mode only reports approved hand-offs, so plans sent
back from that mode are not recorded. Without Tailscale the local link is used. Agents that
started before this feature need a new session to get the hook.

## Auto-dispatch

With **Auto-dispatch** on in the Paseo Agents menu bar app's Control panel, the plugin polls Linear (every 60 seconds by default,
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
comment saying why; fix the cause and add the trigger label again. Stale `<label>-running` and
`<label>-failed` labels are repaired on their own (see **Repairing stale running and failed
labels** under Projects).

Paseo gives plugin code its daemon connection only inside RPCs and lifecycle hooks, so
polling starts at the first of these after the plugin loads: opening the ticket surface,
saving a setting, or any agent or workspace activity on the host (agents resumed after a
daemon restart count). The Paseo Agents menu bar app's Control panel shows the last poll,
its error and the most recent dispatches.

## Write back to Linear

For agents carrying the `linear.issueId` label (every agent started from a ticket, manually
or dispatched), **Write back to Linear** in the Paseo Agents menu bar app's Control panel can report their lifecycle on the ticket
written as the Paseo app (see [Who Linear shows as the author](#who-linear-shows-as-the-author)),
independently of the agent's own `linear_ticket` tools:

- **Status** — the agent's first turn moves the ticket into its team's In Progress state,
  following the same rules as the launch-time setting. A completed or canceled ticket is left
  as it is: an agent still working after its merge closed the ticket does not reopen it.
- **Turn summaries** — each completed turn's final reply is posted as a comment (capped at
  4,000 characters), a failed turn posts its error, and archiving an agent that never linked
  a pull request says so.
- **Blocked alerts** — when the agent waits for you (a question, a plan approval, a
  permission still pending after a moment, or a turn that ends by asking you), the ticket
  shows it three ways, also when the agent panel asks:
  - it moves to the team's **Needs input** workflow state (type Started; create it in the
    team's workflow settings, teams without it skip this step),
  - it gets the red `<label>-needs-you` label (created on first use), handy for a saved
    "Waiting on me" view,
  - one comment @mentions you, so Linear notifies your inbox and phone. It names the
    question, its options and how to reply. Like every plugin write it comes from the Paseo app,
    so Linear notifies you (it does not notify you of your own mentions). It mentions whoever
    opened the agent's Linear session, else the ticket's creator when a person wrote it, else you.
  Further questions in the same wait edit that comment. Once nothing is pending (a follow-up
  question arriving within seconds keeps the wait open), and when the turn ends or the agent
  is archived, the label comes off and the ticket returns to its previous state, unless
  someone moved it out of Needs input meanwhile. The next wait gets a fresh comment. A
  failed turn adds `<label>-blocked`, which marks errors only; the next completed turn
  removes it. Started agents are asked to put everything they need from you (answers,
  decisions, approvals, secrets, manual steps) into one question request.
  As a fallback, a completed turn whose final reply ends by asking you (a question, or a
  phrase such as "needs your OK", "once you decide" or "reply "yes" and I'll") opens a
  wait too; the comment quotes that part of the reply. It lasts until the agent's next turn
  starts. Plan approval requests are left to the plan review.
- **Waits after the ticket closed** — a merge commit's `Closes` moves the ticket to Done while
  its agent may still need you (a deploy decision, a step after merge). A closed ticket stays
  closed: the wait opens a **"Needs you: …" sub-issue** instead, in Needs input (Todo on teams
  without it), assigned to you, explicitly in the parent's project, with the `<label>-needs-you` label and the mention comment.
  Further questions in the same wait edit that comment, and while the sub-issue is open the
  agent's later waits on the ticket reuse it. It is closed for you when the question or
  approval is answered (in Paseo or in Linear), or when you comment on it, which
  goes to the agent that asked. A wait that ended otherwise (for example the agent's next turn
  started) may be a manual step, so that sub-issue stays open until you close it. Archiving the
  agent leaves its open sub-issues for you; replies there no longer reach anyone.
- **Pull requests** — GitHub pull request URLs printed by the agent's completed shell
  commands during a turn (for example `gh pr create`) are attached to the ticket, the agent
  panel and the handover record, and the ticket then moves to its team's started state named
  like *In Review*, but only for a pull request of that ticket: `gh pr view` on this host
  finds it, and its title, description or head branch names the ticket identifier as a whole
  word (`Part of TUC-123`; `TUC-12` does not name `TUC-123`). Test fixtures, which
  `gh` cannot resolve ("no such pull request", or a repository that does not exist or this
  host's `gh` cannot see), and real pull requests of other tickets are skipped, each with a
  plugin log line `[linear-tickets] not linking <url> to <identifier>: <reason>`, and a turn
  that printed only skipped URLs leaves the ticket where it is. A skipped URL is checked again
  in any later turn that prints it. An agent links any other pull request itself with
  `link_url`. Completion is left to Linear's GitHub integration and to the agent itself
  ([Agent access to Linear](#agent-access-to-linear)).

- **Start a new agent automatically** — its texts are "Start a new agent automatically when one fails (after a usage limit when it resets, at most 4 a day per ticket on each host; other failures at most once an hour per ticket), or when its pull request needs work after it is gone" (on) and "Offer Resume in Linear when an agent stops; a gone agent's pull request work goes to the ticket as a comment" (off). Limit failures use **Usage-limit resumes**; other failures retain the hourly retry and Resume offer. Archiving an agent never starts one by itself. A nudge, merge queue fix request or replacement request for an archived or missing agent can start a successor under the conditions in **Gone agents**. When off, a failed agent gets the offer and that pull request work goes to the ticket as a comment mentioning you. This switch does not govern the watchdog's replacements: those follow **Silent and stuck agents** and its own **Watchdog** switch.

- **Replies from Linear** — your comments reach the agent within one poll interval, no
  `@paseo` needed, on every issue it watches:
  - its ticket (the newest active agent on it) and its "Needs you" sub-issues;
  - the issues it filed with `create_issue`, until one gets an agent of its own;
  - the threads it started with `add_comment` on other issues: your replies there reach it,
    other comments on that issue do not.

  A comment on another issue than its ticket arrives prefixed with that issue's identifier
  ("Comment on TUC-9, the issue you filed: …", "Reply to your comment on TUC-7: …"). If the
  agent is waiting on a question, the comment is the answer (an option name picks that
  option). If it is waiting on an approval, `approve` / `deny <reason>` decides it. Otherwise
  the text is sent as a message. Its reply comes back as a turn summary (or its own comment),
  so the conversation stays in Linear. Delivered comments get a 👀 reaction; undeliverable ones
  get ❌ and a reply saying why, and a comment handled twice is not delivered again, nor to a
  later question ([Answers to agent questions](#answers-to-agent-questions)). All watched issues
  are read in one request per poll, each from
  a cursor kept in `$PASEO_HOME/linear-tickets/relay-cursors.json`, so neither a restart nor a
  long pause delivers a comment twice or skips one. Comments by other people are ignored, and
  so are the comments the agents and the plugin wrote themselves, even when they show you as
  the author: the `linear_ticket` server records each comment it posts (and each issue it files)
  under `$PASEO_HOME/linear-tickets/agent-comments/` (`agent-issues/`), and the plugin records
  the comments it had to write with your key because the Paseo app could not be used. Any
  other comment written as you counts as yours, including one another agent posts through a
  Linear connection signed in as you. Without a usable Paseo app, Paseo's comments are written
  as you, so only comments that start with `@paseo`, replies to a Paseo app comment and replies
  in an agent's thread count. Blocked alerts end with how to reply. With the Paseo app
  installed, Linear turns a typed `@paseo` into a mention of the app: that comment, and any
  reply in that agent session's thread, reaches the agent through its agent session right
  away, with the same question and approval rules, and the relay leaves it alone.

Archiving a linked agent always removes `<label>-running`. Subagents never report. Paseo
delivers lifecycle events live and best-effort: events while the plugin is stopped are not
replayed, and a Linear failure is logged (`paseo plugin logs linear-tickets`) without
affecting the agent. A write-back that hits Linear's rate limit waits for the quota instead
(see [Rate limits](#rate-limits)).

## Ticket state in the sidebar

Each workspace with a ticket agent carries one workspace label naming its ticket's current Linear
state, for example `Linear: In Review`. The sidebar shows it as a chip next to the pull request
badge. Labels that start with `Linear: ` belong to the plugin. When the state changes, the old one
is removed, and workspaces without a ticket agent lose theirs. Other labels are never touched.
The colour comes from the state type: triage orange, backlog indigo, unstarted sky, completed
emerald, canceled red. Started states are split by name: review violet, merge teal, planning blue,
needs input pink, and anything else, such as In Progress, amber. A workspace whose agents work on
different tickets shows the ticket its name carries (`TUC-1: …` or a `tuc-1-…` branch). Otherwise
it shows the ticket of its oldest agent.

States are read about once a minute in one batched Linear request, on the app's pool like the
other polled reads. A state the plugin sets itself shows at once, and a new agent's workspace is
labelled within seconds. The plugin SDK cannot set workspace labels, so this uses the daemon's
internal `workspace.label.*` protocol. It connects to the local daemon the way the `paseo` CLI
does: the address in `$PASEO_HOME/paseo.pid` and `PASEO_PASSWORD` when the daemon needs one.
A daemon without that API, or a lost connection, is logged once per cause and affects nothing
else.

## Label rules

The plugin can keep label groups current on every issue of some teams, for example an `Area`
group (`Quality`, `Sales`, …) and a `Type` group (`Bug`, `Feature`, …). Linear allows one label
per group on an issue, so each issue gets one area and one type. The rules live in
`$PASEO_HOME/linear-tickets/label-rules.json`. Without that file nothing runs.

```json
{
  "teamKeys": ["ENG"],
  "groups": [
    { "name": "Area", "inherit": true, "labels": [
      { "name": "Billing", "color": "#059669", "description": "Invoices and payments.",
        "paths": ["acme/app/**/billing/**"], "projects": ["Payments v2"],
        "keywords": ["\\binvoice", "payment"], "title": ["^BILLING:"] }
    ] },
    { "name": "Type", "labels": [{ "name": "Bug", "title": ["\\bfails?\\b", "^SENTRY:"] }] }
  ]
}
```

For each issue and group, the first piece of evidence that decides wins:

1. **Pull requests.** The files changed by the GitHub pull requests attached to the issue, as
   `owner/repo/path`, are matched against each label's `paths` globs. `**` spans directories, `*`
   and `?` stay within one. Each file counts for the first label, in file order, whose globs match
   it, so put specific globs in earlier labels. The label with the most files wins. Files no glob
   matches count for nobody.
2. **The parent's label** of the group, for sub-issues, when the group has `"inherit": true`.
3. **The project**, when a label lists the issue's Linear project in `projects`.
4. **Keywords**: case-insensitive regular expressions. Each `keywords` pattern scores 3 in the
   title and 1 in the description, and each `title` pattern scores 3 in the title only. The
   highest score wins.

A tie keeps the label the issue already has when it is among the best. Otherwise the next step
decides. With no evidence the issue keeps what it has, and nothing is ever removed without a
replacement. Pull request files are read with `gh`, up to 150 pull requests per cycle. Merged
and closed ones are kept in `$PASEO_HOME/linear-tickets/pr-files.json`, and open ones are read
again after 30 minutes.

**Labels people choose stay.** Before it changes an issue's label, the plugin reads the issue's
history. If the last change to that group's labels was not the Paseo app's, it leaves the issue
alone. The same goes for an issue that got its label when it was created. To hand an issue back
to the rules, remove the group's label and let the plugin set it once. That is why it writes only
as the [Paseo Linear app](#native-linear-agent) and waits while the app is unusable. It also
leaves issues alone for their first 3 minutes: Linear does not record label changes made in that
window.

**Groups are made in Linear.** A missing group or label is created as a workspace label with
the configured colour and description. An ungrouped workspace label with a configured name is
moved into its group, keeping its issues. A label that already belongs to another group is logged
and left out. Linear refuses to group labels that share an issue, so remove one of them from such
issues first.

Every 2 minutes, the plugin reads the issues updated since the last cycle. Every 30 minutes, or
while issues are still undecided, it reads all of them. All of this runs at background priority on
the app's pool. Each change is logged as `label rules: TUC-12 Area/Quality (pull requests)`.
Editing the file takes effect at the next cycle.

## Rate limits

Linear meters **requests and complexity points** per credential and hour:

| Pool | Requests/hour | Complexity points/hour |
|---|---:|---:|
| Personal API key (shared by that user's keys) | 2,500 | 3,000,000 |
| Paseo app token (per app user) | 5,000 | 2,000,000 |

Both dimensions refill steadily. The plugin reads `X-RateLimit-Requests-*` and
`X-RateLimit-Complexity-*`, estimates refill since each dimension's last sample, and reserves
in-flight requests and their estimated points. `X-Complexity` updates the pool's average query
cost (EWMA, starting at 100 points). A dimension not learned yet does not restrict admission;
a missing header leaves its last sample unchanged. Whichever dimension resumes later sets the wait.

**Usage per caller.** `linear.agent-status` includes `usage`: `since`, `until`, `pools` and
`rows`. Each row names the credential pool (`app` or `key`), caller and GraphQL operation,
with sent `requests`, measured `points`, and `unmetered` requests whose cost is unknown
(missing/invalid `X-Complexity`, including network failures). Local budget refusals count
neither a request nor points; Linear's error responses do count. The totals cover at most
60 minute buckets, including the current partial minute, and reset when the plugin reloads.
Calls are counted when their fetch settles. Caller context follows awaited work and timers;
nested callers override it. Unscoped requests are labelled `op:<operation>`.

The caller names distinguish dispatch, project flow, comment relay, label repair, PR watch,
session-sweep parts, session webhooks, lifecycle write-backs, sidebar reads, health, manual
tasks, state labels, label rules and plan handling. Each pool also includes the most recently
observed request/complexity limits and remaining budget, with `observedAt` (not an extrapolation).
Once an hour the plugin logs totals split into plugin and agent MCP sources, and its twelve most
expensive caller/operation rows. Counters cover this daemon's GraphQL transport, including
managed agents' `linear_ticket` requests through its broker (callers `mcp:<tool>`); other hosts
and host scripts are **not** attributed. Hourly history adds a partial outside estimate only for
isolated fresh header intervals (see below), never as exact per-caller attribution. Exact counts
hold within a running broker and its graceful drain; a crash can lose the last minute of usage,
which is never reconstructed from reservations.
No tokens, query bodies or ticket text appear in the report.

- **Reads that pollers repeat use the app's pool** when the Paseo app is installed: the relay's
  comment read, the auto-dispatch label query, ticket state, manual-task status, the sidebar
  state labels, the agent session sweep and the label rules' sweeps. The key reads them only when the app is not installed, its token cannot be
  refreshed, or it cannot see a ticket. An app rate limit never falls back to the key. Writes use
  the app's pool too; the key writes only in the cases listed under [Who Linear shows as the
  author](#who-linear-shows-as-the-author). Managed `linear_ticket` requests share daemon
  admission through the private broker; daemon and agent MCP traffic are attributed separately.
- **The session sweep's per-session reads follow the webhooks.** It still lists Linear's open
  agent sessions every minute (one request, shared by the parts of a sweep that need it), because
  that is how a session whose `created` webhook was missed is found, but it reads a session's
  activities only when they are due: at most every 5 minutes while Linear webhooks for that
  session, at once when such a webhook arrives with the read due, and every minute once no webhook
  has arrived for 5 minutes (a session that was never webhooked for keeps the minute sweep). With
  22–35 live sessions this is `1 + N/5` requests a minute instead of `1 + N`: about 320–480/h
  instead of 1,380–2,160/h while every session is covered. `linear.agent-status` reports
  `webhooks` (delivered since the plugin loaded), `sweepReads`, `sweepSkips` and `webhookReads`;
  `sweepSkips` against `sweepReads + sweepSkips` is how much of the saving the webhooks actually
  cover.
- **Waiting threads are read in batches.** Every sweep checks each queued thread (waiting for
  blockers, a slot, or a live OMP worker of its ticket to exit) for a session that ended in Linear
  and, once nothing local holds it, for a ticket moved to Done or Canceled. These reads used to
  be one request per thread: on server087 on 2026-10-07, 62 waiting threads (55 behind a live OMP
  worker) made `session-sweep.queued threads` 1,678–1,951 requests an hour, 34–39% of the app's
  5,000. Now the sweep reads all waiting threads' session states up front, 50 aliased
  `agentSession` lookups per request (`sessionStatuses`, about 2 points each), and the first
  thread that needs its ticket's state reads it for every later thread in one `issueStatuses`
  request. Those 62 threads cost 2 + 1 requests a sweep instead of 62 + 7, plus the unchanged
  dependency read of `starter.admission` for each of the 7 that reached it. A session Linear no
  longer has makes Linear refuse the whole batch; its alias is dropped, the rest are read again,
  and that thread is read alone as before. Anything a batch does not return is read alone, and a
  failed batch fails each thread's check as its own read did. The per-thread order, gates and
  outcomes are unchanged; the states are read up to one sweep pass earlier than before.
- **Three priorities reserve room for owner intent on both dimensions.**
  - Background work leaves **20%**: auto-dispatch, comment relay, project flow, label repair,
    health, label rules, manual tasks, plan requests, PR watch, queue backstop, state labels
    and the session sweep. Polls resume as the budget refills; the sweep skips its whole round
    while paused. Auto-dispatch shows `paused: …`, and persistent pauses are logged once per pool/cause.
  - Interactive agent work leaves **5%**: progress write-backs, session replies and sidebar reads.
  - Owner work may use the final **5%**: plan approval/send-back (review page, inbox and Linear
    panel, including split and approve-later), plan follow-up filing and its retry worker,
    ticket status changes, and owner questions (panel prompt, Needs input, label and comment).
    The whole operation runs at owner priority, prerequisite reads included. A turn-end question
    is delivered before ordinary progress work, which still leaves the owner's reserve untouched.
    Nested work never lowers priority. Pending session links are only recorded after successful
    delivery; a reserve refusal leaves them for the next sweep.
- **Reservations capture their cost at admission.** Pending requests do not resize when another
  response changes the daemon's average complexity. Overlapping responses cannot restore capacity
  from an older, higher remaining header. A missing dimension retains a pessimistic debit; an
  unknown send retains its reserved debt even when later headers arrive. Owner work keeps its
  priority and recovery probe. Reserved-but-unsent work can be cancelled without recording traffic.
- **When Linear answers `RATELIMITED`**, every priority waits at least one minute. After that,
  reserve admission runs before the single probe slot: background or interactive work below
  its reserve cannot steal the owner's probe. Only one eligible request probes; a network
  failure releases its slot, an answered success clears the block, and a limited probe doubles
  the backoff up to 15 minutes. Background still waits for its 20% share to refill.
  Rate-limit refusals of Plannotator events and plan follow-ups retry at the advertised resume
  time without consuming an attempt; already-created tickets and relations stay recorded.
  Non-parked decisions are deduplicated only after delivery succeeds, so a refused hand-off
  remains retryable. Crash-safe journaling of partially applied decisions remains TUC-1288.
- **Hourly usage is persisted** in `$PASEO_HOME/linear-tickets/linear-usage.json` (version 1,
  mode 0600), atomically every minute and on unload, with eight days retained. It counts answered
  requests, complexity points (missing costs estimated separately), local reserve refusals,
  upstream limits, minimum remaining fractions, elapsed blocked time and spend by caller/pool.
  Corrupt input starts empty with a warning; persistence failures do not block requests.
  Unload drains admitted Linear responses and the PR watch's in-progress runs before its final
  flush. Initial turn-start status changes run before ordinary panel progress; a refused
  prerequisite read leaves that transition eligible for retry.
  `linear.agent-status` adds `sources` (plugin and agent MCP totals) to each usage pool,
  `budget.pools` with both dimensions, block/pause times, and `budget.hours` with each pool's
  current-hour top ten callers, plugin/agent MCP totals over every caller and outside estimates.
- **The ops digest's “Linear budget” section** shows the last full UTC hour per pool, its top
  three callers, its plugin and agent MCP totals (`none recorded` for hours before the broker,
  never a measured zero), and every limited or blocked hour in the last seven days with its
  largest spender. Limited hours within 24 hours also become non-attention `linear: limit reached`
  history items, once per pool/hour, for the weekly review. Missing/unreadable usage is reported
  under `linear_budget`, keeping previous items rather than failing the digest.
- **Outside shared admission is an estimate, not a complete meter.** Scripts, other hosts and
  the digest use the same credentials without daemon admission. Their spend appears as
  “≈ outside shared admission” only between fresh (at most five minutes), non-overlapping own
  responses carrying that dimension's headers. Observation coverage is shown separately for
  requests and points; gaps and concurrent requests are unobserved, not zero outside spend.
  Negative corrections are retained in the file but displays clamp at zero. A different host's
  app is a separate pool, not part of this estimate. These external callers can still consume
  the owner's reserve. Hours before the broker keep their old estimate, which then also held
  agents' tools; it is not relabelled as measured agent MCP use.
  The laptop's digest aggregation, menu-bar budget view, comment webhooks and one-week budget
  review are separate follow-ups. Status batches request only the number of IDs in each chunk.
  Review inbox metadata reads only issue id, identifier and labels; queued threads read only
  the workflow state before capacity admission. `starter.admission` still checks dependencies
  and merged-review blockers using the full state query. On 2026-10-07 the old full state read
  measured 498 points, while `issueStatuses` measured 4: declared page size is not measured cost.
  PR discovery reads only attachment URLs (the same first 50 as before); watchdog exclusions
  read only workflow state and labels. Both retain app-first reads, access fallback to the key
  and propagation of app rate limits without key fallback. Discovery's repository/title matching,
  ambiguous-repository refusal and watchdog owner/hold/veto exclusions are unchanged.
  A read-only production probe on this ticket measured the new attachment-URL query at
  4 points and the watchdog state/label query at 5 points (2026-10-07); costs vary with data.
  A steady Mac interval on 2026-10-07 (11:11:13–11:22:46 UTC) measured PR-watch state reads at
  307,266 points, 81.15% of daemon points; label-history reads were second at 45,084 points.
  Comment relay used 2,188 points, disproving the original comment-relay estimate for that host.
- **Write-backs are not dropped.** A rate-limited write-back is retried when the pool refills,
  for up to 6 hours. A retry that a newer event for the same agent overtook only links its
  pull requests: those are kept in `$PASEO_HOME/linear-tickets/writeback-outbox.json` until
  they are linked on the ticket, in the agent panel and in the handover record, even across
  restarts. Retries never repeat a comment or panel activity that already went out. A pull
  request is checked ([Pull requests](#write-back-to-linear)) before it is linked anywhere: when
  GitHub cannot be reached (network, auth, throttling, a timeout) the write-back is retried
  after 30 s and 2 min, and the entry stays in the outbox for the agent's next turn with a pull
  request or the next plugin start; a URL `gh` cannot resolve, or one that does not name the
  ticket, is dropped from the outbox with its log line. An entry already attached on Linear
  before this check existed and now rejected gets `; already attached on Linear; remove it by
  hand` in that line.

## Pull request view

The Paseo Agents menu bar app shows a repository's open pull requests, the Graphite merge queue
and what landed on the default branch. The plugin reads them for it through the routed `gh`
([GitHub automation identity](#github-automation-identity)), so the login has one GitHub poller
instead of two:

- `linear.pull-requests` (`{ repository: "owner/name" }`) answers from memory at once: open pull
  requests with their labels, a CI summary of each ready one's head (the newest run per check;
  runs a later run of the same workflow superseded and Graphite's `mergeability_check` left out;
  a failed gate named only when no job failed; the start of the oldest check still running), its
  merge queue state from Graphite's Merge activity comment (queued, testing in round `#n`,
  merged, dropped with Graphite's reason, removals in the last 24 hours), the open queue rounds
  (`[Graphite MQ] Draft PR`s) with their CI, and the commits of the last 24 hours. Draft pull
  requests are listed but not read in detail.
- `linear.label-pulls` (`{ repository, label, numbers }`) adds a label to each pull request as
  the automation bot, stopping at the first one GitHub refuses, and returns the snapshot with
  the new labels.
- A repository is polled at most every 2 minutes, and only while a client asked for it in the
  last 10 minutes: with the app closed, the plugin sends GitHub nothing. Reads are REST only
  (GraphQL stays with `gh pr` and `gt`) and conditional, so an unchanged page answers
  `304 Not Modified` and costs no budget.
- The account router owns both accounts' request budgets and picks the read account per call
  ([GitHub automation identity](#github-automation-identity)); the plugin records no quota of
  its own, and a refusal says which budgets are spent and when they resume. Without the router
  (a host with one `gh` login) polling runs at background priority instead: while fewer than 300
  REST requests are left before the login's hourly reset, it pauses until the reset and keeps the
  last data (`rateLimited` in the snapshot), and after GitHub refuses a request for its rate
  limit nothing is sent for 2 minutes. Labelling is not held back by the reserve.
- The [pull request watch](#pull-request-reviews) reads the same way: through the router's read
  account where it is installed, under the single-login reserve where it is not; its conditional
  first look (the issue resource, its comments and reviews, the head's checks) keeps a quiet pull
  request to its cached view rather than reading it in full.

## Manual tasks

Some steps only a person can do: environment variables and secrets, Railway, Linear, GitHub or
Paseo settings, webhooks, integrations. Agents register each one with `add_manual_task` instead
of leaving it in a comment. Each task is a **sub-issue of the ticket, assigned to you** (the
owner of the plugin's key), explicitly in the parent's project, with the steps in its description and one of three due points:

| `when` | Created in | Effect |
|---|---|---|
| `before_merge` | Todo | Blocks the ticket. An approved pull request keeps the ticket in *In Review* instead of *Ready to merge* until the task is done |
| `after_merge` | Backlog (Todo on teams without one) | Moves to Todo when the ticket's pull request merges |
| `anytime` | Todo | Due now, never gates anything (for example "before the production release") |

A task with the same title as an open sub-issue is not created twice. Within about a minute,
new tasks get the orange `<label>-manual` label and the ticket gets one comment that @mentions
you and lists them, written as the Paseo app so it reaches your inbox and phone. Once the pull
request merges, one more mention lists what is due now and any before-merge task that was
still open. Merging on GitHub is never blocked; the gate is the ticket state only. Archived
agents stay watched until their after-merge tasks are due.

**Checks.** A task can carry a shell command that exits 0 once the step is done, for example a
script that confirms a Railway variable exists. When you mark the task done, the plugin runs it
(no stdin, 60 s timeout, in the agent's worktree, or your home directory when that is gone):
a pass comments "✓ Verified", a failure moves the task back to Todo and mentions you. The
output only goes to `paseo plugin logs linear-tickets`, never to Linear, since it could hold a
secret. A before-merge task marked done still gates until its check passes. The command is
read only from `$PASEO_HOME/linear-tickets/manual-tasks/<task>.json` (private, written by the
agent's MCP server); editing the Linear description never changes what runs. Checks run as the
daemon's user, the same trust as the agent's own shell.

A saved Linear view of label `<label>-manual`, assignee *me*, status not completed or canceled
lists everything waiting on you. Keep the team setting that closes a parent when all its
sub-issues are done **off**, or finishing the tasks closes the ticket.

## Decision candidates

Once a week the owner's decisions made outside plans become proposals for the rules that bind
later work. Nothing becomes a rule until the owner answers each proposal.

**What is collected.** For a window of normally 7 days: feedback on plan reviews (sent back and
approved, from the plan documents, the `Plan sent back` comments and the local log), the owner's
answers to agents' questions (the local log, `Needs you` sub-issues, replies after a "waiting for
an answer" comment) and the owner's own comments on tickets an agent worked on. Comments the
plugin or a ticket agent wrote with the key are left out by their records under
`agent-comments/` (kept 35 days), and so is everything on candidate tickets themselves.

**Local log.** Answers given in the Paseo app and earlier review rounds leave no lasting trace in
Linear (the plan document is replaced every round), so the plugin appends them to
`$PASEO_HOME/linear-tickets/owner-decisions/log.jsonl` (directory `0700`, file `0600`): every plan
review decision with feedback (`plan-feedback`), every question request (`question`) and its
resolution (`answer`), also with write-back off. Entries older than 60 days are dropped. A failed
write is logged and never stops the review or the question.

**Window.** `collect` covers from the checkpoint of the last successful `file` (at most 28 days
back) to now, otherwise the last 7 days, and never before `coverageFrom` in
`owner-decisions/state.json` (the first run minus 7 days, since older key-written comments have
no record left).

**Runbook for the weekly agent.** The schedule `decision-candidates` (Mondays 07:00
Europe/Berlin) starts an agent in a scratch folder with these steps:

1. From the plugin folder (`~/dev/paseo-plugins/linear-tickets`) run
   `node --import tsx scripts/decision-candidates.ts collect`. It prints the window's items, each
   with its `sourceId`, link and the owner's words; every earlier candidate ticket with its
   comments; the full register (`approved.md`, `decisions.md`, `decision-queue.md` from
   tuchel-platform's `origin/main`); open tickets that mention `docs/principles`; and the files
   holding the agents' rules (this README, the launch template in `settings.json`). The first
   line names the batch (`--batch <until>`).
2. Sort each item: **general** is a rule for future tickets or for other places than this one;
   **one-off** settles only that ticket. Drop one-offs. Comments the owner's own assistant
   sessions wrote through his Linear account show him as author and cannot be told apart (no
   record, no bot marker): take such a report (a status, findings, a summary) as a decision only
   where it states the owner's decision, and quote that part.
3. Drop general items already covered: by `approved.md`, by `decisions.md` (approved **or
   rejected**; judge statement, scope and rationale, not words), by `decision-queue.md`, by an
   earlier candidate ticket, by an open register ticket, or (Agent tooling) by this README or the
   launch template. A rejected decision is never raised again.
4. Merge duplicates and route each to a project: `ERP` (rules of the platform) or
   `Agent tooling` (how agents work).
5. Write the input file and run
   `node --import tsx scripts/decision-candidates.ts file --batch <until> --input <file.json>`
   (first with `--dry-run`):

   ```json
   { "projects": [{ "project": "ERP", "candidates": [{
     "title": "Lists sort newest first", "type": "principle",
     "wording": "Every list in the ERP sorts newest first unless the page says otherwise.",
     "scope": "All list pages", "question": "Make this a principle?",
     "options": "Approve / reject / change the wording", "recommendation": "Approve",
     "evidence": [{ "sourceId": "comment:…", "url": "https://linear.app/…", "quote": "the owner's words, verbatim" }]
   }] }] }
   ```

   `type` is `principle`, `conflict` or `exception`. Every candidate needs at least one evidence
   entry with a collected `sourceId`, an https link and the owner's words quoted verbatim. An
   empty `projects` list files nothing and still closes the window.
6. Never edit a repository and never write Linear except through `file`.

**Filing.** `file` writes only as the Paseo app (`agent-app/token.json`); a missing, expiring or
rejected token stops it before or at the first write, never a write with the key. Per project it
files at most one ticket per run: *Decision candidates, week <n>*, marked
``Marker: `decision-candidates <project> <year>-W<week>` `` in its description. A candidate whose
key (derived from its evidence: source ids and quotes) is in any earlier candidate ticket of that
project is skipped; new ones go into that week's open ticket or, if there is none (or it was
closed), into a new one (`run 2`, ...). Proposals are numbered `Q-<n>` after the highest number in
the register and in earlier candidate tickets. Created tickets go into the team's Todo (Triage is
never handed out) and through the project's normal
pickup. The checkpoint moves only once every project was filed; a rerun of the same batch files
nothing twice. One lock (`owner-decisions/lock`, taken over by one run after 30 minutes) keeps
two runs apart. A run that dies inside the milliseconds it checks or replaces the lock leaves
`owner-decisions/lock.guard`; it is never removed automatically, and runs fail naming it until a
person removes it with no run active.

**Answers.** The ticket tells its agent to ask the owner each proposal, post
`**Q-<n> answered** — approved | rejected | changed | deferred: <the owner's words>` per answer,
and record them: for ERP one tuchel-platform pull request following `docs/principles/README.md`
(`D-N` each, `P-N` for approved principles, `Q-N` in the queue for deferred ones); for Agent
tooling a change to this README or the launch template. The ops digest shows
`Decision candidates waiting: N`: proposals of open candidate tickets without such a comment.

**Undo.** Pause or delete the schedule; tickets already filed are closed by hand.

## Ops digest and weekly ops review

The ops digest (`ops/paseo-ops-digest.py`, Python stdlib) is an hourly job on **server087**
that publishes the Linear document "Ops digest" (project Agent tooling): the merge queue,
drops, pull requests open > 5 h, deploys, and the Paseo agents of this host and of every host
in `~/.paseo/ops-digest/remotes` that are in error, wait on the owner, are silent for > 2 h or
hold a ticket's running label without an agent. Inside Mon-Fri 08:00-19:00 Berlin it comments
on the document as the Paseo app, mentioning the owner, with the problems not delivered yet (at
most 25 items plus counts per kind, never more than `NOTIFY_MAX_CHARS`). Each scheduled run also
starts tuchel-platform's *Flaky quarantine* workflow (`gh workflow run flaky-quarantine.yml
--ref main`, TUC-614); a failed start is logged and never stops the digest. Raw log and error
text never reaches Linear or the history: errors are reduced to categories, and each line names
the local command that shows the details. The script's docstring describes one run in detail.

Owner-needed project planners are read directly from `linear-tickets/projects.json` on every
host, even when no agent exists or the planner's Linear notification failed. Items identify the
owning host, project and run, use the saved project name when available (else its UUID), and tell
you to use Plan or Skip there. Error text is reduced to a category. The `planners` source is
independent of agent/repository reads: unreadable state, unreachable peers and older peers without
planner snapshots retain that host's previous items as stale rather than clearing them. Missing
local state means no failures. Recovered, replaced, approved and closed runs clear the old item;
undelivered notifications remain pending under the existing delivery policy.
The menu bar app includes owner-needed planners in **Needs your input** and its count, with Plan
and Skip on the selected tickets host. Temporary errors scheduled for recovery do not enter that
list. A failed status read keeps the previous list, marked stale; an absent or archived planner's
Open action still links to its owning host.

Scheduled limit restarts show `in error: rate limit (resumes at HH:MM)` in Berlin time
(`DD.MM. HH:MM` on another day), still requiring attention. The host snapshot's `limitResumes`
field keeps remote agents' own times; an older remote script shows the bare error until updated.
The history kind remains `agents: in error: rate limit`. A local incident whose resolution is
`started` counts as **Plugin acted**; pending, cancelled, claimed and forwarded schedules do
not. A one-week post-release check uses the minute-precise restart record, not hourly samples:
outside full exhaustion across all candidate models, median failure-to-start must be <30 min;
unrestarted qualifying failures count as never cleared, forwarded ones remain unverified.

**Planning without Plannotator's instructions.** On 2026-10-07 omp re-ran its
`before_agent_start` handlers and dropped the first round's messages, so Plannotator's planning
instructions never reached 34 planning agents on server087 and their plans came out in the wrong
layout. The digest reads every host's omp session files (`~/.omp/agent/sessions/<cwd>/*.jsonl`;
subagent transcripts in deeper folders are skipped) that started in the last 24 h
(`PLANNING_WINDOW_S`, from the file name; files not modified within it are not opened) and reads
each only up to its first assistant message. A session counts when it has the plan-first launch
marker (`linear-tickets.plan-first`, reason `launch`), an assistant message, and no
`plannotator-framing` message before that first assistant message (instructions that arrive later
count as missing). Each such session is one attention item, keyed by host and session id
(`planning-missing:<host>:<session id>`), so the owner is notified once; it clears when the
session leaves the 24 h window. The line names the host, the ticket (from the launch prompt's
`Work on the Linear ticket TUC-N` / `continuing work on Linear ticket TUC-N`, else the worktree
folder, else `project planner`), the start in Berlin time and what to do: check that plan's layout
and send the plan back if it lacks the instructions' layout. History kind:
`planning: instructions missing`.

The digest also reads each host's planning smoke result,
`~/.paseo/linear-tickets/planning-smoke.json` (version 1, written by `npm run smoke:planning`).
A failed check (`ok: false`) is one attention item per host and checked setup
(`planning-smoke:<host>:<fingerprint>`) naming each failed `check` and its `detail` (reduced to
plain words) and the command to run the smoke check again by hand once fixed; history kind
`planning: smoke check failed`. A passed check gives no item; a missing file means the smoke check
has not run on that host yet (no item, no failure). An unreadable or invalid file, an unreadable
sessions folder, an unreachable host or an older host snapshot without `planningSessions` /
`planningSmoke` (category `not in host snapshot`) is that host's `planning_sessions` or
`planning_smoke` unit not read: only that host's previous items stay, marked stale. Both appear
in the document's **Planning without Plannotator's instructions** section.

**Project planners (usage-limit recovery).** The digest reads `projects.json` once per host/run.
Scheduled waits show `usage-limit restart scheduled (at …; subject to automatic dispatch and the
project trigger)`, claimed attempts show `usage-limit restart in progress`, and an exhausted
recovery held for the owner shows `usage-limit recovery held for owner`. These rows name the
project/run, not an inferred ticket. An existing failed-root error gains the Berlin-time
`(resumes at …)` suffix only for a matching scheduled wait on its own host, never a held or
claimed attempt. Existing errors still require attention; the additional planner rows never
notify the owner.

Explicit confirmations show `usage-limit restart confirmed (at …)`: a replacement was created
or a new live root with a claimed `linear.plannerRequest` label was adopted. This is **not**
confirmation that the plan finished. Run/request evidence is deduplicated and retained for
eight days, pruned on project updates and filtered when read even for untouched closed projects.
Counters, failed/uncertain claims, ordinary starts and old unlabeled agents earn no inferred
success. There is no reconstruction of restarts before this evidence existed.
Malformed confirmation evidence is preserved and marks recovery reporting unavailable; it
cannot block automatic recovery or Plan/Skip. No usable success history is inferred from it.

The additive `plannerRecovery` version-1 snapshot exports only project/run/request/root IDs,
state and timestamps, never error text, plans, ticket lists, selectors or credentials. Local
planner collection and remote attempts do not depend on successful local agent or Linear reads.
A delivered remote snapshot with unreadable planner data refreshes its agents but retains its
planner rows stale. A failed agent/permission collector leaves `plannerRecovery` unavailable and
its recovery rows stale; the independently delivered `projectPlanners` owner alerts and explicit
`agentSource` failure outcome introduced by the host-ownership work stay intact. Missing/old/
unknown-version recovery fields and unreachable hosts mean not-read, not an empty successful
source. Each host's old rows are retained independently as “not refreshed since”.

History keeps the existing fixed fields and digest observation time; producer `confirmedAt`
is display/evidence data, not an exact restart timestamp exported in history. Confirmed rows
have `auto=true`; scheduled/claimed/held rows do not earn restart credit, and held rows have
`owner=true`. Explicit same-host completion can credit the failed-root error, without guessing
about unrelated remote automation. These non-attention rows do not count as recurring problems
or change unrelated weekly problem trends.

Isolated verification uses disposable project files, fake SDK/Linear adapters and a localhost
usage broker with the real `ProjectFlow`, `ProjectStore`, `Launcher`, `UsageReader`, Python
snapshot/digest/history and weekly reader. It checks a scheduled wait, two confirmed starts,
Skip closure, JSON transport and exactly-once history without production agents or publishing.
Regression checks: `node --import tsx --test server/project-flow.test.ts server/ops-review.test.ts`
and `python3 -m unittest discover -s ops -p 'test_*.py'`. After pulling/reloading the server,
use the read-only commands below; the Mac's snapshot runs from its checkout once the switch-over
under **Mac** below is done (TUC-1253).

Once a week the review (`scripts/ops-review.ts`) reads the digest's history, files one ticket
per kind of problem that keeps coming back, and checks two weeks after such a ticket is Done
that the kind got at least twice as rare, reopening it otherwise.

**Files (server087).**

- `~/.paseo/bin/paseo-ops-digest.py` and `~/.paseo/bin/test_paseo_ops_digest.py`: symlinks into
  `~/dev/paseo-plugins/linear-tickets/ops/`, so a merged change goes live with the checkout's
  next `git pull --ff-only`.
- `~/.config/systemd/user/paseo-ops-digest.{service,timer}`: `/usr/bin/python3
  %h/.paseo/bin/paseo-ops-digest.py` at minute 5 of every hour; log `~/.paseo/ops-digest.log`.
- `~/.paseo/ops-digest/state.json`: items, pending notifications, the document id and the
  history outbox (below).
- `~/.paseo/ops-digest/tuchel-platform/`: detached worktree of `~/paseo/tuchel-platform` at
  `origin/main` (`OPS_DIGEST_REPO` overrides the clone); the digest runs its
  `tools/ci/ops-digest.mjs --json` (limit `REPO_SCRIPT_S`, 600 s).
- `~/.paseo/ops-digest/remotes`: one SSH target per line, today `mirko@100.81.37.89` (the Mac
  over Tailscale). The server reads the Mac's agents with `~/.ssh/id_ed25519_ops_digest`; on the
  Mac that key is restricted to `command=...--agents-json` and can run nothing else. A Mac that
  is asleep keeps only its own items (stale); server087's items still refresh.
- `~/.paseo/ops-digest/history.jsonl`, `history-YYYY-MM.jsonl`, `history-backfill.jsonl`: the
  history. `trend.json`, `review.lock`, `review-creates.json`: the review's.
- Credentials, read only: `~/.paseo/linear-tickets/credentials.json` (the key: reads and the
  document) and `~/.paseo/linear-tickets/agent-app/token.json` (the Paseo app: the notification
  comment; used only while valid for 5 more minutes, never refreshed by the digest).

**Mac.** The server can only ask the Mac for its snapshot: the restricted key's forced command
runs `~/.paseo/bin/paseo-ops-digest.py --agents-json`, whatever the server sends. That file is a
symlink into the Mac's `~/dev/paseo-plugins/linear-tickets/ops/`, like server087's; the private
copy from before the move is kept as `paseo-ops-digest.py.bak-<date>-mac-checkout` next to it.
Every snapshot names the file and checkout HEAD it ran from (`source`, below); a snapshot
without `source` comes from an old copy.

Switch-over, once, in a terminal on the Mac (about 2 minutes; do the open laptop roll-out tasks
first, since its pull brings their changes too). It checks everything before changing anything
and stops with `STOP: <reason>` on the first failed check. A stop before the pull changes
nothing; a stop after the pull leaves only the checkout moved forward; when the link does not
answer right after switching, it puts the old copy back, or names where the backup is if even
that fails. Running it again is harmless. `K` is the key part of server087's
`~/.ssh/id_ed25519_ops_digest.pub`: the block finds that key's single active line in
`authorized_keys` and, after switching, runs its forced command the way sshd does (the login
shell's `-c`, from `$HOME`). Every program it starts reads `/dev/null`, since bash reads the block
itself from standard input.

```sh
bash -u <<'EOF'
P="$HOME/dev/paseo-plugins"; T="$P/linear-tickets/ops/paseo-ops-digest.py"
L="$HOME/.paseo/bin/paseo-ops-digest.py"; B="$L.bak-$(date +%Y%m%d)-mac-checkout"
K="AAAAC3NzaC1lZDI1NTE5AAAAINRZoRGRaUAjyP4G1YUwPKQD1eIPdSOGEI/RJ4SvlLlD"
stop() { echo "STOP: $*"; exit 1; }
check() {  # $1: command run like sshd runs the forced command; ok when the answer is a full read from the checkout's file at HEAD
  head=$(git -C "$P" rev-parse HEAD) || return 1
  raw=$(cd "$HOME" && "${SHELL:-/bin/sh}" -c "$1" </dev/null) || return 1
  printf '%s\n' "$raw" | HEAD="$head" T="$T" python3 -c 'import json,os,sys
d=json.loads(sys.stdin.read().strip().splitlines()[-1]); s=d["source"]
assert {"agents","metas","permissions","reviews","errorLines"} <= set(d) and d["agentSource"]["ok"] is True, "agent read"
assert d["projectPlanners"]["ok"] is True and isinstance(d["plannerRecovery"], dict), "planner read"
assert isinstance(d["limitResumes"], dict), "limit-resume read"
assert s["script"] == os.path.realpath(os.environ["T"]) and s["rev"] == os.environ["HEAD"], "source"'
}
fc=$(python3 -c 'import os,sys
k=sys.argv[1]; q=chr(34)
m=[l.strip() for l in open(os.path.expanduser("~/.ssh/authorized_keys")) if not l.lstrip().startswith("#") and k in l.split()]
assert len(m) == 1, "the digest key has %d active entries" % len(m)
o=m[0].split(k)[0]; i=o.find("command=" + q)
assert i == 0 or (i > 0 and o[i - 1] == ","), "the digest key has no forced command"
c=o[i + 9:].split(q)[0]
assert chr(92) not in c, "the forced command uses quoting this block does not read"
print(c)' "$K" </dev/null) || stop "cannot read the digest key's forced command"
case "$fc" in *python3*.paseo/bin/paseo-ops-digest.py\ --agents-json*) echo "forced command: $fc";; *) stop "the forced command does not run $L: $fc";; esac
if [ -L "$L" ] && [ "$(readlink "$L")" = "$T" ]; then check "$fc" && { echo "already linked and answering"; exit 0; }; stop "linked but not answering"; fi
for old in "$L".bak-*-mac-checkout; do
  if [ -e "$old" ] || [ -L "$old" ]; then stop "$old exists: a previous switch-over was undone or is half done; look first"; fi
done
[ -f "$L" ] && [ ! -L "$L" ] || stop "$L is not the old copy"
jobs=$(launchctl list </dev/null) || stop "launchctl list failed"
case "$jobs" in *ops-digest*) stop "the old hourly ops-digest launch job is loaded";; esac
branch=$(git -C "$P" rev-parse --abbrev-ref HEAD) || stop "git rev-parse failed"
[ "$branch" = main ] || stop "$P is on $branch, not main"
dirty=$(git -C "$P" status --porcelain) || stop "git status failed"
[ -z "$dirty" ] || stop "$P has local changes"
git -C "$P" pull --ff-only </dev/null || stop "pull failed; entrypoint unchanged"
check "python3 '$T' --agents-json" || stop "the checkout's script does not answer; entrypoint unchanged (the checkout was pulled)"
mv "$L" "$B" || stop "backup failed; entrypoint unchanged"
if ln -s "$T" "$L" && check "$fc"; then echo "switched: $(readlink "$L") at $(git -C "$P" rev-parse --short HEAD)"; exit 0; fi
if rm -f "$L" && mv "$B" "$L"; then stop "the link did not answer; old copy restored"; fi
stop "the link did not answer and restoring failed: the old copy is at $B"
EOF
```

The check before switching runs the checkout's file with the login shell's `python3`; the checks
after switching run the real forced command. The terminal's environment is not sshd's, so the
check from server087 below stays the end-to-end proof. The Mac's old `test_paseo_ops_digest.py`,
if any, stays as it is: the forced command never runs it.

Undo on the Mac (also its own bash block: zsh fails on an unmatched glob). It moves the single
backup back over the link and changes nothing when there is none or more than one:

```sh
bash -u <<'EOF'
L="$HOME/.paseo/bin/paseo-ops-digest.py"; n=0; B=
for b in "$L".bak-*-mac-checkout; do if [ -f "$b" ] && [ ! -L "$b" ]; then n=$((n + 1)); B="$b"; fi; done
[ "$n" = 1 ] || { echo "STOP: $n backups found; nothing changed"; exit 1; }
mv -f "$B" "$L" && echo "restored $L from $B"
EOF
```

Check from server087, through the same SSH path and forced command as the digest's read, with
`<commit>` the commit that must have reached the Mac; then the latest hourly `run` line, so run it
after the first hourly run following the switch (the Mac's `planners@…` unit is `false` on every
run before it):

```sh
rev=$(ssh -o BatchMode=yes -o ConnectTimeout=15 mirko@100.81.37.89 x | tail -1 | python3 -c 'import json,sys
d=json.load(sys.stdin); s=d["source"]; r=d.get("limitResumes")
assert {"agents","metas","permissions","reviews","errorLines"} <= set(d) and d["agentSource"]["ok"] is True, "AC-4 agent read"
assert s["script"].endswith("/dev/paseo-plugins/linear-tickets/ops/paseo-ops-digest.py") and s["rev"], "AC-4 source"
assert isinstance(r, dict) and isinstance(r.get("pending"), dict) and isinstance(r.get("started"), list), "AC-9 limit resumes"
print(s["rev"])') && git -C ~/dev/paseo-plugins fetch -q origin && git -C ~/dev/paseo-plugins merge-base --is-ancestor <commit> "$rev" && python3 -c 'import json,os
runs=[d for d in (json.loads(l) for l in open(os.path.expanduser("~/.paseo/ops-digest/history.jsonl")) if l.strip()) if d.get("event") == "run"]
u=runs[-1]["units"]; h="@mirko@100.81.37.89"
assert u.get("agents" + h) is True, "AC-5 Mac agents unit"
assert u.get("planners" + h) is True and u.get("planner_recovery" + h) is True, "AC-8 Mac planner units"'
```

**Run by hand.**

```sh
/usr/bin/python3 ~/.paseo/bin/paseo-ops-digest.py --print    # render to stdout: no state, no history, no publish
/usr/bin/python3 ~/.paseo/bin/paseo-ops-digest.py --dry-run  # log what would happen: no state, no history
/usr/bin/python3 ~/.paseo/bin/paseo-ops-digest.py --agents-json # read-only local host snapshot
systemctl --user start paseo-ops-digest.service             # one real run
```

`--at <ISO time>` pretends another "now"; `--agents-json` prints this host's agents and sanitized
`projectPlanners`, `planningSessions` (session id, start, ticket) and `planningSmoke` sources for
another host's digest (what the Mac runs for server087; its format is a contract with the remote).
It also carries `source`: `script`, the resolved file that ran, and `rev`, the HEAD of the
checkout holding it (not proof that the file has no local edits; `null` when git cannot answer
within 5 s or the file is outside a checkout). A change to the snapshot reaches the Mac with the
Mac checkout's `git pull --ff-only`; no plugin reload is needed for it, because every call starts
the script fresh. Other plugin changes in that pull keep their own reload steps.

**History.** Every publishing run appends JSON lines, one `run` line and one line per item:

- `{"t", "event": "run", "host", "units": {unit: read?}, "hosts": [...], "items": n}`: every unit
  the run attempted (`repo`, the repository script's own units such as `queue`, `pulls/917`,
  `deploy:production/x`, `agents`, `silent`, `locks`, `planner_recovery`, `planning_sessions`,
  `planning_smoke`, and `agents@<host>`/`silent@<host>`/`planner_recovery@<host>`/
  `planning_sessions@<host>`/`planning_smoke@<host>` for each
  remote), read or not, and every host whose agents were read. It is the proof that a source was
  looked at, whether or not anything was found.
- `{"t", "event": "opened" | "open" | "cleared", "key", "kind", "unit", "first", "attention",
  "section", "group", "ticket", "host", "stale", "owner", "auto"}`: an item that is new, still
  there (`stale` when its source could not be read) or gone. Never a title, detail, command or
  URL. `owner` is `true` when the item waits on the owner or the plugin escalated it to the owner
  (`pr-watch.json`, `crash-recovery.json`), `false` when those records are readable and show
  neither, `null` (unknown) for another host's items or unreadable records. `auto` is `true` when
  the plugin acted on it (pull request nudges, drop handling, queue actions or a Greptile
  re-request; agent restarts), `false` or `null` likewise. Both are read at that run, so later
  changes never rewrite old lines.

`kind` is `item_kind()`: the section plus the detail without parenthesised parts, with `#N` for
pull request references and `N` for every other number (`pulls: draft, not published`,
`agents: running, no activity for N h`; the pulls line `complex-review: no Greptile review yet
(Greptile re-requested 14:05)` stays `pulls: complex-review: no Greptile review yet`). Changing
`item_kind()` starts new kinds; earlier lines keep their wording, and the review compares by the
stored kind.

The lines first go into the state's `historyOutbox` and are saved with the observations, then
appended to the file of their UTC month (`history.jsonl` for the current one,
`history-YYYY-MM.jsonl` for earlier ones) and leave the outbox only once written and fsynced. At
a month change `history.jsonl` is appended to its month's file, then removed. A failed append is
logged (`WARN history not written (<category>)`) and retried by the next run; a torn last line is
cut off before the retry, and lines a file already ends with are not written twice. At most 72
runs wait; older ones are dropped and named by one `gap` line. Nothing is deleted (about 2 MB a
day).

`--backfill-history` (one-off, done on 2026-10-07) wrote `history-backfill.jsonl` from what
`state.json` remembered (open items and recently cleared ones, latest occurrence each, owner and
automation unknown, `"src": "backfill"`), after copying `state.json` to
`state.json.bak-<date>-backfill`. It refuses when that file exists. Backfilled lines have no
`run` lines, so their hours never count as covered: they can show a kind as recurring, never
verify or reopen a ticket.

**Coverage.** A kind's sources follow from its section, not from its incidents, so a kind that
did not happen is still judged. Repository sections need `repo` and their own unit read, with at
most 10 % of their `pulls/<n>` or `deploy:<env>/<service>` sub-units failed; agent kinds need
`agents`/`agents@<host>` (and `silent`/`silent@<host>` for silent agents, `locks` for orphaned
labels) read, judged per host. Planner kinds require their own `planner_recovery` or
`planner_recovery@<host>` unit, independently of agent reads; missing units are unknown coverage.
Non-attention planner notes do not affect headline problem completeness. The review does not know
the `planning_*` units yet: it judges the `planning` kinds like a repository section, by `repo`.
An hour without a `run` line, a `gap` and backfilled hours are
never covered. A window is complete with at least 90 % covered hours and less than 1 % malformed
lines; agent kinds count only the hosts complete in every window compared, and server087 must be
one of them (the Mac asleep at night does not spoil the comparison). Otherwise the review says
"not enough data" for that kind and window.

**Review.** From the plugin folder:

```sh
node --import tsx scripts/ops-review.ts collect          # numbers and the kinds' tickets; writes nothing
node --import tsx scripts/ops-review.ts file --dry-run   # what `file` would do; writes nothing
node --import tsx scripts/ops-review.ts file             # do it (server087 only)
```

Options: `--now <iso>`, `--history <dir>` (default `$PASEO_HOME/ops-digest`), `--team <key>`
(default `TUC`). Exits non-zero on any failure. Per kind of problem that needed attention, for
the last 7 days against the 7 before: count, still open, median and p90 hours to clear, needed
the owner (yes / no / unknown), the plugin acted on it (yes / no / unknown; acting is not proof
it fixed anything), hours open, and whether the data is complete. Headline numbers: problems that
needed the owner per merged tuchel-platform pull request (observed owner involvement, not every
touch; merged counts GitHub's `is:merged` plus pull requests the Graphite queue landed and
closed as `externally-merged`; unknown when `gh` fails), the share of cleared problems that
cleared without the owner (unknowns shown apart), and the median time to clear.

A kind **keeps coming back** at 3 or more problems in the last 7 days (`RECURRING_MIN`). Its
ticket carries ``Marker: `ops-kind <kind>` `` on a line of its own: in the description of a
ticket the review filed (created by the Paseo app), or in a comment of an **adopted** ticket
(an existing fix ticket; anyone may post that comment, archived tickets count too). `file` then:

1. **Creates** *Recurring ops problem: &lt;kind&gt;* in Agent tooling, team Todo, for each
   recurring kind without a ticket, ranked by hours open, then count: at most 3 filed tickets
   per Berlin ISO week (`NEW_TICKETS_PER_WEEK`; adopted tickets never count); the rest is listed
   for next week. The description holds the numbers, examples and "Done when: the weekly count is
   at most half of the week before this ticket closes, measured in the second week after it
   closes". Before creating, the run writes a reservation with a new issue id to
   `review-creates.json` and creates with that id, so a create that timed out and lands later is
   found by the next run instead of filed twice. Only `file` without `--dry-run` reconciles
   reservations.
2. **Comments** once per Berlin ISO week on each open marker ticket with its kinds' numbers
   (``Marker: `ops-review <year>-W<week>` ``), except tickets it filed that week (their
   description holds the numbers). `file --dry-run` names each as "to write" or "already there".
3. **Checks** a completed marker ticket 14 days after it closed: per kind, the week before the
   close against the second week after. At most half: verified; nothing in the week before: "no
   baseline" (neither verified nor failed); more than half: failed. Any failed kind reopens the
   ticket to Todo with the numbers (``ops-review reopen <completedAt>``); no failed kind but a
   window without enough data: nothing is written, the check is repeated next week; otherwise one
   ``ops-review checked <completedAt>`` comment listing each kind.
4. **Reopens on relapse** a checked ticket whose kind later climbs back: at least 3 in a later
   complete week and more than half of its count before the close (or any 3 after "no
   baseline"), with ``ops-review reopen <completedAt> relapse``.
5. Ignores canceled and duplicate marker tickets. A kind with two or more marker tickets that
   are not canceled is a **conflict**: no action, named in the output until a person removes a
   marker.

Every comment carries its marker and is skipped when present, so reruns write nothing twice; a
reopen re-reads the state right before the move and moves only a ticket still Done. Writes go
only through the Paseo app (`agent-app/token.json`); a missing or expiring token stops the run
before its first write, never a write with the key. `review.lock` keeps one `file` at a time; it
is taken over only when it names this host and its process is gone. `file` also writes
`trend.json`, which the digest's next run shows as the **Trend** section of the document (top 5
kinds this week against last week and the headline numbers; "Trend: not computed yet" before
that).

**Schedule.** The Paseo schedule `ops-review` on server087 (Mondays 07:30 Europe/Berlin) starts
an agent in a scratch folder that runs, from `~/dev/paseo-plugins/linear-tickets`, `collect`,
`file --dry-run` and `file`, reports their output, and never edits a repository or writes Linear
otherwise.

**Undo.** Pause or delete the schedule; tickets already filed or reopened are closed by hand.
The digest: `systemctl --user disable --now paseo-ops-digest.timer` stops it (the document stays
and stops updating); to go back to the program before the move, copy
`~/.paseo/bin/paseo-ops-digest.py.bak-20261007-repo-move` (and its test) over the symlinks. The
history files can stay. Before changing a host copy by hand, keep it as
`<file>.bak-<date>-<reason>` next to it.

## Answers to agent questions

Everything the plugin sends to an agent question goes through one checked path
(`server/permission-replies.ts`): your answer from a Linear comment, from an agent session, from a
reply the other host forwarded or queued for a later poll, and the deputy's answer in live mode.
The path decides what the text is (the answer to the pending question, an approve/deny for a
pending approval, or a message), submits it to Paseo and records what came of it. Every
delivery carries one stable ref -- the comment id, the session activity, the queued text, or the
forwarded activation's id -- which is reserved before anything is routed, so the same Linear
activity is never delivered twice and a repeat never lands on a later question.

The dedicated permission connection explicitly negotiates Paseo's `owned_subscriptions`
capability so confirmation is the reply to this submission, not a broadcast saying somebody
answered. Other daemon calls retain the bundled 0.8.0 client's legacy subscription protocol:
its workspace-label subscriptions supply their own IDs, which owned subscriptions reject.
Both connections close on unload. This was exercised against Paseo 0.10.3 on server087.

**Owner first.** An answer of yours that the plugin is already sending beats a deputy answer that
is not yet sent; a deputy answer that reached Paseo first ends yours as a correction. An agent
session's answer with several parts counts as yours from its first part, so the deputy stays out of
that question from then on. The check is plugin-local: the plugin asks Paseo to apply exactly this
answer to exactly this request and waits for Paseo's confirmation, but Paseo does not compare the
question's content for it and names no responder, so an answer given in the Paseo app at the same
moment as a deputy answer can lose.

**What you see.** A delivered answer changes nothing (👀). Otherwise:

- The deputy had already answered that question: your answer goes to the agent as your correction,
  and you get "The deputy had already answered this question (D-1a2b3c4d); your answer went to the
  agent as your correction." An agent session whose collected parts are affected sends all of them
  as one correction.
- Paseo turned your answer down (the question was no longer waiting, or Paseo was already
  processing another answer to it): ❌ and "Your answer was not delivered: the question was no
  longer waiting, or Paseo was already processing another answer to it."
- Paseo did not confirm it (timeout, a lost connection, another error): ❌ and "Paseo could not
  confirm that your answer reached the agent: <reason>. It is not sent again; check the agent."
  Your answer is not counted as yours, and it never answers a later question: if the question it
  was meant for went away, that is what you are told, and a question that arrived in the meantime
  is shown as what it is.

**Handled twice.** A comment, a session activity or a forwarded activation that is handled a
second time (a poll retried after a restart, a repeated forward) is not sent again and never
answers a newer question: the second attempt reports what happened the first time. An attempt that
was interrupted before its outcome was recorded is reported unconfirmed the same way, and is never
sent again either. The records live in `$PASEO_HOME/linear-tickets/permission-replies.json`
(`0600` in the plugin's `0700` directory) and are kept 30 days. Approvals ("approve" / "deny
<reason>") and plain messages are covered by the same records for this replay protection; how they
are sent and who may send them is unchanged.
After a restart, unfinished evidence and Needs you completion for confirmed deliveries are
recovered from that record even when the session has already marked the activity handled.

**Without a checked connection.** On a host where the plugin's own connection to the local Paseo
daemon is missing, your answers are sent as today (fire-and-forget, recorded as unchecked) and are
not counted as yours, and the deputy cannot answer there at all: its live candidate ends `blocked`
with "no checked answer connection to the local Paseo daemon". The forwarded activations and
queued messages that host delivers to its agents are sent and recorded the same way.

**Who counts as the answerer** (only ever after Paseo confirmed the answer):

| Where the answer was given | Through the checked path | Recorded as |
|---|---|---|
| A Linear comment or agent session written as you | always, ahead of the deputy | owner |
| A forwarded or queued activation (no verified author) | always, ahead of the deputy | nobody (`linear-unverified`) |
| The deputy, in live mode | only with no owner answer in flight and the same request still pending | deputy |
| The Paseo app, the CLI, a daemon auto-decision | not at all | unattributed |

**Limits.**

- The pending request's content is compared once more immediately before the submission (its
  fingerprint). A change Paseo makes between that check and its applying the answer is not caught:
  the daemon takes no expected fingerprint.
- A refusal is recognised from Paseo's own message. The two messages that mean "not applied" are
  matched exactly, which depends on the daemon and provider version; every other error counts as
  unconfirmed. An answer Paseo applied but whose confirmation was lost is reported unconfirmed too,
  and is never sent again.
- A correction (a reply in a deputy answer's thread, or `override D-…`, see **Override**) is
  claimed and sent before it is recorded. A crash in that window can lose the correction without a
  ❌ reply, or send it twice; making corrections durable is a follow-up.
- The checked path is the plugin's. On a host without a checked connection the sending stays the
  old fire-and-forget one: the records still prevent a repeat, and nothing confirms that Paseo took
  the answer.

## Deputy for agent questions

Routine questions ticket agents ask the owner can be answered by a deputy, but only when recorded
knowledge decides the answer. Risky, unsupported or ambiguous questions wait for the owner exactly
as before, and the owner always has the last word. Plan, tool and mode approvals are never
delegated.

**Order.** A question is first logged and shown to the owner as before (write-back's settle
window and "waiting for an answer" comment are unchanged). Then, in the background, it becomes a
candidate in `$PASEO_HOME/linear-tickets/deputy/candidates.json` (directory `0700`, file `0600`,
one per agent and request, kept 14 days):

1. **Risk first.** Only a `question` from an agent linked to a ticket the owner wrote (or the
   Paseo app in a flow he started; not `feedback`), whose plan is approved (`plan-ready`) and that
   is not marked attended, qualifies. Every required part needs at least two offered options;
   free text ("Other (type your own)"), multiple choice and parts without options leave the whole
   request with the owner (an optional empty comment stays empty). Words in the title,
   description, any question or any option (label and description, English and German) put it in
   an owner-kept category and refuse it: open business decisions, user-facing wording or layout,
   production data, external accounts or spend, security or permissions, deleting data or
   history, irreversible operations, destructive git, and what the launch template or AGENTS.md
   reserve for the owner (approvals, pushes, labels, settings, manual steps, plans, deploys,
   anything sent outside). The evaluator rates the risk too; anything but `low` refuses, and
   unknown counts as high.
2. **Knowledge second.** Sources, in this order of authority: the ticket's approved `Plan:`
   document; `docs/principles/` (`approved.md`, `decisions.md`, `decision-queue.md`) at one
   `origin/main` commit of `deputy.principlesRepository`; this README, the effective launch template (custom or built-in) and the
   agent repository's `AGENTS.md`; earlier owner answers the plugin itself delivered for the
   authenticated owner (`owner-answer` log entries); Hindsight recall. Only sections sharing words
   with the question are shown. Open proposals (the decision queue), rejected, superseded,
   withdrawn or deferred decisions (every excerpt of such an entry, its subsections included) and
   memories can only block an answer, never decide one. An earlier source that should exist but
   is missing or cannot be read (the plan document of the plan-ready ticket, or one not marked
   approved; the register; recall without access) makes the deputy abstain.
3. **Evaluation.** One OMP call (`deputy.model`, thinking `low`, 150 s deadline) with no tools, MCP
   servers, extensions, skills, rules, memory or saved session, from an empty directory under a
   private OMP agent directory (`deputy/omp-agent/`, only the isolated configuration plus the
   owner's `auth:` block), with no Paseo, Linear or GitHub credentials in its environment. It sees
   only the question, each option with what it says it does (its description), and the excerpts,
   and returns per part an offered option and the sources that
   decide it. Every selection must be an offered option verbatim, every citation must name a
   source that can decide and quote it verbatim (at least 12 characters); a tool event, timeout,
   oversized or unreadable answer, abstention or one failed check refuses the whole request. The
   agent's own "(Recommended)" never decides.

Citations store the source's id, revision (document hash, commit or memory id) and the quote, so
they keep saying what they relied on after the source changes.

**Modes** (`deputy.mode`):

- `off` (default): nothing is evaluated.
- `shadow`: the prediction or refusal is logged (`deputy-prediction`, `deputy-refusal`) and
  nothing is written to the agent, the ticket or the session. The owner answers as before.
- `live`: the owner keeps the grace period (`deputy.graceMinutes`, default 5, 1–120). An owner
  answer in it ends the candidate. After it every gate is checked again: still live, same
  evaluator, agent running and still linked, the same request still pending and unchanged (a
  newer question is never answered in its place), the ticket still qualifies, every cited quote
  still in today's sources, and the live gate below. Only then is one answer submitted through
  the checked path ([Answers to agent questions](#answers-to-agent-questions)). The intent is
  recorded first: an answer interrupted by a reload or without a confirmation is never submitted
  again (`unknown`), and it is not reported as applied.

**Live gate.** Live answers need both: at least 30 real paired shadow cases at 90% agreement or
more for the current evaluator version (`deputy-2/<model>/low`; a model or policy change starts
over), and a submission path that applies a response only while no owner response for the request
is in, bound to the request, idempotent, and reports what happened to it. The owner accepted the
plugin's own checked path ([Answers to agent questions](#answers-to-agent-questions)) in place of
the daemon half (2026-10-07): for the answers it submits for the deputy, that path holds the
owner's answer ahead of it, binds the submission to the request whose content it last read, records
one outcome per Linear activity, and never submits an unconfirmed answer again. What Paseo itself
would have to provide stays outside the promise: the daemon names no responder, so answers from the
Paseo app remain unattributed and can win a race against a deputy answer, and it takes no expected
fingerprint. On a host whose plugin has no checked connection to its Paseo daemon the deputy cannot
answer at all (blocker "no checked answer connection to the local Paseo daemon"); there a live
candidate ends `blocked` with the reason and the question stays with the owner. The settings show
`deputy.live.ready` and `deputy.live.blockers`.

**Evidence.** A pair is a prediction recorded before the owner answered and the owner's answer to
the same request, delivered by the plugin for the authenticated owner (a Linear comment written
with the owner's key, or an agent-session reply whose author is the owner) and confirmed by Paseo;
an answer that was turned down or not confirmed leaves no pair. Answers the daemon
reports (Paseo app, other clients) name no responder and never count, nor do identical answer
text, timing, blank identities, legacy `answer` entries, duplicates or deputy answers. All parts
must match (option labels case-insensitively). Unpaired predictions and refusals are reported as
coverage.

**Upstream attribution — proposal; not available.** The
[question-answer provenance proposal](https://github.com/Mtuchel/paseo-plugins/blob/main/linear-tickets/proposals/question-answer-attribution.md) asks Paseo to
record the daemon-established responder consistently in confirmations, live updates, plugin
events and retained question history, without guessing a human identity. It is published as
[Paseo Ideas discussion #6298](https://github.com/getpaseo/paseo/discussions/6298).
This documentation ships no capability and changes no evidence computation,
settings or live gate; attribution alone would not satisfy the other live-gate requirements.

**Answers shown.** After a confirmed live answer the deputy posts on the ticket (whatever the
write-back settings): the agent, the question and chosen option, each source with its link,
revision and quote, the request id and "Reply to override". The linked agent session shows the
same. A failed notice is retried every 5 minutes; the answer never is.

**Override.** A reply in the thread of that comment, or `override D-1a2b3c4d <your answer>` in
a ticket comment (with or without `@paseo`, also one that opens a new agent session, which then
starts nothing) or the agent session, goes to the agent that got the deputy's answer as a
correction message naming the original question; it never answers the agent's newer
question. Only replies whose author is the owner count; each owner activity is handled once, and
a failed delivery is replied to as failed, never claimed. Without a reference or a notice thread,
an owner reply is handled as before. Normal answers, messages and approvals keep how and by whom
they are sent; only a repeat of the same Linear activity is refused (see **Answers to agent
questions**).

**Log and weekly review.** The decision log (`owner-decisions/log.jsonl`, see [Decision
candidates](#decision-candidates)) gains `owner-answer` (an answer the plugin delivered for the
owner), `deputy-prediction`, `deputy-refusal`, `deputy-answer` (with version and citations),
`deputy-outcome` (blocked, canceled, owner won, unknown) and `deputy-override` (with delivery
result). Existing entries are kept as they are. `collect` lists deputy answers and overrides in
their own section as review evidence: a deputy answer cannot be cited as the owner's decision;
an override can (the owner's words).

**Report.** From the plugin folder, read-only:

```sh
node --import tsx scripts/deputy-report.ts
node --import tsx scripts/deputy-report.ts --baseline <since>..<until> --live <since>..<until> --repo tuchel-sohn/tuchel-platform
```

It prints the shadow evidence for the configured evaluator (pairs, matches, mismatches,
coverage, readiness), refusals by category, live answers, overrides and open cases. With two
equally long windows it also prints, per window, the questions asked, their median wait from
question to resolution (unanswered ones listed), owner answers and merged pull requests (GitHub,
per `--repo`) and a verdict: the live median under 15 minutes and fewer owner answers per merged
pull request pass; no merged pull request or no comparable baseline is inconclusive. Each run is
archived in `deputy/reports/`, so cases outlive the log's 60 days.

**Recall access.** `deputy/recall.json` (`{ "url", "bank", "token" }`, `0600`), else omp's
`hindsight.apiUrl` with bank `omp` and `HINDSIGHT_API_TOKEN` in the daemon's environment. The
token stays on the host: never in settings, prompts, citations or reports. `deputy.recallConfigured`
says whether access exists.

**Setup and rollout.** Set through `linear.set-settings`, for example
`{ "deputy": { "mode": "shadow", "model": "openai-codex/gpt-6.1-sol", "principlesRepository": "/home/mirko/paseo/tuchel-platform" } }`,
or edit `deputy` in `settings.json`. Start in shadow on one host, link a report with at least 30
real paired cases, and switch to live once the checked path ([Answers to agent
questions](#answers-to-agent-questions)) is deployed on that host. The deputy stays off by
default.

**Off switch.** `"deputy": { "mode": "off" }` stops new evaluations and ends candidates waiting
for their grace period at once; `shadow` ends waiting live candidates too. Neither undoes an
answer already given or work an agent did after it; override those.

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
In Progress transition, auto-dispatch and write-back are the only writes, sent as the Paseo app
when it is installed. Only the server and the agents' `linear_ticket` servers contact Linear.
The key and the app's token are never added to ticket context, agent configuration, agent
environment or agent labels.

The key still needs write permission with the app installed: handing a ticket to Paseo, editing
comments the key wrote before writes moved to the app, and every write while the app cannot be
used on this host (not installed, token not refreshable, or rejected after a refresh) go out with
it. Such a fallback is logged once per daemon run (`the Paseo app is not usable on this host;
Linear writes appear as the key's owner`); any other failed write is reported, never repeated
with the key.

Repeated launch requests reuse their result for the lifetime of the loaded plugin.
If agent creation returns an uncertain failure, the same request is not retried
automatically: check the project's workspaces and agent list before reopening the ticket to
start again. This retry cache does not survive a plugin or daemon restart.

## Validation

`npm run typecheck` checks both entrypoints against Paseo's SDK. `npm test` covers
GraphQL response parsing, pagination, context preservation, prompt template rendering
and validation, repository orientation (guide matching, ranking and the cap), credential and
settings persistence, ticket retrieval, state-transition
resolution and failure handling, agent creation/retries with mocked Linear and Paseo
calls, the session sweep's webhook-driven activity reads (skipped while a webhook is fresh, the
5-minute fallback, the minute sweep without webhooks), the waiting threads' batched status reads
(120 threads in four requests; a session Linear no longer has is dropped and read alone), and the pull request view (CI summaries,
merge queue parsing, polling cadence, the GitHub budget's reserve and its routed bypass,
labelling) against a fake GitHub, the decision candidates (the log, the collector's sources
and exclusions, window limits, candidate identity, one ticket per project, app-only filing)
and the weekly ops review (history reading, coverage, per-kind numbers, dedupe, the cap, checks
and reopens, the review lock, create reservations) against a fake Linear, the checked answer path
(owner precedence, replay protection, refusals) with the refs it takes from forwarded and queued
activations, and the cutover's activation routing (claims, deferral, delivery over the wire)
between two host fixtures. It also runs the ops
digest's Python tests (`python3 -m unittest discover -s ops -p 'test_*.py'`).
Live account authentication and agent execution require your configured host and key.

### Managed agent Linear cutover and recovery

The broker listens only on `$PASEO_HOME/linear-tickets/linear-broker.sock` (0600, directory 0700).
Each MCP attempt reserves one request and the upstream 10,000-point query ceiling; that is
a safety reservation, not measured usage. Daemon average-cost estimates and other credential
users can still consume more than predicted; the reserve is not an absolute external-spend guarantee.
An unknown app/key pool singleflights one small `viewer { id }` discovery at interactive priority,
counted as `mcp:budget-probe`, before tool queries. Known holds/probe ownership remain authoritative.
Absent samples retry no more often than once a minute. This discovery can precede knowledge of
the reserve; it never borrows owner priority.

`linear-broker-journal.json` records only outstanding ids, pool, time and reserved costs.
Intent is synced before dispatch. Unknown/recovered sends pause MCP on that pool for one hour;
afterwards fresh dimension headers are required **and unresolved maximum-cost debt is still
subtracted**. Repeated restarts preserve the original fence deadline and debt. Elapsed time/new
headers do not prove that an unknown request finished. Corrupt/unreadable state fails closed until
repaired from verified state; do not delete markers to unpause agents. Reconcile only when the
specific outcome is established; otherwise retain debt or roll back the transport explicitly.
Shutdown refuses new work and drains attempts within the 30-second upstream deadline.
Usage counts settle once while the broker runs or drains; persistence remains best-effort across
crashes, and unknown/recovered intervals invalidate outside-estimate continuity.

For **each host** (laptop and server087), drain current agent turns/MCP calls, update the clean
`~/dev/paseo-plugins` checkout with `git pull --ff-only`, run `npm ci` only if the lockfile changed,
then `paseo plugin reload linear-tickets` — never restart the daemon to load source changes.
Startup upgrades only verified private generated files, preserving saved command paths.
Unrecognized paths are logged as **unprotected**, never overwritten. Correct their saved config
or establish provenance before claiming host coverage. Restart already-loaded legacy MCP processes
through the provider after the turn drains; use agent session reopen if no independent MCP restart
exists. Inventory saved commands/live children, verify `paseo plugin ls`, the status schema and one
read-only tool's `mcp:` counter delta. A successful reload alone is not proof. Inaccessible hosts
need a registered after-merge manual task; do not race another rollout or recovery.

Rollback: drain affected MCP processes, run the installed standalone helper with a selected
rollout manifest, newest first:

```sh
node "$PASEO_HOME/linear-tickets/ticket-mcp-restore.mjs" \
  "$PASEO_HOME/linear-tickets/mcp-upgrades/rollout-<timestamp>-<id>.json"
```

It restores checksum-verified previous bytes for all affected saved paths, including commands
created after cutover, and refuses modified/symlinked targets. Original sources stay in the private
`mcp-upgrades/` archive. Then revert the merge in a new PR, run repository checks, merge/reload and
restart affected MCP processes. Keep usage history and unresolved safety debt. A plain Git revert
without saved-command restoration does not roll back those executable paths.
