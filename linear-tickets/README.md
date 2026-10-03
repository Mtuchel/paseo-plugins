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
by hand is never overridden. **Settings → Project mappings** lists the saved mappings and can
forget them. Mappings are stored per host in `settings.json`.

## Agent access to Linear

Agents started from a ticket get a `linear_ticket` MCP server (on by default, **Settings →
Agent access to Linear** turns it off). Its tools act only on the ticket the agent started from
and its manual tasks:

- `get_ticket` — fresh title, description, status, the team's workflow states, comments, links;
- `add_comment` — post a Markdown comment;
- `set_status` — move to another state of the ticket's team by name; a canceled or duplicate
  state needs a `reason`, posted on the ticket before the move;
- `link_url` — attach an https link, such as the pull request;
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
agent's PATH. A provider that cannot load MCP servers (omp: the daemon refuses its launch when
one is attached) starts once more without the server and with the no-write note instead of
`{{linear_access}}`, and the launch returns a warning, since that agent has no Linear tools.
The agent configuration carries only that path and the issue ID; no credential is put into the
agent's configuration or environment.

### Who Linear shows as the author

Everything the plugin and the `linear_ticket` tools write (comments, status moves, labels, links,
new sub-issues, reactions, plan documents) is sent with the [Paseo Linear app](#native-linear-agent)'s
token, so Linear's history shows **Paseo**, not you. Your own comments stay yours, so `@paseo`
replies still steer agents. The `linear_ticket` server reads the app's token from
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
Progress when the agent starts** in the plugin's **Settings** (gear icon in the
header), a launch also moves the ticket
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
timestamp newer than 60 s, answered at once, and deduplicated. A sweep every minute picks up
sessions and replies whose webhook was missed. Each of its parts (waiting tickets, superseded
threads, reviews, "Open in Paseo" links, missed replies) and each thread's replies are handled on
their own: a failed Linear request skips only what it hit until the next minute.
**Settings → Linear agent** shows the state.

**In the panel.**
- The agent's commands and file edits show up while it works, merged at most every 4 seconds.
- Each session links **Open in Paseo** (the web app at app.paseo.sh opens the agent when that browser is paired with this host).
- Questions with several parts are asked one part at a time, and are answered together once all parts are in. "Other" options are not buttons: type your own answer instead.
- **Stop** interrupts the turn and keeps the agent stopped (a turn the provider starts by itself within 5 minutes is stopped again) until you reply.
- When a session exists, the plan review, its decision and pull-request review changes update the progress comment instead of adding comments. The panel's own messages are copied into the ticket thread by Linear.

**Plan-first.** Every launch (sidebar, auto-dispatch, delegation, mention) picks one of three
plan policies, first match wins:

| Ticket | Policy |
|---|---|
| Carries `plan-ready` | No plan: the approved plan is implemented (below). |
| Written by someone else, or labelled `feedback` | **Plan required**; `no-plan` does not apply, so the ticket's own text cannot skip its review. |
| Labelled `plan`, or started with **Plan first** in the sidebar | **Plan required**. |
| Labelled `no-plan` | No plan. |
| Anything else | **The agent decides**. |

*Plan required*: Claude starts in `plan` mode and Codex in `auto`; omp keeps your usual mode
(its `write` mode asks before every shell command, reads included) and starts in Plannotator's
planning phase instead. The prompt asks only for a plan and, for someone else's ticket, marks
its text as untrusted input. With status write-back on, the ticket starts in **Planning** instead
of In Progress. Approving the plan switches the agent to your usual mode.

*The agent decides*: the prompt says to plan for a schema or migration change, auth or
permissions, more than one app or service, a public or cross-service API change, unclear or
conflicting acceptance criteria, or more than about three files, and to plan when unsure. omp
agents start in the planning phase and leave it only through `skip_plan` with a one-sentence
reason, which the ticket gets as a "No plan" note (the panel and progress comment with a Linear
agent session). Other providers get the same rules as instructions.

**Plan on a running agent.** Add `plan` to the ticket while its agent works: within a minute the
plugin asks the agent for a plan. An omp agent enters the planning phase at its next tool call
(that call is stopped and the reason follows as a message) or prompt, from implementing an approved plan too, and cannot
`skip_plan` afterwards. Other providers only get the message. A label that was there when the
agent started does nothing; remove and add it again to ask once more.

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
and for those agents the extension blocks `plannotator_submit_plan`, its `xd://` device and omp's
`xd://propose` until `record_plan_advice` has recorded the review for exactly the plan text being
submitted; a plan the gate cannot read is blocked too. The tool checks with `paseo inspect` that
the advisor runs GPT-6 Astra at medium, was created by this agent and has finished its latest
turn; any later edit to the plan needs a new record, and the record follows the session branch
(resume, `/tree` and branch switches rebuild it). It cannot check what the advisor said: the
plan's advisor section is your record of that. Recording and submitting in one step works when the
record comes first: the record is checked before any tool of that step runs, and a plan edit queued
in the same step holds both back. Subagents of a ticket agent (`task` children) are not gated; the
plan you review always comes from the ticket agent. An advisor that cannot be created (quota,
provider error) is recorded as `unavailable` only when the plan's advisor section says so and gives
the same reason. Claude and Codex planners get the steps as instructions when they launch in a
planning policy, without the gate.

**The omp extension.** The planning phase, `skip_plan` and the plan advisor gate come from
[`omp/linear-tickets-plan-first.ts`](omp/linear-tickets-plan-first.ts), which omp loads from its
extensions directory. Install it once with a symlink, so plugin updates reach it:

```sh
ln -s "$PWD/omp/linear-tickets-plan-first.ts" ~/.omp/agent/extensions/
```

It needs the Plannotator omp plugin (`@plannotator/pi-extension`). The plugin gives ticket agents
the policy in `LINEAR_TICKETS_PLAN` (also after a daemon restart) and writes mid-run requests to
`$PASEO_HOME/linear-tickets/plan-requests/<agent id>`. Only fresh sessions start in planning; a
resumed agent keeps its phase.

**`plan-ready`.** Every approved plan adds the `plan-ready` label: always for a split or
“Approve, implement later”, and with status write-back on for Plannotator and panel approvals,
where a new review round or a plan sent back removes it again.
A ticket that carries it starts its next agent in your usual mode, with the approved
“Plan: <ticket>” document in the prompt and the instruction to implement it rather than plan
again.

**Approve, implement later.** The plan review also offers **Approve, implement later**. The
plan is saved as the plan document, the planning agent is closed (no Resume offer), and the
ticket goes back to Todo with `plan-ready`. Reply in the panel, assign Paseo again or add the
trigger label to start the implementing agent.

**Link to the agent.** Each ticket gets an attachment "Paseo agent · <agent title>" next to its
pull requests, linking to the agent in the Paseo web app (app.paseo.sh opens it on devices paired
with this host). Its subtitle shows the phase and model; a new agent on the ticket replaces it.
Every Linear thread linked to an agent has "Open in Paseo" under Links, and the Plan review link
is there only while the review is open.

**Ticket agents keep the launch model.** Every ticket agent runs the model and thinking level
chosen for launches in the plugin. Plannotator's plan mode switches back to the model it saved when
planning began once a plan is approved; the plugin notices within seconds (at most 20 s), restores
the launch model and says so in the ticket's panel. To use another model for ticket work, change the
launch model in the plugin; changing it on one agent in Paseo is undone.

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
(Settings → Auto-dispatch, up to 50; 0 means no limit)
are already working, waits. A labelled ticket keeps its label; a delegated one says why in its
panel. The minute sweep starts it once it is admitted, however long it waited. A delegated ticket
whose thread was ended, or which was closed meanwhile, starts nothing; one that already has an
agent (from its label, say) is linked to it; a failed start is reported in the panel once.
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

An admitted ticket keeps its slot for 3 minutes while its agent starts. Tickets you start from
the sidebar skip the line.

**Present and away.** While you are away, tickets that may need you during the run wait; all
others start as usual. A ticket may need you when it carries `paseo-attended` (the project
planner marks these, and you can add or remove the label yourself) or when its plan needs your
approval: someone else wrote it, or it carries `plan` (an approved plan, `plan-ready`, no longer
counts). A project's planner ticket never waits: its plan is reviewed whenever you are back.
Waiting tickets keep their place and start within a few minutes of you being present again; agents
already working continue. A ticket that asks you something anyway stops in Needs input and frees
its slot.

You switch with the Present/Away toggle of the Paseo Agents menu bar app, or with a schedule
(off by default; host-local times such as away 22:00–07:00). A toggle holds until the
schedule's next switch, or, without a schedule, until you toggle again. Changing the schedule
drops an earlier toggle. Both are kept in `~/.paseo/linear-tickets/presence.json` and are read
and changed through the `linear.presence` and `linear.set-presence` RPCs.

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
every 2 minutes.

- **Planning on request.** Nothing is planned until you ask; planning never starts on its own.
  The plugin offers two RPCs for that, used by the Paseo Agents menu bar app:
  `linear.projects-status` lists each labelled project with how many new tickets wait for a
  plan and the planner waiting for your approval (with a link to it); `linear.plan-project`
  plans one project's new tickets.
- **Planner.** Planning files a ticket *Plan the work order of <project>* in the project
  (Urgent, labels `paseo-planner` and `plan`) and assigns it to Paseo. Its agent reads the open
  tickets, listed in its description with the new ones marked, and the code, and plans which
  tickets block which (because one builds on another, or both touch the same files), which
  must wait for you, and which may need you while they run. You review that plan like any other.
  Its last section is a block like:

  ````
  ```project-order
  TUC-12 blocks TUC-15
  hold TUC-20: too big, split it first
  release TUC-21
  attended TUC-23: which customer groups get the discount is not decided
  ```
  ````

  On approval Paseo adds the blocking relations, puts `paseo-hold` on held tickets (removes it
  from released ones) and `paseo-attended` on attended ones (`unattended X` removes it), comments
  what it applied and skipped, closes the planner ticket and archives its agent. Nothing else of
  an approval (In Progress, `plan-ready`) applies to it. The planner is told to mark a ticket
  attended only for an open business decision, acceptance criteria too vague to check,
  user-facing wording or layout you choose, changes to production data, external accounts or
  spend, or a step only a person can do; never for size or risk alone.
- **Hand-out.** Planned tickets in Backlog or Todo that are unassigned or yours, not handed to
  Paseo yet, without `paseo-hold` (or other `paseo-` state labels) and with every blocker
  finished are assigned to Paseo in the *Who starts next* order, one per free slot. Tickets in
  Triage or already started, someone else's, and sub-issues (their parent's group hands them
  out) are left alone. A ticket with open sub-issues in the project is assigned as a group and
  takes no slot itself. Removing `paseo-hold` releases a ticket.
- **New tickets.** Tickets filed after the last plan are not handed out until you plan them;
  `linear.projects-status` counts them. Only tickets the project could hand out count: new sub-issues, tickets
  already with Paseo or someone else, and started ones do not. There is at most one planner per
  project at a time: tickets filed while one waits for approval are counted for the next.
- **Skipping a plan.** Closing or canceling the planner ticket yourself counts its tickets as
  planned: they are handed out without a work order.
- Removing the label from the project stops new hand-outs; agents already working continue.
  Without a usable Paseo app (no threads) projects are not worked on.

What has been planned is kept in `~/.paseo/linear-tickets/projects.json`.

**Pull request reviews.** Every 2 minutes the plugin reads each ticket's pull request with
`gh`. Requested changes post a panel update and move the ticket back to In Progress; fixes
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
the pull request is open. Without Merge activity, drafts alone never count. Each drop is one of
two kinds, as the repo's `tools/ci/wait-queue.mjs` decides for the agent's own wait
(`docs/automation/merge-queue.md`). It is **conflict-only** when Graphite names a merge conflict
and nothing on the queue's draft failed, was cancelled or was still running (every check run on
its head is read, all pages), or no draft existed; a draft no longer listed counts as unread, so
the drop is plain. Every other drop is **plain**: Graphite also says "merge conflicts" for real
failures. The ticket's agent gets the reason, the checks that did not pass on the draft and the
runbook for the kind. Both re-enqueue the dropped queue range from its top branch, the one `gt
merge` ran on before the drop: the highest of the ticket's open pull requests the queue's draft
listed, or the dropped pull request itself when no draft lists it; never the stack's top branch,
which would enqueue pull requests above the range that are not ready. A plain drop: on the
stack's top branch `git fetch origin main && git rebase --update-refs --onto origin/main
"$(git merge-base HEAD origin/main)"`, which moves only its own branches, never `gt
sync`/`gt restack`; fix, `gt submit --stack --ignore-out-of-sync-trunk`, then `git switch
<range top> && gt merge` and `node tools/ci/wait-queue.mjs <its PR>`; one plain `gt merge` retry
on that branch for an obviously flaky failure. A conflict-only drop: the same rebase (only when
every branch below is the agent's own), regenerate generated files instead of merging them, the
focused checks, the same `gt submit`, then right away `git switch <range top> && gt merge` and
`node tools/ci/wait-queue.mjs <its PR>`, without waiting for the pull request's checks: the
queue's draft runs the full suite (only when `gt merge` refuses because checks still run: `node
tools/ci/wait-checks.mjs <its PR>`, then `gt merge` once more). The
message goes out once the agent is idle; Paseo resumes it if it has stopped. While the agent is
in a turn or waiting for an answer, or Paseo is not connected,
the message waits for a later poll. When the agent is gone or archived, the same text becomes a
ticket comment mentioning you, and the ticket moves back to In Progress (when status write-back
is on). Each drop is claimed in `$PASEO_HOME/linear-tickets/pr-watch.json` (by its draft, or by
the bullet when there is none) before anything is sent, so it is delivered at most once, also
across restarts. The kinds are counted separately per pull request: one fix request after a
plain drop and up to five restacks after conflict-only drops. The second plain drop or the sixth
conflict-only drop, whichever comes first, only mentions you ("the merge queue dropped this
stack again", with both counts), and after that drops of either kind are only logged. Drops
claimed before the kinds existed count as plain, and three of them as escalated. An
archived agent's open pull request stays watched until that escalation or 14 days without
activity. When GitHub throttles `gh`, the rest of the poll waits for the next one.

**Partial landings.** When the ticket's recorded pull request lands (merged, or closed by the
queue as above) while other pull requests of the ticket are still open (the rest of its stack,
or pull requests the agent replayed onto main), the ticket links the lowest of them (the one no
other open pull request of the ticket sits on; ties go to the lower number), the agent panel
and the handover record point at it, and the plugin watches and nudges it from the next poll,
also for an archived agent. This repeats with each landing until none of the ticket's pull
requests is open. The ticket's pull requests are the ones whose title names it as a whole word,
as for the merge nudge. A lookup or link move that fails, or a poll that ends before it (a rate
limit), is retried on the next poll, also across restarts.

**Replacement pull requests.** When the queue lands part of a stack, Graphite deletes the
landed branch, and GitHub closes the pull request based on it for good (it cannot be reopened
onto a deleted base). For a ticket's pull request closed without merging, the plugin looks for
an open pull request from the same branch in the repo's open pull requests on every poll; when
there is one, the ticket links it, the agent panel and the handover record point at it, and the
plugin watches it from the next poll. Without one, the closure is looked at once: when the base
branch is gone, the agent is told once to replay the rest of its stack onto
main from the landed branch (`git fetch origin main && git rebase --update-refs --onto
origin/main <landed branch>` on the top branch), `git push --force-with-lease` each replayed
branch, open a new pull request onto main whose body links the old one, and `gt track <branch>
--parent main`. It is claimed and delivered like a nudge; a gone or archived agent's message goes
to the ticket. After that request an archived agent's closed pull request stays watched for its
replacement until 14 days pass without activity.

**Stalled pull requests.** Agents often stop before their pull request reaches the merge queue.
On each poll, an open pull request whose agent is idle gets the next step of its lifecycle as a
new message, the first that applies:

| Stage | When | Next step sent |
|---|---|---|
| Draft | a draft with no new commit and no pull request activity for 30 minutes | run the background Sol review if not done, then publish only the reviewed part of the stack, bottom first: `gt submit --publish --no-stack --branch <branch>` once the branch and every branch below it are reviewed |
| Failed checks | a ready pull request whose latest run of a check failed (pending runs and `Graphite / mergeability_check` do not count) | the failed checks with links; fix, then `gt submit --stack` |
| Changes requested | a reviewer's latest approving, change-requesting or dismissed review asks for changes (on any commit), or GitHub's review decision is "changes requested" | each such review and the unresolved review threads; address them, then `gt submit --stack` (for a review on an earlier commit: reply on its threads and re-request the review) |
| Findings | unresolved review threads a bot started (Greptile, any bot reviewer) | the findings; run the AGENTS.md review loop |
| Merge | `PR code` and `PR metadata` ran on the head and succeeded or were skipped (so did `Label queued PRs for Linear` when it ran), every other check is green (except Graphite's mergeability check), no change request is open, no review thread is unresolved, and Greptile has reviewed the current head when the pull request has `complex-review` (a Greptile review on the head, or, for a review without findings, which files no review, Greptile's summary comment naming the head as its `Last reviewed commit`) | for the ticket's highest such pull request whose pull requests below it are all such too: `gt checkout <its branch> && gt merge` (which enqueues the ones below it), then `node tools/ci/wait-queue.mjs <its number>`; the rest of the stack follows once it is reviewed |

The first four stages look at the ticket's recorded pull request. The merge stage covers every
open pull request of the ticket: the recorded one and each whose title names the ticket as a
whole word (`Add TUC-34 [area] …` is TUC-34's, never TUC-343's). The repo's open pull requests
are listed once per repo and poll (REST, every page). A stack lands bottom first, so the plugin
climbs from the default branch through the ticket's pull requests and stops at the first one
that is not ready; one merge nudge per ticket and poll names the highest ready one. A pull
request stacked on another ticket's open branch is left to that ticket.

Nothing is sent for a pull request labelled `do-not-merge`, while [manual tasks](#manual-tasks)
due before the merge are open, while the merge queue has it (its last Merge activity bullet
queues it, runs its CI or merged it, or an open queue draft lists it), or while a merge queue
drop is being handled; these are settled before review threads are read. An agent gets at most
one message per poll: merge queue drops of all its pull requests come first, then nudges, so the
pull requests of one stack take turns. Each stage is claimed per head right before it goes out:
a new head can be nudged again, at most twice per stage and pull request. Requested changes are
claimed per review instead: a change request is sent once, however many commits follow it (it
keeps holding the merge until the reviewer settles it), and a new request is sent again. The next time that
stage stalls, you get one comment instead ("Paseo asked the agent 2 times to …"), and after
that only the log. A busy or disconnected agent is asked on a later poll; a gone or archived
agent's nudge goes to the ticket like a drop's fix request (it counts toward the same two).
Review threads are read (GraphQL, every page) only when a stage needs them.

**Health.** Every 5 minutes the plugin checks the Linear key, the Paseo app, Tailscale Funnel
and the local receiver. A problem confirmed twice opens one urgent ticket, "⚠️ Paseo needs
attention", assigned to you (in the first auto-dispatch team), so Linear notifies you. The ticket
is updated while problems change and completed when all checks pass again. Failed Linear writes
caused by outages (HTTP 5xx, rate limits, network) are retried after 30 s and 2 min.

**Durable record and resume.** Every ticket agent keeps one "Paseo progress" comment, edited
in place: phase, branch, last commit, links, latest report. When the agent fails or is
archived while the ticket is open, it also posts a final report. The panel then offers
**Resume with a new agent**, which is automatic when *Start a new agent automatically when one
fails* is on (at most hourly). Assigning Paseo again, @mentioning it or re-adding the label
also resumes. The new agent continues on the same branch, reusing the old worktree while it
exists so uncommitted work survives. It starts with a handover of the previous agent's reports,
and the old agent is archived. The ticket's links, its pull request among them, stay on the
record, so the pull request watch keeps following them; only "Open in Paseo" moves to the new
agent.

## Plannotator reviews

Plannotator shows its review URL only in omp's own status line, which Paseo does not display.
The plugin sets `PLANNOTATOR_BROWSER` for every agent session to a small hook
(`$PASEO_HOME/linear-tickets/plannotator/open`). When a review starts, the hook still opens it
on the host. It also publishes the review port inside your tailnet with `tailscale serve`
(HTTPS, reachable only from your devices). The agent's Paseo chat then gets a “Handed off to
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

Reviews are tracked in `$PASEO_HOME/linear-tickets/plannotator/reviews.json`. Every 30 s the
plugin checks each open review's server; after two failed checks it removes that review's
`tailscale serve` route and marks the review closed. Only ports recorded there are ever turned
off. When `:8444` cannot be published, the per-review link is posted as before.

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
saving a setting, or any agent or workspace activity on the host (agents resumed after a
daemon restart count). The surface's Settings shows the last poll,
its error and the most recent dispatches.

## Write back to Linear

For agents carrying the `linear.issueId` label (every agent started from a ticket, manually
or dispatched), **Settings → Write back to Linear** can report their lifecycle on the ticket
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
  without it), assigned to you, with the `<label>-needs-you` label and the mention comment.
  Further questions in the same wait edit that comment, and while the sub-issue is open the
  agent's later waits on the ticket reuse it. It is closed for you when the question or
  approval is answered (in Paseo or in Linear), or when you reply on it with `@paseo …`, which
  goes to the agent that asked. A wait that ended otherwise (for example the agent's next turn
  started) may be a manual step, so that sub-issue stays open until you close it. Archiving the
  agent leaves its open sub-issues for you; replies there no longer reach anyone.
- **Pull requests** — GitHub pull request URLs printed by the agent's completed shell
  commands during a turn (for example `gh pr create`) are attached to the ticket, which then moves to its team's
  started state named like *In Review*. Completion is left to Linear's GitHub integration and to
  the agent itself ([Agent access to Linear](#agent-access-to-linear)).

- **Replies from Linear** — your own comments that start with `@paseo`, and your replies in a
  thread started by a Paseo app comment (status, question, summary), reach the ticket's agent
  (the newest active one) within one poll interval; a reply needs no `@paseo`. If the agent is
  waiting on a question, the comment is the answer (an option name picks that option). If it is
  waiting on an approval, `approve` / `deny <reason>` decides it. Otherwise the text is
  sent as a message. Its reply comes back as a turn summary, so the conversation stays in
  Linear. Delivered comments get a 👀 reaction; undeliverable ones get ❌ and a reply saying
  why. All linked tickets are read in one request per poll, each from a cursor kept in
  `$PASEO_HOME/linear-tickets/relay-cursors.json`, so neither a restart nor a long pause
  delivers a comment twice or skips one. Comments by other people, and your comments that
  neither start with the mention nor reply to Paseo, are ignored. Without a usable Paseo app,
  Paseo's comments are written as you, so only `@paseo` comments count. Blocked alerts end with
  how to reply. With the Paseo app installed, Linear turns a typed `@paseo` into a mention of
  the app: that comment, and any reply in that agent session's thread, reaches the agent
  through its agent session right away, with the same question and approval rules, and the
  relay leaves it alone.

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

Linear meters requests per credential and hour: **2,500** for the personal API key (shared by
every key of the same Linear user) and **5,000** for the Paseo app's token. Both refill
steadily, so the plugin estimates each pool's room from the `X-RateLimit-Requests-Remaining`
header of the last answer plus the refill since then.

- **Reads that pollers repeat use the app's pool** when the Paseo app is installed: the relay's
  comment read, the auto-dispatch label query, ticket state, manual-task status, the sidebar
  state labels and the label rules' sweeps. The key reads them only when the app is not installed, its token cannot be
  refreshed, or it cannot see a ticket. An app rate limit never falls back to the key. Writes use
  the app's pool too; the key writes only in the cases listed under [Who Linear shows as the
  author](#who-linear-shows-as-the-author). The agents' `linear_ticket` servers send their own
  requests, which the daemon's estimate does not count.
- **Background work stops at a 15% reserve** of the pool it needs: auto-dispatch, the relay,
  manual tasks, the pull request watch, the state labels, the label rules and the health check. It resumes on its
  own as the pool refills. Session prompts, write-backs, agents' `linear_ticket` tools and the
  sidebar ticket list still use the reserve. The **Auto-dispatch** status shows `paused: …` with
  the estimated time, and the plugin log records each pause once.
- **When Linear answers `RATELIMITED`**, requests on that pool wait until the estimate reaches
  the reserve again (at least a minute). Then exactly one request tries, and a second limit
  doubles the wait, up to 15 minutes. Session errors and agent tools say when to try again.
- **Write-backs are not dropped.** A rate-limited write-back is retried when the pool refills,
  for up to 6 hours. A retry that a newer event for the same agent overtook only links its
  pull requests: those are kept in `$PASEO_HOME/linear-tickets/writeback-outbox.json` until
  they are linked on the ticket, in the agent panel and in the handover record, even across
  restarts. Retries never repeat a comment or panel activity that already went out.

## Pull request view

The Paseo Agents menu bar app shows a repository's open pull requests, the Graphite merge queue
and what landed on the default branch. The plugin reads them for it, so the shared `gh` login has
one GitHub poller instead of two:

- `linear.pull-requests` (`{ repository: "owner/name" }`) answers from memory at once: open pull
  requests with their labels, a CI summary of each ready one's head (the newest run per check;
  runs a later run of the same workflow superseded and Graphite's `mergeability_check` left out;
  a failed gate named only when no job failed; the start of the oldest check still running), its
  merge queue state from Graphite's Merge activity comment (queued, testing in round `#n`,
  merged, dropped with Graphite's reason, removals in the last 24 hours), the open queue rounds
  (`[Graphite MQ] Draft PR`s) with their CI, and the commits of the last 24 hours. Draft pull
  requests are listed but not read in detail.
- `linear.label-pulls` (`{ repository, label, numbers }`) adds a label to each pull request with
  the owner's `gh` login, stopping at the first one GitHub refuses, and returns the snapshot with
  the new labels.
- A repository is polled at most every 2 minutes, and only while a client asked for it in the
  last 10 minutes: with the app closed, the plugin sends GitHub nothing. Reads are REST only
  (GraphQL stays with `gh pr` and `gt`) and conditional, so an unchanged page answers
  `304 Not Modified` and costs no budget.
- Polling runs at background priority: while fewer than 300 REST requests are left before the
  login's hourly reset, it pauses until the reset and keeps the last data (`rateLimited` in the
  snapshot). After GitHub refuses a request for its rate limit, nothing is sent for 2 minutes.
  Labelling is not held back by the reserve.

## Manual tasks

Some steps only a person can do: environment variables and secrets, Railway, Linear, GitHub or
Paseo settings, webhooks, integrations. Agents register each one with `add_manual_task` instead
of leaving it in a comment. Each task is a **sub-issue of the ticket, assigned to you** (the
owner of the plugin's key), with the steps in its description and one of three due points:

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
calls, and the pull request view (CI summaries, merge queue parsing, polling cadence, the GitHub
budget's reserve, labelling) against a fake GitHub.
Live account authentication and agent execution require your configured host and key.
